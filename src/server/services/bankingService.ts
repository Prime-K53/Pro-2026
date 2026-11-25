import { Transaction } from '@electric-sql/pglite';
import {
  AccountingError,
  ActorContext,
  JournalLineInput,
  postJournalEntry,
  reverseJournalEntry,
} from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal2, formatDecimal4, parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import {
  assertIsoDate,
  checkRouteIdempotency,
  generateNextDocNumber,
  resolveCommercialContext,
  saveRouteIdempotency,
  todayIsoDate,
} from './commercialHelpers.ts';

// ============================================================================
// BANK & CASH ACCOUNTS
// ============================================================================

export async function listBankAccounts(tx: Transaction, companyId: number) {
  const res = await tx.query<{
    id: number;
    gl_account_id: number;
    account_code: string | null;
    account_name: string;
    account_type: string;
    institution_name: string;
    account_mask: string | null;
    feed_provider: string;
    last_synced_at: string | null;
    next_check_number: number;
    gl_balance: string;
    is_active: boolean;
  }>(
    `SELECT ba.id, ba.gl_account_id, a.code AS account_code, a.name AS account_name,
            a.account_type, ba.institution_name, ba.account_mask, ba.feed_provider,
            ba.last_synced_at::text, ba.next_check_number,
            COALESCE(a.balance, 0)::NUMERIC(19,4)::text AS gl_balance,
            ba.is_active
       FROM bank_accounts ba
       JOIN accounts a ON a.company_id = ba.company_id AND a.id = ba.gl_account_id
      WHERE ba.company_id = $1 AND ba.is_active = TRUE
      ORDER BY a.code ASC NULLS LAST, ba.id ASC`,
    [companyId]
  );

  // Count pending bank feed imports per account
  const pendingRes = await tx.query<{ account_id: number; cnt: string }>(
    `SELECT account_id, COUNT(*)::text AS cnt
       FROM bank_transactions
      WHERE company_id = $1 AND status = 'pending_import'
      GROUP BY account_id`,
    [companyId]
  );
  const pendingMap = new Map<number, number>();
  for (const p of pendingRes.rows) pendingMap.set(Number(p.account_id), Number(p.cnt));

  return res.rows.map(r => ({
    id: Number(r.id),
    glAccountId: Number(r.gl_account_id),
    accountCode: r.account_code || '',
    accountName: r.account_name,
    accountType: r.account_type,
    institutionName: r.institution_name,
    accountMask: r.account_mask || '',
    feedProvider: r.feed_provider,
    lastSyncedAt: r.last_synced_at,
    nextCheckNumber: Number(r.next_check_number),
    glBalance: toMoneyNumber(parseDecimal4(r.gl_balance)),
    glBalanceStr: r.gl_balance,
    pendingImportCount: pendingMap.get(Number(r.gl_account_id)) ?? 0,
    isActive: Boolean(r.is_active),
  }));
}

export async function linkBankAccount(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    glAccountId: number;
    institutionName: string;
    accountMask?: string | null;
    feedProvider?: 'manual' | 'simplefin' | 'mercury' | 'ofx' | 'csv';
    nextCheckNumber?: number;
  }
) {
  const glAccountId = Number(input.glAccountId);
  const acctRes = await tx.query<{ id: number; name: string; account_type: string }>(
    `SELECT id, name, account_type FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, glAccountId]
  );
  if (acctRes.rows.length === 0) throw new AccountingError(404, 'GL account not found');
  const acct = acctRes.rows[0];
  if (acct.account_type !== 'Bank' && acct.account_type !== 'CreditCard') {
    throw new AccountingError(400, 'Bank register must link to a Bank or CreditCard GL account');
  }

  const institutionName = String(input.institutionName || acct.name).trim();
  const nextCheck = Math.max(1, Number(input.nextCheckNumber || 1001));
  const provider = input.feedProvider || 'manual';

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO bank_accounts (
       company_id, gl_account_id, institution_name, account_mask, feed_provider, next_check_number
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id, gl_account_id)
     DO UPDATE SET institution_name = EXCLUDED.institution_name,
                   account_mask = EXCLUDED.account_mask,
                   feed_provider = EXCLUDED.feed_provider,
                   is_active = TRUE
     RETURNING id`,
    [companyId, glAccountId, institutionName, input.accountMask?.trim() || null, provider, nextCheck]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BANK_ACCOUNT_LINKED',
    tableName: 'bank_accounts',
    recordId: Number(ins.rows[0].id),
    newValues: { glAccountId, institutionName, provider },
  });

  const all = await listBankAccounts(tx, companyId);
  return all.find(b => b.id === Number(ins.rows[0].id))!;
}

// ============================================================================
// BANK REGISTER QUERIES & CLEARING
// ============================================================================

