import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as documentQrService from '../services/documentQrService.ts';

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const msg = (err as any)?.message || 'Document QR service error';
  console.error('[Document QR Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createDocumentQrRoutes(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requirePermission } = createAuthMiddleware(db);

  // POST /documents/:kind/:id/qr — generate QR code
  router.post('/documents/:kind/:id/qr', requireAuth, requirePermission('documents:qr:manage'), csrfProtection, async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const documentKind = req.params.kind;
      const documentId = Number(req.params.id);
      const result = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        documentQrService.generateQrToken(tx, auth.companyId, documentKind, documentId, {
          version: req.body?.version,
          contentHash: req.body?.contentHash,
        })
      );
      return res.status(201).json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /qr-verify/:token — verify document authenticity (public)
  router.get('/qr-verify/:token', async (req: Request, res: Response) => {
    try {
      const token = req.params.token;
      const result = await db.withSystemDb((tx: Transaction) =>
        documentQrService.verifyQrToken(tx, token)
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /qr-verify/:token/page — branded public verification page (safe fields only)
  router.get('/qr-verify/:token/page', async (req: Request, res: Response) => {
    try {
      const token = req.params.token;
      const result = await db.withSystemDb((tx: Transaction) =>
        documentQrService.verifyQrToken(tx, token)
      );
      let companyName = 'Prime ERP';
      if (result.companyId) {
        const c = await db.withSystemDb((tx: Transaction) =>
          tx.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1 LIMIT 1`, [result.companyId])
        );
        companyName = c.rows[0]?.name || companyName;
      }
      const esc = (v: unknown) =>
        String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
      const status = result.valid ? 'Authentic' : result.revoked ? 'Revoked' : 'Not recognised';
      const colour = result.valid ? '#047857' : '#b91c1c';
      const rows: Array<[string, unknown]> = [
        ['Document', result.documentKind],
        ['Reference', result.documentId],
        ['Version', result.documentVersion ?? 1],
        ['Issued', result.createdAt],
      ].filter(([, v]) => v !== undefined && v !== null) as Array<[string, unknown]>;
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Verify — ${esc(companyName)}</title>
<style>body{font-family:Arial,sans-serif;margin:40px;color:#111;font-size:14px}.card{max-width:520px}.brand{border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:18px}.brand h1{margin:0;font-size:18px}.status{font-size:18px;font-weight:700;margin:10px 0}table{border-collapse:collapse;width:100%}td{padding:7px 10px;border-bottom:1px solid #eee}td:first-child{color:#555;width:140px}.note{margin-top:16px;color:#666;font-size:12px}</style></head>
<body><div class="card">
<div class="brand"><h1>${esc(companyName)}</h1><div style="color:#666;font-size:12px">Document verification</div></div>
<div class="status" style="color:${colour}">${esc(status)}</div>
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
<p class="note">This page confirms authenticity only. It does not display confidential document contents or customer information.</p>
</div></body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /documents/:kind/:id/qr/revoke — revoke QR code
  router.post('/documents/:kind/:id/qr/revoke', requireAuth, requirePermission('documents:qr:manage'), csrfProtection, async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const documentKind = req.params.kind;
      const documentId = Number(req.params.id);
      await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        documentQrService.revokeQrToken(tx, auth.companyId, documentKind, documentId)
      );
      return res.json({ revoked: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // Simple test route
  router.get('/test', (req, res) => {
    res.json({ ok: true });
  });

  return router;
}