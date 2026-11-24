import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { complianceApi, ComplianceCustomerStatement, ComplianceVendor1099Row } from '../../services/complianceApi';
import { Loader2, FileText, Printer, AlertTriangle } from 'lucide-react';

/**
 * Compliance & self-service center: customer statements (AR statement of
 * account) and vendor 1099-style disbursement summaries for a calendar year.
 * Read-only working papers; nothing here mutates the ledger.
 */
export const ComplianceView: React.FC = () => {
  const { companyProfile, customers, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [statementLoading, setStatementLoading] = useState(false);
  const [vendor1099Loading, setVendor1099Loading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [custId, setCustId] = useState(() => (customers[0] ? String(customers[0].id) : ''));
  const [startDate, setStartDate] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [year, setYear] = useState(() => new Date().getFullYear());

  const customer = useMemo(() => customers.find(c => String(c.id) === custId), [customers, custId]);

  const loadStatement = useCallback(async () => {
    if (!custId || !customer) return;
    setStatementLoading(true);
    setError(null);
    try {
      const stmt: ComplianceCustomerStatement = await complianceApi.customerStatement(
        Number(custId),
        startDate,
        endDate
      );
      setDetail(stmt);
    } catch (err: any) {
      setError(err?.message || 'Failed to load customer statement');
    } finally {
      setStatementLoading(false);
    }
  }, [custId, customer, startDate, endDate]);

  useEffect(() => { loadStatement(); }, [loadStatement]);

  const [detail, setDetail] = useState<ComplianceCustomerStatement | null>(null);
  const [vendor1099, setVendor1099] = useState<ComplianceVendor1099Row[] | null>(null);

  const loadVendor1099 = useCallback(async () => {
    setVendor1099Loading(true);
    setError(null);
    try {
      const summary = await complianceApi.vendor1099Summary(Number(year));
      setVendor1099(summary.vendors);
    } catch (err: any) {
      setError(err?.message || 'Failed to load vendor summary');
    } finally {
      setVendor1099Loading(false);
    }
  }, [year]);

  useEffect(() => { loadVendor1099(); }, [loadVendor1099]);

  const handlePrintStatement = () => window.print();

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Compliance &amp; Self-Service</h1>
          <p className="text-xs text-slate-500 mt-0.5">Customer statements (AR) and vendor 1099-style disbursement summaries.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => window.print()} className="btn btn-secondary text-xs">
            <Printer className="w-4 h-4" /> Print
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" /><span>{error}</span>
        </div>
      )}

      {/* Customer Statement */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Customer Statement</h3>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
            <label className="space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Customer</span>
              <select value={custId} onChange={e => setCustId(e.target.value)} className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5">
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">From</span>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5" />
            </label>
            <label className="space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">To</span>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5" />
            </label>
            <div className="flex items-end">
              <button onClick={loadStatement} disabled={statementLoading} className="btn btn-primary disabled:opacity-50">
                {statementLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Load
              </button>
            </div>
          </div>
          {detail && (
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="font-bold">{detail.customerName}</span>
                <span className="text-xs text-slate-500">{detail.startDate} → {detail.endDate}</span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-xs text-slate-500">
                <div>
                  <span className="block text-[10px] uppercase font-bold">Opening Balance</span>
                  <span className="font-mono">{formatCurrency(Number(detail.openingBalance), currency)}</span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase font-bold">Total Invoiced</span>
                  <span className="font-mono">{formatCurrency(Number(detail.totalInvoiced), currency)}</span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase font-bold">Total Paid</span>
                  <span className="font-mono">{formatCurrency(Number(detail.totalPaid), currency)}</span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase font-bold">Total Credits</span>
                  <span className="font-mono">{formatCurrency(Number(detail.totalCredits), currency)}</span>
                </div>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase font-bold text-slate-500 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-2.5">Date</th>
                    <th className="px-4 py-2.5">Type</th>
                    <th className="px-4 py-2.5">Reference</th>
                    <th className="px-4 py-2.5 text-right">Debit</th>
                    <th className="px-4 py-2.5 text-right">Credit</th>
                    <th className="px-4 py-2.5 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {detail.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-4 py-2">{l.date}</td>
                      <td className="px-4 py-2 text-slate-500">{l.type}</td>
                      <td className="px-4 py-2">{l.reference}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-mono">{l.debit ? formatCurrency(l.debit, currency) : ''}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-mono">{l.credit ? formatCurrency(l.credit, currency) : ''}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(l.runningBalance, currency)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200 dark:border-slate-800 font-bold">
                    <td className="px-4 py-2" colSpan={4}>Balance</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono"></td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(detail.closingBalance, currency)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Vendor 1099 summary */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Vendor 1099-Style Summary</h3>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
            <label className="space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Year</span>
              <input
                type="number" min="2000" max="2100" value={year} onChange={e => setYear(Number(e.target.value))}
                className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
              />
            </label>
            <div className="flex items-end">
              <button onClick={loadVendor1099} disabled={vendor1099Loading} className="btn btn-primary disabled:opacity-50">
                {vendor1099Loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Load
              </button>
            </div>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase font-bold text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2.5">Vendor</th>
                <th className="px-4 py-2.5 text-right">Payments</th>
                <th className="px-4 py-2.5 text-right">TIN</th>
                <th className="px-4 py-2.5 text-right">Total Paid</th>
                <th className="px-4 py-2.5 text-center">1099-Eligible</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {!vendor1099 || vendor1099.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No vendors in this year.</td></tr>
              ) : (
                vendor1099.map(v => (
                  <tr key={v.vendorId}>
                    <td className="px-4 py-2">{v.companyName}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{v.paymentCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono">{v.tin || '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(v.totalPaid, currency)}</td>
                    <td className="px-4 py-2 text-center">{v.is1099Eligible ? 'Yes' : 'No'}</td>
                  </tr>
                ))
              )}
            </tbody>
            {vendor1099 && vendor1099.length > 0 && (
              <tfoot className="bg-slate-50 dark:bg-slate-800/60 font-bold">
                <tr>
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right tabular-nums"></td>
                  <td className="px-4 py-2 text-right tabular-nums"></td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(vendor1099.reduce((s, v) => s + v.totalPaid, 0), currency)}</td>
                  <td className="px-4 py-2 text-right tabular-nums"></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
};