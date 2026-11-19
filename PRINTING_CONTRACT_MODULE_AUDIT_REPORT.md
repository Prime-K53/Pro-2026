# Printing Contract Module — End-to-End Audit Report

**Project:** Printing Management System (Prime ERP)
**Module:** School Printing Contracts, Assessment Milestones, Prepaid Retainers & Examination Batches
**Audit date:** 2026-11-19
**Audit type:** Static, end-to-end architecture / financial-integrity / data-consistency review
**Scope baseline:** `db/migrations/0007_printing_production_exams_contracts.up.sql` through the React contracts UI

---

## 1. Executive Summary

The printing-contract domain is architecturally well above average: it has tenant isolation (RLS + composite FKs), a single double-entry posting engine, exact `NUMERIC(19,4)` / BigInt decimal handling, generated total/profit columns, CHECK constraints, audit logging, and a paper/toner costing engine that correctly refuses to let pricing alter physical quantities.

However, the module is **not yet financially production-grade**. The dominant risk is **dual-write inconsistency between the browser state and PostgreSQL**: most contract mutations are optimistic in React, fire-and-forget to the API, and silently fall back to a local ledger when the backend rejects the call. A rejected or duplicated financial transaction can therefore still appear successful in the UI, and a server-side contract can be lost from the client.

The audit identified **nine Critical (S1) findings**. The most severe money-movement defects are:

1. No server-side invariant that assessment amounts sum to the prepaid total (and completion can strand a credit balance).
2. Contract creation and renewal post real deposit journals with **no idempotency key**.
3. Cancelling a contract leaves the unearned-revenue liability and cash unsettled.
4. Renewing posts a bank debit / unearned-revenue credit for cash that may never have been received.

The remaining Critical findings are the missing bank-subledger row for deposits, contract-number collisions at scale, and three frontend patterns that turn backend rejection or timeout into a false local success.

**Estimated current maturity: ~72–75%.** Reaching the requested **≥99.8%** requires closing all Critical/High findings, adding service-level tests, and enforcing the invariants in the database as well as in application code. The accompanying remediation plan sequences this into six phases with explicit acceptance gates.

---

## 2. Scope, Method and Evidence

### 2.1 Files reviewed

| Layer | Files |
|---|---|
| Schema | `db/migrations/0007_printing_production_exams_contracts.up.sql`, `0004_purchases_payables_and_banking.up.sql`, `0011_phase9_production_workflow_integration.up.sql` |
| Backend services | `src/server/services/printingRecordsService.ts`, `printingWorkflows.ts`, `paperCalc.ts`, `tonerCalc.ts`, `accountingEngine.ts`, `documentsService.ts` |
| Routes | `src/server/routes/printingRoutes.ts`, `documentsRoutes.ts`, `protectedRoutes.ts` |
| API client | `src/services/printingApi.ts`, `documentsApi.ts` |
| Frontend | `src/components/views/PrintingContractsView.tsx`, `src/components/modals/ContractActionModals.tsx`, `src/context/AccountingContext.tsx`, `src/types/accounting.ts`, `src/types/documents.ts` |
| Security | `src/server/permissions.ts`, `src/server/middleware/auth.ts`, `src/server/app.ts` |
| Tests | `tests/printing/paper-toner-calc.test.ts`, `tests/documents/documents-and-invoicing.test.ts`, `tests/db/migration-suite.ts`, `tests/workflows/phase9-e2e-workflows.test.ts` |

### 2.2 Method

- Traced the full lifecycle: **create → amend → add/remove assessment → generate invoice → complete/deduct → cancel/activate → renew**.
- Traced every money movement into `postJournalEntry` and verified whether a corresponding `bank_transactions` row exists.
- Compared frontend types, API serializers, and SQL columns for field-level parity.
- Checked every mutation for transaction boundaries, row locks, status guards, idempotency, and audit coverage.
- Checked role/permission coverage for each route.
- **No tests or builds were executed during this audit.** All findings are from static reading. The remediation plan includes the commands to verify each fix.

### 2.3 Severity model

