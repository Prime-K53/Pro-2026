import { Transaction } from '@electric-sql/pglite';
import { writeAuditLog } from '../audit.ts';
import {
  AccountingError,
  ActorContext,
  JournalLineInput,
  postJournalEntry,
  reverseJournalEntry,
} from './accountingEngine.ts';
import {
  addDaysToIso,
  advanceRecurringDate,
  assertIsoDate,
  checkRouteIdempotency,
  computeTax4,
  convertForeign4ToBase4,
  divRoundBigInt,
  formatDecimal6,
  generateNextDocNumber,
  multiplyQty6ByRate4,
  parseDecimal6,
  recalculateCustomerBalance,
  resolveCommercialContext,
  resolveExchangeRate6,
  saveRouteIdempotency,
  todayIsoDate,
} from './commercialHelpers.ts';
import {
  absBigInt,
  formatDecimal2,
  formatDecimal4,
  parseDecimal4,
  toMoneyNumber,
} from '../lib/decimal.ts';

// ============================================================================
// CUSTOMERS & RESELLER PERMITS & PAYMENT TERMS
// ============================================================================

export async function listPaymentTerms(tx: Transaction, companyId: number) {
  const res = await tx.query<{
    id: number;
    name: string;
    kind: string;
    net_days: number;
    discount_percent: string;
    discount_days: number;
  }>(
    `SELECT id, name, kind, net_days, discount_percent::text, discount_days
       FROM payment_terms
      WHERE company_id = $1 AND is_active = TRUE
      ORDER BY net_days ASC, id ASC`,
    [companyId]
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    netDays: Number(r.net_days),
    discountPercent: Number(r.discount_percent),
    discountDays: Number(r.discount_days),
  }));
}

export async function listCustomers(tx: Transaction, companyId: number, includeInactive = false) {
  const res = await tx.query<{
    id: number;
    parent_customer_id: number | null;
    customer_type: string;
    name: string;
    company_name: string;
    email: string | null;
    phone: string | null;
    billing_address: string | null;
    shipping_address: string | null;
    payment_term_id: number | null;
    terms_label: string;
    credit_limit: string | null;
    balance: string;
    is_tax_exempt: boolean;
    notes: string | null;
    is_active: boolean;
  }>(
    `SELECT id, parent_customer_id, customer_type, name, company_name, email, phone,
            billing_address, shipping_address, payment_term_id, terms_label,
            credit_limit::text, balance::text, is_tax_exempt, notes, is_active
       FROM customers
      WHERE company_id = $1 ${includeInactive ? '' : 'AND is_active = TRUE'}
      ORDER BY LOWER(company_name) ASC, id ASC`,
    [companyId]
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    parentCustomerId: r.parent_customer_id !== null ? Number(r.parent_customer_id) : null,
    customerType: r.customer_type,
    name: r.name,
    companyName: r.company_name,
    email: r.email || '',
    phone: r.phone || '',
    billingAddress: r.billing_address || '',
    shippingAddress: r.shipping_address || '',
    paymentTermId: r.payment_term_id !== null ? Number(r.payment_term_id) : null,
    terms: r.terms_label,
    creditLimit: r.credit_limit !== null ? Number(r.credit_limit) : null,
    balance: toMoneyNumber(parseDecimal4(r.balance)),
    balanceExact: r.balance,
    isTaxExempt: Boolean(r.is_tax_exempt),
    notes: r.notes || '',
    isActive: Boolean(r.is_active),
  }));
}

export async function createCustomer(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    name: string;
    companyName?: string;
    customerType?: string;
    parentCustomerId?: number | null;
    email?: string | null;
    phone?: string | null;
    billingAddress?: string | null;
    shippingAddress?: string | null;
    terms?: string | null;
    paymentTermId?: number | null;
    creditLimit?: string | number | null;
    isTaxExempt?: boolean;
    notes?: string | null;
  }
) {
  const name = String(input.name || '').trim();
  const companyName = String(input.companyName || name).trim();
  if (!name) throw new AccountingError(400, 'Customer name is required', 'MISSING_CUSTOMER_NAME');

  const customerType = input.customerType || 'corporate';
  if (!['school', 'corporate', 'individual', 'government', 'nonprofit'].includes(customerType)) {
    throw new AccountingError(400, `Invalid customerType '${customerType}'`, 'INVALID_CUSTOMER_TYPE');
  }

  const creditLimitStr =
    input.creditLimit !== undefined && input.creditLimit !== null && input.creditLimit !== ''
      ? formatDecimal4(parseDecimal4(input.creditLimit))
      : null;

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO customers (
       company_id, parent_customer_id, customer_type, name, company_name, email, phone,
       billing_address, shipping_address, payment_term_id, terms_label, credit_limit,
       is_tax_exempt, notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::NUMERIC(19,4), $13, $14)
     RETURNING id`,
    [
      companyId,
      input.parentCustomerId ? Number(input.parentCustomerId) : null,
      customerType,
      name,
      companyName,
      input.email?.trim() || null,
      input.phone?.trim() || null,
      input.billingAddress?.trim() || null,
      input.shippingAddress?.trim() || null,
      input.paymentTermId ? Number(input.paymentTermId) : null,
      input.terms?.trim() || 'Net 30',
      creditLimitStr,
      Boolean(input.isTaxExempt),
      input.notes?.trim() || null,
    ]
  );

  const id = Number(ins.rows[0].id);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_CREATED',
    tableName: 'customers',
    recordId: id,
    newValues: { name, companyName, customerType },
  });

  const all = await listCustomers(tx, companyId, true);
  return all.find(c => c.id === id)!;
}

export async function updateCustomer(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  customerId: number,
  updates: Record<string, any>
) {
  const cur = await tx.query<any>(
    `SELECT * FROM customers WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, customerId]
  );
  if (cur.rows.length === 0) throw new AccountingError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
  const row = cur.rows[0];

  const nextName = updates.name !== undefined ? String(updates.name).trim() : row.name;
  if (!nextName) throw new AccountingError(400, 'Customer name cannot be empty');

  const nextCreditLimit =
    updates.creditLimit !== undefined
      ? updates.creditLimit === null || updates.creditLimit === ''
        ? null
        : formatDecimal4(parseDecimal4(updates.creditLimit))
      : row.credit_limit;

  await tx.query(
    `UPDATE customers
        SET name = $3,
            company_name = $4,
            customer_type = $5,
            email = $6,
            phone = $7,
            billing_address = $8,
            shipping_address = $9,
            terms_label = $10,
            credit_limit = $11::NUMERIC(19,4),
            is_tax_exempt = $12,
            notes = $13,
            is_active = $14
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      customerId,
      nextName,
      updates.companyName !== undefined ? String(updates.companyName).trim() || nextName : row.company_name,
      updates.customerType ?? row.customer_type,
      updates.email !== undefined ? updates.email?.trim() || null : row.email,
      updates.phone !== undefined ? updates.phone?.trim() || null : row.phone,
      updates.billingAddress !== undefined ? updates.billingAddress?.trim() || null : row.billing_address,
      updates.shippingAddress !== undefined ? updates.shippingAddress?.trim() || null : row.shipping_address,
      updates.terms !== undefined ? updates.terms?.trim() || 'Net 30' : row.terms_label,
      nextCreditLimit,
      updates.isTaxExempt !== undefined ? Boolean(updates.isTaxExempt) : row.is_tax_exempt,
      updates.notes !== undefined ? updates.notes?.trim() || null : row.notes,
      updates.isActive !== undefined ? Boolean(updates.isActive) : row.is_active,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_UPDATED',
    tableName: 'customers',
    recordId: customerId,
    oldValues: { name: row.name, terms: row.terms_label, isActive: row.is_active },
    newValues: updates,
  });

  const all = await listCustomers(tx, companyId, true);
  return all.find(c => c.id === customerId)!;
}

export async function listResellerPermits(tx: Transaction, companyId: number, customerId?: number) {
  const res = await tx.query<{
    id: number;
    customer_id: number;
    customer_name: string;
    jurisdiction: string;
    permit_number: string;
    issued_at: string | null;
    expires_at: string | null;
    last_verified_at: string | null;
    notes: string | null;
    is_active: boolean;
  }>(
    `SELECT rp.id, rp.customer_id, c.company_name AS customer_name, rp.jurisdiction,
            rp.permit_number, rp.issued_at::text, rp.expires_at::text, rp.last_verified_at::text,
            rp.notes, rp.is_active
       FROM reseller_permits rp
       JOIN customers c ON c.company_id = rp.company_id AND c.id = rp.customer_id
      WHERE rp.company_id = $1 ${customerId ? 'AND rp.customer_id = $2' : ''}
      ORDER BY rp.id DESC`,
    customerId ? [companyId, customerId] : [companyId]
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    customerId: Number(r.customer_id),
    customerName: r.customer_name,
    jurisdiction: r.jurisdiction,
    permitNumber: r.permit_number,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    lastVerifiedAt: r.last_verified_at,
    notes: r.notes,
    isActive: Boolean(r.is_active),
  }));
}

export async function createResellerPermit(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    jurisdiction: string;
    permitNumber: string;
    issuedAt?: string | null;
    expiresAt?: string | null;
    notes?: string | null;
  }
) {
  const ins = await tx.query<{ id: number }>(
    `INSERT INTO reseller_permits (
       company_id, customer_id, jurisdiction, permit_number, issued_at, expires_at,
       last_verified_at, verified_by, notes
     ) VALUES ($1, $2, $3, $4, $5::DATE, $6::DATE, NOW(), $7, $8)
     RETURNING id`,
    [
      companyId,
      Number(input.customerId),
      String(input.jurisdiction || 'ZRA').trim(),
      String(input.permitNumber || '').trim(),
      input.issuedAt || null,
      input.expiresAt || null,
      actor.userId,
      input.notes?.trim() || null,
    ]
  );
  await tx.query(`UPDATE customers SET is_tax_exempt = TRUE WHERE company_id = $1 AND id = $2`, [
    companyId,
    Number(input.customerId),
  ]);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'RESELLER_PERMIT_ADDED',
    tableName: 'reseller_permits',
    recordId: Number(ins.rows[0].id),
    newValues: input,
  });
  const all = await listResellerPermits(tx, companyId, Number(input.customerId));
  return all.find(p => p.id === Number(ins.rows[0].id))!;
}

// ============================================================================
// INVOICING & SALES RECEIPTS (GL + Perpetual Inventory + FX + Voiding)
// ============================================================================

export interface InvoiceLineInput {
  itemId?: number | null;
  variantId?: number | null;
  variantName?: string | null;
  description: string;
  quantity: string | number;
  rate: string | number;
  unitCost?: string | number | null;
  taxable?: boolean;
  incomeAccountId?: number | null;
  classId?: number | null;
}

export interface CreateInvoiceInput {
  customerId: number;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  terms?: string | null;
  poNumber?: string | null;
  isSalesReceipt?: boolean;
  isTaxExempt?: boolean;
  taxRate?: string | number | null;
  depositToAccountId?: number | null;
  currencyCode?: string | null;
  exchangeRate?: string | number | null;
  sourceEstimateId?: number | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  lines: InvoiceLineInput[];
}

async function consumeLineInventory(
  tx: Transaction,
  companyId: number,
  sourceType: 'invoice' | 'sales_receipt',
  sourceId: number,
  line: { itemId: number; variantId: number | null; quantity6: bigint; explicitUnitCost6: bigint }
): Promise<{
  itemType: string;
  incomeAccountId: number;
  cogsAccountId: number;
  assetAccountId: number;
  lineUnitCost6: bigint;
  lineTotalCost4: bigint;
  inventoryCredit4: bigint;
}> {
  const itemRes = await tx.query<{
    id: number;
    name: string;
    item_type: string;
    unit_cost: string;
    avg_cost: string;
    on_hand: string;
    reserved_qty: string;
    conversion_factor: string;
    asset_account_id: number;
    cogs_account_id: number;
    income_account_id: number;
  }>(
    `SELECT id, name, item_type, unit_cost::text, avg_cost::text, on_hand::text,
            COALESCE(reserved_qty, 0)::text AS reserved_qty,
            conversion_factor::text, asset_account_id, cogs_account_id, income_account_id
       FROM inventory_items
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, line.itemId]
  );
  if (itemRes.rows.length === 0) {
    throw new AccountingError(404, `Inventory item ${line.itemId} not found`, 'ITEM_NOT_FOUND');
  }
  const item = itemRes.rows[0];
  if (item.item_type === 'raw_material') {
    throw new AccountingError(
      400,
      `Raw material "${item.name}" is for internal production only and cannot be invoiced.`,
      'RAW_MATERIAL_NOT_INVOICEABLE'
    );
  }

  let unitCost6 = line.explicitUnitCost6 > 0n ? line.explicitUnitCost6 : parseDecimal6(item.unit_cost);
  let inventoryCredit4 = 0n;

  if (item.item_type === 'stationery') {
    if (line.variantId) {
      const vRes = await tx.query<{ id: number; on_hand: string; reserved_qty: string; unit_cost: string }>(
        `SELECT id, on_hand::text, COALESCE(reserved_qty, 0)::text AS reserved_qty, unit_cost::text
           FROM item_variants WHERE company_id = $1 AND id = $2 AND item_id = $3 FOR UPDATE`,
        [companyId, line.variantId, line.itemId]
      );
      if (vRes.rows.length === 0) throw new AccountingError(404, `Item variant ${line.variantId} not found`);
      const v = vRes.rows[0];
      if (parseDecimal6(v.unit_cost) > 0n && line.explicitUnitCost6 === 0n) {
        unitCost6 = parseDecimal6(v.unit_cost);
      }
      const prevVarOnHand6 = parseDecimal6(v.on_hand);
      const prevVarReserved6 = parseDecimal6(v.reserved_qty);
      const availVar6 = prevVarOnHand6 - prevVarReserved6;
      if (availVar6 < line.quantity6) {
        throw new AccountingError(
          409,
          `Insufficient available stock on variant for "${item.name}" (available: ${formatDecimal6(availVar6)})`,
          prevVarReserved6 > 0n ? 'INSUFFICIENT_AVAILABLE_STOCK' : 'INSUFFICIENT_STOCK'
        );
      }
      const nextVarOnHand6 = prevVarOnHand6 - line.quantity6;
      await tx.query(
        `UPDATE item_variants SET on_hand = $4::NUMERIC(19,6) WHERE company_id = $1 AND id = $2 AND item_id = $3`,
        [companyId, line.variantId, line.itemId, formatDecimal6(nextVarOnHand6)]
      );
    }

    const prevOnHand6 = parseDecimal6(item.on_hand);
    const prevReserved6 = parseDecimal6(item.reserved_qty);
    const availOnHand6 = prevOnHand6 - prevReserved6;
    if (availOnHand6 < line.quantity6) {
      throw new AccountingError(
        409,
        `Insufficient available stock on hand for "${item.name}" (on hand: ${formatDecimal6(prevOnHand6)}, reserved: ${formatDecimal6(prevReserved6)})`,
        prevReserved6 > 0n ? 'INSUFFICIENT_AVAILABLE_STOCK' : 'INSUFFICIENT_STOCK'
      );
    }
    const nextOnHand6 = prevOnHand6 - line.quantity6;
    await tx.query(
      `UPDATE inventory_items SET on_hand = $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`,
      [companyId, line.itemId, formatDecimal6(nextOnHand6)]
    );

    const lineCost4 = divRoundBigInt(line.quantity6 * unitCost6, 100000000n, 'HALF_EVEN');
    inventoryCredit4 = lineCost4;

    await tx.query(
      `INSERT INTO inventory_movements (
         company_id, item_id, variant_id, movement_type, quantity_delta, unit_cost,
         balance_qty, balance_avg_cost, source_type, source_id
       ) VALUES ($1, $2, $3, 'sale', $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), $5::NUMERIC(19,6), $7, $8)`,
      [
        companyId,
        line.itemId,
        line.variantId,
        formatDecimal6(-line.quantity6),
        formatDecimal6(unitCost6),
        formatDecimal6(nextOnHand6),
        sourceType,
        sourceId,
      ]
    );

    return {
      itemType: item.item_type,
      incomeAccountId: Number(item.income_account_id),
      cogsAccountId: Number(item.cogs_account_id),
      assetAccountId: Number(item.asset_account_id),
      lineUnitCost6: unitCost6,
      lineTotalCost4: lineCost4,
      inventoryCredit4,
    };
  }

  // printed_product or printing_service: check BOM raw materials to compute & consume exact usage
  const bomRes = await tx.query<{ raw_material_item_id: number; quantity_per_unit: string }>(
    `SELECT raw_material_item_id, quantity_per_unit::text
       FROM item_bom_components
      WHERE company_id = $1 AND parent_item_id = $2
        AND ($3::BIGINT IS NULL OR parent_variant_id = $3 OR parent_variant_id IS NULL)
      ORDER BY id ASC`,
    [companyId, line.itemId, line.variantId]
  );

  if (bomRes.rows.length > 0) {
    let computedUnitCost6 = 0n;
    let totalConsumedCost4 = 0n;

    for (const comp of bomRes.rows) {
      const rmRes = await tx.query<{
        id: number;
        name: string;
        unit_cost: string;
        on_hand: string;
        reserved_qty: string;
        conversion_factor: string;
      }>(
        `SELECT id, name, unit_cost::text, on_hand::text, COALESCE(reserved_qty, 0)::text AS reserved_qty, conversion_factor::text
           FROM inventory_items
          WHERE company_id = $1 AND id = $2
          FOR UPDATE`,
        [companyId, Number(comp.raw_material_item_id)]
      );
      if (rmRes.rows.length === 0) continue;
      const rm = rmRes.rows[0];
      const rmPurchaseCost6 = parseDecimal6(rm.unit_cost);
      const factor6 = parseDecimal6(rm.conversion_factor);
      const usageCost6 = divRoundBigInt(rmPurchaseCost6 * 1000000n, factor6, 'HALF_EVEN');
      const bomQty6 = parseDecimal6(comp.quantity_per_unit);
      computedUnitCost6 += divRoundBigInt(usageCost6 * bomQty6, 1000000n, 'HALF_EVEN');

      // Total usage units = line.quantity * bomQty; convert to purchase units = totalUsage / factor
      const totalUsage6 = divRoundBigInt(line.quantity6 * bomQty6, 1000000n, 'HALF_EVEN');
      const purchaseUnitsUsed6 = divRoundBigInt(totalUsage6 * 1000000n, factor6, 'HALF_EVEN');
      const rmOnHand6 = parseDecimal6(rm.on_hand);
      const rmReserved6 = parseDecimal6(rm.reserved_qty);
      const rmAvailable6 = rmOnHand6 - rmReserved6;
      if (rmReserved6 > 0n && rmAvailable6 < purchaseUnitsUsed6) {
        throw new AccountingError(
          409,
          `Raw material "${rm.name}" has insufficient unreserved stock (available: ${formatDecimal6(rmAvailable6)}, required: ${formatDecimal6(purchaseUnitsUsed6)})`,
          'INSUFFICIENT_AVAILABLE_STOCK'
        );
      }
      const nextRmOnHand6 = rmAvailable6 >= purchaseUnitsUsed6 ? rmOnHand6 - purchaseUnitsUsed6 : rmOnHand6 >= purchaseUnitsUsed6 ? rmOnHand6 - purchaseUnitsUsed6 : 0n;
      const actualDeducted6 = rmOnHand6 - nextRmOnHand6;

      if (actualDeducted6 > 0n) {
        await tx.query(
          `UPDATE inventory_items SET on_hand = $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`,
          [companyId, Number(rm.id), formatDecimal6(nextRmOnHand6)]
        );
        await tx.query(
          `INSERT INTO inventory_movements (
             company_id, item_id, movement_type, quantity_delta, unit_cost,
             balance_qty, balance_avg_cost, source_type, source_id
           ) VALUES ($1, $2, 'production_consume', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $4::NUMERIC(19,6), $6, $7)`,
          [
            companyId,
            Number(rm.id),
            formatDecimal6(-actualDeducted6),
            formatDecimal6(rmPurchaseCost6),
            formatDecimal6(nextRmOnHand6),
            sourceType,
            sourceId,
          ]
        );
        totalConsumedCost4 += divRoundBigInt(actualDeducted6 * rmPurchaseCost6, 100000000n, 'HALF_EVEN');
      }
    }

    if (line.explicitUnitCost6 === 0n && computedUnitCost6 > 0n) {
      unitCost6 = computedUnitCost6;
    }
    const lineCost4 = divRoundBigInt(line.quantity6 * unitCost6, 100000000n, 'HALF_EVEN');
    return {
      itemType: item.item_type,
      incomeAccountId: Number(item.income_account_id),
      cogsAccountId: Number(item.cogs_account_id),
      assetAccountId: Number(item.asset_account_id),
      lineUnitCost6: unitCost6,
      lineTotalCost4: lineCost4,
      inventoryCredit4: totalConsumedCost4,
    };
  }

  const fallbackCost4 = divRoundBigInt(line.quantity6 * unitCost6, 100000000n, 'HALF_EVEN');
  return {
    itemType: item.item_type,
    incomeAccountId: Number(item.income_account_id),
    cogsAccountId: Number(item.cogs_account_id),
    assetAccountId: Number(item.asset_account_id),
    lineUnitCost6: unitCost6,
    lineTotalCost4: fallbackCost4,
    inventoryCredit4: 0n,
  };
}

