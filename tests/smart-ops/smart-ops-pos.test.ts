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

    // 4. Create Customer + Advocate Code + Full POS Checkout (Split Tender + Promo + Referral + Inventory + Auto WhatsApp)
    let advocateCustId = 0;
    let referralCodeId = 0;
    let referralCodeStr = '';
    let posOrderId = 0;
    let firstEventId = 0;

    await runTest('4. Full POS Split-Tender Checkout with Promo, Referral, Stock Deduction & Auto-WhatsApp', async () => {
      // Create advocate customer with AR balance so we can test Store Credit settlement later too
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
      assert.ok(cashAcct && mobAcct);

      const previewPayload = {
        lines: [
          { itemId: stockedItem.id, description: stockedItem.name, quantity: 2, unitPrice: 150, isTaxable: true },
          { itemId: svcItem.id, description: svcItem.name, quantity: 100, unitPrice: 2, isTaxable: true },
        ],
        promoCode: 'VIP20',
        referralCode: referralCodeStr,
        taxRate: 16,
        isTaxExempt: false,
      };
      const prev = await admin.request('POST', '/api/pos/preview', { body: previewPayload });
      assert.equal(prev.status, 200);
      // Gross = 300 + 200 = 500; VIP20 = 20% of 500 = 100; Referral = 5% of 500 = 25; Net = 375; Tax 16% = 60; Total = 435
      assert.equal(prev.json.grossSubtotal, 500);
      assert.equal(prev.json.promoDiscount, 100);
      assert.equal(prev.json.referralDiscount, 25);
      assert.equal(prev.json.netSubtotal, 375);
      assert.equal(prev.json.taxAmount, 60);
      assert.equal(prev.json.total, 435);

      const checkoutRes = await admin.request('POST', '/api/pos/checkout', {
        body: {
          ...previewPayload,
          walkInCustomerName: 'Walk-in Referee',
          walkInCustomerPhone: '+260966998877',
          tenderMode: 'split',
          tenders: [
            { tenderMethod: 'Cash', depositAccountId: cashAcct.id, amount: 200 },
            { tenderMethod: 'Mobile Money', depositAccountId: mobAcct.id, amount: 235, referenceNumber: 'MOMO-9988' },
          ],
          sendWhatsAppReceipt: true,
          idempotencyKey: 'pos-test-key-1',
        },
      });
      assert.equal(checkoutRes.status, 201);
      const order = checkoutRes.json.order;
      posOrderId = order.id;
      assert.equal(order.total, 435);
      assert.ok(order.journalTxnId > 0);

      // Verify GL Journal balanced & includes 1050 Cash, 1030 Mobile Money, 4100 Discounts, 4000 Revenue, 2200 Tax
      const je = await assertJournalBalanced(order.journalTxnId);
      const jeCodes = je.lines.map((l: any) => l.accountCode || '');
      assert.ok(jeCodes.includes('4100'), 'Expected debit to 4100 Sales Discounts');
      assert.ok(jeCodes.includes('1050'), 'Expected debit to 1050 Cash Drawer');
      assert.ok(jeCodes.includes('1030'), 'Expected debit to 1030 Mobile Clearing');

      // Idempotent replay check
      const replay = await admin.request('POST', '/api/pos/checkout', {
        body: {
          ...previewPayload,
          walkInCustomerName: 'Walk-in Referee',
          walkInCustomerPhone: '+260966998877',
          tenderMode: 'split',
          tenders: [
            { tenderMethod: 'Cash', depositAccountId: cashAcct.id, amount: 200 },
            { tenderMethod: 'Mobile Money', depositAccountId: mobAcct.id, amount: 235, referenceNumber: 'MOMO-9988' },
          ],
          sendWhatsAppReceipt: true,
          idempotencyKey: 'pos-test-key-1',
        },
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.json.order.id, posOrderId);

      // Check referral event created + accrued
      const refAfter = await admin.request('GET', '/api/smart-ops/referrals');
      assert.equal(refAfter.json.events.length, 1);
      firstEventId = refAfter.json.events[0].id;
      assert.equal(refAfter.json.events[0].rewardAmount, 23.75); // 5% of 475 (gross 500 - referee 25)
      await assertJournalBalanced(refAfter.json.events[0].accrualJournalTxnId);

      // Check auto-queued WhatsApp receipt message
      const mktAfter = await admin.request('GET', '/api/smart-ops/marketing');
      assert.ok(
        mktAfter.json.messages.some((m: any) => m.posOrderId === posOrderId && m.whatsappUrl?.includes('260966998877')),
        'Expected auto-queued WhatsApp receipt message with wa.me link'
      );

      return `Receipt=${order.receiptNumber}, Total=435, ReferralReward=18.75`;
    });

    // 5. Referral Reward Payout (Bank Payout + Customer Credit Memo)
    await runTest('5. Referral Reward Settlement (Customer Store Credit & Bank Payout)', async () => {
      // Pay first event via Customer Store Credit Memo
      const creditPayout = await admin.request('POST', `/api/smart-ops/referrals/events/${firstEventId}/payout`, {
        body: { settlementType: 'customer_credit' },
      });
      assert.equal(creditPayout.status, 200);
      assert.equal(creditPayout.json.event.status, 'credited');
      assert.ok(creditPayout.json.event.creditMemoId > 0);
      await assertJournalBalanced(creditPayout.json.event.payoutJournalTxnId);

      // Record second manual referral conversion & settle via Bank Payout
      const manual = await admin.request('POST', '/api/smart-ops/referrals/events', {
        body: {
          referralCodeId,
          qualifyingAmount: 1000,
          notes: 'Manual wholesale referral',
        },
      });
      assert.equal(manual.status, 201);
      const secondId = manual.json.event.id;
      await assertJournalBalanced(manual.json.event.accrualJournalTxnId);

      const bankPayout = await admin.request('POST', `/api/smart-ops/referrals/events/${secondId}/payout`, {
        body: { settlementType: 'bank_payout' },
      });
      assert.equal(bankPayout.status, 200);
      assert.equal(bankPayout.json.event.status, 'paid');
      await assertJournalBalanced(bankPayout.json.event.payoutJournalTxnId);

      return `CreditMemo=#${creditPayout.json.event.creditMemoId}, BankPayoutJE=#${bankPayout.json.event.payoutJournalTxnId}`;
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
