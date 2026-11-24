import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { taxApi, ApiTaxCode } from '../../services/taxApi';
import { Loader2, Percent, AlertTriangle } from 'lucide-react';

/**
 * Tax codes & rates: manage the per-company tax code registry (rate +
 * jurisdiction) and review the tax collected by jurisdiction for a period.
 */
export const TaxCodesView: React.FC = () => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [codes, setCodes] = useState<ApiTaxCode[]>([]);
  const [summary, setSummary] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');

  const [startDate, setStartDate] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, s] = await Promise.all([taxApi.listCodes(), taxApi.summary(startDate, endDate)]);
      setCodes(c);
      setSummary(s);
    } catch (err: any) {
      setError(err?.message || 'Failed to load tax codes');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await taxApi.createCode({ code, name, rate, jurisdiction: jurisdiction || 'General' });
      triggerShortcutNotice(`Tax code ${code.toUpperCase()} created`);
      setCode('');
      setName('');
      setRate('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to create tax code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Tax Codes &amp; Rates</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          Define tax codes (rate + jurisdiction) and review tax collected by jurisdiction.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Create tax code */}
      <form onSubmit={handleCreate} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs items-end">
        <label className="space-y-1">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Code</span>
          <input value={code} onChange={e => setCode(e.target.value)} required className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 font-mono" />
        </label>
        <label className="space-y-1">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Name</span>
          <input value={name} onChange={e => setName(e.target.value)} required className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5" />
        </label>
        <label className="space-y-1">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Rate (%)</span>
          <input type="number" min="0" step="0.0001" value={rate} onChange={e => setRate(e.target.value)} required className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5" />
        </label>
        <label className="space-y-1">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Jurisdiction</span>
          <input value={jurisdiction} onChange={e => setJurisdiction(e.target.value)} placeholder="General" className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5" />
        </label>
        <button type="submit" disabled={busy} className="btn btn-primary disabled:opacity-50">
          <Percent className="w-4 h-4" /> Add Code
        </button>
      </form>

      {/* Codes table */}
      {loading ? (
        <div className="p-10 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading tax codes…
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase font-bold text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2.5">Code</th>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5 text-right">Rate</th>
                <th className="px-4 py-2.5">Jurisdiction</th>
                <th className="px-4 py-2.5">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {codes.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No tax codes defined.</td></tr>
              ) : (
                codes.map(c => (
                  <tr key={c.id}>
                    <td className="px-4 py-2 font-mono font-bold">{c.code}</td>
                    <td className="px-4 py-2">{c.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono">{(Number(c.rate) || 0).toFixed(4)}%</td>
                    <td className="px-4 py-2 text-slate-500">{c.jurisdiction}</td>
                    <td className="px-4 py-2">{c.is_active ? 'Yes' : 'No'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Tax summary by jurisdiction */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Tax Collected by Jurisdiction</h3>
          <div className="flex items-center gap-2 text-xs">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2 py-1" />
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2 py-1" />
          </div>
        </div>
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase font-bold text-slate-500 border-b border-slate-200 dark:border-slate-800">
            <tr>
              <th className="px-4 py-2.5">Jurisdiction</th>
              <th className="px-4 py-2.5 text-right">Invoices</th>
              <th className="px-4 py-2.5 text-right">Taxable Sales</th>
              <th className="px-4 py-2.5 text-right">Tax Collected</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(summary?.rows || []).length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">No invoices in this period.</td></tr>
            ) : (
              (summary?.rows || []).map((r: any) => (
                <tr key={r.jurisdiction}>
                  <td className="px-4 py-2 font-semibold">{r.jurisdiction}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.invoiceCount}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(Number(r.taxableSales), currency)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(Number(r.taxCollected), currency)}</td>
                </tr>
              ))
            )}
          </tbody>
          {summary?.totals && (
            <tfoot className="bg-slate-50 dark:bg-slate-800/60 font-bold">
              <tr>
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right tabular-nums">{summary.totals.invoiceCount}</td>
                <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(Number(summary.totals.taxableSales), currency)}</td>
                <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(Number(summary.totals.taxCollected), currency)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
};