import { emitAccountingUpdated } from './accountingApi';
import { requestJson } from './http';

export interface SmartOpsOverview {
  promotions: {
    activeCount: number;
    totalRedemptions: number;
    totalDiscount: number;
  };
  referrals: {
    activePrograms: number;
    activeCodes: number;
    conversions: number;
    referredRevenue: number;
    rewardsPending: number;
    rewardsSettled: number;
  };
  marketing: {
    campaignsCount: number;
    messagesSent: number;
    activeRules: number;
    totalSpend: number;
  };
  pos: {
    ordersCount: number;
    posRevenue: number;
    posDiscounts: number;
    todaySales: number;
  };
  priceCards: {
    presetsCount: number;
  };
  linkedAccounts: Array<{
    id: number;
    code: string;
    name: string;
    accountType: string;
    balance: number;
  }>;
}

export interface ApiPromotion {
  id: number;
  code: string;
  name: string;
  description: string;
  discountType: 'percent' | 'fixed_amount' | 'bogo' | 'bundle';
  discountValue: number;
  minOrderAmount: number;
  maxDiscountAmount: number | null;
  applicableItemType: string;
  applicableItemId: number | null;
  applicableItemName: string | null;
  discountAccountId: number | null;
  discountAccountLabel: string;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  usageCount: number;
  promoBudget: number;
  showOnPriceCard: boolean;
  isActive: boolean;
  totalDiscountGiven: number;
  influencedRevenue: number;
  createdAt: string;
}

export interface ApiPromotionRedemption {
  id: number;
  promotionId: number;
  promoCode: string;
  promoName: string;
  customerId: number;
  customerName: string;
  posOrderId: number | null;
  invoiceId: number | null;
  discountAmount: number;
  orderSubtotal: number;
  redeemedAt: string;
}

export interface ApiReferralWorkspace {
  programs: Array<{
    id: number;
    name: string;
    description: string;
    referrerRewardType: 'fixed_credit' | 'percent_commission' | 'cash_payout';
    referrerRewardValue: number;
    refereeDiscountType: 'percent' | 'fixed_amount';
    refereeDiscountValue: number;
    minQualifyingSpend: number;
    rewardExpenseAccountId: number | null;
    rewardExpenseAccountLabel: string;
    rewardLiabilityAccountId: number | null;
    rewardLiabilityAccountLabel: string;
    startsAt: string | null;
    endsAt: string | null;
    isActive: boolean;
  }>;
  campaigns: Array<{
    id: number;
    programId: number;
    programName: string;
    name: string;
    channel: 'whatsapp' | 'print_qr' | 'walk_in' | 'email' | 'social';
    trackingCode: string;
    targetReferrals: number;
    actualReferrals: number;
    budgetAmount: number;
    generatedRevenue: number;
    status: string;
  }>;
  codes: Array<{
    id: number;
    programId: number;
    programName: string;
    campaignId: number | null;
    campaignName: string | null;
    referrerCustomerId: number | null;
    referrerName: string;
    referrerPhone: string;
    code: string;
    clicksCount: number;
    conversionsCount: number;
    totalReferredRevenue: number;
    totalRewardsEarned: number;
    rewardBalance: number;
    isActive: boolean;
  }>;
  events: Array<{
    id: number;
    referralCodeId: number;
    referralCode: string;
    referrerName: string;
    referrerCustomerId: number | null;
    programId: number;
    programName: string;
    refereeCustomerId: number | null;
    refereeName: string;
    posOrderId: number | null;
    receiptNumber: string | null;
    qualifyingAmount: number;
    refereeDiscount: number;
    rewardAmount: number;
    status: 'pending' | 'approved' | 'credited' | 'paid' | 'voided';
    payoutMethod: string | null;
    payoutAccountLabel: string | null;
    creditMemoId: number | null;
    accrualJournalTxnId: number | null;
    payoutJournalTxnId: number | null;
    notes: string;
    createdAt: string;
    paidAt: string | null;
  }>;
  analytics: {
    totalClicks: number;
    totalConversions: number;
    conversionRate: number;
    totalRevenue: number;
    totalDiscounts: number;
    totalRewardsAccrued: number;
    pendingLiability: number;
    settledRewards: number;
    roiMultiple: number;
  };
}

