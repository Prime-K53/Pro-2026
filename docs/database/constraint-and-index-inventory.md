# Constraint, Foreign Key, Index & Trigger Inventory

This inventory documents every structural constraint, composite foreign key delete rule, unique constraint, query-driven index, trigger, and Row-Level Security (RLS) policy enforced across migrations `0001`–`0007`.

---

## 1. Foreign Key Delete Rules Summary

Financial, master-data, and production tables deliberately enforce **`ON DELETE RESTRICT`** to prevent accidental cascade loss of accounting history or referenced SKUs. Only tightly owned child detail lines (`invoice_lines`, `estimate_lines`, `bill_lines`, `credit_memo_lines`, `purchase_order_lines`, `pay_stubs`, `pay_stub_benefits`, `contract_assessment_milestones`, `item_bom_components`, `item_variants`, `delivery_note_lines`, `bank_check_details`, `deposit_other_lines`) cascade when an **unposted/draft** parent document is deleted.

All cross-table foreign keys use composite `(company_id, <fk_id>)` pointing to parent `UNIQUE (company_id, id)` keys so cross-tenant references are structurally impossible.

| Parent Table | Child Tables Referencing `(company_id, id)` | Delete Policy |
|---|---|---|
| `companies` | Every tenant table (`company_id`) | `RESTRICT` |
| `users` | `company_memberships`, `api_tokens`, `journal_transactions`, `fiscal_periods` | `RESTRICT` (Nullable log attribution uses `SET NULL`) |
| `accounts` | `journal_lines`, `vendors`, `payments`, `bill_payments`, `bank_accounts`, `reconciliations`, `inventory_items` (`asset`/`cogs`/`income`), `printing_contracts` | `RESTRICT` |
| `customers` | `estimates`, `invoices`, `payments`, `credit_memos`, `printing_contracts`, `exam_assessment_batches`, `printing_jobs`, `delivery_notes` | `RESTRICT` |
| `vendors` | `purchase_orders`, `bills`, `bill_payments`, `vendor_credits` | `RESTRICT` |
| `journal_transactions` | `journal_lines`, `invoices`, `payments`, `bills`, `bill_payments`, `pay_runs`, `printing_contracts`, `contract_assessment_milestones`, `printing_jobs` | `RESTRICT` |
| `inventory_items` | `invoice_lines`, `estimate_lines`, `bill_lines`, `item_bom_components` (`raw_material_item_id`), `inventory_movements`, `exam_papers`, `printing_jobs`, `contract_assessment_milestones`, `finishing_operations` | `RESTRICT` |
| `paper_specifications` | `inventory_items`, `printing_estimate_lines`, `exam_papers`, `printing_jobs` | `RESTRICT` |
| `printing_machines` | `printing_estimate_lines`, `printing_jobs`, `production_operations`, `finishing_operations` | `RESTRICT` |
| `printing_contracts` | `contract_assessment_milestones` (`CASCADE`), `exam_assessment_batches` (`RESTRICT`) | `RESTRICT` on batches |
| `exam_assessment_batches` | `exam_papers` | `RESTRICT` |
| `printing_jobs` | `production_operations`, `finishing_operations`, `quality_control_inspections`, `delivery_note_lines` | `RESTRICT` |

---

## 2. Unique Constraints & Partial Unique Indexes

