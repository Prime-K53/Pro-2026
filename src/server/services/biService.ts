import { Transaction } from '@electric-sql/pglite';

export interface SalesTrend {
  period: string;
  invoiceCount: number;
  revenue: string;
  cost: string;
  margin: string;
}

export interface KpiScorecard {
  totalInvoices: number;
  totalRevenue: string;
  totalCost: string;
  grossProfit: string;
  grossMargin: string;
  revenueTarget: string | null;
  revenueVariance: string | null;
  totalCustomers: number;
  totalInventoryItems: number;
  outstandingReceivables: string;
}

export interface InventoryTurnoverItem {
  name: string;
  sku: string;
  onHand: string;
  totalMovement: string;
}

export interface CashierPerformance {
  cashier: string;
  orderCount: number;
  totalSales: string;
}

export async function getSalesTrends(tx: Transaction, companyId: number, period: string): Promise<SalesTrend[]> {
  const truncMap: Record<string, string> = {
    daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year',
  };
  const trunc = truncMap[period] || 'month';
  const res = await tx.query<any>(
    `SELECT DATE_TRUNC($2, invoice_date)::date AS period,
            COUNT(*)::text AS invoice_count,
            COALESCE(SUM(total), 0)::text AS revenue,
            COALESCE(SUM(total_cost), 0)::text AS cost,
            COALESCE(SUM(total - total_cost), 0)::text AS margin
     FROM invoices WHERE company_id = $1 AND status NOT IN ('voided', 'draft')
     GROUP BY 1 ORDER BY 1`,
    [companyId, trunc]
  );
  return res.rows.map((r: any) => ({ period: r.period, invoiceCount: Number(r.invoice_count), revenue: r.revenue, cost: r.cost, margin: r.margin }));
}

export async function getKpiScorecard(tx: Transaction, companyId: number): Promise<KpiScorecard> {
  const [inv, cust, items, receivables, target] = await Promise.all([
    tx.query<any>(`SELECT COUNT(*)::text AS cnt, COALESCE(SUM(total), 0)::text AS total, COALESCE(SUM(total_cost), 0)::text AS cost FROM invoices WHERE company_id = $1 AND status NOT IN ('voided', 'draft')`, [companyId]),
    tx.query<any>(`SELECT COUNT(*)::text AS cnt FROM customers WHERE company_id = $1 AND is_active = TRUE`, [companyId]),
    tx.query<any>(`SELECT COUNT(*)::text AS cnt FROM inventory_items WHERE company_id = $1 AND is_active = TRUE`, [companyId]),
    tx.query<any>(`SELECT COALESCE(SUM(balance_due), 0)::text AS total FROM invoices WHERE company_id = $1 AND balance_due > 0`, [companyId]),
    tx.query<any>(`SELECT target_value::text AS target FROM bi_kpi_targets WHERE company_id = $1 AND kpi_key = 'revenue' ORDER BY effective_from DESC LIMIT 1`, [companyId]),
  ]);
  const revenue = Number(inv.rows[0].total);
  const cost = Number(inv.rows[0].cost);
  const grossProfit = revenue - cost;
  const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  return {
    totalInvoices: Number(inv.rows[0].cnt),
    totalRevenue: inv.rows[0].total,
    totalCost: inv.rows[0].cost,
    grossProfit: grossProfit.toFixed(2),
    grossMargin: grossMargin.toFixed(2),
    revenueTarget: target.rows[0]?.target ?? null,
    revenueVariance:
      target.rows[0]?.target != null
        ? (revenue - Number(target.rows[0].target)).toFixed(2)
        : null,
    totalCustomers: Number(cust.rows[0].cnt),
    totalInventoryItems: Number(items.rows[0].cnt),
    outstandingReceivables: receivables.rows[0].total,
  };
}

export async function getInventoryTurnover(tx: Transaction, companyId: number): Promise<InventoryTurnoverItem[]> {
  const res = await tx.query<any>(
    `SELECT ii.name, ii.sku, ii.on_hand::text,
            COALESCE(SUM(im.quantity_delta), 0)::text AS total_movement
     FROM inventory_items ii
     LEFT JOIN inventory_movements im ON im.company_id = ii.company_id AND im.item_id = ii.id
     WHERE ii.company_id = $1 AND ii.is_active = TRUE
     GROUP BY ii.id, ii.name, ii.sku, ii.on_hand ORDER BY ii.name`,
    [companyId]
  );
  return res.rows.map((r: any) => ({ name: r.name, sku: r.sku, onHand: r.on_hand, totalMovement: r.total_movement }));
}