export async function listInvoices(
  tx: Transaction,
  companyId: number,
  options: { customerId?: number; status?: string; isSalesReceipt?: boolean } = {}
) {
  const conds = ['i.company_id = $1'];
  const params: unknown[] = [companyId];
  let idx = 2;
  if (options.customerId) {
    conds.push(`i.customer_id = $${idx++}`);
    params.push(options.customerId);
  }
  if (options.status) {
    conds.push(`i.status = $${idx++}`);
    params.push(options.status);
  }
  if (options.isSalesReceipt !== undefined) {
    conds.push(`i.is_sales_receipt = $${idx++}`);
    params.push(options.isSalesReceipt);
  }

  const res = await tx.query<any>(
    `SELECT i.id, i.company_id, i.invoice_number, i.customer_id, c.company_name AS customer_name,
            c.name AS customer_contact, i.invoice_date::text, i.due_date::text,
            i.terms_label, i.po_number, i.status, i.is_sales_receipt, i.is_tax_exempt,
            i.currency_code, i.exchange_rate::text, i.foreign_total::text, i.foreign_balance_due::text,
            i.subtotal::text, i.tax_rate::text, i.tax_amount::text, i.total::text,
            i.total_cost::text, i.gross_profit::text, i.amount_paid::text, i.balance_due::text,
            i.journal_txn_id, i.deposit_to_account_id, i.source_estimate_id, i.notes,
            i.created_at::text
       FROM invoices i
       JOIN customers c ON c.company_id = i.company_id AND c.id = i.customer_id
      WHERE ${conds.join(' AND ')}
      ORDER BY i.invoice_date DESC, i.id DESC`,
    params
  );

  if (res.rows.length === 0) return [];
  const ids = res.rows.map(r => Number(r.id));
  const linesRes = await tx.query<any>(
    `SELECT id, invoice_id, line_order, item_id, variant_id, variant_name, description,
            quantity::text, rate::text, amount::text, unit_cost::text, total_cost::text, taxable, class_id
       FROM invoice_lines
      WHERE company_id = $1 AND invoice_id = ANY($2::BIGINT[])
      ORDER BY invoice_id ASC, line_order ASC, id ASC`,
    [companyId, ids]
  );

  const linesByInv = new Map<number, any[]>();
  for (const l of linesRes.rows) {
    const invId = Number(l.invoice_id);
    const list = linesByInv.get(invId) ?? [];
    list.push({
      id: Number(l.id),
      lineOrder: Number(l.line_order),
      itemId: l.item_id !== null ? Number(l.item_id) : null,
      variantId: l.variant_id !== null ? Number(l.variant_id) : null,
      variantName: l.variant_name,
      description: l.description,
      quantity: Number(l.quantity),
      rate: toMoneyNumber(parseDecimal4(l.rate)),
      amount: toMoneyNumber(parseDecimal4(l.amount)),
      unitCost: Number(l.unit_cost),
      totalCost: toMoneyNumber(parseDecimal4(l.total_cost)),
      taxable: Boolean(l.taxable),
    });
    linesByInv.set(invId, list);
  }

  return res.rows.map(r => ({
    id: Number(r.id),
    company_id: Number(r.company_id),
    invoice_number: r.invoice_number,
    invoiceNumber: r.invoice_number,
    customer_id: Number(r.customer_id),
    customerId: Number(r.customer_id),
    customer_name: r.customer_name,
    customerName: r.customer_name,
    invoice_date: r.invoice_date,
    date: r.invoice_date,
    due_date: r.due_date,
    dueDate: r.due_date,
    terms: r.terms_label,
    poNumber: r.po_number,
    status: r.status,
    isSalesReceipt: Boolean(r.is_sales_receipt),
    isTaxExempt: Boolean(r.is_tax_exempt),
    currencyCode: r.currency_code,
    exchangeRate: Number(r.exchange_rate),
    foreignTotal: toMoneyNumber(parseDecimal4(r.foreign_total)),
    foreignBalanceDue: toMoneyNumber(parseDecimal4(r.foreign_balance_due)),
    subtotal: r.subtotal,
    subtotalNum: toMoneyNumber(parseDecimal4(r.subtotal)),
    tax_amount: r.tax_amount,
    taxRate: Number(r.tax_rate),
    taxAmountNum: toMoneyNumber(parseDecimal4(r.tax_amount)),
    total: r.total,
    totalNum: toMoneyNumber(parseDecimal4(r.total)),
    total_cost: r.total_cost,
    totalCostNum: toMoneyNumber(parseDecimal4(r.total_cost)),
    gross_profit: r.gross_profit,
    grossProfitNum: toMoneyNumber(parseDecimal4(r.gross_profit)),
    amountPaidNum: toMoneyNumber(parseDecimal4(r.amount_paid)),
    balance_due: r.balance_due,
    balanceDueNum: toMoneyNumber(parseDecimal4(r.balance_due)),
    journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
    depositToAccountId: r.deposit_to_account_id !== null ? Number(r.deposit_to_account_id) : null,
    sourceEstimateId: r.source_estimate_id !== null ? Number(r.source_estimate_id) : null,
    notes: r.notes || '',
    lines: linesByInv.get(Number(r.id)) ?? [],
  }));
}

