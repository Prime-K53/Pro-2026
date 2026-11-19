# 24 — Phase A2.2 Business Approval Record

**Date:** 2026-11-19
**Branch:** `fix/printing-contracts-99`
**Base commit:** `933bcf32b9e570f97ef9d2f864274fd64c6d6e08`
**Phase:** A2.2 — Approval Recording
**Mode:** Documentation only
**Status:** **APPROVALS RECORDED — PHASE A3 NOT AUTHORISED**

---

## 1. Purpose

This document records the business owner's explicit approvals dated **2026-11-19** for the customer-wallet financial architecture. It supersedes the earlier PROPOSED/PENDING labels in the A2/A2.1 documents. It does **not** rewrite the historical A2/A2.1 reports; those remain as audit history with their original text.

**No source code, schema, migration, test, financial transaction, or production configuration was changed.**

---

## 2. Exact Approvals Received

| ID | Decision | Approval status | Date |
|---|---|---|---|
| **W-01** | Two-liability model: `2310 Customer Wallet Funds` + `2300 Unearned Contract Retainers` | **BUSINESS APPROVED** | 2026-11-19 |
| **W-02** | Reuse `payments`/`payment_allocations` for wallet invoice settlement, with compatibility safeguards | **BUSINESS APPROVED** | 2026-11-19 |
| **W-03** | Contract consumption via allocation records + journal; no second wallet debit | **BUSINESS APPROVED** | 2026-11-19 |
| **W-04** | Base-currency wallets only in Phase 1 | **BUSINESS APPROVED** | 2026-11-19 |
| **W-05** | Company-configured and validated `2310` account; no automatic account creation | **TECHNICAL DESIGN ACCEPTED** | 2026-11-19 |
| **W-06** | Refund threshold through `approval_policies`; applied threshold snapshot | **TECHNICAL DESIGN ACCEPTED** | 2026-11-19 |
| **W-07** | Wallet numbering `WLT-YYYY-NNNN`, four-digit minimum, transactionally allocated per company/year | **BUSINESS APPROVED** | 2026-11-19 |
| **W-08** | Frozen blocks debits; closed blocks all new transactions; settlement required before closure | **BUSINESS APPROVED** | 2026-11-19 |
| **AF-A1** | Revenue recognition event | **BUSINESS POLICY SELECTED — FINANCE VALIDATION REQUIRED** | 2026-11-19 |
| **AF-A2** | Tax and COGS treatment | **PENDING — FINANCE/TAX REVIEW REQUIRED** | — |
| **AF-A3** | Contract cancellation refund flow | **BUSINESS APPROVED — FINANCE IMPLEMENTATION VALIDATION REQUIRED** | 2026-11-19 |
| **AF-A4** | Account `2310` | **TECHNICAL VERIFICATION PENDING** | — |
| **AF-A5** | Refund threshold | **BUSINESS POLICY APPROVED (T03) — TECHNICAL VERIFICATION PENDING** | Approved under T03 |
| **AF-A6** | Forfeiture account | **BUSINESS POLICY APPROVED (D-03) — ACCOUNT VERIFICATION PENDING** | Approved under D-03 |
| **D-13** | Customer wallet architecture | **BUSINESS APPROVED** | 2026-11-19 |

**Approval note:** W-05 and W-06 are technical design decisions. They are **not** represented as implemented or configured. AF-A1 is a business policy selection, **not** Finance approval. AF-A3 is a business approval, **not** Finance implementation validation.

---

## 3. Business-Approved Decisions

### 2.1 W-01 — Two-liability model

- `2310 Customer Wallet Funds` — unallocated prepaid funds.
- `2300 Unearned Contract Retainers` — allocated contract funds.
- Deposit: Dr Bank / Cr 2310.
- Contract allocation: Dr 2310 / Cr 2300.
- Contract consumption: Dr 2300 / Cr 4000.
- Wallet invoice payment: Dr 2310 / Cr 1100.
- Refund: Dr 2310 / Cr Bank.
- Forfeiture: Dr 2300 / Cr 4900.

**Status:** BUSINESS APPROVED.

### 2.2 W-02 — Wallet invoice payments

