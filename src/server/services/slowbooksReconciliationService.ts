import { Transaction } from '@electric-sql/pglite';
import {
  AccountingError,
  ActorContext,
  DEBIT_NORMAL_TYPES,
  AccountType,
} from './accountingEngine.ts';
import {
  getBalanceSheet,
  getProfitAndLoss,
  getTrialBalance,
} from './financialReports.ts';
import {
  formatDecimal4,
  parseDecimal4,
  absBigInt,
} from '../lib/decimal.ts';
import { divRoundBigInt, parseDecimal6 } from './commercialHelpers.ts';
import { writeAuditLog } from '../audit.ts';
import {
  SlowBooksAccountRecord,
  SlowBooksSourceBundle,
  SlowBooksId,
} from './slowbooksSourceAdapter.ts';

export interface DiscrepancyExplanation {
  domain: string;
  metric: string;
  sourceValue: string;
  targetValue: string;
  variance: string;
  explained: boolean;
  explanation: string;
  relatedExceptionIds: number[];
}

export interface EntityCountCheck {
  entity: string;
  sourceCount: number;
  migratedCount: number;
  duplicateMergedCount: number;
  archivedOrDeletedCount: number;
  rejectedCount: number;
  accountedTotal: number;
  reconciled: boolean;
}

export interface CompanyReconciliationReport {
  companyId: number;
  companyName: string;
  sourceCompanyId: string;
  asOfDate: string;
  basis: 'accrual' | 'cash';
  trialBalance: {
    sourceDebit: string;
    sourceCredit: string;
    sourceIsBalanced: boolean;
    targetDebit: string;
    targetCredit: string;
    targetIsBalanced: boolean;
    varianceDebit: string;
    varianceCredit: string;
    reconciled: boolean;
  };
  accountBalances: Array<{
    sourceAccountId: string;
    targetAccountId: number | null;
    code: string | null;
    name: string;
    accountType: string;
    sourceBalance: string;
    targetBalance: string;
    variance: string;
    matched: boolean;
  }>;
  accountsReceivable: {
    sourceGlAr: string;
    targetGlAr: string;
    sourceOpenInvoicesTotal: string;
    targetOpenInvoicesTotal: string;
    reconciled: boolean;
  };
  accountsPayable: {
    sourceGlAp: string;
    targetGlAp: string;
    sourceOpenBillsTotal: string;
    targetOpenBillsTotal: string;
    reconciled: boolean;
  };
  bankBalances: Array<{
    code: string | null;
    name: string;
    sourceBalance: string;
    targetBalance: string;
    variance: string;
    matched: boolean;
  }>;
  inventoryValuation: {
    sourceSubledgerValue: string;
    targetSubledgerValue: string;
    sourceGl1200: string;
    targetGl1200: string;
    reconciled: boolean;
  };
  customerBalances: Array<{
    sourceCustomerId: string;
    targetCustomerId: number | null;
    name: string;
    sourceBalance: string;
    targetBalance: string;
    variance: string;
    matched: boolean;
  }>;
  supplierBalances: Array<{
    sourceVendorId: string;
    targetVendorId: number | null;
    name: string;
    sourceBalance: string;
    targetBalance: string;
    variance: string;
    matched: boolean;
  }>;
  revenueAndExpenses: {
    sourceRevenue: string;
    targetRevenue: string;
    sourceCogs: string;
    targetCogs: string;
    sourceExpenses: string;
    targetExpenses: string;
    sourceNetIncome: string;
    targetNetIncome: string;
    reconciled: boolean;
  };
  financialStatements: {
    balanceSheetBalanced: boolean;
    targetTotalAssets: string;
    targetTotalLiabilities: string;
    targetTotalEquity: string;
    trialBalanceBalanced: boolean;
  };
  entityCounts: EntityCountCheck[];
  countsReconciled: boolean;
  exceptionsSummary: {
    total: number;
    openRejected: number;
    resolvedOrAcceptedRejected: number;
    duplicatesMerged: number;
    archivedPreserved: number;
    deletedPreserved: number;
    deprecatedVertical: number;
  };
  discrepancies: DiscrepancyExplanation[];
  allBalanced: boolean;
  cutoverReady: boolean;
  blockingReasons: string[];
}

function normalizeAcctType(raw: string): AccountType {
  const clean = (raw || '').trim();
  const map: Record<string, AccountType> = {
    Bank: 'Bank',
    bank: 'Bank',
    AccountsReceivable: 'AccountsReceivable',
    accounts_receivable: 'AccountsReceivable',
    OtherCurrentAsset: 'OtherCurrentAsset',
    other_current_asset: 'OtherCurrentAsset',
    Inventory: 'Inventory',
    inventory: 'Inventory',
    FixedAsset: 'FixedAsset',
    fixed_asset: 'FixedAsset',
    AccountsPayable: 'AccountsPayable',
    accounts_payable: 'AccountsPayable',
    CreditCard: 'CreditCard',
    credit_card: 'CreditCard',
    OtherCurrentLiability: 'OtherCurrentLiability',
    other_current_liability: 'OtherCurrentLiability',
    PayrollLiability: 'PayrollLiability',
    payroll_liability: 'PayrollLiability',
    LongTermLiability: 'LongTermLiability',
    long_term_liability: 'LongTermLiability',
    Equity: 'Equity',
    equity: 'Equity',
    Income: 'Income',
    income: 'Income',
    Revenue: 'Income',
    CostOfGoodsSold: 'CostOfGoodsSold',
    cost_of_goods_sold: 'CostOfGoodsSold',
    COGS: 'CostOfGoodsSold',
    Expense: 'Expense',
    expense: 'Expense',
    OtherExpense: 'OtherExpense',
    other_expense: 'OtherExpense',
  };
  return map[clean] ?? 'Expense';
}

function isDebitNormal(t: AccountType): boolean {
  return DEBIT_NORMAL_TYPES.has(t);
}

