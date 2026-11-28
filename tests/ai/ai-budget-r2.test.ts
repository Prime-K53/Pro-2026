/**
 * D-05/R2 — immutable period, strict settlement state machine, operational
 * recovery. Real service logic on isolated in-memory PGlite. Multi-connection
 * PostgreSQL concurrency is NOT available here (reported as a blocker).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer } from '../helpers/testServer.ts';
import * as aiService from '../../src/server/services/aiService.ts';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e: any) { failed++; console.error(`  [FAIL] ${name} — ${e?.message || e}`); }
}

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const { db } = srv;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM companies ORDER BY id LIMIT 1`)).rows[0].id));
    const adminId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM users WHERE username='admin'`)).rows[0].id));
    const counters = (period: string) => db.withCompanyDb(companyId, async (tx: any) => (await tx.query(`SELECT reserved_tokens, settled_tokens FROM ai_budget_usage WHERE company_id=$1 AND period=$2`, [companyId, period])).rows[0], 1);
    const setLimit = (n: number) => db.withCompanyDb(companyId, (tx: any) => aiService.upsertAiBudget(tx, companyId, { monthlyTokenLimit: n }), 1);
    const insertAttempt = (period: string, reserved: number, state = 'reserved') =>
      db.withCompanyDb(companyId, async (tx: any) => {
        await tx.query(`INSERT INTO ai_budget_usage (company_id, period, reserved_tokens, settled_tokens) VALUES ($1,$2,$3,0) ON CONFLICT (company_id,period) DO NOTHING`, [companyId, period, reserved]);
        const a = await tx.query(`INSERT INTO ai_usage_attempts (company_id, request_id, attempt_no, provider, model, reservation_tokens, state, period) VALUES ($1,$2::UUID,1,'p','m',$3,$4,$5) RETURNING id`, [companyId, crypto.randomUUID(), reserved, state, period]);
        return Number(a.rows[0].id);
      }, 1);

    console.log('=== D-05/R2 ===\n');

    await test('A1. reserve Jan, settle in Nov → Jan counter reduced, Nov not charged', async () => {
      const id = await insertAttempt('2026-01', 5000);
      await db.withCompanyDb(companyId, (tx: any) => aiService.settleAttempt(tx, companyId, id, { totalTokens: 5000 }), 1);
      const jan = await counters('2026-01');
      const now = new Date().toISOString().slice(0, 7);
      const cur = now === '2026-01' ? jan : await counters(now);
      assert.equal(Number(jan.reserved_tokens), 0, 'Jan reserved released');
      assert.equal(Number(jan.settled_tokens), 5000, 'Jan settled charged');
      if (now !== '2026-01') assert.ok(!cur || Number(cur.settled_tokens) === 0, 'current month not charged');
    });

    await test('A2. reserve Jan, definite failure in Nov → Jan released', async () => {
      const id = await insertAttempt('2026-01', 3000);
      await db.withCompanyDb(companyId, (tx: any) => aiService.recordProviderFailure(tx, companyId, id, false, '4xx'), 1);
      const jan = await counters('2026-01');
      assert.equal(Number(jan.reserved_tokens), 0);
    });

    await test('B1. reserved → settled (normal)', async () => {
      const id = await insertAttempt('2026-02', 1000);
      await db.withCompanyDb(companyId, (tx: any) => aiService.settleAttempt(tx, companyId, id, { totalTokens: 400 }), 1);
      const row = await db.withCompanyDb(companyId, async (tx: any) => (await tx.query(`SELECT state,total_tokens FROM ai_usage_attempts WHERE company_id=$1 AND id=$2`, [companyId, id])).rows[0], 1);
      assert.equal(row.state, 'settled');
    });

    await test('B2. duplicate settlement does not double count', async () => {
      const id = await insertAttempt('2026-02', 1000);
      await db.withCompanyDb(companyId, (tx: any) => aiService.settleAttempt(tx, companyId, id, { totalTokens: 400 }), 1);
      const before = await counters('2026-02');
      await db.withCompanyDb(companyId, (tx: any) => aiService.settleAttempt(tx, companyId, id, { totalTokens: 400 }), 1);
      const after = await counters('2026-02');
      assert.equal(Number(after.settled_tokens), Number(before.settled_tokens));
    });

    await test('B3. released → settled rejected (no counter change)', async () => {
      const id = await insertAttempt('2026-03', 1000);
      await db.withCompanyDb(companyId, (tx: any) => aiService.recordProviderFailure(tx, companyId, id, false, '4xx'), 1);
      const before = await counters('2026-03');
      await db.withCompanyDb(companyId, (tx: any) => aiService.settleAttempt(tx, companyId, id, { totalTokens: 999 }), 1);
      const row = await db.withCompanyDb(companyId, async (tx: any) => (await tx.query(`SELECT state FROM ai_usage_attempts WHERE company_id=$1 AND id=$2`, [companyId, id])).rows[0], 1);
      const after = await counters('2026-03');
      assert.equal(row.state, 'released');
      assert.equal(Number(after.settled_tokens), Number(before.settled_tokens));
    });

    await test('B4. unresolved → settled rejected via ordinary path', async () => {
      const id = await insertAttempt('2026-03', 1000);
      await db.withCompanyDb(companyId, (tx: any) => aiService.recordProviderFailure(tx, companyId, id, true, 'timeout'), 1);
      await db.withCompanyDb(companyId, (tx: any) => aiService.settleAttempt(tx, companyId, id, { totalTokens: 999 }), 1);
      const row = await db.withCompanyDb(companyId, async (tx: any) => (await tx.query(`SELECT state FROM ai_usage_attempts WHERE company_id=$1 AND id=$2`, [companyId, id])).rows[0], 1);
      assert.equal(row.state, 'unresolved');
    });

    await test('B5. concurrent duplicate settlement settles once', async () => {
      const id = await insertAttempt('2026-04', 1000);
      const before = await counters('2026-04');
      await Promise.allSettled([
        db.withCompanyDb(companyId, (tx: any) => aiService.settleAttempt(tx, companyId, id, { totalTokens: 500 }), 1),
        db.withCompanyDb(companyId, (tx: any) => aiService.settleAttempt(tx, companyId, id, { totalTokens: 500 }), 1),
      ]);
      const after = await counters('2026-04');
      assert.equal(Number(after.settled_tokens) - Number(before.settled_tokens), 500, 'counted exactly once');
    });

    await test('C1. recovery marks stale reserved → unresolved, no release', async () => {
      const id = await insertAttempt('2026-05', 2000);
      await db.withCompanyDb(companyId, async (tx: any) => { await tx.query(`UPDATE ai_usage_attempts SET reserved_at = NOW() - INTERVAL '2 hours' WHERE company_id=$1 AND id=$2`, [companyId, id]); }, 1);
      const before = await counters('2026-05');
      const n = await db.withCompanyDb(companyId, (tx: any) => aiService.recoverUnresolvedAttempts(tx, companyId, adminId), 1);
      const row = await db.withCompanyDb(companyId, async (tx: any) => (await tx.query(`SELECT state FROM ai_usage_attempts WHERE company_id=$1 AND id=$2`, [companyId, id])).rows[0], 1);
      const after = await counters('2026-05');
      assert.ok(n >= 1);
      assert.equal(row.state, 'unresolved');
      assert.equal(Number(after.reserved_tokens), Number(before.reserved_tokens), 'reservation not released');
    });

    await test('C2. repeated recovery is idempotent', async () => {
      const n2 = await db.withCompanyDb(companyId, (tx: any) => aiService.recoverUnresolvedAttempts(tx, companyId, adminId), 1);
      assert.equal(n2, 0, 'no eligible rows remain');
    });

    await test('C3. recoverAllUnresolved runs across companies without throwing', async () => {
      const r = await aiService.recoverAllUnresolved(db);
      assert.ok(r.companies >= 1 && r.failed === 0);
    });

    await test('D. reconcile is fail-closed without server-bound provider evidence', async () => {
      const id = await insertAttempt('2026-06', 1000);
      await db.withCompanyDb(companyId, (tx: any) => aiService.recordProviderFailure(tx, companyId, id, true, 'timeout'), 1);
      // No provider_request_id recorded → reconciliation must reject (fail-closed).
      const ok1 = await db.withCompanyDb(companyId, (tx: any) => aiService.reconcileUnresolvedAttempt(tx, companyId, id, { totalTokens: 700 }, { providerRequestId: 'spoof' }, adminId), 1);
      const row1 = await db.withCompanyDb(companyId, async (tx: any) => (await tx.query(`SELECT state FROM ai_usage_attempts WHERE company_id=$1 AND id=$2`, [companyId, id])).rows[0], 1);
      assert.equal(ok1, false);
      assert.equal(row1.state, 'unresolved');
      // With a server-recorded provider request id + matching evidence → reconciles.
      await db.withCompanyDb(companyId, (tx: any) => tx.query(`UPDATE ai_usage_attempts SET provider_request_id='req-123' WHERE company_id=$1 AND id=$2`, [companyId, id]), 1);
      const ok2 = await db.withCompanyDb(companyId, (tx: any) => aiService.reconcileUnresolvedAttempt(tx, companyId, id, { totalTokens: 700 }, { providerRequestId: 'req-123' }, adminId), 1);
      const row2 = await db.withCompanyDb(companyId, async (tx: any) => (await tx.query(`SELECT state,total_tokens FROM ai_usage_attempts WHERE company_id=$1 AND id=$2`, [companyId, id])).rows[0], 1);
      assert.equal(ok2, true);
      assert.equal(row2.state, 'settled');
      assert.equal(Number(row2.total_tokens), 700);
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exitCode = 1;
  } finally { await srv.close(); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });