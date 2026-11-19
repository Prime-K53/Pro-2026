import { Transaction } from '@electric-sql/pglite';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal4, parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import {
  AccountingError,
  ActorContext,
  assertPeriodOpenForDate,
  createAccount,
  JournalLineInput,
  postJournalEntry,
  reverseJournalEntry,
} from './accountingEngine.ts';
import {
  assertIsoDate,
  checkRouteIdempotency,
  divRoundBigInt,
  generateNextDocNumber,
  recalculateCustomerBalance,
  resolveCommercialContext,
  saveRouteIdempotency,
  todayIsoDate,
} from './commercialHelpers.ts';

export interface SmartOpsAccountMap {
  bank1010: number;
  mobileClearing1030: number;
  cashDrawer1050: number;
  ar1100: number;
  inventory1200: number;
  referralPayable2150: number;
  salesTax2200: number;
  revenue4000: number;
  salesDiscounts4100: number;
  cogs5000: number;
  marketingExpense6450: number;
  baseCurrency: string;
}

export async function resolveSmartOpsAccounts(
  tx: Transaction,
  companyId: number,
  actor: ActorContext
): Promise<SmartOpsAccountMap> {
  const base = await resolveCommercialContext(tx, companyId, actor);
  const res = await tx.query<{ id: number; code: string | null }>(
    `SELECT id, code FROM accounts WHERE company_id = $1 AND code IS NOT NULL`,
    [companyId]
  );
  const byCode = new Map<string, number>();
  for (const r of res.rows) {
    if (r.code) byCode.set(r.code, Number(r.id));
  }

  const ensureByCode = async (spec: {
    code: string;
    name: string;
    accountType: any;
    detailType: any;
    description: string;
    isContra?: boolean;
  }): Promise<number> => {
    const hit = byCode.get(spec.code);
    if (hit) return hit;
    const created = await createAccount(tx, companyId, actor, spec);
    byCode.set(spec.code, created.id);
    return created.id;
  };

  const mobileClearing1030 = await ensureByCode({
    code: '1030',
    name: 'Mobile Money & Card Clearing',
    accountType: 'Bank',
    detailType: 'bank',
    description: 'Mobile Money (Airtel/MTN/Zamtel) and POS card settlement bank account',
  });

  // Ensure bank_accounts register row exists for 1030
  await tx.query(
    `INSERT INTO bank_accounts (company_id, gl_account_id, institution_name, account_mask, feed_provider, is_active)
     VALUES ($1, $2, 'Mobile Money & POS Clearing', 'POS-MOMO', 'manual', TRUE)
     ON CONFLICT (company_id, gl_account_id) DO NOTHING`,
    [companyId, mobileClearing1030]
  );

  const cashDrawer1050 = await ensureByCode({
    code: '1050',
    name: 'Undeposited Funds / Cash Drawer',
    accountType: 'OtherCurrentAsset',
    detailType: 'other_current_asset',
    description: 'POS cash drawer and undeposited customer receipts',
  });

  const referralPayable2150 = await ensureByCode({
    code: '2150',
    name: 'Referral Rewards Payable',
    accountType: 'OtherCurrentLiability',
    detailType: 'other_current_liability',
    description: 'Accrued customer & advocate referral rewards awaiting credit or payout',
  });

  const salesDiscounts4100 = await ensureByCode({
    code: '4100',
    name: 'Sales Discounts & Promotions',
    accountType: 'Income',
    detailType: 'income',
    isContra: true,
    description: 'Contra-revenue account for POS promotional discounts and referral referee discounts',
  });

  const marketingExpense6450 = await ensureByCode({
    code: '6450',
    name: 'Marketing & Referral Rewards Expense',
    accountType: 'Expense',
    detailType: 'expense',
    description: 'WhatsApp marketing campaigns, print promos, and referral advocate reward expense',
  });

  return {
    bank1010: base.bank1010,
    mobileClearing1030,
    cashDrawer1050,
    ar1100: base.ar1100,
    inventory1200: base.inventory1200,
    referralPayable2150,
    salesTax2200: base.salesTax2200,
    revenue4000: base.revenue4000,
    salesDiscounts4100,
    cogs5000: base.cogs5000,
    marketingExpense6450,
    baseCurrency: base.baseCurrency,
  };
}

export function buildWhatsAppUrl(phone: string | null | undefined, text: string): string | null {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  const encoded = encodeURIComponent(text);
  if (digits.length >= 7) {
    return `https://wa.me/${digits}?text=${encoded}`;
  }
  return `https://wa.me/?text=${encoded}`;
}

