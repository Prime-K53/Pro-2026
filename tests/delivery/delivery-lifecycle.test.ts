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
  console.log('=== Delivery Note Lifecycle Verification Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-delivery-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const admin = new CookieHttpClient(`http://127.0.0.1:${addr.port}`);

  let noteId = 0;

  try {
    await runTest('1. Auth', 'Login as Admin', async () => {
      const res = await admin.request('POST', '/api/auth/login', {
        body: { identifier: 'admin', password: 'PrintingAdmin#2026' },
      });
      assert.equal(res.status, 200, `Login failed: ${res.text}`);
      return 'Logged in as Admin';
    });

    await runTest('2. Vehicle & Driver', 'Register Vehicle and Driver', async () => {
      const vRes = await admin.request('POST', '/api/delivery/vehicles', {
        body: { registration: 'MZ-1234', make: 'Toyota', model: 'Hilux', capacityKg: 1000 },
      });
      assert.equal(vRes.status, 201, `Create vehicle failed: ${vRes.text}`);

      const dRes = await admin.request('POST', '/api/delivery/drivers', {
        body: { name: 'John Phiri', licenseNumber: 'DL-998877', phone: '+265991234567' },
      });
      assert.equal(dRes.status, 201, `Create driver failed: ${dRes.text}`);
      return 'Vehicle MZ-1234 and Driver John Phiri registered';
    });

    await runTest('3. Delivery Note', 'Create Delivery Note with lines', async () => {
      const res = await admin.request('POST', '/api/delivery/notes', {
        body: {
          customerId: 1,
          dispatchDate: new Date().toISOString().slice(0, 10),
          driverName: 'John Phiri',
          vehicleReg: 'MZ-1234',
          notes: 'Deliver to main reception',
          lines: [
            { description: 'School Examination Booklets (Grade 12)', quantityDispatched: 500 },
            { description: 'Report Cards A4 Full Colour', quantityDispatched: 1000 },
          ],
        },
      });
      assert.equal(res.status, 201, `Create delivery note failed: ${res.text}`);
      assert.ok(res.json?.deliveryNote?.id, 'Expected deliveryNote id');
      assert.equal(res.json?.deliveryNote?.status, 'prepared');
      assert.equal(res.json?.deliveryNote?.lines?.length, 2);
      noteId = res.json.deliveryNote.id;
      return `Created ${res.json.deliveryNote.deliveryNumber} with 2 lines`;
    });

    await runTest('4. Dispatch', 'Dispatch Delivery Note', async () => {
      const res = await admin.request('POST', `/api/delivery/notes/${noteId}/dispatch`, {
        body: { driverName: 'John Phiri', vehicleReg: 'MZ-1234' },
      });
      assert.equal(res.status, 200, `Dispatch failed: ${res.text}`);
      assert.equal(res.json?.deliveryNote?.status, 'in_transit');
      return 'Status updated to in_transit';
    });

    await runTest('5. Proof of Delivery', 'Mark Delivered with recipient', async () => {
      const res = await admin.request('POST', `/api/delivery/notes/${noteId}/deliver`, {
        body: { recipientName: 'Dr. Banda', notes: 'Received and signed by headmaster' },
      });
      assert.equal(res.status, 200, `Deliver failed: ${res.text}`);
      assert.equal(res.json?.deliveryNote?.status, 'delivered');
      assert.equal(res.json?.deliveryNote?.recipientName, 'Dr. Banda');
      assert.ok(res.json?.deliveryNote?.deliveredAt, 'Expected deliveredAt timestamp');
      return `Delivered to ${res.json.deliveryNote.recipientName}`;
    });

    await runTest('6. Retrieval', 'Fetch Delivery Note with lines', async () => {
      const res = await admin.request('GET', `/api/delivery/notes/${noteId}`);
      assert.equal(res.status, 200, `Get failed: ${res.text}`);
      assert.equal(res.json?.deliveryNote?.status, 'delivered');
      assert.equal(res.json?.deliveryNote?.lines?.length, 2);
      return 'Successfully fetched delivered note with line items';
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
