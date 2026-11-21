-- Rollback 0025: Customer Master Data Governance
-- Removes columns added in up migration. Data in removed columns is discarded.

ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS uq_customers_customer_code;

DROP INDEX IF EXISTS ix_customers_customer_code;
DROP INDEX IF EXISTS ix_customers_customer_status;

ALTER TABLE customers
  DROP COLUMN IF EXISTS customer_code,
  DROP COLUMN IF EXISTS customer_status,
  DROP COLUMN IF EXISTS tax_registration_number,
  DROP COLUMN IF EXISTS tax_jurisdiction,
  DROP COLUMN IF EXISTS exemption_certificate_number,
  DROP COLUMN IF EXISTS exemption_certificate_issue_date,
  DROP COLUMN IF EXISTS exemption_certificate_expiry_date,
  DROP COLUMN IF EXISTS withholding_tax_classification;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pms_app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pms_app_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pms_app_role;