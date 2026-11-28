/**
 * D-08/R4-A — conservative pre-call text-token reservation.
 * Proves the textual reservation is a deterministic UPPER BOUND (UTF-8 bytes +
 * framing), that the complete reservation = text + image + output, and that the
 * serialized provider request is the exact request that was reserved.
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import * as ocrService from '../../src/server/services/ocrService.ts';
import { conservativeTextTokens, ocrImageTokens, resolveOcrModel, OCR_MESSAGE_FRAMING_TOKENS, OCR_REQUEST_OVERHEAD_TOKENS } from '../../src/server/services/ocrEligibility.ts';
import { encryptSecret } from '../../src/server/services/secretCrypto.ts';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e: any) { failed++; console.error(`  [FAIL] ${name} — ${e?.message || e}`); }
}
function crc32(buf: Buffer): number { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function pngDataUrl(w: number, h: number): string { const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]); return 'data:image/png;base64,' + png.toString('base64'); }

async function main() {
  // Pure unit tests (no DB).
  console.log('=== D-08/R4-A: conservative text reservation ===\n');
  await test('ASCII text: bound is a UTF-8 upper bound', async () => {
    const msgs = [{ role: 'system', content: 'You are an OCR digitizer.' }, { role: 'user', content: 'Extract this invoice.' }];
    const bound = conservativeTextTokens(msgs);
    const bytes = msgs.reduce((s, m) => s + Buffer.byteLength(m.content, 'utf8') + Buffer.byteLength(m.role, 'utf8'), 0);
    assert.ok(bound >= bytes, 'bound >= utf8 bytes (tokens <= bytes)');
    assert.equal(bound, bytes + msgs.length * OCR_MESSAGE_FRAMING_TOKENS + OCR_REQUEST_OVERHEAD_TOKENS);
  });
  await test('Unicode + emoji: bound >= bytes', async () => {
    const msgs = [{ role: 'user', content: 'Facture café ☕ 日本語 — naïve résumé' }];
    const bound = conservativeTextTokens(msgs);
    const bytes = Buffer.byteLength(msgs[0].content, 'utf8');
    assert.ok(bound >= bytes);
    assert.ok(bytes > msgs[0].content.length, 'utf8 bytes exceed UTF-16 length for non-ASCII');
  });
  await test('Non-Latin scripts: bound >= bytes', async () => {
    const msgs = [{ role: 'user', content: 'Инвойс счёт фактура rendered' }];
    assert.ok(conservativeTextTokens(msgs) >= Buffer.byteLength(msgs[0].content, 'utf8'));
  });
  await test('Long unbroken string: bound scales with bytes', async () => {
    const s = 'A'.repeat(100000);
    const bound = conservativeTextTokens([{ role: 'user', content: s }]);
    assert.ok(bound >= 100000);
  });
  await test('Adversarial punctuation: bound >= bytes', async () => {
    const s = '!@#$%^&*()_+-=[]{}|;:",.<>/?`~\\ \u0000\u001b';
    assert.ok(conservativeTextTokens([{ role: 'user', content: s }]) >= Buffer.byteLength(s, 'utf8'));
  });
  await test('Multiple messages/roles: framing counted per message', async () => {
    const msgs = [{ role: 'system', content: 'a' }, { role: 'user', content: 'bb' }, { role: 'assistant', content: 'ccc' }];
    const bound = conservativeTextTokens(msgs);
    const bytes = msgs.reduce((s, m) => s + Buffer.byteLength(m.content, 'utf8') + Buffer.byteLength(m.role, 'utf8'), 0);
    assert.equal(bound, bytes + 3 * OCR_MESSAGE_FRAMING_TOKENS + OCR_REQUEST_OVERHEAD_TOKENS);
  });
await test('Empty messages: bound is just framing + overhead', async () => {
      assert.equal(conservativeTextTokens([]), OCR_REQUEST_OVERHEAD_TOKENS);
      assert.equal(conservativeTextTokens([{ role: '', content: '' }]), OCR_MESSAGE_FRAMING_TOKENS + OCR_REQUEST_OVERHEAD_TOKENS);
      assert.equal(conservativeTextTokens([{ role: 'user', content: '' }]), OCR_MESSAGE_FRAMING_TOKENS + OCR_REQUEST_OVERHEAD_TOKENS + Buffer.byteLength('user', 'utf8'));
    });
  await test('Overflow protection: huge input stays finite', async () => {
    const bound = conservativeTextTokens([{ role: 'user', content: 'x'.repeat(5_000_000) }]);
    assert.ok(Number.isFinite(bound) && bound >= 5_000_000);
  });
  await test('corpus: bound never below the byte upper bound (tokens <= bytes)', async () => {
    const corpus = ['Hello world', 'café ☕ 日本語', 'A'.repeat(5000), '!@#$%^&*()', 'Инвойс счёт', 'mixed 123 with\nnewlines\tand tabs'];
    for (const s of corpus) {
      const bound = conservativeTextTokens([{ role: 'user', content: s }]);
      const bytes = Buffer.byteLength(s, 'utf8') + Buffer.byteLength('user', 'utf8');
      assert.ok(bound >= bytes, `bound < byte upper bound for "${s.slice(0, 12)}"`);
    }
  });

  // DB + reservation + actual-request match.
  const srv = await startTestServer({ seedDemo: true });
  const db: any = srv.db;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM companies ORDER BY id LIMIT 1`)).rows[0].id));
    const adminId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM users WHERE username='admin'`)).rows[0].id));
    const actor = { userId: adminId, username: 'admin' };
    await db.withCompanyDb(companyId, (tx: any) => tx.query(`INSERT INTO ai_config (company_id, provider, api_key_encrypted, model_name, enabled) VALUES ($1,'openai',$2,'gpt-4o',TRUE)`, [companyId, encryptSecret('k')]), adminId);
    await db.withCompanyDb(companyId, (tx: any) => tx.query(`INSERT INTO ai_budgets (company_id, monthly_token_limit, monthly_cost_limit) VALUES ($1,1000000,0) ON CONFLICT (company_id) DO UPDATE SET monthly_token_limit=1000000`, [companyId]), adminId);
    const attempt = (rid: string) => db.withCompanyDb(companyId, async (tx: any) => (await tx.query(`SELECT reservation_tokens FROM ai_usage_attempts WHERE company_id=$1 AND request_id=$2`, [companyId, rid])).rows[0], adminId);

    await test('reservation = conservative text + image + output (image counted once)', async () => {
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: pngDataUrl(1024, 768) }), adminId);
      const a = await attempt(prep.requestId);
      const policy = resolveOcrModel('openai', 'gpt-4o')!;
      const text = conservativeTextTokens(prep.messages);
      const img = ocrImageTokens(policy, 1024, 768);
      const out = policy.maxOutputTokens;
      assert.equal(Number(a.reservation_tokens), text + img + out, 'exact complete reservation');
      assert.ok(Number(a.reservation_tokens) >= img + out, 'image + output included');
    });

    await test('serialized provider request matches the reserved request', async () => {
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: pngDataUrl(800, 600) }), adminId);
      const orig = globalThis.fetch; let body: any = null;
      (globalThis as any).fetch = async (_u: string, init: any) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 5 } }), headers: { get: () => null }, text: async () => '' }; };
      try { await ocrService.runOcrProvider(prep); } finally { (globalThis as any).fetch = orig; }
      // Same system + user text that was reserved.
      assert.equal(body.messages[0].content, prep.messages[0].content, 'system text matches');
      const userText = Array.isArray(body.messages[1].content) ? body.messages[1].content.find((p: any) => p.type === 'text').text : body.messages[1].content;
      assert.equal(userText, prep.messages[1].content, 'user text matches');
      // Same output ceiling that was reserved.
      assert.equal(body.max_tokens, prep.maxOutputTokens, 'output ceiling matches reservation');
      // Same image representation (detail high).
      const img = body.messages[1].content.find((p: any) => p.type === 'image_url');
      assert.equal(img.image_url.detail, 'high');
      assert.equal(img.image_url.url, prep.messages[1].images[0], 'image bytes match');
    });

    await test('image data URL is not counted as text', async () => {
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: pngDataUrl(64, 64) }), adminId);
      const text = conservativeTextTokens(prep.messages);
      // Text bound is derived ONLY from the two content+role strings (image in images[]).
      const expected = Buffer.byteLength(prep.messages[0].content, 'utf8') + Buffer.byteLength(prep.messages[0].role, 'utf8') + Buffer.byteLength(prep.messages[1].content, 'utf8') + Buffer.byteLength(prep.messages[1].role, 'utf8') + 2 * OCR_MESSAGE_FRAMING_TOKENS + OCR_REQUEST_OVERHEAD_TOKENS;
      assert.equal(text, expected, 'image base64 excluded from text bound');
      assert.ok(!prep.messages.some((m: any) => (m.content || '').includes('base64')), 'no image data in text content');
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exitCode = 1;
  } finally { await srv.close(); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });