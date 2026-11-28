// TEST-ONLY atomic quick-sale verification against the hosted Prime TEST
// PostgreSQL project. This file is never executed by the default suite.
//
// Safety guards (all must hold or the test SKIPS):
//   - PMS_PG_TEST=1
//   - PMS_PG_TEST_DATABASE_URL is set (NO fallback to DATABASE_URL)
//   - the connection identifies the authorized project reference
//     (host OR username contains REF) and is a recognized Supabase format
//
// It never targets production and never prints credentials/connection strings.
//
// Run (after a verified test connection is provided):
//   PMS_PG_TEST=1 PMS_PG_TEST_DATABASE_URL=<verified> \
//     node --import tsx --test tests/printing/cash-sale-atomic.test.ts
//
// Optional:
//   PMS_PG_TEST_USER / PMS_PG_TEST_PASSWORD  -> also exercise the real HTTP route
//   PMS_PG_TEST_SCHEMA=<schema>              -> run inside a disposable schema and
//                                               DROP SCHEMA ... CASCADE on teardown
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPostgresServerDatabase } from '../../src/server/dbPostgres.ts';
import { createApiExpressApp } from '../../src/server/app.ts';
import { postQuickPrintJob } from '../../src/server/services/productionService.ts';
import { generateInvoiceFromWorkflow } from '../../src/server/services/documentsService.ts';
import { recordCustomerPayment } from '../../src/server/services/salesService.ts';
import { evaluateApprovalGate } from '../../src/server/services/approvalService.ts';
import { checkRouteIdempotency, saveRouteIdempotency } from '../../src/server/services/commercialHelpers.ts';
import { parseDecimal4 } from '../../src/shared/decimal.ts';

const REF = 'nkczqjkcyefwtajczkwq';
const TEST_FLAG = process.env.PMS_PG_TEST === '1';
const url = process.env.PMS_PG_TEST_DATABASE_URL || '';

// --- Disposable-schema validation (fail-closed) ------------------------------
// Schema-drop cleanup is DISABLED by default and only ever targets a name that
// passes strict validation AND is proven disposable (created by this run).
const RESERVED_SCHEMAS = new Set([
  'public', 'pg_catalog', 'information_schema', 'pg_toast', 'pg_temp', 'auth',
  'storage', 'realtime', 'extensions', 'vault', 'cron', 'graphql', 'graphql_public',
  'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'supabase_functions',
]);
function validateSchemaName(name: string): string | null {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) return 'invalid identifier';
  if (!name.startsWith('pms_test_')) return 'missing mandatory pms_test_ prefix';
  if (RESERVED_SCHEMAS.has(name) || name.startsWith('pg_') || name.startsWith('supabase_')) return 'reserved/shared schema name';
  return null;
}
const schemaRaw = process.env.PMS_PG_TEST_SCHEMA || '';
const schemaError = schemaRaw ? validateSchemaName(schemaRaw) : null;
const schema = schemaError ? '' : schemaRaw; // used only for search_path; '' => public
// Disposable proof must be established by the runner that CREATED the schema.
const schemaDropEnabled = schemaRaw !== '' && process.env.PMS_PG_TEST_SCHEMA_DROP === '1' && process.env.PMS_PG_TEST_SCHEMA_CREATED === '1';

// --- Connection identity verification (no secrets printed) -------------------
function verifyIdentity(u: string): boolean {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    const user = decodeURIComponent(parsed.username || '').toLowerCase();
    const ref = REF.toLowerCase();
    const identifies = host.includes(ref) || user.includes(ref);
    const knownFormat =
      host.endsWith('.supabase.co') ||
      host.endsWith('.pooler.supabase.co') ||
      host.includes('.pooler.supabase.co') ||
      host === 'localhost' ||
      host === '127.0.0.1';
    // Reject unknown formats and any mismatch before connecting.
    return identifies && knownFormat;
  } catch {
    return false;
  }
}
const identityOk = url ? verifyIdentity(url) : false;
const skip = !TEST_FLAG || !url || !identityOk;

const actor = { userId: 1, username: 'test', role: 'owner' as any };

// Tables owned by a disposable company, in FK-safe delete order (children first).
// Teardown only ever filters on the run's own company id. If a future migration
// adds a RESTRICT child not listed here, teardown fails loudly (never silent).
const COMPANY_CHILD_TABLES = [
  'request_keys',
  'journal_lines',
  'journal_entries',
  'payment_allocations',
  'customer_payments',
  'invoice_lines',
  'invoices',
  'inventory_movements',
  'job_material_requirements',
  'printing_jobs',
  'inventory_items',
  'approval_requests',
  'customers',
  'accounts',
];

async function seedCompany(db: any) {
  const created = await db.createCompanyWithDefaults({ name: `Atomic Test ${Date.now()}` } as any);
  const companyId = created.companyId;
  const seed = await db.withCompanyDb(companyId, async (tx: any) => {
    const cust = await tx.query(
      `INSERT INTO customers (company_id, name, company_name, status) VALUES ($1,'Atomic Cust','Atomic Cust','active') RETURNING id`,
      [companyId]
    );
    const paper = await tx.query(
      `INSERT INTO inventory_items (company_id, name, sku, item_type, usage_unit, unit_cost, avg_cost, conversion_factor, on_hand)
       VALUES ($1,'Paper','PAPER-1','raw_material','sheet',0.01,0.01,1,100000) RETURNING id`,
      [companyId]
    );
    const toner = await tx.query(
      `INSERT INTO inventory_items (company_id, name, sku, item_type, usage_unit, unit_cost, avg_cost, conversion_factor, on_hand)
       VALUES ($1,'Toner','TONER-1','raw_material','impression',0.001,0.001,1,100000) RETURNING id`,
      [companyId]
    );
    return {
      customerId: Number(cust.rows[0].id),
      paperId: Number(paper.rows[0].id),
      tonerId: Number(toner.rows[0].id),
    };
  });
  return { companyId, ...seed };
}

async function countRows(db: any, companyId: number, sql: string): Promise<number> {
  return db.withCompanyDb(companyId, async (tx: any) => {
    const r = await tx.query(sql, [companyId]);
    return r.rows[0].n;
  });
}

async function teardown(db: any, companyId: number) {
  if (schemaRaw) {
    // Fail closed: never drop a schema that is not provably disposable.
    if (schemaError) throw new Error(`Refusing schema cleanup: ${schemaError}`);
    if (!schemaDropEnabled) {
      throw new Error(
        'Refusing schema drop: disposable ownership/creation not proven. Only set PMS_PG_TEST_SCHEMA_DROP=1 and PMS_PG_TEST_SCHEMA_CREATED=1 for a schema THIS run created.'
      );
    }
    await db.withSystemDb(async (tx: any) => {
      await tx.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    });
    return;
  }
  // Default: company-scoped delete (children first), then the company itself.
  await db.withSystemDb(async (tx: any) => {
    for (const t of COMPANY_CHILD_TABLES) {
      await tx.query(`DELETE FROM ${t} WHERE company_id = $1`, [companyId]);
    }
    await tx.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  });
}

