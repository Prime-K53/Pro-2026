import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import {
  createExamBatch,
  deliverExamPaper,
  listExamPapers,
  updateExamPaperStatus,
} from '../../src/server/services/printingRecordsService.ts';
import { generateInvoiceFromWorkflow } from '../../src/server/services/documentsService.ts';
import { parseDecimal4 } from '../../src/server/lib/decimal.ts';

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
  customerName: string;
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
  const actor: ActorContext = {
    userId: Number(admin.id),
    username: String(admin.username),
    role: 'Administrator',
  };

  const ctx = await db.withCompanyDb(companyId, async (tx: any) => {
    const cust = await tx.query(
      `SELECT id, company_name FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1`,
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
      customerName: String(cust.rows[0].company_name),
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

async function journalTotals(ctx: Ctx, journalId: number) {
  return ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
    const res = await tx.query(
      `SELECT COALESCE(SUM(debit), 0)::text AS debit,
              COALESCE(SUM(credit), 0)::text AS credit
         FROM journal_lines
        WHERE company_id = $1 AND transaction_id = $2`,
      [ctx.companyId, journalId]
    );
    return {
      debit: parseDecimal4(res.rows[0].debit),
      credit: parseDecimal4(res.rows[0].credit),
    };
  });
}

test('exam production: multi-class, server costing, stock/WIP, QC, delivery and invoice linkage', async () => {
  const ctx = await setup();
  try {
    const created = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: '2026 End of Term Integrity Exam',
        classes: [
          {
            className: 'Form 1',
            learnersCount: 20,
            pricePerLearner: '25.0000',
            papers: [
              {
                subjectName: 'Mathematics',
                pages: 8,
                copies: 20,
                rawPaperItemId: ctx.paperItemId,
                rawTonerItemId: ctx.tonerItemId,
                printSide: 'Duplex',
                bindingType: 'Stapled',
                paperSize: 'A3',
                productionDate: '2026-11-24',
              },
            ],
          },
          {
            className: 'Form 2',
            learnersCount: 30,
            pricePerLearner: '30.0000',
            papers: [
              {
                subjectName: 'Mathematics',
                pages: 6,
                copies: 30,
                rawPaperItemId: ctx.paperItemId,
                rawTonerItemId: ctx.tonerItemId,
                printSide: 'Duplex',
                bindingType: 'Booklet',
                paperSize: 'A4',
                productionDate: '2026-11-24',
              },
            ],
          },
        ],
        idempotencyKey: 'exam-integrity-create-1',
      })
    );

    assert.equal(created.batches.length, 2, 'each class must retain its own batch header');
    assert.equal(created.papers.length, 2, 'both subject papers must be created');
    assert.deepEqual(
      created.batches.map((b: any) => [b.className, b.learnersCount, b.pricePerLearner]),
      [
        ['Form 1', 20, 25],
        ['Form 2', 30, 30],
      ]
    );

    const form1 = created.papers.find((p: any) => p.className === 'Form 1');
    const form2 = created.papers.find((p: any) => p.className === 'Form 2');
    assert.ok(form1?.productionJobId, 'Form 1 paper must have a linked production job');
    assert.ok(form2?.productionJobId, 'Form 2 paper must have a linked production job');
    assert.equal(form1.paperSize, 'A3', 'A3 specification must not be collapsed to A4');
    assert.equal(form2.paperSize, 'A4');
    assert.ok(form1.materialCost > 0, 'server must compute a non-zero material cost');
    assert.ok(form2.materialCost > 0, 'server must compute a non-zero material cost');

    const replay = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: '2026 End of Term Integrity Exam',
        classes: [
          {
            className: 'Form 1',
            learnersCount: 20,
            pricePerLearner: '25.0000',
            papers: [
              {
                subjectName: 'Mathematics',
                pages: 8,
                copies: 20,
                rawPaperItemId: ctx.paperItemId,
                rawTonerItemId: ctx.tonerItemId,
                printSide: 'Duplex',
                bindingType: 'Stapled',
                paperSize: 'A3',
                productionDate: '2026-11-24',
              },
            ],
          },
          {
            className: 'Form 2',
            learnersCount: 30,
            pricePerLearner: '30.0000',
            papers: [
              {
                subjectName: 'Mathematics',
                pages: 6,
                copies: 30,
                rawPaperItemId: ctx.paperItemId,
                rawTonerItemId: ctx.tonerItemId,
                printSide: 'Duplex',
                bindingType: 'Booklet',
                paperSize: 'A4',
                productionDate: '2026-11-24',
              },
            ],
          },
        ],
        idempotencyKey: 'exam-integrity-create-1',
      })
    );
    assert.equal(replay.batchId, created.batchId, 'idempotent retry must replay the original batch');

    const stockBefore = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT id, on_hand::text FROM inventory_items
          WHERE company_id = $1 AND id = ANY($2::BIGINT[])`,
        [ctx.companyId, [ctx.paperItemId, ctx.tonerItemId]]
      );
      return new Map(r.rows.map((row: any) => [Number(row.id), parseDecimal4(row.on_hand)]));
    });

    const started = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, Number(form1.backendId), 'printing')
    );
    assert.equal(started.status, 'printing');
    assert.ok(started.journalTxnId, 'material issue must post a WIP journal');
    const wip = await journalTotals(ctx, Number(started.journalTxnId));
    assert.equal(wip.debit, wip.credit, 'material issue journal must balance');
    assert.ok(wip.debit > 0n);

    const stockAfter = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT id, on_hand::text FROM inventory_items
          WHERE company_id = $1 AND id = ANY($2::BIGINT[])`,
        [ctx.companyId, [ctx.paperItemId, ctx.tonerItemId]]
      );
      return new Map(r.rows.map((row: any) => [Number(row.id), parseDecimal4(row.on_hand)]));
    });
    assert.ok(
      stockAfter.get(ctx.paperItemId)! < stockBefore.get(ctx.paperItemId)!,
      'paper stock must decrease on production start'
    );
    assert.ok(
      stockAfter.get(ctx.tonerItemId)! < stockBefore.get(ctx.tonerItemId)!,
      'toner stock must decrease on production start'
    );

    const completed = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      updateExamPaperStatus(tx, ctx.companyId, ctx.actor, Number(form1.backendId), 'completed')
    );
    assert.equal(completed.status, 'completed');
    const paperAfterQc = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT status, qc_status, qc_approved_copies, good_copies
           FROM exam_papers WHERE company_id = $1 AND id = $2`,
        [ctx.companyId, Number(form1.backendId)]
      );
      return r.rows[0];
    });
    assert.equal(paperAfterQc.qc_status, 'passed');
    assert.equal(Number(paperAfterQc.qc_approved_copies), 20);
    assert.equal(Number(paperAfterQc.good_copies), 20);

    // Invoicing before delivery must fail and leave no invoice behind.
    const invoiceCountBefore = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(`SELECT COUNT(*)::int AS c FROM invoices WHERE company_id = $1`, [ctx.companyId]);
      return Number(r.rows[0].c);
    });
    await expectCode(
      () =>
        ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
          generateInvoiceFromWorkflow(tx, ctx.companyId, ctx.actor, {
            sourceKind: 'exam_batch',
            customerId: ctx.customerId,
            invoiceDate: '2026-11-25',
            dueDate: '2026-12-25',
            postgresExamPaperIds: [Number(form1.backendId)],
            idempotencyKey: 'exam-integrity-invoice-too-early',
            lines: [{ description: 'Form 1 Mathematics', quantity: 20, rate: 25, unitCost: 0 }],
          })
        ),
      'EXAM_PAPER_NOT_DELIVERED'
    );
    const invoiceCountAfterFail = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(`SELECT COUNT(*)::int AS c FROM invoices WHERE company_id = $1`, [ctx.companyId]);
      return Number(r.rows[0].c);
    });
    assert.equal(invoiceCountAfterFail, invoiceCountBefore, 'failed eligibility must roll back the invoice');

    const delivered = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      deliverExamPaper(tx, ctx.companyId, ctx.actor, Number(form1.backendId), {
        recipientName: 'Exam Office Receiver',
        notes: 'Delivered in sealed carton',
      })
    );
    assert.equal(delivered.status, 'delivered');
    assert.ok(delivered.deliveryNote?.id, 'delivery must create a delivery note');

    const invoiceResult = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      generateInvoiceFromWorkflow(tx, ctx.companyId, ctx.actor, {
        sourceKind: 'exam_batch',
        customerId: ctx.customerId,
        invoiceDate: '2026-11-25',
        dueDate: '2026-12-25',
        postgresExamPaperIds: [Number(form1.backendId)],
        idempotencyKey: 'exam-integrity-invoice-1',
        lines: [{ description: 'Form 1 Mathematics', quantity: 20, rate: 25, unitCost: 0 }],
      })
    );
    assert.ok(invoiceResult.invoice.id > 0);
    assert.equal(invoiceResult.examLink?.linkedPaperIds.length, 1);
    assert.ok(Number(invoiceResult.examLink?.wipRelieved) > 0);
    const cogsJournalId = Number(invoiceResult.examLink?.cogsJournalId);
    assert.ok(cogsJournalId > 0, 'invoice must relieve WIP to COGS');
    const cogs = await journalTotals(ctx, cogsJournalId);
    assert.equal(cogs.debit, cogs.credit, 'COGS journal must balance');
    assert.ok(cogs.debit > 0n);

    const invoiceDb = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const inv = await tx.query(
        `SELECT total_cost::text FROM invoices WHERE company_id = $1 AND id = $2`,
        [ctx.companyId, Number(invoiceResult.invoice.id)]
      );
      const link = await tx.query(
        `SELECT paper_id, invoice_id, linked_quantity::text, linked_amount::text
           FROM exam_paper_invoice_links
          WHERE company_id = $1 AND paper_id = $2`,
        [ctx.companyId, Number(form1.backendId)]
      );
      const paper = await tx.query(
        `SELECT status, invoice_id FROM exam_papers WHERE company_id = $1 AND id = $2`,
        [ctx.companyId, Number(form1.backendId)]
      );
      return { inv: inv.rows[0], link: link.rows[0], paper: paper.rows[0] };
    });
    assert.equal(invoiceDb.paper.status, 'invoiced');
    assert.equal(Number(invoiceDb.paper.invoice_id), Number(invoiceResult.invoice.id));
    assert.equal(Number(invoiceDb.link.invoice_id), Number(invoiceResult.invoice.id));
    assert.equal(Number(invoiceDb.link.linked_quantity), 20);
    assert.equal(
      parseDecimal4(invoiceDb.inv.total_cost),
      parseDecimal4(invoiceResult.examLink!.wipRelieved),
      'invoice total_cost must equal the exact WIP relief, not a duplicated material cost'
    );

    // Same idempotency key replays; it must not create a second invoice or link.
    const replayInvoice = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      generateInvoiceFromWorkflow(tx, ctx.companyId, ctx.actor, {
        sourceKind: 'exam_batch',
        customerId: ctx.customerId,
        invoiceDate: '2026-11-25',
        dueDate: '2026-12-25',
        postgresExamPaperIds: [Number(form1.backendId)],
        idempotencyKey: 'exam-integrity-invoice-1',
        lines: [{ description: 'Form 1 Mathematics', quantity: 20, rate: 25, unitCost: 0 }],
      })
    );
    assert.equal(replayInvoice.idempotentReplay, true);
    assert.equal(Number(replayInvoice.invoice.id), Number(invoiceResult.invoice.id));
    const linkCount = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT COUNT(*)::int AS c FROM exam_paper_invoice_links
          WHERE company_id = $1 AND paper_id = $2`,
        [ctx.companyId, Number(form1.backendId)]
      );
      return Number(r.rows[0].c);
    });
    assert.equal(linkCount, 1, 'idempotent replay must not duplicate invoice links');

    const papers = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      listExamPapers(tx, ctx.companyId)
    );
    const serialized = papers.find((p: any) => Number(p.backendId) === Number(form1.backendId));
    assert.equal(serialized?.paperSize, 'A3');
    assert.equal(serialized?.status, 'invoiced');
  } finally {
    await ctx.db.close();
  }
});
