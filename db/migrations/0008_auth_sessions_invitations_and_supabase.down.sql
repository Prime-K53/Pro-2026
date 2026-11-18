-- Rollback 0008: Drop Phase 3 Auth Sessions, Invitations, Recovery Tokens & Column Extensions

DROP TABLE IF EXISTS password_recovery_tokens CASCADE;
DROP TABLE IF EXISTS auth_sessions CASCADE;
DROP TABLE IF EXISTS user_invitations CASCADE;

ALTER TABLE company_memberships
  DROP COLUMN IF EXISTS revoked_by,
  DROP COLUMN IF EXISTS revoked_at,
  DROP COLUMN IF EXISTS invited_by,
  DROP COLUMN IF EXISTS expires_on,
  DROP COLUMN IF EXISTS membership_version;

DROP INDEX IF EXISTS uq_users_supabase_uid;

ALTER TABLE users
  DROP COLUMN IF EXISTS last_password_change_at,
  DROP COLUMN IF EXISTS must_change_password,
  DROP COLUMN IF EXISTS supabase_uid;
