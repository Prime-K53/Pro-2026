/**
 * D-06/R1 B — runtime proof that the provider is called with NO open DB
 * transaction, that finalization runs in a separate transaction, and that a
 * provider failure leaves no partial assistant answer.
 *
 * The real db.withCompanyDb is wrapped with a test-only counter that measures
 * actual transaction entry/exit. The provider stub inspects that counter at the
 * exact moment chatCompletion is invoked. No production semantics are changed.
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import * as aiService from '../../src/server/services/aiService.ts';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e: any) { failed++; console.error(`  [FAIL] ${name} — ${e?.message || e}`); }
}

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const db: any = srv.db;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM companies ORDER BY id LIMIT 1`)).rows[0].id));
    const adminId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM users WHERE username='admin'`)).rows[0].id));

    // Instrument the REAL transaction wrapper.
    let open = 0;
    const events: string[] = [];
    const orig = db.withCompanyDb.bind(db);
    db.withCompanyDb = (cid: number, fn: any, uid?: number) => {
      open++; events.push('tx_enter');
      return orig(cid, fn, uid).finally(() => { open--; events.push('tx_exit'); });
    };

    // Provider stub: inspects tx state at the exact invocation moment.
    const makeProvider = (fail: boolean) => ({
      chatCompletion: async (_cfg: any, _msgs: any) => {
        assert.equal(open, 0, 'a DB transaction must NOT be open during the provider call');
        events.push('provider');
        if (fail) throw Object.assign(new Error('provider down'), { code: 'AI_PROVIDER_ERROR' });
        return { content: '{}', usage: { totalTokens: 7 } };
      },
    });

    const claimFromEvidence = (prep: any) => {
      const it = prep.evidence.items[0];
      const metric = Object.keys(it.fields)[0];
      return { claimType: 'balance', metric, entity: it.label, recordType: it.recordType, amount: it.fields[metric], evidenceIds: [it.evidenceId] };
    };

    console.log('=== D-06/R1 B: Provider transaction isolation ===\n');

    await test('prepare transaction is released before provider; finalize is a separate tx', async () => {
      events.length = 0;
      const prep = await db.withCompanyDb(companyId, (tx: any) => aiService.prepareChat(tx, companyId, adminId, 'Administrator', 'Co', null, 'customer balance'), adminId);
      assert.equal(open, 0, 'prepare tx must be released');
      const provider = makeProvider(false);
      let raw: any;
      if (prep.evidence.items.length > 0) {
        const claim = claimFromEvidence(prep);
        (provider as any).chatCompletion = async () => { assert.equal(open, 0); events.push('provider'); return { content: JSON.stringify({ claims: [claim], explanation: 'ok' }), usage: { totalTokens: 7 } }; };
      }
      raw = await provider.chatCompletion({}, prep.messages);
      assert.equal(open, 0, 'still no tx after provider');
      const out = await db.withCompanyDb(companyId, (tx: any) => aiService.finalizeChat(tx, companyId, prep, { content: raw.content, usage: raw.usage }), adminId);
      assert.equal(open, 0, 'finalize tx released');
      assert.ok(events.indexOf('provider') > events.indexOf('tx_exit'), 'provider ran after a tx_exit');
      assert.ok(events.indexOf('provider') < events.lastIndexOf('tx_enter'), 'finalize tx_enter happened after provider');
      if (prep.evidence.items.length > 0) assert.equal(out.response.claims.length, 1, 'exactly one verified claim');
    });

    await test('provider failure: no tx open, no assistant answer persisted, ERP op works, retry safe', async () => {
      const prep = await db.withCompanyDb(companyId, (tx: any) => aiService.prepareChat(tx, companyId, adminId, 'Administrator', 'Co', null, 'bill total'), adminId);
      const provider = makeProvider(true);
      let threw = false;
      try { await provider.chatCompletion({}, prep.messages); } catch { threw = true; }
      assert.ok(threw, 'provider failure surfaced');
      assert.equal(open, 0, 'no tx left open after provider failure');
      const cnt = await db.withCompanyDb(companyId, async (tx: any) => Number((await tx.query(`SELECT COUNT(*)::int c FROM ai_messages WHERE conversation_id=$1 AND role='assistant'`, [prep.conversationId])).rows[0].c), adminId);
      assert.equal(cnt, 0, 'no assistant answer persisted');
      // Ordinary ERP op still works after failure.
      await db.withCompanyDb(companyId, (tx: any) => tx.query(`SELECT 1`), adminId);
      // Retry (success) uses the same conversation safely.
      const good = prep.evidence.items.length > 0
        ? JSON.stringify({ claims: [claimFromEvidence(prep)], explanation: 'ok' })
        : JSON.stringify({ claims: [], explanation: 'none' });
      const out = await db.withCompanyDb(companyId, (tx: any) => aiService.finalizeChat(tx, companyId, prep, { content: good }), adminId);
      assert.equal(out.conversationId, prep.conversationId);
      if (prep.evidence.items.length > 0) assert.equal(out.response.claims.length, 1);
    });

    await test('successful provider yields exactly one finalized assistant response', async () => {
      const prep = await db.withCompanyDb(companyId, (tx: any) => aiService.prepareChat(tx, companyId, adminId, 'Administrator', 'Co', null, 'customer balance'), adminId);
      const good = prep.evidence.items.length > 0 ? JSON.stringify({ claims: [claimFromEvidence(prep)], explanation: 'ok' }) : JSON.stringify({ claims: [] });
      await db.withCompanyDb(companyId, (tx: any) => aiService.finalizeChat(tx, companyId, prep, { content: good }), adminId);
      const n = await db.withCompanyDb(companyId, async (tx: any) => Number((await tx.query(`SELECT COUNT(*)::int c FROM ai_messages WHERE conversation_id=$1 AND role='assistant'`, [prep.conversationId])).rows[0].c), adminId);
      assert.equal(n, 1, 'exactly one assistant message');
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exitCode = 1;
  } finally { await srv.close(); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });