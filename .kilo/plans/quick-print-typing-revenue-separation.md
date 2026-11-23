# Quick Photocopy / Quick Print — Typing & Printing Revenue Separation Fix

**Plan date:** 2026-11-22
**Scope:** Treat typing & printing as a service **revenue** component (not material cost) across the Quick Print desk, POS, invoice, and persisted job. No DB migration.

---

## 1. Root Cause (audited)

The DB schema `printing_jobs` (`db/migrations/0007_printing_production_exams_contracts.up.sql:300-302`) defines generated columns:

```sql
total_cost GENERATED ALWAYS AS (paper_cost + toner_cost + extra_cost) STORED
profit     GENERATED ALWAYS AS (manual_selling_price - (paper_cost + toner_cost + extra_cost)) STORED
```

These columns are **correct** once the invariant holds:
- `extra_cost` = genuine physical finishing only (staple/bind)
- `manual_selling_price` = complete customer-facing revenue (typing + photocopy)

The application code violates the invariant in four places:

| # | Location | Violation |
|---|---|---|
| 1 | `src/server/services/printingWorkflows.ts:603-605` | `calculateTypeAndPrintingWorkflow` adds `typingAmount` into `totalCostWithTypingAndExtra` (cost). |
| 2 | `src/utils/quickPrintCalc.ts:78-84` | `computeQuickPrintEstimate` folds `extraCostTotal` into `totalCost`; `typingRevenue=0`; `sellingPriceTotal` = photocopy-only. |
| 3 | `src/context/AccountingContext.tsx:1548-1549` | `addQuickPrintJob` sets `totalCost = paper+toner+combinedExtraCost`; `profit = sellingPriceTotal - totalCost` (typing excluded from revenue). |
| 4 | `src/server/services/productionService.ts:400-403, 540-546` | `createPrintingJob` stores `extra_cost = finishingCostPerPage * pages`; `manual_selling_price` from `manualSellingPricePerSheet * sheetsUsed` (photocopy-only). For `type_and_printing`, the typing rate is passed via `typingFeeMode/Rate` but never added to `manual_selling_price`. |

**Conclusion:** No migration needed. Fix the application code so `extra_cost` = physical finishing only and `manual_selling_price` = typing + photocopy. The generated columns then yield correct `total_cost` and `profit` automatically.

---

## 2. Approved Decisions (binding)

- **D-1** `manual_selling_price` = complete customer-facing selling amount (typing + photocopy).
- **D-2** `extra_cost` = genuine physical finishing expenses only (staple/bind). Never typing revenue.
- **D-3** `paper_cost`, `toner_cost` = material costs.
- **D-4** Typing revenue is **never** classified as production cost.
- **D-5** No dedicated typing-fee column; no DB migration.
- **D-6** Receipt/invoice shows **two lines**: Typing & Printing, Photocopying. Both reconcile with stored `manual_selling_price` and invoice/POS totals. No double-charging.
- **D-7** `quick_photocopy` `finishingCostPerPage` = genuine physical finishing (stays in `extra_cost`/cost). Not typing revenue. Not added to selling price unless an explicitly configured customer-facing finishing charge exists.
- **D-8** Preserve BigInt-based exact monetary calculations.
- **D-9** Preserve existing DB compatibility.
- **D-10 (verification)** `manual_selling_price` and `sellingPriceTotal` are the **same revenue figure** in two layers (DB vs local model). They must be **equal**, never summed. No aggregation may add them.
- **D-11 (verification)** Invoice conversion must **not** add typing revenue a second time: invoice line sum = `sellingPriceTotal` = `manual_selling_price`.
- **D-12 (verification)** Persisted profitability (`printing_jobs.profit` generated column) must be correct, not just the frontend preview.
- **D-13 (safety)** Preserve the existing dirty worktree. Do **not** run `git stash`, `git checkout`, `git reset`, `git clean`, or revert any file. Edit only the files listed in §5.

