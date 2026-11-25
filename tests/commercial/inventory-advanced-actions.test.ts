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
  console.log('=== Inventory Advanced Actions Verification Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-inv-adv-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const admin = new CookieHttpClient(`http://127.0.0.1:${addr.port}`);

  let itemId = 0;
  let inTransitAccountId = 0;

  try {
    await runTest('1. Auth', 'Login as Admin', async () => {
      const res = await admin.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } });
      assert.equal(res.status, 200, res.text);
    });

    await runTest('2. Setup', 'Find stocked item and ensure in-transit account', async () => {
      const inv = await admin.request('GET', '/api/inventory');
      assert.equal(inv.status, 200, inv.text);
      const items = inv.json.inventory || inv.json.items || [];
      const stocked = items.find((i: any) => ['raw_material', 'stationery'].includes(String(i.type || i.item_type || '').toLowerCase()) && Number(i.onHand ?? i.on_hand ?? 0) > 0);
      assert.ok(stocked, `No stocked item with on hand found; sample=${JSON.stringify(items[0])?.slice(0,200)}`);
      itemId = Number(stocked.id);

      const accounts = await admin.request('GET', '/api/accounts');
      const list = accounts.json.accounts || [];
      const inTransit = list.find((a: any) => String(a.code) === '1320' || String(a.name || '').toLowerCase().includes('in transit'));
      if (inTransit) {
        inTransitAccountId = Number(inTransit.id);
      } else {
        // create 1320 for test if missing
        const created = await admin.request('POST', '/api/accounts', {
          body: { code: '1320', name: 'Stock in Transit', accountType: 'OtherCurrentAsset', normalBalance: 'debit', isActive: true },
        });
        assert.ok(created.status === 201 || created.status === 200, `Failed to create 1320: ${created.text}`);
        inTransitAccountId = Number(created.json?.account?.id || created.json?.id);
      }
      assert.ok(inTransitAccountId, 'In-transit account missing');
      return `item=${itemId} inTransit=${inTransitAccountId}`;
    });

    let twoStepTransferId = 0;
    await runTest('3. Two-step dispatch', 'Dispatch two-step transfer creates in_transit and dispatch JE', async () => {
      const res = await admin.request('POST', '/api/inventory/transfer', {
        body: {
          fromLocation: 'Main',
          toLocation: 'Warehouse B',
          transferDate: '2026-11-25',
          transferMode: 'two_step',
          notes: 'Test two-step',
          lines: [{ itemId, quantity: 1 }],
        },
      });
      assert.equal(res.status, 201, res.text);
      const t = res.json.transfer;
      assert.equal(t.transferMode, 'two_step');
      assert.equal(t.status, 'in_transit');
      assert.ok(t.journalTxnId, 'Expected dispatch journal txn');
      twoStepTransferId = Number(t.transferId);
      return `transfer=${twoStepTransferId} je=${t.journalTxnId}`;
    });

    await runTest('4. Two-step receive', 'Receive completes transfer, moves stock, reverses JE', async () => {
      const res = await admin.request('POST', `/api/inventory/transfers/${twoStepTransferId}/receive`);
      assert.equal(res.status, 200, res.text);
      const t = res.json.transfer;
      assert.equal(t.status, 'posted');
      assert.ok(t.receiveJournalTxnId, 'Expected receive/reversal journal txn');
      assert.ok(t.dispatchJournalTxnId, 'Expected dispatch journal txn');
      return `received transfer=${t.transferId} reversal=${t.receiveJournalTxnId}`;
    });

    await runTest('5. Receive idempotency', 'Receiving posted transfer is idempotent', async () => {
      const res = await admin.request('POST', `/api/inventory/transfers/${twoStepTransferId}/receive`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.transfer.idempotent, true);
      return 'idempotent';
    });

    await runTest('6. Direct transfer', 'Direct transfer posts without JE', async () => {
      const res = await admin.request('POST', '/api/inventory/transfer', {
        body: {
          fromLocation: 'Main',
          toLocation: 'Warehouse C',
          transferDate: '2026-11-25',
          transferMode: 'direct',
          lines: [{ itemId, quantity: 1 }],
        },
      });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.transfer.status, 'posted');
      assert.equal(res.json.transfer.glImpact, 'none');
      return `transfer=${res.json.transfer.transferId}`;
    });

    await runTest('7. Scrap write-off', 'Scrap write-off posts damage with job reference', async () => {
      const res = await admin.request('POST', `/api/inventory/${itemId}/scrap`, {
        body: { quantity: 1, reason: 'Spoilage on job J-1', reasonCode: 'scrap', jobReference: 'J-1', damageDate: '2026-11-25' },
      });
      assert.equal(res.status, 201, res.text);
      assert.ok(res.json.scrap?.damageId || res.json.scrap?.id || res.json.scrap?.journalTransactionId, 'Expected scrap result');
      return `scrap=${JSON.stringify(res.json.scrap).slice(0,120)}`;
    });

    await runTest('8. Transfer list', 'GET /inventory/transfers returns transfers', async () => {
      const res = await admin.request('GET', '/api/inventory/transfers');
      assert.equal(res.status, 200, res.text);
      assert.ok(Array.isArray(res.json.transfers));
      assert.ok(res.json.transfers.length >= 2, 'Expected at least 2 transfers');
      const inTransit = await admin.request('GET', '/api/inventory/transfers?status=in_transit');
      assert.equal(inTransit.status, 200, inTransit.text);
      assert.ok(Array.isArray(inTransit.json.transfers));
      return `total=${res.json.transfers.length} in_transit=${inTransit.json.transfers.length}`;
    });

    await runTest('9. Receive controls', 'Missing transfer 404, posted transfer receive is idempotent', async () => {
      const missing = await admin.request('POST', '/api/inventory/transfers/999999/receive');
      assert.equal(missing.status, 404, missing.text);
      // direct transfer (id 2) is already posted
      const posted = await admin.request('POST', '/api/inventory/transfers/2/receive');
      assert.equal(posted.status, 200, posted.text);
      assert.equal(posted.json.transfer.idempotent, true);
      return '404/idempotent verified';
    });

    await runTest('10. Dispatch validation', 'Insufficient stock and same-location transfer rejected', async () => {
      const same = await admin.request('POST', '/api/inventory/transfer', {
        body: { fromLocation: 'Main', toLocation: 'Main', transferMode: 'direct', lines: [{ itemId, quantity: 1 }] },
      });
      assert.equal(same.status, 400, same.text);
      const tooMuch = await admin.request('POST', '/api/inventory/transfer', {
        body: { fromLocation: 'Main', toLocation: 'Warehouse Z', transferMode: 'two_step', lines: [{ itemId, quantity: 999999 }] },
      });
      assert.ok([400, 409].includes(tooMuch.status), tooMuch.text);
      return `same=${same.status} tooMuch=${tooMuch.status}`;
    });

    let partialTransferId = 0;
    await runTest('11. Partial receipt', 'Two-step transfer can be partially received then completed', async () => {
      const dispatch = await admin.request('POST', '/api/inventory/transfer', {
        body: { fromLocation: 'Main', toLocation: 'Warehouse P', transferDate: '2026-11-25', transferMode: 'two_step', lines: [{ itemId, quantity: 2 }] },
      });
      assert.equal(dispatch.status, 201, dispatch.text);
      partialTransferId = Number(dispatch.json.transfer.transferId);
      const first = await admin.request('POST', `/api/inventory/transfers/${partialTransferId}/receive`, { body: { lines: [{ itemId, receivedQty: 1 }] } });
      assert.equal(first.status, 200, first.text);
      assert.equal(first.json.transfer.status, 'partially_received', first.text);
      assert.equal(first.json.transfer.fullyReceived, false, first.text);
      assert.ok(first.json.transfer.receiveJournalTxnId, 'partial receipt should post JE');
      const detail = await admin.request('GET', `/api/inventory/transfers/${partialTransferId}`);
      assert.equal(detail.status, 200, detail.text);
      assert.equal(Number(detail.json.transfer.lines[0].received_qty), 1);
      const second = await admin.request('POST', `/api/inventory/transfers/${partialTransferId}/receive`, { body: { lines: [{ itemId, receivedQty: 1 }] } });
      assert.equal(second.status, 200, second.text);
      assert.equal(second.json.transfer.status, 'posted', second.text);
      assert.equal(second.json.transfer.fullyReceived, true, second.text);
      return `transfer=${partialTransferId} partial->posted`;
    });

    await runTest('12. Lot API', 'Can create and list inventory lots', async () => {
      const created = await admin.request('POST', '/api/inventory/lots', { body: { itemId, lotNumber: `LOT-${Date.now()}`, supplierRollId: 'ROLL-1', paperGrain: 'long', quantityOnHand: 5 } });
      assert.equal(created.status, 201, created.text);
      const list = await admin.request('GET', `/api/inventory/lots?itemId=${itemId}`);
      assert.equal(list.status, 200, list.text);
      assert.ok(Array.isArray(list.json.lots));
      assert.ok(list.json.lots.some((l: any) => Number(l.itemId) === itemId));
      return `lots=${list.json.lots.length}`;
    });

  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n=== Inventory Advanced Actions Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    for (const r of results.filter(r => !r.passed)) console.error(` - ${r.suite} :: ${r.name}: ${r.details}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
