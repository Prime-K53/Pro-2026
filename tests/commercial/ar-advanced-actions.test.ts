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
  console.log('=== AR Advanced Actions Verification Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-ar-adv-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const admin = new CookieHttpClient(`http://127.0.0.1:${addr.port}`);

  let invoiceId = 0;

  try {
    await runTest('1. Auth', 'Login as Admin', async () => {
      const res = await admin.request('POST', '/api/auth/login', {
        body: { identifier: 'admin', password: 'PrintingAdmin#2026' },
      });
      assert.equal(res.status, 200, `Login failed: ${res.text}`);
      return 'Logged in as Admin';
    });

    await runTest('2. Create Invoice', 'Post an Invoice for K1000', async () => {
      const res = await admin.request('POST', '/api/invoices', {
        body: {
          customerId: 1,
          invoiceDate: '2026-11-25',
          dueDate: '2026-12-25',
          termsLabel: 'Net 30',
          taxPercent: 0,
          lines: [
            { description: 'School Examination Papers Grade 10', quantity: 10, rate: 100 },
          ],
        },
      });
      assert.equal(res.status, 201, `Create invoice failed: ${res.text}`);
      assert.ok(res.json?.invoice?.id, 'Expected invoice id');
      invoiceId = res.json.invoice.id;
      assert.equal(Number(res.json.invoice.balanceDue), 1000);
      return `Created Invoice #${invoiceId} for K1,000 balance`;
    });

    await runTest('3. Apply Deposit', 'Apply K400 customer advance deposit', async () => {
      const res = await admin.request('POST', `/api/invoices/${invoiceId}/apply-deposit`, {
        body: { amount: 400, sourceType: 'deposit' },
      });
      assert.equal(res.status, 200, `Apply deposit failed: ${res.text}`);
      assert.equal(Number(res.json.allocatedAmount), 400);
      assert.equal(Number(res.json.remainingBalance), 600);
      assert.equal(res.json.status, 'partial');
      assert.ok(res.json.journalTxnId, 'Expected balanced journal entry id');
      return `Applied K400 deposit, remaining balance K600, journal #${res.json.journalTxnId}`;
    });

    await runTest('4. Dispute Hold', 'Place and release dispute hold', async () => {
      const placeRes = await admin.request('POST', `/api/invoices/${invoiceId}/toggle-dispute`, {
        body: { disputeReason: 'Customer queried paper thickness' },
      });
      assert.equal(placeRes.status, 200, `Place dispute failed: ${placeRes.text}`);
      assert.equal(placeRes.json.isDisputed, true);
      assert.equal(placeRes.json.disputeReason, 'Customer queried paper thickness');

      const releaseRes = await admin.request('POST', `/api/invoices/${invoiceId}/toggle-dispute`);
      assert.equal(releaseRes.status, 200, `Release dispute failed: ${releaseRes.text}`);
      assert.equal(releaseRes.json.isDisputed, false);
      assert.equal(releaseRes.json.disputedAt, null);
      return 'Successfully placed on dispute and released';
    });

    await runTest('5. Write-Off Balance', 'Write-off remaining K600 to Bad Debt Expense', async () => {
      const res = await admin.request('POST', `/api/invoices/${invoiceId}/write-off`, {
        body: {
          amount: 600,
          reason: 'Customer insolvent / legal settlement',
        },
      });
      assert.equal(res.status, 200, `Write-off failed: ${res.text}`);
      assert.equal(Number(res.json.writtenOffAmount), 600);
      assert.equal(Number(res.json.remainingBalance), 0);
      assert.equal(res.json.status, 'paid');
      assert.ok(res.json.journalTxnId, 'Expected write-off journal id');
      return `Wrote off K600, invoice status marked paid, journal #${res.json.journalTxnId}`;
    });

    let invoice2Id = 0;
    await runTest('6. Create Invoice 2', 'Post second invoice for controls tests', async () => {
      const res = await admin.request('POST', '/api/invoices', {
        body: {
          customerId: 1,
          invoiceDate: '2026-11-25',
          dueDate: '2026-12-25',
          termsLabel: 'Net 30',
          taxPercent: 0,
          lines: [{ description: 'Control test item', quantity: 1, rate: 500 }],
        },
      });
      assert.equal(res.status, 201, `Create invoice failed: ${res.text}`);
      invoice2Id = res.json.invoice.id;
      return `Created Invoice #${invoice2Id}`;
    });

    await runTest('7. Over-allocation guard', 'Deposit exceeding balance is rejected', async () => {
      const res = await admin.request('POST', `/api/invoices/${invoice2Id}/apply-deposit`, {
        body: { amount: 600, sourceType: 'deposit' },
      });
      assert.equal(res.status, 400, `Expected 400, got ${res.status}: ${res.text}`);
      return 'Rejected over-allocation';
    });

    await runTest('8. Deposit idempotency', 'Same idempotency key replays without double-posting', async () => {
      const key = 'test-deposit-idem-1';
      const first = await admin.request('POST', `/api/invoices/${invoice2Id}/apply-deposit`, {
        body: { amount: 100, sourceType: 'deposit', idempotencyKey: key },
      });
      assert.equal(first.status, 200, `First deposit failed: ${first.text}`);
      const second = await admin.request('POST', `/api/invoices/${invoice2Id}/apply-deposit`, {
        body: { amount: 100, sourceType: 'deposit', idempotencyKey: key },
      });
      assert.equal(second.status, 200, `Replay failed: ${second.text}`);
      assert.equal(second.json.idempotentReplay, true);
      assert.equal(second.json.journalTxnId, first.json.journalTxnId);
      assert.equal(Number(second.json.remainingBalance), 400);
      return 'Idempotent replay returned same journal/balance';
    });

    await runTest('9. Write-off permission guard', 'Bookkeeper cannot write off invoice balance', async () => {
      const bookkeeper = new CookieHttpClient(`http://127.0.0.1:${addr.port}`);
      const login = await bookkeeper.request('POST', '/api/auth/login', {
        body: { identifier: 'bookkeeper', password: 'PrintingAdmin#2026' },
      });
      assert.equal(login.status, 200, `Bookkeeper login failed: ${login.text}`);
      const res = await bookkeeper.request('POST', `/api/invoices/${invoice2Id}/write-off`, {
        body: { amount: 50, reason: 'Should be forbidden' },
      });
      assert.equal(res.status, 403, `Expected 403, got ${res.status}: ${res.text}`);
      return 'Bookkeeper correctly denied write-off';
    });

    await runTest('10. Over-writeoff guard', 'Write-off exceeding balance is rejected', async () => {
      const res = await admin.request('POST', `/api/invoices/${invoice2Id}/write-off`, {
        body: { amount: 9999, reason: 'Too much' },
      });
      assert.equal(res.status, 400, `Expected 400, got ${res.status}: ${res.text}`);
      return 'Rejected over-writeoff';
    });

    await runTest('11. Invalid status guard', 'Cannot write off a paid invoice', async () => {
      const res = await admin.request('POST', `/api/invoices/${invoiceId}/write-off`, {
        body: { amount: 1, reason: 'Already paid' },
      });
      assert.equal(res.status, 422, `Expected 422, got ${res.status}: ${res.text}`);
      return 'Paid invoice write-off rejected';
    });

    await runTest('12. Write-off idempotency conflict', 'Same key with different payload returns 409', async () => {
      const key = 'test-writeoff-idem-conflict';
      const first = await admin.request('POST', `/api/invoices/${invoice2Id}/write-off`, {
        body: { amount: 50, reason: 'First writeoff', idempotencyKey: key },
      });
      assert.equal(first.status, 200, `First write-off failed: ${first.text}`);
      const conflict = await admin.request('POST', `/api/invoices/${invoice2Id}/write-off`, {
        body: { amount: 60, reason: 'Different payload', idempotencyKey: key },
      });
      assert.equal(conflict.status, 409, `Expected 409, got ${conflict.status}: ${conflict.text}`);
      return 'Idempotency conflict correctly rejected';
    });

    await runTest('13. 404 guard', 'Unknown invoice returns 404', async () => {
      const res = await admin.request('POST', `/api/invoices/999999/apply-deposit`, {
        body: { amount: 10, sourceType: 'deposit' },
      });
      assert.equal(res.status, 404, `Expected 404, got ${res.status}: ${res.text}`);
      return 'Unknown invoice rejected with 404';
    });

    await runTest('14. Ledger balance', 'Deposit/write-off journals are balanced', async () => {
      const balanced = await db.withCompanyDb(1, async (tx) => {
        const rows = await tx.query<{ id: number }>(
          `SELECT jt.id
             FROM journal_transactions jt
            WHERE jt.company_id = $1
              AND jt.id IN (SELECT journal_txn_id FROM invoices WHERE company_id = $1 AND journal_txn_id IS NOT NULL)
             ORDER BY jt.id DESC LIMIT 20`,
          [1]
        );
        for (const r of rows.rows) {
          const sum = await tx.query<{ dr: string; cr: string }>(
            `SELECT COALESCE(SUM(debit),0)::text AS dr, COALESCE(SUM(credit),0)::text AS cr
               FROM journal_lines WHERE company_id = $1 AND transaction_id = $2`,
            [1, r.id]
          );
          const dr = Number(sum.rows[0].dr);
          const cr = Number(sum.rows[0].cr);
          if (Math.abs(dr - cr) > 0.0001) return { ok: false, id: r.id, dr, cr };
        }
        return { ok: true };
      });
      assert.equal(balanced.ok, true, `Unbalanced journal: ${JSON.stringify(balanced)}`);
      return 'Sampled invoice journals are balanced';
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
