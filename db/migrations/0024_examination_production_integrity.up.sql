-- Migration 0024: Examination production integrity
-- Makes PostgreSQL authoritative for examination production by adding:
--   * paper-level specification, lifecycle, QC, delivery and invoice fields
--   * batch-level status / scheduling fields and aggregate costs
--   * an append-only examination production event history
--   * a constrained per-paper invoice link table (consolidated invoices)
--   * database-level transition, idempotency and immutability protections
--
-- Additive only. Existing rows are preserved and explicitly flagged as legacy
-- where their historical cost/specification cannot be proven.

-- 1. Batch-level lifecycle and scheduling -----------------------------------
ALTER TABLE exam_assessment_batches
  ADD COLUMN IF NOT EXISTS status VARCHAR(24) NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS total_paper_cost NUMERIC(19, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS total_toner_cost NUMERIC(19, 4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

ALTER TABLE exam_assessment_batches
  DROP CONSTRAINT IF EXISTS ck_exam_batches_status;
ALTER TABLE exam_assessment_batches
  ADD CONSTRAINT ck_exam_batches_status CHECK (status IN (
    'draft', 'scheduled', 'in_production', 'completed', 'delivered',
    'invoiced', 'closed', 'cancelled'
  ));
ALTER TABLE exam_assessment_batches
  DROP CONSTRAINT IF EXISTS ck_exam_batches_priority;
ALTER TABLE exam_assessment_batches
  ADD CONSTRAINT ck_exam_batches_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

CREATE INDEX IF NOT EXISTS ix_exam_batches_company_status
  ON exam_assessment_batches (company_id, status, due_date);

DROP TRIGGER IF EXISTS trg_exam_batches_updated_at ON exam_assessment_batches;
CREATE TRIGGER trg_exam_batches_updated_at
  BEFORE UPDATE ON exam_assessment_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. Paper-level specification, lifecycle and financial linkage -------------
ALTER TABLE exam_papers
  ADD COLUMN IF NOT EXISTS paper_size VARCHAR(16) NOT NULL DEFAULT 'A4',
  ADD COLUMN IF NOT EXISTS printing_item_id BIGINT,
  ADD COLUMN IF NOT EXISTS machine_id BIGINT,
  ADD COLUMN IF NOT EXISTS production_job_id BIGINT,
  ADD COLUMN IF NOT EXISTS production_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS qc_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS qc_approved_copies INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS good_copies INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spoiled_copies INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS waste_sheets NUMERIC(19, 6) NOT NULL DEFAULT 0.000000,
  ADD COLUMN IF NOT EXISTS reprint_of_paper_id BIGINT,
  ADD COLUMN IF NOT EXISTS invoice_id BIGINT,
  ADD COLUMN IF NOT EXISTS delivery_note_id BIGINT,
  ADD COLUMN IF NOT EXISTS cost_status VARCHAR(24) NOT NULL DEFAULT 'legacy_unverified',
  ADD COLUMN IF NOT EXISTS cost_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS exam_papers_status_check;
ALTER TABLE exam_papers
  ADD CONSTRAINT exam_papers_status_check CHECK (status IN (
    'draft', 'scheduled', 'queued', 'reserved', 'printing', 'qc_hold',
    'qc_passed', 'completed', 'packed', 'dispatched', 'delivered',
    'invoiced', 'cancelled', 'reprinted'
  ));
ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_paper_size;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_paper_size CHECK (paper_size IN ('A4', 'A3', 'B5', 'Letter'));
ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_qc_status;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_qc_status CHECK (qc_status IN (
    'pending', 'in_progress', 'passed', 'failed', 'rework', 'not_required'
  ));
ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_cost_status;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_cost_status CHECK (cost_status IN (
    'authoritative', 'estimated', 'unavailable', 'legacy_unverified'
  ));
ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_qc_copies;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_qc_copies CHECK (
    qc_approved_copies >= 0 AND good_copies >= 0 AND spoiled_copies >= 0
  );
ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS ck_exam_papers_waste;
ALTER TABLE exam_papers
  ADD CONSTRAINT ck_exam_papers_waste CHECK (waste_sheets >= 0);

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS fk_exam_papers_printing_item;
ALTER TABLE exam_papers
  ADD CONSTRAINT fk_exam_papers_printing_item FOREIGN KEY (company_id, printing_item_id)
  REFERENCES inventory_items (company_id, id) ON DELETE RESTRICT;

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS fk_exam_papers_machine;
ALTER TABLE exam_papers
  ADD CONSTRAINT fk_exam_papers_machine FOREIGN KEY (company_id, machine_id)
  REFERENCES printing_machines (company_id, id) ON DELETE RESTRICT;

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS fk_exam_papers_production_job;
ALTER TABLE exam_papers
  ADD CONSTRAINT fk_exam_papers_production_job FOREIGN KEY (company_id, production_job_id)
  REFERENCES printing_jobs (company_id, id) ON DELETE RESTRICT;

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS fk_exam_papers_reprint_parent;
ALTER TABLE exam_papers
  ADD CONSTRAINT fk_exam_papers_reprint_parent FOREIGN KEY (company_id, reprint_of_paper_id)
  REFERENCES exam_papers (company_id, id) ON DELETE RESTRICT;

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS fk_exam_papers_invoice;
ALTER TABLE exam_papers
  ADD CONSTRAINT fk_exam_papers_invoice FOREIGN KEY (company_id, invoice_id)
  REFERENCES invoices (company_id, id) ON DELETE RESTRICT;

ALTER TABLE exam_papers
  DROP CONSTRAINT IF EXISTS fk_exam_papers_delivery_note;
ALTER TABLE exam_papers
  ADD CONSTRAINT fk_exam_papers_delivery_note FOREIGN KEY (company_id, delivery_note_id)
  REFERENCES delivery_notes (company_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_exam_papers_company_batch
  ON exam_papers (company_id, batch_id);
CREATE INDEX IF NOT EXISTS ix_exam_papers_company_invoice
  ON exam_papers (company_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_exam_papers_company_delivery
  ON exam_papers (company_id, delivered_at) WHERE delivered_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_exam_papers_updated_at ON exam_papers;
CREATE TRIGGER trg_exam_papers_updated_at
  BEFORE UPDATE ON exam_papers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Append-only event history ---------------------------------------------
CREATE TABLE IF NOT EXISTS exam_paper_events (
  id                BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  batch_id          BIGINT NOT NULL,
  paper_id          BIGINT NOT NULL,
  event_type        VARCHAR(40) NOT NULL,
  from_status       VARCHAR(24),
  to_status         VARCHAR(24),
  actor_user_id     BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  reason            TEXT,
  quantity_delta    NUMERIC(19, 6),
  inventory_txn_id  BIGINT,
  journal_txn_id    BIGINT,
  invoice_id        BIGINT,
  idempotency_key   VARCHAR(128),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_exam_paper_events_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_exam_events_batch FOREIGN KEY (company_id, batch_id)
    REFERENCES exam_assessment_batches (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_exam_events_paper FOREIGN KEY (company_id, paper_id)
    REFERENCES exam_papers (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_exam_events_actor FOREIGN KEY (actor_user_id)
    REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_exam_events_invoice FOREIGN KEY (company_id, invoice_id)
    REFERENCES invoices (company_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS ix_exam_events_company_paper
  ON exam_paper_events (company_id, paper_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_exam_events_company_batch
  ON exam_paper_events (company_id, batch_id, id DESC);

CREATE OR REPLACE FUNCTION prevent_exam_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'exam_paper_events is append-only; record a corrective event instead';
END;
$$;

DROP TRIGGER IF EXISTS trg_exam_events_immutable ON exam_paper_events;
CREATE TRIGGER trg_exam_events_immutable
  BEFORE UPDATE OR DELETE ON exam_paper_events
  FOR EACH ROW EXECUTE FUNCTION prevent_exam_event_mutation();

ALTER TABLE exam_paper_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_paper_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_exam_paper_events_isolation ON exam_paper_events;
CREATE POLICY p_exam_paper_events_isolation ON exam_paper_events
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));

-- 4. Per-paper invoice linkage (supports consolidated invoices) -------------
CREATE TABLE IF NOT EXISTS exam_paper_invoice_links (
  id               BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id       BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  paper_id         BIGINT NOT NULL,
  batch_id         BIGINT NOT NULL,
  invoice_id       BIGINT NOT NULL,
  invoice_line_id  BIGINT,
  customer_id      BIGINT NOT NULL,
  linked_quantity  NUMERIC(19, 4) NOT NULL DEFAULT 0.0000,
  linked_amount    NUMERIC(19, 4) NOT NULL DEFAULT 0.0000,
  created_by       BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_exam_invoice_links_company_id UNIQUE (company_id, id),
  CONSTRAINT uq_exam_invoice_links_paper UNIQUE (company_id, paper_id),
  CONSTRAINT fk_exam_invoice_links_paper FOREIGN KEY (company_id, paper_id)
    REFERENCES exam_papers (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_exam_invoice_links_batch FOREIGN KEY (company_id, batch_id)
    REFERENCES exam_assessment_batches (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_exam_invoice_links_invoice FOREIGN KEY (company_id, invoice_id)
    REFERENCES invoices (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_exam_invoice_links_line FOREIGN KEY (company_id, invoice_line_id)
    REFERENCES invoice_lines (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_exam_invoice_links_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES customers (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_exam_invoice_links_qty CHECK (linked_quantity >= 0),
  CONSTRAINT ck_exam_invoice_links_amount CHECK (linked_amount >= 0)
);

CREATE INDEX IF NOT EXISTS ix_exam_invoice_links_company_invoice
  ON exam_paper_invoice_links (company_id, invoice_id);

ALTER TABLE exam_paper_invoice_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_paper_invoice_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_exam_invoice_links_isolation ON exam_paper_invoice_links;
CREATE POLICY p_exam_invoice_links_isolation ON exam_paper_invoice_links
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));

-- 5. Legacy backfill (never fabricates costs) ------------------------------
UPDATE exam_papers
   SET cost_status = 'legacy_unverified',
       queued_at = COALESCE(queued_at, created_at),
       qc_status = CASE WHEN status = 'completed' THEN 'passed' ELSE qc_status END,
       qc_approved_copies = CASE WHEN status IN ('completed', 'invoiced') THEN copies ELSE qc_approved_copies END,
       good_copies = CASE WHEN status IN ('completed', 'invoiced') THEN copies ELSE good_copies END,
       completed_at = CASE WHEN status IN ('completed', 'invoiced') THEN COALESCE(completed_at, created_at) ELSE completed_at END
 WHERE cost_status = 'legacy_unverified';

INSERT INTO exam_paper_events (
  company_id, batch_id, paper_id, event_type, from_status, to_status,
  actor_user_id, reason, metadata
)
SELECT p.company_id, p.batch_id, p.id, 'legacy_import', NULL, p.status,
       NULL, 'Existing examination paper preserved during migration 0024',
       jsonb_build_object('legacyCostStatus', 'legacy_unverified')
  FROM exam_papers p
 WHERE NOT EXISTS (
   SELECT 1 FROM exam_paper_events e
    WHERE e.company_id = p.company_id AND e.paper_id = p.id
 );
