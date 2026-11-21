# Examination Printing Module — Production Readiness Report

**Date:** 2026-11-21
**Branch:** `fix/printing-contracts-99`
**Scope:** PRIME ERP Examination Printing Module (server, database, API, UI, tests)
**Method:** Repository-first verification, additive migration, service/route/UI implementation, focused tests, regression comparison.

> This is an implementation report, not an audit-only document. It records what was
> changed, what was verified, what remains open, and why full 99.8% certification is
> **not** claimed.

---

## 1. Architecture Verification (Phase 0)

### 1.1 Authoritative chain

```
ExaminationView / AdvancedActionsMenu
        │  (no local stock, COGS, invoice or status simulation for server records)
        ▼
src/services/printingApi.ts  →  /api/printing/*
        ▼
src/server/routes/printingRoutes.ts   (auth + exam permission + error mapping)
        ▼
src/server/services/printingRecordsService.ts  (domain authority)
        ├── productionService.ts   (jobs, reservations, issuance, consumption, QC, delivery, WIP)
        ├── documentsService.ts    (invoice creation + exam invoice linking)
        ├── accountingEngine.ts    (balanced journals, idempotent posting)
        └── customerWalletService.ts (contract funding; not used directly by exams)
        ▼
PostgreSQL (RLS + company-scoped composite FKs + append-only events)
```

### 1.2 Verified source-of-truth behaviour

| Control | Current behaviour | Evidence |
|---|---|---|
| Batch/paper creation | Server generates ids, job numbers, production jobs and costs | `createExamBatch` in `printingRecordsService.ts` |
| Multi-class submission | One batch header per class; no collapse into the first class | lifecycle + integrity tests |
| Paper specification | `paper_size`, `printing_item_id`, `machine_id`, side, binding persisted per paper | migration 0024, `createExamBatch` |
| Material movements | Only through `reserveJobMaterials` / `issueJobMaterials` / consumption / returns | `productionService.ts` |
| WIP and COGS | WIP on issuance; one WIP→COGS relief on invoicing | `linkExamPapersToInvoice` |
| Invoice linkage | `exam_paper_invoice_links` unique per `(company_id, paper_id)` | migration 0024, integrity test |
| Audit history | `exam_paper_events`, append-only trigger, immutable | migration 0024, lifecycle test |
| Tenant isolation | RLS on exam tables + company-scoped FKs | migrations 0007/0024, `rejectCrossCompanyParams` |
| Idempotency | `request_keys` claim in the same transaction for batch create, reprint, invoice, COGS | `claimPrintingIdempotency`, tests |

### 1.3 Data safety

- Migration strategy is additive (`0024`, `0026`).
- No existing business rows are deleted, reset or truncated.
- Legacy rows are flagged `cost_status = 'legacy_unverified'`; no historical cost is fabricated.
- `0026` is reversible; the migration suite applies `0001 → 0026` and rolls back `26 → 0` cleanly.

---

## 2. Findings Matrix (reconstructed register)

The original audit was not stored in the repository, so the register below is reconstructed
from the audit themes named in the assignment and re-verified against the current code.
IDs are stable for this report; they are not claimed to be the original audit's numbering.

