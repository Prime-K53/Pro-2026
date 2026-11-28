/**
 * D-02 maker-checker integrity tests for AI proposed financial actions.
 *
 * Isolated: boots an in-memory PGlite database (seedDemo) and never touches a
 * real/production database. Exercises the service layer directly with distinct
 * seeded actors, plus a couple of route-level checks that client-supplied
 * approver/executor identity is ignored.
 */
import assert from 'node:assert/strict';
import { startTestServer, loginAdmin } from '../helpers/testServer.ts';
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
    assert.equal(err?.code, code, `expected code ${code}, got ${err?.code} (${err?.message})`);
    return;
  }
  throw new Error(`expected rejection ${code}, but call succeeded`);
}

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const { db } = srv;
  try {
    const companyId = await db.withSystemDb(async tx => {
      const r = await tx.query<{ id: number }>(`SELECT id FROM companies ORDER BY id ASC LIMIT 1`);
      return Number(r.rows[0].id);
    });
    const foreignCompanyId = await db.withSystemDb(async tx => {
      const r = await tx.query<{ id: number }>(`SELECT id FROM companies ORDER BY id ASC OFFSET 1 LIMIT 1`);
      return Number(r.rows[0]?.id ?? 0);
    });
    const uid = async (username: string) =>
      db.withSystemDb(async tx => {
        const r = await tx.query<{ id: number }>(`SELECT id FROM users WHERE username = $1`, [username]);
        return Number(r.rows[0].id);
      });

    const adminId = await uid('admin');
    const bookkeeperId = await uid('bookkeeper');
    const accountantId = await uid('accountant');
    const productionId = await uid('production');

    const admin: Actor = { userId: adminId, username: 'admin', role: 'Administrator' };
    const bookkeeper: Actor = { userId: bookkeeperId, username: 'bookkeeper', role: 'Bookkeeper' };
    const accountant: Actor = { userId: accountantId, username: 'accountant', role: 'Accountant' };
    const production: Actor = { userId: productionId, username: 'production', role: 'ProductionManager' };

    const accounts = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ id: number }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND is_active = TRUE ORDER BY id ASC LIMIT 2`,
        [companyId]
      );
      return r.rows.map(x => Number(x.id));
    });
    assert.ok(accounts.length >= 2, 'need at least two active accounts');

    let refCounter = 0;
    const balancedParams = (ref: string) => ({
      reference: ref,
      txnDate: new Date().toISOString().slice(0, 10),
      lines: [
        { accountId: accounts[0], debit: '100', credit: '0' },
        { accountId: accounts[1], debit: '0', credit: '100' },
      ],
    });
    const unbalancedParams = (ref: string) => ({
      reference: ref,
      txnDate: new Date().toISOString().slice(0, 10),
      lines: [
        { accountId: accounts[0], debit: '100', credit: '0' },
        { accountId: accounts[1], debit: '0', credit: '50' },
      ],
    });

    const propose = (createdBy: number, parameters: any) =>
      db.withCompanyDb(companyId, tx =>
        aiService.proposeAction(tx, companyId, createdBy, null, 'post_journal', 'D-02 test', parameters)
      );
    const approve = (actor: Actor, id: number) =>
      db.withCompanyDb(companyId, tx => aiService.approveProposedAction(tx, companyId, actor, id));
    const reject = (actor: Actor, id: number) =>
      db.withCompanyDb(companyId, tx => aiService.rejectProposedAction(tx, companyId, actor, id));
    const execute = (actor: Actor, id: number, company = companyId) =>
      db.withCompanyDb(company, tx => aiService.executeProposedAction(tx, company, actor, id));
    const journalCount = (ref: string) =>
      db.withCompanyDb(companyId, async tx => {
        const r = await tx.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM journal_transactions WHERE company_id = $1 AND reference = $2`,
          [companyId, ref]
        );
        return Number(r.rows[0].c);
      });
    const reload = (id: number) =>
      db.withCompanyDb(companyId, async tx => {
        const r = await tx.query<any>(`SELECT * FROM ai_proposed_actions WHERE company_id = $1 AND id = $2`, [companyId, id]);
        return r.rows[0];
      });

    console.log('=== D-02 Maker-Checker Integrity Suite ===\n');

    // ── Approval ───────────────────────────────────────────────────────────
    await test('creator cannot approve own proposal', async () => {
      const a = await propose(adminId, balancedParams(`MC-${++refCounter}`));
      await expectCode(() => approve(admin, a.id), 'AI_ACTION_SELF_APPROVAL');
    });

    await test('different authorized user can approve; identity + timestamp persisted', async () => {
      const a = await propose(adminId, balancedParams(`MC-${++refCounter}`));
      const approved = await approve(accountant, a.id);
      assert.equal(approved.status, 'approved');
      assert.equal(approved.approvedBy, accountantId);
      assert.ok(approved.approvedAt);
      const row = await reload(a.id);
      assert.equal(Number(row.approved_by), accountantId);
      assert.ok(row.approved_at);
    });

    await test('unauthorized user (no journals:write) cannot approve', async () => {
      const a = await propose(adminId, balancedParams(`MC-${++refCounter}`));
      await expectCode(() => approve(production, a.id), 'PERMISSION_DENIED');
    });

    await test('already-approved proposal cannot be approved again', async () => {
      const a = await propose(adminId, balancedParams(`MC-${++refCounter}`));
      await approve(accountant, a.id);
      await expectCode(() => approve(bookkeeper, a.id), 'AI_ACTION_INVALID_STATE');
    });

    await test('database rejects nulling the approver on an approved action', async () => {
      const a = await propose(adminId, balancedParams(`MC-${++refCounter}`));
      await approve(accountant, a.id);
      let threw = false;
      try {
        await db.withCompanyDb(companyId, tx =>
          tx.query(`UPDATE ai_proposed_actions SET approved_by = NULL WHERE company_id = $1 AND id = $2`, [companyId, a.id])
        );
      } catch {
        threw = true;
      }
      assert.ok(threw, 'CHECK constraint must prevent removing the approver identity');
    });

    // ── Execution ──────────────────────────────────────────────────────────
    await test('creator cannot execute own proposal', async () => {
      const a = await propose(adminId, balancedParams(`MC-${++refCounter}`));
      await approve(accountant, a.id);
      await expectCode(() => execute(admin, a.id), 'AI_ACTION_SELF_EXECUTION');
    });

    await test('different authorized executor executes approved proposal', async () => {
      const ref = `MC-${++refCounter}`;
      const a = await propose(adminId, balancedParams(ref));
      await approve(accountant, a.id);
      const executed = await execute(bookkeeper, a.id);
      assert.equal(executed.status, 'executed');
      assert.equal(executed.executedBy, bookkeeperId);
      assert.ok(executed.executedAt);
      assert.equal(await journalCount(ref), 1);
    });

    await test('unapproved proposal cannot execute', async () => {
      const a = await propose(adminId, balancedParams(`MC-${++refCounter}`));
      await expectCode(() => execute(bookkeeper, a.id), 'AI_ACTION_NOT_APPROVED');
    });

    await test('unauthorized executor (no journals:write) is rejected', async () => {
      const a = await propose(adminId, balancedParams(`MC-${++refCounter}`));
      await approve(accountant, a.id);
      await expectCode(() => execute(production, a.id), 'PERMISSION_DENIED');
    });

    await test('foreign-company proposal is inaccessible', async () => {
      if (!foreignCompanyId) return; // single-company seed
      const a = await propose(adminId, balancedParams(`MC-${++refCounter}`));
      await expectCode(() => execute(bookkeeper, a.id, foreignCompanyId), 'AI_ACTION_NOT_FOUND');
    });

    await test('already-executed proposal produces no second journal', async () => {
      const ref = `MC-${++refCounter}`;
      const a = await propose(adminId, balancedParams(ref));
      await approve(accountant, a.id);
      await execute(bookkeeper, a.id);
      const again = await execute(bookkeeper, a.id); // idempotent replay
      assert.equal(again.status, 'executed');
      assert.equal(await journalCount(ref), 1);
    });

    await test('failed journal posting fully rolls back execution state', async () => {
      const ref = `MC-${++refCounter}`;
      const a = await propose(adminId, unbalancedParams(ref));
      await approve(accountant, a.id);
      let threw = false;
      try {
        await execute(bookkeeper, a.id);
      } catch {
        threw = true;
      }
      assert.ok(threw, 'unbalanced journal must throw');
      const row = await reload(a.id);
      assert.equal(row.status, 'approved', 'status must remain approved after failed posting');
      assert.equal(row.executed_by, null, 'executed_by must not be set');
      assert.equal(await journalCount(ref), 0, 'no journal may persist');
    });

    // ── Concurrency ────────────────────────────────────────────────────────
    await test('two concurrent approvals → at most one transition', async () => {
      const a = await propose(adminId, balancedParams(`MC-${++refCounter}`));
      const results = await Promise.allSettled([approve(accountant, a.id), approve(bookkeeper, a.id)]);
      const fulfilled = results.filter(r => r.status === 'fulfilled').length;
      assert.equal(fulfilled, 1, 'exactly one approval must win');
    });

    await test('two concurrent executions → exactly one financial posting', async () => {
      const ref = `MC-${++refCounter}`;
      const a = await propose(adminId, balancedParams(ref));
      await approve(accountant, a.id);
      await Promise.allSettled([execute(bookkeeper, a.id), execute(accountant, a.id)]);
      assert.equal(await journalCount(ref), 1, 'exactly one journal must exist');
    });

    await test('concurrent execute + reject → consistent final state', async () => {
      const ref = `MC-${++refCounter}`;
      const a = await propose(adminId, balancedParams(ref));
      await approve(accountant, a.id);
      const results = await Promise.allSettled([execute(bookkeeper, a.id), reject(bookkeeper, a.id)]);
      const execOk = results[0].status === 'fulfilled';
      const rejectOk = results[1].status === 'fulfilled';
      assert.ok(execOk !== rejectOk, 'exactly one of execute/reject must succeed');
      const row = await reload(a.id);
      assert.ok(row.status === 'executed' || row.status === 'rejected');
      assert.ok((await journalCount(ref)) <= 1, 'at most one journal');
    });

    // ── Route-level: client-supplied identity is ignored ───────────────────
    const { client } = await loginAdmin(srv.baseUrl);
    await test('route ignores client-supplied approver identity (creator still blocked)', async () => {
      const created = await client.request('POST', '/api/ai/actions', {
        body: { actionType: 'post_journal', description: 'route spoof', parameters: balancedParams(`MC-${++refCounter}`) },
      });
      assert.equal(created.status, 201, created.text);
      const id = created.json.action.id;
      const res = await client.request('PATCH', `/api/ai/actions/${id}`, {
        body: { status: 'approved', approvedBy: 999999, approvedAt: '2000-01-01T00:00:00Z' },
      });
      assert.equal(res.status, 403, 'creator (auth admin) must be blocked despite spoofed approver in body');
      assert.equal(res.json.code, 'AI_ACTION_SELF_APPROVAL');
    });

    await test('route cannot execute via PATCH status', async () => {
      const created = await client.request('POST', '/api/ai/actions', {
        body: { actionType: 'post_journal', description: 'route exec', parameters: balancedParams(`MC-${++refCounter}`) },
      });
      const id = created.json.action.id;
      const res = await client.request('PATCH', `/api/ai/actions/${id}`, { body: { status: 'executed' } });
      assert.equal(res.status, 400, 'PATCH must not accept executed status');
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await srv.close();
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});