| Severity | Meaning |
|---|---|
| **S1 — Critical** | Incorrect money, duplicate posting, silent financial failure, or data corruption. Blocks production. |
| **S2 — High** | Broken workflow, lost client data, cross-entity leakage, or misleading success. Must fix before 99%. |
| **S3 — Medium** | Robustness, scalability, reconciliation, or edge-case correctness. Needed for 99.8%. |
| **S4 — Low** | Polish, type safety, observability, documentation. Needed for maintainability. |

---

## 3. Architecture Map

```
React PrintingContractsView
  ├─ useAccounting()  (AccountingContext)
  │    ├─ optimistic setState(printingContracts)
  │    ├─ printingApi.*  (fire-and-forget for most mutations)
  │    └─ refreshPrintingContractsFromBackend() on ACCOUNTING_UPDATED_EVENT
  ├─ ContractActionModals (amend/add/remove/info)
  ├─ printingWorkflows.calculateContractMilestoneEstimate (client costing)
  └─ documentsApi / mapContractToPreviewModel (preview + invoice)
          │
          ▼
Express /api/printing/*
  ├─ requireAuth + rejectCrossCompanyParams + requirePermission
  ├─ printingRoutes.ts
  │    ├─ productionService  (jobs, machines, materials, QC, delivery)
  │    └─ printingRecordsService (contracts, milestones, exam batches)
  │         ├─ postJournalEntry (double-entry)
  │         └─ writeAuditLog
  └─ documentsService (contract preview, generate-invoice, attachments)
          │
          ▼
PostgreSQL (pglite / Supabase)
  printing_contracts ──< contract_assessment_milestones
  exam_assessment_batches ──< exam_papers
  journal_transactions ──< journal_lines
  bank_transactions (separate subledger)
  audit_log
```

**Key observation:** the browser and PostgreSQL are **two writable sources of truth** for contracts. The backend is authoritative for GL postings, but the client is authoritative for invoice links, local demo contracts, and (on failure) local ledger entries. No reconciliation protocol defines which wins.

---

## 4. Data Model Review

### 4.1 Strengths

- `printing_contracts` and `contract_assessment_milestones` are company-scoped with composite unique constraints and composite FKs (`company_id, id`), preventing cross-tenant references.
- RLS is `ENABLE`d and `FORCE`d on every table, with `app_rls_allowed(company_id)` policies.
- Monetary columns are `NUMERIC(19,4)`; `total_cost` and `profit` are `GENERATED ALWAYS AS ... STORED`, so they cannot drift from their inputs.
- CHECK constraints enforce `remaining_balance <= total_prepaid_amount`, `completed_assessments <= total_assessments`, `total_assessments BETWEEN 2 AND 5`, `agreed_amount >= 0`, and `assessment_number BETWEEN 1 AND 5`.
- `updated_at` trigger exists on `printing_contracts`.

### 4.2 Gaps

| ID | Gap | Evidence |
|---|---|---|
| **S1** | `printing_contracts` has no `currency_code`, `cancelled_at`, `cancelled_by`, `cancellation_reason`, `settlement_journal_txn_id`, `refund_amount`, `deposit_invoice_id`, or `deposit_invoice_number`. | `0007...up.sql:118-161`; no later migration adds them to contracts |
| **S2** | `contract_assessment_milestones` has no `completed_by` or `completed_at TIMESTAMPTZ` (only `completed_date DATE`). | `0007...up.sql:163-202` |
| **S2** | `exam_assessment_batches` / `exam_papers` have no constraint tying `contract_id` to `school_customer_id`. | `0007...up.sql:205-275` |
| **S3** | Contract number is `VARCHAR(64)` with no DB sequence; generation is application-side. | `0007...up.sql:121`; `printingRecordsService.ts:135-140` |
| **S3** | No index on `printing_contracts(company_id, status)` or `contract_assessment_milestones(company_id, status)`. | `0007...up.sql` |
| **S3** | `bank_transactions.journal_txn_id` exists but contract creation never populates it. | `0004...up.sql:348-368`; `printingRecordsService.ts:142-161` |

---

