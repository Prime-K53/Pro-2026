import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as aiService from '../services/aiService.ts';
import * as aiProvider from '../services/aiProvider.ts';
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
  const { requireAuth, requireReadOrWrite } = createAuthMiddleware(db);

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
        aiService.getConversationMessages(tx, auth.companyId, conversationId)
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

      let result;
      try {
        result = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          aiService.chat(tx, auth.companyId, auth.userId, auth.role || 'user', companyName, providerConfig, conversationId || null, message)
        );
      } catch (err: any) {
        // Provider failover only for provider-level failures, never for budget/validation.
        const code = err?.code;
        if (fallbackConfig && (code === 'AI_PROVIDER_ERROR' || code === 'AI_PROVIDER_CIRCUIT_OPEN')) {
          result = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
            aiService.chat(tx, auth.companyId, auth.userId, auth.role || 'user', companyName, fallbackConfig!, conversationId || null, message)
          );
        } else {
          throw err;
        }
      }

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

  // PATCH /ai/actions/:id — update action status (approve/reject)
  router.patch('/ai/actions/:id', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const actionId = Number(req.params.id);
      const { status } = req.body || {};
      if (!status || !['approved', 'rejected', 'executed'].includes(status)) {
        return res.status(400).json({ error: 'status must be approved, rejected, or executed' });
      }
      const action = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        aiService.updateProposedActionStatus(tx, auth.companyId, actionId, status)
      );
      return res.json({ action });
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

  return router;
}