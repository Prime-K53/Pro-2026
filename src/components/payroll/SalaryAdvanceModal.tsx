import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Wallet, Calendar, X } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';
import { requestJson } from '../../services/http';
import { formatCurrency } from '../../utils/currency';
import {
  EmptyState,
  FormField,
  InlineAlert,
  Panel,
  StatusBadge,
} from '../common/ui';

interface SalaryAdvance {
  id: number;
  employeeId: number;
  amount: string;
  status: string;
  createdAt: string;
}

interface EmployeeLite {
  id: number;
  firstName: string;
  lastName: string;
}

export const SalaryAdvanceModal: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { triggerShortcutNotice, companyProfile } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [advances, setAdvances] = useState<SalaryAdvance[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [form, setForm] = useState({ employeeId: '', amount: '', repaymentMonths: '6' });
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [adv, emp] = await Promise.all([
        requestJson<{ advances: SalaryAdvance[] }>('/api/payroll/advances'),
        requestJson<{ employees: EmployeeLite[] }>('/api/employees'),
      ]);
      setAdvances(adv.advances || []);
      setEmployees(emp.employees || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load salary advances');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const empName = (id: number) => {
    const e = employees.find(x => String(x.id) === String(id));
    return e ? `${e.firstName} ${e.lastName}` : `Employee #${id}`;
  };

  const submit = async () => {
    const months = Number(form.repaymentMonths);
    if (!form.employeeId || !form.amount || !months) {
      setError('Employee, amount and repayment months are required');
      return;
    }
    const amt = Number(form.amount) / months;
    const repaymentSchedule = Array.from({ length: months }, (_, i) => ({
      month: i + 1,
      amount: Number(amt.toFixed(2)),
    }));
    setBusy(true);
    setError(null);
    try {
      await requestJson('/api/payroll/advances', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: Number(form.employeeId),
          amount: Number(form.amount),
          repaymentSchedule,
        }),
      });
      triggerShortcutNotice?.('Advance created');
      setShowForm(false);
      setForm({ employeeId: '', amount: '', repaymentMonths: '6' });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to create advance');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (advance: SalaryAdvance) => {
    if (!confirm('Cancel this salary advance?')) return;
    try {
      await requestJson(`/api/payroll/advances/${advance.id}`, { method: 'DELETE' });
      triggerShortcutNotice?.('Advance cancelled');
      await load();
    } catch (err: any) {
      triggerShortcutNotice?.(err?.message || 'Failed to cancel advance', 'error');
    }
  };

  return (
    <Panel
      title="Salary advances"
      description="Advances are recovered from net pay on a fixed instalment schedule."
      icon={<Wallet className="h-4 w-4 text-brand-600" />}
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setShowForm(v => !v);
            }}
            className="btn btn-secondary py-1.5 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            New advance
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close"
              className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/[0.06] dark:hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <InlineAlert tone="error" onDismiss={() => setError(null)}>
            {error}
          </InlineAlert>
        )}

        {showForm && (
          <div className="surface space-y-3 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label="Employee" required>
                <select
                  value={form.employeeId}
                  onChange={e => setForm({ ...form, employeeId: e.target.value })}
                  className="app-input"
                >
                  <option value="">Select employee</option>
                  {employees.map(e => (
                    <option key={e.id} value={e.id}>
                      {e.firstName} {e.lastName}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Amount" required>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.amount}
                  onChange={e => setForm({ ...form, amount: e.target.value })}
                  placeholder="0.00"
                  className="app-input app-input-mono"
                />
              </FormField>
              <FormField label="Repayment months" required>
                <input
                  type="number"
                  min="1"
                  value={form.repaymentMonths}
                  onChange={e => setForm({ ...form, repaymentMonths: e.target.value })}
                  className="app-input app-input-mono"
                />
              </FormField>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {Number(form.amount) > 0 && Number(form.repaymentMonths) > 0 ? (
                  <>
                    Instalment{' '}
                    <span className="font-mono font-semibold">
                      {formatCurrency(
                        Number(form.amount) / Number(form.repaymentMonths),
                        currency
                      )}
                    </span>{' '}
                    per month
                  </>
                ) : (
                  'Enter an amount to preview the instalment.'
                )}
              </p>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="btn btn-primary"
              >
                <Plus className="h-4 w-4" />
                {busy ? 'Creating…' : 'Create advance'}
              </button>
            </div>
          </div>
        )}

        {advances.length === 0 ? (
          <EmptyState
            title="No salary advances"
            description="Advances appear here once recorded and reduce net pay each run until repaid."
            icon={<Wallet className="h-6 w-6" />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                  <th className="text-right">Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {advances.map(a => (
                  <tr key={a.id}>
                    <td className="font-medium text-slate-800 dark:text-slate-200">
                      {empName(a.employeeId)}
                    </td>
                    <td className="text-right font-mono font-semibold tabular-nums">
                      {formatCurrency(Number(a.amount), currency)}
                    </td>
                    <td>
                      <StatusBadge
                        tone={a.status === 'active' ? 'warning' : a.status === 'repaid' ? 'success' : 'neutral'}
                      >
                        {a.status}
                      </StatusBadge>
                    </td>
                    <td className="text-right text-xs text-slate-500 dark:text-slate-400">
                      {a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        onClick={() => remove(a)}
                        title="Cancel advance"
                        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
};