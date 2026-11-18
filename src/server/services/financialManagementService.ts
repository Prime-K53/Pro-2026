import { Transaction } from '@electric-sql/pglite';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal4, parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import {
  getBalanceSheet,
  getCashFlowStatement,
  getProfitAndLoss,
  getTrialBalance,
} from './financialReports.ts';
import { getArAgingReport } from './salesService.ts';
import { getApAgingReport } from './purchasingService.ts';
import {
  assertIsoDate,
  formatDecimal6,
  parseDecimal6,
  todayIsoDate,
} from './commercialHelpers.ts';

// ============================================================================
// BUDGETS & BUDGET VS ACTUAL
// ============================================================================

export async function getBudgetMatrix(tx: Transaction, companyId: number, fiscalYear: number) {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1990 || fiscalYear > 2150) {
    throw new AccountingError(400, 'Invalid fiscalYear');
  }

  const accts = await tx.query<{
    id: number;
    code: string | null;
    name: string;
    account_type: string;
  }>(
    `SELECT id, code, name, account_type
       FROM accounts
      WHERE company_id = $1 AND is_active = TRUE
        AND account_type IN ('Income', 'OtherIncome', 'CostOfGoodsSold', 'Expense', 'OtherExpense')
      ORDER BY code ASC NULLS LAST, name ASC`,
    [companyId]
  );

  const bRes = await tx.query<{
    account_id: number;
    fiscal_month: number;
    amount: string;
  }>(
    `SELECT account_id, fiscal_month, amount::text
       FROM budgets
      WHERE company_id = $1 AND fiscal_year = $2 AND class_id IS NULL`,
    [companyId, fiscalYear]
  );

  const byAcctMonth = new Map<string, bigint>();
  for (const r of bRes.rows) {
    byAcctMonth.set(`${r.account_id}-${r.fiscal_month}`, parseDecimal4(r.amount));
  }

  const rows = accts.rows.map(a => {
    const months: number[] = [];
    let annualTotal4 = 0n;
    for (let m = 1; m <= 12; m++) {
      const val4 = byAcctMonth.get(`${a.id}-${m}`) ?? 0n;
      annualTotal4 += val4;
      months.push(toMoneyNumber(val4));
    }
    return {
      accountId: Number(a.id),
      code: a.code || '',
      name: a.name,
      accountType: a.account_type,
      months,
      annualTotal: toMoneyNumber(annualTotal4),
    };
  });

  return { fiscalYear, rows };
}

export async function upsertBudgetEntries(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  fiscalYear: number,
  entries: Array<{ accountId: number; fiscalMonth: number; amount: string | number }>
) {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1990 || fiscalYear > 2150) {
    throw new AccountingError(400, 'Invalid fiscalYear');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new AccountingError(400, 'At least one budget entry is required');
  }

  for (const e of entries) {
    const month = Number(e.fiscalMonth);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new AccountingError(400, `Invalid fiscalMonth: ${e.fiscalMonth}`);
    }
    const amt4 = parseDecimal4(e.amount);
    await tx.query(
      `INSERT INTO budgets (company_id, account_id, fiscal_year, fiscal_month, amount, class_id)
       VALUES ($1, $2, $3, $4, $5::NUMERIC(19,4), NULL)
       ON CONFLICT (company_id, account_id, fiscal_year, fiscal_month, COALESCE(class_id, 0))
       DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW()`,
      [companyId, Number(e.accountId), fiscalYear, month, formatDecimal4(amt4)]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BUDGET_UPDATED',
    tableName: 'budgets',
    recordId: fiscalYear,
    newValues: { fiscalYear, entriesUpdated: entries.length },
  });

  return getBudgetMatrix(tx, companyId, fiscalYear);
}