## 5. Backend Service Review

### 5.1 `printingRecordsService.ts`

**Strengths**

- All mutations are company-scoped and audited.
- `completeContractAssessment` locks the contract (`FOR UPDATE`) and the milestone (`FOR UPDATE`), checks `pending`, and passes an idempotency key to `postJournalEntry`.
- Deduction is clamped to `remaining_balance`, preventing a negative balance.
- Assessment completion posts a balanced Dr Liability / Cr Income entry through the shared engine.

**Defects**

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **C-01** | S1 | **No invariant that assessment amounts sum to the prepaid total.** Only the count is validated. If the sum is lower, `remaining_balance` never reaches zero and the liability is stranded; if higher, later assessments silently deduct only the remaining balance and revenue is under-recognized. Completion also sets `exhausted` when `completed >= total` even if `remaining_balance > 0`, stranding a credit balance. The fix must allow `SUM(agreed) <= total_prepaid` after a legitimate top-up, but require exact equality at creation and require settlement when all assessments complete with a positive balance. | `printingRecordsService.ts:124-131` (count only), `960-963` (clamped deduction), `994-996` (`isExhausted`) |
| **C-02** | S1 | **Contract creation posts a deposit journal with no idempotency key.** A retry/timeout creates a second contract and a second bank debit / unearned-revenue credit. | `printingRecordsService.ts:142-161`; `printingRoutes.ts:328-348` |
| **C-03** | S1 | **Cancel leaves cash and the unearned-revenue liability unsettled.** Status flips to `cancelled`, a note is appended, but `remaining_balance` and the liability are untouched; no refund or forfeiture entry is posted. | `printingRecordsService.ts:622-642` |
| **C-04** | S1 | **Renew posts a deposit journal without evidence of new cash.** It reuses the old bank account, amount, and past dates, then calls `createPrintingContract`, which debits bank and credits unearned revenue. | `printingRecordsService.ts:673-705` |
| **C-05** | S1 | **Contract number generation can collide permanently.** `MAX(contract_number)` + lexicographic `split('-')` breaks at `CTR-2026-100` vs `CTR-2026-99`; concurrent creates read the same MAX and one fails `23505`. | `printingRecordsService.ts:135-140` |
| **H-01** | S2 | **Add Assessment uses no `FOR UPDATE` on the contract in `updateContractAssessment`; amend does not lock at all.** Concurrent edits can interleave. | `printingRecordsService.ts:570-610`, `837-906` |
| **H-02** | S2 | **`removeContractAssessment` and `updateContractAssessment` do not require `status = 'active'`.** Assessments on cancelled/exhausted contracts can be edited or removed. | `printingRecordsService.ts:791-835`, `837-906` |
| **H-03** | S2 | **`createExamBatch` does not validate `contractId` against `schoolCustomerId` or `assessmentNumber` against `total_assessments`.** Cross-school or out-of-range links corrupt per-assessment actuals. | `printingRecordsService.ts:271-397` |
| **H-04** | S2 | **`updateExamPaperStatus` allows arbitrary transitions**, including `completed → queued`; only `invoiced` is blocked. | `printingRecordsService.ts:1167-1206` |
| **H-05** | S2 | **`assertIsoDate` only regex-checks the format.** `2026-02-30` passes and fails later as a Postgres cast error (500). Assessment dates are not required to fall within the contract window. | `printingRecordsService.ts:14-20`; `190-215` |
| **H-06** | S2 | **`exam_batch_note` is dropped on add.** The route accepts it, but the INSERT never includes the column. | `printingRoutes.ts:498`; `printingRecordsService.ts:750-771` |
| **M-01** | S3 | **`listPrintingContracts` is N+1** — one `loadMilestones` query per contract. | `printingRecordsService.ts:538-555` |
| **M-02** | S3 | **`resolveLiabilityAccount` can fall back to `PayrollLiability`**; `resolveIncomeAccount` can fall back to any income account. | `printingRecordsService.ts:22-46`, `908-931` |
| **M-03** | S3 | **Completion date uses UTC `new Date().toISOString()`**, which can be off by one day behind UTC. | `printingRecordsService.ts:965` |
| **M-04** | S3 | **`hydrateContract` does not return `updatedAt`, `liabilityAccountId` is number-typed while IDs are strings, and deposit invoice links are absent.** | `printingRecordsService.ts:515-536` |
| **M-05** | S3 | **`serializeMilestone` returns `backendInvoiceId` but not `linked_invoice_id`/`linked_invoice_number`.** | `printingRecordsService.ts:492-513` |

