import React, { useCallback, useEffect, useState } from 'react';
import {
  Truck,
  Plus,
  RefreshCw,
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  User,
  Calendar,
  X,
  Send,
  CheckSquare,
} from 'lucide-react';
import { deliveryApi, Driver, Vehicle } from '../../services/v2Api';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency } from '../../utils/currency';
import { appDialog, StatusBadge } from '../../design-system';

interface DeliveryNoteLine {
  id?: number;
  description: string;
  quantityDispatched: number;
}

interface DeliveryNote {
  id: number;
  companyId: number;
  deliveryNumber: string;
  customerId: number;
  dispatchDate: string;
  deliveredAt: string | null;
  driverName: string | null;
  vehicleReg: string | null;
  recipientName: string | null;
  status: 'prepared' | 'in_transit' | 'delivered' | 'partial' | 'cancelled';
  notes: string | null;
  deliveryCost: string | number;
  createdAt: string;
  lines?: DeliveryNoteLine[];
}

export const DeliveryNotesView: React.FC = () => {
  const { customers, companyProfile, triggerShortcutNotice } = useAccounting();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('delivery:write');
  const currency = companyProfile.currency || 'K';

  const [notes, setNotes] = useState<DeliveryNote[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deliverModalNote, setDeliverModalNote] = useState<DeliveryNote | null>(null);
  const [recipientName, setRecipientName] = useState('');
  const [deliveryNotes, setDeliveryNotes] = useState('');

  // New Note Form
  const today = new Date().toISOString().slice(0, 10);
  const [newNote, setNewNote] = useState({
    customerId: customers[0]?.id ? String(customers[0].id) : '',
    dispatchDate: today,
    driverName: '',
    vehicleReg: '',
    notes: '',
    deliveryCost: 0,
    lines: [{ description: '', quantityDispatched: 1 }],
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [nRes, vRes, dRes] = await Promise.all([
        deliveryApi.notes(),
        deliveryApi.vehicles(),
        deliveryApi.drivers(),
      ]);
      setNotes(nRes.deliveryNotes || []);
      setVehicles(vRes.vehicles || []);
      setDrivers(dRes.drivers || []);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to load delivery data', 'error');
    } finally {
      setLoading(false);
    }
  }, [triggerShortcutNotice]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreateNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNote.customerId || !newNote.dispatchDate) {
      triggerShortcutNotice('Customer and Dispatch Date are required', 'error');
      return;
    }
    const validLines = newNote.lines.filter(l => l.description.trim() && l.quantityDispatched > 0);
    if (validLines.length === 0) {
      triggerShortcutNotice('At least one item description with quantity > 0 is required', 'error');
      return;
    }

    try {
      await deliveryApi.createNote({
        customerId: Number(newNote.customerId),
        dispatchDate: newNote.dispatchDate,
        driverName: newNote.driverName || undefined,
        vehicleReg: newNote.vehicleReg || undefined,
        notes: newNote.notes || undefined,
        deliveryCost: Number(newNote.deliveryCost) || 0,
        lines: validLines,
      });
      triggerShortcutNotice('Delivery note created successfully');
      setShowCreateModal(false);
      setNewNote({
        customerId: customers[0]?.id ? String(customers[0].id) : '',
        dispatchDate: today,
        driverName: '',
        vehicleReg: '',
        notes: '',
        deliveryCost: 0,
        lines: [{ description: '', quantityDispatched: 1 }],
      });
      await loadData();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to create delivery note', 'error');
    }
  };

  const handleDispatch = async (note: DeliveryNote) => {
    const confirmed = await appDialog.confirm({
      title: 'Dispatch Delivery Note',
      message: `Dispatch delivery note ${note.deliveryNumber} and mark it in transit?`,
      confirmLabel: 'Dispatch',
      tone: 'brand',
    });
    if (!confirmed) return;
    try {
      await deliveryApi.dispatchNote(note.id);
      triggerShortcutNotice(`Delivery note ${note.deliveryNumber} marked in transit`);
      await loadData();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to dispatch delivery note', 'error');
    }
  };

  const handleConfirmDelivery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deliverModalNote) return;
    try {
      await deliveryApi.markDelivered(deliverModalNote.id, {
        recipientName: recipientName.trim() || undefined,
        notes: deliveryNotes.trim() || undefined,
      });
      triggerShortcutNotice(`Delivery confirmed for ${deliverModalNote.deliveryNumber}`);
      setDeliverModalNote(null);
      setRecipientName('');
      setDeliveryNotes('');
      await loadData();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to confirm delivery', 'error');
    }
  };

  const handleCancelNote = async (note: DeliveryNote) => {
    const confirmed = await appDialog.confirm({
      title: 'Cancel Delivery Note',
      message: `Cancel delivery note ${note.deliveryNumber}?`,
      confirmLabel: 'Cancel Note',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await deliveryApi.cancelNote(note.id);
      triggerShortcutNotice(`Delivery note ${note.deliveryNumber} cancelled`);
      await loadData();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to cancel delivery note', 'error');
    }
  };

  const addLine = () => {
    setNewNote(prev => ({
      ...prev,
      lines: [...prev.lines, { description: '', quantityDispatched: 1 }],
    }));
  };

  const updateLine = (index: number, field: keyof DeliveryNoteLine, value: any) => {
    setNewNote(prev => {
      const updated = [...prev.lines];
      updated[index] = { ...updated[index], [field]: value };
      return { ...prev, lines: updated };
    });
  };

  const removeLine = (index: number) => {
    if (newNote.lines.length <= 1) return;
    setNewNote(prev => ({
      ...prev,
      lines: prev.lines.filter((_, i) => i !== index),
    }));
  };

  const preparedCount = notes.filter(n => n.status === 'prepared').length;
  const inTransitCount = notes.filter(n => n.status === 'in_transit').length;
  const deliveredCount = notes.filter(n => n.status === 'delivered').length;

  const filteredNotes = notes.filter(n => {
    if (filterStatus === 'all') return true;
    return n.status === filterStatus;
  });

  const getCustomerName = (customerId: number) => {
    const c = customers.find(cust => Number(cust.id) === customerId);
    return c ? (c.companyName || c.name) : `Customer #${customerId}`;
  };

  const renderStatusBadge = (status: string) => {
    switch (status) {
      case 'prepared':
        return <StatusBadge tone="warning" showIcon>Prepared</StatusBadge>;
      case 'in_transit':
        return <StatusBadge tone="info" showIcon>In Transit</StatusBadge>;
      case 'delivered':
        return <StatusBadge tone="success" showIcon>Delivered</StatusBadge>;
      case 'cancelled':
        return <StatusBadge tone="neutral">Cancelled</StatusBadge>;
      default:
        return <StatusBadge tone="neutral">{status}</StatusBadge>;
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
            <Truck className="w-6 h-6 text-blue-600" />
            Delivery & Dispatch Management
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Create delivery notes, dispatch vehicles, and record signed proof-of-delivery (POD).
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadData}
            disabled={loading}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
            title="Refresh list"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {canWrite && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-sm transition-all"
            >
              <Plus className="w-4 h-4" />
              <span>New Delivery Note</span>
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div
          onClick={() => setFilterStatus(prev => prev === 'prepared' ? 'all' : 'prepared')}
          className={`p-4 rounded-xl bg-white dark:bg-slate-900 border transition-all cursor-pointer ${
            filterStatus === 'prepared' ? 'border-amber-500 ring-2 ring-amber-500/20' : 'border-slate-200 dark:border-slate-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Ready for Dispatch</div>
            <Clock className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
            {preparedCount}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Prepared packages awaiting departure</div>
        </div>

        <div
          onClick={() => setFilterStatus(prev => prev === 'in_transit' ? 'all' : 'in_transit')}
          className={`p-4 rounded-xl bg-white dark:bg-slate-900 border transition-all cursor-pointer ${
            filterStatus === 'in_transit' ? 'border-blue-500 ring-2 ring-blue-500/20' : 'border-slate-200 dark:border-slate-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">In Transit</div>
            <Truck className="w-4 h-4 text-blue-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-blue-600 dark:text-blue-400 mt-1 tabular-nums">
            {inTransitCount}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Out for delivery with driver</div>
        </div>

        <div
          onClick={() => setFilterStatus(prev => prev === 'delivered' ? 'all' : 'delivered')}
          className={`p-4 rounded-xl bg-white dark:bg-slate-900 border transition-all cursor-pointer ${
            filterStatus === 'delivered' ? 'border-emerald-500 ring-2 ring-emerald-500/20' : 'border-slate-200 dark:border-slate-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Delivered</div>
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1 tabular-nums">
            {deliveredCount}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Proof of delivery captured</div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-medium w-fit">
        {[
          { id: 'all', label: `All (${notes.length})` },
          { id: 'prepared', label: `Prepared (${preparedCount})` },
          { id: 'in_transit', label: `In Transit (${inTransitCount})` },
          { id: 'delivered', label: `Delivered (${deliveredCount})` },
          { id: 'cancelled', label: 'Cancelled' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setFilterStatus(tab.id)}
            className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
              filterStatus === tab.id
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-bold shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Delivery Notes Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-3">DN Number</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Dispatch Date</th>
                <th className="px-4 py-3">Vehicle / Driver</th>
                <th className="px-4 py-3">Recipient / POD</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredNotes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No delivery notes found matching current filters.
                  </td>
                </tr>
              ) : (
                filteredNotes.map(note => (
                  <tr key={note.id} className="hover:bg-slate-50 dark:hover:bg-slate-850/50 transition-colors">
                    <td className="px-4 py-3 font-mono font-bold text-blue-600 dark:text-blue-400">
                      {note.deliveryNumber}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                      {getCustomerName(note.customerId)}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {note.dispatchDate}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      <div>{note.vehicleReg || '—'}</div>
                      <div className="text-[10px] text-slate-400">{note.driverName || 'No driver assigned'}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {note.recipientName ? (
                        <div>
                          <div className="font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                            <CheckSquare className="w-3.5 h-3.5" />
                            {note.recipientName}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {note.deliveredAt ? new Date(note.deliveredAt).toLocaleDateString() : ''}
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-400 italic">Pending delivery</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {renderStatusBadge(note.status)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {canWrite && note.status === 'prepared' && (
                          <button
                            onClick={() => handleDispatch(note)}
                            className="px-2.5 py-1 rounded bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-semibold hover:bg-blue-100 text-[11px] transition-colors"
                          >
                            Dispatch
                          </button>
                        )}
                        {canWrite && note.status === 'in_transit' && (
                          <button
                            onClick={() => {
                              setDeliverModalNote(note);
                              setRecipientName('');
                              setDeliveryNotes('');
                            }}
                            className="px-2.5 py-1 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 font-semibold hover:bg-emerald-100 text-[11px] transition-colors"
                          >
                            Confirm POD
                          </button>
                        )}
                        {canWrite && ['prepared', 'in_transit'].includes(note.status) && (
                          <button
                            onClick={() => handleCancelNote(note)}
                            className="px-2.5 py-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/50 text-rose-600 font-semibold text-[11px] transition-colors"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Delivery Note Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-xl w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Truck className="w-5 h-5 text-blue-600" />
                New Delivery Note
              </h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateNote} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                    Customer *
                  </label>
                  <select
                    value={newNote.customerId}
                    onChange={e => setNewNote({ ...newNote, customerId: e.target.value })}
                    className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                    required
                  >
                    {customers.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.companyName || c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                    Dispatch Date *
                  </label>
                  <input
                    type="date"
                    value={newNote.dispatchDate}
                    onChange={e => setNewNote({ ...newNote, dispatchDate: e.target.value })}
                    className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                    required
                  />
                </div>

                <div>
                  <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                    Vehicle
                  </label>
                  <select
                    value={newNote.vehicleReg}
                    onChange={e => setNewNote({ ...newNote, vehicleReg: e.target.value })}
                    className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                  >
                    <option value="">— Select Vehicle —</option>
                    {vehicles.map(v => (
                      <option key={v.id} value={v.registration}>
                        {v.registration} ({v.make} {v.model})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                    Assigned Driver
                  </label>
                  <select
                    value={newNote.driverName}
                    onChange={e => setNewNote({ ...newNote, driverName: e.target.value })}
                    className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                  >
                    <option value="">— Select Driver —</option>
                    {drivers.map(d => (
                      <option key={d.id} value={d.name}>
                        {d.name} ({d.licenseNumber})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Line Items */}
              <div className="space-y-2 border-t border-slate-100 dark:border-slate-800 pt-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-900 dark:text-white">Items to Dispatch</span>
                  <button
                    type="button"
                    onClick={addLine}
                    className="text-blue-600 font-semibold hover:underline text-[11px]"
                  >
                    + Add Item
                  </button>
                </div>

                {newNote.lines.map((line, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Item description (e.g. Exam papers batch A)"
                      value={line.description}
                      onChange={e => updateLine(idx, 'description', e.target.value)}
                      className="flex-1 p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                      required
                    />
                    <input
                      type="number"
                      placeholder="Qty"
                      min={1}
                      value={line.quantityDispatched}
                      onChange={e => updateLine(idx, 'quantityDispatched', Number(e.target.value))}
                      className="w-20 p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white text-right"
                      required
                    />
                    {newNote.lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeLine(idx)}
                        className="p-2 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-lg"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                  Delivery Instructions / Notes
                </label>
                <textarea
                  rows={2}
                  value={newNote.notes}
                  onChange={e => setNewNote({ ...newNote, notes: e.target.value })}
                  placeholder="Gate pass required, delivery instructions..."
                  className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-xs"
                >
                  Create Delivery Note
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm POD Modal */}
      {deliverModalNote && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                Proof of Delivery (POD)
              </h2>
              <button
                onClick={() => setDeliverModalNote(null)}
                className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmDelivery} className="space-y-4 text-xs">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 space-y-1">
                <div className="font-bold text-slate-900 dark:text-white">
                  {deliverModalNote.deliveryNumber}
                </div>
                <div className="text-slate-500">
                  Customer: {getCustomerName(deliverModalNote.customerId)}
                </div>
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                  Received & Signed By *
                </label>
                <input
                  type="text"
                  placeholder="e.g. John Banda (Store Manager)"
                  value={recipientName}
                  onChange={e => setRecipientName(e.target.value)}
                  className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-600 dark:text-slate-300 font-medium mb-1">
                  POD Notes / Condition
                </label>
                <textarea
                  rows={2}
                  placeholder="Received in good order and full count"
                  value={deliveryNotes}
                  onChange={e => setDeliveryNotes(e.target.value)}
                  className="w-full p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-850 text-slate-900 dark:text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setDeliverModalNote(null)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow-xs"
                >
                  Save Proof of Delivery
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
