-- Migration 0091: widen OCR document kinds and add a review status (Phase 4).
-- Adds receipt + supplier_bill document types and a 'needs_review' status for the
-- confidence gate. Totals remain recomputed server-side; OCR never posts.

ALTER TABLE ocr_extractions DROP CONSTRAINT IF EXISTS ocr_extractions_kind_check;
ALTER TABLE ocr_extractions
  ADD CONSTRAINT ocr_extractions_kind_check
  CHECK (kind IN ('quote', 'invoice', 'receipt', 'supplier_bill'));

ALTER TABLE ocr_extractions DROP CONSTRAINT IF EXISTS ocr_extractions_status_check;
ALTER TABLE ocr_extractions
  ADD CONSTRAINT ocr_extractions_status_check
  CHECK (status IN ('extracted', 'confirmed', 'discarded', 'needs_review'));