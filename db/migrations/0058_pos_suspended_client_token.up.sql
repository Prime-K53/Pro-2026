-- WS-1 P7 — deterministic suspended-sale recovery.
-- A client generates the token once per parked sale and re-sends the same token
-- after a refresh or restart, so recovery is idempotent instead of duplicating.

ALTER TABLE pos_suspended_sales
  ADD COLUMN IF NOT EXISTS client_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_suspended_sales_client_token
  ON pos_suspended_sales (company_id, client_token)
  WHERE client_token IS NOT NULL;