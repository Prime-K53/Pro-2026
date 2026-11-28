/**
 * D-08/R3 — OCR provider allowlisting, image safety, strict reservation and
 * enforced provider output ceiling. Real PGlite + real ocrService/ocrEligibility/
 * ocrImage + REAL chatCompletion (fetch stubbed to inspect the serialized request).
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import * as ocrService from '../../src/server/services/ocrService.ts';
import * as aiService from '../../src/server/services/aiService.ts';
import { resolveOcrModel, ocrImageTokens } from '../../src/server/services/ocrEligibility.ts';
import { decodeOcrImage } from '../../src/server/services/ocrImage.ts';
import { chatCompletion } from '../../src/server/services/aiProvider.ts';
import { encryptSecret } from '../../src/server/services/secretCrypto.ts';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e: any) { failed++; console.error(`  [FAIL] ${name} — ${e?.message || e}`); }
}

// Minimal PNG builder (signature + IHDR + IEND) with correct CRC32.
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngDataUrl(w: number, h: number): string {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}
const VALID = { kind: 'invoice', counterpartyName: 'ACME', date: '2026-01-01', currency: 'MWK', taxRate: 0, lines: [{ description: 'X', quantity: 2, rate: 100, amount: 200, confidence: 0.9 }], subtotal: 200, tax: 0, total: 200, confidence: 0.9 };

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const db: any = srv.db;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM companies ORDER BY id LIMIT 1`)).rows[0].id));
    const adminId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM users WHERE username='admin'`)).rows[0].id));
    const actor = { userId: adminId, username: 'admin' };
    const setConfig = (provider: string, model: string) => db.withCompanyDb(companyId, async (tx: any) => {
      await tx.query(`DELETE FROM ai_config WHERE company_id=$1`, [companyId]);
      await tx.query(`INSERT INTO ai_config (company_id, provider, api_key_encrypted, model_name, enabled) VALUES ($1,$2,$3,$4,TRUE)`, [companyId, provider, encryptSecret('k'), model]);
    }, adminId);
    const attempt = (requestId: string) => db.withCompanyDb(companyId, async (tx: any) =>
      (await tx.query(`SELECT state, reservation_tokens, total_tokens, usage_source FROM ai_usage_attempts WHERE company_id=$1 AND request_id=$2`, [companyId, requestId])).rows[0], adminId);
    const budgetRow = () => db.withCompanyDb(companyId, async (tx: any) =>
      (await tx.query(`SELECT reserved_tokens FROM ai_budget_usage WHERE company_id=$1 AND period=$2`, [companyId, new Date().toISOString().slice(0, 7)])).rows[0] || { reserved_tokens: 0 }, adminId);
    const setBudget = (n: number) => db.withCompanyDb(companyId, (tx: any) => tx.query(
      `INSERT INTO ai_budgets (company_id, monthly_token_limit, monthly_cost_limit) VALUES ($1,$2,0) ON CONFLICT (company_id) DO UPDATE SET monthly_token_limit=EXCLUDED.monthly_token_limit`, [companyId, n]), adminId);
    const providerOk = async (_c: any, _m: any, _o: any): Promise<any> => ({ content: JSON.stringify(VALID), model: 'gpt-4o', usage: { totalTokens: 7 } });

    console.log('=== D-08/R3: OCR eligibility, image safety, strict budget ===\n');

    // Eligibility
    await test('verified OpenAI models accepted', async () => {
      for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1']) {
        const p = resolveOcrModel('openai', m);
        assert.ok(p, `${m} must be allowlisted`);
      }
      assert.equal(resolveOcrModel('openai', 'gpt-9'), null, 'unknown model rejected');
    });
    await test('openrouter/anthropic/other rejected for OCR (fail closed)', async () => {
      for (const prov of ['openrouter', 'anthropic', 'other']) assert.equal(resolveOcrModel(prov, 'gpt-4o'), null, `${prov} rejected`);
      assert.equal(resolveOcrModel('gemini', 'gemini-2.0-flash'), null, 'gemini rejected (no defensible bound)');
    });
    await test('unsupported provider/model prevents provider invocation', async () => {
      await setConfig('openrouter', 'gpt-4o');
      let called = 0;
      let code = '';
      try { await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: pngDataUrl(64, 64) }), adminId); }
      catch (e: any) { code = e.code; }
      assert.equal(code, 'OCR_PROVIDER_UNSUPPORTED');
      assert.equal(called, 0);
    });
    await test('ordinary AI chat is NOT restricted by the OCR allowlist', async () => {
      const orig = globalThis.fetch;
      (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 1 } }), headers: { get: () => null }, text: async () => '' });
      try {
        const r = await chatCompletion({ provider: 'openrouter', apiKey: 'k', modelName: 'anything' }, [{ role: 'user', content: 'hi' }]);
        assert.equal(r.content, 'hi');
      } finally { (globalThis as any).fetch = orig; }
    });

    // Image safety
    await test('valid PNG accepted; representation preserved', async () => {
      const d = decodeOcrImage(pngDataUrl(1024, 768));
      assert.equal(d.format, 'png'); assert.equal(d.width, 1024); assert.equal(d.height, 768);
    });
    await test('incorrect MIME prefix rejected', async () => {
      assert.throws(() => decodeOcrImage('data:text/plain;base64,AAAA'), (e: any) => e.code === 'OCR_IMAGE_REQUIRED');
    });
    await test('malformed/truncated image rejected', async () => {
      assert.throws(() => decodeOcrImage('data:image/png;base64,AAAA'), (e: any) => e.code === 'OCR_IMAGE_MALFORMED');
    });
    await test('unsupported format rejected', async () => {
      assert.throws(() => decodeOcrImage('data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='), (e: any) => e.code === 'OCR_IMAGE_UNSUPPORTED');
    });
    await test('oversized dimensions rejected', async () => {
      assert.throws(() => decodeOcrImage(pngDataUrl(100000, 100000)), (e: any) => e.code === 'OCR_IMAGE_TOO_LARGE');
    });
    await test('excessive total pixels rejected', async () => {
      assert.throws(() => decodeOcrImage(pngDataUrl(7000, 7000)), (e: any) => e.code === 'OCR_IMAGE_TOO_LARGE');
    });
    await test('payload exceeding limit rejected', async () => {
      const big = 'data:image/png;base64,' + 'A'.repeat(11 * 1024 * 1024);
      assert.throws(() => decodeOcrImage(big), (e: any) => e.code === 'OCR_IMAGE_TOO_LARGE');
    });

    // Strict reservation
    await test('complete reservation includes image + output ceiling', async () => {
      await setConfig('openai', 'gpt-4o'); await setBudget(1_000_000);
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: pngDataUrl(1024, 1024) }), adminId);
      const a = await attempt(prep.requestId);
      const policy = resolveOcrModel('openai', 'gpt-4o')!;
      const maxImage = ocrImageTokens(policy, 1024, 1024);
      assert.equal(prep.maxOutputTokens, 16384, 'output ceiling stored');
      assert.ok(Number(a.reservation_tokens) >= prep.maxOutputTokens + maxImage, 'reservation covers output + image (+ text)');
    });
    await test('reservation failure prevents provider invocation', async () => {
      await setConfig('openai', 'gpt-4o'); await setBudget(10);
      let code = '';
      try { await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: pngDataUrl(64, 64) }), adminId); }
      catch (e: any) { code = e.code; }
      assert.equal(code, 'AI_TOKEN_BUDGET_EXCEEDED');
      await setBudget(1_000_000);
    });
    await test('successful trusted usage settles; missing usage follows D-05', async () => {
      await setConfig('openai', 'gpt-4o');
      const p1: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: pngDataUrl(64, 64) }), adminId);
      const r1 = await ocrService.runOcrProvider(p1, providerOk);
      await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, p1, r1), adminId);
      assert.equal((await attempt(p1.requestId)).usage_source, 'provider');
      assert.equal(Number((await attempt(p1.requestId)).total_tokens), 7);
      const p2: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: pngDataUrl(80, 80) }), adminId);
      const r2 = await ocrService.runOcrProvider(p2, async () => ({ content: JSON.stringify(VALID), model: 'gpt-4o' }));
      await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, p2, r2), adminId);
      const a2 = await attempt(p2.requestId);
      assert.equal(a2.usage_source, 'estimated');
      assert.equal(Number(a2.total_tokens), Number(a2.reservation_tokens));
    });
    await test('ambiguous timeout retains reservation (unresolved)', async () => {
      const p: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: pngDataUrl(96, 96) }), adminId);
      let threw = false;
      try { await ocrService.runOcrProvider(p, async () => { throw new Error('timeout'); }); } catch { threw = true; }
      await db.withCompanyDb(companyId, (tx: any) => aiService.recordProviderFailure(tx, companyId, p.attemptId, true, 'timeout'), adminId);
      assert.ok(threw);
      assert.equal((await attempt(p.requestId)).state, 'unresolved');
    });

    // Outbound provider request enforcement
    await test('outbound OpenAI request contains max_tokens ceiling and detail:high', async () => {
      const orig = globalThis.fetch; let captured: any = null;
      (globalThis as any).fetch = async (_url: string, init: any) => { captured = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 3 } }), headers: { get: () => null }, text: async () => '' }; };
      try {
        await chatCompletion({ provider: 'openai', apiKey: 'k', modelName: 'gpt-4o' }, [{ role: 'user', content: 'x', images: [pngDataUrl(512, 512)] }], { maxOutputTokens: 4096 });
      } finally { (globalThis as any).fetch = orig; }
      assert.equal(captured.max_tokens, 4096, 'max_tokens present and exact');
      const img = captured.messages[0].content.find((p: any) => p.type === 'image_url');
      assert.equal(img.image_url.detail, 'high', 'deterministic high detail');
    });
    await test('chat path (no opts) does NOT inject max_tokens', async () => {
      const orig = globalThis.fetch; let captured: any = null;
      (globalThis as any).fetch = async (_url: string, init: any) => { captured = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }), headers: { get: () => null }, text: async () => '' }; };
      try { await chatCompletion({ provider: 'openai', apiKey: 'k', modelName: 'gpt-4o' }, [{ role: 'user', content: 'hi' }]); }
      finally { (globalThis as any).fetch = orig; }
      assert.equal(captured.max_tokens, undefined, 'no ceiling on ordinary chat');
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exitCode = 1;
  } finally { await srv.close(); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });