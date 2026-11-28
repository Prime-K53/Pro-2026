import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';

/**
 * Server-side idempotency guarantees for the quick-print invoice path
 * (documentsRoutes -> generateInvoiceFromWorkflow -> createInvoiceOrSalesReceipt
 * -> request_keys).
 *
 * The frontend reuses one idempotency key after a failed attempt; this suite
 * proves the server, not the client, prevents duplicate invoices.
 */

interface Result {
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}
const results: Result[] = [];

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

class Client {
  cookie = '';
  constructor(private readonly baseUrl: string) {}
  async request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.baseUrl}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    if (setCookie.length) this.cookie = setCookie.map(c => c.split(';')[0]).join('; ');
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, text, json };
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-idem-concurrency-'));
  const baseCfg = loadServerConfig();
  const db: ServerDatabase = await createServerDatabase(
    { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpDir },
    { inMemory: true, seedDemo: true }
  );
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  const admin = new Client(`http://127.0.0.1:${addr.port}`);

  const payload = (ref: string, amount = 100) => ({
    sourceKind: 'quick_print',
    sourceRef: ref,
    customerName: 'Idempotency Concurrency School',
    customerType: 'school',
    invoiceDate: '2026-11-20',
    dueDate: '2026-12-05',
    terms: 'Due on Receipt',
    taxRate: 0,
    notes: `Concurrency check ${ref}`,
    lines: [{ description: `Print job ${ref}`, quantity: 1, rate: amount, taxable: false }],
  });

  const countInvoices = async (ref: string) => {
    const rows = await db.withSystemDb(async tx =>
      tx.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM invoices WHERE company_id = 1 AND notes = $1`,
        [`Concurrency check ${ref}`]
      )
    );
    return Number(rows.rows[0]?.count ?? 0);
  };

  try {
    await runTest('1. Auth', 'Login as Admin', async () => {
      const res = await admin.request('POST', '/api/auth/login', {
        identifier: 'admin',
        username: 'admin',
        password: 'PrintingAdmin#2026',
      });
      assert.equal(res.status, 200, `Login failed: ${res.text}`);
      return 'Logged in';
    });

    await runTest(
      '2. Concurrent same-key',
      'Two simultaneous requests with the same key create exactly one invoice and resolve to the same identity',
      async () => {
        const key = 'idem-concurrent-0001';
        const body = payload('QPR-CONC-1');
        const [a, b] = await Promise.all([
          admin.request('POST', '/api/documents/generate-invoice', body, { 'idempotency-key': key }),
          admin.request('POST', '/api/documents/generate-invoice', body, { 'idempotency-key': key }),
        ]);
        assert.ok(a.status === 201 || a.status === 200, `unexpected status A: ${a.status} ${a.text}`);
        assert.ok(b.status === 201 || b.status === 200, `unexpected status B: ${b.status} ${b.text}`);
        assert.equal(
          a.json.invoice.id,
          b.json.invoice.id,
          `both responses must resolve to one invoice, got ${a.json.invoice.id} and ${b.json.invoice.id}`
        );
        assert.equal(await countInvoices('QPR-CONC-1'), 1, 'exactly one invoice row must exist');
        const replays = [a, b].filter(r => r.json.idempotentReplay === true).length;
        assert.equal(replays, 1, `exactly one response must be a replay, got ${replays}`);
        return `statuses ${a.status}/${b.status}, one invoice #${a.json.invoice.id}, one replay`;
      }
    );

    await runTest(
      '3. Same key, different payload',
      'Reusing the key with a materially different payload is rejected with 409 IDEMPOTENCY_CONFLICT',
      async () => {
        const key = 'idem-concurrent-0001';
        const res = await admin.request(
          'POST',
          '/api/documents/generate-invoice',
          payload('QPR-CONC-1', 999),
          { 'idempotency-key': key }
        );
        assert.equal(res.status, 409, `expected 409, got ${res.status}: ${res.text}`);
        assert.equal(res.json?.code, 'IDEMPOTENCY_CONFLICT');
        assert.equal(await countInvoices('QPR-CONC-1'), 1, 'conflict must not create another invoice');
        return 'conflict rejected, invoice count unchanged';
      }
    );

    await runTest(
      '4. Failed transaction then retry',
      'A rejected first attempt leaves no idempotency record, so a retry with the same key succeeds',
      async () => {
        const key = 'idem-retry-0002';
        // Missing customer identity -> the attempt fails validation.
        const bad = await admin.request('POST', '/api/documents/generate-invoice', {
          sourceKind: 'quick_print',
          sourceRef: 'QPR-RETRY-2',
          invoiceDate: '2026-11-20',
          lines: [{ description: 'x', quantity: 1, rate: 1 }],
        }, { 'idempotency-key': key });
        assert.ok(bad.status >= 400, `expected failure, got ${bad.status}`);

        const retry = await admin.request(
          'POST',
          '/api/documents/generate-invoice',
          payload('QPR-RETRY-2'),
          { 'idempotency-key': key }
        );
        assert.equal(retry.status, 201, `retry must succeed: ${retry.text}`);
        assert.equal(retry.json.idempotentReplay, false);
        assert.equal(await countInvoices('QPR-RETRY-2'), 1);
        return `failed attempt ${bad.status}, retry 201, one invoice`;
      }
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  const failed = results.filter(r => !r.passed);
  console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} PASSED ===`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});