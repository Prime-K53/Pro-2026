DROP INDEX IF EXISTS idx_attachments_company_entity_current;
ALTER TABLE attachments
  DROP COLUMN IF EXISTS version_no,
  DROP COLUMN IF EXISTS is_current,
  DROP COLUMN IF EXISTS supersedes_attachment_id,
  DROP COLUMN IF EXISTS retention_until,
  DROP COLUMN IF EXISTS approval_status,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_at;