### 5.2 `printingWorkflows.ts` and costing engines

**Strengths**

- `calculateContractMilestoneEstimate` computes paper and toner independently of contract price, preserving physical quantities.
- `computePaperCostForSheets` uses BigInt scaled arithmetic and never binary floating point for money.
- Toner evidence states (`available` / `provisional` / `unavailable`) are propagated instead of invented.
- `calculateExaminationContractWorkflow` explicitly documents that production consumption never depends on contract pricing.

**Observations**

- `calculateContractMilestoneEstimate` requires `tonerChannels.K`; colour-only or C/M/Y-only channels are ignored. For colour contracts, the milestone toner cost will be understated. Add channel-aware handling or an explicit warning.
- The frontend `CONTRACT_PRESS_CAPABILITY` hardcodes a mono digital press (`supportsColour: false`), so the client estimate can never model colour. If colour contracts are offered, the estimate is wrong by design.
- `round2` uses `Math.round` (half-up) while the server uses `HALF_EVEN` for money. Client and server can differ by 0.01 on half-cent values. Standardize on the shared decimal helper.

### 5.3 `accountingEngine.ts`

- `postJournalEntry` is robust: validates dates, descriptions, balanced accrual/cash bases, account existence/active status, period-open locks, and idempotency via `request_keys`.
- **It never writes `bank_transactions`.** Any contract deposit is therefore invisible to the banking register and bank reconciliation. This is the root cause of **C-06** below.

---

## 6. API / Route Review

### 6.1 Strengths

- Every route uses `requireAuth`, `rejectCrossCompanyParams`, and `requirePermission`.
- `printing:read` / `printing:write` are defined for all roles; `invoices:write` is correctly required for job invoicing.
- `handlePrintingError` maps unique/check violations to 409 and `AccountingError` to its declared status.
- Idempotency keys are read from the `idempotency-key` header or body for jobs, materials, and invoicing.

### 6.2 Defects

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **C-06** | S1 | **Deposit journal has no bank subledger row.** `listContractWalletTransactions` reads `bank_transactions`, but creation only writes `journal_transactions`. The wallet modal is always empty for backend contracts and reconciliation is blind. | `printingRoutes.ts:584-605`; `printingRecordsService.ts:1042-1073`; `accountingEngine.ts:1725-1795` |
| **C-07** | S1 | **`POST /printing/contracts` and `/renew` have no idempotency guard.** Both move money. | `printingRoutes.ts:328-348`, `469-480` |
| **H-07** | S2 | **`handlePrintingError` maps FK violations (`23503`) and invalid date/text (`22P02`, `22007`) to 500**, leaking a misleading server error. | `printingRoutes.ts:50-61` |
| **H-08** | S2 | **Unknown errors return the raw DB message to the client** (`error: msg`), which can leak schema details. | `printingRoutes.ts:54-60` |
| **H-09** | S2 | **No top-up/deposit endpoint.** A contract cannot receive an additional prepaid deposit; renew creates a new contract instead. | Route inventory, `printingRoutes.ts:396-605` |
| **M-06** | S3 | **No pagination/filtering** on `GET /printing/contracts`, `/printing/exam-papers`, or `/printing/jobs`. | `printingRoutes.ts:91-98`, `400-409`, `611-620` |
| **M-07** | S3 | **No `GET /printing/exam-batches`** and no filter by `contractId`/`assessmentNumber` on exam papers. | Route inventory |
| **M-08** | S3 | **`POST /printing/exam-batches` does not validate the contract link** (see H-03). | `printingRoutes.ts:351-369` |

---

## 7. Frontend / Context Review

