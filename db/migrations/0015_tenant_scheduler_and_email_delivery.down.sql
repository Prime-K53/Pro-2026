-- Rollback Migration 0015: Tenant-scoped scheduler leases + resilient email delivery

DROP INDEX IF EXISTS ix_email_log_delivery_queue;

ALTER TABLE email_log DROP COLUMN IF EXISTS next_attempt_at;
ALTER TABLE email_log DROP COLUMN IF EXISTS last_error;
ALTER TABLE email_log DROP COLUMN IF EXISTS attempts;
ALTER TABLE email_log DROP COLUMN IF EXISTS body;

DROP TABLE IF EXISTS scheduler_leases;
