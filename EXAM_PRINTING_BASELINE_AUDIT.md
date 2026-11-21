# EXAM_PRINTING_BASELINE_AUDIT.md

**Module:** PRIME ERP — Examination Printing
**Phase:** 0 — Repository-First Baseline Audit
**Date:** 21 November 2026
**Mode:** Read-only audit. No application code, schema, migrations or production data were modified during this phase.

> Every "Current status" below is based on the actual repository tree at commit `4d9eaf4` and is cited to `file:line`. Where a claim could not be confirmed from code it is marked **Unverified**. Suspected issues are labelled **(suspected)** and separated from confirmed defects.

---

## 0. Method

The repository was inspected across four dimensions using read-only exploration:

- Backend examination code (`printingRoutes.ts`, `printingRecordsService.ts`, `productionService.ts`, `documentsService.ts`, `paperCalc.ts`, `tonerCalc.ts`, `printingApi.ts`).
- Database schema (migrations `0001`–`0026`, RLS policies, composite FKs, constraints, append-only triggers).
- Frontend examination code (`ExaminationView.tsx`, `AccountingContext.tsx`, `printingApi.ts`).
- Security / permissions / tenant isolation (`auth.ts`, `permissions.ts`, `supabaseAuth.ts`, `db.ts`, `rateLimiter.ts`, `backupRoutes.ts`, `migrationRoutes.ts`).
- Test suites under `tests/`.

A prior implementation report exists at `docs/examination/EXAMINATION_MODULE_PRODUCTION_REPORT.md`. It is treated as a **claim to be verified**, not as evidence. Its self-declared status (Verdict C — NOT PRODUCTION READY) is consistent with this audit's findings.

Confirmed via direct grep:
- No occurrence of `teacher`, `billable`, or `free.?teacher` anywhere in `src/` or `db/` (0 matches).
- No occurrence of `artwork`, `confidential`, `signed_url`, `presigned` anywhere in `db/` (0 matches).
- `addExamPapersBatch` local-only branch confirmed at `src/context/AccountingContext.tsx:1942-1960`.

---

## 1. Requirement-to-Location Register

Status legend: **Implemented** = present and wired end-to-end · **Partial** = present but incomplete · **Missing** = not present · **Broken** = present but defective · **Unverified** = cannot be confirmed from code.

### 1.1 Examination batch & paper creation

| Field | Detail |
|---|---|
| Requirement | Create examination batch + papers via backend-authoritative path |
| Current status | **Partial** |
| Frontend location | `src/components/views/ExaminationView.tsx:451-490` (`handleSubmitExamBatch`) → `src/context/AccountingContext.tsx:1838-1961` (`addExamPapersBatch`) |
| Backend location | `printingApi.createExamBatch` (`src/services/printingApi.ts:209`) → `POST /printing/exam-batches` (`printingRoutes.ts:469`, `exams:create`) → `createExamBatch` (`printingRecordsService.ts:1335`) |
| Database location | `exam_assessment_batches` (`0007:205-232`, `0024:13-42`, `0026:29-42`); `exam_papers` (`0007:234-275`, `0024:45-152`, `0026:9-27`) |
| Existing service | `createPrintingJob`/`createExamProductionJob` (`productionService.ts:282`), `createPrintingNumberCounter` numbering |
| Test evidence | `tests/printing/exam-production-integrity.test.ts:152-216`; `tests/printing/exam-lifecycle.test.ts:121-137` |
| Gap | Local-only fabrication path at `AccountingContext.tsx:1942-1960` reachable by default (see §2, P0-01) |
| Risk | Operational / Financial |
| Recommended remediation | Phase 3 — remove local-only branch; make `createExamBatch` the sole path; surface errors |
| Acceptance test | Fresh-form submit with default demo ids must call server or hard-fail; no fabricated `exm-*` rows |

### 1.2 Server-authoritative costing

