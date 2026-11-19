# 18 — Customer Wallet Architecture

**Date:** 2026-11-19
**Phase:** A2 — Financial Architecture (documentation only)
**Status:** Proposed architecture for business-owner review
**Scope:** Company-wide customer wallet subledger

---

## A2.2 Approval Addendum (2026-11-19)

The business owner approved the following on 2026-11-19 (Phase A2.2). This addendum supersedes the earlier PROPOSED/PENDING labels; the historical A2/A2.1 text remains below for audit history.

- **W-01** Two-liability model (`2310` + `2300`): **BUSINESS APPROVED**.
- **W-02** Reuse `payments`/`payment_allocations` for wallet invoice settlement, with compatibility safeguards: **BUSINESS APPROVED**.
- **W-03** Contract consumption via allocation + journal, no second wallet debit: **BUSINESS APPROVED**.
- **W-04** Base-currency wallets only in Phase 1: **BUSINESS APPROVED**.
- **W-05** `2310` configurable/validated, no auto-create: **TECHNICAL DESIGN ACCEPTED** (not implemented/configured).
- **W-06** Refund threshold via `approval_policies`, snapshot applied: **TECHNICAL DESIGN ACCEPTED** (not implemented/configured).
- **W-07** `WLT-YYYY-NNNN`, four-digit minimum: **BUSINESS APPROVED**.
- **W-08** Frozen blocks debits; closed blocks all, settlement before closure: **BUSINESS APPROVED**.

- **AF-A1** Revenue recognition: **Option B — assessment completion selected. FINANCE VALIDATION REQUIRED.** Contract invoice generation must not post revenue again; the non-duplicating accounting design is required.
- **AF-A3** Contract cancellation refund: **Option B — release to wallet, then refund. BUSINESS APPROVED — FINANCE IMPLEMENTATION VALIDATION REQUIRED.**
- **AF-A2** Tax/COGS: **PENDING — FINANCE/TAX REVIEW REQUIRED.**
- **AF-A4** Account `2310`: **TECHNICAL VERIFICATION PENDING.**
- **AF-A5** Refund threshold: **BUSINESS POLICY APPROVED (T03) — TECHNICAL VERIFICATION PENDING.**
- **AF-A6** Forfeiture account: **BUSINESS POLICY APPROVED (D-03) — ACCOUNT VERIFICATION PENDING.**

**Phase A3: NOT AUTHORISED.** See `24-PHASE-A2.2-BUSINESS-APPROVAL-RECORD.md`.

---

## 1. Executive Summary

This document specifies a **company-wide customer-wallet subledger** for Prime ERP. The wallet is a **liability** representing customer prepaid funds. It is distinct from:

- `customers.balance` (accounts receivable);
- `bank_transactions` (bank subledger);
- `accounts` (general ledger);
- `printing_contracts.remaining_balance` (contract liability).

The design introduces:

- `customer_wallets` — one wallet per customer per currency.
- `customer_wallet_transactions` — append-only wallet ledger.
- `customer_wallet_allocations` — funds allocated to contracts, invoices, or future sales orders.
- Reuse of `request_keys`, `approval_policies`/`approval_requests`, `audit_log`, `stored_files`/`attachments`, and `company_settings`.
- A two-liability accounting model:
  - `2310 Customer Wallet Funds` (unallocated prepaid funds);
  - `2300 Unearned Contract Retainers` (allocated contract funds; already seeded).

**Critical design decision requiring approval:** contract activation/allocation reclassifies funds from `2310` to `2300` (Dr 2310 / Cr 2300). This preserves the total customer liability while distinguishing unallocated wallet funds from contract-specific funds. It changes the current contract deposit posting (Dr Bank / Cr 2300) and is required by D-10.

**No implementation is performed in A2.** No schema, migration, or service is changed.

---

## 2. Verified Existing Financial Architecture

### 2.1 Customer balance is AR, not a wallet

- `customers.balance` (`0003:20`) is recomputed by `recalculateCustomerBalance` (`commercialHelpers.ts:478-521`) as:

```
open invoices − credit memos − unapplied payment remainders
```

- This is **accounts receivable**. A positive balance means the customer owes the company.
- There is **no customer-wallet table, entity, API, or service**.

### 2.2 Payments are AR settlements

- `payments` (`0003:240-264`) has `payment_method` CHECK `Check | Credit Card | Cash | ACH / Wire | Mobile Money` (247), `deposit_to_account_id` (249), `journal_txn_id` (253).
- `payment_allocations` (`0003:274-286`) links payments to invoices.
- `recordCustomerPayment` (`salesService.ts:1346-1691`):
  - locks the customer (`1379-1383`);
  - validates a Bank/OtherCurrentAsset deposit account (`1391-1397`);
  - allocates to invoices with invoice `FOR UPDATE` (`1434-1502`);
  - posts **Dr Bank / Cr AR** (`1574-1592`);
  - inserts a `bank_transactions` row for bank deposits (`1625-1656`);
  - recomputes the AR balance (`1658`).
- The unapplied remainder is **not** a wallet; it is an AR credit (`payments.amount − SUM(payment_allocations.amount)`).

### 2.3 Credit memos are AR credits

- `credit_memos` (`0003:295-326`) has `remaining_credit` (306) and `journal_txn_id` (309). They reduce AR; they are not wallet funds.

