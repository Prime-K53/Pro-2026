-- Rollback Migration 0047: QR token lookup.

DROP INDEX IF EXISTS idx_document_qr_codes_token_lookup;
ALTER TABLE document_qr_codes DROP COLUMN IF EXISTS token_lookup;