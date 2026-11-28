import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { commercialApi, ApiCustomer } from '../../services/commercialApi';
import { accountingApi, ApiAccount } from '../../services/accountingApi';
import { ModalShell } from '../common/ui';
import { appDialog } from '../../design-system';
import { Sparkles, Copy } from 'lucide-react';
import { printingApi } from '../../services/printingApi';
import { QuickPrintJobModal, type QuickPrintJobDraft } from './QuickPrintJobModal';
import { aiApi, AiProposedAction } from '../../services/v2Api';
import { useFxRates } from '../../hooks/useFxRates';

type Line = {
  id: string;
  itemId: string;
  description: string;
  quantity: number;
  rate: number;
  /** Null means cost is unknown/unavailable; never silently treat as zero. */
  unitCost: number | null;
  /**
   * A desk print job carried by this line. Its quantity/rate are fixed by the
   * costing preview and the job is posted to production before the invoice is
   * saved, so the two can never disagree.
   */
  quickPrint?: QuickPrintJobDraft;
};

type SearchItem = {
  id: string;
  name: string;
  price: number;
  onHand: number | null;
  unitCost: number | null;
  itemType: string;
};

type CreditProfile = {
  creditLimit: number | null;
  availableCredit: number | null;
  exposure: number;
  overLimit: boolean;
  creditHold: boolean;
};

const TERMS_OPTIONS: Array<{ label: string; days: number }> = [
  { label: 'Due on receipt', days: 0 },
  { label: 'Net 14', days: 14 },
  { label: 'Net 30', days: 30 },
  { label: 'Net 60', days: 60 },
];

const addDays = (iso: string, days: number): string => {
  const d = new Date(iso || new Date().toISOString().slice(0, 10));
  if (!Number.isNaN(d.getTime())) d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Fixed 4-decimal scale used for deterministic discount allocation. */
const SCALE = 10000;
const to4 = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * SCALE);

/**
 * Distribute `total4` across `weights` proportionally, in 4-dp integer units,
 * using largest-remainder rounding so the parts sum exactly to `total4`.
 */
function allocateByLargestRemainder(weights: number[], total4: number): number[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0 || total4 <= 0) return weights.map(() => 0);
  const raw = weights.map(w => (total4 * w) / sumW);
  const floors = raw.map(Math.floor);
  let remainder = total4 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) floors[order[k % order.length].i] += 1;
  return floors;
}

