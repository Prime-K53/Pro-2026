import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import {
  categorizeImportedTransaction,
  completeReconciliation,
  createBankRule,
  deleteBankRule,
  dismissDuplicateFeedItem,
  importBankStatement,
  linkBankAccount,
  listBankAccounts,
  listBankRules,
  listBankTransactions,
  listReconciliations,
  markChecksPrinted,
  previewReconciliation,
  recordCheckOrExpense,
  recordDeposit,
  recordTransfer,
  reverseReconciliation,
  toggleBankTransactionCleared,
  voidBankTransaction,
} from '../services/bankingService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleBankingError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  const msg = (err as any)?.message || 'Banking operation failed';
  if (pgCode === '23505' || pgCode === '23514' || pgCode === '23001') {
    return res.status(409).json({ error: msg, code: pgCode });
  }
  console.error('[Banking Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createBankingRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

  // Bank & Credit Card Accounts
  router.get('/banking/accounts', requirePermission('banking:read'), async (req: Request, res: Response) => {
    try {
      const bankAccounts = await db.withCompanyDb(req.auth!.companyId, tx =>
        listBankAccounts(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, bankAccounts });
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/accounts', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const bankAccount = await db.withCompanyDb(req.auth!.companyId, tx =>
        linkBankAccount(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ bankAccount });
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  // Bank Register Transactions
  router.get('/banking/transactions', requirePermission('banking:read'), async (req: Request, res: Response) => {
    try {
      const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
      const status = req.query.status ? String(req.query.status) : undefined;
      const isCleared =
        req.query.cleared === 'true' ? true : req.query.cleared === 'false' ? false : undefined;
      const transactions = await db.withCompanyDb(req.auth!.companyId, tx =>
        listBankTransactions(tx, req.auth!.companyId, { accountId, status, isCleared })
      );
      return res.json({ companyId: req.auth!.companyId, transactions });
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  // Checks, Expenses & Credit Card Charges
  router.post('/banking/expenses', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordCheckOrExpense(tx, req.auth!.companyId, toActor(req), {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/checks/print', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        markChecksPrinted(tx, req.auth!.companyId, toActor(req), req.body?.bankTxnIds || [])
      );
      return res.json(result);
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  // Deposits & Transfers
  router.post('/banking/deposits', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordDeposit(tx, req.auth!.companyId, toActor(req), {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/transfers', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordTransfer(tx, req.auth!.companyId, toActor(req), {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/transactions/:id/void', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid bank transaction id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        voidBankTransaction(tx, req.auth!.companyId, toActor(req), id, req.body?.reason)
      );
      return res.json(result);
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.patch('/banking/transactions/:id/cleared', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid bank transaction id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        toggleBankTransactionCleared(tx, req.auth!.companyId, id, Boolean(req.body?.cleared))
      );
      return res.json(result);
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  // Bank Rules & CSV/OFX Imports
  router.get('/banking/rules', requirePermission('banking:read'), async (req: Request, res: Response) => {
    try {
      const rules = await db.withCompanyDb(req.auth!.companyId, tx => listBankRules(tx, req.auth!.companyId));
      return res.json({ companyId: req.auth!.companyId, rules });
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/rules', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const rule = await db.withCompanyDb(req.auth!.companyId, tx =>
        createBankRule(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ rule });
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.delete('/banking/rules/:id', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid rule id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        deleteBankRule(tx, req.auth!.companyId, id)
      );
      return res.json(result);
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/imports', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        importBankStatement(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json(result);
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/transactions/:id/categorize', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid bank transaction id' });
      const transaction = await db.withCompanyDb(req.auth!.companyId, tx =>
        categorizeImportedTransaction(tx, req.auth!.companyId, toActor(req), id, req.body || {})
      );
      return res.json({ transaction });
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/transactions/:id/dismiss-duplicate', requirePermission('banking:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid bank transaction id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        dismissDuplicateFeedItem(tx, req.auth!.companyId, toActor(req), id, req.body?.reason)
      );
      return res.json(result);
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  // Bank Reconciliations
  router.get('/banking/reconciliations', requirePermission('banking:read'), async (req: Request, res: Response) => {
    try {
      const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
      const reconciliations = await db.withCompanyDb(req.auth!.companyId, tx =>
        listReconciliations(tx, req.auth!.companyId, accountId)
      );
      return res.json({ companyId: req.auth!.companyId, reconciliations });
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/reconciliations/preview', requirePermission('banking:reconcile'), async (req: Request, res: Response) => {
    try {
      const preview = await db.withCompanyDb(req.auth!.companyId, tx =>
        previewReconciliation(tx, req.auth!.companyId, req.body || {})
      );
      return res.json({ preview });
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/reconciliations/complete', requirePermission('banking:reconcile'), async (req: Request, res: Response) => {
    try {
      const reconciliation = await db.withCompanyDb(req.auth!.companyId, tx =>
        completeReconciliation(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ reconciliation });
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  router.post('/banking/reconciliations/:id/reverse', requirePermission('banking:reconcile'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid reconciliation id' });
      const reconciliation = await db.withCompanyDb(req.auth!.companyId, tx =>
        reverseReconciliation(tx, req.auth!.companyId, toActor(req), id, String(req.body?.reason || ''))
      );
      return res.json({ reconciliation });
    } catch (err) {
      return handleBankingError(res, err);
    }
  });

  return router;
}
