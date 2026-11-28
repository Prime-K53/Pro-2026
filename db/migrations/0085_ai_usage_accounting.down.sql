-- Rollback Migration 0085: AI usage accounting.
BEGIN;
DROP TABLE IF EXISTS ai_usage_attempts;
DROP TABLE IF EXISTS ai_budget_usage;
COMMIT;