# Quick Photocopy, Type & Printing Desk — End-to-End Gap Analysis

## Status (closed)

| Gap | Closed by |
| --- | --- |
| 1 — workspace posts local ledger effects | Desk now calls `POST /api/printing/quick-jobs` → `postQuickPrintJob` (job + budget approval + material issue to WIP). No local `onHand` decrement, no local journal. |
| 2 — no quick-print WIP→COGS relief | `linkQuickPrintJobToInvoice` relieves WIP to COGS once, adjusts `invoices.total_cost`, and is invoked by `generateInvoiceFromWorkflow` (`sourceKind: 'quick_print'`) and by `POST /api/printing/jobs/:id/invoice-link`. |
| 3 — counter vs invoiced paths diverge | One production posting; billing differs only by `isSalesReceipt` (cash) vs invoice (A/R). Both go through the ledger engine. |
| 4 — weaker desk cost basis | Desk, invoice modal and POS all price through `computeQuickPrintEstimate` (shared `printingWorkflows` engines); the server recomputes with `paperCalc`/`tonerCalc` and its result is authoritative. |
| 5 — COA mismatch | Desk cost now posts to the workflow accounts (`wip1250`, `cogs5000`) server-side; the local `1300`/`5010` quick-print postings are gone. |
| 6 — no ownership decision | Decided: the desk job *is* a server `printing_jobs` record (`QuickPrintJob.backendJobId`); the workspace list is a projection of it. |

## What "correct principles" means here
Judgment is against double-entry inventory/production accounting, not against the current
browser implementation as-is. The relevant principles are:

- Physical consumption and selling price are separate concerns. Material used is a movement
  event; revenue is a billing event; the two are linked but not conflated.
- Inventory movement must be a controlled, attributable event (issue / consume / return) with
  a real cost basis, not a local `onHand` decrement computed in the browser from a
  possibly-stale unit cost.
- Each billable production job should carry cost as it accumulates (WIP), then relieve that
  WIP to COGS when the invoice is raised. The invoice itself should not re-deduct raw
  inventory, and it should not invent its own COGS.
- The same desk workflow should produce the same ledger effect whether it is billed to a
  customer or sold over the counter for cash.
- A journal is posted through the ledger engine, not simulated locally with ad-hoc account
  balance edits.
- Cost evidence is tiered: a real rating/calibration is better than a yield estimate; a yield
  estimate is better than an invented per-impression unit cost.

The main comparison anchor is the server `quick_photocopy`/`type_and_printing`/`general_print`
path already built in `createPrintingJob` / `issueJobMaterials` /
`recordMaterialConsumptionAndWaste` / `invoiceJobDelivered`, and the exam contrast in
`linkExamPapersToInvoice`.

---

## Gap 1 — Workspace posts local ledger effects instead of using the authoritative server path

**Evidence**
- `AccountingContext.tsx:addQuickPrintJob` decrements local stock directly:
  `setInventoryItems(... item.onHand: Math.max(0, round4(item.onHand - sheetsUsed / factor))` for paper
  and `round4(item.onHand - impressionsUsed / factor)` for toner.
- Invoice branch (when `createInvoice && customerId`) posts A/R, Sales and COGS locally through
  workspace `addInvoice`, with the comment
  `"Pass custom line (no itemId) so addInvoice posts A/R, Sales & COGS without double-deducting raw materials"`.
- Counter-sale branch mutates account balances directly by code (`defaultBankAccountId`, `4010`,
  `5010`, `1300`) and posts a local `JournalEntry` with `source: 'quick_print'`.

**Why it is a gap**
- The browser is simulating both the inventory movement and the books. The server already has the
  authoritative mechanisms: `inventory_movements` for stock, and `production_wip` / `production_cogs`
  journals for the cost side.
- Local COGS is computed from the grid's `getRawUsageUnitCost` (per-usage-unit cost), which is a
  simpler basis than the server cost engine. The result can disagree with the server's
  `getEffectivePurchaseUnitCost6` + rated-yield cost basis.
- There is no server `printing_job` record created for a desk job in the current flow, so the desk
  job is not entering the same production/costing ledger as the rest of printing.

**Fix direction**
- Make the desk create a real server `printing_jobs` row for `quick_photocopy`/`type_and_printing`/`general_print`
  through `createPrintingJob`, and let that be the cost record of record.
