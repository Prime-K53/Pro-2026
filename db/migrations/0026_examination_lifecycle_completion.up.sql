-- Migration 0025: Examination lifecycle completion
-- Additive follow-up to 0024. Adds the remaining execution checkpoints required
-- by the controlled examination production lifecycle:
--   * packing / dispatch timestamps, package and seal references
--   * QC notes and reprint reason
--   * a partial uniqueness rule that permits controlled reprints in the same batch
--   * frozen, hash-addressed production specifications at batch level

ALTER TABLE exam_papers
  ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reprint_reason TEXT,
  ADD COLUMN IF NOT EXISTS qc_notes TEXT,
  ADD COLUMN IF NOT EXISTS package_count INTEGER,
  ADD COLUMN IF NOT EXISTS seal_reference VARCHAR(80);

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_package_count;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_package_count CHECK (package_count IS NULL OR package_count >= 0);

-- Original papers keep the one-subject-per-batch rule. A reprint is a distinct
-- production record in the same batch and must never replace its parent.
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS uq_exam_papers_batch_subject;
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_papers_batch_subject_original
  ON exam_papers (company_id, batch_id, subject_name)
  WHERE reprint_of_paper_id IS NULL;

ALTER TABLE exam_assessment_batches
  ADD COLUMN IF NOT EXISTS spec_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS spec_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS spec_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS spec_approved_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS spec_frozen BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE exam_assessment_batches
  DROP CONSTRAINT IF EXISTS ck_exam_batches_spec_version;
ALTER TABLE exam_assessment_batches
  ADD CONSTRAINT ck_exam_batches_spec_version CHECK (spec_version >= 1);

CREATE INDEX IF NOT EXISTS ix_exam_batches_company_due
  ON exam_assessment_batches (company_id, status, due_date);