export async function createInvoiceOrSalesReceipt(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: CreateInvoiceInput
) {
  const isSalesReceipt = Boolean(input.isSalesReceipt);
  const routeKey = isSalesReceipt ? 'sales_receipt_create' : 'invoice_create';
  const idem = await checkRouteIdempotency<{ invoice: any }>(tx, companyId, routeKey, input.idempotencyKey, input);
  if (idem.hit) {
    return { invoice: idem.response.invoice, idempotentReplay: true };
  }

  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new AccountingError(400, 'Valid customerId is required', 'INVALID_CUSTOMER');
  }

  const custRes = await tx.query<{
    id: number;
    company_name: string;
    terms_label: string;
    credit_limit: string | null;
    balance: string;
    is_tax_exempt: boolean;
  }>(
    `SELECT id, company_name, terms_label, credit_limit::text, balance::text, is_tax_exempt
       FROM customers WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, customerId]
  );
  if (custRes.rows.length === 0) {
    throw new AccountingError(404, 'Customer not found in active company', 'CUSTOMER_NOT_FOUND');
  }
  const customer = custRes.rows[0];

  const invoiceDate = input.invoiceDate ? assertIsoDate(input.invoiceDate, 'invoiceDate') : todayIsoDate();
  const dueDate = input.dueDate
    ? assertIsoDate(input.dueDate, 'dueDate')
    : isSalesReceipt
    ? invoiceDate
    : addDaysToIso(invoiceDate, 30);
  if (dueDate < invoiceDate) {
    throw new AccountingError(400, 'dueDate must be on or after invoiceDate', 'INVALID_DUE_DATE');
  }

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'At least one line item is required', 'EMPTY_LINES');
  }

  const fx = await resolveExchangeRate6(
    tx,
    companyId,
    input.currencyCode,
    ctx.baseCurrency,
    invoiceDate,
    input.exchangeRate
  );

  const invoiceNumber = input.invoiceNumber?.trim()
    ? input.invoiceNumber.trim()
    : await generateNextDocNumber(
        tx,
        companyId,
        'invoices',
        'invoice_number',
        isSalesReceipt ? 'SR' : 'INV'
      );

  const dup = await tx.query<{ id: number }>(
    `SELECT id FROM invoices WHERE company_id = $1 AND invoice_number = $2 LIMIT 1`,
    [companyId, invoiceNumber]
  );
  if (dup.rows.length > 0) {
    throw new AccountingError(409, `Document number ${invoiceNumber} already exists`, 'DUPLICATE_INVOICE_NUMBER');
  }

  const isTaxExempt = input.isTaxExempt !== undefined ? Boolean(input.isTaxExempt) : Boolean(customer.is_tax_exempt);
  const taxRatePct6 = isTaxExempt ? 0n : parseDecimal6(input.taxRate ?? 0);

  let depositAccountId: number | null = null;
  let depositAccountType: string | null = null;
  if (isSalesReceipt) {
    depositAccountId = input.depositToAccountId ? Number(input.depositToAccountId) : ctx.bank1010;
    const bankCheck = await tx.query<{ id: number; account_type: string }>(
      `SELECT id, account_type FROM accounts WHERE company_id = $1 AND id = $2 AND is_active = TRUE`,
      [companyId, depositAccountId]
    );
    if (bankCheck.rows.length === 0 || !['Bank', 'OtherCurrentAsset'].includes(bankCheck.rows[0].account_type)) {
      throw new AccountingError(400, 'Sales receipt depositToAccountId must be an active Bank/Cash account');
    }
    depositAccountType = bankCheck.rows[0].account_type;
  }

  // First compute foreign line amounts
  let foreignSubtotal4 = 0n;
  let foreignTaxable4 = 0n;
  const preparedLines: Array<{
    itemId: number | null;
    variantId: number | null;
    variantName: string | null;
    description: string;
    quantity6: bigint;
    foreignRate4: bigint;
    foreignAmount4: bigint;
    baseAmount4: bigint;
    explicitUnitCost6: bigint;
    taxable: boolean;
    incomeAccountId: number;
    classId: number | null;
  }> = [];

  for (let i = 0; i < input.lines.length; i++) {
    const raw = input.lines[i];
    const desc = String(raw.description || '').trim();
    if (!desc) throw new AccountingError(400, `Line ${i + 1}: description is required`);
    const qty6 = parseDecimal6(raw.quantity);
    if (qty6 <= 0n) throw new AccountingError(400, `Line ${i + 1}: quantity must be > 0`);
    const rate4 = parseDecimal4(raw.rate);
    if (rate4 < 0n) throw new AccountingError(400, `Line ${i + 1}: rate cannot be negative`);
    const foreignAmount4 = multiplyQty6ByRate4(qty6, rate4, ctx.roundingMode);
    const baseAmount4 = convertForeign4ToBase4(foreignAmount4, fx.rate6, ctx.roundingMode);
    const taxable = Boolean(raw.taxable) && !isTaxExempt;

    foreignSubtotal4 += foreignAmount4;
    if (taxable) foreignTaxable4 += foreignAmount4;

    preparedLines.push({
      itemId: raw.itemId ? Number(raw.itemId) : null,
      variantId: raw.variantId ? Number(raw.variantId) : null,
      variantName: raw.variantName?.trim() || null,
      description: desc,
      quantity6: qty6,
      foreignRate4: rate4,
      foreignAmount4,
      baseAmount4,
      explicitUnitCost6: parseDecimal6(raw.unitCost ?? 0),
      taxable,
      incomeAccountId: raw.incomeAccountId ? Number(raw.incomeAccountId) : ctx.revenue4000,
      classId: raw.classId ? Number(raw.classId) : null,
    });
  }

  const foreignTax4 = computeTax4(foreignTaxable4, taxRatePct6, ctx.roundingMode);
  const foreignTotal4 = foreignSubtotal4 + foreignTax4;
  if (foreignTotal4 <= 0n) {
    throw new AccountingError(400, 'Invoice/Receipt total must be greater than zero', 'ZERO_INVOICE');
  }

  const baseSubtotal4 = preparedLines.reduce((s, l) => s + l.baseAmount4, 0n);
  const baseTax4 = convertForeign4ToBase4(foreignTax4, fx.rate6, ctx.roundingMode);
  const baseTotal4 = baseSubtotal4 + baseTax4;

  // Enforce Customer Credit Limit for open AR invoices
  if (!isSalesReceipt && customer.credit_limit !== null) {
    const limit4 = parseDecimal4(customer.credit_limit);
    const nextAr4 = parseDecimal4(customer.balance) + baseTotal4;
    if (nextAr4 > limit4) {
      throw new AccountingError(
        409,
        `Invoice exceeds ${customer.company_name}'s credit limit (${formatDecimal2(limit4)}).`,
        'CREDIT_LIMIT_EXCEEDED'
      );
    }
  }

  const amountPaid4 = isSalesReceipt ? baseTotal4 : 0n;
  const balanceDue4 = isSalesReceipt ? 0n : baseTotal4;
  const foreignBalanceDue4 = isSalesReceipt ? 0n : foreignTotal4;
  const initialStatus = isSalesReceipt ? 'paid' : 'sent';

  // Insert invoice header first so movements can reference invoice.id
  const hdrIns = await tx.query<{ id: number }>(
    `INSERT INTO invoices (
       company_id, invoice_number, customer_id, invoice_date, due_date, terms_label, po_number,
       status, is_sales_receipt, is_tax_exempt, subtotal, tax_rate, tax_amount, total, total_cost,
       amount_paid, balance_due, source_estimate_id, notes,
       currency_code, exchange_rate, foreign_total, foreign_balance_due, deposit_to_account_id
     ) VALUES (
       $1, $2, $3, $4::DATE, $5::DATE, $6, $7,
       $8, $9, $10, $11::NUMERIC(19,4), $12::NUMERIC(9,6), $13::NUMERIC(19,4), $14::NUMERIC(19,4), 0.0000,
       $15::NUMERIC(19,4), $16::NUMERIC(19,4), $17, $18,
       $19, $20::NUMERIC(19,6), $21::NUMERIC(19,4), $22::NUMERIC(19,4), $23
     ) RETURNING id`,
    [
      companyId,
      invoiceNumber,
      customerId,
      invoiceDate,
      dueDate,
      input.terms?.trim() || customer.terms_label || 'Net 30',
      input.poNumber?.trim() || null,
      initialStatus,
      isSalesReceipt,
      isTaxExempt,
      formatDecimal4(baseSubtotal4),
      formatDecimal6(taxRatePct6),
      formatDecimal4(baseTax4),
      formatDecimal4(baseTotal4),
      formatDecimal4(amountPaid4),
      formatDecimal4(balanceDue4),
      input.sourceEstimateId ? Number(input.sourceEstimateId) : null,
      input.notes?.trim() || null,
      fx.currencyCode,
      fx.rateStr,
      formatDecimal4(foreignTotal4),
      formatDecimal4(foreignBalanceDue4),
      depositAccountId,
    ]
  );
  const invoiceId = Number(hdrIns.rows[0].id);

  // Process lines, inventory deductions & build GL lines
  const revenueByAcct = new Map<number, bigint>();
  const cogsByAcct = new Map<number, bigint>();
  const invCreditByAcct = new Map<number, bigint>();
  let totalCost4 = 0n;

  for (let i = 0; i < preparedLines.length; i++) {
    const l = preparedLines[i];
    let incomeAcctId = l.incomeAccountId;
    let unitCost6 = l.explicitUnitCost6;
    let lineTotalCost4 = divRoundBigInt(l.quantity6 * unitCost6, 100000000n, ctx.roundingMode);

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
          explicitUnitCost6: l.explicitUnitCost6,
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
    revenueByAcct.set(incomeAcctId, (revenueByAcct.get(incomeAcctId) ?? 0n) + l.baseAmount4);

    const baseRate4 = convertForeign4ToBase4(l.foreignRate4, fx.rate6, ctx.roundingMode);
    await tx.query(
      `INSERT INTO invoice_lines (
         company_id, invoice_id, line_order, item_id, variant_id, variant_name, description,
         quantity, rate, amount, unit_cost, total_cost, taxable, class_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8::NUMERIC(19,6), $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11::NUMERIC(19,6), $12::NUMERIC(19,4), $13, $14
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
        formatDecimal4(baseRate4),
        formatDecimal4(l.baseAmount4),
        formatDecimal6(unitCost6),
        formatDecimal4(lineTotalCost4),
        l.taxable,
        l.classId,
      ]
    );
  }

  await tx.query(
    `UPDATE invoices SET total_cost = $3::NUMERIC(19,4) WHERE company_id = $1 AND id = $2`,
    [companyId, invoiceId, formatDecimal4(totalCost4)]
  );

  // Build Double-Entry Journal through Accounting Engine
  const jeLines: JournalLineInput[] = [
    {
      accountId: isSalesReceipt ? depositAccountId! : ctx.ar1100,
      debit: formatDecimal4(baseTotal4),
      credit: '0.0000',
      description: `${isSalesReceipt ? 'Sales Receipt' : 'Accounts Receivable'} — ${invoiceNumber}`,
      partyType: 'customer',
      partyId: customerId,
    },
  ];

  for (const [acctId, amt4] of revenueByAcct.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: acctId,
        debit: '0.0000',
        credit: formatDecimal4(amt4),
        description: `Sales Revenue — ${invoiceNumber}`,
        partyType: 'customer',
        partyId: customerId,
      });
    }
  }

  if (baseTax4 > 0n) {
    jeLines.push({
      accountId: ctx.salesTax2200,
      debit: '0.0000',
      credit: formatDecimal4(baseTax4),
      description: `Sales Tax Payable — ${invoiceNumber}`,
    });
  }

  for (const [cogsAcct, amt4] of cogsByAcct.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: cogsAcct,
        debit: formatDecimal4(amt4),
        credit: '0.0000',
        description: `COGS — ${invoiceNumber}`,
      });
    }
  }
  for (const [invAcct, amt4] of invCreditByAcct.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: invAcct,
        debit: '0.0000',
        credit: formatDecimal4(amt4),
        description: `Inventory Issued — ${invoiceNumber}`,
      });
    }
  }

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate: invoiceDate,
    description: `${isSalesReceipt ? 'Sales Receipt' : 'Invoice'} ${invoiceNumber} — ${customer.company_name}`,
    reference: invoiceNumber,
    sourceType: isSalesReceipt ? 'sales_receipt' : 'invoice',
    sourceId: invoiceId,
    idempotencyKey: `${routeKey}-je-${companyId}-${invoiceNumber}`,
    lines: jeLines,
  });

  await tx.query(
    `UPDATE invoices SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, invoiceId, postedJe.transaction.id]
  );

  // If Sales Receipt deposited directly into a Bank account, also post to Bank Register immediately.
  // When deposited into OtherCurrentAsset (e.g. 1050 Undeposited Funds), it enters Bank Register upon batched recordDeposit.
  if (isSalesReceipt && depositAccountId && depositAccountType === 'Bank') {
    const baRes = await tx.query<{ id: number }>(
      `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
      [companyId, depositAccountId]
    );
    const btIns = await tx.query<{ id: number }>(
      `INSERT INTO bank_transactions (
         company_id, account_id, bank_account_id, txn_date, payee, txn_type,
         ref_number, memo, amount, is_cleared, status, offset_account_id, journal_txn_id, customer_id, category
       ) VALUES (
         $1, $2, $3, $4::DATE, $5, 'Sales Receipt',
         $6, $7, $8::NUMERIC(19,4), FALSE, 'posted', $9, $10, $11, 'Printing & Sales Revenue'
       ) RETURNING id`,
      [
        companyId,
        depositAccountId,
        baRes.rows[0] ? Number(baRes.rows[0].id) : null,
        invoiceDate,
        customer.company_name,
        invoiceNumber,
        input.notes?.trim() || `Point-of-sale receipt ${invoiceNumber}`,
        formatDecimal4(baseTotal4),
        ctx.revenue4000,
        postedJe.transaction.id,
        customerId,
      ]
    );
    await tx.query(
      `UPDATE invoices SET deposited_bank_txn_id = $3 WHERE company_id = $1 AND id = $2`,
      [companyId, invoiceId, Number(btIns.rows[0].id)]
    );
  }

  if (input.sourceEstimateId) {
    await tx.query(
      `UPDATE estimates SET status = 'invoiced', decided_at = COALESCE(decided_at, NOW())
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(input.sourceEstimateId)]
    );
  }

  await recalculateCustomerBalance(tx, companyId, customerId);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: isSalesReceipt ? 'SALES_RECEIPT_POSTED' : 'INVOICE_POSTED',
    tableName: 'invoices',
    recordId: invoiceId,
    newValues: {
      invoiceNumber,
      customerId,
      total: formatDecimal4(baseTotal4),
      currencyCode: fx.currencyCode,
      journalTxnId: postedJe.transaction.id,
    },
  });

  const fullList = await listInvoices(tx, companyId, { customerId });
  const created = fullList.find(inv => inv.id === invoiceId)!;
  await saveRouteIdempotency(
    tx,
    companyId,
    routeKey,
    input.idempotencyKey,
    idem.payloadHash,
    201,
    { invoice: created },
    actor.userId
  );

  return { invoice: created, idempotentReplay: false };
}

