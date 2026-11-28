-- Rollback Migration 0087: remove the lazily-provisioned system-recovery actor.
BEGIN;
DELETE FROM ai_audit_logs WHERE user_id IN (SELECT id FROM users WHERE username = 'system-recovery');
DELETE FROM users WHERE username = 'system-recovery';
COMMIT;