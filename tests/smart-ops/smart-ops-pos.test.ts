import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';
import { parseDecimal4 } from '../../src/server/lib/decimal.ts';

class CookieHttpClient {
  public cookie = '';
  constructor(private baseUrl: string) {}

  async request(
    method: string,
    pathname: string,
    options: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; headers: Headers; text: string; json: any }> {
    const headers: Record<string, string> = {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(options.headers || {}),
    };
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
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
    return { status: res.status, headers: res.headers, text, json };
  }
}

async function runTest(name: string, fn: () => Promise<string | void>) {
  const start = Date.now();
  const details = (await fn()) || 'OK';
  console.log(`  [PASS] (${Date.now() - start}ms) ${name} — ${details}`);
}

async function main() {
  console.log('=== Smart Operations & Full POS End-to-End Verification Suite ===\n');

  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-smart-ops-test-'));
  const baseCfg = loadServerConfig();
  const db: ServerDatabase = await createServerDatabase(
    {
      ...baseCfg,
      nodeEnv: 'test',
      isProduction: false,
      attachmentsDir: tmpAttachDir,
    },
    { inMemory: true, seedDemo: true }
  );
  const app = createApiExpressApp(db);

  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const admin = new CookieHttpClient(baseUrl);
  const accountant = new CookieHttpClient(baseUrl);

  const assertJournalBalanced = async (journalTxnId: number) => {
    const res = await admin.request('GET', `/api/journals/${journalTxnId}`);
    assert.equal(res.status, 200, `Journal ${journalTxnId} lookup failed`);
    let deb = 0n;
    let cred = 0n;
    for (const l of res.json.entry.lines) {
      deb += parseDecimal4(l.debit);
      cred += parseDecimal4(l.credit);
    }
    assert.equal(deb, cred, `Journal ${journalTxnId} unbalanced: ${deb} != ${cred}`);
    assert.ok(deb > 0n);
    return res.json.entry;
  };

  try {
    assert.equal(
      (await admin.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } })).status,
      200
    );
    assert.equal(
      (await accountant.request('POST', '/api/auth/login', { body: { identifier: 'accountant', password: 'PrintingAdmin#2026' } })).status,
      200
    );

    // 1. Initialize GL Accounts & Playbook
    await runTest('1. Initialize GL Accounts & Starter Playbook', async () => {
      const init = await admin.request('POST', '/api/smart-ops/initialize-accounts');
      assert.equal(init.status, 200);
      assert.equal(init.json.initialized, true);
      const ov = await admin.request('GET', '/api/smart-ops/overview');
      assert.equal(ov.status, 200);
      const codes = (ov.json.linkedAccounts as any[]).map(a => a.code);
      for (const expected of ['1010', '1030', '1050', '2150', '4000', '4100', '6450']) {
        assert.ok(codes.includes(expected), `Missing GL account ${expected}`);
      }
      assert.ok(ov.json.promotions.activeCount >= 1);
      assert.ok(ov.json.referrals.activePrograms >= 1);
      assert.ok(ov.json.marketing.activeRules >= 1);
      return `Linked accounts=${codes.join(',')}`;
    });

    // 2. Role RBAC Guard
    await runTest('2. RBAC Permission Enforcement', async () => {
      // Accountant has smart_ops:read and pos:read, NOT smart_ops:write or pos:write
      const rRead = await accountant.request('GET', '/api/smart-ops/overview');
      assert.equal(rRead.status, 200);
      const rWrite = await accountant.request('POST', '/api/smart-ops/promotions', {
        body: { code: 'BLOCKED', name: 'Blocked', discountType: 'percent', discountValue: 5 },
      });
      assert.equal(rWrite.status, 403);
      return 'Accountant granted read (200) & denied write (403)';
    });

    // 3. Promotions + Price Cards Live Feed
    let promoId = 0;
    await runTest('3. Promotions & Live POS Price Card Sync', async () => {
      const pRes = await admin.request('POST', '/api/smart-ops/promotions', {
        body: {
          code: 'VIP20',
          name: 'VIP 20% Print Offer',
          discountType: 'percent',
          discountValue: 20,
          minOrderAmount: 100,
          maxDiscountAmount: 150,
          showOnPriceCard: true,
        },
      });
      assert.equal(pRes.status, 201);
      promoId = pRes.json.promotion.id;

      const pcRes = await admin.request('GET', '/api/smart-ops/price-cards');
      assert.equal(pcRes.status, 200);
      assert.ok(pcRes.json.items.length > 0, 'Expected live POS items in Price Cards');
      assert.ok(pcRes.json.promotions.some((p: any) => p.code === 'VIP20'));

      const presetRes = await admin.request('POST', '/api/smart-ops/price-cards/presets', {
        body: {
          title: 'Term 2 Flyer',
          theme: 'emerald',
          itemIds: [pcRes.json.items[0].id],
          promoId,
        },
      });
      assert.equal(presetRes.status, 201);
      return `Live items=${pcRes.json.items.length}, promo=VIP20`;
    });

    // 4. Create Customer + Advocate Code + POS Checkout (Referral-only, campaign rates, D1-A)
    let advocateCustId = 0;
    let referralCodeId = 0;
    let referralCodeStr = '';
    let posOrderId = 0;
    let firstEventId = 0;

    await runTest('4. POS Referral Checkout (Campaign Rates, No Promo Stacking, Pending Reward)', async () => {
      const custRes = await admin.request('POST', '/api/customers', {
        body: {
          name: 'Kabulonga Academy',
          companyName: 'Kabulonga Academy',
          email: 'bursar@kabulonga.edu.zm',
          customerType: 'school',
          phone: '+260977123456',
          terms: 'Net 30',
        },
      });
      assert.equal(custRes.status, 201);
      advocateCustId = custRes.json.customer.id;

      const refData = await admin.request('GET', '/api/smart-ops/referrals');
      const progId = refData.json.programs[0].id;

      const codeRes = await admin.request('POST', '/api/smart-ops/referrals/codes', {
        body: {
          programId: progId,
          referrerCustomerId: advocateCustId,
          referrerName: 'Kabulonga Academy',
          referrerPhone: '+260977123456',
          code: 'KABULONGA5',
        },
      });
      assert.equal(codeRes.status, 201);
      referralCodeId = codeRes.json.code.id;
      referralCodeStr = codeRes.json.code.code;

      const catRes = await admin.request('GET', '/api/pos/catalog');
      assert.equal(catRes.status, 200);
      const stockedItem = (catRes.json.items as any[]).find(i => i.itemType === 'stationery');
      const svcItem = (catRes.json.items as any[]).find(i => i.itemType === 'printing_service');
      assert.ok(stockedItem && svcItem, 'Expected stationery and printing_service items');
      const cashAcct = catRes.json.depositAccounts.find((a: any) => a.code === '1050');
      const mobAcct = catRes.json.depositAccounts.find((a: any) => a.code === '1030');

      // Referral-only preview: 5% referee discount on eligible 500 = 25 (campaign-configured rate).
      const refPreview = await admin.request('POST', '/api/pos/preview', {
        body: {
          lines: [
            { itemId: stockedItem.id, description: stockedItem.name, quantity: 2, unitPrice: 150, isTaxable: true },
            { itemId: svcItem.id, description: svcItem.name, quantity: 100, unitPrice: 2, isTaxable: true },
          ],
          referralCode: referralCodeStr,
          taxRate: 16,
          isTaxExempt: false,
        },
      });
      assert.equal(refPreview.status, 200);
      assert.equal(refPreview.json.grossSubtotal, 500);
      assert.equal(refPreview.json.referralDiscount, 25);
      assert.equal(refPreview.json.netSubtotal, 475);
      assert.equal(refPreview.json.taxAmount, 76);
      assert.equal(refPreview.json.total, 551);

      // Promo + referral → referral discount suppressed (D1-A).
      const stackPreview = await admin.request('POST', '/api/pos/preview', {
        body: {
          lines: [
            { itemId: stockedItem.id, description: stockedItem.name, quantity: 2, unitPrice: 150, isTaxable: true },
          ],
          promoCode: 'VIP20',
          referralCode: referralCodeStr,
          taxRate: 16,
          isTaxExempt: false,
        },
      });
      assert.equal(stackPreview.status, 200);
      assert.equal(stackPreview.json.promoDiscount, 60); // 20% of 300
      assert.equal(stackPreview.json.referralDiscount, 0);
      assert.equal(stackPreview.json.netSubtotal, 240);

      const checkoutRes = await admin.request('POST', '/api/pos/checkout', {
        body: {
          lines: [
            { itemId: stockedItem.id, description: stockedItem.name, quantity: 2, unitPrice: 150, isTaxable: true },
            { itemId: svcItem.id, description: svcItem.name, quantity: 100, unitPrice: 2, isTaxable: true },
          ],
          walkInCustomerName: 'Walk-in Referee',
          walkInCustomerPhone: '+260966998877',
          referralCode: referralCodeStr,
          taxRate: 16,
          isTaxExempt: false,
          tenderMode: 'split',
          tenders: [
            { tenderMethod: 'Cash', depositAccountId: cashAcct.id, amount: 200 },
            { tenderMethod: 'Mobile Money', depositAccountId: mobAcct.id, amount: 351, referenceNumber: 'MOMO-9988' },
          ],
          idempotencyKey: 'pos-test-key-1',
        },
      });
      assert.equal(checkoutRes.status, 201);
      const order = checkoutRes.json.order;
      posOrderId = order.id;
      assert.equal(order.total, 551);
      assert.ok(order.journalTxnId > 0);
      await assertJournalBalanced(order.journalTxnId);

      const refAfter = await admin.request('GET', '/api/smart-ops/referrals');
      const ev = refAfter.json.events.find((e: any) => e.posOrderId === posOrderId);
      assert.ok(ev, 'referral event exists');
      firstEventId = ev.id;
      assert.equal(ev.status, 'pending');
      assert.equal(ev.rewardAmount, 14.25); // 3% of 475
      assert.equal(ev.accrualJournalTxnId, null); // recognised at qualification (F4-A)
      assert.ok(ev.attributionId > 0, 'first-valid attribution recorded');

      return `Receipt=${order.receiptNumber}, Total=551, PendingReward=14.25`;
    });

    // 5. Referral Qualification → Existing Wallet Credit → Reversal
    await runTest('5. Referral Qualification → Existing Customer Wallet Credit & Reversal (D-02-B)', async () => {
      const q = await admin.request('POST', `/api/smart-ops/referrals/events/${firstEventId}/qualify`, { body: {} });
      assert.equal(q.status, 200);
      assert.equal(q.json.qualified.status, 'approved');
      assert.ok(q.json.credit, 'below-threshold reward auto-credited after qualification');
      assert.equal(q.json.credit.status, 'credited');
      assert.ok(q.json.credit.walletTxnId > 0, 'existing wallet transaction created');
      await assertJournalBalanced(q.json.credit.journalTxnId);

      const wallets = await admin.request('GET', `/api/wallets?customerId=${advocateCustId}`);
      assert.equal(wallets.status, 200);
      const w = wallets.json.wallets[0];
      assert.ok(w, 'referrer wallet exists');
      assert.ok(Math.abs(w.balance - 14.25) < 0.001, `wallet balance ${w.balance}`);

      const stmt = await admin.request('GET', `/api/wallets/${w.id}/transactions`);
      assert.ok(
        stmt.json.transactions.some((t: any) => t.txnType === 'referral_reward' && Math.abs(t.amount - 14.25) < 0.001),
        'wallet statement shows referral_reward txn'
      );

      const rev = await admin.request('POST', `/api/smart-ops/referrals/events/${firstEventId}/reverse`, {
        body: { reason: 'Customer refunded' },
      });
      assert.equal(rev.status, 200, `reverse failed: ${JSON.stringify(rev.json)}`);
      assert.equal(rev.json.reversalAmount, 14.25);

      const wallets2 = await admin.request('GET', `/api/wallets?customerId=${advocateCustId}`);
      assert.ok(Math.abs(wallets2.json.wallets[0].balance - 0) < 0.001, `wallet after reversal ${wallets2.json.wallets[0].balance}`);

      return `WalletCredited=14.25, Reversed=14.25, Balance=0`;
    });

    // 6. Marketing Bulk Campaign + GL Spend + Automation Execution
    await runTest('6. Bulk WhatsApp Campaign with GL Spend & Automation Execution', async () => {
      const mkt = await admin.request('GET', '/api/smart-ops/marketing');
      const ruleId = mkt.json.automationRules[0].id;
      const runRes = await admin.request('POST', `/api/smart-ops/marketing/rules/${ruleId}/run`);
      assert.equal(runRes.status, 200);

      const campRes = await admin.request('POST', '/api/smart-ops/marketing/campaigns', {
        body: {
          name: 'Q2 School Stationery Campaign',
          channel: 'whatsapp',
          audienceSegment: 'all',
          messageBody: 'Hi {{customerName}}, order today from {{companyName}}!',
          budgetAmount: 300,
          actualSpend: 120,
        },
      });
      assert.equal(campRes.status, 201);
      assert.ok(campRes.json.campaign.expenseJournalTxnId > 0);
      await assertJournalBalanced(campRes.json.campaign.expenseJournalTxnId);
      return `Recipients=${campRes.json.campaign.recipientCount}, ExpenseJE=#${campRes.json.campaign.expenseJournalTxnId}`;
    });

    // 7. Void Second POS Order & Verify Reversal
    await runTest('7. POS Order Void & Full GL / Inventory Reversal', async () => {
      const catRes = await admin.request('GET', '/api/pos/catalog');
      const svcItem = (catRes.json.items as any[]).find(i => i.itemType === 'printing_service');
      const checkout2 = await admin.request('POST', '/api/pos/checkout', {
        body: {
          lines: [{ itemId: svcItem.id, description: svcItem.name, quantity: 50, unitPrice: 4, isTaxable: true }],
          tenderMode: 'cash',
          amountTendered: 250,
          taxRate: 16,
          idempotencyKey: 'pos-void-test-2',
        },
      });
      assert.equal(checkout2.status, 201);
      assert.equal(checkout2.json.order.changeDue, 18); // Total 232, tendered 250 => change 18

      const voidRes = await admin.request('POST', `/api/pos/orders/${checkout2.json.order.id}/void`, {
        body: { reason: 'Customer changed order' },
      });
      assert.equal(voidRes.status, 200);
      assert.equal(voidRes.json.voided, true);
      await assertJournalBalanced(voidRes.json.reversalJournalId);

      // Verify Trial Balance remains completely balanced after all Smart Ops & POS operations
      const tb = await admin.request('GET', '/api/reports/trial-balance?startDate=2026-01-01&endDate=2026-12-31');
      assert.equal(tb.status, 200);
      assert.equal(tb.json.isBalanced, true, 'Trial Balance unbalanced after Smart Ops & POS suite');
      return `VoidReversalJE=#${voidRes.json.reversalJournalId}, TrialBalance=BALANCED`;
    });

    console.log('\nALL 7 SMART OPERATIONS & POS TESTS PASSED!');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('\n[FATAL TEST FAILURE]', err);
  process.exit(1);
});