export async function getBudgetVsActualReport(
  tx: Transaction,
  companyId: number,
  fiscalYear: number,
  startMonth = 1,
  endMonth = 12
) {
  const sMonth = Math.max(1, Math.min(12, Number(startMonth)));
  const eMonth = Math.max(sMonth, Math.min(12, Number(endMonth)));
  const startDate = `${fiscalYear}-${String(sMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(fiscalYear, eMonth, 0)).getUTCDate();
  const endDate = `${fiscalYear}-${String(eMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const [bRes, aRes] = await Promise.all([
    tx.query<{
      account_id: number;
      code: string | null;
      name: string;
      account_type: string;
      budget_total: string;
    }>(
      `SELECT a.id AS account_id, a.code, a.name, a.account_type,
              COALESCE(SUM(b.amount), 0)::NUMERIC(19,4)::text AS budget_total
         FROM accounts a
         LEFT JOIN budgets b
           ON b.company_id = a.company_id
          AND b.account_id = a.id
          AND b.fiscal_year = $2
          AND b.fiscal_month BETWEEN $3 AND $4
          AND b.class_id IS NULL
        WHERE a.company_id = $1 AND a.is_active = TRUE
          AND a.account_type IN ('Income', 'OtherIncome', 'CostOfGoodsSold', 'Expense', 'OtherExpense')
        GROUP BY a.id, a.code, a.name, a.account_type
        ORDER BY a.code ASC NULLS LAST, a.name ASC`,
      [companyId, fiscalYear, sMonth, eMonth]
    ),
    tx.query<{
      account_id: number;
      debit_sum: string;
      credit_sum: string;
    }>(
      `SELECT l.account_id,
              COALESCE(SUM(l.debit), 0)::NUMERIC(19,4)::text AS debit_sum,
              COALESCE(SUM(l.credit), 0)::NUMERIC(19,4)::text AS credit_sum
         FROM journal_lines l
         JOIN journal_transactions t
           ON t.company_id = l.company_id AND t.id = l.transaction_id
        WHERE l.company_id = $1
          AND t.is_posted = TRUE
          AND t.txn_date BETWEEN $2::DATE AND $3::DATE
        GROUP BY l.account_id`,
      [companyId, startDate, endDate]
    ),
  ]);

  const actualMap = new Map<number, { d4: bigint; c4: bigint }>();
  for (const r of aRes.rows) {
    actualMap.set(Number(r.account_id), {
      d4: parseDecimal4(r.debit_sum),
      c4: parseDecimal4(r.credit_sum),
    });
  }

  let totalBudgetIncome4 = 0n;
  let totalActualIncome4 = 0n;
  let totalBudgetExpense4 = 0n;
  let totalActualExpense4 = 0n;

  const lines = bRes.rows.map(r => {
    const aid = Number(r.account_id);
    const budget4 = parseDecimal4(r.budget_total);
    const sums = actualMap.get(aid) ?? { d4: 0n, c4: 0n };
    const isIncome = r.account_type === 'Income' || r.account_type === 'OtherIncome';
    const actual4 = isIncome ? sums.c4 - sums.d4 : sums.d4 - sums.c4;
    const variance4 = actual4 - budget4;

    if (isIncome) {
      totalBudgetIncome4 += budget4;
      totalActualIncome4 += actual4;
    } else {
      totalBudgetExpense4 += budget4;
      totalActualExpense4 += actual4;
    }

    return {
      accountId: aid,
      code: r.code || '',
      name: r.name,
      accountType: r.account_type,
      budget: toMoneyNumber(budget4),
      actual: toMoneyNumber(actual4),
      variance: toMoneyNumber(variance4),
      favorable: isIncome ? variance4 >= 0n : variance4 <= 0n,
    };
  });

  return {
    fiscalYear,
    startMonth: sMonth,
    endMonth: eMonth,
    startDate,
    endDate,
    lines,
    summary: {
      budgetedRevenue: toMoneyNumber(totalBudgetIncome4),
      actualRevenue: toMoneyNumber(totalActualIncome4),
      budgetedExpenses: toMoneyNumber(totalBudgetExpense4),
      actualExpenses: toMoneyNumber(totalActualExpense4),
      budgetedNetIncome: toMoneyNumber(totalBudgetIncome4 - totalBudgetExpense4),
      actualNetIncome: toMoneyNumber(totalActualIncome4 - totalActualExpense4),
    },
  };
}

// ============================================================================
// TAX REPORTING & CATEGORY MAPPINGS
// ============================================================================

export async function listTaxMappings(tx: Transaction, companyId: number) {
  const res = await tx.query<any>(
    `SELECT m.id, m.account_id, a.code AS account_code, a.name AS account_name,
            a.account_type, m.tax_line
       FROM tax_category_mappings m
       JOIN accounts a ON a.company_id = m.company_id AND a.id = m.account_id
      WHERE m.company_id = $1
      ORDER BY a.code ASC NULLS LAST, m.id ASC`,
    [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    accountId: Number(r.account_id),
    accountCode: r.account_code || '',
    accountName: r.account_name,
    accountType: r.account_type,
    taxLine: r.tax_line,
  }));
}

export async function upsertTaxMapping(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { accountId: number; taxLine: string }
) {
  const accountId = Number(input.accountId);
  const taxLine = String(input.taxLine || '').trim();
  if (!taxLine) throw new AccountingError(400, 'taxLine is required');

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO tax_category_mappings (company_id, account_id, tax_line)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, account_id)
     DO UPDATE SET tax_line = EXCLUDED.tax_line
     RETURNING id`,
    [companyId, accountId, taxLine]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'TAX_MAPPING_UPSERTED',
    tableName: 'tax_category_mappings',
    recordId: Number(ins.rows[0].id),
    newValues: { accountId, taxLine },
  });

  const all = await listTaxMappings(tx, companyId);
  return all.find(m => m.accountId === accountId)!;
}

export async function getTaxSummaryReport(
  tx: Transaction,
  companyId: number,
  startDate?: string,
  endDate?: string
) {
  const end = endDate ? assertIsoDate(endDate, 'endDate') : todayIsoDate();
  const start = startDate ? assertIsoDate(startDate, 'startDate') : `${end.slice(0, 4)}-01-01`;

  const [invAgg, cmAgg, billTaxAgg, taxLiabilityGl, mappings] = await Promise.all([
    tx.query<{
      gross_sales: string;
      taxable_sales: string;
      output_tax: string;
      invoice_count: string;
    }>(
      `SELECT COALESCE(SUM(i.subtotal), 0)::NUMERIC(19,4)::text AS gross_sales,
              COALESCE((
                SELECT SUM(il.amount)
                  FROM invoice_lines il
                  JOIN invoices i2 ON i2.company_id = il.company_id AND i2.id = il.invoice_id
                 WHERE il.company_id = $1 AND il.taxable = TRUE
                   AND i2.status <> 'voided' AND i2.invoice_date BETWEEN $2::DATE AND $3::DATE
              ), 0)::NUMERIC(19,4)::text AS taxable_sales,
              COALESCE(SUM(i.tax_amount), 0)::NUMERIC(19,4)::text AS output_tax,
              COUNT(*)::text AS invoice_count
         FROM invoices i
        WHERE i.company_id = $1 AND i.status <> 'voided' AND i.invoice_date BETWEEN $2::DATE AND $3::DATE`,
      [companyId, start, end]
    ),
    tx.query<{ credit_tax: string }>(
      `SELECT COALESCE(SUM(tax_amount), 0)::NUMERIC(19,4)::text AS credit_tax
         FROM credit_memos
        WHERE company_id = $1 AND credit_date BETWEEN $2::DATE AND $3::DATE`,
      [companyId, start, end]
    ),
    tx.query<{ use_tax_accrued: string }>(
      `SELECT COALESCE(SUM(bl.amount * bl.use_tax_rate / 100.0), 0)::NUMERIC(19,4)::text AS use_tax_accrued
         FROM bill_lines bl
         JOIN bills b ON b.company_id = bl.company_id AND b.id = bl.bill_id
        WHERE bl.company_id = $1 AND b.status <> 'voided' AND b.bill_date BETWEEN $2::DATE AND $3::DATE`,
      [companyId, start, end]
    ),
    tx.query<{ balance: string }>(
      `SELECT COALESCE(SUM(a.balance), 0)::NUMERIC(19,4)::text AS balance
         FROM accounts a
        WHERE a.company_id = $1 AND (a.code = '2200' OR LOWER(a.name) LIKE '%tax%')`,
      [companyId]
    ),
    listTaxMappings(tx, companyId),
  ]);

  const gross4 = parseDecimal4(invAgg.rows[0].gross_sales);
  const taxable4 = parseDecimal4(invAgg.rows[0].taxable_sales);
  const exempt4 = gross4 >= taxable4 ? gross4 - taxable4 : 0n;
  const outputTax4 = parseDecimal4(invAgg.rows[0].output_tax);
  const creditTax4 = parseDecimal4(cmAgg.rows[0].credit_tax);
  const useTax4 = parseDecimal4(billTaxAgg.rows[0].use_tax_accrued);
  const netTaxRemittance4 = outputTax4 - creditTax4 + useTax4;
  const glTaxLiability4 = parseDecimal4(taxLiabilityGl.rows[0].balance);

  return {
    startDate: start,
    endDate: end,
    invoiceCount: Number(invAgg.rows[0].invoice_count),
    grossSales: toMoneyNumber(gross4),
    taxableSales: toMoneyNumber(taxable4),
    exemptSales: toMoneyNumber(exempt4),
    outputVatCollected: toMoneyNumber(outputTax4),
    creditMemoVatReversed: toMoneyNumber(creditTax4),
    purchaseUseTaxAccrued: toMoneyNumber(useTax4),
    netTaxPayableForPeriod: toMoneyNumber(netTaxRemittance4),
    glTaxLiabilityBalance: toMoneyNumber(glTaxLiability4),
    mappings,
  };
}

// ============================================================================
// FOREIGN EXCHANGE RATES
// ============================================================================

export async function listExchangeRates(tx: Transaction, companyId: number) {
  const res = await tx.query<any>(
    `SELECT id, from_currency, to_currency, rate_date::text, rate::text, source, created_at::text
       FROM exchange_rates
      WHERE company_id = $1
      ORDER BY rate_date DESC, from_currency ASC, id DESC`,
    [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    fromCurrency: r.from_currency,
    toCurrency: r.to_currency,
    rateDate: r.rate_date,
    rate: Number(r.rate),
    rateStr: r.rate,
    source: r.source,
    createdAt: r.created_at,
  }));
}

export async function upsertExchangeRate(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    fromCurrency: string;
    toCurrency?: string;
    rateDate?: string;
    rate: string | number;
    source?: string;
  }
) {
  const compRes = await tx.query<{ base_currency: string }>(`SELECT base_currency FROM companies WHERE id = $1`, [
    companyId,
  ]);
  const baseCurrency = compRes.rows[0]?.base_currency || 'ZMW';
  const fromCur = String(input.fromCurrency || '').trim().toUpperCase().slice(0, 3);
  const toCur = String(input.toCurrency || baseCurrency).trim().toUpperCase().slice(0, 3);
  if (fromCur.length !== 3 || toCur.length !== 3 || fromCur === toCur) {
    throw new AccountingError(400, 'fromCurrency and toCurrency must be distinct 3-letter ISO currency codes');
  }
  const rateDate = input.rateDate ? assertIsoDate(input.rateDate, 'rateDate') : todayIsoDate();
  const rate6 = parseDecimal6(input.rate);
  if (rate6 <= 0n) throw new AccountingError(400, 'Exchange rate must be greater than zero');

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate_date, rate, source, created_by)
     VALUES ($1, $2, $3, $4::DATE, $5::NUMERIC(19,6), $6, $7)
     ON CONFLICT (company_id, from_currency, to_currency, rate_date)
     DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source
     RETURNING id`,
    [companyId, fromCur, toCur, rateDate, formatDecimal6(rate6), input.source?.trim() || 'manual', actor.userId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'EXCHANGE_RATE_UPSERTED',
    tableName: 'exchange_rates',
    recordId: Number(ins.rows[0].id),
    newValues: { fromCurrency: fromCur, toCurrency: toCur, rateDate, rate: formatDecimal6(rate6) },
  });

  const all = await listExchangeRates(tx, companyId);
  return all.find(r => r.id === Number(ins.rows[0].id))!;
}

