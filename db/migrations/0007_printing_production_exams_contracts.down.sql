-- Rollback 0007: Drop Printing Production System Tables

DROP TABLE IF EXISTS delivery_note_lines CASCADE;
DROP TABLE IF EXISTS delivery_notes CASCADE;
DROP TABLE IF EXISTS quality_control_inspections CASCADE;
DROP TABLE IF EXISTS finishing_operations CASCADE;
DROP TABLE IF EXISTS production_operations CASCADE;
DROP TABLE IF EXISTS printing_jobs CASCADE;
DROP TABLE IF EXISTS exam_papers CASCADE;
DROP TABLE IF EXISTS exam_assessment_batches CASCADE;
DROP TABLE IF EXISTS contract_assessment_milestones CASCADE;
DROP TABLE IF EXISTS printing_contracts CASCADE;
DROP TABLE IF EXISTS printing_estimate_lines CASCADE;
DROP TABLE IF EXISTS printing_estimates CASCADE;
DROP TABLE IF EXISTS printing_machines CASCADE;
