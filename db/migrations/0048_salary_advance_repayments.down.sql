-- Rollback Migration 0048: salary advance repayment tracking.

ALTER TABLE salary_advances DROP COLUMN IF EXISTS repaid_amount;