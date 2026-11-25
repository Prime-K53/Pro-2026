import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, type ActorContext } from './accountingEngine.ts';
import { checkRouteIdempotency, saveRouteIdempotency } from './commercialHelpers.ts';
import { formatDecimal4, parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import { writeAuditLog } from '../audit.ts';

function assertIsoDate(value: unknown, fallback?: string): string {
  const raw = String(value || '').trim();
  if (!raw) {
    if (fallback) return fallback;
    throw new AccountingError(400, 'date is required', 'INVALID_DATE');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new AccountingError(400, 'date must be YYYY-MM-DD', 'INVALID_DATE');
  return raw;
}

async function nextClaimNumber(tx: Transaction, companyId: number): Promise<string> {
  const res = await tx.query<{ n: string }>(
    `SELECT LPAD((COALESCE(MAX(CASE WHEN claim_number ~ '^EXP-[0-9]+$' THEN SUBSTRING(claim_number FROM 5)::int END), 0) + 1)::text, 6, '0') AS n
       FROM expense_claims WHERE company_id = $1`,
    [companyId]
  );
  return `EXP-${res.rows[0]?.n || '000001'}`;
}

function mapClaim(r: any) {
  return {
    id: Number(r.id),
    claimNumber: r.claim_number,
    claimantUserId: r.claimant_user_id == null ? null : Number(r.claimant_user_id),
    claimantName: r.claimant_name || '',
    claimDate: r.claim_date,
    category: r.category,
    description: r.description || '',
    amount: toMoneyNumber(parseDecimal4(r.amount)),
    currencyCode: r.currency_code || 'ZMW',
    status: r.status,
    submittedAt: r.submitted_at,
    approvedAt: r.approved_at,
    approvedByUserId: r.approved_by_user_id == null ? null : Number(r.approved_by_user_id),
    rejectedAt: r.rejected_at,
    rejectionReason: r.rejection_reason || '',
    reimbursedAt: r.reimbursed_at,
    reimbursementMethod: r.reimbursement_method || '',
    reimbursementRef: r.reimbursement_ref || '',
    expenseAccountId: r.expense_account_id == null ? null : Number(r.expense_account_id),
    bankAccountId: r.bank_account_id == null ? null : Number(r.bank_account_id),
    journalTxnId: r.journal_txn_id == null ? null : Number(r.journal_txn_id),
    receiptAttachmentId: r.receipt_attachment_id == null ? null : Number(r.receipt_attachment_id),
    notes: r.notes || '',
    createdAt: r.created_at,
  };
}

export async function listExpenseClaims(tx: Transaction, companyId: number, filters: { status?: string } = {}) {
  const params: any[] = [companyId];
  let where = 'WHERE company_id = $1';
  if (filters.status) { params.push(String(filters.status)); where += ` AND status = $${params.length}`; }
  const res = await tx.query<any>(
    `SELECT * FROM expense_claims ${where} ORDER BY claim_date DESC, id DESC LIMIT 500`,
    params
  );
  return res.rows.map(mapClaim);
}

export async function getExpenseClaim(tx: Transaction, companyId: number, id: number) {
  const res = await tx.query<any>(`SELECT * FROM expense_claims WHERE company_id = $1 AND id = $2`, [companyId, id]);
  if (res.rows.length === 0) throw new AccountingError(404, 'Expense claim not found', 'EXPENSE_CLAIM_NOT_FOUND');
  return mapClaim(res.rows[0]);
}

export async function createExpenseClaim(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: any
) {
  const amount4 = parseDecimal4(input.amount ?? 0);
  if (amount4 <= 0n) throw new AccountingError(400, 'amount must be greater than zero', 'INVALID_AMOUNT');
  const claimDate = assertIsoDate(input.claimDate || input.date, new Date().toISOString().slice(0, 10));
  const claimNumber = String(input.claimNumber || '').trim() || await nextClaimNumber(tx, companyId);
  const claimantUserId = input.claimantUserId ? Number(input.claimantUserId) : actor.userId;
  const res = await tx.query<any>(
    `INSERT INTO expense_claims (
       company_id, claim_number, claimant_user_id, claimant_name, claim_date, category, description, amount, currency_code,
       status, expense_account_id, receipt_attachment_id, notes, created_by
     ) VALUES ($1,$2,$3,$4,$5::DATE,$6,$7,$8::NUMERIC(19,4),$9,'draft',$10,$11,$12,$13)
     RETURNING *`,
    [
      companyId, claimNumber, claimantUserId, input.claimantName || actor.username, claimDate,
      String(input.category || 'general').trim() || 'general', input.description || null, formatDecimal4(amount4),
      String(input.currencyCode || 'ZMW').trim() || 'ZMW', input.expenseAccountId ? Number(input.expenseAccountId) : null,
      input.receiptAttachmentId ? Number(input.receiptAttachmentId) : null, input.notes || null, actor.userId,
    ]
  );
  const claim = mapClaim(res.rows[0]);
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'EXPENSE_CLAIM_CREATED', tableName: 'expense_claims', recordId: claim.id, newValues: claim });
  return claim;
}