export async function listBankTransactions(
  tx: Transaction,
  companyId: number,
  filters?: { accountId?: number; status?: string; isCleared?: boolean }
) {
  const conds: string[] = ['bt.company_id = $1'];
  const params: any[] = [companyId];
  let idx = 2;

  if (filters?.accountId) {
    conds.push(`bt.account_id = $${idx++}`);
    params.push(Number(filters.accountId));
  }
  if (filters?.status) {
    conds.push(`bt.status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters?.isCleared !== undefined) {
    conds.push(`bt.is_cleared = $${idx++}`);
    params.push(filters.isCleared);
  }

  const res = await tx.query<any>(
    `SELECT bt.id, bt.account_id, a.name AS account_name, bt.bank_account_id,
            bt.txn_date::text, bt.payee, bt.txn_type, bt.ref_number, bt.memo,
            bt.amount::text, bt.is_cleared, bt.status, bt.reconciliation_id,
            bt.journal_txn_id, bt.external_fitid, bt.category, bt.offset_account_id,
            oa.name AS offset_account_name, bt.transfer_pair_txn_id, bt.matched_rule_id,
            bt.vendor_id, bt.customer_id,
            cd.check_number AS cd_check_number, cd.print_later, cd.printed_at::text
       FROM bank_transactions bt
       JOIN accounts a ON a.company_id = bt.company_id AND a.id = bt.account_id
       LEFT JOIN accounts oa ON oa.company_id = bt.company_id AND oa.id = bt.offset_account_id
       LEFT JOIN bank_check_details cd ON cd.company_id = bt.company_id AND cd.bank_txn_id = bt.id
      WHERE ${conds.join(' AND ')}
      ORDER BY bt.txn_date ASC, bt.id ASC`,
    params
  );

  // Compute per-account running balance on posted transactions
  const runningByAcct = new Map<number, bigint>();
  const rows = res.rows.map((r: any) => {
    const acctId = Number(r.account_id);
    const amt4 = parseDecimal4(r.amount);
    let running4 = runningByAcct.get(acctId) ?? 0n;
    if (r.status === 'posted') {
      running4 += amt4;
      runningByAcct.set(acctId, running4);
    }
    return {
      id: Number(r.id),
      accountId: acctId,
      accountName: r.account_name,
      bankAccountId: r.bank_account_id !== null ? Number(r.bank_account_id) : null,
      date: r.txn_date,
      payee: r.payee,
      type: r.txn_type,
      refNumber: r.ref_number || '',
      memo: r.memo || '',
      amount: toMoneyNumber(amt4),
      amountStr: r.amount,
      runningBalance: toMoneyNumber(running4),
      cleared: Boolean(r.is_cleared),
      status: r.status,
      reconciliationId: r.reconciliation_id !== null ? Number(r.reconciliation_id) : null,
      journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
      externalFitid: r.external_fitid || null,
      category: r.category || '',
      offsetAccountId: r.offset_account_id !== null ? Number(r.offset_account_id) : null,
      offsetAccountName: r.offset_account_name || '',
      transferPairTxnId: r.transfer_pair_txn_id !== null ? Number(r.transfer_pair_txn_id) : null,
      matchedRuleId: r.matched_rule_id !== null ? Number(r.matched_rule_id) : null,
      checkNumber: r.cd_check_number || '',
      printLater: Boolean(r.print_later),
      printedAt: r.printed_at || null,
    };
  });

  // Return newest first while keeping chronological runningBalance attached
  return rows.reverse();
}

// ============================================================================
// CHECKS, EXPENSES & CREDIT CARD CHARGES
// ============================================================================

export async function recordCheckOrExpense(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    bankGlAccountId?: number;
    txnDate?: string;
    payee: string;
    txnType?: 'Check' | 'Debit' | 'Fee' | 'Credit Card Charge';
    checkNumber?: string | null;
    printLater?: boolean;
    payeeAddress?: string | null;
    vendorId?: number | null;
    memo?: string | null;
    idempotencyKey?: string | null;
    lines: Array<{
      accountId: number;
      amount: string | number;
      memo?: string | null;
      classId?: number | null;
    }>;
  }
) {
  const idem = await checkRouteIdempotency<{ transaction: any }>(
    tx,
    companyId,
    'bank_expense_create',
    input.idempotencyKey,
    input
  );
  if (idem.hit) return { transaction: idem.response.transaction, idempotentReplay: true };

  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const bankGlAccountId = input.bankGlAccountId ? Number(input.bankGlAccountId) : ctx.bank1010;
  const acctRes = await tx.query<{ id: number; name: string; account_type: string }>(
    `SELECT id, name, account_type FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, bankGlAccountId]
  );
  if (acctRes.rows.length === 0) throw new AccountingError(404, 'Bank/CreditCard account not found');
  const bankAcct = acctRes.rows[0];
  if (bankAcct.account_type !== 'Bank' && bankAcct.account_type !== 'CreditCard') {
    throw new AccountingError(400, 'Payment source account must be of type Bank or CreditCard');
  }

  const txnDate = input.txnDate ? assertIsoDate(input.txnDate, 'txnDate') : todayIsoDate();
  const payee = String(input.payee || '').trim();
  if (!payee) throw new AccountingError(400, 'Payee is required');
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'At least one expense/asset split line is required');
  }

  const txnType =
    input.txnType ||
    (bankAcct.account_type === 'CreditCard' ? 'Credit Card Charge' : 'Check');

  let total4 = 0n;
  const jeLines: JournalLineInput[] = [];
  let primaryOffsetId: number | null = null;
  let primaryCategory = '';

  for (const l of input.lines) {
    const amt4 = parseDecimal4(l.amount);
    if (amt4 <= 0n) throw new AccountingError(400, 'Split line amount must be greater than zero');
    const expRes = await tx.query<{ id: number; name: string }>(
      `SELECT id, name FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, Number(l.accountId)]
    );
    if (expRes.rows.length === 0) throw new AccountingError(404, `Offset account ${l.accountId} not found`);

    if (!primaryOffsetId) {
      primaryOffsetId = Number(expRes.rows[0].id);
      primaryCategory = expRes.rows[0].name;
    }

    total4 += amt4;
    jeLines.push({
      accountId: Number(expRes.rows[0].id),
      debit: formatDecimal4(amt4),
      credit: '0.0000',
      description: l.memo?.trim() || `${txnType} — ${payee}`,
      partyType: input.vendorId ? 'vendor' : null,
      partyId: input.vendorId ? Number(input.vendorId) : null,
      classId: l.classId ? Number(l.classId) : null,
    });
  }

  const baRes = await tx.query<{ id: number; next_check_number: number }>(
    `SELECT id, next_check_number FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 FOR UPDATE`,
    [companyId, bankGlAccountId]
  );

  let checkNumber = input.checkNumber?.trim() || null;
  if (txnType === 'Check' && !checkNumber && baRes.rows.length > 0) {
    checkNumber = String(baRes.rows[0].next_check_number);
    await tx.query(
      `UPDATE bank_accounts SET next_check_number = next_check_number + 1 WHERE company_id = $1 AND id = $2`,
      [companyId, baRes.rows[0].id]
    );
  }

  const refNumber = checkNumber || (await generateNextDocNumber(tx, companyId, 'bank_transactions', 'ref_number', 'EXP'));

  jeLines.push({
    accountId: bankGlAccountId,
    debit: '0.0000',
    credit: formatDecimal4(total4),
    description: `${txnType} ${refNumber} — ${payee}`,
  });

  const sourceType =
    txnType === 'Check'
      ? 'check'
      : txnType === 'Credit Card Charge'
      ? 'credit_card_charge'
      : 'expense';

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate,
    description: `${txnType} ${refNumber} — ${payee}`,
    reference: refNumber,
    sourceType,
    idempotencyKey: `${routeIdKey(input.idempotencyKey, refNumber)}-je`,
    lines: jeLines,
  });

  const btIns = await tx.query<{ id: number }>(
    `INSERT INTO bank_transactions (
       company_id, account_id, bank_account_id, txn_date, payee, txn_type,
       ref_number, memo, amount, is_cleared, status, offset_account_id,
       journal_txn_id, vendor_id, category
     ) VALUES (
       $1, $2, $3, $4::DATE, $5, $6,
       $7, $8, $9::NUMERIC(19,4), FALSE, 'posted', $10,
       $11, $12, $13
     ) RETURNING id`,
    [
      companyId,
      bankGlAccountId,
      baRes.rows[0] ? Number(baRes.rows[0].id) : null,
      txnDate,
      payee,
      txnType,
      refNumber,
      input.memo?.trim() || null,
      formatDecimal4(-total4),
      primaryOffsetId,
      postedJe.transaction.id,
      input.vendorId ? Number(input.vendorId) : null,
      input.lines.length > 1 ? 'Split Expense' : primaryCategory,
    ]
  );
  const bankTxnId = Number(btIns.rows[0].id);

  if (txnType === 'Check') {
    await tx.query(
      `INSERT INTO bank_check_details (company_id, bank_txn_id, check_number, print_later, payee_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, bankTxnId, checkNumber, Boolean(input.printLater), input.payeeAddress?.trim() || null]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: txnType === 'Check' ? 'CHECK_POSTED' : 'BANK_EXPENSE_POSTED',
    tableName: 'bank_transactions',
    recordId: bankTxnId,
    newValues: { txnType, refNumber, payee, amount: formatDecimal4(total4), journalTxnId: postedJe.transaction.id },
  });

  const all = await listBankTransactions(tx, companyId, { accountId: bankGlAccountId });
  const created = all.find(t => t.id === bankTxnId)!;
  await saveRouteIdempotency(
    tx,
    companyId,
    'bank_expense_create',
    input.idempotencyKey,
    idem.payloadHash,
    201,
    { transaction: created },
    actor.userId
  );

  return { transaction: created, idempotentReplay: false };
}

export async function markChecksPrinted(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  bankTxnIds: number[]
) {
  if (!Array.isArray(bankTxnIds) || bankTxnIds.length === 0) {
    throw new AccountingError(400, 'At least one check transaction id is required');
  }
  await tx.query(
    `UPDATE bank_check_details
        SET print_later = FALSE,
            printed_at = NOW()
      WHERE company_id = $1 AND bank_txn_id = ANY($2::BIGINT[])`,
    [companyId, bankTxnIds.map(Number)]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CHECKS_PRINTED',
    tableName: 'bank_check_details',
    recordId: Number(bankTxnIds[0]),
    newValues: { printedIds: bankTxnIds },
  });
  return { printedCount: bankTxnIds.length };
}

// ============================================================================
// BANK DEPOSITS & INTER-ACCOUNT TRANSFERS
// ============================================================================