export async function voidInvoice(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  invoiceId: number,
  reason?: string
) {
  const invRes = await tx.query<{
    id: number;
    invoice_number: string;
    customer_id: number;
    status: string;
    is_sales_receipt: boolean;
    amount_paid: string;
    journal_txn_id: number | null;
  }>(
    `SELECT id, invoice_number, customer_id, status, is_sales_receipt, amount_paid::text, journal_txn_id
       FROM invoices WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, invoiceId]
  );
  if (invRes.rows.length === 0) throw new AccountingError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  const inv = invRes.rows[0];
  if (inv.status === 'voided') {
    throw new AccountingError(409, `Invoice ${inv.invoice_number} is already voided`, 'ALREADY_VOIDED');
  }
  if (!inv.is_sales_receipt && parseDecimal4(inv.amount_paid) > 0n) {
    throw new AccountingError(
      409,
      `Cannot void invoice ${inv.invoice_number} with applied payments or credits. Void the payment first.`,
      'HAS_APPLIED_PAYMENTS'
    );
  }

  let reversalJournalId: number | null = null;
  if (inv.journal_txn_id) {
    const rev = await reverseJournalEntry(tx, companyId, actor, Number(inv.journal_txn_id), {
      reason: reason || `Void ${inv.is_sales_receipt ? 'Sales Receipt' : 'Invoice'} ${inv.invoice_number}`,
    });
    reversalJournalId = rev.reversal.id;
  }

  // Void linked bank transaction for Sales Receipts
  if (inv.is_sales_receipt && inv.journal_txn_id) {
    await tx.query(
      `UPDATE bank_transactions SET status = 'voided' WHERE company_id = $1 AND journal_txn_id = $2`,
      [companyId, inv.journal_txn_id]
    );
  }

  // Restore inventory movements created by this invoice/sales receipt
  const movs = await tx.query<{
    id: number;
    item_id: number;
    variant_id: number | null;
    quantity_delta: string;
    unit_cost: string;
  }>(
    `SELECT id, item_id, variant_id, quantity_delta::text, unit_cost::text
       FROM inventory_movements
      WHERE company_id = $1
        AND source_type IN ('invoice', 'sales_receipt')
        AND source_id = $2
        AND reverses_movement_id IS NULL`,
    [companyId, invoiceId]
  );
  for (const m of movs.rows) {
    const restoreQty6 = -parseDecimal6(m.quantity_delta);
    const itRes = await tx.query<{ on_hand: string; item_type: string }>(
      `SELECT on_hand::text, item_type FROM inventory_items WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, Number(m.item_id)]
    );
    if (itRes.rows.length > 0 && ['raw_material', 'stationery'].includes(itRes.rows[0].item_type)) {
      const nextBal6 = parseDecimal6(itRes.rows[0].on_hand) + restoreQty6;
      await tx.query(
        `UPDATE inventory_items SET on_hand = $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`,
        [companyId, Number(m.item_id), formatDecimal6(nextBal6)]
      );
      if (m.variant_id) {
        const vRes = await tx.query<{ on_hand: string }>(
          `SELECT on_hand::text FROM item_variants WHERE company_id = $1 AND id = $2 FOR UPDATE`,
          [companyId, Number(m.variant_id)]
        );
        if (vRes.rows.length > 0) {
          const nextVBal6 = parseDecimal6(vRes.rows[0].on_hand) + restoreQty6;
          await tx.query(
            `UPDATE item_variants SET on_hand = $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`,
            [companyId, Number(m.variant_id), formatDecimal6(nextVBal6)]
          );
        }
      }
      await tx.query(
        `INSERT INTO inventory_movements (
           company_id, item_id, variant_id, movement_type, quantity_delta, unit_cost,
           balance_qty, balance_avg_cost, source_type, source_id, reverses_movement_id
         ) VALUES ($1, $2, $3, 'void', $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), $5::NUMERIC(19,6), $7, $8, $9)`,
        [
          companyId,
          Number(m.item_id),
          m.variant_id ? Number(m.variant_id) : null,
          formatDecimal6(restoreQty6),
          m.unit_cost,
          formatDecimal6(nextBal6),
          inv.is_sales_receipt ? 'sales_receipt' : 'invoice',
          invoiceId,
          Number(m.id),
        ]
      );
    }
  }

  await tx.query(
    `UPDATE invoices SET status = 'voided' WHERE company_id = $1 AND id = $2`,
    [companyId, invoiceId]
  );
  await recalculateCustomerBalance(tx, companyId, Number(inv.customer_id));

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'INVOICE_VOIDED',
    tableName: 'invoices',
    recordId: invoiceId,
    oldValues: { status: inv.status },
    newValues: { status: 'voided', reason: reason || null, reversalJournalId },
  });

  const list = await listInvoices(tx, companyId, { customerId: Number(inv.customer_id) });
  return { invoice: list.find(i => i.id === invoiceId)!, reversalJournalId };
}

// ============================================================================
// CUSTOMER PAYMENTS (Multi-Invoice Allocations, Overpayments, FX Gain/Loss)
// ============================================================================

export async function listPayments(tx: Transaction, companyId: number, customerId?: number) {
  const res = await tx.query<any>(
    `SELECT p.id, p.payment_number, p.customer_id, c.company_name AS customer_name,
            p.payment_date::text, p.amount::text, p.payment_method, p.reference_number,
            p.deposit_to_account_id, a.name AS deposit_account_name,
            p.discount_override, p.discount_override_note, p.is_voided,
            p.journal_txn_id, p.memo, p.currency_code, p.exchange_rate::text, p.foreign_amount::text
       FROM payments p
       JOIN customers c ON c.company_id = p.company_id AND c.id = p.customer_id
       JOIN accounts a ON a.company_id = p.company_id AND a.id = p.deposit_to_account_id
      WHERE p.company_id = $1 ${customerId ? 'AND p.customer_id = $2' : ''}
      ORDER BY p.payment_date DESC, p.id DESC`,
    customerId ? [companyId, customerId] : [companyId]
  );

  if (res.rows.length === 0) return [];
  const pmtIds = res.rows.map(r => Number(r.id));
  const allocRes = await tx.query<any>(
    `SELECT pa.payment_id, pa.invoice_id, i.invoice_number, pa.amount::text, pa.from_remainder
       FROM payment_allocations pa
       JOIN invoices i ON i.company_id = pa.company_id AND i.id = pa.invoice_id
      WHERE pa.company_id = $1 AND pa.payment_id = ANY($2::BIGINT[])`,
    [companyId, pmtIds]
  );
  const allocMap = new Map<number, any[]>();
  for (const a of allocRes.rows) {
    const pid = Number(a.payment_id);
    const list = allocMap.get(pid) ?? [];
    list.push({
      invoiceId: Number(a.invoice_id),
      invoiceNumber: a.invoice_number,
      amount: toMoneyNumber(parseDecimal4(a.amount)),
      fromRemainder: Boolean(a.from_remainder),
    });
    allocMap.set(pid, list);
  }

  return res.rows.map(r => ({
    id: Number(r.id),
    paymentNumber: r.payment_number,
    customerId: Number(r.customer_id),
    customerName: r.customer_name,
    paymentDate: r.payment_date,
    amount: toMoneyNumber(parseDecimal4(r.amount)),
    amountExact: r.amount,
    paymentMethod: r.payment_method,
    referenceNumber: r.reference_number,
    depositToAccountId: Number(r.deposit_to_account_id),
    depositAccountName: r.deposit_account_name,
    discountOverride: Boolean(r.discount_override),
    isVoided: Boolean(r.is_voided),
    journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
    memo: r.memo || '',
    currencyCode: r.currency_code,
    exchangeRate: Number(r.exchange_rate),
    foreignAmount: toMoneyNumber(parseDecimal4(r.foreign_amount)),
    allocations: allocMap.get(Number(r.id)) ?? [],
  }));
}

