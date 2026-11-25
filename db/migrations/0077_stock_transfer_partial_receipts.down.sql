ALTER TABLE stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_status_check;
ALTER TABLE stock_transfers
  ADD CONSTRAINT stock_transfers_status_check
  CHECK (status IN ('draft', 'in_transit', 'posted', 'voided'));
ALTER TABLE stock_transfer_lines DROP CONSTRAINT IF EXISTS ck_stock_transfer_lines_received_qty;
ALTER TABLE stock_transfer_lines DROP COLUMN IF EXISTS received_qty;
