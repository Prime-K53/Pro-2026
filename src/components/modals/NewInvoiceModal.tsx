import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { commercialApi, ApiCustomer } from '../../services/commercialApi';
import { accountingApi, ApiAccount } from '../../services/accountingApi';
import { ModalShell } from '../common/ui';
import { X, Trash2, Receipt, Sparkles, Printer, Copy } from 'lucide-react';
import { printingApi } from '../../services/printingApi';
import { QuickPrintJobModal, type QuickPrintJobDraft } from './QuickPrintJobModal';

type Line = {
  id: string;
  itemId: string;
  description: string;
  quantity: number;
  rate: number;
  unitCost: number;
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
  unitCost: number;
  itemType: string;
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
  const { isNewInvoiceOpen, setIsNewInvoiceOpen, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const fmt = (n: number) => formatCurrency(Number.isFinite(n) ? n : 0, currency);

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

  const [lines, setLines] = useState<Line[]>([
    { id: 'l-1', itemId: '', description: '', quantity: 1, rate: 0, unitCost: 0 },
  ]);
  const [lastAdded, setLastAdded] = useState<SearchItem | null>(null);

  const [quickPrintOpen, setQuickPrintOpen] = useState(false);

  const [discountMode, setDiscountMode] = useState<'K' | '%'>('K');
  const [discountValue, setDiscountValue] = useState('');
  const [otherChargesEnabled, setOtherChargesEnabled] = useState(false);
  const [otherCharges, setOtherCharges] = useState('');
  const [taxPercent, setTaxPercent] = useState(0);
  const [bankAccountId, setBankAccountId] = useState<string>('');

  const catalog: SearchItem[] = useMemo(
    () =>
      items.map(i => ({
        id: String(i.id),
        name: i.name || i.sku || 'Item',
        price: Number(i.sales_price ?? i.salesPrice ?? 0),
        onHand:
          i.on_hand != null ? Number(i.on_hand) : i.onHand != null ? Number(i.onHand) : null,
        unitCost: Number(i.unit_cost ?? i.unitCost ?? i.cost ?? 0),
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

  useEffect(() => {
    if (!isNewInvoiceOpen) return;
    // Reset the form each time the modal opens.
    setLines([{ id: 'l-1', itemId: '', description: '', quantity: 1, rate: 0, unitCost: 0 }]);
    setInvoiceNumber('');
    setNotes('');
    setDiscountMode('K');
    setDiscountValue('');
    setOtherChargesEnabled(false);
    setOtherCharges('');
    setLastAdded(null);
    setError(null);
    setDate(new Date().toISOString().slice(0, 10));
    setLoading(true);
    Promise.all([
      commercialApi.listCustomers().catch(() => [] as ApiCustomer[]),
      commercialApi.listInventory().catch(() => [] as any[]),
      accountingApi.listAccounts(true).catch(() => [] as ApiAccount[]),
    ])
      .then(([custs, its, accts]) => {
        setCustomers(custs);
        setItems(its);
        setCustomerId(prev => prev || (custs[0] ? String(custs[0].id) : ''));
        const banks = accts.filter(a => a.account_type === 'Bank' && a.is_active);
        setBankAccountId(prev => prev || (banks[0] ? String(banks[0].id) : ''));
        setTaxPercent(Math.round((companyProfile.salesTaxRate || 0) * 1000) / 10);
        setLoading(false);
      })
      .catch(err => {
        setError(err?.message || 'Failed to load data');
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewInvoiceOpen]);

  if (!isNewInvoiceOpen) return null;

  const close = () => setIsNewInvoiceOpen(false);
  const selectedCustomer = customers.find(c => String(c.id) === customerId);

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

  const addCustomLine = (description: string, rate = 0) => {
    setLines(prev => [
      ...prev,
      {
        id: `l-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        itemId: '',
        description,
        quantity: 1,
        rate,
        unitCost: 0,
      },
    ]);
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

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.rate, 0);
  const cost = lines.reduce((s, l) => s + l.quantity * (l.unitCost || 0), 0);
  const discountAmount = (() => {
    const raw = Number(discountValue) || 0;
    if (raw <= 0) return 0;
    const amount = discountMode === '%' ? (subtotal * raw) / 100 : raw;
    return Math.min(subtotal, Math.max(0, amount));
  })();
  const otherChargesValue = otherChargesEnabled ? Math.max(0, Number(otherCharges) || 0) : 0;
  const net = subtotal - discountAmount + otherChargesValue;
  const taxRate = Math.max(0, taxPercent) / 100;
  const taxAmount = Math.max(0, net) * taxRate;
  const total = Math.max(0, net) + taxAmount;
  const grossProfit = net - cost;

  const totalQty = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  const validLineCount = lines.filter(l => l.description.trim().length > 0).length;
  const unitsLeft = (() => {
    if (!lastAdded || lastAdded.onHand == null) return null;
    const inCart = lines
      .filter(l => l.itemId === lastAdded.id)
      .reduce((s, l) => s + l.quantity, 0);
    return Math.max(0, lastAdded.onHand - inCart);
  })();

  const handleSave = async (isSalesReceipt: boolean) => {
    if (!customerId || validLineCount === 0) return;
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
      // losing their stock movement.
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
        .filter(l => l.description.trim().length > 0)
        .map(l => ({
          itemId: l.itemId ? Number(l.itemId) : null,
          description: l.description.trim() || 'Printing Service / Product',
          quantity: String(l.quantity),
          rate: String(Number((l.rate * (1 - discountFraction)).toFixed(4))),
          unitCost: String(l.unitCost || 0),
          taxable: true,
        }));
      if (otherChargesValue > 0) {
        payloadLines.push({
          itemId: null,
          description: 'Other charges',
          quantity: '1',
          rate: String(otherChargesValue),
          unitCost: '0',
          taxable: true,
        });
      }

      const payload: any = {
        customerId: Number(customerId),
        invoiceDate: date,
        dueDate,
        terms,
        taxRate: String(Math.max(0, taxPercent)),
        isSalesReceipt,
        notes: notes || undefined,
        lines: payloadLines,
      };
      if (invoiceNumber.trim()) payload.invoiceNumber = invoiceNumber.trim();
      if (isSalesReceipt) payload.depositToAccountId = Number(bankAccountId);

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
        `${isSalesReceipt ? 'Payment recorded' : 'Invoice created'} · ${inv.invoiceNumber} · ${fmt(total)}`
      );
      setIsNewInvoiceOpen(false);
    } catch (err: any) {
      const suffix = postedJobs.length
        ? ` Print jobs #${postedJobs.join(', #')} were posted to production WIP and still need billing.`
        : '';
      setError((err?.message || 'Invoice creation failed') + suffix);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    {/* Quick print capture lives beside the invoice so its overlay stacks above it. */}
    <ModalShell
      open={isNewInvoiceOpen}
      onClose={close}
      size="4xl"
      titleId="invoice-modal-title"
      className="!max-w-[1040px]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 bg-gradient-to-r from-brand-800 via-brand-600 to-brand-500 px-5 py-3 text-white">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/15 text-lg ring-1 ring-inset ring-white/20">
          🧾
        </span>
        <div className="min-w-0">
          <div id="invoice-modal-title" className="text-[14.5px] font-semibold leading-tight">
            Create Invoice
          </div>
          <div className="text-[11.5px] text-white/80">
            Bill a customer for printing products or services
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          className="ml-auto rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        {/* Sidebar */}
        <aside className="w-full shrink-0 overflow-auto border-b border-slate-200 bg-slate-50/80 p-5 dark:border-white/[0.06] dark:bg-white/[0.02] md:w-[270px] md:border-b-0 md:border-r">
          <div className="mb-4 border-b border-slate-200 pb-4 dark:border-white/[0.06]">
            <p className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Customer
            </p>
            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Bill to <span className="text-rose-500">*</span>
            </label>
            <select
              value={customerId}
              onChange={e => setCustomerId(e.target.value)}
              className="app-input !py-2"
              required
            >
              {customers.length === 0 && <option value="">No customers</option>}
              {customers.map(c => (
                <option key={c.id} value={c.id}>
                  {c.companyName}
                </option>
              ))}
            </select>
            {selectedCustomer && (
              <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2.5 text-[12px] dark:border-white/10 dark:bg-white/[0.03]">
                <div className="font-semibold text-slate-700 dark:text-slate-200">
                  {selectedCustomer.companyName}
                </div>
                {selectedCustomer.email && (
                  <div className="text-slate-500 dark:text-slate-400">{selectedCustomer.email}</div>
                )}
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-slate-500 dark:text-slate-400">Current balance</span>
                  <span
                    className={`font-mono font-semibold ${
                      (selectedCustomer.balance || 0) > 0
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-emerald-600 dark:text-emerald-400'
                    }`}
                  >
                    {fmt(selectedCustomer.balance || 0)}
                    {(selectedCustomer.balance || 0) > 0 ? ' owing' : ''}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="mb-4 border-b border-slate-200 pb-4 dark:border-white/[0.06]">
            <p className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Invoice details
            </p>
            <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
              Invoice number
            </label>
            <input
              value={invoiceNumber}
              onChange={e => setInvoiceNumber(e.target.value)}
              placeholder="Auto-generated"
              className="app-input app-input-mono !py-2"
            />
            <label className="mb-1 mt-2.5 block text-[12px] text-slate-500 dark:text-slate-400">
              Invoice date <span className="text-rose-500">*</span>
            </label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="app-input !py-2"
              required
            />
            <div className="mt-2.5 grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
                  Terms
                </label>
                <select
                  value={terms}
                  onChange={e => setTerms(e.target.value)}
                  className="app-input !px-2 !py-2 !text-[12px]"
                >
                  {TERMS_OPTIONS.map(t => (
                    <option key={t.label} value={t.label}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[12px] text-slate-500 dark:text-slate-400">
                  Due date
                </label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  className="app-input !px-2 !py-2 !text-[12px]"
                />
              </div>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Notes
            </p>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={4}
              placeholder="Internal notes, PO number, delivery instructions…"
              className="app-input resize-none !text-[12px]"
            />
          </div>
        </aside>

        {/* Line items */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-5">
          <p className="mb-2 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Line items
          </p>

          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setQuickPrintOpen(true)}
              className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1 text-[12px] font-medium text-slate-700 transition-colors hover:border-brand-400 hover:text-brand-600 dark:border-white/10 dark:text-slate-200"
            >
              <Copy className="h-3 w-3" /> Quick Photocopy / Print
            </button>
            <button
              type="button"
              onClick={() =>
                triggerShortcutNotice?.('AI Invoice: describe the job and lines are drafted here')
              }
              className="flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-1 text-[12px] font-medium text-brand-700 transition-colors hover:border-brand-400 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300"
            >
              <Sparkles className="h-3 w-3" /> AI Invoice
            </button>
          </div>

          <div className="mb-2 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <SearchDropdown
              label="Item"
              placeholder="Search inventory…"
              items={itemCatalog}
              onPick={addItem}
              formatMoney={fmt}
            />
            <SearchDropdown
              label="Services"
              placeholder="Search services…"
              items={serviceCatalog}
              onPick={addItem}
              formatMoney={fmt}
            />
          </div>

          <div className="mb-2 flex items-center gap-2 text-[12px] text-slate-500 dark:text-slate-400">
            <span>
              Units left:{' '}
              <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                {unitsLeft == null ? '—' : unitsLeft}
              </span>
            </span>
            <span className="text-slate-300 dark:text-slate-600">|</span>
            <span className="text-brand-600 dark:text-brand-400">Alt+F2: Item History</span>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-white/10">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-300 text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:border-white/20 dark:text-slate-400">
                  <th className="w-10 px-2 py-2 text-left">SN</th>
                  <th className="px-2 py-2 text-left">Description</th>
                  <th className="w-20 px-2 py-2 text-right">Qty</th>
                  <th className="w-24 px-2 py-2 text-right">Price</th>
                  <th className="w-28 px-2 py-2 text-right">Amount</th>
                  <th className="w-8 px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05]">
                {lines.map((line, idx) => (
                  <tr key={line.id} className="group">
                    <td className="px-2 py-1.5 font-mono text-[12px] text-slate-500 dark:text-slate-400">
                      {idx + 1}
                    </td>
                    <td className="px-2 py-1.5">
                      {line.quickPrint ? (
                        <div className="flex items-center gap-1.5">
                          <Copy className="h-3 w-3 shrink-0 text-brand-500" />
                          <span className="truncate text-[13px] text-slate-800 dark:text-slate-100">
                            {line.description}
                          </span>
                        </div>
                      ) : (
                        <input
                          value={line.description}
                          onChange={e => updateLine(line.id, { description: e.target.value })}
                          placeholder="Description"
                          className="w-full rounded border-0 border-b border-transparent bg-transparent px-0 py-1 text-[13px] text-slate-800 outline-none placeholder:text-slate-400 hover:border-slate-200 focus:border-brand-500 dark:text-slate-100"
                        />
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {line.quickPrint ? (
                        <div className="text-right font-mono text-[13px] text-slate-600 dark:text-slate-300">
                          {line.quantity}
                        </div>
                      ) : (
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={line.quantity}
                          onChange={e =>
                            updateLine(line.id, { quantity: Math.max(1, Number(e.target.value) || 1) })
                          }
                          className="w-full rounded border-0 border-b border-transparent bg-transparent px-0 py-1 text-right font-mono text-[13px] text-slate-800 outline-none hover:border-slate-200 focus:border-brand-500 dark:text-slate-100"
                        />
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {line.quickPrint ? (
                        <div className="text-right font-mono text-[13px] text-slate-600 dark:text-slate-300">
                          {fmt(line.rate)}
                        </div>
                      ) : (
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={line.rate}
                          onChange={e =>
                            updateLine(line.id, { rate: Math.max(0, Number(e.target.value) || 0) })
                          }
                          className="w-full rounded border-0 border-b border-transparent bg-transparent px-0 py-1 text-right font-mono text-[13px] text-slate-800 outline-none hover:border-slate-200 focus:border-brand-500 dark:text-slate-100"
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-[13px] font-semibold tabular-nums text-slate-900 dark:text-white">
                      {fmt(line.quantity * line.rate)}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeLine(line.id)}
                          className="rounded p-1 text-slate-400 opacity-0 transition-all hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100 dark:hover:bg-rose-950/40"
                          title="Remove line"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {validLineCount === 0 && (
              <div className="border-t border-slate-100 px-2 py-4 text-center text-[12px] text-slate-400 dark:border-white/[0.05]">
                Press Enter to add the first item
              </div>
            )}
          </div>

          <div className="mt-2 flex items-center gap-2 border-b border-slate-200 pb-2.5 dark:border-white/[0.06]">
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-500 dark:bg-white/[0.06] dark:text-slate-400">
              {validLineCount} item{validLineCount === 1 ? '' : 's'}
            </span>
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-500 dark:bg-white/[0.06] dark:text-slate-400">
              {totalQty} qty
            </span>
            <span className="flex-1" />
            <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Subtotal
            </span>
            <span className="font-mono text-[15px] font-semibold text-slate-900 dark:text-white">
              {fmt(subtotal)}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_270px]">
            <div>
              <div className="mb-2.5 flex items-center gap-2">
                <label className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={otherChargesEnabled}
                    onChange={e => setOtherChargesEnabled(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
                  />
                  Other charges
                </label>
                {otherChargesEnabled && (
                  <input
                    type="number"
                    min={0}
                    value={otherCharges}
                    onChange={e => setOtherCharges(e.target.value)}
                    placeholder="0.00"
                    className="app-input app-input-mono !w-28 !py-1.5 !text-[12px]"
                  />
                )}
              </div>

              <div className="mb-2.5 flex items-center gap-2">
                <label className="whitespace-nowrap text-[12px] text-slate-600 dark:text-slate-300">
                  Discount
                </label>
                <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 dark:border-white/10">
                  {(['K', '%'] as const).map(m => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setDiscountMode(m)}
                      className={`px-3 py-1 font-mono text-[12px] transition-colors ${
                        discountMode === m
                          ? 'bg-brand-600 text-white'
                          : 'bg-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/[0.06]'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min={0}
                  value={discountValue}
                  onChange={e => setDiscountValue(e.target.value)}
                  placeholder="0.00"
                  className="app-input app-input-mono !w-28 !py-1.5 !text-[12px]"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="whitespace-nowrap text-[12px] text-slate-600 dark:text-slate-300">
                  Tax %
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={taxPercent}
                  onChange={e => setTaxPercent(Math.max(0, Number(e.target.value) || 0))}
                  className="app-input app-input-mono !w-20 !py-1.5 !text-[12px]"
                />
              </div>
            </div>

            <div className="text-[12.5px]">
              {discountAmount > 0 && (
                <div className="flex items-center justify-between py-1 text-emerald-600 dark:text-emerald-400">
                  <span>Discount</span>
                  <span className="font-mono">−{fmt(discountAmount)}</span>
                </div>
              )}
              {otherChargesValue > 0 && (
                <div className="flex items-center justify-between py-1 text-slate-500 dark:text-slate-400">
                  <span>Other Charges</span>
                  <span className="font-mono text-slate-700 dark:text-slate-200">
                    {fmt(otherChargesValue)}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between py-1 text-slate-500 dark:text-slate-400">
                <span>Cost of Sales</span>
                <span className="font-mono text-slate-700 dark:text-slate-200">{fmt(cost)}</span>
              </div>
              <div className="flex items-center justify-between py-1 text-slate-500 dark:text-slate-400">
                <span>Gross Profit</span>
                <span
                  className={`font-mono font-semibold ${
                    grossProfit < 0
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {fmt(grossProfit)}
                </span>
              </div>
              <div className="flex items-center justify-between py-1 text-slate-500 dark:text-slate-400">
                <span>Sales Tax ({taxPercent}%)</span>
                <span className="font-mono text-slate-700 dark:text-slate-200">
                  {fmt(taxAmount)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between border-t border-slate-300 pt-2 dark:border-white/20">
                <span className="text-[12px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                  Total Due
                </span>
                <span className="font-mono text-[19px] font-bold text-brand-600 dark:text-brand-400">
                  {fmt(total)}
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>

      {error && (
        <div className="border-t border-rose-200 bg-rose-50 px-5 py-2 text-[12px] text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* Footer */}
      <footer className="flex shrink-0 items-center gap-2.5 border-t border-slate-200 bg-white px-5 py-3 dark:border-white/[0.06] dark:bg-slate-900">
        <span className="mr-auto truncate text-[12px] text-slate-500 dark:text-slate-400">
          {loading ? 'Loading…' : selectedCustomer?.companyName || 'No customer selected'}
        </span>
        <button
          type="button"
          onClick={close}
          className="btn btn-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => handleSave(true)}
          disabled={submitting || !customerId || validLineCount === 0}
          className="btn btn-primary"
        >
          <Receipt className="h-3.5 w-3.5" />
          Save &amp; Pay
        </button>
        <button
          type="button"
          onClick={() => handleSave(false)}
          disabled={submitting || !customerId || validLineCount === 0}
          className="btn btn-primary !from-brand-600 !to-brand-700"
        >
          <Printer className="h-3.5 w-3.5" />
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