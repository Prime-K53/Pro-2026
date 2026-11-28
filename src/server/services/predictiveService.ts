/**
 * Phase 6 — Predictive intelligence (deterministic, explainable, no ML).
 *
 * Produces review signals (never accusations) as ai_anomaly_alerts:
 *  - duplicate_payment: same vendor + total + date across different bills.
 *  - unusual_expense: a bill materially above the vendor's own historical average.
 *  - likely_shortage: on-hand cover (from recent consumption) below supplier lead time.
 *
 * Every alert cites the records that triggered it. A flag is a review signal only.
 */
import type { Transaction } from '@electric-sql/pglite';

type Severity = 'info' | 'warning' | 'critical';

async function openAlert(
  tx: Transaction,
  companyId: number,
  anomalyType: string,
  severity: Severity,
  description: string,
  evidence: any
): Promise<void> {
  await tx.query(
    `INSERT INTO ai_anomaly_alerts (company_id, anomaly_type, severity, description, evidence, status)
     SELECT $1, $2, $3, $4, $5::jsonb, 'open'
      WHERE NOT EXISTS (
        SELECT 1 FROM ai_anomaly_alerts WHERE company_id = $1 AND anomaly_type = $2 AND status = 'open'
      )`,
    [companyId, anomalyType, severity, description, JSON.stringify(evidence)]
  );
}

/** Expense/transaction anomaly review signals. */
export async function detectExpenseAnomalies(tx: Transaction, companyId: number): Promise<void> {
  // Duplicate payment: identical vendor + total + date on more than one bill.
  const dup = await tx.query<any>(
    `SELECT vendor_id, total::text AS total, bill_date::text AS d, COUNT(*)::int AS c,
            array_agg(bill_number ORDER BY bill_number) AS bills
       FROM bills
      WHERE company_id = $1
      GROUP BY vendor_id, total, bill_date
     HAVING COUNT(*) > 1`,
    [companyId]
  );
  if (dup.rows.length > 0) {
    await openAlert(
      tx, companyId, 'duplicate_payment', 'warning',
      `${dup.rows.length} possible duplicate payment(s): same supplier, amount and date on multiple bills`,
      { count: dup.rows.length, examples: dup.rows.slice(0, 10) }
    );
  }

  // Unusual expense: a bill more than 3x the vendor's own average (excluding itself).
  const out = await tx.query<any>(
    `SELECT b.id, b.bill_number, b.total::text AS total, v.company_name,
            (SELECT AVG(b2.total) FROM bills b2
              WHERE b2.company_id = b.company_id AND b2.vendor_id = b.vendor_id AND b2.id <> b.id) AS avg_total
       FROM bills b
       JOIN vendors v ON v.company_id = b.company_id AND v.id = b.vendor_id
      WHERE b.company_id = $1`,
    [companyId]
  );
  const outliers = out.rows.filter((r: any) => {
    const avg = Number(r.avg_total);
    return avg > 0 && Number(r.total) > avg * 3;
  });
  if (outliers.length > 0) {
    await openAlert(
      tx, companyId, 'unusual_expense', 'warning',
      `${outliers.length} expense(s) more than 3x the supplier's historical average`,
      { count: outliers.length, examples: outliers.slice(0, 10).map((r: any) => ({ bill: r.bill_number, vendor: r.company_name, total: r.total, avg: r.avg_total })) }
    );
  }
}

/** Deterministic stock-shortage forecast from recent consumption and lead time. */
export async function forecastShortages(tx: Transaction, companyId: number): Promise<void> {
  const items = await tx.query<any>(
    `SELECT id, name, sku, on_hand::text AS on_hand, lead_time_days
       FROM inventory_items
      WHERE company_id = $1 AND is_active = TRUE
        AND lead_time_days IS NOT NULL AND lead_time_days > 0
        AND reorder_point > 0 AND on_hand <= reorder_point`,
    [companyId]
  );
  const shortages: any[] = [];
  for (const it of items.rows) {
    const cons = await tx.query<{ qty: string }>(
      `SELECT COALESCE(SUM(actual_good_usage_qty), 0)::text AS qty
         FROM job_material_requirements
        WHERE company_id = $1 AND raw_material_item_id = $2
          AND created_at > NOW() - INTERVAL '30 days'`,
      [companyId, Number(it.id)]
    );
    const consumed = Number(cons.rows[0]?.qty ?? 0);
    const dailyRate = consumed / 30;
    if (dailyRate <= 0) continue; // insufficient history → abstain for this item
    const onHand = Number(it.on_hand);
    const daysCover = onHand / dailyRate;
    const leadTime = Number(it.lead_time_days);
    if (daysCover < leadTime) {
      const expected = new Date(Date.now() + daysCover * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      shortages.push({ sku: it.sku, name: it.name, onHand, dailyRate: Number(dailyRate.toFixed(4)), daysCover: Number(daysCover.toFixed(1)), leadTime, expectedStockout: expected });
    }
  }
  if (shortages.length > 0) {
    await openAlert(
      tx, companyId, 'likely_shortage', 'warning',
      `${shortages.length} item(s) likely to stock out before replenishment can arrive`,
      { count: shortages.length, items: shortages.slice(0, 20) }
    );
  }
}

/** Run all predictive checks (called from the tenant scheduler). */
export async function runPredictiveChecks(tx: Transaction, companyId: number): Promise<void> {
  await detectExpenseAnomalies(tx, companyId);
  await forecastShortages(tx, companyId);
}