import { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { parseDecimal6, todayIsoDate } from './commercialHelpers.ts';

function p4(value: unknown): bigint {
  return parseDecimal4(value as string | number | bigint | null | undefined);
}

function p6(value: unknown): bigint {
  return parseDecimal6(value as string | number | bigint | null | undefined);
}

interface DateRangeOptions {
  startDate?: string;
  endDate?: string;
}

function resolveRange(options: DateRangeOptions): { startDate: string; endDate: string } {
  const endDate = options.endDate && /^\d{4}-\d{2}-\d{2}$/.test(options.endDate)
    ? options.endDate
    : todayIsoDate();
  const startDate = options.startDate && /^\d{4}-\d{2}-\d{2}$/.test(options.startDate)
    ? options.startDate
    : `${endDate.slice(0, 4)}-01-01`;
  if (startDate > endDate) {
    throw new AccountingError(400, 'startDate cannot be after endDate', 'INVALID_DATE_RANGE');
  }
  return { startDate, endDate };
}

function marginPct4(profit4: bigint, revenue4: bigint): string {
  if (revenue4 <= 0n) return '0.00';
  const bps = (profit4 * 10000n) / revenue4;
  const sign = bps < 0n ? '-' : '';
  const abs = bps < 0n ? -bps : bps;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  const neg = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const q = a / b;
  const r = a % b;
  let rounded = q;
  if (r * 2n > b || (r * 2n === b && q % 2n === 1n)) rounded += 1n;
  return neg ? -rounded : rounded;
}

function multiply6By6To4Exact(a6: bigint, b6: bigint): bigint {
  return roundDiv(a6 * b6, 100000000n);
}

export async function getPrintingJobProfitability(
  tx: Transaction,
  companyId: number,
  options: DateRangeOptions = {}
) {
  const { startDate, endDate } = resolveRange(options);
  const res = await tx.query<Record<string, unknown>>(
    `SELECT pj.id, pj.job_number, pj.title, pj.job_type, pj.status, pj.job_date::text AS job_date,
            pj.customer_name,
            pj.ordered_qty::text AS ordered_qty,
            pj.produced_good_qty::text AS produced_good_qty,
            pj.delivered_qty::text AS delivered_qty,
            pj.invoiced_qty::text AS invoiced_qty,
            pj.manual_selling_price::text AS quoted_price,
            pj.total_cost::text AS booked_cost,
            pj.actual_material_cost::text AS actual_material_cost,
            pj.actual_waste_cost::text AS actual_waste_cost,
            pj.actual_labour_cost::text AS actual_labour_cost,
            pj.actual_machine_cost::text AS actual_machine_cost,
            pj.approved_budget_total::text AS approved_budget_total,
            inv.invoice_number,
            inv.total::text AS invoiced_total,
            inv.status AS invoice_status
       FROM printing_jobs pj
       LEFT JOIN invoices inv
         ON inv.company_id = pj.company_id AND inv.id = pj.invoice_id
      WHERE pj.company_id = $1
        AND pj.job_date BETWEEN $2::DATE AND $3::DATE
      ORDER BY pj.job_date DESC, pj.id DESC`,
    [companyId, startDate, endDate]
  );

  const rows = res.rows.map(row => {
    const bookedCost4 = p4(row.booked_cost ?? 0);
    const actualComponents4 =
      p4(row.actual_material_cost ?? 0) +
      p4(row.actual_waste_cost ?? 0) +
      p4(row.actual_labour_cost ?? 0) +
      p4(row.actual_machine_cost ?? 0);
    const actualCost4 = actualComponents4 > 0n ? actualComponents4 : bookedCost4;
    const invoicedRevenue4 = row.invoiced_total ? p4(row.invoiced_total) : p4(row.quoted_price ?? 0);
    const realizedProfit4 = invoicedRevenue4 - actualCost4;
    const approvedBudget4 = p4(row.approved_budget_total ?? 0);
    return {
      jobId: Number(row.id),
      jobNumber: String(row.job_number),
      title: String(row.title),
      jobType: String(row.job_type),
      status: String(row.status),
      jobDate: String(row.job_date),
      customerName: String(row.customer_name),
      orderedQty: row.ordered_qty,
      producedGoodQty: row.produced_good_qty,
      deliveredQty: row.delivered_qty,
      invoicedQty: row.invoiced_qty,
      quotedPrice: formatDecimal4(p4(row.quoted_price ?? 0)),
      bookedCost: formatDecimal4(bookedCost4),
      actualMaterialCost: formatDecimal4(p4(row.actual_material_cost ?? 0)),
      actualWasteCost: formatDecimal4(p4(row.actual_waste_cost ?? 0)),
      actualLabourCost: formatDecimal4(p4(row.actual_labour_cost ?? 0)),
      actualMachineCost: formatDecimal4(p4(row.actual_machine_cost ?? 0)),
      actualCost: formatDecimal4(actualCost4),
      invoicedRevenue: formatDecimal4(invoicedRevenue4),
      realizedProfit: formatDecimal4(realizedProfit4),
      realizedMarginPct: marginPct4(realizedProfit4, invoicedRevenue4),
      approvedBudget: approvedBudget4 > 0n ? formatDecimal4(approvedBudget4) : null,
      budgetVariance: approvedBudget4 > 0n ? formatDecimal4(actualCost4 - approvedBudget4) : null,
      invoiceNumber: row.invoice_number ? String(row.invoice_number) : null,
      invoiceStatus: row.invoice_status ? String(row.invoice_status) : null,
      actualCost4,
      invoicedRevenue4,
      realizedProfit4,
    };
  });

  let totalActual4 = 0n;
  let totalRevenue4 = 0n;
  let totalProfit4 = 0n;
  for (const r of rows) {
    totalActual4 += r.actualCost4;
    totalRevenue4 += r.invoicedRevenue4;
    totalProfit4 += r.realizedProfit4;
  }

  return {
    companyId,
    startDate,
    endDate,
    rows: rows.map(({ actualCost4: _a, invoicedRevenue4: _r, realizedProfit4: _p, ...rest }) => rest),
    totals: {
      jobCount: rows.length,
      actualCost: formatDecimal4(totalActual4),
      invoicedRevenue: formatDecimal4(totalRevenue4),
      realizedProfit: formatDecimal4(totalProfit4),
      realizedMarginPct: marginPct4(totalProfit4, totalRevenue4),
    },
  };
}

export async function getWipAgingReport(tx: Transaction, companyId: number) {
  const res = await tx.query<Record<string, unknown>>(
    `SELECT pj.id, pj.job_number, pj.title, pj.job_type, pj.status, pj.job_date::text AS job_date,
            pj.customer_name,
            pj.wip_cost_accumulated::text AS wip_cost_accumulated,
            pj.wip_cost_relieved::text AS wip_cost_relieved,
            (pj.wip_cost_accumulated - pj.wip_cost_relieved)::NUMERIC(19,4)::text AS wip_balance,
            (CURRENT_DATE - pj.job_date)::text AS age_days
       FROM printing_jobs pj
      WHERE pj.company_id = $1
        AND pj.wip_cost_accumulated > pj.wip_cost_relieved
        AND pj.status NOT IN ('cancelled', 'completed')
      ORDER BY pj.job_date ASC`,
    [companyId]
  );

  const buckets = { '0-7': 0n, '8-30': 0n, '31-60': 0n, '60+': 0n };
  const rows = res.rows.map(row => {
    const ageDays = Number(row.age_days ?? 0);
    const balance4 = p4(row.wip_balance ?? 0);
    if (ageDays <= 7) buckets['0-7'] += balance4;
    else if (ageDays <= 30) buckets['8-30'] += balance4;
    else if (ageDays <= 60) buckets['31-60'] += balance4;
    else buckets['60+'] += balance4;
    return {
      jobId: Number(row.id),
      jobNumber: String(row.job_number),
      title: String(row.title),
      jobType: String(row.job_type),
      status: String(row.status),
      jobDate: String(row.job_date),
      customerName: String(row.customer_name),
      wipAccumulated: formatDecimal4(p4(row.wip_cost_accumulated ?? 0)),
      wipRelieved: formatDecimal4(p4(row.wip_cost_relieved ?? 0)),
      wipBalance: formatDecimal4(balance4),
      ageDays,
    };
  });

  return {
    companyId,
    asOfDate: todayIsoDate(),
    rows,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, formatDecimal4(v)])),
    totalWip: formatDecimal4(buckets['0-7'] + buckets['8-30'] + buckets['31-60'] + buckets['60+']),
  };
}

