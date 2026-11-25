import type { Transaction } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { AccountingError, type ActorContext } from './accountingEngine.ts';

export async function createReportExportSnapshot(tx: Transaction, companyId: number, actor: ActorContext, input: { reportKey: string; parameters?: any; rowCount?: number; deliveryTarget?: string | null }) {
  const reportKey = String(input.reportKey || '').trim();
  if (!reportKey) throw new AccountingError(400, 'reportKey is required', 'INVALID_REPORT_KEY');
  const params = input.parameters && typeof input.parameters === 'object' ? input.parameters : {};
  const hash = crypto.createHash('sha256').update(JSON.stringify({ reportKey, params })).digest('hex');
  const existing = await tx.query<any>(`SELECT id, status, generated_at, row_count FROM report_export_snapshots WHERE company_id=$1 AND report_key=$2 AND parameters_hash=$3`, [companyId, reportKey, hash]);
  if (existing.rows.length > 0) {
    const r = existing.rows[0];
    return { id: Number(r.id), reportKey, parametersHash: hash, status: r.status, rowCount: Number(r.row_count), generatedAt: r.generated_at, idempotentReplay: true };
  }
  const ins = await tx.query<any>(
    `INSERT INTO report_export_snapshots (company_id, report_key, parameters_hash, parameters_json, generated_by, row_count, status, delivery_target)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING id, generated_at, status, row_count`,
    [companyId, reportKey, hash, JSON.stringify(params), actor.userId, Number(input.rowCount || 0), 'generated', input.deliveryTarget || null]
  );
  const r = ins.rows[0];
  return { id: Number(r.id), reportKey, parametersHash: hash, status: r.status, rowCount: Number(r.row_count), generatedAt: r.generated_at, idempotentReplay: false };
}

export async function listReportExportSnapshots(tx: Transaction, companyId: number, reportKey?: string) {
  const params: any[] = [companyId];
  let where = 'WHERE company_id=$1';
  if (reportKey) { params.push(String(reportKey)); where += ` AND report_key=$${params.length}`; }
  const res = await tx.query<any>(`SELECT id, report_key, parameters_hash, row_count, status, delivery_target, generated_at, error_message FROM report_export_snapshots ${where} ORDER BY generated_at DESC, id DESC LIMIT 200`, params);
  return res.rows.map(r => ({ id: Number(r.id), reportKey: r.report_key, parametersHash: r.parameters_hash, rowCount: Number(r.row_count), status: r.status, deliveryTarget: r.delivery_target || null, generatedAt: r.generated_at, errorMessage: r.error_message || null }));
}
