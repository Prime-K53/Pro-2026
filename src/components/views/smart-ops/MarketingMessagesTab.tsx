import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Megaphone,
  MessageSquare,
  Play,
  Plus,
  Send,
  Sparkles,
  Users,
  Workflow,
} from 'lucide-react';
import {
  ApiMarketingWorkspace,
  ApiPromotion,
  smartOpsApi,
} from '../../../services/smartOpsApi';
import { useAccounting } from '../../../context/AccountingContext';
import { formatCurrency } from '../../../utils/currency';
import { EmptyState, FormField, InlineAlert, Panel, StatCard } from '../../common/ui';

interface MarketingMessagesTabProps {
  onDataChanged?: () => void;
}

const SEGMENTS = [
  { id: 'all', label: 'All Customers with Phone' },
  { id: 'schools', label: 'Schools & Institutions' },
  { id: 'corporate', label: 'Corporate & Retail Accounts' },
  { id: 'overdue', label: 'Overdue Balances (> 0)' },
  { id: 'top_spenders', label: 'Top Spenders (VIP)' },
  { id: 'referral_advocates', label: 'Active Referral Advocates' },
];

const TRIGGERS = [
  { id: 'post_pos_receipt', label: 'After POS Sale Receipt' },
  { id: 'invoice_overdue', label: 'Invoice Overdue Reminder' },
  { id: 'referral_invite', label: 'Advocate Referral Nudge' },
  { id: 'promo_drop', label: 'Promo Code Announcement' },
  { id: 'inactive_customer', label: 'Win-Back / Re-Order' },
];

