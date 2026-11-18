-- Rollback Migration 0009: Phase 4 Accounting Foundation Enhancements

-- Restore prior enforce_balanced_journal trigger behavior
CREATE OR REPLACE FUNCTION enforce_balanced_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_txn_id BIGINT;
  v_company_id BIGINT;
  v_is_posted BOOLEAN;
  v_line_count INTEGER;
  v_diff NUMERIC(19, 4);
  v_total NUMERIC(19, 4);
  v_txn_date DATE;
  v_source_type VARCHAR(40);
  v_closed_period VARCHAR(60);
BEGIN
  IF TG_TABLE_NAME = 'journal_transactions' THEN
    v_txn_id := COALESCE(NEW.id, OLD.id);
    v_company_id := COALESCE(NEW.company_id, OLD.company_id);
  ELSE
    v_txn_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
    v_company_id := COALESCE(NEW.company_id, OLD.company_id);
  END IF;

  IF v_txn_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT is_posted, txn_date, source_type
    INTO v_is_posted, v_txn_date, v_source_type
    FROM journal_transactions
   WHERE id = v_txn_id AND company_id = v_company_id;

  IF NOT FOUND OR NOT v_is_posted THEN
    RETURN NULL;
  END IF;

  SELECT period_name INTO v_closed_period
    FROM fiscal_periods
   WHERE company_id = v_company_id
     AND status = 'closed'
     AND v_txn_date BETWEEN start_date AND end_date
   LIMIT 1;

  IF v_closed_period IS NOT NULL AND v_source_type <> 'reversal' THEN
    RAISE EXCEPTION 'Cannot post journal % into closed fiscal period "%"', v_txn_id, v_closed_period
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*),
         COALESCE(SUM(debit), 0),
         COALESCE(SUM(debit - credit), 0)
    INTO v_line_count, v_total, v_diff
    FROM journal_lines
   WHERE transaction_id = v_txn_id
     AND company_id = v_company_id
     AND basis IN ('both', 'accrual');

  IF v_line_count > 0 AND v_diff <> 0 THEN
    RAISE EXCEPTION 'Unbalanced journal transaction % (company %): accrual/both debit-credit difference = %',
      v_txn_id, v_company_id, v_diff
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*),
         COALESCE(SUM(debit - credit), 0)
    INTO v_line_count, v_diff
    FROM journal_lines
   WHERE transaction_id = v_txn_id
     AND company_id = v_company_id
     AND basis IN ('both', 'cash');

  IF v_line_count > 0 AND v_diff <> 0 THEN
    RAISE EXCEPTION 'Unbalanced journal transaction % (company %): cash/both debit-credit difference = %',
      v_txn_id, v_company_id, v_diff
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total <= 0 AND NOT EXISTS (
    SELECT 1 FROM journal_lines WHERE transaction_id = v_txn_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Posted journal transaction % has zero journal lines', v_txn_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

ALTER TABLE fiscal_periods
  DROP CONSTRAINT IF EXISTS fk_fiscal_periods_closing_txn,
  DROP COLUMN IF EXISTS closing_txn_id,
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS reopened_by,
  DROP COLUMN IF EXISTS reopened_at;

DROP INDEX IF EXISTS uq_journal_txns_company_idempotency;

ALTER TABLE journal_transactions
  DROP COLUMN IF EXISTS idempotency_key;

ALTER TABLE journal_transactions
  DROP CONSTRAINT IF EXISTS journal_transactions_source_type_check;

ALTER TABLE journal_transactions
  ADD CONSTRAINT journal_transactions_source_type_check CHECK (source_type IN (
    'manual', 'invoice', 'payment', 'credit_memo', 'bill', 'bill_payment', 'vendor_credit',
    'payroll', 'reconciliation', 'inventory_adjustment', 'depreciation',
    'printing_contract', 'quick_print', 'exam_production', 'opening_balance', 'reversal'
  ));

ALTER TABLE accounts
  DROP COLUMN IF EXISTS balance;
