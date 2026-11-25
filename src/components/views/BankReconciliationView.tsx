import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT } from '../../services/accountingApi';
import { ApiBankAccount, commercialApi } from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
import {
  CheckCircle2,
  AlertTriangle,
  CheckSquare,
  Square,
  RotateCcw,
  Loader2,
  X,
} from 'lucide-react';

export const BankReconciliationView: React.FC = () => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const { activeCompany, hasPermission } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canReconcile = hasPermission('banking:reconcile');

  const [bankAccounts, setBankAccounts] = useState<ApiBankAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number>(0);
  const [statementDate, setStatementDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [statementEndingBalance, setStatementEndingBalance] = useState<string>('0');
  const [clearedIds, setClearedIds] = useState<number[] | undefined>(undefined);

  const [preview, setPreview] = useState<any | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [reverseTarget, setReverseTarget] = useState<any | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reconRules, setReconRules] = useState<any[]>([]);
  const [rulesBusy, setRulesBusy] = useState(false);

  const loadAccounts = useCallback(async () => {
    try {
      const baList = await commercialApi.listBankAccounts();
      setBankAccounts(baList);
      if (baList.length > 0 && (!selectedAccountId || !baList.some(b => b.glAccountId === selectedAccountId))) {
        setSelectedAccountId(baList[0].glAccountId);
        setStatementEndingBalance(String(baList[0].glBalance));
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to load bank accounts');
    }
  }, [activeCompany?.id, selectedAccountId]);

  const loadPreviewAndHistory = useCallback(async () => {
    if (!selectedAccountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const [prev, hist] = await Promise.all([
        commercialApi.previewReconciliation({
          accountId: selectedAccountId,
          statementDate,
          statementEndingBalance: statementEndingBalance || '0',
          clearedBankTxnIds: clearedIds,
        }),
        commercialApi.listReconciliations(selectedAccountId),
      ]);
      setPreview(prev);
      setHistory(hist);
      if (clearedIds === undefined) {
        setClearedIds(prev.items.filter((i: any) => i.selected).map((i: any) => i.id));
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to compute reconciliation preview');
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId, statementDate, statementEndingBalance, clearedIds]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    loadPreviewAndHistory();
  }, [loadPreviewAndHistory]);

  const loadRules = useCallback(async () => {
    try { setReconRules(await commercialApi.listBankReconRules()); } catch { /* non-blocking */ }
  }, []);

  useEffect(() => { void loadRules(); }, [loadRules]);

  useEffect(() => {
    const handler = () => {
      loadAccounts();
      loadPreviewAndHistory();
      void loadRules();
    };
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, [loadAccounts, loadPreviewAndHistory, loadRules]);

  const items: any[] = preview?.items || [];
  const payments = items.filter(t => t.amount < 0);
  const deposits = items.filter(t => t.amount >= 0);

  const toggleCleared = (id: number) => {
    const current = clearedIds ?? items.filter(i => i.selected).map(i => i.id);
    setClearedIds(current.includes(id) ? current.filter(x => x !== id) : [...current, id]);
  };

  const handleComplete = async () => {
    if (!preview?.differenceExactZero) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.completeReconciliation({
        accountId: selectedAccountId,
        statementDate,
        statementEndingBalance,
        clearedBankTxnIds: clearedIds ?? items.filter(i => i.selected).map(i => i.id),
      });
      triggerShortcutNotice('Reconciliation completed & GL lines locked!');
      setClearedIds([]);
      await loadPreviewAndHistory();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Reconciliation completion failed');
    } finally {
      setBusy(false);
    }
  };

  const handleReverse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reverseTarget) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.reverseReconciliation(reverseTarget.id, reverseReason);
      triggerShortcutNotice('Reconciliation reversed and transactions unlocked');
      setReverseTarget(null);
      setReverseReason('');
      setClearedIds(undefined);
      await loadPreviewAndHistory();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Reconciliation reversal failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            Bank Account Reconciliation
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Exact decimal zero-difference reconciliation with immutable GL period locking and audited reversal support.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-500">Account:</label>
          <select
            value={selectedAccountId}
            onChange={e => {
              const nextId = Number(e.target.value);
              const acct = bankAccounts.find(b => b.glAccountId === nextId);
              setSelectedAccountId(nextId);
              if (acct) setStatementEndingBalance(String(acct.glBalance));
              setClearedIds(undefined);
            }}
            className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-1.5 text-xs font-semibold outline-none"
          >
            {bankAccounts.map(b => (
              <option key={b.id} value={b.glAccountId}>
                {b.accountCode} - {b.accountName} ({formatCurrency(b.glBalance, currency)})
              </option>
            ))}
          </select>
        </div>
      </div>

      {errorMsg && (
        <div role="alert" className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 text-rose-800 dark:text-rose-200 text-xs flex items-center justify-between">
          <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="underline">Dismiss</button>
        </div>
      )}

      {/* Statement Parameters */}
      <div className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs grid grid-cols-1 md:grid-cols-4 gap-4 items-end text-xs">
        <div>
          <label className="font-semibold text-slate-700 dark:text-slate-300">Beginning Balance (Last Closed)</label>
          <div className="mt-1 px-3 py-2 rounded-md bg-slate-100 dark:bg-slate-800 font-mono font-bold text-sm">
            {formatCurrency(preview?.beginningBalance ?? 0, currency)}
          </div>
        </div>
        <div>
          <label className="font-semibold text-slate-700 dark:text-slate-300">Statement Ending Date</label>
          <input
            type="date"
            value={statementDate}
            onChange={e => {
              setStatementDate(e.target.value);
              setClearedIds(undefined);
            }}
            className="w-full mt-1 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm font-mono outline-none"
          />
        </div>
        <div>
          <label className="font-semibold text-slate-700 dark:text-slate-300">Statement Ending Balance ({currency})</label>
          <input
            type="number"
            step="0.01"
            value={statementEndingBalance}
            onChange={e => setStatementEndingBalance(e.target.value)}
            className="w-full mt-1 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm font-mono font-bold outline-none"
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => setClearedIds(items.map(i => i.id))} className="px-3 py-2 rounded border font-semibold">
            Mark All
          </button>
          <button type="button" onClick={() => setClearedIds([])} className="px-3 py-2 rounded border font-semibold">
            Unmark All
          </button>
        </div>
      </div>

      {/* Checklist Columns */}
      {loading && !preview ? (
        <div className="py-10 flex items-center justify-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading unreconciled register items...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          {/* Payments */}
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 dark:bg-slate-850 border-b flex items-center justify-between text-xs">
              <span className="font-bold uppercase tracking-wider">Checks & Payments ({payments.filter(p => p.selected).length}/{payments.length})</span>
              <span className="font-mono font-bold text-rose-600">-{formatCurrency(preview?.clearedPayments ?? 0, currency)}</span>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 text-xs font-mono">
              {payments.length === 0 ? (
                <div className="p-6 text-center font-sans text-slate-400">No unreconciled payments up to {statementDate}.</div>
              ) : (
                payments.map(p => (
                  <div
                    key={p.id}
                    onClick={() => toggleCleared(p.id)}
                    className={`p-3 flex items-center justify-between cursor-pointer ${p.selected ? 'bg-blue-50/40 dark:bg-blue-950/20' : 'hover:bg-slate-50'}`}
                  >
                    <div className="flex items-center gap-3">
                      {p.selected ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4 text-slate-300" />}
                      <div>
                        <div className="font-sans font-semibold text-slate-900 dark:text-white">{p.payee}</div>
                        <div className="text-[11px] text-slate-400">{p.date} · {p.refNumber || p.type}</div>
                      </div>
                    </div>
                    <div className="font-bold tabular-nums">{formatCurrency(Math.abs(p.amount), currency)}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Deposits */}
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
            <div className="px-4 py-3 bg-slate-50 dark:bg-slate-850 border-b flex items-center justify-between text-xs">
              <span className="font-bold uppercase tracking-wider">Deposits & Credits ({deposits.filter(d => d.selected).length}/{deposits.length})</span>
              <span className="font-mono font-bold text-emerald-600">+{formatCurrency(preview?.clearedDeposits ?? 0, currency)}</span>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 text-xs font-mono">
              {deposits.length === 0 ? (
                <div className="p-6 text-center font-sans text-slate-400">No unreconciled deposits up to {statementDate}.</div>
              ) : (
                deposits.map(d => (
                  <div
                    key={d.id}
                    onClick={() => toggleCleared(d.id)}
                    className={`p-3 flex items-center justify-between cursor-pointer ${d.selected ? 'bg-blue-50/40 dark:bg-blue-950/20' : 'hover:bg-slate-50'}`}
                  >
                    <div className="flex items-center gap-3">
                      {d.selected ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4 text-slate-300" />}
                      <div>
                        <div className="font-sans font-semibold text-slate-900 dark:text-white">{d.payee}</div>
                        <div className="text-[11px] text-slate-400">{d.date} · {d.refNumber || d.type}</div>
                      </div>
                    </div>
                    <div className="font-bold text-emerald-600 tabular-nums">+{formatCurrency(d.amount, currency)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Difference Settlement Bar */}
      <div
        className={`p-6 rounded-xl border font-mono ${
          preview?.differenceExactZero
            ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800'
            : 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            {preview?.differenceExactZero ? (
              <>
                <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                <span className="font-sans font-bold text-base text-emerald-900 dark:text-emerald-100">
                  Balanced to Zero ({formatCurrency(0, currency)}) — Ready to Lock
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-6 h-6 text-amber-600" />
                <span className="font-sans font-bold text-base text-amber-900 dark:text-amber-100">
                  Difference Remaining: {formatCurrency(preview?.difference ?? 0, currency)}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-6 text-xs">
            <div>
              <div className="text-slate-500 text-[10px] uppercase">Cleared Ending Balance</div>
              <div className="font-bold text-sm tabular-nums">{formatCurrency(preview?.clearedEndingBalance ?? 0, currency)}</div>
            </div>
            <div>
              <div className="text-slate-500 text-[10px] uppercase">Difference</div>
              <div className={`text-lg font-black tabular-nums ${preview?.differenceExactZero ? 'text-emerald-600' : 'text-amber-600'}`}>
                {formatCurrency(preview?.difference ?? 0, currency)}
              </div>
            </div>
            {canReconcile && (
              <button
                onClick={handleComplete}
                disabled={busy || !preview?.differenceExactZero}
                className={`px-5 py-2.5 rounded-lg font-bold font-sans text-xs shadow-md ${
                  preview?.differenceExactZero ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-slate-300 text-slate-500 cursor-not-allowed'
                }`}
              >
                {busy ? 'Locking...' : 'Reconcile Now'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Banking Rules (Module 6) */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b font-bold text-xs flex items-center justify-between">
          <span>Reconciliation Rules</span>
          <button
            type="button"
            className="px-2.5 py-1 rounded border border-slate-300 text-[11px] font-semibold hover:bg-slate-50"
            disabled={rulesBusy}
            onClick={async () => {
              const ruleName = window.prompt('Rule name');
              if (!ruleName) return;
              const matchPattern = window.prompt('Match pattern (description contains)', ruleName) || ruleName;
              setRulesBusy(true);
              try {
                await commercialApi.upsertBankReconRule({ ruleName, matchField: 'description', matchPattern, autoPost: false, isActive: true });
                await loadRules();
                triggerShortcutNotice('Reconciliation rule saved');
              } catch (e: any) { setErrorMsg(e?.message || 'Failed to save rule'); }
              finally { setRulesBusy(false); }
            }}
          >Add Rule</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase text-[10px] font-bold border-b"><tr><th className="px-4 py-2">Name</th><th className="px-4 py-2">Field</th><th className="px-4 py-2">Pattern</th><th className="px-4 py-2">Active</th></tr></thead>
            <tbody className="divide-y">{reconRules.length === 0 ? <tr><td colSpan={4} className="px-4 py-4 text-center text-slate-400">No recon rules.</td></tr> : reconRules.map((r: any) => (
              <tr key={r.id}><td className="px-4 py-2">{r.rule_name || r.ruleName}</td><td className="px-4 py-2">{r.match_field || r.matchField}</td><td className="px-4 py-2 font-mono">{r.match_pattern || r.matchPattern}</td><td className="px-4 py-2">{String(r.is_active ?? r.isActive)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      {/* History */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b font-bold text-xs">Reconciliation History & Audit Locks</div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase text-[10px] font-bold border-b">
              <tr>
                <th className="px-4 py-2.5">STATEMENT DATE</th>
                <th className="px-4 py-2.5 text-right">BEGINNING</th>
                <th className="px-4 py-2.5 text-right">CLEARED NET</th>
                <th className="px-4 py-2.5 text-right">ENDING BALANCE</th>
                <th className="px-4 py-2.5 text-center">STATUS</th>
                <th className="px-4 py-2.5">NOTES / REASON</th>
                <th className="px-4 py-2.5 text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y font-mono">
              {history.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center font-sans text-slate-400">No reconciliations recorded yet for this account.</td></tr>
              ) : (
                history.map(h => (
                  <tr key={h.id}>
                    <td className="px-4 py-2.5 font-bold">{h.statementDate}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatCurrency(h.beginningBalance, currency)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatCurrency(h.clearedTotal, currency)}</td>
                    <td className="px-4 py-2.5 text-right font-bold tabular-nums">{formatCurrency(h.statementEndingBalance, currency)}</td>
                    <td className="px-4 py-2.5 text-center font-sans">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${h.status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}`}>
                        {h.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-sans text-slate-500">{h.reversalReason || 'Locked'}</td>
                    <td className="px-4 py-2.5 text-right font-sans">
                      {canReconcile && h.status === 'completed' && (
                        <button
                          onClick={() => setReverseTarget(h)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 text-[11px] font-semibold"
                        >
                          <RotateCcw className="w-3 h-3" /> Reverse
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* REVERSE REASON MODAL */}
      {reverseTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Reverse Reconciliation ({reverseTarget.statementDate})</span>
              <button onClick={() => setReverseTarget(null)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleReverse} className="p-5 space-y-3 text-xs">
              <p className="text-slate-600 dark:text-slate-300">
                Reversing this reconciliation unlocks all cleared bank transactions and GL lines for auditing or correction.
              </p>
              <div>
                <label className="font-semibold block mb-1">Audit Reason *</label>
                <input type="text" value={reverseReason} onChange={e => setReverseReason(e.target.value)} placeholder="e.g. Correcting duplicate deposit" className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950" required />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <button type="button" onClick={() => setReverseTarget(null)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy} className="px-4 py-2 rounded bg-rose-600 text-white font-bold">Confirm Reversal</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