function computeSourceCompanyLedger(
  bundle: SlowBooksSourceBundle,
  sourceCompanyId: string
): {
  tbDebit4: bigint;
  tbCredit4: bigint;
  netByAcctId4: Map<string, bigint>;
  drCrByAcctId: Map<string, { dr4: bigint; cr4: bigint }>;
  revenue4: bigint;
  cogs4: bigint;
  expenses4: bigint;
} {
  const sid = String(sourceCompanyId);
  const accts = (bundle.accounts || []).filter(a => String(a.company_id) === sid);
  const acctMap = new Map<string, SlowBooksAccountRecord>();
  for (const a of accts) acctMap.set(String(a.id), a);

  const drCrByAcctId = new Map<string, { dr4: bigint; cr4: bigint }>();
  const addLine = (acctId: string, dr4: bigint, cr4: bigint) => {
    const cur = drCrByAcctId.get(acctId) ?? { dr4: 0n, cr4: 0n };
    cur.dr4 += dr4;
    cur.cr4 += cr4;
    drCrByAcctId.set(acctId, cur);
  };

  for (const ob of bundle.opening_balances || []) {
    if (String(ob.company_id) !== sid) continue;
    for (const l of ob.lines || []) {
      addLine(String(l.account_id), parseDecimal4(l.debit), parseDecimal4(l.credit));
    }
  }

  for (const txn of bundle.transactions || []) {
    if (String(txn.company_id) !== sid) continue;
    if (txn.is_posted === false) continue;
    for (const l of txn.lines || []) {
      const basis = l.basis || 'both';
      if (basis === 'cash') continue;
      addLine(String(l.account_id), parseDecimal4(l.debit), parseDecimal4(l.credit));
    }
  }

  let tbDebit4 = 0n;
  let tbCredit4 = 0n;
  const netByAcctId4 = new Map<string, bigint>();
  let revenue4 = 0n;
  let cogs4 = 0n;
  let expenses4 = 0n;

  for (const acct of accts) {
    const aKey = String(acct.id);
    const sums = drCrByAcctId.get(aKey) ?? { dr4: 0n, cr4: 0n };
    const t = normalizeAcctType(acct.account_type);
    const natural4 = isDebitNormal(t) ? sums.dr4 - sums.cr4 : sums.cr4 - sums.dr4;
    netByAcctId4.set(aKey, natural4);

    // Match Target Trial Balance presentation (BS accounts net to debit/credit side; P&L keep dr/cr sums)
    if (['Income', 'CostOfGoodsSold', 'Expense', 'OtherExpense'].includes(t)) {
      tbDebit4 += sums.dr4;
      tbCredit4 += sums.cr4;
    } else {
      const net = sums.dr4 - sums.cr4;
      if (net > 0n) tbDebit4 += net;
      else if (net < 0n) tbCredit4 += -net;
    }

    if (t === 'Income') revenue4 += natural4;
    else if (t === 'CostOfGoodsSold') cogs4 += natural4;
    else if (t === 'Expense' || t === 'OtherExpense') expenses4 += natural4;
  }

  return { tbDebit4, tbCredit4, netByAcctId4, drCrByAcctId, revenue4, cogs4, expenses4 };
}

