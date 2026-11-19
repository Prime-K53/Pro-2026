# 22 — Phase A2 Financial Architecture Verification

**Date:** 2026-11-19
**Branch:** `fix/printing-contracts-99`
**Base commit:** `933bcf32b9e570f97ef9d2f864274fd64c6d6e08`
**Phase:** A2 — Financial Architecture (documentation only)
**Status:** **COMPLETE — READY FOR BUSINESS/FINANCE REVIEW**
**Implementation:** Not authorised in this phase. No code, schema, migration, or financial transaction was created.

---

## A2.2 Approval Addendum (2026-11-19)

- **W-01, W-02, W-03, W-04, W-07, W-08:** BUSINESS APPROVED.
- **W-05, W-06:** TECHNICAL DESIGN ACCEPTED (not implemented/configured).
- **AF-A1:** Option B (assessment completion) selected — **FINANCE VALIDATION REQUIRED**.
- **AF-A3:** Option B (release to wallet, then refund) — **BUSINESS APPROVED — FINANCE IMPLEMENTATION VALIDATION REQUIRED**.
- **AF-A2:** **PENDING — FINANCE/TAX REVIEW REQUIRED**.
- **AF-A4:** **TECHNICAL VERIFICATION PENDING**.
- **AF-A5:** **BUSINESS POLICY APPROVED (T03) — TECHNICAL VERIFICATION PENDING**.
- **AF-A6:** **BUSINESS POLICY APPROVED (D-03) — ACCOUNT VERIFICATION PENDING**.
- **Phase A3: NOT AUTHORISED.**

This addendum supersedes the earlier PROPOSED/PENDING labels. The historical A2/A2.1 text remains below for audit history.

---

## 1. Executive Summary

Phase A2 designed a **company-wide customer-wallet subledger** for Prime ERP. The design:

- Establishes `customer_wallets`, `customer_wallet_transactions`, and `customer_wallet_allocations`.
- Uses a **two-liability model**: `2310 Customer Wallet Funds` (unallocated) and `2300 Unearned Contract Retainers` (allocated).
- Defines deposits, contract allocations, contract top-ups, wallet-funded invoice payments, contract consumption, refunds, forfeitures, reversals, and adjustments.
- Defines balance invariants, reconciliation, atomicity, idempotency, concurrency control, RBAC, audit, tenant isolation, currency, and timezone.
- Maps integration with customers, invoices, payments, printing contracts, GL, banking, reports, and future sales orders/portal.
- Defines a read-only legacy reconciliation and a **no-automatic-conversion** migration stance.

**Critical verified facts:**

- **No customer wallet exists** in the repository.
- `customers.balance` is **accounts receivable**, not a wallet (`commercialHelpers.ts:478-521`).
- `payments`/`payment_allocations`/`credit_memos` are AR records; unapplied payments are AR credits.
- Contract deposits currently post **Dr Bank / Cr contract liability** (`printingRecordsService.ts:142-161`).
- **No sales-order module, customer portal, or offline wallet service exists.**
- Payment methods are a CHECK constraint on `payments.payment_method` (`0003:247`), not a table.

**A2 verdict:** **COMPLETE — READY FOR BUSINESS/FINANCE REVIEW.** Implementation remains blocked until the W-01…W-08 design decisions are approved, the wallet schema is independently reviewed, and migration application is separately authorised.

---

## 2. Repository Evidence Inspected