---

## 3. Acceptance Values (target, binding)

| Field | Expected |
|---|---|
| Selling price (typing + photocopy) | K2,450 |
| Material cost (paper + toner) | K120 |
| Finishing cost | K0 |
| Total cost | K120 |
| Gross profit | K2,330 |

Stored job after fix: `manual_selling_price=2450`, `paper_cost+toner_cost=120`, `extra_cost=0`, `total_cost=120`, `profit=2330`.

**Derivation (must hold in code):** typing = `rate × pages` = K2,000 (2 pages); photocopy = `rate × sheetsUsed` = K450 (3 sheets); `sellingPriceTotal = 2000 + 450 = 2450`; `totalCost = paper + toner + finishing(0) = 120`; `profit = 2450 − 120 = 2330`.

**Currency note:** The acceptance example uses "MK". The codebase uses `K` from `companyProfile.currency`. Numeric calculations are identical; currency symbol display is **out of scope**.

---

## 4. Audited Readers/Writers (complete)

### 4.1 `manual_selling_price` / `manualSellingPrice`
- **Writers:**
  - `productionService.ts:540-546` (`resolvedManualSelling`) — from `manualSellingPricePerSheet * sheetsUsed` or `manualSellingPrice`.
  - `productionService.ts:699` (`createPrintingJobFromEstimate`) — from estimate `subtotal`.
  - `printingRecordsService.ts:1335` — exam paper job (`manualSellingPrice: 0`, correct — exam revenue is separate).
  - `productionService.ts:2627` — controlled reprint (`0`, correct).
- **Readers:**
  - `productionService.ts:217` (`listPrintingJobs`) → `manualSellingPrice`.
  - `documentsService.ts:677` (documents list `amount`).
  - `documentsService.ts:1345` (printing_job preview `totalAmt`).
  - `operationalReports.ts:69,307` (`quoted_price`).
  - `printingApi.ts:76` (client job model).

### 4.2 `sellingPriceTotal` / `sellingPricePerSheet` (frontend QuickPrintJob model)
- **Writers:**
  - `quickPrintCalc.ts:83` (`computeQuickPrintEstimate`).
  - `AccountingContext.tsx:1543-1546` (`addQuickPrintJob`).
  - `QuickPrintView.tsx:184` (desk post).
- **Readers:**
  - `QuickPrintView.tsx:637,743,865,869` (UI display, KPI, history).
  - `QuickPrintJobModal.tsx:128,152,380,418` (modal preview).
  - `PosModal.tsx:296,398` (cart line `unitPrice`, job post `manualSellingPricePerSheet`).
  - `NewInvoiceModal.tsx:278,350-351` (invoice line `rate`, job post).
  - `documents.ts:709-717,754,771,773` (receipt mapper).
  - `AllDocumentsView.tsx:243` (documents list amount).

### 4.3 `extra_cost` / `extraCost`
- **Writers:**
  - `productionService.ts:400-403` (`extraCost` from `finishingCostPerPage * pages` or `finishingCost`).
  - `productionService.ts:588` (INSERT into `extra_cost`).
  - `AccountingContext.tsx:1486-1487,1726` (local job model `extraCostStored`).
- **Readers:**
  - `productionService.ts:215,739` (job model, budget default material).
  - `documents.ts:768` (`quickPrintMeta.extraCost`).
  - `QuickPrintView.tsx:859-860` (history `Ex:` annotation).
  - `printingApi.ts:74` (client job model).

---

## 5. Implementation Tasks

### Task 1 — Fix `calculateTypeAndPrintingWorkflow` (server workflow)
**File:** `src/server/services/printingWorkflows.ts`

