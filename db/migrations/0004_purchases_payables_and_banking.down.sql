-- Rollback 0004: Drop Banking, Payables, Vendor Credits & Purchasing

DROP TABLE IF EXISTS duplicate_dismissals CASCADE;
DROP TABLE IF EXISTS deposit_other_lines CASCADE;
DROP TABLE IF EXISTS bank_rules CASCADE;
DROP TABLE IF EXISTS bank_check_details CASCADE;
DROP TABLE IF EXISTS bank_transactions CASCADE;
DROP TABLE IF EXISTS reconciliations CASCADE;
DROP TABLE IF EXISTS bank_accounts CASCADE;
DROP TABLE IF EXISTS vendor_credit_applications CASCADE;
DROP TABLE IF EXISTS vendor_credit_lines CASCADE;
DROP TABLE IF EXISTS vendor_credits CASCADE;
DROP TABLE IF EXISTS bill_payment_allocations CASCADE;
DROP TABLE IF EXISTS bill_payments CASCADE;
DROP TABLE IF EXISTS bill_lines CASCADE;
DROP TABLE IF EXISTS bills CASCADE;
DROP TABLE IF EXISTS purchase_order_lines CASCADE;
DROP TABLE IF EXISTS purchase_orders CASCADE;
DROP TABLE IF EXISTS vendors CASCADE;
