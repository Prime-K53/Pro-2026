-- Rollback Migration 0011: Phase 9 Production Workflow Integration

ALTER TABLE journal_transactions
  DROP CONSTRAINT IF EXISTS journal_transactions_source_type_check;

ALTER TABLE journal_transactions
  ADD CONSTRAINT journal_transactions_source_type_check CHECK (source_type IN (
    'manual', 'invoice', 'sales_receipt', 'payment', 'credit_memo',
    'bill', 'bill_payment', 'vendor_credit',
    'deposit', 'transfer', 'check', 'expense', 'credit_card_charge', 'bank_import',
    'payroll', 'reconciliation', 'inventory_adjustment', 'depreciation',
    'printing_contract', 'quick_print', 'exam_production', 'opening_balance',
    'reversal', 'closing_entry', 'fx_gain_loss'
  ));

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS fk_invoices_deposited_bank_txn;
ALTER TABLE invoices
  DROP COLUMN IF EXISTS deposited_bank_txn_id;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS fk_payments_deposited_bank_txn;
ALTER TABLE payments
  DROP COLUMN IF EXISTS deposited_bank_txn_id;

ALTER TABLE delivery_note_lines
  DROP COLUMN IF EXISTS invoiced_qty;

ALTER TABLE delivery_notes
  DROP CONSTRAINT IF EXISTS fk_delivery_notes_invoice;
ALTER TABLE delivery_notes
  DROP COLUMN IF EXISTS invoice_id,
  DROP COLUMN IF EXISTS delivered_by;

ALTER TABLE finishing_operations
  DROP CONSTRAINT IF EXISTS fk_finish_ops_journal;
ALTER TABLE finishing_operations
  DROP COLUMN IF EXISTS journal_txn_id,
  DROP COLUMN IF EXISTS machine_cost,
  DROP COLUMN IF EXISTS labour_cost,
  DROP COLUMN IF EXISTS labour_rate_per_hour,
  DROP COLUMN IF EXISTS actual_hours;

ALTER TABLE production_operations
  DROP CONSTRAINT IF EXISTS fk_prod_ops_journal;
ALTER TABLE production_operations
  DROP COLUMN IF EXISTS journal_txn_id,
  DROP COLUMN IF EXISTS machine_cost,
  DROP COLUMN IF EXISTS impressions_run,
  DROP COLUMN IF EXISTS labour_cost,
  DROP COLUMN IF EXISTS labour_rate_per_hour,
  DROP COLUMN IF EXISTS actual_hours;

DROP POLICY IF EXISTS p_job_mat_req_isolation ON job_material_requirements;
DROP TRIGGER IF EXISTS trg_job_material_requirements_updated_at ON job_material_requirements;
DROP TABLE IF EXISTS job_material_requirements;

DROP POLICY IF EXISTS p_goods_receipt_lines_isolation ON goods_receipt_lines;
DROP TABLE IF EXISTS goods_receipt_lines;

DROP POLICY IF EXISTS p_goods_receipts_isolation ON goods_receipts;
DROP TABLE IF EXISTS goods_receipts;

ALTER TABLE bills
  DROP COLUMN IF EXISTS awaiting_receipt;

ALTER TABLE purchase_order_lines
  DROP CONSTRAINT IF EXISTS ck_po_lines_qty_bounds;
ALTER TABLE purchase_order_lines
  DROP COLUMN IF EXISTS billed_qty;

DROP INDEX IF EXISTS uq_po_company_requisition;
ALTER TABLE purchase_orders
  DROP CONSTRAINT IF EXISTS fk_po_requisition;
ALTER TABLE purchase_orders
  DROP COLUMN IF EXISTS requisition_id;

DROP POLICY IF EXISTS p_purchase_req_lines_isolation ON purchase_requisition_lines;
DROP TABLE IF EXISTS purchase_requisition_lines;

DROP POLICY IF EXISTS p_purchase_requisitions_isolation ON purchase_requisitions;
DROP TRIGGER IF EXISTS trg_purchase_requisitions_updated_at ON purchase_requisitions;
DROP TABLE IF EXISTS purchase_requisitions;

ALTER TABLE printing_jobs
  DROP CONSTRAINT IF EXISTS ck_pjobs_qty_pipeline,
  DROP CONSTRAINT IF EXISTS fk_pjobs_cogs_journal,
  DROP CONSTRAINT IF EXISTS fk_pjobs_wip_journal,
  DROP CONSTRAINT IF EXISTS fk_pjobs_reprint_parent,
  DROP CONSTRAINT IF EXISTS fk_pjobs_sales_estimate;

ALTER TABLE printing_jobs
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS cogs_journal_txn_id,
  DROP COLUMN IF EXISTS wip_journal_txn_id,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS reprint_authorized_by,
  DROP COLUMN IF EXISTS reprint_reason,
  DROP COLUMN IF EXISTS reprint_of_job_id,
  DROP COLUMN IF EXISTS wip_cost_relieved,
  DROP COLUMN IF EXISTS wip_cost_accumulated,
  DROP COLUMN IF EXISTS actual_machine_cost,
  DROP COLUMN IF EXISTS actual_labour_cost,
  DROP COLUMN IF EXISTS actual_waste_cost,
  DROP COLUMN IF EXISTS actual_material_cost,
  DROP COLUMN IF EXISTS budget_approved_at,
  DROP COLUMN IF EXISTS budget_approved_by,
  DROP COLUMN IF EXISTS approved_budget_total,
  DROP COLUMN IF EXISTS approved_budget_machine,
  DROP COLUMN IF EXISTS approved_budget_labour,
  DROP COLUMN IF EXISTS approved_budget_material,
  DROP COLUMN IF EXISTS invoiced_qty,
  DROP COLUMN IF EXISTS delivered_qty,
  DROP COLUMN IF EXISTS qc_approved_qty,
  DROP COLUMN IF EXISTS produced_good_qty,
  DROP COLUMN IF EXISTS ordered_qty,
  DROP COLUMN IF EXISTS sales_estimate_id;

ALTER TABLE printing_jobs
  DROP CONSTRAINT IF EXISTS printing_jobs_status_check;

ALTER TABLE printing_jobs
  ADD CONSTRAINT printing_jobs_status_check CHECK (status IN (
    'queued', 'in_production', 'finishing', 'qc_pending', 'ready', 'delivered', 'completed', 'cancelled'
  ));

ALTER TABLE item_variants
  DROP CONSTRAINT IF EXISTS ck_item_variants_reserved_bounds;
ALTER TABLE item_variants
  DROP COLUMN IF EXISTS reserved_qty;

ALTER TABLE inventory_items
  DROP CONSTRAINT IF EXISTS ck_inventory_items_reserved_bounds;
ALTER TABLE inventory_items
  DROP COLUMN IF EXISTS reserved_qty;
