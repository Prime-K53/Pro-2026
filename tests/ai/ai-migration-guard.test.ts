/**
 * D-05/R7 — migration rollback safeguard.
 *
 * Verifies that migrations 0087 (deletes recovery audit history + actor) and
 * 0088 (drops the race-safety unique username index) are refused BEFORE any
 * down-migration SQL executes, that 0086 and 0089 remain permitted, and that a
 * refused rollback leaves schema, data, and migration history unchanged.
 */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  PROTECTED_DOWN_VERSIONS,
  assertDownAllowed,
  getAppliedMigrations,
  migrateDown,
  migrateUp,
} from '../../db/migrator.ts';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  [FAIL] ${name} — ${e?.message || e}`);
  }
}

/**
 * Recording executor that satisfies the migrator's introspection calls but
 * records every statement, so a refused rollback can be proven to have issued
 * no down-migration SQL and no transaction.
 */
function makeRecordingDb(applied: string[]) {
  const calls: string[] = [];
  return {
    calls,
    async exec(sql: string) {
      calls.push(sql);
    },
    async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
      calls.push(sql);
      if (/FROM schema_migrations/i.test(sql)) {
        return {
          rows: applied.map((version) => ({
            version,
            name: `synthetic_${version}`,
            checksum_sha256: '0'.repeat(64),
            applied_at: '2026-01-01T00:00:00Z',
            execution_ms: 0,
          })) as unknown as T[],
        };
      }
      return { rows: [] as T[] };
    },
  };
}

const forbid = /BEGIN|DROP INDEX\s+IF EXISTS\s+users_username_uniq|DELETE FROM ai_audit_logs|DELETE FROM users/i;

console.log('=== D-05/R7 migration rollback guard ===\n');

await test('0087 down is refused (audit-retention reason) before any SQL', async () => {
  assert.throws(() => assertDownAllowed('0087'), /Protected migration 0087.*audit/is);
  assert.match(String(PROTECTED_DOWN_VERSIONS['0087']), /audit/i);

  const db = makeRecordingDb(['0087']);
  await assert.rejects(() => migrateDown(db, { steps: 1 }), /Protected migration 0087/i);
  const offending = db.calls.filter((s) => forbid.test(s));
  assert.deepEqual(offending, [], `No down SQL/transaction may run; got: ${offending.join(' | ')}`);
});

await test('0088 down is refused (unique-username race-safety reason) before any SQL', async () => {
  assert.throws(() => assertDownAllowed('0088'), /Protected migration 0088.*unique/is);
  assert.match(String(PROTECTED_DOWN_VERSIONS['0088']), /unique/i);

  const db = makeRecordingDb(['0088']);
  await assert.rejects(() => migrateDown(db, { steps: 1 }), /Protected migration 0088/i);
  const offending = db.calls.filter((s) => forbid.test(s));
  assert.deepEqual(offending, [], `No down SQL/transaction may run; got: ${offending.join(' | ')}`);
});

await test('0086 and 0089 remain permitted', async () => {
  assert.doesNotThrow(() => assertDownAllowed('0086'));
  assert.doesNotThrow(() => assertDownAllowed('0089'));
  assert.equal(PROTECTED_DOWN_VERSIONS['0086'], undefined);
  assert.equal(PROTECTED_DOWN_VERSIONS['0089'], undefined);
});

await test('multi-step rollback is refused wholesale when a protected version is in range', async () => {
  // 0089 (permitted) + 0088 (protected) planned together: nothing may run.
  const db = makeRecordingDb(['0089', '0088']);
  await assert.rejects(() => migrateDown(db, { steps: 2 }), /Protected migration 0088/i);
  const offending = db.calls.filter((s) => forbid.test(s));
  assert.deepEqual(offending, [], `Wholesale refusal must run no down SQL; got: ${offending.join(' | ')}`);
});

console.log('\n--- real database (PGlite/Postgres 17): schema/data/history preservation ---\n');

await test('0086 rollback permitted; 0087/0088 refused; state unchanged; 0089 permitted', async () => {
  const db = new PGlite();

  // 1) 0086 rollback is permitted.
  await migrateUp(db, { targetVersion: '0086' });
  const down86 = await migrateDown(db, { steps: 1 });
  assert.deepEqual(down86.rolledBack, ['0086'], '0086 down must execute (permitted)');

  // 2) Re-apply through 0088 so 0088 is the topmost applied migration.
  const upTo88 = await migrateUp(db, { targetVersion: '0088' });
  assert.deepEqual(upTo88.applied, ['0086', '0087', '0088']);

  // Seed data that 0087's destructive down would delete, plus the 0088 index.
  await db.exec(`SET app.bypass_rls = 'on';`);
  const comp = await db.query<{ id: number }>(
    `INSERT INTO companies (slug, name, legal_name, base_currency, currency_symbol)
     VALUES ('guard-co', 'Guard Co', 'Guard Co Ltd', 'ZMW', 'K') RETURNING id`
  );
  const companyId = Number(comp.rows[0].id);
  await db.query(`SELECT set_config('app.current_company_id', $1, false)`, [String(companyId)]);
  const usr = await db.query<{ id: number }>(
    `INSERT INTO users (username, email, display_name, password_hash, is_active)
     VALUES ('system-recovery', 'system-recovery@local.invalid', 'System Recovery', '!', FALSE)
     RETURNING id`
  );
  const userId = Number(usr.rows[0].id);
  await db.query(
    `INSERT INTO ai_audit_logs (company_id, user_id, action, query, response_summary)
     VALUES ($1, $2, 'AI_RECOVERY', 'guard-test', 'must survive refused rollback')`,
    [companyId, userId]
  );

  const appliedBefore = (await getAppliedMigrations(db)).map((r) => r.version);
  const indexBefore = await db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_username_uniq'`
  );
  assert.equal(indexBefore.rows.length, 1, '0088 must create users_username_uniq');
  const auditBefore = await db.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM ai_audit_logs`);

  // 3) 0088 (topmost) rollback is refused before SQL; nothing changes.
  await assert.rejects(() => migrateDown(db, { steps: 1 }), /Protected migration 0088/i);

  const appliedAfter = (await getAppliedMigrations(db)).map((r) => r.version);
  assert.deepEqual(appliedAfter, appliedBefore, 'migration history must be unchanged');
  assert.ok(appliedAfter.includes('0087') && appliedAfter.includes('0088'));

  const indexAfter = await db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_username_uniq'`
  );
  assert.equal(indexAfter.rows.length, 1, 'schema unchanged: unique username index must survive');

  const usersAfter = await db.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM users WHERE username = 'system-recovery'`
  );
  assert.equal(usersAfter.rows[0].cnt, '1', 'data unchanged: recovery actor must survive');

  const auditAfter = await db.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM ai_audit_logs`);
  assert.equal(auditAfter.rows[0].cnt, auditBefore.rows[0].cnt, 'data unchanged: audit rows must survive');

  // 4) 0087 rollback is also refused (it is below 0088, so target it directly).
  await assert.rejects(() => migrateDown(db, { targetVersion: '0086' }), /Protected migration 0088/i);

  // 5) latest migration rollback remains permitted (non-destructive no-op).
  const up89 = await migrateUp(db);
  assert.deepEqual(up89.applied, ['0089', '0090', '0091', '0092', '0093']);
  const down89 = await migrateDown(db, { steps: 1 });
  assert.deepEqual(down89.rolledBack, ['0093'], 'latest (0093) down must execute (permitted no-op)');

  await db.close();
});

console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
if (failed) process.exitCode = 1;