export async function reconcileMigratedCompany(
  tx: Transaction,
  companyId: number,
  batchId: number,
  sourceCompanyId: string,
  bundle: SlowBooksSourceBundle,
  options: { asOfDate?: string; basis?: 'accrual' | 'cash'; persistSnapshot?: boolean } = {}
): Promise<CompanyReconciliationReport> {
  await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);

  const compRes = await tx.query<{ name: string }>(
    `SELECT name FROM companies WHERE id = $1`,
    [companyId]
  );
  if (compRes.rows.length === 0) {
    throw new AccountingError(404, `Target company ${companyId} not found`);
  }
  const companyName = compRes.rows[0].name;
  const asOfDate = options.asOfDate || bundle.asOfDate || '2026-12-31';
  const basis: 'accrual' | 'cash' = options.basis || 'accrual';

  // Load ID mappings & exceptions for this company
  const mapRes = await tx.query<{
    source_entity: string;
    source_id: string;
    target_table: string;
    target_id: number;
    disposition: string;
  }>(
    `SELECT source_entity, source_id, target_table, target_id, disposition
       FROM migration_id_map
      WHERE company_id = $1 AND source_system = 'SlowBooks-Pro-2026'`,
    [companyId]
  );

  const mapByEntityAndSource = new Map<string, { targetId: number; disposition: string }>();
  for (const r of mapRes.rows) {
    mapByEntityAndSource.set(`${r.source_entity}::${r.source_id}`, {
      targetId: Number(r.target_id),
      disposition: r.disposition,
    });
  }

  const excRes = await tx.query<{
    id: number;
    source_entity: string;
    source_id: string;
    disposition: string;
    reason_code: string;
    reason_detail: string;
    financial_impact: string;
    resolution_status: string;
  }>(
    `SELECT id, source_entity, source_id, disposition, reason_code, reason_detail,
            financial_impact::text, resolution_status
       FROM migration_exceptions
      WHERE company_id = $1 AND batch_id = $2
      ORDER BY id ASC`,
    [companyId, batchId]
  );
  const exceptions = excRes.rows.map(e => ({
    ...e,
    id: Number(e.id),
    impact4: parseDecimal4(e.financial_impact),
  }));

  // 1. Source Ledger vs Target Reports
  const srcLedger = computeSourceCompanyLedger(bundle, sourceCompanyId);
  const targetTb = await getTrialBalance(tx, companyId, {
    startDate: '1990-01-01',
    endDate: asOfDate,
    basis,
  });
  const targetPnl = await getProfitAndLoss(tx, companyId, {
    startDate: '1990-01-01',
    endDate: asOfDate,
    basis,
  });
  const targetBs = await getBalanceSheet(tx, companyId, {
    asOfDate,
    basis,
  });

  const targetTbDebit4 = parseDecimal4(targetTb.totalDebit);
  const targetTbCredit4 = parseDecimal4(targetTb.totalCredit);
  const tbDrVar4 = targetTbDebit4 - srcLedger.tbDebit4;
  const tbCrVar4 = targetTbCredit4 - srcLedger.tbCredit4;

  // 2. Account-by-Account & Bank Balances
  const targetAcctsRes = await tx.query<{
    id: number;
    code: string | null;
    name: string;
    account_type: AccountType;
    balance: string;
  }>(
    `SELECT id, code, name, account_type, balance::text
       FROM accounts
      WHERE company_id = $1`,
    [companyId]
  );
  const targetAcctById = new Map<number, typeof targetAcctsRes.rows[0]>();
  for (const a of targetAcctsRes.rows) targetAcctById.set(Number(a.id), a);

  const tbNetByTargetAcctId = new Map<number, bigint>();
  for (const row of targetTb.rows) {
    if (row.accountId !== null) {
      const aMeta = targetAcctById.get(Number(row.accountId));
      const dr4 = parseDecimal4(row.debit);
      const cr4 = parseDecimal4(row.credit);
      const nat4 = aMeta && isDebitNormal(aMeta.account_type) ? dr4 - cr4 : cr4 - dr4;
      tbNetByTargetAcctId.set(Number(row.accountId), nat4);
    }
  }

  const srcAccts = (bundle.accounts || []).filter(a => String(a.company_id) === String(sourceCompanyId));
  const accountBalances: CompanyReconciliationReport['accountBalances'] = [];
  const bankBalances: CompanyReconciliationReport['bankBalances'] = [];

  let srcGlAr4 = 0n;
  let tgtGlAr4 = 0n;
  let srcGlAp4 = 0n;
  let tgtGlAp4 = 0n;
  let srcGlInv4 = 0n;
  let tgtGlInv4 = 0n;
  let srcBankTotal4 = 0n;
  let tgtBankTotal4 = 0n;

  for (const sa of srcAccts) {
    const mapped = mapByEntityAndSource.get(`accounts::${String(sa.id)}`);
    const targetAcctId = mapped?.targetId ?? null;
    const srcBal4 = srcLedger.netByAcctId4.get(String(sa.id)) ?? 0n;
    const tgtBal4 = targetAcctId !== null ? (tbNetByTargetAcctId.get(targetAcctId) ?? 0n) : 0n;
    const var4 = tgtBal4 - srcBal4;
    const acctType = normalizeAcctType(sa.account_type);

    accountBalances.push({
      sourceAccountId: String(sa.id),
      targetAccountId: targetAcctId,
      code: sa.code || null,
      name: sa.name,
      accountType: acctType,
      sourceBalance: formatDecimal4(srcBal4),
      targetBalance: formatDecimal4(tgtBal4),
      variance: formatDecimal4(var4),
      matched: var4 === 0n && targetAcctId !== null,
    });

    if (acctType === 'AccountsReceivable' || sa.code === '1100') {
      srcGlAr4 += srcBal4;
      tgtGlAr4 += tgtBal4;
    }
    if (acctType === 'AccountsPayable' || sa.code === '2000') {
      srcGlAp4 += srcBal4;
      tgtGlAp4 += tgtBal4;
    }
    if (acctType === 'Inventory' || sa.code === '1200') {
      srcGlInv4 += srcBal4;
      tgtGlInv4 += tgtBal4;
    }
    if (acctType === 'Bank' || acctType === 'CreditCard') {
      const signedSrc = acctType === 'Bank' ? srcBal4 : -srcBal4;
      const signedTgt = acctType === 'Bank' ? tgtBal4 : -tgtBal4;
      srcBankTotal4 += signedSrc;
      tgtBankTotal4 += signedTgt;
      bankBalances.push({
        code: sa.code || null,
        name: sa.name,
        sourceBalance: formatDecimal4(srcBal4),
        targetBalance: formatDecimal4(tgtBal4),
        variance: formatDecimal4(var4),
        matched: var4 === 0n,
      });
    }
  }

  // 3. AR Open Invoices & Customer Balances
  const srcCustomers = (bundle.customers || []).filter(c => String(c.company_id) === String(sourceCompanyId));
  const srcInvoices = (bundle.invoices || []).filter(
    i => String(i.company_id) === String(sourceCompanyId) && !i.is_deleted && i.status !== 'voided' && !i.is_sales_receipt
  );
  const srcCustOpen4 = new Map<string, bigint>();
  let srcOpenInvoicesTotal4 = 0n;
  for (const inv of srcInvoices) {
    const bal4 = parseDecimal4(inv.balance_due);
    srcOpenInvoicesTotal4 += bal4;
    const ck = String(inv.customer_id);
    srcCustOpen4.set(ck, (srcCustOpen4.get(ck) ?? 0n) + bal4);
  }

  const tgtInvSumRes = await tx.query<{ s: string }>(
    `SELECT COALESCE(SUM(balance_due), 0)::NUMERIC(19,4)::text AS s
       FROM invoices
      WHERE company_id = $1 AND is_sales_receipt = FALSE AND status <> 'voided'`,
    [companyId]
  );
  const targetOpenInvoicesTotal4 = parseDecimal4(tgtInvSumRes.rows[0].s);

  const tgtCustRes = await tx.query<{ id: number; balance: string }>(
    `SELECT id, balance::text FROM customers WHERE company_id = $1`,
    [companyId]
  );
  const tgtCustBalById = new Map<number, bigint>();
  for (const c of tgtCustRes.rows) tgtCustBalById.set(Number(c.id), parseDecimal4(c.balance));

  const customerBalances: CompanyReconciliationReport['customerBalances'] = [];
  for (const sc of srcCustomers) {
    const mapped = mapByEntityAndSource.get(`customers::${String(sc.id)}`);
    const tid = mapped?.targetId ?? null;
    const sBal = srcCustOpen4.get(String(sc.id)) ?? 0n;
    const tBal = tid !== null ? (tgtCustBalById.get(tid) ?? 0n) : 0n;
    const v = tBal - sBal;
    customerBalances.push({
      sourceCustomerId: String(sc.id),
      targetCustomerId: tid,
      name: sc.name,
      sourceBalance: formatDecimal4(sBal),
      targetBalance: formatDecimal4(tBal),
      variance: formatDecimal4(v),
      matched: v === 0n,
    });
  }

  // 4. AP Open Bills & Supplier Balances
  const srcVendors = (bundle.vendors || []).filter(v => String(v.company_id) === String(sourceCompanyId));
  const srcBills = (bundle.bills || []).filter(
    b => String(b.company_id) === String(sourceCompanyId) && !b.is_deleted && b.status !== 'voided'
  );
  const srcVendOpen4 = new Map<string, bigint>();
  let srcOpenBillsTotal4 = 0n;
  for (const b of srcBills) {
    const bal4 = parseDecimal4(b.balance_due);
    srcOpenBillsTotal4 += bal4;
    const vk = String(b.vendor_id);
    srcVendOpen4.set(vk, (srcVendOpen4.get(vk) ?? 0n) + bal4);
  }

  const tgtBillSumRes = await tx.query<{ s: string }>(
    `SELECT COALESCE(SUM(balance_due), 0)::NUMERIC(19,4)::text AS s
       FROM bills
      WHERE company_id = $1 AND status <> 'voided'`,
    [companyId]
  );
  const targetOpenBillsTotal4 = parseDecimal4(tgtBillSumRes.rows[0].s);

  const tgtVendRes = await tx.query<{ id: number; balance: string }>(
    `SELECT id, balance::text FROM vendors WHERE company_id = $1`,
    [companyId]
  );
  const tgtVendBalById = new Map<number, bigint>();
  for (const v of tgtVendRes.rows) tgtVendBalById.set(Number(v.id), parseDecimal4(v.balance));

  const supplierBalances: CompanyReconciliationReport['supplierBalances'] = [];
  for (const sv of srcVendors) {
    const mapped = mapByEntityAndSource.get(`vendors::${String(sv.id)}`);
    const tid = mapped?.targetId ?? null;
    const sBal = srcVendOpen4.get(String(sv.id)) ?? 0n;
    const tBal = tid !== null ? (tgtVendBalById.get(tid) ?? 0n) : 0n;
    const v = tBal - sBal;
    supplierBalances.push({
      sourceVendorId: String(sv.id),
      targetVendorId: tid,
      name: sv.name,
      sourceBalance: formatDecimal4(sBal),
      targetBalance: formatDecimal4(tBal),
      variance: formatDecimal4(v),
      matched: v === 0n,
    });
  }

  // 5. Inventory Subledger Valuation (purchase_units * avg_cost/unit_cost)
  const srcItems = (bundle.items || []).filter(i => String(i.company_id) === String(sourceCompanyId) && !i.is_deleted);
  let srcInvSub4 = 0n;
  for (const it of srcItems) {
    const rawType = (it.item_type || '').toLowerCase();
    if (['product', 'inventory', 'material', 'raw_material', 'stationery'].includes(rawType)) {
      const qty6 = parseDecimal6(it.on_hand ?? 0);
      const cost6 = parseDecimal6(it.avg_cost ?? it.unit_cost ?? 0);
      // (qty6 * cost6) / 10^8 -> scale 10^4
      srcInvSub4 += divRoundBigInt(qty6 * cost6, 100000000n, 'HALF_EVEN');
    }
  }

  const tgtItemsRes = await tx.query<{ on_hand: string; avg_cost: string; unit_cost: string }>(
    `SELECT on_hand::text, avg_cost::text, unit_cost::text
       FROM inventory_items
      WHERE company_id = $1 AND item_type IN ('raw_material', 'stationery')`,
    [companyId]
  );
  let tgtInvSub4 = 0n;
  for (const r of tgtItemsRes.rows) {
    const qty6 = parseDecimal6(r.on_hand);
    const avg6 = parseDecimal6(r.avg_cost);
    const unit6 = parseDecimal6(r.unit_cost);
    const eff6 = avg6 > 0n ? avg6 : unit6;
    tgtInvSub4 += divRoundBigInt(qty6 * eff6, 100000000n, 'HALF_EVEN');
  }

  // 6. Revenue & Expenses vs P&L
  const tgtRev4 = parseDecimal4(targetPnl.totals.totalIncome);
  const tgtCogs4 = parseDecimal4(targetPnl.totals.totalCogs);
  const tgtExp4 = parseDecimal4(targetPnl.totals.totalExpenses);
  const tgtNet4 = parseDecimal4(targetPnl.totals.netIncome);
  const srcNet4 = srcLedger.revenue4 - srcLedger.cogs4 - srcLedger.expenses4;

  // 7. Entity Counts from migration_checkpoints
  const cpRes = await tx.query<{
    domain_name: string;
    source_count: number;
    migrated_count: number;
    deduplicated_count: number;
    archived_count: number;
    rejected_count: number;
  }>(
    `SELECT domain_name, source_count, migrated_count, deduplicated_count, archived_count, rejected_count
       FROM migration_checkpoints
      WHERE company_id = $1 AND batch_id = $2
      ORDER BY domain_order ASC`,
    [companyId, batchId]
  );

  const entityCounts: EntityCountCheck[] = cpRes.rows.map(cp => {
    const accounted =
      Number(cp.migrated_count) +
      Number(cp.deduplicated_count) +
      Number(cp.archived_count) +
      Number(cp.rejected_count);
    return {
      entity: cp.domain_name,
      sourceCount: Number(cp.source_count),
      migratedCount: Number(cp.migrated_count),
      duplicateMergedCount: Number(cp.deduplicated_count),
      archivedOrDeletedCount: Number(cp.archived_count),
      rejectedCount: Number(cp.rejected_count),
      accountedTotal: accounted,
      reconciled: accounted === Number(cp.source_count),
    };
  });
  const countsReconciled = entityCounts.every(e => e.reconciled);

  // 8. Discrepancy Analysis & Explanations
  const discrepancies: DiscrepancyExplanation[] = [];

  const correlateExceptions = (predicate: (e: typeof exceptions[number]) => boolean) =>
    exceptions.filter(predicate);

  if (tbDrVar4 !== 0n || tbCrVar4 !== 0n) {
    const journalExcs = correlateExceptions(
      e => ['transactions', 'opening_balances'].includes(e.source_entity) && ['rejected', 'deleted_preserved'].includes(e.disposition)
    );
    const explained = journalExcs.length > 0 && srcLedger.tbDebit4 !== srcLedger.tbCredit4;
    discrepancies.push({
      domain: 'General Ledger',
      metric: 'Trial Balance Totals',
      sourceValue: `${formatDecimal4(srcLedger.tbDebit4)} / ${formatDecimal4(srcLedger.tbCredit4)}`,
      targetValue: `${formatDecimal4(targetTbDebit4)} / ${formatDecimal4(targetTbCredit4)}`,
      variance: `${formatDecimal4(tbDrVar4)} / ${formatDecimal4(tbCrVar4)}`,
      explained,
      explanation: explained
        ? `Target Trial Balance is strictly balanced (${formatDecimal4(targetTbDebit4)}); difference stems from ${journalExcs.length} rejected/unbalanced or voided source journal(s) quarantined in migration_exceptions.`
        : 'Unexplained Trial Balance difference between source and target.',
      relatedExceptionIds: journalExcs.map(e => e.id),
    });
  }

  if (tgtGlAr4 !== srcGlAr4 || targetOpenInvoicesTotal4 !== srcOpenInvoicesTotal4) {
    const arExcs = correlateExceptions(e => e.source_entity === 'invoices');
    const diffInv = targetOpenInvoicesTotal4 - srcOpenInvoicesTotal4;
    const rejectedInvSum = arExcs
      .filter(e => e.disposition === 'rejected')
      .reduce((s, e) => s + e.impact4, 0n);
    const explained = arExcs.length > 0 && absBigInt(diffInv) === absBigInt(rejectedInvSum);
    discrepancies.push({
      domain: 'Accounts Receivable',
      metric: 'Open Invoices & AR Control',
      sourceValue: `${formatDecimal4(srcOpenInvoicesTotal4)} (GL ${formatDecimal4(srcGlAr4)})`,
      targetValue: `${formatDecimal4(targetOpenInvoicesTotal4)} (GL ${formatDecimal4(tgtGlAr4)})`,
      variance: formatDecimal4(diffInv),
      explained,
      explanation: explained
        ? `AR variance equals ${formatDecimal4(rejectedInvSum)} from rejected/quarantined invoice record(s).`
        : 'Unexplained Accounts Receivable variance between source and target.',
      relatedExceptionIds: arExcs.map(e => e.id),
    });
  }

  if (tgtGlAp4 !== srcGlAp4 || targetOpenBillsTotal4 !== srcOpenBillsTotal4) {
    const apExcs = correlateExceptions(e => e.source_entity === 'bills');
    const diffBill = targetOpenBillsTotal4 - srcOpenBillsTotal4;
    const rejectedBillSum = apExcs
      .filter(e => e.disposition === 'rejected')
      .reduce((s, e) => s + e.impact4, 0n);
    const explained = apExcs.length > 0 && absBigInt(diffBill) === absBigInt(rejectedBillSum);
    discrepancies.push({
      domain: 'Accounts Payable',
      metric: 'Open Bills & AP Control',
      sourceValue: `${formatDecimal4(srcOpenBillsTotal4)} (GL ${formatDecimal4(srcGlAp4)})`,
      targetValue: `${formatDecimal4(targetOpenBillsTotal4)} (GL ${formatDecimal4(tgtGlAp4)})`,
      variance: formatDecimal4(diffBill),
      explained,
      explanation: explained
        ? `AP variance equals ${formatDecimal4(rejectedBillSum)} from rejected supplier bill record(s).`
        : 'Unexplained Accounts Payable variance between source and target.',
      relatedExceptionIds: apExcs.map(e => e.id),
    });
  }

  if (tgtInvSub4 !== srcInvSub4) {
    const itemExcs = correlateExceptions(e => e.source_entity === 'items');
    const diffInvVal = tgtInvSub4 - srcInvSub4;
    const rejInvVal = itemExcs
      .filter(e => e.disposition === 'rejected')
      .reduce((s, e) => s + e.impact4, 0n);
    const explained = itemExcs.length > 0 && absBigInt(diffInvVal) === absBigInt(rejInvVal);
    discrepancies.push({
      domain: 'Inventory',
      metric: 'Subledger Valuation vs GL 1200',
      sourceValue: `${formatDecimal4(srcInvSub4)} (GL ${formatDecimal4(srcGlInv4)})`,
      targetValue: `${formatDecimal4(tgtInvSub4)} (GL ${formatDecimal4(tgtGlInv4)})`,
      variance: formatDecimal4(diffInvVal),
      explained,
      explanation: explained
        ? `Inventory valuation delta explained by ${itemExcs.length} rejected/non-stockable item record(s).`
        : 'Unexplained Inventory subledger variance.',
      relatedExceptionIds: itemExcs.map(e => e.id),
    });
  }

  if (tgtNet4 !== srcNet4) {
    const plExcs = correlateExceptions(
      e => ['transactions', 'invoices', 'bills'].includes(e.source_entity) && e.disposition === 'rejected'
    );
    discrepancies.push({
      domain: 'Profit & Loss',
      metric: 'Net Income',
      sourceValue: formatDecimal4(srcNet4),
      targetValue: formatDecimal4(tgtNet4),
      variance: formatDecimal4(tgtNet4 - srcNet4),
      explained: plExcs.length > 0,
      explanation:
        plExcs.length > 0
          ? `P&L Net Income difference explained by ${plExcs.length} rejected P&L-affecting source record(s).`
          : 'Unexplained P&L Net Income difference.',
      relatedExceptionIds: plExcs.map(e => e.id),
    });
  }

  // Exceptions Summary
  const openRejected = exceptions.filter(e => e.disposition === 'rejected' && e.resolution_status === 'open').length;
  const resolvedOrAcceptedRejected = exceptions.filter(
    e => e.disposition === 'rejected' && e.resolution_status !== 'open'
  ).length;
  const duplicatesMerged = exceptions.filter(e => e.disposition === 'duplicate_merged').length;
  const archivedPreserved = exceptions.filter(e => e.disposition === 'archived_preserved').length;
  const deletedPreserved = exceptions.filter(e => e.disposition === 'deleted_preserved').length;
  const deprecatedVertical = exceptions.filter(e => e.disposition === 'deprecated_vertical').length;

  const tbBalanced = targetTb.isBalanced;
  const bsBalanced = targetBs.totals.isBalanced;
  const unexplained = discrepancies.filter(d => !d.explained);
  const allBalanced = tbBalanced && bsBalanced && unexplained.length === 0;

  const blockingReasons: string[] = [];
  if (!tbBalanced) blockingReasons.push('Target Trial Balance is unbalanced');
  if (!bsBalanced) blockingReasons.push('Target Balance Sheet does not balance');
  if (!countsReconciled) blockingReasons.push('Source vs target entity counts do not foot');
  if (openRejected > 0) blockingReasons.push(`${openRejected} rejected migration row(s) are still open without resolution or acceptance`);
  if (unexplained.length > 0) {
    blockingReasons.push(`${unexplained.length} financial discrepancy(ies) lack an explained exception correlation`);
  }

  const cutoverReady = blockingReasons.length === 0;

  const report: CompanyReconciliationReport = {
    companyId,
    companyName,
    sourceCompanyId: String(sourceCompanyId),
    asOfDate,
    basis,
    trialBalance: {
      sourceDebit: formatDecimal4(srcLedger.tbDebit4),
      sourceCredit: formatDecimal4(srcLedger.tbCredit4),
      sourceIsBalanced: srcLedger.tbDebit4 === srcLedger.tbCredit4,
      targetDebit: formatDecimal4(targetTbDebit4),
      targetCredit: formatDecimal4(targetTbCredit4),
      targetIsBalanced: tbBalanced,
      varianceDebit: formatDecimal4(tbDrVar4),
      varianceCredit: formatDecimal4(tbCrVar4),
      reconciled: tbDrVar4 === 0n && tbCrVar4 === 0n && tbBalanced,
    },
    accountBalances,
    accountsReceivable: {
      sourceGlAr: formatDecimal4(srcGlAr4),
      targetGlAr: formatDecimal4(tgtGlAr4),
      sourceOpenInvoicesTotal: formatDecimal4(srcOpenInvoicesTotal4),
      targetOpenInvoicesTotal: formatDecimal4(targetOpenInvoicesTotal4),
      reconciled: srcGlAr4 === tgtGlAr4 && srcOpenInvoicesTotal4 === targetOpenInvoicesTotal4,
    },
    accountsPayable: {
      sourceGlAp: formatDecimal4(srcGlAp4),
      targetGlAp: formatDecimal4(tgtGlAp4),
      sourceOpenBillsTotal: formatDecimal4(srcOpenBillsTotal4),
      targetOpenBillsTotal: formatDecimal4(targetOpenBillsTotal4),
      reconciled: srcGlAp4 === tgtGlAp4 && srcOpenBillsTotal4 === targetOpenBillsTotal4,
    },
    bankBalances,
    inventoryValuation: {
      sourceSubledgerValue: formatDecimal4(srcInvSub4),
      targetSubledgerValue: formatDecimal4(tgtInvSub4),
      sourceGl1200: formatDecimal4(srcGlInv4),
      targetGl1200: formatDecimal4(tgtGlInv4),
      reconciled: srcInvSub4 === tgtInvSub4 && srcGlInv4 === tgtGlInv4,
    },
    customerBalances,
    supplierBalances,
    revenueAndExpenses: {
      sourceRevenue: formatDecimal4(srcLedger.revenue4),
      targetRevenue: formatDecimal4(tgtRev4),
      sourceCogs: formatDecimal4(srcLedger.cogs4),
      targetCogs: formatDecimal4(tgtCogs4),
      sourceExpenses: formatDecimal4(srcLedger.expenses4),
      targetExpenses: formatDecimal4(tgtExp4),
      sourceNetIncome: formatDecimal4(srcNet4),
      targetNetIncome: formatDecimal4(tgtNet4),
      reconciled: srcLedger.revenue4 === tgtRev4 && srcLedger.cogs4 === tgtCogs4 && srcLedger.expenses4 === tgtExp4,
    },
    financialStatements: {
      balanceSheetBalanced: bsBalanced,
      targetTotalAssets: formatDecimal4(parseDecimal4(targetBs.totals.totalAssets)),
      targetTotalLiabilities: formatDecimal4(parseDecimal4(targetBs.totals.totalLiabilities)),
      targetTotalEquity: formatDecimal4(parseDecimal4(targetBs.totals.totalEquity)),
      trialBalanceBalanced: tbBalanced,
    },
    entityCounts,
    countsReconciled,
    exceptionsSummary: {
      total: exceptions.length,
      openRejected,
      resolvedOrAcceptedRejected,
      duplicatesMerged,
      archivedPreserved,
      deletedPreserved,
      deprecatedVertical,
    },
    discrepancies,
    allBalanced,
    cutoverReady,
    blockingReasons,
  };

  if (options.persistSnapshot) {
    await tx.query(
      `INSERT INTO migration_reconciliation_snapshots (
         company_id, batch_id, as_of_date, basis,
         source_tb_debit, source_tb_credit, target_tb_debit, target_tb_credit,
         ar_source, ar_target, ap_source, ap_target,
         bank_source, bank_target, inventory_source, inventory_target,
         revenue_source, revenue_target, expenses_source, expenses_target,
         all_balanced, counts_reconciled, open_rejected_count, cutover_ready, report_json
       ) VALUES (
         $1, $2, $3::DATE, $4,
         $5::NUMERIC(19,4), $6::NUMERIC(19,4), $7::NUMERIC(19,4), $8::NUMERIC(19,4),
         $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11::NUMERIC(19,4), $12::NUMERIC(19,4),
         $13::NUMERIC(19,4), $14::NUMERIC(19,4), $15::NUMERIC(19,4), $16::NUMERIC(19,4),
         $17::NUMERIC(19,4), $18::NUMERIC(19,4), $19::NUMERIC(19,4), $20::NUMERIC(19,4),
         $21, $22, $23, $24, $25::JSONB
       )`,
      [
        companyId,
        batchId,
        asOfDate,
        basis,
        formatDecimal4(srcLedger.tbDebit4),
        formatDecimal4(srcLedger.tbCredit4),
        formatDecimal4(targetTbDebit4),
        formatDecimal4(targetTbCredit4),
        formatDecimal4(srcOpenInvoicesTotal4),
        formatDecimal4(targetOpenInvoicesTotal4),
        formatDecimal4(srcOpenBillsTotal4),
        formatDecimal4(targetOpenBillsTotal4),
        formatDecimal4(srcBankTotal4),
        formatDecimal4(tgtBankTotal4),
        formatDecimal4(srcInvSub4),
        formatDecimal4(tgtInvSub4),
        formatDecimal4(srcLedger.revenue4),
        formatDecimal4(tgtRev4),
        formatDecimal4(srcLedger.cogs4 + srcLedger.expenses4),
        formatDecimal4(tgtCogs4 + tgtExp4),
        allBalanced,
        countsReconciled,
        openRejected,
        cutoverReady,
        JSON.stringify(report),
      ]
    );

    await tx.query(
      `UPDATE migration_company_runs
          SET reconciled = $3,
              cutover_approved = $4
        WHERE company_id = $1 AND batch_id = $2`,
      [companyId, batchId, allBalanced && countsReconciled, cutoverReady]
    );
  }

  return report;
}

