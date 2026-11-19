# 02 — Business Decision Register (Updated for Stage 2)

**Status:** **APPROVED — D-01 through D-12**
**Approval date:** 2026-11-19
**Approval source:** Stage 2 authorisation recorded in the remediation instruction. No separate wet signature was supplied; the approvals below are recorded from that instruction.
**Rule:** Approved decisions are authoritative for Stage 2 design. Implementation remains prohibited until explicit implementation authorisation.
**Date opened:** 2026-11-19
**Owner:** Business owner / Finance / Operations (per Stage 2 approval)

---

## 1. Decision Summary

| ID | Decision | Approved final decision | Status | Date approved |
|---|---|---|---|---|
| **D-01** | Deployment currency | Malawi; ISO `MWK`; symbol `K`; source of truth `companies.base_currency`; no module hardcoding | **APPROVED** | 2026-11-19 |
| **D-02** | Cancellation settlement | Authorised user chooses `refund` or `forfeit`; mandatory reason; comply with contract terms; record amount, user, date, full audit | **APPROVED** | 2026-11-19 |
| **D-03** | Forfeiture income account | Use existing Other Income account; never auto-create; fail safely; never substitute Printing Revenue | **APPROVED** | 2026-11-19 |
| **D-04** | Top-ups | Confirmed additional payments auto top-up active contracts; record wallet Deposit; suspended requires approval; completed not reopened; cancelled rejects; no double counting | **APPROVED** | 2026-11-19 |
| **D-05** | Completed assessments | Contract completes when all required assessments are completed; remaining balance stays attached; no automatic refund or wallet transfer | **APPROVED** | 2026-11-19 |
| **D-06** | Colour printing | Support B&W and colour; colour explicitly in contract terms; separate pricing, BOM and consumption | **APPROVED** | 2026-11-19 |
| **D-07** | Contract permissions | Administrators, Finance, and authorised Contract Managers; separation of duties; verify existing permission infrastructure | **APPROVED** | 2026-11-19 |
| **D-08** | Timezone | Company-configured timezone; default `Africa/Blantyre`; UTC timestamps; display in company timezone | **APPROVED** | 2026-11-19 |
| **D-09** | Reactivation | Never reactivate cancelled or settled contracts; create a new contract or renewal | **APPROVED** | 2026-11-19 |
| **D-10** | Initial allocation | Create as draft; allocate exact approved amount before activation; require sufficient available wallet funds; atomic | **APPROVED** | 2026-11-19 |
| **D-11** | Numbering | Preserve existing format and minimum widths (contracts 2, exams 4); safe natural overflow; verify prefix/year | **APPROVED** | 2026-11-19 |
| **D-12** | Legacy remediation | Read-only preflight; reconciliation report; separate approval; controlled audited remediation; never silently correct | **APPROVED** | 2026-11-19 |

**All twelve decisions are APPROVED. No business decision remains BLOCKED.**

---

## 2. Detailed Decisions and Verified Implementation Implications

### D-01 — Deployment Currency

**Approved decision:**
- Country: Malawi.
- Internal ISO currency: `MWK`.
- Display symbol: `K`.
- Source of truth: `companies.base_currency`.
- No module-specific currency hardcoding.

**Verified repository facts:**
- `companies.base_currency CHAR(3) NOT NULL DEFAULT 'ZMW'` (`db/migrations/0001...up.sql:59`).
- `db.ts` default `baseCurrency = 'ZMW'` (`db.ts:151`).
- The seed company is created without an explicit currency, so it is `ZMW` (`db.ts:224-231`).
- `documentsService.ts:561` hardcodes `currencyCode: 'ZMW'` in the contract document list. This is the verified line (not 1184).
- `types/accounting.ts` `CompanyProfile.currency` is the display symbol, not the ISO code; `baseCurrency` is not on the profile.

**Technical implications:**
- Update the Malawi company record to `base_currency = 'MWK'`, `currency_symbol = 'K'`.
- Add `printing_contracts.currency_code CHAR(3)`; backfill from `companies.base_currency`; set `NOT NULL`.
- Service sets `currency_code` on create/renew/top-up.
- Replace `documentsService.ts:561` hardcoded `'ZMW'` with the contract/company currency.
- Existing documents remain as issued; do not rewrite historical currency.
- Do not change the global schema default unless the product is single-country; the company record is the source of truth.

