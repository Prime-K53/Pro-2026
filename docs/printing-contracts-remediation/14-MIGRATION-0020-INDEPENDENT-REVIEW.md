# 14 — Migration 0020 Independent Review

**Date:** 2026-11-19
**Migration:** `db/migrations/0020_customer_wallet.up.sql` / `.down.sql`
**Base commit:** `933bcf32b9e570f97ef9d2f864274fd64c6d6e08`
**Branch:** `fix/printing-contracts-99`
**Review type:** Independent technical review + disposable PGlite test evidence
**Application status:** **NOT APPLIED** to production or any shared database
**Approval status:** **PENDING** business-owner application approval

---

## 1. Executive Summary

Migration 0020 adds the company-wide customer-wallet subledger, company/year numbering counters, `companies.timezone`, and the required CHECK extensions for `customer_wallet` journal sources, the `Wallet` payment method, and wallet/contract approval action types.

The migration was authored, applied to an in-memory PGlite database, exercised by the wallet service test suite, and rolled back/re-applied by the existing migration suite. It is **technically sound for disposable test databases**.

**It must not be applied to production or any shared database until the business owner explicitly approves application and the remaining Phase E tests pass.**

**Verdict:** **PASS — DISPOSABLE TEST DATABASES ONLY; PRODUCTION APPLICATION PENDING APPROVAL.**

---

## 2. Exact Schema Changes

### 2.1 `companies`

```sql
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Africa/Blantyre';
```

### 2.2 New tables

| Table | Purpose | RLS |
|---|---|---|
| `printing_number_counters` | Company/scope/year counters for `contract`, `exam_paper`, `wallet_txn` | ENABLE + FORCE + `app_rls_allowed(company_id)` |
| `customer_wallets` | One wallet per customer/currency | ENABLE + FORCE + `app_rls_allowed(company_id)` |
| `customer_wallet_allocations` | Funds allocated to contracts/invoices | ENABLE + FORCE + `app_rls_allowed(company_id)` |
| `customer_wallet_transactions` | Append-only wallet ledger | ENABLE + FORCE + `app_rls_allowed(company_id)` |

### 2.3 CHECK extensions

| Constraint | Change |
|---|---|
| `journal_transactions_source_type_check` | Adds `customer_wallet`; all existing source types preserved |
| `payments_payment_method_check` | Adds `Wallet`; existing five methods preserved |
| `approval_policies_action_type_check` | Adds `wallet_refund`, `wallet_reversal`, `wallet_adjustment`, `wallet_writeoff`, `contract_cancel`, `contract_refund`, `contract_forfeit`, `contract_assessment_change`, `contract_activation`, `contract_amendment` |
| `approval_requests_action_type_check` | Same additions as above |

### 2.4 New functions/triggers

| Object | Purpose |
|---|---|
| `next_printing_number(bigint, text, smallint, text, int)` | Atomic company/year counter with overflow guard and company guard |
| `trg_customer_wallet_txns_immutable()` | Rejects UPDATE/DELETE on posted wallet transactions |
| `trg_customer_wallet_balance_check()` | Deferred check that `customer_wallets.balance = SUM(credits − debits)` |
| `trg_customer_wallets_updated_at` | `updated_at` trigger |
| `trg_customer_wallet_allocations_updated_at` | `updated_at` trigger |

