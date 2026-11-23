import { Transaction } from '@electric-sql/pglite';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';
import { addDaysToIso, toIsoTimestamp, todayIsoDate } from './commercialHelpers.ts';
import {
  CampaignTerms,
  campaignAcceptsAttributions,
  resolveEffectiveTerms,
  serializeTerms,
} from './referralConfigService.ts';

/**
 * Central referral attribution service.
 *
 * Enforces first-valid attribution (T2-A / T5-A), self-referral prevention
 * (C3-C), same-company referrer integrity, and first-order customer eligibility.
 * Link, code and verbal attributions share this single code path.
 */

export type AttributionMethod = 'link' | 'code' | 'verbal';

export interface AttributionRecord {
  id: number;
  customerId: number;
  referrerCustomerId: number;
  programId: number;
  campaignId: number | null;
  referralCodeId: number | null;
  method: AttributionMethod;
  status: string;
  validUntil: string | null;
  locked: boolean;
  termsSnapshot: CampaignTerms | null;
}

async function loadCustomer(tx: Transaction, companyId: number, customerId: number) {
  const res = await tx.query<{ id: number; company_name: string; is_active: boolean; customer_status: string }>(
    `SELECT id, company_name, is_active, customer_status
       FROM customers WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, customerId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
  }
  return res.rows[0];
}

export async function findActiveAttribution(
  tx: Transaction,
  companyId: number,
  customerId: number
): Promise<AttributionRecord | null> {
  const res = await tx.query<any>(
    `SELECT * FROM referral_attributions
      WHERE company_id = $1 AND customer_id = $2 AND status = 'active'
      LIMIT 1`,
    [companyId, customerId]
  );
  if (res.rows.length === 0) return null;
  return mapAttribution(res.rows[0]);
}

function mapAttribution(row: any): AttributionRecord {
  return {
    id: Number(row.id),
    customerId: Number(row.customer_id),
    referrerCustomerId: Number(row.referrer_customer_id),
    programId: Number(row.program_id),
    campaignId: row.campaign_id ? Number(row.campaign_id) : null,
    referralCodeId: row.referral_code_id ? Number(row.referral_code_id) : null,
    method: String(row.method) as AttributionMethod,
    status: String(row.status),
    validUntil: toIsoTimestamp(row.valid_until),
    locked: Boolean(row.locked),
    termsSnapshot: (row.terms_snapshot as CampaignTerms | null) ?? null,
  };
}

/** True when the referrer may refer (active customer, not blocked). */
export function isEligibleReferrer(customer: { is_active: boolean; customer_status: string }): boolean {
  return Boolean(customer.is_active) && customer.customer_status === 'active';
}

/**
 * A customer is first-order eligible when they have no other completed,
 * non-voided POS order (excluding an optional order reference).
 */
export async function isFirstOrderCustomer(
  tx: Transaction,
  companyId: number,
  customerId: number,
  excludeOrderRef?: string | null
): Promise<boolean> {
  const params: unknown[] = [companyId, customerId];
  let excludeClause = '';
  if (excludeOrderRef) {
    params.push(excludeOrderRef);
    excludeClause = ` AND id::text <> $${params.length}`;
  }
  const res = await tx.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
       FROM pos_orders
      WHERE company_id = $1 AND customer_id = $2 AND status = 'completed'${excludeClause}`,
    params
  );
  return Number(res.rows[0]?.cnt || 0) === 0;
}

export interface AttributionInput {
  customerId: number;
  referrerCustomerId: number;
  method: AttributionMethod;
  referralCodeId?: number | null;
  programId?: number | null;
  campaignId?: number | null;
  sourceContext: string;
}

/**
 * Record a first-valid attribution. Throws on validation failures. When no
 * eligible campaign exists the caller may catch REFERRAL_NO_CAMPAIGN /
 * REFERRAL_CAMPAIGN_UNAVAILABLE and continue without an attribution.
 */
