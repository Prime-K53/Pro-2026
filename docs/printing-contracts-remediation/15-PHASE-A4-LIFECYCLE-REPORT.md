# 15 — Phase A4 Lifecycle Implementation Report

**Date:** 2026-11-19
**Branch:** `fix/printing-contracts-99`
**Base commit:** `933bcf32b9e570f97ef9d2f864274fd64c6d6e08`
**Phase:** A4 — Contract Lifecycle Services
**Status:** **IMPLEMENTED — TESTED ON DISPOSABLE DB; PRODUCTION MIGRATION NOT APPLIED**

---

## 1. Summary

Phase A4 implements the approved contract lifecycle:

- `draft` → `active` → `suspended` / `completed` / `cancelled`.
- Activation requires customer acceptance, an approved activation request, exact allocation, sufficient wallet funds, and an atomic wallet allocation.
- Suspension/resumption require a reason and the contract-management permission.
- Completion requires all assessments to be completed; remaining funds stay attached.
- Cancellation requires a reason and a settlement mode (`refund` or `forfeit`); settled contracts cannot be reactivated.
- Renewal creates a new draft contract with a predecessor reference.

**No production migration was applied.** Migration 0021 was applied only to in-memory PGlite test databases by the test harness.

---

## 2. Files Changed

### Created

- `db/migrations/0021_printing_contract_lifecycle.up.sql`
- `db/migrations/0021_printing_contract_lifecycle.down.sql`
- `tests/printing/contract-lifecycle.test.ts`
- `docs/printing-contracts-remediation/15-PHASE-A4-LIFECYCLE-REPORT.md`

### Modified

- `src/server/services/printingRecordsService.ts`
  - `createPrintingContract` now creates a **draft** by default; optional `activate` for seed/legacy.
  - Added `activatePrintingContract`, `suspendContract`, `resumeContract`, `cancelPrintingContract`, `recordContractAcceptance`, `resolveForfeitureIncomeAccount`.
  - `completeContractAssessment` no longer clamps; rejects over-consumption; sets `completed` when all assessments are done.
  - `renewPrintingContract` sets `renewalOfContractId`.
- `src/server/services/customerWalletService.ts`
  - `allocateWalletFunds` supports `allowDraft` and `increaseContractTotals`.
  - Added `releaseWalletAllocation`.
- `src/server/routes/printingRoutes.ts`
  - Added `POST /printing/contracts/:id/suspend`, `/resume`, `/acceptances`.
  - Contract lifecycle routes use `printing:contracts:manage`.
  - Cancel accepts `settlementMode` and `refundBankAccountId`.
- `src/server/permissions.ts`
  - Added `printing:contracts:manage`; granted to Administrator and Accountant.
- `src/types/accounting.ts`
  - `PrintingContract.status` now includes `draft | active | suspended | completed | exhausted | cancelled`; added lifecycle fields.
- `src/server/db.ts`
  - Seed contract passes `activate: true` to preserve the demo.
- `package.json`
  - Added `test:contracts`.
- `tests/wallet/customer-wallet.test.ts`
  - Activates the draft contract before allocation.
- `tests/db/migration-suite.ts`
  - Contract fixture sets `status='active'`, `activated_at=NOW()`.
- `tests/documents/documents-and-invoicing.test.ts`
  - Contract fixture sets `activated_at=NOW()`.

---

## 3. Database Changes (Migration 0021)

- `printing_contracts.status` CHECK expanded to `draft | active | suspended | completed | exhausted | cancelled`.
- Added lifecycle columns: `activated_at/by`, `completed_at/by`, `suspended_at/by`, `suspension_reason`, `resumed_at/by`, `renewal_of_contract_id`, `customer_acceptance_id`.
- Added cancellation/settlement columns: `cancelled_at`, `cancelled_by`, `cancellation_reason`, `settlement_mode`, `settled_amount`, `settlement_journal_txn_id`.
- Added `contract_acceptances` table with RLS + FORCE.
- Added composite FKs:
  - `(company_id, renewal_of_contract_id)` → `printing_contracts(company_id, id)`.
  - `(company_id, customer_acceptance_id)` → `contract_acceptances(company_id, id)`.
  - `(company_id, settlement_journal_txn_id)` → `journal_transactions(company_id, id)`.
- Added lifecycle consistency CHECKs.
- Added `contract_assessment_milestones.completed_at/completed_by`.
- Down migration drops the new objects; disposable DBs only.

---

## 4. Lifecycle State Machine

```
draft
  │ activate (acceptance + approval + exact allocation + wallet funds)
  ▼
active ─────────────► suspended
  │  ▲                   │
  │  └──── resume ───────┘
  │
  ├─ all assessments completed ──► completed (balance stays)
  │
  └─ cancel (reason + settlement) ──► cancelled (no reactivation)

completed ──► (no automatic reopen)
cancelled ──► (no reactivation; renew/new contract)
```