### 2.8 Grants

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pms_app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pms_app_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pms_app_role;
```

---

## 3. SQL Review

| Check | Result | Notes |
|---|---|---|
| Syntax / parse | **PASS** | Applied to PGlite without error after the `customer_wallet_txns` → `customer_wallet_transactions` index fix |
| Idempotent migration | **PASS** | `test:db` applies 0001→0020 from empty and re-runs cleanly |
| Down migration | **PASS** | `test:db` rolls back 0020→0000 and re-applies |
| `IF NOT EXISTS` / `DROP ... IF EXISTS` | **PASS** | Used consistently for columns/constraints |
| Transactional execution | **PASS** | Each migration file runs as one script (`migrator.ts:32-44`) |
| No destructive production down | **PASS** | Down is documented for disposable DBs only |
| No floating-point money | **PASS** | All monetary columns `NUMERIC(19,4)` |

**Initial defect found and fixed:** the first version used `ON customer_wallet_txns` for the `ix_customer_wallet_txns_customer` index; the correct relation is `customer_wallet_transactions`. The wallet test caught this; the migration was corrected before the passing run.

---

## 4. Foreign-Key Review

| FK | Local columns | Parent | On delete | Valid? |
|---|---|---|---|---|
| `fk_customer_wallets_customer` | `(company_id, customer_id)` | `customers(company_id, id)` | RESTRICT | **PASS** — `customers` has composite unique (`0003:29`) |
| `fk_customer_wallets_liability` | `(company_id, liability_account_id)` | `accounts(company_id, id)` | RESTRICT | **PASS** — `accounts` has composite unique (`0002:38`) |
| `fk_customer_wallet_allocations_wallet` | `(company_id, wallet_id)` | `customer_wallets(company_id, id)` | RESTRICT | **PASS** |
| `fk_customer_wallet_allocations_customer` | `(company_id, customer_id)` | `customers(company_id, id)` | RESTRICT | **PASS** |
| `fk_customer_wallet_allocations_contract` | `(company_id, contract_id)` | `printing_contracts(company_id, id)` | RESTRICT | **PASS** — `0007:140` |
| `fk_customer_wallet_allocations_invoice` | `(company_id, invoice_id)` | `invoices(company_id, id)` | RESTRICT | **PASS** — `0003:151` |
| `fk_customer_wallet_txns_wallet` | `(company_id, wallet_id)` | `customer_wallets(company_id, id)` | RESTRICT | **PASS** |
| `fk_customer_wallet_txns_customer` | `(company_id, customer_id)` | `customers(company_id, id)` | RESTRICT | **PASS** |
| `fk_customer_wallet_txns_allocation` | `(company_id, allocation_id)` | `customer_wallet_allocations(company_id, id)` | RESTRICT | **PASS** |
| `fk_customer_wallet_txns_journal` | `(company_id, journal_txn_id)` | `journal_transactions(company_id, id)` | RESTRICT | **PASS** — `0002:73` |
| `fk_customer_wallet_txns_bank` | `(company_id, bank_txn_id)` | `bank_transactions(company_id, id)` | RESTRICT | **PASS** — `0004:376` |
| `fk_customer_wallet_txns_payment` | `(company_id, payment_id)` | `payments(company_id, id)` | RESTRICT | **PASS** — `0003:259` |
| `fk_customer_wallet_txns_reversal` | `(company_id, reverses_txn_id)` | `customer_wallet_transactions(company_id, id)` | RESTRICT | **PASS** |
| `cancelled_by` / `completed_by` (future) | `users(id)` | Global user PK | RESTRICT | **PASS** — `0001:81` |

**No one-column FK references a two-column key.** All composite FKs have matching local `company_id` columns.

---

## 5. Constraint Review

| Constraint | Result | Notes |
|---|---|---|
| `customer_wallets.balance >= 0` | **PASS** | Prevents negative wallet |
| `customer_wallets.status IN ('active','frozen','closed')` | **PASS** | No new `credit_balance`/`partially_allocated` status |
| `customer_wallet_allocations.consumed + released + forfeited <= amount` | **PASS** | Prevents over-allocation |
| `customer_wallet_transactions.amount > 0` | **PASS** | Direction is separate |
| `customer_wallet_transactions.balance_after >= 0` | **PASS** | Prevents negative running balance |
| `customer_wallet_transactions.txn_type` | **PASS** | 8 allowed types |
| `customer_wallet_transactions.direction` | **PASS** | `credit`/`debit` |
| `printing_number_counters.last_value >= 0` | **PASS** | No negative counters |
| `printing_number_counters.scope` | **PASS** | `contract`, `exam_paper`, `wallet_txn` |
| `printing_contracts.remaining_balance <= total_prepaid_amount` | **PASS** | Existing CHECK preserved |
| `printing_contracts.completed_assessments <= total_assessments` | **PASS** | Existing CHECK preserved |

**Not added in 0020 (by design):**
- A DB trigger to enforce assessment sum for printing contracts. That belongs to the contract migration (0021+), not the wallet migration.
- A new contract status. The wallet migration does not change `printing_contracts.status`.

---

## 6. Index Review

| Index | Table | Purpose | Result |
|---|---|---|---|
| `uq_customer_wallets_company_id` | `customer_wallets` | Composite PK uniqueness | **PASS** |
| `uq_customer_wallets_customer_currency` | `customer_wallets` | One wallet per customer/currency | **PASS** |
| `ix_customer_wallets_company_customer` | `customer_wallets` | Lookup by customer | **PASS** |
| `ix_customer_wallets_company_status` | `customer_wallets` | Status filter | **PASS** |
| `uq_customer_wallet_allocations_company_id` | allocations | Composite PK | **PASS** |
| `uq_customer_wallet_allocations_contract` | allocations | One active allocation per contract/wallet | **PASS** |
| `uq_customer_wallet_allocations_invoice` | allocations | One allocation per invoice/wallet | **PASS** |
| `ix_customer_wallet_allocations_wallet_status` | allocations | Wallet/status lookup | **PASS** |
| `uq_customer_wallet_txns_company_id` | transactions | Composite PK | **PASS** |
| `uq_customer_wallet_txns_wallet_number` | transactions | Unique wallet number | **PASS** |
| `uq_customer_wallet_txns_idem` | transactions | Unique idempotency key | **PASS** |
| `uq_customer_wallet_txns_reference` | transactions | Unique deposit/invoice_payment/refund reference | **PASS** — narrowed to avoid blocking multiple allocations |
| `ix_customer_wallet_txns_wallet_date` | transactions | Statement order | **PASS** |
| `ix_customer_wallet_txns_customer` | transactions | Customer statement | **PASS** |
| `printing_number_counters` PK | counters | `(company_id, scope, year)` | **PASS** |

**Note:** `uq_customer_wallet_txns_reference` was deliberately narrowed to `txn_type IN ('deposit','invoice_payment','refund')`. Allocations and releases can legitimately repeat for the same contract (top-ups), so they are excluded.

---

## 7. Trigger/Function Review

### 7.1 `next_printing_number`

| Check | Result | Notes |
|---|---|---|
| Atomic claim | **PASS** | `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` |
| Company guard | **PASS** | `p_company_id` must equal `app.current_company_id` |
| Scope guard | **PASS** | `contract`, `exam_paper`, `wallet_txn` |
| Prefix/width guards | **PASS** | Non-empty prefix, width 1..10 |
| Overflow | **PASS** | `LPAD` is a minimum; natural overflow; no truncation |
| RLS | **PASS** | Function runs as caller; RLS applies |
| Error mapping | **PASS (code-level)** | `PRINTING_NUMBER_*` errors need route mapping in Phase A/B |

### 7.2 `trg_customer_wallet_txns_immutable`

- Rejects `UPDATE` and `DELETE` on `customer_wallet_transactions`.
- **PASS** — append-only ledger enforced.
- **Note:** the trigger is a `BEFORE` statement/row trigger; it raises `WALLET_TRANSACTION_IMMUTABLE`.

### 7.3 `trg_customer_wallet_balance_check`

- Deferred `AFTER INSERT` constraint trigger.
- Recomputes `SUM(credits − debits)` and compares to `customer_wallets.balance`.
- **PASS** — catches a service bug that forgets to update the wallet balance.
- **Note:** the service updates the wallet balance in the same transaction; the trigger runs at commit.

### 7.4 `updated_at` triggers

- `trg_customer_wallets_updated_at` and `trg_customer_wallet_allocations_updated_at` use the existing `set_updated_at()`.
- **PASS**.

---

## 8. RLS / Tenant-Isolation Review

| Check | Result | Notes |
|---|---|---|
| `ENABLE ROW LEVEL SECURITY` on all new tables | **PASS** | Four tables |
| `FORCE ROW LEVEL SECURITY` on all new tables | **PASS** | Table owner is also subject to RLS |
| Policy `USING (app_rls_allowed(company_id))` | **PASS** | Matches existing tables |
| Policy `WITH CHECK (app_rls_allowed(company_id))` | **PASS** | Prevents cross-company inserts/updates |
| Composite FKs | **PASS** | All wallet FKs include `company_id` |
| `withCompanyDb` sets role + company id | **PASS** | `db.ts:555-565` |
| `rejectCrossCompanyParams` | **PASS** | Existing middleware |
| Number counters company-scoped | **PASS** | PK includes `company_id`; RLS |
| No cross-company wallet access in service | **PASS** | Every query filters `company_id` |
| Direct SQL with `withSystemDb` | **PASS (design)** | System/migration use only; not for wallet operations |

**Conclusion:** tenant isolation is preserved and extended to the new tables.

---

## 9. Backfill Safety

| Item | Result | Notes |
|---|---|---|
| `companies.timezone` | **PASS** | Default `Africa/Blantyre`; no data rewrite |
| `printing_number_counters` | **PASS** | Starts empty; wallet numbering starts at 1 |
| Contract/exam numbering | **NOT CHANGED** | D-11 preserves existing `MAX` behavior; counter backfill for contracts/exams is a separate migration |
| `currency_code` on contracts | **NOT CHANGED** | Wallet tables have `currency_code`; contract currency is a separate migration |
| Legacy contract data | **UNTOUCHED** | No updates/deletes to `printing_contracts` |
| Legacy bank/journal data | **UNTOUCHED** | No updates/deletes |
| Existing CHECK rows | **PASS** | CHECK changes only add allowed values; existing rows remain valid |
| Down migration | **PASS** | Disposable DBs only; production roll-forward |

**No automatic historical financial correction is performed.**

---

## 9. Idempotency Review

The wallet service implements a **claim-first** protocol:

1. `INSERT INTO request_keys (..., status_code=202, response_json=NULL) ON CONFLICT DO NOTHING RETURNING id`.
   - If the insert wins, the transaction owns the key.
   - If it conflicts, the service selects the existing row `FOR UPDATE`.
2. On conflict:
   - Different `actor_user_id` → 409 `IDEMPOTENCY_ACTOR_CONFLICT`.
   - Different `payload_hash` → 409 `IDEMPOTENCY_CONFLICT`.
   - `status_code=202` + `response_json IS NULL` → 409 `IDEMPOTENCY_IN_PROGRESS`.
   - 2xx + response → replay.
3. On success, `completeWalletIdempotency` updates the same row to `201` with the response **before COMMIT**.
4. On failure, the transaction rolls back the claim and the financial mutation.
5. No timeout-based takeover.

**Guarantee:** a financial operation is posted at most once per `(company_id, route, idempotency_key)`.

**Residual verification gap:** the current wallet test proves sequential replay and insufficient-funds rejection, but not a true concurrent same-key race. Phase E must add a concurrency test (20 parallel same-key requests) to prove one success and the rest replay/409. The design is sound; the test evidence is pending.

---

## 10. Concurrency Review

| Path | Lock order | Result |
|---|---|---|
| Deposit | wallet `FOR UPDATE` → journal → bank → transaction → request_keys | **PASS** |
| Allocation | wallet `FOR UPDATE` → contract `FOR UPDATE` → allocation → journal → transaction → request_keys | **PASS** |
| Invoice payment | wallet `FOR UPDATE` → invoice `FOR UPDATE` → payment → journal → transaction → request_keys | **PASS** |
| Refund | wallet `FOR UPDATE` → journal → bank → transaction → request_keys | **PASS** |
| Status change | wallet `FOR UPDATE` → update → audit | **PASS** |
| Same-key concurrent | unique index + `FOR UPDATE` on existing row | **PASS (design)** — one wins, others block/replay/409 |
- **No cross-order deadlock** in the wallet paths: all lock the wallet before allocations/contracts/invoices.
- **Allocation vs contract** lock order is wallet → contract; the contract service's future activation must follow the same order (wallet → contract) or avoid holding the contract while locking the wallet. This is a Phase B integration note.

---

## 11. Recovery and Rollback Strategy

### 11.1 Production roll-forward

1. Full backup + tested restore.
2. Apply 0020 up in a maintenance window.
8. If a defect is found, write a new `0021_fix...up.sql` (roll-forward).
9. Never run 0020 down against production.

### 11.2 Point of no return

- Once 0020 is applied to production, the down script is prohibited.
- Recovery paths:
  - roll-forward fix migration;
  - restore from the pre-migration backup (with data loss since the backup).

### 11.3 Disposable test

- `npm run test:db` proves 0020 up/down on PGlite.
- Down is for disposable DBs only.

### 11.4 Backup/restore

- Documented in `FINAL-CERTIFICATION.md` with exact commands and RPO/RTO.

---

## 12. Existing-Data Compatibility

| Area | Result | Notes |
|---|---|---|
| Existing companies | **PASS** | `timezone` default added; no rewrite |
| Existing accounts | **PASS** | No changes |
| Existing customers | **PASS** | No changes |
| Existing invoices/payments | **PASS** | CHECK only adds `Wallet`; existing methods valid |
| Existing journals | **PASS** | CHECK only adds `customer_wallet`; existing source types valid |
| Existing approvals | **PASS** | CHECK only adds wallet/contract actions; existing actions valid |
| Existing contracts | **PASS** | No changes |
| Existing bank transactions | **PASS** | No changes |
| Existing documents/attachments | **PASS** | No changes |
| RLS | **PASS** | New tables follow the same policy |

**Legacy preflight:** still required for contract data (D-12); migration 0020 does not touch contract history.

---

## 13. Test Evidence

### 13.1 Commands and exit codes

| Command | Exit code | Result |
|---|---:|---|
| `npm run lint` | 0 | PASS — `tsc --noEmit`, no diagnostics |
| `npm run test:wallet` | 0 | PASS — 1/1 |
| `npm run test:documents` | 0 | PASS — 7/7 |
| `npm run test:workflows` | 0 | PASS — 7/7 |
| `npm run test:db` | 0 | PASS — 8/8, including 0020 up/down |
| `npm run test:printing` | 1 | 17/18 — pre-existing SKU collision, unchanged |
| `npm run build` | 0 | PASS — 1754 modules, chunk-size warning only |

### 13.2 Wallet test coverage

The wallet test (`tests/wallet/customer-wallet.test.ts`) covers:

- Migration objects: `customer_wallets`, `customer_wallet_transactions`, `customer_wallet_allocations`, `printing_number_counters`.
- `companies.timezone = 'Africa/Blantyre'`.
- Deposit 1000 → wallet balance 1000, one bank Deposit row.
- Idempotent deposit replay → same wallet transaction, no second bank row.
- Contract creation + allocation 200 → wallet 800, contract remaining 700.
- Invoice 200 + wallet payment → wallet 600, invoice paid, no bank row.
- Refund 100 + idempotent replay → wallet 500, second bank row.
- Insufficient funds → 409.
- Reconciliation → variance 0.
- Frozen wallet → deposit 409.
- Close with balance > 0 → 409.

**Not yet covered (Phase E):**
- True concurrent same-key requests.
- Reversal and adjustment flows.
- Wallet transfer.
- Multi-currency.
- API-level RBAC/rate limiting.
- UAT and 30-day shadow run.

### 13.3 Migration test evidence

`npm run test:db` output includes:

- `Empty DB Migration :: Apply all migrations 0001 -> latest` — 141 tables, 0 floating-point columns.
- `Upgrade & Rollback :: ... 20->0 rollback + staged 0004->0020 upgrade clean`.
- `Concurrent Writes & Printing Domains` — existing contract milestone race test still passes.

This proves 0020 applies up and down on PGlite and does not break the existing schema.

---

## 14. Findings and Required Corrections

### 14.1 Corrected during implementation

| ID | Finding | Correction |
|---|---|---|
| MIG-0020-01 | Initial migration used `ON customer_wallet_txns` for an index | Changed to `ON customer_wallet_transactions`; wallet test now passes |
| MIG-0020-02 | `allocateWalletFunds` initially credited the wallet liability instead of the contract liability | Now loads `printing_contracts.liability_account_id`, validates it is an active credit-normal liability, and uses it for the credit line |
| MIG-0020-03 | Unique reference index blocked multiple allocations | Narrowed to `deposit`/`invoice_payment`/`refund`; allocations can repeat for top-ups |
| MIG-0020-04 | `company_settings` column names | Used `setting_key`/`setting_value` (not `key`/`value`) |
| MIG-0020-05 | Idempotency helper was not concurrency-safe | Implemented claim-first `request_keys` protocol in the wallet service |

### 14.2 Residual items

| ID | Item | Severity | Owner |
|---|---|---|---|
| MIG-0020-06 | True concurrent same-key test not yet added | Medium | Phase E |
| MIG-0020-07 | Reversal/adjustment/transfer flows not implemented | Medium | Phase A/C |
| MIG-0020-08 | API-level RBAC/rate limiting for wallet routes not tested | Medium | Phase E |
| MIG-0020-09 | `PRINTING_NUMBER_*` errors need route mapping | Low | Phase A/B |
| MIG-0020-10 | `next_printing_number` error code `P0001` is generic | Low | Phase A/B |
| MIG-0020-11 | Legacy preflight not executed | High | Phase D/E |
| MIG-0020-12 | `customer_wallet_transactions` has no `reversed_at` column; reversal detection is by `reverses_txn_id` | Low | Design accepted |
| MIG-0020-13 | `customer_wallet_allocations.sales_order_id` has no FK (no sales-order table) | Low | Future sales orders |
| MIG-0020-14 | `customer_wallets.status` has no `suspended`; wallet freeze is `frozen` | Low | Design accepted |
| MIG-0020-15 | `request_keys` has no `claimed_at`/`completed_at`; pending state is `202`/NULL | Low | Design accepted; same-transaction claim prevents stale pending |

---

## 15. Independent Review Verdict

| Check | Result |
|---|---|
| SQL syntax / parse | **PASS** |
| Composite FKs valid | **PASS** |
| Constraints valid | **PASS** |
| Indexes valid | **PASS** |
| Triggers/functions valid | **PASS** |
| RLS + FORCE on new tables | **PASS** |
| Tenant isolation | **PASS** |
| Backfill safety | **PASS** |
| Idempotency claim-first | **PASS (design)** |
| Concurrency lock order | **PASS (design)** |
| Up/down on PGlite | **PASS** |
| Existing-data compatibility | **PASS** |
| Production application | **NOT APPLIED** |
| Business-owner application approval | **PENDING** |
| Phase E concurrency/UAT | **PENDING** |

**Migration 0020 independent review result:** **PASS — DISPOSABLE TEST DATABASES ONLY.**

**Production application is NOT authorised by this review.** It requires:
1. Business-owner explicit approval to apply.
2. Phase E concurrency and UAT tests.
3. Legacy preflight sign-off (D-12).
4. Backup/restore confirmation.

**No migration was applied to production or any shared database during this review.**