import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  MinusCircle,
} from 'lucide-react';
import { adminApi, HealthCheck, SystemHealth } from '../../services/v2Api';
import { EmptyState, Panel, StatCard, StatusBadge } from '../common/ui';

const formatUptime = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
};

const checkIcon = (status: HealthCheck['status']) => {
  if (status === 'ok') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === 'error') return <XCircle className="h-4 w-4 text-rose-500" />;
  return <MinusCircle className="h-4 w-4 text-slate-400" />;
};

const checkTone = (status: HealthCheck['status']) =>
  status === 'ok' ? 'success' : status === 'error' ? 'danger' : 'neutral';

export const HealthDashboard: React.FC = () => {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await adminApi.health();
      setHealth(res);
    } catch (err: any) {
      setError(err?.message || 'Health check failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 30000);
    return () => window.clearInterval(interval);
  }, [load]);

  const checks = health?.checks || [];
  const failing = checks.filter(c => c.status === 'error');
  const degraded = health?.status === 'degraded' || failing.length > 0;

  return (
    <div className="space-y-4">
      <Panel
        title="System health"
        description="Live status of each subsystem. Refreshes every 30 seconds."
        icon={<Activity className="h-4 w-4 text-brand-600" />}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge tone={degraded ? 'warning' : 'success'}>
              {loading ? 'Checking…' : degraded ? 'Degraded' : 'All systems operational'}
            </StatusBadge>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="btn btn-secondary py-1.5 text-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        }
      >
        {error && (
          <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-[13px] text-rose-800 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard
            label="Overall status"
            value={health ? health.status.toUpperCase() : '—'}
            hint={health ? new Date(health.timestamp).toLocaleString() : ''}
            icon={<Activity className="h-4 w-4" />}
            tone={degraded ? 'rose' : 'emerald'}
            loading={loading}
          />
          <StatCard
            label="Uptime"
            value={health ? formatUptime(health.uptimeSeconds) : '—'}
            hint={`${checks.length} checks`}
            icon={<RefreshCw className="h-4 w-4" />}
            tone="blue"
            loading={loading}
          />
          <StatCard
            label="Failing checks"
            value={failing.length}
            hint={failing.length === 0 ? 'No failures' : failing.map(f => f.name).join(', ')}
            icon={<XCircle className="h-4 w-4" />}
            tone={failing.length > 0 ? 'rose' : 'emerald'}
            loading={loading}
          />
        </div>
      </Panel>

      <Panel
        title="Subsystem checks"
        icon={<CheckCircle2 className="h-4 w-4 text-slate-500" />}
        actions={
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {checks.filter(c => c.status === 'ok').length}/{checks.length} healthy
          </span>
        }
      >
        {checks.length === 0 && !loading ? (
          <EmptyState
            title="No checks reported"
            description="The health endpoint returned no subsystem checks."
            icon={<Activity className="h-6 w-6" />}
          />
        ) : (
          <ul className="space-y-2">
            {checks.map(c => (
              <li
                key={c.name}
                className="surface surface-hover flex flex-wrap items-center justify-between gap-3 p-3.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 dark:bg-white/[0.05]">
                    {checkIcon(c.status)}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">
                      {c.name}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
                      {c.detail || '—'}
                    </div>
                  </div>
                </div>
                <StatusBadge tone={checkTone(c.status)}>{c.status.replace('_', ' ')}</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
};