export async function recordDeposit(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    bankGlAccountId?: number;
    txnDate?: string;
    receivedFrom?: string;
    memo?: string | null;
    idempotencyKey?: string | null;
    paymentIds?: number[];
    salesReceiptIds?: number[];
    lines?: Array<{
      accountId: number;
      amount: string | number;
      customerId?: number | null;
      vendorId?: number | null;
      classId?: number | null;
      memo?: string | null;
    }>;
  }
) {
  const idem = await checkRouteIdempotency<{ transaction: any }>(
    tx,
    companyId,
    'bank_deposit_create',
    input.idempotencyKey,
    input
  );
  if (idem.hit) return { transaction: idem.response.transaction, idempotentReplay: true };

  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const bankGlAccountId = input.bankGlAccountId ? Number(input.bankGlAccountId) : ctx.bank1010;
  const bankChk = await tx.query<{ id: number; account_type: string }>(
    `SELECT id, account_type FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, bankGlAccountId]
  );
  if (bankChk.rows.length === 0 || bankChk.rows[0].account_type !== 'Bank') {
    throw new AccountingError(400, 'Deposit target must be an active Bank GL account');
  }

  const paymentIds = Array.isArray(input.paymentIds) ? [...new Set(input.paymentIds.map(Number).filter(n => n > 0))] : [];
  const salesReceiptIds = Array.isArray(input.salesReceiptIds)
    ? [...new Set(input.salesReceiptIds.map(Number).filter(n => n > 0))]
    : [];
  const manualLines = Array.isArray(input.lines) ? input.lines : [];

  if (manualLines.length === 0 && paymentIds.length === 0 && salesReceiptIds.length === 0) {
    throw new AccountingError(400, 'Deposit requires at least one source line, paymentId, or salesReceiptId');
  }

  const txnDate = input.txnDate ? assertIsoDate(input.txnDate, 'txnDate') : todayIsoDate();
  let total4 = 0n;
  const creditJeLines: JournalLineInput[] = [];
  const preparedSplits: any[] = [];
  let primaryOffsetId: number | null = null;
  let primaryCat = '';

  for (const raw of manualLines) {
    const amt4 = parseDecimal4(raw.amount);
    if (amt4 <= 0n) throw new AccountingError(400, 'Deposit line amount must be positive');
    const aRes = await tx.query<{ id: number; name: string }>(
      `SELECT id, name FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, Number(raw.accountId)]
    );
    if (aRes.rows.length === 0) throw new AccountingError(404, `Source account ${raw.accountId} not found`);
    if (!primaryOffsetId) {
      primaryOffsetId = Number(aRes.rows[0].id);
      primaryCat = aRes.rows[0].name;
    }

    total4 += amt4;
    preparedSplits.push({
      accountId: Number(aRes.rows[0].id),
      customerId: raw.customerId ? Number(raw.customerId) : null,
      vendorId: raw.vendorId ? Number(raw.vendorId) : null,
      classId: raw.classId ? Number(raw.classId) : null,
      memo: raw.memo?.trim() || null,
      amt4,
    });
    creditJeLines.push({
      accountId: Number(aRes.rows[0].id),
      debit: '0.0000',
      credit: formatDecimal4(amt4),
      description: raw.memo?.trim() || `Deposit from ${input.receivedFrom || aRes.rows[0].name}`,
      partyType: raw.customerId ? 'customer' : raw.vendorId ? 'vendor' : null,
      partyId: raw.customerId ? Number(raw.customerId) : raw.vendorId ? Number(raw.vendorId) : null,
      classId: raw.classId ? Number(raw.classId) : null,
    });
  }

  // Lock & clear Undeposited Customer Payments
  for (const pid of paymentIds.sort((a, b) => a - b)) {
    const pRes = await tx.query<{
      id: number;
      payment_number: string;
      customer_id: number;
      customer_name: string;
      amount: string;
      deposit_to_account_id: number;
      is_voided: boolean;
      deposited_bank_txn_id: number | null;
    }>(
      `SELECT p.id, p.payment_number, p.customer_id, c.company_name AS customer_name,
              p.amount::text, p.deposit_to_account_id, p.is_voided, p.deposited_bank_txn_id
         FROM payments p
         JOIN customers c ON c.company_id = p.company_id AND c.id = p.customer_id
        WHERE p.company_id = $1 AND p.id = $2
        FOR UPDATE OF p`,
      [companyId, pid]
    );
    if (pRes.rows.length === 0) throw new AccountingError(404, `Payment ${pid} not found`);
    const p = pRes.rows[0];
    if (p.is_voided) throw new AccountingError(409, `Payment ${p.payment_number} is voided and cannot be deposited`, 'PAYMENT_VOIDED');
    if (p.deposited_bank_txn_id !== null) {
      throw new AccountingError(
        409,
        `Payment ${p.payment_number} was already deposited (bank txn #${p.deposited_bank_txn_id})`,
        'ALREADY_DEPOSITED'
      );
    }
    const amt4 = parseDecimal4(p.amount);
    const srcAcctId = Number(p.deposit_to_account_id);
    if (!primaryOffsetId) {
      primaryOffsetId = srcAcctId;
      primaryCat = 'Undeposited Funds';
    }
    total4 += amt4;
    preparedSplits.push({
      accountId: srcAcctId,
      customerId: Number(p.customer_id),
      vendorId: null,
      classId: null,
      memo: `Undeposited Payment ${p.payment_number} — ${p.customer_name}`,
      amt4,
    });
    creditJeLines.push({
      accountId: srcAcctId,
      debit: '0.0000',
      credit: formatDecimal4(amt4),
      description: `Clear Undeposited Payment ${p.payment_number}`,
      partyType: 'customer',
      partyId: Number(p.customer_id),
    });
  }

  // Lock & clear Undeposited Sales Receipts
  for (const srid of salesReceiptIds.sort((a, b) => a - b)) {
    const srRes = await tx.query<{
      id: number;
      invoice_number: string;
      customer_id: number;
      customer_name: string;
      total: string;
      status: string;
      is_sales_receipt: boolean;
      deposit_to_account_id: number | null;
      deposited_bank_txn_id: number | null;
    }>(
      `SELECT i.id, i.invoice_number, i.customer_id, c.company_name AS customer_name,
              i.total::text, i.status, i.is_sales_receipt, i.deposit_to_account_id, i.deposited_bank_txn_id
         FROM invoices i
         JOIN customers c ON c.company_id = i.company_id AND c.id = i.customer_id
        WHERE i.company_id = $1 AND i.id = $2
        FOR UPDATE OF i`,
      [companyId, srid]
    );
    if (srRes.rows.length === 0) throw new AccountingError(404, `Sales receipt ${srid} not found`);
    const sr = srRes.rows[0];
    if (!sr.is_sales_receipt) throw new AccountingError(400, `Document ${sr.invoice_number} is not a sales receipt`);
    if (sr.status === 'voided') throw new AccountingError(409, `Sales receipt ${sr.invoice_number} is voided`);
    if (sr.deposited_bank_txn_id !== null) {
      throw new AccountingError(
        409,
        `Sales receipt ${sr.invoice_number} was already deposited (bank txn #${sr.deposited_bank_txn_id})`,
        'ALREADY_DEPOSITED'
      );
    }
    const amt4 = parseDecimal4(sr.total);
    const srcAcctId = sr.deposit_to_account_id ? Number(sr.deposit_to_account_id) : bankGlAccountId;
    if (!primaryOffsetId) {
      primaryOffsetId = srcAcctId;
      primaryCat = 'Undeposited Funds';
    }
    total4 += amt4;
    preparedSplits.push({
      accountId: srcAcctId,
      customerId: Number(sr.customer_id),
      vendorId: null,
      classId: null,
      memo: `Undeposited Sales Receipt ${sr.invoice_number} — ${sr.customer_name}`,
      amt4,
    });
    creditJeLines.push({
      accountId: srcAcctId,
      debit: '0.0000',
      credit: formatDecimal4(amt4),
      description: `Clear Undeposited Sales Receipt ${sr.invoice_number}`,
      partyType: 'customer',
      partyId: Number(sr.customer_id),
    });
  }

  const refNumber = await generateNextDocNumber(tx, companyId, 'bank_transactions', 'ref_number', 'DEP');
  const payee = String(input.receivedFrom || primaryCat || 'Bank Deposit').trim();

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate,
    description: `Bank Deposit ${refNumber} — ${payee}`,
    reference: refNumber,
    sourceType: 'deposit',
    idempotencyKey: `${routeIdKey(input.idempotencyKey, refNumber)}-je`,
    lines: [
      {
        accountId: bankGlAccountId,
        debit: formatDecimal4(total4),
        credit: '0.0000',
        description: `Deposit ${refNumber} — ${payee}`,
      },
      ...creditJeLines,
    ],
  });

  const baRes = await tx.query<{ id: number }>(
    `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
    [companyId, bankGlAccountId]
  );

  const btIns = await tx.query<{ id: number }>(
    `INSERT INTO bank_transactions (
       company_id, account_id, bank_account_id, txn_date, payee, txn_type,
       ref_number, memo, amount, is_cleared, status, offset_account_id, journal_txn_id, category
     ) VALUES (
       $1, $2, $3, $4::DATE, $5, 'Deposit',
       $6, $7, $8::NUMERIC(19,4), FALSE, 'posted', $9, $10, $11
     ) RETURNING id`,
    [
      companyId,
      bankGlAccountId,
      baRes.rows[0] ? Number(baRes.rows[0].id) : null,
      txnDate,
      payee,
      refNumber,
      input.memo?.trim() || null,
      formatDecimal4(total4),
      primaryOffsetId,
      postedJe.transaction.id,
      preparedSplits.length > 1 ? 'Split Deposit' : primaryCat,
    ]
  );
  const bankTxnId = Number(btIns.rows[0].id);

  for (const s of preparedSplits) {
    await tx.query(
      `INSERT INTO deposit_other_lines (
         company_id, bank_txn_id, account_id, customer_id, vendor_id, class_id, memo, amount
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::NUMERIC(19,4))`,
      [companyId, bankTxnId, s.accountId, s.customerId, s.vendorId, s.classId, s.memo, formatDecimal4(s.amt4)]
    );
  }

  if (paymentIds.length > 0) {
    await tx.query(
      `UPDATE payments SET deposited_bank_txn_id = $3 WHERE company_id = $1 AND id = ANY($2::BIGINT[])`,
      [companyId, paymentIds, bankTxnId]
    );
  }
  if (salesReceiptIds.length > 0) {
    await tx.query(
      `UPDATE invoices SET deposited_bank_txn_id = $3 WHERE company_id = $1 AND id = ANY($2::BIGINT[])`,
      [companyId, salesReceiptIds, bankTxnId]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BANK_DEPOSIT_POSTED',
    tableName: 'bank_transactions',
    recordId: bankTxnId,
    newValues: {
      refNumber,
      payee,
      amount: formatDecimal4(total4),
      paymentIds,
      salesReceiptIds,
      journalTxnId: postedJe.transaction.id,
    },
  });

  const all = await listBankTransactions(tx, companyId, { accountId: bankGlAccountId });
  const created = all.find(t => t.id === bankTxnId)!;
  await saveRouteIdempotency(
    tx,
    companyId,
    'bank_deposit_create',
    input.idempotencyKey,
    idem.payloadHash,
    201,
    { transaction: created },
    actor.userId
  );

  return { transaction: created, idempotentReplay: false };
}

export async function recordTransfer(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    fromAccountId: number;
    toAccountId: number;
    amount: string | number;
    txnDate?: string;
    memo?: string | null;
    idempotencyKey?: string | null;
  }
) {
  const idem = await checkRouteIdempotency<{ fromTransaction: any; toTransaction: any }>(
    tx,
    companyId,
    'bank_transfer_create',
    input.idempotencyKey,
    input
  );
  if (idem.hit) return { ...idem.response, idempotentReplay: true };

  const fromId = Number(input.fromAccountId);
  const toId = Number(input.toAccountId);
  if (!Number.isInteger(fromId) || fromId <= 0 || !Number.isInteger(toId) || toId <= 0) {
    throw new AccountingError(400, 'Valid source and destination account IDs are required');
  }
  if (fromId === toId) throw new AccountingError(400, 'Transfer source and destination accounts must differ');

  const accts = await tx.query<{ id: number; name: string; account_type: string }>(
    `SELECT id, name, account_type FROM accounts WHERE company_id = $1 AND id IN ($2, $3)`,
    [companyId, fromId, toId]
  );
  const fromAcct = accts.rows.find(a => Number(a.id) === fromId);
  const toAcct = accts.rows.find(a => Number(a.id) === toId);
  if (!fromAcct || !toAcct) throw new AccountingError(404, 'Transfer account not found');
  const validTypes = new Set(['Bank', 'CreditCard', 'OtherCurrentAsset']);
  if (!validTypes.has(fromAcct.account_type) || !validTypes.has(toAcct.account_type)) {
    throw new AccountingError(400, 'Transfers are supported between Bank, CreditCard, and Cash accounts');
  }

  const amt4 = parseDecimal4(input.amount);
  if (amt4 <= 0n) throw new AccountingError(400, 'Transfer amount must be positive');
  const txnDate = input.txnDate ? assertIsoDate(input.txnDate, 'txnDate') : todayIsoDate();
  const refNumber = await generateNextDocNumber(tx, companyId, 'bank_transactions', 'ref_number', 'XFER');

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate,
    description: `Funds Transfer ${refNumber}: ${fromAcct.name} -> ${toAcct.name}`,
    reference: refNumber,
    sourceType: 'transfer',
    idempotencyKey: `${routeIdKey(input.idempotencyKey, refNumber)}-je`,
    lines: [
      {
        accountId: toId,
        debit: formatDecimal4(amt4),
        credit: '0.0000',
        description: `Transfer In from ${fromAcct.name}`,
      },
      {
        accountId: fromId,
        debit: '0.0000',
        credit: formatDecimal4(amt4),
        description: `Transfer Out to ${toAcct.name}`,
      },
    ],
  });

  const [fromBa, toBa] = await Promise.all([
    tx.query<{ id: number }>(`SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`, [
      companyId,
      fromId,
    ]),
    tx.query<{ id: number }>(`SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`, [
      companyId,
      toId,
    ]),
  ]);

  const outIns = await tx.query<{ id: number }>(
    `INSERT INTO bank_transactions (
       company_id, account_id, bank_account_id, txn_date, payee, txn_type,
       ref_number, memo, amount, is_cleared, status, offset_account_id, journal_txn_id, category
     ) VALUES ($1, $2, $3, $4::DATE, $5, 'Transfer', $6, $7, $8::NUMERIC(19,4), FALSE, 'posted', $9, $10, 'Transfer')
     RETURNING id`,
    [
      companyId,
      fromId,
      fromBa.rows[0] ? Number(fromBa.rows[0].id) : null,
      txnDate,
      `Transfer to ${toAcct.name}`,
      refNumber,
      input.memo?.trim() || null,
      formatDecimal4(-amt4),
      toId,
      postedJe.transaction.id,
    ]
  );
  const outId = Number(outIns.rows[0].id);

  const inIns = await tx.query<{ id: number }>(
    `INSERT INTO bank_transactions (
       company_id, account_id, bank_account_id, txn_date, payee, txn_type,
       ref_number, memo, amount, is_cleared, status, offset_account_id, transfer_pair_txn_id, journal_txn_id, category
     ) VALUES ($1, $2, $3, $4::DATE, $5, 'Transfer', $6, $7, $8::NUMERIC(19,4), FALSE, 'posted', $9, $10, $11, 'Transfer')
     RETURNING id`,
    [
      companyId,
      toId,
      toBa.rows[0] ? Number(toBa.rows[0].id) : null,
      txnDate,
      `Transfer from ${fromAcct.name}`,
      refNumber,
      input.memo?.trim() || null,
      formatDecimal4(amt4),
      fromId,
      outId,
      postedJe.transaction.id,
    ]
  );
  const inId = Number(inIns.rows[0].id);

  await tx.query(`UPDATE bank_transactions SET transfer_pair_txn_id = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    outId,
    inId,
  ]);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BANK_TRANSFER_POSTED',
    tableName: 'bank_transactions',
    recordId: outId,
    newValues: { refNumber, fromId, toId, amount: formatDecimal4(amt4), journalTxnId: postedJe.transaction.id },
  });

  const [fromList, toList] = await Promise.all([
    listBankTransactions(tx, companyId, { accountId: fromId }),
    listBankTransactions(tx, companyId, { accountId: toId }),
  ]);
  const resPayload = {
    fromTransaction: fromList.find(t => t.id === outId)!,
    toTransaction: toList.find(t => t.id === inId)!,
  };
  await saveRouteIdempotency(
    tx,
    companyId,
    'bank_transfer_create',
    input.idempotencyKey,
    idem.payloadHash,
    201,
    resPayload,
    actor.userId
  );

  return { ...resPayload, idempotentReplay: false };
}

