import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Settings, Percent, Coins } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';
import { requestJson } from '../../services/http';
import {
  EmptyState,
  FormField,
  InlineAlert,
  Panel,
  StatusBadge,
} from '../common/ui';

interface DeductionRule {
  id: number;
  name: string;
  deductionType: string;
  calculationMethod: string;
  formula: string | null;
  applicableTo: string;
}

const BLANK = {
  deductionType: 'tax',
  name: '',
  calculationMethod: 'percentage',
  formula: '',
  applicableTo: 'all',
};

const METHOD_ICON: Record<string, React.ElementType> = {
  percentage: Percent,
  tiered: Settings,
  statutory: Settings,
  fixed: Coins,
};

export const DeductionRulesView: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [rules, setRules] = useState<DeductionRule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await requestJson<{ rules: DeductionRule[] }>(
        '/api/payroll/deduction-rules'
      );
      setRules(res.rules || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load deduction rules');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    if (!form.name.trim()) {
      setError('Rule name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestJson('/api/payroll/deduction-rules', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      triggerShortcutNotice?.('Rule created');
      setShowForm(false);
      setForm(BLANK);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to create rule');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (rule: DeductionRule) => {
    if (!confirm(`Delete deduction rule "${rule.name}"?`)) return;
    try {
      await requestJson(`/api/payroll/deduction-rules/${rule.id}`, { method: 'DELETE' });
      triggerShortcutNotice?.('Rule deleted');
      await load();
    } catch (err: any) {
      triggerShortcutNotice?.(err?.message || 'Failed to delete rule', 'error');
    }
  };

  return (
    <Panel
      title="Deduction rules"
      description="Configurable deductions applied during a payroll run. Rates themselves are effective-dated in Statutory Config."
      icon={<Settings className="h-4 w-4 text-brand-600" />}
      actions={
        <button
          type="button"
          onClick={() => {
            setError(null);
            setShowForm(v => !v);
          }}
          className="btn btn-secondary py-1.5 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          New rule
        </button>
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
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Rule name" required>
                <input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="app-input"
                  placeholder="e.g. Pension top-up"
                />
              </FormField>
              <FormField label="Deduction type">
                <select
                  value={form.deductionType}
                  onChange={e => setForm({ ...form, deductionType: e.target.value })}
                  className="app-input"
                >
                  <option value="tax">Tax</option>
                  <option value="pension">Pension</option>
                  <option value="loan">Loan</option>
                  <option value="other">Other</option>
                </select>
              </FormField>
              <FormField label="Calculation method">
                <select
                  value={form.calculationMethod}
                  onChange={e => setForm({ ...form, calculationMethod: e.target.value })}
                  className="app-input"
                >
                  <option value="fixed">Fixed</option>
                  <option value="percentage">Percentage</option>
                  <option value="tiered">Tiered</option>
                  <option value="statutory">Statutory</option>
                </select>
              </FormField>
              <FormField label="Applies to">
                <select
                  value={form.applicableTo}
                  onChange={e => setForm({ ...form, applicableTo: e.target.value })}
                  className="app-input"
                >
                  <option value="all">All employees</option>
                  <option value="permanent">Permanent staff</option>
                  <option value="contract">Contract staff</option>
                </select>
              </FormField>
              <FormField
                label="Formula"
                hint="e.g. 10%, a fixed amount, or a statutory reference."
                className="sm:col-span-2"
              >
                <input
                  value={form.formula}
                  onChange={e => setForm({ ...form, formula: e.target.value })}
                  className="app-input app-input-mono"
                  placeholder="10%"
                />
              </FormField>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={submit} disabled={busy} className="btn btn-primary">
                <Plus className="h-4 w-4" />
                {busy ? 'Creating…' : 'Create rule'}
              </button>
            </div>
          </div>
        )}

        {rules.length === 0 ? (
          <EmptyState
            title="No deduction rules"
            description="Create a rule to apply recurring statutory or voluntary deductions during a run."
            icon={<Settings className="h-6 w-6" />}
          />
        ) : (
          <ul className="space-y-2">
            {rules.map(r => {
              const Icon = METHOD_ICON[r.calculationMethod] || Settings;
              return (
                <li
                  key={r.id}
                  className="surface surface-hover flex flex-wrap items-center justify-between gap-3 p-3.5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100 ring-inset dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold text-slate-900 dark:text-white">
                          {r.name}
                        </span>
                        <StatusBadge tone="info">{r.deductionType}</StatusBadge>
                        <StatusBadge tone="neutral">{r.calculationMethod}</StatusBadge>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                        Applies to {r.applicableTo}
                        {r.formula ? ` · ${r.formula}` : ''}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(r)}
                    title="Delete rule"
                    className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
};