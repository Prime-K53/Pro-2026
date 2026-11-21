import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT } from '../../services/accountingApi';
import { ApiCustomer, ApiInvoice, commercialApi } from '../../services/commercialApi';
import { documentsApi } from '../../services/documentsApi';
import { DocumentPreviewKind, mapApiPreviewToModel } from '../../types/documents';
import { formatCurrency } from '../../utils/currency';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions, isActionExecutable } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';

import {
  Plus,
  Search,
  Mail,
  Phone,
  FileText,
  MapPin,
  Clock,
  ShieldCheck,
  Copy,
  ArrowUpRight,
  X,
  Loader2,
} from 'lucide-react';

export const CustomersView: React.FC = () => {
  const {
    companyProfile,
    setCurrentView,
    triggerShortcutNotice,
    openDocumentPreview,
    setIsNewCustomerOpen,
  } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canWrite = hasPermission('customers:write');
  const canChangeCredit = hasPermission('customers:change_credit_limit');
  const canAllocate = hasPermission('payments:allocate');
  const canSendStatements = hasPermission('statements:send');
  const canRevalueFx = hasPermission('fx:revalue');

  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [invoices, setInvoices] = useState<ApiInvoice[]>([]);
  const [permits, setPermits] = useState<any[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Credit exposure, open cash, statements, and FX revaluation
  const [creditProfile, setCreditProfile] = useState<any | null>(null);
  const [unappliedPayments, setUnappliedPayments] = useState<any[]>([]);
  const [statements, setStatements] = useState<any[]>([]);
  const [allocation, setAllocation] = useState({ paymentId: '', invoiceId: '', amount: '' });
  const [showFxPanel, setShowFxPanel] = useState(false);
  const [fx, setFx] = useState<{
    asOfDate: string;
    currencyCode: string;
    preview: any | null;
    runs: any[];
  }>({ asOfDate: new Date().toISOString().slice(0, 10), currencyCode: '', preview: null, runs: [] });
  const [busy, setBusy] = useState(false);

  // Reseller Permit Modal
  const [showAddPermit, setShowAddPermit] = useState(false);
  const [newPermit, setNewPermit] = useState({ permitNumber: '', state: 'ZM', expiresAt: '', notes: '' });

  // Live Statement Modal
  const [statementData, setStatementData] = useState<any | null>(null);
  const [statementPeriod, setStatementPeriod] = useState({ start: '', end: '' });

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [custs, invs, perms] = await Promise.all([
        commercialApi.listCustomers(),
        commercialApi.listInvoices(),
        commercialApi.listResellerPermits().catch(() => []),
      ]);
      setCustomers(custs);
      setInvoices(invs);
      setPermits(perms);
      setSelectedCustomerId(prev =>
        prev && custs.some(c => c.id === prev) ? prev : custs[0]?.id ?? null
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load customers');
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const onUpdated = () => loadData();
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, onUpdated);
  }, [loadData]);

  const loadCustomerDetail = useCallback(async (customerId: number) => {
    try {
      const [profile, unapplied, history] = await Promise.all([
        commercialApi.getCustomerCreditProfile(customerId).catch(() => null),
        commercialApi.listUnappliedPayments(customerId).catch(() => []),
        commercialApi.listCustomerStatements(customerId).catch(() => []),
      ]);
      setCreditProfile(profile);
      setUnappliedPayments(unapplied);
      setStatements(history);
      setAllocation({ paymentId: '', invoiceId: '', amount: '' });
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load customer credit details');
    }
  }, []);

  useEffect(() => {
    if (selectedCustomerId) {
      loadCustomerDetail(selectedCustomerId);
    } else {
      setCreditProfile(null);
      setUnappliedPayments([]);
      setStatements([]);
    }
  }, [selectedCustomerId, loadCustomerDetail]);

  useEffect(() => {
    if (!showFxPanel || !canRevalueFx) return;
    commercialApi
      .listFxRevaluationRuns()
      .then(runs => setFx(p => ({ ...p, runs })))
      .catch(() => undefined);
  }, [showFxPanel, canRevalueFx]);

  const filteredCustomers = customers.filter(
    c =>
      c.companyName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedCustomer = customers.find(c => c.id === selectedCustomerId) || customers[0] || null;
  const customerInvoices = selectedCustomer
    ? invoices.filter(i => i.customerId === selectedCustomer.id && i.status !== 'voided')
    : [];
  const customerPermits = selectedCustomer
    ? permits.filter(p => p.customerId === selectedCustomer.id)
    : [];
  const totalOutstanding = customers.reduce((sum, c) => sum + c.balance, 0);

  const handleOpenStatement = async (
    customerId: number,
    periodStart?: string,
    periodEnd?: string
  ) => {
    try {
      const stmt = await commercialApi.getCustomerStatement(customerId, {
        saveSnapshot: true,
        periodStart,
        periodEnd,
      });
      setStatementData(stmt);
      setStatementPeriod({ start: stmt.periodStart, end: stmt.periodEnd });
      setStatements(await commercialApi.listCustomerStatements(customerId).catch(() => statements));
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to generate customer statement');
    }
  };

  const handleEmailStatement = async (customerId: number) => {
    if (!canSendStatements) {
      setErrorMsg('You do not have permission to email statements.');
      return;
    }
    try {
      setBusy(true);
      const result = await commercialApi.sendCustomerStatement(customerId, {
        periodStart: statementData?.periodStart,
        periodEnd: statementData?.periodEnd,
      });
      triggerShortcutNotice(`Statement queued to ${result.recipient}`);
      await loadCustomerDetail(customerId);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to email statement');
    } finally {
      setBusy(false);
    }
  };

  const handleChangeLimit = async () => {
    if (!selectedCustomer) return;
    const raw = window.prompt(
      `New credit limit for ${selectedCustomer.companyName} (leave blank for no limit):`,
      selectedCustomer.creditLimit === null ? '' : String(selectedCustomer.creditLimit)
    );
    if (raw === null) return;
    const value = raw.trim();
    try {
      setBusy(true);
      await commercialApi.updateCustomer(selectedCustomer.id, {
        creditLimit: value === '' ? null : Number(value),
        creditOverrideReason: 'Credit limit revised in Customer Center',
      } as any);
      triggerShortcutNotice('Credit limit updated');
      await loadData();
      await loadCustomerDetail(selectedCustomer.id);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to change credit limit');
    } finally {
      setBusy(false);
    }
  };

  const handleStatusChange = async (status: 'active' | 'blocked') => {
    if (!selectedCustomer) return;
    try {
      setBusy(true);
      await commercialApi.updateCustomer(selectedCustomer.id, { customerStatus: status });
      triggerShortcutNotice(
        status === 'blocked'
          ? `${selectedCustomer.companyName} placed on credit hold`
          : `${selectedCustomer.companyName} released from credit hold`
      );
      await loadData();
      await loadCustomerDetail(selectedCustomer.id);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to change customer status');
    } finally {
      setBusy(false);
    }
  };

  const handleAllocate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomer || !allocation.paymentId || !allocation.invoiceId) return;
    try {
      setBusy(true);
      const result = await commercialApi.applyUnappliedPayment(Number(allocation.paymentId), {
        invoiceId: Number(allocation.invoiceId),
        amount: allocation.amount || null,
      });
      triggerShortcutNotice(
        `Applied ${formatCurrency(result.amount, currency)} to ${result.invoiceNumber}`
      );
      await loadData();
      await loadCustomerDetail(selectedCustomer.id);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to apply payment');
    } finally {
      setBusy(false);
    }
  };

  const handlePreviewFx = async () => {
    try {
      setBusy(true);
      const preview = await commercialApi.previewFxRevaluation({
        asOfDate: fx.asOfDate || undefined,
        currencyCode: fx.currencyCode || undefined,
      });
      setFx(p => ({ ...p, preview }));
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to preview FX revaluation');
    } finally {
      setBusy(false);
    }
  };

  const handlePostFx = async () => {
    try {
      setBusy(true);
      const result = await commercialApi.postFxRevaluation({
        asOfDate: fx.asOfDate || undefined,
        currencyCode: fx.currencyCode || undefined,
      });
      triggerShortcutNotice(
        `FX revaluation posted: gain ${result.totalGain.toFixed(2)}, loss ${result.totalLoss.toFixed(2)}`
      );
      setFx(p => ({ ...p, preview: result }));
      const runs = await commercialApi.listFxRevaluationRuns();
      setFx(p => ({ ...p, runs }));
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to post FX revaluation');
    } finally {
      setBusy(false);
    }
  };

  const handleOpenPreview = async (kind: DocumentPreviewKind, id: number) => {
    try {
      const raw = await documentsApi.getDocumentPreview(kind, id);
      openDocumentPreview(mapApiPreviewToModel(raw, currency));
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load document preview');
    }
  };

  const buildCustomerInvoiceActionContext = (inv: ApiInvoice, pendingId?: string | null): ActionEligibilityContext<ApiInvoice> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'customers',
    entityType: inv.isSalesReceipt ? 'sales_receipt' : 'invoice',
    record: inv,
    recordStatus: inv.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const buildCustomerInvoiceActionDefinitions = (inv: ApiInvoice): AdvancedActionDefinition<ApiInvoice>[] => {
    const previewKind: DocumentPreviewKind = inv.isSalesReceipt ? 'sales_receipt' : 'invoice';
    return [
      {
        id: 'customer.invoice.view',
        label: 'View & Print',
        icon: <FileText className="w-3.5 h-3.5 text-slate-600" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'invoices:read',
        execute: async () => { await handleOpenPreview(previewKind, inv.id); },
      },
      {
        id: 'customer.invoice.statement',
        label: 'Generate Statement',
        icon: <FileText className="w-3.5 h-3.5 text-indigo-600" />,
        group: 'communication',
        groupLabel: 'Customer',
        requiredPermission: 'customers:read',
        execute: async () => { if (selectedCustomer) await handleOpenStatement(selectedCustomer.id); },
      },
      {
        id: 'customer.invoice.open-sales',
        label: 'Open Sales Center',
        icon: <ArrowUpRight className="w-3.5 h-3.5" />,
        group: 'process',
        groupLabel: 'Navigation',
        requiredPermission: 'invoices:read',
        execute: async () => { setCurrentView('invoices'); },
      },
      {
        id: 'customer.invoice.copy-number',
        label: 'Copy Doc #',
        icon: <Copy className="w-3.5 h-3.5" />,
        group: 'admin',
        groupLabel: 'Other',
        requiredPermission: 'invoices:read',
        execute: async () => {
          await navigator.clipboard?.writeText(inv.invoiceNumber);
          triggerShortcutNotice(`Copied ${inv.invoiceNumber}`);
        },
      },
    ];
  };

  const renderCustomerInvoiceActions = (inv: ApiInvoice) => {
    const defs = buildCustomerInvoiceActionDefinitions(inv);
    const ctx = buildCustomerInvoiceActionContext(inv, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<ApiInvoice>
        label={`Actions for ${inv.invoiceNumber}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={inv.id}
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

  const handleCreatePermit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomer) return;
    try {
      await commercialApi.createResellerPermit({
        customerId: selectedCustomer.id,
        permitNumber: newPermit.permitNumber,
        state: newPermit.state,
        expiresAt: newPermit.expiresAt || undefined,
        notes: newPermit.notes,
      });
      setShowAddPermit(false);
      setNewPermit({ permitNumber: '', state: 'ZM', expiresAt: '', notes: '' });
      await loadData();
      triggerShortcutNotice('Reseller/Tax Exemption Permit saved');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to add permit');
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
            <span>Customer Center</span>
            {loading && <Loader2 className="w-4 h-4 animate-spin text-blue-600" />}
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Live AR sub-ledger, credit limits, tax-exemption reseller permits, and customer statements.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {selectedCustomer && (
            <button
              onClick={() => handleOpenStatement(selectedCustomer.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs shadow-xs"
            >
              <FileText className="w-4 h-4 text-blue-600" />
              <span>Customer Statement</span>
            </button>
          )}
          {canWrite && (
            <button
              onClick={() => setIsNewCustomerOpen(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-sm"
            >
              <Plus className="w-4 h-4" />
              <span>Add Customer</span>
            </button>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-xs flex justify-between">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="font-bold">×</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-4 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden flex flex-col">
          <div className="p-3 border-b border-slate-200 dark:border-slate-800 space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Filter customers..."
                className="w-full pl-8 pr-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-850 text-xs text-slate-900 dark:text-slate-100 outline-none"
              />
            </div>
            <div className="flex justify-between text-[11px] font-mono text-slate-500 pt-1">
              <span>{customers.length} Customers</span>
              <span>
                Total A/R:{' '}
                <strong className="text-blue-600 dark:text-blue-400 tabular-nums">
                  {formatCurrency(totalOutstanding, currency)}
                </strong>
              </span>
            </div>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[600px] overflow-y-auto">
            {filteredCustomers.map(cust => {
              const isSelected = cust.id === selectedCustomer?.id;
              return (
                <button
                  key={cust.id}
                  onClick={() => setSelectedCustomerId(cust.id)}
                  className={`w-full p-3 text-left transition-colors flex items-center justify-between ${
                    isSelected
                      ? 'bg-blue-50 dark:bg-blue-950/50 ring-1 ring-inset ring-blue-500/40'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-850'
                  }`}
                >
                  <div className="truncate pr-2">
                    <div className="font-bold text-xs text-slate-900 dark:text-white truncate">
                      {cust.companyName}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {cust.customerCode} · {cust.name}
                    </div>
                  </div>
                  <div className="text-right shrink-0 font-mono">
                    <div
                      className={`text-xs font-bold tabular-nums ${
                        cust.balance > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'
                      }`}
                    >
                      {formatCurrency(cust.balance, currency)}
                    </div>
                    <div className="text-[10px] text-slate-400">{cust.terms}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-8 space-y-6">
          {selectedCustomer ? (
            <>
              <div className="p-6 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                      <span>{selectedCustomer.companyName}</span>
                      {selectedCustomer.isTaxExempt && selectedCustomer.taxExemptionValid && (
                        <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 text-[10px] font-bold">
                          Tax Exempt
                          {selectedCustomer.taxExemptionExpiry
                            ? ` · exp ${selectedCustomer.taxExemptionExpiry}`
                            : ''}
                        </span>
                      )}
                      {selectedCustomer.isTaxExempt && !selectedCustomer.taxExemptionValid && (
                        <span
                          className="px-2 py-0.5 rounded bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 text-[10px] font-bold"
                          title="No active, unexpired reseller permit — tax will be charged"
                        >
                          Exemption Invalid
                        </span>
                      )}
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          selectedCustomer.customerStatus === 'blocked'
                            ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                            : selectedCustomer.customerStatus === 'inactive'
                            ? 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                            : 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300'
                        }`}
                      >
                        {selectedCustomer.customerStatus}
                      </span>
                    </h2>
                    <div className="text-xs text-slate-500">
                      {selectedCustomer.customerCode} · Primary Contact:{' '}
                      <span className="font-semibold text-slate-700 dark:text-slate-300">
                        {selectedCustomer.name}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => handleOpenStatement(selectedCustomer.id)}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs"
                    >
                      Statement
                    </button>
                    {canSendStatements && selectedCustomer.email && (
                      <button
                        disabled={busy}
                        onClick={() => handleEmailStatement(selectedCustomer.id)}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs flex items-center gap-1 disabled:opacity-50"
                      >
                        <Mail className="w-3.5 h-3.5 text-blue-600" />
                        <span>Email Statement</span>
                      </button>
                    )}
                    {canWrite && (
                      <button
                        onClick={() => setShowAddPermit(true)}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs flex items-center gap-1"
                      >
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Add Permit</span>
                      </button>
                    )}
                    {canChangeCredit && (
                      <button
                        disabled={busy}
                        onClick={handleChangeLimit}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs disabled:opacity-50"
                      >
                        Change Limit
                      </button>
                    )}
                    {canWrite && selectedCustomer.customerStatus !== 'inactive' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          handleStatusChange(
                            selectedCustomer.customerStatus === 'blocked' ? 'active' : 'blocked'
                          )
                        }
                        className={`px-3 py-1.5 rounded-lg border font-semibold text-xs disabled:opacity-50 ${
                          selectedCustomer.customerStatus === 'blocked'
                            ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40'
                            : 'border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40'
                        }`}
                      >
                        {selectedCustomer.customerStatus === 'blocked' ? 'Release Hold' : 'Credit Hold'}
                      </button>
                    )}
                    <button
                      onClick={() => setCurrentView('invoices')}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs"
                    >
                      Sales &amp; Invoices →
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                  <div className="space-y-1">
                    <span className="text-slate-400 font-semibold flex items-center gap-1">
                      <Mail className="w-3.5 h-3.5" /> Email
                    </span>
                    <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                      {selectedCustomer.email || 'None on file'}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-slate-400 font-semibold flex items-center gap-1">
                      <Phone className="w-3.5 h-3.5" /> Phone
                    </span>
                    <div className="font-medium text-slate-800 dark:text-slate-200">
                      {selectedCustomer.phone || 'None on file'}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <span className="text-slate-400 font-semibold flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" /> Terms &amp; Credit Limit
                    </span>
                    <div className="font-semibold text-slate-800 dark:text-slate-200 font-mono">
                      {selectedCustomer.terms}{' '}
                      {selectedCustomer.creditLimit !== null &&
                        `· Limit ${formatCurrency(selectedCustomer.creditLimit, currency)}`}
                    </div>
                  </div>
                </div>

                {creditProfile && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-850/60 border border-slate-200 dark:border-slate-800">
                      <div className="text-[10px] uppercase font-bold text-slate-400">Net Exposure</div>
                      <div className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                        {formatCurrency(creditProfile.exposure, selectedCustomer.currencyCode || currency)}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        Invoices {formatCurrency(creditProfile.openInvoiceBalance, selectedCustomer.currencyCode || currency)}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-850/60 border border-slate-200 dark:border-slate-800">
                      <div className="text-[10px] uppercase font-bold text-slate-400">Available Credit</div>
                      <div
                        className={`font-mono font-bold tabular-nums ${
                          creditProfile.availableCredit !== null && creditProfile.availableCredit < 0
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {creditProfile.availableCredit === null
                          ? 'No limit'
                          : formatCurrency(creditProfile.availableCredit, selectedCustomer.currencyCode || currency)}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        Limit{' '}
                        {creditProfile.creditLimit === null
                          ? '—'
                          : formatCurrency(creditProfile.creditLimit, selectedCustomer.currencyCode || currency)}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-850/60 border border-slate-200 dark:border-slate-800">
                      <div className="text-[10px] uppercase font-bold text-slate-400">Unapplied Cash</div>
                      <div className="font-mono font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                        {formatCurrency(creditProfile.unappliedReceipts, selectedCustomer.currencyCode || currency)}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        Credit memos {formatCurrency(creditProfile.unappliedCreditMemos, selectedCustomer.currencyCode || currency)}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-850/60 border border-slate-200 dark:border-slate-800">
                      <div className="text-[10px] uppercase font-bold text-slate-400">Currency / Terms</div>
                      <div className="font-mono font-bold text-slate-900 dark:text-white">
                        {selectedCustomer.currencyCode || currency}
                      </div>
                      <div className="text-[10px] text-slate-500">{selectedCustomer.terms}</div>
                    </div>
                  </div>
                )}

                <div className="space-y-1 text-xs">
                  <span className="text-slate-400 font-semibold flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5" /> Billing Address
                  </span>
                  <div className="text-slate-700 dark:text-slate-300">
                    {selectedCustomer.billingAddress || 'No address specified'}
                  </div>
                </div>

                {customerPermits.length > 0 && (
                  <div className="p-3 rounded-lg bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 text-xs">
                    <div className="font-bold text-emerald-800 dark:text-emerald-300 mb-1">
                      Reseller / Tax Exemption Permits ({customerPermits.length})
                    </div>
                    <div className="flex flex-wrap gap-3 font-mono text-[11px]">
                      {customerPermits.map(p => (
                        <span key={p.id}>
                          #{p.permitNumber} ({p.state || 'N/A'}) {p.expiresAt ? `exp ${p.expiresAt}` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Invoices Ledger */}
              <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="font-bold text-xs text-slate-900 dark:text-white uppercase tracking-wider">
                    Customer Invoices &amp; Sales Receipts
                  </h3>
                  <span className="text-xs font-mono text-slate-500">{customerInvoices.length} Records</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="px-4 py-2.5">DOC #</th>
                        <th className="px-4 py-2.5">DATE</th>
                        <th className="px-4 py-2.5">DUE DATE</th>
                        <th className="px-4 py-2.5 text-right">TOTAL</th>
                        <th className="px-4 py-2.5 text-right">PAID</th>
                        <th className="px-4 py-2.5 text-right">BALANCE DUE</th>
                        <th className="px-4 py-2.5 text-center">STATUS</th>
                        <th className="px-4 py-2.5 text-right">ACTIONS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                      {customerInvoices.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-8 text-center text-slate-400 font-sans">
                            No active invoices posted for this customer.
                          </td>
                        </tr>
                      ) : (
                        customerInvoices.map(inv => (
                          <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-slate-850/50">
                            <td className="px-4 py-2.5 font-bold text-blue-600 dark:text-blue-400">
                              {inv.invoiceNumber}
                            </td>
                            <td className="px-4 py-2.5 text-slate-500">{inv.invoiceDate}</td>
                            <td className="px-4 py-2.5 text-slate-500">{inv.dueDate}</td>
                            <td className="px-4 py-2.5 text-right font-bold tabular-nums">
                              {formatCurrency(inv.total, currency)}
                            </td>
                            <td className="px-4 py-2.5 text-right text-emerald-600 tabular-nums">
                              {formatCurrency(inv.amountPaid, currency)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-bold text-blue-600 tabular-nums">
                              {formatCurrency(inv.balanceDue, currency)}
                            </td>
                            <td className="px-4 py-2.5 text-center font-sans">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                  inv.balanceDue === 0
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : 'bg-blue-100 text-blue-800'
                                }`}
                              >
                                {inv.isSalesReceipt ? 'Receipt' : inv.status}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right font-sans">
                              {renderCustomerInvoiceActions(inv)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Unapplied cash allocation workbench (D-3 / D-5) */}
              <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="font-bold text-xs text-slate-900 dark:text-white uppercase tracking-wider">
                    Unapplied Receipts
                  </h3>
                  <span className="text-xs font-mono text-slate-500">{unappliedPayments.length} Available</span>
                </div>
                <div className="p-4 space-y-3 text-xs">
                  {unappliedPayments.length === 0 ? (
                    <div className="text-slate-400">No unapplied customer receipts.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="text-[10px] uppercase text-slate-500 border-b dark:border-slate-800">
                          <tr>
                            <th className="py-2">Payment #</th>
                            <th className="py-2">Date</th>
                            <th className="py-2">Method</th>
                            <th className="py-2 text-right">Unapplied</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {unappliedPayments.map(p => (
                            <tr key={p.paymentId}>
                              <td className="py-2 font-bold text-blue-600 dark:text-blue-400">{p.paymentNumber}</td>
                              <td className="py-2 text-slate-500">{p.paymentDate}</td>
                              <td className="py-2 text-slate-500">{p.paymentMethod}</td>
                              <td className="py-2 text-right font-bold text-amber-600 dark:text-amber-400">
                                {formatCurrency(p.unapplied, p.currencyCode || currency)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {canAllocate && unappliedPayments.length > 0 && customerInvoices.some(i => i.balanceDue > 0) && (
                    <form onSubmit={handleAllocate} className="flex flex-wrap items-end gap-2 pt-2 border-t dark:border-slate-800">
                      <div>
                        <label className="font-semibold block mb-1 text-[10px] uppercase text-slate-400">Receipt</label>
                        <select
                          value={allocation.paymentId}
                          onChange={e => setAllocation(p => ({ ...p, paymentId: e.target.value }))}
                          className="border rounded px-2 py-1.5 dark:bg-slate-850 dark:border-slate-700 min-w-[140px]"
                        >
                          <option value="">Select receipt…</option>
                          {unappliedPayments.map(p => (
                            <option key={p.paymentId} value={p.paymentId}>
                              {p.paymentNumber} · {formatCurrency(p.unapplied, p.currencyCode || currency)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="font-semibold block mb-1 text-[10px] uppercase text-slate-400">Invoice</label>
                        <select
                          value={allocation.invoiceId}
                          onChange={e => setAllocation(p => ({ ...p, invoiceId: e.target.value }))}
                          className="border rounded px-2 py-1.5 dark:bg-slate-850 dark:border-slate-700 min-w-[160px]"
                        >
                          <option value="">Select invoice…</option>
                          {customerInvoices
                            .filter(i => i.balanceDue > 0)
                            .map(i => (
                              <option key={i.id} value={i.id}>
                                {i.invoiceNumber} · {formatCurrency(i.balanceDue, currency)} due
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label className="font-semibold block mb-1 text-[10px] uppercase text-slate-400">Amount (optional)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={allocation.amount}
                          onChange={e => setAllocation(p => ({ ...p, amount: e.target.value }))}
                          placeholder="Full remaining"
                          className="border rounded px-2 py-1.5 w-32 font-mono dark:bg-slate-850 dark:border-slate-700"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={busy || !allocation.paymentId || !allocation.invoiceId}
                        className="px-3 py-1.5 rounded bg-blue-600 text-white font-bold disabled:opacity-50"
                      >
                        Apply Receipt
                      </button>
                    </form>
                  )}
                </div>
              </div>

              {/* Statement archive */}
              <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="font-bold text-xs text-slate-900 dark:text-white uppercase tracking-wider">
                    Statement History
                  </h3>
                  <span className="text-xs font-mono text-slate-500">{statements.length} Saved</span>
                </div>
                <div className="p-4 text-xs">
                  {statements.length === 0 ? (
                    <div className="text-slate-400">No statements archived yet.</div>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800">
                      {statements.map(s => (
                        <div key={s.statementId} className="py-2 flex items-center justify-between font-mono">
                          <div>
                            <span className="font-bold">{s.statementDate}</span>{' '}
                            <span className="text-slate-500">
                              ({s.periodStart} → {s.periodEnd})
                            </span>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="text-slate-500">
                              Close {formatCurrency(s.closingBalance, selectedCustomer.currencyCode || currency)}
                            </span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${s.emailedAt ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
                              {s.emailedAt ? 'Emailed' : 'Archived'}
                            </span>
                            <button
                              onClick={() => handleOpenStatement(selectedCustomer.id, s.periodStart, s.periodEnd)}
                              className="text-blue-600 dark:text-blue-400 font-bold"
                            >
                              View
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* FX revaluation (D-8) */}
              {canRevalueFx && (
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
                  <button
                    onClick={() => setShowFxPanel(v => !v)}
                    className="w-full px-5 py-3 flex items-center justify-between text-left"
                  >
                    <span className="font-bold text-xs text-slate-900 dark:text-white uppercase tracking-wider">
                      Period-End FX Revaluation
                    </span>
                    <span className="text-xs text-slate-500">{showFxPanel ? 'Hide' : 'Open'}</span>
                  </button>
                  {showFxPanel && (
                    <div className="p-4 border-t dark:border-slate-800 space-y-3 text-xs">
                      <div className="flex flex-wrap items-end gap-2">
                        <div>
                          <label className="font-semibold block mb-1 text-[10px] uppercase text-slate-400">As of</label>
                          <input
                            type="date"
                            value={fx.asOfDate}
                            onChange={e => setFx(p => ({ ...p, asOfDate: e.target.value }))}
                            className="border rounded px-2 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                          />
                        </div>
                        <div>
                          <label className="font-semibold block mb-1 text-[10px] uppercase text-slate-400">Currency (optional)</label>
                          <input
                            value={fx.currencyCode}
                            maxLength={3}
                            onChange={e => setFx(p => ({ ...p, currencyCode: e.target.value.toUpperCase() }))}
                            placeholder="ALL"
                            className="border rounded px-2 py-1.5 w-24 font-mono dark:bg-slate-850 dark:border-slate-700"
                          />
                        </div>
                        <button
                          onClick={handlePreviewFx}
                          disabled={busy}
                          className="px-3 py-1.5 rounded border font-bold disabled:opacity-50"
                        >
                          Preview
                        </button>
                        <button
                          onClick={handlePostFx}
                          disabled={busy || !fx.preview || fx.preview.posted}
                          className="px-3 py-1.5 rounded bg-indigo-600 text-white font-bold disabled:opacity-50"
                        >
                          Post Revaluation
                        </button>
                      </div>

                      {fx.preview && (
                        <div className="space-y-2">
                          <div className="font-mono text-[11px] text-slate-600 dark:text-slate-300">
                            {fx.preview.invoiceCount} invoices · gain {formatCurrency(fx.preview.totalGain, currency)} · loss{' '}
                            {formatCurrency(fx.preview.totalLoss, currency)} · net {formatCurrency(fx.preview.netAdjustment, currency)}
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-[11px] font-mono">
                              <thead className="text-[10px] uppercase text-slate-500 border-b dark:border-slate-800">
                                <tr>
                                  <th className="py-1.5">Invoice</th>
                                  <th className="py-1.5">Ccy</th>
                                  <th className="py-1.5 text-right">Foreign</th>
                                  <th className="py-1.5 text-right">Closing Rate</th>
                                  <th className="py-1.5 text-right">Revalued</th>
                                  <th className="py-1.5 text-right">Gain/Loss</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                {fx.preview.lines.map((l: any) => (
                                  <tr key={l.invoiceId}>
                                    <td className="py-1.5 font-bold">{l.invoiceNumber}</td>
                                    <td className="py-1.5">{l.currencyCode}</td>
                                    <td className="py-1.5 text-right">{l.foreignBalance.toFixed(2)}</td>
                                    <td className="py-1.5 text-right">{l.closingRate}</td>
                                    <td className="py-1.5 text-right">{formatCurrency(l.revaluedBaseBalance, currency)}</td>
                                    <td className={`py-1.5 text-right font-bold ${l.gainLoss < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                                      {formatCurrency(l.gainLoss, currency)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {fx.runs.length > 0 && (
                        <div className="text-[11px] font-mono text-slate-500">
                          Last posted: {fx.runs[0].asOfDate} · gain {formatCurrency(fx.runs[0].totalGain, currency)} · loss{' '}
                          {formatCurrency(fx.runs[0].totalLoss, currency)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="p-12 text-center text-slate-500 bg-white dark:bg-slate-900 rounded-xl border">
              No customers found in active company.
            </div>
          )}
        </div>
      </div>

      {/* Add Permit Modal */}
      {showAddPermit && selectedCustomer && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between">
              <span className="font-bold text-sm">Add Reseller / Exemption Permit</span>
              <button onClick={() => setShowAddPermit(false)}><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleCreatePermit} className="p-5 space-y-3 text-xs">
              <div>
                <label className="font-semibold block mb-1">Permit / Certificate Number *</label>
                <input
                  required
                  value={newPermit.permitNumber}
                  onChange={e => setNewPermit(p => ({ ...p, permitNumber: e.target.value }))}
                  className="w-full border rounded px-2.5 py-1.5 font-mono dark:bg-slate-850 dark:border-slate-700"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Jurisdiction</label>
                  <input
                    value={newPermit.state}
                    onChange={e => setNewPermit(p => ({ ...p, state: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Expiry Date</label>
                  <input
                    type="date"
                    value={newPermit.expiresAt}
                    onChange={e => setNewPermit(p => ({ ...p, expiresAt: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAddPermit(false)} className="px-3 py-1.5 border rounded">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-emerald-600 text-white rounded font-bold">
                  Save Permit
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Statement Preview Modal */}
      {statementData && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-white text-slate-900 rounded-xl shadow-2xl border overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between">
              <span className="font-bold text-sm">Customer Statement — {statementData.customerName}</span>
              <button onClick={() => setStatementData(null)}><X className="w-4 h-4" /></button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto text-xs">
              <div className="flex flex-wrap items-end gap-2 p-2 rounded bg-slate-50 border border-slate-200">
                <div>
                  <label className="font-semibold block mb-1 text-[10px] uppercase text-slate-500">From</label>
                  <input
                    type="date"
                    value={statementPeriod.start}
                    onChange={e => setStatementPeriod(p => ({ ...p, start: e.target.value }))}
                    className="border rounded px-2 py-1"
                  />
                </div>
                <div>
                  <label className="font-semibold block mb-1 text-[10px] uppercase text-slate-500">To</label>
                  <input
                    type="date"
                    value={statementPeriod.end}
                    onChange={e => setStatementPeriod(p => ({ ...p, end: e.target.value }))}
                    className="border rounded px-2 py-1"
                  />
                </div>
                <button
                  onClick={() =>
                    statementData &&
                    handleOpenStatement(statementData.customerId, statementPeriod.start, statementPeriod.end)
                  }
                  className="px-3 py-1 rounded border bg-white font-bold"
                >
                  Rebuild
                </button>
                {canSendStatements && (
                  <button
                    disabled={busy}
                    onClick={() => statementData && handleEmailStatement(statementData.customerId)}
                    className="px-3 py-1 rounded bg-blue-600 text-white font-bold disabled:opacity-50"
                  >
                    {busy ? 'Queueing…' : 'Email Statement'}
                  </button>
                )}
              </div>
              <div className="flex justify-between font-mono border-b pb-3">
                <div>
                  <div className="font-bold text-sm font-sans">{statementData.customerName}</div>
                  <div className="text-slate-500">
                    Period: {statementData.periodStart} to {statementData.periodEnd}
                  </div>
                </div>
                <div className="text-right">
                  <div>Opening Balance: {formatCurrency(statementData.openingBalance, currency)}</div>
                  <div className="font-bold text-sm text-blue-700">
                    Closing Balance: {formatCurrency(statementData.closingBalance, currency)}
                  </div>
                </div>
              </div>
              {statementData.aging && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 font-mono text-[11px]">
                  {[
                    ['Current', statementData.aging.current],
                    ['1–30', statementData.aging.days1To30],
                    ['31–60', statementData.aging.days31To60],
                    ['61–90', statementData.aging.days61To90],
                    ['90+', statementData.aging.daysOver90],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="p-2 rounded border bg-slate-50">
                      <div className="text-[9px] uppercase text-slate-500 font-bold">{label}</div>
                      <div className="font-bold">{formatCurrency(Number(value), statementData.currencyCode || currency)}</div>
                    </div>
                  ))}
                </div>
              )}
              <table className="w-full text-left border-collapse border border-slate-200 font-mono">
                <thead className="bg-slate-100 text-[10px] uppercase">
                  <tr>
                    <th className="p-2 border-b">Date</th>
                    <th className="p-2 border-b">Type</th>
                    <th className="p-2 border-b">Doc #</th>
                    <th className="p-2 border-b text-right">Charges</th>
                    <th className="p-2 border-b text-right">Credits/Pmts</th>
                    <th className="p-2 border-b text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {statementData.lines.map((l: any, idx: number) => (
                    <tr key={idx}>
                      <td className="p-2">{l.date}</td>
                      <td className="p-2 font-sans">{l.type}</td>
                      <td className="p-2 font-bold">{l.number}</td>
                      <td className="p-2 text-right">{l.charge > 0 ? formatCurrency(l.charge, currency) : '—'}</td>
                      <td className="p-2 text-right text-emerald-700">
                        {l.credit > 0 ? `-${formatCurrency(l.credit, currency)}` : '—'}
                      </td>
                      <td className="p-2 text-right font-bold">{formatCurrency(l.runningBalance, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
