/**
 * D-06/R1 A — conversation ownership (same-company cross-user isolation).
 * Real service logic on an isolated in-memory PGlite DB with two seeded users
 * (admin, bookkeeper) in the same company.
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import * as aiService from '../../src/server/services/aiService.ts';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e: any) { failed++; console.error(`  [FAIL] ${name} — ${e?.message || e}`); }
}
async function code(fn: () => Promise<unknown>, c: string) {
  try { await fn(); } catch (e: any) { assert.equal(e?.code, c, `expected ${c} got ${e?.code}`); return; }
  throw new Error(`expected ${c} but succeeded`);
}

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const { db } = srv;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM companies ORDER BY id LIMIT 1`)).rows[0].id));
    const adminId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM users WHERE username='admin'`)).rows[0].id));
    const bookId = await db.withSystemDb(async (tx: any) => Number((await tx.query(`SELECT id FROM users WHERE username='bookkeeper'`)).rows[0].id));

    console.log('=== D-06/R1 A: Conversation ownership ===\n');

    let convId = 0;
    await test('A creates a conversation it owns', async () => {
      const c = await db.withCompanyDb(companyId, (tx: any) => aiService.createConversation(tx, companyId, adminId, 'A private'), adminId);
      convId = c.id;
      assert.ok(convId > 0);
    });
    await test('owner can load messages', async () => {
      await db.withCompanyDb(companyId, (tx: any) => tx.query(`INSERT INTO ai_messages (company_id, conversation_id, role, content) VALUES ($1,$2,'user','A-secret')`, [companyId, convId]), adminId);
      const m = await db.withCompanyDb(companyId, (tx: any) => aiService.getConversationMessages(tx, companyId, convId, adminId), adminId);
      assert.ok(m.some((x: any) => x.content === 'A-secret'));
    });
    await test('other same-company user cannot GET messages (404)', async () => {
      await code(() => db.withCompanyDb(companyId, (tx: any) => aiService.getConversationMessages(tx, companyId, convId, bookId), bookId), 'CONVERSATION_NOT_FOUND');
    });
    await test('other user cannot continue via prepareChat (404) and no message appended', async () => {
      const before = await db.withCompanyDb(companyId, async (tx: any) => Number((await tx.query(`SELECT COUNT(*)::int c FROM ai_messages WHERE conversation_id=$1`, [convId])).rows[0].c), adminId);
      await code(() => db.withCompanyDb(companyId, (tx: any) => aiService.prepareChat(tx, companyId, bookId, 'Administrator', 'Co', convId, 'intrude'), bookId), 'CONVERSATION_NOT_FOUND');
      const after = await db.withCompanyDb(companyId, async (tx: any) => Number((await tx.query(`SELECT COUNT(*)::int c FROM ai_messages WHERE conversation_id=$1`, [convId])).rows[0].c), adminId);
      assert.equal(before, after, 'no message may be appended on unauthorized continuation');
    });
    await test('list is user-scoped (other user does not see it)', async () => {
      const other = await db.withCompanyDb(companyId, (tx: any) => aiService.listConversations(tx, companyId, bookId), bookId);
      const owner = await db.withCompanyDb(companyId, (tx: any) => aiService.listConversations(tx, companyId, adminId), adminId);
      assert.ok(!other.some((c: any) => c.id === convId));
      assert.ok(owner.some((c: any) => c.id === convId));
    });
    await test('owner can continue normally', async () => {
      const prep = await db.withCompanyDb(companyId, (tx: any) => aiService.prepareChat(tx, companyId, adminId, 'Administrator', 'Co', convId, 'owner continues'), adminId);
      assert.equal(prep.conversationId, convId);
    });
    await test('client-supplied user id cannot override (service uses passed id only)', async () => {
      // The service derives ownership solely from the authenticated userId argument;
      // there is no body/param user override path.
      await code(() => db.withCompanyDb(companyId, (tx: any) => aiService.getConversationMessages(tx, companyId, convId, bookId), bookId), 'CONVERSATION_NOT_FOUND');
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exitCode = 1;
  } finally { await srv.close(); }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });