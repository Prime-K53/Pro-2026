-- Rollback Migration 0092.
ALTER TABLE inventory_items DROP COLUMN IF EXISTS lead_time_days;