### 2.4 Contract deposits currently post to the contract liability

- `createPrintingContract` posts **Dr Bank / Cr contract liability** (`printingRecordsService.ts:142-161`) and creates an `active` contract (`164-170`).
- The contract liability account is resolved from codes `2250/2200/2100/2300` (`22-46`).
- Seeded accounts: `1010 Operating Checking` (`db.ts:48`), `1100 Accounts Receivable` (`49`), `2300 Unearned Contract Retainers` (`57`), `4000 Printing & Sales Revenue` (`62`), `4900 Other Miscellaneous Income` (`63`).
- There is **no `2310` wallet account** in the seed.

### 2.5 Bank subledger

- `bank_transactions` (`0004:348-395`) has `journal_txn_id` (377-378), `status` (0010:218), `offset_account_id` (219), `customer_id` (0004), and `txn_type` including `Deposit`, `Payment`, `Debit`, etc. (0010:225-226).
- `running_balance` is computed on read (`bankingService.ts:177-181`); do not persist it in the wallet.

### 2.6 Journal and idempotency

- `postJournalEntry` (`accountingEngine.ts:1523-1816`) validates balanced lines, account existence, period locks, and idempotency (`1563-1588`, `1788-1795`).
- `request_keys` (`0001:190-204`) provides `(company_id, route, idempotency_key)` uniqueness and `payload_hash`.
- `approval_requests`/`approval_policies` (`0013`, `0014`) provide maker-checker thresholds and one-time consumption.

### 2.7 Sales orders, portal, offline

- **No sales-order module exists.** `salesOrderService.ts`/`salesOrderRoutes.ts` are absent; only `salesOrderSettingsService.ts` exists. Sales-order wallet payments are **not applicable** until sales orders are built.
- **No customer portal route exists.**
- **No offline wallet service exists.** The browser working copy is explicitly not a ledger (`SettingsView.tsx:395`).

### 2.8 Payment methods

- Payment methods are a **CHECK constraint** on `payments.payment_method` (`0003:247`), not a table. Adding `Wallet` requires a migration to extend the CHECK.

---

## 3. Non-Negotiable Financial Distinctions

| Concept | Authoritative store | Meaning |
|---|---|---|
| Customer prepaid wallet funds | `customer_wallets` + `customer_wallet_transactions` | Customer's unallocated prepaid funds |
| Accounts receivable | `customers.balance`, `invoices.balance_due`, `payments`, `credit_memos` | What the customer owes |
| Bank/cash | `bank_transactions`, `accounts` (Bank/OtherCurrentAsset) | Actual cash movements |
| Contract allocated funds | `customer_wallet_allocations` + `printing_contracts` | Funds committed to a contract |
| Invoice balance | `invoices` | Open amount due |
| Unapplied customer payment | `payments` minus `payment_allocations` | AR credit awaiting allocation |

**Never treat these as equivalent.** In particular:

- `customers.balance` is **not** a wallet.
- `bank_transactions` is **not** a wallet ledger.
- `printing_contracts.remaining_balance` is **not** unallocated wallet funds.
- A customer can have an AR balance and a wallet balance at the same time.

---

## 4. Domain Model

### 4.1 Entities

1. **Customer wallet** — one per `(company, customer, currency)`.
2. **Wallet transaction** — append-only ledger entry (deposit, allocation, release, invoice payment, contract consumption link, refund, reversal, adjustment).
3. **Wallet allocation** — funds committed to a contract/invoice/sales order; tracks allocated, consumed, released.
4. **Wallet approval** — reuse `approval_requests` with contract/wallet action types.
5. **Wallet audit** — reuse `audit_log`.
6. **Wallet settings** — reuse `company_settings` keys.

### 4.2 Relationship

```
customers 1───N customer_wallets 1───N customer_wallet_transactions
customer_wallets 1───N customer_wallet_allocations
customer_wallet_allocations N───1 printing_contracts (allocation_type='contract')
customer_wallet_allocations N───1 invoices (allocation_type='invoice')
customer_wallet_allocations N───1 sales_orders (future; no table today)
customer_wallet_transactions N───1 journal_transactions
customer_wallet_transactions N───1 bank_transactions (deposits/refunds)
```

---

## 5. Proposed Schema

### 5.1 `customer_wallets`

```sql
CREATE TABLE customer_wallets (
  id                   BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id           BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  customer_id          BIGINT NOT NULL,
  currency_code        CHAR(3) NOT NULL,
  liability_account_id BIGINT NOT NULL,
  balance              NUMERIC(19,4) NOT NULL DEFAULT 0.0000 CHECK (balance >= 0),
  status               VARCHAR(16) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','frozen','closed')),
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_customer_wallets_company_id UNIQUE (company_id, id),
  CONSTRAINT uq_customer_wallets_customer_currency UNIQUE (company_id, customer_id, currency_code),
  CONSTRAINT fk_customer_wallets_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES customers (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_wallets_liability FOREIGN KEY (company_id, liability_account_id)
    REFERENCES accounts (company_id, id) ON DELETE RESTRICT
);

CREATE INDEX ix_customer_wallets_company_customer
  ON customer_wallets (company_id, customer_id);
CREATE INDEX ix_customer_wallets_company_status
  ON customer_wallets (company_id, status);

ALTER TABLE customer_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY p_customer_wallets_isolation ON customer_wallets
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));
```

