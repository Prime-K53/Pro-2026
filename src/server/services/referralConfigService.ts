import { Transaction } from '@electric-sql/pglite';
import {
  AccountingError,
  ActorContext,
} from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { assertIsoDate, isoDateOnly, todayIsoDate } from './commercialHelpers.ts';

/**
 * Central referral configuration service.
 *
 * The CAMPAIGN is the authoritative source of effective financial terms
 * (D-01-B). Programme-level rate fields are retained only for backward
 * compatibility and are NEVER used to supply campaign financial terms.
 *
 * All mandatory financial values are nullable (UNCONFIGURED) until explicitly
 * supplied. A campaign cannot activate until every mandatory value and both
 * Finance and Management approvals are recorded (L1-B, §3).
 */

export type ReferrerRewardType = 'fixed_credit' | 'percent_commission' | 'cash_payout';
export type RefereeDiscountType = 'percent' | 'fixed_amount';

export interface CampaignTerms {
  campaignId: number;
  programId: number;
  name: string;
  referrerRewardType: ReferrerRewardType;
  referrerRewardValue4: bigint;
  refereeDiscountType: RefereeDiscountType;
  refereeDiscountValue4: bigint;
  maxReferrerRewardPerOrder4: bigint | null;
  maxRefereeDiscountPerOrder4: bigint | null;
  rewardApprovalThreshold4: bigint | null;
  eligibleItemTypes: string[] | null;
  eligibleItemIds: number[] | null;
  attributionWindowDays: number;
  startsAt: string | null;
  endsAt: string | null;
  budgetAmount4: bigint;
  budgetReserved4: bigint;
  budgetQualified4: bigint;
  lifecycleStatus: string;
}

export interface CampaignRow {
  id: number;
  company_id: number;
  program_id: number;
  name: string;
  referrer_reward_type: string | null;
  referrer_reward_value: string | null;
  referee_discount_type: string | null;
  referee_discount_value: string | null;
  max_referrer_reward_per_order: string | null;
  max_referee_discount_per_order: string | null;
  reward_approval_threshold: string | null;
  attribution_window_days: number | null;
  eligible_item_types: string[] | null;
  eligible_item_ids: string[] | null;
  starts_at: string | null;
  ends_at: string | null;
  lifecycle_status: string;
  budget_amount: string;
  budget_reserved_amount: string;
  budget_qualified_amount: string;
  finance_approved_at: string | null;
  management_approved_at: string | null;
}

function toNumArray(v: unknown): number[] | null {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : [];
  const nums = arr.map(x => Number(x)).filter(n => Number.isInteger(n));
  return nums.length > 0 ? nums : null;
}

export function mapCampaignTerms(row: CampaignRow): CampaignTerms {
  return {
    campaignId: Number(row.id),
    programId: Number(row.program_id),
    name: row.name,
    referrerRewardType: (row.referrer_reward_type as ReferrerRewardType) || 'fixed_credit',
    referrerRewardValue4: parseDecimal4(row.referrer_reward_value ?? 0),
    refereeDiscountType: (row.referee_discount_type as RefereeDiscountType) || 'percent',
    refereeDiscountValue4: parseDecimal4(row.referee_discount_value ?? 0),
    maxReferrerRewardPerOrder4:
      row.max_referrer_reward_per_order != null ? parseDecimal4(row.max_referrer_reward_per_order) : null,
    maxRefereeDiscountPerOrder4:
      row.max_referee_discount_per_order != null ? parseDecimal4(row.max_referee_discount_per_order) : null,
    rewardApprovalThreshold4:
      row.reward_approval_threshold != null ? parseDecimal4(row.reward_approval_threshold) : null,
    eligibleItemTypes: row.eligible_item_types && row.eligible_item_types.length > 0 ? row.eligible_item_types : null,
    eligibleItemIds: toNumArray(row.eligible_item_ids),
    attributionWindowDays: row.attribution_window_days != null ? Number(row.attribution_window_days) : 90,
    startsAt: isoDateOnly(row.starts_at),
    endsAt: isoDateOnly(row.ends_at),
    budgetAmount4: parseDecimal4(row.budget_amount),
    budgetReserved4: parseDecimal4(row.budget_reserved_amount),
    budgetQualified4: parseDecimal4(row.budget_qualified_amount),
    lifecycleStatus: row.lifecycle_status,
  };
}