export function interpolateTemplate(
  template: string,
  vars: Record<string, string | number | null | undefined>
): string {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const val = vars[key];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

// ============================================================================
// OVERVIEW & FINANCIAL ACCOUNT BALANCES
// ============================================================================

export async function getSmartOpsOverview(tx: Transaction, companyId: number) {
  const [
    promoStats,
    refStats,
    mktStats,
    posStats,
    priceCardCount,
    glAccts,
  ] = await Promise.all([
    tx.query<{ active_count: string; total_redemptions: string; total_discount: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE is_active = TRUE)::text AS active_count,
         COALESCE(SUM(usage_count), 0)::text AS total_redemptions,
         COALESCE((SELECT SUM(discount_amount) FROM promotion_redemptions WHERE company_id = $1), 0)::NUMERIC(19,4)::text AS total_discount
       FROM promotions WHERE company_id = $1`,
      [companyId]
    ),
    tx.query<{
      active_programs: string;
      active_codes: string;
      conversions: string;
      referred_revenue: string;
      rewards_pending: string;
      rewards_settled: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM referral_programs WHERE company_id = $1 AND is_active = TRUE)::text AS active_programs,
         (SELECT COUNT(*) FROM referral_codes WHERE company_id = $1 AND is_active = TRUE)::text AS active_codes,
         COALESCE((SELECT COUNT(*) FROM referral_events WHERE company_id = $1 AND status <> 'voided'), 0)::text AS conversions,
         COALESCE((SELECT SUM(qualifying_amount) FROM referral_events WHERE company_id = $1 AND status <> 'voided'), 0)::NUMERIC(19,4)::text AS referred_revenue,
         COALESCE((SELECT SUM(reward_amount) FROM referral_events WHERE company_id = $1 AND status IN ('pending', 'approved')), 0)::NUMERIC(19,4)::text AS rewards_pending,
         COALESCE((SELECT SUM(reward_amount) FROM referral_events WHERE company_id = $1 AND status IN ('credited', 'paid')), 0)::NUMERIC(19,4)::text AS rewards_settled`,
      [companyId]
    ),
    tx.query<{
      campaigns_count: string;
      messages_sent: string;
      active_rules: string;
      total_spend: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM marketing_campaigns WHERE company_id = $1)::text AS campaigns_count,
         (SELECT COUNT(*) FROM marketing_messages WHERE company_id = $1)::text AS messages_sent,
         (SELECT COUNT(*) FROM marketing_automation_rules WHERE company_id = $1 AND is_enabled = TRUE)::text AS active_rules,
         COALESCE((SELECT SUM(actual_spend) FROM marketing_campaigns WHERE company_id = $1), 0)::NUMERIC(19,4)::text AS total_spend`,
      [companyId]
    ),
    tx.query<{
      orders_count: string;
      pos_revenue: string;
      pos_discounts: string;
      today_sales: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status <> 'voided')::text AS orders_count,
         COALESCE(SUM(total) FILTER (WHERE status <> 'voided'), 0)::NUMERIC(19,4)::text AS pos_revenue,
         COALESCE(SUM(total_discount) FILTER (WHERE status <> 'voided'), 0)::NUMERIC(19,4)::text AS pos_discounts,
         COALESCE(SUM(total) FILTER (WHERE status <> 'voided' AND order_date = CURRENT_DATE), 0)::NUMERIC(19,4)::text AS today_sales
       FROM pos_orders WHERE company_id = $1`,
      [companyId]
    ),
    tx.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM price_card_presets WHERE company_id = $1`,
      [companyId]
    ),
    tx.query<{ id: number; code: string; name: string; account_type: string; balance: string }>(
      `SELECT id, code, name, account_type, balance::text
         FROM accounts
        WHERE company_id = $1 AND code IN ('1010', '1030', '1050', '1100', '2150', '4000', '4100', '6450')
        ORDER BY code ASC`,
      [companyId]
    ),
  ]);

  return {
    promotions: {
      activeCount: Number(promoStats.rows[0].active_count),
      totalRedemptions: Number(promoStats.rows[0].total_redemptions),
      totalDiscount: toMoneyNumber(parseDecimal4(promoStats.rows[0].total_discount)),
    },
    referrals: {
      activePrograms: Number(refStats.rows[0].active_programs),
      activeCodes: Number(refStats.rows[0].active_codes),
      conversions: Number(refStats.rows[0].conversions),
      referredRevenue: toMoneyNumber(parseDecimal4(refStats.rows[0].referred_revenue)),
      rewardsPending: toMoneyNumber(parseDecimal4(refStats.rows[0].rewards_pending)),
      rewardsSettled: toMoneyNumber(parseDecimal4(refStats.rows[0].rewards_settled)),
    },
    marketing: {
      campaignsCount: Number(mktStats.rows[0].campaigns_count),
      messagesSent: Number(mktStats.rows[0].messages_sent),
      activeRules: Number(mktStats.rows[0].active_rules),
      totalSpend: toMoneyNumber(parseDecimal4(mktStats.rows[0].total_spend)),
    },
    pos: {
      ordersCount: Number(posStats.rows[0].orders_count),
      posRevenue: toMoneyNumber(parseDecimal4(posStats.rows[0].pos_revenue)),
      posDiscounts: toMoneyNumber(parseDecimal4(posStats.rows[0].pos_discounts)),
      todaySales: toMoneyNumber(parseDecimal4(posStats.rows[0].today_sales)),
    },
    priceCards: {
      presetsCount: Number(priceCardCount.rows[0].cnt),
    },
    linkedAccounts: glAccts.rows.map(a => ({
      id: Number(a.id),
      code: a.code,
      name: a.name,
      accountType: a.account_type,
      balance: toMoneyNumber(parseDecimal4(a.balance)),
    })),
  };
}

// ============================================================================
// PROMOTIONS ENGINE
// ============================================================================

export async function listPromotions(tx: Transaction, companyId: number) {
  const res = await tx.query<any>(
    `SELECT p.*, a.code AS discount_account_code, a.name AS discount_account_name,
            it.name AS applicable_item_name,
            COALESCE((SELECT SUM(pr.discount_amount) FROM promotion_redemptions pr WHERE pr.company_id = p.company_id AND pr.promotion_id = p.id), 0)::NUMERIC(19,4)::text AS total_discount_given,
            COALESCE((SELECT SUM(pr.order_subtotal) FROM promotion_redemptions pr WHERE pr.company_id = p.company_id AND pr.promotion_id = p.id), 0)::NUMERIC(19,4)::text AS influenced_revenue
       FROM promotions p
       LEFT JOIN accounts a ON a.company_id = p.company_id AND a.id = p.discount_account_id
       LEFT JOIN inventory_items it ON it.company_id = p.company_id AND it.id = p.applicable_item_id
      WHERE p.company_id = $1
      ORDER BY p.is_active DESC, p.created_at DESC, p.id DESC`,
    [companyId]
  );

  const redRes = await tx.query<any>(
    `SELECT pr.id, pr.promotion_id, p.code AS promo_code, p.name AS promo_name,
            pr.customer_id, c.company_name AS customer_name, pr.pos_order_id, pr.invoice_id,
            pr.discount_amount::text, pr.order_subtotal::text, pr.redeemed_at::text
       FROM promotion_redemptions pr
       JOIN promotions p ON p.company_id = pr.company_id AND p.id = pr.promotion_id
       JOIN customers c ON c.company_id = pr.company_id AND c.id = pr.customer_id
      WHERE pr.company_id = $1
      ORDER BY pr.redeemed_at DESC
      LIMIT 40`,
    [companyId]
  );

  const promotions = res.rows.map(r => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    description: r.description || '',
    discountType: r.discount_type,
    discountValue: toMoneyNumber(parseDecimal4(r.discount_value)),
    minOrderAmount: toMoneyNumber(parseDecimal4(r.min_order_amount)),
    maxDiscountAmount: r.max_discount_amount !== null ? toMoneyNumber(parseDecimal4(r.max_discount_amount)) : null,
    applicableItemType: r.applicable_item_type || 'all',
    applicableItemId: r.applicable_item_id !== null ? Number(r.applicable_item_id) : null,
    applicableItemName: r.applicable_item_name || null,
    discountAccountId: r.discount_account_id !== null ? Number(r.discount_account_id) : null,
    discountAccountLabel: r.discount_account_code ? `${r.discount_account_code} ${r.discount_account_name}` : '4100 Sales Discounts & Promotions',
    startsAt: r.starts_at ? String(r.starts_at).slice(0, 10) : null,
    endsAt: r.ends_at ? String(r.ends_at).slice(0, 10) : null,
    usageLimit: r.usage_limit !== null ? Number(r.usage_limit) : null,
    usageCount: Number(r.usage_count),
    promoBudget: toMoneyNumber(parseDecimal4(r.promo_budget)),
    showOnPriceCard: Boolean(r.show_on_price_card),
    isActive: Boolean(r.is_active),
    totalDiscountGiven: toMoneyNumber(parseDecimal4(r.total_discount_given)),
    influencedRevenue: toMoneyNumber(parseDecimal4(r.influenced_revenue)),
    createdAt: r.created_at,
  }));

  const redemptions = redRes.rows.map(r => ({
    id: Number(r.id),
    promotionId: Number(r.promotion_id),
    promoCode: r.promo_code,
    promoName: r.promo_name,
    customerId: Number(r.customer_id),
    customerName: r.customer_name,
    posOrderId: r.pos_order_id !== null ? Number(r.pos_order_id) : null,
    invoiceId: r.invoice_id !== null ? Number(r.invoice_id) : null,
    discountAmount: toMoneyNumber(parseDecimal4(r.discount_amount)),
    orderSubtotal: toMoneyNumber(parseDecimal4(r.order_subtotal)),
    redeemedAt: r.redeemed_at,
  }));

  return { promotions, redemptions };
}

export async function createPromotion(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    code: string;
    name: string;
    description?: string | null;
    discountType: 'percent' | 'fixed_amount' | 'bogo' | 'bundle';
    discountValue: string | number;
    minOrderAmount?: string | number;
    maxDiscountAmount?: string | number | null;
    applicableItemType?: string | null;
    applicableItemId?: number | null;
    discountAccountId?: number | null;
    startsAt?: string | null;
    endsAt?: string | null;
    usageLimit?: number | null;
    promoBudget?: string | number;
    showOnPriceCard?: boolean;
    isActive?: boolean;
  }
) {
  const smartAccts = await resolveSmartOpsAccounts(tx, companyId, actor);
  const code = String(input.code || '').trim().toUpperCase().replace(/\s+/g, '');
  const name = String(input.name || '').trim();
  if (!code || !name) {
    throw new AccountingError(400, 'Promotion code and name are required', 'MISSING_PROMO_FIELDS');
  }
  const discVal4 = parseDecimal4(input.discountValue);
  if (discVal4 < 0n) throw new AccountingError(400, 'Discount value cannot be negative');
  if (input.discountType === 'percent' && discVal4 > 1000000n) {
    throw new AccountingError(400, 'Percentage discount cannot exceed 100%');
  }

  const startsAt = input.startsAt ? assertIsoDate(input.startsAt, 'startsAt') : null;
  const endsAt = input.endsAt ? assertIsoDate(input.endsAt, 'endsAt') : null;
  if (startsAt && endsAt && endsAt < startsAt) {
    throw new AccountingError(400, 'End date must be on or after start date');
  }

  const minOrder4 = parseDecimal4(input.minOrderAmount ?? 0);
  const maxDisc4 =
    input.maxDiscountAmount !== undefined && input.maxDiscountAmount !== null && input.maxDiscountAmount !== ''
      ? parseDecimal4(input.maxDiscountAmount)
      : null;
  const budget4 = parseDecimal4(input.promoBudget ?? 0);
  const discountAccountId = input.discountAccountId ? Number(input.discountAccountId) : smartAccts.salesDiscounts4100;

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO promotions (
       company_id, code, name, description, discount_type, discount_value,
       min_order_amount, max_discount_amount, applicable_item_type, applicable_item_id,
       discount_account_id, starts_at, ends_at, usage_limit, promo_budget,
       show_on_price_card, is_active, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6::NUMERIC(19,4),
       $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9, $10,
       $11, $12::DATE, $13::DATE, $14, $15::NUMERIC(19,4),
       $16, $17, $18
     ) RETURNING id`,
    [
      companyId,
      code,
      name,
      input.description?.trim() || null,
      input.discountType || 'percent',
      formatDecimal4(discVal4),
      formatDecimal4(minOrder4),
      maxDisc4 !== null ? formatDecimal4(maxDisc4) : null,
      input.applicableItemType || 'all',
      input.applicableItemId ? Number(input.applicableItemId) : null,
      discountAccountId,
      startsAt,
      endsAt,
      input.usageLimit ? Number(input.usageLimit) : null,
      formatDecimal4(budget4),
      input.showOnPriceCard !== undefined ? Boolean(input.showOnPriceCard) : true,
      input.isActive !== undefined ? Boolean(input.isActive) : true,
      actor.userId,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PROMOTION_CREATED',
    tableName: 'promotions',
    recordId: Number(ins.rows[0].id),
    newValues: { code, name, discountType: input.discountType, discountValue: formatDecimal4(discVal4) },
  });

  const all = await listPromotions(tx, companyId);
  return all.promotions.find(p => p.id === Number(ins.rows[0].id))!;
}

export async function updatePromotion(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  promoId: number,
  updates: {
    name?: string;
    description?: string | null;
    discountType?: 'percent' | 'fixed_amount' | 'bogo' | 'bundle';
    discountValue?: string | number;
    minOrderAmount?: string | number;
    maxDiscountAmount?: string | number | null;
    startsAt?: string | null;
    endsAt?: string | null;
    usageLimit?: number | null;
    promoBudget?: string | number;
    showOnPriceCard?: boolean;
    isActive?: boolean;
  }
) {
  const existing = await tx.query<any>(
    `SELECT * FROM promotions WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, promoId]
  );
  if (existing.rows.length === 0) throw new AccountingError(404, 'Promotion not found');
  const cur = existing.rows[0];

  const discVal = updates.discountValue !== undefined ? formatDecimal4(parseDecimal4(updates.discountValue)) : cur.discount_value;
  const minOrd = updates.minOrderAmount !== undefined ? formatDecimal4(parseDecimal4(updates.minOrderAmount)) : cur.min_order_amount;
  const maxDisc =
    updates.maxDiscountAmount === null || updates.maxDiscountAmount === ''
      ? null
      : updates.maxDiscountAmount !== undefined
      ? formatDecimal4(parseDecimal4(updates.maxDiscountAmount))
      : cur.max_discount_amount;
  const budget = updates.promoBudget !== undefined ? formatDecimal4(parseDecimal4(updates.promoBudget)) : cur.promo_budget;

  await tx.query(
    `UPDATE promotions
        SET name = $3,
            description = $4,
            discount_type = $5,
            discount_value = $6::NUMERIC(19,4),
            min_order_amount = $7::NUMERIC(19,4),
            max_discount_amount = $8::NUMERIC(19,4),
            starts_at = $9::DATE,
            ends_at = $10::DATE,
            usage_limit = $11,
            promo_budget = $12::NUMERIC(19,4),
            show_on_price_card = $13,
            is_active = $14
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      promoId,
      updates.name !== undefined ? updates.name.trim() : cur.name,
      updates.description !== undefined ? updates.description?.trim() || null : cur.description,
      updates.discountType ?? cur.discount_type,
      discVal,
      minOrd,
      maxDisc,
      updates.startsAt !== undefined ? (updates.startsAt || null) : cur.starts_at,
      updates.endsAt !== undefined ? (updates.endsAt || null) : cur.ends_at,
      updates.usageLimit !== undefined ? (updates.usageLimit ? Number(updates.usageLimit) : null) : cur.usage_limit,
      budget,
      updates.showOnPriceCard !== undefined ? Boolean(updates.showOnPriceCard) : cur.show_on_price_card,
      updates.isActive !== undefined ? Boolean(updates.isActive) : cur.is_active,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PROMOTION_UPDATED',
    tableName: 'promotions',
    recordId: promoId,
    newValues: updates,
  });

  const all = await listPromotions(tx, companyId);
  return all.promotions.find(p => p.id === promoId)!;
}