export interface ApiMarketingWorkspace {
  templates: Array<{
    id: number;
    name: string;
    category: 'promotion' | 'receipt' | 'referral' | 'reminder' | 'announcement' | 'reorder';
    channel: 'whatsapp' | 'sms' | 'email';
    body: string;
    promoId: number | null;
    promoCode: string | null;
    isActive: boolean;
  }>;
  automationRules: Array<{
    id: number;
    name: string;
    triggerEvent: 'post_pos_receipt' | 'invoice_overdue' | 'referral_invite' | 'promo_drop' | 'inactive_customer';
    templateId: number;
    templateName: string;
    templateBody: string;
    delayHours: number;
    targetSegment: string;
    isEnabled: boolean;
    runsCount: number;
    lastRunAt: string | null;
  }>;
  campaigns: Array<{
    id: number;
    name: string;
    channel: 'whatsapp' | 'sms' | 'email';
    audienceSegment: string;
    templateId: number | null;
    messageBody: string;
    promoId: number | null;
    promoCode: string | null;
    status: string;
    recipientCount: number;
    sentCount: number;
    budgetAmount: number;
    actualSpend: number;
    expenseAccountLabel: string | null;
    paymentAccountLabel: string | null;
    expenseJournalTxnId: number | null;
    dispatchedAt: string | null;
    createdAt: string;
  }>;
  messages: Array<{
    id: number;
    campaignId: number | null;
    campaignName: string | null;
    ruleId: number | null;
    ruleName: string | null;
    customerId: number | null;
    recipientName: string;
    recipientPhone: string;
    channel: 'whatsapp' | 'sms' | 'email';
    renderedBody: string;
    whatsappUrl: string | null;
    status: 'queued' | 'sent' | 'delivered' | 'clicked' | 'failed';
    posOrderId: number | null;
    sentAt: string | null;
    createdAt: string;
  }>;
}

export interface ApiPriceCardWorkspace {
  company: {
    name: string;
    phone: string | null;
    email: string | null;
    website: string | null;
    address: string | null;
    city_state_zip: string | null;
    currency_symbol: string;
    base_currency: string;
  };
  items: Array<{
    id: number;
    sku: string;
    name: string;
    itemType: string;
    description: string;
    salesPrice: number;
    onHand: number;
    unitLabel: string;
    isTaxable: boolean;
    variants: Array<{
      id: number;
      variantName: string;
      sku: string;
      salesPrice: number;
      onHand: number;
    }>;
  }>;
  promotions: Array<{
    id: number;
    code: string;
    name: string;
    discountType: string;
    discountValue: number;
    endsAt: string | null;
  }>;
  presets: Array<{
    id: number;
    title: string;
    subtitle: string;
    theme: string;
    headline: string;
    whatsappNumber: string;
    validUntil: string | null;
    itemIds: number[];
    promoId: number | null;
    showVariants: boolean;
  }>;
}

export interface ApiPosCatalog {
  company: {
    name: string;
    phone: string;
    currencySymbol: string;
    baseCurrency: string;
    defaultTaxRate: number;
  };
  items: Array<{
    id: number;
    sku: string;
    name: string;
    itemType: 'stationery' | 'printed_product' | 'printing_service';
    description: string;
    unitCost: number;
    salesPrice: number;
    availableQty: number | null;
    unitLabel: string;
    isTaxable: boolean;
    incomeAccountId: number;
    variants: Array<{
      id: number;
      variantName: string;
      sku: string;
      unitCost: number;
      salesPrice: number;
      onHand: number;
    }>;
  }>;
  customers: Array<{
    id: number;
    customerType: string;
    name: string;
    companyName: string;
    phone: string;
    email: string;
    terms: string;
    creditLimit: number | null;
    balance: number;
    isTaxExempt: boolean;
  }>;
  depositAccounts: Array<{
    id: number;
    code: string;
    name: string;
    accountType: string;
    balance: number;
  }>;
  activePromotions: Array<{
    id: number;
    code: string;
    name: string;
    discountType: string;
    discountValue: number;
    minOrderAmount: number;
    maxDiscountAmount: number | null;
  }>;
  activeReferralCodes: Array<{
    id: number;
    code: string;
    referrerName: string;
    refereeDiscountType: string;
    refereeDiscountValue: number;
  }>;
  recentOrders: Array<{
    id: number;
    receiptNumber: string;
    invoiceId: number;
    invoiceNumber: string;
    customerId: number;
    customerName: string;
    customerPhone: string;
    orderDate: string;
    grossSubtotal: number;
    promoCode: string | null;
    promoDiscount: number;
    referralDiscount: number;
    totalDiscount: number;
    netSubtotal: number;
    taxRate: number;
    taxAmount: number;
    total: number;
    tenderMode: string;
    amountTendered: number;
    changeDue: number;
    depositAccountLabel: string | null;
    journalTxnId: number | null;
    status: string;
    notes: string;
    tenders: Array<{
      id: number;
      tenderMethod: string;
      depositAccountId: number;
      accountLabel: string;
      amount: number;
      referenceNumber: string | null;
    }>;
    createdAt: string;
  }>;
}

