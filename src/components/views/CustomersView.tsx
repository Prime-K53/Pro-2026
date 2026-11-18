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
  const { companyProfile, setCurrentView, triggerShortcutNotice, openDocumentPreview } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canWrite = hasPermission('customers:write');

  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [invoices, setInvoices] = useState<ApiInvoice[]>([]);
  const [permits, setPermits] = useState<any[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Add Customer Modal
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [newCust, setNewCust] = useState({
    companyName: '',
    name: '',
    email: '',
    phone: '',
    address: '',
    terms: 'Net 30',
    creditLimit: '',
    taxExempt: false,
  });

  // Reseller Permit Modal
  const [showAddPermit, setShowAddPermit] = useState(false);
  const [newPermit, setNewPermit] = useState({ permitNumber: '', state: 'ZM', expiresAt: '', notes: '' });

  // Live Statement Modal
  const [statementData, setStatementData] = useState<any | null>(null);

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

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await commercialApi.createCustomer({
        companyName: newCust.companyName,
        name: newCust.name || newCust.companyName,
        email: newCust.email,
        phone: newCust.phone,
        address: newCust.address,
        terms: newCust.terms,
        creditLimit: newCust.creditLimit ? Number(newCust.creditLimit) : null,
        taxExempt: newCust.taxExempt,
      });
      setSelectedCustomerId(created.id);
      setShowAddCustomer(false);
      setNewCust({
        companyName: '',
        name: '',
        email: '',
        phone: '',
        address: '',
        terms: 'Net 30',
        creditLimit: '',
        taxExempt: false,
      });
      triggerShortcutNotice(`Customer ${created.companyName} saved to PostgreSQL`);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to create customer');
    }
  };

  const handleOpenStatement = async (customerId: number) => {
    try {
      const stmt = await commercialApi.getCustomerStatement(customerId, { saveSnapshot: true });
      setStatementData(stmt);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to generate customer statement');
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
              onClick={() => setShowAddCustomer(true)}
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
                    <div className="text-[11px] text-slate-500 truncate">{cust.name}</div>
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
                      {selectedCustomer.taxExempt && (
                        <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 text-[10px] font-bold">
                          Tax Exempt
                        </span>
                      )}
                    </h2>
                    <div className="text-xs text-slate-500">
                      Primary Contact:{' '}
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
                    {canWrite && (
                      <button
                        onClick={() => setShowAddPermit(true)}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs flex items-center gap-1"
                      >
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Add Permit</span>
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

                <div className="space-y-1 text-xs">
                  <span className="text-slate-400 font-semibold flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5" /> Billing Address
                  </span>
                  <div className="text-slate-700 dark:text-slate-300">
                    {selectedCustomer.address || 'No address specified'}
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
            </>
          ) : (
            <div className="p-12 text-center text-slate-500 bg-white dark:bg-slate-900 rounded-xl border">
              No customers found in active company.
            </div>
          )}
        </div>
      </div>

      {/* Add Customer Modal */}
      {showAddCustomer && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between">
              <span className="font-bold text-sm">Add Customer</span>
              <button onClick={() => setShowAddCustomer(false)}><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleCreateCustomer} className="p-5 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Company / School Name *</label>
                  <input
                    required
                    value={newCust.companyName}
                    onChange={e => setNewCust(p => ({ ...p, companyName: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Contact Name</label>
                  <input
                    value={newCust.name}
                    onChange={e => setNewCust(p => ({ ...p, name: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Email</label>
                  <input
                    type="email"
                    value={newCust.email}
                    onChange={e => setNewCust(p => ({ ...p, email: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Phone</label>
                  <input
                    value={newCust.phone}
                    onChange={e => setNewCust(p => ({ ...p, phone: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Payment Terms</label>
                  <select
                    value={newCust.terms}
                    onChange={e => setNewCust(p => ({ ...p, terms: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  >
                    <option value="Due on Receipt">Due on Receipt</option>
                    <option value="Net 15">Net 15</option>
                    <option value="Net 30">Net 30</option>
                    <option value="Net 60">Net 60</option>
                  </select>
                </div>
                <div>
                  <label className="font-semibold block mb-1">Credit Limit ({currency})</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newCust.creditLimit}
                    onChange={e => setNewCust(p => ({ ...p, creditLimit: e.target.value }))}
                    placeholder="Optional"
                    className="w-full border rounded px-2.5 py-1.5 font-mono dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
              </div>
              <div>
                <label className="font-semibold block mb-1">Billing Address</label>
                <input
                  value={newCust.address}
                  onChange={e => setNewCust(p => ({ ...p, address: e.target.value }))}
                  className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                />
              </div>
              <label className="flex items-center gap-2 font-semibold">
                <input
                  type="checkbox"
                  checked={newCust.taxExempt}
                  onChange={e => setNewCust(p => ({ ...p, taxExempt: e.target.checked }))}
                />
                <span>Customer is Tax Exempt</span>
              </label>
              <div className="flex justify-end gap-2 pt-2 border-t dark:border-slate-800">
                <button type="button" onClick={() => setShowAddCustomer(false)} className="px-3 py-1.5 border rounded">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-blue-600 text-white rounded font-bold">
                  Save Customer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