export async function evaluatePromotionDiscount4(
  tx: Transaction,
  companyId: number,
  promoCodeOrId: { promoCode?: string | null; promoId?: number | null },
  orderDate: string,
  grossSubtotal4: bigint,
  lines: Array<{ itemId?: number | null; itemType?: string | null; lineAmount4: bigint; quantity6: bigint; rate4: bigint }>
): Promise<{
  promotionId: number;
  code: string;
  name: string;
  discountAccountId: number | null;
  discount4: bigint;
}> {
  const res = promoCodeOrId.promoId
    ? await tx.query<any>(
        `SELECT * FROM promotions WHERE company_id = $1 AND id = $2 LIMIT 1`,
        [companyId, Number(promoCodeOrId.promoId)]
      )
    : await tx.query<any>(
        `SELECT * FROM promotions WHERE company_id = $1 AND LOWER(code) = LOWER($2) LIMIT 1`,
        [companyId, String(promoCodeOrId.promoCode || '').trim()]
      );

  if (res.rows.length === 0) {
    throw new AccountingError(404, `Promotion code "${promoCodeOrId.promoCode || promoCodeOrId.promoId}" not found`, 'PROMO_NOT_FOUND');
  }
  const p = res.rows[0];
  if (!p.is_active) {
    throw new AccountingError(400, `Promotion "${p.code}" is inactive`, 'PROMO_INACTIVE');
  }
  const startsAt = p.starts_at ? String(p.starts_at).slice(0, 10) : null;
  const endsAt = p.ends_at ? String(p.ends_at).slice(0, 10) : null;
  if (startsAt && orderDate < startsAt) {
    throw new AccountingError(400, `Promotion "${p.code}" starts on ${startsAt}`, 'PROMO_NOT_STARTED');
  }
  if (endsAt && orderDate > endsAt) {
    throw new AccountingError(400, `Promotion "${p.code}" expired on ${endsAt}`, 'PROMO_EXPIRED');
  }
  if (p.usage_limit !== null && Number(p.usage_count) >= Number(p.usage_limit)) {
    throw new AccountingError(400, `Promotion "${p.code}" has reached its usage limit`, 'PROMO_LIMIT_REACHED');
  }

  const minOrd4 = parseDecimal4(p.min_order_amount);
  if (grossSubtotal4 < minOrd4) {
    throw new AccountingError(
      400,
      `Promotion "${p.code}" requires a minimum order of ${formatDecimal4(minOrd4)}`,
      'PROMO_MIN_ORDER'
    );
  }

  // Filter eligible lines if applicable_item_id or applicable_item_type is specified
  const eligibleLines = lines.filter(l => {
    if (p.applicable_item_id && Number(l.itemId) !== Number(p.applicable_item_id)) return false;
    if (p.applicable_item_type && p.applicable_item_type !== 'all' && l.itemType && l.itemType !== p.applicable_item_type) return false;
    return true;
  });
  const eligibleSubtotal4 = eligibleLines.reduce((s, l) => s + l.lineAmount4, 0n);
  if (eligibleSubtotal4 <= 0n) {
    throw new AccountingError(400, `No items in the cart qualify for promotion "${p.code}"`, 'PROMO_NO_ELIGIBLE_ITEMS');
  }

  const val4 = parseDecimal4(p.discount_value);
  let discount4 = 0n;
  if (p.discount_type === 'percent' || p.discount_type === 'bundle') {
    // val4 is scaled *10000 (e.g. 15.0000% = 150000n), divide by 100 * 10000 = 1000000n
    discount4 = divRoundBigInt(eligibleSubtotal4 * val4, 1000000n, 'HALF_EVEN');
  } else if (p.discount_type === 'fixed_amount') {
    discount4 = val4;
  } else if (p.discount_type === 'bogo') {
    // Buy 1 get 1 (or discount_value% off every 2nd unit on eligible lines)
    const pct4 = val4 > 0n ? val4 : 1000000n; // default 100% off 2nd unit if 0/100
    for (const l of eligibleLines) {
      const freeUnits = l.quantity6 / 2000000n; // integer pairs
      if (freeUnits > 0n) {
        const pairDisc = divRoundBigInt(freeUnits * l.rate4 * pct4, 1000000n, 'HALF_EVEN');
        discount4 += pairDisc;
      }
    }
  }

  if (p.max_discount_amount !== null) {
    const cap4 = parseDecimal4(p.max_discount_amount);
    if (discount4 > cap4) discount4 = cap4;
  }
  if (discount4 > eligibleSubtotal4) discount4 = eligibleSubtotal4;
  if (discount4 > grossSubtotal4) discount4 = grossSubtotal4;

  return {
    promotionId: Number(p.id),
    code: p.code,
    name: p.name,
    discountAccountId: p.discount_account_id !== null ? Number(p.discount_account_id) : null,
    discount4,
  };
}

// ============================================================================
// REFERRAL PROGRAMS, CAMPAIGNS, CODES, EVENTS, PAYOUTS & ANALYTICS
// ============================================================================

export async function listReferralWorkspace(tx: Transaction, companyId: number) {
  const [programsRes, campaignsRes, codesRes, eventsRes] = await Promise.all([
    tx.query<any>(
      `SELECT rp.*,
              ea.code AS exp_code, ea.name AS exp_name,
              la.code AS liab_code, la.name AS liab_name
         FROM referral_programs rp
         LEFT JOIN accounts ea ON ea.company_id = rp.company_id AND ea.id = rp.reward_expense_account_id
         LEFT JOIN accounts la ON la.company_id = rp.company_id AND la.id = rp.reward_liability_account_id
        WHERE rp.company_id = $1
        ORDER BY rp.is_active DESC, rp.id DESC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT rc.*, rp.name AS program_name,
              COALESCE((SELECT COUNT(*) FROM referral_events re WHERE re.company_id = rc.company_id AND re.campaign_id = rc.id AND re.status <> 'voided'), 0)::text AS actual_referrals,
              COALESCE((SELECT SUM(re.qualifying_amount) FROM referral_events re WHERE re.company_id = rc.company_id AND re.campaign_id = rc.id AND re.status <> 'voided'), 0)::NUMERIC(19,4)::text AS generated_revenue
         FROM referral_campaigns rc
         JOIN referral_programs rp ON rp.company_id = rc.company_id AND rp.id = rc.program_id
        WHERE rc.company_id = $1
        ORDER BY rc.id DESC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT rcode.*, rp.name AS program_name, rc.name AS campaign_name,
              c.company_name AS customer_company_name
         FROM referral_codes rcode
         JOIN referral_programs rp ON rp.company_id = rcode.company_id AND rp.id = rcode.program_id
         LEFT JOIN referral_campaigns rc ON rc.company_id = rcode.company_id AND rc.id = rcode.campaign_id
         LEFT JOIN customers c ON c.company_id = rcode.company_id AND c.id = rcode.referrer_customer_id
        WHERE rcode.company_id = $1
        ORDER BY rcode.total_referred_revenue DESC, rcode.id DESC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT re.*, rcode.code AS referral_code, rcode.referrer_name, rcode.referrer_customer_id,
              rp.name AS program_name, c.company_name AS referee_name,
              pa.code AS payout_account_code, pa.name AS payout_account_name,
              po.receipt_number
         FROM referral_events re
         JOIN referral_codes rcode ON rcode.company_id = re.company_id AND rcode.id = re.referral_code_id
         JOIN referral_programs rp ON rp.company_id = re.company_id AND rp.id = re.program_id
         LEFT JOIN customers c ON c.company_id = re.company_id AND c.id = re.referee_customer_id
         LEFT JOIN accounts pa ON pa.company_id = re.company_id AND pa.id = re.payout_account_id
         LEFT JOIN pos_orders po ON po.company_id = re.company_id AND po.id = re.pos_order_id
        WHERE re.company_id = $1
        ORDER BY re.created_at DESC, re.id DESC
        LIMIT 100`,
      [companyId]
    ),
  ]);

  const programs = programsRes.rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    description: r.description || '',
    referrerRewardType: r.referrer_reward_type,
    referrerRewardValue: toMoneyNumber(parseDecimal4(r.referrer_reward_value)),
    refereeDiscountType: r.referee_discount_type,
    refereeDiscountValue: toMoneyNumber(parseDecimal4(r.referee_discount_value)),
    minQualifyingSpend: toMoneyNumber(parseDecimal4(r.min_qualifying_spend)),
    rewardExpenseAccountId: r.reward_expense_account_id ? Number(r.reward_expense_account_id) : null,
    rewardExpenseAccountLabel: r.exp_code ? `${r.exp_code} ${r.exp_name}` : '6450 Marketing & Referral Rewards Expense',
    rewardLiabilityAccountId: r.reward_liability_account_id ? Number(r.reward_liability_account_id) : null,
    rewardLiabilityAccountLabel: r.liab_code ? `${r.liab_code} ${r.liab_name}` : '2150 Referral Rewards Payable',
    startsAt: r.starts_at ? String(r.starts_at).slice(0, 10) : null,
    endsAt: r.ends_at ? String(r.ends_at).slice(0, 10) : null,
    isActive: Boolean(r.is_active),
  }));

  const campaigns = campaignsRes.rows.map(r => ({
    id: Number(r.id),
    programId: Number(r.program_id),
    programName: r.program_name,
    name: r.name,
    channel: r.channel,
    trackingCode: r.tracking_code,
    targetReferrals: Number(r.target_referrals),
    actualReferrals: Number(r.actual_referrals),
    budgetAmount: toMoneyNumber(parseDecimal4(r.budget_amount)),
    generatedRevenue: toMoneyNumber(parseDecimal4(r.generated_revenue)),
    status: r.status,
  }));

  const codes = codesRes.rows.map(r => ({
    id: Number(r.id),
    programId: Number(r.program_id),
    programName: r.program_name,
    campaignId: r.campaign_id ? Number(r.campaign_id) : null,
    campaignName: r.campaign_name || null,
    referrerCustomerId: r.referrer_customer_id ? Number(r.referrer_customer_id) : null,
    referrerName: r.customer_company_name || r.referrer_name,
    referrerPhone: r.referrer_phone || '',
    code: r.code,
    clicksCount: Number(r.clicks_count),
    conversionsCount: Number(r.conversions_count),
    totalReferredRevenue: toMoneyNumber(parseDecimal4(r.total_referred_revenue)),
    totalRewardsEarned: toMoneyNumber(parseDecimal4(r.total_rewards_earned)),
    rewardBalance: toMoneyNumber(parseDecimal4(r.reward_balance)),
    isActive: Boolean(r.is_active),
  }));

  const events = eventsRes.rows.map(r => ({
    id: Number(r.id),
    referralCodeId: Number(r.referral_code_id),
    referralCode: r.referral_code,
    referrerName: r.referrer_name,
    referrerCustomerId: r.referrer_customer_id ? Number(r.referrer_customer_id) : null,
    programId: Number(r.program_id),
    programName: r.program_name,
    refereeCustomerId: r.referee_customer_id ? Number(r.referee_customer_id) : null,
    refereeName: r.referee_name || 'Walk-In Customer',
    posOrderId: r.pos_order_id ? Number(r.pos_order_id) : null,
    receiptNumber: r.receipt_number || null,
    qualifyingAmount: toMoneyNumber(parseDecimal4(r.qualifying_amount)),
    refereeDiscount: toMoneyNumber(parseDecimal4(r.referee_discount)),
    rewardAmount: toMoneyNumber(parseDecimal4(r.reward_amount)),
    status: r.status,
    payoutMethod: r.payout_method || null,
    payoutAccountLabel: r.payout_account_code ? `${r.payout_account_code} ${r.payout_account_name}` : null,
    creditMemoId: r.credit_memo_id ? Number(r.credit_memo_id) : null,
    accrualJournalTxnId: r.accrual_journal_txn_id ? Number(r.accrual_journal_txn_id) : null,
    payoutJournalTxnId: r.payout_journal_txn_id ? Number(r.payout_journal_txn_id) : null,
    notes: r.notes || '',
    createdAt: r.created_at,
    paidAt: r.paid_at,
  }));

  const totalClicks = codes.reduce((s, c) => s + c.clicksCount, 0);
  const activeEvents = events.filter(e => e.status !== 'voided');
  const totalConversions = activeEvents.length;
  const totalRevenue = activeEvents.reduce((s, e) => s + e.qualifyingAmount, 0);
  const totalDiscounts = activeEvents.reduce((s, e) => s + e.refereeDiscount, 0);
  const totalRewardsAccrued = activeEvents.reduce((s, e) => s + e.rewardAmount, 0);
  const pendingLiability = activeEvents
    .filter(e => e.status === 'pending' || e.status === 'approved')
    .reduce((s, e) => s + e.rewardAmount, 0);
  const settledRewards = activeEvents
    .filter(e => e.status === 'credited' || e.status === 'paid')
    .reduce((s, e) => s + e.rewardAmount, 0);
  const conversionRate = totalClicks > 0 ? Math.round((totalConversions / totalClicks) * 1000) / 10 : totalConversions > 0 ? 100 : 0;

  return {
    programs,
    campaigns,
    codes,
    events,
    analytics: {
      totalClicks,
      totalConversions,
      conversionRate,
      totalRevenue,
      totalDiscounts,
      totalRewardsAccrued,
      pendingLiability,
      settledRewards,
      roiMultiple: totalRewardsAccrued > 0 ? Math.round((totalRevenue / totalRewardsAccrued) * 10) / 10 : 0,
    },
  };
}

