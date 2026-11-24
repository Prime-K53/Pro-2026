-- RLS for 2FA tables: user-scoped policies.
-- Single-company ERP: 2FA rows are user-owned, not company-owned.

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.user_id', true), '')::integer,
    -1
  );
$$;

ALTER TABLE user_two_factor_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_two_factor_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_user_two_factor_secrets_owner ON user_two_factor_secrets;
CREATE POLICY p_user_two_factor_secrets_owner ON user_two_factor_secrets
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

ALTER TABLE user_backup_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_backup_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_user_backup_codes_owner ON user_backup_codes;
CREATE POLICY p_user_backup_codes_owner ON user_backup_codes
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());