import crypto from 'node:crypto';
import { Transaction } from '@electric-sql/pglite';
import { writeAuditLog } from '../audit.ts';
import { CompanyRole } from '../permissions.ts';
import {
  absBigInt,
  formatDecimal4,
  parseDecimal4,
  RoundingMode,
  toMoneyNumber,
} from '../lib/decimal.ts';

export class AccountingError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = 'ACCOUNTING_ERROR'
  ) {
    super(message);
    this.name = 'AccountingError';
  }
}

export const ALL_ACCOUNT_TYPES = [
  'Bank',
  'AccountsReceivable',
  'OtherCurrentAsset',
  'Inventory',
  'FixedAsset',
  'AccountsPayable',
  'CreditCard',
  'OtherCurrentLiability',
  'PayrollLiability',
  'LongTermLiability',
  'Equity',
  'Income',
  'CostOfGoodsSold',
  'Expense',
  'OtherExpense',
] as const;

export type AccountType = (typeof ALL_ACCOUNT_TYPES)[number];

export const DEBIT_NORMAL_TYPES = new Set<AccountType>([
  'Bank',
  'AccountsReceivable',
  'OtherCurrentAsset',
  'Inventory',
  'FixedAsset',
  'CostOfGoodsSold',
  'Expense',
  'OtherExpense',
]);

export const CREDIT_NORMAL_TYPES = new Set<AccountType>([
  'AccountsPayable',
  'CreditCard',
  'OtherCurrentLiability',
  'PayrollLiability',
  'LongTermLiability',
  'Equity',
  'Income',
]);

export const BALANCE_SHEET_TYPES = new Set<AccountType>([
  'Bank',
  'AccountsReceivable',
  'OtherCurrentAsset',
  'Inventory',
  'FixedAsset',
  'AccountsPayable',
  'CreditCard',
  'OtherCurrentLiability',
  'PayrollLiability',
  'LongTermLiability',
  'Equity',
]);

export const PL_TYPES = new Set<AccountType>([
  'Income',
  'CostOfGoodsSold',
  'Expense',
  'OtherExpense',
]);

export const ALL_DETAIL_TYPES = [
  'bank',
  'accounts_receivable',
  'other_current_asset',
  'fixed_asset',
  'other_asset',
  'accounts_payable',
  'credit_card',
  'other_current_liability',
  'payroll_liabilities',
  'long_term_liability',
  'equity',
  'income',
  'other_income',
  'cost_of_goods_sold',
  'expense',
  'other_expense',
] as const;

export type DetailType = (typeof ALL_DETAIL_TYPES)[number];

const DEFAULT_DETAIL_BY_TYPE: Record<AccountType, DetailType> = {
  Bank: 'bank',
  AccountsReceivable: 'accounts_receivable',
  OtherCurrentAsset: 'other_current_asset',
  Inventory: 'other_current_asset',
  FixedAsset: 'fixed_asset',
  AccountsPayable: 'accounts_payable',
  CreditCard: 'credit_card',
  OtherCurrentLiability: 'other_current_liability',
  PayrollLiability: 'payroll_liabilities',
  LongTermLiability: 'long_term_liability',
  Equity: 'equity',
  Income: 'income',
  CostOfGoodsSold: 'cost_of_goods_sold',
  Expense: 'expense',
  OtherExpense: 'other_expense',
};

const DETAIL_COMPATIBLE_TYPES: Record<DetailType, AccountType[]> = {
  bank: ['Bank'],
  accounts_receivable: ['AccountsReceivable'],
  other_current_asset: ['OtherCurrentAsset', 'Inventory'],
  fixed_asset: ['FixedAsset'],
  other_asset: ['OtherCurrentAsset', 'FixedAsset'],
  accounts_payable: ['AccountsPayable'],
  credit_card: ['CreditCard'],
  other_current_liability: ['OtherCurrentLiability'],
  payroll_liabilities: ['PayrollLiability', 'OtherCurrentLiability'],
  long_term_liability: ['LongTermLiability'],
  equity: ['Equity'],
  income: ['Income'],
  other_income: ['Income'],
  cost_of_goods_sold: ['CostOfGoodsSold'],
  expense: ['Expense'],
  other_expense: ['Expense', 'OtherExpense'],
};

/**
 * SlowBooks Control Accounts Registry: prevents hijacking or renumbering core system control codes.
 */
export const CONTROL_ACCOUNTS: Record<string, { name: string; accountType: AccountType; purpose: string }> = {
  '1010': { name: 'Operating Checking', accountType: 'Bank', purpose: 'primary bank deposits & disbursements' },
  '1100': { name: 'Accounts Receivable', accountType: 'AccountsReceivable', purpose: 'customer invoices & payments' },
  '1200': { name: 'Inventory Asset', accountType: 'Inventory', purpose: 'raw materials and stocked stationery' },
  '2000': { name: 'Accounts Payable', accountType: 'AccountsPayable', purpose: 'vendor bills and bill payments' },
  '2200': { name: 'Sales Tax Payable', accountType: 'OtherCurrentLiability', purpose: 'collected sales tax' },
  '2300': { name: 'Unearned Contract Retainers', accountType: 'OtherCurrentLiability', purpose: 'prepaid printing contracts' },
  '3200': { name: 'Retained Earnings', accountType: 'Equity', purpose: 'accumulated earnings & period closing' },
  '3900': { name: 'Opening Balance Equity', accountType: 'Equity', purpose: 'opening balance offset' },
  '4000': { name: 'Printing & Sales Revenue', accountType: 'Income', purpose: 'default printing and sales revenue' },
  '5000': { name: 'Cost of Goods Sold', accountType: 'CostOfGoodsSold', purpose: 'direct material and production cost' },
};

export type JournalSourceType =
  | 'manual'
  | 'invoice'
  | 'sales_receipt'
  | 'pos_sale'
  | 'payment'
  | 'credit_memo'
  | 'bill'
  | 'bill_payment'
  | 'vendor_credit'
  | 'deposit'
  | 'transfer'
  | 'check'
  | 'expense'
  | 'credit_card_charge'
  | 'bank_import'
  | 'payroll'
  | 'reconciliation'
  | 'inventory_adjustment'
  | 'inventory_damage'
  | 'stock_count'
  | 'depreciation'
  | 'printing_contract'
  | 'quick_print'
  | 'exam_production'
  | 'referral_reward'
  | 'marketing_expense'
  | 'opening_balance'
  | 'reversal'
  | 'closing_entry'
  | 'fx_gain_loss'
  | 'goods_receipt'
  | 'production_wip'
  | 'production_cogs'
  | 'production_variance'
  | 'customer_wallet';

export type LedgerBasis = 'both' | 'accrual' | 'cash';

export interface ActorContext {
  userId: number;
  username: string;
  role: CompanyRole;
}

export interface AccountRow {
  id: number;
  company_id: number;
  code: string | null;
  name: string;
  account_type: AccountType;
  detail_type: DetailType;
  bank_kind: 'bank' | 'credit_card' | null;
  description: string | null;
  parent_id: number | null;
  normal_balance: 'debit' | 'credit';
  is_system: boolean;
  is_control: boolean;
  is_contra: boolean;
  is_active: boolean;
  balance: string;
  created_at: string;
  updated_at: string;
}

export function normalBalanceFor(accountType: AccountType, isContra: boolean = false): 'debit' | 'credit' {
  const base = DEBIT_NORMAL_TYPES.has(accountType) ? 'debit' : 'credit';
  if (!isContra) return base;
  return base === 'debit' ? 'credit' : 'debit';
}
export function naturalDelta4(accountType: AccountType, debit4: bigint, credit4: bigint): bigint {
  return DEBIT_NORMAL_TYPES.has(accountType) ? debit4 - credit4 : credit4 - debit4;
}

function validateAccountCode(code: string | null | undefined): string | null {
  if (!code || !code.trim()) return null;
  const trimmed = code.trim();
  if (trimmed.length > 32 || !/^\d+(?:[.-]\d+)*$/.test(trimmed)) {
    throw new AccountingError(
      400,
      `"${trimmed}" is not a valid account number. Use digits like 6150, or 6150.1 / 6150-01 for sub-accounts.`,
      'INVALID_ACCOUNT_CODE'
    );
  }
  return trimmed;
}

