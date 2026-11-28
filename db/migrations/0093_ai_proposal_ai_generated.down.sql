-- Rollback Migration 0093.
ALTER TABLE ai_proposed_actions DROP COLUMN IF EXISTS created_by_ai;