/** Serializable snapshot of campaign terms (bigints → 4-dp strings). */
export function serializeTerms(terms: CampaignTerms): Record<string, unknown> {
  return {
    campaignId: terms.campaignId,
    programId: terms.programId,
    name: terms.name,
    referrerRewardType: terms.referrerRewardType,
    referrerRewardValue4: formatDecimal4(terms.referrerRewardValue4),
    refereeDiscountType: terms.refereeDiscountType,
    refereeDiscountValue4: formatDecimal4(terms.refereeDiscountValue4),
    maxReferrerRewardPerOrder4:
      terms.maxReferrerRewardPerOrder4 != null ? formatDecimal4(terms.maxReferrerRewardPerOrder4) : null,
    maxRefereeDiscountPerOrder4:
      terms.maxRefereeDiscountPerOrder4 != null ? formatDecimal4(terms.maxRefereeDiscountPerOrder4) : null,
    rewardApprovalThreshold4:
      terms.rewardApprovalThreshold4 != null ? formatDecimal4(terms.rewardApprovalThreshold4) : null,
    eligibleItemTypes: terms.eligibleItemTypes,
    eligibleItemIds: terms.eligibleItemIds,
    attributionWindowDays: terms.attributionWindowDays,
    startsAt: terms.startsAt,
    endsAt: terms.endsAt,
    budgetAmount4: formatDecimal4(terms.budgetAmount4),
    budgetReserved4: formatDecimal4(terms.budgetReserved4),
    budgetQualified4: formatDecimal4(terms.budgetQualified4),
    lifecycleStatus: terms.lifecycleStatus,
  };
}

/** True when every mandatory financial value is configured (activation blocker). */
export function isCampaignConfigComplete(row: CampaignRow): boolean {
  const hasRates =
    row.referrer_reward_type != null &&
    row.referrer_reward_value != null &&
    row.referee_discount_type != null &&
    row.referee_discount_value != null;
  const hasCaps =
    row.max_referrer_reward_per_order != null && row.max_referee_discount_per_order != null;
  const hasThreshold = row.reward_approval_threshold != null;
  const hasEligible =
    (row.eligible_item_types != null && row.eligible_item_types.length > 0) ||
    (row.eligible_item_ids != null && row.eligible_item_ids.length > 0);
  const hasBudget = parseDecimal4(row.budget_amount) > 0n;
  const hasDates = row.starts_at != null && row.ends_at != null;
  return hasRates && hasCaps && hasThreshold && hasEligible && hasBudget && hasDates;
}

export function budgetAvailable4(terms: CampaignTerms): bigint {
  return terms.budgetAmount4 - terms.budgetReserved4 - terms.budgetQualified4;
}

