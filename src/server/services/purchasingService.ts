import crypto from 'node:crypto';
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
  getVendorApExposure,
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
    vendor_code: string | null;
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
    status: string;
    currency_code: string;
    opening_balance_bill_id: number | null;
    notes: string | null;
    vendor_category: string;
    is_preferred: boolean;
    bank_name: string | null;
    bank_account_name: string | null;
    bank_account_number: string | null;
    bank_branch: string | null;
    is_active: boolean;
    created_at: string;
  }>(
    `SELECT id, vendor_code, name, company_name, email, phone, address, ein_or_ssn,
            is_1099_eligible, default_expense_account_id, payment_term_id, terms_label,
            balance::text, status, currency_code, opening_balance_bill_id, notes,
            vendor_category, is_preferred, bank_name, bank_account_name,
            bank_account_number, bank_branch, is_active, created_at::text
       FROM vendors
      WHERE company_id = $1
      ORDER BY company_name ASC, id ASC`,
    [companyId]
  );

  return res.rows.map(r => ({
    id: Number(r.id),
    vendorCode: r.vendor_code || '',
    name: r.name,
    companyName: r.company_name,
    email: r.email || '',
    phone: r.phone || '',
    address: r.address || '',
    taxId: r.ein_or_ssn || '',
    is1099Eligible: Boolean(r.is_1099_eligible),
    defaultExpenseAccountId:
      r.default_expense_account_id !== null ? Number(r.default_expense_account_id) : null,
    paymentTermId: r.payment_term_id !== null ? Number(r.payment_term_id) : null,
    terms: r.terms_label,
    balance: toMoneyNumber(parseDecimal4(r.balance)),
    balanceStr: r.balance,
    status: r.status || (r.is_active ? 'active' : 'inactive'),
    currencyCode: r.currency_code || 'ZMW',
    openingBalanceBillId:
      r.opening_balance_bill_id !== null ? Number(r.opening_balance_bill_id) : null,
    notes: r.notes || '',
    vendorCategory: r.vendor_category || 'goods',
    isPreferred: Boolean(r.is_preferred),
    bankName: r.bank_name || '',
    bankAccountName: r.bank_account_name || '',
    bankAccountNumber: r.bank_account_number || '',
    bankBranch: r.bank_branch || '',
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
    notes?: string | null;
    currencyCode?: string | null;
    openingBalance?: string | number | null;
    openingBalanceDate?: string | null;
    openingBalanceExchangeRate?: string | number | null;
    vendorCategory?: string | null;
    isPreferred?: boolean;
    bankName?: string | null;
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
    bankBranch?: string | null;
  }
) {
  const companyName = String(input.companyName || input.name || '').trim();
  if (!companyName) throw new AccountingError(400, 'Vendor companyName is required');
  const name = String(input.name || companyName).trim();

  const vendorCategory = String(input.vendorCategory || 'goods').trim().toLowerCase();
  if (!['goods', 'services', 'logistics', 'utilities', 'contractor', 'other'].includes(vendorCategory)) {
    throw new AccountingError(400, `Invalid vendorCategory '${vendorCategory}'`, 'INVALID_VENDOR_CATEGORY');
  }

  const duplicate = await tx.query<{ id: number; company_name: string }>(
    `SELECT id, company_name
       FROM vendors
      WHERE company_id = $1
        AND (
          LOWER(name) = LOWER($2)
          OR LOWER(company_name) = LOWER($3)
          OR ($4::VARCHAR IS NOT NULL AND email IS NOT NULL AND LOWER(email) = LOWER($4::VARCHAR))
          OR ($5::VARCHAR IS NOT NULL AND phone IS NOT NULL AND phone = $5::VARCHAR)
        )
      LIMIT 1`,
    [companyId, name, companyName, input.email?.trim() || null, input.phone?.trim() || null]
  );
  if (duplicate.rows.length > 0) {
    throw new AccountingError(
      409,
      `Potential duplicate supplier found: "${duplicate.rows[0].company_name}" (ID: ${duplicate.rows[0].id})`,
      'DUPLICATE_VENDOR'
    );
  }

  const companyCurrencyRes = input.currencyCode
    ? null
    : await tx.query<{ base_currency: string }>(
        `SELECT base_currency FROM companies WHERE id = $1 LIMIT 1`,
        [companyId]
      );
  const currencyCode = String(
    input.currencyCode || companyCurrencyRes?.rows[0]?.base_currency || 'ZMW'
  )
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new AccountingError(400, 'currencyCode must be a 3-letter ISO code', 'INVALID_CURRENCY');
  }

  const openingBalance4 = parseDecimal4(input.openingBalance ?? 0);
  if (openingBalance4 < 0n) {
    throw new AccountingError(400, 'Opening balance cannot be negative', 'INVALID_OPENING_BALANCE');
  }

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
    const ins = await tx.query<{ id: number; vendor_code: string }>(
      `INSERT INTO vendors (
         company_id, name, company_name, email, phone, address, ein_or_ssn,
         is_1099_eligible, default_expense_account_id, payment_term_id, terms_label,
         status, currency_code, notes, vendor_category, is_preferred,
         bank_name, bank_account_name, bank_account_number, bank_branch
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'active', $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING id, vendor_code`,
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
        currencyCode,
        input.notes?.trim() || null,
        vendorCategory,
        Boolean(input.isPreferred),
        input.bankName?.trim() || null,
        input.bankAccountName?.trim() || null,
        input.bankAccountNumber?.trim() || null,
        input.bankBranch?.trim() || null,
      ]
    );
    const id = Number(ins.rows[0].id);
    const vendorCode = ins.rows[0].vendor_code;

    await writeAuditLog(tx, {
      companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'VENDOR_CREATED',
      tableName: 'vendors',
      recordId: id,
      newValues: {
        name,
        companyName,
        termsLabel,
        vendorCode,
        status: 'active',
        vendorCategory,
        currencyCode,
      },
    });

    if (openingBalance4 > 0n) {
      await postVendorOpeningBalance(tx, companyId, actor, {
        vendorId: id,
        vendorCode,
        vendorName: companyName,
        openingBalance: openingBalance4,
        currencyCode,
        openingDate: input.openingBalanceDate
          ? assertIsoDate(input.openingBalanceDate, 'openingBalanceDate')
          : todayIsoDate(),
        exchangeRate: input.openingBalanceExchangeRate,
        terms: termsLabel,
      });
    }

    const all = await listVendors(tx, companyId);
    return all.find(v => v.id === id)!;
  } catch (err: any) {
    if (String(err?.code) === '23505') {
      throw new AccountingError(409, `Vendor "${name}" already exists`);
    }
    throw err;
  }
}

/**
 * Supplier opening balances are traceable AP documents: an opening bill plus
 * Dr Opening Balance Equity 3900 / Cr Accounts Payable 2000. The bill's line is
 * posted to the same equity account so the subledger and GL agree.
 */
