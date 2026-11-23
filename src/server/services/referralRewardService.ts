import { Transaction } from '@electric-sql/pglite';
import { AccountingError, ActorContext, postJournalEntry } from './accountingEngine.ts';
import { consumeApprovalRequest } from './approvalService.ts';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import {
  creditWalletForReferralReward,
  resolveWalletLiabilityAccount,
} from './customerWalletService.ts';

/**
 * Referral reward service — qualification-gated credit through the EXISTING
 * customer wallet (D-02-B, F4-A, F5-A, A1-C).
 *
 * Accounting (D-02-B):
 *   Dr  approved referral reward expense
 *   Cr  approved existing customer-wallet liability
 * The wallet credit and the journal represent the same event, posted atomically
 * in the caller's transaction. No bank leg is used.
 *
 * Threshold governance (A1-C): rewards at or above the campaign approval
 * threshold require an approved `referral_reward_approval` request; rewards
 * below the threshold are credited automatically after qualification.
 */

export interface RewardCreditResult {
  eventId: number;
  status: string;
  walletTxnId: number | null;
  journalTxnId: number | null;
  amount: number;
  idempotentReplay: boolean;
}

async function loadEventForReward(tx: Transaction, companyId: number, eventId: number) {
  const res = await tx.query<any>(
    `SELECT re.*, rc.referrer_customer_id, rc.referrer_name, rc.code AS referral_code,
            rp.reward_expense_account_id
       FROM referral_events re
       JOIN referral_codes rc ON rc.company_id = re.company_id AND rc.id = re.referral_code_id
       JOIN referral_programs rp ON rp.company_id = re.company_id AND rp.id = re.program_id
      WHERE re.company_id = $1 AND re.id = $2
      FOR UPDATE`,
    [companyId, eventId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Referral reward event not found', 'REFERRAL_EVENT_NOT_FOUND');
  }
  return res.rows[0];
}

async function assertRewardApprovalIfRequired(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  event: any,
  reward4: bigint
): Promise<void> {
  const snapshot = (event.terms_snapshot as any) || null;
  const threshold4 =
    snapshot?.rewardApprovalThreshold4 != null
      ? parseDecimal4(String(snapshot.rewardApprovalThreshold4))
      : null;

  if (threshold4 == null) {
    // No threshold configured → require explicit approval (fail safe).
    throw new AccountingError(
      409,
      'Reward approval threshold is not configured; reward cannot be credited',
      'REFERRAL_THRESHOLD_UNCONFIGURED'
    );
  }

  if (reward4 < threshold4) return; // below threshold → auto-creditable

  const approvalRequestId = event.approval_request_id != null ? Number(event.approval_request_id) : null;
  if (!approvalRequestId) {
    throw new AccountingError(
      409,
      'Reward meets or exceeds the approval threshold and requires authorisation',
      'REFERRAL_REWARD_APPROVAL_REQUIRED'
    );
  }
  const approval = await tx.query<{ status: string; action_type: string; consumed_at: string | null }>(
    `SELECT status, action_type, consumed_at FROM approval_requests WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, approvalRequestId]
  );
  if (approval.rows.length === 0) {
    throw new AccountingError(404, 'Approval request not found', 'APPROVAL_NOT_FOUND');
  }
  const req = approval.rows[0];
  if (req.action_type !== 'referral_reward_approval' || req.status !== 'approved') {
    throw new AccountingError(
      409,
      'Reward meets the approval threshold but has not been approved',
      'REFERRAL_REWARD_APPROVAL_INVALID'
    );
  }
  // Consume the approval exactly once (A1-C, A2-C).
  if (!req.consumed_at) {
    await consumeApprovalRequest(tx, companyId, actor, approvalRequestId, 'referral_event', Number(event.id));
  }
}

/**
 * Credit an approved, qualified referral reward into the referrer's existing
 * customer wallet and post the D-02-B journal. Idempotent by event and by
 * deterministic wallet/journal keys.
 */
export async function creditReferralRewardToWallet(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { eventId: number; expenseAccountId: number }
): Promise<RewardCreditResult> {
  const event = await loadEventForReward(tx, companyId, Number(input.eventId));
  const eventId = Number(event.id);

  if ((event.status === 'credited' || event.status === 'paid') && event.wallet_txn_id != null) {
    return {
      eventId,
      status: String(event.status),
      walletTxnId: Number(event.wallet_txn_id),
      journalTxnId: event.payout_journal_txn_id != null ? Number(event.payout_journal_txn_id) : null,
      amount: Number(parseDecimal4(String(event.reward_amount))) / 10000,
      idempotentReplay: true,
    };
  }
  if (event.status === 'voided' || event.status === 'reversed') {
    throw new AccountingError(409, 'Voided or reversed reward cannot be credited', 'REFERRAL_REWARD_VOID');
  }
  if (event.status !== 'approved') {
    throw new AccountingError(
      409,
      'Referral reward must be qualified (approved) before it can be credited',
      'REFERRAL_REWARD_NOT_QUALIFIED'
    );
  }
  if (event.fraud_hold) {
    throw new AccountingError(409, 'Referral reward is on fraud hold', 'REFERRAL_FRAUD_HOLD');
  }

  const reward4 = parseDecimal4(String(event.reward_amount));
  if (reward4 <= 0n) {
    throw new AccountingError(400, 'Reward amount is zero; nothing to credit', 'REFERRAL_ZERO_REWARD');
  }

  await assertRewardApprovalIfRequired(tx, companyId, actor, event, reward4);

  const referrerCustomerId = event.referrer_customer_id != null ? Number(event.referrer_customer_id) : null;
  if (!referrerCustomerId) {
    throw new AccountingError(
      400,
      'Referral code is not linked to an existing customer wallet owner',
      'REFERRAL_REFERRER_CUSTOMER_MISSING'
    );
  }

  const walletLiabilityAccountId = await resolveWalletLiabilityAccount(tx, companyId);
  const expenseAccountId = Number(input.expenseAccountId);

  const je = await postJournalEntry(tx, companyId, actor, {
    txnDate: todayDate(),
    description: `Referral Reward Credit — ${event.referral_code}`,
    reference: `REF-REWARD-${eventId}`,
    sourceType: 'referral_reward',
    sourceId: eventId,
    idempotencyKey: `ref-reward-je-${companyId}-${eventId}`,
    lines: [
      {
        accountId: expenseAccountId,
        debit: formatDecimal4(reward4),
        credit: '0.0000',
        description: `Referral reward expense (${event.referral_code})`,
      },
      {
        accountId: walletLiabilityAccountId,
        debit: '0.0000',
        credit: formatDecimal4(reward4),
        description: `Customer wallet liability (${event.referral_code})`,
        partyType: 'customer',
        partyId: referrerCustomerId,
      },
    ],
  });

  const credit = await creditWalletForReferralReward(tx, companyId, actor, {
    customerId: referrerCustomerId,
    amount: formatDecimal4(reward4),
    referenceType: 'referral_event',
    referenceId: eventId,
    journalTxnId: je.transaction.id,
    idempotencyKey: `ref-reward-wtx-${companyId}-${eventId}`,
    description: `Referral reward for ${event.referral_code}`,
    notes: `Referral event #${eventId}`,
  });

  await tx.query(
    `UPDATE referral_events
        SET status = 'credited',
            payout_method = 'wallet',
            payout_account_id = NULL,
            wallet_txn_id = $3,
            payout_journal_txn_id = $4,
            rewarded_at = NOW()
      WHERE company_id = $1 AND id = $2`,
    [companyId, eventId, credit.walletTransaction.id, je.transaction.id]
  );

  await tx.query(
    `UPDATE referral_codes
        SET reward_balance = GREATEST(0, reward_balance - $3::NUMERIC(19,4))
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(event.referral_code_id), formatDecimal4(reward4)]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REFERRAL_REWARD_CREDITED',
    tableName: 'referral_events',
    recordId: eventId,
    newValues: {
      amount: formatDecimal4(reward4),
      walletTxnId: credit.walletTransaction.id,
      journalTxnId: je.transaction.id,
      idempotentReplay: credit.idempotentReplay,
    },
  });

  return {
    eventId,
    status: 'credited',
    walletTxnId: credit.walletTransaction.id,
    journalTxnId: je.transaction.id,
    amount: Number(reward4) / 10000,
    idempotentReplay: credit.idempotentReplay,
  };
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}