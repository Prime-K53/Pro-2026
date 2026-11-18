-- Rollback 0005: Drop Inventory, Paper Specs, Materials, Variants, BOMs & Item FKs

DROP TRIGGER IF EXISTS trg_item_bom_raw_check ON item_bom_components;
DROP TRIGGER IF EXISTS trg_item_variants_type_check ON item_variants;
DROP TRIGGER IF EXISTS trg_invoice_lines_no_raw_material ON invoice_lines;
DROP FUNCTION IF EXISTS enforce_bom_raw_material_check() CASCADE;
DROP FUNCTION IF EXISTS enforce_item_variant_rules() CASCADE;
DROP FUNCTION IF EXISTS enforce_invoice_line_no_raw_material() CASCADE;

ALTER TABLE vendor_credit_lines DROP CONSTRAINT IF EXISTS fk_vc_lines_item;
ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS fk_bill_lines_item;
ALTER TABLE purchase_order_lines DROP CONSTRAINT IF EXISTS fk_po_lines_item;
ALTER TABLE recurring_invoice_lines DROP CONSTRAINT IF EXISTS fk_recurring_lines_item;
ALTER TABLE credit_memo_lines DROP CONSTRAINT IF EXISTS fk_cm_lines_item;
ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS fk_invoice_lines_variant;
ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS fk_invoice_lines_item;
ALTER TABLE estimate_lines DROP CONSTRAINT IF EXISTS fk_estimate_lines_variant;
ALTER TABLE estimate_lines DROP CONSTRAINT IF EXISTS fk_estimate_lines_item;

DROP TABLE IF EXISTS inventory_movements CASCADE;
DROP TABLE IF EXISTS inventory_adjustments CASCADE;
DROP TABLE IF EXISTS item_bom_components CASCADE;
DROP TABLE IF EXISTS item_variants CASCADE;
DROP TABLE IF EXISTS material_specifications CASCADE;
DROP TABLE IF EXISTS inventory_items CASCADE;
DROP TABLE IF EXISTS paper_specifications CASCADE;
