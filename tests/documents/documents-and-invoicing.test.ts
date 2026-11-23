import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';
import { parseDecimal4 } from '../../src/server/lib/decimal.ts';

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
    const durationMs = Date.now() - start;
    results.push({ suite, name, passed: true, durationMs, details });
    console.log(`  [PASS] (${durationMs}ms) ${suite} :: ${name} — ${details}`);
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const msg = err?.message || String(err);
    results.push({ suite, name, passed: false, durationMs, details: msg });
    console.error(`  [FAIL] (${durationMs}ms) ${suite} :: ${name} — ${msg}`);
  }
}

class CookieHttpClient {
  public cookie = '';
  constructor(private baseUrl: string) {}

  async request(
    method: string,
    pathname: string,
    options: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; headers: Headers; text: string; json: any }> {
    const headers: Record<string, string> = {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(options.headers || {}),
    };
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  }
}

async function main() {
  console.log('=== Printing Management System — All Documents, Preview & Workflow Invoicing Suite ===\n');

  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-docs-test-'));
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

  const adminClient = new CookieHttpClient(baseUrl);
  const accountantClient = new CookieHttpClient(baseUrl);
  const prodClient = new CookieHttpClient(baseUrl);

  async function assertJournalBalanced(journalTxnId: number) {
    const res = await adminClient.request('GET', `/api/journals/${journalTxnId}`);
    assert.equal(res.status, 200, `Journal ${journalTxnId} lookup failed`);
    const lines = res.json.entry.lines as any[];
    let deb = 0n;
    let cred = 0n;
    for (const l of lines) {
      deb += parseDecimal4(l.debit);
      cred += parseDecimal4(l.credit);
    }
    assert.equal(deb, cred, `Journal ${journalTxnId} unbalanced: debit=${deb} credit=${cred}`);
    assert.ok(deb > 0n, `Journal ${journalTxnId} has zero total`);
    return deb;
  }

  let companyAId = 0;
  let companyBId = 0;
  let seededCustomerId = 0;
  let contractId = 0;
  let examBatchId = 0;
  let printingJobId = 0;
  let billId = 0;
  let attachmentId = 0;

  try {
    // Authenticate roles
    assert.equal(
      (await adminClient.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } })).status,
      200
    );
    assert.equal(
      (await accountantClient.request('POST', '/api/auth/login', { body: { identifier: 'accountant', password: 'PrintingAdmin#2026' } })).status,
      200
    );
    assert.equal(
      (await prodClient.request('POST', '/api/auth/login', { body: { identifier: 'production', password: 'PrintingAdmin#2026' } })).status,
      200
    );

    const meRes = await adminClient.request('GET', '/api/auth/status');
    assert.equal(meRes.status, 200);
    companyAId = Number(meRes.json.activeCompany.id);
    const compB = (meRes.json.companies as any[]).find(c => Number(c.id) !== companyAId);
    assert.ok(compB, 'Expected second seeded company for RLS isolation verification');
    companyBId = Number(compB.id);

    const custRes = await adminClient.request('GET', '/api/customers');
    assert.equal(custRes.status, 200);
    seededCustomerId = Number(custRes.json.customers[0].id);

    // Seed vendor bill, contract + milestone, exam batch, printing job inside Company A for preview & invoicing
    await runTest('Setup', 'Seed contract, exam batch, quick-print job, and vendor bill in Company A', async () => {
      // Vendor & Bill for RBAC gating checks
      const vend = await adminClient.request('POST', '/api/vendors', {
        body: { name: 'Kafue Paper Mill Ltd', companyName: 'Kafue Paper Mill Ltd', terms: 'Net 30' },
      });
      assert.equal(vend.status, 201);
      const acctRes = await adminClient.request('GET', '/api/accounts?includeInactive=true');
      const allAccts = acctRes.json.accounts as any[];
      const expAcct = allAccts.find(a => a.code === '5010' || a.account_type === 'CostOfGoodsSold');
      const bankAcct = allAccts.find(a => a.account_type === 'Bank');
      const liabAcct = allAccts.find(a => a.code === '2250' || a.account_type === 'OtherCurrentLiability');
      assert.ok(expAcct && bankAcct && liabAcct, 'Expected COGS, Bank, and Liability accounts');

      const invItemsRes = await adminClient.request('GET', '/api/inventory');
      assert.equal(invItemsRes.status, 200);
      const rawMaterials = (invItemsRes.json.items as any[]).filter(i => i.item_type === 'raw_material');
      assert.ok(rawMaterials.length >= 1, 'Expected seeded raw_material item(s)');
      const rawPaperId = Number(rawMaterials[0].id);
      const rawTonerId = Number((rawMaterials[1] ?? rawMaterials[0]).id);

      const bill = await adminClient.request('POST', '/api/bills', {
        body: {
          vendorId: vend.json.vendor.id,
          billDate: '2026-11-12',
          dueDate: '2026-12-12',
          notes: 'Paper mill invoice',
          lines: [{ accountId: expAcct.id, description: 'A4 Bond Reams', quantity: 10, unitCost: 95 }],
        },
      });
      assert.equal(bill.status, 201);
      billId = Number(bill.json.bill.id);

      await db.withCompanyDb(companyAId, async tx => {
        const ctr = await tx.query<{ id: number }>(
          `INSERT INTO printing_contracts (
             company_id, contract_number, school_customer_id, title, academic_year,
             start_date, end_date, total_prepaid_amount, total_assessments, completed_assessments,
             remaining_balance, deposit_bank_account_id, liability_account_id, status, notes, activated_at
           ) VALUES ($1, 'CTR-DOC-001', $2, '2026 Examination Retainer', '2026', '2026-01-10', '2026-12-10', 40000.0000, 2, 0, 40000.0000, $3, $4, 'active', '2 assessment cycles', NOW())
           RETURNING id`,
          [companyAId, seededCustomerId, bankAcct.id, liabAcct.id]
        );
        contractId = Number(ctr.rows[0].id);

        await tx.query(
          `INSERT INTO contract_assessment_milestones (
             company_id, contract_id, assessment_number, label, scheduled_date, agreed_amount,
             estimated_sheets, estimated_impressions, paper_cost, toner_cost, status
           ) VALUES ($1, $2, 1, 'Term 1 Mock Exams', '2026-05-15', 20000.0000, 30000, 60000, 5400.0000, 1800.0000, 'pending')`,
          [companyAId, contractId]
        );

        const exm = await tx.query<{ id: number }>(
          `INSERT INTO exam_assessment_batches (
             company_id, school_customer_id, assessment_name, class_name, learners_count,
             price_per_learner
           ) VALUES ($1, $2, 'Term 2 Finals', 'Grade 12A', 150, 25.0000)
           RETURNING id`,
          [companyAId, seededCustomerId]
        );
        examBatchId = Number(exm.rows[0].id);

        await tx.query(
          `INSERT INTO exam_papers (
             company_id, batch_id, job_number, subject_name, pages, copies,
             raw_paper_item_id, raw_toner_item_id, print_side, binding_type,
             sheets_used, impressions_used, paper_cost, toner_cost, status, production_date,
             delivered_at
           ) VALUES ($1, $2, 'EXM-DOC-101', 'Mathematics', 12, 150, $3, $4, 'Duplex', 'Stapled', 900, 1800, 825.0000, 300.0000, 'delivered', '2026-11-12', NOW())`,
          [companyAId, examBatchId, rawPaperId, rawTonerId]
        );

        const pj = await tx.query<{ id: number }>(
          `INSERT INTO printing_jobs (
             company_id, job_number, job_type, customer_id, customer_name,
             raw_paper_item_id, raw_toner_item_id, title, pages, copies,
             print_side, sheets_used, impressions_used, paper_cost, toner_cost, extra_cost,
             manual_selling_price, job_date, status, notes
           ) VALUES ($1, 'QP-DOC-900', 'quick_photocopy', $2, 'Lusaka Boys Secondary School',
             $3, $4, 'Staff Handbook Photocopy', 16, 40, 'Duplex', 320, 640, 120.0000, 45.0000, 0.0000,
             650.0000, '2026-11-14', 'completed', 'Counter rush order')
           RETURNING id`,
          [companyAId, seededCustomerId, rawPaperId, rawTonerId]
        );
        printingJobId = Number(pj.rows[0].id);
      });

      return `contract=${contractId}, examBatch=${examBatchId}, printingJob=${printingJobId}, bill=${billId}`;
    });

    // 1. Unified /api/documents & Preview
    await runTest('Unified Documents', 'GET /api/documents returns all document categories & counts', async () => {
      const res = await adminClient.request('GET', '/api/documents');
      assert.equal(res.status, 200);
      assert.equal(res.json.companyId, companyAId);
      const kinds = new Set((res.json.documents as any[]).map(d => d.kind));
      assert.ok(kinds.has('invoice'), 'Expected seeded invoice in /api/documents');
      assert.ok(kinds.has('estimate'), 'Expected seeded estimate in /api/documents');
      assert.ok(kinds.has('bill'), 'Expected vendor bill in /api/documents');
      assert.ok(kinds.has('contract'), 'Expected contract in /api/documents');
      assert.ok(kinds.has('exam_batch'), 'Expected exam_batch in /api/documents');
      assert.ok(kinds.has('printing_job'), 'Expected printing_job in /api/documents');
      assert.equal(res.json.countsByCategory.all, res.json.documents.length);

      const catRes = await adminClient.request('GET', '/api/documents?category=contracts_exams');
      assert.equal(catRes.status, 200);
      assert.ok((catRes.json.documents as any[]).every(d => d.category === 'contracts_exams'));

      return `${res.json.documents.length} docs across ${kinds.size} kinds`;
    });

    await runTest('Preview Payloads', 'GET /api/documents/preview/:kind/:id renders full details for contract, exam_batch & printing_job', async () => {
      const ctrPrev = await adminClient.request('GET', `/api/documents/preview/contract/${contractId}`);
      assert.equal(ctrPrev.status, 200);
      assert.equal(ctrPrev.json.preview.documentNumber, 'CTR-DOC-001');
      assert.equal(ctrPrev.json.preview.contractMeta.assessments.length, 1);
      assert.equal(ctrPrev.json.preview.totals.totalCost, 7200);

      const exmPrev = await adminClient.request('GET', `/api/documents/preview/exam_batch/${examBatchId}`);
      assert.equal(exmPrev.status, 200);
      assert.equal(exmPrev.json.preview.examMeta.learnersCount, 150);
      assert.equal(exmPrev.json.preview.totals.total, 3750);

      const jobPrev = await adminClient.request('GET', `/api/documents/preview/printing_job/${printingJobId}`);
      assert.equal(jobPrev.status, 200);
      assert.equal(jobPrev.json.preview.documentNumber, 'QP-DOC-900');
      assert.equal(jobPrev.json.preview.totals.grossProfit, 485);

      return 'contract, exam_batch, and printing_job previews verified';
    });

    // 2. RBAC enforcement
    await runTest('RBAC', 'ProductionManager excluded from vendor bills; Accountant sees redacted internal costs', async () => {
      const prodList = await prodClient.request('GET', '/api/documents');
      assert.equal(prodList.status, 200);
      assert.ok(
        !(prodList.json.documents as any[]).some(d => d.kind === 'bill' || d.kind === 'purchase_order'),
        'ProductionManager should not receive bills or POs'
      );

      const prodBillPrev = await prodClient.request('GET', `/api/documents/preview/bill/${billId}`);
      assert.equal(prodBillPrev.status, 403);

      const accCtrPrev = await accountantClient.request('GET', `/api/documents/preview/contract/${contractId}`);
      assert.equal(accCtrPrev.status, 200);
      assert.equal(accCtrPrev.json.preview.totals.totalCost, undefined);
      assert.equal(accCtrPrev.json.preview.totals.grossProfit, undefined);

      const accJobPrev = await accountantClient.request('GET', `/api/documents/preview/printing_job/${printingJobId}`);
      assert.equal(accJobPrev.status, 200);
      assert.equal(accJobPrev.json.preview.totals.totalCost, undefined);
      assert.equal(accJobPrev.json.preview.totals.grossProfit, undefined);

      return 'Bill visibility & cost redaction verified across roles';
    });

    // 3. Attachments Upload / Preview / Download / Delete + Audit
    await runTest('Attachments Vault', 'Upload with notes, inline preview, download, and delete attachment (audited)', async () => {
      const up = await adminClient.request('POST', '/api/attachments', {
        body: {
          fileName: 'signed-school-contract.txt',
          contentType: 'text/plain',
          entityType: 'printing_contract',
          entityId: contractId,
          contentText: 'Signed School Contract Agreement — Lusaka Boys Secondary 2026',
          notes: 'Signed by Principal on 2026-11-15',
        },
      });
      assert.equal(up.status, 201);
      attachmentId = Number(up.json.attachment.attachmentId);
      assert.ok(attachmentId > 0);

      const listRes = await adminClient.request('GET', `/api/attachments?entityType=printing_contract&entityId=${contractId}`);
      assert.equal(listRes.status, 200);
      const found = (listRes.json.attachments as any[]).find(a => Number(a.attachmentId) === attachmentId);
      assert.ok(found, 'Uploaded attachment must appear in GET /api/attachments');
      assert.equal(found.notes, 'Signed by Principal on 2026-11-15');

      const docsRes = await adminClient.request('GET', '/api/documents?category=files');
      assert.equal(docsRes.status, 200);
      assert.ok((docsRes.json.documents as any[]).some(d => d.kind === 'attachment' && Number(d.id) === attachmentId));

      const prevInline = await adminClient.request('GET', `/api/attachments/${attachmentId}/preview`);
      assert.equal(prevInline.status, 200);
      assert.equal(prevInline.headers.get('x-content-type-options'), 'nosniff');
      assert.ok((prevInline.headers.get('content-disposition') || '').startsWith('inline;'));
      assert.ok(prevInline.text.includes('Lusaka Boys Secondary 2026'));

      const attPrevModel = await adminClient.request('GET', `/api/documents/preview/attachment/${attachmentId}`);
      assert.equal(attPrevModel.status, 200);
      assert.ok(attPrevModel.json.preview.fileMeta.textPreview.includes('Signed School Contract Agreement'));

      const dl = await adminClient.request('GET', `/api/attachments/${attachmentId}/download`);
      assert.equal(dl.status, 200);
      assert.ok((dl.headers.get('content-disposition') || '').startsWith('attachment;'));

      // Role guard: Accountant lacks attachments:write -> 403 on DELETE
      const accDel = await accountantClient.request('DELETE', `/api/attachments/${attachmentId}`);
      assert.equal(accDel.status, 403);

      return `attachment #${attachmentId} uploaded, previewed inline, downloaded, RBAC-checked`;
    });

    // 4. Cross-company RLS Isolation
    await runTest('Multi-Company Isolation', 'Company B cannot list or preview Company A documents or attachments', async () => {
      const sw = await adminClient.request('POST', '/api/auth/switch-company', {
        body: { companyId: companyBId },
      });
      assert.equal(sw.status, 200);

      const docsB = await adminClient.request('GET', '/api/documents');
      assert.equal(docsB.status, 200);
      assert.equal(docsB.json.companyId, companyBId);
      assert.ok(!(docsB.json.documents as any[]).some(d => d.documentNumber === 'CTR-DOC-001'));
      assert.ok(!(docsB.json.documents as any[]).some(d => d.kind === 'attachment' && Number(d.id) === attachmentId));

      const crossCtr = await adminClient.request('GET', `/api/documents/preview/contract/${contractId}`);
      assert.equal(crossCtr.status, 404);

      const crossAtt = await adminClient.request('GET', `/api/attachments/${attachmentId}/preview`);
      assert.equal(crossAtt.status, 404);

      const crossDel = await adminClient.request('DELETE', `/api/attachments/${attachmentId}`);
      assert.equal(crossDel.status, 404);

      // Switch back to Company A
      assert.equal(
        (await adminClient.request('POST', '/api/auth/switch-company', { body: { companyId: companyAId } })).status,
        200
      );

      // Delete the attachment now in Company A and verify audit log
      const delRes = await adminClient.request('DELETE', `/api/attachments/${attachmentId}`);
      assert.equal(delRes.status, 200);
      assert.equal(delRes.json.deleted, true);

      const afterPrev = await adminClient.request('GET', `/api/attachments/${attachmentId}/preview`);
      assert.equal(afterPrev.status, 404);

      return 'Company B blocked (404) from Company A documents & attachments';
    });

    // 5. Workflow Invoice Generation (Contract Retainer, Milestone, Exam Batch, Quick Print) + Idempotency + GL Balance
    await runTest('Workflow Invoicing', 'Generate GL-posted invoices from Contract Retainer, Milestone, Exam Batch & Quick Print with idempotency', async () => {
      // Unauthorized role check
      const prodGen = await prodClient.request('POST', '/api/documents/generate-invoice', {
        body: {
          sourceKind: 'quick_print',
          customerName: 'Lusaka Boys Secondary School',
          lines: [{ description: 'Test', quantity: 1, rate: 100 }],
        },
      });
      assert.equal(prodGen.status, 403);

      // (a) Contract Retainer to new auto-created customer name + idempotency replay
      const retainerKey = 'test-contract-retainer-001';
      const retainerBody = {
        sourceKind: 'contract',
        sourceRef: 'CTR-DOC-001',
        customerName: 'Chibombo Girls Technical Secondary',
        customerType: 'school',
        invoiceDate: '2026-11-15',
        dueDate: '2026-12-15',
        idempotencyKey: retainerKey,
        notes: 'Annual Prepaid Retainer',
        lines: [{ description: 'CTR-DOC-001: 2026 Examination Retainer', quantity: 1, rate: 40000, unitCost: 14400 }],
      };
      const ctrInv1 = await adminClient.request('POST', '/api/documents/generate-invoice', {
        body: retainerBody,
      });
      assert.equal(ctrInv1.status, 201, ctrInv1.text);
      assert.equal(ctrInv1.json.idempotentReplay, false);
      assert.ok(Number(ctrInv1.json.invoice.journalTxnId) > 0);
      await assertJournalBalanced(Number(ctrInv1.json.invoice.journalTxnId));

      const ctrInvReplay = await adminClient.request('POST', '/api/documents/generate-invoice', {
        body: retainerBody,
      });
      assert.equal(ctrInvReplay.status, 200);
      assert.equal(ctrInvReplay.json.idempotentReplay, true);
      assert.equal(Number(ctrInvReplay.json.invoice.id), Number(ctrInv1.json.invoice.id));

      // Verify mismatched payload with same idempotencyKey safely rejects with 409 Conflict
      const ctrInvConflict = await adminClient.request('POST', '/api/documents/generate-invoice', {
        body: { ...retainerBody, notes: 'Tampered amount attempt' },
      });
      assert.equal(ctrInvConflict.status, 409);

      // (b) Contract Milestone linked in PostgreSQL
      const msInv = await adminClient.request('POST', '/api/documents/generate-invoice', {
        body: {
          sourceKind: 'contract_milestone',
          sourceRef: 'CTR-DOC-001-A1',
          customerId: seededCustomerId,
          invoiceDate: '2026-11-15',
          dueDate: '2026-12-15',
          postgresContractId: contractId,
          postgresMilestoneNumber: 1,
          idempotencyKey: 'test-contract-ms-1',
          lines: [{ description: 'Term 1 Mock Exams Milestone', quantity: 1, rate: 20000, unitCost: 7200 }],
        },
      });
      assert.equal(msInv.status, 201, msInv.text);
      await assertJournalBalanced(Number(msInv.json.invoice.journalTxnId));

      const ctrPrevAfter = await adminClient.request('GET', `/api/documents/preview/contract/${contractId}`);
      assert.equal(ctrPrevAfter.status, 200);
      assert.equal(
        Number(ctrPrevAfter.json.preview.contractMeta.assessments[0].linkedInvoiceId),
        Number(msInv.json.invoice.id)
      );

      // (c) Consolidated Exam Batch linked in PostgreSQL
      const exmInv = await adminClient.request('POST', '/api/documents/generate-invoice', {
        body: {
          sourceKind: 'exam_batch',
          sourceRef: 'EXM-DOC-12A',
          customerId: seededCustomerId,
          invoiceDate: '2026-11-15',
          dueDate: '2026-12-15',
          postgresExamBatchId: examBatchId,
          idempotencyKey: 'test-exam-batch-1',
          lines: [{ description: 'Grade 12A Term 2 Finals (150 learners)', quantity: 150, rate: 25, unitCost: 7.5 }],
        },
      });
      assert.equal(exmInv.status, 201, exmInv.text);
      await assertJournalBalanced(Number(exmInv.json.invoice.journalTxnId));

      const exmPrevAfter = await adminClient.request('GET', `/api/documents/preview/exam_batch/${examBatchId}`);
      assert.equal(exmPrevAfter.status, 200);
      assert.equal(Number(exmPrevAfter.json.preview.examMeta.linkedInvoiceId), Number(exmInv.json.invoice.id));
      assert.equal(exmPrevAfter.json.preview.examMeta.linkedInvoiceNumber, exmInv.json.invoice.invoiceNumber);

      // (d) Quick Print Job linked in PostgreSQL
      const jobInv = await adminClient.request('POST', '/api/documents/generate-invoice', {
        body: {
          sourceKind: 'quick_print',
          sourceRef: 'QP-DOC-900',
          customerId: seededCustomerId,
          invoiceDate: '2026-11-15',
          dueDate: '2026-11-30',
          postgresPrintingJobId: printingJobId,
          idempotencyKey: 'test-quick-print-1',
          lines: [{ description: 'QP-DOC-900 Staff Handbook Photocopy', quantity: 1, rate: 650, unitCost: 165 }],
        },
      });
      assert.equal(jobInv.status, 201, jobInv.text);
      await assertJournalBalanced(Number(jobInv.json.invoice.journalTxnId));

      const jobPrevAfter = await adminClient.request('GET', `/api/documents/preview/printing_job/${printingJobId}`);
      assert.equal(jobPrevAfter.status, 200);
      assert.equal(Number(jobPrevAfter.json.preview.linkedInvoiceId), Number(jobInv.json.invoice.id));
      assert.equal(jobPrevAfter.json.preview.linkedInvoiceNumber, jobInv.json.invoice.invoiceNumber);

      // Verify Trial Balance remains strictly balanced
      const tb = await adminClient.request('GET', '/api/reports/trial-balance?startDate=2026-01-01&endDate=2026-12-31');
      assert.equal(tb.status, 200);
      assert.equal(tb.json.isBalanced, true);

      return `Generated & GL-verified 4 workflow invoices + idempotent replay; Trial Balance balanced (${tb.json.totalDebit})`;
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }

  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.filter(r => !r.passed).length;
  console.log(`\nSummary: ${passedCount}/${results.length} passed, ${failedCount} failed.`);
  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test harness error:', err);
  process.exit(1);
});
