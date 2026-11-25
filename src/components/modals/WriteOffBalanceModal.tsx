import React, { useState } from 'react';
import { Scissors, X, AlertTriangle } from 'lucide-react';
import { commercialApi } from '../../services/commercialApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';

interface WriteOffBalanceModalProps {
  invoice: any;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const WriteOffBalanceModal: React.FC<WriteOffBalanceModalProps> = ({
  invoice,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const balanceDue = Number(invoice.balanceDue ?? invoice.balance_due ?? invoice.total);

  const [amount, setAmount] = useState<number>(balanceDue);
  const [reasonCategory, setReasonCategory] = useState<'tolerance' | 'bad_debt' | 'disputed'>('tolerance');
  const [reasonDetails, setReasonDetails] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (amount <= 0) {
      setError('Write-off amount must be greater than zero');
      return;
    }
    if (amount > balanceDue) {
      setError(`Write-off amount cannot exceed balance due of ${formatCurrency(balanceDue, currency)}`);
      return;
    }

    const fullReason = `[${reasonCategory.toUpperCase()}] ${reasonDetails.trim() || 'Balance write-off'}`;
    setLoading(true);
    setError(null);
    try {
      await commercialApi.writeOffInvoiceBalance(invoice.id, amount, fullReason);
      triggerShortcutNotice(`Wrote off ${formatCurrency(amount, currency)} on ${invoice.invoiceNumber}`);
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to post balance write-off');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-md w-full p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Scissors className="w-5 h-5 text-rose-600" />
            Write-Off Invoice Balance
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-850 space-y-1.5 border border-slate-200/60 dark:border-slate-800">
            <div className="flex justify-between text-slate-500">
              <span>Invoice:</span>
              <span className="font-mono font-bold text-slate-900 dark:text-white">{invoice.invoiceNumber || invoice.invoice_number}</span>
            </div>
            <div className="flex justify-between text-slate-500">
              <span>Customer:</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{invoice.customerName || invoice.company_name}</span>
            </div>
            <div className="flex justify-between text-slate-500">
              <span>Outstanding Balance:</span>
              <span className="font-mono font-bold text-rose-600 dark:text-rose-400">{formatCurrency(balanceDue, currency)}</span>
            </div>
          </div>

          <div>
            <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
              Write-Off Classification *
            </label>
            <select
              value={reasonCategory}
              onChange={e => setReasonCategory(e.target.value as any)}
              className="w-full p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
            >
              <option value="tolerance">Small Balance Underpayment Tolerance (&lt; K5,000)</option>
              <option value="bad_debt">Bad Debt Write-Off (Customer Insolvent / Uncollectible)</option>
              <option value="disputed">Commercial Settlement / Minor Print Discrepancy</option>
            </select>
          </div>

          <div>
            <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
              Write-off Amount ({currency}) *
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={balanceDue}
              value={amount}
              onChange={e => setAmount(Number(e.target.value))}
              className="w-full p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white font-mono text-sm"
              required
            />
          </div>

          <div>
            <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
              Justification / Reason Notes *
            </label>
            <textarea
              rows={2}
              placeholder="State reason for general ledger audit trail..."
              value={reasonDetails}
              onChange={e => setReasonDetails(e.target.value)}
              className="w-full p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
              required
            />
          </div>

          <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 text-[11px]">
            ⚠️ This will post a debit entry to Bad Debt / Allowance Expense (Account 6320) and credit Accounts Receivable (1200).
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold shadow-xs disabled:opacity-50"
            >
              {loading ? 'Posting Write-Off...' : 'Post Write-Off'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
