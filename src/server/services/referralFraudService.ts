import { Transaction } from '@electric-sql/pglite';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';

/**
 * Referral fraud & dispute foundation (C3-C, A5-B, U4-D, U5-B).
 *
 * Identity matches are FLAGGED for review, never automatically classified as
 * confirmed fraud. Confirmed fraud decisions are case-by-case by an authorised
 * decision-maker with recorded evidence. Disputed decisions may be reviewed by
 * an independent authorised reviewer who must differ from the original
 * decision-maker.
 */

export type ReferralCaseType =
  | 'fraud'
  | 'dispute'
  | 'exception'
  | 'eligibility_exception'
  | 'attribution_change';

export type ReferralCaseStatus = 'open' | 'under_review' | 'confirmed' | 'dismissed' | 'resolved';

export interface IdentitySignals {
  samePhone: boolean;
  sameEmail: boolean;
  similarName: boolean;
  matched: boolean;
}

/** Non-destructive identity signal check used to flag (not convict) self-referral. */
export async function detectIdentitySignals(
  tx: Transaction,
  companyId: number,
  params: { customerId: number; referrerCustomerId: number }
): Promise<IdentitySignals> {
  const res = await tx.query<{
    c_phone: string | null;
    c_email: string | null;
    c_name: string | null;
    r_phone: string | null;
    r_email: string | null;
    r_name: string | null;
  }>(
    `SELECT
        MAX(CASE WHEN id = $2 THEN phone END) AS c_phone,
        MAX(CASE WHEN id = $2 THEN email END) AS c_email,
        MAX(CASE WHEN id = $2 THEN name END) AS c_name,
        MAX(CASE WHEN id = $3 THEN phone END) AS r_phone,
        MAX(CASE WHEN id = $3 THEN email END) AS r_email,
        MAX(CASE WHEN id = $3 THEN name END) AS r_name
       FROM customers WHERE company_id = $1 AND id IN ($2, $3)`,
    [companyId, Number(params.customerId), Number(params.referrerCustomerId)]
  );
  const row = res.rows[0];
  const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
  const samePhone = !!row?.c_phone && norm(row.c_phone) === norm(row.r_phone);
  const sameEmail = !!row?.c_email && norm(row.c_email) === norm(row.r_email);
  const cName = norm(row?.c_name);
  const rName = norm(row?.r_name);
  const similarName = !!cName && !!rName && (cName === rName || (cName.length > 3 && rName.includes(cName)));
  return { samePhone, sameEmail, similarName, matched: samePhone || sameEmail || similarName };
}

export async function flagReferralHold(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { attributionId?: number | null; eventId?: number | null; reason: string; evidence?: unknown }
): Promise<number> {
  if (input.eventId != null) {
    await tx.query(
      `UPDATE referral_events SET fraud_hold = TRUE WHERE company_id = $1 AND id = $2`,
      [companyId, Number(input.eventId)]
    );
  }
  const ins = await tx.query<{ id: number }>(
    `INSERT INTO referral_cases (company_id, case_type, status, attribution_id, referral_event_id, evidence, created_by)
     VALUES ($1, 'fraud', 'open', $2, $3, $4::JSONB, $5) RETURNING id`,
    [
      companyId,
      input.attributionId != null ? Number(input.attributionId) : null,
      input.eventId != null ? Number(input.eventId) : null,
      JSON.stringify(input.evidence ?? { reason: input.reason }),
      actor.userId,
    ]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_FRAUD_CASE_OPENED',
    tableName: 'referral_cases',
    recordId: Number(ins.rows[0].id),
    newValues: { reason: input.reason, eventId: input.eventId ?? null },
  });
  return Number(ins.rows[0].id);
}

export async function recordFraudDecision(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { caseId: number; decision: 'confirmed' | 'dismissed'; reason: string; evidence?: unknown }
): Promise<void> {
  const res = await tx.query<{ id: number; referral_event_id: number | null; status: string }>(
    `SELECT id, referral_event_id, status FROM referral_cases WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, Number(input.caseId)]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Referral case not found', 'REFERRAL_CASE_NOT_FOUND');
  }
  const c = res.rows[0];
  if (c.status !== 'open' && c.status !== 'under_review') {
    throw new AccountingError(409, 'Case decision already recorded', 'REFERRAL_CASE_CLOSED');
  }
  if (!input.reason || !input.reason.trim()) {
    throw new AccountingError(400, 'A decision reason is required', 'REFERRAL_REASON_REQUIRED');
  }

  const newStatus: ReferralCaseStatus = input.decision === 'confirmed' ? 'confirmed' : 'dismissed';
  await tx.query(
    `UPDATE referral_cases
        SET status = $3, decided_by = $4, decided_at = NOW(), decision_reason = $5, evidence = $6::JSONB
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(input.caseId), newStatus, actor.userId, input.reason, JSON.stringify(input.evidence ?? {})]
  );

  if (input.decision === 'confirmed' && c.referral_event_id != null) {
    // Confirmed fraud → hold the reward pending authorised case-by-case handling.
    await tx.query(
      `UPDATE referral_events SET fraud_hold = TRUE WHERE company_id = $1 AND id = $2`,
      [companyId, Number(c.referral_event_id)]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_FRAUD_DECIDED',
    tableName: 'referral_cases',
    recordId: Number(input.caseId),
    newValues: { decision: input.decision, reason: input.reason },
  });
}

/**
 * U5-B independent dispute review. The reviewer must differ from the original
 * decision-maker (enforced in both service and database).
 */
export async function recordIndependentDisputeReview(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { caseId: number; reviewerUserId: number; outcome: 'uphold' | 'overturn'; reason: string }
): Promise<void> {
  const res = await tx.query<{ id: number; decided_by: number | null; status: string; referral_event_id: number | null }>(
    `SELECT id, decided_by, status, referral_event_id FROM referral_cases WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, Number(input.caseId)]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Referral case not found', 'REFERRAL_CASE_NOT_FOUND');
  }
  const c = res.rows[0];
  if (c.status !== 'confirmed' && c.status !== 'dismissed') {
    throw new AccountingError(409, 'Only decided cases can be independently reviewed', 'REFERRAL_CASE_NOT_DECIDED');
  }
  if (c.decided_by != null && Number(c.decided_by) === Number(input.reviewerUserId)) {
    throw new AccountingError(
      403,
      'The independent reviewer must differ from the original decision-maker',
      'REFERRAL_REVIEWER_NOT_INDEPENDENT'
    );
  }
  if (!input.reason || !input.reason.trim()) {
    throw new AccountingError(400, 'A review reason is required', 'REFERRAL_REASON_REQUIRED');
  }

  await tx.query(
    `UPDATE referral_cases SET reviewer_id = $3, status = 'resolved' WHERE company_id = $1 AND id = $2`,
    [companyId, Number(input.caseId), Number(input.reviewerUserId)]
  );
  if (input.outcome === 'overturn' && c.referral_event_id != null) {
    // Overturned fraud hold → release the hold.
    await tx.query(
      `UPDATE referral_events SET fraud_hold = FALSE WHERE company_id = $1 AND id = $2`,
      [companyId, Number(c.referral_event_id)]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_DISPUTE_REVIEWED',
    tableName: 'referral_cases',
    recordId: Number(input.caseId),
    newValues: { reviewerUserId: input.reviewerUserId, outcome: input.outcome, reason: input.reason },
  });
}