import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BadgeCheck,
  CheckCircle2,
  Copy,
  DollarSign,
  ExternalLink,
  Gift,
  Plus,
  Settings2,
  Share2,
  ShieldAlert,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import {
  ApiReferralAttribution,
  ApiReferralCase,
  ApiReferralWorkspace,
  smartOpsApi,
} from '../../../services/smartOpsApi';
import { useAccounting } from '../../../context/AccountingContext';
import { formatCurrency } from '../../../utils/currency';
import { EmptyState, FormField, InlineAlert, Panel, StatCard } from '../../common/ui';
import { appDialog } from '../../../design-system';

interface ReferralsTabProps {
  onDataChanged?: () => void;
}

type SubTab = 'rewards' | 'codes' | 'programs' | 'attributions' | 'governance';

interface CampaignFormState {
  referrerRewardType: string;
  referrerRewardValue: string;
  refereeDiscountType: string;
  refereeDiscountValue: string;
  maxReferrerRewardPerOrder: string;
  maxRefereeDiscountPerOrder: string;
  rewardApprovalThreshold: string;
  eligibleItemTypes: string;
  startsAt: string;
  endsAt: string;
  budgetAmount: string;
}

const emptyCampaignForm: CampaignFormState = {
  referrerRewardType: 'percent_commission',
  referrerRewardValue: '',
  refereeDiscountType: 'percent',
  refereeDiscountValue: '',
  maxReferrerRewardPerOrder: '',
  maxRefereeDiscountPerOrder: '',
  rewardApprovalThreshold: '',
  eligibleItemTypes: '',
  startsAt: '',
  endsAt: '',
  budgetAmount: '',
};

