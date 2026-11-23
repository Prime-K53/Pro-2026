import { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, type ActorContext } from './accountingEngine.ts';
import { chatCompletion, sanitizePrompt, buildSystemPrompt, AiProviderConfig } from './aiProvider.ts';
import { hasPermission } from '../permissions.ts';

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

export async function getConversationMessages(
  tx: Transaction,
  companyId: number,
  conversationId: number
): Promise<AiMessage[]> {
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

  // Create or get conversation
  let convId = conversationId;
  if (!convId) {
    const conv = await createConversation(tx, companyId, userId, sanitized.slice(0, 50));
    convId = conv.id;
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
  const history = await getConversationMessages(tx, companyId, convId);
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
    createdBy: Number(r.created_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function proposeAction(
  tx: Transaction,
  companyId: number,
  userId: number,
  conversationId: number | null,
  actionType: string,
  description: string,
  parameters: any
): Promise<AiProposedAction> {
  const res = await tx.query<any>(
    `INSERT INTO ai_proposed_actions (company_id, conversation_id, action_type, description, parameters, status, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6)
     RETURNING id, company_id, conversation_id, action_type, description, parameters, status, approval_id, created_by, created_at, updated_at`,
    [companyId, conversationId, actionType, description, JSON.stringify(parameters ?? {}), userId]
  );
  return mapProposedAction(res.rows[0]);
}

export async function listProposedActions(
  tx: Transaction,
  companyId: number,
  status?: string
): Promise<AiProposedAction[]> {
  const res = await tx.query<any>(
    `SELECT id, company_id, conversation_id, action_type, description, parameters, status, approval_id, created_by, created_at, updated_at
       FROM ai_proposed_actions
      WHERE company_id = $1 AND ($2::TEXT IS NULL OR status = $2)
      ORDER BY created_at DESC`,
    [companyId, status || null]
  );
  return res.rows.map(mapProposedAction);
}

export async function updateProposedActionStatus(
  tx: Transaction,
  companyId: number,
  actionId: number,
  status: 'pending' | 'approved' | 'rejected' | 'executed'
): Promise<AiProposedAction> {
  const res = await tx.query<any>(
    `UPDATE ai_proposed_actions SET status = $3, updated_at = NOW()
      WHERE company_id = $1 AND id = $2
      RETURNING id, company_id, conversation_id, action_type, description, parameters, status, approval_id, created_by, created_at, updated_at`,
    [companyId, actionId, status]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'AI proposed action not found', 'AI_ACTION_NOT_FOUND');
  }
  return mapProposedAction(res.rows[0]);
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
  if (action.status === 'executed') return mapProposedAction(action);
  if (action.status !== 'approved') {
    throw new AccountingError(409, 'AI action must be approved before execution', 'AI_ACTION_NOT_APPROVED');
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
  } else {
    throw new AccountingError(400, `AI action type '${action.action_type}' cannot be executed automatically`, 'AI_ACTION_UNSUPPORTED');
  }
  const upd = await tx.query<any>(
    `UPDATE ai_proposed_actions SET status = 'executed', updated_at = NOW()
      WHERE company_id = $1 AND id = $2
      RETURNING id, company_id, conversation_id, action_type, description, parameters, status, approval_id, created_by, created_at, updated_at`,
    [companyId, actionId]
  );
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