// ============================================================================
// SAVED REPORTS
// ============================================================================

export async function listSavedReports(tx: Transaction, companyId: number) {
  const res = await tx.query<any>(
    `SELECT id, name, report_type, parameters, created_at::text, last_run_at::text
       FROM saved_reports
      WHERE company_id = $1
      ORDER BY created_at DESC, id DESC`,
    [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    name: r.name,
    reportType: r.report_type,
    parameters: r.parameters || {},
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
  }));
}

export async function createSavedReport(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { name: string; reportType: string; parameters?: Record<string, any> }
) {
  const name = String(input.name || '').trim();
  const reportType = String(input.reportType || '').trim();
  const allowed = [
    'trial_balance',
    'profit_and_loss',
    'balance_sheet',
    'cash_flow',
    'ar_aging',
    'ap_aging',
    'budget_vs_actual',
    'tax_summary',
  ];
  if (!name) throw new AccountingError(400, 'Saved report name is required');
  if (!allowed.includes(reportType)) {
    throw new AccountingError(400, `Unsupported reportType "${reportType}"`);
  }

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO saved_reports (company_id, name, report_type, parameters, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [companyId, name, reportType, JSON.stringify(input.parameters || {}), actor.userId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'SAVED_REPORT_CREATED',
    tableName: 'saved_reports',
    recordId: Number(ins.rows[0].id),
    newValues: { name, reportType },
  });

  const all = await listSavedReports(tx, companyId);
  return all.find(r => r.id === Number(ins.rows[0].id))!;
}

