DROP POLICY IF EXISTS p_user_two_factor_secrets_owner ON user_two_factor_secrets;
DROP POLICY IF EXISTS p_user_backup_codes_owner ON user_backup_codes;
ALTER TABLE user_two_factor_secrets DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_backup_codes DISABLE ROW LEVEL SECURITY;
DROP FUNCTION IF EXISTS app_current_user_id();