| Area | Evidence | Finding |
|---|---|---|
| Customer master | `db/migrations/0003...up.sql:6-31`; `customers.balance` at 20 | `balance` is a single numeric column |
| AR calculation | `src/server/services/commercialHelpers.ts:478-521` | `open invoices − credit memos − unapplied payments` |
| Payments | `0003:240-264`; `payment_method` CHECK at 247 | Five methods; no `Wallet` |
| Payment allocations | `0003:274-286` | Links payments to invoices |
| Credit memos | `0003:295-326` | AR credits with `remaining_credit` |
| Customer payment service | `salesService.ts:1346-1691` | Locks customer/invoice; Dr Bank / Cr AR; bank row; recalculates AR |
| Bank subledger | `0004:348-395`; `0010:216-227` | `journal_txn_id`, `status`, `txn_type`, `customer_id` |
| Bank running balance | `bankingService.ts:177-181` | Computed on read; do not persist |
| Chart of accounts | `db.ts:41-76` | `1010` bank, `1100` AR, `2300` contract liability, `4000` revenue, `4900` other income; **no `2310`** |
| Journal engine | `accountingEngine.ts:1523-1816` | Balanced, period-locked, idempotent |
| Idempotency | `0001:190-204`; `accountingEngine.ts:1563-1588`, `1788-1795` | `request_keys` + journal unique index |
| Approvals | `0013:11-94`; `0014`; `approvalService.ts:16-25`, `253-404`, `496-508` | Maker-checker, thresholds, no self-approval |
| Audit | `0006:436-450`; `audit.ts:17-40` | Append-only, SHA-256 |
| Storage | `0006:345-375` | `stored_files` + `attachments` |
| Contract service | `printingRecordsService.ts:74-270`, `933-1040`, `1042-1073` | Create active + deposit; complete clamps; wallet view reads bank |
| Contract schema | `0007:118-202` | No draft/completed/suspended, no currency/colour/settlement |
| Sales orders | No `sales_orders` table; no `salesOrderService.ts` | Not applicable |
| Customer portal | No `/portal` route | Not applicable |
| Offline | Only `SettingsView.tsx:395` browser working copy note | No offline wallet |
| Permissions | `permissions.ts:60-61`, `147-190`, `226-256` | `printing:read/write`; no wallet permissions |
| RLS | `db.ts:555-565`; migrations | `pms_app_role`, `app.current_company_id`, forced RLS |
| Timezone | No `companies.timezone`; `commercialHelpers.ts:54-56` UTC | Gap |
| Currency | `companies.base_currency` default ZMW (`0001:59`); `db.ts:151` | Company-level; no contract currency |

---

## 3. Verified Financial Distinctions

| Concept | Authoritative store | Not this |
|---|---|---|
| Customer prepaid wallet | **Does not exist yet** — proposed `customer_wallets` | Not `customers.balance` |
| Accounts receivable | `customers.balance`, `invoices.balance_due`, `payments`, `credit_memos` | Not a wallet |
| Bank/cash | `bank_transactions`, bank/cash `accounts` | Not a wallet |
| Contract allocated funds | `printing_contracts.remaining_balance`, `customer_wallet_allocations` | Not unallocated wallet |
| Invoice balance | `invoices.balance_due` | Not a wallet |
| Unapplied payment | `payments.amount − SUM(payment_allocations.amount)` | AR credit, not wallet |

**No automatic equivalence is permitted.**

---

## 4. Proposed Wallet Architecture

### 4.1 Tables

| Table | Purpose | Key constraints |
|---|---|---|
| `customer_wallets` | One wallet per customer/currency; cached unallocated balance | `UNIQUE (company_id, customer_id, currency_code)`; `balance >= 0`; RLS + FORCE |
| `customer_wallet_transactions` | Append-only wallet ledger | Immutable; unique idempotency; unique `(reference_type, reference_id, txn_type)`; RLS + FORCE |
| `customer_wallet_allocations` | Funds allocated to contracts/invoices/orders | `consumed + released + forfeited <= amount`; unique contract/invoice+wallet; RLS + FORCE |
| `company_settings` keys | Wallet configuration | `wallet_enabled`, `wallet_liability_account_code`, `wallet_refund_threshold`, etc. |
| `request_keys` | Idempotency | Existing |
| `approval_policies`/`approval_requests` | Refund/reversal/adjustment approvals | Existing; extend action types |
| `audit_log` | Wallet audit | Existing |
| `stored_files`/`attachments` | Statements/evidence | Existing |

### 4.2 Wallet transaction types

`deposit`, `allocation`, `release`, `invoice_payment`, `sales_order_payment`, `refund`, `reversal`, `adjustment`, plus `forfeit` at the contract level.