export async function voidBankTransaction(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  bankTxnId: number,
  reason?: string
) {
  const btRes = await tx.query<{
    id: number;
    status: string;
    reconciliation_id: number | null;
    journal_txn_id: number | null;
    transfer_pair_txn_id: number | null;
    txn_type: string;
    ref_number: string | null;
  }>(
    `SELECT id, status, reconciliation_id, journal_txn_id, transfer_pair_txn_id, txn_type, ref_number
       FROM bank_transactions WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, bankTxnId]
  );
  if (btRes.rows.length === 0) throw new AccountingError(404, 'Bank transaction not found');
  const bt = btRes.rows[0];
  if (bt.status === 'voided') throw new AccountingError(409, 'Bank transaction is already voided');
  if (bt.reconciliation_id) {
    throw new AccountingError(409, 'Cannot void a reconciled bank transaction; reverse the reconciliation first', 'RECONCILED_ENTRY_LOCKED');
  }
  if (bt.journal_txn_id) {
    // F1 fix: if this bank transaction was created directly by a customer payment,
    // bill payment, or sales receipt, voiding only the bank transaction would reverse
    // the GL while leaving the subledger document active/paid. Require voiding via
    // the source document so AR/AP subledgers stay in sync with the GL.
    const linkedPmt = await tx.query<{ payment_number: string }>(
      `SELECT payment_number FROM payments
        WHERE company_id = $1 AND journal_txn_id = $2 AND is_voided = FALSE LIMIT 1`,
      [companyId, bt.journal_txn_id]
    );
    if (linkedPmt.rows.length > 0) {
      throw new AccountingError(
        409,
        `Bank transaction is linked to customer payment ${linkedPmt.rows[0].payment_number}; void the payment instead.`,
        'LINKED_SOURCE_DOCUMENT'
      );
    }
    const linkedBillPmt = await tx.query<{ payment_number: string }>(
      `SELECT payment_number FROM bill_payments
        WHERE company_id = $1 AND journal_txn_id = $2 AND is_voided = FALSE LIMIT 1`,
      [companyId, bt.journal_txn_id]
    );
    if (linkedBillPmt.rows.length > 0) {
      throw new AccountingError(
        409,
        `Bank transaction is linked to bill payment ${linkedBillPmt.rows[0].payment_number}; void the bill payment instead.`,
        'LINKED_SOURCE_DOCUMENT'
      );
    }
    const linkedSr = await tx.query<{ invoice_number: string }>(
      `SELECT invoice_number FROM invoices
        WHERE company_id = $1 AND journal_txn_id = $2 AND is_sales_receipt = TRUE AND status <> 'voided' LIMIT 1`,
      [companyId, bt.journal_txn_id]
    );
    if (linkedSr.rows.length > 0) {
      throw new AccountingError(
        409,
        `Bank transaction is linked to sales receipt ${linkedSr.rows[0].invoice_number}; void the sales receipt instead.`,
        'LINKED_SOURCE_DOCUMENT'
      );
    }

    const reconLineRes = await tx.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM journal_lines
        WHERE company_id = $1 AND transaction_id = $2 AND is_reconciled = TRUE`,
      [companyId, bt.journal_txn_id]
    );
    if (Number(reconLineRes.rows[0]?.cnt ?? 0) > 0) {
      throw new AccountingError(409, 'Cannot void a bank transaction with reconciled journal lines; reverse the reconciliation first', 'RECONCILED_ENTRY_LOCKED');
    }
  }

  let reversalJournalId: number | null = null;
  if (bt.journal_txn_id) {
    const rev = await reverseJournalEntry(tx, companyId, actor, Number(bt.journal_txn_id), {
      reason: reason || `Void ${bt.txn_type} ${bt.ref_number || bt.id}`,
    });
    reversalJournalId = rev.reversal.id;
  }

  await tx.query(`UPDATE bank_transactions SET status = 'voided' WHERE company_id = $1 AND id = $2`, [
    companyId,
    bankTxnId,
  ]);
  await tx.query(
    `UPDATE payments SET deposited_bank_txn_id = NULL WHERE company_id = $1 AND deposited_bank_txn_id = $2`,
    [companyId, bankTxnId]
  );
  await tx.query(
    `UPDATE invoices SET deposited_bank_txn_id = NULL WHERE company_id = $1 AND deposited_bank_txn_id = $2`,
    [companyId, bankTxnId]
  );
  if (bt.transfer_pair_txn_id) {
    await tx.query(`UPDATE bank_transactions SET status = 'voided' WHERE company_id = $1 AND id = $2`, [
      companyId,
      Number(bt.transfer_pair_txn_id),
    ]);
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BANK_TRANSACTION_VOIDED',
    tableName: 'bank_transactions',
    recordId: bankTxnId,
    oldValues: { status: bt.status },
    newValues: { status: 'voided', reason: reason || null, reversalJournalId },
  });

  return { bankTxnId, status: 'voided', reversalJournalId };
}