export const ReferralsTab: React.FC<ReferralsTabProps> = ({ onDataChanged }) => {
  const { accounts, customers, companyProfile, triggerShortcutNotice } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [workspace, setWorkspace] = useState<ApiReferralWorkspace | null>(null);
  const [attributions, setAttributions] = useState<ApiReferralAttribution[]>([]);
  const [cases, setCases] = useState<ApiReferralCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>('rewards');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Program Form
  const [showProgramForm, setShowProgramForm] = useState(false);
  const [progName, setProgName] = useState('');
  const [progDesc, setProgDesc] = useState('');
  const [rewardType, setRewardType] = useState<'fixed_credit' | 'percent_commission' | 'cash_payout'>('percent_commission');
  const [rewardVal, setRewardVal] = useState('5');
  const [refereeType, setRefereeType] = useState<'percent' | 'fixed_amount'>('percent');
  const [refereeVal, setRefereeVal] = useState('5');
  const [minSpend, setMinSpend] = useState('100');

  // Campaign (creation) Form
  const [showCampForm, setShowCampForm] = useState(false);
  const [campProgId, setCampProgId] = useState('');
  const [campName, setCampName] = useState('');
  const [campChannel, setCampChannel] = useState('whatsapp');
  const [campTarget, setCampTarget] = useState('25');
  const [campBudget, setCampBudget] = useState('500');

  // Advocate Code Form
  const [showCodeForm, setShowCodeForm] = useState(false);
  const [codeProgId, setCodeProgId] = useState('');
  const [codeCampId, setCodeCampId] = useState('');
  const [codeCustomerId, setCodeCustomerId] = useState('');
  const [codeName, setCodeName] = useState('');
  const [codePhone, setCodePhone] = useState('');
  const [codeText, setCodeText] = useState('');

  // Manual Conversion Form
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualCodeId, setManualCodeId] = useState('');
  const [manualRefereeId, setManualRefereeId] = useState('');
  const [manualAmount, setManualAmount] = useState('500');
  const [manualNotes, setManualNotes] = useState('');

  // Legacy payout state
  const [payoutTargetId, setPayoutTargetId] = useState<number | null>(null);
  const [payoutMethod, setPayoutMethod] = useState<'bank_payout' | 'customer_credit'>('bank_payout');
  const [payoutAccountId, setPayoutAccountId] = useState('');

  // Campaign management (config + activation)
  const [editingCampaignId, setEditingCampaignId] = useState<number | null>(null);
  const [campForm, setCampForm] = useState<CampaignFormState>(emptyCampaignForm);
  const [budgetInfo, setBudgetInfo] = useState<Record<number, { reserved: number; qualified: number; remaining: number; discrepancy: boolean }>>({});

  // Governance (fraud/dispute)
  const [showCaseForm, setShowCaseForm] = useState(false);
  const [caseEventId, setCaseEventId] = useState('');
  const [caseReason, setCaseReason] = useState('');

  const bankCashAccounts = accounts.filter(a => a.type === 'Bank' || a.type === 'OtherCurrentAsset');

  const loadWorkspace = async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, attr, caseData] = await Promise.all([
        smartOpsApi.getReferrals(),
        smartOpsApi.getReferralAttributions().catch(() => ({ attributions: [] })),
        smartOpsApi.getReferralCases().catch(() => ({ cases: [] })),
      ]);
      setWorkspace(data);
      setAttributions(attr.attributions);
      setCases(caseData.cases);
      if (data.programs.length > 0) {
        if (!campProgId) setCampProgId(String(data.programs[0].id));
        if (!codeProgId) setCodeProgId(String(data.programs[0].id));
      }
      if (data.codes.length > 0 && !manualCodeId) setManualCodeId(String(data.codes[0].id));
    } catch (err: any) {
      setError(err?.message || 'Failed to load referrals workspace');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkspace();
  }, []);

  useEffect(() => {
    if (!payoutAccountId && bankCashAccounts.length > 0) {
      const preferred =
        bankCashAccounts.find(a => a.code === '1010') ||
        bankCashAccounts.find(a => a.code === '1030') ||
        bankCashAccounts[0];
      setPayoutAccountId(String(preferred.id));
    }
  }, [accounts.length]);

  const handleCreateProgram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!progName.trim()) return;
    setBusyKey('create-prog');
    try {
      await smartOpsApi.createReferralProgram({
        name: progName.trim(),
        description: progDesc.trim(),
        referrerRewardType: rewardType,
        referrerRewardValue: Number(rewardVal) || 0,
        refereeDiscountType: refereeType,
        refereeDiscountValue: Number(refereeVal) || 0,
        minQualifyingSpend: Number(minSpend) || 0,
      });
      setProgName('');
      setProgDesc('');
      setShowProgramForm(false);
      triggerShortcutNotice('Referral program created', 'success');
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to create program', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleProgram = async (id: number, active: boolean) => {
    setBusyKey(`prog-${id}`);
    try {
      await smartOpsApi.toggleReferralProgram(id, !active);
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to update program', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!campProgId || !campName.trim()) return;
    setBusyKey('create-camp');
    try {
      await smartOpsApi.createReferralCampaign({
        programId: Number(campProgId),
        name: campName.trim(),
        channel: campChannel,
        targetReferrals: Number(campTarget) || 25,
        budgetAmount: Number(campBudget) || 0,
      });
      setCampName('');
      setShowCampForm(false);
      triggerShortcutNotice('Referral campaign created (draft — configure & approve to activate)', 'success');
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to create campaign', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSelectCustomerForCode = (cid: string) => {
    setCodeCustomerId(cid);
    const c = customers.find(x => String(x.id) === cid);
    if (c) {
      setCodeName(c.companyName || c.name);
      setCodePhone(c.phone || '');
    }
  };

  const handleCreateCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!codeProgId || !codeName.trim()) return;
    setBusyKey('create-code');
    try {
      await smartOpsApi.createReferralCode({
        programId: Number(codeProgId),
        campaignId: codeCampId ? Number(codeCampId) : undefined,
        referrerCustomerId: codeCustomerId ? Number(codeCustomerId) : undefined,
        referrerName: codeName.trim(),
        referrerPhone: codePhone.trim(),
        code: codeText.trim() || undefined,
      });
      setCodeName('');
      setCodePhone('');
      setCodeText('');
      setShowCodeForm(false);
      triggerShortcutNotice('Advocate referral code issued', 'success');
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to issue referral code', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleRecordManualConversion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCodeId) return;
    setBusyKey('manual-conv');
    try {
      await smartOpsApi.recordManualReferral({
        referralCodeId: Number(manualCodeId),
        refereeCustomerId: manualRefereeId ? Number(manualRefereeId) : undefined,
        qualifyingAmount: Number(manualAmount) || 0,
        notes: manualNotes.trim(),
      });
      setShowManualForm(false);
      setManualNotes('');
      triggerShortcutNotice('Referral conversion recorded (pending qualification)', 'success');
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to record conversion', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleQualify = async (eventId: number) => {
    setBusyKey(`qual-${eventId}`);
    try {
      const res = await smartOpsApi.qualifyReferralEvent(eventId);
      triggerShortcutNotice(
        res.credit
          ? `Qualified & credited ${formatCurrency(res.credit.amount ?? 0, currency)} to wallet`
          : 'Qualified — reward awaiting approval/credit',
        'success'
      );
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Qualification failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleCredit = async (eventId: number) => {
    setBusyKey(`cred-${eventId}`);
    try {
      await smartOpsApi.creditReferralReward(eventId);
      triggerShortcutNotice('Reward credited to existing customer wallet', 'success');
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Reward credit failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleReverse = async (eventId: number) => {
    const reason = await appDialog.prompt({
      title: 'Reverse Referral Reward',
      message: 'Provide the reason for reversing this referral reward.',
      label: 'Reversal reason',
      defaultValue: 'Customer refunded',
      required: true,
      destructive: true,
      confirmLabel: 'Reverse Reward',
    });
    if (reason === null) return;
    setBusyKey(`rev-${eventId}`);
    try {
      const res = await smartOpsApi.reverseReferralReward(eventId, reason);
      triggerShortcutNotice(
        `Reversed ${formatCurrency(res.reversalAmount, currency)}${
          res.negativeBalance > 0 ? ` · wallet recovery ${formatCurrency(res.negativeBalance, currency)}` : ''
        }`,
        'success'
      );
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Reversal failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSettleReward = async (eventId: number) => {
    setBusyKey(`pay-${eventId}`);
    try {
      await smartOpsApi.payoutReferral(eventId, {
        settlementType: payoutMethod,
        paymentAccountId: payoutMethod === 'bank_payout' && payoutAccountId ? Number(payoutAccountId) : undefined,
      });
      setPayoutTargetId(null);
      triggerShortcutNotice('Legacy reward settled', 'success');
      await loadWorkspace();
      onDataChanged?.();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Reward settlement failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const openCampaignEditor = (c: ApiReferralWorkspace['campaigns'][number]) => {
    setEditingCampaignId(c.id);
    setCampForm({
      referrerRewardType: c.referrerRewardType || 'percent_commission',
      referrerRewardValue: c.referrerRewardValue != null ? String(c.referrerRewardValue) : '',
      refereeDiscountType: c.refereeDiscountType || 'percent',
      refereeDiscountValue: c.refereeDiscountValue != null ? String(c.refereeDiscountValue) : '',
      maxReferrerRewardPerOrder: c.maxReferrerRewardPerOrder != null ? String(c.maxReferrerRewardPerOrder) : '',
      maxRefereeDiscountPerOrder: c.maxRefereeDiscountPerOrder != null ? String(c.maxRefereeDiscountPerOrder) : '',
      rewardApprovalThreshold: c.rewardApprovalThreshold != null ? String(c.rewardApprovalThreshold) : '',
      eligibleItemTypes: (c.eligibleItemTypes || []).join(', '),
      startsAt: c.startsAt || '',
      endsAt: c.endsAt || '',
      budgetAmount: String(c.budgetAmount ?? ''),
    });
  };

  const handleSaveCampaignConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingCampaignId == null) return;
    setBusyKey(`cfg-${editingCampaignId}`);
    try {
      await smartOpsApi.configureReferralCampaign(editingCampaignId, {
        referrerRewardType: campForm.referrerRewardType,
        referrerRewardValue: campForm.referrerRewardValue === '' ? undefined : Number(campForm.referrerRewardValue),
        refereeDiscountType: campForm.refereeDiscountType,
        refereeDiscountValue: campForm.refereeDiscountValue === '' ? undefined : Number(campForm.refereeDiscountValue),
        maxReferrerRewardPerOrder: campForm.maxReferrerRewardPerOrder === '' ? null : Number(campForm.maxReferrerRewardPerOrder),
        maxRefereeDiscountPerOrder: campForm.maxRefereeDiscountPerOrder === '' ? null : Number(campForm.maxRefereeDiscountPerOrder),
        rewardApprovalThreshold: campForm.rewardApprovalThreshold === '' ? null : Number(campForm.rewardApprovalThreshold),
        eligibleItemTypes: campForm.eligibleItemTypes
          .split(',')
          .map(s => s.trim())
          .filter(Boolean),
        startsAt: campForm.startsAt || null,
        endsAt: campForm.endsAt || null,
        budgetAmount: campForm.budgetAmount === '' ? 0 : Number(campForm.budgetAmount),
      });
      triggerShortcutNotice('Campaign financial configuration saved', 'success');
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to save configuration', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleFinanceApprove = async (id: number) => {
    setBusyKey(`fin-${id}`);
    try {
      await smartOpsApi.financeApproveCampaign(id);
      triggerShortcutNotice('Finance approval recorded', 'success');
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Finance approval failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleManagementApprove = async (id: number) => {
    setBusyKey(`mgmt-${id}`);
    try {
      await smartOpsApi.managementApproveCampaign(id);
      triggerShortcutNotice('Management approval recorded', 'success');
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Management approval failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleActivate = async (id: number) => {
    setBusyKey(`act-${id}`);
    try {
      await smartOpsApi.activateReferralCampaign(id);
      triggerShortcutNotice('Campaign activated', 'success');
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Activation blocked (config/approvals incomplete)', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleLifecycle = async (id: number, status: string) => {
    let reason: string | undefined;
    if (status === 'suspended') {
      const input = await appDialog.prompt({
        title: 'Suspend Referral Campaign',
        message: 'Provide a reason for suspending this referral campaign.',
        label: 'Suspension reason',
        destructive: true,
        confirmLabel: 'Suspend Campaign',
      });
      if (input === null) return;
      reason = input;
    }
    setBusyKey(`lc-${id}`);
    try {
      await smartOpsApi.setCampaignLifecycle(id, status, reason);
      triggerShortcutNotice(`Campaign ${status}`, 'success');
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Lifecycle change failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleReconcile = async (id: number) => {
    setBusyKey(`rec-${id}`);
    try {
      const info = await smartOpsApi.getCampaignBudget(id);
      setBudgetInfo(prev => ({
        ...prev,
        [id]: {
          reserved: info.reservedLedger,
          qualified: info.qualifiedLedger,
          remaining: info.budgetAmount - info.reservedLedger - info.qualifiedLedger,
          discrepancy: info.discrepancy,
        },
      }));
      triggerShortcutNotice(info.discrepancy ? 'Budget discrepancy detected' : 'Budget reconciled', info.discrepancy ? 'error' : 'success');
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Reconciliation failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleOpenCase = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyKey('open-case');
    try {
      await smartOpsApi.openReferralCase({
        eventId: caseEventId ? Number(caseEventId) : null,
        reason: caseReason.trim() || 'Suspicious referral',
      });
      setShowCaseForm(false);
      setCaseReason('');
      triggerShortcutNotice('Referral case opened & reward placed on hold', 'success');
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to open case', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleDecideCase = async (c: ApiReferralCase) => {
    const decision = await appDialog.prompt({
      title: `Decide Referral Case #${c.id}`,
      message: 'Enter decision: "confirmed" (uphold fraud) or "dismissed" (clear case).',
      label: 'Decision (confirmed / dismissed)',
      defaultValue: 'dismissed',
      required: true,
    });
    if (!decision) return;
    const reasonInput = await appDialog.prompt({
      title: 'Decision Rationale',
      message: 'Document the reason for this decision.',
      label: 'Decision reason',
      multiline: true,
    });
    if (reasonInput === null) return;
    const reason = reasonInput || '';
    setBusyKey(`dec-${c.id}`);
    try {
      await smartOpsApi.decideReferralCase(c.id, { decision: decision.trim().toLowerCase(), reason });
      triggerShortcutNotice('Fraud decision recorded', 'success');
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Decision failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleReviewCase = async (c: ApiReferralCase) => {
    const reviewer = await appDialog.prompt({
      title: `Independent Review — Case #${c.id}`,
      message: 'Enter the independent reviewer user ID.',
      label: 'Reviewer user ID',
      inputType: 'number',
      required: true,
    });
    if (!reviewer) return;
    const outcome = await appDialog.prompt({
      title: 'Independent Review Outcome',
      message: 'Enter the review outcome: "uphold" or "overturn".',
      label: 'Outcome (uphold / overturn)',
      defaultValue: 'overturn',
      required: true,
    });
    if (!outcome) return;
    const reasonInput = await appDialog.prompt({
      title: 'Review Notes',
      message: 'Provide notes explaining the independent review decision.',
      label: 'Review reason',
      multiline: true,
    });
    if (reasonInput === null) return;
    const reason = reasonInput || '';
    setBusyKey(`rev-${c.id}`);
    try {
      await smartOpsApi.reviewReferralCase(c.id, {
        reviewerUserId: Number(reviewer),
        outcome: outcome.trim().toLowerCase(),
        reason,
      });
      triggerShortcutNotice('Independent dispute review recorded', 'success');
      await loadWorkspace();
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Review failed', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const copyShareMessage = (code: string, referrerName: string) => {
    const text = `Hi! ${referrerName} invited you to print & shop at ${companyProfile.name}. Mention referral code ${code} at our POS counter to unlock your welcome discount!`;
    navigator.clipboard?.writeText(text);
    triggerShortcutNotice(`Share text for code ${code} copied`, 'info');
  };

  const analytics = workspace?.analytics;
  const programs = workspace?.programs || [];
  const campaigns = workspace?.campaigns || [];
  const codes = workspace?.codes || [];
  const events = workspace?.events || [];

  return (
    <div className="space-y-6">
      {error && (
        <InlineAlert tone="error" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      {/* Referral Analytics KPI Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Referred Revenue"
          value={formatCurrency(analytics?.totalRevenue || 0, currency)}
          hint={`${analytics?.totalConversions || 0} conversions · ${analytics?.conversionRate || 0}% conv rate`}
          icon={<TrendingUp className="h-4 w-4" />}
          tone="emerald"
          loading={loading}
        />
        <StatCard
          label="Pending Rewards"
          value={formatCurrency(analytics?.pendingLiability || 0, currency)}
          hint="Awaiting qualification / credit"
          icon={<Gift className="h-4 w-4" />}
          tone="amber"
          loading={loading}
        />
        <StatCard
          label="Settled Rewards"
          value={formatCurrency(analytics?.settledRewards || 0, currency)}
          hint="Credited to wallets / settled"
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone="blue"
          loading={loading}
        />
        <StatCard
          label="Referral ROI Multiple"
          value={`${(analytics?.roiMultiple || 0).toFixed(2)}×`}
          hint={`${analytics?.totalClicks || 0} link shares/clicks tracked`}
          icon={<Award className="h-4 w-4" />}
          tone="neutral"
          loading={loading}
        />
      </div>

      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200/80 pb-3 dark:border-white/[0.06]">
        {(
          [
            { id: 'rewards', label: 'Conversions & Rewards', icon: DollarSign },
            { id: 'codes', label: 'Codes & Campaigns', icon: Share2 },
            { id: 'programs', label: 'Programs', icon: Award },
            { id: 'attributions', label: 'Attributions', icon: Users },
            { id: 'governance', label: 'Fraud & Disputes', icon: ShieldAlert },
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

      {/* 1. CONVERSIONS & REWARDS */}
      {subTab === 'rewards' && (
        <Panel
          title="Referral Conversions & Reward Qualification"
          description="Rewards are recognised only after an order is fully paid and delivered (F4-A). Credit qualified rewards to the existing customer wallet (D-02-B)."
          actions={
            <button type="button" onClick={() => setShowManualForm(v => !v)} className="btn btn-primary">
              <Plus className="h-3.5 w-3.5" />
              Record Conversion
            </button>
          }
        >
          {showManualForm && (
            <form
              onSubmit={handleRecordManualConversion}
              className="mb-5 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 md:grid-cols-4 dark:border-white/10 dark:bg-white/[0.03]"
            >
              <FormField label="Advocate Code" required>
                <select className="app-input" value={manualCodeId} onChange={e => setManualCodeId(e.target.value)} required>
                  {codes.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.referrerName}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Referred Customer">
                <select className="app-input" value={manualRefereeId} onChange={e => setManualRefereeId(e.target.value)}>
                  <option value="">Walk-In / External</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.companyName}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label={`Qualifying Order Amount (${currency})`} required>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  className="app-input app-input-mono"
                  value={manualAmount}
                  onChange={e => setManualAmount(e.target.value)}
                  required
                />
              </FormField>
              <FormField label="Notes / Order Ref">
                <input
                  type="text"
                  className="app-input"
                  value={manualNotes}
                  onChange={e => setManualNotes(e.target.value)}
                  placeholder="Invoice # or walk-in ref"
                />
              </FormField>
              <div className="flex gap-2 md:col-span-4">
                <button type="submit" disabled={busyKey === 'manual-conv' || codes.length === 0} className="btn btn-primary">
                  Record Conversion
                </button>
                <button type="button" onClick={() => setShowManualForm(false)} className="btn btn-secondary">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {events.length === 0 ? (
            <EmptyState
              title="No referral conversions yet"
              description="Issue an advocate code and apply it at POS checkout, or record a conversion above."
              icon={<Gift className="h-6 w-6" />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date / Ref</th>
                    <th>Advocate & Code</th>
                    <th>Referred Customer</th>
                    <th className="text-right">Order Value</th>
                    <th className="text-right">Reward</th>
                    <th>Status / Wallet</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map(ev => {
                    const attributed = ev.attributionId != null;
                    return (
                      <tr key={ev.id}>
                        <td>
                          <div className="font-mono text-xs font-semibold">{ev.receiptNumber || `CONV-${ev.id}`}</div>
                          <div className="text-[11px] text-slate-500">{new Date(ev.createdAt).toLocaleDateString()}</div>
                        </td>
                        <td>
                          <div className="font-semibold text-slate-900 dark:text-white">{ev.referrerName}</div>
                          <div className="font-mono text-[11px] text-brand-600 dark:text-brand-400">
                            {ev.referralCode} · {ev.programName}
                          </div>
                        </td>
                        <td className="text-xs font-medium text-slate-700 dark:text-slate-300">{ev.refereeName}</td>
                        <td className="text-right font-mono font-semibold tabular-nums">
                          {formatCurrency(ev.qualifyingAmount, currency)}
                        </td>
                        <td className="text-right font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {formatCurrency(ev.rewardAmount, currency)}
                        </td>
                        <td>
                          <div className="text-xs font-bold capitalize text-slate-700 dark:text-slate-200">
                            {ev.status}
                            {ev.fraudHold && <span className="ml-1 text-rose-500">· hold</span>}
                          </div>
                          <div className="font-mono text-[10px] text-slate-400">
                            {ev.walletTxnId ? `Wallet Tx #${ev.walletTxnId}` : ev.payoutJournalTxnId ? `Payout JE #${ev.payoutJournalTxnId}` : ''}
                          </div>
                        </td>
                        <td className="text-right">
                          {attributed ? (
                            <div className="inline-flex items-center gap-1.5">
                              {ev.status === 'pending' && (
                                <button
                                  type="button"
                                  disabled={busyKey === `qual-${ev.id}`}
                                  onClick={() => handleQualify(ev.id)}
                                  className="btn btn-primary py-1.5 text-xs"
                                >
                                  Qualify
                                </button>
                              )}
                              {ev.status === 'approved' && (
                                <button
                                  type="button"
                                  disabled={busyKey === `cred-${ev.id}`}
                                  onClick={() => handleCredit(ev.id)}
                                  className="btn btn-emerald py-1.5 text-xs"
                                >
                                  Credit Wallet
                                </button>
                              )}
                              {ev.status === 'credited' && (
                                <button
                                  type="button"
                                  disabled={busyKey === `rev-${ev.id}`}
                                  onClick={() => handleReverse(ev.id)}
                                  className="btn btn-secondary py-1.5 text-xs"
                                >
                                  Reverse
                                </button>
                              )}
                              {(ev.status === 'paid' || ev.status === 'voided' || ev.status === 'reversed') && (
                                <span className="text-xs capitalize text-slate-400">{ev.status}</span>
                              )}
                            </div>
                          ) : ev.status === 'pending' || ev.status === 'approved' ? (
                            <button
                              type="button"
                              disabled={busyKey === `pay-${ev.id}`}
                              onClick={() => handleSettleReward(ev.id)}
                              className="btn btn-emerald py-1.5 text-xs"
                            >
                              Settle (legacy)
                            </button>
                          ) : (
                            <span className="text-xs capitalize text-slate-400">{ev.status}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {/* 2. CODES & CAMPAIGNS */}
      {subTab === 'codes' && (
        <div className="space-y-6">
          <Panel
            title="Advocate Referral Codes"
            description="Issue trackable referral codes to schools, repeat clients, or print agents."
            actions={
              <button type="button" onClick={() => setShowCodeForm(v => !v)} className="btn btn-primary">
                <Plus className="h-3.5 w-3.5" />
                Issue Advocate Code
              </button>
            }
          >
            {showCodeForm && (
              <form
                onSubmit={handleCreateCode}
                className="mb-5 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 md:grid-cols-3 dark:border-white/10 dark:bg-white/[0.03]"
              >
                <FormField label="Program" required>
                  <select className="app-input" value={codeProgId} onChange={e => setCodeProgId(e.target.value)} required>
                    {programs.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Link Existing Customer">
                  <select className="app-input" value={codeCustomerId} onChange={e => handleSelectCustomerForCode(e.target.value)}>
                    <option value="">External Partner / Staff</option>
                    {customers.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.companyName}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Campaign (Optional)">
                  <select className="app-input" value={codeCampId} onChange={e => setCodeCampId(e.target.value)}>
                    <option value="">Direct / No Campaign</option>
                    {campaigns.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Advocate Name" required>
                  <input
                    type="text"
                    className="app-input"
                    value={codeName}
                    onChange={e => setCodeName(e.target.value)}
                    required
                  />
                </FormField>
                <FormField label="WhatsApp / Phone">
                  <input
                    type="text"
                    className="app-input app-input-mono"
                    value={codePhone}
                    onChange={e => setCodePhone(e.target.value)}
                  />
                </FormField>
                <FormField label="Custom Code (Blank = Secure Auto)">
                  <input
                    type="text"
                    className="app-input app-input-mono uppercase"
                    value={codeText}
                    onChange={e => setCodeText(e.target.value.toUpperCase())}
                    placeholder="e.g. BURSAR26"
                  />
                </FormField>
                <div className="flex gap-2 md:col-span-3">
                  <button type="submit" disabled={busyKey === 'create-code' || programs.length === 0} className="btn btn-primary">
                    Create Referral Code
                  </button>
                  <button type="button" onClick={() => setShowCodeForm(false)} className="btn btn-secondary">
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {codes.length === 0 ? (
              <EmptyState
                title="No advocate codes issued yet"
                description="Generate your first advocate referral code so customers can earn rewards on POS referrals."
                icon={<Users className="h-6 w-6" />}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Advocate</th>
                      <th>Program / Campaign</th>
                      <th className="text-right">Conversions</th>
                      <th className="text-right">Referred Rev</th>
                      <th className="text-right">Earned</th>
                      <th className="text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {codes.map(c => {
                      const waText = encodeURIComponent(
                        `Hello! Use my referral code ${c.code} at ${companyProfile.name} POS counter for an instant discount!`
                      );
                      return (
                        <tr key={c.id}>
                          <td className="font-mono font-bold text-brand-600 dark:text-brand-400">{c.code}</td>
                          <td>
                            <div className="font-semibold text-slate-900 dark:text-white">{c.referrerName}</div>
                            <div className="font-mono text-[11px] text-slate-500">{c.referrerPhone || 'No phone'}</div>
                          </td>
                          <td className="text-xs text-slate-600 dark:text-slate-300">
                            {c.programName}
                            {c.campaignName ? ` · ${c.campaignName}` : ''}
                          </td>
                          <td className="text-right font-mono font-semibold tabular-nums">{c.conversionsCount}</td>
                          <td className="text-right font-mono font-semibold tabular-nums">
                            {formatCurrency(c.totalReferredRevenue, currency)}
                          </td>
                          <td className="text-right font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                            {formatCurrency(c.totalRewardsEarned, currency)}
                          </td>
                          <td className="text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => copyShareMessage(c.code, c.referrerName)}
                                className="btn btn-secondary py-1 text-xs"
                              >
                                <Copy className="h-3 w-3" />
                                Copy
                              </button>
                              <a
                                href={`https://wa.me/?text=${waText}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn btn-emerald py-1 text-xs"
                              >
                                <ExternalLink className="h-3 w-3" />
                                WA
                              </a>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="Referral Acquisition Campaigns"
            description="Configure campaign-level rates, caps, budget and approvals. A campaign cannot activate until mandatory financial configuration and Finance + Management approvals are recorded."
            actions={
              <button type="button" onClick={() => setShowCampForm(v => !v)} className="btn btn-secondary">
                <Plus className="h-3.5 w-3.5" />
                New Campaign
              </button>
            }
          >
            {showCampForm && (
              <form
                onSubmit={handleCreateCampaign}
                className="mb-5 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 md:grid-cols-4 dark:border-white/10 dark:bg-white/[0.03]"
              >
                <FormField label="Program" required>
                  <select className="app-input" value={campProgId} onChange={e => setCampProgId(e.target.value)} required>
                    {programs.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Campaign Name" required>
                  <input
                    type="text"
                    className="app-input"
                    value={campName}
                    onChange={e => setCampName(e.target.value)}
                    placeholder="e.g. Back-to-School QR Flyers"
                    required
                  />
                </FormField>
                <FormField label="Channel">
                  <select className="app-input" value={campChannel} onChange={e => setCampChannel(e.target.value)}>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="print_qr">Print QR / Flyers</option>
                    <option value="walk_in">Walk-In Counter</option>
                    <option value="email">Email</option>
                    <option value="social">Social</option>
                  </select>
                </FormField>
                <FormField label="Target Conversions">
                  <input
                    type="number"
                    min="1"
                    className="app-input app-input-mono"
                    value={campTarget}
                    onChange={e => setCampTarget(e.target.value)}
                  />
                </FormField>
                <div className="flex gap-2 md:col-span-4">
                  <button type="submit" disabled={busyKey === 'create-camp'} className="btn btn-primary">
                    Save Campaign (Draft)
                  </button>
                  <button type="button" onClick={() => setShowCampForm(false)} className="btn btn-secondary">
                    Cancel
                  </button>
                </div>
              </form>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {campaigns.map(c => {
                const remaining = c.budgetAmount - c.budgetReserved - c.budgetQualified;
                const usedPct = c.budgetAmount > 0 ? Math.min(100, Math.round(((c.budgetReserved + c.budgetQualified) / c.budgetAmount) * 100)) : 0;
                const editing = editingCampaignId === c.id;
                return (
                  <div key={c.id} className="rounded-xl border border-slate-200/80 p-4 dark:border-white/[0.08]">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-semibold text-slate-900 dark:text-white">{c.name}</span>
                          <span
                            className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                              c.lifecycleStatus === 'active'
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                                : c.lifecycleStatus === 'exhausted'
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
                                : 'bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400'
                            }`}
                          >
                            {c.lifecycleStatus}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {c.programName} · {c.channel.replace('_', ' ')} ·{' '}
                          <span className="font-mono font-bold">{c.trackingCode}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {formatCurrency(c.generatedRevenue, currency)}
                        </div>
                        <div className="text-[10px] text-slate-400">generated</div>
                      </div>
                    </div>

                    {/* Rates summary */}
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-white/[0.06]">
                        Referrer {c.referrerRewardType === 'percent_commission' ? `${c.referrerRewardValue ?? '—'}%` : c.referrerRewardValue != null ? formatCurrency(c.referrerRewardValue, currency) : 'unconfigured'}
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-white/[0.06]">
                        Referee {c.refereeDiscountType === 'percent' ? `${c.refereeDiscountValue ?? '—'}%` : c.refereeDiscountValue != null ? formatCurrency(c.refereeDiscountValue, currency) : 'unconfigured'}
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-white/[0.06]">
                        Cap {c.maxReferrerRewardPerOrder != null ? formatCurrency(c.maxReferrerRewardPerOrder, currency) : '—'}
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-white/[0.06]">
                        Approval ≥ {c.rewardApprovalThreshold != null ? formatCurrency(c.rewardApprovalThreshold, currency) : '—'}
                      </span>
                    </div>

                    {/* Budget bar */}
                    <div className="mt-3">
                      <div className="mb-1 flex justify-between text-[11px] text-slate-500">
                        <span>
                          Budget {formatCurrency(c.budgetAmount, currency)} · reserved {formatCurrency(c.budgetReserved, currency)} · qualified {formatCurrency(c.budgetQualified, currency)}
                        </span>
                        <span className="font-mono tabular-nums">remaining {formatCurrency(remaining, currency)}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]">
                        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${usedPct}%` }} />
                      </div>
                    </div>

                    {/* Approval status */}
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
                      <span className={c.financeApprovedAt ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}>
                        Finance {c.financeApprovedAt ? '✓' : 'pending'}
                      </span>
                      <span className={c.managementApprovedAt ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}>
                        Management {c.managementApprovedAt ? '✓' : 'pending'}
                      </span>
                      {budgetInfo[c.id] && (
                        <span className={budgetInfo[c.id].discrepancy ? 'text-rose-500' : 'text-slate-400'}>
                          {budgetInfo[c.id].discrepancy ? 'Budget discrepancy!' : 'Budget reconciled'}
                        </span>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <button type="button" onClick={() => (editing ? setEditingCampaignId(null) : openCampaignEditor(c))} className="btn btn-secondary py-1 text-xs">
                        <Settings2 className="h-3 w-3" />
                        {editing ? 'Close' : 'Manage'}
                      </button>
                      <button type="button" onClick={() => handleFinanceApprove(c.id)} disabled={busyKey === `fin-${c.id}`} className="btn btn-secondary py-1 text-xs">
                        Finance Approve
                      </button>
                      <button type="button" onClick={() => handleManagementApprove(c.id)} disabled={busyKey === `mgmt-${c.id}`} className="btn btn-secondary py-1 text-xs">
                        Mgmt Approve
                      </button>
                      <button type="button" onClick={() => handleActivate(c.id)} disabled={busyKey === `act-${c.id}` || c.lifecycleStatus === 'active'} className="btn btn-emerald py-1 text-xs">
                        <BadgeCheck className="h-3 w-3" />
                        Activate
                      </button>
                      {c.lifecycleStatus === 'active' && (
                        <button type="button" onClick={() => handleLifecycle(c.id, 'suspended')} className="btn btn-secondary py-1 text-xs">
                          Suspend
                        </button>
                      )}
                      <button type="button" onClick={() => handleReconcile(c.id)} disabled={busyKey === `rec-${c.id}`} className="btn btn-secondary py-1 text-xs">
                        Reconcile
                      </button>
                    </div>

                    {editing && (
                      <form onSubmit={handleSaveCampaignConfig} className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                        <FormField label="Referrer Reward Type">
                          <select className="app-input" value={campForm.referrerRewardType} onChange={e => setCampForm(f => ({ ...f, referrerRewardType: e.target.value }))}>
                            <option value="percent_commission">% Commission</option>
                            <option value="fixed_credit">Fixed Credit</option>
                            <option value="cash_payout">Fixed Cash Payout</option>
                          </select>
                        </FormField>
                        <FormField label="Referrer Reward Value">
                          <input type="number" min="0" step="0.01" className="app-input app-input-mono" value={campForm.referrerRewardValue} onChange={e => setCampForm(f => ({ ...f, referrerRewardValue: e.target.value }))} />
                        </FormField>
                        <FormField label="Referee Discount Type">
                          <select className="app-input" value={campForm.refereeDiscountType} onChange={e => setCampForm(f => ({ ...f, refereeDiscountType: e.target.value }))}>
                            <option value="percent">% Off</option>
                            <option value="fixed_amount">Fixed Amount</option>
                          </select>
                        </FormField>
                        <FormField label="Referee Discount Value">
                          <input type="number" min="0" step="0.01" className="app-input app-input-mono" value={campForm.refereeDiscountValue} onChange={e => setCampForm(f => ({ ...f, refereeDiscountValue: e.target.value }))} />
                        </FormField>
                        <FormField label={`Max Reward / Order (${currency})`}>
                          <input type="number" min="0" step="0.01" className="app-input app-input-mono" value={campForm.maxReferrerRewardPerOrder} onChange={e => setCampForm(f => ({ ...f, maxReferrerRewardPerOrder: e.target.value }))} />
                        </FormField>
                        <FormField label={`Max Discount / Order (${currency})`}>
                          <input type="number" min="0" step="0.01" className="app-input app-input-mono" value={campForm.maxRefereeDiscountPerOrder} onChange={e => setCampForm(f => ({ ...f, maxRefereeDiscountPerOrder: e.target.value }))} />
                        </FormField>
                        <FormField label={`Reward Approval Threshold (${currency})`}>
                          <input type="number" min="0" step="0.01" className="app-input app-input-mono" value={campForm.rewardApprovalThreshold} onChange={e => setCampForm(f => ({ ...f, rewardApprovalThreshold: e.target.value }))} />
                        </FormField>
                        <FormField label={`Campaign Budget (${currency})`}>
                          <input type="number" min="0" step="0.01" className="app-input app-input-mono" value={campForm.budgetAmount} onChange={e => setCampForm(f => ({ ...f, budgetAmount: e.target.value }))} />
                        </FormField>
                        <FormField label="Eligible Item Types (comma-separated)" className="col-span-2">
                          <input type="text" className="app-input" value={campForm.eligibleItemTypes} onChange={e => setCampForm(f => ({ ...f, eligibleItemTypes: e.target.value }))} placeholder="stationery, printing_service" />
                        </FormField>
                        <FormField label="Starts At">
                          <input type="date" className="app-input" value={campForm.startsAt} onChange={e => setCampForm(f => ({ ...f, startsAt: e.target.value }))} />
                        </FormField>
                        <FormField label="Ends At">
                          <input type="date" className="app-input" value={campForm.endsAt} onChange={e => setCampForm(f => ({ ...f, endsAt: e.target.value }))} />
                        </FormField>
                        <div className="col-span-2 flex gap-2">
                          <button type="submit" disabled={busyKey === `cfg-${c.id}`} className="btn btn-primary py-1.5 text-xs">
                            Save Configuration
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      )}

      {/* 3. PROGRAMS */}
      {subTab === 'programs' && (
        <Panel
          title="Referral Programs"
          description="Programs are containers. Financial terms are configured per campaign; programs map default GL accounts."
          actions={
            <button type="button" onClick={() => setShowProgramForm(v => !v)} className="btn btn-primary">
              <Plus className="h-3.5 w-3.5" />
              New Referral Program
            </button>
          }
        >
          {showProgramForm && (
            <form
              onSubmit={handleCreateProgram}
              className="mb-5 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 md:grid-cols-3 dark:border-white/10 dark:bg-white/[0.03]"
            >
              <FormField label="Program Name" required>
                <input type="text" className="app-input" value={progName} onChange={e => setProgName(e.target.value)} placeholder="e.g. Stationer Partner Club" required />
              </FormField>
              <FormField label="Advocate Reward Type">
                <select className="app-input" value={rewardType} onChange={e => setRewardType(e.target.value as any)}>
                  <option value="percent_commission">% Commission of Order</option>
                  <option value="fixed_credit">Fixed Store Credit</option>
                  <option value="cash_payout">Fixed Cash Payout</option>
                </select>
              </FormField>
              <FormField label={rewardType === 'percent_commission' ? 'Reward %' : `Reward Amount (${currency})`} required>
                <input type="number" min="0" step="0.01" className="app-input app-input-mono" value={rewardVal} onChange={e => setRewardVal(e.target.value)} required />
              </FormField>
              <FormField label="New Customer Discount Type">
                <select className="app-input" value={refereeType} onChange={e => setRefereeType(e.target.value as any)}>
                  <option value="percent">% Off Order</option>
                  <option value="fixed_amount">Fixed Amount Off</option>
                </select>
              </FormField>
              <FormField label={refereeType === 'percent' ? 'Referee Discount %' : `Discount (${currency})`}>
                <input type="number" min="0" step="0.01" className="app-input app-input-mono" value={refereeVal} onChange={e => setRefereeVal(e.target.value)} />
              </FormField>
              <FormField label={`Min Qualifying Spend (${currency})`}>
                <input type="number" min="0" step="0.01" className="app-input app-input-mono" value={minSpend} onChange={e => setMinSpend(e.target.value)} />
              </FormField>
              <FormField label="Description" className="md:col-span-3">
                <input type="text" className="app-input" value={progDesc} onChange={e => setProgDesc(e.target.value)} placeholder="Terms and qualifying conditions..." />
              </FormField>
              <div className="flex gap-2 md:col-span-3">
                <button type="submit" disabled={busyKey === 'create-prog'} className="btn btn-primary">
                  Create Program
                </button>
                <button type="button" onClick={() => setShowProgramForm(false)} className="btn btn-secondary">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {programs.length === 0 ? (
            <EmptyState
              title="No referral programs configured"
              description="Create a referral program to group campaigns and map default GL accounts."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Program</th>
                    <th>Advocate Reward</th>
                    <th>New Customer Discount</th>
                    <th>GL Expense / Liability</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {programs.map(p => (
                    <tr key={p.id}>
                      <td>
                        <div className="font-semibold text-slate-900 dark:text-white">{p.name}</div>
                        <div className="text-[11px] text-slate-500">Min spend: {formatCurrency(p.minQualifyingSpend, currency)}</div>
                      </td>
                      <td className="font-mono text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                        {p.referrerRewardType === 'percent_commission' ? `${p.referrerRewardValue}% commission` : formatCurrency(p.referrerRewardValue, currency)}
                      </td>
                      <td className="font-mono text-xs font-semibold tabular-nums">
                        {p.refereeDiscountType === 'percent' ? `${p.refereeDiscountValue}% off` : formatCurrency(p.refereeDiscountValue, currency)}
                      </td>
                      <td className="text-xs text-slate-500">
                        Dr {p.rewardExpenseAccountLabel || '6450'} / Cr {p.rewardLiabilityAccountLabel || '2150'}
                      </td>
                      <td>
                        <button
                          type="button"
                          disabled={busyKey === `prog-${p.id}`}
                          onClick={() => handleToggleProgram(p.id, p.isActive)}
                          className={`text-xs font-bold ${p.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}
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
      )}

      {/* 4. ATTRIBUTIONS */}
      {subTab === 'attributions' && (
        <Panel
          title="Referral Attribution Records"
          description="First-valid attribution is locked per customer. Acquisition method is recorded as link, code or verbal."
        >
          {attributions.length === 0 ? (
            <EmptyState
              title="No attributions recorded"
              description="Verbal referrals captured during customer creation and link/code referrals appear here."
              icon={<Users className="h-6 w-6" />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Referred Customer</th>
                    <th>Referring Customer</th>
                    <th>Method</th>
                    <th>Source</th>
                    <th>Valid Until</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {attributions.map(a => (
                    <tr key={a.id}>
                      <td className="font-semibold text-slate-900 dark:text-white">{a.customer_name || `#${a.customer_id}`}</td>
                      <td className="text-xs text-slate-600 dark:text-slate-300">{a.referrer_name || `#${a.referrer_customer_id}`}</td>
                      <td>
                        <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                          {a.method}
                        </span>
                      </td>
                      <td className="text-[11px] text-slate-500">{a.source_context || '—'}</td>
                      <td className="font-mono text-[11px] text-slate-500">
                        {a.valid_until ? new Date(a.valid_until).toLocaleDateString() : '—'}
                      </td>
                      <td className="text-xs capitalize text-slate-600 dark:text-slate-300">{a.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {/* 5. FRAUD & DISPUTES */}
      {subTab === 'governance' && (
        <div className="space-y-6">
          <Panel
            title="Fraud & Dispute Cases"
            description="Identity matches are flagged for review, never auto-confirmed. Confirmed fraud is case-by-case; disputed decisions may be independently reviewed."
            actions={
              <button type="button" onClick={() => setShowCaseForm(v => !v)} className="btn btn-secondary">
                <AlertTriangle className="h-3.5 w-3.5" />
                Open Case
              </button>
            }
          >
            {showCaseForm && (
              <form
                onSubmit={handleOpenCase}
                className="mb-5 grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 md:grid-cols-3 dark:border-white/10 dark:bg-white/[0.03]"
              >
                <FormField label="Referral Event (optional)">
                  <select className="app-input" value={caseEventId} onChange={e => setCaseEventId(e.target.value)}>
                    <option value="">General / Attribution</option>
                    {events.map(ev => (
                      <option key={ev.id} value={ev.id}>
                        #{ev.id} — {ev.referralCode} ({ev.status})
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Reason" className="md:col-span-2">
                  <input
                    type="text"
                    className="app-input"
                    value={caseReason}
                    onChange={e => setCaseReason(e.target.value)}
                    placeholder="Suspicious pattern, possible self-referral, duplicate referee…"
                  />
                </FormField>
                <div className="flex gap-2 md:col-span-3">
                  <button type="submit" disabled={busyKey === 'open-case'} className="btn btn-primary">
                    Open Case & Hold
                  </button>
                  <button type="button" onClick={() => setShowCaseForm(false)} className="btn btn-secondary">
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {cases.length === 0 ? (
              <EmptyState
                title="No fraud or dispute cases"
                description="Suspicious referrals flagged for review appear here."
                icon={<ShieldAlert className="h-6 w-6" />}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Case</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Event</th>
                      <th>Reason</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cases.map(c => (
                      <tr key={c.id}>
                        <td className="font-mono text-xs font-semibold">#{c.id}</td>
                        <td className="text-xs capitalize text-slate-600 dark:text-slate-300">{c.case_type.replace('_', ' ')}</td>
                        <td>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                              c.status === 'confirmed'
                                ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
                                : c.status === 'dismissed' || c.status === 'resolved'
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                                : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
                            }`}
                          >
                            {c.status}
                          </span>
                        </td>
                        <td className="font-mono text-[11px] text-slate-500">{c.referral_event_id ? `#${c.referral_event_id}` : '—'}</td>
                        <td className="max-w-[220px] truncate text-[11px] text-slate-500" title={c.decision_reason || ''}>
                          {c.decision_reason || '—'}
                        </td>
                        <td className="text-right">
                          {(c.status === 'open' || c.status === 'under_review') && (
                            <button type="button" disabled={busyKey === `dec-${c.id}`} onClick={() => handleDecideCase(c)} className="btn btn-secondary py-1 text-xs">
                              Decide
                            </button>
                          )}
                          {(c.status === 'confirmed' || c.status === 'dismissed') && (
                            <button type="button" disabled={busyKey === `rev-${c.id}`} onClick={() => handleReviewCase(c)} className="btn btn-secondary py-1 text-xs">
                              <Wallet className="h-3 w-3" />
                              Review
                            </button>
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
    </div>
  );
};