async function requireClaim(tx: Transaction, companyId: number, id: number, forUpdate = true) {
  const res = await tx.query<any>(`SELECT * FROM expense_claims WHERE company_id = $1 AND id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`, [companyId, id]);
  if (res.rows.length === 0) throw new AccountingError(404, 'Expense claim not found', 'EXPENSE_CLAIM_NOT_FOUND');
  return res.rows[0];
}

export async function submitExpenseClaim(tx: Transaction, companyId: number, actor: ActorContext, id: number) {
  const c = await requireClaim(tx, companyId, id);
  if (c.status !== 'draft') throw new AccountingError(409, `Only draft claims can be submitted (current: ${c.status})`, 'INVALID_EXPENSE_STATUS');
  await tx.query(`UPDATE expense_claims SET status='submitted', submitted_at=NOW(), updated_at=NOW() WHERE company_id=$1 AND id=$2`, [companyId, id]);
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'EXPENSE_CLAIM_SUBMITTED', tableName: 'expense_claims', recordId: id, newValues: { status: 'submitted' } });
  return getExpenseClaim(tx, companyId, id);
}

export async function approveExpenseClaim(tx: Transaction, companyId: number, actor: ActorContext, id: number, input: any = {}) {
  const c = await requireClaim(tx, companyId, id);
  if (!['submitted', 'draft'].includes(String(c.status))) throw new AccountingError(409, `Only submitted/draft claims can be approved (current: ${c.status})`, 'INVALID_EXPENSE_STATUS');
  const expenseAccountId = input.expenseAccountId ? Number(input.expenseAccountId) : (c.expense_account_id ? Number(c.expense_account_id) : null);
  await tx.query(
    `UPDATE expense_claims SET status='approved', approved_at=NOW(), approved_by_user_id=$3, expense_account_id=COALESCE($4, expense_account_id), updated_at=NOW()
      WHERE company_id=$1 AND id=$2`,
    [companyId, id, actor.userId, expenseAccountId]
  );
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'EXPENSE_CLAIM_APPROVED', tableName: 'expense_claims', recordId: id, newValues: { status: 'approved', expenseAccountId } });
  return getExpenseClaim(tx, companyId, id);
}