- Line 603-605: Remove `+ typingAmount` from `totalCostWithTypingAndExtra`. Rename local to `totalProductionCost` = `paper + toner + finishingTotal` (finishing stays as real cost per D-7).
- Line 616-619: `realProfit = netRevenue + typingAmount - totalProductionCost`; `profitMarginPct` uses `netRevenue + typingAmount` as denominator.
- Line 631-645 (`commercial` return):
  - `totalProductionCost` = `totalProductionCost` (excludes typing).
  - Keep `typingFee: typingAmount` (now clearly a revenue component).
  - Add `typingRevenue: typingAmount` to `CommercialFinancialSummary` for explicit separation.
- Line 46-60: Add `typingRevenue: number` to `CommercialFinancialSummary` interface.
- `computeCommercialSummary` (line 100-145): Add `typingRevenue?: number` param defaulting to `0`; include in returned object. (Other workflows pass 0.)

### Task 2 — Fix `computeQuickPrintEstimate` (shared frontend calc)
**File:** `src/utils/quickPrintCalc.ts`

**Critical latent bug found:** Line 78 computes `extraCostTotal = safeExtraPerPage * impressionsUsed`, but both the server (`finishingCostPerPage * pages`) and the UI label ("per page × safePages", QuickPrintView:641) use **per-page**. For `copies > 1` the current code overcounts by `copies`. Fix to per-page.

**jobType branching (D-2, D-7):** `extraCostTotal` means typing revenue for `type_and_printing`, but finishing cost for `quick_photocopy`/`general_print`. Branch explicitly:

- Line 78: `extraCostTotal = round2(safeExtraPerPage * safePages)` (per typed/finished page, not per impression).
- Add:
  - `typingRevenue = jobType === 'type_and_printing' ? round2(extraCostTotal) : 0`
  - `finishingCost = jobType === 'type_and_printing' ? 0 : round2(extraCostTotal)`
- Line 79: `totalCost = round2(paperCost + tonerCost + finishingCost)` (typing excluded; finishing included per D-7).
- Line 81-83:
  - `photocopyRevenue = round2(safePricePerSheet * sheetsUsed)`
  - `sellingPriceTotal = round2(photocopyRevenue + typingRevenue)` (combined revenue).
- Line 84: `realProfit = round2(sellingPriceTotal - totalCost)`.
- Line 85: `profitMarginPct = sellingPriceTotal > 0 ? (realProfit / sellingPriceTotal) * 100 : 0`.
- Add `typingRevenue` and `finishingCost` to the `QuickPrintEstimate` interface (line 24-40); keep `extraCostTotal` for backward compat.
- `jobType` is already an input field (line 16) and a `useMemo` dependency in callers — no caller changes needed.

### Task 3 — Fix `addQuickPrintJob` (AccountingContext local model)
**File:** `src/context/AccountingContext.tsx` (lines 1478-1549, 1714-1734)

**Context:** This is the **QuickPrintView desk path** (local-only job + invoice). It must mirror the server's `printing_jobs` semantics exactly so the local preview equals persisted profitability (D-12).

**jobType branching (mirror Task 2 and server):**
- Line 1482-1485: `combinedExtraCost` = `resolvedExtraPerPage * safePages` (per-page, already correct here — uses `safePages`, unlike the buggy `computeQuickPrintEstimate`).
- Line 1486-1487: `typingFeeStored`/`extraCostStored` (unchanged — typing for `type_and_printing`, finishing for others).
- Add:
  - `typingRevenue = jobData.jobType === 'type_and_printing' ? round2(combinedExtraCost) : 0`
  - `finishingCost = jobData.jobType === 'type_and_printing' ? 0 : round2(combinedExtraCost)`
- Line 1548: `totalCost = round2(paperCost + tonerCost + finishingCost)` (typing excluded; finishing included per D-7).
- Line 1537-1546: `resolvedSellingPerSheet` = photocopy rate. Compute:
  - `photocopyRevenue = round2(resolvedSellingPerSheet * sheetsUsed)`
  - `resolvedSellingPriceTotal = round2(photocopyRevenue + typingRevenue)` (combined revenue).
