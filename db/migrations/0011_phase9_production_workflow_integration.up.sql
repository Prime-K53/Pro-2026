-- Migration 0011: Phase 9 Full Business Workflow & Production Integration
-- Adds:
--   - Inventory stock reservation tracking (reserved_qty <= on_hand) to prevent overselling & double consumption
--   - Purchase requisitions & demand -> PO -> Bill / Goods Receipt 3-way linkage
--   - Printing job budget approval, sales estimate linkage, partial production/QC/delivery/invoice qty invariants
--   - Job material requirements, reservation, issue, consumption, waste & return tracking
--   - Production & finishing labour/machine cost capture & WIP/COGS journal links
--   - Controlled reprints & job cancellation tracking
--   - Undeposited payment/receipt deposit linkage to prevent double bank deposits

-- 1. Inventory Reservation Columns & Check Constraints
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS reserved_qty NUMERIC(19, 6) NOT NULL DEFAULT 0.000000;

ALTER TABLE inventory_items
  DROP CONSTRAINT IF EXISTS ck_inventory_items_reserved_bounds;
ALTER TABLE inventory_items
  ADD CONSTRAINT ck_inventory_items_reserved_bounds
  CHECK (reserved_qty >= 0 AND reserved_qty <= on_hand);

ALTER TABLE item_variants
  ADD COLUMN IF NOT EXISTS reserved_qty NUMERIC(19, 6) NOT NULL DEFAULT 0.000000;

ALTER TABLE item_variants
  DROP CONSTRAINT IF EXISTS ck_item_variants_reserved_bounds;
ALTER TABLE item_variants
  ADD CONSTRAINT ck_item_variants_reserved_bounds
  CHECK (reserved_qty >= 0 AND reserved_qty <= on_hand);

-- 2. Printing Jobs Enhancements (Sales Estimate Link, Partial Qty Guards, Budget, WIP/COGS, Reprints, Cancellation)
ALTER TABLE printing_jobs
  DROP CONSTRAINT IF EXISTS printing_jobs_status_check;

ALTER TABLE printing_jobs
  ADD CONSTRAINT printing_jobs_status_check CHECK (status IN (
    'draft', 'budget_approved', 'queued', 'in_production', 'finishing',
    'qc_pending', 'ready', 'partial_delivery', 'delivered', 'completed', 'cancelled'
  ));

ALTER TABLE printing_jobs
  ADD COLUMN IF NOT EXISTS sales_estimate_id BIGINT,
  ADD COLUMN IF NOT EXISTS ordered_qty NUMERIC(19, 4) NOT NULL DEFAULT 1.0000 CHECK (ordered_qty > 0),
  ADD COLUMN IF NOT EXISTS produced_good_qty NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (produced_good_qty >= 0),
  ADD COLUMN IF NOT EXISTS qc_approved_qty NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (qc_approved_qty >= 0),
  ADD COLUMN IF NOT EXISTS delivered_qty NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (delivered_qty >= 0),
  ADD COLUMN IF NOT EXISTS invoiced_qty NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (invoiced_qty >= 0),
  ADD COLUMN IF NOT EXISTS approved_budget_material NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (approved_budget_material >= 0),
  ADD COLUMN IF NOT EXISTS approved_budget_labour NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (approved_budget_labour >= 0),
  ADD COLUMN IF NOT EXISTS approved_budget_machine NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (approved_budget_machine >= 0),
  ADD COLUMN IF NOT EXISTS approved_budget_total NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (approved_budget_total >= 0),
  ADD COLUMN IF NOT EXISTS budget_approved_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS budget_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_material_cost NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (actual_material_cost >= 0),
  ADD COLUMN IF NOT EXISTS actual_waste_cost NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (actual_waste_cost >= 0),
  ADD COLUMN IF NOT EXISTS actual_labour_cost NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (actual_labour_cost >= 0),
  ADD COLUMN IF NOT EXISTS actual_machine_cost NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (actual_machine_cost >= 0),
  ADD COLUMN IF NOT EXISTS wip_cost_accumulated NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (wip_cost_accumulated >= 0),
  ADD COLUMN IF NOT EXISTS wip_cost_relieved NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (wip_cost_relieved >= 0),
  ADD COLUMN IF NOT EXISTS reprint_of_job_id BIGINT,
  ADD COLUMN IF NOT EXISTS reprint_reason TEXT,
  ADD COLUMN IF NOT EXISTS reprint_authorized_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wip_journal_txn_id BIGINT,
  ADD COLUMN IF NOT EXISTS cogs_journal_txn_id BIGINT,
  ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE printing_jobs
  DROP CONSTRAINT IF EXISTS fk_pjobs_sales_estimate;
ALTER TABLE printing_jobs
  ADD CONSTRAINT fk_pjobs_sales_estimate FOREIGN KEY (company_id, sales_estimate_id)
  REFERENCES estimates (company_id, id) ON DELETE RESTRICT;

ALTER TABLE printing_jobs
  DROP CONSTRAINT IF EXISTS fk_pjobs_reprint_parent;
ALTER TABLE printing_jobs
  ADD CONSTRAINT fk_pjobs_reprint_parent FOREIGN KEY (company_id, reprint_of_job_id)
  REFERENCES printing_jobs (company_id, id) ON DELETE RESTRICT;

ALTER TABLE printing_jobs
  DROP CONSTRAINT IF EXISTS fk_pjobs_wip_journal;
ALTER TABLE printing_jobs
  ADD CONSTRAINT fk_pjobs_wip_journal FOREIGN KEY (company_id, wip_journal_txn_id)
  REFERENCES journal_transactions (company_id, id) ON DELETE RESTRICT;

ALTER TABLE printing_jobs
  DROP CONSTRAINT IF EXISTS fk_pjobs_cogs_journal;
ALTER TABLE printing_jobs
  ADD CONSTRAINT fk_pjobs_cogs_journal FOREIGN KEY (company_id, cogs_journal_txn_id)
  REFERENCES journal_transactions (company_id, id) ON DELETE RESTRICT;

ALTER TABLE printing_jobs
  DROP CONSTRAINT IF EXISTS ck_pjobs_qty_pipeline;
ALTER TABLE printing_jobs
  ADD CONSTRAINT ck_pjobs_qty_pipeline CHECK (
    qc_approved_qty <= produced_good_qty
    AND delivered_qty <= qc_approved_qty
    AND invoiced_qty <= delivered_qty
    AND wip_cost_relieved <= wip_cost_accumulated
  );

-- 3. Purchase Requisitions & Goods Receipts (3-Way Procurement Pipeline)
CREATE TABLE IF NOT EXISTS purchase_requisitions (
  id                 BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id         BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  requisition_number VARCHAR(64) NOT NULL,
  req_date           DATE NOT NULL,
  needed_by_date     DATE,
  demand_source      VARCHAR(24) NOT NULL DEFAULT 'manual' CHECK (demand_source IN ('manual', 'reorder_level', 'job_shortfall')),
  source_job_id      BIGINT,
  status             VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'converted', 'cancelled')),
  requested_by       BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  approved_by        BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  approved_at        TIMESTAMPTZ,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_purchase_reqs_company_id UNIQUE (company_id, id),
  CONSTRAINT uq_purchase_reqs_company_num UNIQUE (company_id, requisition_number),
  CONSTRAINT fk_purchase_reqs_job FOREIGN KEY (company_id, source_job_id)
    REFERENCES printing_jobs (company_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER trg_purchase_requisitions_updated_at
  BEFORE UPDATE ON purchase_requisitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE purchase_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_requisitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_purchase_requisitions_isolation ON purchase_requisitions;
CREATE POLICY p_purchase_requisitions_isolation ON purchase_requisitions
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));

