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
  console.log('=== Withholding / 1099 Workflow Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-withholding-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const admin = new CookieHttpClient(baseUrl);

  let vendorId = 0;
  let billAcctId = 0;

  try {
    await runTest('1. Setup', 'Authenticate and create a 1099-eligible vendor', async () => {
      const login = await admin.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } });
      assert.equal(login.status, 200, `login failed: ${login.text}`);
      const vRes = await admin.request('POST', '/api/vendors', {
        body: {
          name: 'Freelance Printer Ltd',
          companyName: 'Freelance Printer Ltd',
          email: 'billing@freelanceprinter.zm',
          is1099Eligible: true,
        },
      });
      assert.equal(vRes.status, 201, `vendor creation failed: ${vRes.text}`);
      vendorId = Number(vRes.json.vendor.id);
      assert.ok(vendorId > 0);

      // Find an expense account for the bill
      const acct = await admin.request('GET', '/api/accounts');
      assert.equal(acct.status, 200);
      const expAcct = (acct.json.accounts as any[]).find((a: any) => (a.account_type || '').toLowerCase().includes('expense') || a.code === '6200');
      assert.ok(expAcct, 'expected an expense account');
      billAcctId = Number(expAcct.id);
      return `vendor #${vendorId} (1099-eligible), expense account #${billAcctId}`;
    });

    await runTest('2. Bill payment with withholding', 'Create a bill and pay it with withholding tax', async () => {
      // Create a bill for the vendor
      const bill = await admin.request('POST', '/api/bills', {
        body: {
          vendorId,
          billNumber: 'INV-2026-001',
          billDate: '2026-11-01',
          dueDate: '2026-12-01',
          lines: [{ accountId: billAcctId, description: 'Printing services', amount: 1000 }],
        },
      });
      assert.equal(bill.status, 201, `bill creation failed: ${bill.text}`);
      const billId = Number(bill.json.bill.id);

      // Pay the bill with withholding tax
      const pay = await admin.request('POST', '/api/bill-payments', {
        body: {
          vendorId,
          paymentDate: '2026-11-15',
          amount: 900,
          paymentMethod: 'ACH / Wire',
          allocations: [{ billId, amount: 900 }],
          withholding_tax_amount: 100,
        },
      });
      assert.equal(pay.status, 201, `payment creation failed: ${pay.text}`);
      const payment = pay.json.payment;
      assert.ok(Math.abs(Number(payment.withholding_tax_amount) - 100) < 0.01, `withholding not stored: ${payment.withholding_tax_amount}`);
      return `bill paid: amount 900, withholding 100`;
    });

    await runTest('3. Vendor 1099 summary', 'Summary includes withheld amount for 1099-eligible vendor', async () => {
      const year = new Date().getFullYear();
      const sum = await admin.request('GET', `/api/reports/vendor-1099-summary?year=${year}`);
      assert.equal(sum.status, 200, `1099 summary failed: ${sum.text}`);
      const row = (sum.json.vendors as any[]).find((v: any) => v.vendorId === vendorId);
      assert.ok(row, `vendor #${vendorId} not in 1099 summary`);
      assert.ok(Math.abs(Number(row.totalPaid) - 1000) < 0.01, `totalPaid should be 1000 (amount 900 + withholding 100), got ${row.totalPaid}`);
      assert.ok(Math.abs(Number(row.totalWithheld) - 100) < 0.01, `withheld should be 100, got ${row.totalWithheld}`);
      return `vendor 1099: paid ${row.totalPaid}, withheld ${row.totalWithheld}`;
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });