-- Migration 0016: Accumulated Depreciation contra-asset classification
-- Adds a general is_contra flag and corrects Account 1590 (Accumulated Depreciation)
-- to credit-normal contra-asset treatment without altering historical journals.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_contra BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE accounts
   SET is_contra = TRUE,
       normal_balance = 'credit'
 WHERE code = '1590';
