# 23 — Phase A2.1 Decision Closure Report

**Date:** 2026-11-19
**Branch:** `fix/printing-contracts-99`
**Base commit:** `933bcf32b9e570f97ef9d2f864274fd64c6d6e08`
**Phase:** A2.1 — Documentation and Design Closure
**Mode:** Documentation only
**Verdict:** **A2.1 COMPLETE — PENDING BUSINESS/FINANCE APPROVAL; A3 NOT AUTHORISED**

---

## A2.2 Approval Addendum (2026-11-19)

The business owner approved the following after the A2.1 report. This addendum supersedes the earlier PROPOSED/PENDING labels; the A2.1 historical verdict remains below.

- **W-01, W-02, W-03, W-04, W-07, W-08:** BUSINESS APPROVED.
- **W-05, W-06:** TECHNICAL DESIGN ACCEPTED (not implemented/configured).
- **AF-A1:** Option B (assessment completion) selected — **BUSINESS POLICY SELECTED — FINANCE VALIDATION REQUIRED**. Contract invoices must not post revenue again.
- **AF-A3:** Option B (release to wallet, then refund) — **BUSINESS APPROVED — FINANCE IMPLEMENTATION VALIDATION REQUIRED**.
- **AF-A2:** **PENDING — FINANCE/TAX REVIEW REQUIRED**.
- **AF-A4:** **TECHNICAL VERIFICATION PENDING**.
- **AF-A5:** **BUSINESS POLICY APPROVED (T03) — TECHNICAL VERIFICATION PENDING**.
- **AF-A6:** **BUSINESS POLICY APPROVED (D-03) — ACCOUNT VERIFICATION PENDING**.
- **Phase A3: NOT AUTHORISED.**

See `24-PHASE-A2.2-BUSINESS-APPROVAL-RECORD.md` for the full approval record.

---

## 1. Executive Summary

Phase A2.1 reviewed the A2 wallet architecture, hardened the accounting design, and closed the W-01…W-08 decision set as **proposed pending approval**.

The review found one **critical accounting defect** and several compatibility requirements:

- **Critical:** contract milestone invoices can double-recognize revenue. Assessment completion posts Dr 2300 / Cr 4000, and contract invoice generation posts Dr AR / Cr 4000 regardless of contract source. Finance must choose one revenue event and make the other path non-revenue.
- **Compatibility:** the existing `payments` model can support wallet-funded invoice payments only after extending the payment-method CHECK, adding a wallet branch to `recordCustomerPayment`, making `voidCustomerPayment` wallet-aware, and preventing unapplied wallet remainders.
- **Refund flow:** contract cancellation refunds can be direct (Dr 2300 / Cr Bank) or release-to-wallet then refund (Dr 2300 / Cr 2310; Dr 2310 / Cr Bank). Finance must choose; Option B is recommended for a unified wallet statement.
- **Controls:** negative-balance prevention, wallet locking, frozen/closed semantics, approval, reversal, duplicate prevention, account validation, and closure prerequisites are specified.

**No code, schema, migration, test, or financial transaction was changed. No commit was created.**

---

## 2. W-01…W-08 Disposition

| ID | Proposed decision | Status | Disposition |
|---|---|---|---|
| **W-01** | Two-liability model: `2310 Customer Wallet Funds` + `2300 Unearned Contract Retainers` | **PROPOSED — PENDING** | Recommended; preserves contract liability and D-10 |
| **W-02** | Reuse `payments`/`payment_allocations` for wallet invoice settlement | **PROPOSED — PENDING** | Technically viable only with the changes in §6 |
| **W-03** | Contract consumption via allocation records + journal; no second wallet debit | **PROPOSED — PENDING** | Recommended; avoids double-counting |
| **W-04** | Base-currency wallets only in Phase 1 | **PROPOSED — PENDING** | Recommended; `currency_code` ready for future |
| **W-05** | `2310` configurable/validated per company; no auto-create | **TECHNICAL — SUPPORTED** | No business approval required; repository evidence supports it |
| **W-06** | Refund threshold via `approval_policies`; snapshot applied threshold | **TECHNICAL — SUPPORTED** | `approval_policies`/`approval_requests` exist |
| **W-07** | `WLT-YYYY-NNNN`, four-digit minimum, company/year counter | **PROPOSED — PENDING** | Recommended; natural overflow |
| **W-08** | Frozen blocks debits; credits require approval; closed blocks all and requires settlement | **PROPOSED — PENDING** | Recommended; closure prerequisites specified |

**No W-01…W-08 decision is approved.** W-05/W-06 are technical decisions supported by evidence, not business approvals.

---

## 3. Approved Business Decisions (Baseline)

The following were approved in the Phase A2 decision register and remain binding:

| ID | Decision |
|---|---|
| D-01 | Currency: Malawi MWK, symbol K, source `companies.base_currency` |
| D-02 | Cancellation: authorised, reason, refund/forfeit, second-person approval, Finance destination, threshold |
| D-03 | Forfeiture: existing Other Income account, fail safely, no Printing Revenue substitution |
| D-04 | Top-ups: active auto, suspended approval, completed not reopened, cancelled rejected, no double count |
| D-05 | Completion: all assessments complete; funding exhaustion blocks allocation, not lifecycle |
| D-06 | Colour: one contract-level setting, inherited by assessments, no override |
| D-07 | Roles: Administrator, Accountant (Finance), Contract Manager; separate operational/financial |
| D-08 | Timezone: company-configured, default Africa/Blantyre, UTC storage |
| D-09 | Renewal/reactivation: no reactivation; renewal is a new contract |
| D-10 | Draft → activation with signature, exact allocation, sufficient wallet funds |
| D-11 | Numbering: preserve formats, 2-digit contract minimum, 4-digit exam minimum |
| D-12 | Legacy: read-only preflight, quarantine, no automatic correction |
| D-13 | Customer wallet: dedicated company-wide subledger, two-liability model |

These are **approved**. The W-01…W-08 decisions below are **not** approved.

---

## 4. Proposed Decisions Pending Business Approval

| ID | Decision | Why it needs approval | Recommended default |
|---|---|---|---|
| W-01 | Two-liability model | Changes contract deposit/allocation accounting | 2310 + 2300 |
| W-02 | Wallet invoice payments via `payments` | Adds a new payment method and changes the payment service | Extend `payments` with `Wallet` |
| W-03 | Contract consumption recording | Confirms no second wallet debit | Allocation + journal only |
| W-04 | Base-currency wallets | Limits Phase 1 scope | Base-only |
| W-07 | Wallet numbering | Customer-facing format | `WLT-YYYY-NNNN` |
| W-08 | Frozen/closed semantics | Operational policy | Frozen blocks debits; closed blocks all |

**Approval required before A3.**

---

## 5. Technical Decisions Supported by Repository Evidence

These do not require business approval; they are implementation constraints proven by the code:

| ID | Technical decision | Evidence |
|---|---|---|
| T-01 | `customers.balance` remains AR; wallet is separate | `commercialHelpers.ts:478-521` |
| T-02 | Wallet tables must be company-scoped with RLS + FORCE | `db.ts:555-565`; migrations |
| T-03 | All wallet money uses `postJournalEntry` | `accountingEngine.ts:1523-1816` |
| T-04 | Deposits/refunds create `bank_transactions` rows; wallet invoice payments do not | `salesService.ts:1625-1656`; `bankingService.ts` |
| T-05 | Do not persist `bank_transactions.running_balance` | `bankingService.ts:177-181` |
| T-06 | `payments.payment_method` CHECK must be extended for `Wallet` | `0003:247` |
| T-07 | `recordCustomerPayment` currently validates a Bank/OtherCurrentAsset account | `salesService.ts:1391-1397` |
| T-08 | `voidCustomerPayment` currently only reverses the journal and voids bank rows | `salesService.ts:1693-1771` |
| T-09 | `recalculateCustomerBalance` is AR-only | `commercialHelpers.ts:478-521` |
| T-10 | Contract invoices currently post Dr AR / Cr Revenue | `salesService.ts:1004-1027` |
| T-11 | Assessment completion currently posts Dr 2300 / Cr 4000 | `printingRecordsService.ts:970-990` |
| T-12 | Production completion/delivery do not post contract revenue | `productionService.ts` (WIP/COGS only) |
| T-13 | `approval_requests` supports maker-checker and thresholds | `0013`; `approvalService.ts:496-508` |
| T-14 | `request_keys` supports route-level idempotency | `0001:190-204` |
| T-15 | No sales-order, portal, or offline wallet module exists | repository inspection |

---

## 6. Accounting Corrections

### 6.1 Critical: contract invoice double-recognition

**Current:**
- Assessment completion: Dr 2300 / Cr 4000.
- Contract invoice: Dr AR / Cr 4000.
- Result: potential double revenue.

**Correction:** choose one revenue event:

- **Option A:** contract invoice/receipt is the revenue event; assessment completion only updates status/remaining; contract invoice posts Dr 2300 / Cr 4000 with no AR.
- **Option B (recommended, least invasive):** assessment completion is the revenue event; contract invoice is a **nil-GL receipt** with no AR/revenue/COGS.
- **Option C:** production completion/delivery/acceptance (not current).

**Never both.** Add `invoices.source_type`, `source_ref`, `contract_id`, `milestone_number` to identify contract invoices.

### 6.2 Deposit vs allocation