### 7.1 Strengths

- Clear separation of the register table, drawdown schedule, and action menus.
- Cost visibility is gated by `estimates:read_costs`; invoicing by `invoices:write`.
- `AdvancedActionsMenu` + `resolveActions` provides consistent permission/risk gating.
- The new-contract modal shows per-assessment profit live and blocks custom splits that do not sum to the prepaid total.

### 7.2 Defects

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **C-08** | S1 | **`addPrintingContract` silently converts backend rejection into a local ledger mutation.** `try { backend } catch { /* local fallback */ }` cannot distinguish "network down" from "400 validation error". A rejected financial transaction is posted to local accounts/bank transactions. If the backend succeeded but the response was lost, the local fallback double-counts. | `AccountingContext.tsx:2176-2208`, `2223-2253` |
| **C-09** | S1 | **All other contract mutations are optimistic and fire-and-forget.** `completeContractAssessment`, `cancelPrintingContract`, `activatePrintingContract`, `renewPrintingContract`, `amendPrintingContract`, `addContractAssessment`, `removeContractAssessment`, `updateContractAssessment` update local state first and call the API with `.catch(() => {})`. The UI shows success even when the server rejects. | `AccountingContext.tsx:2265-2335`, `2359-2468`, `2488-2623` |
| **H-10** | S2 | **`mapApiContract` drops deposit invoice links and milestone local invoice links.** After any refresh, the retainer invoice button disappears and the preview offers to generate a duplicate retainer invoice. | `AccountingContext.tsx:612-646`; `documents.ts:388-391` |
| **H-11** | S2 | **Milestone invoice generation from the preview is never linked to the milestone.** The milestone payload omits `postgresContractId` / `postgresMilestoneNumber`; `openContractPreview` only links the deposit invoice. | `documents.ts:416-440`; `PrintingContractsView.tsx:325-345`; `documentsService.ts:1515-1521` |
| **H-12** | S2 | **Add Assessment computes `nextNumber = length + 1`.** After removing #3 from [1,2,3,4], it proposes #4, which already exists; the backend returns 409 but the client has already appended it. | `ContractActionModals.tsx:167`; `AccountingContext.tsx:2574-2601` |
| **H-13** | S2 | **Action handlers report success before backend confirmation.** `cancel/activate/renew` are sync and immediately toast; `completeContractAssessment` does not await the backend call. | `PrintingContractsView.tsx:582-590`; `AccountingContext.tsx:2408-2415` |
| **M-09** | S3 | **Attachment upload hardcodes `entityId: 1`.** Contract files attach to contract #1, not the selected contract. | `PrintingContractsView.tsx:518-525`; `documentsService.ts:803` |
| **M-10** | S3 | **`refreshPrintingContractsFromBackend` refuses to clear an empty backend list** and discards all local-only contracts when the backend returns a non-empty list. Source-of-truth precedence is undefined. | `AccountingContext.tsx:699-707` |
| **M-11** | S3 | **Global refresh on every `ACCOUNTING_UPDATED_EVENT` can overwrite a newer optimistic state with an older snapshot.** | `AccountingContext.tsx:719-731` |
| **M-12** | S3 | **Wallet running balance is heuristic** (`amount > 0` = deposit) and starts from `totalPrepaidAmount`; it is not reconciled to `remainingBalance`. | `ContractInfoModals.tsx:537-565` |
| **M-13** | S3 | **`ContractInfoModal` reads `(contract as any).liabilityAccountId`,** which is not declared on `PrintingContract`. | `ContractActionModals.tsx:500`; `types/accounting.ts:199-219` |
| **L-01** | S4 | **`totalAssessments` is cast to `2|3|4|5` after `+1`** without a runtime guard. | `AccountingContext.tsx:2578` |
| **L-02** | S4 | **`customMismatch` tolerance is `0.05`** while amounts are 2-decimal; use an exact decimal comparison. | `PrintingContractsView.tsx:265` |
| **L-03** | S4 | **No empty state** when there are no contracts; the schedule section simply disappears. | `PrintingContractsView.tsx:810` |
| **L-04** | S4 | **History modal is synthesized client-side** and omits amend/cancel/activate/renew audit events. | `ContractActionModals.tsx:402-438` |

