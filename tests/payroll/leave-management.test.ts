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
  console.log('=== Leave Management Verification Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-leave-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const admin = new CookieHttpClient(`http://127.0.0.1:${addr.port}`);

  let leaveTypeId = 0;
  let requestId = 0;

  try {
    await runTest('1. Auth', 'Login as Admin', async () => {
      const res = await admin.request('POST', '/api/auth/login', {
        body: { identifier: 'admin', password: 'PrintingAdmin#2026' },
      });
      assert.equal(res.status, 200, `Login failed: ${res.text}`);
      return 'Logged in as Admin';
    });

    await runTest('2. Leave Types', 'Create Annual Leave Type', async () => {
      const res = await admin.request('POST', '/api/leave/types', {
        body: { code: 'ANNUAL', name: 'Annual Paid Leave', accrualDays: 21, maxCarryForward: 5, isPaid: true },
      });
      assert.equal(res.status, 201, `Create leave type failed: ${res.text}`);
      assert.ok(res.json?.leaveType?.id, 'Expected leaveType id');
      assert.equal(res.json?.leaveType?.code, 'ANNUAL');
      leaveTypeId = res.json.leaveType.id;
      return `Created Leave Type #${leaveTypeId} (ANNUAL)`;
    });

    await runTest('3. Leave Request', 'Submit Leave Request for Employee #1', async () => {
      const res = await admin.request('POST', '/api/leave/requests', {
        body: {
          employeeId: 1,
          leaveTypeId,
          startDate: '2026-12-01',
          endDate: '2026-12-05',
          daysRequested: 5,
          reason: 'Family holiday',
        },
      });
      assert.equal(res.status, 201, `Create request failed: ${res.text}`);
      assert.ok(res.json?.request?.id, 'Expected request id');
      assert.equal(res.json?.request?.status, 'pending');
      assert.equal(res.json?.request?.daysRequested, 5);
      requestId = res.json.request.id;
      return `Submitted Leave Request #${requestId} for 5 days`;
    });

    await runTest('4. Approval & Balance', 'Approve Leave Request and Verify Taken Days', async () => {
      const res = await admin.request('POST', `/api/leave/requests/${requestId}/approve`);
      assert.equal(res.status, 200, `Approve request failed: ${res.text}`);
      assert.equal(res.json?.request?.status, 'approved');

      // Check balances
      const balRes = await admin.request('GET', `/api/leave/balances/1?year=2026`);
      assert.equal(balRes.status, 200, `Get balances failed: ${balRes.text}`);
      const bal = (balRes.json.balances as any[]).find(b => b.leaveTypeId === leaveTypeId);
      assert.ok(bal, 'Expected balance entry for ANNUAL');
      assert.equal(bal.taken, 5, `Expected 5 taken days, got ${bal.taken}`);
      return `Approved request #${requestId}, 5 days recorded in balance`;
    });

    await runTest('5. Listing', 'List All Leave Requests', async () => {
      const res = await admin.request('GET', '/api/leave/requests');
      assert.equal(res.status, 200, `List requests failed: ${res.text}`);
      assert.ok(res.json?.requests?.length >= 1, 'Expected at least 1 request');
      const item = (res.json.requests as any[]).find(r => r.id === requestId);
      assert.ok(item, 'Expected request in list');
      assert.equal(item.status, 'approved');
      return `Found ${res.json.requests.length} requests, request #${requestId} is approved`;
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
