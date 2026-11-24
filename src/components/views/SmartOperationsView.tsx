import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Banknote,
  BookOpen,
  CheckCircle2,
  Gift,
  Image as ImageIcon,
  Megaphone,
  Percent,
  RefreshCw,
  ShoppingCart,
  Sparkles,
  Zap,
} from 'lucide-react';
import { SmartOpsOverview, smartOpsApi } from '../../services/smartOpsApi';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import { InlineAlert, PageHeader, Panel, StatCard } from '../common/ui';
import { MarketingMessagesTab } from './smart-ops/MarketingMessagesTab';
import { PriceCardsTab } from './smart-ops/PriceCardsTab';
import { ReferralsTab } from './smart-ops/ReferralsTab';
import { PromotionsTab } from './smart-ops/PromotionsTab';
import { ShiftManager } from '../pos/ShiftManager';
import { SuspendedSalesView } from '../pos/SuspendedSalesView';
import { RefundPanel } from '../pos/RefundPanel';
import { BarcodeScanner } from '../pos/BarcodeScanner';
import { OnlineStatusBanner } from '../pos/OnlineStatusBanner';

type SmartOpsTab = 'hub' | 'marketing' | 'price-cards' | 'referrals' | 'promotions' | 'shift';

export const SmartOperationsView: React.FC = () => {
  const { setIsPosModalOpen, setCurrentView, companyProfile, triggerShortcutNotice } =
    useAccounting();
  const currency = companyProfile.currency || 'K';

  const [activeTab, setActiveTab] = useState<SmartOpsTab>('hub');
  const [overview, setOverview] = useState<SmartOpsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await smartOpsApi.getOverview();
      setOverview(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load Smart Operations metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
  }, []);

  const handleInitializeStarter = async () => {
    setInitializing(true);
    try {
      await smartOpsApi.initializeStarter();
      triggerShortcutNotice(
        'Smart Operations financial accounts (1030, 1050, 2150, 4100, 6450) & starter playbook initialized',
        'success'
      );
      await loadOverview();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Initialization failed', 'error');
    } finally {
      setInitializing(false);
    }
  };

  const hubModules: Array<{
    id: Exclude<SmartOpsTab, 'hub'>;
    title: string;
    subtitle: string;
    metric: string;
    icon: React.ElementType;
    accentClass: string;
  }> = [
    {
      id: 'marketing',
      title: 'Marketing Messages',
      subtitle: 'WhatsApp automation rules, bulk audience campaigns & customer communication log',
      metric: overview
        ? `${overview.marketing.activeRules} active rules · ${overview.marketing.messagesSent} sent`
        : 'WhatsApp Automation & Bulk Blasts',
      icon: Megaphone,
      accentClass:
        'bg-emerald-50 text-emerald-700 ring-emerald-200/80 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20',
    },
    {
      id: 'price-cards',
      title: 'Price Cards',
      subtitle: 'Generate WhatsApp-ready promotional PNG price sheets synced to live POS pricing',
      metric: overview
        ? `${overview.priceCards.presetsCount} saved layouts · Live POS Sync`
        : 'WhatsApp-Ready Live Price Sheet',
      icon: ImageIcon,
      accentClass:
        'bg-brand-50 text-brand-700 ring-brand-200/80 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20',
    },
    {
      id: 'referrals',
      title: 'Referrals',
      subtitle: 'Referral programs, advocate codes, reward payouts (Bank / Credit Memo) & ROI analytics',
      metric: overview
        ? `${overview.referrals.conversions} conversions · ${formatCurrency(
            overview.referrals.rewardsPending,
            currency
          )} pending`
        : 'Programs, Rewards & Analytics',
      icon: Gift,
      accentClass:
        'bg-amber-50 text-amber-700 ring-amber-200/80 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
    },
    {
      id: 'shift',
      title: 'Cashier Shift',
      subtitle: 'Open/close the till, record cash-in/out and deposits, and reconcile expected cash',
      metric: 'Float · Cash Movements · Reconciliation',
      icon: Banknote,
      accentClass:
        'bg-sky-50 text-sky-700 ring-sky-200/80 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20',
    },
    {
      id: 'promotions',
      title: 'Promotions',
      subtitle: 'Promo codes, BOGO & bundle rules mapped to 4100 Sales Discounts & POS checkout',
      metric: overview
        ? `${overview.promotions.activeCount} active codes · ${overview.promotions.totalRedemptions} uses`
        : 'Discount Rules & Redemptions',
      icon: Percent,
      accentClass:
        'bg-purple-50 text-purple-700 ring-purple-200/80 dark:bg-purple-500/10 dark:text-purple-300 dark:ring-purple-500/20',
    },
  ];

  const needsSetup =
    overview &&
    (overview.linkedAccounts.length < 7 ||
      (overview.marketing.activeRules === 0 &&
        overview.referrals.activePrograms === 0 &&
        overview.promotions.activeCount === 0));

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 p-5 sm:p-7">
      <PageHeader
        title="Smart Operations"
        subtitle="Customer growth, WhatsApp automation, live POS price cards, referral payouts, and full multi-tender POS checkout backed by double-entry GL posting."
        icon={<Zap className="h-5 w-5" />}
        actions={
          <>
            {needsSetup && (
              <button
                type="button"
                onClick={handleInitializeStarter}
                disabled={initializing}
                className="btn btn-secondary"
              >
                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                {initializing ? 'Initializing...' : 'Initialize Accounts & Starter Playbook'}
              </button>
            )}
            <button
              type="button"
              onClick={loadOverview}
              disabled={loading}
              className="btn btn-secondary"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setIsPosModalOpen(true)}
              className="btn btn-emerald"
            >
              <ShoppingCart className="h-4 w-4" />
              Open Full POS Terminal
            </button>
          </>
        }
      />

      {error && (
        <InlineAlert tone="error" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      {/* Top Module Switcher Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200/80 bg-white p-2 shadow-card dark:border-white/[0.07] dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTab('hub')}
            className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
              activeTab === 'hub'
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/[0.06]'
            }`}
          >
            {activeTab !== 'hub' && <ArrowLeft className="h-3.5 w-3.5" />}
            Operations Hub
          </button>
          {hubModules.map(m => {
            const Icon = m.icon;
            const active = activeTab === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setActiveTab(m.id)}
                className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
                  active
                    ? 'bg-brand-600 text-white shadow-glow dark:bg-brand-500'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/[0.06]'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {m.title}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setIsPosModalOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white transition-colors hover:bg-emerald-500"
        >
          <ShoppingCart className="h-3.5 w-3.5" />
          Launch POS Checkout
        </button>
      </div>

      {/* HUB OVERVIEW */}
      {activeTab === 'hub' && (
        <div className="space-y-6">
          {/* 4 Hub Action Buttons */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {hubModules.map(mod => {
              const Icon = mod.icon;
              return (
                <button
                  key={mod.id}
                  type="button"
                  onClick={() => setActiveTab(mod.id)}
                  className="surface surface-hover group flex flex-col justify-between p-6 text-left"
                >
                  <div className="flex w-full items-start justify-between gap-4">
                    <div className="flex items-start gap-4">
                      <span
                        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ring-1 ring-inset ${mod.accentClass}`}
                      >
                        <Icon className="h-6 w-6" />
                      </span>
                      <div>
                        <h2 className="text-base font-bold tracking-tight text-slate-900 group-hover:text-brand-600 dark:text-white dark:group-hover:text-brand-300">
                          {mod.title}
                        </h2>
                        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                          {mod.subtitle}
                        </p>
                      </div>
                    </div>
                    <ArrowRight className="h-5 w-5 shrink-0 text-slate-300 transition-transform group-hover:translate-x-1 group-hover:text-brand-600 dark:text-slate-600 dark:group-hover:text-brand-400" />
                  </div>

                  <div className="mt-5 flex w-full items-center justify-between border-t border-slate-100 pt-3.5 text-xs dark:border-white/[0.06]">
                    <span className="font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                      {mod.metric}
                    </span>
                    <span className="font-semibold text-brand-600 dark:text-brand-400">
                      Open Module
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Live Financial & Operational KPIs */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="POS Counter Revenue"
              value={formatCurrency(overview?.pos.posRevenue || 0, currency)}
              hint={`${overview?.pos.ordersCount || 0} completed orders · ${formatCurrency(
                overview?.pos.todaySales || 0,
                currency
              )} today`}
              icon={<ShoppingCart className="h-4 w-4" />}
              tone="emerald"
              loading={loading}
            />
            <StatCard
              label="Promo & Referral Discounts"
              value={formatCurrency(
                (overview?.promotions.totalDiscount || 0) + (overview?.pos.posDiscounts || 0),
                currency
              )}
              hint={`${overview?.promotions.totalRedemptions || 0} redemptions posted to 4100`}
              icon={<Percent className="h-4 w-4" />}
              tone="amber"
              loading={loading}
            />
            <StatCard
              label="Referral Liability vs Settled"
              value={formatCurrency(overview?.referrals.rewardsPending || 0, currency)}
              hint={`${formatCurrency(
                overview?.referrals.rewardsSettled || 0,
                currency
              )} settled · ${overview?.referrals.conversions || 0} conversions`}
              icon={<Gift className="h-4 w-4" />}
              tone="blue"
              loading={loading}
            />
            <StatCard
              label="WhatsApp Campaigns & Comms"
              value={overview?.marketing.messagesSent || 0}
              hint={`${overview?.marketing.campaignsCount || 0} campaigns · ${formatCurrency(
                overview?.marketing.totalSpend || 0,
                currency
              )} spend`}
              icon={<Megaphone className="h-4 w-4" />}
              tone="neutral"
              loading={loading}
            />
          </div>

          {/* Responsible Financial Accounts Ledger Strip */}
          <Panel
            title="Responsible Financial Accounts (Chart of Accounts Sync)"
            description="All POS tenders, promotional discounts, referral reward liabilities, and marketing spend post directly to these GL accounts."
            icon={<BookOpen className="h-4 w-4 text-brand-600 dark:text-brand-400" />}
            actions={
              <button
                type="button"
                onClick={() => setCurrentView('accounts')}
                className="btn btn-secondary py-1.5 text-xs"
              >
                View Full Chart of Accounts
              </button>
            }
          >
            {overview && overview.linkedAccounts.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Account Name</th>
                      <th>Type</th>
                      <th className="text-right">Live GL Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.linkedAccounts.map(acc => (
                      <tr key={acc.id}>
                        <td className="font-mono font-bold text-brand-600 dark:text-brand-400">
                          {acc.code}
                        </td>
                        <td className="font-semibold text-slate-900 dark:text-white">{acc.name}</td>
                        <td className="text-xs text-slate-500">{acc.accountType}</td>
                        <td className="text-right font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                          {formatCurrency(acc.balance, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200/80 p-4 dark:border-white/[0.08]">
                <div className="flex items-center gap-3 text-xs text-slate-600 dark:text-slate-300">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  <span>
                    Click <strong>Initialize Accounts & Starter Playbook</strong> to create dedicated
                    Smart Operations GL accounts (1030 Mobile Clearing, 1050 Cash Drawer, 2150
                    Referral Rewards Payable, 4100 Sales Discounts, 6450 Marketing Expense) and
                    ready-to-use templates.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleInitializeStarter}
                  disabled={initializing}
                  className="btn btn-primary"
                >
                  {initializing ? 'Initializing...' : 'Initialize Now'}
                </button>
              </div>
            )}
          </Panel>
        </div>
      )}

      {activeTab === 'marketing' && <MarketingMessagesTab onDataChanged={loadOverview} />}
      {activeTab === 'price-cards' && <PriceCardsTab />}
      {activeTab === 'referrals' && <ReferralsTab onDataChanged={loadOverview} />}
      {activeTab === 'shift' && (
        <div className="space-y-6">
          <OnlineStatusBanner />
          <div className="grid gap-6 lg:grid-cols-2">
            <ShiftManager />
            <SuspendedSalesView />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <BarcodeScanner />
            <RefundPanel />
          </div>
        </div>
      )}
      {activeTab === 'promotions' && <PromotionsTab onDataChanged={loadOverview} />}
    </div>
  );
};
