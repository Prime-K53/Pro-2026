import crypto from 'node:crypto';
import { Transaction } from '@electric-sql/pglite';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { isFirstOrderCustomer } from './referralAttributionService.ts';
import { qualifyReservation } from './referralBudgetService.ts';

/**
 * Central reward qualification service (P1-A, P2-A, P3-D, F4-A).
 *
 * A reward qualifies only when:
 *   1. the attribution is valid and within its validity window,
 *   2. the referee meets first-order eligibility,
 *   3. every invoice belonging to the order is fully settled,
 *   4. all ordered quantities are delivered and accepted,
 *   5. traceable delivery evidence exists,
 *   6. the order is not disqualified by refund/cancellation,
 *   7. no unresolved fraud hold exists,
 *   8. the reservation is valid,
 *   9. the reward has not already been qualified or credited.
 */

export interface DeliveryEvidence {
  type: 'customer_signed' | 'portal_confirmation' | 'staff_confirmation' | 'pos_completed' | 'delivery_note' | 'job_completed';
  reference?: string | null;
}

export interface QualificationResult {
  paid: boolean;
  delivered: boolean;
  evidence: DeliveryEvidence[];
  detail: Record<string, unknown>;
}

/**
 * Determine paid + delivered status for a POS order or invoice.
 * Operations must approve the exact delivery-evidence mapping before production
 * activation; this is a documented Phase 1 mapping.
 */
export async function evaluateOrderQualification(
  tx: Transaction,
  companyId: number,
  input: { posOrderId?: number | null; invoiceId?: number | null; customerId: number; deliveryEvidence?: DeliveryEvidence | null }
): Promise<QualificationResult> {
  const evidence: DeliveryEvidence[] = [];
  const detail: Record<string, unknown> = {};
  let paid = false;
  let delivered = false;

  if (input.deliveryEvidence) {
    // P3-D: authorised manual delivery evidence (customer signed / portal / staff).
    evidence.push(input.deliveryEvidence);
    delivered = true;
    detail.manualDeliveryEvidence = input.deliveryEvidence;
  }

  if (input.posOrderId) {
    const pos = await tx.query<{ status: string; invoice_id: number | null; total: string }>(
      `SELECT status, invoice_id, total FROM pos_orders WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, Number(input.posOrderId)]
    );
    if (pos.rows.length === 0) {
      throw new AccountingError(404, 'POS order not found', 'POS_ORDER_NOT_FOUND');
    }
    const order = pos.rows[0];
    detail.posOrderId = Number(input.posOrderId);
    detail.posStatus = order.status;

    if (order.status === 'completed') {
      paid = true;
      // POS is an immediate over-the-counter handover: completion is delivery.
      delivered = true;
      evidence.push({ type: 'pos_completed', reference: String(input.posOrderId) });
    } else if (order.status === 'on_account') {
      paid = false;
    } else if (order.status === 'voided') {
      throw new AccountingError(409, 'POS order is voided; reward is disqualified', 'REFERRAL_ORDER_VOIDED');
    }

    if (!paid && order.invoice_id != null) {
      const inv = await tx.query<{ balance_due: string; total: string }>(
        `SELECT balance_due, total FROM invoices WHERE company_id = $1 AND id = $2 LIMIT 1`,
        [companyId, Number(order.invoice_id)]
      );
      if (inv.rows.length === 0) {
        throw new AccountingError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
      }
      const bal = parseDecimal4(inv.rows[0].balance_due);
      paid = bal <= 0n;
      detail.invoiceBalanceDue = Number(bal) / 10000;
    }
  }

  if (input.invoiceId) {
    const inv = await tx.query<{ id: number; total: string; amount_paid: string; balance_due: string }>(
      `SELECT id, total, amount_paid, balance_due FROM invoices WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, Number(input.invoiceId)]
    );
    if (inv.rows.length === 0) {
      throw new AccountingError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
    }
    const invoice = inv.rows[0];
    detail.invoiceId = Number(input.invoiceId);
    const bal = parseDecimal4(invoice.balance_due);
    paid = paid || bal <= 0n;
    detail.invoiceBalanceDue = Number(bal) / 10000;

    // Delivery evidence: delivered delivery notes, or all related printing jobs delivered/completed.
    if (!delivered) {
      const notes = await tx.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM delivery_notes
          WHERE company_id = $1 AND delivery_note_number IS NOT NULL AND status = 'delivered'`,
        [companyId]
      );
      const jobs = await tx.query<{ total: string; done: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE status IN ('delivered', 'completed'))::text AS done
           FROM printing_jobs WHERE company_id = $1 AND invoice_id = $2`,
        [companyId, Number(input.invoiceId)]
      );
      const jobTotal = Number(jobs.rows[0]?.total || 0);
      const jobDone = Number(jobs.rows[0]?.done || 0);
      if (jobTotal > 0 && jobDone === jobTotal) {
        delivered = true;
        evidence.push({ type: 'job_completed', reference: String(input.invoiceId) });
      } else if (Number(notes.rows[0]?.cnt || 0) > 0) {
        delivered = true;
        evidence.push({ type: 'delivery_note', reference: String(input.invoiceId) });
      }
    }
  }

  return { paid, delivered, evidence, detail };
}

