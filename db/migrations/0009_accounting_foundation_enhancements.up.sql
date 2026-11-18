-- Migration 0009: Phase 4 Accounting Foundation Enhancements
-- Adds atomic stored account balance, journal idempotency key, closing_entry source type,
-- fiscal period closing linkage, and strict closed-period trigger enforcement.

-- 1. Stored Account Balance (atomically maintained in ascending account_id order + rebuildable from journal_lines)
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS balance NUMERIC(19, 4) NOT NULL DEFAULT 0.0000;

-- 2. Journal Idempotency & Closing Entry Source Type
ALTER TABLE journal_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_txns_company_idempotency
  ON journal_transactions (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE journal_transactions
  DROP CONSTRAINT IF EXISTS journal_transactions_source_type_check;

ALTER TABLE journal_transactions
  ADD CONSTRAINT journal_transactions_source_type_check CHECK (source_type IN (
    'manual', 'invoice', 'payment', 'credit_memo', 'bill', 'bill_payment', 'vendor_credit',
    'payroll', 'reconciliation', 'inventory_adjustment', 'depreciation',
    'printing_contract', 'quick_print', 'exam_production', 'opening_balance', 'reversal',
    'closing_entry'
  ));

-- 3. Fiscal Period Closing Audit & Traceable Closing Entry Link
ALTER TABLE fiscal_periods
  ADD COLUMN IF NOT EXISTS closing_txn_id BIGINT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS reopened_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;

ALTER TABLE fiscal_periods
  DROP CONSTRAINT IF EXISTS fk_fiscal_periods_closing_txn;

ALTER TABLE fiscal_periods
  ADD CONSTRAINT fk_fiscal_periods_closing_txn
  FOREIGN KEY (company_id, closing_txn_id)
  REFERENCES journal_transactions (company_id, id) ON DELETE RESTRICT;

-- 4. Tighten Closed Fiscal Period Lock in Trigger (blocks BOTH postings and reversals once status = 'closed')
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

  -- Strictly block any posted journal (including reversals) into a closed fiscal period,
  -- except the period's own linked year-end/period closing entry.
  SELECT period_name INTO v_closed_period
    FROM fiscal_periods
   WHERE company_id = v_company_id
     AND status = 'closed'
     AND v_txn_date BETWEEN start_date AND end_date
     AND NOT (v_source_type = 'closing_entry' AND closing_txn_id = v_txn_id)
   LIMIT 1;

  IF v_closed_period IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot post journal % into closed fiscal period "%"', v_txn_id, v_closed_period
      USING ERRCODE = 'check_violation';
  END IF;

  -- Check accrual/both and cash/both views balance cleanly
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
