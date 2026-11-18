-- 0017_inventory_ops_and_read_models.down.sql
--
-- Reverts 0017. Drops in reverse dependency order and restores the original
-- inventory_movements.movement_type CHECK (the seven types from 0005).

DROP POLICY IF EXISTS p_stock_damages_isolation ON stock_damages;
DROP TABLE IF EXISTS stock_damages;

DROP POLICY IF EXISTS p_stock_transfer_lines_isolation ON stock_transfer_lines;
DROP TABLE IF EXISTS stock_transfer_lines;

DROP POLICY IF EXISTS p_stock_transfers_isolation ON stock_transfers;
DROP TABLE IF EXISTS stock_transfers;

DROP POLICY IF EXISTS p_stock_count_lines_isolation ON stock_count_lines;
DROP TABLE IF EXISTS stock_count_lines;

DROP POLICY IF EXISTS p_stock_counts_isolation ON stock_counts;
DROP TABLE IF EXISTS stock_counts;

DROP INDEX IF EXISTS ix_inv_movements_item_created;

ALTER TABLE inventory_items
  DROP COLUMN IF EXISTS location;

ALTER TABLE inventory_movements
  DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type IN (
    'purchase', 'sale', 'production_consume', 'adjustment',
    'return_in', 'return_out', 'void'
  ));