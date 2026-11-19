# 20 — Customer Wallet Integration Plan

**Date:** 2026-11-19
**Phase:** A2 — Financial Architecture (documentation only)
**Status:** Proposed integration design for review
**Scope:** Company-wide customer wallet

---

## A2.2 Approval Addendum (2026-11-19)

- **W-02 — BUSINESS APPROVED:** reuse `payments`/`payment_allocations` for wallet-funded invoice settlement, subject to the compatibility safeguards in §3.3.1.
- **AF-A1 — BUSINESS POLICY SELECTED — FINANCE VALIDATION REQUIRED:** assessment completion (Option B) is the revenue event; contract invoices must not post revenue again.
- **AF-A3 — BUSINESS APPROVED — FINANCE IMPLEMENTATION VALIDATION REQUIRED:** contract cancellation refunds use release-to-wallet then refund, atomically.
- **AF-A2 / AF-A4 / AF-A5 / AF-A6:** outstanding Finance/technical verification as recorded in `11-FINAL-BUSINESS-DECISION-REGISTER.md`.
- **Phase A3: NOT AUTHORISED.**

---

## 1. Integration Principles

1. **One authoritative wallet service.** All modules call `customerWalletService`; no module maintains its own wallet balance.
2. **One ledger.** `customer_wallets` + `customer_wallet_transactions` are the only wallet books.
3. **Existing AR/bank/GL remain authoritative for their domains.**
4. **No automatic conversion** of AR, unapplied payments, or contract balances into wallet funds.
5. **Backend-authoritative balances.** UI balances are display-only.
6. **Idempotent and atomic** for every financial operation.
7. **Tenant-isolated** via `db.withCompanyDb` + RLS.
8. **Audit every movement.**
9. **No offline wallet mutations.** Wallet operations require a server connection.

---

## 2. Service Ownership

### 2.1 New service: `customerWalletService.ts`

Responsibilities:

- Get/create a customer wallet (per customer/currency).
- Validate wallet status, balance, and currency.
- Record deposits, allocations, releases, invoice payments, refunds, reversals, adjustments, transfers.
- Post journals via `postJournalEntry`.
- Insert bank rows via the canonical banking pattern for deposits/refunds.
- Write audit.
- Manage idempotency via `request_keys`.
- Provide statements and reconciliation.

### 2.2 Existing services to integrate

| Service | Integration |
|---|---|
| `salesService.recordCustomerPayment` | Add a wallet-funded payment branch (`fundingSource='wallet'`); Dr 2310 / Cr 1100; no bank row |
| `printingRecordsService` | Contract activation allocates from wallet; top-up; consumption; cancellation release/forfeit |
| `documentsService` | Wallet statement / customer statement; wallet-funded invoice preview |
| `bankingService` | Deposit/refund bank rows; reconciliation |
| `approvalService` | `wallet_refund`, `wallet_reversal`, `wallet_adjustment`, `wallet_writeoff` |
| `accountingEngine.postJournalEntry` | All wallet journals |
| `audit.writeAuditLog` | All wallet events |
| `commercialHelpers.recalculateCustomerBalance` | Must remain AR-only; wallet must not affect it |

### 2.3 Explicit non-ownership

- `customers.balance` remains AR. The wallet must **not** be added to it.
- `bank_transactions` remains the bank subledger. The wallet must not be used as a bank balance.
- `printing_contracts.remaining_balance` remains the contract liability. The wallet is not the contract balance.

---

## 3. Module-by-Module Integration

### 3.1 Customer Management

**Current:** `customers` (`0003:6-31`), `customers.balance` AR, `listCustomers`/`createCustomer` (`salesService.ts`).

**Integration:**
- Add a wallet summary to the customer detail:
  - total wallet balance by currency;
  - allocated funds;
  - total customer funds;
  - AR balance (separate).
- Add a "Wallet" tab/section with statement and actions.
- Create the wallet lazily on the first deposit/allocation; do not create a zero-balance wallet for every customer.
- `GET /api/customers/:id/wallet` returns wallet summaries.
- Do not change `customers.balance`.

**Risks:** users may confuse AR and wallet; label clearly.

### 3.2 Invoices

**Current:** `invoices` (`0003:117-156`), `invoice_lines`, `payments`, `payment_allocations`, `recordCustomerPayment` (`salesService.ts:1346-1691`).

