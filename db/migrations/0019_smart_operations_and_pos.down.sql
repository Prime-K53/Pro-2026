-- 0019_smart_operations_and_pos.down.sql

DROP POLICY IF EXISTS p_price_card_presets_isolation ON price_card_presets;
DROP TABLE IF EXISTS price_card_presets;

DROP POLICY IF EXISTS p_marketing_messages_isolation ON marketing_messages;
DROP TABLE IF EXISTS marketing_messages;

DROP POLICY IF EXISTS p_marketing_campaigns_isolation ON marketing_campaigns;
DROP TABLE IF EXISTS marketing_campaigns;

DROP POLICY IF EXISTS p_marketing_automation_rules_isolation ON marketing_automation_rules;
DROP TABLE IF EXISTS marketing_automation_rules;

DROP POLICY IF EXISTS p_marketing_templates_isolation ON marketing_templates;
DROP TABLE IF EXISTS marketing_templates;

DROP POLICY IF EXISTS p_referral_events_isolation ON referral_events;
DROP TABLE IF EXISTS referral_events;

DROP POLICY IF EXISTS p_promotion_redemptions_isolation ON promotion_redemptions;
DROP TABLE IF EXISTS promotion_redemptions;

DROP POLICY IF EXISTS p_pos_order_tenders_isolation ON pos_order_tenders;
DROP TABLE IF EXISTS pos_order_tenders;

DROP POLICY IF EXISTS p_pos_orders_isolation ON pos_orders;
DROP TABLE IF EXISTS pos_orders;

DROP POLICY IF EXISTS p_referral_codes_isolation ON referral_codes;
DROP TABLE IF EXISTS referral_codes;

DROP POLICY IF EXISTS p_referral_campaigns_isolation ON referral_campaigns;
DROP TABLE IF EXISTS referral_campaigns;

DROP POLICY IF EXISTS p_referral_programs_isolation ON referral_programs;
DROP TABLE IF EXISTS referral_programs;

DROP POLICY IF EXISTS p_promotions_isolation ON promotions;
DROP TABLE IF EXISTS promotions;

ALTER TABLE journal_transactions
  DROP CONSTRAINT IF EXISTS journal_transactions_source_type_check;

ALTER TABLE journal_transactions
  ADD CONSTRAINT journal_transactions_source_type_check CHECK (source_type IN (
    'manual', 'invoice', 'sales_receipt', 'payment', 'credit_memo',
    'bill', 'bill_payment', 'vendor_credit', 'goods_receipt',
    'deposit', 'transfer', 'check', 'expense', 'credit_card_charge', 'bank_import',
    'payroll', 'reconciliation', 'inventory_adjustment', 'inventory_damage', 'stock_count', 'depreciation',
    'printing_contract', 'quick_print', 'exam_production',
    'production_wip', 'production_issue', 'production_operation', 'production_cogs', 'production_variance',
    'opening_balance', 'reversal', 'closing_entry', 'fx_gain_loss'
  ));