### 4.3 Balance model

- **Unallocated wallet balance** = `SUM(credits) − SUM(debits)` from wallet transactions.
- **Allocation remaining** = `amount − consumed − released − forfeited`.
- **Total customer funds** = unallocated + allocation remaining.
- **GL:**
  - `2310` = `SUM(customer_wallets.balance)`.
  - `2300` = `SUM(allocation.remaining)`.
  - `1100` = AR (unchanged).

### 4.4 Invariants

1. `customer_wallets.balance >= 0`.
2. `customer_wallets.balance = SUM(posted credits − debits)`.
3. `consumed + released + forfeited <= amount`.
4. `contract.remaining_balance = allocation.remaining`.
5. `2310 GL = SUM(wallet balances)`.
6. `2300 GL = SUM(allocation remaining)`.
7. Every wallet transaction has a journal (except pure allocation/consumption records).
8. Deposits/refunds have a bank row.
9. No posted wallet transaction is updated/deleted.
10. No cross-company wallet.

---

## 5. Accounting Model

| Event | Debit | Credit | Bank | Contract | Revenue |
|---|---|---|---|---|---|
| Deposit | Bank | 2310 | Deposit row | — | — |
| Contract allocation | 2310 | 2300 | — | Allocation + | — |
| Contract top-up | Bank → 2310; 2310 → 2300 | — | Deposit row | Allocation + | — |
| Wallet invoice payment | 2310 | 1100 | **None** | — | — |
| Contract consumption | 2300 | 4000 | — | Remaining − | **Yes** |
| Unallocated refund | 2310 | Bank | Debit row | — | — |
| Contract refund | 2300 → 2310; 2310 → Bank | — | Debit row | Remaining 0 | — |
| Forfeiture | 2300 | 4900 | — | Remaining 0 | Other income |
| Reversal | Opposite | Opposite | Depends | Reverses | Reverses |
| Adjustment | Approved | Approved | — | — | — |

**Key:** contract activation/allocation reclassifies liability; it does not create cash. Revenue is recognized only on contract consumption.

---

## 6. Atomicity, Idempotency, Concurrency

### 6.1 Atomicity

One `db.withCompanyDb` transaction includes:

1. idempotency claim;
2. wallet lock/balance check;
3. wallet transaction;
4. allocation/payment/invoice/contract mutation;
5. `postJournalEntry`;
6. bank row (deposits/refunds);
7. audit;
8. stored response.

### 6.2 Idempotency

- Same-transaction claim (`request_keys`).
- Unique `(company_id, idempotency_key)`.
- Same key + same payload → replay.
- Same key + different payload → `409 IDEMPOTENCY_CONFLICT`.
- In-progress → `409 IDEMPOTENCY_IN_PROGRESS`; no takeover.
- Unique `(company_id, reference_type, reference_id, txn_type)` prevents duplicate deposits/allocations.

### 6.3 Concurrency

- Lock order: **wallet → allocation → contract/invoice → journal/bank → audit**.
- `SELECT ... FOR UPDATE` on the wallet before reading balance.
- `balance_after` computed under the lock.
- `CHECK (balance >= 0)` prevents overspend.
- `40001` → 409; bounded retry.

---

## 7. Integration Summary

| Module | Integration | Status |
|---|---|---|
| Customer Management | Wallet summary/tab; `GET /api/customers/:id/wallet` | Proposed |
| Invoices | Wallet-funded payment via `payments.payment_method='Wallet'`; Dr 2310 / Cr 1100; no bank row | Proposed |
| Receive Payment | Wallet funding source; backend balance authoritative | Proposed |
| Sales Orders | No module exists; future `sales_order_payment` | Not applicable |
| Printing Contracts | Activation allocates; top-up; consumption; cancel release/forfeit | Proposed |
| Accounting/GL | `2310`/`2300`; journals; reconciliation | Proposed |
| Banking | Deposit/refund bank rows; no bank row for wallet invoice payments | Proposed |
| Customer Portal | No module exists | Not applicable |
| Reports/Statements | Wallet statement, aging, reconciliation | Proposed |
| Offline/Sync | No offline wallet; server-only | Not applicable |

