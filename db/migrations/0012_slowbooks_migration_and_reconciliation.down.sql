-- Rollback Migration 0012: Phase 10 SlowBooks Migration & Reconciliation Infrastructure

DROP POLICY IF EXISTS p_migration_recon_isolation ON migration_reconciliation_snapshots;
DROP TABLE IF EXISTS migration_reconciliation_snapshots;

DROP POLICY IF EXISTS p_migration_exceptions_isolation ON migration_exceptions;
DROP TABLE IF EXISTS migration_exceptions;

DROP POLICY IF EXISTS p_migration_id_map_isolation ON migration_id_map;
DROP TABLE IF EXISTS migration_id_map;

DROP POLICY IF EXISTS p_migration_checkpoints_isolation ON migration_checkpoints;
DROP TRIGGER IF EXISTS trg_migration_checkpoints_updated_at ON migration_checkpoints;
DROP TABLE IF EXISTS migration_checkpoints;

DROP POLICY IF EXISTS p_migration_company_runs_isolation ON migration_company_runs;
DROP TRIGGER IF EXISTS trg_migration_company_runs_updated_at ON migration_company_runs;
DROP TABLE IF EXISTS migration_company_runs;

DROP TABLE IF EXISTS migration_batches;
