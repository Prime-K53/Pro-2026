-- Migration 0068 rollback
DROP TABLE IF EXISTS expense_claims;

ALTER TABLE journal_transactions DROP CONSTRAINT IF EXISTS journal_transactions_source_type_check;
ALTER TABLE journal_transactions
  ADD CONSTRAINT journal_transactions_source_type_check CHECK (source_type IN (
    'manual', 'invoice', 'sales_receipt', 'pos_sale', 'payment', 'credit_memo',
    'bill', 'bill_payment', 'vendor_credit', 'goods_receipt',
    'deposit', 'transfer', 'check', 'expense', 'credit_card_charge', 'bank_import',
    'payroll', 'reconciliation', 'inventory_adjustment', 'inventory_damage', 'inventory_transfer', 'stock_count', 'depreciation',
    'printing_contract', 'quick_print', 'exam_production',
    'production_wip', 'production_issue', 'production_operation', 'production_cogs', 'production_variance',
    'referral_reward', 'marketing_expense',
    'opening_balance', 'reversal', 'closing_entry', 'fx_gain_loss',
    'customer_wallet'
  ));
