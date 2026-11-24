import React, { useEffect, useState } from 'react';
import {
  Play,
  Square,
  Wallet,
  AlertTriangle,
  CheckCircle2,
  ArrowDownLeft,
  ArrowUpRight,
  Landmark,
} from 'lucide-react';
import { smartOpsApi } from '../../services/smartOpsApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import {
  FormField,
  InlineAlert,
  ModalFooter,
  ModalHeader,
  ModalShell,
  Panel,
  StatCard,
  StatusBadge,
  SummaryRow,
} from '../common/ui';

interface ShiftManagerProps {
  onShiftChange?: (shiftId: number | null) => void;
}

const MOVEMENT_TYPES = [
  { value: 'cash_in', label: 'Cash in', icon: ArrowDownLeft },
  { value: 'cash_out', label: 'Cash out', icon: ArrowUpRight },
  { value: 'paid_in', label: 'Paid in', icon: ArrowDownLeft },
  { value: 'paid_out', label: 'Paid out', icon: ArrowUpRight },
  { value: 'deposit', label: 'Bank deposit', icon: Landmark },
];

export const ShiftManager: React.FC<ShiftManagerProps> = ({ onShiftChange }) => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [currentShift, setCurrentShift] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [openingFloat, setOpeningFloat] = useState('100.00');
  const [actualCash, setActualCash] = useState('');
  const [notes, setNotes] = useState('');
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [movementType, setMovementType] = useState('cash_in');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadCurrentShift = async () => {
    try {
      const res = await smartOpsApi.getCurrentPosShift();
      setCurrentShift(res.shift);
      onShiftChange?.(res.shift?.id || null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load the current shift');
    }
  };

  useEffect(() => {
    loadCurrentShift();
  }, []);

  const handleOpenShift = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await smartOpsApi.openPosShift({
        openingFloat: Number(openingFloat),
        notes: notes.trim() || undefined,
      });
      setCurrentShift(res.shift);
      onShiftChange?.(res.shift.id);
      setNotes('');
      triggerShortcutNotice?.('Shift opened successfully');
    } catch (err: any) {
      const msg = err?.message || 'Failed to open shift';
      setError(msg);
      triggerShortcutNotice?.(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCloseShift = async () => {
    if (!currentShift) return;
    setLoading(true);
    setError(null);
    try {
      const res = await smartOpsApi.closePosShift(currentShift.id, {
        actualCash: Number(actualCash),
        notes: notes.trim() || undefined,
      });
      setCurrentShift(null);
      onShiftChange?.(null);
      setShowCloseModal(false);
      setActualCash('');
      setNotes('');
      triggerShortcutNotice?.(`Shift closed · variance ${formatCurrency(Number(res.variance), currency)}`);
    } catch (err: any) {
      const msg = err?.message || 'Failed to close shift';
      setError(msg);
      triggerShortcutNotice?.(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRecordMovement = async () => {
    if (!currentShift) return;
    setLoading(true);
    setError(null);
    try {
      await smartOpsApi.recordPosCashMovement(currentShift.id, {
        movementType,
        amount: Number(movementAmount),
        reason: movementReason.trim() || undefined,
      });
      triggerShortcutNotice?.('Cash movement recorded');
      setMovementAmount('');
      setMovementReason('');
      await loadCurrentShift();
    } catch (err: any) {
      const msg = err?.message || 'Failed to record cash movement';
      setError(msg);
      triggerShortcutNotice?.(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  /* ── Active shift ─────────────────────────────────────────────────────── */
  if (currentShift) {
    const shiftTotals = currentShift.totals || currentShift.summary || {};
    return (
      <div className="space-y-4">
        <Panel
          title="Shift open"
          description={`Cashier ${currentShift.cashierName || '—'} · opened ${new Date(
            currentShift.openedAt
          ).toLocaleString()}`}
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
          actions={<StatusBadge tone="success">Open</StatusBadge>}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Opening float"
              value={formatCurrency(Number(currentShift.openingFloat || 0), currency)}
              icon={<Wallet className="h-4 w-4" />}
              tone="blue"
            />
            <StatCard
              label="Cash sales"
              value={formatCurrency(Number(shiftTotals.cashSales || 0), currency)}
              icon={<ArrowDownLeft className="h-4 w-4" />}
              tone="emerald"
            />
            <StatCard
              label="Cash movements"
              value={formatCurrency(
                Number(shiftTotals.cashIn || 0) - Number(shiftTotals.cashOut || 0),
                currency
              )}
              hint={`In ${formatCurrency(Number(shiftTotals.cashIn || 0), currency)} · out ${formatCurrency(
                Number(shiftTotals.cashOut || 0),
                currency
              )}`}
              icon={<Landmark className="h-4 w-4" />}
              tone="amber"
            />
            <StatCard
              label="Expected cash"
              value={formatCurrency(
                Number(shiftTotals.expectedCash ?? currentShift.expectedCash ?? 0),
                currency
              )}
              icon={<Wallet className="h-4 w-4" />}
              tone="neutral"
            />
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div className="space-y-3">
              <h4 className="section-title flex items-center gap-1.5">
                <Landmark className="h-3.5 w-3.5 text-slate-400" />
                Record a cash movement
              </h4>
              <FormField label="Movement type">
                <select
                  value={movementType}
                  onChange={e => setMovementType(e.target.value)}
                  className="app-input"
                >
                  {MOVEMENT_TYPES.map(m => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Amount" required>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={movementAmount}
                  onChange={e => setMovementAmount(e.target.value)}
                  placeholder="0.00"
                  className="app-input app-input-mono"
                />
              </FormField>
              <FormField label="Reason">
                <input
                  value={movementReason}
                  onChange={e => setMovementReason(e.target.value)}
                  placeholder="Optional note for the audit trail"
                  className="app-input"
                />
              </FormField>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleRecordMovement}
                  disabled={loading || !movementAmount}
                  className="btn btn-secondary"
                >
                  <Landmark className="h-4 w-4" />
                  Record movement
                </button>
              </div>
            </div>

            <div className="surface p-4">
              <h4 className="section-title mb-2">Shift summary</h4>
              <SummaryRow label="Cashier" value={currentShift.cashierName || '—'} />
              <SummaryRow
                label="Opened"
                value={new Date(currentShift.openedAt).toLocaleTimeString()}
              />
              <SummaryRow
                label="Card & mobile"
                value={formatCurrency(
                  Number(shiftTotals.cardSales || 0) + Number(shiftTotals.mobileSales || 0),
                  currency
                )}
              />
              <SummaryRow label="Refunds" value={formatCurrency(Number(shiftTotals.refunds || 0), currency)} tone="rose" />
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setShowCloseModal(true);
                  }}
                  disabled={loading}
                  className="btn btn-danger w-full"
                >
                  <Square className="h-4 w-4" />
                  Close shift
                </button>
              </div>
            </div>
          </div>
        </Panel>

        {error && (
          <InlineAlert tone="error" onDismiss={() => setError(null)}>
            {error}
          </InlineAlert>
        )}

        {showCloseModal && (
          <ModalShell open onClose={() => setShowCloseModal(false)} size="md" titleId="close-shift-title">
            <ModalHeader
              title="Close shift"
              subtitle="Count the drawer and reconcile against the expected cash."
              icon={<Wallet className="h-4 w-4" />}
              tone="brand"
              onClose={() => setShowCloseModal(false)}
            />
            <div className="space-y-4 overflow-y-auto p-5">
              <FormField
                label="Actual cash counted"
                required
                hint="The physical cash in the drawer at close."
              >
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={actualCash}
                  onChange={e => setActualCash(e.target.value)}
                  placeholder="0.00"
                  className="app-input app-input-mono"
                />
              </FormField>
              <FormField label="Notes" hint="Stored on the shift audit record.">
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={3}
                  className="app-input resize-none"
                />
              </FormField>
              {error && <InlineAlert tone="error">{error}</InlineAlert>}
            </div>
            <ModalFooter
              onCancel={() => setShowCloseModal(false)}
              onSubmit={handleCloseShift}
              submitLabel="Confirm close"
              submitIcon={<Square className="h-4 w-4" />}
              tone="rose"
              busy={loading}
              disabled={!actualCash}
            />
          </ModalShell>
        )}
      </div>
    );
  }

  /* ── No active shift ──────────────────────────────────────────────────── */
  return (
    <Panel
      title="Cashier shift"
      description="Open a shift before taking payments so every tender is reconciled to a drawer."
      icon={<Wallet className="h-4 w-4 text-brand-600" />}
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          <FormField
            label="Opening float"
            required
            hint="Cash already in the drawer before the first sale."
          >
            <input
              type="number"
              min="0"
              step="0.01"
              value={openingFloat}
              onChange={e => setOpeningFloat(e.target.value)}
              className="app-input app-input-mono"
            />
          </FormField>
          <FormField label="Notes">
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Optional handover note"
              className="app-input resize-none"
            />
          </FormField>
          {error && <InlineAlert tone="error">{error}</InlineAlert>}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleOpenShift}
              disabled={loading}
              className="btn btn-primary"
            >
              <Play className="h-4 w-4" />
              {loading ? 'Opening…' : 'Open shift'}
            </button>
          </div>
        </div>

        <div className="surface flex flex-col justify-center gap-2 p-4 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-amber-200/70 ring-inset dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            No active shift
          </div>
          <p className="text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
            Payments are blocked until a shift is opened. Enter the opening float to begin.
          </p>
        </div>
      </div>
    </Panel>
  );
};