**Status:** APPROVED — 2026-11-19.

---

### D-02 — Cancellation Settlement

**Approved decision:**
- Authorised user chooses `refund` or `forfeit`.
- Mandatory cancellation reason.
- Decision must comply with agreed contract terms.
- Record amount, user, date, and complete audit history.

**Verified current behaviour:**
- `setPrintingContractStatus` cancel (`printingRecordsService.ts:622-642`) sets `status='cancelled'` and appends to `notes`; no settlement journal, no bank row, no `cancelled_at`/`cancelled_by`.

**Technical implications:**
- Add columns: `cancelled_at TIMESTAMPTZ`, `cancelled_by BIGINT REFERENCES users(id)`, `cancellation_reason TEXT`, `settlement_mode VARCHAR(16)`, `settled_amount NUMERIC(19,4)`, `settlement_journal_txn_id BIGINT`.
- Composite FKs: `(company_id, settlement_journal_txn_id) REFERENCES journal_transactions(company_id, id)`.
- Refund: Dr contract liability / Cr explicit refund bank account; insert one `bank_transactions` row (`txn_type='Debit'`, negative amount, `journal_txn_id`).
- Forfeit: Dr contract liability / Cr `4900 Other Miscellaneous Income`; no bank row.
- Idempotency key required for cancel.
- Block reactivation after settlement (D-09).
- Audit: actor, reason, mode, amount, journal id, timestamp.

**Status:** APPROVED — 2026-11-19.

---

### D-03 — Forfeiture Income Account

**Approved decision:**
- Use the existing Other Income account.
- Never automatically create another account.
- Fail safely if unavailable or incorrectly configured.
- Never silently substitute Printing Revenue.

**Verified repository facts:**
- The seed account `4900` is `'Other Miscellaneous Income'` with `account_type='Income'` and `account_subtype='other_income'` (`db.ts:63`).
- There is no `account_type='OtherIncome'` row in the seed; `account_type` includes `'Income'`, not `'OtherIncome'` (`0002:12`).
- `resolveIncomeAccount` currently uses codes `4000/4010/4900`, then any `Income` account (`printingRecordsService.ts:908-931`).

**Technical implications:**
- Resolve forfeiture income by `account_subtype = 'other_income'` or `code = '4900'`, `is_active = TRUE`.
- Do **not** fall back to `Income`/`4000` Printing Revenue.
- If missing or inactive, throw `NO_FORFEITURE_INCOME_ACCOUNT` and roll back.
- Add a test for missing/inactive account.
- Do not auto-create an account.

**Status:** APPROVED — 2026-11-19.

---

### D-04 — Top-Ups and Unallocated Credit

**Approved decision:**
- Confirmed additional payments automatically top up active contracts.
- Record a wallet Deposit.
- Suspended contracts require authorised approval.
- Completed contracts are not automatically reopened.
- Cancelled contracts reject automatic top-ups.
- Prevent double-counting wallet funds.

**Verified repository facts:**
- No top-up endpoint/service exists.
- `printing_contracts.remaining_balance` is the contract liability; `bank_transactions` is the bank subledger.
- There is **no dedicated customer-wallet table**. The "wallet" in this decision maps to the bank subledger (`bank_transactions`) plus the contract liability. If a separate customer wallet is intended, it is not in the schema and must be treated as UNVERIFIED.
- `bank_transactions.amount` is positive for inflow, negative for outflow; `running_balance` is computed on read (`bankingService.ts:177-181`).

**Technical implications:**
- New `POST /printing/contracts/:id/deposits` with idempotency key.
- Only `status='active'` auto top-up; `completed` rejects; `cancelled` rejects; `draft` rejects (not activated); suspended/settled requires explicit approval (map to `cancelled` or a new `suspended` status — see D-09/D-12).
- Dr Bank / Cr contract liability; one `bank_transactions` Deposit row with `journal_txn_id`.
- Increase `total_prepaid_amount` and `remaining_balance` in one UPDATE.
- No double counting: idempotency + unique bank row + no manual wallet balance.
- UI shows unallocated amount.

