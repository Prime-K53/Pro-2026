import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as ocrService from '../services/ocrService.ts';
import * as aiService from '../services/aiService.ts';

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
  // D-08 three-phase isolation:
  //   Phase 1 (short tx): validate + dedupe + RESERVE budget/attempt.
  //   Phase 2 (NO tx):    invoke the external vision provider.
  //   Phase 3 (short tx): validate output + SETTLE attempt + persist extraction.
  router.post('/ai/ocr/extract', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { kind, imageBase64, mime } = req.body || {};
      if (!['quote', 'invoice', 'receipt', 'supplier_bill'].includes(kind)) {
        return res.status(400).json({ error: 'kind must be quote, invoice, receipt or supplier_bill' });
      }
      const actor = { userId: auth.userId, username: auth.username };

      // Phase 1 — prepare + reserve inside a short company transaction.
      const prep = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        ocrService.prepareOcrExtraction(tx, auth.companyId, actor, {
          kind,
          imageBase64: String(imageBase64 || ''),
          mime: mime ? String(mime) : undefined,
        })
      );
      if (prep.duplicate) {
        return res.json(prep.result);
      }

      // Phase 2 — provider call OUTSIDE any database transaction.
      let raw;
      try {
        raw = await ocrService.runOcrProvider(prep);
      } catch (err: any) {
        // A circuit-open failure is a definite non-billing failure → release the
        // reservation. Timeouts/5xx/network are ambiguous (may have billed) →
        // retain as unresolved per the D-05 fail-closed policy.
        const ambiguous = err?.code !== 'AI_PROVIDER_CIRCUIT_OPEN';
        await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          aiService.recordProviderFailure(tx, auth.companyId, prep.attemptId, ambiguous, String(err?.message || 'provider error'))
        );
        throw err;
      }

      // Phase 3 — finalize + settle inside a new short company transaction.
      try {
        const result = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          ocrService.finalizeOcrExtraction(tx, auth.companyId, actor, prep, raw)
        );
        return res.json(result);
      } catch (err: any) {
        // Provider responded but output was invalid / persistence failed (e.g. a
        // concurrent duplicate hit the UNIQUE(company_id,image_sha256)). Settle
        // from trusted usage when present, else retain as unresolved; never zero.
        await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          aiService.recordProviderFailure(tx, auth.companyId, prep.attemptId, true, String(err?.message || 'finalize error'), raw?.usage)
        );
        throw err;
      }
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