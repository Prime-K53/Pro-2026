-- Rollback Migration 0037: Payroll — Advances, Deduction Rules, Allowances.

DROP TABLE IF EXISTS employee_allowances;
DROP TABLE IF EXISTS payroll_deduction_rules;
DROP TABLE IF EXISTS salary_advances;