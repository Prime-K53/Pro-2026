import React, { useCallback, useEffect, useState } from 'react';
import { TrendingUp, BarChart3, RefreshCw, Receipt, Users, Package, Wallet } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';
import { biApi, KpiScorecard, SalesTrend } from '../../services/v2Api';
import { formatCurrency } from '../../utils/currency';
import {
  EmptyState,
  InlineAlert,
  Panel,
  StatCard,
} from '../common/ui';

interface Trend {
  period: string;
  invoiceCount: number;
  revenue: string;
  cost: string;
  margin: string;
}

type Period = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

export const SalesTrendsView: React.FC = () => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [trends, setTrends] = useState<SalesTrend[]>([]);
  const [period, setPeriod] = useState<Period>('monthly');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await biApi.salesTrends(period);
      setTrends(res.trends || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load sales trends');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  const maxRevenue = Math.max(1, ...trends.map(t => Number(t.revenue) || 0));

  const totals = trends.reduce(
    (acc, t) => ({
      revenue: acc.revenue + Number(t.revenue || 0),
      cost: acc.cost + Number(t.cost || 0),
      margin: acc.margin + Number(t.margin || 0),
      invoices: acc.invoices + Number(t.invoiceCount || 0),
    }),
    { revenue: 0, cost: 0, margin: 0, invoices: 0 }
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Revenue"
          value={formatCurrency(totals.revenue, currency)}
          hint={`${totals.invoices} invoices`}
          icon={<TrendingUp className="h-4 w-4" />}
          tone="emerald"
          loading={loading}
        />
        <StatCard
          label="Cost"
          value={formatCurrency(totals.cost, currency)}
          icon={<Receipt className="h-4 w-4" />}
          tone="neutral"
          loading={loading}
        />
        <StatCard
          label="Gross margin"
          value={formatCurrency(totals.margin, currency)}
          hint={
            totals.revenue > 0
              ? `${((totals.margin / totals.revenue) * 100).toFixed(2)}%`
              : '—'
          }
          icon={<Wallet className="h-4 w-4" />}
          tone="blue"
          loading={loading}
        />
        <StatCard
          label="Periods"
          value={trends.length}
          hint={period}
          icon={<BarChart3 className="h-4 w-4" />}
          tone="amber"
          loading={loading}
        />
      </div>

      <Panel
        title="Sales trends"
        description="Revenue, cost and margin over time, sourced from posted invoices."
        icon={<TrendingUp className="h-4 w-4 text-brand-600" />}
        actions={
          <div className="flex items-center gap-2">
            <select
              value={period}
              onChange={e => setPeriod(e.target.value as Period)}
              className="app-input w-auto py-1.5 text-xs"
            >
              {PERIODS.map(p => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
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
          <InlineAlert tone="error" onDismiss={() => setError(null)}>
            {error}
          </InlineAlert>
        )}

        {trends.length === 0 && !loading ? (
          <EmptyState
            title="No sales data"
            description="Trends appear once invoices have been posted for the selected period."
            icon={<TrendingUp className="h-6 w-6" />}
          />
        ) : (
          <div className="space-y-2">
            {trends.map((t: Trend) => {
              const revenue = Number(t.revenue) || 0;
              const margin = Number(t.margin) || 0;
              return (
                <div key={t.period} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    {t.period}
                  </span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600"
                      style={{ width: `${Math.max(2, (revenue / maxRevenue) * 100)}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right font-mono text-[12px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                    {formatCurrency(revenue, currency)}
                  </span>
                  <span className="hidden w-24 shrink-0 text-right font-mono text-[11px] tabular-nums text-emerald-600 sm:inline dark:text-emerald-400">
                    {formatCurrency(margin, currency)}
                  </span>
                  <span className="hidden w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-400 md:inline">
                    {t.invoiceCount}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {trends.length > 0 && (
        <Panel
          title="Period detail"
          icon={<Receipt className="h-4 w-4 text-slate-500" />}
          actions={
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              {trends.length} periods
            </span>
          }
        >
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="text-right">Invoices</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {trends.map(t => (
                  <tr key={t.period}>
                    <td className="font-mono text-xs">{t.period}</td>
                    <td className="text-right font-mono tabular-nums">{t.invoiceCount}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(Number(t.revenue), currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(Number(t.cost), currency)}
                    </td>
                    <td className="text-right font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(Number(t.margin), currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
};

export const KpiScorecardView: React.FC = () => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [kpis, setKpis] = useState<KpiScorecard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await biApi.kpiScorecard();
      setKpis(res.kpis);
    } catch (err: any) {
      setError(err?.message || 'Failed to load KPI scorecard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const k = kpis as (KpiScorecard & Record<string, any>) | null;

  return (
    <Panel
      title="KPI scorecard"
      description="Headline measures for the company, drawn from the same records as the financial reports."
      icon={<BarChart3 className="h-4 w-4 text-brand-600" />}
      actions={
        <button
          type="button"
          onClick={() => {
            load();
            triggerShortcutNotice?.('Refreshing KPIs');
          }}
          disabled={loading}
          className="btn btn-secondary py-1.5 text-xs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      }
    >
      {error && (
        <InlineAlert tone="error" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Total invoices"
          value={k?.totalInvoices ?? 0}
          icon={<Receipt className="h-4 w-4" />}
          tone="blue"
          loading={loading}
        />
        <StatCard
          label="Customers"
          value={k?.totalCustomers ?? 0}
          icon={<Users className="h-4 w-4" />}
          tone="emerald"
          loading={loading}
        />
        <StatCard
          label="Inventory items"
          value={k?.totalInventoryItems ?? 0}
          icon={<Package className="h-4 w-4" />}
          tone="amber"
          loading={loading}
        />
        <StatCard
          label="Total revenue"
          value={formatCurrency(Number(k?.totalRevenue || 0), currency)}
          icon={<TrendingUp className="h-4 w-4" />}
          tone="emerald"
          loading={loading}
        />
        <StatCard
          label="Gross profit"
          value={formatCurrency(Number(k?.grossProfit || 0), currency)}
          hint={k?.grossMargin ? `${k.grossMargin}% margin` : undefined}
          icon={<Wallet className="h-4 w-4" />}
          tone="blue"
          loading={loading}
        />
        <StatCard
          label="Outstanding receivables"
          value={formatCurrency(Number(k?.outstandingReceivables || 0), currency)}
          icon={<Receipt className="h-4 w-4" />}
          tone="rose"
          loading={loading}
        />
      </div>
    </Panel>
  );
};