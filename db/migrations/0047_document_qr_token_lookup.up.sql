-- Prime ERP — V2 WS-6: O(1) QR token lookup.
--
-- Stores an HMAC of the QR token (not the token itself) so verification is an
-- indexed lookup instead of scanning every QR code. Existing rows have no
-- lookup value; the service falls back to the legacy scan for those.

ALTER TABLE document_qr_codes
  ADD COLUMN IF NOT EXISTS token_lookup TEXT;

CREATE INDEX IF NOT EXISTS idx_document_qr_codes_token_lookup
  ON document_qr_codes (token_lookup)
  WHERE token_lookup IS NOT NULL;