import crypto from 'node:crypto';
import { Transaction } from '@electric-sql/pglite';
import { writeAuditLog } from '../audit.ts';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { multiplyQty6ByRate4, parseDecimal6, todayIsoDate } from './commercialHelpers.ts';

function p4(value: unknown): bigint {
  return parseDecimal4(value as string | number | bigint | null | undefined);
}

function p6(value: unknown): bigint {
  return parseDecimal6(value as string | number | bigint | null | undefined);
}

export const APPROVAL_ACTION_TYPES = [
  'invoice',
  'bill',
  'customer_payment',
  'bill_payment',
  'journal_entry',
  'credit_memo',
  'estimate_conversion',
  'po_receive',
  'wallet_refund',
  'wallet_reversal',
  'wallet_adjustment',
  'wallet_writeoff',
  'contract_cancel',
  'contract_refund',
  'contract_forfeit',
  'contract_assessment_change',
  'contract_activation',
  'contract_amendment',
  'customer',
  'credit_limit_change',
  'credit_hold_release',
  'customer_merge',
] as const;

export type ApprovalActionType = (typeof APPROVAL_ACTION_TYPES)[number];
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ApprovalPolicyRow {
  id: number;
  company_id: number;
  action_type: ApprovalActionType;
  threshold_amount: string;
  is_enabled: boolean;
  require_note: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRequestRow {
  id: number;
  company_id: number;
  action_type: ApprovalActionType;
  entity_type: string;
  entity_id: number | null;
  business_date: string;
  amount: string;
  status: ApprovalStatus;
  requested_by: number;
  requested_at: string;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  payload_json: unknown;
  payload_hash: string;
  idempotency_key: string | null;
  consumed_at: string | null;
  consumed_by: number | null;
  created_at: string;
  updated_at: string;
  requested_by_name?: string | null;
  decided_by_name?: string | null;
}

export interface ApprovalGateResult {
  requiresApproval: boolean;
  request: ApprovalRequestRow | null;
}

function isApprovalAction(value: unknown): value is ApprovalActionType {
  return typeof value === 'string' && (APPROVAL_ACTION_TYPES as readonly string[]).includes(value);
}

function mapPolicy(row: Record<string, unknown>): ApprovalPolicyRow {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    action_type: row.action_type as ApprovalActionType,
    threshold_amount: String(row.threshold_amount ?? '0.0000'),
    is_enabled: Boolean(row.is_enabled),
    require_note: Boolean(row.require_note),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapRequest(row: Record<string, unknown>): ApprovalRequestRow {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    action_type: row.action_type as ApprovalActionType,
    entity_type: String(row.entity_type),
    entity_id: row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id),
    business_date: String(row.business_date),
    amount: String(row.amount ?? '0.0000'),
    status: row.status as ApprovalStatus,
    requested_by: Number(row.requested_by),
    requested_at: String(row.requested_at),
    decided_by: row.decided_by === null || row.decided_by === undefined ? null : Number(row.decided_by),
    decided_at: row.decided_at ? String(row.decided_at) : null,
    decision_note: row.decision_note ? String(row.decision_note) : null,
    payload_json: row.payload_json ?? {},
    payload_hash: String(row.payload_hash),
    idempotency_key: row.idempotency_key ? String(row.idempotency_key) : null,
    consumed_at: row.consumed_at ? String(row.consumed_at) : null,
    consumed_by: row.consumed_by === null || row.consumed_by === undefined ? null : Number(row.consumed_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    requested_by_name: row.requested_by_name ? String(row.requested_by_name) : null,
    decided_by_name: row.decided_by_name ? String(row.decided_by_name) : null,
  };
}

/**
 * Exact amount used for maker-checker threshold evaluation.
 * Multiplies 6-decimal quantities by 4-decimal rates without floating point.
 */
export function sumLineAmounts4(
  lines: unknown,
  quantityField = 'quantity',
  rateField = 'rate'
): bigint {
  if (!Array.isArray(lines)) return 0n;
  let total4 = 0n;
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const qty6 = p6(rec[quantityField] ?? 0);
    const rate4 = p4(rec[rateField] ?? 0);
    total4 += multiplyQty6ByRate4(qty6, rate4, 'HALF_EVEN');
  }
  return total4;
}

