import React, { useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency, getCurrencySymbol, getCurrencyWord } from '../../utils/currency';
import { commercialApi, ApiBankAccount } from '../../services/commercialApi';
import { accountingApi, ApiAccount } from '../../services/accountingApi';
import { CreditCard, Plus, Trash2 } from 'lucide-react';
import {
  FormField,
  FormSection,
  InlineAlert,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  SummaryRow,
} from '../common/ui';

function numberToWords(num: number, currencyWord = 'Kwacha'): string {
  if (num === 0) return `Zero and 00/100 ${currencyWord}`;
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const dollars = Math.floor(num);
  const cents = Math.round((num - dollars) * 100);
  const formatHundreds = (n: number): string => {
    let str = '';
    if (n >= 100) { str += a[Math.floor(n / 100)] + ' Hundred '; n %= 100; }
    if (n >= 20) { str += b[Math.floor(n / 10)] + (n % 10 > 0 ? '-' + a[n % 10] : '') + ' '; }
    else if (n > 0) { str += a[n] + ' '; }
    return str.trim();
  };
  let word = '';
  if (dollars >= 1000000) { word += formatHundreds(Math.floor(dollars / 1000000)) + ' Million '; }
  const thousands = Math.floor((dollars % 1000000) / 1000);
  if (thousands > 0) { word += formatHundreds(thousands) + ' Thousand '; }
  const rem = dollars % 1000;
  if (rem > 0) { word += formatHundreds(rem) + ' '; }
  const centsFormatted = cents.toString().padStart(2, '0');
  return `${word.trim()} and ${centsFormatted}/100 ${currencyWord}`;
}

interface SplitLine {
  id: string;
  accountId: string;
  amount: number;
}

const makeLine = (accountId = '', amount = 0): SplitLine => ({
  id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  accountId,
  amount,
});

/**
 * Composite amount control.
 *
 * FormField clones its child to inject `id`/`aria-describedby`, so this typed
 * wrapper forwards both to the real number input. The currency symbol stays a
 * decorative, pointer-transparent overlay and never names the input.
 */
interface AmountControlProps {
  id?: string;
  'aria-describedby'?: string;
  amount: number;
  onAmountChange: (value: number) => void;
  currencySymbol: string;
}

export const AmountControl: React.FC<AmountControlProps> = ({
  id,
  'aria-describedby': ariaDescribedBy,
  amount,
  onAmountChange,
  currencySymbol,
}) => (
  <div className="relative">
    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-400">
      {currencySymbol}
    </span>
    <input
      id={id}
      aria-describedby={ariaDescribedBy}
      type="number"
      step="0.01"
      min="0.01"
      value={amount}
      onChange={e => onAmountChange(parseFloat(e.target.value) || 0)}
      className="app-input pl-7 text-lg font-semibold tabular-nums"
      required
    />
  </div>
);