**Notes:**
- `balance` is a **cached** unallocated balance. The authoritative value is `SUM(credits) − SUM(debits)` from `customer_wallet_transactions`. A trigger or reconciliation job must keep it equal.
- `liability_account_id` must be an active liability account with `normal_balance='credit'` (normally `2310`). Do not default to `2300`; `2300` is the contract liability.
- `status='frozen'` blocks new debits but allows credits? Define: frozen blocks all new transactions except reversal/adjustment with approval. `closed` blocks all.
- `version` supports optimistic concurrency; increment on every balance change.

### 5.2 `customer_wallet_transactions`

```sql
CREATE TABLE customer_wallet_transactions (
  id                BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  wallet_id         BIGINT NOT NULL,
  customer_id       BIGINT NOT NULL,
  txn_type          VARCHAR(32) NOT NULL CHECK (txn_type IN (
                      'deposit', 'allocation', 'release', 'invoice_payment',
                      'sales_order_payment', 'refund', 'reversal', 'adjustment'
                    )),
  direction         VARCHAR(6) NOT NULL CHECK (direction IN ('credit','debit')),
  amount            NUMERIC(19,4) NOT NULL CHECK (amount > 0),
  balance_after     NUMERIC(19,4) NOT NULL CHECK (balance_after >= 0),
  reference_type    VARCHAR(32),
  reference_id      BIGINT,
  allocation_id     BIGINT,
  journal_txn_id    BIGINT,
  bank_txn_id       BIGINT,
  payment_id        BIGINT,
  reverses_txn_id   BIGINT,
  idempotency_key   VARCHAR(128),
  description       TEXT NOT NULL,
  notes             TEXT,
  created_by        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_customer_wallet_txns_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_customer_wallet_txns_wallet FOREIGN KEY (company_id, wallet_id)
    REFERENCES customer_wallets (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_wallet_txns_customer FOREIGN KEY (company_id, customer_id)
    REFERENCES customers (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_wallet_txns_allocation FOREIGN KEY (company_id, allocation_id)
    REFERENCES customer_wallet_allocations (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_wallet_txns_journal FOREIGN KEY (company_id, journal_txn_id)
    REFERENCES journal_transactions (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_wallet_txns_bank FOREIGN KEY (company_id, bank_txn_id)
    REFERENCES bank_transactions (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_wallet_txns_reversal FOREIGN KEY (company_id, reverses_txn_id)
    REFERENCES customer_wallet_transactions (company_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_customer_wallet_txns_idem
  ON customer_wallet_transactions (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX uq_customer_wallet_txns_reference
  ON customer_wallet_transactions (company_id, reference_type, reference_id, txn_type)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

CREATE INDEX ix_customer_wallet_txns_wallet_date
  ON customer_wallet_transactions (company_id, wallet_id, created_at DESC);
CREATE INDEX ix_customer_wallet_txns_customer
  ON customer_wallet_txns (company_id, customer_id, created_at DESC);

ALTER TABLE customer_wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_wallet_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY p_customer_wallet_txns_isolation ON customer_wallet_transactions
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));
```

**Immutability:** a trigger rejects `UPDATE` and `DELETE` on this table. Reversals are new rows with `reverses_txn_id`.

**`direction` semantics (wallet perspective):**
- `credit` = increases unallocated wallet funds (deposit, release from allocation, reversal of a debit).
- `debit` = decreases unallocated wallet funds (allocation, invoice payment, refund, reversal of a credit).

**`balance_after`** = unallocated wallet balance after this transaction.

### 5.3 `customer_wallet_allocations`

```sql
CREATE TABLE customer_wallet_allocations (
  id                BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  wallet_id         BIGINT NOT NULL,
  customer_id       BIGINT NOT NULL,
  allocation_type   VARCHAR(16) NOT NULL
                    CHECK (allocation_type IN ('contract','invoice','sales_order')),
  contract_id       BIGINT,
  invoice_id        BIGINT,
  sales_order_id    BIGINT,
  amount            NUMERIC(19,4) NOT NULL CHECK (amount > 0),
  consumed_amount   NUMERIC(19,4) NOT NULL DEFAULT 0.0000
                    CHECK (consumed_amount >= 0),
  released_amount   NUMERIC(19,4) NOT NULL DEFAULT 0.0000
                    CHECK (released_amount >= 0),
  status            VARCHAR(16) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','completed','cancelled')),
  currency_code     CHAR(3) NOT NULL,
  created_by        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_customer_wallet_allocations_company_id UNIQUE (company_id, id),
  CONSTRAINT fk_customer_wallet_allocations_wallet FOREIGN KEY (company_id, wallet_id)
    REFERENCES customer_wallets (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_wallet_allocations_contract FOREIGN KEY (company_id, contract_id)
    REFERENCES printing_contracts (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_customer_wallet_allocations_invoice FOREIGN KEY (company_id, invoice_id)
    REFERENCES invoices (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_customer_wallet_allocations_balances CHECK (
    consumed_amount + released_amount <= amount
  )
);

CREATE UNIQUE INDEX uq_customer_wallet_allocations_contract
  ON customer_wallet_allocations (company_id, contract_id, wallet_id)
  WHERE allocation_type = 'contract';
CREATE UNIQUE INDEX uq_customer_wallet_allocations_invoice
  ON customer_wallet_allocations (company_id, invoice_id, wallet_id)
  WHERE allocation_type = 'invoice';
CREATE INDEX ix_customer_wallet_allocations_wallet_status
  ON customer_wallet_allocations (company_id, wallet_id, status);

ALTER TABLE customer_wallet_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_wallet_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY p_customer_wallet_allocations_isolation ON customer_wallet_allocations
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));
```

