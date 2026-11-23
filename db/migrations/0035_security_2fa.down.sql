-- Rollback Migration 0035: Security — 2FA.

DROP TABLE IF EXISTS user_backup_codes;
DROP TABLE IF EXISTS user_two_factor_secrets;