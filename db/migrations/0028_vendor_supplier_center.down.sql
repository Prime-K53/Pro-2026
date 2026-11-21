-- Rollback migration 0028: Vendor & Supplier Center Upgrade

DROP TABLE IF EXISTS vendor_statements;

ALTER TABLE approval_policies
  DROP CONSTRAINT IF EXISTS approval_policies_action_type_check;

ALTER TABLE approval_policies
  ADD CONSTRAINT approval_policies_action_type_check CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive',
    'wallet_refund', 'wallet_reversal', 'wallet_adjustment', 'wallet_writeoff',
    'contract_cancel', 'contract_refund', 'contract_forfeit',
    'contract_assessment_change', 'contract_activation', 'contract_amendment',
    'customer', 'credit_limit_change', 'credit_hold_release', 'customer_merge'
  ));

ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_action_type_check CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive',
    'wallet_refund', 'wallet_reversal', 'wallet_adjustment', 'wallet_writeoff',
    'contract_cancel', 'contract_refund', 'contract_forfeit',
    'contract_assessment_change', 'contract_activation', 'contract_amendment',
    'customer', 'credit_limit_change', 'credit_hold_release', 'customer_merge'
  ));

DROP TRIGGER IF EXISTS trg_vendors_assign_code ON vendors;
DROP FUNCTION IF EXISTS fn_assign_vendor_code();

DROP INDEX IF EXISTS ix_vendors_opening_bill;
ALTER TABLE vendors DROP CONSTRAINT IF EXISTS fk_vendors_opening_bill;
DROP INDEX IF EXISTS uq_vendors_company_code;

ALTER TABLE vendors
  DROP COLUMN IF EXISTS bank_branch,
  DROP COLUMN IF EXISTS bank_account_number,
  DROP COLUMN IF EXISTS bank_account_name,
  DROP COLUMN IF EXISTS bank_name,
  DROP COLUMN IF EXISTS is_preferred,
  DROP COLUMN IF EXISTS vendor_category,
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS opening_balance_bill_id,
  DROP COLUMN IF EXISTS currency_code,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS vendor_code;
