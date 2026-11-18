import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import {
  ACCOUNTING_UPDATED_EVENT,
  accountingApi,
} from '../../services/accountingApi';
import type { ApiTrialBalanceReport } from '../../services/accountingApi';
import { formatCurrency } from '../../utils/currency';
import { AlertTriangle, CheckCircle2, Loader2, Rows3, ShieldCheck, WifiOff } from 'lucide-react';

type VerifyState = 'loading' | 'ready' | 'error' | 'restricted';

export const StatusBar: React.FC = () => {
  const { companyProfile, tableDensity, setTableDensity, triggerShortcutNotice } = useAccounting();
  const { activeCompany, hasPermission } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canVerify = hasPermission('reports:read');

  const [state, setState] = useState<VerifyState>(canVerify ? 'loading' : 'restricted');
  const [trialBalance, setTrialBalance] = useState<ApiTrialBalanceReport | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const loadVerification = useCallback(async () => {
    if (!canVerify) {
      setState('restricted');
      setTrialBalance(null);
      return;
    }
    setState(prev => (prev === 'ready' ? prev : 'loading'));
    const today = new Date().toISOString().slice(0, 10);
    const startDate = `${new Date().getFullYear()}-01-01`;
    try {
      const report = await accountingApi.getTrialBalance({ startDate, endDate: today });
      setTrialBalance(report);
      setState('ready');
      setLastSyncedAt(new Date().toLocaleTimeString());
    } catch {
      setState('error');
      setTrialBalance(null);
    }
  }, [canVerify]);

  useEffect(() => {
    loadVerification();
  }, [loadVerification, activeCompany?.id]);

  useEffect(() => {
    const handler = () => {
      loadVerification();
    };
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, [loadVerification]);

  const ar = (trialBalance?.rows || [])
    .filter(r => r.accountType === 'AccountsReceivable')
    .reduce((sum, r) => sum + r.netBalanceNum, 0);
  const ap = (trialBalance?.rows || [])
    .filter(r => r.accountType === 'AccountsPayable')
    .reduce((sum, r) => sum + Math.abs(r.netBalanceNum), 0);
  const cash = (trialBalance?.rows || [])
    .filter(r => r.accountType === 'Bank')
    .reduce((sum, r) => sum + r.netBalanceNum, 0);

  return (
    <footer className="statusbar no-print">
      <div className="flex min-w-0 items-center gap-4">
        {/* Ledger verification from the server GL, not from a browser cache */}
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          {state === 'loading' && (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 shrink-0" />
              <span>Verifying ledger against server GL…</span>
            </>
          )}
          {state === 'ready' && trialBalance && trialBalance.isBalanced && (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                Ledger balanced (ΣD = ΣC)
              </span>
            </>
          )}
          {state === 'ready' && trialBalance && !trialBalance.isBalanced && (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span className="text-amber-600 dark:text-amber-400 font-semibold">
                Trial balance differs by {formatCurrency(Number(trialBalance.difference || 0), currency)}
              </span>
            </>
          )}
          {state === 'restricted' && (
            <>
              <ShieldCheck className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span>Ledger verification requires reports access</span>
            </>
          )}
          {state === 'error' && (
            <>
              <WifiOff className="w-3.5 h-3.5 text-rose-500 shrink-0" />
              <button
                type="button"
                onClick={loadVerification}
                className="text-rose-600 dark:text-rose-400 font-semibold hover:underline"
                title="Retry ledger verification"
              >
                Ledger verification unavailable — retry
              </button>
            </>
          )}
        </div>

        {state === 'ready' && (
          <>
            <div className="hidden md:flex items-center gap-1 tabular-nums whitespace-nowrap">
              <span className="text-slate-400">Cash:</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {formatCurrency(cash, currency)}
              </span>
            </div>

            <div className="hidden lg:flex items-center gap-1 tabular-nums whitespace-nowrap">
              <span className="text-slate-400">A/R:</span>
              <span className="font-semibold text-blue-600 dark:text-blue-400">
                {formatCurrency(ar, currency)}
              </span>
            </div>

            <div className="hidden lg:flex items-center gap-1 tabular-nums whitespace-nowrap">
              <span className="text-slate-400">A/P:</span>
              <span className="font-semibold text-rose-600 dark:text-rose-400">
                {formatCurrency(ap, currency)}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <button
          onClick={() => {
            const next = tableDensity === 'compact' ? 'comfortable' : 'compact';
            setTableDensity(next);
            triggerShortcutNotice(`Ledger density set to ${next}`);
          }}
          className="hidden sm:flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-200 transition-colors cursor-pointer"
          title="Toggle ledger row density"
        >
          <Rows3 className="w-3 h-3" />
          <span className="capitalize">{tableDensity} rows</span>
        </button>

        <span aria-hidden="true" className="hidden h-3.5 w-px bg-slate-200 sm:inline dark:bg-white/10">|</span>

        <div className="hidden sm:flex items-center gap-1.5 whitespace-nowrap">
          <ShieldCheck className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
          <span className="truncate max-w-[180px]" title={activeCompany?.name || companyProfile.name}>
            {activeCompany ? `${activeCompany.name} · ${activeCompany.role}` : 'Authenticated session'}
          </span>
        </div>

        <span aria-hidden="true" className="hidden h-3.5 w-px bg-slate-200 md:inline dark:bg-white/10">|</span>

        <div className="hidden md:block whitespace-nowrap tabular-nums">
          {lastSyncedAt ? `GL sync ${lastSyncedAt}` : 'Server-backed ledger'}
        </div>
      </div>
    </footer>
  );
};