**Status:** APPROVED — 2026-11-19.
**Note:** "Suspended" is not a current status. The design maps it to a contract requiring explicit approval; a new `suspended` status is a schema change to be confirmed in Phase A.

---

### D-05 — Completed Assessments

**Approved decision:**
- Contract completes when all required assessments are completed.
- Remaining balance stays attached to the completed contract.
- No automatic refund or wallet transfer.

**Verified current behaviour:**
- `printing_contracts.status` CHECK allows only `active/exhausted/cancelled` (`0007:134`).
- `completeContractAssessment` sets `exhausted` when `completed >= total` even if `remaining_balance > 0` (`printingRecordsService.ts:994-1019`).
- TS type is `'active' | 'exhausted' | 'cancelled'` (`types/accounting.ts:213`).

**Technical implications:**
- Add `completed` to the status CHECK: `('draft','active','completed','exhausted','cancelled')`.
- On the final assessment completion, set `status='completed'`, keep `remaining_balance` unchanged.
- `exhausted` remains for `remaining_balance = 0` (or is deprecated; decide in Phase A).
- Update all status branches: `documents.ts:307` (`status === 'active'` for invoice), `PrintingContractsView.tsx:792`, `AccountingContext.tsx:2386`, `ContractActionModals.tsx:426/434`, `SidebarNavigator.tsx:123`, `HomeWorkflowView.tsx:91`.
- No automatic refund/transfer.
- Add tests for `completed` with positive balance.

**Status:** APPROVED — 2026-11-19.
**Schema impact:** HIGH — status CHECK + TS type + UI/query branches.

---

### D-06 — Colour Printing

**Approved decision:**
- Support black-and-white and colour.
- Colour must be explicitly included in contract terms.
- Separate pricing, BOM and consumption tracking.

**Verified current behaviour:**
- `printingWorkflows.calculateContractMilestoneEstimate` accepts `colorMode` but only computes toner if `tonerChannels.K` exists (`printingWorkflows.ts:675`); colour-only CMY is under-costed.
- `productionService.ts` hardcodes `colorMode: 'mono'` at lines 419, 445, 465, 514.
- `PrintingContractsView.tsx:55`, `AccountingContext.tsx:68`, `ExaminationView.tsx:42`, `QuickPrintView.tsx:39` set `supportsColour: false` in demo press capabilities.
- `printing_contracts` has no colour/terms field; `contract_assessment_milestones` has no colour.
- The toner engine supports CMYK (`tonerCalc.ts:4-5`, `615-635`).

**Technical implications:**
- Add `color_mode VARCHAR(16) NOT NULL DEFAULT 'mono' CHECK (color_mode IN ('mono','colour'))` to `printing_contracts` or `contract_assessment_milestones` (decide in Phase A; milestone-level is more precise).
- Add a `terms`/`colour_terms` field or structured JSONB to record that colour is included.
- Pass `colorMode` from the contract/milestone to `calculateContractMilestoneEstimate`.
- Update press capability to `supportsColour: true` where colour is offered.
- Separate pricing/BOM/consumption by colour; add CMY tests.
- Do not change existing mono costing behaviour.

**Status:** APPROVED — 2026-11-19.
**Schema impact:** MEDIUM — new colour/terms fields + costing/UI changes.

---

### D-07 — Contract Permissions

**Approved decision:**
- Administrators, Finance, and authorised Contract Managers.
- Enforce separation of responsibilities.
- Verify actual existing permission infrastructure.

**Verified current infrastructure:**
- Permissions: `printing:read`, `printing:write` (`permissions.ts:60-61`).
- Roles: `Administrator`, `Accountant`, `Bookkeeper`, `ProductionManager`, `Read-Only` (`0001:106`, `permissions.ts:147-190`).
- `printing:write` is granted to Administrator, Accountant, Bookkeeper, ProductionManager (`permissions.ts:167-183`).
- No `ContractManager` role exists; no per-user ACL table exists.
- Contract routes use `printing:write` (`printingRoutes.ts:328-582`).

