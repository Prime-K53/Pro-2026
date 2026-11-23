import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import { recordReferralAttribution } from '../../src/server/services/referralAttributionService.ts';
import { createInvoiceOrSalesReceipt } from '../../src/server/services/salesService.ts';
import { applyWalletToInvoice } from '../../src/server/services/customerWalletService.ts';
import { reverseReferralReward } from '../../src/server/services/referralReversalService.ts';

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
  console.log('=== Prime ERP Referral Management — Phase 1 Verification Suite ===\n');

  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-referral-test-'));
  const baseCfg = loadServerConfig();
  const db: ServerDatabase = await createServerDatabase(
    { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir },
    { inMemory: true, seedDemo: true }
  );
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const admin = new CookieHttpClient(baseUrl);
  let userId = 1;
  let companyId = 1;
  let advocateId = 0;

  const actor: ActorContext = { userId, username: 'admin', role: 'Administrator' };

  const cat = async () => {
    const r = await admin.request('GET', '/api/pos/catalog');
    assert.equal(r.status, 200);
    return r.json;
  };
  const cashAcct = (c: any) => c.depositAccounts.find((a: any) => a.code === '1050').id;

  const walletBalance = async (customerId: number): Promise<number> => {
    const r = await admin.request('GET', `/api/wallets?customerId=${customerId}`);
    assert.equal(r.status, 200);
    return r.json.wallets[0]?.balance ?? 0;
  };

  try {
    const login = await admin.request('POST', '/api/auth/login', {
      body: { identifier: 'admin', password: 'PrintingAdmin#2026' },
    });
    assert.equal(login.status, 200);
    userId = login.json.user.id;
    companyId = login.json.activeCompany.id;
    Object.assign(actor, { userId });

    const init = await admin.request('POST', '/api/smart-ops/initialize-accounts', { body: {} });
    assert.equal(init.status, 200);

    await runTest('1. Campaign activation gate (config + Finance + Management)', async () => {
      const prog = await admin.request('POST', '/api/smart-ops/referrals/programs', {
        body: { name: 'Gate Test Program', referrerRewardType: 'percent_commission', referrerRewardValue: 3, refereeDiscountType: 'percent', refereeDiscountValue: 5 },
      });
      assert.equal(prog.status, 201);
      const programId = prog.json.program.id;

      const camp = await admin.request('POST', '/api/smart-ops/referrals/campaigns', {
        body: { programId, name: 'Gate Test Campaign', channel: 'whatsapp', trackingCode: 'GATE1', budgetAmount: 500 },
      });
      assert.equal(camp.status, 201);
      const campaignId = camp.json.campaign.id;

      const a1 = await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/activate`, { body: {} });
      assert.equal(a1.status, 409, `expected incomplete-config block, got ${a1.status}`);

      const cfg = await admin.request('PATCH', `/api/smart-ops/referrals/campaigns/${campaignId}/config`, {
        body: {
          referrerRewardType: 'percent_commission',
          referrerRewardValue: 3,
          refereeDiscountType: 'percent',
          refereeDiscountValue: 5,
          maxReferrerRewardPerOrder: 100,
          maxRefereeDiscountPerOrder: 100,
          rewardApprovalThreshold: 250,
          eligibleItemTypes: ['stationery', 'printing_service'],
          attributionWindowDays: 90,
          startsAt: '2026-01-01',
          endsAt: '2027-12-31',
        },
      });
      assert.equal(cfg.status, 200);

      const a2 = await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/activate`, { body: {} });
      assert.equal(a2.status, 409, 'finance approval should block activation');

      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/finance-approval`, { body: {} });
      const a3 = await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/activate`, { body: {} });
      assert.equal(a3.status, 409, 'management approval should block activation');

      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/management-approval`, { body: {} });
      const a4 = await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/activate`, { body: {} });
      assert.equal(a4.status, 200);
      assert.equal(a4.json.terms.lifecycleStatus, 'active');
      return 'config→finance→management→activate enforced';
    });

    await runTest('2. Campaign-specific rates (no hardcoded 5%/3% fallback)', async () => {
      const prog = await admin.request('POST', '/api/smart-ops/referrals/programs', {
        body: { name: 'Rate Test Program', referrerRewardType: 'percent_commission', referrerRewardValue: 10, refereeDiscountType: 'percent', refereeDiscountValue: 7 },
      });
      const programId = prog.json.program.id;
      const camp = await admin.request('POST', '/api/smart-ops/referrals/campaigns', {
        body: {
          programId,
          name: 'Rate Test Campaign',
          channel: 'whatsapp',
          trackingCode: 'RATE7',
          budgetAmount: 1000,
          referrerRewardType: 'percent_commission',
          referrerRewardValue: 10,
          refereeDiscountType: 'percent',
          refereeDiscountValue: 7,
          maxReferrerRewardPerOrder: 100,
          maxRefereeDiscountPerOrder: 100,
          rewardApprovalThreshold: 250,
          eligibleItemTypes: ['stationery', 'printing_service'],
          attributionWindowDays: 90,
          startsAt: '2026-01-01',
          endsAt: '2027-12-31',
        },
      });
      const campaignId = camp.json.campaign.id;
      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/finance-approval`, { body: {} });
      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/management-approval`, { body: {} });
      const act = await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/activate`, { body: {} });
      assert.equal(act.status, 200);

      const cust = await admin.request('POST', '/api/customers', {
        body: { name: 'Rate Advocate', companyName: 'Rate Advocate', customerType: 'individual', phone: '+260970000001', terms: 'Due on Receipt' },
      });
      const referrerId = cust.json.customer.id;

      const code = await admin.request('POST', '/api/smart-ops/referrals/codes', {
        body: { programId, referrerCustomerId: referrerId, referrerName: 'Rate Advocate', code: 'RATE7CODE' },
      });
      assert.equal(code.status, 201);

      const c = await cat();
      const stationery = c.items.find((i: any) => i.itemType === 'stationery');
      const svc = c.items.find((i: any) => i.itemType === 'printing_service');
      const prev = await admin.request('POST', '/api/pos/preview', {
        body: {
          lines: [
            { itemId: stationery.id, description: stationery.name, quantity: 2, unitPrice: 150, isTaxable: true },
            { itemId: svc.id, description: svc.name, quantity: 100, unitPrice: 2, isTaxable: true },
          ],
          referralCode: 'RATE7CODE',
          taxRate: 0,
        },
      });
      assert.equal(prev.status, 200);
      assert.equal(prev.json.referralDiscount, 35, '7% of 500');
      assert.equal(prev.json.referralApplied.rewardAmount, 46.5, '10% of 465');
      return 'referee 7% / referrer 10% honoured from campaign config';
    });

    await runTest('3. Verbal referral capture + first-valid lock + self-referral guard', async () => {
      // Advocate customer who owns a referral code (T3-A: codes are customer-owned).
      const adv = await admin.request('POST', '/api/customers', {
        body: { name: 'Verbal Advocate', companyName: 'Verbal Advocate', customerType: 'individual', phone: '+260970000002', terms: 'Due on Receipt' },
      });
      advocateId = adv.json.customer.id;

      const refData = await admin.request('GET', '/api/smart-ops/referrals');
      const starterProgramId = refData.json.programs[0].id;
      const code = await admin.request('POST', '/api/smart-ops/referrals/codes', {
        body: { programId: starterProgramId, referrerCustomerId: advocateId, referrerName: 'Verbal Advocate', code: 'VERBADV' },
      });
      assert.equal(code.status, 201);

      const referred = await admin.request('POST', '/api/customers', {
        body: {
          name: 'Verbal Referee',
          companyName: 'Verbal Referee',
          customerType: 'individual',
          phone: '+260970000003',
          terms: 'Due on Receipt',
          referredByCustomerId: advocateId,
        },
      });
      assert.equal(referred.status, 201);
      const refereeId = referred.json.customer.id;

      const attrs = await admin.request('GET', '/api/smart-ops/referrals/attributions');
      const row = attrs.json.attributions.find((a: any) => a.customer_id === refereeId);
      assert.ok(row, 'verbal attribution recorded');
      assert.equal(row.method, 'verbal');
      assert.equal(Number(row.attributed_by), userId);

      // First-valid lock: a second attribution for the same referee must fail.
      let locked = false;
      try {
        await db.withCompanyDb(companyId, tx =>
          recordReferralAttribution(tx, companyId, actor, {
            customerId: refereeId,
            referrerCustomerId: advocateId,
            method: 'verbal',
            sourceContext: 'test',
          })
        );
      } catch (err: any) {
        locked = err?.code === 'REFERRAL_ALREADY_ATTRIBUTED';
      }
      assert.ok(locked, 'first-valid attribution is locked');

      // Self-referral guard.
      let selfBlocked = false;
      try {
        await db.withCompanyDb(companyId, tx =>
          recordReferralAttribution(tx, companyId, actor, {
            customerId: advocateId,
            referrerCustomerId: advocateId,
            method: 'verbal',
            sourceContext: 'test',
          })
        );
      } catch (err: any) {
        selfBlocked = err?.code === 'REFERRAL_SELF_REFERRAL';
      }
      assert.ok(selfBlocked, 'self-referral blocked');
      return 'verbal attribution + first-valid lock + self-referral guard';
    });

    await runTest('4. Budget exhaustion rejects new attributions (no overspend)', async () => {
      const prog = await admin.request('POST', '/api/smart-ops/referrals/programs', {
        body: { name: 'Budget Test Program', referrerRewardType: 'percent_commission', referrerRewardValue: 3, refereeDiscountType: 'percent', refereeDiscountValue: 5 },
      });
      const programId = prog.json.program.id;
      const camp = await admin.request('POST', '/api/smart-ops/referrals/campaigns', {
        body: {
          programId,
          name: 'Budget Test Campaign',
          channel: 'whatsapp',
          trackingCode: 'BUD20',
          budgetAmount: 20,
          referrerRewardType: 'percent_commission',
          referrerRewardValue: 3,
          refereeDiscountType: 'percent',
          refereeDiscountValue: 5,
          maxReferrerRewardPerOrder: 100,
          maxRefereeDiscountPerOrder: 100,
          rewardApprovalThreshold: 250,
          eligibleItemTypes: ['stationery', 'printing_service'],
          attributionWindowDays: 90,
          startsAt: '2026-01-01',
          endsAt: '2027-12-31',
        },
      });
      const campaignId = camp.json.campaign.id;
      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/finance-approval`, { body: {} });
      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/management-approval`, { body: {} });
      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/activate`, { body: {} });

      const code = await admin.request('POST', '/api/smart-ops/referrals/codes', {
        body: { programId, referrerCustomerId: advocateId, referrerName: 'Verbal Advocate', code: 'BUD20CODE' },
      });
      assert.equal(code.status, 201);

      const c = await cat();
      const stationery = c.items.find((i: any) => i.itemType === 'stationery');
      const svc = c.items.find((i: any) => i.itemType === 'printing_service');
      const cash = cashAcct(c);
      const lines = [
        { itemId: stationery.id, description: stationery.name, quantity: 2, unitPrice: 150, isTaxable: true },
        { itemId: svc.id, description: svc.name, quantity: 100, unitPrice: 2, isTaxable: true },
      ];

      const o1 = await admin.request('POST', '/api/pos/checkout', {
        body: { lines, walkInCustomerName: 'Budget Referee One', walkInCustomerPhone: '+260971000001', referralCode: 'BUD20CODE', taxRate: 0, tenderMode: 'cash', amountTendered: 551, idempotencyKey: 'budget-1' },
      });
      assert.equal(o1.status, 201, `first order should reserve: ${JSON.stringify(o1.json)}`);

      const o2 = await admin.request('POST', '/api/pos/checkout', {
        body: { lines, walkInCustomerName: 'Budget Referee Two', walkInCustomerPhone: '+260971000002', referralCode: 'BUD20CODE', taxRate: 0, tenderMode: 'cash', amountTendered: 551, idempotencyKey: 'budget-2' },
      });
      assert.equal(o2.status, 409, 'second order should be rejected on budget exhaustion');
      assert.equal(o2.json.code, 'REFERRAL_BUDGET_EXHAUSTED');
      return 'budget 20 → first reserves 14.25, second rejected (no overspend)';
    });

    await runTest('5. Negative wallet recovery (D-03-A) + ordinary spend blocked', async () => {
      const prog = await admin.request('POST', '/api/smart-ops/referrals/programs', {
        body: { name: 'Recovery Test Program', referrerRewardType: 'percent_commission', referrerRewardValue: 3, refereeDiscountType: 'percent', refereeDiscountValue: 5 },
      });
      const programId = prog.json.program.id;
      const camp = await admin.request('POST', '/api/smart-ops/referrals/campaigns', {
        body: {
          programId,
          name: 'Recovery Test Campaign',
          channel: 'whatsapp',
          trackingCode: 'REC1',
          budgetAmount: 1000,
          referrerRewardType: 'percent_commission',
          referrerRewardValue: 3,
          refereeDiscountType: 'percent',
          refereeDiscountValue: 5,
          maxReferrerRewardPerOrder: 100,
          maxRefereeDiscountPerOrder: 100,
          rewardApprovalThreshold: 250,
          eligibleItemTypes: ['stationery', 'printing_service'],
          attributionWindowDays: 90,
          startsAt: '2026-01-01',
          endsAt: '2027-12-31',
        },
      });
      const campaignId = camp.json.campaign.id;
      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/finance-approval`, { body: {} });
      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/management-approval`, { body: {} });
      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/activate`, { body: {} });

      const code = await admin.request('POST', '/api/smart-ops/referrals/codes', {
        body: { programId, referrerCustomerId: advocateId, referrerName: 'Verbal Advocate', code: 'REC1CODE' },
      });
      assert.equal(code.status, 201);

      const c = await cat();
      const stationery = c.items.find((i: any) => i.itemType === 'stationery');
      const svc = c.items.find((i: any) => i.itemType === 'printing_service');
      const cash = cashAcct(c);
      const lines = [
        { itemId: stationery.id, description: stationery.name, quantity: 2, unitPrice: 150, isTaxable: true },
        { itemId: svc.id, description: svc.name, quantity: 100, unitPrice: 2, isTaxable: true },
      ];
      const order = await admin.request('POST', '/api/pos/checkout', {
        body: { lines, walkInCustomerName: 'Recovery Referee', walkInCustomerPhone: '+260972000001', referralCode: 'REC1CODE', taxRate: 0, tenderMode: 'cash', amountTendered: 551, idempotencyKey: 'rec-1' },
      });
      assert.equal(order.status, 201);
      const posOrderId = order.json.order.id;

      const refData = await admin.request('GET', '/api/smart-ops/referrals');
      const ev = refData.json.events.find((e: any) => e.posOrderId === posOrderId);
      const eventId = ev.id;

      const q = await admin.request('POST', `/api/smart-ops/referrals/events/${eventId}/qualify`, { body: {} });
      assert.equal(q.status, 200);
      const credit = q.json.credit;
      assert.ok(credit && credit.walletTxnId > 0, 'reward credited to wallet');
      const reward = 14.25;
      assert.ok(Math.abs((await walletBalance(advocateId)) - reward) < 0.001);

      // Spend 10 of the wallet via an invoice payment.
      const inv = await db.withCompanyDb(companyId, tx =>
        createInvoiceOrSalesReceipt(tx, companyId, actor, {
          customerId: advocateId,
          lines: [{ description: 'Recovery spend invoice', quantity: 1, rate: 10 }],
          idempotencyKey: 'rec-inv-1',
        })
      );
      const invoiceId = Number(inv.invoice.id);
      await db.withCompanyDb(companyId, tx =>
        applyWalletToInvoice(tx, companyId, actor, { customerId: advocateId, invoiceId, amount: '10', idempotencyKey: 'rec-pay-1' })
      );
      assert.ok(Math.abs((await walletBalance(advocateId)) - 4.25) < 0.001, 'wallet after spending 10 = 4.25');

      // Reverse the full reward → wallet goes negative by the spent 10.
      const rev = await db.withCompanyDb(companyId, tx =>
        reverseReferralReward(tx, companyId, actor, { eventId, reason: 'Full refund' })
      );
      assert.ok(Math.abs(rev.negativeBalance - 10) < 0.001, `negative balance ${rev.negativeBalance}`);
      assert.ok(Math.abs((await walletBalance(advocateId)) - -10) < 0.001, 'wallet is -10');

      // Ordinary spending must be blocked at a negative balance.
      const inv2 = await db.withCompanyDb(companyId, tx =>
        createInvoiceOrSalesReceipt(tx, companyId, actor, {
          customerId: advocateId,
          lines: [{ description: 'Blocked spend invoice', quantity: 1, rate: 1 }],
          idempotencyKey: 'rec-inv-2',
        })
      );
      let blocked = false;
      try {
        await db.withCompanyDb(companyId, tx =>
          applyWalletToInvoice(tx, companyId, actor, { customerId: advocateId, invoiceId: Number(inv2.invoice.id), amount: '1', idempotencyKey: 'rec-pay-2' })
        );
      } catch (err: any) {
        blocked = err?.code === 'INSUFFICIENT_WALLET_FUNDS' || err?.code === 'WALLET_INSUFFICIENT_FUNDS';
      }
      assert.ok(blocked, 'ordinary spending blocked at negative balance');
      return 'reward spent → reversed to -10, ordinary spend blocked';
    });

    await runTest('6. Reward approval threshold (A1-C) blocks credit until approved', async () => {
      const prog = await admin.request('POST', '/api/smart-ops/referrals/programs', {
        body: { name: 'Threshold Program', referrerRewardType: 'percent_commission', referrerRewardValue: 3, refereeDiscountType: 'percent', refereeDiscountValue: 5 },
      });
      const programId = prog.json.program.id;
      const camp = await admin.request('POST', '/api/smart-ops/referrals/campaigns', {
        body: {
          programId,
          name: 'Threshold Campaign',
          channel: 'whatsapp',
          trackingCode: 'THR10',
          budgetAmount: 1000,
          referrerRewardType: 'percent_commission',
          referrerRewardValue: 3,
          refereeDiscountType: 'percent',
          refereeDiscountValue: 5,
          maxReferrerRewardPerOrder: 100,
          maxRefereeDiscountPerOrder: 100,
          rewardApprovalThreshold: 10,
          eligibleItemTypes: ['stationery', 'printing_service'],
          attributionWindowDays: 90,
          startsAt: '2026-01-01',
          endsAt: '2027-12-31',
        },
      });
      const campaignId = camp.json.campaign.id;
      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/finance-approval`, { body: {} });
      await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/management-approval`, { body: {} });
      const act = await admin.request('POST', `/api/smart-ops/referrals/campaigns/${campaignId}/activate`, { body: {} });
      assert.equal(act.status, 200);

      const referrer = await admin.request('POST', '/api/customers', {
        body: { name: 'Threshold Advocate', companyName: 'Threshold Advocate', customerType: 'individual', phone: '+260973000001', terms: 'Due on Receipt' },
      });
      const referrerId = referrer.json.customer.id;
      const code = await admin.request('POST', '/api/smart-ops/referrals/codes', {
        body: { programId, referrerCustomerId: referrerId, referrerName: 'Threshold Advocate', code: 'THR10CODE' },
      });
      assert.equal(code.status, 201);

      const c = await cat();
      const stationery = c.items.find((i: any) => i.itemType === 'stationery');
      const svc = c.items.find((i: any) => i.itemType === 'printing_service');
      const cash = cashAcct(c);
      const order = await admin.request('POST', '/api/pos/checkout', {
        body: {
          lines: [
            { itemId: stationery.id, description: stationery.name, quantity: 2, unitPrice: 150, isTaxable: true },
            { itemId: svc.id, description: svc.name, quantity: 100, unitPrice: 2, isTaxable: true },
          ],
          walkInCustomerName: 'Threshold Referee',
          walkInCustomerPhone: '+260973000002',
          referralCode: 'THR10CODE',
          taxRate: 0,
          tenderMode: 'cash',
          amountTendered: 551,
          idempotencyKey: 'thr-1',
        },
      });
      assert.equal(order.status, 201);
      const posOrderId = order.json.order.id;
      const refData = await admin.request('GET', '/api/smart-ops/referrals');
      const eventId = refData.json.events.find((e: any) => e.posOrderId === posOrderId).id;

      const q = await admin.request('POST', `/api/smart-ops/referrals/events/${eventId}/qualify`, { body: {} });
      assert.equal(q.status, 200);
      assert.equal(q.json.credit, null, 'at/above threshold must NOT auto-credit');
      assert.equal(q.json.qualified.status, 'approved');
      assert.ok(q.json.qualified.rewardAmount >= 10);

      // Credit before approval must be rejected.
      const early = await admin.request('POST', `/api/smart-ops/referrals/events/${eventId}/credit`, { body: {} });
      assert.equal(early.status, 409, 'credit blocked before approval');

      // Record an authorised approval (approver = admin) and retry.
      await db.withCompanyDb(companyId, tx =>
        tx.query(
          `UPDATE approval_requests SET status = 'approved', decided_by = $2, decided_at = NOW()
             WHERE company_id = $1 AND action_type = 'referral_reward_approval' AND entity_id = $3`,
          [companyId, userId, eventId]
        )
      );
      const cred = await admin.request('POST', `/api/smart-ops/referrals/events/${eventId}/credit`, { body: {} });
      assert.equal(cred.status, 200, `credit after approval: ${JSON.stringify(cred.json)}`);
      assert.equal(cred.json.status, 'credited');
      assert.ok(cred.json.walletTxnId > 0);
      return 'above-threshold reward blocked until approved, then credited to wallet';
    });

    console.log('\nALL REFERRAL PHASE 1 TESTS PASSED!');
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