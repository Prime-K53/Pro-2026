-- Rollback Migration 0033: POS Governance.

-- 6. Revert shift_id from pos_orders.
DROP INDEX IF EXISTS idx_pos_orders_shift;
ALTER TABLE pos_orders DROP COLUMN IF EXISTS shift_id;

-- 5. Drop pos_shift_audit.
DROP TABLE IF EXISTS pos_shift_audit;

-- 4. Revert barcode column on inventory_items.
ALTER TABLE inventory_items DROP COLUMN IF EXISTS barcode;
DROP INDEX IF EXISTS uq_inventory_items_company_barcode;

-- 3. Drop pos_transactions.
DROP TABLE IF EXISTS pos_transactions;

-- 2. Drop pos_suspended_sales.
DROP TABLE IF EXISTS pos_suspended_sales;

-- 1. Drop pos_shifts.
DROP TABLE IF EXISTS pos_shifts;