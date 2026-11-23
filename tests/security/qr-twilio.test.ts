/**
 * WS-6 QR integrity and WS-7 Twilio signature validation.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, loginAdmin } from '../helpers/testServer.ts';

function twilioSignature(url: string, form: Record<string, string>, authToken: string): string {
  const data =
    url +
    Object.keys(form)
      .sort()
      .reduce((acc, key) => acc + key + form[key], '');
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

async function main() {
  // Configure a Twilio auth token before the server reads its config.
  process.env.TWILIO_AUTH_TOKEN = 'test-twilio-token';

  const srv = await startTestServer();
  try {
    const admin = await loginAdmin(srv.baseUrl);
    const c = admin.client;

    // ── QR lifecycle ────────────────────────────────────────────────────
    const gen = await c.request('POST', '/api/documents/invoice/1/qr', { body: {} });
    assert.equal(gen.status, 201, gen.text);
    const token: string = gen.json.token;
    assert.ok(token, 'QR token must be returned');

    const verify = await c.request('GET', `/api/qr-verify/${token}`);
    assert.equal(verify.status, 200);
    assert.equal(verify.json.valid, true);
    assert.equal(verify.json.documentKind, 'invoice');
    assert.equal(verify.json.documentId, 1);

    const bad = await c.request('GET', `/api/qr-verify/${'a'.repeat(64)}`);
    assert.equal(bad.json.valid, false, 'unknown token must be invalid');

    const revoke = await c.request('POST', '/api/documents/invoice/1/qr/revoke', { body: {} });
    assert.equal(revoke.status, 200, revoke.text);

    const afterRevoke = await c.request('GET', `/api/qr-verify/${token}`);
    assert.equal(afterRevoke.json.valid, false, 'revoked token must be invalid');
    assert.equal(afterRevoke.json.revoked, true);

    // ── Twilio signature validation ─────────────────────────────────────
    const url = `${srv.baseUrl}/api/twilio-webhook`;

    // Missing signature → 403.
    const unsigned = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Body: 'STOP', From: '+260970000000' }).toString(),
    });
    assert.equal(unsigned.status, 403, 'unsigned webhook must be rejected');

    // Valid signature → 200.
    const form = { Body: 'hello', From: '+260970000001' };
    const sig = twilioSignature(url, form, 'test-twilio-token');
    const signed = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': sig,
      },
      body: new URLSearchParams(form).toString(),
    });
    assert.equal(signed.status, 200, `signed webhook failed: ${signed.status}`);

    console.log('✅ QR & Twilio tests passed');
  } finally {
    delete process.env.TWILIO_AUTH_TOKEN;
    await srv.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});