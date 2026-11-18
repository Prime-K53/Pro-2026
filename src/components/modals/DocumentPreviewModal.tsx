import React, { useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { commercialApi } from '../../services/commercialApi';
import { documentsApi } from '../../services/documentsApi';
import {
  mapApiPreviewToModel,
  mapLocalInvoiceToPreviewModel,
} from '../../types/documents';
import { formatCurrency } from '../../utils/currency';
import {
  Printer,
  Download,
  Archive,
  FileText,
  ExternalLink,
  X,
  Loader2,
  Paperclip,
  CheckCircle2,
  Clock,
  FileSpreadsheet,
  AlertTriangle,
} from 'lucide-react';

function buildPrintableHtmlDocument(doc: NonNullable<ReturnType<typeof useAccounting>['previewDocument']>): string {
  const currency = doc.company.currency || doc.currencyCode || 'K';
  const rowsHtml = doc.lines
    .map(
      l => `
      <tr>
        <td style="padding:8px;border:1px solid #cbd5e1;">${escapeHtml(l.description)}</td>
        <td style="padding:8px;border:1px solid #cbd5e1;text-align:right;font-family:monospace;">${l.quantity}</td>
        <td style="padding:8px;border:1px solid #cbd5e1;text-align:right;font-family:monospace;">${escapeHtml(formatCurrency(l.rate, currency))}</td>
        <td style="padding:8px;border:1px solid #cbd5e1;text-align:right;font-family:monospace;font-weight:bold;">${escapeHtml(formatCurrency(l.amount, currency))}</td>
      </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(doc.title)} ${escapeHtml(doc.documentNumber)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; color: #0f172a; margin: 32px; font-size: 12px; }
  .header { display: flex; justify-content: space-between; border-bottom: 2px solid #0f172a; padding-bottom: 16px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { background: #f1f5f9; padding: 8px; border: 1px solid #cbd5e1; text-align: left; font-size: 10px; text-transform: uppercase; }
  .totals { width: 280px; margin-left: auto; margin-top: 16px; font-family: monospace; }
  .totals-row { display: flex; justify-content: space-between; padding: 4px 0; }
  .grand { border-top: 2px solid #0f172a; font-weight: bold; font-size: 14px; margin-top: 6px; padding-top: 6px; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1 style="margin:0;font-size:20px;">${escapeHtml(doc.company.name)}</h1>
      <p style="margin:4px 0 0 0;color:#475569;">${escapeHtml(doc.company.address || '')} ${escapeHtml(doc.company.cityStateZip || '')}</p>
      <p style="margin:2px 0 0 0;color:#475569;">${escapeHtml(doc.company.phone || '')} ${escapeHtml(doc.company.email || '')}</p>
    </div>
    <div style="text-align:right;">
      <div style="font-size:20px;font-weight:800;color:#1e3a8a;">${escapeHtml(doc.title)}</div>
      <div style="font-family:monospace;font-weight:bold;font-size:14px;margin-top:4px;">${escapeHtml(doc.documentNumber)}</div>
      <div style="color:#475569;margin-top:4px;">Date: ${escapeHtml(doc.documentDate)}${doc.dueDate ? ` · Due: ${escapeHtml(doc.dueDate)}` : ''}</div>
      <div style="color:#475569;text-transform:uppercase;">Status: ${escapeHtml(doc.status)}</div>
    </div>
  </div>
  <div style="margin-bottom:16px;">
    <div style="font-size:10px;text-transform:uppercase;color:#64748b;font-weight:bold;">${escapeHtml(doc.counterparty.roleLabel)}</div>
    <div style="font-size:14px;font-weight:bold;margin-top:2px;">${escapeHtml(doc.counterparty.name)}</div>
    ${doc.counterparty.address ? `<div style="color:#475569;">${escapeHtml(doc.counterparty.address)}</div>` : ''}
    ${doc.counterparty.email || doc.counterparty.phone ? `<div style="color:#475569;">${escapeHtml(doc.counterparty.email || '')} ${escapeHtml(doc.counterparty.phone || '')}</div>` : ''}
  </div>
  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th style="text-align:right;width:70px;">Qty</th>
        <th style="text-align:right;width:110px;">Rate</th>
        <th style="text-align:right;width:120px;">Amount</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="totals">
    <div class="totals-row"><span>Subtotal:</span><span>${escapeHtml(formatCurrency(doc.totals.subtotal, currency))}</span></div>
    <div class="totals-row"><span>Tax:</span><span>${escapeHtml(formatCurrency(doc.totals.taxAmount, currency))}</span></div>
    <div class="totals-row grand"><span>Total:</span><span>${escapeHtml(formatCurrency(doc.totals.total, currency))}</span></div>
    ${doc.totals.amountPaid !== undefined ? `<div class="totals-row"><span>Paid / Applied:</span><span>-${escapeHtml(formatCurrency(doc.totals.amountPaid, currency))}</span></div>` : ''}
    ${doc.totals.balanceDue !== undefined ? `<div class="totals-row grand" style="color:#1d4ed8;"><span>Balance Due:</span><span>${escapeHtml(formatCurrency(doc.totals.balanceDue, currency))}</span></div>` : ''}
  </div>
  ${doc.notes ? `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e2e8f0;color:#475569;"><strong>Notes:</strong> ${escapeHtml(doc.notes)}</div>` : ''}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatStatusLabel(status: string): string {
  return String(status || 'open')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function getStatusColorClass(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'paid' || s === 'completed' || s === 'active' || s === 'posted' || s === 'stored') {
    return 'text-emerald-700 dark:text-emerald-400';
  }
  if (s === 'invoiced' || s === 'sent') {
    return 'text-blue-700 dark:text-blue-400';
  }
  if (s === 'partial' || s === 'pending' || s === 'pending_invoice' || s === 'printing' || s === 'queued') {
    return 'text-amber-700 dark:text-amber-400';
  }
  if (s === 'voided' || s === 'cancelled' || s === 'overdue' || s === 'rejected') {
    return 'text-rose-700 dark:text-rose-400';
  }
  return 'text-slate-700 dark:text-slate-300';
}

export const DocumentPreviewModal: React.FC = () => {
  const {
    previewDocument,
    openDocumentPreview,
    closeDocumentPreview,
    companyProfile,
    customers,
    getInvoiceById,
    generateAndSyncWorkflowInvoice,
    triggerShortcutNotice,
  } = useAccounting();
  const { activeCompany, hasPermission } = useAuth();

  const [busyAction, setBusyAction] = useState<'invoice' | 'archive' | 'linked' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fileObjectUrl, setFileObjectUrl] = useState<string | null>(null);
  const [fileContentType, setFileContentType] = useState<string>('');
  const [loadingFile, setLoadingFile] = useState(false);

  const canWriteInvoice = hasPermission('invoices:write');
  const canWriteAttachment = hasPermission('attachments:write');
  const canReadCosts = hasPermission('estimates:read_costs');

  useEffect(() => {
    setActionError(null);
    let activeUrl: string | null = null;
    let cancelled = false;

    if (
      previewDocument?.kind === 'attachment' &&
      previewDocument.fileMeta &&
      !previewDocument.fileMeta.textPreview
    ) {
      const ct = previewDocument.fileMeta.contentType.toLowerCase();
      if (ct === 'application/pdf' || ct.startsWith('image/')) {
        setLoadingFile(true);
        documentsApi
          .fetchAttachmentPreviewBlob(previewDocument.fileMeta.attachmentId)
          .then(({ objectUrl, contentType }) => {
            if (cancelled) {
              URL.revokeObjectURL(objectUrl);
              return;
            }
            activeUrl = objectUrl;
            setFileObjectUrl(objectUrl);
            setFileContentType(contentType);
          })
          .catch(err => {
            if (!cancelled) {
              setActionError(err?.message || 'Unable to load attachment preview');
            }
          })
          .finally(() => {
            if (!cancelled) setLoadingFile(false);
          });
      }
    } else {
      setFileObjectUrl(null);
      setFileContentType('');
    }

    return () => {
      cancelled = true;
      if (activeUrl) {
        URL.revokeObjectURL(activeUrl);
      }
    };
  }, [previewDocument?.kind, previewDocument?.id, previewDocument?.documentNumber]);

  if (!previewDocument) return null;

  const currency = previewDocument.company.currency || companyProfile.currency || 'K';
  const companyDisplayName =
    activeCompany?.name || previewDocument.company.name || companyProfile.name;

  const handleDownload = async () => {
    setActionError(null);
    try {
      if (previewDocument.kind === 'attachment' && previewDocument.fileMeta) {
        await documentsApi.downloadAttachment(
          previewDocument.fileMeta.attachmentId,
          previewDocument.fileMeta.originalName
        );
        triggerShortcutNotice(`Downloaded ${previewDocument.fileMeta.originalName}`);
        return;
      }
      const html = buildPrintableHtmlDocument(previewDocument);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${previewDocument.documentNumber.replace(/[^a-zA-Z0-9_-]/g, '_')}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      triggerShortcutNotice(`Downloaded ${previewDocument.documentNumber}`);
    } catch (err: any) {
      setActionError(err?.message || 'Download failed');
    }
  };

  const handleArchiveSnapshot = async () => {
    if (previewDocument.kind === 'attachment') return;
    setBusyAction('archive');
    setActionError(null);
    try {
      const html = buildPrintableHtmlDocument(previewDocument);
      const safeName = previewDocument.documentNumber.replace(/[^a-zA-Z0-9_-]/g, '_');
      const numericEntityId =
        typeof previewDocument.backendId === 'number' && previewDocument.backendId > 0
          ? previewDocument.backendId
          : typeof previewDocument.id === 'number' && previewDocument.id > 0
          ? previewDocument.id
          : 1;
      await documentsApi.uploadAttachment({
        fileName: `${safeName}_${previewDocument.kind}.html`,
        contentType: 'text/html',
        entityType: previewDocument.kind,
        entityId: numericEntityId,
        contentText: html,
        notes: `Archived snapshot for ${previewDocument.documentNumber} (${previewDocument.counterparty.name})`,
      });
      triggerShortcutNotice(`Archived ${previewDocument.documentNumber} to All Documents Vault`);
    } catch (err: any) {
      setActionError(err?.message || 'Failed to archive snapshot');
    } finally {
      setBusyAction(null);
    }
  };

  const handleGenerateInvoice = async () => {
    setBusyAction('invoice');
    setActionError(null);
    try {
      if (previewDocument.kind === 'estimate' && typeof previewDocument.id === 'number') {
        const res = await commercialApi.convertEstimate(previewDocument.id);
        triggerShortcutNotice(
          `Converted ${previewDocument.documentNumber} → Invoice ${res.invoice?.invoiceNumber}`
        );
        if (res.invoice?.id) {
          const invPreview = await documentsApi.getDocumentPreview('invoice', res.invoice.id);
          openDocumentPreview(mapApiPreviewToModel(invPreview, currency));
        }
        return;
      }

      if (previewDocument.generateInvoiceInput) {
        const localCustId =
          typeof previewDocument.counterparty.id === 'string'
            ? previewDocument.counterparty.id
            : undefined;
        const { apiInvoice, localInvoice } = await generateAndSyncWorkflowInvoice(
          previewDocument.generateInvoiceInput,
          { localCustomerId: localCustId }
        );
        previewDocument.onInvoiceGenerated?.({ apiInvoice, localInvoice });
        triggerShortcutNotice(
          `Generated Invoice ${apiInvoice.invoiceNumber} & posted to General Ledger`
        );
        try {
          const invPreview = await documentsApi.getDocumentPreview('invoice', apiInvoice.id);
          openDocumentPreview(mapApiPreviewToModel(invPreview, currency));
        } catch {
          const cust = customers.find(c => c.id === localInvoice.customerId);
          openDocumentPreview(
            mapLocalInvoiceToPreviewModel({
              invoice: localInvoice,
              customer: cust,
              companyProfile,
              companyNameOverride: companyDisplayName,
            })
          );
        }
      }
    } catch (err: any) {
      setActionError(err?.message || 'Invoice generation failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenLinkedInvoice = async () => {
    const ref = previewDocument.linkedInvoiceRef;
    if (!ref) return;
    setBusyAction('linked');
    setActionError(null);
    try {
      if (ref.backendInvoiceId) {
        const invPreview = await documentsApi.getDocumentPreview('invoice', ref.backendInvoiceId);
        openDocumentPreview(mapApiPreviewToModel(invPreview, currency));
        return;
      }
      if (ref.localInvoiceId) {
        const local = getInvoiceById(ref.localInvoiceId);
        if (local) {
          const cust = customers.find(c => c.id === local.customerId);
          openDocumentPreview(
            mapLocalInvoiceToPreviewModel({
              invoice: local,
              customer: cust,
              companyProfile,
              companyNameOverride: companyDisplayName,
            })
          );
          return;
        }
      }
      setActionError('Linked invoice record could not be resolved');
    } catch (err: any) {
      setActionError(err?.message || 'Failed to load linked invoice');
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenAttachmentPreview = async (attachmentId: number) => {
    setBusyAction('linked');
    setActionError(null);
    try {
      const attPreview = await documentsApi.getDocumentPreview('attachment', attachmentId);
      openDocumentPreview(mapApiPreviewToModel(attPreview, currency));
    } catch (err: any) {
      setActionError(err?.message || 'Unable to load attachment');
    } finally {
      setBusyAction(null);
    }
  };

  const showCostStrip =
    canReadCosts &&
    previewDocument.kind !== 'attachment' &&
    previewDocument.totals.totalCost !== undefined;

  const grossProfit =
    previewDocument.totals.grossProfit ??
    Math.round(
      (previewDocument.totals.subtotal - (previewDocument.totals.totalCost || 0)) * 100
    ) / 100;
  const marginPct =
    previewDocument.totals.subtotal > 0
      ? (grossProfit / previewDocument.totals.subtotal) * 100
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 document-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${previewDocument.title} ${previewDocument.documentNumber}`}
    >
      <div className="w-full max-w-4xl bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh] animate-modal-enter document-preview-shell">
        {/* Top Action Bar (Hidden when printing) */}
        <div className="px-5 py-3 bg-[#0f3d63] dark:bg-slate-950 text-white flex flex-wrap items-center justify-between gap-3 no-print border-b border-slate-700/50">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText className="w-4 h-4 text-amber-400 shrink-0" />
            <div className="truncate">
              <span className="font-bold text-sm">{previewDocument.title}</span>
              <span className="mx-2 text-white/40">·</span>
              <span className="font-mono text-sm font-semibold text-amber-300">
                {previewDocument.documentNumber}
              </span>
              <span className="mx-2 text-white/40">·</span>
              <span className="text-xs text-slate-200 uppercase font-semibold">
                {formatStatusLabel(previewDocument.status)}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {previewDocument.linkedInvoiceRef && (
              <button
                type="button"
                onClick={handleOpenLinkedInvoice}
                disabled={busyAction !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs border border-slate-600 transition-colors"
              >
                {busyAction === 'linked' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="w-3.5 h-3.5 text-blue-300" />
                )}
                <span>
                  Preview Invoice
                  {previewDocument.linkedInvoiceRef.invoiceNumber
                    ? ` (${previewDocument.linkedInvoiceRef.invoiceNumber})`
                    : ''}
                </span>
              </button>
            )}

            {previewDocument.canGenerateInvoice &&
              canWriteInvoice &&
              (previewDocument.generateInvoiceInput || previewDocument.kind === 'estimate') && (
                <button
                  type="button"
                  onClick={handleGenerateInvoice}
                  disabled={busyAction !== null}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition-colors"
                >
                  {busyAction === 'invoice' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                  )}
                  <span>Generate Invoice</span>
                </button>
              )}

            {previewDocument.kind !== 'attachment' && canWriteAttachment && (
              <button
                type="button"
                onClick={handleArchiveSnapshot}
                disabled={busyAction !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white font-semibold text-xs transition-colors"
                title="Save an immutable HTML copy into All Documents Vault"
              >
                {busyAction === 'archive' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Archive className="w-3.5 h-3.5" />
                )}
                <span>Archive to Documents</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white font-semibold text-xs transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>

            <button
              type="button"
              onClick={() => window.print()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print / PDF</span>
            </button>

            <button
              type="button"
              onClick={closeDocumentPreview}
              aria-label="Close document preview"
              className="p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Action Error Banner */}
        {actionError && (
          <div className="px-5 py-2.5 bg-rose-50 dark:bg-rose-950/50 border-b border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs flex items-center justify-between no-print">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{actionError}</span>
            </span>
            <button onClick={() => setActionError(null)} className="underline font-semibold">
              Dismiss
            </button>
          </div>
        )}

        {/* Internal Profitability Strip (Hidden on print & redacted when user lacks cost permission) */}
        {showCostStrip && (
          <div className="px-8 py-2.5 bg-slate-100 dark:bg-slate-850 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs font-mono no-print">
            <span className="font-sans font-semibold text-slate-600 dark:text-slate-300">
              Internal Profitability Check
            </span>
            <div className="flex flex-wrap items-center gap-6 tabular-nums">
              <span>
                Production Cost:{' '}
                <strong className="text-slate-900 dark:text-white">
                  {formatCurrency(previewDocument.totals.totalCost || 0, currency)}
                </strong>
              </span>
              <span>
                Revenue / Subtotal:{' '}
                <strong className="text-slate-900 dark:text-white">
                  {formatCurrency(previewDocument.totals.subtotal, currency)}
                </strong>
              </span>
              <span
                className={
                  grossProfit >= 0
                    ? 'text-emerald-700 dark:text-emerald-400 font-bold'
                    : 'text-rose-700 dark:text-rose-400 font-bold'
                }
              >
                Gross Profit: {formatCurrency(grossProfit, currency)} ({marginPct.toFixed(1)}%)
              </span>
            </div>
          </div>
        )}

        {/* Printable Document Sheet */}
        <div className="p-8 space-y-6 overflow-y-auto text-xs bg-white text-slate-900 document-print-sheet">
          {/* Letterhead */}
          <div className="flex flex-wrap justify-between items-start gap-4 border-b-2 border-slate-900 pb-5">
            <div>
              <h2 className="text-xl font-black text-slate-900 uppercase tracking-tight">
                {companyDisplayName}
              </h2>
              {(previewDocument.company.address || previewDocument.company.cityStateZip) && (
                <div className="text-slate-600 mt-1">
                  {previewDocument.company.address}
                  {previewDocument.company.address && previewDocument.company.cityStateZip ? ' · ' : ''}
                  {previewDocument.company.cityStateZip}
                </div>
              )}
              {(previewDocument.company.phone || previewDocument.company.email) && (
                <div className="text-slate-500 mt-0.5">
                  {previewDocument.company.phone}
                  {previewDocument.company.phone && previewDocument.company.email ? ' · ' : ''}
                  {previewDocument.company.email}
                </div>
              )}
              {previewDocument.company.ein && (
                <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                  Tax ID / TPIN: {previewDocument.company.ein}
                </div>
              )}
            </div>

            <div className="text-right">
              <div className="text-2xl font-black text-[#0f3d63] tracking-tight">
                {previewDocument.title}
              </div>
              <div className="font-mono text-sm font-bold text-slate-900 mt-1">
                {previewDocument.documentNumber}
              </div>
              <div className="text-slate-600 mt-1 font-mono">
                Date: {previewDocument.documentDate}
                {previewDocument.dueDate ? ` · Due: ${previewDocument.dueDate}` : ''}
              </div>
              <div className="mt-1 flex items-center justify-end gap-2 font-sans">
                <span className={`font-bold text-[11px] uppercase ${getStatusColorClass(previewDocument.status)}`}>
                  {formatStatusLabel(previewDocument.status)}
                </span>
                {previewDocument.journalEntryNumber && (
                  <>
                    <span className="text-slate-300">·</span>
                    <span className="font-mono text-[11px] text-slate-500">
                      GL: {previewDocument.journalEntryNumber}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Counterparty & Terms Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {previewDocument.counterparty.roleLabel}
              </div>
              <div className="font-bold text-sm text-slate-900 mt-0.5">
                {previewDocument.counterparty.name}
              </div>
              {previewDocument.counterparty.address && (
                <div className="text-slate-600 mt-0.5">{previewDocument.counterparty.address}</div>
              )}
              {(previewDocument.counterparty.email || previewDocument.counterparty.phone) && (
                <div className="text-slate-500 mt-0.5">
                  {previewDocument.counterparty.email}
                  {previewDocument.counterparty.email && previewDocument.counterparty.phone
                    ? ' · '
                    : ''}
                  {previewDocument.counterparty.phone}
                </div>
              )}
            </div>

            <div className="sm:text-right space-y-1">
              {previewDocument.terms && (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-2">
                    Terms:
                  </span>
                  <span className="font-semibold text-slate-800">{previewDocument.terms}</span>
                </div>
              )}
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-2">
                  Currency:
                </span>
                <span className="font-mono font-semibold text-slate-800">
                  {previewDocument.currencyCode}
                </span>
              </div>
            </div>
          </div>

          {/* Attachment / Stored File Viewer */}
          {previewDocument.kind === 'attachment' && previewDocument.fileMeta && (
            <div className="space-y-4">
              <div className="p-3 border border-slate-200 rounded-lg bg-slate-50 flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono text-slate-600">
                <span>File: <strong className="text-slate-900 font-sans">{previewDocument.fileMeta.originalName}</strong></span>
                <span>Type: {previewDocument.fileMeta.contentType}</span>
                <span>Size: {(previewDocument.fileMeta.sizeBytes / 1024).toFixed(1)} KB</span>
                <span>SHA-256: {previewDocument.fileMeta.sha256Hex.slice(0, 16)}…</span>
              </div>

              {loadingFile ? (
                <div className="py-16 flex items-center justify-center gap-2 text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Loading file preview from company vault...</span>
                </div>
              ) : previewDocument.fileMeta.textPreview !== null &&
                previewDocument.fileMeta.textPreview !== undefined ? (
                previewDocument.fileMeta.contentType === 'text/html' ? (
                  <iframe
                    title={previewDocument.fileMeta.originalName}
                    srcDoc={previewDocument.fileMeta.textPreview}
                    sandbox=""
                    className="w-full h-[520px] border border-slate-200 rounded-lg bg-white"
                  />
                ) : (
                  <pre className="p-4 border border-slate-200 rounded-lg bg-slate-50 text-slate-800 font-mono text-[11px] overflow-x-auto max-h-[500px] whitespace-pre-wrap">
                    {previewDocument.fileMeta.textPreview}
                  </pre>
                )
              ) : fileObjectUrl && fileContentType === 'application/pdf' ? (
                <iframe
                  title={previewDocument.fileMeta.originalName}
                  src={fileObjectUrl}
                  className="w-full h-[540px] border border-slate-200 rounded-lg"
                />
              ) : fileObjectUrl && fileContentType.startsWith('image/') ? (
                <div className="p-4 border border-slate-200 rounded-lg bg-slate-50 flex justify-center">
                  <img
                    src={fileObjectUrl}
                    alt={previewDocument.fileMeta.originalName}
                    className="max-h-[520px] object-contain rounded"
                  />
                </div>
              ) : (
                <div className="p-8 border border-slate-200 rounded-lg bg-slate-50 text-center space-y-2">
                  <div className="font-bold text-sm text-slate-900">
                    Binary File Stored in Company Vault
                  </div>
                  <p className="text-slate-500">
                    Inline browser rendering is unavailable for {previewDocument.fileMeta.contentType}. Use Download above to open locally.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Contract Retainer & Assessment Schedule */}
          {previewDocument.contractMeta && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 border border-slate-200 rounded-lg bg-slate-50 font-mono">
                <div>
                  <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                    Academic Year
                  </div>
                  <div className="font-bold text-slate-900 mt-0.5">
                    {previewDocument.contractMeta.academicYear}
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                    Assessments Done
                  </div>
                  <div className="font-bold text-slate-900 mt-0.5 tabular-nums">
                    {previewDocument.contractMeta.completedAssessments} /{' '}
                    {previewDocument.contractMeta.totalAssessments}
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                    Prepaid Total
                  </div>
                  <div className="font-bold text-slate-900 mt-0.5 tabular-nums">
                    {formatCurrency(previewDocument.contractMeta.totalPrepaidAmount, currency)}
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                    Remaining Retainer
                  </div>
                  <div className="font-bold text-blue-700 mt-0.5 tabular-nums">
                    {formatCurrency(previewDocument.contractMeta.remainingBalance, currency)}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">
                  Assessment Drawdown & Production Schedule
                </div>
                <table className="w-full text-left border-collapse border border-slate-200">
                  <thead className="bg-slate-100 font-bold text-[10px] text-slate-600 uppercase border-b border-slate-200">
                    <tr>
                      <th className="p-2 border-r border-slate-200 w-10">#</th>
                      <th className="p-2 border-r border-slate-200">ASSESSMENT MILESTONE</th>
                      <th className="p-2 border-r border-slate-200 w-28">DATE</th>
                      <th className="p-2 border-r border-slate-200 text-right">VOLUME</th>
                      <th className="p-2 border-r border-slate-200 text-right">AMOUNT</th>
                      <th className="p-2 border-r border-slate-200 text-center">STATUS</th>
                      <th className="p-2 text-right">INVOICE</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-mono">
                    {previewDocument.contractMeta.assessments.map(a => (
                      <tr key={a.assessmentNumber}>
                        <td className="p-2 border-r border-slate-200 font-bold">
                          #{a.assessmentNumber}
                        </td>
                        <td className="p-2 border-r border-slate-200 font-sans font-medium">
                          {a.label}
                        </td>
                        <td className="p-2 border-r border-slate-200">{a.scheduledDate}</td>
                        <td className="p-2 border-r border-slate-200 text-right text-[11px] text-slate-600">
                          {a.estimatedSheets.toLocaleString()} shts /{' '}
                          {a.estimatedImpressions.toLocaleString()} imp
                        </td>
                        <td className="p-2 border-r border-slate-200 text-right font-bold tabular-nums">
                          {formatCurrency(a.agreedAmount, currency)}
                        </td>
                        <td className="p-2 border-r border-slate-200 text-center font-sans">
                          {a.status === 'completed' ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                              <CheckCircle2 className="w-3 h-3" /> Deducted
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-amber-700 font-semibold">
                              <Clock className="w-3 h-3" /> Pending
                            </span>
                          )}
                        </td>
                        <td className="p-2 text-right font-mono text-[11px] text-blue-700">
                          {a.linkedInvoiceNumber || (a.linkedInvoiceId ? `#${a.linkedInvoiceId}` : '—')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Examination Production Sheet Breakdown */}
          {previewDocument.examMeta && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 border border-slate-200 rounded-lg bg-slate-50 font-mono">
                <div>
                  <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                    Assessment
                  </div>
                  <div className="font-sans font-bold text-slate-900 mt-0.5">
                    {previewDocument.examMeta.assessmentName}
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                    Classes Covered
                  </div>
                  <div className="font-sans font-bold text-slate-900 mt-0.5">
                    {previewDocument.examMeta.className}
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                    Total Learners
                  </div>
                  <div className="font-bold text-slate-900 mt-0.5 tabular-nums">
                    {previewDocument.examMeta.learnersCount.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                    Subject Papers
                  </div>
                  <div className="font-bold text-slate-900 mt-0.5 tabular-nums">
                    {previewDocument.examMeta.papers.length}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">
                  Subject Press Production Schedule
                </div>
                <table className="w-full text-left border-collapse border border-slate-200">
                  <thead className="bg-slate-100 font-bold text-[10px] text-slate-600 uppercase border-b border-slate-200">
                    <tr>
                      <th className="p-2 border-r border-slate-200">JOB #</th>
                      <th className="p-2 border-r border-slate-200">CLASS & SUBJECT PAPER</th>
                      <th className="p-2 border-r border-slate-200 text-right">PP × COPIES</th>
                      <th className="p-2 border-r border-slate-200">FINISHING</th>
                      <th className="p-2 border-r border-slate-200 text-right">SHEETS / IMP</th>
                      <th className="p-2 text-center">STATUS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-mono">
                    {previewDocument.examMeta.papers.map((p, idx) => (
                      <tr key={`${p.jobNumber}-${idx}`}>
                        <td className="p-2 border-r border-slate-200 font-bold">{p.jobNumber}</td>
                        <td className="p-2 border-r border-slate-200 font-sans font-medium">
                          {p.subjectName}
                        </td>
                        <td className="p-2 border-r border-slate-200 text-right tabular-nums">
                          {p.pages} × {p.copies}
                        </td>
                        <td className="p-2 border-r border-slate-200 font-sans text-slate-600">
                          {p.printSide} · {p.bindingType}
                        </td>
                        <td className="p-2 border-r border-slate-200 text-right tabular-nums text-slate-600">
                          {p.sheetsUsed.toLocaleString()} / {p.impressionsUsed.toLocaleString()}
                        </td>
                        <td className="p-2 text-center font-sans font-semibold uppercase text-[10px]">
                          {p.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Quick Print Production Metadata */}
          {previewDocument.quickPrintMeta && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 border border-slate-200 rounded-lg bg-slate-50 font-mono">
              <div>
                <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                  Pages × Copies
                </div>
                <div className="font-bold text-slate-900 mt-0.5 tabular-nums">
                  {previewDocument.quickPrintMeta.pages} pp × {previewDocument.quickPrintMeta.copies}
                </div>
              </div>
              <div>
                <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                  Duplex / Mode
                </div>
                <div className="font-sans font-bold text-slate-900 mt-0.5">
                  {previewDocument.quickPrintMeta.printSide}
                </div>
              </div>
              <div>
                <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                  Sheets Consumed
                </div>
                <div className="font-bold text-slate-900 mt-0.5 tabular-nums">
                  {previewDocument.quickPrintMeta.sheetsUsed.toLocaleString()}
                </div>
              </div>
              <div>
                <div className="font-sans text-[10px] font-bold uppercase text-slate-500">
                  Impressions
                </div>
                <div className="font-bold text-slate-900 mt-0.5 tabular-nums">
                  {previewDocument.quickPrintMeta.impressionsUsed.toLocaleString()}
                </div>
              </div>
            </div>
          )}

          {/* Line Items & Commercial Totals (Shown for commercial, exam billing, and print jobs) */}
          {previewDocument.kind !== 'attachment' && previewDocument.lines.length > 0 && !previewDocument.contractMeta && (
            <table className="w-full text-left border-collapse border border-slate-200">
              <thead className="bg-slate-100 font-bold text-[10px] text-slate-600 uppercase border-b border-slate-200">
                <tr>
                  <th className="p-2.5 border-r border-slate-200">DESCRIPTION</th>
                  <th className="p-2.5 w-20 text-right border-r border-slate-200">QTY</th>
                  <th className="p-2.5 w-28 text-right border-r border-slate-200">RATE</th>
                  <th className="p-2.5 w-28 text-right">AMOUNT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 font-mono">
                {previewDocument.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="p-2.5 font-sans border-r border-slate-200">{l.description}</td>
                    <td className="p-2.5 text-right border-r border-slate-200 tabular-nums">
                      {l.quantity}
                    </td>
                    <td className="p-2.5 text-right border-r border-slate-200 tabular-nums">
                      {formatCurrency(l.rate, currency)}
                    </td>
                    <td className="p-2.5 text-right font-bold tabular-nums">
                      {formatCurrency(l.amount, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Totals Block */}
          {previewDocument.kind !== 'attachment' && (
            <div className="flex justify-end pt-2">
              <div className="w-72 space-y-1.5 font-mono text-xs">
                <div className="flex justify-between">
                  <span className="font-sans text-slate-600">Subtotal:</span>
                  <span className="tabular-nums">
                    {formatCurrency(previewDocument.totals.subtotal, currency)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-sans text-slate-600">
                    Sales Tax
                    {previewDocument.totals.taxRate
                      ? ` (${(previewDocument.totals.taxRate > 1
                          ? previewDocument.totals.taxRate
                          : previewDocument.totals.taxRate * 100
                        ).toFixed(1)}%)`
                      : ''}
                    :
                  </span>
                  <span className="tabular-nums">
                    {formatCurrency(previewDocument.totals.taxAmount, currency)}
                  </span>
                </div>
                <div className="flex justify-between font-bold text-sm border-t border-slate-300 pt-1.5">
                  <span className="font-sans">Total:</span>
                  <span className="tabular-nums">
                    {formatCurrency(previewDocument.totals.total, currency)}
                  </span>
                </div>
                {previewDocument.totals.amountPaid !== undefined && (
                  <div className="flex justify-between text-emerald-700">
                    <span className="font-sans">
                      {previewDocument.kind === 'contract' ? 'Recognized / Deducted:' : 'Paid / Applied:'}
                    </span>
                    <span className="tabular-nums">
                      -{formatCurrency(previewDocument.totals.amountPaid, currency)}
                    </span>
                  </div>
                )}
                {previewDocument.totals.balanceDue !== undefined && (
                  <div className="flex justify-between font-black text-base text-[#0f3d63] border-t-2 border-slate-900 pt-1.5">
                    <span className="font-sans">
                      {previewDocument.kind === 'contract' ? 'Remaining Retainer:' : 'Balance Due:'}
                    </span>
                    <span className="tabular-nums">
                      {formatCurrency(previewDocument.totals.balanceDue, currency)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Notes */}
          {previewDocument.notes && (
            <div className="pt-4 border-t border-slate-200 text-slate-600">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                Notes & Terms
              </div>
              <p>{previewDocument.notes}</p>
            </div>
          )}

          {/* Linked Attachments Strip (hidden when printing) */}
          {previewDocument.attachments && previewDocument.attachments.length > 0 && (
            <div className="pt-4 border-t border-slate-200 no-print">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
                <Paperclip className="w-3.5 h-3.5" />
                <span>Attached Supporting Files ({previewDocument.attachments.length})</span>
              </div>
              <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden">
                {previewDocument.attachments.map(att => (
                  <div
                    key={att.attachmentId}
                    className="px-3 py-2 flex items-center justify-between gap-3 bg-slate-50 text-xs"
                  >
                    <div className="truncate font-medium text-slate-800">
                      {att.originalName}{' '}
                      <span className="font-mono text-[10px] text-slate-500 ml-1">
                        ({(att.sizeBytes / 1024).toFixed(1)} KB)
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleOpenAttachmentPreview(att.attachmentId)}
                        className="text-blue-700 hover:underline font-semibold"
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          documentsApi.downloadAttachment(att.attachmentId, att.originalName)
                        }
                        className="text-slate-600 hover:underline font-semibold"
                      >
                        Download
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