- Line 1549: `profit = round2(resolvedSellingPriceTotal - totalCost)` (typing already in revenue; finishing already in cost).
- Line 1728-1729: Store `sellingPriceTotal: resolvedSellingPriceTotal` (combined), `typingFee: typingFeeStored`.
- Invoice/cash lines (1579-1645, 1649-1708): `resolvedSellingPriceTotal` is now combined — bank/sales postings use it as revenue (correct). `materialCogs` (line 1550) = `paper+toner` (correct; finishing is not COGS here — it stays in job `totalCost` but the cash COGS posting uses material only, matching existing behavior).
- Line 1585 (`lineUnitCost`): `totalCost / sheetsUsed` — now correct (paper+toner+finishing per sheet). COGS posting uses `materialCogs` (paper+toner), not `totalCost`.

**Invariant (D-10):** `created.sellingPriceTotal` is the single revenue figure. Do **not** add `manual_selling_price` (no server job on this path) or `typingFee` on top of it.

### Task 4 — Fix `createPrintingJob` (server production service)
**File:** `src/server/services/productionService.ts`

**Goal:** Persist `manual_selling_price` = photocopy + typing (D-1), while `extra_cost` stays physical finishing only (D-2). The DB generated columns `total_cost`/`profit` (migration 0007:300-302) then compute correctly with no schema change.

**Changes:**
1. Line 400: alongside `let extraCost = ...`, add `let typingAmount = 0;` (typing revenue accumulator).
2. In the `type_and_printing` branch, after line 438 (`tonerCost = ...`), add:
   `typingAmount = wf.typingFee.amount;` (from `calculateTypeAndPrintingWorkflow` result; `wf` is in scope).
3. Lines 540-546: restructure `resolvedManualSelling`/`manualSelling4` with a **double-count guard** (D-10):
   - `const photocopySelling = input.manualSellingPricePerSheet !== undefined ? Math.round(Number(input.manualSellingPricePerSheet) * sheetsUsed * 100) / 100 : Number(input.manualSellingPrice ?? 0);`
   - `const manualSelling4 = input.reprintOfJobId ? 0n : parseDecimal4(input.manualSellingPricePerSheet !== undefined ? photocopySelling + typingAmount : photocopySelling);`
   - **Rationale:** When `manualSellingPricePerSheet` is provided (desk/POS path), add typing on top of photocopy. When only `manualSellingPrice` is provided (estimate path), treat it as already-complete and do **not** add typing — avoids double-counting (D-10).
4. Line 588 (`extra_cost` INSERT): unchanged — `extraCost` is physical finishing only (D-2/D-7).
5. `paper_cost`/`toner_cost` INSERT (lines 586-587): unchanged.
6. **No change** to generated columns `total_cost`/`profit` — DB computes them.
7. `createPrintingJobFromEstimate` (line 699): `manualSellingPrice: est.subtotal` — no `manualSellingPricePerSheet`, so typing is **not** added (estimate path unchanged, out of scope). Verify no regression.

**Result:** For a `type_and_printing` desk job (2 pages, 3 sheets, rate 150/sheet, typing 1000/page):
`photocopySelling = 150*3 = 450`, `typingAmount = 1000*2 = 2000`, `manual_selling_price = 2450`, `extra_cost = 0`, `total_cost = paper+toner = 120`, `profit = 2330`. ✓

### Task 5 — Update `QuickPrintView` UI
**File:** `src/components/views/QuickPrintView.tsx`

- Lines 711-765 (cost summary panel):
  - "Paper" and "Toner" lines unchanged.
  - Lines 725-732: Relabel "Extra Typing / Finishing" → "Typing & Printing Charge"; **remove from cost subtotal**. Present as a revenue line.
  - Line 734-737: "Total Calculated Cost" = `paperCost + tonerCost` only.
  - Add "Photocopy Revenue (N shts × rate)" line = `photocopyRevenue`.
  - Add "Typing Revenue (N pp × rate)" line = `typingRevenue`.
  - Line 739-744: "Selling Price" → "Total Revenue" = `sellingPriceTotal` (combined).
  - Line 746-765: "Real Job Profit" = `realProfit` (now correct).
