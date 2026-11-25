-- Forward migration: partial stock transfer receipts.
-- Adds received_qty tracking per transfer line and allows partially_received status.

ALTER TABLE stock_transfer_lines
  ADD COLUMN IF NOT EXISTS received_qty NUMERIC(19, 6) NOT NULL DEFAULT 0.000000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_stock_transfer_lines_received_qty'
  ) THEN
    ALTER TABLE stock_transfer_lines
      ADD CONSTRAINT ck_stock_transfer_lines_received_qty
      CHECK (received_qty >= 0 AND received_qty <= quantity);
  END IF;
END $$;

-- Backfill: posted transfers are fully received; in_transit remain 0 unless already received.
UPDATE stock_transfer_lines l
   SET received_qty = l.quantity
  FROM stock_transfers t
 WHERE t.company_id = l.company_id
   AND t.id = l.transfer_id
   AND t.status = 'posted'
   AND l.received_qty = 0;

ALTER TABLE stock_transfers ALTER COLUMN status TYPE VARCHAR(32);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_transfers_status_check') THEN
    ALTER TABLE stock_transfers DROP CONSTRAINT stock_transfers_status_check;
  END IF;
END $$;
ALTER TABLE stock_transfers
  ADD CONSTRAINT stock_transfers_status_check
  CHECK (status IN ('draft', 'in_transit', 'partially_received', 'posted', 'voided'));