export async function createReferralProgram(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    name: string;
    description?: string | null;
    referrerRewardType: 'fixed_credit' | 'percent_commission' | 'cash_payout';
    referrerRewardValue: string | number;
    refereeDiscountType: 'percent' | 'fixed_amount';
    refereeDiscountValue: string | number;
    minQualifyingSpend?: string | number;
    rewardExpenseAccountId?: number | null;
    rewardLiabilityAccountId?: number | null;
    startsAt?: string | null;
    endsAt?: string | null;
  }
) {
  const smartAccts = await resolveSmartOpsAccounts(tx, companyId, actor);
  const name = String(input.name || '').trim();
  if (!name) throw new AccountingError(400, 'Referral program name is required');
  const rewardVal4 = parseDecimal4(input.referrerRewardValue ?? 0);
  const refereeDisc4 = parseDecimal4(input.refereeDiscountValue ?? 0);
  const minSpend4 = parseDecimal4(input.minQualifyingSpend ?? 0);
  const expAcctId = input.rewardExpenseAccountId ? Number(input.rewardExpenseAccountId) : smartAccts.marketingExpense6450;
  const liabAcctId = input.rewardLiabilityAccountId ? Number(input.rewardLiabilityAccountId) : smartAccts.referralPayable2150;

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO referral_programs (
       company_id, name, description, referrer_reward_type, referrer_reward_value,
       referee_discount_type, referee_discount_value, min_qualifying_spend,
       reward_expense_account_id, reward_liability_account_id, starts_at, ends_at, is_active, created_by
     ) VALUES (
       $1, $2, $3, $4, $5::NUMERIC(19,4),
       $6, $7::NUMERIC(19,4), $8::NUMERIC(19,4),
       $9, $10, $11::DATE, $12::DATE, TRUE, $13
     ) RETURNING id`,
    [
      companyId,
      name,
      input.description?.trim() || null,
      input.referrerRewardType || 'fixed_credit',
      formatDecimal4(rewardVal4),
      input.refereeDiscountType || 'percent',
      formatDecimal4(refereeDisc4),
      formatDecimal4(minSpend4),
      expAcctId,
      liabAcctId,
      input.startsAt || null,
      input.endsAt || null,
      actor.userId,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_PROGRAM_CREATED',
    tableName: 'referral_programs',
    recordId: Number(ins.rows[0].id),
    newValues: { name },
  });

  const ws = await listReferralWorkspace(tx, companyId);
  return ws.programs.find(p => p.id === Number(ins.rows[0].id))!;
}

export async function toggleReferralProgram(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  programId: number,
  isActive: boolean
) {
  await tx.query(
    `UPDATE referral_programs SET is_active = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, programId, isActive]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_PROGRAM_TOGGLED',
    tableName: 'referral_programs',
    recordId: programId,
    newValues: { isActive },
  });
}

