-- Rollback 0006: Drop Reporting, Audit Logs, Documents, Budgets, Fixed Assets & Payroll/HR

DROP TRIGGER IF EXISTS trg_audit_log_append_only ON audit_log;
DROP FUNCTION IF EXISTS prevent_audit_log_tampering() CASCADE;

DROP TABLE IF EXISTS tax_category_mappings CASCADE;
DROP TABLE IF EXISTS saved_reports CASCADE;
DROP TABLE IF EXISTS document_audits CASCADE;
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS email_log CASCADE;
DROP TABLE IF EXISTS email_templates CASCADE;
DROP TABLE IF EXISTS ocr_templates CASCADE;
DROP TABLE IF EXISTS attachments CASCADE;
DROP TABLE IF EXISTS stored_files CASCADE;
DROP TABLE IF EXISTS budgets CASCADE;
DROP TABLE IF EXISTS fixed_assets CASCADE;
DROP TABLE IF EXISTS fixed_asset_types CASCADE;
DROP TABLE IF EXISTS time_entries CASCADE;
DROP TABLE IF EXISTS onboarding_tasks CASCADE;
DROP TABLE IF EXISTS pto_accruals CASCADE;
DROP TABLE IF EXISTS pto_policies CASCADE;
DROP TABLE IF EXISTS pay_stub_benefits CASCADE;
DROP TABLE IF EXISTS pay_stubs CASCADE;
DROP TABLE IF EXISTS pay_runs CASCADE;
DROP TABLE IF EXISTS employee_benefits CASCADE;
DROP TABLE IF EXISTS benefit_codes CASCADE;
DROP TABLE IF EXISTS employee_bank_accounts CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
