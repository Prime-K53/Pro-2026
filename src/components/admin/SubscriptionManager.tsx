import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard, Plug, RefreshCw, Server } from 'lucide-react';
import { adminApi } from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import { IntegrationManager } from './IntegrationManager';
import { ReleaseManager } from './ReleaseManager';

type Tab = 'integrations' | 'billing' | 'releases';

/**
 * WS-9 — system administration.
 *
 * Groups integrations + secret rotation, subscription/billing state and release
 * history. There is deliberately no HTTP restore or rollback here: restore is
 * an audited operator runbook procedure (docs/runbooks/restore.md,
 * docs/runbooks/deploy.md), not a button.
 */
export const SubscriptionManager: React.FC = () => {
  const [tab, setTab] = useState<Tab>('integrations');
  const [backup, setBackup] = useState<any>(null);
  const [readiness, setReadiness] = useState<any>(null);

  const loadOps = useCallback(async () => {
    try {
      const [b, r] = await Promise.all([
        adminApi.backupStatus().catch(() => null),
        adminApi.restoreReadiness().catch(() => null),
      ]);
      setBackup(b);
      setReadiness(r);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    loadOps();
  }, [loadOps]);

  return (
    <div className="space-y-6">
      <div className="flex w-fit flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 text-xs font-semibold shadow-xs dark:border-slate-800 dark:bg-slate-900">
        {(
          [
            { id: 'integrations', label: 'Integrations', icon: Plug },
            { id: 'billing', label: 'Billing', icon: CreditCard },
            { id: 'releases', label: 'Releases & Audit', icon: Server },
          ] as Array<{ id: Tab; label: string; icon: React.ElementType }>
        ).map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 transition-colors ${
                tab === item.id
                  ? 'bg-[#0f3d63] text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === 'integrations' && <IntegrationManager />}
      {tab === 'billing' && <ReleaseManager />}
      {tab === 'releases' && (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="surface p-5">
              <h3 className="section-title">Backup status</h3>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-[11px] text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                {JSON.stringify(backup, null, 2)}
              </pre>
            </div>
            <div className="surface p-5">
              <h3 className="section-title">Restore readiness</h3>
              <p className="mt-1 text-[11px] text-slate-500">
                Restore is an operator procedure, never an HTTP call. See
                <code className="mx-1">docs/runbooks/restore.md</code>.
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-[11px] text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                {JSON.stringify(readiness, null, 2)}
              </pre>
            </div>
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={loadOps} className="btn btn-secondary">
              <RefreshCw className="h-4 w-4" />
              Refresh operations status
            </button>
          </div>
          <ReleaseManager />
        </div>
      )}
    </div>
  );
};