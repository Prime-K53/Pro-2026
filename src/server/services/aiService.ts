import { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, type ActorContext } from './accountingEngine.ts';
import { chatCompletion, sanitizePrompt, buildSystemPrompt, AiProviderConfig } from './aiProvider.ts';
import { hasPermission } from '../permissions.ts';
import { buildEvidenceSet, renderEvidenceForPrompt, type EvidenceSet } from './aiFinancialGrounding.ts';
import { verifyClaims, type FinancialClaim } from './aiClaimVerifier.ts';

export interface AiConversation {
  id: number;
  companyId: number;
  userId: number;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessage {
  id: number;
  companyId: number;
  conversationId: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sourceCitations: any | null;
  tokenCount: number | null;
  createdAt: string;
}

export interface AiAnomalyAlert {
  id: number;
  companyId: number;
  anomalyType: string;
  severity: 'info' | 'warning' | 'alert' | 'critical';
  description: string;
  evidence: any | null;
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  createdAt: string;
  resolvedAt: string | null;
}

export interface AiProposedAction {
  id: number;
  companyId: number;
  conversationId: number | null;
  actionType: string;
  description: string;
  parameters: any | null;
  status: 'pending' | 'approved' | 'rejected' | 'executed';
  approvalId: number | null;
  approvedBy: number | null;
  approvedAt: string | null;
  executedBy: number | null;
  executedAt: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Conversation Management ─────────────────────────────────────────────

export async function createConversation(
  tx: Transaction,
  companyId: number,
  userId: number,
  title?: string
): Promise<AiConversation> {
  const res = await tx.query<any>(
    `INSERT INTO ai_conversations (company_id, user_id, title)
     VALUES ($1, $2, $3) RETURNING id, company_id, user_id, title, created_at, updated_at`,
    [companyId, userId, title || null]
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    userId: Number(r.user_id),
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listConversations(
  tx: Transaction,
  companyId: number,
  userId: number
): Promise<AiConversation[]> {
  const res = await tx.query<any>(
    `SELECT id, company_id, user_id, title, created_at, updated_at
     FROM ai_conversations
     WHERE company_id = $1 AND user_id = $2
     ORDER BY updated_at DESC`,
    [companyId, userId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    userId: Number(r.user_id),
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function assertConversationOwner(
  tx: Transaction,
  companyId: number,
  conversationId: number,
  userId: number
): Promise<void> {
  const res = await tx.query<any>(
    `SELECT 1 FROM ai_conversations WHERE company_id = $1 AND id = $2 AND user_id = $3`,
    [companyId, conversationId, userId]
  );
  if (res.rows.length === 0) {
    // Do not disclose whether the conversation exists under another owner.
    throw new AccountingError(404, 'Conversation not found', 'CONVERSATION_NOT_FOUND');
  }
}

export async function getConversationMessages(
  tx: Transaction,
  companyId: number,
  conversationId: number,
  userId: number
): Promise<AiMessage[]> {
  // Ownership is enforced by BOTH company and authenticated user.
  await assertConversationOwner(tx, companyId, conversationId, userId);
  const res = await tx.query<any>(
    `SELECT id, company_id, conversation_id, role, content, source_citations, token_count, created_at
     FROM ai_messages
     WHERE company_id = $1 AND conversation_id = $2
     ORDER BY created_at ASC`,
    [companyId, conversationId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    conversationId: Number(r.conversation_id),
    role: r.role,
    content: r.content,
    sourceCitations: r.source_citations,
    tokenCount: r.token_count ? Number(r.token_count) : null,
    createdAt: r.created_at,
  }));
}

// ─── Chat with RAG ─────────────────────────────────────────────────────

export async function chat(
  tx: Transaction,
  companyId: number,
  userId: number,
  userRole: string,
  companyName: string,
  config: AiProviderConfig,
  conversationId: number | null,
  userMessage: string
): Promise<{ conversationId: number; message: AiMessage; response: AiMessage }> {
  // Sanitize input
  const { safe, sanitized, reason } = sanitizePrompt(userMessage);
  if (!safe) {
    throw new AccountingError(400, reason || 'Unsafe input detected', 'AI_PROMPT_INJECTION');
  }

  // Enforce the monthly token/cost budget before calling the provider.
  await assertWithinBudget(tx, companyId, Math.ceil(sanitized.length / 4));

  // Create or get conversation (ownership enforced for an existing conversation)
  let convId = conversationId;
  if (!convId) {
    const conv = await createConversation(tx, companyId, userId, sanitized.slice(0, 50));
    convId = conv.id;
  } else {
    await assertConversationOwner(tx, companyId, convId, userId);
  }

  // Save user message
  const userMsgRes = await tx.query<any>(
    `INSERT INTO ai_messages (company_id, conversation_id, role, content)
     VALUES ($1, $2, 'user', $3) RETURNING id, company_id, conversation_id, role, content, source_citations, token_count, created_at`,
    [companyId, convId, sanitized]
  );
  const userMsg = userMsgRes.rows[0];

  // Build RAG context — retrieve relevant data based on query
  const rag = await buildRagContext(tx, companyId, sanitized, userRole);
  const ragContext = rag.text;

  // Build messages array
  const systemPrompt = buildSystemPrompt(companyName, userRole);
  const messages: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Add RAG context as system message
  if (ragContext) {
    messages.push({ role: 'system', content: `Relevant company data:\n${ragContext}` });
  }

  // Add conversation history
  const history = await getConversationMessages(tx, companyId, convId, userId);
  for (const msg of history.slice(-10)) {
    if (msg.role !== 'system') {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // Add current user message
  messages.push({ role: 'user', content: sanitized });

  // Call AI provider
  const response = await chatCompletion(config, messages);

  // Save assistant response
  const assistantMsgRes = await tx.query<any>(
    `INSERT INTO ai_messages (company_id, conversation_id, role, content, source_citations, token_count)
     VALUES ($1, $2, 'assistant', $3, $4, $5) RETURNING id, company_id, conversation_id, role, content, source_citations, token_count, created_at`,
    [companyId, convId, response.content, ragContext ? JSON.stringify({ context: ragContext.slice(0, 500), citations: rag.citations }) : null, response.usage?.totalTokens || null]
  );
  const assistantMsg = assistantMsgRes.rows[0];

  // Update conversation timestamp
  await tx.query(
    `UPDATE ai_conversations SET updated_at = NOW() WHERE company_id = $1 AND id = $2`,
    [companyId, convId]
  );

  return {
    conversationId: convId,
    message: {
      id: Number(userMsg.id),
      companyId: Number(userMsg.company_id),
      conversationId: Number(userMsg.conversation_id),
      role: userMsg.role,
      content: userMsg.content,
      sourceCitations: userMsg.source_citations,
      tokenCount: userMsg.token_count ? Number(userMsg.token_count) : null,
      createdAt: userMsg.created_at,
    },
    response: {
      id: Number(assistantMsg.id),
      companyId: Number(assistantMsg.company_id),
      conversationId: Number(assistantMsg.conversation_id),
      role: assistantMsg.role,
      content: assistantMsg.content,
      sourceCitations: assistantMsg.source_citations,
      tokenCount: assistantMsg.token_count ? Number(assistantMsg.token_count) : null,
      createdAt: assistantMsg.created_at,
    },
  };
}

// ─── RAG Context Builder ────────────────────────────────────────────────

async function buildRagContext(
  tx: Transaction,
  companyId: number,
  query: string,
  userRole: string
): Promise<{ text: string; citations: Array<{ kind: string; id: number; label: string }> }> {
  const lowerQuery = query.toLowerCase();
  const contextParts: string[] = [];
  const citations: Array<{ kind: string; id: number; label: string }> = [];
  const can = (permission: string) => hasPermission(userRole as any, permission as any);

  try {
    // Invoices / receivables
    if (
      (lowerQuery.includes('invoice') || lowerQuery.includes('receivable') || lowerQuery.includes('customer')) &&
      (can('sales:read') || can('accounts:read'))
    ) {
      const res = await tx.query<any>(
        `SELECT id, invoice_number, customer_id, total::text, balance_due::text, status, invoice_date::text
         FROM invoices WHERE company_id = $1 ORDER BY invoice_date DESC LIMIT 10`,
        [companyId]
      );
      if (res.rows.length > 0) {
        contextParts.push('Recent invoices: ' + res.rows.map((r: any) =>
          `${r.invoice_number}: total=${r.total}, balance=${r.balance_due}, status=${r.status}, date=${r.invoice_date}`
        ).join('; '));
        for (const r of res.rows) citations.push({ kind: 'invoice', id: Number(r.id), label: r.invoice_number });
      }
    }

    // Bills / payables / suppliers
    if (
      (lowerQuery.includes('bill') || lowerQuery.includes('payable') || lowerQuery.includes('supplier') || lowerQuery.includes('vendor')) &&
      can('accounts:read')
    ) {
      const res = await tx.query<any>(
        `SELECT id, bill_number, vendor_id, total::text, balance_due::text, status, bill_date::text
         FROM bills WHERE company_id = $1 ORDER BY bill_date DESC LIMIT 10`,
        [companyId]
      );
      if (res.rows.length > 0) {
        contextParts.push('Recent bills: ' + res.rows.map((r: any) =>
          `${r.bill_number}: total=${r.total}, balance=${r.balance_due}, status=${r.status}, date=${r.bill_date}`
        ).join('; '));
        for (const r of res.rows) citations.push({ kind: 'bill', id: Number(r.id), label: r.bill_number });
      }
    }

    // Inventory / stock
    if (
      (lowerQuery.includes('inventory') || lowerQuery.includes('stock') || lowerQuery.includes('item')) &&
      can('inventory:read')
    ) {
      const res = await tx.query<any>(
        `SELECT id, name, sku, on_hand::text, reorder_point::text, item_type
         FROM inventory_items WHERE company_id = $1 AND is_active = TRUE ORDER BY name LIMIT 20`,
        [companyId]
      );
      if (res.rows.length > 0) {
        contextParts.push('Inventory items: ' + res.rows.map((r: any) =>
          `${r.name} (${r.sku}): on_hand=${r.on_hand}, reorder_point=${r.reorder_point}, type=${r.item_type}`
        ).join('; '));
        for (const r of res.rows) citations.push({ kind: 'inventory_item', id: Number(r.id), label: r.sku });
      }
    }

    // Accounts / balances / trial balance
    if (
      (lowerQuery.includes('account') || lowerQuery.includes('balance') || lowerQuery.includes('trial') || lowerQuery.includes('profit') || lowerQuery.includes('margin') || lowerQuery.includes('cash')) &&
      can('accounts:read')
    ) {
      const res = await tx.query<any>(
        `SELECT id, code, name, account_type FROM accounts WHERE company_id = $1 AND is_active = TRUE ORDER BY code LIMIT 30`,
        [companyId]
      );
      if (res.rows.length > 0) {
        contextParts.push('Chart of accounts: ' + res.rows.map((r: any) =>
          `${r.code} ${r.name} (${r.account_type})`
        ).join('; '));
        for (const r of res.rows) citations.push({ kind: 'account', id: Number(r.id), label: `${r.code} ${r.name}` });
      }
    }

    // Payroll / employees
    if (
      (lowerQuery.includes('payroll') || lowerQuery.includes('employee') || lowerQuery.includes('salary')) &&
      can('payroll:read')
    ) {
      const res = await tx.query<any>(
        `SELECT id, employee_number, first_name, last_name, pay_frequency, status
         FROM employees WHERE company_id = $1 AND is_active = TRUE ORDER BY last_name LIMIT 20`,
        [companyId]
      );
      if (res.rows.length > 0) {
        contextParts.push('Employees: ' + res.rows.map((r: any) =>
          `${r.first_name} ${r.last_name} (${r.employee_number}): ${r.pay_frequency}, status=${r.status}`
        ).join('; '));
        for (const r of res.rows) {
          citations.push({ kind: 'employee', id: Number(r.id), label: `${r.first_name} ${r.last_name}`.trim() });
        }
      }
    }
  } catch (err) {
    console.error('RAG context build error:', err);
  }

  return { text: contextParts.join('\n'), citations };
}

// ─── Grounded chat (D-06): prepare → provider (outside tx) → finalize ─────

export interface PreparedChat {
  conversationId: number;
  userId: number;
  userMessage: AiMessage;
  evidence: EvidenceSet;
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
}

function mapMessage(r: any): AiMessage {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    conversationId: Number(r.conversation_id),
    role: r.role,
    content: r.content,
    sourceCitations: r.source_citations ?? null,
    tokenCount: r.token_count ? Number(r.token_count) : null,
    createdAt: r.created_at,
  };
}

/**
 * Phase 1 (inside a short company-scoped transaction): authenticate is done by
 * the route; here we sanitize, enforce budget, persist the user message, and
 * build an immutable, typed, company-scoped EvidenceSet from AUTHORITATIVE ERP
 * data. The DB transaction is released before the provider is called.
 */
export async function prepareChat(
  tx: Transaction,
  companyId: number,
  userId: number,
  userRole: string,
  companyName: string,
  conversationId: number | null,
  userMessage: string,
  queryEmbedding?: number[]
): Promise<PreparedChat> {
  const { safe, sanitized, reason } = sanitizePrompt(userMessage);
  if (!safe) {
    throw new AccountingError(400, reason || 'Unsafe input detected', 'AI_PROMPT_INJECTION');
  }

  let convId = conversationId;
  if (!convId) {
    const conv = await createConversation(tx, companyId, userId, sanitized.slice(0, 50));
    convId = conv.id;
  } else {
    // Never continue a conversation owned by another user (same company included).
    await assertConversationOwner(tx, companyId, convId, userId);
  }

  const userMsgRes = await tx.query<any>(
    `INSERT INTO ai_messages (company_id, conversation_id, role, content)
     VALUES ($1, $2, 'user', $3)
     RETURNING id, company_id, conversation_id, role, content, source_citations, token_count, created_at`,
    [companyId, convId, sanitized]
  );
  const userMessageRow = mapMessage(userMsgRes.rows[0]);

  // Deterministic, permission-gated, company-scoped evidence snapshot.
  const evidence = await buildEvidenceSet(tx, companyId, userRole, sanitized);

  const messages: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
    { role: 'system', content: buildSystemPrompt(companyName, userRole) },
  ];
  const evidenceText = renderEvidenceForPrompt(evidence);
  if (evidenceText) {
    // Evidence is DATA, never instructions (prompt-injection separation).
    messages.push({ role: 'system', content: evidenceText });
  }
  // Semantic memory (untrusted context). Only when a query embedding is supplied
  // (computed OUTSIDE this tx by the route, D-04). Best-effort: never blocks chat.
  if (queryEmbedding && queryEmbedding.length > 0) {
    try {
      const mem = await import('./aiMemoryService.ts');
      const hits = await mem.recall(tx, companyId, queryEmbedding, { k: 6 });
      const block = mem.renderMemoryForPrompt(hits);
      if (block) messages.push({ role: 'system', content: block });
    } catch {
      /* memory recall is best-effort */
    }
  }
  // Prior assistant answers are NOT authoritative evidence: only prior user
  // messages are replayed as history.
  const history = await getConversationMessages(tx, companyId, convId, userId);
  for (const m of history.slice(-10)) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
  }
  messages.push({ role: 'user', content: sanitized });

  return { conversationId: convId, userId, userMessage: userMessageRow, evidence, messages };
}

function parseModelJson(content: string): { claims?: FinancialClaim[]; explanation?: string; proposedAction?: any } | null {
  if (!content || !content.trim()) return null;
  let s = content.trim();
  // Strip ```json ... ``` fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && Array.isArray(obj.claims)) {
      return {
        claims: obj.claims,
        explanation: typeof obj.explanation === 'string' ? obj.explanation : '',
        proposedAction: obj.proposedAction && typeof obj.proposedAction === 'object' ? obj.proposedAction : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export interface FinalizedChat {
  conversationId: number;
  message: AiMessage;
  response: AiMessage & {
    claims: ReturnType<typeof verifyClaims>['verified'];
    explanation: string | null;
    abstained: boolean;
    abstainReason: string | null;
    asOf: string;
    domain: string;
  };
}

/**
 * Phase 2 (inside a short company-scoped transaction): verify the model's
 * claims against the immutable evidence snapshot, then persist the assistant
 * message with claim-level citations and validation metadata. The provider call
 * has already completed OUTSIDE any transaction.
 */
export async function finalizeChat(
  tx: Transaction,
  companyId: number,
  prep: PreparedChat,
  raw: { content: string; usage?: { totalTokens?: number } }
): Promise<FinalizedChat> {
  const parsed = parseModelJson(raw.content);
  const claims: FinancialClaim[] = parsed?.claims ?? [];
  const explanation = parsed ? (parsed.explanation ?? '') : raw.content;
  const verdict = verifyClaims(claims, prep.evidence);

  // Auto-propose (NEVER execute) when the model returns a recognized action.
  // The proposal is created pending; a different authorized human must approve
  // and execute it. Unknown types are ignored here and rejected at proposeAction.
  if (parsed?.proposedAction && typeof parsed.proposedAction === 'object') {
    const pa = parsed.proposedAction;
    if (typeof pa.actionType === 'string' && PROPOSABLE_ACTION_TYPES.has(pa.actionType)) {
      try {
        await proposeAction(
          tx,
          companyId,
          prep.userId,
          prep.conversationId,
          pa.actionType,
          String(pa.description || 'AI-proposed action'),
          pa.parameters || {}
        );
      } catch {
        /* a bad proposal must never break the chat response */
      }
    }
  }

  const hadFinancial = claims.some(
    (c) => c.amount !== undefined && c.amount !== null && String(c.amount).trim() !== ''
  );
  const abstained = prep.evidence.abstain || !parsed || (hadFinancial && verdict.verified.length === 0);
  // When the evidence set abstains (conflicting/incomplete/unsupported), no claim
  // may be presented as verified.
  const verifiedClaims = abstained ? [] : verdict.verified;
  const abstainReason = prep.evidence.abstainReason
    ?? (!parsed
      ? 'The model returned an unreadable response; no financial claim was verified.'
      : hadFinancial && verdict.verified.length === 0
        ? 'The requested figure could not be verified against authoritative records.'
        : null);

  const content = abstained
    ? (abstainReason || 'I cannot verify that from authoritative records.')
    : (explanation || 'Here is what the authoritative records show.');

  const sourceCitations = JSON.stringify({
    domain: prep.evidence.domain,
    asOf: prep.evidence.asOf,
    abstained,
    verifiedClaims,
    rejectedClaims: verdict.rejected,
    evidence: prep.evidence.items,
  });

  const res = await tx.query<any>(
    `INSERT INTO ai_messages (company_id, conversation_id, role, content, source_citations, token_count)
     VALUES ($1, $2, 'assistant', $3, $4, $5)
     RETURNING id, company_id, conversation_id, role, content, source_citations, token_count, created_at`,
    [companyId, prep.conversationId, content, sourceCitations, raw.usage?.totalTokens || null]
  );
  await tx.query(
    `UPDATE ai_conversations SET updated_at = NOW() WHERE company_id = $1 AND id = $2`,
    [companyId, prep.conversationId]
  );

  const response = mapMessage(res.rows[0]);
  return {
    conversationId: prep.conversationId,
    message: prep.userMessage,
    response: {
      ...response,
      claims: verifiedClaims,
      explanation: abstained ? null : (explanation || null),
      abstained,
      abstainReason: abstainReason ?? null,
      asOf: prep.evidence.asOf,
      domain: prep.evidence.domain,
    },
  };
}

// ─── D-05 usage accounting: atomic reservation + durable attempts ─────────

export const MAX_OUTPUT_TOKENS = 1024;

/** Deterministic token estimate over the full provider request + output allowance. */
export function estimateRequestTokens(
  messages: { role: string; content: string }[],
  maxOutputTokens = MAX_OUTPUT_TOKENS
): number {
  let n = maxOutputTokens;
  for (const m of messages) n += Math.ceil((m.content?.length || 0) / 4);
  return n;
}

function utcPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Atomically reserve `tokens` against the company's UTC-month budget and create a
 * durable 'reserved' attempt. A single atomic upsert with a WHERE guard ensures
 * concurrent reservations cannot exceed the limit. Throws 429 when it cannot.
 */
export async function reserveAttempt(
  tx: Transaction,
  companyId: number,
  requestId: string,
  attemptNo: number,
  provider: string,
  model: string | null,
  messages: { role: string; content: string }[],
  maxOutputTokens = MAX_OUTPUT_TOKENS,
  opts: { tokenOverride?: number } = {}
): Promise<{ attemptId: number; reservationTokens: number }> {
  const budget = await getAiBudget(tx, companyId);
  // Additive, backward-compatible: callers may supply a provably conservative
  // total reservation (e.g. OCR text+image+output upper bound). When omitted,
  // the legacy estimator is used unchanged (chat path unaffected).
  const tokens =
    typeof opts.tokenOverride === 'number' && Number.isFinite(opts.tokenOverride) && opts.tokenOverride > 0
      ? Math.floor(opts.tokenOverride)
      : estimateRequestTokens(messages, maxOutputTokens);
  const limit = budget.monthlyTokenLimit;
  const period = utcPeriod();

  const exists = await tx.query(`SELECT 1 FROM ai_budget_usage WHERE company_id = $1 AND period = $2`, [companyId, period]);
  if (exists.rows.length === 0 && limit > 0 && tokens > limit) {
    throw new AccountingError(429, 'Monthly AI token budget exceeded', 'AI_TOKEN_BUDGET_EXCEEDED');
  }
  const ins = await tx.query<any>(
    `INSERT INTO ai_budget_usage (company_id, period, reserved_tokens, settled_tokens)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (company_id, period) DO UPDATE
       SET reserved_tokens = ai_budget_usage.reserved_tokens + EXCLUDED.reserved_tokens,
           updated_at = NOW()
     WHERE ai_budget_usage.reserved_tokens + ai_budget_usage.settled_tokens + EXCLUDED.reserved_tokens <= $4
     RETURNING reserved_tokens, settled_tokens`,
    [companyId, period, tokens, limit]
  );
  if (ins.rows.length === 0) {
    throw new AccountingError(429, 'Monthly AI token budget exceeded', 'AI_TOKEN_BUDGET_EXCEEDED');
  }
  const a = await tx.query<any>(
    `INSERT INTO ai_usage_attempts (company_id, request_id, attempt_no, provider, model, reservation_tokens, state, period)
     VALUES ($1, $2::UUID, $3, $4, $5, $6, 'reserved', $7)
     RETURNING id`,
    [companyId, requestId, attemptNo, provider, model || null, tokens, period]
  );
  return { attemptId: Number(a.rows[0].id), reservationTokens: tokens };
}

/** Idempotently settle an attempt with provider usage (or a conservative estimate). */
export async function settleAttempt(
  tx: Transaction,
  companyId: number,
  attemptId: number,
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
  requestId?: string
): Promise<void> {
  const cur = await tx.query<any>(`SELECT reservation_tokens, state, period FROM ai_usage_attempts WHERE company_id = $1 AND id = $2`, [companyId, attemptId]);
  if (cur.rows.length === 0) return;
  // Strict state machine: only an in-progress attempt may settle. Terminal
  // states (settled/released/unresolved/rejected) are immutable here.
  if (cur.rows[0].state !== 'reserved' && cur.rows[0].state !== 'invoking') return;
  const reservation = Number(cur.rows[0].reservation_tokens);
  const period = cur.rows[0].period; // immutable reservation period (never recomputed)
  const reported = Number(usage?.totalTokens || 0);
  const total = reported > 0 ? reported : reservation; // never zero
  const source = reported > 0 ? 'provider' : 'estimated';
  const prompt = reported > 0 ? Number(usage?.promptTokens || 0) : null;
  const completion = reported > 0 ? Number(usage?.completionTokens || 0) : null;
  const upd = await tx.query<any>(
    `UPDATE ai_usage_attempts
        SET state = 'settled', prompt_tokens = $2, completion_tokens = $3, total_tokens = $4,
            usage_source = $5, settled_at = NOW(), error = $6,
            provider_request_id = COALESCE($8, provider_request_id)
      WHERE company_id = $1 AND id = $7 AND state IN ('reserved','invoking')
      RETURNING reservation_tokens`,
    [companyId, prompt, completion, total, source, total > reservation ? 'overrun' : null, attemptId, requestId || null]
  );
  if (upd.rows.length === 0) return; // lost race / ineligible state
  await tx.query(
    `UPDATE ai_budget_usage
        SET reserved_tokens = GREATEST(0, reserved_tokens - $2),
            settled_tokens = settled_tokens + $3,
            updated_at = NOW()
      WHERE company_id = $1 AND period = $4`,
    [companyId, reservation, total, period]
  );
}

/**
 * Record a provider failure. Definite rejection (not ambiguous) releases the
 * reservation; ambiguous/timeout outcomes are kept conservatively as 'unresolved'.
 */
export async function recordProviderFailure(
  tx: Transaction,
  companyId: number,
  attemptId: number,
  ambiguous: boolean,
  error: string,
  usage?: { totalTokens?: number }
): Promise<void> {
  if (usage && Number(usage.totalTokens || 0) > 0) {
    await settleAttempt(tx, companyId, attemptId, usage as any);
    return;
  }
  const cur = await tx.query<any>(`SELECT reservation_tokens, state FROM ai_usage_attempts WHERE company_id = $1 AND id = $2`, [companyId, attemptId]);
  if (cur.rows.length === 0 || !['reserved', 'invoking'].includes(cur.rows[0].state)) return;
  if (ambiguous) {
    await tx.query(`UPDATE ai_usage_attempts SET state = 'unresolved', error = $2 WHERE company_id = $1 AND id = $3`, [companyId, error, attemptId]);
    return;
  }
  const rel = await tx.query<any>(
    `UPDATE ai_usage_attempts SET state = 'released', settled_at = NOW(), error = $2
      WHERE company_id = $1 AND id = $3 AND state IN ('reserved','invoking')
      RETURNING reservation_tokens, period`,
    [companyId, error, attemptId]
  );
  if (rel.rows.length > 0) {
    await tx.query(
      `UPDATE ai_budget_usage SET reserved_tokens = GREATEST(0, reserved_tokens - $2), updated_at = NOW()
        WHERE company_id = $1 AND period = $3`,
      [companyId, Number(rel.rows[0].reservation_tokens), rel.rows[0].period]
    );
  }
}

/**
 * Explicit, separately audited reconciliation of an unresolved attempt when
 * authoritative provider evidence later becomes available. Only 'unresolved'
 * transitions here; ordinary settlement rules are not weakened.
 */
export async function reconcileUnresolvedAttempt(
  tx: Transaction,
  companyId: number,
  attemptId: number,
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
  evidence: { providerRequestId?: string | null } | undefined,
  actorUserId = 0
): Promise<boolean> {
  const cur = await tx.query<any>(
    `SELECT state, provider_request_id FROM ai_usage_attempts WHERE company_id = $1 AND id = $2`,
    [companyId, attemptId]
  );
  if (cur.rows.length === 0 || cur.rows[0].state !== 'unresolved') return false;
  // FAIL-CLOSED: reconciliation requires a server-recorded provider request id
  // bound to THIS attempt. The client cannot assert usage; absent/mismatched
  // evidence is rejected and nothing changes.
  const storedReq = cur.rows[0].provider_request_id;
  if (!storedReq || !evidence?.providerRequestId || evidence.providerRequestId !== storedReq) {
    return false;
  }
  const upd = await tx.query<any>(
    `UPDATE ai_usage_attempts SET state = 'settled', prompt_tokens = $2, completion_tokens = $3,
        total_tokens = $4, usage_source = 'provider', settled_at = NOW(), error = 'reconciled'
      WHERE company_id = $1 AND id = $5 AND state = 'unresolved'
      RETURNING reservation_tokens, period`,
    [companyId, Number(usage.promptTokens || 0), Number(usage.completionTokens || 0), Number(usage.totalTokens || 0), attemptId]
  );
  if (upd.rows.length === 0) return false;
  await tx.query(
    `UPDATE ai_budget_usage SET reserved_tokens = GREATEST(0, reserved_tokens - $2), settled_tokens = settled_tokens + $3, updated_at = NOW()
      WHERE company_id = $1 AND period = $4`,
    [companyId, Number(upd.rows[0].reservation_tokens), Number(usage.totalTokens || 0), upd.rows[0].period]
  );
  if (actorUserId > 0) {
    await writeAiAuditLog(tx, companyId, actorUserId, 'AI_USAGE_RECONCILED', `attempt=${attemptId}, total=${Number(usage.totalTokens || 0)}, providerRequestId=${storedReq}`);
  }
  return true;
}

/**
 * Recovery: mark stale reserved/invoking attempts as unresolved (never auto-release).
 * Each transition is audited in the SAME transaction (atomic) using the
 * server-controlled system actor, so auditability never depends on a human id.
 */
export async function recoverUnresolvedAttempts(
  tx: Transaction,
  companyId: number,
  systemUserId: number
): Promise<number> {
  const res = await tx.query<any>(
    `UPDATE ai_usage_attempts SET state = 'unresolved', error = 'recovered: stale reservation'
      WHERE company_id = $1 AND state IN ('reserved','invoking') AND reserved_at < NOW() - INTERVAL '1 hour'
      RETURNING id, request_id`,
    [companyId]
  );
  for (const r of res.rows) {
    await writeAiAuditLog(
      tx,
      companyId,
      systemUserId,
      'AI_RECOVERY',
      `attempt=${r.id}, request=${r.request_id}, prev=reserved/invoking, new=unresolved, reason=stale`
    );
  }
  return res.rows.length;
}

/** Resolve (provisioning atomically if needed) the server-controlled system-recovery user id. */
export async function getSystemRecoveryUserId(db: any): Promise<number> {
  return db.withSystemDb(async (tx: any) => {
    // Atomic upsert on the unique username (migration 0088): concurrent callers
    // resolve to the same canonical identity; no duplicate system users.
    const ins = await tx.query(
      `INSERT INTO users (username, email, display_name, password_hash, is_active)
       VALUES ('system-recovery', 'system-recovery@local.invalid', 'System Recovery', '!', FALSE)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`
    );
    if (ins.rows.length) return Number(ins.rows[0].id);
    const r = await tx.query(`SELECT id FROM users WHERE username = 'system-recovery' LIMIT 1`);
    if (!r.rows.length) throw new Error('system-recovery user missing after upsert');
    return Number(r.rows[0].id);
  });
}

/**
 * Operational recovery across all companies. Bounded, idempotent, company-scoped,
 * never releases. Intended for startup / scheduled maintenance. Errors are
 * isolated per company so a failure never blocks ordinary ERP operations.
 */
export async function recoverAllUnresolved(db: any): Promise<{ companies: number; recovered: number; failed: number }> {
  let companies = 0, recovered = 0, failed = 0;
  try {
    const systemUserId = await getSystemRecoveryUserId(db);
    const list = await db.withSystemDb(async (tx: any) => (await tx.query(`SELECT id FROM companies`)).rows.map((r: any) => Number(r.id)));
    for (const cid of list) {
      companies++;
      try {
        const n = await db.withCompanyDb(cid, (tx: any) => recoverUnresolvedAttempts(tx, cid, systemUserId));
        recovered += n;
      } catch (err) {
        failed++;
        console.error(`[AI Recovery] company ${cid} failed:`, (err as any)?.message || err);
      }
    }
  } catch (err) {
    failed++;
    console.error('[AI Recovery] enumeration failed:', (err as any)?.message || err);
  }
  return { companies, recovered, failed };
}

// ─── Config ─────────────────────────────────────────────────────────────

export interface AiConfig {
  enabled: boolean;
  provider: string | null;
  modelName: string | null;
  hasApiKey: boolean;
}

export async function getAiConfig(tx: Transaction, companyId: number): Promise<AiConfig> {
  const res = await tx.query<any>(
    `SELECT provider, model_name, enabled, api_key_encrypted
       FROM ai_config WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
    [companyId]
  );
  if (res.rows.length === 0) {
    return { enabled: false, provider: null, modelName: null, hasApiKey: false };
  }
  const r = res.rows[0];
  return {
    enabled: r.enabled,
    provider: r.provider,
    modelName: r.model_name,
    hasApiKey: Boolean(r.api_key_encrypted),
  };
}

export async function upsertAiConfig(
  tx: Transaction,
  companyId: number,
  provider: string,
  apiKeyEncrypted: string,
  modelName: string,
  enabled = true,
  fallback?: { provider: string; apiKeyEncrypted: string; modelName: string } | null
): Promise<AiConfig> {
  const existing = await tx.query(
    `SELECT id FROM ai_config WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
    [companyId]
  );
  if (existing.rows.length > 0) {
    await tx.query(
      `UPDATE ai_config
          SET provider = $2,
              model_name = $3,
              enabled = $4,
              api_key_encrypted = CASE WHEN $5::TEXT IS NOT NULL AND $5 <> '' THEN $5 ELSE api_key_encrypted END,
              fallback_provider = $6,
              fallback_model = $7,
              fallback_api_key_encrypted = CASE WHEN $8::TEXT IS NOT NULL AND $8 <> '' THEN $8 ELSE fallback_api_key_encrypted END,
              updated_at = NOW()
        WHERE company_id = $1`,
      [
        companyId,
        provider,
        modelName,
        enabled,
        apiKeyEncrypted || null,
        fallback?.provider || null,
        fallback?.modelName || null,
        fallback?.apiKeyEncrypted || null,
      ]
    );
  } else {
    await tx.query(
      `INSERT INTO ai_config (company_id, provider, api_key_encrypted, model_name, enabled, fallback_provider, fallback_model, fallback_api_key_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        companyId,
        provider,
        apiKeyEncrypted || '',
        modelName,
        enabled,
        fallback?.provider || null,
        fallback?.modelName || null,
        fallback?.apiKeyEncrypted || null,
      ]
    );
  }
  return getAiConfig(tx, companyId);
}

// ─── Budgets ────────────────────────────────────────────────────────────

export interface AiBudget {
  companyId: number;
  monthlyTokenLimit: number;
  monthlyCostLimit: number;
  costPer1kTokens: number;
}

const DEFAULT_AI_BUDGET: Omit<AiBudget, 'companyId'> = {
  monthlyTokenLimit: 1_000_000,
  monthlyCostLimit: 0,
  costPer1kTokens: 0,
};

export async function getAiBudget(tx: Transaction, companyId: number): Promise<AiBudget> {
  const res = await tx.query<any>(
    `SELECT company_id, monthly_token_limit, monthly_cost_limit::text AS monthly_cost_limit,
            cost_per_1k_tokens::text AS cost_per_1k_tokens
       FROM ai_budgets WHERE company_id = $1 LIMIT 1`,
    [companyId]
  );
  if (res.rows.length === 0) return { companyId, ...DEFAULT_AI_BUDGET };
  const r = res.rows[0];
  return {
    companyId: Number(r.company_id),
    monthlyTokenLimit: Number(r.monthly_token_limit),
    monthlyCostLimit: Number(r.monthly_cost_limit),
    costPer1kTokens: Number(r.cost_per_1k_tokens),
  };
}

export async function upsertAiBudget(
  tx: Transaction,
  companyId: number,
  input: { monthlyTokenLimit?: number; monthlyCostLimit?: number; costPer1kTokens?: number }
): Promise<AiBudget> {
  const tokenLimit = Math.max(0, Number(input.monthlyTokenLimit ?? DEFAULT_AI_BUDGET.monthlyTokenLimit));
  const costLimit = Math.max(0, Number(input.monthlyCostLimit ?? 0));
  const costPer1k = Math.max(0, Number(input.costPer1kTokens ?? 0));
  await tx.query(
    `INSERT INTO ai_budgets (company_id, monthly_token_limit, monthly_cost_limit, cost_per_1k_tokens)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id) DO UPDATE SET
       monthly_token_limit = EXCLUDED.monthly_token_limit,
       monthly_cost_limit = EXCLUDED.monthly_cost_limit,
       cost_per_1k_tokens = EXCLUDED.cost_per_1k_tokens,
       updated_at = NOW()`,
    [companyId, tokenLimit, costLimit, costPer1k]
  );
  return { companyId, monthlyTokenLimit: tokenLimit, monthlyCostLimit: costLimit, costPer1kTokens: costPer1k };
}

async function assertWithinBudget(tx: Transaction, companyId: number, incomingTokens: number): Promise<void> {
  const budget = await getAiBudget(tx, companyId);
  const usageRes = await tx.query<{ tokens: string }>(
    `SELECT COALESCE(SUM(token_count), 0)::text AS tokens
       FROM ai_messages
      WHERE company_id = $1 AND created_at >= date_trunc('month', NOW())`,
    [companyId]
  );
  const used = Number(usageRes.rows[0]?.tokens ?? 0);
  const projected = used + Math.max(0, incomingTokens);
  if (budget.monthlyTokenLimit > 0 && projected > budget.monthlyTokenLimit) {
    throw new AccountingError(429, 'Monthly AI token budget exceeded', 'AI_TOKEN_BUDGET_EXCEEDED');
  }
  if (budget.monthlyCostLimit > 0) {
    const projectedCost = (projected / 1000) * budget.costPer1kTokens;
    if (projectedCost > budget.monthlyCostLimit) {
      throw new AccountingError(429, 'Monthly AI cost budget exceeded', 'AI_COST_BUDGET_EXCEEDED');
    }
  }
}

// ─── Retention ──────────────────────────────────────────────────────────

export async function deleteConversation(
  tx: Transaction,
  companyId: number,
  userId: number,
  conversationId: number
): Promise<boolean> {
  const res = await tx.query(
    `DELETE FROM ai_conversations WHERE company_id = $1 AND id = $2 AND user_id = $3`,
    [companyId, conversationId, userId]
  );
  return (res as any).rowCount > 0;
}

export async function purgeOldConversations(
  tx: Transaction,
  companyId: number,
  olderThanDays: number
): Promise<number> {
  const days = Math.max(1, Number(olderThanDays) || 90);
  const res = await tx.query(
    `DELETE FROM ai_conversations
      WHERE company_id = $1 AND updated_at < NOW() - ($2 || ' days')::interval`,
    [companyId, days]
  );
  return (res as any).rowCount ?? 0;
}

// ─── Proposed actions & execution ───────────────────────────────────────

const ACTION_COLUMNS = `id, company_id, conversation_id, action_type, description, parameters, status,
   approval_id, approved_by, approved_at, executed_by, executed_at, created_by, created_at, updated_at`;

function mapProposedAction(r: any): AiProposedAction {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    conversationId: r.conversation_id ? Number(r.conversation_id) : null,
    actionType: r.action_type,
    description: r.description,
    parameters: r.parameters,
    status: r.status,
    approvalId: r.approval_id ? Number(r.approval_id) : null,
    approvedBy: r.approved_by ? Number(r.approved_by) : null,
    approvedAt: r.approved_at ?? null,
    executedBy: r.executed_by ? Number(r.executed_by) : null,
    executedAt: r.executed_at ?? null,
    createdBy: Number(r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Action types the AI may PROPOSE (pending; never auto-executed). */
export const PROPOSABLE_ACTION_TYPES = new Set([
  'post_journal',
  'create_quote_draft',
  'create_invoice',
  'start_workflow',
  'propose_journal',
]);

/** Action types that can be EXECUTED after approval (maker-checker enforced). */
export const EXECUTABLE_ACTION_TYPES = new Set(['post_journal', 'create_quote_draft', 'create_invoice']);

export interface ResolvedInvoiceLine {
  description: string;
  quantity: number;
  rate: number;
  taxable: boolean;
}

/**
 * Resolve invoice lines to AUTHORITATIVE prices from the item catalog. The model
 * never sets the rate: when an itemId is present the server overrides the rate
 * with inventory_items.sales_price. Lines without a description are dropped.
 */
export async function resolveInvoiceLines(
  tx: Transaction,
  companyId: number,
  rawLines: any[]
): Promise<ResolvedInvoiceLine[]> {
  const out: ResolvedInvoiceLine[] = [];
  for (const l of rawLines || []) {
    let description = String(l?.description ?? '').trim();
    let rate = Number(l?.rate) || 0;
    const taxable = l?.taxable !== false;
    const itemId = l?.itemId != null && l?.itemId !== '' ? Number(l.itemId) : null;
    if (itemId) {
      const r = await tx.query<any>(
        `SELECT name, sales_price FROM inventory_items WHERE company_id = $1 AND id = $2`,
        [companyId, itemId]
      );
      if (r.rows[0]) {
        description = r.rows[0].name || description;
        rate = Number(r.rows[0].sales_price) || rate;
      }
    }
    if (!description) continue;
    out.push({ description, quantity: Number(l?.quantity) || 0, rate, taxable });
  }
  return out;
}

export async function proposeAction(
  tx: Transaction,
  companyId: number,
  userId: number,
  conversationId: number | null,
  actionType: string,
  description: string,
  parameters: any,
  opts: { isAiGenerated?: boolean } = {}
): Promise<AiProposedAction> {
  if (!PROPOSABLE_ACTION_TYPES.has(actionType)) {
    throw new AccountingError(400, `AI action type '${actionType}' is not a recognized proposal type`, 'AI_ACTION_UNSUPPORTED_TYPE');
  }
  const res = await tx.query<any>(
    `INSERT INTO ai_proposed_actions (company_id, conversation_id, action_type, description, parameters, status, created_by, created_by_ai)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $7)
     RETURNING ${ACTION_COLUMNS}`,
    [companyId, conversationId, actionType, description, JSON.stringify(parameters ?? {}), userId, opts.isAiGenerated ? true : false]
  );
  return mapProposedAction(res.rows[0]);
}

export async function listProposedActions(
  tx: Transaction,
  companyId: number,
  status?: string
): Promise<AiProposedAction[]> {
  const res = await tx.query<any>(
    `SELECT ${ACTION_COLUMNS}
       FROM ai_proposed_actions
      WHERE company_id = $1 AND ($2::TEXT IS NULL OR status = $2)
      ORDER BY created_at DESC`,
    [companyId, status || null]
  );
  return res.rows.map(mapProposedAction);
}

/**
 * Approve a pending proposed action.
 *
 * Maker-checker invariant: the authenticated actor must be an authorized user
 * and must never be the creator. Approval identity and timestamp are persisted
 * atomically with the status transition; an existing approval cannot be
 * overwritten. The actor is always resolved from the authenticated request
 * context by the route — never from client-supplied fields.
 */
export async function approveProposedAction(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  actionId: number
): Promise<AiProposedAction> {
  const res = await tx.query<any>(
    `SELECT * FROM ai_proposed_actions WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, actionId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'AI proposed action not found', 'AI_ACTION_NOT_FOUND');
  }
  const action = res.rows[0];
  if (action.status !== 'pending') {
    throw new AccountingError(409, 'AI action is not pending approval', 'AI_ACTION_INVALID_STATE');
  }
  // AI-generated proposals have the AI as maker, so the requesting human is the
  // checker and MAY approve. Human-authored proposals still forbid self-approval.
  if (!action.created_by_ai && Number(action.created_by) === Number(actor.userId)) {
    throw new AccountingError(403, 'You cannot approve your own proposed action', 'AI_ACTION_SELF_APPROVAL');
  }
  if (action.action_type === 'post_journal' && !hasPermission(actor.role, 'journals:write')) {
    throw new AccountingError(403, "Role lacks required permission 'journals:write'", 'PERMISSION_DENIED');
  }
  if (action.action_type === 'create_invoice' && !hasPermission(actor.role, 'invoices:write')) {
    throw new AccountingError(403, "Role lacks required permission 'invoices:write'", 'PERMISSION_DENIED');
  }
  const upd = await tx.query<any>(
    `UPDATE ai_proposed_actions
        SET status = 'approved', approved_by = $3, approved_at = NOW(), updated_at = NOW()
      WHERE company_id = $1 AND id = $2 AND status = 'pending'
      RETURNING ${ACTION_COLUMNS}`,
    [companyId, actionId, actor.userId]
  );
  if (upd.rows.length === 0) {
    // Lost a race with another transition.
    throw new AccountingError(409, 'AI action is not pending approval', 'AI_ACTION_INVALID_STATE');
  }
  await writeAiAuditLog(tx, companyId, actor.userId, 'AI_ACTION_APPROVED', `action=${actionId}, type=${action.action_type}`);
  return mapProposedAction(upd.rows[0]);
}

/** Reject a pending proposed action. */
export async function rejectProposedAction(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  actionId: number
): Promise<AiProposedAction> {
  const res = await tx.query<any>(
    `SELECT * FROM ai_proposed_actions WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, actionId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'AI proposed action not found', 'AI_ACTION_NOT_FOUND');
  }
  if (res.rows[0].status !== 'pending') {
    throw new AccountingError(409, 'AI action is not pending', 'AI_ACTION_INVALID_STATE');
  }
  const upd = await tx.query<any>(
    `UPDATE ai_proposed_actions
        SET status = 'rejected', updated_at = NOW()
      WHERE company_id = $1 AND id = $2 AND status = 'pending'
      RETURNING ${ACTION_COLUMNS}`,
    [companyId, actionId]
  );
  if (upd.rows.length === 0) {
    throw new AccountingError(409, 'AI action is not pending', 'AI_ACTION_INVALID_STATE');
  }
  await writeAiAuditLog(tx, companyId, actor.userId, 'AI_ACTION_REJECTED', `action=${actionId}`);
  return mapProposedAction(upd.rows[0]);
}

export async function executeProposedAction(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  actionId: number
): Promise<AiProposedAction> {
  const res = await tx.query<any>(
    `SELECT * FROM ai_proposed_actions WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, actionId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'AI proposed action not found', 'AI_ACTION_NOT_FOUND');
  }
  const action = res.rows[0];
  // Idempotent: a repeated request after success returns the existing result and
  // never posts again.
  if (action.status === 'executed') return mapProposedAction(action);
  if (action.status !== 'approved') {
    throw new AccountingError(409, 'AI action must be approved before execution', 'AI_ACTION_NOT_APPROVED');
  }
  // Execution must verify the persisted approval, never a client-supplied status.
  if (!action.approved_by || !action.approved_at) {
    throw new AccountingError(409, 'AI action has no recorded approval', 'AI_ACTION_NOT_APPROVED');
  }
  // Maker-checker: a human creator must never execute their own action. For
  // AI-generated proposals the AI is the maker, so the human checker may execute.
  if (!action.created_by_ai && Number(action.created_by) === Number(actor.userId)) {
    throw new AccountingError(403, 'You cannot execute your own proposed action', 'AI_ACTION_SELF_EXECUTION');
  }
  const params = action.parameters || {};
  if (action.action_type === 'post_journal') {
    if (!hasPermission(actor.role, 'journals:write')) {
      throw new AccountingError(403, "Role lacks required permission 'journals:write'", 'PERMISSION_DENIED');
    }
    const lines = Array.isArray(params.lines) ? params.lines : [];
    if (lines.length < 2) {
      throw new AccountingError(400, 'At least two journal lines are required', 'INVALID_JOURNAL');
    }
    await postJournalEntry(tx, companyId, actor, {
      txnDate: params.txnDate || new Date().toISOString().slice(0, 10),
      description: params.description || action.description,
      memo: `Executed from AI proposed action #${action.id}`,
      reference: params.reference || null,
      sourceType: 'manual',
      sourceId: null,
      lines: lines.map((l: any) => ({
        accountId: Number(l.accountId),
        debit: String(l.debit ?? '0'),
        credit: String(l.credit ?? '0'),
        description: l.description || null,
      })),
    });
  } else if (action.action_type === 'create_quote_draft') {
    if (!hasPermission(actor.role, 'estimates:write')) {
      throw new AccountingError(403, "Role lacks required permission 'estimates:write'", 'PERMISSION_DENIED');
    }
    if (!params.customerId || !Array.isArray(params.lines) || params.lines.length === 0) {
      throw new AccountingError(400, 'create_quote_draft requires customerId and at least one line', 'INVALID_QUOTE');
    }
    const quoteService = await import('./quoteService.ts');
    await quoteService.createQuote(tx, companyId, actor, {
      customerId: params.customerId,
      title: params.title || action.description,
      lines: params.lines,
      taxRate: params.taxRate ?? 0,
      validUntil: params.validUntil ?? null,
      notes: params.notes ?? `Created from AI proposed action #${action.id}`,
    } as any);
  } else if (action.action_type === 'create_invoice') {
    if (!hasPermission(actor.role, 'invoices:write')) {
      throw new AccountingError(403, "Role lacks required permission 'invoices:write'", 'PERMISSION_DENIED');
    }
    if (!params.customerId || !Array.isArray(params.lines) || params.lines.length === 0) {
      throw new AccountingError(400, 'create_invoice requires customerId and at least one line', 'INVALID_INVOICE');
    }
    const salesService = await import('./salesService.ts');
    const resolved = await resolveInvoiceLines(tx, companyId, params.lines);
    if (resolved.length === 0) {
      throw new AccountingError(400, 'create_invoice has no valid lines', 'INVALID_INVOICE');
    }
    await salesService.createInvoiceOrSalesReceipt(tx, companyId, actor, {
      customerId: Number(params.customerId),
      invoiceDate: params.invoiceDate || new Date().toISOString().slice(0, 10),
      taxRate: Number(params.taxRate) || 0,
      notes: params.notes ?? `Created from AI proposed action #${action.id}`,
      lines: resolved,
    } as any);
  } else {
    throw new AccountingError(400, `AI action type '${action.action_type}' cannot be executed automatically`, 'AI_ACTION_UNSUPPORTED');
  }
  // Atomically transition approved → executed, persisting executor identity and
  // time. The status guard ensures at most one execution wins the race.
  const upd = await tx.query<any>(
    `UPDATE ai_proposed_actions
        SET status = 'executed', executed_by = $3, executed_at = NOW(), updated_at = NOW()
      WHERE company_id = $1 AND id = $2 AND status = 'approved'
      RETURNING ${ACTION_COLUMNS}`,
    [companyId, actionId, actor.userId]
  );
  if (upd.rows.length === 0) {
    throw new AccountingError(409, 'AI action is no longer approved', 'AI_ACTION_NOT_APPROVED');
  }
  await writeAiAuditLog(tx, companyId, actor.userId, 'AI_ACTION_EXECUTED', `action=${action.id}, type=${action.action_type}`);
  return mapProposedAction(upd.rows[0]);
}

export async function listAnomalyAlerts(
  tx: Transaction,
  companyId: number,
  status?: string
): Promise<AiAnomalyAlert[]> {
  const res = await tx.query<any>(
    `SELECT id, company_id, anomaly_type, severity, description, evidence, status, created_at, resolved_at
       FROM ai_anomaly_alerts
      WHERE company_id = $1 AND ($2::TEXT IS NULL OR status = $2)
      ORDER BY created_at DESC`,
    [companyId, status || null]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    anomalyType: r.anomaly_type,
    severity: r.severity,
    description: r.description,
    evidence: r.evidence,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));
}

export async function detectAnomalies(tx: Transaction, companyId: number): Promise<AiAnomalyAlert[]> {
  const overdue = await tx.query<{ count: number; balance: string }>(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(balance_due), 0)::text AS balance
       FROM invoices
      WHERE company_id = $1 AND balance_due > 0
        AND (status = 'overdue' OR (status <> 'paid' AND due_date < CURRENT_DATE))`,
    [companyId]
  );
  const negativeStock = await tx.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM inventory_items WHERE company_id = $1 AND on_hand < 0`,
    [companyId]
  );
  const lowStock = await tx.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM inventory_items
      WHERE company_id = $1 AND reorder_point > 0 AND on_hand <= reorder_point`,
    [companyId]
  );
  // Wastage: consumption rows where waste exceeds 10% of issued quantity.
  const wastage = await tx.query<{ count: number; wasteQty: string }>(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(waste_usage_qty), 0)::text AS wasteQty
       FROM job_material_requirements
      WHERE company_id = $1 AND issued_usage_qty > 0 AND waste_usage_qty > issued_usage_qty * 0.10`,
    [companyId]
  );
  // Delayed production: exam batches past due and not finished, on unfinished jobs.
  const delayed = await tx.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM exam_assessment_batches
      WHERE company_id = $1
        AND due_date IS NOT NULL AND due_date < CURRENT_DATE
        AND status NOT IN ('completed', 'cancelled')`,
    [companyId]
  );
  // Unprofitable jobs: realized margin below zero (authoritative profitability report).
  let unprofitableCount = 0;
  try {
    const { getPrintingJobProfitability } = await import('./operationalReports.ts');
    const jp = await getPrintingJobProfitability(tx, companyId);
    unprofitableCount = (jp.rows || []).filter((r: any) => Number(r.realizedMarginPct) < 0).length;
  } catch {
    unprofitableCount = 0;
  }

  const candidates: Array<{ anomalyType: string; severity: AiAnomalyAlert['severity']; description: string; evidence: any }> = [];
  if (Number(overdue.rows[0]?.count) > 0) {
    candidates.push({
      anomalyType: 'overdue_receivables',
      severity: 'warning',
      description: `${overdue.rows[0].count} overdue invoice(s) totalling ${overdue.rows[0].balance}`,
      evidence: overdue.rows[0],
    });
  }
  if (Number(negativeStock.rows[0]?.count) > 0) {
    candidates.push({
      anomalyType: 'negative_inventory',
      severity: 'critical',
      description: `${negativeStock.rows[0].count} inventory item(s) with negative stock`,
      evidence: negativeStock.rows[0],
    });
  }
  if (Number(lowStock.rows[0]?.count) > 0) {
    candidates.push({
      anomalyType: 'low_stock',
      severity: 'info',
      description: `${lowStock.rows[0].count} item(s) at or below reorder point`,
      evidence: lowStock.rows[0],
    });
  }
  if (Number(wastage.rows[0]?.count) > 0) {
    candidates.push({
      anomalyType: 'wastage_high',
      severity: 'warning',
      description: `${wastage.rows[0].count} material line(s) with waste above 10% of issued quantity`,
      evidence: wastage.rows[0],
    });
  }
  if (Number(delayed.rows[0]?.count) > 0) {
    candidates.push({
      anomalyType: 'production_delayed',
      severity: 'warning',
      description: `${delayed.rows[0].count} production job(s) past their exam due date`,
      evidence: delayed.rows[0],
    });
  }
  if (unprofitableCount > 0) {
    candidates.push({
      anomalyType: 'unprofitable_job',
      severity: 'warning',
      description: `${unprofitableCount} printing job(s) with negative realized margin`,
      evidence: { count: unprofitableCount },
    });
  }

  for (const c of candidates) {
    await tx.query(
      `INSERT INTO ai_anomaly_alerts (company_id, anomaly_type, severity, description, evidence, status)
       SELECT $1, $2, $3, $4, $5::jsonb, 'open'
        WHERE NOT EXISTS (
          SELECT 1 FROM ai_anomaly_alerts WHERE company_id = $1 AND anomaly_type = $2 AND status = 'open'
        )`,
      [companyId, c.anomalyType, c.severity, c.description, JSON.stringify(c.evidence)]
    );
  }
  return listAnomalyAlerts(tx, companyId, 'open');
}

export async function setAnomalyStatus(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  id: number,
  status: string
): Promise<AiAnomalyAlert> {
  if (!['open', 'acknowledged', 'resolved', 'dismissed'].includes(status)) {
    throw new AccountingError(400, 'Invalid anomaly status', 'AI_ANOMALY_INVALID_STATUS');
  }
  const res = await tx.query<any>(
    `UPDATE ai_anomaly_alerts
        SET status = $3,
            resolved_at = CASE WHEN $3 IN ('resolved','dismissed') THEN NOW() ELSE resolved_at END
      WHERE company_id = $1 AND id = $2
      RETURNING id, company_id, anomaly_type, severity, description, evidence, status, created_at, resolved_at`,
    [companyId, id, status]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Anomaly alert not found', 'AI_ANOMALY_NOT_FOUND');
  }
  const r = res.rows[0];
  await writeAiAuditLog(tx, companyId, actor.userId, 'AI_ANOMALY_STATUS', `alert=${id}, status=${status}`);
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    anomalyType: r.anomaly_type,
    severity: r.severity,
    description: r.description,
    evidence: r.evidence,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export async function writeAiAuditLog(
  tx: Transaction,
  companyId: number,
  actorUserId: number,
  action: string,
  query?: string | null,
  responseSummary?: string | null
): Promise<void> {
  await tx.query(
    `INSERT INTO ai_audit_logs (company_id, user_id, action, query, response_summary)
     VALUES ($1, $2, $3, $4, $5)`,
    [companyId, actorUserId, action, query || null, responseSummary || null]
  );
}
