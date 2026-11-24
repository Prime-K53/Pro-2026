import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as complianceService from '../services/complianceService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  console.error(`[Compliance Route Error ${requestId}]`, err);
  return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId });
}

export function createComplianceRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection);

  // Customer statement (AR statement of account): self-service-readable.
  router.get('/reports/vendor-1099-summary', requirePermission('tax:read'), async (req: Request, res: Response) => {
    try {
      const year = Number(req.query.year || new Date().getFullYear());
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return res.status(400).json({ error: 'Invalid year', code: 'INVALID_YEAR' });
      }
      const summary = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        complianceService.getVendor1099Summary(tx, req.auth!.companyId, year)
      );
      return res.json(summary);
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}