-- 0088_users_username_unique
--
-- D-05/R4-B: enforce database-level uniqueness of users.username so concurrent
-- first-time provisioning of the system-recovery actor is race-safe
-- (INSERT ... ON CONFLICT (username) resolves to one canonical identity).
-- Additive; no data change. Down drops only the index (non-destructive).

BEGIN;

-- Fail safely if legacy duplicate usernames exist (none expected).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users GROUP BY username HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'cannot create unique index: duplicate users.username values exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_uniq ON users (username);
COMMIT;