**Technical implications:**
- Add `printing:contracts:manage` permission.
- Map "Finance" to `Accountant`; grant `printing:contracts:manage` to Administrator + Accountant.
- Add a `ContractManager` role to `company_memberships.role` CHECK and `ROLE_DEFINITIONS`, with `printing:contracts:manage`; or use an explicit per-user grant if the business prefers.
- Remove `printing:contracts:manage` from ProductionManager/Bookkeeper by default.
- Update route guards and UI `requiredPermission`.
- Add RBAC tests.
- **Schema impact:** role CHECK change is required if `ContractManager` is added.

**Status:** APPROVED — 2026-11-19.
**Note:** The exact mapping of "Finance" and "authorised Contract Managers" must be confirmed in Phase A; the design above is the narrowest implementation.

---

### D-08 — Timezone

**Approved decision:**
- Company-configured timezone.
- Default `Africa/Blantyre`.
- Store timestamps consistently in UTC.
- Display using the company timezone.

**Verified current state:**
- `companies` has **no timezone column** (`0001:46-73`).
- `todayIsoDate()` uses UTC (`commercialHelpers.ts:54-56`).
- Contract/exam dates and years use UTC (`printingRecordsService.ts:140`, `328`, `347`, `965`).
- `journal_transactions.txn_date` is `DATE`; `created_at`/`updated_at` are `TIMESTAMPTZ`.

**Technical implications:**
- Add `companies.timezone TEXT NOT NULL DEFAULT 'Africa/Blantyre'` (proposed; not existing).
- Add a helper `companyToday(companyId)` / `companyNow(companyId)` using `timezone(...)`, or set the DB session timezone per request.
- Business dates: `(NOW() AT TIME ZONE company_timezone)::DATE`.
- Timestamps: store `TIMESTAMPTZ` in UTC; display in company timezone.
- Replace UTC year/date derivations in contract/exam numbering and completion.
- Add tests around midnight/year boundaries.

**Status:** APPROVED — 2026-11-19.
**Schema impact:** MEDIUM — new `companies.timezone` column + date helpers.

---

### D-09 — Reactivation

**Approved decision:**
- Never reactivate cancelled or settled contracts.
- Create a new contract or renewal.

**Verified current behaviour:**
- `setPrintingContractStatus('activate')` allows `cancelled → active` (`printingRecordsService.ts:643-667`).
- No `settled_amount` concept yet.

**Technical implications:**
- Reject `activate` when `status='cancelled'` or `settled_amount > 0`.
- Allow `draft → active` (D-10).
- Allow `active` only; no `completed → active`, no `exhausted → active` (renew instead).
- Update UI: hide/disable activate for cancelled/settled.
- Add tests.

**Status:** APPROVED — 2026-11-19.

---

### D-10 — Initial Allocation and Draft Lifecycle

**Approved decision:**
- Create contract as draft.
- Allocate exact approved amount before activation.
- Require sufficient available wallet funds.
- Use atomic financial operations.

**Verified current behaviour:**
- `createPrintingContract` posts the deposit journal immediately and inserts `status='active'` (`printingRecordsService.ts:142-170`).
- No `draft` status in the DB or TS type (`0007:134`, `types/accounting.ts:213`).
- The UI already has an "Edit Draft" action visible when `status !== 'active'` (`PrintingContractsView.tsx:588`), but there is no draft status.

**Technical implications:**
- Add `draft` to the status CHECK and TS type.
- Split lifecycle:
  1. `createPrintingContract` → insert `status='draft'`, assessments, **no journal, no bank row**.
  2. `activatePrintingContract` → lock contract, validate exact allocation, validate wallet/bank funds, post Dr Bank / Cr liability, insert bank Deposit row, set `status='active'`, set `activated_at`/`activated_by`.
- Require sufficient available wallet funds at activation (define wallet source; see D-04 note).
- Atomic: activation posts journal + bank row + status in one transaction with idempotency key.
- Update all status branches and UI.
- Tests: draft create, draft amend, activation success, activation insufficient funds, double activation.

