# Source-to-Target Schema Mapping (`SlowBooks-Pro-2026` + PMS Frontend → PostgreSQL 17)

This mapping accounts for **all source SQLAlchemy entities** inspected in `VonHoltenCodes/SlowBooks-Pro-2026` (`app/models/*.py`) and all active **Printing Management System** TypeScript domain models (`src/types/accounting.ts`).

---

## 1. Identity, Access Control & Company Management (`0001`)

| Source Entity (`SlowBooks-Pro-2026`) | Source Identifiers / Purpose | Target Entity (PostgreSQL) | Migration | Mapping & Isolation Strategy |
|---|---|---|---|---|
| `companies` | Company file registry | `companies` | `0001` | Tenant root (`id` BIGINT IDENTITY, `slug` unique, `base_currency`/`currency_symbol='K'`, rounding config). |
| `users` | Global user credentials & `session_version` | `users` | `0001` | Preserved `id`, `username` (CI unique), `password_hash`, `session_version`, `expires_on`. Added `company_memberships` for multi-company RBAC. |
| *(New)* | Per-company user role join | `company_memberships` | `0001` | Links `users` ↔ `companies` with roles (`Administrator`, `Accountant`, `Bookkeeper`, `ProductionManager`, `Read-Only`). |
| `api_tokens` | REST API bearer tokens | `api_tokens` | `0001` | Scoped by `company_id` + `user_id`, SHA-256 `token_hash`. |
| `login_attempts` | Auth rate-limit & audit log | `login_attempts` | `0001` | Direct 1:1 mapping (`username`, `ip_address`, `success`, `created_at`). |
| `user_preferences` | Per-user UI preferences | `user_preferences` | `0001` | Tenant-scoped `(company_id, user_id, pref_key)`. |
| `settings` | Company settings KV pairs | `company_settings` | `0001` | Tenant-scoped `(company_id, setting_key)` to isolate settings per company. |
| `request_keys` | Idempotency replay protection | `request_keys` | `0001` | Tenant-scoped `(company_id, route, idempotency_key)` + `actor_user_id`. |
| `payment_terms` | Net/discount billing rules | `payment_terms` | `0001` | Preserved `kind`, `net_days`, `due_day`, `discount_percent NUMERIC(9,6)`. |
| `classes` | Cost center / division tags | `txn_classes` | `0001` | Preserved hierarchical self-FK `(company_id, parent_id)`. |
| `backups`, `accountants_copies`, `qbo_mappings` | Backup snapshots, CPA dividing date, QBO sync | `backups`, `accountants_copies`, `qbo_mappings` | `0001` | Direct 1:1 tenant-scoped mappings with composite `company_id`. |

---

## 2. Accounting, COA, General Ledger & Journals (`0002`)

| Source Entity | Target Entity | Migration | Precision & Accounting Rules Preserved |
|---|---|---|---|
| `accounts` | `accounts` | `0002` | Preserves `code`, `account_type`, `detail_type`, `bank_kind`, self-FK `parent_id`, `is_system`, `is_control`. Adds `normal_balance` CHECK. |
| `wip_entry_locks` + closing date settings | `fiscal_periods` | `0002` | Generalized fiscal period ranges (`open`, `soft_closed`, `closed`) enforced by ledger posting trigger. |
| `transactions` | `journal_transactions` | `0002` | Preserves `source_type`, `source_id`, `source_ref`, `source_kind`, `source_difference NUMERIC(19,4)`, `replaces/reverses_transaction_id`, `reversed_by_transaction_id`. Enforces immutability trigger. |
| `transaction_lines` | `journal_lines` | `0002` | Upgraded `debit`/`credit` from `Numeric(15,2)` to `NUMERIC(19,4)`. Preserves `basis IN ('both','accrual','cash')`, `ck_journal_line_single_side`, `ck_journal_line_nonzero`, and deferred `SUM(debit)=SUM(credit)` trigger. |

---

## 3. Customers, Sales & Receivables (`0003`)

| Source Entity | Target Entity | Migration | Mapping Notes |
|---|---|---|---|
| `customers` | `customers` | `0003` | Preserves sub-customer `parent_customer_id`, `payment_term_id`, `terms_label`. Adds `customer_type` (`school`, `corporate`, `individual`, `government`, `nonprofit`) & `balance NUMERIC(19,4)`. |
| `reseller_permits` | `reseller_permits` | `0003` | Tenant-scoped tax exemption certificates FK to `customers(company_id, id)`. |
| `invoice_messages` | `invoice_messages` | `0003` | Reusable invoice/estimate/statement footer text. |
| `estimates`, `estimate_lines` | `estimates`, `estimate_lines` | `0003` | Upgraded amounts to `NUMERIC(19,4)` & quantities/unit costs to `NUMERIC(19,6)`. Preserves conversion link `invoices.source_estimate_id`. |
| `invoices`, `invoice_lines` | `invoices`, `invoice_lines` | `0003` | Adds `variant_id`/`variant_name`, `unit_cost NUMERIC(19,6)`, `total_cost NUMERIC(19,4)`, and computed `gross_profit = subtotal - total_cost`. Enforces `amount_paid + balance_due = total`. |
| `payments`, `payment_allocations` | `payments`, `payment_allocations` | `0003` | Multi-invoice settlement (`payment_allocations`), `from_remainder`, `discount_override`, `deposit_to_account_id`, `journal_txn_id`. |
| `credit_memos`, `credit_memo_lines`, `credit_applications` | `credit_memos`, `credit_memo_lines`, `credit_applications` | `0003` | Direct 1:1 mapping with composite company FKs & `NUMERIC(19,4)`. |
| `invoice_reminder_rules`, `invoice_reminders`, `customer_statements` | `invoice_reminder_rules`, `invoice_reminders`, `customer_statements` | `0003` | Direct 1:1 collections tables. |
| `recurring_invoices`, `recurring_invoice_lines`, `memorized_transactions`, `memorized_transaction_lines` | Identical names | `0003` | Direct 1:1 mapping with composite company FKs. |

---

## 4. Suppliers, Purchases, Payables & Banking (`0004`)

| Source Entity | Target Entity | Migration | Mapping Notes |
|---|---|---|---|
| `vendors` | `vendors` | `0004` | Preserves `default_expense_account_id`, `payment_term_id`, `ein_or_ssn`, `is_1099_eligible`, `balance NUMERIC(19,4)`. |
| `purchase_orders`, `purchase_order_lines` | `purchase_orders`, `purchase_order_lines` | `0004` | Quantity/received qty in `NUMERIC(19,6)`, amounts in `NUMERIC(19,4)`. |
| `bills`, `bill_lines` | `bills`, `bill_lines` | `0004` | Preserves `uq_bills_company_vendor_num` unique bill# per vendor, `use_tax_rate NUMERIC(9,6)`, and `amount_paid + balance_due = total` CHECK. |
| `bill_payments`, `bill_payment_allocations` | `bill_payments`, `bill_payment_allocations` | `0004` | Multi-bill settlement with bank account & journal FKs. |
| `vendor_credits`, `vendor_credit_lines`, `vendor_credit_applications` | Identical names | `0004` | Direct 1:1 mapping with composite FKs. |
| `bank_accounts`, `bank_transactions`, `bank_check_details`, `bank_rules`, `reconciliations`, `deposit_other_lines`, `duplicate_dismissals` | Identical names | `0004` | Reconciliations enforce `CHECK (difference = 0.0000)`. Bank txns keep unique `(company_id, account_id, external_fitid)` for idempotent feed sync. |

---

## 5. Inventory, Paper Specs, Materials, Variants & BOMs (`0005`)

| Source Entity | Target Entity | Migration | Mapping & Enhancement Notes |
|---|---|---|---|
| *(New / PMS)* | `paper_specifications` | `0005` | Standardizes paper size (`A4`, `A3`, `B5`, `Letter`, etc.), `width_mm`/`height_mm`, `gsm`, `finish`, `grain_direction`, `sheets_per_ream`. |
| `items` | `inventory_items` | `0005` | Maps 4 SlowBooks types (`product`/`service`/`material`/`labor`) → strict 4 PMS types (`raw_material`, `printed_product`, `stationery`, `printing_service`). Adds `purchase_unit`, `usage_unit`, `conversion_factor NUMERIC(19,6)`, `paper_spec_id`. Enforces non-stocked `on_hand=0` for `printed_product`/`printing_service` and non-invoiceable `raw_material`. |
| *(New / PMS)* | `material_specifications` | `0005` | Extends `raw_material` items with `material_category` (`paper`, `toner`, `ink`, `plate`, `binding_consumable`, `lamination`), `yield_per_purchase_unit`, `coverage_basis_pct`. |
| *(PMS Type)* | `item_variants` | `0005` | Supports product variants on `stationery` (per-variant SKU & stock) and `printed_product` (per-variant cost & price, `on_hand=0`). |
| *(PMS Type)* | `item_bom_components` | `0005` | Bill of Materials linking `printed_product` / `printing_service` (and optional variant) → `raw_material` quantities in `usage_unit`. |
| `inventory_movements`, `inventory_adjustments` | Identical names | `0005` | Quantity deltas in `NUMERIC(19,6)`, unit cost/avg cost in `NUMERIC(19,6)`, immutable reversal link `reverses_movement_id`. |

---

## 6. Payroll/HR, Assets, Budgets, Documents, Audit & Reporting (`0006`)

