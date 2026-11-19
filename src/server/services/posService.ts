import { Transaction } from '@electric-sql/pglite';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal4, parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import {
  AccountingError,
  ActorContext,
  assertPeriodOpenForDate,
  JournalLineInput,
  postJournalEntry,
  reverseJournalEntry,
} from './accountingEngine.ts';
import {
  assertIsoDate,
  checkRouteIdempotency,
  computeTax4,
  divRoundBigInt,
  formatDecimal6,
  generateNextDocNumber,
  multiplyQty6ByRate4,
  parseDecimal6,
  recalculateCustomerBalance,
  resolveCommercialContext,
  saveRouteIdempotency,
  todayIsoDate,
} from './commercialHelpers.ts';
import { consumeLineInventory } from './salesService.ts';
import {
  accrueReferralEventAndJournal,
  buildWhatsAppUrl,
  evaluatePromotionDiscount4,
  evaluateReferralForOrder,
  interpolateTemplate,
  resolveSmartOpsAccounts,
} from './smartOpsService.ts';

export interface PosLineInput {
  itemId?: number | null;
  variantId?: number | null;
  variantName?: string | null;
  description: string;
  quantity: string | number;
  rate?: string | number;
  unitPrice?: string | number;
  taxable?: boolean;
  isTaxable?: boolean;
  incomeAccountId?: number | null;
}

export interface PosTenderInput {
  tenderMethod: 'Cash' | 'Mobile Money' | 'Card' | 'Bank Transfer' | 'On Account';
  depositAccountId?: number | null;
  amount: string | number;
  referenceNumber?: string | null;
}

export interface PosCheckoutInput {
  customerId?: number | null;
  walkInCustomerName?: string | null;
  walkInCustomerPhone?: string | null;
  orderDate?: string;
  taxRate?: string | number;
  isTaxExempt?: boolean;
  promoCode?: string | null;
  promoId?: number | null;
  referralCode?: string | null;
  tenderMode: 'cash' | 'mobile_money' | 'card' | 'bank_transfer' | 'split' | 'on_account';
  depositToAccountId?: number | null;
  amountTendered?: string | number;
  tenders?: PosTenderInput[];
  notes?: string | null;
  sendWhatsAppReceipt?: boolean;
  idempotencyKey?: string | null;
  lines: PosLineInput[];
}