async function postVendorOpeningBalance(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    vendorId: number;
    vendorCode: string;
    vendorName: string;
    openingBalance: bigint;
    currencyCode: string;
    openingDate: string;
    exchangeRate?: string | number | null;
    terms: string;
  }
): Promise<void> {
  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const fx = await resolveExchangeRate6(
    tx,
    companyId,
    input.currencyCode,
    ctx.baseCurrency,
    input.openingDate,
    input.exchangeRate
  );
  const base4 = convertForeign4ToBase4(input.openingBalance, fx.rate6, ctx.roundingMode);
  if (base4 <= 0n) {
    throw new AccountingError(400, 'Opening balance is too small to post', 'INVALID_OPENING_BALANCE');
  }

  const netDays = input.terms.toLowerCase().includes('receipt')
    ? 0
    : Number(input.terms.match(/\d+/)?.[0] || 30);
  const dueDate = addDaysToIso(input.openingDate, netDays);

  const baseNumber = `BILL-OPEN-${input.vendorCode}-${input.openingDate.slice(0, 4)}`;
  let billNumber = baseNumber;
  for (let attempt = 0; attempt < 20; attempt++) {
    const exists = await tx.query<{ id: number }>(
      `SELECT id FROM bills WHERE company_id = $1 AND vendor_id = $2 AND bill_number = $3 LIMIT 1`,
      [companyId, input.vendorId, billNumber]
    );
    if (exists.rows.length === 0) break;
    billNumber = `${baseNumber}-${attempt + 2}`;
  }

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO bills (
       company_id, bill_number, vendor_id, bill_date, due_date, terms_label, status,
       total, amount_paid, balance_due, currency_code, exchange_rate,
       foreign_total, foreign_balance_due, memo
     ) VALUES (
       $1, $2, $3, $4::DATE, $5::DATE, $6, 'open',
       $7::NUMERIC(19,4), 0.0000, $7::NUMERIC(19,4),
       $8, $9::NUMERIC(19,6), $10::NUMERIC(19,4), $10::NUMERIC(19,4), $11
     ) RETURNING id`,
    [
      companyId,
      billNumber,
      input.vendorId,
      input.openingDate,
      dueDate,
      input.terms,
      formatDecimal4(base4),
      fx.currencyCode,
      fx.rateStr,
      formatDecimal4(input.openingBalance),
      `Opening balance captured at supplier onboarding (${input.vendorCode})`,
    ]
  );
  const billId = Number(ins.rows[0].id);

  await tx.query(
    `INSERT INTO bill_lines (
       company_id, bill_id, line_order, account_id, description,
       quantity, unit_cost, amount, use_tax_rate
     ) VALUES ($1, $2, 1, $3, 'Opening Balance', 1, $4::NUMERIC(19,6), $4::NUMERIC(19,4), 0)`,
    [
      companyId,
      billId,
      ctx.openingBalanceEquity3900,
      formatDecimal4(input.openingBalance),
    ]
  );

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: input.openingDate,
    description: `Opening AP for ${input.vendorName} (${input.vendorCode})`,
    reference: billNumber,
    sourceType: 'opening_balance',
    sourceId: billId,
    idempotencyKey: `vendor-opening-balance-${input.vendorId}`,
    lines: [
      {
        accountId: ctx.openingBalanceEquity3900,
        debit: formatDecimal4(base4),
        credit: '0.0000',
        description: `Opening balance equity — ${input.vendorCode}`,
      },
      {
        accountId: ctx.ap2000,
        debit: '0.0000',
        credit: formatDecimal4(base4),
        description: `Opening AP — ${input.vendorName}`,
        partyType: 'vendor',
        partyId: input.vendorId,
      },
    ],
  });

  await tx.query(`UPDATE bills SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    billId,
    posted.transaction.id,
  ]);
  await tx.query(
    `UPDATE vendors SET opening_balance_bill_id = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, input.vendorId, billId]
  );
  await recalculateVendorBalance(tx, companyId, input.vendorId);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'VENDOR_OPENING_BALANCE_POSTED',
    tableName: 'bills',
    recordId: billId,
    newValues: {
      vendorId: input.vendorId,
      billNumber,
      openingBalance: formatDecimal4(input.openingBalance),
      baseAmount: formatDecimal4(base4),
      currencyCode: fx.currencyCode,
      exchangeRate: fx.rateStr,
      journalTxnId: posted.transaction.id,
    },
  });
}

export async function addVendorOpeningBalance(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  vendorId: number,
  input: {
    openingBalance: string | number;
    openingBalanceDate?: string;
    exchangeRate?: string | number | null;
    terms?: string | null;
  }
) {
  const vRes = await tx.query<{
    id: number;
    vendor_code: string;
    company_name: string;
    terms_label: string;
    currency_code: string;
    opening_balance_bill_id: number | null;
  }>(
    `SELECT v.id, v.vendor_code, v.company_name,
            COALESCE(pt.name, v.terms_label, 'Net 30') AS terms_label,
            v.currency_code, v.opening_balance_bill_id
       FROM vendors v
       LEFT JOIN payment_terms pt
         ON pt.company_id = v.company_id AND pt.id = v.payment_term_id
      WHERE v.company_id = $1 AND v.id = $2
      FOR UPDATE OF v`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const vendor = vRes.rows[0];
  if (vendor.opening_balance_bill_id) {
    throw new AccountingError(409, 'Supplier opening balance has already been posted', 'OPENING_BALANCE_EXISTS');
  }
  const openingBalance4 = parseDecimal4(input.openingBalance ?? 0);
  if (openingBalance4 <= 0n) {
    throw new AccountingError(400, 'Opening balance must be greater than zero', 'INVALID_OPENING_BALANCE');
  }

  await postVendorOpeningBalance(tx, companyId, actor, {
    vendorId,
    vendorCode: vendor.vendor_code,
    vendorName: vendor.company_name,
    openingBalance: openingBalance4,
    currencyCode: vendor.currency_code,
    openingDate: input.openingBalanceDate
      ? assertIsoDate(input.openingBalanceDate, 'openingBalanceDate')
      : todayIsoDate(),
    exchangeRate: input.exchangeRate,
    terms: input.terms?.trim() || vendor.terms_label,
  });

  return getVendorApProfile(tx, companyId, vendorId);
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
    paymentTermId?: number | null;
    terms?: string | null;
    isActive?: boolean;
    status?: string | null;
    currencyCode?: string | null;
    notes?: string | null;
    vendorCategory?: string | null;
    isPreferred?: boolean;
    bankName?: string | null;
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
    bankBranch?: string | null;
  }
) {
  const existing = await tx.query<any>(
    `SELECT * FROM vendors WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, vendorId]
  );
  if (existing.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const prev = existing.rows[0];

  const status = input.status
    ? String(input.status).trim().toLowerCase()
    : input.isActive === undefined
      ? null
      : input.isActive
        ? 'active'
        : 'inactive';
  if (status && !['active', 'inactive', 'on_hold', 'blocked'].includes(status)) {
    throw new AccountingError(400, `Invalid vendor status '${status}'`, 'INVALID_VENDOR_STATUS');
  }

  let currencyCode: string | null = null;
  if (input.currencyCode) {
    currencyCode = input.currencyCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      throw new AccountingError(400, 'currencyCode must be a 3-letter ISO code', 'INVALID_CURRENCY');
    }
    if (currencyCode !== prev.currency_code) {
      const used = await tx.query<{ id: number }>(
        `SELECT id FROM bills WHERE company_id = $1 AND vendor_id = $2
         UNION ALL SELECT id FROM bill_payments WHERE company_id = $1 AND vendor_id = $2
         UNION ALL SELECT id FROM vendor_credits WHERE company_id = $1 AND vendor_id = $2
         LIMIT 1`,
        [companyId, vendorId]
      );
      if (used.rows.length > 0) {
        throw new AccountingError(
          409,
          'Supplier currency cannot change after AP transactions exist',
          'VENDOR_CURRENCY_IN_USE'
        );
      }
    }
  }

  const vendorCategory = input.vendorCategory
    ? String(input.vendorCategory).trim().toLowerCase()
    : null;
  if (
    vendorCategory &&
    !['goods', 'services', 'logistics', 'utilities', 'contractor', 'other'].includes(vendorCategory)
  ) {
    throw new AccountingError(400, `Invalid vendorCategory '${vendorCategory}'`, 'INVALID_VENDOR_CATEGORY');
  }

  let termsLabel = input.terms?.trim() || null;
  let termId: number | null = null;
  if (input.paymentTermId !== undefined && input.paymentTermId !== null) {
    termId = Number(input.paymentTermId);
    const tRes = await tx.query<{ name: string }>(
      `SELECT name FROM payment_terms WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, termId]
    );
    if (tRes.rows.length === 0) throw new AccountingError(404, 'Payment term not found');
    termsLabel = tRes.rows[0].name;
  }

  const bankChanged =
    input.bankName !== undefined ||
    input.bankAccountName !== undefined ||
    input.bankAccountNumber !== undefined ||
    input.bankBranch !== undefined;

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
            payment_term_id = COALESCE($12, payment_term_id),
            status = COALESCE($13, status),
            is_active = CASE WHEN $13::TEXT IS NULL THEN is_active ELSE $13 = 'active' END,
            currency_code = COALESCE($14, currency_code),
            notes = COALESCE($15, notes),
            vendor_category = COALESCE($16, vendor_category),
            is_preferred = COALESCE($17, is_preferred),
            bank_name = COALESCE($18, bank_name),
            bank_account_name = COALESCE($19, bank_account_name),
            bank_account_number = COALESCE($20, bank_account_number),
            bank_branch = COALESCE($21, bank_branch)
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
      termsLabel,
      termId,
      status,
      currencyCode,
      input.notes === undefined ? null : input.notes?.trim() || null,
      vendorCategory,
      input.isPreferred === undefined ? null : Boolean(input.isPreferred),
      input.bankName === undefined ? null : input.bankName?.trim() || null,
      input.bankAccountName === undefined ? null : input.bankAccountName?.trim() || null,
      input.bankAccountNumber === undefined ? null : input.bankAccountNumber?.trim() || null,
      input.bankBranch === undefined ? null : input.bankBranch?.trim() || null,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: bankChanged ? 'VENDOR_BANK_DETAILS_CHANGED' : 'VENDOR_UPDATED',
    tableName: 'vendors',
    recordId: vendorId,
    oldValues: {
      companyName: prev.company_name,
      terms: prev.terms_label,
      status: prev.status,
      currencyCode: prev.currency_code,
      bankAccountNumber: prev.bank_account_number,
    },
    newValues: {
      companyName: input.companyName ?? prev.company_name,
      terms: termsLabel ?? prev.terms_label,
      status: status ?? prev.status,
      currencyCode: currencyCode ?? prev.currency_code,
      bankAccountNumber: input.bankAccountNumber ?? prev.bank_account_number,
    },
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
  const vRes = await tx.query<{
    id: number;
    default_expense_account_id: number | null;
    status: string;
    company_name: string;
  }>(
    `SELECT id, default_expense_account_id, status, company_name
       FROM vendors WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  if (['inactive', 'blocked'].includes(vRes.rows[0].status)) {
    throw new AccountingError(
      409,
      `Supplier ${vRes.rows[0].company_name} is ${vRes.rows[0].status.replace('_', ' ')} and cannot receive purchase orders`,
      'VENDOR_NOT_ORDERABLE'
    );
  }
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
    `SELECT po.id, po.po_number, po.vendor_id, po.status, v.status AS vendor_status,
            v.company_name AS vendor_name
       FROM purchase_orders po
       JOIN vendors v ON v.company_id = po.company_id AND v.id = po.vendor_id
      WHERE po.company_id = $1 AND po.id = $2
      FOR UPDATE OF po`,
    [companyId, poId]
  );
  if (poRes.rows.length === 0) throw new AccountingError(404, 'Purchase order not found');
  const po = poRes.rows[0] as typeof poRes.rows[0] & { vendor_status: string; vendor_name: string };
  if (['inactive', 'blocked'].includes(po.vendor_status)) {
    throw new AccountingError(
      409,
      `Supplier ${po.vendor_name} is ${po.vendor_status.replace('_', ' ')} and cannot be billed`,
      'VENDOR_NOT_BILLABLE'
    );
  }
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
            COALESCE(b.payment_hold, FALSE) AS payment_hold,
            COALESCE(b.match_status, 'unmatched') AS match_status,
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
    paymentHold: Boolean(r.payment_hold),
    matchStatus: r.match_status || 'unmatched',
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
    status: string;
    currency_code: string;
  }>(
    `SELECT id, company_name, default_expense_account_id, terms_label, status, currency_code
       FROM vendors WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const vendor = vRes.rows[0];
  if (['inactive', 'blocked'].includes(vendor.status)) {
    throw new AccountingError(
      409,
      `Supplier ${vendor.company_name} is ${vendor.status.replace('_', ' ')} and cannot be billed`,
      'VENDOR_NOT_BILLABLE'
    );
  }

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
    input.currencyCode || vendor.currency_code,
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
    const rawCost = raw.unitCost ?? (raw as any).amount;
      const unitCost6 = parseDecimal6(rawCost);
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
    // Accrue use tax to a dedicated clearing account (1300), not the arbitrary
    // first expense line. The clearing balance is reclassified to inventory /
    // expense (or remitted) rather than distorting a random expense account.
    jeLines.push({
      accountId: ctx.useTax1300,
      debit: formatDecimal4(baseUseTax4),
      credit: '0.0000',
      description: `Use Tax Clearing — Bill ${billNumber}`,
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
      idempotencyKey: `void-bill-${bill.journal_txn_id}`,
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
            bp.is_voided, bp.journal_txn_id, bp.memo,
            COALESCE(bp.withholding_tax_amount, 0)::text AS withholding_tax_amount
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
    withholding_tax_amount: r.withholding_tax_amount ? toMoneyNumber(parseDecimal4(r.withholding_tax_amount)) : 0,
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
    withholding_tax_amount?: string | number | null;
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
  const vRes = await tx.query<{ id: number; company_name: string; status: string }>(
    `SELECT id, company_name, status FROM vendors WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const vendor = vRes.rows[0];
  if (vendor.status !== 'active') {
    const reason =
      vendor.status === 'on_hold'
        ? 'is on payment hold'
        : `is ${vendor.status.replace('_', ' ')}`;
    throw new AccountingError(
      409,
      `Supplier ${vendor.company_name} ${reason}; release the vendor before paying`,
      'VENDOR_PAYMENT_BLOCKED'
    );
  }

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
      payment_hold: boolean;
    }>(
      `SELECT id, bill_number, vendor_id, status, total::text, amount_paid::text, balance_due::text,
              currency_code, exchange_rate::text, foreign_balance_due::text,
              COALESCE(payment_hold, FALSE) AS payment_hold
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
    if (bill.payment_hold) {
      throw new AccountingError(409, `Bill ${bill.bill_number} is on payment hold`, 'BILL_PAYMENT_HOLD');
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
       check_number, currency_code, exchange_rate, foreign_amount, memo,
       withholding_tax_amount
     ) VALUES ($1, $2, $3, $4::DATE, $5::NUMERIC(19,4), $6, $7, $8, $9::NUMERIC(19,6), $10::NUMERIC(19,4), $11, $12::NUMERIC(19,4))
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
      formatDecimal4(parseDecimal4(input.withholding_tax_amount ?? 0)),
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
      idempotencyKey: `void-bp-${bp.journal_txn_id}`,
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

  // Route-level idempotency: a retried submission (double-click / network replay)
  // with an identical vendor, date, memo and lines must not create a duplicate credit.
  const idemPayload = {
    vendorId,
    creditDate,
    memo: input.memo?.trim() || null,
    lines: lineRows.map(l => ({
      accountId: l.accountId,
      description: l.description,
      qty6: formatDecimal6(l.qty6),
      rate4: formatDecimal4(l.rate4),
      amt4: formatDecimal4(l.amt4),
    })),
  };
  const idemKey = `vc-${crypto
    .createHash('sha256')
    .update(JSON.stringify(idemPayload))
    .digest('hex')
    .slice(0, 24)}`;
  const idem = await checkRouteIdempotency<any>(tx, companyId, 'vendor_credit_create', idemKey, idemPayload);
  if (idem.hit) {
    return idem.response;
  }

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
  const result = all.find(v => v.id === vcId)!;
  await saveRouteIdempotency(
    tx, companyId, 'vendor_credit_create', idemKey, idem.payloadHash, 201, result, actor.userId
  );
  return result;
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

export interface VendorAgingResult {
  buckets: {
    current4: bigint;
    d1_30_4: bigint;
    d31_60_4: bigint;
    d61_90_4: bigint;
    d90plus4: bigint;
  };
  total4: bigint;
  unappliedCredit4: bigint;
  unappliedPayment4: bigint;
  lines: Array<{
    billId: number;
    billNumber: string;
    billDate: string;
    dueDate: string;
    daysPastDue: number;
    originalBalance: number;
    balanceDue: number;
    appliedUnapplied: number;
  }>;
}

function emptyVendorAging(): VendorAgingResult {
  return {
    buckets: { current4: 0n, d1_30_4: 0n, d31_60_4: 0n, d61_90_4: 0n, d90plus4: 0n },
    total4: 0n,
    unappliedCredit4: 0n,
    unappliedPayment4: 0n,
    lines: [],
  };
}

/**
 * FIFO AP aging as of a date. Open bill balances are reconstructed from the
 * bill total less payment allocations and vendor-credit applications up to the
 * date. Any unapplied supplier credits or prepayments are then consumed oldest
 * bill first, which is how AP controllers expect a supplier position to net.
 */
export async function buildVendorAgingBuckets(
  tx: Transaction,
  companyId: number,
  vendorId: number,
  asOfDate?: string
): Promise<VendorAgingResult> {
  const asOf = asOfDate ? assertIsoDate(asOfDate, 'asOfDate') : todayIsoDate();
  const [billRes, creditRes, paymentRes] = await Promise.all([
    tx.query<{
      id: number;
      bill_number: string;
      bill_date: string;
      due_date: string;
      total: string;
      paid: string;
      credited: string;
    }>(
      `SELECT b.id, b.bill_number, b.bill_date::text, b.due_date::text, b.total::text,
              COALESCE(pay.allocated, 0)::NUMERIC(19,4)::text AS paid,
              COALESCE(vca.applied, 0)::NUMERIC(19,4)::text AS credited
         FROM bills b
         LEFT JOIN (
           SELECT a.bill_id, SUM(a.amount) AS allocated
             FROM bill_payment_allocations a
             JOIN bill_payments p
               ON p.company_id = a.company_id AND p.id = a.bill_payment_id
            WHERE a.company_id = $1 AND p.is_voided = FALSE AND p.payment_date <= $3::DATE
            GROUP BY a.bill_id
         ) pay ON pay.bill_id = b.id
         LEFT JOIN (
           SELECT bill_id, SUM(amount) AS applied
             FROM vendor_credit_applications
            WHERE company_id = $1 AND applied_date <= $3::DATE
            GROUP BY bill_id
         ) vca ON vca.bill_id = b.id
        WHERE b.company_id = $1 AND b.vendor_id = $2
          AND b.status <> 'voided' AND b.bill_date <= $3::DATE
        ORDER BY b.due_date ASC, b.id ASC`,
      [companyId, vendorId, asOf]
    ),
    tx.query<{ s: string }>(
      `SELECT COALESCE(SUM(vc.total - COALESCE(app.applied, 0)), 0)::NUMERIC(19,4)::text AS s
         FROM vendor_credits vc
         LEFT JOIN (
           SELECT vendor_credit_id, SUM(amount) AS applied
             FROM vendor_credit_applications
            WHERE company_id = $1 AND applied_date <= $3::DATE
            GROUP BY vendor_credit_id
         ) app ON app.vendor_credit_id = vc.id
        WHERE vc.company_id = $1 AND vc.vendor_id = $2
          AND vc.status <> 'voided' AND vc.credit_date <= $3::DATE`,
      [companyId, vendorId, asOf]
    ),
    tx.query<{ s: string }>(
      `SELECT COALESCE(SUM(bp.amount - COALESCE(alloc.allocated, 0)), 0)::NUMERIC(19,4)::text AS s
         FROM bill_payments bp
         LEFT JOIN (
           SELECT bill_payment_id, SUM(amount) AS allocated
             FROM bill_payment_allocations
            WHERE company_id = $1
            GROUP BY bill_payment_id
         ) alloc ON alloc.bill_payment_id = bp.id
        WHERE bp.company_id = $1 AND bp.vendor_id = $2
          AND bp.is_voided = FALSE AND bp.payment_date <= $3::DATE`,
      [companyId, vendorId, asOf]
    ),
  ]);

  const result = emptyVendorAging();
  result.unappliedCredit4 = parseDecimal4(creditRes.rows[0].s);
  result.unappliedPayment4 = parseDecimal4(paymentRes.rows[0].s);

  const openBills: Array<{
    billId: number;
    billNumber: string;
    billDate: string;
    dueDate: string;
    original4: bigint;
    balance4: bigint;
    daysPastDue: number;
  }> = [];
  for (const b of billRes.rows) {
    const original4 = parseDecimal4(b.total);
    const balance4 = original4 - parseDecimal4(b.paid) - parseDecimal4(b.credited);
    if (balance4 > 0n) {
      const dueMs = Date.parse(`${b.due_date}T00:00:00Z`);
      const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
      openBills.push({
        billId: Number(b.id),
        billNumber: b.bill_number,
        billDate: b.bill_date,
        dueDate: b.due_date,
        original4,
        balance4,
        daysPastDue: Math.max(0, Math.floor((asOfMs - dueMs) / 86_400_000)),
      });
    }
  }

  let availableCredit4 = result.unappliedCredit4;
  let availablePayment4 = result.unappliedPayment4;
  for (const bill of openBills) {
    const fromCredit4 = availableCredit4 >= bill.balance4 ? bill.balance4 : availableCredit4;
    availableCredit4 -= fromCredit4;
    let billRemaining4 = bill.balance4 - fromCredit4;
    const fromPayment4 = availablePayment4 >= billRemaining4 ? billRemaining4 : availablePayment4;
    availablePayment4 -= fromPayment4;
    billRemaining4 -= fromPayment4;
    const applied4 = fromCredit4 + fromPayment4;
    const remaining4 = billRemaining4;
    if (remaining4 <= 0n) continue;

    if (bill.daysPastDue <= 0) result.buckets.current4 += remaining4;
    else if (bill.daysPastDue <= 30) result.buckets.d1_30_4 += remaining4;
    else if (bill.daysPastDue <= 60) result.buckets.d31_60_4 += remaining4;
    else if (bill.daysPastDue <= 90) result.buckets.d61_90_4 += remaining4;
    else result.buckets.d90plus4 += remaining4;
    result.total4 += remaining4;
    result.lines.push({
      billId: bill.billId,
      billNumber: bill.billNumber,
      billDate: bill.billDate,
      dueDate: bill.dueDate,
      daysPastDue: bill.daysPastDue,
      originalBalance: toMoneyNumber(bill.original4),
      balanceDue: toMoneyNumber(remaining4),
      appliedUnapplied: toMoneyNumber(applied4),
    });
  }

  // Unapplied supplier credits/prepayments beyond open bills are a net
  // supplier position, not an ageable payable. Expose them separately.
  result.unappliedCredit4 = availableCredit4;
  result.unappliedPayment4 = availablePayment4;
  return result;
}

export async function getVendorApProfile(
  tx: Transaction,
  companyId: number,
  vendorId: number,
  asOfDate?: string
) {
  const vRes = await tx.query<any>(
    `SELECT v.*, pt.name AS terms_label
       FROM vendors v
       LEFT JOIN payment_terms pt
         ON pt.company_id = v.company_id AND pt.id = v.payment_term_id
      WHERE v.company_id = $1 AND v.id = $2 LIMIT 1`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const vendor = vRes.rows[0];
  const asOf = asOfDate ? assertIsoDate(asOfDate, 'asOfDate') : todayIsoDate();

  const [exposure, aging, counts, statements] = await Promise.all([
    getVendorApExposure(tx, companyId, vendorId),
    buildVendorAgingBuckets(tx, companyId, vendorId, asOf),
    tx.query<{
      open_bills: string;
      open_pos: string;
      unapplied_credits: string;
      last_bill_date: string | null;
      last_payment_date: string | null;
      ytd_bills: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM bills WHERE company_id = $1 AND vendor_id = $2
            AND status <> 'voided' AND balance_due > 0)::text AS open_bills,
         (SELECT COUNT(*) FROM purchase_orders WHERE company_id = $1 AND vendor_id = $2
            AND status = 'open')::text AS open_pos,
         (SELECT COUNT(*) FROM vendor_credits WHERE company_id = $1 AND vendor_id = $2
            AND status <> 'voided' AND remaining_credit > 0)::text AS unapplied_credits,
         (SELECT MAX(bill_date)::text FROM bills WHERE company_id = $1 AND vendor_id = $2
            AND status <> 'voided') AS last_bill_date,
         (SELECT MAX(payment_date)::text FROM bill_payments WHERE company_id = $1 AND vendor_id = $2
            AND is_voided = FALSE) AS last_payment_date,
         (SELECT COALESCE(SUM(total), 0)::NUMERIC(19,4)::text FROM bills
           WHERE company_id = $1 AND vendor_id = $2 AND status <> 'voided'
             AND bill_date >= DATE_TRUNC('year', $3::DATE)) AS ytd_bills`,
      [companyId, vendorId, asOf]
    ),
    tx.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM vendor_statements
        WHERE company_id = $1 AND vendor_id = $2`,
      [companyId, vendorId]
    ),
  ]);
  const c = counts.rows[0];

  return {
    vendorId,
    vendorCode: vendor.vendor_code || '',
    vendorName: vendor.company_name,
    email: vendor.email || '',
    phone: vendor.phone || '',
    address: vendor.address || '',
    taxId: vendor.ein_or_ssn || '',
    is1099Eligible: Boolean(vendor.is_1099_eligible),
    terms: vendor.terms_label || 'Net 30',
    status: vendor.status || (vendor.is_active ? 'active' : 'inactive'),
    currencyCode: vendor.currency_code || 'ZMW',
    vendorCategory: vendor.vendor_category || 'goods',
    isPreferred: Boolean(vendor.is_preferred),
    notes: vendor.notes || '',
    bankName: vendor.bank_name || '',
    bankAccountName: vendor.bank_account_name || '',
    bankAccountNumber: vendor.bank_account_number || '',
    bankBranch: vendor.bank_branch || '',
    openingBalanceBillId: vendor.opening_balance_bill_id
      ? Number(vendor.opening_balance_bill_id)
      : null,
    asOfDate: asOf,
    exposure: {
      openBillBalance: toMoneyNumber(exposure.openBillBalance4),
      unappliedVendorCredits: toMoneyNumber(exposure.unappliedVendorCredits4),
      unappliedBillPayments: toMoneyNumber(exposure.unappliedBillPayments4),
      netExposure: toMoneyNumber(exposure.exposure4),
    },
    aging: {
      current: toMoneyNumber(aging.buckets.current4),
      days1To30: toMoneyNumber(aging.buckets.d1_30_4),
      days31To60: toMoneyNumber(aging.buckets.d31_60_4),
      days61To90: toMoneyNumber(aging.buckets.d61_90_4),
      daysOver90: toMoneyNumber(aging.buckets.d90plus4),
      total: toMoneyNumber(aging.total4),
      unappliedCredit: toMoneyNumber(aging.unappliedCredit4),
      unappliedPayment: toMoneyNumber(aging.unappliedPayment4),
      bills: aging.lines,
    },
    counts: {
      openBills: Number(c.open_bills),
      openPurchaseOrders: Number(c.open_pos),
      unappliedCredits: Number(c.unapplied_credits),
      statements: Number(statements.rows[0]?.count || 0),
    },
    lastBillDate: c.last_bill_date,
    lastPaymentDate: c.last_payment_date,
    ytdSpend: toMoneyNumber(parseDecimal4(c.ytd_bills)),
    createdAt: vendor.created_at,
  };
}

export async function getApAgingReport(tx: Transaction, companyId: number, asOfDate?: string) {
  const asOf = asOfDate ? assertIsoDate(asOfDate, 'asOfDate') : todayIsoDate();
  const vendorRes = await tx.query<{ id: number; company_name: string }>(
    `SELECT DISTINCT v.id, v.company_name
       FROM vendors v
       JOIN bills b ON b.company_id = v.company_id AND b.vendor_id = v.id
      WHERE v.company_id = $1 AND b.status <> 'voided' AND b.bill_date <= $2::DATE
      ORDER BY v.company_name ASC`,
    [companyId, asOf]
  );

  let grandCurrent = 0n;
  let grand1_30 = 0n;
  let grand31_60 = 0n;
  let grand61_90 = 0n;
  let grand90plus = 0n;
  let grandUnappliedCredit = 0n;
  let grandUnappliedPayment = 0n;
  const vendors: any[] = [];

  for (const v of vendorRes.rows) {
    const aging = await buildVendorAgingBuckets(tx, companyId, Number(v.id), asOf);
    grandCurrent += aging.buckets.current4;
    grand1_30 += aging.buckets.d1_30_4;
    grand31_60 += aging.buckets.d31_60_4;
    grand61_90 += aging.buckets.d61_90_4;
    grand90plus += aging.buckets.d90plus4;
    grandUnappliedCredit += aging.unappliedCredit4;
    grandUnappliedPayment += aging.unappliedPayment4;
    if (aging.total4 === 0n && aging.lines.length === 0) continue;
    vendors.push({
      vendorId: Number(v.id),
      vendorName: v.company_name,
      current: toMoneyNumber(aging.buckets.current4),
      days1To30: toMoneyNumber(aging.buckets.d1_30_4),
      days31To60: toMoneyNumber(aging.buckets.d31_60_4),
      days61To90: toMoneyNumber(aging.buckets.d61_90_4),
      daysOver90: toMoneyNumber(aging.buckets.d90plus4),
      total: toMoneyNumber(aging.total4),
      unappliedCredit: toMoneyNumber(aging.unappliedCredit4),
      unappliedPayment: toMoneyNumber(aging.unappliedPayment4),
      bills: aging.lines,
    });
  }

  return {
    asOfDate: asOf,
    vendors,
    totals: {
      current: toMoneyNumber(grandCurrent),
      days1To30: toMoneyNumber(grand1_30),
      days31To60: toMoneyNumber(grand31_60),
      days61To90: toMoneyNumber(grand61_90),
      daysOver90: toMoneyNumber(grand90plus),
      total: toMoneyNumber(grandCurrent + grand1_30 + grand31_60 + grand61_90 + grand90plus),
      unappliedCredit: toMoneyNumber(grandUnappliedCredit),
      unappliedPayment: toMoneyNumber(grandUnappliedPayment),
    },
  };
}

export async function generateSupplierStatement(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { vendorId: number; periodStart?: string; periodEnd?: string; saveSnapshot?: boolean }
) {
  const vendorId = Number(input.vendorId);
  const vRes = await tx.query<{
    id: number;
    company_name: string;
    vendor_code: string | null;
    email: string | null;
    address: string | null;
    ein_or_ssn: string | null;
    currency_code: string;
  }>(
    `SELECT id, company_name, vendor_code, email, address, ein_or_ssn, currency_code
       FROM vendors WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');
  const vendor = vRes.rows[0];

  const periodEnd = input.periodEnd ? assertIsoDate(input.periodEnd, 'periodEnd') : todayIsoDate();
  const periodStart = input.periodStart ? assertIsoDate(input.periodStart, 'periodStart') : `${periodEnd.slice(0, 7)}-01`;
  if (periodStart > periodEnd) {
    throw new AccountingError(400, 'periodStart must be on or before periodEnd', 'INVALID_STATEMENT_PERIOD');
  }

  const [priorBills, priorPmts, priorVcs, activity] = await Promise.all([
    tx.query<{ s: string }>(
      `SELECT COALESCE(SUM(total), 0)::NUMERIC(19,4)::text AS s FROM bills
        WHERE company_id = $1 AND vendor_id = $2 AND status <> 'voided' AND bill_date < $3::DATE`,
      [companyId, vendorId, periodStart]
    ),
    tx.query<{ s: string }>(
      `SELECT COALESCE(SUM(amount), 0)::NUMERIC(19,4)::text AS s FROM bill_payments
        WHERE company_id = $1 AND vendor_id = $2 AND is_voided = FALSE AND payment_date < $3::DATE`,
      [companyId, vendorId, periodStart]
    ),
    tx.query<{ s: string }>(
      `SELECT COALESCE(SUM(total), 0)::NUMERIC(19,4)::text AS s FROM vendor_credits
        WHERE company_id = $1 AND vendor_id = $2 AND status <> 'voided' AND credit_date < $3::DATE`,
      [companyId, vendorId, periodStart]
    ),
    tx.query<{ doc_date: string; doc_type: string; doc_number: string; description: string; amount: string }>(
      `SELECT bill_date::text AS doc_date, 'Bill' AS doc_type, bill_number AS doc_number,
              COALESCE(memo, 'Supplier Bill') AS description, total::text AS amount
         FROM bills
        WHERE company_id = $1 AND vendor_id = $2 AND status <> 'voided'
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
        WHERE company_id = $1 AND vendor_id = $2 AND status <> 'voided'
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

  const aging = await buildVendorAgingBuckets(tx, companyId, vendorId, periodEnd);
  const statement = {
    vendorId,
    vendorName: vendor.company_name,
    vendorCode: vendor.vendor_code || '',
    vendorEmail: vendor.email || '',
    remitToAddress: vendor.address || '',
    taxId: vendor.ein_or_ssn || '',
    currencyCode: vendor.currency_code || 'ZMW',
    periodStart,
    periodEnd,
    openingBalance: toMoneyNumber(openingBal4),
    closingBalance: toMoneyNumber(running4),
    lines,
    aging: {
      current: toMoneyNumber(aging.buckets.current4),
      days1To30: toMoneyNumber(aging.buckets.d1_30_4),
      days31To60: toMoneyNumber(aging.buckets.d31_60_4),
      days61To90: toMoneyNumber(aging.buckets.d61_90_4),
      daysOver90: toMoneyNumber(aging.buckets.d90plus4),
      total: toMoneyNumber(aging.total4),
      unappliedCredit: toMoneyNumber(aging.unappliedCredit4),
      unappliedPayment: toMoneyNumber(aging.unappliedPayment4),
      bills: aging.lines,
    },
  };

  let statementId: number | null = null;
  if (input.saveSnapshot) {
    const ins = await tx.query<{ id: number }>(
      `INSERT INTO vendor_statements (
         company_id, vendor_id, statement_date, period_start, period_end, currency_code,
         opening_balance, closing_balance, snapshot_json, created_by
       ) VALUES ($1, $2, $3::DATE, $4::DATE, $5::DATE, $6,
                 $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9::JSONB, $10)
       RETURNING id`,
      [
        companyId,
        vendorId,
        todayIsoDate(),
        periodStart,
        periodEnd,
        statement.currencyCode,
        formatDecimal4(openingBal4),
        formatDecimal4(running4),
        JSON.stringify(statement),
        actor.userId,
      ]
    );
    statementId = Number(ins.rows[0].id);
    await writeAuditLog(tx, {
      companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'VENDOR_STATEMENT_GENERATED',
      tableName: 'vendor_statements',
      recordId: statementId,
      newValues: { vendorId, periodStart, periodEnd, closingBalance: formatDecimal4(running4) },
    });
  }

  return { ...statement, statementId };
}

export async function listVendorStatements(
  tx: Transaction,
  companyId: number,
  vendorId: number,
  limit = 25
) {
  const res = await tx.query<{
    id: number;
    statement_date: string;
    period_start: string;
    period_end: string;
    currency_code: string;
    opening_balance: string;
    closing_balance: string;
    emailed_at: string | null;
    created_at: string;
  }>(
    `SELECT id, statement_date::text, period_start::text, period_end::text, currency_code,
            opening_balance::text, closing_balance::text, emailed_at::text, created_at::text
       FROM vendor_statements
      WHERE company_id = $1 AND vendor_id = $2
      ORDER BY statement_date DESC, id DESC
      LIMIT $3`,
    [companyId, vendorId, Math.min(Math.max(Number(limit) || 25, 1), 100)]
  );
  return res.rows.map(r => ({
    statementId: Number(r.id),
    statementDate: r.statement_date,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    currencyCode: r.currency_code,
    openingBalance: toMoneyNumber(parseDecimal4(r.opening_balance)),
    closingBalance: toMoneyNumber(parseDecimal4(r.closing_balance)),
    emailedAt: r.emailed_at,
    createdAt: r.created_at,
  }));
}

export async function getVendorStatement(
  tx: Transaction,
  companyId: number,
  statementId: number
) {
  const res = await tx.query<{ snapshot_json: any }>(
    `SELECT snapshot_json FROM vendor_statements
      WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, statementId]
  );
  if (res.rows.length === 0 || !res.rows[0].snapshot_json) {
    throw new AccountingError(404, 'Supplier statement not found');
  }
  return res.rows[0].snapshot_json;
}

