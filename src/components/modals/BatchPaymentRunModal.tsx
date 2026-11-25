import React, { useMemo, useState } from 'react';
import { X, Loader2, Banknote } from 'lucide-react';
import { commercialApi } from '../../services/commercialApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  bills: any[];
  bankAccounts: Array<{ id: number; name: string; code?: string }>;
}

export const BatchPaymentRunModal: React.FC<Props> = ({ isOpen, onClose, onSuccess, bills, bankAccounts }) => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const [bankAccountId, setBankAccountId] = useState<number>(bankAccounts[0]?.id || 0);
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payableBills = useMemo(() => bills.filter(b => !b.paymentHold && b.status !== 'voided' && b.status !== 'paid' && Number(b.balanceDue || 0) > 0), [bills]);
  const selectedBills = payableBills.filter(b => selected[b.id]);
  const total = selectedBills.reduce((s, b) => s + Number(b.balanceDue || 0), 0);
  const vendorGroups = Object.values(selectedBills.reduce((acc: any, b: any) => {
    const k = String(b.vendorId || b.vendorName || 'unknown');
    if (!acc[k]) acc[k] = { vendorName: b.vendorName || 'Vendor', count: 0, total: 0 };
    acc[k].count += 1;
    acc[k].total += Number(b.balanceDue || 0);
    return acc;
  }, {}));

  if (!isOpen) return null;

  const toggle = (id: number) => setSelected(prev => ({ ...prev, [id]: !prev[id] }));
  const allSelected = payableBills.length > 0 && selectedBills.length === payableBills.length;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bankAccountId) { setError('Select a bank account'); return; }
    if (selectedBills.length === 0) { setError('Select at least one bill'); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await commercialApi.executeBatchPaymentRun({
        bankAccountId,
        billIds: selectedBills.map(b => b.id),
        paymentDate,
        memo: `Batch payment run (${selectedBills.length} bills)`,
      });
      triggerShortcutNotice(`Batch payment run ${res.runNumber || ''} posted for ${formatCurrency(total, currency)}`);
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Batch payment run failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-4xl w-full p-6 space-y-4 shadow-xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2"><Banknote className="w-5 h-5 text-emerald-600" /> Batch Payment Run</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
        </div>
        {error && <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 text-xs">{error}</div>}
        <form onSubmit={submit} className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">Bank account</label>
              <select value={bankAccountId} onChange={e => setBankAccountId(Number(e.target.value))} className="w-full p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850">
                <option value={0}>Select bank account</option>
                {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.code ? `${a.code} - ` : ''}{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">Payment date</label>
              <input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} className="w-full p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850" />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-50 dark:bg-slate-850 text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left"><input type="checkbox" checked={allSelected} onChange={e => { const checked = e.target.checked; const next: Record<number, boolean> = {}; payableBills.forEach(b => next[b.id] = checked); setSelected(next); }} /></th>
                  <th className="px-3 py-2 text-left">Bill</th>
                  <th className="px-3 py-2 text-left">Vendor</th>
                  <th className="px-3 py-2 text-left">Due</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {payableBills.length === 0 ? (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">No payable bills available (held/voided/paid bills excluded).</td></tr>
                ) : payableBills.map(b => (
                  <tr key={b.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2"><input type="checkbox" checked={!!selected[b.id]} onChange={() => toggle(b.id)} /></td>
                    <td className="px-3 py-2 font-mono">{b.billNumber}</td>
                    <td className="px-3 py-2">{b.vendorName}</td>
                    <td className="px-3 py-2">{b.dueDate}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(Number(b.balanceDue || 0), currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800 gap-4">
            <div className="text-slate-500 space-y-1">
              <div>Selected: <span className="font-semibold text-slate-900 dark:text-white">{selectedBills.length}</span> · Gross total: <span className="font-semibold text-slate-900 dark:text-white">{formatCurrency(total, currency)}</span></div>
              <div className="text-[10px] text-slate-400">Preview is gross v1 (withholding/discount/bank-balance checks not auto-applied in this modal).</div>
              {vendorGroups.length > 0 && <div className="text-[10px] text-slate-400">Vendors: {vendorGroups.map((g: any) => `${g.vendorName} (${g.count}, ${formatCurrency(g.total, currency)})`).join(' · ')}</div>}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} disabled={loading} className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300">Cancel</button>
              <button type="submit" disabled={loading || selectedBills.length === 0} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold disabled:opacity-50">
                {loading ? <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Posting...</span> : 'Post Batch Payment Run'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};