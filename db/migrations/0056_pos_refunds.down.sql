DROP POLICY IF EXISTS p_pos_refunds_isolation ON pos_refunds;
ALTER TABLE pos_refunds DISABLE ROW LEVEL SECURITY;
ALTER TABLE pos_orders DROP COLUMN IF EXISTS refunded_amount;
DROP TABLE IF EXISTS pos_refunds;