**One authoritative `customerWalletService`** must be used by all modules. No module may maintain a separate wallet balance.

---

## 8. Permissions and Audit

### 8.1 Proposed permissions

`wallet:read`, `wallet:transactions:read`, `wallet:deposit`, `wallet:allocate`, `wallet:apply`, `wallet:refund`, `wallet:reverse`, `wallet:adjust`, `wallet:reconcile`, `wallet:configure`.

### 8.2 Role mapping

- Administrator: all.
- Accountant: all financial.
- Contract Manager: read only; no financial wallet authority.
- Bookkeeper: read only (no financial authority).
- Production Manager: read only.
- Read-Only: read.

### 8.3 Approvals

- `wallet_refund`, `wallet_reversal`, `wallet_adjustment`, `wallet_writeoff`.
- Threshold default K250,000 (T03).
- Requester cannot approve own request.
- Store threshold applied.

### 8.4 Audit

Every wallet transaction logs actor, company, customer, wallet, amount, currency, type, reference, journal, bank, approval, reason, before/after balance.

---

## 9. Tenant Isolation and RLS

- All wallet tables company-scoped.
- Composite FKs `(company_id, ...)`.
- `ENABLE` + `FORCE` RLS + `app_rls_allowed(company_id)`.
- `db.withCompanyDb` sets role, bypass off, current company.
- Number counters company-scoped.
- Reconciliation queries include `company_id`.
- No cross-company wallet access.

---

## 10. Currency and Timezone

- `currency_code` on wallets/transactions/allocations.
- Phase 1: base-currency wallets only; `wallet_currency_mode='base_only'`.
- No implicit conversion; foreign currency requires explicit account/rate.
- `TIMESTAMPTZ` stored UTC; display in `companies.timezone` (to be added; default `Africa/Blantyre`).
- No UTC ISO slicing for business dates.

---

## 11. Legacy Data

- No historical wallet records.
- `customers.balance` = AR.
- Unapplied payments = AR credits.
- Contract deposits/remaining = contract liabilities.
- Bank rows = bank subledger.
- **Default: wallets start at zero.**
- Optional approved conversion of unapplied payments requires:
  - customer agreement;
  - `Dr 1100 / Cr 2310`;
  - a `payments.wallet_conversion_txn_id` or equivalent to prevent AR double-counting;
  - audit.
- No automatic conversion or historical correction.

---

## 12. Architecture Diagram

```
Customer
  │
  ├── AR (invoices, credit memos, payments, customers.balance)
  │
  └── Customer Wallet (customer_wallets)
        ├── customer_wallet_transactions (append-only)
        │     ├── deposit ── Dr Bank / Cr 2310 ── bank_transactions
        │     ├── allocation ─ Dr 2310 / Cr 2300
        │     ├── invoice_payment ─ Dr 2310 / Cr 1100
        │     ├── refund ─ Dr 2310 / Cr Bank ── bank_transactions
        │     ├── reversal ─ compensating
        │     └── adjustment ─ approved
        │
        └── customer_wallet_allocations
              ├── contract allocation ── printing_contracts
              ├── invoice allocation ── invoices
              └── sales_order allocation (future)

GL:
  1010 Bank
  1100 AR
  2310 Customer Wallet Funds
  2300 Unearned Contract Retainers
  4000 Printing & Sales Revenue
  4900 Other Miscellaneous Income
```

---

## 13. Risks and Dependencies

