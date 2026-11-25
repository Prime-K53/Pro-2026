-- Down migration for 0063: drop the withholding_tax_amount column from bill_payments.

ALTER TABLE bill_payments DROP COLUMN IF EXISTS withholding_tax_amount;