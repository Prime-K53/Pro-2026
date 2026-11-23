-- Rollback Migration 0045: Malawi statutory payroll configuration.

DROP TABLE IF EXISTS payroll_statutory_rates;
DROP TABLE IF EXISTS payroll_paye_bands;

ALTER TABLE pay_stubs
  DROP COLUMN IF EXISTS paye,
  DROP COLUMN IF EXISTS pension_employee,
  DROP COLUMN IF EXISTS pension_employer,
  DROP COLUMN IF EXISTS other_deductions,
  DROP COLUMN IF EXISTS employer_other;