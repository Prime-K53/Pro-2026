-- Rollback Migration 0084: AI proposed-action maker-checker columns.
--
-- Restores the pre-0084 ai_proposed_actions shape. Legacy rows are not
-- affected beyond losing the (nullable) approver/executor audit columns.

BEGIN;

ALTER TABLE ai_proposed_actions DROP CONSTRAINT IF EXISTS chk_ai_action_executed_identity;
ALTER TABLE ai_proposed_actions DROP CONSTRAINT IF EXISTS chk_ai_action_approved_identity;
ALTER TABLE ai_proposed_actions DROP CONSTRAINT IF EXISTS chk_ai_action_creator_not_executor;
ALTER TABLE ai_proposed_actions DROP CONSTRAINT IF EXISTS chk_ai_action_creator_not_approver;

ALTER TABLE ai_proposed_actions DROP COLUMN IF EXISTS executed_at;
ALTER TABLE ai_proposed_actions DROP COLUMN IF EXISTS executed_by;
ALTER TABLE ai_proposed_actions DROP COLUMN IF EXISTS approved_at;
ALTER TABLE ai_proposed_actions DROP COLUMN IF EXISTS approved_by;

COMMIT;