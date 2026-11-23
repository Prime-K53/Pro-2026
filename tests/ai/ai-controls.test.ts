/**
 * WS-2 AI controls: budget enforcement, approval-bound execution guard,
 * retention purge, and key non-exposure.
 */
import assert from 'node:assert/strict';
import { startTestServer, loginAdmin } from '../helpers/testServer.ts';

async function main() {
  const srv = await startTestServer();
  try {
    const admin = await loginAdmin(srv.baseUrl);
    const c = admin.client;

    // Configure a provider with a dummy key.
    const cfg = await c.request('POST', '/api/ai/config', {
      body: { provider: 'openai', apiKey: 'sk-test-dummy', modelName: 'gpt-4o-mini', enabled: true },
    });
    assert.equal(cfg.status, 200, cfg.text);

    // The config response must never expose the key.
    const readCfg = await c.request('GET', '/api/ai/config');
    assert.equal(readCfg.status, 200);
    assert.equal(readCfg.json.config.hasApiKey, true);
    assert.equal(readCfg.json.config.apiKey, undefined, 'api key must not be returned');

    // Set a tiny token budget; the next chat must fail closed before any provider call.
    const budget = await c.request('PUT', '/api/ai/budget', { body: { monthlyTokenLimit: 1 } });
    assert.equal(budget.status, 200, budget.text);

    const chat = await c.request('POST', '/api/ai/chat', { body: { message: 'hello' } });
    assert.equal(chat.status, 429, `expected budget rejection, got ${chat.status}`);
    assert.equal(chat.json.code, 'AI_TOKEN_BUDGET_EXCEEDED');

    // Raise the budget so the guard passes (provider call will fail, but not 429).
    await c.request('PUT', '/api/ai/budget', { body: { monthlyTokenLimit: 1000000 } });

    // Execution is refused for a non-existent / unapproved action.
    const exec = await c.request('POST', '/api/ai/actions/1/execute', { body: {} });
    assert.equal(exec.status, 404, exec.text);
    assert.equal(exec.json.code, 'AI_ACTION_NOT_FOUND');

    // Retention purge succeeds (nothing old to purge).
    const purge = await c.request('POST', '/api/ai/retention/purge', {
      body: { olderThanDays: 90 },
    });
    assert.equal(purge.status, 200);
    assert.equal(purge.json.purged, 0);

    console.log('✅ AI controls tests passed');
  } finally {
    await srv.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});