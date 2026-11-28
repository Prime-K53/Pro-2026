import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT } from '../../services/accountingApi';
import { ApiBankTransaction, commercialApi } from '../../services/commercialApi';
import { financeControlsApi } from '../../services/financeControlsApi';
import type { DashboardAlerts } from '../../services/financeControlsApi';
import { MonthlyCashflowChart, ExpenseBreakdownDonut } from '../charts/FinancialCharts';
import { Button, EmptyState, InlineAlert, PageHeader, StatCard } from '../common/ui';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';
import {
  TrendingUp,
  DollarSign,
  FileText,
  Receipt,
  ArrowUpRight,
  ArrowDownRight,
  CheckCircle2,
  Landmark,
  BarChart3,
  PieChart,
  Loader2,
  Bell,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';

export const DashboardView: React.FC = () => {
  const {
    companyProfile,
    setCurrentView,
    setIsNewInvoiceOpen,
    setIsEnterBillOpen,
  } = useAccounting();
  const { activeCompany, hasPermission } = useAuth();
  const currency = getCurrencySymbol(companyProfile.currency);
  const canReadReports = hasPermission('reports:read');

  const [overview, setOverview] = useState<any | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [recentBankTxns, setRecentBankTxns] = useState<ApiBankTransaction[]>([]);
  const [alerts, setAlerts] = useState<DashboardAlerts | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setAlertsError(null);
    try {
      const [ov, txns, alertFeed] = await Promise.all([
        commercialApi.getAnalyticsOverview().catch(err => { setOverviewError(err?.message || 'Dashboard data unavailable'); return null; }),
        commercialApi.listBankTransactions({ status: 'posted' }).catch(() => []),
        canReadReports
          ? financeControlsApi.dashboardAlerts().catch(err => {
              setAlertsError(err?.message || 'Operational alerts unavailable');
              return null;
            })
          : Promise.resolve(null),
      ]);
      if (ov) { setOverview(ov); setOverviewError(null); }
      setRecentBankTxns(txns.slice(0, 6));
      setAlerts(alertFeed);
      setLastUpdated(new Date().toLocaleTimeString());
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id, canReadReports]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    const onUpdated = () => loadDashboard();
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, onUpdated);
  }, [loadDashboard]);

  const kpis = overview?.kpis || {
    ytdRevenue: 0,
    ytdCogs: 0,
    ytdExpenses: 0,
    ytdNetIncome: 0,
    netProfitMarginPct: 0,
    totalBankCash: 0,
    creditCardDebt: 0,
    netLiquidCash: 0,
    totalArOutstanding: 0,
    totalApOutstanding: 0,
  };

  const totalIncome = Number(kpis.ytdRevenue || 0);
  const totalCogs = Number(kpis.ytdCogs || 0);
  const totalExpenses = Number(kpis.ytdExpenses || 0);
  const grossProfit = totalIncome - totalCogs;
  const netIncome = Number(kpis.ytdNetIncome || 0);
  const netMargin = Number(kpis.netProfitMarginPct || 0);
  const totalCash = Number(kpis.totalBankCash || 0);
  const totalAr = Number(kpis.totalArOutstanding || 0);
  const totalAp = Number(kpis.totalApOutstanding || 0);

  const expenseSlices = [
    {
      label: 'Cost of Goods Sold',
      amount: totalCogs || 1,
      color: '#2563eb',
      strokeClass: 'stroke-blue-600',
      dotClass: 'bg-blue-600',
    },
    {
      label: 'Operating Expenses',
      amount: totalExpenses || 1,
      color: '#10b981',
      strokeClass: 'stroke-emerald-500',
      dotClass: 'bg-emerald-500',
    },
    {
      label: 'Credit Card & Short-Term Debt',
      amount: Math.max(0, Number(kpis.creditCardDebt || 0)),
      color: '#f59e0b',
      strokeClass: 'stroke-amber-500',
      dotClass: 'bg-amber-500',
    },
  ].filter(s => s.amount > 0);

  const topDebtors: Array<{ customerId: number; name: string; balance: number }> = overview?.topDebtors || [];
  const topCreditors: Array<{ vendorId: number; name: string; balance: number }> = overview?.topCreditors || [];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      {/* View Header */}
      <PageHeader
        title="Executive Financial Dashboard"
        subtitle={`Live PostgreSQL double-entry metrics · ${activeCompany?.name || companyProfile.name} · Accrual Basis`}
        icon={<BarChart3 className="w-5 h-5" strokeWidth={1.75} />}
        actions={
          <>
            {lastUpdated && (
              <span className="hidden sm:inline text-[11px] font-medium text-slate-600 dark:text-slate-400 font-mono tabular-nums">
                Updated {lastUpdated}
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={loadDashboard}
              disabled={loading}
              aria-label="Refresh dashboard"
              title="Refresh dashboard"
              icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.75} aria-hidden="true" />}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setIsNewInvoiceOpen(true)}
            >
              + Create Invoice
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsEnterBillOpen(true)}
            >
              + Enter Bill
            </Button>
          </>
        }
      />

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Revenue (YTD)"
          tone="emerald"
          icon={<TrendingUp className="w-4 h-4" />}
          loading={loading && !overview}
          value={formatCurrency(totalIncome, currency)}
          hint={
            <span className="flex items-center gap-1.5">
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">Gross Margin</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {totalIncome > 0 ? ((grossProfit / totalIncome) * 100).toFixed(1) : '0.0'}%
              </span>
            </span>
          }
        />

        <StatCard
          label="Cost of Goods Sold"
          tone="amber"
          icon={<Receipt className="w-4 h-4" />}
          loading={loading && !overview}
          value={formatCurrency(totalCogs, currency)}
          hint="Perpetual inventory & BOM consumption"
        />

        <StatCard
          label="Net Operating Income"
          tone={netIncome >= 0 ? 'blue' : 'rose'}
          icon={<DollarSign className="w-4 h-4" />}
          loading={loading && !overview}
          value={formatCurrency(netIncome, currency)}
          hint={
            <span className="flex items-center gap-1.5">
              <span>Net Margin</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono font-bold tabular-nums text-slate-800 dark:text-slate-200">
                {netMargin.toFixed(1)}%
              </span>
            </span>
          }
        />

        <StatCard
          label="Liquid Bank Cash"
          tone="neutral"
          icon={<Landmark className="w-4 h-4" />}
          loading={loading && !overview}
          value={formatCurrency(totalCash, currency)}
          hint={
            <span>
              Net Liquid: <span className="font-mono font-semibold">{formatCurrency(kpis.netLiquidCash, currency)}</span>
            </span>
          }
        />
      </div>

      {/* Operational alert feed from /api/dashboard/alerts */}
      {alertsError && (
        <InlineAlert
          tone="warning"
          action={
            <Button variant="secondary" size="sm" onClick={() => loadDashboard()} disabled={loading}>
              Retry
            </Button>
          }
        >
          {alertsError}
        </InlineAlert>
      )}

      {overviewError && (
        <InlineAlert
          tone="error"
          action={
            <Button variant="secondary" size="sm" onClick={() => loadDashboard()} disabled={loading}>
              Retry
            </Button>
          }
        >
          {overviewError} — the figures below are shown as zero rather than a partial total.
        </InlineAlert>
      )}

      {alerts && alerts.alerts.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
              <Bell className="w-4 h-4 text-amber-600" strokeWidth={1.75} aria-hidden="true" />
              <span>Operational Alerts</span>
              <span className="text-[11px] font-mono tabular-nums text-slate-600 dark:text-slate-400">
                {alerts.alerts.length} active
              </span>
            </h2>
            <button
              onClick={() => setCurrentView('finance-controls')}
              className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
            >
              Open alert center →
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {alerts.alerts.slice(0, 6).map(a => {
              const key = String(a.key || '').toLowerCase();
              const target = key.includes('pay')
                ? 'bills'
                : key.includes('receiv') || key.includes('invoice')
                ? 'invoices'
                : key.includes('stock') || key.includes('inventory')
                ? 'inventory'
                : key.includes('bank') || key.includes('recon')
                ? 'reconciliation'
                : 'reports';
              const critical = a.severity === 'critical';
              const warning = a.severity === 'warning';
              return (
                <button
                  key={a.key}
                  onClick={() => setCurrentView(target)}
                  className={`text-left p-4 rounded-xl border bg-white dark:bg-slate-900 transition-colors hover:border-slate-400 dark:hover:border-slate-600 ${
                    critical
                      ? 'border-rose-300 dark:border-rose-900'
                      : warning
                      ? 'border-amber-300 dark:border-amber-900'
                      : 'border-slate-200 dark:border-slate-800'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle
                      className={`w-4 h-4 shrink-0 mt-0.5 ${
                        critical ? 'text-rose-500' : warning ? 'text-amber-500' : 'text-blue-500'
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-900 dark:text-white truncate">{a.title}</div>
                      {a.detail && (
                        <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">{a.detail}</div>
                      )}
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] font-mono text-slate-500">
                        {typeof a.count === 'number' && <span>{a.count} item(s)</span>}
                        {a.amount && <span className="font-bold">{formatCurrency(Number(a.amount), currency)}</span>}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {alerts && alerts.alerts.length === 0 && (
        <div className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          <span>No operational alerts. Receivables, payables, stock and period controls are clear.</span>
        </div>
      )}

      {/* Primary Interactive Financial Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-7 surface p-6 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-blue-600" />
              <h2 className="font-bold text-sm text-slate-900 dark:text-white">
                Revenue, Expenses &amp; Cashflow Trend
              </h2>
            </div>
            <button
              onClick={() => setCurrentView('reports')}
              className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
            >
              Open P&amp;L Report →
            </button>
          </div>

          <MonthlyCashflowChart
            totalIncome={totalIncome}
            totalOutflows={totalCogs + totalExpenses}
            currency={currency}
          />
        </div>

        <div className="lg:col-span-5 surface p-6 flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <PieChart className="w-4 h-4 text-emerald-600" />
              <h2 className="font-bold text-sm text-slate-900 dark:text-white">
                Cost &amp; Operating Expense Mix
              </h2>
            </div>
            <span className="text-[11px] font-mono text-slate-600 dark:text-slate-400">YTD GL</span>
          </div>

          <ExpenseBreakdownDonut slices={expenseSlices} currency={currency} />
        </div>
      </div>

      {/* Two-Column Operational Ledger Split */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="surface p-6 space-y-5">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
            <h2 className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-600" />
              <span>Receivables (A/R) vs Payables (A/P)</span>
            </h2>
            <button
              onClick={() => setCurrentView('reports')}
              className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
            >
              Full Aging Report →
            </button>
          </div>

          <div className="space-y-4 text-xs font-mono">
            <div>
              <div className="flex justify-between font-semibold mb-1.5">
                <span className="text-slate-700 dark:text-slate-300 font-sans">
                  Open Receivables Owed by Customers
                </span>
                <span className="text-blue-600 dark:text-blue-400 font-bold tabular-nums">
                  {formatCurrency(totalAr, currency)}
                </span>
              </div>
              <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                <div
                  className="h-full bg-blue-600 rounded transition-all duration-300"
                  style={{ width: `${Math.min(100, (totalAr / (totalAr + totalAp || 1)) * 100)}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between font-semibold mb-1.5">
                <span className="text-slate-700 dark:text-slate-300 font-sans">
                  Open Payables Owed to Suppliers
                </span>
                <span className="text-rose-600 dark:text-rose-400 font-bold tabular-nums">
                  {formatCurrency(totalAp, currency)}
                </span>
              </div>
              <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                <div
                  className="h-full bg-rose-500 rounded transition-all duration-300"
                  style={{ width: `${Math.min(100, (totalAp / (totalAr + totalAp || 1)) * 100)}%` }}
                />
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between font-sans">
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-semibold">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>Net AR − AP Working Capital Delta</span>
              </div>
              <span className="font-mono font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                {formatCurrency(totalAr - totalAp, currency, { showSign: true })}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div>
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2">Top Debtors (AR)</div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {topDebtors.length === 0 ? (
                  <div className="text-slate-600 dark:text-slate-400 py-2">No open receivables</div>
                ) : (
                  topDebtors.map(c => (
                    <div key={c.customerId} className="py-1.5 flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-slate-800 dark:text-slate-200">{c.name}</span>
                      <span className="font-mono font-bold text-brand-700 dark:text-brand-400 tabular-nums shrink-0">
                        {formatCurrency(c.balance, currency)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2">Top Creditors (AP)</div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {topCreditors.length === 0 ? (
                  <div className="text-slate-600 dark:text-slate-400 py-2">No open payables</div>
                ) : (
                  topCreditors.map(v => (
                    <div key={v.vendorId} className="py-1.5 flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-slate-800 dark:text-slate-200">{v.name}</span>
                      <span className="font-mono font-bold text-rose-700 dark:text-rose-400 tabular-nums shrink-0">
                        {formatCurrency(v.balance, currency)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Recent Bank Register Feed */}
        <div className="surface p-6 space-y-5 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h2 className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
                <Landmark className="w-4 h-4 text-emerald-600" />
                <span>Recent Check Register &amp; Bank Feed</span>
              </h2>
              <button
                onClick={() => setCurrentView('banking')}
                className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline whitespace-nowrap"
              >
                Open Register →
              </button>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {recentBankTxns.length === 0 ? (
                <EmptyState
                  title="No posted bank transactions yet"
                  description="Record checks, deposits, or payments in Banking to see activity here."
                  icon={<Landmark className="w-5 h-5" strokeWidth={1.75} />}
                />
              ) : (
                recentBankTxns.map(tx => (
                  <div key={tx.id} className="py-2.5 first:pt-0 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                          tx.amount > 0
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400'
                            : 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400'
                        }`}
                        aria-hidden="true"
                      >
                        {tx.amount > 0 ? <ArrowDownRight className="w-4 h-4" strokeWidth={1.75} /> : <ArrowUpRight className="w-4 h-4" strokeWidth={1.75} />}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-800 dark:text-slate-200 truncate">{tx.payee}</div>
                        <div className="text-[11px] text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                          <span className="font-mono tabular-nums">{tx.date}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono truncate">{tx.refNumber || tx.type}</span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <div
                        className={`font-mono font-bold tabular-nums ${
                          tx.amount > 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-slate-900 dark:text-white'
                        }`}
                      >
                        {formatCurrency(tx.amount, currency, { showSign: true })}
                      </div>
                      <div className="text-[11px] text-slate-600 dark:text-slate-400 font-mono">
                        {tx.cleared ? 'Cleared ✓' : 'Uncleared'}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-bold text-slate-800 dark:text-slate-200">Cash Accounts Summary</div>
              <div className="text-[11px] text-slate-600 dark:text-slate-400 truncate">
                {(overview?.cashAccounts || []).length} active cash/card GL accounts tracked
              </div>
            </div>
            <Button
              variant="emerald"
              size="sm"
              onClick={() => setCurrentView('reconciliation')}
            >
              Reconcile Bank
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};


