import assert from 'node:assert/strict';
import http from 'node:http';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';

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

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin', password: 'PrintingAdmin#2026' }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';

  // Test GET /auth/2fa/status
  const statusRes = await fetch(`${baseUrl}/api/auth/2fa/status`, {
    headers: { Cookie: cookie },
  });
  assert.equal(statusRes.status, 200);
  console.log('2FA status:', await statusRes.json());

  // Test POST /auth/2fa/enroll
  const enrollRes = await fetch(`${baseUrl}/api/auth/2fa/enroll`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(enrollRes.status, 200);
  const enrollData = await enrollRes.json();
  console.log('Enrolled, secret length:', enrollData.secret.length, 'URI:', enrollData.uri.slice(0, 50));

  // Generate a valid TOTP code using the secret
  // We'll use the twoFactorService directly
  const { generateTotpCode } = await import('../../src/server/services/twoFactorService.ts');
  const code = generateTotpCode(enrollData.secret);
  console.log('Generated TOTP code:', code);

  // Test POST /auth/2fa/verify
  const verifyRes = await fetch(`${baseUrl}/api/auth/2fa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code }),
  });
  assert.equal(verifyRes.status, 200);
  console.log('Verify result:', await verifyRes.json());

  // Test POST /auth/2fa/backup-codes
  const backupRes = await fetch(`${baseUrl}/api/auth/2fa/backup-codes`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(backupRes.status, 200);
  const backupData = await backupRes.json();
  console.log('Backup codes count:', backupData.codes.length);

  // Test status again
  const status2Res = await fetch(`${baseUrl}/api/auth/2fa/status`, {
    headers: { Cookie: cookie },
  });
  assert.equal(status2Res.status, 200);
  console.log('2FA status after enable:', await status2Res.json());

  // Disable requires password re-authentication (WS-0 S4).
  const badDisable = await fetch(`${baseUrl}/api/auth/2fa/disable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(badDisable.status, 403, 'disable with wrong password must be rejected');

  const goodDisable = await fetch(`${baseUrl}/api/auth/2fa/disable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password: 'PrintingAdmin#2026' }),
  });
  assert.equal(goodDisable.status, 200, 'disable with correct password must succeed');

  const status3Res = await fetch(`${baseUrl}/api/auth/2fa/status`, {
    headers: { Cookie: cookie },
  });
  assert.equal((await status3Res.json()).enabled, false, '2FA must be disabled after re-auth');

  console.log('\n✅ All 2FA route tests passed!');

  await db.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});