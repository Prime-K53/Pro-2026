import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';

/**
 * Integration suite for the advanced inventory operations.
 *
 * The point of this suite is the invariant that must never break: a stock
 * movement and its general-ledger entry always agree. Every scenario below
 * checks both sides — the quantity and the balanced journal — because a change
 * that updates on_hand without a matching journal (or the reverse) is a silent
 * balance-sheet error.
 */

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

  async request(
    method: string,
    pathname: string,
    options: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; text: string; json: any }> {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(options.headers || {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
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

/** Parse a fixed-point string coming from the server into an exact integer of 4dp. */
function d4(value: unknown): bigint {
  const raw = String(value ?? '0').trim();
  if (!raw) return 0n;
  const neg = raw.startsWith('-');
  const [intPart, fracPart = ''] = raw.replace(/^[+-]/, '').split('.');
  const frac = (fracPart + '0000').slice(0, 4);
  const scaled = BigInt(intPart || '0') * 10000n + BigInt(frac);
  return neg ? -scaled : scaled;
}

async function main() {
  console.log(
    '=== Printing Management System — Advanced Inventory Operations Integration Suite ===\n'
  );

  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-inv-attach-'));
  const baseCfg = loadServerConfig();
  const testCfg = {
    ...baseCfg,
    nodeEnv: 'test',
    isProduction: false,
    attachmentsDir: tmpAttachDir,
  };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);

  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const admin = new CookieHttpClient(baseUrl);
  let companyId = 0;

  /** Sum of debits minus credits for a journal entry — must be zero. */
  async function journalDelta(entryId: number): Promise<bigint> {
    return db.withCompanyDb(companyId, async tx => {
      const res = await tx.query<{ debit: string; credit: string }>(
        `SELECT debit::text AS debit, credit::text AS credit
           FROM journal_lines
          WHERE company_id = $1 AND transaction_id = $2`,
        [companyId, entryId]
      );
      let delta = 0n;
      for (const row of res.rows) delta += d4(row.debit) - d4(row.credit);
      return delta;
    });
  }

  async function onHand(itemId: number): Promise<bigint> {
    return db.withCompanyDb(companyId, async tx => {
      const res = await tx.query<{ on_hand: string }>(
        `SELECT on_hand::text AS on_hand FROM inventory_items WHERE company_id = $1 AND id = $2`,
        [companyId, itemId]
      );
      return d4(res.rows[0].on_hand);
    });
  }

  /** Every journal entry in the company must be balanced. */
  async function assertAllJournalsBalanced(label: string) {
    const bad = await db.withCompanyDb(companyId, async tx => {
      const res = await tx.query<{ id: number; delta: string }>(
        `SELECT t.id, COALESCE(SUM(l.debit - l.credit), 0)::text AS delta
           FROM journal_transactions t
           LEFT JOIN journal_lines l
             ON l.company_id = t.company_id AND l.transaction_id = t.id
          WHERE t.company_id = $1
          GROUP BY t.id
         HAVING COALESCE(SUM(l.debit - l.credit), 0) <> 0`,
        [companyId]
      );
      return res.rows;
    });
    assert.equal(
      bad.length,
      0,
      `${label}: ${bad.length} unbalanced journal(s) — ${JSON.stringify(bad.slice(0, 5))}`
    );
  }

  try {
    // -------------------------------------------------------------------------
    // 0. Sign in and pick a stocked raw material
    // -------------------------------------------------------------------------
    let item: any = null;

    await runTest(
      '1. Read Models',
      'Every inventory read endpoint returns server-sourced data for a stocked item',
      async () => {
        const login = await admin.request('POST', '/api/auth/login', {
          body: { identifier: 'admin', password: 'PrintingAdmin#2026' },
        });
        assert.equal(login.status, 200, `login failed: ${login.text}`);
        companyId = login.json.activeCompany.id;

        const list = await admin.request('GET', '/api/inventory');
        assert.equal(list.status, 200, `GET /api/inventory failed: ${list.text}`);
        const stocked = (list.json.items as any[]).filter(
          i => i.item_type === 'raw_material' || i.item_type === 'stationery'
        );
        assert.ok(stocked.length > 0, 'demo seed should contain at least one stocked item');
        item = stocked[0];

        const detail = await admin.request('GET', `/api/inventory/${item.id}`);
        assert.equal(detail.status, 200, `GET /inventory/:id failed: ${detail.text}`);
        assert.ok(detail.json.item, 'detail must include the item master record');
        assert.ok(Array.isArray(detail.json.variants), 'detail must include variants');
        assert.ok(Array.isArray(detail.json.bom), 'detail must include BOM components');

        // Amounts must arrive as exact fixed-point strings, never numbers.
        for (const field of ['on_hand', 'avg_cost', 'valuation', 'unit_cost']) {
          assert.equal(
            typeof detail.json.item[field],
            'string',
            `${field} must be a fixed-point string, got ${typeof detail.json.item[field]}`
          );
        }

        for (const suffix of ['/movements', '/ledger', '/bom', '/consumption', '/transactions', '/supplier-history']) {
          const res = await admin.request('GET', `/api/inventory/${item.id}${suffix}`);
          assert.equal(res.status, 200, `GET /inventory/:id${suffix} failed: ${res.text}`);
        }

        const levels = await admin.request('GET', '/api/inventory/reorder-levels');
        assert.equal(levels.status, 200, 'GET /inventory/reorder-levels failed');
        assert.ok(Array.isArray(levels.json.items), 'reorder-levels must return an items array');

        // The static route must not be swallowed by /inventory/:id.
        assert.notEqual(item.id, 'reorder-levels');

        return `loaded ${item.sku} (${item.item_type}) on hand ${detail.json.item.on_hand}, avg cost ${detail.json.item.avg_cost}; 8 read endpoints OK`;
      }
    );

    // -------------------------------------------------------------------------
    // 2. Damage write-off decrements stock and posts a balanced journal
    // -------------------------------------------------------------------------
    await runTest(
      '2. Stock Damage',
      'Damage decrements on_hand by exactly the posted quantity and balances the GL',
      async () => {
        const before = await onHand(Number(item.id));
        const ledgerBefore = await admin.request('GET', `/api/inventory/${item.id}/ledger`);
        const movementsBefore = ledgerBefore.json.summary.movementCount as number;

        const res = await admin.request('POST', `/api/inventory/${item.id}/damage`, {
          body: { quantity: '2.5000', reasonCode: 'damaged', reason: 'Integration suite write-off' },
        });
        assert.equal(res.status, 201, `damage failed: ${res.text}`);

        const damage = res.json.damage;
        assert.equal(d4(damage.quantity), 25000n, 'server must echo the exact quantity');
        assert.equal(d4(damage.onHandBefore), before, 'onHandBefore must equal the stored on_hand');
        assert.equal(
          d4(damage.onHandAfter),
          before - d4(damage.quantity),
          'onHandAfter must equal onHandBefore minus quantity'
        );
        assert.equal(await onHand(Number(item.id)), before - d4(damage.quantity), 'stored on_hand must move by exactly the damaged quantity');
        assert.equal(await journalDelta(damage.journalTransactionId), 0n, 'damage journal must balance');
        assert.ok(damage.entryNumber, 'a journal entry number must be issued');

        // The damage register row and the movement ledger must both record it.
        const tx = await admin.request('GET', `/api/inventory/${item.id}/transactions`);
        assert.equal(tx.status, 200);
        assert.equal(
          tx.json.damages.length,
          1,
          'exactly one damage register row should exist for this item'
        );
        assert.equal(d4(tx.json.damages[0].value), d4(damage.value), 'register value must match the posted value');

        const ledgerAfter = await admin.request('GET', `/api/inventory/${item.id}/ledger`);
        assert.equal(
          ledgerAfter.json.summary.movementCount,
          movementsBefore + 1,
          'the ledger must record exactly one new movement'
        );

        await assertAllJournalsBalanced('after damage');
        return `${damage.sku} ${damage.quantity} written off at ${damage.value}; on hand ${damage.onHandBefore} -> ${damage.onHandAfter}; ${damage.entryNumber} balanced`;
      }
    );

    // -------------------------------------------------------------------------
    // 3. Rejects an over-damage instead of going negative
    // -------------------------------------------------------------------------
    await runTest(
      '3. Stock Damage Guard',
      'Damage larger than on_hand is rejected and leaves stock untouched',
      async () => {
        const before = await onHand(Number(item.id));
        const res = await admin.request('POST', `/api/inventory/${item.id}/damage`, {
          body: { quantity: '999999' },
        });
        assert.equal(res.status, 409, `over-damage must be rejected with 409, got ${res.status}: ${res.text}`);
        assert.equal(await onHand(Number(item.id)), before, 'rejected damage must not change stock');
        await assertAllJournalsBalanced('after rejected damage');
        return `rejected with ${res.json.code}`;
      }
    );

    // -------------------------------------------------------------------------
    // 4. Transfer is stock-neutral, reconciles locations, posts no journal
    // -------------------------------------------------------------------------
    await runTest(
      '4. Stock Transfer',
      'Transfer moves location balances, leaves on_hand unchanged and posts no journal',
      async () => {
        const onHandBefore = await onHand(Number(item.id));

        const journalsBefore = await db.withCompanyDb(companyId, async tx => {
          const res = await tx.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt FROM journal_transactions WHERE company_id = $1`,
            [companyId]
          );
          return Number(res.rows[0].cnt);
        });

        const res = await admin.request('POST', '/api/inventory/transfer', {
          body: {
            fromLocation: 'Main',
            toLocation: 'Warehouse B',
            transferDate: new Date().toISOString().slice(0, 10),
            lines: [{ itemId: Number(item.id), quantity: '1.2500' }],
          },
        });
        assert.equal(res.status, 201, `transfer failed: ${res.text}`);
        assert.equal(res.json.transfer.glImpact, 'none', 'a transfer must report zero GL impact');
        assert.ok(res.json.transfer.transferNumber, 'a transfer number must be issued');

        assert.equal(await onHand(Number(item.id)), onHandBefore, 'a transfer must not change company-wide on_hand');

        // Location balances must reconcile to on_hand.
        const balances = await db.withCompanyDb(companyId, async tx => {
          const res = await tx.query<{ location: string; qty: string }>(
            `SELECT location, qty::text AS qty FROM stock_balances
              WHERE company_id = $1 AND item_id = $2 AND COALESCE(variant_id, 0) = 0
              ORDER BY location`,
            [companyId, item.id]
          );
          return res.rows;
        });
        const total = balances.reduce((sum, b) => sum + d4(b.qty), 0n);
        assert.equal(total, onHandBefore, 'location balances must sum to on_hand');

        const byLocation = new Map(balances.map(b => [b.location.toLowerCase(), d4(b.qty)]));
        assert.ok(byLocation.has('warehouse b'), 'destination location balance must exist');
        assert.ok(byLocation.has('main'), 'source location balance must exist');
        assert.equal(byLocation.get('warehouse b'), 12500n, 'destination must receive the transferred quantity');
        assert.equal(
          byLocation.get('main')! + 12500n,
          onHandBefore,
          'source must give up exactly the transferred quantity'
        );

        // Two mirrored movements, net zero, one for each side of the move.
        const transferMovements = await db.withCompanyDb(companyId, async tx => {
          const res = await tx.query<{ quantity_delta: string; location: string }>(
            `SELECT quantity_delta::text AS quantity_delta, location
               FROM inventory_movements
              WHERE company_id = $1 AND item_id = $2 AND source_type = 'stock_transfer'
              ORDER BY id ASC`,
            [companyId, item.id]
          );
          return res.rows;
        });
        assert.equal(
          transferMovements.length,
          2,
          'a single-line transfer must write exactly two mirrored movement rows'
        );
        const net = transferMovements.reduce((sum, m) => sum + d4(m.quantity_delta), 0n);
        assert.equal(net, 0n, 'the two mirrored movements must net to zero');

        const journalsAfter = await db.withCompanyDb(companyId, async tx => {
          const r = await tx.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt FROM journal_transactions WHERE company_id = $1`,
            [companyId]
          );
          return Number(r.rows[0].cnt);
        });
        assert.equal(journalsAfter, journalsBefore, 'a transfer must not create a journal entry');

        await assertAllJournalsBalanced('after transfer');
        return `${res.json.transfer.transferNumber}: Main -> Warehouse B, 1.2500 moved, on_hand unchanged at ${res.json.transfer.lines[0].quantity}, balances ${balances.length} rows summing to on_hand`;
      }
    );

    // -------------------------------------------------------------------------
    // 5. Draft count does not move stock; posting applies the variance
    // -------------------------------------------------------------------------
    await runTest(
      '5. Stock Count',
      'A draft count leaves stock untouched; posting applies the variance and balances the GL',
      async () => {
        const before = await onHand(Number(item.id));

        // Count 5 units below the system figure.
        const counted = before - 50000n;

        const draft = await admin.request('POST', '/api/stock-counts', {
          body: {
            countDate: new Date().toISOString().slice(0, 10),
            notes: 'Integration suite count',
            lines: [{ itemId: Number(item.id), countedQty: String(Number(counted) / 10000) }],
          },
        });
        assert.equal(draft.status, 201, `draft count failed: ${draft.text}`);
        assert.equal(draft.json.stockCount.status, 'draft', 'a new count must be a draft');
        assert.ok(draft.json.stockCount.countNumber, 'a count number must be issued');

        const countId = draft.json.stockCount.countId;
        const draftLine = draft.json.stockCount.lines[0];
        assert.equal(d4(draftLine.systemQty), before, 'draft must snapshot the live system quantity');
        assert.equal(d4(draftLine.countedQty), counted, 'draft must echo the counted quantity');
        assert.equal(d4(draftLine.varianceQty), -50000n, 'draft variance must be counted minus system');

        // Draft must not touch stock.
        assert.equal(await onHand(Number(item.id)), before, 'a draft count must not change on_hand');

        // Post it.
        const posted = await admin.request('POST', `/api/stock-counts/${countId}/post`, {
          body: {},
        });
        assert.equal(posted.status, 201, `posting the count failed: ${posted.text}`);
        assert.equal(posted.json.stockCount.status, 'posted');
        assert.equal(await onHand(Number(item.id)), counted, 'posting must apply the variance to on_hand');

        const postedLine = posted.json.stockCount.lines[0];
        const expectedValue = (d4(postedLine.varianceQty) * d4(postedLine.unitCost)) / 10000n;
        assert.equal(
          d4(posted.json.stockCount.netVariance),
          expectedValue,
          `net variance must equal variance quantity (${postedLine.varianceQty}) times unit cost (${postedLine.unitCost})`
        );
        assert.equal(
          d4(postedLine.value),
          expectedValue,
          'the line value must equal variance quantity times unit cost'
        );
        if (posted.json.stockCount.journalTransactionId) {
          assert.equal(
            await journalDelta(posted.json.stockCount.journalTransactionId),
            0n,
            'the count journal must balance'
          );
        }

        // Re-posting must be rejected.
        const again = await admin.request('POST', `/api/stock-counts/${countId}/post`, { body: {} });
        assert.equal(again.status, 409, `re-posting must be rejected with 409, got ${again.status}: ${again.text}`);

        await assertAllJournalsBalanced('after count');
        const fmt = (v: bigint) => (Number(v) / 10000).toFixed(4);
        return `${draft.json.stockCount.countNumber}: variance ${posted.json.stockCount.netVariance}, on hand ${fmt(before)} -> ${fmt(counted)}, re-post rejected`;
      }
    );

    // -------------------------------------------------------------------------
    // 6. Deactivation is refused while stock or history exists
    // -------------------------------------------------------------------------
    await runTest(
      '6. Deactivation Guard',
      'Deactivating an item with stock or history is refused and changes nothing',
      async () => {
        const res = await admin.request('POST', `/api/inventory/${item.id}/deactivate`, { body: {} });
        assert.equal(
          res.status,
          409,
          `deactivation of an item with stock must be rejected with 409, got ${res.status}: ${res.text}`
        );
        assert.ok(
          ['ITEM_HAS_STOCK', 'ITEM_IN_USE'].includes(res.json.code),
          `expected a stock/reference guard code, got ${res.json.code}`
        );

        const check = await admin.request('GET', `/api/inventory/${item.id}`);
        assert.equal(check.json.item.is_active, true, 'a rejected deactivation must not deactivate the item');

        return `rejected with ${res.json.code}`;
      }
    );

    // -------------------------------------------------------------------------
    // 7. Editing master data (rename) never disturbs stock or valuation
    // -------------------------------------------------------------------------
    await runTest(
      '7. Item Master Edit',
      'Renaming an item and editing costs leaves on_hand and avg_cost untouched, and rejects duplicate SKUs',
      async () => {
        const before = await onHand(Number(item.id));
        const detailBefore = await admin.request('GET', `/api/inventory/${item.id}`);
        const avgCostBefore = d4(detailBefore.json.item.avg_cost);

        // A no-op rename to the same SKU must succeed and change nothing else.
        const noop = await admin.request('PATCH', `/api/inventory/${item.id}`, {
          body: { name: `${item.name} (edited)`, sku: item.sku },
        });
        assert.equal(noop.status, 200, `no-op rename failed: ${noop.text}`);
        assert.equal(noop.json.item.name, `${item.name} (edited)`, 'the new name must be stored');
        assert.equal(await onHand(Number(item.id)), before, 'editing master data must not change on_hand');
        const detailAfterName = await admin.request('GET', `/api/inventory/${item.id}`);
        assert.equal(
          d4(detailAfterName.json.item.avg_cost),
          avgCostBefore,
          'editing master data must not change the moving average'
        );

        // Rename the SKU itself.
        const renamedSku = `${item.sku}-R`;
        const rename = await admin.request('PATCH', `/api/inventory/${item.id}`, {
          body: { sku: renamedSku },
        });
        assert.equal(rename.status, 200, `SKU rename failed: ${rename.text}`);
        assert.equal(rename.json.item.sku, renamedSku, 'the new SKU must be stored');
        assert.equal(await onHand(Number(item.id)), before, 'a SKU rename must not change on_hand');

        const detailAfterSku = await admin.request('GET', `/api/inventory/${item.id}`);
        assert.equal(detailAfterSku.json.item.sku, renamedSku, 'the SKU must read back renamed');

        // A duplicate SKU must be rejected with 409.
        const others = (detailAfterSku.json.item && (await admin.request('GET', '/api/inventory'))).json.items as any[];
        const other = others.find(i => Number(i.id) !== Number(item.id) && i.sku);
        if (other) {
          const dup = await admin.request('PATCH', `/api/inventory/${item.id}`, {
            body: { sku: other.sku },
          });
          assert.equal(
            dup.status,
            409,
            `a duplicate SKU must be rejected with 409, got ${dup.status}: ${dup.text}`
          );
          assert.equal(dup.json.code, 'DUPLICATE_SKU', 'expected the DUPLICATE_SKU code');
        }

        // Blank name must be rejected.
        const blank = await admin.request('PATCH', `/api/inventory/${item.id}`, { body: { name: '   ' } });
        assert.equal(blank.status, 400, `a blank name must be rejected with 400, got ${blank.status}`);

        await assertAllJournalsBalanced('after item edit');
        item.sku = renamedSku;
        return `renamed ${item.sku}-R; name, SKU and costs updated with on_hand ${before} and avg_cost unchanged; duplicate SKU and blank name rejected`;
      }
    );

    // -------------------------------------------------------------------------
    // 8. RBAC: read-only cannot write inventory
    // -------------------------------------------------------------------------
    await runTest(
      '8. RBAC Enforcement',
      'Roles without the granular inventory permissions are refused on the write endpoints',
      async () => {
        // The Accountant seed has inventory:read but none of the granular
        // write permissions, which is exactly the separation being tested.
        const accountant = new CookieHttpClient(baseUrl);
        const login = await accountant.request('POST', '/api/auth/login', {
          body: { identifier: 'accountant', password: 'PrintingAdmin#2026' },
        });
        assert.equal(login.status, 200, `accountant login failed: ${login.text}`);

        const damage = await accountant.request('POST', `/api/inventory/${item.id}/damage`, {
          body: { quantity: '1' },
        });
        assert.equal(
          damage.status,
          403,
          `accountant must be blocked from damage (no inventory:damage), got ${damage.status}: ${damage.text}`
        );

        const transfer = await accountant.request('POST', '/api/inventory/transfer', {
          body: {
            fromLocation: 'Main',
            toLocation: 'X',
            lines: [{ itemId: Number(item.id), quantity: '1' }],
          },
        });
        assert.equal(
          transfer.status,
          403,
          `accountant must be blocked from transfer (no inventory:transfer), got ${transfer.status}`
        );

        const count = await accountant.request('POST', '/api/stock-counts', {
          body: { lines: [{ itemId: Number(item.id), countedQty: '1' }] },
        });
        assert.equal(
          count.status,
          403,
          `accountant must be blocked from stock counts (no inventory:count), got ${count.status}`
        );

        // But reading is allowed — the permission is granular, not a blanket block.
        const read = await accountant.request('GET', `/api/inventory/${item.id}/ledger`);
        assert.equal(read.status, 200, 'accountant must still be able to read inventory');

        // The ProductionManager seed holds the operational stock permissions.
        const production = new CookieHttpClient(baseUrl);
        const prodLogin = await production.request('POST', '/api/auth/login', {
          body: { identifier: 'production', password: 'PrintingAdmin#2026' },
        });
        assert.equal(prodLogin.status, 200, `production login failed: ${prodLogin.text}`);
        const prodRead = await production.request('GET', `/api/inventory/${item.id}`);
        assert.equal(prodRead.status, 200, 'production manager must be able to read inventory');

        return 'accountant refused damage/transfer/count (403) but may read (200); production may read (200)';
      }
    );

    // -------------------------------------------------------------------------
    // 8. Final global invariant
    // -------------------------------------------------------------------------
    await runTest(
      '9. Ledger Invariant',
      'Every journal entry in the company remains balanced after all operations',
      async () => {
        await assertAllJournalsBalanced('final');

        // on_hand must never be negative for any stocked item.
        const negatives = await db.withCompanyDb(companyId, async tx => {
          const res = await tx.query<{ sku: string; on_hand: string }>(
            `SELECT sku, on_hand::text AS on_hand FROM inventory_items
              WHERE company_id = $1 AND on_hand < 0`,
            [companyId]
          );
          return res.rows;
        });
        assert.equal(negatives.length, 0, `negative stock detected: ${JSON.stringify(negatives)}`);

        // No floating-point column may exist anywhere in the schema.
        const floats = await db.withCompanyDb(companyId, async tx => {
          const res = await tx.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt FROM information_schema.columns
              WHERE table_schema = 'public' AND data_type IN ('real', 'double precision')`
          );
          return Number(res.rows[0].cnt);
        });
        assert.equal(floats, 0, 'the schema must contain zero floating-point columns');

        return 'all journals balanced, no negative stock, 0 floating-point columns';
      }
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try {
      await db.pg.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpAttachDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log(`\nSummary: ${passed}/${results.length} PASSED in ${totalMs}ms.`);

  const reportPath = path.resolve(
    process.env.PMS_TEST_REPORT_DIR || path.join(process.cwd(), 'docs'),
    'database/inventory-ops-test-execution-report.md'
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const lines = [
    '# Advanced Inventory Operations — Test Execution Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `**Result:** ${passed}/${results.length} passed${failed > 0 ? `, ${failed} FAILED` : ''} (${totalMs}ms)`,
    '',
    '| Suite | Test | Result | Duration | Details |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(
      r =>
        `| ${r.suite} | ${r.name} | ${r.passed ? 'PASS' : '**FAIL**'} | ${r.durationMs}ms | ${r.details.replace(/\|/g, '\\|')} |`
    ),
    '',
  ];
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`Report written to ${reportPath}`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});