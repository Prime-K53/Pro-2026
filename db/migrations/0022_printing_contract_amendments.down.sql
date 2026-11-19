-- Rollback Migration 0022: Printing Contract Amendments
-- WARNING: Drops amendment history. For disposable test databases only.

DROP TRIGGER IF EXISTS trg_contract_amendments_updated_at ON contract_amendments;
DROP TABLE IF EXISTS contract_amendments;