export async function toggleBankTransactionCleared(
  tx: Transaction,
  companyId: number,
  bankTxnId: number,
  cleared: boolean
) {
  const res = await tx.query<{ id: number; reconciliation_id: number | null }>(
    `SELECT id, reconciliation_id FROM bank_transactions WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, bankTxnId]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Bank transaction not found');
  if (res.rows[0].reconciliation_id) {
    throw new AccountingError(409, 'Transaction is locked in a completed reconciliation');
  }
  await tx.query(`UPDATE bank_transactions SET is_cleared = $3 WHERE company_id = $1 AND id = $2`, [
    companyId,
    bankTxnId,
    Boolean(cleared),
  ]);
  return { bankTxnId, cleared: Boolean(cleared) };
}

// ============================================================================
// BANKING RULES, CSV / OFX IMPORTS & CATEGORIZATION
// ============================================================================

export async function listBankRules(tx: Transaction, companyId: number) {
  const res = await tx.query<any>(
    `SELECT r.id, r.name, r.match_field, r.match_pattern, r.target_account_id,
            a.name AS target_account_name, r.default_vendor_id, r.default_customer_id,
            r.default_class_id, r.priority, r.is_active
       FROM bank_rules r
       JOIN accounts a ON a.company_id = r.company_id AND a.id = r.target_account_id
      WHERE r.company_id = $1
      ORDER BY r.priority ASC, r.id ASC`,
    [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    name: r.name,
    matchField: r.match_field,
    matchPattern: r.match_pattern,
    targetAccountId: Number(r.target_account_id),
    targetAccountName: r.target_account_name,
    defaultVendorId: r.default_vendor_id !== null ? Number(r.default_vendor_id) : null,
    defaultCustomerId: r.default_customer_id !== null ? Number(r.default_customer_id) : null,
    defaultClassId: r.default_class_id !== null ? Number(r.default_class_id) : null,
    priority: Number(r.priority),
    isActive: Boolean(r.is_active),
  }));
}

export async function createBankRule(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    name: string;
    matchField: 'payee' | 'memo' | 'amount';
    matchPattern: string;
    targetAccountId: number;
    defaultVendorId?: number | null;
    defaultCustomerId?: number | null;
    priority?: number;
  }
) {
  const name = String(input.name || '').trim();
  const pattern = String(input.matchPattern || '').trim();
  if (!name || !pattern) throw new AccountingError(400, 'Rule name and matchPattern are required');
  if (!['payee', 'memo', 'amount'].includes(input.matchField)) {
    throw new AccountingError(400, 'matchField must be payee, memo, or amount');
  }

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO bank_rules (
       company_id, name, match_field, match_pattern, target_account_id,
       default_vendor_id, default_customer_id, priority
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      companyId,
      name,
      input.matchField,
      pattern,
      Number(input.targetAccountId),
      input.defaultVendorId ? Number(input.defaultVendorId) : null,
      input.defaultCustomerId ? Number(input.defaultCustomerId) : null,
      Number(input.priority ?? 10),
    ]
  );
  const id = Number(ins.rows[0].id);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BANK_RULE_CREATED',
    tableName: 'bank_rules',
    recordId: id,
    newValues: { name, matchField: input.matchField, matchPattern: pattern },
  });

  const all = await listBankRules(tx, companyId);
  return all.find(r => r.id === id)!;
}

export async function deleteBankRule(tx: Transaction, companyId: number, ruleId: number) {
  const del = await tx.query(`DELETE FROM bank_rules WHERE company_id = $1 AND id = $2 RETURNING id`, [
    companyId,
    ruleId,
  ]);
  if (del.rows.length === 0) throw new AccountingError(404, 'Bank rule not found');
  return { deletedId: ruleId };
}

function parseStatementPayload(rawText?: string, rows?: any[]): Array<{
  date: string;
  payee: string;
  memo: string;
  amount: string;
  fitid: string | null;
}> {
  if (Array.isArray(rows) && rows.length > 0) {
    return rows.map((r, i) => ({
      date: assertIsoDate(r.date || r.txnDate || todayIsoDate(), `rows[${i}].date`),
      payee: String(r.payee || r.description || 'Bank Entry').trim(),
      memo: String(r.memo || '').trim(),
      amount: String(r.amount),
      fitid: r.fitid || r.externalFitid ? String(r.fitid || r.externalFitid).trim() : null,
    }));
  }

  const text = String(rawText || '').trim();
  if (!text) return [];

  // OFX <STMTTRN> block detection
  if (text.includes('<STMTTRN>') || text.includes('<OFX>')) {
    const blocks = text.split('<STMTTRN>').slice(1);
    const parsed: any[] = [];
    for (const blk of blocks) {
      const tag = (name: string) => {
        const m = blk.match(new RegExp(`<${name}>([^<\\r\\n]+)`, 'i'));
        return m ? m[1].trim() : '';
      };
      const dtRaw = tag('DTPOSTED').slice(0, 8);
      const iso =
        dtRaw.length === 8
          ? `${dtRaw.slice(0, 4)}-${dtRaw.slice(4, 6)}-${dtRaw.slice(6, 8)}`
          : todayIsoDate();
      const amt = tag('TRNAMT') || '0';
      const payee = tag('NAME') || tag('MEMO') || 'OFX Entry';
      const memo = tag('MEMO');
      const fitid = tag('FITID') || null;
      parsed.push({ date: iso, payee, memo, amount: amt, fitid });
    }
    return parsed;
  }

  // CSV parser: expects date,payee,amount[,memo,fitid]
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
    if (i === 0 && /date/i.test(cols[0])) continue; // skip header
    if (cols.length < 3) continue;
    out.push({
      date: assertIsoDate(cols[0], `csv[${i}].date`),
      payee: cols[1] || 'CSV Entry',
      amount: cols[2],
      memo: cols[3] || '',
      fitid: cols[4] || null,
    });
  }
  return out;
}

export async function importBankStatement(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    bankGlAccountId: number;
    rawText?: string;
    rows?: Array<{ date: string; payee: string; amount: string | number; memo?: string; fitid?: string }>;
    autoApplyRules?: boolean;
  }
) {
  const bankGlAccountId = Number(input.bankGlAccountId);
  const acctRes = await tx.query<{ id: number }>(
    `SELECT id FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, bankGlAccountId]
  );
  if (acctRes.rows.length === 0) throw new AccountingError(404, 'Bank GL account not found');

  const baRes = await tx.query<{ id: number }>(
    `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
    [companyId, bankGlAccountId]
  );
  const bankAccountId = baRes.rows[0] ? Number(baRes.rows[0].id) : null;

  const items = parseStatementPayload(input.rawText, input.rows);
  if (items.length === 0) throw new AccountingError(400, 'No valid CSV/OFX transactions found in import payload');

  const rules = await listBankRules(tx, companyId);
  let importedCount = 0;
  let skippedDuplicates = 0;
  let autoPostedCount = 0;
  const importedIds: number[] = [];

  for (const item of items) {
    const amt4 = parseDecimal4(item.amount);
    if (amt4 === 0n) continue;

    if (item.fitid) {
      const dup = await tx.query<{ id: number }>(
        `SELECT id FROM bank_transactions WHERE company_id = $1 AND account_id = $2 AND external_fitid = $3 LIMIT 1`,
        [companyId, bankGlAccountId, item.fitid]
      );
      if (dup.rows.length > 0) {
        skippedDuplicates++;
        continue;
      }
    }

    // Match rules by priority
    const matchedRule = rules.find(r => {
      if (!r.isActive) return false;
      const needle = r.matchPattern.toLowerCase();
      if (r.matchField === 'payee') return item.payee.toLowerCase().includes(needle);
      if (r.matchField === 'memo') return item.memo.toLowerCase().includes(needle);
      if (r.matchField === 'amount') return formatDecimal2(amt4 < 0n ? -amt4 : amt4) === needle;
      return false;
    });

    const txnType = amt4 > 0n ? 'Deposit' : 'Debit';
    const ins = await tx.query<{ id: number }>(
      `INSERT INTO bank_transactions (
         company_id, account_id, bank_account_id, txn_date, payee, txn_type,
         memo, amount, is_cleared, status, offset_account_id, matched_rule_id,
         vendor_id, customer_id, external_fitid, category
       ) VALUES (
         $1, $2, $3, $4::DATE, $5, $6,
         $7, $8::NUMERIC(19,4), FALSE, 'pending_import', $9, $10,
         $11, $12, $13, $14
       ) RETURNING id`,
      [
        companyId,
        bankGlAccountId,
        bankAccountId,
        item.date,
        item.payee,
        txnType,
        item.memo || null,
        formatDecimal4(amt4),
        matchedRule ? matchedRule.targetAccountId : null,
        matchedRule ? matchedRule.id : null,
        matchedRule ? matchedRule.defaultVendorId : null,
        matchedRule ? matchedRule.defaultCustomerId : null,
        item.fitid,
        matchedRule ? matchedRule.targetAccountName : 'Uncategorized',
      ]
    );
    const txnId = Number(ins.rows[0].id);
    importedIds.push(txnId);
    importedCount++;

    if (input.autoApplyRules && matchedRule) {
      await categorizeImportedTransaction(tx, companyId, actor, txnId, {
        offsetAccountId: matchedRule.targetAccountId,
        vendorId: matchedRule.defaultVendorId,
        customerId: matchedRule.defaultCustomerId,
      });
      autoPostedCount++;
    }
  }

  if (bankAccountId) {
    await tx.query(`UPDATE bank_accounts SET last_synced_at = NOW() WHERE company_id = $1 AND id = $2`, [
      companyId,
      bankAccountId,
    ]);
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BANK_STATEMENT_IMPORTED',
    tableName: 'bank_transactions',
    recordId: bankGlAccountId,
    newValues: { importedCount, skippedDuplicates, autoPostedCount },
  });

  return { importedCount, skippedDuplicates, autoPostedCount, importedIds };
}

export async function categorizeImportedTransaction(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  bankTxnId: number,
  input: {
    offsetAccountId: number;
    vendorId?: number | null;
    customerId?: number | null;
    memo?: string | null;
  }
) {
  const btRes = await tx.query<{
    id: number;
    account_id: number;
    txn_date: string;
    payee: string;
    txn_type: string;
    memo: string | null;
    amount: string;
    status: string;
  }>(
    `SELECT id, account_id, txn_date::text, payee, txn_type, memo, amount::text, status
       FROM bank_transactions WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, bankTxnId]
  );
  if (btRes.rows.length === 0) throw new AccountingError(404, 'Bank feed transaction not found');
  const bt = btRes.rows[0];
  if (bt.status !== 'pending_import') {
    throw new AccountingError(409, `Transaction is already ${bt.status}`);
  }

  const offsetAcctId = Number(input.offsetAccountId);
  const acctRes = await tx.query<{ id: number; name: string }>(
    `SELECT id, name FROM accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, offsetAcctId]
  );
  if (acctRes.rows.length === 0) throw new AccountingError(404, 'Target offset account not found');

  const amt4 = parseDecimal4(bt.amount);
  const abs4 = amt4 < 0n ? -amt4 : amt4;

  const lines: JournalLineInput[] =
    amt4 > 0n
      ? [
          {
            accountId: Number(bt.account_id),
            debit: formatDecimal4(abs4),
            credit: '0.0000',
            description: `Bank Feed Deposit — ${bt.payee}`,
          },
          {
            accountId: offsetAcctId,
            debit: '0.0000',
            credit: formatDecimal4(abs4),
            description: input.memo?.trim() || bt.memo || bt.payee,
            partyType: input.customerId ? 'customer' : null,
            partyId: input.customerId ? Number(input.customerId) : null,
          },
        ]
      : [
          {
            accountId: offsetAcctId,
            debit: formatDecimal4(abs4),
            credit: '0.0000',
            description: input.memo?.trim() || bt.memo || bt.payee,
            partyType: input.vendorId ? 'vendor' : null,
            partyId: input.vendorId ? Number(input.vendorId) : null,
          },
          {
            accountId: Number(bt.account_id),
            debit: '0.0000',
            credit: formatDecimal4(abs4),
            description: `Bank Feed Withdrawal — ${bt.payee}`,
          },
        ];

  const postedJe = await postJournalEntry(tx, companyId, actor, {
    txnDate: bt.txn_date,
    description: `Bank Feed Match — ${bt.payee}`,
    reference: `FEED-${bankTxnId}`,
    sourceType: 'bank_import',
    sourceId: bankTxnId,
    idempotencyKey: `bank-feed-je-${companyId}-${bankTxnId}`,
    lines,
  });

  await tx.query(
    `UPDATE bank_transactions
        SET status = 'posted',
            offset_account_id = $3,
            vendor_id = COALESCE($4, vendor_id),
            customer_id = COALESCE($5, customer_id),
            memo = COALESCE($6, memo),
            category = $7,
            journal_txn_id = $8
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      bankTxnId,
      offsetAcctId,
      input.vendorId ? Number(input.vendorId) : null,
      input.customerId ? Number(input.customerId) : null,
      input.memo?.trim() || null,
      acctRes.rows[0].name,
      postedJe.transaction.id,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BANK_IMPORT_CATEGORIZED',
    tableName: 'bank_transactions',
    recordId: bankTxnId,
    newValues: { offsetAccountId: offsetAcctId, journalTxnId: postedJe.transaction.id },
  });

  const list = await listBankTransactions(tx, companyId, { accountId: Number(bt.account_id) });
  return list.find(t => t.id === bankTxnId)!;
}

