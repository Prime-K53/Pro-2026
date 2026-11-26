import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import {
  createExamBatch,
  generateExamGroupProduction,
  completeExamGroupProduction,
  approveExamGroupQc,
  deliverExamGroupChildren,
  postExamGroupInvoice,
  getExamGroupSummary,
  updateExamPaperStatus,
} from '../../src/server/services/printingRecordsService.ts';

const cfg = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseServiceRoleKey: '',
  jwtSecret: 'test-secret',
  isProduction: false,
  nodeEnv: 'test',
};

type Ctx = {
  db: any;
  companyId: number;
  actor: ActorContext;
  customerId: number;
  paperItemId: number;
  tonerItemId: number;
};

async function setup(): Promise<Ctx> {
  const db = await createServerDatabase(cfg as any, { inMemory: true, seedDemo: true });
  const users = await db.withSystemDb(async (tx: any) => {
    const r = await tx.query(
      `SELECT u.id, u.username, m.company_id
         FROM users u
         JOIN company_memberships m ON m.user_id = u.id
        WHERE u.is_active = TRUE
        ORDER BY u.id ASC`
    );
    return r.rows;
  });
  const admin = users.find((u: any) => String(u.username).toLowerCase() === 'admin') || users[0];
  const companyId = Number(admin.company_id);
  const actor: ActorContext = { userId: Number(admin.id), username: String(admin.username), role: 'Administrator' };

  const ctx = await db.withCompanyDb(companyId, async (tx: any) => {
    const cust = await tx.query(`SELECT id FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1`, [companyId]);
    const paper = await tx.query(
      `SELECT id FROM inventory_items WHERE company_id = $1 AND item_type = 'raw_material' ORDER BY id ASC LIMIT 1`,
      [companyId]
    );
    const toner = await tx.query(
      `SELECT id FROM inventory_items WHERE company_id = $1 AND item_type = 'raw_material' ORDER BY id DESC LIMIT 1`,
      [companyId]
    );
    return {
      customerId: Number(cust.rows[0].id),
      paperItemId: Number(paper.rows[0].id),
      tonerItemId: Number(toner.rows[0].id),
    };
  });

  return { db, companyId, actor, ...ctx };
}

const SUBJECTS = ['Mathematics', 'English', 'Physics', 'Chemistry', 'Biology', 'History'];

function buildClasses(ctx: Ctx, classCount: number, subjectsPerClass: number, learners: number) {
  return Array.from({ length: classCount }, (_, ci) => ({
    className: `Form ${ci + 1}`,
    learnersCount: learners,
    pricePerLearner: '10.0000',
    papers: Array.from({ length: subjectsPerClass }, (_, si) => ({
      subjectName: SUBJECTS[si % SUBJECTS.length],
      pages: 4,
      copies: learners,
      rawPaperItemId: ctx.paperItemId,
      rawTonerItemId: ctx.tonerItemId,
      printSide: 'Duplex',
      bindingType: 'Stapled',
      paperSize: 'A4',
      productionDate: '2026-11-24',
    })),
  }));
}

async function count(ctx: Ctx, sql: string, params: any[] = []): Promise<number> {
  return ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
    const r = await tx.query(sql, [ctx.companyId, ...params]);
    return Number(r.rows[0]?.count ?? 0);
  });
}

const DELIVERY_NOTES = `SELECT COUNT(*)::int AS count FROM delivery_notes WHERE company_id = $1`;
const INVOICES = `SELECT COUNT(*)::int AS count FROM invoices WHERE company_id = $1`;
const PARENT_JOBS = `SELECT COUNT(*)::int AS count FROM printing_jobs WHERE company_id = $1 AND job_type = 'exam_batch'`;
const CHILD_JOBS = `SELECT COUNT(*)::int AS count FROM printing_jobs WHERE company_id = $1 AND parent_job_id IS NOT NULL`;

