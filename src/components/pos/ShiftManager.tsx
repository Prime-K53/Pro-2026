import React, { useState, useEffect } from 'react';
import { Play, Square, DollarSign, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { smartOpsApi } from '../../services/smartOpsApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';

interface ShiftManagerProps {
  onShiftChange?: (shiftId: number | null) => void;
}

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

  const loadCurrentShift = async () => {
    try {
      const res = await smartOpsApi.getCurrentPosShift();
      setCurrentShift(res.shift);
      onShiftChange?.(res.shift?.id || null);
    } catch (err) {
      console.error('Failed to load current shift:', err);
    }
  };

  useEffect(() => {
    loadCurrentShift();
  }, []);

  const handleOpenShift = async () => {
    setLoading(true);
    try {
      const res = await smartOpsApi.openPosShift({ openingFloat: Number(openingFloat), notes });
      setCurrentShift(res.shift);
      onShiftChange?.(res.shift.id);
      triggerShortcutNotice?.('Shift opened successfully');
    } catch (err: any) {
      triggerShortcutNotice?.(err?.message || 'Failed to open shift');
    } finally {
      setLoading(false);
    }
  };

  const handleCloseShift = async () => {
    if (!currentShift) return;
    setLoading(true);
    try {
      const res = await smartOpsApi.closePosShift(currentShift.id, {
        actualCash: Number(actualCash),
        notes,
      });
      setCurrentShift(null);
      onShiftChange?.(null);
      triggerShortcutNotice?.(`Shift closed. Variance: ${formatCurrency(res.variance, currency)}`);
      setShowCloseModal(false);
    } catch (err: any) {
      triggerShortcutNotice?.(err?.message || 'Failed to close shift');
    } finally {
      setLoading(false);
    }
  };

  const handleRecordMovement = async () => {
    if (!currentShift) return;
    setLoading(true);
    try {
      await smartOpsApi.recordPosCashMovement(currentShift.id, {
        movementType,
        amount: Number(movementAmount),
        reason: movementReason,
      });
      triggerShortcutNotice?.('Cash movement recorded');
      setMovementAmount('');
      setMovementReason('');
      await loadCurrentShift();
    } catch (err: any) {
      triggerShortcutNotice?.(err?.message || 'Failed to record cash movement');
    } finally {
      setLoading(false);
    }
  };

  if (currentShift) {
    return (
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-500" />
            <span className="font-semibold">Shift Open</span>
          </div>
          <span className="text-sm text-gray-500">
            Cashier: {currentShift.cashierName}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm mb-3">
          <div>
            <span className="text-gray-500">Opening Float:</span>{' '}
            <span className="font-medium">{formatCurrency(currentShift.openingFloat, currency)}</span>
          </div>
          <div>
            <span className="text-gray-500">Opened:</span>{' '}
            <span className="font-medium">{new Date(currentShift.openedAt).toLocaleTimeString()}</span>
          </div>
        </div>
        <div className="mb-3 space-y-2 border-t pt-3">
          <div className="text-sm font-medium text-gray-600">Cash Movements</div>
          <div className="flex gap-2">
            <select
              value={movementType}
              onChange={(e) => setMovementType(e.target.value)}
              className="border rounded px-2 py-1 text-sm"
            >
              <option value="cash_in">Cash In</option>
              <option value="cash_out">Cash Out</option>
              <option value="paid_in">Paid In</option>
              <option value="paid_out">Paid Out</option>
              <option value="deposit">Bank Deposit</option>
            </select>
            <input
              type="number"
              value={movementAmount}
              onChange={(e) => setMovementAmount(e.target.value)}
              placeholder="Amount"
              className="w-28 border rounded px-2 py-1 text-sm"
            />
          </div>
          <input
            value={movementReason}
            onChange={(e) => setMovementReason(e.target.value)}
            placeholder="Reason (optional)"
            className="w-full border rounded px-2 py-1 text-sm"
          />
          <button
            onClick={handleRecordMovement}
            disabled={loading || !movementAmount}
            className="w-full bg-sky-500 text-white px-4 py-2 rounded hover:bg-sky-600 disabled:opacity-50"
          >
            Record Movement
          </button>
        </div>
        <button
          onClick={() => setShowCloseModal(true)}
          className="w-full flex items-center justify-center gap-2 bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600"
          disabled={loading}
        >
          <Square className="w-4 h-4" />
          Close Shift
        </button>

        {showCloseModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 w-96">
              <h3 className="text-lg font-semibold mb-4">Close Shift — Cash Reconciliation</h3>
              <div className="mb-3">
                <label className="block text-sm text-gray-600 mb-1">Actual Cash Count</label>
                <input
                  type="number"
                  value={actualCash}
                  onChange={(e) => setActualCash(e.target.value)}
                  className="w-full border rounded px-3 py-2"
                  placeholder="0.00"
                />
              </div>
              <div className="mb-3">
                <label className="block text-sm text-gray-600 mb-1">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full border rounded px-3 py-2"
                  rows={2}
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCloseShift}
                  className="flex-1 bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600"
                  disabled={loading || !actualCash}
                >
                  {loading ? 'Closing...' : 'Confirm Close'}
                </button>
                <button
                  onClick={() => setShowCloseModal(false)}
                  className="flex-1 bg-gray-200 text-gray-700 px-4 py-2 rounded hover:bg-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-5 h-5 text-amber-500" />
        <span className="font-semibold">No Active Shift</span>
      </div>
      <div className="mb-3">
        <label className="block text-sm text-gray-600 mb-1">Opening Float</label>
        <input
          type="number"
          value={openingFloat}
          onChange={(e) => setOpeningFloat(e.target.value)}
          className="w-full border rounded px-3 py-2"
        />
      </div>
      <div className="mb-3">
        <label className="block text-sm text-gray-600 mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full border rounded px-3 py-2"
          rows={2}
        />
      </div>
      <button
        onClick={handleOpenShift}
        className="w-full flex items-center justify-center gap-2 bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600"
        disabled={loading}
      >
        <Play className="w-4 h-4" />
        {loading ? 'Opening...' : 'Open Shift'}
      </button>
    </div>
  );
};