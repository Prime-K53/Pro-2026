import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT } from '../../services/accountingApi';
import { ApiBankAccount, commercialApi } from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
import { appDialog } from '../../design-system';
import {
  CheckCircle2,
  AlertTriangle,
  CheckSquare,
  Square,
  RotateCcw,
  Loader2,
  Scale,
} from 'lucide-react';
import {
  Button,
  FormField,
  InlineAlert,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  PageHeader,
  PageShell,
  StatusBadge,
} from '../common/ui';

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
    <PageShell>
      <PageHeader
        title="Bank Account Reconciliation"
        subtitle="Exact decimal zero-difference reconciliation with immutable GL period locking and audited reversal support."
        icon={<Scale className="w-5 h-5" strokeWidth={1.75} />}
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="recon-acct-select" className="text-xs font-semibold text-slate-600 dark:text-slate-300">Account:</label>
            <select
              id="recon-acct-select"
              value={selectedAccountId}
              onChange={e => {
                const nextId = Number(e.target.value);
                const acct = bankAccounts.find(b => b.glAccountId === nextId);
                setSelectedAccountId(nextId);
                if (acct) setStatementEndingBalance(String(acct.glBalance));
                setClearedIds(undefined);
              }}
              className="app-input !w-auto text-xs font-semibold"
            >
              {bankAccounts.map(b => (
                <option key={b.id} value={b.glAccountId}>
                  {b.accountCode} - {b.accountName} ({formatCurrency(b.glBalance, currency)})
                </option>
              ))}
            </select>
          </div>
        }
      />

      {errorMsg && (
        <InlineAlert tone="error" onDismiss={() => setErrorMsg(null)}>
          {errorMsg}
        </InlineAlert>
      )}

      {/* Statement Parameters */}
      <div className="surface p-5 grid grid-cols-1 md:grid-cols-4 gap-4 items-end text-xs">
        <div>
          <label className="app-label">Beginning Balance (Last Closed)</label>
          <div className="mt-1 px-3 py-2 rounded-lg bg-slate-100 dark:bg-white/[0.06] font-mono font-bold text-sm tabular-nums text-slate-900 dark:text-white">
            {formatCurrency(preview?.beginningBalance ?? 0, currency)}
          </div>
        </div>
        <FormField label="Statement Ending Date">
          <input
            type="date"
            value={statementDate}
            onChange={e => {
              setStatementDate(e.target.value);
              setClearedIds(undefined);
            }}
            className="app-input app-input-mono"
          />
        </FormField>
        <FormField label={`Statement Ending Balance (${currency})`}>
          <input
            type="number"
            step="0.01"
            value={statementEndingBalance}
            onChange={e => setStatementEndingBalance(e.target.value)}
            className="app-input app-input-mono font-bold"
          />
        </FormField>
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setClearedIds(items.map(i => i.id))}>
            Mark All
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setClearedIds([])}>
            Unmark All
          </Button>
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
          <div className="surface overflow-hidden">
            <div className="surface-header bg-slate-50/70 dark:bg-white/[0.03] text-xs">
              <span className="font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-200">
                Checks &amp; Payments ({payments.filter(p => p.selected).length}/{payments.length})
              </span>
              <span className="font-mono font-bold tabular-nums text-rose-600 dark:text-rose-400">
                -{formatCurrency(preview?.clearedPayments ?? 0, currency)}
              </span>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-200 dark:divide-white/[0.06] text-xs font-mono">
              {payments.length === 0 ? (
                <div className="p-6 text-center font-sans text-slate-400">No unreconciled payments up to {statementDate}.</div>
              ) : (
                payments.map(p => (
                  <div
                    key={p.id}
                    onClick={() => toggleCleared(p.id)}
                    className={`p-3 flex items-center justify-between cursor-pointer transition-colors ${p.selected ? 'bg-brand-50/50 dark:bg-brand-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'}`}
                  >
                    <div className="flex items-center gap-3">
                      {p.selected ? <CheckSquare className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <Square className="w-4 h-4 text-slate-300 dark:text-slate-600" />}
                      <div>
                        <div className="font-sans font-semibold text-slate-900 dark:text-white">{p.payee}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">{p.date} · {p.refNumber || p.type}</div>
                      </div>
                    </div>
                    <div className="font-bold tabular-nums">{formatCurrency(Math.abs(p.amount), currency)}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Deposits */}
          <div className="surface overflow-hidden">
            <div className="surface-header bg-slate-50/70 dark:bg-white/[0.03] text-xs">
              <span className="font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-200">
                Deposits &amp; Credits ({deposits.filter(d => d.selected).length}/{deposits.length})
              </span>
              <span className="font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                +{formatCurrency(preview?.clearedDeposits ?? 0, currency)}
              </span>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-200 dark:divide-white/[0.06] text-xs font-mono">
              {deposits.length === 0 ? (
                <div className="p-6 text-center font-sans text-slate-400">No unreconciled deposits up to {statementDate}.</div>
              ) : (
                deposits.map(d => (
                  <div
                    key={d.id}
                    onClick={() => toggleCleared(d.id)}
                    className={`p-3 flex items-center justify-between cursor-pointer transition-colors ${d.selected ? 'bg-brand-50/50 dark:bg-brand-500/10' : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'}`}
                  >
                    <div className="flex items-center gap-3">
                      {d.selected ? <CheckSquare className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <Square className="w-4 h-4 text-slate-300 dark:text-slate-600" />}
                      <div>
                        <div className="font-sans font-semibold text-slate-900 dark:text-white">{d.payee}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">{d.date} · {d.refNumber || d.type}</div>
                      </div>
                    </div>
                    <div className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">+{formatCurrency(d.amount, currency)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Difference Settlement Bar */}
      <div
        className={`surface p-5 font-mono ${
          preview?.differenceExactZero
            ? 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10'
            : 'border-amber-300 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            {preview?.differenceExactZero ? (
              <>
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                <span className="font-sans font-bold text-base text-emerald-900 dark:text-emerald-100">
                  Balanced to Zero ({formatCurrency(0, currency)}) — Ready to Lock
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                <span className="font-sans font-bold text-base text-amber-900 dark:text-amber-100">
                  Difference Remaining: {formatCurrency(preview?.difference ?? 0, currency)}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-6 text-xs">
            <div>
              <div className="text-slate-500 dark:text-slate-400 text-[10px] uppercase">Cleared Ending Balance</div>
              <div className="font-bold text-sm tabular-nums text-slate-900 dark:text-white">{formatCurrency(preview?.clearedEndingBalance ?? 0, currency)}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400 text-[10px] uppercase">Difference</div>
              <div className={`text-lg font-bold tabular-nums ${preview?.differenceExactZero ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {formatCurrency(preview?.difference ?? 0, currency)}
              </div>
            </div>
            {canReconcile && (
              <Button
                variant="emerald"
                onClick={handleComplete}
                loading={busy}
                disabled={!preview?.differenceExactZero}
              >
                {busy ? 'Locking...' : 'Reconcile Now'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Banking Rules (Module 6) */}
      <div className="surface overflow-hidden">
        <div className="surface-header text-xs">
          <span className="font-semibold text-slate-900 dark:text-white">Reconciliation Rules</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={rulesBusy}
            onClick={async () => {
              const ruleName = await appDialog.prompt({
                title: 'Add Reconciliation Rule',
                message: 'Name the bank statement matching rule.',
                label: 'Rule name',
                required: true,
              });
              if (!ruleName) return;
              const matchPattern =
                (await appDialog.prompt({
                  title: 'Match Pattern',
                  message: 'Enter text that statement descriptions must contain.',
                  label: 'Description contains',
                  defaultValue: ruleName,
                  required: true,
                })) || ruleName;
              setRulesBusy(true);
              try {
                await commercialApi.upsertBankReconRule({ ruleName, matchField: 'description', matchPattern, autoPost: false, isActive: true });
                await loadRules();
                triggerShortcutNotice('Reconciliation rule saved');
              } catch (e: any) { setErrorMsg(e?.message || 'Failed to save rule'); }
              finally { setRulesBusy(false); }
            }}
          >
            Add Rule
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table w-full text-left text-xs">
            <thead><tr><th>Name</th><th>Field</th><th>Pattern</th><th>Active</th></tr></thead>
            <tbody>{reconRules.length === 0 ? <tr><td colSpan={4} className="px-4 py-4 text-center text-slate-400">No recon rules.</td></tr> : reconRules.map((r: any) => (
              <tr key={r.id}><td>{r.rule_name || r.ruleName}</td><td>{r.match_field || r.matchField}</td><td className="font-mono">{r.match_pattern || r.matchPattern}</td><td>{String(r.is_active ?? r.isActive)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      {/* History */}
      <div className="surface overflow-hidden">
        <div className="surface-header font-semibold text-xs text-slate-900 dark:text-white">Reconciliation History &amp; Audit Locks</div>
        <div className="overflow-x-auto">
          <table className="data-table w-full text-left text-xs">
            <thead>
              <tr>
                <th>Statement Date</th>
                <th className="text-right">Beginning</th>
                <th className="text-right">Cleared Net</th>
                <th className="text-right">Ending Balance</th>
                <th className="text-center">Status</th>
                <th>Notes / Reason</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {history.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center font-sans text-slate-400">No reconciliations recorded yet for this account.</td></tr>
              ) : (
                history.map(h => (
                  <tr key={h.id}>
                    <td className="font-semibold">{h.statementDate}</td>
                    <td className="text-right tabular-nums">{formatCurrency(h.beginningBalance, currency)}</td>
                    <td className="text-right tabular-nums">{formatCurrency(h.clearedTotal, currency)}</td>
                    <td className="text-right font-bold tabular-nums">{formatCurrency(h.statementEndingBalance, currency)}</td>
                    <td className="text-center font-sans">
                      <StatusBadge tone={h.status === 'completed' ? 'success' : 'neutral'}>
                        {h.status}
                      </StatusBadge>
                    </td>
                    <td className="font-sans text-slate-500 dark:text-slate-400">{h.reversalReason || 'Locked'}</td>
                    <td className="text-right font-sans">
                      {canReconcile && h.status === 'completed' && (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setReverseTarget(h)}
                          icon={<RotateCcw className="w-3 h-3" />}
                        >
                          Reverse
                        </Button>
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
      <ModalShell open={!!reverseTarget} onClose={() => setReverseTarget(null)} size="md">
        <ModalHeader
          title={`Reverse Reconciliation (${reverseTarget?.statementDate ?? ''})`}
          icon={<RotateCcw className="w-4 h-4" strokeWidth={1.75} />}
          tone="rose"
          onClose={() => setReverseTarget(null)}
        />
        <form id="recon-reverse-form" onSubmit={handleReverse}>
          <ModalBody>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Reversing this reconciliation unlocks all cleared bank transactions and GL lines for auditing or correction.
            </p>
            <FormField label="Audit Reason" required>
              <input
                type="text"
                value={reverseReason}
                onChange={e => setReverseReason(e.target.value)}
                placeholder="e.g. Correcting duplicate deposit"
                className="app-input"
                required
              />
            </FormField>
          </ModalBody>
          <ModalFooter
            onCancel={() => setReverseTarget(null)}
            form="recon-reverse-form"
            submitLabel="Confirm Reversal"
            busy={busy}
            tone="rose"
          />
        </form>
      </ModalShell>
    </PageShell>
  );
};
