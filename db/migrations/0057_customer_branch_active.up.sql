-- WS-3 C5 — soft-deactivate a branch while preserving historical references.
-- Existing rows default to active, so nothing changes for current data.

ALTER TABLE customer_branches
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_customer_branches_active
  ON customer_branches (company_id, customer_id, is_active);