export async function getPrintingSpoilageReport(
  tx: Transaction,
  companyId: number,
  options: DateRangeOptions = {}
) {
  const { startDate, endDate } = resolveRange(options);
  const res = await tx.query<Record<string, unknown>>(
    `SELECT pj.id, pj.job_number, pj.title, pj.job_type, pj.status,
            pj.sheets_used::text AS sheets_used,
            pj.paper_cost::text AS paper_cost,
            COALESCE(po.spoilage_sheets, 0)::text AS spoilage_sheets,
            COALESCE(po.good_sheets, 0)::text AS good_sheets,
            COALESCE(pm.click_cost_per_imp, 0)::text AS click_cost_per_imp,
            COALESCE(req.waste_usage_qty, 0)::text AS waste_usage_qty,
            COALESCE(req.issued_avg_unit_cost, 0)::text AS issued_avg_unit_cost,
            COALESCE(req.planned_usage_qty, 0)::text AS planned_usage_qty,
            COALESCE(req.actual_good_usage_qty, 0)::text AS actual_good_usage_qty
       FROM printing_jobs pj
       LEFT JOIN (
         SELECT printing_job_id,
                SUM(spoilage_sheets) AS spoilage_sheets,
                SUM(good_sheets) AS good_sheets
           FROM production_operations
          WHERE company_id = $1
          GROUP BY printing_job_id
       ) po ON po.printing_job_id = pj.id
       LEFT JOIN printing_machines pm
         ON pm.company_id = pj.company_id AND pm.id = pj.machine_id
       LEFT JOIN (
         SELECT printing_job_id,
                SUM(waste_usage_qty) AS waste_usage_qty,
                SUM(issued_avg_unit_cost * issued_usage_qty) / NULLIF(SUM(issued_usage_qty), 0) AS issued_avg_unit_cost,
                SUM(planned_usage_qty) AS planned_usage_qty,
                SUM(actual_good_usage_qty) AS actual_good_usage_qty
           FROM job_material_requirements
          WHERE company_id = $1
          GROUP BY printing_job_id
       ) req ON req.printing_job_id = pj.id
      WHERE pj.company_id = $1
        AND pj.job_date BETWEEN $2::DATE AND $3::DATE
      ORDER BY pj.job_date DESC, pj.id DESC`,
    [companyId, startDate, endDate]
  );

  const rows = res.rows.map(row => {
    const spoilageSheets6 = p6(row.spoilage_sheets ?? 0);
    const goodSheets6 = p6(row.good_sheets ?? 0);
    const paperCost4 = p4(row.paper_cost ?? 0);
    const clickCost6 = p6(row.click_cost_per_imp ?? 0);
    const totalSheets6 = spoilageSheets6 + goodSheets6;
    const spoilageSheetCost4 =
      totalSheets6 > 0n ? roundDiv(paperCost4 * spoilageSheets6, totalSheets6) : 0n;
    const machineClickCost4 = multiply6By6To4Exact(clickCost6, spoilageSheets6);
    const wasteQty6 = p6(row.waste_usage_qty ?? 0);
    const wasteUnitCost6 = p6(row.issued_avg_unit_cost ?? 0);
    const wasteCost4 = multiply6By6To4Exact(wasteQty6, wasteUnitCost6);
    return {
      jobId: Number(row.id),
      jobNumber: String(row.job_number),
      title: String(row.title),
      jobType: String(row.job_type),
      status: String(row.status),
      sheetsUsed: row.sheets_used,
      paperCost: formatDecimal4(paperCost4),
      spoilageSheets: row.spoilage_sheets,
      goodSheets: row.good_sheets,
      spoilagePct:
        totalSheets6 > 0n
          ? `${Number((spoilageSheets6 * 10000n) / totalSheets6) / 100}`
          : '0.00',
      wasteUsageQty: row.waste_usage_qty,
      wasteCost: formatDecimal4(wasteCost4),
      spoilageMaterialCost: formatDecimal4(spoilageSheetCost4),
      machineClickCost: formatDecimal4(machineClickCost4),
      totalSpoilageCost: formatDecimal4(spoilageSheetCost4 + machineClickCost4 + wasteCost4),
    };
  });

  return {
    companyId,
    startDate,
    endDate,
    rows,
    totals: {
      spoilageMaterialCost: formatDecimal4(
        rows.reduce((s, r) => s + p4(r.spoilageMaterialCost), 0n)
      ),
      machineClickCost: formatDecimal4(rows.reduce((s, r) => s + p4(r.machineClickCost), 0n)),
      wasteCost: formatDecimal4(rows.reduce((s, r) => s + p4(r.wasteCost), 0n)),
      totalSpoilageCost: formatDecimal4(rows.reduce((s, r) => s + p4(r.totalSpoilageCost), 0n)),
    },
  };
}