**Rules implemented:**

- Draft creation posts **no journal** and **no bank row**.
- Activation:
  - contract must be `draft`;
  - assessment sum must equal `total_prepaid_amount`;
  - an accepted customer acceptance must exist;
  - an approved `contract_activation` request must exist and be unconsumed;
  - wallet must have sufficient funds;
  - allocation is atomic: Dr 2310 / Cr 2300, wallet debit, allocation row, contract `active`, `activated_at/by`, `deposit_journal_txn_id`.
- Suspension:
  - only `active` contracts;
  - reason mandatory;
  - `suspended_at/by`, `suspension_reason`.
- Resumption:
  - only `suspended` contracts;
  - `resumed_at/by`.
- Completion:
  - all assessments completed → `completed`;
  - `remaining_balance` stays attached (no automatic refund/transfer);
  - `completed_at/by` on contract and milestone.
- Cancellation:
  - only `active`, `suspended`, or `completed`;
  - reason mandatory;
  - `remaining_balance > 0` requires `settlementMode`;
  - `refund`: release allocation (Dr 2300 / Cr 2310), then refund (Dr 2310 / Cr Bank), one bank Debit row, one wallet release, one wallet refund;
  - `forfeit`: Dr 2300 / Cr 4900 Other Income, no bank row;
  - `remaining_balance=0`; `cancelled_at/by`; settlement metadata.
- Reactivation:
  - `cancelled` or settled → `409`;
  - `completed`/`exhausted` → `409` (renew instead).
- Renewal:
  - new draft contract with `renewal_of_contract_id`; no balance transfer.

---

## 22. Test Results

| Command | Exit code | Result |
|---|---:|---|
| `npm run lint` | 0 | PASS — `tsc --noEmit` |
| `npm run test:wallet` | 0 | PASS — 1/1 |
| `npm run test:contracts` | 0 | PASS — 1/1 |
| `npm run test:documents` | 0 | PASS — 7/7 |
| `npm run test:workflows` | 0 | PASS — 7/7 |
| `npm run test:db` | 0 | PASS — 8/8, including 0021 up/down |
| `npm run test:printing` | 1 | 17/18 — pre-existing SKU collision, unchanged |
| `npm run build` | 0 | PASS — chunk-size warning only |

**New lifecycle test coverage:**

- Draft creation has no journal.
- Activation without acceptance → 409.
- Activation without approval → 409.
- Activation with acceptance + approval → active; wallet allocated.
- Suspend → suspended; resume → active.
- Complete assessment 1 → active, remaining 250.
- Complete assessment 2 → completed, remaining 0.
- Complete after completion → 400.
- Suspend completed → 409.
- Second contract activation + forfeiture → cancelled, remaining 0, Other Income credit.
- Reactivate cancelled → 409.

---

## 6. Invariants Enforced

- `printing_contracts.status` CHECK includes draft/active/suspended/completed/exhausted/cancelled.
- Active contracts must have `activated_at`.
- Completed contracts must have `completed_at`.
- Suspended contracts must have `suspended_at`.
- Cancelled contracts must have `cancelled_at`.
- Settlement mode/amount/journal consistency.
- Assessment completion does not clamp; `agreed_amount > remaining_balance` → 409 `INSUFFICIENT_CONTRACT_FUNDS`.
- All assessments complete → `completed`, not `exhausted`.
- Cancelled/settled contracts cannot be reactivated.
- Draft has no journal.

**Not yet implemented (later phases):**
- Trigger-owned assessment counts (MIG-04).
- Contract number counter (MIG-01) — A4 still uses MAX.
- Contract currency code (D-01) — wallet uses company base currency.
- Contract invoice nil-GL/non-duplicating treatment (AF-A1/AF-A2).
- Approval workflow enforcement for cancel/assessment changes (A7).
- Drawn/OTP signature flows (A6).
- Notifications (A8).
- Frontend (A9).
- Full test matrix (A10).

---

## 7. Remaining Phase A Work

- **A5:** amendments and renewals (versioned terms, future-only effects, predecessor).
- **A6:** signatures and customer acceptance (drawn, OTP, upload).
- **A7:** financial approvals and settlement (approval action types, thresholds, Finance-selected refund account).
- **A8:** insufficient-funds notifications.
- **A9:** frontend.
- **A10:** full test and certification matrix.

---

## 8. Production Migration Status

**Migration 0021 is written and tested on disposable PGlite databases only.** It has **not** been applied to production or any shared database. Application requires:
1. Independent review of 0021.
9. Business-owner approval.
10. Backup/restore confirmation.

**No commit was created. All pre-existing user changes remain preserved.**