| Field | Detail |
|---|---|
| Requirement | Server is sole authority for paper/toner cost |
| Current status | **Implemented** |
| Backend location | `createExamBatch` ignores client cost fields (`printingRecordsService.ts:1135-1140`), writes back from production job (`:1551-1585`) |
| Database location | `exam_papers.sheets_used/impressions_used/paper_cost/toner_cost/material_cost` (`0007:247-251`), `cost_status` (`0024:67,91-94`) |
| Test evidence | `exam-production-integrity.test.ts:164-169`; `paper-toner-calc.test.ts` cases 17–18 |
| Gap | None for authoritative path; local path zeroes costs (`AccountingContext.tsx:1805-1807`) |
| Risk | Financial |
| Recommended remediation | Remove local path (P0-01) |
| Acceptance test | Client-posted costs never persisted on backend path |

### 1.3 Two free teacher copies (D3)

| Field | Detail |
|---|---|
| Requirement | `teacherCopies = 2` per paper; `plannedProductionQuantity = learners + 2`; `billableQuantity = acceptedLearnerQty`; never invoice teacher copies; never classify as wastage |
| Current status | **Missing** |
| Frontend location | `ExaminationView.tsx` — no teacher field; only `learnersCount`/`pricePerLearner`/`pages`/`copies` (`:53-61`, inputs `:1447-1509`) |
| Backend location | None — no `teacher`/`billable` symbol exists (grep = 0) |
| Database location | No columns; `exam_papers.copies` only (`0007:241`); batch `learners_count` (`0007:211`) |
| Existing service | n/a |
| Test evidence | None — `grep -i teacher tests/` = 0 |
| Gap | Entire D3 rule unimplemented. Billing currently `learnersCount × pricePerLearner` (`printingRecordsService.ts:1636`); invoicing quantity = `paper.copies` (`:4674`) |
| Risk | Financial / Inventory |
| Recommended remediation | Phase 4 — add teacher/learner/billable/planned columns + logic; no duplicate allowance |
| Acceptance test | UAT: 25 learners → 27 planned, 25 billable, 2 teacher, teacher invoice qty = 0 |

### 1.4 Short delivery & reprint loss treatment (D1)

| Field | Detail |
|---|---|
| Requirement | Recognise revenue only for delivered/accepted; never invoice undelivered; separate production-loss treatment; recoverable materials return to inventory; preserve ordered/produced/delivered/accepted/short/reprinted separately; authorised write-off reasons; prevent duplicate loss postings; link reprints to batch+reason |
| Current status | **Partial** |
| Backend location | Delivery dispatches QC-approved good copies (`printingRecordsService.ts:4492-4495`, `shortDelivery` `:4530`); `deliverExamPaper` `:4435`; reprint `createExamReprint` `:3859` |
| Database location | `printing_jobs` qty pipeline (`0011:42-46,93-101`); `exam_papers.good_copies/spoiled_copies` (`0024:60-62`); `reprint_of_paper_id/reprint_reason` (`0024:64`, `0026:12`) |
| Test evidence | `exam-lifecycle.test.ts:188-238` (short delivery exercised but quantity/`shortDelivery` not asserted); `:250-283` (reprint linkage) |
| Gap | No `accepted_qty` column; no separate production-loss ledger; no dedicated loss-account posting (Finance approval outstanding); reprints create new job but loss-accounting rule not defined |
| Risk | Financial |
| Recommended remediation | Phase 4/5 — add accepted/delivered/short/reprinted quantity columns; implement loss treatment only after Finance approves matrix |
| Acceptance test | Verify invoiced qty = accepted learner qty only; loss posted once; material returned |

### 1.5 Toner/machine cost variance (D2)

| Field | Detail |
|---|---|
| Requirement | Compare estimated vs actual production cost; separate est/actual; trace to paper/batch; dedicated variance account |
| Current status | **Partial** |
| Backend location | `job_material_requirements.planned_*` vs `actual_good_usage_qty` (`productionService.ts:614-648`, variance `:1289-1299`); `cost_status`/`cost_warnings` on exam paper (`printingRecordsService.ts:1551-1552`) |
| Database location | `job_material_requirements` planned/actual/waste/returned (`0011:249-269`) |
| Test evidence | `phase9-e2e-workflows.test.ts` consumes/returns but never asserts planned-vs-actual variance |
| Gap | No dedicated variance account; no favourable/unfavourable treatment; no variance posting (Finance approval outstanding); variance not surfaced per paper |
| Risk | Financial |
| Recommended remediation | Phase 4 — implement only after Finance approves account code/name/method/thresholds |
| Acceptance test | Variance computed and posted to approved account; traceable to paper/batch |