export function sumAmountField4(values: unknown, field: string): bigint {
  if (!Array.isArray(values)) return 0n;
  let total4 = 0n;
  for (const raw of values) {
    if (!raw || typeof raw !== 'object') continue;
    total4 += p4((raw as Record<string, unknown>)[field] ?? 0);
  }
  return total4;
}

async function ensureApprovalPolicies(tx: Transaction, companyId: number): Promise<void> {
  for (const actionType of APPROVAL_ACTION_TYPES) {
    await tx.query(
      `INSERT INTO approval_policies (company_id, action_type)
       VALUES ($1, $2)
       ON CONFLICT (company_id, action_type) DO NOTHING`,
      [companyId, actionType]
    );
  }
}

export async function listApprovalPolicies(tx: Transaction, companyId: number): Promise<ApprovalPolicyRow[]> {
  await ensureApprovalPolicies(tx, companyId);
  const res = await tx.query<Record<string, unknown>>(
    `SELECT id, company_id, action_type, threshold_amount::text AS threshold_amount,
            is_enabled, require_note, created_at::text AS created_at, updated_at::text AS updated_at
       FROM approval_policies
      WHERE company_id = $1
      ORDER BY action_type ASC`,
    [companyId]
  );
  return res.rows.map(mapPolicy);
}

export async function updateApprovalPolicy(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    actionType: unknown;
    thresholdAmount?: unknown;
    isEnabled?: unknown;
    requireNote?: unknown;
  }
): Promise<ApprovalPolicyRow> {
  if (!isApprovalAction(input.actionType)) {
    throw new AccountingError(400, 'Invalid approval action type', 'INVALID_APPROVAL_ACTION');
  }
  const actionType = input.actionType;
  await ensureApprovalPolicies(tx, companyId);

  const existingRes = await tx.query<Record<string, unknown>>(
    `SELECT id, company_id, action_type, threshold_amount::text AS threshold_amount,
            is_enabled, require_note, created_at::text AS created_at, updated_at::text AS updated_at
       FROM approval_policies
      WHERE company_id = $1 AND action_type = $2
      LIMIT 1`,
    [companyId, actionType]
  );
  const existing = existingRes.rows[0];
  const threshold4 =
    input.thresholdAmount === undefined || input.thresholdAmount === null
      ? p4(existing?.threshold_amount ?? 0)
      : p4(input.thresholdAmount);
  if (threshold4 < 0n) {
    throw new AccountingError(400, 'Approval threshold cannot be negative', 'INVALID_THRESHOLD');
  }
  const isEnabled =
    input.isEnabled === undefined ? Boolean(existing?.is_enabled) : Boolean(input.isEnabled);
  const requireNote =
    input.requireNote === undefined ? Boolean(existing?.require_note) : Boolean(input.requireNote);

  const updated = await tx.query<Record<string, unknown>>(
    `UPDATE approval_policies
        SET threshold_amount = $3::NUMERIC(19,4),
            is_enabled = $4,
            require_note = $5,
            updated_by = $6
      WHERE company_id = $1 AND action_type = $2
      RETURNING id, company_id, action_type, threshold_amount::text AS threshold_amount,
                is_enabled, require_note, created_at::text AS created_at, updated_at::text AS updated_at`,
    [companyId, actionType, formatDecimal4(threshold4), isEnabled, requireNote, actor.userId]
  );

  const policy = mapPolicy(updated.rows[0]);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'APPROVAL_POLICY_UPDATED',
    tableName: 'approval_policies',
    recordId: policy.id,
    oldValues: existing
      ? {
          thresholdAmount: existing.threshold_amount,
          isEnabled: existing.is_enabled,
          requireNote: existing.require_note,
        }
      : null,
    newValues: {
      actionType: policy.action_type,
      thresholdAmount: policy.threshold_amount,
      isEnabled: policy.is_enabled,
      requireNote: policy.require_note,
    },
  });
  return policy;
}

