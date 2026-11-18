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
      if (existing.checksum_sha256 !== mig.checksumSha256) {
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
  const rolledBack: string[] = [];

  for (const row of reversed) {
    if (rolledBack.length >= maxSteps) break;
    if (options.targetVersion !== undefined && row.version <= options.targetVersion) break;

    const mig = allMap.get(row.version);
    if (!mig) {
      throw new Error(`Missing down migration script on disk for applied version ${row.version}`);
    }

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
