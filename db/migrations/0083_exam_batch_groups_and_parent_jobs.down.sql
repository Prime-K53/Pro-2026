-- 0083_exam_batch_groups_and_parent_jobs (down)
--
-- Reverses the additive examination batch-group automation. Existing per-class
-- examination batches and subject-level production jobs are preserved; only the
-- organisational exam_batch parent jobs and group/run records are removed so the
-- relaxed NOT NULL constraints can be restored.

BEGIN;

-- 1. Drop the checkpoint ledger.
DROP TABLE IF EXISTS exam_batch_group_runs;

-- 2. Detach per-class batches from the parent group.
ALTER TABLE exam_assessment_batches DROP CONSTRAINT IF EXISTS fk_exam_batches_group;
ALTER TABLE exam_assessment_batches DROP COLUMN IF EXISTS exam_batch_group_id;

-- 3. Remove organisational parent jobs (children keep their own jobs).
UPDATE printing_jobs SET parent_job_id = NULL WHERE parent_job_id IS NOT NULL;
DELETE FROM printing_jobs WHERE job_type = 'exam_batch';

ALTER TABLE printing_jobs DROP CONSTRAINT IF EXISTS fk_pjobs_parent;
ALTER TABLE printing_jobs DROP COLUMN IF EXISTS parent_job_id;

-- 4. Restore the original production-job invariants.
ALTER TABLE printing_jobs DROP CONSTRAINT IF EXISTS printing_jobs_exam_batch_materials;

ALTER TABLE printing_jobs DROP CONSTRAINT IF EXISTS printing_jobs_pages_check;
ALTER TABLE printing_jobs
  ADD CONSTRAINT printing_jobs_pages_check CHECK (pages > 0);

ALTER TABLE printing_jobs DROP CONSTRAINT IF EXISTS printing_jobs_copies_check;
ALTER TABLE printing_jobs
  ADD CONSTRAINT printing_jobs_copies_check CHECK (copies > 0);

ALTER TABLE printing_jobs ALTER COLUMN raw_paper_item_id SET NOT NULL;
ALTER TABLE printing_jobs ALTER COLUMN raw_toner_item_id SET NOT NULL;

ALTER TABLE printing_jobs DROP CONSTRAINT IF EXISTS printing_jobs_job_type_check;
ALTER TABLE printing_jobs
  ADD CONSTRAINT printing_jobs_job_type_check
  CHECK (job_type IN ('quick_photocopy', 'type_and_printing', 'general_print', 'exam_paper', 'printed_product'));

-- 5. Drop the parent group table.
DROP TABLE IF EXISTS exam_batch_groups;

COMMIT;