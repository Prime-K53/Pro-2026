-- Migration 0067 rollback

ALTER TABLE stock_damages
  DROP COLUMN IF EXISTS job_reference,
  DROP COLUMN IF EXISTS scrap_type;

ALTER TABLE stock_transfers
  DROP COLUMN IF EXISTS transfer_mode,
  DROP COLUMN IF EXISTS dispatched_at,
  DROP COLUMN IF EXISTS received_at,
  DROP COLUMN IF EXISTS received_by_user_id,
  DROP COLUMN IF EXISTS dispatch_journal_txn_id,
  DROP COLUMN IF EXISTS receive_journal_txn_id;

ALTER TABLE stock_transfer_lines DROP CONSTRAINT IF EXISTS fk_stock_transfer_lines_lot;
ALTER TABLE stock_transfer_lines DROP COLUMN IF EXISTS lot_id;

DROP TABLE IF EXISTS inventory_lots;
