import React, { useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { PayrollItem, PayrollRun } from '../../types/accounting';
import { payrollApi } from '../../services/payrollApi';
import { calculatePayrollItem } from '../../services/taxCalculation';
import { formatCurrency } from '../../utils/currency';
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

export const PayrollView: React.FC = () => {
  const {
    employees,
    payrollRuns,
    accounts,
    setIsNewEmployeeOpen,
    setCurrentView,
    companyProfile,
    triggerShortcutNotice,
  } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const { authenticated, permissions, activeCompany } = useAuth();

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
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            Payroll Center &amp; Pay Slips
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Bi-weekly payroll execution, Malawi PAYE &amp; statutory deductions (pension), pension employer match, and pay slips.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsNewEmployeeOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-semibold shadow-xs"
          >
            <Plus className="w-4 h-4" />
            <span>Add Employee</span>
          </button>
          <button
            onClick={() => setActiveTab('wizard')}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-sm transition-all active:scale-95"
          >
            <Play className="w-4 h-4" />
            <span>Run Payroll Wizard (Alt+P)</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs text-xs font-medium w-fit">
        <button
          onClick={() => setActiveTab('runs')}
          className={`px-3.5 py-1.5 rounded-lg transition-colors ${
            activeTab === 'runs'
              ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Payroll Runs History ({payrollRuns.length})
        </button>
        <button
          onClick={() => setActiveTab('wizard')}
          className={`px-3.5 py-1.5 rounded-lg transition-colors ${
            activeTab === 'wizard'
              ? 'bg-emerald-600 text-white font-bold shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Run New Pay Period
        </button>
        <button
          onClick={() => setActiveTab('employees')}
          className={`px-3.5 py-1.5 rounded-lg transition-colors ${
            activeTab === 'employees'
              ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Employee Directory ({employees.length})
        </button>
        <button
          onClick={() => setActiveTab('advances')}
          className={`px-3.5 py-1.5 rounded-lg transition-colors ${
            activeTab === 'advances'
              ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Salary Advances
        </button>
        <button
          onClick={() => setActiveTab('deductions')}
          className={`px-3.5 py-1.5 rounded-lg transition-colors ${
            activeTab === 'deductions'
              ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Deduction Rules
        </button>
        <button
          onClick={() => setActiveTab('statutory')}
          className={`px-3.5 py-1.5 rounded-lg transition-colors ${
            activeTab === 'statutory'
              ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Statutory Config
        </button>
        <button
          onClick={() => setActiveTab('controls')}
          className={`px-3.5 py-1.5 rounded-lg transition-colors ${
            activeTab === 'controls'
              ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Structures &amp; Loans
        </button>
        <button
          onClick={() => setActiveTab('bank')}
          className={`px-3.5 py-1.5 rounded-lg transition-colors ${
            activeTab === 'bank'
              ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Payslips &amp; Bank File
        </button>
      </div>

      {/* 1. RUN PAYROLL WIZARD */}
      {activeTab === 'wizard' && (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs p-6 space-y-6">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Execute Bi-Weekly Pay Period
              </h2>
              <p className="text-xs text-slate-500">
                Adjust regular and overtime hours for hourly machinists and review automated tax calculations.
              </p>
            </div>
            <div className="text-right">
              <span className="text-[10px] uppercase font-bold text-slate-400">Payroll Checking:</span>
              <div className="font-mono font-bold text-slate-900 dark:text-white">
                {formatCurrency(accounts.find(a => a.id === bankAccountId)?.balance || 0, currency)} Available
              </div>
            </div>
          </div>

          {/* Period dates row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div>
              <label className="font-semibold text-slate-700 dark:text-slate-300">Period Start Date</label>
              <input
                type="date"
                value={payPeriodStart}
                onChange={e => setPayPeriodStart(e.target.value)}
                className="w-full mt-1 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
              />
            </div>
            <div>
              <label className="font-semibold text-slate-700 dark:text-slate-300">Period End Date</label>
              <input
                type="date"
                value={payPeriodEnd}
                onChange={e => setPayPeriodEnd(e.target.value)}
                className="w-full mt-1 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
              />
            </div>
            <div>
              <label className="font-semibold text-slate-700 dark:text-slate-300">Direct Deposit Date</label>
              <input
                type="date"
                value={payDate}
                onChange={e => setPayDate(e.target.value)}
                className="w-full mt-1 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
              />
            </div>
            <div>
              <label className="font-semibold text-slate-700 dark:text-slate-300">Disbursement Bank Account</label>
              <select
                value={bankAccountId ?? ''}
                onChange={e => setBankAccountId(e.target.value)}
                className="w-full mt-1 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
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
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#0f3d63] text-white uppercase tracking-wider font-bold text-[10px]">
                <tr>
                  <th className="px-4 py-3">EMPLOYEE</th>
                  <th className="px-4 py-3">PAY TYPE</th>
                  <th className="px-4 py-3 w-28 text-center">REG HOURS</th>
                  <th className="px-4 py-3 w-28 text-center">OT HOURS</th>
                  <th className="px-4 py-3 text-right">GROSS PAY</th>
                  <th className="px-4 py-3 text-right">PAYE</th>
                  <th className="px-4 py-3 text-right">PENSION (5%)</th>
                  <th className="px-4 py-3 text-right">OTHER</th>
                  <th className="px-4 py-3 text-right">NET PAY</th>
                  <th className="px-4 py-3 text-right">ACTIONS</th>
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
              <div
                role="alert"
                className="px-4 py-3 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 text-xs flex items-start gap-2"
              >
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{runError}</span>
              </div>
            )}

            <button
              onClick={handleExecutePayroll}
              disabled={running}
              className="px-6 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold font-sans text-xs shadow-md transition-all active:scale-95 disabled:opacity-60 inline-flex items-center gap-1.5"
              title="Posts the payroll journal entry and pay stubs to the server"
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {running ? 'Posting to server…' : 'Authorize & Process Payroll'}
            </button>
          </div>
        </div>
      )}

      {/* 2. PAYROLL RUNS HISTORY */}
      {activeTab === 'runs' && (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-3">PAYROLL RUN #</th>
                  <th className="px-4 py-3">PAY DATE</th>
                  <th className="px-4 py-3">PAY PERIOD</th>
                  <th className="px-4 py-3 text-center">HEADCOUNT</th>
                  <th className="px-4 py-3 text-right">TOTAL GROSS</th>
                  <th className="px-4 py-3 text-right">TAXES WITHHELD</th>
                  <th className="px-4 py-3 text-right">NET DISBURSED</th>
                  <th className="px-4 py-3 text-center">STATUS</th>
                  <th className="px-4 py-3 text-right">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                {payrollRuns.map(run => (
                  <tr key={run.id} className="hover:bg-slate-50 dark:hover:bg-slate-850/50">
                    <td className="px-4 py-3 font-bold text-slate-900 dark:text-white">
                      {run.runNumber}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{run.payDate}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {run.payPeriodStart} to {run.payPeriodEnd}
                    </td>
                    <td className="px-4 py-3 text-center font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {run.items.length}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-slate-900 dark:text-white tabular-nums">
                      {formatCurrency(run.totalGross, currency)}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-500 tabular-nums">
                      {formatCurrency(run.totalEmployeeTaxes, currency)}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                      {formatCurrency(run.totalNet, currency)}
                    </td>
                    <td className="px-4 py-3 text-center font-sans">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        <CheckCircle2 className="w-3 h-3" /> Processed
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-sans">
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
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-3">EMPLOYEE NAME</th>
                  <th className="px-4 py-3">JOB TITLE / DEPARTMENT</th>
                  <th className="px-4 py-3">SSN (MASKED)</th>
                  <th className="px-4 py-3">COMPENSATION</th>
                  <th className="px-4 py-3">W-4 FILING STATUS</th>
                  <th className="px-4 py-3">DIRECT DEPOSIT ACH</th>
                  <th className="px-4 py-3">HIRE DATE</th>
                  <th className="px-4 py-3 text-right">ACTIONS</th>
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
      {selectedStubRun && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white text-slate-900 rounded-xl shadow-2xl border border-slate-300 overflow-hidden flex flex-col max-h-[92vh]">
            <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between no-print">
              <span className="font-bold text-sm">Official Employee Pay Stub</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-3 py-1 rounded bg-blue-600 text-white font-semibold text-xs"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Pay Stub</span>
                </button>
                <button
                  onClick={() => setSelectedStubRun(null)}
                  className="p-1 text-white/80 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Pay Stub Document */}
            {(() => {
              const emp = employees.find(e => e.id === selectedStubRun.item.employeeId);
              const item = selectedStubRun.item;
              const run = selectedStubRun.run;

              return (
                <div className="p-8 space-y-6 overflow-y-auto text-xs bg-white text-slate-900 font-sans">
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
          </div>
        </div>
      )}
    </div>
  );
};
