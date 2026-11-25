import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';

interface TestRecord { suite: string; name: string; passed: boolean; durationMs: number; details: string; }
const results: TestRecord[] = [];
async function runTest(suite: string, name: string, fn: () => Promise<string | void>) {
  const start = Date.now();
  try { const details = (await fn()) || 'OK'; results.push({ suite, name, passed: true, durationMs: Date.now() - start, details }); console.log(`  [PASS] ${suite} :: ${name} — ${details}`); }
  catch (err: any) { const msg = err?.message || String(err); results.push({ suite, name, passed: false, durationMs: Date.now() - start, details: msg }); console.error(`  [FAIL] ${suite} :: ${name} — ${msg}`); }
}
class CookieHttpClient {
  public cookie = '';
  constructor(private baseUrl: string) {}
  async request(method: string, pathname: string, options: { body?: unknown } = {}) {
    const res = await fetch(`${this.baseUrl}${pathname}`, { method, headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
    const setCookie = res.headers.get('set-cookie'); if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, text, json };
  }
}

async function main() {
  console.log('=== Modules 6-10 Controls Verification Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-m6-10-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };
  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const admin = new CookieHttpClient(`http://127.0.0.1:${addr.port}`);

  try {
    await runTest('1. Auth', 'Login', async () => { const res = await admin.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } }); assert.equal(res.status, 200, res.text); });

    await runTest('2. Banking rules', 'Create/export/import rules', async () => {
      const create = await admin.request('POST', '/api/banking/recon-rules', { body: { ruleName: 'Rent', matchField: 'description', matchPattern: 'RENT', autoPost: false, isActive: true } });
      assert.equal(create.status, 201, create.text);
      const list = await admin.request('GET', '/api/banking/recon-rules');
      assert.equal(list.status, 200, list.text);
      assert.ok(list.json.rules.length >= 1);
      const exp = await admin.request('GET', '/api/banking/recon-rules/export');
      assert.equal(exp.status, 200, exp.text);
      assert.ok(Array.isArray(exp.json.rules));
      const imp = await admin.request('POST', '/api/banking/recon-rules/import', { body: { rules: [{ ruleName: 'Utilities', matchPattern: 'ZESCO', matchField: 'description' }] } });
      assert.equal(imp.status, 200, imp.text);
      assert.equal(imp.json.imported, 1);
      return `rules=${list.json.rules.length}`;
    });

    await runTest('3. Tax controls', 'Filing period and mapping CRUD', async () => {
      const period = await admin.request('POST', '/api/tax/filing-periods', { body: { jurisdiction: 'ZRA', periodStart: '2026-01-01', periodEnd: '2026-01-31', dueDate: '2026-02-21', status: 'open' } });
      assert.equal(period.status, 201, period.text);
      const filed = await admin.request('POST', `/api/tax/filing-periods/${period.json.period.id}/file`, { body: { reference: 'VAT-2026-01' } });
      assert.equal(filed.status, 200, filed.text);
      assert.equal(filed.json.period.status, 'filed');
      const accounts = await admin.request('GET', '/api/accounts');
      const accountId = accounts.json.accounts?.[0]?.id;
      const map = await admin.request('POST', '/api/tax/account-mappings', { body: { jurisdiction: 'ZRA', taxBox: 'VAT_OUTPUT', accountId, direction: 'credit' } });
      assert.equal(map.status, 201, map.text);
      const mappings = await admin.request('GET', '/api/tax/account-mappings');
      assert.equal(mappings.status, 200, mappings.text);
      assert.ok(mappings.json.mappings.length >= 1);
      return 'ok';
    });

