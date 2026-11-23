/**
 * WS-7 outbound messaging + idempotent receipts, WS-9 secret rotation and
 * audit monitoring.
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
  process.env.TWILIO_AUTH_TOKEN = 'test-twilio-token';
  const srv = await startTestServer();
  try {
    const admin = await loginAdmin(srv.baseUrl);
    const c = admin.client;

    // Queue an SMS with a provider message id.
    const sent = await c.request('POST', '/api/communications/send', {
      body: {
        channel: 'sms',
        recipient: '+260970000001',
        body: 'Your invoice is ready',
        provider: 'twilio',
        providerMessageId: 'SM123',
      },
    });
    assert.equal(sent.status, 201, sent.text);
    assert.equal(sent.json.message.status, 'sent');

    // Idempotent delivery receipt via signed webhook.
    const url = `${srv.baseUrl}/api/communications/webhooks/twilio`;
    const form = { MessageSid: 'SM123', MessageStatus: 'delivered' };
    const sig = twilioSignature(url, form, 'test-twilio-token');
    const receipt = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': sig,
      },
      body: new URLSearchParams(form).toString(),
    });
    assert.equal(receipt.status, 200);

    // Replaying the same receipt must not change anything (idempotent).
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': sig,
      },
      body: new URLSearchParams(form).toString(),
    });

    const messages = await c.request('GET', '/api/communications/messages');
    assert.equal(messages.status, 200);
    const msg = messages.json.messages.find((m: any) => m.providerMessageId === 'SM123');
    assert.ok(msg, 'message must be listed');
    assert.equal(msg.status, 'delivered', 'receipt must update status');

    // Integration secret rotation.
    const created = await c.request('POST', '/api/admin/integrations', {
      body: { name: 'Twilio', type: 'sms', config: {} },
    });
    assert.equal(created.status, 201, created.text);
    const rotate = await c.request('POST', `/api/admin/integrations/${created.json.integration.id}/rotate-secret`, {
      body: { secret: 'new-secret-value' },
    });
    assert.equal(rotate.status, 200, rotate.text);

    // Audit summary records the rotation.
    const summary = await c.request('GET', '/api/admin/audit/summary');
    assert.equal(summary.status, 200, summary.text);
    const actions = summary.json.actions.map((a: any) => a.action);
    assert.ok(actions.includes('INTEGRATION_SECRET_ROTATED'), 'rotation must be audited');

    // QR versioning.
    const qr = await c.request('POST', '/api/documents/invoice/1/qr', { body: { version: 2 } });
    assert.equal(qr.status, 201, qr.text);
    const verify = await c.request('GET', `/api/qr-verify/${qr.json.token}`);
    assert.equal(verify.status, 200);
    assert.equal(verify.json.documentVersion, 2, 'QR must report the document version');

    // Templates.
    const tpl = await c.request('POST', '/api/communications/templates', {
      body: { name: 'Invoice Ready', channel: 'sms', body: 'Hello {{name}}' },
    });
    assert.equal(tpl.status, 201, tpl.text);
    const tpls = await c.request('GET', '/api/communications/templates');
    assert.equal(tpls.status, 200);
    assert.ok(tpls.json.templates.some((t: any) => t.name === 'Invoice Ready'));

    // Suppression blocks sends.
    const supp = await c.request('POST', '/api/communications/suppressions', {
      body: { channel: 'sms', recipient: '+260970000099', reason: 'opted out' },
    });
    assert.equal(supp.status, 201, supp.text);
    const blocked = await c.request('POST', '/api/communications/send', {
      body: { channel: 'sms', recipient: '+260970000099', body: 'x' },
    });
    assert.equal(blocked.status, 201);
    assert.equal(blocked.json.message.status, 'failed', 'suppressed recipient must not send');
    assert.equal(blocked.json.message.error, 'suppressed');

    // Branded document print view.
    const docPrint = await c.request('GET', '/api/documents/invoice/1/print');
    assert.equal(docPrint.status, 200, docPrint.text);
    assert.match(docPrint.text, /<title>.*<\/title>/, 'print view must be branded HTML');
    assert.match(docPrint.text, /Print/, 'print view must offer printing');

    // Branded public QR verification page (safe fields only).
    const qrPage = await c.request('GET', `/api/qr-verify/${qr.json.token}/page`);
    assert.equal(qrPage.status, 200, qrPage.text);
    assert.match(qrPage.text, /Authentic/, 'QR page must report authenticity');
    assert.match(qrPage.text, /does not display confidential/i, 'QR page must state it reveals no confidential data');

    // Communications cost/usage summary.
    const costs = await c.request('GET', '/api/communications/costs');
    assert.equal(costs.status, 200, costs.text);
    assert.equal(typeof costs.json.total, 'number');
    assert.ok(Array.isArray(costs.json.byChannel));

    console.log('✅ Communications & admin control tests passed');
  } finally {
    delete process.env.TWILIO_AUTH_TOKEN;
    await srv.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});