-- Rollback Migration 0086: drop the persisted attempt period.
BEGIN;
DROP INDEX IF EXISTS ai_usage_attempts_period_idx;
ALTER TABLE ai_usage_attempts DROP COLUMN IF EXISTS period;
COMMIT;