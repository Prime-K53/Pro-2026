/**
 * Phase 3 — Action intelligence: executable quote drafts, maker-checker,
 * proposal-type validation, and auto-propose (never auto-execute).
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import * as aiService from '../../src/server/services/aiService.ts';

type Actor = { userId: number; username: string; role: any };
let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  [FAIL] ${name} — ${err?.message || err}`);
  }
}
async function expectCode(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (err: any) {
    assert.equal(err?.code, code, `expected ${code}, got ${err?.code} (${err?.message})`);
    return;
  }
  throw new Error(`expected rejection ${code}, but succeeded`);
}

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const { db } = srv;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(`SELECT id FROM companies ORDER BY id ASC LIMIT 1`);
      return Number(r.rows[0].id);
    });
    const uid = async (u: string) =>
      db.withSystemDb(async (tx: any) => {
        const r = await tx.query(`SELECT id FROM users WHERE username = $1`, [u]);
        return Number(r.rows[0].id);
      });
    const admin: Actor = { userId: await uid('admin'), username: 'admin', role: 'Administrator' };
    const accountant: Actor = { userId: await uid('accountant'), username: 'accountant', role: 'Accountant' };
    const production: Actor = { userId: await uid('production'), username: 'production', role: 'ProductionManager' };
    const noAccess: Actor = { userId: 999999, username: 'noaccess', role: 'NoAccess' };

    const customerId = await db.withCompanyDb(companyId, async (tx: any) => {
      const r = await tx.query(`SELECT id FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1`, [companyId]);
      return Number(r.rows[0].id);
    });
    assert.ok(customerId > 0, 'need a seeded customer');

    const quoteParams = (title: string) => ({
      customerId,
      title,
      lines: [{ description: 'A4 80gsm', quantity: 100, unitPrice: 5 }],
      taxRate: 0,
    });
    const quoteCount = (title: string) =>
      db.withCompanyDb(companyId, async (tx: any) => {
        const r = await tx.query(`SELECT count(*)::int AS c FROM quotes WHERE company_id = $1 AND title = $2`, [companyId, title]);
        return Number(r.rows[0].c);
      });
    const propose = (actor: Actor, type: string, params: any) =>
      db.withCompanyDb(companyId, (tx: any) => aiService.proposeAction(tx, companyId, actor.userId, null, type, 'test', params));
    const approve = (actor: Actor, id: number) =>
      db.withCompanyDb(companyId, (tx: any) => aiService.approveProposedAction(tx, companyId, actor, id));
    const execute = (actor: Actor, id: number) =>
      db.withCompanyDb(companyId, (tx: any) => aiService.executeProposedAction(tx, companyId, actor, id));

    console.log('=== Phase 3: Action Intelligence ===\n');

    await test('create_quote_draft executes into a real draft quote', async () => {
      const title = `AI Quote ${Date.now()}`;
      const a = await propose(accountant, 'create_quote_draft', quoteParams(title));
      await approve(admin, a.id);
      const ex = await execute(admin, a.id); // admin ≠ creator
      assert.equal(ex.status, 'executed');
      assert.equal(await quoteCount(title), 1);
    });

    await test('creator cannot approve own quote-draft proposal', async () => {
      const a = await propose(accountant, 'create_quote_draft', quoteParams(`x${Date.now()}`));
      await expectCode(() => approve(accountant, a.id), 'AI_ACTION_SELF_APPROVAL');
    });

    await test('executor without estimates:write is rejected', async () => {
      const a = await propose(accountant, 'create_quote_draft', quoteParams(`y${Date.now()}`));
      await approve(admin, a.id);
      await expectCode(() => execute(noAccess, a.id), 'PERMISSION_DENIED');
    });

    await test('unknown action type rejected at propose time', async () => {
      await expectCode(() => propose(admin, 'delete_everything', {}), 'AI_ACTION_UNSUPPORTED_TYPE');
    });

    await test('proposable but non-executable type (start_workflow) throws at execute', async () => {
      const a = await propose(accountant, 'start_workflow', { customerId });
      await approve(admin, a.id);
      await expectCode(() => execute(admin, a.id), 'AI_ACTION_UNSUPPORTED');
    });

    await test('AI-generated create_invoice: human approves & executes (invoice created)', async () => {
      const before = await db.withCompanyDb(companyId, async (tx: any) =>
        Number((await tx.query(`SELECT count(*)::int c FROM invoices WHERE company_id=$1`, [companyId])).rows[0].c), admin.userId);
      const a = await db.withCompanyDb(companyId, (tx: any) =>
        aiService.proposeAction(tx, companyId, accountant.userId, null, 'create_invoice', 'AI invoice',
          { customerId, invoiceDate: '2026-11-27', taxRate: 0, lines: [{ description: 'AI line', quantity: 2, rate: 15 }] },
          { isAiGenerated: true }));
      // AI is the maker, so the requesting human may approve and execute.
      await approve(admin, a.id);
      const ex = await execute(admin, a.id);
      assert.equal(ex.status, 'executed');
      const after = await db.withCompanyDb(companyId, async (tx: any) =>
        Number((await tx.query(`SELECT count(*)::int c FROM invoices WHERE company_id=$1`, [companyId])).rows[0].c), admin.userId);
      assert.equal(after, before + 1, 'one invoice created');
    });

    await test('auto-propose from model JSON creates a pending action (no execution)', async () => {
      const conv = await db.withCompanyDb(companyId, (tx: any) => aiService.createConversation(tx, companyId, admin.userId, 'auto'));
      const prep = await db.withCompanyDb(companyId, async (tx: any) => {
        const userMsgRes = await tx.query(
          `INSERT INTO ai_messages (company_id, conversation_id, role, content) VALUES ($1,$2,'user','hi') RETURNING id, company_id, conversation_id, role, content, source_citations, token_count, created_at`,
          [companyId, conv.id]
        );
        const r = userMsgRes.rows[0];
        return {
          conversationId: conv.id,
          userId: admin.userId,
          userMessage: { id: Number(r.id), companyId: Number(r.company_id), conversationId: Number(r.conversation_id), role: r.role, content: r.content, sourceCitations: null, tokenCount: null, createdAt: r.created_at },
          evidence: { companyId, domain: 'general', asOf: '2026-11-27', items: [], complete: true, abstain: false },
          messages: [],
        };
      });
      const before = await db.withCompanyDb(companyId, (tx: any) => aiService.listProposedActions(tx, companyId, 'pending'));
      const modelJson = JSON.stringify({
        claims: [],
        explanation: 'Prepared a draft quote.',
        proposedAction: { actionType: 'create_quote_draft', description: 'draft', parameters: quoteParams(`auto${Date.now()}`) },
      });
      await db.withCompanyDb(companyId, (tx: any) => aiService.finalizeChat(tx, companyId, prep as any, { content: modelJson }));
      const after = await db.withCompanyDb(companyId, (tx: any) => aiService.listProposedActions(tx, companyId, 'pending'));
      assert.ok(after.length > before.length, 'a pending proposal must be created');
      const created = after[0];
      assert.equal(created.status, 'pending');
      assert.equal(created.actionType, 'create_quote_draft');
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