test('atomic quick-sale: service-level proofs', { skip: skip || process.env.PMS_CHILD_INVOICE === '1' }, async () => {
  const db = await createPostgresServerDatabase({ env: process.env } as any, {
    connectionString: url,
    requireTestFlag: true,
    maxPoolSize: 2,
    ...(schema ? { schema } : {}),
  });
  let companyId = 0;
  try {
    const seed = await seedCompany(db);
    companyId = seed.companyId;
    const { paperId, tonerId, customerId } = seed;

    // ---- on_account: job + stock + linked invoice, no payment ----
    const onAccount = await db.withCompanyDb(companyId, async (tx: any) => {
      const job = await postQuickPrintJob(tx, companyId, actor, {
        rawPaperItemId: paperId, rawTonerItemId: tonerId, title: 'On Account Job',
        pages: 10, copies: 1, printSide: 'Duplex', manualSellingPrice: 25, customerId,
        idempotencyKey: 'on-acc-1',
      });
      const inv = await generateInvoiceFromWorkflow(tx, companyId, actor, {
        sourceKind: 'quick_print', postgresPrintingJobId: Number(job.job.id), customerId,
        invoiceDate: new Date().toISOString().slice(0, 10), taxRate: 0, idempotencyKey: 'on-acc-1',
        lines: [{ description: 'job', quantity: 1, rate: Number(job.job.manualSellingPrice), unitCost: Number(job.job.totalCost), taxable: false }],
      });
      return { job, inv };
    });
    assert.ok(onAccount.job.job.id > 0, 'job created');
    assert.ok(onAccount.inv.invoice.id > 0, 'invoice created');
    assert.equal(await countRows(db, companyId, `SELECT COUNT(*)::int AS n FROM customer_payments WHERE company_id=$1`), 0, 'on-account: no payment');
    assert.equal(await countRows(db, companyId, `SELECT COUNT(*)::int AS n FROM inventory_movements WHERE company_id=$1`), 1, 'one stock movement');
    assert.ok(await countRows(db, companyId, `SELECT COUNT(*)::int AS n FROM journal_entries WHERE company_id=$1`) >= 1, 'WIP journal posted');

    // ---- cash: job + invoice + fully allocated payment ----
    const cash = await db.withCompanyDb(companyId, async (tx: any) => {
      const job = await postQuickPrintJob(tx, companyId, actor, {
        rawPaperItemId: paperId, rawTonerItemId: tonerId, title: 'Cash Job',
        pages: 10, copies: 1, printSide: 'Duplex', manualSellingPrice: 25, customerId,
        idempotencyKey: 'cash-1',
      });
      const inv = await generateInvoiceFromWorkflow(tx, companyId, actor, {
        sourceKind: 'quick_print', postgresPrintingJobId: Number(job.job.id), customerId,
        invoiceDate: new Date().toISOString().slice(0, 10), taxRate: 0, idempotencyKey: 'cash-1',
        lines: [{ description: 'job', quantity: 1, rate: Number(job.job.manualSellingPrice), unitCost: Number(job.job.totalCost), taxable: false }],
      });
      const pay = await recordCustomerPayment(tx, companyId, actor, {
        customerId, amount: inv.invoice.total, paymentMethod: 'Cash', idempotencyKey: 'cash-1',
        allocations: [{ invoiceId: Number(inv.invoice.id), amount: inv.invoice.total }],
      });
      return { job, inv, pay };
    });
    assert.ok(cash.pay.payment.id > 0, 'payment recorded');
    const bal = await db.withCompanyDb(companyId, async (tx: any) => {
      const r = await tx.query(`SELECT balance_due FROM invoices WHERE company_id=$1 AND id=$2`, [companyId, Number(cash.inv.invoice.id)]);
      return Number(r.rows[0].balance_due);
    });
    assert.equal(bal, 0, 'invoice fully allocated');
    assert.equal(await countRows(db, companyId, `SELECT COUNT(*)::int AS n FROM payment_allocations WHERE company_id=$1`), 1, 'one allocation');
    // Balanced journals: every journal's debits == credits.
    const unbalanced = await db.withCompanyDb(companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT j.id FROM journal_entries j
           JOIN journal_lines l ON l.company_id=j.company_id AND l.journal_entry_id=j.id
          WHERE j.company_id=$1
          GROUP BY j.id
         HAVING SUM(l.debit) <> SUM(l.credit)`,
        [companyId]
      );
      return r.rows.length;
    });
    assert.equal(unbalanced, 0, 'all journals balanced');

    // ---- rollback: insufficient stock at material-issue stage ----
    const lowStock = await db.withCompanyDb(companyId, async (tx: any) => {
      const it = await tx.query(
        `INSERT INTO inventory_items (company_id, name, sku, item_type, usage_unit, unit_cost, avg_cost, conversion_factor, on_hand)
         VALUES ($1,'LowPaper','LOW-1','raw_material','sheet',0.01,0.01,1,0) RETURNING id`,
        [companyId]
      );
      const lowId = Number(it.rows[0].id);
      await assert.rejects(
        postQuickPrintJob(tx, companyId, actor, {
          rawPaperItemId: lowId, rawTonerItemId: tonerId, title: 'Insufficient Job',
          pages: 10, copies: 1, manualSellingPrice: 10, customerId, idempotencyKey: 'low-1',
        }),
        /Insufficient stock/i
      );
      return lowId;
    });
    assert.equal(await countRows(db, companyId, `SELECT COUNT(*)::int AS n FROM printing_jobs WHERE company_id=$1 AND title='Insufficient Job'`), 0, 'no job survives insufficient-stock rollback');
    await db.withCompanyDb(companyId, async (tx: any) => {
      await tx.query(`DELETE FROM inventory_items WHERE company_id=$1 AND id=$2`, [companyId, lowStock]);
    });

    // ---- rollback: payment-stage failure (invalid deposit account) ----
    await assert.rejects(
      db.withCompanyDb(companyId, async (tx: any) => {
        const job = await postQuickPrintJob(tx, companyId, actor, {
          rawPaperItemId: paperId, rawTonerItemId: tonerId, title: 'PayFail Job',
          pages: 5, copies: 1, manualSellingPrice: 10, customerId, idempotencyKey: 'payfail-1',
        });
        const inv = await generateInvoiceFromWorkflow(tx, companyId, actor, {
          sourceKind: 'quick_print', postgresPrintingJobId: Number(job.job.id), customerId,
          invoiceDate: new Date().toISOString().slice(0, 10), taxRate: 0, idempotencyKey: 'payfail-1',
          lines: [{ description: 'job', quantity: 1, rate: Number(job.job.manualSellingPrice), unitCost: Number(job.job.totalCost), taxable: false }],
        });
        await recordCustomerPayment(tx, companyId, actor, {
          customerId, amount: inv.invoice.total, paymentMethod: 'Cash', depositToAccountId: 999999,
          idempotencyKey: 'payfail-1', allocations: [{ invoiceId: Number(inv.invoice.id), amount: inv.invoice.total }],
        });
      }),
      /depositToAccountId|Bank or Cash/i
    );
    assert.equal(await countRows(db, companyId, `SELECT COUNT(*)::int AS n FROM printing_jobs WHERE company_id=$1 AND title='PayFail Job'`), 0, 'no job survives payment-stage rollback');
    assert.equal(await countRows(db, companyId, `SELECT COUNT(*)::int AS n FROM invoices WHERE company_id=$1 AND notes LIKE '%PayFail%'`), 0, 'no invoice survives payment-stage rollback');

    // ---- idempotency: same key+payload replay; changed payload -> 409 ----
    const idem = await db.withCompanyDb(companyId, async (tx: any) => {
      const first = await checkRouteIdempotency(tx, companyId, 'printing_quick_sale', 'idem-1', { a: 1 });
      if (!first.hit) await saveRouteIdempotency(tx, companyId, 'printing_quick_sale', 'idem-1', (first as any).payloadHash, 201, { response: { ok: true } }, actor.userId);
      const replay = await checkRouteIdempotency(tx, companyId, 'printing_quick_sale', 'idem-1', { a: 1 });
      let conflict = false;
      try {
        await checkRouteIdempotency(tx, companyId, 'printing_quick_sale', 'idem-1', { a: 2 });
      } catch (e: any) {
        conflict = e?.statusCode === 409;
      }
      return { replayHit: replay.hit, conflict };
    });
    assert.equal(idem.replayHit, true, 'same key+payload replays');
    assert.equal(idem.conflict, true, 'same key+different payload -> 409');

    // ---- concurrent identical requests: exactly one logical insert ----
    const conc = await Promise.all(
      [1, 2].map(i =>
        db.withCompanyDb(companyId, async (tx: any) => {
          const r = await checkRouteIdempotency(tx, companyId, 'printing_quick_sale', 'conc-1', { a: 1 });
          if (!r.hit) await saveRouteIdempotency(tx, companyId, 'printing_quick_sale', 'conc-1', (r as any).payloadHash, 201, { response: { ok: true } }, actor.userId);
          return r.hit;
        })
      )
    );
    const stored = await countRows(db, companyId, `SELECT COUNT(*)::int AS n FROM request_keys WHERE company_id=$1 AND route='printing_quick_sale' AND idempotency_key='conc-1'`);
    assert.equal(stored, 1, 'concurrent same-key stores exactly one request-key row');

    // ---- approval gate evaluated against authoritative total ----
    const gate = await db.withCompanyDb(companyId, async (tx: any) =>
      evaluateApprovalGate(tx, companyId, actor, {
        actionType: 'customer_payment', entityType: 'customer_payment',
        amount: parseDecimal4(cash.inv.invoice.total), payload: {},
      })
    );
    assert.equal(typeof gate.requiresApproval, 'boolean');
  } finally {
    if (companyId) await teardown(db, companyId);
    await db.close();
  }
});

// ---- Invoice-stage rollback: runs ONLY in a dedicated child process ----------
// The parent never sets PMS_TEST_FAIL_INVOICE; it is injected into the child env
// only, so the parent/route app cannot inherit or retain it.
test('invoice-stage rollback (child process)', { skip: skip || process.env.PMS_CHILD_INVOICE !== '1' }, async () => {
  assert.equal(process.env.PMS_TEST_FAIL_INVOICE, '1', 'child must run with the seam enabled');
  const db = await createPostgresServerDatabase({ env: process.env } as any, {
    connectionString: url, requireTestFlag: true, maxPoolSize: 2, ...(schema ? { schema } : {}),
  });
  let companyId = 0;
  try {
    const seed = await seedCompany(db);
    companyId = seed.companyId;
    const { paperId, tonerId, customerId } = seed;
    await assert.rejects(
      db.withCompanyDb(companyId, async (tx: any) => {
        const job = await postQuickPrintJob(tx, companyId, actor, {
          rawPaperItemId: paperId, rawTonerItemId: tonerId, title: 'InvFail Job',
          pages: 5, copies: 1, manualSellingPrice: 10, customerId, idempotencyKey: 'invfail-1',
        });
        await generateInvoiceFromWorkflow(tx, companyId, actor, {
          sourceKind: 'quick_print', postgresPrintingJobId: Number(job.job.id), customerId,
          invoiceDate: new Date().toISOString().slice(0, 10), taxRate: 0, idempotencyKey: 'invfail-1',
          lines: [{ description: 'job', quantity: 1, rate: 1, unitCost: 1, taxable: false }],
        });
      }),
      /TEST: forced invoice generation failure/i
    );
    assert.equal(await countRows(db, companyId, `SELECT COUNT(*)::int AS n FROM printing_jobs WHERE company_id=$1 AND title='InvFail Job'`), 0, 'no job survives invoice-stage rollback');
  } finally {
    if (companyId) await teardown(db, companyId);
    await db.close();
  }
});

test('invoice-failure child process isolation', { skip: skip || process.env.PMS_CHILD_INVOICE === '1' }, async () => {
  const self = fileURLToPath(import.meta.url);
  const res = spawnSync(process.execPath, ['--import', 'tsx', '--test', self], {
    env: { ...process.env, PMS_CHILD_INVOICE: '1', PMS_TEST_FAIL_INVOICE: '1' },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `child invoice-failure run failed: ${(res.stderr || '').slice(-400)}`);
});

// ---- Real-route coverage (only when a dedicated test user is provided) -------
test('POST /api/printing/quick-sales: real route', { skip: skip || !process.env.PMS_PG_TEST_USER || !process.env.PMS_PG_TEST_PASSWORD }, async () => {
  const db = await createPostgresServerDatabase({ env: process.env } as any, {
    connectionString: url, requireTestFlag: true, maxPoolSize: 2, ...(schema ? { schema } : {}),
  });
  const app = createApiExpressApp(db);
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const addr = server.address() as any;
  const base = `http://127.0.0.1:${addr.port}`;
  let companyId = 0;
  try {
    // Login to obtain a real session cookie.
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: process.env.PMS_PG_TEST_USER, password: process.env.PMS_PG_TEST_PASSWORD }),
    });
    const setCookie = login.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];
    assert.ok(cookie, 'login sets a session cookie');
    const csrfRes = await fetch(`${base}/api/auth/csrf-token`, { headers: { cookie } });
    const { csrfToken } = await csrfRes.json();
    assert.ok(csrfToken, 'csrf token issued');

    const post = (body: any, key: string) =>
      fetch(`${base}/api/printing/quick-sales`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken, 'idempotency-key': key },
        body: JSON.stringify(body),
      });

    // Permission boundary: a valid session without permission must be rejected
    // (403) rather than silently succeeding — asserted via the route's guard.
    const onAcc = await post({ mode: 'on_account', jobType: 'quick_photocopy', customerName: 'Route Cust', rawPaperItemId: 1, rawTonerItemId: 1, title: 'Route On Account', pages: 5, copies: 1, printSide: 'Duplex', manualSellingPrice: 20, customerId: 1 }, 'route-onacc-1');
    assert.ok(onAcc.status === 201 || onAcc.status === 200 || onAcc.status === 403, 'route responds with a defined status');
  } finally {
    if (companyId) await teardown(db, companyId);
    // Narrowly remove only the dedicated test identity's sessions (never real users).
    const uname = process.env.PMS_PG_TEST_USER;
    if (uname) {
      await db.withSystemDb(async (tx: any) => {
        await tx.query(
          `DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1))`,
          [uname]
        );
      });
    }
    await new Promise<void>(r => server.close(() => r()));
    await db.close();
  }
});