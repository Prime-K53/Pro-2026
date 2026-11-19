-- Rollback Migration 0020: Company-Wide Customer Wallet Subledger
-- WARNING: This down migration drops wallet tables and data. It is intended for
-- disposable test databases only. Never run it against production.

-- 1. Drop triggers
DROP TRIGGER IF EXISTS trg_customer_wallet_balance_check ON customer_wallet_transactions;
DROP TRIGGER IF EXISTS trg_customer_wallet_txns_immutable ON customer_wallet_transactions;
DROP TRIGGER IF EXISTS trg_customer_wallet_allocations_updated_at ON customer_wallet_allocations;
DROP TRIGGER IF EXISTS trg_customer_wallets_updated_at ON customer_wallets;

-- 2. Drop functions
DROP FUNCTION IF EXISTS next_printing_number(BIGINT, TEXT, SMALLINT, TEXT, INT);
DROP FUNCTION IF EXISTS trg_customer_wallet_balance_check();
DROP FUNCTION IF EXISTS trg_customer_wallet_txns_immutable();

-- 3. Drop tables
DROP TABLE IF EXISTS customer_wallet_transactions;
DROP TABLE IF EXISTS customer_wallet_allocations;
DROP TABLE IF EXISTS customer_wallets;
DROP TABLE IF EXISTS printing_number_counters;

-- 4. Revert companies.timezone
ALTER TABLE companies DROP COLUMN IF EXISTS timezone;

-- 5. Revert journal source type constraint
ALTER TABLE journal_transactions
  DROP CONSTRAINT IF EXISTS journal_transactions_source_type_check;

ALTER TABLE journal_transactions
  ADD CONSTRAINT journal_transactions_source_type_check CHECK (source_type IN (
    'manual', 'invoice', 'sales_receipt', 'pos_sale', 'payment', 'credit_memo',
    'bill', 'bill_payment', 'vendor_credit', 'goods_receipt',
    'deposit', 'transfer', 'check', 'expense', 'credit_card_charge', 'bank_import',
    'payroll', 'reconciliation', 'inventory_adjustment', 'inventory_damage', 'stock_count', 'depreciation',
    'printing_contract', 'quick_print', 'exam_production',
    'production_wip', 'production_issue', 'production_operation', 'production_cogs', 'production_variance',
    'referral_reward', 'marketing_expense',
    'opening_balance', 'reversal', 'closing_entry', 'fx_gain_loss'
  ));

-- 6. Revert payments payment method constraint
ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_payment_method_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_payment_method_check CHECK (payment_method IN (
    'Check', 'Credit Card', 'Cash', 'ACH / Wire', 'Mobile Money'
  ));

-- 7. Revert approval action type constraints
ALTER TABLE approval_policies
  DROP CONSTRAINT IF EXISTS approval_policies_action_type_check;

ALTER TABLE approval_policies
  ADD CONSTRAINT approval_policies_action_type_check CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive'
  ));

ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_action_type_check CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive'
  ));