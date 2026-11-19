# 15 — Phase A5 Amendments and Renewals Implementation Report

**Date:** 2026-11-19
**Branch:** `fix/printing-contracts-99`
**Base commit:** `933bcf32b9e570f97ef9d2f864274fd64c6d6e08`
**Phase:** A5 — Contract Amendments and Renewals
**Status:** **IMPLEMENTED — TESTED ON DISPOSABLE DB; PRODUCTION MIGRATION NOT APPLIED**

---

## 1. Summary

Phase A5 implements versioned, approval-gated contract amendments and independent renewals:

- **Draft contracts** can be amended directly.
- **Non-draft contracts** require a formal amendment:
  - amendment request (`pending_acceptance`);
  - customer acceptance (drawn/OTP/upload) tied to the amendment version;
  - Accountant/Administrator approval (maker-checker);
  - effective amendment applies terms and pending assessment changes only.
- **Assessment changes after activation** require an approved `contract_assessment_change` request.
- **Renewal** creates a new **draft** contract with `renewal_of_contract_id`; optional new terms; **no wallet balance transfer**.
- Historical posted journals, invoices, payments, and completed assessments are never modified.

**No production migration was applied.** Migration 0022 was applied only to in-memory PGlite test databases.

---

## 2. Files Changed

### Created

- `db/migrations/0022_printing_contract_amendments.up.sql`
- `db/migrations/0022_printing_contract_amendments.down.sql`
- `tests/printing/contract-amendments.test.ts`
- `docs/printing-contracts-remediation/15-PHASE-A5-AMENDMENTS-RENEWALS-REPORT.md`

### Modified

- `src/server/services/printingRecordsService.ts`
  - Added `requestContractAmendment`, `approveContractAmendment`, `rejectContractAmendment`, `listContractAmendments`.
  - Added `requestAssessmentChangeApproval`, `consumeAssessmentChangeApproval`, `assertAssessmentChangeApproval`.
  - `amendPrintingContract` now only amends **draft** contracts directly; non-draft returns `AMENDMENT_WORKFLOW_REQUIRED`.
  - `addContractAssessment`, `removeContractAssessment`, `updateContractAssessment`:
    - allow draft/active only;
    - require an approved assessment-change request for non-draft;
    - enforce `SUM(agreed_amount) <= total_prepaid_amount` on add/update.
  - `renewPrintingContract` accepts optional new terms and sets `renewalOfContractId`.
- `src/server/routes/printingRoutes.ts`
  - Added `POST/GET /printing/contracts/:id/amendments`.
  - Added `POST /printing/contracts/:id/amendments/:amendmentId/approve` and `/reject`.
  - Added `POST /printing/contracts/:id/assessment-changes`.
  - Renew route passes `req.body` as new terms.
- `package.json`
  - Added `test:amendments`.

---

## 3. Database Changes (Migration 0022)

- New `contract_amendments` table:
  - `company_id`, `contract_id`, `version`, `amendment_type`, `reason`;
  - `old_values`/`new_values` JSONB;
  - `status` (`pending_acceptance`/`effective`/`rejected`);
  - `requested_by`, `approved_by`, `approved_at`, `acceptance_id`, `effective_at`;
  - unique `(company_id, id)`, `(company_id, contract_id, version)`;
  - composite FKs to `printing_contracts`, `contract_acceptances`, `users`;
  - RLS + FORCE + `app_rls_allowed(company_id)` policy;
  - `updated_at` trigger.
- Down migration drops the table; disposable DBs only.

---

## 4. Amendment Lifecycle

```
draft contract ── direct amend ──► updated draft

active/suspended contract
  │ request amendment
  ▼
pending_acceptance
  │ customer acceptance (version) + Accountant/Administrator approval
  ▼
effective ──► contract terms + pending assessment changes applied
  │
  └─ reject ──► rejected
```

**Rules:**

- `pending_acceptance` does **not** change the contract.
- Acceptance must match the amendment `version` (`document_version`).
- Approval must be an approved `contract_amendment` request; requester cannot approve.
- Effective amendment applies:
  - title, academic year, start/end dates, notes;
  - pending assessment label/date/agreed amount changes.
- Completed assessments are never changed.
- The sum of assessment agreed amounts must remain `<= total_prepaid_amount`.
- Historical journals, invoices, payments, and wallet transactions are immutable.

---

## 4. Assessment Change Approval

- Draft contracts: add/remove/update assessments without approval.
- Active/suspended contracts: add/remove/update requires an approved `contract_assessment_change` request.
- The request records reason, amount, payload, requester, business date.
- The Accountant/Administrator approves; the change consumes the approval once.
- Without an approval → 409 `ASSESSMENT_CHANGE_APPROVAL_REQUIRED`.
- Sum invariant enforced on add/update.

---

## 5. Renewal

- `renewPrintingContract` creates a **new draft** contract:
  - `renewal_of_contract_id` references the predecessor;
  - optional new title, dates, total prepaid, assessments;
  - defaults to the previous terms;
  - **no wallet transaction or balance transfer**.
- The new contract must be activated separately with a new acceptance, approval, and wallet allocation.
- The previous contract remains unchanged.

---

## 6. Test Results

| Command | Exit code | Result |
|---|---:|---|
| `npm run lint` | 0 | PASS — `tsc --noEmit` |
| `npm run test:wallet` | 0 | PASS — 1/1 |
| `npm run test:contracts` | 0 | PASS — 1/1 |
| `npm run test:amendments` | 0 | PASS — 1/1 |
| `npm run test:documents` | 0 | PASS — 7/7 |
| `npm run test:workflows` | 0 | PASS — 7/7 |
| `npm run test:db` | 0 | PASS — 8/8, including 0022 up/down |
| `npm run test:printing` | 1 | 17/18 — pre-existing SKU collision, unchanged |
| `npm run build` | 0 | PASS |

**A5 test coverage:**

- Draft contract activation and amendment request.
- Pending amendment leaves the contract unchanged.
- Customer acceptance + Accountant approval → amendment effective; title/end date updated.
- Assessment change without approval → 409.
- Assessment change with approved request → assessment added.
- Renewal creates a new draft with predecessor; wallet balance unchanged.
- Sum invariant on assessment add/update.

---

## 7. Remaining Phase A Work

- **A6:** drawn/OTP/upload signatures and acceptance evidence.
- **A7:** full approval workflow and settlement enforcement.
- **A8:** insufficient-funds notifications.
- **A9:** frontend.
- **A10:** full test/certification matrix.
- **AF-A1/AF-A2:** contract invoice non-duplicating revenue treatment — **critical**: the current invoice path still posts Dr AR / Cr Revenue; contract invoicing must not go live until fixed.
- **MIG-01:** contract numbering counter.
- **MIG-04:** trigger-owned assessment counts.

---

## 8. Production Migration Status

**Migration 0022 is written and tested on disposable PGlite databases only.** It has **not** been applied to production or any shared database. Application requires independent review, business-owner approval, and backup/restore confirmation.

**No commit was created. All pre-existing user changes remain preserved.**