/**
 * Maker-checker gate used by creation routes.
 *
 * - If an approved, unconsumed approvalRequestId is supplied the action is allowed.
 * - If a policy is enabled and amount >= threshold a pending request is created and
 *   the caller must return 202 (no financial document is created yet).
 * - Once the document is created the route calls consumeApprovalRequest().
 */
export async function evaluateApprovalGate(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    actionType: ApprovalActionType;
    entityType: string;
    amount: bigint;
    businessDate?: string | null;
    payload: unknown;
    approvalRequestId?: number | null;
    idempotencyKey?: string | null;
  }
): Promise<ApprovalGateResult> {
  if (input.approvalRequestId !== undefined && input.approvalRequestId !== null) {
    const requestId = Number(input.approvalRequestId);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      throw new AccountingError(400, 'Invalid approvalRequestId', 'INVALID_APPROVAL_REQUEST');
    }
    const reqRes = await tx.query<Record<string, unknown>>(
      `SELECT * FROM approval_requests WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, requestId]
    );
    if (reqRes.rows.length === 0) {
      throw new AccountingError(404, 'Approval request not found', 'APPROVAL_NOT_FOUND');
    }
    const request = mapRequest(reqRes.rows[0]);
    if (request.action_type !== input.actionType) {
      throw new AccountingError(
        409,
        `Approval request #${request.id} is for ${request.action_type}, not ${input.actionType}`,
        'APPROVAL_ACTION_MISMATCH'
      );
    }
    if (request.consumed_at) {
      throw new AccountingError(
        409,
        `Approval request #${request.id} has already been consumed`,
        'APPROVAL_ALREADY_CONSUMED'
      );
    }
    if (request.status === 'pending') {
      throw new AccountingError(
        409,
        `Approval request #${request.id} is still pending approval`,
        'APPROVAL_PENDING'
      );
    }
    if (request.status !== 'approved') {
      throw new AccountingError(
        409,
        `Approval request #${request.id} was ${request.status}`,
        'APPROVAL_NOT_APPROVED'
      );
    }
    return { requiresApproval: false, request };
  }

  await ensureApprovalPolicies(tx, companyId);
  const policyRes = await tx.query<Record<string, unknown>>(
    `SELECT id, action_type, threshold_amount::text AS threshold_amount, is_enabled, require_note
       FROM approval_policies
      WHERE company_id = $1 AND action_type = $2
      LIMIT 1`,
    [companyId, input.actionType]
  );
  const policy = policyRes.rows[0];
  if (!policy || !Boolean(policy.is_enabled)) {
    return { requiresApproval: false, request: null };
  }
  const threshold4 = p4(policy.threshold_amount);
  if (input.amount < threshold4) {
    return { requiresApproval: false, request: null };
  }

  const businessDate = input.businessDate && /^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)
    ? input.businessDate
    : todayIsoDate();
  const payloadHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        actionType: input.actionType,
        entityType: input.entityType,
        amount: formatDecimal4(input.amount),
        businessDate,
        payload: input.payload ?? null,
      })
    )
    .digest('hex');

  const providedKey = input.idempotencyKey?.trim();
  const idempotencyKey = (providedKey || `auto-${payloadHash.slice(0, 56)}`).slice(0, 128);

  const existingRes = await tx.query<Record<string, unknown>>(
    `SELECT * FROM approval_requests
      WHERE company_id = $1 AND action_type = $2 AND idempotency_key = $3
      LIMIT 1`,
    [companyId, input.actionType, idempotencyKey]
  );
  if (existingRes.rows.length > 0) {
    const existing = mapRequest(existingRes.rows[0]);
    if (existing.status === 'pending') {
      return { requiresApproval: true, request: existing };
    }
    if (existing.status === 'approved' && !existing.consumed_at) {
      return { requiresApproval: false, request: existing };
    }
    throw new AccountingError(
      409,
      `Approval request #${existing.id} is ${existing.status}${existing.consumed_at ? ' and already consumed' : ''}`,
      existing.status === 'approved' ? 'APPROVAL_ALREADY_CONSUMED' : 'APPROVAL_NOT_APPROVED'
    );
  }

  const ins = await tx.query<Record<string, unknown>>(
    `INSERT INTO approval_requests (
       company_id, action_type, entity_type, business_date, amount, status,
       requested_by, payload_json, payload_hash, idempotency_key
     ) VALUES (
       $1, $2, $3, $4::DATE, $5::NUMERIC(19,4), 'pending',
       $6, $7::JSONB, $8, $9
     )
     RETURNING *`,
    [
      companyId,
      input.actionType,
      input.entityType,
      businessDate,
      formatDecimal4(input.amount),
      actor.userId,
      JSON.stringify(input.payload ?? {}),
      payloadHash,
      idempotencyKey,
    ]
  );
  const request = mapRequest(ins.rows[0]);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'APPROVAL_REQUESTED',
    tableName: 'approval_requests',
    recordId: request.id,
    newValues: {
      actionType: request.action_type,
      entityType: request.entity_type,
      amount: request.amount,
      businessDate: request.business_date,
    },
  });
  return { requiresApproval: true, request };
}

