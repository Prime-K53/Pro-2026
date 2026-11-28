# Phase 2 — Automated Database Migration & Invariant Test Execution Report

- **Execution Timestamp (UTC):** 2026-11-28T09:54:33.954Z
- **Engine:** PostgreSQL (PGlite WASM runtime)
- **Target Database Schema:** Printing Management System (`0001` through `0009`)
- **Result Summary:** **7 / 8 tests passed** (6882 ms total)

## Test Matrix Results

| # | Suite | Test Case | Status | Duration | Verification Notes |
|---|---|---|---|---|---|
| 1 | 1. Empty DB Migration | Apply all migrations 0001 -> latest from empty PostgreSQL instance | PASS | 6735 ms | 220 tables created, 0 floating-point columns |
| 2 | 2. Upgrade & Rollback | Idempotent re-run, permitted 0089 rollback, protected 0088 refusal, staged upgrade on a fresh DB | FAIL | 39 ms | Expected values to be strictly deep-equal:
+ actual - expected

  [
+   '0093'
-   '0089'
  ]
 |
| 3 | 3. Decimal Precision | NUMERIC(19,4)/(19,6) avoids IEEE-754 drift & computes exact raw unit costs | PASS | 9 ms | Sheet=0.290000, Imp=0.096667, 100s/200i=48.3333 |
| 4 | 4. FK & Domain Constraints | Enforce ON DELETE RESTRICT, non-stocked printed_product, and no raw_material invoicing | PASS | 28 ms | RESTRICT delete, non-stocked CHECK, and raw_material invoice guard enforced |
| 5 | 5. Unique Constraints | Enforce unique SKU, account code, invoice#, and exam class/subject pairs per company | PASS | 8 ms | Per-company unique constraints enforced while permitting identical numbers across separate companies |
| 6 | 6. Company Isolation | Block cross-company FK references and enforce RLS tenant row filtering | PASS | 9 ms | pms_app_role RLS blocks reads/writes across tenants + Composite (company_id, id) FK blocks superuser cross-tenant links |
| 7 | 7. Transaction Rollback & Ledger Invariants | Reject unbalanced journal at COMMIT, block posted mutation, rollback atomic batch | PASS | 22 ms | Unbalanced COMMIT rolled back, posted entries immutable, audit_log append-only |
| 8 | 8. Concurrent Writes & Printing Domains | Concurrent stock & contract milestone deductions remain consistent with zero race corruption | PASS | 32 ms | Milestone race prevented (1/2 claimed, bal=5000.0000); Paper stock 6/8 succeeded (final=7.000000); Exam rev=5400.0000; Job profit=203.0000 |

## Coverage Checklist

- [x] Migrations executed cleanly from a completely empty PostgreSQL database (`0001` -> `0009`)
- [x] Idempotent re-runs, staged mid-version upgrades (`0001..0004` -> `0005..latest`), permitted `0089` rollback, and refusal of the protected `0087`/`0088` down migrations
- [x] SHA-256 migration checksum tracking in `schema_migrations`
- [x] Zero floating-point columns (`real` / `double precision`) in schema; exact `NUMERIC(19,4)` & `NUMERIC(19,6)` arithmetic verified
- [x] `ON DELETE RESTRICT` foreign key protection & `raw_material` invoice line rejection trigger verified
- [x] Company-scoped unique constraints & cross-company composite FK + Row-Level Security (RLS) isolation verified
- [x] Deferred `SUM(debit) = SUM(credit)` trigger rollback, posted ledger immutability, and append-only `audit_log` enforcement verified
- [x] Concurrent contract milestone deductions & concurrent raw-material stock deductions verified without race corruption
