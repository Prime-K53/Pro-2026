import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { hasPermission } from '../permissions.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import {
  deleteAttachmentRecord,
  generateInvoiceFromWorkflow,
  getAttachmentForServing,
  getDocumentPreviewPayload,
  listAttachments,
  listCompanyDocuments,
  UnifiedDocumentKind,
} from '../services/documentsService.ts';
import { renderContractToRenderModel } from '../services/contractRenderService.ts';
import * as documentQrService from '../services/documentQrService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleDocumentsError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  const msg = (err as any)?.message || 'Documents operation failed';
  if (pgCode === '23505' || pgCode === '23514' || pgCode === '23001') {
    return res.status(409).json({ error: msg, code: pgCode });
  }
  console.error('[Documents Route Error]', err);
  return res.status(500).json({ error: msg });
}

const VALID_KINDS: UnifiedDocumentKind[] = [
  'invoice',
  'sales_receipt',
  'estimate',
  'credit_memo',
  'payment_receipt',
  'bill',
  'purchase_order',
  'contract',
  'exam_batch',
  'printing_job',
  'attachment',
];

export function createDocumentsRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

  // Unified All Documents list across commercial, contracts, exams, jobs, and stored files
  router.get('/documents', requirePermission('attachments:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const includeCosts = hasPermission(auth.role, 'estimates:read_costs');
      const canReadBills = hasPermission(auth.role, 'bills:read');
      const data = await db.withCompanyDb(auth.companyId, tx =>
        listCompanyDocuments(tx, auth.companyId, {
          category: req.query.category ? String(req.query.category) : undefined,
          kind: req.query.kind ? String(req.query.kind) : undefined,
          search: req.query.search ? String(req.query.search) : undefined,
          includeCosts,
          canReadBills,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          offset: req.query.offset ? Number(req.query.offset) : undefined,
        })
      );
      return res.json({ companyId: auth.companyId, ...data });
    } catch (err) {
      return handleDocumentsError(res, err);
    }
  });

  // Detailed Document Preview Payload
  router.get(
    '/documents/preview/:kind/:id',
    requirePermission('attachments:read'),
    async (req: Request, res: Response) => {
      try {
        const auth = req.auth!;
        const kind = String(req.params.kind) as UnifiedDocumentKind;
        const id = Number(req.params.id);
        if (!VALID_KINDS.includes(kind)) {
          return res.status(400).json({ error: `Unsupported document kind '${kind}'` });
        }
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(400).json({ error: 'Invalid document id' });
        }
        const includeCosts = hasPermission(auth.role, 'estimates:read_costs');
        const canReadBills = hasPermission(auth.role, 'bills:read');

        const preview = await db.withCompanyDb(auth.companyId, tx =>
          getDocumentPreviewPayload(tx, auth.companyId, kind, id, {
            includeCosts,
            canReadBills,
            attachmentsDir: db.config.attachmentsDir,
          })
        );
        return res.json({ preview });
      } catch (err) {
        return handleDocumentsError(res, err);
      }
    }
  );

  // Branded, print-friendly document view (HTML). Uses the same authoritative
  // preview payload as the JSON endpoint; no separate data path.
  router.get(
    '/documents/:kind/:id/print',
    requirePermission('attachments:read'),
    async (req: Request, res: Response) => {
      try {
        const auth = req.auth!;
        const kind = String(req.params.kind) as UnifiedDocumentKind;
        const id = Number(req.params.id);
        if (!VALID_KINDS.includes(kind)) {
          return res.status(400).json({ error: `Unsupported document kind '${kind}'` });
        }
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(400).json({ error: 'Invalid document id' });
        }
        const preview: any = await db.withCompanyDb(auth.companyId, tx =>
          getDocumentPreviewPayload(tx, auth.companyId, kind, id, {
            includeCosts: hasPermission(auth.role, 'estimates:read_costs'),
            canReadBills: hasPermission(auth.role, 'bills:read'),
            attachmentsDir: db.config.attachmentsDir,
          })
        );
        const company = preview.company || {};
        const esc = (v: unknown) =>
          String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
        const total = preview.totals?.total;
        const rows: Array<[string, unknown]> = [
          ['Document', kind.replace(/_/g, ' ')],
          ['Number', preview.documentNumber],
          ['Date', preview.documentDate],
          ['Status', preview.status],
          ['Customer', preview.counterparty?.name],
          ['Total', total != null ? `${company.currency || preview.currencyCode || ''}${total}` : undefined],
        ].filter(([, v]) => v !== undefined && v !== null && v !== '') as Array<[string, unknown]>;

        let qrSection = '';
        const wantQr = String(req.query.qr || '') === '1';
        if (wantQr && hasPermission(auth.role, 'documents:qr:manage')) {
          try {
            // Derive a stable content hash + version from the preview so the QR
            // records tamper-evidence instead of always version 1 / null hash.
            const crypto = await import('node:crypto');
            const contentHash = crypto
              .createHash('sha256')
              .update(
                JSON.stringify({
                  number: preview.documentNumber,
                  status: preview.status,
                  total: preview.totals?.total ?? null,
                  date: preview.documentDate,
                })
              )
              .digest('hex');
            const version = Array.isArray(preview.attachments) && preview.attachments.length > 0
              ? preview.attachments.length
              : 1;
            const qr = await db.withCompanyDb(auth.companyId, tx =>
              documentQrService.generateQrToken(tx, auth.companyId, kind, id, {
                version,
                contentHash,
                baseUrl: `${req.protocol}://${req.get('host') || ''}`,
              })
            );
            qrSection = `<div class="qr"><img src="${esc(qr.qrDataUrl)}" alt="QR verification code" width="140" height="140" /><div class="qr-label">Scan to verify authenticity</div></div>`;
          } catch (qrErr) {
            console.error('[documents print] QR generation failed', qrErr);
          }
        }
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(company.name || 'Document')} — ${esc(kind)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;margin:40px;color:#111;font-size:13px}
  .brand{border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:20px}
  .brand h1{margin:0;font-size:20px}
  .brand .legal{color:#555;font-size:12px}
  table{border-collapse:collapse;width:100%;margin-top:12px}
  td{padding:7px 10px;border-bottom:1px solid #e5e5e5;vertical-align:top}
  td:first-child{width:160px;color:#555}
  .meta{margin-top:18px;font-size:11px;color:#777}
  .qr{margin-top:18px;display:flex;flex-direction:column;align-items:flex-end}
  .qr-label{font-size:11px;color:#777;margin-top:4px}
  button{margin-bottom:16px;padding:8px 14px}
  @media print{button{display:none}}
</style></head><body>
<button onclick="window.print()">Print</button>
<div class="brand">
  <h1>${esc(company.name || 'Company')}</h1>
  <div class="legal">${esc(company.legalName || '')}${company.ein ? ` · ${esc(company.ein)}` : ''}</div>
  <div class="legal">${esc([company.address, company.cityStateZip].filter(Boolean).join(', '))}</div>
  <div class="legal">${esc([company.phone, company.email].filter(Boolean).join(' · '))}</div>
</div>
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${qrSection}
<div class="meta">Generated ${esc(new Date().toISOString())} · ${esc(company.name || '')}</div>
</body></html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } catch (err) {
        return handleDocumentsError(res, err);
      }
    }
  );

  // Deterministic render-model endpoint for contracts (feature-flagged, additive).
  // Returns { document, renderModel, consistency } where:
  //   - document: the generic ERPDocument envelope
  //   - renderModel: absolute-coordinate render tree
  //   - consistency: ConsistencyLock validation result
  // This does not affect the existing /documents/preview/contract/:id endpoint.
  router.get(
    '/documents/render-model/contract/:id',
    requirePermission('attachments:read'),
    async (req: Request, res: Response) => {
      try {
        const auth = req.auth!;
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(400).json({ error: 'Invalid contract id' });
        }
        const blueprintId = req.query.blueprintId ? String(req.query.blueprintId) : undefined;
        const checkConsistency =
          req.query.checkConsistency == null || String(req.query.checkConsistency).toLowerCase() !== 'false';

        const result = await db.withCompanyDb(auth.companyId, tx =>
          renderContractToRenderModel(tx, auth.companyId, id, {
            blueprintId,
            checkConsistency,
          })
        );
        return res.json(result);
      } catch (err) {
        return handleDocumentsError(res, err);
      }
    }
  );

  // Generate a real GL-posted invoice from Contracts, Examination batches, Quick Print, or custom workflow
  router.post(
    '/documents/generate-invoice',
    requirePermission('invoices:write'),
    async (req: Request, res: Response) => {
      try {
        const auth = req.auth!;
        const body = req.body || {};
        const idempotencyKey =
          (req.headers['idempotency-key'] as string | undefined) || body.idempotencyKey || null;

        const result = await db.withCompanyDb(auth.companyId, tx =>
          generateInvoiceFromWorkflow(tx, auth.companyId, toActor(req), {
            ...body,
            idempotencyKey,
          })
        );

        return res.status(result.idempotentReplay ? 200 : 201).json({
          invoice: { ...result.invoice, invoice_number: result.invoice.invoiceNumber },
          idempotentReplay: result.idempotentReplay,
          // Present when the invoice billed a quick-print desk job, so the caller
          // can show the WIP->COGS relief that was posted with it.
          quickPrintLink: result.quickPrintLink ?? null,
        });
      } catch (err) {
        return handleDocumentsError(res, err);
      }
    }
  );

  // List stored file attachments in active company
  router.get('/attachments', requirePermission('attachments:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const entityType = req.query.entityType ? String(req.query.entityType) : undefined;
      const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;
      const attachments = await db.withCompanyDb(auth.companyId, tx =>
        listAttachments(tx, auth.companyId, { entityType, entityId })
      );
      return res.json({ companyId: auth.companyId, attachments });
    } catch (err) {
      return handleDocumentsError(res, err);
    }
  });

  // Inline preview endpoint for stored files (PDF, image, text/CSV/JSON)
  router.get(
    '/attachments/:id/preview',
    requirePermission('attachments:read'),
    async (req: Request, res: Response) => {
      try {
        const auth = req.auth!;
        const attachmentId = Number(req.params.id);
        if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
          return res.status(400).json({ error: 'Invalid attachment id' });
        }

        const fileRow = await db.withCompanyDb(auth.companyId, tx =>
          getAttachmentForServing(tx, auth.companyId, attachmentId)
        );
        if (!fileRow) {
          return res.status(404).json({ error: 'Attachment not found in active company' });
        }

        const filePath = path.join(
          db.config.attachmentsDir,
          `company_${auth.companyId}`,
          path.basename(fileRow.storage_key)
        );
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'Attachment payload missing from company vault' });
        }

        res.setHeader('Content-Type', fileRow.content_type || 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader(
          'Content-Disposition',
          `inline; filename="${path.basename(fileRow.original_name)}"`
        );
        return res.send(fs.readFileSync(filePath));
      } catch (err) {
        return handleDocumentsError(res, err);
      }
    }
  );

  // Delete an uploaded attachment (audited)
  router.delete(
    '/attachments/:id',
    requirePermission('attachments:write'),
    async (req: Request, res: Response) => {
      try {
        const auth = req.auth!;
        const attachmentId = Number(req.params.id);
        if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
          return res.status(400).json({ error: 'Invalid attachment id' });
        }

        const result = await db.withCompanyDb(auth.companyId, tx =>
          deleteAttachmentRecord(
            tx,
            auth.companyId,
            toActor(req),
            attachmentId,
            db.config.attachmentsDir
          )
        );
        return res.json(result);
      } catch (err) {
        return handleDocumentsError(res, err);
      }
    }
  );

  return router;
}
