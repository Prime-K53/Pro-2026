import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import {
  createExamBatch,
  generateExamGroupProduction,
  completeExamGroupProduction,
  deliverExamGroupChildren,
  postExamGroupInvoice,
  listExamGroups,
} from '../../src/server/services/printingRecordsService.ts';
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

  // A second, isolated company owned by the same admin user.
  const created = await db.createCompanyWithDefaults({
    name: 'Second Printing Co',
    ownerUserId: Number(admin.id),
    ownerUsername: String(admin.username),
    makeDefault: false,
  });
  const companyB = Number(created.companyId);
  const actorB: ActorContext = { userId: Number(admin.id), username: String(admin.username), role: 'Administrator' };

  return { db, companyId, actor, ...ctx, companyB, actorB };
}

function buildClasses(ctx: Ctx, classCount: number, subjectsPerClass: number, learners: number) {
  const subjects = ['Mathematics', 'English', 'Physics', 'Chemistry'];
  return Array.from({ length: classCount }, (_, ci) => ({
    className: `Form ${ci + 1}`,
    learnersCount: learners,
    pricePerLearner: '10.0000',
    papers: Array.from({ length: subjectsPerClass }, (_, si) => ({
      subjectName: subjects[si % subjects.length],
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

async function expectCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (err: any) => {
    assert.ok(err instanceof AccountingError, `expected AccountingError, got ${err?.message}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    return true;
  });
}

async function onHand(ctx: Ctx, companyId: number, ids: number[]): Promise<Map<number, bigint>> {
  return ctx.db.withCompanyDb(companyId, async (tx: any) => {
    const r = await tx.query(
      `SELECT id, on_hand::text AS on_hand FROM inventory_items WHERE company_id = $1 AND id = ANY($2::BIGINT[])`,
      [companyId, ids]
    );
    return new Map(r.rows.map((row: any) => [Number(row.id), parseDecimal4(row.on_hand)]));
  });
}

test('tenant isolation: a second company cannot read or mutate another company\'s group', async () => {
  const ctx = await setup();
  try {
    const created: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: 'Tenant Exam',
        classes: buildClasses(ctx, 1, 2, 4),
        idempotencyKey: 'tenant-create',
      })
    );
    const groupId = created.examBatchGroupId;

    // B cannot see A's group in the list.
    const bGroups = await ctx.db.withCompanyDb(ctx.companyB, (tx: any) => listExamGroups(tx, ctx.companyB));
    assert.ok(!bGroups.some((g: any) => g.examBatchGroupId === groupId), 'B must not list A\'s group');

    // B cannot generate / deliver / invoice A's group.
    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyB, (tx: any) =>
        generateExamGroupProduction(tx, ctx.companyB, ctx.actorB, { groupId, idempotencyKey: 'tenant-gen' })),
      'EXAM_GROUP_NOT_FOUND'
    );
    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyB, (tx: any) =>
        deliverExamGroupChildren(tx, ctx.companyB, ctx.actorB, { groupId, idempotencyKey: 'tenant-del' })),
      'EXAM_GROUP_NOT_FOUND'
    );
    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyB, (tx: any) =>
        postExamGroupInvoice(tx, ctx.companyB, ctx.actorB, { groupId, idempotencyKey: 'tenant-inv' })),
      'EXAM_GROUP_NOT_FOUND'
    );

    // A's group is still intact and usable by A.
    const aSummary = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      generateExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'tenant-gen-a' }));
    assert.equal(aSummary.examBatchGroupId, groupId);
  } finally {
    await ctx.db.close();
  }
});

test('permission: a role without exams:produce cannot generate group production', async () => {
  const ctx = await setup();
  try {
    const created: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: 'Permission Exam',
        classes: buildClasses(ctx, 1, 1, 4),
        idempotencyKey: 'perm-create',
      })
    );
    const noAccess: ActorContext = { userId: ctx.actor.userId, username: ctx.actor.username, role: 'NoAccess' as any };
    await expectCode(
      () => ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
        generateExamGroupProduction(tx, ctx.companyId, noAccess, { groupId: created.examBatchGroupId, idempotencyKey: 'perm-gen' })),
      'EXAMS_PRODUCE_PERMISSION_REQUIRED'
    );
  } finally {
    await ctx.db.close();
  }
});

test('inventory integrity: parent consumes nothing; children retain material + WIP; retries do not duplicate', async () => {
  const ctx = await setup();
  try {
    const created: any = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      createExamBatch(tx, ctx.companyId, ctx.actor, {
        schoolCustomerId: ctx.customerId,
        assessmentName: 'Inventory Exam',
        classes: buildClasses(ctx, 2, 2, 4),
        idempotencyKey: 'inv-create',
      })
    );
    const groupId = created.examBatchGroupId;
    const ids = [ctx.paperItemId, ctx.tonerItemId];
    const before = await onHand(ctx, ctx.companyId, ids);

    const summary = await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      generateExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'inv-gen' }));

    // Parent job has zero material requirements.
    const parentReq = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT COUNT(*)::int AS count FROM job_material_requirements
          WHERE company_id = $1 AND printing_job_id = $2`,
        [ctx.companyId, summary.parentJobId]
      );
      return Number(r.rows[0].count);
    });
    assert.equal(parentReq, 0, 'parent exam_batch job must have no material requirements');

    // Parent creation must not move inventory.
    const afterGen = await onHand(ctx, ctx.companyId, ids);
    assert.equal(afterGen.get(ctx.paperItemId)!, before.get(ctx.paperItemId)!, 'paper on_hand unchanged by parent creation');
    assert.equal(afterGen.get(ctx.tonerItemId)!, before.get(ctx.tonerItemId)!, 'toner on_hand unchanged by parent creation');

    // Complete production: children issue materials (WIP) and reduce stock.
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      completeExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'inv-prod' }));

    const childReq = await ctx.db.withCompanyDb(ctx.companyId, async (tx: any) => {
      const r = await tx.query(
        `SELECT COUNT(*)::int AS count FROM job_material_requirements jmr
           JOIN printing_jobs j ON j.company_id = jmr.company_id AND j.id = jmr.printing_job_id
          WHERE jmr.company_id = $1 AND j.parent_job_id = $2`,
        [ctx.companyId, summary.parentJobId]
      );
      return Number(r.rows[0].count);
    });
    assert.ok(childReq > 0, 'child jobs must retain material requirements');

    const afterProd = await onHand(ctx, ctx.companyId, ids);
    assert.ok(afterProd.get(ctx.paperItemId)! < afterGen.get(ctx.paperItemId)!, 'paper stock reduced by child production');
    assert.ok(afterProd.get(ctx.tonerItemId)! < afterGen.get(ctx.tonerItemId)!, 'toner stock reduced by child production');

    // Retry completion must not double-consume.
    await ctx.db.withCompanyDb(ctx.companyId, (tx: any) =>
      completeExamGroupProduction(tx, ctx.companyId, ctx.actor, { groupId, idempotencyKey: 'inv-prod' }));
    const afterRetry = await onHand(ctx, ctx.companyId, ids);
    assert.equal(afterRetry.get(ctx.paperItemId)!, afterProd.get(ctx.paperItemId)!, 'no duplicate paper consumption on retry');
    assert.equal(afterRetry.get(ctx.tonerItemId)!, afterProd.get(ctx.tonerItemId)!, 'no duplicate toner consumption on retry');
  } finally {
    await ctx.db.close();
  }
});