export async function getEstimateVsActualReport(
  tx: Transaction,
  companyId: number,
  options: DateRangeOptions = {}
) {
  const { startDate, endDate } = resolveRange(options);
  const res = await tx.query<Record<string, unknown>>(
    `SELECT pe.id, pe.estimate_number, pe.title, pe.estimate_date::text AS estimate_date,
            pe.status AS estimate_status,
            pe.total_cost::text AS estimated_cost,
            pe.manual_selling_price::text AS quoted_price,
            pj.job_number, pj.job_date::text AS job_date, pj.status AS job_status,
            pj.total_cost::text AS actual_booked_cost,
            pj.actual_material_cost::text AS actual_material_cost,
            pj.actual_waste_cost::text AS actual_waste_cost,
            pj.actual_labour_cost::text AS actual_labour_cost,
            pj.actual_machine_cost::text AS actual_machine_cost,
            inv.invoice_number,
            inv.total::text AS invoiced_total
       FROM printing_estimates pe
       LEFT JOIN printing_jobs pj
         ON pj.company_id = pe.company_id AND pj.printing_estimate_id = pe.id
       LEFT JOIN invoices inv
         ON inv.company_id = pj.company_id AND inv.id = pj.invoice_id
      WHERE pe.company_id = $1
        AND pe.estimate_date BETWEEN $2::DATE AND $3::DATE
      ORDER BY pe.estimate_date DESC, pe.id DESC`,
    [companyId, startDate, endDate]
  );

  const rows = res.rows.map(row => {
    const estimatedCost4 = p4(row.estimated_cost ?? 0);
    const booked4 = p4(row.actual_booked_cost ?? 0);
    const actualComponents4 =
      p4(row.actual_material_cost ?? 0) +
      p4(row.actual_waste_cost ?? 0) +
      p4(row.actual_labour_cost ?? 0) +
      p4(row.actual_machine_cost ?? 0);
    const actualCost4 = actualComponents4 > 0n ? actualComponents4 : booked4;
    const quoted4 = p4(row.quoted_price ?? 0);
    const invoiced4 = row.invoiced_total ? p4(row.invoiced_total) : quoted4;
    return {
      estimateId: Number(row.id),
      estimateNumber: String(row.estimate_number),
      title: String(row.title),
      estimateDate: String(row.estimate_date),
      estimateStatus: String(row.estimate_status),
      jobNumber: row.job_number ? String(row.job_number) : null,
      jobDate: row.job_date ? String(row.job_date) : null,
      jobStatus: row.job_status ? String(row.job_status) : null,
      estimatedCost: formatDecimal4(estimatedCost4),
      actualCost: formatDecimal4(actualCost4),
      costVariance: formatDecimal4(actualCost4 - estimatedCost4),
      quotedPrice: formatDecimal4(quoted4),
      invoicedRevenue: formatDecimal4(invoiced4),
      estimatedProfit: formatDecimal4(quoted4 - estimatedCost4),
      actualProfit: formatDecimal4(invoiced4 - actualCost4),
      invoiceNumber: row.invoice_number ? String(row.invoice_number) : null,
      actualCost4,
      invoiced4,
      quoted4,
      estimatedCost4,
    };
  });

  const totals = rows.reduce(
    (acc, r) => {
      acc.estimatedCost4 += r.estimatedCost4;
      acc.actualCost4 += r.actualCost4;
      acc.quoted4 += r.quoted4;
      acc.invoiced4 += r.invoiced4;
      return acc;
    },
    { estimatedCost4: 0n, actualCost4: 0n, quoted4: 0n, invoiced4: 0n }
  );

  return {
    companyId,
    startDate,
    endDate,
    rows: rows.map(({ actualCost4: _a, invoiced4: _i, quoted4: _q, estimatedCost4: _e, ...rest }) => rest),
    totals: {
      estimateCount: rows.length,
      estimatedCost: formatDecimal4(totals.estimatedCost4),
      actualCost: formatDecimal4(totals.actualCost4),
      costVariance: formatDecimal4(totals.actualCost4 - totals.estimatedCost4),
      quotedPrice: formatDecimal4(totals.quoted4),
      invoicedRevenue: formatDecimal4(totals.invoiced4),
      estimatedProfit: formatDecimal4(totals.quoted4 - totals.estimatedCost4),
      actualProfit: formatDecimal4(totals.invoiced4 - totals.actualCost4),
    },
  };
}