Reuse `payments`/`payment_allocations`, subject to:

- `payments.payment_method` CHECK extended with `Wallet`;
- `recordCustomerPayment` wallet branch;
- no bank row for wallet payments;
- no unapplied wallet remainder;
- `voidCustomerPayment` wallet-aware;
- `recalculateCustomerBalance` remains AR-only;
- invoice balance calculations unchanged.

**Status:** BUSINESS APPROVED. Implementation not performed.

### 2.3 W-03 — Contract consumption

- Consumption is recorded through `customer_wallet_allocations` and the accounting journal.
- **No second wallet debit.**
- Revenue is recognized only at the approved event (AF-A1 Option B: assessment completion).

**Status:** BUSINESS APPROVED.

### 2.4 W-04 — Base-currency wallets

- Phase 1: wallet currency must equal `companies.base_currency`.
- No implicit conversion.
- `currency_code` columns are ready for a future multi-currency phase.

**Status:** BUSINESS APPROVED.

### 2.5 W-07 — Wallet numbering

- `WLT-YYYY-NNNN`, four-digit minimum.
- Transactionally allocated per company/year.
- Natural overflow beyond four digits; no truncation.

**Status:** BUSINESS APPROVED.

### 2.6 W-08 — Frozen and closed wallets

- `frozen`: blocks debits; credits only with approval.
- `closed`: blocks all new transactions; requires:
  - zero balance;
  - no active allocations with remaining > 0;
  - no pending reversals/adjustments;
  - final statement;
  - Accountant approval;
  - audit.

**Status:** BUSINESS APPROVED.

### 2.7 D-13 — Customer wallet architecture

- Dedicated company-wide customer-wallet subledger.
- Double-entry accounting integration.
- Reusable across invoices, sales orders, and Printing Contracts.
- Strict separation from AR and bank/cash balances.

**Status:** BUSINESS APPROVED.

---

## 4. Technical Design Decisions

| ID | Decision | Status | Notes |
|---|---|---|---|
| **W-05** | `2310` configurable and validated per company; no auto-create | **TECHNICAL DESIGN ACCEPTED** | Not implemented/configured. Service must fail `NO_WALLET_LIABILITY_ACCOUNT` if missing/inactive. |
| **W-06** | Refund threshold via `approval_policies`; snapshot applied threshold | **TECHNICAL DESIGN ACCEPTED** | Not implemented/configured. Requires `wallet_refund` action type and policy row. |
| **T-01** | `customers.balance` remains AR | Supported by code | `commercialHelpers.ts:478-521` |
| **T-02** | Wallet tables company-scoped with RLS + FORCE | Supported by code | `db.ts:555-565` |
| **T-03** | All wallet money uses `postJournalEntry` | Supported by code | `accountingEngine.ts:1523-1816` |
| **T-04** | Deposits/refunds create `bank_transactions`; wallet invoice payments do not | Supported by code | `salesService.ts:1625-1656`; `bankingService.ts` |
| **T-05** | Do not persist `bank_transactions.running_balance` | Supported by code | `bankingService.ts:177-181` |
| **T-06** | `payments.payment_method` CHECK must add `Wallet` | Required | `0003:247` |
| **T-07** | `recordCustomerPayment` must add a wallet branch | Required | `salesService.ts:1346-1691` |
| **T-08** | `voidCustomerPayment` must be wallet-aware | Required | `salesService.ts:1693-1771` |
| **T-09** | Contract invoices must not double-post revenue | Required | `salesService.ts:1004-1027`; `printingRecordsService.ts:970-990` |
| **T-10** | Add `invoices.source_type`/`contract_id`/`milestone_number` | Required | `0003:151-190` |
| **T-11** | `companies.timezone` missing | Required | `0001:46-73` |
| **T-12** | Contract status lacks `draft`/`suspended`/`completed` | Required | `0007:134` |
| **T-13** | Approval action types lack wallet/contract actions | Required | `0013`; `0014`; `approvalService.ts:16-25` |
| **T-14** | `request_keys` claim must be concurrency-safe | Required | `accountingEngine.ts:1563-1588`; `commercialHelpers.ts:414-477` |
| **T-15** | No sales-order/portal/offline wallet module | Not applicable | Repository inspection |