### 1.6 Confidential content retention (D4)

| Field | Detail |
|---|---|
| Requirement | Retain artwork/proofs + access/download audit 7 years from formal exam completion; protect content; no permanent public links; secure deletion after hold check; record disposal |
| Current status | **Missing** |
| Frontend location | No artwork/proof upload anywhere in exam UI |
| Backend location | No confidential-content endpoint; `exams:view_confidential` defined (`permissions.ts:77`) but unused by any route |
| Database location | No artwork/proof/file-version tables; generic `stored_files`/`attachments` (`0006:345-383`) not wired to exams |
| Test evidence | None |
| Gap | Entire D4 retention + protection unimplemented (see §2, P0-02) |
| Risk | Security / Legal |
| Recommended remediation | Phase 2 — confidential content store, signed URLs, retention/disposal (Legal sign-off required for commencement date) |
| Acceptance test | 8 security tests in Phase 2 all pass; disposal audited |

### 1.7 Examination cancellation (D5 — PROPOSED)

| Field | Detail |
|---|---|
| Requirement | Authorised cancellation; stop production; preserve history; reconcile qty/inventory; recover materials; calculate losses; reconcile before financial adjustments; authorised credit notes/refunds; prevent duplicate cancellation |
| Current status | **Partial** |
| Backend location | `cancelExamPaper` (`printingRecordsService.ts:3761`), `exams:cancel` route (`printingRoutes.ts:1027`); `cancelPrintingJob` (`productionService.ts:2394`) |
| Database location | `exam_papers.cancelled_at/cancelled_by/cancellation_reason` (`0024:56-58`); batch `cancelled_at` (`0024:20-22`) |
| Test evidence | `exam-lifecycle.test.ts:286-310` (cancel + already-cancelled); `phase9…:720-753` (job-level WIP write-off) |
| Gap | No full qty reconciliation workflow; no recoverable-material identification; no credit-note/refund orchestration; no reconciliation-before-adjustment gate; formal approvals outstanding |
| Risk | Financial / Inventory |
| Recommended remediation | Phase 5 — controlled workflow after Operations+Finance approvals |
| Acceptance test | Cancel requires reconciliation complete before any financial adjustment; no duplicate adjustment |

### 1.8 Status transitions / QC / pack / dispatch

| Field | Detail |
|---|---|
| Requirement | Enforced state machine with permission per target state |
| Current status | **Implemented** |
| Backend location | `EXAM_STATUS_ALLOWED` (`printingRecordsService.ts:3463-3478`); `updateExamPaperStatus` (`:3480`); transition permission map (`printingRoutes.ts:985-993`, inline check `:1004-1008`) |
| Database location | `exam_papers.status` check (`0024:73-78`); `qc_status` (`0024:85-88`); `packed_at/dispatched_at` (`0026:10-11`) |
| Test evidence | `exam-lifecycle.test.ts:140-310`; `contracts-gap-closure.test.ts:671` (G-15) |
| Gap | PATCH route uses inline `hasPermission` not `requirePermission` middleware (`printingRoutes.ts:995`) — functionally correct, stylistically inconsistent; `scheduled/reserved/delivered/invoiced` not in transition map (reachable only via dedicated endpoints) |
| Risk | Operational |
| Recommended remediation | Phase 6 — route through middleware for consistency |
| Acceptance test | Each transition denied for wrong role (403) |

### 1.9 Invoice generation (exam)