export const WriteCheckModal: React.FC = () => {
  const { isWriteCheckOpen, setIsWriteCheckOpen, companyProfile, vendors, triggerShortcutNotice } = useAccounting();
  const { activeCompany } = useAuth();
  const currency = companyProfile.currency || 'K';
  const currencySymbol = getCurrencySymbol(currency);
  const currencyWord = getCurrencyWord(currency);

  const [bankAccounts, setBankAccounts] = useState<ApiBankAccount[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<ApiAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [bankAccountId, setBankAccountId] = useState<string>('');
  const [checkNumber, setCheckNumber] = useState(`CHK-${Math.floor(3500 + Math.random() * 500)}`);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [payee, setPayee] = useState('');
  const [amount, setAmount] = useState<number>(0);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<SplitLine[]>(() => [makeLine()]);

  useEffect(() => {
    if (!isWriteCheckOpen) return;
    setLoading(true);
    setError(null);
    Promise.all([
      commercialApi.listBankAccounts().catch(() => [] as ApiBankAccount[]),
      accountingApi.listAccounts(true).catch(() => [] as ApiAccount[]),
    ]).then(([banks, accts]) => {
      setBankAccounts(banks);
      const exp = accts.filter(a => ['Expense', 'CostOfGoodsSold', 'OtherExpense'].includes(a.account_type));
      setExpenseAccounts(exp);
      if (banks.length && !bankAccountId) setBankAccountId(String(banks[0].glAccountId));
      if (exp.length) {
        setLines(prev => {
          if (prev.length && prev[0].accountId) return prev;
          return prev.map((l, i) => (i === 0 ? { ...l, accountId: String(exp[0].id) } : l));
        });
      }
      setLoading(false);
    }).catch(err => { setError(err?.message || 'Failed to load accounts'); setLoading(false); });
  }, [isWriteCheckOpen]);

  if (!isWriteCheckOpen) return null;

  const close = () => setIsWriteCheckOpen(false);

  const currentBank = bankAccounts.find(a => String(a.glAccountId) === bankAccountId);
  const currentBankBalance = currentBank
    ? Number((currentBank as any).balance ?? (currentBank as any).currentBalance ?? currentBank.glBalance ?? 0)
    : 0;
  const balanceAfter = currentBankBalance - amount;

  const validLines = lines.length > 0 && lines.every(l => l.accountId && l.amount > 0);
  const canSubmit = Boolean(payee.trim()) && amount > 0 && Boolean(bankAccountId) && validLines;

  const updateLine = (id: string, patch: Partial<SplitLine>) =>
    setLines(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));

  const removeLine = (id: string) =>
    setLines(prev => (prev.length <= 1 ? prev : prev.filter(l => l.id !== id)));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payee.trim() || amount <= 0 || !bankAccountId || !validLines) return;
    setSubmitting(true);
    setError(null);
    try {
      await commercialApi.recordExpenseOrCheck({
        bankGlAccountId: Number(bankAccountId),
        txnDate: date,
        payee,
        txnType: 'Check',
        checkNumber,
        memo: memo || 'Check written',
        lines: lines.map(l => ({ accountId: Number(l.accountId), amount: l.amount, memo })),
      });
      triggerShortcutNotice?.(`Check ${checkNumber} recorded and posted to General Ledger`);
      setIsWriteCheckOpen(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to record check');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell open={isWriteCheckOpen} onClose={close} size="3xl" titleId="write-check-title">
      <ModalHeader
          titleId="write-check-title"
        title="Write Check"
        subtitle="Record a check and post the expense split to the General Ledger."
        icon={<CreditCard className="h-4 w-4" />}
        tone="slate"
        onClose={close}
      />

      <form id="write-check-form" onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody columns={2}>
          {loading && <div className="skeleton h-8 w-40 lg:col-span-2" />}
          {error && (
            <div className="lg:col-span-2">
              <InlineAlert tone="error">{error}</InlineAlert>
            </div>
          )}

          <FormSection title="Check Details">
            <FormField
              label="Bank Account"
              required
              hint={currentBank ? `Available: ${formatCurrency(currentBankBalance, currency)}` : undefined}
            >
              <select
                value={bankAccountId}
                onChange={e => setBankAccountId(e.target.value)}
                className="app-input"
                required
              >
                {bankAccounts.map(b => (
                  <option key={b.id} value={b.glAccountId}>
                    {b.accountCode} - {b.accountName}
                  </option>
                ))}
              </select>
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField label="Check No." required>
                <input
                  type="text"
                  value={checkNumber}
                  onChange={e => setCheckNumber(e.target.value)}
                  className="app-input font-mono"
                  required
                />
              </FormField>
              <FormField label="Date" required>
                <input
                  type="date"
                  value={date}
                  onChange={e => setDate(e.target.value)}
                  className="app-input"
                  required
                />
              </FormField>
            </div>

            <FormField label="Payee" required>
              <input
                type="text"
                value={payee}
                onChange={e => setPayee(e.target.value)}
                list="vendor-list"
                placeholder="Select or type a payee"
                className="app-input"
                required
              />
              <datalist id="vendor-list">
                {Array.from(new Set(vendors.map(v => v.companyName).filter(Boolean))).map(vendorName => (
                  <option key={vendorName} value={vendorName} />
                ))}
              </datalist>
            </FormField>

            <FormField label="Amount" required hint={`Recorded in ${currency}`}>
              <AmountControl
                amount={amount}
                onAmountChange={setAmount}
                currencySymbol={currencySymbol}
              />
            </FormField>

            <FormField label="Memo">
              <input
                type="text"
                value={memo}
                onChange={e => setMemo(e.target.value)}
                placeholder="Optional memo"
                className="app-input"
              />
            </FormField>
          </FormSection>

          <div className="space-y-4">
            <FormSection aside title="Expense Split">
              <div className="space-y-2">
                {lines.map(line => (
                  <div key={line.id} className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <select
                        value={line.accountId}
                        onChange={e => updateLine(line.id, { accountId: e.target.value })}
                        className="app-input"
                        aria-label="Expense account"
                      >
                        <option value="">Select account</option>
                        {expenseAccounts.map(a => (
                          <option key={a.id} value={a.id}>
                            {a.code} - {a.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="w-28 shrink-0">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={line.amount || ''}
                        onChange={e => updateLine(line.id, { amount: parseFloat(e.target.value) || 0 })}
                        className="app-input text-right tabular-nums"
                        placeholder="0.00"
                        aria-label="Line amount"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLine(line.id)}
                      className="btn btn-secondary px-2 py-2"
                      aria-label="Remove line"
                      disabled={lines.length <= 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setLines(prev => [...prev, makeLine()])}
                className="btn btn-secondary w-full"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Line
              </button>
            </FormSection>

            <FormSection aside title="Amount in Words">
              <input
                type="text"
                readOnly
                value={numberToWords(amount, currencyWord)}
                className="app-input bg-slate-50 text-slate-600 dark:bg-white/[0.03] dark:text-slate-300"
              />
            </FormSection>

            <FormSection aside title="Summary">
              <SummaryRow label="Total" value={formatCurrency(amount, currency)} tone="brand" emphasis />
              <SummaryRow
                label="Bank Balance After"
                value={formatCurrency(balanceAfter, currency)}
                tone={balanceAfter < 0 ? 'rose' : 'emerald'}
                emphasis
              />
            </FormSection>
          </div>
        </ModalBody>
      </form>

      <ModalFooter
        onCancel={close}
        form="write-check-form"
        tone="brand"
        submitLabel="Save & Post"
        disabled={!canSubmit}
        busy={submitting}
      />
    </ModalShell>
  );
};