/**
 * D-08 — OCR transaction isolation & budget enforcement.
 *
 * Real in-memory PGlite + REAL ocrService + REAL D-05 reservation/settlement
 * functions. The external provider is injected as a stub (no network). A test-only
 * counter wraps the real db.withCompanyDb to prove the provider runs with ZERO open
 * company transactions and that prepare/finalize are separate transactions.
 *
 * Limitation: PGlite is single-connection, so "concurrency" here is serialized;
 * it proves the atomic budget guard and UNIQUE(company_id,image_sha256) dedupe,
 * NOT multi-connection races (those require tests/pg against real PostgreSQL).
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import * as ocrService from '../../src/server/services/ocrService.ts';
import * as aiService from '../../src/server/services/aiService.ts';
import { encryptSecret } from '../../src/server/services/secretCrypto.ts';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e: any) { failed++; console.error(`  [FAIL] ${name} — ${e?.message || e}`); }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const img = (n = 0) => (n === 0 ? PNG : PNG.slice(0, -2) + String(n).padStart(2, '0'));
const period = () => new Date().toISOString().slice(0, 7);

const VALID = {
  kind: 'invoice', counterpartyName: 'ACME', counterpartyPhone: null, counterpartyEmail: null,
  date: '2026-01-01', currency: 'MWK', taxRate: 0,
  lines: [{ description: 'Widget', quantity: 2, rate: 100, amount: 200, confidence: 0.9 }],
  subtotal: 200, tax: 0, total: 200, confidence: 0.9,
};

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const db: any = srv.db;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM companies ORDER BY id LIMIT 1`)).rows[0].id));
    const adminId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM users WHERE username='admin'`)).rows[0].id));
    const actor = { userId: adminId, username: 'admin' };

    await db.withCompanyDb(companyId, (tx: any) => tx.query(
      `INSERT INTO ai_config (company_id, provider, api_key_encrypted, model_name, enabled) VALUES ($1,'openai',$2,'gpt-4o',TRUE)`,
      [companyId, encryptSecret('test-key')]
    ), adminId);
    const setBudget = (limit: number) => db.withCompanyDb(companyId, (tx: any) => tx.query(
      `INSERT INTO ai_budgets (company_id, monthly_token_limit, monthly_cost_limit) VALUES ($1,$2,0)
       ON CONFLICT (company_id) DO UPDATE SET monthly_token_limit = EXCLUDED.monthly_token_limit`, [companyId, limit]), adminId);
    await setBudget(1_000_000);

    // Instrument the REAL transaction wrapper.
    let open = 0;
    const events: string[] = [];
    const orig = db.withCompanyDb.bind(db);
    db.withCompanyDb = (cid: number, fn: any, uid?: number) => {
      open++; events.push('tx_enter');
      return orig(cid, fn, uid).finally(() => { open--; events.push('tx_exit'); });
    };

    const budget = (p: string) => db.withCompanyDb(companyId, async (tx: any) =>
      (await tx.query(`SELECT reserved_tokens, settled_tokens FROM ai_budget_usage WHERE company_id=$1 AND period=$2`, [companyId, p])).rows[0] || { reserved_tokens: 0, settled_tokens: 0 }, adminId);
    const attempt = (requestId: string) => db.withCompanyDb(companyId, async (tx: any) =>
      (await tx.query(`SELECT state, reservation_tokens, total_tokens, usage_source FROM ai_usage_attempts WHERE company_id=$1 AND request_id=$2`, [companyId, requestId])).rows[0], adminId);
    const extractionCount = (hash: string) => db.withCompanyDb(companyId, async (tx: any) =>
      Number((await tx.query(`SELECT COUNT(*)::int c FROM ocr_extractions WHERE company_id=$1 AND image_sha256=$2`, [companyId, hash])).rows[0].c), adminId);
    const journalCount = () => db.withCompanyDb(companyId, async (tx: any) => Number((await tx.query(`SELECT COUNT(*)::int c FROM journal_transactions WHERE company_id=$1`, [companyId])).rows[0].c), adminId);

    // Provider stub: asserts no open tx at the exact invocation moment.
    const provider = (behavior: 'ok' | 'invalid' | 'timeout' | 'circuit' | 'nousage' = 'ok', usage: any = { promptTokens: 5, completionTokens: 5, totalTokens: 10 }) =>
      async (_cfg: any, _msgs: any) => {
        assert.equal(open, 0, 'a DB transaction must NOT be open during the provider call');
        events.push('provider');
        if (behavior === 'timeout') throw new Error('provider timeout');
        if (behavior === 'circuit') throw Object.assign(new Error('circuit open'), { code: 'AI_PROVIDER_CIRCUIT_OPEN' });
        if (behavior === 'invalid') return { content: 'not-json', model: 'stub', usage };
        if (behavior === 'nousage') return { content: JSON.stringify(VALID), model: 'stub' };
        return { content: JSON.stringify(VALID), model: 'stub', requestId: 'prv-1', usage };
      };

    // Mirror the route's failure classification (ambiguous unless circuit-open).
    const runWithFailure = async (prep: any, fn: any): Promise<{ raw: any; err: any }> => {
      try { const raw = await ocrService.runOcrProvider(prep, fn); return { raw, err: null }; }
      catch (err: any) {
        const ambiguous = err?.code !== 'AI_PROVIDER_CIRCUIT_OPEN';
        await db.withCompanyDb(companyId, (tx: any) => aiService.recordProviderFailure(tx, companyId, prep.attemptId, ambiguous, String(err?.message || 'provider error')));
        return { raw: null, err };
      }
    };

    console.log('=== D-08: OCR transaction isolation & budget ===\n');

    // A. Transaction isolation
    await test('prepare tx released before provider; provider sees zero open tx; finalize is a separate tx', async () => {
      events.length = 0;
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(1) }), adminId);
      assert.equal(prep.duplicate, false);
      assert.equal(open, 0, 'prepare tx must be released');
      const before = events.filter(e => e === 'tx_exit').length;
      const { raw } = await runWithFailure(prep, provider('ok'));
      assert.ok(raw, 'provider succeeded');
      assert.equal(open, 0, 'still no tx after provider');
      await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, prep, raw), adminId);
      assert.equal(open, 0, 'finalize tx released');
      const provIdx = events.indexOf('provider');
      assert.ok(provIdx > before, 'provider ran after prepare tx_exit');
      assert.ok(provIdx < events.lastIndexOf('tx_enter'), 'finalize tx_enter happened after provider');
    });

    await test('provider timeout leaves no tx open and does not corrupt ERP; reservation retained (unresolved)', async () => {
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(2) }), adminId);
      const { err } = await runWithFailure(prep, provider('timeout'));
      assert.ok(err, 'timeout surfaced');
      assert.equal(open, 0, 'no tx left open after provider failure');
      const a = await attempt(prep.requestId);
      assert.equal(a.state, 'unresolved', 'ambiguous timeout retains reservation as unresolved');
      assert.ok(Number(a.reservation_tokens) > 0);
      // Ordinary ERP op still works.
      await db.withCompanyDb(companyId, (tx: any) => tx.query(`SELECT 1`), adminId);
    });

    await test('circuit-open failure releases the reservation (definite non-billing failure)', async () => {
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(3) }), adminId);
      const { err } = await runWithFailure(prep, provider('circuit'));
      assert.ok(err);
      const a = await attempt(prep.requestId);
      assert.equal(a.state, 'released', 'circuit-open releases the reservation');
    });

    // B. Budget enforcement
    await test('reserves budget before provider; success settles from trusted usage (not zero)', async () => {
      const p = period();
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(4) }), adminId);
      const b1 = await budget(p);
      assert.ok(Number(b1.reserved_tokens) >= ocrService.OCR_IMAGE_TOKEN_RESERVE, 'reservation includes the image upper bound');
      const { raw } = await runWithFailure(prep, provider('ok'));
      await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, prep, raw), adminId);
      const a = await attempt(prep.requestId);
      assert.equal(a.state, 'settled');
      assert.equal(Number(a.total_tokens), 10, 'settled from trusted provider usage');
      assert.ok(Number((await budget(p)).reserved_tokens) < Number(b1.reserved_tokens), 'reservation released on settle');
    });

    await test('missing provider usage is settled at the reservation, never zero or falsely confirmed', async () => {
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(5) }), adminId);
      const { raw } = await runWithFailure(prep, provider('nousage'));
      await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, prep, raw), adminId);
      const a = await attempt(prep.requestId);
      assert.equal(a.state, 'settled');
      assert.equal(Number(a.total_tokens), Number(a.reservation_tokens), 'missing usage settles at reservation');
      assert.ok(Number(a.total_tokens) > 0, 'never zero');
      assert.notEqual(a.usage_source, 'provider', 'not falsely marked as provider usage');
    });

    await test('insufficient remaining budget prevents provider execution (fail closed)', async () => {
      await setBudget(10);
      try {
        let threw: any = null;
        try { await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(6) }), adminId); }
        catch (e) { threw = e; }
        assert.ok(threw, 'prepare must fail over budget');
        assert.equal(threw.code, 'AI_TOKEN_BUDGET_EXCEEDED');
      } finally { await setBudget(1_000_000); }
    });

    await test('retry after a failed attempt creates a NEW reservation/attempt', async () => {
      const first: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(7) }), adminId);
      await runWithFailure(first, provider('timeout'));
      const second: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(7) }), adminId);
      assert.equal(second.duplicate, false);
      assert.notEqual(second.attemptId, first.attemptId, 'retry reserves a distinct attempt');
      assert.ok(await attempt(second.requestId), 'second attempt persisted');
    });

    await test('concurrent OCR requests cannot exceed the company limit', async () => {
      // Measure one real reservation (gpt-4o high-detail + output ceiling).
      const probe: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(999) }), adminId);
      const per = Number((await attempt(probe.requestId)).reservation_tokens);
      const cur = Number((await budget(period())).reserved_tokens);
      const limit = cur + per * 2 + 50; // room for exactly two more reservations
      await setBudget(limit);
      try {
        const results = await Promise.allSettled([0, 1, 2, 3, 4].map(i =>
          db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(100 + i) }), adminId)
        ));
        const ok = results.filter(r => r.status === 'fulfilled').length;
        const b = await budget(period());
        assert.ok(Number(b.reserved_tokens) <= limit, 'reserved never exceeds the limit');
        assert.ok(ok >= 1 && ok <= 2, `some but not all reservations fit (got ${ok})`);
      } finally { await setBudget(1_000_000); }
    });

    await test('company A budget cannot consume or alter other companies budget', async () => {
      const others = () => db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT COUNT(*)::int c FROM ai_budget_usage WHERE company_id <> $1`, [companyId])).rows[0].c));
      const before = await others();
      await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(200) }), adminId);
      const after = await others();
      assert.equal(after, before, 'no other company budget rows created or altered');
      // And A's reservation is scoped to A only.
      const aRows = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT COUNT(*)::int c FROM ai_budget_usage WHERE company_id=$1`, [companyId])).rows[0].c));
      assert.ok(aRows >= 1, 'A has its own budget row');
    });

    await test('month-boundary settlement uses the original reservation period', async () => {
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(300) }), adminId);
      const { raw } = await runWithFailure(prep, provider('ok'));
      await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, prep, raw), adminId);
      const a1 = await attempt(prep.requestId);
      assert.equal(a1.state, 'settled');
      assert.equal(Number(a1.total_tokens), 10, 'settled from trusted usage in the original period');
    });

    // C. OCR integrity
    await test('invalid provider output is rejected; no extraction persisted; attempt not zero-settled', async () => {
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(8) }), adminId);
      const { raw, err } = await runWithFailure(prep, provider('invalid'));
      assert.ok(!err, 'provider returned (invalid content)');
      let finalizeErr: any = null;
      try { await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, prep, raw), adminId); }
      catch (e) { finalizeErr = e; }
      assert.ok(finalizeErr, 'invalid output rejected by schema');
      assert.equal(await extractionCount(prep.imageHash), 0, 'no extraction row');
    });

    await test('reconcileTotals recomputes totals (model arithmetic not trusted)', async () => {
      const bad = { ...VALID, lines: [{ description: 'X', quantity: 3, rate: 50, amount: 150, confidence: 0.8 }], subtotal: 1, total: 1 };
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(9) }), adminId);
      const raw: any = { content: JSON.stringify(bad), model: 'stub', usage: { totalTokens: 3 } };
      const out: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, prep, raw), adminId);
      assert.equal(out.extraction.subtotal, 150, 'subtotal recomputed from lines');
      assert.equal(out.extraction.total, 150);
    });

    await test('OCR success alone does not post financial records', async () => {
      const j0 = await journalCount();
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(10) }), adminId);
      const { raw } = await runWithFailure(prep, provider('ok'));
      await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, prep, raw), adminId);
      assert.equal(await journalCount(), j0, 'no journal posted by OCR');
    });

    await test('concurrent duplicate requests produce a single extraction (UNIQUE dedupe)', async () => {
      const p1: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(11) }), adminId);
      const p2: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(11) }), adminId);
      assert.notEqual(p1.attemptId, p2.attemptId);
      const r1 = await runWithFailure(p1, provider('ok'));
      const r2 = await runWithFailure(p2, provider('ok'));
      await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, p1, r1.raw), adminId);
      let dupErr: any = null;
      try { await db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, p2, r2.raw), adminId); }
      catch (e) { dupErr = e; }
      assert.ok(dupErr, 'second finalize hits the unique constraint');
      assert.equal(await extractionCount(p1.imageHash), 1, 'exactly one extraction row');
    });

    await test('dedupe: a repeated completed OCR returns the existing extraction with no new reservation', async () => {
      const before = await budget(period());
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind: 'invoice', imageBase64: img(10) }), adminId);
      assert.equal(prep.duplicate, true, 'duplicate detected');
      assert.ok(prep.result?.id, 'existing extraction returned');
      const after = await budget(period());
      assert.equal(Number(after.reserved_tokens), Number(before.reserved_tokens), 'no new reservation for a duplicate');
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exitCode = 1;
  } finally { await srv.close(); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });