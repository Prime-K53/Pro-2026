# SlowBooks-Pro-2026 to Printing Management System — Phase 4 Accounting Parity & Deviations

This document maps every accounting module rebuilt in Phase 4 to its upstream reference in `SlowBooks-Pro-2026`, records source-to-target test coverage, and documents intentional architectural improvements for PostgreSQL multi-company isolation and printing operations.

---

## 1. Source-to-Target Module Mapping

| Accounting Capability | Upstream `SlowBooks-Pro-2026` Source | Target Printing Management System Implementation | Parity Status |
|---|---|---|---|
| **Exact Decimal & Rounding** | `app/utils/money.py`, `Decimal` (`ROUND_HALF_EVEN` / `ROUND_HALF_UP`), `NUMERIC(12,2)` / `NUMERIC(14,4)` | `/src/server/lib/decimal.ts` (`10000n` scaled `BigInt` arithmetic, `HALF_EVEN` / `HALF_UP`), PostgreSQL `NUMERIC(19,4)` | **Exact Parity + Extended Precision** (4 decimal places natively stored, 2-decimal statement rounding) |
| **Chart of Accounts & Controls** | `app/models/account.py` (`Account`, `CONTROL_ACCOUNTS`, `DETAIL_TYPES`), `app/routes/accounts.py` | `/src/server/services/accountingEngine.ts` (`ALL_ACCOUNT_TYPES`, `DETAIL_COMPATIBLE_TYPES`, `CONTROL_ACCOUNTS`), `/src/server/routes/accountingRoutes.ts` | **Exact Parity** (control codes locked, detail-type compatibility, max depth 5, cycle prevention, zero-balance deactivation) |
| **Atomic Account Balances & Rebuild** | `app/services/posting.py` (`apply_balance_deltas`, `rebuild_stored_balances`) | `applyBalanceDeltas` (ascending `account_id` row updates) & `rebuildStoredBalances` in `/src/server/services/accountingEngine.ts`, `POST /api/accounts/rebuild-balances` | **Exact Parity** |
| **Double-Entry Journal Posting & Validation** | `app/models/transaction.py`, `app/services/posting.py` (`post_transaction`, `validate_lines`), `app/routes/journals.py` | `postJournalEntry` in `accountingEngine.ts` + PostgreSQL `DEFERRABLE INITIALLY DEFERRED` constraint trigger `enforce_balanced_journal()` (`0002` / `0009`) | **Exact Parity + DB Trigger Hardening** (single-side check, Accrual vs Cash basis balance validation) |
| **Idempotency** | `app/utils/idempotency.py` / `request_keys` | `request_keys` + `journal_transactions.idempotency_key` unique index + SHA-256 payload hash conflict guard (`409 IDEMPOTENCY_CONFLICT`) | **Exact Parity** |
| **Immutability & Traceable Reversals** | `app/services/posting.py` (`void_or_reverse_transaction`), Accountant `#340` rule | `prevent_posted_journal_mutation()` trigger + `reverseJournalEntry` in `accountingEngine.ts` (`status='voided'`, bidirectional links, reconciled-line lock, `#340` Accountant own-post guard) | **Exact Parity + DB Trigger Hardening** |
| **Opening Balances Wizard** | `app/routes/opening_balances.py` / `app/services/opening_balances.py` | `postOpeningBalances` in `accountingEngine.ts`, `GET /api/opening-balances/status`, `POST /api/opening-balances`, and Opening Balances tab in `ChartOfAccountsView.tsx` | **Exact Parity** |
| **Fiscal Periods & Closing Locks** | `app/models/settings.py` (`closing_date`), period close workflows | `fiscal_periods` (`open` / `soft_closed` / `closed`), `createFiscalPeriod`, `softCloseFiscalPeriod`, `closeFiscalPeriod` (with `closing_entry` into `3200 Retained Earnings`), `reopenFiscalPeriod` | **Enhanced Parity** (supports both `closing_date` and named fiscal period lifecycle with hard DB trigger enforcement) |
| **General Ledger** | `app/routes/reports/financial.py` (`general_ledger`) | `getGeneralLedger` in `/src/server/services/financialReports.ts` | **Exact Parity** (brought-forward `< startDate`, deterministic ordering, natural-sign running balance, void markers) |
| **Trial Balance** | `app/routes/reports/financial.py` (`trial_balance`) | `getTrialBalance` in `financialReports.ts` + `/api/reports/trial-balance/csv` | **Exact Parity** (BS accounts net `<= endDate`, P&L gross `[startDate, endDate]`, `"Net Income (prior periods)"` balancing row) |
| **Profit & Loss** | `app/routes/reports/financial.py` (`profit_loss`) | `getProfitAndLoss` in `financialReports.ts` + `/api/reports/profit-and-loss/csv` | **Exact Parity** (Operating Income/Expenses vs `other_income`/`OtherExpense`, Accrual & Cash basis, `excludeAdjusting`, `hideZero`) |
| **Balance Sheet** | `app/routes/reports/financial.py` (`balance_sheet`, `_bs_period`, `_name_prior_years`, `#708`) | `getBalanceSheet` in `financialReports.ts` + `/api/reports/balance-sheet/csv` | **Exact Parity** (Assets = Liabilities + Equity, `fiscal_year_start_month` split, `#708` `"Net Income, prior years"` rule when `3200` holds balance) |
| **Cash Flow Statement (Indirect)** | `app/services/cash_flow.py` | `getCashFlowStatement` in `financialReports.ts` + `/api/reports/cash-flow/csv` | **Exact Parity** (Net Income, non-cash depreciation adjustments, working capital, investing, financing, `opening_balance` rolled into `beginningCash`, exact `beginningCash + netChange = endingCash`) |
| **Frontend Accounting UI** | `app/templates/accounts/*`, `journals/*`, `reports/*` | `/src/components/views/ChartOfAccountsView.tsx`, `/src/components/modals/JournalEntryModal.tsx`, `/src/components/views/ReportsView.tsx`, `/src/services/accountingApi.ts` | **Rebuilt Live UI** (mock `AccountingContext` ledger removed from reporting/COA/journal screens; all actions commit directly to PostgreSQL) |

