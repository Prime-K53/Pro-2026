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
    budgetReserved: number;
    budgetQualified: number;
    generatedRevenue: number;
    status: string;
    lifecycleStatus: string;
    referrerRewardType: 'fixed_credit' | 'percent_commission' | 'cash_payout' | null;
    referrerRewardValue: number | null;
    refereeDiscountType: 'percent' | 'fixed_amount' | null;
    refereeDiscountValue: number | null;
    maxReferrerRewardPerOrder: number | null;
    maxRefereeDiscountPerOrder: number | null;
    rewardApprovalThreshold: number | null;
    attributionWindowDays: number;
    eligibleItemTypes: string[] | null;
    eligibleItemIds: number[] | null;
    startsAt: string | null;
    endsAt: string | null;
    financeApprovedAt: string | null;
    managementApprovedAt: string | null;
    activatedAt: string | null;
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
    status: 'pending' | 'approved' | 'credited' | 'paid' | 'voided' | 'reversed';
    payoutMethod: string | null;
    payoutAccountLabel: string | null;
    creditMemoId: number | null;
    accrualJournalTxnId: number | null;
    payoutJournalTxnId: number | null;
    walletTxnId: number | null;
    attributionId: number | null;
    reversalOfId: number | null;
    reservationId: number | null;
    approvalRequestId: number | null;
    fraudHold: boolean;
    notes: string;
    createdAt: string;
    paidAt: string | null;
    rewardedAt: string | null;
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

export interface ApiReferralAttribution {
  id: number;
  company_id: number;
  customer_id: number;
  customer_name: string | null;
  referrer_customer_id: number;
  referrer_name: string | null;
  program_id: number;
  campaign_id: number | null;
  referral_code_id: number | null;
  method: 'link' | 'code' | 'verbal';
  status: string;
  source_context: string | null;
  attributed_at: string;
  attributed_by: number | null;
  valid_until: string | null;
  locked: boolean;
  terms_snapshot: unknown;
  created_at: string;
}

export interface ApiReferralCase {
  id: number;
  company_id: number;
  case_type: 'fraud' | 'dispute' | 'exception' | 'eligibility_exception' | 'attribution_change';
  status: 'open' | 'under_review' | 'confirmed' | 'dismissed' | 'resolved';
  attribution_id: number | null;
  referral_event_id: number | null;
  pos_order_id: number | null;
  evidence: unknown;
  decision_reason: string | null;
  decided_by: number | null;
  reviewer_id: number | null;
  created_by: number | null;
  created_at: string;
  decided_at: string | null;
  updated_at: string;
}

export interface ApiBudgetReconciliation {
  campaignId: number;
  budgetAmount: number;
  reservedLedger: number;
  qualifiedLedger: number;
  reservedComputed: number;
  qualifiedComputed: number;
  discrepancy: boolean;
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
    barcode: string | null;
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