---

## 5. Finance / Tax Items Still Outstanding

### AF-A1 — Revenue Recognition

**Status:** `BUSINESS POLICY SELECTED — FINANCE VALIDATION REQUIRED`

**Selected policy (Option B):**
- Assessment completion is the contract revenue-recognition event.
- Assessment completion must not be followed by another revenue posting when the associated contract invoice is generated.
- Contract invoice generation must follow the approved non-duplicating accounting design.
- The exact tax, COGS, and statutory-document treatment remains subject to Finance review.
- This is **not** Finance approval.

**Critical finding preserved:** the current code can double-recognize revenue because assessment completion posts Dr 2300 / Cr 4000 (`printingRecordsService.ts:970-990`) and contract invoice generation posts Dr AR / Cr 4000 (`salesService.ts:1004-1027`). The non-duplicating design must be implemented before any contract invoicing goes live.

### AF-A2 — Tax and COGS

**Status:** `PENDING — FINANCE/TAX REVIEW REQUIRED`

Finance must confirm:
- tax recognition timing;
- contract invoice tax treatment;
- COGS recognition timing;
- whether the proposed non-posting contract invoice is acceptable;
- required statutory document/reporting treatment.

**No Finance approval is implied.**

### AF-A3 — Contract Cancellation Refund

**Status:** `BUSINESS APPROVED — FINANCE IMPLEMENTATION VALIDATION REQUIRED`

**Approved flow (Option B):**
1. Release contract allocation: Dr 2300 / Cr 2310.
2. Refund from wallet: Dr 2310 / Cr Bank.
3. Execute both stages atomically.
4. Record one bank debit.
5. Record one wallet release and one wallet refund.
6. Prevent duplicate credits and refunds.
7. Apply existing cancellation approval, refund destination, and audit requirements.

**Implementation does not exist yet.**

### AF-A4 — Account 2310

**Status:** `TECHNICAL VERIFICATION PENDING`

- No `2310` account exists in the seed chart of accounts.
- Each company must configure an active liability account with `normal_balance='credit'`.
- The wallet service must validate it and fail `NO_WALLET_LIABILITY_ACCOUNT` if missing/inactive.
- **No automatic account creation.**

### AF-A5 — Refund Threshold

**Status:** `BUSINESS POLICY APPROVED — TECHNICAL VERIFICATION PENDING`

- Initial threshold: **K250,000**.
- Refunds **greater than** K250,000 require additional independent approval.
- Refunds **equal to** K250,000 do not exceed the threshold.
- Threshold changes are permission-controlled and audited.
- The applied threshold is snapshotted on the refund/settlement.
- **Technical verification pending:** add `wallet_refund` to `approval_policies`/`approval_requests` CHECKs; seed the policy; store the applied threshold.

### AF-A6 — Forfeiture Account

**Status:** `BUSINESS POLICY APPROVED — ACCOUNT VERIFICATION PENDING`

- Use the existing appropriate Other Income account.
- Seed: `4900 Other Miscellaneous Income`, `account_type='Income'`, `account_subtype='other_income'`, `normal_balance='credit'` (`db.ts:63`).
- No automatic account creation.
- Fail safely if the account is missing or inactive.
- Never silently substitute Printing Revenue (`4000`).
- **Verification pending:** confirm the live company chart of accounts has an active `4900`/`other_income` account.

---

## 6. Technical Verification Items