export async function createReferralCampaign(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    programId: number;
    name: string;
    channel: 'whatsapp' | 'print_qr' | 'walk_in' | 'email' | 'social';
    trackingCode: string;
    targetReferrals?: number;
    budgetAmount?: string | number;
    status?: 'active' | 'paused' | 'completed' | 'draft';
  }
) {
  const name = String(input.name || '').trim();
  const trackingCode = String(input.trackingCode || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!name || !trackingCode) throw new AccountingError(400, 'Campaign name and tracking code are required');

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO referral_campaigns (
       company_id, program_id, name, channel, tracking_code, target_referrals, budget_amount, status, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(19,4), $8, $9) RETURNING id`,
    [
      companyId,
      Number(input.programId),
      name,
      input.channel || 'whatsapp',
      trackingCode,
      Math.max(1, Number(input.targetReferrals) || 25),
      formatDecimal4(parseDecimal4(input.budgetAmount ?? 0)),
      input.status || 'active',
      actor.userId,
    ]
  );

  const ws = await listReferralWorkspace(tx, companyId);
  return ws.campaigns.find(c => c.id === Number(ins.rows[0].id))!;
}

export async function createReferralCode(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    programId: number;
    campaignId?: number | null;
    referrerCustomerId?: number | null;
    referrerName?: string;
    referrerPhone?: string | null;
    code?: string;
  }
) {
  let referrerName = String(input.referrerName || '').trim();
  let referrerPhone = input.referrerPhone?.trim() || null;

  if (input.referrerCustomerId) {
    const cust = await tx.query<{ company_name: string; name: string; phone: string | null }>(
      `SELECT company_name, name, phone FROM customers WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, Number(input.referrerCustomerId)]
    );
    if (cust.rows.length === 0) throw new AccountingError(404, 'Customer not found');
    if (!referrerName) referrerName = cust.rows[0].company_name || cust.rows[0].name;
    if (!referrerPhone) referrerPhone = cust.rows[0].phone;
  }
  if (!referrerName) throw new AccountingError(400, 'Referrer name or customer is required');

  const rawCode = input.code?.trim()
    ? input.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '')
    : `REF-${referrerName.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO referral_codes (
       company_id, program_id, campaign_id, referrer_customer_id, referrer_name, referrer_phone, code
     ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      companyId,
      Number(input.programId),
      input.campaignId ? Number(input.campaignId) : null,
      input.referrerCustomerId ? Number(input.referrerCustomerId) : null,
      referrerName,
      referrerPhone,
      rawCode,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_CODE_CREATED',
    tableName: 'referral_codes',
    recordId: Number(ins.rows[0].id),
    newValues: { code: rawCode, referrerName },
  });

  const ws = await listReferralWorkspace(tx, companyId);
  return ws.codes.find(c => c.id === Number(ins.rows[0].id))!;
}

export async function recordReferralClick(tx: Transaction, companyId: number, codeId: number) {
  await tx.query(
    `UPDATE referral_codes SET clicks_count = clicks_count + 1 WHERE company_id = $1 AND id = $2`,
    [companyId, codeId]
  );
}

export async function evaluateReferralForOrder(
  tx: Transaction,
  companyId: number,
  referralCode: string,
  orderDate: string,
  grossSubtotal4: bigint
): Promise<{
  referralCodeId: number;
  programId: number;
  campaignId: number | null;
  code: string;
  referrerName: string;
  expenseAccountId: number | null;
  liabilityAccountId: number | null;
  refereeDiscount4: bigint;
  referrerReward4: bigint;
}> {
  const res = await tx.query<any>(
    `SELECT rc.*, rp.referrer_reward_type, rp.referrer_reward_value::text,
            rp.referee_discount_type, rp.referee_discount_value::text,
            rp.min_qualifying_spend::text, rp.is_active AS program_active,
            rp.starts_at, rp.ends_at, rp.reward_expense_account_id, rp.reward_liability_account_id
       FROM referral_codes rc
       JOIN referral_programs rp ON rp.company_id = rc.company_id AND rp.id = rc.program_id
      WHERE rc.company_id = $1 AND LOWER(rc.code) = LOWER($2)
      LIMIT 1`,
    [companyId, referralCode.trim()]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, `Referral code "${referralCode}" not found`, 'REFERRAL_NOT_FOUND');
  }
  const r = res.rows[0];
  if (!r.is_active || !r.program_active) {
    throw new AccountingError(400, `Referral code "${r.code}" or its program is inactive`, 'REFERRAL_INACTIVE');
  }
  const startsAt = r.starts_at ? String(r.starts_at).slice(0, 10) : null;
  const endsAt = r.ends_at ? String(r.ends_at).slice(0, 10) : null;
  if (startsAt && orderDate < startsAt) {
    throw new AccountingError(400, `Referral program starts on ${startsAt}`);
  }
  if (endsAt && orderDate > endsAt) {
    throw new AccountingError(400, `Referral program expired on ${endsAt}`);
  }
  const minSpend4 = parseDecimal4(r.min_qualifying_spend);
  if (grossSubtotal4 < minSpend4) {
    throw new AccountingError(
      400,
      `Referral code "${r.code}" requires minimum order ${formatDecimal4(minSpend4)}`
    );
  }

  const refDiscVal4 = parseDecimal4(r.referee_discount_value);
  let refereeDiscount4 =
    r.referee_discount_type === 'percent'
      ? divRoundBigInt(grossSubtotal4 * refDiscVal4, 1000000n, 'HALF_EVEN')
      : refDiscVal4;
  if (refereeDiscount4 > grossSubtotal4) refereeDiscount4 = grossSubtotal4;

  const netQualifying4 = grossSubtotal4 - refereeDiscount4;
  const rewVal4 = parseDecimal4(r.referrer_reward_value);
  const referrerReward4 =
    r.referrer_reward_type === 'percent_commission'
      ? divRoundBigInt(netQualifying4 * rewVal4, 1000000n, 'HALF_EVEN')
      : rewVal4;

  return {
    referralCodeId: Number(r.id),
    programId: Number(r.program_id),
    campaignId: r.campaign_id ? Number(r.campaign_id) : null,
    code: r.code,
    referrerName: r.referrer_name,
    expenseAccountId: r.reward_expense_account_id ? Number(r.reward_expense_account_id) : null,
    liabilityAccountId: r.reward_liability_account_id ? Number(r.reward_liability_account_id) : null,
    refereeDiscount4,
    referrerReward4,
  };
}

export async function accrueReferralEventAndJournal(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  params: {
    referralCodeId: number;
    programId: number;
    campaignId: number | null;
    refereeCustomerId: number | null;
    posOrderId: number | null;
    invoiceId: number | null;
    qualifyingAmount4: bigint;
    refereeDiscount4: bigint;
    rewardAmount4: bigint;
    expenseAccountId: number | null;
    liabilityAccountId: number | null;
    txnDate: string;
    reference: string;
    notes?: string | null;
    status?: 'pending' | 'approved';
  }
) {
  const smartAccts = await resolveSmartOpsAccounts(tx, companyId, actor);
  const expAcctId = params.expenseAccountId || smartAccts.marketingExpense6450;
  const liabAcctId = params.liabilityAccountId || smartAccts.referralPayable2150;

  let accrualJournalId: number | null = null;
  if (params.rewardAmount4 > 0n) {
    const je = await postJournalEntry(tx, companyId, actor, {
      txnDate: params.txnDate,
      description: `Referral Reward Accrual — ${params.reference}`,
      reference: params.reference,
      sourceType: 'referral_reward',
      sourceId: params.posOrderId ?? params.referralCodeId,
      idempotencyKey: `ref-accrual-${companyId}-${params.posOrderId ?? 'manual'}-${Date.now()}-${Math.random()}`,
      lines: [
        {
          accountId: expAcctId,
          debit: formatDecimal4(params.rewardAmount4),
          credit: '0.0000',
          description: `Referral expense accrued (${params.reference})`,
        },
        {
          accountId: liabAcctId,
          debit: '0.0000',
          credit: formatDecimal4(params.rewardAmount4),
          description: `Referral rewards payable (${params.reference})`,
        },
      ],
    });
    accrualJournalId = je.transaction.id;
  }

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO referral_events (
       company_id, referral_code_id, program_id, campaign_id, referee_customer_id,
       pos_order_id, invoice_id, qualifying_amount, referee_discount, reward_amount,
       status, accrual_journal_txn_id, notes
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8::NUMERIC(19,4), $9::NUMERIC(19,4), $10::NUMERIC(19,4),
       $11, $12, $13
     ) RETURNING id`,
    [
      companyId,
      params.referralCodeId,
      params.programId,
      params.campaignId,
      params.refereeCustomerId,
      params.posOrderId,
      params.invoiceId,
      formatDecimal4(params.qualifyingAmount4),
      formatDecimal4(params.refereeDiscount4),
      formatDecimal4(params.rewardAmount4),
      params.status || 'approved',
      accrualJournalId,
      params.notes || null,
    ]
  );

  await tx.query(
    `UPDATE referral_codes
        SET conversions_count = conversions_count + 1,
            clicks_count = GREATEST(clicks_count, conversions_count + 1),
            total_referred_revenue = total_referred_revenue + $3::NUMERIC(19,4),
            total_rewards_earned = total_rewards_earned + $4::NUMERIC(19,4),
            reward_balance = reward_balance + $4::NUMERIC(19,4)
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      params.referralCodeId,
      formatDecimal4(params.qualifyingAmount4),
      formatDecimal4(params.rewardAmount4),
    ]
  );

  return Number(ins.rows[0].id);
}

export async function recordManualReferralConversion(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    referralCodeId: number;
    refereeCustomerId?: number | null;
    qualifyingAmount: string | number;
    rewardAmount?: string | number | null;
    txnDate?: string;
    notes?: string | null;
  }
) {
  const codeRes = await tx.query<any>(
    `SELECT rc.*, rp.referrer_reward_type, rp.referrer_reward_value::text,
            rp.reward_expense_account_id, rp.reward_liability_account_id
       FROM referral_codes rc
       JOIN referral_programs rp ON rp.company_id = rc.company_id AND rp.id = rc.program_id
      WHERE rc.company_id = $1 AND rc.id = $2 FOR UPDATE`,
    [companyId, Number(input.referralCodeId)]
  );
  if (codeRes.rows.length === 0) throw new AccountingError(404, 'Referral code not found');
  const rc = codeRes.rows[0];
  const txnDate = input.txnDate ? assertIsoDate(input.txnDate, 'txnDate') : todayIsoDate();
  await assertPeriodOpenForDate(tx, companyId, txnDate);

  const qual4 = parseDecimal4(input.qualifyingAmount);
  if (qual4 <= 0n) throw new AccountingError(400, 'Qualifying amount must be greater than zero');

  let reward4: bigint;
  if (input.rewardAmount !== undefined && input.rewardAmount !== null && input.rewardAmount !== '') {
    reward4 = parseDecimal4(input.rewardAmount);
  } else {
    const val4 = parseDecimal4(rc.referrer_reward_value);
    reward4 = rc.referrer_reward_type === 'percent_commission'
      ? divRoundBigInt(qual4 * val4, 1000000n, 'HALF_EVEN')
      : val4;
  }

  const eventId = await accrueReferralEventAndJournal(tx, companyId, actor, {
    referralCodeId: Number(rc.id),
    programId: Number(rc.program_id),
    campaignId: rc.campaign_id ? Number(rc.campaign_id) : null,
    refereeCustomerId: input.refereeCustomerId ? Number(input.refereeCustomerId) : null,
    posOrderId: null,
    invoiceId: null,
    qualifyingAmount4: qual4,
    refereeDiscount4: 0n,
    rewardAmount4: reward4,
    expenseAccountId: rc.reward_expense_account_id ? Number(rc.reward_expense_account_id) : null,
    liabilityAccountId: rc.reward_liability_account_id ? Number(rc.reward_liability_account_id) : null,
    txnDate,
    reference: rc.code,
    notes: input.notes?.trim() || 'Manual referral attribution',
    status: 'approved',
  });

  const ws = await listReferralWorkspace(tx, companyId);
  return ws.events.find(e => e.id === eventId)!;
}

export async function payoutReferralReward(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  eventId: number,
  input: {
    settlementType: 'bank_payout' | 'customer_credit';
    payoutAccountId?: number | null;
    payoutMethod?: string;
    payoutDate?: string;
    notes?: string | null;
  }
) {
  const smartAccts = await resolveSmartOpsAccounts(tx, companyId, actor);
  const evRes = await tx.query<any>(
    `SELECT re.*, rc.referrer_customer_id, rc.referrer_name, rc.code AS referral_code,
            rp.reward_liability_account_id
       FROM referral_events re
       JOIN referral_codes rc ON rc.company_id = re.company_id AND rc.id = re.referral_code_id
       JOIN referral_programs rp ON rp.company_id = re.company_id AND rp.id = re.program_id
      WHERE re.company_id = $1 AND re.id = $2
      FOR UPDATE`,
    [companyId, eventId]
  );
  if (evRes.rows.length === 0) throw new AccountingError(404, 'Referral reward event not found');
  const ev = evRes.rows[0];
  if (ev.status === 'paid' || ev.status === 'credited') {
    throw new AccountingError(409, 'This referral reward has already been settled', 'ALREADY_SETTLED');
  }
  if (ev.status === 'voided') {
    throw new AccountingError(409, 'Voided referral reward cannot be paid out');
  }

  const reward4 = parseDecimal4(ev.reward_amount);
  if (reward4 <= 0n) {
    throw new AccountingError(400, 'Reward amount is zero; nothing to settle');
  }

  const payoutDate = input.payoutDate ? assertIsoDate(input.payoutDate, 'payoutDate') : todayIsoDate();
  await assertPeriodOpenForDate(tx, companyId, payoutDate);

  const liabilityAcctId = ev.reward_liability_account_id
    ? Number(ev.reward_liability_account_id)
    : smartAccts.referralPayable2150;

  let nextStatus: 'paid' | 'credited' = 'paid';
  let creditMemoId: number | null = null;
  let payoutBankTxnId: number | null = null;
  let payoutAccountId: number | null = null;
  let payoutMethod = input.payoutMethod || 'Mobile Money';

  if (input.settlementType === 'customer_credit') {
    const custId = ev.referrer_customer_id ? Number(ev.referrer_customer_id) : null;
    if (!custId) {
      throw new AccountingError(
        400,
        'Customer store credit requires the referral code to be linked to an existing customer account',
        'MISSING_REFERRER_CUSTOMER'
      );
    }
    nextStatus = 'credited';
    payoutMethod = 'Store Credit Memo';
    payoutAccountId = smartAccts.ar1100;

    const creditNumber = await generateNextDocNumber(tx, companyId, 'credit_memos', 'credit_number', 'CM');
    const cmIns = await tx.query<{ id: number }>(
      `INSERT INTO credit_memos (
         company_id, credit_number, customer_id, credit_date, status,
         subtotal, tax_rate, tax_amount, total, remaining_credit, memo
       ) VALUES ($1, $2, $3, $4::DATE, 'open', $5::NUMERIC(19,4), 0.000000, 0.0000, $5::NUMERIC(19,4), $5::NUMERIC(19,4), $6)
       RETURNING id`,
      [
        companyId,
        creditNumber,
        custId,
        payoutDate,
        formatDecimal4(reward4),
        `Referral Reward Store Credit (${ev.referral_code})`,
      ]
    );
    creditMemoId = Number(cmIns.rows[0].id);

    await tx.query(
      `INSERT INTO credit_memo_lines (company_id, credit_memo_id, description, quantity, rate, amount)
       VALUES ($1, $2, $3, 1.000000, $4::NUMERIC(19,4), $4::NUMERIC(19,4))`,
      [companyId, creditMemoId, `Referral reward payout for code ${ev.referral_code}`, formatDecimal4(reward4)]
    );

    const je = await postJournalEntry(tx, companyId, actor, {
      txnDate: payoutDate,
      description: `Referral Reward Credit Memo ${creditNumber} — ${ev.referrer_name}`,
      reference: creditNumber,
      sourceType: 'referral_reward',
      sourceId: eventId,
      idempotencyKey: `ref-payout-cm-${companyId}-${eventId}`,
      lines: [
        {
          accountId: liabilityAcctId,
          debit: formatDecimal4(reward4),
          credit: '0.0000',
          description: `Settle referral liability (${ev.referral_code})`,
        },
        {
          accountId: smartAccts.ar1100,
          debit: '0.0000',
          credit: formatDecimal4(reward4),
          description: `Apply referral credit memo ${creditNumber}`,
          partyType: 'customer',
          partyId: custId,
        },
      ],
    });

    await tx.query(`UPDATE credit_memos SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`, [
      companyId,
      creditMemoId,
      je.transaction.id,
    ]);
    await recalculateCustomerBalance(tx, companyId, custId);

    await tx.query(
      `UPDATE referral_events
          SET status = 'credited',
              payout_method = $3,
              payout_account_id = $4,
              credit_memo_id = $5,
              payout_journal_txn_id = $6,
              notes = COALESCE($7, notes),
              paid_at = NOW()
        WHERE company_id = $1 AND id = $2`,
      [companyId, eventId, payoutMethod, payoutAccountId, creditMemoId, je.transaction.id, input.notes?.trim() || null]
    );
  } else {
    payoutAccountId = input.payoutAccountId ? Number(input.payoutAccountId) : smartAccts.mobileClearing1030;
    const acctRes = await tx.query<{ id: number; account_type: string; name: string }>(
      `SELECT id, account_type, name FROM accounts WHERE company_id = $1 AND id = $2 AND is_active = TRUE LIMIT 1`,
      [companyId, payoutAccountId]
    );
    if (acctRes.rows.length === 0 || !['Bank', 'OtherCurrentAsset'].includes(acctRes.rows[0].account_type)) {
      throw new AccountingError(400, 'Payout account must be an active Bank or Cash account');
    }

    const je = await postJournalEntry(tx, companyId, actor, {
      txnDate: payoutDate,
      description: `Referral Reward Payout (${ev.referral_code}) — ${ev.referrer_name}`,
      reference: `REF-PAY-${eventId}`,
      sourceType: 'referral_reward',
      sourceId: eventId,
      idempotencyKey: `ref-payout-cash-${companyId}-${eventId}`,
      lines: [
        {
          accountId: liabilityAcctId,
          debit: formatDecimal4(reward4),
          credit: '0.0000',
          description: `Settle referral rewards payable (${ev.referral_code})`,
        },
        {
          accountId: payoutAccountId,
          debit: '0.0000',
          credit: formatDecimal4(reward4),
          description: `Referral reward payout via ${payoutMethod}`,
        },
      ],
    });

    if (acctRes.rows[0].account_type === 'Bank') {
      const baRes = await tx.query<{ id: number }>(
        `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
        [companyId, payoutAccountId]
      );
      const btIns = await tx.query<{ id: number }>(
        `INSERT INTO bank_transactions (
           company_id, account_id, bank_account_id, txn_date, payee, txn_type,
           ref_number, memo, amount, is_cleared, status, offset_account_id, journal_txn_id, category
         ) VALUES (
           $1, $2, $3, $4::DATE, $5, 'Debit',
           $6, $7, $8::NUMERIC(19,4), FALSE, 'posted', $9, $10, 'Referral Rewards'
         ) RETURNING id`,
        [
          companyId,
          payoutAccountId,
          baRes.rows[0] ? Number(baRes.rows[0].id) : null,
          payoutDate,
          ev.referrer_name,
          `REF-PAY-${eventId}`,
          `Referral payout for code ${ev.referral_code} (${payoutMethod})`,
          formatDecimal4(-reward4),
          liabilityAcctId,
          je.transaction.id,
        ]
      );
      payoutBankTxnId = Number(btIns.rows[0].id);
    }

    await tx.query(
      `UPDATE referral_events
          SET status = 'paid',
              payout_method = $3,
              payout_account_id = $4,
              payout_journal_txn_id = $5,
              payout_bank_txn_id = $6,
              notes = COALESCE($7, notes),
              paid_at = NOW()
        WHERE company_id = $1 AND id = $2`,
      [
        companyId,
        eventId,
        payoutMethod,
        payoutAccountId,
        je.transaction.id,
        payoutBankTxnId,
        input.notes?.trim() || null,
      ]
    );
  }

  await tx.query(
    `UPDATE referral_codes
        SET reward_balance = GREATEST(0, reward_balance - $3::NUMERIC(19,4))
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(ev.referral_code_id), formatDecimal4(reward4)]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_REWARD_SETTLED',
    tableName: 'referral_events',
    recordId: eventId,
    newValues: { status: nextStatus, amount: formatDecimal4(reward4), payoutMethod, creditMemoId, payoutBankTxnId },
  });

  const ws = await listReferralWorkspace(tx, companyId);
  return ws.events.find(e => e.id === eventId)!;
}

// ============================================================================
// MARKETING MESSAGES (WHATSAPP AUTOMATION, BULK CAMPAIGNS, CUSTOMER COMMS)
// ============================================================================

export async function listMarketingWorkspace(tx: Transaction, companyId: number) {
  const [templatesRes, rulesRes, campaignsRes, messagesRes] = await Promise.all([
    tx.query<any>(
      `SELECT mt.*, p.code AS promo_code
         FROM marketing_templates mt
         LEFT JOIN promotions p ON p.company_id = mt.company_id AND p.id = mt.promo_id
        WHERE mt.company_id = $1
        ORDER BY mt.id DESC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT mr.*, mt.name AS template_name, mt.body AS template_body, mt.category AS template_category
         FROM marketing_automation_rules mr
         JOIN marketing_templates mt ON mt.company_id = mr.company_id AND mt.id = mr.template_id
        WHERE mr.company_id = $1
        ORDER BY mr.is_enabled DESC, mr.id DESC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT mc.*, p.code AS promo_code,
              ea.code AS expense_account_code, ea.name AS expense_account_name,
              pa.code AS payment_account_code, pa.name AS payment_account_name
         FROM marketing_campaigns mc
         LEFT JOIN promotions p ON p.company_id = mc.company_id AND p.id = mc.promo_id
         LEFT JOIN accounts ea ON ea.company_id = mc.company_id AND ea.id = mc.expense_account_id
         LEFT JOIN accounts pa ON pa.company_id = mc.company_id AND pa.id = mc.payment_account_id
        WHERE mc.company_id = $1
        ORDER BY mc.id DESC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT mm.*, mc.name AS campaign_name, mr.name AS rule_name
         FROM marketing_messages mm
         LEFT JOIN marketing_campaigns mc ON mc.company_id = mm.company_id AND mc.id = mm.campaign_id
         LEFT JOIN marketing_automation_rules mr ON mr.company_id = mm.company_id AND mr.id = mm.rule_id
        WHERE mm.company_id = $1
        ORDER BY mm.created_at DESC, mm.id DESC
        LIMIT 120`,
      [companyId]
    ),
  ]);

  const templates = templatesRes.rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    category: r.category,
    channel: r.channel,
    body: r.body,
    promoId: r.promo_id ? Number(r.promo_id) : null,
    promoCode: r.promo_code || null,
    isActive: Boolean(r.is_active),
  }));

  const automationRules = rulesRes.rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    triggerEvent: r.trigger_event,
    templateId: Number(r.template_id),
    templateName: r.template_name,
    templateBody: r.template_body,
    delayHours: Number(r.delay_hours),
    targetSegment: r.target_segment,
    isEnabled: Boolean(r.is_enabled),
    runsCount: Number(r.runs_count),
    lastRunAt: r.last_run_at,
  }));

  const campaigns = campaignsRes.rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    channel: r.channel,
    audienceSegment: r.audience_segment,
    templateId: r.template_id ? Number(r.template_id) : null,
    messageBody: r.message_body,
    promoId: r.promo_id ? Number(r.promo_id) : null,
    promoCode: r.promo_code || null,
    status: r.status,
    recipientCount: Number(r.recipient_count),
    sentCount: Number(r.sent_count),
    budgetAmount: toMoneyNumber(parseDecimal4(r.budget_amount)),
    actualSpend: toMoneyNumber(parseDecimal4(r.actual_spend)),
    expenseAccountLabel: r.expense_account_code ? `${r.expense_account_code} ${r.expense_account_name}` : null,
    paymentAccountLabel: r.payment_account_code ? `${r.payment_account_code} ${r.payment_account_name}` : null,
    expenseJournalTxnId: r.expense_journal_txn_id ? Number(r.expense_journal_txn_id) : null,
    dispatchedAt: r.dispatched_at,
    createdAt: r.created_at,
  }));

  const messages = messagesRes.rows.map(r => ({
    id: Number(r.id),
    campaignId: r.campaign_id ? Number(r.campaign_id) : null,
    campaignName: r.campaign_name || null,
    ruleId: r.rule_id ? Number(r.rule_id) : null,
    ruleName: r.rule_name || null,
    customerId: r.customer_id ? Number(r.customer_id) : null,
    recipientName: r.recipient_name,
    recipientPhone: r.recipient_phone || '',
    channel: r.channel,
    renderedBody: r.rendered_body,
    whatsappUrl: r.whatsapp_url || buildWhatsAppUrl(r.recipient_phone, r.rendered_body),
    status: r.status,
    posOrderId: r.pos_order_id ? Number(r.pos_order_id) : null,
    sentAt: r.sent_at,
    createdAt: r.created_at,
  }));

  return { templates, automationRules, campaigns, messages };
}

export async function createMarketingTemplate(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    name: string;
    category: 'promotion' | 'receipt' | 'referral' | 'reminder' | 'announcement' | 'reorder';
    channel?: 'whatsapp' | 'sms' | 'email';
    body: string;
    promoId?: number | null;
  }
) {
  const name = String(input.name || '').trim();
  const body = String(input.body || '').trim();
  if (!name || !body) throw new AccountingError(400, 'Template name and body are required');

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO marketing_templates (company_id, name, category, channel, body, promo_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      companyId,
      name,
      input.category || 'promotion',
      input.channel || 'whatsapp',
      body,
      input.promoId ? Number(input.promoId) : null,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'MARKETING_TEMPLATE_CREATED',
    tableName: 'marketing_templates',
    recordId: Number(ins.rows[0].id),
    newValues: { name, category: input.category },
  });

  const ws = await listMarketingWorkspace(tx, companyId);
  return ws.templates.find(t => t.id === Number(ins.rows[0].id))!;
}

export async function createAutomationRule(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    name: string;
    triggerEvent: 'post_pos_receipt' | 'invoice_overdue' | 'referral_invite' | 'promo_drop' | 'inactive_customer';
    templateId: number;
    delayHours?: number;
    targetSegment?: string;
  }
) {
  const name = String(input.name || '').trim();
  if (!name) throw new AccountingError(400, 'Automation rule name is required');

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO marketing_automation_rules (company_id, name, trigger_event, template_id, delay_hours, target_segment)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      companyId,
      name,
      input.triggerEvent,
      Number(input.templateId),
      Math.max(0, Number(input.delayHours) || 0),
      input.targetSegment || 'all',
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'MARKETING_RULE_CREATED',
    tableName: 'marketing_automation_rules',
    recordId: Number(ins.rows[0].id),
    newValues: { name, triggerEvent: input.triggerEvent },
  });

  const ws = await listMarketingWorkspace(tx, companyId);
  return ws.automationRules.find(r => r.id === Number(ins.rows[0].id))!;
}

export async function toggleAutomationRule(
  tx: Transaction,
  companyId: number,
  ruleId: number,
  isEnabled: boolean
) {
  await tx.query(
    `UPDATE marketing_automation_rules SET is_enabled = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, ruleId, isEnabled]
  );
}

