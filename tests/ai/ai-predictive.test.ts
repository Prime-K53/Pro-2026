/**
 * Phase 6 — Predictive intelligence: duplicate-payment / unusual-expense signals
 * and deterministic shortage forecasting. Real PGlite; no network.
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import { runPredictiveChecks } from '../../src/server/services/predictiveService.ts';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e: any) { failed++; console.error(`  [FAIL] ${name} — ${e?.message || e}`); }
}
const addDays = (d: string, n: number) => new Date(new Date(d).getTime() + n * 86400000).toISOString().slice(0, 10);

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const db: any = srv.db;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM companies ORDER BY id LIMIT 1`)).rows[0].id));
    const adminId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM users WHERE username='admin'`)).rows[0].id));
    const vendorId = await db.withCompanyDb(companyId, async (tx: any) => {
      const r = await tx.query(`SELECT id FROM vendors WHERE company_id=$1 ORDER BY id LIMIT 1`, [companyId]);
      return r.rows[0] ? Number(r.rows[0].id) : 0;
    });
    const jobId = await db.withCompanyDb(companyId, async (tx: any) => {
      const r = await tx.query(`SELECT id FROM printing_jobs WHERE company_id=$1 ORDER BY id LIMIT 1`, [companyId]);
      return r.rows[0] ? Number(r.rows[0].id) : 0;
    });
    const alertTypes = () => db.withCompanyDb(companyId, async (tx: any) =>
      (await tx.query(`SELECT anomaly_type FROM ai_anomaly_alerts WHERE company_id=$1 AND status='open'`, [companyId])).rows.map((r: any) => r.anomaly_type), adminId);

    console.log('=== Phase 6: Predictive Intelligence ===\n');

    await test('runPredictiveChecks runs without error', async () => {
      await db.withCompanyDb(companyId, (tx: any) => runPredictiveChecks(tx, companyId));
    });

    if (vendorId > 0) {
      await test('duplicate payment + unusual expense are flagged', async () => {
        const today = new Date().toISOString().slice(0, 10);
        const mk = (num: string, total: number) => db.withCompanyDb(companyId, (tx: any) => tx.query(
          `INSERT INTO bills (company_id, bill_number, vendor_id, bill_date, due_date, total, amount_paid, balance_due)
           VALUES ($1,$2,$3,$4,$5,$6,0,$6)`, [companyId, num, vendorId, today, addDays(today, 30), total]), adminId);
        await mk(`DUP-${Date.now()}-A`, 100);
        await mk(`DUP-${Date.now()}-B`, 100);
        await mk(`OUT-${Date.now()}`, 1000);
        await db.withCompanyDb(companyId, (tx: any) => runPredictiveChecks(tx, companyId));
        const types = await alertTypes();
        assert.ok(types.includes('duplicate_payment'), `expected duplicate_payment, got ${types}`);
        assert.ok(types.includes('unusual_expense'), `expected unusual_expense, got ${types}`);
      });
    }

    if (jobId > 0) {
      await test('likely shortage is forecast when cover < lead time', async () => {
        const itemId = await db.withCompanyDb(companyId, async (tx: any) => {
          const r = await tx.query(`SELECT id FROM inventory_items WHERE company_id=$1 AND is_active=TRUE ORDER BY id LIMIT 1`, [companyId]);
          return Number(r.rows[0].id);
        }, adminId);
        await db.withCompanyDb(companyId, (tx: any) => tx.query(
          `UPDATE inventory_items SET lead_time_days = 30, reorder_point = 1000000, on_hand = 10 WHERE company_id=$1 AND id=$2`, [companyId, itemId]), adminId);
        await db.withCompanyDb(companyId, (tx: any) => tx.query(
          `INSERT INTO job_material_requirements (company_id, printing_job_id, raw_material_item_id, material_role, planned_usage_qty, issued_usage_qty, actual_good_usage_qty, waste_usage_qty, returned_usage_qty)
           VALUES ($1,$2,$3,'paper',300,300,300,0,0)
           ON CONFLICT (company_id, printing_job_id, raw_material_item_id, material_role)
           DO UPDATE SET planned_usage_qty=300, issued_usage_qty=300, actual_good_usage_qty=300`, [companyId, jobId, itemId]), adminId);
        await db.withCompanyDb(companyId, (tx: any) => runPredictiveChecks(tx, companyId));
        const types = await alertTypes();
        assert.ok(types.includes('likely_shortage'), `expected likely_shortage, got ${types}`);
      });
    }

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exitCode = 1;
  } finally { await srv.close(); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });