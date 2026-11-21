import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import {
  approveExamBatchSpecification,
  cancelExamPaper,
  createExamBatch,
  createExamReprint,
  deliverExamPaper,
  getExaminationReconciliation,
  listExamBatches,
  listExamPaperEvents,
  updateExamPaperDetails,
  updateExamPaperStatus,
} from '../../src/server/services/printingRecordsService.ts';
import { hasPermission } from '../../src/server/permissions.ts';

const cfg = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseServiceRoleKey: '',
  jwtSecret: 'test-secret',
  isProduction: false,
  nodeEnv: 'test',
};

async function setup() {
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
  const actor: ActorContext = {
    userId: Number(admin.id),
    username: String(admin.username),
    role: 'Administrator',
  };
  const ctx = await db.withCompanyDb(companyId, async (tx: any) => {
    const cust = await tx.query(
      `SELECT id FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1`,
      [companyId]
    );
    const paper = await tx.query(
      `SELECT id FROM inventory_items WHERE company_id = $1 AND item_type = 'raw_material'
        ORDER BY id ASC LIMIT 1`,
      [companyId]
    );
    const toner = await tx.query(
      `SELECT id FROM inventory_items WHERE company_id = $1 AND item_type = 'raw_material'
        ORDER BY id DESC LIMIT 1`,
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

async function expectCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (err: any) => {
    assert.ok(err instanceof AccountingError, `expected AccountingError, got ${err?.message}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    return true;
  });
}

test('examination lifecycle: spec freeze, QC, packing, dispatch, cancellation, reprint, timeline and reconciliation', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: '2026 Lifecycle Examination',
        classes: [
          {
            className: 'Form 3',
            learnersCount: 40,
            pricePerLearner: '18.0000',
            papers: [
              {
                subjectName: 'History',
                pages: 6,
                copies: 40,
                rawPaperItemId: ctx.paperItemId,
                rawTonerItemId: ctx.tonerItemId,
                printSide: 'Duplex',
                bindingType: 'Stapled',
                paperSize: 'A4',
                productionDate: '2026-11-26',
              },
              {
                subjectName: 'Geography',
                pages: 4,
                copies: 40,
                rawPaperItemId: ctx.paperItemId,
                rawTonerItemId: ctx.tonerItemId,
                printSide: 'Duplex',
                bindingType: 'Stapled',
                paperSize: 'A4',
                productionDate: '2026-11-26',
              },
            ],
          },
        ],
        dueDate: '2026-12-05',
        priority: 'high',
        idempotencyKey: 'exam-lifecycle-create-1',
      })
    );
    assert.equal(created.papers.length, 2);
    const batchId = Number(created.batches[0].batchId);
    const paperA = Number(created.papers[0].backendId);
    const paperB = Number(created.papers[1].backendId);

    // D3: every paper gets exactly 2 free teacher copies; planned production is
    // learner quantity + 2 (40 learners -> 42 planned), billable stays at 40.
    const d3Row = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT teacher_copies, planned_production_quantity, billable_quantity, copies
           FROM exam_papers WHERE company_id = $1 AND id = $2`,
        [ctx.companyId, paperA]
      );
      return r.rows[0];
    });
    assert.equal(Number(d3Row.teacher_copies), 2, 'D3: exactly two free teacher copies');
    assert.equal(Number(d3Row.planned_production_quantity), Number(d3Row.copies) + 2);
    assert.equal(Number(d3Row.billable_quantity), Number(d3Row.copies), 'billable starts at learner quantity');

    // Frozen production specification is hash-addressed and idempotent.
    const spec = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      approveExamBatchSpecification(tx, ctx.companyId, ctx.actor, batchId, { notes: 'Exam office approved' })
    );
    assert.equal(spec.specFrozen, true);
    assert.equal(spec.idempotentReplay, false);
    assert.equal(String(spec.specHash).length, 64);
    const specReplay = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      approveExamBatchSpecification(tx, ctx.companyId, ctx.actor, batchId)
    );
    assert.equal(specReplay.idempotentReplay, true);
    assert.equal(specReplay.specHash, spec.specHash);

    // Multi-class/spec integrity: batch register reflects both papers.
    const register = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      listExamBatches(tx, ctx.companyId, { schoolCustomerId: ctx.customerId })
    );
    const registered = register.find((b: any) => b.backendId === batchId);
    assert.ok(registered, 'batch register must include the created batch');
    assert.equal(registered.paperCount, 2);
    assert.equal(registered.specFrozen, true);
    assert.equal(registered.specVersion, 2);
    assert.equal(registered.priority, 'high');

    // QC hold requires a reason and is rejected while queued.
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          updateExamPaperStatus(tx, ctx.companyId, ctx.actor, paperA, 'qc_hold')
        ),
      'INVALID_EXAM_STATUS_TRANSITION'
    );

    const printing = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, paperA, 'printing')
    );
    assert.equal(printing.status, 'printing');
    assert.ok(printing.journalTxnId, 'material issuance journal must be posted once');

    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          updateExamPaperStatus(tx, ctx.companyId, ctx.actor, paperA, 'qc_hold')
        ),
      'REASON_REQUIRED'
    );

    const hold = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, paperA, 'qc_hold', {
        reason: 'Registration drift on first article',
        spoiledCopies: 3,
      })
    );
    assert.equal(hold.status, 'qc_hold');

    const rework = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, paperA, 'printing', {
        reason: 'Press recalibrated and re-ran',
      })
    );
    assert.equal(rework.status, 'printing');

    const qcPass = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, paperA, 'qc_passed', {
        goodCopies: 38,
        spoiledCopies: 2,
        qcNotes: 'Two spoiled copies rejected',
      })
    );
    assert.equal(qcPass.status, 'qc_passed');

    const qcRow = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT status, qc_status, good_copies, spoiled_copies,
                accepted_learner_quantity, billable_quantity
           FROM exam_papers
          WHERE company_id = $1 AND id = $2`,
        [ctx.companyId, paperA]
      );
      return r.rows[0];
    });
    assert.equal(qcRow.status, 'qc_passed');
    assert.equal(qcRow.qc_status, 'passed');
    assert.equal(Number(qcRow.good_copies), 38);
    assert.equal(Number(qcRow.spoiled_copies), 2);
    // D3: after QC, billable learner quantity = good output minus the 2 teacher
    // copies (38 - 2 = 36); teacher copies are never invoiced.
    assert.equal(Number(qcRow.accepted_learner_quantity), 36);
    assert.equal(Number(qcRow.billable_quantity), 36);

    const packed = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, paperA, 'packed', {
        packageCount: 4,
        sealReference: 'SEAL-7781',
      })
    );
    assert.equal(packed.status, 'packed');
    const dispatched = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, paperA, 'dispatched')
    );
    assert.equal(dispatched.status, 'dispatched');

    // Dispatched papers cannot be cancelled; they must be delivered or reversed.
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          cancelExamPaper(tx, ctx.companyId, ctx.actor, paperA, { reason: 'School changed its mind' })
        ),
      'EXAM_PAPER_NOT_CANCELLABLE'
    );

    const delivered = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      deliverExamPaper(tx, ctx.companyId, ctx.actor, paperA, {
        recipientName: 'Exam Office',
        notes: 'Sealed carton 4 of 4',
      })
    );
    assert.equal(delivered.status, 'delivered');
    assert.ok(delivered.deliveryNote?.id);

    // A delivered paper cannot be cancelled either.
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          cancelExamPaper(tx, ctx.companyId, ctx.actor, paperA, { reason: 'Late cancellation attempt' })
        ),
      'EXAM_PAPER_NOT_CANCELLABLE'
    );

    // Controlled reprint: new linked record, original preserved.
    const reprint = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamReprint(tx, ctx.companyId, ctx.actor, paperA, {
        reason: 'Exam office received damaged copies',
        copies: 5,
        productionDate: '2026-11-27',
        idempotencyKey: 'exam-lifecycle-reprint-1',
      })
    );
    assert.equal(reprint.reprintOfPaperId, paperA);
    assert.equal(reprint.productionVersion, 2);
    assert.equal(reprint.status, 'queued');
    assert.notEqual(reprint.paperId, paperA);

    const reprintReplay = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamReprint(tx, ctx.companyId, ctx.actor, paperA, {
        reason: 'Exam office received damaged copies',
        copies: 5,
        productionDate: '2026-11-27',
        idempotencyKey: 'exam-lifecycle-reprint-1',
      })
    );
    assert.equal(reprintReplay.paperId, reprint.paperId, 'idempotent reprint retry must not duplicate');

    // D3: a reprint is a replacement/additional run and must NOT grant another
    // teacher-copy allowance. teacher_copies=0, planned=billable=reprint copies.
    const reprintRow = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT teacher_copies, planned_production_quantity, billable_quantity, copies
           FROM exam_papers WHERE company_id = $1 AND id = $2`,
        [ctx.companyId, reprint.paperId]
      );
      return r.rows[0];
    });
    assert.equal(Number(reprintRow.teacher_copies), 0, 'reprint must not grant a new teacher-copy allowance');
    assert.equal(Number(reprintRow.planned_production_quantity), 5);
    assert.equal(Number(reprintRow.billable_quantity), 5);
    assert.equal(Number(reprintRow.copies), 5);

    const original = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT status, invoice_id, reprint_of_paper_id FROM exam_papers
          WHERE company_id = $1 AND id = $2`,
        [ctx.companyId, paperA]
      );
      return r.rows[0];
    });
    assert.equal(original.status, 'delivered');
    assert.equal(original.reprint_of_paper_id, null);
    assert.equal(original.invoice_id, null);

    // Cancellation of a queued paper releases its material reservations.
    const cancelled = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      cancelExamPaper(tx, ctx.companyId, ctx.actor, paperB, {
        reason: 'Geography paper replaced by school circular',
      })
    );
    assert.equal(cancelled.status, 'cancelled');
    const cancelledRow = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT status, cancelled_at, cancellation_reason FROM exam_papers
          WHERE company_id = $1 AND id = $2`,
        [ctx.companyId, paperB]
      );
      return r.rows[0];
    });
    assert.equal(cancelledRow.status, 'cancelled');
    assert.ok(cancelledRow.cancelled_at);
    assert.match(String(cancelledRow.cancellation_reason), /Geography paper replaced/);

    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          cancelExamPaper(tx, ctx.companyId, ctx.actor, paperB, { reason: 'Second attempt' })
        ),
      'EXAM_PAPER_ALREADY_CANCELLED'
    );

    // Append-only timeline covers creation, approval, production and delivery.
    const events = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      listExamPaperEvents(tx, ctx.companyId, paperA)
    );
    const types = events.map((e: any) => e.eventType);
    assert.ok(types.includes('created'));
    assert.ok(types.includes('spec_approved'));
    assert.ok(types.filter((t: string) => t === 'status_changed').length >= 6);
    assert.ok(events.every((e: any) => e.createdAt));

    // The append-only trigger blocks any attempt to rewrite history.
    await assert.rejects(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
          await tx.query(
            `UPDATE exam_paper_events SET reason = 'tampered'
              WHERE company_id = $1 AND paper_id = $2`,
            [ctx.companyId, paperA]
          );
        }),
      /append-only/
    );

    const report = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      getExaminationReconciliation(tx, ctx.companyId)
    );
    assert.equal(report.criticalCount, 0, JSON.stringify(report.checks));
    const keys = report.checks.map((c: any) => c.key);
    assert.ok(keys.includes('duplicate_invoice_links'));
    assert.ok(keys.includes('over_consumed_materials'));
    assert.ok(keys.includes('negative_raw_material_stock'));
    assert.ok(keys.includes('negative_exam_wip'));
  } finally {
    await ctx.db.close();
  }
});