async function selectAudienceCustomers(
  tx: Transaction,
  companyId: number,
  segment: string
): Promise<Array<{ id: number; company_name: string; name: string; phone: string | null; balance: string }>> {
  let sql = `SELECT id, company_name, name, phone, balance::text FROM customers WHERE company_id = $1 AND is_active = TRUE`;
  if (segment === 'schools') {
    sql += ` AND customer_type = 'school'`;
  } else if (segment === 'corporate') {
    sql += ` AND customer_type = 'corporate'`;
  } else if (segment === 'individual') {
    sql += ` AND customer_type = 'individual'`;
  } else if (segment === 'overdue') {
    sql += ` AND balance > 0`;
  } else if (segment === 'referral_advocates') {
    sql += ` AND id IN (SELECT referrer_customer_id FROM referral_codes WHERE company_id = $1 AND referrer_customer_id IS NOT NULL)`;
  } else if (segment === 'top_spenders') {
    sql += ` AND id IN (SELECT customer_id FROM invoices WHERE company_id = $1 AND status <> 'voided' GROUP BY customer_id HAVING SUM(total) > 0)`;
  }
  sql += ` ORDER BY id ASC LIMIT 200`;
  const res = await tx.query<any>(sql, [companyId]);
  return res.rows.map(r => ({
    id: Number(r.id),
    company_name: r.company_name,
    name: r.name,
    phone: r.phone,
    balance: r.balance,
  }));
}

