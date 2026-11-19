# 03 — Phase 0 Closeout Report

**Project:** Prime ERP — Printing Contracts Remediation
**Date:** 2026-11-19
**Branch:** `fix/printing-contracts-99`
**Base commit:** `933bcf32b9e570f97ef9d2f864274fd64c6d6e08`
**Phase 0 status:** **NOT APPROVED — BLOCKED**
**Implementation authorised:** **NO**

---

## 1. Executive Summary

Phase 0 verification and documentation is complete. The repository was inspected end-to-end, the baseline commands were executed and recorded, the proposed migration 0020 was reviewed, and the idempotency transaction-flow was specified.

However, **Phase 0 cannot be marked APPROVED** because the twelve business decisions D-01…D-12 remain BLOCKED, and the migration design has five high-severity defects that must be corrected before 0020 is written.

No production code, schema, migration, or test was changed. The only changes are documentation files and test-generated report artifacts.

---

## 2. Activity Status

| Activity | Status | Evidence |
|---|---|---|
| Repository inspection complete | **COMPLETE** | `00-repository-verification.md` (47 findings verified, 18 new findings) |
| Working tree preserved | **COMPLETE** | `00-repository-state.txt`; branch `fix/printing-contracts-99` created; 137 entries preserved |
| Baseline execution complete | **COMPLETE** | `01-baseline.txt`; logs in `logs/` |
| Migration design verified | **COMPLETE — DEFECTS FOUND** | `04-migration-design-verification.md` |
| Idempotency design specified | **COMPLETE** | `05-idempotency-design.md` |
| Business decisions approved | **NOT COMPLETE — BLOCKED** | `02-business-decisions.md`; all D-01…D-12 BLOCKED |
| Implementation authorised | **NO** | No Phase A/D work started |

---

## 3. Baseline Results

| Command | Exit code | Result |
|---|---:|---|
| `npm run lint` | 0 | PASS — `tsc --noEmit`, no diagnostics |
| `npm run test:printing` | 1 | 17/18 passed; 1 pre-existing SKU collision |
| `npm run test:documents` | 0 | PASS — 7/7 |
| `npm run test:workflows` | 0 | PASS — 7/7 |
| `npm run test:db` | 0 | PASS — 8/8 |
| `npm run build` | 0 | PASS — 1754 modules; non-blocking chunk-size warning |

**Pre-existing failure classification:**

- Test: `Integration :: 17. PostgreSQL lookup + single BOM deduction & single GL posting on invoice creation`
- Error: `duplicate key value violates unique constraint "uq_inventory_items_company_sku_lower"`
- Cause: the demo seed creates SKU `RM-TONER-K` (`src/server/db.ts:300`); the test inserts the same SKU (`tests/printing/paper-toner-calc.test.ts:961`).
- Classification: **pre-existing test-data collision, unrelated to printing contracts**.
- Action: no production code changed. A separate test-hardening ticket should use a unique test-only SKU.

Full output: `logs/01-lint.log` … `logs/06-build.log`.

---

## 4. Git State

| Item | Value |
|---|---|
| Branch before | `main` |
| Branch after | `fix/printing-contracts-99` |
| Base commit | `933bcf32b9e570f97ef9d2f864274fd64c6d6e08` |
| Commit subject | Implement full advanced options for Invoices and Printing Contracts |
| Working-tree entries before | 137 |
| Working-tree entries after | 137 |
| Untracked docs | `docs/printing-contracts-remediation/`, `PRINTING_CONTRACT_MODULE_AUDIT_REPORT.md`, `PRINTING_CONTRACT_MODULE_REMEDIATION_PLAN.md` |
| Untracked code (pre-existing) | `src/components/modals/ContractActionModals.tsx`, `PosModal.tsx`, `SmartOperationsView.tsx`, `smart-ops/`, `smartOpsRoutes.ts`, `posService.ts`, `smartOpsService.ts`, `smartOpsApi.ts`, `tests/smart-ops/` |
| Modified code (pre-existing) | `src/server/services/printingRecordsService.ts`, `AccountingContext.tsx`, `PrintingContractsView.tsx`, `printingRoutes.ts`, `printingApi.ts`, `types/accounting.ts`, etc. |

**No user changes were discarded, reset, stashed, overwritten, or committed.** The branch was created from the same commit with the working tree carried forward.

