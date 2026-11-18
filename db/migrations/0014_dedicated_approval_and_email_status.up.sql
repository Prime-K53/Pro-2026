-- Migration 0014: Dedicated approval action types + honest email delivery status
-- Adds estimate_conversion and po_receive as distinct maker-checker action types,
-- and a 'skipped' email_log status for runs without SMTP configured.

ALTER TABLE approval_policies DROP CONSTRAINT IF EXISTS approval_policies_action_type_check;
ALTER TABLE approval_policies ADD CONSTRAINT approval_policies_action_type_check
  CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive'
  ));

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_action_type_check
  CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive'
  ));

ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_status_check;
ALTER TABLE email_log ADD CONSTRAINT email_log_status_check
  CHECK (status IN ('queued', 'sent', 'failed', 'skipped'));