| Name | Table | Columns / Expression | Purpose |
|---|---|---|---|
| `uq_companies_slug` | `companies` | `(slug)` | Unique workspace slug |
| `uq_users_username_lower` | `users` | `(LOWER(username))` | Case-insensitive unique login username |
| `uq_users_email_lower` | `users` | `(LOWER(email))` | Case-insensitive unique email |
| `uq_company_membership_user` | `company_memberships` | `(company_id, user_id)` | One role membership per user per company |
| `uq_request_keys_company_route_key` | `request_keys` | `(company_id, route, idempotency_key)` | Idempotent payment/invoice submission guard |
| `uq_accounts_company_code` | `accounts` | `(company_id, LOWER(code)) WHERE code IS NOT NULL` | Unique COA account number per company |
| `uq_journal_txns_company_number` | `journal_transactions` | `(company_id, entry_number)` | Unique journal voucher number per company |
| `uq_customers_company_name_lower` | `customers` | `(company_id, LOWER(name))` | Unique customer display name per company |
| `uq_invoices_company_number` | `invoices` | `(company_id, invoice_number)` | Unique invoice number per company |
| `uq_vendors_company_name_lower` | `vendors` | `(company_id, LOWER(name))` | Unique vendor name per company |
| `uq_bills_company_vendor_num` | `bills` | `(company_id, vendor_id, bill_number)` | Unique supplier bill number per vendor |
| `uq_bank_txns_fitid` | `bank_transactions` | `(company_id, account_id, external_fitid) WHERE external_fitid IS NOT NULL` | Deduplicates imported bank feed transactions |
| `uq_inventory_items_company_sku_lower` | `inventory_items` | `(company_id, LOWER(sku))` | Unique SKU per company |
| `uq_item_variants_company_sku_lower` | `item_variants` | `(company_id, LOWER(sku))` | Unique variant SKU per company |
| `uq_bom_item_raw` / `uq_bom_variant_raw` | `item_bom_components` | `(company_id, parent_item_id, [parent_variant_id,] raw_material_item_id)` | Prevents duplicate raw material entries per BOM |
| `uq_budgets_account_ym_class` | `budgets` | `(company_id, account_id, fiscal_year, fiscal_month, COALESCE(class_id, 0))` | One budget cell per account/month/class |
| `uq_contract_milestone_num` | `contract_assessment_milestones` | `(company_id, contract_id, assessment_number)` | Unique milestone slot (1..5) per contract |
| `uq_exam_batch_school_class` | `exam_assessment_batches` | `(company_id, school_customer_id, assessment_name, class_name)` | Enforces 1 class billing group per school assessment |
| `uq_exam_papers_batch_subject` | `exam_papers` | `(company_id, batch_id, subject_name)` | Prevents duplicate subject paper in same class batch |

*Plus `uq_<table>_company_id UNIQUE (company_id, id)` on every referenced parent table to anchor composite foreign keys.*

---

## 3. Critical Financial & Domain `CHECK` Constraints

| Table | Constraint Name | Expression / Rule |
|---|---|---|
| `companies` | `companies_sales_tax_rate_check` | `sales_tax_rate >= 0 AND sales_tax_rate <= 100` |
| `fiscal_periods` | `ck_fiscal_period_dates` | `end_date >= start_date` |
| `journal_transactions` | `ck_journal_no_self_reversal` | `reverses_transaction_id IS DISTINCT FROM id AND reversed_by_transaction_id IS DISTINCT FROM id` |
| `journal_lines` | `ck_journal_line_single_side` | `NOT (debit > 0 AND credit > 0)` |
| `journal_lines` | `ck_journal_line_nonzero` | `debit > 0 OR credit > 0` |
| `estimates` | `ck_estimates_total_consistent` | `total = subtotal + tax_amount` |
| `invoices` | `ck_invoices_total_math`, `ck_invoices_balance_math`, `ck_invoices_due_after_date` | `total = subtotal + tax_amount`, `amount_paid + balance_due = total`, `due_date >= invoice_date` |
| `bills` | `ck_bills_balance_math`, `ck_bills_due_after_date` | `amount_paid + balance_due = total`, `due_date >= bill_date` |
| `reconciliations` | `reconciliations_difference_check` | `difference = 0.0000` |
| `inventory_items` | `ck_items_non_stocked_types` | `item_type IN ('raw_material', 'stationery') OR on_hand = 0` |
| `inventory_items` | `ck_items_raw_material_not_for_sale` | `item_type <> 'raw_material' OR sales_price = 0` |
| `inventory_items` | `inventory_items_conversion_factor_check` | `conversion_factor > 0` |
| `item_bom_components` | `ck_bom_no_self_ref` | `parent_item_id <> raw_material_item_id` |
| `fixed_assets` | `ck_fixed_asset_salvage`, `ck_fixed_asset_accum_cap` | `salvage_value <= purchase_price`, `accumulated_depreciation <= purchase_price - salvage_value` |
| `printing_contracts` | `printing_contracts_total_assessments_check`, `ck_contracts_balance_cap`, `ck_contracts_completed_cap` | `total_assessments BETWEEN 2 AND 5`, `remaining_balance <= total_prepaid_amount`, `completed_assessments <= total_assessments` |
| `quality_control_inspections` | `quality_control_inspections_defect_count_check` | `defect_count >= 0 AND defect_count <= sample_size` |

