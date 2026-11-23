import assert from 'node:assert/strict';
import http from 'node:http';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';

class CookieHttpClient {
  public cookie = '';
  constructor(private baseUrl: string) {}
  async request(method: string, pathname: string, options: { body?: unknown } = {}) {
    const headers: Record<string, string> = {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    };
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method, headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, text, json };
  }
}

async function main() {
  const baseCfg = loadServerConfig();
  const db: ServerDatabase = await createServerDatabase(
    { ...baseCfg, nodeEnv: 'test', isProduction: false },
    { inMemory: true, seedDemo: true }
  );
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const admin = new CookieHttpClient(baseUrl);
  const loginRes = await admin.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } });
  assert.equal(loginRes.status, 200);

  let passed = 0;
  let failed = 0;
  const results: string[] = [];

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      passed++;
      results.push(`✅ ${name}`);
    } catch (err: any) {
      failed++;
      results.push(`❌ ${name}: ${err.message}`);
    }
  }

  // ============================================================
  // Phase 4: Customers — Contacts & Branches
  // ============================================================
  await test('P4: Create customer contact', async () => {
    // Get a customer first
    const custRes = await admin.request('GET', '/api/customers');
    assert.equal(custRes.status, 200);
    const customerId = custRes.json.customers?.[0]?.id || custRes.json[0]?.id;
    assert.ok(customerId, 'Need a customer');
    const res = await admin.request('POST', `/api/customers/${customerId}/contacts`, {
      body: { contactName: 'Test Contact', role: 'Manager', email: 'test@test.com', isPrimary: true },
    });
    assert.equal(res.status, 201, `Contact create failed: ${res.text}`);
    assert.ok(res.json.contact.id > 0);
  });

  await test('P4: List customer contacts', async () => {
    const custRes = await admin.request('GET', '/api/customers');
    const customerId = custRes.json.customers?.[0]?.id || custRes.json[0]?.id;
    const res = await admin.request('GET', `/api/customers/${customerId}/contacts`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.contacts));
  });

  await test('P4: Create customer branch', async () => {
    const custRes = await admin.request('GET', '/api/customers');
    const customerId = custRes.json.customers?.[0]?.id || custRes.json[0]?.id;
    const res = await admin.request('POST', `/api/customers/${customerId}/branches`, {
      body: { branchName: 'Main Branch', address: '123 Main St', isBillingDefault: true },
    });
    assert.equal(res.status, 201, `Branch create failed: ${res.text}`);
    assert.ok(res.json.branch.id > 0);
  });

  await test('P4: List customer branches', async () => {
    const custRes = await admin.request('GET', '/api/customers');
    const customerId = custRes.json.customers?.[0]?.id || custRes.json[0]?.id;
    const res = await admin.request('GET', `/api/customers/${customerId}/branches`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.branches));
  });

  // ============================================================
  // Phase 5: Payroll — Advances, Deductions, Allowances
  // ============================================================
  await test('P5: Create salary advance', async () => {
    // Get an employee
    const empRes = await admin.request('GET', '/api/employees');
    const employeeId = empRes.json.employees?.[0]?.id || empRes.json[0]?.id;
    if (!employeeId) { console.log('No employees found, skipping'); return; }
    const res = await admin.request('POST', '/api/payroll/advances', {
      body: { employeeId, amount: 50000, repaymentSchedule: [{ month: 1, amount: 5000 }] },
    });
    assert.equal(res.status, 201, `Advance create failed: ${res.text}`);
    assert.ok(res.json.advance.id > 0);
  });

  await test('P5: List salary advances', async () => {
    const res = await admin.request('GET', '/api/payroll/advances');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.advances));
  });

  await test('P5: Create deduction rule', async () => {
    const res = await admin.request('POST', '/api/payroll/deduction-rules', {
      body: { deductionType: 'tax', name: 'PAYE', calculationMethod: 'percentage', formula: '10%', applicableTo: 'all' },
    });
    assert.equal(res.status, 201, `Deduction rule create failed: ${res.text}`);
    assert.ok(res.json.rule.id > 0);
  });

  await test('P5: List deduction rules', async () => {
    const res = await admin.request('GET', '/api/payroll/deduction-rules');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.rules));
  });

  await test('P5: Create employee allowance', async () => {
    const empRes = await admin.request('GET', '/api/employees');
    const employeeId = empRes.json.employees?.[0]?.id || empRes.json[0]?.id;
    if (!employeeId) { console.log('No employees found, skipping'); return; }
    const res = await admin.request('POST', '/api/payroll/allowances', {
      body: { employeeId, allowanceType: 'housing', amount: 10000 },
    });
    assert.equal(res.status, 201, `Allowance create failed: ${res.text}`);
    assert.ok(res.json.allowance.id > 0);
  });

  await test('P5: List employee allowances', async () => {
    const res = await admin.request('GET', '/api/payroll/allowances');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.allowances));
  });

  // ============================================================
  // Phase 6: Delivery — Vehicles, Drivers, Scheduling
  // ============================================================
  await test('P6: Create vehicle', async () => {
    const res = await admin.request('POST', '/api/delivery/vehicles', {
      body: { registration: 'ABC-123', make: 'Toyota', model: 'Hilux', capacityKg: 1000 },
    });
    assert.equal(res.status, 201, `Vehicle create failed: ${res.text}`);
    assert.ok(res.json.vehicle.id > 0);
  });

  await test('P6: List vehicles', async () => {
    const res = await admin.request('GET', '/api/delivery/vehicles');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.vehicles));
  });

  await test('P6: Create driver', async () => {
    const res = await admin.request('POST', '/api/delivery/drivers', {
      body: { name: 'John Driver', phone: '+260970000001', licenseNumber: 'DL-001', licenseExpiry: '2027-12-31' },
    });
    assert.equal(res.status, 201, `Driver create failed: ${res.text}`);
    assert.ok(res.json.driver.id > 0);
  });

  await test('P6: List drivers', async () => {
    const res = await admin.request('GET', '/api/delivery/drivers');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.drivers));
  });

  // ============================================================
  // Phase 8: Documents — QR Verification
  // ============================================================
  await test('P8: Generate QR token', async () => {
    const res = await admin.request('POST', '/api/documents/invoice/1/qr');
    assert.equal(res.status, 201, `QR generate failed: ${res.text}`);
    assert.ok(res.json.token);
  });

  await test('P8: Verify QR token', async () => {
    const genRes = await admin.request('POST', '/api/documents/invoice/2/qr');
    const token = genRes.json.token;
    const res = await fetch(`${baseUrl}/api/qr-verify/${token}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.valid, true);
  });

  await test('P8: Revoke QR token', async () => {
    const res = await admin.request('POST', '/api/documents/invoice/1/qr/revoke');
    assert.equal(res.status, 200);
    assert.equal(res.json.revoked, true);
  });

  // ============================================================
  // Phase 9: Communications — Consent & Suppression
  // ============================================================
  await test('P9: Create consent', async () => {
    const custRes = await admin.request('GET', '/api/customers');
    const customerId = custRes.json.customers?.[0]?.id || custRes.json[0]?.id;
    if (!customerId) { console.log('No customers found, skipping'); return; }
    const res = await admin.request('POST', '/api/communications/consents', {
      body: { customerId, channel: 'email', consentType: 'marketing', status: 'granted' },
    });
    assert.equal(res.status, 201, `Consent create failed: ${res.text}`);
    assert.ok(res.json.consent.id > 0);
  });

  await test('P9: List consents', async () => {
    const res = await admin.request('GET', '/api/communications/consents');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.consents));
  });

  await test('P9: Create suppression', async () => {
    const res = await admin.request('POST', '/api/communications/suppressions', {
      body: { channel: 'email', recipient: 'spam@test.com', reason: 'bounced' },
    });
    assert.equal(res.status, 201, `Suppression create failed: ${res.text}`);
    assert.ok(res.json.suppression.id > 0);
  });

  await test('P9: List suppressions', async () => {
    const res = await admin.request('GET', '/api/communications/suppressions');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.suppressions));
  });

  await test('P9: Twilio webhook', async () => {
    const res = await fetch(`${baseUrl}/api/twilio-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ From: '+1234567890', Body: 'STOP' }),
    });
    assert.equal(res.status, 200);
  });

  // ============================================================
  // Phase 10: BI — Sales Trends & KPI
  // ============================================================
  await test('P10: Sales trends', async () => {
    const res = await admin.request('GET', '/api/bi/sales-trends?period=monthly');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.trends));
  });

  await test('P10: KPI scorecard', async () => {
    const res = await admin.request('GET', '/api/bi/kpi-scorecard');
    assert.equal(res.status, 200);
    assert.ok(res.json.kpis);
  });

  await test('P10: Inventory turnover', async () => {
    const res = await admin.request('GET', '/api/bi/inventory-turnover');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.items));
  });

  await test('P10: POS cashier performance', async () => {
    const res = await admin.request('GET', '/api/bi/pos-cashier-performance');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.cashiers));
  });

  // ============================================================
  // Phase 11: System Admin — Health, Integrations, Subscriptions
  // ============================================================
  await test('P11: Health check', async () => {
    const res = await admin.request('GET', '/api/admin/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
  });

  await test('P11: Create integration', async () => {
    const res = await admin.request('POST', '/api/admin/integrations', {
      body: { name: 'Test Integration', type: 'webhook', config: { url: 'https://example.com' } },
    });
    assert.equal(res.status, 201, `Integration create failed: ${res.text}`);
    assert.ok(res.json.integration.id > 0);
  });

  await test('P11: List integrations', async () => {
    const res = await admin.request('GET', '/api/admin/integrations');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.integrations));
  });

  await test('P11: List subscriptions', async () => {
    const res = await admin.request('GET', '/api/admin/subscriptions');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.subscriptions));
  });

  await test('P11: List releases', async () => {
    const res = await admin.request('GET', '/api/admin/releases');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.releases));
  });

  await test('P11: Metrics', async () => {
    const res = await admin.request('GET', '/api/admin/metrics');
    assert.equal(res.status, 200);
    assert.ok(res.json.metrics);
  });

  // ============================================================
  // Print Results
  // ============================================================
  console.log('\n=== INTEGRATION TEST RESULTS ===');
  for (const r of results) console.log(r);
  console.log(`\nTotal: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);

  await db.close();
  await new Promise<void>(resolve => server.close(() => resolve()));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});