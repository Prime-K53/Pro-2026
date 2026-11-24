import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { commercialApi } from '../../services/commercialApi';
import { Loader2, Package, AlertTriangle } from 'lucide-react';

type Tab = 'movements' | 'ledger' | 'bom' | 'consumption' | 'suppliers' | 'actions';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'movements', label: 'Movements' },
  { id: 'ledger', label: 'Stock Ledger' },
  { id: 'bom', label: 'BOM' },
  { id: 'consumption', label: 'Consumption' },
  { id: 'suppliers', label: 'Supplier History' },
  { id: 'actions', label: 'Adjust / Transfer' },
];

/**
 * Inventory operations console: per-item movement stream, running-balance
 * ledger, bill of materials, job consumption, supplier history, and the
 * write actions (damage write-off, internal transfer) that were previously
 * headless. Also shows company-wide reorder levels.
 */
export const InventoryOperationsView: React.FC = () => {
  const { inventoryItems, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [selectedId, setSelectedId] = useState<string>(() => (inventoryItems[0] ? String(inventoryItems[0].id) : ''));
  const [tab, setTab] = useState<Tab>('movements');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);

  // Reorder levels (company-wide)
  const [reorder, setReorder] = useState<any>(null);

  // Damage form
  const [dmgQty, setDmgQty] = useState('');
  const [dmgReason, setDmgReason] = useState('');
  // Transfer form
  const [xferQty, setXferQty] = useState('');
  const [xferFrom, setXferFrom] = useState('');
  const [xferTo, setXferTo] = useState('');

  const backendId = useMemo(() => (selectedId ? Number(selectedId) : 0), [selectedId]);
  const selectedItem = useMemo(() => inventoryItems.find(i => String(i.id) === selectedId), [inventoryItems, selectedId]);

  const loadTab = useCallback(async () => {
    if (!backendId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let result: any = null;
      switch (tab) {
        case 'movements':
          result = await commercialApi.getInventoryMovements(backendId, { limit: 100 });
          break;
        case 'ledger':
          result = await commercialApi.getInventoryLedger(backendId);
          break;
        case 'bom':
          result = await commercialApi.getInventoryBom(backendId);
          break;
        case 'consumption':
          result = await commercialApi.getInventoryConsumption(backendId);
          break;
        case 'suppliers':
          result = await commercialApi.getInventorySupplierHistory(backendId);
          break;
        default:
          result = null;
      }
      setData(result);
    } catch (err: any) {
      setError(err?.message || 'Failed to load inventory data');
    } finally {
      setLoading(false);
    }
  }, [backendId, tab]);

  useEffect(() => {
    loadTab();
  }, [loadTab]);

  useEffect(() => {
    commercialApi
      .getReorderLevels()
      .then(setReorder)
      .catch(() => setReorder(null));
  }, []);

  const handleDamage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backendId) return;
    setError(null);
    try {
      await commercialApi.recordStockDamage(backendId, { quantity: dmgQty, reason: dmgReason || null });
      triggerShortcutNotice(`Recorded damage of ${dmgQty} for ${selectedItem?.sku ?? 'item'}`);
      setDmgQty('');
      setDmgReason('');
      loadTab();
    } catch (err: any) {
      setError(err?.message || 'Damage write-off failed');
    }
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backendId) return;
    setError(null);
    try {
      await commercialApi.transferStock({
        fromLocation: xferFrom || null,
        toLocation: xferTo || null,
        lines: [{ itemId: backendId, quantity: xferQty }],
      });
      triggerShortcutNotice(`Transferred ${xferQty} of ${selectedItem?.sku ?? 'item'} to ${xferTo || 'target'}`);
      setXferQty('');
      loadTab();
    } catch (err: any) {
      setError(err?.message || 'Stock transfer failed');
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Inventory Operations</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          Movement audit, stock ledger, BOM, consumption and write actions for every stocked item.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Reorder levels */}
      {reorder && Array.isArray(reorder.items) && reorder.items.length > 0 && (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">Below Reorder Point</h3>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase font-bold text-slate-500">
              <tr>
                <th className="px-4 py-2">SKU</th>
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2 text-right">On Hand</th>
                <th className="px-4 py-2 text-right">Reorder Point</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {reorder.items.slice(0, 10).map((r: any, i: number) => (
                <tr key={i}>
                  <td className="px-4 py-2 font-mono font-bold">{r.sku}</td>
                  <td className="px-4 py-2">{r.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(r.on_hand ?? 0)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(r.reorder_point ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Item selector + tabs */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">Item:</label>
        <select
          value={selectedId}
          onChange={e => setSelectedId(e.target.value)}
          className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-1.5 text-xs font-semibold"
        >
          {inventoryItems.length === 0 && <option value="">(no inventory items)</option>}
          {inventoryItems.map(i => (
            <option key={i.id} value={i.id}>
              {i.sku} — {i.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 text-xs font-semibold w-fit">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-lg transition-colors ${
              tab === t.id ? 'bg-[#0f3d63] text-white shadow-xs' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="p-10 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : tab === 'actions' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <form onSubmit={handleDamage} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3 text-xs">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">Record Damage / Spoilage</h3>
            <label className="block space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Quantity</span>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={dmgQty}
                onChange={e => setDmgQty(e.target.value)}
                required
                className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
              />
            </label>
            <label className="block space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Reason</span>
              <input
                value={dmgReason}
                onChange={e => setDmgReason(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
              />
            </label>
            <button type="submit" className="btn btn-danger w-full">Write Off Damaged Stock</button>
          </form>

          <form onSubmit={handleTransfer} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3 text-xs">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">Transfer Stock Between Locations</h3>
            <label className="block space-y-1">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Quantity</span>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={xferQty}
                onChange={e => setXferQty(e.target.value)}
                required
                className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="font-semibold text-slate-600 dark:text-slate-300">From location</span>
                <input
                  value={xferFrom}
                  onChange={e => setXferFrom(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
                />
              </label>
              <label className="space-y-1">
                <span className="font-semibold text-slate-600 dark:text-slate-300">To location</span>
                <input
                  value={xferTo}
                  onChange={e => setXferTo(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
                />
              </label>
            </div>
            <button type="submit" className="btn btn-primary w-full">Transfer Stock</button>
          </form>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase font-bold text-slate-500 border-b border-slate-200 dark:border-slate-800">
              {tab === 'movements' && (
                <tr>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5 text-right">Qty Δ</th>
                  <th className="px-4 py-2.5 text-right">Unit Cost</th>
                  <th className="px-4 py-2.5 text-right">Balance</th>
                  <th className="px-4 py-2.5">Source</th>
                </tr>
              )}
              {tab === 'ledger' && (
                <tr>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5 text-right">Qty Δ</th>
                  <th className="px-4 py-2.5 text-right">Balance</th>
                </tr>
              )}
              {tab === 'bom' && (
                <tr>
                  <th className="px-4 py-2.5">SKU</th>
                  <th className="px-4 py-2.5">Component</th>
                  <th className="px-4 py-2.5 text-right">Qty</th>
                  <th className="px-4 py-2.5 text-right">Unit Cost</th>
                </tr>
              )}
              {tab === 'consumption' && (
                <tr>
                  <th className="px-4 py-2.5">Job</th>
                  <th className="px-4 py-2.5">Title</th>
                  <th className="px-4 py-2.5 text-right">Qty Used</th>
                  <th className="px-4 py-2.5">Date</th>
                </tr>
              )}
              {tab === 'suppliers' && (
                <tr>
                  <th className="px-4 py-2.5">Vendor</th>
                  <th className="px-4 py-2.5 text-right">Purchases</th>
                  <th className="px-4 py-2.5 text-right">Qty</th>
                  <th className="px-4 py-2.5">Last Purchase</th>
                </tr>
              )}
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {tab === 'movements' &&
                (data?.movements || []).map((m: any, i: number) => (
                  <tr key={i}>
                    <td className="px-4 py-2">{String(m.created_at ?? m.date ?? '').slice(0, 10)}</td>
                    <td className="px-4 py-2">{m.movement_type ?? m.type}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(m.quantity_delta ?? 0)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(Number(m.unit_cost ?? 0), currency)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(m.balance_qty ?? 0)}</td>
                    <td className="px-4 py-2 text-slate-500">{m.source_type ?? ''}</td>
                  </tr>
                ))}
              {tab === 'ledger' &&
                (data?.ledger || []).map((m: any, i: number) => (
                  <tr key={i}>
                    <td className="px-4 py-2">{String(m.created_at ?? m.date ?? '').slice(0, 10)}</td>
                    <td className="px-4 py-2">{m.movement_type ?? m.type}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(m.quantity_delta ?? 0)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(m.balance_qty ?? 0)}</td>
                  </tr>
                ))}
              {tab === 'bom' &&
                (data?.components || []).map((c: any, i: number) => (
                  <tr key={i}>
                    <td className="px-4 py-2 font-mono font-bold">{c.sku ?? c.component_sku}</td>
                    <td className="px-4 py-2">{c.name ?? c.component_name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(c.quantity ?? 0)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(Number(c.unit_cost ?? 0), currency)}</td>
                  </tr>
                ))}
              {tab === 'consumption' &&
                (data?.jobs || []).map((j: any, i: number) => (
                  <tr key={i}>
                    <td className="px-4 py-2 font-mono font-bold">{j.job_number ?? j.jobNumber}</td>
                    <td className="px-4 py-2">{j.title ?? j.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(j.quantity ?? j.qty_used ?? 0)}</td>
                    <td className="px-4 py-2">{String(j.date ?? j.created_at ?? '').slice(0, 10)}</td>
                  </tr>
                ))}
              {tab === 'suppliers' &&
                (data?.vendors || []).map((v: any, i: number) => (
                  <tr key={i}>
                    <td className="px-4 py-2">{v.name ?? v.vendor_name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(Number(v.total ?? 0), currency)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(v.quantity ?? 0)}</td>
                    <td className="px-4 py-2">{String(v.last_purchase ?? v.lastDate ?? '').slice(0, 10)}</td>
                  </tr>
                ))}
              {((tab === 'movements' && (data?.movements || []).length === 0) ||
                (tab === 'ledger' && (data?.ledger || []).length === 0) ||
                (tab === 'bom' && (data?.components || []).length === 0) ||
                (tab === 'consumption' && (data?.jobs || []).length === 0) ||
                (tab === 'suppliers' && (data?.vendors || []).length === 0)) && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                    <Package className="w-6 h-6 mx-auto mb-1" />
                    No records for this item.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {tab === 'bom' && data?.computedUnitCost != null && (
            <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 text-xs">
              Rolled-up unit cost: <strong className="font-mono">{formatCurrency(Number(data.computedUnitCost), currency)}</strong>
            </div>
          )}
        </div>
      )}
    </div>
  );
};