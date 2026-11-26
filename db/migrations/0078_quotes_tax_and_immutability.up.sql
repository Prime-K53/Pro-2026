-- Quotes: tax support + version immutability.
-- Adds tax_rate to quotes and quote_versions (percentage, 6dp), and enforces
-- append-only semantics on quote_versions so issued versions cannot be mutated.

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0;
ALTER TABLE quote_versions ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION prevent_quote_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'quote_versions is append-only; versions cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quote_versions_immutable ON quote_versions;
CREATE TRIGGER trg_quote_versions_immutable
  BEFORE UPDATE OR DELETE ON quote_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_quote_version_mutation();