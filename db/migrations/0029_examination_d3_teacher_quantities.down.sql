-- Down migration for 0029: Examination D3 teacher-copy quantity model
-- Drops the D3 columns, constraints, trigger and index.

DROP TRIGGER IF EXISTS trg_exam_papers_set_quantities ON exam_papers;
DROP FUNCTION IF EXISTS set_exam_paper_quantities();

DROP INDEX IF EXISTS ix_exam_papers_company_planned_qty;
DROP INDEX IF EXISTS uq_exam_paper_events_idempotency;

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_teacher_copies,
  DROP CONSTRAINT IF EXISTS ck_exam_papers_planned_qty,
  DROP CONSTRAINT IF EXISTS ck_exam_papers_billable_qty,
  DROP CONSTRAINT IF EXISTS ck_exam_papers_accepted_learner_qty,
  DROP CONSTRAINT IF EXISTS ck_exam_papers_damaged_qty;

ALTER TABLE exam_papers
  DROP COLUMN IF EXISTS teacher_copies,
  DROP COLUMN IF EXISTS planned_production_quantity,
  DROP COLUMN IF EXISTS billable_quantity,
  DROP COLUMN IF EXISTS accepted_learner_quantity,
  DROP COLUMN IF EXISTS damaged_teacher_copies,
  DROP COLUMN IF EXISTS damaged_learner_copies,
  DROP COLUMN IF EXISTS replacement_teacher_copies,
  DROP COLUMN IF EXISTS replacement_learner_copies;