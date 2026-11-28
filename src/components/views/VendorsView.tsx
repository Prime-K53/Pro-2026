import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT } from '../../services/accountingApi';
import {
  ApiBill,
  ApiVendor,
  ApiVendorApProfile,
  ApiVendorStatementSummary,
  commercialApi,
} from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
import {
  Button,
  InlineAlert,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  PageHeader,
  PageShell,
} from '../common/ui';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';
import {
  Plus,
  Search,
  Mail,
  Phone,
  FileText,
  MapPin,
  Shield,
  Copy,
  ArrowUpRight,
  X,
  Loader2,
  Star,
  Send,
  Save,
  Pencil,
  CalendarDays,
  Building2,
  AlertTriangle,
  Printer,
} from 'lucide-react';

type VendorStatus = 'active' | 'inactive' | 'on_hold' | 'blocked';

const STATUS_META: Record<VendorStatus, { label: string; badge: string; help: string }> = {
  active: {
    label: 'Active',
    badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    help: 'POs, bills and payments are allowed.',
  },
  inactive: {
    label: 'Inactive',
    badge: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    help: 'No new POs, bills or payments. History is retained.',
  },
  on_hold: {
    label: 'Payment Hold',
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    help: 'POs and bills may be recorded, but payments are blocked until released.',
  },
  blocked: {
    label: 'Blocked',
    badge: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
    help: 'No new POs, bills or payments until the supplier is released.',
  },
};

const emptyEditForm = {
  email: '',
  phone: '',
  address: '',
  taxId: '',
  vendorCategory: 'goods',
  isPreferred: false,
  bankName: '',
  bankAccountName: '',
  bankAccountNumber: '',
  bankBranch: '',
  notes: '',
};