| ID | Risk / dependency | Severity | Mitigation |
|---|---|---|---|
| A2-R1 | No `2310` account configured | High | Explicit configuration; fail `NO_WALLET_LIABILITY_ACCOUNT`; no auto-create |
| A2-R2 | `payments.payment_method` CHECK rejects `Wallet` | High | Migration extends CHECK |
| A2-R3 | `recordCustomerPayment` assumes bank funding | High | Wallet branch; skip bank validation/row |
| A2-R4 | Contract deposit posting changes from 2300 to 2310→2300 | High | Finance approval; migration + tests |
| A2-R5 | `customers.balance` accidentally includes wallet | High | Keep AR calculation separate; test |
| A2-R6 | Double-counted contract funds | High | Unique allocation; wallet + contract lock; reconciliation |
| A2-R7 | Overspend | High | Wallet lock + `CHECK (balance >= 0)` |
| A2-R8 | Duplicate deposit/payment | High | Idempotency + unique reference |
| A2-R9 | Refund threshold bypass | High | Approval policy + stored threshold |
| A2-R10 | Cross-company access | High | RLS + composite FKs |
| A2-R11 | Legacy AR converted silently | High | No automatic conversion; D-12 |
| A2-R12 | Multi-currency implicit conversion | Medium | Base-only Phase 1 |
| A2-R13 | Offline false balance | Medium | No offline wallet |
| A2-R14 | "Contract Wallet" UI confusion | Medium | Rename to "Contract Funding"/"Bank Transactions" |
| A2-R15 | No sales-order module | Low | Mark not applicable; future design |
| A2-R16 | No customer portal | Low | Mark not applicable; future design |
| A2-R17 | No timezone column | Medium | Add `companies.timezone` in a later migration |
| A2-R18 | No SMS/OTP provider | Medium | Separate T04 dependency; email only |

---

## 14. Unresolved Technical Questions / Decisions

| ID | Decision | Recommended default |
|---|---|---|
| W-01 | Two-liability model vs single liability | Two-liability (2310 + 2300) |
| W-02 | Wallet invoice payment via `payments` vs separate table | Extend `payments.payment_method='Wallet'` |
| W-03 | Record contract consumption in wallet transactions vs allocation table | Allocation table only; wallet balance unchanged |
| W-04 | Phase 1 multi-currency vs base-only | Base-only |
| W-05 | Wallet liability account code | `2310` |
| W-06 | Refund threshold storage | `approval_policies` for `wallet_refund`; store applied threshold |
| W-07 | Wallet transaction numbering | `WLT-YYYY-NNNN`, 4-digit minimum |
| W-08 | Frozen wallet semantics | Frozen blocks debits; credits only with approval; closed blocks all |

**These must be approved before A3.**

---

## 15. Test Strategy

| Area | Tests |
|---|---|
| Deposit | Bank/cash/mobile; duplicate; missing account; negative; cross-company |
| Allocation | Sufficient/insufficient; contract status; duplicate; concurrency |
| Invoice payment | Wallet funding; no bank row; partial; duplicate; FX |
| Consumption | Allocation/contract remaining; no auto-deduct on job/invoice |
| Refund | Approval; threshold; destination; duplicate; insufficient |
| Forfeiture | 2300/4900; no bank; approval |
| Reversal | Compensating; original immutable; insufficient |
| Adjustment | Approval; reason; account validation |
| Reconciliation | 2310 vs wallets; 2300 vs allocations; 1100 AR unchanged |
| Concurrency | 10 parallel deposits/payments/allocations; no overspend |
| Idempotency | Same/different payload; concurrent; retry |
| Tenant | Cross-company denied |
| Audit | Every transaction logged |
| Legacy | No AR/bank/contract auto-conversion |

---

## 16. Documents Produced

| File | Purpose |
|---|---|
| `18-CUSTOMER-WALLET-ARCHITECTURE.md` | Domain model, schema, lifecycle, invariants, reconciliation |
| `19-CUSTOMER-WALLET-ACCOUNTING-MATRIX.md` | Debit/credit for every transaction type |
| `20-CUSTOMER-WALLET-INTEGRATION-PLAN.md` | Module integration, API, migration sequence |
| `21-CUSTOMER-WALLET-LEGACY-RECONCILIATION.md` | Read-only legacy classification, no auto conversion |
| `22-PHASE-A2-FINANCIAL-ARCHITECTURE-VERIFICATION.md` | This verification report |
| `11-FINAL-BUSINESS-DECISION-REGISTER.md` | D-13 added |

---