export async function runAutomationRuleNow(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  ruleId: number
) {
  const ruleRes = await tx.query<any>(
    `SELECT mr.*, mt.body, mt.channel, p.code AS promo_code, comp.name AS company_name, comp.currency_symbol
       FROM marketing_automation_rules mr
       JOIN marketing_templates mt ON mt.company_id = mr.company_id AND mt.id = mr.template_id
       JOIN companies comp ON comp.id = mr.company_id
       LEFT JOIN promotions p ON p.company_id = mt.company_id AND p.id = mt.promo_id
      WHERE mr.company_id = $1 AND mr.id = $2 FOR UPDATE OF mr`,
    [companyId, ruleId]
  );
  if (ruleRes.rows.length === 0) throw new AccountingError(404, 'Automation rule not found');
  const rule = ruleRes.rows[0];

  const segment =
    rule.trigger_event === 'invoice_overdue'
      ? 'overdue'
      : rule.trigger_event === 'referral_invite'
      ? 'all'
      : rule.target_segment || 'all';

  const customers = await selectAudienceCustomers(tx, companyId, segment);
  let queuedCount = 0;

  for (const c of customers) {
    const rendered = interpolateTemplate(rule.body, {
      customerName: c.company_name || c.name,
      contactName: c.name,
      companyName: rule.company_name,
      promoCode: rule.promo_code || 'PRINT10',
      balanceDue: `${rule.currency_symbol || 'K'} ${toMoneyNumber(parseDecimal4(c.balance)).toFixed(2)}`,
      referralCode: 'REFER2026',
    });
    const waUrl = buildWhatsAppUrl(c.phone, rendered);
    await tx.query(
      `INSERT INTO marketing_messages (
         company_id, rule_id, customer_id, recipient_name, recipient_phone,
         channel, rendered_body, whatsapp_url, status, sent_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent', NOW())`,
      [companyId, ruleId, c.id, c.company_name || c.name, c.phone, rule.channel || 'whatsapp', rendered, waUrl]
    );
    queuedCount++;
  }

  await tx.query(
    `UPDATE marketing_automation_rules SET runs_count = runs_count + 1, last_run_at = NOW() WHERE company_id = $1 AND id = $2`,
    [companyId, ruleId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'MARKETING_AUTOMATION_EXECUTED',
    tableName: 'marketing_automation_rules',
    recordId: ruleId,
    newValues: { queuedCount, triggerEvent: rule.trigger_event },
  });

  return { ruleId, queuedCount };
}