export const VendorsView: React.FC = () => {
  const { companyProfile, setCurrentView, triggerShortcutNotice, setIsNewVendorOpen, openPrimePreview } =
    useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canWrite = hasPermission('vendors:write');
  const canSendStatements = hasPermission('statements:send');

  const [vendors, setVendors] = useState<ApiVendor[]>([]);
  const [bills, setBills] = useState<ApiBill[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [profile, setProfile] = useState<ApiVendorApProfile | null>(null);
  const [statements, setStatements] = useState<ApiVendorStatementSummary[]>([]);
  const [activeTab, setActiveTab] = useState<'overview' | 'aging' | 'statements'>('overview');
  const [statusDraft, setStatusDraft] = useState<VendorStatus>('active');
  const [period, setPeriod] = useState({ start: '', end: '' });
  const [openingForm, setOpeningForm] = useState({ amount: '', date: new Date().toISOString().slice(0, 10) });
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [statementData, setStatementData] = useState<any | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [vs, bs] = await Promise.all([commercialApi.listVendors(), commercialApi.listBills()]);
      setVendors(vs);
      setBills(bs);
      setSelectedVendorId(prev => (prev && vs.some(v => v.id === prev) ? prev : vs[0]?.id ?? null));
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load suppliers');
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id]);

  const loadVendorDetail = useCallback(async (vendorId: number) => {
    setProfileLoading(true);
    try {
      const [prof, stmts] = await Promise.all([
        commercialApi.getVendorApProfile(vendorId),
        commercialApi.listVendorStatements(vendorId),
      ]);
      setProfile(prof);
      setStatements(stmts);
      setStatusDraft(prof.status);
      setEditForm({
        email: prof.email,
        phone: prof.phone,
        address: prof.address,
        taxId: prof.taxId,
        vendorCategory: prof.vendorCategory,
        isPreferred: prof.isPreferred,
        bankName: prof.bankName,
        bankAccountName: prof.bankAccountName,
        bankAccountNumber: prof.bankAccountNumber,
        bankBranch: prof.bankBranch,
        notes: prof.notes,
      });
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load supplier AP profile');
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (selectedVendorId) {
      setActiveTab('overview');
      setEditing(false);
      loadVendorDetail(selectedVendorId);
    } else {
      setProfile(null);
      setStatements([]);
    }
  }, [selectedVendorId, loadVendorDetail]);

  useEffect(() => {
    const onUpdated = () => {
      loadData();
      if (selectedVendorId) loadVendorDetail(selectedVendorId);
    };
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, onUpdated);
  }, [loadData, loadVendorDetail, selectedVendorId]);

  const filteredVendors = vendors.filter(v => {
    const q = searchQuery.toLowerCase();
    return (
      v.companyName.toLowerCase().includes(q) ||
      v.name.toLowerCase().includes(q) ||
      v.taxId.toLowerCase().includes(q) ||
      (v.vendorCode || '').toLowerCase().includes(q)
    );
  });

  const selectedVendor = vendors.find(v => v.id === selectedVendorId) || vendors[0] || null;
  const vendorBills = selectedVendor
    ? bills.filter(b => b.vendorId === selectedVendor.id && b.status !== 'voided')
    : [];
  const vendorCurrency = profile?.currencyCode || selectedVendor?.currencyCode || currency;
  const status = (profile?.status || selectedVendor?.status || 'active') as VendorStatus;

  const refreshSelected = async () => {
    await loadData();
    if (selectedVendorId) await loadVendorDetail(selectedVendorId);
  };

  const handleSaveStatus = async () => {
    if (!selectedVendorId) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.updateVendor(selectedVendorId, { status: statusDraft });
      triggerShortcutNotice(`Supplier status set to ${STATUS_META[statusDraft].label}`);
      await refreshSelected();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to update supplier status');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVendorId) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.updateVendor(selectedVendorId, editForm);
      triggerShortcutNotice('Supplier details saved');
      setEditing(false);
      await refreshSelected();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to update supplier');
    } finally {
      setBusy(false);
    }
  };

  const handlePostOpeningBalance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVendorId) return;
    const amount = Number(openingForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setErrorMsg('Opening balance must be greater than zero');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.addVendorOpeningBalance(selectedVendorId, {
        openingBalance: amount,
        openingBalanceDate: openingForm.date,
      });
      triggerShortcutNotice('Opening balance posted to AP');
      setOpeningForm({ amount: '', date: new Date().toISOString().slice(0, 10) });
      await refreshSelected();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to post supplier opening balance');
    } finally {
      setBusy(false);
    }
  };

  const statementParams = () => ({
    periodStart: period.start || undefined,
    periodEnd: period.end || undefined,
  });

  const handleOpenStatement = async () => {
    if (!selectedVendorId) return;
    setBusy(true);
    try {
      const stmt = await commercialApi.getVendorStatement(selectedVendorId, {
        ...statementParams(),
        saveSnapshot: true,
      });
      setStatementData(stmt);
      await loadVendorDetail(selectedVendorId);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load supplier statement');
    } finally {
      setBusy(false);
    }
  };

  const handleViewSavedStatement = async (statementId: number) => {
    if (!selectedVendorId) return;
    setBusy(true);
    try {
      const stmt = await commercialApi.getVendorStatementSnapshot(selectedVendorId, statementId);
      setStatementData(stmt);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to open archived statement');
    } finally {
      setBusy(false);
    }
  };

  const handlePrintStatement = () => {
    if (!statementData) return;
    const cur = statementData.currencyCode || currency;
    const lines = statementData.lines || [];
    const totalDebit = lines.reduce((s: number, l: any) => s + (Number(l.charge) || 0), 0);
    const totalCredit = lines.reduce((s: number, l: any) => s + (Number(l.credit) || 0), 0);
    openPrimePreview(
      'ACCOUNT_STATEMENT',
      {
        number: `STMT-VND-${statementData.vendorCode || statementData.vendorId || '0'}`,
        statementNumber: `STMT-VND-${statementData.vendorCode || statementData.vendorId || '0'}`,
        date: statementData.periodEnd,
        clientName: statementData.vendorName,
        customerName: statementData.vendorName,
        address: statementData.remitToAddress || companyProfile.address || '',
        phone: companyProfile.phone || '',
        openingBalance: Number(statementData.openingBalance) || 0,
        closingBalance: Number(statementData.closingBalance) || 0,
        finalBalance: Number(statementData.closingBalance) || 0,
        startDate: statementData.periodStart,
        endDate: statementData.periodEnd,
        totalDebit,
        totalCredit,
        currency: cur,
        transactions: lines.map((l: any) => ({
          date: l.date,
          reference: l.number,
          description: l.type,
          debit: Number(l.charge) || 0,
          credit: Number(l.credit) || 0,
          balance: Number(l.runningBalance) || 0,
        })),
      },
      `Supplier Statement — ${statementData.vendorName}`
    );
  };

  const handleSendStatement = async () => {
    if (!selectedVendorId) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.sendVendorStatement(selectedVendorId, statementParams());
      triggerShortcutNotice('Supplier statement queued for email');
      await loadVendorDetail(selectedVendorId);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to send supplier statement');
    } finally {
      setBusy(false);
    }
  };

  const buildVendorBillActionContext = (bill: ApiBill, pendingId?: string | null): ActionEligibilityContext<ApiBill> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'vendors',
    entityType: 'bill',
    record: bill,
    recordStatus: bill.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const buildVendorBillActionDefinitions = (bill: ApiBill): AdvancedActionDefinition<ApiBill>[] => [
    {
      id: 'vendor.bill.open-bills',
      label: 'Go to Bills & POs',
      icon: <ArrowUpRight className="w-3.5 h-3.5 text-blue-600" />,
      group: 'process',
      groupLabel: 'Navigation',
      requiredPermission: 'bills:read',
      execute: async () => {
        setCurrentView('bills');
      },
    },
    {
      id: 'vendor.bill.statement',
      label: 'Supplier Statement',
      icon: <FileText className="w-3.5 h-3.5 text-amber-600" />,
      group: 'communication',
      groupLabel: 'Supplier',
      requiredPermission: 'vendors:read',
      execute: async () => {
        await handleOpenStatement();
      },
    },
    {
      id: 'vendor.bill.copy-number',
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

  const renderVendorBillActions = (bill: ApiBill) => {
    const defs = buildVendorBillActionDefinitions(bill);
    const ctx = buildVendorBillActionContext(bill, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<ApiBill>
        label={`Actions for ${bill.billNumber}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={bill.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async action => {
          const def = action.definition;
          if (typeof def.execute === 'function') {
            await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) });
          }
        }}
      />
    );
  };

  const money = (value: number | null | undefined) =>
    formatCurrency(Number(value || 0), vendorCurrency);

  return (
    <PageShell>
      <PageHeader
        title="Vendor & Supplier Center"
        subtitle="Supplier master, AP exposure, payment holds, aging and reconciled statements."
        icon={(loading || profileLoading) ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : <Building2 className="h-4.5 w-4.5" />}
        actions={
          <>
            {selectedVendor && (
              <Button variant="secondary" size="sm" onClick={handleOpenStatement} disabled={busy}>
                <FileText className="h-3.5 w-3.5 text-brand-600 dark:text-brand-400" />
                Supplier Statement
              </Button>
            )}
            {canWrite && (
              <Button variant="primary" size="sm" onClick={() => setIsNewVendorOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add Vendor
              </Button>
            )}
          </>
        }
      />

      {errorMsg && (
        <InlineAlert tone="rose" onDismiss={() => setErrorMsg(null)}>
          {errorMsg}
        </InlineAlert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-4 surface overflow-hidden flex flex-col">
          <div className="p-3 border-b border-slate-200 dark:border-white/[0.08]">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Filter by name, code or tax ID..."
                className="app-input pl-8"
              />
            </div>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[620px] overflow-y-auto">
            {filteredVendors.length === 0 && (
              <div className="p-6 text-center text-xs text-slate-400">No suppliers match this filter.</div>
            )}
            {filteredVendors.map(v => {
              const isSelected = v.id === selectedVendor?.id;
              const meta = STATUS_META[(v.status || 'active') as VendorStatus] || STATUS_META.active;
              return (
                <button
                  key={v.id}
                  onClick={() => setSelectedVendorId(v.id)}
                  className={`w-full p-3 text-left transition-colors flex items-center justify-between ${
                    isSelected
                      ? 'bg-amber-50 dark:bg-amber-950/40 ring-1 ring-inset ring-amber-500/40'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-850'
                  }`}
                >
                  <div className="truncate pr-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-xs text-slate-900 dark:text-white truncate">
                        {v.companyName}
                      </span>
                      {v.isPreferred && <Star className="w-3 h-3 fill-amber-400 text-amber-400 shrink-0" />}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500">
                      <span className="font-mono">{v.vendorCode}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded font-bold uppercase tracking-wide ${meta.badge}`}
                      >
                        {meta.label}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0 font-mono">
                    <div
                      className={`text-xs font-bold tabular-nums ${
                        v.balance > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400'
                      }`}
                    >
                      {formatCurrency(v.balance, currency)}
                    </div>
                    <div className="text-[10px] text-slate-400">{v.terms}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-8 space-y-6">
          {selectedVendor ? (
            <>
              <div className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                        {selectedVendor.companyName}
                      </h2>
                      {profile?.isPreferred && <Star className="w-4 h-4 fill-amber-400 text-amber-400" />}
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          STATUS_META[status].badge
                        }`}
                      >
                        {STATUS_META[status].label}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-4">
                      <span>
                        Code: <span className="font-mono font-semibold">{profile?.vendorCode || selectedVendor.vendorCode}</span>
                      </span>
                      <span>
                        Contact:{' '}
                        <span className="font-semibold text-slate-700 dark:text-slate-300">
                          {selectedVendor.name}
                        </span>
                      </span>
                      <span>
                        Category:{' '}
                        <span className="font-semibold capitalize">
                          {profile?.vendorCategory || selectedVendor.vendorCategory}
                        </span>
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {canWrite && (
                      <button
                        onClick={() => setEditing(v => !v)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        <span>Edit Details</span>
                      </button>
                    )}
                    <button
                      onClick={() => setCurrentView('bills')}
                      className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs shadow-xs"
                    >
                      Open Bills &amp; POs →
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                  <div className="space-y-1">
                    <span className="text-slate-400 font-semibold flex items-center gap-1">
                      <Mail className="w-3.5 h-3.5" /> Email
                    </span>
                    <div className="font-medium truncate">{selectedVendor.email || 'None on file'}</div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-slate-400 font-semibold flex items-center gap-1">
                      <Phone className="w-3.5 h-3.5" /> Phone
                    </span>
                    <div className="font-medium">{selectedVendor.phone || 'None on file'}</div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-slate-400 font-semibold flex items-center gap-1">
                      <Shield className="w-3.5 h-3.5" /> Tax ID / TPIN
                    </span>
                    <div className="font-mono font-semibold">{selectedVendor.taxId || 'None on file'}</div>
                  </div>
                </div>

                {status !== 'active' && (
                  <div
                    className={`flex items-start gap-2 rounded-lg border p-3 text-[11px] ${
                      status === 'on_hold'
                        ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
                        : 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
                    }`}
                  >
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>{STATUS_META[status].help} Payments are blocked while this status is in effect.</span>
                  </div>
                )}

                {canWrite && (
                  <div className="flex flex-wrap items-end gap-3 pt-1">
                    <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                      Supplier status
                      <select
                        value={statusDraft}
                        onChange={e => setStatusDraft(e.target.value as VendorStatus)}
                        className="mt-1 block w-44 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-850"
                      >
                        <option value="active">Active</option>
                        <option value="on_hold">Payment hold</option>
                        <option value="inactive">Inactive</option>
                        <option value="blocked">Blocked</option>
                      </select>
                    </label>
                    <button
                      onClick={handleSaveStatus}
                      disabled={busy || statusDraft === status}
                      className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
                    >
                      <Save className="w-3.5 h-3.5" />
                      Save status
                    </button>
                    <span className="text-[11px] text-slate-400">{STATUS_META[statusDraft].help}</span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard
                  label="Net AP Exposure"
                  value={profile ? money(profile.exposure.netExposure) : '—'}
                  emphasis={Number(profile?.exposure.netExposure || 0) > 0}
                  hint="Open bills less credits & prepayments"
                />
                <StatCard
                  label="Open Bills"
                  value={profile ? money(profile.exposure.openBillBalance) : '—'}
                  hint={profile ? `${profile.counts.openBills} bill(s)` : ' '}
                />
                <StatCard
                  label="YTD Spend"
                  value={profile ? money(profile.ytdSpend) : '—'}
                  hint="Posted bills this year"
                />
                <StatCard
                  label="Unapplied Credits"
                  value={profile ? money(profile.exposure.unappliedVendorCredits) : '—'}
                  hint={profile ? `${profile.counts.openPurchaseOrders} open PO(s)` : ' '}
                />
              </div>

              <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
                <div className="flex border-b border-slate-200 dark:border-slate-800">
                  {(['overview', 'aging', 'statements'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`px-4 py-2.5 text-xs font-bold capitalize border-b-2 -mb-px ${
                        activeTab === tab
                          ? 'border-amber-500 text-amber-700 dark:text-amber-400'
                          : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {activeTab === 'overview' && (
                  <div className="p-5 space-y-5">
                    {editing ? (
                      <form onSubmit={handleSaveDetails} className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                          <Field label="Email">
                            <input
                              type="email"
                              value={editForm.email}
                              onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))}
                              className="app-input"
                            />
                          </Field>
                          <Field label="Phone">
                            <input
                              value={editForm.phone}
                              onChange={e => setEditForm(p => ({ ...p, phone: e.target.value }))}
                              className="app-input"
                            />
                          </Field>
                          <Field label="Tax ID / TPIN">
                            <input
                              value={editForm.taxId}
                              onChange={e => setEditForm(p => ({ ...p, taxId: e.target.value }))}
                              className="app-input font-mono"
                            />
                          </Field>
                          <Field label="Supplier Category">
                            <select
                              value={editForm.vendorCategory}
                              onChange={e => setEditForm(p => ({ ...p, vendorCategory: e.target.value }))}
                              className="app-input"
                            >
                              <option value="goods">Goods</option>
                              <option value="services">Services</option>
                              <option value="logistics">Logistics</option>
                              <option value="utilities">Utilities</option>
                              <option value="contractor">Contractor</option>
                              <option value="other">Other</option>
                            </select>
                          </Field>
                          <Field label="Bank Name">
                            <input
                              value={editForm.bankName}
                              onChange={e => setEditForm(p => ({ ...p, bankName: e.target.value }))}
                              className="app-input"
                            />
                          </Field>
                          <Field label="Bank Account Name">
                            <input
                              value={editForm.bankAccountName}
                              onChange={e => setEditForm(p => ({ ...p, bankAccountName: e.target.value }))}
                              className="app-input"
                            />
                          </Field>
                          <Field label="Bank Account Number">
                            <input
                              value={editForm.bankAccountNumber}
                              onChange={e => setEditForm(p => ({ ...p, bankAccountNumber: e.target.value }))}
                              className="app-input font-mono"
                            />
                          </Field>
                          <Field label="Bank Branch">
                            <input
                              value={editForm.bankBranch}
                              onChange={e => setEditForm(p => ({ ...p, bankBranch: e.target.value }))}
                              className="app-input"
                            />
                          </Field>
                          <div className="sm:col-span-2">
                            <Field label="Remit Address">
                              <textarea
                                rows={2}
                                value={editForm.address}
                                onChange={e => setEditForm(p => ({ ...p, address: e.target.value }))}
                                className="app-input"
                              />
                            </Field>
                          </div>
                          <div className="sm:col-span-2">
                            <Field label="Notes">
                              <textarea
                                rows={2}
                                value={editForm.notes}
                                onChange={e => setEditForm(p => ({ ...p, notes: e.target.value }))}
                                className="app-input"
                              />
                            </Field>
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                          <input
                            type="checkbox"
                            checked={editForm.isPreferred}
                            onChange={e => setEditForm(p => ({ ...p, isPreferred: e.target.checked }))}
                            className="h-4 w-4 rounded border-slate-300 text-slate-700"
                          />
                          Preferred supplier
                        </label>
                        <div className="flex gap-2">
                          <button
                            type="submit"
                            disabled={busy}
                            className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                          >
                            <Save className="w-3.5 h-3.5" />
                            Save details
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(false)}
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold dark:border-slate-700"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                        <Detail label="Payment Terms" value={profile?.terms || selectedVendor.terms} />
                        <Detail label="Currency" value={profile?.currencyCode || selectedVendor.currencyCode} />
                        <Detail
                          label="Remit Address"
                          value={profile?.address || selectedVendor.address || 'No address on file'}
                        />
                        <Detail
                          label="Bank Details"
                          value={
                            profile?.bankAccountNumber
                              ? `${profile.bankName || 'Bank'} · ${profile.bankAccountName || '—'} · ${profile.bankAccountNumber}${
                                  profile.bankBranch ? ` (${profile.bankBranch})` : ''
                                }`
                              : 'No bank details on file'
                          }
                        />
                        <Detail
                          label="1099 Reporting"
                          value={profile?.is1099Eligible ? '1099 eligible' : 'Not 1099 eligible'}
                        />
                        <Detail
                          label="Last Activity"
                          value={
                            profile?.lastPaymentDate
                              ? `Payment ${profile.lastPaymentDate}`
                              : profile?.lastBillDate
                                ? `Bill ${profile.lastBillDate}`
                                : 'No AP activity'
                          }
                        />
                        {profile?.notes && (
                          <div className="sm:col-span-2">
                            <Detail label="Internal Notes" value={profile.notes} />
                          </div>
                        )}
                      </div>
                    )}

                    {!profile?.openingBalanceBillId && canWrite && (
                      <form
                        onSubmit={handlePostOpeningBalance}
                        className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-4 space-y-3"
                      >
                        <div className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-200">
                          <Building2 className="w-4 h-4 text-amber-600" />
                          Bring forward an opening balance
                        </div>
                        <p className="text-[11px] text-slate-500">
                          Posts an opening supplier bill and Dr Opening Balance Equity / Cr Accounts Payable,
                          keeping the AP subledger and GL reconciled.
                        </p>
                        <div className="flex flex-wrap items-end gap-3">
                          <Field label="Opening Balance">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              value={openingForm.amount}
                              onChange={e => setOpeningForm(p => ({ ...p, amount: e.target.value }))}
                              className="app-input w-40"
                            />
                          </Field>
                          <Field label="Opening Date">
                            <input
                              type="date"
                              value={openingForm.date}
                              onChange={e => setOpeningForm(p => ({ ...p, date: e.target.value }))}
                              className="app-input w-40"
                            />
                          </Field>
                          <button
                            type="submit"
                            disabled={busy}
                            className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950 disabled:opacity-50"
                          >
                            Post opening balance
                          </button>
                        </div>
                      </form>
                    )}

                    <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
                          <tr>
                            <th className="px-4 py-2.5">BILL #</th>
                            <th className="px-4 py-2.5">DATE</th>
                            <th className="px-4 py-2.5">DUE DATE</th>
                            <th className="px-4 py-2.5 text-right">TOTAL</th>
                            <th className="px-4 py-2.5 text-right">BALANCE DUE</th>
                            <th className="px-4 py-2.5 text-center">STATUS</th>
                            <th className="px-4 py-2.5 text-right">ACTIONS</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                          {vendorBills.length === 0 ? (
                            <tr>
                              <td colSpan={7} className="px-4 py-8 text-center text-slate-400 font-sans">
                                No bills recorded for this supplier.
                              </td>
                            </tr>
                          ) : (
                            vendorBills.map(b => (
                              <tr key={b.id} className="hover:bg-slate-50 dark:hover:bg-slate-850/50">
                                <td className="px-4 py-2.5 font-bold">{b.billNumber}</td>
                                <td className="px-4 py-2.5 text-slate-500">{b.billDate}</td>
                                <td className="px-4 py-2.5 text-slate-500">{b.dueDate}</td>
                                <td className="px-4 py-2.5 text-right font-bold tabular-nums">
                                  {formatCurrency(b.total, currency)}
                                </td>
                                <td className="px-4 py-2.5 text-right font-bold text-rose-600 tabular-nums">
                                  {formatCurrency(b.balanceDue, currency)}
                                </td>
                                <td className="px-4 py-2.5 text-center font-sans">
                                  <span
                                    className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                      b.balanceDue === 0
                                        ? 'bg-emerald-100 text-emerald-800'
                                        : 'bg-amber-100 text-amber-800'
                                    }`}
                                  >
                                    {b.status}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 text-right font-sans">
                                  {renderVendorBillActions(b)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {activeTab === 'aging' && (
                  <div className="p-5 space-y-4">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                      <AgingCell label="Current" value={profile ? money(profile.aging.current) : '—'} />
                      <AgingCell label="1–30" value={profile ? money(profile.aging.days1To30) : '—'} />
                      <AgingCell label="31–60" value={profile ? money(profile.aging.days31To60) : '—'} />
                      <AgingCell label="61–90" value={profile ? money(profile.aging.days61To90) : '—'} />
                      <AgingCell
                        label="90+"
                        value={profile ? money(profile.aging.daysOver90) : '—'}
                        danger
                      />
                    </div>
                    <div className="flex flex-wrap gap-4 text-[11px] text-slate-500">
                      <span>
                        Open bill balance:{' '}
                        <span className="font-mono font-semibold">{profile ? money(profile.aging.total) : '—'}</span>
                      </span>
                      <span>
                        Unapplied credit:{' '}
                        <span className="font-mono font-semibold">
                          {profile ? money(profile.aging.unappliedCredit) : '—'}
                        </span>
                      </span>
                      <span>
                        Unapplied prepayment:{' '}
                        <span className="font-mono font-semibold">
                          {profile ? money(profile.aging.unappliedPayment) : '—'}
                        </span>
                      </span>
                      <span>As of {profile?.asOfDate || '—'}</span>
                    </div>
                    <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
                          <tr>
                            <th className="px-4 py-2.5">BILL #</th>
                            <th className="px-4 py-2.5">BILL DATE</th>
                            <th className="px-4 py-2.5">DUE DATE</th>
                            <th className="px-4 py-2.5 text-right">DAYS PAST DUE</th>
                            <th className="px-4 py-2.5 text-right">ORIGINAL</th>
                            <th className="px-4 py-2.5 text-right">CREDITS/PAYMENTS</th>
                            <th className="px-4 py-2.5 text-right">OPEN</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                          {(profile?.aging.bills || []).length === 0 ? (
                            <tr>
                              <td colSpan={7} className="px-4 py-8 text-center text-slate-400 font-sans">
                                No aged AP for this supplier.
                              </td>
                            </tr>
                          ) : (
                            profile!.aging.bills.map(b => (
                              <tr key={b.billId}>
                                <td className="px-4 py-2.5 font-bold">{b.billNumber}</td>
                                <td className="px-4 py-2.5 text-slate-500">{b.billDate}</td>
                                <td className="px-4 py-2.5 text-slate-500">{b.dueDate}</td>
                                <td className="px-4 py-2.5 text-right">{b.daysPastDue}</td>
                                <td className="px-4 py-2.5 text-right">{money(b.originalBalance)}</td>
                                <td className="px-4 py-2.5 text-right text-emerald-600">
                                  {b.appliedUnapplied > 0 ? `-${money(b.appliedUnapplied)}` : '—'}
                                </td>
                                <td className="px-4 py-2.5 text-right font-bold text-rose-600">
                                  {money(b.balanceDue)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {activeTab === 'statements' && (
                  <div className="p-5 space-y-4">
                    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 dark:border-slate-800 p-3">
                      <Field label="Period start">
                        <input
                          type="date"
                          value={period.start}
                          onChange={e => setPeriod(p => ({ ...p, start: e.target.value }))}
                          className="app-input w-40"
                        />
                      </Field>
                      <Field label="Period end">
                        <input
                          type="date"
                          value={period.end}
                          onChange={e => setPeriod(p => ({ ...p, end: e.target.value }))}
                          className="app-input w-40"
                        />
                      </Field>
                      <button
                        onClick={handleOpenStatement}
                        disabled={busy}
                        className="flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-bold disabled:opacity-50 dark:border-slate-700"
                      >
                        <CalendarDays className="w-3.5 h-3.5" />
                        Generate &amp; save
                      </button>
                      {canSendStatements && (
                        <button
                          onClick={handleSendStatement}
                          disabled={busy}
                          className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                        >
                          <Send className="w-3.5 h-3.5" />
                          Email statement
                        </button>
                      )}
                      <span className="text-[11px] text-slate-400">
                        Defaults to the current month when dates are blank.
                      </span>
                    </div>

                    <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                      {statements.length === 0 ? (
                        <div className="p-6 text-center text-xs text-slate-400">
                          No archived supplier statements yet.
                        </div>
                      ) : (
                        statements.map(s => (
                          <div key={s.statementId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
                            <div>
                              <div className="font-mono font-bold">
                                {s.periodStart} → {s.periodEnd}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                Opening {money(s.openingBalance)} · Closing {money(s.closingBalance)} ·{' '}
                                {s.emailedAt ? `Emailed ${new Date(s.emailedAt).toLocaleDateString()}` : 'Not emailed'}
                              </div>
                            </div>
                            <button
                              onClick={() => handleViewSavedStatement(s.statementId)}
                              className="flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-[11px] font-semibold dark:border-slate-700"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              View snapshot
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="p-12 text-center text-slate-500 bg-white dark:bg-slate-900 rounded-xl border">
              No suppliers configured yet.
            </div>
          )}
        </div>
      </div>

      <ModalShell open={Boolean(statementData)} onClose={() => setStatementData(null)} size="3xl">
        <ModalHeader
          title={`Supplier Statement — ${statementData?.vendorName ?? ''}`}
          subtitle={statementData?.vendorCode ? `Code: ${statementData.vendorCode}` : undefined}
          icon={<FileText className="h-4.5 w-4.5" />}
          onClose={() => setStatementData(null)}
        />
        {statementData && (
          <>
            <ModalBody className="space-y-4">
              <div className="flex justify-between font-mono border-b border-slate-200 dark:border-white/[0.08] pb-3 text-xs">
                <div>
                  <div className="font-bold text-sm font-sans text-slate-900 dark:text-white">{statementData.vendorName}</div>
                  <div className="text-slate-500">
                    Period: {statementData.periodStart} to {statementData.periodEnd}
                  </div>
                  {statementData.remitToAddress && (
                    <div className="text-slate-500 flex items-center gap-1 mt-1">
                      <MapPin className="w-3 h-3" /> {statementData.remitToAddress}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-slate-600 dark:text-slate-300">
                    Opening AP: {formatCurrency(statementData.openingBalance, statementData.currencyCode || currency)}
                  </div>
                  <div className="font-bold text-sm text-rose-600 dark:text-rose-400">
                    Closing AP: {formatCurrency(statementData.closingBalance, statementData.currencyCode || currency)}
                  </div>
                </div>
              </div>
              <div className="surface overflow-hidden">
                <table className="data-table font-mono">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Doc #</th>
                      <th className="text-right">Bills</th>
                      <th className="text-right">Payments/Credits</th>
                      <th className="text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(statementData.lines || []).map((l: any, idx: number) => (
                      <tr key={idx}>
                        <td>{l.date}</td>
                        <td className="font-sans">{l.type}</td>
                        <td className="font-bold">{l.number}</td>
                        <td className="text-right">
                          {l.charge > 0
                            ? formatCurrency(l.charge, statementData.currencyCode || currency)
                            : '—'}
                        </td>
                        <td className="text-right text-emerald-600 dark:text-emerald-400">
                          {l.credit > 0
                            ? `-${formatCurrency(l.credit, statementData.currencyCode || currency)}`
                            : '—'}
                        </td>
                        <td className="text-right font-bold">
                          {formatCurrency(l.runningBalance, statementData.currencyCode || currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {statementData.aging && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  <AgingCell label="Current" value={money(statementData.aging.current)} />
                  <AgingCell label="1–30" value={money(statementData.aging.days1To30)} />
                  <AgingCell label="31–60" value={money(statementData.aging.days31To60)} />
                  <AgingCell label="61–90" value={money(statementData.aging.days61To90)} />
                  <AgingCell label="90+" value={money(statementData.aging.daysOver90)} danger />
                </div>
              )}
            </ModalBody>
            <ModalFooter
              right={
                <>
                  <Button variant="secondary" onClick={() => setStatementData(null)}>Close</Button>
                  <Button variant="primary" onClick={handlePrintStatement}>
                    <Printer className="h-3.5 w-3.5" />
                    Download PDF
                  </Button>
                </>
              }
            />
          </>
        )}
      </ModalShell>
    </PageShell>
  );
};

const StatCard: React.FC<{
  label: string;
  value: string;
  hint: string;
  emphasis?: boolean;
}> = ({ label, value, hint, emphasis }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900">
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div
      className={`mt-1 font-mono text-sm font-bold tabular-nums ${
        emphasis ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'
      }`}
    >
      {value}
    </div>
    <div className="mt-0.5 text-[10px] text-slate-400">{hint}</div>
  </div>
);

const AgingCell: React.FC<{ label: string; value: string; danger?: boolean }> = ({
  label,
  value,
  danger,
}) => (
  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/40">
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div
      className={`mt-0.5 font-mono text-xs font-bold tabular-nums ${
        danger ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-100'
      }`}
    >
      {value}
    </div>
  </div>
);

const Detail: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
    <div className="mt-0.5 text-slate-700 dark:text-slate-300">{value}</div>
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
    <span className="mb-1 block">{label}</span>
    {children}
  </label>
);
