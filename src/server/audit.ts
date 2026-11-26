import crypto from 'node:crypto';
import { SqlExecutor } from '../../db/migrator.ts';

export interface AuditEntryInput {
  companyId: number;
  actorUserId?: number | null;
  actorUsername?: string | null;
  action: string;
  tableName: string;
  recordId: number;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  changedFields?: string[];
  source?: string;
}

export async function writeAuditLog(db: SqlExecutor, entry: AuditEntryInput): Promise<void> {
  const payload = JSON.stringify({
    companyId: entry.companyId,
    actorUserId: entry.actorUserId ?? null,
    actorUsername: entry.actorUsername ?? null,
    action: entry.action,
    tableName: entry.tableName,
    recordId: entry.recordId,
    oldValues: entry.oldValues ?? null,
    newValues: entry.newValues ?? null,
    changedFields: entry.changedFields ?? [],
    ts: new Date().toISOString(),
  });

  // Chain to the previous row (per company) so tampering is detectable.
  const prevRes = await db.query<{ sha256_hash: string }>(
    `SELECT sha256_hash FROM audit_log WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
    [entry.companyId]
  );
  const prevHash = prevRes.rows[0]?.sha256_hash || null;
  const sha256Hash = crypto
    .createHash('sha256')
    .update(`${prevHash || ''}${payload}`, 'utf8')
    .digest('hex');

  await db.query(
    `INSERT INTO audit_log (
       company_id, actor_user_id, actor_username, action, table_name, record_id,
       old_values, new_values, changed_fields, sha256_hash, prev_hash, source
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::text[], $10, $11, $12)`,
    [
      entry.companyId,
      entry.actorUserId ?? null,
      entry.actorUsername ?? 'system',
      entry.action,
      entry.tableName,
      entry.recordId,
      entry.oldValues ? JSON.stringify(entry.oldValues) : null,
      entry.newValues ? JSON.stringify(entry.newValues) : null,
      entry.changedFields ?? [],
      sha256Hash,
      prevHash,
      entry.source ?? 'api',
    ]
  );
}

export async function recordLoginAttempt(
  db: SqlExecutor,
  params: { username: string; ipAddress: string; userAgent: string; success: boolean }
): Promise<void> {
  await db.query(
    `INSERT INTO login_attempts (username, ip_address, user_agent, success)
     VALUES ($1, $2, $3, $4)`,
    [params.username.slice(0, 100), params.ipAddress.slice(0, 64), params.userAgent.slice(0, 500), params.success]
  );
}