**Integration:**
- Add a wallet-funded payment path:
  - `payments.payment_method` CHECK extended with `Wallet`.
  - `recordCustomerPayment` accepts `fundingSource='wallet'`.
  - For wallet funding:
    - validate wallet balance;
    - insert `payments` with `deposit_to_account_id = wallet.liability_account_id`, `payment_method='Wallet'`;
    - insert normal `payment_allocations`;
    - post **Dr 2310 / Cr 1100** (no bank debit);
    - insert wallet transaction `invoice_payment`;
    - update invoice `amount_paid`/`balance_due`/status;
    - **no** `bank_transactions` row.
- Prevent duplicate invoice payment via invoice balance check + unique wallet reference.
- Preserve credit memos, discounts, and FX behaviour.
- `recordCustomerPayment` already validates `payment_method` against a list (`salesService.ts:1387-1388`); add `Wallet`.
- The `deposit_to_account_id` validation (`1391-1397`) currently requires Bank/OtherCurrentAsset; for wallet funding, bypass that check and use the wallet liability account.

**Risks:** the `payments` table's `deposit_to_account_id` name becomes semantically "funding account"; acceptable if documented. Alternative: a separate `wallet_invoice_applications` table. Recommended: reuse `payments` with `Wallet`.

### 3.3 Receive Payment

**Current:** UI in `InvoicesView.tsx` / `salesRoutes.ts` `POST /payments`.

**Integration:**
- Add "Payment source": Bank/Cash/Mobile Money vs **Customer Wallet**.
- When wallet is selected:
  - show available wallet balance;
  - validate amount ≤ balance;
  - send `fundingSource='wallet'`, `walletId`, `idempotencyKey`;
  - display confirmation that no bank transaction is created.
- Backend is authoritative; the UI balance is display-only.
- On success, refresh wallet and invoice.

**Risks:** double submission; use idempotency + disable button.

### 3.3.1 Payment Compatibility Changes (W-02) — Required

The existing `payments` model can support wallet-funded invoice settlement only with these changes:

1. **Extend `payments.payment_method` CHECK** with `Wallet` (`0003:247`).
2. **Add `fundingSource='wallet'` to `recordCustomerPayment`** (`salesService.ts:1346-1691`):
   - validate wallet status/balance;
   - skip the Bank/OtherCurrentAsset deposit-account validation (`1391-1397`);
   - use `wallet.liability_account_id` as `deposit_to_account_id`;
   - post **Dr 2310 / Cr 1100**;
   - insert **no** `bank_transactions` row;
   - leave `payments.deposited_bank_txn_id = NULL`;
   - insert wallet `invoice_payment` debit;
   - keep `payment_allocations` and invoice balance updates unchanged.
3. **No unapplied remainder:** wallet invoice payments must be fully allocated to invoices. If the amount exceeds the invoice(s), reject; do not create an AR credit.
4. **Void wallet payment:** `voidCustomerPayment` (`salesService.ts:1693-1771`) must become wallet-aware:
   - reverse the wallet transaction (new reversal row, wallet credit);
   - restore invoice balances;
   - mark payment voided;
   - no bank row to void.
   - The current implementation only reverses the journal and voids bank transactions; it does not update the wallet.
5. **`recalculateCustomerBalance` remains AR-only** (`commercialHelpers.ts:478-521`); wallet payments still reduce AR, which is correct.
6. **No duplicate bank receipt:** wallet payments never create `bank_transactions`.
7. **Existing payment methods unchanged:** Check/Credit Card/Cash/ACH/Mobile Money continue to post Dr Bank / Cr AR.
8. **Invoice balance calculations unchanged:** `amount_paid`, `balance_due`, `status` are updated by the existing allocation logic.
9. **Invoice contract link:** add `invoices.source_type`, `invoices.source_ref`, `invoices.contract_id`, `invoices.milestone_number` (or equivalent) to identify contract invoices and prevent double revenue/COGS.

**Compatibility conclusion:** W-02 is technically viable, but requires the above changes. Without them, wallet invoice payments would either fail the bank-account validation or create an incorrect bank journal.

### 3.4 Sales Orders

**Current:** **No sales-order module exists.** `salesOrderService.ts`/`salesOrderRoutes.ts` are absent; only `salesOrderSettingsService.ts` exists.

**Integration:**
- Not applicable in Phase A2.
- Design a future `sales_order_payment` wallet transaction type:
  - Dr 2310 / Cr order liability or AR;
  - no bank;
  - wallet debit;
  - idempotency `wallet_order_payment`.