- Deposit: Dr Bank / Cr 2310; wallet **+**.
- Allocation: Dr 2310 / Cr 2300; wallet **−**, contract **+**.
- No cash at allocation.
- No second deposit at allocation.

### 6.3 Contract top-up

- Dr Bank / Cr 2310; then Dr 2310 / Cr 2300.
- Wallet `deposit` + `allocation`.
- One bank Deposit row.

### 6.4 Contract cancellation refund

- Option A: Dr 2300 / Cr Bank; allocation released; contract remaining 0.
- Option B: Dr 2300 / Cr 2310 (release); Dr 2310 / Cr Bank (refund); one transaction.
- No duplicate credit.

### 6.5 Contract forfeiture

- Dr 2300 / Cr 4900 Other Miscellaneous Income.
- No bank row.
- Allocation `forfeited_amount`; contract remaining 0.

### 6.6 Reversals and adjustments

- New compensating entries; original immutable.
- Approval required.
- Adjustments require a reason and approved counter-account.

### 6.7 Sales-order payments

- No sales-order module exists.
- Future `sales_order_payment`: Dr 2310 / Cr order liability/AR; no bank.

---

## 7. Revenue Recognition Findings

### 7.1 Current implementation

- **Assessment completion** is the only event that posts contract revenue (`printingRecordsService.ts:970-990`).
- **Production completion, delivery, and customer acceptance** do not post contract revenue.
- **Invoice creation** posts revenue for every invoice (`salesService.ts:1004-1027`), including contract milestone invoices.
- **Allocation, job creation, and invoice generation** do not themselves earn revenue under the current assessment-completion model, but **invoice generation double-counts** because the invoice path posts revenue again.

### 7.2 Approved event?

The approved decisions (D-05, D-13) do **not** explicitly name the revenue recognition event. The current code uses assessment completion, but this is not documented as an approved accounting policy.

**AF-A1 (OPEN):** Finance/business owner must confirm:
- revenue at assessment completion;
- revenue at contract invoice/receipt;
- revenue at production completion/delivery/acceptance.

**AF-A2 (OPEN):** Finance/tax must confirm:
- sales tax treatment for contract invoices;
- COGS treatment (production WIP relief vs invoice COGS);
- whether a nil-GL receipt is acceptable for tax invoicing.

### 7.3 Recommendation

**Option B** (assessment completion + nil-GL contract receipt) is the least invasive and preserves current revenue timing. **Option A** (revenue at contract invoice) is cleaner for tax invoicing but requires a contract-funded invoice path.

**Until AF-A1 is approved, contract milestone invoices must not post Dr AR / Cr 4000.**

---

## 8. Payment Compatibility Findings

### 8.1 Current model

- `payments` (`0003:240-264`): `payment_method` CHECK five values; `deposit_to_account_id` NOT NULL; `journal_txn_id`; `deposited_bank_txn_id` (0011); currency/FX columns (0010).
- `payment_allocations` (`0003:274-286`): unique `(payment_id, invoice_id)`.
- `recordCustomerPayment` (`salesService.ts:1346-1691`): locks customer/invoice; validates Bank/OtherCurrentAsset; allocates; posts Dr Bank / Cr AR; inserts bank row; recalculates AR.
- `voidCustomerPayment` (`salesService.ts:1693-1771`): reverses journal; voids bank rows; restores invoice balances; marks payment voided; recalculates AR.

### 8.2 Required changes

1. Extend `payments.payment_method` CHECK with `Wallet`.
2. Add `fundingSource='wallet'` to `recordCustomerPayment`:
   - validate wallet;
   - skip bank validation;
   - use `wallet.liability_account_id`;
   - Dr 2310 / Cr 1100;
   - no bank row;
   - `deposited_bank_txn_id=NULL`;
   - wallet `invoice_payment` debit;
   - normal allocations;
   - no unapplied remainder.
3. Make `voidCustomerPayment` wallet-aware:
   - reverse wallet transaction;
   - restore invoice balances;
   - mark payment voided;
   - no bank row.
4. `recalculateCustomerBalance` remains AR-only.
5. Existing payment methods unchanged.
6. Invoice balance calculations unchanged.
7. Add `invoices.source_type`/`contract_id` for contract invoice identification.

### 8.3 Compatibility conclusion

**W-02 is technically viable** with these changes. Without them, wallet invoice payments would fail the bank-account validation or create an incorrect bank journal.

---

## 9. Refund-Flow Findings

### 9.1 Contract cancellation refund

- **Option A — direct:** Dr 2300 / Cr Bank; allocation released; contract remaining 0; one bank Debit row.
- **Option B — release then refund (recommended):** Dr 2300 / Cr 2310; Dr 2310 / Cr Bank; one transaction; wallet `release` + `refund`; one bank Debit row.
- **No duplicate credit:** allocation released once, wallet credited once, refund debited once, bank debited once.