- Lines 631-645 (desk rates info box): Typing charge shown as `+ typing ... = revenue` (clarify).
- Lines 420-488 (KPI strip): "Desk Revenue" uses `totalRevenue` (now includes typing since `sellingPriceTotal` is combined). "Paper & Toner Cost" uses `totalMaterialAndExtra` — verify it sums `job.totalCost` (now paper+toner+finishing, no typing). Update label to "Material & Finishing Cost" if needed.
- Lines 855-863 (history table): `job.totalCost` now excludes typing; `Ex:` annotation shows typing as informational revenue. Update `Ex:` label to `Typing:` for clarity.

### Task 6 — Update `QuickPrintJobModal` UI
**File:** `src/components/modals/QuickPrintJobModal.tsx`

- Lines 339-411 (preview panel):
  - "Paper" and "Toner" unchanged.
  - Lines 363-372: Relabel "Extra (N pp)" → "Typing & Printing"; present as revenue, not cost.
  - Line 373-376: "Total cost" = `paperCost + tonerCost` only.
  - Add "Photocopy Revenue" line = `photocopyRevenue`.
  - Add "Typing Revenue" line = `typingRevenue`.
  - Line 377-382: "Line amount" → "Total Revenue" = `sellingPriceTotal` (combined).
  - Line 383-394: "Margin" = `realProfit` (correct).
- Line 418 (footer): `sellingPriceTotal` now combined — correct.

### Task 7 — Update POS / NewInvoiceModal job posting
**Files:** `src/components/modals/PosModal.tsx`, `src/components/modals/NewInvoiceModal.tsx`

- **PosModal.tsx:386-402:** Currently sends `typingFeeMode: 'per_page'`, `typingFeeRate: draft.extraCostPerPage`, `manualSellingPricePerSheet: draft.sellingPricePerSheet`. The server (Task 4) now adds typing to `manual_selling_price`. **No change to payload** — but verify `manualSellingPricePerSheet` is photocopy-only (it is, from `companyProfile.manualSellingPricePerSheet`).
- **PosModal.tsx:296:** Cart line `unitPrice: draft.estimate.sellingPriceTotal` — now combined revenue (correct, since `computeQuickPrintEstimate` returns combined). POS cart shows single combined line; the POS receipt (if rendered via `mapQuickPrintToPreviewModel`) splits into two.
- **NewInvoiceModal.tsx:278:** Invoice line `rate: draft.estimate.sellingPriceTotal` — now combined (correct).
- **NewInvoiceModal.tsx:350-351:** `manualSellingPricePerSheet` discounted — stays photocopy-only rate; server adds typing. Verify discount applies only to photocopy rate (acceptable — typing is a fixed service charge).
- **Both:** The invoice `lines` payload (POS `cart.map` at line 411-418; Invoice `payloadLines` at 360-369) carries a **single combined line** per quick-print job. This is correct: the invoice total = `sellingPriceTotal` = `manual_selling_price`. The **two-line split (D-6)** is a **display** concern implemented in the receipt preview (Task 8) and the `generateInvoiceInput.lines` path (Task 8), not the POS/Invoice modal cart. Splitting the POS cart into two lines would double the line count and complicate tender/discount allocation; the single combined line reconciles exactly with the job's `manual_selling_price`.

### Task 8 — Update receipt mapper (two-line split)
**File:** `src/types/documents.ts` (lines 749-776, `mapQuickPrintToPreviewModel`)

- Replace single `lines` entry with two lines when typing > 0:
  - Line 1: `description: 'Typing & Printing'`, `quantity: job.pages`, `rate: typingRate` (= `typingRevenue / job.pages`), `amount: typingRevenue`.
  - Line 2: `description: 'Photocopying'`, `quantity: job.sheetsUsed`, `rate: job.sellingPricePerSheet`, `amount: photocopyRevenue`.
