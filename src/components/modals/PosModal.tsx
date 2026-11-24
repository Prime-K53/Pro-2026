import React, { useEffect, useMemo, useState } from 'react';
import {
  Banknote,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Copy,
  Gift,
  Minus,
  Plus,
  Printer,
  RotateCcw,
  Search,
  ShoppingCart,
  Smartphone,
  Split,
  Tag,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { ApiPosCatalog, smartOpsApi } from '../../services/smartOpsApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { InlineAlert, ModalHeader, ModalShell, SummaryRow } from '../common/ui';
import { OnlineStatusBanner } from '../pos/OnlineStatusBanner';
import { printingApi } from '../../services/printingApi';
import { QuickPrintJobModal, type QuickPrintJobDraft } from './QuickPrintJobModal';

interface CartLine {
  key: string;
  itemId?: number;
  variantId?: number;
  description: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  isTaxable: boolean;
  /** A desk print job: quantity and price are fixed by its costing preview. */
  quickPrint?: QuickPrintJobDraft;
}

type TenderMode = 'cash' | 'mobile_money' | 'card' | 'bank_transfer' | 'split' | 'on_account';
type TenderMethodLabel = 'Cash' | 'Mobile Money' | 'Card' | 'Bank Transfer';

interface SplitTenderRow {
  key: string;
  tenderMethod: TenderMethodLabel;
  depositAccountId: string;
  amount: string;
  referenceNumber: string;
}

export const PosModal: React.FC = () => {
  const {
    isPosModalOpen,
    setIsPosModalOpen,
    companyProfile,
    triggerShortcutNotice,
    openDocumentPreview,
  } = useAccounting();

  const [catalog, setCatalog] = useState<ApiPosCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Catalog Browse / Orders History Tab
  const [catalogTab, setCatalogTab] = useState<'all' | 'printing_service' | 'printed_product' | 'stationery' | 'orders'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Quick Photocopy / Print job capture
  const [showQuickPrint, setShowQuickPrint] = useState(false);

  // Custom Quick Item Form
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customDesc, setCustomDesc] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const [customQty, setCustomQty] = useState('1');

  // Cart & Customer State
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState<string>('');
  const [walkInName, setWalkInName] = useState('Walk-In Cash Customer');
  const [walkInPhone, setWalkInPhone] = useState('');

  // Promo, Referral, Tax
  const [promoCode, setPromoCode] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [taxRate, setTaxRate] = useState('16');
  const [isTaxExempt, setIsTaxExempt] = useState(false);

  // Server Pricing Preview
  const [preview, setPreview] = useState<{
    grossSubtotal: number;
    promoApplied: { id: number; code: string; name: string } | null;
    promoDiscount: number;
    referralApplied: { id: number; code: string; referrerName: string; rewardAmount: number } | null;
    referralDiscount: number;
    totalDiscount: number;
    netSubtotal: number;
    taxAmount: number;
    total: number;
  } | null>(null);

  // Payment Tender State
  const [tenderMode, setTenderMode] = useState<TenderMode>('cash');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [amountTendered, setAmountTendered] = useState('');
  const [paymentRef, setPaymentRef] = useState('');
  const [splitTenders, setSplitTenders] = useState<SplitTenderRow[]>([]);
  const [sendWhatsAppReceipt, setSendWhatsAppReceipt] = useState(true);
  const [notes, setNotes] = useState('');

  // Checkout & Post-Sale State
  const [submitting, setSubmitting] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<ApiPosCatalog['recentOrders'][number] | null>(
    null
  );
  const [confirmVoidId, setConfirmVoidId] = useState<number | null>(null);

  const currency = catalog?.company.currencySymbol || companyProfile.currency || 'K';

  const loadCatalog = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await smartOpsApi.getPosCatalog();
      setCatalog(data);
      setTaxRate(String(data.company.defaultTaxRate ?? 16));
      if (data.depositAccounts.length > 0 && !depositAccountId) {
        const cashAcct =
          data.depositAccounts.find(a => a.code === '1050') ||
          data.depositAccounts.find(a => a.code === '1010') ||
          data.depositAccounts[0];
        setDepositAccountId(String(cashAcct.id));
      }
    } catch (err: any) {
      setError(err?.message || 'Unable to load POS catalog');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isPosModalOpen) {
      setCompletedOrder(null);
      setConfirmVoidId(null);
      loadCatalog();
    }
  }, [isPosModalOpen]);

  // Auto-select sensible default deposit account when tender mode switches
  useEffect(() => {
    if (!catalog) return;
    const accts = catalog.depositAccounts;
    if (tenderMode === 'cash') {
      const a = accts.find(x => x.code === '1050') || accts.find(x => x.code === '1010') || accts[0];
      if (a) setDepositAccountId(String(a.id));
    } else if (tenderMode === 'mobile_money' || tenderMode === 'card') {
      const a = accts.find(x => x.code === '1030') || accts.find(x => x.code === '1010') || accts[0];
      if (a) setDepositAccountId(String(a.id));
    } else if (tenderMode === 'bank_transfer') {
      const a = accts.find(x => x.code === '1010') || accts[0];
      if (a) setDepositAccountId(String(a.id));
    }
  }, [tenderMode, catalog]);

  // Live debounced POS preview calculation from backend
  useEffect(() => {
    if (!isPosModalOpen || cart.length === 0) {
      setPreview(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const res = await smartOpsApi.previewPos({
          lines: cart.map(l => ({
            itemId: l.itemId,
            variantId: l.variantId,
            description: l.description,
            quantity: l.quantity,
            rate: l.unitPrice,
            taxable: l.isTaxable,
          })),
          promoCode: promoCode.trim() || undefined,
          referralCode: referralCode.trim() || undefined,
          taxRate: Number(taxRate) || 0,
          isTaxExempt,
        });
        setPreview(res);
      } catch {
        // Fallback local estimate if user is mid-typing an invalid code
        const gross = cart.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
        const taxable = isTaxExempt
          ? 0
          : cart.reduce((s, l) => s + (l.isTaxable ? l.quantity * l.unitPrice : 0), 0);
        const tax = Math.round(taxable * ((Number(taxRate) || 0) / 100) * 100) / 100;
        setPreview({
          grossSubtotal: gross,
          promoApplied: null,
          promoDiscount: 0,
          referralApplied: null,
          referralDiscount: 0,
          totalDiscount: 0,
          netSubtotal: gross,
          taxAmount: tax,
          total: gross + tax,
        });
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [isPosModalOpen, cart, promoCode, referralCode, taxRate, isTaxExempt]);

  const filteredItems = useMemo(() => {
    if (!catalog) return [];
    const q = searchQuery.toLowerCase().trim();
    return catalog.items.filter(item => {
      if (catalogTab !== 'all' && catalogTab !== 'orders' && item.itemType !== catalogTab) {
        return false;
      }
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.sku.toLowerCase().includes(q) ||
        item.variants.some(v => v.variantName.toLowerCase().includes(q))
      );
    });
  }, [catalog, catalogTab, searchQuery]);

  const addItemToCart = (
    item: ApiPosCatalog['items'][number],
    variant?: ApiPosCatalog['items'][number]['variants'][number]
  ) => {
    const key = variant ? `item-${item.id}-var-${variant.id}` : `item-${item.id}`;
    const desc = variant ? `${item.name} (${variant.variantName})` : item.name;
    const price = variant ? variant.salesPrice : item.salesPrice;
    const sku = variant ? variant.sku || item.sku : item.sku;

    setCart(prev => {
      const existing = prev.find(l => l.key === key);
      if (existing) {
        return prev.map(l => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [
        ...prev,
        {
          key,
          itemId: item.id,
          variantId: variant?.id,
          description: desc,
          sku,
          quantity: 1,
          unitPrice: price,
          isTaxable: item.isTaxable,
        },
      ];
    });
  };

  const handleAddCustomLine = (e: React.FormEvent) => {
    e.preventDefault();
    const price = Number(customPrice);
    const qty = Number(customQty) || 1;
    if (!customDesc.trim() || !(price >= 0)) return;
    setCart(prev => [
      ...prev,
      {
        key: `custom-${Date.now()}`,
        description: customDesc.trim(),
        sku: 'CUSTOM',
        quantity: qty,
        unitPrice: price,
        isTaxable: true,
      },
    ]);
    setCustomDesc('');
    setCustomPrice('');
    setCustomQty('1');
    setShowCustomForm(false);
  };

  const addQuickPrintJob = (draft: QuickPrintJobDraft) => {
    const jobLabel =
      draft.jobType === 'quick_photocopy'
        ? 'Quick Photocopy'
        : draft.jobType === 'type_and_printing'
        ? 'Type & Print'
        : 'General Print';
    setCart(prev => [
      ...prev,
      {
        key: `qp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        description: `${jobLabel} — ${draft.title} (${draft.pages} pp × ${draft.copies} copies, ${
          draft.printSide
        } · ${draft.estimate.sheetsUsed.toLocaleString()} sheets)`,
        sku: 'PRINT-JOB',
        quantity: 1,
        unitPrice: draft.estimate.sellingPriceTotal,
        isTaxable: true,
        quickPrint: draft,
      },
    ]);
  };

  const updateCartQty = (key: string, delta: number) => {
    setCart(prev =>
      prev
        .map(l => (l.key === key ? { ...l, quantity: Math.max(0, l.quantity + delta) } : l))
        .filter(l => l.quantity > 0)
    );
  };

  const updateCartPrice = (key: string, nextPrice: number) => {
    setCart(prev =>
      prev.map(l => (l.key === key ? { ...l, unitPrice: Math.max(0, nextPrice) } : l))
    );
  };

  const handleSelectCustomer = (cid: string) => {
    setCustomerId(cid);
    const found = catalog?.customers.find(c => String(c.id) === cid);
    if (found) {
      setIsTaxExempt(Boolean(found.isTaxExempt));
    }
  };

  const totalDue = preview?.total ?? 0;
  const parsedTendered = Number(amountTendered) || 0;
  const cashChangeDue =
    tenderMode === 'cash' && parsedTendered > totalDue
      ? Math.round((parsedTendered - totalDue) * 100) / 100
      : 0;

  const initSplitMode = () => {
    setTenderMode('split');
    const half = Math.round((totalDue / 2) * 100) / 100;
    const rem = Math.round((totalDue - half) * 100) / 100;
    const cashAcct =
      catalog?.depositAccounts.find(a => a.code === '1050')?.id ??
      catalog?.depositAccounts[0]?.id ??
      '';
    const mobAcct =
      catalog?.depositAccounts.find(a => a.code === '1030')?.id ??
      catalog?.depositAccounts[0]?.id ??
      '';
    setSplitTenders([
      {
        key: `st-${Date.now()}-1`,
        tenderMethod: 'Cash',
        depositAccountId: String(cashAcct),
        amount: String(half),
        referenceNumber: '',
      },
      {
        key: `st-${Date.now()}-2`,
        tenderMethod: 'Mobile Money',
        depositAccountId: String(mobAcct),
        amount: String(rem),
        referenceNumber: '',
      },
    ]);
  };

  const splitSum = splitTenders.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const splitRemaining = Math.round((totalDue - splitSum) * 100) / 100;

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    if (tenderMode === 'split' && Math.abs(splitRemaining) > 0.01) {
      triggerShortcutNotice('Split tender legs must equal the exact total due', 'warning');
      return;
    }
    if (tenderMode === 'cash' && amountTendered && parsedTendered < totalDue) {
      triggerShortcutNotice('Cash tendered is less than total due', 'warning');
      return;
    }

    setSubmitting(true);
    setError(null);
    const postedJobs: number[] = [];
    try {
      // Post every desk print job to production (material issue to WIP) before the
      // sale is finalised, so the ticket sells real cost and the stock movement
      // happens once, on the server.
      for (const line of cart) {
        if (!line.quickPrint) continue;
        const draft = line.quickPrint;
        const { job } = await printingApi.postQuickPrintJob({
          jobType: draft.jobType,
          customerId: customerId ? Number(customerId) : null,
          customerName: !customerId ? walkInName.trim() || 'Walk-In Cash Customer' : undefined,
          title: draft.title,
          pages: draft.pages,
          copies: draft.copies,
          printSide: draft.printSide,
          rawPaperItemId: Number(draft.rawPaperItemId),
          rawTonerItemId: Number(draft.rawTonerItemId),
          typingFeeMode: 'per_page',
          typingFeeRate: draft.jobType === 'type_and_printing' ? draft.extraCostPerPage : 0,
          manualSellingPricePerSheet: draft.sellingPricePerSheet,
          jobDate: draft.date,
          notes: draft.notes ?? null,
          idempotencyKey: `pos-quick-${line.key}`,
        });
        const jobId = Number(job?.id);
        if (Number.isInteger(jobId) && jobId > 0) postedJobs.push(jobId);
      }

      const payload: Record<string, unknown> = {
        customerId: customerId ? Number(customerId) : undefined,
        walkInCustomerName: !customerId ? walkInName.trim() || 'Walk-In Cash Customer' : undefined,
        walkInCustomerPhone: !customerId && walkInPhone.trim() ? walkInPhone.trim() : undefined,
        lines: cart.map(l => ({
          itemId: l.itemId,
          variantId: l.variantId,
          description: l.description,
          quantity: l.quantity,
          rate: l.unitPrice,
          taxable: l.isTaxable,
        })),
        promoCode: promoCode.trim() || undefined,
        referralCode: referralCode.trim() || undefined,
        taxRate: Number(taxRate) || 0,
        isTaxExempt,
        tenderMode,
        depositAccountId: depositAccountId ? Number(depositAccountId) : undefined,
        amountTendered: tenderMode === 'cash' ? Number(amountTendered) || totalDue : totalDue,
        referenceNumber: paymentRef.trim() || undefined,
        tenders:
          tenderMode === 'split'
            ? splitTenders.map(t => ({
                tenderMethod: t.tenderMethod,
                depositAccountId: t.depositAccountId ? Number(t.depositAccountId) : undefined,
                amount: Number(t.amount) || 0,
                referenceNumber: t.referenceNumber.trim() || undefined,
              }))
            : undefined,
        sendWhatsAppReceipt,
        notes: notes.trim() || undefined,
        idempotencyKey: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };

      const order = await smartOpsApi.checkoutPos(payload);

      for (const jobId of postedJobs) {
        try {
          await printingApi.linkJobInvoice(jobId, order.invoiceId);
        } catch (linkErr: any) {
          setError(
            `Sale ${order.receiptNumber} posted, but print job #${jobId} could not be linked: ${
              linkErr?.message || 'unknown error'
            }`
          );
        }
      }

      setCompletedOrder(order);
      triggerShortcutNotice(
        `POS Sale ${order.receiptNumber} posted to GL (JE #${order.journalTxnId})`,
        'success'
      );
      await loadCatalog();
    } catch (err: any) {
      const suffix = postedJobs.length
        ? ` Print jobs #${postedJobs.join(', #')} were posted to production WIP and still need billing.`
        : '';
      setError((err?.message || 'POS checkout failed') + suffix);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartNewSale = () => {
    setCart([]);
    setPromoCode('');
    setReferralCode('');
    setAmountTendered('');
    setPaymentRef('');
    setNotes('');
    setCompletedOrder(null);
  };

  const handlePrintOrderReceipt = (order: ApiPosCatalog['recentOrders'][number]) => {
    openDocumentPreview({
      kind: 'sales_receipt',
      id: order.invoiceId,
      backendId: order.invoiceId,
      title: `POS Sales Receipt`,
      documentNumber: order.receiptNumber,
      status: order.status,
      documentDate: order.orderDate,
      currencyCode: catalog?.company.baseCurrency || 'ZMW',
      company: {
        name: companyProfile.name || catalog?.company.name || 'Printing House',
        legalName: companyProfile.legalName,
        ein: companyProfile.ein,
        currency,
        address: companyProfile.address,
        cityStateZip: companyProfile.cityStateZip,
        phone: companyProfile.phone,
        email: companyProfile.email,
      },
      counterparty: {
        roleLabel: 'Customer',
        id: order.customerId,
        name: order.customerName,
        phone: order.customerPhone || undefined,
      },
      lines: [
        {
          description: `POS Counter Sale (${order.invoiceNumber}) — Tenders: ${order.tenders
            .map(t => `${t.tenderMethod} ${formatCurrency(t.amount, currency)}`)
            .join(', ')}${order.totalDiscount > 0 ? ` · Discounts: -${formatCurrency(order.totalDiscount, currency)}` : ''}`,
          quantity: 1,
          rate: order.netSubtotal,
          amount: order.netSubtotal,
          taxable: order.taxAmount > 0,
        },
      ],
      totals: {
        subtotal: order.netSubtotal,
        taxRate: order.taxRate,
        taxAmount: order.taxAmount,
        total: order.total,
        amountPaid: order.tenderMode === 'on_account' ? 0 : order.total,
        balanceDue: order.tenderMode === 'on_account' ? order.total : 0,
      },
      journalEntryNumber: order.journalTxnId ? `JE-${order.journalTxnId}` : null,
      notes: order.notes || undefined,
    });
  };

  const handleVoidOrder = async (orderId: number) => {
    try {
      await smartOpsApi.voidPosOrder(orderId, 'POS register void');
      setConfirmVoidId(null);
      triggerShortcutNotice('POS order voided & GL journal / inventory reversed', 'warning');
      await loadCatalog();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to void POS order', 'error');
    }
  };

  const buildWhatsAppReceiptUrl = (order: ApiPosCatalog['recentOrders'][number]) => {
    const digits = (order.customerPhone || '').replace(/[^\d]/g, '');
    const msg = encodeURIComponent(
      `Thank you ${order.customerName} for shopping at ${companyProfile.name}! Receipt ${order.receiptNumber} · Total: ${formatCurrency(order.total, currency)}${
        order.totalDiscount > 0 ? ` (Saved ${formatCurrency(order.totalDiscount, currency)})` : ''
      }.`
    );
    return digits ? `https://wa.me/${digits}?text=${msg}` : `https://wa.me/?text=${msg}`;
  };

  return (
    <>
    <ModalShell
      open={isPosModalOpen}
      onClose={() => setIsPosModalOpen(false)}
      size="4xl"
      className="!max-w-6xl"
    >
      <ModalHeader
        title="Full Point-of-Sale (POS) Terminal"
        subtitle="Live inventory deduction, promos & referrals, multi-tender settlement, and instant double-entry GL posting"
        icon={<ShoppingCart className="h-5 w-5" />}
        tone="emerald"
        onClose={() => setIsPosModalOpen(false)}
      />

      {error && (
        <div className="px-5 pt-3">
          <InlineAlert tone="error" onDismiss={() => setError(null)}>
            {error}
          </InlineAlert>
        </div>
      )}

      <div className="px-5 pt-3">
        <OnlineStatusBanner />
      </div>

      {completedOrder ? (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl rounded-2xl border border-emerald-200 bg-emerald-50/40 p-6 dark:border-emerald-500/25 dark:bg-emerald-500/10">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-600 text-white">
                  <CheckCircle2 className="h-6 w-6" />
                </span>
                <div>
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                    Sale Completed — {completedOrder.receiptNumber}
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    Posted Invoice {completedOrder.invoiceNumber} · GL Journal #
                    {completedOrder.journalTxnId} · Inventory & Bank Register updated
                  </p>
                </div>
              </div>
              <span className="font-mono text-2xl font-black tabular-nums text-emerald-700 dark:text-emerald-300">
                {formatCurrency(completedOrder.total, currency)}
              </span>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 rounded-xl border border-slate-200/80 bg-white p-4 sm:grid-cols-2 dark:border-white/10 dark:bg-slate-900">
              <div className="space-y-1 text-xs">
                <div className="font-bold tracking-wider text-slate-400 uppercase">Customer</div>
                <div className="font-semibold text-slate-900 dark:text-white">
                  {completedOrder.customerName}
                </div>
                {completedOrder.customerPhone && (
                  <div className="font-mono text-slate-500">{completedOrder.customerPhone}</div>
                )}
              </div>
              <div className="space-y-1 text-xs">
                <div className="font-bold tracking-wider text-slate-400 uppercase">Tenders</div>
                {completedOrder.tenders.map(t => (
                  <div key={t.id} className="flex justify-between font-mono tabular-nums">
                    <span>
                      {t.tenderMethod} ({t.accountLabel})
                    </span>
                    <span className="font-bold">{formatCurrency(t.amount, currency)}</span>
                  </div>
                ))}
                {completedOrder.changeDue > 0 && (
                  <div className="flex justify-between font-mono font-bold text-emerald-600 tabular-nums">
                    <span>Change Returned</span>
                    <span>{formatCurrency(completedOrder.changeDue, currency)}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => handlePrintOrderReceipt(completedOrder)}
                className="btn btn-secondary"
              >
                <Printer className="h-4 w-4" />
                Print Receipt
              </button>
              <a
                href={buildWhatsAppReceiptUrl(completedOrder)}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-emerald"
              >
                <ExternalLink className="h-4 w-4" />
                Send Receipt via WhatsApp
              </a>
              <button type="button" onClick={handleStartNewSale} className="btn btn-primary">
                <Plus className="h-4 w-4" />
                New POS Sale
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid flex-1 min-h-0 grid-cols-1 overflow-hidden lg:grid-cols-[1fr_440px]">
          {/* LEFT COLUMN: CATALOG OR RECENT ORDERS */}
          <div className="flex min-h-0 flex-col border-b border-slate-200/80 lg:border-r lg:border-b-0 dark:border-white/[0.06]">
            {/* Search & Category Bar */}
            <div className="space-y-2.5 border-b border-slate-200/70 bg-slate-50/70 p-4 dark:border-white/[0.06] dark:bg-white/[0.02]">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    className="app-input pl-9"
                    placeholder="Search stationery, print services, SKU..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowQuickPrint(true)}
                  className="btn btn-secondary"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Quick Copy / Print
                </button>
                <button
                  type="button"
                  onClick={() => setShowCustomForm(v => !v)}
                  className="btn btn-secondary"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Custom Line
                </button>
              </div>

              {showCustomForm && (
                <form
                  onSubmit={handleAddCustomLine}
                  className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-[1fr_90px_110px_auto] dark:border-white/10 dark:bg-slate-900"
                >
                  <input
                    type="text"
                    className="app-input"
                    placeholder="Custom print / lamination description..."
                    value={customDesc}
                    onChange={e => setCustomDesc(e.target.value)}
                    required
                  />
                  <input
                    type="number"
                    min="1"
                    className="app-input app-input-mono"
                    placeholder="Qty"
                    value={customQty}
                    onChange={e => setCustomQty(e.target.value)}
                    required
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="app-input app-input-mono"
                    placeholder="Price"
                    value={customPrice}
                    onChange={e => setCustomPrice(e.target.value)}
                    required
                  />
                  <button type="submit" className="btn btn-primary">
                    Add
                  </button>
                </form>
              )}

              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { id: 'all', label: 'All Catalog' },
                    { id: 'printing_service', label: 'Printing Services' },
                    { id: 'printed_product', label: 'Printed Products' },
                    { id: 'stationery', label: 'Stationery' },
                    {
                      id: 'orders',
                      label: `Recent Receipts (${catalog?.recentOrders.length || 0})`,
                    },
                  ] as const
                ).map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setCatalogTab(tab.id)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                      catalogTab === tab.id
                        ? 'bg-brand-600 text-white'
                        : 'bg-white text-slate-600 ring-1 ring-slate-200/80 hover:bg-slate-50 dark:bg-white/[0.04] dark:text-slate-300 dark:ring-white/10'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Catalog Items Grid or Recent Orders Table */}
            <div className="flex-1 overflow-y-auto p-4">
              {loading && !catalog ? (
                <div className="py-12 text-center text-xs text-slate-500">
                  Loading live inventory & POS catalog...
                </div>
              ) : catalogTab === 'orders' ? (
                <div className="space-y-2.5">
                  {catalog?.recentOrders.length === 0 ? (
                    <div className="py-12 text-center text-xs text-slate-500">
                      No POS receipts recorded yet.
                    </div>
                  ) : (
                    catalog?.recentOrders.map(ord => (
                      <div
                        key={ord.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/80 p-3.5 text-xs dark:border-white/[0.08]"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-brand-600 dark:text-brand-400">
                              {ord.receiptNumber}
                            </span>
                            <span className="font-semibold text-slate-900 dark:text-white">
                              {ord.customerName}
                            </span>
                            <span className="font-mono text-[11px] text-slate-400">
                              {ord.status.toUpperCase()}
                            </span>
                          </div>
                          <div className="mt-1 text-[11px] text-slate-500">
                            {ord.orderDate} · {ord.tenders.map(t => t.tenderMethod).join(' + ')} ·{' '}
                            {ord.journalTxnId ? `JE #${ord.journalTxnId}` : ''}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                            {formatCurrency(ord.total, currency)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handlePrintOrderReceipt(ord)}
                            className="btn btn-secondary py-1 text-xs"
                          >
                            <Printer className="h-3 w-3" />
                          </button>
                          <a
                            href={buildWhatsAppReceiptUrl(ord)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-secondary py-1 text-xs"
                          >
                            WA
                          </a>
                          {ord.status === 'completed' &&
                            (confirmVoidId === ord.id ? (
                              <button
                                type="button"
                                onClick={() => handleVoidOrder(ord.id)}
                                className="btn btn-danger py-1 text-xs"
                              >
                                Confirm Void
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmVoidId(ord.id)}
                                className="btn btn-secondary py-1 text-xs text-rose-600"
                              >
                                <RotateCcw className="h-3 w-3" />
                                Void
                              </button>
                            ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {filteredItems.map(item => (
                    <div
                      key={item.id}
                      className="flex flex-col justify-between rounded-xl border border-slate-200/80 bg-white p-3.5 transition-all hover:border-brand-300 dark:border-white/[0.08] dark:bg-white/[0.02]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 dark:text-white">
                            {item.name}
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                            {item.sku} ·{' '}
                            {item.availableQty !== null
                              ? `${item.availableQty} ${item.unitLabel} in stock`
                              : item.itemType.replace(/_/g, ' ')}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                          {formatCurrency(item.salesPrice, currency)}
                        </span>
                      </div>

                      {item.variants.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {item.variants.map(v => (
                            <button
                              key={v.id}
                              type="button"
                              onClick={() => addItemToCart(item, v)}
                              className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition-colors hover:border-brand-400 hover:bg-brand-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-200 dark:hover:bg-brand-500/20"
                            >
                              {v.variantName} ·{' '}
                              <span className="font-mono">{formatCurrency(v.salesPrice, currency)}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => addItemToCart(item)}
                          className="btn btn-secondary mt-3 w-full py-1.5 text-xs"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add to Ticket
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT COLUMN: ACTIVE TICKET, DISCOUNTS & MULTI-TENDER SETTLEMENT */}
          <div className="flex min-h-0 flex-col bg-slate-50/50 dark:bg-slate-950/30">
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {/* Customer & Walk-In */}
              <div className="space-y-2 rounded-xl border border-slate-200/80 bg-white p-3 dark:border-white/[0.08] dark:bg-slate-900">
                <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                  <UserCheck className="h-3.5 w-3.5" />
                  Customer Account
                </div>
                <select
                  className="app-input"
                  value={customerId}
                  onChange={e => handleSelectCustomer(e.target.value)}
                >
                  <option value="">Walk-In Cash Customer</option>
                  {catalog?.customers.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.companyName} {c.phone ? `(${c.phone})` : ''}
                    </option>
                  ))}
                </select>
                {!customerId && (
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      className="app-input"
                      placeholder="Walk-in name"
                      value={walkInName}
                      onChange={e => setWalkInName(e.target.value)}
                    />
                    <input
                      type="text"
                      className="app-input app-input-mono"
                      placeholder="WhatsApp phone"
                      value={walkInPhone}
                      onChange={e => setWalkInPhone(e.target.value)}
                    />
                  </div>
                )}
              </div>

              {/* Cart Lines */}
              <div className="rounded-xl border border-slate-200/80 bg-white p-3 dark:border-white/[0.08] dark:bg-slate-900">
                <div className="mb-2 flex items-center justify-between text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                  <span>Order Ticket ({cart.length} lines)</span>
                  {cart.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setCart([])}
                      className="text-rose-600 hover:underline"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {cart.length === 0 ? (
                  <div className="py-6 text-center text-xs text-slate-400">
                    Click items on the left to build the POS ticket.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {cart.map(line => (
                      <div
                        key={line.key}
                        className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 p-2 text-xs dark:border-white/[0.06]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-slate-900 dark:text-white">
                            {line.description}
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            {line.quickPrint ? (
                              <span className="text-[10px] text-brand-600 dark:text-brand-400">
                                Print job · {line.quickPrint.estimate.sheetsUsed.toLocaleString()} sheets · cost{' '}
                                {formatCurrency(line.quickPrint.estimate.totalCost, currency)}
                              </span>
                            ) : (
                              <>
                                <span className="text-[10px] text-slate-400">Rate:</span>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  className="w-20 rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[11px] dark:border-white/10 dark:bg-transparent"
                                  value={line.unitPrice}
                                  onChange={e => updateCartPrice(line.key, Number(e.target.value) || 0)}
                                />
                              </>
                            )}
                          </div>
                        </div>

                        {line.quickPrint ? (
                          <span className="w-16 text-center font-mono font-bold tabular-nums">
                            {line.quantity}
                          </span>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => updateCartQty(line.key, -1)}
                              className="rounded border border-slate-200 p-1 hover:bg-slate-100 dark:border-white/10 dark:hover:bg-white/10"
                            >
                              <Minus className="h-3 w-3" />
                            </button>
                            <span className="w-7 text-center font-mono font-bold tabular-nums">
                              {line.quantity}
                            </span>
                            <button
                              type="button"
                              onClick={() => updateCartQty(line.key, 1)}
                              className="rounded border border-slate-200 p-1 hover:bg-slate-100 dark:border-white/10 dark:hover:bg-white/10"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                          </div>
                        )}

                        <div className="w-20 text-right font-mono font-bold tabular-nums">
                          {formatCurrency(line.quantity * line.unitPrice, currency)}
                        </div>

                        <button
                          type="button"
                          onClick={() => setCart(prev => prev.filter(x => x.key !== line.key))}
                          className="p-1 text-slate-400 hover:text-rose-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Promo Code, Referral Code & Tax */}
              <div className="space-y-2.5 rounded-xl border border-slate-200/80 bg-white p-3 dark:border-white/[0.08] dark:bg-slate-900">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="app-label flex items-center gap-1">
                      <Tag className="h-3 w-3" /> Promo Code
                    </label>
                    <input
                      type="text"
                      list="pos-promo-list"
                      className="app-input app-input-mono uppercase"
                      placeholder="e.g. PRINT10"
                      value={promoCode}
                      onChange={e => setPromoCode(e.target.value.toUpperCase())}
                    />
                    <datalist id="pos-promo-list">
                      {catalog?.activePromotions.map(p => (
                        <option key={p.id} value={p.code}>
                          {p.name}
                        </option>
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="app-label flex items-center gap-1">
                      <Gift className="h-3 w-3" /> Referral Code
                    </label>
                    <input
                      type="text"
                      list="pos-ref-list"
                      className="app-input app-input-mono uppercase"
                      placeholder="Advocate code"
                      value={referralCode}
                      onChange={e => setReferralCode(e.target.value.toUpperCase())}
                    />
                    <datalist id="pos-ref-list">
                      {catalog?.activeReferralCodes.map(r => (
                        <option key={r.id} value={r.code}>
                          {r.referrerName}
                        </option>
                      ))}
                    </datalist>
                  </div>
                </div>

                {preview?.promoApplied && (
                  <div className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                    Promo {preview.promoApplied.code} applied (-
                    {formatCurrency(preview.promoDiscount, currency)})
                  </div>
                )}
                {preview?.referralApplied && (
                  <div className="text-[11px] font-semibold text-brand-600 dark:text-brand-400">
                    Referral {preview.referralApplied.code} ({preview.referralApplied.referrerName})
                    · Referee -{formatCurrency(preview.referralDiscount, currency)} · Advocate Reward{' '}
                    {formatCurrency(preview.referralApplied.rewardAmount, currency)}
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 pt-1">
                  <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={isTaxExempt}
                      onChange={e => setIsTaxExempt(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    Tax-Exempt Sale
                  </label>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-slate-500">Tax %</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.5"
                      disabled={isTaxExempt}
                      className="w-16 rounded border border-slate-200 px-2 py-1 text-right font-mono dark:border-white/10 dark:bg-transparent"
                      value={taxRate}
                      onChange={e => setTaxRate(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Financial Summary */}
              <div className="rounded-xl border border-slate-200/80 bg-white p-3 dark:border-white/[0.08] dark:bg-slate-900">
                <SummaryRow
                  label="Gross Subtotal"
                  value={formatCurrency(preview?.grossSubtotal || 0, currency)}
                />
                {(preview?.promoDiscount || 0) > 0 && (
                  <SummaryRow
                    label="Promo Discount (4100)"
                    value={`-${formatCurrency(preview?.promoDiscount || 0, currency)}`}
                    tone="emerald"
                  />
                )}
                {(preview?.referralDiscount || 0) > 0 && (
                  <SummaryRow
                    label="Referral Discount (4100)"
                    value={`-${formatCurrency(preview?.referralDiscount || 0, currency)}`}
                    tone="brand"
                  />
                )}
                <SummaryRow
                  label={`Sales Tax (${isTaxExempt ? 0 : taxRate}%)`}
                  value={formatCurrency(preview?.taxAmount || 0, currency)}
                />
                <SummaryRow
                  label="Total Due"
                  value={formatCurrency(totalDue, currency)}
                  emphasis
                  tone="emerald"
                />
              </div>

              {/* Payment Tenders */}
              <div className="space-y-3 rounded-xl border border-slate-200/80 bg-white p-3 dark:border-white/[0.08] dark:bg-slate-900">
                <div className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                  Payment & Deposit Account
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: 'cash', label: 'Cash', icon: Banknote },
                      { id: 'mobile_money', label: 'Mobile Money', icon: Smartphone },
                      { id: 'card', label: 'Card', icon: CreditCard },
                      { id: 'bank_transfer', label: 'Bank', icon: CheckCircle2 },
                      { id: 'split', label: 'Split', icon: Split },
                      { id: 'on_account', label: 'On Account', icon: UserCheck },
                    ] as const
                  ).map(m => {
                    const Icon = m.icon;
                    const active = tenderMode === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() =>
                          m.id === 'split' ? initSplitMode() : setTenderMode(m.id)
                        }
                        className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-semibold transition-colors ${
                          active
                            ? 'border-emerald-600 bg-emerald-600 text-white'
                            : 'border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/[0.06]'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        {m.label}
                      </button>
                    );
                  })}
                </div>

                {tenderMode !== 'split' && tenderMode !== 'on_account' && (
                  <>
                    <div>
                      <label className="app-label">Deposit To GL Account</label>
                      <select
                        className="app-input"
                        value={depositAccountId}
                        onChange={e => setDepositAccountId(e.target.value)}
                      >
                        {catalog?.depositAccounts.map(a => (
                          <option key={a.id} value={a.id}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {tenderMode === 'cash' ? (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="app-label">Cash Tendered ({currency})</label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className="app-input app-input-mono"
                            placeholder={totalDue.toFixed(2)}
                            value={amountTendered}
                            onChange={e => setAmountTendered(e.target.value)}
                          />
                        </div>
                        <div className="flex flex-col justify-end rounded-xl bg-slate-50 px-3 py-2 dark:bg-white/[0.04]">
                          <span className="text-[10px] font-bold text-slate-400 uppercase">
                            Change Due
                          </span>
                          <span className="font-mono text-base font-black tabular-nums text-emerald-600 dark:text-emerald-400">
                            {formatCurrency(cashChangeDue, currency)}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <label className="app-label">Transaction / Reference #</label>
                        <input
                          type="text"
                          className="app-input app-input-mono"
                          placeholder="MoMo Ref / Card Auth Code"
                          value={paymentRef}
                          onChange={e => setPaymentRef(e.target.value)}
                        />
                      </div>
                    )}
                  </>
                )}

                {tenderMode === 'split' && (
                  <div className="space-y-2">
                    {splitTenders.map((row, idx) => (
                      <div
                        key={row.key}
                        className="grid grid-cols-[100px_1fr_90px] items-center gap-1.5"
                      >
                        <select
                          className="app-input py-1.5 text-xs"
                          value={row.tenderMethod}
                          onChange={e =>
                            setSplitTenders(prev =>
                              prev.map((r, i) =>
                                i === idx
                                  ? { ...r, tenderMethod: e.target.value as TenderMethodLabel }
                                  : r
                              )
                            )
                          }
                        >
                          <option value="Cash">Cash</option>
                          <option value="Mobile Money">Mobile Money</option>
                          <option value="Card">Card</option>
                          <option value="Bank Transfer">Bank</option>
                        </select>
                        <select
                          className="app-input py-1.5 text-xs"
                          value={row.depositAccountId}
                          onChange={e =>
                            setSplitTenders(prev =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, depositAccountId: e.target.value } : r
                              )
                            )
                          }
                        >
                          {catalog?.depositAccounts.map(a => (
                            <option key={a.id} value={a.id}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className="app-input app-input-mono py-1.5 text-xs"
                          value={row.amount}
                          onChange={e =>
                            setSplitTenders(prev =>
                              prev.map((r, i) => (i === idx ? { ...r, amount: e.target.value } : r))
                            )
                          }
                        />
                      </div>
                    ))}
                    <div className="flex items-center justify-between text-[11px]">
                      <button
                        type="button"
                        onClick={() =>
                          setSplitTenders(prev => [
                            ...prev,
                            {
                              key: `st-${Date.now()}`,
                              tenderMethod: 'Card',
                              depositAccountId: String(catalog?.depositAccounts[0]?.id || ''),
                              amount: String(Math.max(0, splitRemaining)),
                              referenceNumber: '',
                            },
                          ])
                        }
                        className="font-semibold text-brand-600 hover:underline"
                      >
                        + Add Tender Leg
                      </button>
                      <span
                        className={`font-mono font-bold tabular-nums ${
                          Math.abs(splitRemaining) <= 0.01 ? 'text-emerald-600' : 'text-rose-600'
                        }`}
                      >
                        Remaining: {formatCurrency(splitRemaining, currency)}
                      </span>
                    </div>
                  </div>
                )}

                <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={sendWhatsAppReceipt}
                    onChange={e => setSendWhatsAppReceipt(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Auto-queue WhatsApp Receipt message (if rule enabled)
                </label>
              </div>
            </div>

            {/* Sticky Checkout Footer */}
            <div className="border-t border-slate-200/80 bg-white p-4 dark:border-white/[0.06] dark:bg-slate-900">
              <button
                type="button"
                disabled={submitting || cart.length === 0}
                onClick={handleCheckout}
                className="btn btn-emerald w-full py-3 text-sm font-bold"
              >
                <ShoppingCart className="h-4 w-4" />
                {submitting
                  ? 'Posting Sale to Ledger...'
                  : `Complete Sale & Post to GL (${formatCurrency(totalDue, currency)})`}
              </button>
            </div>
          </div>
        </div>
      )}
      </ModalShell>

      <QuickPrintJobModal
        open={isPosModalOpen && showQuickPrint}
        onClose={() => setShowQuickPrint(false)}
        onAdd={addQuickPrintJob}
        targetLabel="this ticket"
      />
    </>
  );
};
