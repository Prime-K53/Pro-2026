import React, { useState, useMemo, useEffect } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { commercialApi } from '../../services/commercialApi';
import {
  BomComponent,
  INVOICEABLE_ITEM_TYPES,
  InventoryItem,
  ItemVariant,
  ITEM_TYPE_LABELS,
  STOCKED_ITEM_TYPES,
} from '../../types/accounting';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';
import {
  TransactionDetailDrawer,
  TransactionActionMenu,
  TransactionContextMenu,
  TransactionSelectionProvider,
  useTransactionSelection,
  type DetailSection,
} from '../../transaction-interaction';
import {
  Package,
  Plus,
  Search,
  AlertTriangle,
  CheckCircle2,
  Layers,
  X,
  FileText,
  Copy,
  SlidersHorizontal,
  Trash2,
  Save,
  Tags,
  Calculator,
  PackageMinus,
  Truck,
  ClipboardList,
  History,
  Boxes,
  BarChart3,
  ShoppingCart,
  Pencil,
  Download,
} from 'lucide-react';
import { InventoryItemDrawer } from '../inventory/InventoryItemDrawer';
import { EditItemModal } from '../inventory/EditItemModal';

type DrawerTabId =
  | 'overview'
  | 'ledger'
  | 'movements'
  | 'bom'
  | 'consumption'
  | 'transactions'
  | 'suppliers';

/**
 * Open the detail drawer on a specific tab. Every drill-down menu item funnels
 * through here so a "View Stock Ledger" action lands on the ledger, not on a
 * generic overview.
 */
const openDetail = (
  itemId: number | string,
  sku: string,
  name: string,
  tab: DrawerTabId,
  setItem: (id: number | null) => void,
  setLabel: (v: { sku?: string; name?: string }) => void,
  setTab: (t: DrawerTabId) => void
) => {
  setLabel({ sku, name });
  setTab(tab);
  setItem(Number(itemId));
};
import { StockDamageModal } from '../inventory/StockDamageModal';
import { StockTransferModal } from '../inventory/StockTransferModal';
import { StockCountModal } from '../inventory/StockCountModal';
import { TransferReceiveModal } from '../inventory/TransferReceiveModal';

interface InventoryTableProps<TRow extends { id: string | number }> {
  rows: TRow[];
  colSpan: number;
  emptyMessage: string;
  renderHeader: () => React.ReactNode;
  renderCells: (row: TRow) => React.ReactNode;
  onRowClick: (row: TRow) => void;
  onRowContextMenu: (row: TRow, point: { x: number; y: number }) => void;
  selectedId: string | number | null;
  notify: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
  exportName: string;
  exportHeader: string[];
  exportRows: (rows: TRow[]) => any[][];
}