**Remaining allocation** = `amount − consumed_amount − released_amount`.

### 5.4 Settings

Use `company_settings` keys (no new table):

| Key | Value | Purpose |
|---|---|---|
| `wallet_enabled` | `true`/`false` | Enable wallet module |
| `wallet_liability_account_code` | e.g. `2310` | GL liability account |
| `wallet_currency_mode` | `base_only`/`multi` | Phase 1 should be `base_only` |
| `wallet_refund_threshold` | `250000.0000` | Default refund approval threshold (T03) |
| `wallet_allow_negative` | `false` | Must remain false |
| `wallet_require_approval_over` | `0.0000` | Approval threshold for adjustments/refunds |

### 5.5 Numbering

Wallet transaction numbers: `WLT-YYYY-NNNN` via the `printing_number_counters`-style counter (scope `wallet_txn`), company-scoped, 4-digit minimum, natural overflow. The wallet transaction `id` is the PK; the number is a human reference.

---

## 6. Wallet Transaction Lifecycle

### 6.1 Deposit

1. Customer tenders cash/bank transfer/mobile money.
2. Authorised user records a wallet deposit (amount, currency, bank/cash account, date, reference).
3. System locks the wallet row.
4. Posts **Dr Bank/Cash / Cr 2310 Wallet Liability**.
5. Inserts a `bank_transactions` Deposit row with `journal_txn_id`.
6. Inserts a `customer_wallet_transactions` row: `txn_type='deposit'`, `direction='credit'`, `amount`, `balance_after`.
7. Updates `customer_wallets.balance` and `version`.
8. Writes audit; saves idempotency response.

**No second cash receipt:** if the deposit is recorded through an existing payment workflow, the wallet deposit must link to that payment/journal rather than creating a second bank row.

### 6.2 Contract allocation (activation)

1. Contract is in `draft` with assessments summing exactly to the approved amount (D-10).
2. Customer acceptance/signature is recorded (D-10/T04).
3. Authorised user activates.
4. System locks the wallet and the contract.
5. Validates `wallet.balance >= allocation amount`.
6. Inserts `customer_wallet_allocations` (`allocation_type='contract'`, `contract_id`, `amount`).
7. Inserts `customer_wallet_transactions`: `txn_type='allocation'`, `direction='debit'`, `amount`, `balance_after`.
8. Posts **Dr 2310 Wallet Liability / Cr 2300 Unearned Contract Retainers**.
9. Updates contract: `status='active'`, `total_prepaid_amount=amount`, `remaining_balance=amount`, `activated_at/by`.
10. Audit; idempotency.

**No second cash receipt.** Allocation is a reclassification of liability, not cash.

### 6.3 Contract top-up (D-04)

1. Confirmed payment is received.
2. Wallet deposit (Dr Bank / Cr 2310) + allocation to the active contract (Dr 2310 / Cr 2300) in one transaction.
3. Wallet transaction `deposit` + `allocation`; allocation row updated/inserted; contract totals increased.
4. Idempotency prevents double counting.

### 6.4 Invoice payment using wallet funds

1. User selects wallet as the funding source for an invoice payment.
2. System locks the wallet and invoice.
3. Validates `wallet.balance >= payment amount` and invoice balance.
4. Inserts a `payments` row with `payment_method='Wallet'`, `deposit_to_account_id = wallet.liability_account_id`, `journal_txn_id`.
5. Inserts `payment_allocations` (normal invoice allocation).
6. Posts **Dr 2310 Wallet Liability / Cr 1100 Accounts Receivable**.
7. Inserts `customer_wallet_transactions`: `txn_type='invoice_payment'`, `direction='debit'`, `reference_type='payment'`, `reference_id=paymentId`.
8. Updates wallet balance and invoice `amount_paid`/`balance_due`/status.
9. **No `bank_transactions` row.**
10. Audit; idempotency.

**No duplicate invoice payment:** unique `(company_id, reference_type, reference_id, txn_type)` + invoice balance check + `payments` idempotency.

### 6.5 Contract consumption

1. An assessment/job is completed (not merely created/invoiced).
2. System locks the contract, allocation, and milestone.
3. Validates `allocation.remaining >= assessment agreed amount` and contract `remaining_balance >= amount`.
4. Posts **Dr 2300 Unearned Contract Retainers / Cr 4000 Printing & Sales Revenue** (or approved income account).
5. Updates `customer_wallet_allocations.consumed_amount += amount`.
6. Updates contract `remaining_balance -= amount`, `completed_assessments += 1`.
7. Inserts a `customer_wallet_allocations` consumption record? The allocation table's `consumed_amount` is the record; optionally insert a `customer_wallet_transactions` row with `txn_type='contract_consumption'`, `direction='debit'`, `amount`, `allocation_id`, but **do not change the unallocated wallet balance**. To avoid confusion, the wallet transaction ledger can include a `contract_consumption` entry with `balance_after = wallet.balance` (unchanged) and `allocation_id`; this provides a unified statement. Alternatively, keep consumption only in the allocation table. **Recommendation:** record it in the allocation table and in the contract milestone; do not insert a wallet transaction, because the wallet's unallocated balance is unchanged. The wallet statement can join allocations for a full customer statement.
8. Audit; idempotency.