/**
 * Queues a supplier statement email for the tenant delivery worker and records
 * it in email_log. Suppliers need the remit-to and tax context for reconciliation.
 */
export async function sendSupplierStatement(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { vendorId: number; periodStart?: string; periodEnd?: string; recipient?: string | null }
) {
  const statement = await generateSupplierStatement(tx, companyId, actor, {
    vendorId: input.vendorId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    saveSnapshot: true,
  });
  const recipient = String(input.recipient || statement.vendorEmail || '').trim();
  if (!recipient) {
    throw new AccountingError(400, 'A recipient email address is required', 'MISSING_RECIPIENT');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
    throw new AccountingError(400, 'Recipient email address is invalid', 'INVALID_RECIPIENT');
  }

  const subject = `Supplier statement ${statement.periodStart} to ${statement.periodEnd} — ${statement.vendorName}`;
  const body = [
    `Supplier: ${statement.vendorName} (${statement.vendorCode})`,
    `Statement period: ${statement.periodStart} to ${statement.periodEnd}`,
    `Opening balance: ${statement.openingBalance.toFixed(2)} ${statement.currencyCode}`,
    `Closing balance: ${statement.closingBalance.toFixed(2)} ${statement.currencyCode}`,
    '',
    ...statement.lines.map(
      l =>
        `${l.date}  ${l.type} ${l.number}  charge ${l.charge.toFixed(2)}  credit ${l.credit.toFixed(2)}  balance ${l.runningBalance.toFixed(2)}`
    ),
  ].join('\n');

  const emailIns = await tx.query<{ id: number }>(
    `INSERT INTO email_log (company_id, recipient, subject, entity_type, entity_id, status, sent_by, body)
     VALUES ($1, $2, $3, 'vendor_statement', $4, 'queued', $5, $6)
     RETURNING id`,
    [companyId, recipient, subject, statement.statementId, actor.userId, body]
  );
  await tx.query(
    `UPDATE vendor_statements SET emailed_at = NOW() WHERE company_id = $1 AND id = $2`,
    [companyId, statement.statementId]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'VENDOR_STATEMENT_SENT',
    tableName: 'vendor_statements',
    recordId: statement.statementId ?? input.vendorId,
    newValues: {
      recipient,
      emailLogId: Number(emailIns.rows[0].id),
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
    },
  });

  return {
    statementId: statement.statementId,
    emailLogId: Number(emailIns.rows[0].id),
    recipient,
    subject,
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    closingBalance: statement.closingBalance,
  };
}