    await runTest('4. Reporting snapshots', 'Export snapshot is idempotent by hash', async () => {
      const a = await admin.request('POST', '/api/reports/export-snapshots', { body: { reportKey: 'trial-balance', parameters: { period: '2026-11' }, rowCount: 42 } });
      assert.equal(a.status, 201, a.text);
      assert.equal(a.json.snapshot.idempotentReplay, false);
      const b = await admin.request('POST', '/api/reports/export-snapshots', { body: { reportKey: 'trial-balance', parameters: { period: '2026-11' }, rowCount: 42 } });
      assert.equal(b.status, 201, b.text);
      assert.equal(b.json.snapshot.idempotentReplay, true);
      const list = await admin.request('GET', '/api/reports/export-snapshots?reportKey=trial-balance');
      assert.equal(list.status, 200, list.text);
      assert.ok(list.json.snapshots.length >= 1);
      return `snapshots=${list.json.snapshots.length}`;
    });

    await runTest('5. Document control', 'Approve/reject/retention on attachment', async () => {
      // create a stored_file + attachment row directly for test
      let attachmentId = 0;
      await db.withCompanyDb(1, async (tx) => {
        const sf = await tx.query<any>(
          `INSERT INTO stored_files (company_id, storage_kind, original_name, content_type, size_bytes, sha256_hex, storage_key, created_by)
           VALUES (1,'local','test.pdf','application/pdf',10,'${'0'.repeat(64)}','test/test.pdf',1) RETURNING id`
        );
        const ins = await tx.query<any>(
          `INSERT INTO attachments (company_id, stored_file_id, entity_type, entity_id)
           VALUES (1,$1,'invoice',1) RETURNING id`,
          [Number(sf.rows[0].id)]
        );
        attachmentId = Number(ins.rows[0].id);
      });
      const approve = await admin.request('POST', `/api/documents/${attachmentId}/approve`, { body: { approved: true } });
      assert.equal(approve.status, 200, approve.text);
      assert.equal(approve.json.document.approvalStatus, 'approved');
      const retention = await admin.request('POST', `/api/documents/${attachmentId}/retention`, { body: { retentionUntil: '2027-12-31' } });
      assert.equal(retention.status, 200, retention.text);
      const versions = await admin.request('GET', '/api/documents/invoice/1/versions');
      assert.equal(versions.status, 200, versions.text);
      assert.ok(versions.json.documents.length >= 1);
      return `attachment=${attachmentId}`;
    });

    await runTest('6. Accounting controls', 'Control event and journal approval status', async () => {
      const ev = await admin.request('POST', '/api/accounting/control-events', { body: { controlType: 'period_lock_check', severity: 'info', message: 'Test event', details: { ok: true } } });
      assert.equal(ev.status, 201, ev.text);
      const list = await admin.request('GET', '/api/accounting/control-events');
      assert.equal(list.status, 200, list.text);
      assert.ok(list.json.events.length >= 1);
      // journal approval status on an existing journal if any
      let journalId = 0;
      await db.withCompanyDb(1, async (tx) => { const r = await tx.query<any>(`SELECT id FROM journal_transactions WHERE company_id=1 ORDER BY id DESC LIMIT 1`); journalId = r.rows[0] ? Number(r.rows[0].id) : 0; });
      if (journalId) {
        const j = await admin.request('POST', `/api/accounting/journals/${journalId}/approval`, { body: { status: 'approved', reason: 'test' } });
        assert.equal(j.status, 200, j.text);
        assert.equal(j.json.journal.approvalStatus, 'approved');
      }
      return `events=${list.json.events.length} journal=${journalId}`;
    });

