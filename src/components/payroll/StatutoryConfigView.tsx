import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Percent, RefreshCw, AlertTriangle } from 'lucide-react';
import {
  payrollConfigApi,
  PayeBand,
  StatutoryRate,
  StatutoryRateType,
} from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import { InlineAlert, Panel, StatusBadge } from '../common/ui';

/**
 * WS-4 R1 — configurable Malawi statutory engine.
 *
 * Rates live in effective-dated tables, never in code. `runPayroll` refuses to
 * execute when no PAYE band applies to the pay date, so this screen is the
 * authoritative source of the tax treatment.
 */
export const StatutoryConfigView: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [bands, setBands] = useState<PayeBand[]>([]);
  const [rates, setRates] = useState<StatutoryRate[]>([]);
  const [loading, setLoading] = useState(true);

  const [bandForm, setBandForm] = useState({ lowerBound: '', upperBound: '', rate: '' });
  const [rateForm, setRateForm] = useState<{
    rateType: StatutoryRateType;
    rate: string;
    basis: 'gross' | 'basic';
  }>({ rateType: 'pension_employee', rate: '', basis: 'gross' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await payrollConfigApi.statutoryConfig();
      setBands(res.bands || []);
      setRates(res.rates || []);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to load statutory configuration', 'error');
    } finally {
      setLoading(false);
    }
  }, [triggerShortcutNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const addBand = async () => {
    const lower = Number(bandForm.lowerBound);
    const ratePct = Number(bandForm.rate);
    if (!Number.isFinite(lower) || !Number.isFinite(ratePct)) {
      triggerShortcutNotice('Lower bound and rate are required', 'error');
      return;
    }
    try {
      await payrollConfigApi.createPayeBand({
        lowerBound: lower,
        upperBound: bandForm.upperBound ? Number(bandForm.upperBound) : null,
        rate: ratePct / 100,
      });
      setBandForm({ lowerBound: '', upperBound: '', rate: '' });
      triggerShortcutNotice('PAYE band added');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to add band', 'error');
    }
  };

  const addRate = async () => {
    const ratePct = Number(rateForm.rate);
    if (!Number.isFinite(ratePct)) {
      triggerShortcutNotice('Rate is required', 'error');
      return;
    }
    try {
      await payrollConfigApi.createStatutoryRate({
        rateType: rateForm.rateType,
        rate: ratePct / 100,
        basis: rateForm.basis,
      });
      setRateForm({ rateType: 'pension_employee', rate: '', basis: 'gross' });
      triggerShortcutNotice('Statutory rate added');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to add rate', 'error');
    }
  };

  const removeBand = async (id: number) => {
    try {
      await payrollConfigApi.deletePayeBand(id);
      triggerShortcutNotice('Band removed');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to remove band', 'error');
    }
  };

  const removeRate = async (id: number) => {
    try {
      await payrollConfigApi.deleteStatutoryRate(id);
      triggerShortcutNotice('Rate removed');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to remove rate', 'error');
    }
  };

  return (
    <div className="space-y-4">
      {bands.length === 0 && !loading && (
        <InlineAlert tone="warning">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              No PAYE bands are configured. Payroll will fail with <code>PAYE_NOT_CONFIGURED</code>{' '}
              until at least one band applies to the pay date.
            </span>
          </div>
        </InlineAlert>
      )}

      <Panel
        title="PAYE bands"
        description="Progressive bands applied to taxable pay. Rates are entered as percentages and stored as fractions."
        icon={<Percent className="h-4 w-4 text-brand-600" />}
        actions={
          <button type="button" onClick={load} disabled={loading} className="btn btn-secondary py-1.5 text-xs">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">From</span>
            <input
              type="number"
              min="0"
              value={bandForm.lowerBound}
              onChange={e => setBandForm({ ...bandForm, lowerBound: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 tabular-nums dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">To (blank = ∞)</span>
            <input
              type="number"
              min="0"
              value={bandForm.upperBound}
              onChange={e => setBandForm({ ...bandForm, upperBound: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 tabular-nums dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Rate %</span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={bandForm.rate}
              onChange={e => setBandForm({ ...bandForm, rate: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 tabular-nums dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <div className="flex items-end">
            <button type="button" onClick={addBand} className="btn btn-primary w-full">
              <Plus className="h-3.5 w-3.5" />
              Add band
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Band</th>
                <th className="text-right">From</th>
                <th className="text-right">To</th>
                <th className="text-right">Rate</th>
                <th className="text-right">Effective</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {bands.map((b, i) => (
                <tr key={b.id}>
                  <td className="font-mono">#{i + 1}</td>
                  <td className="text-right font-mono tabular-nums">{b.lowerBound}</td>
                  <td className="text-right font-mono tabular-nums">
                    {b.upperBound == null ? '∞' : b.upperBound}
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {(Number(b.rate) * 100).toFixed(2)}%
                  </td>
                  <td className="text-right text-xs text-slate-500">
                    {b.effectiveFrom}
                    {b.effectiveTo ? ` → ${b.effectiveTo}` : ''}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={() => removeBand(b.id)}
                      className="p-1 text-rose-500 hover:bg-rose-50 rounded"
                      title="Remove band"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {bands.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-xs text-slate-500">
                    No PAYE bands configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Statutory rates"
        description="Pension (employee/employer) and other statutory rates, effective-dated and applied to gross or basic pay."
        icon={<Percent className="h-4 w-4 text-emerald-600" />}
      >
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Type</span>
            <select
              value={rateForm.rateType}
              onChange={e =>
                setRateForm({ ...rateForm, rateType: e.target.value as StatutoryRateType })
              }
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="pension_employee">Pension — employee</option>
              <option value="pension_employer">Pension — employer</option>
              <option value="other_statutory">Other statutory</option>
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Rate %</span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={rateForm.rate}
              onChange={e => setRateForm({ ...rateForm, rate: e.target.value })}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 tabular-nums dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Basis</span>
            <select
              value={rateForm.basis}
              onChange={e =>
                setRateForm({ ...rateForm, basis: e.target.value as 'gross' | 'basic' })
              }
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="gross">Gross pay</option>
              <option value="basic">Basic pay</option>
            </select>
          </label>
          <div className="flex items-end">
            <button type="button" onClick={addRate} className="btn btn-primary w-full">
              <Plus className="h-3.5 w-3.5" />
              Add rate
            </button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th className="text-right">Rate</th>
                <th>Basis</th>
                <th className="text-right">Effective</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rates.map(r => (
                <tr key={r.id}>
                  <td>
                    <StatusBadge tone="info">{r.rateType}</StatusBadge>
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {(Number(r.rate) * 100).toFixed(2)}%
                  </td>
                  <td className="text-xs text-slate-500">{r.basis}</td>
                  <td className="text-right text-xs text-slate-500">
                    {r.effectiveFrom}
                    {r.effectiveTo ? ` → ${r.effectiveTo}` : ''}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={() => removeRate(r.id)}
                      className="p-1 text-rose-500 hover:bg-rose-50 rounded"
                      title="Remove rate"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {rates.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-xs text-slate-500">
                    No statutory rates configured.
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