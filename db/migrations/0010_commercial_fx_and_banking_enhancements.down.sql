-- Rollback Migration 0010: Commercial FX & Banking Enhancements

ALTER TABLE journal_transactions
  DROP CONSTRAINT IF EXISTS journal_transactions_source_type_check;

ALTER TABLE journal_transactions
  ADD CONSTRAINT journal_transactions_source_type_check CHECK (source_type IN (
    'manual', 'invoice', 'payment', 'credit_memo', 'bill', 'bill_payment', 'vendor_credit',
    'payroll', 'reconciliation', 'inventory_adjustment', 'depreciation',
    'printing_contract', 'quick_print', 'exam_production', 'opening_balance', 'reversal',
    'closing_entry'
  ));

ALTER TABLE saved_reports
  DROP COLUMN IF EXISTS last_run_at,
  DROP COLUMN IF EXISTS updated_at;

ALTER TABLE recurring_invoices
  DROP COLUMN IF EXISTS generated_count,
  DROP COLUMN IF EXISTS last_generated_date;

ALTER TABLE reconciliations
  DROP COLUMN IF EXISTS reversal_reason,
  DROP COLUMN IF EXISTS reversed_at,
  DROP COLUMN IF EXISTS reversed_by,
  DROP COLUMN IF EXISTS status;

ALTER TABLE bank_transactions
  DROP CONSTRAINT IF EXISTS fk_bank_txns_customer,
  DROP CONSTRAINT IF EXISTS fk_bank_txns_vendor,
  DROP CONSTRAINT IF EXISTS fk_bank_txns_offset_acct;

ALTER TABLE bank_transactions
  DROP COLUMN IF EXISTS customer_id,
  DROP COLUMN IF EXISTS vendor_id,
  DROP COLUMN IF EXISTS matched_rule_id,
  DROP COLUMN IF EXISTS transfer_pair_txn_id,
  DROP COLUMN IF EXISTS offset_account_id,
  DROP COLUMN IF EXISTS status;

ALTER TABLE bank_transactions
  DROP CONSTRAINT IF EXISTS bank_transactions_txn_type_check;

ALTER TABLE bank_transactions
  ADD CONSTRAINT bank_transactions_txn_type_check CHECK (txn_type IN (
    'Check', 'Deposit', 'Transfer', 'Bill Payment', 'Debit', 'Fee'
  ));

ALTER TABLE bill_payments
  DROP COLUMN IF EXISTS foreign_amount,
  DROP COLUMN IF EXISTS exchange_rate,
  DROP COLUMN IF EXISTS currency_code;

ALTER TABLE bill_lines
  DROP COLUMN IF EXISTS po_line_id;

ALTER TABLE bills
  DROP CONSTRAINT IF EXISTS fk_bills_po;

ALTER TABLE bills
  DROP COLUMN IF EXISTS foreign_balance_due,
  DROP COLUMN IF EXISTS foreign_total,
  DROP COLUMN IF EXISTS exchange_rate,
  DROP COLUMN IF EXISTS currency_code,
  DROP COLUMN IF EXISTS purchase_order_id;

ALTER TABLE payments
  DROP COLUMN IF EXISTS foreign_amount,
  DROP COLUMN IF EXISTS exchange_rate,
  DROP COLUMN IF EXISTS currency_code;

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS fk_invoices_deposit_acct;

ALTER TABLE invoices
  DROP COLUMN IF EXISTS deposit_to_account_id,
  DROP COLUMN IF EXISTS foreign_balance_due,
  DROP COLUMN IF EXISTS foreign_total,
  DROP COLUMN IF EXISTS exchange_rate,
  DROP COLUMN IF EXISTS currency_code;

DROP POLICY IF EXISTS p_exchange_rates_isolation ON exchange_rates;
DROP INDEX IF EXISTS uq_exchange_rates_company_pair_date;
DROP TABLE IF EXISTS exchange_rates;
