import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, type ActorContext } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';

export async function listTaxFilingPeriods(tx: Transaction, companyId: number) {
  const res = await tx.query<any>(`SELECT * FROM tax_filing_periods WHERE company_id=$1 ORDER BY period_end DESC, id DESC`, [companyId]);
  return res.rows.map(r => ({ id: Number(r.id), jurisdiction: r.jurisdiction, periodStart: r.period_start, periodEnd: r.period_end, dueDate: r.due_date, status: r.status, reference: r.reference || '', notes: r.notes || '', filedAt: r.filed_at }));
}
export async function upsertTaxFilingPeriod(tx: Transaction, companyId: number, actor: ActorContext, input: any) {
  const jurisdiction = String(input.jurisdiction || 'ZRA').trim() || 'ZRA';
  const periodStart = String(input.periodStart || '').slice(0, 10);
  const periodEnd = String(input.periodEnd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) throw new AccountingError(400, 'periodStart/periodEnd must be YYYY-MM-DD', 'INVALID_DATE');
  if (input.id) {
    const res = await tx.query<any>(`UPDATE tax_filing_periods SET jurisdiction=$3, period_start=$4::date, period_end=$5::date, due_date=$6::date, status=$7, reference=$8, notes=$9, updated_at=NOW() WHERE company_id=$1 AND id=$2 RETURNING id`, [companyId, Number(input.id), jurisdiction, periodStart, periodEnd, input.dueDate || null, String(input.status || 'open'), input.reference || null, input.notes || null]);
    if (res.rows.length === 0) throw new AccountingError(404, 'Filing period not found', 'NOT_FOUND');
    return { id: Number(res.rows[0].id) };
  }
  const ins = await tx.query<any>(`INSERT INTO tax_filing_periods (company_id, jurisdiction, period_start, period_end, due_date, status, reference, notes) VALUES ($1,$2,$3::date,$4::date,$5::date,$6,$7,$8) RETURNING id`, [companyId, jurisdiction, periodStart, periodEnd, input.dueDate || null, String(input.status || 'open'), input.reference || null, input.notes || null]);
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'TAX_FILING_PERIOD_SAVED', tableName: 'tax_filing_periods', recordId: Number(ins.rows[0].id), newValues: { jurisdiction, periodStart, periodEnd } });
  return { id: Number(ins.rows[0].id) };
}
export async function markTaxFilingPeriodFiled(tx: Transaction, companyId: number, actor: ActorContext, id: number, reference?: string | null) {
  const res = await tx.query<any>(`UPDATE tax_filing_periods SET status='filed', filed_at=NOW(), filed_by=$3, reference=COALESCE($4, reference), updated_at=NOW() WHERE company_id=$1 AND id=$2 RETURNING id`, [companyId, id, actor.userId, reference || null]);
  if (res.rows.length === 0) throw new AccountingError(404, 'Filing period not found', 'NOT_FOUND');
  return { id: Number(res.rows[0].id), status: 'filed' };
}
export async function listTaxAccountMappings(tx: Transaction, companyId: number) {
  const res = await tx.query<any>(`SELECT m.*, a.code, a.name FROM tax_account_mappings m JOIN accounts a ON a.company_id=m.company_id AND a.id=m.account_id WHERE m.company_id=$1 ORDER BY m.jurisdiction, m.tax_box, m.id`, [companyId]);
  return res.rows.map(r => ({ id: Number(r.id), jurisdiction: r.jurisdiction, taxBox: r.tax_box, accountId: Number(r.account_id), accountCode: r.code, accountName: r.name, direction: r.direction, isActive: Boolean(r.is_active) }));
}
export async function upsertTaxAccountMapping(tx: Transaction, companyId: number, actor: ActorContext, input: any) {
  const taxBox = String(input.taxBox || '').trim();
  const accountId = Number(input.accountId);
  if (!taxBox || !Number.isInteger(accountId) || accountId <= 0) throw new AccountingError(400, 'taxBox and accountId are required', 'INVALID_MAPPING');
  if (input.id) {
    const res = await tx.query<any>(`UPDATE tax_account_mappings SET jurisdiction=$3, tax_box=$4, account_id=$5, direction=$6, is_active=$7 WHERE company_id=$1 AND id=$2 RETURNING id`, [companyId, Number(input.id), String(input.jurisdiction || 'ZRA'), taxBox, accountId, String(input.direction || 'both'), input.isActive !== false]);
    if (res.rows.length === 0) throw new AccountingError(404, 'Mapping not found', 'NOT_FOUND');
    return { id: Number(res.rows[0].id) };
  }
  const ins = await tx.query<any>(`INSERT INTO tax_account_mappings (company_id, jurisdiction, tax_box, account_id, direction, is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [companyId, String(input.jurisdiction || 'ZRA'), taxBox, accountId, String(input.direction || 'both'), input.isActive !== false]);
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'TAX_ACCOUNT_MAPPING_SAVED', tableName: 'tax_account_mappings', recordId: Number(ins.rows[0].id), newValues: { taxBox, accountId } });
  return { id: Number(ins.rows[0].id) };
}