export async function deleteSavedReport(tx: Transaction, companyId: number, reportId: number) {
  const del = await tx.query(`DELETE FROM saved_reports WHERE company_id = $1 AND id = $2 RETURNING id`, [
    companyId,
    reportId,
  ]);
  if (del.rows.length === 0) throw new AccountingError(404, 'Saved report not found');
  return { deletedId: reportId };
}

export async function runSavedReport(tx: Transaction, companyId: number, reportId: number) {
  const rRes = await tx.query<{ id: number; name: string; report_type: string; parameters: any }>(
    `SELECT id, name, report_type, parameters FROM saved_reports WHERE company_id = $1 AND id = $2`,
    [companyId, reportId]
  );
  if (rRes.rows.length === 0) throw new AccountingError(404, 'Saved report not found');
  const rep = rRes.rows[0];
  const p = rep.parameters || {};
  const today = todayIsoDate();
  const yearStart = `${today.slice(0, 4)}-01-01`;

  let output: any;
  switch (rep.report_type) {
    case 'trial_balance':
      output = await getTrialBalance(tx, companyId, { asOfDate: p.asOfDate || today });
      break;
    case 'profit_and_loss':
      output = await getProfitAndLoss(tx, companyId, { startDate: p.startDate || yearStart, endDate: p.endDate || today });
      break;
    case 'balance_sheet':
      output = await getBalanceSheet(tx, companyId, { asOfDate: p.asOfDate || today });
      break;
    case 'cash_flow':
      output = await getCashFlowStatement(tx, companyId, { startDate: p.startDate || yearStart, endDate: p.endDate || today });
      break;
    case 'ar_aging':
      output = await getArAgingReport(tx, companyId, p.asOfDate || today);
      break;
    case 'ap_aging':
      output = await getApAgingReport(tx, companyId, p.asOfDate || today);
      break;
    case 'budget_vs_actual':
      output = await getBudgetVsActualReport(
        tx,
        companyId,
        Number(p.fiscalYear || today.slice(0, 4)),
        Number(p.startMonth || 1),
        Number(p.endMonth || 12)
      );
      break;
    case 'tax_summary':
      output = await getTaxSummaryReport(tx, companyId, p.startDate || yearStart, p.endDate || today);
      break;
    default:
      throw new AccountingError(400, `Unsupported reportType ${rep.report_type}`);
  }

  await tx.query(`UPDATE saved_reports SET last_run_at = NOW(), updated_at = NOW() WHERE company_id = $1 AND id = $2`, [
    companyId,
    reportId,
  ]);

  return {
    report: {
      id: Number(rep.id),
      name: rep.name,
      reportType: rep.report_type,
      parameters: p,
    },
    output,
  };
}

