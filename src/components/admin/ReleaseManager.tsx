import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard, RefreshCw, ShieldAlert } from 'lucide-react';
import { adminApi, AuditSummary, ReleaseVersion, Subscription } from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { InlineAlert, Panel, StatCard, StatusBadge } from '../common/ui';

/**
 * WS-9 S9 / S11 / S12 — release history and audit monitoring.
 *
 * The plan deliberately has no HTTP restore endpoint; restore is an operator
 * runbook procedure. This screen surfaces health, release history, the audit
 * summary and subscription state (read-only) without exposing a destructive
 * action.
 */
export const ReleaseManager: React.FC = () => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [releases, setReleases] = useState<ReleaseVersion[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [audit, setAudit] = useState<AuditSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, s, a] = await Promise.all([
        adminApi.releases(),
        adminApi.subscriptions(),
        adminApi.auditSummary(),
      ]);
      setReleases(r.releases || []);
      setSubscriptions(s.subscriptions || []);
      setAudit(a);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to load release information', 'error');
    } finally {
      setLoading(false);
    }
  }, [triggerShortcutNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const current = releases.find(r => r.isCurrent);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Current version"
          value={current?.version || 'Unrecorded'}
          hint={current ? new Date(current.releasedAt).toLocaleDateString() : ''}
          icon={<CreditCard className="h-4 w-4" />}
          tone="blue"
          loading={loading}
        />
        <StatCard
          label="Audit actions (24h)"
          value={audit?.totalActions ?? 0}
          hint={`${audit?.criticalActions ?? 0} critical`}
          icon={<ShieldAlert className="h-4 w-4" />}
          tone={(audit?.criticalActions ?? 0) > 0 ? 'rose' : 'emerald'}
          loading={loading}
        />
        <StatCard
          label="Subscriptions"
          value={subscriptions.length}
          hint={
            subscriptions.length > 0
              ? formatCurrency(Number(subscriptions[0].planPrice || 0), currency)
              : 'Local billing only'
          }
          icon={<CreditCard className="h-4 w-4" />}
          tone="amber"
          loading={loading}
        />
      </div>

      <Panel
        title="Release history"
        description="Recorded releases. Rollback follows docs/runbooks/deploy.md — there is no HTTP rollback."
        icon={<CreditCard className="h-4 w-4 text-brand-600" />}
        actions={
          <button type="button" onClick={load} disabled={loading} className="btn btn-secondary py-1.5 text-xs">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      >
        {releases.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500">No releases recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Notes</th>
                  <th>Status</th>
                  <th className="text-right">Released</th>
                </tr>
              </thead>
              <tbody>
                {releases.map(r => (
                  <tr key={r.id}>
                    <td className="font-mono font-semibold">{r.version}</td>
                    <td className="max-w-[420px] text-xs text-slate-500">{r.notes || '—'}</td>
                    <td>
                      {r.isCurrent ? (
                        <StatusBadge tone="success">current</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">archived</StatusBadge>
                      )}
                    </td>
                    <td className="text-right text-xs text-slate-500">
                      {new Date(r.releasedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Audit summary"
        description="Actions recorded in the last 24 hours, with critical actions called out."
        icon={<ShieldAlert className="h-4 w-4 text-rose-600" />}
      >
        {audit && audit.byAction.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th className="text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {audit.byAction.map(a => (
                  <tr key={a.action}>
                    <td className="font-mono text-xs">{a.action}</td>
                    <td className="text-right font-mono tabular-nums">{a.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-6 text-center text-xs text-slate-500">No audit actions in the last 24h.</p>
        )}
      </Panel>

      <Panel
        title="Subscriptions"
        description="Local billing — plans are invoiced manually. No external payment provider."
        icon={<CreditCard className="h-4 w-4 text-emerald-600" />}
      >
        {subscriptions.length === 0 ? (
          <InlineAlert tone="info">
            No subscription rows. Local billing is handled by manual invoicing against the plan
            configured for this company.
          </InlineAlert>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th className="text-right">Price</th>
                  <th>Status</th>
                  <th className="text-right">Started</th>
                  <th className="text-right">Ends</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map(s => (
                  <tr key={s.id}>
                    <td className="font-medium">{s.planName}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(Number(s.planPrice), currency)}
                    </td>
                    <td>
                      <StatusBadge
                        tone={s.status === 'active' ? 'success' : s.status === 'suspended' ? 'warning' : 'neutral'}
                      >
                        {s.status}
                      </StatusBadge>
                    </td>
                    <td className="text-right text-xs text-slate-500">{s.startedAt || '—'}</td>
                    <td className="text-right text-xs text-slate-500">{s.endsAt || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
};