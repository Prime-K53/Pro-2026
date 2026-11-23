-- Rollback Migration 0044: POS cash-drawer movements.

DROP TABLE IF EXISTS pos_cash_movements;
ALTER TABLE pos_shifts
  DROP COLUMN IF EXISTS cash_refunds,
  DROP COLUMN IF EXISTS cash_deposits;