- When sales orders are built, they must call `customerWalletService`, not maintain a separate balance.

### 3.5 Printing Contracts

**Current:** `printing_contracts` (`0007:118-161`), `printingRecordsService.ts`, `printingRoutes.ts`.

**Integration:**

| Contract event | Wallet action | Accounting |
|---|---|---|
| Create draft | None (no deposit) | No journal |
| Activate | Allocate wallet funds to contract | Dr 2310 / Cr 2300; wallet allocation; contract active |
| Top-up | Deposit + allocate | Dr Bank / Cr 2310; Dr 2310 / Cr 2300 |
| Assessment completion | Consume allocation | Dr 2300 / Cr 4000; allocation consumed; contract remaining − |
| Cancel with refund | Release allocation to wallet; refund wallet to bank | Dr 2300 / Cr 2310; Dr 2310 / Cr Bank |
| Cancel with forfeit | Forfeit allocation | Dr 2300 / Cr 4900 |
| Suspend | No wallet movement | None |
| Resume | No wallet movement | None |
| Insufficient funds | Block allocation/consumption | No journal |

**Rules:**
- Draft creation must not post a deposit (D-10).
- Activation requires signature + sufficient wallet funds.
- Allocation moves funds from unallocated wallet to contract; no second cash receipt.
- Top-ups are wallet deposits + allocations.
- Consumption only on completed assessment/job, not on invoice generation.
- Completed contracts keep remaining funds attached (D-05).
- Cancelled contracts reject top-ups.
- Suspended contracts require approval for top-up.
- No automatic reactivation.
- Refund/forfeit via approved cancellation workflow.

**Top-up flow (D-04):**

1. Confirmed payment received.
2. Dr Bank / Cr 2310 (wallet deposit).
3. Dr 2310 / Cr 2300 (allocation to active contract).
4. Wallet transactions `deposit` (+), `allocation` (−).
5. One bank Deposit row.
6. Contract totals increased.
7. One idempotency key for the whole top-up.

**Contract cancellation refund flow (AF-A3):**

- **Option A — direct:** Dr 2300 / Cr Bank; allocation `released_amount += X`; contract `remaining_balance = 0`; one bank Debit row. No wallet credit.
- **Option B — release then refund (recommended for a unified statement):** Dr 2300 / Cr 2310 (release), then Dr 2310 / Cr Bank (refund), both in one transaction; allocation `released_amount += X`; wallet `release` (+X) and `refund` (−X); one bank Debit row.
- **No duplicate credit:** allocation released once, wallet credited once, refund debited once, bank debited once.
- **Finance must choose (AF-A3).**

**Revenue recognition dependency (AF-A1/AF-A2):**

- Current assessment completion posts Dr 2300 / Cr 4000 (`printingRecordsService.ts:970-990`).
- Current contract invoice generation posts Dr AR / Cr 4000 (`salesService.ts:1004-1027`), risking double revenue.
- Contract invoices must be either:
  - **Option B:** nil-GL receipts (no AR/revenue/COGS), if revenue is recognized at assessment completion; or
  - **Option A:** Dr 2300 / Cr 4000 with no AR, if revenue is recognized at contract invoice/receipt.
- **Never both.** Finance/tax must approve the option and the tax/COGS treatment.

**Naming risk:** the current "Contract Wallet" UI (`printingApi.getContractWalletTransactions`, `ContractInfoModal`) actually shows bank transactions. Rename to "Contract Funding" or "Bank Transactions" to avoid confusion with the new customer wallet.

### 3.6 Accounting / General Ledger

**Current:** `accounts` (`0002:5-39`), `journal_transactions`, `journal_lines`, `postJournalEntry` (`accountingEngine.ts:1523-1816`).

**Integration:**
- Add/configure `2310 Customer Wallet Funds` (OtherCurrentLiability, credit normal balance).
- Keep `2300 Unearned Contract Retainers`.
- All wallet journals use `postJournalEntry`.
- `sourceType='customer_wallet'`, `sourceId=<wallet txn id>`.
- Period lock enforced.
- Account validation enforced.
- Reconciliation:
  - `2310` = `SUM(customer_wallets.balance)`.
  - `2300` = `SUM(allocation.remaining)`.
  - `1100` = AR (unchanged).
