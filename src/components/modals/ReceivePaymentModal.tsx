import React, { useState, useEffect } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';
import { commercialApi, ApiInvoice, ApiCustomer } from '../../services/commercialApi';
import { accountingApi, ApiAccount } from '../../services/accountingApi';
import { DollarSign, CheckCircle2, Save, Receipt, CreditCard, Landmark, StickyNote } from 'lucide-react';
import {
  ModalShell,
  ModalHeader,
  ModalFooter,
  ModalBody,
  FormSection,
  FormField,
  SummaryRow,
  InlineAlert,
} from '../common/ui';
import { AiAssistPanel } from '../ai/AiAssistPanel';

export const ReceivePaymentModal: React.FC = () => {
  const { isReceivePaymentOpen, setIsReceivePaymentOpen, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const currencySymbol = getCurrencySymbol(currency);

  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [invoices, setInvoices] = useState<ApiInvoice[]>([]);
  const [bankAccounts, setBankAccounts] = useState<ApiAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [amount, setAmount] = useState<number>(0);
  const [paymentMethod, setPaymentMethod] = useState<'Check' | 'Credit Card' | 'Cash' | 'ACH / Wire' | 'Mobile Money'>('Check');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [depositToAccountId, setDepositToAccountId] = useState<string>('');
  const [memo, setMemo] = useState('');

  useEffect(() => {
    if (!isReceivePaymentOpen) return;
    setLoading(true);
    setError(null);
    Promise.all([
      commercialApi.listCustomers().catch(() => [] as ApiCustomer[]),
      commercialApi.listInvoices().catch(() => [] as ApiInvoice[]),
      accountingApi.listAccounts(true).catch(() => [] as ApiAccount[]),
    ]).then(([custs, invs, accts]) => {
      setCustomers(custs);
      setInvoices(invs.filter(i => i.status !== 'voided' && !i.isSalesReceipt && (i.balanceDue || 0) > 0));
      const banks = accts.filter(a => a.account_type === 'Bank');
      setBankAccounts(banks);
      if (banks.length && !depositToAccountId) setDepositToAccountId(String(banks[0].id));
      setLoading(false);
    }).catch(err => { setError(err?.message || 'Failed to load data'); setLoading(false); });
  }, [isReceivePaymentOpen]);

  useEffect(() => {
    const inv = invoices.find(i => String(i.id) === selectedInvoiceId);
    if (inv) setAmount(inv.balanceDue || 0);
  }, [selectedInvoiceId, invoices]);

  if (!isReceivePaymentOpen) return null;

  const selectedInvoice = invoices.find(i => String(i.id) === selectedInvoiceId);
  const unpaidInvoices = invoices;
  const selectedCustomer = selectedInvoice ? customers.find(c => c.id === selectedInvoice.customerId) : null;
  const balanceDue = selectedInvoice?.balanceDue || 0;
  const overpay = amount > balanceDue;
  const underpay = amount > 0 && amount < balanceDue;

  const handleInvoiceChange = (invId: string) => {
    setSelectedInvoiceId(invId);
    const inv = invoices.find(i => String(i.id) === invId);
    if (inv) setAmount(inv.balanceDue || 0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedInvoice || amount <= 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const pmt = await commercialApi.recordPayment({
        customerId: selectedInvoice.customerId,
        paymentDate: date,
        paymentMethod,
        depositToAccountId: depositToAccountId ? Number(depositToAccountId) : undefined,
        referenceNumber: referenceNumber || undefined,
        currencyCode: selectedInvoice.currencyCode || 'ZMW',
        exchangeRate: selectedInvoice.exchangeRate || 1,
        amount: String(amount),
        memo: memo || undefined,
        allocations: [{ invoiceId: selectedInvoice.id, amount: String(amount) }],
      });
      triggerShortcutNotice?.(`Recorded payment ${pmt.paymentNumber} & updated General Ledger`);
      setIsReceivePaymentOpen(false);
    } catch (err: any) {
      setError(err?.message || 'Payment failed');
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => setIsReceivePaymentOpen(false);
  const canSubmit = !!selectedInvoice && amount > 0 && !overpay;

  return (
    <ModalShell open={isReceivePaymentOpen} onClose={close} size="3xl" titleId="payment-modal-title">
      <div className="px-4 pt-3">
        <AiAssistPanel
          context={`Customer: ${selectedCustomer?.companyName || '—'} · Balance due: ${formatCurrency(balanceDue, currency)}`}
          suggestions={['How much does this customer owe?', 'Is this invoice overdue?', 'What is our cash position this month?']}
        />
      </div>
      <ModalHeader
          titleId="payment-modal-title"
        title="Receive Customer Payment"
        subtitle="Apply a payment against an open customer invoice"
        icon={<DollarSign className="h-4 w-4" />}
        tone="emerald"
        onClose={close}
      />
      <form id="payment-form" onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-500">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            Loading payment data...
          </div>
        )}
        {!loading && unpaidInvoices.length === 0 && (
          <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">No open invoices</div>
            <p className="mt-1.5 max-w-sm text-[13px] text-slate-500 dark:text-slate-400">
              All customer invoices are paid or voided. Create a new invoice first.
            </p>
          </div>
        )}
        {!loading && unpaidInvoices.length > 0 && (
          <ModalBody columns={2}>
            {/* LEFT: Invoice selection */}
            <div className="space-y-4">
              <FormSection title="Open Invoices" icon={<Receipt className="h-3 w-3" />}>
                <FormField label="Apply Payment To" required>
                  <select
                    value={selectedInvoiceId}
                    onChange={e => handleInvoiceChange(e.target.value)}
                    className="app-input"
                    required
                  >
                    <option value="">-- Select an open invoice --</option>
                    {unpaidInvoices.map(inv => {
                      const cust = customers.find(c => c.id === inv.customerId);
                      return (
                        <option key={inv.id} value={inv.id}>
                          {inv.invoiceNumber} — {cust?.companyName || 'Unknown'} ({formatCurrency(inv.balanceDue, currency)})
                        </option>
                      );
                    })}
                  </select>
                </FormField>

                {selectedInvoice && (
                  <div className="surface mt-2 overflow-hidden">
                    <div className="surface-header !py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                          {selectedInvoice.invoiceNumber}
                        </span>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400">
                          {selectedInvoice.invoiceDate}
                        </span>
                      </div>
                    </div>
                    <div className="space-y-1.5 p-4">
                      <SummaryRow label="Customer" value={selectedCustomer?.companyName || '—'} />
                      <SummaryRow label="Invoice Total" value={formatCurrency(selectedInvoice.total, currency)} />
                      <SummaryRow label="Amount Paid" value={formatCurrency(selectedInvoice.amountPaid, currency)} tone="emerald" />
                      <SummaryRow label="Balance Due" value={formatCurrency(balanceDue, currency)} emphasis tone="rose" />
                    </div>
                  </div>
                )}
              </FormSection>
            </div>

            {/* RIGHT: Payment details */}
            <div className="space-y-4">
              <FormSection title="Payment Details" icon={<CreditCard className="h-3 w-3" />} aside>
                <div className="space-y-2.5">
                  <FormField label="Payment Date" required>
                    <input
                      type="date"
                      value={date}
                      onChange={e => setDate(e.target.value)}
                      className="app-input"
                      required
                    />
                  </FormField>
                  <FormField
                    label={`Amount Received (${currencySymbol})`}
                    required
                    error={overpay ? `Exceeds balance due of ${formatCurrency(balanceDue, currency)}` : undefined}
                  >
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={balanceDue || undefined}
                      value={amount}
                      onChange={e => setAmount(parseFloat(e.target.value) || 0)}
                      className="app-input font-mono font-bold"
                      required
                    />
                  </FormField>
                  {underpay && (
                    <div className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                      Partial payment: {formatCurrency(balanceDue - amount, currency)} will remain due.
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <FormField label="Method">
                      <select
                        value={paymentMethod}
                        onChange={e => setPaymentMethod(e.target.value as any)}
                        className="app-input"
                      >
                        <option value="Check">Check</option>
                        <option value="ACH / Wire">ACH / Wire</option>
                        <option value="Credit Card">Credit Card</option>
                        <option value="Cash">Cash</option>
                        <option value="Mobile Money">Mobile Money</option>
                      </select>
                    </FormField>
                    <FormField label="Check / Ref #">
                      <input
                        type="text"
                        value={referenceNumber}
                        onChange={e => setReferenceNumber(e.target.value)}
                        placeholder="e.g. CHK-9921"
                        className="app-input"
                      />
                    </FormField>
                  </div>
                  <FormField label="Deposit To Account" required>
                    <select
                      value={depositToAccountId}
                      onChange={e => setDepositToAccountId(e.target.value)}
                      className="app-input"
                      required
                    >
                      {bankAccounts.map(acc => (
                        <option key={acc.id} value={acc.id}>{acc.code} — {acc.name}</option>
                      ))}
                    </select>
                  </FormField>
                </div>
              </FormSection>

              <FormSection title="Memo" icon={<StickyNote className="h-3 w-3" />} aside>
                <textarea
                  value={memo}
                  onChange={e => setMemo(e.target.value)}
                  rows={2}
                  placeholder="Optional payment notes..."
                  className="app-input resize-none"
                />
              </FormSection>

              <FormSection title="Summary" icon={<Landmark className="h-3 w-3" />} aside>
                <SummaryRow label="Payment Amount" value={formatCurrency(amount, currency)} tone="emerald" />
                <SummaryRow label="Remaining Balance" value={formatCurrency(Math.max(0, balanceDue - amount), currency)} emphasis tone={overpay ? 'rose' : 'brand'} />
              </FormSection>
            </div>
          </ModalBody>
        )}
        {error && (
          <div className="px-5 pb-2">
            <InlineAlert tone="error">{error}</InlineAlert>
          </div>
        )}
        <ModalFooter
          onCancel={close}
          submitLabel="Record Payment & Deposit"
          submitIcon={<Save className="h-3.5 w-3.5" />}
          form="payment-form"
          disabled={!canSubmit}
          busy={submitting}
          tone="emerald"
          left={selectedInvoice ? (
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              {selectedInvoice.invoiceNumber} · {formatCurrency(balanceDue, currency)} due
            </div>
          ) : undefined}
        />
      </form>
    </ModalShell>
  );
};