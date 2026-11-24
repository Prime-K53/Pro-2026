import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';
import { runTenantTick } from '../../src/server/scheduler.ts';
import { createReportSchedule } from '../../src/server/services/reportSchedulingService.ts';

interface TestRecord {
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

const results: TestRecord[] = [];

async function runTest(suite: string, name: string, fn: () => Promise<string | void>) {
  const start = Date.now();
  try {
    const details = (await fn()) || 'OK';
    results.push({ suite, name, passed: true, durationMs: Date.now() - start, details });
    console.log(`  [PASS] (${Date.now() - start}ms) ${suite} :: ${name} — ${details}`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    results.push({ suite, name, passed: false, durationMs: Date.now() - start, details: msg });
    console.error(`  [FAIL] (${Date.now() - start}ms) ${suite} :: ${name} — ${msg}`);
  }
}

class CookieHttpClient {
  public cookie = '';
  constructor(private baseUrl: string) {}

  async request(
    method: string,
    pathname: string,
    options: { body?: unknown } = {}
  ): Promise<{ status: number; text: string; json: any }> {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  }
}

async function main() {
  console.log('=== Printing Management System — Finance Controls & Operational Reporting Suite ===\n');

  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-controls-test-'));
  const baseCfg = loadServerConfig();
  const testCfg = {
    ...baseCfg,
    nodeEnv: 'test',
    isProduction: false,
    attachmentsDir: tmpAttachDir,
  };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const admin = new CookieHttpClient(baseUrl);
  const accountant = new CookieHttpClient(baseUrl);
  const bookkeeper = new CookieHttpClient(baseUrl);

  try {
    await runTest('1. Setup', 'Authenticate Administrator, Accountant, Bookkeeper', async () => {
      for (const [client, username] of [
        [admin, 'admin'],
        [accountant, 'accountant'],
        [bookkeeper, 'bookkeeper'],
      ] as Array<[CookieHttpClient, string]>) {
        const res = await client.request('POST', '/api/auth/login', {
          body: { identifier: username, password: 'PrintingAdmin#2026' },
        });
        assert.equal(res.status, 200, `login ${username} failed: ${res.text}`);
      }
      return 'admin, accountant, bookkeeper authenticated';
    });

    await runTest('2. Maker-Checker', 'Threshold approval blocks invoice creation, blocks self-approval, and permits approved replay', async () => {
      const policy = await admin.request('PUT', '/api/approvals/policies', {
        body: { actionType: 'invoice', thresholdAmount: '1000.0000', isEnabled: true },
      });
      assert.equal(policy.status, 200, `policy update failed: ${policy.text}`);

      const customer = await admin.request('POST', '/api/customers', {
        body: {
          customerType: 'school',
          name: 'Finance Controls Test School',
          companyName: 'Finance Controls Test School Ltd',
          email: 'bursar@controls.example',
        },
      });
      assert.equal(customer.status, 201, `customer creation failed: ${customer.text}`);

      const invoiceBody = {
        customerId: customer.json.customer.id,
        invoiceDate: '2026-11-16',
        dueDate: '2026-12-16',
        lines: [
          { description: 'Controlled exam printing', quantity: 2000, rate: 1.25, taxable: false },
        ],
      };

      const blocked = await admin.request('POST', '/api/invoices', { body: invoiceBody });
      assert.equal(blocked.status, 202, `expected 202 approval gate, got ${blocked.status}: ${blocked.text}`);
      assert.equal(blocked.json.approvalRequired, true);
      const requestId = Number(blocked.json.approvalRequest.id);
      assert.ok(requestId > 0);

      const pending = await admin.request('GET', '/api/approvals?status=pending');
      assert.equal(pending.status, 200);
      assert.ok(pending.json.requests.some((r: any) => r.id === requestId));

      const selfApproval = await admin.request('POST', `/api/approvals/${requestId}/approve`, {
        body: { note: 'self approval attempt' },
      });
      assert.equal(selfApproval.status, 409, `self-approval must be blocked: ${selfApproval.text}`);
      assert.equal(selfApproval.json.code, 'SELF_APPROVAL_FORBIDDEN');

      const approved = await accountant.request('POST', `/api/approvals/${requestId}/approve`, {
        body: { note: 'approved by accountant' },
      });
      assert.equal(approved.status, 200, `accountant approval failed: ${approved.text}`);

      const created = await admin.request('POST', '/api/invoices', {
        body: { ...invoiceBody, approvalRequestId: requestId },
      });
      assert.equal(created.status, 201, `approved invoice creation failed: ${created.text}`);

      const request = await admin.request('GET', `/api/approvals/${requestId}`);
      assert.equal(request.status, 200);
      assert.equal(request.json.request.status, 'approved');
      assert.ok(request.json.request.consumed_at, 'approval request must be consumed after document creation');

      return `invoice ${created.json.invoice.invoice_number} created only after accountant approval`;
    });

    await runTest('3. Maker-Checker', 'Journal entries above threshold require approval', async () => {
      const policy = await admin.request('PUT', '/api/approvals/policies', {
        body: { actionType: 'journal_entry', thresholdAmount: '100.0000', isEnabled: true },
      });
      assert.equal(policy.status, 200, `journal policy failed: ${policy.text}`);

      const accounts = await admin.request('GET', '/api/accounts?includeInactive=true');
      assert.equal(accounts.status, 200);
      const byCode = new Map<string, any>();
      for (const a of accounts.json.accounts) byCode.set(a.code, a);

      const journalBody = {
        txnDate: '2026-11-16',
        description: 'Controlled adjusting journal',
        lines: [
          { accountId: byCode.get('6200').id, debit: '500.0000', credit: '0.0000', description: 'Expense' },
          { accountId: byCode.get('1010').id, debit: '0.0000', credit: '500.0000', description: 'Bank' },
        ],
      };

      const blocked = await admin.request('POST', '/api/journals', { body: journalBody });
      assert.equal(blocked.status, 202, `expected 202 approval gate, got ${blocked.status}: ${blocked.text}`);
      const requestId = Number(blocked.json.approvalRequest.id);

      const approved = await accountant.request('POST', `/api/approvals/${requestId}/approve`, {
        body: { note: 'approved' },
      });
      assert.equal(approved.status, 200, `journal approval failed: ${approved.text}`);

      const created = await admin.request('POST', '/api/journals', {
        body: { ...journalBody, approvalRequestId: requestId },
      });
      assert.equal(created.status, 201, `approved journal creation failed: ${created.text}`);
      assert.ok(created.json.entry.id > 0);
      return `journal #${created.json.entry.id} approved and posted`;
    });

    await runTest('3b. Maker-Checker', 'Inventory shrinkage write-off above threshold requires approval before posting', async () => {
      const policy = await admin.request('PUT', '/api/approvals/policies', {
        body: { actionType: 'inventory_writeoff', thresholdAmount: '100.0000', isEnabled: true },
      });
      assert.equal(policy.status, 200, `inventory writeoff policy failed: ${policy.text}`);

      const created = await admin.request('POST', '/api/inventory', {
        body: {
          sku: `WO-${Date.now()}`,
          name: 'Write-off approval test item',
          itemType: 'raw_material',
          unitCost: '10.0000',
          onHand: '100.0000',
        },
      });
      assert.equal(created.status, 201, `item creation failed: ${created.text}`);
      const itemId = Number(created.json.item.id);
      assert.ok(itemId > 0);

      // Shrinkage of 50 units @ 10 = 500 value, above the 100 threshold → 202.
      const blocked = await admin.request('POST', `/api/inventory/${itemId}/adjust`, {
        body: { adjustmentQty: -50, reason: 'Damaged in transit' },
      });
      assert.equal(blocked.status, 202, `expected 202 approval gate, got ${blocked.status}: ${blocked.text}`);
      assert.equal(blocked.json.approvalRequired, true);
      const requestId = Number(blocked.json.approvalRequest.id);
      assert.ok(requestId > 0);

      // Stock must be unchanged while approval is pending.
      const mid = await admin.request('GET', `/api/inventory/${itemId}`);
      assert.equal(mid.status, 200, `item detail failed: ${mid.text}`);
      assert.equal(Number(mid.json.item.on_hand), 100, `stock changed while approval pending: ${mid.text}`);

      // The requester cannot approve their own write-off.
      const selfApproval = await admin.request('POST', `/api/approvals/${requestId}/approve`, {
        body: { note: 'self approval attempt' },
      });
      assert.equal(selfApproval.status, 409, `self-approval must be blocked: ${selfApproval.text}`);
      assert.equal(selfApproval.json.code, 'SELF_APPROVAL_FORBIDDEN');

      // A second approver signs off.
      const approved = await accountant.request('POST', `/api/approvals/${requestId}/approve`, {
        body: { note: 'approved by accountant' },
      });
      assert.equal(approved.status, 200, `write-off approval failed: ${approved.text}`);

      // Re-submitting with the approval posts the write-off exactly once.
      const applied = await admin.request('POST', `/api/inventory/${itemId}/adjust`, {
        body: { adjustmentQty: -50, reason: 'Damaged in transit', approvalRequestId: requestId },
      });
      assert.equal(applied.status, 201, `approved write-off failed: ${applied.status} ${applied.text}`);
      assert.equal(Number(applied.json.adjustment.onHandAfter), 50, `unexpected on hand: ${applied.text}`);

      // The approval is consumed once the write-off posts.
      const req = await admin.request('GET', `/api/approvals/${requestId}`);
      assert.equal(req.status, 200);
      assert.equal(req.json.request.status, 'approved');
      assert.ok(req.json.request.consumed_at, 'approval must be consumed after the write-off posts');

      return 'write-off of 50 units posted only after a second approver signed off; stock 100 -> 50';
    });

    await runTest('4. Period Close', 'Checklist workflow exposes auto evidence, manual sign-off, and enforcement', async () => {
      const period = await admin.request('POST', '/api/periods', {
        body: {
          periodName: 'November 2026 Close Test',
          startDate: '2026-11-01',
          endDate: '2026-11-30',
        },
      });
      assert.equal(period.status, 201, `period creation failed: ${period.text}`);
      const periodId = Number(period.json.period.id);

      const checklist = await admin.request('GET', `/api/periods/${periodId}/checklist`);
      assert.equal(checklist.status, 200, `checklist failed: ${checklist.text}`);
      const tasks = checklist.json.tasks as any[];
      assert.ok(tasks.some(t => t.task_key === 'trial_balance_balanced'));
      assert.ok(tasks.some(t => t.task_key === 'management_signoff' && t.is_manual));

      const signoff = await admin.request('POST', `/api/periods/${periodId}/checklist/management_signoff/complete`, {
        body: { notes: 'Management reviewed the period-end pack.' },
      });
      assert.equal(signoff.status, 200, `signoff failed: ${signoff.text}`);
      assert.equal(signoff.json.task.status, 'complete');

      const policy = await admin.request('PUT', '/api/periods/checklist-policy', {
        body: { enabled: true },
      });
      assert.equal(policy.status, 200, `checklist policy failed: ${policy.text}`);

      const blockedClose = await admin.request('POST', `/api/periods/${periodId}/close`, { body: {} });
      assert.equal(blockedClose.status, 409, `close should be blocked by incomplete checklist: ${blockedClose.text}`);
      assert.equal(blockedClose.json.code, 'CLOSE_CHECKLIST_INCOMPLETE');

      return `period #${periodId} checklist generated; close blocked until required tasks complete`;
    });

    await runTest('5. Operational Reports', 'Printing job profitability, WIP aging, spoilage, estimate-vs-actual, inventory valuation, and COGS reconciliation respond', async () => {
      const checks: Array<[string, string]> = [
        ['/api/reports/printing-job-profitability', 'totals'],
        ['/api/reports/wip-aging', 'buckets'],
        ['/api/reports/printing-spoilage', 'totals'],
        ['/api/reports/estimate-vs-actual', 'totals'],
        ['/api/reports/inventory-valuation', 'totals'],
        ['/api/reports/cogs-reconciliation', 'totals'],
      ];
      for (const [endpoint, key] of checks) {
        const res = await admin.request('GET', endpoint);
        assert.equal(res.status, 200, `${endpoint} failed: ${res.text}`);
        assert.ok(res.json.report && res.json.report[key], `${endpoint} missing report.${key}`);
      }
      return checks.map(([endpoint]) => endpoint).join(', ');
    });

    await runTest('6. Dashboard Alerts', 'Operational alerts include approval, receivables, stock, and reconciliation signals', async () => {
      const res = await admin.request('GET', '/api/dashboard/alerts');
      assert.equal(res.status, 200, `alerts failed: ${res.text}`);
      assert.ok(Array.isArray(res.json.alerts));
      assert.ok(res.json.counts && typeof res.json.counts.pendingApprovals === 'number');
      return `${res.json.alerts.length} active alert groups`;
    });

    await runTest('7. Scheduled Reports', 'Create, run, and run-due a recurring report schedule', async () => {
      const created = await admin.request('POST', '/api/report-schedules', {
        body: {
          name: 'Monthly trial balance to finance',
          reportKey: 'trial_balance',
          frequency: 'monthly',
          dayOfMonth: 1,
          timeOfDay: '07:00',
          recipients: ['cfo@primepress.zm'],
        },
      });
      assert.equal(created.status, 201, `schedule create failed: ${created.text}`);
      const scheduleId = Number(created.json.schedule.id);

      const list = await admin.request('GET', '/api/report-schedules');
      assert.equal(list.status, 200);
      assert.ok(list.json.schedules.some((s: any) => s.id === scheduleId));
      assert.ok(list.json.availableReports.some((r: any) => r.key === 'job_profitability'));

      const run = await admin.request('POST', `/api/report-schedules/${scheduleId}/run`);
      assert.equal(run.status, 200, `schedule run failed: ${run.text}`);
      assert.equal(run.json.run.status, 'completed');
      assert.equal(run.json.run.recipientsCount, 1);
      assert.ok(run.json.delivery, 'manual run must attempt delivery, not leave mail silently queued');
      assert.equal(run.json.delivery.processed, 1);
      assert.equal(
        run.json.delivery.sent + run.json.delivery.skipped + run.json.delivery.retried,
        1,
        `unexpected delivery summary: ${JSON.stringify(run.json.delivery)}`
      );

      const due = await admin.request('POST', '/api/report-schedules/run-due');
      assert.equal(due.status, 200, `run-due failed: ${due.text}`);
      assert.ok(Array.isArray(due.json.results));

      return `schedule #${scheduleId} ran and delivered to ${run.json.run.recipientsCount} recipient`;
    });

    await runTest('8. RBAC', 'Bookkeeper cannot configure or decide approvals', async () => {
      const configure = await bookkeeper.request('PUT', '/api/approvals/policies', {
        body: { actionType: 'invoice', thresholdAmount: '1.0000', isEnabled: true },
      });
      assert.equal(configure.status, 403, `bookkeeper policy write should be forbidden: ${configure.text}`);

      const pending = await admin.request('GET', '/api/approvals?status=pending');
      const pendingId = pending.json.requests?.[0]?.id;
      if (pendingId) {
        const decide = await bookkeeper.request('POST', `/api/approvals/${pendingId}/approve`, {
          body: { note: 'bookkeeper attempt' },
        });
        assert.equal(decide.status, 403, `bookkeeper approval should be forbidden: ${decide.text}`);
      }
      return 'bookkeeper forbidden from configuring or deciding approvals';
    });

    await runTest('9. Dedicated Approval Gates', 'Estimate conversion and PO receiving use their own action types', async () => {
      for (const actionType of ['estimate_conversion', 'po_receive']) {
        const policy = await admin.request('PUT', '/api/approvals/policies', {
          body: { actionType, thresholdAmount: '1.0000', isEnabled: true },
        });
        assert.equal(policy.status, 200, `${actionType} policy failed: ${policy.text}`);
      }

      const customer = await admin.request('POST', '/api/customers', {
        body: {
          customerType: 'corporate',
          name: 'Dedicated Gate Customer',
          companyName: 'Dedicated Gate Customer Ltd',
          email: 'ap@dedicated-gate.example',
        },
      });
      assert.equal(customer.status, 201, `customer creation failed: ${customer.text}`);

      const estimate = await admin.request('POST', '/api/estimates', {
        body: {
          customerId: customer.json.customer.id,
          estimateDate: '2026-11-16',
          lines: [{ description: 'Gate estimate', quantity: 100, rate: 25, unitCost: 10 }],
        },
      });
      assert.equal(estimate.status, 201, `estimate creation failed: ${estimate.text}`);

      const conversion = await admin.request('POST', `/api/estimates/${estimate.json.estimate.id}/convert`, {
        body: {},
      });
      assert.equal(conversion.status, 202, `estimate conversion should be gated: ${conversion.text}`);
      assert.equal(conversion.json.approvalRequest.action_type, 'estimate_conversion');
      assert.equal(conversion.json.approvalRequest.entity_type, 'estimate');

      const vendor = await admin.request('POST', '/api/vendors', {
        body: {
          companyName: 'Dedicated Gate Supplier Ltd',
          email: 'orders@dedicated-gate.example',
        },
      });
      assert.equal(vendor.status, 201, `vendor creation failed: ${vendor.text}`);

      const po = await admin.request('POST', '/api/purchase-orders', {
        body: {
          vendorId: vendor.json.vendor.id,
          poDate: '2026-11-16',
          lines: [{ description: 'Gate paper', quantity: 10, rate: 100 }],
        },
      });
      assert.equal(po.status, 201, `purchase order creation failed: ${po.text}`);

      const receipt = await admin.request('POST', `/api/purchase-orders/${po.json.purchaseOrder.id}/receive`, {
        body: { billDate: '2026-11-16' },
      });
      assert.equal(receipt.status, 202, `PO receiving should be gated: ${receipt.text}`);
      assert.equal(receipt.json.approvalRequest.action_type, 'po_receive');
      assert.equal(receipt.json.approvalRequest.entity_type, 'purchase_order');

      return 'estimate_conversion and po_receive gates are distinct from invoice/bill';
    });

    await runTest('10. Tenant Scheduler', 'Due reports run per tenant under a lease and queue real report bodies', async () => {
      const companyId = await db.withSystemDb(async tx => {
        const res = await tx.query<{ id: number }>(
          `SELECT id FROM companies WHERE name = 'Prime Educational Press Ltd' LIMIT 1`
        );
        return Number(res.rows[0].id);
      });

      const schedule = await db.withCompanyDb(companyId, tx =>
        createReportSchedule(
          tx,
          companyId,
          { userId: 1, username: 'admin', role: 'Administrator' },
          {
            name: 'Tenant scheduler tick test',
            reportKey: 'trial_balance',
            frequency: 'daily',
            timeOfDay: '07:00',
            recipients: ['scheduler@primepress.zm'],
          }
        )
      );
      await db.withCompanyDb(companyId, tx =>
        tx.query(
          `UPDATE report_schedules SET next_run_at = NOW() - INTERVAL '1 minute'
            WHERE company_id = $1 AND id = $2`,
          [companyId, schedule.id]
        )
      );

      const tick = await runTenantTick(db, companyId);
      assert.equal(tick.leased, true, 'tenant tick should acquire its lease');
      assert.ok(
        tick.reportRuns.some(r => r.scheduleId === schedule.id && r.status === 'completed'),
        `due schedule did not run: ${JSON.stringify(tick.reportRuns)}`
      );
      assert.ok(tick.email && tick.email.processed >= 1, 'scheduled report did not queue mail');

      const emailRow = await db.withCompanyDb(companyId, async tx => {
        const res = await tx.query<any>(
          `SELECT status, attempts, body, last_error
             FROM email_log
            WHERE company_id = $1 AND entity_type = 'report_schedule' AND entity_id = $2
            ORDER BY id DESC LIMIT 1`,
          [companyId, schedule.id]
        );
        return res.rows[0];
      });
      assert.ok(emailRow, 'email_log row missing for scheduled report');
      assert.ok(String(emailRow.body || '').includes('Report data'), 'queued email must include report content');
      assert.ok(
        ['sent', 'skipped', 'queued'].includes(String(emailRow.status)),
        `unexpected delivery status ${emailRow.status}`
      );

      // A competing process holding the tenant lease must be able to block this process.
      await db.withSystemDb(async tx => {
        await tx.query(
          `INSERT INTO scheduler_leases (company_id, lease_owner, lease_expires_at)
           VALUES ($1, 'competing-process', NOW() + INTERVAL '5 minutes')
           ON CONFLICT (company_id) DO UPDATE
              SET lease_owner = EXCLUDED.lease_owner,
                  lease_expires_at = EXCLUDED.lease_expires_at`,
          [companyId]
        );
      });
      const blocked = await runTenantTick(db, companyId);
      assert.equal(blocked.leased, false, 'tenant tick must respect a competing lease');
      await db.withSystemDb(async tx => {
        await tx.query(`DELETE FROM scheduler_leases WHERE company_id = $1`, [companyId]);
      });

      return `schedule #${schedule.id} ran inside tenant ${companyId}; email body and lease observed`;
    });
  } finally {
    server.close();
    await db.close();
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }

  const passed = results.filter(r => r.passed).length;
  console.log(`\nSummary: ${passed}/${results.length} PASSED`);
  if (passed !== results.length) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});