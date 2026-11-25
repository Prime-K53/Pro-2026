import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, type ActorContext } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';

export async function listDocumentVersions(tx: Transaction, companyId: number, entityType: string, entityId: number) {
  const res = await tx.query<any>(
    `SELECT a.id, a.entity_type, a.entity_id, a.version_no, a.is_current, a.supersedes_attachment_id, a.retention_until,
            a.approval_status, a.approved_by, a.approved_at, a.created_at,
            sf.original_name, sf.content_type, sf.size_bytes
       FROM attachments a
       JOIN stored_files sf ON sf.company_id = a.company_id AND sf.id = a.stored_file_id
      WHERE a.company_id=$1 AND a.entity_type=$2 AND a.entity_id=$3
      ORDER BY a.version_no DESC, a.id DESC`,
    [companyId, String(entityType), Number(entityId)]
  );
  return res.rows.map(r => ({ id: Number(r.id), entityType: r.entity_type, entityId: Number(r.entity_id), filename: r.original_name, mimeType: r.content_type, sizeBytes: Number(r.size_bytes || 0), versionNo: Number(r.version_no || 1), isCurrent: Boolean(r.is_current), supersedesAttachmentId: r.supersedes_attachment_id == null ? null : Number(r.supersedes_attachment_id), retentionUntil: r.retention_until, approvalStatus: r.approval_status, approvedBy: r.approved_by == null ? null : Number(r.approved_by), approvedAt: r.approved_at, createdAt: r.created_at }));
}

export async function approveDocument(tx: Transaction, companyId: number, actor: ActorContext, attachmentId: number, approved: boolean, reason?: string | null) {
  const res = await tx.query<any>(
    `UPDATE attachments
        SET approval_status=$3::text,
            approved_by=$4,
            approved_at=CASE WHEN $3::text='approved' THEN NOW() ELSE NULL END
      WHERE company_id=$1 AND id=$2 RETURNING id, approval_status`,
    [companyId, attachmentId, approved ? 'approved' : 'rejected', actor.userId]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Attachment not found', 'NOT_FOUND');
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: approved ? 'DOCUMENT_APPROVED' : 'DOCUMENT_REJECTED', tableName: 'attachments', recordId: attachmentId, newValues: { approvalStatus: res.rows[0].approval_status, reason: reason || null } });
  return { id: Number(res.rows[0].id), approvalStatus: res.rows[0].approval_status };
}

export async function setDocumentRetention(tx: Transaction, companyId: number, actor: ActorContext, attachmentId: number, retentionUntil: string | null) {
  const res = await tx.query<any>(`UPDATE attachments SET retention_until=$3::date WHERE company_id=$1 AND id=$2 RETURNING id, retention_until`, [companyId, attachmentId, retentionUntil]);
  if (res.rows.length === 0) throw new AccountingError(404, 'Attachment not found', 'NOT_FOUND');
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'DOCUMENT_RETENTION_SET', tableName: 'attachments', recordId: attachmentId, newValues: { retentionUntil } });
  return { id: Number(res.rows[0].id), retentionUntil: res.rows[0].retention_until };
}
