import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';

interface TestRecord { suite: string; name: string; passed: boolean; durationMs: number; details: string; }
const results: TestRecord[] = [];

async function runTest(suite: string, name: string, fn: () => Promise<string | void>) {
  const start = Date.now();
  try {
    const details = (await fn()) || 'OK';
    results.push({ suite, name, passed: true, durationMs: Date.now() - start, details });
    console.log(`  [PASS] (${Date.now() - start}ms) ${suite} :: ${name} — ${details}`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    results.push({ suite, name, passed: false, durationMs: Date.now() - start, details: msg });
    console.error(`  [FAIL] (${Date.now() - start}ms) ${suite} :: ${name} — ${msg}`);
  }
}

class CookieHttpClient {
  public cookie = '';
  constructor(private baseUrl: string) {}
  async request(method: string, pathname: string, options: { body?: unknown } = {}) {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, text, json };
  }
}

async function main() {
  console.log('=== AP Advanced Actions Verification Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-ap-adv-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const admin = new CookieHttpClient(`http://127.0.0.1:${addr.port}`);

  let vendorId = 0;
  let expenseAccountId = 0;
  let bankAccountId = 0;
  let billId = 0;
  let bill2Id = 0;

  try {
    await runTest('1. Auth', 'Login as Admin', async () => {
      const res = await admin.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } });
      assert.equal(res.status, 200, res.text);
    });

    await runTest('2. Setup refs', 'Find vendor, expense account, bank account', async () => {
      const vendors = await admin.request('GET', '/api/vendors');
      assert.equal(vendors.status, 200, vendors.text);
      vendorId = vendors.json.vendors?.[0]?.id;
      const accounts = await admin.request('GET', '/api/accounts');
      assert.equal(accounts.status, 200, accounts.text);
      const list = accounts.json.accounts || [];
      const typeOf = (a: any) => String(a.accountType || a.type || a.account_type || '').toLowerCase();
      const expense = list.find((a: any) => ['expense', 'otherexpense', 'costofgoodssold'].includes(typeOf(a)));
      const bank = list.find((a: any) => typeOf(a) === 'bank');
      expenseAccountId = expense?.id;
      bankAccountId = bank?.id;
      assert.ok(vendorId, `vendor missing: ${vendors.text.slice(0, 200)}`);
      assert.ok(expenseAccountId, `expense missing; sample=${JSON.stringify(list[0])?.slice(0,200)}`);
      assert.ok(bankAccountId, `bank missing; sample=${JSON.stringify(list[0])?.slice(0,200)}`);
      return `vendor=${vendorId} expense=${expenseAccountId} bank=${bankAccountId}`;
    });

    await runTest('3. Create bill', 'Create open bill', async () => {
      const res = await admin.request('POST', '/api/bills', {
        body: {
          vendorId,
          billNumber: 'BILL-AP-ADV-001',
          billDate: '2026-11-25',
          dueDate: '2026-12-25',
          lines: [{ accountId: expenseAccountId, description: 'Paper stock', quantity: 1, unitCost: 1000, amount: 1000 }],
        },
      });
      assert.equal(res.status, 201, res.text);
      billId = res.json.bill.id;
      assert.equal(Number(res.json.bill.balanceDue), 1000);
      return `bill=${billId}`;
    });

    await runTest('4. Payment hold', 'Place and release payment hold', async () => {
      const place = await admin.request('POST', `/api/bills/${billId}/payment-hold`, { body: { hold: true, reason: 'Awaiting match review' } });
      assert.equal(place.status, 200, place.text);
      assert.equal(place.json.paymentHold, true);
      const release = await admin.request('POST', `/api/bills/${billId}/payment-hold`, { body: { hold: false } });
      assert.equal(release.status, 200, release.text);
      assert.equal(release.json.paymentHold, false);
      return 'Hold placed/released';
    });

    await runTest('5. Three-way match evaluate', 'Evaluate match returns status', async () => {
      const res = await admin.request('POST', `/api/bills/${billId}/match/evaluate`);
      assert.equal(res.status, 200, res.text);
      assert.ok(['matched', 'variance_held', 'approved_override', 'unmatched'].includes(res.json.matchStatus));
      return `matchStatus=${res.json.matchStatus} discrepancies=${(res.json.discrepancies||[]).length}`;
    });

    await runTest('6. Match override', 'Approve variance override when needed', async () => {
      // ensure variance_held
      await admin.request('POST', `/api/bills/${billId}/match/evaluate`);
      const res = await admin.request('POST', `/api/bills/${billId}/match/override`, { body: { reason: 'Approved for test' } });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.matchStatus, 'approved_override');
      return 'Override approved';
    });

    await runTest('7. Batch payment run', 'Batch pays eligible bills and skips held', async () => {
      const bill2 = await admin.request('POST', '/api/bills', {
        body: {
          vendorId,
          billNumber: 'BILL-AP-ADV-002',
          billDate: '2026-11-25',
          dueDate: '2026-12-25',
          lines: [{ accountId: expenseAccountId, description: 'Toner', quantity: 1, unitCost: 500, amount: 500 }],
        },
      });
      assert.equal(bill2.status, 201, bill2.text);
      bill2Id = bill2.json.bill.id;
      await admin.request('POST', `/api/bills/${bill2Id}/payment-hold`, { body: { hold: true, reason: 'Hold for test' } });

      const res = await admin.request('POST', '/api/bill-payments/batch-run', {
        body: { bankAccountId, billIds: [billId, bill2Id], paymentDate: '2026-11-25', idempotencyKey: 'ap-batch-1' },
      });
      assert.equal(res.status, 200, res.text);
      assert.ok(Array.isArray(res.json.payments));
      assert.ok(res.json.skipped.some((s: any) => Number(s.billId) === bill2Id), 'Held bill should be skipped');
      const replay = await admin.request('POST', '/api/bill-payments/batch-run', {
        body: { bankAccountId, billIds: [billId, bill2Id], paymentDate: '2026-11-25', idempotencyKey: 'ap-batch-1' },
      });
      assert.equal(replay.status, 200, replay.text);
      assert.equal(replay.json.idempotentReplay, true);
      return `payments=${res.json.payments.length} skipped=${res.json.skipped.length}`;
    });

    await runTest('8. Hold blocks direct payment', 'Direct bill payment is rejected when bill is on hold', async () => {
      const res = await admin.request('POST', '/api/bill-payments', {
        body: { vendorId, bankAccountId, paymentDate: '2026-11-25', allocations: [{ billId: bill2Id, amount: 100 }] },
      });
      assert.equal(res.status, 409, res.text);
      assert.match(String(res.text), /hold|BILL_ON_HOLD/i);
      return `status=${res.status}`;
    });

    await runTest('9. Missing bill controls', 'Hold/match endpoints return 404 for missing bill', async () => {
      const hold = await admin.request('POST', '/api/bills/999999/payment-hold', { body: { hold: true, reason: 'x' } });
      assert.equal(hold.status, 404, hold.text);
      const match = await admin.request('POST', '/api/bills/999999/match/evaluate');
      assert.equal(match.status, 404, match.text);
      return '404s verified';
    });

    await runTest('10. Batch idempotency key conflict', 'Reused batch idempotency key with different payload is rejected', async () => {
      const res = await admin.request('POST', '/api/bill-payments/batch-run', {
        body: { bankAccountId, billIds: [billId], paymentDate: '2026-11-26', idempotencyKey: 'ap-batch-1' },
      });
      assert.notEqual(res.status, 200, res.text);
      assert.ok([409, 400].includes(res.status), `Expected 409/400, got ${res.status}: ${res.text}`);
      return `status=${res.status}`;
    });
  } finally {
    server.close();
    try { fs.rmSync(tmpAttachDir, { recursive: true, force: true }); } catch {}
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });