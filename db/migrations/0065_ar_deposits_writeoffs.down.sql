-- Migration 0065 rollback: AR Deposits, Write-offs, and Dispute Holds.

DROP TABLE IF EXISTS customer_deposit_allocations;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS ck_invoices_balance_math;

ALTER TABLE invoices
  DROP COLUMN IF EXISTS deposit_applied_amount,
  DROP COLUMN IF EXISTS write_off_amount,
  DROP COLUMN IF EXISTS write_off_reason,
  DROP COLUMN IF EXISTS write_off_journal_id,
  DROP COLUMN IF EXISTS disputed_at,
  DROP COLUMN IF EXISTS dispute_reason;

ALTER TABLE invoices
  ADD CONSTRAINT ck_invoices_balance_math
  CHECK (amount_paid + balance_due = total);