- When typing = 0, keep single photocopy line (backward compat).
- Compute `photocopyRevenue = round2(job.sellingPricePerSheet * job.sheetsUsed)`, `typingRevenue = round2((job.typingFee || 0) + (job.extraCost || 0))`. Verify `photocopyRevenue + typingRevenue === job.sellingPriceTotal` (combined).
- Line 770-776 (`totals`): `subtotal`/`total` = `job.sellingPriceTotal` (combined, unchanged). `totalCost` = `job.totalCost` (paper+toner+finishing). `grossProfit` = `job.profit`.
- Line 768 (`quickPrintMeta.extraCost`): Keep as `(job.typingFee || 0) + (job.extraCost || 0)` — informational. Add `quickPrintMeta.typingRevenue` and `quickPrintMeta.photocopyRevenue` fields (update type at line 206-216).
- `generateInvoiceInput.lines` (lines 806-814): **Split into two lines here too** so the backend invoice matches the receipt. The `generateAndSyncWorkflowInvoice` flow (QuickPrintView `handleGenerateJobInvoice`, AccountingContext `addQuickPrintJob`) posts these lines to `/api/documents/generate-invoice`, which persists them as `invoice_lines`. Two lines sum to `sellingPriceTotal` = `manual_selling_price`; no double-charging. Each line's `unitCost` = `totalCost` allocated proportionally (or 0 for typing line, full `totalCost` for photocopy line — typing has no material cost). **Recommendation:** typing line `unitCost: 0`; photocopy line `unitCost: job.totalCost`.

### Task 9 — Update `documentsService.ts` printing_job preview (single combined line)
**File:** `src/server/services/documentsService.ts` (lines 1335-1382)

- **Constraint:** The `printing_jobs` DB row stores only combined `manual_selling_price` and `total_cost`. It does **not** store `sellingPricePerSheet` or `typingFee` separately (no migration per D-5). The backend preview therefore **cannot** split into two lines without the per-sheet rate.
- **Decision:** Backend `documentsService` preview keeps a **single combined line** (`totalAmt` = `manual_selling_price`). This is the persisted-job view and must reconcile with the DB.
- The **two-line split (D-6)** is implemented in the **frontend** `mapQuickPrintToPreviewModel` (Task 8), which has `job.sellingPricePerSheet` and `job.typingFee` in the local `QuickPrintJob` model. The frontend receipt and the frontend-built `generateInvoiceInput.lines` both split into two lines; their sum equals `sellingPriceTotal` = `manual_selling_price` = backend `totalAmt`. Reconciliation holds.
- Lines 1345-1375: `totalAmt` = `manual_selling_price` (combined, correct). `totalCost` = `total_cost` (paper+toner+finishing, correct). `grossProfit` = `totalAmt - totalCost` (correct). **No change** except verifying the values are now correct post-Task-4.

### Task 10 — Update `quickPrintMeta` type
**File:** `src/types/documents.ts` (lines 206-216)

- Add `typingRevenue?: number` and `photocopyRevenue?: number` to `quickPrintMeta`.

### Task 11 — Regression tests
**File:** `tests/printing/paper-toner-calc.test.ts`

