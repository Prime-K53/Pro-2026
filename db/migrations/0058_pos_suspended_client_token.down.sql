DROP INDEX IF EXISTS uq_pos_suspended_sales_client_token;
ALTER TABLE pos_suspended_sales DROP COLUMN IF EXISTS client_token;