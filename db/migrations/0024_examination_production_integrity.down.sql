-- Rollback 0024: remove examination production integrity additions.
-- Existing core exam rows are preserved; only the additive columns/tables are removed.

DROP TABLE IF EXISTS exam_paper_invoice_links;

DROP TRIGGER IF EXISTS trg_exam_events_immutable ON exam_paper_events;
DROP FUNCTION IF EXISTS prevent_exam_event_mutation();
DROP TABLE IF EXISTS exam_paper_events;

DROP TRIGGER IF EXISTS trg_exam_papers_updated_at ON exam_papers;
DROP INDEX IF EXISTS ix_exam_papers_company_delivery;
DROP INDEX IF EXISTS ix_exam_papers_company_invoice;
DROP INDEX IF EXISTS ix_exam_papers_company_batch;

ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS fk_exam_papers_delivery_note;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS fk_exam_papers_invoice;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS fk_exam_papers_reprint_parent;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS fk_exam_papers_production_job;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS fk_exam_papers_machine;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS fk_exam_papers_printing_item;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS ck_exam_papers_waste;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS ck_exam_papers_qc_copies;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS ck_exam_papers_cost_status;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS ck_exam_papers_qc_status;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS ck_exam_papers_paper_size;
ALTER TABLE exam_papers DROP CONSTRAINT IF EXISTS exam_papers_status_check;

ALTER TABLE exam_papers
  ADD CONSTRAINT exam_papers_status_check CHECK (status IN ('queued', 'printing', 'completed', 'invoiced'));

ALTER TABLE exam_papers
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS cost_warnings,
  DROP COLUMN IF EXISTS cost_status,
  DROP COLUMN IF EXISTS delivery_note_id,
  DROP COLUMN IF EXISTS invoice_id,
  DROP COLUMN IF EXISTS reprint_of_paper_id,
  DROP COLUMN IF EXISTS waste_sheets,
  DROP COLUMN IF EXISTS spoiled_copies,
  DROP COLUMN IF EXISTS good_copies,
  DROP COLUMN IF EXISTS qc_approved_copies,
  DROP COLUMN IF EXISTS qc_status,
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS delivered_at,
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS started_at,
  DROP COLUMN IF EXISTS queued_at,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS production_version,
  DROP COLUMN IF EXISTS production_job_id,
  DROP COLUMN IF EXISTS machine_id,
  DROP COLUMN IF EXISTS printing_item_id,
  DROP COLUMN IF EXISTS paper_size;

DROP TRIGGER IF EXISTS trg_exam_batches_updated_at ON exam_assessment_batches;
DROP INDEX IF EXISTS ix_exam_batches_company_status;

ALTER TABLE exam_assessment_batches DROP CONSTRAINT IF EXISTS ck_exam_batches_priority;
ALTER TABLE exam_assessment_batches DROP CONSTRAINT IF EXISTS ck_exam_batches_status;
ALTER TABLE exam_assessment_batches
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS total_toner_cost,
  DROP COLUMN IF EXISTS total_paper_cost,
  DROP COLUMN IF EXISTS priority,
  DROP COLUMN IF EXISTS due_date,
  DROP COLUMN IF EXISTS status;