| Field | Detail |
|---|---|
| Requirement | Backend-authoritative exam invoice; eligible only when delivered; no double invoicing; traceable link |
| Current status | **Partial** |
| Frontend location | `createConsolidatedSchoolInvoice` (`AccountingContext.tsx:2101-2322`); `generateAndSyncWorkflowInvoice` (`:3018-3069`) |
| Backend location | `POST /documents/generate-invoice` (`documentsRoutes.ts:144`, `invoices:write`) → `generateInvoiceFromWorkflow` (`documentsService.ts:1463`) → `linkExamPapersToInvoice` (`:1568`, service `:4554`) |
| Database location | `exam_paper_invoice_links` unique per paper (`0024:210-246`); `invoices` (`0003`) |
| Test evidence | `exam-production-integrity.test.ts:269-373`; `documents-and-invoicing.test.ts:459-477` |
| Gap | `exams:invoice` permission defined but never enforced (exam invoicing gated by `invoices:write`); two entry points disagree on non-delivered eligibility (`exam-production-integrity:287` rejects vs `documents:471` accepts 201); consolidated path silently falls back to local-only invoice when `useBackend===false` (`AccountingContext.tsx:2126,2186`) |
| Risk | Financial / Security |
| Recommended remediation | Phase 3/6 — enforce `exams:invoice`; unify eligibility; remove silent local invoice fallback |
| Acceptance test | Non-delivered rejected at both entry points; ProductionManager without invoice permission 403 |

### 1.10 Tenant isolation

| Field | Detail |
|---|---|
| Requirement | Company-scoped access on every exam endpoint |
| Current status | **Implemented** (for exam endpoints) |
| Backend location | `withCompanyDb` (`db.ts:620-630`); `rejectCrossCompanyParams` (`auth.ts:347-391`); every query `WHERE company_id=$1` |
| Database location | RLS ENABLE+FORCE + `app_rls_allowed(company_id)` on all exam tables (`0007:228-275`, `0024:202-246`); composite FKs (`0007`, `0024`) |
| Test evidence | `auth-isolation.test.ts:149-237` (general); **no exam-specific negative test** |
| Gap | No exam endpoint cross-tenant negative tests (Phase 6) |
| Risk | Security |
| Recommended remediation | Phase 6 — fresh negative tests for all exam endpoints |
| Acceptance test | Foreign paper/batch id → 404; missing permission → 403 |

### 1.11 Idempotency / concurrency

| Field | Detail |
|---|---|
| Requirement | No duplicate production/inventory/invoice/payment on retry/double-click |
| Current status | **Partial** |
| Backend location | `claimPrintingIdempotency` (`printingRecordsService.ts:47-118`) for batch create/reprint; `checkRouteIdempotency` for job ops; `request_keys` unique (`0001:190-201`) |
| Database location | `uq_exam_invoice_links_paper` (`0024:223`); `request_keys` unique; `journal_transactions` partial unique (`0009:11-15`) |
| Test evidence | `exam-lifecycle.test.ts:126-137,263-271`; `exam-production-integrity.test.ts:171-216,351-373` |
| Gap | `recordMaterialConsumptionAndWaste` / `recordProductionOperation` / `recordFinishingOperation` not idempotency-keyed (`printingRoutes.ts:233,265,278`); `updateExamPaperStatus`/`deliverExamPaper`/`cancelExamPaper` have no idempotency test; `exam_paper_events.idempotency_key` has no unique constraint (`0024:169`) |
| Risk | Financial / Inventory |
| Recommended remediation | Phase 8 — key all critical mutations; add duplicate-request tests |
| Acceptance test | Double submit → single effect; retries return authoritative result |

### 1.12 Confidential-content permission enforcement

| Field | Detail |
|---|---|
| Requirement | Enforce `exams:view_confidential` on confidential endpoints |
| Current status | **Missing** |
| Backend location | Permission defined `permissions.ts:77,183,323,367`; no route uses it |
| Test evidence | `exam-lifecycle.test.ts:349-373` asserts role matrix only; never asserts confidential access enforcement |
| Gap | Dead permission; exam cost fields leak to all `exams:view` holders |
| Risk | Security |
| Recommended remediation | Phase 2/6 |
| Acceptance test | ProductionManager without `exams:view_confidential` → 403 on confidential endpoint |

---

## 2. Confirmed defects (evidence-backed)

> **Status update (Phase 1 remediation):** P0-01, P0-03, P1-04, P1-05, P1-06,
> P1-07, P1-08 (D3), P1-09, P1-10, P1-11, P1-12 and the data-leak slice of
> P0-02 are now **RESOLVED**. See each entry's "Resolution" note. Remaining
> open items are the full P0-02 confidential-content subsystem (Phase 2) and
> the approval-gated D1/D2 financial policies.

### P0-01 — Local-only exam creation is the default outcome and is reported as server-confirmed (RESOLVED)
`addExamPapersBatch` (`AccountingContext.tsx:1838`) branches on id shape (`:1851-1855`). When ids are non-numeric (the default demo ids `cust-1`, `item-raw-1`), it fabricates `exm-*` rows locally (`:1942-1960`) with client-fabricated job numbers and zeroed costs. The caller unconditionally shows `"Server confirmed N examination print job(s) in the production queue."` (`ExaminationView.tsx:480-482`). Demo customers are permanently merged into the live list (`AccountingContext.tsx:770-775`), and inventory/customer backend loads silently fall back to demo data (`:546-577`, `:762-799`), so the local branch is reachable on a healthy backend. This is the "fake local success" defect named in the handover (Phase 3, gate 3).
**Resolution:** `addExamPapersBatch` now throws descriptive errors when backend ids are missing and uses `printingApi.createExamBatch` as the sole creation path; the local `exm-*` fabrication branch is deleted.

### P0-02 — No confidential content protection; `exams:view_confidential` is dead (PARTIALLY RESOLVED)
No artwork/proof/upload/signed-URL handling exists for exams. `exams:view_confidential` is granted (`permissions.ts:183,323,367`) but enforced by no route. Exam read endpoints return cost fields to any `exams:view` holder including Read-Only/Bookkeeper (`printingRecordsService.ts:3397-3399,4172-4179`). This is the zero-tolerance Phase 2 blocker.
**Resolution (data-leak slice):** `GET /printing/exam-papers` and `GET /printing/exam-batches` now redact cost fields (paper/toner/material cost, cost status/warnings, physical consumption, aggregate cost totals) unless the caller holds `exams:view_confidential`, and return a `costsRedacted` flag. The full confidential-content store (artwork, proofs, signed URLs, 7-year retention/disposal) remains open as a Phase 2 subsystem.

### P0-03 — `exam-lifecycle.test.ts` is not wired to any npm script (RESOLVED)
`package.json:13-28` has no `test:exam-lifecycle` entry. The suite can rot undetected. (The prior report ran it via `npx tsx`.)
**Resolution:** added `"test:exam-lifecycle": "tsx tests/printing/exam-lifecycle.test.ts"` to `package.json`.

### P1-04 — Exam invoicing uses `invoices:write`, not `exams:invoice` (RESOLVED)
`documentsRoutes.ts:144-146` gates exam invoice generation by `invoices:write`; `exams:invoice` (`permissions.ts:85`) is never checked. This is a segregation-of-duties gap for the exam module.
**Resolution:** `linkExamPapersToInvoice` now enforces `hasPermission(actor.role, 'exams:invoice')` server-side.

### P1-05 — Silent local invoice fallback in consolidated billing (RESOLVED)
`createConsolidatedSchoolInvoice` sets `useBackend = selectedPapers.every(p => Boolean(p.backendId))` (`AccountingContext.tsx:2126`); when false, the server block is skipped and a local invoice is written while the UI still reports success (`:2186`, `ExaminationView.tsx:647-649`).
**Resolution:** the function now throws when any selected paper lacks a `backendId`; a local-only invoice is never written.

### P1-06 — Background refresh swallows all errors; stale/demo data indistinguishable from live (RESOLVED)
`refreshExamPapersFromBackend` (`AccountingContext.tsx:791-799`) returns early on empty list and `catch {}` on error. No user-visible warning.
**Resolution:** refresh failures now surface via `console.warn` + `triggerShortcutNotice` (exam papers) and `console.warn` (customers/contracts).

### P1-07 — Two invoice-eligibility rules coexist (RESOLVED)
`exam-production-integrity.test.ts:287` asserts a non-delivered paper invoice is rejected (`EXAM_PAPER_NOT_DELIVERED`); `documents-and-invoicing.test.ts:471` asserts a `201` for a batch-level invoice on a `completed`, never-delivered paper. The paper-level path validates delivery; the batch path (when no delivered papers but a production job exists) throws `EXAM_BATCH_NOT_DELIVERED` only under specific conditions (`documentsService.ts:1531-1545`). Behaviour is inconsistent between entry points.
**Resolution:** the batch-level path now requires all papers in the batch to be `delivered` (or `invoiced`/`cancelled`); papers without a production job are invoiced via lines only (no WIP to relieve).

### P1-08 — Qty pipeline incomplete for D1/D3 (RESOLVED for D3)
No `accepted_qty`, `teacher_*`, `learner_*`, `billable`, `planned_production_qty`, `damaged_*`, `replacement_*` columns exist. `copies` doubles as ordered and billable quantity.
**Resolution (D3):** migration `0029` adds `teacher_copies` (fixed 2), `planned_production_quantity`, `billable_quantity`, `accepted_learner_quantity`, and damaged/replacement columns; QC computes billable = good − teacher; invoicing uses `billable_quantity`; reprints get `teacher_copies=0`. D1 (accepted/loss accounting) and D2 (variance postings) remain approval-gated.

### P1-09 — Consumption/production/finishing operations not idempotency-keyed (RESOLVED)
Routes `printingRoutes.ts:233,265,278` pass no idempotency key; duplicate material consumption could double-post WIP. (No test proves a duplicate, but the key is absent.)
**Resolution:** `recordMaterialConsumptionAndWaste`, `recordProductionOperation`, and `recordFinishingOperation` now use `checkRouteIdempotency`/`saveRouteIdempotency`; the routes forward the `idempotency-key` header/body.

### P1-10 — `exam_paper_events.idempotency_key` has no unique constraint (RESOLVED)
`0024:169` — replay protection relies solely on service-layer `request_keys` and per-paper unique invoice link.
**Resolution:** migration `0029` adds partial unique index `uq_exam_paper_events_idempotency (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL`; event keys are made unique per paper.

### P1-11 — 0026 down migration fails if reprints exist (RESOLVED)
`0026.down:14-15` re-adds full `UNIQUE (company_id, batch_id, subject_name)`. Reprints share the parent's `batch_id` + `subject_name` (`printingRecordsService.ts:3942-3974`); 0026.up deliberately excluded them via a partial index. Any reprint row makes the down fail. Same class of hazard in 0024.down (`status_check` restored to 4 values).
**Resolution:** `0026.down` now recreates a partial unique index (`WHERE reprint_of_paper_id IS NULL`); `0024.down` normalizes out-of-range `status` values to `completed` before restoring the legacy 4-value `status_check`.

### P1-12 — Migration file header says "0025" (RESOLVED, cosmetic)
`0026_examination_lifecycle_completion.up.sql:1` and `.down.sql:1` say "0025". Migrator keys off filename, so cosmetic but misleading.
**Resolution:** both headers corrected to "0026".

---

## 3. Phase 1 shared regressions — current status

Per the prior report (`EXAMINATION_MODULE_PRODUCTION_REPORT.md:267-270,288-302`) these regressions exist in the working tree. This audit confirms the relevant schema/code exists to produce them; each must be re-verified by running the suites in Phase 1.

| Regression | Reported symptom | Confirmed root artefact | Status |
|---|---|---|---|
| Documents/invoices `$4` | `could not determine data type of parameter $4` | `generateInvoiceFromWorkflow`/`createInvoiceOrSalesReceipt` path (`documentsService.ts:1463+`) | **Verified fixed** — `test:documents` 7/7 |
| Documents setup 409 | HTTP 409 on setup | — | **Verified fixed** — `test:documents` setup passes |
| `approval_policies_action_type_check` | violation on workflow run | constraint at `0020:298-317` (and `0014`); new action types must be in the CHECK list | **Not reproduced** — `test:documents` workflow invoicing passes |
| `customer_code NOT NULL` | migration-suite fails 4/5/6/8 | `0025` sets `customer_code NOT NULL` (`0025:53-60`); migration-suite seeds customers without it | **Verified fixed** — `test:db` 8/8 |
| Missing `JOB_MATERIALS_ISSUED` | audit action absent | written at `productionService.ts:1190` | **Present** — emitted on material issue |

These are **not** to be "fixed" by weakening tests. Phase 1 will reproduce, root-cause, and fix the underlying defect while preserving financial/audit semantics.

---

## 4. Test coverage summary (evidence)

| Dimension | Covered | Best evidence | Missing |
|---|---|---|---|
| Server-authoritative creation | ✅ | exam-production-integrity | — |
| Multi-class integrity | ✅ | exam-production-integrity:152-160 | — |
| Status machine + QC + pack + dispatch | ✅ | exam-lifecycle:140-310 | — |
| Reprint (exam) | ✅ | exam-lifecycle:250-283 | reprint→QC→deliver→invoice cycle |
| Cancellation (exam) | ✅ | exam-lifecycle:286-310 | reservation-release assertion; financial reversal |
| Invoice (paper-level) | ✅ | exam-production-integrity:269-373 | multi-paper allocation split; `ALREADY_INVOICED` |
| Idempotency (batch/reprint/invoice) | ✅ | exam-lifecycle; exam-production-integrity | deliver/status/cancel idempotency |
| Material issue (exam) | ⚠️ | exam-production-integrity:218-251 | `reserved_qty` assertion |
| Tenant isolation (exam) | ❌ | only general auth-isolation | all exam cross-tenant negatives |
| Confidential content | ❌ | role matrix only | all data-level tests |
| Teacher copies (D3) | ✅ | exam-lifecycle (creation + reprint); exam-production-integrity (QC/invoice) | full rule incl. reprint-no-new-allowance |
| Billable quantity | ✅ | exam-lifecycle:QC (good−teacher); exam-production-integrity (linked_quantity) | multi-paper allocation split |
| Planned production / variance (D2) | ⚠️ planned asserted | exam-lifecycle (planned = copies + 2) | D2 variance postings (approval-gated) |
| Short delivery | ⚠️ exercised | exam-lifecycle:188-238 | qty/shortDelivery assertion |
| Cancellation D5 workflow | ⚠️ partial | job-level only | full reconciliation workflow |
| Reconciliation | ⚠️ 4/9 checks | exam-lifecycle:335-343 | 5 checks; no critical-producing test |
| E2E browser | ❌ | node-level phase9 only | real browser E2E |
| Performance/reliability | ❌ | none | 1000-run measurement |
| Legacy reconciliation | ❌ | none | production-copy report |
| Migration rehearsal | ⚠️ pass only | migration-suite | 0026 up/down with reprint data |

---

## 5. Risk summary

| Category | Highest risk items |
|---|---|
| Financial | Local-only creation reported as success (P0-01); no accepted/loss accounting (D1); no variance account (D2); silent local invoice (P1-05); unkeyed consumption (P1-09) |
| Security | No confidential content (P0-02); dead `exams:view_confidential`; `exams:invoice` not enforced (P1-04); cost leakage to Read-Only |
| Inventory | No teacher/learner/billable/planned quantities (P1-08); no `reserved_qty` assertions; consumption not idempotent |
| Operational | Stale/demo data shown as live (P1-06); exam-lifecycle test not in CI (P0-03); no E2E/perf |
| Migration | 0026 down fails with reprints (P1-11) |

---

## 6. Overall baseline verdict

**Not production ready.** The backend-authoritative core (server costing, lifecycle, cancellation, reprint, append-only audit, invoice linking, tenant scoping) is implemented and unit-tested. Blockers for certification:

1. No confidential-content protection (P0-02) — zero-tolerance gate.
2. Local-only exam creation default + fake success (P0-01) — zero-tolerance gate.
3. D3 (two teacher copies), D1 (accepted/loss accounting), D2 (variance) unimplemented.
4. Phase 1 shared regressions unverified/unresolved.
5. No exam tenant-isolation negatives, no browser E2E, no performance, no legacy reconciliation.

See `EXAM_PRINTING_IMPLEMENTATION_PLAN.md` for the remediation sequence.