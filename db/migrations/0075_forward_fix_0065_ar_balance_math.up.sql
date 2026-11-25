-- Forward fix for environments that already applied 0065 before write_off_amount was included
-- in ck_invoices_balance_math. Idempotent.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS deposit_applied_amount NUMERIC(19, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS write_off_amount NUMERIC(19, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS write_off_reason TEXT,
  ADD COLUMN IF NOT EXISTS write_off_journal_id BIGINT,
  ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispute_reason TEXT;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS ck_invoices_balance_math;
ALTER TABLE invoices
  ADD CONSTRAINT ck_invoices_balance_math
  CHECK (amount_paid + balance_due + COALESCE(write_off_amount, 0) = total);