**Test side effects (not source changes):**
- `docs/database/test-execution-report.md` rewritten by `test:db`.
- `docs/workflows/phase9-dependency-and-test-report.md` rewritten by `test:workflows`.
- `dist/` created by `npm run build`; it is git-ignored (`.gitignore:3`).

---

## 5. Files Created by Phase 0

| File | Purpose |
|---|---|
| `docs/printing-contracts-remediation/00-repository-verification.md` | Full repository verification (47 findings + 18 new) |
| `docs/printing-contracts-remediation/00-repository-state.txt` | Git branch/commit/status snapshot |
| `docs/printing-contracts-remediation/01-baseline.txt` | Baseline command results and exit codes |
| `docs/printing-contracts-remediation/02-business-decisions.md` | D-01…D-12 register (all BLOCKED) |
| `docs/printing-contracts-remediation/03-phase-0-closeout.md` | This report |
| `docs/printing-contracts-remediation/04-migration-design-verification.md` | Migration 0020 review and defects |
| `docs/printing-contracts-remediation/05-idempotency-design.md` | Idempotency transaction-flow specification |
| `docs/printing-contracts-remediation/logs/01-lint.log` | Lint output |
| `docs/printing-contracts-remediation/logs/02-test-printing.log` | Printing test output |
| `docs/printing-contracts-remediation/logs/03-test-documents.log` | Documents test output |
| `docs/printing-contracts-remediation/logs/04-test-workflows.log` | Workflow test output |
| `docs/printing-contracts-remediation/logs/05-test-db.log` | DB migration test output |
| `docs/printing-contracts-remediation/logs/06-build.log` | Build output |

---

## 6. Migration Design Findings

The proposed migration 0020 is directionally correct but **not ready to write**. The full review is in `04-migration-design-verification.md`.

### 6.1 High-severity defects

| ID | Defect | Required correction |
|---|---|---|
| **MIG-01** | Draft changes contract numbers from 2-digit to 4-digit and exam numbers from 4-digit to 5-digit, breaking the existing format | Preserve existing widths (2 contracts, 4 exams); fail safely on overflow; treat any format change as a separate approved migration |
| **MIG-02** | Allocation trigger alone can deadlock; service must lock the parent contract before child writes | Mandate parent-first locking in every milestone mutation; add deadlock tests |
| **MIG-04** | Trigger does not maintain `total_assessments` / `completed_assessments`; direct SQL can violate the count CHECK | Add count-maintenance triggers or prohibit direct DML; add reconciliation |
| **MIG-09** | Exam-paper number backfill is missing | Add `EXM-YYYY-NNNN` counter backfill and replace `MAX(job_number)` |
| **MIG-15** | Legacy allocation mismatches and credit balances are not addressed | Phase D preflight + D-12 sign-off before strict constraints |

### 6.2 Medium/low defects

- MIG-03: trigger misses `contract_id`/`company_id` updates.
- MIG-05: pending idempotency state is a convention, not schema.
- MIG-06: `currency_code` depends on service changes.
- MIG-07: settlement columns lack consistency CHECKs.
- MIG-08: cancellation metadata consistency.
- MIG-10: `version` column unused.
- MIG-11: number function needs company guard and safe error mapping.
- MIG-12: `40001` serialization failures not handled.
- MIG-13: missing `remaining_balance` vs completed-assessment invariant.
- MIG-14: PGlite constraint-trigger compatibility not yet proven.
- MIG-16/17/18: minor type/constraint/guard items.

### 6.3 Verified-correct items

- Composite FKs reference valid unique keys.
- RLS + FORCE pattern for the new counter table.
- Atomic `ON CONFLICT DO UPDATE ... RETURNING` counter.
- Backfill from number strings, not `start_date`.
- Parent-total trigger present.
- Roll-forward recovery strategy.

---

## 7. Idempotency Design Summary

The specification is in `05-idempotency-design.md`.

**Chosen design:** same-transaction claim.

- The request-key claim, financial mutation, journal, bank row, audit, and stored response are written in **one transaction**.
- A committed transaction stores the response; a retry replays it.
- A rolled-back transaction leaves no claim; a retry starts fresh.
- A concurrent same-key request blocks on the unique index, then replays or starts fresh.
- There is **no timeout-based takeover**. A timeout only returns `409 IDEMPOTENCY_IN_PROGRESS`.
- A financial operation is posted at most once per `(company_id, route, idempotency_key)`.

