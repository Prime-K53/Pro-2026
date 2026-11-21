import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';

async function main() {
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-vendor-center-'));
  const cfg = {
    ...loadServerConfig(),
    nodeEnv: 'test',
    isProduction: false,
    attachmentsDir: tmpAttachDir,
  };
  const db = await createServerDatabase(cfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  let cookie = '';

  async function request(method: string, pathname: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  try {
    const login = await request('POST', '/api/auth/login', {
      identifier: 'admin',
      password: 'PrintingAdmin#2026',
    });
    assert.equal(login.status, 200, login.text);

    const accounts = await request('GET', '/api/accounts');
    assert.equal(accounts.status, 200, accounts.text);
    const accountByCode = new Map<string, any>(
      accounts.json.accounts.map((a: any) => [String(a.code), a])
    );
    const expenseAccount = accountByCode.get('6200') || accountByCode.get('5000');
    assert.ok(expenseAccount, 'an expense account is required');
    const bankAccount = accountByCode.get('1010');
    assert.ok(bankAccount, 'a bank account is required');

    // 1. Supplier onboarding: code, opening bill, balanced Dr 3900 / Cr AP journal
    const created = await request('POST', '/api/vendors', {
      companyName: 'Upgrade Supplier Ltd',
      name: 'Upgrade Supplier',
      email: 'ap@supplier-upgrade.test',
      phone: '+260 900 000 001',
      address: '1 Supplier Road, Lusaka',
      taxId: 'SUP-TPIN-001',
      terms: 'Net 30',
      openingBalance: 750,
      openingBalanceDate: '2026-11-01',
      currencyCode: 'ZMW',
      vendorCategory: 'goods',
      isPreferred: true,
      notes: 'Opening balance captured during migration',
      bankName: 'Zanaco',
      bankAccountName: 'Upgrade Supplier Ltd',
      bankAccountNumber: '0123456789',
      bankBranch: 'Lusaka Main',
    });
    assert.equal(created.status, 201, created.text);
    const vendor = created.json.vendor;
    assert.match(vendor.vendorCode, /^SUP-\d{6}$/, 'supplier code must be auto-assigned');
    assert.ok(vendor.openingBalanceBillId, 'opening bill must be linked');
    assert.equal(vendor.status, 'active');
    assert.equal(vendor.vendorCategory, 'goods');
    assert.equal(vendor.isPreferred, true);

    const bills = await request('GET', `/api/bills?vendorId=${vendor.id}`);
    assert.equal(bills.status, 200, bills.text);
    const openingBill = bills.json.bills.find((b: any) => b.id === vendor.openingBalanceBillId);
    assert.ok(openingBill, 'opening bill must be listed');
    assert.equal(openingBill.total, 750);
    assert.equal(openingBill.balanceDue, 750);
    assert.ok(openingBill.journalTxnId);

    const journal = await request('GET', `/api/journals/${openingBill.journalTxnId}`);
    assert.equal(journal.status, 200, journal.text);
    let debit = 0n;
    let credit = 0n;
    for (const line of journal.json.entry.lines) {
      debit += BigInt(Math.round(Number(line.debit) * 10000));
      credit += BigInt(Math.round(Number(line.credit) * 10000));
    }
    assert.equal(debit, credit, 'opening supplier journal must balance');
    assert.ok(debit > 0n);

    let profile = await request('GET', `/api/vendors/${vendor.id}/ap-profile`);
    assert.equal(profile.status, 200, profile.text);
    assert.equal(profile.json.profile.exposure.netExposure, 750);
    assert.equal(profile.json.profile.exposure.openBillBalance, 750);
    assert.equal(profile.json.profile.counts.openBills, 1);
    assert.equal(profile.json.profile.bankAccountNumber, '0123456789');

    // 2. On-hold suppliers may still be billed, but payments are blocked
    const held = await request('PATCH', `/api/vendors/${vendor.id}`, { status: 'on_hold' });
    assert.equal(held.status, 200, held.text);
    assert.equal(held.json.vendor.status, 'on_hold');

    const bill = await request('POST', '/api/bills', {
      vendorId: vendor.id,
      billNumber: 'BILL-UPG-001',
      billDate: '2026-11-05',
      dueDate: '2026-12-05',
      lines: [
        {
          accountId: expenseAccount.id,
          description: 'Upgrade supplier consumables',
          quantity: 1,
          unitCost: 200,
        },
      ],
    });
    assert.equal(bill.status, 201, bill.text);
    const billId = bill.json.bill.id;

    const blockedPayment = await request('POST', '/api/bill-payments', {
      vendorId: vendor.id,
      paymentDate: '2026-11-10',
      bankAccountId: bankAccount.id,
      allocations: [{ billId, amount: 300 }],
    });
    assert.equal(blockedPayment.status, 409, blockedPayment.text);
    assert.equal(blockedPayment.json.code, 'VENDOR_PAYMENT_BLOCKED');

    const released = await request('PATCH', `/api/vendors/${vendor.id}`, { status: 'active' });
    assert.equal(released.status, 200, released.text);

    // 3. Payment and unapplied vendor credit net against AP exposure and aging
    const payment = await request('POST', '/api/bill-payments', {
      vendorId: vendor.id,
      paymentDate: '2026-11-10',
      bankAccountId: bankAccount.id,
      allocations: [{ billId, amount: 200 }],
    });
    assert.equal(payment.status, 201, payment.text);
    assert.ok(payment.json.billPayment.journalTxnId);

    const vendorCredit = await request('POST', '/api/vendor-credits', {
      vendorId: vendor.id,
      creditDate: '2026-11-12',
      memo: 'Unapplied supplier rebate',
      lines: [
        {
          accountId: expenseAccount.id,
          description: 'Rebate credit',
          quantity: 1,
          rate: 100,
        },
      ],
    });
    assert.equal(vendorCredit.status, 201, vendorCredit.text);

    profile = await request('GET', `/api/vendors/${vendor.id}/ap-profile`);
    assert.equal(profile.status, 200, profile.text);
    assert.equal(profile.json.profile.exposure.openBillBalance, 750);
    assert.equal(profile.json.profile.exposure.unappliedVendorCredits, 100);
    assert.equal(profile.json.profile.exposure.netExposure, 650);
    assert.equal(profile.json.profile.aging.total, 650);

    const agingReport = await request('GET', '/api/reports/ap-aging?asOfDate=2026-11-21');
    assert.equal(agingReport.status, 200, agingReport.text);
    const agedVendor = agingReport.json.report.vendors.find(
      (v: any) => v.vendorId === vendor.id
    );
    assert.ok(agedVendor, 'supplier must appear in AP aging');
    assert.equal(agedVendor.total, 650);
    assert.equal(agedVendor.unappliedCredit, 0);

    // 4. Statement snapshot, statement email queue, and archived history
    const statement = await request(
      'GET',
      `/api/vendors/${vendor.id}/statement?periodStart=2026-11-01&periodEnd=2026-11-21&saveSnapshot=true`
    );
    assert.equal(statement.status, 200, statement.text);
    assert.equal(statement.json.statement.openingBalance, 0);
    assert.equal(statement.json.statement.closingBalance, 650);
    assert.equal(statement.json.statement.aging.total, 650);
    assert.ok(statement.json.statement.statementId);

    const emailed = await request('POST', `/api/vendors/${vendor.id}/statement/send`, {
      periodStart: '2026-11-01',
      periodEnd: '2026-11-21',
    });
    assert.equal(emailed.status, 202, emailed.text);
    assert.equal(emailed.json.recipient, 'ap@supplier-upgrade.test');

    const history = await request('GET', `/api/vendors/${vendor.id}/statements`);
    assert.equal(history.status, 200, history.text);
    assert.ok(history.json.statements.length >= 2);
    assert.ok(history.json.statements.some((s: any) => s.emailedAt));

    const snapshot = await request(
      'GET',
      `/api/vendors/${vendor.id}/statements/${statement.json.statement.statementId}`
    );
    assert.equal(snapshot.status, 200, snapshot.text);
    assert.equal(snapshot.json.statement.closingBalance, 650);

    // 5. Blocked supplier cannot bill; currency is locked after AP activity
    const blocked = await request('PATCH', `/api/vendors/${vendor.id}`, { status: 'blocked' });
    assert.equal(blocked.status, 200, blocked.text);

    const blockedBill = await request('POST', '/api/bills', {
      vendorId: vendor.id,
      billNumber: 'BILL-UPG-002',
      billDate: '2026-11-15',
      lines: [
        {
          accountId: expenseAccount.id,
          description: 'Blocked supplier bill',
          quantity: 1,
          unitCost: 50,
        },
      ],
    });
    assert.equal(blockedBill.status, 409, blockedBill.text);
    assert.equal(blockedBill.json.code, 'VENDOR_NOT_BILLABLE');

    const currencyChange = await request('PATCH', `/api/vendors/${vendor.id}`, {
      currencyCode: 'USD',
    });
    assert.equal(currencyChange.status, 409, currencyChange.text);
    assert.equal(currencyChange.json.code, 'VENDOR_CURRENCY_IN_USE');

    const duplicate = await request('POST', '/api/vendors', {
      companyName: 'Upgrade Supplier Ltd',
      name: 'Upgrade Supplier',
      email: 'ap@supplier-upgrade.test',
    });
    assert.equal(duplicate.status, 409, duplicate.text);
    assert.equal(duplicate.json.code, 'DUPLICATE_VENDOR');

    console.log('Vendor & Supplier Center upgrade verification: PASS');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
