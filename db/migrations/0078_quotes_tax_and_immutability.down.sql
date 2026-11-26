DROP TRIGGER IF EXISTS trg_quote_versions_immutable ON quote_versions;
DROP FUNCTION IF EXISTS prevent_quote_version_mutation();
ALTER TABLE quote_versions DROP COLUMN IF EXISTS tax_rate;
ALTER TABLE quotes DROP COLUMN IF EXISTS tax_rate;