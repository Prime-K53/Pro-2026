-- Migration 0081 (down): Printing Contract Void
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_lifecycle_meta;
ALTER TABLE printing_contracts
  ADD CONSTRAINT ck_printing_contracts_lifecycle_meta CHECK (
    (status <> 'active' OR activated_at IS NOT NULL)
    AND (status <> 'completed' OR completed_at IS NOT NULL)
    AND (status <> 'suspended' OR suspended_at IS NOT NULL)
    AND (status <> 'cancelled' OR cancelled_at IS NOT NULL)
  );

ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS printing_contracts_status_check;
ALTER TABLE printing_contracts
  ADD CONSTRAINT printing_contracts_status_check
  CHECK (status IN ('draft','active','suspended','completed','exhausted','cancelled'));

ALTER TABLE printing_contracts
  DROP COLUMN IF EXISTS void_reason,
  DROP COLUMN IF EXISTS voided_by,
  DROP COLUMN IF EXISTS voided_at;