- Lines 781: Update `totalProductionCost` expectation from `33.18` to `8.18` (`2.70 + 0.48 + 5`, typing excluded). Add assertion `flatJob.commercial.typingRevenue === 25`.
- Lines 1169-1172: `quick_photocopy` with `finishingCostPerPage: 2.0` — `extraCost=20` stays (physical finishing). `totalCost=33.75` stays. `profit=153.75` stays. **No change** — this is `quick_photocopy`, not `type_and_printing`; finishing is real cost per D-7.
- Add new test cases:
  - **Typing-only job:** `type_and_printing`, 5 pages, 1 copy, duplex, typing rate 400/page, selling 0 → `typingRevenue = 2000`, `photocopyRevenue = 0`, `totalCost = paper+toner`, `profit = 2000 - cost`.
  - **Photocopy-only job:** `quick_photocopy`, 10 pages, 25 copies, no finishing → `typingRevenue = 0`, `totalCost = paper+toner`, `profit = photocopy - cost`.
  - **Combined job (acceptance example, §3):** `type_and_printing`, 2 pages, 3 sheets, typing 1000/page, photocopy 150/sheet, paper+toner 120 → `manual_selling_price=2450`, `total_cost=120`, `profit=2330`, `extra_cost=0`.
  - **Per-page typing (not per-impression):** `type_and_printing`, 2 pages, 10 copies, typing 1000/page → `typingFee.amount = 2000` (NOT `2000*10=20000`). Proves Task 2/4 per-page fix.
  - **Duplex vs simplex sheet calc (D-9):** `sheetsUsed` duplex = `ceil(pages/2)*copies`, simplex = `pages*copies`, independent of typing/finishing.

**File:** `tests/printing/quick-print-desk-posting.test.ts`

- Verify `quick_photocopy` job (no typing) still passes — `job.totalCost`, `job.profit`, WIP relief.
- Add `type_and_printing` variant: post job with `typingFeeMode: 'per_page'`, `typingFeeRate`, `manualSellingPricePerSheet` — verify:
  - `job.manualSellingPrice = photocopy + typing` (D-1).
  - `job.totalCost = paper+toner+finishing` (no typing, D-4).
  - `job.profit = manualSellingPrice - totalCost` (D-12).
  - `job.extraCost = 0` (no finishing for this job).
  - Invoice total = `job.manualSellingPrice` (no double, D-11).

**New test file:** `tests/printing/quick-print-typing-revenue.test.ts` (or extend `quick-print-desk-posting.test.ts`) covering Task V1-V3 end-to-end, including the exact acceptance example from §3.

### Task 12 — Verify quotation → job → POS → invoice reconciliation
- Trace `createPrintingJobFromEstimate` (line 665-701): `manualSellingPrice = est.subtotal` — if estimate includes typing, subtotal is combined (correct). If estimate is photocopy-only, job `manual_selling_price` is photocopy-only (typing not added). **Verify:** estimates for `type_and_printing` must include typing in `subtotal`, or the job creation must add it. Since estimates are a separate flow (not Quick Print desk), and the bug report is about the desk, **scope this task to the desk/POS/invoice path**. Note the estimate path as out-of-scope but verify no regression.

---

## 6. Verification Tasks (requirements 5-8, binding)

### Task V1 — Prove no double-counting of revenue (D-10)
- **Static audit:** Confirm no code path computes `manual_selling_price + sellingPriceTotal` or `manualSellingPrice + sellingPriceTotal`. Grep results show the two are used in **separate layers** (server DB vs local model) and never summed.
- **Test:** Post a `type_and_printing` job via `postQuickPrintJob` (POS path). Assert:
  - `job.manualSellingPrice === 2450` (photocopy 450 + typing 2000).
  - `job.totalCost === 120` (paper+toner, no typing).
  - `job.profit === 2330`.
  - `job.extraCost === 0` (no finishing).
- **Test (local path):** Call `addQuickPrintJob` (desk path) with the same inputs. Assert `created.sellingPriceTotal === 2450`, `created.totalCost === 120`, `created.profit === 2330`, `created.typingFee === 2000`, `created.extraCost === 0`.

### Task V2 — Prove invoice conversion does not add typing twice (D-11)
- **Test:** From the posted `type_and_printing` job, call `generateAndSyncWorkflowInvoice` (or the `/api/documents/generate-invoice` endpoint) with `generateInvoiceInput`. Assert:
  - Invoice `lines` = two lines: typing (2000) + photocopy (450).
  - `invoice.total === 2450` (=== `job.manualSellingPrice`, NOT `2450 + 2450`).
  - `invoice.total_cost === 120` (WIP relieved once).
