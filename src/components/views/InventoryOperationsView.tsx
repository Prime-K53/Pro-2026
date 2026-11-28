import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { commercialApi } from '../../services/commercialApi';
import { Loader2, Package } from 'lucide-react';
import { Button, InlineAlert, PageHeader, PageShell, Tabs } from '../common/ui';

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
    <PageShell>
      <PageHeader
        title="Inventory Operations"
        subtitle="Movement audit, stock ledger, BOM, consumption and write actions for every stocked item."
        icon={<Package className="w-5 h-5" strokeWidth={1.75} />}
      />

      {error && (
        <InlineAlert tone="error" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      {/* Reorder levels */}
      {reorder && Array.isArray(reorder.items) && reorder.items.length > 0 && (
        <div className="surface overflow-hidden">
          <div className="surface-header">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Below Reorder Point</h3>
          </div>
          <table className="data-table w-full text-left text-xs">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Item</th>
                <th className="text-right">On Hand</th>
                <th className="text-right">Reorder Point</th>
              </tr>
            </thead>
            <tbody>
              {reorder.items.slice(0, 10).map((r: any, i: number) => (
                <tr key={i}>
                  <td className="font-mono font-semibold">{r.sku}</td>
                  <td>{r.name}</td>
                  <td className="text-right font-mono tabular-nums">{Number(r.on_hand ?? 0)}</td>
                  <td className="text-right font-mono tabular-nums">{Number(r.reorder_point ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Item selector + tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="inv-ops-item" className="text-xs font-semibold text-slate-600 dark:text-slate-300">Item:</label>
          <select
            id="inv-ops-item"
            value={selectedId}
            onChange={e => setSelectedId(e.target.value)}
            className="app-input !w-auto text-xs font-semibold"
          >
            {inventoryItems.length === 0 && <option value="">(no inventory items)</option>}
            {inventoryItems.map(i => (
              <option key={i.id} value={i.id}>
                {i.sku} — {i.name}
              </option>
            ))}
          </select>
        </div>

        <Tabs
          ariaLabel="Inventory operation views"
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          tabs={TABS}
        />
      </div>

      {loading ? (
        <div className="surface p-10 flex items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : tab === 'actions' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <form onSubmit={handleDamage} className="surface p-5 space-y-3 text-xs">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Record Damage / Spoilage</h3>
            <label className="block space-y-1">
              <span className="app-label">Quantity</span>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={dmgQty}
                onChange={e => setDmgQty(e.target.value)}
                required
                className="app-input app-input-mono"
              />
            </label>
            <label className="block space-y-1">
              <span className="app-label">Reason</span>
              <input
                value={dmgReason}
                onChange={e => setDmgReason(e.target.value)}
                className="app-input"
              />
            </label>
            <Button type="submit" variant="danger" className="w-full">Write Off Damaged Stock</Button>
          </form>

          <form onSubmit={handleTransfer} className="surface p-5 space-y-3 text-xs">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Transfer Stock Between Locations</h3>
            <label className="block space-y-1">
              <span className="app-label">Quantity</span>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={xferQty}
                onChange={e => setXferQty(e.target.value)}
                required
                className="app-input app-input-mono"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="app-label">From location</span>
                <input
                  value={xferFrom}
                  onChange={e => setXferFrom(e.target.value)}
                  className="app-input"
                />
              </label>
              <label className="space-y-1">
                <span className="app-label">To location</span>
                <input
                  value={xferTo}
                  onChange={e => setXferTo(e.target.value)}
                  className="app-input"
                />
              </label>
            </div>
            <Button type="submit" variant="primary" className="w-full">Transfer Stock</Button>
          </form>
        </div>
      ) : (
        <div className="surface overflow-hidden">
          <table className="data-table w-full text-left text-xs">
            <thead>
              {tab === 'movements' && (
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th className="text-right">Qty Δ</th>
                  <th className="text-right">Unit Cost</th>
                  <th className="text-right">Balance</th>
                  <th>Source</th>
                </tr>
              )}
              {tab === 'ledger' && (
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th className="text-right">Qty Δ</th>
                  <th className="text-right">Balance</th>
                </tr>
              )}
              {tab === 'bom' && (
                <tr>
                  <th>SKU</th>
                  <th>Component</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Unit Cost</th>
                </tr>
              )}
              {tab === 'consumption' && (
                <tr>
                  <th>Job</th>
                  <th>Title</th>
                  <th className="text-right">Qty Used</th>
                  <th>Date</th>
                </tr>
              )}
              {tab === 'suppliers' && (
                <tr>
                  <th>Vendor</th>
                  <th className="text-right">Purchases</th>
                  <th className="text-right">Qty</th>
                  <th>Last Purchase</th>
                </tr>
              )}
            </thead>
            <tbody>
              {tab === 'movements' &&
                (data?.movements || []).map((m: any, i: number) => (
                  <tr key={i}>
                    <td className="font-mono">{String(m.created_at ?? m.date ?? '').slice(0, 10)}</td>
                    <td>{m.movement_type ?? m.type}</td>
                    <td className="text-right font-mono tabular-nums">{Number(m.quantity_delta ?? 0)}</td>
                    <td className="text-right font-mono tabular-nums">{formatCurrency(Number(m.unit_cost ?? 0), currency)}</td>
                    <td className="text-right font-mono tabular-nums">{Number(m.balance_qty ?? 0)}</td>
                    <td className="text-slate-500">{m.source_type ?? ''}</td>
                  </tr>
                ))}
              {tab === 'ledger' &&
                (data?.ledger || []).map((m: any, i: number) => (
                  <tr key={i}>
                    <td className="font-mono">{String(m.created_at ?? m.date ?? '').slice(0, 10)}</td>
                    <td>{m.movement_type ?? m.type}</td>
                    <td className="text-right font-mono tabular-nums">{Number(m.quantity_delta ?? 0)}</td>
                    <td className="text-right font-mono tabular-nums">{Number(m.balance_qty ?? 0)}</td>
                  </tr>
                ))}
              {tab === 'bom' &&
                (data?.components || []).map((c: any, i: number) => (
                  <tr key={i}>
                    <td className="font-mono font-semibold">{c.sku ?? c.component_sku}</td>
                    <td>{c.name ?? c.component_name}</td>
                    <td className="text-right font-mono tabular-nums">{Number(c.quantity ?? 0)}</td>
                    <td className="text-right font-mono tabular-nums">{formatCurrency(Number(c.unit_cost ?? 0), currency)}</td>
                  </tr>
                ))}
              {tab === 'consumption' &&
                (data?.jobs || []).map((j: any, i: number) => (
                  <tr key={i}>
                    <td className="font-mono font-semibold">{j.job_number ?? j.jobNumber}</td>
                    <td>{j.title ?? j.name}</td>
                    <td className="text-right font-mono tabular-nums">{Number(j.quantity ?? j.qty_used ?? 0)}</td>
                    <td className="font-mono">{String(j.date ?? j.created_at ?? '').slice(0, 10)}</td>
                  </tr>
                ))}
              {tab === 'suppliers' &&
                (data?.vendors || []).map((v: any, i: number) => (
                  <tr key={i}>
                    <td>{v.name ?? v.vendor_name}</td>
                    <td className="text-right font-mono tabular-nums">{formatCurrency(Number(v.total ?? 0), currency)}</td>
                    <td className="text-right font-mono tabular-nums">{Number(v.quantity ?? 0)}</td>
                    <td className="font-mono">{String(v.last_purchase ?? v.lastDate ?? '').slice(0, 10)}</td>
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
            <div className="px-4 py-2 border-t border-slate-200 dark:border-white/[0.08] text-xs">
              Rolled-up unit cost: <strong className="font-mono tabular-nums">{formatCurrency(Number(data.computedUnitCost), currency)}</strong>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
};