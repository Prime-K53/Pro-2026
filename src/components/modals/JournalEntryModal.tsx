import React, { useEffect, useRef, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { accountingApi, ApiAccount } from '../../services/accountingApi';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';
import { X, Plus, Trash2, CheckCircle2, AlertTriangle, Save, Loader2 } from 'lucide-react';

interface DraftLine {
  id: string;
  accountId: string;
  description: string;
  basis: 'both' | 'accrual' | 'cash';
  debitStr: string;
  creditStr: string;
}

function parseCents(val: string): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

export const JournalEntryModal: React.FC = () => {
  const {
    isJournalEntryOpen,
    setIsJournalEntryOpen,
    companyProfile,
    triggerShortcutNotice,
  } = useAccounting();
  const { activeCompany } = useAuth();
  const currency = companyProfile.currency || 'K';
  const currencySymbol = getCurrencySymbol(currency);

  const [accounts, setAccounts] = useState<ApiAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('Month-end depreciation & accrual adjustment');
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const draftKeyRef = useRef<string>('');

  const [lines, setLines] = useState<DraftLine[]>([
    { id: 'jl-1', accountId: '', description: '', basis: 'both', debitStr: '', creditStr: '' },
    { id: 'jl-2', accountId: '', description: '', basis: 'both', debitStr: '', creditStr: '' },
  ]);

  useEffect(() => {
    if (!isJournalEntryOpen) return;
    setErrorMsg(null);
    draftKeyRef.current = `je-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let cancelled = false;
    setLoadingAccounts(true);
    accountingApi
      .listAccounts(false)
      .then(list => {
        if (cancelled) return;
        setAccounts(list);
        setLines(prev => {
          const defaultDr = list.find(a => a.code === '6300') || list[0];
          const defaultCr = list.find(a => a.code === '1590') || list[1] || list[0];
          return prev.map((l, idx) => {
            if (l.accountId && list.some(a => String(a.id) === l.accountId)) return l;
            if (idx === 0 && defaultDr) return { ...l, accountId: String(defaultDr.id) };
            if (idx === 1 && defaultCr) return { ...l, accountId: String(defaultCr.id) };
            return { ...l, accountId: list[0] ? String(list[0].id) : '' };
          });
        });
      })
      .catch(err => {
        if (!cancelled) setErrorMsg(err?.message || 'Failed to load Chart of Accounts');
      })
      .finally(() => {
        if (!cancelled) setLoadingAccounts(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isJournalEntryOpen, activeCompany?.id]);

  // Static hook order: the dialog is dismissible with Escape even though the
  // component returns early while closed.
  useEffect(() => {
    if (!isJournalEntryOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsJournalEntryOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isJournalEntryOpen, setIsJournalEntryOpen]);

  if (!isJournalEntryOpen) return null;

  const updateLine = (id: string, patch: Partial<DraftLine>) => {
    setLines(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  };

  const addLine = () => {
    setLines(prev => [
      ...prev,
      {
        id: `jl-${Date.now()}-${prev.length}`,
        accountId: accounts[0] ? String(accounts[0].id) : '',
        description: '',
        basis: 'both',
        debitStr: '',
        creditStr: '',
      },
    ]);
  };

  const removeLine = (id: string) => {
    if (lines.length > 2) {
      setLines(prev => prev.filter(l => l.id !== id));
    }
  };

  const totalDebitCents = lines.reduce((sum, l) => sum + parseCents(l.debitStr), 0);
  const totalCreditCents = lines.reduce((sum, l) => sum + parseCents(l.creditStr), 0);
  const totalDebits = totalDebitCents / 100;
  const totalCredits = totalCreditCents / 100;
  const difference = Math.abs(totalDebitCents - totalCreditCents) / 100;
  const allHaveAccounts = lines.every(l => Number(l.accountId) > 0 && (parseCents(l.debitStr) > 0 || parseCents(l.creditStr) > 0));
  const isBalanced = totalDebitCents > 0 && totalDebitCents === totalCreditCents && allHaveAccounts;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isBalanced || submitting) return;

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const result = await accountingApi.postJournal({
        txnDate: date,
        description: memo.trim(),
        reference: reference.trim() || undefined,
        isAdjusting,
        idempotencyKey: draftKeyRef.current,
        lines: lines.map(l => ({
          accountId: Number(l.accountId),
          debit: l.debitStr.trim() ? l.debitStr.trim() : '0',
          credit: l.creditStr.trim() ? l.creditStr.trim() : '0',
          description: l.description.trim() || undefined,
          basis: l.basis,
        })),
      });

      triggerShortcutNotice(
        `Posted ${result.entry.entryNumber} (${formatCurrency(totalDebits, currency)}) to General Ledger`
      );
      setIsJournalEntryOpen(false);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to post journal entry');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="journal-entry-title"
        className="w-full max-w-4xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]"
      >
        {/* Header */}
        <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="journal-entry-title" className="font-bold text-base tracking-tight">Make General Journal Entry</h2>
            <span className="text-xs text-amber-300 font-mono">
              Double-Entry Invariant: Debits = Credits
            </span>
          </div>
          <button
            type="button"
            onClick={() => setIsJournalEntryOpen(false)}
            className="p-1 rounded hover:bg-white/10 text-white/80 hover:text-white"
            aria-label="Close journal entry dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {errorMsg && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/50 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
              <div className="font-medium">{errorMsg}</div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 p-4 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800">
            <div className="md:col-span-3 space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Entry Date</label>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 outline-none"
                required
              />
            </div>
            <div className="md:col-span-3 space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Reference (Optional)</label>
              <input
                type="text"
                value={reference}
                onChange={e => setReference(e.target.value)}
                placeholder="e.g. ADJ-2026-11"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 outline-none"
              />
            </div>
            <div className="md:col-span-6 space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Memo / Description</label>
              <input
                type="text"
                value={memo}
                onChange={e => setMemo(e.target.value)}
                placeholder="Reason for adjustment or manual journal entry..."
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                required
              />
            </div>
            <div className="md:col-span-12 pt-1 flex items-center justify-between">
              <label className="inline-flex items-center gap-2 cursor-pointer select-none text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={isAdjusting}
                  onChange={e => setIsAdjusting(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="font-semibold">Mark as Adjusting Entry</span>
                <span className="text-[11px] text-slate-500">
                  (Permitted in soft-closed periods and filterable in Adjusted vs Unadjusted financial statements)
                </span>
              </label>
              {loadingAccounts && (
                <span className="inline-flex items-center gap-1.5 text-slate-500">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Loading accounts...
                </span>
              )}
            </div>
          </div>

          {/* Lines Table */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
            <div className="bg-slate-100 dark:bg-slate-800 px-3 py-2 text-[11px] font-bold text-slate-600 dark:text-slate-300 grid grid-cols-12 gap-2">
              <div className="col-span-4">ACCOUNT</div>
              <div className="col-span-3">LINE MEMO</div>
              <div className="col-span-1">BASIS</div>
              <div className="col-span-2 text-right">DEBIT ({currencySymbol})</div>
              <div className="col-span-2 text-right">CREDIT ({currencySymbol})</div>
            </div>

            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {lines.map(line => (
                <div key={line.id} className="p-2.5 grid grid-cols-12 gap-2 items-center text-xs">
                  <div className="col-span-4">
                    <select
                      value={line.accountId}
                      onChange={e => updateLine(line.id, { accountId: e.target.value })}
                      className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-900 dark:text-slate-100 outline-none"
                      required
                    >
                      <option value="">Select account...</option>
                      {accounts.map(acc => (
                        <option key={acc.id} value={String(acc.id)}>
                          {acc.code ? `${acc.code} - ` : ''}{acc.name} ({acc.account_type})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="col-span-3">
                    <input
                      type="text"
                      value={line.description}
                      onChange={e => updateLine(line.id, { description: e.target.value })}
                      placeholder="Line memo..."
                      className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-900 dark:text-slate-100 outline-none"
                    />
                  </div>

                  <div className="col-span-1">
                    <select
                      value={line.basis}
                      onChange={e => updateLine(line.id, { basis: e.target.value as 'both' | 'accrual' | 'cash' })}
                      className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-1 py-1.5 text-[11px] text-slate-700 dark:text-slate-200 outline-none"
                    >
                      <option value="both">Both</option>
                      <option value="accrual">Accrual</option>
                      <option value="cash">Cash</option>
                    </select>
                  </div>

                  <div className="col-span-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={line.debitStr}
                      onChange={e => {
                        const v = e.target.value;
                        updateLine(line.id, {
                          debitStr: v,
                          creditStr: Number(v) > 0 ? '' : line.creditStr,
                        });
                      }}
                      placeholder="0.00"
                      className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-right font-mono tabular-nums text-slate-900 dark:text-slate-100 outline-none"
                    />
                  </div>

                  <div className="col-span-2 flex items-center gap-1.5">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={line.creditStr}
                      onChange={e => {
                        const v = e.target.value;
                        updateLine(line.id, {
                          creditStr: v,
                          debitStr: Number(v) > 0 ? '' : line.debitStr,
                        });
                      }}
                      placeholder="0.00"
                      className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-right font-mono tabular-nums text-slate-900 dark:text-slate-100 outline-none"
                    />
                    {lines.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        className="text-slate-400 hover:text-rose-600 p-1"
                        aria-label="Remove line"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="p-2 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={addLine}
                className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-800 px-2 py-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Split Line</span>
              </button>
            </div>
          </div>

          {/* Trial Balance Footer indicator */}
          <div className="p-4 rounded-lg bg-slate-100 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 font-mono text-xs">
            <div className="flex items-center gap-2">
              {isBalanced ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  <span className="text-emerald-700 dark:text-emerald-400 font-bold">
                    Balanced and ready to post atomically
                  </span>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                  <span className="text-amber-700 dark:text-amber-400 font-bold">
                    {totalDebitCents === 0
                      ? 'Enter debit and credit amounts on at least two accounts'
                      : !allHaveAccounts
                      ? 'Every non-zero line must select an active account'
                      : `Out of balance by ${formatCurrency(difference, currency)}`}
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center gap-6 tabular-nums">
              <div>
                <span className="text-slate-500 mr-2 font-sans">Total Debits:</span>
                <span className="font-bold text-slate-900 dark:text-white">
                  {formatCurrency(totalDebits, currency)}
                </span>
              </div>
              <div>
                <span className="text-slate-500 mr-2 font-sans">Total Credits:</span>
                <span className="font-bold text-slate-900 dark:text-white">
                  {formatCurrency(totalCredits, currency)}
                </span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setIsJournalEntryOpen(false)}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isBalanced || submitting}
              className={`flex items-center gap-2 px-5 py-2 rounded-lg font-bold shadow-md transition-all ${
                isBalanced && !submitting
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer'
                  : 'bg-slate-300 dark:bg-slate-800 text-slate-500 cursor-not-allowed'
              }`}
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              <span>{submitting ? 'Posting...' : 'Post to General Ledger'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
