import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, type ActorContext } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';

export async function listAccountingControlEvents(tx: Transaction, companyId: number, limit = 100) {
  const res = await tx.query<any>(
    `SELECT id, control_type, entity_type, entity_id, severity, message, details_json, created_at
       FROM accounting_control_events WHERE company_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [companyId, Math.max(1, Math.min(500, Number(limit || 100)))]
  );
  return res.rows.map(r => ({ id: Number(r.id), controlType: r.control_type, entityType: r.entity_type, entityId: r.entity_id == null ? null : Number(r.entity_id), severity: r.severity, message: r.message, details: r.details_json || {}, createdAt: r.created_at }));
}

export async function logAccountingControlEvent(tx: Transaction, companyId: number, actor: ActorContext, input: { controlType: string; entityType?: string | null; entityId?: number | null; severity?: 'info'|'warning'|'error'; message: string; details?: any }) {
  const controlType = String(input.controlType || '').trim();
  if (!controlType) throw new AccountingError(400, 'controlType is required', 'INVALID_CONTROL');
  const ins = await tx.query<any>(
    `INSERT INTO accounting_control_events (company_id, control_type, entity_type, entity_id, severity, message, details_json, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id, created_at`,
    [companyId, controlType, input.entityType || null, input.entityId ?? null, input.severity || 'info', String(input.message || '').trim(), JSON.stringify(input.details || {}), actor.userId]
  );
  return { id: Number(ins.rows[0].id), createdAt: ins.rows[0].created_at };
}

export async function setJournalApprovalStatus(tx: Transaction, companyId: number, actor: ActorContext, journalTxnId: number, status: 'draft'|'pending_approval'|'approved'|'rejected', reason?: string | null) {
  const res = await tx.query<any>(
    `UPDATE journal_transactions
        SET approval_status=$3::text,
            approved_by=CASE WHEN $3::text='approved' THEN $4 ELSE approved_by END,
            approved_at=CASE WHEN $3::text='approved' THEN NOW() ELSE approved_at END,
            reversal_reason=COALESCE($5, reversal_reason)
      WHERE company_id=$1 AND id=$2 RETURNING id, approval_status`,
    [companyId, journalTxnId, status, actor.userId, reason || null]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Journal transaction not found', 'NOT_FOUND');
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'JOURNAL_APPROVAL_STATUS_SET', tableName: 'journal_transactions', recordId: journalTxnId, newValues: { approvalStatus: status, reason: reason || null } });
  return { id: Number(res.rows[0].id), approvalStatus: res.rows[0].approval_status };
}
