-- Forward fix for environments that already applied 0067 before 2-step transfer JE/status fields.
-- Idempotent.

ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS transfer_mode TEXT NOT NULL DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS received_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispatch_journal_txn_id BIGINT REFERENCES journal_transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receive_journal_txn_id BIGINT REFERENCES journal_transactions(id) ON DELETE SET NULL;

ALTER TABLE stock_transfer_lines
  ADD COLUMN IF NOT EXISTS received_qty NUMERIC(19, 6) NOT NULL DEFAULT 0.000000;

ALTER TABLE stock_transfers ALTER COLUMN status TYPE VARCHAR(32);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_transfers_status_check') THEN
    ALTER TABLE stock_transfers DROP CONSTRAINT stock_transfers_status_check;
  END IF;
END $$;
ALTER TABLE stock_transfers
  ADD CONSTRAINT stock_transfers_status_check
  CHECK (status IN ('draft', 'in_transit', 'partially_received', 'posted', 'voided'));

ALTER TABLE journal_transactions DROP CONSTRAINT IF EXISTS journal_transactions_source_type_check;
ALTER TABLE journal_transactions
  ADD CONSTRAINT journal_transactions_source_type_check CHECK (source_type IN (
    'manual', 'invoice', 'sales_receipt', 'pos_sale', 'payment', 'credit_memo',
    'bill', 'bill_payment', 'vendor_credit', 'goods_receipt',
    'deposit', 'transfer', 'check', 'expense', 'expense_claim', 'credit_card_charge', 'bank_import',
    'payroll', 'reconciliation', 'inventory_adjustment', 'inventory_damage', 'inventory_transfer', 'stock_count', 'depreciation',
    'printing_contract', 'quick_print', 'exam_production',
    'production_wip', 'production_issue', 'production_operation', 'production_cogs', 'production_variance',
    'referral_reward', 'marketing_expense',
    'opening_balance', 'reversal', 'closing_entry', 'fx_gain_loss',
    'customer_wallet'
  ));