---

## 2. Source-to-Target Test Coverage Comparison

| Source `SlowBooks-Pro-2026` Test Focus | Target Test Suite Case (`tests/accounting/accounting-foundation.test.ts`) | Verified Assertion |
|---|---|---|
| `test_coa_controls.py` / account validation | `1. COA & Decimal Arithmetic` | `HALF_EVEN` vs `HALF_UP` rounding, incompatible `detail_type` (`400`), control account lock (`409`), hierarchy cycle/depth 5 (`400`), zero-balance deactivation (`409`/`200`) |
| `test_journal_balancing.py` | `2. Debit/Credit Balancing & DB Trigger` | Rejects out-of-balance HTTP posts (`400`), dual debit+credit lines (`400`), inactive accounts (`400`), cash/accrual basis imbalance (`400`), and raw SQL unbalanced `COMMIT` (`DEFERRABLE` trigger) |
| `test_balance_rebuild.py` | `3. Account Balances & Rebuild` | Tracks 4-decimal natural-sign deltas and verifies `POST /api/accounts/rebuild-balances` heals intentional DB drift (`correctedCount === 1`) and logs audit record |
| `test_void_reversal.py` & `#340` | `4. Reversals, Immutability & #340 Guard` | Blocks SQL `UPDATE`/`DELETE` on posted rows, restricts Accountant reversals to own posts (`403` vs `201`), creates bidirectional void links, blocks double-reversal (`409`) & reconciled reversal (`409`) |
| `test_opening_balances.py` | `5. Opening Balances Wizard` | Maps positive/negative asset, contra-asset (`1590`), and liability/equity amounts cleanly; rejects P&L accounts (`400`); auto-balances offset to `3900 Opening Balance Equity` |
| `test_closing_date.py` / period locks | `6. Fiscal Periods & Closing Locks` | Enforces `open -> soft_closed` (adjusting-only) `-> closed` (zeroes period P&L into `3200 Retained Earnings` & blocks both new entries and reversals), plus Administrator-only audited reopen |
| `test_financial_reports.py` & `test_cash_flow.py` | `7. Financial Statements & Reconciliation` | Reconciles Trial Balance (`totalDebit === totalCredit` + `"Net Income (prior periods)"`), P&L Accrual vs Cash (`350.0000` delta) & `excludeAdjusting` (`1200.0000` delta), Balance Sheet `Assets = L+E`, Cash Flow `beginning + net = ending`, GL running cash, and audited CSV exports |
| `test_concurrency.py` | `8. Concurrent Posting` | Executes 10 simultaneous HTTP postings across shared accounts in reversed line orders -> zero deadlocks/lost updates, `rebuild-balances` finds `0` drift |
| `test_idempotency.py` | `9. Idempotency Handling` | Identical `Idempotency-Key` replay returns `200` with `idempotentReplay: true` and single ledger posting; changed payload returns `409 IDEMPOTENCY_CONFLICT` |
| `test_permissions.py` / company isolation | `10. Multi-Company & RBAC Accounting Guards` | Blocks `ProductionManager` (`403`) & `Bookkeeper` rebuilds (`403`); prevents Company B from reading or reversing Company A journals (`404`) |

---

## 3. Documented Deviations & Architectural Improvements

1. **PostgreSQL Row-Level Security (RLS) Multi-Company Isolation Instead of Per-Company SQLite Files:**
   - *SlowBooks:* Created separate SQLite database files per company (`data/company_<id>.db`).
   - *Printing Management System:* Uses a single PostgreSQL schema with mandatory `company_id` composite foreign keys `(company_id, id)` and enforced RLS policies (`pms_app_role`, `FORCE ROW LEVEL SECURITY`). Every accounting operation runs inside `db.withCompanyDb(auth.companyId, ...)` so cross-company access is impossible even at the SQL engine level.
2. **Named Fiscal Periods + Closing Entry Generation (Enhanced Beyond Scalar `closing_date`):**
   - *SlowBooks:* Primarily used a scalar `closing_date` setting.
   - *Printing Management System:* Honors the scalar `closing_date` setting *and* provides formal named `fiscal_periods` (`open`, `soft_closed`, `closed`) with non-overlapping date constraints, soft-close adjusting-only workflows, automated `closing_entry` generation into `3200 Retained Earnings`, and `Administrator`-only audited reopen.
3. **Strict Closed-Period Trigger Enforcement on Reversals:**
   - *Deviation:* Migration `0009` tightens `enforce_balanced_journal()` so **neither** new postings nor reversals can land inside a `closed` fiscal period without an explicit `Administrator` reopen first, preserving historical closed financial statements intact.
4. **4-Decimal Fixed-Point Storage (`NUMERIC(19,4)`) Across Ledger:**
   - *Deviation:* Instead of `NUMERIC(12,2)` (and `14,4` only on item rates), the entire General Ledger (`journal_lines.debit`, `journal_lines.credit`, `accounts.balance`) stores exact 4-decimal `NUMERIC(19,4)` values computed with `BigInt` (`10000n`) arithmetic. This supports fractional printing unit economics (reams-to-sheets, toner click rates) without rounding drift, rounding to 2 decimals only for display and CSV export according to `companies.rounding_mode`.
5. **Single Ledger Engine for All Printing Domains:**
   - No separate ledger or shadow accounting tables exist for Quick Print, Examination Batches, or Prepaid Printing Contracts; all commercial/production postings flow exclusively through `accountingEngine.ts` (`journal_transactions` / `journal_lines`).