export async function getPosCashierPerformance(tx: Transaction, companyId: number): Promise<CashierPerformance[]> {
  const res = await tx.query<any>(
    `SELECT u.username, COUNT(po.id)::text AS order_count, COALESCE(SUM(po.total), 0)::text AS total_sales
     FROM pos_orders po JOIN users u ON u.id = po.created_by
     WHERE po.company_id = $1 AND po.status = 'completed'
     GROUP BY u.username ORDER BY total_sales DESC`,
    [companyId]
  );
  return res.rows.map((r: any) => ({ cashier: r.username, orderCount: Number(r.order_count), totalSales: r.total_sales }));
}
// ─── GL reconciliation ─────────────────────────────────────────────────

export interface BiReconciliationCheck {
  name: string;
  ok: boolean;
  gated: boolean;
  invoice: string;
  gl: string;
  difference: string;
}

export interface BiReconciliation {
  balanced: boolean;
  invoiceRevenue: string;
  glRevenue: string;
  invoiceReceivables: string;
  glReceivables: string;
  checks: BiReconciliationCheck[];
}

/**
 * Reconcile BI totals against authoritative GL balances.
 * Uses account codes (4xxx revenue, 1200 receivables) rather than a
 * parallel revenue calculation.
 */
export async function getBiReconciliation(
  tx: Transaction,
  companyId: number
): Promise<BiReconciliation> {
  const inv = await tx.query<{ revenue: string; ar: string }>(
    `SELECT COALESCE(SUM(total), 0)::text AS revenue,
            COALESCE(SUM(balance_due), 0)::text AS ar
       FROM invoices
      WHERE company_id = $1 AND status NOT IN ('voided', 'draft')`,
    [companyId]
  );

  const rev = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS total
       FROM journal_lines jl
       JOIN accounts a ON a.company_id = jl.company_id AND a.id = jl.account_id
       JOIN journal_transactions jt ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
      WHERE jl.company_id = $1 AND a.code LIKE '4%' AND jt.source_type = 'invoice'`,
    [companyId]
  );

  const ar = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS total
       FROM journal_lines jl
       JOIN accounts a ON a.company_id = jl.company_id AND a.id = jl.account_id
       JOIN journal_transactions jt ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
      WHERE jl.company_id = $1 AND a.code = '1200' AND jt.source_type = 'invoice'`,
    [companyId]
  );

  const invoiceRevenue = Number(inv.rows[0]?.revenue ?? 0);
  const glRevenue = Number(rev.rows[0]?.total ?? 0);
  const invoiceReceivables = Number(inv.rows[0]?.ar ?? 0);
  const glReceivables = Number(ar.rows[0]?.total ?? 0);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

  const checks: BiReconciliationCheck[] = [
    {
      name: 'revenue_invoices_equal_gl',
      ok: near(invoiceRevenue, glRevenue),
      gated: true,
      invoice: invoiceRevenue.toFixed(2),
      gl: glRevenue.toFixed(2),
      difference: (invoiceRevenue - glRevenue).toFixed(2),
    },
    {
      name: 'receivables_informational',
      ok: near(invoiceReceivables, glReceivables),
      gated: false,
      invoice: invoiceReceivables.toFixed(2),
      gl: glReceivables.toFixed(2),
      difference: (invoiceReceivables - glReceivables).toFixed(2),
    },
  ];

  return {
    balanced: checks.filter(c => c.gated).every(c => c.ok),
    invoiceRevenue: invoiceRevenue.toFixed(2),
    glRevenue: glRevenue.toFixed(2),
    invoiceReceivables: invoiceReceivables.toFixed(2),
    glReceivables: glReceivables.toFixed(2),
    checks,
  };
}

// ─── AR ageing ──────────────────────────────────────────────────────────

export interface ArAgeingBucket {
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
  count: number;
  amount: string;
}