- Let the server post the inventory movement (`job_material_requirements` + issue/consume or a direct
  `printing_job` consumption path) and the WIP journal. Do not re-post COGS locally.
- Keep the workspace UI for entry and preview, but make it drive the server path; mirror the server
  state back to the workspace rather than maintaining a parallel books.

---

## Gap 2 — Quick print invoicing creates the invoice but does not relieve WIP or post COGS on the server

**Evidence**
- `generateInvoiceFromWorkflow` handles `sourceKind: 'quick_print'`, creates the invoice, and can
  set `printing_jobs.invoice_id` when `postgresPrintingJobId` is supplied.
- Unlike `exam_batch`, the `quick_print` branch does not perform a WIP→COGS relief step. In the
  exam path, `linkExamPapersToInvoice` posts an `exam_production` journal debiting COGS and crediting
  WIP, then adjusts `invoices.total_cost` to the exact relief so gross profit is not doubled.
- The production path `invoiceJobDelivered` does the analogous WIP→COGS relief with a `production_cogs`
  journal and invoices total_cost adjustment.

**Why it is a gap**
- A quick-print invoice can be linked to a printing job, but the server currently has no quick-print
  WIP-relief journal. That means the job's cost is not moved out of WIP into COGS through the ledger
  at invoice time.
- If the desk also posts local COGS, you end up with two different COGS stories: one local, one absent
  or partial server-side. That breaks cost/invoice consistency.
- Item-less invoice lines (which is what quick print uses) are exactly the lines that should be paired
  with a WIP-relief journal. The exam and production code already document that intent explicitly; the
  quick_print path has the invoice but not the counterpart relief.

**Fix direction**
- Add a quick-print WIP→COGS relief step in `generateInvoiceFromWorkflow` (or a dedicated quick-print
  invoice handler) when the job has accumulated production cost. Mirror the `production_cogs` pattern:
  debit COGS, credit WIP, tie the journal to the invoice, and set invoice total_cost to the actual
  relieved cost rather than a locally recomputed one.
- If quick print is meant to be first-class production work, route it through the same WIP lifecycle
  (issue/consume → accumulate → relieve at invoice) rather than inventing a separate cost story.

---

## Gap 3 — Counter-sale and invoiced paths are not two outputs of one consistent production posting

**Evidence**
- The desk treats "invoice" and "cash/counter" as two separate posting styles inside
  `addQuickPrintJob`.
- The counter-sale branch posts a `JournalEntry` with `source: 'quick_print'` but also edits account
  balances directly. That entry is local only; it is not run through server `postJournalEntry`.
- The same physical job posting is therefore represented differently depending on payment mode,
  instead of one production posting plus one revenue recognition method.

**Why it is a gap**
- A counter sale is still revenue and still material consumption. The correct split is:
  revenue recognized (A/R vs cash/bank) on the billing side, and material moved to WIP/COGS on the
  production side. Those two dimensions should not be merged into a single local cash journal.
- Posting a local `quick_print` journal alongside direct balance edits duplicates logic and makes the
  ledger's balanced-journal enforcement irrelevant for these records.

**Fix direction**
- Unify on one server production posting for the job, and treat counter sale as a cash/bank revenue
  posting (or sales receipt) on top of that, not as a separate cost calculation.
- If a local fallback is ever needed when the server is unreachable, keep it strictly as a temporary
  workspace projection and make clear it is not the ledger. Better: choose one system of record and
  let the other be a read model.

---

## Gap 4 — Cost basis on the desk is weaker than the server cost evidence tier

**Evidence**
- Desk `addQuickPrintJob` fallback cost:
  - paper: `round2(sheetsUsed * paperUnitCost)`
  - toner: `round2(impressionsUsed * tonerUnitCost)`
  where `paperUnitCost`/`tonerUnitCost` come from `getRawUsageUnitCost`.
- Desk live preview in `QuickPrintView.tsx` can use the shared engines when both paper and toner
  material items exist; when they do not, it falls back to `estSheets * paperUnitCost` and
  `estImpressions * tonerUnitCost`.
- Server `createPrintingJob` uses `getEffectivePurchaseUnitCost6`, `conversion_factor`, and when no
  machine is selected it prefers `material_specifications.yield_per_purchase_unit`, then
  `conversion_factor` only if it is > 1, and only falls back to a 10,000-impression default.

