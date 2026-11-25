import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import {
  approveExpenseClaim,
  createExpenseClaim,
  getExpenseClaim,
  listExpenseClaims,
  reimburseExpenseClaim,
  rejectExpenseClaim,
  submitExpenseClaim,
} from '../services/expenseService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleExpenseError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
  const msg = (err as any)?.message || 'Expense operation failed';
  console.error('[Expense Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createExpenseRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

  router.get('/expenses/claims', requirePermission('expenses:read'), async (req: Request, res: Response) => {
    try {
      const claims = await db.withCompanyDb(req.auth!.companyId, tx => listExpenseClaims(tx, req.auth!.companyId, { status: req.query.status ? String(req.query.status) : undefined }));
      return res.json({ claims });
    } catch (err) { return handleExpenseError(res, err); }
  });

  router.get('/expenses/claims/:id', requirePermission('expenses:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid claim id' });
      const claim = await db.withCompanyDb(req.auth!.companyId, tx => getExpenseClaim(tx, req.auth!.companyId, id));
      return res.json({ claim });
    } catch (err) { return handleExpenseError(res, err); }
  });

  router.post('/expenses/claims', requirePermission('expenses:write'), async (req: Request, res: Response) => {
    try {
      const claim = await db.withCompanyDb(req.auth!.companyId, tx => createExpenseClaim(tx, req.auth!.companyId, toActor(req), req.body || {}));
      return res.status(201).json({ claim });
    } catch (err) { return handleExpenseError(res, err); }
  });

  router.post('/expenses/claims/:id/submit', requirePermission('expenses:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const claim = await db.withCompanyDb(req.auth!.companyId, tx => submitExpenseClaim(tx, req.auth!.companyId, toActor(req), id));
      return res.json({ claim });
    } catch (err) { return handleExpenseError(res, err); }
  });

  router.post('/expenses/claims/:id/approve', requirePermission('expenses:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const claim = await db.withCompanyDb(req.auth!.companyId, tx => approveExpenseClaim(tx, req.auth!.companyId, toActor(req), id, req.body || {}));
      return res.json({ claim });
    } catch (err) { return handleExpenseError(res, err); }
  });

  router.post('/expenses/claims/:id/reject', requirePermission('expenses:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const claim = await db.withCompanyDb(req.auth!.companyId, tx => rejectExpenseClaim(tx, req.auth!.companyId, toActor(req), id, String(req.body?.reason || '')));
      return res.json({ claim });
    } catch (err) { return handleExpenseError(res, err); }
  });

  router.post('/expenses/claims/:id/reimburse', requirePermission('expenses:reimburse'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx => reimburseExpenseClaim(tx, req.auth!.companyId, toActor(req), id, { ...(req.body || {}), idempotencyKey }));
      return res.json(result);
    } catch (err) { return handleExpenseError(res, err); }
  });

  return router;
}