---

## 4. Query-Driven Indexes

| Index Name | Table | Definition | Primary Query Access Path |
|---|---|---|---|
| `ix_accounts_company_type` | `accounts` | `(company_id, account_type, is_active)` | Trial Balance & COA dropdown filtering |
| `ix_journal_txns_company_date` | `journal_transactions` | `(company_id, txn_date DESC)` | General Ledger chronological register & P&L range queries |
| `ix_journal_txns_source` | `journal_transactions` | `(company_id, source_type, source_id)` | Drill-down from Invoice/Bill/Payment/Payroll to GL voucher |
| `ix_journal_lines_company_txn` | `journal_lines` | `(company_id, transaction_id, line_order)` | Reconstructing balanced journal lines & trigger balance checks |
| `ix_journal_lines_company_account` | `journal_lines` | `(company_id, account_id, basis)` | Accrual vs Cash P&L, Balance Sheet & Account Register summation |
| `ix_invoices_company_customer_status` | `invoices` | `(company_id, customer_id, status)` | Customer Center open balances & statement generation |
| `ix_invoices_company_due_date` | `invoices` | `(company_id, due_date) WHERE balance_due > 0` | Partial index for A/R Aging & overdue reminders |
| `ix_bills_company_vendor_status` | `bills` | `(company_id, vendor_id, status)` | Vendor Center & Pay Bills window |
| `ix_bills_company_due` | `bills` | `(company_id, due_date) WHERE balance_due > 0` | Partial index for A/P Aging |
| `ix_bank_txns_company_acct_date` | `bank_transactions` | `(company_id, account_id, txn_date DESC)` | Check Register & Bank Reconciliation workspace |
| `ix_inv_movements_company_item_at` | `inventory_movements` | `(company_id, item_id, movement_at DESC)` | Stock valuation audit & item movement ledger |
| `ix_exam_papers_company_status` | `exam_papers` | `(company_id, status, production_date DESC)` | Examination production queue & ready-to-invoice filter |
| `ix_printing_jobs_company_type_date` | `printing_jobs` | `(company_id, job_type, job_date DESC)` | Quick Photocopy / Type & Printing / Press Job history |
| `ix_audit_log_company_time` | `audit_log` | `(company_id, occurred_at DESC)` | Compliance audit log viewer |

---

## 5. Database Triggers & Row-Level Security Summary

- **Deferred Ledger Triggers:** `trg_enforce_balanced_journal_txn`, `trg_enforce_balanced_journal_line` (`DEFERRABLE INITIALLY DEFERRED`, enforce `SUM(debit) = SUM(credit)` & closed fiscal-period lock on `COMMIT`).
- **Ledger Immutability Triggers:** `trg_prevent_posted_txn_mutation`, `trg_prevent_posted_line_mutation` (block silent edits/deletes of posted journal rows).
- **Audit Log Immutability Trigger:** `trg_audit_log_append_only` (append-only enforcement on `audit_log`).
- **Inventory & Sales Domain Triggers:** `trg_invoice_lines_no_raw_material`, `trg_item_variants_type_check`, `trg_item_bom_raw_check`.
- **Row-Level Security (`ENABLE` + `FORCE ROW LEVEL SECURITY`):** Active on all 60+ tenant-scoped tables via `app_rls_allowed(company_id)`.