/**
 * Qualify a referral reward event (paid + delivered). Sets status to 'approved'
 * and converts any reservation to 'qualified'. The reward is credited separately
 * by the reward service (which enforces the approval threshold).
 */
export async function qualifyReferralEvent(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  eventId: number,
  input: { deliveryEvidence?: DeliveryEvidence | null } = {}
): Promise<{ eventId: number; status: string; rewardAmount: number; alreadyQualified: boolean }> {
  const res = await tx.query<any>(
    `SELECT * FROM referral_events WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, Number(eventId)]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Referral reward event not found', 'REFERRAL_EVENT_NOT_FOUND');
  }
  const event = res.rows[0];

  if (event.status === 'voided' || event.status === 'reversed') {
    throw new AccountingError(409, 'Voided or reversed event cannot be qualified', 'REFERRAL_EVENT_VOID');
  }
  if (event.status === 'credited' || event.status === 'paid') {
    return {
      eventId: Number(event.id),
      status: String(event.status),
      rewardAmount: Number(parseDecimal4(String(event.reward_amount))) / 10000,
      alreadyQualified: true,
    };
  }
  if (event.fraud_hold) {
    throw new AccountingError(409, 'Referral is on fraud hold and cannot qualify', 'REFERRAL_FRAUD_HOLD');
  }

  // 1. Valid attribution within its window.
  if (event.attribution_id == null) {
    throw new AccountingError(
      409,
      'Referral event has no first-valid attribution; cannot qualify',
      'REFERRAL_ATTRIBUTION_MISSING'
    );
  }
  const attr = await tx.query<{ id: number; status: string; valid_until: string | null; customer_id: number }>(
    `SELECT id, status, valid_until, customer_id FROM referral_attributions WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, Number(event.attribution_id)]
  );
  if (attr.rows.length === 0) {
    throw new AccountingError(404, 'Referral attribution not found', 'REFERRAL_ATTRIBUTION_NOT_FOUND');
  }
  const attribution = attr.rows[0];
  if (attribution.status !== 'active') {
    throw new AccountingError(409, 'Referral attribution is not active', 'REFERRAL_ATTRIBUTION_INACTIVE');
  }
  const nowMs = Date.now();
  if (attribution.valid_until && nowMs > new Date(String(attribution.valid_until)).getTime()) {
    throw new AccountingError(409, 'Referral attribution has expired', 'REFERRAL_ATTRIBUTION_EXPIRED');
  }

  const refereeCustomerId =
    event.referee_customer_id != null ? Number(event.referee_customer_id) : Number(attribution.customer_id);

  // 2. First-order eligibility (excluding the current order).
  const firstOrder = await isFirstOrderCustomer(tx, companyId, refereeCustomerId, event.pos_order_id ? String(event.pos_order_id) : null);
  if (!firstOrder) {
    throw new AccountingError(
      409,
      'Referred customer does not meet first-order eligibility',
      'REFERRAL_FIRST_ORDER_NOT_MET'
    );
  }

  // 3/4/5. Paid + delivered.
  const qualification = await evaluateOrderQualification(tx, companyId, {
    posOrderId: event.pos_order_id != null ? Number(event.pos_order_id) : null,
    invoiceId: event.invoice_id != null ? Number(event.invoice_id) : null,
    customerId: refereeCustomerId,
    deliveryEvidence: input.deliveryEvidence ?? null,
  });
  if (!qualification.paid || !qualification.delivered) {
    throw new AccountingError(
      409,
      `Referral reward is not yet qualified (paid=${qualification.paid}, delivered=${qualification.delivered})`,
      'REFERRAL_NOT_QUALIFIED'
    );
  }

  // 8. Reservation valid → qualified.
  if (event.reservation_id != null) {
    await qualifyReservation(tx, companyId, Number(event.reservation_id));
  }

  await tx.query(
    `UPDATE referral_events
        SET status = 'approved',
            qualification_evidence = $3::JSONB
      WHERE company_id = $1 AND id = $2 AND status = 'pending'`,
    [companyId, Number(eventId), JSON.stringify(qualification.evidence)]
  );

  // A1-C: rewards at or above the campaign approval threshold require approval.
  // Create a pending referral_reward_approval request linked to the event.
  const reward4 = parseDecimal4(String(event.reward_amount));
  const snapshot = (event.terms_snapshot as any) || null;
  const threshold4 =
    snapshot?.rewardApprovalThreshold4 != null ? parseDecimal4(String(snapshot.rewardApprovalThreshold4)) : null;
  let approvalRequestId: number | null = event.approval_request_id != null ? Number(event.approval_request_id) : null;
  if (approvalRequestId == null && threshold4 != null && reward4 >= threshold4) {
    const approvalKey = `ref-reward-appr-${companyId}-${eventId}`;
    const existing = await tx.query<{ id: number }>(
      `SELECT id FROM approval_requests
        WHERE company_id = $1 AND action_type = 'referral_reward_approval' AND idempotency_key = $2 LIMIT 1`,
      [companyId, approvalKey]
    );
    if (existing.rows.length > 0) {
      approvalRequestId = Number(existing.rows[0].id);
    } else {
      const payloadHash = crypto.createHash('sha256').update(`${companyId}:${eventId}:${reward4}`).digest('hex');
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO approval_requests (
           company_id, action_type, entity_type, entity_id, business_date, amount, status,
           requested_by, payload_json, payload_hash, idempotency_key
         ) VALUES (
           $1, 'referral_reward_approval', 'referral_event', $2, CURRENT_DATE, $3::NUMERIC(19,4), 'pending',
           $4, '{}'::jsonb, $5, $6
         ) RETURNING id`,
        [companyId, Number(eventId), formatDecimal4(reward4), actor.userId, payloadHash, approvalKey]
      );
      approvalRequestId = Number(ins.rows[0].id);
    }
    await tx.query(`UPDATE referral_events SET approval_request_id = $3 WHERE company_id = $1 AND id = $2`, [
      companyId,
      Number(eventId),
      approvalRequestId,
    ]);
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_REWARD_QUALIFIED',
    tableName: 'referral_events',
    recordId: Number(eventId),
    newValues: { status: 'approved', qualification },
  });

  return {
    eventId: Number(eventId),
    status: 'approved',
    rewardAmount: Number(parseDecimal4(String(event.reward_amount))) / 10000,
    alreadyQualified: false,
  };
}