**Do not auto-deduct wallet funds on job creation or invoice generation.**

### 6.6 Refund

Two cases:

**A. Unallocated wallet refund:**
1. Authorised refund request (approval, threshold).
2. Locks wallet.
3. Posts **Dr 2310 / Cr Bank/Cash**.
4. Inserts `bank_transactions` Debit (negative amount) with `journal_txn_id`.
5. Inserts wallet transaction `refund`, `direction='debit'`.
6. Updates wallet balance.
7. Audit; idempotency.

**B. Unused contract funds refund (after cancellation/settlement):**
1. Cancellation with `settlement_mode='refund'`.
2. Release remaining allocation to the wallet: Dr 2300 / Cr 2310 (reclassification), allocation `released_amount = remaining`, contract `remaining_balance = 0`.
2. Refund from wallet: Dr 2310 / Cr Bank, bank Debit row, wallet `refund` debit.
3. Audit both steps; idempotency.

### 6.7 Forfeiture

1. Cancellation with `settlement_mode='forfeit'`.
2. Dr 2300 / Cr 4900 Other Miscellaneous Income.
3. Allocation `released_amount = remaining`? For forfeiture, the funds are not released to the wallet; they are forfeited. Set allocation `status='cancelled'`, `released_amount = remaining`? That would imply release to wallet. Better: add `forfeited_amount` to the allocation, or treat `released_amount` as "no longer available" and record a separate `customer_wallet_allocations` status `cancelled` with `released_amount=remaining` and a `forfeiture` reference. To keep the balance equation, define `remaining = amount − consumed − released − forfeited`. Add `forfeited_amount` column. I'll include it in the schema.
4. Contract `remaining_balance=0`, `status='cancelled'`, settlement fields.
5. Audit.

### 6.8 Reversal

- A reversal is a **new** transaction with `reverses_txn_id`, `txn_type='reversal'`, opposite direction, and a compensating journal.
- Never update/delete the original.
- Example: reverse a deposit → Dr 2310 / Cr Bank; wallet debit; requires sufficient balance or an approved adjustment.
- Example: reverse an invoice payment → Dr 1100 / Cr 2310; restore invoice balance; wallet credit.
- Approval required; audit.

### 6.9 Adjustment

- `txn_type='adjustment'`, approved, reason mandatory.
- Dr/Cr 2310 against an approved adjustment account (e.g., 4900/6900) or a customer clearing account.
- Never use adjustments to bypass approvals or to convert AR to wallet.
- Store approval id, reason, and threshold applied.

---

## 7. Balance Calculations and Invariants

### 7.1 Wallet unallocated balance

```
wallet.balance = SUM(customer_wallet_transactions.amount)
                 WHERE direction='credit' AND wallet_id = wallet.id
                 MINUS SUM(amount)
                 WHERE direction='debit' AND wallet_id = wallet.id
```

- Only posted transactions count; reversals are separate posted rows.
- `wallet.balance >= 0`.

### 7.2 Allocation remaining

```
allocation.remaining = allocation.amount
                       - allocation.consumed_amount
                       - allocation.released_amount
                       - allocation.forfeited_amount
```

### 7.3 Total customer funds

```
total_customer_funds = wallet.balance
                       + SUM(allocation.remaining)
```

### 7.4 General-ledger reconciliation

- `2310 Customer Wallet Funds` credit balance = `SUM(customer_wallets.balance)`.
- `2300 Unearned Contract Retainers` credit balance = `SUM(allocation.remaining)`.
- `1100 Accounts Receivable` = open invoices − credit memos − unapplied payments (existing).
- `bank_transactions` deposits/debits = bank GL account movement.

### 7.5 Invariants (must always hold)

1. `customer_wallets.balance >= 0`.
2. `customer_wallets.balance = SUM(posted wallet transaction credits − debits)`.
3. `allocation.consumed_amount + released_amount + forfeited_amount <= amount`.
4. `contract.remaining_balance = SUM(allocation.remaining for that contract)` (or equal to the single allocation).
5. `2310 GL balance = SUM(customer_wallets.balance)`.
6. `2300 GL balance = SUM(allocation.remaining)`.
7. Every wallet transaction has a `journal_txn_id` (except pure allocation/consumption records that are not wallet-balance movements).
8. Every deposit/refund has a `bank_txn_id`.
9. No posted wallet transaction is updated or deleted.
10. No customer wallet spans companies.

---

## 8. Reconciliation

### 8.1 Subledger-to-GL

```sql
-- Wallet subledger vs 2310
SELECT w.company_id, w.id, w.customer_id, w.currency_code,
       w.balance AS wallet_balance,
       COALESCE(SUM(CASE WHEN t.direction='credit' THEN t.amount ELSE -t.amount END), 0) AS ledger_balance
  FROM customer_wallets w
  LEFT JOIN customer_wallet_transactions t
    ON t.company_id = w.company_id AND t.wallet_id = w.id
 GROUP BY w.id
HAVING w.balance <> COALESCE(SUM(CASE WHEN t.direction='credit' THEN t.amount ELSE -t.amount END), 0);
```

