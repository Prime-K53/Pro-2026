import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT } from '../../services/accountingApi';
import { ApiBill, ApiVendor, commercialApi } from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
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
} from 'lucide-react';

export const VendorsView: React.FC = () => {
  const { companyProfile, setCurrentView, triggerShortcutNotice } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canWrite = hasPermission('vendors:write');

  const [vendors, setVendors] = useState<ApiVendor[]>([]);
  const [bills, setBills] = useState<ApiBill[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [showAddVendor, setShowAddVendor] = useState(false);
  const [newVendor, setNewVendor] = useState({
    companyName: '',
    name: '',
    email: '',
    phone: '',
    address: '',
    taxId: '',
    terms: 'Net 30',
    is1099Eligible: false,
  });
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

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const onUpdated = () => loadData();
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, onUpdated);
  }, [loadData]);

  const filteredVendors = vendors.filter(
    v =>
      v.companyName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      v.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      v.taxId.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedVendor = vendors.find(v => v.id === selectedVendorId) || vendors[0] || null;
  const vendorBills = selectedVendor
    ? bills.filter(b => b.vendorId === selectedVendor.id && b.status !== 'voided')
    : [];

  const handleCreateVendor = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await commercialApi.createVendor(newVendor);
      setSelectedVendorId(created.id);
      setShowAddVendor(false);
      setNewVendor({
        companyName: '',
        name: '',
        email: '',
        phone: '',
        address: '',
        taxId: '',
        terms: 'Net 30',
        is1099Eligible: false,
      });
      triggerShortcutNotice(`Vendor ${created.companyName} saved`);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to add vendor');
    }
  };

  const handleOpenStatement = async (vendorId: number) => {
    try {
      const stmt = await commercialApi.getVendorStatement(vendorId);
      setStatementData(stmt);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load supplier statement');
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
      execute: async () => { setCurrentView('bills'); },
    },
    {
      id: 'vendor.bill.statement',
      label: 'Supplier Statement',
      icon: <FileText className="w-3.5 h-3.5 text-amber-600" />,
      group: 'communication',
      groupLabel: 'Supplier',
      requiredPermission: 'vendors:read',
      execute: async () => { if (selectedVendor) await handleOpenStatement(selectedVendor.id); },
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
        onExecuteAction={async (action) => {
          const def = action.definition;
          if (typeof def.execute === 'function') {
            await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) });
          }
        }}
      />
    );
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
            <span>Vendor &amp; Supplier Center</span>
            {loading && <Loader2 className="w-4 h-4 animate-spin text-amber-600" />}
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Live AP sub-ledger, supplier TPIN/1099 details, and supplier account statements.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {selectedVendor && (
            <button
              onClick={() => handleOpenStatement(selectedVendor.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold"
            >
              <FileText className="w-4 h-4 text-amber-600" />
              <span>Supplier Statement</span>
            </button>
          )}
          {canWrite && (
            <button
              onClick={() => setShowAddVendor(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold text-xs shadow-sm"
            >
              <Plus className="w-4 h-4" />
              <span>Add Vendor</span>
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
          <div className="p-3 border-b border-slate-200 dark:border-slate-800">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Filter suppliers..."
                className="w-full pl-8 pr-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-850 text-xs outline-none"
              />
            </div>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[600px] overflow-y-auto">
            {filteredVendors.map(v => {
              const isSelected = v.id === selectedVendor?.id;
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
                    <div className="font-bold text-xs text-slate-900 dark:text-white truncate">{v.companyName}</div>
                    <div className="text-[11px] text-slate-500 truncate">{v.name}</div>
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
              <div className="p-6 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">{selectedVendor.companyName}</h2>
                    <div className="text-xs text-slate-500">
                      Contact: <span className="font-semibold text-slate-700 dark:text-slate-300">{selectedVendor.name}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => setCurrentView('bills')}
                    className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs shadow-xs"
                  >
                    Open Bills &amp; POs →
                  </button>
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

                <div className="space-y-1 text-xs">
                  <span className="text-slate-400 font-semibold flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5" /> Remit Address
                  </span>
                  <div className="text-slate-700 dark:text-slate-300">
                    {selectedVendor.address || 'No address specified'}
                  </div>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="font-bold text-xs uppercase tracking-wider">Vendor Bills &amp; Payables</h3>
                  <span className="text-xs font-mono text-slate-500">{vendorBills.length} Bills</span>
                </div>
                <div className="overflow-x-auto">
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
                                  b.balanceDue === 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
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
            </>
          ) : (
            <div className="p-12 text-center text-slate-500 bg-white dark:bg-slate-900 rounded-xl border">
              No suppliers configured yet.
            </div>
          )}
        </div>
      </div>

      {/* Add Vendor Modal */}
      {showAddVendor && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-xl shadow-2xl border overflow-hidden">
            <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between">
              <span className="font-bold text-sm">Add Supplier / Vendor</span>
              <button onClick={() => setShowAddVendor(false)}><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleCreateVendor} className="p-5 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Supplier Company Name *</label>
                  <input
                    required
                    value={newVendor.companyName}
                    onChange={e => setNewVendor(p => ({ ...p, companyName: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Contact Name</label>
                  <input
                    value={newVendor.name}
                    onChange={e => setNewVendor(p => ({ ...p, name: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Email</label>
                  <input
                    type="email"
                    value={newVendor.email}
                    onChange={e => setNewVendor(p => ({ ...p, email: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Tax ID / TPIN</label>
                  <input
                    value={newVendor.taxId}
                    onChange={e => setNewVendor(p => ({ ...p, taxId: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 font-mono dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Phone</label>
                  <input
                    value={newVendor.phone}
                    onChange={e => setNewVendor(p => ({ ...p, phone: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Terms</label>
                  <select
                    value={newVendor.terms}
                    onChange={e => setNewVendor(p => ({ ...p, terms: e.target.value }))}
                    className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                  >
                    <option value="Due on Receipt">Due on Receipt</option>
                    <option value="Net 15">Net 15</option>
                    <option value="Net 30">Net 30</option>
                    <option value="Net 60">Net 60</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="font-semibold block mb-1">Address</label>
                <input
                  value={newVendor.address}
                  onChange={e => setNewVendor(p => ({ ...p, address: e.target.value }))}
                  className="w-full border rounded px-2.5 py-1.5 dark:bg-slate-850 dark:border-slate-700"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t dark:border-slate-800">
                <button type="button" onClick={() => setShowAddVendor(false)} className="px-3 py-1.5 border rounded">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-1.5 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded font-bold">
                  Save Vendor
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Supplier Statement Modal */}
      {statementData && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-white text-slate-900 rounded-xl shadow-2xl border overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between">
              <span className="font-bold text-sm">Supplier Statement — {statementData.vendorName}</span>
              <button onClick={() => setStatementData(null)}><X className="w-4 h-4" /></button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto text-xs">
              <div className="flex justify-between font-mono border-b pb-3">
                <div>
                  <div className="font-bold text-sm font-sans">{statementData.vendorName}</div>
                  <div className="text-slate-500">
                    Period: {statementData.periodStart} to {statementData.periodEnd}
                  </div>
                </div>
                <div className="text-right">
                  <div>Opening AP: {formatCurrency(statementData.openingBalance, currency)}</div>
                  <div className="font-bold text-sm text-rose-700">
                    Closing AP: {formatCurrency(statementData.closingBalance, currency)}
                  </div>
                </div>
              </div>
              <table className="w-full text-left border-collapse border border-slate-200 font-mono">
                <thead className="bg-slate-100 text-[10px] uppercase">
                  <tr>
                    <th className="p-2 border-b">Date</th>
                    <th className="p-2 border-b">Type</th>
                    <th className="p-2 border-b">Doc #</th>
                    <th className="p-2 border-b text-right">Bills</th>
                    <th className="p-2 border-b text-right">Payments/Credits</th>
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
