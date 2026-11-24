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
  console.log('=== Multi-Rate Tax Engine Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-tax-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const admin = new CookieHttpClient(baseUrl);

  let standardCodeId = 0;
  let zeroCodeId = 0;
  let customerId = 0;
  let itemId = 0;

  try {
    await runTest('1. Setup', 'Authenticate and resolve a customer + invoiceable item', async () => {
      const login = await admin.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } });
      assert.equal(login.status, 200, `login failed: ${login.text}`);
      const cust = await admin.request('GET', '/api/customers');
      assert.equal(cust.status, 200);
      customerId = Number(cust.json.customers[0].id);
      const inv = await admin.request('GET', '/api/inventory');
      assert.equal(inv.status, 200);
      const invoiceable = (inv.json.items || inv.json.inventoryItems || []).find((i: any) => !['raw_material'].includes(i.item_type) && Number(i.sales_price) > 0);
      assert.ok(invoiceable, 'expected an invoiceable item with a sales price');
      itemId = Number(invoiceable.id);
      return `customer #${customerId}, item #${itemId}`;
    });

    await runTest('2. Tax codes', 'Create standard (16.5%) and zero (0%) codes in different jurisdictions', async () => {
      const std = await admin.request('POST', '/api/tax-codes', {
        body: { code: 'VAT-STD', name: 'Standard VAT', rate: 16.5, jurisdiction: 'Malawi' },
      });
      assert.equal(std.status, 201, `create standard code failed: ${std.text}`);
      standardCodeId = Number(std.json.code.id);
      assert.ok(Math.abs(Number(std.json.code.rate) - 16.5) < 0.0001);

      const zero = await admin.request('POST', '/api/tax-codes', {
        body: { code: 'VAT-ZERO', name: 'Zero-rated', rate: 0, jurisdiction: 'Export' },
      });
      assert.equal(zero.status, 201, `create zero code failed: ${zero.text}`);
      zeroCodeId = Number(zero.json.code.id);

      const list = await admin.request('GET', '/api/tax-codes');
      assert.equal(list.status, 200);
      assert.ok(list.json.codes.length >= 2);
      return 'VAT-STD (16.5%, Malawi) and VAT-ZERO (0%, Export) created';
    });

    await runTest('3. Invoice uses the tax code rate', 'Standard code taxes at 16.5%, zero code taxes at 0%', async () => {
      const stdInv = await admin.request('POST', '/api/invoices', {
        body: {
          customerId,
          taxCodeId: standardCodeId,
          lines: [{ itemId, description: 'Taxable service', quantity: 1, rate: 100, taxable: true }],
        },
      });
      assert.equal(stdInv.status, 201, `standard invoice failed: ${stdInv.text}`);
      const stdTax = Number(stdInv.json.invoice.taxAmount ?? stdInv.json.invoice.taxAmountNum ?? 0);
      assert.ok(Math.abs(stdTax - 16.5) < 0.01, `expected 16.5 tax, got ${stdTax}`);

      const zeroInv = await admin.request('POST', '/api/invoices', {
        body: {
          customerId,
          taxCodeId: zeroCodeId,
          lines: [{ itemId, description: 'Zero-rated export', quantity: 1, rate: 100, taxable: true }],
        },
      });
      assert.equal(zeroInv.status, 201, `zero invoice failed: ${zeroInv.text}`);
      const zeroTax = Number(zeroInv.json.invoice.taxAmount ?? zeroInv.json.invoice.taxAmountNum ?? 0);
      assert.ok(Math.abs(zeroTax) < 0.0001, `expected 0 tax, got ${zeroTax}`);
      return `standard invoice tax ${stdTax}; zero-rated invoice tax ${zeroTax}`;
    });

    await runTest('4. Tax summary by jurisdiction', 'Aggregates tax collected per jurisdiction', async () => {
      const sum = await admin.request('GET', '/api/reports/tax-summary');
      assert.equal(sum.status, 200, `tax summary failed: ${sum.text}`);
      const rows = sum.json.rows as any[];
      const malawi = rows.find(r => r.jurisdiction === 'Malawi');
      const exp = rows.find(r => r.jurisdiction === 'Export');
      assert.ok(malawi, 'Malawi jurisdiction row expected');
      assert.ok(exp, 'Export jurisdiction row expected');
      assert.ok(Math.abs(Number(malawi.taxCollected) - 16.5) < 0.01, `Malawi tax collected ${malawi.taxCollected}`);
      assert.ok(Math.abs(Number(exp.taxCollected)) < 0.0001, `Export tax collected ${exp.taxCollected}`);
      return `Malawi ${malawi.taxCollected}, Export ${exp.taxCollected}`;
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