---

## 8. Documents / Invoice Integration Review

### 8.1 Strengths

- `documentsService` renders a full contract preview with milestones, costs (when permitted), and attachments.
- `generateWorkflowInvoice` supports `contract` and `contract_milestone` sources and links `linked_invoice_id` when `postgresContractId` + `postgresMilestoneNumber` are supplied.
- Attachments are tenant-isolated and support `printing_contract` entity type.

### 8.2 Defects

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **H-14** | S2 | **The contract preview's milestone invoice payload omits the Postgres link fields**, so the generated invoice is not written back to the milestone. | `documents.ts:416-440`; `documentsService.ts:1515-1521` |
| **H-15** | S2 | **Deposit invoice linkage is local-only.** There is no `deposit_invoice_id` on `printing_contracts`; a refresh loses it. | `types/accounting.ts:215-217`; `printingRecordsService.ts:515-536` |
| **M-14** | S3 | **`mapContractToPreviewModel` picks `nextPending` with `!a.linkedInvoiceId`;** after a backend refresh `linkedInvoiceId` is undefined even when `backendInvoiceId` is set, so an already-invoiced milestone can be offered again (mitigated only by the idempotency key). | `documents.ts:388`; `AccountingContext.tsx:644` |

---

## 9. Security, Tenancy and Permissions Review

### 9.1 Strengths

- RLS is enabled and forced on every printing table.
- Composite FKs prevent cross-company references.
- `rejectCrossCompanyParams` middleware rejects mismatched company IDs.
- Cost data is gated by `estimates:read_costs`; invoicing by `invoices:write`.
- Audit log is append-only and written for every contract mutation.

### 9.2 Gaps

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **M-15** | S3 | **No route-level rate limiting specific to financial contract endpoints.** Global production limits apply, but create/renew/complete should be stricter. | `app.ts:58-63` |
| **M-16** | S3 | **`printing:write` is granted to `ProductionManager` and `Bookkeeper`, but contract completion posts revenue.** A production manager can recognize revenue. Consider splitting `printing:write` into `printing:operate` and `printing:contracts:manage`, or require `journals:write`/`invoices:write` for completion. | `permissions.ts:147-190`, `226-256`; `printingRoutes.ts:560-582` |
| **L-05** | S4 | **Unknown 500 errors return the raw message** (see H-08). | `printingRoutes.ts:60` |

---

## 10. Test Coverage Review

### 10.1 What exists

- `tests/printing/paper-toner-calc.test.ts` — 18 tests covering paper, toner, workflows, and one integration case.
- `tests/documents/documents-and-invoicing.test.ts` — seeds a contract/milestone, checks preview, invoice generation with `postgresContractId`/`postgresMilestoneNumber`, and attachment isolation.
- `tests/db/migration-suite.ts` — concurrent milestone deduction at raw SQL level.

### 10.2 What is missing

| ID | Severity | Gap |
|---|---|---|
| **T-01** | S2 | No service-level test for `createPrintingContract` (validation, journal balance, assessment sum, number generation). |
| **T-02** | S2 | No test for `completeContractAssessment` (double-completion, idempotency, remaining-balance clamp, exhausted status, journal balance). |
| **T-03** | S2 | No test for cancel/activate/renew (settlement, idempotency, status guards). |
| **T-04** | S2 | No test for add/remove/update assessment (sum invariant, status guard, numbering after removal). |
| **T-05** | S2 | No test that exam batches reject cross-school contracts or out-of-range assessment numbers. |
| **T-06** | S3 | No test that contract creation writes a `bank_transactions` row. |
| **T-07** | S3 | No test for contract-number collision at 99+ or under concurrency. |
| **T-08** | S3 | No API-level RBAC test for contract completion (which role may recognize revenue). |
| **T-09** | S3 | No frontend/context test for refresh precedence and optimistic rollback. |

---

## 11. Findings Register (Consolidated)

### Critical (S1)

