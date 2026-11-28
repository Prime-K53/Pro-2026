-- Migration 0092: supplier lead time for shortage forecasting (Phase 6).
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS lead_time_days INTEGER;