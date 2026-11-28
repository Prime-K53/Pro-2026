import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { commercialApi, ApiCustomer } from '../../services/commercialApi';
import { accountingApi, ApiAccount } from '../../services/accountingApi';
import { ModalShell } from '../common/ui';
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

  const beforeClose = () => {
    if (!isDirty || submitting) return true;
    return window.confirm('Discard this unsaved invoice?');
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

  const C = {
    ink: '#0f2b2a', mute: '#5d7573', line: '#dfe7e5', teal: '#0f4c4a', teal2: '#14706b',
    tealSoft: '#e3f1ef', amber: '#d99a1c', amberSoft: '#fbf1d9', green: '#0e8a5f', red: '#c0392b', paper: '#fbfaf6',
  };
  const secStyle: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: C.teal2, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 8 };
  const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 500, color: C.mute, marginBottom: 5 };
  const fStyle: React.CSSProperties = { width: '100%', height: 32, border: `1px solid ${C.line}`, borderRadius: 9, background: '#fff', padding: '0 10px', font: 'inherit', color: C.ink, outline: 0 };
  const secLine = <div style={{ flex: 1, height: 1, background: C.line }} />;

  const saveDisabled = submitting || !canSave;

  return (
    <>
    <ModalShell
      open={isNewInvoiceOpen}
      onClose={close}
      beforeClose={beforeClose}
      size="4xl"
      titleId="invoice-modal-title"
      className="inv-modal !max-w-[1040px]"
    >
      <style>{`
        .inv-modal input:focus-visible, .inv-modal select:focus-visible, .inv-modal textarea:focus-visible { border-color: ${C.teal2} !important; box-shadow: 0 0 0 3px ${C.tealSoft} !important; }
        .inv-modal .inv-btn:active:not(:disabled) { transform: translateY(1px); }
        .inv-modal .inv-btn:disabled { cursor: not-allowed; }
        .dark .inv-modal .inv-sidebar { background: #0e2425 !important; border-color: #1f3b3c !important; color: #cbd5e1; }
        .dark .inv-modal .inv-paper { background: #0e2425 !important; border-color: #1f3b3c !important; color: #cbd5e1; }
        .dark .inv-modal .inv-table { background: #0e2425 !important; border-color: #1f3b3c !important; }
        .dark .inv-modal .inv-footer { background: #0e2425 !important; border-color: #1f3b3c !important; color: #cbd5e1; }
        .dark .inv-modal .inv-table th { background: #132e30 !important; border-color: #1f3b3c !important; color: #94a3b8 !important; }
        .dark .inv-modal .inv-table td { border-color: #1f3b3c !important; color: #e2e8f0 !important; }
        .dark .inv-modal .inv-table input { color: #e2e8f0 !important; }
        .dark .inv-modal .inv-table input::placeholder { color: #64748b !important; }
        .dark .inv-modal .inv-sidebar input, .dark .inv-modal .inv-sidebar select, .dark .inv-modal .inv-sidebar textarea { background: #132e30 !important; border-color: #2b4a4b !important; color: #e2e8f0 !important; }
        .dark .inv-modal .inv-sidebar label, .dark .inv-modal .inv-sidebar p, .dark .inv-modal .inv-sidebar span, .dark .inv-modal .inv-sidebar b, .dark .inv-modal .inv-sidebar em { color: inherit; }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 22px', color: '#fff', background: 'linear-gradient(120deg,#0f4c4a,#14706b)', position: 'relative' }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(255,255,255,.14)', display: 'grid', placeItems: 'center', border: '1px solid rgba(255,255,255,.25)', fontSize: 18 }}>
          🧾
        </div>
        <div className="min-w-0">
          <h1 id="invoice-modal-title" style={{ font: "400 22px 'DM Serif Display', serif", margin: 0, letterSpacing: '.2px' }}>
            Create Invoice
          </h1>
          <p style={{ margin: '1px 0 0', fontSize: 12, opacity: 0.8 }}>
            Bill a customer for printing products or services
          </p>
        </div>
        <button
          type="button"
          onClick={beforeClose}
          aria-label="Close"
          style={{ marginLeft: 'auto', width: 32, height: 32, borderRadius: 9, border: 0, background: 'rgba(255,255,255,.12)', color: '#fff', cursor: 'pointer', fontSize: 18 }}
        >
          ×
        </button>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: 'linear-gradient(90deg,#d99a1c,transparent 70%)' }} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row">
        {/* Sidebar */}
        <aside className="inv-sidebar p-5 lg:w-[290px] lg:shrink-0 lg:border-r lg:border-dashed" style={{ background: C.paper, borderColor: C.line, fontSize: 12.5 }}>
          <div style={{ marginBottom: 20 }}>
            <p style={secStyle}>Customer {secLine}</p>
            <label style={labelStyle} htmlFor="inv-customer">
              Bill to <i style={{ color: C.red, fontStyle: 'normal' }}>*</i>
            </label>
            <select id="inv-customer" value={customerId} onChange={e => setCustomerId(e.target.value)} style={fStyle} required disabled={loading}>
              {customers.length === 0 && <option value="">No customers</option>}
              {customers.map(c => (
                <option key={c.id} value={c.id}>
                  {c.companyName}
                </option>
              ))}
            </select>
            {selectedCustomer && (
              <div style={{ marginTop: 10, padding: '12px 14px', borderRadius: 12, background: '#fff', border: `1px solid ${C.line}`, borderLeft: `3px solid ${C.amber}` }}>
                <b style={{ display: 'block', fontWeight: 600 }}>{selectedCustomer.companyName}</b>
                {selectedCustomer.email && <span style={{ color: C.mute, fontSize: 12 }}>{selectedCustomer.email}</span>}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${C.line}`, fontSize: 12, color: C.mute }}>
                  Current balance
                  <em style={{ fontStyle: 'normal', color: C.green, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>
                    {fmt(selectedCustomer.balance || 0)}
                  </em>
                </div>
                {creditProfile && creditProfile.creditLimit != null && (
                  <div style={{ marginTop: 6, fontSize: 11.5, color: C.mute }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Credit limit</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{fmt(creditProfile.creditLimit)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Available</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", color: (creditProfile.availableCredit ?? 0) <= 0 ? C.red : C.ink }}>
                        {creditProfile.availableCredit != null ? fmt(creditProfile.availableCredit) : '—'}
                      </span>
                    </div>
                  </div>
                )}
                {creditLoading && <div style={{ marginTop: 6, fontSize: 11, color: C.mute }}>Checking credit…</div>}
              </div>
            )}
            {customers.length === 0 && !loading && (
              <div style={{ marginTop: 10 }}>
                <p style={{ fontSize: 12, color: C.mute, marginBottom: 6 }}>Add a customer first.</p>
                <button type="button" className="inv-btn" onClick={() => setIsNewCustomerOpen(true)} style={{ height: 32, padding: '0 12px', borderRadius: 11, border: `1px solid ${C.line}`, background: '#fff', color: C.ink, cursor: 'pointer', fontSize: 12.5 }}>
                  New customer
                </button>
              </div>
            )}
          </div>

          <div style={{ marginBottom: 20 }}>
            <p style={secStyle}>Invoice details {secLine}</p>
            <label style={labelStyle} htmlFor="inv-number">Invoice number</label>
            <input id="inv-number" value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} placeholder="Auto-generated" disabled style={{ ...fStyle, fontFamily: "'JetBrains Mono', monospace" }} />
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle} htmlFor="inv-date">
                Invoice date <i style={{ color: C.red, fontStyle: 'normal' }}>*</i>
              </label>
              <input id="inv-date" type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...fStyle, fontFamily: "'JetBrains Mono', monospace" }} required />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
              <div>
                <label style={labelStyle} htmlFor="inv-terms">Terms</label>
                <select id="inv-terms" value={terms} onChange={e => setTerms(e.target.value)} style={fStyle}>
                  {TERMS_OPTIONS.map(t => (
                    <option key={t.label} value={t.label}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle} htmlFor="inv-due">Due date</label>
                <input id="inv-due" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={{ ...fStyle, fontFamily: "'JetBrains Mono', monospace", padding: '0 8px' }} />
              </div>
            </div>
            {isForeign && (
              <div style={{ marginTop: 12 }}>
                <label style={labelStyle} htmlFor="inv-currency">Currency</label>
                <div style={{ ...fStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: "'JetBrains Mono', monospace" }}>
                  <span>{currency}</span>
                  <span style={{ fontSize: 11, color: currencyReady ? C.mute : C.red }}>
                    {currencyReady ? `1 ${currency} = ${fxRate} ${baseCurrency}` : 'No rate'}
                  </span>
                </div>
                {!currencyReady && (
                  <p style={{ fontSize: 11, color: C.red, marginTop: 4 }}>
                    No exchange rate for {currency}. Add one in FX settings before saving.
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <p style={secStyle}>Notes {secLine}</p>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Add a note for the customer…" style={{ ...fStyle, height: 56, padding: '6px 10px', resize: 'none' }} />
          </div>
        </aside>

        {/* Line items */}
        <section className="lg:min-w-0 lg:flex-1" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ ...secStyle, marginBottom: -4 }}>Line items {secLine}</p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px 6px 12px', borderRadius: 12, border: `1px solid ${C.amber}`, background: `linear-gradient(90deg,${C.amberSoft},${C.tealSoft})` }}>
            <Sparkles className="h-4 w-4" style={{ color: C.amber }} />
            <input
              value={assistInput}
              aria-label="AI assist"
              onChange={e => setAssistInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); askAssist(); } }}
              placeholder={'AI assist — e.g. “50 A4 flyers, full colour”'}
              style={{ flex: 1, border: 0, background: 'transparent', font: '12.5px Inter', color: C.ink, outline: 0 }}
            />
            <button
              type="button"
              className="inv-btn"
              onClick={askAssist}
              disabled={assistBusy}
              style={{ height: 30, padding: '0 12px', borderRadius: 11, border: '1px solid #b9810f', background: 'linear-gradient(180deg,#f1c35a,#d99a1c)', color: '#2d1f00', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}
            >
              {assistBusy ? '…' : 'Ask'}
            </button>
          </div>
          {assistAnswer && (
            <div style={{ fontSize: 12, color: C.mute, whiteSpace: 'pre-wrap' }}>{assistAnswer}</div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setQuickPrintOpen(true)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 13px', borderRadius: 999, border: `1px solid ${C.line}`, background: '#fff', font: '500 12.5px Inter', color: C.ink, cursor: 'pointer' }}
            >
              <Copy className="h-3.5 w-3.5" /> Quick Photocopy / Print
            </button>
            <button
              type="button"
              onClick={() => { setMode(m => (m === 'ai' ? 'manual' : 'ai')); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 13px', borderRadius: 999, border: `1px solid ${C.amber}`, background: `linear-gradient(120deg,${C.amberSoft},${C.tealSoft})`, font: '500 12.5px Inter', color: C.ink, cursor: 'pointer' }}
            >
              <Sparkles className="h-3.5 w-3.5" style={{ color: C.amber }} /> AI Invoice
            </button>
          </div>

          {mode === 'ai' && (
            <div style={{ borderRadius: 12, border: `1px solid ${C.amber}`, background: C.amberSoft, padding: 12 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={aiRequest}
                  aria-label="Describe the invoice"
                  onChange={e => setAiRequest(e.target.value)}
                  placeholder="Describe the invoice (e.g. 500 A4 flyers + 2 reams A4 80gsm)"
                  style={{ ...fStyle, flex: 1 }}
                />
                <button type="button" className="inv-btn" onClick={aiDraft} disabled={aiBusy} style={{ height: 32, padding: '0 14px', borderRadius: 11, border: `1px solid ${C.teal}`, background: `linear-gradient(180deg,${C.teal2},${C.teal})`, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                  {aiBusy ? 'Working…' : 'AI draft'}
                </button>
              </div>
              {aiError && <div style={{ marginTop: 8, fontSize: 11, color: C.red }}>{aiError}</div>}
              {aiAction && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.teal2, marginBottom: 4 }}>
                    Review the AI draft, then apply it to the form:
                  </div>
                  {aiPreview.map((l, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: C.mute }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{l.quantity} × {fmt(l.rate)}</span>
                    </div>
                  ))}
                  {!aiApplyConfirm ? (
                    <button type="button" className="inv-btn" onClick={() => (validLineCount > 0 ? setAiApplyConfirm(true) : applyAiDraft('replace'))} disabled={aiBusy} style={{ marginTop: 6, height: 34, padding: '0 14px', borderRadius: 11, border: `1px solid ${C.teal}`, background: `linear-gradient(180deg,${C.teal2},${C.teal})`, color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                      Apply draft to form
                    </button>
                  ) : (
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11.5, color: C.mute, alignSelf: 'center' }}>Existing lines present —</span>
                      <button type="button" className="inv-btn" onClick={() => applyAiDraft('replace')} style={{ height: 30, padding: '0 12px', borderRadius: 11, border: `1px solid ${C.red}`, background: '#fff', color: C.red, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Replace</button>
                      <button type="button" className="inv-btn" onClick={() => applyAiDraft('append')} style={{ height: 30, padding: '0 12px', borderRadius: 11, border: `1px solid ${C.teal}`, background: '#fff', color: C.teal, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Append</button>
                      <button type="button" className="inv-btn" onClick={() => setAiApplyConfirm(false)} style={{ height: 30, padding: '0 12px', borderRadius: 11, border: `1px solid ${C.line}`, background: '#fff', color: C.ink, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <SearchDropdown label="Item" placeholder="Search inventory…" items={itemCatalog} onPick={addItem} formatMoney={fmt} />
            <SearchDropdown label="Services" placeholder="Search services…" items={serviceCatalog} onPick={addItem} formatMoney={fmt} />
          </div>

          <div style={{ fontSize: 12, color: C.mute, display: 'flex', gap: 10, alignItems: 'center', marginTop: -6 }}>
            <span>Units left: <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{unitsLeft == null ? '—' : unitsLeft}</span></span>
            <span style={{ color: C.line }}>|</span>
            <span style={{ color: C.teal2 }}>Alt+F2 · Item History</span>
          </div>

          <div className="inv-table" style={{ border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 600, color: C.mute, textAlign: 'left', padding: '10px 12px', background: C.paper, borderBottom: `1px solid ${C.line}` }}>SN</th>
                  <th style={{ fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 600, color: C.mute, textAlign: 'left', padding: '10px 12px', background: C.paper, borderBottom: `1px solid ${C.line}` }}>Description</th>
                  <th style={{ fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 600, color: C.mute, textAlign: 'right', padding: '10px 12px', background: C.paper, borderBottom: `1px solid ${C.line}` }}>Qty</th>
                  <th style={{ fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 600, color: C.mute, textAlign: 'right', padding: '10px 12px', background: C.paper, borderBottom: `1px solid ${C.line}` }}>Price</th>
                  <th style={{ fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 600, color: C.mute, textAlign: 'right', padding: '10px 12px', background: C.paper, borderBottom: `1px solid ${C.line}` }}>Amount</th>
                  <th style={{ padding: '10px 12px', background: C.paper, borderBottom: `1px solid ${C.line}` }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={line.id}>
                    <td style={{ padding: '6px 12px', borderBottom: `1px dashed ${C.line}`, color: C.mute, width: 44, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{idx + 1}</td>
                    <td style={{ padding: '6px 12px', borderBottom: `1px dashed ${C.line}` }}>
                      <input
                        value={line.description}
                        aria-label={`Description for line ${idx + 1}`}
                        onChange={e => updateLine(line.id, { description: e.target.value })}
                        placeholder="Description"
                        readOnly={!!line.quickPrint}
                        style={{ width: '100%', border: 0, background: 'transparent', font: 'inherit', color: C.ink, outline: 0, padding: '4px 6px', borderRadius: 7 }}
                      />
                    </td>
                    <td style={{ padding: '6px 12px', borderBottom: `1px dashed ${C.line}`, textAlign: 'right' }}>
                      <input
                        type="number"
                        min={1}
                        aria-label={`Quantity for line ${idx + 1}`}
                        value={line.quantity}
                        readOnly={!!line.quickPrint}
                        onChange={e => updateLine(line.id, { quantity: Math.max(1, Number(e.target.value) || 1) })}
                        style={{ width: 80, border: 0, background: 'transparent', font: "13px 'JetBrains Mono', monospace", color: C.ink, outline: 0, textAlign: 'right' }}
                      />
                    </td>
                    <td style={{ padding: '6px 12px', borderBottom: `1px dashed ${C.line}`, textAlign: 'right' }}>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`Price for line ${idx + 1}`}
                        value={line.rate}
                        readOnly={!!line.quickPrint}
                        onChange={e => updateLine(line.id, { rate: Math.max(0, Number(e.target.value) || 0) })}
                        style={{ width: 80, border: 0, background: 'transparent', font: "13px 'JetBrains Mono', monospace", color: C.ink, outline: 0, textAlign: 'right' }}
                      />
                    </td>
                    <td style={{ padding: '6px 12px', borderBottom: `1px dashed ${C.line}`, font: "500 13px 'JetBrains Mono', monospace", textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {fmt(line.quantity * line.rate)}
                    </td>
                    <td style={{ padding: '6px 12px', borderBottom: `1px dashed ${C.line}`, textAlign: 'center' }}>
                      {lines.length > 1 && (
                        <button type="button" onClick={() => removeLine(line.id)} aria-label={`Remove line ${idx + 1}`} style={{ border: 0, background: 'none', color: C.mute, cursor: 'pointer', fontSize: 16, borderRadius: 6 }}>×</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {validLineCount === 0 && (
              <div style={{ padding: 12, textAlign: 'center', color: C.mute, fontSize: 12, background: `repeating-linear-gradient(0deg,transparent 0 23px,${C.line} 23px 24px)` }}>
                Search for an item above, or type a description to add the first line
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ font: "500 11.5px 'JetBrains Mono', monospace", background: C.tealSoft, color: C.teal2, padding: '3px 9px', borderRadius: 7, marginRight: 6 }}>{validLineCount} item{validLineCount === 1 ? '' : 's'}</span>
              <span style={{ font: "500 11.5px 'JetBrains Mono', monospace", background: C.tealSoft, color: C.teal2, padding: '3px 9px', borderRadius: 7 }}>{totalQty} qty</span>
            </div>
            <div style={{ fontSize: 11, letterSpacing: '.1em', color: C.mute, fontWeight: 600 }}>
              SUBTOTAL <b style={{ font: "600 17px 'JetBrains Mono', monospace", color: C.ink, marginLeft: 8 }}>{fmt(subtotal)}</b>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 330px', gap: 22, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13, color: C.ink }}>
                <input type="checkbox" checked={otherChargesEnabled} onChange={e => setOtherChargesEnabled(e.target.checked)} style={{ accentColor: C.teal2, width: 16, height: 16 }} />
                Other charges
              </label>
              {otherChargesEnabled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label htmlFor="inv-other" style={{ width: 64, color: C.mute, fontSize: 12.5 }}>Amount</label>
                  <input id="inv-other" type="number" min={0} value={otherCharges} onChange={e => setOtherCharges(e.target.value)} placeholder="0.00" style={{ ...fStyle, width: 104, height: 30, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }} />
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 64, color: C.mute, fontSize: 12.5 }}>Discount</span>
                <div style={{ display: 'inline-flex', padding: 3, borderRadius: 10, background: C.tealSoft }} role="group" aria-label="Discount type">
                  {(['K', '%'] as const).map(m => (
                    <button key={m} type="button" aria-pressed={discountMode === m} onClick={() => setDiscountMode(m)} style={{ border: 0, background: discountMode === m ? C.teal2 : 'transparent', padding: '6px 14px', borderRadius: 8, font: "600 12.5px 'JetBrains Mono', monospace", color: discountMode === m ? '#fff' : C.mute, cursor: 'pointer' }}>
                      {m}
                    </button>
                  ))}
                </div>
                <input id="inv-discount" type="number" min={0} aria-label="Discount value" value={discountValue} onChange={e => setDiscountValue(e.target.value)} placeholder="0.00" style={{ ...fStyle, width: 104, height: 30, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label htmlFor="inv-tax" style={{ width: 64, color: C.mute, fontSize: 12.5 }}>Tax %</label>
                <input id="inv-tax" type="number" min={0} max={100} step={0.5} value={isExempt ? 0 : taxPercent} disabled readOnly style={{ ...fStyle, width: 104, height: 30, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", background: '#f8fafc', color: C.mute }} />
                <span style={{ fontSize: 11, color: C.mute }}>{isExempt ? 'Tax exempt' : 'Company tax policy'}</span>
              </div>

              {overLimit && (
                <div role="alert" style={{ padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.red}`, background: '#fdecea', color: C.red, fontSize: 12 }}>
                  This invoice exceeds the customer&apos;s available credit
                  {creditProfile?.availableCredit != null ? ` of ${fmt(creditProfile.availableCredit)}` : ''}. An override reason is required and the server will verify permission.
                  <div style={{ marginTop: 8 }}>
                    <label htmlFor="inv-override" style={{ display: 'block', fontSize: 11.5, marginBottom: 4 }}>Override reason</label>
                    <textarea id="inv-override" value={overrideReason} onChange={e => setOverrideReason(e.target.value)} rows={2} placeholder="Why is this over the limit?" style={{ ...fStyle, height: 44, padding: '6px 8px', resize: 'none' }} />
                  </div>
                </div>
              )}
            </div>

            <div className="inv-paper" style={{ position: 'relative', background: C.paper, border: `1px solid ${C.line}`, borderRadius: 14, padding: '16px 18px 18px' }}>
              {!isForeign && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: C.mute, fontSize: 12.5 }}>
                    <span>Cost of Sales</span>
                    <span style={{ font: "500 12.5px 'JetBrains Mono', monospace", color: costKnown ? C.ink : C.mute }}>
                      {costKnown ? fmt(cost) : 'Unavailable'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: C.mute, fontSize: 12.5 }}>
                    <span>Gross Profit</span>
                    <span style={{ font: "500 12.5px 'JetBrains Mono', monospace", color: costKnown ? C.green : C.mute }}>
                      {costKnown && grossProfit != null ? fmt(grossProfit) : 'Unavailable'}
                    </span>
                  </div>
                  {!costKnown && (
                    <div style={{ fontSize: 11.5, color: C.mute, padding: '2px 0 8px' }}>
                      Cost unavailable for one or more lines; profit is not shown until authoritative costing is known.
                    </div>
                  )}
                </>
              )}
              {isForeign && (
                <div style={{ fontSize: 11.5, color: C.mute, padding: '2px 0 8px' }}>
                  Server computes cost and margin for {currency} invoices.
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: C.mute, fontSize: 12.5 }}>
                <span>Sales Tax ({isExempt ? 0 : taxPercent}%)</span>
                <span style={{ font: "500 12.5px 'JetBrains Mono', monospace", color: C.ink }}>{fmt(taxAmount)}</span>
              </div>
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: `2px dashed ${C.line}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <small style={{ fontSize: 10.5, letterSpacing: '.14em', fontWeight: 600, color: C.teal2 }}>TOTAL DUE</small>
                <strong style={{ font: "400 28px/1 'DM Serif Display', serif", color: C.teal, fontVariantNumeric: 'tabular-nums' }}>{fmt(total)}</strong>
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

      {/* Footer */}
      <footer className="inv-footer" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 22px', borderTop: `1px solid ${C.line}`, background: '#fff' }}>
        <span style={{ marginRight: 'auto', color: C.mute, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <i style={{ width: 8, height: 8, borderRadius: '50%', background: C.amber, display: 'inline-block' }} />
          {loading ? 'Loading customers & items…' : selectedCustomer?.companyName || 'No customer selected'}
        </span>
        <button type="button" className="inv-btn" onClick={beforeClose} style={{ height: 38, padding: '0 14px', borderRadius: 11, font: '600 12.5px Inter', cursor: 'pointer', border: `1px solid ${C.line}`, background: '#fff', color: C.ink }}>
          Cancel
        </button>
        <button
          type="button"
          className="inv-btn"
          onClick={() => handleSave(true)}
          disabled={saveDisabled || !bankAccountId}
          style={{ height: 38, padding: '0 14px', borderRadius: 11, font: '600 12.5px Inter', cursor: 'pointer', border: '1px solid #b9810f', background: 'linear-gradient(180deg,#f1c35a,#d99a1c)', color: '#2d1f00', boxShadow: '0 2px 0 #b9810f', opacity: saveDisabled || !bankAccountId ? 0.45 : 1 }}
        >
          Save &amp; Pay
        </button>
        <button
          type="button"
          className="inv-btn"
          onClick={() => handleSave(false)}
          disabled={saveDisabled}
          style={{ height: 38, padding: '0 14px', borderRadius: 11, font: '600 12.5px Inter', cursor: 'pointer', border: `1px solid ${C.teal}`, background: `linear-gradient(180deg,${C.teal2},${C.teal})`, color: '#fff', boxShadow: '0 2px 0 rgba(0,0,0,.25)', opacity: saveDisabled ? 0.45 : 1 }}
        >
          Save &amp; Finalise
        </button>
      </footer>
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