export async function consumeApprovalRequest(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  requestId: number | null | undefined,
  entityType: string,
  entityId: number
): Promise<void> {
  if (requestId === undefined || requestId === null) return;
  const id = Number(requestId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AccountingError(400, 'Invalid approvalRequestId', 'INVALID_APPROVAL_REQUEST');
  }
  const res = await tx.query<Record<string, unknown>>(
    `UPDATE approval_requests
        SET consumed_at = NOW(),
            consumed_by = $3,
            entity_type = $4,
            entity_id = $5
      WHERE company_id = $1 AND id = $2 AND status = 'approved' AND consumed_at IS NULL
      RETURNING id`,
    [companyId, id, actor.userId, entityType, entityId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(
      409,
      `Approval request #${id} is not approved or was already consumed`,
      'APPROVAL_CONSUME_FAILED'
    );
  }
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'APPROVAL_CONSUMED',
    tableName: 'approval_requests',
    recordId: id,
    newValues: { entityType, entityId },
  });
}

export async function listApprovalRequests(
  tx: Transaction,
  companyId: number,
  status?: ApprovalStatus | 'all'
): Promise<ApprovalRequestRow[]> {
  const statuses: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'cancelled'];
  const filter =
    status && status !== 'all' && statuses.includes(status) ? status : null;
  const res = await tx.query<Record<string, unknown>>(
    `SELECT ar.*,
            ru.display_name AS requested_by_name,
            du.display_name AS decided_by_name
       FROM approval_requests ar
       LEFT JOIN users ru ON ru.id = ar.requested_by
       LEFT JOIN users du ON du.id = ar.decided_by
      WHERE ar.company_id = $1
        AND ($2::TEXT IS NULL OR ar.status = $2)
      ORDER BY
        CASE ar.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
        ar.requested_at DESC,
        ar.id DESC`,
    [companyId, filter]
  );
  return res.rows.map(mapRequest);
}

export async function getApprovalRequest(
  tx: Transaction,
  companyId: number,
  id: number
): Promise<ApprovalRequestRow> {
  const res = await tx.query<Record<string, unknown>>(
    `SELECT ar.*,
            ru.display_name AS requested_by_name,
            du.display_name AS decided_by_name
       FROM approval_requests ar
       LEFT JOIN users ru ON ru.id = ar.requested_by
       LEFT JOIN users du ON du.id = ar.decided_by
      WHERE ar.company_id = $1 AND ar.id = $2
      LIMIT 1`,
    [companyId, id]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Approval request not found', 'APPROVAL_NOT_FOUND');
  }
  return mapRequest(res.rows[0]);
}

function assertCanDecide(request: ApprovalRequestRow, actor: ActorContext): void {
  if (request.status !== 'pending') {
    throw new AccountingError(
      409,
      `Approval request #${request.id} is already ${request.status}`,
      'APPROVAL_NOT_PENDING'
    );
  }
  if (request.requested_by === actor.userId) {
    throw new AccountingError(
      409,
      'Maker-checker violation: the requester cannot approve their own request',
      'SELF_APPROVAL_FORBIDDEN'
    );
  }
}

