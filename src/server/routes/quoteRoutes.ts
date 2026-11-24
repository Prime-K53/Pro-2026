import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as quoteService from '../services/quoteService.ts';

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
  console.error(`[Quote Route Error ${requestId}]`, err);
  return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId });
}

export function createQuoteRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection);

  router.get('/quotes', requirePermission('invoices:read'), async (req: Request, res: Response) => {
    try {
      const quotes = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        quoteService.listQuotes(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, quotes });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/quotes/:id', requirePermission('invoices:read'), async (req: Request, res: Response) => {
    try {
      const quote = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        quoteService.getQuote(tx, req.auth!.companyId, Number(req.params.id))
      );
      return res.json(quote);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/quotes', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const quote = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        quoteService.createQuote(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json(quote);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/quotes/:id/versions', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const quote = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        quoteService.addQuoteVersion(tx, req.auth!.companyId, toActor(req), Number(req.params.id), req.body || {})
      );
      return res.status(201).json(quote);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/quotes/:id/status', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const quote = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        quoteService.setQuoteStatus(tx, req.auth!.companyId, toActor(req), Number(req.params.id), req.body?.status)
      );
      return res.json(quote);
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}