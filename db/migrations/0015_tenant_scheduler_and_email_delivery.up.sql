-- Migration 0015: Tenant-scoped scheduler leases + resilient email delivery
-- The scheduler now runs one timer per company. These leases prevent two
-- application processes from executing the same tenant's due work twice.
-- email_log gains the report body plus retry/backoff bookkeeping so SMTP
-- delivery failures are visible and retried instead of being silently dropped.

CREATE TABLE IF NOT EXISTS scheduler_leases (
  company_id       BIGINT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  lease_owner      VARCHAR(128) NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  last_tick_at     TIMESTAMPTZ,
  last_error       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_scheduler_leases_expiry
  ON scheduler_leases (lease_expires_at);

ALTER TABLE email_log ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS ix_email_log_delivery_queue
  ON email_log (company_id, status, next_attempt_at, id);

-- Least-privilege runtime grants (RLS remains strictly enforced for tenant tables)
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduler_leases TO pms_app_role;
