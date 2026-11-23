/**
 * WS-1 POS cash-drawer & reconciliation tests.
 *
 * Proves:
 *  - cash-in / cash-out / deposits are recorded and included in expected cash
 *  - card/mobile-money tenders do NOT inflate expected physical cash
 *  - refunds reduce expected cash
 *  - reconciliation is scoped by shift_id, not a time window
 */
import assert from 'node:assert/strict';
import { startTestServer, loginAdmin, createCookieClient } from '../helpers/testServer.ts';

async function openShift(client: any, openingFloat: number) {
  const res = await client.request('POST', '/api/pos/shifts', {
    body: { openingFloat, notes: 'test shift' },
  });
  assert.equal(res.status, 201, `open shift failed: ${res.text}`);
  return res.json.shift.id as number;
}

async function sale(client: any, amount: number, tenderMode: 'cash' | 'card', key: string) {
  const catalog = (await client.request('GET', '/api/pos/catalog')).json;
  const item = catalog.items.find((i: any) => i.itemType === 'stationery' && i.availableQty > 0);
  assert.ok(item, 'catalog must have a sellable item');
  const res = await client.request('POST', '/api/pos/checkout', {
    body: {
      lines: [
        {
          itemId: item.id,
          description: item.name,
          quantity: 1,
          unitPrice: amount,
          taxable: true,
        },
      ],
      walkInCustomerName: 'Cash Drawer Test',
      walkInCustomerPhone: '+260970000000',
      tenderMode,
      amountTendered: amount,
      idempotencyKey: key,
    },
  });
  assert.equal(res.status, 201, `checkout failed: ${res.text}`);
  return res.json.order.id as number;
}

async function closeShift(client: any, shiftId: number, actualCash: number) {
  const res = await client.request('POST', `/api/pos/shifts/${shiftId}/close`, {
    body: { actualCash },
  });
  assert.equal(res.status, 200, `close failed: ${res.text}`);
  return res.json;
}

async function main() {
  const srv = await startTestServer();
  try {
    const admin = await loginAdmin(srv.baseUrl);
    const c = admin.client;

    // ── Scenario 1: cash sale + cash-in/out/deposit ──────────────────────
    let shiftId = await openShift(c, 50000);
    const mvIn = await c.request('POST', `/api/pos/shifts/${shiftId}/cash-movements`, {
      body: { movementType: 'cash_in', amount: 2000, reason: 'float top-up' },
    });
    assert.equal(mvIn.status, 201, `cash_in failed: ${mvIn.text}`);
    const mvOut = await c.request('POST', `/api/pos/shifts/${shiftId}/cash-movements`, {
      body: { movementType: 'cash_out', amount: 1000, reason: 'supplies' },
    });
    assert.equal(mvOut.status, 201, `cash_out failed: ${mvOut.text}`);
    const mvDep = await c.request('POST', `/api/pos/shifts/${shiftId}/cash-movements`, {
      body: { movementType: 'deposit', amount: 500, reason: 'bank drop' },
    });
    assert.equal(mvDep.status, 201, `deposit failed: ${mvDep.text}`);
    await sale(c, 15000, 'cash', 'drawer-cash-1');
    await sale(c, 8000, 'card', 'drawer-card-1');

    const expected1 = 50000 + 15000 + 2000 - 0 - 1000 - 500; // 65500
    const closed1 = await closeShift(c, shiftId, expected1);
    assert.equal(closed1.shift.cashIn, 2000, 'cashIn must include cash_in');
    assert.equal(closed1.shift.cashOut, 1000, 'cashOut must include cash_out');
    assert.equal(closed1.shift.cashDeposits, 500, 'cashDeposits must include deposit');
    assert.equal(closed1.shift.cashSales, 15000, 'cashSales must be cash tenders only');
    assert.equal(closed1.shift.cardSales, 8000, 'cardSales must be card tenders');
    assert.equal(closed1.shift.expectedCash, expected1, 'expected cash formula');
    assert.equal(closed1.variance, 0, 'perfect close has zero variance');

    // ── Scenario 2: card-only sale does not inflate expected cash ────────
    shiftId = await openShift(c, 0);
    await sale(c, 7000, 'card', 'drawer-card-2');
    const closed2 = await closeShift(c, shiftId, 0);
    assert.equal(closed2.shift.expectedCash, 0, 'card sales must not affect expected cash');
    assert.equal(closed2.variance, 0);

    // ── Scenario 3: refund reduces expected cash ─────────────────────────
    shiftId = await openShift(c, 1000);
    const orderId = await sale(c, 5000, 'cash', 'drawer-cash-3');
    const voidRes = await c.request('POST', `/api/pos/orders/${orderId}/void`, {
      body: { reason: 'customer changed mind' },
    });
    assert.equal(voidRes.status, 200, `void failed: ${voidRes.text}`);
    const closed3 = await closeShift(c, shiftId, 1000);
    assert.equal(closed3.shift.cashRefunds, 5000, 'refund must be recorded');
    assert.equal(closed3.shift.expectedCash, 1000, 'expected cash = float + sale - refund');
    assert.equal(closed3.variance, 0);

    // ── Scenario 4: manager override to close another cashier's shift ────
    const bookkeeper = createCookieClient(srv.baseUrl);
    assert.equal(
      (await bookkeeper.request('POST', '/api/auth/login', {
        body: { identifier: 'bookkeeper', password: 'PrintingAdmin#2026' },
      })).status,
      200
    );
    const production = createCookieClient(srv.baseUrl);
    assert.equal(
      (await production.request('POST', '/api/auth/login', {
        body: { identifier: 'production', password: 'PrintingAdmin#2026' },
      })).status,
      200
    );
    const prodShift = await openShift(production, 1000);
    // Bookkeeper has pos:write but NOT pos:manage_shifts → override denied.
    const denied = await bookkeeper.request('POST', `/api/pos/shifts/${prodShift}/close`, {
      body: { actualCash: 1000, allowOtherCashier: true },
    });
    assert.equal(denied.status, 403, 'non-manager cannot close another cashier shift');
    // Administrator holds pos:manage_shifts → override succeeds.
    const forced = await c.request('POST', `/api/pos/shifts/${prodShift}/close`, {
      body: { actualCash: 1000, allowOtherCashier: true },
    });
    assert.equal(forced.status, 200, `manager override failed: ${forced.text}`);

    console.log('✅ POS cash-drawer & reconciliation tests passed');
  } finally {
    await srv.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});