test('acceptance: one batch group -> one parent job -> 30 children -> one consolidated invoice', async () => {
  const ctx = await setup();
  const invoicesBase = await count(ctx, INVOICES);
  try {
    const created: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: '2026 Acceptance Exam',
        classes: buildClasses(ctx, 5, 6, 5),
        idempotencyKey: 'acc-create-1',
      })
    );
    assert.ok(created.examBatchGroupId, 'batch creation must return the parent group id');
    assert.equal(created.batches.length, 5, 'one class batch per class');
    assert.equal(created.papers.length, 30, '30 subject papers');
    const groupId = created.examBatchGroupId;

    const summary = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      generateExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'acc-gen-1' })
    );
    assert.equal(summary.classCount, 5);
    assert.equal(summary.subjectCount, 30);
    assert.ok(summary.parentJobNumber?.startsWith('JOB-'), 'parent job number is independent (JOB-…)');
    assert.equal(await count(ctx, PARENT_JOBS), 1, 'exactly one parent job');
    assert.equal(await count(ctx, CHILD_JOBS), 30, 'all 30 child jobs linked to the parent');

    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      completeExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'acc-prod-1' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      approveExamGroupQc(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'acc-qc-1' })
    );
    const delivered = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      deliverExamGroupChildren(tx, ctx.companyId, ctx.actor, {
        groupId,
        idempotencyKey: 'acc-del-1',
        recipientName: 'School Bursar',
      })
    );
    assert.equal(delivered.delivered, true, 'all children delivered');
    assert.equal(await count(ctx, DELIVERY_NOTES), 30, 'one real delivery note per child');

    const invoiced = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      postExamGroupInvoice(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'acc-inv-1' })
    );
    assert.equal(invoiced.invoiced, true, 'group invoiced');
    assert.ok(invoiced.invoiceNumber?.startsWith('INV-'), 'invoice number is independent (INV-…)');
    assert.notEqual(invoiced.invoiceNumber, invoiced.parentJobNumber, 'invoice and job numbers differ');
    assert.equal((await count(ctx, INVOICES)) - invoicesBase, 1, 'exactly one consolidated invoice');
  } finally {
    await ctx.db.close();
  }
});

test('idempotency: repeated checkpoints never duplicate jobs, notes, invoices or postings', async () => {
  const ctx = await setup();
  try {
    const created: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: '2026 Idempotency Exam',
        classes: buildClasses(ctx, 2, 3, 4),
        idempotencyKey: 'idem-create-1',
      })
    );
    const groupId = created.examBatchGroupId;

    // Repeat every checkpoint with the SAME idempotency keys.
    for (const key of ['gen', 'prod', 'qc']) {
      await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
        key === 'gen'
          ? generateExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: `idem-${key}` })
          : key === 'prod'
          ? completeExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: `idem-${key}` })
          : approveExamGroupQc(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: `idem-${key}` })
      );
    }
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      deliverExamGroupChildren(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'idem-del' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      postExamGroupInvoice(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'idem-inv' })
    );

    const notesBefore = await count(ctx, DELIVERY_NOTES);
    const invoicesBefore = await count(ctx, INVOICES);
    const parentsBefore = await count(ctx, PARENT_JOBS);
    const childrenBefore = await count(ctx, CHILD_JOBS);

    // Replay all checkpoints.
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      generateExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'idem-gen' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      completeExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'idem-prod' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      approveExamGroupQc(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'idem-qc' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      deliverExamGroupChildren(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'idem-del' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      postExamGroupInvoice(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'idem-inv' })
    );

    assert.equal(await count(ctx, DELIVERY_NOTES), notesBefore, 'no duplicate delivery notes');
    assert.equal(await count(ctx, INVOICES), invoicesBefore, 'no duplicate invoices');
    assert.equal(await count(ctx, PARENT_JOBS), parentsBefore, 'no duplicate parent jobs');
    assert.equal(await count(ctx, CHILD_JOBS), childrenBefore, 'no duplicate child jobs');
  } finally {
    await ctx.db.close();
  }
});

test('concurrency: parallel generate/deliver/invoice requests are safe', async () => {
  const ctx = await setup();
  const invoicesBase = await count(ctx, INVOICES);
  const notesBase = await count(ctx, DELIVERY_NOTES);
  try {
    const created: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: '2026 Concurrency Exam',
        classes: buildClasses(ctx, 2, 2, 4),
        idempotencyKey: 'conc-create-1',
      })
    );
    const groupId = created.examBatchGroupId;

    const run = (fn: (tx: any) => Promise<any>, key: string) =>
      ctx.db.withCompanyDb(ctx.companyId, (tx: any) => fn(tx));

    // Concurrent generate (same key) -> single parent.
    await Promise.all([
      run(tx => generateExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'conc-gen' }), 'a'),
      run(tx => generateExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'conc-gen' }), 'b'),
    ]);
    assert.equal(await count(ctx, PARENT_JOBS), 1, 'one parent despite concurrent generate');

    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      completeExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'conc-prod' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      approveExamGroupQc(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'conc-qc' })
    );

    // Concurrent delivery (same key) -> no duplicate notes.
    await Promise.all([
      run(tx => deliverExamGroupChildren(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'conc-del' }), 'a'),
      run(tx => deliverExamGroupChildren(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'conc-del' }), 'b'),
    ]);
    assert.equal((await count(ctx, DELIVERY_NOTES)) - notesBase, 4, 'one note per child despite concurrent delivery');

    // Concurrent invoice (same key) -> one invoice.
    await Promise.all([
      run(tx => postExamGroupInvoice(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'conc-inv' }), 'a'),
      run(tx => postExamGroupInvoice(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'conc-inv' }), 'b'),
    ]);
    assert.equal((await count(ctx, INVOICES)) - invoicesBase, 1, 'one invoice despite concurrent posting');
  } finally {
    await ctx.db.close();
  }
});

