import { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';

/**
 * Campaign reward-budget reservation service (U1-A, U3-B, C4-A, T4-A).
 *
 * Only referrer bonuses count against the campaign reward budget. Customer
 * discounts are excluded and reported separately (U1-A).
 *
 * Reservations are deterministic and concurrency-safe:
 *   * The campaign row is locked FOR UPDATE before any budget mutation.
 *   * A partial unique index prevents duplicate live reservations for the same
 *     (campaign, attribution, order reference).
 *   * New attributions are rejected when available budget reaches zero, while
 *     already-attributed valid referrals continue to qualify under their
 *     original terms (U2-A).
 */

export interface ReservationRecord {
  id: number;
  campaignId: number;
  attributionId: number | null;
  orderRef: string;
  amount: number;
  status: string;
}

function mapReservation(row: any): ReservationRecord {
  return {
    id: Number(row.id),
    campaignId: Number(row.campaign_id),
    attributionId: row.attribution_id != null ? Number(row.attribution_id) : null,
    orderRef: String(row.order_ref),
    amount: Number(row.amount),
    status: String(row.status),
  };
}

async function lockCampaign(tx: Transaction, companyId: number, campaignId: number) {
  const res = await tx.query<{
    id: number;
    budget_amount: string;
    budget_reserved_amount: string;
    budget_qualified_amount: string;
    lifecycle_status: string;
  }>(
    `SELECT id, budget_amount, budget_reserved_amount, budget_qualified_amount, lifecycle_status
       FROM referral_campaigns WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, campaignId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Referral campaign not found', 'REFERRAL_CAMPAIGN_NOT_FOUND');
  }
  return res.rows[0];
}

export async function reserveBudget(
  tx: Transaction,
  companyId: number,
  input: { campaignId: number; attributionId?: number | null; orderRef: string; amount: string | number | bigint }
): Promise<ReservationRecord> {
  const amount4 = parseDecimal4(input.amount as any);
  if (amount4 <= 0n) {
    throw new AccountingError(400, 'Reservation amount must be greater than zero', 'REFERRAL_INVALID_RESERVATION');
  }
  const campaign = await lockCampaign(tx, companyId, Number(input.campaignId));

  // Idempotent: return an existing live reservation for the same key.
  const existing = await tx.query<any>(
    `SELECT * FROM referral_budget_reservations
      WHERE company_id = $1 AND campaign_id = $2 AND attribution_id IS NOT DISTINCT FROM $3 AND order_ref = $4
        AND status = 'reserved' LIMIT 1`,
    [companyId, Number(input.campaignId), input.attributionId ?? null, input.orderRef]
  );
  if (existing.rows.length > 0) {
    return mapReservation(existing.rows[0]);
  }

  const available4 =
    parseDecimal4(campaign.budget_amount) -
    parseDecimal4(campaign.budget_reserved_amount) -
    parseDecimal4(campaign.budget_qualified_amount);

  if (amount4 > available4) {
    // Exhaustion: stop new reservations. Existing reservations remain valid.
    if (available4 <= 0n && campaign.lifecycle_status !== 'exhausted') {
      await tx.query(
        `UPDATE referral_campaigns SET lifecycle_status = 'exhausted', status = 'exhausted'
          WHERE company_id = $1 AND id = $2`,
        [companyId, Number(input.campaignId)]
      );
    }
    throw new AccountingError(
      409,
      'Campaign reward budget is exhausted or insufficient for this reservation',
      'REFERRAL_BUDGET_EXHAUSTED'
    );
  }

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO referral_budget_reservations (company_id, campaign_id, attribution_id, order_ref, amount, status)
     VALUES ($1, $2, $3, $4, $5::NUMERIC(19,4), 'reserved')
     RETURNING id`,
    [companyId, Number(input.campaignId), input.attributionId ?? null, input.orderRef, formatDecimal4(amount4)]
  );

  await tx.query(
    `UPDATE referral_campaigns
        SET budget_reserved_amount = budget_reserved_amount + $3::NUMERIC(19,4)
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(input.campaignId), formatDecimal4(amount4)]
  );

  return {
    id: Number(ins.rows[0].id),
    campaignId: Number(input.campaignId),
    attributionId: input.attributionId ?? null,
    orderRef: input.orderRef,
    amount: Number(amount4) / 10000,
    status: 'reserved',
  };
}

export async function releaseReservation(
  tx: Transaction,
  companyId: number,
  reservationId: number
): Promise<void> {
  const res = await tx.query<{ campaign_id: number; amount: string; status: string }>(
    `SELECT campaign_id, amount, status FROM referral_budget_reservations
      WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, reservationId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Reservation not found', 'REFERRAL_RESERVATION_NOT_FOUND');
  }
  const row = res.rows[0];
  if (row.status !== 'reserved') return; // idempotent no-op

  await lockCampaign(tx, companyId, Number(row.campaign_id));
  await tx.query(
    `UPDATE referral_budget_reservations SET status = 'released' WHERE company_id = $1 AND id = $2`,
    [companyId, reservationId]
  );
  await tx.query(
    `UPDATE referral_campaigns
        SET budget_reserved_amount = GREATEST(0, budget_reserved_amount - $3::NUMERIC(19,4))
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(row.campaign_id), row.amount]
  );
}

export async function qualifyReservation(
  tx: Transaction,
  companyId: number,
  reservationId: number
): Promise<void> {
  const res = await tx.query<{ campaign_id: number; amount: string; status: string }>(
    `SELECT campaign_id, amount, status FROM referral_budget_reservations
      WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, reservationId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Reservation not found', 'REFERRAL_RESERVATION_NOT_FOUND');
  }
  const row = res.rows[0];
  if (row.status !== 'reserved') return;

  await lockCampaign(tx, companyId, Number(row.campaign_id));
  await tx.query(
    `UPDATE referral_budget_reservations SET status = 'qualified' WHERE company_id = $1 AND id = $2`,
    [companyId, reservationId]
  );
  await tx.query(
    `UPDATE referral_campaigns
        SET budget_reserved_amount = GREATEST(0, budget_reserved_amount - $3::NUMERIC(19,4)),
            budget_qualified_amount = budget_qualified_amount + $3::NUMERIC(19,4)
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(row.campaign_id), row.amount]
  );
}

export interface BudgetReconciliation {
  campaignId: number;
  budgetAmount: number;
  reservedLedger: number;
  qualifiedLedger: number;
  reservedComputed: number;
  qualifiedComputed: number;
  discrepancy: boolean;
}

export async function reconcileBudget(
  tx: Transaction,
  companyId: number,
  campaignId: number
): Promise<BudgetReconciliation> {
  const camp = await lockCampaign(tx, companyId, campaignId);
  const sums = await tx.query<{ reserved: string; qualified: string }>(
    `SELECT
        COALESCE(SUM(CASE WHEN status = 'reserved' THEN amount ELSE 0 END), 0)::NUMERIC(19,4)::text AS reserved,
        COALESCE(SUM(CASE WHEN status = 'qualified' THEN amount ELSE 0 END), 0)::NUMERIC(19,4)::text AS qualified
       FROM referral_budget_reservations WHERE company_id = $1 AND campaign_id = $2`,
    [companyId, campaignId]
  );
  const reservedComputed = parseDecimal4(sums.rows[0]?.reserved ?? 0);
  const qualifiedComputed = parseDecimal4(sums.rows[0]?.qualified ?? 0);
  const reservedLedger = parseDecimal4(camp.budget_reserved_amount);
  const qualifiedLedger = parseDecimal4(camp.budget_qualified_amount);
  return {
    campaignId,
    budgetAmount: Number(parseDecimal4(camp.budget_amount)) / 10000,
    reservedLedger: Number(reservedLedger) / 10000,
    qualifiedLedger: Number(qualifiedLedger) / 10000,
    reservedComputed: Number(reservedComputed) / 10000,
    qualifiedComputed: Number(qualifiedComputed) / 10000,
    discrepancy: reservedComputed !== reservedLedger || qualifiedComputed !== qualifiedLedger,
  };
}