    const limited = new CookieHttpClient(`http://127.0.0.1:${addr.port}`);
    await runTest('7. 403 permissions', 'Read-only/limited user cannot perform control writes', async () => {
      let loggedIn = false;
      for (const cred of [{ identifier: 'readonly', password: 'ReadOnly#2026' }, { identifier: 'viewer', password: 'Viewer#2026' }]) {
        const r = await limited.request('POST', '/api/auth/login', { body: cred }).catch(() => null);
        if (r && r.status === 200) { loggedIn = true; break; }
      }
      if (!loggedIn) {
        const { hashPassword } = await import('../../src/server/supabaseAuth.ts');
        const hash = hashPassword('ReadOnly#2026');
        await db.withCompanyDb(1, async (tx) => {
          const existing = await tx.query<any>(`SELECT id FROM public.users WHERE username = 'readonly_test_user' LIMIT 1`);
          let uid: number;
          if (existing.rows[0]) {
            uid = Number(existing.rows[0].id);
            await tx.query(`UPDATE public.users SET password_hash = $1, is_active = TRUE WHERE id = $2`, [hash, uid]);
          } else {
            const ins = await tx.query<any>(`INSERT INTO public.users (username, display_name, email, password_hash, is_active) VALUES ('readonly_test_user','Read Only Test','readonly@test.local',$1,TRUE) RETURNING id`, [hash]);
            uid = Number(ins.rows[0].id);
          }
          const mem = await tx.query<any>(`SELECT 1 FROM public.company_memberships WHERE company_id = 1 AND user_id = $1 LIMIT 1`, [uid]);
          if (mem.rows[0]) {
            await tx.query(`UPDATE public.company_memberships SET role='Read-Only', is_active=TRUE WHERE company_id=1 AND user_id=$1`, [uid]);
          } else {
            await tx.query(`INSERT INTO public.company_memberships (company_id,user_id,role,is_active) VALUES (1,$1,'Read-Only',TRUE)`, [uid]);
          }
        });
        const r = await limited.request('POST', '/api/auth/login', { body: { identifier: 'readonly_test_user', password: 'ReadOnly#2026' } });
        assert.equal(r.status, 200, r.text);
      }
      const checks: Array<[string, number]> = [];
      checks.push(['bankRule', (await limited.request('POST', '/api/banking/recon-rules', { body: { ruleName: 'Nope', matchPattern: 'X' } })).status]);
      checks.push(['taxPeriod', (await limited.request('POST', '/api/tax/filing-periods', { body: { jurisdiction: 'ZRA', periodStart: '2026-01-01', periodEnd: '2026-01-31' } })).status]);
      checks.push(['reportSnap', (await limited.request('POST', '/api/reports/export-snapshots', { body: { reportKey: 'x', parameters: {} } })).status]);
      checks.push(['acctEvent', (await limited.request('POST', '/api/accounting/control-events', { body: { controlType: 'x', severity: 'info', message: 'x' } })).status]);
      checks.push(['expenseWrite', (await limited.request('POST', '/api/expenses/claims', { body: { claimantName: 'X', claimDate: '2026-11-25', lines: [{ description: 'x', amount: 1, expenseAccountId: 1 }] } })).status]);
      checks.push(['prodOps', (await limited.request('POST', '/api/production/jobs/1/assign-machine', { body: { machineId: 1 } })).status]);
      checks.push(['docControl', (await limited.request('POST', '/api/documents/1/approve', { body: { approved: true } })).status]);
      for (const [name, status] of checks) assert.equal(status, 403, `${name} should be 403, got ${status}`);
      const readRules = await limited.request('GET', '/api/banking/recon-rules');
      assert.equal(readRules.status, 200, readRules.text);
      const readTax = await limited.request('GET', '/api/tax/filing-periods');
      assert.equal(readTax.status, 200, readTax.text);
      const readEvents = await limited.request('GET', '/api/accounting/control-events');
      assert.equal(readEvents.status, 200, readEvents.text);
      return checks.map(c => `${c[0]}=${c[1]}`).join(' ') + ` reads=ok`;
    });

    await runTest('8. RLS/company scope', 'Control events and rules are company-scoped', async () => {
      const rules = await admin.request('GET', '/api/banking/recon-rules');
      assert.equal(rules.status, 200, rules.text);
      for (const r of rules.json.rules || []) assert.ok(Number(r.company_id || r.companyId || 1) === 1);
      const events = await admin.request('GET', '/api/accounting/control-events');
      assert.equal(events.status, 200, events.text);
      for (const e of events.json.events || []) assert.ok(Number(e.company_id || e.companyId || 1) === 1);
      return `rules=${(rules.json.rules||[]).length} events=${(events.json.events||[]).length}`;
    });

  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n=== Modules 6-10 Controls Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) { for (const r of results.filter(r => !r.passed)) console.error(` - ${r.suite} :: ${r.name}: ${r.details}`); process.exit(1); }
}
main().catch(err => { console.error(err); process.exit(1); });
