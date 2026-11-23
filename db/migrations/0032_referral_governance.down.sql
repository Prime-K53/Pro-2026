-- Rollback Migration 0032: Referral Governance.

-- 9. Drop program_id from campaigns (if added by this migration).
ALTER TABLE referral_campaigns DROP COLUMN IF EXISTS program_id;

-- 8. Drop referral_compliance_logs.
DROP TABLE IF EXISTS referral_compliance_logs;

-- 7. Drop referral_reward_approvals.
DROP TABLE IF EXISTS referral_reward_approvals;

-- 6. Revert referral_reward_events governance columns.
ALTER TABLE referral_reward_events DROP COLUMN IF EXISTS governance_status;
ALTER TABLE referral_reward_events DROP COLUMN IF EXISTS approval_id;
ALTER TABLE referral_reward_events DROP COLUMN IF EXISTS campaign_id;
ALTER TABLE referral_reward_events DROP COLUMN IF EXISTS program_id;
ALTER TABLE referral_reward_events DROP COLUMN IF EXISTS budget_id;

-- 5. Drop referral_attributions.
DROP TABLE IF EXISTS referral_attributions;

-- 4. Revert referral_campaigns governance columns.
ALTER TABLE referral_campaigns DROP COLUMN IF EXISTS status;
ALTER TABLE referral_campaigns DROP COLUMN IF EXISTS budget_id;
ALTER TABLE referral_campaigns DROP COLUMN IF EXISTS start_date;
ALTER TABLE referral_campaigns DROP COLUMN IF EXISTS end_date;
ALTER TABLE referral_campaigns DROP COLUMN IF EXISTS target_audience;
ALTER TABLE referral_campaigns DROP COLUMN IF EXISTS governance_required;
ALTER TABLE referral_campaigns DROP COLUMN IF EXISTS approval_required_threshold;

-- 3. Revert referral_programs governance columns.
ALTER TABLE referral_programs DROP COLUMN IF EXISTS program_type;
ALTER TABLE referral_programs DROP COLUMN IF EXISTS reward_mode;
ALTER TABLE referral_programs DROP COLUMN IF EXISTS discount_rate;
ALTER TABLE referral_programs DROP COLUMN IF EXISTS commission_rate;
ALTER TABLE referral_programs DROP COLUMN IF EXISTS status;
ALTER TABLE referral_programs DROP COLUMN IF EXISTS governance_required;
ALTER TABLE referral_programs DROP COLUMN IF EXISTS approval_required_threshold;
ALTER TABLE referral_programs DROP COLUMN IF EXISTS max_reward_amount;
ALTER TABLE referral_programs DROP COLUMN IF EXISTS max_reward_count;
ALTER TABLE referral_programs DROP COLUMN IF EXISTS wallet_id;

-- 2. Drop discount_usage.
DROP TABLE IF EXISTS discount_usage;

-- 1. Drop discount_budgets.
DROP TABLE IF EXISTS discount_budgets;