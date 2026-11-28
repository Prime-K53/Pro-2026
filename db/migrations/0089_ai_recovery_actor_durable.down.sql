-- Rollback Migration 0089: intentionally NON-DESTRUCTIVE.
-- Retains the system-recovery actor and all recovery audit history (audit
-- retention takes priority over removing the identity). No-op.
BEGIN;
SELECT 1;
COMMIT;