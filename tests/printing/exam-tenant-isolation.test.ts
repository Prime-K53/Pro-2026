import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDatabase } from '../../src/server/db.ts';
import { AccountingError, ActorContext } from '../../src/server/services/accountingEngine.ts';
import {
  cancelExamPaper,
  createExamBatch,
  createExamReprint,
  deliverExamPaper,
  listExamPapers,
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

async function setup() {
  const db = await createServerDatabase(cfg as any, { inMemory: true, seedDemo: true });

  const companies = await db.withSystemDb(async (tx: any) => {
    const r = await tx.query(`SELECT id FROM companies ORDER BY id ASC`);
    return r.rows.map((row: any) => Number(row.id));
  });

  const admin = await db.withSystemDb(async (tx: any) => {
    const r = await tx.query(
      `SELECT u.id, u.username
         FROM users u
         JOIN company_memberships m ON m.user_id = u.id
        WHERE u.is_active = TRUE AND LOWER(u.username) = 'admin'
        ORDER BY u.id ASC LIMIT 1`
    );
    return r.rows[0] as { id: number; username: string };
  });

  const companyA = companies[0];
  const companyB = companies[1] ?? companies[0] + 1;

  const ctxA = await db.withCompanyDb(companyA, async (tx: any) => {
    const cust = await tx.query(
      `SELECT id FROM customers WHERE company_id = $1 ORDER BY id LIMIT 1`,
      [companyA]
    );
    const paper = await tx.query(
      `SELECT id FROM inventory_items WHERE company_id = $1 AND item_type = 'raw_material'
        ORDER BY id ASC LIMIT 1`,
      [companyA]
    );
    const toner = await tx.query(
      `SELECT id FROM inventory_items WHERE company_id = $1 AND item_type = 'raw_material'
        ORDER BY id DESC LIMIT 1`,
      [companyA]
    );
    return {
      customerId: Number(cust.rows[0].id),
      paperItemId: Number(paper.rows[0].id),
      tonerItemId: Number(toner.rows[0].id),
    };
  });

  const actorA: ActorContext = {
    userId: Number(admin.id),
    username: String(admin.username),
    role: 'Administrator',
  };

  return { db, companyA, companyB, actorA, ...ctxA };
}

test('examination tenant isolation: a second company cannot read or mutate another company\'s exam papers', async () => {
  const { db, companyA, companyB, actorA, customerId, paperItemId, tonerItemId } = await setup();
  try {
    // Create an examination batch in Company A.
    const created = await db.withCompanyDb(companyA, (tx: any) =>
      createExamBatch(tx, companyA, actorA, {
        schoolCustomerId: customerId,
        assessmentName: 'Tenant Isolation Examination',
        classes: [
          {
            className: 'Form 1',
            learnersCount: 10,
            pricePerLearner: '10.0000',
            papers: [
              {
                subjectName: 'Mathematics',
                pages: 4,
                copies: 10,
                rawPaperItemId: paperItemId,
                rawTonerItemId: tonerItemId,
                productionDate: '2026-11-26',
              },
            ],
          },
        ],
        idempotencyKey: 'exam-tenant-create-1',
      })
    );
    const paperAId = Number(created.papers[0].backendId);
    assert.ok(paperAId > 0, 'exam paper must be created in Company A');

    // Company A can see its own paper.
    const aPapers = await db.withCompanyDb(companyA, (tx: any) => listExamPapers(tx, companyA));
    assert.ok(
      aPapers.some((p: any) => Number(p.backendId) === paperAId),
      'Company A must list its own examination paper'
    );

    // Company B must NOT see Company A's paper (RLS + company_id scoping).
    const bPapers = await db.withCompanyDb(companyB, (tx: any) => listExamPapers(tx, companyB));
    assert.equal(
      bPapers.some((p: any) => Number(p.backendId) === paperAId),
      false,
      'Company B must not list Company A examination papers'
    );

    // Company B must NOT transition Company A's paper.
    await assert.rejects(
      () =>
        db.withCompanyDb(companyB, (tx: any) =>
          updateExamPaperStatus(tx, companyB, actorA, paperAId, 'printing')
        ),
      (err: any) => err instanceof AccountingError && err.code === 'EXAM_PAPER_NOT_FOUND',
      'cross-tenant status change must be rejected as not found'
    );

    // Company B must NOT cancel Company A's paper.
    await assert.rejects(
      () =>
        db.withCompanyDb(companyB, (tx: any) =>
          cancelExamPaper(tx, companyB, actorA, paperAId, { reason: 'cross-tenant cancel' })
        ),
      (err: any) => err instanceof AccountingError && err.code === 'EXAM_PAPER_NOT_FOUND',
      'cross-tenant cancel must be rejected as not found'
    );

    // Company B must NOT deliver Company A's paper.
    await assert.rejects(
      () =>
        db.withCompanyDb(companyB, (tx: any) =>
          deliverExamPaper(tx, companyB, actorA, paperAId, { recipientName: 'Intruder' })
        ),
      (err: any) => err instanceof AccountingError && err.code === 'EXAM_PAPER_NOT_FOUND',
      'cross-tenant delivery must be rejected as not found'
    );

    // Company B must NOT reprint Company A's paper.
    await assert.rejects(
      () =>
        db.withCompanyDb(companyB, (tx: any) =>
          createExamReprint(tx, companyB, actorA, paperAId, {
            reason: 'cross-tenant reprint',
            copies: 1,
          })
        ),
      (err: any) => err instanceof AccountingError && err.code === 'EXAM_PAPER_NOT_FOUND',
      'cross-tenant reprint must be rejected as not found'
    );

    // The paper in Company A is untouched by the cross-tenant attempts.
    const stillQueued = await db.withCompanyDb(companyA, async (tx: any) => {
      const r = await tx.query(
        `SELECT status FROM exam_papers WHERE company_id = $1 AND id = $2`,
        [companyA, paperAId]
      );
      return r.rows[0];
    });
    assert.equal(stillQueued.status, 'queued', 'Company A paper must remain queued after cross-tenant attempts');
  } finally {
    await db.close();
  }
});