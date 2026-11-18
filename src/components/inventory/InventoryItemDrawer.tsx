import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Box,
  Boxes,
  ClipboardList,
  FileText,
  History,
  Layers,
  Package,
  RefreshCw,
  ShoppingCart,
  Truck,
  X,
} from 'lucide-react';
import { commercialApi } from '../../services/commercialApi';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';

/**
 * Right-hand detail drawer for a single inventory item.
 *
 * Read-only by design: every tab fetches its data from the server so the
 * quantities and valuations shown here are exactly the ones in the general
 * ledger. Nothing is computed locally from a float.
 */

type TabId = 'overview' | 'ledger' | 'movements' | 'bom' | 'consumption' | 'transactions' | 'suppliers';

interface InventoryItemDrawerProps {
  itemId: number | null;
  sku?: string;
  name?: string;
  /** Tab to open on, so a menu item can deep-link straight to its section. */
  initialTab?: TabId;
  onClose: () => void;
  /** Called after a write operation so the caller can refresh its table. */
  onChanged?: () => void;
}

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <Box className="w-3.5 h-3.5" /> },
  { id: 'ledger', label: 'Stock Ledger', icon: <History className="w-3.5 h-3.5" /> },
  { id: 'movements', label: 'Movements', icon: <Boxes className="w-3.5 h-3.5" /> },
  { id: 'bom', label: 'BOM', icon: <Layers className="w-3.5 h-3.5" /> },
  { id: 'consumption', label: 'Consumption', icon: <ClipboardList className="w-3.5 h-3.5" /> },
  { id: 'transactions', label: 'Journal', icon: <FileText className="w-3.5 h-3.5" /> },
  { id: 'suppliers', label: 'Suppliers', icon: <Truck className="w-3.5 h-3.5" /> },
];

const MOVEMENT_TONES: Record<string, string> = {
  purchase: 'text-emerald-600 dark:text-emerald-400',
  sale: 'text-sky-600 dark:text-sky-400',
  production_consume: 'text-indigo-600 dark:text-indigo-400',
  adjustment: 'text-amber-600 dark:text-amber-400',
  return_in: 'text-emerald-600 dark:text-emerald-400',
  return_out: 'text-rose-600 dark:text-rose-400',
  void: 'text-slate-500 dark:text-slate-400',
  transfer: 'text-violet-600 dark:text-violet-400',
  damage: 'text-rose-600 dark:text-rose-400',
  count_adjust: 'text-amber-600 dark:text-amber-400',
};

