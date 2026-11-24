import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play, ShoppingCart, Clock, RefreshCw, Ticket, Plus } from 'lucide-react';
import { smartOpsApi } from '../../services/smartOpsApi';
import { useAccounting } from '../../context/AccountingContext';
import { EmptyState, FormField, InlineAlert, Panel } from '../common/ui';

interface SuspendedSale {
  id: number;
  shiftId: number;
  posOrderId: number;
  suspendedAt: string;
  resumedAt: string | null;
  status: string;
  clientToken?: string | null;
}

interface SuspendedSalesViewProps {
  onResume?: (posOrderId: number) => void;
}

/**
 * WS-1 P7 — suspended-sale recovery.
 *
 * The client generates the park token once (`clientTokenRef`) and re-sends the
 * same value, so a refresh or restart re-uses the existing parked sale instead
 * of creating a duplicate. The token is kept in `sessionStorage` so it survives
 * a full page reload within the same tab.
 */
export const SuspendedSalesView: React.FC<SuspendedSalesViewProps> = ({ onResume }) => {
  const { triggerShortcutNotice } = useAccounting();
  const [suspendedSales, setSuspendedSales] = useState<SuspendedSale[]>([]);
  const [loading, setLoading] = useState(false);
  const [orderId, setOrderId] = useState('');
  const [parking, setParking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientTokenRef = useRef<string | null>(null);

  const getClientToken = (): string => {
    if (clientTokenRef.current) return clientTokenRef.current;
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem('pms:pos:suspendId');
    } catch {
      /* storage unavailable */
    }
    if (stored) {
      clientTokenRef.current = stored;
      return stored;
    }
    const token =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `suspend-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    clientTokenRef.current = token;
    try {
      window.sessionStorage.setItem('pms:pos:suspendId', token);
    } catch {
      /* storage unavailable */
    }
    return token;
  };

  const loadSuspended = async () => {
    setLoading(true);
    try {
      const res = await smartOpsApi.listSuspendedSales({ status: 'suspended' });
      setSuspendedSales(res.suspendedSales || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load suspended sales');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSuspended();
  }, []);

  const handlePark = async () => {
    const id = Number(orderId);
    if (!Number.isInteger(id) || id <= 0) {
      setError('Enter a valid POS order id');
      return;
    }
    setParking(true);
    setError(null);
    try {
      // Same token every time → idempotent park, safe across refresh/restart.
      await smartOpsApi.suspendPosOrder(id, { suspendId: getClientToken() });
      triggerShortcutNotice?.(`Order #${id} parked`);
      setOrderId('');
      await loadSuspended();
    } catch (err: any) {
      setError(err?.message || 'Failed to park order');
    } finally {
      setParking(false);
    }
  };

  const handleResume = async (suspendedId: number) => {
    try {
      const res = await smartOpsApi.resumePosOrder(suspendedId);
      triggerShortcutNotice?.('Sale resumed');
      onResume?.(res.suspendedSale.posOrderId);
      // A resumed sale consumes the token; issue a fresh one for the next park.
      clientTokenRef.current = null;
      try {
        window.sessionStorage.removeItem('pms:pos:suspendId');
      } catch {
        /* storage unavailable */
      }
      await loadSuspended();
    } catch (err: any) {
      setError(err?.message || 'Failed to resume sale');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Panel
      title="Suspended sales"
      description="Park an order and pick it up later — even after a refresh. The park token makes recovery deterministic."
      icon={<Pause className="h-4 w-4 text-amber-600" />}
      actions={
        <button
          type="button"
          onClick={loadSuspended}
          disabled={loading}
          className="btn btn-secondary py-1.5 text-xs"
        >
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

        <div className="surface flex flex-wrap items-end gap-3 p-4">
          <FormField label="Park a POS order" required className="min-w-[180px] flex-1">
            <input
              type="number"
              min="1"
              value={orderId}
              onChange={e => setOrderId(e.target.value)}
              placeholder="Order id"
              className="app-input app-input-mono"
            />
          </FormField>
          <button
            type="button"
            onClick={handlePark}
            disabled={parking}
            className="btn btn-primary"
          >
            <Ticket className="h-4 w-4" />
            {parking ? 'Parking…' : 'Park order'}
          </button>
        </div>

        {suspendedSales.length === 0 ? (
          <EmptyState
            title="No suspended sales"
            description="Parked orders appear here and can be resumed from any terminal signed in as this cashier."
            icon={<ShoppingCart className="h-6 w-6" />}
          />
        ) : (
          <ul className="space-y-2">
            {suspendedSales.map(sale => (
              <li
                key={sale.id}
                className="surface surface-hover flex flex-wrap items-center justify-between gap-3 p-3.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 ring-1 ring-amber-200/70 ring-inset dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20">
                    <ShoppingCart className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">
                      Order #{sale.posOrderId}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                      <Clock className="h-3 w-3" />
                      {new Date(sale.suspendedAt).toLocaleString()}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400">
                      token {sale.clientToken ? sale.clientToken.slice(0, 8) : '(legacy)'}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleResume(sale.id)}
                  className="btn btn-emerald py-1.5 text-xs"
                >
                  <Play className="h-3.5 w-3.5" />
                  Resume
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
};