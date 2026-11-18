import crypto from 'node:crypto';
import { Transaction } from '@electric-sql/pglite';
import {
  AccountingError,
  ActorContext,
  createAccount,
  getCompanyAccountingPrefs,
} from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4, RoundingMode } from '../lib/decimal.ts';

export interface ControlAccountMap {
  bank1010: number;
  ar1100: number;
  inventory1200: number;
  ap2000: number;
  salesTax2200: number;
  revenue4000: number;
  fxGain4900: number;
  cogs5000: number;
  fxLoss6900: number;
  baseCurrency: string;
  roundingMode: RoundingMode;
}

export async function resolveCommercialContext(
  tx: Transaction,
  companyId: number,
  actor: ActorContext
): Promise<ControlAccountMap> {
  const prefs = await getCompanyAccountingPrefs(tx, companyId);
  const compRes = await tx.query<{ base_currency: string }>(
    `SELECT base_currency FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  );
  const baseCurrency = compRes.rows[0]?.base_currency || 'ZMW';

  const acctsRes = await tx.query<{
    id: number;
    code: string | null;
    account_type: string;
    is_active: boolean;
  }>(
    `SELECT id, code, account_type, is_active
       FROM accounts
      WHERE company_id = $1 AND is_active = TRUE
      ORDER BY id ASC`,
    [companyId]
  );

  const byCode = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const r of acctsRes.rows) {
    if (r.code) byCode.set(r.code, Number(r.id));
    if (!byType.has(r.account_type)) byType.set(r.account_type, Number(r.id));
  }

  const ensureAccount = async (
    code: string,
    fallbackType: string,
    createSpec: { name: string; accountType: any; detailType: any; description: string }
  ): Promise<number> => {
    const exact = byCode.get(code) ?? byType.get(fallbackType);
    if (exact) return exact;
    const created = await createAccount(tx, companyId, actor, {
      code,
      name: createSpec.name,
      accountType: createSpec.accountType,
      detailType: createSpec.detailType,
      description: createSpec.description,
    });
    return created.id;
  };

  const bank1010 = await ensureAccount('1010', 'Bank', {
    name: 'Operating Checking',
    accountType: 'Bank',
    detailType: 'bank',
    description: 'Primary operating bank account',
  });
  const ar1100 = await ensureAccount('1100', 'AccountsReceivable', {
    name: 'Accounts Receivable',
    accountType: 'AccountsReceivable',
    detailType: 'accounts_receivable',
    description: 'Customer trade receivables',
  });
  const inventory1200 = await ensureAccount('1200', 'Inventory', {
    name: 'Inventory Asset',
    accountType: 'Inventory',
    detailType: 'other_current_asset',
    description: 'Stocked stationery and raw materials',
  });
  const ap2000 = await ensureAccount('2000', 'AccountsPayable', {
    name: 'Accounts Payable',
    accountType: 'AccountsPayable',
    detailType: 'accounts_payable',
    description: 'Vendor payables',
  });
  const salesTax2200 =
    byCode.get('2200') ??
    byType.get('OtherCurrentLiability') ??
    (
      await createAccount(tx, companyId, actor, {
        code: '2200',
        name: 'Sales Tax Payable',
        accountType: 'OtherCurrentLiability',
        detailType: 'other_current_liability',
        description: 'Collected sales & use tax liability',
      })
    ).id;

  const revenue4000 = await ensureAccount('4000', 'Income', {
    name: 'Printing & Sales Revenue',
    accountType: 'Income',
    detailType: 'income',
    description: 'Primary operating sales revenue',
  });
  const fxGain4900 =
    byCode.get('4900') ??
    revenue4000;
  const cogs5000 = await ensureAccount('5000', 'CostOfGoodsSold', {
    name: 'Cost of Goods Sold',
    accountType: 'CostOfGoodsSold',
    detailType: 'cost_of_goods_sold',
    description: 'Direct production & inventory COGS',
  });
  const fxLoss6900 =
    byCode.get('6900') ??
    byType.get('OtherExpense') ??
    byType.get('Expense') ??
    (
      await createAccount(tx, companyId, actor, {
        code: '6900',
        name: 'Other Non-Operating Expense',
        accountType: 'OtherExpense',
        detailType: 'other_expense',
        description: 'Foreign exchange loss & non-operating charges',
      })
    ).id;

  return {
    bank1010,
    ar1100,
    inventory1200,
    ap2000,
    salesTax2200,
    revenue4000,
    fxGain4900,
    cogs5000,
    fxLoss6900,
    baseCurrency,
    roundingMode: prefs.roundingMode,
  };
}

export interface WorkflowControlAccounts extends ControlAccountMap {
  undeposited1050: number;
  purchasesInTransit1210: number;
  wip1250: number;
  grni2055: number;
  directLabourAbsorbed2110: number;
  spoilageVariance5100: number;
  machineOverhead6310: number;
}

export async function resolveWorkflowAccounts(
  tx: Transaction,
  companyId: number,
  actor: ActorContext
): Promise<WorkflowControlAccounts> {
  const base = await resolveCommercialContext(tx, companyId, actor);
  const acctsRes = await tx.query<{ id: number; code: string | null }>(
    `SELECT id, code FROM accounts WHERE company_id = $1 AND code IS NOT NULL`,
    [companyId]
  );
  const byCode = new Map<string, number>();
  for (const r of acctsRes.rows) {
    if (r.code) byCode.set(r.code, Number(r.id));
  }

  const ensureByCode = async (
    code: string,
    name: string,
    accountType: any,
    detailType: any,
    description: string
  ): Promise<number> => {
    const existing = byCode.get(code);
    if (existing) return existing;
    const created = await createAccount(tx, companyId, actor, {
      code,
      name,
      accountType,
      detailType,
      description,
    });
    byCode.set(code, created.id);
    return created.id;
  };

  const undeposited1050 = await ensureByCode(
    '1050',
    'Undeposited Funds',
    'OtherCurrentAsset',
    'other_current_asset',
    'Customer payments and cash receipts awaiting bank deposit'
  );
  const purchasesInTransit1210 = await ensureByCode(
    '1210',
    'Purchases In Transit',
    'OtherCurrentAsset',
    'other_current_asset',
    'Billed supplier inventory awaiting physical goods receipt'
  );
  const wip1250 = await ensureByCode(
    '1250',
    'Work in Progress (WIP)',
    'OtherCurrentAsset',
    'other_current_asset',
    'Issued raw materials, direct labour, and machine overhead on active print jobs'
  );
  const grni2055 = await ensureByCode(
    '2055',
    'Accrued Purchases (GRNI)',
    'OtherCurrentLiability',
    'other_current_liability',
    'Goods received not yet invoiced by supplier'
  );
  const directLabourAbsorbed2110 = await ensureByCode(
    '2110',
    'Direct Labour Absorbed',
    'OtherCurrentLiability',
    'other_current_liability',
    'Production labour cost absorbed into Work in Progress'
  );
  const spoilageVariance5100 = await ensureByCode(
    '5100',
    'Spoilage & Production Variance',
    'CostOfGoodsSold',
    'cost_of_goods_sold',
    'Production material waste, rework, and sunk WIP write-offs'
  );
  const machineOverhead6310 = await ensureByCode(
    '6310',
    'Machine Overhead Applied',
    'Expense',
    'expense',
    'Press and finishing machine click/running overhead absorbed to WIP'
  );

  return {
    ...base,
    undeposited1050,
    purchasesInTransit1210,
    wip1250,
    grni2055,
    directLabourAbsorbed2110,
    spoilageVariance5100,
    machineOverhead6310,
  };
}

/**
 * Exact 6-decimal parser for exchange rates and quantities.
 */
export function parseDecimal6(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value * 1000000n;
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!raw) return 0n;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) {
    throw new AccountingError(400, `Invalid numeric quantity/rate: "${raw}"`, 'INVALID_DECIMAL');
  }
  const neg = raw.startsWith('-');
  const unsigned = raw.replace(/^[+-]/, '');
  const [intRaw, fracRaw = ''] = unsigned.split('.');
  const intPart = BigInt(intRaw || '0');
  if (fracRaw.length <= 6) {
    const scaled = intPart * 1000000n + BigInt(fracRaw.padEnd(6, '0'));
    return neg ? -scaled : scaled;
  }
  const head6 = BigInt(fracRaw.slice(0, 6));
  const nextDigit = Number(fracRaw[6]);
  const restNonZero = /[1-9]/.test(fracRaw.slice(7));
  let rounded = head6;
  if (nextDigit > 5 || (nextDigit === 5 && (restNonZero || head6 % 2n === 1n))) {
    rounded += 1n;
  }
  const scaled = intPart * 1000000n + rounded;
  return neg ? -scaled : scaled;
}

export function formatDecimal6(scaled6: bigint): string {
  const neg = scaled6 < 0n;
  const abs = neg ? -scaled6 : scaled6;
  const whole = abs / 1000000n;
  const frac = (abs % 1000000n).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Exact BigInt rounding division: returns (numerator / denominator) rounded using HALF_EVEN or HALF_UP.
 */
export function divRoundBigInt(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'HALF_EVEN'
): bigint {
  if (denominator === 0n) throw new AccountingError(400, 'Division by zero in financial calculation');
  const neg = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const q = a / b;
  const r = a % b;
  const twiceR = r * 2n;
  let rounded = q;
  if (twiceR > b) {
    rounded += 1n;
  } else if (twiceR === b) {
    if (mode === 'HALF_UP' || q % 2n === 1n) {
      rounded += 1n;
    }
  }
  return neg ? -rounded : rounded;
}

/**
 * Multiplies a 6-decimal quantity (qty6) by a 4-decimal rate (rate4) -> exact 4-decimal monetary amount.
 */
export function multiplyQty6ByRate4(
  qty6: bigint,
  rate4: bigint,
  mode: RoundingMode = 'HALF_EVEN'
): bigint {
  return divRoundBigInt(qty6 * rate4, 1000000n, mode);
}

/**
 * Multiplies a 4-decimal foreign monetary amount by a 6-decimal FX rate -> exact 4-decimal base currency amount.
 */
export function convertForeign4ToBase4(
  foreign4: bigint,
  exchangeRate6: bigint,
  mode: RoundingMode = 'HALF_EVEN'
): bigint {
  return divRoundBigInt(foreign4 * exchangeRate6, 1000000n, mode);
}

/**
 * Computes tax4 = subtotal4 * taxRatePct / 100 using exact BigInt arithmetic.
 */
export function computeTax4(
  taxableSubtotal4: bigint,
  taxRatePct6: bigint,
  mode: RoundingMode = 'HALF_EVEN'
): bigint {
  if (taxableSubtotal4 <= 0n || taxRatePct6 <= 0n) return 0n;
  return divRoundBigInt(taxableSubtotal4 * taxRatePct6, 100000000n, mode);
}

export function assertIsoDate(value: unknown, fieldName: string): string {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new AccountingError(400, `${fieldName} must be formatted as YYYY-MM-DD`, 'INVALID_DATE');
  }
  return s;
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysToIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function advanceRecurringDate(
  dateIso: string,
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual'
): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  if (frequency === 'weekly') return addDaysToIso(dateIso, 7);
  if (frequency === 'biweekly') return addDaysToIso(dateIso, 14);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (frequency === 'monthly') dt.setUTCMonth(dt.getUTCMonth() + 1);
  else if (frequency === 'quarterly') dt.setUTCMonth(dt.getUTCMonth() + 3);
  else if (frequency === 'annual') dt.setUTCFullYear(dt.getUTCFullYear() + 1);
  return dt.toISOString().slice(0, 10);
}

export async function generateNextDocNumber(
  tx: Transaction,
  companyId: number,
  tableName: string,
  columnName: string,
  prefix: string
): Promise<string> {
  await tx.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [companyId]);
  const res = await tx.query<{ cnt: string }>(
    `SELECT (COUNT(*) + 1)::text AS cnt FROM ${tableName} WHERE company_id = $1`,
    [companyId]
  );
  let seq = Number(res.rows[0].cnt) + 1000;
  for (let i = 0; i < 40; i++) {
    const candidate = `${prefix}-${seq + i}`;
    const exists = await tx.query<{ id: number }>(
      `SELECT id FROM ${tableName} WHERE company_id = $1 AND ${columnName} = $2 LIMIT 1`,
      [companyId, candidate]
    );
    if (exists.rows.length === 0) return candidate;
  }
  return `${prefix}-${Date.now()}`;
}

export async function checkRouteIdempotency<T>(
  tx: Transaction,
  companyId: number,
  route: string,
  idempotencyKey: string | null | undefined,
  payload: unknown
): Promise<{ hit: true; statusCode: number; response: T } | { hit: false; payloadHash: string }> {
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if (!idempotencyKey || !idempotencyKey.trim()) {
    return { hit: false, payloadHash };
  }
  const cleanKey = idempotencyKey.trim().slice(0, 128);
  const existing = await tx.query<{
    payload_hash: string;
    status_code: number;
    response_json: T;
  }>(
    `SELECT payload_hash, status_code, response_json
       FROM request_keys
      WHERE company_id = $1 AND route = $2 AND idempotency_key = $3
      LIMIT 1`,
    [companyId, route, cleanKey]
  );
  if (existing.rows.length === 0) {
    return { hit: false, payloadHash };
  }
  const prev = existing.rows[0];
  if (prev.payload_hash !== payloadHash) {
    throw new AccountingError(
      409,
      `Idempotency key "${cleanKey}" was already used with a different request payload`,
      'IDEMPOTENCY_CONFLICT'
    );
  }
  return { hit: true, statusCode: Number(prev.status_code) || 200, response: prev.response_json };
}

export async function saveRouteIdempotency(
  tx: Transaction,
  companyId: number,
  route: string,
  idempotencyKey: string | null | undefined,
  payloadHash: string,
  statusCode: number,
  responseJson: unknown,
  actorUserId: number
): Promise<void> {
  if (!idempotencyKey || !idempotencyKey.trim()) return;
  const cleanKey = idempotencyKey.trim().slice(0, 128);
  await tx.query(
    `INSERT INTO request_keys (
       company_id, route, idempotency_key, payload_hash, status_code, response_json, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (company_id, route, idempotency_key) DO NOTHING`,
    [companyId, route, cleanKey, payloadHash, statusCode, JSON.stringify(responseJson), actorUserId]
  );
}

/**
 * Recomputes customer AR balance deterministically from posted non-voided invoices,
 * unapplied credit memos, and unapplied payment remainders.
 */
export async function recalculateCustomerBalance(
  tx: Transaction,
  companyId: number,
  customerId: number
): Promise<string> {
  const openInv = await tx.query<{ total_due: string }>(
    `SELECT COALESCE(SUM(balance_due), 0)::NUMERIC(19,4)::text AS total_due
       FROM invoices
      WHERE company_id = $1 AND customer_id = $2
        AND is_sales_receipt = FALSE
        AND status <> 'voided'`,
    [companyId, customerId]
  );
  const openCm = await tx.query<{ total_credit: string }>(
    `SELECT COALESCE(SUM(remaining_credit), 0)::NUMERIC(19,4)::text AS total_credit
       FROM credit_memos
      WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId]
  );
  const unappliedPmt = await tx.query<{ unapplied: string }>(
    `SELECT COALESCE(SUM(p.amount - COALESCE(alloc.alloc_sum, 0)), 0)::NUMERIC(19,4)::text AS unapplied
       FROM payments p
       LEFT JOIN (
         SELECT payment_id, SUM(amount) AS alloc_sum
           FROM payment_allocations
          WHERE company_id = $1
          GROUP BY payment_id
       ) alloc ON alloc.payment_id = p.id
      WHERE p.company_id = $1 AND p.customer_id = $2 AND p.is_voided = FALSE`,
    [companyId, customerId]
  );

  const net4 =
    parseDecimal4(openInv.rows[0].total_due) -
    parseDecimal4(openCm.rows[0].total_credit) -
    parseDecimal4(unappliedPmt.rows[0].unapplied);

  const formatted = formatDecimal4(net4);
  await tx.query(
    `UPDATE customers SET balance = $3::NUMERIC(19,4) WHERE company_id = $1 AND id = $2`,
    [companyId, customerId, formatted]
  );
  return formatted;
}