### 8.2 Allocation vs 2300

```sql
SELECT a.company_id, a.id, a.amount, a.consumed_amount, a.released_amount, a.forfeited_amount,
       a.amount - a.consumed_amount - a.released_amount - a.forfeited_amount AS remaining
  FROM customer_wallet_allocations a
 WHERE a.status = 'active'
   AND a.amount - a.consumed_amount - a.released_amount - a.forfeited_amount <> 0;
```

Compare `SUM(remaining)` to the `2300` GL balance.

### 8.3 Reconciliation exceptions

| Exception | Detection |
|---|---|
| Missing journal | `journal_txn_id IS NULL` on a posted wallet transaction |
| Duplicate deposit | same `(reference_type, reference_id, txn_type)` |
| Duplicate allocation | same contract/wallet allocation |
| Negative wallet | `balance < 0` |
| Orphaned transaction | `wallet_id`/`customer_id` mismatch |
| Cross-company | `company_id` mismatch across joined tables |
| Incorrect reversal | reversal amount/direction does not compensate the original |
| Subledger/GL difference | queries above |

### 8.4 Reconciliation cadence

- Real-time: wallet balance update + validation trigger.
- Daily: subledger-to-GL report.
- Monthly: full reconciliation with sign-off.
- Exception queue with owner and resolution.

---

## 9. Atomicity, Idempotency, Concurrency

### 9.1 Atomicity

Every wallet operation runs in `db.withCompanyDb` (RLS + role + company). The following commit or roll back together:

1. Idempotency claim (`request_keys`).
2. Wallet row lock + balance check.
3. Wallet transaction insert.
4. Allocation/payment/invoice/contract mutation.
5. `postJournalEntry`.
6. `bank_transactions` insert (deposits/refunds).
7. Audit.
8. Stored response (`request_keys`).

### 9.2 Idempotency

- Use the same-transaction claim design from `05-idempotency-design.md`.
- Routes:
  - `wallet_deposit`
  - `wallet_allocation`
  - `wallet_release`
  - `wallet_invoice_payment`
  - `wallet_refund`
  - `wallet_reversal`
  - `wallet_adjustment`
- Unique index on `(company_id, idempotency_key)`.
- Duplicate same key + same payload → replay stored response.
- Same key + different payload → `409 IDEMPOTENCY_CONFLICT`.
- In-progress → `409 IDEMPOTENCY_IN_PROGRESS`; no takeover.

### 9.3 Concurrency

- **Lock order:** wallet → allocation → contract/invoice → journal/bank → audit/request_keys.
- `SELECT ... FOR UPDATE` on the wallet before reading `balance`.
- `balance_after` computed under the lock.
- `CHECK (balance >= 0)` prevents overspend.
- Unique constraints prevent duplicate deposits/allocations.
- `40001` → 409 `SERIALIZATION_CONFLICT`; bounded retry.

### 9.4 Frontend

- No balance checks as a financial control.
- Await backend confirmation; no optimistic financial success.
- Disable repeat submits; reuse idempotency keys.

---

## 10. Permissions and Audit

### 10.1 Proposed permissions

| Permission | Purpose |
|---|---|
| `wallet:read` | View wallets, balances, statements |
| `wallet:transactions:read` | View wallet transactions |
| `wallet:deposit` | Record deposits |
| `wallet:allocate` | Allocate funds to contracts/invoices |
| `wallet:apply` | Apply wallet funds to invoices/orders |
| `wallet:refund` | Issue refunds |
| `wallet:reverse` | Reverse transactions |
| `wallet:adjust` | Post adjustments |
| `wallet:reconcile` | Run reconciliation |
| `wallet:configure` | Configure wallet settings/accounts |

### 10.2 Role mapping (proposed)

| Role | Permissions |
|---|---|
| Administrator | All |
| Accountant (Finance) | All financial wallet permissions |
| Contract Manager | `wallet:read`, `wallet:transactions:read`; operational contract actions; **no** financial wallet permissions |
| Bookkeeper | `wallet:read`, `wallet:transactions:read` (no financial authority) |
| Production Manager | `wallet:read` (or none) |
| Read-Only | `wallet:read` |

### 10.3 Approval

- Refunds, reversals, adjustments, and write-offs require maker-checker via `approval_requests`.
- New action types: `wallet_refund`, `wallet_reversal`, `wallet_adjustment`, `wallet_writeoff`.
- `approval_policies` thresholds per company; default refund threshold K250,000 (T03).
- Requester cannot approve own request (`approvalService.assertCanDecide`).
- Store the threshold applied on the wallet transaction/settlement.

### 10.4 Audit

Every wallet transaction writes `audit_log` with:
- actor, company, customer, wallet, amount, currency, txn type, reference, journal id, bank id, approval id, reason, before/after balance.

---

## 11. Tenant Isolation and RLS

- All wallet tables are company-scoped with composite keys.
- `ENABLE` + `FORCE` RLS + `app_rls_allowed(company_id)` policy.
- Composite FKs `(company_id, customer_id)`, `(company_id, wallet_id)`, `(company_id, journal_txn_id)`, `(company_id, bank_txn_id)`.
- Service uses `db.withCompanyDb`; no cross-company reads.
- Number counters are company-scoped.
- Reconciliation queries include `company_id`.
- Direct SQL with `withSystemDb` is for migrations/backups only; never for wallet operations.

---

## 12. Currency and Timezone

### 12.1 Currency

- `customer_wallets.currency_code` and all wallet tables carry `currency_code`.
- Phase 1: **base-currency wallets only** (`wallet_currency_mode='base_only'`). The wallet currency must equal `companies.base_currency`.
- Multi-currency wallets require:
  - a configured liability account per currency;
  - an explicit exchange rate and FX gain/loss posting;
  - no implicit conversion.
- Do not hardcode `ZMW` or `MWK`; use `companies.base_currency`.

### 12.2 Timezone

- Store `TIMESTAMPTZ` in UTC.
- Display and business-date calculations use `companies.timezone` (to be added; default `Africa/Blantyre`).
- Wallet transaction dates are `DATE` in company-local time; timestamps are UTC.
- No UTC ISO slicing for business dates.

---

## 13. Reversal and Adjustment Rules

- Posted wallet transactions are immutable.
- Reversals reference the original (`reverses_txn_id`) and post a compensating journal.
- A reversal that would make the wallet negative requires an approved adjustment or must be rejected.
- Adjustments require a reason, approval, and an approved counter-account.
- Never use reversals/adjustments to rewrite history or convert AR to wallet.

---

## 14. Open Design Decisions for Approval

| ID | Decision | Recommended default |
|---|---|---|
| W-01 | Two-liability model (2310 wallet + 2300 contract) vs single liability with subledger allocation | Two-liability model; preserves contract liability and D-10 |
| W-02 | Wallet funding for invoices via `payments.payment_method='Wallet'` vs a separate wallet-invoice table | Add `Wallet` to `payments.payment_method`; reuse invoice allocation |
| W-03 | Contract consumption recorded in wallet transactions vs allocation table only | Allocation table only; wallet balance unchanged |
| W-04 | Phase 1 multi-currency or base-only | Base-only; `currency_code` column ready |
| W-05 | Wallet account code `2310` vs another | `2310 Customer Wallet Funds`; configure explicitly, never auto-create |
| W-06 | Refund threshold storage: `approval_policies` vs `company_settings` | `approval_policies` row for `wallet_refund`; store applied threshold on the transaction |
| W-07 | Wallet transaction numbering `WLT-YYYY-NNNN` | Yes; 4-digit minimum, natural overflow |
| W-08 | Frozen wallet semantics | Frozen blocks debits; credits allowed only with approval; closed blocks all |

---

## 14.1 A2.1 Decision Closure — W-01…W-08

**Status: PROPOSED — PENDING BUSINESS-OWNER APPROVAL.** These are not approved.

| ID | Proposed decision | Disposition |
|---|---|---|
| W-01 | Two-liability model: `2310 Customer Wallet Funds` + `2300 Unearned Contract Retainers` | **PROPOSED** — recommended; preserves contract liability and D-10 |
| W-02 | Reuse `payments`/`payment_allocations` for wallet invoice settlement | **PROPOSED** — technically compatible only with the changes in §14.4 |
| W-03 | Contract consumption via allocation records + journal; no second wallet debit | **PROPOSED** — recommended; avoids double-counting |
| W-04 | Base-currency wallets only in Phase 1 | **PROPOSED** — recommended; `currency_code` ready for future |
| W-05 | `2310` configurable and validated per company; no auto-create | **TECHNICAL DECISION** — supported by repository evidence; no business approval required |
| W-06 | Refund threshold via `approval_policies`; snapshot applied threshold | **TECHNICAL DECISION** — supported by `approval_policies`/`approval_requests` |
| W-07 | `WLT-YYYY-NNNN`, four-digit minimum, company/year counter | **PROPOSED** — recommended; natural overflow |
| W-08 | Frozen blocks debits; credits require approval; closed blocks all and requires settlement | **PROPOSED** — recommended |

**No W-01…W-08 decision may be treated as approved until recorded in the decision register with a date.**

---

## 14.2 Wallet Control Hardening

### Negative-balance prevention

- `customer_wallets.balance` has `CHECK (balance >= 0)`.
- Every debit locks the wallet row `FOR UPDATE`, reads `balance`, and rejects if `amount > balance` with `INSUFFICIENT_WALLET_FUNDS`.
- `balance_after` is computed under the lock and checked `>= 0`.
- No overdraft path. A negative balance can only arise from an approved adjustment/reversal, which must be explicitly designed and audited.

### Atomic spending

One transaction:
1. claim idempotency;
2. lock wallet;
3. validate balance/status/currency;
4. insert wallet transaction;
5. update wallet balance/version;
6. mutate allocation/invoice/contract;
7. post journal;
8. insert bank row (deposits/refunds only);
9. audit;
10. store response.

### Concurrent requests

- Wallet row lock serializes debits.
- Unique `(company_id, idempotency_key)`.
- Unique `(company_id, reference_type, reference_id, txn_type)`.
- `40001` → 409 `SERIALIZATION_CONFLICT`; bounded retry.
- `409 IDEMPOTENCY_IN_PROGRESS` for an in-flight key; no takeover.