- **Test (link path):** `linkQuickPrintJobToInvoice` — assert it updates `invoice.total_cost` only (COGS relief), never `invoice.total` (revenue untouched).

### Task V3 — Prove persisted profitability (D-12)
- **Test:** After posting via `postQuickPrintJob`, re-fetch the job from the server (`GET /api/printing/jobs/:id`). Assert the **persisted** generated columns:
  - `total_cost === 120`, `profit === 2330`, `manual_selling_price === 2450`.
- **Test:** After invoicing, re-fetch job and invoice. Assert `job.wipCostAccumulated === job.wipCostRelieved` (WIP fully relieved) and `invoice.grossProfit === 2330` (revenue 2450 − COGS 120).
- **Acceptance test:** Reproduce the exact acceptance example (2 pages, 3 sheets, typing 2000, photocopy 450, paper+toner 120) end-to-end and assert all five acceptance values from §3.

### Task V4 — Preserve dirty worktree (D-13)
- Do **not** run `git stash`, `git checkout`, `git reset`, `git clean`, `git restore`, or any command that reverts files.
- Edit **only** the files listed in §5. Do not reformat or touch unrelated modified files (the worktree has ~70 modified + many untracked files).
- Do not create new top-level files except the test files in Task 11.
- Do not stage or commit anything (user has not requested it).

---

## 7. Execution Order

1. Task 1 (server workflow) — foundation for typing revenue separation.
2. Task 2 (frontend calc) — shared by all desk/POS/invoice modals; fixes per-page bug + jobType branching.
3. Task 4 (server job creation) — persist combined `manual_selling_price`.
4. Task 3 (AccountingContext local model) — local job model + cash/invoice postings.
5. Task 5 (QuickPrintView UI).
6. Task 6 (QuickPrintJobModal UI).
7. Task 7 (POS/Invoice job posting).
8. Task 8 (receipt mapper two-line split).
9. Task 9 (documentsService preview).
10. Task 10 (types).
11. Task 11 (regression tests).
12. Task 12 (reconciliation verification).
13. Task V1-V4 (binding verification: no double-count, invoice no double, persisted profit, worktree safety).

---

## 8. Risk & Validation

- **No migration:** All changes are application-layer. Generated columns `total_cost`/`profit` auto-correct once `extra_cost`/`manual_selling_price` are populated correctly.
- **Per-page fix risk:** `computeQuickPrintEstimate` `extraCostTotal` changes from per-impression to per-page. No existing test pins this (verified: no test imports `computeQuickPrintEstimate`). The server already uses per-page (`finishingCostPerPage * pages`, `typingFee * typedPages`), so this aligns frontend with server.
- **Backward compat:** Existing jobs with typing in `extra_cost` will have wrong `profit` until re-posted. **Decision:** No data backfill (would require migration). New jobs correct; historical jobs show legacy values.
- **BigInt exactness:** Server uses `parseDecimal4`/`formatDecimal4`. Frontend uses `round2` on JS numbers (existing pattern). No precision loss.
- **Double-charging (D-10/D-11):** Verified by Task V1/V2 — `manual_selling_price` and `sellingPriceTotal` are equal (never summed); invoice lines sum to `sellingPriceTotal` (never added to `manual_selling_price` again).
- **Worktree safety (D-13):** Task V4 — no git mutations, no unrelated file edits.
- **Validation:** Run `npm run test:printing`, `npm run test:documents`, `npm run test:workflows`, `npm run lint`.

---

## 9. Out of Scope

- Printing estimates (`printing_estimates`) typing handling — separate flow, verify no regression only.
- Exam paper / contract jobs — `manualSellingPrice` semantics differ (exam revenue separate), not affected.
- Historical data backfill — no migration.
- DB schema changes — rejected per D-5/D-9.
- Currency symbol display (MK vs K) — separate concern, not expanded.