export const MarketingMessagesTab: React.FC<MarketingMessagesTabProps> = ({ onDataChanged }) => {
  const { accounts, customers, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [workspace, setWorkspace] = useState<ApiMarketingWorkspace | null>(null);
  const [promotions, setPromotions] = useState<ApiPromotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<'automation' | 'campaigns' | 'direct' | 'templates'>('automation');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Campaign Builder State
  const [campName, setCampName] = useState('');
  const [campSegment, setCampSegment] = useState('schools');
  const [campPromoId, setCampPromoId] = useState('');
  const [campTemplateId, setCampTemplateId] = useState('');
  const [campBody, setCampBody] = useState(
    'Hello {{customerName}}, {{companyName}} has special term pricing ready for you. Use promo code {{promoCode}} at our POS counter or reply to place an order!'
  );
  const [campBudget, setCampBudget] = useState('0');
  const [campSpend, setCampSpend] = useState('0');
  const [campPayAccountId, setCampPayAccountId] = useState('');
  const [campExpenseAccountId, setCampExpenseAccountId] = useState('');

  // Direct Message Composer State
  const [directCustomerId, setDirectCustomerId] = useState('');
  const [directName, setDirectName] = useState('');
  const [directPhone, setDirectPhone] = useState('');
  const [directBody, setDirectBody] = useState('');

  // New Automation Rule State
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleName, setRuleName] = useState('');
  const [ruleTrigger, setRuleTrigger] = useState('promo_drop');
  const [ruleTemplateId, setRuleTemplateId] = useState('');
  const [ruleSegment, setRuleSegment] = useState('all');
  const [ruleDelay, setRuleDelay] = useState('0');

  // New Template State
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [tplName, setTplName] = useState('');
  const [tplCategory, setTplCategory] = useState('promotion');
  const [tplBody, setTplBody] = useState(
    'Hi {{customerName}}, {{companyName}} would love to serve your next print order. Present {{promoCode}} at checkout!'
  );

  const paymentAccounts = accounts.filter(
    a => a.type === 'Bank' || a.type === 'OtherCurrentAsset'
  );
  const expenseAccounts = accounts.filter(a => a.type === 'Expense');

  const loadWorkspace = async () => {
    setLoading(true);
    setError(null);
    try {
      const [mkt, promoData] = await Promise.all([
        smartOpsApi.getMarketing(),
        smartOpsApi.listPromotions(),
      ]);
      setWorkspace(mkt);
      setPromotions(promoData.promotions);
      if (mkt.templates.length > 0 && !ruleTemplateId) {
        setRuleTemplateId(String(mkt.templates[0].id));
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load marketing workspace');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkspace();
  }, []);

  useEffect(() => {
    if (!campPayAccountId && paymentAccounts.length > 0) {
      const preferred = paymentAccounts.find(a => a.code === '1010') || paymentAccounts[0];
      setCampPayAccountId(preferred.id);
    }
    if (!campExpenseAccountId && expenseAccounts.length > 0) {
      const preferredExp = expenseAccounts.find(a => a.code === '6450') || expenseAccounts[0];
      setCampExpenseAccountId(preferredExp.id);
    }
  }, [accounts.length]);

  const handleToggleRule = async (id: number, current: boolean) => {
    setBusyKey(`rule-${id}`);
    try {
      await smartOpsApi.toggleAutomationRule(id, !current);
      triggerShortcutNotice(`Automation rule ${!current ? 'enabled' : 'paused'}`, 'success');
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to update rule', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRunRuleNow = async (id: number) => {
    setBusyKey(`run-${id}`);
    try {
      const res = await smartOpsApi.runAutomationRule(id);
      triggerShortcutNotice(
        `Automation executed: ${res.queuedCount} WhatsApp message${res.queuedCount === 1 ? '' : 's'} queued`,
        'success'
      );
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to run automation rule', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleName.trim() || !ruleTemplateId) return;
    setBusyKey('create-rule');
    try {
      await smartOpsApi.createAutomationRule({
        name: ruleName.trim(),
        triggerEvent: ruleTrigger,
        templateId: Number(ruleTemplateId),
        targetSegment: ruleSegment,
        delayHours: Number(ruleDelay) || 0,
      });
      setRuleName('');
      setShowRuleForm(false);
      triggerShortcutNotice('WhatsApp automation rule created', 'success');
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Could not create automation rule', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tplName.trim() || !tplBody.trim()) return;
    setBusyKey('create-tpl');
    try {
      await smartOpsApi.createTemplate({
        name: tplName.trim(),
        category: tplCategory,
        channel: 'whatsapp',
        body: tplBody.trim(),
      });
      setTplName('');
      setShowTemplateForm(false);
      triggerShortcutNotice('WhatsApp template saved', 'success');
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Could not save template', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleTemplateSelectForCampaign = (tplId: string) => {
    setCampTemplateId(tplId);
    const found = workspace?.templates.find(t => String(t.id) === tplId);
    if (found) setCampBody(found.body);
  };

  const handleDispatchCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!campName.trim() || !campBody.trim()) {
      triggerShortcutNotice('Campaign name and message body are required', 'warning');
      return;
    }
    setBusyKey('dispatch-camp');
    try {
      const spendVal = Number(campSpend) || 0;
      const created = await smartOpsApi.createCampaign({
        name: campName.trim(),
        channel: 'whatsapp',
        audienceSegment: campSegment,
        templateId: campTemplateId ? Number(campTemplateId) : undefined,
        messageBody: campBody.trim(),
        promoId: campPromoId ? Number(campPromoId) : undefined,
        budgetAmount: Number(campBudget) || 0,
        actualSpend: spendVal,
        paymentAccountId: spendVal > 0 && campPayAccountId ? Number(campPayAccountId) : undefined,
        expenseAccountId:
          spendVal > 0 && campExpenseAccountId ? Number(campExpenseAccountId) : undefined,
      });
      setCampName('');
      setCampSpend('0');
      triggerShortcutNotice(
        `Bulk campaign dispatched to ${created.recipientCount} customers${
          spendVal > 0 ? ' & posted to GL Marketing Expense' : ''
        }`,
        'success'
      );
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Campaign dispatch failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSelectDirectCustomer = (custId: string) => {
    setDirectCustomerId(custId);
    const c = customers.find(x => x.id === custId);
    if (c) {
      setDirectName(c.companyName || c.name);
      setDirectPhone(c.phone || '');
    }
  };

  const handleSendDirect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!directPhone.trim() || !directBody.trim()) {
      triggerShortcutNotice('Recipient phone number and message text are required', 'warning');
      return;
    }
    setBusyKey('send-direct');
    try {
      await smartOpsApi.sendDirectMessage({
        customerId: directCustomerId ? Number(directCustomerId) : undefined,
        recipientName: directName.trim() || 'Customer',
        recipientPhone: directPhone.trim(),
        channel: 'whatsapp',
        body: directBody.trim(),
      });
      setDirectBody('');
      triggerShortcutNotice('Customer WhatsApp message logged & link ready', 'success');
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to log customer message', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleMarkStatus = async (msgId: number, status: string) => {
    try {
      await smartOpsApi.updateMessageStatus(msgId, status);
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Status update failed', 'error');
    }
  };

  const selectedPromo = promotions.find(p => String(p.id) === campPromoId);
  const previewInterpolated = campBody
    .replace(/\{\{\s*customerName\s*\}\}/gi, customers[0]?.companyName || 'St. Mary Secondary')
    .replace(/\{\{\s*companyName\s*\}\}/gi, companyProfile.name || 'Print House')
    .replace(/\{\{\s*promoCode\s*\}\}/gi, selectedPromo?.code || 'PRINT10');

  const rules = workspace?.automationRules || [];
  const campaigns = workspace?.campaigns || [];
  const messages = workspace?.messages || [];
  const templates = workspace?.templates || [];

  const totalSpend = campaigns.reduce((s, c) => s + c.actualSpend, 0);
  const activeRulesCount = rules.filter(r => r.isEnabled).length;
  const deliveredCount = messages.filter(m => m.status === 'delivered' || m.status === 'sent').length;

  return (
    <div className="space-y-6">
      {error && (
        <InlineAlert tone="error" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active WhatsApp Rules"
          value={activeRulesCount}
          hint={`${rules.length} configured automation workflows`}
          icon={<Workflow className="h-4 w-4" />}
          tone="blue"
          loading={loading}
        />
        <StatCard
          label="Bulk Campaigns"
          value={campaigns.length}
          hint={`${campaigns.reduce((s, c) => s + c.recipientCount, 0)} total targeted contacts`}
          icon={<Megaphone className="h-4 w-4" />}
          tone="emerald"
          loading={loading}
        />
        <StatCard
          label="Customer Messages Log"
          value={messages.length}
          hint={`${deliveredCount} queued / sent via WhatsApp`}
          icon={<MessageSquare className="h-4 w-4" />}
          tone="neutral"
          loading={loading}
        />
        <StatCard
          label="Campaign GL Ad Spend"
          value={formatCurrency(totalSpend, currency)}
          hint="Posted to 6450 Marketing Expense"
          icon={<Sparkles className="h-4 w-4" />}
          tone="amber"
          loading={loading}
        />
      </div>

      {/* Sub-navigation bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 pb-3 dark:border-white/[0.06]">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'automation', label: 'WhatsApp Automation', icon: Workflow },
              { id: 'campaigns', label: 'Bulk Campaigns', icon: Megaphone },
              { id: 'direct', label: 'Customer Comms & Log', icon: MessageSquare },
              { id: 'templates', label: 'Message Templates', icon: Users },
            ] as const
          ).map(tab => {
            const Icon = tab.icon;
            const active = subTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSubTab(tab.id)}
                className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
                  active
                    ? 'bg-brand-600 text-white shadow-glow dark:bg-brand-500'
                    : 'bg-white text-slate-600 ring-1 ring-slate-200/80 hover:bg-slate-50 dark:bg-white/[0.04] dark:text-slate-300 dark:ring-white/10 dark:hover:bg-white/[0.08]'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 1. WHATSAPP AUTOMATION */}
      {subTab === 'automation' && (
        <Panel
          title="WhatsApp Automation Rules"
          description="Trigger instant WhatsApp receipts on POS sales, overdue balance nudges, and promo broadcasts."
          icon={<Workflow className="h-4 w-4 text-brand-600 dark:text-brand-400" />}
          actions={
            <button
              type="button"
              onClick={() => setShowRuleForm(v => !v)}
              className="btn btn-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              New Automation Rule
            </button>
          }
        >
          {showRuleForm && (
            <form
              onSubmit={handleCreateRule}
              className="mb-5 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 md:grid-cols-5 dark:border-white/10 dark:bg-white/[0.03]"
            >
              <FormField label="Rule Name" required className="md:col-span-2">
                <input
                  type="text"
                  className="app-input"
                  placeholder="e.g. Monthly School Paper Re-order Reminder"
                  value={ruleName}
                  onChange={e => setRuleName(e.target.value)}
                  required
                />
              </FormField>
              <FormField label="Trigger Event">
                <select
                  className="app-input"
                  value={ruleTrigger}
                  onChange={e => setRuleTrigger(e.target.value)}
                >
                  {TRIGGERS.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Template">
                <select
                  className="app-input"
                  value={ruleTemplateId}
                  onChange={e => setRuleTemplateId(e.target.value)}
                  required
                >
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Target Segment">
                <select
                  className="app-input"
                  value={ruleSegment}
                  onChange={e => setRuleSegment(e.target.value)}
                >
                  {SEGMENTS.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </FormField>
              <div className="flex items-end gap-2 md:col-span-5">
                <FormField label="Delay (Hours)" className="w-36">
                  <input
                    type="number"
                    min="0"
                    className="app-input app-input-mono"
                    value={ruleDelay}
                    onChange={e => setRuleDelay(e.target.value)}
                  />
                </FormField>
                <button
                  type="submit"
                  disabled={busyKey === 'create-rule'}
                  className="btn btn-primary"
                >
                  Save Rule
                </button>
                <button
                  type="button"
                  onClick={() => setShowRuleForm(false)}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {rules.length === 0 ? (
            <EmptyState
              title="No WhatsApp automation rules yet"
              description="Click Initialize Accounts & Playbook on the Hub or create a custom automation rule above."
              icon={<Workflow className="h-6 w-6" />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Rule & Template</th>
                    <th>Trigger</th>
                    <th>Segment</th>
                    <th className="text-right">Runs</th>
                    <th>State</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map(rule => (
                    <tr key={rule.id}>
                      <td>
                        <div className="font-semibold text-slate-900 dark:text-white">{rule.name}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                          {rule.templateName} · Delay {rule.delayHours}h
                        </div>
                      </td>
                      <td className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        {TRIGGERS.find(t => t.id === rule.triggerEvent)?.label || rule.triggerEvent}
                      </td>
                      <td className="text-xs text-slate-600 dark:text-slate-400">
                        {SEGMENTS.find(s => s.id === rule.targetSegment)?.label || rule.targetSegment}
                      </td>
                      <td className="text-right font-mono font-semibold tabular-nums">
                        {rule.runsCount}
                      </td>
                      <td>
                        <button
                          type="button"
                          disabled={busyKey === `rule-${rule.id}`}
                          onClick={() => handleToggleRule(rule.id, rule.isEnabled)}
                          className={`text-xs font-bold ${
                            rule.isEnabled
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-slate-400 dark:text-slate-500'
                          }`}
                        >
                          {rule.isEnabled ? 'Enabled' : 'Paused'}
                        </button>
                      </td>
                      <td className="text-right">
                        <button
                          type="button"
                          disabled={busyKey === `run-${rule.id}`}
                          onClick={() => handleRunRuleNow(rule.id)}
                          className="btn btn-secondary py-1.5 text-xs"
                        >
                          <Play className="h-3 w-3 text-emerald-600" />
                          Run Now
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {/* 2. BULK CAMPAIGNS */}
      {subTab === 'campaigns' && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[440px_1fr]">
          <Panel
            title="Launch Bulk WhatsApp Campaign"
            description="Segment customers, personalize with {{customerName}} / {{promoCode}}, and optionally post ad spend to GL."
            icon={<Megaphone className="h-4 w-4 text-emerald-600" />}
          >
            <form onSubmit={handleDispatchCampaign} className="space-y-4">
              <FormField label="Campaign Name" required>
                <input
                  type="text"
                  className="app-input"
                  placeholder="e.g. Term 2 Exam Stationery Blast"
                  value={campName}
                  onChange={e => setCampName(e.target.value)}
                  required
                />
              </FormField>

              <div className="grid grid-cols-2 gap-3">
                <FormField label="Audience Segment">
                  <select
                    className="app-input"
                    value={campSegment}
                    onChange={e => setCampSegment(e.target.value)}
                  >
                    {SEGMENTS.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Attach Promo Code">
                  <select
                    className="app-input"
                    value={campPromoId}
                    onChange={e => setCampPromoId(e.target.value)}
                  >
                    <option value="">None</option>
                    {promotions
                      .filter(p => p.isActive)
                      .map(p => (
                        <option key={p.id} value={p.id}>
                          {p.code} — {p.name}
                        </option>
                      ))}
                  </select>
                </FormField>
              </div>

              <FormField label="Load From Template">
                <select
                  className="app-input"
                  value={campTemplateId}
                  onChange={e => handleTemplateSelectForCampaign(e.target.value)}
                >
                  <option value="">Custom message body...</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </FormField>

              <FormField
                label="Message Body"
                hint="Variables supported: {{customerName}}, {{companyName}}, {{promoCode}}"
                required
              >
                <textarea
                  rows={4}
                  className="app-input"
                  value={campBody}
                  onChange={e => setCampBody(e.target.value)}
                  required
                />
              </FormField>

              <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/60 p-3 text-xs text-emerald-950 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-100">
                <div className="mb-1 text-[10px] font-bold tracking-wider text-emerald-700 uppercase dark:text-emerald-300">
                  Live WhatsApp Preview
                </div>
                <p className="leading-relaxed whitespace-pre-wrap">{previewInterpolated}</p>
              </div>

              <div className="grid grid-cols-2 gap-3 border-t border-slate-200/70 pt-3 dark:border-white/[0.06]">
                <FormField label={`Planned Budget (${currency})`}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="app-input app-input-mono"
                    value={campBudget}
                    onChange={e => setCampBudget(e.target.value)}
                  />
                </FormField>
                <FormField
                  label={`GL Ad Spend Now (${currency})`}
                  hint="> 0 posts Dr 6450 / Cr Bank"
                >
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="app-input app-input-mono"
                    value={campSpend}
                    onChange={e => setCampSpend(e.target.value)}
                  />
                </FormField>
              </div>

              {Number(campSpend) > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Expense Account">
                    <select
                      className="app-input"
                      value={campExpenseAccountId}
                      onChange={e => setCampExpenseAccountId(e.target.value)}
                    >
                      {expenseAccounts.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Paid From Bank / Cash">
                    <select
                      className="app-input"
                      value={campPayAccountId}
                      onChange={e => setCampPayAccountId(e.target.value)}
                    >
                      {paymentAccounts.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                </div>
              )}

              <button
                type="submit"
                disabled={busyKey === 'dispatch-camp'}
                className="btn btn-emerald w-full py-2.5"
              >
                <Send className="h-3.5 w-3.5" />
                {busyKey === 'dispatch-camp' ? 'Dispatching...' : 'Dispatch Bulk Campaign'}
              </button>
            </form>
          </Panel>

          <Panel
            title="Campaign History & Financial Attribution"
            description="Every dispatched campaign queues personalized WhatsApp links and optionally posts marketing spend to the General Ledger."
          >
            {campaigns.length === 0 ? (
              <EmptyState
                title="No campaigns dispatched yet"
                description="Use the campaign builder on the left to reach segmented customers via WhatsApp."
                icon={<Megaphone className="h-6 w-6" />}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Segment</th>
                      <th className="text-right">Recipients</th>
                      <th className="text-right">GL Spend</th>
                      <th>Accounting Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map(c => (
                      <tr key={c.id}>
                        <td>
                          <div className="font-semibold text-slate-900 dark:text-white">{c.name}</div>
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            {c.promoCode ? `Promo ${c.promoCode} · ` : ''}
                            {c.dispatchedAt ? new Date(c.dispatchedAt).toLocaleDateString() : 'Draft'}
                          </div>
                        </td>
                        <td className="text-xs text-slate-600 dark:text-slate-300">
                          {SEGMENTS.find(s => s.id === c.audienceSegment)?.label || c.audienceSegment}
                        </td>
                        <td className="text-right font-mono font-semibold tabular-nums">
                          {c.recipientCount}
                        </td>
                        <td className="text-right font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                          {formatCurrency(c.actualSpend, currency)}
                        </td>
                        <td className="text-xs text-slate-500 dark:text-slate-400">
                          {c.expenseJournalTxnId ? (
                            <span className="font-mono text-emerald-600 dark:text-emerald-400">
                              JE #{c.expenseJournalTxnId} · {c.expenseAccountLabel}
                            </span>
                          ) : (
                            'No GL spend posted'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}

      {/* 3. CUSTOMER COMMS & LOG */}
      {subTab === 'direct' && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[380px_1fr]">
          <Panel
            title="Send Direct Customer WhatsApp"
            description="Compose a 1-on-1 message and generate a verified wa.me launch link."
            icon={<Send className="h-4 w-4 text-brand-600" />}
          >
            <form onSubmit={handleSendDirect} className="space-y-3.5">
              <FormField label="Select Customer (Optional)">
                <select
                  className="app-input"
                  value={directCustomerId}
                  onChange={e => handleSelectDirectCustomer(e.target.value)}
                >
                  <option value="">Custom phone contact...</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.companyName} {c.phone ? `(${c.phone})` : ''}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Recipient Name">
                <input
                  type="text"
                  className="app-input"
                  value={directName}
                  onChange={e => setDirectName(e.target.value)}
                  placeholder="Customer name"
                />
              </FormField>
              <FormField label="WhatsApp Phone Number" required>
                <input
                  type="text"
                  className="app-input app-input-mono"
                  value={directPhone}
                  onChange={e => setDirectPhone(e.target.value)}
                  placeholder="+260 97..."
                  required
                />
              </FormField>
              <FormField label="Message" required>
                <textarea
                  rows={4}
                  className="app-input"
                  value={directBody}
                  onChange={e => setDirectBody(e.target.value)}
                  placeholder="Write order status, quotation follow-up, or promo offer..."
                  required
                />
              </FormField>
              <button
                type="submit"
                disabled={busyKey === 'send-direct'}
                className="btn btn-primary w-full"
              >
                <Send className="h-3.5 w-3.5" />
                Queue & Generate WhatsApp Link
              </button>
            </form>
          </Panel>

          <Panel
            title="Customer Communication Log"
            description="Launch WhatsApp Web/App directly from any logged message or update delivery status."
          >
            {messages.length === 0 ? (
              <EmptyState
                title="No customer messages queued yet"
                description="Messages from POS auto-receipts, bulk campaigns, automation runs, and direct composer appear here."
                icon={<MessageSquare className="h-6 w-6" />}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Recipient</th>
                      <th>Message Preview</th>
                      <th>Source</th>
                      <th>Status</th>
                      <th className="text-right">WhatsApp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map(m => (
                      <tr key={m.id}>
                        <td>
                          <div className="font-semibold text-slate-900 dark:text-white">
                            {m.recipientName}
                          </div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {m.recipientPhone || 'No phone'}
                          </div>
                        </td>
                        <td className="max-w-md text-xs text-slate-600 dark:text-slate-300">
                          <div className="line-clamp-2">{m.renderedBody}</div>
                        </td>
                        <td className="text-xs text-slate-500">
                          {m.campaignName || m.ruleName || (m.posOrderId ? 'POS Receipt' : 'Direct')}
                        </td>
                        <td>
                          <select
                            className="rounded-lg border border-slate-200 bg-transparent px-2 py-1 text-xs font-semibold text-slate-700 dark:border-white/10 dark:text-slate-200"
                            value={m.status}
                            onChange={e => handleMarkStatus(m.id, e.target.value)}
                          >
                            <option value="queued">Queued</option>
                            <option value="sent">Sent</option>
                            <option value="delivered">Delivered</option>
                            <option value="clicked">Clicked</option>
                          </select>
                        </td>
                        <td className="text-right">
                          {m.whatsappUrl ? (
                            <a
                              href={m.whatsappUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => handleMarkStatus(m.id, 'sent')}
                              className="btn btn-emerald py-1.5 text-xs"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Open WhatsApp
                            </a>
                          ) : (
                            <span className="text-[11px] text-slate-400">No phone</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}

      {/* 4. TEMPLATES */}
      {subTab === 'templates' && (
        <Panel
          title="WhatsApp Message Templates"
          description="Reusable message templates shared across automation rules and bulk broadcasts."
          actions={
            <button
              type="button"
              onClick={() => setShowTemplateForm(v => !v)}
              className="btn btn-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              New Template
            </button>
          }
        >
          {showTemplateForm && (
            <form
              onSubmit={handleCreateTemplate}
              className="mb-5 space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-white/[0.03]"
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <FormField label="Template Name" required>
                  <input
                    type="text"
                    className="app-input"
                    value={tplName}
                    onChange={e => setTplName(e.target.value)}
                    placeholder="e.g. Exam Paper Ready Pickup Alert"
                    required
                  />
                </FormField>
                <FormField label="Category">
                  <select
                    className="app-input"
                    value={tplCategory}
                    onChange={e => setTplCategory(e.target.value)}
                  >
                    <option value="promotion">Promotion</option>
                    <option value="receipt">Receipt</option>
                    <option value="reminder">Reminder</option>
                    <option value="referral">Referral</option>
                    <option value="announcement">Announcement</option>
                    <option value="reorder">Re-order</option>
                  </select>
                </FormField>
              </div>
              <FormField label="Template Body" required>
                <textarea
                  rows={3}
                  className="app-input"
                  value={tplBody}
                  onChange={e => setTplBody(e.target.value)}
                  required
                />
              </FormField>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busyKey === 'create-tpl'}
                  className="btn btn-primary"
                >
                  Save Template
                </button>
                <button
                  type="button"
                  onClick={() => setShowTemplateForm(false)}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {templates.length === 0 ? (
            <EmptyState
              title="No message templates"
              description="Create reusable WhatsApp templates for receipts, payment reminders, and seasonal promos."
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {templates.map(tpl => (
                <div
                  key={tpl.id}
                  className="rounded-xl border border-slate-200/80 p-4 dark:border-white/[0.08]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">{tpl.name}</div>
                      <div className="mt-0.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
                        {tpl.category} · {tpl.channel}
                      </div>
                    </div>
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                  </div>
                  <p className="mt-2.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    {tpl.body}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
};
