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
      headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
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
  console.log('=== Expense Advanced Actions Verification Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-exp-adv-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };
  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const admin = new CookieHttpClient(`http://127.0.0.1:${addr.port}`);
  let claimId = 0; let expenseAccountId = 0; let bankAccountId = 0;

  try {
    await runTest('1. Auth', 'Login as Admin', async () => {
      const res = await admin.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } });
      assert.equal(res.status, 200, res.text);
    });
    await runTest('2. Setup', 'Find expense and bank accounts', async () => {
      const accounts = await admin.request('GET', '/api/accounts');
      assert.equal(accounts.status, 200, accounts.text);
      const list = accounts.json.accounts || [];
      const typeOf = (a: any) => String(a.accountType || a.type || a.account_type || '').toLowerCase();
      expenseAccountId = list.find((a: any) => ['expense', 'otherexpense', 'costofgoodssold'].includes(typeOf(a)))?.id;
      bankAccountId = list.find((a: any) => typeOf(a) === 'bank')?.id;
      assert.ok(expenseAccountId && bankAccountId);
      return `expense=${expenseAccountId} bank=${bankAccountId}`;
    });
    await runTest('3. Create claim', 'Create draft expense claim', async () => {
      const res = await admin.request('POST', '/api/expenses/claims', { body: { claimDate: '2026-11-25', category: 'travel', description: 'Taxi to supplier', amount: 250, expenseAccountId } });
      assert.equal(res.status, 201, res.text);
      claimId = res.json.claim.id;
      assert.equal(res.json.claim.status, 'draft');
      return `claim=${claimId}`;
    });
    await runTest('4. Submit/Approve', 'Submit then approve claim', async () => {
      let res = await admin.request('POST', `/api/expenses/claims/${claimId}/submit`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.claim.status, 'submitted');
      res = await admin.request('POST', `/api/expenses/claims/${claimId}/approve`, { body: { expenseAccountId } });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.claim.status, 'approved');
      return 'approved';
    });
    await runTest('5. Reimburse', 'Reimburse approved claim posts JE', async () => {
      const res = await admin.request('POST', `/api/expenses/claims/${claimId}/reimburse`, { body: { bankAccountId, expenseAccountId, paymentDate: '2026-11-25', method: 'Cash', reference: 'EXP-REIMB-1' } });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.claim.status, 'reimbursed');
      assert.ok(res.json.journalTxnId, 'Expected journal txn');
      return `je=${res.json.journalTxnId}`;
    });
    await runTest('6. Reject flow', 'Rejected claim cannot be reimbursed', async () => {
      const created = await admin.request('POST', '/api/expenses/claims', { body: { claimDate: '2026-11-25', category: 'office', description: 'Snacks', amount: 50, expenseAccountId } });
      const id = created.json.claim.id;
      await admin.request('POST', `/api/expenses/claims/${id}/submit`);
      const rej = await admin.request('POST', `/api/expenses/claims/${id}/reject`, { body: { reason: 'Not business related' } });
      assert.equal(rej.status, 200, rej.text);
      assert.equal(rej.json.claim.status, 'rejected');
      const reimb = await admin.request('POST', `/api/expenses/claims/${id}/reimburse`, { body: { bankAccountId, expenseAccountId } });
      assert.equal(reimb.status, 409, reimb.text);
      return 'rejected+blocked';
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n=== Expense Advanced Actions Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) { for (const r of results.filter(r => !r.passed)) console.error(` - ${r.suite} :: ${r.name}: ${r.details}`); process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
