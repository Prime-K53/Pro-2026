-- Down migration for 0061: drop the tax code reference and registry.

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS fk_invoices_tax_code;
ALTER TABLE invoices DROP COLUMN IF EXISTS tax_code_id;

DROP TABLE IF EXISTS tax_codes;