export async function recordCustomerPayment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    paymentDate?: string;
    amount: string | number;
    paymentMethod: string;
    referenceNumber?: string | null;
    depositToAccountId?: number | null;
    currencyCode?: string | null;
    exchangeRate?: string | number | null;
    memo?: string | null;
    discountOverride?: boolean;
    discountOverrideNote?: string | null;
    idempotencyKey?: string | null;
    allocations?: Array<{ invoiceId: number; amount: string | number }>;
  }
) {
  const idem = await checkRouteIdempotency<{ payment: any }>(
    tx,
    companyId,
    'customer_payment_create',
    input.idempotencyKey,
    input
  );
  if (idem.hit) {
    return { payment: idem.response.payment, idempotentReplay: true };
  }

  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const customerId = Number(input.customerId);
  const custRes = await tx.query<{ id: number; company_name: string }>(
    `SELECT id, company_name FROM customers WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, customerId]
  );
  if (custRes.rows.length === 0) throw new AccountingError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
  const customer = custRes.rows[0];

  const paymentDate = input.paymentDate ? assertIsoDate(input.paymentDate, 'paymentDate') : todayIsoDate();
  const validMethods = ['Check', 'Credit Card', 'Cash', 'ACH / Wire', 'Mobile Money'];
  const method = validMethods.includes(input.paymentMethod) ? input.paymentMethod : 'ACH / Wire';
  const depositAcctId = input.depositToAccountId ? Number(input.depositToAccountId) : ctx.bank1010;

  const bankRes = await tx.query<{ id: number; account_type: string }>(
    `SELECT id, account_type FROM accounts WHERE company_id = $1 AND id = $2 AND is_active = TRUE`,
    [companyId, depositAcctId]
  );
  if (bankRes.rows.length === 0 || !['Bank', 'OtherCurrentAsset'].includes(bankRes.rows[0].account_type)) {
    throw new AccountingError(400, 'depositToAccountId must be an active Bank or Cash account');
  }

  const fx = await resolveExchangeRate6(
    tx,
    companyId,
    input.currencyCode,
    ctx.baseCurrency,
    paymentDate,
    input.exchangeRate
  );

  const foreignAmt4 = parseDecimal4(input.amount);
  if (foreignAmt4 <= 0n) throw new AccountingError(400, 'Payment amount must be greater than zero');
  const cashReceivedBase4 = convertForeign4ToBase4(foreignAmt4, fx.rate6, ctx.roundingMode);

  // Validate & apply invoice allocations
  const rawAllocs = Array.isArray(input.allocations) ? input.allocations : [];
  let totalAllocatedForeignOrBase4 = 0n;
  let totalArRelievedBase4 = 0n;

  const allocRows: Array<{
    invoiceId: number;
    appliedBase4: bigint;
    appliedForeign4: bigint;
    originalRate6: bigint;
    invCurrency: string;
    prevPaid4: bigint;
    prevTotal4: bigint;
    prevForeignBal4: bigint;
    invoiceNumber: string;
  }> = [];

  for (const alloc of rawAllocs) {
    const invId = Number(alloc.invoiceId);
    const allocInput4 = parseDecimal4(alloc.amount);
    if (allocInput4 <= 0n) continue;

    const invRes = await tx.query<{
      id: number;
      customer_id: number;
      invoice_number: string;
      status: string;
      is_sales_receipt: boolean;
      total: string;
      amount_paid: string;
      balance_due: string;
      currency_code: string;
      exchange_rate: string;
      foreign_balance_due: string;
    }>(
      `SELECT id, customer_id, invoice_number, status, is_sales_receipt, total::text,
              amount_paid::text, balance_due::text, currency_code, exchange_rate::text, foreign_balance_due::text
         FROM invoices WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, invId]
    );
    if (invRes.rows.length === 0) throw new AccountingError(404, `Invoice ${invId} not found`);
    const inv = invRes.rows[0];
    if (Number(inv.customer_id) !== customerId) {
      throw new AccountingError(400, `Invoice ${inv.invoice_number} belongs to a different customer`);
    }
    if (inv.status === 'voided' || inv.is_sales_receipt) {
      throw new AccountingError(409, `Invoice ${inv.invoice_number} cannot receive payments`);
    }

    const invBal4 = parseDecimal4(inv.balance_due);
    const invRate6 = parseDecimal6(inv.exchange_rate);

    let appliedBase4: bigint;
    let appliedForeign4: bigint;
    if (inv.currency_code === fx.currencyCode && inv.currency_code !== ctx.baseCurrency) {
      // Allocation amount is in the foreign invoice currency
      appliedForeign4 = allocInput4;
      const invForeignBal4 = parseDecimal4(inv.foreign_balance_due);
      if (appliedForeign4 > invForeignBal4) {
        throw new AccountingError(400, `Allocation exceeds foreign balance due on ${inv.invoice_number}`);
      }
      // Relieve AR at original invoice booking rate so AR returns to exactly 0 when paid in full
      appliedBase4 =
        appliedForeign4 === invForeignBal4
          ? invBal4
          : convertForeign4ToBase4(appliedForeign4, invRate6, ctx.roundingMode);
    } else {
      appliedBase4 = allocInput4;
      appliedForeign4 = allocInput4;
      if (appliedBase4 > invBal4) {
        throw new AccountingError(
          400,
          `Allocation ${formatDecimal2(appliedBase4)} exceeds balance due ${formatDecimal2(invBal4)} on ${inv.invoice_number}`
        );
      }
    }

    totalAllocatedForeignOrBase4 += allocInput4;
    totalArRelievedBase4 += appliedBase4;
    allocRows.push({
      invoiceId: invId,
      appliedBase4,
      appliedForeign4,
      originalRate6: invRate6,
      invCurrency: inv.currency_code,
      prevPaid4: parseDecimal4(inv.amount_paid),
      prevTotal4: parseDecimal4(inv.total),
      prevForeignBal4: parseDecimal4(inv.foreign_balance_due),
      invoiceNumber: inv.invoice_number,
    });
  }

  if (totalAllocatedForeignOrBase4 > foreignAmt4) {
    throw new AccountingError(400, 'Total invoice allocations cannot exceed payment amount', 'ALLOCATION_EXCEEDS_PAYMENT');
  }

  // Unapplied remainder (if overpayment or unallocated deposit on customer account)
  const remainderForeignOrBase4 = foreignAmt4 - totalAllocatedForeignOrBase4;
  const remainderBase4 = convertForeign4ToBase4(remainderForeignOrBase4, fx.rate6, ctx.roundingMode);
  const totalArCredit4 = totalArRelievedBase4 + remainderBase4;
  const fxDiff4 = cashReceivedBase4 - totalArCredit4; // > 0 => FX Gain, < 0 => FX Loss

  const paymentNumber = await generateNextDocNumber(tx, companyId, 'payments', 'payment_number', 'PMT');

  const pmtIns = await tx.query<{ id: number }>(
    `INSERT INTO payments (
       company_id, payment_number, customer_id, payment_date, amount, payment_method,
       reference_number, deposit_to_account_id, discount_override, discount_override_note,
       memo, currency_code, exchange_rate, foreign_amount
     ) VALUES (
       $1, $2, $3, $4::DATE, $5::NUMERIC(19,4), $6,
       $7, $8, $9, $10, $11, $12, $13::NUMERIC(19,6), $14::NUMERIC(19,4)
     ) RETURNING id`,
    [
      companyId,
      paymentNumber,
      customerId,
      paymentDate,
      formatDecimal4(cashReceivedBase4),
      method,
      input.referenceNumber?.trim() || null,
      depositAcctId,
      Boolean(input.discountOverride),
      input.discountOverrideNote?.trim() || null,
      input.memo?.trim() || null,
      fx.currencyCode,
      fx.rateStr,
      formatDecimal4(foreignAmt4),
    ]
  );
  const paymentId = Number(pmtIns.rows[0].id);

  for (const a of allocRows) {
    await tx.query(
      `INSERT INTO payment_allocations (company_id, payment_id, invoice_id, amount, from_remainder)
       VALUES ($1, $2, $3, $4::NUMERIC(19,4), FALSE)`,
      [companyId, paymentId, a.invoiceId, formatDecimal4(a.appliedBase4)]
    );
    const nextPaid4 = a.prevPaid4 + a.appliedBase4;
    const nextBal4 = a.prevTotal4 - nextPaid4;
    const nextStatus = nextBal4 === 0n ? 'paid' : 'partial';
    const nextForeignBal4 =
      a.prevForeignBal4 > a.appliedForeign4 ? a.prevForeignBal4 - a.appliedForeign4 : 0n;

    await tx.query(
      `UPDATE invoices
          SET amount_paid = $3::NUMERIC(19,4),
              balance_due = $4::NUMERIC(19,4),
              foreign_balance_due = $5::NUMERIC(19,4),
              status = $6
        WHERE company_id = $1 AND id = $2`,
      [
        companyId,
        a.invoiceId,
        formatDecimal4(nextPaid4),
        formatDecimal4(nextBal4),
        formatDecimal4(nextForeignBal4),
        nextStatus,
      ]
    );
  }

  // Post Double-Entry Journal: Dr Bank, Cr AR (+ realized FX Gain/Loss if any)
  const jeLines: JournalLineInput[] = [
    {
      accountId: depositAcctId,
      debit: formatDecimal4(cashReceivedBase4),
      credit: '0.0000',
      description: `Customer Payment Deposit — ${paymentNumber}`,
      partyType: 'customer',
      partyId: customerId,
    },
    {
      accountId: ctx.ar1100,
      debit: '0.0000',
      credit: formatDecimal4(totalArCredit4),
      description: `Accounts Receivable Relief — ${paymentNumber}`,
      partyType: 'customer',
      partyId: customerId,
    },
  ];
  if (fxDiff4 > 0n) {
    jeLines.push({
      accountId: ctx.fxGain4900,
      debit: '0.0000',
      credit: formatDecimal4(fxDiff4),
      description: `Realized FX Gain on Settlement — ${paymentNumber}`,
    });
  } else if (fxDiff4 < 0n) {
    jeLines.push({
      accountId: ctx.fxLoss6900,
      debit: formatDecimal4(-fxDiff4),
      credit: '0.0000',
      description: `Realized FX Loss on Settlement — ${paymentNumber}`,
    });
  }

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate: paymentDate,
    description: `Payment ${paymentNumber} from ${customer.company_name}`,
    reference: input.referenceNumber?.trim() || paymentNumber,
    sourceType: 'payment',
    sourceId: paymentId,
    idempotencyKey: `pmt-je-${companyId}-${paymentId}`,
    lines: jeLines,
  });

  await tx.query(`UPDATE payments SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    paymentId,
    postedJe.transaction.id,
  ]);

  if (bankRes.rows[0].account_type === 'Bank') {
    const baRes = await tx.query<{ id: number }>(
      `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
      [companyId, depositAcctId]
    );
    const btIns = await tx.query<{ id: number }>(
      `INSERT INTO bank_transactions (
         company_id, account_id, bank_account_id, txn_date, payee, txn_type,
         ref_number, memo, amount, is_cleared, status, offset_account_id, journal_txn_id, customer_id, category
       ) VALUES (
         $1, $2, $3, $4::DATE, $5, 'Payment',
         $6, $7, $8::NUMERIC(19,4), FALSE, 'posted', $9, $10, $11, 'Accounts Receivable'
       ) RETURNING id`,
      [
        companyId,
        depositAcctId,
        baRes.rows[0] ? Number(baRes.rows[0].id) : null,
        paymentDate,
        customer.company_name,
        input.referenceNumber?.trim() || paymentNumber,
        input.memo?.trim() || `Customer Payment ${paymentNumber}`,
        formatDecimal4(cashReceivedBase4),
        ctx.ar1100,
        postedJe.transaction.id,
        customerId,
      ]
    );
    await tx.query(
      `UPDATE payments SET deposited_bank_txn_id = $3 WHERE company_id = $1 AND id = $2`,
      [companyId, paymentId, Number(btIns.rows[0].id)]
    );
  }

  await recalculateCustomerBalance(tx, companyId, customerId);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_PAYMENT_POSTED',
    tableName: 'payments',
    recordId: paymentId,
    newValues: {
      paymentNumber,
      customerId,
      amount: formatDecimal4(cashReceivedBase4),
      fxDiff: formatDecimal4(fxDiff4),
      allocations: allocRows.map(a => ({ invoiceId: a.invoiceId, amount: formatDecimal4(a.appliedBase4) })),
      journalTxnId: postedJe.transaction.id,
    },
  });

  const all = await listPayments(tx, companyId, customerId);
  const created = all.find(p => p.id === paymentId)!;
  await saveRouteIdempotency(
    tx,
    companyId,
    'customer_payment_create',
    input.idempotencyKey,
    idem.payloadHash,
    201,
    { payment: created },
    actor.userId
  );

  return { payment: created, idempotentReplay: false };
}

export async function voidCustomerPayment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  paymentId: number,
  reason?: string
) {
  const pRes = await tx.query<{
    id: number;
    payment_number: string;
    customer_id: number;
    is_voided: boolean;
    journal_txn_id: number | null;
  }>(
    `SELECT id, payment_number, customer_id, is_voided, journal_txn_id
       FROM payments WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, paymentId]
  );
  if (pRes.rows.length === 0) throw new AccountingError(404, 'Payment not found');
  const p = pRes.rows[0];
  if (p.is_voided) throw new AccountingError(409, `Payment ${p.payment_number} is already voided`);

  let reversalJournalId: number | null = null;
  if (p.journal_txn_id) {
    const rev = await reverseJournalEntry(tx, companyId, actor, Number(p.journal_txn_id), {
      reason: reason || `Void customer payment ${p.payment_number}`,
    });
    reversalJournalId = rev.reversal.id;
    await tx.query(
      `UPDATE bank_transactions SET status = 'voided' WHERE company_id = $1 AND journal_txn_id = $2`,
      [companyId, p.journal_txn_id]
    );
  }

  // Restore allocated invoice balances
  const allocs = await tx.query<{ invoice_id: number; amount: string }>(
    `SELECT invoice_id, amount::text FROM payment_allocations WHERE company_id = $1 AND payment_id = $2`,
    [companyId, paymentId]
  );
  for (const a of allocs.rows) {
    const invRes = await tx.query<{ total: string; amount_paid: string }>(
      `SELECT total::text, amount_paid::text FROM invoices WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, Number(a.invoice_id)]
    );
    if (invRes.rows.length > 0) {
      const total4 = parseDecimal4(invRes.rows[0].total);
      const curPaid4 = parseDecimal4(invRes.rows[0].amount_paid);
      const alloc4 = parseDecimal4(a.amount);
      const nextPaid4 = curPaid4 >= alloc4 ? curPaid4 - alloc4 : 0n;
      const nextBal4 = total4 - nextPaid4;
      const nextStatus = nextPaid4 === 0n ? 'sent' : nextBal4 === 0n ? 'paid' : 'partial';
      await tx.query(
        `UPDATE invoices
            SET amount_paid = $3::NUMERIC(19,4),
                balance_due = $4::NUMERIC(19,4),
                status = $5
          WHERE company_id = $1 AND id = $2`,
        [companyId, Number(a.invoice_id), formatDecimal4(nextPaid4), formatDecimal4(nextBal4), nextStatus]
      );
    }
  }

  await tx.query(`UPDATE payments SET is_voided = TRUE WHERE company_id = $1 AND id = $2`, [companyId, paymentId]);
  await recalculateCustomerBalance(tx, companyId, Number(p.customer_id));

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_PAYMENT_VOIDED',
    tableName: 'payments',
    recordId: paymentId,
    oldValues: { isVoided: false },
    newValues: { isVoided: true, reason: reason || null, reversalJournalId },
  });

  const all = await listPayments(tx, companyId, Number(p.customer_id));
  return { payment: all.find(x => x.id === paymentId)!, reversalJournalId };
}

// ============================================================================
// CREDIT MEMOS & CREDIT APPLICATIONS
// ============================================================================

export async function listCreditMemos(tx: Transaction, companyId: number, customerId?: number) {
  const res = await tx.query<any>(
    `SELECT cm.id, cm.credit_number, cm.customer_id, c.company_name AS customer_name,
            cm.credit_date::text, cm.status, cm.subtotal::text, cm.tax_rate::text,
            cm.tax_amount::text, cm.total::text, cm.remaining_credit::text,
            cm.journal_txn_id, cm.memo
       FROM credit_memos cm
       JOIN customers c ON c.company_id = cm.company_id AND c.id = cm.customer_id
      WHERE cm.company_id = $1 ${customerId ? 'AND cm.customer_id = $2' : ''}
      ORDER BY cm.credit_date DESC, cm.id DESC`,
    customerId ? [companyId, customerId] : [companyId]
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    creditNumber: r.credit_number,
    customerId: Number(r.customer_id),
    customerName: r.customer_name,
    creditDate: r.credit_date,
    status: r.status,
    subtotal: toMoneyNumber(parseDecimal4(r.subtotal)),
    taxAmount: toMoneyNumber(parseDecimal4(r.tax_amount)),
    total: toMoneyNumber(parseDecimal4(r.total)),
    remainingCredit: toMoneyNumber(parseDecimal4(r.remaining_credit)),
    journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
    memo: r.memo || '',
  }));
}