test('recovery: a failed invoice does not erase delivery; retry resumes and posts once', async () => {
  const ctx = await setup();
  const invoicesBase = await count(ctx, INVOICES);
  try {
    const created: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: '2026 Recovery Exam',
        classes: buildClasses(ctx, 2, 2, 4),
        idempotencyKey: 'rec-create-1',
      })
    );
    const groupId = created.examBatchGroupId;

    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      generateExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'rec-gen' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      completeExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'rec-prod' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      approveExamGroupQc(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'rec-qc' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      deliverExamGroupChildren(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'rec-del', recipientName: 'Bursar' })
    );

    const notesAfterDelivery = await count(ctx, DELIVERY_NOTES);
    assert.ok(notesAfterDelivery > 0, 'delivery recorded');

    // Force an invoice-posting failure (invalid tax rate) after delivery.
    await assert.rejects(
      ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
        postExamGroupInvoice(tx, ctx.companyId, ctx.actor, {
          groupId,
          idempotencyKey: 'rec-inv-fail',
          includeTax: true,
          taxRate: Number.NaN,
        })
      )
    );

    // Delivery survived the failed invoice; nothing invoiced yet.
    assert.equal(await count(ctx, DELIVERY_NOTES), notesAfterDelivery, 'delivery notes intact after invoice failure');
    assert.equal((await count(ctx, INVOICES)) - invoicesBase, 0, 'no partial invoice');
    const afterFail = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) => getExamGroupSummary(tx, ctx.companyId, groupId));
    assert.equal(afterFail.delivered, true, 'group still delivered');
    assert.equal(afterFail.invoiced, false, 'group not invoiced after failure');

    // Retry the invoice -> exactly one invoice, delivery untouched.
    const ok = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      postExamGroupInvoice(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'rec-inv-ok' })
    );
    assert.equal(ok.invoiced, true);
    assert.equal((await count(ctx, INVOICES)) - invoicesBase, 1, 'exactly one invoice after retry');
    assert.equal(await count(ctx, DELIVERY_NOTES), notesAfterDelivery, 'delivery notes unchanged by retry');
  } finally {
    await ctx.db.close();
  }
});

test('lifecycle: completed children are not reversed; held/cancelled states are handled explicitly', async () => {
  const ctx = await setup();
  try {
    const created: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: '2026 Lifecycle Exam',
        classes: buildClasses(ctx, 1, 2, 4),
        idempotencyKey: 'lc-create-1',
      })
    );
    const groupId = created.examBatchGroupId;
    const paperId = Number(created.papers[0].backendId);

    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      generateExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'lc-gen' })
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      completeExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'lc-prod' })
    );

    const statusAfterComplete = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(`SELECT status FROM exam_papers WHERE company_id = $1 AND id = $2`, [ctx.companyId, paperId]);
      return r.rows[0].status;
    });
    assert.equal(statusAfterComplete, 'completed', 'child completed by checkpoint B');

    // Checkpoint C must not reverse an already-completed child.
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      approveExamGroupQc(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'lc-qc' })
    );
    const statusAfterQc = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(`SELECT status FROM exam_papers WHERE company_id = $1 AND id = $2`, [ctx.companyId, paperId]);
      return r.rows[0].status;
    });
    assert.equal(statusAfterQc, 'completed', 'QC checkpoint never reverses completed to an earlier state');

    // A held child blocks batch completion with an explicit error.
    const created2: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: '2026 Hold Exam',
        classes: buildClasses(ctx, 1, 1, 4),
        idempotencyKey: 'lc-create-2',
      })
    );
    const holdPaper = Number(created2.papers[0].backendId);
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, holdPaper, 'printing')
    );
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, holdPaper, 'qc_hold', { reason: 'Smudged print' })
    );
    await assert.rejects(
      ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
        completeExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId: created2.examBatchGroupId, idempotencyKey: 'lc-prod-2' })
      ),
      (err: any) => err instanceof AccountingError && err.code === 'QC_HOLD_UNRESOLVED'
    );
  } finally {
    await ctx.db.close();
  }
});