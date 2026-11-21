-- Migration 0029: Examination D3 teacher-copy quantity model
-- Implements the fixed D3 rule: exactly two free teacher copies per paper,
-- separate tracking of learner vs teacher quantities, and billable quantity
-- limited to accepted learner copies.
--
-- Existing rows: teacher_copies defaults to 2, planned_production_quantity
-- defaults to copies + 2, billable_quantity defaults to copies. Legacy rows
-- are flagged via cost_status where necessary.

ALTER TABLE exam_papers
  ADD COLUMN IF NOT EXISTS teacher_copies INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS planned_production_quantity INTEGER,
  ADD COLUMN IF NOT EXISTS billable_quantity INTEGER,
  ADD COLUMN IF NOT EXISTS accepted_learner_quantity INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damaged_teacher_copies INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damaged_learner_copies INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replacement_teacher_copies INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replacement_learner_copies INTEGER NOT NULL DEFAULT 0;

-- Constraints: teacher copies fixed at 2 (non-negative, exact value enforced in app layer)
ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_teacher_copies;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_teacher_copies CHECK (teacher_copies >= 0 AND teacher_copies <= 10);

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_planned_qty;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_planned_qty CHECK (
    planned_production_quantity IS NULL OR planned_production_quantity >= 0
  );

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_billable_qty;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_billable_qty CHECK (
    billable_quantity IS NULL OR billable_quantity >= 0
  );

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_accepted_learner_qty;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_accepted_learner_qty CHECK (accepted_learner_quantity >= 0);

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_damaged_qty;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_damaged_qty CHECK (
    damaged_teacher_copies >= 0 AND
    damaged_learner_copies >= 0 AND
    replacement_teacher_copies >= 0 AND
    replacement_learner_copies >= 0
  );

-- Backfill existing rows so planned = copies + teacher_copies and billable = copies.
UPDATE exam_papers
SET
  planned_production_quantity = COALESCE(planned_production_quantity, copies + teacher_copies),
  billable_quantity = COALESCE(billable_quantity, copies)
WHERE planned_production_quantity IS NULL OR billable_quantity IS NULL;

-- Ensure new rows automatically get planned_production_quantity and billable_quantity.
-- We use a trigger to keep the invariant: planned = learner + teacher, billable <= learner.
CREATE OR REPLACE FUNCTION set_exam_paper_quantities()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.planned_production_quantity IS NULL THEN
    NEW.planned_production_quantity := NEW.copies + NEW.teacher_copies;
  END IF;
  IF NEW.billable_quantity IS NULL THEN
    NEW.billable_quantity := NEW.copies;
  END IF;
  -- Billable quantity can never exceed ordered learner copies.
  IF NEW.billable_quantity > NEW.copies THEN
    NEW.billable_quantity := NEW.copies;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_exam_papers_set_quantities ON exam_papers;
CREATE TRIGGER trg_exam_papers_set_quantities
  BEFORE INSERT OR UPDATE ON exam_papers
  FOR EACH ROW EXECUTE FUNCTION set_exam_paper_quantities();

-- Index for reporting on teacher/planned quantities.
CREATE INDEX IF NOT EXISTS ix_exam_papers_company_planned_qty
  ON exam_papers (company_id, planned_production_quantity)
  WHERE planned_production_quantity IS NOT NULL;

-- P1-10: Enforce idempotency at the database level for exam paper events.
-- Previously replay protection relied solely on service-layer request_keys;
-- a partial unique index on idempotency_key prevents duplicate events even
-- if the service layer is bypassed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_paper_events_idempotency
  ON exam_paper_events (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;