| ID | Title | Primary evidence |
|---|---|---|
| **C-01** | Assessment amounts are not required to sum to the prepaid total | `printingRecordsService.ts:124-131`, `960-963` |
| **C-02** | Contract creation is not idempotent and posts a deposit journal | `printingRecordsService.ts:142-161`; `printingRoutes.ts:328-348` |
| **C-03** | Cancel does not settle the remaining liability | `printingRecordsService.ts:622-642` |
| **C-04** | Renew posts a deposit journal without a real cash movement | `printingRecordsService.ts:673-705` |
| **C-05** | Contract number generation can collide permanently | `printingRecordsService.ts:135-140` |
| **C-06** | Deposit journal does not create a bank transaction | `accountingEngine.ts:1725-1795`; `printingRecordsService.ts:1042-1073` |
| **C-07** | Create/renew endpoints have no idempotency guard | `printingRoutes.ts:328-348`, `469-480` |
| **C-08** | Frontend turns backend rejection into a local ledger mutation | `AccountingContext.tsx:2176-2253` |
| **C-09** | All other contract mutations are optimistic and report false success | `AccountingContext.tsx:2265-2623` |

### High (S2)

| ID | Title | Primary evidence |
|---|---|---|
| **H-01** | Amend/update assessment do not lock the contract row | `printingRecordsService.ts:570-610`, `837-906` |
| **H-02** | Add/remove/update assessment do not require active status | `printingRecordsService.ts:791-906` |
| **H-03** | Exam batch can link a contract from another school or an out-of-range assessment | `printingRecordsService.ts:271-397` |
| **H-04** | Exam paper status transitions are unrestricted | `printingRecordsService.ts:1167-1206` |
| **H-05** | Date validation is regex-only; assessment dates are not range-checked | `printingRecordsService.ts:14-20` |
| **H-06** | `exam_batch_note` is dropped on add | `printingRecordsService.ts:750-771` |
| **H-07** | FK/date violations surface as 500 | `printingRoutes.ts:50-61` |
| **H-08** | Raw DB error messages are returned to clients | `printingRoutes.ts:54-60` |
| **H-09** | No top-up/additional deposit workflow | route inventory |
| **H-10** | API mapping drops deposit and milestone invoice links | `AccountingContext.tsx:612-646` |
| **H-11** | Milestone invoice generation is not linked to the milestone | `documents.ts:416-440` |
| **H-12** | Add Assessment numbering collides after removal | `ContractActionModals.tsx:167` |
| **H-13** | Action handlers report success before confirmation | `PrintingContractsView.tsx:582-590` |
| **H-14** | Contract preview milestone payload omits Postgres link fields | `documents.ts:416-440` |
| **H-15** | Deposit invoice linkage is local-only | `types/accounting.ts:215-217` |

### Medium (S3)

| ID | Title |
|---|---|
| **M-01** | N+1 milestone loading in list contracts |
| **M-02** | Liability/income account resolution can pick the wrong account |
| **M-03** | Completion date uses UTC and can be off by one day |
| **M-04** | Contract serialization omits `updatedAt` / `liabilityAccountId` typing |
| **M-05** | Milestone serialization omits invoice number |
| **M-06** | No pagination/filtering on list endpoints |
| **M-07** | No exam-batch list endpoint or contract filter |
| **M-08** | Exam batch does not validate the contract link |
| **M-09** | Attachment upload hardcodes `entityId: 1` |
| **M-10** | Refresh precedence between backend and local contracts is undefined |
| **M-11** | Global refresh can overwrite newer optimistic state |
| **M-12** | Wallet running balance is heuristic and unreconciled |
| **M-13** | `liabilityAccountId` read via `as any` |
| **M-14** | `nextPending` ignores `backendInvoiceId` |
| **M-15** | No contract-specific rate limiting |
| **M-16** | `printing:write` allows revenue recognition for non-finance roles |

### Low (S4)

