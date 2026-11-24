import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { fixedAssetApi, ApiFixedAsset, ApiFixedAssetType, ApiRollForward } from '../../services/fixedAssetApi';
import { Loader2, Plus, PlayCircle, Archive, AlertTriangle, CheckCircle2 } from 'lucide-react';

/**
 * Fixed-asset register: asset types, capitalised assets, a monthly depreciation
 * run (Dr depreciation expense / Cr accumulated depreciation) and disposal.
 */
export const FixedAssetsView: React.FC = () => {
  const { accounts, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [types, setTypes] = useState<ApiFixedAssetType[]>([]);
  const [assets, setAssets] = useState<ApiFixedAsset[]>([]);
  const [rollForward, setRollForward] = useState<ApiRollForward | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New asset type form
  const [showTypeForm, setShowTypeForm] = useState(false);
  const [typeName, setTypeName] = useState('');
  const [typeMethod, setTypeMethod] = useState<'straight_line' | 'declining_balance'>('straight_line');
  const [typeLife, setTypeLife] = useState('5');
  const [typeAssetAcc, setTypeAssetAcc] = useState('');
  const [typeAccumAcc, setTypeAccumAcc] = useState('');
  const [typeExpenseAcc, setTypeExpenseAcc] = useState('');

  // Register asset form
  const [assetTypeId, setAssetTypeId] = useState('');
  const [assetNumber, setAssetNumber] = useState('');
  const [assetName, setAssetName] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [purchasePrice, setPurchasePrice] = useState('');
  const [salvageValue, setSalvageValue] = useState('0');
  const [assetDescription, setAssetDescription] = useState('');

  // Depreciation run
  const [depPeriod, setDepPeriod] = useState(() => new Date().toISOString().slice(0, 10));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, a, rf] = await Promise.all([
        fixedAssetApi.listTypes(),
        fixedAssetApi.listAssets(),
        fixedAssetApi.rollForward(),
      ]);
      setTypes(t);
      setAssets(a);
      setRollForward(rf);
      setAssetTypeId(prev => prev || (t[0] ? String(t[0].id) : ''));
    } catch (err: any) {
      setError(err?.message || 'Failed to load fixed assets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const activeAccounts = useMemo(() => accounts, [accounts]);

  const handleCreateType = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fixedAssetApi.createType({
        name: typeName,
        depreciationMethod: typeMethod,
        effectiveLifeYears: Number(typeLife) || 5,
        assetAccountId: typeAssetAcc ? Number(typeAssetAcc) : null,
        accumDeprAccountId: typeAccumAcc ? Number(typeAccumAcc) : null,
        deprExpenseAccountId: typeExpenseAcc ? Number(typeExpenseAcc) : null,
      });
      triggerShortcutNotice(`Asset type "${typeName}" created`);
      setTypeName('');
      setShowTypeForm(false);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to create asset type');
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fixedAssetApi.createAsset({
        assetTypeId: Number(assetTypeId),
        assetNumber,
        name: assetName,
        purchaseDate,
        purchasePrice,
        salvageValue,
        description: assetDescription || null,
      });
      triggerShortcutNotice(`Asset ${assetNumber} registered`);
      setAssetNumber('');
      setAssetName('');
      setPurchasePrice('');
      setAssetDescription('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to register asset');
    } finally {
      setBusy(false);
    }
  };

  const handleRunDepreciation = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fixedAssetApi.runDepreciation(depPeriod);
      if (res.idempotentReplay) {
        triggerShortcutNotice(`Depreciation for ${res.periodDate} was already posted`);
      } else {
        triggerShortcutNotice(
          `Posted ${formatCurrency(Number(res.totalDepreciation) || 0, currency)} depreciation across ${res.assetsDepreciated} asset(s)`
        );
      }
      await load();
    } catch (err: any) {
      setError(err?.message || 'Depreciation run failed');
    } finally {
      setBusy(false);
    }
  };

  const handleDispose = async (asset: ApiFixedAsset) => {
    const proceedsRaw = window.prompt(
      `Dispose "${asset.asset_number} — ${asset.name}"\nNet book value: ${formatCurrency(Number(asset.net_book_value), currency)}\nEnter disposal proceeds (0 if scrapped):`,
      '0'
    );
    if (proceedsRaw === null) return;
    const proceeds = Number(proceedsRaw) || 0;
    setBusy(true);
    setError(null);
    try {
      const disposal = await fixedAssetApi.dispose(asset.id, { proceeds });
      const outcome =
        disposal.gain > 0
          ? `gain of ${formatCurrency(disposal.gain, currency)}`
          : disposal.loss > 0
          ? `loss of ${formatCurrency(disposal.loss, currency)}`
          : 'no gain or loss';
      triggerShortcutNotice(`Disposed ${asset.asset_number} (${outcome})`);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Disposal failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Fixed Assets</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Register capitalised assets, run depreciation and retire assets with gain/loss.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTypeForm(v => !v)}
            className="btn btn-secondary text-xs"
            disabled={busy}
          >
            <Plus className="w-4 h-4" /> Asset Type
          </button>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={depPeriod}
              onChange={e => setDepPeriod(e.target.value)}
              className="bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-1.5 text-xs"
            />
            <button
              onClick={handleRunDepreciation}
              disabled={busy || loading}
              className="btn btn-primary text-xs disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
              Run Depreciation
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {showTypeForm && (
        <form
          onSubmit={handleCreateType}
          className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs"
        >
          <label className="space-y-1">
            <span className="font-semibold text-slate-600 dark:text-slate-300">Asset type name</span>
            <input
              value={typeName}
              onChange={e => setTypeName(e.target.value)}
              required
              className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
            />
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-600 dark:text-slate-300">Method</span>
            <select
              value={typeMethod}
              onChange={e => setTypeMethod(e.target.value as any)}
              className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
            >
              <option value="straight_line">Straight line</option>
              <option value="declining_balance">Declining balance</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-600 dark:text-slate-300">Useful life (years)</span>
            <input
              type="number"
              min="1"
              step="0.5"
              value={typeLife}
              onChange={e => setTypeLife(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
            />
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-600 dark:text-slate-300">Asset account</span>
            <select
              value={typeAssetAcc}
              onChange={e => setTypeAssetAcc(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
            >
              <option value="">(default 1500)</option>
              {activeAccounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-600 dark:text-slate-300">Accumulated depreciation account</span>
            <select
              value={typeAccumAcc}
              onChange={e => setTypeAccumAcc(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
            >
              <option value="">(default 1590)</option>
              {activeAccounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-600 dark:text-slate-300">Depreciation expense account</span>
            <select
              value={typeExpenseAcc}
              onChange={e => setTypeExpenseAcc(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
            >
              <option value="">(default 6300)</option>
              {activeAccounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button type="submit" disabled={busy} className="btn btn-primary w-full disabled:opacity-50">
              Save Asset Type
            </button>
          </div>
        </form>
      )}

      {/* Roll-forward KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] uppercase font-bold text-slate-500">Total Cost</div>
          <div className="text-lg font-black tabular-nums font-mono text-slate-900 dark:text-white mt-1">
            {formatCurrency(Number(rollForward?.totalCost ?? 0), currency)}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] uppercase font-bold text-slate-500">Accumulated Depreciation</div>
          <div className="text-lg font-black tabular-nums font-mono text-amber-700 dark:text-amber-400 mt-1">
            {formatCurrency(Number(rollForward?.totalAccumulatedDepreciation ?? 0), currency)}
          </div>
        </div>
        <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-800 rounded-xl p-4">
          <div className="text-[11px] uppercase font-bold text-emerald-800 dark:text-emerald-300">Net Book Value</div>
          <div className="text-lg font-black tabular-nums font-mono text-emerald-900 dark:text-emerald-200 mt-1">
            {formatCurrency(Number(rollForward?.totalNetBookValue ?? 0), currency)}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] uppercase font-bold text-slate-500">Active / Disposed</div>
          <div className="text-lg font-black tabular-nums font-mono text-slate-900 dark:text-white mt-1">
            {rollForward?.activeCount ?? 0} / {rollForward?.disposedCount ?? 0}
          </div>
        </div>
      </div>

      {/* Register asset */}
      <form
        onSubmit={handleRegister}
        className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs"
      >
        <label className="space-y-1">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Asset type</span>
          <select
            value={assetTypeId}
            onChange={e => setAssetTypeId(e.target.value)}
            required
            className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
          >
            {types.length === 0 && <option value="">(create an asset type first)</option>}
            {types.map(t => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Asset number</span>
          <input
            value={assetNumber}
            onChange={e => setAssetNumber(e.target.value)}
            required
            className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
          />
        </label>
        <label className="space-y-1">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Name</span>
          <input
            value={assetName}
            onChange={e => setAssetName(e.target.value)}
            required
            className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
          />
        </label>
        <label className="space-y-1">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Purchase date</span>
          <input
            type="date"
            value={purchaseDate}
            onChange={e => setPurchaseDate(e.target.value)}
            className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
          />
        </label>
        <label className="space-y-1">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Purchase price</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={purchasePrice}
            onChange={e => setPurchasePrice(e.target.value)}
            required
            className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
          />
        </label>
        <label className="space-y-1">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Salvage value</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={salvageValue}
            onChange={e => setSalvageValue(e.target.value)}
            className="w-full bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
          />
        </label>
        <div className="flex items-end lg:col-span-3">
          <button
            type="submit"
            disabled={busy || types.length === 0}
            className="btn btn-primary disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> Register Asset
          </button>
        </div>
      </form>

      {/* Assets table */}
      {loading ? (
        <div className="p-10 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading fixed assets…
        </div>
      ) : assets.length === 0 ? (
        <div className="p-10 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-col items-center gap-2 text-xs text-slate-500">
          <Archive className="w-6 h-6" />
          <span>No fixed assets registered yet.</span>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-[10px] uppercase font-bold text-slate-500 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2.5">Number</th>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5 text-right">Cost</th>
                <th className="px-4 py-2.5 text-right">Accum. Dep.</th>
                <th className="px-4 py-2.5 text-right">NBV</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {assets.map(a => (
                <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2 font-mono font-bold">{a.asset_number}</td>
                  <td className="px-4 py-2">{a.name}</td>
                  <td className="px-4 py-2 text-slate-500">{a.asset_type_name}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(Number(a.purchase_price), currency)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono text-amber-700 dark:text-amber-400">
                    {formatCurrency(Number(a.accumulated_depreciation), currency)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono">{formatCurrency(Number(a.net_book_value), currency)}</td>
                  <td className="px-4 py-2">
                    {a.status === 'disposed' ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                        <CheckCircle2 className="w-3 h-3" /> Disposed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                        Active
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {a.status === 'registered' && (
                      <button
                        onClick={() => handleDispose(a)}
                        disabled={busy}
                        className="text-[11px] font-semibold text-rose-600 hover:text-rose-500 disabled:opacity-50"
                      >
                        Dispose
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};