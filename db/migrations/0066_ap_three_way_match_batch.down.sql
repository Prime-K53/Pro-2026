-- Migration 0066 rollback: AP three-way match, payment holds, and batch payment run support.

DROP TABLE IF EXISTS ap_payment_run_items;
DROP TABLE IF EXISTS ap_payment_runs;
DROP TABLE IF EXISTS bill_match_discrepancies;

ALTER TABLE bills
  DROP COLUMN IF EXISTS match_status,
  DROP COLUMN IF EXISTS payment_hold,
  DROP COLUMN IF EXISTS payment_hold_reason,
  DROP COLUMN IF EXISTS payment_hold_at,
  DROP COLUMN IF EXISTS payment_hold_by_user_id;