export async function approveApprovalRequest(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  id: number,
  note?: string | null
): Promise<ApprovalRequestRow> {
  const current = await getApprovalRequest(tx, companyId, id);
  assertCanDecide(current, actor);

  const updated = await tx.query<Record<string, unknown>>(
    `UPDATE approval_requests
        SET status = 'approved',
            decided_by = $3,
            decided_at = NOW(),
            decision_note = $4
      WHERE company_id = $1 AND id = $2 AND status = 'pending'
      RETURNING *`,
    [companyId, id, actor.userId, note?.trim() || null]
  );
  if (updated.rows.length === 0) {
    throw new AccountingError(409, 'Approval request changed while being approved', 'APPROVAL_CONFLICT');
  }
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'APPROVAL_APPROVED',
    tableName: 'approval_requests',
    recordId: id,
    oldValues: { status: current.status },
    newValues: { status: 'approved', note: note?.trim() || null },
  });
  return getApprovalRequest(tx, companyId, id);
}

export async function rejectApprovalRequest(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  id: number,
  note: string
): Promise<ApprovalRequestRow> {
  const trimmedNote = String(note || '').trim();
  if (!trimmedNote) {
    throw new AccountingError(400, 'A rejection note is required', 'REJECTION_NOTE_REQUIRED');
  }
  const current = await getApprovalRequest(tx, companyId, id);
  assertCanDecide(current, actor);

  const updated = await tx.query<Record<string, unknown>>(
    `UPDATE approval_requests
        SET status = 'rejected',
            decided_by = $3,
            decided_at = NOW(),
            decision_note = $4
      WHERE company_id = $1 AND id = $2 AND status = 'pending'
      RETURNING *`,
    [companyId, id, actor.userId, trimmedNote]
  );
  if (updated.rows.length === 0) {
    throw new AccountingError(409, 'Approval request changed while being rejected', 'APPROVAL_CONFLICT');
  }
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'APPROVAL_REJECTED',
    tableName: 'approval_requests',
    recordId: id,
    oldValues: { status: current.status },
    newValues: { status: 'rejected', note: trimmedNote },
  });
  return getApprovalRequest(tx, companyId, id);
}

export async function cancelApprovalRequest(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  id: number
): Promise<ApprovalRequestRow> {
  const current = await getApprovalRequest(tx, companyId, id);
  if (current.status !== 'pending') {
    throw new AccountingError(409, 'Only pending approval requests can be cancelled', 'APPROVAL_NOT_PENDING');
  }
  if (current.requested_by !== actor.userId) {
    throw new AccountingError(403, 'Only the requester can cancel an approval request', 'APPROVAL_CANCEL_FORBIDDEN');
  }
  const updated = await tx.query<Record<string, unknown>>(
    `UPDATE approval_requests
        SET status = 'cancelled',
            decided_by = $3,
            decided_at = NOW(),
            decision_note = 'Cancelled by requester'
      WHERE company_id = $1 AND id = $2 AND status = 'pending'
      RETURNING *`,
    [companyId, id, actor.userId]
  );
  if (updated.rows.length === 0) {
    throw new AccountingError(409, 'Approval request changed while being cancelled', 'APPROVAL_CONFLICT');
  }
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'APPROVAL_CANCELLED',
    tableName: 'approval_requests',
    recordId: id,
    oldValues: { status: current.status },
    newValues: { status: 'cancelled' },
  });
  return getApprovalRequest(tx, companyId, id);
}

export async function hasPendingApprovals(
  tx: Transaction,
  companyId: number,
  startDate?: string,
  endDate?: string
): Promise<{ count: number; amount: string }> {
  const res = await tx.query<{ count: string; amount: string }>(
    `SELECT COUNT(*)::text AS count,
            COALESCE(SUM(amount), 0)::NUMERIC(19,4)::text AS amount
       FROM approval_requests
      WHERE company_id = $1
        AND status = 'pending'
        AND ($2::DATE IS NULL OR business_date >= $2)
        AND ($3::DATE IS NULL OR business_date <= $3)`,
    [companyId, startDate ?? null, endDate ?? null]
  );
  return {
    count: Number(res.rows[0]?.count ?? 0),
    amount: res.rows[0]?.amount ?? '0.0000',
  };
}