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

  // Login
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin', password: 'PrintingAdmin#2026' }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';

  // Test GET /ai/config
  const configRes = await fetch(`${baseUrl}/api/ai/config`, {
    headers: { Cookie: cookie },
  });
  assert.equal(configRes.status, 200);
  console.log('AI config:', await configRes.json());

  // Test POST /ai/config
  const saveRes = await fetch(`${baseUrl}/api/ai/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ provider: 'openrouter', apiKey: 'test-key', modelName: 'gpt-4', enabled: true }),
  });
  assert.equal(saveRes.status, 200);
  console.log('Saved config:', await saveRes.json());

  // Test GET /ai/conversations
  const convRes = await fetch(`${baseUrl}/api/ai/conversations`, {
    headers: { Cookie: cookie },
  });
  assert.equal(convRes.status, 200);
  console.log('Conversations:', await convRes.json());

  // Test POST /ai/conversations
  const newConvRes = await fetch(`${baseUrl}/api/ai/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: 'Test conversation' }),
  });
  assert.equal(newConvRes.status, 201);
  const conv = (await newConvRes.json()).conversation;
  console.log('New conversation:', conv);

  // Test GET /ai/anomalies
  const anomRes = await fetch(`${baseUrl}/api/ai/anomalies`, {
    headers: { Cookie: cookie },
  });
  assert.equal(anomRes.status, 200);
  console.log('Anomalies:', await anomRes.json());

  // Test POST /ai/anomalies/detect
  const detectRes = await fetch(`${baseUrl}/api/ai/anomalies/detect`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(detectRes.status, 200);
  console.log('Detected anomalies:', await detectRes.json());

  // Test GET /ai/actions
  const actionsRes = await fetch(`${baseUrl}/api/ai/actions`, {
    headers: { Cookie: cookie },
  });
  assert.equal(actionsRes.status, 200);
  console.log('Actions:', await actionsRes.json());

  // Test POST /ai/actions
  const proposeRes = await fetch(`${baseUrl}/api/ai/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ actionType: 'create_invoice', description: 'Test action', parameters: { foo: 'bar' } }),
  });
  assert.equal(proposeRes.status, 201);
  console.log('Proposed action:', await proposeRes.json());

  // Test GET /ai/audit
  const auditRes = await fetch(`${baseUrl}/api/ai/audit`, {
    headers: { Cookie: cookie },
  });
  assert.equal(auditRes.status, 200);
  console.log('Audit logs:', await auditRes.json());

  console.log('\n✅ All AI route tests passed!');

  await db.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});