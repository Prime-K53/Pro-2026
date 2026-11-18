-- Rollback 0003: Drop Sales, Receivables, Estimates, Credit Memos & Customers

DROP TABLE IF EXISTS memorized_transaction_lines CASCADE;
DROP TABLE IF EXISTS memorized_transactions CASCADE;
DROP TABLE IF EXISTS recurring_invoice_lines CASCADE;
DROP TABLE IF EXISTS recurring_invoices CASCADE;
DROP TABLE IF EXISTS customer_statements CASCADE;
DROP TABLE IF EXISTS invoice_reminders CASCADE;
DROP TABLE IF EXISTS invoice_reminder_rules CASCADE;
DROP TABLE IF EXISTS credit_applications CASCADE;
DROP TABLE IF EXISTS credit_memo_lines CASCADE;
DROP TABLE IF EXISTS credit_memos CASCADE;
DROP TABLE IF EXISTS payment_allocations CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS invoice_lines CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS estimate_lines CASCADE;
DROP TABLE IF EXISTS estimates CASCADE;
DROP TABLE IF EXISTS invoice_messages CASCADE;
DROP TABLE IF EXISTS reseller_permits CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