CREATE TABLE IF NOT EXISTS purchase_requisition_lines (
  id                  BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id          BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  requisition_id      BIGINT NOT NULL,
  line_order          INTEGER NOT NULL DEFAULT 1,
  item_id             BIGINT,
  preferred_vendor_id BIGINT,
  description         TEXT NOT NULL,
  quantity            NUMERIC(19, 6) NOT NULL CHECK (quantity > 0),
  estimated_unit_cost NUMERIC(19, 6) NOT NULL DEFAULT 0.000000 CHECK (estimated_unit_cost >= 0),
  CONSTRAINT fk_pr_lines_req FOREIGN KEY (company_id, requisition_id)
    REFERENCES purchase_requisitions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_pr_lines_item FOREIGN KEY (company_id, item_id)
    REFERENCES inventory_items (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_pr_lines_vendor FOREIGN KEY (company_id, preferred_vendor_id)
    REFERENCES vendors (company_id, id) ON DELETE RESTRICT
);

ALTER TABLE purchase_requisition_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_requisition_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_purchase_req_lines_isolation ON purchase_requisition_lines;
CREATE POLICY p_purchase_req_lines_isolation ON purchase_requisition_lines
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS requisition_id BIGINT;

ALTER TABLE purchase_orders
  DROP CONSTRAINT IF EXISTS fk_po_requisition;
ALTER TABLE purchase_orders
  ADD CONSTRAINT fk_po_requisition FOREIGN KEY (company_id, requisition_id)
  REFERENCES purchase_requisitions (company_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_po_company_requisition
  ON purchase_orders (company_id, requisition_id)
  WHERE requisition_id IS NOT NULL;

ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS billed_qty NUMERIC(19, 6) NOT NULL DEFAULT 0.000000;

ALTER TABLE purchase_order_lines
  DROP CONSTRAINT IF EXISTS ck_po_lines_qty_bounds;
ALTER TABLE purchase_order_lines
  ADD CONSTRAINT ck_po_lines_qty_bounds CHECK (
    received_qty <= quantity AND billed_qty >= 0 AND billed_qty <= quantity
  );

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS awaiting_receipt BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS goods_receipts (
  id                BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  receipt_number    VARCHAR(64) NOT NULL,
  purchase_order_id BIGINT NOT NULL,
  bill_id           BIGINT,
  vendor_id         BIGINT NOT NULL,
  receipt_date      DATE NOT NULL,
  received_by       BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  status            VARCHAR(20) NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'voided')),
  journal_txn_id    BIGINT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_goods_receipts_company_id UNIQUE (company_id, id),
  CONSTRAINT uq_goods_receipts_company_num UNIQUE (company_id, receipt_number),
  CONSTRAINT fk_gr_po FOREIGN KEY (company_id, purchase_order_id)
    REFERENCES purchase_orders (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_gr_bill FOREIGN KEY (company_id, bill_id)
    REFERENCES bills (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_gr_vendor FOREIGN KEY (company_id, vendor_id)
    REFERENCES vendors (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_gr_journal FOREIGN KEY (company_id, journal_txn_id)
    REFERENCES journal_transactions (company_id, id) ON DELETE RESTRICT
);

ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_goods_receipts_isolation ON goods_receipts;
CREATE POLICY p_goods_receipts_isolation ON goods_receipts
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));

CREATE TABLE IF NOT EXISTS goods_receipt_lines (
  id                BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  goods_receipt_id  BIGINT NOT NULL,
  po_line_id        BIGINT NOT NULL,
  item_id           BIGINT,
  description       TEXT NOT NULL,
  quantity_received NUMERIC(19, 6) NOT NULL CHECK (quantity_received > 0),
  unit_cost         NUMERIC(19, 6) NOT NULL DEFAULT 0.000000 CHECK (unit_cost >= 0),
  CONSTRAINT fk_gr_lines_hdr FOREIGN KEY (company_id, goods_receipt_id)
    REFERENCES goods_receipts (company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_gr_lines_item FOREIGN KEY (company_id, item_id)
    REFERENCES inventory_items (company_id, id) ON DELETE RESTRICT
);

ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_goods_receipt_lines_isolation ON goods_receipt_lines;
CREATE POLICY p_goods_receipt_lines_isolation ON goods_receipt_lines
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));