| Source Entity | Target Entity | Migration | Mapping Notes |
|---|---|---|---|
| `employees`, `employee_bank_accounts`, `benefit_codes`, `employee_benefits`, `pay_runs`, `pay_stubs`, `pay_stub_benefits`, `pto_policies`, `pto_accruals`, `onboarding_tasks`, `time_entries` | Identical names | `0006` | All wages, withholdings, taxes, and benefits stored as `NUMERIC(19,4)`. Additional SlowBooks sub-tables (`benefit_rates`, `employee_groups`, `garnishment_orders`, `payroll_opening_*`, `pto_requests`) consolidate cleanly onto `benefit_codes`/`employee_benefits`/`pto_accruals` when payroll compliance expands in Phase 3 without speculative empty tables today. |
| `fixed_asset_types`, `fixed_assets` | Identical names | `0006` | Enforces `salvage_value <= purchase_price` and `accumulated_depreciation <= purchase_price - salvage_value`; book value derived dynamically (`purchase_price - accumulated_depreciation`). |
| `budgets` | `budgets` | `0006` | Monthly budget amounts per `(company_id, account_id, fiscal_year, fiscal_month, class_id)` in `NUMERIC(19,4)`. |
| `stored_files`, `attachments`, `ocr_templates`, `email_templates`, `email_log` | Identical names | `0006` | Document vault & OCR template persistence with `company_id` RLS. |
| `audit_log`, `document_audits` | Identical names | `0006` | Append-only trigger blocks `UPDATE` and `DELETE` on `audit_log`; preserves `sha256_hash` tamper digest. |
| `saved_reports`, `tax_category_mappings` | Identical names | `0006` | Saved report definitions (`JSONB`) and tax-line mappings per company. |

---

## 7. Printing Production Domains (`0007`) & Superseded SlowBooks Verticals

| Source Entity (`SlowBooks` / PMS) | Target Entity | Migration | Rationale / Relationship Notes |
|---|---|---|---|
| `job_costing.Equipment` | `printing_machines` | `0007` | Press, photocopier, guillotine, stitcher, binder registry linked optionally to `fixed_assets` with `click_cost_per_imp NUMERIC(19,6)` & `meter_impressions`. |
| `estimates` (printing extension) | `printing_estimates`, `printing_estimate_lines` | `0007` | Sheet/impression/spoilage calculator driven from `paper_specifications`, `inventory_items` (raw paper/toner), and `printing_machines`; computes `total_cost` and `estimated_profit` vs manual selling price. |
| `job_deposits` + PMS `PrintingContract` | `printing_contracts`, `contract_assessment_milestones` | `0007` | School lump-sum prepaid retainer contracts (`2..5` assessments) with mandatory `scheduled_date`, `agreed_amount`, estimated paper/toner cost, and per-assessment `profit` (`agreed_amount - (paper_cost + toner_cost)`). |
| PMS `ExamPaper` | `exam_assessment_batches`, `exam_papers` | `0007` | Normalized into **Class-Level Billing Batch** (`learners_count * price_per_learner = class_revenue`) + **Subject Production Papers** (`pages`, `copies`, `sheets_used`, `impressions_used`, `paper_cost`, `toner_cost`) supporting 1 consolidated invoice line per class. |
| `jobs` + PMS `QuickPrintJob` | `printing_jobs` | `0007` | Unified production order for `quick_photocopy`, `type_and_printing`, `general_print`, `exam_paper`, and `printed_product` runs with real profit tracking (`manual_selling_price - total_cost`). |
| *(New / Press Workflow)* | `production_operations` | `0007` | Tracks prepress, typesetting, plate-making, press run, duplex pass, operator user, good sheets vs spoilage sheets. |
| *(New / Press Workflow)* | `finishing_operations` | `0007` | Tracks cutting, folding, collating, stapling, saddle-stitching, spiral/perfect binding, lamination, and raw consumable usage. |
| *(New / Press Workflow)* | `quality_control_inspections` | `0007` | Tracks sample size, defect count (`<= sample_size`), registration/density/binding checks, and `approved`/`rework`/`rejected` disposition. |
| *(New / Logistics)* | `delivery_notes`, `delivery_note_lines` | `0007` | Dispatches completed `printing_jobs` or `exam_papers` to customers/schools with driver/recipient sign-off. |
| `sov_lines`, `pay_applications`, `pay_application_lines`, `change_orders`, `field_tickets`, `lien_waivers`, `trade_packages`, `cost_codes`, `in_kind_gifts`, `restriction_releases`, `functional_allocations` | **Consolidated / Deprecated** | — | Construction AIA progress-billing and 501(c)(3) nonprofit allocation vertical tables from `SlowBooks-Pro-2026`. Intentionally omitted from DDL to avoid speculative unused tables while commercial press estimating, contracts, exams, and delivery notes fulfill the printing vertical. |
