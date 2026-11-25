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
  console.log('=== Production Ops Advanced Actions Verification Suite ===\n');
  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-prod-ops-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = { ...baseCfg, nodeEnv: 'test', isProduction: false, attachmentsDir: tmpAttachDir };
  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const addr = server.address() as { port: number };
  const admin = new CookieHttpClient(`http://127.0.0.1:${addr.port}`);
  let machineId = 0; let jobId = 0;

  try {
    await runTest('1. Auth', 'Login', async () => {
      const res = await admin.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } });
      assert.equal(res.status, 200, res.text);
    });

    await runTest('2. Seed refs', 'Find or create machine and job', async () => {
      await db.withCompanyDb(1, async (tx) => {
        const m = await tx.query<any>(`SELECT id FROM printing_machines WHERE company_id = 1 ORDER BY id LIMIT 1`);
        if (m.rows.length > 0) { machineId = Number(m.rows[0].id); }
        else {
          const ins = await tx.query<any>(`INSERT INTO printing_machines (company_id, machine_code, name, machine_type) VALUES (1,'M-TEST','Test Press','digital_press') RETURNING id`);
          machineId = Number(ins.rows[0].id);
        }
        const j = await tx.query<any>(`SELECT id FROM printing_jobs WHERE company_id = 1 ORDER BY id LIMIT 1`);
        if (j.rows.length > 0) { jobId = Number(j.rows[0].id); }
        else {
          const ins = await tx.query<any>(
            `INSERT INTO printing_jobs (company_id, job_number, customer_id, job_kind, description, job_date, status)
             VALUES (1,'JOB-TEST-1', (SELECT id FROM customers WHERE company_id=1 ORDER BY id LIMIT 1), 'general_print', 'Test job', CURRENT_DATE, 'queued') RETURNING id`
          );
          jobId = Number(ins.rows[0].id);
        }
      });
      assert.ok(machineId > 0 && jobId > 0);
      return `machine=${machineId} job=${jobId}`;
    });

    await runTest('3. Assign machine', 'Assign machine to job', async () => {
      const res = await admin.request('POST', `/api/production/jobs/${jobId}/assign-machine`, { body: { machineId, notes: 'Primary press' } });
      assert.equal(res.status, 201, res.text);
      assert.equal(Number(res.json.assignment.machineId), machineId);
      return `assignment=${res.json.assignment.assignmentId}`;
    });

    await runTest('4. Move stage', 'Move job stage/status', async () => {
      const res = await admin.request('POST', `/api/production/jobs/${jobId}/move-stage`, { body: { toStatus: 'in_production', reason: 'Started' } });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.job.toStatus, 'in_production');
      return `${res.json.job.fromStatus}->${res.json.job.toStatus}`;
    });

    await runTest('5. Log downtime', 'Log machine downtime event', async () => {
      const res = await admin.request('POST', `/api/production/machines/${machineId}/downtime`, { body: { jobId, downtimeMinutes: 30, reasonCode: 'jam', reason: 'Paper jam' } });
      assert.equal(res.status, 201, res.text);
      assert.equal(Number(res.json.downtime.downtimeMinutes), 30);
      return `downtime=${res.json.downtime.downtimeId}`;
    });

    await runTest('6. List downtime', 'List machine downtime events', async () => {
      const res = await admin.request('GET', `/api/production/machines/${machineId}/downtime`);
      assert.equal(res.status, 200, res.text);
      assert.ok(Array.isArray(res.json.events));
      assert.ok(res.json.events.length >= 1);
      return `events=${res.json.events.length}`;
    });

  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n=== Production Ops Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) { for (const r of results.filter(r => !r.passed)) console.error(` - ${r.suite} :: ${r.name}: ${r.details}`); process.exit(1); }
}
main().catch(err => { console.error(err); process.exit(1); });
