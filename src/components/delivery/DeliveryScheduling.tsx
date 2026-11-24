import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Plus, RefreshCw, Truck, User } from 'lucide-react';
import { deliveryApi, DeliverySchedule, Driver, Vehicle } from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import { InlineAlert, Panel, StatusBadge } from '../common/ui';

/**
 * WS-5 D1 / D3 — scheduling with conflict detection.
 *
 * The server rejects a driver or vehicle that is already booked in an
 * overlapping window (409), so a double-booking cannot be saved from here.
 */
export const DeliveryScheduling: React.FC = () => {
  const { triggerShortcutNotice } = useAccounting();
  const [schedules, setSchedules] = useState<DeliverySchedule[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);

  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    deliveryNoteId: '',
    scheduledDate: today,
    timeWindow: '',
    assignedDriverId: '',
    assignedVehicleId: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, v, d] = await Promise.all([
        deliveryApi.schedules(),
        deliveryApi.vehicles(),
        deliveryApi.drivers(),
      ]);
      setSchedules(s.schedules || []);
      setVehicles(v.vehicles || []);
      setDrivers(d.drivers || []);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to load delivery schedule', 'error');
    } finally {
      setLoading(false);
    }
  }, [triggerShortcutNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const vehicleLabel = useMemo(() => {
    const map = new Map<number, string>();
    vehicles.forEach(v => map.set(v.id, v.registration));
    return map;
  }, [vehicles]);

  const driverLabel = useMemo(() => {
    const map = new Map<number, string>();
    drivers.forEach(d => map.set(d.id, d.name));
    return map;
  }, [drivers]);

  const create = async () => {
    if (!form.deliveryNoteId || !form.scheduledDate) {
      triggerShortcutNotice('Delivery note and scheduled date are required', 'error');
      return;
    }
    try {
      await deliveryApi.createSchedule({
        deliveryNoteId: Number(form.deliveryNoteId),
        scheduledDate: form.scheduledDate,
        timeWindow: form.timeWindow || undefined,
        assignedDriverId: form.assignedDriverId ? Number(form.assignedDriverId) : undefined,
        assignedVehicleId: form.assignedVehicleId ? Number(form.assignedVehicleId) : undefined,
      });
      setForm({ ...form, deliveryNoteId: '', timeWindow: '', assignedDriverId: '', assignedVehicleId: '' });
      triggerShortcutNotice('Delivery scheduled');
      await load();
    } catch (err: any) {
      const msg = err?.message || 'Failed to schedule delivery';
      triggerShortcutNotice(msg, 'error');
    }
  };

  return (
    <Panel
      title="Delivery scheduling"
      description="Assign a vehicle and driver to a delivery note. Overlapping driver or vehicle bookings are rejected."
      icon={<CalendarClock className="h-4 w-4 text-indigo-600" />}
      actions={
        <button type="button" onClick={load} disabled={loading} className="btn btn-secondary py-1.5 text-xs">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-5">
        <label className="block text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Delivery note</span>
          <input
            value={form.deliveryNoteId}
            onChange={e => setForm({ ...form, deliveryNoteId: e.target.value })}
            placeholder="Note id"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 tabular-nums dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <label className="block text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Date</span>
          <input
            type="date"
            value={form.scheduledDate}
            onChange={e => setForm({ ...form, scheduledDate: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <label className="block text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Window</span>
          <input
            value={form.timeWindow}
            onChange={e => setForm({ ...form, timeWindow: e.target.value })}
            placeholder="09:00–12:00"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <label className="block text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-300">
            <Truck className="mr-1 inline h-3 w-3" /> Vehicle
          </span>
          <select
            value={form.assignedVehicleId}
            onChange={e => setForm({ ...form, assignedVehicleId: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="">Unassigned</option>
            {vehicles.map(v => (
              <option key={v.id} value={v.id}>
                {v.registration}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-300">
            <User className="mr-1 inline h-3 w-3" /> Driver
          </span>
          <select
            value={form.assignedDriverId}
            onChange={e => setForm({ ...form, assignedDriverId: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="">Unassigned</option>
            {drivers.map(d => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3 flex justify-end">
        <button type="button" onClick={create} className="btn btn-primary">
          <Plus className="h-3.5 w-3.5" />
          Schedule delivery
        </button>
      </div>

      <div className="mt-4">
        {schedules.length === 0 ? (
          <InlineAlert tone="info">No deliveries scheduled yet.</InlineAlert>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Note</th>
                  <th>Date</th>
                  <th>Window</th>
                  <th>Vehicle</th>
                  <th>Driver</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map(s => (
                  <tr key={s.id}>
                    <td className="font-mono">#{s.deliveryNoteId}</td>
                    <td className="whitespace-nowrap">{s.scheduledDate}</td>
                    <td className="text-xs text-slate-500">{s.timeWindow || '—'}</td>
                    <td>{s.assignedVehicleId ? vehicleLabel.get(s.assignedVehicleId) || '—' : '—'}</td>
                    <td>{s.assignedDriverId ? driverLabel.get(s.assignedDriverId) || '—' : '—'}</td>
                    <td>
                      <StatusBadge
                        tone={s.status === 'delivered' ? 'success' : s.status === 'failed' ? 'danger' : 'info'}
                      >
                        {s.status}
                      </StatusBadge>
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