| ID | Finding | Status | Evidence / correction | Verification |
|---|---|---|---|---|
| P0-01 | Local-only examination success | **Fixed** (server records) | `addExamPapersBatch` creates through `printingApi.createExamBatch`; local path only for non-numeric demo ids | `exam-production-integrity.test.ts` |
| P0-02 | Multi-class submission collapses to first class | **Fixed** | `normalizeExamClasses` + one batch per class | integrity test (`batches.length === 2`) |
| P0-03 | Paper size / printing service not persisted | **Fixed** | `exam_papers.paper_size`, `printing_item_id`; A3 preserved | integrity test |
| P0-04 | Client-submitted costs trusted | **Fixed** for creation | server creates production job and stores computed `paper_cost`/`toner_cost`; `cost_status` marks unavailable estimates | integrity test |
| P0-05 | Duplicate COGS (completion + invoicing) | **Fixed** | only `linkExamPapersToInvoice` posts WIP→COGS; invoice `total_cost` replaced with exact relief | integrity test asserts equality |
| P0-06 | Invoice relationship untraceable | **Fixed** | `exam_paper_invoice_links` with one row per paper | integrity test, reconciliation check |
| P0-07 | Unrestricted paper status changes | **Fixed** | `EXAM_STATUS_ALLOWED` + route-level permission per target state | lifecycle test |
| P0-08 | Duplicate submission creates duplicate batches | **Fixed** | `request_keys` claim and replay | integrity test replay |
| P0-09 | Cross-company examination access | **Fixed** (existing infrastructure) | company-scoped FKs + RLS + `rejectCrossCompanyParams` | `test:security`, migration suite |
| P0-10 | No production event history | **Fixed** | append-only `exam_paper_events` + immutability trigger | lifecycle test (update rejected) |
| P0-11 | Browser simulates stock/COGS | **Fixed** for backend papers | `updateExamPaperStatus` refuses simulation for `backendId` records | context code + integrity test |
| P1-01 | QC hold / pack / dispatch missing | **Fixed in this pass** | new transitions `qc_hold`, `qc_passed`, `packed`, `dispatched`; timestamps, packages, seals, spoiled copies | lifecycle test |
| P1-02 | No controlled cancellation | **Fixed in this pass** | `cancelExamPaper` releases reservations, returns material, writes off WIP; blocks dispatched/delivered/invoiced | lifecycle test |
| P1-03 | No reprint relationship | **Fixed in this pass** | `createExamReprint` creates a new linked paper/job, parent preserved; partial unique index permits reprint | lifecycle test + idempotency |
| P1-04 | Contract/assessment link not validated | **Fixed** | `assertExamContract` validates school, range, pending state | `test:printing-contracts` |
| P1-05 | No examination-specific permissions | **Fixed (metadata/routes/UI); partial** | 12 `exams:*` permissions, per-transition checks, UI gates | permission test |
| P1-06 | Frontend swallows exam errors | **Partial** | actions now surface errors; background refresh still intentionally keeps demo data when unreachable | code review |
| P1-07 | Invoice eligibility only in UI | **Fixed** | server requires `status = 'delivered'` before linking; rollback on failure | integrity test (`EXAM_PAPER_NOT_DELIVERED`) |
| P1-08 | Estimated vs actual cost variance | **Partial** | `cost_status`, `cost_warnings`, actual QC spoilage recorded; no dedicated variance report | schema/code review |
| P1-09 | No prepress approval / proof freeze | **Partial** | `spec_frozen`, `spec_version`, SHA-256 `spec_hash`, approval identity/time; no artwork upload/versioning | lifecycle test |
| P1-10 | No partial/over-delivery controls | **Partial** | short delivery now dispatches QC-approved good copies only; no explicit over-delivery endpoint | lifecycle test (38/40 delivered) |
| P1-11 | No performance evidence | **Open** | not measured | — |
| P2-01 | Exam lists unpaginated | **Partial** | batch register filters by status/school; paper list still returns all | code review |
| P2-02 | No batch register | **Partial** | `GET /printing/exam-batches` + register API; UI remains paper/class-centric | lifecycle test |
| P2-03 | No production timeline | **Fixed in this pass** | `GET /printing/exam-papers/:id/events` + timeline modal | lifecycle test |
| P2-04 | No reconciliation report | **Fixed in this pass** | `GET /printing/exam-reconciliation` + UI modal | lifecycle test |
| P2-05 | Hardcoded currency | **Fixed** | UI uses company currency; server uses NUMERIC only | code review |
| P2-06 | Legacy migration/reconciliation | **Partial** | legacy rows preserved and flagged; no one-off legacy report executed | migration 0024 backfill |

---

## 3. Changes Delivered in This Pass

### 3.1 Database

**Migration `0026_examination_lifecycle_completion`** (renamed from an initial 0025 because
`0025_customer_master_governance` already exists):

- `exam_papers`: `packed_at`, `dispatched_at`, `reprint_reason`, `qc_notes`,
  `package_count`, `seal_reference`.
- Original-paper uniqueness restored as a partial unique index
  `uq_exam_papers_batch_subject_original ... WHERE reprint_of_paper_id IS NULL`,
  so a reprint can live in the same batch without replacing its parent.
- `exam_assessment_batches`: `spec_version`, `spec_hash`, `spec_approved_at`,
  `spec_approved_by`, `spec_frozen`.
- Reversible down migration.

### 3.2 Backend

`src/server/services/printingRecordsService.ts`

- Extended `updateExamPaperStatus` to the controlled lifecycle with reason and
  quantity validation, QC inspection records, packing/dispatch checkpoints and
  append-only events.