| ID | Item | Evidence / action | Status |
|---|---|---|---|
| TV-01 | Account `2310` configured per company | No seed row; validate active liability/credit | **PENDING** |
| **TV-02** | Account `4900` active and `other_income` | Seed `db.ts:63`; verify live chart | **PENDING** |
| TV-03 | `payments.payment_method` CHECK add `Wallet` | `0003:247` | **PENDING** |
| TV-04 | `recordCustomerPayment` wallet branch | `salesService.ts:1346-1691` | **PENDING** |
| TV-05 | `voidCustomerPayment` wallet-aware | `salesService.ts:1693-1771` | **PENDING** |
| TV-06 | Contract invoice non-duplicating design | `salesService.ts:1004-1027`; `printingRecordsService.ts:970-990` | **PENDING** |
| TV-07 | `invoices` contract link columns | `0003:151-190` | **PENDING** |
| TV-08 | `companies.timezone` | `0001:46-73` | **PENDING** |
| TV-09 | Contract status `draft`/`suspended`/`completed` | `0007:134` | **PENDING** |
| TV-10 | Approval action types for wallet/contract | `0013`; `0014`; `approvalService.ts:16-25` | **PENDING** |
| TV-11 | `request_keys` concurrency-safe claim | `accountingEngine.ts:1563-1588`; `commercialHelpers.ts:414-477` | **PENDING** |
| TV-12 | PGlite constraint-trigger compatibility | `tests/db/migration-suite.ts` | **PENDING** |
| TV-13 | Wallet schema independent review | Future migration | **PENDING** |
| TV-14 | Legacy preflight under D-12 | `21-...` | **PENDING** |

---

## 7. Implementation Restrictions

- **No source code changes.**
- **No schema changes.**
- **No migration creation or modification.**
- **No Migration 0020 application.**
- **No production migration.**
- **No financial transactions.**
- **No historical financial conversion.**
- **No production accounting configuration changes.**
- **No commits.**
- **Preserve all pre-existing user changes.**

---

## 8. Remaining Phase A3 Entry Conditions

Phase A3 remains **NOT AUTHORISED** until all of the following are complete:

1. **AF-A2** Finance/tax review complete.
2. **AF-A1** Finance validation complete.
3. **AF-A4** Account `2310` configuration verified.
4. **AF-A5** Refund threshold technical policy verified.
5. **AF-A6** Account `4900` verified against the live chart of accounts.
6. **Independent schema and migration design review** completed.
7. **Separate explicit implementation authorisation** recorded.
8. **Wallet migration approved for application** (separate gate; Migration 0020 remains unapplied).
9. **Legacy preflight** executed and signed off under D-12.
10. **Test plan** approved.

---

## 9. Document Control

### Updated

| File | Update |
|---|---|
| `11-FINAL-BUSINESS-DECISION-REGISTER.md` | W-01…W-08 approved/accepted; AF-A1…AF-A6 statuses; Phase A3 not authorised |
| `18-CUSTOMER-WALLET-ARCHITECTURE.md` | A2.2 approval addendum |
| `19-CUSTOMER-WALLET-ACCOUNTING-MATRIX.md` | A2.2 approval addendum; AF-A1/AF-A3 decisions |
| `20-CUSTOMER-WALLET-INTEGRATION-PLAN.md` | A2.2 approval addendum |
| `22-PHASE-A2-FINANCIAL-ARCHITECTURE-VERIFICATION.md` | A2.2 approval addendum |
| `23-PHASE-A2.1-DECISION-CLOSURE-REPORT.md` | A2.2 approval addendum; historical A2.1 text preserved |

### Created

| File | Purpose |
|---|---|
| `24-PHASE-A2.2-BUSINESS-APPROVAL-RECORD.md` | This approval record |

### Preserved

- `00`–`10` Phase 0/Stage 2 documents.
- `11` historical proposal text (with current status updated).
- `12`–`17` A1/A2 documents.
- `18`–`23` historical A2/A2.1 text with addenda.

---

## 10. Final Status

| Item | Status |
|---|---|
| W-01…W-08 | Approved / Technical Design Accepted |
| AF-A1 | Business policy selected (Option B) — Finance validation required |
| AF-A2 | Pending Finance/tax review |
| AF-A3 | Business approved (Option B) — Finance implementation validation required |
| AF-A4 | Technical verification pending |
| AF-A5 | Business policy approved (T03) — technical verification pending |
| AF-A6 | Business policy approved (D-03) — account verification pending |
| D-13 | Business approved |
| Phase A3 | **NOT AUTHORISED** |
| Migration 0020 | **UNWRITTEN AND UNAPPLIED** |
| Source/schema/migration/test/financial changes | **NONE** |
| Commits | **NONE** |

**Phase A2.2 complete. Phase A3 remains blocked pending the conditions in §7.**