### Frozen and closed wallets

| Status | Debits | Credits | Closure |
|---|---|---|---|
| `active` | Allowed | Allowed | — |
| `frozen` | **Blocked** | Allowed only with approval (e.g., refund reversal) | Must be unfrozen or settled |
| `closed` | **Blocked** | **Blocked** | Requires zero balance, no active allocations, no pending reversals, final statement, approval |

**Closure prerequisites:**
- `balance = 0`;
- no active allocations with remaining > 0;
- no pending reversals/adjustments;
- no negative balance;
- final statement generated;
- Accountant approval;
- audit.

### Adjustment approval

- `txn_type='adjustment'` requires `approval_requests` action `wallet_adjustment`.
- Reason mandatory.
- Counter-account must be an approved active account.
- Store approval id and threshold applied.
- Requester cannot approve own request.

### Reversal handling

- New row with `reverses_txn_id`; original immutable.
- Opposite direction and compensating journal.
- Approval required.
- If the reversal would make the wallet negative, reject unless an approved adjustment covers the deficit.

### Duplicate prevention

- Unique idempotency key.
- Unique `(reference_type, reference_id, txn_type)`.
- Unique allocation per contract/invoice/wallet.
- Invoice balance check.
- Contract balance check.

### Account configuration validation

- `customer_wallets.liability_account_id` must reference an active `accounts` row.
- Account type must be a liability (`OtherCurrentLiability`/`LongTermLiability` as configured).
- `normal_balance='credit'`.
- `is_active=TRUE`.
- Company-scoped.
- If `2310` is missing/inactive → `NO_WALLET_LIABILITY_ACCOUNT`; **no auto-creation**.
- `2300` must remain the contract liability; do not use it as the wallet account.

### Multi-company isolation

- All wallet tables company-scoped with composite keys.
- RLS + FORCE.
- `db.withCompanyDb`.
- `rejectCrossCompanyParams`.
- Number counters company-scoped.
- Reconciliation includes `company_id`.

### Currency restrictions

- Phase 1: `currency_code = companies.base_currency` only.
- `wallet_currency_mode='base_only'`.
- No implicit conversion.
- Foreign currency requires explicit account/rate and a separate approved phase.

---

## 14.3 Contract Refund and Top-Up Flows

### Top-up (D-04)

**Recommended: wallet deposit + allocation in one transaction.**

1. Receive confirmed payment.
2. Dr Bank / Cr 2310 (wallet deposit).
3. Dr 2310 / Cr 2300 (allocation to contract).
4. Wallet transactions: `deposit` (+), `allocation` (−).
5. One bank Deposit row.
6. Contract totals increased.
7. One idempotency key for the whole top-up.

**Alternative: direct contract top-up** Dr Bank / Cr 2300. This is simpler but bypasses the wallet ledger and conflicts with D-04's "record wallet Deposit transactions." **Not recommended.**

### Contract cancellation refund

**Option A — direct contract liability → bank:**
```
Dr 2300 Unearned Contract Retainers   X
    Cr 1010 Bank                         X
```
- Allocation `released_amount += X` (or a new `refunded_amount`), contract `remaining_balance = 0`.
- One bank Debit row.
- No wallet credit.
- Simpler; fewer steps.
- The wallet statement does not show the refund unless a memo transaction is recorded.

**Option B — release to wallet, then refund (recommended for a unified wallet statement):**
```
Step 1: Dr 2300 / Cr 2310   (release)
Step 2: Dr 2310 / Cr 1010   (refund)
```
- Allocation `released_amount += X`; wallet `release` (+X); then `refund` (−X).
- One bank Debit row.
- Both steps in **one transaction**, one idempotency key.
- The intermediate wallet credit must not be spendable between steps.
- No duplicate credit: allocation released once, wallet credited once, refund debited once, bank debited once.

**Recommendation:** Option B for a single customer wallet statement and consistent two-liability accounting. Option A remains acceptable if Finance prefers direct settlement, provided the allocation is closed and the refund is audited. **Finance must choose (AF-A3).**

### No duplicate credit controls

- Contract remaining balance checked = 0 before refund.
- Allocation remaining checked = refund amount.
- Wallet balance checked ≥ refund amount.
- Unique idempotency key.
- One bank row.
- One journal per step.
- Audit each step.

---

## 14.4 Payment Compatibility Changes (W-02)

The existing `payments` model can support wallet-funded invoice settlement **only with these changes**:

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

**Compatibility conclusion:** W-02 is technically viable, but requires the above changes. Without them, wallet invoice payments would either fail the bank-account validation or create an incorrect bank journal.

---

## 15. A2 / A2.1 Architecture Verdict

The architecture is **sound and implementable**, subject to approval of W-01…W-08 and the Finance decisions in §14.3 (contract refund flow) and `19-CUSTOMER-WALLET-ACCOUNTING-MATRIX.md` (revenue recognition / contract invoice treatment). It preserves the existing AR, bank, GL, approval, audit, and RLS infrastructure. It does not convert historical balances automatically.

**A2.1 status:** documentation and design closure complete; **W-01…W-08 remain PROPOSED — PENDING BUSINESS APPROVAL**. Phase A3 implementation is not authorised until those approvals and the Finance decisions are recorded.

**No schema, migration, service, or financial transaction was created in A2/A2.1.**