| ID | Title |
|---|---|
| **L-01** | `totalAssessments` cast can exceed 5 at runtime |
| **L-02** | `customMismatch` tolerance too loose |
| **L-03** | No empty state |
| **L-04** | History modal omits audit events |
| **L-05** | Raw 500 message leak |
| **L-06** | No module-level documentation |
| **L-07** | `printing_estimates` and contract costing use different rounding modes |

---

## 12. Positive Findings (Keep)

1. **Tenant isolation is strong.** RLS forced, composite FKs, cross-company param rejection.
2. **Single posting engine.** All contract money movements go through `postJournalEntry` with balanced accrual/cash bases.
3. **Exact decimal arithmetic.** `parseDecimal4` / `formatDecimal4` use BigInt; generated columns prevent drift.
4. **Evidence-aware costing.** Paper/toner engines never invent calibration, yield, or coverage.
5. **Pricing/quantity separation.** Contract price and discounts never alter physical sheets or impressions (verified by tests).
6. **Audit coverage.** Every contract mutation writes an audit entry.
7. **Permission gating.** Cost visibility and invoicing are correctly separated.
8. **Concurrency on completion.** Contract + milestone are locked, and completion carries an idempotency key.

---

## 13. Perfection Scorecard

| Dimension | Current | Target | Gap driver |
|---|---:|---:|---|
| Schema & constraints | 82% | 99% | Missing settlement/invoice/cancel columns; no DB-level sum invariant |
| Financial correctness | 66% | 99.8% | C-01…C-09 |
| API robustness | 70% | 99% | Idempotency, error mapping, pagination, top-up |
| Frontend consistency | 58% | 99% | Dual-write, dropped links, false success, entityId |
| Document/invoice integration | 68% | 99% | H-10/H-11/H-14/H-15 |
| Security & tenancy | 90% | 99% | RBAC granularity, rate limits |
| Audit & observability | 80% | 99% | Missing cancellation/completion metadata, history endpoint |
| Test coverage | 42% | 99% | T-01…T-09 |
| **Overall** | **~73%** | **≥99.8%** | — |

**Path to 99.8%:** close all S1 + S2, then all S3, then add the test matrix in §14 of the plan. The last 0.2% is reserved for load/concurrency testing and a production shadow-run reconciliation.

---

## 14. Assumptions and Limitations

- This is a static audit. No test, build, migration, or runtime request was executed.
- The review assumes the existing `postJournalEntry` contract (balanced lines, period lock, idempotency) is correct; it was read but not fuzzed.
- `bank_transactions` is assumed to be a subledger that should mirror the bank-side journal lines. If the project intentionally treats it as a separate manual register, C-06 becomes a design decision rather than a defect — but the wallet UI still needs to read journal lines.
- Frontend behavior was inferred from `AccountingContext` and the views; no browser session was run.
- The "99.8%" target is treated as a measurable quality gate (all S1/S2 closed, all S3 closed, test matrix green, one clean migration, one reconciliation run with zero variance).

---

## 15. Appendix — File/Line Index

| Concern | Location |
|---|---|
| Contract schema | `db/migrations/0007_printing_production_exams_contracts.up.sql:118-202` |
| Exam batch/paper schema | `db/migrations/0007...up.sql:205-275` |
| Contract service | `src/server/services/printingRecordsService.ts:74-1244` |
| Contract routes | `src/server/routes/printingRoutes.ts:327-650` |
| Contract API client | `src/services/printingApi.ts:96-325` |
| Contract context | `src/context/AccountingContext.tsx:612-731`, `2128-2623` |
| Contracts view | `src/components/views/PrintingContractsView.tsx` |
| Contract modals | `src/components/modals/ContractActionModals.tsx` |
| Contract types | `src/types/accounting.ts:178-219` |
| Contract preview | `src/types/documents.ts:369-524` |
| Contract document service | `src/server/services/documentsService.ts:521-556`, `1155-1235`, `1515-1521` |
| Journal engine | `src/server/services/accountingEngine.ts:1523-1816` |
| Permissions | `src/server/permissions.ts:60-61`, `147-190`, `226-256` |
| Costing | `src/server/services/printingWorkflows.ts:653-696`, `paperCalc.ts`, `tonerCalc.ts` |