/**
 * Recomputes vendor AP balance deterministically from non-voided bills minus unapplied vendor credits.
 */
export async function recalculateVendorBalance(
  tx: Transaction,
  companyId: number,
  vendorId: number
): Promise<string> {
  const openBills = await tx.query<{ total_due: string }>(
    `SELECT COALESCE(SUM(balance_due), 0)::NUMERIC(19,4)::text AS total_due
       FROM bills
      WHERE company_id = $1 AND vendor_id = $2
        AND status <> 'voided'`,
    [companyId, vendorId]
  );
  const openVc = await tx.query<{ total_credit: string }>(
    `SELECT COALESCE(SUM(remaining_credit), 0)::NUMERIC(19,4)::text AS total_credit
       FROM vendor_credits
      WHERE company_id = $1 AND vendor_id = $2`,
    [companyId, vendorId]
  );
  const net4 = parseDecimal4(openBills.rows[0].total_due) - parseDecimal4(openVc.rows[0].total_credit);
  const formatted = formatDecimal4(net4);
  await tx.query(
    `UPDATE vendors SET balance = $3::NUMERIC(19,4) WHERE company_id = $1 AND id = $2`,
    [companyId, vendorId, formatted]
  );
  return formatted;
}

/**
 * Resolves FX rate for (currencyCode -> baseCurrency) on txnDate. Returns '1.000000' when matching baseCurrency.
 */
