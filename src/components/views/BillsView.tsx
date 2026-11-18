import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT, accountingApi, ApiAccount } from '../../services/accountingApi';
import { ApiBill, ApiPurchaseOrder, ApiVendor, commercialApi } from '../../services/commercialApi';
import { printingApi, type ApiPrintingJob } from '../../services/printingApi';
import { useFxRates } from '../../hooks/useFxRates';
import { Pagination, pageSlice } from '../common/Pagination';
import { formatCurrency } from '../../utils/currency';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';
import {
  Receipt,
  Plus,
  Search,
  Clock,
  Building2,
  DollarSign,
  Copy,
  X,
  Ban,
  PackageCheck,
  FilePlus,
  AlertTriangle,
  Loader2,
  ClipboardList,
  Package,
  ArrowRight,
  CheckCircle2,
  FileText,
  Trash2,
} from 'lucide-react';

type PurchasingTab =
  | 'bills'
  | 'purchaseOrders'
  | 'requisitions'
  | 'goodsReceipts'
  | 'payments'
  | 'vendorCredits';

export const BillsView: React.FC = () => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canWrite = hasPermission('bills:write');
  const { options: fxOptions, baseCurrency, rateFor: fxRateFor } = useFxRates();

  const [activeTab, setActiveTab] = useState<PurchasingTab>('bills');
  const [billFilter, setBillFilter] = useState<'open' | 'all' | 'paid' | 'voided'>('open');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [bills, setBills] = useState<ApiBill[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<ApiPurchaseOrder[]>([]);
  const [billPayments, setBillPayments] = useState<any[]>([]);
  const [vendorCredits, setVendorCredits] = useState<any[]>([]);
  const [requisitions, setRequisitions] = useState<any[]>([]);
  const [goodsReceipts, setGoodsReceipts] = useState<any[]>([]);
  const [printingJobs, setPrintingJobs] = useState<ApiPrintingJob[]>([]);
  const [shortfallJobId, setShortfallJobId] = useState<number | ''>('');
  const [vendors, setVendors] = useState<ApiVendor[]>([]);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<ApiAccount[]>([]);

  // Enter Bill Modal
  const [isBillModalOpen, setIsBillModalOpen] = useState(false);
  const [billVendorId, setBillVendorId] = useState<number>(0);
  const [billNumberInput, setBillNumberInput] = useState('');
  const [billDate, setBillDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [billCurrency, setBillCurrency] = useState('ZMW');
  const [billFxRate, setBillFxRate] = useState('1');
  const [billMemo, setBillMemo] = useState('');
  const [billLines, setBillLines] = useState<
    Array<{ itemId: string; accountId: number; description: string; quantity: string; unitCost: string; useTaxRate: string }>
  >([{ itemId: '', accountId: 0, description: '', quantity: '1', unitCost: '0', useTaxRate: '0' }]);

  // Purchase Order Modal
  const [isPoModalOpen, setIsPoModalOpen] = useState(false);
  const [poVendorId, setPoVendorId] = useState<number>(0);
  const [poDate, setPoDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [poNotes, setPoNotes] = useState('');
  const [poLines, setPoLines] = useState<
    Array<{ itemId: string; description: string; quantity: string; rate: string }>
  >([{ itemId: '', description: 'Printing Raw Stock Order', quantity: '10', rate: '120' }]);

  // Pay Bill Modal
  const [isPayModalOpen, setIsPayModalOpen] = useState(false);
  const [payVendorId, setPayVendorId] = useState<number>(0);
  const [payBankAcctId, setPayBankAcctId] = useState<number>(0);
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payCheckNum, setPayCheckNum] = useState('');
  const [payCurrency, setPayCurrency] = useState('ZMW');
  const [payFxRate, setPayFxRate] = useState('1');
  const [payAllocs, setPayAllocs] = useState<Record<number, string>>({});

  // Purchase Requisition Modal
  const [isReqModalOpen, setIsReqModalOpen] = useState(false);
  const [reqVendorId, setReqVendorId] = useState<number>(0);
  const [reqItemId, setReqItemId] = useState('');
  const [reqDesc, setReqDesc] = useState('Raw material replenishment');
  const [reqQty, setReqQty] = useState('10');
  const [reqCost, setReqCost] = useState('0');
  const [reqNeededBy, setReqNeededBy] = useState('');
  const [reqNotes, setReqNotes] = useState('');
  const [convertTarget, setConvertTarget] = useState<any | null>(null);
  const [convertVendorId, setConvertVendorId] = useState<number>(0);

  // Goods Receipt Modal
  const [isGrModalOpen, setIsGrModalOpen] = useState(false);
  const [grPoId, setGrPoId] = useState<number>(0);
  const [grNotes, setGrNotes] = useState('');

  // Vendor Credit Modals
  const [isVcModalOpen, setIsVcModalOpen] = useState(false);
  const [vcVendorId, setVcVendorId] = useState<number>(0);
  const [vcDesc, setVcDesc] = useState('Damaged stock return credit');
  const [vcAmount, setVcAmount] = useState('0');
  const [applyVcTarget, setApplyVcTarget] = useState<any | null>(null);
  const [applyVcBillId, setApplyVcBillId] = useState<number>(0);
  const [applyVcAmt, setApplyVcAmt] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [bList, poList, bpList, vcList, vList, invList, acctList, reqList, grList, jobList] = await Promise.all([
        commercialApi.listBills(),
        commercialApi.listPurchaseOrders(),
        commercialApi.listBillPayments(),
        commercialApi.listVendorCredits(),
        commercialApi.listVendors(),
        commercialApi.listInventory(),
        accountingApi.listAccounts(),
        commercialApi.listRequisitions().catch(() => []),
        commercialApi.listGoodsReceipts().catch(() => []),
        printingApi.listJobs().catch(() => []),
      ]);
      setBills(bList);
      setPurchaseOrders(poList);
      setBillPayments(bpList);
      setVendorCredits(vcList);
      setRequisitions(reqList);
      setGoodsReceipts(grList);
      setPrintingJobs(jobList);
      setVendors(vList);
      setInventoryItems(invList);
      setAccounts(acctList);

      if (vList.length > 0 && !billVendorId) {
        setBillVendorId(vList[0].id);
        setPoVendorId(vList[0].id);
        setPayVendorId(vList[0].id);
        setVcVendorId(vList[0].id);
        setReqVendorId(vList[0].id);
        setConvertVendorId(vList[0].id);
      }
      const bankAccts = acctList.filter(a => a.account_type === 'Bank' && a.is_active);
      if (bankAccts.length > 0 && !payBankAcctId) {
        setPayBankAcctId(bankAccts[0].id);
      }
      const expAcct = acctList.find(a => (a.account_type === 'Expense' || a.account_type === 'CostOfGoodsSold') && a.is_active);
      if (expAcct) {
        setBillLines(prev => prev.map(l => (l.accountId === 0 ? { ...l, accountId: expAcct.id } : l)));
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to load purchasing ledger');
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id, billVendorId, payBankAcctId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const handler = () => loadData();
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, [loadData]);

  const bankAccounts = accounts.filter(a => a.account_type === 'Bank' && a.is_active);
  const expenseAndAssetAccts = accounts.filter(
    a => ['Expense', 'CostOfGoodsSold', 'Inventory', 'OtherCurrentAsset', 'FixedAsset'].includes(a.account_type) && a.is_active
  );
  const stockableItems = inventoryItems.filter(it => it.item_type === 'raw_material' || it.item_type === 'stationery');

  const filteredBills = bills.filter(b => {
    const q = searchQuery.toLowerCase();
    const matches =
      !q ||
      b.billNumber.toLowerCase().includes(q) ||
      b.vendorName.toLowerCase().includes(q) ||
      (b.memo && b.memo.toLowerCase().includes(q));
    if (!matches) return false;
    if (billFilter === 'open') return b.status !== 'voided' && b.balanceDue > 0;
    if (billFilter === 'paid') return b.status !== 'voided' && b.balanceDue === 0;
    if (billFilter === 'voided') return b.status === 'voided';
    return true;
  });

  const pagedBills = pageSlice(filteredBills, page, pageSize);

  const totalAp = bills.filter(b => b.status !== 'voided' && b.balanceDue > 0).reduce((s, b) => s + b.balanceDue, 0);

  const buildBillActionContext = (bill: ApiBill, pendingId?: string | null): ActionEligibilityContext<ApiBill> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'bills',
    entityType: 'bill',
    record: bill,
    recordStatus: bill.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const buildBillActionDefinitions = (bill: ApiBill): AdvancedActionDefinition<ApiBill>[] => {
    const canPay = bill.status !== 'voided' && bill.balanceDue > 0;
    const canVoid = bill.status !== 'voided' && bill.amountPaid === 0;
    return [
      ...(canWrite && canPay
        ? [
            {
              id: 'bill.pay',
              label: 'Pay Bill',
              icon: <DollarSign className="w-3.5 h-3.5 text-emerald-600" />,
              group: 'process',
              groupLabel: 'Payments',
              requiredPermission: 'bills:write',
              execute: async () => { openPayModalForBill(bill); },
            } as AdvancedActionDefinition<ApiBill>,
          ]
        : []),
      ...(canWrite && canVoid
        ? [
            {
              id: 'bill.void',
              label: 'Void Bill (Reverse GL)',
              icon: <Ban className="w-3.5 h-3.5 text-rose-600" />,
              group: 'danger',
              groupLabel: 'Sensitive operations',
              destructive: true,
              risk: 'destructive' as const,
              requiredPermission: 'bills:write',
              confirmation: {
                title: `Void ${bill.billNumber}`,
                message: 'Void this bill and reverse its GL impact using the authorized workflow.',
                confirmLabel: 'Void Bill',
                destructive: true,
              },
              idempotency: 'recommended' as const,
              execute: async (_ctx, helpers) => {
                try {
                  await commercialApi.voidBill(bill.id, helpers.reason || 'Voided from AP ledger');
                  triggerShortcutNotice(`Voided Bill ${bill.billNumber}`);
                  await loadData();
                } catch (err: any) {
                  setErrorMsg(err?.message);
                  throw err;
                }
              },
            } as AdvancedActionDefinition<ApiBill>,
          ]
        : []),
      {
        id: 'bill.copy-number',
        label: 'Copy Bill #',
        icon: <Copy className="w-3.5 h-3.5" />,
        group: 'admin',
        groupLabel: 'Other',
        requiredPermission: 'bills:read',
        execute: async () => {
          await navigator.clipboard?.writeText(bill.billNumber);
          triggerShortcutNotice(`Copied ${bill.billNumber}`);
        },
      },
    ];
  };

  const renderBillActions = (bill: ApiBill) => {
    const defs = buildBillActionDefinitions(bill);
    const ctx = buildBillActionContext(bill, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<ApiBill>
        label={`Actions for ${bill.billNumber}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={bill.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => {
          const def = action.definition;
          // handle confirmation for void
          if (def.confirmation) {
            const conf = typeof def.confirmation === 'function' ? def.confirmation(ctx, def) : def.confirmation;
            if (conf) {
              const msg = `${conf.message}${conf.impactSummary ? '\n\n' + conf.impactSummary : ''}`;
              if (conf.destructive || conf.requireReason) {
                const input = window.prompt(msg, '');
                if (input === null) return;
                const reason = (input || '').trim();
                if (conf.requireReason && !reason) throw new Error('A reason is required to continue');
                if (typeof def.execute === 'function') {
                  await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t), reason });
                }
                return;
              }
              const ok = window.confirm(msg);
              if (!ok) return;
            }
          }
          if (typeof def.execute === 'function') {
            await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) });
          }
        }}
      />
    );
  };

  const handleBillSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await commercialApi.createBill({
        vendorId: billVendorId,
        billNumber: billNumberInput.trim() || undefined,
        billDate,
        currencyCode: billCurrency,
        exchangeRate: billCurrency === baseCurrency ? 1 : Number(billFxRate || 1),
        memo: billMemo || undefined,
        lines: billLines.map(l => ({
          itemId: l.itemId ? Number(l.itemId) : undefined,
          accountId: l.accountId || undefined,
          description: l.description.trim() || 'Supplier Purchase',
          quantity: l.quantity || '1',
          unitCost: l.unitCost || '0',
          useTaxRate: l.useTaxRate || '0',
        })),
      });
      triggerShortcutNotice(`Posted Bill ${res.billNumber} to Accounts Payable & GL`);
      setIsBillModalOpen(false);
      setBillNumberInput('');
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to post bill');
    } finally {
      setBusy(false);
    }
  };

  const handlePoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      const po = await commercialApi.createPurchaseOrder({
        vendorId: poVendorId,
        poDate,
        notes: poNotes || undefined,
        lines: poLines.map(l => ({
          itemId: l.itemId ? Number(l.itemId) : undefined,
          description: l.description.trim() || 'Purchase line',
          quantity: l.quantity || '1',
          rate: l.rate || '0',
        })),
      });
      triggerShortcutNotice(`Created Purchase Order ${po.poNumber}`);
      setIsPoModalOpen(false);
      setPoNotes('');
      setPoLines([{ itemId: '', description: 'Printing Raw Stock Order', quantity: '10', rate: '120' }]);
      setActiveTab('purchaseOrders');
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to create PO');
    } finally {
      setBusy(false);
    }
  };

  const openPayModalForBill = (bill?: ApiBill) => {
    const vid = bill ? bill.vendorId : vendors[0]?.id || 0;
    setPayVendorId(vid);
    setPayCurrency(bill?.currencyCode || 'ZMW');
    setPayFxRate(String(bill?.exchangeRate || 1));
    setPayAllocs(bill ? { [bill.id]: String(bill.balanceDue) } : {});
    setIsPayModalOpen(true);
  };

  const openBillsForPayVendor = bills.filter(b => b.vendorId === payVendorId && b.status !== 'voided' && b.balanceDue > 0);

  const handlePayBillsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const allocs = Object.entries(payAllocs)
      .filter(([, amt]) => Number(amt) > 0)
      .map(([billId, amount]) => ({ billId: Number(billId), amount }));
    if (allocs.length === 0) {
      setErrorMsg('Enter a payment amount on at least one open bill.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const bp = await commercialApi.recordBillPayment({
        vendorId: payVendorId,
        paymentDate: payDate,
        bankAccountId: payBankAcctId || undefined,
        checkNumber: payCheckNum.trim() || undefined,
        currencyCode: payCurrency,
        exchangeRate: payCurrency === baseCurrency ? 1 : Number(payFxRate || 1),
        allocations: allocs,
      });
      triggerShortcutNotice(`Disbursed Bill Payment ${bp.paymentNumber} (${bp.checkNumber || 'EFT'})`);
      setIsPayModalOpen(false);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Bill payment failed');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateVc = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      const vc = await commercialApi.createVendorCredit({
        vendorId: vcVendorId,
        lines: [{ description: vcDesc, quantity: '1', rate: vcAmount }],
      });
      triggerShortcutNotice(`Posted Vendor Credit ${vc.creditNumber}`);
      setIsVcModalOpen(false);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Vendor credit failed');
    } finally {
      setBusy(false);
    }
  };

  const handleApplyVc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!applyVcTarget || !applyVcBillId) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.applyVendorCredit(applyVcTarget.id, { billId: applyVcBillId, amount: applyVcAmt });
      triggerShortcutNotice(`Applied Vendor Credit ${applyVcTarget.creditNumber}`);
      setApplyVcTarget(null);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to apply vendor credit');
    } finally {
      setBusy(false);
    }
  };

  const handleRequisitionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      const req = await commercialApi.createRequisition({
        reqDate: new Date().toISOString().slice(0, 10),
        neededByDate: reqNeededBy || null,
        demandSource: 'manual',
        notes: reqNotes || null,
        lines: [
          {
            itemId: reqItemId ? Number(reqItemId) : null,
            preferredVendorId: reqVendorId || null,
            description: reqDesc.trim() || 'Material purchase',
            quantity: reqQty || '1',
            estimatedUnitCost: reqCost || '0',
          },
        ],
      });
      triggerShortcutNotice(`Submitted Purchase Requisition ${req.requisitionNumber}`);
      setIsReqModalOpen(false);
      setReqNotes('');
      setActiveTab('requisitions');
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to create requisition');
    } finally {
      setBusy(false);
    }
  };

  const handleApproveRequisition = async (req: any) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.approveRequisition(req.id, 'Approved in purchasing workspace');
      triggerShortcutNotice(`Approved Requisition ${req.requisitionNumber}`);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to approve requisition');
    } finally {
      setBusy(false);
    }
  };

  const handleConvertRequisition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!convertTarget || !convertVendorId) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await commercialApi.convertRequisitionToPo(convertTarget.id, {
        vendorId: convertVendorId,
      });
      triggerShortcutNotice(
        `Converted ${convertTarget.requisitionNumber} -> ${res.purchaseOrder?.poNumber || 'Purchase Order'}`
      );
      setConvertTarget(null);
      setActiveTab('purchaseOrders');
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to convert requisition');
    } finally {
      setBusy(false);
    }
  };

  const handleGoodsReceiptSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!grPoId) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await commercialApi.recordGoodsReceipt({
        purchaseOrderId: grPoId,
        receiptDate: new Date().toISOString().slice(0, 10),
        notes: grNotes || null,
      });
      triggerShortcutNotice(
        `Recorded goods receipt ${res.goodsReceipt?.receiptNumber || ''} (${res.poStatus || 'received'})`
      );
      setIsGrModalOpen(false);
      setGrNotes('');
      setActiveTab('goodsReceipts');
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to record goods receipt');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            Purchasing, Bills & Accounts Payable (A/P)
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Live PostgreSQL Purchase Orders, Inventory Receipts (with Raw Material unit conversion), Vendor Bills, Check Runs & Credits.
          </p>
        </div>

        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setIsReqModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold"
            >
              <ClipboardList className="w-3.5 h-3.5" /> New Requisition
            </button>
            <button
              onClick={() => setIsPoModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold"
            >
              <FilePlus className="w-3.5 h-3.5" /> New PO
            </button>
            <button
              onClick={() => openPayModalForBill()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 text-xs font-semibold"
            >
              <DollarSign className="w-3.5 h-3.5" /> Pay Bills
            </button>
            <button
              onClick={() => setIsBillModalOpen(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold text-xs shadow-sm"
            >
              <Plus className="w-4 h-4" /> Enter Bill
            </button>
          </div>
        )}
      </div>

      {errorMsg && (
        <div role="alert" className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 text-rose-800 dark:text-rose-200 text-xs flex items-center justify-between">
          <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="underline">Dismiss</button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase">Total Outstanding A/P</div>
            <div className="text-xl font-bold font-mono text-rose-600 dark:text-rose-400 mt-1 tabular-nums">
              {formatCurrency(totalAp, currency)}
            </div>
          </div>
          <Receipt className="w-6 h-6 text-rose-500" />
        </div>
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase">Open Purchase Orders</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {purchaseOrders.filter(p => p.status === 'open' || p.status === 'partial').length}
            </div>
          </div>
          <Clock className="w-6 h-6 text-amber-500" />
        </div>
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase">Active Suppliers</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {vendors.length}
            </div>
          </div>
          <Building2 className="w-6 h-6 text-blue-500" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-2 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-semibold">
          {(
            [
              ['bills', `Bills (${bills.length})`],
              ['purchaseOrders', `Purchase Orders (${purchaseOrders.length})`],
              ['requisitions', `Requisitions (${requisitions.length})`],
              ['goodsReceipts', `Goods Receipts (${goodsReceipts.length})`],
              ['payments', `Bill Payments (${billPayments.length})`],
              ['vendorCredits', `Vendor Credits (${vendorCredits.length})`],
            ] as Array<[PurchasingTab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                activeTab === id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs' : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search bills, POs, vendors..."
            className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-850 text-xs outline-none"
          />
        </div>
      </div>

      {loading ? (
        <div className="py-12 flex items-center justify-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading accounts payable ledger...
        </div>
      ) : (
        <>
          {/* BILLS */}
          {activeTab === 'bills' && (
            <div className="space-y-3">
              <div className="flex items-center gap-1.5 text-xs">
                {(['open', 'all', 'paid', 'voided'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setBillFilter(f)}
                    className={`px-3 py-1 rounded-md border text-[11px] font-semibold capitalize ${
                      billFilter === f ? 'bg-[#0f3d63] text-white border-[#0f3d63]' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="px-4 py-3">BILL #</th>
                        <th className="px-4 py-3">VENDOR</th>
                        <th className="px-4 py-3">BILL DATE</th>
                        <th className="px-4 py-3">DUE DATE</th>
                        <th className="px-4 py-3 text-right">TOTAL</th>
                        <th className="px-4 py-3 text-right">PAID</th>
                        <th className="px-4 py-3 text-right">BALANCE DUE</th>
                        <th className="px-4 py-3 text-center">STATUS</th>
                        <th className="px-4 py-3 text-right">ACTIONS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                      {pagedBills.map(bill => (
                        <tr key={bill.id} className={`hover:bg-slate-50 dark:hover:bg-slate-850/50 ${bill.status === 'voided' ? 'opacity-60' : ''}`}>
                          <td className="px-4 py-3 font-bold text-slate-900 dark:text-white">
                            {bill.billNumber}
                            {bill.currencyCode !== baseCurrency && (
                              <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">{bill.currencyCode}</span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-sans font-semibold">{bill.vendorName}</td>
                          <td className="px-4 py-3 text-slate-500">{bill.billDate}</td>
                          <td className="px-4 py-3 text-slate-500">{bill.dueDate}</td>
                          <td className="px-4 py-3 text-right font-bold tabular-nums">{formatCurrency(bill.total, currency)}</td>
                          <td className="px-4 py-3 text-right text-emerald-600 tabular-nums">{formatCurrency(bill.amountPaid, currency)}</td>
                          <td className="px-4 py-3 text-right font-bold text-rose-600 tabular-nums">{formatCurrency(bill.balanceDue, currency)}</td>
                          <td className="px-4 py-3 text-center font-sans uppercase text-[10px] font-bold">{bill.status}</td>
                          <td className="px-4 py-3 text-right font-sans">
                            {renderBillActions(bill)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={filteredBills.length}
                  onPageChange={setPage}
                  onPageSizeChange={size => {
                    setPageSize(size);
                    setPage(1);
                  }}
                  label="bills"
                />
              </div>
            </div>
          )}

          {/* PURCHASE ORDERS */}
          {activeTab === 'purchaseOrders' && (
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase text-[10px] font-bold border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-3">PO #</th>
                      <th className="px-4 py-3">VENDOR</th>
                      <th className="px-4 py-3">PO DATE</th>
                      <th className="px-4 py-3">EXPECTED</th>
                      <th className="px-4 py-3 text-right">TOTAL</th>
                      <th className="px-4 py-3 text-center">STATUS</th>
                      <th className="px-4 py-3 text-right">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                    {purchaseOrders.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-8 text-center font-sans text-slate-400">No purchase orders created.</td></tr>
                    ) : (
                      purchaseOrders.map(po => (
                        <tr key={po.id}>
                          <td className="px-4 py-3 font-bold text-blue-600">{po.poNumber}</td>
                          <td className="px-4 py-3 font-sans font-semibold">{po.vendorName}</td>
                          <td className="px-4 py-3 text-slate-500">{po.poDate}</td>
                          <td className="px-4 py-3 text-slate-500">{po.expectedDate || '—'}</td>
                          <td className="px-4 py-3 text-right font-bold tabular-nums">{formatCurrency(po.total, currency)}</td>
                          <td className="px-4 py-3 text-center font-sans uppercase text-[10px] font-bold">{po.status}</td>
                          <td className="px-4 py-3 text-right font-sans">
                            {canWrite && po.status !== 'closed' && po.status !== 'cancelled' && (
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  onClick={async () => {
                                    setBusy(true);
                                    setErrorMsg(null);
                                    try {
                                      const res = await commercialApi.receivePurchaseOrder(po.id, {});
                                      triggerShortcutNotice(`Received ${po.poNumber} -> Bill ${res.bill?.billNumber}`);
                                      await loadData();
                                    } catch (err: any) {
                                      setErrorMsg(err?.message);
                                      triggerShortcutNotice(err?.message || 'Receive failed', 'error');
                                    } finally {
                                      setBusy(false);
                                    }
                                  }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold"
                                >
                                  <PackageCheck className="w-3.5 h-3.5" /> Receive to Bill
                                </button>
                                <button
                                  onClick={async () => {
                                    setBusy(true);
                                    setErrorMsg(null);
                                    try {
                                      const res = await commercialApi.createBillFromPurchaseOrder(po.id, {});
                                      triggerShortcutNotice(
                                        `Billed ${po.poNumber} -> Bill ${res.bill?.billNumber || ''} (3-way match)`
                                      );
                                      await loadData();
                                    } catch (err: any) {
                                      setErrorMsg(err?.message);
                                      triggerShortcutNotice(err?.message || 'Could not bill this purchase order', 'error');
                                    } finally {
                                      setBusy(false);
                                    }
                                  }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold"
                                  title="Create the supplier bill from received quantities (3-way match against goods receipts)"
                                >
                                  <FileText className="w-3.5 h-3.5" /> Bill from PO
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* PURCHASE REQUISITIONS */}
          {activeTab === 'requisitions' && (
            <div className="surface overflow-hidden">
              <div className="surface-header">
                <div>
                  <h2 className="section-title flex items-center gap-2">
                    <ClipboardList className="w-4 h-4 text-blue-600" /> Purchase Requisitions
                  </h2>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Approval-gated demand requests that convert into purchase orders.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={shortfallJobId}
                    onChange={e => setShortfallJobId(e.target.value ? Number(e.target.value) : '')}
                    disabled={!canWrite || busy}
                    className="app-input app-input-mono max-w-[220px]"
                    title="Printing job whose material shortfall should raise a requisition"
                  >
                    <option value="">Select a printing job…</option>
                    {printingJobs.map(j => (
                      <option key={j.id} value={j.id}>
                        {j.jobNumber} — {j.title || j.customerName || `Job #${j.id}`}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={async () => {
                      if (!shortfallJobId) {
                        setErrorMsg('Select a printing job first.');
                        return;
                      }
                      setBusy(true);
                      setErrorMsg(null);
                      try {
                        const res = await commercialApi.generateDemandRequisitions({ jobId: Number(shortfallJobId) });
                        triggerShortcutNotice(
                          res.generated
                            ? 'Generated a material shortfall requisition for the selected job'
                            : 'That job has no material shortfall against current stock',
                          res.generated ? 'success' : 'info'
                        );
                        await loadData();
                      } catch (err: any) {
                        setErrorMsg(err?.message || 'Job shortfall scan failed');
                        triggerShortcutNotice(err?.message || 'Job shortfall scan failed', 'error');
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={!canWrite || busy}
                    className="btn btn-secondary"
                    title="Raise a requisition for raw material still required by the selected printing job"
                  >
                    <Package className="w-3.5 h-3.5" /> Job shortfall
                  </button>
                  <button
                    onClick={async () => {
                      setBusy(true);
                      setErrorMsg(null);
                      try {
                        const res = await commercialApi.generateDemandRequisitions({});
                        triggerShortcutNotice(
                          res.generated
                            ? `Generated demand requisition from stock reorder levels`
                            : 'No items are currently below their reorder point',
                          res.generated ? 'success' : 'info'
                        );
                        await loadData();
                      } catch (err: any) {
                        setErrorMsg(err?.message || 'Demand scan failed');
                        triggerShortcutNotice(err?.message || 'Demand scan failed', 'error');
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={!canWrite || busy}
                    className="btn btn-secondary"
                    title="Generate requisitions for every stocked item below its reorder point"
                  >
                    <Package className="w-3.5 h-3.5" /> Scan reorder levels
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>REQUISITION #</th>
                      <th>DATE</th>
                      <th>NEEDED BY</th>
                      <th>SOURCE</th>
                      <th className="text-right">EST. VALUE</th>
                      <th>LINES</th>
                      <th>STATUS</th>
                      <th className="text-right">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {requisitions.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center font-sans text-slate-400">
                          No purchase requisitions yet. Create one or scan reorder levels.
                        </td>
                      </tr>
                    ) : (
                      requisitions.map((req: any) => {
                        const estValue = (req.lines || []).reduce(
                          (sum: number, l: any) => sum + Number(l.quantity || 0) * Number(l.estimatedUnitCost || 0),
                          0
                        );
                        const canApprove = ['draft', 'submitted'].includes(String(req.status));
                        const canConvert = String(req.status) === 'approved';
                        return (
                          <tr key={req.id}>
                            <td className="font-bold text-blue-600 dark:text-blue-400">{req.requisitionNumber}</td>
                            <td className="text-slate-500">{req.reqDate}</td>
                            <td className="text-slate-500">{req.neededByDate || '—'}</td>
                            <td className="font-sans capitalize">{String(req.demandSource || 'manual').replace('_', ' ')}</td>
                            <td className="text-right font-bold tabular-nums">{formatCurrency(estValue, currency)}</td>
                            <td className="font-sans text-slate-600 dark:text-slate-300">
                              {(req.lines || []).length} line(s)
                              {(req.lines || [])[0] && (
                                <span className="block text-[10px] text-slate-400 truncate max-w-[220px]">
                                  {(req.lines || [])[0].description}
                                </span>
                              )}
                            </td>
                            <td>
                              <span
                                className={`badge ${
                                  canConvert
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                    : String(req.status) === 'converted'
                                    ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                                    : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                                }`}
                              >
                                {req.status}
                              </span>
                            </td>
                            <td className="text-right font-sans">
                              <div className="inline-flex items-center gap-1.5">
                                {canWrite && canApprove && (
                                  <button
                                    onClick={() => handleApproveRequisition(req)}
                                    disabled={busy}
                                    className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
                                  >
                                    <CheckCircle2 className="w-3 h-3" /> Approve
                                  </button>
                                )}
                                {canWrite && canConvert && (
                                  <button
                                    onClick={() => {
                                      const preferred =
                                        (req.lines || []).find((l: any) => l.preferredVendorId)?.preferredVendorId ||
                                        vendors[0]?.id ||
                                        0;
                                      setConvertVendorId(preferred);
                                      setConvertTarget(req);
                                    }}
                                    disabled={busy}
                                    className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-blue-500 disabled:opacity-50"
                                  >
                                    <ArrowRight className="w-3 h-3" /> Convert to PO
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* GOODS RECEIPTS */}
          {activeTab === 'goodsReceipts' && (
            <div className="surface overflow-hidden">
              <div className="surface-header">
                <div>
                  <h2 className="section-title flex items-center gap-2">
                    <Package className="w-4 h-4 text-emerald-600" /> Goods Receipts
                  </h2>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Physical receipts recorded against open purchase orders; receiving stock does not post a supplier bill.
                  </p>
                </div>
                <button
                  onClick={() => {
                    const openPo = purchaseOrders.find(p => p.status !== 'closed' && p.status !== 'cancelled');
                    setGrPoId(openPo?.id || 0);
                    setIsGrModalOpen(true);
                  }}
                  disabled={!canWrite}
                  className="btn btn-emerald"
                >
                  <PackageCheck className="w-3.5 h-3.5" /> Record Receipt
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>RECEIPT #</th>
                      <th>PURCHASE ORDER</th>
                      <th>VENDOR</th>
                      <th>RECEIPT DATE</th>
                      <th>LINES</th>
                      <th>STATUS</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {goodsReceipts.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center font-sans text-slate-400">
                          No goods receipts recorded yet.
                        </td>
                      </tr>
                    ) : (
                      goodsReceipts.map((gr: any) => (
                        <tr key={gr.id}>
                          <td className="font-bold text-blue-600 dark:text-blue-400">{gr.receiptNumber}</td>
                          <td className="font-sans font-semibold">{gr.poNumber}</td>
                          <td className="font-sans">{gr.vendorName}</td>
                          <td className="text-slate-500">{gr.receiptDate}</td>
                          <td className="font-sans text-slate-600 dark:text-slate-300">
                            {(gr.lines || []).length} line(s)
                            {(gr.lines || [])[0] && (
                              <span className="block text-[10px] text-slate-400 truncate max-w-[240px]">
                                {(gr.lines || [])[0].description} · {Number((gr.lines || [])[0].quantityReceived || 0)}
                              </span>
                            )}
                          </td>
                          <td>
                            <span className="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                              {gr.status || 'received'}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* BILL PAYMENTS */}
          {activeTab === 'payments' && (
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase text-[10px] font-bold border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-3">PAYMENT #</th>
                      <th className="px-4 py-3">VENDOR</th>
                      <th className="px-4 py-3">DATE</th>
                      <th className="px-4 py-3">CHECK / REF</th>
                      <th className="px-4 py-3">BANK ACCOUNT</th>
                      <th className="px-4 py-3 text-right">AMOUNT</th>
                      <th className="px-4 py-3 text-center">STATUS</th>
                      <th className="px-4 py-3 text-right">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                    {billPayments.map(bp => (
                      <tr key={bp.id} className={bp.isVoided ? 'opacity-60' : ''}>
                        <td className="px-4 py-3 font-bold text-blue-600">{bp.paymentNumber}</td>
                        <td className="px-4 py-3 font-sans font-semibold">{bp.vendorName}</td>
                        <td className="px-4 py-3 text-slate-500">{bp.paymentDate}</td>
                        <td className="px-4 py-3">{bp.checkNumber || 'EFT'}</td>
                        <td className="px-4 py-3 font-sans">{bp.bankAccountName}</td>
                        <td className="px-4 py-3 text-right font-bold tabular-nums">{formatCurrency(bp.amount, currency)}</td>
                        <td className="px-4 py-3 text-center font-sans text-[10px] font-bold uppercase">{bp.isVoided ? 'Voided' : 'Posted'}</td>
                        <td className="px-4 py-3 text-right font-sans">
                          {canWrite && !bp.isVoided && (
                            <button
                              onClick={async () => {
                                try {
                                  await commercialApi.voidBillPayment(bp.id, 'Voided by user');
                                  triggerShortcutNotice(`Voided ${bp.paymentNumber} & reversed GL`);
                                  await loadData();
                                } catch (err: any) {
                                  setErrorMsg(err?.message);
                                }
                              }}
                              className="px-2 py-1 rounded border border-rose-300 text-rose-700 text-[11px] font-semibold"
                            >
                              Void
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* VENDOR CREDITS */}
          {activeTab === 'vendorCredits' && (
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <span className="text-xs font-bold">Supplier Vendor Credits</span>
                {canWrite && (
                  <button onClick={() => setIsVcModalOpen(true)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold flex items-center gap-1">
                    <Plus className="w-3.5 h-3.5" /> New Vendor Credit
                  </button>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase text-[10px] font-bold border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-3">CREDIT #</th>
                      <th className="px-4 py-3">VENDOR</th>
                      <th className="px-4 py-3">DATE</th>
                      <th className="px-4 py-3 text-right">TOTAL</th>
                      <th className="px-4 py-3 text-right">REMAINING</th>
                      <th className="px-4 py-3 text-center">STATUS</th>
                      <th className="px-4 py-3 text-right">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                    {vendorCredits.map(vc => (
                      <tr key={vc.id}>
                        <td className="px-4 py-3 font-bold text-blue-600">{vc.creditNumber}</td>
                        <td className="px-4 py-3 font-sans font-semibold">{vc.vendorName}</td>
                        <td className="px-4 py-3 text-slate-500">{vc.creditDate}</td>
                        <td className="px-4 py-3 text-right font-bold tabular-nums">{formatCurrency(vc.total, currency)}</td>
                        <td className="px-4 py-3 text-right font-bold text-emerald-600 tabular-nums">{formatCurrency(vc.remainingCredit, currency)}</td>
                        <td className="px-4 py-3 text-center font-sans text-[10px] font-bold uppercase">{vc.status}</td>
                        <td className="px-4 py-3 text-right font-sans">
                          {canWrite && vc.status === 'open' && vc.remainingCredit > 0 && (
                            <button
                              onClick={() => {
                                const openB = bills.filter(b => b.vendorId === vc.vendorId && b.status !== 'voided' && b.balanceDue > 0);
                                setApplyVcTarget(vc);
                                setApplyVcBillId(openB[0]?.id || 0);
                                setApplyVcAmt(String(Math.min(vc.remainingCredit, openB[0]?.balanceDue || vc.remainingCredit)));
                              }}
                              className="px-2.5 py-1 rounded bg-blue-600 text-white text-[11px] font-bold"
                            >
                              Apply to Bill
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ENTER BILL MODAL */}
      {isBillModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Enter Supplier Bill (Posts to AP & Inventory/GL)</span>
              <button onClick={() => setIsBillModalOpen(false)} className="p-1 text-white/80 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleBillSubmit} className="p-5 space-y-4 overflow-y-auto text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="sm:col-span-2">
                  <label className="font-semibold block mb-1">Vendor *</label>
                  <select value={billVendorId} onChange={e => setBillVendorId(Number(e.target.value))} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.companyName}</option>)}
                  </select>
                </div>
                <div>
                  <label className="font-semibold block mb-1">Vendor Bill #</label>
                  <input type="text" value={billNumberInput} onChange={e => setBillNumberInput(e.target.value)} placeholder="Auto if blank" className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Bill Date</label>
                  <input type="date" value={billDate} onChange={e => setBillDate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Currency</label>
                  <select
                    value={billCurrency}
                    onChange={e => {
                      setBillCurrency(e.target.value);
                      if (e.target.value === baseCurrency) setBillFxRate('1');
                      else {
                        const known = fxRateFor(e.target.value);
                        if (known) setBillFxRate(String(known));
                      }
                    }}
                    className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950"
                  >
                    {fxOptions.map(o => (
                      <option key={o.code} value={o.code}>{o.label}</option>
                    ))}
                  </select>
                </div>
                {billCurrency !== baseCurrency && (
                  <div>
                    <label className="font-semibold block mb-1">FX Rate</label>
                    <input type="number" step="0.0001" value={billFxRate} onChange={e => setBillFxRate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                  </div>
                )}
                <div>
                  <label className="font-semibold block mb-1">Memo</label>
                  <input type="text" value={billMemo} onChange={e => setBillMemo(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950" />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between font-bold">
                  <span>Expense / Inventory Receipt Lines</span>
                  <button
                    type="button"
                    onClick={() =>
                      setBillLines(prev => [
                        ...prev,
                        { itemId: '', accountId: expenseAndAssetAccts[0]?.id || 0, description: '', quantity: '1', unitCost: '0', useTaxRate: '0' },
                      ])
                    }
                    className="text-blue-600 hover:underline flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Line
                  </button>
                </div>
                {billLines.map((l, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center p-2 rounded bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800">
                    <div className="col-span-3">
                      <select
                        value={l.itemId}
                        onChange={e => {
                          const it = stockableItems.find(x => String(x.id) === e.target.value);
                          setBillLines(prev =>
                            prev.map((row, i) =>
                              i !== idx ? row : { ...row, itemId: e.target.value, description: it ? it.name : row.description }
                            )
                          );
                        }}
                        className="w-full border rounded px-1.5 py-1.5 bg-white dark:bg-slate-950"
                      >
                        <option value="">Expense Account Only</option>
                        {stockableItems.map(it => (
                          <option key={it.id} value={it.id}>{it.name} ({it.purchase_unit})</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-3">
                      <select
                        value={l.accountId}
                        onChange={e => setBillLines(prev => prev.map((r, i) => (i === idx ? { ...r, accountId: Number(e.target.value) } : r)))}
                        className="w-full border rounded px-1.5 py-1.5 bg-white dark:bg-slate-950"
                      >
                        {expenseAndAssetAccts.map(a => (
                          <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <input type="text" placeholder="Desc" value={l.description} onChange={e => setBillLines(prev => prev.map((r, i) => (i === idx ? { ...r, description: e.target.value } : r)))} className="w-full border rounded px-1.5 py-1.5 bg-white dark:bg-slate-950" required />
                    </div>
                    <div className="col-span-1">
                      <input type="number" step="0.01" placeholder="Qty" value={l.quantity} onChange={e => setBillLines(prev => prev.map((r, i) => (i === idx ? { ...r, quantity: e.target.value } : r)))} className="w-full border rounded px-1.5 py-1.5 bg-white dark:bg-slate-950 font-mono text-right" />
                    </div>
                    <div className="col-span-2">
                      <input type="number" step="0.01" placeholder="Cost" value={l.unitCost} onChange={e => setBillLines(prev => prev.map((r, i) => (i === idx ? { ...r, unitCost: e.target.value } : r)))} className="w-full border rounded px-1.5 py-1.5 bg-white dark:bg-slate-950 font-mono text-right" />
                    </div>
                    <div className="col-span-1">
                      <input type="number" step="0.01" title="Use Tax %" placeholder="Tax%" value={l.useTaxRate} onChange={e => setBillLines(prev => prev.map((r, i) => (i === idx ? { ...r, useTaxRate: e.target.value } : r)))} className="w-full border rounded px-1 py-1.5 bg-white dark:bg-slate-950 font-mono text-right" />
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button type="button" onClick={() => setIsBillModalOpen(false)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy} className="px-5 py-2 rounded bg-blue-600 text-white font-bold">
                  {busy ? 'Posting...' : 'Post Bill to AP'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE PO MODAL */}
      {isPoModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Create Purchase Order</span>
              <button onClick={() => setIsPoModalOpen(false)} className="p-1 text-white/80 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handlePoSubmit} className="p-5 space-y-4 overflow-y-auto text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Vendor</label>
                  <select value={poVendorId} onChange={e => setPoVendorId(Number(e.target.value))} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.companyName}</option>)}
                  </select>
                </div>
                <div>
                  <label className="font-semibold block mb-1">Order Date</label>
                  <input type="date" value={poDate} onChange={e => setPoDate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Notes</label>
                  <input type="text" value={poNotes} onChange={e => setPoNotes(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950" />
                </div>
              </div>

              <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px]">
                    <colgroup>
                      <col style={{ width: '5%' }} />
                      <col style={{ width: '41%' }} />
                      <col style={{ width: '10%' }} />
                      <col style={{ width: '15%' }} />
                      <col style={{ width: '19%' }} />
                      <col style={{ width: '10%' }} />
                    </colgroup>
                    <thead>
                      <tr className="bg-slate-100 dark:bg-slate-800/60 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        <th className="px-2 py-2 text-center">Sn</th>
                        <th className="px-3 py-2 text-left">Description</th>
                        <th className="px-2 py-2 text-center">Qty</th>
                        <th className="px-2 py-2 text-right">Unit Cost</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-2 py-2 text-center"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {poLines.map((l, idx) => (
                        <tr key={idx} className="align-top hover:bg-slate-50 dark:hover:bg-slate-850/50 transition-colors">
                          <td className="px-2 py-2 text-center font-mono text-[11px] text-slate-400">{idx + 1}</td>
                          <td className="px-3 py-2">
                            <select
                              value={l.itemId}
                              onChange={e => {
                                const it = stockableItems.find(x => String(x.id) === e.target.value);
                                setPoLines(prev =>
                                  prev.map((row, i) =>
                                    i === idx ? { ...row, itemId: e.target.value, description: it ? it.name : row.description } : row
                                  )
                                );
                              }}
                              className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100"
                            >
                              <option value="">-- Custom Item --</option>
                              {stockableItems.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                            </select>
                            <input
                              type="text"
                              value={l.description}
                              onChange={e => setPoLines(prev => prev.map((row, i) => (i === idx ? { ...row, description: e.target.value } : row)))}
                              placeholder="Line description"
                              className="mt-1 w-full bg-transparent border-0 border-b border-transparent px-1 py-1 text-[11px] text-slate-600 dark:text-slate-300 outline-none focus:border-blue-500"
                              required
                            />
                          </td>
                          <td className="px-2 py-2">
                            <input type="number" min="1" step="0.01" value={l.quantity} onChange={e => setPoLines(prev => prev.map((row, i) => (i === idx ? { ...row, quantity: e.target.value } : row)))} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-xs font-mono text-center tabular-nums" />
                          </td>
                          <td className="px-2 py-2">
                            <input type="number" min="0" step="0.01" value={l.rate} onChange={e => setPoLines(prev => prev.map((row, i) => (i === idx ? { ...row, rate: e.target.value } : row)))} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-xs font-mono text-right tabular-nums" />
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums text-slate-900 dark:text-white whitespace-nowrap">
                            {formatCurrency((Number(l.quantity) || 0) * (Number(l.rate) || 0), currency)}
                          </td>
                          <td className="px-2 py-2 text-center">
                            {poLines.length > 1 && (
                              <button type="button" onClick={() => setPoLines(prev => prev.filter((_, i) => i !== idx))} className="p-1 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors" title="Remove line">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800">
                  <button type="button" onClick={() => setPoLines(prev => [...prev, { itemId: '', description: '', quantity: '1', rate: '0' }])} className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-800 px-2 py-1">
                    <Plus className="w-3.5 h-3.5" /><span>Add Line</span>
                  </button>
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    Total: <span className="font-bold text-slate-900 dark:text-white">{formatCurrency(poLines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.rate) || 0), 0), currency)}</span>
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button type="button" onClick={() => setIsPoModalOpen(false)} className="px-4 py-2 rounded border border-slate-300 dark:border-slate-700">Cancel</button>
                <button type="submit" disabled={busy} className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white font-bold disabled:opacity-50">Save PO</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PAY BILLS MODAL */}
      {isPayModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Pay Supplier Bills</span>
              <button onClick={() => setIsPayModalOpen(false)} className="p-1 text-white/80 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handlePayBillsSubmit} className="p-5 space-y-4 overflow-y-auto text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Vendor</label>
                  <select value={payVendorId} onChange={e => { setPayVendorId(Number(e.target.value)); setPayAllocs({}); }} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.companyName}</option>)}
                  </select>
                </div>
                <div>
                  <label className="font-semibold block mb-1">Pay From Bank Account</label>
                  <select value={payBankAcctId} onChange={e => setPayBankAcctId(Number(e.target.value))} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.code} - {b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="font-semibold block mb-1">Payment Date</label>
                  <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Check # (optional)</label>
                  <input type="text" value={payCheckNum} onChange={e => setPayCheckNum(e.target.value)} placeholder="Auto-sequence if blank" className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Currency</label>
                  <select
                    value={payCurrency}
                    onChange={e => {
                      setPayCurrency(e.target.value);
                      if (e.target.value === baseCurrency) setPayFxRate('1');
                      else {
                        const known = fxRateFor(e.target.value);
                        if (known) setPayFxRate(String(known));
                      }
                    }}
                    className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950"
                  >
                    {fxOptions.map(o => (
                      <option key={o.code} value={o.code}>{o.code}</option>
                    ))}
                  </select>
                </div>
                {payCurrency !== baseCurrency && (
                  <div>
                    <label className="font-semibold block mb-1">FX Rate</label>
                    <input type="number" step="0.0001" value={payFxRate} onChange={e => setPayFxRate(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                  </div>
                )}
              </div>

              <div className="border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 font-bold text-[11px] uppercase">Open Bills for Vendor</div>
                <div className="divide-y max-h-48 overflow-y-auto">
                  {openBillsForPayVendor.length === 0 ? (
                    <div className="p-4 text-center text-slate-400">No open bills for selected vendor.</div>
                  ) : (
                    openBillsForPayVendor.map(b => (
                      <div key={b.id} className="p-2.5 flex items-center justify-between">
                        <div>
                          <div className="font-mono font-bold">{b.billNumber}</div>
                          <div className="text-[11px] text-slate-500">Due {b.dueDate} · Balance: {formatCurrency(b.balanceDue, currency)}</div>
                        </div>
                        <input
                          type="number"
                          step="0.01"
                          value={payAllocs[b.id] || ''}
                          placeholder="0.00"
                          onChange={e => setPayAllocs(prev => ({ ...prev, [b.id]: e.target.value }))}
                          className="w-32 border rounded px-2 py-1 text-right font-mono bg-white dark:bg-slate-950"
                        />
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <button type="button" onClick={() => setIsPayModalOpen(false)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy} className="px-5 py-2 rounded bg-emerald-600 text-white font-bold">
                  {busy ? 'Disbursing...' : 'Post Payment & Check'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* VENDOR CREDIT & APPLY MODALS */}
      {isVcModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Record Vendor Credit</span>
              <button onClick={() => setIsVcModalOpen(false)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleCreateVc} className="p-5 space-y-3 text-xs">
              <div>
                <label className="font-semibold block mb-1">Vendor</label>
                <select value={vcVendorId} onChange={e => setVcVendorId(Number(e.target.value))} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.companyName}</option>)}
                </select>
              </div>
              <div>
                <label className="font-semibold block mb-1">Description</label>
                <input type="text" value={vcDesc} onChange={e => setVcDesc(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950" required />
              </div>
              <div>
                <label className="font-semibold block mb-1">Credit Amount</label>
                <input type="number" step="0.01" value={vcAmount} onChange={e => setVcAmount(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" required />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <button type="button" onClick={() => setIsVcModalOpen(false)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy} className="px-4 py-2 rounded bg-blue-600 text-white font-bold">Post Vendor Credit</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {applyVcTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Apply {applyVcTarget.creditNumber} to Bill</span>
              <button onClick={() => setApplyVcTarget(null)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleApplyVc} className="p-5 space-y-3 text-xs">
              <div>
                <label className="font-semibold block mb-1">Open Vendor Bill</label>
                <select value={applyVcBillId} onChange={e => setApplyVcBillId(Number(e.target.value))} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950" required>
                  <option value={0}>Select bill...</option>
                  {bills
                    .filter(b => b.vendorId === applyVcTarget.vendorId && b.status !== 'voided' && b.balanceDue > 0)
                    .map(b => (
                      <option key={b.id} value={b.id}>{b.billNumber} (Due: {formatCurrency(b.balanceDue, currency)})</option>
                    ))}
                </select>
              </div>
              <div>
                <label className="font-semibold block mb-1">Amount</label>
                <input type="number" step="0.01" value={applyVcAmt} onChange={e => setApplyVcAmt(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" required />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <button type="button" onClick={() => setApplyVcTarget(null)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy || !applyVcBillId} className="px-4 py-2 rounded bg-blue-600 text-white font-bold">Apply Credit</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* NEW REQUISITION MODAL */}
      {isReqModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">New Purchase Requisition</span>
              <button onClick={() => setIsReqModalOpen(false)} className="p-1 text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleRequisitionSubmit} className="p-5 space-y-3 text-xs">
              <div>
                <label className="app-label">Preferred Vendor (optional)</label>
                <select value={reqVendorId} onChange={e => setReqVendorId(Number(e.target.value))} className="app-input">
                  <option value={0}>No preference</option>
                  {vendors.map(v => (
                    <option key={v.id} value={v.id}>{v.companyName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="app-label">Stock Item (optional)</label>
                <select
                  value={reqItemId}
                  onChange={e => {
                    const it = stockableItems.find(x => String(x.id) === e.target.value);
                    setReqItemId(e.target.value);
                    if (it) {
                      setReqDesc(it.name);
                      setReqCost(String(Number(it.unit_cost || 0)));
                    }
                  }}
                  className="app-input"
                >
                  <option value="">Custom line</option>
                  {stockableItems.map(it => (
                    <option key={it.id} value={it.id}>{it.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="app-label">Description</label>
                <input type="text" value={reqDesc} onChange={e => setReqDesc(e.target.value)} className="app-input" required />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="app-label">Quantity</label>
                  <input type="number" step="0.001" value={reqQty} onChange={e => setReqQty(e.target.value)} className="app-input app-input-mono" required />
                </div>
                <div>
                  <label className="app-label">Est. Unit Cost</label>
                  <input type="number" step="0.01" value={reqCost} onChange={e => setReqCost(e.target.value)} className="app-input app-input-mono" />
                </div>
                <div>
                  <label className="app-label">Needed By</label>
                  <input type="date" value={reqNeededBy} onChange={e => setReqNeededBy(e.target.value)} className="app-input app-input-mono" />
                </div>
              </div>
              <div>
                <label className="app-label">Justification / Notes</label>
                <input type="text" value={reqNotes} onChange={e => setReqNotes(e.target.value)} className="app-input" />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button type="button" onClick={() => setIsReqModalOpen(false)} className="btn btn-secondary">Cancel</button>
                <button type="submit" disabled={busy} className="btn btn-primary">
                  {busy ? 'Submitting…' : 'Submit Requisition'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CONVERT REQUISITION TO PO */}
      {convertTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Convert {convertTarget.requisitionNumber} to Purchase Order</span>
              <button onClick={() => setConvertTarget(null)} className="p-1 text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleConvertRequisition} className="p-5 space-y-3 text-xs">
              <div>
                <label className="app-label">Supplier</label>
                <select value={convertVendorId} onChange={e => setConvertVendorId(Number(e.target.value))} className="app-input" required>
                  <option value={0}>Select supplier…</option>
                  {vendors.map(v => (
                    <option key={v.id} value={v.id}>{v.companyName}</option>
                  ))}
                </select>
              </div>
              <p className="text-[11px] text-slate-500">
                The approved requisition lines are copied onto a new open purchase order. Rates fall back to each line's estimated unit cost.
              </p>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button type="button" onClick={() => setConvertTarget(null)} className="btn btn-secondary">Cancel</button>
                <button type="submit" disabled={busy || !convertVendorId} className="btn btn-primary">
                  {busy ? 'Converting…' : 'Create Purchase Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* RECORD GOODS RECEIPT */}
      {isGrModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Record Goods Receipt</span>
              <button onClick={() => setIsGrModalOpen(false)} className="p-1 text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleGoodsReceiptSubmit} className="p-5 space-y-3 text-xs">
              <div>
                <label className="app-label">Open Purchase Order</label>
                <select value={grPoId} onChange={e => setGrPoId(Number(e.target.value))} className="app-input" required>
                  <option value={0}>Select purchase order…</option>
                  {purchaseOrders
                    .filter(p => p.status !== 'closed' && p.status !== 'cancelled')
                    .map(p => (
                      <option key={p.id} value={p.id}>
                        {p.poNumber} · {p.vendorName} · {formatCurrency(p.total, currency)}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="app-label">Receipt Notes</label>
                <input type="text" value={grNotes} onChange={e => setGrNotes(e.target.value)} className="app-input" placeholder="Delivery note, condition, short-shipped lines…" />
              </div>
              <p className="text-[11px] text-slate-500">
                Remaining open quantities are received into stock with no journal entry. The supplier bill is posted separately.
              </p>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button type="button" onClick={() => setIsGrModalOpen(false)} className="btn btn-secondary">Cancel</button>
                <button type="submit" disabled={busy || !grPoId} className="btn btn-emerald">
                  {busy ? 'Recording…' : 'Post Receipt'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
