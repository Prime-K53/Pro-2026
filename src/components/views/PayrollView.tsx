import React, { useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { PayrollItem, PayrollRun } from '../../types/accounting';
import { payrollApi } from '../../services/payrollApi';
import { calculatePayrollItem } from '../../services/taxCalculation';
import { formatCurrency } from '../../utils/currency';
import { FinancialDataNotice } from '../common/FinancialDataNotice';
import { financialFigureSourceFromDomains, resolveFinancialFigureState } from '../common/financialDataState';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';
import { DeductionRulesView } from '../payroll/DeductionRulesView';
import { SalaryAdvanceModal } from '../payroll/SalaryAdvanceModal';
import { StatutoryConfigView } from '../payroll/StatutoryConfigView';
import { PayrollControlsView } from '../payroll/PayrollControlsView';
import { BankFileExport } from '../payroll/BankFileExport';
import {
  Users,
  Plus,
  Play,
  FileCheck2,
  Printer,
  CheckCircle2,
  X,
  RotateCcw,
  Clock,
  Copy,
  FileText,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import {
  Button,
  InlineAlert,
  ModalBody,
  ModalHeader,
  ModalShell,
  PageHeader,
  PageShell,
  StatusBadge,
  Tabs,
} from '../common/ui';

export const PayrollView: React.FC = () => {
  const {
    employees,
    payrollRuns,
    accounts,
    financialData,
    refreshFinancialData,
    setIsNewEmployeeOpen,
    setCurrentView,
    companyProfile,
    triggerShortcutNotice,
  } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const { authenticated, permissions, activeCompany } = useAuth();

  /**
   * Payroll totals are derived from the employee roster and the posted runs.
   * Both are backend-owned context domains, so the figures may only be shown
   * as current when those domains loaded successfully; a failed refresh marks
   * the retained figures stale instead of presenting them as current.
   */
  const payrollFigureState = resolveFinancialFigureState(
    financialFigureSourceFromDomains(financialData, ['employees', 'payrollRuns'])
  );

  const [activeTab, setActiveTab] = useState<
    'runs' | 'wizard' | 'employees' | 'advances' | 'deductions' | 'statutory' | 'controls' | 'bank'
  >('runs');
  const [selectedStubRun, setSelectedStubRun] = useState<{ run: PayrollRun; item: PayrollItem } | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // Payroll Wizard State
  const [payPeriodStart, setPayPeriodStart] = useState('2026-10-26');
  const [payPeriodEnd, setPayPeriodEnd] = useState('2026-11-08');
  const [payDate, setPayDate] = useState(new Date().toISOString().split('T')[0]);
  const [bankAccountId, setBankAccountId] = useState(
    accounts.find(a => a.code === '1020')?.id || companyProfile.defaultBankAccountId
  );

  // Hours inputs for each employee in the wizard
  const [hoursState, setHoursState] = useState<Record<string, { regular: number; overtime: number }>>(() => {
    const initial: Record<string, { regular: number; overtime: number }> = {};
    employees.forEach(emp => {
      initial[emp.id] = { regular: emp.payType === 'hourly' ? 80 : 80, overtime: 0 };
    });
    return initial;
  });

  const handleHoursChange = (empId: string, field: 'regular' | 'overtime', val: number) => {
    setHoursState(prev => ({
      ...prev,
      [empId]: {
        ...prev[empId],
        [field]: Math.max(0, val),
      },
    }));
  };

  // Live calculation of wizard items
  const computedPayrollItems: PayrollItem[] = employees.map(emp => {
    const hours = hoursState[emp.id] || { regular: 80, overtime: 0 };
    return calculatePayrollItem(emp, hours.regular, hours.overtime);
  });

  const totalGross = Math.round(computedPayrollItems.reduce((sum, it) => sum + it.grossPay, 0) * 100) / 100;
  const totalNet = Math.round(computedPayrollItems.reduce((sum, it) => sum + it.netPay, 0) * 100) / 100;
  const totalEmployeeTaxes = Math.round(
    computedPayrollItems.reduce(
      (sum, it) => sum + it.fit + it.socialSecurityEmployee + it.medicareEmployee + it.sit,
      0
    ) * 100
  ) / 100;
  const totalEmployerTaxes = Math.round(
    computedPayrollItems.reduce(
      (sum, it) =>
        sum + it.socialSecurityEmployer + it.medicareEmployer + it.futaEmployer + it.sutaEmployer,
      0
    ) * 100
  ) / 100;

  const handleExecutePayroll = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const backendBankId = Number(bankAccountId);
      if (!Number.isInteger(backendBankId) || backendBankId <= 0) {
        throw new Error(
          'Select a server bank account before running payroll. Reload the chart of accounts from the server first.'
        );
      }

      const run = await payrollApi.runPayroll({
        payPeriodStart,
        payPeriodEnd,
        payDate,
        bankAccountId: backendBankId,
        items: computedPayrollItems.map(it => ({
          employeeId: Number(it.employeeId),
          hoursRegular: it.hoursWorked,
          hoursOvertime: it.overtimeHours,
        })),
      });

      triggerShortcutNotice(
        `Payroll ${run.runNumber} posted ${run.entryNumber}: ${formatCurrency(run.totalNet, currency)} net to ${run.items.length} employee(s)`
      );
      setActiveTab('runs');
    } catch (err: any) {
      const message = err?.message || 'Payroll run failed';
      setRunError(message);
      triggerShortcutNotice(message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const buildPayrollActionContext = (record: any, pendingId?: string | null): ActionEligibilityContext<any> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'payroll',
    entityType: 'payroll',
    record,
    recordStatus: record?.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const renderWizardEmpActions = (emp: any, item: any) => {
    const defs: AdvancedActionDefinition<any>[] = [];
    if (emp.payType === 'hourly') {
      defs.push({ id: 'reset-80', label: 'Reset to 80h Regular', icon: <RotateCcw className="w-3.5 h-3.5 text-blue-600" />, group: 'process', groupLabel: 'Hours', requiredPermission: 'payroll:write', execute: async () => { setHoursState(prev => ({ ...prev, [emp.id]: { regular: 80, overtime: 0 } })); triggerShortcutNotice(`Reset hours to 80h for ${emp.firstName}`); } });
      defs.push({ id: 'add-ot', label: 'Add +4h Overtime', icon: <Clock className="w-3.5 h-3.5 text-amber-600" />, group: 'process', groupLabel: 'Hours', requiredPermission: 'payroll:write', execute: async () => setHoursState(prev => ({ ...prev, [emp.id]: { ...prev[emp.id], overtime: (prev[emp.id]?.overtime || 0) + 4 } })) });
    }
    const ctx = buildPayrollActionContext(emp, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for ${emp.firstName} ${emp.lastName}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={emp.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => { const def = action.definition; if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) }); }}
      />
    );
  };

  const renderRunActions = (run: any) => {
    const defs: AdvancedActionDefinition<any>[] = run.items.map((item: any) => {
      const emp = employees.find((e: any) => e.id === item.employeeId);
      return {
        id: `stub-${item.employeeId}`,
        label: `Pay Stub: ${emp ? `${emp.firstName} ${emp.lastName}` : item.employeeId}`,
        icon: <FileText className="w-3.5 h-3.5 text-blue-600" />,
        group: 'view',
        groupLabel: 'Stubs',
        requiredPermission: 'payroll:read',
        execute: async () => setSelectedStubRun({ run, item }),
      };
    });
    defs.push({ id: 'tax-forms', label: 'Open Tax Forms (941 / W-2)', icon: <FileCheck2 className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Tax', requiredPermission: 'payroll:read', execute: async () => setCurrentView('tax-forms') });
    defs.push({ id: 'copy-run', label: 'Copy Run #', icon: <Copy className="w-3.5 h-3.5" />, group: 'admin', groupLabel: 'Other', requiredPermission: 'payroll:read', execute: async () => { await navigator.clipboard?.writeText(run.runNumber); triggerShortcutNotice(`Copied ${run.runNumber}`); } });
    const ctx = buildPayrollActionContext(run, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for ${run.runNumber}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={run.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => { const def = action.definition; if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) }); }}
      />
    );
  };

  const renderEmpActions = (emp: any) => {
    const defs: AdvancedActionDefinition<any>[] = [
      { id: 'run-payroll', label: 'Run Payroll Wizard', icon: <Play className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Actions', requiredPermission: 'payroll:write', execute: async () => setActiveTab('wizard') },
      { id: 'tax-forms', label: 'View Form W-2', icon: <FileCheck2 className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Tax', requiredPermission: 'payroll:read', execute: async () => setCurrentView('tax-forms') },
      { id: 'copy-ach', label: 'Copy Routing / Acct Info', icon: <Copy className="w-3.5 h-3.5" />, group: 'admin', groupLabel: 'Other', requiredPermission: 'payroll:read', execute: async () => { await navigator.clipboard?.writeText(`${emp.directDepositRouting} / ${emp.directDepositAccountMasked}`); triggerShortcutNotice(`Copied ACH info for ${emp.firstName}`); } },
    ];
    const ctx = buildPayrollActionContext(emp, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for ${emp.firstName} ${emp.lastName}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={emp.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => { const def = action.definition; if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) }); }}
      />
    );
  };

  return (
    <PageShell>
      <PageHeader
        title="Payroll Center & Pay Slips"
        subtitle="Bi-weekly payroll execution, Malawi PAYE & statutory deductions (pension), pension employer match, and pay slips."
        icon={<Users className="w-5 h-5" strokeWidth={1.75} />}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsNewEmployeeOpen(true)}
              icon={<Plus className="w-3.5 h-3.5" />}
            >
              Add Employee
            </Button>
            <Button
              variant="emerald"
              size="sm"
              onClick={() => setActiveTab('wizard')}
              icon={<Play className="w-3.5 h-3.5" />}
            >
              Run Payroll Wizard (Alt+P)
            </Button>
          </>
        }
      />

      <Tabs
        ariaLabel="Payroll sections"
        value={activeTab}
        onChange={(id) =>
          setActiveTab(
            id as 'runs' | 'wizard' | 'employees' | 'advances' | 'deductions' | 'statutory' | 'controls' | 'bank'
          )
        }
        tabs={[
          { id: 'runs', label: `Payroll Runs History (${payrollRuns.length})` },
          { id: 'wizard', label: 'Run New Pay Period' },
          { id: 'employees', label: `Employee Directory (${employees.length})` },
          { id: 'advances', label: 'Salary Advances' },
          { id: 'deductions', label: 'Deduction Rules' },
          { id: 'statutory', label: 'Statutory Config' },
          { id: 'controls', label: 'Structures & Loans' },
          { id: 'bank', label: 'Payslips & Bank File' },
        ]}
      />

      {/* 1. RUN PAYROLL WIZARD */}
      {activeTab === 'wizard' && (
        <div className="surface p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-white/[0.08] pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                Execute Bi-Weekly Pay Period
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Adjust regular and overtime hours for hourly machinists and review automated tax calculations.
              </p>
            </div>
            <div className="text-right">
              <span className="text-[11px] uppercase font-semibold tracking-wider text-slate-500 dark:text-slate-400">Payroll Checking:</span>
              <div className="font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                {formatCurrency(accounts.find(a => a.id === bankAccountId)?.balance || 0, currency)} Available
              </div>
            </div>
          </div>

          {/* Period dates row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div>
              <label className="app-label">Period Start Date</label>
              <input
                type="date"
                value={payPeriodStart}
                onChange={e => setPayPeriodStart(e.target.value)}
                className="app-input app-input-mono"
              />
            </div>
            <div>
              <label className="app-label">Period End Date</label>
              <input
                type="date"
                value={payPeriodEnd}
                onChange={e => setPayPeriodEnd(e.target.value)}
                className="app-input app-input-mono"
              />
            </div>
            <div>
              <label className="app-label">Direct Deposit Date</label>
              <input
                type="date"
                value={payDate}
                onChange={e => setPayDate(e.target.value)}
                className="app-input app-input-mono"
              />
            </div>
            <div>
              <label className="app-label">Disbursement Bank Account</label>
              <select
                value={bankAccountId ?? ''}
                onChange={e => setBankAccountId(e.target.value)}
                className="app-input"
              >
                <option value="">Select bank account…</option>
                {accounts
                  .filter(a => a.type === 'Bank')
                  .map(a => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {/* Employee Hours Entry Table */}
          <div className="surface overflow-hidden">
            <table className="data-table w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-white/[0.04] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-white/[0.08] uppercase tracking-wider font-semibold text-[11px]">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Pay Type</th>
                  <th className="px-4 py-3 w-28 text-center">Reg Hours</th>
                  <th className="px-4 py-3 w-28 text-center">OT Hours</th>
                  <th className="px-4 py-3 text-right">Gross Pay</th>
                  <th className="px-4 py-3 text-right">PAYE</th>
                  <th className="px-4 py-3 text-right">Pension (5%)</th>
                  <th className="px-4 py-3 text-right">Other</th>
                  <th className="px-4 py-3 text-right">Net Pay</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                {computedPayrollItems.map(item => {
                  const emp = employees.find(e => e.id === item.employeeId);
                  if (!emp) return null;
                  const hours = hoursState[emp.id] || { regular: 80, overtime: 0 };

                  return (
                    <tr key={emp.id} className="hover:bg-slate-50 dark:hover:bg-slate-850/50">
                      <td className="px-4 py-3 font-sans">
                        <div className="font-bold text-slate-900 dark:text-white">
                          {emp.firstName} {emp.lastName}
                        </div>
                        <div className="text-[11px] text-slate-500 font-sans">{emp.title}</div>
                      </td>
                      <td className="px-4 py-3 font-sans capitalize text-slate-500 text-[11px]">
                        {emp.payType === 'hourly' ? `${formatCurrency(emp.payRate, currency)}/hr` : 'Salary'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {emp.payType === 'hourly' ? (
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={hours.regular}
                            onChange={e =>
                              handleHoursChange(emp.id, 'regular', parseFloat(e.target.value) || 0)
                            }
                            className="w-16 bg-slate-50 dark:bg-slate-800 border rounded px-1.5 py-1 text-center font-bold text-slate-900 dark:text-slate-100"
                          />
                        ) : (
                          <span className="text-slate-400">80.0</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {emp.payType === 'hourly' ? (
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={hours.overtime}
                            onChange={e =>
                              handleHoursChange(emp.id, 'overtime', parseFloat(e.target.value) || 0)
                            }
                            className="w-16 bg-slate-50 dark:bg-slate-800 border rounded px-1.5 py-1 text-center font-bold text-slate-900 dark:text-slate-100"
                          />
                        ) : (
                          <span className="text-slate-400">0.0</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-slate-900 dark:text-white tabular-nums">
                        {formatCurrency(item.grossPay, currency)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400 tabular-nums">
                        -{formatCurrency(item.fit, currency)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400 tabular-nums">
                        -{formatCurrency(item.socialSecurityEmployee + item.medicareEmployee, currency)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400 tabular-nums">
                        -{formatCurrency(item.sit, currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {formatCurrency(item.netPay, currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-sans">
                        {renderWizardEmpActions(emp, item)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Grand Totals Strip */}
          {/* Derived from the employee roster, so it is only trustworthy when
              that roster loaded successfully. A failed load must not render
              K0 payroll totals as though they were real. */}
          <FinancialDataNotice
            state={payrollFigureState}
            label="payroll data"
            onRetry={refreshFinancialData}
          />
          {(payrollFigureState === 'ready' || payrollFigureState === 'stale') && (
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-6 font-mono text-xs">
            <div>
              <span className="text-slate-500">Gross Wages (Dr. Payroll Exp):</span>
              <div className="text-base font-bold text-slate-900 dark:text-white tabular-nums">
                {formatCurrency(totalGross, currency)}
              </div>
            </div>

            <div>
              <span className="text-slate-500">Employee Deductions (Cr. Liab):</span>
              <div className="text-base font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                {formatCurrency(totalEmployeeTaxes, currency)}
              </div>
            </div>

            <div>
              <span className="text-slate-500">Employer Pension (10%):</span>
              <div className="text-base font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">
                {formatCurrency(totalEmployerTaxes, currency)}
              </div>
            </div>

            <div className="border-l border-slate-300 dark:border-slate-700 pl-6">
              <span className="text-slate-500 uppercase font-bold text-[10px]">
                Net Direct Deposit (Cr. Bank):
              </span>
              <div className="text-xl font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                {formatCurrency(totalNet, currency)}
              </div>
            </div>

            {runError && (
              <InlineAlert tone="error">{runError}</InlineAlert>
            )}

            <Button
              variant="emerald"
              onClick={handleExecutePayroll}
              loading={running}
              loadingLabel="Posting to server…"
              icon={<CheckCircle2 className="w-3.5 h-3.5" />}
              title="Posts the payroll journal entry and pay stubs to the server"
            >
              Authorize &amp; Process Payroll
            </Button>
          </div>
          )}
        </div>
      )}

      {/* 2. PAYROLL RUNS HISTORY */}
      {activeTab === 'runs' && (
        <div className="surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table w-full text-left text-xs">
              <thead>
                <tr>
                  <th>Payroll Run #</th>
                  <th>Pay Date</th>
                  <th>Pay Period</th>
                  <th className="text-center">Headcount</th>
                  <th className="text-right">Total Gross</th>
                  <th className="text-right">Taxes Withheld</th>
                  <th className="text-right">Net Disbursed</th>
                  <th className="text-center">Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {payrollRuns.map(run => (
                  <tr key={run.id}>
                    <td className="font-semibold text-slate-900 dark:text-white">
                      {run.runNumber}
                    </td>
                    <td className="text-slate-600 dark:text-slate-400">{run.payDate}</td>
                    <td className="text-slate-500">
                      {run.payPeriodStart} to {run.payPeriodEnd}
                    </td>
                    <td className="text-center font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {run.items.length}
                    </td>
                    <td className="text-right font-bold text-slate-900 dark:text-white tabular-nums">
                      {formatCurrency(run.totalGross, currency)}
                    </td>
                    <td className="text-right text-slate-500 tabular-nums">
                      {formatCurrency(run.totalEmployeeTaxes, currency)}
                    </td>
                    <td className="text-right font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                      {formatCurrency(run.totalNet, currency)}
                    </td>
                    <td className="text-center font-sans">
                      <StatusBadge tone="success" showIcon>
                        Processed
                      </StatusBadge>
                    </td>
                    <td className="text-right font-sans">
                      {renderRunActions(run)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. EMPLOYEE DIRECTORY */}
      {activeTab === 'employees' && (
        <div className="surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table w-full text-left text-xs">
              <thead>
                <tr>
                  <th>Employee Name</th>
                  <th>Job Title / Department</th>
                  <th>SSN (Masked)</th>
                  <th>Compensation</th>
                  <th>W-4 Filing Status</th>
                  <th>Direct Deposit ACH</th>
                  <th>Hire Date</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                {employees.map(emp => (
                  <tr key={emp.id} className="hover:bg-slate-50 dark:hover:bg-slate-850/50">
                    <td className="px-4 py-3 font-sans font-bold text-slate-900 dark:text-white">
                      {emp.firstName} {emp.lastName}
                    </td>
                    <td className="px-4 py-3 font-sans">
                      <div className="font-semibold text-slate-800 dark:text-slate-200">
                        {emp.title}
                      </div>
                      <div className="text-[11px] text-slate-400">{emp.department}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{emp.ssnMasked}</td>
                    <td className="px-4 py-3 font-bold text-slate-900 dark:text-white tabular-nums">
                      {emp.payType === 'hourly'
                        ? `${formatCurrency(emp.payRate, currency)}/hr`
                        : `${formatCurrency(emp.payRate, currency, { decimals: 0 })}/yr`}
                    </td>
                    <td className="px-4 py-3 font-sans capitalize text-slate-600 dark:text-slate-400">
                      {emp.filingStatus.replace('_', ' ')} (Allow: {emp.w4Allowances})
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      Routing: {emp.directDepositRouting} · Acct: {emp.directDepositAccountMasked}
                    </td>
                    <td className="px-4 py-3 text-slate-500">{emp.hireDate}</td>
                    <td className="px-4 py-3 text-right font-sans">
                      {renderEmpActions(emp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. SALARY ADVANCES */}
      {activeTab === 'advances' && (
        <SalaryAdvanceModal onClose={() => setActiveTab('runs')} />
      )}

      {/* 5. DEDUCTION RULES */}
      {activeTab === 'deductions' && (
        <DeductionRulesView />
      )}

      {/* 6. STATUTORY CONFIG */}
      {activeTab === 'statutory' && <StatutoryConfigView />}

      {/* 7. STRUCTURES & LOANS */}
      {activeTab === 'controls' && <PayrollControlsView />}

      {/* 8. PAYSLIPS & BANK FILE */}
      {activeTab === 'bank' && <BankFileExport />}

      {/* Pay Stub Modal Dialog */}
      <ModalShell open={!!selectedStubRun} onClose={() => setSelectedStubRun(null)} size="2xl">
        <ModalHeader
          title="Official Employee Pay Stub"
          icon={<FileText className="w-4 h-4" strokeWidth={1.75} />}
          tone="brand"
          onClose={() => setSelectedStubRun(null)}
        />
        <ModalBody>
          {selectedStubRun && (() => {
            const emp = employees.find(e => e.id === selectedStubRun.item.employeeId);
            const item = selectedStubRun.item;
            const run = selectedStubRun.run;

            return (
              <div className="space-y-6 text-xs bg-white text-slate-900 font-sans p-6 rounded-xl border border-slate-200">
                  {/* Company & Stub Header */}
                  <div className="flex justify-between items-start border-b pb-4">
                    <div>
                      <h2 className="text-base font-black text-slate-900 uppercase">
                        {companyProfile.name}
                      </h2>
                      <div className="text-slate-600 text-[11px]">
                        {companyProfile.address} · {companyProfile.cityStateZip}
                        <br />
                        EIN: {companyProfile.ein}
                      </div>
                    </div>
                    <div className="text-right font-mono">
                      <div className="text-base font-black text-emerald-700">PAY STUB</div>
                      <div className="text-xs font-bold text-slate-700">{run.runNumber}</div>
                      <div className="text-[11px] text-slate-500">Pay Date: {run.payDate}</div>
                    </div>
                  </div>

                  {/* Employee Details Box */}
                  <div className="p-4 rounded-lg bg-slate-50 border grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <div className="text-[10px] uppercase font-bold text-slate-500">Employee</div>
                      <div className="font-bold text-sm text-slate-900">
                        {emp?.firstName} {emp?.lastName}
                      </div>
                      <div className="text-slate-600">{emp?.title}</div>
                      <div className="text-slate-500 font-mono text-[11px] mt-1">
                        SSN: {emp?.ssnMasked} · Dep: {emp?.department}
                      </div>
                    </div>

                    <div className="font-mono text-right space-y-1">
                      <div>
                        <span className="text-slate-500 text-[11px]">Pay Period: </span>
                        <span className="font-semibold">{run.payPeriodStart} - {run.payPeriodEnd}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 text-[11px]">Filing Status: </span>
                        <span className="font-semibold capitalize">{emp?.filingStatus}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 text-[11px]">Disbursement: </span>
                        <span className="font-semibold">Direct Deposit ACH ({emp?.directDepositAccountMasked})</span>
                      </div>
                    </div>
                  </div>

                  {/* Earnings Breakdown */}
                  <div>
                    <h3 className="font-bold text-xs uppercase tracking-wider mb-2 text-slate-700">
                      Gross Earnings
                    </h3>
                    <table className="w-full text-left border border-slate-200">
                      <thead className="bg-slate-100 font-bold text-[10px] uppercase">
                        <tr>
                          <th className="p-2 border-r">EARNINGS TYPE</th>
                          <th className="p-2 w-20 text-center border-r">HOURS</th>
                          <th className="p-2 w-24 text-right border-r">RATE</th>
                          <th className="p-2 w-24 text-right">TOTAL</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y font-mono">
                        <tr>
                          <td className="p-2 font-sans border-r">Regular Earnings</td>
                          <td className="p-2 text-center border-r">{item.hoursWorked}</td>
                          <td className="p-2 text-right border-r">
                            {emp?.payType === 'hourly' ? formatCurrency(emp.payRate, currency) : 'Salaried'}
                          </td>
                          <td className="p-2 text-right font-bold">{formatCurrency(item.grossPay, currency)}</td>
                        </tr>
                        {item.overtimeHours > 0 && (
                          <tr>
                            <td className="p-2 font-sans border-r">Overtime (1.5x)</td>
                            <td className="p-2 text-center border-r">{item.overtimeHours}</td>
                            <td className="p-2 text-right border-r">
                              {formatCurrency((emp?.payRate || 0) * 1.5, currency)}
                            </td>
                            <td className="p-2 text-right font-bold">Included</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Deductions Breakdown */}
                  <div>
                    <h3 className="font-bold text-xs uppercase tracking-wider mb-2 text-slate-700">
                      Statutory Taxes & Deductions
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      {/* Employee Deductions */}
                      <table className="w-full text-left border border-slate-200 font-mono text-xs">
                        <thead className="bg-slate-100 font-bold text-[10px] font-sans uppercase">
                          <tr>
                            <th className="p-2 border-r">STATUTORY DEDUCTIONS</th>
                            <th className="p-2 text-right">AMOUNT</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          <tr>
                            <td className="p-2 font-sans border-r">PAYE (Pay As You Earn)</td>
                            <td className="p-2 text-right font-bold">{formatCurrency(item.fit, currency)}</td>
                          </tr>
                          <tr>
                            <td className="p-2 font-sans border-r">Pension (Employee 5%)</td>
                            <td className="p-2 text-right font-bold">{formatCurrency(item.socialSecurityEmployee, currency)}</td>
                          </tr>
                          <tr>
                            <td className="p-2 font-sans border-r">Other Deductions</td>
                            <td className="p-2 text-right font-bold">{formatCurrency(item.sit, currency)}</td>
                          </tr>
                        </tbody>
                      </table>

                      {/* Employer Contributions */}
                      <table className="w-full text-left border border-slate-200 font-mono text-xs">
                        <thead className="bg-slate-100 font-bold text-[10px] font-sans uppercase">
                          <tr>
                            <th className="p-2 border-r">EMPLOYER CONTRIBUTIONS (INFORMATIONAL)</th>
                            <th className="p-2 text-right">AMOUNT</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          <tr>
                            <td className="p-2 font-sans border-r">Pension (Employer 10%)</td>
                            <td className="p-2 text-right">{formatCurrency(item.socialSecurityEmployer, currency)}</td>
                          </tr>
                          <tr>
                            <td className="p-2 font-sans border-r">Other Employer Costs</td>
                            <td className="p-2 text-right">{formatCurrency(item.medicareEmployer + item.futaEmployer + item.sutaEmployer, currency)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Net Pay Box */}
                  <div className="p-4 bg-emerald-50 rounded-lg border border-emerald-300 flex items-center justify-between font-mono">
                    <div>
                      <div className="font-sans font-bold text-emerald-950 text-sm">
                        Net Direct Deposit Disbursed
                      </div>
                      <div className="font-sans text-xs text-emerald-800">
                        Deposited to {emp?.directDepositRouting} · {emp?.directDepositAccountMasked}
                      </div>
                    </div>
                    <div className="text-2xl font-black text-emerald-700">
                      {formatCurrency(item.netPay, currency)}
                    </div>
                  </div>
                </div>
              );
            })()}
        </ModalBody>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200/70 bg-slate-50/60 px-5 py-3.5 dark:border-white/[0.06] dark:bg-white/[0.02] no-print">
          <Button variant="secondary" onClick={() => setSelectedStubRun(null)}>
            Close
          </Button>
          <Button variant="primary" onClick={() => window.print()} icon={<Printer className="w-3.5 h-3.5" />}>
            Print Pay Stub
          </Button>
        </div>
      </ModalShell>
    </PageShell>
  );
};
