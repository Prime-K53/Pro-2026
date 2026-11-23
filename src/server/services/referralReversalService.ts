import { Transaction } from '@electric-sql/pglite';
import {
  AccountingError,
  ActorContext,
  postJournalEntry,
  reverseJournalEntry,
} from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import {
  resolveWalletLiabilityAccount,
  reverseWalletForReferralReward,
} from './customerWalletService.ts';

/**
 * Central referral reversal service (R1-A, R2-A, R3-A, R4-C, D-03-A).
 *
 * Full refund  → reverse the entire original reward.
 * Partial refund → recalculate the reward on final retained eligible sales and
 *                  reverse the excess.
 *
 * When the reward was already spent, the wallet is debited below zero ONLY for
 * the exact unrecovered amount (bounded by the original reward). Ordinary
 * spending remains blocked at zero; future wallet credits recover the negative
 * balance first.
 *
 * Original reward and wallet transactions are never deleted; each reversal is a
 * new, idempotent, referenced record.
 */

export interface ReversalResult {
  originalEventId: number;
  reversalEventId: number;
  reversalAmount: number;
  negativeBalance: number;
  journalTxnId: number;
  walletTxnId: number;
  idempotentReplay: boolean;
}

async function alreadyReversed4(tx: Transaction, companyId: number, eventId: number): Promise<bigint> {
  const res = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(reward_amount), 0)::NUMERIC(19,4)::text AS total
       FROM referral_events
      WHERE company_id = $1 AND reversal_of_id = $2 AND status = 'reversed'`,
    [companyId, eventId]
  );
  return parseDecimal4(res.rows[0]?.total ?? 0);
}

/**
 * Reverse a wallet-credited referral reward, in full or in part.
 * `amount` omitted = full remaining reversal.
 */
export async function reverseReferralReward(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { eventId: number; amount?: string | number | null; reason?: string | null }
): Promise<ReversalResult> {
  const res = await tx.query<any>(
    `SELECT re.*, rc.referrer_customer_id, rc.code AS rc_code, rp.reward_expense_account_id
       FROM referral_events re
       JOIN referral_codes rc ON rc.company_id = re.company_id AND rc.id = re.referral_code_id
       JOIN referral_programs rp ON rp.company_id = re.company_id AND rp.id = re.program_id
      WHERE re.company_id = $1 AND re.id = $2
      FOR UPDATE`,
    [companyId, Number(input.eventId)]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Referral reward event not found', 'REFERRAL_EVENT_NOT_FOUND');
  }
  const event = res.rows[0];

  if (event.status === 'voided' || event.status === 'reversed') {
    throw new AccountingError(409, 'Event is already void or reversed', 'REFERRAL_ALREADY_REVERSED');
  }
  if (event.status !== 'credited' || event.wallet_txn_id == null || event.payout_journal_txn_id == null) {
    throw new AccountingError(
      409,
      'Only wallet-credited rewards can be reversed through this service',
      'REFERRAL_REWARD_NOT_WALLET_CREDITED'
    );
  }

  const original4 = parseDecimal4(String(event.reward_amount));
  const reversed4 = await alreadyReversed4(tx, companyId, Number(event.id));
  const remaining4 = original4 - reversed4;
  if (remaining4 <= 0n) {
    throw new AccountingError(409, 'Reward is already fully reversed', 'REFERRAL_ALREADY_FULLY_REVERSED');
  }

  const amount4 = input.amount != null ? parseDecimal4(input.amount as any) : remaining4;
  if (amount4 <= 0n) {
    throw new AccountingError(400, 'Reversal amount must be greater than zero', 'INVALID_AMOUNT');
  }
  if (amount4 > remaining4) {
    throw new AccountingError(
      400,
      'Reversal amount exceeds the remaining reversible reward',
      'REFERRAL_REVERSAL_EXCEEDS_REWARD'
    );
  }

  const referrerCustomerId = event.referrer_customer_id != null ? Number(event.referrer_customer_id) : null;
  if (!referrerCustomerId) {
    throw new AccountingError(400, 'Referral code is not linked to a customer wallet owner', 'REFERRAL_REFERRER_CUSTOMER_MISSING');
  }

  const isFullRemaining = amount4 === remaining4;
  const isFirstReversal = reversed4 === 0n;
  const walletLiabilityAccountId = await resolveWalletLiabilityAccount(tx, companyId);

  // Resolve the referral expense account from the program (D-02-B).
  const progRes = await tx.query<{ reward_expense_account_id: number | null }>(
    `SELECT reward_expense_account_id FROM referral_programs WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, Number(event.program_id)]
  );
  const expenseAccountId = progRes.rows[0]?.reward_expense_account_id != null
    ? Number(progRes.rows[0].reward_expense_account_id)
    : null;
  if (expenseAccountId == null) {
    throw new AccountingError(
      409,
      'Referral expense account is not configured; reversal cannot post',
      'REFERRAL_EXPENSE_ACCOUNT_UNCONFIGURED'
    );
  }

  let journalTxnId: number;
  let walletIdempotentReplay = false;

  if (isFirstReversal && isFullRemaining) {
    // Full reversal: reverse the original reward journal atomically.
    const rev = await reverseJournalEntry(tx, companyId, actor, Number(event.payout_journal_txn_id), {
      reason: input.reason ?? 'Referral reward full reversal',
      idempotencyKey: `ref-reversal-je-${companyId}-${event.id}`,
    });
    journalTxnId = rev.reversal.id;
    walletIdempotentReplay = rev.idempotentReplay;
  } else {
    // Partial (or subsequent) reversal: post a partial reversing journal
    // Dr wallet liability / Cr referral expense for the excess amount.
    const je = await postJournalEntry(tx, companyId, actor, {
      txnDate: new Date().toISOString().slice(0, 10),
      description: `Referral reward partial reversal — ${event.rc_code}`,
      reference: `REF-REV-${event.id}-${reversed4}`,
      sourceType: 'reversal',
      sourceId: Number(event.id),
      idempotencyKey: `ref-reversal-je-${companyId}-${event.id}-${reversed4}`,
      lines: [
        {
          accountId: walletLiabilityAccountId,
          debit: formatDecimal4(amount4),
          credit: '0.0000',
          description: `Wallet liability reversal (${event.rc_code})`,
          partyType: 'customer',
          partyId: referrerCustomerId,
        },
        {
          accountId: expenseAccountId,
          debit: '0.0000',
          credit: formatDecimal4(amount4),
          description: `Referral expense reversal (${event.rc_code})`,
        },
      ],
    });
    journalTxnId = je.transaction.id;
  }

  // Debit the existing wallet (allow negative ONLY up to the exact reversal amount).
  const debit = await reverseWalletForReferralReward(tx, companyId, actor, {
    customerId: referrerCustomerId,
    amount: formatDecimal4(amount4),
    referenceType: 'referral_reversal',
    referenceId: Number(event.id),
    originalWalletTxnId: Number(event.wallet_txn_id),
    journalTxnId,
    idempotencyKey: `ref-reversal-wtx-${companyId}-${event.id}-${reversed4}`,
    description: `Referral reward reversal for ${event.rc_code}`,
    notes: input.reason ?? null,
    allowNegative: true,
  });
  walletIdempotentReplay = walletIdempotentReplay || debit.idempotentReplay;

  // Record a new reversal event that references the original (never delete).
  const ins = await tx.query<{ id: number }>(
    `INSERT INTO referral_events (
       company_id, referral_code_id, program_id, campaign_id, attribution_id,
       referee_customer_id, pos_order_id, invoice_id, qualifying_amount, referee_discount,
       reward_amount, status, payout_method, payout_account_id, wallet_txn_id,
       payout_journal_txn_id, reversal_of_id, notes, terms_snapshot
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 0.0000, 0.0000,
       $9::NUMERIC(19,4), 'reversed', 'wallet', NULL, $10,
       $11, $12, $13, $14::JSONB
     ) RETURNING id`,
    [
      companyId,
      Number(event.referral_code_id),
      Number(event.program_id),
      event.campaign_id != null ? Number(event.campaign_id) : null,
      event.attribution_id != null ? Number(event.attribution_id) : null,
      referrerCustomerId,
      null,
      event.invoice_id != null ? Number(event.invoice_id) : null,
      formatDecimal4(amount4),
      debit.walletTransaction.id,
      journalTxnId,
      Number(event.id),
      input.reason ?? 'Referral reward reversal',
      event.terms_snapshot ? JSON.stringify(event.terms_snapshot) : null,
    ]
  );

  await tx.query(
    `UPDATE referral_codes
        SET reward_balance = reward_balance + $3::NUMERIC(19,4)
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(event.referral_code_id), formatDecimal4(amount4)]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_REWARD_REVERSED',
    tableName: 'referral_events',
    recordId: Number(event.id),
    newValues: {
      reversalEventId: Number(ins.rows[0].id),
      amount: formatDecimal4(amount4),
      walletTxnId: debit.walletTransaction.id,
      journalTxnId,
      negativeBalance: Number(debit.negativeBalance4) / 10000,
    },
  });

  return {
    originalEventId: Number(event.id),
    reversalEventId: Number(ins.rows[0].id),
    reversalAmount: Number(amount4) / 10000,
    negativeBalance: Number(debit.negativeBalance4) / 10000,
    journalTxnId,
    walletTxnId: debit.walletTransaction.id,
    idempotentReplay: walletIdempotentReplay,
  };
}