-- 0087_ai_system_recovery_user
--
-- D-05/R3-B: no schema change. The server-controlled system-recovery actor is
-- provisioned lazily at runtime (after demo seeding) by
-- getSystemRecoveryUserId(), so it never interferes with first-run seeding.
-- Kept as a numbered no-op to preserve migration ordering.

BEGIN;
SELECT 1;
COMMIT;