export async function setBillPaymentHold(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { billId: number; hold: boolean; reason?: string | null }
) {
  const billId = Number(input.billId);
  const res = await tx.query<{ id: number; bill_number: string; payment_hold: boolean; status: string }>(
    `SELECT id, bill_number, COALESCE(payment_hold, FALSE) AS payment_hold, status
       FROM bills WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, billId]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Bill not found', 'BILL_NOT_FOUND');
  const bill = res.rows[0];
  if (bill.status === 'voided') throw new AccountingError(409, 'Cannot change payment hold on a voided bill', 'BILL_VOIDED');

  const hold = Boolean(input.hold);
  const reason = hold ? (String(input.reason || '').trim() || 'Payment hold') : null;
  await tx.query(
    `UPDATE bills
        SET payment_hold = $3::BOOLEAN,
            payment_hold_reason = $4,
            payment_hold_at = CASE WHEN $3::BOOLEAN THEN NOW() ELSE NULL END,
            payment_hold_by_user_id = CASE WHEN $3::BOOLEAN THEN $5::BIGINT ELSE NULL END
      WHERE company_id = $1 AND id = $2`,
    [companyId, billId, hold, reason, actor.userId]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: hold ? 'BILL_PAYMENT_HOLD_PLACED' : 'BILL_PAYMENT_HOLD_RELEASED',
    tableName: 'bills',
    recordId: billId,
    newValues: { billNumber: bill.bill_number, paymentHold: hold, reason },
  });
  return { billId, billNumber: bill.bill_number, paymentHold: hold, reason };
}

export async function evaluateThreeWayMatch(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  billId: number,
  options: { priceTolerance?: number; qtyTolerance?: number } = {}
) {
  const billRes = await tx.query<any>(
    `SELECT id, bill_number, vendor_id, purchase_order_id, total::text, status,
            COALESCE(match_status, 'unmatched') AS match_status
       FROM bills WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, billId]
  );
  if (billRes.rows.length === 0) throw new AccountingError(404, 'Bill not found', 'BILL_NOT_FOUND');
  const bill = billRes.rows[0];

  const linesRes = await tx.query<any>(
    `SELECT line_order, item_id, description, quantity::text, unit_cost::text, amount::text, po_line_id
       FROM bill_lines WHERE company_id = $1 AND bill_id = $2 ORDER BY line_order ASC, id ASC`,
    [companyId, billId]
  );

  await tx.query(`DELETE FROM bill_match_discrepancies WHERE company_id = $1 AND bill_id = $2`, [companyId, billId]);

  const discrepancies: any[] = [];
  const poId = bill.purchase_order_id ? Number(bill.purchase_order_id) : null;
  let poLinesRows: any[] = [];
  const grnByPoLineMap = new Map<number, bigint>();
  const priceTolerance = Number.isFinite(Number(options.priceTolerance)) ? Math.max(0, Number(options.priceTolerance)) : 0.01;
  const qtyTolerance4 = parseDecimal4(Number.isFinite(Number(options.qtyTolerance)) ? Number(options.qtyTolerance) : 0);
  if (!poId) {
    discrepancies.push({
      lineIndex: 0, varianceType: 'missing_po', expectedValue: null, actualValue: null, deltaAmount: null,
      note: 'Bill is not linked to a purchase order',
    });
  } else {
    const poRes = await tx.query<any>(
      `SELECT id, status FROM purchase_orders WHERE company_id = $1 AND id = $2`,
      [companyId, poId]
    );
    if (poRes.rows.length === 0) {
      discrepancies.push({ lineIndex: 0, varianceType: 'missing_po', expectedValue: null, actualValue: null, deltaAmount: null, note: 'Linked PO not found' });
    } else {
      const poLines = await tx.query<any>(
        `SELECT id, line_order, item_id, description, quantity::text, unit_cost::text, amount::text
           FROM purchase_order_lines WHERE company_id = $1 AND purchase_order_id = $2 ORDER BY line_order ASC, id ASC`,
        [companyId, poId]
      );
      poLinesRows = poLines.rows;
      const grnLines = await tx.query<any>(
        `SELECT grl.po_line_id, SUM(grl.quantity_received::numeric)::text AS qty_received
           FROM goods_receipt_lines grl
           JOIN goods_receipts gr ON gr.company_id = grl.company_id AND gr.id = grl.goods_receipt_id
          WHERE gr.company_id = $1 AND gr.purchase_order_id = $2
          GROUP BY grl.po_line_id`,
        [companyId, poId]
      );
      for (const g of grnLines.rows) {
        if (g.po_line_id !== null) grnByPoLineMap.set(Number(g.po_line_id), parseDecimal4(g.qty_received || 0));
      }

      for (let i = 0; i < linesRes.rows.length; i++) {
        const bl = linesRes.rows[i];
        const poLineId = bl.po_line_id ? Number(bl.po_line_id) : null;
        const poLine = poLineId ? poLinesRows.find((p: any) => Number(p.id) === poLineId) : poLinesRows[i];
        const billQty = parseDecimal4(bl.quantity || 0);
        const billUnit = parseDecimal6(bl.unit_cost || 0);

        if (!poLine) {
          discrepancies.push({ lineIndex: i + 1, varianceType: 'missing_po', expectedValue: null, actualValue: toMoneyNumber(billQty), deltaAmount: toMoneyNumber(parseDecimal4(bl.amount || 0)), note: `No matching PO line for bill line ${i + 1}` });
          continue;
        }
        const poQty = parseDecimal4(poLine.quantity || 0);
        const poUnit = parseDecimal6(poLine.unit_cost || 0);
        const grnQty = poLineId ? (grnByPoLineMap.get(poLineId) ?? 0n) : 0n;
        if (grnQty === 0n) {
          discrepancies.push({ lineIndex: i + 1, varianceType: 'missing_grn', expectedValue: toMoneyNumber(poQty), actualValue: 0, deltaAmount: toMoneyNumber(parseDecimal4(bl.amount || 0)), note: `No GRN received for PO line ${poLine.line_order}` });
        } else if (billQty > grnQty + qtyTolerance4) {
          discrepancies.push({ lineIndex: i + 1, varianceType: 'quantity', expectedValue: toMoneyNumber(grnQty), actualValue: toMoneyNumber(billQty), deltaAmount: toMoneyNumber(billQty - grnQty), note: `Billed qty exceeds received qty on line ${i + 1}` });
        }
        const priceDelta = Number(bl.unit_cost || 0) - Number(poLine.unit_cost || 0);
        if (Math.abs(priceDelta) > priceTolerance) {
          discrepancies.push({ lineIndex: i + 1, varianceType: 'price', expectedValue: Number(poLine.unit_cost || 0), actualValue: Number(bl.unit_cost || 0), deltaAmount: priceDelta, note: `Unit cost variance on line ${i + 1}` });
        }
      }
    }
  }

  for (const d of discrepancies) {
    await tx.query(
      `INSERT INTO bill_match_discrepancies (company_id, bill_id, po_id, grn_id, line_index, variance_type, expected_value, actual_value, delta_amount)
       VALUES ($1, $2, $3, NULL, $4, $5, $6::NUMERIC(19,4), $7::NUMERIC(19,4), $8::NUMERIC(19,4))`,
      [companyId, billId, poId, d.lineIndex, d.varianceType, d.expectedValue, d.actualValue, d.deltaAmount]
    );
  }

  const matchStatus = discrepancies.length === 0 ? 'matched' : 'variance_held';
  await tx.query(
    `UPDATE bills SET match_status = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, billId, matchStatus]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BILL_THREE_WAY_MATCH_EVALUATED',
    tableName: 'bills',
    recordId: billId,
    newValues: { billNumber: bill.bill_number, matchStatus, discrepancyCount: discrepancies.length },
  });

  const matrix = linesRes.rows.map((bl: any, i: number) => {
    const poLineId = bl.po_line_id ? Number(bl.po_line_id) : null;
    const poLine = poLineId ? poLinesRows.find((p: any) => Number(p.id) === poLineId) : poLinesRows[i];
    return {
      lineIndex: i + 1,
      description: bl.description,
      billQty: Number(bl.quantity || 0),
      billUnitCost: Number(bl.unit_cost || 0),
      poQty: poLine ? Number(poLine.quantity || 0) : null,
      poUnitCost: poLine ? Number(poLine.unit_cost || 0) : null,
      grnQty: poLineId ? Number(formatDecimal4(grnByPoLineMap.get(poLineId) ?? 0n)) : null,
      hasVariance: discrepancies.some(d => d.lineIndex === i + 1),
    };
  });

  return { billId, billNumber: bill.bill_number, matchStatus, discrepancies, matrix, tolerances: { price: priceTolerance, quantity: toMoneyNumber(qtyTolerance4) } };
}

export async function approveBillMatchOverride(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { billId: number; reason: string }
) {
  const billId = Number(input.billId);
  const reason = String(input.reason || '').trim();
  if (!reason) throw new AccountingError(400, 'reason is required', 'MISSING_REASON');
  const res = await tx.query<{ id: number; bill_number: string; match_status: string }>(
    `SELECT id, bill_number, COALESCE(match_status, 'unmatched') AS match_status
       FROM bills WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, billId]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Bill not found', 'BILL_NOT_FOUND');
  const bill = res.rows[0];
  await tx.query(
    `UPDATE bills SET match_status = 'approved_override' WHERE company_id = $1 AND id = $2`,
    [companyId, billId]
  );
  await tx.query(
    `UPDATE bill_match_discrepancies
        SET approved_by = $3, approved_at = NOW(), approval_reason = $4
      WHERE company_id = $1 AND bill_id = $2`,
    [companyId, billId, actor.userId, reason]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BILL_MATCH_OVERRIDE_APPROVED',
    tableName: 'bills',
    recordId: billId,
    newValues: { billNumber: bill.bill_number, reason, previousStatus: bill.match_status },
  });
  return { billId, billNumber: bill.bill_number, matchStatus: 'approved_override', reason };
}