**Covered routes:** create, renew, top-up, cancel (refund/forfeit), complete, invoice generation, exam batch, add assessment.

**Required code changes (Phase A):** canonical JSON hash helper, claim/complete helpers, route/API key propagation, error mapping, frontend stable keys, test matrix.

---

## 8. Business Decision Matrix

| ID | Decision | Status | Final decision | Date |
|---|---|---|---|---|
| D-01 | Deployment currency | **BLOCKED** | PENDING | — |
| D-02 | Refund policy | **BLOCKED** | PENDING | — |
| D-03 | Forfeiture income account | **BLOCKED** | PENDING | — |
| D-04 | Top-up / unallocated credit | **BLOCKED** | PENDING | — |
| D-05 | All complete with positive balance | **BLOCKED** | PENDING | — |
| D-06 | Colour printing | **BLOCKED** | PENDING | — |
| D-07 | Contract management roles | **BLOCKED** | PENDING | — |
| D-08 | Timezone source | **BLOCKED** | PENDING | — |
| D-09 | Reactivation after settlement | **BLOCKED** | PENDING | — |
| D-10 | Exact allocation at creation | **BLOCKED** | PENDING | — |
| D-11 | Number width/format | **BLOCKED** | PENDING | — |
| D-12 | Legacy data remediation | **BLOCKED** | PENDING | — |

No business owner approval has been recorded. **All decisions remain BLOCKED.**

---

## 9. Outstanding Blockers

1. **Business decisions D-01…D-12 are unapproved.** Phase A cannot start.
2. **Migration design defects MIG-01, MIG-02, MIG-04, MIG-09, MIG-15 are unresolved.** Migration 0020 must not be written until they are corrected.
3. **Medium/low migration defects** (MIG-03, MIG-05, MIG-07, MIG-08, MIG-11, MIG-12, MIG-13, MIG-14) need disposition.
4. **Legacy data preflight has not been run.** D-12 depends on it.
5. **The pre-existing `test:printing` SKU collision** is documented but not fixed. It is out of scope for this remediation; a separate test-hardening ticket is required if desired.
6. **No `tests/printing/contracts.test.ts` or `test:printing-contracts` script exists.** This is a Phase E deliverable, not a Phase 0 blocker, but it must be planned.
7. **The working tree contains extensive pre-existing user changes.** Any implementation must avoid committing unrelated changes.

---

## 10. Explicit Statement

**No production code, schema, migration, or test file was changed by this Phase 0 work.**

Specifically:

- No `.sql` migration was created or applied.
- No `src/` or `tests/` file was edited.
- No `package.json` script was changed.
- No user modification was discarded, reset, stashed, overwritten, or committed.
- The only new files are documentation and test logs under `docs/printing-contracts-remediation/`.
- The only working-tree changes caused by the baseline runs are test-generated report artifacts and the git-ignored `dist/` build output.

---

## 11. Phase 0 Decision

| Question | Answer |
|---|---|
| Repository inspection complete? | **YES** |
| Baseline execution complete? | **YES** (one pre-existing, non-contract failure documented) |
| Migration design verified? | **YES** (defects documented; not resolved) |
| Idempotency behaviour specified? | **YES** |
| Business decisions approved? | **NO** — D-01…D-12 BLOCKED |
| Implementation authorised? | **NO** |

**Phase 0 status: NOT APPROVED — BLOCKED.**

Phase A must not begin until:

1. D-01…D-12 are approved and signed.
2. MIG-01, MIG-02, MIG-04, MIG-09, MIG-15 are resolved.
3. The migration 0020 design is re-reviewed and accepted.
4. The idempotency design is accepted.
5. The legacy-data preflight is run.

---

## 12. Sign-Off

| Role | Name | Decision | Signature | Date |
|---|---|---|---|---|
| Finance Manager | ________________ | ☐ Approved ☐ Rejected | ________________ | __________ |
| Managing Director | ________________ | ☐ Approved ☐ Rejected | ________________ | __________ |
| Operations Manager | ________________ | ☐ Approved ☐ Rejected | ________________ | __________ |
| Product Owner | ________________ | ☐ Approved ☐ Rejected | ________________ | __________ |

**Phase 0 is complete as a verification exercise, but not approved for implementation.**