export async function recordReferralAttribution(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: AttributionInput
): Promise<AttributionRecord> {
  const customerId = Number(input.customerId);
  const referrerCustomerId = Number(input.referrerCustomerId);
  if (!Number.isInteger(customerId) || !Number.isInteger(referrerCustomerId)) {
    throw new AccountingError(400, 'customerId and referrerCustomerId are required', 'REFERRAL_INVALID_INPUT');
  }
  if (customerId === referrerCustomerId) {
    throw new AccountingError(400, 'A customer cannot be referred by themselves', 'REFERRAL_SELF_REFERRAL');
  }

  const [customer, referrer] = await Promise.all([
    loadCustomer(tx, companyId, customerId),
    loadCustomer(tx, companyId, referrerCustomerId),
  ]);

  if (!isEligibleReferrer(referrer)) {
    throw new AccountingError(400, 'Referring customer is not eligible to refer', 'REFERRAL_REFERRER_INELIGIBLE');
  }

  const existing = await findActiveAttribution(tx, companyId, customerId);
  if (existing) {
    throw new AccountingError(
      409,
      'This customer already has a valid referral attribution (first-valid is locked)',
      'REFERRAL_ALREADY_ATTRIBUTED'
    );
  }

  // Resolve program: explicit > referral code > referrer's owned code.
  let programId = input.programId ? Number(input.programId) : null;
  let referralCodeId = input.referralCodeId ? Number(input.referralCodeId) : null;
  let campaignId = input.campaignId ? Number(input.campaignId) : null;

  if (referralCodeId) {
    const codeRes = await tx.query<{ program_id: number; campaign_id: number | null; referrer_customer_id: number | null }>(
      `SELECT program_id, campaign_id, referrer_customer_id
         FROM referral_codes WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, referralCodeId]
    );
    if (codeRes.rows.length === 0) {
      throw new AccountingError(404, 'Referral code not found', 'REFERRAL_CODE_NOT_FOUND');
    }
    const code = codeRes.rows[0];
    // T3-A: referral codes are customer-owned and non-transferable.
    if (code.referrer_customer_id != null && Number(code.referrer_customer_id) !== referrerCustomerId) {
      throw new AccountingError(403, 'Referral code is owned by another customer', 'REFERRAL_CODE_NOT_OWNED');
    }
    programId = programId ?? Number(code.program_id);
    campaignId = campaignId ?? (code.campaign_id ? Number(code.campaign_id) : null);
  }

  if (!programId) {
    const codeRes = await tx.query<{ program_id: number; campaign_id: number | null }>(
      `SELECT program_id, campaign_id FROM referral_codes
        WHERE company_id = $1 AND referrer_customer_id = $2 AND is_active = TRUE
        ORDER BY id ASC LIMIT 1`,
      [companyId, referrerCustomerId]
    );
    if (codeRes.rows.length === 0) {
      throw new AccountingError(404, 'Referring customer has no referral program', 'REFERRAL_NO_PROGRAM');
    }
    programId = Number(codeRes.rows[0].program_id);
    campaignId = campaignId ?? (codeRes.rows[0].campaign_id ? Number(codeRes.rows[0].campaign_id) : null);
  }

  const terms = await resolveEffectiveTerms(tx, companyId, { programId, campaignId });
  if (!terms) {
    throw new AccountingError(409, 'No referral campaign is available', 'REFERRAL_NO_CAMPAIGN');
  }

  const attributedAt = todayIsoDate();
  if (!campaignAcceptsAttributions(terms, attributedAt)) {
    throw new AccountingError(
      409,
      'The referral campaign is not accepting new attributions',
      'REFERRAL_CAMPAIGN_UNAVAILABLE'
    );
  }

  const validUntil = addDaysToIso(attributedAt, terms.attributionWindowDays);

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO referral_attributions (
       company_id, customer_id, referrer_customer_id, program_id, campaign_id,
       referral_code_id, method, status, source_context, attributed_by, valid_until, locked, terms_snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10::TIMESTAMPTZ, TRUE, $11::JSONB)
     RETURNING id`,
    [
      companyId,
      customerId,
      referrerCustomerId,
      programId,
      terms.campaignId,
      referralCodeId,
      input.method,
      input.sourceContext,
      actor.userId,
      validUntil,
      JSON.stringify(serializeTerms(terms)),
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_ATTRIBUTION_RECORDED',
    tableName: 'referral_attributions',
    recordId: Number(ins.rows[0].id),
    newValues: {
      customerId,
      referrerCustomerId,
      method: input.method,
      campaignId: terms.campaignId,
      sourceContext: input.sourceContext,
      validUntil,
    },
  });

  const row = await tx.query<any>(
    `SELECT * FROM referral_attributions WHERE company_id = $1 AND id = $2`,
    [companyId, Number(ins.rows[0].id)]
  );
  return mapAttribution(row.rows[0]);
}

/**
 * Manual attribution correction (A3-B). Requires an approved
 * referral_attribution_change approval request. The original attribution is
 * superseded (never deleted) and a new active attribution is recorded.
 */
export async function correctAttribution(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    newReferrerCustomerId: number;
    reason: string;
    approvalRequestId: number;
  }
): Promise<AttributionRecord> {
  const approval = await tx.query<{ id: number; status: string; action_type: string; entity_id: number | null }>(
    `SELECT id, status, action_type, entity_id FROM approval_requests
      WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, Number(input.approvalRequestId)]
  );
  if (approval.rows.length === 0) {
    throw new AccountingError(404, 'Approval request not found', 'APPROVAL_NOT_FOUND');
  }
  const req = approval.rows[0];
  if (req.action_type !== 'referral_attribution_change' || req.status !== 'approved') {
    throw new AccountingError(409, 'A valid approved attribution-change approval is required', 'REFERRAL_ATTRIBUTION_APPROVAL_REQUIRED');
  }
  if (!input.reason || !input.reason.trim()) {
    throw new AccountingError(400, 'A reason is required for attribution correction', 'REFERRAL_REASON_REQUIRED');
  }

  const existing = await findActiveAttribution(tx, companyId, Number(input.customerId));
  if (existing) {
    await tx.query(
      `UPDATE referral_attributions SET status = 'superseded' WHERE company_id = $1 AND id = $2`,
      [companyId, existing.id]
    );
  }

  const created = await recordReferralAttribution(tx, companyId, actor, {
    customerId: Number(input.customerId),
    referrerCustomerId: Number(input.newReferrerCustomerId),
    method: existing?.method ?? 'verbal',
    sourceContext: 'attribution_correction',
  });

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_ATTRIBUTION_CORRECTED',
    tableName: 'referral_attributions',
    recordId: created.id,
    oldValues: existing ? { attributionId: existing.id, referrerCustomerId: existing.referrerCustomerId } : null,
    newValues: { attributionId: created.id, referrerCustomerId: created.referrerCustomerId, reason: input.reason, approvalRequestId: input.approvalRequestId },
  });

  return created;
}