test('examination permissions separate content, production, QC, delivery and billing duties', () => {
  assert.equal(hasPermission('Administrator', 'exams:manage_permissions'), true);
  assert.equal(hasPermission('Administrator', 'exams:view_confidential'), true);
  assert.equal(hasPermission('Administrator', 'exams:edit'), true);

  assert.equal(hasPermission('ProductionManager', 'exams:produce'), true);
  assert.equal(hasPermission('ProductionManager', 'exams:qc'), true);
  assert.equal(hasPermission('ProductionManager', 'exams:dispatch'), true);
  assert.equal(hasPermission('ProductionManager', 'exams:deliver'), true);
  assert.equal(hasPermission('ProductionManager', 'exams:invoice'), false);
  assert.equal(hasPermission('ProductionManager', 'exams:cancel'), false);
  assert.equal(hasPermission('ProductionManager', 'exams:edit'), true);

  assert.equal(hasPermission('Bookkeeper', 'exams:create'), true);
  assert.equal(hasPermission('Bookkeeper', 'exams:invoice'), true);
  assert.equal(hasPermission('Bookkeeper', 'exams:edit'), true);
  assert.equal(hasPermission('Bookkeeper', 'exams:view_confidential'), false);
  assert.equal(hasPermission('Bookkeeper', 'exams:qc'), false);
  assert.equal(hasPermission('Bookkeeper', 'exams:cancel'), false);

  assert.equal(hasPermission('Accountant', 'exams:invoice'), true);
  assert.equal(hasPermission('Accountant', 'exams:cancel'), true);
  assert.equal(hasPermission('Accountant', 'exams:produce'), false);

  assert.equal(hasPermission('Read-Only', 'exams:view'), true);
  assert.equal(hasPermission('Read-Only', 'exams:view_confidential'), false);
  assert.equal(hasPermission('Read-Only', 'exams:create'), false);
});