export async function resolveExchangeRate6(
  tx: Transaction,
  companyId: number,
  currencyCode: string | undefined | null,
  baseCurrency: string,
  txnDate: string,
  explicitRate?: string | number | null
): Promise<{ currencyCode: string; rate6: bigint; rateStr: string }> {
  const code = String(currencyCode || baseCurrency).trim().toUpperCase().slice(0, 3) || baseCurrency;
  if (code === baseCurrency) {
    return { currencyCode: baseCurrency, rate6: 1000000n, rateStr: '1.000000' };
  }
  if (explicitRate !== undefined && explicitRate !== null && explicitRate !== '') {
    const r6 = parseDecimal6(explicitRate);
    if (r6 <= 0n) throw new AccountingError(400, 'Exchange rate must be greater than zero', 'INVALID_FX_RATE');
    return { currencyCode: code, rate6: r6, rateStr: formatDecimal6(r6) };
  }
  const res = await tx.query<{ rate: string }>(
    `SELECT rate::text
       FROM exchange_rates
      WHERE company_id = $1 AND from_currency = $2 AND to_currency = $3 AND rate_date <= $4::DATE
      ORDER BY rate_date DESC, id DESC
      LIMIT 1`,
    [companyId, code, baseCurrency, txnDate]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(
      400,
      `No exchange rate configured for ${code} -> ${baseCurrency} on or before ${txnDate}`,
      'MISSING_FX_RATE'
    );
  }
  const r6 = parseDecimal6(res.rows[0].rate);
  return { currencyCode: code, rate6: r6, rateStr: formatDecimal6(r6) };
}
