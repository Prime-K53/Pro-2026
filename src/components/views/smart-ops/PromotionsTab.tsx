import React, { useEffect, useState } from 'react';
import { Percent, Plus, Receipt, Tag, TrendingUp } from 'lucide-react';
import { ApiPromotion, ApiPromotionRedemption, smartOpsApi } from '../../../services/smartOpsApi';
import { useAccounting } from '../../../context/AccountingContext';
import { formatCurrency } from '../../../utils/currency';
import { EmptyState, FormField, InlineAlert, Panel, StatCard } from '../../common/ui';

interface PromotionsTabProps {
  onDataChanged?: () => void;
}

export const PromotionsTab: React.FC<PromotionsTabProps> = ({ onDataChanged }) => {
  const { accounts, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [promotions, setPromotions] = useState<ApiPromotion[]>([]);
  const [redemptions, setRedemptions] = useState<ApiPromotionRedemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  // Create Form State
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [discountType, setDiscountType] = useState<'percent' | 'fixed_amount' | 'bogo' | 'bundle'>('percent');
  const [discountValue, setDiscountValue] = useState('10');
  const [minOrderAmount, setMinOrderAmount] = useState('0');
  const [maxDiscountAmount, setMaxDiscountAmount] = useState('');
  const [applicableItemType, setApplicableItemType] = useState('all');
  const [usageLimit, setUsageLimit] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [showOnPriceCard, setShowOnPriceCard] = useState(true);
  const [discountAccountId, setDiscountAccountId] = useState('');

  const discountAccounts = accounts.filter(
    a => a.type === 'Income' || a.type === 'Expense'
  );

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await smartOpsApi.listPromotions();
      setPromotions(res.promotions);
      setRedemptions(res.redemptions);
    } catch (err: any) {
      setError(err?.message || 'Failed to load promotions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!discountAccountId && discountAccounts.length > 0) {
      const preferred =
        discountAccounts.find(a => a.code === '4100') ||
        discountAccounts.find(a => a.code === '4000') ||
        discountAccounts[0];
      setDiscountAccountId(preferred.id);
    }
  }, [accounts.length]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !name.trim()) return;
    setBusy(true);
    try {
      await smartOpsApi.createPromotion({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description: description.trim(),
        discountType,
        discountValue: Number(discountValue) || 0,
        minOrderAmount: Number(minOrderAmount) || 0,
        maxDiscountAmount: maxDiscountAmount ? Number(maxDiscountAmount) : undefined,
        applicableItemType,
        usageLimit: usageLimit ? Number(usageLimit) : undefined,
        endsAt: endsAt || undefined,
        showOnPriceCard,
        discountAccountId: discountAccountId ? Number(discountAccountId) : undefined,
      });
      setCode('');
      setName('');
      setDescription('');
      setShowForm(false);
      triggerShortcutNotice('Promotion created & ready for POS & Price Cards', 'success');
      await loadData();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to create promotion', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (promo: ApiPromotion, field: 'isActive' | 'showOnPriceCard') => {
    try {
      await smartOpsApi.updatePromotion(promo.id, {
        [field]: !promo[field],
      });
      await loadData();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Update failed', 'error');
    }
  };

  const activeCount = promotions.filter(p => p.isActive).length;
  const totalDiscount = promotions.reduce((s, p) => s + p.totalDiscountGiven, 0);
  const influencedRev = promotions.reduce((s, p) => s + p.influencedRevenue, 0);
  const totalRedemptions = promotions.reduce((s, p) => s + p.usageCount, 0);

  return (
    <div className="space-y-6">
      {error && (
        <InlineAlert tone="error" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      {/* Analytics Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active Promotions"
          value={activeCount}
          hint={`${promotions.length} total campaign codes`}
          icon={<Tag className="h-4 w-4" />}
          tone="blue"
          loading={loading}
        />
        <StatCard
          label="POS Redemptions"
          value={totalRedemptions}
          hint="Verified promo applications"
          icon={<Receipt className="h-4 w-4" />}
          tone="emerald"
          loading={loading}
        />
        <StatCard
          label="Influenced Revenue"
          value={formatCurrency(influencedRev, currency)}
          hint="Gross orders with promo attached"
          icon={<TrendingUp className="h-4 w-4" />}
          tone="neutral"
          loading={loading}
        />
        <StatCard
          label="Contra-Revenue Cost (4100)"
          value={formatCurrency(totalDiscount, currency)}
          hint="Posted to Sales Discounts GL"
          icon={<Percent className="h-4 w-4" />}
          tone="amber"
          loading={loading}
        />
      </div>

      {/* Promotions Table & Creator */}
      <Panel
        title="Promotional Offers & POS Discount Rules"
        description="Promotions debit 4100 Sales Discounts & Promotions automatically at POS checkout and sync directly into Price Cards."
        actions={
          <button
            type="button"
            onClick={() => setShowForm(v => !v)}
            className="btn btn-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            Create Promotion
          </button>
        }
      >
        {showForm && (
          <form
            onSubmit={handleCreate}
            className="mb-5 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 md:grid-cols-4 dark:border-white/10 dark:bg-white/[0.03]"
          >
            <FormField label="Promo Code" required>
              <input
                type="text"
                className="app-input app-input-mono uppercase"
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. EXAM20"
                required
              />
            </FormField>
            <FormField label="Promotion Name" required className="md:col-span-2">
              <input
                type="text"
                className="app-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Exam Season 20% Bulk Print Offer"
                required
              />
            </FormField>
            <FormField label="Discount Type">
              <select
                className="app-input"
                value={discountType}
                onChange={e => setDiscountType(e.target.value as any)}
              >
                <option value="percent">Percentage (%)</option>
                <option value="fixed_amount">Fixed Amount ({currency})</option>
                <option value="bogo">BOGO (50% on paired qty)</option>
                <option value="bundle">Bundle Deal ({currency} off)</option>
              </select>
            </FormField>

            <FormField label={discountType === 'percent' ? 'Discount %' : `Discount (${currency})`}>
              <input
                type="number"
                min="0"
                step="0.01"
                className="app-input app-input-mono"
                value={discountValue}
                onChange={e => setDiscountValue(e.target.value)}
              />
            </FormField>
            <FormField label={`Min Spend (${currency})`}>
              <input
                type="number"
                min="0"
                step="0.01"
                className="app-input app-input-mono"
                value={minOrderAmount}
                onChange={e => setMinOrderAmount(e.target.value)}
              />
            </FormField>
            <FormField label={`Max Discount Cap (${currency})`}>
              <input
                type="number"
                min="0"
                step="0.01"
                className="app-input app-input-mono"
                value={maxDiscountAmount}
                onChange={e => setMaxDiscountAmount(e.target.value)}
                placeholder="Optional"
              />
            </FormField>
            <FormField label="Applies To">
              <select
                className="app-input"
                value={applicableItemType}
                onChange={e => setApplicableItemType(e.target.value)}
              >
                <option value="all">All POS Items</option>
                <option value="printing_service">Printing Services</option>
                <option value="printed_product">Printed Products</option>
                <option value="stationery">Stationery</option>
              </select>
            </FormField>

            <FormField label="Usage Limit">
              <input
                type="number"
                min="1"
                className="app-input app-input-mono"
                value={usageLimit}
                onChange={e => setUsageLimit(e.target.value)}
                placeholder="Unlimited"
              />
            </FormField>
            <FormField label="Expires On">
              <input
                type="date"
                className="app-input app-input-mono"
                value={endsAt}
                onChange={e => setEndsAt(e.target.value)}
              />
            </FormField>
            <FormField label="GL Contra-Revenue Account" className="md:col-span-2">
              <select
                className="app-input"
                value={discountAccountId}
                onChange={e => setDiscountAccountId(e.target.value)}
              >
                {discountAccounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </FormField>

            <div className="flex flex-wrap items-center justify-between gap-3 md:col-span-4">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={showOnPriceCard}
                  onChange={e => setShowOnPriceCard(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600"
                />
                Feature this offer on WhatsApp Price Cards
              </label>
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className="btn btn-primary">
                  Save Promotion
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        )}

        {promotions.length === 0 ? (
          <EmptyState
            title="No promotions created yet"
            description="Create a discount code to offer seasonal print promos at POS and highlight on WhatsApp Price Cards."
            icon={<Tag className="h-6 w-6" />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Code & Offer</th>
                  <th>Rule</th>
                  <th>GL Account</th>
                  <th className="text-right">Uses</th>
                  <th className="text-right">Discounts Given</th>
                  <th>Price Card</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {promotions.map(p => (
                  <tr key={p.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-brand-600 dark:text-brand-400">
                          {p.code}
                        </span>
                        <span className="font-semibold text-slate-900 dark:text-white">{p.name}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        Scope: {p.applicableItemType.replace(/_/g, ' ')} · Min{' '}
                        {formatCurrency(p.minOrderAmount, currency)}
                        {p.endsAt ? ` · Ends ${p.endsAt}` : ''}
                      </div>
                    </td>
                    <td className="font-mono text-xs font-semibold tabular-nums">
                      {p.discountType === 'percent'
                        ? `${p.discountValue}% off`
                        : p.discountType === 'bogo'
                        ? 'BOGO 50% pair'
                        : `${formatCurrency(p.discountValue, currency)} off`}
                    </td>
                    <td className="text-xs text-slate-500">{p.discountAccountLabel || '4100'}</td>
                    <td className="text-right font-mono font-semibold tabular-nums">
                      {p.usageCount}
                      {p.usageLimit ? ` / ${p.usageLimit}` : ''}
                    </td>
                    <td className="text-right font-mono font-bold tabular-nums text-amber-700 dark:text-amber-400">
                      {formatCurrency(p.totalDiscountGiven, currency)}
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => handleToggle(p, 'showOnPriceCard')}
                        className={`text-xs font-semibold ${
                          p.showOnPriceCard ? 'text-brand-600 dark:text-brand-400' : 'text-slate-400'
                        }`}
                      >
                        {p.showOnPriceCard ? 'Shown' : 'Hidden'}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => handleToggle(p, 'isActive')}
                        className={`text-xs font-bold ${
                          p.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'
                        }`}
                      >
                        {p.isActive ? 'Active' : 'Paused'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Redemption Log */}
      {redemptions.length > 0 && (
        <Panel
          title="Recent Promotion Redemptions"
          description="Audit trail of discounts posted from POS checkout."
        >
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Promo Code</th>
                  <th>Customer</th>
                  <th className="text-right">Order Subtotal</th>
                  <th className="text-right">Discount Applied</th>
                </tr>
              </thead>
              <tbody>
                {redemptions.map(r => (
                  <tr key={r.id}>
                    <td className="font-mono text-xs text-slate-500">
                      {new Date(r.redeemedAt).toLocaleDateString()}
                    </td>
                    <td className="font-mono text-xs font-bold text-brand-600 dark:text-brand-400">
                      {r.promoCode}
                    </td>
                    <td className="text-xs font-medium text-slate-800 dark:text-slate-200">
                      {r.customerName}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(r.orderSubtotal, currency)}
                    </td>
                    <td className="text-right font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                      -{formatCurrency(r.discountAmount, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
};
