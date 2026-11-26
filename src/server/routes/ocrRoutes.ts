import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as ocrService from '../services/ocrService.ts';

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  console.error(`[OCR Route Error ${requestId}]`, err);
  return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId });
}

export function createOcrRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection);

  // POST /ai/ocr/extract — body { kind, imageBase64, mime? }
  router.post('/ai/ocr/extract', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { kind, imageBase64, mime } = req.body || {};
      if (kind !== 'quote' && kind !== 'invoice') {
        return res.status(400).json({ error: 'kind must be quote or invoice' });
      }
      const result = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        ocrService.extractDocument(tx, auth.companyId, { userId: auth.userId, username: auth.username }, {
          kind,
          imageBase64: String(imageBase64 || ''),
          mime: mime ? String(mime) : undefined,
        })
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /ai/ocr/:id — fetch a stored extraction
  router.get('/ai/ocr/:id', requirePermission('invoices:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const extraction = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        ocrService.getExtraction(tx, auth.companyId, String(req.params.id))
      );
      return res.json(extraction);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /ai/ocr/retention/purge — delete unconfirmed extractions older than N days
  router.post('/ai/ocr/retention/purge', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const days = Number(req.body?.olderThanDays) || 90;
      const result = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        ocrService.purgeExpiredOcr(tx, auth.companyId, { userId: auth.userId, username: auth.username }, days)
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}