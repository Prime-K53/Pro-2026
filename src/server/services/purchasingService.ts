import { Transaction } from '@electric-sql/pglite';
import {
  AccountingError,
  ActorContext,
  JournalLineInput,
  postJournalEntry,
  reverseJournalEntry,
} from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal4, parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import {
  addDaysToIso,
  assertIsoDate,
  checkRouteIdempotency,
  computeTax4,
  convertForeign4ToBase4,
  divRoundBigInt,
  formatDecimal6,
  generateNextDocNumber,
  multiplyQty6ByRate4,
  parseDecimal6,
  recalculateVendorBalance,
  resolveCommercialContext,
  resolveExchangeRate6,
  saveRouteIdempotency,
  todayIsoDate,
} from './commercialHelpers.ts';

// ============================================================================
// VENDORS / SUPPLIERS
// ============================================================================

export async function listVendors(tx: Transaction, companyId: number) {
  const res = await tx.query<{
    id: number;
    name: string;
    company_name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    ein_or_ssn: string | null;
    is_1099_eligible: boolean;
    default_expense_account_id: number | null;
    payment_term_id: number | null;
    terms_label: string;
    balance: string;
    is_active: boolean;
    created_at: string;
  }>(
    `SELECT id, name, company_name, email, phone, address, ein_or_ssn, is_1099_eligible,
            default_expense_account_id, payment_term_id, terms_label, balance::text,
            is_active, created_at::text
       FROM vendors
      WHERE company_id = $1
      ORDER BY company_name ASC, id ASC`,
    [companyId]
  );

  return res.rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    companyName: r.company_name,
    email: r.email || '',
    phone: r.phone || '',
    address: r.address || '',
    taxId: r.ein_or_ssn || '',
    is1099Eligible: Boolean(r.is_1099_eligible),
    defaultExpenseAccountId: r.default_expense_account_id !== null ? Number(r.default_expense_account_id) : null,
    paymentTermId: r.payment_term_id !== null ? Number(r.payment_term_id) : null,
    terms: r.terms_label,
    balance: toMoneyNumber(parseDecimal4(r.balance)),
    balanceStr: r.balance,
    isActive: Boolean(r.is_active),
    createdAt: r.created_at,
  }));
}