export async function createCreditMemo(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    creditDate?: string;
    taxRate?: string | number;
    memo?: string | null;
    idempotencyKey?: string | null;
    lines: Array<{
      itemId?: number | null;
      description: string;
      quantity: string | number;
      rate: string | number;
      incomeAccountId?: number | null;
    }>;
  }
) {
  const idem = await checkRouteIdempotency<{ creditMemo: any }>(
    tx,
    companyId,
    'credit_memo_create',
    input.idempotencyKey,
    input
  );
  if (idem.hit) return { creditMemo: idem.response.creditMemo, idempotentReplay: true };

  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const customerId = Number(input.customerId);
  const custRes = await tx.query<{ id: number; company_name: string }>(
    `SELECT id, company_name FROM customers WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, customerId]
  );
  if (custRes.rows.length === 0) throw new AccountingError(404, 'Customer not found');
  const customer = custRes.rows[0];

  const creditDate = input.creditDate ? assertIsoDate(input.creditDate, 'creditDate') : todayIsoDate();
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'At least one credit memo line is required');
  }

  let subtotal4 = 0n;
  const revReversalByAcct = new Map<number, bigint>();
  const lineRows: Array<{
    itemId: number | null;
    description: string;
    quantity6: bigint;
    rate4: bigint;
    amount4: bigint;
  }> = [];

  for (const raw of input.lines) {
    const qty6 = parseDecimal6(raw.quantity);
    const rate4 = parseDecimal4(raw.rate);
    const amount4 = multiplyQty6ByRate4(qty6, rate4, ctx.roundingMode);
    if (amount4 <= 0n) throw new AccountingError(400, 'Credit memo line amount must be positive');
    subtotal4 += amount4;
    const acctId = raw.incomeAccountId ? Number(raw.incomeAccountId) : ctx.revenue4000;
    revReversalByAcct.set(acctId, (revReversalByAcct.get(acctId) ?? 0n) + amount4);
    lineRows.push({
      itemId: raw.itemId ? Number(raw.itemId) : null,
      description: String(raw.description || '').trim() || 'Sales Credit',
      quantity6: qty6,
      rate4,
      amount4,
    });
  }

  const taxRate6 = parseDecimal6(input.taxRate ?? 0);
  const tax4 = computeTax4(subtotal4, taxRate6, ctx.roundingMode);
  const total4 = subtotal4 + tax4;
  const creditNumber = await generateNextDocNumber(tx, companyId, 'credit_memos', 'credit_number', 'CM');

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO credit_memos (
       company_id, credit_number, customer_id, credit_date, status,
       subtotal, tax_rate, tax_amount, total, remaining_credit, memo
     ) VALUES ($1, $2, $3, $4::DATE, 'open', $5::NUMERIC(19,4), $6::NUMERIC(9,6), $7::NUMERIC(19,4), $8::NUMERIC(19,4), $8::NUMERIC(19,4), $9)
     RETURNING id`,
    [
      companyId,
      creditNumber,
      customerId,
      creditDate,
      formatDecimal4(subtotal4),
      formatDecimal6(taxRate6),
      formatDecimal4(tax4),
      formatDecimal4(total4),
      input.memo?.trim() || null,
    ]
  );
  const cmId = Number(ins.rows[0].id);

  for (const l of lineRows) {
    await tx.query(
      `INSERT INTO credit_memo_lines (company_id, credit_memo_id, item_id, description, quantity, rate, amount)
       VALUES ($1, $2, $3, $4, $5::NUMERIC(19,6), $6::NUMERIC(19,4), $7::NUMERIC(19,4))`,
      [companyId, cmId, l.itemId, l.description, formatDecimal6(l.quantity6), formatDecimal4(l.rate4), formatDecimal4(l.amount4)]
    );
  }

  const jeLines: JournalLineInput[] = [];
  for (const [acctId, amt4] of revReversalByAcct.entries()) {
    jeLines.push({
      accountId: acctId,
      debit: formatDecimal4(amt4),
      credit: '0.0000',
      description: `Sales Credit Reversal — ${creditNumber}`,
      partyType: 'customer',
      partyId: customerId,
    });
  }
  if (tax4 > 0n) {
    jeLines.push({
      accountId: ctx.salesTax2200,
      debit: formatDecimal4(tax4),
      credit: '0.0000',
      description: `Sales Tax Credit — ${creditNumber}`,
    });
  }
  jeLines.push({
    accountId: ctx.ar1100,
    debit: '0.0000',
    credit: formatDecimal4(total4),
    description: `AR Credit Memo — ${creditNumber}`,
    partyType: 'customer',
    partyId: customerId,
  });

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate: creditDate,
    description: `Credit Memo ${creditNumber} — ${customer.company_name}`,
    reference: creditNumber,
    sourceType: 'credit_memo',
    sourceId: cmId,
    idempotencyKey: `cm-je-${companyId}-${cmId}`,
    lines: jeLines,
  });

  await tx.query(`UPDATE credit_memos SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    cmId,
    postedJe.transaction.id,
  ]);
  await recalculateCustomerBalance(tx, companyId, customerId);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CREDIT_MEMO_POSTED',
    tableName: 'credit_memos',
    recordId: cmId,
    newValues: { creditNumber, customerId, total: formatDecimal4(total4), journalTxnId: postedJe.transaction.id },
  });

  const list = await listCreditMemos(tx, companyId, customerId);
  const created = list.find(c => c.id === cmId)!;
  await saveRouteIdempotency(
    tx,
    companyId,
    'credit_memo_create',
    input.idempotencyKey,
    idem.payloadHash,
    201,
    { creditMemo: created },
    actor.userId
  );
  return { creditMemo: created, idempotentReplay: false };
}

export async function applyCreditMemoToInvoice(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  creditMemoId: number,
  input: { invoiceId: number; amount: string | number; appliedDate?: string }
) {
  const cmRes = await tx.query<{
    id: number;
    credit_number: string;
    customer_id: number;
    status: string;
    remaining_credit: string;
  }>(
    `SELECT id, credit_number, customer_id, status, remaining_credit::text
       FROM credit_memos WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, creditMemoId]
  );
  if (cmRes.rows.length === 0) throw new AccountingError(404, 'Credit memo not found');
  const cm = cmRes.rows[0];
  if (cm.status === 'voided') throw new AccountingError(409, 'Voided credit memo cannot be applied');

  const invRes = await tx.query<{
    id: number;
    invoice_number: string;
    customer_id: number;
    status: string;
    total: string;
    amount_paid: string;
    balance_due: string;
  }>(
    `SELECT id, invoice_number, customer_id, status, total::text, amount_paid::text, balance_due::text
       FROM invoices WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, Number(input.invoiceId)]
  );
  if (invRes.rows.length === 0) throw new AccountingError(404, 'Invoice not found');
  const inv = invRes.rows[0];
  if (Number(inv.customer_id) !== Number(cm.customer_id)) {
    throw new AccountingError(400, 'Credit memo and invoice must belong to the same customer');
  }
  if (inv.status === 'voided') throw new AccountingError(409, 'Cannot apply credit to voided invoice');

  const apply4 = parseDecimal4(input.amount);
  const rem4 = parseDecimal4(cm.remaining_credit);
  const invBal4 = parseDecimal4(inv.balance_due);
  if (apply4 <= 0n || apply4 > rem4 || apply4 > invBal4) {
    throw new AccountingError(
      400,
      `Application amount must be between 0.01 and min(remaining credit ${formatDecimal2(rem4)}, balance due ${formatDecimal2(invBal4)})`
    );
  }

  const appliedDate = input.appliedDate ? assertIsoDate(input.appliedDate, 'appliedDate') : todayIsoDate();
  await tx.query(
    `INSERT INTO credit_applications (company_id, credit_memo_id, invoice_id, amount, applied_date)
     VALUES ($1, $2, $3, $4::NUMERIC(19,4), $5::DATE)`,
    [companyId, creditMemoId, inv.id, formatDecimal4(apply4), appliedDate]
  );

  const nextRem4 = rem4 - apply4;
  await tx.query(
    `UPDATE credit_memos
        SET remaining_credit = $3::NUMERIC(19,4),
            status = $4
      WHERE company_id = $1 AND id = $2`,
    [companyId, creditMemoId, formatDecimal4(nextRem4), nextRem4 === 0n ? 'applied' : 'open']
  );

  const nextInvPaid4 = parseDecimal4(inv.amount_paid) + apply4;
  const nextInvBal4 = parseDecimal4(inv.total) - nextInvPaid4;
  await tx.query(
    `UPDATE invoices
        SET amount_paid = $3::NUMERIC(19,4),
            balance_due = $4::NUMERIC(19,4),
            status = $5
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      inv.id,
      formatDecimal4(nextInvPaid4),
      formatDecimal4(nextInvBal4),
      nextInvBal4 === 0n ? 'paid' : 'partial',
    ]
  );

  await recalculateCustomerBalance(tx, companyId, Number(cm.customer_id));

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CREDIT_MEMO_APPLIED',
    tableName: 'credit_applications',
    recordId: creditMemoId,
    newValues: { invoiceId: inv.id, invoiceNumber: inv.invoice_number, amount: formatDecimal4(apply4) },
  });

  const list = await listCreditMemos(tx, companyId, Number(cm.customer_id));
  return list.find(c => c.id === creditMemoId)!;
}

export async function voidCreditMemo(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  creditMemoId: number,
  reason?: string
) {
  const cmRes = await tx.query<{
    id: number;
    credit_number: string;
    customer_id: number;
    status: string;
    total: string;
    remaining_credit: string;
    journal_txn_id: number | null;
  }>(
    `SELECT id, credit_number, customer_id, status, total::text, remaining_credit::text, journal_txn_id
       FROM credit_memos WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, creditMemoId]
  );
  if (cmRes.rows.length === 0) throw new AccountingError(404, 'Credit memo not found');
  const cm = cmRes.rows[0];
  if (cm.status === 'voided') throw new AccountingError(409, 'Credit memo is already voided');
  if (parseDecimal4(cm.remaining_credit) !== parseDecimal4(cm.total)) {
    throw new AccountingError(409, 'Cannot void a credit memo that has already been applied to invoices');
  }

  let reversalJournalId: number | null = null;
  if (cm.journal_txn_id) {
    const rev = await reverseJournalEntry(tx, companyId, actor, Number(cm.journal_txn_id), {
      reason: reason || `Void credit memo ${cm.credit_number}`,
    });
    reversalJournalId = rev.reversal.id;
  }

  await tx.query(`UPDATE credit_memos SET status = 'voided' WHERE company_id = $1 AND id = $2`, [
    companyId,
    creditMemoId,
  ]);
  await recalculateCustomerBalance(tx, companyId, Number(cm.customer_id));

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CREDIT_MEMO_VOIDED',
    tableName: 'credit_memos',
    recordId: creditMemoId,
    newValues: { status: 'voided', reason: reason || null, reversalJournalId },
  });

  const list = await listCreditMemos(tx, companyId, Number(cm.customer_id));
  return { creditMemo: list.find(c => c.id === creditMemoId)!, reversalJournalId };
}

// ============================================================================
// ESTIMATES / QUOTATIONS
// ============================================================================

export async function listEstimates(tx: Transaction, companyId: number, includeCosts: boolean) {
  const hdrs = await tx.query<{
    id: number;
    estimate_number: string;
    customer_id: number;
    customer_name: string;
    estimate_date: string;
    expiry_date: string | null;
    status: string;
    subtotal: string;
    tax_rate: string;
    tax_amount: string;
    total: string;
    total_cost: string;
    notes: string | null;
  }>(
    `SELECT e.id, e.estimate_number, e.customer_id, c.company_name AS customer_name,
            e.estimate_date::text, e.expiry_date::text, e.status, e.subtotal::text,
            e.tax_rate::text, e.tax_amount::text, e.total::text, e.total_cost::text, e.notes
       FROM estimates e
       JOIN customers c ON c.company_id = e.company_id AND c.id = e.customer_id
      WHERE e.company_id = $1
      ORDER BY e.id DESC`,
    [companyId]
  );

  const ids = hdrs.rows.map(r => Number(r.id));
  const linesByEst = new Map<number, any[]>();
  if (ids.length > 0) {
    const lRes = await tx.query<any>(
      `SELECT estimate_id, line_order, item_id, variant_id, description,
              quantity::text, unit_cost::text, rate::text, amount::text, taxable
         FROM estimate_lines
        WHERE company_id = $1 AND estimate_id = ANY($2::BIGINT[])
        ORDER BY estimate_id ASC, line_order ASC`,
      [companyId, ids]
    );
    for (const l of lRes.rows) {
      const eid = Number(l.estimate_id);
      const arr = linesByEst.get(eid) ?? [];
      const row: any = {
        lineOrder: Number(l.line_order),
        itemId: l.item_id !== null ? Number(l.item_id) : null,
        variantId: l.variant_id !== null ? Number(l.variant_id) : null,
        description: l.description,
        quantity: Number(l.quantity),
        rate: toMoneyNumber(parseDecimal4(l.rate)),
        amount: toMoneyNumber(parseDecimal4(l.amount)),
        taxable: Boolean(l.taxable),
      };
      if (includeCosts) {
        row.unitCost = Number(l.unit_cost);
      }
      arr.push(row);
      linesByEst.set(eid, arr);
    }
  }

  return hdrs.rows.map(row => {
    const base: any = {
      id: Number(row.id),
      estimateNumber: row.estimate_number,
      customerId: Number(row.customer_id),
      customerName: row.customer_name,
      estimateDate: row.estimate_date,
      expiryDate: row.expiry_date,
      status: row.status,
      subtotal: row.subtotal,
      subtotalNum: toMoneyNumber(parseDecimal4(row.subtotal)),
      taxRate: Number(row.tax_rate),
      taxAmount: row.tax_amount,
      total: row.total,
      totalNum: toMoneyNumber(parseDecimal4(row.total)),
      notes: row.notes,
      lines: linesByEst.get(Number(row.id)) ?? [],
    };
    if (!includeCosts) return base;
    const profit4 = parseDecimal4(row.subtotal) - parseDecimal4(row.total_cost);
    return {
      ...base,
      totalCost: row.total_cost,
      totalCostNum: toMoneyNumber(parseDecimal4(row.total_cost)),
      estimatedProfit: formatDecimal4(profit4),
      estimatedProfitNum: toMoneyNumber(profit4),
    };
  });
}

export async function createEstimate(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    estimateDate?: string;
    expiryDate?: string;
    taxRate?: string | number;
    notes?: string | null;
    lines: InvoiceLineInput[];
  }
) {
  const customerId = Number(input.customerId);
  const cust = await tx.query<{ id: number }>(
    `SELECT id FROM customers WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, customerId]
  );
  if (cust.rows.length === 0) throw new AccountingError(404, 'Customer not found');

  const estimateDate = input.estimateDate ? assertIsoDate(input.estimateDate, 'estimateDate') : todayIsoDate();
  const expiryDate = input.expiryDate ? assertIsoDate(input.expiryDate, 'expiryDate') : addDaysToIso(estimateDate, 30);
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'At least one estimate line is required');
  }

  let subtotal4 = 0n;
  let taxable4 = 0n;
  let totalCost4 = 0n;
  const prepared: Array<any> = [];

  for (let i = 0; i < input.lines.length; i++) {
    const raw = input.lines[i];
    const qty6 = parseDecimal6(raw.quantity);
    const rate4 = parseDecimal4(raw.rate);
    const amount4 = multiplyQty6ByRate4(qty6, rate4, 'HALF_EVEN');
    const unitCost6 = parseDecimal6(raw.unitCost ?? 0);
    const lineCost4 = divRoundBigInt(qty6 * unitCost6, 100000000n, 'HALF_EVEN');

    subtotal4 += amount4;
    if (raw.taxable) taxable4 += amount4;
    totalCost4 += lineCost4;

    prepared.push({
      itemId: raw.itemId ? Number(raw.itemId) : null,
      variantId: raw.variantId ? Number(raw.variantId) : null,
      description: String(raw.description || '').trim() || 'Quoted item',
      quantity6: qty6,
      unitCost6,
      rate4,
      amount4,
      taxable: Boolean(raw.taxable),
    });
  }

  const taxRate6 = parseDecimal6(input.taxRate ?? 0);
  const tax4 = computeTax4(taxable4, taxRate6, 'HALF_EVEN');
  const total4 = subtotal4 + tax4;
  const estNum = await generateNextDocNumber(tx, companyId, 'estimates', 'estimate_number', 'EST');

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO estimates (
       company_id, estimate_number, customer_id, estimate_date, expiry_date,
       status, subtotal, tax_rate, tax_amount, total, total_cost, notes
     ) VALUES (
       $1, $2, $3, $4::DATE, $5::DATE, 'pending',
       $6::NUMERIC(19,4), $7::NUMERIC(9,6), $8::NUMERIC(19,4), $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11
     ) RETURNING id`,
    [
      companyId,
      estNum,
      customerId,
      estimateDate,
      expiryDate,
      formatDecimal4(subtotal4),
      formatDecimal6(taxRate6),
      formatDecimal4(tax4),
      formatDecimal4(total4),
      formatDecimal4(totalCost4),
      input.notes?.trim() || null,
    ]
  );
  const estId = Number(ins.rows[0].id);

  for (let i = 0; i < prepared.length; i++) {
    const l = prepared[i];
    await tx.query(
      `INSERT INTO estimate_lines (
         company_id, estimate_id, line_order, item_id, variant_id, description,
         quantity, unit_cost, rate, amount, taxable
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(19,6), $8::NUMERIC(19,6), $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11)`,
      [
        companyId,
        estId,
        i + 1,
        l.itemId,
        l.variantId,
        l.description,
        formatDecimal6(l.quantity6),
        formatDecimal6(l.unitCost6),
        formatDecimal4(l.rate4),
        formatDecimal4(l.amount4),
        l.taxable,
      ]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'ESTIMATE_CREATED',
    tableName: 'estimates',
    recordId: estId,
    newValues: { estimateNumber: estNum, customerId, total: formatDecimal4(total4) },
  });

  const all = await listEstimates(tx, companyId, true);
  return all.find(e => e.id === estId)!;
}

export async function approveEstimate(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  estimateId: number,
  note?: string
) {
  const res = await tx.query<{ id: number; estimate_number: string; status: string }>(
    `SELECT id, estimate_number, status FROM estimates WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, estimateId]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Estimate not found', 'ESTIMATE_NOT_FOUND');
  const est = res.rows[0];
  if (est.status === 'accepted') {
    const all = await listEstimates(tx, companyId, true);
    return all.find(e => e.id === estimateId)!;
  }
  if (est.status !== 'pending') {
    throw new AccountingError(
      409,
      `Estimate ${est.estimate_number} in status "${est.status}" cannot be approved`,
      'INVALID_ESTIMATE_TRANSITION'
    );
  }
  await tx.query(
    `UPDATE estimates SET status = 'accepted', decided_at = NOW() WHERE company_id = $1 AND id = $2`,
    [companyId, estimateId]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'ESTIMATE_APPROVED',
    tableName: 'estimates',
    recordId: estimateId,
    oldValues: { status: est.status },
    newValues: { status: 'accepted', note: note || null },
  });
  const all = await listEstimates(tx, companyId, true);
  return all.find(e => e.id === estimateId)!;
}