export async function dismissDuplicateFeedItem(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  bankTxnId: number,
  reason?: string
) {
  const bt = await tx.query<{ id: number; status: string }>(
    `SELECT id, status FROM bank_transactions WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, bankTxnId]
  );
  if (bt.rows.length === 0) throw new AccountingError(404, 'Bank transaction not found');
  if (bt.rows[0].status !== 'pending_import') {
    throw new AccountingError(409, 'Only pending_import transactions can be dismissed as duplicates');
  }
  await tx.query(
    `INSERT INTO duplicate_dismissals (company_id, bank_txn_id, dismissed_by, reason)
     VALUES ($1, $2, $3, $4)`,
    [companyId, bankTxnId, actor.userId, reason?.trim() || 'Dismissed duplicate bank feed line']
  );
  await tx.query(`UPDATE bank_transactions SET status = 'voided' WHERE company_id = $1 AND id = $2`, [
    companyId,
    bankTxnId,
  ]);
  return { bankTxnId, status: 'voided' };
}

// ============================================================================
// BANK RECONCILIATION (PREVIEW, EXACT ZERO-DIFFERENCE LOCK, & REVERSAL)
// ============================================================================

export async function listReconciliations(tx: Transaction, companyId: number, accountId?: number) {
  const res = await tx.query<any>(
    `SELECT r.id, r.account_id, a.name AS account_name, r.statement_date::text,
            r.beginning_balance::text, r.statement_ending_balance::text,
            r.cleared_total::text, r.difference::text, r.status,
            r.completed_at::text, r.reversed_at::text, r.reversal_reason
       FROM reconciliations r
       JOIN accounts a ON a.company_id = r.company_id AND a.id = r.account_id
      WHERE r.company_id = $1 ${accountId ? 'AND r.account_id = $2' : ''}
      ORDER BY r.statement_date DESC, r.id DESC`,
    accountId ? [companyId, accountId] : [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    accountId: Number(r.account_id),
    accountName: r.account_name,
    statementDate: r.statement_date,
    beginningBalance: toMoneyNumber(parseDecimal4(r.beginning_balance)),
    statementEndingBalance: toMoneyNumber(parseDecimal4(r.statement_ending_balance)),
    clearedTotal: toMoneyNumber(parseDecimal4(r.cleared_total)),
    difference: toMoneyNumber(parseDecimal4(r.difference)),
    status: r.status || 'completed',
    completedAt: r.completed_at,
    reversedAt: r.reversed_at,
    reversalReason: r.reversal_reason || '',
  }));
}

export async function previewReconciliation(
  tx: Transaction,
  companyId: number,
  input: {
    accountId: number;
    statementDate?: string;
    statementEndingBalance: string | number;
    clearedBankTxnIds?: number[];
  }
) {
  const accountId = Number(input.accountId);
  const stmtDate = input.statementDate ? assertIsoDate(input.statementDate, 'statementDate') : todayIsoDate();
  const stmtEnd4 = parseDecimal4(input.statementEndingBalance);

  const lastRec = await tx.query<{ statement_ending_balance: string }>(
    `SELECT statement_ending_balance::text
       FROM reconciliations
      WHERE company_id = $1 AND account_id = $2 AND status = 'completed'
      ORDER BY statement_date DESC, id DESC
      LIMIT 1`,
    [companyId, accountId]
  );
  const beginning4 = lastRec.rows.length > 0 ? parseDecimal4(lastRec.rows[0].statement_ending_balance) : 0n;

  const unreconciled = await tx.query<{
    id: number;
    txn_date: string;
    payee: string;
    txn_type: string;
    ref_number: string | null;
    amount: string;
    is_cleared: boolean;
  }>(
    `SELECT id, txn_date::text, payee, txn_type, ref_number, amount::text, is_cleared
       FROM bank_transactions
      WHERE company_id = $1 AND account_id = $2
        AND status = 'posted'
        AND reconciliation_id IS NULL
        AND txn_date <= $3::DATE
      ORDER BY txn_date ASC, id ASC`,
    [companyId, accountId, stmtDate]
  );

  const selectedSet = input.clearedBankTxnIds ? new Set(input.clearedBankTxnIds.map(Number)) : null;

  let clearedDeposits4 = 0n;
  let clearedPayments4 = 0n;
  const items = unreconciled.rows.map(r => {
    const id = Number(r.id);
    const amt4 = parseDecimal4(r.amount);
    const isSelected = selectedSet ? selectedSet.has(id) : Boolean(r.is_cleared);
    if (isSelected) {
      if (amt4 >= 0n) clearedDeposits4 += amt4;
      else clearedPayments4 += -amt4;
    }
    return {
      id,
      date: r.txn_date,
      payee: r.payee,
      type: r.txn_type,
      refNumber: r.ref_number || '',
      amount: toMoneyNumber(amt4),
      selected: isSelected,
    };
  });

  const clearedNet4 = clearedDeposits4 - clearedPayments4;
  const clearedBalance4 = beginning4 + clearedNet4;
  const difference4 = stmtEnd4 - clearedBalance4;

  return {
    accountId,
    statementDate: stmtDate,
    beginningBalance: toMoneyNumber(beginning4),
    statementEndingBalance: toMoneyNumber(stmtEnd4),
    clearedDeposits: toMoneyNumber(clearedDeposits4),
    clearedPayments: toMoneyNumber(clearedPayments4),
    clearedNet: toMoneyNumber(clearedNet4),
    clearedEndingBalance: toMoneyNumber(clearedBalance4),
    difference: toMoneyNumber(difference4),
    differenceExactZero: difference4 === 0n,
    items,
  };
}

export async function completeReconciliation(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    accountId: number;
    statementDate: string;
    statementEndingBalance: string | number;
    clearedBankTxnIds: number[];
  }
) {
  const accountId = Number(input.accountId);
  const stmtDate = assertIsoDate(input.statementDate, 'statementDate');
  const stmtEnd4 = parseDecimal4(input.statementEndingBalance);
  const selectedIds = Array.isArray(input.clearedBankTxnIds) ? input.clearedBankTxnIds.map(Number) : [];

  const preview = await previewReconciliation(tx, companyId, {
    accountId,
    statementDate: stmtDate,
    statementEndingBalance: input.statementEndingBalance,
    clearedBankTxnIds: selectedIds,
  });

  // Strict exact BigInt zero difference invariant (also enforced by PostgreSQL CHECK (difference = 0.0000))
  const beginning4 = parseDecimal4(preview.beginningBalance);
  let clearedNet4 = 0n;
  const journalTxnIds: number[] = [];

  if (selectedIds.length > 0) {
    const selRes = await tx.query<{ id: number; amount: string; journal_txn_id: number | null; reconciliation_id: number | null }>(
      `SELECT id, amount::text, journal_txn_id, reconciliation_id
         FROM bank_transactions
        WHERE company_id = $1 AND account_id = $2 AND status = 'posted' AND id = ANY($3::BIGINT[])
        FOR UPDATE`,
      [companyId, accountId, selectedIds]
    );
    if (selRes.rows.length !== selectedIds.length) {
      throw new AccountingError(400, 'One or more selected bank transactions could not be found in this account');
    }
    for (const r of selRes.rows) {
      if (r.reconciliation_id) {
        throw new AccountingError(409, `Transaction ${r.id} is already reconciled`);
      }
      clearedNet4 += parseDecimal4(r.amount);
      if (r.journal_txn_id) journalTxnIds.push(Number(r.journal_txn_id));
    }
  }

  const diff4 = stmtEnd4 - (beginning4 + clearedNet4);
  if (diff4 !== 0n) {
    throw new AccountingError(
      400,
      `Reconciliation difference must equal 0.00 before completing (current difference: ${formatDecimal2(diff4)})`,
      'RECONCILIATION_UNBALANCED'
    );
  }

  const baRes = await tx.query<{ id: number }>(
    `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
    [companyId, accountId]
  );

  const recIns = await tx.query<{ id: number }>(
    `INSERT INTO reconciliations (
       company_id, account_id, bank_account_id, statement_date,
       statement_ending_balance, beginning_balance, cleared_total, difference,
       reconciled_by, completed_at, status
     ) VALUES (
       $1, $2, $3, $4::DATE,
       $5::NUMERIC(19,4), $6::NUMERIC(19,4), $7::NUMERIC(19,4), 0.0000,
       $8, NOW(), 'completed'
     ) RETURNING id`,
    [
      companyId,
      accountId,
      baRes.rows[0] ? Number(baRes.rows[0].id) : null,
      stmtDate,
      formatDecimal4(stmtEnd4),
      formatDecimal4(beginning4),
      formatDecimal4(clearedNet4),
      actor.userId,
    ]
  );
  const recId = Number(recIns.rows[0].id);

  if (selectedIds.length > 0) {
    await tx.query(
      `UPDATE bank_transactions
          SET is_cleared = TRUE,
              reconciliation_id = $3
        WHERE company_id = $1 AND id = ANY($2::BIGINT[])`,
      [companyId, selectedIds, recId]
    );
  }

  // Lock matching GL journal lines as reconciled so Phase 4 reverseJournalEntry blocks tampering!
  if (journalTxnIds.length > 0) {
    await tx.query(
      `UPDATE journal_lines
          SET is_reconciled = TRUE
        WHERE company_id = $1 AND account_id = $2 AND transaction_id = ANY($3::BIGINT[])`,
      [companyId, accountId, journalTxnIds]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BANK_RECONCILIATION_COMPLETED',
    tableName: 'reconciliations',
    recordId: recId,
    newValues: {
      accountId,
      statementDate: stmtDate,
      statementEndingBalance: formatDecimal4(stmtEnd4),
      clearedCount: selectedIds.length,
      lockedJournalCount: journalTxnIds.length,
    },
  });

  const all = await listReconciliations(tx, companyId, accountId);
  return all.find(r => r.id === recId)!;
}

