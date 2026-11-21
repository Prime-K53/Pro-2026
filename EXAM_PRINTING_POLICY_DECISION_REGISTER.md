# EXAM_PRINTING_POLICY_DECISION_REGISTER.md

**Module:** PRIME ERP — Examination Printing
**Phase:** 0 — Repository-First Baseline Audit
**Date:** 21 November 2026

This register records the authoritative business policy decisions from the master handover (D1–D5), their current implementation status, and the approvals still outstanding. **No decision below is represented as approved beyond what the handover states.**

Status legend: **APPROVED (business)** = selected by business policy per handover · **PROPOSED** = selected but formal approval outstanding · **MISSING** = no approval path yet.

---

## D1 — Short delivery and reprint losses

- **Decision:** Option A — Delivered-quantity revenue with separate production-loss treatment.
- **Register status:** APPROVED (business) — Finance posting matrix PENDING.
- **Requirements:**
  1. Recognise revenue only for examination papers actually delivered and accepted.
  2. Never invoice undelivered quantities.
  3. Production losses accounted separately using Finance-approved treatment.
  4. Prime Printing must not charge customers for its own production mistakes.
  5. Recoverable materials return to inventory where appropriate.
  6. Preserve ordered, produced, delivered, accepted, short-delivered and reprinted quantities separately.
  7. Preserve the original order quantity.
  8. Require authorised write-off reasons and audit records.
  9. Prevent duplicate loss postings.
  10. Link reprints to original production batch and reason.
- **Finance must approve before financial implementation is finalised:** the detailed posting matrix (see `EXAM_PRINTING_FINANCIAL_POSTING_MATRIX.md`).
- **Current implementation status:** PARTIAL.
  - Delivered-quantity billing basis exists (`deliverExamPaper` dispatches QC-approved good copies, `printingRecordsService.ts:4492-4495`; `shortDelivery` flag `:4530`).
  - Revenue = `learnersCount × pricePerLearner` (`:1636`); invoicing quantity = `paper.copies` (`:4674`) — **not** accepted quantity. Gap: no `accepted_qty` column.
  - Reprints link to parent (`reprint_of_paper_id`) with reason (`createExamReprint:3859`); original preserved.
  - Material return exists (`returnUnusedMaterials:1328`).
  - **Missing:** separate `accepted/delivered/short/reprinted` quantity columns; authorised write-off reasons on loss; dedicated production-loss posting; duplicate-loss prevention keyed on event.
- **Outstanding approval:** Finance — posting matrix (revenue recognition on short delivery, treatment of Prime Printing-caused spoilage, recoverable-material return valuation).

## D2 — Toner and machine cost variance

- **Decision:** Option A — Dedicated production cost variance account.
- **Register status:** APPROVED (business) — account code/name/method PENDING Finance.
- **Requirements:**
  1. Compare estimated vs actual production costs where actual consumption data is available.
  2. Maintain separate estimated and actual costs.
  3. Trace variances to the affected paper/batch.
  4. Use a dedicated, Finance-approved production cost variance account.
- **Finance must approve:**
  1. Account code.
  2. Account name.
  3. Debit/credit posting method.
  4. Favourable and unfavourable variance treatment.
  5. Immediate vs periodic posting.
  6. Approval and materiality thresholds.
- **Rule:** Never invent an account code or reuse an unrelated account.
- **Current implementation status:** PARTIAL.
  - `job_material_requirements` carries `planned_*` vs `actual_good_usage_qty`/`waste`/`returned` (`0011:249-269`).
  - `cost_status`/`cost_warnings` on exam papers record estimate/unavailable status (`printingRecordsService.ts:1551-1552`).
  - **Missing:** dedicated variance account; favourable/unfavourable logic; variance posting; per-paper variance surfacing.
- **Outstanding approval:** Finance — all six items above. **No code may post to a variance account until this is approved.**

## D3 — Free teacher examination copies

- **Decision:** Option C — Exactly TWO free teacher copies per examination paper.
- **Register status:** APPROVED (business) — fixed rule, not user-editable.
- **Fixed rule:**
  - `teacherCopies = 2`
  - `plannedProductionQuantity = learnerQuantity + 2`
  - `billableQuantity = acceptedBillableLearnerQuantity`
  - Worked example: learners 25 → teacher 2 → planned 27 → billable 25.
