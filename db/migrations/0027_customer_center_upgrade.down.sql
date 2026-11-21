-- Rollback 0027: Customer Center Upgrade
-- Removes FX revaluation tables, statement archive metadata, customer currency,
-- opening-balance linkage, the customer-code trigger, and the customer approval
-- action types. RESTRICTs this from silently deleting posted revaluations.

DROP TABLE IF EXISTS fx_revaluation_lines;
DROP TABLE IF EXISTS fx_revaluation_runs;

DROP INDEX IF EXISTS ix_customer_statements_company_customer;
ALTER TABLE customer_statements
  DROP COLUMN IF EXISTS snapshot_json,
  DROP COLUMN IF EXISTS emailed_at;

DROP TRIGGER IF EXISTS trg_customers_assign_code ON customers;
DROP FUNCTION IF EXISTS fn_assign_customer_code();

DROP INDEX IF EXISTS ix_customers_opening_invoice;
ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS fk_customers_opening_invoice;
ALTER TABLE customers
  DROP COLUMN IF EXISTS opening_balance_invoice_id,
  DROP COLUMN IF EXISTS currency_code;

ALTER TABLE companies
  DROP COLUMN IF EXISTS require_tax_exemption_permit;

ALTER TABLE approval_policies
  DROP CONSTRAINT IF EXISTS approval_policies_action_type_check;

ALTER TABLE approval_policies
  ADD CONSTRAINT approval_policies_action_type_check CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive',
    'wallet_refund', 'wallet_reversal', 'wallet_adjustment', 'wallet_writeoff',
    'contract_cancel', 'contract_refund', 'contract_forfeit',
    'contract_assessment_change', 'contract_activation', 'contract_amendment'
  ));

ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_action_type_check CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive',
    'wallet_refund', 'wallet_reversal', 'wallet_adjustment', 'wallet_writeoff',
    'contract_cancel', 'contract_refund', 'contract_forfeit',
    'contract_assessment_change', 'contract_activation', 'contract_amendment'
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pms_app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pms_app_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pms_app_role;