**Status:** APPROVED — 2026-11-19.
**Schema impact:** HIGH — new `draft` status, `activated_at`/`activated_by`, lifecycle split.
**Note:** This is the largest change in the remediation. The current "create = active + deposit" model must be replaced.

---

### D-11 — Numbering

**Approved decision:**
- Preserve existing contract numbering format and 2-digit minimum sequence width.
- Preserve examination format `EXM-YYYY-NNNN`.
- Examination sequence has 4-digit minimum width.
- Safe natural overflow.
- Verify actual contract prefix and year convention.

**Verified current behaviour:**
- Contracts: `CTR-${new Date().getUTCFullYear()}-${String(seq).padStart(2,'0')}` (`printingRecordsService.ts:140`), where `seq = MAX(contract_number)+1` across all years (`135-139`). The sequence is **global across years**, not per-year.
- Exams: `EXM-${year}-${String(seq+i).padStart(4,'0')}` (`printingRecordsService.ts:342`), `MAX(job_number)+1` (`323-327`). Global across years.
- No sequence/counter table exists.
- `VARCHAR(64)` columns; no DB-level uniqueness beyond `(company_id, contract_number)` and `(company_id, job_number)`.

**Technical implications:**
- Preserve `CTR-YYYY-NN` (2-digit minimum) and `EXM-YYYY-NNNN` (4-digit minimum).
- Use a **numeric company-scoped counter** with a global `last_value` to preserve the existing cross-year sequence. Do not reset to 1 at year rollover.
- `LPAD(seq, width, '0')` with width as a **minimum**; natural overflow to 3/5 digits when exceeded. No truncation, no exception at width.
- Counter table: `printing_number_counters(company_id, scope, last_value)`, PK `(company_id, scope)`, RLS + FORCE.
- Backfill with `GREATEST` and rerunnable upsert.
- Function `next_printing_number(company_id, scope, prefix, min_width)` with company guard, parameter guards, and `ON CONFLICT DO UPDATE ... RETURNING`.
- Year from company timezone (D-08).
- Tests: 150 sequential, 20 concurrent, malformed legacy, natural overflow at 99/100 and 9999/10000.

**Status:** APPROVED — 2026-11-19.
**Correction to earlier draft:** The earlier draft proposed per-year counters and a failure at width overflow. Both are rejected. The corrected design is a global numeric counter with minimum-width formatting and natural overflow.

---

### D-12 — Legacy Remediation

**Approved decision:**
- Read-only preflight.
- Produce reconciliation report.
- Obtain separate business and finance approval.
- Execute controlled, audited remediation only after approval.
- Never silently correct historical financial data.

**Technical implications:**
- Implement the read-only queries in `09-legacy-data-preflight-design.md`.
- Export results, classify exceptions, obtain sign-off.
- Remediation is a separate controlled change with audit entries and backup.
- Do not enable strict constraints until legacy rows are reconciled or quarantined.
- No automatic corrections.

**Status:** APPROVED — 2026-11-19.

---

## 3. Approval Record

| Role | Decision | Approval | Date |
|---|---|---|---|
| Business owner | D-01…D-12 | APPROVED (Stage 2 instruction) | 2026-11-19 |
| Finance | D-01…D-05, D-07, D-10, D-11, D-12 | APPROVED (Stage 2 instruction) | 2026-11-19 |
| Operations | D-02, D-04, D-06, D-09, D-11 | APPROVED (Stage 2 instruction) | 2026-11-19 |

**No wet signature was supplied.** The approvals are recorded from the Stage 2 authorisation text. If a formal signature is required for audit, it must be added before implementation.

---

## 4. Release Rule

Phase A may begin only after:

1. The migration design in `06-migration-design-remediation.md` is accepted.
2. The numbering/locking design in `07-numbering-and-locking-design.md` is accepted.
3. The assessment integrity design in `08-assessment-integrity-design.md` is accepted.
4. The legacy preflight in `09-legacy-data-preflight-design.md` is executed and signed off.
5. Explicit implementation authorisation is recorded.
6. The pre-existing `test:printing` SKU collision is acknowledged as out of scope.