/**
 * Phase 4 — Document intelligence: receipt/supplier_bill kinds, confidence gate,
 * business-document dedup, and server-side total recomputation. Provider is a
 * stub (no network); real PGlite + real ocrService.
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import * as ocrService from '../../src/server/services/ocrService.ts';
import { encryptSecret } from '../../src/server/services/secretCrypto.ts';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e: any) { failed++; console.error(`  [FAIL] ${name} — ${e?.message || e}`); }
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const img = (n = 0) => (n === 0 ? PNG : PNG.slice(0, -2) + String(n).padStart(2, '0'));

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
    await db.withCompanyDb(companyId, (tx: any) => tx.query(
      `INSERT INTO ai_budgets (company_id, monthly_token_limit, monthly_cost_limit) VALUES ($1,1000000,0)
       ON CONFLICT (company_id) DO UPDATE SET monthly_token_limit = EXCLUDED.monthly_token_limit`, [companyId]), adminId);

    const stub = (obj: any) => async (_cfg: any, _msgs: any) => ({ content: JSON.stringify(obj), model: 'stub', usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } });
    const run = async (kind: any, image: string, obj: any) => {
      const prep: any = await db.withCompanyDb(companyId, (tx: any) => ocrService.prepareOcrExtraction(tx, companyId, actor, { kind, imageBase64: image }), adminId);
      const raw = await ocrService.runOcrProvider(prep, stub(obj));
      return db.withCompanyDb(companyId, (tx: any) => ocrService.finalizeOcrExtraction(tx, companyId, actor, prep, raw), adminId);
    };
    const statusOf = (id: string) => db.withCompanyDb(companyId, async (tx: any) =>
      (await tx.query(`SELECT status FROM ocr_extractions WHERE company_id=$1 AND id=$2::uuid`, [companyId, id])).rows[0]?.status, adminId);

    console.log('=== Phase 4: Document Intelligence ===\n');

    await test('supplier_bill kind is accepted and persisted', async () => {
      const out: any = await run('supplier_bill', img(1), {
        kind: 'supplier_bill', counterpartyName: 'PaperCo', date: '2026-02-01', currency: 'MWK', taxRate: 0,
        lines: [{ description: 'A4', quantity: 10, rate: 20, amount: 200, confidence: 0.9 }],
        subtotal: 200, tax: 0, total: 200, confidence: 0.9,
      });
      assert.equal(out.extraction.kind, 'supplier_bill');
      assert.equal(out.needsReview, false);
    });

    await test('receipt kind is accepted', async () => {
      const out: any = await run('receipt', img(2), {
        kind: 'receipt', counterpartyName: 'WalkIn', date: '2026-02-02', currency: 'MWK', taxRate: 0,
        paymentMethod: 'cash', lines: [{ description: 'Print', quantity: 1, rate: 50, amount: 50, confidence: 0.8 }],
        subtotal: 50, tax: 0, total: 50, confidence: 0.8,
      });
      assert.equal(out.extraction.kind, 'receipt');
    });

    await test('low confidence blocks auto-fill (needs_review)', async () => {
      const out: any = await run('invoice', img(3), {
        kind: 'invoice', counterpartyName: 'LowConf', date: '2026-02-03', currency: 'MWK', taxRate: 0,
        lines: [{ description: 'X', quantity: 1, rate: 10, amount: 10, confidence: 0.2 }],
        subtotal: 10, tax: 0, total: 10, confidence: 0.3,
      });
      assert.equal(out.needsReview, true);
      assert.equal(await statusOf(out.id), 'needs_review');
    });

    await test('business dedup flags same counterparty/date/total on a different image', async () => {
      const base = { kind: 'invoice', counterpartyName: 'DupCo', date: '2026-02-04', currency: 'MWK', taxRate: 0, lines: [{ description: 'Y', quantity: 2, rate: 100, amount: 200, confidence: 0.9 }], subtotal: 200, tax: 0, total: 200, confidence: 0.9 };
      const first: any = await run('invoice', img(4), base);
      assert.equal(first.businessDuplicate, false);
      const second: any = await run('invoice', img(5), base);
      assert.equal(second.businessDuplicate, true, 'second identical business doc flagged');
    });

    await test('model amount is ignored; totals recomputed from quantity*rate', async () => {
      const out: any = await run('invoice', img(6), {
        kind: 'invoice', counterpartyName: 'Recon', date: '2026-02-05', currency: 'MWK', taxRate: 0,
        lines: [{ description: 'Z', quantity: 3, rate: 50, amount: 999, confidence: 0.9 }],
        subtotal: 1, tax: 0, total: 1, confidence: 0.9,
      });
      assert.equal(out.extraction.subtotal, 150, 'subtotal from qty*rate, not model amount');
      assert.equal(out.extraction.total, 150);
    });

    await test('OCR never posts financial records', async () => {
      const j0 = await db.withCompanyDb(companyId, async (tx: any) => Number((await tx.query(`SELECT count(*)::int c FROM journal_transactions WHERE company_id=$1`, [companyId])).rows[0].c), adminId);
      await run('invoice', img(7), { kind: 'invoice', counterpartyName: 'NoPost', date: '2026-02-06', currency: 'MWK', taxRate: 0, lines: [{ description: 'Q', quantity: 1, rate: 1, amount: 1, confidence: 0.9 }], subtotal: 1, tax: 0, total: 1, confidence: 0.9 });
      const j1 = await db.withCompanyDb(companyId, async (tx: any) => Number((await tx.query(`SELECT count(*)::int c FROM journal_transactions WHERE company_id=$1`, [companyId])).rows[0].c), adminId);
      assert.equal(j1, j0);
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exitCode = 1;
  } finally { await srv.close(); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });