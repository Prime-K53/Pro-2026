import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  Wallet,
  TrendingUp,
  Package,
  Printer,
  Users,
  Target,
  ChevronDown,
} from 'lucide-react';
import {
  biApi,
  ArAgeingBucket,
  GroupedSalesTrend,
  KpiScorecard,
  KpiTarget,
  PayrollCostSummary,
  PrintingJobEfficiency,
  RevenueDrilldownRow,
  SalesSplit,
  SalesTrend,
  StockValuationItem,
} from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { InlineAlert, Panel, StatCard, StatusBadge } from '../common/ui';

type TrendPeriod = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
type GroupBy = 'product' | 'category' | 'customer';

/**
 * WS-8 — business intelligence.
 *
 * Every figure comes from the authoritative records (GL and subledgers) and the
 * KPI tiles carry a drill-down so the number can always be traced back to the
 * transactions behind it.
 */
export const BiDashboard: React.FC = () => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [period, setPeriod] = useState<TrendPeriod>('monthly');
  const [groupBy, setGroupBy] = useState<GroupBy | ''>('');

  const [kpis, setKpis] = useState<KpiScorecard | null>(null);
  const [trends, setTrends] = useState<SalesTrend[]>([]);
  const [grouped, setGrouped] = useState<GroupedSalesTrend[]>([]);
  const [ageing, setAgeing] = useState<ArAgeingBucket[]>([]);
  const [split, setSplit] = useState<SalesSplit | null>(null);
  const [stock, setStock] = useState<StockValuationItem[]>([]);
  const [jobs, setJobs] = useState<PrintingJobEfficiency[]>([]);
  const [payrollCost, setPayrollCost] = useState<PayrollCostSummary | null>(null);
  const [targets, setTargets] = useState<KpiTarget[]>([]);
  const [drilldown, setDrilldown] = useState<RevenueDrilldownRow[] | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newTargetKey, setNewTargetKey] = useState('revenue');
  const [newTargetValue, setNewTargetValue] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [k, a, s, st, j, p, t] = await Promise.all([
        biApi.kpiScorecard(),
        biApi.arAgeing(),
        biApi.salesSplit(),
        biApi.stockValuation(),
        biApi.jobEfficiency(),
        biApi.payrollCost(),
        biApi.kpiTargets(),
      ]);
      setKpis(k.kpis);
      setAgeing(a.buckets || []);
      setSplit(s);
      setStock(st.items || []);
      setJobs(j.jobs || []);
      setPayrollCost(p);
      setTargets(t.targets || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load BI data');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTrends = useCallback(async () => {
    try {
      if (groupBy) {
        const res = await biApi.salesTrendsGrouped(groupBy, period);
        setGrouped(res.trends || []);
        setTrends([]);
      } else {
        const res = await biApi.salesTrends(period);
        setTrends(res.trends || []);
        setGrouped([]);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load sales trends');
    }
  }, [period, groupBy]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    loadTrends();
  }, [loadTrends]);

  const addTarget = async () => {
    const value = Number(newTargetValue);
    if (!newTargetKey || !Number.isFinite(value)) {
      triggerShortcutNotice('KPI key and target value are required', 'error');
      return;
    }
    try {
      await biApi.upsertKpiTarget({ kpiKey: newTargetKey, targetValue: value });
      setNewTargetValue('');
      const res = await biApi.kpiTargets();
      setTargets(res.targets || []);
      triggerShortcutNotice('KPI target saved');
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to save target', 'error');
    }
  };

  const toggleDrilldown = async () => {
    if (drilldown) {
      setDrilldown(null);
      return;
    }
    try {
      const res = await biApi.drilldownRevenue(50);
      setDrilldown(res.rows || []);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Drill-down failed', 'error');
    }
  };

  const stockValue = stock.reduce((sum, i) => sum + Number(i.totalValue), 0);
  const stockUnits = stock.reduce((sum, i) => sum + Number(i.onHand), 0);

  const trendRows = groupBy ? grouped : trends;
  const maxTrendValue = Math.max(
    1,
    ...trendRows.map(r => Number((r as any).revenue || 0))
  );

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100 ring-inset dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20">
              <TrendingUp className="h-5 w-5" />
            </span>
            <h1 className="text-[22px] font-bold leading-tight tracking-tight text-slate-900 dark:text-white">
              Business Intelligence
            </h1>
          </div>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
            Metrics sourced from the general ledger and subledgers, reconciled to the trial balance.
            Click any KPI to drill down to the transactions behind it.
          </p>
        </div>
        <button type="button" onClick={loadAll} disabled={loading} className="btn btn-secondary">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <InlineAlert tone="error" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Revenue"
          value={formatCurrency(Number(kpis?.totalRevenue || 0), currency)}
          hint={`${kpis?.totalInvoices ?? 0} invoices`}
          icon={<TrendingUp className="h-4 w-4" />}
          tone="emerald"
          loading={loading}
        />
        <StatCard
          label="Gross profit"
          value={formatCurrency(Number(kpis?.grossProfit || 0), currency)}
          hint={`${kpis?.grossMargin || '0.00'}% margin`}
          icon={<Wallet className="h-4 w-4" />}
          tone="blue"
          loading={loading}
        />
        <StatCard
          label="Outstanding receivables"
          value={formatCurrency(Number(kpis?.outstandingReceivables || split?.outstanding || 0), currency)}
          hint={`${kpis?.totalCustomers ?? 0} customers`}
          icon={<Users className="h-4 w-4" />}
          tone="amber"
          loading={loading}
        />
        <StatCard
          label="Stock on hand"
          value={formatCurrency(stockValue, currency)}
          hint={`${kpis?.totalInventoryItems ?? stock.length} items · ${stockUnits.toLocaleString()} units`}
          icon={<Package className="h-4 w-4" />}
          tone="neutral"
          loading={loading}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Revenue drill-down
        </span>
        <button
          type="button"
          onClick={toggleDrilldown}
          className="btn btn-secondary py-1.5 text-xs"
        >
          <ChevronDown className={`h-3.5 w-3.5 ${drilldown ? 'rotate-180' : ''}`} />
          {drilldown ? 'Hide transactions' : 'Show underlying transactions'}
        </button>
        {kpis?.revenueTarget != null && (
          <StatusBadge tone={Number(kpis.revenueVariance) >= 0 ? 'success' : 'warning'}>
            Target {formatCurrency(Number(kpis.revenueTarget), currency)} · variance{' '}
            {formatCurrency(Number(kpis.revenueVariance || 0), currency)}
          </StatusBadge>
        )}
      </div>

      {drilldown && (
        <Panel title="Revenue drill-down" icon={<TrendingUp className="h-4 w-4 text-emerald-600" />}>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Customer</th>
                  <th>Date</th>
                  <th className="text-right">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {drilldown.map(r => (
                  <tr key={r.id}>
                    <td className="font-mono">{r.number}</td>
                    <td>{r.customer}</td>
                    <td className="whitespace-nowrap text-xs text-slate-500">{r.date}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(Number(r.total), currency)}
                    </td>
                    <td>
                      <StatusBadge tone="info">{r.status}</StatusBadge>
                    </td>
                  </tr>
                ))}
                {drilldown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-xs text-slate-500">
                      No revenue rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel
        title="Sales trends"
        description="Revenue, cost and margin over time, optionally grouped by product, category or customer."
        icon={<TrendingUp className="h-4 w-4 text-brand-600" />}
        actions={
          <div className="flex flex-wrap gap-2">
            <select
              value={period}
              onChange={e => setPeriod(e.target.value as TrendPeriod)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
            >
              {(['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as TrendPeriod[]).map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              value={groupBy}
              onChange={e => setGroupBy(e.target.value as GroupBy | '')}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="">Over time</option>
              <option value="product">By product</option>
              <option value="category">By category</option>
              <option value="customer">By customer</option>
            </select>
          </div>
        }
      >
        {trendRows.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500">No sales data yet.</p>
        ) : groupBy ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th className="text-right">Invoices</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {grouped.map(g => (
                  <tr key={g.groupKey}>
                    <td className="font-medium">{g.groupLabel}</td>
                    <td className="text-right font-mono tabular-nums">{g.invoiceCount}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(Number(g.revenue), currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(Number(g.cost), currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums text-emerald-600">
                      {formatCurrency(Number(g.margin), currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="space-y-2">
            {trends.map(t => {
              const revenue = Number(t.revenue);
              return (
                <div key={t.period} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate font-mono text-xs text-slate-500">
                    {t.period}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${Math.max(2, (revenue / maxTrendValue) * 100)}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums">
                    {formatCurrency(revenue, currency)}
                  </span>
                  <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-emerald-600">
                    {formatCurrency(Number(t.margin), currency)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Receivables ageing"
          description="Outstanding balances by age bucket."
          icon={<Users className="h-4 w-4 text-amber-600" />}
        >
          <div className="space-y-2">
            {ageing.map(b => (
              <div key={b.bucket} className="flex items-center justify-between text-sm">
                <span className="text-slate-600 dark:text-slate-300">{b.bucket}</span>
                <span className="font-mono tabular-nums">
                  {formatCurrency(Number(b.amount), currency)}{' '}
                  <span className="text-xs text-slate-400">({b.count})</span>
                </span>
              </div>
            ))}
            {ageing.length === 0 && (
              <p className="py-4 text-center text-xs text-slate-500">No outstanding balances.</p>
            )}
          </div>
          {split && (
            <div className="mt-3 flex gap-4 border-t border-slate-200 pt-3 text-xs dark:border-white/[0.07]">
              <span>
                Settled{' '}
                <strong className="font-mono tabular-nums">
                  {formatCurrency(Number(split.settled), currency)}
                </strong>
              </span>
              <span>
                Outstanding{' '}
                <strong className="font-mono tabular-nums">
                  {formatCurrency(Number(split.outstanding), currency)}
                </strong>
              </span>
            </div>
          )}
        </Panel>

        <Panel
          title="Payroll cost"
          description="Aggregate statutory payroll cost across all runs."
          icon={<Users className="h-4 w-4 text-indigo-600" />}
        >
          {payrollCost ? (
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['Gross', payrollCost.totalGross],
                ['PAYE', payrollCost.totalPAYE],
                ['Pension (employee)', payrollCost.totalPensionEmployee],
                ['Pension (employer)', payrollCost.totalPensionEmployer],
                ['Other deductions', payrollCost.totalOtherDeductions],
                ['Net pay', payrollCost.totalNet],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-slate-50 p-2.5 dark:bg-white/[0.04]">
                  <div className="text-[11px] uppercase text-slate-400">{label}</div>
                  <div className="font-mono font-semibold tabular-nums">
                    {formatCurrency(Number(value), currency)}
                  </div>
                </div>
              ))}
              <div className="col-span-2 text-xs text-slate-500">
                Headcount: {payrollCost.headcount}
              </div>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-slate-500">No payroll data.</p>
          )}
        </Panel>
      </div>

      <Panel
        title="Stock valuation"
        description="On-hand quantity valued at unit cost."
        icon={<Package className="h-4 w-4 text-emerald-600" />}
      >
        {stock.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500">No inventory items.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Unit cost</th>
                  <th className="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {stock.map(i => (
                  <tr key={i.itemId}>
                    <td className="font-mono">{i.sku}</td>
                    <td>{i.name}</td>
                    <td className="text-right font-mono tabular-nums">{i.onHand}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(Number(i.unitCost), currency)}
                    </td>
                    <td className="text-right font-mono font-semibold tabular-nums">
                      {formatCurrency(Number(i.totalValue), currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Printing job efficiency"
        description="Revenue, cost and margin per job — the same figures the profitability report uses."
        icon={<Printer className="h-4 w-4 text-slate-500" />}
      >
        {jobs.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500">No printing jobs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th className="text-right">Revenue</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Margin</th>
                  <th className="text-right">Margin %</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <tr key={j.jobId}>
                    <td className="font-mono">{j.jobNumber}</td>
                    <td>
                      <StatusBadge tone="neutral">{j.status}</StatusBadge>
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(Number(j.totalRevenue), currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(Number(j.totalCost), currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(Number(j.margin), currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">{j.marginPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="KPI targets"
        description="Targets and variance. Variance is actual minus target; positive is ahead."
        icon={<Target className="h-4 w-4 text-purple-600" />}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">KPI key</span>
            <input
              value={newTargetKey}
              onChange={e => setNewTargetKey(e.target.value)}
              className="mt-1 w-48 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Target</span>
            <input
              type="number"
              value={newTargetValue}
              onChange={e => setNewTargetValue(e.target.value)}
              className="mt-1 w-32 rounded-md border border-slate-300 bg-white px-3 py-2 tabular-nums dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <button type="button" onClick={addTarget} className="btn btn-primary">
            Save target
          </button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>KPI</th>
                <th className="text-right">Target</th>
                <th>Period</th>
                <th>Effective from</th>
              </tr>
            </thead>
            <tbody>
              {targets.map(t => (
                <tr key={t.id}>
                  <td className="font-mono">{t.kpiKey}</td>
                  <td className="text-right font-mono tabular-nums">
                    {formatCurrency(Number(t.targetValue), currency)}
                  </td>
                  <td className="text-xs text-slate-500">{t.period}</td>
                  <td className="text-xs text-slate-500">{t.effectiveFrom}</td>
                </tr>
              ))}
              {targets.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-xs text-slate-500">
                    No KPI targets set.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
};