-- Migration 0031: Existing customer wallet — referral reward / reversal transaction
-- types and narrowly-scoped negative-balance recovery (D-03-A).
--
-- Design (D-03-A):
--   * Referral rewards are credited through the EXISTING customer wallet ledger
--     using new transaction types 'referral_reward' and 'referral_reversal'.
--   * A negative wallet balance may only be produced by a 'referral_reversal'
--     debit. Ordinary spend paths (allocation / invoice payment / refund /
--     adjustment) remain blocked at zero at the service layer, and the database
--     rejects any non-referral debit that would drive balance_after below zero.
--   * Credit transactions (deposits and recovery credits) may carry a negative
--     balance_after while the negative recovery is still being repaid.
--   * The deferred balance-reconciliation trigger (wallet.balance == ledger sum)
--     is preserved unchanged, so wallet/ledger drift remains impossible.
--   * The exact unrecovered amount is enforced in the service layer by capping a
--     reversal at the original reward amount and debiting exactly that amount.

-- 1. Widen the wallet transaction type vocabulary with referral types.
ALTER TABLE customer_wallet_transactions DROP CONSTRAINT IF EXISTS customer_wallet_transactions_txn_type_check;
ALTER TABLE customer_wallet_transactions
  ADD CONSTRAINT customer_wallet_transactions_txn_type_check CHECK (txn_type IN (
    'deposit', 'allocation', 'release', 'invoice_payment',
    'sales_order_payment', 'refund', 'reversal', 'adjustment',
    'referral_reward', 'referral_reversal'
  ));

-- 2. Replace the blanket positive-only balance_after check with a narrowly scoped
--    control: only a referral_reversal debit may produce a negative balance_after.
ALTER TABLE customer_wallet_transactions DROP CONSTRAINT IF EXISTS customer_wallet_transactions_balance_after_check;
ALTER TABLE customer_wallet_transactions
  ADD CONSTRAINT customer_wallet_transactions_balance_after_check
  CHECK (balance_after >= 0 OR direction = 'credit' OR txn_type = 'referral_reversal');

-- 3. The wallet balance column can no longer be constrained to >= 0 at the column
--    level, because a referral_reversal may drive it negative. The invariant is
--    enforced by (a) the transaction-level check above, (b) the deferred
--    balance-reconciliation trigger, and (c) service-layer spend guards.
ALTER TABLE customer_wallets DROP CONSTRAINT IF EXISTS customer_wallets_balance_check;