export async function createAndDispatchCampaign(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    name: string;
    channel?: 'whatsapp' | 'sms' | 'email';
    audienceSegment: string;
    templateId?: number | null;
    messageBody: string;
    promoId?: number | null;
    budgetAmount?: string | number;
    actualSpend?: string | number;
    expenseAccountId?: number | null;
    paymentAccountId?: number | null;
    dispatchNow?: boolean;
  }
) {
  const smartAccts = await resolveSmartOpsAccounts(tx, companyId, actor);
  const name = String(input.name || '').trim();
  const messageBody = String(input.messageBody || '').trim();
  if (!name || !messageBody) throw new AccountingError(400, 'Campaign name and message body are required');

  const budget4 = parseDecimal4(input.budgetAmount ?? 0);
  const actualSpend4 = parseDecimal4(input.actualSpend ?? 0);
  const expenseAccountId = input.expenseAccountId ? Number(input.expenseAccountId) : smartAccts.marketingExpense6450;
  const paymentAccountId = input.paymentAccountId ? Number(input.paymentAccountId) : smartAccts.bank1010;

  let expenseJeId: number | null = null;
  let expenseBankTxnId: number | null = null;

  if (actualSpend4 > 0n) {
    const payAcctRes = await tx.query<{ id: number; account_type: string; name: string }>(
      `SELECT id, account_type, name FROM accounts WHERE company_id = $1 AND id = $2 AND is_active = TRUE LIMIT 1`,
      [companyId, paymentAccountId]
    );
    if (payAcctRes.rows.length === 0) throw new AccountingError(400, 'Invalid payment account for marketing spend');

    const today = todayIsoDate();
    await assertPeriodOpenForDate(tx, companyId, today);
    const je = await postJournalEntry(tx, companyId, actor, {
      txnDate: today,
      description: `Marketing Campaign Spend — ${name}`,
      reference: `MKT-${Date.now().toString().slice(-6)}`,
      sourceType: 'marketing_expense',
      idempotencyKey: `mkt-spend-${companyId}-${name}-${Date.now()}`,
      lines: [
        {
          accountId: expenseAccountId,
          debit: formatDecimal4(actualSpend4),
          credit: '0.0000',
          description: `Marketing campaign spend: ${name}`,
        },
        {
          accountId: paymentAccountId,
          debit: '0.0000',
          credit: formatDecimal4(actualSpend4),
          description: `Paid from ${payAcctRes.rows[0].name}`,
        },
      ],
    });
    expenseJeId = je.transaction.id;

    if (payAcctRes.rows[0].account_type === 'Bank') {
      const baRes = await tx.query<{ id: number }>(
        `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
        [companyId, paymentAccountId]
      );
      const btIns = await tx.query<{ id: number }>(
        `INSERT INTO bank_transactions (
           company_id, account_id, bank_account_id, txn_date, payee, txn_type,
           ref_number, memo, amount, is_cleared, status, offset_account_id, journal_txn_id, category
         ) VALUES (
           $1, $2, $3, $4::DATE, 'WhatsApp / Marketing Campaign', 'Debit',
           $5, $6, $7::NUMERIC(19,4), FALSE, 'posted', $8, $9, 'Marketing & Advertising'
         ) RETURNING id`,
        [
          companyId,
          paymentAccountId,
          baRes.rows[0] ? Number(baRes.rows[0].id) : null,
          today,
          `MKT-${je.transaction.id}`,
          name,
          formatDecimal4(-actualSpend4),
          expenseAccountId,
          expenseJeId,
        ]
      );
      expenseBankTxnId = Number(btIns.rows[0].id);
    }
  }

  const dispatchNow = input.dispatchNow !== false;
  const compRes = await tx.query<{ name: string; currency_symbol: string }>(
    `SELECT name, currency_symbol FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  );
  const compName = compRes.rows[0]?.name || 'Our Print House';
  const sym = compRes.rows[0]?.currency_symbol || 'K';

  let promoCode = '';
  if (input.promoId) {
    const pRes = await tx.query<{ code: string }>(`SELECT code FROM promotions WHERE company_id = $1 AND id = $2`, [
      companyId,
      Number(input.promoId),
    ]);
    promoCode = pRes.rows[0]?.code || '';
  }

  const customers = dispatchNow ? await selectAudienceCustomers(tx, companyId, input.audienceSegment || 'all') : [];

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO marketing_campaigns (
       company_id, name, channel, audience_segment, template_id, message_body, promo_id,
       status, recipient_count, sent_count, budget_amount, actual_spend,
       expense_account_id, payment_account_id, expense_journal_txn_id, expense_bank_txn_id,
       dispatched_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11::NUMERIC(19,4), $12::NUMERIC(19,4),
       $13, $14, $15, $16,
       $17, $18
     ) RETURNING id`,
    [
      companyId,
      name,
      input.channel || 'whatsapp',
      input.audienceSegment || 'all',
      input.templateId ? Number(input.templateId) : null,
      messageBody,
      input.promoId ? Number(input.promoId) : null,
      dispatchNow ? 'dispatched' : 'draft',
      customers.length,
      dispatchNow ? customers.length : 0,
      formatDecimal4(budget4),
      formatDecimal4(actualSpend4),
      expenseAccountId,
      paymentAccountId,
      expenseJeId,
      expenseBankTxnId,
      dispatchNow ? new Date().toISOString() : null,
      actor.userId,
    ]
  );
  const campaignId = Number(ins.rows[0].id);

  for (const c of customers) {
    const rendered = interpolateTemplate(messageBody, {
      customerName: c.company_name || c.name,
      contactName: c.name,
      companyName: compName,
      promoCode: promoCode || 'SPECIAL',
      balanceDue: `${sym} ${toMoneyNumber(parseDecimal4(c.balance)).toFixed(2)}`,
    });
    const waUrl = buildWhatsAppUrl(c.phone, rendered);
    await tx.query(
      `INSERT INTO marketing_messages (
         company_id, campaign_id, customer_id, recipient_name, recipient_phone,
         channel, rendered_body, whatsapp_url, status, sent_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent', NOW())`,
      [companyId, campaignId, c.id, c.company_name || c.name, c.phone, input.channel || 'whatsapp', rendered, waUrl]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'MARKETING_CAMPAIGN_CREATED',
    tableName: 'marketing_campaigns',
    recordId: campaignId,
    newValues: { name, recipientCount: customers.length, actualSpend: formatDecimal4(actualSpend4), expenseJeId },
  });

  const ws = await listMarketingWorkspace(tx, companyId);
  return ws.campaigns.find(c => c.id === campaignId)!;
}

export async function sendDirectCustomerMessage(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId?: number | null;
    recipientName: string;
    recipientPhone?: string | null;
    channel?: 'whatsapp' | 'sms' | 'email';
    messageBody: string;
    posOrderId?: number | null;
  }
) {
  const body = String(input.messageBody || '').trim();
  const recipientName = String(input.recipientName || '').trim() || 'Customer';
  if (!body) throw new AccountingError(400, 'Message body cannot be empty');

  const waUrl = buildWhatsAppUrl(input.recipientPhone, body);
  const ins = await tx.query<{ id: number }>(
    `INSERT INTO marketing_messages (
       company_id, customer_id, recipient_name, recipient_phone, channel,
       rendered_body, whatsapp_url, status, pos_order_id, sent_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', $8, NOW()) RETURNING id`,
    [
      companyId,
      input.customerId ? Number(input.customerId) : null,
      recipientName,
      input.recipientPhone?.trim() || null,
      input.channel || 'whatsapp',
      body,
      waUrl,
      input.posOrderId ? Number(input.posOrderId) : null,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_MESSAGE_SENT',
    tableName: 'marketing_messages',
    recordId: Number(ins.rows[0].id),
    newValues: { recipientName, channel: input.channel || 'whatsapp' },
  });

  const ws = await listMarketingWorkspace(tx, companyId);
  return ws.messages.find(m => m.id === Number(ins.rows[0].id))!;
}

export async function updateMarketingMessageStatus(
  tx: Transaction,
  companyId: number,
  messageId: number,
  status: 'queued' | 'sent' | 'delivered' | 'clicked' | 'failed'
) {
  await tx.query(
    `UPDATE marketing_messages SET status = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, messageId, status]
  );
}

// ============================================================================
// PRICE CARDS (LIVE POS INVENTORY PRICING + PRESETS)
// ============================================================================

export async function getPriceCardWorkspace(tx: Transaction, companyId: number) {
  const [compRes, itemsRes, variantsRes, promosRes, presetsRes] = await Promise.all([
    tx.query<{
      name: string;
      phone: string | null;
      email: string | null;
      website: string | null;
      address: string | null;
      city_state_zip: string | null;
      currency_symbol: string;
      base_currency: string;
    }>(
      `SELECT name, phone, email, website, address, city_state_zip, currency_symbol, base_currency
         FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT id, sku, name, item_type, description, sales_price::text, on_hand::text, usage_unit, is_taxable
         FROM inventory_items
        WHERE company_id = $1
          AND is_active = TRUE
          AND item_type IN ('stationery', 'printed_product', 'printing_service')
        ORDER BY item_type ASC, name ASC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT id, item_id, variant_name, sku, sales_price::text, on_hand::text
         FROM item_variants
        WHERE company_id = $1 AND is_active = TRUE
        ORDER BY variant_name ASC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT id, code, name, discount_type, discount_value::text, ends_at::text
         FROM promotions
        WHERE company_id = $1 AND is_active = TRUE AND show_on_price_card = TRUE
        ORDER BY id DESC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT * FROM price_card_presets WHERE company_id = $1 ORDER BY id DESC`,
      [companyId]
    ),
  ]);

  const variantsByItem = new Map<number, any[]>();
  for (const v of variantsRes.rows) {
    const iid = Number(v.item_id);
    const list = variantsByItem.get(iid) ?? [];
    list.push({
      id: Number(v.id),
      variantName: v.variant_name,
      sku: v.sku,
      salesPrice: toMoneyNumber(parseDecimal4(v.sales_price)),
      onHand: Number(v.on_hand),
    });
    variantsByItem.set(iid, list);
  }

  return {
    company: compRes.rows[0] || {
      name: 'Printing Press',
      phone: '',
      email: '',
      website: '',
      address: '',
      city_state_zip: '',
      currency_symbol: 'K',
      base_currency: 'ZMW',
    },
    items: itemsRes.rows.map(it => ({
      id: Number(it.id),
      sku: it.sku,
      name: it.name,
      itemType: it.item_type,
      description: it.description || '',
      salesPrice: toMoneyNumber(parseDecimal4(it.sales_price)),
      onHand: Number(it.on_hand),
      unitLabel: it.usage_unit || 'Unit',
      isTaxable: Boolean(it.is_taxable),
      variants: variantsByItem.get(Number(it.id)) ?? [],
    })),
    promotions: promosRes.rows.map(p => ({
      id: Number(p.id),
      code: p.code,
      name: p.name,
      discountType: p.discount_type,
      discountValue: toMoneyNumber(parseDecimal4(p.discount_value)),
      endsAt: p.ends_at ? String(p.ends_at).slice(0, 10) : null,
    })),
    presets: presetsRes.rows.map(pr => ({
      id: Number(pr.id),
      title: pr.title,
      subtitle: pr.subtitle || '',
      theme: pr.theme,
      headline: pr.headline || '',
      whatsappNumber: pr.whatsapp_number || '',
      validUntil: pr.valid_until ? String(pr.valid_until).slice(0, 10) : null,
      itemIds: Array.isArray(pr.item_ids_json) ? pr.item_ids_json.map(Number) : [],
      promoId: pr.promo_id ? Number(pr.promo_id) : null,
      showVariants: Boolean(pr.show_variants),
    })),
  };
}

export async function savePriceCardPreset(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    title: string;
    subtitle?: string | null;
    theme?: string;
    headline?: string | null;
    whatsappNumber?: string | null;
    validUntil?: string | null;
    itemIds: number[];
    promoId?: number | null;
    showVariants?: boolean;
  }
) {
  const title = String(input.title || '').trim();
  if (!title) throw new AccountingError(400, 'Price card title is required');

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO price_card_presets (
       company_id, title, subtitle, theme, headline, whatsapp_number,
       valid_until, item_ids_json, promo_id, show_variants, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::DATE, $8::jsonb, $9, $10, $11)
     RETURNING id`,
    [
      companyId,
      title,
      input.subtitle?.trim() || null,
      input.theme || 'emerald_studio',
      input.headline?.trim() || null,
      input.whatsappNumber?.trim() || null,
      input.validUntil || null,
      JSON.stringify((input.itemIds || []).map(Number)),
      input.promoId ? Number(input.promoId) : null,
      input.showVariants !== false,
      actor.userId,
    ]
  );

  const ws = await getPriceCardWorkspace(tx, companyId);
  return ws.presets.find(p => p.id === Number(ins.rows[0].id))!;
}
