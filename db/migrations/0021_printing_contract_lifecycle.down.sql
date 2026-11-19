-- Rollback Migration 0021: Printing Contract Lifecycle
-- WARNING: Drops lifecycle metadata and acceptance records. For disposable test
-- databases only. Never run against production.

-- 1. Drop FKs and lifecycle CHECK
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS fk_printing_contracts_acceptance;
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS fk_printing_contracts_renewal_of;
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_lifecycle_meta;
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS fk_printing_contracts_settlement_journal;
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_settlement;
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_settled_amount;
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_settlement_mode;

-- 2. Drop acceptance table
DROP TABLE IF EXISTS contract_acceptances;

-- 3. Drop lifecycle columns
ALTER TABLE printing_contracts
  DROP COLUMN IF EXISTS customer_acceptance_id,
  DROP COLUMN IF EXISTS renewal_of_contract_id,
  DROP COLUMN IF EXISTS settlement_journal_txn_id,
  DROP COLUMN IF EXISTS settled_amount,
  DROP COLUMN IF EXISTS settlement_mode,
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS resumed_by,
  DROP COLUMN IF EXISTS resumed_at,
  DROP COLUMN IF EXISTS suspension_reason,
  DROP COLUMN IF EXISTS suspended_by,
  DROP COLUMN IF EXISTS suspended_at,
  DROP COLUMN IF EXISTS completed_by,
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS activated_by,
  DROP COLUMN IF EXISTS activated_at;

ALTER TABLE contract_assessment_milestones
  DROP COLUMN IF EXISTS completed_by,
  DROP COLUMN IF EXISTS completed_at;

-- 4. Drop indexes
DROP INDEX IF EXISTS ix_printing_contracts_renewal_of;
DROP INDEX IF EXISTS ix_printing_contracts_company_status;

-- 5. Revert status CHECK
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS printing_contracts_status_check;

ALTER TABLE printing_contracts
  ADD CONSTRAINT printing_contracts_status_check
  CHECK (status IN ('active','exhausted','cancelled'));