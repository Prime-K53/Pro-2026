import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Truck, Users, Trash2, Gauge, IdCard } from 'lucide-react';
import { deliveryApi, Driver, Vehicle } from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import {
  EmptyState,
  FormField,
  InlineAlert,
  Panel,
  StatusBadge,
} from '../common/ui';

const BLANK_VEHICLE = { registration: '', make: '', model: '', capacityKg: '' };
const BLANK_DRIVER = { name: '', phone: '', licenseNumber: '', licenseExpiry: '' };

const statusTone = (status: string) =>
  status === 'active' ? 'success' : status === 'maintenance' ? 'warning' : 'neutral';

export const VehicleManagement: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(BLANK_VEHICLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await deliveryApi.vehicles();
      setVehicles(res.vehicles || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load vehicles');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    if (!form.registration.trim()) {
      setError('Registration is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deliveryApi.createVehicle({
        registration: form.registration.trim().toUpperCase(),
        make: form.make.trim() || undefined,
        model: form.model.trim() || undefined,
        capacityKg: form.capacityKg ? Number(form.capacityKg) : undefined,
      });
      triggerShortcutNotice?.('Vehicle added');
      setShowForm(false);
      setForm(BLANK_VEHICLE);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to add vehicle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Vehicles"
      description="Fleet register used when assigning deliveries."
      icon={<Truck className="h-4 w-4 text-brand-600" />}
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
          Add vehicle
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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <FormField label="Registration" required>
                <input
                  value={form.registration}
                  onChange={e => setForm({ ...form, registration: e.target.value })}
                  className="app-input app-input-mono uppercase"
                  placeholder="BT 1234"
                />
              </FormField>
              <FormField label="Make">
                <input
                  value={form.make}
                  onChange={e => setForm({ ...form, make: e.target.value })}
                  className="app-input"
                  placeholder="Toyota"
                />
              </FormField>
              <FormField label="Model">
                <input
                  value={form.model}
                  onChange={e => setForm({ ...form, model: e.target.value })}
                  className="app-input"
                  placeholder="Hiace"
                />
              </FormField>
              <FormField label="Capacity (kg)">
                <input
                  type="number"
                  min="0"
                  value={form.capacityKg}
                  onChange={e => setForm({ ...form, capacityKg: e.target.value })}
                  className="app-input app-input-mono"
                  placeholder="1200"
                />
              </FormField>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={submit} disabled={busy} className="btn btn-primary">
                <Plus className="h-4 w-4" />
                {busy ? 'Adding…' : 'Add vehicle'}
              </button>
            </div>
          </div>
        )}

        {vehicles.length === 0 ? (
          <EmptyState
            title="No vehicles"
            description="Add a vehicle before scheduling deliveries."
            icon={<Truck className="h-6 w-6" />}
          />
        ) : (
          <ul className="space-y-2">
            {vehicles.map(v => (
              <li
                key={v.id}
                className="surface surface-hover flex flex-wrap items-center justify-between gap-3 p-3.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100 ring-inset dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20">
                    <Truck className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">
                      {v.registration}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      <span>
                        {[v.make, v.model].filter(Boolean).join(' ') || 'Make / model not set'}
                      </span>
                      {v.capacityKg != null && (
                        <span className="inline-flex items-center gap-1">
                          <Gauge className="h-3 w-3" />
                          {v.capacityKg} kg
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <StatusBadge tone={statusTone(v.status)}>{v.status}</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
};

export const DriverManagement: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(BLANK_DRIVER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await deliveryApi.drivers();
      setDrivers(res.drivers || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load drivers');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    if (!form.name.trim() || !form.licenseNumber.trim()) {
      setError('Name and licence number are required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deliveryApi.createDriver({
        name: form.name.trim(),
        phone: form.phone.trim() || undefined,
        licenseNumber: form.licenseNumber.trim(),
        licenseExpiry: form.licenseExpiry || undefined,
      });
      triggerShortcutNotice?.('Driver added');
      setShowForm(false);
      setForm(BLANK_DRIVER);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to add driver');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Drivers"
      description="Driver register. Licence expiry is shown so assignments can be blocked when invalid."
      icon={<Users className="h-4 w-4 text-brand-600" />}
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
          Add driver
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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <FormField label="Name" required>
                <input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="app-input"
                  placeholder="Full name"
                />
              </FormField>
              <FormField label="Phone">
                <input
                  value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  className="app-input app-input-mono"
                  placeholder="+265…"
                />
              </FormField>
              <FormField label="Licence number" required>
                <input
                  value={form.licenseNumber}
                  onChange={e => setForm({ ...form, licenseNumber: e.target.value })}
                  className="app-input app-input-mono"
                />
              </FormField>
              <FormField label="Licence expiry">
                <input
                  type="date"
                  value={form.licenseExpiry}
                  onChange={e => setForm({ ...form, licenseExpiry: e.target.value })}
                  className="app-input"
                />
              </FormField>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={submit} disabled={busy} className="btn btn-primary">
                <Plus className="h-4 w-4" />
                {busy ? 'Adding…' : 'Add driver'}
              </button>
            </div>
          </div>
        )}

        {drivers.length === 0 ? (
          <EmptyState
            title="No drivers"
            description="Add a driver before assigning deliveries."
            icon={<Users className="h-6 w-6" />}
          />
        ) : (
          <ul className="space-y-2">
            {drivers.map(d => {
              const expired =
                !!d.licenseExpiry && new Date(d.licenseExpiry).getTime() < Date.now();
              return (
                <li
                  key={d.id}
                  className="surface surface-hover flex flex-wrap items-center justify-between gap-3 p-3.5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-white/[0.05] dark:text-slate-400">
                      <Users className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 dark:text-white">
                        {d.name}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                        <span className="inline-flex items-center gap-1 font-mono">
                          <IdCard className="h-3 w-3" />
                          {d.licenseNumber}
                        </span>
                        {d.phone && <span className="font-mono">{d.phone}</span>}
                        {d.licenseExpiry && (
                          <span className={expired ? 'text-rose-600 dark:text-rose-400' : ''}>
                            expires {new Date(d.licenseExpiry).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <StatusBadge tone={expired ? 'danger' : statusTone(d.status)}>
                    {expired ? 'Licence expired' : d.status}
                  </StatusBadge>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
};