-- 4. Job Material Requirements, Reservation, Issue, Actual Consumption & Waste
CREATE TABLE IF NOT EXISTS job_material_requirements (
  id                    BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id            BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  printing_job_id       BIGINT NOT NULL,
  raw_material_item_id  BIGINT NOT NULL,
  material_role         VARCHAR(24) NOT NULL DEFAULT 'paper' CHECK (material_role IN ('paper', 'toner', 'finishing', 'other')),
  usage_unit            VARCHAR(40) NOT NULL DEFAULT 'Unit',
  planned_usage_qty     NUMERIC(19, 6) NOT NULL CHECK (planned_usage_qty > 0),
  planned_unit_cost     NUMERIC(19, 6) NOT NULL DEFAULT 0.000000 CHECK (planned_unit_cost >= 0),
  planned_total_cost    NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (planned_total_cost >= 0),
  reserved_usage_qty    NUMERIC(19, 6) NOT NULL DEFAULT 0.000000 CHECK (reserved_usage_qty >= 0),
  issued_usage_qty      NUMERIC(19, 6) NOT NULL DEFAULT 0.000000 CHECK (issued_usage_qty >= 0),
  actual_good_usage_qty NUMERIC(19, 6) NOT NULL DEFAULT 0.000000 CHECK (actual_good_usage_qty >= 0),
  waste_usage_qty       NUMERIC(19, 6) NOT NULL DEFAULT 0.000000 CHECK (waste_usage_qty >= 0),
  returned_usage_qty    NUMERIC(19, 6) NOT NULL DEFAULT 0.000000 CHECK (returned_usage_qty >= 0),
  issued_avg_unit_cost  NUMERIC(19, 6) NOT NULL DEFAULT 0.000000 CHECK (issued_avg_unit_cost >= 0),
  waste_reason          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_job_mat_req_company_id UNIQUE (company_id, id),
  CONSTRAINT uq_job_mat_req_job_item_role UNIQUE (company_id, printing_job_id, raw_material_item_id, material_role),
  CONSTRAINT fk_job_mat_req_job FOREIGN KEY (company_id, printing_job_id)
    REFERENCES printing_jobs (company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_job_mat_req_item FOREIGN KEY (company_id, raw_material_item_id)
    REFERENCES inventory_items (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_job_mat_consumption_bounds CHECK (
    (actual_good_usage_qty + waste_usage_qty + returned_usage_qty) <= (issued_usage_qty + 0.000001)
  )
);

CREATE TRIGGER trg_job_material_requirements_updated_at
  BEFORE UPDATE ON job_material_requirements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE job_material_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_material_requirements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_job_mat_req_isolation ON job_material_requirements;
CREATE POLICY p_job_mat_req_isolation ON job_material_requirements
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));

-- 5. Production & Finishing Labour/Machine Cost Tracking + Delivery Invoice Guard
ALTER TABLE production_operations
  ADD COLUMN IF NOT EXISTS actual_hours NUMERIC(10, 4) NOT NULL DEFAULT 0.0000 CHECK (actual_hours >= 0),
  ADD COLUMN IF NOT EXISTS labour_rate_per_hour NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (labour_rate_per_hour >= 0),
  ADD COLUMN IF NOT EXISTS labour_cost NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (labour_cost >= 0),
  ADD COLUMN IF NOT EXISTS impressions_run NUMERIC(19, 6) NOT NULL DEFAULT 0.000000 CHECK (impressions_run >= 0),
  ADD COLUMN IF NOT EXISTS machine_cost NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (machine_cost >= 0),
  ADD COLUMN IF NOT EXISTS journal_txn_id BIGINT;

