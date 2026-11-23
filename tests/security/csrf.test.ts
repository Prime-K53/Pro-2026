/**
 * CSRF regression test (WS-0 S1).
 *
 * Runs with PMS_CSRF=enforce so the middleware is active regardless of NODE_ENV.
 * Verifies:
 *  - mutating cookie-auth requests without a token are rejected (403)
 *  - the same request with a valid token passes CSRF
 *  - safe (GET) requests do not require a token
 *  - /api/auth/csrf-token requires authentication
 */
import assert from 'node:assert/strict';
import { startTestServer, createCookieClient } from '../helpers/testServer.ts';

async function main() {
  process.env.PMS_CSRF = 'enforce';
  const srv = await startTestServer();
  try {
    // 1. Login (public) and capture the per-session CSRF token.
    const client = createCookieClient(srv.baseUrl);
    const login = await client.request('POST', '/api/auth/login', {
      body: { identifier: 'admin', password: 'PrintingAdmin#2026' },
    });
    assert.equal(login.status, 200, 'login should succeed');
    const csrfToken = login.json?.csrfToken;
    assert.ok(csrfToken, 'login response must include a csrfToken');

    // 2. Mutating request WITHOUT a token → 403.
    const noToken = await client.request('POST', '/api/payroll/advances', {
      body: { employeeId: 1, amount: 100, repaymentSchedule: [] },
    });
    assert.equal(noToken.status, 403, `expected 403 without CSRF, got ${noToken.status}`);
    assert.match(noToken.json?.error || '', /CSRF/i);

    // 3. Mutating request WITH a valid token → passes CSRF (201 created).
    const withToken = await client.request('POST', '/api/payroll/advances', {
      body: { employeeId: 1, amount: 100, repaymentSchedule: [] },
      headers: { 'X-CSRF-Token': csrfToken },
    });
    assert.notEqual(withToken.status, 403, 'valid CSRF token must not be rejected');
    assert.equal(withToken.status, 201, `expected 201 with valid CSRF, got ${withToken.status}`);

    // 4. Safe request does not need a token.
    const list = await client.request('GET', '/api/payroll/advances');
    assert.equal(list.status, 200, 'GET must not require CSRF');

    // 5. /api/auth/csrf-token requires authentication.
    const anon = createCookieClient(srv.baseUrl);
    const anonToken = await anon.request('GET', '/api/auth/csrf-token');
    assert.equal(anonToken.status, 401, 'csrf-token endpoint must require auth');

    // 6. Authenticated csrf-token returns a token.
    const authedToken = await client.request('GET', '/api/auth/csrf-token');
    assert.equal(authedToken.status, 200);
    assert.ok(authedToken.json?.csrfToken, 'authenticated csrf-token must return a token');

    console.log('✅ CSRF tests passed');
  } finally {
    delete process.env.PMS_CSRF;
    await srv.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});