async function loadCampaignRow(tx: Transaction, companyId: number, campaignId: number): Promise<CampaignRow> {
  const res = await tx.query<CampaignRow>(
    `SELECT * FROM referral_campaigns WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, campaignId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Referral campaign not found', 'REFERRAL_CAMPAIGN_NOT_FOUND');
  }
  return res.rows[0];
}

/**
 * Resolve the effective campaign terms for a program/campaign pair.
 * If no campaignId is supplied, the program's active campaign is used; failing
 * that, its most recent campaign. Returns null when no campaign exists.
 */
export async function resolveEffectiveTerms(
  tx: Transaction,
  companyId: number,
  params: { programId: number; campaignId?: number | null }
): Promise<CampaignTerms | null> {
  if (params.campaignId) {
    const row = await loadCampaignRow(tx, companyId, Number(params.campaignId));
    if (Number(row.program_id) !== Number(params.programId)) {
      throw new AccountingError(400, 'Campaign does not belong to the program', 'REFERRAL_CAMPAIGN_PROGRAM_MISMATCH');
    }
    return mapCampaignTerms(row);
  }

  const res = await tx.query<CampaignRow>(
    `SELECT * FROM referral_campaigns
      WHERE company_id = $1 AND program_id = $2
      ORDER BY (lifecycle_status = 'active') DESC, id ASC
      LIMIT 1`,
    [companyId, Number(params.programId)]
  );
  if (res.rows.length === 0) return null;
  return mapCampaignTerms(res.rows[0]);
}

/** True when the campaign accepts new attributions at the given ISO date. */
export function campaignAcceptsAttributions(terms: CampaignTerms, atDateIso: string): boolean {
  if (terms.lifecycleStatus !== 'active') return false;
  if (terms.startsAt && atDateIso < terms.startsAt) return false;
  if (terms.endsAt && atDateIso > terms.endsAt) return false;
  if (budgetAvailable4(terms) <= 0n) return false;
  return true;
}

export interface CampaignConfigPatch {
  referrerRewardType?: ReferrerRewardType;
  referrerRewardValue?: string | number;
  refereeDiscountType?: RefereeDiscountType;
  refereeDiscountValue?: string | number;
  maxReferrerRewardPerOrder?: string | number | null;
  maxRefereeDiscountPerOrder?: string | number | null;
  rewardApprovalThreshold?: string | number | null;
  attributionWindowDays?: number;
  eligibleItemTypes?: string[] | null;
  eligibleItemIds?: number[] | null;
  startsAt?: string | null;
  endsAt?: string | null;
  budgetAmount?: string | number;
}

function validatePercentage(value4: bigint, label: string): void {
  if (value4 < 0n) throw new AccountingError(400, `${label} cannot be negative`, 'REFERRAL_INVALID_RATE');
  if (value4 > 1000000n) {
    throw new AccountingError(400, `${label} cannot exceed 100%`, 'REFERRAL_INVALID_RATE');
  }
}

/** Apply a financial configuration patch to a campaign and audit the change. */
export async function configureCampaign(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  campaignId: number,
  patch: CampaignConfigPatch
): Promise<CampaignTerms> {
  const row = await loadCampaignRow(tx, companyId, campaignId);

  const referrerRewardType = patch.referrerRewardType ?? (row.referrer_reward_type as ReferrerRewardType | null) ?? undefined;
  const referrerRewardValue4 =
    patch.referrerRewardValue !== undefined
      ? parseDecimal4(patch.referrerRewardValue)
      : row.referrer_reward_value != null
        ? parseDecimal4(row.referrer_reward_value)
        : undefined;
  if (referrerRewardType === 'percent_commission' && referrerRewardValue4 !== undefined) {
    validatePercentage(referrerRewardValue4, 'Referrer reward percentage');
  }

  const refereeDiscountType = patch.refereeDiscountType ?? (row.referee_discount_type as RefereeDiscountType | null) ?? undefined;
  const refereeDiscountValue4 =
    patch.refereeDiscountValue !== undefined
      ? parseDecimal4(patch.refereeDiscountValue)
      : row.referee_discount_value != null
        ? parseDecimal4(row.referee_discount_value)
        : undefined;
  if (refereeDiscountType === 'percent' && refereeDiscountValue4 !== undefined) {
    validatePercentage(refereeDiscountValue4, 'Referee discount percentage');
  }

  const startsAt =
    patch.startsAt !== undefined ? (patch.startsAt ? assertIsoDate(patch.startsAt, 'startsAt') : null) : isoDateOnly(row.starts_at);
  const endsAt =
    patch.endsAt !== undefined ? (patch.endsAt ? assertIsoDate(patch.endsAt, 'endsAt') : null) : isoDateOnly(row.ends_at);
  if (startsAt && endsAt && endsAt < startsAt) {
    throw new AccountingError(400, 'Campaign end date cannot precede start date', 'REFERRAL_INVALID_DATE_RANGE');
  }

  const budgetAmount4 = patch.budgetAmount !== undefined ? parseDecimal4(patch.budgetAmount) : parseDecimal4(row.budget_amount);
  if (budgetAmount4 < 0n) throw new AccountingError(400, 'Campaign budget cannot be negative', 'REFERRAL_INVALID_BUDGET');

  await tx.query(
    `UPDATE referral_campaigns SET
        referrer_reward_type = $3,
        referrer_reward_value = $4::NUMERIC(19,4),
        referee_discount_type = $5,
        referee_discount_value = $6::NUMERIC(19,4),
        max_referrer_reward_per_order = $7::NUMERIC(19,4),
        max_referee_discount_per_order = $8::NUMERIC(19,4),
        reward_approval_threshold = $9::NUMERIC(19,4),
        attribution_window_days = $10,
        eligible_item_types = $11,
        eligible_item_ids = $12,
        starts_at = $13::DATE,
        ends_at = $14::DATE,
        budget_amount = $15::NUMERIC(19,4)
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      campaignId,
      referrerRewardType ?? null,
      referrerRewardValue4 !== undefined ? formatDecimal4(referrerRewardValue4) : null,
      refereeDiscountType ?? null,
      refereeDiscountValue4 !== undefined ? formatDecimal4(refereeDiscountValue4) : null,
      patch.maxReferrerRewardPerOrder !== undefined
        ? patch.maxReferrerRewardPerOrder === null
          ? null
          : formatDecimal4(parseDecimal4(patch.maxReferrerRewardPerOrder))
        : row.max_referrer_reward_per_order,
      patch.maxRefereeDiscountPerOrder !== undefined
        ? patch.maxRefereeDiscountPerOrder === null
          ? null
          : formatDecimal4(parseDecimal4(patch.maxRefereeDiscountPerOrder))
        : row.max_referee_discount_per_order,
      patch.rewardApprovalThreshold !== undefined
        ? patch.rewardApprovalThreshold === null
          ? null
          : formatDecimal4(parseDecimal4(patch.rewardApprovalThreshold))
        : row.reward_approval_threshold,
      patch.attributionWindowDays !== undefined ? patch.attributionWindowDays : row.attribution_window_days ?? 90,
      patch.eligibleItemTypes !== undefined
        ? patch.eligibleItemTypes && patch.eligibleItemTypes.length > 0
          ? patch.eligibleItemTypes
          : null
        : row.eligible_item_types,
      patch.eligibleItemIds !== undefined
        ? patch.eligibleItemIds && patch.eligibleItemIds.length > 0
          ? patch.eligibleItemIds
          : null
        : row.eligible_item_ids,
      startsAt,
      endsAt,
      formatDecimal4(budgetAmount4),
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_CAMPAIGN_CONFIGURED',
    tableName: 'referral_campaigns',
    recordId: campaignId,
    newValues: {
      referrerRewardType: referrerRewardType ?? null,
      referrerRewardValue: referrerRewardValue4 !== undefined ? formatDecimal4(referrerRewardValue4) : null,
      refereeDiscountType: refereeDiscountType ?? null,
      refereeDiscountValue: refereeDiscountValue4 !== undefined ? formatDecimal4(refereeDiscountValue4) : null,
      budgetAmount: formatDecimal4(budgetAmount4),
      startsAt,
      endsAt,
    },
  });

  return resolveEffectiveTerms(tx, companyId, { programId: Number(row.program_id), campaignId }) as Promise<CampaignTerms>;
}

