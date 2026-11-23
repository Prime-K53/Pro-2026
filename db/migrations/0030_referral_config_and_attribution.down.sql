-- Migration 0030 DOWN: reverse referral configuration & attribution additions.
-- Order matters: drop dependent structures before the base tables/columns.

-- 6. Restore approval action-type constraints to their 0028 state (remove referral actions).
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_action_type_check CHECK (action_type IN (
    'invoice', 'bill', 'customer_payment', 'bill_payment',
    'journal_entry', 'credit_memo', 'estimate_conversion', 'po_receive',
    'wallet_refund', 'wallet_reversal', 'wallet_adjustment', 'wallet_writeoff',
    'contract_cancel', 'contract_refund', 'contract_forfeit',
    'contract_assessment_change', 'contract_activation', 'contract_amendment',
    'customer', 'credit_limit_change', 'credit_hold_release', 'customer_merge',
    'vendor', 'vendor_payment_hold', 'vendor_bank_change', 'vendor_merge'
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
    'vendor', 'vendor_payment_hold', 'vendor_bank_change', 'vendor_merge'
  ));

-- 5. Referral events — drop added columns and restore status check.
DROP INDEX IF EXISTS ix_referral_events_wallet_txn;
DROP INDEX IF EXISTS ix_referral_events_attribution;
DROP INDEX IF EXISTS uq_referral_events_pos_order;

ALTER TABLE referral_events DROP CONSTRAINT IF EXISTS fk_ref_events_approval;
ALTER TABLE referral_events DROP CONSTRAINT IF EXISTS fk_ref_events_reservation;
ALTER TABLE referral_events DROP CONSTRAINT IF EXISTS fk_ref_events_reversal_of;
ALTER TABLE referral_events DROP CONSTRAINT IF EXISTS fk_ref_events_wallet_txn;
ALTER TABLE referral_events DROP CONSTRAINT IF EXISTS fk_ref_events_attribution;

ALTER TABLE referral_events
  DROP COLUMN IF EXISTS rewarded_at,
  DROP COLUMN IF EXISTS terms_snapshot,
  DROP COLUMN IF EXISTS qualification_evidence,
  DROP COLUMN IF EXISTS fraud_hold,
  DROP COLUMN IF EXISTS approval_request_id,
  DROP COLUMN IF EXISTS reservation_id,
  DROP COLUMN IF EXISTS reversal_of_id,
  DROP COLUMN IF EXISTS wallet_txn_id,
  DROP COLUMN IF EXISTS attribution_id;

ALTER TABLE referral_events DROP CONSTRAINT IF EXISTS referral_events_status_check;
ALTER TABLE referral_events
  ADD CONSTRAINT referral_events_status_check
  CHECK (status IN ('pending', 'approved', 'credited', 'paid', 'voided'));

-- 4. Referral cases.
DROP POLICY IF EXISTS p_referral_cases_isolation ON referral_cases;
DROP TRIGGER IF EXISTS trg_referral_cases_updated_at ON referral_cases;
DROP TABLE IF EXISTS referral_cases;

-- 3. Referral budget reservations.
DROP POLICY IF EXISTS p_referral_budget_reservations_isolation ON referral_budget_reservations;
DROP TRIGGER IF EXISTS trg_referral_budget_reservations_updated_at ON referral_budget_reservations;
DROP TABLE IF EXISTS referral_budget_reservations;

-- 2. Referral attributions.
DROP POLICY IF EXISTS p_referral_attributions_isolation ON referral_attributions;
DROP TRIGGER IF EXISTS trg_referral_attributions_updated_at ON referral_attributions;
DROP TABLE IF EXISTS referral_attributions;

-- 1. Referral campaigns — drop added columns and restore status check.
DROP INDEX IF EXISTS ix_referral_campaigns_lifecycle;

ALTER TABLE referral_campaigns DROP CONSTRAINT IF EXISTS referral_campaigns_status_check;
ALTER TABLE referral_campaigns
  ADD CONSTRAINT referral_campaigns_status_check
  CHECK (status IN ('active', 'paused', 'completed', 'draft'));

ALTER TABLE referral_campaigns
  DROP COLUMN IF EXISTS budget_qualified_amount,
  DROP COLUMN IF EXISTS budget_reserved_amount,
  DROP COLUMN IF EXISTS suspension_reason,
  DROP COLUMN IF EXISTS suspended_at,
  DROP COLUMN IF EXISTS activated_at,
  DROP COLUMN IF EXISTS management_approved_by,
  DROP COLUMN IF EXISTS management_approved_at,
  DROP COLUMN IF EXISTS finance_approved_by,
  DROP COLUMN IF EXISTS finance_approved_at,
  DROP COLUMN IF EXISTS lifecycle_status,
  DROP COLUMN IF EXISTS ends_at,
  DROP COLUMN IF EXISTS starts_at,
  DROP COLUMN IF EXISTS eligible_item_ids,
  DROP COLUMN IF EXISTS eligible_item_types,
  DROP COLUMN IF EXISTS attribution_window_days,
  DROP COLUMN IF EXISTS reward_approval_threshold,
  DROP COLUMN IF EXISTS max_referee_discount_per_order,
  DROP COLUMN IF EXISTS max_referrer_reward_per_order,
  DROP COLUMN IF EXISTS referee_discount_value,
  DROP COLUMN IF EXISTS referee_discount_type,
  DROP COLUMN IF EXISTS referrer_reward_value,
  DROP COLUMN IF EXISTS referrer_reward_type;