export async function rejectExpenseClaim(tx: Transaction, companyId: number, actor: ActorContext, id: number, reason: string) {
  const c = await requireClaim(tx, companyId, id);
  if (!['submitted', 'draft', 'approved'].includes(String(c.status))) throw new AccountingError(409, `Claim cannot be rejected from status ${c.status}`, 'INVALID_EXPENSE_STATUS');
  const r = String(reason || '').trim();
  if (!r) throw new AccountingError(400, 'reason is required', 'MISSING_REASON');
  await tx.query(
    `UPDATE expense_claims SET status='rejected', rejected_at=NOW(), rejected_by_user_id=$3, rejection_reason=$4, updated_at=NOW()
      WHERE company_id=$1 AND id=$2`,
    [companyId, id, actor.userId, r]
  );
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'EXPENSE_CLAIM_REJECTED', tableName: 'expense_claims', recordId: id, newValues: { status: 'rejected', reason: r } });
  return getExpenseClaim(tx, companyId, id);
}

export async function reimburseExpenseClaim(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  id: number,
  input: any = {}
) {
  const idem = await checkRouteIdempotency<any>(tx, companyId, 'expense_claim_reimburse', input.idempotencyKey, { id, ...input });
  if (idem.hit) return { ...idem.response, idempotentReplay: true };
  const payloadHash = idem.payloadHash;

  const c = await requireClaim(tx, companyId, id);
  if (c.status === 'reimbursed') {
    const claim = mapClaim(c);
    return { claim, idempotentReplay: true };
  }
  if (c.status !== 'approved') throw new AccountingError(409, `Only approved claims can be reimbursed (current: ${c.status})`, 'INVALID_EXPENSE_STATUS');

  const amount4 = parseDecimal4(c.amount);
  const expenseAccountId = input.expenseAccountId ? Number(input.expenseAccountId) : (c.expense_account_id ? Number(c.expense_account_id) : null);
  const bankAccountId = input.bankAccountId ? Number(input.bankAccountId) : null;
  if (!expenseAccountId) throw new AccountingError(400, 'expenseAccountId is required for reimbursement', 'MISSING_EXPENSE_ACCOUNT');
  if (!bankAccountId) throw new AccountingError(400, 'bankAccountId is required for reimbursement', 'MISSING_BANK_ACCOUNT');

  const acctRes = await tx.query<{ id: number }>(
    `SELECT id FROM accounts WHERE company_id = $1 AND id = ANY($2::bigint[]) AND is_active = TRUE`,
    [companyId, [expenseAccountId, bankAccountId]]
  );
  if (acctRes.rows.length !== 2) throw new AccountingError(400, 'expense/bank account not found or inactive', 'INVALID_ACCOUNT');

  const paymentDate = assertIsoDate(input.paymentDate || input.date, new Date().toISOString().slice(0, 10));
  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: paymentDate,
    description: `Expense claim reimbursement ${c.claim_number}`,
    sourceType: 'expense_claim',
    sourceId: id,
    idempotencyKey: `expense-claim-reimburse:${id}`,
    lines: [
      { accountId: expenseAccountId, debit: formatDecimal4(amount4), credit: '0.0000', description: `Expense claim ${c.claim_number}` },
      { accountId: bankAccountId, debit: '0.0000', credit: formatDecimal4(amount4), description: `Reimbursement ${c.claim_number}` },
    ],
  });

  await tx.query(
    `UPDATE expense_claims
        SET status='reimbursed', reimbursed_at=NOW(), reimbursement_method=$3, reimbursement_ref=$4,
            expense_account_id=$5, bank_account_id=$6, journal_txn_id=$7, updated_at=NOW()
      WHERE company_id=$1 AND id=$2`,
    [companyId, id, input.method || null, input.reference || null, expenseAccountId, bankAccountId, posted.transaction.id]
  );

  const claim = await getExpenseClaim(tx, companyId, id);
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'EXPENSE_CLAIM_REIMBURSED', tableName: 'expense_claims', recordId: id, newValues: { status: 'reimbursed', journalTxnId: posted.transaction.id } });
  const response = { claim, journalTxnId: posted.transaction.id };
  await saveRouteIdempotency(tx, companyId, 'expense_claim_reimburse', input.idempotencyKey, payloadHash, 200, response, actor.userId);
  return response;
}
