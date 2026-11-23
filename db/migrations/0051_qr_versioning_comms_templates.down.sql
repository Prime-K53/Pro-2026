-- Rollback Migration 0051: QR versioning and communication templates.

DROP TABLE IF EXISTS communication_templates;

ALTER TABLE document_qr_codes
  DROP COLUMN IF EXISTS document_version,
  DROP COLUMN IF EXISTS document_hash;