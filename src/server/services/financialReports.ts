import { Transaction } from '@electric-sql/pglite';
import {
  AccountType,
  AccountingError,
  BALANCE_SHEET_TYPES,
  DEBIT_NORMAL_TYPES,
  DetailType,
  getCompanyAccountingPrefs,
  naturalDelta4,
} from './accountingEngine.ts';
import {
  formatDecimal2,
  formatDecimal4,
  parseDecimal4,
  RoundingMode,
  toMoneyNumber,
} from '../lib/decimal.ts';

export type ReportBasis = 'accrual' | 'cash';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function validateIsoDate(value: string | undefined | null, fallback: string, fieldName: string): string {
  const v = value?.trim();
  if (!v) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new AccountingError(400, `${fieldName} must be formatted as YYYY-MM-DD`, 'INVALID_DATE');
  }
  return v;
}

function resolveFiscalYearStart(asOfDateIso: string, fiscalYearStartMonth: number): string {
  const [yStr, mStr] = asOfDateIso.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const fyMonth = Math.min(Math.max(Number(fiscalYearStartMonth) || 1, 1), 12);
  const startYear = month >= fyMonth ? year : year - 1;
  return `${startYear}-${String(fyMonth).padStart(2, '0')}-01`;
}

function allowedBases(basis: ReportBasis): string[] {
  return basis === 'cash' ? ['both', 'cash'] : ['both', 'accrual'];
}

interface AccountMeta {
  id: number;
  code: string | null;
  name: string;
  accountType: AccountType;
  detailType: DetailType;
  bankKind: 'bank' | 'credit_card' | null;
  parentId: number | null;
  normalBalance: 'debit' | 'credit';
  isActive: boolean;
}

async function loadCompanyChart(tx: Transaction, companyId: number): Promise<Map<number, AccountMeta>> {
  const res = await tx.query<{
    id: number;
    code: string | null;
    name: string;
    account_type: AccountType;
    detail_type: DetailType;
    bank_kind: 'bank' | 'credit_card' | null;
    parent_id: number | null;
    normal_balance: 'debit' | 'credit';
    is_active: boolean;
  }>(
    `SELECT id, code, name, account_type, detail_type, bank_kind, parent_id, normal_balance, is_active
       FROM accounts
      WHERE company_id = $1`,
    [companyId]
  );

  const map = new Map<number, AccountMeta>();
  for (const r of res.rows) {
    map.set(Number(r.id), {
      id: Number(r.id),
      code: r.code,
      name: r.name,
      accountType: r.account_type,
      detailType: r.detail_type,
      bankKind: r.bank_kind,
      parentId: r.parent_id !== null ? Number(r.parent_id) : null,
      normalBalance: r.normal_balance,
      isActive: Boolean(r.is_active),
    });
  }
  return map;
}

function accountHierarchyPath(chart: Map<number, AccountMeta>, accountId: number): string {
  const names: string[] = [];
  const seen = new Set<number>();
  let cursor: number | null = accountId;
  while (cursor !== null && !seen.has(cursor) && names.length < 5) {
    const node = chart.get(cursor);
    if (!node) break;
    seen.add(cursor);
    names.push(node.name);
    cursor = node.parentId;
  }
  return names.reverse().join(': ');
}

function compareAccountsByCode(a: AccountMeta, b: AccountMeta): number {
  const ac = a.code || '';
  const bc = b.code || '';
  if (ac && !bc) return -1;
  if (!ac && bc) return 1;
  if (ac !== bc) return ac.localeCompare(bc, undefined, { numeric: true });
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

// ============================================================================
// 1. GENERAL LEDGER (Running Balances in Natural Account Sign + Brought Forward)
// ============================================================================

export interface GeneralLedgerEntryRow {
  transactionId: number;
  lineId: number;
  entryNumber: string;
  txnDate: string;
  reference: string | null;
  description: string;
  sourceType: string;
  isAdjusting: boolean;
  status: string;
  voided: boolean;
  reversesTransactionId: number | null;
  reversedByTransactionId: number | null;
  debit: string;
  credit: string;
  debitNum: number;
  creditNum: number;
  runningBalance: string;
  runningBalanceNum: number;
}

export interface GeneralLedgerAccountSection {
  accountId: number;
  accountCode: string | null;
  accountName: string;
  accountPath: string;
  accountType: AccountType;
  normalBalance: 'debit' | 'credit';
  openingBalance: string;
  openingBalanceNum: number;
  totalDebit: string;
  totalCredit: string;
  totalDebitNum: number;
  totalCreditNum: number;
  closingBalance: string;
  closingBalanceNum: number;
  entries: GeneralLedgerEntryRow[];
}

export async function getGeneralLedger(
  tx: Transaction,
  companyId: number,
  options: {
    startDate?: string;
    endDate?: string;
    accountId?: number | null;
    basis?: ReportBasis;
    excludeAdjusting?: boolean;
  } = {}
) {
  const prefs = await getCompanyAccountingPrefs(tx, companyId);
  const basis: ReportBasis = options.basis === 'cash' || options.basis === 'accrual' ? options.basis : prefs.accountingMethod;
  const endDate = validateIsoDate(options.endDate, todayIso(), 'endDate');
  const startDate = validateIsoDate(
    options.startDate,
    resolveFiscalYearStart(endDate, prefs.fiscalYearStartMonth),
    'startDate'
  );
  if (startDate > endDate) {
    throw new AccountingError(400, 'startDate cannot be after endDate', 'INVALID_DATE_RANGE');
  }

  const chart = await loadCompanyChart(tx, companyId);
  const bases = allowedBases(basis);
  const accountId = options.accountId ? Number(options.accountId) : null;
  if (accountId !== null && !chart.has(accountId)) {
    throw new AccountingError(404, 'Account not found in active company', 'ACCOUNT_NOT_FOUND');
  }

  // Opening (brought forward) balances strictly before startDate
  const openParams: unknown[] = [companyId, startDate, bases];
  let openFilter = '';
  if (accountId !== null) {
    openFilter += ` AND jl.account_id = $4`;
    openParams.push(accountId);
  }
  if (options.excludeAdjusting) {
    openFilter += ` AND jt.is_adjusting = FALSE`;
  }

  const openRes = await tx.query<{ account_id: number; dr: string; cr: string }>(
    `SELECT jl.account_id,
            COALESCE(SUM(jl.debit), 0)::NUMERIC(19,4)::text AS dr,
            COALESCE(SUM(jl.credit), 0)::NUMERIC(19,4)::text AS cr
       FROM journal_lines jl
       JOIN journal_transactions jt
         ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
      WHERE jl.company_id = $1
        AND jt.is_posted = TRUE
         
        AND jt.txn_date < $2::DATE
        AND jl.basis = ANY($3::TEXT[])
        ${openFilter}
      GROUP BY jl.account_id`,
    openParams
  );

  const openingByAcct = new Map<number, bigint>();
  for (const r of openRes.rows) {
    const aid = Number(r.account_id);
    const meta = chart.get(aid);
    if (!meta) continue;
    openingByAcct.set(aid, naturalDelta4(meta.accountType, parseDecimal4(r.dr), parseDecimal4(r.cr)));
  }

  // Period entries ordered deterministically by account code, txn_date, transaction_id, line_id
  const lineParams: unknown[] = [companyId, startDate, endDate, bases];
  let lineFilter = '';
  if (accountId !== null) {
    lineFilter += ` AND jl.account_id = $5`;
    lineParams.push(accountId);
  }
  if (options.excludeAdjusting) {
    lineFilter += ` AND jt.is_adjusting = FALSE`;
  }

  const linesRes = await tx.query<{
    line_id: number;
    transaction_id: number;
    entry_number: string;
    txn_date: string;
    reference: string | null;
    txn_desc: string | null;
    line_desc: string | null;
    source_type: string;
    is_adjusting: boolean;
    status: string;
    reverses_transaction_id: number | null;
    reversed_by_transaction_id: number | null;
    account_id: number;
    debit: string;
    credit: string;
  }>(
    `SELECT jl.id AS line_id,
            jt.id AS transaction_id,
            jt.entry_number,
            jt.txn_date::text,
            jt.reference,
            jt.description AS txn_desc,
            jl.description AS line_desc,
            jt.source_type,
            jt.is_adjusting,
            jt.status,
            jt.reverses_transaction_id,
            jt.reversed_by_transaction_id,
            jl.account_id,
            jl.debit::text,
            jl.credit::text
       FROM journal_lines jl
       JOIN journal_transactions jt
         ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
      WHERE jl.company_id = $1
        AND jt.is_posted = TRUE
         
        AND jt.txn_date BETWEEN $2::DATE AND $3::DATE
        AND jl.basis = ANY($4::TEXT[])
        ${lineFilter}
      ORDER BY jl.account_id ASC, jt.txn_date ASC, jt.id ASC, jl.line_order ASC, jl.id ASC`,
    lineParams
  );

  const sectionsMap = new Map<
    number,
    {
      meta: AccountMeta;
      opening4: bigint;
      running4: bigint;
      totalDr4: bigint;
      totalCr4: bigint;
      entries: GeneralLedgerEntryRow[];
    }
  >();

  const ensureSection = (aid: number) => {
    let sec = sectionsMap.get(aid);
    if (!sec) {
      const meta = chart.get(aid)!;
      const opening4 = openingByAcct.get(aid) ?? 0n;
      sec = {
        meta,
        opening4,
        running4: opening4,
        totalDr4: 0n,
        totalCr4: 0n,
        entries: [],
      };
      sectionsMap.set(aid, sec);
    }
    return sec;
  };

  for (const [aid, openBal] of openingByAcct.entries()) {
    if (openBal !== 0n || accountId === aid) {
      ensureSection(aid);
    }
  }
  if (accountId !== null) {
    ensureSection(accountId);
  }

  for (const row of linesRes.rows) {
    const aid = Number(row.account_id);
    if (!chart.has(aid)) continue;
    const sec = ensureSection(aid);
    const dr4 = parseDecimal4(row.debit);
    const cr4 = parseDecimal4(row.credit);
    sec.running4 += naturalDelta4(sec.meta.accountType, dr4, cr4);
    sec.totalDr4 += dr4;
    sec.totalCr4 += cr4;

    const desc =
      row.line_desc && row.txn_desc && row.line_desc !== row.txn_desc
        ? `${row.txn_desc} — ${row.line_desc}`
        : row.line_desc || row.txn_desc || row.entry_number;

    sec.entries.push({
      transactionId: Number(row.transaction_id),
      lineId: Number(row.line_id),
      entryNumber: row.entry_number,
      txnDate: row.txn_date,
      reference: row.reference,
      description: desc,
      sourceType: row.source_type,
      isAdjusting: Boolean(row.is_adjusting),
      status: row.status,
      voided: row.status === 'voided' || row.source_type === 'reversal',
      reversesTransactionId: row.reverses_transaction_id !== null ? Number(row.reverses_transaction_id) : null,
      reversedByTransactionId: row.reversed_by_transaction_id !== null ? Number(row.reversed_by_transaction_id) : null,
      debit: formatDecimal4(dr4),
      credit: formatDecimal4(cr4),
      debitNum: toMoneyNumber(dr4, prefs.roundingMode),
      creditNum: toMoneyNumber(cr4, prefs.roundingMode),
      runningBalance: formatDecimal4(sec.running4),
      runningBalanceNum: toMoneyNumber(sec.running4, prefs.roundingMode),
    });
  }

  const accountsList: GeneralLedgerAccountSection[] = Array.from(sectionsMap.values())
    .sort((a, b) => compareAccountsByCode(a.meta, b.meta))
    .map(sec => ({
      accountId: sec.meta.id,
      accountCode: sec.meta.code,
      accountName: sec.meta.name,
      accountPath: accountHierarchyPath(chart, sec.meta.id),
      accountType: sec.meta.accountType,
      normalBalance: sec.meta.normalBalance,
      openingBalance: formatDecimal4(sec.opening4),
      openingBalanceNum: toMoneyNumber(sec.opening4, prefs.roundingMode),
      totalDebit: formatDecimal4(sec.totalDr4),
      totalCredit: formatDecimal4(sec.totalCr4),
      totalDebitNum: toMoneyNumber(sec.totalDr4, prefs.roundingMode),
      totalCreditNum: toMoneyNumber(sec.totalCr4, prefs.roundingMode),
      closingBalance: formatDecimal4(sec.running4),
      closingBalanceNum: toMoneyNumber(sec.running4, prefs.roundingMode),
      entries: sec.entries,
    }));

  return {
    companyId,
    startDate,
    endDate,
    accountId,
    basis,
    excludeAdjusting: Boolean(options.excludeAdjusting),
    roundingMode: prefs.roundingMode,
    accounts: accountsList,
  };
}

// ============================================================================
// 2. TRIAL BALANCE (SlowBooks Parity: BS <= endDate, P&L in [startDate, endDate] + Prior Net Income)
// ============================================================================

export interface TrialBalanceRow {
  accountId: number | null;
  accountCode: string | null;
  accountName: string;
  accountPath: string;
  accountType: AccountType | 'DerivedEquity';
  debit: string;
  credit: string;
  debitNum: number;
  creditNum: number;
  netBalance: string;
  netBalanceNum: number;
}

export async function getTrialBalance(
  tx: Transaction,
  companyId: number,
  options: {
    startDate?: string;
    endDate?: string;
    asOfDate?: string;
    basis?: ReportBasis;
    excludeAdjusting?: boolean;
    hideZero?: boolean;
  } = {}
) {
  const prefs = await getCompanyAccountingPrefs(tx, companyId);
  const basis: ReportBasis = options.basis === 'cash' || options.basis === 'accrual' ? options.basis : prefs.accountingMethod;
  const endDate = validateIsoDate(options.endDate || options.asOfDate, todayIso(), 'endDate');
  const startDate = validateIsoDate(
    options.startDate,
    resolveFiscalYearStart(endDate, prefs.fiscalYearStartMonth),
    'startDate'
  );
  if (startDate > endDate) {
    throw new AccountingError(400, 'startDate cannot be after endDate', 'INVALID_DATE_RANGE');
  }

  const chart = await loadCompanyChart(tx, companyId);
  const bases = allowedBases(basis);
  const adjClause = options.excludeAdjusting ? 'AND jt.is_adjusting = FALSE' : '';

  const bsTypes = Array.from(BALANCE_SHEET_TYPES);

  const sumsRes = await tx.query<{ account_id: number; dr: string; cr: string }>(
    `SELECT jl.account_id,
            COALESCE(SUM(jl.debit), 0)::NUMERIC(19,4)::text AS dr,
            COALESCE(SUM(jl.credit), 0)::NUMERIC(19,4)::text AS cr
       FROM journal_lines jl
       JOIN journal_transactions jt
         ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
       JOIN accounts a
         ON a.company_id = jl.company_id AND a.id = jl.account_id
      WHERE jl.company_id = $1
        AND jt.is_posted = TRUE
         
        AND jl.basis = ANY($2::TEXT[])
        AND jt.txn_date <= $3::DATE
        AND (a.account_type = ANY($4::TEXT[]) OR jt.txn_date >= $5::DATE)
        ${adjClause}
      GROUP BY jl.account_id`,
    [companyId, bases, endDate, bsTypes, startDate]
  );

  const byAcct = new Map<number, { dr4: bigint; cr4: bigint }>();
  for (const r of sumsRes.rows) {
    byAcct.set(Number(r.account_id), { dr4: parseDecimal4(r.dr), cr4: parseDecimal4(r.cr) });
  }

  let totalDebit4 = 0n;
  let totalCredit4 = 0n;
  const rows: TrialBalanceRow[] = [];

  const sortedAccts = Array.from(chart.values()).sort(compareAccountsByCode);
  for (const acct of sortedAccts) {
    const raw = byAcct.get(acct.id);
    if (!raw && options.hideZero) continue;
    let dr4 = raw?.dr4 ?? 0n;
    let cr4 = raw?.cr4 ?? 0n;

    if (BALANCE_SHEET_TYPES.has(acct.accountType)) {
      const net = dr4 - cr4;
      dr4 = net > 0n ? net : 0n;
      cr4 = net < 0n ? -net : 0n;
    }

    if (options.hideZero && dr4 === 0n && cr4 === 0n) {
      continue;
    }
    if (!raw && !acct.isActive) continue;

    totalDebit4 += dr4;
    totalCredit4 += cr4;

    rows.push({
      accountId: acct.id,
      accountCode: acct.code,
      accountName: acct.name,
      accountPath: accountHierarchyPath(chart, acct.id),
      accountType: acct.accountType,
      debit: formatDecimal4(dr4),
      credit: formatDecimal4(cr4),
      debitNum: toMoneyNumber(dr4, prefs.roundingMode),
      creditNum: toMoneyNumber(cr4, prefs.roundingMode),
      netBalance: formatDecimal4(dr4 - cr4),
      netBalanceNum: toMoneyNumber(dr4 - cr4, prefs.roundingMode),
    });
  }

  // Net income of periods strictly prior to startDate (so BS cumulative + P&L windowed always foot identically)
  const priorRes = await tx.query<{ net_dr_minus_cr: string }>(
    `SELECT (COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0))::NUMERIC(19,4)::text AS net_dr_minus_cr
       FROM journal_lines jl
       JOIN journal_transactions jt
         ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
       JOIN accounts a
         ON a.company_id = jl.company_id AND a.id = jl.account_id
      WHERE jl.company_id = $1
        AND jt.is_posted = TRUE
         
        AND jl.basis = ANY($2::TEXT[])
        AND NOT (a.account_type = ANY($3::TEXT[]))
        AND jt.txn_date < $4::DATE
        AND jt.txn_date <= $5::DATE
        ${adjClause}`,
    [companyId, bases, bsTypes, startDate, endDate]
  );

  const priorNet4 = parseDecimal4(priorRes.rows[0]?.net_dr_minus_cr ?? '0');
  if (priorNet4 !== 0n) {
    const dr4 = priorNet4 > 0n ? priorNet4 : 0n;
    const cr4 = priorNet4 < 0n ? -priorNet4 : 0n;
    totalDebit4 += dr4;
    totalCredit4 += cr4;
    rows.push({
      accountId: null,
      accountCode: null,
      accountName: 'Net Income (prior periods)',
      accountPath: 'Net Income (prior periods)',
      accountType: 'DerivedEquity',
      debit: formatDecimal4(dr4),
      credit: formatDecimal4(cr4),
      debitNum: toMoneyNumber(dr4, prefs.roundingMode),
      creditNum: toMoneyNumber(cr4, prefs.roundingMode),
      netBalance: formatDecimal4(dr4 - cr4),
      netBalanceNum: toMoneyNumber(dr4 - cr4, prefs.roundingMode),
    });
  }

  return {
    companyId,
    startDate,
    endDate,
    basis,
    excludeAdjusting: Boolean(options.excludeAdjusting),
    hideZero: Boolean(options.hideZero),
    roundingMode: prefs.roundingMode,
    rows,
    totalDebit: formatDecimal4(totalDebit4),
    totalCredit: formatDecimal4(totalCredit4),
    totalDebitNum: toMoneyNumber(totalDebit4, prefs.roundingMode),
    totalCreditNum: toMoneyNumber(totalCredit4, prefs.roundingMode),
    difference: formatDecimal4(totalDebit4 - totalCredit4),
    isBalanced: totalDebit4 === totalCredit4,
  };
}

// ============================================================================
// 3. PROFIT & LOSS (Operating vs Other Income/Expense + Accrual/Cash Basis)
// ============================================================================

export interface StatementLineItem {
  accountId: number | null;
  accountCode: string | null;
  accountName: string;
  accountPath: string;
  detailType: string;
  amount: string;
  amountNum: number;
  syntheticLine?: string;
}

async function queryTypeBalances4(
  tx: Transaction,
  companyId: number,
  chart: Map<number, AccountMeta>,
  options: {
    startDate?: string | null;
    endDate: string;
    bases: string[];
    excludeAdjusting?: boolean;
    roundingMode: RoundingMode;
  }
): Promise<Map<number, bigint>> {
  const params: unknown[] = [companyId, options.bases, options.endDate];
  let dateStartSql = '';
  if (options.startDate) {
    dateStartSql = `AND jt.txn_date >= $4::DATE`;
    params.push(options.startDate);
  }
  const adjSql = options.excludeAdjusting ? 'AND jt.is_adjusting = FALSE' : '';

  const res = await tx.query<{ account_id: number; dr: string; cr: string }>(
    `SELECT jl.account_id,
            COALESCE(SUM(jl.debit), 0)::NUMERIC(19,4)::text AS dr,
            COALESCE(SUM(jl.credit), 0)::NUMERIC(19,4)::text AS cr
       FROM journal_lines jl
       JOIN journal_transactions jt
         ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
      WHERE jl.company_id = $1
        AND jt.is_posted = TRUE
         
        AND jl.basis = ANY($2::TEXT[])
        AND jt.txn_date <= $3::DATE
        ${dateStartSql}
        ${adjSql}
      GROUP BY jl.account_id`,
    params
  );

  const map = new Map<number, bigint>();
  for (const r of res.rows) {
    const aid = Number(r.account_id);
    const meta = chart.get(aid);
    if (!meta) continue;
    map.set(aid, naturalDelta4(meta.accountType, parseDecimal4(r.dr), parseDecimal4(r.cr)));
  }
  return map;
}

function buildSectionRows(
  chart: Map<number, AccountMeta>,
  balances: Map<number, bigint>,
  predicate: (m: AccountMeta) => boolean,
  roundingMode: RoundingMode,
  hideZero: boolean
): { lines: StatementLineItem[]; total4: bigint } {
  const lines: StatementLineItem[] = [];
  let total4 = 0n;

  const matching = Array.from(chart.values()).filter(predicate).sort(compareAccountsByCode);
  for (const m of matching) {
    const amt4 = balances.get(m.id) ?? 0n;
    total4 += amt4;
    if (hideZero && amt4 === 0n) continue;
    if (!balances.has(m.id) && !m.isActive) continue;
    if (!balances.has(m.id) && amt4 === 0n) continue;

    lines.push({
      accountId: m.id,
      accountCode: m.code,
      accountName: m.name,
      accountPath: accountHierarchyPath(chart, m.id),
      detailType: m.detailType,
      amount: formatDecimal4(amt4),
      amountNum: toMoneyNumber(amt4, roundingMode),
    });
  }
  return { lines, total4 };
}

export async function getProfitAndLoss(
  tx: Transaction,
  companyId: number,
  options: {
    startDate?: string;
    endDate?: string;
    basis?: ReportBasis;
    excludeAdjusting?: boolean;
    hideZero?: boolean;
  } = {}
) {
  const prefs = await getCompanyAccountingPrefs(tx, companyId);
  const basis: ReportBasis = options.basis === 'cash' || options.basis === 'accrual' ? options.basis : prefs.accountingMethod;
  const endDate = validateIsoDate(options.endDate, todayIso(), 'endDate');
  const startDate = validateIsoDate(
    options.startDate,
    resolveFiscalYearStart(endDate, prefs.fiscalYearStartMonth),
    'startDate'
  );
  if (startDate > endDate) {
    throw new AccountingError(400, 'startDate cannot be after endDate', 'INVALID_DATE_RANGE');
  }

  const chart = await loadCompanyChart(tx, companyId);
  const balances = await queryTypeBalances4(tx, companyId, chart, {
    startDate,
    endDate,
    bases: allowedBases(basis),
    excludeAdjusting: Boolean(options.excludeAdjusting),
    roundingMode: prefs.roundingMode,
  });

  const hideZero = Boolean(options.hideZero);
  const incSec = buildSectionRows(
    chart,
    balances,
    m => m.accountType === 'Income' && m.detailType !== 'other_income',
    prefs.roundingMode,
    hideZero
  );
  const otherIncSec = buildSectionRows(
    chart,
    balances,
    m => m.accountType === 'Income' && m.detailType === 'other_income',
    prefs.roundingMode,
    hideZero
  );
  const cogsSec = buildSectionRows(
    chart,
    balances,
    m => m.accountType === 'CostOfGoodsSold',
    prefs.roundingMode,
    hideZero
  );
  const expSec = buildSectionRows(
    chart,
    balances,
    m => m.accountType === 'Expense' && m.detailType !== 'other_expense',
    prefs.roundingMode,
    hideZero
  );
  const otherExpSec = buildSectionRows(
    chart,
    balances,
    m => m.accountType === 'OtherExpense' || (m.accountType === 'Expense' && m.detailType === 'other_expense'),
    prefs.roundingMode,
    hideZero
  );

  const operatingGrossProfit4 = incSec.total4 - cogsSec.total4;
  const netOperatingIncome4 = operatingGrossProfit4 - expSec.total4;
  const netOtherIncome4 = otherIncSec.total4 - otherExpSec.total4;
  const netIncome4 = netOperatingIncome4 + netOtherIncome4;

  const totalIncome4 = incSec.total4 + otherIncSec.total4;
  const grossProfit4 = totalIncome4 - cogsSec.total4;
  const totalExpenses4 = expSec.total4 + otherExpSec.total4;

  return {
    companyId,
    startDate,
    endDate,
    basis,
    excludeAdjusting: Boolean(options.excludeAdjusting),
    hideZero,
    roundingMode: prefs.roundingMode,
    sections: {
      income: incSec.lines,
      cogs: cogsSec.lines,
      expenses: expSec.lines,
      otherIncome: otherIncSec.lines,
      otherExpense: otherExpSec.lines,
    },
    hasOther: otherIncSec.total4 !== 0n || otherExpSec.total4 !== 0n,
    totals: {
      totalOperatingIncome: formatDecimal4(incSec.total4),
      totalOperatingIncomeNum: toMoneyNumber(incSec.total4, prefs.roundingMode),
      totalIncome: formatDecimal4(totalIncome4),
      totalIncomeNum: toMoneyNumber(totalIncome4, prefs.roundingMode),
      totalCogs: formatDecimal4(cogsSec.total4),
      totalCogsNum: toMoneyNumber(cogsSec.total4, prefs.roundingMode),
      operatingGrossProfit: formatDecimal4(operatingGrossProfit4),
      operatingGrossProfitNum: toMoneyNumber(operatingGrossProfit4, prefs.roundingMode),
      grossProfit: formatDecimal4(grossProfit4),
      grossProfitNum: toMoneyNumber(grossProfit4, prefs.roundingMode),
      totalOperatingExpenses: formatDecimal4(expSec.total4),
      totalOperatingExpensesNum: toMoneyNumber(expSec.total4, prefs.roundingMode),
      totalExpenses: formatDecimal4(totalExpenses4),
      totalExpensesNum: toMoneyNumber(totalExpenses4, prefs.roundingMode),
      netOperatingIncome: formatDecimal4(netOperatingIncome4),
      netOperatingIncomeNum: toMoneyNumber(netOperatingIncome4, prefs.roundingMode),
      totalOtherIncome: formatDecimal4(otherIncSec.total4),
      totalOtherIncomeNum: toMoneyNumber(otherIncSec.total4, prefs.roundingMode),
      totalOtherExpense: formatDecimal4(otherExpSec.total4),
      totalOtherExpenseNum: toMoneyNumber(otherExpSec.total4, prefs.roundingMode),
      netOtherIncome: formatDecimal4(netOtherIncome4),
      netOtherIncomeNum: toMoneyNumber(netOtherIncome4, prefs.roundingMode),
      netIncome: formatDecimal4(netIncome4),
      netIncomeNum: toMoneyNumber(netIncome4, prefs.roundingMode),
    },
  };
}

// ============================================================================
// 4. BALANCE SHEET (Assets = Liabilities + Equity; Prior FY Retained Earnings vs Current FY Net Income)
// ============================================================================

export async function getBalanceSheet(
  tx: Transaction,
  companyId: number,
  options: {
    asOfDate?: string;
    basis?: ReportBasis;
    excludeAdjusting?: boolean;
    hideZero?: boolean;
  } = {}
) {
  const prefs = await getCompanyAccountingPrefs(tx, companyId);
  const basis: ReportBasis = options.basis === 'cash' || options.basis === 'accrual' ? options.basis : prefs.accountingMethod;
  const asOfDate = validateIsoDate(options.asOfDate, todayIso(), 'asOfDate');
  const fyStart = resolveFiscalYearStart(asOfDate, prefs.fiscalYearStartMonth);
  const chart = await loadCompanyChart(tx, companyId);
  const bases = allowedBases(basis);
  const hideZero = Boolean(options.hideZero);

  const cumBalances = await queryTypeBalances4(tx, companyId, chart, {
    startDate: null,
    endDate: asOfDate,
    bases,
    excludeAdjusting: Boolean(options.excludeAdjusting),
    roundingMode: prefs.roundingMode,
  });

  const fyBalances = await queryTypeBalances4(tx, companyId, chart, {
    startDate: fyStart,
    endDate: asOfDate,
    bases,
    excludeAdjusting: Boolean(options.excludeAdjusting),
    roundingMode: prefs.roundingMode,
  });

  // Group Assets
  const currentAssetsSec = buildSectionRows(
    chart,
    cumBalances,
    m =>
      ['Bank', 'AccountsReceivable', 'Inventory', 'OtherCurrentAsset'].includes(m.accountType) &&
      m.detailType !== 'fixed_asset' &&
      m.detailType !== 'other_asset',
    prefs.roundingMode,
    hideZero
  );
  const fixedAssetsSec = buildSectionRows(
    chart,
    cumBalances,
    m => m.accountType === 'FixedAsset' || m.detailType === 'fixed_asset',
    prefs.roundingMode,
    hideZero
  );
  const otherAssetsSec = buildSectionRows(
    chart,
    cumBalances,
    m => m.accountType === 'OtherCurrentAsset' && m.detailType === 'other_asset',
    prefs.roundingMode,
    hideZero
  );

  // Group Liabilities
  const currentLiabSec = buildSectionRows(
    chart,
    cumBalances,
    m => ['AccountsPayable', 'CreditCard', 'PayrollLiability', 'OtherCurrentLiability'].includes(m.accountType),
    prefs.roundingMode,
    hideZero
  );
  const longTermLiabSec = buildSectionRows(
    chart,
    cumBalances,
    m => m.accountType === 'LongTermLiability',
    prefs.roundingMode,
    hideZero
  );

  // Posted Equity accounts
  const postedEquitySec = buildSectionRows(
    chart,
    cumBalances,
    m => m.accountType === 'Equity',
    prefs.roundingMode,
    hideZero
  );

  // Compute net income helper (Income - COGS - Expense - OtherExpense)
  const netIncomeFrom = (balMap: Map<number, bigint>): bigint => {
    let net4 = 0n;
    for (const m of chart.values()) {
      const amt4 = balMap.get(m.id) ?? 0n;
      if (amt4 === 0n) continue;
      if (m.accountType === 'Income') net4 += amt4;
      else if (m.accountType === 'CostOfGoodsSold' || m.accountType === 'Expense' || m.accountType === 'OtherExpense') {
        net4 -= amt4;
      }
    }
    return net4;
  };

  const allTimeNet4 = netIncomeFrom(cumBalances);
  const currentFyNet4 = netIncomeFrom(fyBalances);
  const priorYearsNet4 = allTimeNet4 - currentFyNet4;

  // SlowBooks #708 naming rule: if 3200 Retained Earnings already holds a posted balance,
  // name unclosed prior-year net income "Net Income, prior years" instead of repeating "Retained Earnings".
  const hasPosted3200 = postedEquitySec.lines.some(
    l => l.accountCode === '3200' && parseDecimal4(l.amount) !== 0n
  );

  const equityLines: StatementLineItem[] = [...postedEquitySec.lines];
  if (priorYearsNet4 !== 0n) {
    const label = hasPosted3200 ? 'Net Income, prior years' : 'Retained Earnings';
    equityLines.push({
      accountId: null,
      accountCode: null,
      accountName: label,
      accountPath: label,
      detailType: 'equity',
      amount: formatDecimal4(priorYearsNet4),
      amountNum: toMoneyNumber(priorYearsNet4, prefs.roundingMode),
      syntheticLine: 'retained_earnings',
    });
  }
  if (currentFyNet4 !== 0n || priorYearsNet4 === 0n) {
    equityLines.push({
      accountId: null,
      accountCode: null,
      accountName: 'Net Income',
      accountPath: 'Net Income',
      detailType: 'equity',
      amount: formatDecimal4(currentFyNet4),
      amountNum: toMoneyNumber(currentFyNet4, prefs.roundingMode),
      syntheticLine: 'net_income',
    });
  }

  const totalAssets4 = currentAssetsSec.total4 + fixedAssetsSec.total4 + otherAssetsSec.total4;
  const totalLiabilities4 = currentLiabSec.total4 + longTermLiabSec.total4;
  const totalEquity4 = postedEquitySec.total4 + allTimeNet4;
  const totalLiabilitiesAndEquity4 = totalLiabilities4 + totalEquity4;

  return {
    companyId,
    asOfDate,
    fiscalYearStartDate: fyStart,
    basis,
    excludeAdjusting: Boolean(options.excludeAdjusting),
    hideZero,
    roundingMode: prefs.roundingMode,
    groups: {
      currentAssets: currentAssetsSec.lines,
      fixedAssets: fixedAssetsSec.lines,
      otherAssets: otherAssetsSec.lines,
      currentLiabilities: currentLiabSec.lines,
      longTermLiabilities: longTermLiabSec.lines,
      equity: equityLines,
    },
    totals: {
      totalCurrentAssets: formatDecimal4(currentAssetsSec.total4),
      totalCurrentAssetsNum: toMoneyNumber(currentAssetsSec.total4, prefs.roundingMode),
      totalFixedAssets: formatDecimal4(fixedAssetsSec.total4),
      totalFixedAssetsNum: toMoneyNumber(fixedAssetsSec.total4, prefs.roundingMode),
      totalOtherAssets: formatDecimal4(otherAssetsSec.total4),
      totalOtherAssetsNum: toMoneyNumber(otherAssetsSec.total4, prefs.roundingMode),
      totalAssets: formatDecimal4(totalAssets4),
      totalAssetsNum: toMoneyNumber(totalAssets4, prefs.roundingMode),
      totalCurrentLiabilities: formatDecimal4(currentLiabSec.total4),
      totalCurrentLiabilitiesNum: toMoneyNumber(currentLiabSec.total4, prefs.roundingMode),
      totalLongTermLiabilities: formatDecimal4(longTermLiabSec.total4),
      totalLongTermLiabilitiesNum: toMoneyNumber(longTermLiabSec.total4, prefs.roundingMode),
      totalLiabilities: formatDecimal4(totalLiabilities4),
      totalLiabilitiesNum: toMoneyNumber(totalLiabilities4, prefs.roundingMode),
      postedEquity: formatDecimal4(postedEquitySec.total4),
      priorYearsNetIncome: formatDecimal4(priorYearsNet4),
      priorYearsNetIncomeNum: toMoneyNumber(priorYearsNet4, prefs.roundingMode),
      currentYearNetIncome: formatDecimal4(currentFyNet4),
      currentYearNetIncomeNum: toMoneyNumber(currentFyNet4, prefs.roundingMode),
      totalEquity: formatDecimal4(totalEquity4),
      totalEquityNum: toMoneyNumber(totalEquity4, prefs.roundingMode),
      totalLiabilitiesAndEquity: formatDecimal4(totalLiabilitiesAndEquity4),
      totalLiabilitiesAndEquityNum: toMoneyNumber(totalLiabilitiesAndEquity4, prefs.roundingMode),
      difference: formatDecimal4(totalAssets4 - totalLiabilitiesAndEquity4),
      isBalanced: totalAssets4 === totalLiabilitiesAndEquity4,
    },
  };
}

// ============================================================================
// 5. STATEMENT OF CASH FLOWS — INDIRECT METHOD (SlowBooks Parity)
// ============================================================================

export interface CashFlowRow {
  accountId: number | null;
  accountCode: string | null;
  accountName: string;
  group: 'net_income' | 'adjustments' | 'working_capital' | 'investing' | 'financing';
  amount: string;
  amountNum: number;
}

const ACCUMULATED_RE = /\baccum(?:ulated)?\b.*\b(?:dep(?:rec(?:iation)?)?|amort)/i;
// 'opening_balance' is a balance-sheet carry-in and must not appear in P&L / Cash Flow flows.
// 'closing_entry' zeroes out P&L accounts at period close — it must also be excluded from
// income statement queries so that closed-period P&L still shows the actual activity.
const CARRIED_IN_SOURCES = new Set(['opening_balance', 'closing_entry']);

export async function getCashFlowStatement(
  tx: Transaction,
  companyId: number,
  options: { startDate?: string; endDate?: string } = {}
) {
  const prefs = await getCompanyAccountingPrefs(tx, companyId);
  const endDate = validateIsoDate(options.endDate, todayIso(), 'endDate');
  const startDate = validateIsoDate(
    options.startDate,
    resolveFiscalYearStart(endDate, prefs.fiscalYearStartMonth),
    'startDate'
  );
  if (startDate > endDate) {
    throw new AccountingError(400, 'startDate cannot be after endDate', 'INVALID_DATE_RANGE');
  }

  const chart = await loadCompanyChart(tx, companyId);
  const cashAccountIds = Array.from(chart.values())
    .filter(m => m.accountType === 'Bank' || m.bankKind === 'bank')
    .map(m => m.id);

  // Check fixed_asset_types linked accounts if populated
  const fixedAssetTypesRes = await tx.query<{
    asset_account_id: number | null;
    accum_depr_account_id: number | null;
  }>(
    `SELECT DISTINCT asset_account_id, accum_depr_account_id FROM fixed_asset_types WHERE company_id = $1`,
    [companyId]
  );

  const fixedIds = new Set<number>();
  const accumIds = new Set<number>();
  for (const r of fixedAssetTypesRes.rows) {
    if (r.asset_account_id) fixedIds.add(Number(r.asset_account_id));
    if (r.accum_depr_account_id) accumIds.add(Number(r.accum_depr_account_id));
  }

  const classifyCashFlowPlacement = (
    m: AccountMeta
  ): 'net_income' | 'adjustments' | 'working_capital' | 'investing' | 'financing' => {
    if (!BALANCE_SHEET_TYPES.has(m.accountType)) return 'net_income';
    if (m.accountType === 'Equity') return 'financing';
    if (m.accountType === 'LongTermLiability' || m.detailType === 'long_term_liability') return 'financing';
    if (['AccountsPayable', 'CreditCard', 'OtherCurrentLiability', 'PayrollLiability'].includes(m.accountType)) {
      return 'working_capital';
    }
    // Assets
    if (accumIds.has(m.id) || ACCUMULATED_RE.test(m.name) || m.code === '1590') {
      return 'adjustments';
    }
    if (fixedIds.has(m.id) || m.accountType === 'FixedAsset' || ['fixed_asset', 'other_asset'].includes(m.detailType)) {
      return 'investing';
    }
    return 'working_capital';
  };

  // Query period flows (Credit - Debit on accrual/both ledger), grouped by account & source_type
  const flowsRes = await tx.query<{ account_id: number; source_type: string; dr: string; cr: string }>(
    `SELECT jl.account_id,
            jt.source_type,
            COALESCE(SUM(jl.debit), 0)::NUMERIC(19,4)::text AS dr,
            COALESCE(SUM(jl.credit), 0)::NUMERIC(19,4)::text AS cr
       FROM journal_lines jl
       JOIN journal_transactions jt
         ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
      WHERE jl.company_id = $1
        AND jt.is_posted = TRUE
         
        AND jl.basis IN ('both', 'accrual')
        AND jt.txn_date BETWEEN $2::DATE AND $3::DATE
      GROUP BY jl.account_id, jt.source_type`,
    [companyId, startDate, endDate]
  );

  const regularByAcct = new Map<number, bigint>();
  for (const r of flowsRes.rows) {
    if (CARRIED_IN_SOURCES.has(r.source_type)) continue;
    const aid = Number(r.account_id);
    const crMinusDr = parseDecimal4(r.cr) - parseDecimal4(r.dr);
    regularByAcct.set(aid, (regularByAcct.get(aid) ?? 0n) + crMinusDr);
  }

  let netIncome4 = 0n;
  const adjustments: CashFlowRow[] = [];
  const workingCapital: CashFlowRow[] = [];
  const investing: CashFlowRow[] = [];
  const financing: CashFlowRow[] = [];

  const cashSet = new Set(cashAccountIds);
  const touchedIds = Array.from(regularByAcct.keys())
    .filter(id => !cashSet.has(id) && chart.has(id))
    .sort((a, b) => compareAccountsByCode(chart.get(a)!, chart.get(b)!));

  for (const aid of touchedIds) {
    const meta = chart.get(aid)!;
    const flow4 = regularByAcct.get(aid) ?? 0n;
    const place = classifyCashFlowPlacement(meta);
    if (place === 'net_income') {
      // Credit - Debit is already positive for Income and negative for COGS/Expense
      netIncome4 += flow4;
      continue;
    }
    if (flow4 === 0n) continue;

    const label = place === 'adjustments' ? `Non-cash adjustment (${meta.name})` : meta.name;
    const row: CashFlowRow = {
      accountId: meta.id,
      accountCode: meta.code,
      accountName: label,
      group: place,
      amount: formatDecimal4(flow4),
      amountNum: toMoneyNumber(flow4, prefs.roundingMode),
    };
    if (place === 'adjustments') adjustments.push(row);
    else if (place === 'working_capital') workingCapital.push(row);
    else if (place === 'investing') investing.push(row);
    else financing.push(row);
  }

  const sumRows = (rows: CashFlowRow[]) => rows.reduce((s, r) => s + parseDecimal4(r.amount), 0n);

  const totalOperating4 = netIncome4 + sumRows(adjustments) + sumRows(workingCapital);
  const totalInvesting4 = sumRows(investing);
  const totalFinancing4 = sumRows(financing);
  const netChange4 = totalOperating4 + totalInvesting4 + totalFinancing4;

  // Beginning Cash = Cash < startDate + Cash opening_balance rows inside [startDate, endDate]
  let beginningCash4 = 0n;
  let endingCash4 = 0n;
  if (cashAccountIds.length > 0) {
    const begRes = await tx.query<{ dr: string; cr: string }>(
      `SELECT COALESCE(SUM(jl.debit), 0)::NUMERIC(19,4)::text AS dr,
              COALESCE(SUM(jl.credit), 0)::NUMERIC(19,4)::text AS cr
         FROM journal_lines jl
         JOIN journal_transactions jt
           ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
        WHERE jl.company_id = $1
          AND jt.is_posted = TRUE
         
          AND jl.basis IN ('both', 'accrual')
          AND jl.account_id = ANY($2::BIGINT[])
          AND (
            jt.txn_date < $3::DATE
            OR (jt.txn_date BETWEEN $3::DATE AND $4::DATE AND jt.source_type = 'opening_balance')
          )`,
      [companyId, cashAccountIds, startDate, endDate]
    );
    beginningCash4 = parseDecimal4(begRes.rows[0].dr) - parseDecimal4(begRes.rows[0].cr);

    const endRes = await tx.query<{ dr: string; cr: string }>(
      `SELECT COALESCE(SUM(jl.debit), 0)::NUMERIC(19,4)::text AS dr,
              COALESCE(SUM(jl.credit), 0)::NUMERIC(19,4)::text AS cr
         FROM journal_lines jl
         JOIN journal_transactions jt
           ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
        WHERE jl.company_id = $1
          AND jt.is_posted = TRUE
         
          AND jl.basis IN ('both', 'accrual')
          AND jl.account_id = ANY($2::BIGINT[])
          AND jt.txn_date <= $3::DATE`,
      [companyId, cashAccountIds, endDate]
    );
    endingCash4 = parseDecimal4(endRes.rows[0].dr) - parseDecimal4(endRes.rows[0].cr);
  }

  const operating: CashFlowRow[] = [
    {
      accountId: null,
      accountCode: null,
      accountName: 'Net Income',
      group: 'net_income',
      amount: formatDecimal4(netIncome4),
      amountNum: toMoneyNumber(netIncome4, prefs.roundingMode),
    },
    ...adjustments,
    ...workingCapital,
  ];

  const isReconciled = beginningCash4 + netChange4 === endingCash4;

  return {
    companyId,
    startDate,
    endDate,
    roundingMode: prefs.roundingMode,
    netIncome: formatDecimal4(netIncome4),
    netIncomeNum: toMoneyNumber(netIncome4, prefs.roundingMode),
    adjustments,
    workingCapital,
    operating,
    investing,
    financing,
    totalOperating: formatDecimal4(totalOperating4),
    totalOperatingNum: toMoneyNumber(totalOperating4, prefs.roundingMode),
    totalInvesting: formatDecimal4(totalInvesting4),
    totalInvestingNum: toMoneyNumber(totalInvesting4, prefs.roundingMode),
    totalFinancing: formatDecimal4(totalFinancing4),
    totalFinancingNum: toMoneyNumber(totalFinancing4, prefs.roundingMode),
    netChange: formatDecimal4(netChange4),
    netChangeNum: toMoneyNumber(netChange4, prefs.roundingMode),
    beginningCash: formatDecimal4(beginningCash4),
    beginningCashNum: toMoneyNumber(beginningCash4, prefs.roundingMode),
    endingCash: formatDecimal4(endingCash4),
    endingCashNum: toMoneyNumber(endingCash4, prefs.roundingMode),
    reconciliationVariance: formatDecimal4(beginningCash4 + netChange4 - endingCash4),
    isReconciled,
  };
}

// ============================================================================
// CSV FORMATTERS (Exact Server-Side Financial Statement CSV Exports)
// ============================================================================

function csvCell(val: string | number | null | undefined): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function formatTrialBalanceCsv(
  tb: Awaited<ReturnType<typeof getTrialBalance>>
): string {
  const lines = [
    'Code,Account Name,Type,Debit,Credit',
    ...tb.rows.map(r =>
      [
        csvCell(r.accountCode || ''),
        csvCell(r.accountPath),
        csvCell(r.accountType),
        csvCell(formatDecimal2(parseDecimal4(r.debit), tb.roundingMode)),
        csvCell(formatDecimal2(parseDecimal4(r.credit), tb.roundingMode)),
      ].join(',')
    ),
    [
      'Total',
      '',
      '',
      csvCell(formatDecimal2(parseDecimal4(tb.totalDebit), tb.roundingMode)),
      csvCell(formatDecimal2(parseDecimal4(tb.totalCredit), tb.roundingMode)),
    ].join(','),
  ];
  return lines.join('\n');
}

export function formatProfitAndLossCsv(
  pl: Awaited<ReturnType<typeof getProfitAndLoss>>
): string {
  const rows: string[] = ['Section,Code,Account,Amount'];
  const pushSec = (label: string, items: StatementLineItem[]) => {
    for (const item of items) {
      rows.push(
        [
          csvCell(label),
          csvCell(item.accountCode || ''),
          csvCell(item.accountPath),
          csvCell(formatDecimal2(parseDecimal4(item.amount), pl.roundingMode)),
        ].join(',')
      );
    }
  };
  pushSec('Operating Income', pl.sections.income);
  pushSec('Cost of Goods Sold', pl.sections.cogs);
  pushSec('Operating Expenses', pl.sections.expenses);
  pushSec('Other Income', pl.sections.otherIncome);
  pushSec('Other Expenses', pl.sections.otherExpense);
  rows.push(['Gross Profit', '', '', formatDecimal2(parseDecimal4(pl.totals.operatingGrossProfit), pl.roundingMode)].join(','));
  rows.push(['Net Operating Income', '', '', formatDecimal2(parseDecimal4(pl.totals.netOperatingIncome), pl.roundingMode)].join(','));
  rows.push(['Net Income', '', '', formatDecimal2(parseDecimal4(pl.totals.netIncome), pl.roundingMode)].join(','));
  return rows.join('\n');
}

export function formatBalanceSheetCsv(
  bs: Awaited<ReturnType<typeof getBalanceSheet>>
): string {
  const rows: string[] = ['Section,Code,Account,Amount'];
  const pushSec = (label: string, items: StatementLineItem[]) => {
    for (const item of items) {
      rows.push(
        [
          csvCell(label),
          csvCell(item.accountCode || ''),
          csvCell(item.accountPath),
          csvCell(formatDecimal2(parseDecimal4(item.amount), bs.roundingMode)),
        ].join(',')
      );
    }
  };
  pushSec('Current Assets', bs.groups.currentAssets);
  pushSec('Fixed Assets', bs.groups.fixedAssets);
  pushSec('Other Assets', bs.groups.otherAssets);
  pushSec('Current Liabilities', bs.groups.currentLiabilities);
  pushSec('Long-Term Liabilities', bs.groups.longTermLiabilities);
  pushSec('Equity', bs.groups.equity);
  rows.push(['Total Assets', '', '', formatDecimal2(parseDecimal4(bs.totals.totalAssets), bs.roundingMode)].join(','));
  rows.push(['Total Liabilities', '', '', formatDecimal2(parseDecimal4(bs.totals.totalLiabilities), bs.roundingMode)].join(','));
  rows.push(['Total Equity', '', '', formatDecimal2(parseDecimal4(bs.totals.totalEquity), bs.roundingMode)].join(','));
  rows.push([
    'Total Liabilities & Equity',
    '',
    '',
    formatDecimal2(parseDecimal4(bs.totals.totalLiabilitiesAndEquity), bs.roundingMode),
  ].join(','));
  return rows.join('\n');
}

export function formatCashFlowCsv(
  cf: Awaited<ReturnType<typeof getCashFlowStatement>>
): string {
  const rows: string[] = ['Activity,Account,Amount'];
  for (const r of cf.operating) {
    rows.push(['Operating', csvCell(r.accountName), formatDecimal2(parseDecimal4(r.amount), cf.roundingMode)].join(','));
  }
  rows.push(['Net Cash from Operating Activities', '', formatDecimal2(parseDecimal4(cf.totalOperating), cf.roundingMode)].join(','));
  for (const r of cf.investing) {
    rows.push(['Investing', csvCell(r.accountName), formatDecimal2(parseDecimal4(r.amount), cf.roundingMode)].join(','));
  }
  rows.push(['Net Cash from Investing Activities', '', formatDecimal2(parseDecimal4(cf.totalInvesting), cf.roundingMode)].join(','));
  for (const r of cf.financing) {
    rows.push(['Financing', csvCell(r.accountName), formatDecimal2(parseDecimal4(r.amount), cf.roundingMode)].join(','));
  }
  rows.push(['Net Cash from Financing Activities', '', formatDecimal2(parseDecimal4(cf.totalFinancing), cf.roundingMode)].join(','));
  rows.push(['Net Change in Cash', '', formatDecimal2(parseDecimal4(cf.netChange), cf.roundingMode)].join(','));
  rows.push(['Beginning Cash', '', formatDecimal2(parseDecimal4(cf.beginningCash), cf.roundingMode)].join(','));
  rows.push(['Ending Cash', '', formatDecimal2(parseDecimal4(cf.endingCash), cf.roundingMode)].join(','));
  return rows.join('\n');
}