const MOVEMENT_LABELS: Record<string, string> = {
  purchase: 'Purchase',
  sale: 'Sale',
  production_consume: 'Production use',
  adjustment: 'Adjustment',
  return_in: 'Return in',
  return_out: 'Return out',
  void: 'Void',
  transfer: 'Transfer',
  damage: 'Damage',
  count_adjust: 'Count correction',
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmt(value: unknown): string {
  return formatCurrency(num(value));
}

function signedQty(value: unknown): string {
  const n = num(value);
  return `${n > 0 ? '+' : ''}${n}`;
}

const Spinner = () => (
  <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-500">
    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
    Loading from server…
  </div>
);

const ErrorBox = ({ message }: { message: string }) => (
  <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
    <span>{message}</span>
  </div>
);

const EmptyTab = ({ label }: { label: string }) => (
  <p className="py-10 text-center text-xs text-slate-400">{label}</p>
);

export const InventoryItemDrawer: React.FC<InventoryItemDrawerProps> = ({
  itemId,
  sku,
  name,
  initialTab = 'overview',
  onClose,
  onChanged,
}) => {
  const [tab, setTab] = useState<TabId>('overview');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [ledger, setLedger] = useState<any>(null);
  const [movements, setMovements] = useState<any>(null);
  const [bom, setBom] = useState<any>(null);
  const [consumption, setConsumption] = useState<any>(null);
  const [transactions, setTransactions] = useState<any>(null);
  const [suppliers, setSuppliers] = useState<any>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Tracks which tabs have already been fetched. A ref rather than state so the
  // loader identity stays stable — otherwise clearing a cache entry would not
  // change `load` and a refresh would silently skip the refetch.
  const loadedRef = useRef<Set<string>>(new Set());

  const open = itemId != null && Number.isInteger(itemId) && itemId > 0;

  const load = useCallback(
    async (force = false) => {
      if (!itemId) return;
      const needsDetail = force || !loadedRef.current.has('detail');
      const needsTab = force || !loadedRef.current.has(tab);
      if (!needsDetail && !needsTab) return;

      setLoading(true);
      setError(null);
      try {
        // Fetch the tab that is on screen plus the overview, so switching tabs
        // never blocks on a round trip for data it does not display.
        const tasks: Array<Promise<void>> = [];
        if (needsDetail) {
          tasks.push(
            commercialApi.getInventoryItem(itemId).then(d => {
              setDetail(d);
              loadedRef.current.add('detail');
            }),
          );
        }
        if (needsTab && tab === 'ledger') {
          tasks.push(
            commercialApi.getInventoryLedger(itemId).then(d => {
              setLedger(d);
              loadedRef.current.add('ledger');
            }),
          );
        }
        if (needsTab && tab === 'movements') {
          tasks.push(
            commercialApi.getInventoryMovements(itemId, { limit: 100 }).then(d => {
              setMovements(d);
              loadedRef.current.add('movements');
            }),
          );
        }
        if (needsTab && tab === 'bom') {
          tasks.push(
            commercialApi.getInventoryBom(itemId).then(d => {
              setBom(d);
              loadedRef.current.add('bom');
            }),
          );
        }
        if (needsTab && tab === 'consumption') {
          tasks.push(
            commercialApi.getInventoryConsumption(itemId).then(d => {
              setConsumption(d);
              loadedRef.current.add('consumption');
            }),
          );
        }
        if (needsTab && tab === 'transactions') {
          tasks.push(
            commercialApi.getInventoryTransactions(itemId).then(d => {
              setTransactions(d);
              loadedRef.current.add('transactions');
            }),
          );
        }
        if (needsTab && tab === 'suppliers') {
          tasks.push(
            commercialApi.getInventorySupplierHistory(itemId).then(d => {
              setSuppliers(d);
              loadedRef.current.add('suppliers');
            }),
          );
        }
        await Promise.all(tasks);
      } catch (err: any) {
        setError(err?.message || 'Failed to load inventory detail from the server.');
      } finally {
        setLoading(false);
      }
    },
    [itemId, tab]
  );

  useEffect(() => {
    if (!open) return;
    loadedRef.current.clear();
    setTab(initialTab);
    setDetail(null);
    setLedger(null);
    setMovements(null);
    setBom(null);
    setConsumption(null);
    setTransactions(null);
    setSuppliers(null);
    setError(null);
  }, [itemId, open, initialTab]);

  useEffect(() => {
    if (!open) return;
    load();
  }, [open, tab, itemId, load]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
      restoreFocusRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const symbol = getCurrencySymbol();
  const item = detail?.item ?? {};
  const isStocked = Boolean(item.is_stocked);
  const isValued = Boolean(item.is_valued);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/60 backdrop-blur-sm"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={name ? `${name} detail` : sku ? `${sku} detail` : 'Inventory item detail'}
        tabIndex={-1}
        className="animate-drawer-enter flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-slate-200/80 bg-white shadow-pop outline-none dark:border-white/[0.08] dark:bg-slate-900"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200/80 bg-gradient-to-r from-brand-600 to-brand-700 px-5 py-4 text-white dark:border-white/[0.06]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 shrink-0 opacity-90" />
              <h2 className="truncate text-sm font-bold">
                {item.name || name || 'Inventory item'}
              </h2>
            </div>
            <p className="mt-0.5 truncate font-mono text-[11px] text-white/80">
              SKU {item.sku || sku || '—'}
              {item.item_type ? ` · ${String(item.item_type).replace('_', ' ')}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail panel"
            className="rounded-lg p-1.5 text-white/80 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200/80 px-3 py-2 dark:border-white/[0.06]">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition ${
                tab === t.id
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-200'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {error && <div className="mb-4"><ErrorBox message={error} /></div>}

          {tab === 'overview' && (
            <div className="space-y-4">
              {loading && !detail ? <Spinner /> : detail ? (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="surface p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">On hand</div>
                      <div className="mt-1 font-mono text-base font-bold text-slate-900 dark:text-white">
                        {num(item.on_hand)}
                      </div>
                      <div className="text-[10px] text-slate-400">{item.usage_unit || 'units'}</div>
                    </div>
                    <div className="surface p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Avg cost</div>
                      <div className="mt-1 font-mono text-base font-bold text-slate-900 dark:text-white">
                        {fmt(item.avg_cost)}
                      </div>
                      <div className="text-[10px] text-slate-400">{symbol} / {item.usage_unit || 'unit'}</div>
                    </div>
                    <div className="surface p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Valuation</div>
                      <div className="mt-1 font-mono text-base font-bold text-slate-900 dark:text-white">
                        {fmt(item.valuation)}
                      </div>
                      <div className="text-[10px] text-slate-400">on hand × avg cost</div>
                    </div>
                    <div className="surface p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Reorder at</div>
                      <div className="mt-1 font-mono text-base font-bold text-slate-900 dark:text-white">
                        {num(item.reorder_point)}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {num(item.on_hand) <= num(item.reorder_point) ? 'At/below level' : 'Healthy'}
                      </div>
                    </div>
                  </div>

                  {isValued && (
                    <div className="surface space-y-2 p-4 text-xs">
                      <h3 className="text-[11px] font-bold uppercase tracking-[0.09em] text-slate-500">Cost basis</h3>
                      <dl className="space-y-1.5">
                        <div className="flex justify-between gap-3">
                          <dt className="text-slate-500 dark:text-slate-400">Standard cost</dt>
                          <dd className="font-mono font-semibold text-slate-800 dark:text-slate-200">{fmt(item.unit_cost)}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-slate-500 dark:text-slate-400">Moving average</dt>
                          <dd className="font-mono font-semibold text-slate-800 dark:text-slate-200">{fmt(item.avg_cost)}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-slate-500 dark:text-slate-400">Rolled-up BOM cost</dt>
                          <dd className="font-mono font-semibold text-slate-800 dark:text-slate-200">{fmt(item.bom_unit_cost)}</dd>
                        </div>
                        {isStocked && (
                          <div className="flex justify-between gap-3">
                            <dt className="text-slate-500 dark:text-slate-400">Reserved</dt>
                            <dd className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                              {num(item.reserved_qty)} {item.usage_unit || 'units'}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  )}

                  {detail.variants?.length > 0 && (
                    <div className="surface overflow-hidden">
                      <div className="border-b border-slate-200/70 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.09em] text-slate-500 dark:border-white/[0.06]">
                        Variants ({detail.variants.length})
                      </div>
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-white/[0.03]">
                          <tr>
                            <th className="px-4 py-2 text-left font-semibold">Variant</th>
                            <th className="px-4 py-2 text-right font-semibold">On hand</th>
                            <th className="px-4 py-2 text-right font-semibold">Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.variants.map((v: any) => (
                            <tr key={v.id} className="border-t border-slate-100 dark:border-white/[0.05]">
                              <td className="px-4 py-2">
                                <div className="font-medium text-slate-800 dark:text-slate-200">{v.variant_name}</div>
                                <div className="font-mono text-[10px] text-slate-400">{v.sku}</div>
                              </td>
                              <td className="px-4 py-2 text-right font-mono">{num(v.on_hand)}</td>
                              <td className="px-4 py-2 text-right font-mono">{fmt(v.unit_cost)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {detail.bom?.length > 0 && (
                    <div className="surface overflow-hidden">
                      <div className="border-b border-slate-200/70 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.09em] text-slate-500 dark:border-white/[0.06]">
                        BOM components ({detail.bom.length})
                      </div>
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-white/[0.03]">
                          <tr>
                            <th className="px-4 py-2 text-left font-semibold">Raw material</th>
                            <th className="px-4 py-2 text-right font-semibold">Qty / unit</th>
                            <th className="px-4 py-2 text-right font-semibold">Avg cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.bom.map((b: any) => (
                            <tr key={b.id} className="border-t border-slate-100 dark:border-white/[0.05]">
                              <td className="px-4 py-2">
                                <div className="font-medium text-slate-800 dark:text-slate-200">{b.raw_material_name}</div>
                                <div className="font-mono text-[10px] text-slate-400">{b.raw_material_sku}</div>
                              </td>
                              <td className="px-4 py-2 text-right font-mono">{num(b.quantity_per_unit)}</td>
                              <td className="px-4 py-2 text-right font-mono">{fmt(b.raw_material_avg_cost)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {detail.lastMovement && (
                    <div className="surface space-y-1 p-4 text-xs">
                      <h3 className="text-[11px] font-bold uppercase tracking-[0.09em] text-slate-500">Last movement</h3>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                            MOVEMENT_TONES[detail.lastMovement.movement_type] ?? 'text-slate-500'
                          }`}
                        >
                          {MOVEMENT_LABELS[detail.lastMovement.movement_type] ?? detail.lastMovement.movement_type}
                        </span>
                        <span className="font-mono font-semibold">{signedQty(detail.lastMovement.quantity_delta)}</span>
                        <span className="text-slate-400">
                          {String(detail.lastMovement.movement_at).slice(0, 19).replace('T', ' ')}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}

          {tab === 'ledger' && (
            <div>
              {loading && !ledger ? <Spinner /> : ledger ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="surface p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Receipts</div>
                      <div className="mt-1 font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">
                        {num(ledger.summary.totalReceipts)}
                      </div>
                    </div>
                    <div className="surface p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Issues</div>
                      <div className="mt-1 font-mono text-sm font-bold text-rose-600 dark:text-rose-400">
                        {num(ledger.summary.totalIssues)}
                      </div>
                    </div>
                    <div className="surface p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Net</div>
                      <div className="mt-1 font-mono text-sm font-bold text-slate-800 dark:text-slate-200">
                        {num(ledger.summary.netMovement)}
                      </div>
                    </div>
                  </div>
                  {ledger.ledger.length === 0 ? (
                    <EmptyTab label="No stock ledger entries yet." />
                  ) : (
                    <div className="surface overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-white/[0.03]">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">Date</th>
                            <th className="px-3 py-2 text-left font-semibold">Type</th>
                            <th className="px-3 py-2 text-right font-semibold">In</th>
                            <th className="px-3 py-2 text-right font-semibold">Out</th>
                            <th className="px-3 py-2 text-right font-semibold">Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ledger.ledger.map((row: any) => (
                            <tr key={row.id} className="border-t border-slate-100 dark:border-white/[0.05]">
                              <td className="px-3 py-1.5 text-slate-500">
                                {String(row.movement_at).slice(0, 10)}
                              </td>
                              <td
                                className={`px-3 py-1.5 font-semibold ${
                                  MOVEMENT_TONES[row.movement_type] ?? 'text-slate-500'
                                }`}
                              >
                                {MOVEMENT_LABELS[row.movement_type] ?? row.movement_type}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-emerald-600 dark:text-emerald-400">
                                {row.direction === 'in' ? num(row.quantity_delta) : ''}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-rose-600 dark:text-rose-400">
                                {row.direction === 'out' ? Math.abs(num(row.quantity_delta)) : ''}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono font-semibold">
                                {num(row.balance_qty)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="text-[10px] text-slate-400">
                    Balances are the ones stored on each movement row, not recomputed in the browser.
                  </p>
                </div>
              ) : null}
            </div>
          )}

          {tab === 'movements' && (
            <div>
              {loading && !movements ? <Spinner /> : movements ? (
                movements.movements.length === 0 ? (
                  <EmptyTab label="No movements recorded." />
                ) : (
                  <div className="space-y-2">
                    <p className="text-[10px] text-slate-400">
                      Showing {movements.movements.length} of {movements.total} movements, newest first.
                    </p>
                    {movements.movements.map((m: any) => (
                      <div key={m.id} className="surface flex items-center justify-between gap-3 p-3 text-xs">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                                MOVEMENT_TONES[m.movement_type] ?? 'text-slate-500'
                              }`}
                            >
                              {MOVEMENT_LABELS[m.movement_type] ?? m.movement_type}
                            </span>
                            <span className="font-mono text-[10px] text-slate-400">
                              {String(m.movement_at).slice(0, 19).replace('T', ' ')}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-[10px] text-slate-400">
                            {m.source_type ?? '—'}
                            {m.source_id ? ` #${m.source_id}` : ''}
                            {m.location ? ` · ${m.location}` : ''}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div
                            className={`font-mono text-sm font-bold ${
                              num(m.quantity_delta) >= 0
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {signedQty(m.quantity_delta)}
                          </div>
                          <div className="font-mono text-[10px] text-slate-400">bal {num(m.balance_qty)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : null}
            </div>
          )}

          {tab === 'bom' && (
            <div>
              {loading && !bom ? <Spinner /> : bom ? (
                bom.components.length === 0 ? (
                  <EmptyTab label="This item has no bill of materials." />
                ) : (
                  <div className="space-y-3">
                    <div className="surface flex items-center justify-between p-4 text-xs">
                      <span className="font-semibold text-slate-600 dark:text-slate-300">Rolled-up unit cost</span>
                      <span className="font-mono text-base font-bold text-slate-900 dark:text-white">
                        {fmt(bom.computedUnitCost)}
                      </span>
                    </div>
                    <div className="surface overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-white/[0.03]">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">Raw material</th>
                            <th className="px-3 py-2 text-right font-semibold">Qty/unit</th>
                            <th className="px-3 py-2 text-right font-semibold">Avg cost</th>
                            <th className="px-3 py-2 text-right font-semibold">Ext.</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bom.components.map((c: any) => (
                            <tr key={c.id} className="border-t border-slate-100 dark:border-white/[0.05]">
                              <td className="px-3 py-1.5">
                                <div className="font-medium text-slate-800 dark:text-slate-200">{c.raw_material_name}</div>
                                <div className="font-mono text-[10px] text-slate-400">{c.raw_material_sku}</div>
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono">{num(c.quantity_per_unit)}</td>
                              <td className="px-3 py-1.5 text-right font-mono">{fmt(c.raw_material_avg_cost)}</td>
                              <td className="px-3 py-1.5 text-right font-mono font-semibold">
                                {fmt(c.extended_unit_cost)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              ) : null}
            </div>
          )}

          {tab === 'consumption' && (
            <div>
              {loading && !consumption ? <Spinner /> : consumption ? (
                consumption.jobs.length === 0 ? (
                  <EmptyTab label="No job consumption recorded for this item." />
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="surface p-3">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Issued</div>
                        <div className="mt-1 font-mono text-sm font-bold">{num(consumption.summary.totalIssued)}</div>
                      </div>
                      <div className="surface p-3">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Good</div>
                        <div className="mt-1 font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">
                          {num(consumption.summary.totalGood)}
                        </div>
                      </div>
                      <div className="surface p-3">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Waste</div>
                        <div className="mt-1 font-mono text-sm font-bold text-rose-600 dark:text-rose-400">
                          {num(consumption.summary.totalWaste)}
                        </div>
                        <div className="text-[10px] text-slate-400">{consumption.summary.wastePct}</div>
                      </div>
                      <div className="surface p-3">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Jobs</div>
                        <div className="mt-1 font-mono text-sm font-bold">{consumption.summary.jobCount}</div>
                      </div>
                    </div>
                    <div className="surface overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-white/[0.03]">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">Job</th>
                            <th className="px-3 py-2 text-right font-semibold">Issued</th>
                            <th className="px-3 py-2 text-right font-semibold">Good</th>
                            <th className="px-3 py-2 text-right font-semibold">Waste</th>
                            <th className="px-3 py-2 text-right font-semibold">Returned</th>
                          </tr>
                        </thead>
                        <tbody>
                          {consumption.jobs.map((j: any) => (
                            <tr key={j.id} className="border-t border-slate-100 dark:border-white/[0.05]">
                              <td className="px-3 py-1.5">
                                <div className="font-medium text-slate-800 dark:text-slate-200">{j.job_number}</div>
                                <div className="text-[10px] capitalize text-slate-400">
                                  {String(j.job_status ?? '').replace('_', ' ')}
                                </div>
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono">{num(j.issued_usage_qty)}</td>
                              <td className="px-3 py-1.5 text-right font-mono">{num(j.actual_good_usage_qty)}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-rose-600 dark:text-rose-400">
                                {num(j.waste_usage_qty)}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono">{num(j.returned_usage_qty)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              ) : null}
            </div>
          )}

          {tab === 'transactions' && (
            <div>
              {loading && !transactions ? <Spinner /> : transactions ? (
                <div className="space-y-4">
                  <div className="surface overflow-hidden">
                    <div className="border-b border-slate-200/70 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.09em] text-slate-500 dark:border-white/[0.06]">
                      Journal entries
                    </div>
                    {transactions.transactions.length === 0 ? (
                      <EmptyTab label="No journal entries touch this item." />
                    ) : (
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-white/[0.03]">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">Entry</th>
                            <th className="px-3 py-2 text-left font-semibold">Date</th>
                            <th className="px-3 py-2 text-left font-semibold">Description</th>
                          </tr>
                        </thead>
                        <tbody>
                          {transactions.transactions.map((t: any) => (
                            <tr key={t.id} className="border-t border-slate-100 dark:border-white/[0.05]">
                              <td className="px-3 py-1.5 font-mono font-semibold">{t.entry_number}</td>
                              <td className="px-3 py-1.5 text-slate-500">
                                {String(t.txn_date).slice(0, 10)}
                              </td>
                              <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">
                                {t.description}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <div className="surface overflow-hidden">
                    <div className="border-b border-slate-200/70 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.09em] text-slate-500 dark:border-white/[0.06]">
                      Damage register
                    </div>
                    {transactions.damages.length === 0 ? (
                      <EmptyTab label="No damage write-offs recorded." />
                    ) : (
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-white/[0.03]">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">Date</th>
                            <th className="px-3 py-2 text-right font-semibold">Qty</th>
                            <th className="px-3 py-2 text-right font-semibold">Value</th>
                            <th className="px-3 py-2 text-left font-semibold">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {transactions.damages.map((d: any) => (
                            <tr key={d.id} className="border-t border-slate-100 dark:border-white/[0.05]">
                              <td className="px-3 py-1.5 text-slate-500">{String(d.damage_date).slice(0, 10)}</td>
                              <td className="px-3 py-1.5 text-right font-mono">{num(d.quantity)}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-rose-600 dark:text-rose-400">
                                {fmt(d.value)}
                              </td>
                              <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold dark:bg-white/10">
                                  {d.reason_code}
                                </span>
                                {d.reason ? <span className="ml-1.5 text-slate-500">{d.reason}</span> : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {tab === 'suppliers' && (
            <div>
              {loading && !suppliers ? <Spinner /> : suppliers ? (
                suppliers.vendors.length === 0 ? (
                  <EmptyTab label="No purchase history for this item." />
                ) : (
                  <div className="space-y-3">
                    <div className="surface overflow-hidden">
                      <div className="border-b border-slate-200/70 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.09em] text-slate-500 dark:border-white/[0.06]">
                        By vendor
                      </div>
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-white/[0.03]">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">Vendor</th>
                            <th className="px-3 py-2 text-right font-semibold">Orders</th>
                            <th className="px-3 py-2 text-right font-semibold">Qty</th>
                            <th className="px-3 py-2 text-right font-semibold">Total</th>
                            <th className="px-3 py-2 text-left font-semibold">Last</th>
                          </tr>
                        </thead>
                        <tbody>
                          {suppliers.vendors.map((v: any) => (
                            <tr key={v.vendorId} className="border-t border-slate-100 dark:border-white/[0.05]">
                              <td className="px-3 py-1.5 font-medium text-slate-800 dark:text-slate-200">
                                {v.vendorName}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono">{v.orders}</td>
                              <td className="px-3 py-1.5 text-right font-mono">{num(v.totalQuantity)}</td>
                              <td className="px-3 py-1.5 text-right font-mono font-semibold">{fmt(v.totalValue)}</td>
                              <td className="px-3 py-1.5 text-slate-500">
                                {v.lastPurchaseDate ? String(v.lastPurchaseDate).slice(0, 10) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="surface overflow-hidden">
                      <div className="border-b border-slate-200/70 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.09em] text-slate-500 dark:border-white/[0.06]">
                        Purchases ({suppliers.purchases.length})
                      </div>
                      {suppliers.purchases.length === 0 ? (
                        <EmptyTab label="No bills reference this item." />
                      ) : (
                        <table className="w-full text-xs">
                          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-white/[0.03]">
                            <tr>
                              <th className="px-3 py-2 text-left font-semibold">Bill</th>
                              <th className="px-3 py-2 text-left font-semibold">Vendor</th>
                              <th className="px-3 py-2 text-right font-semibold">Qty</th>
                              <th className="px-3 py-2 text-right font-semibold">Unit cost</th>
                              <th className="px-3 py-2 text-right font-semibold">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {suppliers.purchases.map((p: any) => (
                              <tr key={p.bill_id} className="border-t border-slate-100 dark:border-white/[0.05]">
                                <td className="px-3 py-1.5">
                                  <div className="font-mono font-semibold">{p.bill_number}</div>
                                  <div className="text-[10px] text-slate-400">
                                    {String(p.bill_date).slice(0, 10)}
                                  </div>
                                </td>
                                <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">{p.vendor_name}</td>
                                <td className="px-3 py-1.5 text-right font-mono">{num(p.quantity)}</td>
                                <td className="px-3 py-1.5 text-right font-mono">{fmt(p.unit_cost)}</td>
                                <td className="px-3 py-1.5 text-right font-mono font-semibold">{fmt(p.line_amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                )
              ) : null}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200/80 bg-slate-50/70 px-5 py-3 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <p className="flex items-center gap-1.5 text-[10px] text-slate-400">
            <BarChart3 className="h-3 w-3" />
            Values from the server ledger
          </p>
          <button
            type="button"
            onClick={() => {
              // Force a refetch of the current tab plus the overview so any
              // stock movement posted elsewhere is reflected immediately.
              load(true);
              onChanged?.();
            }}
            className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
};

export default InventoryItemDrawer;