test('examination paper editing: allowed before spec freeze, blocked afterwards', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: 'Edit Guard Examination',
        classes: [
          {
            className: 'Form 2',
            learnersCount: 20,
            pricePerLearner: '10.0000',
            papers: [
              {
                subjectName: 'English',
                pages: 4,
                copies: 20,
                rawPaperItemId: ctx.paperItemId,
                rawTonerItemId: ctx.tonerItemId,
                productionDate: '2026-11-26',
              },
            ],
          },
        ],
        idempotencyKey: 'exam-edit-batch-1',
      })
    );
    const paperId = Number(created.papers[0].backendId);
    const batchId = Number(created.batches[0].batchId);

    // Edit while queued and not frozen -> succeeds; D3 planned/billable updated.
    const edited = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperDetails(tx, ctx.companyId, ctx.actor, paperId, {
        subjectName: 'English (Revised)',
        copies: 30,
        pages: 8,
        reason: 'Corrected class list',
        idempotencyKey: 'exam-edit-1',
      })
    );
    assert.equal(edited.copies, 30);
    assert.equal(edited.plannedProductionQuantity, 32, 'planned = learner copies + 2 teacher');
    assert.equal(edited.billableQuantity, 30, 'billable = learner copies');
    assert.equal(edited.pages, 8);
    assert.equal(edited.subjectName, 'English (Revised)');

    // The linked production job's ordered quantity is synced to planned production.
    const job = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT ordered_qty FROM printing_jobs WHERE company_id = $1 AND id = $2`,
        [ctx.companyId, edited.productionJobId]
      );
      return r.rows[0];
    });
    assert.equal(Number(job.ordered_qty), 32, 'production job ordered_qty must match planned production');

    // Idempotent replay of the same edit returns the same result.
    const replay = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperDetails(tx, ctx.companyId, ctx.actor, paperId, {
        subjectName: 'English (Revised)',
        copies: 30,
        pages: 8,
        reason: 'Corrected class list',
        idempotencyKey: 'exam-edit-1',
      })
    );
    assert.equal(replay.copies, 30, 'idempotent edit replay must not re-apply');

    // Freeze the specification; editing is now rejected.
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      approveExamBatchSpecification(tx, ctx.companyId, ctx.actor, batchId, { notes: 'frozen' })
    );
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          updateExamPaperDetails(tx, ctx.companyId, ctx.actor, paperId, { copies: 40 })
        ),
      'EXAM_SPEC_FROZEN'
    );

    // Move to production; editing is now rejected because the paper left 'queued'.
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, paperId, 'printing')
    );
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          updateExamPaperDetails(tx, ctx.companyId, ctx.actor, paperId, { copies: 40 })
        ),
      'EXAM_PAPER_NOT_EDITABLE'
    );
  } finally {
    await ctx.db.close();
  }
});