- Do not add wallet balances to `customers.balance`.
- Chart of accounts must be configured per company; no auto-creation.

**Risk:** existing companies may not have `2310`. The implementation must fail with `NO_WALLET_LIABILITY_ACCOUNT` until configured. Do not auto-create.

### 3.7 Banking

**Current:** `bank_transactions` (`0004:348-395`), `bankingService.ts`.

**Integration:**
- Wallet deposits (bank/cash/mobile money) create one `bank_transactions` row:
  - `txn_type='Deposit'`, positive amount, `journal_txn_id`, `customer_id`.
- Wallet refunds create one `bank_transactions` row:
  - `txn_type='Debit'`, negative amount, `journal_txn_id`, `customer_id`.
- Wallet-funded invoice payments create **no** bank row.
- Contract consumption/forfeiture create **no** bank row.
- Do not persist `running_balance`; `listBankTransactions` computes it (`bankingService.ts:177-181`).
- Bank reconciliation must not double-count wallet deposits.

### 3.8 Customer Portal

**Current:** **No customer portal route exists.**

**Integration:**
- Not applicable in Phase A2.
- Future read-only portal:
  - wallet balance;
  - statement;
  - invoices;
  - funding requests.
- Must use the same `customerWalletService` and company scoping; no direct DB access.

### 3.9 Reports and Statements

**Integration:**
- Customer statement: AR section + wallet section + total customer funds.
- Wallet statement: opening balance, deposits, allocations, invoice payments, refunds, reversals, adjustments, closing balance.
- Wallet aging: unallocated funds by age.
- Reconciliation report: subledger vs GL.
- Exception report: missing journals, duplicate deposits, negative balances, orphaned transactions.
- All reports company-scoped and permission-gated (`wallet:read`, `wallet:reconcile`).

### 3.10 Offline and Synchronisation

**Current:** No offline wallet service. `SettingsView.tsx:395` states the browser working copy is not a ledger.

**Integration:**
- Wallet operations are **online-only**.
- The browser cache must never be used as a wallet balance or to post wallet transactions.
- If an offline mode is added later:
  - queue **requests**, not balances;
  - idempotency keys prevent duplicates;
  - server reconciliation on reconnect;
  - no local financial truth.
- No offline wallet in Phase A2.

---

## 4. API Surface (Proposed)

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| GET | `/api/wallets` | `wallet:read` | List wallets |
| GET | `/api/wallets/:id` | `wallet:read` | Wallet summary |
| GET | `/api/wallets/:id/transactions` | `wallet:transactions:read` | Statement |
| GET | `/api/wallets/:id/reconciliation` | `wallet:reconcile` | Reconciliation |
| POST | `/api/wallets/:id/deposits` | `wallet:deposit` | Deposit |
| POST | `/api/wallets/:id/allocations` | `wallet:allocate` | Allocate to contract/invoice |
| POST | `/api/wallets/:id/releases` | `wallet:allocate` | Release allocation |
| POST | `/api/wallets/:id/payments` | `wallet:apply` | Apply to invoices |
| POST | `/api/wallets/:id/refunds` | `wallet:refund` | Refund |
| POST | `/api/wallets/:id/reversals` | `wallet:reverse` | Reverse |
| POST | `/api/wallets/:id/adjustments` | `wallet:adjust` | Adjust |
| POST | `/api/wallets/:id/transfers` | `wallet:allocate` | Transfer between wallets |
| GET | `/api/customers/:id/wallet` | `wallet:read` | Customer wallet summary |
| GET | `/api/reports/customer-wallet-statement` | `wallet:read` | Statement |

All POSTs require an `idempotency-key` header or body. Financial routes require approval checks where applicable.

---

## 5. Migration Sequence

1. **Configuration:** add `2310 Customer Wallet Funds` to each company's chart of accounts (manual/approved).
2. **Schema:** add wallet tables, RLS, triggers, indexes (future migration, not 0020; A3).
3. **Payment method:** extend `payments.payment_method` CHECK with `Wallet`.
4. **Service:** `customerWalletService` with idempotency, locking, audit.
5. **API:** wallet endpoints.
6. **Customer UI:** wallet tab, statement.
7. **Invoice payment:** wallet funding path.
8. **Printing contracts:** activation/allocation, top-up, consumption, cancellation release/forfeit.
9. **Reports:** statement, reconciliation.
10. **Legacy preflight:** `21-CUSTOMER-WALLET-LEGACY-RECONCILIATION.md`.
11. **Tests:** unit, integration, concurrency, idempotency, reconciliation.
12. **Pilot:** one company, shadow run, finance sign-off.
13. **Rollout:** other companies.

