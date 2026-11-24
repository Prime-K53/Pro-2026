-- Migration 0059: Inventory write-off maker-checker approval.
--
-- Adds 'inventory_writeoff' to the approval_requests and approval_policies
-- action_type CHECK constraints so inventory shrinkage write-offs above a
-- configured threshold can be routed through the existing maker-checker
-- approval framework (evaluateApprovalGate / consumeApprovalRequest).
--
-- The remaining 34 action types are preserved verbatim from migration 0030
-- (the last migration to redefine these constraints).

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_action_type_check CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive',
    'wallet_refund', 'wallet_reversal', 'wallet_adjustment', 'wallet_writeoff',
    'contract_cancel', 'contract_refund', 'contract_forfeit',
    'contract_assessment_change', 'contract_activation', 'contract_amendment',
    'customer', 'credit_limit_change', 'credit_hold_release', 'customer_merge',
    'vendor', 'vendor_payment_hold', 'vendor_bank_change', 'vendor_merge',
    'referral_campaign_activation', 'referral_reward_approval',
    'referral_attribution_change', 'referral_eligibility_exception',
    'referral_refund_reversal', 'referral_fraud_decision',
    'referral_dispute_review', 'referral_writeoff',
    'inventory_writeoff'
  ));

ALTER TABLE approval_policies DROP CONSTRAINT IF EXISTS approval_policies_action_type_check;
ALTER TABLE approval_policies
  ADD CONSTRAINT approval_policies_action_type_check CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive',
    'wallet_refund', 'wallet_reversal', 'wallet_adjustment', 'wallet_writeoff',
    'contract_cancel', 'contract_refund', 'contract_forfeit',
    'contract_assessment_change', 'contract_activation', 'contract_amendment',
    'customer', 'credit_limit_change', 'credit_hold_release', 'customer_merge',
    'vendor', 'vendor_payment_hold', 'vendor_bank_change', 'vendor_merge',
    'referral_campaign_activation', 'referral_reward_approval',
    'referral_attribution_change', 'referral_eligibility_exception',
    'referral_refund_reversal', 'referral_fraud_decision',
    'referral_dispute_review', 'referral_writeoff',
    'inventory_writeoff'
  ));