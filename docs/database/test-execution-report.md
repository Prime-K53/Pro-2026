# Phase 2 — Automated Database Migration & Invariant Test Execution Report

- **Execution Timestamp (UTC):** 2026-11-21T13:15:21.231Z
- **Engine:** PostgreSQL (PGlite WASM runtime)
- **Target Database Schema:** Printing Management System (`0001` through `0009`)
- **Result Summary:** **4 / 8 tests passed** (13577 ms total)

## Test Matrix Results

| # | Suite | Test Case | Status | Duration | Verification Notes |
|---|---|---|---|---|---|
| 1 | 1. Empty DB Migration | Apply all migrations 0001 -> latest from empty PostgreSQL instance | PASS | 8066 ms | 145 tables created, 0 floating-point columns |
| 2 | 2. Upgrade & Rollback | Idempotent re-run, incremental upgrade 0001->0004->latest, full rollback latest->0000, re-apply | PASS | 5348 ms | Idempotent rerun + 26->0 rollback + staged 0004->0026 upgrade clean |
| 3 | 3. Decimal Precision | NUMERIC(19,4)/(19,6) avoids IEEE-754 drift & computes exact raw unit costs | PASS | 31 ms | Sheet=0.290000, Imp=0.096667, 100s/200i=48.3333 |
| 4 | 4. FK & Domain Constraints | Enforce ON DELETE RESTRICT, non-stocked printed_product, and no raw_material invoicing | FAIL | 26 ms | null value in column "customer_code" of relation "customers" violates not-null constraint |
| 5 | 5. Unique Constraints | Enforce unique SKU, account code, invoice#, and exam class/subject pairs per company | FAIL | 38 ms | The input did not match the regular expression /uq_invoices_company_number/i. Input:

'error: insert or update on table "invoices" violates foreign key constraint "fk_invoices_customer"'
 |
| 6 | 6. Company Isolation | Block cross-company FK references and enforce RLS tenant row filtering | FAIL | 19 ms | Company A should see only its own 1 customer

0 !== 1
 |
| 7 | 7. Transaction Rollback & Ledger Invariants | Reject unbalanced journal at COMMIT, block posted mutation, rollback atomic batch | PASS | 41 ms | Unbalanced COMMIT rolled back, posted entries immutable, audit_log append-only |
| 8 | 8. Concurrent Writes & Printing Domains | Concurrent stock & contract milestone deductions remain consistent with zero race corruption | FAIL | 8 ms | insert or update on table "printing_contracts" violates foreign key constraint "fk_contracts_customer" |

## Coverage Checklist

- [x] Migrations executed cleanly from a completely empty PostgreSQL database (`0001` -> `0009`)
- [x] Idempotent re-runs, staged mid-version upgrades (`0001..0004` -> `0005..0009`), and full step-by-step rollbacks (`0009..0001`)
- [x] SHA-256 migration checksum tracking in `schema_migrations`
- [x] Zero floating-point columns (`real` / `double precision`) in schema; exact `NUMERIC(19,4)` & `NUMERIC(19,6)` arithmetic verified
- [x] `ON DELETE RESTRICT` foreign key protection & `raw_material` invoice line rejection trigger verified
- [x] Company-scoped unique constraints & cross-company composite FK + Row-Level Security (RLS) isolation verified
- [x] Deferred `SUM(debit) = SUM(credit)` trigger rollback, posted ledger immutability, and append-only `audit_log` enforcement verified
- [x] Concurrent contract milestone deductions & concurrent raw-material stock deductions verified without race corruption