**Migration 0020 restriction:** the wallet schema is **not** Migration 0020 unless the business explicitly includes it. It should be a separate migration after A3 review. Do not apply without business-owner approval.

---

## 6. Compatibility Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `payments.payment_method` CHECK rejects `Wallet` | Migration extends CHECK; service validates |
| `recordCustomerPayment` treats all payments as bank-funded | Branch on `fundingSource`; wallet path skips bank validation/row |
| `customers.balance` accidentally includes wallet | Keep `recalculateCustomerBalance` AR-only; add a test |
| Contract deposit double-posted | Activation allocates; draft posts nothing; one journal |
| Contract consumption double-deducted | Unique idempotency + contract lock + allocation check |
| Wallet balance overspent | `CHECK (balance >= 0)` + wallet row lock |
| Duplicate deposit | Unique `(reference_type, reference_id, txn_type)` + idempotency |
| Duplicate invoice payment | Invoice balance check + unique wallet reference |
| Refund threshold bypass | Approval policy + stored threshold applied |
| Cross-company access | RLS + composite FKs + `withCompanyDb` |
| `2310` missing | Fail with `NO_WALLET_LIABILITY_ACCOUNT`; no auto-create |
| `2300` misused as wallet | Separate wallet/contract accounts; validation |
| "Contract Wallet" UI confusion | Rename to "Contract Funding"/"Bank Transactions" |
| Offline false balance | No offline wallet; server-only |
| Legacy AR converted silently | No automatic conversion; D-12 preflight |
| Multi-currency implicit conversion | Phase 1 base-only; explicit FX if enabled |

---

## 7. RBAC Integration

| Permission | Administrator | Accountant | Contract Manager | Bookkeeper | Production Manager | Read-Only |
|---|---|---|---|---|---|---|
| `wallet:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `wallet:transactions:read` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `wallet:deposit` | ✓ | ✓ | — | — | — | — |
| `wallet:allocate` | ✓ | ✓ | — | — | — | — |
| `wallet:apply` | ✓ | ✓ | — | — | — | — |
| `wallet:refund` | ✓ | ✓ | — | — | — | — |
| `wallet:reverse` | ✓ | ✓ | — | — | — | — |
| `wallet:adjust` | ✓ | ✓ | — | — | — | — |
| `wallet:reconcile` | ✓ | ✓ | — | — | — | — |
| `wallet:configure` | ✓ | — | — | — | — | — |

**Contract Manager** may view wallet balances relevant to contracts but must not post financial wallet transactions. Financial authority remains with Accountant/Administrator (D-07/T01).

---

## 8. Testing Strategy

| Area | Tests |
|---|---|
| Deposit | Bank/cash/mobile; duplicate idempotency; missing account; negative amount; cross-company |
| Allocation | Sufficient/insufficient funds; contract status; duplicate allocation; concurrency |
| Invoice payment | Wallet funding; no bank row; invoice balance; duplicate; partial; FX |
| Consumption | Allocation remaining; contract remaining; double completion; job/invoice no auto-deduction |
| Refund | Approval; threshold; Finance destination; duplicate; insufficient balance |
| Forfeiture | 2300/4900; no bank; approval |
| Reversal | Compensating entry; original immutable; insufficient balance |
| Adjustment | Approval; reason; account validation |
| Reconciliation | 2310 vs wallets; 2300 vs allocations; 1100 AR unchanged |
| Concurrency | 10 parallel deposits/payments/allocations; no overspend; one journal |
| Idempotency | Same key same/different payload; concurrent; retry |
| Tenant | Cross-company wallet access denied |
| Audit | Every transaction logged with actor/amount/reference |
| Legacy | No AR/bank/contract auto-conversion |

---

## 9. A2 Integration Verdict

The integration plan is **complete and consistent** with the existing AR, payment, invoice, GL, bank, approval, audit, and RLS architecture. The main new dependencies are:

1. `2310 Customer Wallet Funds` account configuration.
2. `Wallet` payment method.
3. Wallet tables/service/endpoints.
4. Contract activation/allocation changes.

No sales-order, portal, or offline integration is possible today because those modules do not exist. They are marked future/not applicable.

**No code or schema was changed in A2.**