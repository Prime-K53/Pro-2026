DROP TABLE IF EXISTS accounting_control_events;
ALTER TABLE journal_transactions
  DROP COLUMN IF EXISTS approval_status,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS reversal_reason;
