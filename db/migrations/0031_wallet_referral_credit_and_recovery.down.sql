-- Migration 0031 DOWN: restore the original positive-only wallet constraints.
-- This will fail if any referral_reversal has driven a wallet negative; that is
-- intentional — production data must be remediated before rollback.

-- 3. Restore the wallet balance >= 0 column check.
ALTER TABLE customer_wallets
  ADD CONSTRAINT customer_wallets_balance_check CHECK (balance >= 0);

-- 2. Restore the positive-only balance_after check.
ALTER TABLE customer_wallet_transactions DROP CONSTRAINT IF EXISTS customer_wallet_transactions_balance_after_check;
ALTER TABLE customer_wallet_transactions
  ADD CONSTRAINT customer_wallet_transactions_balance_after_check CHECK (balance_after >= 0);

-- 1. Restore the original transaction type vocabulary.
ALTER TABLE customer_wallet_transactions DROP CONSTRAINT IF EXISTS customer_wallet_transactions_txn_type_check;
ALTER TABLE customer_wallet_transactions
  ADD CONSTRAINT customer_wallet_transactions_txn_type_check CHECK (txn_type IN (
    'deposit', 'allocation', 'release', 'invoice_payment',
    'sales_order_payment', 'refund', 'reversal', 'adjustment'
  ));