## 17. A2.1 Addendum — Decision Closure and Accounting Hardening

### 17.1 Revenue Recognition — Critical Finding

**Verified current flow:**

1. Assessment completion posts **Dr 2300 / Cr 4000** (`printingRecordsService.ts:970-990`).
2. Contract milestone invoice generation posts **Dr AR / Cr 4000** (`salesService.ts:1004-1027`) regardless of contract source.
3. Production completion/delivery/customer acceptance do not post contract revenue.

**Defect:** a completed assessment that is then invoiced can recognize revenue **twice**.

**Required correction (Finance decision AF-A1/AF-A2):**

- Choose one revenue event:
  - **Option A:** contract invoice/receipt; assessment completion updates status/remaining only; contract invoice posts Dr 2300 / Cr 4000 with no AR.
  - **Option B (recommended, least invasive):** assessment completion (current); contract invoice is a **nil-GL receipt** with no AR/revenue/COGS.
  - **Option C:** production completion/delivery/acceptance (not current).
- **Never allow both assessment completion and contract invoice to post revenue.**
- Add `invoices.source_type`, `invoices.source_ref`, `invoices.contract_id`, `invoices.milestone_number` to identify contract invoices.
- Finance/tax must confirm sales tax and COGS treatment (AF-A2).

**Status:** **UNRESOLVED — Finance approval required.**

### 17.2 Invoice Payment Compatibility (W-02)

The existing `payments` model can support wallet-funded invoice payments only with:

1. `payments.payment_method` CHECK extended with `Wallet` (`0003:247`).
2. `recordCustomerPayment` wallet branch (`salesService.ts:1346-1691`):
   - validate wallet balance;
   - skip Bank/OtherCurrentAsset validation (`1391-1397`);
   - use `wallet.liability_account_id`;
   - post Dr 2310 / Cr 1100;
   - no `bank_transactions` row;
   - `deposited_bank_txn_id = NULL`;
   - wallet `invoice_payment` debit;
   - normal `payment_allocations`;
   - no unapplied remainder.
3. `voidCustomerPayment` wallet-aware (`salesService.ts:1693-1771`):
   - reverse the wallet transaction;
   - restore invoice balances;
   - mark payment voided;
   - no bank row to void.
4. `recalculateCustomerBalance` remains AR-only (`commercialHelpers.ts:478-521`).
5. Existing payment methods unchanged.
6. Invoice balance calculations unchanged.

**Status:** technically viable; **implementation required in Phase A3**. W-02 remains proposed pending approval.

### 17.3 Contract Refund and Top-Up Flows

**Top-up (D-04):** wallet deposit (Dr Bank / Cr 2310) + allocation (Dr 2310 / Cr 2300) in one transaction; one bank Deposit row; contract totals increased.

**Contract cancellation refund (AF-A3):**

- **Option A:** Dr 2300 / Cr Bank directly; allocation `released_amount += X`; contract remaining 0; one bank Debit row.
- **Option B (recommended for a unified statement):** Dr 2300 / Cr 2310 (release) then Dr 2310 / Cr Bank (refund), both in one transaction; wallet `release` (+X) and `refund` (−X); one bank Debit row.
- **No duplicate credit:** allocation released once, wallet credited once, refund debited once, bank debited once.

**Status:** Finance must choose AF-A3. Both options are technically valid.

### 17.4 Wallet Control Hardening

- **Negative balance:** `CHECK (balance >= 0)` + wallet `FOR UPDATE` + balance check; reject `INSUFFICIENT_WALLET_FUNDS`.
- **Atomic spending:** claim → lock wallet → validate → insert tx → update balance → mutate → journal → bank → audit → store response.
- **Concurrency:** wallet row lock; unique idempotency; unique reference; `40001` → 409; `409 IDEMPOTENCY_IN_PROGRESS`; no takeover.
- **Frozen:** blocks debits; credits only with approval.
- **Closed:** blocks all; requires zero balance, no active allocations, no pending reversals, final statement, approval.
- **Adjustment:** approval, reason, approved counter-account.
- **Reversal:** new row, `reverses_txn_id`, compensating journal, approval.
- **Duplicate prevention:** unique idempotency + reference + invoice/contract checks.
- **Account validation:** active liability, credit normal, company-scoped; no auto-create; `NO_WALLET_LIABILITY_ACCOUNT`.
- **Multi-company:** RLS + composite FKs + `withCompanyDb`.
- **Currency:** base-only Phase 1; no implicit conversion.
- **Closure prerequisites:** as above.

