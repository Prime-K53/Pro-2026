-- 0089_ai_recovery_actor_durable
--
-- D-05/R4-C: no schema change and no seed-time insert (so first-run demo
-- seeding is unaffected). The system-recovery identity is provisioned lazily at
-- runtime by getSystemRecoveryUserId(); this migration exists so the DOWN path
-- is explicitly NON-DESTRUCTIVE (retains actor + audit history).

BEGIN;
SELECT 1;
COMMIT;