function resolveDetailType(
  accountType: AccountType,
  requestedDetail?: string | null,
  bankKind?: 'bank' | 'credit_card' | null
): DetailType {
  if (bankKind === 'bank') {
    if (accountType !== 'Bank') {
      throw new AccountingError(400, `bank_kind 'bank' requires account_type 'Bank'`, 'INVALID_BANK_KIND');
    }
    if (requestedDetail && requestedDetail !== 'bank') {
      throw new AccountingError(400, `A bank account must use detail_type 'bank'`, 'INVALID_DETAIL_TYPE');
    }
    return 'bank';
  }
  if (bankKind === 'credit_card') {
    if (accountType !== 'CreditCard') {
      throw new AccountingError(
        400,
        `bank_kind 'credit_card' requires account_type 'CreditCard'`,
        'INVALID_BANK_KIND'
      );
    }
    if (requestedDetail && requestedDetail !== 'credit_card') {
      throw new AccountingError(
        400,
        `A credit card account must use detail_type 'credit_card'`,
        'INVALID_DETAIL_TYPE'
      );
    }
    return 'credit_card';
  }

  if (!requestedDetail) {
    return DEFAULT_DETAIL_BY_TYPE[accountType];
  }
  const dt = requestedDetail as DetailType;
  const allowed = DETAIL_COMPATIBLE_TYPES[dt];
  if (!allowed) {
    throw new AccountingError(400, `Unknown detail_type '${requestedDetail}'`, 'INVALID_DETAIL_TYPE');
  }
  if (!allowed.includes(accountType)) {
    throw new AccountingError(
      400,
      `detail_type '${dt}' is incompatible with account_type '${accountType}'`,
      'INVALID_DETAIL_TYPE'
    );
  }
  return dt;
}

async function assertParentValid(
  tx: Transaction,
  companyId: number,
  accountId: number | null,
  parentId: number | null
): Promise<void> {
  if (parentId === null) return;
  if (accountId !== null && parentId === accountId) {
    throw new AccountingError(400, 'An account cannot be its own parent', 'ACCOUNT_PARENT_LOOP');
  }

  let cursor: number | null = parentId;
  const visited = new Set<number>();
  if (accountId !== null) visited.add(accountId);

  let depth = 0;
  while (cursor !== null) {
    if (visited.has(cursor)) {
      throw new AccountingError(400, 'Parent account hierarchy cannot contain a cycle', 'ACCOUNT_PARENT_LOOP');
    }
    visited.add(cursor);
    depth += 1;
    if (depth >= 5) {
      throw new AccountingError(400, 'Account hierarchy depth cannot exceed 5 levels', 'ACCOUNT_MAX_DEPTH');
    }

    const r: { rows: Array<{ id: number; parent_id: number | null; is_active: boolean }> } = await tx.query<{
      id: number;
      parent_id: number | null;
      is_active: boolean;
    }>(
      `SELECT id, parent_id, is_active FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, cursor]
    );
    if (r.rows.length === 0) {
      throw new AccountingError(400, `Parent account ${cursor} not found in company`, 'PARENT_NOT_FOUND');
    }
    if (cursor === parentId && !r.rows[0].is_active) {
      throw new AccountingError(400, 'Inactive parent account cannot take sub-accounts', 'INACTIVE_PARENT');
    }
    cursor = r.rows[0].parent_id !== null ? Number(r.rows[0].parent_id) : null;
  }
}

export async function getCompanyAccountingPrefs(
  tx: Transaction,
  companyId: number
): Promise<{
  roundingMode: RoundingMode;
  fiscalYearStartMonth: number;
  accountingMethod: 'accrual' | 'cash';
  currencySymbol: string;
}> {
  const res = await tx.query<{
    rounding_mode: string;
    fiscal_year_start_month: number;
    accounting_method: string;
    currency_symbol: string;
  }>(
    `SELECT rounding_mode, fiscal_year_start_month, accounting_method, currency_symbol
       FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  );
  if (res.rows.length === 0) {
    return {
      roundingMode: 'HALF_EVEN',
      fiscalYearStartMonth: 1,
      accountingMethod: 'accrual',
      currencySymbol: 'K',
    };
  }
  const r = res.rows[0];
  return {
    roundingMode: r.rounding_mode === 'HALF_UP' ? 'HALF_UP' : 'HALF_EVEN',
    fiscalYearStartMonth: Number(r.fiscal_year_start_month) || 1,
    accountingMethod: r.accounting_method === 'cash' ? 'cash' : 'accrual',
    currencySymbol: r.currency_symbol || 'K',
  };
}

export async function listAccounts(
  tx: Transaction,
  companyId: number,
  options: { includeInactive?: boolean; sort?: 'code' | 'name' } = {}
): Promise<AccountRow[]> {
  const whereClause = options.includeInactive ? 'WHERE company_id = $1' : 'WHERE company_id = $1 AND is_active = TRUE';
  const orderClause =
    options.sort === 'name'
      ? 'ORDER BY LOWER(name) ASC, code ASC NULLS LAST'
      : 'ORDER BY CASE WHEN code IS NULL THEN 1 ELSE 0 END, code ASC, LOWER(name) ASC';

  const res = await tx.query<AccountRow>(
    `SELECT id, company_id, code, name, account_type, detail_type, bank_kind,
            description, parent_id, normal_balance, is_system, is_control, is_contra, is_active,
            balance::text, created_at::text, updated_at::text
       FROM accounts
      ${whereClause}
      ${orderClause}`,
    [companyId]
  );
  return res.rows.map(r => ({
    ...r,
    id: Number(r.id),
    company_id: Number(r.company_id),
    parent_id: r.parent_id !== null ? Number(r.parent_id) : null,
  }));
}
export async function createAccount(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    code?: string | null;
    name: string;
    accountType: AccountType;
    detailType?: string | null;
    bankKind?: 'bank' | 'credit_card' | null;
    description?: string | null;
    parentId?: number | null;
    isContra?: boolean;
  }
): Promise<AccountRow> {
  const name = String(input.name || '').trim();
  if (!name) {
    throw new AccountingError(400, 'Account name is required', 'MISSING_ACCOUNT_NAME');
  }
  if (!ALL_ACCOUNT_TYPES.includes(input.accountType)) {
    throw new AccountingError(400, `Invalid account type '${input.accountType}'`, 'INVALID_ACCOUNT_TYPE');
  }

  const isContra = Boolean(input.isContra);
  const code = validateAccountCode(input.code);
  const bankKind =
    input.bankKind ??
    (input.accountType === 'Bank' ? 'bank' : input.accountType === 'CreditCard' ? 'credit_card' : null);
  const detailType = resolveDetailType(input.accountType, input.detailType, bankKind);
  const normalBalance = normalBalanceFor(input.accountType, isContra);
  const parentId = input.parentId ? Number(input.parentId) : null;

  if (code) {
    const reserved = CONTROL_ACCOUNTS[code];
    if (reserved && (reserved.name.toLowerCase() !== name.toLowerCase() || reserved.accountType !== input.accountType)) {
      throw new AccountingError(
        409,
        `Account code ${code} is reserved for control account "${reserved.name}" (${reserved.accountType}).`,
        'RESERVED_CONTROL_CODE'
      );
    }

    const dup = await tx.query<{ id: number; name: string }>(
      `SELECT id, name FROM accounts WHERE company_id = $1 AND LOWER(code) = LOWER($2) LIMIT 1`,
      [companyId, code]
    );
    if (dup.rows.length > 0) {
      throw new AccountingError(
        409,
        `Account code ${code} is already used by "${dup.rows[0].name}".`,
        'DUPLICATE_ACCOUNT_CODE'
      );
    }
  }

  await assertParentValid(tx, companyId, null, parentId);

  const isControl = Boolean(code && CONTROL_ACCOUNTS[code]);

  const ins = await tx.query<AccountRow>(
    `INSERT INTO accounts (
       company_id, code, name, account_type, detail_type, bank_kind,
       description, parent_id, normal_balance, is_system, is_control, is_contra, is_active, balance
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, $10, $11, TRUE, 0.0000)
     RETURNING id, company_id, code, name, account_type, detail_type, bank_kind,
               description, parent_id, normal_balance, is_system, is_control, is_contra, is_active,
               balance::text, created_at::text, updated_at::text`,
    [
      companyId,
      code,
      name,
      input.accountType,
      detailType,
      bankKind,
      input.description?.trim() || null,
      parentId,
      normalBalance,
      isControl,
      isContra,
    ]
  );

  const created = {
    ...ins.rows[0],
    id: Number(ins.rows[0].id),
    company_id: Number(ins.rows[0].company_id),
    parent_id: ins.rows[0].parent_id !== null ? Number(ins.rows[0].parent_id) : null,
  };

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'ACCOUNT_CREATED',
    tableName: 'accounts',
    recordId: created.id,
    newValues: { code: created.code, name: created.name, accountType: created.account_type, detailType },
  });

  return created;
}

