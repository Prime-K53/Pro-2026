import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import {
  createExamBatch,
  getExamGroupForBatch,
  listExamBatches,
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
  secondCustomerId: number;
  paperItemId: number;
  tonerItemId: number;
  companyB: number;
  actorB: ActorContext;
};

async function setup(): Promise<Ctx> {
  const db = await createServerDatabase(cfg as any, { inMemory: true, seedDemo: true });
  const users = await db.withSystemDb(async (tx: any) => {
    const r = await tx.query(
      `SELECT u.id, u.username, m.company_id FROM users u
         JOIN company_memberships m ON m.user_id = u.id
        WHERE u.is_active = TRUE ORDER BY u.id ASC`
    );
    return r.rows;
  });
  const admin = users.find((u: any) => String(u.username).toLowerCase() === 'admin') || users[0];
  const companyId = Number(admin.company_id);
  const actor: ActorContext = { userId: Number(admin.id), username: String(admin.username), role: 'Administrator' };

  const ctx = await db.withCompanyDb(companyId, async (tx: any) => {
    const cust = await tx.query(
      `SELECT id FROM customers WHERE company_id = $1 ORDER BY id ASC LIMIT 1`,
      [companyId]
    );
    const second = await tx.query(
      `INSERT INTO customers (company_id, customer_type, name, company_name)
       VALUES ($1, 'school', 'Second School', 'Second School') RETURNING id`,
      [companyId]
    );
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
      secondCustomerId: Number(second.rows[0].id),
      paperItemId: Number(paper.rows[0].id),
      tonerItemId: Number(toner.rows[0].id),
    };
  });

  const created = await db.createCompanyWithDefaults({
    name: 'Second Resolution Co',
    ownerUserId: Number(admin.id),
    ownerUsername: String(admin.username),
    makeDefault: false,
  });
  const companyB = Number(created.companyId);
  const actorB: ActorContext = { userId: Number(admin.id), username: String(admin.username), role: 'Administrator' };

  return { db, companyId, actor, ...ctx, companyB, actorB };
}

function classes(ctx: Ctx, className: string, learners = 4) {
  return [
    {
      className,
      learnersCount: learners,
      pricePerLearner: '10.0000',
      papers: [
        {
          subjectName: 'Mathematics',
          pages: 4,
          copies: learners,
          rawPaperItemId: ctx.paperItemId,
          rawTonerItemId: ctx.tonerItemId,
          printSide: 'Duplex',
          bindingType: 'Stapled',
          paperSize: 'A4',
          productionDate: '2026-11-24',
        },
      ],
    },
  ];
}

async function expectCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (err: any) => {
    assert.ok(err instanceof AccountingError, `expected AccountingError, got ${err?.message}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    return true;
  });
}

test('batch -> group resolution is authoritative, per-batch, and fail-closed', async () => {
  const ctx = await setup();
  try {
    // Two examinations at the SAME school -> two distinct groups.
    const a: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: 'Resolution Exam A',
        classes: classes(ctx, 'Form 1'),
        idempotencyKey: 'res-a',
      })
    );
    const b: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: 'Resolution Exam B',
        classes: classes(ctx, 'Form 2'),
        idempotencyKey: 'res-b',
      })
    );
    const batchA = a.batches[0].batchId;
    const batchB = b.batches[0].batchId;
    assert.notEqual(a.examBatchGroupId, b.examBatchGroupId, 'two examinations -> two groups');

    // Each batch resolves its OWN group.
    const gA = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) => getExamGroupForBatch(tx, ctx.companyId, batchA));
    const gB = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) => getExamGroupForBatch(tx, ctx.companyId, batchB));
    assert.equal(gA.examBatchGroupId, a.examBatchGroupId, 'batch A resolves group A');
    assert.equal(gB.examBatchGroupId, b.examBatchGroupId, 'batch B resolves group B');

    // listExamBatches exposes the persisted relationship.
    const list = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      listExamBatches(tx, ctx.companyId, { schoolCustomerId: ctx.customerId }));
    const listedA = list.find((x: any) => x.backendId === batchA);
    assert.equal(listedA?.examBatchGroupId, a.examBatchGroupId, 'batch list carries examBatchGroupId');

    // A batch without a persisted group relationship cannot start the workflow.
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      tx.query(`UPDATE exam_assessment_batches SET exam_batch_group_id = NULL WHERE company_id = $1 AND id = $2`, [
        ctx.companyId,
        batchB,
      ]));
    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyId, (tx: any) => getExamGroupForBatch(tx, ctx.companyId, batchB)),
      'EXAM_BATCH_GROUP_MISSING'
    );

    // Inconsistent relationship (group belongs to another school) fails closed.
    assert.notEqual(ctx.secondCustomerId, ctx.customerId, 'seed must provide a second customer');
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      tx.query(`UPDATE exam_batch_groups SET school_customer_id = $3 WHERE company_id = $1 AND id = $2`, [
        ctx.companyId,
        a.examBatchGroupId,
        ctx.secondCustomerId,
      ]));
    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyId, (tx: any) => getExamGroupForBatch(tx, ctx.companyId, batchA)),
      'EXAM_GROUP_SCHOOL_MISMATCH'
    );

    // Another company cannot resolve the batch (tenant isolation).
    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyB, (tx: any) => getExamGroupForBatch(tx, ctx.companyB, batchA)),
      'EXAM_BATCH_NOT_FOUND'
    );
  } finally {
    await ctx.db.close();
  }
});