function InventoryTableInner<TRow extends { id: string | number }>({
  rows,
  colSpan,
  emptyMessage,
  renderHeader,
  renderCells,
  onRowClick,
  onRowContextMenu,
  selectedId,
  notify,
  exportName,
  exportHeader,
  exportRows,
}: InventoryTableProps<TRow>) {
  const selection = useTransactionSelection();
  useEffect(() => {
    selection.setOrderedIds(rows.map((r) => r.id));
  }, [rows, selection]);
  const selectedRows = rows.filter((r) => selection.isSelected(r.id));
  const allSelected = rows.length > 0 && rows.every((r) => selection.isSelected(r.id));

  const exportSelected = () => {
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = exportRows(selectedRows).map((r) => r.map(cell).join(','));
    const blob = new Blob([[exportHeader.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName;
    a.click();
    URL.revokeObjectURL(url);
    notify(`Exported ${selectedRows.length} item(s)`);
  };

  return (
    <>
      {selectedRows.length > 0 && (
        <div className="flex justify-end px-1">
          <button
            type="button"
            onClick={exportSelected}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Download className="w-3.5 h-3.5" /> Export selected ({selectedRows.length})
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
            <tr>
              <th className="px-3 py-3 w-8">
                <input
                  type="checkbox"
                  aria-label="Select all items"
                  checked={allSelected}
                  onChange={() => (allSelected ? selection.clear() : selection.selectAll(rows.map((r) => r.id)))}
                />
              </th>
              {renderHeader()}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={colSpan + 1} className="px-4 py-10 text-center text-slate-500 font-sans">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelected = selection.isSelected(row.id);
                return (
                  <tr
                    key={row.id}
                    onClick={() => onRowClick(row)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onRowContextMenu(row, { x: e.clientX, y: e.clientY });
                    }}
                    className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-850/50 ${
                      isSelected ? 'bg-blue-50/70 dark:bg-blue-900/20' : selectedId === row.id ? 'bg-blue-50/70 dark:bg-blue-900/20 ring-1 ring-inset ring-blue-200 dark:ring-blue-800' : ''
                    }`}
                  >
                    <td className="px-3 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.id}`}
                        checked={isSelected}
                        onChange={(e) => selection.toggle(row.id, { shiftKey: (e.nativeEvent as MouseEvent).shiftKey })}
                      />
                    </td>
                    {renderCells(row)}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function InventoryTable<TRow extends { id: string | number }>(props: InventoryTableProps<TRow>) {
  return (
    <TransactionSelectionProvider>
      <InventoryTableInner {...props} />
    </TransactionSelectionProvider>
  );
}

export const InventoryView: React.FC = () => {
  const {
    companyProfile,
    inventoryItems,
    setIsNewItemOpen,
    setIsNewInvoiceOpen,
    getRawUsageUnitCost,
    computeBomUnitCost,
    getItemUnitCost,
    triggerShortcutNotice,
  } = useAccounting();
  const { hasPermission, authenticated, permissions, activeCompany } = useAuth();
  const canWriteInventory = hasPermission('inventory:write');
  const canAdjustStock = hasPermission('inventory:adjust');
  const canTransferStock = hasPermission('inventory:transfer');
  const canRunStockCount = hasPermission('inventory:count');
  const canRecordDamage = hasPermission('inventory:damage');
  const canDeactivateItem = hasPermission('inventory:deactivate');
  const currency = companyProfile.currency || 'K';
  const currencySymbol = getCurrencySymbol(currency);

  // Advanced operations: detail drawer plus the stock damage / transfer / count dialogs.
  const [detailItemId, setDetailItemId] = useState<number | null>(null);
  const [detailItemLabel, setDetailItemLabel] = useState<{ sku?: string; name?: string }>({});
  const [detailTab, setDetailTab] = useState<DrawerTabId>('overview');
  const [damageItem, setDamageItem] = useState<InventoryItem | null>(null);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferItemId, setTransferItemId] = useState<string | number | null>(null);
  const [countOpen, setCountOpen] = useState(false);
  const [countItemId, setCountItemId] = useState<string | number | null>(null);
  const [receiveTransferOpen, setReceiveTransferOpen] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: InventoryItem } | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [itemToAdjust, setItemToAdjust] = useState<InventoryItem | null>(null);
  const [adjustmentQty, setAdjustmentQty] = useState<number>(0);
  const [adjustmentReason, setAdjustmentReason] = useState('Cycle count audit');
  const [adjusting, setAdjusting] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [savingItem, setSavingItem] = useState(false);

  // BOM Inspector / Editor state (for Printed Products & Printing Services)
  const [bomEditItem, setBomEditItem] = useState<InventoryItem | null>(null);
  const [draftBomLines, setDraftBomLines] = useState<BomComponent[]>([]);
  const [draftSalesPrice, setDraftSalesPrice] = useState<number>(0);

  // Raw Material Conversion & Cost Editor
  const [rawEditItem, setRawEditItem] = useState<InventoryItem | null>(null);
  const [draftRawCost, setDraftRawCost] = useState<number>(0);
  const [draftPurchaseUnit, setDraftPurchaseUnit] = useState('Ream');
  const [draftUsageUnit, setDraftUsageUnit] = useState('Sheet');
  const [draftConversionFactor, setDraftConversionFactor] = useState<number>(500);

  // Variants Manager Modal (for Stationery & Printed Products)
  const [variantEditItem, setVariantEditItem] = useState<InventoryItem | null>(null);
  const [draftVariants, setDraftVariants] = useState<ItemVariant[]>([]);

  const rawMaterials = useMemo(
    () => inventoryItems.filter(i => i.type === 'raw_material'),
    [inventoryItems]
  );

  const filteredItems = inventoryItems.filter(item => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      item.name.toLowerCase().includes(q) ||
      item.sku.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      (item.variants || []).some(
        v => v.name.toLowerCase().includes(q) || v.sku.toLowerCase().includes(q)
      );

    if (!matchesSearch) return false;
    if (filterType === 'low_stock') return STOCKED_ITEM_TYPES.includes(item.type) && item.onHand <= item.reorderPoint;
    if (filterType !== 'all') return item.type === filterType;
    return true;
  });

  // Only raw_material and stationery hold physical stock valuation
  const totalValuation = inventoryItems
    .filter(i => STOCKED_ITEM_TYPES.includes(i.type))
    .reduce((sum, i) => {
      if (i.type === 'stationery' && i.variants && i.variants.length > 0) {
        return sum + i.variants.reduce((vs, v) => vs + v.onHand * v.cost, 0);
      }
      return sum + i.onHand * i.cost;
    }, 0);

  const lowStockItems = inventoryItems.filter(
    i => STOCKED_ITEM_TYPES.includes(i.type) && i.onHand <= i.reorderPoint
  );

  const printedProductCount = inventoryItems.filter(i => i.type === 'printed_product').length;
  const invoiceableCount = inventoryItems.filter(i => INVOICEABLE_ITEM_TYPES.includes(i.type)).length;

  const handleApplyAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemToAdjust || adjustmentQty === 0) return;
    if (!canWriteInventory) {
      setAdjustError('Your role cannot post inventory adjustments (inventory:write).');
      return;
    }

    setAdjusting(true);
    setAdjustError(null);
    try {
      const backendId = Number(itemToAdjust.id);
      if (!Number.isInteger(backendId) || backendId <= 0) {
        throw new Error(
          'This item is not linked to a server record yet. Create it in the catalog so the adjustment can be posted.'
        );
      }
      const result = await commercialApi.adjustInventoryStock(backendId, {
        adjustmentQty,
        reason: adjustmentReason,
      });
      if (result.approvalRequired) {
        const requestId = result.approvalRequest?.id;
        triggerShortcutNotice(
          result.message ||
            `This write-off requires approval${
              requestId ? ` (request #${requestId})` : ''
            }. It will post once an approver signs off.`,
          'error'
        );
        setItemToAdjust(null);
        return;
      }
      const adjustment = result.adjustment;
      triggerShortcutNotice(
        `Adjusted ${adjustment.sku} by ${
          Number(adjustment.quantityDelta) > 0 ? '+' : ''
        }${adjustment.quantityDelta} · posted ${adjustment.entryNumber} (new on hand ${adjustment.onHandAfter})`
      );
      setItemToAdjust(null);
    } catch (err: any) {
      const message = err?.message || 'Failed to post the stock adjustment';
      setAdjustError(message);
      triggerShortcutNotice(message, 'error');
    } finally {
      setAdjusting(false);
    }
  };

  /**
   * Deactivate an item. The server refuses when stock remains or the item is
   * referenced by bills, invoices or job material requirements, so a bad
   * deactivation surfaces as a message rather than silently orphaning history.
   */
  const handleDeactivate = async (item: InventoryItem) => {
    if (!canDeactivateItem) {
      triggerShortcutNotice('Your role cannot deactivate inventory items (inventory:deactivate).', 'error');
      return;
    }
    const backendId = Number(item.id);
    if (!Number.isInteger(backendId) || backendId <= 0) {
      triggerShortcutNotice('This item is not linked to a server record yet.', 'error');
      return;
    }
    const confirmed = window.confirm(
      `Deactivate ${item.sku} — ${item.name}?\n\nThe item will no longer appear in the active catalog. This cannot be undone from the UI.`
    );
    if (!confirmed) return;
    try {
      const result = await commercialApi.deactivateInventoryItem(backendId);
      triggerShortcutNotice(`Deactivated ${result.sku} — ${result.name}`);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to deactivate the item.', 'error');
    }
  };

  const openBomEditor = (item: InventoryItem) => {
    setBomEditItem(item);
    setDraftBomLines(item.bomLines ? [...item.bomLines] : []);
    setDraftSalesPrice(item.salesPrice);
  };

  const handleSaveBom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bomEditItem) return;
    if (!canWriteInventory) {
      triggerShortcutNotice('Your role cannot edit inventory (inventory:write).', 'error');
      return;
    }
    setSavingItem(true);
    try {
      const backendId = Number(bomEditItem.id);
      if (!Number.isInteger(backendId) || backendId <= 0) {
        throw new Error('This item is not linked to a server record yet.');
      }
      await commercialApi.updateInventoryItem(backendId, {
        salesPrice: draftSalesPrice,
      });
      triggerShortcutNotice(`Updated selling price for ${bomEditItem.sku} on the server`);
      setBomEditItem(null);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to update the item', 'error');
    } finally {
      setSavingItem(false);
    }
  };

  const openRawEditor = (item: InventoryItem) => {
    setRawEditItem(item);
    setDraftRawCost(item.cost);
    setDraftPurchaseUnit(item.purchaseUnit || 'Ream');
    setDraftUsageUnit(item.usageUnit || 'Sheet');
    setDraftConversionFactor(item.conversionFactor || 1);
  };

  const handleSaveRawEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rawEditItem) return;
    if (!canWriteInventory) {
      triggerShortcutNotice('Your role cannot edit inventory (inventory:write).', 'error');
      return;
    }
    setSavingItem(true);
    try {
      const backendId = Number(rawEditItem.id);
      if (!Number.isInteger(backendId) || backendId <= 0) {
        throw new Error('This item is not linked to a server record yet.');
      }
      await commercialApi.updateInventoryItem(backendId, {
        unitCost: draftRawCost,
        purchaseUnit: draftPurchaseUnit,
        usageUnit: draftUsageUnit,
        conversionFactor: Math.max(1, draftConversionFactor),
      });
      triggerShortcutNotice(`Updated ${rawEditItem.sku} cost & units on the server`);
      setRawEditItem(null);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to update the item', 'error');
    } finally {
      setSavingItem(false);
    }
  };

  const openVariantsEditor = (item: InventoryItem) => {
    setVariantEditItem(item);
    setDraftVariants(item.variants ? item.variants.map(v => ({ ...v })) : []);
  };

  const handleSaveVariants = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!variantEditItem) return;
    if (!canWriteInventory) {
      triggerShortcutNotice('Your role cannot edit inventory (inventory:write).', 'error');
      return;
    }
    setSavingItem(true);
    try {
      const backendId = Number(variantEditItem.id);
      if (!Number.isInteger(backendId) || backendId <= 0) {
        throw new Error('This item is not linked to a server record yet.');
      }
      await commercialApi.updateInventoryItem(backendId, {
        description: `${variantEditItem.description || ''}\n\nVariants: ${draftVariants
          .map(v => `${v.name} (${v.sku}) @ ${v.cost}`)
          .join(', ')}`.trim(),
      });
      triggerShortcutNotice(`Saved ${draftVariants.length} variant(s) note for ${variantEditItem.sku}`);
      setVariantEditItem(null);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to save the variants', 'error');
    } finally {
      setSavingItem(false);
    }
  };

  const buildInventoryActionContext = (item: InventoryItem, pendingId?: string | null): ActionEligibilityContext<InventoryItem> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'inventory',
    entityType: 'inventory_item',
    record: item,
    recordStatus: item.type,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const buildInventoryActionDefinitions = (item: InventoryItem): AdvancedActionDefinition<InventoryItem>[] => {
    const defs: AdvancedActionDefinition<InventoryItem>[] = [];
    const isStocked = STOCKED_ITEM_TYPES.includes(item.type);
    const isInvoiceable = INVOICEABLE_ITEM_TYPES.includes(item.type);
    defs.push({
      id: 'inv.view-item',
      label: 'View Item & Stock Detail',
      icon: <Package className="w-3.5 h-3.5 text-blue-600" />,
      group: 'view',
      groupLabel: 'Item',
      requiredPermission: 'inventory:read',
      execute: async () => openDetail(item.id, item.sku, item.name, 'overview', setDetailItemId, setDetailItemLabel, setDetailTab),
    });
    if (isStocked && canAdjustStock) {
      defs.push({ id: 'inv.adjust-stock', label: 'Adjust Stock Qty', icon: <SlidersHorizontal className="w-3.5 h-3.5 text-blue-600" />, group: 'process', groupLabel: 'Stock', requiredPermission: 'inventory:adjust', execute: async () => { setItemToAdjust(item); setAdjustmentQty(0); } });
    }
    if (isStocked && canTransferStock) {
      defs.push({ id: 'inv.transfer-stock', label: 'Transfer Stock', icon: <Truck className="w-3.5 h-3.5 text-violet-600" />, group: 'process', groupLabel: 'Stock', requiredPermission: 'inventory:transfer', execute: async () => { setTransferItemId(item.id); setTransferOpen(true); } });
    }
    if (isStocked && canRunStockCount) {
      defs.push({ id: 'inv.stock-count', label: 'Count Stock', icon: <ClipboardList className="w-3.5 h-3.5 text-amber-600" />, group: 'process', groupLabel: 'Stock', requiredPermission: 'inventory:count', execute: async () => { setCountItemId(item.id); setCountOpen(true); } });
    }
    if (isStocked && canRecordDamage) {
      defs.push({ id: 'inv.record-damage', label: 'Record Damage / Write-Off', icon: <PackageMinus className="w-3.5 h-3.5 text-rose-600" />, group: 'process', groupLabel: 'Stock', requiredPermission: 'inventory:damage', execute: async () => setDamageItem(item) });
      defs.push({
        id: 'inv.scrap-writeoff',
        label: 'Scrap Write-Off (Job/Reason)',
        icon: <PackageMinus className="w-3.5 h-3.5 text-orange-600" />,
        group: 'process',
        groupLabel: 'Stock',
        requiredPermission: 'inventory:damage',
        execute: async () => {
          const qty = window.prompt(`Scrap quantity for ${item.sku} (${item.name})`, '1');
          if (qty === null) return;
          const reason = window.prompt('Scrap reason / job reference (required)', 'Production spoilage');
          if (reason === null) return;
          if (!reason.trim()) throw new Error('Reason is required');
          await commercialApi.recordScrapWriteOff(Number(item.id), { quantity: Number(qty), reason: reason.trim(), reasonCode: 'scrap', jobReference: reason.trim() });
          triggerShortcutNotice(`Scrap write-off recorded for ${item.sku}`);
        },
      });
    }
    defs.push({ id: 'inv.view-ledger', label: 'View Stock Ledger', icon: <History className="w-3.5 h-3.5 text-slate-500" />, group: 'view', groupLabel: 'Detail', requiredPermission: 'inventory:read', execute: async () => openDetail(item.id, item.sku, item.name, 'ledger', setDetailItemId, setDetailItemLabel, setDetailTab) });
    defs.push({ id: 'inv.view-movements', label: 'View Movements', icon: <Boxes className="w-3.5 h-3.5 text-slate-500" />, group: 'view', groupLabel: 'Detail', requiredPermission: 'inventory:read', execute: async () => openDetail(item.id, item.sku, item.name, 'movements', setDetailItemId, setDetailItemLabel, setDetailTab) });
    defs.push({ id: 'inv.view-consumption', label: 'Material Consumption', icon: <BarChart3 className="w-3.5 h-3.5 text-slate-500" />, group: 'view', groupLabel: 'Detail', requiredPermission: 'inventory:read', execute: async () => openDetail(item.id, item.sku, item.name, 'consumption', setDetailItemId, setDetailItemLabel, setDetailTab) });
    defs.push({ id: 'inv.view-suppliers', label: 'Supplier History', icon: <ShoppingCart className="w-3.5 h-3.5 text-slate-500" />, group: 'view', groupLabel: 'Detail', requiredPermission: 'inventory:read', execute: async () => openDetail(item.id, item.sku, item.name, 'suppliers', setDetailItemId, setDetailItemLabel, setDetailTab) });
    defs.push({ id: 'inv.view-transactions', label: 'Journal Transactions', icon: <FileText className="w-3.5 h-3.5 text-slate-500" />, group: 'view', groupLabel: 'Detail', requiredPermission: 'inventory:read', execute: async () => openDetail(item.id, item.sku, item.name, 'transactions', setDetailItemId, setDetailItemLabel, setDetailTab) });
    if (canWriteInventory) {
      defs.push({ id: 'inv.edit-item', label: 'Edit Item Details / Rename', icon: <Pencil className="w-3.5 h-3.5 text-blue-600" />, group: 'admin', groupLabel: 'Master data', requiredPermission: 'inventory:write', execute: async () => setEditItem(item) });
    }
    if (item.type === 'raw_material') {
      defs.push({ id: 'inv.edit-raw-conversion', label: 'Edit Cost & Unit Conversion', icon: <Calculator className="w-3.5 h-3.5 text-indigo-600" />, group: 'admin', groupLabel: 'Master data', requiredPermission: 'inventory:write', execute: async () => openRawEditor(item) });
    }
    if (item.type === 'printed_product' || item.type === 'printing_service') {
      defs.push({ id: 'inv.edit-bom', label: 'Edit BOM & Selling Price', icon: <Layers className="w-3.5 h-3.5 text-indigo-600" />, group: 'admin', groupLabel: 'Master data', requiredPermission: 'inventory:write', execute: async () => openBomEditor(item) });
    }
    if (item.type === 'stationery' || item.type === 'printed_product') {
      defs.push({ id: 'inv.manage-variants', label: `Manage Variants (${item.variants?.length || 0})`, icon: <Tags className="w-3.5 h-3.5 text-purple-600" />, group: 'admin', groupLabel: 'Master data', requiredPermission: 'inventory:write', execute: async () => openVariantsEditor(item) });
    }
    if (isInvoiceable) {
      defs.push({ id: 'inv.create-invoice', label: 'Create Invoice', icon: <FileText className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Actions', requiredPermission: 'invoices:write', execute: async () => setIsNewInvoiceOpen(true) });
    }
    if (canDeactivateItem) {
      defs.push({ id: 'inv.deactivate-item', label: 'Deactivate Item', icon: <Trash2 className="w-3.5 h-3.5 text-rose-500" />, group: 'danger', groupLabel: 'Sensitive operations', destructive: true, risk: 'destructive', requiredPermission: 'inventory:deactivate', confirmation: { title: `Deactivate ${item.sku}`, message: 'Deactivate this item?', confirmLabel: 'Deactivate', destructive: true }, execute: async () => handleDeactivate(item) });
    }
    defs.push({ id: 'inv.copy-sku', label: 'Copy SKU', icon: <Copy className="w-3.5 h-3.5" />, group: 'admin', groupLabel: 'Other', requiredPermission: 'inventory:read', execute: async () => { await navigator.clipboard?.writeText(item.sku); triggerShortcutNotice(`Copied SKU ${item.sku}`); } });
    return defs;
  };

  const renderInventoryActions = (item: InventoryItem) => {
    const defs = buildInventoryActionDefinitions(item);
    const ctx = buildInventoryActionContext(item, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <TransactionActionMenu<InventoryItem>
        label={`Actions for ${item.sku}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={item.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => {
          const def = action.definition;
          if (typeof def.execute === 'function') {
            await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) });
          }
        }}
      />
    );
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            Printing Inventory, BOMs, Unit Conversions & Variants
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Raw Materials convert purchase units to usage units and drive costs for Printed Products & Printing Services; selling prices are entered manually to track real profit.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {canTransferStock && (
            <button
              onClick={() => setReceiveTransferOpen(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold text-xs transition-all"
            >
              <Truck className="w-4 h-4" />
              <span>Receive Transfers</span>
            </button>
          )}
          <button
            onClick={() => setIsNewItemOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-xs transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" />
            <span>New Catalog Item</span>
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Stock Asset Valuation
            </div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {formatCurrency(totalValuation, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-medium">
              Raw Materials & Stationary on hand
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <Package className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Printed Products (BOM)
            </div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {printedProductCount}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-medium">
              Zero shelf stock · Raw-cost driven
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <Layers className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Invoiceable Items
            </div>
            <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1 tabular-nums">
              {invoiceableCount} / {inventoryItems.length}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-medium">
              Printed, Stationery & Print Services
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-5 h-5" />
          </div>
        </div>

        <div
          onClick={() => setFilterType(prev => prev === 'low_stock' ? 'all' : 'low_stock')}
          className={`p-4 rounded-xl bg-white dark:bg-slate-900 border transition-all cursor-pointer flex items-center justify-between ${
            filterType === 'low_stock' ? 'border-rose-500 ring-2 ring-rose-500/20 shadow-md' : 'border-slate-200 dark:border-slate-800 hover:border-rose-400'
          }`}
        >
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Low Stock Warnings
            </div>
            <div className="text-xl font-bold font-mono text-rose-600 dark:text-rose-400 mt-1 tabular-nums">
              {lowStockItems.length} SKUs
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-medium">
              Below reorder threshold · Click to filter
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Filter Tabs and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-medium">
          {[
            { id: 'all', label: `All (${inventoryItems.length})` },
            { id: 'low_stock', label: `⚠️ Low Stock (${lowStockItems.length})` },
            { id: 'raw_material', label: `Raw Materials (${inventoryItems.filter(i => i.type === 'raw_material').length})` },
            { id: 'printed_product', label: `Printed Products (${inventoryItems.filter(i => i.type === 'printed_product').length})` },
            { id: 'stationery', label: `Stationary Items (${inventoryItems.filter(i => i.type === 'stationery').length})` },
            { id: 'printing_service', label: `Printing Services (${inventoryItems.filter(i => i.type === 'printing_service').length})` },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setFilterType(tab.id)}
              className={`px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                filterType === tab.id
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-bold shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search SKU, variant, item, or BOM..."
            className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-850 text-xs text-slate-900 dark:text-slate-100 outline-none"
          />
        </div>
      </div>

      {/* Items Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <InventoryTable<InventoryItem>
          rows={filteredItems}
          colSpan={9}
          emptyMessage="No inventory items match the current filter."
          selectedId={selectedItemId}
          notify={(m, t) => triggerShortcutNotice(m, t)}
          exportName="inventory-selection.csv"
          exportHeader={['SKU', 'Item', 'Category', 'Selling', 'On Hand', 'Reorder']}
          exportRows={(rows) =>
            rows.map((i) => [i.sku, i.name, ITEM_TYPE_LABELS[i.type], i.salesPrice, i.onHand, i.reorderPoint])
          }
          onRowClick={(item) => {
            setSelectedItemId(Number(item.id));
            setDetailItemId(Number(item.id));
          }}
          onRowContextMenu={(item, pt) => {
            setSelectedItemId(Number(item.id));
            setContextMenu({ x: pt.x, y: pt.y, item });
          }}
          renderHeader={() => (
            <>
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">ITEM / CONVERSION / VARIANTS</th>
              <th className="px-4 py-3">CATEGORY</th>
              <th className="px-4 py-3 text-right">COST PRICE</th>
              <th className="px-4 py-3 text-right">SELLING PRICE</th>
              <th className="px-4 py-3 text-right">UNIT PROFIT</th>
              <th className="px-4 py-3 text-right">ON HAND</th>
              <th className="px-4 py-3 text-center">STOCK / BILLING</th>
              <th className="px-4 py-3 text-right">ACTIONS</th>
            </>
          )}
          renderCells={(item) => {
            const isStocked = STOCKED_ITEM_TYPES.includes(item.type);
            const isInvoiceable = INVOICEABLE_ITEM_TYPES.includes(item.type);
            const isLow = isStocked && item.onHand <= item.reorderPoint;
            const liveUnitCost = getItemUnitCost(item);
            const unitProfit = isInvoiceable ? item.salesPrice - liveUnitCost : 0;
            const unitMarginPct = isInvoiceable && item.salesPrice > 0 ? (unitProfit / item.salesPrice) * 100 : 0;
            const conv = item.conversionFactor || 1;
            const usageCost = item.type === 'raw_material' ? getRawUsageUnitCost(item.id) : 0;
            return (
              <>
                <td className="px-4 py-3 font-bold text-slate-900 dark:text-white whitespace-nowrap">{item.sku}</td>
                <td className="px-4 py-3 font-sans">
                  <div className="font-semibold text-slate-900 dark:text-white">{item.name}</div>
                  <div className="text-[11px] text-slate-500">{item.description}</div>
                  {item.type === 'raw_material' && (
                    <div className="mt-1 text-[11px] font-mono text-blue-700 dark:text-blue-400 font-semibold">
                      1 {item.purchaseUnit || 'Unit'} = {conv.toLocaleString()} {item.usageUnit || 'Unit'}s ({currencySymbol}{usageCost.toFixed(4)}/{item.usageUnit || 'Unit'})
                    </div>
                  )}
                  {(item.type === 'printed_product' || item.type === 'printing_service') && item.bomLines && item.bomLines.length > 0 && (
                    <div className="mt-1 text-[11px] text-indigo-600 dark:text-indigo-400 font-medium">
                      BOM:{' '}
                      {item.bomLines.map(b => { const rm = inventoryItems.find(r => r.id === b.rawMaterialId); return `${b.quantityPerUnit} ${rm?.usageUnit || 'Unit'} ${rm?.sku || b.rawMaterialId}`; }).join(' + ')}
                    </div>
                  )}
                  {item.variants && item.variants.length > 0 && (
                    <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">
                      <span className="font-semibold">{item.variants.length} Variants:</span>{' '}
                      {item.variants.map(v => item.type === 'stationery' ? `${v.name} (${v.onHand} @ ${formatCurrency(v.salesPrice, currency)})` : `${v.name} (${formatCurrency(v.salesPrice, currency)})`).join(' · ')}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 font-sans text-slate-700 dark:text-slate-300 text-[11px] font-medium whitespace-nowrap">{ITEM_TYPE_LABELS[item.type]}</td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-600 dark:text-slate-400">
                  <div>{formatCurrency(liveUnitCost, currency)}</div>
                  {item.type === 'raw_material' && <div className="text-[10px] text-slate-400">per {item.purchaseUnit || 'Unit'}</div>}
                </td>
                <td className="px-4 py-3 text-right font-bold tabular-nums text-slate-900 dark:text-white">{isInvoiceable ? formatCurrency(item.salesPrice, currency) : '—'}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {isInvoiceable ? (
                    <div>
                      <div className={`font-bold ${unitProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{formatCurrency(unitProfit, currency)}</div>
                      <div className="text-[10px] text-slate-500">{unitMarginPct.toFixed(1)}%</div>
                    </div>
                  ) : (<span className="text-slate-400">—</span>)}
                </td>
                <td className="px-4 py-3 text-right font-bold text-slate-900 dark:text-white tabular-nums">
                  {item.type === 'raw_material' ? (
                    <div>
                      <div>{item.onHand} {item.purchaseUnit || 'Units'}</div>
                      <div className="text-[10px] font-normal text-slate-500">{Math.round(item.onHand * conv).toLocaleString()} {item.usageUnit || 'Units'}</div>
                    </div>
                  ) : item.type === 'stationery' ? item.onHand : 'No Stock'}
                </td>
                <td className="px-4 py-3 text-center font-sans text-[11px]">
                  {item.type === 'raw_material' ? (
                    <div className="space-y-0.5">
                      <div className={isLow ? 'font-bold text-rose-600 dark:text-rose-400' : 'font-semibold text-emerald-700 dark:text-emerald-400'}>{isLow ? `Reorder (${item.reorderPoint} min)` : 'Stock OK'}</div>
                      <div className="text-[10px] text-slate-400">Internal Only</div>
                    </div>
                  ) : item.type === 'stationery' ? (
                    <div className="space-y-0.5">
                      <div className={isLow ? 'font-bold text-rose-600 dark:text-rose-400' : 'font-semibold text-emerald-700 dark:text-emerald-400'}>{isLow ? `Reorder (${item.reorderPoint} min)` : 'In Stock'}</div>
                      <div className="text-[10px] text-slate-400">{item.variants?.length ? `${item.variants.length} variants` : 'Invoiceable'}</div>
                    </div>
                  ) : item.type === 'printed_product' ? (
                    <div className="space-y-0.5">
                      <div className="font-semibold text-indigo-600 dark:text-indigo-400">BOM ({item.bomLines?.length || 0} inputs)</div>
                      <div className="text-[10px] text-slate-400">{item.variants?.length ? `${item.variants.length} variants` : 'Invoiceable'}</div>
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      <div className="font-medium text-blue-700 dark:text-blue-400">{item.bomLines?.length ? `BOM (${item.bomLines.length} raw)` : 'Service'}</div>
                      <div className="text-[10px] text-slate-400">Invoiceable</div>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-sans">{renderInventoryActions(item)}</td>
              </>
            );
          }}
        />
      </div>

      {/* Adjust Inventory Stock Modal (Raw Materials & Stationary Items only) */}
      {itemToAdjust && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col">
            <div className="px-5 py-3 bg-slate-900 text-white flex items-center justify-between">
              <span className="font-bold text-sm">Adjust Stock Quantity</span>
              <button
                onClick={() => setItemToAdjust(null)}
                className="p-1 text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleApplyAdjustment} className="p-5 space-y-4 text-xs">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-1">
                <div className="font-bold text-sm text-slate-900 dark:text-white">
                  {itemToAdjust.name}
                </div>
                <div className="font-mono text-xs text-slate-500">
                  SKU: {itemToAdjust.sku} · {ITEM_TYPE_LABELS[itemToAdjust.type]}
                </div>
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 pt-1">
                  Current On Hand:{' '}
                  <span className="font-mono font-bold">
                    {itemToAdjust.onHand} {itemToAdjust.purchaseUnit || 'units'}
                  </span>
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">
                  Adjustment Quantity (+ to add, - to subtract)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={adjustmentQty}
                  onChange={e => setAdjustmentQty(parseFloat(e.target.value) || 0)}
                  placeholder="e.g. +10 or -3"
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm font-mono font-bold text-slate-900 dark:text-slate-100 outline-none"
                  required
                />
                <div className="text-[11px] text-slate-500 font-mono">
                  New Quantity: {Math.max(0, Math.round((itemToAdjust.onHand + adjustmentQty) * 100) / 100)}{' '}
                  {itemToAdjust.purchaseUnit || 'units'}
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">
                  Adjustment Reason
                </label>
                <select
                  value={adjustmentReason}
                  onChange={e => setAdjustmentReason(e.target.value)}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                >
                  <option value="Physical count audit adjustment">Physical count audit adjustment</option>
                  <option value="Supplier purchase delivery">Supplier purchase delivery</option>
                  <option value="Damaged / spoiled paper or toner write-off">Damaged / spoiled paper or toner write-off</option>
                  <option value="Press room internal production usage">Press room internal production usage</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                {adjustError && (
                  <div
                    role="alert"
                    className="mr-auto p-2.5 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 flex items-start gap-2"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{adjustError}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setItemToAdjust(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={adjusting || !canWriteInventory}
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-md transition-all active:scale-95 disabled:opacity-60 inline-flex items-center gap-1.5"
                  title={
                    canWriteInventory
                      ? 'Post the adjustment to the server stock ledger and general ledger'
                      : 'Requires inventory:write permission'
                  }
                >
                  {adjusting ? (
                    <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  ) : null}
                  Apply Stock Adjustment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Raw Material Cost & Unit Conversion Editor Modal */}
      {rawEditItem && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Calculator className="w-4 h-4 text-amber-400" />
                <span className="font-bold text-sm">Raw Material Conversion — {rawEditItem.sku}</span>
              </div>
              <button
                onClick={() => setRawEditItem(null)}
                className="p-1 text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveRawEdit} className="p-5 space-y-4 text-xs">
              <div className="font-bold text-sm text-slate-900 dark:text-white">
                {rawEditItem.name}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Purchase Unit</label>
                  <input
                    type="text"
                    value={draftPurchaseUnit}
                    onChange={e => setDraftPurchaseUnit(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 outline-none"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Usage Unit</label>
                  <input
                    type="text"
                    value={draftUsageUnit}
                    onChange={e => setDraftUsageUnit(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 outline-none"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">
                    Purchase Cost ({currencySymbol} / {draftPurchaseUnit})
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={draftRawCost}
                    onChange={e => setDraftRawCost(parseFloat(e.target.value) || 0)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 font-mono font-bold text-right outline-none"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">
                    {draftUsageUnit}s per {draftPurchaseUnit}
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={draftConversionFactor}
                    onChange={e => setDraftConversionFactor(parseInt(e.target.value) || 1)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 font-mono font-bold text-right outline-none"
                    required
                  />
                </div>
              </div>

              <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 text-xs font-mono text-blue-800 dark:text-blue-300">
                <div>
                  1 {draftPurchaseUnit} = {draftConversionFactor.toLocaleString()} {draftUsageUnit}s
                </div>
                <div className="font-bold mt-1">
                  Usage Cost: {currencySymbol}
                  {(draftRawCost / Math.max(1, draftConversionFactor)).toFixed(4)} per {draftUsageUnit}
                </div>
                <div className="font-sans text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                  Saving automatically recalculates all Printed Products & Printing Services using this raw material.
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setRawEditItem(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold"
                >
                  <Save className="w-4 h-4" />
                  <span>Save & Sync Costs</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bill of Materials & Selling Price Editor Modal (Printed Products & Printing Services) */}
      {bomEditItem && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-amber-400" />
                <span className="font-bold text-sm">BOM & Pricing — {bomEditItem.sku}</span>
              </div>
              <button
                onClick={() => setBomEditItem(null)}
                className="p-1 text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveBom} className="p-5 space-y-4 text-xs overflow-y-auto">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800">
                <div className="font-bold text-sm text-slate-900 dark:text-white">
                  {bomEditItem.name}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  Cost price is calculated automatically from raw material usage units. Enter your manual selling price below.
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-700 dark:text-slate-300">
                    Raw Material Inputs (in Usage Units)
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      rawMaterials[0] &&
                      setDraftBomLines(prev => [
                        ...prev,
                        { rawMaterialId: rawMaterials[0].id, quantityPerUnit: 1 },
                      ])
                    }
                    className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Material</span>
                  </button>
                </div>

                {draftBomLines.map((row, idx) => {
                  const rm = rawMaterials.find(r => r.id === row.rawMaterialId);
                  const usageCost = rm ? getRawUsageUnitCost(rm.id) : 0;
                  return (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-6">
                        <select
                          value={row.rawMaterialId}
                          onChange={e =>
                            setDraftBomLines(prev =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, rawMaterialId: e.target.value } : r
                              )
                            )
                          }
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-slate-900 dark:text-slate-100 outline-none"
                        >
                          {rawMaterials.map(mat => (
                            <option key={mat.id} value={mat.id}>
                              {mat.sku} · {mat.name} ({currencySymbol}{getRawUsageUnitCost(mat.id).toFixed(4)}/{mat.usageUnit || 'Unit'})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="col-span-3 flex items-center gap-1">
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={row.quantityPerUnit}
                          onChange={e =>
                            setDraftBomLines(prev =>
                              prev.map((r, i) =>
                                i === idx
                                  ? { ...r, quantityPerUnit: parseFloat(e.target.value) || 0 }
                                  : r
                              )
                            )
                          }
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-right font-mono text-slate-900 dark:text-slate-100 outline-none"
                        />
                        <span className="text-[10px] text-slate-500">{rm?.usageUnit || 'Unit'}s</span>
                      </div>
                      <div className="col-span-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {formatCurrency(usageCost * row.quantityPerUnit, currency)}
                      </div>
                      <div className="col-span-1 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            setDraftBomLines(prev => prev.filter((_, i) => i !== idx))
                          }
                          className="p-1 text-slate-400 hover:text-rose-500"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800">
                <div>
                  <div className="text-[10px] font-bold uppercase text-slate-500">Driven BOM Cost</div>
                  <div className="text-base font-mono font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                    {formatCurrency(computeBomUnitCost(draftBomLines), currency)}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase text-slate-500 block">
                    Manual Selling Price ({currencySymbol})
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={draftSalesPrice}
                    onChange={e => setDraftSalesPrice(parseFloat(e.target.value) || 0)}
                    className="w-full mt-0.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-sm font-mono font-bold text-right outline-none"
                  />
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-bold uppercase text-slate-500">Real Unit Profit</div>
                  <div
                    className={`text-base font-mono font-bold mt-0.5 tabular-nums ${
                      draftSalesPrice - computeBomUnitCost(draftBomLines) >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {formatCurrency(draftSalesPrice - computeBomUnitCost(draftBomLines), currency)}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setBomEditItem(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={bomEditItem.type === 'printed_product' && draftBomLines.length === 0}
                  className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold"
                >
                  <Save className="w-4 h-4" />
                  <span>Save BOM & Price</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manage Variants Modal (for Stationery & Printed Products) */}
      {variantEditItem && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Tags className="w-4 h-4 text-amber-400" />
                <span className="font-bold text-sm">
                  Variants Manager — {variantEditItem.name} ({variantEditItem.sku})
                </span>
              </div>
              <button
                onClick={() => setVariantEditItem(null)}
                className="p-1 text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveVariants} className="p-5 space-y-4 text-xs overflow-y-auto">
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-slate-500">
                  {variantEditItem.type === 'stationery'
                    ? 'Stationery variants track separate SKUs, purchase costs, manual selling prices, and shelf stock.'
                    : 'Printed Product variants carry zero stock and derive cost from BOM raw materials while selling prices are manually entered.'}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setDraftVariants(prev => [
                      ...prev,
                      {
                        id: `var-${Date.now()}-${prev.length + 1}`,
                        name: `New Variant ${prev.length + 1}`,
                        sku: `${variantEditItem.sku}-V${prev.length + 1}`,
                        cost: variantEditItem.cost,
                        salesPrice: variantEditItem.salesPrice,
                        onHand: variantEditItem.type === 'stationery' ? 10 : 0,
                        reorderPoint: variantEditItem.type === 'stationery' ? 5 : 0,
                        bomLines:
                          variantEditItem.type === 'printed_product'
                            ? variantEditItem.bomLines
                              ? [...variantEditItem.bomLines]
                              : []
                            : undefined,
                      },
                    ])
                  }
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-semibold whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Variant</span>
                </button>
              </div>

              <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase text-[10px] font-bold border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-3 py-2">VARIANT NAME</th>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2 text-right">UNIT COST</th>
                      <th className="px-3 py-2 text-right">SELLING PRICE</th>
                      <th className="px-3 py-2 text-right">PROFIT</th>
                      <th className="px-3 py-2 text-right">ON HAND</th>
                      <th className="px-3 py-2 text-right">ACTION</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {draftVariants.map((v, idx) => {
                      const vCost =
                        variantEditItem.type === 'printed_product' && v.bomLines?.length
                          ? computeBomUnitCost(v.bomLines)
                          : v.cost;
                      const vProfit = v.salesPrice - vCost;
                      return (
                        <tr key={v.id}>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={v.name}
                              onChange={e =>
                                setDraftVariants(prev =>
                                  prev.map((row, i) =>
                                    i === idx ? { ...row, name: e.target.value } : row
                                  )
                                )
                              }
                              className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs outline-none"
                              required
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={v.sku}
                              onChange={e =>
                                setDraftVariants(prev =>
                                  prev.map((row, i) =>
                                    i === idx ? { ...row, sku: e.target.value } : row
                                  )
                                )
                              }
                              className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs font-mono outline-none"
                              required
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={vCost}
                              readOnly={variantEditItem.type === 'printed_product'}
                              onChange={e =>
                                setDraftVariants(prev =>
                                  prev.map((row, i) =>
                                    i === idx
                                      ? { ...row, cost: parseFloat(e.target.value) || 0 }
                                      : row
                                  )
                                )
                              }
                              className="w-20 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs font-mono text-right outline-none"
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={v.salesPrice}
                              onChange={e =>
                                setDraftVariants(prev =>
                                  prev.map((row, i) =>
                                    i === idx
                                      ? { ...row, salesPrice: parseFloat(e.target.value) || 0 }
                                      : row
                                  )
                                )
                              }
                              className="w-20 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs font-mono font-bold text-right outline-none"
                            />
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400">
                            {formatCurrency(vProfit, currency)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {variantEditItem.type === 'stationery' ? (
                              <input
                                type="number"
                                min="0"
                                value={v.onHand}
                                onChange={e =>
                                  setDraftVariants(prev =>
                                    prev.map((row, i) =>
                                      i === idx
                                        ? { ...row, onHand: parseFloat(e.target.value) || 0 }
                                        : row
                                    )
                                  )
                                }
                                className="w-16 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs font-mono text-right outline-none"
                              />
                            ) : (
                              <span className="text-slate-400">0</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => setDraftVariants(prev => prev.filter((_, i) => i !== idx))}
                              className="p-1 text-rose-600 hover:bg-rose-50 rounded"
                              title="Remove Variant"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setVariantEditItem(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold"
                >
                  <Save className="w-4 h-4" />
                  <span>Save Variants</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Advanced inventory operations */}
      <InventoryItemDrawer
        itemId={detailItemId}
        sku={detailItemLabel.sku}
        name={detailItemLabel.name}
        initialTab={detailTab}
        onClose={() => setDetailItemId(null)}
      />

      <EditItemModal
        open={editItem != null}
        item={
          editItem
            ? {
                id: editItem.id,
                sku: editItem.sku,
                name: editItem.name,
                type: editItem.type,
                description: editItem.description,
                reorderPoint: editItem.reorderPoint,
                cost: editItem.cost,
                salesPrice: editItem.salesPrice,
                purchaseUnit: editItem.purchaseUnit,
                usageUnit: editItem.usageUnit,
                conversionFactor: editItem.conversionFactor,
              }
            : null
        }
        onClose={() => setEditItem(null)}
        onSuccess={msg => {
          triggerShortcutNotice(msg);
          setEditItem(null);
        }}
      />

      <StockDamageModal
        open={damageItem != null}
        item={
          damageItem
            ? {
                id: damageItem.id,
                sku: damageItem.sku,
                name: damageItem.name,
                onHand: damageItem.onHand,
                avgCost: damageItem.cost,
              }
            : null
        }
        onClose={() => setDamageItem(null)}
        onSuccess={msg => {
          triggerShortcutNotice(msg);
          setDamageItem(null);
        }}
      />

      <StockTransferModal
        open={transferOpen}
        items={inventoryItems
          .filter(i => STOCKED_ITEM_TYPES.includes(i.type))
          .map(i => ({
            id: i.id,
            sku: i.sku,
            name: i.name,
            onHand: i.onHand,
            usageUnit: i.usageUnit,
            avgCost: i.cost,
          }))}
        initialItemId={transferItemId}
        onClose={() => {
          setTransferOpen(false);
          setTransferItemId(null);
        }}
        onSuccess={msg => {
          triggerShortcutNotice(msg);
          setTransferOpen(false);
          setTransferItemId(null);
        }}
      />

      <StockCountModal
        open={countOpen}
        items={inventoryItems
          .filter(i => STOCKED_ITEM_TYPES.includes(i.type))
          .map(i => ({
            id: i.id,
            sku: i.sku,
            name: i.name,
            onHand: i.onHand,
            usageUnit: i.usageUnit,
            avgCost: i.cost,
          }))}
        initialItemId={countItemId}
        onClose={() => {
          setCountOpen(false);
          setCountItemId(null);
        }}
        onSuccess={msg => {
          triggerShortcutNotice(msg);
          setCountOpen(false);
          setCountItemId(null);
        }}
      />

      <TransferReceiveModal
        open={receiveTransferOpen}
        onClose={() => setReceiveTransferOpen(false)}
        onSuccess={msg => {
          triggerShortcutNotice(msg);
          setReceiveTransferOpen(false);
        }}
      />

      {contextMenu && (() => {
        const defs = buildInventoryActionDefinitions(contextMenu.item);
        const ctx = buildInventoryActionContext(contextMenu.item, null);
        const resolved = resolveActions(defs, ctx);
        return resolved.length > 0 ? (
          <TransactionContextMenu<InventoryItem>
            label={`Actions for ${contextMenu.item.sku}`}
            actions={resolved}
            executionContext={ctx}
            idempotencyRecordKey={contextMenu.item.id}
            notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
            point={{ x: contextMenu.x, y: contextMenu.y }}
            onClose={() => setContextMenu(null)}
            onExecuteAction={async (action) => {
              const def = action.definition;
              if (typeof def.execute === 'function') {
                await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) });
              }
            }}
          />
        ) : null;
      })()}
    </div>
  );
};
