import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, MapPin, Star, Truck, RotateCcw } from 'lucide-react';
import { customerBranchApi, CustomerBranch } from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import {
  EmptyState,
  FormField,
  ModalFooter,
  ModalHeader,
  ModalShell,
  Panel,
  StatusBadge,
} from '../common/ui';
import { appDialog } from '../../design-system';

interface CustomerBranchesTabProps {
  customerId: number;
}

const BLANK: Partial<CustomerBranch> = {
  branchName: '',
  address: '',
  phone: '',
  isBillingDefault: false,
  isShippingDefault: false,
  deliveryInstructions: '',
};

/**
 * WS-3 C2 / C5 — multiple addresses as first-class rows with validated
 * billing/shipping defaults, and soft deactivation that preserves history.
 */
export const CustomerBranchesTab: React.FC<CustomerBranchesTabProps> = ({ customerId }) => {
  const { triggerShortcutNotice } = useAccounting();
  const [branches, setBranches] = useState<CustomerBranch[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<Partial<CustomerBranch>>(BLANK);
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await customerBranchApi.list(customerId, showInactive);
      setBranches(res.branches || []);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to load branches', 'error');
    }
  }, [customerId, showInactive, triggerShortcutNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setForm(BLANK);
    setError(null);
    setShowForm(true);
  };

  const openEdit = (branch: CustomerBranch) => {
    setEditingId(branch.id);
    setForm(branch);
    setError(null);
    setShowForm(true);
  };

  const submit = async () => {
    if (!form.branchName?.trim()) {
      setError('Branch name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await customerBranchApi.update(customerId, editingId, form);
        triggerShortcutNotice('Branch updated');
      } else {
        await customerBranchApi.create(customerId, form);
        triggerShortcutNotice('Branch added');
      }
      setShowForm(false);
      setEditingId(null);
      setForm(BLANK);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to save branch');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (branch: CustomerBranch) => {
    const confirmed = await appDialog.confirm({
      title: 'Deactivate Branch',
      message: `Deactivate branch "${branch.branchName}"? Historical documents keep referencing it.`,
      confirmLabel: 'Deactivate',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await customerBranchApi.remove(customerId, branch.id);
      triggerShortcutNotice('Branch deactivated');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to deactivate branch', 'error');
    }
  };

  const reactivate = async (branch: CustomerBranch) => {
    try {
      await customerBranchApi.reactivate(customerId, branch.id);
      triggerShortcutNotice('Branch reactivated');
      await load();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to reactivate branch', 'error');
    }
  };

  return (
    <Panel
      title="Branches & addresses"
      description="Billing and delivery addresses for this customer. Defaults are unique per customer."
      icon={<MapPin className="h-4 w-4 text-brand-600" />}
      actions={
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => setShowInactive(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            Show inactive
          </label>
          <button type="button" onClick={openCreate} className="btn btn-secondary py-1.5 text-xs">
            <Plus className="h-3.5 w-3.5" />
            Add branch
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        {branches.length === 0 ? (
          <EmptyState
            title="No branches yet"
            description="Add an address to enable multi-branch billing and delivery."
            icon={<MapPin className="h-6 w-6" />}
            action={
              <button type="button" onClick={openCreate} className="btn btn-primary">
                <Plus className="h-4 w-4" />
                Add branch
              </button>
            }
          />
        ) : (
          <ul className="space-y-2">
            {branches.map(branch => (
              <li
                key={branch.id}
                className={`surface surface-hover flex flex-wrap items-start justify-between gap-3 p-3.5 ${
                  branch.isActive ? '' : 'opacity-60'
                }`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-white/[0.05] dark:text-slate-400">
                    <MapPin className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">
                        {branch.branchName}
                      </span>
                      {!branch.isActive && <StatusBadge tone="neutral">Inactive</StatusBadge>}
                      {branch.isBillingDefault && (
                        <StatusBadge tone="info">
                          <Star className="h-3 w-3" />
                          Billing
                        </StatusBadge>
                      )}
                      {branch.isShippingDefault && (
                        <StatusBadge tone="success">
                          <Truck className="h-3 w-3" />
                          Shipping
                        </StatusBadge>
                      )}
                    </div>
                    {branch.address && (
                      <div className="mt-0.5 truncate text-[12px] text-slate-500 dark:text-slate-400">
                        {branch.address}
                      </div>
                    )}
                    {(branch.phone || branch.deliveryInstructions) && (
                      <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                        {branch.phone && (
                          <span className="font-mono tabular-nums">{branch.phone}</span>
                        )}
                        {branch.deliveryInstructions && (
                          <span className="truncate">{branch.deliveryInstructions}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {branch.isActive ? (
                    <>
                      <button
                        type="button"
                        onClick={() => openEdit(branch)}
                        title="Edit branch"
                        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-brand-50 hover:text-brand-600 dark:hover:bg-white/[0.06] dark:hover:text-brand-300"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(branch)}
                        title="Deactivate branch"
                        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => reactivate(branch)}
                      title="Reactivate branch"
                      className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showForm && (
        <ModalShell open onClose={() => setShowForm(false)} size="md" titleId="branch-form-title">
          <ModalHeader
            title={editingId ? 'Edit branch' : 'Add branch'}
            subtitle="Billing and shipping defaults are validated per customer."
            icon={<MapPin className="h-4 w-4" />}
            tone="brand"
            onClose={() => setShowForm(false)}
          />
          <div className="space-y-4 overflow-y-auto p-5">
            <FormField label="Branch name" required>
              <input
                value={form.branchName || ''}
                onChange={e => setForm({ ...form, branchName: e.target.value })}
                className="app-input"
                placeholder="e.g. Blantyre depot"
              />
            </FormField>
            <FormField label="Address">
              <textarea
                value={form.address || ''}
                onChange={e => setForm({ ...form, address: e.target.value })}
                rows={2}
                className="app-input resize-none"
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Phone">
                <input
                  value={form.phone || ''}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  className="app-input app-input-mono"
                  placeholder="+265…"
                />
              </FormField>
              <FormField label="Delivery instructions">
                <input
                  value={form.deliveryInstructions || ''}
                  onChange={e => setForm({ ...form, deliveryInstructions: e.target.value })}
                  className="app-input"
                  placeholder="Gate code, landmark…"
                />
              </FormField>
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={!!form.isBillingDefault}
                  onChange={e => setForm({ ...form, isBillingDefault: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                <Star className="h-3.5 w-3.5" />
                Billing default
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={!!form.isShippingDefault}
                  onChange={e => setForm({ ...form, isShippingDefault: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                <Truck className="h-3.5 w-3.5" />
                Shipping default
              </label>
            </div>
            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-800 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-200">
                {error}
              </div>
            )}
          </div>
          <ModalFooter
            onCancel={() => setShowForm(false)}
            onSubmit={submit}
            submitLabel={editingId ? 'Update branch' : 'Add branch'}
            submitIcon={<Plus className="h-4 w-4" />}
            busy={busy}
          />
        </ModalShell>
      )}
    </Panel>
  );
};