-- 0084_ai_proposed_action_maker_checker
--
-- D-02 maker-checker hardening for AI proposed financial actions.
-- Persist approver/executor identity and timestamps and enforce, at the
-- database level, that a creator can never approve or execute their own
-- action.
--
-- Additive and backward-compatible:
--   * New columns are nullable so legacy rows are preserved as-is.
--   * The status/identity CHECK constraints are added NOT VALID so existing
--     approved/executed rows (which predate these columns and therefore have
--     no approver/executor identity) are NOT rejected by the migration. New
--     writes are still fully validated. No approval identities are fabricated.

BEGIN;

ALTER TABLE ai_proposed_actions
  ADD COLUMN approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD COLUMN executed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN executed_at TIMESTAMPTZ;

-- Creator may never approve their own action (a NULL approver passes).
ALTER TABLE ai_proposed_actions
  ADD CONSTRAINT chk_ai_action_creator_not_approver
  CHECK (approved_by IS NULL OR approved_by <> created_by) NOT VALID;

-- Creator may never execute their own action (a NULL executor passes).
ALTER TABLE ai_proposed_actions
  ADD CONSTRAINT chk_ai_action_creator_not_executor
  CHECK (executed_by IS NULL OR executed_by <> created_by) NOT VALID;

-- An approved or executed action must carry a persisted approver + timestamp.
ALTER TABLE ai_proposed_actions
  ADD CONSTRAINT chk_ai_action_approved_identity
  CHECK (status NOT IN ('approved', 'executed') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)) NOT VALID;

-- An executed action must carry a persisted executor + timestamp.
ALTER TABLE ai_proposed_actions
  ADD CONSTRAINT chk_ai_action_executed_identity
  CHECK (status <> 'executed' OR (executed_by IS NOT NULL AND executed_at IS NOT NULL)) NOT VALID;

COMMIT;