export async function rejectEstimate(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  estimateId: number,
  reason?: string
) {
  const res = await tx.query<{ id: number; estimate_number: string; status: string }>(
    `SELECT id, estimate_number, status FROM estimates WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, estimateId]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Estimate not found', 'ESTIMATE_NOT_FOUND');
  const est = res.rows[0];
  if (est.status !== 'pending') {
    throw new AccountingError(
      409,
      `Estimate ${est.estimate_number} in status "${est.status}" cannot be rejected`,
      'INVALID_ESTIMATE_TRANSITION'
    );
  }
  await tx.query(
    `UPDATE estimates SET status = 'rejected', decided_at = NOW() WHERE company_id = $1 AND id = $2`,
    [companyId, estimateId]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'ESTIMATE_REJECTED',
    tableName: 'estimates',
    recordId: estimateId,
    oldValues: { status: est.status },
    newValues: { status: 'rejected', reason: reason || null },
  });
  const all = await listEstimates(tx, companyId, true);
  return all.find(e => e.id === estimateId)!;
}

export async function convertEstimateToInvoice(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  estimateId: number
) {
  const estRes = await tx.query<{
    id: number;
    estimate_number: string;
    customer_id: number;
    status: string;
    tax_rate: string;
    notes: string | null;
  }>(
    `SELECT id, estimate_number, customer_id, status, tax_rate::text, notes
       FROM estimates WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, estimateId]
  );
  if (estRes.rows.length === 0) throw new AccountingError(404, 'Estimate not found');
  const est = estRes.rows[0];
  if (est.status === 'invoiced') {
    throw new AccountingError(409, `Estimate ${est.estimate_number} has already been converted to an invoice`);
  }

  const linesRes = await tx.query<{
    item_id: number | null;
    variant_id: number | null;
    description: string;
    quantity: string;
    unit_cost: string;
    rate: string;
    taxable: boolean;
  }>(
    `SELECT item_id, variant_id, description, quantity::text, unit_cost::text, rate::text, taxable
       FROM estimate_lines WHERE company_id = $1 AND estimate_id = $2 ORDER BY line_order ASC`,
    [companyId, estimateId]
  );

  return createInvoiceOrSalesReceipt(tx, companyId, actor, {
    customerId: Number(est.customer_id),
    taxRate: est.tax_rate,
    sourceEstimateId: estimateId,
    notes: est.notes || `Converted from Estimate ${est.estimate_number}`,
    lines: linesRes.rows.map(l => ({
      itemId: l.item_id !== null ? Number(l.item_id) : null,
      variantId: l.variant_id !== null ? Number(l.variant_id) : null,
      description: l.description,
      quantity: l.quantity,
      unitCost: l.unit_cost,
      rate: l.rate,
      taxable: l.taxable,
    })),
  });
}

// ============================================================================
// AR AGING, STATEMENTS, COLLECTIONS/REMINDERS, RECURRING INVOICES & EMAIL LOG
// ============================================================================

export async function getArAgingReport(tx: Transaction, companyId: number, asOfDate?: string) {
  const asOf = asOfDate ? assertIsoDate(asOfDate, 'asOfDate') : todayIsoDate();
  const res = await tx.query<{
    invoice_id: number;
    invoice_number: string;
    customer_id: number;
    customer_name: string;
    invoice_date: string;
    due_date: string;
    balance_due: string;
    days_past_due: number;
  }>(
    `SELECT i.id AS invoice_id, i.invoice_number, i.customer_id, c.company_name AS customer_name,
            i.invoice_date::text, i.due_date::text, i.balance_due::text,
            ($2::DATE - i.due_date)::INTEGER AS days_past_due
       FROM invoices i
       JOIN customers c ON c.company_id = i.company_id AND c.id = i.customer_id
      WHERE i.company_id = $1
        AND i.status <> 'voided'
        AND i.is_sales_receipt = FALSE
        AND i.balance_due > 0
      ORDER BY c.company_name ASC, i.due_date ASC`,
    [companyId, asOf]
  );

  const byCustomer = new Map<
    number,
    {
      customerId: number;
      customerName: string;
      current4: bigint;
      d1_30_4: bigint;
      d31_60_4: bigint;
      d61_90_4: bigint;
      d90plus4: bigint;
      total4: bigint;
      invoices: any[];
    }
  >();

  let grandCurrent = 0n;
  let grand1_30 = 0n;
  let grand31_60 = 0n;
  let grand61_90 = 0n;
  let grand90plus = 0n;

  for (const r of res.rows) {
    const cid = Number(r.customer_id);
    const bal4 = parseDecimal4(r.balance_due);
    const days = Number(r.days_past_due);
    const entry = byCustomer.get(cid) ?? {
      customerId: cid,
      customerName: r.customer_name,
      current4: 0n,
      d1_30_4: 0n,
      d31_60_4: 0n,
      d61_90_4: 0n,
      d90plus4: 0n,
      total4: 0n,
      invoices: [],
    };
    if (days <= 0) {
      entry.current4 += bal4;
      grandCurrent += bal4;
    } else if (days <= 30) {
      entry.d1_30_4 += bal4;
      grand1_30 += bal4;
    } else if (days <= 60) {
      entry.d31_60_4 += bal4;
      grand31_60 += bal4;
    } else if (days <= 90) {
      entry.d61_90_4 += bal4;
      grand61_90 += bal4;
    } else {
      entry.d90plus4 += bal4;
      grand90plus += bal4;
    }
    entry.total4 += bal4;
    entry.invoices.push({
      invoiceId: Number(r.invoice_id),
      invoiceNumber: r.invoice_number,
      invoiceDate: r.invoice_date,
      dueDate: r.due_date,
      daysPastDue: Math.max(0, days),
      balanceDue: toMoneyNumber(bal4),
    });
    byCustomer.set(cid, entry);
  }

  const totalAr4 = grandCurrent + grand1_30 + grand31_60 + grand61_90 + grand90plus;
  return {
    asOfDate: asOf,
    customers: Array.from(byCustomer.values()).map(c => ({
      customerId: c.customerId,
      customerName: c.customerName,
      current: toMoneyNumber(c.current4),
      days1To30: toMoneyNumber(c.d1_30_4),
      days31To60: toMoneyNumber(c.d31_60_4),
      days61To90: toMoneyNumber(c.d61_90_4),
      daysOver90: toMoneyNumber(c.d90plus4),
      total: toMoneyNumber(c.total4),
      invoices: c.invoices,
    })),
    totals: {
      current: toMoneyNumber(grandCurrent),
      days1To30: toMoneyNumber(grand1_30),
      days31To60: toMoneyNumber(grand31_60),
      days61To90: toMoneyNumber(grand61_90),
      daysOver90: toMoneyNumber(grand90plus),
      total: toMoneyNumber(totalAr4),
    },
  };
}

