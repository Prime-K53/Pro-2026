import pgModule from 'pg';
import type { Transaction } from '@electric-sql/pglite';
import type { ServerConfig } from './config.ts';
import type { DatabaseDriver, DatabaseTransaction, ServerDatabase } from './db.ts';
import { createCompanyInTx } from './db.ts';

/**
 * Minimal structural view of the `pg` package.
 *
 * `@types/pg` is not a dependency of this project, so the driver boundary is
 * typed here rather than adding a package or using `any` in the adapter body.
 */
interface PgQueryResult {
  rows: any[];
}
interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  release(): void;
}
interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}
const pg = pgModule as unknown as {
  Pool: new (config: {
    connectionString: string;
    max?: number;
    connectionTimeoutMillis?: number;
  }) => PgPoolLike;
};

/**
 * TEST-ONLY PostgreSQL driver.
 *
 * This factory is never referenced by `createServerDatabase`, so no production
 * or development startup path can select it. It exists so the real HTTP routes
 * and services can be exercised against PostgreSQL in an isolated test
 * environment.
 *
 * Transaction semantics mirror the PGlite implementation exactly:
 * - system scope: `app.bypass_rls = 'on'`
 * - company scope: `SET LOCAL ROLE pms_app_role`, `app.bypass_rls = 'off'`,
 *   `app.current_company_id` (and `app.user_id` when supplied)
 */

class PgTransaction implements DatabaseTransaction {
  constructor(private readonly client: PgClientLike) {}

  async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const res = await this.client.query(sql, params);
    return { rows: res.rows as T[] };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }
}

export interface PostgresDriverOptions {
  connectionString: string;
  /** Maximum pool size. Defaults to 4 to keep concurrent tests bounded. */
  maxPoolSize?: number;
  /** Fail closed unless the connection string targets an explicit test setup. */
  requireTestFlag?: boolean;
  /**
   * TEST-ONLY. When set, every transaction sets `search_path` to this schema
   * (then `public`) so an isolated harness can run against a disposable schema
   * and drop it wholesale on teardown. Ignored when unset (production default).
   */
  schema?: string;
}

export async function createPostgresServerDatabase(
  config: ServerConfig,
  options: PostgresDriverOptions
): Promise<ServerDatabase> {
  if (options.requireTestFlag && process.env.PMS_PG_TEST !== '1') {
    throw new Error('PostgreSQL test driver requires PMS_PG_TEST=1.');
  }
  if (!options.connectionString) {
    throw new Error('PostgreSQL test driver requires a connection string.');
  }

  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxPoolSize ?? 4,
    connectionTimeoutMillis: 10_000,
  });

  const withTransaction = async <T>(
    configure: (tx: DatabaseTransaction) => Promise<void>,
    fn: (tx: DatabaseTransaction) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (options.schema) {
        // Transaction-local search_path so the disposable schema is used and the
        // connection is unaffected outside this transaction.
        await client.query(`SELECT set_config('search_path', $1, true)`, [`${options.schema}, public`]);
      }
      const tx = new PgTransaction(client);
      await configure(tx);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // Roll back and always release, including when the callback throws.
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already unusable; releasing is still required.
      }
      throw err;
    } finally {
      client.release();
    }
  };

  const driver: DatabaseDriver = {
    async query<T = any>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    transaction<T>(fn: (tx: DatabaseTransaction) => Promise<T>) {
      return withTransaction(async () => {}, tx => fn(tx as unknown as Parameters<typeof fn>[0]));
    },
    async close() {
      await pool.end();
    },
  };

  const db: ServerDatabase = {
    pg: driver,
    config,
    withSystemDb<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      return withTransaction(async tx => {
        await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);
      }, tx => fn(tx as unknown as Parameters<typeof fn>[0]));
    },
    withCompanyDb<T>(
      companyId: number,
      fn: (tx: Transaction) => Promise<T>,
      userId?: number
    ): Promise<T> {
      if (!Number.isInteger(companyId) || companyId <= 0) {
        throw new Error('Invalid companyId for scoped transaction');
      }
      return withTransaction(async tx => {
        await tx.exec(`SET LOCAL ROLE pms_app_role;`);
        await tx.exec(`SELECT set_config('app.bypass_rls', 'off', true);`);
        await tx.query(`SELECT set_config('app.current_company_id', $1, true)`, [String(companyId)]);
        if (userId && Number.isInteger(userId) && userId > 0) {
          await tx.query(`SELECT set_config('app.user_id', $1, true)`, [String(userId)]);
        }
      }, tx => fn(tx as unknown as Parameters<typeof fn>[0]));
    },
    async createCompanyWithDefaults(params) {
      // Reuse the existing provisioning logic; no duplicated implementation.
      return driver.transaction(async tx => {
        const res = await createCompanyInTx(tx as unknown as Parameters<typeof createCompanyInTx>[0], params);
        return { companyId: res.companyId, membershipId: res.membershipId, slug: res.slug };
      });
    },
    async close() {
      await driver.close();
    },
  };

  return db;
}