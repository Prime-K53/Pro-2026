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
  console.log('=== Versioned Quote Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-quotes-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const admin = new CookieHttpClient(baseUrl);

  let quoteId = 0;

  try {
    await runTest('1. Setup', 'Authenticate and resolve a customer', async () => {
      const login = await admin.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } });
      assert.equal(login.status, 200, `login failed: ${login.text}`);
      return 'admin authenticated';
    });

    await runTest('2. Create quote', 'Create a quote with version 1', async () => {
      const cust = await admin.request('GET', '/api/customers');
      const customerId = Number(cust.json.customers[0].id);
      const res = await admin.request('POST', '/api/quotes', {
        body: {
          customerId,
          title: 'Examination Booklets — Term 3',
          validUntil: '2026-12-31',
          lines: [
            { description: 'Printing', quantity: 1000, rate: 1.5 },
            { description: 'Binding', quantity: 1000, rate: 0.25 },
          ],
        },
      });
      assert.equal(res.status, 201, `create quote failed: ${res.text}`);
      quoteId = Number(res.json.quote.id);
      assert.equal(res.json.versions.length, 1, 'expected one version');
      assert.ok(Math.abs(Number(res.json.versions[0].total) - 1750) < 0.01, `expected total 1750, got ${res.json.versions[0].total}`);
      assert.match(res.json.quote.quote_number, /^QT-\d{4}-\d{5}$/);
      return `quote ${res.json.quote.quote_number} v1 total ${res.json.versions[0].total}`;
    });

    await runTest('3. Add version', 'Revising a quote adds an immutable v2 and bumps current_version', async () => {
      const res = await admin.request('POST', `/api/quotes/${quoteId}/versions`, {
        body: {
          lines: [{ description: 'Printing (revised)', quantity: 2000, rate: 1.5 }],
          notes: 'Quantity increased',
        },
      });
      assert.equal(res.status, 201, `add version failed: ${res.text}`);
      assert.equal(res.json.versions.length, 2, 'expected two versions');
      assert.equal(res.json.quote.current_version, 2);
      assert.ok(Math.abs(Number(res.json.quote.total) - 3000) < 0.01);
      // v1 must remain unchanged (immutable history).
      const v1 = res.json.versions.find((v: any) => v.version_no === 1);
      assert.ok(Math.abs(Number(v1.total) - 1750) < 0.01, 'v1 must be unchanged');
      return `v1 ${v1.total} preserved; v2 ${res.json.quote.total}`;
    });

    await runTest('4. Status transitions', 'Send -> accept; converted quotes cannot be revised', async () => {
      const sent = await admin.request('POST', `/api/quotes/${quoteId}/status`, { body: { status: 'sent' } });
      assert.equal(sent.status, 200);
      assert.equal(sent.json.quote.status, 'sent');
      const accepted = await admin.request('POST', `/api/quotes/${quoteId}/status`, { body: { status: 'accepted' } });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.json.quote.status, 'accepted');

      const converted = await admin.request('POST', `/api/quotes/${quoteId}/status`, { body: { status: 'converted' } });
      assert.equal(converted.status, 200);
      assert.equal(converted.json.quote.status, 'converted');

      const blocked = await admin.request('POST', `/api/quotes/${quoteId}/versions`, {
        body: { lines: [{ description: 'x', quantity: 1, rate: 1 }] },
      });
      assert.equal(blocked.status, 409, `expected 409 for revising a converted quote: ${blocked.text}`);
      assert.equal(blocked.json.code, 'QUOTE_CONVERTED');
      return 'sent -> accepted -> converted; revision blocked after conversion';
    });

    await runTest('5. Invalid status rejected', 'An unknown status is rejected with 400', async () => {
      const res = await admin.request('POST', `/api/quotes/${quoteId}/status`, { body: { status: 'bogus' } });
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
      assert.equal(res.json.code, 'INVALID_QUOTE_STATUS');
      return 'invalid status rejected';
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