export async function getPosCatalogAndOrders(tx: Transaction, companyId: number) {
  const [compRes, itemsRes, variantsRes, customersRes, accountsRes, promosRes, refCodesRes, ordersRes] =
    await Promise.all([
      tx.query<{
        name: string;
        phone: string | null;
        currency_symbol: string;
        base_currency: string;
        sales_tax_rate: string;
      }>(
        `SELECT name, phone, currency_symbol, base_currency, sales_tax_rate::text
           FROM companies WHERE id = $1 LIMIT 1`,
        [companyId]
      ),
      tx.query<any>(
        `SELECT id, sku, name, item_type, description, unit_cost::text, avg_cost::text,
                sales_price::text, on_hand::text, COALESCE(reserved_qty, 0)::text AS reserved_qty,
                usage_unit, is_taxable, income_account_id
           FROM inventory_items
          WHERE company_id = $1
            AND is_active = TRUE
            AND item_type IN ('stationery', 'printed_product', 'printing_service')
          ORDER BY name ASC`,
        [companyId]
      ),
      tx.query<any>(
        `SELECT id, item_id, variant_name, sku, unit_cost::text, sales_price::text,
                on_hand::text, COALESCE(reserved_qty, 0)::text AS reserved_qty
           FROM item_variants
          WHERE company_id = $1 AND is_active = TRUE
          ORDER BY variant_name ASC`,
        [companyId]
      ),
      tx.query<any>(
        `SELECT id, customer_type, name, company_name, phone, email, terms_label,
                credit_limit::text, balance::text, is_tax_exempt
           FROM customers
          WHERE company_id = $1 AND is_active = TRUE
          ORDER BY company_name ASC, id ASC`,
        [companyId]
      ),
      tx.query<any>(
        `SELECT id, code, name, account_type, balance::text
           FROM accounts
          WHERE company_id = $1 AND is_active = TRUE
            AND account_type IN ('Bank', 'OtherCurrentAsset')
          ORDER BY CASE WHEN code IN ('1050', '1030', '1010') THEN 0 ELSE 1 END, code ASC, name ASC`,
        [companyId]
      ),
      tx.query<any>(
        `SELECT id, code, name, discount_type, discount_value::text, min_order_amount::text, max_discount_amount::text
           FROM promotions
          WHERE company_id = $1 AND is_active = TRUE
          ORDER BY id DESC`,
        [companyId]
      ),
      tx.query<any>(
        `SELECT rc.id, rc.code, rc.referrer_name, rp.referee_discount_type, rp.referee_discount_value::text
           FROM referral_codes rc
           JOIN referral_programs rp ON rp.company_id = rc.company_id AND rp.id = rc.program_id
          WHERE rc.company_id = $1 AND rc.is_active = TRUE AND rp.is_active = TRUE
          ORDER BY rc.id DESC`,
        [companyId]
      ),
      tx.query<any>(
        `SELECT po.*, c.company_name AS customer_name, c.phone AS customer_phone,
                i.invoice_number, a.code AS deposit_account_code, a.name AS deposit_account_name
           FROM pos_orders po
           JOIN customers c ON c.company_id = po.company_id AND c.id = po.customer_id
           JOIN invoices i ON i.company_id = po.company_id AND i.id = po.invoice_id
           LEFT JOIN accounts a ON a.company_id = po.company_id AND a.id = po.deposit_to_account_id
          WHERE po.company_id = $1
          ORDER BY po.created_at DESC, po.id DESC
          LIMIT 50`,
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
      unitCost: Number(v.unit_cost),
      salesPrice: toMoneyNumber(parseDecimal4(v.sales_price)),
      onHand: Number(v.on_hand) - Number(v.reserved_qty),
    });
    variantsByItem.set(iid, list);
  }

  const orderIds = ordersRes.rows.map(o => Number(o.id));
  const tendersByOrder = new Map<number, any[]>();
  if (orderIds.length > 0) {
    const tRes = await tx.query<any>(
      `SELECT pt.*, a.code AS account_code, a.name AS account_name
         FROM pos_order_tenders pt
         JOIN accounts a ON a.company_id = pt.company_id AND a.id = pt.deposit_account_id
        WHERE pt.company_id = $1 AND pt.pos_order_id = ANY($2::BIGINT[])
        ORDER BY pt.id ASC`,
      [companyId, orderIds]
    );
    for (const t of tRes.rows) {
      const oid = Number(t.pos_order_id);
      const list = tendersByOrder.get(oid) ?? [];
      list.push({
        id: Number(t.id),
        tenderMethod: t.tender_method,
        depositAccountId: Number(t.deposit_account_id),
        accountLabel: t.account_code ? `${t.account_code} ${t.account_name}` : t.account_name,
        amount: toMoneyNumber(parseDecimal4(t.amount)),
        referenceNumber: t.reference_number || null,
      });
      tendersByOrder.set(oid, list);
    }
  }

  const comp = compRes.rows[0];
  return {
    company: {
      name: comp?.name || 'Printing Press',
      phone: comp?.phone || '',
      currencySymbol: comp?.currency_symbol || 'K',
      baseCurrency: comp?.base_currency || 'ZMW',
      defaultTaxRate: Number(comp?.sales_tax_rate ?? 0),
    },
    items: itemsRes.rows.map(it => ({
      id: Number(it.id),
      sku: it.sku,
      name: it.name,
      itemType: it.item_type,
      description: it.description || '',
      unitCost: Number(it.unit_cost),
      salesPrice: toMoneyNumber(parseDecimal4(it.sales_price)),
      availableQty:
        it.item_type === 'stationery'
          ? Math.max(0, Number(it.on_hand) - Number(it.reserved_qty))
          : null,
      unitLabel: it.usage_unit || 'Unit',
      isTaxable: Boolean(it.is_taxable),
      incomeAccountId: Number(it.income_account_id),
      variants: variantsByItem.get(Number(it.id)) ?? [],
    })),
    customers: customersRes.rows.map(c => ({
      id: Number(c.id),
      customerType: c.customer_type,
      name: c.name,
      companyName: c.company_name,
      phone: c.phone || '',
      email: c.email || '',
      terms: c.terms_label || 'Net 30',
      creditLimit: c.credit_limit !== null ? toMoneyNumber(parseDecimal4(c.credit_limit)) : null,
      balance: toMoneyNumber(parseDecimal4(c.balance)),
      isTaxExempt: Boolean(c.is_tax_exempt),
    })),
    depositAccounts: accountsRes.rows.map(a => ({
      id: Number(a.id),
      code: a.code || '',
      name: a.name,
      accountType: a.account_type,
      balance: toMoneyNumber(parseDecimal4(a.balance)),
    })),
    activePromotions: promosRes.rows.map(p => ({
      id: Number(p.id),
      code: p.code,
      name: p.name,
      discountType: p.discount_type,
      discountValue: toMoneyNumber(parseDecimal4(p.discount_value)),
      minOrderAmount: toMoneyNumber(parseDecimal4(p.min_order_amount)),
      maxDiscountAmount: p.max_discount_amount !== null ? toMoneyNumber(parseDecimal4(p.max_discount_amount)) : null,
    })),
    activeReferralCodes: refCodesRes.rows.map(r => ({
      id: Number(r.id),
      code: r.code,
      referrerName: r.referrer_name,
      refereeDiscountType: r.referee_discount_type,
      refereeDiscountValue: toMoneyNumber(parseDecimal4(r.referee_discount_value)),
    })),
    recentOrders: ordersRes.rows.map(o => ({
      id: Number(o.id),
      receiptNumber: o.receipt_number,
      invoiceId: Number(o.invoice_id),
      invoiceNumber: o.invoice_number,
      customerId: Number(o.customer_id),
      customerName: o.customer_name,
      customerPhone: o.customer_phone || '',
      orderDate: String(o.order_date).slice(0, 10),
      grossSubtotal: toMoneyNumber(parseDecimal4(o.gross_subtotal)),
      promoCode: o.promo_code || null,
      promoDiscount: toMoneyNumber(parseDecimal4(o.promo_discount)),
      referralDiscount: toMoneyNumber(parseDecimal4(o.referral_discount)),
      totalDiscount: toMoneyNumber(parseDecimal4(o.total_discount)),
      netSubtotal: toMoneyNumber(parseDecimal4(o.net_subtotal)),
      taxRate: Number(o.tax_rate),
      taxAmount: toMoneyNumber(parseDecimal4(o.tax_amount)),
      total: toMoneyNumber(parseDecimal4(o.total)),
      tenderMode: o.tender_mode,
      amountTendered: toMoneyNumber(parseDecimal4(o.amount_tendered)),
      changeDue: toMoneyNumber(parseDecimal4(o.change_due)),
      depositAccountLabel: o.deposit_account_code ? `${o.deposit_account_code} ${o.deposit_account_name}` : null,
      journalTxnId: o.journal_txn_id ? Number(o.journal_txn_id) : null,
      status: o.status,
      notes: o.notes || '',
      tenders: tendersByOrder.get(Number(o.id)) ?? [],
      createdAt: o.created_at,
    })),
  };
}

async function computePosPricing(
  tx: Transaction,
  companyId: number,
  orderDate: string,
  input: {
    lines: PosLineInput[];
    taxRate?: string | number;
    isTaxExempt?: boolean;
    promoCode?: string | null;
    promoId?: number | null;
    referralCode?: string | null;
  }
) {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'Cart cannot be empty', 'EMPTY_CART');
  }

  const preparedLines: Array<{
    itemId: number | null;
    variantId: number | null;
    variantName: string | null;
    itemType: string | null;
    description: string;
    quantity6: bigint;
    rate4: bigint;
    grossAmount4: bigint;
    netAmount4: bigint;
    taxable: boolean;
    incomeAccountId: number | null;
  }> = [];

  let grossSubtotal4 = 0n;
  for (let i = 0; i < input.lines.length; i++) {
    const raw = input.lines[i];
    const desc = String(raw.description || '').trim();
    if (!desc) throw new AccountingError(400, `Line ${i + 1}: description is required`);
    const qty6 = parseDecimal6(raw.quantity);
    if (qty6 <= 0n) throw new AccountingError(400, `Line ${i + 1}: quantity must be positive`);
    const effectiveRate = raw.rate ?? raw.unitPrice ?? '';
    const rate4 = parseDecimal4(effectiveRate);
    if (rate4 < 0n) throw new AccountingError(400, `Line ${i + 1}: rate cannot be negative`);
    const grossAmount4 = multiplyQty6ByRate4(qty6, rate4, 'HALF_EVEN');

    let itemType: string | null = null;
    let incomeAccountId = raw.incomeAccountId ? Number(raw.incomeAccountId) : null;
    if (raw.itemId) {
      const itRes = await tx.query<{ item_type: string; income_account_id: number }>(
        `SELECT item_type, income_account_id FROM inventory_items WHERE company_id = $1 AND id = $2 LIMIT 1`,
        [companyId, Number(raw.itemId)]
      );
      if (itRes.rows.length > 0) {
        itemType = itRes.rows[0].item_type;
        if (!incomeAccountId) incomeAccountId = Number(itRes.rows[0].income_account_id);
      }
    }

    grossSubtotal4 += grossAmount4;
    preparedLines.push({
      itemId: raw.itemId ? Number(raw.itemId) : null,
      variantId: raw.variantId ? Number(raw.variantId) : null,
      variantName: raw.variantName?.trim() || null,
      itemType,
      description: desc,
      quantity6: qty6,
      rate4,
      grossAmount4,
      netAmount4: grossAmount4,
      taxable: (raw.taxable !== undefined ? Boolean(raw.taxable) : Boolean(raw.isTaxable ?? true)) && !input.isTaxExempt,
      incomeAccountId,
    });
  }

  let promoMatch: Awaited<ReturnType<typeof evaluatePromotionDiscount4>> | null = null;
  if (input.promoId || (input.promoCode && input.promoCode.trim())) {
    promoMatch = await evaluatePromotionDiscount4(
      tx,
      companyId,
      { promoId: input.promoId, promoCode: input.promoCode },
      orderDate,
      grossSubtotal4,
      preparedLines.map(l => ({
        itemId: l.itemId,
        itemType: l.itemType,
        lineAmount4: l.grossAmount4,
        quantity6: l.quantity6,
        rate4: l.rate4,
      }))
    );
  }

  let referralMatch: Awaited<ReturnType<typeof evaluateReferralForOrder>> | null = null;
  if (input.referralCode && input.referralCode.trim()) {
    referralMatch = await evaluateReferralForOrder(
      tx,
      companyId,
      input.referralCode,
      orderDate,
      grossSubtotal4
    );
  }

  const promoDiscount4 = promoMatch ? promoMatch.discount4 : 0n;
  let referralDiscount4 = referralMatch ? referralMatch.refereeDiscount4 : 0n;
  if (promoDiscount4 + referralDiscount4 > grossSubtotal4) {
    referralDiscount4 = grossSubtotal4 - promoDiscount4;
  }
  const totalDiscount4 = promoDiscount4 + referralDiscount4;
  const netSubtotal4 = grossSubtotal4 - totalDiscount4;

  // Proportionally distribute discount across lines so invoice_lines.amount stays >= 0 and sums to netSubtotal4
  if (totalDiscount4 > 0n && grossSubtotal4 > 0n) {
    let allocatedDisc4 = 0n;
    for (let i = 0; i < preparedLines.length; i++) {
      const l = preparedLines[i];
      let lineDisc4: bigint;
      if (i === preparedLines.length - 1) {
        lineDisc4 = totalDiscount4 - allocatedDisc4;
      } else {
        lineDisc4 = divRoundBigInt(l.grossAmount4 * totalDiscount4, grossSubtotal4, 'HALF_EVEN');
      }
      if (lineDisc4 > l.grossAmount4) lineDisc4 = l.grossAmount4;
      allocatedDisc4 += lineDisc4;
      l.netAmount4 = l.grossAmount4 - lineDisc4;
    }
    // Fix any residual 0.0001 rounding remainder on largest line if needed
    const diff = totalDiscount4 - allocatedDisc4;
    if (diff !== 0n) {
      const target = preparedLines.find(l => l.netAmount4 >= diff) ?? preparedLines[0];
      target.netAmount4 -= diff;
    }
  }

  const taxRatePct6 = input.isTaxExempt ? 0n : parseDecimal6(input.taxRate ?? 0);
  const netTaxable4 = preparedLines.filter(l => l.taxable).reduce((s, l) => s + l.netAmount4, 0n);
  const taxAmount4 = computeTax4(netTaxable4, taxRatePct6, 'HALF_EVEN');
  const total4 = netSubtotal4 + taxAmount4;

  return {
    preparedLines,
    grossSubtotal4,
    promoMatch,
    promoDiscount4,
    referralMatch,
    referralDiscount4,
    totalDiscount4,
    netSubtotal4,
    taxRatePct6,
    taxAmount4,
    total4,
  };
}

export async function previewPosOrder(tx: Transaction, companyId: number, input: Partial<PosCheckoutInput>) {
  const orderDate = input.orderDate ? assertIsoDate(input.orderDate, 'orderDate') : todayIsoDate();
  const calc = await computePosPricing(tx, companyId, orderDate, {
    lines: input.lines || [],
    taxRate: input.taxRate,
    isTaxExempt: input.isTaxExempt,
    promoCode: input.promoCode,
    promoId: input.promoId,
    referralCode: input.referralCode,
  });

  return {
    grossSubtotal: toMoneyNumber(calc.grossSubtotal4),
    promoApplied: calc.promoMatch
      ? { id: calc.promoMatch.promotionId, code: calc.promoMatch.code, name: calc.promoMatch.name }
      : null,
    promoDiscount: toMoneyNumber(calc.promoDiscount4),
    referralApplied: calc.referralMatch
      ? {
          id: calc.referralMatch.referralCodeId,
          code: calc.referralMatch.code,
          referrerName: calc.referralMatch.referrerName,
          rewardAmount: toMoneyNumber(calc.referralMatch.referrerReward4),
        }
      : null,
    referralDiscount: toMoneyNumber(calc.referralDiscount4),
    totalDiscount: toMoneyNumber(calc.totalDiscount4),
    netSubtotal: toMoneyNumber(calc.netSubtotal4),
    taxAmount: toMoneyNumber(calc.taxAmount4),
    total: toMoneyNumber(calc.total4),
  };
}

async function resolveOrCreateWalkInCustomer(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  walkInName?: string | null,
  walkInPhone?: string | null
): Promise<{ id: number; company_name: string; phone: string | null; credit_limit: string | null; balance: string; is_tax_exempt: boolean; terms_label: string }> {
  const targetName = walkInName?.trim() || 'Walk-In Cash Customer';
  const existing = await tx.query<any>(
    `SELECT id, company_name, phone, credit_limit::text, balance::text, is_tax_exempt, terms_label
       FROM customers
      WHERE company_id = $1 AND LOWER(company_name) = LOWER($2)
      LIMIT 1 FOR UPDATE`,
    [companyId, targetName]
  );
  if (existing.rows.length > 0) {
    if (walkInPhone?.trim() && !existing.rows[0].phone) {
      await tx.query(`UPDATE customers SET phone = $3 WHERE company_id = $1 AND id = $2`, [
        companyId,
        Number(existing.rows[0].id),
        walkInPhone.trim(),
      ]);
      existing.rows[0].phone = walkInPhone.trim();
    }
    return existing.rows[0];
  }

  const ins = await tx.query<any>(
    `INSERT INTO customers (
       company_id, customer_type, name, company_name, phone, terms_label, is_tax_exempt, is_active
     ) VALUES ($1, 'individual', $2, $2, $3, 'Due on receipt', FALSE, TRUE)
     RETURNING id, company_name, phone, credit_limit::text, balance::text, is_tax_exempt, terms_label`,
    [companyId, targetName, walkInPhone?.trim() || null]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'POS_WALKIN_CUSTOMER_CREATED',
    tableName: 'customers',
    recordId: Number(ins.rows[0].id),
    newValues: { name: targetName },
  });

  return ins.rows[0];
}

export async function checkoutPosOrder(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: PosCheckoutInput
) {
  const idem = await checkRouteIdempotency<{ order: any }>(tx, companyId, 'pos_checkout', input.idempotencyKey, input);
  if (idem.hit) return { order: idem.response.order, idempotentReplay: true };

  const smartAccts = await resolveSmartOpsAccounts(tx, companyId, actor);
  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const orderDate = input.orderDate ? assertIsoDate(input.orderDate, 'orderDate') : todayIsoDate();
  await assertPeriodOpenForDate(tx, companyId, orderDate);

  // Resolve customer
  let customer: {
    id: number;
    company_name: string;
    phone: string | null;
    credit_limit: string | null;
    balance: string;
    is_tax_exempt: boolean;
    terms_label: string;
  };
  if (input.customerId) {
    const cRes = await tx.query<any>(
      `SELECT id, company_name, phone, credit_limit::text, balance::text, is_tax_exempt, terms_label
         FROM customers WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, Number(input.customerId)]
    );
    if (cRes.rows.length === 0) throw new AccountingError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
    customer = cRes.rows[0];
  } else {
    customer = await resolveOrCreateWalkInCustomer(
      tx,
      companyId,
      actor,
      input.walkInCustomerName,
      input.walkInCustomerPhone
    );
  }
  const customerId = Number(customer.id);

  const isTaxExempt = input.isTaxExempt !== undefined ? Boolean(input.isTaxExempt) : Boolean(customer.is_tax_exempt);
  const pricing = await computePosPricing(tx, companyId, orderDate, {
    lines: input.lines,
    taxRate: input.taxRate,
    isTaxExempt,
    promoCode: input.promoCode,
    promoId: input.promoId,
    referralCode: input.referralCode,
  });

  if (pricing.total4 <= 0n) {
    throw new AccountingError(400, 'POS order total must be greater than zero', 'ZERO_POS_ORDER');
  }

  const isOnAccount = input.tenderMode === 'on_account';
  if (isOnAccount && customer.credit_limit !== null) {
    const limit4 = parseDecimal4(customer.credit_limit);
    const nextAr4 = parseDecimal4(customer.balance) + pricing.total4;
    if (nextAr4 > limit4) {
      throw new AccountingError(
        409,
        `Sale exceeds ${customer.company_name}'s credit limit (${formatDecimal4(limit4)})`,
        'CREDIT_LIMIT_EXCEEDED'
      );
    }
  }

  // Build tender legs
  const defaultAccountForMethod = (method: PosTenderInput['tenderMethod']): number => {
    if (method === 'Cash') return smartAccts.cashDrawer1050;
    if (method === 'Mobile Money' || method === 'Card') return smartAccts.mobileClearing1030;
    if (method === 'Bank Transfer') return smartAccts.bank1010;
    return smartAccts.ar1100;
  };

  let tenderLegs: Array<{
    tenderMethod: PosTenderInput['tenderMethod'];
    depositAccountId: number;
    accountType: string;
    amount4: bigint;
    referenceNumber: string | null;
  }> = [];

  if (isOnAccount) {
    tenderLegs.push({
      tenderMethod: 'On Account',
      depositAccountId: smartAccts.ar1100,
      accountType: 'AccountsReceivable',
      amount4: pricing.total4,
      referenceNumber: null,
    });
  } else if (input.tenderMode === 'split' && Array.isArray(input.tenders) && input.tenders.length > 0) {
    let sumTenders4 = 0n;
    for (const rawT of input.tenders) {
      const amt4 = parseDecimal4(rawT.amount);
      if (amt4 <= 0n) continue;
      const acctId = rawT.depositAccountId ? Number(rawT.depositAccountId) : defaultAccountForMethod(rawT.tenderMethod);
      const acctRes = await tx.query<{ id: number; account_type: string }>(
        `SELECT id, account_type FROM accounts WHERE company_id = $1 AND id = $2 AND is_active = TRUE LIMIT 1`,
        [companyId, acctId]
      );
      if (acctRes.rows.length === 0 || !['Bank', 'OtherCurrentAsset'].includes(acctRes.rows[0].account_type)) {
        throw new AccountingError(400, `Tender account for ${rawT.tenderMethod} must be an active Bank or Cash account`);
      }
      sumTenders4 += amt4;
      tenderLegs.push({
        tenderMethod: rawT.tenderMethod,
        depositAccountId: acctId,
        accountType: acctRes.rows[0].account_type,
        amount4: amt4,
        referenceNumber: rawT.referenceNumber?.trim() || null,
      });
    }
    if (sumTenders4 !== pricing.total4) {
      throw new AccountingError(
        400,
        `Split tender total (${formatDecimal4(sumTenders4)}) must equal POS order total (${formatDecimal4(pricing.total4)})`,
        'TENDER_MISMATCH'
      );
    }
  } else {
    const methodMap: Record<string, PosTenderInput['tenderMethod']> = {
      cash: 'Cash',
      mobile_money: 'Mobile Money',
      card: 'Card',
      bank_transfer: 'Bank Transfer',
    };
    const method = methodMap[input.tenderMode] || 'Cash';
    const acctId = input.depositToAccountId ? Number(input.depositToAccountId) : defaultAccountForMethod(method);
    const acctRes = await tx.query<{ id: number; account_type: string }>(
      `SELECT id, account_type FROM accounts WHERE company_id = $1 AND id = $2 AND is_active = TRUE LIMIT 1`,
      [companyId, acctId]
    );
    if (acctRes.rows.length === 0 || !['Bank', 'OtherCurrentAsset'].includes(acctRes.rows[0].account_type)) {
      throw new AccountingError(400, 'Deposit account must be an active Bank or Cash account');
    }
    tenderLegs.push({
      tenderMethod: method,
      depositAccountId: acctId,
      accountType: acctRes.rows[0].account_type,
      amount4: pricing.total4,
      referenceNumber: input.tenders?.[0]?.referenceNumber?.trim() || null,
    });
  }

  const amountTendered4 =
    input.amountTendered !== undefined && input.amountTendered !== null && input.amountTendered !== ''
      ? parseDecimal4(input.amountTendered)
      : isOnAccount
      ? 0n
      : pricing.total4;
  if (!isOnAccount && input.tenderMode === 'cash' && amountTendered4 < pricing.total4) {
    throw new AccountingError(400, 'Cash tendered cannot be less than the order total', 'INSUFFICIENT_TENDER');
  }
  const changeDue4 = !isOnAccount && amountTendered4 > pricing.total4 ? amountTendered4 - pricing.total4 : 0n;

  // Generate invoice number & POS receipt number
  const receiptNumber = await generateNextDocNumber(tx, companyId, 'pos_orders', 'receipt_number', 'POS');
  const invoiceNumber = receiptNumber;

  const isSalesReceipt = !isOnAccount;
  const primaryDepositAcctId = isSalesReceipt ? tenderLegs[0].depositAccountId : null;

  const invIns = await tx.query<{ id: number }>(
    `INSERT INTO invoices (
       company_id, invoice_number, customer_id, invoice_date, due_date, terms_label,
       status, is_sales_receipt, is_tax_exempt, subtotal, tax_rate, tax_amount, total, total_cost,
       amount_paid, balance_due, notes, currency_code, exchange_rate, foreign_total, foreign_balance_due, deposit_to_account_id
     ) VALUES (
       $1, $2, $3, $4::DATE, $4::DATE, $5,
       $6, $7, $8, $9::NUMERIC(19,4), $10::NUMERIC(9,6), $11::NUMERIC(19,4), $12::NUMERIC(19,4), 0.0000,
       $13::NUMERIC(19,4), $14::NUMERIC(19,4), $15, $16, 1.000000, $12::NUMERIC(19,4), $14::NUMERIC(19,4), $17
     ) RETURNING id`,
    [
      companyId,
      invoiceNumber,
      customerId,
      orderDate,
      isSalesReceipt ? 'POS Immediate' : customer.terms_label || 'Net 30',
      isSalesReceipt ? 'paid' : 'sent',
      isSalesReceipt,
      isTaxExempt,
      formatDecimal4(pricing.netSubtotal4),
      formatDecimal6(pricing.taxRatePct6),
      formatDecimal4(pricing.taxAmount4),
      formatDecimal4(pricing.total4),
      formatDecimal4(isSalesReceipt ? pricing.total4 : 0n),
      formatDecimal4(isSalesReceipt ? 0n : pricing.total4),
      input.notes?.trim() || `POS Checkout ${receiptNumber}`,
      ctx.baseCurrency,
      primaryDepositAcctId,
    ]
  );
  const invoiceId = Number(invIns.rows[0].id);

  // Process lines, consume inventory & build Gross Revenue / COGS / Inventory GL maps
  const grossRevenueByAcct = new Map<number, bigint>();
  const cogsByAcct = new Map<number, bigint>();
  const invCreditByAcct = new Map<number, bigint>();
  let totalCost4 = 0n;

  for (let i = 0; i < pricing.preparedLines.length; i++) {
    const l = pricing.preparedLines[i];
    let incomeAcctId = l.incomeAccountId || smartAccts.revenue4000;
    let unitCost6 = 0n;
    let lineTotalCost4 = 0n;

    if (l.itemId) {
      const consumed = await consumeLineInventory(
        tx,
        companyId,
        isSalesReceipt ? 'sales_receipt' : 'invoice',
        invoiceId,
        {
          itemId: l.itemId,
          variantId: l.variantId,
          quantity6: l.quantity6,
          explicitUnitCost6: 0n,
        }
      );
      incomeAcctId = consumed.incomeAccountId;
      unitCost6 = consumed.lineUnitCost6;
      lineTotalCost4 = consumed.lineTotalCost4;
      if (consumed.inventoryCredit4 > 0n) {
        cogsByAcct.set(consumed.cogsAccountId, (cogsByAcct.get(consumed.cogsAccountId) ?? 0n) + consumed.inventoryCredit4);
        invCreditByAcct.set(consumed.assetAccountId, (invCreditByAcct.get(consumed.assetAccountId) ?? 0n) + consumed.inventoryCredit4);
      }
    }

    totalCost4 += lineTotalCost4;
    grossRevenueByAcct.set(incomeAcctId, (grossRevenueByAcct.get(incomeAcctId) ?? 0n) + l.grossAmount4);

    const netRate4 = l.quantity6 > 0n ? divRoundBigInt(l.netAmount4 * 1000000n, l.quantity6, 'HALF_EVEN') : l.rate4;
    await tx.query(
      `INSERT INTO invoice_lines (
         company_id, invoice_id, line_order, item_id, variant_id, variant_name, description,
         quantity, rate, amount, unit_cost, total_cost, taxable
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8::NUMERIC(19,6), $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11::NUMERIC(19,6), $12::NUMERIC(19,4), $13
       )`,
      [
        companyId,
        invoiceId,
        i + 1,
        l.itemId,
        l.variantId,
        l.variantName,
        l.description,
        formatDecimal6(l.quantity6),
        formatDecimal4(netRate4),
        formatDecimal4(l.netAmount4),
        formatDecimal6(unitCost6),
        formatDecimal4(lineTotalCost4),
        l.taxable,
      ]
    );
  }

  await tx.query(
    `UPDATE invoices SET total_cost = $3::NUMERIC(19,4) WHERE company_id = $1 AND id = $2`,
    [companyId, invoiceId, formatDecimal4(totalCost4)]
  );

  // Build balanced Double-Entry Journal for POS Sale
  const jeLines: JournalLineInput[] = [];
  for (const t of tenderLegs) {
    jeLines.push({
      accountId: t.depositAccountId,
      debit: formatDecimal4(t.amount4),
      credit: '0.0000',
      description: `POS ${t.tenderMethod} — ${receiptNumber}`,
      partyType: 'customer',
      partyId: customerId,
    });
  }

  if (pricing.promoDiscount4 > 0n) {
    jeLines.push({
      accountId: pricing.promoMatch?.discountAccountId || smartAccts.salesDiscounts4100,
      debit: formatDecimal4(pricing.promoDiscount4),
      credit: '0.0000',
      description: `Promo Discount (${pricing.promoMatch?.code}) — ${receiptNumber}`,
      partyType: 'customer',
      partyId: customerId,
    });
  }

  if (pricing.referralDiscount4 > 0n) {
    jeLines.push({
      accountId: smartAccts.salesDiscounts4100,
      debit: formatDecimal4(pricing.referralDiscount4),
      credit: '0.0000',
      description: `Referral Discount (${pricing.referralMatch?.code}) — ${receiptNumber}`,
      partyType: 'customer',
      partyId: customerId,
    });
  }

  for (const [acctId, amt4] of grossRevenueByAcct.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: acctId,
        debit: '0.0000',
        credit: formatDecimal4(amt4),
        description: `POS Gross Sales Revenue — ${receiptNumber}`,
        partyType: 'customer',
        partyId: customerId,
      });
    }
  }

  if (pricing.taxAmount4 > 0n) {
    jeLines.push({
      accountId: smartAccts.salesTax2200,
      debit: '0.0000',
      credit: formatDecimal4(pricing.taxAmount4),
      description: `POS Sales Tax Payable — ${receiptNumber}`,
    });
  }

  for (const [cogsAcct, amt4] of cogsByAcct.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: cogsAcct,
        debit: formatDecimal4(amt4),
        credit: '0.0000',
        description: `POS COGS — ${receiptNumber}`,
      });
    }
  }

  for (const [invAcct, amt4] of invCreditByAcct.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: invAcct,
        debit: '0.0000',
        credit: formatDecimal4(amt4),
        description: `POS Inventory Issued — ${receiptNumber}`,
      });
    }
  }

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate: orderDate,
    description: `POS Sale ${receiptNumber} — ${customer.company_name}`,
    reference: receiptNumber,
    sourceType: 'pos_sale',
    sourceId: invoiceId,
    idempotencyKey: `pos-je-${companyId}-${receiptNumber}`,
    lines: jeLines,
  });

  await tx.query(`UPDATE invoices SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    invoiceId,
    postedJe.transaction.id,
  ]);

  // Insert POS Order header
  const posIns = await tx.query<{ id: number }>(
    `INSERT INTO pos_orders (
       company_id, receipt_number, invoice_id, customer_id, order_date,
       gross_subtotal, promo_id, promo_code, promo_discount,
       referral_code_id, referral_discount, total_discount, net_subtotal,
       tax_rate, tax_amount, total, tender_mode, amount_tendered, change_due,
       deposit_to_account_id, journal_txn_id, status, notes, created_by
     ) VALUES (
       $1, $2, $3, $4, $5::DATE,
       $6::NUMERIC(19,4), $7, $8, $9::NUMERIC(19,4),
       $10, $11::NUMERIC(19,4), $12::NUMERIC(19,4), $13::NUMERIC(19,4),
       $14::NUMERIC(9,6), $15::NUMERIC(19,4), $16::NUMERIC(19,4), $17, $18::NUMERIC(19,4), $19::NUMERIC(19,4),
       $20, $21, $22, $23, $24
     ) RETURNING id`,
    [
      companyId,
      receiptNumber,
      invoiceId,
      customerId,
      orderDate,
      formatDecimal4(pricing.grossSubtotal4),
      pricing.promoMatch ? pricing.promoMatch.promotionId : null,
      pricing.promoMatch ? pricing.promoMatch.code : null,
      formatDecimal4(pricing.promoDiscount4),
      pricing.referralMatch ? pricing.referralMatch.referralCodeId : null,
      formatDecimal4(pricing.referralDiscount4),
      formatDecimal4(pricing.totalDiscount4),
      formatDecimal4(pricing.netSubtotal4),
      formatDecimal6(pricing.taxRatePct6),
      formatDecimal4(pricing.taxAmount4),
      formatDecimal4(pricing.total4),
      input.tenderMode,
      formatDecimal4(amountTendered4),
      formatDecimal4(changeDue4),
      tenderLegs[0].depositAccountId,
      postedJe.transaction.id,
      isOnAccount ? 'on_account' : 'completed',
      input.notes?.trim() || null,
      actor.userId,
    ]
  );
  const posOrderId = Number(posIns.rows[0].id);

  // Record tender legs & bank register transactions for Bank accounts
  for (const t of tenderLegs) {
    let bankTxnId: number | null = null;
    if (t.accountType === 'Bank') {
      const baRes = await tx.query<{ id: number }>(
        `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
        [companyId, t.depositAccountId]
      );
      const btIns = await tx.query<{ id: number }>(
        `INSERT INTO bank_transactions (
           company_id, account_id, bank_account_id, txn_date, payee, txn_type,
           ref_number, memo, amount, is_cleared, status, offset_account_id, journal_txn_id, customer_id, category
         ) VALUES (
           $1, $2, $3, $4::DATE, $5, 'Sales Receipt',
           $6, $7, $8::NUMERIC(19,4), FALSE, 'posted', $9, $10, $11, 'POS Sales Revenue'
         ) RETURNING id`,
        [
          companyId,
          t.depositAccountId,
          baRes.rows[0] ? Number(baRes.rows[0].id) : null,
          orderDate,
          customer.company_name,
          receiptNumber,
          `POS ${t.tenderMethod}${t.referenceNumber ? ` (${t.referenceNumber})` : ''}`,
          formatDecimal4(t.amount4),
          smartAccts.revenue4000,
          postedJe.transaction.id,
          customerId,
        ]
      );
      bankTxnId = Number(btIns.rows[0].id);
      await tx.query(
        `UPDATE invoices SET deposited_bank_txn_id = COALESCE(deposited_bank_txn_id, $3) WHERE company_id = $1 AND id = $2`,
        [companyId, invoiceId, bankTxnId]
      );
    }

    await tx.query(
      `INSERT INTO pos_order_tenders (
         company_id, pos_order_id, tender_method, deposit_account_id, amount, reference_number, bank_txn_id
       ) VALUES ($1, $2, $3, $4, $5::NUMERIC(19,4), $6, $7)`,
      [
        companyId,
        posOrderId,
        t.tenderMethod,
        t.depositAccountId,
        formatDecimal4(t.amount4),
        t.referenceNumber,
        bankTxnId,
      ]
    );
  }

  // Record promotion redemption
  if (pricing.promoMatch) {
    await tx.query(
      `INSERT INTO promotion_redemptions (
         company_id, promotion_id, pos_order_id, invoice_id, customer_id, discount_amount, order_subtotal
       ) VALUES ($1, $2, $3, $4, $5, $6::NUMERIC(19,4), $7::NUMERIC(19,4))`,
      [
        companyId,
        pricing.promoMatch.promotionId,
        posOrderId,
        invoiceId,
        customerId,
        formatDecimal4(pricing.promoDiscount4),
        formatDecimal4(pricing.netSubtotal4),
      ]
    );
    await tx.query(
      `UPDATE promotions SET usage_count = usage_count + 1 WHERE company_id = $1 AND id = $2`,
      [companyId, pricing.promoMatch.promotionId]
    );
  }

  // Record referral event & accrue reward expense/liability in GL
  if (pricing.referralMatch) {
    await accrueReferralEventAndJournal(tx, companyId, actor, {
      referralCodeId: pricing.referralMatch.referralCodeId,
      programId: pricing.referralMatch.programId,
      campaignId: pricing.referralMatch.campaignId,
      refereeCustomerId: customerId,
      posOrderId,
      invoiceId,
      qualifyingAmount4: pricing.netSubtotal4,
      refereeDiscount4: pricing.referralDiscount4,
      rewardAmount4: pricing.referralMatch.referrerReward4,
      expenseAccountId: pricing.referralMatch.expenseAccountId,
      liabilityAccountId: pricing.referralMatch.liabilityAccountId,
      txnDate: orderDate,
      reference: receiptNumber,
      notes: `POS referral via ${pricing.referralMatch.code}`,
      status: 'approved',
    });
  }

  await recalculateCustomerBalance(tx, companyId, customerId);

  // Auto-trigger post_pos_receipt WhatsApp automation if enabled (or requested)
  if (input.sendWhatsAppReceipt || customer.phone) {
    const autoRules = await tx.query<any>(
      `SELECT mr.id, mt.body, comp.name AS company_name, comp.currency_symbol
         FROM marketing_automation_rules mr
         JOIN marketing_templates mt ON mt.company_id = mr.company_id AND mt.id = mr.template_id
         JOIN companies comp ON comp.id = mr.company_id
        WHERE mr.company_id = $1 AND mr.trigger_event = 'post_pos_receipt' AND mr.is_enabled = TRUE
        LIMIT 1`,
      [companyId]
    );
    if (autoRules.rows.length > 0) {
      const rule = autoRules.rows[0];
      const rendered = interpolateTemplate(rule.body, {
        customerName: customer.company_name,
        companyName: rule.company_name,
        receiptNumber,
        total: `${rule.currency_symbol || 'K'} ${toMoneyNumber(pricing.total4).toFixed(2)}`,
      });
      await tx.query(
        `INSERT INTO marketing_messages (
           company_id, rule_id, customer_id, recipient_name, recipient_phone,
           channel, rendered_body, whatsapp_url, status, pos_order_id, sent_at
         ) VALUES ($1, $2, $3, $4, $5, 'whatsapp', $6, $7, 'sent', $8, NOW())`,
        [
          companyId,
          Number(rule.id),
          customerId,
          customer.company_name,
          customer.phone,
          rendered,
          buildWhatsAppUrl(customer.phone, rendered),
          posOrderId,
        ]
      );
      await tx.query(
        `UPDATE marketing_automation_rules SET runs_count = runs_count + 1, last_run_at = NOW() WHERE company_id = $1 AND id = $2`,
        [companyId, Number(rule.id)]
      );
    }
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'POS_ORDER_COMPLETED',
    tableName: 'pos_orders',
    recordId: posOrderId,
    newValues: {
      receiptNumber,
      invoiceId,
      total: formatDecimal4(pricing.total4),
      totalDiscount: formatDecimal4(pricing.totalDiscount4),
      tenderMode: input.tenderMode,
      journalTxnId: postedJe.transaction.id,
    },
  });

  const catalog = await getPosCatalogAndOrders(tx, companyId);
  const created = catalog.recentOrders.find(o => o.id === posOrderId)!;

  await saveRouteIdempotency(
    tx,
    companyId,
    'pos_checkout',
    input.idempotencyKey,
    idem.payloadHash,
    201,
    { order: created },
    actor.userId
  );

  return { order: created, idempotentReplay: false };
}

export async function voidPosOrder(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  posOrderId: number,
  reason?: string
) {
  const poRes = await tx.query<any>(
    `SELECT * FROM pos_orders WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, posOrderId]
  );
  if (poRes.rows.length === 0) throw new AccountingError(404, 'POS order not found');
  const po = poRes.rows[0];
  if (po.status === 'voided') throw new AccountingError(409, 'POS order is already voided');

  let reversalJournalId: number | null = null;
  if (po.journal_txn_id) {
    const revJe = await reverseJournalEntry(tx, companyId, actor, Number(po.journal_txn_id), {
      reason: reason || `Void POS Order ${po.receipt_number}`,
    });
    reversalJournalId = revJe?.reversal?.id ?? null;
  }

  // Void linked bank transactions
  await tx.query(
    `UPDATE bank_transactions SET status = 'voided'
      WHERE company_id = $1 AND journal_txn_id = $2`,
    [companyId, po.journal_txn_id]
  );

  // Restore inventory movements
  const movs = await tx.query<any>(
    `SELECT id, item_id, variant_id, quantity_delta::text, unit_cost::text
       FROM inventory_movements
      WHERE company_id = $1
        AND source_type IN ('invoice', 'sales_receipt')
        AND source_id = $2
        AND reverses_movement_id IS NULL`,
    [companyId, Number(po.invoice_id)]
  );
  for (const m of movs.rows) {
    const restoreQty6 = -parseDecimal6(m.quantity_delta);
    const itRes = await tx.query<{ on_hand: string; item_type: string }>(
      `SELECT on_hand::text, item_type FROM inventory_items WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, Number(m.item_id)]
    );
    if (itRes.rows.length > 0 && ['raw_material', 'stationery'].includes(itRes.rows[0].item_type)) {
      const nextBal6 = parseDecimal6(itRes.rows[0].on_hand) + restoreQty6;
      await tx.query(`UPDATE inventory_items SET on_hand = $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`, [
        companyId,
        Number(m.item_id),
        formatDecimal6(nextBal6),
      ]);
      if (m.variant_id) {
        const vRes = await tx.query<{ on_hand: string }>(
          `SELECT on_hand::text FROM item_variants WHERE company_id = $1 AND id = $2 FOR UPDATE`,
          [companyId, Number(m.variant_id)]
        );
        if (vRes.rows.length > 0) {
          const nextVBal6 = parseDecimal6(vRes.rows[0].on_hand) + restoreQty6;
          await tx.query(`UPDATE item_variants SET on_hand = $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`, [
            companyId,
            Number(m.variant_id),
            formatDecimal6(nextVBal6),
          ]);
        }
      }
      await tx.query(
        `INSERT INTO inventory_movements (
           company_id, item_id, variant_id, movement_type, quantity_delta, unit_cost,
           balance_qty, balance_avg_cost, source_type, source_id, reverses_movement_id
         ) VALUES ($1, $2, $3, 'void', $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), $5::NUMERIC(19,6), 'sales_receipt', $7, $8)`,
        [
          companyId,
          Number(m.item_id),
          m.variant_id ? Number(m.variant_id) : null,
          formatDecimal6(restoreQty6),
          m.unit_cost,
          formatDecimal6(nextBal6),
          Number(po.invoice_id),
          Number(m.id),
        ]
      );
    }
  }

  await tx.query(`UPDATE invoices SET status = 'voided' WHERE company_id = $1 AND id = $2`, [
    companyId,
    Number(po.invoice_id),
  ]);
  await tx.query(`UPDATE pos_orders SET status = 'voided' WHERE company_id = $1 AND id = $2`, [
    companyId,
    posOrderId,
  ]);

  if (po.promo_id) {
    await tx.query(
      `UPDATE promotions SET usage_count = GREATEST(0, usage_count - 1) WHERE company_id = $1 AND id = $2`,
      [companyId, Number(po.promo_id)]
    );
  }

  // Void referral event if any and reverse unpaid accrual JE
  const refEvs = await tx.query<any>(
    `SELECT * FROM referral_events WHERE company_id = $1 AND pos_order_id = $2 AND status <> 'voided' FOR UPDATE`,
    [companyId, posOrderId]
  );
  for (const rev of refEvs.rows) {
    if (rev.accrual_journal_txn_id && !rev.payout_journal_txn_id) {
      await reverseJournalEntry(tx, companyId, actor, Number(rev.accrual_journal_txn_id), {
        reason: `Void POS Order ${po.receipt_number}`,
      });
    }
    await tx.query(`UPDATE referral_events SET status = 'voided' WHERE company_id = $1 AND id = $2`, [
      companyId,
      Number(rev.id),
    ]);
    await tx.query(
      `UPDATE referral_codes
          SET conversions_count = GREATEST(0, conversions_count - 1),
              total_referred_revenue = GREATEST(0, total_referred_revenue - $3::NUMERIC(19,4)),
              total_rewards_earned = GREATEST(0, total_rewards_earned - $4::NUMERIC(19,4)),
              reward_balance = GREATEST(0, reward_balance - $4::NUMERIC(19,4))
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(rev.referral_code_id), rev.qualifying_amount, rev.reward_amount]
    );
  }

  await recalculateCustomerBalance(tx, companyId, Number(po.customer_id));

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'POS_ORDER_VOIDED',
    tableName: 'pos_orders',
    recordId: posOrderId,
    newValues: { receiptNumber: po.receipt_number, reason },
  });

  return { voided: true, posOrderId, receiptNumber: po.receipt_number, reversalJournalId };
}
