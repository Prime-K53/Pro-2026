import React, { useState, useEffect } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { commercialApi, ApiBill, ApiVendor } from '../../services/commercialApi';
import { accountingApi, ApiAccount } from '../../services/accountingApi';
import { RowActionMenu } from '../common/RowActionMenu';
import { X, CheckCircle2, DollarSign, AlertCircle, Building2, CheckSquare, Square, Landmark, Copy, Loader2 } from 'lucide-react';

export const PayBillsModal: React.FC = () => {
  const { isPayBillsOpen, setIsPayBillsOpen, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [bills, setBills] = useState<ApiBill[]>([]);
  const [vendors, setVendors] = useState<ApiVendor[]>([]);
  const [bankAccounts, setBankAccounts] = useState<ApiAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedBankId, setSelectedBankId] = useState<string>('');
  const [selectedBillIds, setSelectedBillIds] = useState<string[]>([]);
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [startingCheckNum, setStartingCheckNum] = useState(3510);
  const [paymentMethod, setPaymentMethod] = useState<'Check' | 'ACH' | 'Credit Card'>('Check');

  useEffect(() => {
    if (!isPayBillsOpen) return;
    setLoading(true);
    setError(null);
    Promise.all([
      commercialApi.listBills().catch(() => [] as ApiBill[]),
      commercialApi.listVendors().catch(() => [] as ApiVendor[]),
      accountingApi.listAccounts(true).catch(() => [] as ApiAccount[]),
    ]).then(([bs, vs, accts]) => {
      const unpaid = bs.filter(b => b.status !== 'voided' && (b.balanceDue || 0) > 0);
      setBills(unpaid);
      setVendors(vs);
      const banks = accts.filter(a => a.account_type === 'Bank');
      setBankAccounts(banks);
      setSelectedBillIds(unpaid.map(b => String(b.id)));
      if (banks.length && !selectedBankId) setSelectedBankId(String(banks[0].id));
      setLoading(false);
    }).catch(err => { setError(err?.message || 'Failed to load data'); setLoading(false); });
  }, [isPayBillsOpen]);

  useEffect(() => {
    if (!isPayBillsOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsPayBillsOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isPayBillsOpen, setIsPayBillsOpen]);

  if (!isPayBillsOpen) return null;

  const unpaidBills = bills;
  const bankAccountsList = bankAccounts;
  const currentBank = bankAccounts.find(a => String(a.id) === selectedBankId);

  const toggleBill = (id: string) => {
    setSelectedBillIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const selectAll = () => setSelectedBillIds(unpaidBills.map(b => String(b.id)));
  const clearAll = () => setSelectedBillIds([]);

  const selectedBills = unpaidBills.filter(b => selectedBillIds.includes(String(b.id)));
  const totalPaymentAmount = selectedBills.reduce((sum, b) => sum + (b.balanceDue || 0), 0);

  const handlePaySelectedBills = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedBills.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const allocs = selectedBills.map(b => ({ billId: b.id, amount: String(b.balanceDue || 0) }));
      const vendorId = selectedBills[0].vendorId;
      await commercialApi.recordBillPayment({
        vendorId,
        paymentDate,
        bankAccountId: selectedBankId ? Number(selectedBankId) : undefined,
        checkNumber: paymentMethod === 'Check' ? `CHK-${startingCheckNum}` : undefined,
        currencyCode: selectedBills[0].currencyCode || 'ZMW',
        exchangeRate: selectedBills[0].exchangeRate || 1,
        allocations: allocs,
      });
      triggerShortcutNotice?.(`Disbursed payments for ${selectedBills.length} bills totaling ${formatCurrency(totalPaymentAmount, currency)}`);
      setIsPayBillsOpen(false);
    } catch (err: any) {
      setError(err?.message || 'Bill payment failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-bills-title"
        className="w-full max-w-4xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]"
      >
        <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-amber-300" />
            <h2 id="pay-bills-title" className="font-bold text-base tracking-tight">Pay Bills (Batch Disbursement)</h2>
          </div>
          <button onClick={() => setIsPayBillsOpen(false)} aria-label="Close pay bills dialog" className="p-1 rounded hover:bg-white/10 text-white/80 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handlePaySelectedBills} className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {loading && <div className="text-slate-500">Loading...</div>}
          {error && <div className="text-rose-600">{error}</div>}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 rounded-xl bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 items-center">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Payment Account</label>
              <select value={selectedBankId} onChange={e => setSelectedBankId(e.target.value)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-1.5 text-xs" required>
                {bankAccountsList.map(b => (
                  <option key={b.id} value={b.id}>{b.code} - {b.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Payment Date</label>
              <input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-1.5 text-xs" required />
            </div>
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Method</label>
              <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as any)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-1.5 text-xs">
                <option value="Check">Check</option>
                <option value="ACH">ACH / Electronic Transfer</option>
                <option value="Credit Card">Credit Card</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={selectAll} className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold text-[11px]">Select All ({unpaidBills.length})</button>
            <button type="button" onClick={clearAll} className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold text-[11px]">Clear Selection</button>
          </div>
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#0f3d63] text-white uppercase tracking-wider font-bold text-[10px]">
                <tr>
                  <th className="px-3 py-2.5 w-12 text-center">PAY</th>
                  <th className="px-3 py-2.5">BILL #</th>
                  <th className="px-3 py-2.5">VENDOR</th>
                  <th className="px-3 py-2.5">DUE DATE</th>
                  <th className="px-3 py-2.5 text-right">BALANCE DUE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                {unpaidBills.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500 font-sans">All vendor bills are paid in full!</td></tr>
                ) : (
                  unpaidBills.map(b => {
                    const vendor = vendors.find(v => v.id === b.vendorId);
                    const isSelected = selectedBillIds.includes(String(b.id));
                    return (
                      <tr key={b.id} onClick={() => toggleBill(String(b.id))} className={`cursor-pointer transition-colors ${isSelected ? 'bg-blue-50/50 dark:bg-blue-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-850/50'}`}>
                        <td className="px-3 py-2.5 text-center">
                          {isSelected ? <CheckSquare className="w-4 h-4 text-emerald-600 mx-auto" /> : <Square className="w-4 h-4 text-slate-300 dark:text-slate-600 mx-auto" />}
                        </td>
                        <td className="px-3 py-2.5 font-bold text-slate-900 dark:text-white">{b.billNumber}</td>
                        <td className="px-3 py-2.5 font-sans font-semibold text-slate-900 dark:text-white">{vendor?.companyName}</td>
                        <td className="px-3 py-2.5 text-slate-500">{b.dueDate}</td>
                        <td className="px-3 py-2.5 text-right font-bold tabular-nums text-rose-600 dark:text-rose-400">{formatCurrency(b.balanceDue, currency)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="text-right font-mono">
            <div className="text-xs text-slate-500">Total Selected to Disburse:</div>
            <div className="text-2xl font-black text-rose-600 dark:text-rose-400 tabular-nums">{formatCurrency(totalPaymentAmount, currency)}</div>
          </div>
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            <button type="button" onClick={() => setIsPayBillsOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-medium">Cancel</button>
            <button type="submit" disabled={submitting || selectedBills.length === 0} className="flex items-center gap-2 px-5 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold shadow-md transition-all active:scale-95 disabled:opacity-50">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              <span>Pay Selected Bills ({selectedBills.length})</span>
            </button>
          </div>
          {error && <div className="text-rose-600">{error}</div>}
        </form>
      </div>
    </div>
  );
};