export const smartOpsApi = {
  getOverview: () => requestJson<SmartOpsOverview>('/api/smart-ops/overview'),

  initializeStarter: async () => {
    const res = await requestJson<{ initialized: boolean }>('/api/smart-ops/initialize-accounts', {
      method: 'POST',
    });
    emitAccountingUpdated();
    return res;
  },

  // Promotions
  listPromotions: () =>
    requestJson<{ promotions: ApiPromotion[]; redemptions: ApiPromotionRedemption[] }>(
      '/api/smart-ops/promotions'
    ),

  createPromotion: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ promotion: ApiPromotion }>('/api/smart-ops/promotions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return res.promotion;
  },

  updatePromotion: async (id: number, payload: Record<string, unknown>) => {
    const res = await requestJson<{ promotion: ApiPromotion }>(`/api/smart-ops/promotions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return res.promotion;
  },

  // Referrals
  getReferrals: () => requestJson<ApiReferralWorkspace>('/api/smart-ops/referrals'),

  createReferralProgram: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ program: any }>('/api/smart-ops/referrals/programs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return res.program;
  },

  toggleReferralProgram: async (id: number, isActive: boolean) => {
    await requestJson(`/api/smart-ops/referrals/programs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  },

  createReferralCampaign: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ campaign: any }>('/api/smart-ops/referrals/campaigns', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res.campaign;
  },

  createReferralCode: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ code: any }>('/api/smart-ops/referrals/codes', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res.code;
  },

  recordManualReferral: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ event: any }>('/api/smart-ops/referrals/events', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return res.event;
  },

  payoutReferral: async (eventId: number, payload: Record<string, unknown>) => {
    const res = await requestJson<{ event: any }>(`/api/smart-ops/referrals/events/${eventId}/payout`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return res.event;
  },

  // Marketing
  getMarketing: () => requestJson<ApiMarketingWorkspace>('/api/smart-ops/marketing'),

  createTemplate: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ template: any }>('/api/smart-ops/marketing/templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res.template;
  },

  createAutomationRule: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ rule: any }>('/api/smart-ops/marketing/rules', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res.rule;
  },

  toggleAutomationRule: (id: number, isEnabled: boolean) =>
    requestJson(`/api/smart-ops/marketing/rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isEnabled }),
    }),

  runAutomationRule: async (id: number) => {
    const res = await requestJson<{ ruleId: number; queuedCount: number }>(
      `/api/smart-ops/marketing/rules/${id}/run`,
      { method: 'POST' }
    );
    return res;
  },

  createCampaign: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ campaign: any }>('/api/smart-ops/marketing/campaigns', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return res.campaign;
  },

  sendDirectMessage: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ message: any }>('/api/smart-ops/marketing/messages', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res.message;
  },

  updateMessageStatus: (id: number, status: string) =>
    requestJson(`/api/smart-ops/marketing/messages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  // Price Cards
  getPriceCards: () => requestJson<ApiPriceCardWorkspace>('/api/smart-ops/price-cards'),

  savePriceCardPreset: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ preset: any }>('/api/smart-ops/price-cards/presets', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res.preset;
  },

  // POS
  getPosCatalog: () => requestJson<ApiPosCatalog>('/api/pos/catalog'),

  previewPos: (payload: Record<string, unknown>) =>
    requestJson<{
      grossSubtotal: number;
      promoApplied: { id: number; code: string; name: string } | null;
      promoDiscount: number;
      referralApplied: { id: number; code: string; referrerName: string; rewardAmount: number } | null;
      referralDiscount: number;
      totalDiscount: number;
      netSubtotal: number;
      taxAmount: number;
      total: number;
    }>('/api/pos/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  checkoutPos: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ order: ApiPosCatalog['recentOrders'][number] }>('/api/pos/checkout', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return res.order;
  },

  voidPosOrder: async (id: number, reason?: string) => {
    const res = await requestJson<{ voided: boolean }>(`/api/pos/orders/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return res;
  },
};
