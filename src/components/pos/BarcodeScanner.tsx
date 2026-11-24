import React, { useState } from 'react';
import { ScanLine, Search, Package } from 'lucide-react';
import { smartOpsApi, ApiPosCatalogItem } from '../../services/smartOpsApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { EmptyState, Panel, StatusBadge } from '../common/ui';

/**
 * WS-1 P5 — barcode lookup.
 *
 * A USB/Bluetooth barcode scanner behaves as a keyboard and types the digits
 * followed by Enter, so a plain focused input captures hardware scans without
 * any special driver. The form also accepts manual entry.
 */
export const BarcodeScanner: React.FC = () => {
  const { companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [barcode, setBarcode] = useState('');
  const [result, setResult] = useState<ApiPosCatalogItem | null>(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);

  const lookup = async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const res = await smartOpsApi.lookupBarcode(trimmed);
      setResult(res.item ?? null);
      setSearched(true);
      if (res.item) {
        triggerShortcutNotice(`Found ${res.item.name}`);
      }
    } catch (err: any) {
      setResult(null);
      setSearched(true);
      triggerShortcutNotice(err?.message || 'No item found for that barcode', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    lookup(barcode);
  };

  return (
    <Panel
      title="Barcode Scanner"
      description="Scan or type an item barcode. Hardware scanners work by focusing this field."
      icon={<ScanLine className="h-4 w-4 text-brand-600" />}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              type="text"
              value={barcode}
              onChange={e => setBarcode(e.target.value)}
              placeholder="Scan barcode…"
              className="w-full rounded-md border border-slate-300 bg-white py-2 pl-9 pr-3 font-mono text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          </div>
          <button type="submit" disabled={busy || !barcode.trim()} className="btn btn-primary">
            {busy ? 'Looking…' : 'Look up'}
          </button>
        </div>

        {result && (
          <div className="rounded-xl border border-slate-200 p-4 dark:border-white/[0.07]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
                  <Package className="h-5 w-5" />
                </span>
                <div>
                  <div className="font-semibold text-slate-900 dark:text-white">{result.name}</div>
                  <div className="font-mono text-[11px] text-slate-500">
                    {result.sku}
                    {result.barcode ? ` · ${result.barcode}` : ''}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                    <StatusBadge tone="info">{result.itemType}</StatusBadge>
                    <span>
                      On hand: <strong className="tabular-nums">{result.availableQty ?? '—'}</strong>{' '}
                      {result.unitLabel}
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] uppercase text-slate-400">Price</div>
                <div className="font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                  {formatCurrency(Number(result.salesPrice), currency)}
                </div>
                <div className="text-[11px] text-slate-500">
                  Cost {formatCurrency(Number(result.unitCost), currency)}
                </div>
              </div>
            </div>
          </div>
        )}

        {searched && !result && (
          <EmptyState
            title="No matching item"
            description="Check the barcode, or add the item to inventory with a barcode assigned."
          />
        )}
      </form>
    </Panel>
  );
};