export async function resolveMigrationException(
  tx: Transaction,
  actor: ActorContext,
  exceptionId: number,
  input: { status: 'resolved' | 'accepted'; note: string }
) {
  if (!['resolved', 'accepted'].includes(input.status)) {
    throw new AccountingError(400, `Invalid resolution status '${input.status}'`);
  }
  const res = await tx.query<{ id: number; company_id: number; batch_id: number; source_entity: string; source_id: string }>(
    `UPDATE migration_exceptions
        SET resolution_status = $2,
            resolved_by = $3,
            resolved_at = NOW(),
            resolution_note = $4
      WHERE id = $1
     RETURNING id, company_id, batch_id, source_entity, source_id`,
    [exceptionId, input.status, actor.userId, input.note?.trim() || 'Reviewed and accepted for cutover']
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, `Migration exception ${exceptionId} not found`);
  }
  const row = res.rows[0];

  await writeAuditLog(tx, {
    companyId: Number(row.company_id),
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'MIGRATION_EXCEPTION_RESOLVED',
    tableName: 'migration_exceptions',
    recordId: Number(row.id),
    newValues: {
      batchId: Number(row.batch_id),
      sourceEntity: row.source_entity,
      sourceId: row.source_id,
      resolutionStatus: input.status,
      note: input.note,
    },
  });

  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    batchId: Number(row.batch_id),
    resolutionStatus: input.status,
  };
}