export async function createVendor(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    name?: string;
    companyName: string;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    taxId?: string | null;
    is1099Eligible?: boolean;
    defaultExpenseAccountId?: number | null;
    paymentTermId?: number | null;
    terms?: string | null;
  }
) {
  const companyName = String(input.companyName || input.name || '').trim();
  if (!companyName) throw new AccountingError(400, 'Vendor companyName is required');
  const name = String(input.name || companyName).trim();

  let termsLabel = input.terms?.trim() || 'Net 30';
  let termId: number | null = input.paymentTermId ? Number(input.paymentTermId) : null;
  if (termId) {
    const tRes = await tx.query<{ name: string }>(
      `SELECT name FROM payment_terms WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, termId]
    );
    if (tRes.rows.length === 0) throw new AccountingError(404, 'Payment term not found');
    termsLabel = tRes.rows[0].name;
  }

  let defaultExpId: number | null = input.defaultExpenseAccountId ? Number(input.defaultExpenseAccountId) : null;
  if (defaultExpId) {
    const aRes = await tx.query<{ id: number }>(
      `SELECT id FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, defaultExpId]
    );
    if (aRes.rows.length === 0) throw new AccountingError(404, 'Default expense account not found');
  }

  try {
    const ins = await tx.query<{ id: number }>(
      `INSERT INTO vendors (
         company_id, name, company_name, email, phone, address, ein_or_ssn,
         is_1099_eligible, default_expense_account_id, payment_term_id, terms_label
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        companyId,
        name,
        companyName,
        input.email?.trim() || null,
        input.phone?.trim() || null,
        input.address?.trim() || null,
        input.taxId?.trim() || null,
        Boolean(input.is1099Eligible),
        defaultExpId,
        termId,
        termsLabel,
      ]
    );
    const id = Number(ins.rows[0].id);

    await writeAuditLog(tx, {
      companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'VENDOR_CREATED',
      tableName: 'vendors',
      recordId: id,
      newValues: { name, companyName, termsLabel },
    });

    const all = await listVendors(tx, companyId);
    return all.find(v => v.id === id)!;
  } catch (err: any) {
    if (String(err?.code) === '23505') {
      throw new AccountingError(409, `Vendor "${name}" already exists`);
    }
    throw err;
  }
}

export async function updateVendor(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  vendorId: number,
  input: {
    name?: string;
    companyName?: string;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    taxId?: string | null;
    is1099Eligible?: boolean;
    defaultExpenseAccountId?: number | null;
    terms?: string | null;
    isActive?: boolean;
  }
) {
  const existing = await tx.query<any>(
    `SELECT * FROM vendors WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, vendorId]
  );
  if (existing.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const prev = existing.rows[0];

  await tx.query(
    `UPDATE vendors
        SET name = COALESCE($3, name),
            company_name = COALESCE($4, company_name),
            email = COALESCE($5, email),
            phone = COALESCE($6, phone),
            address = COALESCE($7, address),
            ein_or_ssn = COALESCE($8, ein_or_ssn),
            is_1099_eligible = COALESCE($9, is_1099_eligible),
            default_expense_account_id = COALESCE($10, default_expense_account_id),
            terms_label = COALESCE($11, terms_label),
            is_active = COALESCE($12, is_active)
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      vendorId,
      input.name?.trim() || null,
      input.companyName?.trim() || null,
      input.email === undefined ? null : input.email?.trim() || null,
      input.phone === undefined ? null : input.phone?.trim() || null,
      input.address === undefined ? null : input.address?.trim() || null,
      input.taxId === undefined ? null : input.taxId?.trim() || null,
      input.is1099Eligible === undefined ? null : Boolean(input.is1099Eligible),
      input.defaultExpenseAccountId === undefined ? null : input.defaultExpenseAccountId,
      input.terms?.trim() || null,
      input.isActive === undefined ? null : Boolean(input.isActive),
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'VENDOR_UPDATED',
    tableName: 'vendors',
    recordId: vendorId,
    oldValues: { companyName: prev.company_name, terms: prev.terms_label },
    newValues: { companyName: input.companyName ?? prev.company_name, terms: input.terms ?? prev.terms_label },
  });

  const all = await listVendors(tx, companyId);
  return all.find(v => v.id === vendorId)!;
}

// ============================================================================
// PURCHASE ORDERS
// ============================================================================

export async function listPurchaseOrders(tx: Transaction, companyId: number) {
  const hdrs = await tx.query<{
    id: number;
    po_number: string;
    vendor_id: number;
    vendor_name: string;
    po_date: string;
    expected_date: string | null;
    ship_to: string | null;
    status: string;
    total: string;
    notes: string | null;
  }>(
    `SELECT po.id, po.po_number, po.vendor_id, v.company_name AS vendor_name,
            po.po_date::text, po.expected_date::text, po.ship_to, po.status,
            po.total::text, po.notes
       FROM purchase_orders po
       JOIN vendors v ON v.company_id = po.company_id AND v.id = po.vendor_id
      WHERE po.company_id = $1
      ORDER BY po.po_date DESC, po.id DESC`,
    [companyId]
  );
  if (hdrs.rows.length === 0) return [];
  const ids = hdrs.rows.map(r => Number(r.id));
  const linesRes = await tx.query<any>(
    `SELECT id, purchase_order_id, line_order, item_id, account_id, description,
            quantity::text, received_qty::text, rate::text, amount::text, billed_amount::text
       FROM purchase_order_lines
      WHERE company_id = $1 AND purchase_order_id = ANY($2::BIGINT[])
      ORDER BY purchase_order_id ASC, line_order ASC`,
    [companyId, ids]
  );
  const linesByPo = new Map<number, any[]>();
  for (const l of linesRes.rows) {
    const pid = Number(l.purchase_order_id);
    const arr = linesByPo.get(pid) ?? [];
    arr.push({
      id: Number(l.id),
      lineOrder: Number(l.line_order),
      itemId: l.item_id !== null ? Number(l.item_id) : null,
      accountId: l.account_id !== null ? Number(l.account_id) : null,
      description: l.description,
      quantity: Number(l.quantity),
      receivedQty: Number(l.received_qty),
      rate: toMoneyNumber(parseDecimal4(l.rate)),
      amount: toMoneyNumber(parseDecimal4(l.amount)),
      billedAmount: toMoneyNumber(parseDecimal4(l.billed_amount)),
    });
    linesByPo.set(pid, arr);
  }

  return hdrs.rows.map(r => ({
    id: Number(r.id),
    poNumber: r.po_number,
    vendorId: Number(r.vendor_id),
    vendorName: r.vendor_name,
    poDate: r.po_date,
    expectedDate: r.expected_date,
    shipTo: r.ship_to || '',
    status: r.status,
    total: toMoneyNumber(parseDecimal4(r.total)),
    totalStr: r.total,
    notes: r.notes || '',
    lines: linesByPo.get(Number(r.id)) ?? [],
  }));
}

export async function createPurchaseOrder(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    vendorId: number;
    poNumber?: string;
    poDate?: string;
    expectedDate?: string;
    shipTo?: string | null;
    notes?: string | null;
    lines: Array<{
      itemId?: number | null;
      accountId?: number | null;
      description: string;
      quantity: string | number;
      rate: string | number;
    }>;
  }
) {
  const vendorId = Number(input.vendorId);
  const vRes = await tx.query<{ id: number; default_expense_account_id: number | null }>(
    `SELECT id, default_expense_account_id FROM vendors WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'Purchase order requires at least one line');
  }

  const poDate = input.poDate ? assertIsoDate(input.poDate, 'poDate') : todayIsoDate();
  const expectedDate = input.expectedDate ? assertIsoDate(input.expectedDate, 'expectedDate') : addDaysToIso(poDate, 14);
  const poNumber = input.poNumber?.trim() || (await generateNextDocNumber(tx, companyId, 'purchase_orders', 'po_number', 'PO'));
  const ctx = await resolveCommercialContext(tx, companyId, actor);

  let total4 = 0n;
  const prepared: any[] = [];
  for (const raw of input.lines) {
    const qty6 = parseDecimal6(raw.quantity);
    const rate4 = parseDecimal4(raw.rate);
    if (qty6 <= 0n || rate4 < 0n) throw new AccountingError(400, 'PO line quantity must be > 0 and rate >= 0');
    const amt4 = multiplyQty6ByRate4(qty6, rate4, ctx.roundingMode);
    total4 += amt4;
    prepared.push({
      itemId: raw.itemId ? Number(raw.itemId) : null,
      accountId: raw.accountId ? Number(raw.accountId) : vRes.rows[0].default_expense_account_id || ctx.inventory1200,
      description: String(raw.description || '').trim() || 'Purchase item',
      qty6,
      rate4,
      amt4,
    });
  }

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO purchase_orders (
       company_id, po_number, vendor_id, po_date, expected_date, ship_to, status, total, notes
     ) VALUES ($1, $2, $3, $4::DATE, $5::DATE, $6, 'open', $7::NUMERIC(19,4), $8)
     RETURNING id`,
    [companyId, poNumber, vendorId, poDate, expectedDate, input.shipTo?.trim() || null, formatDecimal4(total4), input.notes?.trim() || null]
  );
  const poId = Number(ins.rows[0].id);

  for (let i = 0; i < prepared.length; i++) {
    const l = prepared[i];
    await tx.query(
      `INSERT INTO purchase_order_lines (
         company_id, purchase_order_id, line_order, item_id, account_id, description,
         quantity, received_qty, rate, amount, billed_amount
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(19,6), 0.000000, $8::NUMERIC(19,4), $9::NUMERIC(19,4), 0.0000)`,
      [companyId, poId, i + 1, l.itemId, l.accountId, l.description, formatDecimal6(l.qty6), formatDecimal4(l.rate4), formatDecimal4(l.amt4)]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PURCHASE_ORDER_CREATED',
    tableName: 'purchase_orders',
    recordId: poId,
    newValues: { poNumber, vendorId, total: formatDecimal4(total4) },
  });

  const all = await listPurchaseOrders(tx, companyId);
  return all.find(p => p.id === poId)!;
}

export async function receivePurchaseOrderToBill(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  poId: number,
  input: {
    billNumber?: string;
    billDate?: string;
    dueDate?: string;
    receiveLines?: Array<{ poLineId: number; receiveQty: string | number; unitCost?: string | number }>;
    memo?: string | null;
    idempotencyKey?: string | null;
  }
) {
  const poRes = await tx.query<{
    id: number;
    po_number: string;
    vendor_id: number;
    status: string;
  }>(
    `SELECT id, po_number, vendor_id, status
       FROM purchase_orders WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, poId]
  );
  if (poRes.rows.length === 0) throw new AccountingError(404, 'Purchase order not found');
  const po = poRes.rows[0];
  if (po.status === 'closed' || po.status === 'cancelled') {
    throw new AccountingError(409, `Purchase order ${po.po_number} is already ${po.status}`);
  }

  const linesRes = await tx.query<{
    id: number;
    item_id: number | null;
    account_id: number | null;
    description: string;
    quantity: string;
    received_qty: string;
    rate: string;
    billed_amount: string;
  }>(
    `SELECT id, item_id, account_id, description, quantity::text, received_qty::text, rate::text, billed_amount::text
       FROM purchase_order_lines
      WHERE company_id = $1 AND purchase_order_id = $2
      ORDER BY line_order ASC
      FOR UPDATE`,
    [companyId, poId]
  );

  const reqMap = new Map<number, { qty6: bigint; rate?: string | number }>();
  if (Array.isArray(input.receiveLines) && input.receiveLines.length > 0) {
    for (const rl of input.receiveLines) {
      reqMap.set(Number(rl.poLineId), { qty6: parseDecimal6(rl.receiveQty), rate: rl.unitCost });
    }
  }

  const billLines: BillLineInput[] = [];
  let anyRemaining = false;

  for (const l of linesRes.rows) {
    const lid = Number(l.id);
    const ordered6 = parseDecimal6(l.quantity);
    const already6 = parseDecimal6(l.received_qty);
    const remaining6 = ordered6 - already6;

    const req = reqMap.get(lid);
    const rec6 = reqMap.size > 0 ? (req?.qty6 ?? 0n) : remaining6;
    if (rec6 < 0n || rec6 > remaining6) {
      throw new AccountingError(400, `Cannot receive more than remaining open quantity on PO line ${lid}`);
    }

    const newReceived6 = already6 + rec6;
    if (newReceived6 < ordered6) anyRemaining = true;

    if (rec6 > 0n) {
      const rateStr = req?.rate !== undefined ? req.rate : l.rate;
      const amt4 = multiplyQty6ByRate4(rec6, parseDecimal4(rateStr), 'HALF_EVEN');
      await tx.query(
        `UPDATE purchase_order_lines
            SET received_qty = $3::NUMERIC(19,6),
                billed_amount = (billed_amount + $4::NUMERIC(19,4))
          WHERE company_id = $1 AND id = $2`,
        [companyId, lid, formatDecimal6(newReceived6), formatDecimal4(amt4)]
      );
      billLines.push({
        poLineId: lid,
        itemId: l.item_id !== null ? Number(l.item_id) : null,
        accountId: l.account_id !== null ? Number(l.account_id) : undefined,
        description: l.description,
        quantity: formatDecimal6(rec6),
        unitCost: rateStr,
      });
    }
  }

  if (billLines.length === 0) {
    throw new AccountingError(400, 'No open purchase order lines selected to receive');
  }

  const billResult = await createBill(tx, companyId, actor, {
    vendorId: Number(po.vendor_id),
    purchaseOrderId: poId,
    billNumber: input.billNumber,
    billDate: input.billDate,
    dueDate: input.dueDate,
    memo: input.memo || `Received from PO ${po.po_number}`,
    idempotencyKey: input.idempotencyKey,
    lines: billLines,
  });

  const nextStatus = anyRemaining ? 'partially_received' : 'closed';
  await tx.query(
    `UPDATE purchase_orders SET status = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, poId, nextStatus]
  );

  return {
    purchaseOrderId: poId,
    poStatus: nextStatus,
    bill: billResult.bill,
  };
}

// ============================================================================
// BILLS (ACCOUNTS PAYABLE) + INVENTORY RECEIPT + GL POSTING
// ============================================================================

export interface BillLineInput {
  poLineId?: number | null;
  accountId?: number | null;
  itemId?: number | null;
  description: string;
  quantity?: string | number;
  unitCost: string | number;
  useTaxRate?: string | number;
  classId?: number | null;
}

export async function listBills(tx: Transaction, companyId: number, vendorId?: number) {
  const res = await tx.query<any>(
    `SELECT b.id, b.bill_number, b.vendor_id, v.company_name AS vendor_name,
            b.bill_date::text, b.due_date::text, b.terms_label, b.status,
            b.total::text, b.amount_paid::text, b.balance_due::text,
            b.purchase_order_id, b.currency_code, b.exchange_rate::text,
            b.foreign_total::text, b.foreign_balance_due::text,
            b.journal_txn_id, b.memo
       FROM bills b
       JOIN vendors v ON v.company_id = b.company_id AND v.id = b.vendor_id
      WHERE b.company_id = $1 ${vendorId ? 'AND b.vendor_id = $2' : ''}
      ORDER BY b.bill_date DESC, b.id DESC`,
    vendorId ? [companyId, vendorId] : [companyId]
  );
  if (res.rows.length === 0) return [];
  const ids = res.rows.map((r: any) => Number(r.id));
  const linesRes = await tx.query<any>(
    `SELECT l.bill_id, l.line_order, l.account_id, a.name AS account_name, l.item_id,
            l.description, l.quantity::text, l.unit_cost::text, l.amount::text, l.use_tax_rate::text
       FROM bill_lines l
       JOIN accounts a ON a.company_id = l.company_id AND a.id = l.account_id
      WHERE l.company_id = $1 AND l.bill_id = ANY($2::BIGINT[])
      ORDER BY l.bill_id ASC, l.line_order ASC`,
    [companyId, ids]
  );
  const linesByBill = new Map<number, any[]>();
  for (const l of linesRes.rows) {
    const bid = Number(l.bill_id);
    const arr = linesByBill.get(bid) ?? [];
    arr.push({
      lineOrder: Number(l.line_order),
      accountId: Number(l.account_id),
      accountName: l.account_name,
      itemId: l.item_id !== null ? Number(l.item_id) : null,
      description: l.description,
      quantity: Number(l.quantity),
      unitCost: Number(l.unit_cost),
      amount: toMoneyNumber(parseDecimal4(l.amount)),
      useTaxRate: Number(l.use_tax_rate),
    });
    linesByBill.set(bid, arr);
  }

  return res.rows.map((r: any) => ({
    id: Number(r.id),
    billNumber: r.bill_number,
    vendorId: Number(r.vendor_id),
    vendorName: r.vendor_name,
    billDate: r.bill_date,
    dueDate: r.due_date,
    terms: r.terms_label,
    status: r.status,
    total: toMoneyNumber(parseDecimal4(r.total)),
    totalStr: r.total,
    amountPaid: toMoneyNumber(parseDecimal4(r.amount_paid)),
    balanceDue: toMoneyNumber(parseDecimal4(r.balance_due)),
    purchaseOrderId: r.purchase_order_id !== null ? Number(r.purchase_order_id) : null,
    currencyCode: r.currency_code || 'ZMW',
    exchangeRate: Number(r.exchange_rate || 1),
    foreignTotal: toMoneyNumber(parseDecimal4(r.foreign_total)),
    foreignBalanceDue: toMoneyNumber(parseDecimal4(r.foreign_balance_due)),
    journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
    memo: r.memo || '',
    lines: linesByBill.get(Number(r.id)) ?? [],
  }));
}

export async function createBill(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    vendorId: number;
    purchaseOrderId?: number | null;
    billNumber?: string;
    billDate?: string;
    dueDate?: string;
    terms?: string | null;
    currencyCode?: string;
    exchangeRate?: string | number;
    memo?: string | null;
    idempotencyKey?: string | null;
    lines: BillLineInput[];
  }
) {
  const idem = await checkRouteIdempotency<{ bill: any }>(
    tx,
    companyId,
    'bill_create',
    input.idempotencyKey,
    input
  );
  if (idem.hit) return { bill: idem.response.bill, idempotentReplay: true };

  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const vendorId = Number(input.vendorId);
  const vRes = await tx.query<{
    id: number;
    company_name: string;
    default_expense_account_id: number | null;
    terms_label: string;
  }>(
    `SELECT id, company_name, default_expense_account_id, terms_label
       FROM vendors WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const vendor = vRes.rows[0];

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'At least one bill line is required');
  }

  const billDate = input.billDate ? assertIsoDate(input.billDate, 'billDate') : todayIsoDate();
  const termsLabel = input.terms?.trim() || vendor.terms_label || 'Net 30';
  const netDays = termsLabel.toLowerCase().includes('receipt')
    ? 0
    : Number(termsLabel.match(/\d+/)?.[0] || 30);
  const dueDate = input.dueDate ? assertIsoDate(input.dueDate, 'dueDate') : addDaysToIso(billDate, netDays);
  if (dueDate < billDate) {
    throw new AccountingError(400, 'Bill dueDate cannot be earlier than billDate');
  }

  const fx = await resolveExchangeRate6(
    tx,
    companyId,
    input.currencyCode,
    ctx.baseCurrency,
    billDate,
    input.exchangeRate
  );

  const billNumber = input.billNumber?.trim() || (await generateNextDocNumber(tx, companyId, 'bills', 'bill_number', 'BILL'));

  // Duplicate bill number guard for same vendor
  const dup = await tx.query<{ id: number }>(
    `SELECT id FROM bills WHERE company_id = $1 AND vendor_id = $2 AND bill_number = $3 LIMIT 1`,
    [companyId, vendorId, billNumber]
  );
  if (dup.rows.length > 0) {
    throw new AccountingError(
      409,
      `Duplicate bill number "${billNumber}" already exists for vendor ${vendor.company_name}`,
      'DUPLICATE_BILL_NUMBER'
    );
  }

  let foreignSubtotal4 = 0n;
  let foreignUseTax4 = 0n;
  const debitByAccountBase = new Map<number, bigint>();
  const preparedLines: any[] = [];
  const inventoryReceipts: Array<{ itemId: number; qtyPurchase6: bigint; lineCostBase4: bigint }> = [];

  for (const raw of input.lines) {
    const qty6 = parseDecimal6(raw.quantity ?? 1);
    const unitCost6 = parseDecimal6(raw.unitCost);
    if (qty6 <= 0n || unitCost6 < 0n) {
      throw new AccountingError(400, 'Bill line quantity must be > 0 and unitCost >= 0');
    }
    const lineAmtForeign4 = divRoundBigInt(qty6 * unitCost6, 100000000n, ctx.roundingMode);
    const lineAmtBase4 = convertForeign4ToBase4(lineAmtForeign4, fx.rate6, ctx.roundingMode);
    const useTaxRate6 = parseDecimal6(raw.useTaxRate ?? 0);
    const lineUseTaxForeign4 = computeTax4(lineAmtForeign4, useTaxRate6, ctx.roundingMode);

    foreignSubtotal4 += lineAmtForeign4;
    foreignUseTax4 += lineUseTaxForeign4;

    let accountId = raw.accountId ? Number(raw.accountId) : vendor.default_expense_account_id || ctx.inventory1200;
    if (raw.itemId) {
      const itemRes = await tx.query<{
        id: number;
        item_type: string;
        asset_account_id: number;
        cogs_account_id: number;
      }>(
        `SELECT id, item_type, asset_account_id, cogs_account_id
           FROM inventory_items WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, Number(raw.itemId)]
      );
      if (itemRes.rows.length === 0) throw new AccountingError(404, `Inventory item ${raw.itemId} not found`);
      const item = itemRes.rows[0];
      if (!raw.accountId) {
        accountId =
          item.item_type === 'raw_material' || item.item_type === 'stationery'
            ? Number(item.asset_account_id)
            : Number(item.cogs_account_id);
      }
      if (item.item_type === 'raw_material' || item.item_type === 'stationery') {
        inventoryReceipts.push({
          itemId: Number(item.id),
          qtyPurchase6: qty6,
          lineCostBase4: lineAmtBase4,
        });
      }
    }

    const acctChk = await tx.query<{ id: number }>(
      `SELECT id FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, accountId]
    );
    if (acctChk.rows.length === 0) throw new AccountingError(404, `Account ${accountId} not found`);

    debitByAccountBase.set(accountId, (debitByAccountBase.get(accountId) ?? 0n) + lineAmtBase4);
    preparedLines.push({
      poLineId: raw.poLineId ? Number(raw.poLineId) : null,
      accountId,
      itemId: raw.itemId ? Number(raw.itemId) : null,
      description: String(raw.description || '').trim() || 'Vendor charge',
      qty6,
      unitCost6,
      amountForeign4: lineAmtForeign4,
      useTaxRate6,
      classId: raw.classId ? Number(raw.classId) : null,
    });
  }

  const baseSubtotal4 = convertForeign4ToBase4(foreignSubtotal4, fx.rate6, ctx.roundingMode);
  const baseUseTax4 = convertForeign4ToBase4(foreignUseTax4, fx.rate6, ctx.roundingMode);
  // Use tax adds to expense/AP accrual if specified, matching QuickBooks use-tax payable
  const foreignTotal4 = foreignSubtotal4;
  const baseTotal4 = baseSubtotal4;

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO bills (
       company_id, bill_number, vendor_id, bill_date, due_date, terms_label, status,
       total, amount_paid, balance_due, purchase_order_id,
       currency_code, exchange_rate, foreign_total, foreign_balance_due, memo
     ) VALUES (
       $1, $2, $3, $4::DATE, $5::DATE, $6, 'open',
       $7::NUMERIC(19,4), 0.0000, $7::NUMERIC(19,4), $8,
       $9, $10::NUMERIC(19,6), $11::NUMERIC(19,4), $11::NUMERIC(19,4), $12
     ) RETURNING id`,
    [
      companyId,
      billNumber,
      vendorId,
      billDate,
      dueDate,
      termsLabel,
      formatDecimal4(baseTotal4),
      input.purchaseOrderId ? Number(input.purchaseOrderId) : null,
      fx.currencyCode,
      fx.rateStr,
      formatDecimal4(foreignTotal4),
      input.memo?.trim() || null,
    ]
  );
  const billId = Number(ins.rows[0].id);

  for (let i = 0; i < preparedLines.length; i++) {
    const l = preparedLines[i];
    await tx.query(
      `INSERT INTO bill_lines (
         company_id, bill_id, line_order, account_id, item_id, description,
         quantity, unit_cost, amount, use_tax_rate, class_id, po_line_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(19,6), $8::NUMERIC(19,6), $9::NUMERIC(19,4), $10::NUMERIC(9,6), $11, $12)`,
      [
        companyId,
        billId,
        i + 1,
        l.accountId,
        l.itemId,
        l.description,
        formatDecimal6(l.qty6),
        formatDecimal6(l.unitCost6),
        formatDecimal4(l.amountForeign4),
        formatDecimal6(l.useTaxRate6),
        l.classId,
        l.poLineId,
      ]
    );
  }

  // Receive stocked items into perpetual inventory ledger (applying conversion_factor for raw materials!)
  for (const rec of inventoryReceipts) {
    const itemRes = await tx.query<{
      id: number;
      on_hand: string;
      avg_cost: string;
      conversion_factor: string;
    }>(
      `SELECT id, on_hand::text, avg_cost::text, conversion_factor::text
         FROM inventory_items WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, rec.itemId]
    );
    const it = itemRes.rows[0];
    const conv6 = parseDecimal6(it.conversion_factor || '1');
    // addedUsageQty6 = qtyPurchase6 * conv6 / 1_000_000
    const addedUsage6 = divRoundBigInt(rec.qtyPurchase6 * conv6, 1000000n, ctx.roundingMode);
    if (addedUsage6 > 0n) {
      const prevQty6 = parseDecimal6(it.on_hand);
      const prevAvg6 = parseDecimal6(it.avg_cost);
      const prevVal8 = prevQty6 * prevAvg6; // scale 10^12 -> /10^6 for scale 10^6? Let's keep scale 10^6 per unit:
      const prevValBase6 = divRoundBigInt(prevVal8, 1000000n, ctx.roundingMode); // scaled 10^6
      const newValBase6 = prevValBase6 + rec.lineCostBase4 * 100n; // base4 -> scale 10^6
      const newQty6 = prevQty6 + addedUsage6;
      const newAvg6 = divRoundBigInt(newValBase6 * 1000000n, newQty6, ctx.roundingMode);
      const lineUnitCostUsage6 = divRoundBigInt(rec.lineCostBase4 * 100n * 1000000n, addedUsage6, ctx.roundingMode);

      await tx.query(
        `UPDATE inventory_items
            SET on_hand = $3::NUMERIC(19,6),
                avg_cost = $4::NUMERIC(19,6),
                unit_cost = $5::NUMERIC(19,6)
          WHERE company_id = $1 AND id = $2`,
        [companyId, rec.itemId, formatDecimal6(newQty6), formatDecimal6(newAvg6), formatDecimal6(lineUnitCostUsage6)]
      );

      await tx.query(
        `INSERT INTO inventory_movements (
           company_id, item_id, movement_type, quantity_delta, unit_cost, balance_qty, balance_avg_cost, source_type, source_id
         ) VALUES ($1, $2, 'purchase', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'bill', $7)`,
        [
          companyId,
          rec.itemId,
          formatDecimal6(addedUsage6),
          formatDecimal6(lineUnitCostUsage6),
          formatDecimal6(newQty6),
          formatDecimal6(newAvg6),
          billId,
        ]
      );
    }
  }

  // Build balanced GL journal: Dr Expense/Inventory (+ Use Tax Debit if > 0) | Cr AP 2000 (+ Cr Use Tax Payable 2200)
  const jeLines: JournalLineInput[] = [];
  for (const [acctId, amt4] of debitByAccountBase.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: acctId,
        debit: formatDecimal4(amt4),
        credit: '0.0000',
        description: `Bill ${billNumber} — ${vendor.company_name}`,
        partyType: 'vendor',
        partyId: vendorId,
      });
    }
  }
  if (baseUseTax4 > 0n) {
    const firstExpAcct = preparedLines[0].accountId;
    jeLines.push({
      accountId: firstExpAcct,
      debit: formatDecimal4(baseUseTax4),
      credit: '0.0000',
      description: `Use Tax Expense — Bill ${billNumber}`,
      partyType: 'vendor',
      partyId: vendorId,
    });
    jeLines.push({
      accountId: ctx.salesTax2200,
      debit: '0.0000',
      credit: formatDecimal4(baseUseTax4),
      description: `Use Tax Payable — Bill ${billNumber}`,
    });
  }
  if (baseTotal4 > 0n) {
    jeLines.push({
      accountId: ctx.ap2000,
      debit: '0.0000',
      credit: formatDecimal4(baseTotal4),
      description: `Accounts Payable — Bill ${billNumber}`,
      partyType: 'vendor',
      partyId: vendorId,
    });
  }

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate: billDate,
    description: `Vendor Bill ${billNumber} — ${vendor.company_name}`,
    reference: billNumber,
    sourceType: 'bill',
    sourceId: billId,
    idempotencyKey: `bill-je-${companyId}-${billId}`,
    lines: jeLines,
  });

  await tx.query(`UPDATE bills SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    billId,
    postedJe.transaction.id,
  ]);

  await recalculateVendorBalance(tx, companyId, vendorId);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BILL_POSTED',
    tableName: 'bills',
    recordId: billId,
    newValues: {
      billNumber,
      vendorId,
      total: formatDecimal4(baseTotal4),
      currencyCode: fx.currencyCode,
      journalTxnId: postedJe.transaction.id,
    },
  });

  const all = await listBills(tx, companyId, vendorId);
  const created = all.find(b => b.id === billId)!;
  await saveRouteIdempotency(
    tx,
    companyId,
    'bill_create',
    input.idempotencyKey,
    idem.payloadHash,
    201,
    { bill: created },
    actor.userId
  );

  return { bill: created, idempotentReplay: false };
}

export async function voidBill(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  billId: number,
  reason?: string
) {
  const bRes = await tx.query<{
    id: number;
    bill_number: string;
    vendor_id: number;
    status: string;
    amount_paid: string;
    journal_txn_id: number | null;
  }>(
    `SELECT id, bill_number, vendor_id, status, amount_paid::text, journal_txn_id
       FROM bills WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, billId]
  );
  if (bRes.rows.length === 0) throw new AccountingError(404, 'Bill not found');
  const bill = bRes.rows[0];
  if (bill.status === 'voided') throw new AccountingError(409, `Bill ${bill.bill_number} is already voided`);
  if (parseDecimal4(bill.amount_paid) > 0n) {
    throw new AccountingError(409, `Cannot void Bill ${bill.bill_number} because payments have already been applied`);
  }

  let reversalJournalId: number | null = null;
  if (bill.journal_txn_id) {
    const rev = await reverseJournalEntry(tx, companyId, actor, Number(bill.journal_txn_id), {
      reason: reason || `Void bill ${bill.bill_number}`,
    });
    reversalJournalId = rev.reversal.id;
  }

  // Reverse perpetual inventory receipts from this bill
  const movs = await tx.query<{ id: number; item_id: number; quantity_delta: string; unit_cost: string }>(
    `SELECT id, item_id, quantity_delta::text, unit_cost::text
       FROM inventory_movements
      WHERE company_id = $1 AND source_type = 'bill' AND source_id = $2 AND movement_type = 'purchase'`,
    [companyId, billId]
  );
  for (const m of movs.rows) {
    const itRes = await tx.query<{ on_hand: string; avg_cost: string }>(
      `SELECT on_hand::text, avg_cost::text FROM inventory_items WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, Number(m.item_id)]
    );
    if (itRes.rows.length > 0) {
      const cur6 = parseDecimal6(itRes.rows[0].on_hand);
      const delta6 = parseDecimal6(m.quantity_delta);
      const next6 = cur6 >= delta6 ? cur6 - delta6 : 0n;
      await tx.query(`UPDATE inventory_items SET on_hand = $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`, [
        companyId,
        Number(m.item_id),
        formatDecimal6(next6),
      ]);
      await tx.query(
        `INSERT INTO inventory_movements (
           company_id, item_id, movement_type, quantity_delta, unit_cost, balance_qty, balance_avg_cost, source_type, source_id, reverses_movement_id
         ) VALUES ($1, $2, 'void', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'bill_void', $7, $8)`,
        [
          companyId,
          Number(m.item_id),
          formatDecimal6(-delta6),
          m.unit_cost,
          formatDecimal6(next6),
          itRes.rows[0].avg_cost,
          billId,
          Number(m.id),
        ]
      );
    }
  }

  await tx.query(`UPDATE bills SET status = 'voided' WHERE company_id = $1 AND id = $2`, [companyId, billId]);
  await recalculateVendorBalance(tx, companyId, Number(bill.vendor_id));

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BILL_VOIDED',
    tableName: 'bills',
    recordId: billId,
    oldValues: { status: bill.status },
    newValues: { status: 'voided', reason: reason || null, reversalJournalId },
  });

  const all = await listBills(tx, companyId, Number(bill.vendor_id));
  return { bill: all.find(b => b.id === billId)!, reversalJournalId };
}

// ============================================================================
// BILL PAYMENTS (MULTI-BILL ALLOCATION + CHECK GENERATION + FX GAIN/LOSS)
// ============================================================================

export async function listBillPayments(tx: Transaction, companyId: number, vendorId?: number) {
  const res = await tx.query<any>(
    `SELECT bp.id, bp.payment_number, bp.vendor_id, v.company_name AS vendor_name,
            bp.payment_date::text, bp.amount::text, bp.bank_account_id, a.name AS bank_account_name,
            bp.check_number, bp.currency_code, bp.exchange_rate::text, bp.foreign_amount::text,
            bp.is_voided, bp.journal_txn_id, bp.memo
       FROM bill_payments bp
       JOIN vendors v ON v.company_id = bp.company_id AND v.id = bp.vendor_id
       JOIN accounts a ON a.company_id = bp.company_id AND a.id = bp.bank_account_id
      WHERE bp.company_id = $1 ${vendorId ? 'AND bp.vendor_id = $2' : ''}
      ORDER BY bp.payment_date DESC, bp.id DESC`,
    vendorId ? [companyId, vendorId] : [companyId]
  );

  if (res.rows.length === 0) return [];
  const ids = res.rows.map((r: any) => Number(r.id));
  const allocRes = await tx.query<any>(
    `SELECT a.bill_payment_id, a.bill_id, b.bill_number, a.amount::text
       FROM bill_payment_allocations a
       JOIN bills b ON b.company_id = a.company_id AND b.id = a.bill_id
      WHERE a.company_id = $1 AND a.bill_payment_id = ANY($2::BIGINT[])`,
    [companyId, ids]
  );
  const allocMap = new Map<number, any[]>();
  for (const a of allocRes.rows) {
    const pid = Number(a.bill_payment_id);
    const arr = allocMap.get(pid) ?? [];
    arr.push({
      billId: Number(a.bill_id),
      billNumber: a.bill_number,
      amount: toMoneyNumber(parseDecimal4(a.amount)),
    });
    allocMap.set(pid, arr);
  }

  return res.rows.map((r: any) => ({
    id: Number(r.id),
    paymentNumber: r.payment_number,
    vendorId: Number(r.vendor_id),
    vendorName: r.vendor_name,
    paymentDate: r.payment_date,
    amount: toMoneyNumber(parseDecimal4(r.amount)),
    bankAccountId: Number(r.bank_account_id),
    bankAccountName: r.bank_account_name,
    checkNumber: r.check_number || '',
    currencyCode: r.currency_code || 'ZMW',
    exchangeRate: Number(r.exchange_rate || 1),
    foreignAmount: toMoneyNumber(parseDecimal4(r.foreign_amount)),
    isVoided: Boolean(r.is_voided),
    journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
    memo: r.memo || '',
    allocations: allocMap.get(Number(r.id)) ?? [],
  }));
}

export async function recordBillPayment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    vendorId: number;
    paymentDate?: string;
    bankAccountId?: number;
    checkNumber?: string | null;
    printLater?: boolean;
    currencyCode?: string;
    exchangeRate?: string | number;
    memo?: string | null;
    idempotencyKey?: string | null;
    allocations: Array<{ billId: number; amount: string | number }>;
  }
) {
  const idem = await checkRouteIdempotency<{ billPayment: any }>(
    tx,
    companyId,
    'bill_payment_create',
    input.idempotencyKey,
    input
  );
  if (idem.hit) return { billPayment: idem.response.billPayment, idempotentReplay: true };

  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const vendorId = Number(input.vendorId);
  const vRes = await tx.query<{ id: number; company_name: string }>(
    `SELECT id, company_name FROM vendors WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const vendor = vRes.rows[0];

  const paymentDate = input.paymentDate ? assertIsoDate(input.paymentDate, 'paymentDate') : todayIsoDate();
  const bankAccountId = input.bankAccountId ? Number(input.bankAccountId) : ctx.bank1010;
  const fx = await resolveExchangeRate6(
    tx,
    companyId,
    input.currencyCode,
    ctx.baseCurrency,
    paymentDate,
    input.exchangeRate
  );

  if (!Array.isArray(input.allocations) || input.allocations.length === 0) {
    throw new AccountingError(400, 'At least one bill allocation is required');
  }

  let cashPaidBase4 = 0n;
  let cashPaidForeign4 = 0n;
  let apRelievedBase4 = 0n;
  const allocRows: Array<{
    billId: number;
    billNumber: string;
    appliedForeign4: bigint;
    appliedBaseAtPay4: bigint;
    apRelievedBase4: bigint;
    prevTotal4: bigint;
    prevPaid4: bigint;
    billCurrency: string;
    billForeignBal4: bigint;
  }> = [];

  for (const alloc of input.allocations) {
    const billId = Number(alloc.billId);
    const bRes = await tx.query<{
      id: number;
      bill_number: string;
      vendor_id: number;
      status: string;
      total: string;
      amount_paid: string;
      balance_due: string;
      currency_code: string;
      exchange_rate: string;
      foreign_balance_due: string;
    }>(
      `SELECT id, bill_number, vendor_id, status, total::text, amount_paid::text, balance_due::text,
              currency_code, exchange_rate::text, foreign_balance_due::text
         FROM bills WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, billId]
    );
    if (bRes.rows.length === 0) throw new AccountingError(404, `Bill ${billId} not found`);
    const bill = bRes.rows[0];
    if (Number(bill.vendor_id) !== vendorId) {
      throw new AccountingError(400, `Bill ${bill.bill_number} belongs to a different vendor`);
    }
    if (bill.status === 'voided') {
      throw new AccountingError(409, `Cannot pay voided bill ${bill.bill_number}`);
    }

    const appliedInput4 = parseDecimal4(alloc.amount);
    if (appliedInput4 <= 0n) throw new AccountingError(400, 'Allocation amount must be positive');

    const billOrigRate6 = parseDecimal6(bill.exchange_rate || '1');
    let billRelieved4 = appliedInput4;
    let cashPayForBillBase4 = appliedInput4;

    if (fx.currencyCode !== ctx.baseCurrency && bill.currency_code === fx.currencyCode) {
      if (appliedInput4 > parseDecimal4(bill.foreign_balance_due)) {
        throw new AccountingError(
          400,
          `Payment ${formatDecimal4(appliedInput4)} ${fx.currencyCode} exceeds bill ${bill.bill_number} balance`
        );
      }
      billRelieved4 = convertForeign4ToBase4(appliedInput4, billOrigRate6, ctx.roundingMode);
      cashPayForBillBase4 = convertForeign4ToBase4(appliedInput4, fx.rate6, ctx.roundingMode);
    } else {
      if (appliedInput4 > parseDecimal4(bill.balance_due)) {
        throw new AccountingError(
          400,
          `Allocation ${formatDecimal2Safe(appliedInput4)} exceeds balance due on ${bill.bill_number}`
        );
      }
    }

    cashPaidForeign4 += appliedInput4;
    cashPaidBase4 += cashPayForBillBase4;
    apRelievedBase4 += billRelieved4;
    allocRows.push({
      billId,
      billNumber: bill.bill_number,
      appliedForeign4: appliedInput4,
      appliedBaseAtPay4: cashPayForBillBase4,
      apRelievedBase4: billRelieved4,
      prevTotal4: parseDecimal4(bill.total),
      prevPaid4: parseDecimal4(bill.amount_paid),
      billCurrency: bill.currency_code,
      billForeignBal4: parseDecimal4(bill.foreign_balance_due),
    });
  }

  const paymentNumber = await generateNextDocNumber(tx, companyId, 'bill_payments', 'payment_number', 'BP');

  // Auto-assign check number from bank_accounts if requested
  const baRes = await tx.query<{ id: number; next_check_number: number }>(
    `SELECT id, next_check_number FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 FOR UPDATE`,
    [companyId, bankAccountId]
  );
  let checkNumber = input.checkNumber?.trim() || null;
  if (!checkNumber && input.printLater && baRes.rows.length > 0) {
    checkNumber = String(baRes.rows[0].next_check_number);
    await tx.query(
      `UPDATE bank_accounts SET next_check_number = next_check_number + 1 WHERE company_id = $1 AND id = $2`,
      [companyId, baRes.rows[0].id]
    );
  }

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO bill_payments (
       company_id, payment_number, vendor_id, payment_date, amount, bank_account_id,
       check_number, currency_code, exchange_rate, foreign_amount, memo
     ) VALUES ($1, $2, $3, $4::DATE, $5::NUMERIC(19,4), $6, $7, $8, $9::NUMERIC(19,6), $10::NUMERIC(19,4), $11)
     RETURNING id`,
    [
      companyId,
      paymentNumber,
      vendorId,
      paymentDate,
      formatDecimal4(cashPaidBase4),
      bankAccountId,
      checkNumber,
      fx.currencyCode,
      fx.rateStr,
      formatDecimal4(cashPaidForeign4),
      input.memo?.trim() || null,
    ]
  );
  const bpId = Number(ins.rows[0].id);

  for (const a of allocRows) {
    await tx.query(
      `INSERT INTO bill_payment_allocations (company_id, bill_payment_id, bill_id, amount)
       VALUES ($1, $2, $3, $4::NUMERIC(19,4))`,
      [companyId, bpId, a.billId, formatDecimal4(a.apRelievedBase4)]
    );

    const nextPaid4 = a.prevPaid4 + a.apRelievedBase4;
    const nextBal4 = a.prevTotal4 - nextPaid4;
    const nextForeignBal4 =
      a.billCurrency === fx.currencyCode && fx.currencyCode !== ctx.baseCurrency
        ? a.billForeignBal4 - a.appliedForeign4
        : nextBal4;
    await tx.query(
      `UPDATE bills
          SET amount_paid = $3::NUMERIC(19,4),
              balance_due = $4::NUMERIC(19,4),
              foreign_balance_due = $5::NUMERIC(19,4),
              status = $6
        WHERE company_id = $1 AND id = $2`,
      [
        companyId,
        a.billId,
        formatDecimal4(nextPaid4),
        formatDecimal4(nextBal4),
        formatDecimal4(nextForeignBal4 < 0n ? 0n : nextForeignBal4),
        nextBal4 === 0n ? 'paid' : 'partial',
      ]
    );
  }

  // GL Journal: Dr AP 2000 (apRelievedBase4) | Cr Bank (cashPaidBase4) + realized FX Gain/Loss
  const jeLines: JournalLineInput[] = [
    {
      accountId: ctx.ap2000,
      debit: formatDecimal4(apRelievedBase4),
      credit: '0.0000',
      description: `AP Settlement — ${paymentNumber}`,
      partyType: 'vendor',
      partyId: vendorId,
    },
    {
      accountId: bankAccountId,
      debit: '0.0000',
      credit: formatDecimal4(cashPaidBase4),
      description: `Cash Disbursed — ${paymentNumber}`,
      partyType: 'vendor',
      partyId: vendorId,
    },
  ];
  const fxDiff4 = apRelievedBase4 - cashPaidBase4;
  // On AP: if we relieved MORE base liability than cash paid (fxDiff4 > 0), we gained -> Cr FX Gain 4900
  if (fxDiff4 > 0n) {
    jeLines.push({
      accountId: ctx.fxGain4900,
      debit: '0.0000',
      credit: formatDecimal4(fxDiff4),
      description: `Realized FX Gain on AP Settlement — ${paymentNumber}`,
    });
  } else if (fxDiff4 < 0n) {
    jeLines.push({
      accountId: ctx.fxLoss6900,
      debit: formatDecimal4(-fxDiff4),
      credit: '0.0000',
      description: `Realized FX Loss on AP Settlement — ${paymentNumber}`,
    });
  }

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate: paymentDate,
    description: `Bill Payment ${paymentNumber} — ${vendor.company_name}`,
    reference: checkNumber || paymentNumber,
    sourceType: 'bill_payment',
    sourceId: bpId,
    idempotencyKey: `bp-je-${companyId}-${bpId}`,
    lines: jeLines,
  });

  await tx.query(`UPDATE bill_payments SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    bpId,
    postedJe.transaction.id,
  ]);

  // Bank register withdrawal entry (negative amount)
  const btRes = await tx.query<{ id: number }>(
    `INSERT INTO bank_transactions (
       company_id, account_id, bank_account_id, txn_date, payee, txn_type,
       ref_number, memo, amount, is_cleared, status, offset_account_id, journal_txn_id, vendor_id, category
     ) VALUES (
       $1, $2, $3, $4::DATE, $5, 'Bill Payment',
       $6, $7, $8::NUMERIC(19,4), FALSE, 'posted', $9, $10, $11, 'Accounts Payable'
     ) RETURNING id`,
    [
      companyId,
      bankAccountId,
      baRes.rows[0] ? Number(baRes.rows[0].id) : null,
      paymentDate,
      vendor.company_name,
      checkNumber || paymentNumber,
      input.memo?.trim() || `Bill Payment ${paymentNumber}`,
      formatDecimal4(-cashPaidBase4),
      ctx.ap2000,
      postedJe.transaction.id,
      vendorId,
    ]
  );

  if (checkNumber || input.printLater) {
    await tx.query(
      `INSERT INTO bank_check_details (company_id, bank_txn_id, check_number, print_later)
       VALUES ($1, $2, $3, $4)`,
      [companyId, Number(btRes.rows[0].id), checkNumber, Boolean(input.printLater)]
    );
  }

  await recalculateVendorBalance(tx, companyId, vendorId);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BILL_PAYMENT_POSTED',
    tableName: 'bill_payments',
    recordId: bpId,
    newValues: {
      paymentNumber,
      vendorId,
      amount: formatDecimal4(cashPaidBase4),
      fxDiff: formatDecimal4(fxDiff4),
      journalTxnId: postedJe.transaction.id,
    },
  });

  const all = await listBillPayments(tx, companyId, vendorId);
  const created = all.find(p => p.id === bpId)!;
  await saveRouteIdempotency(
    tx,
    companyId,
    'bill_payment_create',
    input.idempotencyKey,
    idem.payloadHash,
    201,
    { billPayment: created },
    actor.userId
  );

  return { billPayment: created, idempotentReplay: false };
}

export async function voidBillPayment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  billPaymentId: number,
  reason?: string
) {
  const bpRes = await tx.query<{
    id: number;
    payment_number: string;
    vendor_id: number;
    is_voided: boolean;
    journal_txn_id: number | null;
  }>(
    `SELECT id, payment_number, vendor_id, is_voided, journal_txn_id
       FROM bill_payments WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, billPaymentId]
  );
  if (bpRes.rows.length === 0) throw new AccountingError(404, 'Bill payment not found');
  const bp = bpRes.rows[0];
  if (bp.is_voided) throw new AccountingError(409, `Bill payment ${bp.payment_number} is already voided`);

  let reversalJournalId: number | null = null;
  if (bp.journal_txn_id) {
    const rev = await reverseJournalEntry(tx, companyId, actor, Number(bp.journal_txn_id), {
      reason: reason || `Void bill payment ${bp.payment_number}`,
    });
    reversalJournalId = rev.reversal.id;
    await tx.query(
      `UPDATE bank_transactions SET status = 'voided' WHERE company_id = $1 AND journal_txn_id = $2`,
      [companyId, bp.journal_txn_id]
    );
  }

  const allocs = await tx.query<{ bill_id: number; amount: string }>(
    `SELECT bill_id, amount::text FROM bill_payment_allocations WHERE company_id = $1 AND bill_payment_id = $2`,
    [companyId, billPaymentId]
  );
  for (const a of allocs.rows) {
    const bRes = await tx.query<{ total: string; amount_paid: string }>(
      `SELECT total::text, amount_paid::text FROM bills WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, Number(a.bill_id)]
    );
    if (bRes.rows.length > 0) {
      const total4 = parseDecimal4(bRes.rows[0].total);
      const curPaid4 = parseDecimal4(bRes.rows[0].amount_paid);
      const alloc4 = parseDecimal4(a.amount);
      const nextPaid4 = curPaid4 >= alloc4 ? curPaid4 - alloc4 : 0n;
      const nextBal4 = total4 - nextPaid4;
      await tx.query(
        `UPDATE bills
            SET amount_paid = $3::NUMERIC(19,4),
                balance_due = $4::NUMERIC(19,4),
                status = $5
          WHERE company_id = $1 AND id = $2`,
        [companyId, Number(a.bill_id), formatDecimal4(nextPaid4), formatDecimal4(nextBal4), nextPaid4 === 0n ? 'open' : 'partial']
      );
    }
  }

  await tx.query(`UPDATE bill_payments SET is_voided = TRUE WHERE company_id = $1 AND id = $2`, [
    companyId,
    billPaymentId,
  ]);
  await recalculateVendorBalance(tx, companyId, Number(bp.vendor_id));

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BILL_PAYMENT_VOIDED',
    tableName: 'bill_payments',
    recordId: billPaymentId,
    newValues: { isVoided: true, reason: reason || null, reversalJournalId },
  });

  const all = await listBillPayments(tx, companyId, Number(bp.vendor_id));
  return { billPayment: all.find(x => x.id === billPaymentId)!, reversalJournalId };
}

// ============================================================================
// VENDOR CREDITS & APPLICATIONS
// ============================================================================

export async function listVendorCredits(tx: Transaction, companyId: number, vendorId?: number) {
  const res = await tx.query<any>(
    `SELECT vc.id, vc.credit_number, vc.vendor_id, v.company_name AS vendor_name,
            vc.credit_date::text, vc.status, vc.total::text, vc.remaining_credit::text,
            vc.journal_txn_id, vc.memo
       FROM vendor_credits vc
       JOIN vendors v ON v.company_id = vc.company_id AND v.id = vc.vendor_id
      WHERE vc.company_id = $1 ${vendorId ? 'AND vc.vendor_id = $2' : ''}
      ORDER BY vc.credit_date DESC, vc.id DESC`,
    vendorId ? [companyId, vendorId] : [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    creditNumber: r.credit_number,
    vendorId: Number(r.vendor_id),
    vendorName: r.vendor_name,
    creditDate: r.credit_date,
    status: r.status,
    total: toMoneyNumber(parseDecimal4(r.total)),
    remainingCredit: toMoneyNumber(parseDecimal4(r.remaining_credit)),
    journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
    memo: r.memo || '',
  }));
}

export async function createVendorCredit(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    vendorId: number;
    creditDate?: string;
    memo?: string | null;
    lines: Array<{ accountId?: number | null; description: string; quantity?: string | number; rate: string | number }>;
  }
) {
  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const vendorId = Number(input.vendorId);
  const vRes = await tx.query<{ id: number; company_name: string; default_expense_account_id: number | null }>(
    `SELECT id, company_name, default_expense_account_id FROM vendors WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const vendor = vRes.rows[0];

  const creditDate = input.creditDate ? assertIsoDate(input.creditDate, 'creditDate') : todayIsoDate();
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'At least one vendor credit line is required');
  }

  let total4 = 0n;
  const creditByAcct = new Map<number, bigint>();
  const lineRows: any[] = [];
  for (const raw of input.lines) {
    const qty6 = parseDecimal6(raw.quantity ?? 1);
    const rate4 = parseDecimal4(raw.rate);
    const amt4 = multiplyQty6ByRate4(qty6, rate4, ctx.roundingMode);
    if (amt4 <= 0n) throw new AccountingError(400, 'Vendor credit line amount must be positive');
    total4 += amt4;
    const acctId = raw.accountId ? Number(raw.accountId) : vendor.default_expense_account_id || ctx.cogs5000;
    creditByAcct.set(acctId, (creditByAcct.get(acctId) ?? 0n) + amt4);
    lineRows.push({
      accountId: acctId,
      description: String(raw.description || '').trim() || 'Vendor credit',
      qty6,
      rate4,
      amt4,
    });
  }

  const creditNumber = await generateNextDocNumber(tx, companyId, 'vendor_credits', 'credit_number', 'VC');
  const ins = await tx.query<{ id: number }>(
    `INSERT INTO vendor_credits (
       company_id, credit_number, vendor_id, credit_date, status, total, remaining_credit, memo
     ) VALUES ($1, $2, $3, $4::DATE, 'open', $5::NUMERIC(19,4), $5::NUMERIC(19,4), $6)
     RETURNING id`,
    [companyId, creditNumber, vendorId, creditDate, formatDecimal4(total4), input.memo?.trim() || null]
  );
  const vcId = Number(ins.rows[0].id);

  for (const l of lineRows) {
    await tx.query(
      `INSERT INTO vendor_credit_lines (company_id, vendor_credit_id, account_id, description, quantity, rate, amount)
       VALUES ($1, $2, $3, $4, $5::NUMERIC(19,6), $6::NUMERIC(19,4), $7::NUMERIC(19,4))`,
      [companyId, vcId, l.accountId, l.description, formatDecimal6(l.qty6), formatDecimal4(l.rate4), formatDecimal4(l.amt4)]
    );
  }

  const jeLines: JournalLineInput[] = [
    {
      accountId: ctx.ap2000,
      debit: formatDecimal4(total4),
      credit: '0.0000',
      description: `AP Vendor Credit — ${creditNumber}`,
      partyType: 'vendor',
      partyId: vendorId,
    },
  ];
  for (const [acctId, amt4] of creditByAcct.entries()) {
    jeLines.push({
      accountId: acctId,
      debit: '0.0000',
      credit: formatDecimal4(amt4),
      description: `Expense/Asset Credit — ${creditNumber}`,
      partyType: 'vendor',
      partyId: vendorId,
    });
  }

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate: creditDate,
    description: `Vendor Credit ${creditNumber} — ${vendor.company_name}`,
    reference: creditNumber,
    sourceType: 'vendor_credit',
    sourceId: vcId,
    idempotencyKey: `vc-je-${companyId}-${vcId}`,
    lines: jeLines,
  });

  await tx.query(`UPDATE vendor_credits SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    vcId,
    postedJe.transaction.id,
  ]);
  await recalculateVendorBalance(tx, companyId, vendorId);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'VENDOR_CREDIT_POSTED',
    tableName: 'vendor_credits',
    recordId: vcId,
    newValues: { creditNumber, vendorId, total: formatDecimal4(total4), journalTxnId: postedJe.transaction.id },
  });

  const all = await listVendorCredits(tx, companyId, vendorId);
  return all.find(v => v.id === vcId)!;
}

export async function applyVendorCreditToBill(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  vendorCreditId: number,
  input: { billId: number; amount: string | number; appliedDate?: string }
) {
  const vcRes = await tx.query<{
    id: number;
    credit_number: string;
    vendor_id: number;
    status: string;
    remaining_credit: string;
  }>(
    `SELECT id, credit_number, vendor_id, status, remaining_credit::text
       FROM vendor_credits WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, vendorCreditId]
  );
  if (vcRes.rows.length === 0) throw new AccountingError(404, 'Vendor credit not found');
  const vc = vcRes.rows[0];
  if (vc.status === 'voided') throw new AccountingError(409, 'Cannot apply voided vendor credit');

  const billRes = await tx.query<{
    id: number;
    bill_number: string;
    vendor_id: number;
    status: string;
    total: string;
    amount_paid: string;
    balance_due: string;
  }>(
    `SELECT id, bill_number, vendor_id, status, total::text, amount_paid::text, balance_due::text
       FROM bills WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, Number(input.billId)]
  );
  if (billRes.rows.length === 0) throw new AccountingError(404, 'Bill not found');
  const bill = billRes.rows[0];
  if (Number(bill.vendor_id) !== Number(vc.vendor_id)) {
    throw new AccountingError(400, 'Vendor credit and bill must belong to the same vendor');
  }
  if (bill.status === 'voided') throw new AccountingError(409, 'Cannot apply credit to voided bill');

  const apply4 = parseDecimal4(input.amount);
  const rem4 = parseDecimal4(vc.remaining_credit);
  const bal4 = parseDecimal4(bill.balance_due);
  if (apply4 <= 0n || apply4 > rem4 || apply4 > bal4) {
    throw new AccountingError(400, 'Application amount exceeds available vendor credit or bill balance due');
  }

  const appliedDate = input.appliedDate ? assertIsoDate(input.appliedDate, 'appliedDate') : todayIsoDate();
  await tx.query(
    `INSERT INTO vendor_credit_applications (company_id, vendor_credit_id, bill_id, amount, applied_date)
     VALUES ($1, $2, $3, $4::NUMERIC(19,4), $5::DATE)`,
    [companyId, vendorCreditId, bill.id, formatDecimal4(apply4), appliedDate]
  );

  const nextRem4 = rem4 - apply4;
  await tx.query(
    `UPDATE vendor_credits SET remaining_credit = $3::NUMERIC(19,4), status = $4 WHERE company_id = $1 AND id = $2`,
    [companyId, vendorCreditId, formatDecimal4(nextRem4), nextRem4 === 0n ? 'applied' : 'open']
  );

  const nextPaid4 = parseDecimal4(bill.amount_paid) + apply4;
  const nextBal4 = parseDecimal4(bill.total) - nextPaid4;
  await tx.query(
    `UPDATE bills
        SET amount_paid = $3::NUMERIC(19,4),
            balance_due = $4::NUMERIC(19,4),
            status = $5
      WHERE company_id = $1 AND id = $2`,
    [companyId, bill.id, formatDecimal4(nextPaid4), formatDecimal4(nextBal4), nextBal4 === 0n ? 'paid' : 'partial']
  );

  await recalculateVendorBalance(tx, companyId, Number(vc.vendor_id));

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'VENDOR_CREDIT_APPLIED',
    tableName: 'vendor_credit_applications',
    recordId: vendorCreditId,
    newValues: { billId: bill.id, billNumber: bill.bill_number, amount: formatDecimal4(apply4) },
  });

  const all = await listVendorCredits(tx, companyId, Number(vc.vendor_id));
  return all.find(v => v.id === vendorCreditId)!;
}

// ============================================================================
// AP AGING & SUPPLIER STATEMENTS
// ============================================================================

export async function getApAgingReport(tx: Transaction, companyId: number, asOfDate?: string) {
  const asOf = asOfDate ? assertIsoDate(asOfDate, 'asOfDate') : todayIsoDate();
  const res = await tx.query<{
    bill_id: number;
    bill_number: string;
    vendor_id: number;
    vendor_name: string;
    bill_date: string;
    due_date: string;
    balance_due: string;
    days_past_due: number;
  }>(
    `SELECT b.id AS bill_id, b.bill_number, b.vendor_id, v.company_name AS vendor_name,
            b.bill_date::text, b.due_date::text, b.balance_due::text,
            ($2::DATE - b.due_date)::INTEGER AS days_past_due
       FROM bills b
       JOIN vendors v ON v.company_id = b.company_id AND v.id = b.vendor_id
      WHERE b.company_id = $1 AND b.status <> 'voided' AND b.balance_due > 0
      ORDER BY v.company_name ASC, b.due_date ASC`,
    [companyId, asOf]
  );

  const byVendor = new Map<number, any>();
  let grandCurrent = 0n;
  let grand1_30 = 0n;
  let grand31_60 = 0n;
  let grand61_90 = 0n;
  let grand90plus = 0n;

  for (const r of res.rows) {
    const vid = Number(r.vendor_id);
    const bal4 = parseDecimal4(r.balance_due);
    const days = Number(r.days_past_due);
    const entry = byVendor.get(vid) ?? {
      vendorId: vid,
      vendorName: r.vendor_name,
      current4: 0n,
      d1_30_4: 0n,
      d31_60_4: 0n,
      d61_90_4: 0n,
      d90plus4: 0n,
      total4: 0n,
      bills: [],
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
    entry.bills.push({
      billId: Number(r.bill_id),
      billNumber: r.bill_number,
      billDate: r.bill_date,
      dueDate: r.due_date,
      daysPastDue: Math.max(0, days),
      balanceDue: toMoneyNumber(bal4),
    });
    byVendor.set(vid, entry);
  }

  const totalAp4 = grandCurrent + grand1_30 + grand31_60 + grand61_90 + grand90plus;
  return {
    asOfDate: asOf,
    vendors: Array.from(byVendor.values()).map(v => ({
      vendorId: v.vendorId,
      vendorName: v.vendorName,
      current: toMoneyNumber(v.current4),
      days1To30: toMoneyNumber(v.d1_30_4),
      days31To60: toMoneyNumber(v.d31_60_4),
      days61To90: toMoneyNumber(v.d61_90_4),
      daysOver90: toMoneyNumber(v.d90plus4),
      total: toMoneyNumber(v.total4),
      bills: v.bills,
    })),
    totals: {
      current: toMoneyNumber(grandCurrent),
      days1To30: toMoneyNumber(grand1_30),
      days31To60: toMoneyNumber(grand31_60),
      days61To90: toMoneyNumber(grand61_90),
      daysOver90: toMoneyNumber(grand90plus),
      total: toMoneyNumber(totalAp4),
    },
  };
}

export async function generateSupplierStatement(
  tx: Transaction,
  companyId: number,
  input: { vendorId: number; periodStart?: string; periodEnd?: string }
) {
  const vendorId = Number(input.vendorId);
  const vRes = await tx.query<{ id: number; company_name: string; email: string | null }>(
    `SELECT id, company_name, email FROM vendors WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const vendor = vRes.rows[0];

  const periodEnd = input.periodEnd ? assertIsoDate(input.periodEnd, 'periodEnd') : todayIsoDate();
  const periodStart = input.periodStart ? assertIsoDate(input.periodStart, 'periodStart') : `${periodEnd.slice(0, 7)}-01`;

  const [priorBills, priorPmts, priorVcs, activity] = await Promise.all([
    tx.query<{ s: string }>(
      `SELECT COALESCE(SUM(total), 0)::NUMERIC(19,4)::text AS s FROM bills
        WHERE company_id = $1 AND vendor_id = $2 AND bill_date < $3::DATE`,
      [companyId, vendorId, periodStart]
    ),
    tx.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount), 0)::NUMERIC(19,4)::text AS s FROM bill_payments
        WHERE company_id = $1 AND vendor_id = $2 AND is_voided = FALSE AND payment_date < $3::DATE`,
      [companyId, vendorId, periodStart]
    ),
    tx.query<{ s: string }>(
      `SELECT COALESCE(SUM(total), 0)::NUMERIC(19,4)::text AS s FROM vendor_credits
        WHERE company_id = $1 AND vendor_id = $2 AND credit_date < $3::DATE`,
      [companyId, vendorId, periodStart]
    ),
    tx.query<{ doc_date: string; doc_type: string; doc_number: string; description: string; amount: string }>(
      `SELECT bill_date::text AS doc_date, 'Bill' AS doc_type, bill_number AS doc_number,
              COALESCE(memo, 'Supplier Bill') AS description, total::text AS amount
         FROM bills
        WHERE company_id = $1 AND vendor_id = $2
          AND bill_date BETWEEN $3::DATE AND $4::DATE
       UNION ALL
       SELECT payment_date::text AS doc_date, 'Bill Payment' AS doc_type, payment_number AS doc_number,
              COALESCE(memo, 'Payment') AS description, (-amount)::text AS amount
         FROM bill_payments
        WHERE company_id = $1 AND vendor_id = $2 AND is_voided = FALSE
          AND payment_date BETWEEN $3::DATE AND $4::DATE
       UNION ALL
       SELECT credit_date::text AS doc_date, 'Vendor Credit' AS doc_type, credit_number AS doc_number,
              COALESCE(memo, 'Vendor Credit') AS description, (-total)::text AS amount
         FROM vendor_credits
        WHERE company_id = $1 AND vendor_id = $2
          AND credit_date BETWEEN $3::DATE AND $4::DATE
       ORDER BY doc_date ASC, doc_number ASC`,
      [companyId, vendorId, periodStart, periodEnd]
    ),
  ]);

  const openingBal4 =
    parseDecimal4(priorBills.rows[0].s) -
    parseDecimal4(priorPmts.rows[0].s) -
    parseDecimal4(priorVcs.rows[0].s);

  let running4 = openingBal4;
  const lines = activity.rows.map(r => {
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

  return {
    vendorId,
    vendorName: vendor.company_name,
    vendorEmail: vendor.email || '',
    periodStart,
    periodEnd,
    openingBalance: toMoneyNumber(openingBal4),
    closingBalance: toMoneyNumber(running4),
    lines,
  };
}

function formatDecimal2Safe(val4: bigint): string {
  return formatDecimal4(val4).slice(0, -2);
}
