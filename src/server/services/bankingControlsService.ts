import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, type ActorContext } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';

export async function listBankReconciliationRules(tx: Transaction, companyId: number) {
  const res = await tx.query<any>(`SELECT * FROM bank_reconciliation_rules WHERE company_id = $1 ORDER BY id DESC`, [companyId]);
  return res.rows.map(r => ({ id: Number(r.id), ruleName: r.rule_name, matchField: r.match_field, matchPattern: r.match_pattern, targetAccountId: r.target_account_id == null ? null : Number(r.target_account_id), autoPost: Boolean(r.auto_post), isActive: Boolean(r.is_active) }));
}

export async function upsertBankReconciliationRule(tx: Transaction, companyId: number, actor: ActorContext, input: any) {
  const ruleName = String(input.ruleName || '').trim();
  const matchPattern = String(input.matchPattern || '').trim();
  if (!ruleName || !matchPattern) throw new AccountingError(400, 'ruleName and matchPattern are required', 'INVALID_RULE');
  if (input.id) {
    const res = await tx.query<any>(
      `UPDATE bank_reconciliation_rules SET rule_name=$3, match_field=$4, match_pattern=$5, target_account_id=$6, auto_post=$7, is_active=$8, updated_at=NOW()
        WHERE company_id=$1 AND id=$2 RETURNING *`,
      [companyId, Number(input.id), ruleName, String(input.matchField || 'description'), matchPattern, input.targetAccountId ? Number(input.targetAccountId) : null, Boolean(input.autoPost), input.isActive !== false]
    );
    if (res.rows.length === 0) throw new AccountingError(404, 'Rule not found', 'RULE_NOT_FOUND');
    return { id: Number(res.rows[0].id) };
  }
  const ins = await tx.query<any>(
    `INSERT INTO bank_reconciliation_rules (company_id, rule_name, match_field, match_pattern, target_account_id, auto_post, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [companyId, ruleName, String(input.matchField || 'description'), matchPattern, input.targetAccountId ? Number(input.targetAccountId) : null, Boolean(input.autoPost), input.isActive !== false, actor.userId]
  );
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'BANK_RECON_RULE_CREATED', tableName: 'bank_reconciliation_rules', recordId: Number(ins.rows[0].id), newValues: { ruleName } });
  return { id: Number(ins.rows[0].id) };
}

export async function exportBankReconciliationRules(tx: Transaction, companyId: number) {
  const rules = await listBankReconciliationRules(tx, companyId);
  return { format: 'json', rules };
}

export async function importBankReconciliationRules(tx: Transaction, companyId: number, actor: ActorContext, rules: any[]) {
  if (!Array.isArray(rules)) throw new AccountingError(400, 'rules must be an array', 'INVALID_RULES');
  let imported = 0;
  for (const r of rules) { await upsertBankReconciliationRule(tx, companyId, actor, r); imported++; }
  return { imported };
}

export async function getBankGlDrilldown(tx: Transaction, companyId: number, bankAccountId: number, limit = 100) {
  const res = await tx.query<any>(
    `SELECT bt.id, bt.txn_date::text AS txn_date, bt.description, bt.amount::text, bt.status, bt.journal_txn_id,
            jt.entry_number, jt.description AS journal_description
       FROM bank_transactions bt
       LEFT JOIN journal_transactions jt ON jt.company_id = bt.company_id AND jt.id = bt.journal_txn_id
      WHERE bt.company_id = $1 AND bt.bank_account_id = $2
      ORDER BY bt.txn_date DESC, bt.id DESC LIMIT $3`,
    [companyId, bankAccountId, Math.max(1, Math.min(500, Number(limit || 100)))]
  );
  return res.rows.map(r => ({ id: Number(r.id), txnDate: r.txn_date, description: r.description || '', amount: r.amount, status: r.status, journalTxnId: r.journal_txn_id == null ? null : Number(r.journal_txn_id), entryNumber: r.entry_number || null, journalDescription: r.journal_description || null }));
}
