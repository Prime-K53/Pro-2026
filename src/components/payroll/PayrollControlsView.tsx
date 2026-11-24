import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, RefreshCw, Wallet, ReceiptText } from 'lucide-react';
import {
  payrollConfigApi,
  SalaryStructure,
  EmployeeLoan,
  EmployeeDeduction,
} from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { InlineAlert, Panel, StatusBadge } from '../common/ui';

/**
 * WS-4 R2 / R3 — effective-dated salary structures and employee loan /
 * deduction balances.
 *
 * A payroll run resolves the structure effective on the pay date, so history
 * stays period-correct. Loan instalments and recurring deductions are applied
 * by the run itself; balances reduce as repayments post.
 */
export const PayrollControlsView: React.FC = () => {
  const { employees, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [structures, setStructures] = useState<SalaryStructure[]>([]);
  const [loans, setLoans] = useState<EmployeeLoan[]>([]);
  const [deductions, setDeductions] = useState<EmployeeDeduction[]>([]);
  const [loading, setLoading] = useState(true);

  const [structureForm, setStructureForm] = useState({
    employeeId: '',
    payType: 'salary',
    payRate: '',
    payFrequency: 'monthly',
  });
  const [loanForm, setLoanForm] = useState({ employeeId: '', principal: '', installment: '' });
  const [deductionForm, setDeductionForm] = useState({
    employeeId: '',
    deductionType: 'pension_top_up',
    amount: '',
    calculationMethod: 'fixed' as 'fixed' | 'percentage',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, l, d] = await Promise.all([
        payrollConfigApi.salaryStructures(),
        payrollConfigApi.loans(),
        payrollConfigApi.deductions(),
      ]);
      setStructures(s.structures || []);
      setLoans(l.loans || []);
      setDeductions(d.deductions || []);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to load payroll controls', 'error');
    } finally {
      setLoading(false);
    }
  }, [triggerShortcutNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const empName = (id: number) => {
    const e = employees.find(x => String(x.id) === String(id));
    return e ? `${e.firstName} ${e.lastName}` : `Employee #${id}`;
  };

  const addStructure = async () => {
    if (!structureForm.employeeId || !structureForm.payRate) {
      triggerShortcutNotice('Employee and pay rate are required', 'error');
      return;
    }
    try {
      await payrollConfigApi.createSalaryStructure({
        employeeId: Number(structureForm.employeeId),
        payType: structureForm.payType as 'salary' | 'hourly',
        payRate: Number(structureForm.payRate),
        payFrequency: structureForm.payFrequency,
      });
      setStructureForm({ employeeId: '', payType: 'salary', payRate: '', payFrequency: 'monthly' });
      triggerShortcutNotice('Salary structure added');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to add structure', 'error');
    }
  };

  const addLoan = async () => {
    if (!loanForm.employeeId || !loanForm.principal || !loanForm.installment) {
      triggerShortcutNotice('Employee, principal and instalment are required', 'error');
      return;
    }
    try {
      await payrollConfigApi.createLoan({
        employeeId: Number(loanForm.employeeId),
        principal: Number(loanForm.principal),
        installment: Number(loanForm.installment),
      });
      setLoanForm({ employeeId: '', principal: '', installment: '' });
      triggerShortcutNotice('Loan created');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to create loan', 'error');
    }
  };

  const addDeduction = async () => {
    if (!deductionForm.employeeId || !deductionForm.amount) {
      triggerShortcutNotice('Employee and amount are required', 'error');
      return;
    }
    try {
      await payrollConfigApi.createDeduction({
        employeeId: Number(deductionForm.employeeId),
        deductionType: deductionForm.deductionType,
        amount: Number(deductionForm.amount),
        calculationMethod: deductionForm.calculationMethod,
      });
      setDeductionForm({
        employeeId: '',
        deductionType: 'pension_top_up',
        amount: '',
        calculationMethod: 'fixed',
      });
      triggerShortcutNotice('Deduction added');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to add deduction', 'error');
    }
  };

  const employeeSelect = (value: string, onChange: (v: string) => void) => (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
    >
      <option value="">Select employee…</option>
      {employees.map(e => (
        <option key={e.id} value={e.id}>
          {e.firstName} {e.lastName}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-4">
      {loading && <p className="text-sm text-slate-500">Loading…</p>}

      {structures.length === 0 && !loading && (
        <InlineAlert tone="info">
          No salary structures yet. A run falls back to the employee master rate until one is
          configured for the pay date.
        </InlineAlert>
      )}

      <Panel
        title="Salary structures"
        description="Effective-dated pay. The structure effective on the pay date wins, so historical runs stay period-correct."
        icon={<Wallet className="h-4 w-4 text-brand-600" />}
        actions={
          <button type="button" onClick={load} className="btn btn-secondary py-1.5 text-xs">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Employee</span>
            {employeeSelect(structureForm.employeeId, v =>
              setStructureForm({ ...structureForm, employeeId: v })
            )}
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Pay type</span>
            <select
              value={structureForm.payType}
              onChange={e => setStructureForm({ ...structureForm, payType: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="salary">Salary</option>
              <option value="hourly">Hourly</option>
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Rate</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={structureForm.payRate}
              onChange={e => setStructureForm({ ...structureForm, payRate: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 tabular-nums dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Frequency</span>
            <select
              value={structureForm.payFrequency}
              onChange={e => setStructureForm({ ...structureForm, payFrequency: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={addStructure} className="btn btn-primary">
            <Plus className="h-3.5 w-3.5" />
            Add structure
          </button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Type</th>
                <th className="text-right">Rate</th>
                <th>Frequency</th>
                <th className="text-right">Effective</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {structures.map(s => (
                <tr key={s.id}>
                  <td>{empName(s.employeeId)}</td>
                  <td className="capitalize">{s.payType}</td>
                  <td className="text-right font-mono tabular-nums">
                    {formatCurrency(Number(s.payRate), currency)}
                  </td>
                  <td className="text-xs text-slate-500">{s.payFrequency}</td>
                  <td className="text-right text-xs text-slate-500">
                    {s.effectiveFrom}
                    {s.effectiveTo ? ` → ${s.effectiveTo}` : ''}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await payrollConfigApi.deleteSalaryStructure(s.id);
                          triggerShortcutNotice('Structure removed');
                          await load();
                        } catch (err: any) {
                          triggerShortcutNotice(err?.message || 'Failed to remove', 'error');
                        }
                      }}
                      className="p-1 text-rose-500 hover:bg-rose-50 rounded"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {structures.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-xs text-slate-500">
                    No salary structures.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Employee loans"
          description="Each run applies the next instalment and reduces the outstanding balance."
          icon={<ReceiptText className="h-4 w-4 text-amber-600" />}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Employee</span>
              {employeeSelect(loanForm.employeeId, v => setLoanForm({ ...loanForm, employeeId: v }))}
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Principal</span>
              <input
                type="number"
                min="0"
                value={loanForm.principal}
                onChange={e => setLoanForm({ ...loanForm, principal: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 tabular-nums dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Instalment</span>
              <input
                type="number"
                min="0"
                value={loanForm.installment}
                onChange={e => setLoanForm({ ...loanForm, installment: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 tabular-nums dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button type="button" onClick={addLoan} className="btn btn-primary">
              <Plus className="h-3.5 w-3.5" />
              Add loan
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {loans.map(l => (
              <div
                key={l.id}
                className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-white/[0.07]"
              >
                <div>
                  <div className="font-medium text-slate-800 dark:text-slate-200">
                    {empName(l.employeeId)}
                  </div>
                  <div className="text-slate-500">
                    Instalment {formatCurrency(Number(l.installment), currency)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono font-semibold tabular-nums">
                    {formatCurrency(Number(l.balance), currency)}
                  </div>
                  <StatusBadge tone={l.status === 'active' ? 'warning' : 'success'}>
                    {l.status}
                  </StatusBadge>
                </div>
              </div>
            ))}
            {loans.length === 0 && (
              <p className="py-4 text-center text-xs text-slate-500">No loans.</p>
            )}
          </div>
        </Panel>

        <Panel
          title="Employee deductions"
          description="Fixed or percentage deductions applied every run until removed."
          icon={<ReceiptText className="h-4 w-4 text-rose-600" />}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Employee</span>
              {employeeSelect(deductionForm.employeeId, v =>
                setDeductionForm({ ...deductionForm, employeeId: v })
              )}
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Type</span>
              <input
                value={deductionForm.deductionType}
                onChange={e => setDeductionForm({ ...deductionForm, deductionType: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                Amount {deductionForm.calculationMethod === 'percentage' ? '(%)' : ''}
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={deductionForm.amount}
                onChange={e => setDeductionForm({ ...deductionForm, amount: e.target.value })}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 tabular-nums dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Method</span>
              <select
                value={deductionForm.calculationMethod}
                onChange={e =>
                  setDeductionForm({
                    ...deductionForm,
                    calculationMethod: e.target.value as 'fixed' | 'percentage',
                  })
                }
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="fixed">Fixed</option>
                <option value="percentage">Percentage</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button type="button" onClick={addDeduction} className="btn btn-primary">
              <Plus className="h-3.5 w-3.5" />
              Add deduction
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {deductions.map(d => (
              <div
                key={d.id}
                className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-white/[0.07]"
              >
                <div>
                  <div className="font-medium text-slate-800 dark:text-slate-200">
                    {empName(d.employeeId)}
                  </div>
                  <div className="text-slate-500">{d.deductionType}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono font-semibold tabular-nums">
                    {formatCurrency(Number(d.amount), currency)}
                    {d.calculationMethod === 'percentage' ? '%' : ''}
                  </div>
                  <StatusBadge tone="neutral">{d.calculationMethod}</StatusBadge>
                </div>
              </div>
            ))}
            {deductions.length === 0 && (
              <p className="py-4 text-center text-xs text-slate-500">No deductions.</p>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
};