export async function recordFinanceApproval(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  campaignId: number,
  note?: string | null
): Promise<void> {
  const row = await loadCampaignRow(tx, companyId, campaignId);
  if (!isCampaignConfigComplete(row)) {
    throw new AccountingError(
      409,
      'Campaign financial configuration is incomplete; Finance approval cannot be recorded',
      'REFERRAL_CONFIG_INCOMPLETE'
    );
  }
  await tx.query(
    `UPDATE referral_campaigns SET finance_approved_at = NOW(), finance_approved_by = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, campaignId, actor.userId]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_FINANCE_APPROVED',
    tableName: 'referral_campaigns',
    recordId: campaignId,
    newValues: { note: note ?? null },
  });
}

export async function recordManagementApproval(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  campaignId: number,
  note?: string | null
): Promise<void> {
  const row = await loadCampaignRow(tx, companyId, campaignId);
  if (row.finance_approved_at == null) {
    throw new AccountingError(
      409,
      'Finance approval must be recorded before Management activation approval',
      'REFERRAL_FINANCE_APPROVAL_REQUIRED'
    );
  }
  await tx.query(
    `UPDATE referral_campaigns SET management_approved_at = NOW(), management_approved_by = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, campaignId, actor.userId]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_MANAGEMENT_APPROVED',
    tableName: 'referral_campaigns',
    recordId: campaignId,
    newValues: { note: note ?? null },
  });
}