export async function getArAgeing(tx: Transaction, companyId: number): Promise<ArAgeingBucket[]> {
  const res = await tx.query<{ bucket: string; count: string; amount: string }>(
    `SELECT
       CASE
         WHEN invoice_date >= CURRENT_DATE THEN 'current'
         WHEN invoice_date >= CURRENT_DATE - 30 THEN '1-30'
         WHEN invoice_date >= CURRENT_DATE - 60 THEN '31-60'
         WHEN invoice_date >= CURRENT_DATE - 90 THEN '61-90'
         ELSE '90+'
       END AS bucket,
       COUNT(*)::text AS count,
       COALESCE(SUM(balance_due), 0)::text AS amount
     FROM invoices
    WHERE company_id = $1 AND balance_due > 0 AND status NOT IN ('voided', 'draft')
    GROUP BY 1`,
    [companyId]
  );
  const order: ArAgeingBucket['bucket'][] = ['current', '1-30', '31-60', '61-90', '90+'];
  const byBucket = new Map(res.rows.map(r => [r.bucket, r]));
  return order.map(bucket => {
    const row = byBucket.get(bucket);
    return {
      bucket,
      count: Number(row?.count ?? 0),
      amount: row?.amount ?? '0',
    };
  });
}

// ─── KPI targets & drill-down ───────────────────────────────────────────

export interface KpiTarget {
  id: number;
  kpiKey: string;
  targetValue: string;
  period: string;
  effectiveFrom: string;
}

export async function listKpiTargets(tx: Transaction, companyId: number): Promise<KpiTarget[]> {
  const res = await tx.query<any>(
    `SELECT id, kpi_key, target_value::text AS target_value, period, effective_from::text AS effective_from
       FROM bi_kpi_targets WHERE company_id = $1 ORDER BY kpi_key, effective_from DESC`,
    [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    kpiKey: r.kpi_key,
    targetValue: r.target_value,
    period: r.period,
    effectiveFrom: String(r.effective_from).slice(0, 10),
  }));
}

export async function upsertKpiTarget(
  tx: Transaction,
  companyId: number,
  input: { kpiKey: string; targetValue: number; period?: string; effectiveFrom?: string }
): Promise<KpiTarget> {
  const period = input.period || 'monthly';
  const effectiveFrom = input.effectiveFrom || new Date().toISOString().slice(0, 10);
  const res = await tx.query<any>(
    `INSERT INTO bi_kpi_targets (company_id, kpi_key, target_value, period, effective_from)
     VALUES ($1, $2, $3, $4, $5::date)
     ON CONFLICT (company_id, kpi_key, period, effective_from)
     DO UPDATE SET target_value = EXCLUDED.target_value
     RETURNING id, kpi_key, target_value::text AS target_value, period, effective_from::text AS effective_from`,
    [companyId, input.kpiKey, input.targetValue, period, effectiveFrom]
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    kpiKey: r.kpi_key,
    targetValue: r.target_value,
    period: r.period,
    effectiveFrom: String(r.effective_from).slice(0, 10),
  };
}

export async function getRevenueDrilldown(
  tx: Transaction,
  companyId: number,
  limit = 50
): Promise<Array<{ id: number; number: string; customer: string; date: string; total: string; status: string }>> {
  const res = await tx.query<any>(
    `SELECT i.id, i.invoice_number, COALESCE(c.name, '') AS customer_name,
            i.invoice_date::text AS invoice_date, i.total::text, i.status
       FROM invoices i
       LEFT JOIN customers c ON c.company_id = i.company_id AND c.id = i.customer_id
      WHERE i.company_id = $1 AND i.status NOT IN ('voided', 'draft')
      ORDER BY i.invoice_date DESC, i.id DESC
      LIMIT $2`,
    [companyId, limit]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    number: r.invoice_number,
    customer: r.customer_name,
    date: String(r.invoice_date).slice(0, 10),
    total: r.total,
    status: r.status,
  }));
}

// ─── Sales split (settled vs outstanding) ──────────────────────────────

export interface SalesSplit {
  settled: string;
  outstanding: string;
  total: string;
}

export async function getSalesSplit(tx: Transaction, companyId: number): Promise<SalesSplit> {
  const res = await tx.query<{ settled: string; outstanding: string; total: string }>(
    `SELECT COALESCE(SUM(total) FILTER (WHERE balance_due = 0), 0)::text AS settled,
            COALESCE(SUM(balance_due), 0)::text AS outstanding,
            COALESCE(SUM(total), 0)::text AS total
       FROM invoices
      WHERE company_id = $1 AND status NOT IN ('voided', 'draft')`,
    [companyId]
  );
  const r = res.rows[0];
  return { settled: r.settled, outstanding: r.outstanding, total: r.total };
}
