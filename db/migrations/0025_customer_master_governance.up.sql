-- Migration 0025: Customer Master Data Governance
-- Addresses G-01 (unique customer code), G-05 (customer lifecycle), G-13 (addresses), G-14 (classification)
-- Additive only. Existing rows are preserved and backfilled with generated codes.

-- 1. Add customer_code column to customers (company-scoped unique)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_code VARCHAR(32);

ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS uq_customers_customer_code;
ALTER TABLE customers
  ADD CONSTRAINT uq_customers_customer_code
    UNIQUE (company_id, customer_code);

CREATE INDEX IF NOT EXISTS ix_customers_customer_code
  ON customers (company_id, customer_code);

-- 2. Add customer_status column (active / inactive / blocked)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (customer_status IN ('active', 'inactive', 'blocked'));

CREATE INDEX IF NOT EXISTS ix_customers_customer_status
  ON customers (company_id, customer_status, is_active);

-- 3. Tax compliance fields
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS tax_registration_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tax_jurisdiction VARCHAR(80),
  ADD COLUMN IF NOT EXISTS exemption_certificate_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS exemption_certificate_issue_date DATE,
  ADD COLUMN IF NOT EXISTS exemption_certificate_expiry_date DATE,
  ADD COLUMN IF NOT EXISTS withholding_tax_classification VARCHAR(40);

-- 4. Backfill customer_code for existing customers deterministically
-- Format: CUST-{6-digit zero-padded sequence per company}
UPDATE customers c
SET customer_code = 'CUST-' || LPAD(seq.seq::TEXT, 6, '0')
FROM (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY id) AS seq
  FROM customers
  WHERE customer_code IS NULL
) seq
WHERE c.id = seq.id
  AND c.customer_code IS NULL;

-- 5. Backfill customer_status from is_active
UPDATE customers
SET customer_status = CASE WHEN is_active THEN 'active' ELSE 'inactive' END
WHERE customer_status = 'active' AND is_active = FALSE;

-- 6. Make customer_code NOT NULL after backfill (idempotent: only if all rows have codes)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customers WHERE customer_code IS NULL LIMIT 1
  ) THEN
    ALTER TABLE customers
      ALTER COLUMN customer_code SET NOT NULL;
  END IF;
END $$;

-- 7. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pms_app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pms_app_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pms_app_role;