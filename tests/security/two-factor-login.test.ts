/**
 * 2FA login enforcement regression test (WS-0 S4).
 *
 * Verifies that an account with 2FA enabled cannot obtain a session without a
 * valid TOTP or backup code, and that the client is told to prompt for one.
 */
import assert from 'node:assert/strict';
import { startTestServer, createCookieClient, loginAdmin } from '../helpers/testServer.ts';
import { generateTotpCode } from '../../src/server/services/twoFactorService.ts';

async function main() {
  const srv = await startTestServer();
  try {
    // Enrol and enable 2FA for the admin account.
    const admin = await loginAdmin(srv.baseUrl);
    const enroll = await admin.client.request('POST', '/api/auth/2fa/enroll', { body: {} });
    assert.equal(enroll.status, 200);
    const secret: string = enroll.json.secret;
    const verify = await admin.client.request('POST', '/api/auth/2fa/verify', {
      body: { code: generateTotpCode(secret) },
    });
    assert.equal(verify.status, 200);

    // 1. Login without a code → 401 + twoFactorRequired.
    const noCode = createCookieClient(srv.baseUrl);
    const r1 = await noCode.request('POST', '/api/auth/login', {
      body: { identifier: 'admin', password: 'PrintingAdmin#2026' },
    });
    assert.equal(r1.status, 401);
    assert.equal(r1.json?.twoFactorRequired, true, 'must signal twoFactorRequired');
    assert.equal(noCode.cookie, '', 'no session cookie should be issued');

    // 2. Login with a wrong code → 401.
    const badCode = createCookieClient(srv.baseUrl);
    const r2 = await badCode.request('POST', '/api/auth/login', {
      body: { identifier: 'admin', password: 'PrintingAdmin#2026', twoFactorCode: '000000' },
    });
    assert.equal(r2.status, 401);

    // 3. Login with a valid TOTP → 200 + csrf token.
    const goodCode = createCookieClient(srv.baseUrl);
    const r3 = await goodCode.request('POST', '/api/auth/login', {
      body: { identifier: 'admin', password: 'PrintingAdmin#2026', twoFactorCode: generateTotpCode(secret) },
    });
    assert.equal(r3.status, 200, `valid 2FA login failed: ${r3.status} ${r3.text}`);
    assert.ok(r3.json?.csrfToken, 'valid 2FA login should mint a csrf token');

    // Restore state: disable 2FA with the password.
    const disable = await goodCode.request('POST', '/api/auth/2fa/disable', {
      body: { password: 'PrintingAdmin#2026' },
    });
    assert.equal(disable.status, 200);

    console.log('✅ 2FA login enforcement tests passed');
  } finally {
    await srv.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});