import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SqlExecutor {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface MigrationPair {
  version: string;
  name: string;
  upPath: string;
  downPath: string;
  upSql: string;
  downSql: string;
  checksumSha256: string;
  // Line-ending-normalised (LF) checksum. Git's autocrlf can rewrite the
  // working-tree file from LF to CRLF (or vice-versa) after a migration has
  // already been applied, which would otherwise look like tampering. Comparing
  // against both the raw and the normalised hash keeps the guard effective for
  // real content changes while tolerating pure CRLF/LF churn.
  checksumSha256Normalized: string;
}

export interface AppliedMigrationRecord {
  version: string;
  name: string;
  checksum_sha256: string;
  applied_at: string;
  execution_ms: number;
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(process.cwd(), 'db', 'migrations');

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Migrations whose DOWN script must not be rolled back. Enforced in
 * migrateDown BEFORE any down-migration SQL or transaction is started.
 *
 *  - 0087 down deletes recovery audit rows and the system-recovery actor, which
 *    audit retention forbids.
 *  - 0088 down drops the users.username unique index that makes concurrent
 *    system-recovery identity provisioning race-safe (INSERT ... ON CONFLICT
 *    (username)); removing it would allow duplicate recovery actors.
 *
 * 0089_ai_recovery_actor_durable is the supported, non-destructive terminal
 * migration; its down is a no-op that retains the actor and audit history.
 */
export const PROTECTED_DOWN_VERSIONS: Record<string, string> = {
  '0087':
    'Migration 0087 down deletes recovery audit history and the system-recovery actor. ' +
    'Audit retention forbids rollback; use 0089_ai_recovery_actor_durable instead.',
  '0088':
    'Migration 0088 down drops the users.username unique index (users_username_uniq) required ' +
    'for race-safe system-recovery identity provisioning; removing it would allow duplicate ' +
    'recovery actors. Retained by 0089_ai_recovery_actor_durable.',
};

export function assertDownAllowed(version: string): void {
  if (Object.prototype.hasOwnProperty.call(PROTECTED_DOWN_VERSIONS, version)) {
    throw new Error(
      `Protected migration ${version} cannot be rolled back: ${PROTECTED_DOWN_VERSIONS[version]}`
    );
  }
}

/** Normalise CRLF/CR to LF so checksums are independent of line-ending style. */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function loadMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR): MigrationPair[] {
  const files = fs.readdirSync(migrationsDir).sort();
  const upFiles = files.filter(f => f.endsWith('.up.sql'));

  return upFiles.map(upFile => {
    const base = upFile.replace(/\.up\.sql$/, '');
    const match = base.match(/^(\d+)_(.+)$/);
    if (!match) {
      throw new Error(`Invalid migration filename format: ${upFile}. Expected NNNN_description.up.sql`);
    }
    const [, version, name] = match;
    const downFile = `${base}.down.sql`;
    const upPath = path.join(migrationsDir, upFile);
    const downPath = path.join(migrationsDir, downFile);

    if (!fs.existsSync(downPath)) {
      throw new Error(`Missing paired rollback migration for ${upFile}: expected ${downFile}`);
    }

    const upSql = fs.readFileSync(upPath, 'utf8');
    const downSql = fs.readFileSync(downPath, 'utf8');

    return {
      version,
      name,
      upPath,
      downPath,
      upSql,
      downSql,
      checksumSha256: sha256(upSql),
      checksumSha256Normalized: sha256(normalizeLineEndings(upSql)),
    };
  });
}

export async function ensureSchemaMigrationsTable(db: SqlExecutor): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version         VARCHAR(32) PRIMARY KEY,
      name            VARCHAR(200) NOT NULL,
      checksum_sha256 CHAR(64) NOT NULL,
      applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      execution_ms    INTEGER NOT NULL CHECK (execution_ms >= 0)
    );
  `);
}

export async function getAppliedMigrations(db: SqlExecutor): Promise<AppliedMigrationRecord[]> {
  await ensureSchemaMigrationsTable(db);
  const res = await db.query<AppliedMigrationRecord>(
    `SELECT version, name, checksum_sha256, applied_at::text AS applied_at, execution_ms
       FROM schema_migrations
      ORDER BY version ASC`
  );
  return res.rows;
}

export async function migrateUp(
  db: SqlExecutor,
  options: { targetVersion?: string; migrationsDir?: string } = {}
): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureSchemaMigrationsTable(db);
  const all = loadMigrations(options.migrationsDir);
  const appliedRows = await getAppliedMigrations(db);
  const appliedMap = new Map(appliedRows.map(r => [r.version, r]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const mig of all) {
    if (options.targetVersion && mig.version > options.targetVersion) {
      break;
    }

    const existing = appliedMap.get(mig.version);
    if (existing) {
      // Accept either the raw or the LF-normalised checksum. This tolerates
      // git autocrlf rewriting line endings after a migration was applied while
      // still rejecting genuine content changes.
      const rawMatches = existing.checksum_sha256 === mig.checksumSha256;
      const normalizedMatches =
        existing.checksum_sha256 === mig.checksumSha256Normalized;
      if (!rawMatches && !normalizedMatches) {
        throw new Error(
          `Checksum mismatch for already-applied migration ${mig.version}_${mig.name}: ` +
            `recorded=${existing.checksum_sha256}, disk=${mig.checksumSha256}`
        );
      }
      skipped.push(mig.version);
      continue;
    }

    const t0 = Date.now();
    await db.exec('BEGIN;');
    try {
      await db.exec(mig.upSql);
      const elapsed = Date.now() - t0;
      await db.query(
        `INSERT INTO schema_migrations (version, name, checksum_sha256, execution_ms)
         VALUES ($1, $2, $3, $4)`,
        [mig.version, mig.name, mig.checksumSha256, elapsed]
      );
      await db.exec('COMMIT;');
      applied.push(mig.version);
    } catch (err) {
      await db.exec('ROLLBACK;');
      throw err;
    }
  }

  return { applied, skipped };
}

export async function migrateDown(
  db: SqlExecutor,
  options: { steps?: number; targetVersion?: string; migrationsDir?: string } = {}
): Promise<{ rolledBack: string[] }> {
  await ensureSchemaMigrationsTable(db);
  const all = loadMigrations(options.migrationsDir);
  const allMap = new Map(all.map(m => [m.version, m]));
  const appliedRows = await getAppliedMigrations(db);
  const reversed = [...appliedRows].reverse();

  const maxSteps = options.steps ?? (options.targetVersion !== undefined ? reversed.length : 1);

  // Build the full rollback plan, then validate EVERY planned version against
  // the protected-down policy BEFORE executing any SQL or opening a
  // transaction. A request that would touch a protected migration (e.g.
  // migrateDown({ steps: 2 }) when 0089 and 0088 are applied) is refused
  // wholesale, leaving schema, data, and migration history untouched.
  const plan: AppliedMigrationRecord[] = [];
  for (const row of reversed) {
    if (plan.length >= maxSteps) break;
    if (options.targetVersion !== undefined && row.version <= options.targetVersion) break;
    plan.push(row);
  }

  for (const row of plan) {
    if (!allMap.has(row.version)) {
      throw new Error(`Missing down migration script on disk for applied version ${row.version}`);
    }
    // Refuse protected (destructive) rollbacks BEFORE executing any SQL.
    assertDownAllowed(row.version);
  }

  const rolledBack: string[] = [];

  for (const row of plan) {
    const mig = allMap.get(row.version)!;

    await db.exec('BEGIN;');
    try {
      await db.exec(mig.downSql);
      await db.query(`DELETE FROM schema_migrations WHERE version = $1`, [row.version]);
      await db.exec('COMMIT;');
      rolledBack.push(row.version);
    } catch (err) {
      await db.exec('ROLLBACK;');
      throw err;
    }
  }

  return { rolledBack };
}