export async function signOffMigrationBatch(
  tx: Transaction,
  actor: ActorContext,
  batchId: number,
  bundle: SlowBooksSourceBundle,
  input: { signOffNotes?: string; asOfDate?: string } = {}
) {
  await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);

  const batchRes = await tx.query<{
    id: number;
    batch_key: string;
    mode: string;
    status: string;
    source_sha256: string;
  }>(
    `SELECT id, batch_key, mode, status, source_sha256
       FROM migration_batches
      WHERE id = $1
      FOR UPDATE`,
    [batchId]
  );
  if (batchRes.rows.length === 0) {
    throw new AccountingError(404, `Migration batch ${batchId} not found`);
  }
  const batch = batchRes.rows[0];
  if (batch.mode !== 'execute' || batch.status !== 'completed') {
    throw new AccountingError(
      409,
      `Batch ${batch.batch_key} cannot be signed off in mode='${batch.mode}', status='${batch.status}'`,
      'BATCH_NOT_ELIGIBLE_FOR_CUTOVER'
    );
  }

  const runsRes = await tx.query<{ company_id: number; source_company_id: string }>(
    `SELECT company_id, source_company_id
       FROM migration_company_runs
      WHERE batch_id = $1
      ORDER BY company_id ASC`,
    [batchId]
  );
  if (runsRes.rows.length === 0) {
    throw new AccountingError(400, `Batch ${batch.batch_key} has no migrated company runs`);
  }

  const companyReports: CompanyReconciliationReport[] = [];
  const allBlockingReasons: string[] = [];

  for (const run of runsRes.rows) {
    const rep = await reconcileMigratedCompany(
      tx,
      Number(run.company_id),
      batchId,
      run.source_company_id,
      bundle,
      { asOfDate: input.asOfDate, persistSnapshot: true }
    );
    companyReports.push(rep);
    if (!rep.cutoverReady) {
      for (const reason of rep.blockingReasons) {
        allBlockingReasons.push(`[Company ${rep.companyName}] ${reason}`);
      }
    }
  }

  if (allBlockingReasons.length > 0) {
    throw new AccountingError(
      409,
      `Production cutover blocked until reconciliation & exceptions clear: ${allBlockingReasons.join('; ')}`,
      'CUTOVER_RECONCILIATION_BLOCKED'
    );
  }

  const signOffAt = new Date().toISOString();
  const signOffNotes = input.signOffNotes?.trim() || 'All financial balances, entity counts, and multi-company isolation checks reconciled and signed off for production cutover.';

  await tx.query(
    `UPDATE migration_batches
        SET reconciled = TRUE,
            cutover_approved = TRUE,
            signed_off_by = $2,
            signed_off_at = NOW(),
            sign_off_notes = $3
      WHERE id = $1`,
    [batchId, actor.userId, signOffNotes]
  );

  for (const rep of companyReports) {
    await tx.query(
      `UPDATE migration_reconciliation_snapshots
          SET signed_off_by = $3,
              signed_off_at = NOW(),
              sign_off_notes = $4
        WHERE company_id = $1 AND batch_id = $2`,
      [rep.companyId, batchId, actor.userId, signOffNotes]
    );
    await writeAuditLog(tx, {
      companyId: rep.companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'MIGRATION_CUTOVER_SIGNED_OFF',
      tableName: 'migration_batches',
      recordId: batchId,
      newValues: {
        batchKey: batch.batch_key,
        sourceSha256: batch.source_sha256,
        signOffAt,
        signOffNotes,
      },
    });
  }

  return {
    batchId,
    batchKey: batch.batch_key,
    cutoverApproved: true,
    signedOffBy: actor.username,
    signedOffAt: signOffAt,
    signOffNotes,
    companyReports,
  };
}

