DROP INDEX IF EXISTS idx_customer_branches_active;
ALTER TABLE customer_branches DROP COLUMN IF EXISTS is_active;