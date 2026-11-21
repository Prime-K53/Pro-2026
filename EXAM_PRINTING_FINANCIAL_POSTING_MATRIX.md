# EXAM_PRINTING_FINANCIAL_POSTING_MATRIX.md

**Module:** PRIME ERP — Examination Printing
**Phase:** 0 — Repository-First Baseline Audit
**Date:** 21 November 2026

This matrix distinguishes **confirmed accounting behaviour** (verified in code) from **pending Finance decisions** (D1/D2/D5). No account code below is invented; all confirmed codes are created by `ensureAccount`/`ensureByCode` in `src/server/services/commercialHelpers.ts` (5000 at :121, 1250 at :227, 5100 at :248-250) and are already used by existing code paths.

> **Do not implement any posting marked PENDING until Finance approves it.**

---

## 1. Confirmed account codes

| Code | Name | Type | Created by | Used today |
|---|---|---|---|---|
| 1010 | Operating Checking | Bank | seed COA (`db.ts:56`) | payments/deposits |
| 1100 | Accounts Receivable | AccountsReceivable | seed (`db.ts:57`) | invoices |
| 1200 | Inventory Asset | Inventory | seed (`db.ts:58`) | raw-material movements |
| 2000 | Accounts Payable | AccountsPayable | seed (`db.ts:61`) | bills |
| 2200 | Sales Tax Payable | OtherCurrentLiability | seed (`db.ts:64`) | tax |
| 2300 | Unearned Contract Retainers | OtherCurrentLiability | seed (`db.ts:65`) | contract funding |
| 4000 | Printing & Sales Revenue | Income | seed (`db.ts:70`) | invoices |
| 5000 | Cost of Goods Sold | CostOfGoodsSold | `commercialHelpers.ts:121` | WIP→COGS relief |
| 1250 | Work In Process (WIP) | (inventory-typed) | `commercialHelpers.ts:227-248` | material issue, conversion, relief |
| 5100 | Spoilage & Production Variance | (expense/variance) | `commercialHelpers.ts:248-250` | WIP write-off on cancellation |

No other exam-specific account exists. **D2 requires a new, Finance-approved variance account** — none exists today and none may be invented.

---

## 2. Confirmed posting behaviour (implemented)

Each posting is written through the shared `accountingEngine` (balanced journals, `journal_transactions` + `journal_lines`, immutable after post, idempotent via `journal_transactions.idempotency_key`). Amounts are `NUMERIC(19,4)` fixed-point; no floating point.

| # | Event | Debit | Credit | Posting site | Idempotency |
|---|---|---|---|---|---|
| C1 | Batch/paper creation | — | — | `createExamBatch` (`printingRecordsService.ts:1335`) | `exam_batch_create` (`request_keys`) |
| C2 | Material reservation | — | — | `reserveJobMaterials` (`productionService.ts:801`) | `job_reserve_${jobId}` |
| C3 | Material issuance | 1250 WIP | 1200 Inventory Asset (per raw item avg cost) | `issueJobMaterials` (`productionService.ts:1149`) | `wip-issue-...` / `job_issue_${jobId}` |
| C4 | Press conversion | 1250 WIP | applied labour/machine (configured) | `recordProductionOperation` (`productionService.ts:1595`) | **not keyed** (gap) |
| C5 | Finishing | 1250 WIP | consumables/labour (configured) | `recordFinishingOperation` (`productionService.ts:1800`) | **not keyed** (gap) |
| C6 | Material consumption/waste | — (usage quantities only; no separate GL beyond C3/C4) | — | `recordMaterialConsumptionAndWaste` (`productionService.ts:1201`) | **not keyed** (gap) |
| C7 | Material return | 1200 Inventory Asset | 1250 WIP | `returnUnusedMaterials` (`productionService.ts:1463`) | `job_return_${jobId}` |
| C8 | Completion / QC | — | — | `updateExamPaperStatus` (`printingRecordsService.ts:3480`) | none needed (no GL) |
| C9 | Delivery | — | — | `deliverExamPaper` (`printingRecordsService.ts:4435`) | none needed (no GL) |
| C10 | Invoice issuance | 1100 Accounts Receivable | 4000 Printing & Sales Revenue (+ 2200 tax) | `createInvoiceOrSalesReceipt` (`documentsService.ts` via `generateInvoiceFromWorkflow:1548`) | invoice `idempotencyKey` |
| C11 | Exam WIP→COGS relief | 5000 COGS | 1250 WIP | `linkExamPapersToInvoice` (`printingRecordsService.ts:4691-4697`) | `exam-cogs-{company}-{invoice}` |
| C12 | Customer payment | 1010 Bank | 1100 Accounts Receivable | existing payments service (not exams) | payment idempotency |
| C13 | Cancel (pre-dispatch) residual WIP write-off | 5100 Spoilage & Production Variance | 1250 WIP | `cancelPrintingJob` (`productionService.ts:2487-2493`) | job cancel route idempotency |
| C14 | Reprint | Normal production journals (new job) | Normal production journals | `createExamReprint` (`printingRecordsService.ts:3859`) → new job pipeline | `exam_reprint` (`request_keys`) |
| C15 | Contract retainer (if used) | 1010 Bank | 2300 Unearned Contract Retainers | `printingRecordsService.ts` contract funding | contract idempotency |