**AF-A3 (OPEN):** Finance must choose Option A or B.

### 9.2 Unallocated wallet refund

- Dr 2310 / Cr Bank; bank Debit; wallet `refund` debit.
- Approval + threshold.

### 9.3 Top-up

- Dr Bank / Cr 2310; Dr 2310 / Cr 2300; one bank Deposit row.
- No double counting.

---

## 10. Wallet Control Hardening

| Control | Design |
|---|---|
| Negative balance | `CHECK (balance >= 0)`; wallet `FOR UPDATE`; reject `INSUFFICIENT_WALLET_FUNDS` |
| Atomic spending | claim → lock → validate → tx → balance → mutate → journal → bank → audit → response |
| Concurrency | wallet row lock; unique idempotency; unique reference; 40001 → 409; no takeover |
| Frozen | blocks debits; credits only with approval |
| Closed | blocks all; requires zero balance, no active allocations, no pending reversals, final statement, approval |
| Adjustment | approval, reason, approved counter-account |
| Reversal | new row, `reverses_txn_id`, compensating journal, approval |
| Duplicate prevention | unique idempotency + reference + invoice/contract checks |
| Account validation | active liability, credit normal, company-scoped; no auto-create; `NO_WALLET_LIABILITY_ACCOUNT` |
| Multi-company | RLS + composite FKs + `withCompanyDb` |
| Currency | base-only Phase 1; no implicit conversion |
| Closure prerequisites | zero balance, no active allocations, no pending reversals, final statement, approval |

---

## 11. Updated Documents

| File | Update |
|---|---|
| `11-FINAL-BUSINESS-DECISION-REGISTER.md` | Added D-13 and W-01…W-08 section (PROPOSED — PENDING) |
| `18-CUSTOMER-WALLET-ARCHITECTURE.md` | Added §14.1 decision closure, §14.2 control hardening, §14.3 refund/top-up, §14.4 payment compatibility |
| `19-CUSTOMER-WALLET-ACCOUNTING-MATRIX.md` | Added §2.1 revenue recognition correction, §2.2 deposit vs allocation, §2.3 refund flows |
| `20-CUSTOMER-WALLET-INTEGRATION-PLAN.md` | Added §3.3.1 payment compatibility, contract refund/top-up and revenue dependency |
| `21-CUSTOMER-WALLET-LEGACY-RECONCILIATION.md` | Added §7.3.1 contract invoice revenue risk; confirmed no conversion |
| `22-PHASE-A2-FINANCIAL-ARCHITECTURE-VERIFICATION.md` | Added §17 A2.1 addendum; updated verdict |
| `23-PHASE-A2.1-DECISION-CLOSURE-REPORT.md` | This report |

---

## 12. Outstanding Approvals

### 12.1 Business decisions

| ID | Decision | Status |
|---|---|---|
| W-01 | Two-liability model | **PENDING** |
| W-02 | Wallet invoice payments via `payments` | **PENDING** |
| W-03 | Contract consumption recording | **PENDING** |
| W-04 | Base-currency wallets | **PENDING** |
| W-07 | Wallet numbering | **PENDING** |
| W-08 | Frozen/closed semantics | **PENDING** |

### 12.2 Finance / accounting decisions

| ID | Decision | Status |
|---|---|---|
| AF-A1 | Revenue recognition event | **OPEN** |
| AF-A2 | Contract invoice tax and COGS | **OPEN** |
| AF-A3 | Contract cancellation refund flow | **OPEN** |
| AF-A4 | `2310` account code/configuration | **OPEN** |
| AF-A5 | Refund threshold/approval policy | **OPEN** |
| AF-A6 | Forfeiture income account | **OPEN** |

### 12.3 Implementation dependencies

1. Configure `2310 Customer Wallet Funds` per company.
2. Extend `payments.payment_method` with `Wallet`.
3. Add wallet branch to `recordCustomerPayment`.
4. Make `voidCustomerPayment` wallet-aware.
5. Add `invoices.source_type`/`contract_id`.
6. Correct contract invoice revenue/COGS treatment.
7. Choose refund flow (AF-A3).
8. Add `companies.timezone`.
9. Add wallet tables/service/endpoints.
10. Add wallet RBAC and audit.
11. Independently review the wallet schema.
12. Run the legacy preflight under D-12.

---

## 13. Phase A2.1 Verdict

**A2.1 COMPLETE — PENDING BUSINESS/FINANCE APPROVAL; A3 NOT AUTHORISED.**

The documentation and design closure are complete. The wallet architecture is sound, the accounting corrections are documented, and the remaining items are approvals and implementation dependencies.

**No source code, schema, migration, test, or financial transaction was changed in A2.1. No commit was created. All pre-existing user changes are preserved.**