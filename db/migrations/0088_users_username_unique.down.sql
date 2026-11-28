-- Rollback Migration 0088: drop the username unique index (data preserved).
BEGIN;
DROP INDEX IF EXISTS users_username_uniq;
COMMIT;