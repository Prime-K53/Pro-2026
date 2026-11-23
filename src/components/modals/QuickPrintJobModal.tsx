import React, { useEffect, useMemo, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { computeQuickPrintEstimate, type QuickPrintEstimate } from '../../utils/quickPrintCalc';
import type { QuickPrintJobType } from '../../types/accounting';
import { ModalShell } from '../common/ui';
import { AlertTriangle, Copy, FileText, Plus, Printer, X } from 'lucide-react';

export interface QuickPrintJobDraft {
  jobType: QuickPrintJobType;
  title: string;
  pages: number;
  copies: number;
  printSide: 'Single-Sided' | 'Duplex';
  rawPaperItemId: string;
  rawTonerItemId: string;
  extraCostPerPage: number;
  sellingPricePerSheet: number;
  date: string;
  notes?: string;
  estimate: QuickPrintEstimate;
}

const JOB_TYPE_LABELS: Record<QuickPrintJobType, string> = {
  quick_photocopy: 'Quick Photocopy',
  type_and_printing: 'Type & Print',
  general_print: 'General Print',
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Quick Photocopy / Quick Print capture for an invoice or POS ticket.
 *
 * It only drafts the job. The parent owns the customer and the invoice/order, and
 * posts the job through the server production path when the document is saved, so
 * one screen can carry several desk jobs plus ordinary stock lines on a single
 * document.
 */
export const QuickPrintJobModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onAdd: (draft: QuickPrintJobDraft) => void;
  /** Shown in the header so the operator knows which document this lands on. */
  targetLabel: string;
}> = ({ open, onClose, onAdd, targetLabel }) => {
  const { companyProfile, inventoryItems, getRawUsageUnitCost } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const fmt = (n: number) => formatCurrency(Number.isFinite(n) ? n : 0, currency);

  const rawMaterials = useMemo(
    () => inventoryItems.filter(i => i.type === 'raw_material'),
    [inventoryItems]
  );

  const defaultPaper =
    rawMaterials.find(r => (r.usageUnit || '').toLowerCase().includes('sheet')) || rawMaterials[0];
  const defaultToner =
    rawMaterials.find(r => (r.usageUnit || '').toLowerCase().includes('impression')) ||
    rawMaterials[1] ||
    rawMaterials[0];

  const defaultExtra = Number(companyProfile.extraTypingFinishingPerPage ?? 0);
  const defaultSheetPrice = Number(companyProfile.manualSellingPricePerSheet ?? 0);

  const [jobType, setJobType] = useState<QuickPrintJobType>('quick_photocopy');
  const [title, setTitle] = useState('A4 Document Photocopy Run');
  const [pages, setPages] = useState(10);
  const [copies, setCopies] = useState(25);
  const [printSide, setPrintSide] = useState<'Single-Sided' | 'Duplex'>('Duplex');
  const [rawPaperItemId, setRawPaperItemId] = useState(defaultPaper?.id || '');
  const [rawTonerItemId, setRawTonerItemId] = useState(defaultToner?.id || '');
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');

  // Reset to a clean job every time the modal opens. Pricing always comes from
  // the company's print desk defaults, so a previous job can never leak its rate.
  useEffect(() => {
    if (!open) return;
    setJobType('quick_photocopy');
    setTitle('A4 Document Photocopy Run');
    setPages(10);
    setCopies(25);
    setPrintSide('Duplex');
    setRawPaperItemId(defaultPaper?.id || '');
    setRawTonerItemId(defaultToner?.id || '');
    setDate(today());
    setNotes('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const paperItem = rawMaterials.find(r => r.id === rawPaperItemId);
  const tonerItem = rawMaterials.find(r => r.id === rawTonerItemId);

  const estimate = useMemo(
    () =>
      computeQuickPrintEstimate({
        paperItem,
        tonerItem,
        paperUsageUnitCost: getRawUsageUnitCost(rawPaperItemId),
        tonerUsageUnitCost: getRawUsageUnitCost(rawTonerItemId),
        jobType,
        pages,
        copies,
        printSide,
        extraCostPerPage: defaultExtra,
        sellingPricePerSheet: defaultSheetPrice,
      }),
    [
      paperItem,
      tonerItem,
      rawPaperItemId,
      rawTonerItemId,
      jobType,
      pages,
      copies,
      printSide,
      defaultExtra,
      defaultSheetPrice,
      getRawUsageUnitCost,
    ]
  );

  const canAdd =
    Boolean(title.trim()) &&
    Boolean(rawPaperItemId) &&
    Boolean(rawTonerItemId) &&
    estimate.sellingPriceTotal > 0;

  const applyTypePreset = (next: QuickPrintJobType) => {
    setJobType(next);
    if (next === 'quick_photocopy') {
      setTitle('A4 Document Photocopy Run');
    } else if (next === 'type_and_printing') {
      setTitle('Document Typing, Formatting & Printout');
    } else {
      setTitle('Custom Press Print Job');
    }
  };

  const handleAdd = () => {
    if (!canAdd) return;
    onAdd({
      jobType,
      title: title.trim(),
      pages: Math.max(1, pages),
      copies: Math.max(1, copies),
      printSide,
      rawPaperItemId,
      rawTonerItemId,
      extraCostPerPage: estimate.safeExtraPerPage,
      sellingPricePerSheet: estimate.safePricePerSheet,
      date,
      notes: notes.trim() || undefined,
      estimate,
    });
    onClose();
  };

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      size="3xl"
      titleId="quick-print-line-title"
      className="!max-w-[860px]"
    >
      <div className="flex shrink-0 items-center gap-3 bg-gradient-to-r from-brand-800 via-brand-600 to-brand-500 px-5 py-3 text-white">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/15 text-lg ring-1 ring-white/20 ring-inset">
          <Copy className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div id="quick-print-line-title" className="text-[14.5px] leading-tight font-semibold">
            Quick Photocopy / Quick Print
          </div>
          <div className="truncate text-[11.5px] text-white/80">Adds a print job to {targetLabel}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {rawMaterials.length === 0 ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-[12.5px] text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              No raw materials found. Add paper and toner raw materials before recording a copy or print job —
              material cost is driven from their unit conversions.
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_272px]">
            <div className="space-y-3">
              <div>
                <label className="app-label">Job type</label>
                <div className="flex flex-wrap gap-1.5">
                  {(['quick_photocopy', 'type_and_printing', 'general_print'] as QuickPrintJobType[]).map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => applyTypePreset(t)}
                      className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                        jobType === t
                          ? 'bg-brand-600 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/[0.06] dark:text-slate-300'
                      }`}
                    >
                      {JOB_TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_130px]">
                <div>
                  <label className="app-label">Description</label>
                  <input
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="e.g. Staff ID copies"
                    className="app-input"
                    required
                  />
                </div>
                <div>
                  <label className="app-label">Job date</label>
                  <input
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    className="app-input"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="app-label">Pages</label>
                  <input
                    type="number"
                    min={1}
                    value={pages}
                    onChange={e => setPages(Math.max(1, Number(e.target.value) || 1))}
                    className="app-input app-input-mono text-right"
                  />
                </div>
                <div>
                  <label className="app-label">Copies</label>
                  <input
                    type="number"
                    min={1}
                    value={copies}
                    onChange={e => setCopies(Math.max(1, Number(e.target.value) || 1))}
                    className="app-input app-input-mono text-right"
                  />
                </div>
              </div>

              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Priced at{' '}
                <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                  {fmt(defaultSheetPrice)}
                </span>{' '}
                per sheet
                {jobType === 'type_and_printing' && (
                  <>
                    {' '}
                    plus{' '}
                    <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                      {fmt(defaultExtra)}
                    </span>{' '}
                    per typed page
                  </>
                )}
                . Change these in Settings → Print Desk Pricing Defaults.
              </p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="app-label">Print side</label>
                  <select
                    value={printSide}
                    onChange={e => setPrintSide(e.target.value as 'Single-Sided' | 'Duplex')}
                    className="app-input"
                  >
                    <option value="Duplex">Duplex (2 pp / sheet)</option>
                    <option value="Single-Sided">Single-sided (1 pp / sheet)</option>
                  </select>
                </div>
                <div>
                  <label className="app-label">Paper raw material</label>
                  <select
                    value={rawPaperItemId}
                    onChange={e => setRawPaperItemId(e.target.value)}
                    className="app-input"
                  >
                    {rawMaterials.map(rm => (
                      <option key={rm.id} value={rm.id}>
                        {rm.sku} · {rm.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="app-label">Toner raw material</label>
                  <select
                    value={rawTonerItemId}
                    onChange={e => setRawTonerItemId(e.target.value)}
                    className="app-input"
                  >
                    {rawMaterials.map(rm => (
                      <option key={rm.id} value={rm.id}>
                        {rm.sku} · {rm.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="app-label">Job notes</label>
                <input
                  type="text"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Finishing instructions, PO number…"
                  className="app-input"
                />
              </div>
            </div>

            <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-[12px] dark:border-white/10 dark:bg-white/[0.03]">
              <div className="border-b border-slate-200 pb-2 text-[10.5px] font-bold tracking-wider text-slate-500 uppercase dark:border-white/[0.08]">
                Material &amp; price preview
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">
                  Sheets ({estimate.sheetsUsed.toLocaleString()})
                </span>
                <span className="font-mono text-slate-700 dark:text-slate-200">
                  {estimate.impressionsUsed.toLocaleString()} imp
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Paper</span>
                <span className="font-mono text-slate-700 dark:text-slate-200">
                  {fmt(estimate.paperCost)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">Toner</span>
                <span className="font-mono text-slate-700 dark:text-slate-200">
                  {fmt(estimate.tonerCost)}
                </span>
              </div>
              {estimate.finishingCost > 0 && (
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500 dark:text-slate-400">
                    Physical finishing ({estimate.safePages} pp)
                  </span>
                  <span className="font-mono text-slate-700 dark:text-slate-200">
                    {fmt(estimate.finishingCost)}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-2 border-t border-slate-200 pt-2 font-semibold dark:border-white/[0.08]">
                <span className="text-slate-600 dark:text-slate-300">Material cost</span>
                <span className="font-mono text-slate-900 dark:text-white">{fmt(estimate.totalCost)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">
                  Photocopying ({estimate.sheetsUsed.toLocaleString()} sheets)
                </span>
                <span className="font-mono text-slate-700 dark:text-slate-200">
                  {fmt(estimate.photocopyRevenue)}
                </span>
              </div>
              {estimate.typingRevenue > 0 && (
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500 dark:text-slate-400">
                    Typing &amp; Printing ({estimate.safePages} pp)
                  </span>
                  <span className="font-mono text-slate-700 dark:text-slate-200">
                    {fmt(estimate.typingRevenue)}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-2 font-semibold">
                <span className="text-slate-600 dark:text-slate-300">Total revenue</span>
                <span className="font-mono text-brand-600 dark:text-brand-400">
                  {fmt(estimate.sellingPriceTotal)}
                </span>
              </div>
              <div className="flex justify-between gap-2 text-[11.5px]">
                <span className="text-slate-500 dark:text-slate-400">Margin</span>
                <span
                  className={`font-mono font-semibold ${
                    estimate.realProfit >= 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {fmt(estimate.realProfit)} ({estimate.profitMarginPct.toFixed(1)}%)
                </span>
              </div>
              {defaultSheetPrice <= 0 && (
                <p className="flex items-start gap-1.5 pt-1 text-[10.5px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  No selling price configured — set Manual Selling Price / Sheet in Settings.
                </p>
              )}
              {estimate.isEstimated && (
                <p className="flex items-start gap-1.5 pt-1 text-[10.5px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  Toner cost is estimated — this material has no rated yield yet.
                </p>
              )}
              <p className="flex items-start gap-1.5 pt-1 text-[10.5px] text-slate-500 dark:text-slate-400">
                <FileText className="mt-0.5 h-3 w-3 shrink-0" />
                Stock leaves inventory and cost enters WIP when the document is saved.
              </p>
            </div>
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-slate-200 bg-white px-5 py-3 dark:border-white/[0.06] dark:bg-slate-900">
        <span className="mr-auto truncate text-[11.5px] text-slate-500 dark:text-slate-400">
          {fmt(estimate.sellingPriceTotal)} · {estimate.sheetsUsed.toLocaleString()} sheets
        </span>
        <button type="button" onClick={onClose} className="btn btn-secondary">
          Cancel
        </button>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!canAdd}
          className="btn btn-primary"
          title={
            canAdd
              ? undefined
              : defaultSheetPrice > 0
                ? 'Fill in the job description, paper and toner materials'
                : 'Set the Manual Selling Price / Sheet in Settings first'
          }
        >
          {jobType === 'quick_photocopy' ? <Printer className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          Add to {targetLabel}
        </button>
      </footer>
    </ModalShell>
  );
};
