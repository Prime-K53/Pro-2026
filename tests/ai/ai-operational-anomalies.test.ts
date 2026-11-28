/**
 * Phase 5 — Operational intelligence: extended anomaly detection, audited
 * acknowledgement transitions, and wastage/delay evidence domains.
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import * as aiService from '../../src/server/services/aiService.ts';
import { buildEvidenceSet } from '../../src/server/services/aiFinancialGrounding.ts';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e: any) { failed++; console.error(`  [FAIL] ${name} — ${e?.message || e}`); }
}
async function expectCode(fn: () => Promise<unknown>, code: string) {
  try { await fn(); } catch (e: any) { assert.equal(e?.code, code, `expected ${code}, got ${e?.code}`); return; }
  throw new Error(`expected ${code}, but succeeded`);
}

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const db: any = srv.db;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM companies ORDER BY id LIMIT 1`)).rows[0].id));
    const adminId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM users WHERE username='admin'`)).rows[0].id));
    const actor = { userId: adminId, username: 'admin', role: 'Administrator' as any };

    console.log('=== Phase 5: Operational Intelligence ===\n');

    await test('detectAnomalies runs and returns an array', async () => {
      const alerts = await db.withCompanyDb(companyId, (tx: any) => aiService.detectAnomalies(tx, companyId));
      assert.ok(Array.isArray(alerts));
    });

    const alertId = await db.withCompanyDb(companyId, async (tx: any) => {
      const r = await tx.query(`INSERT INTO ai_anomaly_alerts (company_id, anomaly_type, severity, description, evidence, status)
        VALUES ($1,'low_stock','info','test','{}'::jsonb,'open') RETURNING id`, [companyId]);
      return Number(r.rows[0].id);
    }, adminId);

    await test('acknowledge transition persists status', async () => {
      const a = await db.withCompanyDb(companyId, (tx: any) => aiService.setAnomalyStatus(tx, companyId, actor, alertId, 'acknowledged'));
      assert.equal(a.status, 'acknowledged');
    });

    await test('resolve transition persists status', async () => {
      const a = await db.withCompanyDb(companyId, (tx: any) => aiService.setAnomalyStatus(tx, companyId, actor, alertId, 'resolved'));
      assert.equal(a.status, 'resolved');
      assert.ok(a.resolvedAt);
    });

    await test('invalid status is rejected', async () => {
      await expectCode(() => db.withCompanyDb(companyId, (tx: any) => aiService.setAnomalyStatus(tx, companyId, actor, alertId, 'bogus')), 'AI_ANOMALY_INVALID_STATUS');
    });

    await test('wastage evidence domain routes and does not abstain', async () => {
      const ev = await db.withCompanyDb(companyId, (tx: any) => buildEvidenceSet(tx, companyId, 'Administrator', 'show wastage'));
      assert.equal(ev.domain, 'wastage');
      assert.equal(ev.abstain, false);
      assert.ok(ev.items.length >= 1);
    });

    await test('production delay evidence domain routes', async () => {
      const ev = await db.withCompanyDb(companyId, (tx: any) => buildEvidenceSet(tx, companyId, 'Administrator', 'which jobs are delayed'));
      assert.equal(ev.domain, 'production_delay');
      assert.equal(ev.abstain, false);
    });

    await test('role without production:read abstains on wastage', async () => {
      const ev = await db.withCompanyDb(companyId, (tx: any) => buildEvidenceSet(tx, companyId, 'NoAccess', 'show wastage'));
      assert.equal(ev.abstain, true);
      assert.equal(ev.items.length, 0);
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exitCode = 1;
  } finally { await srv.close(); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });