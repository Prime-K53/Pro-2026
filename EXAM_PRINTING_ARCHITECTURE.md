# EXAM_PRINTING_ARCHITECTURE.md

**Module:** PRIME ERP — Examination Printing
**Phase:** 0 — Repository-First Baseline Audit
**Date:** 21 November 2026

This document records the **actual** architecture as found in the repository (commit `4d9eaf4`). It describes the current system, not a target design. Proposed changes are flagged **[PROPOSED]**.

---

## 1. System overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Frontend (React 19 + Vite)                                            │
│  ExaminationView.tsx  (single 2030-line component)                    │
│  AccountingContext.tsx (global state, demo seed + backend sync)       │
│  printingApi.ts        (fetch wrapper → /api/printing/*)              │
│  documentsApi.ts       (fetch wrapper → /api/documents/*)             │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HttpOnly cookie (pms_session) or Supabase Bearer JWT
┌───────────────▼──────────────────────────────────────────────────────┐
│ Express server (src/server)                                          │
│  app.ts → routers                                                    │
│  middleware/auth.ts: requireAuth + rejectCrossCompanyParams          │
│  permissions.ts: hasPermission(role, permission)                     │
│  routes/printingRoutes.ts  (exam endpoints, exam permission checks)  │
│  routes/documentsRoutes.ts (invoice generation)                      │
│  routes/protectedRoutes.ts (attachments)                             │
│  services/printingRecordsService.ts (exam domain authority)          │
│  services/productionService.ts  (jobs, reserve/issue/consume/QC/DN)  │
│  services/documentsService.ts   (invoice + linkExamPapersToInvoice)  │
│  services/accountingEngine.ts   (balanced, idempotent journals)      │
│  services/approvalService.ts    (approval policies/requests)         │
│  audit.ts (writeAuditLog → audit_log)                                │
│  db.ts (withCompanyDb: SET LOCAL ROLE + app.current_company_id)      │
└───────────────┬──────────────────────────────────────────────────────┘
                │ PGlite (WASM Postgres) in dev/test; Postgres in prod
┌───────────────▼──────────────────────────────────────────────────────┐
│ Database (26 migrations, 0001–0026)                                  │
│  RLS ENABLE+FORCE on every tenant table; app_rls_allowed(company_id) │
│  Composite FKs (company_id, parent_id) for tenant integrity          │
│  Append-only triggers on audit_log and exam_paper_events             │
└──────────────────────────────────────────────────────────────────────┘
```

**Key architectural facts (verified):**
- One HTTP request = one DB transaction. Every route wraps work in `db.withCompanyDb(companyId, tx => service(...))`; services accept the caller's `tx` and never open their own (`printingRoutes.ts:469,473`, etc.).
- `withCompanyDb` (`db.ts:620-630`) runs `SET LOCAL ROLE pms_app_role`, `app.bypass_rls='off'`, `set_config('app.current_company_id', companyId, true)`.
- `withSystemDb` (`db.ts:614-619`) sets `app.bypass_rls='on'` (used only by migration/backup paths).
- No ORM. All data access is parameterized SQL over the `Transaction` interface.

---

## 2. Backend request pipeline

1. `app.ts` builds the Express app: JSON body cap `6mb` (`app.ts:27`), correlation-id echo (`:28-37`), health (`:40-50`), auth public-config (`:52-57`), production-only rate limiting (`:59-64`), routers, `/api` 404 fallthrough (`:84-86`), sanitised 500 handler (`:88-92`).
2. Each router applies `router.use(requireAuth, rejectCrossCompanyParams)` (e.g. `printingRoutes.ts:107`).
3. `requireAuth` (`auth.ts:89`) resolves identity from either the signed cookie session (`auth.ts:101-223`) or a Supabase Bearer JWT (`:226-334`). Company, membership and role are **server-derived**, never client-supplied (`:196-212`).
4. `rejectCrossCompanyParams` (`auth.ts:347-391`) rejects any `companyId`/`company_id`/`X-Company-Id` in query/header/body that differs from the session company → **403** + `CROSS_COMPANY_ATTEMPT` audit row.
5. `requirePermission('...')` (`auth.ts:393-406`) → 401 if unauthenticated, 403 if the role lacks the permission.
6. Handler calls `db.withCompanyDb(req.auth!.companyId, tx => service(...))`.
7. Errors map through `handlePrintingError` (`printingRoutes.ts:72-92`) for PG constraint codes, or propagate `AccountingError.statusCode`.

---

## 3. Examination domain model

### 3.1 Entities

| Entity | Table | Role |
|---|---|---|
| Batch | `exam_assessment_batches` | One school + assessment + class; holds `learners_count`, `price_per_learner`, generated `class_revenue`, `status`, `spec_version/spec_hash/spec_frozen`, cost totals |
| Paper | `exam_papers` | One subject within a batch; holds `copies`, `pages`, quantities (`good_copies`, `spoiled_copies`, `qc_approved_copies`, `waste_sheets`), cost (`paper_cost`, `toner_cost`, generated `material_cost`, `cost_status`), lifecycle status, `reprint_of_paper_id`, `invoice_id`, `delivery_note_id`, `production_job_id` |
| Event | `exam_paper_events` | Append-only timeline; `event_type` ∈ `created, status_changed, cancelled, reprinted, spec_approved, delivered, invoiced, legacy_import`; immutable via trigger |
| Invoice link | `exam_paper_invoice_links` | One row per paper (`uq_exam_invoice_links_paper`); `linked_quantity`, `linked_amount`; supports WIP→COGS traceability |
| Production job | `printing_jobs` | `job_type='exam_paper'`; qty pipeline `ordered→produced_good→qc_approved→delivered→invoiced`; `reprint_of_job_id`; `exam_paper_id` link |
| Material requirement | `job_material_requirements` | Per job: `planned/reserved/issued/actual_good/waste/returned` usage qty + cost |

### 3.2 Status machines

`exam_papers.status` (0024:73-78): `draft, scheduled, queued, reserved, printing, qc_hold, qc_passed, completed, packed, dispatched, delivered, invoiced, cancelled, reprinted`.

Application transition matrix `EXAM_STATUS_ALLOWED` (`printingRecordsService.ts:3463-3478`):
`queued→printing`, `printing→completed|qc_passed|qc_hold`, `qc_hold→printing`, `qc_passed→packed`, `packed→dispatched`, `dispatched→delivered`. Terminal: `invoiced`, `cancelled`, `reprinted` (`[]`).

`exam_assessment_batches.status` (0024:27-30): `draft, scheduled, in_production, completed, delivered, invoiced, closed, cancelled`.

`printing_jobs.status` (0011:35-38): `draft, budget_approved, queued, in_production, finishing, qc_pending, ready, partial_delivery, delivered, completed, cancelled`.

### 3.3 Service functions (with line numbers)

`printingRecordsService.ts`: `createExamBatch` (1335), `listExamPapers` (3431), `updateExamPaperStatus` (3480), `cancelExamPaper` (3761), `createExamReprint` (3859), `listExamPaperEvents` (4092), `listExamBatches` (4127), `approveExamBatchSpecification` (4199), `getExaminationReconciliation` (4290), `deliverExamPaper` (4435), `linkExamPapersToInvoice` (4554), `deleteExamPaper` (4807).

`productionService.ts`: `createPrintingJob` (282), `reserveJobMaterials` (801), `issueJobMaterials` (923), `recordMaterialConsumptionAndWaste` (1201), `returnUnusedMaterials` (1328), `recordProductionOperation` (1505), `recordFinishingOperation` (1711), `recordQualityInspection` (1908), `createDeliveryNote` (2019), `invoiceDeliveredJob` (2153), `cancelPrintingJob` (2394), `createControlledReprint` (2537).

`documentsService.ts`: `generateInvoiceFromWorkflow` (1463) → `linkExamPapersToInvoice` (1568).

### 3.4 API endpoints (exam)

| Method | Path | Permission | Line |
|---|---|---|---|
| POST | `/printing/exam-batches` | `exams:create` | printingRoutes.ts:469 |
| GET | `/printing/exam-papers` | `exams:view` | :942 |
| GET | `/printing/exam-batches` | `exams:view` | :954 |
| GET | `/printing/exam-papers/:id/events` | `exams:view` | :970 |
| PATCH | `/printing/exam-papers/:id/status` | inline per-status (`exams:produce/qc/dispatch`) | :995 |
| POST | `/printing/exam-papers/:id/cancel` | `exams:cancel` | :1027 |
| POST | `/printing/exam-papers/:id/reprint` | `exams:produce` | :1044 |
| POST | `/printing/exam-batches/:id/approve-spec` | `exams:approve` | :1065 |
| GET | `/printing/exam-reconciliation` | `exams:view` | :1081 |
| POST | `/printing/exam-papers/:id/deliver` | `exams:deliver` | :1092 |
| DELETE | `/printing/exam-papers/:id` | `exams:cancel` | :1111 |

Exam invoicing: `POST /documents/generate-invoice` (`documentsRoutes.ts:144`, `invoices:write`) — **note `exams:invoice` is not enforced** (see Baseline Audit P1-04).

---

## 4. Data integrity mechanisms

- **RLS:** every tenant table `ENABLE`+`FORCE` `app_rls_allowed(company_id)` (`0001:10-21,26-28`; per-table policies in `0006/0007/0011/0017/0020/0021/0024`). `pms_app_role` is `NOBYPASSRLS`.
- **Composite FKs:** all parents expose `UNIQUE (company_id, id)`; children reference `(company_id, parent_id)`. Cross-tenant references fail at the DB even with `bypass_rls` on (verified by `migration-suite.ts:365-409`).
- **Append-only:** `audit_log` (`0006:456-468`) and `exam_paper_events` (`0024:188-200`) reject UPDATE/DELETE via triggers.
- **Unique constraints:** `uq_exam_invoice_links_paper` (one invoice link per paper), `uq_exam_papers_company_job`, `uq_exam_batch_school_class`, partial `uq_exam_papers_batch_subject_original WHERE reprint_of_paper_id IS NULL` (0026:24-27), `uq_request_keys_company_route_key`, `uq_journal_txns_company_idempotency` (partial).
- **Idempotency:** two implementations, both backed by `request_keys`:
  - `claimPrintingIdempotency` (`printingRecordsService.ts:47-118`) — batch create, reprint, contract ops.
  - `checkRouteIdempotency`/`saveRouteIdempotency` (`commercialHelpers`, used by `productionService.ts`) — job create, reserve, issue, return, invoice.
  - On conflict: actor mismatch → 409 `IDEMPOTENCY_ACTOR_CONFLICT`; payload-hash mismatch → 409 `IDEMPOTENCY_CONFLICT`; in-progress → 409 `IDEMPOTENCY_IN_PROGRESS`; else replay stored body.
- **Row locking:** `SELECT ... FOR UPDATE` on papers, jobs, inventory items (sorted item-id order to avoid deadlocks, `productionService.ts:843`).

---

## 5. Frontend architecture

- `ExaminationView.tsx` — single component (2030 lines): filters, class billing table, paper production table, 5 modals (Add Batch, Consolidated Invoice, Timeline, Cancel, Reprint, Reconciliation). No sub-components, no memo boundaries.
- `AccountingContext.tsx` — global state. Loads bundled demo seed (`INITIAL_EXAM_PAPERS`, `initialDemoData.ts:510-677`) at boot (`:590-615`), then `refreshExamPapersFromBackend` (`:791-799`). Hosts `addExamPapersBatch` (`:1838`), `updateExamPaperStatus` (`:1974`), `deliverExamPaper` (`:2013`), `cancelExamPaper` (`:2045`), `reprintExamPaper` (`:2059`), `createConsolidatedSchoolInvoice` (`:2101`), `generateAndSyncWorkflowInvoice` (`:3018`).
- `printingApi.ts` — thin fetch wrapper; `createExamBatch` (`:209`) does **not** emit `ACCOUNTING_UPDATED_EVENT` (`:260-266`), so batch creation does not auto-refresh the list.
- Transport: `http.ts:65-74` throws `ApiError` on non-2xx; 401 triggers session-expiry notice.

**Frontend trust model today (verified):**
- Server papers (numeric `backendId`) go through `printingApi` for status/deliver/cancel/reprint.
- Non-backend (demo) papers mutate React state only (`updateExamPaperStatus:1992-2003`), producing a fully local lifecycle that cannot reach `delivered` (deliver/cancel/reprint throw for non-backend ids).
- Local-only creation path (`addExamPapersBatch:1942-1960`) fabricates rows with zeroed costs and client job numbers.

---

## 6. Build / run / test topology

- `npm run dev` → `tsx server.ts` (Express + Vite middleware).
- `npm run build` → `vite build`; `npm run lint` → `tsc --noEmit`.
- Tests: `tsx` running `node:test` or hand-rolled `runTest` collectors against **in-memory PGlite** (`createServerDatabase(cfg, { inMemory: true, seedDemo: true })`, `db.ts:597-606`). Full migration chain `0001`→`0026` applied at DB creation.
- Wired suites: `test:db`, `test:inventory`, `test:security`, `test:accounting`, `test:commercial`, `test:controls`, `test:printing`, `test:wallet`, `test:contracts`, `test:amendments`, `test:printing-contracts`, `test:exam-integrity`, `test:workflows`, `test:migration`, `test:documents`.
- **Not wired:** `exam-lifecycle.test.ts` (no npm script) — see Baseline Audit P0-03.

---

## 7. Known architectural gaps (from audit)

1. No confidential-content subsystem (no artwork/proof store, no signed URLs, no version table). Generic `stored_files`/`attachments` exist (`0006:345-383`) but are unwired to exams.
2. No teacher/billable/planned quantity model (D3/D1/D2).
3. Two invoice-eligibility paths with inconsistent rules.
4. `exams:view_confidential`, `exams:invoice`, `exams:edit`, `exams:manage_permissions` are defined but not enforced by any route.
5. Consumption/production/finishing operations not idempotency-keyed.
6. `exam_paper_events.idempotency_key` unconstrained.
7. Local-only creation and silent local invoice fallback on the frontend.

**[PROPOSED]** target additions (detailed in Implementation Plan): teacher/billable/planned quantity columns; accepted/delivered/short/reprinted quantity columns; confidential content store with retention; variance account wiring; enforced `exams:*` permissions; idempotent consumption; `test:exam-lifecycle` npm script; exam negative tests; browser E2E; performance harness.