### 17.5 W-01…W-08 Disposition

| ID | Proposed decision | Status |
|---|---|---|
| W-01 | Two-liability model (2310 + 2300) | **PROPOSED — PENDING** |
| W-02 | Reuse payments/payment_allocations for wallet invoice settlement | **PROPOSED — PENDING** |
| W-03 | Contract consumption via allocation + journal; no second wallet debit | **PROPOSED — PENDING** |
| W-04 | Base-currency wallets only Phase 1 | **PROPOSED — PENDING** |
| W-05 | 2310 configurable/validated; no auto-create | **TECHNICAL — SUPPORTED** |
| W-06 | Refund threshold via approval policies; snapshot applied | **TECHNICAL — SUPPORTED** |
| W-07 | WLT-YYYY-NNNN, 4-digit minimum | **PROPOSED — PENDING** |
| W-08 | Frozen/closed semantics | **PROPOSED — PENDING** |

### 17.6 Outstanding Finance / Accounting Decisions

| ID | Decision | Owner | Status |
|---|---|---|---|
| AF-A1 | Revenue recognition event (assessment vs invoice vs delivery) | Finance / business owner | **OPEN** |
| AF-A2 | Contract invoice tax and COGS treatment | Finance / tax | **OPEN** |
| AF-A3 | Contract cancellation refund flow (direct vs release→refund) | Finance | **OPEN** |
| AF-A4 | `2310` account code and per-company configuration | Finance | **OPEN** |
| AF-A5 | Refund threshold default K250,000 and approval policy | Finance | **OPEN** |
| AF-A6 | Forfeiture income account `4900` and approval | Finance | **OPEN** |

### 17.7 Updated A2.1 Verdict

**A2.1 COMPLETE — PENDING BUSINESS/FINANCE APPROVAL; A3 NOT AUTHORISED.**

The wallet architecture and accounting design are complete and internally consistent, subject to:

- W-01…W-08 business approval;
- AF-A1…AF-A6 Finance decisions;
- the payment compatibility changes;
- the contract invoice revenue correction;
- the contract refund-flow choice.

**No source code, schema, migration, test, or financial transaction was changed in A2.1. No commit was created.**

---

## 18. Phase A2 Verdict

### **A2 COMPLETE; A2.1 COMPLETE — PENDING BUSINESS/FINANCE APPROVAL**

**A2.1 outcome:** the wallet architecture, accounting matrix, integration plan, legacy reconciliation, and control hardening are complete. W-01…W-08 are **PROPOSED — PENDING**, and AF-A1…AF-A6 are **OPEN**. Phase A3 is **not authorised**.

**Completed:**

- Existing financial architecture verified.
- Customer wallet domain model and schema specified.
- Two-liability accounting model defined.
- Transaction lifecycle documented.
- Balance invariants and reconciliation defined.
- Atomicity/idempotency/concurrency designed.
- Permissions/audit/tenant isolation addressed.
- ERP module integrations mapped.
- Legacy data classified without modification.
- All material uncertainties and decisions reported.
- Required documents produced.

**Conditions before implementation:**

1. Approve W-01…W-08.
2. Configure `2310 Customer Wallet Funds` per company.
3. Extend `payments.payment_method` with `Wallet`.
4. Approve the contract allocation accounting change.
5. Add `companies.timezone`.
6. Independently review the wallet schema (separate from Migration 0020).
7. Run the legacy preflight under D-12.
8. Obtain explicit implementation authorisation.

**No code, schema, migration, test, or financial transaction was changed in A2. No commit was created. All pre-existing user changes are preserved.**