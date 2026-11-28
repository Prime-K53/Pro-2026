/**
 * D-05/R4 — provider request-id evidence capture, race-safe system identity,
 * fail-closed reconciliation. Isolated in-memory PGlite (PG concurrency is a
 * separate blocker, not proven here).
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

    console.log('=== D-05/R4 ===\n');

    await test('A. provider request id captured from trusted response into attempt', async () => {
      const a = await db.withCompanyDb(companyId, (tx: any) => aiService.reserveAttempt(tx, companyId, crypto.randomUUID(), 1, 'p', 'm', [{ role: 'user', content: 'x' }]), 1);
      await db.withCompanyDb(companyId, (tx: any) => aiService.settleAttempt(tx, companyId, a.attemptId, { totalTokens: 10 }, 'req-abc'), 1);
      const row = await db.withCompanyDb(companyId, async (tx: any) => (await tx.query(`SELECT provider_request_id FROM ai_usage_attempts WHERE company_id=$1 AND id=$2`, [companyId, a.attemptId])).rows[0], 1);
      assert.equal(row.provider_request_id, 'req-abc');
    });

    await test('B. reconciliation fail-closed for unresolved attempt (no captured id)', async () => {
      const a = await db.withCompanyDb(companyId, (tx: any) => aiService.reserveAttempt(tx, companyId, crypto.randomUUID(), 1, 'p', 'm', [{ role: 'user', content: 'x' }]), 1);
      await db.withCompanyDb(companyId, (tx: any) => aiService.recordProviderFailure(tx, companyId, a.attemptId, true, 'timeout'), 1);
      const ok = await db.withCompanyDb(companyId, (tx: any) => aiService.reconcileUnresolvedAttempt(tx, companyId, a.attemptId, { totalTokens: 5 }, { providerRequestId: 'spoof' }, adminId), 1);
      assert.equal(ok, false, 'no server-recorded id → reject');
    });

    await test('B2. reconciliation with client-supplied usage but no stored id stays unresolved', async () => {
      const a = await db.withCompanyDb(companyId, (tx: any) => aiService.reserveAttempt(tx, companyId, crypto.randomUUID(), 1, 'p', 'm', [{ role: 'user', content: 'x' }]), 1);
      await db.withCompanyDb(companyId, (tx: any) => aiService.recordProviderFailure(tx, companyId, a.attemptId, true, 'timeout'), 1);
      await db.withCompanyDb(companyId, (tx: any) => aiService.reconcileUnresolvedAttempt(tx, companyId, a.attemptId, { totalTokens: 5 }, { providerRequestId: 'x' }, adminId), 1);
      const row = await db.withCompanyDb(companyId, async (tx: any) => (await tx.query(`SELECT state FROM ai_usage_attempts WHERE company_id=$1 AND id=$2`, [companyId, a.attemptId])).rows[0], 1);
      assert.equal(row.state, 'unresolved');
    });

    await test('C. concurrent first-time provisioning resolves to one canonical id', async () => {
      const ids = await Promise.all(Array.from({ length: 8 }, () => aiService.getSystemRecoveryUserId(db)));
      assert.ok(ids.every((x) => x === ids[0]), 'all callers get same id');
      const count = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT COUNT(*)::int c FROM users WHERE username='system-recovery'`)).rows[0].c));
      assert.equal(count, 1, 'exactly one system user');
    });

    await test('D. repeated provisioning is stable', async () => {
      const a = await aiService.getSystemRecoveryUserId(db);
      const b = await aiService.getSystemRecoveryUserId(db);
      assert.equal(a, b);
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exitCode = 1;
  } finally { await srv.close(); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });