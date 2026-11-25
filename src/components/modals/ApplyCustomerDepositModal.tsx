import React, { useState } from 'react';
import { Wallet, X, AlertCircle } from 'lucide-react';
import { commercialApi } from '../../services/commercialApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';

interface ApplyCustomerDepositModalProps {
  invoice: any;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const ApplyCustomerDepositModal: React.FC<ApplyCustomerDepositModalProps> = ({
  invoice,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const balanceDue = Number(invoice.balanceDue ?? invoice.balance_due ?? invoice.total);

  const [amount, setAmount] = useState<number>(balanceDue);
  const [sourceType, setSourceType] = useState<'deposit' | 'prepayment' | 'wallet'>('deposit');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (amount <= 0) {
      setError('Allocation amount must be greater than zero');
      return;
    }
    if (amount > balanceDue) {
      setError(`Amount cannot exceed outstanding balance of ${formatCurrency(balanceDue, currency)}`);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await commercialApi.applyDepositToInvoice(invoice.id, amount, sourceType);
      triggerShortcutNotice(`Deposit of ${formatCurrency(amount, currency)} applied to ${invoice.invoiceNumber}`);
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to apply customer deposit');
    } finally {
      setLoading(false);
    }
  };

  const remainingAfter = Math.max(0, balanceDue - amount);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-md w-full p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Wallet className="w-5 h-5 text-emerald-600" />
            Apply Customer Deposit
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
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-850 space-y-1.5 border border-slate-200/60 dark:border-slate-800">
            <div className="flex justify-between text-slate-500">
              <span>Invoice Number:</span>
              <span className="font-mono font-bold text-slate-900 dark:text-white">{invoice.invoiceNumber || invoice.invoice_number}</span>
            </div>
            <div className="flex justify-between text-slate-500">
              <span>Customer:</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{invoice.customerName || invoice.company_name || 'Customer'}</span>
            </div>
            <div className="flex justify-between text-slate-500">
              <span>Current Balance Due:</span>
              <span className="font-mono font-bold text-rose-600 dark:text-rose-400">{formatCurrency(balanceDue, currency)}</span>
            </div>
          </div>

          <div>
            <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
              Deposit Source
            </label>
            <select
              value={sourceType}
              onChange={e => setSourceType(e.target.value as any)}
              className="w-full p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
            >
              <option value="deposit">Advance Contract Deposit / Unearned Retainer (2300)</option>
              <option value="prepayment">Unallocated Customer Prepayment (2300)</option>
              <option value="wallet">Customer Prepaid Account / Wallet (2300)</option>
            </select>
          </div>

          <div>
            <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
              Allocation Amount ({currency}) *
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

          <div className="flex justify-between items-center p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300">
            <span>Remaining Invoice Balance:</span>
            <span className="font-mono font-bold">{formatCurrency(remainingAfter, currency)}</span>
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
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow-xs disabled:opacity-50"
            >
              {loading ? 'Applying...' : 'Apply Deposit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