// ============================================================================
// FINANCIAL ANALYTICS & CASH REPORTING DASHBOARD
// ============================================================================

export async function getFinancialAnalyticsDashboard(tx: Transaction, companyId: number) {
  const today = todayIsoDate();
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const [pnl, arAging, apAging, cashAccounts, monthlyTrend, topCustomers, topVendors] = await Promise.all([
    getProfitAndLoss(tx, companyId, { startDate: yearStart, endDate: today }),
    getArAgingReport(tx, companyId, today),
    getApAgingReport(tx, companyId, today),
    tx.query<{ id: number; code: string | null; name: string; account_type: string; balance: string }>(
      `SELECT a.id, a.code, a.name, a.account_type, COALESCE(a.balance, 0)::NUMERIC(19,4)::text AS balance
         FROM accounts a
        WHERE a.company_id = $1 AND a.is_active = TRUE AND a.account_type IN ('Bank', 'CreditCard')
        ORDER BY a.code ASC NULLS LAST`,
      [companyId]
    ),
    tx.query<{
      ym: string;
      revenue: string;
      expenses: string;
    }>(
      `SELECT TO_CHAR(t.txn_date, 'YYYY-MM') AS ym,
              COALESCE(SUM(CASE WHEN a.account_type IN ('Income', 'OtherIncome') THEN (l.credit - l.debit) ELSE 0 END), 0)::NUMERIC(19,4)::text AS revenue,
              COALESCE(SUM(CASE WHEN a.account_type IN ('CostOfGoodsSold', 'Expense', 'OtherExpense') THEN (l.debit - l.credit) ELSE 0 END), 0)::NUMERIC(19,4)::text AS expenses
         FROM journal_lines l
         JOIN journal_transactions t ON t.company_id = l.company_id AND t.id = l.transaction_id
         JOIN accounts a ON a.company_id = l.company_id AND a.id = l.account_id
        WHERE l.company_id = $1 AND t.is_posted = TRUE AND t.txn_date >= $2::DATE
        GROUP BY TO_CHAR(t.txn_date, 'YYYY-MM')
        ORDER BY ym ASC`,
      [companyId, yearStart]
    ),
    tx.query<{ id: number; company_name: string; balance: string }>(
      `SELECT id, company_name, balance::text FROM customers WHERE company_id = $1 AND balance > 0 ORDER BY balance DESC LIMIT 5`,
      [companyId]
    ),
    tx.query<{ id: number; company_name: string; balance: string }>(
      `SELECT id, company_name, balance::text FROM vendors WHERE company_id = $1 AND balance > 0 ORDER BY balance DESC LIMIT 5`,
      [companyId]
    ),
  ]);

  let bankCash4 = 0n;
  let ccLiability4 = 0n;
  const cashAccountList = cashAccounts.rows.map(c => {
    const b4 = parseDecimal4(c.balance);
    if (c.account_type === 'Bank') bankCash4 += b4;
    else ccLiability4 += b4;
    return {
      accountId: Number(c.id),
      code: c.code || '',
      name: c.name,
      accountType: c.account_type,
      balance: toMoneyNumber(b4),
    };
  });

  const rev4 = parseDecimal4(pnl.totals.totalIncome);
  const net4 = parseDecimal4(pnl.totals.netIncome);
  const netMarginPct = rev4 > 0n ? Number(((Number(net4) / Number(rev4)) * 100).toFixed(2)) : 0;

  return {
    asOfDate: today,
    kpis: {
      ytdRevenue: toMoneyNumber(rev4),
      ytdCogs: toMoneyNumber(parseDecimal4(pnl.totals.totalCogs)),
      ytdExpenses: toMoneyNumber(parseDecimal4(pnl.totals.totalExpenses)),
      ytdNetIncome: toMoneyNumber(net4),
      netProfitMarginPct: netMarginPct,
      totalBankCash: toMoneyNumber(bankCash4),
      creditCardDebt: toMoneyNumber(ccLiability4),
      netLiquidCash: toMoneyNumber(bankCash4 - ccLiability4),
      totalArOutstanding: arAging.totals.total,
      totalApOutstanding: apAging.totals.total,
    },
    cashAccounts: cashAccountList,
    arAgingTotals: arAging.totals,
    apAgingTotals: apAging.totals,
    monthlyTrend: monthlyTrend.rows.map(m => ({
      month: m.ym,
      revenue: toMoneyNumber(parseDecimal4(m.revenue)),
      expenses: toMoneyNumber(parseDecimal4(m.expenses)),
    })),
    topDebtors: topCustomers.rows.map(c => ({
      customerId: Number(c.id),
      name: c.company_name,
      balance: toMoneyNumber(parseDecimal4(c.balance)),
    })),
    topCreditors: topVendors.rows.map(v => ({
      vendorId: Number(v.id),
      name: v.company_name,
      balance: toMoneyNumber(parseDecimal4(v.balance)),
    })),
  };
}