ALTER TABLE production_operations
  DROP CONSTRAINT IF EXISTS fk_prod_ops_journal;
ALTER TABLE production_operations
  ADD CONSTRAINT fk_prod_ops_journal FOREIGN KEY (company_id, journal_txn_id)
  REFERENCES journal_transactions (company_id, id) ON DELETE RESTRICT;

ALTER TABLE finishing_operations
  ADD COLUMN IF NOT EXISTS actual_hours NUMERIC(10, 4) NOT NULL DEFAULT 0.0000 CHECK (actual_hours >= 0),
  ADD COLUMN IF NOT EXISTS labour_rate_per_hour NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (labour_rate_per_hour >= 0),
  ADD COLUMN IF NOT EXISTS labour_cost NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (labour_cost >= 0),
  ADD COLUMN IF NOT EXISTS machine_cost NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (machine_cost >= 0),
  ADD COLUMN IF NOT EXISTS journal_txn_id BIGINT;

ALTER TABLE finishing_operations
  DROP CONSTRAINT IF EXISTS fk_finish_ops_journal;
ALTER TABLE finishing_operations
  ADD CONSTRAINT fk_finish_ops_journal FOREIGN KEY (company_id, journal_txn_id)
  REFERENCES journal_transactions (company_id, id) ON DELETE RESTRICT;

ALTER TABLE delivery_notes
  ADD COLUMN IF NOT EXISTS delivered_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS invoice_id BIGINT;

ALTER TABLE delivery_notes
  DROP CONSTRAINT IF EXISTS fk_delivery_notes_invoice;
ALTER TABLE delivery_notes
  ADD CONSTRAINT fk_delivery_notes_invoice FOREIGN KEY (company_id, invoice_id)
  REFERENCES invoices (company_id, id) ON DELETE RESTRICT;

ALTER TABLE delivery_note_lines
  ADD COLUMN IF NOT EXISTS invoiced_qty NUMERIC(19, 4) NOT NULL DEFAULT 0.0000 CHECK (invoiced_qty >= 0 AND invoiced_qty <= quantity_dispatched);

-- 6. Undeposited Funds -> Bank Deposit Linkage
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS deposited_bank_txn_id BIGINT;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS fk_payments_deposited_bank_txn;
ALTER TABLE payments
  ADD CONSTRAINT fk_payments_deposited_bank_txn FOREIGN KEY (company_id, deposited_bank_txn_id)
  REFERENCES bank_transactions (company_id, id) ON DELETE RESTRICT;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS deposited_bank_txn_id BIGINT;

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS fk_invoices_deposited_bank_txn;
ALTER TABLE invoices
  ADD CONSTRAINT fk_invoices_deposited_bank_txn FOREIGN KEY (company_id, deposited_bank_txn_id)
  REFERENCES bank_transactions (company_id, id) ON DELETE RESTRICT;

-- 7. Expand Journal Source Types for Goods Receipt & Production WIP/COGS/Variance
ALTER TABLE journal_transactions
  DROP CONSTRAINT IF EXISTS journal_transactions_source_type_check;

ALTER TABLE journal_transactions
  ADD CONSTRAINT journal_transactions_source_type_check CHECK (source_type IN (
    'manual', 'invoice', 'sales_receipt', 'payment', 'credit_memo',
    'bill', 'bill_payment', 'vendor_credit', 'goods_receipt',
    'deposit', 'transfer', 'check', 'expense', 'credit_card_charge', 'bank_import',
    'payroll', 'reconciliation', 'inventory_adjustment', 'depreciation',
    'printing_contract', 'quick_print', 'exam_production',
    'production_wip', 'production_issue', 'production_operation', 'production_cogs', 'production_variance',
    'opening_balance', 'reversal', 'closing_entry', 'fx_gain_loss'
  ));
