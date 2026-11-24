import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as taxService from '../services/taxService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  if (pgCode === '23505') return res.status(409).json({ error: 'Duplicate record', code: 'DUPLICATE_KEY' });
  if (pgCode === '23503') return res.status(409).json({ error: 'Related record is required or in use', code: 'FOREIGN_KEY_CONSTRAINT' });
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  console.error(`[Tax Route Error ${requestId}]`, err);
  return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId });
}

export function createTaxRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection);

  router.get('/tax-codes', requirePermission('tax:read'), async (req: Request, res: Response) => {
    try {
      const codes = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        taxService.listTaxCodes(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, codes });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/tax-codes', requirePermission('tax:write'), async (req: Request, res: Response) => {
    try {
      const code = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        taxService.createTaxCode(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ code });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/reports/tax-summary', requirePermission('tax:read'), async (req: Request, res: Response) => {
    try {
      const startDate = String(req.query.startDate || req.query.start || '2000-01-01');
      const endDate = String(req.query.endDate || req.query.end || new Date().toISOString().slice(0, 10));
      const summary = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        taxService.getTaxSummaryByJurisdiction(tx, req.auth!.companyId, startDate, endDate)
      );
      return res.json({ companyId: req.auth!.companyId, startDate, endDate, ...summary });
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}