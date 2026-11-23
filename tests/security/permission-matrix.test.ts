/**
 * Authorization matrix regression test (WS-0 S2).
 *
 * Verifies that the V2 routers enforce permissions (not just authentication):
 *  - unauthenticated access → 401
 *  - authenticated but unauthorized role → 403
 *  - authorized role → success
 *
 * Uses the seeded demo users: admin (Administrator), accountant (Accountant),
 * production (ProductionManager).
 */
import assert from 'node:assert/strict';
import { startTestServer, createCookieClient, loginAdmin } from '../helpers/testServer.ts';

async function login(baseUrl: string, identifier: string) {
  const client = createCookieClient(baseUrl);
  const res = await client.request('POST', '/api/auth/login', {
    body: { identifier, password: 'PrintingAdmin#2026' },
  });
  assert.equal(res.status, 200, `login ${identifier} failed: ${res.status}`);
  return client;
}

async function main() {
  const srv = await startTestServer();
  try {
    // Unauthenticated → 401.
    const anon = createCookieClient(srv.baseUrl);
    assert.equal((await anon.request('GET', '/api/admin/metrics')).status, 401);
    assert.equal(
      (await anon.request('POST', '/api/payroll/advances', { body: {} })).status,
      401
    );

    const admin = await loginAdmin(srv.baseUrl);
    const accountant = await login(srv.baseUrl, 'accountant');
    const production = await login(srv.baseUrl, 'production');

    // Administrator: full access.
    assert.equal((await admin.client.request('GET', '/api/admin/metrics')).status, 200);
    assert.equal(
      (await admin.client.request('POST', '/api/admin/integrations', {
        body: { name: 'Test', type: 'generic', config: {} },
      })).status,
      201
    );
    assert.equal((await admin.client.request('GET', '/api/bi/kpi-scorecard')).status, 200);
    assert.equal(
      (await admin.client.request('POST', '/api/payroll/advances', {
        body: { employeeId: 1, amount: 50, repaymentSchedule: [] },
      })).status,
      201
    );

    // Production manager: no admin, no payroll; BI read allowed.
    assert.equal((await production.request('GET', '/api/admin/metrics')).status, 403);
    assert.equal(
      (await production.request('POST', '/api/payroll/advances', {
        body: { employeeId: 1, amount: 50, repaymentSchedule: [] },
      })).status,
      403
    );
    assert.equal((await production.request('GET', '/api/bi/kpi-scorecard')).status, 200);

    // Accountant: BI read allowed; admin denied; payroll denied (admin-only).
    assert.equal((await accountant.request('GET', '/api/bi/kpi-scorecard')).status, 200);
    assert.equal((await accountant.request('GET', '/api/admin/metrics')).status, 403);
    assert.equal((await accountant.request('GET', '/api/payroll/advances')).status, 403);

    // Document QR management is admin-only.
    assert.equal(
      (await accountant.request('POST', '/api/documents/invoice/1/qr')).status,
      403
    );

    console.log('✅ Permission matrix tests passed');
  } finally {
    await srv.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});