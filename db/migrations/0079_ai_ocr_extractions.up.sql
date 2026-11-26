-- AI OCR extractions: persist raw OCR text, image hash, structured extraction,
-- model/confidence and confirmation linkage for audit + duplicate detection.

CREATE TABLE IF NOT EXISTS ocr_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('quote', 'invoice')),
  image_sha256 VARCHAR(64) NOT NULL,
  mime VARCHAR(64),
  raw_text TEXT,
  extraction_jsonb JSONB NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  model VARCHAR(128),
  prompt_version VARCHAR(32) NOT NULL DEFAULT 'v1',
  status VARCHAR(16) NOT NULL DEFAULT 'extracted' CHECK (status IN ('extracted', 'confirmed', 'discarded')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_doc_type VARCHAR(16),
  confirmed_doc_id INTEGER,
  UNIQUE (company_id, image_sha256)
);

CREATE INDEX IF NOT EXISTS idx_ocr_extractions_company ON ocr_extractions(company_id, created_at DESC);

ALTER TABLE ocr_extractions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ocr_extractions_isolation ON ocr_extractions
  USING (company_id = current_setting('app.current_company_id', TRUE)::INTEGER)
  WITH CHECK (company_id = current_setting('app.current_company_id', TRUE)::INTEGER);