-- Rollback Migration 0091: restore original OCR kind/status constraints.
ALTER TABLE ocr_extractions DROP CONSTRAINT IF EXISTS ocr_extractions_status_check;
ALTER TABLE ocr_extractions
  ADD CONSTRAINT ocr_extractions_status_check
  CHECK (status IN ('extracted', 'confirmed', 'discarded'));

ALTER TABLE ocr_extractions DROP CONSTRAINT IF EXISTS ocr_extractions_kind_check;
ALTER TABLE ocr_extractions
  ADD CONSTRAINT ocr_extractions_kind_check
  CHECK (kind IN ('quote', 'invoice'));