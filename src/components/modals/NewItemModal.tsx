import React, { useState, useMemo } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { commercialApi } from '../../services/commercialApi';
import { BomComponent, ItemType, ItemVariant } from '../../types/accounting';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';
import { AlertTriangle, Info, Layers, Loader2, Package, Plus, Save, Tags, Trash2, X } from 'lucide-react';

export const NewItemModal: React.FC = () => {
  const {
    isNewItemOpen,
    setIsNewItemOpen,
    inventoryItems,
    accounts,
    companyProfile,
    getRawUsageUnitCost,
    computeBomUnitCost,
    triggerShortcutNotice,
  } = useAccounting();
  const { hasPermission } = useAuth();
  const canWriteInventory = hasPermission('inventory:write');
  const currency = companyProfile.currency || 'K';
  const currencySymbol = getCurrencySymbol(currency);

  const rawMaterials = useMemo(
    () => inventoryItems.filter(i => i.type === 'raw_material'),
    [inventoryItems]
  );

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [type, setType] = useState<ItemType>('printed_product');
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState<number>(45.0);
  const [salesPrice, setSalesPrice] = useState<number>(100.0);
  const [onHand, setOnHand] = useState<number>(25);
  const [reorderPoint, setReorderPoint] = useState<number>(10);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Raw material unit conversion
  const [purchaseUnit, setPurchaseUnit] = useState('Ream');
  const [usageUnit, setUsageUnit] = useState('Sheet');
  const [conversionFactor, setConversionFactor] = useState<number>(500);

  // BOM components (for printed_product AND printing_service)
  const [bomLines, setBomLines] = useState<BomComponent[]>(() =>
    rawMaterials[0] ? [{ rawMaterialId: rawMaterials[0].id, quantityPerUnit: 1 }] : []
  );

  // Variants (for stationery AND printed_product)
  const [variants, setVariants] = useState<ItemVariant[]>([]);

  const assetAccounts = accounts.filter(a => a.type === 'Inventory' || a.type === 'OtherCurrentAsset');
  const cogsAccounts = accounts.filter(a => a.type === 'CostOfGoodsSold');
  const incomeAccounts = accounts.filter(a => a.type === 'Income');

  const [assetAccountId] = useState(assetAccounts[0]?.id || 'acc-1300');
  const [cogsAccountId, setCogsAccountId] = useState(cogsAccounts[0]?.id || 'acc-5010');
  const [incomeAccountId, setIncomeAccountId] = useState(incomeAccounts[0]?.id || 'acc-4010');

  if (!isNewItemOpen) return null;

  const isStocked = type === 'raw_material' || type === 'stationery';
  const isInvoiceable = type !== 'raw_material';
  const supportsBom = type === 'printed_product' || type === 'printing_service';
  const supportsVariants = type === 'stationery' || type === 'printed_product';

  const bomUnitCost = supportsBom ? computeBomUnitCost(bomLines) : cost;
  const effectiveUnitCost = supportsBom && bomLines.length > 0 ? bomUnitCost : cost;
  const unitProfit = salesPrice - effectiveUnitCost;
  const unitMarginPct = salesPrice > 0 ? (unitProfit / salesPrice) * 100 : 0;

  const handleAddBomRow = () => {
    if (rawMaterials.length === 0) return;
    setBomLines(prev => [
      ...prev,
      { rawMaterialId: rawMaterials[0].id, quantityPerUnit: 1 },
    ]);
  };

  const handleUpdateBomRow = (index: number, field: keyof BomComponent, value: string | number) => {
    setBomLines(prev =>
      prev.map((row, idx) => (idx === index ? { ...row, [field]: value } : row))
    );
  };

  const handleRemoveBomRow = (index: number) => {
    setBomLines(prev => prev.filter((_, idx) => idx !== index));
  };

  const handleAddVariant = () => {
    const idx = variants.length + 1;
    setVariants(prev => [
      ...prev,
      {
        id: `var-${Date.now()}-${idx}`,
        name: `Variant ${idx}`,
        sku: `${sku || 'SKU'}-V${idx}`,
        cost: type === 'printed_product' ? bomUnitCost : cost,
        salesPrice,
        onHand: type === 'stationery' ? 20 : 0,
        reorderPoint: type === 'stationery' ? 5 : 0,
        bomLines: type === 'printed_product' ? [...bomLines] : undefined,
      },
    ]);
  };

  const handleUpdateVariant = (index: number, updates: Partial<ItemVariant>) => {
    setVariants(prev =>
      prev.map((v, i) => (i === index ? { ...v, ...updates } : v))
    );
  };

  const handleRemoveVariant = (index: number) => {
    setVariants(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !sku) return;
    if (type === 'printed_product' && bomLines.length === 0 && variants.length === 0) return;
    if (!canWriteInventory) {
      setErrorMsg('Your role cannot create catalog items (inventory:write).');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const assetId = assetAccountId ? Number(assetAccountId) : null;
      const cogsId = cogsAccountId ? Number(cogsAccountId) : null;
      const incomeId = incomeAccountId ? Number(incomeAccountId) : null;

      const created = await commercialApi.createInventoryItem({
        name: name.trim(),
        sku: sku.trim(),
        itemType: type,
        description,
        unitCost: effectiveUnitCost,
        salesPrice: isInvoiceable ? salesPrice : 0,
        onHand: isStocked ? onHand : 0,
        reorderPoint: isStocked ? reorderPoint : 0,
        purchaseUnit: type === 'raw_material' ? purchaseUnit : 'Unit',
        usageUnit: type === 'raw_material' ? usageUnit : 'Unit',
        conversionFactor: type === 'raw_material' ? Math.max(1, conversionFactor) : 1,
        assetAccountId: assetId && assetId > 0 ? assetId : undefined,
        cogsAccountId: cogsId && cogsId > 0 ? cogsId : undefined,
        incomeAccountId: incomeId && incomeId > 0 ? incomeId : undefined,
      });

      triggerShortcutNotice(`Created catalog item ${created.sku} (${created.name})`);
      setName('');
      setSku('');
      setDescription('');
      setVariants([]);
      setIsNewItemOpen(false);
    } catch (err: any) {
      const message = err?.message || 'Failed to create the catalog item';
      setErrorMsg(message);
      triggerShortcutNotice(message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-3xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]">
        <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-amber-400" />
            <h2 className="font-bold text-base tracking-tight">New Catalog Item</h2>
          </div>
          <button
            onClick={() => setIsNewItemOpen(false)}
            className="p-1 rounded hover:bg-white/10 text-white/80 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Item Category Type</label>
              <select
                value={type}
                onChange={e => setType(e.target.value as ItemType)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
              >
                <option value="raw_material">Raw Material (Unit Conversion · Internal Only)</option>
                <option value="printed_product">Printed Product (No Stock · BOM & Variants)</option>
                <option value="stationery">Stationary Item (Stocked · Variants Supported)</option>
                <option value="printing_service">Printing Service (BOM Costing · Manual Price)</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">SKU / Item Code</label>
              <input
                type="text"
                value={sku}
                onChange={e => setSku(e.target.value)}
                placeholder={
                  type === 'raw_material'
                    ? 'e.g. RAW-PPR-A380'
                    : type === 'printed_product'
                    ? 'e.g. PRT-EXM-BKL2'
                    : type === 'stationery'
                    ? 'e.g. STN-BK-4Q'
                    : 'e.g. SRV-QCP-PG'
                }
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100 outline-none"
                required
              />
            </div>
          </div>

          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-300">
            <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <span>
              {type === 'raw_material' &&
                'Raw Materials are bought in bulk units (e.g. Ream, Cartridge) and converted automatically into usage units (e.g. Sheets, Impressions). Internal use only.'}
              {type === 'printed_product' &&
                'Printed Products hold zero stock. Cost price is driven automatically by Raw Material BOMs while selling price is entered manually. Variants are supported.'}
              {type === 'stationery' &&
                'Stationary Items are purchased for resale, tracked on hand (with optional Variants like 1-Quire / 2-Quire), and sold directly on invoices.'}
              {type === 'printing_service' &&
                'Printing Services (e.g. Quick Photocopy, Type & Printing) derive their material cost from Raw Materials (paper & toner) while selling price is manually entered.'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Item Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Printed 24-Page Mock Booklet Pack"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Description</label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Specifications or invoice line description"
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-slate-100 outline-none"
              />
            </div>
          </div>

          {/* Raw Material Unit Conversion Builder */}
          {type === 'raw_material' && (
            <div className="p-3.5 rounded-lg bg-blue-50/50 dark:bg-slate-850 border border-blue-200 dark:border-slate-700 space-y-3">
              <div className="font-bold text-slate-900 dark:text-white">
                Unit Conversion Setup (Purchase Unit → Usage Unit)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Purchase Unit</label>
                  <input
                    type="text"
                    value={purchaseUnit}
                    onChange={e => setPurchaseUnit(e.target.value)}
                    placeholder="e.g. Ream, Cartridge"
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs outline-none"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Usage Unit</label>
                  <input
                    type="text"
                    value={usageUnit}
                    onChange={e => setUsageUnit(e.target.value)}
                    placeholder="e.g. Sheet, Impression"
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs outline-none"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">
                    {usageUnit || 'Usage Unit'}s per {purchaseUnit || 'Purchase Unit'}
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={conversionFactor}
                    onChange={e => setConversionFactor(parseInt(e.target.value) || 1)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-right outline-none"
                    required
                  />
                </div>
              </div>
              <div className="text-[11px] font-mono text-blue-700 dark:text-blue-400 font-semibold">
                Conversion Rate: 1 {purchaseUnit || 'Unit'} = {conversionFactor.toLocaleString()} {usageUnit || 'Units'} · Cost per {usageUnit || 'Unit'} = {currencySymbol}
                {(cost / Math.max(1, conversionFactor)).toFixed(4)}
              </div>
            </div>
          )}

          {/* Cost & Manual Selling Price */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">
                {supportsBom && bomLines.length > 0
                  ? `Driven BOM Cost (${currencySymbol})`
                  : type === 'raw_material'
                  ? `Cost per ${purchaseUnit || 'Unit'} (${currencySymbol})`
                  : `Unit Cost (${currencySymbol})`}
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={supportsBom && bomLines.length > 0 ? bomUnitCost : cost}
                onChange={e => setCost(parseFloat(e.target.value) || 0)}
                readOnly={supportsBom && bomLines.length > 0}
                className={`w-full border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm font-mono outline-none ${
                  supportsBom && bomLines.length > 0
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-not-allowed'
                    : 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
                }`}
                required
              />
            </div>

            {isInvoiceable ? (
              <>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">
                    Manual Selling Price ({currencySymbol})
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={salesPrice}
                    onChange={e => setSalesPrice(parseFloat(e.target.value) || 0)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm font-mono font-bold text-slate-900 dark:text-slate-100 outline-none"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">
                    Real Unit Profit & Margin
                  </label>
                  <div
                    className={`px-3 py-2 rounded-md border font-mono text-sm font-bold flex items-center justify-between ${
                      unitProfit >= 0
                        ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-400'
                        : 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-400'
                    }`}
                  >
                    <span>{formatCurrency(unitProfit, currency)}</span>
                    <span className="text-xs">{unitMarginPct.toFixed(1)}%</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="sm:col-span-2 space-y-1">
                <label className="font-semibold text-slate-500 dark:text-slate-400">
                  Customer Invoicing
                </label>
                <div className="px-3 py-2 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-850 text-xs text-slate-500 font-medium">
                  Disabled — Internal Raw Material Only (Costs drive Printed Products & Services)
                </div>
              </div>
            )}
          </div>

          {/* Stock fields ONLY for raw_material and stationery */}
          {isStocked && (
            <div className="grid grid-cols-2 gap-4 p-3 rounded-lg bg-amber-50/50 dark:bg-slate-800/40 border border-amber-200 dark:border-slate-700">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">
                  Initial On Hand ({type === 'raw_material' ? `${purchaseUnit || 'Unit'}s` : 'Units'})
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={onHand}
                  onChange={e => setOnHand(parseFloat(e.target.value) || 0)}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-1.5 text-sm font-mono text-slate-900 dark:text-slate-100 outline-none"
                />
                {type === 'raw_material' && (
                  <div className="text-[10px] font-mono text-slate-500">
                    = {(onHand * Math.max(1, conversionFactor)).toLocaleString()} {usageUnit || 'Unit'}s available
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Reorder Alert Point</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={reorderPoint}
                  onChange={e => setReorderPoint(parseInt(e.target.value) || 0)}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-1.5 text-sm font-mono text-slate-900 dark:text-slate-100 outline-none"
                />
              </div>
            </div>
          )}

          {/* BOM Builder for Printed Products & Printing Services */}
          {supportsBom && (
            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white">
                  <Layers className="w-4 h-4 text-blue-600" />
                  <span>
                    Bill of Materials (BOM) — Consumed in Raw Material Usage Units
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleAddBomRow}
                  disabled={rawMaterials.length === 0}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-semibold text-[11px]"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Material</span>
                </button>
              </div>

              {rawMaterials.length === 0 ? (
                <div className="text-xs text-rose-600 font-medium">
                  Create at least one Raw Material item first to calculate BOM material cost.
                </div>
              ) : (
                <div className="space-y-2">
                  {bomLines.map((row, idx) => {
                    const rm = rawMaterials.find(r => r.id === row.rawMaterialId);
                    const usageUnitPrice = rm ? getRawUsageUnitCost(rm.id) : 0;
                    const lineCost = usageUnitPrice * row.quantityPerUnit;
                    return (
                      <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                        <div className="col-span-6">
                          <select
                            value={row.rawMaterialId}
                            onChange={e => handleUpdateBomRow(idx, 'rawMaterialId', e.target.value)}
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
                              handleUpdateBomRow(idx, 'quantityPerUnit', parseFloat(e.target.value) || 0)
                            }
                            placeholder="Qty"
                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-right font-mono text-slate-900 dark:text-slate-100 outline-none"
                            required
                          />
                          <span className="text-[10px] text-slate-500 whitespace-nowrap">
                            {rm?.usageUnit || 'Unit'}s
                          </span>
                        </div>
                        <div className="col-span-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300 font-semibold">
                          {formatCurrency(lineCost, currency)}
                        </div>
                        <div className="col-span-1 text-right">
                          <button
                            type="button"
                            onClick={() => handleRemoveBomRow(idx)}
                            className="p-1 text-slate-400 hover:text-rose-500"
                            title="Remove component"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  <div className="pt-2 border-t border-slate-200 dark:border-slate-700 flex justify-between text-xs font-mono font-bold text-slate-900 dark:text-white">
                    <span>Raw-Material-Driven Unit Cost:</span>
                    <span className="tabular-nums text-blue-600 dark:text-blue-400">
                      {formatCurrency(bomUnitCost, currency)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Variants Builder for Stationery & Printed Products */}
          {supportsVariants && (
            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white">
                  <Tags className="w-4 h-4 text-indigo-600" />
                  <span>Item Variants (Optional — e.g. Sizes, Quires, Page Counts)</span>
                </div>
                <button
                  type="button"
                  onClick={handleAddVariant}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-[11px]"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Variant</span>
                </button>
              </div>

              {variants.length === 0 ? (
                <div className="text-[11px] text-slate-500">
                  No variants added yet. Click &ldquo;Add Variant&rdquo; if this {type === 'stationery' ? 'stationary item' : 'printed product'} comes in multiple options.
                </div>
              ) : (
                <div className="space-y-2">
                  {variants.map((v, idx) => (
                    <div key={v.id} className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-3">
                        <input
                          type="text"
                          value={v.name}
                          onChange={e => handleUpdateVariant(idx, { name: e.target.value })}
                          placeholder="Variant name"
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs outline-none"
                          required
                        />
                      </div>
                      <div className="col-span-3">
                        <input
                          type="text"
                          value={v.sku}
                          onChange={e => handleUpdateVariant(idx, { sku: e.target.value })}
                          placeholder="Variant SKU"
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs font-mono outline-none"
                          required
                        />
                      </div>
                      <div className="col-span-2">
                        <input
                          type="number"
                          step="0.01"
                          value={v.cost}
                          readOnly={type === 'printed_product'}
                          onChange={e =>
                            handleUpdateVariant(idx, { cost: parseFloat(e.target.value) || 0 })
                          }
                          title="Unit Cost"
                          placeholder="Cost"
                          className={`w-full border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-right font-mono outline-none ${
                            type === 'printed_product'
                              ? 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                              : 'bg-white dark:bg-slate-900'
                          }`}
                        />
                      </div>
                      <div className="col-span-2">
                        <input
                          type="number"
                          step="0.01"
                          value={v.salesPrice}
                          onChange={e =>
                            handleUpdateVariant(idx, {
                              salesPrice: parseFloat(e.target.value) || 0,
                            })
                          }
                          title="Manual Selling Price"
                          placeholder="Price"
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-right font-mono font-bold outline-none"
                        />
                      </div>
                      {type === 'stationery' ? (
                        <div className="col-span-1">
                          <input
                            type="number"
                            min="0"
                            value={v.onHand}
                            onChange={e =>
                              handleUpdateVariant(idx, { onHand: parseFloat(e.target.value) || 0 })
                            }
                            title="Stock on hand"
                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-xs text-right font-mono outline-none"
                          />
                        </div>
                      ) : (
                        <div className="col-span-1 text-[10px] text-center text-slate-400">0 stk</div>
                      )}
                      <div className="col-span-1 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveVariant(idx)}
                          className="p-1 text-slate-400 hover:text-rose-500"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">Income Account</label>
              <select
                value={incomeAccountId}
                onChange={e => setIncomeAccountId(e.target.value)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
              >
                {incomeAccounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.code} - {a.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-slate-700 dark:text-slate-300">COGS Account</label>
              <select
                value={cogsAccountId}
                onChange={e => setCogsAccountId(e.target.value)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
              >
                {cogsAccounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.code} - {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            {errorMsg && (
              <div
                role="alert"
                className="mr-auto p-2.5 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 flex items-start gap-2"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => setIsNewItemOpen(false)}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                submitting ||
                !canWriteInventory ||
                (type === 'printed_product' && bomLines.length === 0 && variants.length === 0)
              }
              className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold shadow-md transition-all active:scale-95"
              title={
                canWriteInventory
                  ? 'Create this item in the server catalog'
                  : 'Requires inventory:write permission'
              }
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              <span>{submitting ? 'Saving…' : 'Save Item'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
