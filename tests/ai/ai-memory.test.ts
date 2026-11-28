/**
 * Phase 2 — AI semantic memory: reindex, recall, isolation, prune.
 * Uses a deterministic fake embedder (no network) against an in-memory PGlite DB.
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import * as mem from '../../src/server/services/aiMemoryService.ts';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  [FAIL] ${name} — ${err?.message || err}`);
  }
}

// Deterministic, non-zero embedding: 8-dim char-class histogram.
const embed: mem.EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = new Array(8).fill(0);
    for (const ch of t) v[ch.charCodeAt(0) % 8] += 1;
    return v;
  });

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const { db } = srv;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(`SELECT id FROM companies ORDER BY id ASC LIMIT 1`);
      return Number(r.rows[0].id);
    });

    console.log('=== Phase 2: AI Semantic Memory ===\n');

    await test('cosine of identical vectors is 1; orthogonal is 0', () => {
      assert.ok(Math.abs(mem.cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
      assert.equal(mem.cosine([1, 0], [0, 1]), 0);
      assert.equal(mem.cosine([], [1]), 0);
    });

    let upserted = 0;
    await test('reindex upserts chunks', async () => {
      const r = await db.withCompanyDb(companyId, (tx: any) => mem.reindexCompany(tx, companyId, embed));
      upserted = r.upserted;
      assert.ok(upserted > 0, 'expected some chunks');
    });

    await test('recall finds the exact chunk with score ~1', async () => {
      const chunks = await db.withCompanyDb(companyId, (tx: any) => mem.buildMemoryChunks(tx, companyId));
      const target = chunks[0];
      const qEmb = (await embed([target.content]))[0];
      const hits = await db.withCompanyDb(companyId, (tx: any) => mem.recall(tx, companyId, qEmb, { k: 3 }));
      assert.ok(hits.length >= 1);
      assert.equal(hits[0].recordType, target.recordType);
      assert.equal(hits[0].recordId, target.recordId);
      assert.ok(hits[0].score > 0.999, `expected ~1, got ${hits[0].score}`);
    });

    await test('recall with kinds filter only returns those kinds', async () => {
      const chunks = await db.withCompanyDb(companyId, (tx: any) => mem.buildMemoryChunks(tx, companyId));
      const product = chunks.find((c) => c.kind === 'product');
      if (!product) return; // no products in seed
      const qEmb = (await embed([product.content]))[0];
      const hits = await db.withCompanyDb(companyId, (tx: any) => mem.recall(tx, companyId, qEmb, { k: 5, kinds: ['product'] }));
      assert.ok(hits.every((h) => h.kind === 'product'));
    });

    await test('cross-company recall returns nothing (isolation)', async () => {
      const chunks = await db.withCompanyDb(companyId, (tx: any) => mem.buildMemoryChunks(tx, companyId));
      const qEmb = (await embed([chunks[0].content]))[0];
      const hits = await db.withCompanyDb(companyId + 999999, (tx: any) => mem.recall(tx, companyId + 999999, qEmb, { k: 5 }));
      assert.equal(hits.length, 0);
    });

    await test('prune removes chunks for deactivated products', async () => {
      const before = await db.withSystemDb(async (tx: any) => {
        const r = await tx.query(`SELECT count(*)::int AS n FROM ai_memory_chunks WHERE company_id = $1 AND kind = 'product'`, [companyId]);
        return Number(r.rows[0].n);
      });
      if (before === 0) return;
      await db.withCompanyDb(companyId, (tx: any) =>
        tx.query(`UPDATE inventory_items SET is_active = FALSE WHERE company_id = $1 AND id = (SELECT id FROM inventory_items WHERE company_id = $1 AND is_active = TRUE LIMIT 1)`, [companyId])
      );
      const r = await db.withCompanyDb(companyId, (tx: any) => mem.reindexCompany(tx, companyId, embed));
      assert.ok(r.pruned >= 1, `expected pruned>=1, got ${r.pruned}`);
    });

    await test('reindex is idempotent (no duplicate rows)', async () => {
      await db.withCompanyDb(companyId, (tx: any) => mem.reindexCompany(tx, companyId, embed));
      const n = await db.withSystemDb(async (tx: any) => {
        const r = await tx.query(`SELECT count(*)::int AS n FROM ai_memory_chunks WHERE company_id = $1`, [companyId]);
        return Number(r.rows[0].n);
      });
      assert.ok(n <= upserted + 1, `expected stable count, got ${n} vs ${upserted}`);
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await srv.close();
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});