export async function updateAccount(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  accountId: number,
  updates: {
    code?: string | null;
    name?: string;
    description?: string | null;
    parentId?: number | null;
    detailType?: string | null;
    isActive?: boolean;
    isContra?: boolean;
  }
): Promise<AccountRow> {
  const existingRes = await tx.query<AccountRow>(
    `SELECT id, company_id, code, name, account_type, detail_type, bank_kind,
            description, parent_id, normal_balance, is_system, is_control, is_contra, is_active,
            balance::text, created_at::text, updated_at::text
       FROM accounts WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, accountId]
  );
  if (existingRes.rows.length === 0) {
    throw new AccountingError(404, 'Account not found in active company', 'ACCOUNT_NOT_FOUND');
  }
  const existing = existingRes.rows[0];
  const nextName = updates.name !== undefined ? updates.name.trim() : existing.name;
  if (!nextName) {
    throw new AccountingError(400, 'Account name cannot be empty', 'INVALID_ACCOUNT_NAME');
  }

  let nextCode = existing.code;
  if (updates.code !== undefined) {
    nextCode = validateAccountCode(updates.code);
    if (existing.is_control && nextCode !== existing.code) {
      throw new AccountingError(
        409,
        `Control account "${existing.name}" (${existing.code}) cannot be renumbered.`,
        'CONTROL_ACCOUNT_LOCKED'
      );
    }
    if (nextCode) {
      const reserved = CONTROL_ACCOUNTS[nextCode];
      if (
        reserved &&
        (reserved.name.toLowerCase() !== nextName.toLowerCase() || reserved.accountType !== existing.account_type)
      ) {
        throw new AccountingError(
          409,
          `Account code ${nextCode} is reserved for "${reserved.name}".`,
          'RESERVED_CONTROL_CODE'
        );
      }
      const dup = await tx.query<{ id: number; name: string }>(
        `SELECT id, name FROM accounts WHERE company_id = $1 AND LOWER(code) = LOWER($2) AND id <> $3 LIMIT 1`,
        [companyId, nextCode, accountId]
      );
      if (dup.rows.length > 0) {
        throw new AccountingError(409, `Account code ${nextCode} is already in use.`, 'DUPLICATE_ACCOUNT_CODE');
      }
    }
  }

  const nextParentId = updates.parentId !== undefined ? (updates.parentId ? Number(updates.parentId) : null) : existing.parent_id;
  if (nextParentId !== existing.parent_id) {
    await assertParentValid(tx, companyId, accountId, nextParentId);
  }

  const nextDetailType =
    updates.detailType !== undefined
      ? resolveDetailType(existing.account_type, updates.detailType, existing.bank_kind)
      : existing.detail_type;

  const nextIsActive = updates.isActive !== undefined ? updates.isActive : existing.is_active;
  if (!nextIsActive && existing.is_active) {
    if (existing.is_system || existing.is_control) {
      throw new AccountingError(409, 'System and control accounts cannot be deactivated.', 'SYSTEM_ACCOUNT_LOCKED');
    }
    if (parseDecimal4(existing.balance) !== 0n) {
      throw new AccountingError(
        409,
        'Cannot deactivate an account with a non-zero balance. Clear or transfer the balance first.',
        'NONZERO_BALANCE'
      );
    }
  }

  const upd = await tx.query<AccountRow>(
    `UPDATE accounts
        SET code = $3,
            name = $4,
            description = $5,
            parent_id = $6,
            detail_type = $7,
            is_active = $8
      WHERE company_id = $1 AND id = $2
      RETURNING id, company_id, code, name, account_type, detail_type, bank_kind,
                description, parent_id, normal_balance, is_system, is_control, is_contra, is_active,
                balance::text, created_at::text, updated_at::text`,
    [
      companyId,
      accountId,
      nextCode,
      nextName,
      updates.description !== undefined ? updates.description?.trim() || null : existing.description,
      nextParentId,
      nextDetailType,
      nextIsActive,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'ACCOUNT_UPDATED',
    tableName: 'accounts',
    recordId: accountId,
    oldValues: { code: existing.code, name: existing.name, isActive: existing.is_active, detailType: existing.detail_type },
    newValues: { code: nextCode, name: nextName, isActive: nextIsActive, detailType: nextDetailType },
  });

  return {
    ...upd.rows[0],
    id: Number(upd.rows[0].id),
    company_id: Number(upd.rows[0].company_id),
    parent_id: upd.rows[0].parent_id !== null ? Number(upd.rows[0].parent_id) : null,
  };
}

/**
 * SlowBooks atomic SQL balance updates in ascending account_id order to prevent row-lock deadlocks
 * and eliminate read-modify-write lost updates under concurrent transactions.
 */
export async function applyBalanceDeltas(
  tx: Transaction,
  companyId: number,
  deltas: Map<number, bigint>
): Promise<void> {
  const orderedIds = Array.from(deltas.keys())
    .filter(id => deltas.get(id) !== 0n)
    .sort((a, b) => a - b);

  for (const accountId of orderedIds) {
    const delta = deltas.get(accountId)!;
    await tx.query(
      `UPDATE accounts
          SET balance = COALESCE(balance, 0) + $3::NUMERIC(19, 4)
        WHERE company_id = $1 AND id = $2`,
      [companyId, accountId, formatDecimal4(delta)]
    );
  }
}

/**
 * SlowBooks rebuild_stored_balances: recomputes every account's balance directly from posted accrual/both
 * journal lines and corrects any drift inside an atomic transaction.
 */
export async function rebuildStoredBalances(
  tx: Transaction,
  companyId: number,
  actor: ActorContext
): Promise<{
  checkedCount: number;
  correctedCount: number;
  corrections: Array<{ accountId: number; code: string | null; name: string; previous: string; rebuilt: string }>;
}> {
  const acctsRes = await tx.query<{
    id: number;
    code: string | null;
    name: string;
    account_type: AccountType;
    balance: string;
  }>(
    `SELECT id, code, name, account_type, balance::text
       FROM accounts
      WHERE company_id = $1
      ORDER BY id ASC
      FOR UPDATE`,
    [companyId]
  );

  const sumsRes = await tx.query<{ account_id: number; dr: string; cr: string }>(
    `SELECT jl.account_id,
            COALESCE(SUM(jl.debit), 0)::NUMERIC(19,4)::text AS dr,
            COALESCE(SUM(jl.credit), 0)::NUMERIC(19,4)::text AS cr
       FROM journal_lines jl
       JOIN journal_transactions jt
         ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
      WHERE jl.company_id = $1
        AND jt.is_posted = TRUE
       
        AND jl.basis IN ('both', 'accrual')
      GROUP BY jl.account_id`,
    [companyId]
  );

  const ledgerByAcct = new Map<number, { dr: bigint; cr: bigint }>();
  for (const r of sumsRes.rows) {
    ledgerByAcct.set(Number(r.account_id), {
      dr: parseDecimal4(r.dr),
      cr: parseDecimal4(r.cr),
    });
  }

  const corrections: Array<{
    accountId: number;
    code: string | null;
    name: string;
    previous: string;
    rebuilt: string;
  }> = [];

  for (const acct of acctsRes.rows) {
    const id = Number(acct.id);
    const sums = ledgerByAcct.get(id) ?? { dr: 0n, cr: 0n };
    const expected4 = naturalDelta4(acct.account_type, sums.dr, sums.cr);
    const stored4 = parseDecimal4(acct.balance);
    if (expected4 !== stored4) {
      const rebuiltStr = formatDecimal4(expected4);
      await tx.query(
        `UPDATE accounts SET balance = $3::NUMERIC(19,4) WHERE company_id = $1 AND id = $2`,
        [companyId, id, rebuiltStr]
      );
      corrections.push({
        accountId: id,
        code: acct.code,
        name: acct.name,
        previous: formatDecimal4(stored4),
        rebuilt: rebuiltStr,
      });
    }
  }

  if (corrections.length > 0) {
    await writeAuditLog(tx, {
      companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'ACCOUNT_BALANCES_REBUILT',
      tableName: 'accounts',
      recordId: companyId,
      newValues: { correctedCount: corrections.length, corrections },
    });
  }

  return {
    checkedCount: acctsRes.rows.length,
    correctedCount: corrections.length,
    corrections,
  };
}

// ============================================================================
// FISCAL PERIODS & CLOSING LOCKS
// ============================================================================

export interface FiscalPeriodRow {
  id: number;
  company_id: number;
  period_name: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'soft_closed' | 'closed';
  closed_by: number | null;
  closed_at: string | null;
  closing_txn_id: number | null;
  notes: string | null;
  reopened_by: number | null;
  reopened_at: string | null;
}

export async function listFiscalPeriods(tx: Transaction, companyId: number): Promise<FiscalPeriodRow[]> {
  const res = await tx.query<FiscalPeriodRow>(
    `SELECT id, company_id, period_name, start_date::text, end_date::text, status,
            closed_by, closed_at::text, closing_txn_id, notes, reopened_by, reopened_at::text
       FROM fiscal_periods
      WHERE company_id = $1
      ORDER BY start_date DESC, id DESC`,
    [companyId]
  );
  return res.rows.map(r => ({
    ...r,
    id: Number(r.id),
    company_id: Number(r.company_id),
    closed_by: r.closed_by !== null ? Number(r.closed_by) : null,
    closing_txn_id: r.closing_txn_id !== null ? Number(r.closing_txn_id) : null,
    reopened_by: r.reopened_by !== null ? Number(r.reopened_by) : null,
  }));
}

export async function createFiscalPeriod(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { periodName: string; startDate: string; endDate: string; notes?: string | null }
): Promise<FiscalPeriodRow> {
  const periodName = String(input.periodName || '').trim();
  const startDate = String(input.startDate || '').trim();
  const endDate = String(input.endDate || '').trim();
  if (!periodName || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new AccountingError(400, 'periodName, startDate (YYYY-MM-DD), and endDate (YYYY-MM-DD) are required');
  }
  if (endDate < startDate) {
    throw new AccountingError(400, 'endDate must be on or after startDate');
  }

  const overlap = await tx.query<{ period_name: string }>(
    `SELECT period_name
       FROM fiscal_periods
      WHERE company_id = $1
        AND NOT (end_date < $2::DATE OR start_date > $3::DATE)
      LIMIT 1`,
    [companyId, startDate, endDate]
  );
  if (overlap.rows.length > 0) {
    throw new AccountingError(
      409,
      `Date range overlaps existing fiscal period "${overlap.rows[0].period_name}"`,
      'PERIOD_OVERLAP'
    );
  }

  const ins = await tx.query<FiscalPeriodRow>(
    `INSERT INTO fiscal_periods (company_id, period_name, start_date, end_date, status, notes)
     VALUES ($1, $2, $3::DATE, $4::DATE, 'open', $5)
     RETURNING id, company_id, period_name, start_date::text, end_date::text, status,
               closed_by, closed_at::text, closing_txn_id, notes, reopened_by, reopened_at::text`,
    [companyId, periodName, startDate, endDate, input.notes?.trim() || null]
  );

  const row = { ...ins.rows[0], id: Number(ins.rows[0].id), company_id: Number(ins.rows[0].company_id) };

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PERIOD_CREATED',
    tableName: 'fiscal_periods',
    recordId: row.id,
    newValues: { periodName, startDate, endDate },
  });

  return row;
}

export async function assertPeriodOpenForDate(
  tx: Transaction,
  companyId: number,
  txnDate: string,
  options: { isAdjusting?: boolean; allowSoftClosed?: boolean } = {}
): Promise<void> {
  const periodRes = await tx.query<{ id: number; period_name: string; status: string }>(
    `SELECT id, period_name, status
       FROM fiscal_periods
      WHERE company_id = $1
        AND $2::DATE BETWEEN start_date AND end_date
      LIMIT 1`,
    [companyId, txnDate]
  );
  if (periodRes.rows.length > 0) {
    const p = periodRes.rows[0];
    if (p.status === 'closed') {
      throw new AccountingError(
        403,
        `Transaction date ${txnDate} falls in closed fiscal period "${p.period_name}". Modifications to closed periods are not allowed.`,
        'PERIOD_CLOSED'
      );
    }
    if (p.status === 'soft_closed' && !options.isAdjusting && !options.allowSoftClosed) {
      throw new AccountingError(
        403,
        `Fiscal period "${p.period_name}" is soft-closed. Only adjusting entries are permitted.`,
        'PERIOD_SOFT_CLOSED'
      );
    }
  }

  // Also honor SlowBooks closing_date setting if configured
  const settingRes = await tx.query<{ setting_value: string | null }>(
    `SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = 'closing_date' LIMIT 1`,
    [companyId]
  );
  const closingDate = settingRes.rows[0]?.setting_value;
  if (closingDate && /^\d{4}-\d{2}-\d{2}$/.test(closingDate) && txnDate <= closingDate) {
    throw new AccountingError(
      403,
      `Transaction date ${txnDate} is on or before the company closing date (${closingDate}).`,
      'CLOSING_DATE_LOCK'
    );
  }
}

export async function softCloseFiscalPeriod(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  periodId: number
): Promise<FiscalPeriodRow> {
  const res = await tx.query<FiscalPeriodRow>(
    `SELECT id, period_name, status FROM fiscal_periods WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, periodId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Fiscal period not found', 'PERIOD_NOT_FOUND');
  }
  if (res.rows[0].status === 'closed') {
    throw new AccountingError(409, 'Period is already hard-closed; reopen first to soft-close', 'PERIOD_CLOSED');
  }

  const upd = await tx.query<FiscalPeriodRow>(
    `UPDATE fiscal_periods
        SET status = 'soft_closed'
      WHERE company_id = $1 AND id = $2
      RETURNING id, company_id, period_name, start_date::text, end_date::text, status,
                closed_by, closed_at::text, closing_txn_id, notes, reopened_by, reopened_at::text`,
    [companyId, periodId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PERIOD_SOFT_CLOSED',
    tableName: 'fiscal_periods',
    recordId: periodId,
    oldValues: { status: res.rows[0].status },
    newValues: { status: 'soft_closed' },
  });

  return { ...upd.rows[0], id: Number(upd.rows[0].id), company_id: Number(upd.rows[0].company_id) };
}

export async function closeFiscalPeriod(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  periodId: number,
  options: {
    generateClosingEntry?: boolean;
    retainedEarningsAccountId?: number;
    notes?: string;
  } = {}
): Promise<{ period: FiscalPeriodRow; closingTransactionId: number | null }> {
  const res = await tx.query<FiscalPeriodRow>(
    `SELECT id, company_id, period_name, start_date::text, end_date::text, status, closing_txn_id
       FROM fiscal_periods
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, periodId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Fiscal period not found', 'PERIOD_NOT_FOUND');
  }
  const period = res.rows[0];
  if (period.status === 'closed') {
    throw new AccountingError(409, `Fiscal period "${period.period_name}" is already closed.`, 'PERIOD_ALREADY_CLOSED');
  }

  let closingTxnId: number | null = null;

  if (options.generateClosingEntry) {
    // Resolve Retained Earnings (target equity account or code 3200 / 3000)
    let equityAccountId = options.retainedEarningsAccountId ? Number(options.retainedEarningsAccountId) : null;
    if (equityAccountId) {
      const eqRes = await tx.query<{ id: number; account_type: string }>(
        `SELECT id, account_type FROM accounts WHERE company_id = $1 AND id = $2 AND is_active = TRUE LIMIT 1`,
        [companyId, equityAccountId]
      );
      if (eqRes.rows.length === 0 || eqRes.rows[0].account_type !== 'Equity') {
        throw new AccountingError(400, 'Closing target account must be an active Equity account', 'INVALID_CLOSING_ACCOUNT');
      }
    } else {
      const reRes = await tx.query<{ id: number }>(
        `SELECT id FROM accounts
          WHERE company_id = $1 AND account_type = 'Equity' AND is_active = TRUE
          ORDER BY CASE WHEN code = '3200' THEN 0 WHEN LOWER(name) LIKE '%retained%' THEN 1 ELSE 2 END, id ASC
          LIMIT 1`,
        [companyId]
      );
      if (reRes.rows.length === 0) {
        const createdRe = await createAccount(tx, companyId, actor, {
          code: '3200',
          name: 'Retained Earnings',
          accountType: 'Equity',
          detailType: 'equity',
          description: 'Accumulated earnings closed from fiscal periods',
        });
        equityAccountId = createdRe.id;
      } else {
        equityAccountId = Number(reRes.rows[0].id);
      }
    }

    // Aggregate P&L lines in [start_date, end_date] on accrual/both basis
    const plActivity = await tx.query<{
      account_id: number;
      account_name: string;
      account_type: AccountType;
      dr: string;
      cr: string;
    }>(
      `SELECT a.id AS account_id,
              a.name AS account_name,
              a.account_type,
              COALESCE(SUM(jl.debit), 0)::NUMERIC(19,4)::text AS dr,
              COALESCE(SUM(jl.credit), 0)::NUMERIC(19,4)::text AS cr
         FROM accounts a
         JOIN journal_lines jl
           ON jl.company_id = a.company_id AND jl.account_id = a.id
         JOIN journal_transactions jt
           ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
        WHERE a.company_id = $1
          AND a.account_type IN ('Income', 'CostOfGoodsSold', 'Expense', 'OtherExpense')
          AND jt.is_posted = TRUE
         
          AND jt.txn_date BETWEEN $2::DATE AND $3::DATE
          AND jl.basis IN ('both', 'accrual')
        GROUP BY a.id, a.name, a.account_type
        ORDER BY a.id ASC`,
      [companyId, period.start_date, period.end_date]
    );

    const closingLines: JournalLineInput[] = [];
    let netTransferToEquity4 = 0n; // positive = credit to Retained Earnings (net income)

    for (const row of plActivity.rows) {
      const dr = parseDecimal4(row.dr);
      const cr = parseDecimal4(row.cr);
      const netCrMinusDr = cr - dr;
      if (netCrMinusDr === 0n) continue;

      if (netCrMinusDr > 0n) {
        // Account has net credit (typical Income): debit it to zero
        closingLines.push({
          accountId: Number(row.account_id),
          debit: formatDecimal4(netCrMinusDr),
          credit: '0.0000',
          description: `Close ${row.account_name} for ${period.period_name}`,
        });
      } else {
        // Account has net debit (typical COGS/Expense): credit it to zero
        closingLines.push({
          accountId: Number(row.account_id),
          debit: '0.0000',
          credit: formatDecimal4(-netCrMinusDr),
          description: `Close ${row.account_name} for ${period.period_name}`,
        });
      }
      netTransferToEquity4 += netCrMinusDr;
    }

    if (closingLines.length > 0 && netTransferToEquity4 !== 0n) {
      closingLines.push({
        accountId: equityAccountId,
        debit: netTransferToEquity4 < 0n ? formatDecimal4(-netTransferToEquity4) : '0.0000',
        credit: netTransferToEquity4 > 0n ? formatDecimal4(netTransferToEquity4) : '0.0000',
        description: `Transfer Net ${netTransferToEquity4 >= 0n ? 'Income' : 'Loss'} to Retained Earnings (${period.period_name})`,
      });

      const postedClose = await postJournalEntry(tx, companyId, actor, {
        txnDate: period.end_date,
        description: `Period Close Entry — ${period.period_name}`,
        reference: `CLOSE-${period.end_date}`,
        sourceType: 'closing_entry',
        sourceId: periodId,
        isAdjusting: true,
        idempotencyKey: `period-close-${companyId}-${periodId}-${period.end_date}`,
        lines: closingLines,
      });
      closingTxnId = postedClose.transaction.id;
    }
  }

  const upd = await tx.query<FiscalPeriodRow>(
    `UPDATE fiscal_periods
        SET status = 'closed',
            closed_by = $3,
            closed_at = NOW(),
            closing_txn_id = COALESCE($4, closing_txn_id),
            notes = COALESCE($5, notes)
      WHERE company_id = $1 AND id = $2
      RETURNING id, company_id, period_name, start_date::text, end_date::text, status,
                closed_by, closed_at::text, closing_txn_id, notes, reopened_by, reopened_at::text`,
    [companyId, periodId, actor.userId, closingTxnId, options.notes?.trim() || null]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PERIOD_CLOSED',
    tableName: 'fiscal_periods',
    recordId: periodId,
    oldValues: { status: period.status },
    newValues: { status: 'closed', closingTxnId, periodName: period.period_name },
  });

  return {
    period: {
      ...upd.rows[0],
      id: Number(upd.rows[0].id),
      company_id: Number(upd.rows[0].company_id),
      closing_txn_id: upd.rows[0].closing_txn_id !== null ? Number(upd.rows[0].closing_txn_id) : null,
    },
    closingTransactionId: closingTxnId,
  };
}

export async function reopenFiscalPeriod(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  periodId: number,
  reason: string
): Promise<FiscalPeriodRow> {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw new AccountingError(400, 'An audit reason is required to reopen a closed fiscal period');
  }

  const res = await tx.query<FiscalPeriodRow>(
    `SELECT id, period_name, status FROM fiscal_periods WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, periodId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Fiscal period not found', 'PERIOD_NOT_FOUND');
  }
  if (res.rows[0].status === 'open') {
    throw new AccountingError(409, 'Fiscal period is already open');
  }

  const upd = await tx.query<FiscalPeriodRow>(
    `UPDATE fiscal_periods
        SET status = 'open',
            reopened_by = $3,
            reopened_at = NOW(),
            notes = $4
      WHERE company_id = $1 AND id = $2
      RETURNING id, company_id, period_name, start_date::text, end_date::text, status,
                closed_by, closed_at::text, closing_txn_id, notes, reopened_by, reopened_at::text`,
    [companyId, periodId, actor.userId, cleanReason]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PERIOD_REOPENED',
    tableName: 'fiscal_periods',
    recordId: periodId,
    oldValues: { status: res.rows[0].status },
    newValues: { status: 'open', reason: cleanReason },
  });

  return {
    ...upd.rows[0],
    id: Number(upd.rows[0].id),
    company_id: Number(upd.rows[0].company_id),
    closing_txn_id: upd.rows[0].closing_txn_id !== null ? Number(upd.rows[0].closing_txn_id) : null,
  };
}

// ============================================================================
// JOURNAL ENTRY POSTING, VALIDATION, IDEMPOTENCY & REVERSALS
// ============================================================================

export interface JournalLineInput {
  accountId: number;
  debit?: string | number;
  credit?: string | number;
  description?: string | null;
  basis?: LedgerBasis;
  classId?: number | null;
  partyType?: 'customer' | 'vendor' | 'employee' | null;
  partyId?: number | null;
}

export interface PostJournalInput {
  txnDate: string;
  description: string;
  memo?: string | null;
  reference?: string | null;
  sourceType?: JournalSourceType;
  sourceId?: number | null;
  isAdjusting?: boolean;
  reversesTransactionId?: number | null;
  idempotencyKey?: string | null;
  lines: JournalLineInput[];
}

export interface JournalLineRecord {
  id: number;
  lineOrder: number;
  accountId: number;
  accountCode: string | null;
  accountName: string;
  accountType: AccountType;
  basis: LedgerBasis;
  description: string | null;
  debit: string;
  credit: string;
  debitNum: number;
  creditNum: number;
  isReconciled: boolean;
}

export interface JournalEntryRecord {
  id: number;
  companyId: number;
  entryNumber: string;
  txnDate: string;
  reference: string | null;
  description: string | null;
  memo: string | null;
  sourceType: JournalSourceType;
  sourceId: number | null;
  status: 'draft' | 'posted' | 'voided';
  isPosted: boolean;
  isAdjusting: boolean;
  reversesTransactionId: number | null;
  reversedByTransactionId: number | null;
  postedAt: string | null;
  postedBy: number | null;
  postedByUsername: string | null;
  totalDebits: string;
  totalCredits: string;
  lines: JournalLineRecord[];
}

async function generateEntryNumber(
  tx: Transaction,
  companyId: number,
  sourceType: JournalSourceType
): Promise<string> {
  const prefix =
    sourceType === 'opening_balance'
      ? 'OB'
      : sourceType === 'reversal'
      ? 'REV'
      : sourceType === 'closing_entry'
      ? 'CLS'
      : 'JE';

  // Lock company row to serialize sequence generation per company without collisions
  await tx.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [companyId]);

  const countRes = await tx.query<{ next_seq: string }>(
    `SELECT (COUNT(*) + 1)::text AS next_seq
       FROM journal_transactions
      WHERE company_id = $1`,
    [companyId]
  );
  let seq = Number(countRes.rows[0].next_seq);
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = `${prefix}-${String(seq + attempt).padStart(5, '0')}`;
    const exists = await tx.query<{ id: number }>(
      `SELECT id FROM journal_transactions WHERE company_id = $1 AND entry_number = $2 LIMIT 1`,
      [companyId, candidate]
    );
    if (exists.rows.length === 0) return candidate;
  }
  return `${prefix}-${Date.now()}`;
}

export async function getJournalEntryById(
  tx: Transaction,
  companyId: number,
  transactionId: number
): Promise<JournalEntryRecord | null> {
  const hdrRes = await tx.query<{
    id: number;
    company_id: number;
    entry_number: string;
    txn_date: string;
    reference: string | null;
    description: string | null;
    memo: string | null;
    source_type: JournalSourceType;
    source_id: number | null;
    status: 'draft' | 'posted' | 'voided';
    is_posted: boolean;
    is_adjusting: boolean;
    reverses_transaction_id: number | null;
    reversed_by_transaction_id: number | null;
    posted_at: string | null;
    posted_by: number | null;
    posted_by_username: string | null;
  }>(
    `SELECT jt.id, jt.company_id, jt.entry_number, jt.txn_date::text, jt.reference,
            jt.description, jt.memo, jt.source_type, jt.source_id, jt.status,
            jt.is_posted, jt.is_adjusting, jt.reverses_transaction_id,
            jt.reversed_by_transaction_id, jt.posted_at::text, jt.posted_by,
            u.username AS posted_by_username
       FROM journal_transactions jt
       LEFT JOIN users u ON u.id = jt.posted_by
      WHERE jt.company_id = $1 AND jt.id = $2
      LIMIT 1`,
    [companyId, transactionId]
  );
  if (hdrRes.rows.length === 0) return null;
  const h = hdrRes.rows[0];

  const linesRes = await tx.query<{
    id: number;
    line_order: number;
    account_id: number;
    account_code: string | null;
    account_name: string;
    account_type: AccountType;
    basis: LedgerBasis;
    description: string | null;
    debit: string;
    credit: string;
    is_reconciled: boolean;
  }>(
    `SELECT jl.id, jl.line_order, jl.account_id, a.code AS account_code, a.name AS account_name,
            a.account_type, jl.basis, jl.description, jl.debit::text, jl.credit::text, jl.is_reconciled
       FROM journal_lines jl
       JOIN accounts a ON a.company_id = jl.company_id AND a.id = jl.account_id
      WHERE jl.company_id = $1 AND jl.transaction_id = $2
      ORDER BY jl.line_order ASC, jl.id ASC`,
    [companyId, transactionId]
  );

  let totalDr = 0n;
  let totalCr = 0n;
  const lines: JournalLineRecord[] = linesRes.rows.map(l => {
    const dr = parseDecimal4(l.debit);
    const cr = parseDecimal4(l.credit);
    totalDr += dr;
    totalCr += cr;
    return {
      id: Number(l.id),
      lineOrder: Number(l.line_order),
      accountId: Number(l.account_id),
      accountCode: l.account_code,
      accountName: l.account_name,
      accountType: l.account_type,
      basis: l.basis,
      description: l.description,
      debit: formatDecimal4(dr),
      credit: formatDecimal4(cr),
      debitNum: toMoneyNumber(dr),
      creditNum: toMoneyNumber(cr),
      isReconciled: Boolean(l.is_reconciled),
    };
  });

  return {
    id: Number(h.id),
    companyId: Number(h.company_id),
    entryNumber: h.entry_number,
    txnDate: h.txn_date,
    reference: h.reference,
    description: h.description,
    memo: h.memo,
    sourceType: h.source_type,
    sourceId: h.source_id !== null ? Number(h.source_id) : null,
    status: h.status,
    isPosted: Boolean(h.is_posted),
    isAdjusting: Boolean(h.is_adjusting),
    reversesTransactionId: h.reverses_transaction_id !== null ? Number(h.reverses_transaction_id) : null,
    reversedByTransactionId: h.reversed_by_transaction_id !== null ? Number(h.reversed_by_transaction_id) : null,
    postedAt: h.posted_at,
    postedBy: h.posted_by !== null ? Number(h.posted_by) : null,
    postedByUsername: h.posted_by_username,
    totalDebits: formatDecimal4(totalDr),
    totalCredits: formatDecimal4(totalCr),
    lines,
  };
}

export async function listJournalEntries(
  tx: Transaction,
  companyId: number,
  options: {
    startDate?: string;
    endDate?: string;
    sourceType?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<JournalEntryRecord[]> {
  const conditions: string[] = ['jt.company_id = $1'];
  const params: unknown[] = [companyId];
  let idx = 2;

  if (options.startDate) {
    conditions.push(`jt.txn_date >= $${idx++}::DATE`);
    params.push(options.startDate);
  }
  if (options.endDate) {
    conditions.push(`jt.txn_date <= $${idx++}::DATE`);
    params.push(options.endDate);
  }
  if (options.sourceType && options.sourceType !== 'all') {
    conditions.push(`jt.source_type = $${idx++}`);
    params.push(options.sourceType);
  }

  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 500);
  const offset = Math.max(Number(options.offset || 0), 0);

  const hdrs = await tx.query<{
    id: number;
    company_id: number;
    entry_number: string;
    txn_date: string;
    reference: string | null;
    description: string | null;
    memo: string | null;
    source_type: JournalSourceType;
    source_id: number | null;
    status: 'draft' | 'posted' | 'voided';
    is_posted: boolean;
    is_adjusting: boolean;
    reverses_transaction_id: number | null;
    reversed_by_transaction_id: number | null;
    posted_at: string | null;
    posted_by: number | null;
    posted_by_username: string | null;
  }>(
    `SELECT jt.id, jt.company_id, jt.entry_number, jt.txn_date::text, jt.reference,
            jt.description, jt.memo, jt.source_type, jt.source_id, jt.status,
            jt.is_posted, jt.is_adjusting, jt.reverses_transaction_id,
            jt.reversed_by_transaction_id, jt.posted_at::text, jt.posted_by,
            u.username AS posted_by_username
       FROM journal_transactions jt
       LEFT JOIN users u ON u.id = jt.posted_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY jt.txn_date DESC, jt.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  if (hdrs.rows.length === 0) return [];
  const txnIds = hdrs.rows.map(r => Number(r.id));

  const linesRes = await tx.query<{
    id: number;
    transaction_id: number;
    line_order: number;
    account_id: number;
    account_code: string | null;
    account_name: string;
    account_type: AccountType;
    basis: LedgerBasis;
    description: string | null;
    debit: string;
    credit: string;
    is_reconciled: boolean;
  }>(
    `SELECT jl.id, jl.transaction_id, jl.line_order, jl.account_id,
            a.code AS account_code, a.name AS account_name, a.account_type,
            jl.basis, jl.description, jl.debit::text, jl.credit::text, jl.is_reconciled
       FROM journal_lines jl
       JOIN accounts a ON a.company_id = jl.company_id AND a.id = jl.account_id
      WHERE jl.company_id = $1 AND jl.transaction_id = ANY($2::BIGINT[])
      ORDER BY jl.transaction_id DESC, jl.line_order ASC, jl.id ASC`,
    [companyId, txnIds]
  );

  const linesByTxn = new Map<number, JournalLineRecord[]>();
  const totalsByTxn = new Map<number, { dr: bigint; cr: bigint }>();
  for (const l of linesRes.rows) {
    const tid = Number(l.transaction_id);
    const dr = parseDecimal4(l.debit);
    const cr = parseDecimal4(l.credit);
    const list = linesByTxn.get(tid) ?? [];
    list.push({
      id: Number(l.id),
      lineOrder: Number(l.line_order),
      accountId: Number(l.account_id),
      accountCode: l.account_code,
      accountName: l.account_name,
      accountType: l.account_type,
      basis: l.basis,
      description: l.description,
      debit: formatDecimal4(dr),
      credit: formatDecimal4(cr),
      debitNum: toMoneyNumber(dr),
      creditNum: toMoneyNumber(cr),
      isReconciled: Boolean(l.is_reconciled),
    });
    linesByTxn.set(tid, list);
    const prev = totalsByTxn.get(tid) ?? { dr: 0n, cr: 0n };
    totalsByTxn.set(tid, { dr: prev.dr + dr, cr: prev.cr + cr });
  }

  return hdrs.rows.map(h => {
    const id = Number(h.id);
    const totals = totalsByTxn.get(id) ?? { dr: 0n, cr: 0n };
    return {
      id,
      companyId: Number(h.company_id),
      entryNumber: h.entry_number,
      txnDate: h.txn_date,
      reference: h.reference,
      description: h.description,
      memo: h.memo,
      sourceType: h.source_type,
      sourceId: h.source_id !== null ? Number(h.source_id) : null,
      status: h.status,
      isPosted: Boolean(h.is_posted),
      isAdjusting: Boolean(h.is_adjusting),
      reversesTransactionId: h.reverses_transaction_id !== null ? Number(h.reverses_transaction_id) : null,
      reversedByTransactionId: h.reversed_by_transaction_id !== null ? Number(h.reversed_by_transaction_id) : null,
      postedAt: h.posted_at,
      postedBy: h.posted_by !== null ? Number(h.posted_by) : null,
      postedByUsername: h.posted_by_username,
      totalDebits: formatDecimal4(totals.dr),
      totalCredits: formatDecimal4(totals.cr),
      lines: linesByTxn.get(id) ?? [],
    };
  });
}

export async function postJournalEntry(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: PostJournalInput
): Promise<{ transaction: JournalEntryRecord; idempotentReplay: boolean }> {
  const txnDate = String(input.txnDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) {
    throw new AccountingError(400, 'txnDate must be YYYY-MM-DD', 'INVALID_DATE');
  }
  const description = String(input.description || '').trim();
  if (!description) {
    throw new AccountingError(400, 'Journal description is required', 'MISSING_DESCRIPTION');
  }

  const sourceType: JournalSourceType = input.sourceType || 'manual';
  const idempotencyKey = input.idempotencyKey?.trim() ? input.idempotencyKey.trim().slice(0, 128) : null;

  // Normalized payload hash for idempotency safety
  const normalizedLines = (input.lines || []).map(l => ({
    accountId: Number(l.accountId),
    debit: formatDecimal4(parseDecimal4(l.debit ?? 0)),
    credit: formatDecimal4(parseDecimal4(l.credit ?? 0)),
    basis: (l.basis || 'both') as LedgerBasis,
    description: l.description?.trim() || '',
  }));

  const payloadHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        txnDate,
        description,
        sourceType,
        isAdjusting: Boolean(input.isAdjusting),
        lines: normalizedLines,
      })
    )
    .digest('hex');

  if (idempotencyKey) {
    const existingReq = await tx.query<{ payload_hash: string; response_json: { transactionId?: number } | null }>(
      `SELECT payload_hash, response_json
         FROM request_keys
        WHERE company_id = $1 AND route = 'journal_post' AND idempotency_key = $2
        LIMIT 1`,
      [companyId, idempotencyKey]
    );
    if (existingReq.rows.length > 0) {
      const prev = existingReq.rows[0];
      if (prev.payload_hash !== payloadHash) {
        throw new AccountingError(
          409,
          `Idempotency key "${idempotencyKey}" was already used with a different journal payload`,
          'IDEMPOTENCY_CONFLICT'
        );
      }
      const existingId = Number(prev.response_json?.transactionId);
      if (existingId) {
        const existingTxn = await getJournalEntryById(tx, companyId, existingId);
        if (existingTxn) {
          return { transaction: existingTxn, idempotentReplay: true };
        }
      }
    }
  }

  // Validate lines
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new AccountingError(400, 'A double-entry journal requires at least two lines', 'TOO_FEW_LINES');
  }

  const parsedLines: Array<{
    accountId: number;
    debit4: bigint;
    credit4: bigint;
    basis: LedgerBasis;
    description: string | null;
    classId: number | null;
    partyType: 'customer' | 'vendor' | 'employee' | null;
    partyId: number | null;
  }> = [];

  let accrualDr = 0n;
  let accrualCr = 0n;
  let cashDr = 0n;
  let cashCr = 0n;
  let totalDr = 0n;
  let totalCr = 0n;

  for (let i = 0; i < input.lines.length; i++) {
    const raw = input.lines[i];
    const accountId = Number(raw.accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new AccountingError(400, `Line ${i + 1}: invalid accountId`, 'INVALID_ACCOUNT_ID');
    }

    const debit4 = parseDecimal4(raw.debit ?? 0);
    const credit4 = parseDecimal4(raw.credit ?? 0);
    if (debit4 < 0n || credit4 < 0n) {
      throw new AccountingError(400, `Line ${i + 1}: debit and credit cannot be negative`, 'NEGATIVE_AMOUNT');
    }
    if (debit4 > 0n && credit4 > 0n) {
      throw new AccountingError(
        400,
        `Line ${i + 1}: a single journal line cannot carry both debit and credit`,
        'DUAL_SIDE_LINE'
      );
    }
    if (debit4 === 0n && credit4 === 0n) {
      throw new AccountingError(400, `Line ${i + 1}: amount must be greater than zero`, 'ZERO_LINE');
    }

    const basis: LedgerBasis = raw.basis || 'both';
    if (!['both', 'accrual', 'cash'].includes(basis)) {
      throw new AccountingError(400, `Line ${i + 1}: invalid basis '${basis}'`, 'INVALID_BASIS');
    }

    if (basis === 'both' || basis === 'accrual') {
      accrualDr += debit4;
      accrualCr += credit4;
    }
    if (basis === 'both' || basis === 'cash') {
      cashDr += debit4;
      cashCr += credit4;
    }
    totalDr += debit4;
    totalCr += credit4;

    parsedLines.push({
      accountId,
      debit4,
      credit4,
      basis,
      description: raw.description?.trim() || null,
      classId: raw.classId ?? null,
      partyType: raw.partyType ?? null,
      partyId: raw.partyId ?? null,
    });
  }

  if (totalDr <= 0n || totalDr !== totalCr) {
    const diff = absBigInt(totalDr - totalCr);
    throw new AccountingError(
      400,
      `Debits and credits must balance exactly: out of balance by ${formatDecimal4(diff)}`,
      'UNBALANCED_JOURNAL'
    );
  }
  if (accrualDr !== accrualCr) {
    throw new AccountingError(
      400,
      `Accrual-basis lines are out of balance by ${formatDecimal4(absBigInt(accrualDr - accrualCr))}`,
      'UNBALANCED_ACCRUAL_BASIS'
    );
  }
  if (cashDr !== cashCr) {
    throw new AccountingError(
      400,
      `Cash-basis lines are out of balance by ${formatDecimal4(absBigInt(cashDr - cashCr))}`,
      'UNBALANCED_CASH_BASIS'
    );
  }

  // Period closing lock validation (also enforced by PostgreSQL DEFERRABLE trigger at COMMIT)
  await assertPeriodOpenForDate(tx, companyId, txnDate, {
    isAdjusting: Boolean(input.isAdjusting),
  });

  // Verify every referenced account exists in active company and is active
  const accountIds = Array.from(new Set(parsedLines.map(l => l.accountId)));
  const acctsRes = await tx.query<{
    id: number;
    name: string;
    account_type: AccountType;
    is_active: boolean;
  }>(
    `SELECT id, name, account_type, is_active
       FROM accounts
      WHERE company_id = $1 AND id = ANY($2::BIGINT[])`,
    [companyId, accountIds]
  );
  const acctMap = new Map<number, { name: string; accountType: AccountType; isActive: boolean }>();
  for (const r of acctsRes.rows) {
    acctMap.set(Number(r.id), {
      name: r.name,
      accountType: r.account_type,
      isActive: Boolean(r.is_active),
    });
  }
  for (const id of accountIds) {
    const a = acctMap.get(id);
    if (!a) {
      throw new AccountingError(404, `Account ${id} not found in active company`, 'ACCOUNT_NOT_FOUND');
    }
    if (!a.isActive) {
      throw new AccountingError(400, `Account "${a.name}" is inactive and cannot accept postings`, 'INACTIVE_ACCOUNT');
    }
  }

  const entryNumber = await generateEntryNumber(tx, companyId, sourceType);

  const hdrIns = await tx.query<{ id: number }>(
    `INSERT INTO journal_transactions (
       company_id, entry_number, txn_date, reference, description, memo,
       source_type, source_id, status, is_posted, is_adjusting,
       reverses_transaction_id, idempotency_key, posted_at, posted_by, created_by
     ) VALUES (
       $1, $2, $3::DATE, $4, $5, $6,
       $7, $8, 'posted', TRUE, $9,
       $10, $11, NOW(), $12, $12
     ) RETURNING id`,
    [
      companyId,
      entryNumber,
      txnDate,
      input.reference?.trim() || null,
      description,
      input.memo?.trim() || description,
      sourceType,
      input.sourceId ?? null,
      Boolean(input.isAdjusting),
      input.reversesTransactionId ?? null,
      idempotencyKey,
      actor.userId,
    ]
  );
  const txnId = Number(hdrIns.rows[0].id);

  const deltas = new Map<number, bigint>();
  for (let i = 0; i < parsedLines.length; i++) {
    const l = parsedLines[i];
    await tx.query(
      `INSERT INTO journal_lines (
         company_id, transaction_id, line_order, account_id, basis,
         description, debit, credit, class_id, party_type, party_id
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9, $10, $11
       )`,
      [
        companyId,
        txnId,
        i + 1,
        l.accountId,
        l.basis,
        l.description,
        formatDecimal4(l.debit4),
        formatDecimal4(l.credit4),
        l.classId,
        l.partyType,
        l.partyId,
      ]
    );

    // Stored balance tracks accrual/both view (cash-only recognition lines never move stored balance)
    if (l.basis !== 'cash') {
      const acct = acctMap.get(l.accountId)!;
      const d = naturalDelta4(acct.accountType, l.debit4, l.credit4);
      deltas.set(l.accountId, (deltas.get(l.accountId) ?? 0n) + d);
    }
  }

  await applyBalanceDeltas(tx, companyId, deltas);

  if (idempotencyKey) {
    await tx.query(
      `INSERT INTO request_keys (company_id, route, idempotency_key, payload_hash, status_code, response_json, actor_user_id)
       VALUES ($1, 'journal_post', $2, $3, 201, $4::jsonb, $5)
       ON CONFLICT (company_id, route, idempotency_key) DO NOTHING`,
      [companyId, idempotencyKey, payloadHash, JSON.stringify({ transactionId: txnId }), actor.userId]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'JOURNAL_POSTED',
    tableName: 'journal_transactions',
    recordId: txnId,
    newValues: {
      entryNumber,
      txnDate,
      sourceType,
      isAdjusting: Boolean(input.isAdjusting),
      totalDebits: formatDecimal4(totalDr),
      lineCount: parsedLines.length,
    },
  });

  const full = await getJournalEntryById(tx, companyId, txnId);
  return { transaction: full!, idempotentReplay: false };
}

export async function reverseJournalEntry(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  transactionId: number,
  options: { reversalDate?: string; reason?: string; idempotencyKey?: string } = {}
): Promise<{ original: JournalEntryRecord; reversal: JournalEntryRecord; idempotentReplay: boolean }> {
  const origRes = await tx.query<{
    id: number;
    entry_number: string;
    txn_date: string;
    reference: string | null;
    description: string | null;
    source_type: JournalSourceType;
    status: string;
    is_posted: boolean;
    is_adjusting: boolean;
    reverses_transaction_id: number | null;
    reversed_by_transaction_id: number | null;
    posted_by: number | null;
  }>(
    `SELECT id, entry_number, txn_date::text, reference, description, source_type,
            status, is_posted, is_adjusting, reverses_transaction_id,
            reversed_by_transaction_id, posted_by
       FROM journal_transactions
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, transactionId]
  );

  if (origRes.rows.length === 0) {
    throw new AccountingError(404, 'Journal entry not found in active company', 'JOURNAL_NOT_FOUND');
  }

  const orig = origRes.rows[0];

  if (!orig.is_posted) {
    throw new AccountingError(400, 'Only posted journal entries can be reversed', 'NOT_POSTED');
  }
  if (orig.source_type === 'reversal' || orig.reverses_transaction_id !== null) {
    throw new AccountingError(400, 'A reversal entry cannot itself be reversed', 'CANNOT_REVERSE_REVERSAL');
  }
  if (orig.status === 'voided' || orig.reversed_by_transaction_id !== null) {
    // Check if this is an idempotent retry with same key
    if (options.idempotencyKey && orig.reversed_by_transaction_id) {
      const existingRev = await getJournalEntryById(tx, companyId, Number(orig.reversed_by_transaction_id));
      const existingOrig = await getJournalEntryById(tx, companyId, transactionId);
      if (existingRev && existingOrig) {
        return { original: existingOrig, reversal: existingRev, idempotentReplay: true };
      }
    }
    throw new AccountingError(409, 'This journal entry has already been reversed/voided.', 'ALREADY_REVERSED');
  }

  // SlowBooks Accountant rule (#340): Accountant can reverse only entries they posted
  if (actor.role === 'Accountant' && Number(orig.posted_by) !== actor.userId) {
    throw new AccountingError(
      403,
      'An Accountant may only reverse journal entries they posted.',
      'ACCOUNTANT_OWN_POST_ONLY'
    );
  }

  const linesRes = await tx.query<{
    account_id: number;
    basis: LedgerBasis;
    description: string | null;
    debit: string;
    credit: string;
    class_id: number | null;
    party_type: 'customer' | 'vendor' | 'employee' | null;
    party_id: number | null;
    is_reconciled: boolean;
  }>(
    `SELECT account_id, basis, description, debit::text, credit::text,
            class_id, party_type, party_id, is_reconciled
       FROM journal_lines
      WHERE company_id = $1 AND transaction_id = $2
      ORDER BY line_order ASC, id ASC`,
    [companyId, transactionId]
  );

  if (linesRes.rows.some(l => l.is_reconciled)) {
    throw new AccountingError(
      409,
      'Cannot reverse a journal entry containing reconciled bank/statement lines.',
      'RECONCILED_ENTRY_LOCKED'
    );
  }

  const reversalDate = options.reversalDate?.trim() || orig.txn_date;
  // Must check both original period and reversal period are open
  await assertPeriodOpenForDate(tx, companyId, orig.txn_date, { isAdjusting: Boolean(orig.is_adjusting) });
  if (reversalDate !== orig.txn_date) {
    await assertPeriodOpenForDate(tx, companyId, reversalDate, { isAdjusting: Boolean(orig.is_adjusting) });
  }

  const prefix = orig.is_adjusting ? 'VOID adjusting entry: ' : 'VOID: ';
  const reasonNote = options.reason?.trim() ? ` (${options.reason.trim()})` : '';
  const reversalDescription = `${prefix}${orig.description || orig.entry_number}${reasonNote}`;

  const reversedLines: JournalLineInput[] = linesRes.rows.map(l => ({
    accountId: Number(l.account_id),
    debit: l.credit,
    credit: l.debit,
    basis: l.basis,
    description: `${prefix}${l.description || orig.description || orig.entry_number}`.slice(0, 300),
    classId: l.class_id !== null ? Number(l.class_id) : null,
    partyType: l.party_type,
    partyId: l.party_id !== null ? Number(l.party_id) : null,
  }));

  const postedReversal = await postJournalEntry(tx, companyId, actor, {
    txnDate: reversalDate,
    description: reversalDescription,
    reference: orig.reference || orig.entry_number,
    sourceType: 'reversal',
    sourceId: transactionId,
    isAdjusting: Boolean(orig.is_adjusting),
    reversesTransactionId: transactionId,
    idempotencyKey: options.idempotencyKey,
    lines: reversedLines,
  });

  // Link original <-> reversal without mutating immutable financial fields
  await tx.query(
    `UPDATE journal_transactions
        SET status = 'voided',
            reversed_by_transaction_id = $3
      WHERE company_id = $1 AND id = $2`,
    [companyId, transactionId, postedReversal.transaction.id]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'JOURNAL_REVERSED',
    tableName: 'journal_transactions',
    recordId: transactionId,
    oldValues: { status: orig.status, entryNumber: orig.entry_number },
    newValues: {
      status: 'voided',
      reversedByTransactionId: postedReversal.transaction.id,
      reversalEntryNumber: postedReversal.transaction.entryNumber,
      reason: options.reason || null,
    },
  });

  const updatedOriginal = await getJournalEntryById(tx, companyId, transactionId);
  return {
    original: updatedOriginal!,
    reversal: postedReversal.transaction,
    idempotentReplay: false,
  };
}

// ============================================================================
// OPENING BALANCES WIZARD (SlowBooks Parity)
// ============================================================================

export async function postOpeningBalances(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    txnDate: string;
    description?: string;
    reference?: string;
    autoBalanceAccountId?: number | null;
    idempotencyKey?: string;
    lines: Array<{ accountId: number; amount: string | number }>;
  }
): Promise<{ transaction: JournalEntryRecord; autoBalanced: boolean; idempotentReplay: boolean }> {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'At least one opening balance line is required', 'EMPTY_OPENING_BALANCES');
  }

  const journalLines: JournalLineInput[] = [];
  let totalDebit4 = 0n;
  let totalCredit4 = 0n;

  for (const row of input.lines) {
    const amt4 = parseDecimal4(row.amount);
    if (amt4 === 0n) continue;

    const acctRes = await tx.query<{
      id: number;
      name: string;
      account_type: AccountType;
      is_active: boolean;
    }>(
      `SELECT id, name, account_type, is_active FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, Number(row.accountId)]
    );
    if (acctRes.rows.length === 0) {
      throw new AccountingError(404, `Account ${row.accountId} not found`, 'ACCOUNT_NOT_FOUND');
    }
    const acct = acctRes.rows[0];
    if (!acct.is_active) {
      throw new AccountingError(400, `Account "${acct.name}" is inactive`, 'INACTIVE_ACCOUNT');
    }
    if (!BALANCE_SHEET_TYPES.has(acct.account_type)) {
      throw new AccountingError(
        400,
        `Opening balances apply only to Balance Sheet accounts ("${acct.name}" is ${acct.account_type})`,
        'INVALID_OPENING_ACCOUNT_TYPE'
      );
    }

    const debitNormal = DEBIT_NORMAL_TYPES.has(acct.account_type);
    const putOnDebit = amt4 > 0n ? debitNormal : !debitNormal;
    const magnitude4 = absBigInt(amt4);

    journalLines.push({
      accountId: Number(acct.id),
      debit: putOnDebit ? formatDecimal4(magnitude4) : '0.0000',
      credit: putOnDebit ? '0.0000' : formatDecimal4(magnitude4),
      description: `Opening balance — ${acct.name}`,
    });

    if (putOnDebit) totalDebit4 += magnitude4;
    else totalCredit4 += magnitude4;
  }

  if (journalLines.length === 0) {
    throw new AccountingError(400, 'No non-zero opening balances were provided', 'ZERO_OPENING_BALANCES');
  }

  const diff4 = totalDebit4 - totalCredit4;
  let autoBalanced = false;
  if (diff4 !== 0n) {
    if (!input.autoBalanceAccountId) {
      throw new AccountingError(
        400,
        `Opening balances are unbalanced by ${formatDecimal4(absBigInt(diff4))}. Correct the amounts or select an Equity account to auto-balance.`,
        'UNBALANCED_OPENING_BALANCES'
      );
    }
    const eqRes = await tx.query<{ id: number; name: string; account_type: AccountType; is_active: boolean }>(
      `SELECT id, name, account_type, is_active FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, Number(input.autoBalanceAccountId)]
    );
    if (eqRes.rows.length === 0 || !eqRes.rows[0].is_active || eqRes.rows[0].account_type !== 'Equity') {
      throw new AccountingError(400, 'Auto-balance account must be an active Equity account', 'INVALID_EQUITY_ACCOUNT');
    }
    journalLines.push({
      accountId: Number(eqRes.rows[0].id),
      debit: diff4 < 0n ? formatDecimal4(-diff4) : '0.0000',
      credit: diff4 > 0n ? formatDecimal4(diff4) : '0.0000',
      description: `Opening balance equity offset — ${eqRes.rows[0].name}`,
    });
    autoBalanced = true;
  }

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: input.txnDate,
    description: input.description?.trim() || 'Opening Balances',
    reference: input.reference?.trim() || 'OPENING-BAL',
    sourceType: 'opening_balance',
    idempotencyKey: input.idempotencyKey,
    lines: journalLines,
  });

  return {
    transaction: posted.transaction,
    autoBalanced,
    idempotentReplay: posted.idempotentReplay,
  };
}

