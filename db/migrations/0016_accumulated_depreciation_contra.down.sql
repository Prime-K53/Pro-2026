-- Rollback 0016: remove is_contra and revert Account 1590 normal balance to debit.

UPDATE accounts
   SET normal_balance = 'debit'
 WHERE code = '1590'
   AND is_contra = TRUE;

ALTER TABLE accounts DROP COLUMN IF EXISTS is_contra;