export async function reverseReconciliation(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  reconciliationId: number,
  reason: string
) {
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw new AccountingError(400, 'Reconciliation reversal requires an audit reason');

  const recRes = await tx.query<{ id: number; account_id: number; status: string }>(
    `SELECT id, account_id, status FROM reconciliations WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, reconciliationId]
  );
  if (recRes.rows.length === 0) throw new AccountingError(404, 'Reconciliation not found');
  const rec = recRes.rows[0];
  if (rec.status === 'reversed') throw new AccountingError(409, 'Reconciliation is already reversed');

  const txns = await tx.query<{ id: number; journal_txn_id: number | null }>(
    `SELECT id, journal_txn_id FROM bank_transactions WHERE company_id = $1 AND reconciliation_id = $2 FOR UPDATE`,
    [companyId, reconciliationId]
  );
  const jIds = txns.rows.map(r => r.journal_txn_id).filter((x): x is number => x !== null).map(Number);

  if (jIds.length > 0) {
    await tx.query(
      `UPDATE journal_lines
          SET is_reconciled = FALSE
        WHERE company_id = $1 AND account_id = $2 AND transaction_id = ANY($3::BIGINT[])`,
      [companyId, Number(rec.account_id), jIds]
    );
  }

  await tx.query(
    `UPDATE bank_transactions
        SET reconciliation_id = NULL,
            is_cleared = FALSE
      WHERE company_id = $1 AND reconciliation_id = $2`,
    [companyId, reconciliationId]
  );

  await tx.query(
    `UPDATE reconciliations
        SET status = 'reversed',
            reversed_by = $3,
            reversed_at = NOW(),
            reversal_reason = $4
      WHERE company_id = $1 AND id = $2`,
    [companyId, reconciliationId, actor.userId, cleanReason]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BANK_RECONCILIATION_REVERSED',
    tableName: 'reconciliations',
    recordId: reconciliationId,
    oldValues: { status: 'completed' },
    newValues: { status: 'reversed', reason: cleanReason, unlockedCount: txns.rows.length },
  });

  const all = await listReconciliations(tx, companyId, Number(rec.account_id));
  return all.find(r => r.id === reconciliationId)!;
}

function routeIdKey(idemKey: string | null | undefined, fallback: string): string {
  return idemKey && idemKey.trim() ? idemKey.trim() : fallback;
}
