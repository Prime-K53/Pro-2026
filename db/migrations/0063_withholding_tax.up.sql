-- Migration 0063: Withholding tax on vendor payments (1099 support).
--
-- Adds `withholding_tax_amount` to bill_payments so backup withholding /
-- 1099-eligible vendor payments can record the portion withheld for tax
-- authorities. The net disbursement to the vendor is `amount - withholding_tax_amount`.

ALTER TABLE bill_payments
  ADD COLUMN IF NOT EXISTS withholding_tax_amount NUMERIC(19, 4) NOT NULL DEFAULT 0
    CHECK (withholding_tax_amount >= 0);