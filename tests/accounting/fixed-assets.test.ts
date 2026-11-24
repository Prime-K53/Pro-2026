import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';

interface TestRecord {
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}
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
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  }
}

async function main() {
  console.log('=== Fixed Asset Register & Depreciation Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-fixed-assets-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const admin = new CookieHttpClient(baseUrl);

  let assetTypeId = 0;
  let assetId = 0;

  try {
    await runTest('1. Setup', 'Authenticate administrator and resolve GL accounts', async () => {
      const login = await admin.request('POST', '/api/auth/login', {
        body: { identifier: 'admin', password: 'PrintingAdmin#2026' },
      });
      assert.equal(login.status, 200, `login failed: ${login.text}`);
      return 'admin authenticated';
    });

    await runTest('2. Asset type', 'Create a straight-line asset type mapped to the fixed-asset accounts', async () => {
      const accts = await admin.request('GET', '/api/accounts');
      assert.equal(accts.status, 200, `accounts failed: ${accts.text}`);
      const byCode = new Map<string, number>();
      for (const a of accts.json.accounts as any[]) byCode.set(a.code, Number(a.id));
      const assetAcc = byCode.get('1500');
      const accumAcc = byCode.get('1590');
      const expenseAcc = byCode.get('6300');
      assert.ok(assetAcc && accumAcc && expenseAcc, 'required fixed-asset accounts 1500/1590/6300 must exist');

      const res = await admin.request('POST', '/api/fixed-asset-types', {
        body: {
          name: 'Printing Presses',
          assetAccountId: assetAcc,
          accumDeprAccountId: accumAcc,
          deprExpenseAccountId: expenseAcc,
          depreciationMethod: 'straight_line',
          effectiveLifeYears: 5,
        },
      });
      assert.equal(res.status, 201, `create type failed: ${res.text}`);
      assetTypeId = Number(res.json.type.id);
      assert.ok(assetTypeId > 0);
      assert.equal(res.json.type.depreciation_method, 'straight_line');
      return `asset type #${assetTypeId} (straight-line, 5y)`;
    });

    await runTest('3. Asset registration', 'Register a capitalised press asset', async () => {
      const res = await admin.request('POST', '/api/fixed-assets', {
        body: {
          assetTypeId,
          assetNumber: 'PRESS-001',
          name: 'Heidelberg Speedmaster',
          purchaseDate: '2025-01-01',
          purchasePrice: 12000,
          salvageValue: 0,
          description: 'Main production press',
        },
      });
      assert.equal(res.status, 201, `create asset failed: ${res.text}`);
      assetId = Number(res.json.asset.id);
      assert.ok(assetId > 0);
      assert.equal(Number(res.json.asset.purchase_price), 12000);
      return `asset #${assetId} registered at 12000.0000`;
    });

    await runTest('4. Depreciation run', 'Posts one month of straight-line depreciation (12000 / 5 / 12 = 200)', async () => {
      const res = await admin.request('POST', '/api/fixed-assets/depreciation/run', {
        body: { periodDate: '2025-02-28' },
      });
      assert.equal(res.status, 201, `depreciation run failed: ${res.text}`);
      assert.equal(res.json.assetsDepreciated, 1, `expected 1 asset depreciated: ${res.text}`);
      assert.ok(Math.abs(Number(res.json.totalDepreciation) - 200) < 0.001, `expected ~200 depreciation, got ${res.json.totalDepreciation}`);
      assert.ok(res.json.entries[0].journalTransactionId > 0, 'depreciation must post a journal');

      const asset = await admin.request('GET', `/api/fixed-assets/${assetId}`);
      assert.equal(asset.status, 200);
      assert.ok(Math.abs(Number(asset.json.asset.accumulated_depreciation) - 200) < 0.001, `accumulated should be 200: ${asset.text}`);
      assert.equal(String(asset.json.asset.last_depreciation_date).slice(0, 10), '2025-02-28');
      return `posted ${res.json.totalDepreciation} depreciation; accumulated = 200.0000`;
    });

    await runTest('5. Depreciation idempotency', 'Re-running the same period is a no-op replay', async () => {
      const res = await admin.request('POST', '/api/fixed-assets/depreciation/run', {
        body: { periodDate: '2025-02-28' },
      });
      assert.equal(res.status, 200, `expected 200 replay, got ${res.status}: ${res.text}`);
      assert.equal(res.json.idempotentReplay, true, 'second run must be an idempotent replay');
      const asset = await admin.request('GET', `/api/fixed-assets/${assetId}`);
      assert.ok(Math.abs(Number(asset.json.asset.accumulated_depreciation) - 200) < 0.001, 'accumulated must not double on replay');
      return 'replay returned the original run; accumulated unchanged';
    });

    await runTest('6. Disposal', 'Retires the asset at a loss and posts the write-off', async () => {
      const res = await admin.request('POST', `/api/fixed-assets/${assetId}/dispose`, {
        body: { disposalDate: '2025-03-31', proceeds: 8000, proceedsAccountId: null, reason: 'Sold used press' },
      });
      assert.equal(res.status, 201, `disposal failed: ${res.text}`);
      // NBV = 12000 - 200 = 11800; proceeds 8000 => loss 3800.
      assert.ok(Math.abs(Number(res.json.disposal.loss) - 3800) < 0.001, `expected loss 3800, got ${res.json.disposal.loss}`);
      assert.equal(Number(res.json.disposal.gain), 0);

      const asset = await admin.request('GET', `/api/fixed-assets/${assetId}`);
      assert.equal(asset.json.asset.status, 'disposed');
      assert.equal(String(asset.json.asset.disposal_date).slice(0, 10), '2025-03-31');
      return `asset disposed at a 3800.0000 loss; status = disposed`;
    });

    await runTest('7. Roll-forward', 'Reports cost, accumulated depreciation and net book value', async () => {
      const res = await admin.request('GET', '/api/fixed-assets/roll-forward');
      assert.equal(res.status, 200, `roll-forward failed: ${res.text}`);
      const s = res.json.summary;
      assert.equal(s.disposedCount, 1, 'one disposed asset');
      assert.ok(Math.abs(Number(s.totalCost) - 12000) < 0.001);
      assert.ok(Math.abs(Number(s.totalAccumulatedDepreciation) - 200) < 0.001);
      assert.ok(Math.abs(Number(s.totalNetBookValue) - 11800) < 0.001);
      return `cost ${s.totalCost}, accum ${s.totalAccumulatedDepreciation}, NBV ${s.totalNetBookValue}`;
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});