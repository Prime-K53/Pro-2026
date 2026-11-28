// TEST-ONLY hosted PostgreSQL HTTP idempotency verification.
//
// Skips unless ALL of the following hold:
//   - PMS_PG_TEST=1
//   - DATABASE_URL is set
//   - public.request_keys exists (i.e. the application schema is migrated)
//
// It never targets production: it refuses to run without the explicit flag and
// only uses a disposable company created by this run.
//
// Run: PMS_PG_TEST=1 node --import tsx tests/pg/http-idempotency.mjs

import fs from 'node:fs';
import http from 'node:http';
import pg from 'pg';

const REF = 'nkczqjkcyefwtajczkwq';

function loadEnv() {
  const file = 'C:/Users/Rhonald Chiwatu/Desktop/Projects/Printing System/.env';
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}

const env = { ...loadEnv(), ...process.env };
const url = env.DATABASE_URL;
const results = [];

async function run(name, fn) {
  try {
    const detail = (await fn()) || 'OK';
    results.push({ name, passed: true, detail });
    console.log(`  [PASS] ${name} — ${detail}`);
  } catch (err) {
    results.push({ name, passed: false, detail: String(err.message || err) });
    console.error(`  [FAIL] ${name} — ${String(err.message || err).replace(/password|postgres:\/\/[^\s]*/gi, '[redacted]')}`);
  }
}

async function main() {
  if (process.env.PMS_PG_TEST !== '1') {
    console.log('SKIP: PMS_PG_TEST != 1 (hosted PostgreSQL verification NOT run)');
    process.exit(0);
  }
  if (!url) {
    console.log('SKIP: DATABASE_URL not set (hosted PostgreSQL verification NOT run)');
    process.exit(0);
  }
  let host = '';
  try { host = new URL(url).hostname + new URL(url).username; } catch {}
  if (!host.includes(REF)) {
    console.log('SKIP: DATABASE_URL does not target the authorized TEST project (hosted verification NOT run)');
    process.exit(0);
  }

  const probe = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, ssl: { rejectUnauthorized: false } });
  await probe.connect();
  const reg = await probe.query(`select to_regclass('public.request_keys') is not null as present`);
  if (!reg.rows[0].present) {
    await probe.end();
    console.log('SKIP: public.request_keys missing — application schema not migrated (hosted verification NOT run)');
    process.exit(0);
  }
  await probe.end();

  const { createPostgresServerDatabase } = await import('../../src/server/dbPostgres.ts');
  const { loadServerConfig } = await import('../../src/server/config.ts');
  const { createApiExpressApp } = await import('../../src/server/app.ts');

  const config = loadServerConfig();
  const db = await createPostgresServerDatabase(config, { connectionString: url, requireTestFlag: true, maxPoolSize: 4 });
  const app = createApiExpressApp(db);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;

  let cookie = '';
  const request = async (method, path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie?.() || [];
    if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text: text.slice(0, 200) };
  };

  const marker = `PMS-PG-${Date.now()}`;
  let companyId = null;

  try {
    await run('auth', async () => {
      const r = await request('POST', '/api/auth/login', { identifier: 'admin', password: 'PrintingAdmin#2026' });
      if (r.status !== 200) throw new Error(`login ${r.status}`);
      return 'logged in';
    });

    await run('create isolated company', async () => {
      const r = await request('POST', '/api/companies', { name: marker, legalName: marker, ownerUsername: 'admin' });
      if (!r.status || r.status >= 300) throw new Error(`company ${r.status}`);
      companyId = r.json?.company?.id ?? r.json?.id ?? null;
      if (!companyId) throw new Error('no company id');
      return `company ${companyId}`;
    });

    const payload = {
      sourceKind: 'quick_print',
      sourceRef: marker,
      customerName: `${marker} School`,
      invoiceDate: '2026-11-20',
      dueDate: '2026-12-05',
      taxRate: 0,
      lines: [{ description: `${marker} line`, quantity: 1, rate: 100, taxable: false }],
    };

    await run('concurrent same key + same payload', async () => {
      const key = `idem-${marker}`;
      const [a, b] = await Promise.all([
        request('POST', '/api/documents/generate-invoice', payload, { 'idempotency-key': key }),
        request('POST', '/api/documents/generate-invoice', payload, { 'idempotency-key': key }),
      ]);
      if (a.json?.invoice?.id !== b.json?.invoice?.id) {
        throw new Error(`identity mismatch ${a.status}/${b.status}`);
      }
      const rows = await db.pg.query(
        `SELECT COUNT(*)::int n FROM invoices WHERE company_id = $1 AND notes = $2`,
        [companyId, `Concurrency check ${marker}`]
      );
      if (rows.rows[0].n !== 1) throw new Error(`invoice count ${rows.rows[0].n}`);
      const keys = await db.pg.query(
        `SELECT COUNT(*)::int n FROM request_keys WHERE company_id = $1 AND idempotency_key = $2`,
        [companyId, key]
      );
      if (keys.rows[0].n !== 1) throw new Error(`idempotency rows ${keys.rows[0].n}`);
      return `statuses ${a.status}/${b.status}, one invoice #${a.json.invoice.id}`;
    });

    await run('same key + different payload conflict', async () => {
      const key = `idem-${marker}`;
      const r = await request('POST', '/api/documents/generate-invoice', { ...payload, lines: [{ description: 'different', quantity: 9, rate: 900, taxable: false }] }, { 'idempotency-key': key });
      if (r.status !== 409) throw new Error(`expected 409, got ${r.status}`);
      return 'conflict rejected';
    });
  } finally {
    await new Promise(r => server.close(r));
    await db.close();
  }

  const failed = results.filter(r => !r.passed);
  console.log(`\n=== SUMMARY ${results.length - failed.length}/${results.length} PASSED ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error('ERROR:', String(err.message || err).replace(/password|postgres:\/\/[^\s]*/gi, '[redacted]'));
  process.exit(1);
});