-- Migration 0081: Printing Contract Void
-- Adds a distinct `voided` status (compensating reversal, terminal) plus the
-- void audit columns. Void differs from `cancelled`: it returns any unallocated
-- retainer to the customer wallet rather than refunding/forfeiting.

ALTER TABLE printing_contracts
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- Expand the status CHECK to include 'voided'.
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS printing_contracts_status_check;
ALTER TABLE printing_contracts
  ADD CONSTRAINT printing_contracts_status_check
  CHECK (status IN ('draft','active','suspended','completed','exhausted','cancelled','voided'));

-- Lifecycle metadata consistency: a voided contract must carry voided_at.
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_lifecycle_meta;
ALTER TABLE printing_contracts
  ADD CONSTRAINT ck_printing_contracts_lifecycle_meta CHECK (
    (status <> 'active' OR activated_at IS NOT NULL)
    AND (status <> 'completed' OR completed_at IS NOT NULL)
    AND (status <> 'suspended' OR suspended_at IS NOT NULL)
    AND (status <> 'cancelled' OR cancelled_at IS NOT NULL)
    AND (status <> 'voided' OR voided_at IS NOT NULL)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pms_app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pms_app_role;