function newIdempotencyKey(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `inv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const SearchDropdown: React.FC<{
  label: string;
  placeholder: string;
  items: SearchItem[];
  onPick: (item: SearchItem) => void;
  formatMoney: (n: number) => string;
}> = ({ label, placeholder, items, onPick, formatMoney }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const blurRef = useRef<number | null>(null);

  const filtered = useMemo(() => {
    const s = query.trim().toLowerCase();
    const list = s ? items.filter(i => i.name.toLowerCase().includes(s)) : items;
    return list.slice(0, 12);
  }, [query, items]);

  const pick = (item: SearchItem) => {
    onPick(item);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="relative flex items-center gap-2 border-b border-slate-300 dark:border-white/20">
      <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-400">
        {label}
      </span>
      <input
        value={query}
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => {
          if (blurRef.current) window.clearTimeout(blurRef.current);
          setOpen(true);
        }}
        onBlur={() => {
          blurRef.current = window.setTimeout(() => setOpen(false), 150);
        }}
        onChange={e => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && open && filtered[0]) {
            e.preventDefault();
            pick(filtered[0]);
          }
          if (e.key === 'Escape') setOpen(false);
        }}
        className="w-full border-0 bg-transparent px-0 py-1.5 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:ring-0 dark:text-slate-100"
      />
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-pop dark:border-white/10 dark:bg-slate-900">
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-slate-400">No matches</div>
          )}
          {filtered.map((it, i) => (
            <button
              type="button"
              key={it.id}
              onMouseDown={e => {
                e.preventDefault();
                pick(it);
              }}
              className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-brand-50 dark:hover:bg-white/[0.06] ${
                i === 0 ? 'bg-slate-50 dark:bg-white/[0.03]' : ''
              }`}
            >
              <span className="truncate text-slate-700 dark:text-slate-200">{it.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                {formatMoney(it.price)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const NewInvoiceModal: React.FC = () => {
  const {
    isNewInvoiceOpen,
    setIsNewInvoiceOpen,
    setIsNewCustomerOpen,
    companyProfile,
    triggerShortcutNotice,
  } = useAccounting();
  const { baseCurrency, rateFor, loading: fxLoading } = useFxRates();

  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState<string>('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [terms, setTerms] = useState('Net 30');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [invoiceCurrency, setInvoiceCurrency] = useState('');

  const [lines, setLines] = useState<Line[]>([
    { id: 'l-1', itemId: '', description: '', quantity: 1, rate: 0, unitCost: null },
  ]);
  const [lastAdded, setLastAdded] = useState<SearchItem | null>(null);

  const [quickPrintOpen, setQuickPrintOpen] = useState(false);

  const [discountMode, setDiscountMode] = useState<'K' | '%'>('K');
  const [discountValue, setDiscountValue] = useState('');
  const [otherChargesEnabled, setOtherChargesEnabled] = useState(false);
  const [otherCharges, setOtherCharges] = useState('');
  const [taxPercent, setTaxPercent] = useState(0);
  const [bankAccountId, setBankAccountId] = useState<string>('');

  const [creditProfile, setCreditProfile] = useState<CreditProfile | null>(null);
  const [creditLoading, setCreditLoading] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  // A stable key for this creation attempt. Reused across retries; rotated only
  // after a confirmed success (or when a fresh modal is opened).
  const idemKeyRef = useRef<string>('');

  const catalog: SearchItem[] = useMemo(
    () =>
      items.map(i => ({
        id: String(i.id),
        name: i.name || i.sku || 'Item',
        price: Number(i.sales_price ?? i.salesPrice ?? 0),
        onHand:
          i.on_hand != null ? Number(i.on_hand) : i.onHand != null ? Number(i.onHand) : null,
        unitCost:
          i.unit_cost != null
            ? Number(i.unit_cost)
            : i.unitCost != null
            ? Number(i.unitCost)
            : i.cost != null
            ? Number(i.cost)
            : null,
        itemType: String(i.item_type || i.type || ''),
      })),
    [items]
  );

  const itemCatalog = useMemo(() => catalog.filter(c => !c.itemType.includes('service')), [catalog]);
  const serviceCatalog = useMemo(() => {
    const svc = catalog.filter(c => c.itemType.includes('service'));
    return svc.length ? svc : catalog;
  }, [catalog]);

  const termsDays = (label: string) => TERMS_OPTIONS.find(t => t.label === label)?.days ?? 30;
  useEffect(() => {
    setDueDate(addDays(date, termsDays(terms)));
  }, [date, terms]);

  // Deterministic reset whenever the modal opens.
  useEffect(() => {
    if (!isNewInvoiceOpen) return;
    setLines([{ id: 'l-1', itemId: '', description: '', quantity: 1, rate: 0, unitCost: null }]);
    setInvoiceNumber('');
    setNotes('');
    setDiscountMode('K');
    setDiscountValue('');
    setOtherChargesEnabled(false);
    setOtherCharges('');
    setLastAdded(null);
    setError(null);
    setOverrideReason('');
    setCreditProfile(null);
    setDate(new Date().toISOString().slice(0, 10));
    setTerms('Net 30');
    const rawTax = Number(companyProfile.salesTaxRate || 0);
    const taxPct = rawTax > 1 ? rawTax : rawTax * 100;
    setTaxPercent(Math.round(taxPct * 10) / 10);
    setMode('manual');
    setAiRequest('');
    setAiAction(null);
    setAiPreview([]);
    setAiError(null);
    setAiApplyConfirm(false);
    setAssistInput('');
    setAssistAnswer(null);
    setQuickPrintOpen(false);
    idemKeyRef.current = newIdempotencyKey();
    setLoading(true);
    Promise.all([
      commercialApi.listCustomers().catch(() => [] as ApiCustomer[]),
      commercialApi.listInventory().catch(() => [] as any[]),
      accountingApi.listAccounts(true).catch(() => [] as ApiAccount[]),
    ])
      .then(([custs, its, accts]) => {
        setCustomers(custs);
        setItems(its);
        const firstCustomer = custs[0] ?? null;
        setCustomerId(firstCustomer ? String(firstCustomer.id) : '');
        setInvoiceCurrency(firstCustomer?.currencyCode || baseCurrency || '');
        const banks = accts.filter(a => a.account_type === 'Bank' && a.is_active);
        setBankAccountId(banks[0] ? String(banks[0].id) : '');
        setLoading(false);
      })
      .catch(err => {
        setError(err?.message || 'Failed to load data');
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewInvoiceOpen]);

  // Keep invoice currency aligned with authoritative company/customer currency.
  useEffect(() => {
    if (!isNewInvoiceOpen) return;
    const customerCurrency = customers.find(c => String(c.id) === customerId)?.currencyCode;
    const resolved = customerCurrency || baseCurrency || '';
    if (resolved && resolved !== invoiceCurrency) {
      setInvoiceCurrency(resolved);
    }
  }, [isNewInvoiceOpen, customers, customerId, baseCurrency, invoiceCurrency]);

  // Load the authoritative credit profile whenever the selected customer changes.
  useEffect(() => {
    if (!isNewInvoiceOpen || !customerId) {
      setCreditProfile(null);
      return;
    }
    let cancelled = false;
    setCreditLoading(true);
    commercialApi
      .getCustomerCreditProfile(Number(customerId))
      .then(p => {
        if (cancelled) return;
        setCreditProfile({
          creditLimit: p?.creditLimit ?? null,
          availableCredit: p?.availableCredit ?? null,
          exposure: Number(p?.exposure ?? 0),
          overLimit: Boolean(p?.overLimit),
          creditHold: Boolean(p?.creditHold),
        });
      })
      .catch(() => {
        if (!cancelled) setCreditProfile(null);
      })
      .finally(() => {
        if (!cancelled) setCreditLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, isNewInvoiceOpen]);

  const [aiRequest, setAiRequest] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAction, setAiAction] = useState<AiProposedAction | null>(null);
  const [aiPreview, setAiPreview] = useState<Array<{ description: string; quantity: number; rate: number; taxable: boolean }>>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiApplyConfirm, setAiApplyConfirm] = useState(false);
  const [mode, setMode] = useState<'manual' | 'ai'>('manual');
  const [assistInput, setAssistInput] = useState('');
  const [assistAnswer, setAssistAnswer] = useState<string | null>(null);
  const [assistBusy, setAssistBusy] = useState(false);

  const askAssist = async () => {
    const q = assistInput.trim();
    if (!q || assistBusy) return;
    setAssistBusy(true);
    setAssistAnswer(null);
    try {
      const res = await aiApi.chat({ message: q });
      setAssistAnswer(res.response.content);
      setAssistInput('');
    } catch (e: any) {
      setAssistAnswer(e?.message || 'AI request failed');
    } finally {
      setAssistBusy(false);
    }
  };

  if (!isNewInvoiceOpen) return null;

  const close = () => setIsNewInvoiceOpen(false);
  const selectedCustomer = customers.find(c => String(c.id) === customerId);
  const currency = invoiceCurrency || companyProfile.currency || 'K';
  const fmt = (n: number) => formatCurrency(Number.isFinite(n) ? n : 0, currency);

  const currencyKnown = Boolean(currency) && Boolean(baseCurrency);
  const isForeign = currencyKnown && currency !== baseCurrency;
  const fxRate = isForeign ? rateFor(currency) : 1;
  const currencyReady = currencyKnown && (!isForeign || (fxRate != null && fxRate > 0));

  const isExempt = Boolean(
    selectedCustomer?.isTaxExempt &&
      (selectedCustomer as any).taxExemptionValid !== false &&
      (!(selectedCustomer as any).taxExemptionExpiry ||
        (selectedCustomer as any).taxExemptionExpiry >= date)
  );

  const aiDraft = async () => {
    if (!customerId) { setAiError('Select a customer first.'); return; }
    if (!aiRequest.trim()) { setAiError('Describe the invoice items first.'); return; }
    setAiBusy(true); setAiError(null); setAiAction(null); setAiPreview([]);
    try {
      const res = await aiApi.proposeInvoice({ customerId: Number(customerId), request: aiRequest.trim() });
      setAiAction(res.action);
      setAiPreview(res.preview);
      setAiApplyConfirm(false);
    } catch (err: any) {
      setAiError(err?.message || 'AI invoice draft failed');
    } finally {
      setAiBusy(false);
    }
  };

  // AI never creates the invoice. It only fills the ordinary form, which the
  // user then saves through the normal (validated, idempotent) path.
  const applyAiDraft = (mode: 'replace' | 'append') => {
    const drafted: Line[] = aiPreview.map((l, i) => ({
      id: `l-ai-${Date.now()}-${i}`,
      itemId: '',
      description: l.description,
      quantity: l.quantity,
      rate: l.rate,
      unitCost: null,
    }));
    setLines(prev => {
      const base = mode === 'append' ? prev.filter(l => l.description.trim().length > 0) : [];
      return [...base, ...drafted];
    });
    setAiAction(null);
    setAiPreview([]);
    setAiRequest('');
    setAiApplyConfirm(false);
    setMode('manual');
  };

  const addItem = (item: SearchItem) => {
    setLines(prev => {
      const existing = prev.find(l => l.itemId === String(item.id));
      if (existing) {
        return prev.map(l => (l.id === existing.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [
        ...prev,
        {
          id: `l-${Date.now()}-${item.id}`,
          itemId: String(item.id),
          description: item.name,
          quantity: 1,
          rate: item.price,
          unitCost: item.unitCost,
        },
      ];
    });
    setLastAdded(item);
  };

  const addQuickPrintJob = (draft: QuickPrintJobDraft) => {
    const jobLabel =
      draft.jobType === 'quick_photocopy'
        ? 'Quick Photocopy'
        : draft.jobType === 'type_and_printing'
        ? 'Type & Print'
        : 'General Print';
    const description = `${jobLabel} — ${draft.title} (${draft.pages} pp × ${draft.copies} copies, ${
      draft.printSide
    } · ${draft.estimate.sheetsUsed.toLocaleString()} sheets)`;
    setLines(prev => [
      ...prev,
      {
        id: `l-qp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        itemId: '',
        description,
        quantity: 1,
        rate: draft.estimate.sellingPriceTotal,
        unitCost: draft.estimate.totalCost,
        quickPrint: draft,
      },
    ]);
  };

  const updateLine = (id: string, patch: Partial<Line>) => {
    setLines(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  };
  const removeLine = (id: string) => {
    setLines(prev => (prev.length > 1 ? prev.filter(l => l.id !== id) : prev));
  };

  // ── Totals (deterministic, fixed precision) ────────────────────────────────
  const lineAmounts4 = lines.map(l => to4((Number(l.quantity) || 0) * (Number(l.rate) || 0)));
  const subtotal4 = lineAmounts4.reduce((a, b) => a + b, 0);
  const subtotal = subtotal4 / SCALE;
  const hasUnknownCost = lines.some(
    l => l.description.trim().length > 0 && l.unitCost == null
  );
  const costKnown = !hasUnknownCost;
  const cost = costKnown
    ? lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0), 0)
    : 0;

  const rawDiscount = Number(discountValue) || 0;
  const discountAmount =
    rawDiscount <= 0
      ? 0
      : Math.min(subtotal, Math.max(0, discountMode === '%' ? (subtotal * rawDiscount) / 100 : rawDiscount));
  const discount4 = to4(discountAmount);
  const discountedTotal4 = Math.max(0, subtotal4 - discount4);
  const allocated4 = allocateByLargestRemainder(lineAmounts4, discountedTotal4);

  const otherChargesValue = otherChargesEnabled ? Math.max(0, Number(otherCharges) || 0) : 0;
  const net = subtotal - discountAmount + otherChargesValue;
  const taxRate = isExempt ? 0 : Math.max(0, taxPercent) / 100;
  const taxAmount = Math.max(0, net) * taxRate;
  const total = Math.max(0, net) + taxAmount;
  const grossProfit = costKnown ? net - cost : null;

  const totalQty = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  const validLineCount = lines.filter(l => l.description.trim().length > 0).length;
  const unitsLeft = (() => {
    if (!lastAdded || lastAdded.onHand == null) return null;
    const inCart = lines
      .filter(l => l.itemId === lastAdded.id)
      .reduce((s, l) => s + l.quantity, 0);
    return Math.max(0, lastAdded.onHand - inCart);
  })();

  const projectedBase = isForeign ? total * (fxRate || 1) : total;
  const overLimit = Boolean(
    !isExempt &&
      creditProfile &&
      creditProfile.creditLimit != null &&
      (creditProfile.availableCredit != null
        ? projectedBase > creditProfile.availableCredit
        : projectedBase > creditProfile.creditLimit)
  );

  const isDirty =
    validLineCount > 0 ||
    notes.trim().length > 0 ||
    discountValue.trim().length > 0 ||
    (otherChargesEnabled && otherCharges.trim().length > 0) ||
    lines.some(l => Boolean(l.quickPrint));

  const beforeClose = async () => {
    if (!isDirty || submitting) return true;
    return appDialog.confirm({
      title: 'Discard unsaved invoice?',
      message: 'You have unsaved line items or notes on this invoice. Discard your changes and close?',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      destructive: true,
    });
  };

  const canSave = Boolean(customerId) && validLineCount > 0 && currencyReady && !loading;

  const handleSave = async (isSalesReceipt: boolean) => {
    if (!customerId || validLineCount === 0 || !currencyReady) return;
    if (isSalesReceipt && !bankAccountId) {
      setError('A bank/cash account is required to record payment.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const postedJobs: number[] = [];
    try {
      // The document-level discount reduces revenue per line, so the desk job's
      // selling price is posted net of it. Otherwise the job's reported margin
      // would ignore the discount the customer actually received.
      const discountFraction = subtotal > 0 ? Math.min(1, discountAmount / subtotal) : 0;

      // Desk print jobs are posted to production first (material issue to WIP), so
      // the invoice bills real cost instead of inventing one. If a later step
      // fails the jobs stay in WIP and can be billed again rather than silently
      // losing their stock movement. Keys are stable across retries.
      for (const line of lines) {
        if (!line.quickPrint) continue;
        const draft = line.quickPrint;
        const { job } = await printingApi.postQuickPrintJob({
          jobType: draft.jobType,
          customerId: Number(customerId),
          title: draft.title,
          pages: draft.pages,
          copies: draft.copies,
          printSide: draft.printSide,
          rawPaperItemId: Number(draft.rawPaperItemId),
          rawTonerItemId: Number(draft.rawTonerItemId),
          typingFeeMode: 'per_page',
          typingFeeRate: draft.jobType === 'type_and_printing' ? draft.extraCostPerPage : 0,
          manualSellingPricePerSheet:
            Math.round(draft.sellingPricePerSheet * (1 - discountFraction) * 10000) / 10000,
          jobDate: draft.date,
          notes: draft.notes ?? null,
          idempotencyKey: `inv-quick-${line.id}`,
        });
        const jobId = Number(job?.id);
        if (Number.isInteger(jobId) && jobId > 0) postedJobs.push(jobId);
      }

      const payloadLines = lines
        .map((l, idx) => ({ l, idx }))
        .filter(({ l }) => l.description.trim().length > 0)
        .map(({ l, idx }) => {
          const qty = Number(l.quantity) || 0;
          const effectiveRate = qty > 0 ? allocated4[idx] / qty / SCALE : 0;
          return {
            itemId: l.itemId ? Number(l.itemId) : null,
            description: l.description.trim() || 'Printing Service / Product',
            quantity: String(l.quantity),
            rate: String(Number(Math.max(0, effectiveRate).toFixed(4))),
            unitCost: String(l.unitCost || 0),
            taxable: !isExempt,
          };
        });
      if (otherChargesValue > 0) {
        payloadLines.push({
          itemId: null,
          description: 'Other charges',
          quantity: '1',
          rate: String(otherChargesValue),
          unitCost: '0',
          taxable: !isExempt,
        });
      }

      const payload: any = {
        customerId: Number(customerId),
        invoiceDate: date,
        dueDate,
        terms,
        taxRate: String(Math.max(0, taxPercent)),
        isTaxExempt: isExempt,
        isSalesReceipt,
        currencyCode: currency,
        exchangeRate: isForeign ? String(fxRate) : '1',
        notes: notes || undefined,
        lines: payloadLines,
        idempotencyKey: idemKeyRef.current,
      };
      if (invoiceNumber.trim()) payload.invoiceNumber = invoiceNumber.trim();
      if (isSalesReceipt) payload.depositToAccountId = Number(bankAccountId);
      if (overLimit && overrideReason.trim()) payload.creditOverrideReason = overrideReason.trim();

      const inv = await commercialApi.createInvoice(payload);

      // Bill each posted desk job against this invoice: relieves its WIP to COGS
      // once and ties that cost to the invoice.
      for (const jobId of postedJobs) {
        try {
          await printingApi.linkJobInvoice(jobId, inv.id);
        } catch (linkErr: any) {
          setError(
            `Invoice ${inv.invoiceNumber} was created but print job #${jobId} could not be linked: ${
              linkErr?.message || 'unknown error'
            }`
          );
        }
      }

      triggerShortcutNotice?.(
        `${isSalesReceipt ? 'Payment recorded' : 'Invoice created'} · ${inv.invoiceNumber} · ${fmt(
          Number(inv.total) || total
        )}`
      );
      idemKeyRef.current = newIdempotencyKey();
      setIsNewInvoiceOpen(false);
    } catch (err: any) {
      const suffix = postedJobs.length
        ? ` Print jobs #${postedJobs.join(', #')} were posted to production WIP and still need billing. The invoice was not created; retry to finish.`
        : '';
      setError((err?.message || 'Invoice creation failed') + suffix);
    } finally {
      setSubmitting(false);
    }
  };

  const saveDisabled = submitting || !canSave;

  return (
    <>
    <ModalShell
      open={isNewInvoiceOpen}
      onClose={close}
      beforeClose={beforeClose}
      size="4xl"
      titleId="invoice-modal-title"
      className="!max-w-[1040px]"
    >
      <ModalHeader
        title="Create Invoice"
        subtitle="Bill a customer for printing products or services"
        icon={<FileText className="h-4.5 w-4.5" />}
        tone="brand"
        titleId="invoice-modal-title"
        onClose={() => {
          void (async () => {
            if (await beforeClose()) close();
          })();
        }}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row">
        {/* Sidebar */}
        <aside className="space-y-5 border-b border-slate-200 bg-slate-50/70 p-5 text-[12.5px] dark:border-white/[0.08] dark:bg-slate-900/50 lg:w-[290px] lg:shrink-0 lg:border-b-0 lg:border-r">
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-brand-600 dark:text-brand-400">
              <span>Customer</span>
              <span className="h-px flex-1 bg-slate-200 dark:bg-white/[0.08]" />
            </div>
            <div>
              <label className="mb-1.5 block text-[11.5px] font-medium text-slate-600 dark:text-slate-300" htmlFor="inv-customer">
                Bill to <span className="text-rose-600 dark:text-rose-400">*</span>
              </label>
              <select
                id="inv-customer"
                value={customerId}
                onChange={e => setCustomerId(e.target.value)}
                className="app-input"
                required
                disabled={loading}
              >
                {customers.length === 0 && <option value="">No customers</option>}
                {customers.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.companyName}
                  </option>
                ))}
              </select>
            </div>
            {selectedCustomer && (
              <div className="surface p-3.5 text-[12px]">
                <div className="font-semibold text-slate-900 dark:text-white">{selectedCustomer.companyName}</div>
                {selectedCustomer.email && (
                  <div className="text-slate-500 dark:text-slate-400">{selectedCustomer.email}</div>
                )}
                <div className="mt-2.5 flex items-center justify-between border-t border-dashed border-slate-200 pt-2 text-slate-500 dark:border-white/[0.08] dark:text-slate-400">
                  <span>Current balance</span>
                  <span className="font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {fmt(selectedCustomer.balance || 0)}
                  </span>
                </div>
                {creditProfile && creditProfile.creditLimit != null && (
                  <div className="mt-1.5 space-y-1 text-[11.5px] text-slate-500 dark:text-slate-400">
                    <div className="flex justify-between">
                      <span>Credit limit</span>
                      <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200">
                        {fmt(creditProfile.creditLimit)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Available</span>
                      <span
                        className={`font-mono tabular-nums ${
                          (creditProfile.availableCredit ?? 0) <= 0
                            ? 'font-semibold text-rose-600 dark:text-rose-400'
                            : 'text-slate-900 dark:text-white'
                        }`}
                      >
                        {creditProfile.availableCredit != null ? fmt(creditProfile.availableCredit) : '—'}
                      </span>
                    </div>
                  </div>
                )}
                {creditLoading && (
                  <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">Checking credit…</div>
                )}
              </div>
            )}
            {customers.length === 0 && !loading && (
              <div className="space-y-1.5">
                <p className="text-[12px] text-slate-500 dark:text-slate-400">Add a customer first.</p>
                <Button variant="secondary" size="sm" onClick={() => setIsNewCustomerOpen(true)}>
                  New customer
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-brand-600 dark:text-brand-400">
              <span>Invoice details</span>
              <span className="h-px flex-1 bg-slate-200 dark:bg-white/[0.08]" />
            </div>
            <div>
              <label className="mb-1.5 block text-[11.5px] font-medium text-slate-600 dark:text-slate-300" htmlFor="inv-number">
                Invoice number
              </label>
              <input
                id="inv-number"
                value={invoiceNumber}
                onChange={e => setInvoiceNumber(e.target.value)}
                placeholder="Auto-generated"
                disabled
                className="app-input font-mono"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11.5px] font-medium text-slate-600 dark:text-slate-300" htmlFor="inv-date">
                Invoice date <span className="text-rose-600 dark:text-rose-400">*</span>
              </label>
              <input
                id="inv-date"
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="app-input font-mono"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1.5 block text-[11.5px] font-medium text-slate-600 dark:text-slate-300" htmlFor="inv-terms">
                  Terms
                </label>
                <select id="inv-terms" value={terms} onChange={e => setTerms(e.target.value)} className="app-input">
                  {TERMS_OPTIONS.map(t => (
                    <option key={t.label} value={t.label}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-[11.5px] font-medium text-slate-600 dark:text-slate-300" htmlFor="inv-due">
                  Due date
                </label>
                <input
                  id="inv-due"
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  className="app-input font-mono"
                />
              </div>
            </div>
            {isForeign && (
              <div>
                <label className="mb-1.5 block text-[11.5px] font-medium text-slate-600 dark:text-slate-300" htmlFor="inv-currency">
                  Currency
                </label>
                <div className="app-input flex items-center justify-between font-mono">
                  <span>{currency}</span>
                  <span className={`text-[11px] ${currencyReady ? 'text-slate-500 dark:text-slate-400' : 'text-rose-600 dark:text-rose-400'}`}>
                    {currencyReady ? `1 ${currency} = ${fxRate} ${baseCurrency}` : 'No rate'}
                  </span>
                </div>
                {!currencyReady && (
                  <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                    No exchange rate for {currency}. Add one in FX settings before saving.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-brand-600 dark:text-brand-400">
              <span>Notes</span>
              <span className="h-px flex-1 bg-slate-200 dark:bg-white/[0.08]" />
            </div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Add a note for the customer…"
              className="app-input !h-auto resize-none py-2"
            />
          </div>
        </aside>

        {/* Line items */}
        <section className="flex flex-col gap-4 p-5 sm:p-6 lg:min-w-0 lg:flex-1">
          <div className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-brand-600 dark:text-brand-400">
            <span>Line items</span>
            <span className="h-px flex-1 bg-slate-200 dark:bg-white/[0.08]" />
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-1.5 pl-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
            <input
              value={assistInput}
              aria-label="AI assist"
              onChange={e => setAssistInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); askAssist(); } }}
              placeholder={'AI assist — e.g. “50 A4 flyers, full colour”'}
              className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
            />
            <Button variant="amber" size="sm" onClick={askAssist} disabled={assistBusy}>
              {assistBusy ? '…' : 'Ask'}
            </Button>
          </div>
          {assistAnswer && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600 whitespace-pre-wrap dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-slate-300">
              {assistAnswer}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setQuickPrintOpen(true)}>
              <Copy className="h-3.5 w-3.5" /> Quick Photocopy / Print
            </Button>
            <Button
              variant={mode === 'ai' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => { setMode(m => (m === 'ai' ? 'manual' : 'ai')); }}
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-500" /> AI Invoice
            </Button>
          </div>

          {mode === 'ai' && (
            <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
              <div className="flex gap-2">
                <input
                  value={aiRequest}
                  aria-label="Describe the invoice"
                  onChange={e => setAiRequest(e.target.value)}
                  placeholder="Describe the invoice (e.g. 500 A4 flyers + 2 reams A4 80gsm)"
                  className="app-input flex-1"
                />
                <Button variant="primary" size="sm" onClick={aiDraft} disabled={aiBusy}>
                  {aiBusy ? 'Working…' : 'AI draft'}
                </Button>
              </div>
              {aiError && <div className="mt-2 text-[11px] text-rose-600 dark:text-rose-400">{aiError}</div>}
              {aiAction && (
                <div className="mt-2.5 space-y-1.5">
                  <div className="text-[11px] font-semibold text-brand-700 dark:text-brand-300">
                    Review the AI draft, then apply it to the form:
                  </div>
                  {aiPreview.map((l, i) => (
                    <div key={i} className="flex justify-between text-[11.5px] text-slate-600 dark:text-slate-300">
                      <span className="truncate">{l.description}</span>
                      <span className="font-mono tabular-nums">{l.quantity} × {fmt(l.rate)}</span>
                    </div>
                  ))}
                  {!aiApplyConfirm ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => (validLineCount > 0 ? setAiApplyConfirm(true) : applyAiDraft('replace'))}
                      disabled={aiBusy}
                    >
                      Apply draft to form
                    </Button>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-[11.5px] text-slate-600 dark:text-slate-300">Existing lines present —</span>
                      <Button variant="danger" size="sm" onClick={() => applyAiDraft('replace')}>Replace</Button>
                      <Button variant="primary" size="sm" onClick={() => applyAiDraft('append')}>Append</Button>
                      <Button variant="secondary" size="sm" onClick={() => setAiApplyConfirm(false)}>Cancel</Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SearchDropdown label="Item" placeholder="Search inventory…" items={itemCatalog} onPick={addItem} formatMoney={fmt} />
            <SearchDropdown label="Services" placeholder="Search services…" items={serviceCatalog} onPick={addItem} formatMoney={fmt} />
          </div>

          <div className="flex items-center gap-2.5 text-[12px] text-slate-500 dark:text-slate-400">
            <span>Units left: <span className="font-mono font-medium text-slate-700 dark:text-slate-200">{unitsLeft == null ? '—' : unitsLeft}</span></span>
            <span className="text-slate-300 dark:text-slate-700">|</span>
            <span className="text-brand-600 dark:text-brand-400">Alt+F2 · Item History</span>
          </div>

          <div className="surface overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-11">SN</th>
                  <th>Description</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Amount</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={line.id}>
                    <td className="font-mono text-slate-500">{idx + 1}</td>
                    <td>
                      <input
                        value={line.description}
                        aria-label={`Description for line ${idx + 1}`}
                        onChange={e => updateLine(line.id, { description: e.target.value })}
                        placeholder="Description"
                        readOnly={!!line.quickPrint}
                        className="w-full rounded border-0 bg-transparent px-1.5 py-1 text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:text-slate-100"
                      />
                    </td>
                    <td className="text-right">
                      <input
                        type="number"
                        min={1}
                        aria-label={`Quantity for line ${idx + 1}`}
                        value={line.quantity}
                        readOnly={!!line.quickPrint}
                        onChange={e => updateLine(line.id, { quantity: Math.max(1, Number(e.target.value) || 1) })}
                        className="w-20 rounded border-0 bg-transparent px-1 py-1 text-right font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:text-slate-100"
                      />
                    </td>
                    <td className="text-right">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`Price for line ${idx + 1}`}
                        value={line.rate}
                        readOnly={!!line.quickPrint}
                        onChange={e => updateLine(line.id, { rate: Math.max(0, Number(e.target.value) || 0) })}
                        className="w-24 rounded border-0 bg-transparent px-1 py-1 text-right font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:text-slate-100"
                      />
                    </td>
                    <td className="text-right font-mono font-medium tabular-nums whitespace-nowrap text-slate-900 dark:text-white">
                      {fmt(line.quantity * line.rate)}
                    </td>
                    <td className="text-center">
                      {lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeLine(line.id)}
                          aria-label={`Remove line ${idx + 1}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {validLineCount === 0 && (
              <div className="border-t border-slate-200/80 px-3 py-3 text-center text-[12px] text-slate-500 dark:border-white/[0.06] dark:text-slate-400">
                Search for an item above, or type a description to add the first line
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-brand-50 px-2.5 py-1 font-mono text-[11.5px] font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                {validLineCount} item{validLineCount === 1 ? '' : 's'}
              </span>
              <span className="rounded-md bg-brand-50 px-2.5 py-1 font-mono text-[11.5px] font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                {totalQty} qty
              </span>
            </div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">
              SUBTOTAL <span className="ml-2 font-mono text-[16px] font-semibold tabular-nums text-slate-900 dark:text-white">{fmt(subtotal)}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-[1fr_320px]">
            <div className="flex flex-col gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={otherChargesEnabled}
                  onChange={e => setOtherChargesEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                />
                Other charges
              </label>
              {otherChargesEnabled && (
                <div className="flex items-center gap-2.5">
                  <label htmlFor="inv-other" className="w-16 text-[12px] text-slate-500 dark:text-slate-400">Amount</label>
                  <input
                    id="inv-other"
                    type="number"
                    min={0}
                    value={otherCharges}
                    onChange={e => setOtherCharges(e.target.value)}
                    placeholder="0.00"
                    className="app-input !w-28 text-right font-mono tabular-nums"
                  />
                </div>
              )}
              <div className="flex items-center gap-2.5">
                <span className="w-16 text-[12px] text-slate-500 dark:text-slate-400">Discount</span>
                <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100/80 p-0.5 dark:border-white/[0.08] dark:bg-white/[0.04]" role="group" aria-label="Discount type">
                  {(['K', '%'] as const).map(m => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={discountMode === m}
                      onClick={() => setDiscountMode(m)}
                      className={`rounded-md px-3 py-1 font-mono text-[12px] font-semibold transition-colors ${
                        discountMode === m
                          ? 'bg-brand-600 text-white'
                          : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <input
                  id="inv-discount"
                  type="number"
                  min={0}
                  aria-label="Discount value"
                  value={discountValue}
                  onChange={e => setDiscountValue(e.target.value)}
                  placeholder="0.00"
                  className="app-input !w-28 text-right font-mono tabular-nums"
                />
              </div>
              <div className="flex items-center gap-2.5">
                <label htmlFor="inv-tax" className="w-16 text-[12px] text-slate-500 dark:text-slate-400">Tax %</label>
                <input
                  id="inv-tax"
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={isExempt ? 0 : taxPercent}
                  disabled
                  readOnly
                  className="app-input !w-28 text-right font-mono tabular-nums"
                />
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {isExempt ? 'Tax exempt' : 'Company tax policy'}
                </span>
              </div>

              {overLimit && (
                <InlineAlert tone="rose" title="Credit limit exceeded">
                  This invoice exceeds the customer&apos;s available credit
                  {creditProfile?.availableCredit != null ? ` of ${fmt(creditProfile.availableCredit)}` : ''}. An override reason is required and the server will verify permission.
                  <div className="mt-2">
                    <label htmlFor="inv-override" className="mb-1 block text-[11.5px] font-medium">Override reason</label>
                    <textarea
                      id="inv-override"
                      value={overrideReason}
                      onChange={e => setOverrideReason(e.target.value)}
                      rows={2}
                      placeholder="Why is this over the limit?"
                      className="app-input !h-auto resize-none py-1.5"
                    />
                  </div>
                </InlineAlert>
              )}
            </div>

            <div className="surface p-4">
              {!isForeign && (
                <>
                  <div className="flex justify-between py-1 text-[12.5px] text-slate-500 dark:text-slate-400">
                    <span>Cost of Sales</span>
                    <span className="font-mono font-medium tabular-nums text-slate-900 dark:text-white">
                      {costKnown ? fmt(cost) : 'Unavailable'}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 text-[12.5px] text-slate-500 dark:text-slate-400">
                    <span>Gross Profit</span>
                    <span className={`font-mono font-medium tabular-nums ${costKnown ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}`}>
                      {costKnown && grossProfit != null ? fmt(grossProfit) : 'Unavailable'}
                    </span>
                  </div>
                  {!costKnown && (
                    <div className="pb-2 pt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                      Cost unavailable for one or more lines; profit is not shown until authoritative costing is known.
                    </div>
                  )}
                </>
              )}
              {isForeign && (
                <div className="pb-2 pt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  Server computes cost and margin for {currency} invoices.
                </div>
              )}
              <div className="flex justify-between py-1 text-[12.5px] text-slate-500 dark:text-slate-400">
                <span>Sales Tax ({isExempt ? 0 : taxPercent}%)</span>
                <span className="font-mono font-medium tabular-nums text-slate-900 dark:text-white">{fmt(taxAmount)}</span>
              </div>
              <div className="mt-3 flex items-end justify-between border-t border-dashed border-slate-200 pt-3 dark:border-white/[0.08]">
                <span className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-brand-600 dark:text-brand-400">TOTAL DUE</span>
                <span className="font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-white">{fmt(total)}</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      {error && (
        <div role="alert" aria-live="assertive" className="border-t border-rose-200 bg-rose-50 px-5 py-2 text-[12px] text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </div>
      )}

      <ModalFooter
        left={
          <span>
            {loading ? 'Loading customers & items…' : selectedCustomer?.companyName || 'No customer selected'}
          </span>
        }
        right={
          <>
            <Button variant="secondary" onClick={beforeClose}>
              Cancel
            </Button>
            <Button
              variant="emerald"
              onClick={() => handleSave(true)}
              disabled={saveDisabled || !bankAccountId}
            >
              Save &amp; Pay
            </Button>
            <Button
              variant="primary"
              onClick={() => handleSave(false)}
              disabled={saveDisabled}
            >
              Save &amp; Finalise
            </Button>
          </>
        }
      />
    </ModalShell>

    <QuickPrintJobModal
      open={isNewInvoiceOpen && quickPrintOpen}
      onClose={() => setQuickPrintOpen(false)}
      onAdd={addQuickPrintJob}
      targetLabel="this invoice"
    />
    </>
  );
};