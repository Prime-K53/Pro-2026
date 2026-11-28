import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as aiService from '../services/aiService.ts';
import * as aiProvider from '../services/aiProvider.ts';
import * as aiMemoryService from '../services/aiMemoryService.ts';
import { encryptSecret, decryptSecret } from '../services/secretCrypto.ts';

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const msg = (err as any)?.message || 'AI service error';
  console.error('[AI Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createAiRoutes(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requireReadOrWrite, requirePermission } = createAuthMiddleware(db);

  router.use('/ai', requireAuth, csrfProtection);
  router.use('/ai', requireReadOrWrite('ai:read', 'ai:write'));

  // GET /ai/config — get AI configuration
  router.get('/ai/config', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const config = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.getAiConfig(tx, auth.companyId)
      );
      return res.json({ config });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /ai/config — save AI configuration
  router.post('/ai/config', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { provider, apiKey, modelName, enabled, fallbackProvider, fallbackApiKey, fallbackModel } = req.body || {};
      if (!provider || !modelName) {
        return res.status(400).json({ error: 'provider and modelName are required' });
      }

      const apiKeyEncrypted = apiKey ? encryptSecret(apiKey) : '';
      const fallback =
        fallbackProvider && fallbackModel && fallbackApiKey
          ? {
              provider: String(fallbackProvider),
              apiKeyEncrypted: encryptSecret(String(fallbackApiKey)),
              modelName: String(fallbackModel),
            }
          : null;

      const config = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.upsertAiConfig(
          tx,
          auth.companyId,
          provider,
          apiKeyEncrypted,
          modelName,
          enabled !== false,
          fallback
        )
      );

      await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.writeAiAuditLog(tx, auth.companyId, auth.userId, 'AI_CONFIG_UPDATED', `provider=${provider}, model=${modelName}`)
      );

      return res.json({ config });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /ai/models — list available models from provider
  router.post('/ai/models', async (req: Request, res: Response) => {
    try {
      const { provider, apiKey } = req.body || {};
      if (!provider || !apiKey) {
        return res.status(400).json({ error: 'provider and apiKey are required' });
      }

      const models = await aiProvider.listModels({ provider, apiKey, modelName: '' });
      return res.json({ models });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /ai/conversations — list user's conversations
  router.get('/ai/conversations', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const conversations = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.listConversations(tx, auth.companyId, auth.userId)
      );
      return res.json({ conversations });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /ai/conversations — create new conversation
  router.post('/ai/conversations', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { title } = req.body || {};
      const conversation = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.createConversation(tx, auth.companyId, auth.userId, title)
      );
      return res.status(201).json({ conversation });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /ai/conversations/:id/messages — get conversation messages
  router.get('/ai/conversations/:id/messages', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const conversationId = Number(req.params.id);
      const messages = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.getConversationMessages(tx, auth.companyId, conversationId, auth.userId)
      );
      return res.json({ messages });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /ai/chat — send a message and get AI response
  router.post('/ai/chat', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { conversationId, message } = req.body || {};
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
      }

      const config = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.getAiConfig(tx, auth.companyId)
      );
      if (!config || !config.enabled || !config.hasApiKey || !config.provider || !config.modelName) {
        return res.status(400).json({ error: 'AI is not configured. Please set up an API key in settings.' });
      }

      const configRow = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        tx.query<any>(
          `SELECT api_key_encrypted, fallback_provider, fallback_model, fallback_api_key_encrypted
             FROM ai_config WHERE company_id = $1 LIMIT 1`,
          [auth.companyId]
        )
      );
      const row = configRow.rows[0];
      const apiKey = decryptSecret(row?.api_key_encrypted || '');

      const providerConfig: aiProvider.AiProviderConfig = {
        provider: config.provider as aiProvider.AiProvider,
        apiKey,
        modelName: config.modelName,
      };

      let fallbackConfig: aiProvider.AiProviderConfig | null = null;
      if (row?.fallback_provider && row?.fallback_model && row?.fallback_api_key_encrypted) {
        fallbackConfig = {
          provider: row.fallback_provider as aiProvider.AiProvider,
          apiKey: decryptSecret(row.fallback_api_key_encrypted),
          modelName: row.fallback_model,
        };
      }

      const companyRes = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        tx.query<any>(`SELECT name FROM companies WHERE id = $1 LIMIT 1`, [auth.companyId])
      );
      const companyName = companyRes.rows[0]?.name || 'Company';

      const requestId = randomUUID();

      // Best-effort query embedding for semantic recall (OUTSIDE any tx, D-04).
      // Skipped for providers without embeddings; never blocks chat.
      let queryEmbedding: number[] | undefined;
      if (providerConfig.provider === 'openai' || providerConfig.provider === 'gemini') {
        try {
          const emb = await aiProvider.embedContent(providerConfig, [message]);
          queryEmbedding = emb.vectors[0];
        } catch {
          /* recall is best-effort */
        }
      }

      // Phase 1: short DB transaction — persist user message + build evidence (+ recall).
      const prep = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.prepareChat(tx, auth.companyId, auth.userId, auth.role || 'user', companyName, conversationId || null, message, queryEmbedding)
      );

      // Phase 2: ATOMIC reservation + durable 'reserved' attempt (before provider).
      let usedAttempt = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.reserveAttempt(tx, auth.companyId, requestId, 1, providerConfig.provider, providerConfig.modelName, prep.messages)
      );

      // Phase 3: provider call OUTSIDE any DB transaction (D-04).
      let raw;
      try {
        raw = await aiProvider.chatCompletion(providerConfig, prep.messages as any);
      } catch (err: any) {
        const code = err?.code;
        // Provider outcome is ambiguous (may have billed) — keep reservation as unresolved.
        await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          aiService.recordProviderFailure(tx, auth.companyId, usedAttempt.attemptId, true, String(err?.message || 'provider error'))
        );
        if (fallbackConfig && (code === 'AI_PROVIDER_ERROR' || code === 'AI_PROVIDER_CIRCUIT_OPEN')) {
          // Fallback gets its OWN reservation + attempt record.
          usedAttempt = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
            aiService.reserveAttempt(tx, auth.companyId, requestId, 2, fallbackConfig!.provider, fallbackConfig!.modelName, prep.messages)
          );
          raw = await aiProvider.chatCompletion(fallbackConfig, prep.messages as any);
        } else {
          throw err;
        }
      }

      // Phase 4: settle usage in its OWN tx (survives a later finalize failure).
      await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.settleAttempt(tx, auth.companyId, usedAttempt.attemptId, raw.usage, raw.requestId)
      );

      // Phase 5: verify claims + persist assistant answer (separate tx).
      const result = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.finalizeChat(tx, auth.companyId, prep, { content: raw.content, usage: raw.usage })
      );

      await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.writeAiAuditLog(tx, auth.companyId, auth.userId, 'AI_CHAT', message, result.response.content.slice(0, 200))
      );

      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /ai/anomalies — list anomaly alerts
  router.get('/ai/anomalies', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const status = req.query.status ? String(req.query.status) : undefined;
      const alerts = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.listAnomalyAlerts(tx, auth.companyId, status)
      );
      return res.json({ alerts });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /ai/anomalies/detect — run anomaly detection
  router.post('/ai/anomalies/detect', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const alerts = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.detectAnomalies(tx, auth.companyId)
      );
      return res.json({ alerts });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /ai/actions — list proposed actions
  router.get('/ai/actions', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const status = req.query.status ? String(req.query.status) : undefined;
      const actions = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.listProposedActions(tx, auth.companyId, status)
      );
      return res.json({ actions });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /ai/actions — propose a new action
  router.post('/ai/actions', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { conversationId, actionType, description, parameters } = req.body || {};
      if (!actionType || !description) {
        return res.status(400).json({ error: 'actionType and description are required' });
      }
      const action = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.proposeAction(tx, auth.companyId, auth.userId, conversationId || null, actionType, description, parameters || {})
      );
      return res.status(201).json({ action });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // PATCH /ai/actions/:id — approve or reject a proposed action.
  // The acting user is always derived from the authenticated session; any
  // client-supplied approver identity in the body is ignored. Execution is a
  // separate endpoint and can never be triggered through this route.
  router.patch('/ai/actions/:id', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const actionId = Number(req.params.id);
      const { status } = req.body || {};
      if (status !== 'approved' && status !== 'rejected') {
        return res.status(400).json({ error: 'status must be approved or rejected' });
      }
      const actor = { userId: auth.userId, username: auth.username, role: auth.role };
      const action = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        status === 'approved'
          ? aiService.approveProposedAction(tx, auth.companyId, actor, actionId)
          : aiService.rejectProposedAction(tx, auth.companyId, actor, actionId)
      );
      return res.json({ action });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // PATCH /ai/anomalies/:id — transition an alert (open→acknowledged→resolved/dismissed)
  router.patch('/ai/anomalies/:id', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { status } = req.body || {};
      const actor = { userId: auth.userId, username: auth.username, role: auth.role };
      const alert = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.setAnomalyStatus(tx, auth.companyId, actor, Number(req.params.id), String(status || ''))
      );
      return res.json({ alert });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /ai/audit — get AI audit logs
  router.get('/ai/audit', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
      const logs = await db.withCompanyDb(auth.companyId, (tx: Transaction) => {
        return tx.query<any>(
          `SELECT id, user_id, action, query, response_summary, created_at
           FROM ai_audit_logs WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [auth.companyId, limit]
        ).then((r: any) => r.rows.map((row: any) => ({
          id: Number(row.id),
          userId: Number(row.user_id),
          action: row.action,
          query: row.query,
          responseSummary: row.response_summary,
          createdAt: row.created_at,
        })));
      });
      return res.json({ logs });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // ─── Budgets, retention, execution ───────────────────────────────────────
  // GET /ai/attempts/unresolved — operator visibility for controlled reconciliation.
  // Read-only: reconciliation remains fail-closed (no client-supplied settlement).
  router.get('/ai/attempts/unresolved', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const rows = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        tx.query<any>(
          `SELECT id, request_id, provider, model, state, reservation_tokens, period, reserved_at
             FROM ai_usage_attempts
            WHERE company_id = $1 AND state IN ('reserved','invoking','unresolved')
            ORDER BY reserved_at DESC LIMIT 200`,
          [auth.companyId]
        )
      );
      return res.json({ attempts: rows.rows });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/ai/budget', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const budget = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.getAiBudget(tx, auth.companyId)
      );
      return res.json({ budget });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.put('/ai/budget', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const budget = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.upsertAiBudget(tx, auth.companyId, req.body || {})
      );
      await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.writeAiAuditLog(tx, auth.companyId, auth.userId, 'AI_BUDGET_UPDATED', JSON.stringify(req.body || {}))
      );
      return res.json({ budget });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.delete('/ai/conversations/:id', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const deleted = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.deleteConversation(tx, auth.companyId, auth.userId, Number(req.params.id))
      );
      return res.json({ deleted });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/ai/retention/purge', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const days = Number(req.body?.olderThanDays ?? 90);
      const purged = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.purgeOldConversations(tx, auth.companyId, days)
      );
      await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.writeAiAuditLog(tx, auth.companyId, auth.userId, 'AI_RETENTION_PURGE', `days=${days}, purged=${purged}`)
      );
      return res.json({ purged });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/ai/actions/:id/execute', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const action = await db.withCompanyDb(auth.companyId, (tx: Transaction) => {
        const actor = { userId: auth.userId, username: auth.username, role: auth.role };
        return aiService.executeProposedAction(tx, auth.companyId, actor, Number(req.params.id));
      });
      return res.json({ action });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/ai/memory/reindex', requirePermission('ai:memory:reindex'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const config = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.getAiConfig(tx, auth.companyId)
      );
      if (!config || !config.enabled || !config.hasApiKey || !config.provider || !config.modelName) {
        return res.status(400).json({ error: 'AI is not configured. Set up an API key in settings before reindexing memory.' });
      }
      if (config.provider !== 'openai' && config.provider !== 'gemini') {
        return res.status(400).json({ error: `Embeddings are not supported for provider ${config.provider}. Use OpenAI or Gemini.` });
      }
      const row = (
        await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          tx.query<any>(`SELECT api_key_encrypted FROM ai_config WHERE company_id = $1 LIMIT 1`, [auth.companyId])
        )
      ).rows[0];
      const providerConfig: aiProvider.AiProviderConfig = {
        provider: config.provider as aiProvider.AiProvider,
        apiKey: decryptSecret(row?.api_key_encrypted || ''),
        modelName: config.modelName,
      };

      // Phase 1 (tx): read data-minimized chunks.
      const chunks = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiMemoryService.buildMemoryChunks(tx, auth.companyId)
      );
      // Phase 2 (OUTSIDE tx, D-04): compute embeddings.
      const vectors: number[][] = [];
      const batchSize = 64;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize).map((c) => c.content);
        const emb = await aiProvider.embedContent(providerConfig, batch);
        vectors.push(...emb.vectors);
      }
      // Phase 3 (tx): persist + prune.
      const result = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiMemoryService.writeChunks(tx, auth.companyId, chunks, vectors, providerConfig.modelName)
      );
      await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.writeAiAuditLog(tx, auth.companyId, auth.userId, 'AI_MEMORY_REINDEX', `upserted=${result.upserted}, pruned=${result.pruned}`)
      );
      return res.json({ ok: true, ...result });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /ai/invoice/propose — AI drafts an invoice from a request; returns a
  // PENDING create_invoice proposal (AI is the maker). A human approves+executes.
  router.post('/ai/invoice/propose', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { customerId, request } = req.body || {};
      if (!customerId || !request || !String(request).trim()) {
        return res.status(400).json({ error: 'customerId and request are required' });
      }
      const config = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.getAiConfig(tx, auth.companyId)
      );
      if (!config || !config.enabled || !config.hasApiKey || !config.provider || !config.modelName) {
        return res.status(400).json({ error: 'AI is not configured. Set up a provider in AI settings first.' });
      }
      const row = (
        await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          tx.query<any>(`SELECT api_key_encrypted FROM ai_config WHERE company_id = $1 LIMIT 1`, [auth.companyId])
        )
      ).rows[0];
      const providerConfig: aiProvider.AiProviderConfig = {
        provider: config.provider as aiProvider.AiProvider,
        apiKey: decryptSecret(row?.api_key_encrypted || ''),
        modelName: config.modelName,
      };

      const today = new Date().toISOString().slice(0, 10);
      // Phase 1 (tx): read the item catalog for authoritative price resolution.
      const catalog = await db.withCompanyDb(auth.companyId, async (tx: Transaction) => {
        const r = await tx.query<any>(
          `SELECT id, name, sku, sales_price::text AS sales_price, item_type
             FROM inventory_items WHERE company_id = $1 AND is_active = TRUE ORDER BY name LIMIT 500`,
          [auth.companyId]
        );
        return r.rows;
      });

      const evidence =
        'Item catalog (id | name | sku | type | price). Use itemId for known items; never invent a price:\n' +
        catalog.map((c: any) => `${c.id} | ${c.name} | ${c.sku || ''} | ${c.item_type} | ${c.sales_price}`).join('\n');

      const messages: Array<aiProvider.AiChatMessage> = [
        {
          role: 'system',
          content:
            'You convert a free-text invoice request into structured invoice lines. Return ONLY JSON: ' +
            '{"lines":[{"itemId":number|null,"description":string,"quantity":number}],"notes":string|null}. ' +
            'Match each requested item to a catalog itemId when possible; otherwise provide a clear description with itemId null. ' +
            'Do not set prices. Quantities are numbers.',
        },
        { role: 'user', content: `${String(request).trim()}\n\n${evidence}` },
      ];

      // Phase 2 (tx): reserve budget against the attempt (D-05).
      const requestId = randomUUID();
      // Narrowed once here: the `!config.provider || !config.modelName` guard
      // above does not survive into the callback below, because TypeScript
      // cannot keep a property narrowing across a function boundary.
      const providerName = config.provider;
      const modelName = config.modelName;
      const attempt = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.reserveAttempt(tx, auth.companyId, requestId, 1, providerName, modelName, messages)
      );

      // Phase 3 (OUTSIDE tx, D-04): provider call.
      const raw = await aiProvider.chatCompletion(providerConfig, messages);

      const result = await db.withCompanyDb(auth.companyId, async (tx: Transaction) => {
        await aiService.settleAttempt(tx, auth.companyId, attempt.attemptId, raw.usage, raw.requestId);
        let parsed: any = null;
        try {
          const s = String(raw.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
          parsed = JSON.parse(s);
        } catch {
          parsed = null;
        }
        const rawLines = Array.isArray(parsed?.lines) ? parsed!.lines : [];
        const resolved = await aiService.resolveInvoiceLines(tx, auth.companyId, rawLines);
        if (resolved.length === 0) {
          return { error: 'Could not resolve any invoice lines from the request.' };
        }
        const action = await aiService.proposeAction(
          tx,
          auth.companyId,
          auth.userId,
          null,
          'create_invoice',
          `Invoice for customer #${customerId}`,
          {
            customerId: Number(customerId),
            invoiceDate: today,
            taxRate: 0,
            notes: parsed?.notes ?? null,
            lines: rawLines,
          },
          { isAiGenerated: true }
        );
        return { action, preview: resolved };
      });

      if ((result as any).error) return res.status(422).json(result);
      return res.status(201).json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}