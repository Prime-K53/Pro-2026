import React, { useState, useEffect } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { commercialApi, ApiBill, ApiVendor } from '../../services/commercialApi';
import { accountingApi, ApiAccount } from '../../services/accountingApi';
import { CheckCircle2, DollarSign, CheckSquare, Square } from 'lucide-react';
import {
  Button,
  DataTableShell,
  EmptyState,
  FormField,
  InlineAlert,
  LoadingState,
  ModalHeader,
  ModalShell,
} from '../common/ui';

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
    <ModalShell
      open={isPayBillsOpen}
      onClose={() => setIsPayBillsOpen(false)}
      titleId="pay-bills-title"
      size="4xl"
    >
      <ModalHeader
        title="Pay Bills (Batch Disbursement)"
        subtitle="Select open vendor bills to settle from a bank or cash account"
        icon={<DollarSign className="w-5 h-5" strokeWidth={1.75} />}
        tone="amber"
        titleId="pay-bills-title"
        onClose={() => setIsPayBillsOpen(false)}
      />
      <form onSubmit={handlePaySelectedBills} className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
        {loading && <LoadingState label="Loading unpaid vendor bills…" rows={3} />}
        {error && (
          <InlineAlert tone="error" onDismiss={() => setError(null)}>
            {error}
          </InlineAlert>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08]">
          <FormField label="Payment Account" required>
            <select value={selectedBankId} onChange={e => setSelectedBankId(e.target.value)} className="app-input" required>
              {bankAccountsList.map(b => (
                <option key={b.id} value={b.id}>{b.code} - {b.name}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Payment Date" required>
            <input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} className="app-input app-input-mono" required />
          </FormField>
          <FormField label="Method">
            <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value as any)} className="app-input">
              <option value="Check">Check</option>
              <option value="ACH">ACH / Electronic Transfer</option>
              <option value="Credit Card">Credit Card</option>
            </select>
          </FormField>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={selectAll}>
            Select All ({unpaidBills.length})
          </Button>
          <Button variant="secondary" size="sm" onClick={clearAll}>
            Clear Selection
          </Button>
        </div>

        <DataTableShell className="border border-slate-200 dark:border-white/[0.08] rounded-xl">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-white/[0.04] uppercase tracking-wider font-bold text-[11px] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-white/[0.08]">
              <tr>
                <th className="px-3 py-2.5 w-14 text-center">Pay</th>
                <th className="px-3 py-2.5">Bill #</th>
                <th className="px-3 py-2.5">Vendor</th>
                <th className="px-3 py-2.5">Due Date</th>
                <th className="px-3 py-2.5 text-right">Balance Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06] font-mono">
              {unpaidBills.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4">
                    <EmptyState
                      title="All vendor bills are paid in full"
                      description="There are no open accounts payable balances remaining."
                      icon={<CheckCircle2 className="w-5 h-5 text-emerald-600" strokeWidth={1.75} />}
                    />
                  </td>
                </tr>
              ) : (
                unpaidBills.map(b => {
                  const vendor = vendors.find(v => v.id === b.vendorId);
                  const isSelected = selectedBillIds.includes(String(b.id));
                  return (
                    <tr
                      key={b.id}
                      onClick={() => toggleBill(String(b.id))}
                      className={`cursor-pointer transition-colors ${isSelected ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]'}`}
                    >
                      <td className="px-3 py-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleBill(String(b.id))}
                          onClick={e => e.stopPropagation()}
                          aria-label={`Select bill ${b.billNumber}`}
                          className="sr-only"
                        />
                        {isSelected ? (
                          <CheckSquare className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mx-auto" strokeWidth={1.75} aria-hidden="true" />
                        ) : (
                          <Square className="w-4 h-4 text-slate-400 dark:text-slate-600 mx-auto" strokeWidth={1.75} aria-hidden="true" />
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-bold text-slate-900 dark:text-white">{b.billNumber}</td>
                      <td className="px-3 py-2.5 font-sans font-semibold text-slate-900 dark:text-white">{vendor?.companyName}</td>
                      <td className="px-3 py-2.5 text-slate-600 dark:text-slate-400 tabular-nums">{b.dueDate}</td>
                      <td className="px-3 py-2.5 text-right font-bold tabular-nums text-rose-700 dark:text-rose-400">{formatCurrency(b.balanceDue, currency)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </DataTableShell>

        <div className="text-right font-mono">
          <div className="text-xs font-sans text-slate-600 dark:text-slate-400">Total Selected to Disburse:</div>
          <div className="text-2xl font-black text-rose-700 dark:text-rose-400 tabular-nums">{formatCurrency(totalPaymentAmount, currency)}</div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-white/[0.08]">
          <Button variant="secondary" onClick={() => setIsPayBillsOpen(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            loading={submitting}
            loadingLabel="Processing…"
            disabled={selectedBills.length === 0}
          >
            Pay Selected Bills ({selectedBills.length})
          </Button>
        </div>
      </form>
    </ModalShell>
  );
};