- `cancelExamPaper` — controlled cancellation with inventory release.
- `createExamReprint` — idempotent, parent-linked reprint.
- `listExamPaperEvents` — append-only timeline.
- `listExamBatches` — batch register with aggregated counts and totals.
- `approveExamBatchSpecification` — hash-addressed, idempotent freeze.
- `getExaminationReconciliation` — nine authoritative checks.
- Delivery now dispatches QC-approved good copies and records short delivery.

`src/server/routes/printingRoutes.ts`

- Exam routes now require `exams:*` permissions.
- Status transitions resolve a distinct duty per target state.
- New endpoints: batch register, timeline, cancel, reprint, spec approval, reconciliation.

### 3.3 Frontend

- `printingApi` exposes the new endpoints.
- `AccountingContext` exposes cancellation, reprint, timeline, spec approval and
  reconciliation; status changes refresh from the server.
- `ExaminationView` gains QC hold/pass, rework, packing, dispatch, cancellation and
  reprint actions, a production timeline/audit modal, a reconciliation modal, and
  exam-specific permission gates.

---

## 4. State-Transition Matrix

| From | To | Permission | Required validation | Inventory | Financial | Audit |
|---|---|---|---|---|---|---|
| queued | printing | `exams:produce` | job exists, budget approved | reserve → issue (atomic) | WIP debit / inventory credit | event + audit |
| printing | completed | `exams:qc` | production started | none | none at completion | QC inspection + event |
| printing | qc_passed | `exams:qc` | production started, good+spoiled ≤ copies | none | none | QC inspection + event |
| printing | qc_hold | `exams:qc` | reason required | none | none | QC rejection + event |
| qc_hold | printing | `exams:produce` | reason required, materials already issued | none (no double issue) | none | event |
| qc_hold | qc_passed | `exams:qc` | production started | none | none | event |
| qc_passed / completed | packed | `exams:dispatch` | non-negative package count | none | none | event + timestamp |
| packed / completed | dispatched | `exams:dispatch` | packed or completed | none | none | event + timestamp |
| completed / qc_passed / packed / dispatched | delivered | `exams:deliver` | linked job, QC-approved quantity | delivery note | none | event + delivery note |
| delivered | invoiced | `exams:invoice` | delivered, not already linked | none | AR/revenue + WIP→COGS once | event + invoice link |
| any pre-dispatch | cancelled | `exams:cancel` | reason required | release reservations, return unused | residual WIP → 5100 | event + audit |
| delivered / invoiced / dispatched | cancelled | — | blocked | — | use credit note / reversal | — |

Terminal states: `invoiced`, `cancelled`. Database transition checks remain defence-in-depth;
the service matrix is the authoritative rule.

---

## 5. Financial Posting Matrix (as implemented)

| Event | Debit | Credit | Posting point | Notes |
|---|---|---|---|---|
| Batch/paper creation | — | — | `createExamBatch` | No GL; production job created |
| Material reservation | — | — | `reserveJobMaterials` | No GL |
| Material issuance | 1250 WIP | Raw-material inventory asset accounts | `issueJobMaterials` | One journal per issuance, idempotent |
| Conversion / press operation | 1250 WIP | Applied labour / machine accounts | `recordProductionOperation` | Only configured costs |
| Finishing | 1250 WIP | Consumables / labour | `recordFinishingOperation` | — |
| Production completion / QC | — | — | `updateExamPaperStatus` | No GL; WIP stays on balance sheet |
| Delivery | — | — | `deliverExamPaper` | No GL |
| Invoice issuance | Accounts receivable | Revenue | `documentsService` sales path | Tax per company policy |
| COGS recognition | 5000 COGS | 1250 WIP | `linkExamPapersToInvoice` | Exactly once per paper; `exam-cogs-{company}-{invoice}` |
| Customer payment | Bank / cash | Accounts receivable | existing sales/payment services | Not duplicated by exams |
| Material return | Raw-material inventory | 1250 WIP | `returnUnusedMaterials` | Quantity must be unissued/issued-unconsumed |
| Spoilage / cancellation residual | 5100 Spoilage & Production Variance | 1250 WIP | `cancelPrintingJob` | Only remaining non-recoverable WIP |
| Reprint | Normal production journals | Normal production journals | `createExamReprint` → job pipeline | Additional traceable cost; no revenue change |
| Contract retainer (if used) | Bank | Contract liability | `printing_contracts` service | Exam module never deducts wallet/contract directly |

**Duplicate-posting controls:** `request_keys` idempotency, unique
`(company_id, paper_id)` invoice link, locked rows (`FOR UPDATE`), and
`wip_cost_relieved = wip_cost_accumulated` after relief.

**Unresolved Finance decisions:** revenue recognition for short delivery/reprint
write-offs, and the approved account for estimated toner shrinkage. The module
does not invent these; it records estimate status and warnings.

---

## 6. Inventory Movement Specification

1. **Reserve** — requirement rows and `inventory_items.reserved_qty`; no GL.
2. **Issue** — decrement `on_hand`, release reservation, increment issued usage; WIP journal.
3. **Consume** — actual good/waste usage; prevents negative remaining issuance; no duplicate consumption for the same operation.
4. **Return** — unissued or unconsumed quantities; inventory debit / WIP credit.
5. **Spoilage** — recorded as waste usage; QC spoiled copies recorded on the paper.
6. **Cancel** — releases reservations; optionally returns unused material; residual WIP to 5100.
7. **Reprint** — a new job with its own reservation/issuance/cost; the parent is untouched.
8. **Reconciliation** — reservation vs issue, issued vs consumed+returned, negative stock, over-consumption.

---

## 7. Permission and Segregation-of-Duties Matrix

| Permission | Administrator | ProductionManager | Bookkeeper | Accountant | Read-Only |
|---|---|---|---|---|---|
| `exams:view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `exams:view_confidential` | ✓ | ✓ | — | ✓ | — |
| `exams:create` | ✓ | ✓ | ✓ | — | — |
| `exams:edit` | ✓ | ✓ | ✓ | — | — |
| `exams:approve` | ✓ | ✓ | — | — | — |
| `exams:produce` | ✓ | ✓ | — | — | — |
| `exams:qc` | ✓ | ✓ | — | — | — |
| `exams:dispatch` | ✓ | ✓ | — | — | — |
| `exams:deliver` | ✓ | ✓ | — | — | — |
| `exams:invoice` | ✓ | — | ✓ | ✓ | — |
| `exams:cancel` | ✓ | — | — | ✓ | — |
| `exams:manage_permissions` | ✓ | — | — | — | — |

Segregation achieved: production staff cannot invoice; billing staff cannot produce or
perform QC; cancellation is restricted to administration/finance.

**Security limitation:** `exams:view_confidential` is defined and assigned, but no
examination-content endpoint exists yet to enforce it, and artwork encryption /
signed URLs / watermarking are **not implemented**. This is a blocking gap for the
confidentiality zero-tolerance gate.

---

## 8. Reconciliation Report

`GET /api/printing/exam-reconciliation` returns these checks over authoritative records:

1. Invoiced papers without a delivery timestamp (critical).
2. Delivered papers with no invoice link (informational).
3. Papers linked to more than one invoice (critical).
4. Material requirements consuming more than issued (critical).
5. Raw-material items with negative on-hand or reserved quantity (critical).
6. Examination WIP relieved above accumulated (critical), with both figures.
7. Batch cost totals not equal to their paper costs (attention).
8. Papers with unavailable / legacy-unverified cost (attention).
9. Frozen-specification coverage against batch count (attention).

The lifecycle test asserts `criticalCount === 0` after create → QC → pack → dispatch →
deliver → cancel → reprint.

---

## 9. Test Evidence

All commands below were run against the current working tree on 2026-11-21.

| Suite | Command | Result |
|---|---|---|
| TypeScript | `npm run lint` | **Pass** (0 errors) |
| Examination integrity | `npm run test:exam-integrity` | **1/1 pass** |
| Examination lifecycle + permissions (new) | `npx tsx tests/printing/exam-lifecycle.test.ts` | **2/2 pass** |
| Printing contracts | `npm run test:printing-contracts` | **12/12 pass** |
| Contract amendments | `npm run test:amendments` | **1/1 pass** |
| Customer wallet | `npm run test:wallet` | **1/1 pass** |
| Database migrations | `npm run test:db` | **4/8 pass**; migrations `0001→0026` and full `26→0` rollback pass. Failures 4, 5, 6, 8 are caused by the concurrently added `customers.customer_code NOT NULL` rule (`0025_customer_master_governance`), not by examination changes. |
| Documents / invoicing | `npm run test:documents` | **1/7 pass** — setup fails with 409 and the workflow invoice path returns `could not determine data type of parameter $4`. Pre-existing in the uncommitted working tree; outside the examination files changed here. |
| E2E workflows | `npm run test:workflows` | **1/7 pass** — `approval_policies_action_type_check`, sales `$4` type error, missing audit action. Unrelated to examination changes. |
| Printing engine | `npm run test:printing` | **17/18 pass** — one integration fixture hits a duplicate inventory SKU. |

### New tests added

`tests/printing/exam-lifecycle.test.ts` covers:

- hash-addressed, idempotent specification freeze;
- batch register aggregation;
- transition rejection, QC reason enforcement, QC quantities;
- packing, dispatch, short delivery of good copies;
- cancellation blocked after dispatch/delivery; cancellation of queued paper;
- reprint parent linkage, version increment, append-only parent, idempotent replay;
- append-only event trigger rejects updates;
- reconciliation with zero critical findings;
- role/permission separation.

---

## 10. Pre-existing Failures and Limitations

These were **not introduced by this change** and are reported rather than hidden:

1. `tests/db/migration-suite.ts` fixtures insert customers without `customer_code`,
   which is now `NOT NULL` after the concurrent `0025_customer_master_governance`
   migration.
2. `tests/documents` setup returns 409 and invoice workflow returns a PostgreSQL
   parameter-type error in `documentsService` (uncommitted prior work).
3. `tests/workflows` fails on `approval_policies_action_type_check`, a sales `$4`
   parameter-type error, and a missing audit action.
4. `tests/printing` integration fixture hits a duplicate inventory SKU when run after
   the other suites.

No test was skipped, weakened or deleted to obtain these results.

---

## 11. Outstanding Risks / Required Decisions

| ID | Risk | Required action | Owner |
|---|---|---|---|
| R-01 | No confidential-content access control, encryption, signed URLs, watermarking | Implement artwork/version storage with `exams:view_confidential`, encryption at rest and expiring URLs | Security + Product |
| R-02 | No browser/E2E evidence for the full workflow | Run Playwright/UAT with refresh, retry and concurrency scenarios | QA |
| R-03 | No measured performance | Measure batch creation, status latency, invoice latency and reconciliation on realistic data | Engineering |
| R-04 | No legacy migration report / quarantine counts | Execute preflight on a production copy; publish exceptions | Data + Finance |
| R-05 | Cost variance / actual toner consumption report absent | Define approved variance policy, then implement | Finance |
| R-06 | Partial/over-delivery policy not formally approved | Confirm whether over-delivery is permitted; add explicit guard | Operations |
| R-07 | Exam lists lack pagination | Add cursor/offset pagination for papers and events at scale | Engineering |
| R-08 | Concurrent module regressions | Resolve the customer-code compatibility and documents/workflow failures before release | Platform |

---

## 12. Scorecard

| Category | Target | Result | Evidence |
|---|---:|---:|---|
| Financial integrity (no duplicate posting) | 100% | Met for exam paths | unique invoice link, single COGS relief test |
| Inventory transaction integrity | 100% | Met for exam paths | issuance/reservation/cancel tests |
| Tenant isolation and security gates | 100% | **Partial** | RLS/FKs pass; confidential-content control missing |
| Invoice traceability | 100% | Met for exam paths | `exam_paper_invoice_links` uniqueness |
| State-transition enforcement | 100% | Met | matrix + lifecycle tests |
| Idempotency of critical operations | 100% | Met for implemented operations | batch/reprint/invoice replays |
| Required automated test coverage | 100% | **Partial** | lifecycle covered; E2E/performance absent |
| Weighted production control maturity | ≥98% | Not established | no formal weighting performed |
| Measured critical workflow reliability | ≥99.8% | **Not measured** | no reliability population or window |

---

## 13. Final Certification

**Verdict: C — NOT PRODUCTION READY (for the 99.8% target).**

The critical examination controls implemented and tested here pass: server-authoritative
creation and costing, multi-class integrity, controlled lifecycle, cancellation, reprint,
append-only audit, invoice traceability, single COGS recognition, and tenant scoping.

Certification is blocked by:

1. Zero-tolerance gate 4 — no enforced confidential examination-content access,
   encryption, signed URLs or watermarking (`exams:view_confidential` exists but is unused).
2. Zero-tolerance gate 9 — a local demo-only creation path remains for non-backend ids.
3. Zero-tolerance gate 11 — open high-severity failures in the shared working tree
   (documents invoicing and workflow suites) that can affect examination invoicing.
4. Missing E2E/browser evidence, performance measurement and a legacy reconciliation report.

**Next gate:** complete R-01 (confidential content controls), clear R-08 (concurrent
module regressions), then run the E2E, performance and legacy-reconciliation evidence
required for a 99.8% claim.