export async function getInventoryValuationReport(tx: Transaction, companyId: number) {
  const res = await tx.query<Record<string, unknown>>(
    `SELECT i.id, i.sku, i.name, i.item_type,
            i.on_hand::text AS on_hand,
            i.reserved_qty::text AS reserved_qty,
            i.avg_cost::text AS avg_cost,
            ROUND(i.on_hand * i.avg_cost, 4)::NUMERIC(19,4)::text AS value,
            a.code AS asset_account_code,
            a.name AS asset_account_name
       FROM inventory_items i
       JOIN accounts a
         ON a.company_id = i.company_id AND a.id = i.asset_account_id
      WHERE i.company_id = $1
        AND i.item_type IN ('raw_material', 'stationery')
        AND (i.on_hand <> 0 OR i.reserved_qty <> 0)
      ORDER BY i.item_type ASC, i.sku ASC`,
    [companyId]
  );

  const glRes = await tx.query<{ balance: string }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::NUMERIC(19,4)::text AS balance
       FROM journal_lines jl
       JOIN journal_transactions jt
         ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
       JOIN accounts a
         ON a.company_id = jl.company_id AND a.id = jl.account_id
      WHERE jl.company_id = $1
        AND jt.is_posted = TRUE
        AND a.account_type = 'Inventory'`,
    [companyId]
  );

  let total4 = 0n;
  const byType: Record<string, bigint> = { raw_material: 0n, stationery: 0n };
  const rows = res.rows.map(row => {
    const value4 = p4(row.value ?? 0);
    total4 += value4;
    const type = String(row.item_type);
    byType[type] = (byType[type] ?? 0n) + value4;
    return {
      itemId: Number(row.id),
      sku: String(row.sku),
      name: String(row.name),
      itemType: type,
      onHand: row.on_hand,
      reservedQty: row.reserved_qty,
      avgCost: row.avg_cost,
      value: formatDecimal4(value4),
      assetAccountCode: row.asset_account_code ? String(row.asset_account_code) : null,
      assetAccountName: row.asset_account_name ? String(row.asset_account_name) : null,
    };
  });

  const gl4 = p4(glRes.rows[0]?.balance ?? '0');
  return {
    companyId,
    asOfDate: todayIsoDate(),
    rows,
    totals: {
      inventoryValue: formatDecimal4(total4),
      rawMaterialValue: formatDecimal4(byType.raw_material ?? 0n),
      stationeryValue: formatDecimal4(byType.stationery ?? 0n),
      generalLedgerInventory: formatDecimal4(gl4),
      difference: formatDecimal4(total4 - gl4),
      reconciled: (total4 - gl4 === 0n),
    },
  };
}

export async function getCogsReconciliationReport(
  tx: Transaction,
  companyId: number,
  options: DateRangeOptions = {}
) {
  const { startDate, endDate } = resolveRange(options);

  const glRes = await tx.query<Record<string, unknown>>(
    `SELECT a.id, a.code, a.name,
            COALESCE(SUM(jl.debit - jl.credit), 0)::NUMERIC(19,4)::text AS cogs
       FROM journal_lines jl
       JOIN journal_transactions jt
         ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
       JOIN accounts a
         ON a.company_id = jl.company_id AND a.id = jl.account_id
      WHERE jl.company_id = $1
        AND jt.is_posted = TRUE
        AND a.account_type = 'CostOfGoodsSold'
        AND jt.txn_date BETWEEN $2::DATE AND $3::DATE
      GROUP BY a.id, a.code, a.name
      ORDER BY a.code ASC NULLS LAST`,
    [companyId, startDate, endDate]
  );

  const movementRes = await tx.query<Record<string, unknown>>(
    `SELECT
        COALESCE(SUM(ABS(quantity_delta) * unit_cost), 0)::NUMERIC(19,4)::text AS subledger_cogs,
        COUNT(*)::text AS movement_count
       FROM inventory_movements
      WHERE company_id = $1
        AND movement_type IN ('sale', 'production_consume')
        AND movement_at >= $2::TIMESTAMPTZ
        AND movement_at < ($3::DATE + INTERVAL '1 day')`,
    [companyId, `${startDate}T00:00:00Z`, endDate]
  );

  const adjustmentsRes = await tx.query<{ value: string }>(
    `SELECT COALESCE(SUM(ABS(quantity_delta) * unit_cost), 0)::NUMERIC(19,4)::text AS value
       FROM inventory_movements
      WHERE company_id = $1
        AND movement_type = 'adjustment'
        AND movement_at >= $2::TIMESTAMPTZ
        AND movement_at < ($3::DATE + INTERVAL '1 day')`,
    [companyId, `${startDate}T00:00:00Z`, endDate]
  );

  let glTotal4 = 0n;
  const lines = glRes.rows.map(row => {
    const value4 = p4(row.cogs ?? 0);
    glTotal4 += value4;
    return {
      accountId: Number(row.id),
      accountCode: row.code ? String(row.code) : null,
      accountName: String(row.name),
      cogs: formatDecimal4(value4),
    };
  });

  const subledger4 = p4(movementRes.rows[0]?.subledger_cogs ?? '0');
  const adjustments4 = p4(adjustmentsRes.rows[0]?.value ?? '0');
  const difference4 = glTotal4 - subledger4;
  const tolerance4 = 100n;

  return {
    companyId,
    startDate,
    endDate,
    lines,
    totals: {
      glCogs: formatDecimal4(glTotal4),
      subledgerCogs: formatDecimal4(subledger4),
      inventoryAdjustments: formatDecimal4(adjustments4),
      movementCount: Number(movementRes.rows[0]?.movement_count ?? 0),
      difference: formatDecimal4(difference4),
      tolerance: formatDecimal4(tolerance4),
      reconciled: (difference4 < 0n ? -difference4 : difference4) <= tolerance4,
    },
  };
}