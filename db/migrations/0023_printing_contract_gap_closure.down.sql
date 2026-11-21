-- Rollback for 0023_printing_contract_gap_closure.
-- Drops triggers, function, indexes and columns added in the up migration.
-- Data in the removed columns is intentionally discarded: it is derived or
-- re-derivable from invoices / wallet allocations.

DROP TRIGGER IF EXISTS trg_validate_contract_total_prepaid ON printing_contracts;
DROP TRIGGER IF EXISTS trg_validate_contract_assessment_sum ON contract_assessment_milestones;
DROP FUNCTION IF EXISTS assert_contract_total_prepaid();
DROP FUNCTION IF EXISTS assert_contract_assessment_allocation();

DROP INDEX IF EXISTS ix_contract_milestones_contract_number;
DROP INDEX IF EXISTS ix_contract_milestones_company_status;

ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS fk_printing_contracts_deposit_invoice;

ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_credit_balance;
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_allocated_amount;
ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS ck_printing_contracts_unallocated_amount;

ALTER TABLE printing_contracts
  DROP COLUMN IF EXISTS deposit_invoice_id,
  DROP COLUMN IF EXISTS deposit_invoice_number,
  DROP COLUMN IF EXISTS unallocated_amount,
  DROP COLUMN IF EXISTS allocated_amount,
  DROP COLUMN IF EXISTS credit_balance;

ALTER TABLE contract_assessment_milestones
  DROP COLUMN IF EXISTS linked_invoice_number;

ALTER TABLE printing_number_counters
  DROP CONSTRAINT IF EXISTS uq_printing_number_counters_company_scope;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pms_app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pms_app_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pms_app_role;