- **Requirements:**
  1. Apply the allowance independently to every examination paper (not once per multi-paper batch).
  2. Maintain separate learner and teacher quantities.
  3. Track actual production and delivery of both categories.
  4. Teacher copies must not be invoiced.
  5. Teacher copies must not be classified as wastage.
  6. Teacher-copy production costs remain in appropriate production costs.
  7. Retries must not grant another allowance.
  8. Reprints must not automatically grant another allowance.
  9. Production-error replacements follow D1.
  10. Damaged/spoiled/replacement copies traceable.
  11. Repeated requests must not create duplicate teacher-copy production.
  12. Not user-editable; future change requires formal business authorisation.
- **Current implementation status:** MISSING. No `teacher`/`billable` concept exists anywhere (grep = 0 across `src/` and `db/`). `copies` is the only quantity input and is auto-synced to `learnersCount` in the UI (`ExaminationView.tsx:369-371`), so today `copies` conflates learners and (unmodelled) teacher copies.
- **Outstanding approval:** None for the rule itself (fixed). Implementation must not make it user-editable.

## D4 — Confidential examination content retention

- **Decision:** Seven years, commencing at the formal examination completion date.
- **Register status:** PROPOSED — retention commencement selected; formal Records/Legal sign-off OUTSTANDING.
- **Requirements:**
  1. Retain artwork, proofs and associated access/download audit records for 7 years from formal exam completion.
  2. Protect confidential content throughout retention.
  3. Prohibit permanent public file links.
  4. Securely delete expired content after checking applicable holds.
  5. Record authorised disposal events.
- **Outstanding approval:**
  - Formal Records/Legal sign-off.
  - Legal hold procedures.
  - Exceptional deletion authorisation.
  - Any longer applicable statutory, school or contractual retention requirements.
- **Rule:** The 7-year commencement decision is selected but **must not be represented as completed organisational legal approval.**
- **Current implementation status:** MISSING. No confidential-content store, no artwork/proof tables, no signed URLs, no retention/disposal logic. `exams:view_confidential` defined but unenforced.

## D5 — Examination cancellation

- **Decision:** Option A — Reconcile and account for everything.
- **Register status:** PROPOSED — formal Operations and Finance approvals OUTSTANDING.
- **Additional instruction:** Require authorised cancellation and full reconciliation **before** financial adjustments.
- **Proposed requirements:**
  1. Stop further production immediately after authorised cancellation.
  2. Preserve the original order and production history.
  3. Reconcile ordered, produced, issued, consumed, delivered and remaining quantities.
  4. Identify recoverable materials and return them to inventory where appropriate.
  5. Calculate unavoidable production losses.
  6. Identify affected invoices, payments, customer balances and credits.
  7. Complete reconciliation before financial adjustments.
  8. Process credit notes and refunds through existing authorised accounting workflows.
  9. Preserve a complete audit trail.
  10. Prevent repeated cancellation and duplicate adjustments.
- **Rule:** Do not automatically reverse inventory, issue refunds, post losses or modify invoices merely because a cancellation status changes.
- **Required approvals:**
  - Examination Operations: cancellation authority and production stoppage.
  - Operations/Inventory: quantity reconciliation and material recovery.
  - Finance: production loss/write-off treatment.
  - Finance: invoice adjustments, credit notes and refunds.
  - Operations and Finance: final reconciliation sign-off.
- **Register status:** Keep **PROPOSED** until formal approval is documented.
- **Current implementation status:** PARTIAL.
  - `cancelExamPaper` (`printingRecordsService.ts:3761`) requires reason, blocks delivered/invoiced/dispatched (`:3792-3798`), calls `cancelPrintingJob` to release reservations/return materials/write off WIP (`:3800-3805`).
  - **Missing:** full quantity reconciliation workflow; recoverable-material identification; credit-note/refund orchestration; reconciliation-before-adjustment gate; duplicate-adjustment prevention.
- **Outstanding approval:** All five approval lines above.

---

## Approval status summary

| Decision | Business | Finance | Operations | Legal/Records | Overall |
|---|---|---|---|---|---|
| D1 Short delivery/reprint losses | Selected (Option A) | **Pending** (posting matrix) | — | — | Partial |
| D2 Cost variance | Selected (Option A) | **Pending** (account/method) | — | — | Partial |
| D3 Two free teacher copies | **Fixed rule** | — | — | — | Rule fixed; implementation missing |
| D4 7-year retention | Selected (7 yrs) | — | — | **Pending** (sign-off/holds) | Proposed |
| D5 Cancellation reconcile-all | Selected (Option A) | **Pending** | **Pending** | — | Proposed |

**Implementation gate:** Financial and policy-dependent implementation (D1 loss postings, D2 variance postings, D4 disposal, D5 financial adjustments) must **stop** at the approval boundary and be documented as pending. Independent technical work (D3 quantity model, D5 reconciliation mechanics, confidential storage plumbing) may proceed where safe and reversible.