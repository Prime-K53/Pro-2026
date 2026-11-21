import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';

async function main() {
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-customer-center-'));
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
    assert.equal(
      (await request('POST', '/api/auth/login', { identifier: 'admin', password: 'PrintingAdmin#2026' }))
        .status,
      200
    );

    const inventory = await request('GET', '/api/inventory');
    assert.equal(inventory.status, 200);
    const item = inventory.json.items.find((i: any) => i.item_type === 'stationery');

    // 1. Opening balance -> traceable invoice + balanced Dr AR / Cr 3900 journal
    const created = await request('POST', '/api/customers', {
      companyName: 'Upgrade Test Ltd',
      name: 'Upgrade Test',
      email: 'ap@upgrade.test',
      terms: 'Net 30',
      creditLimit: 5000,
      openingBalance: 1000,
      openingBalanceDate: '2026-11-01',
      isTaxExempt: true,
      currencyCode: 'ZMW',
    });
    assert.equal(created.status, 201, created.text);
    const customer = created.json.customer;
    assert.ok(customer.customerCode, 'customer code must be assigned');
    assert.ok(customer.openingBalanceInvoiceId, 'opening invoice must be linked');

    const invoices = await request('GET', `/api/invoices?customerId=${customer.id}`);
    assert.equal(invoices.status, 200);
    const openingInvoice = invoices.json.invoices.find(
      (i: any) => i.id === customer.openingBalanceInvoiceId
    );
    assert.ok(openingInvoice, 'opening invoice must be listed');
    assert.equal(Number(openingInvoice.totalNum), 1000);
    assert.equal(Number(openingInvoice.balanceDueNum), 1000);

    const journal = await request('GET', `/api/journals/${openingInvoice.journalTxnId}`);
    assert.equal(journal.status, 200);
    let debit = 0n;
    let credit = 0n;
    for (const line of journal.json.entry.lines) {
      debit += BigInt(Math.round(Number(line.debit) * 10000));
      credit += BigInt(Math.round(Number(line.credit) * 10000));
    }
    assert.equal(debit, credit, 'opening balance journal must balance');
    assert.ok(debit > 0n);

    let profile = await request('GET', `/api/customers/${customer.id}/credit-profile`);
    assert.equal(profile.status, 200);
    assert.equal(Number(profile.json.profile.exposure), 1000);

    // 2. Tax exemption is only honored with an active permit
    const noPermitInvoice = await request('POST', '/api/invoices', {
      customerId: customer.id,
      invoiceDate: '2026-11-05',
      dueDate: '2026-12-05',
      taxRate: 16,
      lines: [{ itemId: item.id, description: 'No permit yet', quantity: 1, rate: 100, taxable: true }],
    });
    assert.equal(noPermitInvoice.status, 201, noPermitInvoice.text);
    assert.equal(Number(noPermitInvoice.json.invoice.taxAmountNum), 16);
    assert.equal(Number(noPermitInvoice.json.invoice.totalNum), 116);

    const permit = await request('POST', '/api/reseller-permits', {
      customerId: customer.id,
      permitNumber: 'UPGRADE-PERMIT-1',
      state: 'ZM',
      expiresAt: '2027-12-31',
    });
    assert.equal(permit.status, 201, permit.text);

    const permitInvoice = await request('POST', '/api/invoices', {
      customerId: customer.id,
      invoiceDate: '2026-11-06',
      dueDate: '2026-12-06',
      taxRate: 16,
      lines: [{ itemId: item.id, description: 'Valid permit', quantity: 1, rate: 100, taxable: true }],
    });
    assert.equal(permitInvoice.status, 201, permitInvoice.text);
    assert.equal(Number(permitInvoice.json.invoice.taxAmountNum), 0);

    const refreshedCustomers = await request('GET', '/api/customers');
    const refreshed = refreshedCustomers.json.customers.find((c: any) => c.id === customer.id);
    assert.equal(refreshed.taxExemptionValid, true);

    // 3. Unapplied receipt and allocation to a specific invoice
    const payment = await request('POST', '/api/payments', {
      customerId: customer.id,
      paymentDate: '2026-11-10',
      amount: 300,
      paymentMethod: 'Cash',
    });
    assert.equal(payment.status, 201, payment.text);
    const paymentId = payment.json.payment.id;

    let unapplied = await request('GET', `/api/customers/${customer.id}/unapplied-payments`);
    assert.equal(unapplied.status, 200);
    assert.equal(Number(unapplied.json.payments[0].unapplied), 300);

    const allocation = await request('POST', `/api/payments/${paymentId}/allocate`, {
      invoiceId: noPermitInvoice.json.invoice.id,
      amount: 116,
    });
    assert.equal(allocation.status, 201, allocation.text);
    assert.equal(allocation.json.invoiceStatus, 'paid');
    assert.equal(Number(allocation.json.remainingUnapplied), 184);

    profile = await request('GET', `/api/customers/${customer.id}/credit-profile`);
    assert.equal(Number(profile.json.profile.exposure), 916);
    assert.equal(Number(profile.json.profile.unappliedReceipts), 184);

    // 4. Real statement aging net of unapplied cash, archive, and email queue
    const statement = await request(
      'GET',
      `/api/customers/${customer.id}/statement?periodStart=2026-11-01&periodEnd=2026-11-21&saveSnapshot=true`
    );
    assert.equal(statement.status, 200, statement.text);
    assert.equal(Number(statement.json.statement.closingBalance), 916);
    assert.equal(Number(statement.json.statement.aging.total), 916);
    assert.equal(Number(statement.json.statement.aging.unappliedApplied), 184);
    assert.ok(statement.json.statement.statementId);

    const emailed = await request('POST', `/api/customers/${customer.id}/statement/send`, {
      periodStart: '2026-11-01',
      periodEnd: '2026-11-21',
    });
    assert.equal(emailed.status, 202, emailed.text);
    assert.equal(emailed.json.recipient, 'ap@upgrade.test');

    const history = await request('GET', `/api/customers/${customer.id}/statements`);
    assert.equal(history.status, 200);
    assert.ok(history.json.statements.some((s: any) => s.emailedAt));

    // 5. FX revaluation preview/post/idempotency
    const rate = await request('PUT', '/api/fx/rates', {
      fromCurrency: 'USD',
      toCurrency: 'ZMW',
      rateDate: '2026-11-01',
      rate: 18,
    });
    assert.equal(rate.status, 201, rate.text);

    const usdCustomer = await request('POST', '/api/customers', {
      companyName: 'Upgrade USD Ltd',
      name: 'Upgrade USD',
      email: 'ap@upgrade-usd.test',
      terms: 'Net 30',
      currencyCode: 'USD',
    });
    assert.equal(usdCustomer.status, 201, usdCustomer.text);
    const usdInvoice = await request('POST', '/api/invoices', {
      customerId: usdCustomer.json.customer.id,
      invoiceDate: '2026-11-01',
      dueDate: '2027-01-31',
      currencyCode: 'USD',
      exchangeRate: 18,
      taxRate: 0,
      lines: [{ description: 'USD services', quantity: 1, rate: 1000, taxable: false }],
    });
    assert.equal(usdInvoice.status, 201, usdInvoice.text);

    const closingRate = await request('PUT', '/api/fx/rates', {
      fromCurrency: 'USD',
      toCurrency: 'ZMW',
      rateDate: '2026-11-30',
      rate: 19,
    });
    assert.equal(closingRate.status, 201, closingRate.text);

    const preview = await request('GET', '/api/fx-revaluation/preview?asOfDate=2026-11-30');
    assert.equal(preview.status, 200, preview.text);
    assert.equal(Number(preview.json.preview.totalGain), 1000);
    assert.equal(preview.json.preview.invoiceCount, 1);

    const posted = await request('POST', '/api/fx-revaluation', { asOfDate: '2026-11-30' });
    assert.equal(posted.status, 201, posted.text);
    assert.equal(posted.json.posted, true);
    assert.ok(posted.json.journalTransactionId);

    const repost = await request('POST', '/api/fx-revaluation', { asOfDate: '2026-11-30' });
    assert.equal(repost.status, 409);

    const previewAgain = await request('GET', '/api/fx-revaluation/preview?asOfDate=2026-11-30');
    assert.equal(Number(previewAgain.json.preview.totalGain), 0);

    const runs = await request('GET', '/api/fx-revaluation/runs');
    assert.equal(runs.status, 200);
    assert.equal(Number(runs.json.runs[0].totalGain), 1000);

    console.log('Customer Center upgrade verification: PASS');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('Customer Center upgrade verification: FAIL');
  console.error(err);
  process.exit(1);
});
