-- Rollback 0026: remove examination lifecycle completion additions.

DROP INDEX IF EXISTS ix_exam_batches_company_due;

ALTER TABLE exam_assessment_batches DROP CONSTRAINT IF EXISTS ck_exam_batches_spec_version;
ALTER TABLE exam_assessment_batches
  DROP COLUMN IF EXISTS spec_frozen,
  DROP COLUMN IF EXISTS spec_approved_by,
  DROP COLUMN IF EXISTS spec_approved_at,
  DROP COLUMN IF EXISTS spec_hash,
  DROP COLUMN IF EXISTS spec_version;

-- P1-11: Use a partial unique index that excludes reprints, matching the
-- forward migration. A full UNIQUE constraint would fail if any reprint rows
-- exist (reprints share the parent's batch_id + subject_name).
DROP INDEX IF EXISTS uq_exam_papers_batch_subject_original;
DROP INDEX IF EXISTS uq_exam_papers_batch_subject;
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_papers_batch_subject
  ON exam_papers (company_id, batch_id, subject_name)
  WHERE reprint_of_paper_id IS NULL;

ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS ck_exam_papers_package_count;
ALTER TABLE exam_papers
  DROP COLUMN IF EXISTS seal_reference,
  DROP COLUMN IF EXISTS package_count,
  DROP COLUMN IF EXISTS qc_notes,
  DROP COLUMN IF EXISTS reprint_reason,
  DROP COLUMN IF EXISTS dispatched_at,
  DROP COLUMN IF EXISTS packed_at;