**Duplicate-posting controls (confirmed):**
- `request_keys` unique `(company_id, route, idempotency_key)` (`0001:190-201`).
- `uq_exam_invoice_links_paper` — one invoice link per paper (`0024:223`).
- `wip_cost_relieved = wip_cost_accumulated` invariant after relief; `ck_pjobs_qty_pipeline` (`0011:93-101`).
- Row locks `FOR UPDATE` on papers/jobs/inventory.

**Invariant:** after invoicing, `invoices.total_cost` is replaced with the exact `wipRelieved` (`printingRecordsService.ts:4710-4721`), so material cost is not double-counted between issue and COGS.

---

## 3. PENDING Finance decisions — do not implement until approved

### D1 — Short delivery / reprint loss treatment (PENDING)

The following are **not** yet posted and require the approved matrix:

| # | Event | Proposed treatment (pending approval) | Why pending |
|---|---|---|---|
| P-D1-a | Revenue recognition on short delivery | Recognise revenue only for **accepted delivered** quantity; never for undelivered/short quantity | Finance must confirm revenue basis = accepted learner quantity (not `copies`) |
| P-D1-b | Prime Printing-caused spoilage | Charge to a production-loss account (not to customer); separate from COGS | Finance must approve loss account + treatment |
| P-D1-c | Recoverable materials | Return to inventory at appropriate valuation (C7-like) | Finance/Inventory must confirm valuation |
| P-D1-d | Authorised write-off | Require authorised reason + audit record; prevent duplicate loss posting | Finance must define authority + dedupe key |
| P-D1-e | Reprints | Additional traceable cost; **no** automatic revenue; link to parent batch+reason; no duplicate loss | Finance must confirm no revenue on replacement |

Current code delivers QC-approved good copies and flags `shortDelivery` (`printingRecordsService.ts:4492-4530`), but **does not** yet compute accepted quantity or post a separate loss. Invoicing currently bills `paper.copies` (`:4674`) — **this must not change to accepted quantity until D1 is approved**, but the gap is recorded here.

### D2 — Toner/machine cost variance (PENDING)

| # | Item | Status |
|---|---|---|
| P-D2-account | Dedicated production cost variance account code + name | **Not defined — do not invent** |
| P-D2-method | Debit/credit posting method | Pending |
| P-D2-fav/unfav | Favourable vs unfavourable treatment | Pending |
| P-D2-timing | Immediate vs periodic posting | Pending |
| P-D2-threshold | Approval + materiality thresholds | Pending |
| P-D2-trace | Variance traced to paper/batch | Mechanism exists (`job_material_requirements`), posting does not |

`job_material_requirements` already carries planned vs actual (`0011:249-269`) and `productionService.ts:1289-1299` computes variance. **No variance posting occurs today** — correct, because no account is approved.

### D5 — Cancellation financial adjustments (PENDING, PROPOSED)

| # | Event | Status |
|---|---|---|
| P-D5-recon | Quantity reconciliation (ordered/produced/issued/consumed/delivered/remaining) before any adjustment | **Not implemented** — required gate |
| P-D5-recover | Recoverable-material identification + return | Partial (`returnUnusedMaterials`) but not orchestrated by cancellation |
| P-D5-loss | Unavoidable production loss calc + write-off | Partial (C13 residual WIP write-off exists); D5 requires full reconciliation first |
| P-D5-credit | Credit notes / refunds via authorised workflows | **Not implemented** — use existing credit-memo/refund services |
| P-D5-audit | Complete audit trail; no duplicate cancellation/adjustment | Partial (cancel blocks delivered/invoiced/dispatched; no duplicate-adjustment key) |

**Rule:** A cancellation status change must **not** automatically reverse inventory, issue refunds, post losses or modify invoices. All D5 financial adjustments are gated on completion of reconciliation and the five approvals in the Policy Register.

---

## 4. Segregation-of-duties note

- `exams:invoice` exists (`permissions.ts:85`) but is **not enforced**; exam invoicing is gated by `invoices:write` (`documentsRoutes.ts:144`). **Recommendation (Phase 6):** enforce `exams:invoice` on the exam invoice path so production roles cannot invoice. This is a control change, not an accounting change, but affects who can trigger C10/C11.
- Cancellation (`exams:cancel`) is granted to Administrator and Accountant only (`permissions.ts:192,325`) — consistent with D5 restricting cancellation to authorised roles.

---

## 5. Summary of what is safe to build now vs blocked

| Area | Safe to implement now | Blocked pending approval |
|---|---|---|
| Quantity model (ordered/produced/delivered/accepted/teacher/billable/planned) | ✅ (columns + tracking) | — |
| Teacher copies (D3) — production + delivery tracking, never invoiced | ✅ | — |
| Reprint linkage + reason + no-duplicate-allowance | ✅ | Revenue/loss treatment (P-D1-e) |
| Short-delivery quantity capture | ✅ | Revenue recognition basis (P-D1-a) |
| Variance computation + surfacing | ✅ | Variance posting account/method (P-D2) |
| Cancellation reconciliation mechanics | ✅ | Financial adjustments (P-D5) |
| Confidential content storage/authorisation | ✅ | Disposal timing (D4 Legal) |
| WIP/COGS/AR/revenue postings (C1–C15) | Already implemented; preserve | — |