import React, { useState, useMemo, useRef } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { QuickPrintJob, QuickPrintJobType } from '../../types/accounting';
import { documentsApi } from '../../services/documentsApi';
import {
  mapApiPreviewToModel,
  mapLocalInvoiceToPreviewModel,
  mapQuickPrintToPreviewModel,
} from '../../types/documents';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';
import {
  Printer,
  Copy,
  FileText,
  Calculator,
  TrendingUp,
  Layers,
  CheckCircle2,
  Keyboard,
  Eye,
} from 'lucide-react';
import { computeQuickPrintEstimate } from '../../utils/quickPrintCalc';

const JOB_TYPE_LABELS: Record<QuickPrintJobType, string> = {
  quick_photocopy: 'Quick Photocopy',
  type_and_printing: 'Type and Printing',
  general_print: 'General Press Print',
};

export const QuickPrintView: React.FC = () => {
  const {
    companyProfile,
    customers,
    inventoryItems,
    quickPrintJobs,
    addQuickPrintJob,
    getRawUsageUnitCost,
    setCurrentView,
    openDocumentPreview,
    generateAndSyncWorkflowInvoice,
    linkQuickPrintInvoice,
    getInvoiceById,
    triggerShortcutNotice,
  } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const canInvoice = hasPermission('invoices:write');
  const canReadCosts = hasPermission('estimates:read_costs');
  const currency = companyProfile.currency || 'K';
  const currencySymbol = getCurrencySymbol(currency);

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

  const [jobType, setJobType] = useState<QuickPrintJobType>('quick_photocopy');
  const [title, setTitle] = useState('A4 Document Photocopy Run');
  const [customerId, setCustomerId] = useState<string>('');
  const [walkInName, setWalkInName] = useState('Walk-In Counter Customer');
  const [createInvoice, setCreateInvoice] = useState(false);
  const [pages, setPages] = useState<number>(10);
  const [copies, setCopies] = useState<number>(25);
  const [printSide, setPrintSide] = useState<'Single-Sided' | 'Duplex'>('Duplex');
  const [rawPaperItemId, setRawPaperItemId] = useState(defaultPaper?.id || '');
  const [rawTonerItemId, setRawTonerItemId] = useState(defaultToner?.id || '');
  // Desk rates are company policy, maintained in Settings only. The desk never
  // edits them, so every operator quotes the same price.
  const defaultExtraPerPage = Number(companyProfile.extraTypingFinishingPerPage ?? 0);
  const defaultPricePerSheet = Number(companyProfile.manualSellingPricePerSheet ?? 0);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const [filterType, setFilterType] = useState<'all' | QuickPrintJobType>('all');

  const selectedPaperMat = rawMaterials.find(r => r.id === rawPaperItemId);
  const selectedTonerMat = rawMaterials.find(r => r.id === rawTonerItemId);
  const paperUnitCost = getRawUsageUnitCost(rawPaperItemId);
  const tonerUnitCost = getRawUsageUnitCost(rawTonerItemId);

  // Live paper + toner calculation through the authoritative shared engine.
  // The same function prices the invoice and POS quick-print modals, so one job
  // can never be quoted differently depending on which screen opened it.
  const liveCalc = useMemo(
    () =>
      computeQuickPrintEstimate({
        paperItem: selectedPaperMat,
        tonerItem: selectedTonerMat,
        paperUsageUnitCost: paperUnitCost,
        tonerUsageUnitCost: tonerUnitCost,
        jobType,
        pages,
        copies,
        printSide,
        extraCostPerPage: defaultExtraPerPage,
        sellingPricePerSheet: defaultPricePerSheet,
      }),
    [
      selectedPaperMat,
      selectedTonerMat,
      paperUnitCost,
      tonerUnitCost,
      jobType,
      pages,
      copies,
      printSide,
      defaultExtraPerPage,
      defaultPricePerSheet,
    ]
  );


  const {
    safePages,
    safeExtraPerPage,
    safePricePerSheet,
    sheetsUsed,
    impressionsUsed,
    paperCost,
    tonerCost,
    extraCostTotal,
    finishingCost,
    typingRevenue,
    photocopyRevenue,
    totalCost,
    sellingPriceTotal,
    realProfit,
    profitMarginPct,
  } = liveCalc;
  const avgSidesPerSheet = sheetsUsed > 0 ? impressionsUsed / sheetsUsed : printSide === 'Duplex' ? 2 : 1;
  const tonerCostPerSheet = sheetsUsed > 0 ? tonerCost / sheetsUsed : 0;
  const paperCostPerSheet = sheetsUsed > 0 ? paperCost / sheetsUsed : paperUnitCost;

  const handleTypePreset = (nextType: QuickPrintJobType) => {
    setJobType(nextType);
    if (nextType === 'quick_photocopy') {
      setTitle('A4 Document Photocopy Run');
    } else if (nextType === 'type_and_printing') {
      setTitle('Document Typing, Formatting & Printout');
    } else {
      setTitle('Custom Press Print Job');
    }
  };

  const handleSubmitJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !rawPaperItemId || !rawTonerItemId) return;
    if (safePricePerSheet <= 0) {
      triggerShortcutNotice(
        'Set Manual Selling Price / Sheet in Settings before posting a print job',
        'error'
      );
      return;
    }

    const selectedCust = customers.find(c => c.id === customerId);
    const resolvedName = selectedCust ? selectedCust.companyName : walkInName.trim() || 'Walk-In Customer';
    const wantsInvoice = Boolean(createInvoice && customerId);

    // A stable key per logical submission. On an uncertain network outcome the
    // key is preserved so a retry replays the original committed sale instead of
    // posting a second one; it is cleared only after confirmed success.
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = `qp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    setSubmitting(true);
    try {
      const created = await addQuickPrintJob(
        {
          customerId: customerId || undefined,
          customerName: resolvedName,
          jobType,
          title: title.trim(),
          pages: safePages,
          copies: Math.max(1, copies),
          printSide,
          rawPaperItemId,
          rawTonerItemId,
          extraCostPerPage: safeExtraPerPage,
          typingFee: jobType === 'type_and_printing' ? extraCostTotal : 0,
          extraCost: jobType === 'type_and_printing' ? 0 : extraCostTotal,
          sellingPricePerSheet: safePricePerSheet,
          sellingPriceTotal,
          date,
          notes: notes.trim() || undefined,
        },
        { createInvoice: wantsInvoice, idempotencyKey: idempotencyKeyRef.current }
      );

      idempotencyKeyRef.current = null;
      triggerShortcutNotice(
        `Posted ${created.jobNumber} to WIP · Real Profit: ${formatCurrency(created.profit, currency)}`
      );
      setNotes('');
    } catch (err: any) {
      // Keep the idempotency key so a retry of the same logical operation is safe.
      triggerShortcutNotice(err?.message || 'Could not post the print job', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const openQuickPrintReceiptPreview = (job: QuickPrintJob) => {
    const customer = customers.find(c => c.id === job.customerId);
    openDocumentPreview(
      mapQuickPrintToPreviewModel({
        job,
        customer,
        companyProfile,
        companyNameOverride: activeCompany?.name,
        includeCosts: canReadCosts,
        onInvoiceGenerated: ({ apiInvoice, localInvoice }) => {
          linkQuickPrintInvoice(job.id, {
            invoiceId: localInvoice?.id,
            backendInvoiceId: apiInvoice.id,
            invoiceNumber: apiInvoice.invoiceNumber,
          });
        },
      })
    );
  };

  const openLinkedJobInvoice = async (job: QuickPrintJob) => {
    if (job.backendInvoiceId) {
      try {
        const raw = await documentsApi.getDocumentPreview('invoice', job.backendInvoiceId);
        openDocumentPreview(mapApiPreviewToModel(raw, currency));
        return;
      } catch {
        // fallback to local invoice
      }
    }
    if (job.invoiceId) {
      const localInv = getInvoiceById(job.invoiceId);
      if (localInv) {
        const customer = customers.find(c => c.id === localInv.customerId);
        openDocumentPreview(
          mapLocalInvoiceToPreviewModel({
            invoice: localInv,
            customer,
            companyProfile,
            companyNameOverride: activeCompany?.name,
          })
        );
        return;
      }
    }
    setCurrentView('invoices');
  };

  const handleGenerateJobInvoice = async (job: QuickPrintJob) => {
    if (!canInvoice) return;
    const customer = customers.find(c => c.id === job.customerId);
    const model = mapQuickPrintToPreviewModel({
      job,
      customer,
      companyProfile,
      companyNameOverride: activeCompany?.name,
      includeCosts: canReadCosts,
    });
    if (!model.generateInvoiceInput) return;
    try {
      const { apiInvoice, localInvoice } = await generateAndSyncWorkflowInvoice(
        model.generateInvoiceInput,
        { localCustomerId: job.customerId }
      );
      linkQuickPrintInvoice(job.id, {
        invoiceId: localInvoice.id,
        backendInvoiceId: apiInvoice.id,
        invoiceNumber: apiInvoice.invoiceNumber,
      });
      triggerShortcutNotice(`Generated invoice ${apiInvoice.invoiceNumber} for ${job.jobNumber}`);
      try {
        const raw = await documentsApi.getDocumentPreview('invoice', apiInvoice.id);
        openDocumentPreview(mapApiPreviewToModel(raw, currency));
      } catch {
        openDocumentPreview(
          mapLocalInvoiceToPreviewModel({
            invoice: localInvoice,
            customer,
            companyProfile,
            companyNameOverride: activeCompany?.name,
          })
        );
      }
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to generate invoice for quick print job', 'error');
    }
  };

  const duplicateToCalculator = (job: QuickPrintJob) => {
    setJobType(job.jobType);
    setTitle(`${job.title} (Repeat)`);
    setCustomerId(job.customerId || '');
    setWalkInName(job.customerName);
    setPages(job.pages);
    setCopies(job.copies);
    setPrintSide(job.printSide);
    setRawPaperItemId(job.rawPaperItemId);
    setRawTonerItemId(job.rawTonerItemId);
    triggerShortcutNotice(`Loaded specs from ${job.jobNumber} into desk calculator`);
  };

  const buildJobActionContext = (job: QuickPrintJob, pendingId?: string | null): ActionEligibilityContext<QuickPrintJob> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'quick_print',
    entityType: 'quick_print_job',
    record: job,
    recordStatus: job.invoiceId || job.backendInvoiceId ? 'invoiced' : 'completed',
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const buildJobActionDefinitions = (job: QuickPrintJob): AdvancedActionDefinition<QuickPrintJob>[] => {
    const defs: AdvancedActionDefinition<QuickPrintJob>[] = [
      {
        id: 'job.preview-receipt',
        label: 'Preview Job Receipt',
        icon: <Eye className="w-3.5 h-3.5 text-slate-700" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'printing:read',
        execute: async () => { openQuickPrintReceiptPreview(job); },
      },
    ];
    if (!job.invoiceId && !job.backendInvoiceId && canInvoice) {
      defs.push({
        id: 'job.generate-invoice',
        label: 'Generate & Preview Invoice',
        icon: <FileText className="w-3.5 h-3.5 text-emerald-600" />,
        group: 'process',
        groupLabel: 'Actions',
        requiredPermission: 'invoices:write',
        execute: async () => { await handleGenerateJobInvoice(job); },
      });
    }
    if (job.invoiceId || job.backendInvoiceId) {
      defs.push({
        id: 'job.view-linked-invoice',
        label: `Preview Linked Invoice${job.linkedInvoiceNumber ? ` (${job.linkedInvoiceNumber})` : ''}`,
        icon: <FileText className="w-3.5 h-3.5 text-emerald-600" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'invoices:read',
        execute: async () => { await openLinkedJobInvoice(job); },
      });
    }
    defs.push({
      id: 'job.duplicate',
      label: 'Load Specs into Calculator',
      icon: <Calculator className="w-3.5 h-3.5 text-blue-600" />,
      group: 'process',
      groupLabel: 'Actions',
      requiredPermission: 'printing:read',
      execute: async () => { duplicateToCalculator(job); },
    });
    defs.push({
      id: 'job.copy-number',
      label: 'Copy Job Number',
      icon: <Copy className="w-3.5 h-3.5" />,
      group: 'admin',
      groupLabel: 'Other',
      requiredPermission: 'printing:read',
      execute: async () => {
        await navigator.clipboard?.writeText(job.jobNumber);
        triggerShortcutNotice(`Copied ${job.jobNumber}`);
      },
    });
    return defs;
  };

  const renderJobActions = (job: QuickPrintJob) => {
    const defs = buildJobActionDefinitions(job);
    const ctx = buildJobActionContext(job, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<QuickPrintJob>
        label={`Actions for ${job.jobNumber}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={job.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => {
          const def = action.definition;
          if (typeof def.execute === 'function') {
            await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) });
          }
        }}
      />
    );
  };

  const filteredJobs = quickPrintJobs.filter(j =>
    filterType === 'all' ? true : j.jobType === filterType
  );

  // KPI metrics
  const totalRevenue = quickPrintJobs.reduce((s, j) => s + j.sellingPriceTotal, 0);
  const totalMaterialAndExtra = quickPrintJobs.reduce((s, j) => s + j.totalCost, 0);
  const totalRealProfit = quickPrintJobs.reduce((s, j) => s + j.profit, 0);
  const totalSheetsConsumed = quickPrintJobs.reduce((s, j) => s + j.sheetsUsed, 0);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            Quick Photocopy, Type & Printing Desk
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Paper and toner costs are automatically driven from Raw Material unit conversions. Selling price per sheet and the typing rate come from Settings → Print Desk Pricing Defaults.
          </p>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Desk Revenue
            </div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {formatCurrency(totalRevenue, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {quickPrintJobs.length} completed jobs
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <Printer className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Material &amp; Finishing Cost
            </div>
            <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400 mt-1 tabular-nums">
              {formatCurrency(totalMaterialAndExtra, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Paper, toner &amp; physical finishing
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
            <Layers className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Real Gross Profit
            </div>
            <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1 tabular-nums">
              {formatCurrency(totalRealProfit, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono">
              {totalRevenue > 0 ? ((totalRealProfit / totalRevenue) * 100).toFixed(1) : '0.0'}% net margin
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <TrendingUp className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Sheets Consumed
            </div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {totalSheetsConsumed.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono">
              ~{(totalSheetsConsumed / 500).toFixed(2)} standard reams
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <Calculator className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Job Costing Calculator & Posting Panel */}
      <form
        onSubmit={handleSubmitJob}
        className="grid grid-cols-1 lg:grid-cols-12 gap-5 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5"
      >
        {/* Left: Production Specs */}
        <div className="lg:col-span-8 space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
              <Keyboard className="w-4 h-4 text-blue-600" />
              <span>New Quick Photocopy / Type & Printing Job</span>
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
              {(['quick_photocopy', 'type_and_printing', 'general_print'] as QuickPrintJobType[]).map(
                t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => handleTypePreset(t)}
                    className={`px-2.5 py-1 rounded-md font-semibold transition-colors ${
                      jobType === t
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900'
                    }`}
                  >
                    {JOB_TYPE_LABELS[t]}
                  </button>
                )
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2 space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Job Title / Description</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. Typed Contract & 40 Copies"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Job Date</label>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Account Customer (Optional)</label>
              <select
                value={customerId}
                onChange={e => {
                  setCustomerId(e.target.value);
                  if (!e.target.value) setCreateInvoice(false);
                }}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
              >
                <option value="">-- Walk-In Cash Customer --</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.companyName}
                  </option>
                ))}
              </select>
            </div>

            {!customerId ? (
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Walk-In Customer Name</label>
                <input
                  type="text"
                  value={walkInName}
                  onChange={e => setWalkInName(e.target.value)}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                />
              </div>
            ) : (
              <div className="flex items-end pb-1.5">
                <label className="flex items-center gap-2 cursor-pointer font-semibold text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={createInvoice}
                    onChange={e => setCreateInvoice(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600"
                  />
                  <span>Post to Customer Invoice (A/R)</span>
                </label>
              </div>
            )}

            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Print Side</label>
              <select
                value={printSide}
                onChange={e => setPrintSide(e.target.value as any)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
              >
                <option value="Duplex">Duplex (Front & Back — 2pp/sheet)</option>
                <option value="Single-Sided">Single-Sided (1pp/sheet)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Pages in Document</label>
              <input
                type="number"
                min="1"
                value={pages}
                onChange={e => setPages(parseInt(e.target.value) || 1)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono text-right outline-none"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Copies</label>
              <input
                type="number"
                min="1"
                value={copies}
                onChange={e => setCopies(parseInt(e.target.value) || 1)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono text-right outline-none"
                required
              />
            </div>
          </div>

          <div className="px-3 py-2 rounded-lg bg-blue-50/60 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono">
            <span className="font-sans font-semibold text-blue-800 dark:text-blue-300">
              Desk rates from Settings:
            </span>
            <span className="tabular-nums text-slate-700 dark:text-slate-200">
              {formatCurrency(safePricePerSheet, currency)} / sheet × {sheetsUsed.toLocaleString()} ={' '}
              <strong>{formatCurrency(photocopyRevenue, currency)}</strong>
            </span>
            {jobType === 'type_and_printing' && (
              <span className="tabular-nums text-slate-700 dark:text-slate-200">
                + typing {formatCurrency(safeExtraPerPage, currency)} / page × {safePages} ={' '}
                <strong>{formatCurrency(typingRevenue, currency)}</strong>
                {' '}= total <strong>{formatCurrency(sellingPriceTotal, currency)}</strong>
              </span>
            )}
          </div>

          <div className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
            <span className="font-sans text-slate-600 dark:text-slate-300">
              <strong className="text-slate-900 dark:text-white">
                {printSide === 'Duplex' ? 'Duplex (Front & Back):' : 'Single-Sided (Front Only):'}
              </strong>{' '}
              {printSide === 'Duplex'
                ? safePages === 1
                  ? '1-page document prints 1 side per sheet (back side blank).'
                  : safePages % 2 === 0
                  ? 'Toner is used on both pages (2 sides) of every sheet.'
                  : 'Toner is used on both sides of full sheets and 1 side on the trailing odd sheet.'
                : 'Toner is used on 1 single page (front side) of every sheet.'}
            </span>
            <span className="tabular-nums text-slate-700 dark:text-slate-200 font-semibold">
              {sheetsUsed.toLocaleString()} shts · {impressionsUsed.toLocaleString()} toner imp ({avgSidesPerSheet % 1 === 0 ? avgSidesPerSheet.toFixed(0) : avgSidesPerSheet.toFixed(2)} sides/sht)
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">
                Paper Raw Material ({currencySymbol}{paperUnitCost.toFixed(4)} / {selectedPaperMat?.usageUnit || 'Sheet'})
              </label>
              <select
                value={rawPaperItemId}
                onChange={e => setRawPaperItemId(e.target.value)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                required
              >
                {rawMaterials.map(rm => (
                  <option key={rm.id} value={rm.id}>
                    {rm.sku} · {rm.name} ({formatCurrency(getRawUsageUnitCost(rm.id), currency)}/{rm.usageUnit || 'Unit'} · {rm.onHand} {rm.purchaseUnit || 'Units'} left)
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">
                Toner Raw Material ({currencySymbol}{tonerUnitCost.toFixed(4)} / {selectedTonerMat?.usageUnit || 'Impression'})
              </label>
              <select
                value={rawTonerItemId}
                onChange={e => setRawTonerItemId(e.target.value)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                required
              >
                {rawMaterials.map(rm => (
                  <option key={rm.id} value={rm.id}>
                    {rm.sku} · {rm.name} ({formatCurrency(getRawUsageUnitCost(rm.id), currency)}/{rm.usageUnit || 'Unit'} · {rm.onHand} {rm.purchaseUnit || 'Units'} left)
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Right: Real-Time Costing & Profit Summary */}
        <div className="lg:col-span-4 flex flex-col justify-between p-4 rounded-xl bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 space-y-4">
          <div className="space-y-2.5 text-xs">
            <div className="font-bold text-slate-900 dark:text-white uppercase tracking-wider text-[11px] border-b border-slate-200 dark:border-slate-700 pb-2">
              Real Material Cost & Profit Check
            </div>

            <div className="flex justify-between font-mono gap-2">
              <span className="text-slate-600 dark:text-slate-400 font-sans">
                Paper ({sheetsUsed.toLocaleString()} {selectedPaperMat?.usageUnit || 'Sheet'}s · {currencySymbol}{paperCostPerSheet.toFixed(4)}/sht):
              </span>
              <span className="tabular-nums font-semibold shrink-0">{formatCurrency(paperCost, currency)}</span>
            </div>

            <div className="flex justify-between font-mono gap-2">
              <span className="text-slate-600 dark:text-slate-400 font-sans">
                Toner ({impressionsUsed.toLocaleString()} imp · {avgSidesPerSheet % 1 === 0 ? avgSidesPerSheet.toFixed(0) : avgSidesPerSheet.toFixed(2)} side/sht · {currencySymbol}{tonerCostPerSheet.toFixed(4)}/sht):
              </span>
              <span className="tabular-nums font-semibold shrink-0">{formatCurrency(tonerCost, currency)}</span>
            </div>

            {finishingCost > 0 && (
              <div className="flex justify-between font-mono gap-2">
                <span className="text-slate-600 dark:text-slate-400 font-sans">
                  Physical Finishing ({safePages} pp × {currencySymbol}{safeExtraPerPage.toFixed(2)}/pp):
                </span>
                <span className="tabular-nums font-semibold shrink-0">{formatCurrency(finishingCost, currency)}</span>
              </div>
            )}

            <div className="flex justify-between font-mono pt-2 border-t border-slate-200 dark:border-slate-700 font-bold text-slate-800 dark:text-slate-200 gap-2">
              <span className="font-sans">Total Material Cost:</span>
              <span className="tabular-nums shrink-0">{formatCurrency(totalCost, currency)}</span>
            </div>

            <div className="flex justify-between font-mono gap-2">
              <span className="text-slate-600 dark:text-slate-400 font-sans">
                Photocopying ({sheetsUsed.toLocaleString()} shts × {currencySymbol}{safePricePerSheet.toFixed(2)}/sht):
              </span>
              <span className="tabular-nums font-semibold shrink-0">{formatCurrency(photocopyRevenue, currency)}</span>
            </div>

            {typingRevenue > 0 && (
              <div className="flex justify-between font-mono gap-2">
                <span className="text-slate-600 dark:text-slate-400 font-sans">
                  Typing &amp; Printing ({safePages} pp × {currencySymbol}{safeExtraPerPage.toFixed(2)}/pp):
                </span>
                <span className="tabular-nums font-semibold shrink-0">{formatCurrency(typingRevenue, currency)}</span>
              </div>
            )}

            <div className="flex justify-between font-mono font-bold text-slate-900 dark:text-white gap-2">
              <span className="font-sans">Total Revenue:</span>
              <span className="tabular-nums shrink-0">{formatCurrency(sellingPriceTotal, currency)}</span>
            </div>

            <div
              className={`p-3 rounded-lg border flex items-center justify-between font-mono ${
                realProfit >= 0
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300'
                  : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300'
              }`}
            >
              <div>
                <div className="font-sans text-[10px] font-bold uppercase tracking-wider">
                  Real Job Profit
                </div>
                <div className="text-lg font-black tabular-nums">
                  {formatCurrency(realProfit, currency)}
                </div>
              </div>
              <div className="text-right">
                <div className="font-sans text-[10px] font-bold uppercase">Margin</div>
                <div className="text-sm font-bold tabular-nums">{profitMarginPct.toFixed(1)}%</div>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-bold text-xs shadow-sm transition-all active:scale-95"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>
              {submitting
                ? 'Posting to production…'
                : createInvoice && customerId
                ? 'Post Job to WIP & Create Invoice'
                : 'Post Job to WIP & Record Cash Sale'}
            </span>
          </button>
        </div>
      </form>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1 p-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl w-fit text-xs">
        {(
          [
            { id: 'all', label: `All Jobs (${quickPrintJobs.length})` },
            { id: 'quick_photocopy', label: 'Quick Photocopy' },
            { id: 'type_and_printing', label: 'Type & Printing' },
            { id: 'general_print', label: 'General Print' },
          ] as const
        ).map(tab => (
          <button
            key={tab.id}
            onClick={() => setFilterType(tab.id)}
            className={`px-3 py-1.5 rounded-lg transition-colors ${
              filterType === tab.id
                ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Job History Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-3">JOB # / DATE</th>
                <th className="px-4 py-3">SERVICE & DESCRIPTION</th>
                <th className="px-4 py-3">CUSTOMER</th>
                <th className="px-4 py-3 text-right">SHEETS / IMP</th>
                <th className="px-4 py-3 text-right">PAPER + TONER COST</th>
                <th className="px-4 py-3 text-right">SELLING PRICE</th>
                <th className="px-4 py-3 text-right">REAL PROFIT</th>
                <th className="px-4 py-3 text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {filteredJobs.map(job => {
                const margin =
                  job.sellingPriceTotal > 0 ? (job.profit / job.sellingPriceTotal) * 100 : 0;
                return (
                  <tr key={job.id} className="hover:bg-slate-50 dark:hover:bg-slate-850/50">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-bold text-slate-900 dark:text-white">{job.jobNumber}</div>
                      <div className="text-[10px] text-slate-500">{job.date}</div>
                    </td>
                    <td className="px-4 py-3 font-sans">
                      <div className="font-semibold text-slate-900 dark:text-white">{job.title}</div>
                      <div className="text-[11px] text-slate-500">
                        {JOB_TYPE_LABELS[job.jobType]} · {job.pages}pp × {job.copies} copies ({job.printSide})
                      </div>
                    </td>
                    <td className="px-4 py-3 font-sans text-slate-700 dark:text-slate-300">
                      <div>{job.customerName}</div>
                      <div className="text-[10px] text-slate-400">
                        {job.invoiceId || job.backendInvoiceId
                          ? `Posted to Invoice${job.linkedInvoiceNumber ? ` · ${job.linkedInvoiceNumber}` : ''}`
                          : 'Cash Counter Sale'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600 dark:text-slate-400">
                      <div>{job.sheetsUsed.toLocaleString()} shts</div>
                      <div className="text-[10px] text-slate-400">
                        {job.impressionsUsed.toLocaleString()} imp
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-amber-700 dark:text-amber-400">
                      <div className="font-semibold">{formatCurrency(job.totalCost, currency)}</div>
                      <div className="text-[10px] text-slate-400">
                        P:{formatCurrency(job.paperCost, currency)} · T:{formatCurrency(job.tonerCost, currency)}
                        {(job.typingFee || 0) + (job.extraCost || 0) > 0
                          ? ` · Typing/Fin:${formatCurrency((job.typingFee || 0) + (job.extraCost || 0), currency)}`
                          : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums text-slate-900 dark:text-white">
                      <div>{formatCurrency(job.sellingPriceTotal, currency)}</div>
                      <div className="text-[10px] font-normal text-slate-400">
                        {currencySymbol}
                        {(
                          job.sellingPricePerSheet ??
                          (job.sheetsUsed > 0 ? job.sellingPriceTotal / job.sheetsUsed : 0)
                        ).toFixed(2)}
                        /sht
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums">
                      <div
                        className={
                          job.profit >= 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-rose-600 dark:text-rose-400'
                        }
                      >
                        {formatCurrency(job.profit, currency)}
                      </div>
                      <div className="text-[10px] text-slate-500">{margin.toFixed(1)}%</div>
                    </td>
                    <td className="px-4 py-3 text-right font-sans">
                      {renderJobActions(job)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