/** Activation gate (L1-B): config complete + Finance + Management approval. */
export async function activateCampaign(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  campaignId: number
): Promise<CampaignTerms> {
  const row = await loadCampaignRow(tx, companyId, campaignId);
  if (!isCampaignConfigComplete(row)) {
    throw new AccountingError(
      409,
      'Campaign cannot activate: mandatory financial configuration is incomplete',
      'REFERRAL_CAMPAIGN_INCOMPLETE'
    );
  }
  if (row.finance_approved_at == null) {
    throw new AccountingError(409, 'Campaign cannot activate: Finance approval missing', 'REFERRAL_FINANCE_APPROVAL_REQUIRED');
  }
  if (row.management_approved_at == null) {
    throw new AccountingError(
      409,
      'Campaign cannot activate: Management approval missing',
      'REFERRAL_MANAGEMENT_APPROVAL_REQUIRED'
    );
  }
  await tx.query(
    `UPDATE referral_campaigns
        SET lifecycle_status = 'active', status = 'active', activated_at = NOW()
      WHERE company_id = $1 AND id = $2`,
    [companyId, campaignId]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_CAMPAIGN_ACTIVATED',
    tableName: 'referral_campaigns',
    recordId: campaignId,
    newValues: { lifecycleStatus: 'active' },
  });
  return resolveEffectiveTerms(tx, companyId, { programId: Number(row.program_id), campaignId }) as Promise<CampaignTerms>;
}

export async function setCampaignLifecycle(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  campaignId: number,
  lifecycleStatus: 'active' | 'suspended' | 'exhausted' | 'completed' | 'closed' | 'draft' | 'pending_approval',
  reason?: string | null
): Promise<void> {
  const row = await loadCampaignRow(tx, companyId, campaignId);
  const statusMap: Record<string, string> = {
    active: 'active',
    suspended: 'suspended',
    exhausted: 'exhausted',
    completed: 'completed',
    closed: 'closed',
    draft: 'draft',
    pending_approval: 'pending_approval',
  };
  await tx.query(
    `UPDATE referral_campaigns
        SET lifecycle_status = $3,
            status = $4,
            suspended_at = CASE WHEN $3 = 'suspended' THEN NOW() ELSE suspended_at END,
            suspension_reason = CASE WHEN $3 = 'suspended' THEN $5 ELSE suspension_reason END
      WHERE company_id = $1 AND id = $2`,
    [companyId, campaignId, lifecycleStatus, statusMap[lifecycleStatus] ?? lifecycleStatus, reason ?? null]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_CAMPAIGN_LIFECYCLE_CHANGED',
    tableName: 'referral_campaigns',
    recordId: campaignId,
    oldValues: { lifecycleStatus: row.lifecycle_status },
    newValues: { lifecycleStatus, reason: reason ?? null },
  });
}

export { todayIsoDate };