export async function generateCustomerStatement(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { customerId: number; periodStart?: string; periodEnd?: string; saveSnapshot?: boolean }
) {
  const customerId = Number(input.customerId);
  const custRes = await tx.query<{ id: number; company_name: string; email: string | null; balance: string }>(
    `SELECT id, company_name, email, balance::text FROM customers WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, customerId]
  );
  if (custRes.rows.length === 0) throw new AccountingError(404, 'Customer not found');
  const cust = custRes.rows[0];

  const periodEnd = input.periodEnd ? assertIsoDate(input.periodEnd, 'periodEnd') : todayIsoDate();
  const periodStart = input.periodStart ? assertIsoDate(input.periodStart, 'periodStart') : `${periodEnd.slice(0, 7)}-01`;

  // Opening balance prior to periodStart
  const priorInv = await tx.query<{ s: string }>(
    `SELECT COALESCE(SUM(total), 0)::NUMERIC(19,4)::text AS s FROM invoices
      WHERE company_id = $1 AND customer_id = $2 AND is_sales_receipt = FALSE AND status <> 'voided' AND invoice_date < $3::DATE`,
    [companyId, customerId, periodStart]
  );
  const priorPmt = await tx.query<{ s: string }>(
    `SELECT COALESCE(SUM(amount), 0)::NUMERIC(19,4)::text AS s FROM payments
      WHERE company_id = $1 AND customer_id = $2 AND is_voided = FALSE AND payment_date < $3::DATE`,
    [companyId, customerId, periodStart]
  );
  const priorCm = await tx.query<{ s: string }>(
    `SELECT COALESCE(SUM(total), 0)::NUMERIC(19,4)::text AS s FROM credit_memos
      WHERE company_id = $1 AND customer_id = $2 AND status <> 'voided' AND credit_date < $3::DATE`,
    [companyId, customerId, periodStart]
  );

  const openingBal4 =
    parseDecimal4(priorInv.rows[0].s) - parseDecimal4(priorPmt.rows[0].s) - parseDecimal4(priorCm.rows[0].s);

  const periodActivity = await tx.query<{
    doc_date: string;
    doc_type: string;
    doc_number: string;
    description: string;
    amount: string;
  }>(
    `SELECT invoice_date::text AS doc_date, 'Invoice' AS doc_type, invoice_number AS doc_number,
            COALESCE(notes, 'Invoice') AS description, total::text AS amount
       FROM invoices
      WHERE company_id = $1 AND customer_id = $2 AND is_sales_receipt = FALSE AND status <> 'voided'
        AND invoice_date BETWEEN $3::DATE AND $4::DATE
     UNION ALL
     SELECT payment_date::text AS doc_date, 'Payment' AS doc_type, payment_number AS doc_number,
            COALESCE(memo, payment_method) AS description, (-amount)::text AS amount
       FROM payments
      WHERE company_id = $1 AND customer_id = $2 AND is_voided = FALSE
        AND payment_date BETWEEN $3::DATE AND $4::DATE
     UNION ALL
     SELECT credit_date::text AS doc_date, 'Credit Memo' AS doc_type, credit_number AS doc_number,
            COALESCE(memo, 'Credit Memo') AS description, (-total)::text AS amount
       FROM credit_memos
      WHERE company_id = $1 AND customer_id = $2 AND status <> 'voided'
        AND credit_date BETWEEN $3::DATE AND $4::DATE
     ORDER BY doc_date ASC, doc_number ASC`,
    [companyId, customerId, periodStart, periodEnd]
  );

  let running4 = openingBal4;
  const lines = periodActivity.rows.map(r => {
    const amt4 = parseDecimal4(r.amount);
    running4 += amt4;
    return {
      date: r.doc_date,
      type: r.doc_type,
      number: r.doc_number,
      description: r.description,
      charge: amt4 > 0n ? toMoneyNumber(amt4) : 0,
      credit: amt4 < 0n ? toMoneyNumber(-amt4) : 0,
      runningBalance: toMoneyNumber(running4),
    };
  });

  if (input.saveSnapshot) {
    await tx.query(
      `INSERT INTO customer_statements (
         company_id, customer_id, statement_date, period_start, period_end, opening_balance, closing_balance
       ) VALUES ($1, $2, $3::DATE, $4::DATE, $5::DATE, $6::NUMERIC(19,4), $7::NUMERIC(19,4))`,
      [
        companyId,
        customerId,
        todayIsoDate(),
        periodStart,
        periodEnd,
        formatDecimal4(openingBal4),
        formatDecimal4(running4),
      ]
    );
    await writeAuditLog(tx, {
      companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'CUSTOMER_STATEMENT_GENERATED',
      tableName: 'customer_statements',
      recordId: customerId,
      newValues: { periodStart, periodEnd, closingBalance: formatDecimal4(running4) },
    });
  }

  return {
    customerId,
    customerName: cust.company_name,
    customerEmail: cust.email || '',
    periodStart,
    periodEnd,
    openingBalance: toMoneyNumber(openingBal4),
    closingBalance: toMoneyNumber(running4),
    lines,
  };
}

export async function listRecurringInvoices(tx: Transaction, companyId: number) {
  const hdrs = await tx.query<any>(
    `SELECT r.id, r.customer_id, c.company_name AS customer_name, r.frequency,
            r.start_date::text, r.end_date::text, r.next_due::text, r.last_generated_date::text,
            r.generated_count, r.is_active, r.tax_rate::text, r.notes
       FROM recurring_invoices r
       JOIN customers c ON c.company_id = r.company_id AND c.id = r.customer_id
      WHERE r.company_id = $1
      ORDER BY r.next_due ASC, r.id DESC`,
    [companyId]
  );
  if (hdrs.rows.length === 0) return [];
  const ids = hdrs.rows.map(r => Number(r.id));
  const linesRes = await tx.query<any>(
    `SELECT recurring_invoice_id, item_id, description, quantity::text, rate::text, is_taxable
       FROM recurring_invoice_lines
      WHERE company_id = $1 AND recurring_invoice_id = ANY($2::BIGINT[])
      ORDER BY line_order ASC`,
    [companyId, ids]
  );
  const linesMap = new Map<number, any[]>();
  for (const l of linesRes.rows) {
    const rid = Number(l.recurring_invoice_id);
    const arr = linesMap.get(rid) ?? [];
    arr.push({
      itemId: l.item_id !== null ? Number(l.item_id) : null,
      description: l.description,
      quantity: Number(l.quantity),
      rate: toMoneyNumber(parseDecimal4(l.rate)),
      taxable: Boolean(l.is_taxable),
    });
    linesMap.set(rid, arr);
  }
  return hdrs.rows.map(r => ({
    id: Number(r.id),
    customerId: Number(r.customer_id),
    customerName: r.customer_name,
    frequency: r.frequency,
    startDate: r.start_date,
    endDate: r.end_date,
    nextDue: r.next_due,
    lastGeneratedDate: r.last_generated_date,
    generatedCount: Number(r.generated_count),
    isActive: Boolean(r.is_active),
    taxRate: Number(r.tax_rate),
    notes: r.notes || '',
    lines: linesMap.get(Number(r.id)) ?? [],
  }));
}

export async function createRecurringInvoice(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
    startDate?: string;
    endDate?: string | null;
    taxRate?: string | number;
    notes?: string | null;
    lines: InvoiceLineInput[];
  }
) {
  const startDate = input.startDate ? assertIsoDate(input.startDate, 'startDate') : todayIsoDate();
  if (!['weekly', 'biweekly', 'monthly', 'quarterly', 'annual'].includes(input.frequency)) {
    throw new AccountingError(400, 'Invalid recurring frequency');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'At least one recurring line is required');
  }

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO recurring_invoices (
       company_id, customer_id, frequency, start_date, end_date, next_due, tax_rate, notes
     ) VALUES ($1, $2, $3, $4::DATE, $5::DATE, $4::DATE, $6::NUMERIC(9,6), $7)
     RETURNING id`,
    [
      companyId,
      Number(input.customerId),
      input.frequency,
      startDate,
      input.endDate || null,
      formatDecimal6(parseDecimal6(input.taxRate ?? 0)),
      input.notes?.trim() || null,
    ]
  );
  const recId = Number(ins.rows[0].id);

  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    await tx.query(
      `INSERT INTO recurring_invoice_lines (
         company_id, recurring_invoice_id, item_id, description, quantity, rate, is_taxable, line_order
       ) VALUES ($1, $2, $3, $4, $5::NUMERIC(19,6), $6::NUMERIC(19,4), $7, $8)`,
      [
        companyId,
        recId,
        l.itemId ? Number(l.itemId) : null,
        String(l.description || '').trim(),
        formatDecimal6(parseDecimal6(l.quantity)),
        formatDecimal4(parseDecimal4(l.rate)),
        Boolean(l.taxable),
        i + 1,
      ]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'RECURRING_INVOICE_CREATED',
    tableName: 'recurring_invoices',
    recordId: recId,
    newValues: { customerId: input.customerId, frequency: input.frequency, startDate },
  });

  const all = await listRecurringInvoices(tx, companyId);
  return all.find(r => r.id === recId)!;
}

export async function runDueRecurringInvoices(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  asOfDate?: string
) {
  const runDate = asOfDate ? assertIsoDate(asOfDate, 'asOfDate') : todayIsoDate();
  const dueRes = await tx.query<{
    id: number;
    customer_id: number;
    frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
    next_due: string;
    end_date: string | null;
    tax_rate: string;
    notes: string | null;
  }>(
    `SELECT id, customer_id, frequency, next_due::text, end_date::text, tax_rate::text, notes
       FROM recurring_invoices
      WHERE company_id = $1 AND is_active = TRUE AND next_due <= $2::DATE
      ORDER BY next_due ASC, id ASC
      FOR UPDATE`,
    [companyId, runDate]
  );

  const generatedInvoices: any[] = [];
  for (const rec of dueRes.rows) {
    const linesRes = await tx.query<{
      item_id: number | null;
      description: string;
      quantity: string;
      rate: string;
      is_taxable: boolean;
    }>(
      `SELECT item_id, description, quantity::text, rate::text, is_taxable
         FROM recurring_invoice_lines
        WHERE company_id = $1 AND recurring_invoice_id = $2
        ORDER BY line_order ASC`,
      [companyId, Number(rec.id)]
    );

    const created = await createInvoiceOrSalesReceipt(tx, companyId, actor, {
      customerId: Number(rec.customer_id),
      invoiceDate: rec.next_due,
      taxRate: rec.tax_rate,
      notes: rec.notes || `Auto-generated recurring invoice (${rec.frequency})`,
      idempotencyKey: `rec-inv-${companyId}-${rec.id}-${rec.next_due}`,
      lines: linesRes.rows.map(l => ({
        itemId: l.item_id !== null ? Number(l.item_id) : null,
        description: l.description,
        quantity: l.quantity,
        rate: l.rate,
        taxable: l.is_taxable,
      })),
    });
    generatedInvoices.push(created.invoice);

    const nextDue = advanceRecurringDate(rec.next_due, rec.frequency);
    const keepActive = !rec.end_date || nextDue <= rec.end_date;
    await tx.query(
      `UPDATE recurring_invoices
          SET last_generated_date = $3::DATE,
              next_due = $4::DATE,
              generated_count = generated_count + 1,
              is_active = $5
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(rec.id), rec.next_due, nextDue, keepActive]
    );
  }

  return { runDate, generatedCount: generatedInvoices.length, invoices: generatedInvoices };
}

export async function listCommunicationsAndReminders(tx: Transaction, companyId: number) {
  const [rules, reminders, templates, messages, emails] = await Promise.all([
    tx.query<any>(
      `SELECT id, days_from_due, enabled, subject, body FROM invoice_reminder_rules WHERE company_id = $1 ORDER BY days_from_due ASC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT r.id, r.invoice_id, i.invoice_number, c.company_name AS customer_name, r.recipient,
              r.status, r.days_from_due, r.balance_due::text, r.sent_at::text
         FROM invoice_reminders r
         JOIN invoices i ON i.company_id = r.company_id AND i.id = r.invoice_id
         JOIN customers c ON c.company_id = r.company_id AND c.id = r.customer_id
        WHERE r.company_id = $1
        ORDER BY r.sent_at DESC LIMIT 100`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT id, kind, subject, body, is_default FROM email_templates WHERE company_id = $1 ORDER BY id ASC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT id, name, kind, body FROM invoice_messages WHERE company_id = $1 ORDER BY id ASC`,
      [companyId]
    ),
    tx.query<any>(
      `SELECT id, recipient, subject, entity_type, entity_id, status, attempts, last_error,
              next_attempt_at::text AS next_attempt_at, sent_at::text
         FROM email_log WHERE company_id = $1 ORDER BY sent_at DESC LIMIT 100`,
      [companyId]
    ),
  ]);

  return {
    reminderRules: rules.rows.map(r => ({
      id: Number(r.id),
      daysFromDue: Number(r.days_from_due),
      enabled: Boolean(r.enabled),
      subject: r.subject,
      body: r.body,
    })),
    remindersSent: reminders.rows.map(r => ({
      id: Number(r.id),
      invoiceId: Number(r.invoice_id),
      invoiceNumber: r.invoice_number,
      customerName: r.customer_name,
      recipient: r.recipient,
      status: r.status,
      daysFromDue: Number(r.days_from_due),
      balanceDue: toMoneyNumber(parseDecimal4(r.balance_due)),
      sentAt: r.sent_at,
    })),
    emailTemplates: templates.rows.map(t => ({
      id: Number(t.id),
      kind: t.kind,
      subject: t.subject,
      body: t.body,
      isDefault: Boolean(t.is_default),
    })),
    invoiceMessages: messages.rows.map(m => ({
      id: Number(m.id),
      name: m.name,
      kind: m.kind,
      body: m.body,
    })),
    emailLog: emails.rows.map(e => ({
      id: Number(e.id),
      recipient: e.recipient,
      subject: e.subject,
      entityType: e.entity_type,
      entityId: e.entity_id !== null ? Number(e.entity_id) : null,
      status: e.status,
      attempts: Number(e.attempts ?? 0),
      lastError: e.last_error ? String(e.last_error) : null,
      nextAttemptAt: e.next_attempt_at ? String(e.next_attempt_at) : null,
      sentAt: e.sent_at,
    })),
  };
}

export async function dispatchInvoiceReminder(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { invoiceId: number; ruleId?: number | null; recipient?: string; subject?: string }
) {
  const invRes = await tx.query<{
    id: number;
    invoice_number: string;
    customer_id: number;
    due_date: string;
    balance_due: string;
    email: string | null;
    company_name: string;
  }>(
    `SELECT i.id, i.invoice_number, i.customer_id, i.due_date::text, i.balance_due::text,
            c.email, c.company_name
       FROM invoices i
       JOIN customers c ON c.company_id = i.company_id AND c.id = i.customer_id
      WHERE i.company_id = $1 AND i.id = $2 LIMIT 1`,
    [companyId, Number(input.invoiceId)]
  );
  if (invRes.rows.length === 0) throw new AccountingError(404, 'Invoice not found');
  const inv = invRes.rows[0];
  const recipient = input.recipient?.trim() || inv.email || 'accounts@customer.zm';
  const subject = input.subject?.trim() || `Payment Reminder: ${inv.invoice_number}`;

  const daysRes = await tx.query<{ diff: number }>(
    `SELECT (CURRENT_DATE - $1::DATE)::INTEGER AS diff`,
    [inv.due_date]
  );
  const daysFromDue = Number(daysRes.rows[0]?.diff || 0);

  const remIns = await tx.query<{ id: number }>(
    `INSERT INTO invoice_reminders (
       company_id, invoice_id, rule_id, customer_id, recipient, status, days_from_due, balance_due
     ) VALUES ($1, $2, $3, $4, $5, 'sent', $6, $7::NUMERIC(19,4))
     RETURNING id`,
    [
      companyId,
      inv.id,
      input.ruleId ? Number(input.ruleId) : null,
      inv.customer_id,
      recipient,
      daysFromDue,
      inv.balance_due,
    ]
  );
  await tx.query(
    `INSERT INTO email_log (company_id, recipient, subject, entity_type, entity_id, status, sent_by)
     VALUES ($1, $2, $3, 'invoice', $4, 'sent', $5)`,
    [companyId, recipient, subject, inv.id, actor.userId]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'INVOICE_REMINDER_SENT',
    tableName: 'invoice_reminders',
    recordId: Number(remIns.rows[0].id),
    newValues: { invoiceNumber: inv.invoice_number, recipient, daysFromDue },
  });

  return {
    id: Number(remIns.rows[0].id),
    invoiceId: inv.id,
    invoiceNumber: inv.invoice_number,
    customerName: inv.company_name,
    recipient,
    daysFromDue,
    balanceDue: toMoneyNumber(parseDecimal4(inv.balance_due)),
    status: 'sent',
  };
}