export async function executeBatchPaymentRun(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { bankAccountId: number; billIds: number[]; paymentDate?: string; memo?: string | null; idempotencyKey?: string | null }
) {
  const route = 'ap_batch_payment_run';
  const idemPayload = {
    bankAccountId: Number(input.bankAccountId),
    billIds: (input.billIds || []).map(Number).sort((a, b) => a - b),
    paymentDate: input.paymentDate || null,
    memo: input.memo || null,
  };
  const idem = await checkRouteIdempotency<any>(tx, companyId, route, input.idempotencyKey, idemPayload);
  if (idem.hit) return { ...idem.response, idempotentReplay: true };

  if (!Array.isArray(input.billIds) || input.billIds.length === 0) {
    throw new AccountingError(400, 'billIds is required', 'MISSING_BILL_IDS');
  }
  const paymentDate = input.paymentDate ? assertIsoDate(input.paymentDate, 'paymentDate') : todayIsoDate();
  const bankAccountId = Number(input.bankAccountId);
  if (!Number.isInteger(bankAccountId) || bankAccountId <= 0) {
    throw new AccountingError(400, 'Valid bankAccountId is required', 'INVALID_BANK_ACCOUNT');
  }

  const billIds = Array.from(new Set(input.billIds.map(Number))).filter(n => Number.isInteger(n) && n > 0);
  const billsRes = await tx.query<any>(
    `SELECT id, vendor_id, bill_number, balance_due::text, currency_code, COALESCE(payment_hold, FALSE) AS payment_hold, status
       FROM bills
      WHERE company_id = $1 AND id = ANY($2::BIGINT[])
      FOR UPDATE`,
    [companyId, billIds]
  );
  const byId = new Map(billsRes.rows.map((b: any) => [Number(b.id), b]));

  const groups = new Map<number, any[]>();
  const skipped: any[] = [];
  for (const id of billIds) {
    const b = byId.get(id);
    if (!b) { skipped.push({ billId: id, reason: 'NOT_FOUND' }); continue; }
    if (b.status === 'voided' || b.status === 'paid' || parseDecimal4(b.balance_due) <= 0n) {
      skipped.push({ billId: id, reason: 'NOT_PAYABLE' }); continue;
    }
    if (b.payment_hold) { skipped.push({ billId: id, reason: 'PAYMENT_HOLD' }); continue; }
    const arr = groups.get(Number(b.vendor_id)) ?? [];
    arr.push(b);
    groups.set(Number(b.vendor_id), arr);
  }

  const runNumber = await generateNextDocNumber(tx, companyId, 'ap_payment_runs', 'run_number', 'APRUN');
  const runIns = await tx.query<{ id: number }>(
    `INSERT INTO ap_payment_runs (company_id, run_number, bank_account_id, payment_date, total_amount, status, created_by)
     VALUES ($1, $2, $3, $4::DATE, 0.0000, 'posted', $5) RETURNING id`,
    [companyId, runNumber, bankAccountId, paymentDate, actor.userId]
  );
  const runId = Number(runIns.rows[0].id);

  const results: any[] = [];
  let total4 = 0n;
  for (const [vendorId, bills] of groups.entries()) {
    const allocations = bills.map((b: any) => ({ billId: Number(b.id), amount: b.balance_due }));
    try {
      const payment = await recordBillPayment(tx, companyId, actor, {
        vendorId,
        paymentDate,
        bankAccountId,
        memo: input.memo || `Batch payment run ${runNumber}`,
        allocations,
      });
      const paidAmount4 = allocations.reduce((s, a) => s + parseDecimal4(a.amount), 0n);
      total4 += paidAmount4;
      for (const a of allocations) {
        await tx.query(
          `INSERT INTO ap_payment_run_items (company_id, payment_run_id, bill_id, bill_payment_id, amount, status)
           VALUES ($1, $2, $3, $4, $5::NUMERIC(19,4), 'posted')`,
          [companyId, runId, a.billId, payment.billPayment?.id ?? null, formatDecimal4(parseDecimal4(a.amount))]
        );
      }
      results.push({ vendorId, billPaymentId: payment.billPayment?.id ?? null, billIds: allocations.map(a => a.billId), amount: formatDecimal4(paidAmount4) });
    } catch (err: any) {
      for (const a of allocations) {
        await tx.query(
          `INSERT INTO ap_payment_run_items (company_id, payment_run_id, bill_id, amount, status, error_message)
           VALUES ($1, $2, $3, $4::NUMERIC(19,4), 'failed', $5)`,
          [companyId, runId, a.billId, formatDecimal4(parseDecimal4(a.amount)), String(err?.message || 'Payment failed').slice(0, 500)]
        );
        skipped.push({ billId: a.billId, reason: 'FAILED', error: err?.message || 'Payment failed' });
      }
    }
  }

  await tx.query(`UPDATE ap_payment_runs SET total_amount = $3::NUMERIC(19,4) WHERE company_id = $1 AND id = $2`, [companyId, runId, formatDecimal4(total4)]);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'AP_BATCH_PAYMENT_RUN_EXECUTED',
    tableName: 'ap_payment_runs',
    recordId: runId,
    newValues: { runNumber, bankAccountId, paymentDate, totalAmount: formatDecimal4(total4), paymentCount: results.length, skippedCount: skipped.length },
  });

  const result = { runId, runNumber, paymentDate, bankAccountId, totalAmount: formatDecimal4(total4), payments: results, skipped };
  await saveRouteIdempotency(tx, companyId, route, input.idempotencyKey, idem.payloadHash, 200, result, actor.userId);
  return result;
}

function formatDecimal2Safe(val4: bigint): string {
  return formatDecimal4(val4).slice(0, -2);
}
