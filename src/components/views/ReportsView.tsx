import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import {
  ACCOUNTING_UPDATED_EVENT,
  accountingApi,
  ApiAuditLogRow,
  ApiBalanceSheetReport,
  ApiCashFlowReport,
  ApiGeneralLedgerReport,
  ApiProfitAndLossReport,
  ApiTrialBalanceReport,
} from '../../services/accountingApi';
import { commercialApi } from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';
import {
  Printer,
  Download,
  ShieldCheck,
  BookOpen,
  Scale,
  Copy,
  DollarSign,
  FileText,
  Users,
  Receipt,
  Building2,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Play,
  Trash2,
  Plus,
  Save,
} from 'lucide-react';
import { appDialog } from '../../design-system';
import { Button, InlineAlert, PageHeader, PageShell, StatusBadge, Tabs } from '../common/ui';

type ReportKey =
  | 'pnl'
  | 'balanceSheet'
  | 'cashFlow'
  | 'trialBalance'
  | 'generalLedger'
  | 'aging'
  | 'budgets'
  | 'fx'
  | 'saved'
  | 'audit';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const ReportsView: React.FC = () => {
  const {
    companyProfile,
    setCurrentView,
    setIsJournalEntryOpen,
    setIsReceivePaymentOpen,
    setIsStatementOpen,
    setIsPayBillsOpen,
    setIsEnterBillOpen,
    triggerShortcutNotice,
  } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canExport = hasPermission('reports:export');
  const canReadAudit = hasPermission('audit:read');
  const canWriteBudgets = hasPermission('budgets:write');
  const canWriteAccounts = hasPermission('accounts:write');

  const [activeReport, setActiveReport] = useState<ReportKey>('pnl');
  const [accountingBasis, setAccountingBasis] = useState<'accrual' | 'cash'>('accrual');
  const [excludeAdjusting, setExcludeAdjusting] = useState(false);
  const [hideZero, setHideZero] = useState(false);

  const [startDate, setStartDate] = useState('2026-01-01');
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fiscalYear, setFiscalYear] = useState(() => new Date().getFullYear());

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [pnlReport, setPnlReport] = useState<ApiProfitAndLossReport | null>(null);
  const [bsReport, setBsReport] = useState<ApiBalanceSheetReport | null>(null);
  const [cfReport, setCfReport] = useState<ApiCashFlowReport | null>(null);
  const [tbReport, setTbReport] = useState<ApiTrialBalanceReport | null>(null);
  const [glReport, setGlReport] = useState<ApiGeneralLedgerReport | null>(null);
  const [arAging, setArAging] = useState<any | null>(null);
  const [apAging, setApAging] = useState<any | null>(null);
  const [auditLogs, setAuditLogs] = useState<ApiAuditLogRow[]>([]);

  // Budgets state
  const [budgetRows, setBudgetRows] = useState<any[]>([]);
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});
  const [bvaReport, setBvaReport] = useState<any | null>(null);
  const [savingBudget, setSavingBudget] = useState(false);

  // FX state
  const [fxRates, setFxRates] = useState<any[]>([]);
  const [fxFrom, setFxFrom] = useState('USD');
  const [fxTo, setFxTo] = useState('ZMW');
  const [fxDate, setFxDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fxRateVal, setFxRateVal] = useState('27.50');
  const [savingFx, setSavingFx] = useState(false);

  // Saved Reports state
  const [savedReports, setSavedReports] = useState<any[]>([]);
  const [newSavedName, setNewSavedName] = useState('');
  const [newSavedType, setNewSavedType] = useState('profit_and_loss');
  const [savedRunResult, setSavedRunResult] = useState<{ name: string; output: any } | null>(null);
  const [exportSnapshots, setExportSnapshots] = useState<any[]>([]);

  const fetchActiveReport = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      if (activeReport === 'pnl') {
        const rep = await accountingApi.getProfitAndLoss({
          startDate,
          endDate,
          basis: accountingBasis,
          excludeAdjusting,
          hideZero,
        });
        setPnlReport(rep);
      } else if (activeReport === 'balanceSheet') {
        const rep = await accountingApi.getBalanceSheet({
          asOfDate,
          basis: accountingBasis,
          excludeAdjusting,
          hideZero,
        });
        setBsReport(rep);
      } else if (activeReport === 'cashFlow') {
        const rep = await accountingApi.getCashFlow({ startDate, endDate });
        setCfReport(rep);
      } else if (activeReport === 'trialBalance') {
        const rep = await accountingApi.getTrialBalance({
          startDate,
          endDate,
          basis: accountingBasis,
          excludeAdjusting,
          hideZero,
        });
        setTbReport(rep);
      } else if (activeReport === 'generalLedger') {
        const rep = await accountingApi.getGeneralLedger({
          startDate,
          endDate,
          basis: accountingBasis,
          excludeAdjusting,
        });
        setGlReport(rep);
      } else if (activeReport === 'aging') {
        const [ar, ap] = await Promise.all([
          commercialApi.getArAging(asOfDate),
          commercialApi.getApAging(asOfDate),
        ]);
        setArAging(ar);
        setApAging(ap);
      } else if (activeReport === 'budgets') {
        const [matrix, bva] = await Promise.all([
          commercialApi.getBudgetMatrix(fiscalYear),
          commercialApi.getBudgetVsActual(fiscalYear, 1, 12),
        ]);
        setBudgetRows(matrix.rows || []);
        const draft: Record<string, string> = {};
        for (const r of matrix.rows || []) {
          (r.months || []).forEach((val: number, mIdx: number) => {
            draft[`${r.accountId}-${mIdx + 1}`] = String(val ?? 0);
          });
        }
        setBudgetDraft(draft);
        setBvaReport(bva);
      } else if (activeReport === 'fx') {
        const rates = await commercialApi.listExchangeRates();
        setFxRates(rates);
      } else if (activeReport === 'saved') {
        const [list, snaps] = await Promise.all([
          commercialApi.listSavedReports(),
          commercialApi.listReportExportSnapshots().catch(() => []),
        ]);
        setSavedReports(list);
        setExportSnapshots(snaps);
      } else if (activeReport === 'audit') {
        if (!canReadAudit) {
          setAuditLogs([]);
          setErrorMsg('Audit trail access is restricted to Administrator and Accountant roles.');
        } else {
          const logs = await accountingApi.getAuditLogs(100);
          setAuditLogs(logs);
        }
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to generate financial statement');
    } finally {
      setLoading(false);
    }
  }, [
    activeReport,
    startDate,
    endDate,
    asOfDate,
    fiscalYear,
    accountingBasis,
    excludeAdjusting,
    hideZero,
    canReadAudit,
    activeCompany?.id,
  ]);

  useEffect(() => {
    fetchActiveReport();
  }, [fetchActiveReport]);

  useEffect(() => {
    const handler = () => fetchActiveReport();
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, [fetchActiveReport]);

  const handleSaveBudgets = async () => {
    setSavingBudget(true);
    setErrorMsg(null);
    try {
      const entries: Array<{ accountId: number; fiscalMonth: number; amount: number }> = [];
      for (const row of budgetRows) {
        for (let m = 1; m <= 12; m++) {
          const raw = budgetDraft[`${row.accountId}-${m}`];
          const num = Number(raw || 0);
          if (!Number.isNaN(num)) {
            entries.push({ accountId: row.accountId, fiscalMonth: m, amount: num });
          }
        }
      }
      await commercialApi.saveBudgetEntries(fiscalYear, entries);
      triggerShortcutNotice(`Saved ${fiscalYear} annual budget matrix`);
      await fetchActiveReport();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to save budget matrix');
    } finally {
      setSavingBudget(false);
    }
  };

  const handleSaveFxRate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingFx(true);
    setErrorMsg(null);
    try {
      await commercialApi.upsertExchangeRate({
        fromCurrency: fxFrom.trim().toUpperCase(),
        toCurrency: fxTo.trim().toUpperCase(),
        rateDate: fxDate,
        rate: fxRateVal,
        source: 'manual',
      });
      triggerShortcutNotice(`Saved FX rate ${fxFrom}/${fxTo}`);
      await fetchActiveReport();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to save FX rate');
    } finally {
      setSavingFx(false);
    }
  };

  const handleCreateSavedReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSavedName.trim()) return;
    setErrorMsg(null);
    try {
      await commercialApi.createSavedReport({
        name: newSavedName.trim(),
        reportType: newSavedType,
        parameters: { startDate, endDate, asOfDate, fiscalYear, basis: accountingBasis },
      });
      setNewSavedName('');
      triggerShortcutNotice('Saved report configuration created');
      await fetchActiveReport();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to create saved report');
    }
  };

  const handleRunSavedReport = async (id: number, name: string) => {
    setErrorMsg(null);
    try {
      const res = await commercialApi.runSavedReport(id);
      setSavedRunResult({ name, output: res.output ?? res });
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to run saved report');
    }
  };

  const handleDeleteSavedReport = async (id: number) => {
    setErrorMsg(null);
    try {
      await commercialApi.deleteSavedReport(id);
      await fetchActiveReport();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to delete saved report');
    }
  };

  const handleExportCsv = async () => {
    if (!canExport) {
      setErrorMsg('CSV export permission is restricted for your active role.');
      return;
    }
    try {
      if (activeReport === 'pnl') {
        await accountingApi.downloadReportCsv('profit-and-loss', {
          startDate,
          endDate,
          basis: accountingBasis,
          excludeAdjusting,
          hideZero,
        });
      } else if (activeReport === 'balanceSheet') {
        await accountingApi.downloadReportCsv('balance-sheet', {
          asOfDate,
          basis: accountingBasis,
          excludeAdjusting,
          hideZero,
        });
      } else if (activeReport === 'cashFlow') {
        await accountingApi.downloadReportCsv('cash-flow', { startDate, endDate });
      } else if (activeReport === 'trialBalance') {
        await accountingApi.downloadReportCsv('trial-balance', {
          startDate,
          endDate,
          basis: accountingBasis,
          excludeAdjusting,
          hideZero,
        });
      } else {
        triggerShortcutNotice('Use Profit & Loss, Balance Sheet, Cash Flow, or Trial Balance for CSV export');
        return;
      }
      triggerShortcutNotice('Audit-logged CSV report downloaded');
    } catch (err: any) {
      setErrorMsg(err?.message || 'CSV export failed');
    }
  };

  const buildReportActionContext = (record: any, pendingId?: string | null): ActionEligibilityContext<any> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'reports',
    entityType: 'report',
    record,
    recordStatus: record?.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const renderTrialBalanceActions = (r: any) => {
    const defs: AdvancedActionDefinition<any>[] = [
      { id: 'inspect-coa', label: 'Inspect in Chart of Accounts', icon: <BookOpen className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Account', requiredPermission: 'accounting:read', execute: async () => setCurrentView('accounts') },
      { id: 'journal-entry', label: 'Post Journal Entry', icon: <Scale className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Account', requiredPermission: 'accounting:write', execute: async () => setIsJournalEntryOpen(true) },
      { id: 'copy-balance', label: 'Copy Row Balance', icon: <Copy className="w-3.5 h-3.5" />, group: 'admin', groupLabel: 'Other', requiredPermission: 'accounting:read', execute: async () => { const bal = r.debitNum > 0 ? r.debitNum : r.creditNum; await navigator.clipboard?.writeText(`${r.accountCode || ''} ${r.accountName}: ${formatCurrency(bal, currency)}`.trim()); triggerShortcutNotice(`Copied ${r.accountName} balance`); } },
    ];
    const ctx = buildReportActionContext(r, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for account ${r.accountCode || r.accountName}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={r.accountCode || r.accountName}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => { const def = action.definition; if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) }); }}
      />
    );
  };

  const renderArAgingActions = (c: any) => {
    const defs: AdvancedActionDefinition<any>[] = [
      { id: 'receive-payment', label: 'Receive Payment', icon: <DollarSign className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Customer', requiredPermission: 'payments:write', execute: async () => setIsReceivePaymentOpen(true) },
      { id: 'statement', label: 'Print Customer Statement', icon: <FileText className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Customer', requiredPermission: 'reports:read', execute: async () => setIsStatementOpen(true) },
      { id: 'customer-center', label: 'Open Customer Center', icon: <Users className="w-3.5 h-3.5" />, group: 'view', groupLabel: 'Customer', requiredPermission: 'customers:read', execute: async () => setCurrentView('customers') },
    ];
    const ctx = buildReportActionContext(c, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for ${c.customerName}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={c.customerId || c.customerName}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => { const def = action.definition; if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) }); }}
      />
    );
  };

  const renderApAgingActions = (v: any) => {
    const defs: AdvancedActionDefinition<any>[] = [
      { id: 'pay-bills', label: 'Pay Bills', icon: <DollarSign className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Vendor', requiredPermission: 'payments:write', execute: async () => setIsPayBillsOpen(true) },
      { id: 'enter-bill', label: 'Enter Bill', icon: <Receipt className="w-3.5 h-3.5 text-amber-600" />, group: 'process', groupLabel: 'Vendor', requiredPermission: 'bills:write', execute: async () => setIsEnterBillOpen(true) },
      { id: 'vendor-center', label: 'Open Vendor Center', icon: <Building2 className="w-3.5 h-3.5" />, group: 'view', groupLabel: 'Vendor', requiredPermission: 'vendors:read', execute: async () => setCurrentView('vendors') },
    ];
    const ctx = buildReportActionContext(v, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for ${v.vendorName}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={v.vendorId || v.vendorName}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => { const def = action.definition; if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) }); }}
      />
    );
  };

  return (
    <PageShell>
      <PageHeader
        title="Financial Report Center"
        subtitle="PostgreSQL-backed statements with exact decimal arithmetic, accrual/cash basis, and period reconciliation."
        icon={<BookOpen className="w-5 h-5" strokeWidth={1.75} />}
        actions={
          <>
            <div className="inline-flex items-center p-1 rounded-lg bg-slate-100/80 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.08] text-xs font-semibold">
              <button
                type="button"
                onClick={() => setAccountingBasis('accrual')}
                className={`px-3 py-1 rounded-md whitespace-nowrap shrink-0 transition-colors ${
                  accountingBasis === 'accrual'
                    ? 'bg-brand-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Accrual Basis
              </button>
              <button
                type="button"
                onClick={() => setAccountingBasis('cash')}
                className={`px-3 py-1 rounded-md whitespace-nowrap shrink-0 transition-colors ${
                  accountingBasis === 'cash'
                    ? 'bg-brand-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Cash Basis
              </button>
            </div>

            {canExport && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleExportCsv}
                icon={<Download className="w-3.5 h-3.5" />}
              >
                Export CSV
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => window.print()}
              icon={<Printer className="w-3.5 h-3.5" />}
            >
              Print Report
            </Button>
          </>
        }
      />

      {/* Reports Selection Strip */}
      <Tabs
        ariaLabel="Financial report types"
        value={activeReport}
        onChange={(id) => setActiveReport(id as ReportKey)}
        tabs={[
          { id: 'pnl', label: 'Profit & Loss' },
          { id: 'balanceSheet', label: 'Balance Sheet' },
          { id: 'cashFlow', label: 'Statement of Cash Flows' },
          { id: 'trialBalance', label: 'Trial Balance' },
          { id: 'generalLedger', label: 'General Ledger' },
          { id: 'aging', label: 'A/R & A/P Aging' },
          { id: 'budgets', label: 'Budgets & Variance' },
          { id: 'fx', label: 'Foreign Exchange' },
          { id: 'saved', label: 'Saved Reports' },
          { id: 'audit', label: 'Audit Trail' },
        ]}
      />

      {/* Date Range & Filter Controls */}
      {activeReport !== 'audit' && activeReport !== 'fx' && activeReport !== 'saved' && (
        <div className="surface p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            {activeReport === 'balanceSheet' || activeReport === 'aging' ? (
              <div className="flex items-center gap-2">
                <label className="font-semibold text-slate-600 dark:text-slate-300">As Of Date:</label>
                <input
                  type="date"
                  value={asOfDate}
                  onChange={e => setAsOfDate(e.target.value)}
                  className="app-input app-input-mono !w-auto !py-1"
                />
              </div>
            ) : activeReport === 'budgets' ? (
              <div className="flex items-center gap-2">
                <label className="font-semibold text-slate-600 dark:text-slate-300">Fiscal Year:</label>
                <input
                  type="number"
                  value={fiscalYear}
                  onChange={e => setFiscalYear(Number(e.target.value) || 2026)}
                  className="app-input app-input-mono !w-24 !py-1"
                />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <label className="font-semibold text-slate-600 dark:text-slate-300">From:</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    className="app-input app-input-mono !w-auto !py-1"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="font-semibold text-slate-600 dark:text-slate-300">To:</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    className="app-input app-input-mono !w-auto !py-1"
                  />
                </div>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {activeReport !== 'cashFlow' && activeReport !== 'aging' && activeReport !== 'budgets' && (
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={excludeAdjusting}
                  onChange={e => setExcludeAdjusting(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Exclude Adjusting Entries</span>
              </label>
            )}
            {activeReport !== 'cashFlow' && activeReport !== 'generalLedger' && activeReport !== 'aging' && activeReport !== 'budgets' && (
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={hideZero}
                  onChange={e => setHideZero(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Hide Zero Balances</span>
              </label>
            )}
          </div>
        </div>
      )}

      {errorMsg && (
        <InlineAlert tone="error" onDismiss={() => setErrorMsg(null)}>
          <span>
            {errorMsg}
            {(pnlReport || bsReport || tbReport || glReport) && (
              <span className="ml-1 font-semibold">
                Showing the previously loaded statement — it may be out of date.
              </span>
            )}
          </span>
        </InlineAlert>
      )}

      {/* REPORT PAPER CONTAINER */}
      <div className="bg-white text-slate-900 rounded-xl border border-slate-300 shadow-sm p-7 max-w-6xl mx-auto space-y-6 text-xs font-sans print:border-none print:shadow-none">
        <div className="text-center border-b pb-4 space-y-1">
          <h2 className="text-lg font-black uppercase text-slate-900 tracking-tight">
            {activeCompany?.name || companyProfile.legalName}
          </h2>
          <div className="text-base font-bold text-blue-900 uppercase">
            {activeReport === 'pnl' && 'Profit & Loss Statement'}
            {activeReport === 'balanceSheet' && 'Balance Sheet'}
            {activeReport === 'cashFlow' && 'Statement of Cash Flows (Indirect Method)'}
            {activeReport === 'trialBalance' && 'Trial Balance'}
            {activeReport === 'generalLedger' && 'General Ledger Detail'}
            {activeReport === 'aging' && 'Accounts Receivable & Accounts Payable Aging'}
            {activeReport === 'budgets' && `Annual Budget Matrix & Budget vs. Actual (${fiscalYear})`}
            {activeReport === 'fx' && 'Foreign Currency Exchange Rates'}
            {activeReport === 'saved' && 'Saved Reports & Scheduled Configurations'}
            {activeReport === 'audit' && 'Cryptographic Tamper-Evident Audit Trail'}
          </div>
          <div className="text-slate-500 text-xs font-mono">
            {activeReport === 'balanceSheet' || activeReport === 'aging'
              ? `As of ${asOfDate}`
              : activeReport === 'budgets'
              ? `Fiscal Year ${fiscalYear}`
              : `${startDate} to ${endDate}`}{' '}
            · Basis: <strong className="text-blue-900">{accountingBasis.toUpperCase()}</strong>
            {excludeAdjusting ? ' · Unadjusted' : ''} · Currency: {currency}
          </div>
        </div>

        {loading && (
          <div className="py-10 flex items-center justify-center gap-2 text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Computing ledger statement...</span>
          </div>
        )}

        {/* 1. PROFIT & LOSS */}
        {!loading && activeReport === 'pnl' && pnlReport && (
          <div className="space-y-4 font-mono text-xs">
            <div>
              <div className="font-bold text-xs uppercase text-slate-800 bg-slate-100 p-2 font-sans">
                Operating Income
              </div>
              <div className="divide-y divide-slate-100 p-2 space-y-1">
                {pnlReport.sections.income.length === 0 && (
                  <div className="py-1 pl-4 text-slate-400 font-sans">No operating revenue in period</div>
                )}
                {pnlReport.sections.income.map(a => (
                  <div key={a.accountId ?? a.accountName} className="flex justify-between py-1">
                    <span className="font-sans text-slate-700 pl-4">
                      {a.accountCode ? `${a.accountCode} - ` : ''}
                      {a.accountPath}
                    </span>
                    <span className="tabular-nums font-semibold">{formatCurrency(a.amountNum, currency)}</span>
                  </div>
                ))}
                <div className="flex justify-between pt-2 font-bold border-t border-slate-400">
                  <span className="font-sans pl-4">Total Operating Income</span>
                  <span className="tabular-nums">
                    {formatCurrency(pnlReport.totals.totalOperatingIncomeNum, currency)}
                  </span>
                </div>
              </div>
            </div>

            <div>
              <div className="font-bold text-xs uppercase text-slate-800 bg-slate-100 p-2 font-sans">
                Cost of Goods Sold
              </div>
              <div className="divide-y divide-slate-100 p-2 space-y-1">
                {pnlReport.sections.cogs.length === 0 && (
                  <div className="py-1 pl-4 text-slate-400 font-sans">No COGS posted in period</div>
                )}
                {pnlReport.sections.cogs.map(a => (
                  <div key={a.accountId ?? a.accountName} className="flex justify-between py-1">
                    <span className="font-sans text-slate-700 pl-4">
                      {a.accountCode ? `${a.accountCode} - ` : ''}
                      {a.accountPath}
                    </span>
                    <span className="tabular-nums font-semibold">{formatCurrency(a.amountNum, currency)}</span>
                  </div>
                ))}
                <div className="flex justify-between pt-2 font-bold border-t border-slate-400">
                  <span className="font-sans pl-4">Total Cost of Goods Sold</span>
                  <span className="tabular-nums">{formatCurrency(pnlReport.totals.totalCogsNum, currency)}</span>
                </div>
              </div>
            </div>

            <div className="p-3 bg-blue-50 border border-blue-200 flex justify-between font-bold text-sm">
              <span className="font-sans">GROSS PROFIT</span>
              <span className="tabular-nums text-blue-900">
                {formatCurrency(pnlReport.totals.operatingGrossProfitNum, currency)}
              </span>
            </div>

            <div>
              <div className="font-bold text-xs uppercase text-slate-800 bg-slate-100 p-2 font-sans">
                Operating Expenses
              </div>
              <div className="divide-y divide-slate-100 p-2 space-y-1">
                {pnlReport.sections.expenses.length === 0 && (
                  <div className="py-1 pl-4 text-slate-400 font-sans">No operating expenses posted in period</div>
                )}
                {pnlReport.sections.expenses.map(a => (
                  <div key={a.accountId ?? a.accountName} className="flex justify-between py-1">
                    <span className="font-sans text-slate-700 pl-4">
                      {a.accountCode ? `${a.accountCode} - ` : ''}
                      {a.accountPath}
                    </span>
                    <span className="tabular-nums font-semibold">{formatCurrency(a.amountNum, currency)}</span>
                  </div>
                ))}
                <div className="flex justify-between pt-2 font-bold border-t border-slate-400">
                  <span className="font-sans pl-4">Total Operating Expenses</span>
                  <span className="tabular-nums">
                    {formatCurrency(pnlReport.totals.totalOperatingExpensesNum, currency)}
                  </span>
                </div>
              </div>
            </div>

            <div className="p-3 bg-slate-100 border border-slate-300 flex justify-between font-bold text-sm">
              <span className="font-sans">NET OPERATING INCOME</span>
              <span className="tabular-nums">
                {formatCurrency(pnlReport.totals.netOperatingIncomeNum, currency)}
              </span>
            </div>

            {pnlReport.hasOther && (
              <div>
                <div className="font-bold text-xs uppercase text-slate-800 bg-slate-100 p-2 font-sans">
                  Other Income & Expense
                </div>
                <div className="divide-y divide-slate-100 p-2 space-y-1">
                  {pnlReport.sections.otherIncome.map(a => (
                    <div key={`oi-${a.accountId}`} className="flex justify-between py-1">
                      <span className="font-sans text-slate-700 pl-4">
                        {a.accountCode ? `${a.accountCode} - ` : ''}
                        {a.accountPath}
                      </span>
                      <span className="tabular-nums font-semibold text-emerald-700">
                        {formatCurrency(a.amountNum, currency)}
                      </span>
                    </div>
                  ))}
                  {pnlReport.sections.otherExpense.map(a => (
                    <div key={`oe-${a.accountId}`} className="flex justify-between py-1">
                      <span className="font-sans text-slate-700 pl-4">
                        {a.accountCode ? `${a.accountCode} - ` : ''}
                        {a.accountPath}
                      </span>
                      <span className="tabular-nums font-semibold text-rose-700">
                        {formatCurrency(-a.amountNum, currency)}
                      </span>
                    </div>
                  ))}
                  <div className="flex justify-between pt-2 font-bold border-t border-slate-400">
                    <span className="font-sans pl-4">Net Other Income</span>
                    <span className="tabular-nums">{formatCurrency(pnlReport.totals.netOtherIncomeNum, currency)}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="p-4 bg-emerald-50 border-2 border-emerald-400 rounded-lg flex justify-between font-black text-base text-emerald-950">
              <span className="font-sans">NET INCOME</span>
              <span className="tabular-nums">{formatCurrency(pnlReport.totals.netIncomeNum, currency)}</span>
            </div>
          </div>
        )}

        {/* 2. BALANCE SHEET */}
        {!loading && activeReport === 'balanceSheet' && bsReport && (
          <div className="space-y-4 font-mono text-xs">
            <div>
              <div className="font-bold text-xs uppercase text-slate-800 bg-slate-100 p-2 font-sans">Assets</div>
              <div className="p-2 space-y-2">
                <div className="font-bold font-sans text-slate-600 pl-2">Current Assets</div>
                {bsReport.groups.currentAssets.map(a => (
                  <div key={a.accountId ?? a.accountName} className="flex justify-between pl-6 py-0.5">
                    <span className="font-sans text-slate-700">
                      {a.accountCode ? `${a.accountCode} - ` : ''}
                      {a.accountPath}
                    </span>
                    <span className="tabular-nums font-semibold">{formatCurrency(a.amountNum, currency)}</span>
                  </div>
                ))}

                {bsReport.groups.fixedAssets.length > 0 && (
                  <>
                    <div className="font-bold font-sans text-slate-600 pl-2 pt-2">Fixed Assets</div>
                    {bsReport.groups.fixedAssets.map(a => (
                      <div key={a.accountId ?? a.accountName} className="flex justify-between pl-6 py-0.5">
                        <span className="font-sans text-slate-700">
                          {a.accountCode ? `${a.accountCode} - ` : ''}
                          {a.accountPath}
                        </span>
                        <span className="tabular-nums font-semibold">{formatCurrency(a.amountNum, currency)}</span>
                      </div>
                    ))}
                  </>
                )}

                {bsReport.groups.otherAssets.length > 0 && (
                  <>
                    <div className="font-bold font-sans text-slate-600 pl-2 pt-2">Other Assets</div>
                    {bsReport.groups.otherAssets.map(a => (
                      <div key={a.accountId ?? a.accountName} className="flex justify-between pl-6 py-0.5">
                        <span className="font-sans text-slate-700">
                          {a.accountCode ? `${a.accountCode} - ` : ''}
                          {a.accountPath}
                        </span>
                        <span className="tabular-nums font-semibold">{formatCurrency(a.amountNum, currency)}</span>
                      </div>
                    ))}
                  </>
                )}

                <div className="flex justify-between pt-3 font-bold text-sm border-t border-slate-400">
                  <span className="font-sans">TOTAL ASSETS</span>
                  <span className="tabular-nums text-blue-900">
                    {formatCurrency(bsReport.totals.totalAssetsNum, currency)}
                  </span>
                </div>
              </div>
            </div>

            <div>
              <div className="font-bold text-xs uppercase text-slate-800 bg-slate-100 p-2 font-sans">Liabilities</div>
              <div className="p-2 space-y-1">
                <div className="font-bold font-sans text-slate-600 pl-2">Current Liabilities</div>
                {bsReport.groups.currentLiabilities.map(a => (
                  <div key={a.accountId ?? a.accountName} className="flex justify-between pl-6 py-0.5">
                    <span className="font-sans text-slate-700">
                      {a.accountCode ? `${a.accountCode} - ` : ''}
                      {a.accountPath}
                    </span>
                    <span className="tabular-nums font-semibold">{formatCurrency(a.amountNum, currency)}</span>
                  </div>
                ))}

                {bsReport.groups.longTermLiabilities.length > 0 && (
                  <>
                    <div className="font-bold font-sans text-slate-600 pl-2 pt-2">Long-Term Liabilities</div>
                    {bsReport.groups.longTermLiabilities.map(a => (
                      <div key={a.accountId ?? a.accountName} className="flex justify-between pl-6 py-0.5">
                        <span className="font-sans text-slate-700">
                          {a.accountCode ? `${a.accountCode} - ` : ''}
                          {a.accountPath}
                        </span>
                        <span className="tabular-nums font-semibold">{formatCurrency(a.amountNum, currency)}</span>
                      </div>
                    ))}
                  </>
                )}

                <div className="flex justify-between pt-2 font-bold border-t border-slate-400">
                  <span className="font-sans">Total Liabilities</span>
                  <span className="tabular-nums">{formatCurrency(bsReport.totals.totalLiabilitiesNum, currency)}</span>
                </div>
              </div>
            </div>

            <div>
              <div className="font-bold text-xs uppercase text-slate-800 bg-slate-100 p-2 font-sans">Equity</div>
              <div className="p-2 space-y-1">
                {bsReport.groups.equity.map((a, idx) => (
                  <div
                    key={a.accountId ?? `syn-${a.syntheticLine}-${idx}`}
                    className={`flex justify-between pl-6 py-0.5 ${
                      a.syntheticLine ? 'font-bold text-blue-800' : ''
                    }`}
                  >
                    <span className="font-sans">
                      {a.accountCode ? `${a.accountCode} - ` : ''}
                      {a.accountPath}
                    </span>
                    <span className="tabular-nums font-semibold">{formatCurrency(a.amountNum, currency)}</span>
                  </div>
                ))}
                <div className="flex justify-between pt-2 font-bold border-t border-slate-400">
                  <span className="font-sans">Total Equity</span>
                  <span className="tabular-nums">{formatCurrency(bsReport.totals.totalEquityNum, currency)}</span>
                </div>
              </div>
            </div>

            <div
              className={`p-4 rounded-lg flex flex-wrap items-center justify-between gap-2 font-black text-base border-2 ${
                bsReport.totals.isBalanced
                  ? 'bg-emerald-50 border-emerald-400 text-emerald-950'
                  : 'bg-rose-50 border-rose-400 text-rose-950'
              }`}
            >
              <span className="font-sans flex items-center gap-2">
                {bsReport.totals.isBalanced ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-rose-600" />
                )}
                TOTAL LIABILITIES & EQUITY
              </span>
              <span className="tabular-nums">
                {formatCurrency(bsReport.totals.totalLiabilitiesAndEquityNum, currency)}
              </span>
            </div>
          </div>
        )}

        {/* 3. STATEMENT OF CASH FLOWS (INDIRECT METHOD) */}
        {!loading && activeReport === 'cashFlow' && cfReport && (
          <div className="space-y-4 font-mono text-xs">
            <div>
              <div className="font-bold text-xs uppercase text-slate-800 bg-slate-100 p-2 font-sans">
                Operating Activities
              </div>
              <div className="p-3 space-y-1.5">
                {cfReport.operating.map((row, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span className="font-sans text-slate-700">
                      {row.accountCode ? `${row.accountCode} - ` : ''}
                      {row.accountName}
                    </span>
                    <span className="tabular-nums font-semibold">
                      {formatCurrency(row.amountNum, currency, { showSign: true })}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between pt-2 border-t border-slate-300 font-bold">
                  <span className="font-sans">Net Cash Provided by Operating Activities</span>
                  <span className="tabular-nums">
                    {formatCurrency(cfReport.totalOperatingNum, currency, { showSign: true })}
                  </span>
                </div>
              </div>
            </div>

            <div>
              <div className="font-bold text-xs uppercase text-slate-800 bg-slate-100 p-2 font-sans">
                Investing Activities
              </div>
              <div className="p-3 space-y-1.5">
                {cfReport.investing.length === 0 ? (
                  <div className="text-slate-400 font-sans">No investing cash flows in period</div>
                ) : (
                  cfReport.investing.map((row, idx) => (
                    <div key={idx} className="flex justify-between">
                      <span className="font-sans text-slate-700">
                        {row.accountCode ? `${row.accountCode} - ` : ''}
                        {row.accountName}
                      </span>
                      <span className="tabular-nums font-semibold">
                        {formatCurrency(row.amountNum, currency, { showSign: true })}
                      </span>
                    </div>
                  ))
                )}
                <div className="flex justify-between pt-2 border-t border-slate-300 font-bold">
                  <span className="font-sans">Net Cash Used in Investing Activities</span>
                  <span className="tabular-nums">
                    {formatCurrency(cfReport.totalInvestingNum, currency, { showSign: true })}
                  </span>
                </div>
              </div>
            </div>

            <div>
              <div className="font-bold text-xs uppercase text-slate-800 bg-slate-100 p-2 font-sans">
                Financing Activities
              </div>
              <div className="p-3 space-y-1.5">
                {cfReport.financing.length === 0 ? (
                  <div className="text-slate-400 font-sans">No financing cash flows in period</div>
                ) : (
                  cfReport.financing.map((row, idx) => (
                    <div key={idx} className="flex justify-between">
                      <span className="font-sans text-slate-700">
                        {row.accountCode ? `${row.accountCode} - ` : ''}
                        {row.accountName}
                      </span>
                      <span className="tabular-nums font-semibold">
                        {formatCurrency(row.amountNum, currency, { showSign: true })}
                      </span>
                    </div>
                  ))
                )}
                <div className="flex justify-between pt-2 border-t border-slate-300 font-bold">
                  <span className="font-sans">Net Cash Provided by Financing Activities</span>
                  <span className="tabular-nums">
                    {formatCurrency(cfReport.totalFinancingNum, currency, { showSign: true })}
                  </span>
                </div>
              </div>
            </div>

            <div className="p-4 rounded-lg bg-emerald-50 border-2 border-emerald-400 space-y-1.5 text-emerald-950">
              <div className="flex justify-between">
                <span className="font-sans font-semibold">Net Change in Cash</span>
                <span className="tabular-nums font-bold">
                  {formatCurrency(cfReport.netChangeNum, currency, { showSign: true })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-sans font-semibold">Beginning Cash Balance</span>
                <span className="tabular-nums font-bold">{formatCurrency(cfReport.beginningCashNum, currency)}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-emerald-300 text-sm font-black">
                <span className="font-sans flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  Ending Cash Balance
                </span>
                <span className="tabular-nums">{formatCurrency(cfReport.endingCashNum, currency)}</span>
              </div>
            </div>
          </div>
        )}

        {/* 4. TRIAL BALANCE */}
        {!loading && activeReport === 'trialBalance' && tbReport && (
          <div className="space-y-4">
            <table className="w-full text-left text-xs border border-slate-300">
              <thead className="bg-slate-100 text-slate-700 font-bold text-[10px] uppercase border-b border-slate-300">
                <tr>
                  <th className="p-2 border-r">CODE</th>
                  <th className="p-2 border-r">ACCOUNT NAME</th>
                  <th className="p-2 border-r">TYPE</th>
                  <th className="p-2 text-right border-r w-28">DEBIT ({currency})</th>
                  <th className="p-2 text-right border-r w-28">CREDIT ({currency})</th>
                  <th className="p-2 text-right w-16 no-print">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 font-mono">
                {tbReport.rows.map((r, idx) => (
                  <tr key={r.accountId ?? `derived-${idx}`} className="hover:bg-slate-50">
                    <td className="p-2 font-bold text-slate-500 border-r">{r.accountCode || '—'}</td>
                    <td className="p-2 font-sans font-semibold text-slate-900 border-r">{r.accountPath}</td>
                    <td className="p-2 font-sans text-slate-500 text-[11px] border-r">{r.accountType}</td>
                    <td className="p-2 text-right border-r font-bold tabular-nums">
                      {r.debitNum > 0 ? formatCurrency(r.debitNum, currency) : '—'}
                    </td>
                    <td className="p-2 text-right border-r font-bold tabular-nums">
                      {r.creditNum > 0 ? formatCurrency(r.creditNum, currency) : '—'}
                    </td>
                    <td className="p-2 text-right font-sans no-print">
                      {renderTrialBalanceActions(r)}
                    </td>
                  </tr>
                ))}
                <tr className="bg-slate-100 font-bold border-t-2 border-slate-900 text-sm">
                  <td colSpan={3} className="p-2 font-sans uppercase">
                    Trial Balance Totals ({tbReport.isBalanced ? 'Balanced' : 'Unbalanced'})
                  </td>
                  <td className="p-2 text-right border-r tabular-nums text-blue-900">
                    {formatCurrency(tbReport.totalDebitNum, currency)}
                  </td>
                  <td className="p-2 text-right border-r tabular-nums text-blue-900">
                    {formatCurrency(tbReport.totalCreditNum, currency)}
                  </td>
                  <td className="p-2 no-print" />
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* 5. GENERAL LEDGER DETAIL */}
        {!loading && activeReport === 'generalLedger' && glReport && (
          <div className="space-y-5">
            {glReport.accounts.length === 0 ? (
              <div className="py-8 text-center text-slate-400">No posted ledger lines in selected period.</div>
            ) : (
              glReport.accounts.map(sec => (
                <div key={sec.accountId} className="border border-slate-300 rounded-lg overflow-hidden">
                  <div className="bg-slate-100 px-3 py-2 flex flex-wrap items-center justify-between gap-2 border-b border-slate-300">
                    <span className="font-bold text-slate-900">
                      {sec.accountCode ? `${sec.accountCode} - ` : ''}
                      {sec.accountPath}
                    </span>
                    <span className="font-mono text-[11px] text-slate-600 tabular-nums">
                      Opening: {formatCurrency(sec.openingBalanceNum, currency)} · Closing:{' '}
                      <strong>{formatCurrency(sec.closingBalanceNum, currency)}</strong>
                    </span>
                  </div>
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-[10px] uppercase text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="p-2">DATE</th>
                        <th className="p-2">ENTRY #</th>
                        <th className="p-2">DESCRIPTION</th>
                        <th className="p-2 text-right">DEBIT</th>
                        <th className="p-2 text-right">CREDIT</th>
                        <th className="p-2 text-right">RUNNING BAL</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono">
                      {sec.entries.map(e => (
                        <tr key={e.lineId} className={e.voided ? 'opacity-60' : ''}>
                          <td className="p-2 whitespace-nowrap">{e.txnDate}</td>
                          <td className="p-2 whitespace-nowrap">{e.entryNumber}</td>
                          <td className="p-2 font-sans text-slate-800">{e.description}</td>
                          <td className="p-2 text-right tabular-nums">
                            {e.debitNum > 0 ? formatCurrency(e.debitNum, currency) : '—'}
                          </td>
                          <td className="p-2 text-right tabular-nums">
                            {e.creditNum > 0 ? formatCurrency(e.creditNum, currency) : '—'}
                          </td>
                          <td className="p-2 text-right font-bold tabular-nums">
                            {formatCurrency(e.runningBalanceNum, currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </div>
        )}

        {/* 6. LIVE POSTGRESQL AGING REPORT */}
        {!loading && activeReport === 'aging' && (
          <div className="space-y-6">
            <div>
              <h3 className="font-bold text-xs uppercase tracking-wider mb-2 text-blue-900">
                Accounts Receivable Aging Summary (As of {arAging?.asOfDate || asOfDate})
              </h3>
              <table className="w-full text-left text-xs border border-slate-300">
                <thead className="bg-slate-100 font-bold text-[10px] uppercase">
                  <tr>
                    <th className="p-2 border-r">CUSTOMER</th>
                    <th className="p-2 text-right border-r">CURRENT</th>
                    <th className="p-2 text-right border-r">1 - 30 DAYS</th>
                    <th className="p-2 text-right border-r">31 - 60 DAYS</th>
                    <th className="p-2 text-right border-r">61 - 90 DAYS</th>
                    <th className="p-2 text-right border-r">&gt; 90 DAYS</th>
                    <th className="p-2 text-right border-r">TOTAL DUE</th>
                    <th className="p-2 text-right w-16 no-print">ACTIONS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 font-mono">
                  {(arAging?.customers || []).length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-4 text-center text-slate-400 font-sans">
                        No open customer receivables as of {asOfDate}.
                      </td>
                    </tr>
                  ) : (
                    (arAging?.customers || []).map((c: any) => (
                      <tr key={c.customerId}>
                        <td className="p-2 font-sans font-semibold border-r">{c.customerName}</td>
                        <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(c.current || 0), currency)}</td>
                        <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(c.days1To30 || 0), currency)}</td>
                        <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(c.days31To60 || 0), currency)}</td>
                        <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(c.days61To90 || 0), currency)}</td>
                        <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(c.daysOver90 || 0), currency)}</td>
                        <td className="p-2 text-right border-r font-bold text-blue-700 tabular-nums">
                          {formatCurrency(Number(c.total || 0), currency)}
                        </td>
                        <td className="p-2 text-right font-sans no-print">
                          {renderArAgingActions(c)}
                        </td>
                      </tr>
                    ))
                  )}
                  {arAging?.totals && (
                    <tr className="bg-slate-100 font-bold border-t-2 border-slate-900">
                      <td className="p-2 font-sans border-r">TOTAL RECEIVABLES</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(arAging.totals.current || 0), currency)}</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(arAging.totals.days1To30 || 0), currency)}</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(arAging.totals.days31To60 || 0), currency)}</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(arAging.totals.days61To90 || 0), currency)}</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(arAging.totals.daysOver90 || 0), currency)}</td>
                      <td className="p-2 text-right border-r text-blue-900 tabular-nums">{formatCurrency(Number(arAging.totals.total || 0), currency)}</td>
                      <td className="p-2 no-print" />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="font-bold text-xs uppercase tracking-wider mb-2 text-rose-900">
                Accounts Payable Aging Summary (As of {apAging?.asOfDate || asOfDate})
              </h3>
              <table className="w-full text-left text-xs border border-slate-300">
                <thead className="bg-slate-100 font-bold text-[10px] uppercase">
                  <tr>
                    <th className="p-2 border-r">VENDOR</th>
                    <th className="p-2 text-right border-r">CURRENT</th>
                    <th className="p-2 text-right border-r">1 - 30 DAYS</th>
                    <th className="p-2 text-right border-r">31 - 60 DAYS</th>
                    <th className="p-2 text-right border-r">61 - 90 DAYS</th>
                    <th className="p-2 text-right border-r">&gt; 90 DAYS</th>
                    <th className="p-2 text-right border-r">TOTAL PAYABLE</th>
                    <th className="p-2 text-right w-16 no-print">ACTIONS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 font-mono">
                  {(apAging?.vendors || []).length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-4 text-center text-slate-400 font-sans">
                        No open vendor payables as of {asOfDate}.
                      </td>
                    </tr>
                  ) : (
                    (apAging?.vendors || []).map((v: any) => (
                      <tr key={v.vendorId}>
                        <td className="p-2 font-sans font-semibold border-r">{v.vendorName}</td>
                        <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(v.current || 0), currency)}</td>
                        <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(v.days1To30 || 0), currency)}</td>
                        <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(v.days31To60 || 0), currency)}</td>
                        <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(v.days61To90 || 0), currency)}</td>
                        <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(v.daysOver90 || 0), currency)}</td>
                        <td className="p-2 text-right border-r font-bold text-rose-700 tabular-nums">
                          {formatCurrency(Number(v.total || 0), currency)}
                        </td>
                        <td className="p-2 text-right font-sans no-print">
                          {renderApAgingActions(v)}
                        </td>
                      </tr>
                    ))
                  )}
                  {apAging?.totals && (
                    <tr className="bg-slate-100 font-bold border-t-2 border-slate-900">
                      <td className="p-2 font-sans border-r">TOTAL PAYABLES</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(apAging.totals.current || 0), currency)}</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(apAging.totals.days1To30 || 0), currency)}</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(apAging.totals.days31To60 || 0), currency)}</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(apAging.totals.days61To90 || 0), currency)}</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(apAging.totals.daysOver90 || 0), currency)}</td>
                      <td className="p-2 text-right border-r text-rose-900 tabular-nums">{formatCurrency(Number(apAging.totals.total || 0), currency)}</td>
                      <td className="p-2 no-print" />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 6b. BUDGETS & VARIANCE */}
        {!loading && activeReport === 'budgets' && (
          <div className="space-y-6">
            {bvaReport?.summary && (
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="text-[10px] font-bold uppercase text-slate-500">Revenue (Budget vs Actual)</div>
                  <div className="font-mono font-bold text-sm mt-1 tabular-nums">
                    {formatCurrency(Number(bvaReport.summary.actualRevenue || 0), currency)} /{' '}
                    <span className="text-slate-500">{formatCurrency(Number(bvaReport.summary.budgetedRevenue || 0), currency)}</span>
                  </div>
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="text-[10px] font-bold uppercase text-slate-500">Expenses (Actual vs Budget)</div>
                  <div className="font-mono font-bold text-sm mt-1 tabular-nums">
                    {formatCurrency(Number(bvaReport.summary.actualExpenses || 0), currency)} /{' '}
                    <span className="text-slate-500">{formatCurrency(Number(bvaReport.summary.budgetedExpenses || 0), currency)}</span>
                  </div>
                </div>
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="text-[10px] font-bold uppercase text-blue-700">Net Income (Actual vs Budget)</div>
                  <div className="font-mono font-bold text-sm mt-1 text-blue-900 tabular-nums">
                    {formatCurrency(Number(bvaReport.summary.actualNetIncome || 0), currency)} /{' '}
                    <span className="text-blue-600">{formatCurrency(Number(bvaReport.summary.budgetedNetIncome || 0), currency)}</span>
                  </div>
                </div>
              </div>
            )}

            <div>
              <h3 className="font-bold text-xs uppercase tracking-wider mb-2 text-slate-800">
                Budget vs. Actual Variance Report ({fiscalYear})
              </h3>
              <table className="w-full text-left text-xs border border-slate-300">
                <thead className="bg-slate-100 text-slate-700 font-bold text-[10px] uppercase border-b border-slate-300">
                  <tr>
                    <th className="p-2 border-r">CODE</th>
                    <th className="p-2 border-r">ACCOUNT</th>
                    <th className="p-2 border-r">TYPE</th>
                    <th className="p-2 text-right border-r">BUDGET</th>
                    <th className="p-2 text-right border-r">ACTUAL</th>
                    <th className="p-2 text-right border-r">VARIANCE</th>
                    <th className="p-2 text-center">STATUS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 font-mono">
                  {(bvaReport?.lines || []).map((l: any) => (
                    <tr key={l.accountId}>
                      <td className="p-2 border-r text-slate-500">{l.code || '—'}</td>
                      <td className="p-2 border-r font-sans font-semibold">{l.name}</td>
                      <td className="p-2 border-r font-sans text-slate-500">{l.accountType}</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(l.budget || 0), currency)}</td>
                      <td className="p-2 text-right border-r tabular-nums">{formatCurrency(Number(l.actual || 0), currency)}</td>
                      <td className="p-2 text-right border-r font-bold tabular-nums">
                        {formatCurrency(Number(l.variance || 0), currency, { showSign: true })}
                      </td>
                      <td className="p-2 text-center font-sans">
                        <StatusBadge tone={l.favorable ? 'success' : 'danger'}>
                          {l.favorable ? 'Favorable' : 'Unfavorable'}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-xs uppercase tracking-wider text-slate-800">
                  12-Month Account Budget Matrix ({fiscalYear})
                </h3>
                {canWriteBudgets && (
                  <button
                    type="button"
                    disabled={savingBudget}
                    onClick={handleSaveBudgets}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs disabled:opacity-50"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {savingBudget ? 'Saving...' : 'Save Budget Matrix'}
                  </button>
                )}
              </div>
              <div className="overflow-x-auto border border-slate-300 rounded">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-100 font-bold uppercase text-[10px]">
                    <tr>
                      <th className="p-2 border-r sticky left-0 bg-slate-100 min-w-[160px]">Account</th>
                      {MONTH_LABELS.map(m => (
                        <th key={m} className="p-1.5 text-right border-r min-w-[68px]">{m}</th>
                      ))}
                      <th className="p-1.5 text-right min-w-[80px]">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-mono">
                    {budgetRows.map(r => (
                      <tr key={r.accountId}>
                        <td className="p-1.5 border-r font-sans font-semibold sticky left-0 bg-white">
                          {r.code ? `${r.code} ` : ''}{r.name}
                        </td>
                        {MONTH_LABELS.map((_, idx) => {
                          const key = `${r.accountId}-${idx + 1}`;
                          return (
                            <td key={key} className="p-1 border-r">
                              <input
                                type="number"
                                step="0.01"
                                disabled={!canWriteBudgets}
                                value={budgetDraft[key] ?? '0'}
                                onChange={e => setBudgetDraft(prev => ({ ...prev, [key]: e.target.value }))}
                                className="w-full text-right bg-slate-50 border border-slate-200 rounded px-1 py-0.5 tabular-nums disabled:bg-transparent disabled:border-transparent"
                              />
                            </td>
                          );
                        })}
                        <td className="p-1.5 text-right font-bold tabular-nums">
                          {formatCurrency(Number(r.annualTotal || 0), currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* 6c. FOREIGN EXCHANGE RATES */}
        {!loading && activeReport === 'fx' && (
          <div className="space-y-4">
            {canWriteAccounts && (
              <form onSubmit={handleSaveFxRate} className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap items-end gap-3 text-xs">
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">From Currency</label>
                  <input
                    type="text"
                    maxLength={3}
                    value={fxFrom}
                    onChange={e => setFxFrom(e.target.value.toUpperCase())}
                    className="border border-slate-300 rounded px-2.5 py-1.5 font-mono w-20 bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">To Base</label>
                  <input
                    type="text"
                    maxLength={3}
                    value={fxTo}
                    onChange={e => setFxTo(e.target.value.toUpperCase())}
                    className="border border-slate-300 rounded px-2.5 py-1.5 font-mono w-20 bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Effective Date</label>
                  <input
                    type="date"
                    value={fxDate}
                    onChange={e => setFxDate(e.target.value)}
                    className="border border-slate-300 rounded px-2.5 py-1.5 font-mono bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Rate (1 From = X To)</label>
                  <input
                    type="number"
                    step="0.000001"
                    value={fxRateVal}
                    onChange={e => setFxRateVal(e.target.value)}
                    className="border border-slate-300 rounded px-2.5 py-1.5 font-mono w-28 bg-white"
                  />
                </div>
                <button
                  type="submit"
                  disabled={savingFx}
                  className="flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-bold disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {savingFx ? 'Saving...' : 'Upsert Rate'}
                </button>
              </form>
            )}

            <table className="w-full text-left text-xs border border-slate-300">
              <thead className="bg-slate-100 font-bold text-[10px] uppercase">
                <tr>
                  <th className="p-2 border-r">PAIR</th>
                  <th className="p-2 border-r">EFFECTIVE DATE</th>
                  <th className="p-2 text-right border-r">EXCHANGE RATE</th>
                  <th className="p-2">SOURCE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 font-mono">
                {fxRates.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-slate-400 font-sans">
                      No foreign exchange rates recorded yet.
                    </td>
                  </tr>
                ) : (
                  fxRates.map((r: any) => (
                    <tr key={r.id}>
                      <td className="p-2 border-r font-bold">{r.from_currency || r.fromCurrency} / {r.to_currency || r.toCurrency}</td>
                      <td className="p-2 border-r">{String(r.rate_date || r.rateDate).slice(0, 10)}</td>
                      <td className="p-2 text-right border-r font-bold tabular-nums">{Number(r.rate).toFixed(6)}</td>
                      <td className="p-2 font-sans text-slate-600">{r.source || 'manual'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* 6d. SAVED REPORTS */}
        {!loading && activeReport === 'saved' && (
          <div className="space-y-5">
            <form onSubmit={handleCreateSavedReport} className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap items-end gap-3 text-xs">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Report Configuration Name</label>
                <input
                  type="text"
                  required
                  value={newSavedName}
                  onChange={e => setNewSavedName(e.target.value)}
                  placeholder="e.g. Monthly Board P&L Pack"
                  className="w-full border border-slate-300 rounded px-2.5 py-1.5 bg-white"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Report Type</label>
                <select
                  value={newSavedType}
                  onChange={e => setNewSavedType(e.target.value)}
                  className="border border-slate-300 rounded px-2.5 py-1.5 bg-white"
                >
                  <option value="profit_and_loss">Profit &amp; Loss</option>
                  <option value="balance_sheet">Balance Sheet</option>
                  <option value="cash_flow">Statement of Cash Flows</option>
                  <option value="trial_balance">Trial Balance</option>
                  <option value="ar_aging">AR Aging</option>
                  <option value="ap_aging">AP Aging</option>
                  <option value="budget_vs_actual">Budget vs. Actual</option>
                  <option value="tax_summary">Sales &amp; Use Tax Summary</option>
                </select>
              </div>
              <button
                type="submit"
                className="flex items-center gap-1 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-bold"
              >
                <Save className="w-3.5 h-3.5" />
                Save Report Preset
              </button>
            </form>

            <table className="w-full text-left text-xs border border-slate-300">
              <thead className="bg-slate-100 font-bold text-[10px] uppercase">
                <tr>
                  <th className="p-2 border-r">NAME</th>
                  <th className="p-2 border-r">TYPE</th>
                  <th className="p-2 border-r">LAST RUN</th>
                  <th className="p-2 text-right">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {savedReports.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-slate-400">
                      No saved report presets yet.
                    </td>
                  </tr>
                ) : (
                  savedReports.map((sr: any) => (
                    <tr key={sr.id}>
                      <td className="p-2 border-r font-semibold">{sr.name}</td>
                      <td className="p-2 border-r font-mono text-[11px] text-slate-600">{sr.report_type || sr.reportType}</td>
                      <td className="p-2 border-r font-mono text-[11px] text-slate-500">
                        {sr.last_run_at || sr.lastRunAt ? new Date(sr.last_run_at || sr.lastRunAt).toLocaleString() : 'Never'}
                      </td>
                      <td className="p-2 text-right space-x-2">
                        <button
                          type="button"
                          onClick={() => handleRunSavedReport(sr.id, sr.name)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold"
                        >
                          <Play className="w-3 h-3" /> Run
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteSavedReport(sr.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 text-[11px]"
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-bold text-slate-700">Export Snapshots</div>
                <button
                  type="button"
                  className="px-2.5 py-1 rounded bg-slate-800 text-white text-[11px] font-bold"
                  onClick={async () => {
                    const reportKey = await appDialog.prompt({
                      title: 'Create Report Export Snapshot',
                      message: 'Specify the report key to capture as an immutable export snapshot.',
                      label: 'Report key',
                      defaultValue: 'profit_and_loss',
                      placeholder: 'e.g. profit_and_loss, balance_sheet',
                      required: true,
                    });
                    if (!reportKey) return;
                    try {
                      await commercialApi.createReportExportSnapshot({ reportKey, format: 'json', payload: { generatedAt: new Date().toISOString(), note: 'Manual snapshot from ReportsView' } });
                      const snaps = await commercialApi.listReportExportSnapshots();
                      setExportSnapshots(snaps);
                      triggerShortcutNotice('Report export snapshot created');
                    } catch (e: any) { setErrorMsg(e?.message || 'Failed to create snapshot'); }
                  }}
                >Create Snapshot</button>
              </div>
              <div className="max-h-40 overflow-auto text-[11px]">
                <table className="w-full"><thead><tr className="text-slate-500"><th className="text-left py-1">When</th><th className="text-left">Report</th><th className="text-left">Format</th><th className="text-left">Hash</th></tr></thead>
                  <tbody>{exportSnapshots.length === 0 ? <tr><td colSpan={4} className="py-2 text-slate-400">No snapshots.</td></tr> : exportSnapshots.slice(0,20).map((s:any)=>(
                    <tr key={s.id} className="border-t border-slate-200"><td className="py-1 font-mono">{String(s.created_at||s.createdAt||'').slice(0,19).replace('T',' ')}</td><td>{s.report_key||s.reportKey}</td><td>{s.format}</td><td className="font-mono text-slate-500">{String(s.snapshot_hash||s.snapshotHash||'').slice(0,16)}…</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </div>

            {savedRunResult && (
              <div className="p-4 bg-slate-900 text-emerald-300 rounded-lg font-mono text-[11px] space-y-2">
                <div className="flex items-center justify-between text-white font-sans font-bold text-xs">
                  <span>Executed Saved Report Output: {savedRunResult.name}</span>
                  <button
                    type="button"
                    onClick={() => setSavedRunResult(null)}
                    className="text-slate-400 hover:text-white text-[11px]"
                  >
                    Close
                  </button>
                </div>
                <pre className="overflow-x-auto max-h-80">{JSON.stringify(savedRunResult.output, null, 2)}</pre>
              </div>
            )}
          </div>
        )}

        {/* 7. TAMPER-EVIDENT AUDIT TRAIL (LIVE POSTGRESQL AUDIT LOG) */}
        {!loading && activeReport === 'audit' && (
          <div className="space-y-4">
            <div className="p-3 bg-slate-50 border rounded-lg text-xs space-y-1">
              <span className="font-bold text-slate-800 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
                PostgreSQL Tamper-Evident Audit Trail
              </span>
              <p className="text-slate-600 text-[11px]">
                Every Chart of Accounts update, journal posting, reversal, period lock, and CSV export is sealed with a SHA-256 hash.
              </p>
            </div>

            <div className="divide-y divide-slate-200 font-mono text-xs">
              {auditLogs.length === 0 ? (
                <div className="py-6 text-center text-slate-400 font-sans">No audit entries available.</div>
              ) : (
                auditLogs.map(log => (
                  <div key={log.id} className="py-2.5 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-sans font-bold text-slate-900">
                        {log.action} ({log.tableName} #{log.recordId})
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {new Date(log.occurredAt).toLocaleString()}
                      </span>
                    </div>
                    {log.newValues && (
                      <div className="font-sans text-slate-600 text-[11px]">
                        {JSON.stringify(log.newValues)}
                      </div>
                    )}
                    <div className="text-[10px] text-slate-400 break-all">
                      Actor: {log.actorUsername || 'system'} · SHA-256:{' '}
                      <span className="text-emerald-700">{log.sha256Hash}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
};
