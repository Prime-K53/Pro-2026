-- 0018_stock_balances_by_location.down.sql

ALTER TABLE journal_transactions
  DROP CONSTRAINT IF EXISTS journal_transactions_source_type_check;

ALTER TABLE journal_transactions
  ADD CONSTRAINT journal_transactions_source_type_check CHECK (source_type IN (
    'manual', 'invoice', 'sales_receipt', 'payment', 'credit_memo',
    'bill', 'bill_payment', 'vendor_credit', 'goods_receipt',
    'deposit', 'transfer', 'check', 'expense', 'credit_card_charge', 'bank_import',
    'payroll', 'reconciliation', 'inventory_adjustment', 'depreciation',
    'printing_contract', 'quick_print', 'exam_production',
    'production_wip', 'production_issue', 'production_operation', 'production_cogs', 'production_variance',
    'opening_balance', 'reversal', 'closing_entry', 'fx_gain_loss'
  ));

ALTER TABLE inventory_movements
  DROP COLUMN IF EXISTS location;

DROP INDEX IF EXISTS ix_job_mat_req_item;
DROP INDEX IF EXISTS ix_invoice_lines_item;
DROP INDEX IF EXISTS ix_bill_lines_item;

DROP POLICY IF EXISTS p_stock_balances_isolation ON stock_balances;
DROP TABLE IF EXISTS stock_balances;