**Why it is a gap**
- The desk treats conversion factor as a simple divisor for both paper and toner, while the server
  treats toner yield more carefully and distinguishes "1 cartridge = 1 cartridge" from a real
  impressions-per-cartridge yield.
- The desk's fallback means a quick-print job can be costed with an implied per-impression toner cost
  even when no real yield rating exists. The server is more conservative: it defaults only when no
  better evidence is available, and marks the result as estimated.

**Fix direction**
- Align the desk preview/entry cost basis with the server engines (`paperCalc.ts` + `tonerCalc.ts`),
  including their evidence tiers and fallback policy, rather than inventing a separate per-impression
  rule.
- If the desk must cost offline, include the same "this is estimated because the rating/yield is missing"
  signal rather than silently producing a cost that looks exact.

---

## Gap 5 — Chart-of-accounts mismatch between desk and server workflow posting

**Evidence**
- Workspace counter-sale comments and `addInvoice` COGS path use `1300 Inventory Asset` and `5010 Raw
  Materials & Metals COGS`.
- Server workflow posting uses `wip1250`, `cogs5000`, `spoilageVariance5100`, `machineOverhead6310`
  as resolved workflow accounts, and `1200 Inventory` for the asset side of the issue journal.

**Why it is a gap**
- If the desk were moved onto the server posting path, the account set would need to be consistent.
- Mixing workspace account codes with server workflow accounts creates confusion about which COGS and
  inventory accounts are authoritative for printing production.

**Fix direction**
- Reconcile the COA mapping for quick-print production so the same accounts are used whether the desk
  posts locally (if it ever does) or the server posts. Prefer the server workflow accounts if quick
  print becomes a first-class production job.

---

## Gap 6 — No clear ownership decision: is the desk a server production workflow or a workspace shortcut?

**Evidence**
- `printing_jobs` already supports `quick_photocopy`, `type_and_printing`, `general_print`.
- The desk uses a workspace `QuickPrintJob` type with its own `invoiceId`, `backendInvoiceId`,
  `linkedInvoiceNumber`, `paperCost`, `tonerCost`, `totalCost`, `profit`.
- The desk can call `generateWorkflowInvoice({ sourceKind: 'quick_print', ... })` and link an invoice,
  but the underlying server side has not shown a quick-print WIP/COGS/material-issue path comparable to
  the exam and production flows.

**Why it is a gap**
- The system currently speaks two languages for the same business: a workspace "quick print job" and a
  server "printing job". Without a decision on which owns cost and consumption, the desk will keep
  inventing local ledger effects and the server will not have the matching production ledger entries.
- That makes job history, COGS reporting, and invoice-margin reporting unreliable for this desk in
  particular.

**Fix direction**
- Decide the desk is either:
  - a server production workflow (preferred if it must reconcile to inventory and COGS), in which case
    the desk should create/post through `createPrintingJob` + material issue/consume + invoice with
    WIP relief, or
  - a workspace convenience layer with a clearly documented reconciliation step to server production
    records, not a parallel ledger.

---

## What already exists that can close these gaps

- Server `createPrintingJob` already handles the three quick-print job types with the authoritative
  paper/toner cost engines.
- `issueJobMaterials` + `inventory_movements` + `production_wip` journal already exist for material
  issue to production.
- `recordMaterialConsumptionAndWaste` already exists for actual consumption and waste against issued
  quantities.
- `invoiceJobDelivered` already shows the correct WIP→COGS relief + invoice total_cost adjustment
  pattern.
- `linkExamPapersToInvoice` already shows the exam analogue of "item-less invoice lines plus a
  WIP-relief journal."
- `generateInvoiceFromWorkflow` already accepts `quick_print` and can link `postgresPrintingJobId`.

So the gaps are less "nothing exists" and more "the desk is not yet wired through the existing
authoritative path."

---

## Recommended close-out order

1. Decide ownership: make the desk create a server `printing_jobs` row for quick-print work.
2. Move inventory movement and WIP posting to the server path; remove local `onHand` decrement and
   local COGS posting for quick print.
3. Add a quick-print WIP→COGS relief step at invoice time, mirroring the production/exam pattern.
4. Align counter-sale revenue posting with the same production posting; do not re-derive COGS locally
   for cash sales.
5. Reuse the server cost engines for desk preview/entry so cost evidence tiers and fallbacks match.
6. Reconcile the COA mapping so desk and server posting use the same inventory/COGS/WIP accounts.
