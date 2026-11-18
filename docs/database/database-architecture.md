# Phase 2 Database Architecture Documentation — Printing Management System

## 1. Architectural Principles

1. **PostgreSQL 17 Authoritative Relational Core:** Reconstructs `SlowBooks-Pro-2026` accounting fidelity while adding commercial printing production, unit-converted raw materials, non-stocked BOM-driven printed products/services, per-learner examination class batching, and prepaid dated assessment contracts.
2. **Zero Floating-Point Monetary Storage:** Verified across all 7 migrations—no column uses `REAL`, `FLOAT`, or `DOUBLE PRECISION`.
3. **Defense-in-Depth Multi-Company Isolation:** Every company-owned table enforces both Row-Level Security (`FORCE ROW LEVEL SECURITY`) AND composite parent-child foreign keys `FOREIGN KEY (company_id, ref_id) REFERENCES parent(company_id, id)`.
4. **Immutable & Balanced General Ledger:** Database-level deferred constraint triggers guarantee `SUM(debit) = SUM(credit)` on every posted journal transaction at `COMMIT`, block mutations/deletions of posted entries, and require traceable reversal links (`reverses_transaction_id` / `reversed_by_transaction_id`).

---

## 2. Explicit Financial Precision & Rounding Rules

| Data Category | SQL Data Type | Scale & Purpose | Examples |
|---|---|---|---|
| **Standard Monetary Amounts** | `NUMERIC(19, 4)` | 15 integer digits + 4 fractional decimals (`0.0001`) | Ledger `debit`/`credit`, invoice `subtotal`/`tax_amount`/`total`, `balance_due`, `agreed_amount`, `profit`, payroll taxes |
| **Raw Unit Costs, Conversions & Quantities** | `NUMERIC(19, 6)` | 6 fractional decimals (`0.000001`) to prevent compounding error when converting purchase units to usage units | `1 Ream (K 145.00) / 500 Sheets = 0.290000/Sheet`; `1 Cartridge (K 1450.00) / 15000 Imp = 0.096667/Imp` |
| **Tax, Discount, Spoilage & Margin Rates** | `NUMERIC(9, 6)` / `NUMERIC(7, 4)` | Up to 6 decimal places for exact tax percentages and click multipliers | `sales_tax_rate = 16.000000`, `spoilage_pct = 2.0000` |
| **Paper Dimensions** | `NUMERIC(9, 2)` | Precision in millimeters | `210.00 × 297.00` (A4) |

### Rounding Policy
- **Calculation Phase:** Keep full `NUMERIC(19, 6)` precision through raw-material conversion (`unit_cost / conversion_factor`), BOM rollups (`SUM(bom.quantity_per_unit * raw_usage_unit_cost)`), and sheet/impression multiplication (`pages / 2 * copies` for duplex).
- **Document Line & Ledger Posting Boundary:** Apply deterministic `ROUND(..., 2)` / Half-Even ("Banker's Rounding") in the application posting service so currency amounts store cleanly in `NUMERIC(19, 4)` with `.xx00` cents/ngwee, and any tax/line sub-penny variance is balanced to zero before ledger `COMMIT`.
- **Ledger Check:** `trg_enforce_balanced_journal_txn` and `trg_enforce_balanced_journal_line` compare `SUM(debit - credit) = 0` at `NUMERIC(19, 4)` scale across both `('both', 'accrual')` and `('both', 'cash')` ledger views.

---

## 3. Multi-Company Isolation Architecture

Two orthogonal layers prevent cross-company data leakage or foreign-key corruption:

1. **Composite Tenant Foreign Keys (Structural Isolation):**
   - All tenant tables carry `company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT` AND declare `CONSTRAINT uq_<table>_company_id UNIQUE (company_id, id)`.
   - Every child reference uses `(company_id, foreign_id)` rather than `(foreign_id)` alone. Consequently, even a bug executed with RLS bypassed cannot attach a Company A customer, account, or raw material to a Company B invoice or BOM.
2. **Forced Row-Level Security (Query Isolation):**
   - Every company-scoped table sets `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` with policy:
     ```sql
     USING (app_rls_allowed(company_id))
     WITH CHECK (app_rls_allowed(company_id))
     ```
   - `app_rls_allowed(row_company_id)` checks `current_setting('app.current_company_id', true)::BIGINT`. When unset (`NULL`), queries return zero tenant rows (fail-closed default).

---

## 4. Critical Domain & Accounting Invariants

1. **Double-Entry Balance & Single-Side Split:**
   - `ck_journal_line_single_side`: `NOT (debit > 0 AND credit > 0)`
   - `ck_journal_line_nonzero`: `debit > 0 OR credit > 0`
   - Deferred `COMMIT`-time constraint trigger validates zero net imbalance and blocks posting into `fiscal_periods.status = 'closed'`.
2. **Posted Ledger Immutability & Reversal Traceability:**
   - `trg_prevent_posted_txn_mutation` and `trg_prevent_posted_line_mutation` prohibit `DELETE` or amount/account/date edits after `is_posted = TRUE`. Corrections require creating a reversing entry linked via `reverses_transaction_id` / `reversed_by_transaction_id`.
3. **Append-Only Audit Trail:**
   - `trg_audit_log_append_only` rejects any `UPDATE` or `DELETE` on `audit_log`.
4. **4-Type Inventory & BOM Rules:**
   - `ck_items_non_stocked_types`: `printed_product` and `printing_service` must always hold `on_hand = 0`.
   - `ck_items_raw_material_not_for_sale`: `raw_material` must hold `sales_price = 0`.
   - `trg_invoice_lines_no_raw_material`: rejects placing any `raw_material` on `invoice_lines`.
   - `trg_item_variants_type_check`: allows variants strictly on `stationery` and `printed_product` (with `on_hand = 0` on printed product variants).
   - `trg_item_bom_raw_check`: ensures BOM components reference only `raw_material` items.
5. **Per-Learner Class Billing & Contract Milestones:**
   - `exam_assessment_batches` stores `learners_count * price_per_learner` as `class_revenue` (`GENERATED ALWAYS AS ... STORED`), while `exam_papers` stores per-subject `paper_cost + toner_cost` so consolidated invoicing produces 1 revenue line per class with total subject material costs.
   - `printing_contracts` enforces `total_assessments BETWEEN 2 AND 5`, `remaining_balance <= total_prepaid_amount`, and dated `contract_assessment_milestones` (`scheduled_date NOT NULL`) tracking `profit = agreed_amount - (paper_cost + toner_cost)`.

---

## 5. Migration Versioning, Rollback & Recovery Procedures

### Version Control Structure
- Migrations live sequentially in `/db/migrations/` as immutable pairs: `NNNN_<slug>.up.sql` and `NNNN_<slug>.down.sql`.
- Executed migrations are recorded in `schema_migrations (version, name, checksum_sha256, applied_at, execution_ms)`.
- `db/migrator.ts` refuses to proceed if an applied migration file on disk has a modified SHA-256 checksum (`Checksum mismatch`).

### Atomic Transaction Execution
Every `.up.sql` and `.down.sql` executes inside an explicit `BEGIN ... COMMIT` block. Any DDL error triggers immediate `ROLLBACK`, leaving `schema_migrations` and the database schema untouched.

### Rollback & Disaster Recovery Runbook
1. **Immediate Step Rollback (Pre-Release / Staging):**
   - Run `migrateDown(db, { steps: 1 })` or `migrateDown(db, { targetVersion: '0005' })` to execute the paired `.down.sql` scripts inside transactions and delete matching rows from `schema_migrations`.
2. **Production Post-Deployment Failure:**
   - **Never edit an already-applied `.up.sql` file.**
   - Take a consistent `pg_dump --format=custom` snapshot before running any rollbacks if data was written after migration.
   - If rolling back a schema migration would drop populated columns/tables, first export affected rows (`COPY ... TO STDOUT`) or author a forward corrective migration (`0008_...up.sql`) to migrate data safely without loss.
3. **Zero-Telemetry Vault Compatibility:**
   - `migrateUp(db)` creates all tables idempotently from an empty database with zero reliance on application startup bootstrapping.