  // Referral configuration, activation & governance
  configureReferralCampaign: async (id: number, payload: Record<string, unknown>) => {
    const res = await requestJson<{ terms: any }>(`/api/smart-ops/referrals/campaigns/${id}/config`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return res.terms;
  },

  financeApproveCampaign: (id: number, note?: string) =>
    requestJson(`/api/smart-ops/referrals/campaigns/${id}/finance-approval`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  managementApproveCampaign: (id: number, note?: string) =>
    requestJson(`/api/smart-ops/referrals/campaigns/${id}/management-approval`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  activateReferralCampaign: async (id: number) => {
    const res = await requestJson<{ terms: any }>(`/api/smart-ops/referrals/campaigns/${id}/activate`, {
      method: 'POST',
      body: '{}',
    });
    emitAccountingUpdated();
    return res.terms;
  },

  setCampaignLifecycle: (id: number, lifecycleStatus: string, reason?: string) =>
    requestJson(`/api/smart-ops/referrals/campaigns/${id}/lifecycle`, {
      method: 'POST',
      body: JSON.stringify({ lifecycleStatus, reason }),
    }),

  getCampaignBudget: (id: number) =>
    requestJson<ApiBudgetReconciliation>(`/api/smart-ops/referrals/campaigns/${id}/budget`),

  getReferralAttributions: () =>
    requestJson<{ attributions: ApiReferralAttribution[] }>('/api/smart-ops/referrals/attributions'),

  getReferralCases: () =>
    requestJson<{ cases: ApiReferralCase[] }>('/api/smart-ops/referrals/cases'),

  qualifyReferralEvent: async (id: number, deliveryEvidence?: Record<string, unknown> | null) => {
    const res = await requestJson<{ qualified: any; credit: any }>(
      `/api/smart-ops/referrals/events/${id}/qualify`,
      { method: 'POST', body: JSON.stringify({ deliveryEvidence: deliveryEvidence ?? null }) }
    );
    emitAccountingUpdated();
    return res;
  },

  creditReferralReward: async (id: number) => {
    const res = await requestJson<{ status: string; walletTxnId: number | null; journalTxnId: number | null }>(
      `/api/smart-ops/referrals/events/${id}/credit`,
      { method: 'POST', body: '{}' }
    );
    emitAccountingUpdated();
    return res;
  },

  reverseReferralReward: async (id: number, reason?: string, amount?: number | null) => {
    const res = await requestJson<{ reversalAmount: number; negativeBalance: number }>(
      `/api/smart-ops/referrals/events/${id}/reverse`,
      { method: 'POST', body: JSON.stringify({ reason, amount: amount ?? null }) }
    );
    emitAccountingUpdated();
    return res;
  },

  openReferralCase: async (payload: Record<string, unknown>) => {
    const res = await requestJson<{ caseId: number }>('/api/smart-ops/referrals/cases', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res;
  },

  decideReferralCase: (id: number, payload: Record<string, unknown>) =>
    requestJson(`/api/smart-ops/referrals/cases/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  reviewReferralCase: (id: number, payload: Record<string, unknown>) =>
    requestJson(`/api/smart-ops/referrals/cases/${id}/review`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

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

  // POS Shifts
  getCurrentPosShift: () =>
    requestJson<{ shift: ApiPosShift | null }>('/api/pos/shifts/current'),

  listPosShifts: (filters?: { status?: 'open' | 'closed'; cashierId?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.cashierId) params.set('cashierId', String(filters.cashierId));
    if (filters?.limit) params.set('limit', String(filters.limit));
    return requestJson<{ shifts: ApiPosShift[] }>(`/api/pos/shifts${params.size > 0 ? `?${params.toString()}` : ''}`);
  },

  openPosShift: (payload: { openingFloat?: number; notes?: string }) =>
    requestJson<{ shift: ApiPosShift }>('/api/pos/shifts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  closePosShift: async (shiftId: number, payload: { actualCash: number; notes?: string }) => {
    const res = await requestJson<{ shift: ApiPosShift; variance: number; varianceStatus: string }>(
      `/api/pos/shifts/${shiftId}/close`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
    emitAccountingUpdated();
    return res;
  },

  getPosShiftTransactions: (shiftId: number) =>
    requestJson<{ transactions: ApiPosShiftTransaction[] }>(`/api/pos/shifts/${shiftId}/transactions`),

  recordPosCashMovement: (
    shiftId: number,
    payload: { movementType: string; amount: number; reason?: string }
  ) =>
    requestJson<{ movement: ApiPosCashMovement }>(
      `/api/pos/shifts/${shiftId}/cash-movements`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),

  listPosCashMovements: (shiftId: number) =>
    requestJson<{ movements: ApiPosCashMovement[] }>(
      `/api/pos/shifts/${shiftId}/cash-movements`
    ),

  // POS Suspended Sales
  listSuspendedSales: (filters?: { status?: 'suspended' | 'resumed'; shiftId?: number }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.shiftId) params.set('shiftId', String(filters.shiftId));
    return requestJson<{ suspendedSales: ApiPosSuspendedSale[] }>(
      `/api/pos/suspended${params.size > 0 ? `?${params.toString()}` : ''}`
    );
  },

  suspendPosOrder: (orderId: number, payload: { notes?: string; suspendId?: string } = {}) =>
    requestJson<{ suspendedSale: ApiPosSuspendedSale }>(`/api/pos/orders/${orderId}/suspend`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  resumePosOrder: (suspendedSaleId: number) =>
    requestJson<{ suspendedSale: ApiPosSuspendedSale }>(`/api/pos/suspended/${suspendedSaleId}/resume`, {
      method: 'POST',
    }),

  // POS Barcode
  lookupBarcode: (barcode: string) =>
    requestJson<{ found: boolean; item?: ApiPosCatalogItem; error?: string }>('/api/pos/scan', {
      method: 'POST',
      body: JSON.stringify({ barcode }),
    }),
};

// ============================================================================
// POS GOVERNANCE TYPES
// ============================================================================

export interface ApiPosShift {
  id: number;
  cashierId: number;
  cashierName: string;
  openedAt: string;
  closedAt: string | null;
  openingFloat: number;
  closingFloat: number | null;
  cashIn: number;
  cashOut: number;
  expectedCash: number | null;
  actualCash: number | null;
  variance: number | null;
  status: 'open' | 'closed';
  notes: string | null;
  transactionCount: number;
  totalSales: number;
  cashSales: number;
  cardSales: number;
  mobileMoneySales: number;
  otherSales: number;
}

export interface ApiPosShiftTransaction {
  id: number;
  receiptNumber: string;
  amount: number;
  cashAmount: number;
  tenderMode: string;
  status: string;
  createdAt: string;
}

export interface ApiPosCashMovement {
  id: number;
  shiftId: number;
  movementType: 'cash_in' | 'cash_out' | 'paid_in' | 'paid_out' | 'deposit';
  amount: number;
  reason: string | null;
  createdAt: string;
}

export interface ApiPosSuspendedSale {
  id: number;
  shiftId: number;
  posOrderId: number;
  suspendedAt: string;
  resumedAt: string | null;
  status: 'suspended' | 'resumed';
  clientToken?: string | null;
}

export interface ApiPosCatalogItem {
  id: number;
  sku: string;
  name: string;
  itemType: string;
  description: string;
  unitCost: number;
  salesPrice: number;
  availableQty: number | null;
  unitLabel: string;
  isTaxable: boolean;
  incomeAccountId: number;
  barcode: string | null;
  variants: Array<{
    id: number;
    variantName: string;
    sku: string;
    unitCost: number;
    salesPrice: number;
    onHand: number;
  }>;
}