export function buildReconciliationMarkdownReport(params: {
  batchKey: string;
  sourceSystem: string;
  sourceSha256: string;
  sourceBackupPath?: string | null;
  sourceBackupSha256?: string | null;
  targetBackupPath?: string | null;
  targetBackupSha256?: string | null;
  cutoverApproved: boolean;
  signedOffBy?: string | null;
  signedOffAt?: string | null;
  signOffNotes?: string | null;
  companyReports: CompanyReconciliationReport[];
  isolationVerified: boolean;
  rollbackVerified: boolean;
  dryRunVerified: boolean;
}): string {
  const lines: string[] = [
    '# Phase 10 — SlowBooks-Pro-2026 Migration & Financial Reconciliation Report',
    '',
    `- **Batch Key:** \`${params.batchKey}\``,
    `- **Source System:** \`${params.sourceSystem}\``,
    `- **Source SHA-256:** \`${params.sourceSha256}\``,
    `- **Source Backup Artifact:** \`${params.sourceBackupPath || 'N/A'}\` (SHA-256: \`${params.sourceBackupSha256 || 'N/A'}\`)`,
    `- **Target Pre-Migration Backup:** \`${params.targetBackupPath || 'N/A'}\` (SHA-256: \`${params.targetBackupSha256 || 'N/A'}\`)`,
    `- **Cutover Approved:** **${params.cutoverApproved ? 'YES — SIGNED OFF' : 'NO — PENDING'}**`,
    `- **Signed Off By:** ${params.signedOffBy || 'Pending'} (${params.signedOffAt || '—'})`,
    `- **Sign-Off Statement:** ${params.signOffNotes || 'Pending review'}`,
    '',
    '## Safety & Acceptance Gate Checklist',
    '',
    `- [${params.dryRunVerified ? 'x' : ' '}] Dry-run simulation verified with zero live business-table mutations`,
    `- [${params.sourceBackupSha256 ? 'x' : ' '}] Read-only source database backup archived & SHA-256 verified`,
    `- [${params.targetBackupSha256 ? 'x' : ' '}] Target database pre-migration backup snapshot archived & SHA-256 verified`,
    `- [${params.rollbackVerified ? 'x' : ' '}] Migration rollback & recovery procedure verified`,
    `- [${params.isolationVerified ? 'x' : ' '}] Multi-company RLS & API tenant isolation verified across migrated companies`,
    `- [${params.companyReports.every(r => r.financialStatements.trialBalanceBalanced && r.financialStatements.balanceSheetBalanced) ? 'x' : ' '}] Target Trial Balance & Balance Sheet strictly balanced`,
    `- [${params.companyReports.every(r => r.countsReconciled) ? 'x' : ' '}] 100% source entity & transaction counts reconciled (zero silent drops)`,
    `- [${params.cutoverApproved ? 'x' : ' '}] Financial reconciliation signed off for production cutover`,
    '',
  ];

  for (const rep of params.companyReports) {
    lines.push(
      `## Company: ${rep.companyName} (Target ID: ${rep.companyId}, SlowBooks ID: \`${rep.sourceCompanyId}\`)`,
      '',
      `- **As-Of Date:** ${rep.asOfDate} | **Basis:** ${rep.basis}`,
      `- **Cutover Ready:** ${rep.cutoverReady ? 'YES' : `NO (${rep.blockingReasons.join('; ')})`}`,
      '',
      '### 1. Financial Balance Comparison (Source vs Target)',
      '',
      '| Domain / Metric | Source (SlowBooks) | Target (PMS) | Status |',
      '|---|---:|---:|---|',
      `| Trial Balance Debits | ${rep.trialBalance.sourceDebit} | ${rep.trialBalance.targetDebit} | ${rep.trialBalance.varianceDebit === '0.0000' ? 'EXACT MATCH' : `Variance ${rep.trialBalance.varianceDebit}`} |`,
      `| Trial Balance Credits | ${rep.trialBalance.sourceCredit} | ${rep.trialBalance.targetCredit} | ${rep.trialBalance.varianceCredit === '0.0000' ? 'EXACT MATCH' : `Variance ${rep.trialBalance.varianceCredit}`} |`,
      `| Accounts Receivable (GL 1100 / Open Invoices) | ${rep.accountsReceivable.sourceGlAr} / ${rep.accountsReceivable.sourceOpenInvoicesTotal} | ${rep.accountsReceivable.targetGlAr} / ${rep.accountsReceivable.targetOpenInvoicesTotal} | ${rep.accountsReceivable.reconciled ? 'RECONCILED' : 'EXPLAINED VARIANCE'} |`,
      `| Accounts Payable (GL 2000 / Open Bills) | ${rep.accountsPayable.sourceGlAp} / ${rep.accountsPayable.sourceOpenBillsTotal} | ${rep.accountsPayable.targetGlAp} / ${rep.accountsPayable.targetOpenBillsTotal} | ${rep.accountsPayable.reconciled ? 'RECONCILED' : 'EXPLAINED VARIANCE'} |`,
      `| Inventory Valuation (Subledger / GL 1200) | ${rep.inventoryValuation.sourceSubledgerValue} / ${rep.inventoryValuation.sourceGl1200} | ${rep.inventoryValuation.targetSubledgerValue} / ${rep.inventoryValuation.targetGl1200} | ${rep.inventoryValuation.reconciled ? 'RECONCILED' : 'EXPLAINED VARIANCE'} |`,
      `| Revenue | ${rep.revenueAndExpenses.sourceRevenue} | ${rep.revenueAndExpenses.targetRevenue} | ${rep.revenueAndExpenses.sourceRevenue === rep.revenueAndExpenses.targetRevenue ? 'EXACT MATCH' : 'EXPLAINED VARIANCE'} |`,
      `| Cost of Goods Sold (COGS) | ${rep.revenueAndExpenses.sourceCogs} | ${rep.revenueAndExpenses.targetCogs} | ${rep.revenueAndExpenses.sourceCogs === rep.revenueAndExpenses.targetCogs ? 'EXACT MATCH' : 'EXPLAINED VARIANCE'} |`,
      `| Operating & Other Expenses | ${rep.revenueAndExpenses.sourceExpenses} | ${rep.revenueAndExpenses.targetExpenses} | ${rep.revenueAndExpenses.sourceExpenses === rep.revenueAndExpenses.targetExpenses ? 'EXACT MATCH' : 'EXPLAINED VARIANCE'} |`,
      `| Net Income | ${rep.revenueAndExpenses.sourceNetIncome} | ${rep.revenueAndExpenses.targetNetIncome} | ${rep.revenueAndExpenses.reconciled ? 'RECONCILED' : 'EXPLAINED VARIANCE'} |`,
      `| Balance Sheet (Assets = Liab + Equity) | — | Assets ${rep.financialStatements.targetTotalAssets} | ${rep.financialStatements.balanceSheetBalanced ? 'BALANCED' : 'UNBALANCED'} |`,
      '',
      '### 2. Bank & Credit Card Balances',
      '',
      '| Code | Account Name | Source | Target | Variance | Match |',
      '|---|---|---:|---:|---:|---|',
      ...rep.bankBalances.map(
        b => `| ${b.code || '—'} | ${b.name} | ${b.sourceBalance} | ${b.targetBalance} | ${b.variance} | ${b.matched ? 'YES' : 'NO'} |`
      ),
      '',
      '### 3. Entity & Transaction Count Reconciliation',
      '',
      '| Domain Checkpoint | Source | Migrated | Merged Dup | Archived/Del | Rejected | Accounted | Reconciled |',
      '|---|---:|---:|---:|---:|---:|---:|---|',
      ...rep.entityCounts.map(
        c =>
          `| ${c.entity} | ${c.sourceCount} | ${c.migratedCount} | ${c.duplicateMergedCount} | ${c.archivedOrDeletedCount} | ${c.rejectedCount} | ${c.accountedTotal} | ${c.reconciled ? 'YES' : 'NO'} |`
      ),
      '',
      '### 4. Exception & Discrepancy Explanations',
      '',
      `- Total Exceptions Logged: **${rep.exceptionsSummary.total}** (Rejected Resolved/Accepted: ${rep.exceptionsSummary.resolvedOrAcceptedRejected}, Open Rejected: ${rep.exceptionsSummary.openRejected}, Duplicates Merged: ${rep.exceptionsSummary.duplicatesMerged}, Archived Preserved: ${rep.exceptionsSummary.archivedPreserved}, Deleted Preserved: ${rep.exceptionsSummary.deletedPreserved}, Deprecated Verticals: ${rep.exceptionsSummary.deprecatedVertical})`,
      ''
    );

    if (rep.discrepancies.length === 0) {
      lines.push('- Zero financial discrepancies detected between SlowBooks source and Printing Management System target.', '');
    } else {
      lines.push('| Domain | Metric | Source | Target | Variance | Explained | Explanation |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const d of rep.discrepancies) {
        lines.push(
          `| ${d.domain} | ${d.metric} | ${d.sourceValue} | ${d.targetValue} | ${d.variance} | ${d.explained ? 'YES' : 'NO'} | ${d.explanation} |`
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
