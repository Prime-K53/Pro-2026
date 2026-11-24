import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RotateCcw, RefreshCw, AlertTriangle, Receipt } from 'lucide-react';
import { posRefundApi, PosRefund } from '../../services/v2Api';
import { smartOpsApi } from '../../services/smartOpsApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { EmptyState, InlineAlert, Panel, StatusBadge } from '../common/ui';

/**
 * WS-1 P3 — refunds linked to the original sale.
 *
 * The server rejects a refund without a completed original order, a double
 * refund, and any amount above the remaining refundable balance. This panel
 * surfaces those rules to the cashier before the request is made.
 */
export const RefundPanel: React.FC = () => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [orders, setOrders] = useState<any[]>([]);
  const [refunds, setRefunds] = useState<PosRefund[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedOrder = useMemo(
    () => orders.find(o => String(o.id) === selectedOrderId) || null,
    [orders, selectedOrderId]
  );

  const alreadyRefunded = useMemo(
    () =>
      refunds
        .filter(r => r.posOrderId === selectedOrder?.id && r.status === 'completed')
        .reduce((sum, r) => sum + Number(r.amount), 0),
    [refunds, selectedOrder]
  );

  const refundable = selectedOrder
    ? Math.max(0, Number(selectedOrder.total) - alreadyRefunded)
    : 0;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [catalog, refundList] = await Promise.all([
        smartOpsApi.getPosCatalog(),
        posRefundApi.list(),
      ]);
      setOrders(catalog.recentOrders || []);
      setRefunds(refundList.refunds || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load POS refund data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const canSubmit =
    !!selectedOrder &&
    Number(amount) > 0 &&
    Number(amount) <= refundable &&
    !busy;

  const handleSubmit = async () => {
    if (!selectedOrder || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await posRefundApi.create(selectedOrder.id, {
        amount: Number(amount),
        reason: reason.trim() || undefined,
      });
      triggerShortcutNotice(
        `Refund ${formatCurrency(Number(res.refund.amount), currency)} recorded for ${selectedOrder.receiptNumber}`
      );
      setAmount('');
      setReason('');
      await load();
    } catch (err: any) {
      const msg = err?.message || 'Refund failed';
      setError(msg);
      triggerShortcutNotice(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Refunds"
      description="Refunds are linked to the original completed sale, reverse the GL, and cannot exceed the remaining refundable balance."
      icon={<RotateCcw className="h-4 w-4 text-rose-600" />}
      actions={
        <button type="button" onClick={load} disabled={loading} className="btn btn-secondary py-1.5 text-xs">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      }
    >
      <div className="space-y-4">
        {error && (
          <InlineAlert tone="error" onDismiss={() => setError(null)}>
            {error}
          </InlineAlert>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Original sale</span>
            <select
              value={selectedOrderId}
              onChange={e => {
                setSelectedOrderId(e.target.value);
                setAmount('');
              }}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="">Select a completed order…</option>
              {orders.map(o => (
                <option key={o.id} value={o.id}>
                  {o.receiptNumber} · {o.customerName || 'Walk-in'} ·{' '}
                  {formatCurrency(Number(o.total), currency)}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Refund amount (max {formatCurrency(refundable, currency)})
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={!selectedOrder || refundable <= 0}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm tabular-nums disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
        </div>

        <label className="block text-xs">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Reason</span>
          <input
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. customer changed mind, pricing error"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </label>

        {selectedOrder && refundable <= 0 && (
          <InlineAlert tone="warning">
            This order has already been refunded in full.
          </InlineAlert>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-3 dark:border-white/[0.07]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Order total {formatCurrency(Number(selectedOrder?.total || 0), currency)} · already
            refunded {formatCurrency(alreadyRefunded, currency)}
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="btn btn-danger"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {busy ? 'Recording…' : 'Record Refund'}
          </button>
        </div>

        <div>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <Receipt className="h-3.5 w-3.5" />
            Refund history
          </h3>
          {refunds.length === 0 ? (
            <EmptyState title="No refunds recorded" description="Refunds appear here once recorded." />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Amount</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th className="text-right">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {refunds.map(r => (
                    <tr key={r.id}>
                      <td className="font-mono">#{r.posOrderId}</td>
                      <td className="text-right font-mono font-bold tabular-nums">
                        {formatCurrency(Number(r.amount), currency)}
                      </td>
                      <td className="text-xs text-slate-500 dark:text-slate-400">
                        {r.reason || '—'}
                      </td>
                      <td>
                        <StatusBadge tone={r.status === 'completed' ? 'success' : 'neutral'}>
                          {r.status}
                        </StatusBadge>
                      </td>
                      <td className="text-right text-xs text-slate-500">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="flex items-start gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          Refunds reverse the original journal entry. A refund cannot be recorded twice for the
          same order, and the total refunded can never exceed the order total.
        </p>
      </div>
    </Panel>
  );
};