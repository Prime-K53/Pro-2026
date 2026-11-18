# PRIME ERP — COMPLETE FINANCIAL SYSTEM, CHART OF ACCOUNTS & ACCOUNTING ENGINE AUDIT

**Audit Type:** Comprehensive Financial Integrity, Accounting Accuracy & Functional Testing  
**Application:** Prime ERP / Prime Printing ERP  
**Audit Date:** 2026-11-18  
**Mode:** Read-only audit, verification and controlled testing. No application source code was changed.  
**Database examined:** PGlite data directory `.data/pms-pg` (PostgreSQL-compatible, not SQLite), read through an isolated copy.  
**Verdict:** **D — FINANCIALLY UNRELIABLE** (see Section 26)

---

## 1. Executive Summary

Prime ERP has a genuine double-entry accounting core. The engine posts balanced journal entries, enforces balance with a database constraint trigger, protects posted entries from mutation, generates mirror reversals, supports idempotency, and maintains stored account balances. The Trial Balance, Balance Sheet and Profit & Loss for the current open period reconcile in the demonstration data.

However, the financial system as a whole is **not reliable**. The audit found critical defects in transaction reversal, bank reconciliation, period-close reporting, credit-memo/customer-balance handling, inventory subledger valuation and COGS reconciliation. These defects can produce incorrect customer balances, incorrect bank balances, incorrect closed-period financial statements and un-reconcilable inventory/COGS records even though individual journal entries remain mathematically balanced.

The most serious findings are:

1. **Voiding a bank transaction reverses the GL but does not reverse the linked customer payment, sales receipt or bill payment.** The source document remains “paid”, but the GL is reversed. The document can then not be voided normally because its original journal is already voided. This breaks AR/AP, bank reconciliation and auditability.
2. **Voiding legacy/seeded invoices whose `journal_txn_id` is NULL marks the invoice voided but leaves the original journal entry posted.** In the actual database, one invoice per company has this defect. Voiding company 1 invoice 1 reduced the customer balance by K5,400 while AR in the GL stayed at K66,075.
3. **Voiding a credit memo reverses AR in the GL but does not restore the customer balance.** The credit memo remains with `remaining_credit` unchanged and the customer-balance calculation includes voided credit memos. Test result: AR GL K66,075 vs customer balance K65,975 after a K100 credit-memo void.
4. **Closed-period Profit & Loss reports show zero by default.** The period-close entry zeroes the P&L accounts and is dated on the period end date. `getProfitAndLoss` includes it. The UI’s “Exclude Adjusting” option is not a valid workaround because it also removes legitimate adjusting entries such as depreciation.
5. **The Cash Flow Statement after period close is mathematically “reconciled” but economically meaningless.** Test result: net income K0, operating cash flow -K62,725, financing inflow K60,875 (Retained Earnings), net change -K1,850, variance K0.
6. **Reopening a fiscal period does not reverse the closing entry.** New activity is reported as the entire period P&L, and re-closing fails with `IDEMPOTENCY_CONFLICT`. The period remains open and cannot be closed again through the normal endpoint.
7. **Bank Register and Bank Reconciliation omit opening balances and manual journal entries.** Company 1 bank GL is K83,150; the bank register running balance is -K1,850. Reconciliation preview shows a K83,150 difference (K85,000 if the only bank transaction is cleared). The account can never be reconciled to the GL.
8. **Inventory GL and inventory subledger do not reconcile.** Company 1 inventory GL is K16,114; `on_hand × avg_cost` valuation is K0 because all seeded items have `avg_cost = 0` and there are no inventory movements. COGS in the GL is K2,150; the COGS reconciliation subledger is K0.
9. **Sales/BOM consumption uses `unit_cost`, while production and inventory valuation use `avg_cost`.** This is not a single, consistently applied valuation method. Voiding a purchase bill also fails to restore the prior average/latest cost.
10. **Tax is not centrally controlled and the UI default contradicts the business rule.** The company tax rate is 0 and Prime Printing is not tax registered, but `InvoicesView` defaults new invoices to 16% tax. `NewInvoiceModal` and `SettingsView` pass a decimal fraction where the backend expects a percentage, understating tax by 100×. There is no tax-registration flag and no server-side check against the company tax setting.
11. **The database is configured for Zambia, not Malawi.** Both companies use `base_currency = ZMW`, `currency_symbol = K`, TPIN tax IDs and Zambian bank names. New companies also default to ZMW. If Prime Printing is a Malawi business, the reporting currency is wrong.
12. **The default server startup seeds demo data, including known administrator credentials, even in production mode.** `server.ts` passes `seedDemo: true` unconditionally.

The core ledger can be repaired, but until the reversal, period-close, bank-reconciliation and inventory/COGS defects are corrected, the financial statements and subledger balances cannot be relied upon. **No code was fixed during this audit.**

---

## 2. Overall Financial System Assessment

| Area | Assessment | Basis |
|---|---|---|
| Double-entry journal engine | **Strong** | Balanced entries, DB trigger, immutability, reversals, idempotency tests pass |
| Chart of Accounts | **Adequate** | 44 accounts, correct types/normal balances, hierarchy guards; contra creation not exposed |
| General Ledger | **Strong** | Recomputes from posted lines; stored balances match ledger |
| Trial Balance | **Strong for open periods** | Balanced; closed periods balance but P&L is zero |
| Balance Sheet | **Strong** | Balances before and after close |
| Profit & Loss | **Fails after close** | Zero by default; no correct “exclude closing only” view |
| Cash Flow | **Fails after close** | Retained earnings presented as financing; net income zero |
| AR subledger | **Fails on void paths** | Initial AR = GL; breaks after invoice/credit-memo/bank void |
| AP subledger | **Not verified in data** | No bills or payments in the actual database |
| Bank register/reconciliation | **Fails** | Opening balances/manual JEs omitted; GL vs register differ |
| Inventory valuation | **Fails** | GL K16,114 vs subledger K0; avg_cost zero; printed products excluded |
| COGS reconciliation | **Fails** | GL K2,150 vs subledger K0; void movements excluded |
| Fixed assets | **Not implemented operationally** | Tables exist, no asset register, no depreciation run, no UI/routes |
| Wallet/customer credit | **Not implemented** | No wallet tables/routes/services |
| Refunds / sales returns / purchase returns | **Not implemented** | No refund or return documents with inventory effect |
| Tax | **High risk** | No company-rate enforcement; 16% UI default; fraction/percent bugs |
| Currency/Malawi configuration | **Fails** | ZMW, not MWK; Zambian seed data |
| Period close/reopen | **Fails** | P&L/CF wrong; reopen does not reverse; re-close conflict |
| Security/RBAC | **Mostly good, with control gaps** | RBAC and isolation pass; void/reverse bypass maker-checker; demo seed |
| Performance/reliability | **Not fully verified** | Small data; PGlite single-process; aging/statements load all rows |
| Automated testing | **Good but incomplete** | 75+ checks pass; critical scenarios not covered |

**Overall:** the ledger mechanics are sound, but the surrounding financial modules do not preserve accounting integrity under normal correction workflows. The system is therefore **not financially reliable** in its current state.

---

## 3. Financial Architecture Map

### 3.1 Backend modules

| Component | File / location | Main responsibility | Database tables | API/service | Status |
|---|---|---|---|---|---|
| Accounting engine | `src/server/services/accountingEngine.ts` | COA, journals, reversals, opening balances, period close, balance rebuild | `accounts`, `journal_transactions`, `journal_lines`, `fiscal_periods`, `request_keys` | `/api/accounting/*` | Implemented |
| Financial reports | `src/server/services/financialReports.ts` | GL, TB, P&L, BS, cash flow, CSV | journal lines/accounts | `/api/reports/*` | Implemented; close-period defects |
| Sales / AR | `src/server/services/salesService.ts` | Invoices, sales receipts, payments, credit memos, AR aging, statements | `invoices`, `invoice_lines`, `payments`, `payment_allocations`, `credit_memos`, `customers` | `/api/sales/*` | Implemented; void defects |
| Purchasing / AP | `src/server/services/purchasingService.ts` | Bills, bill payments, vendor credits, AP aging, supplier statements | `bills`, `bill_lines`, `bill_payments`, `vendor_credits`, `vendors` | `/api/purchasing/*` | Implemented; no production data; void/avg-cost defects |
| Banking | `src/server/services/bankingService.ts` | Bank register, deposits, transfers, checks, reconciliation, bank feeds | `bank_accounts`, `bank_transactions`, `reconciliations` | `/api/banking/*` | Implemented; opening-balance and void defects |
| Inventory | `src/server/services/inventoryService.ts`, `salesService.consumeLineInventory`, `purchasingService`, `productionService` | Items, stock movements, BOM consumption, production issues | `inventory_items`, `inventory_movements`, `bom_*` | `/api/inventory/*`, `/api/production/*` | Implemented; valuation inconsistency |
| Operational reports | `src/server/services/operationalReports.ts` | Inventory valuation, COGS reconciliation, job profitability | inventory/movements/GL | `/api/reports/*` | Implemented; reconciliation fails on data |
| Fixed assets | `db/migrations/0006_...` | Schema only | `fixed_assets`, `fixed_asset_types` | none | **Not implemented** |
| Payroll | `PayrollView.tsx`, migration 0006 | UI/schema; no financial posting engine found | payroll tables | none found | **Partial/not verified** |
| Approvals | `src/server/services/approvalService.ts` | Maker-checker policies and request queue | `approval_policies`, `approval_requests` | `/api/approvals/*` | Implemented for creation only |
| Audit log | `src/server/audit.ts`, migration 0006 | Append-only hash-chained audit log | `audit_log` | various | Implemented |
| Company settings | `src/server/routes/companyRoutes.ts` | Company profile, currency, tax rate | `companies` | `/api/companies/current` | Implemented; tax unit bug |
| Offline sync / wallet | none | — | none | none | **Not implemented** |

### 3.2 Frontend financial components

| Component | File | Responsibility | Status |
|---|---|---|---|
| Chart of Accounts | `src/components/views/ChartOfAccountsView.tsx` | COA, opening balances, period close | Implemented |
| Invoices | `src/components/views/InvoicesView.tsx` | Invoice creation, tax, payments, CN/Estimate | Implemented; 16% tax default |
| New Invoice modal | `src/components/modals/NewInvoiceModal.tsx` | Quick invoice | Implemented; tax fraction bug |
| Receive Payment | `src/components/modals/ReceivePaymentModal.tsx` | Customer receipts | Implemented |
| Bills / Vendors | `BillsView.tsx`, `VendorsView.tsx` | AP | Implemented |
| Banking Register | `BankingRegisterView.tsx` | Bank transactions, void, CSV | Implemented; no opening balance; unsafe void |
| Bank Reconciliation | `BankReconciliationView.tsx` | Bank rec | Implemented; cannot reconcile opening balances |
| Reports | `ReportsView.tsx` | TB, P&L, BS, GL, cash flow, aging | Implemented; P&L/CF close defects |
| Settings | `SettingsView.tsx` | Company/tax settings | Implemented; tax unit bug |
| Customers | `CustomersView.tsx` | AR, statements, credit limit | Implemented |
| Finance Controls | `FinanceControlsView.tsx` | Approvals, period close, operational reports | Implemented |

### 3.3 Source of truth for balances

| Balance | Source of truth | Calculation location | Consistent? |
|---|---|---|---|
| Account balances | Posted `journal_lines` | `accounts.balance` updated on post; rebuild from lines | Yes for accrual/both lines; cash-basis rebuild gap |
| AR control (1100) | Posted journal lines | `accounts.balance` / report recomputation | Yes, until void defects |
| Customer balance | Invoices, credit memos, unapplied payments | `recalculateCustomerBalance` | No after credit-memo void; excludes voided CM incorrectly |
| AP control (2000) | Posted journal lines | `accounts.balance` / report recomputation | Yes, until bank void defects |
| Vendor balance | Bills, vendor credits, bill payments | `recalculateVendorBalance` | No vendor-credit void path; includes voided credits |
| Inventory GL (1200) | Posted journal lines | `accounts.balance` / report | Yes |
| Inventory quantity/valuation | `inventory_items.on_hand`, `avg_cost` | Purchase/sale/production/adjustment services | No; seed avg_cost zero; mixed unit/avg cost |
| Bank GL | Posted journal lines | `accounts.balance` | Yes |
| Bank register | `bank_transactions` only | `listBankTransactions` | No; omits opening balance and manual JEs |
| Bank reconciliation | `reconciliations` + last ending balance | `previewReconciliation` | No; beginning balance is last rec, not GL |
| Tax | Request `taxRate` per invoice | `computeTax4` | No; company `sales_tax_rate` unused |
| Wallet | none | none | Not implemented |

### 3.4 Data flow

```
Invoice / Bill / Payment / Journal
        │
        ▼
Service validation (company, period, accounts, balances)
        │
        ▼
postJournalEntry / source insert in one DB transaction
        │
        ├── journal_transactions (posted, immutable)
        ├── journal_lines (debit/credit, basis)
        ├── accounts.balance delta
        └── source document + subledger update
        │
        ▼
Reports recompute from journal_lines (accrual/cash basis)
```

The design is sound at the journal level. The failures occur when source documents are reversed outside their owning service, when source documents have no journal link, or when subledgers are not updated by a reversal.

---

## 4. Chart of Accounts Audit

### 4.1 Structure

| Requirement | Result | Evidence |
|---|---|---|
| Account codes | PASS | `accounts.code`, unique per company, validated |
| Account names | PASS | `accounts.name` |
| Account types | PASS | 15 types including Bank, AR, Inventory, FixedAsset, AP, Equity, Income, COGS, Expense |
| Categories/detail types | PASS | `detail_type`, e.g. `fixed_asset`, `bank_checking` |
| Parent/child | PASS | `parent_id`, depth ≤ 5, cycle/self-parent guards |
| Hierarchy | PASS | `accountHierarchyPath`, `assertParentValid` |
| Descriptions | PASS | `description` |
| Active/inactive | PASS | `is_active`; inactive posting blocked |
| Opening balances | PASS (with caveats) | `postOpeningBalances`; P&L blocked; 3900 auto-offset |
| Normal debit/credit | PASS | `normal_balance`, `DEBIT_NORMAL_TYPES` |
| Classification | PASS | Asset/liability/equity/income/expense/COGS |
| Financial statement mapping | PARTIAL | No explicit FS mapping table; statement grouping derived from type/detail |
| Posting restrictions | **FAIL** | No parent/restricted-posting flag; parent accounts can receive postings |
| Contra accounts | PARTIAL | `is_contra` and 1590 supported; API cannot create/change `isContra` |
| Duplicate codes | PASS | Unique per company |
| Duplicate names | PARTIAL | Names not unique; not necessarily an error |
| Missing types/classifications | PASS | Query found no accounts with invalid normal balance |
| Orphaned subaccounts | PASS | FK and parent validation |
| Circular parents | PASS | Cycle guard |
| Inactive accounts with transactions | PASS | `postJournalEntry` rejects inactive |
| Accounts without valid classification | PASS | No anomalies in actual data |

### 4.2 Classification and normal balances

Actual data: 44 accounts (22 per company). All accounts have a valid `account_type`, `detail_type` and `normal_balance`. The only contra account is:

| Company | Code | Name | Type | Normal balance | is_contra | Balance |
|---|---|---|---|---|---|---|
| 1 | 1590 | Accumulated Depreciation | FixedAsset | credit | true | -25,200.0000 |
| 2 | 1590 | Accumulated Depreciation | FixedAsset | credit | true | 0.0000 |

The negative stored balance for 1590 is the engine’s debit-positive natural balance convention. It is consistent with the General Ledger and Balance Sheet presentation (fixed assets net of accumulated depreciation). It is **not** a balance drift.

### 4.3 Functionality

| Function | Result | Notes |
|---|---|---|
| Create account | PASS | `POST /api/accounting/accounts` |
| Edit account | PASS | Code/name/description/parent/detail/status |
| Activate/deactivate | PASS | System/control/nonzero accounts protected |
| Create parent | PASS | Parent validation |
| Create subaccount | PASS | Parent must be in same company and not self |
| View details/transactions/ledger | PASS | Routes exist |
| Search/filter | PASS | UI supports |
| Prevent deletion with history | PASS | No delete endpoint; deactivate only |
| Prevent posting to restricted parents | **FAIL** | No restriction flag/logic |
| Create contra account | **FAIL via API** | `isContra` is not accepted by `createAccount`/`updateAccount` routes |

### 4.4 COA integrity

- Every posted journal line references an existing account.
- Account balances reconcile with the General Ledger.
- Trial Balance balances.
- No duplicate account codes.
- No orphaned journal lines.
- No inactive account with a balance.
- No account with an invalid normal balance.

**COA verdict: adequate.** The main gaps are posting restrictions, API-level contra creation and the lack of an explicit financial-statement mapping table.

---

## 5. Double-Entry Accounting Audit

### 5.1 What is correctly implemented

| Control | Result | Evidence |
|---|---|---|
| Every posted journal has debit and credit lines | PASS | `postJournalEntry` requires ≥2 lines; DB trigger |
| Total debits = total credits | PASS | Application check + deferred DB constraint trigger |
| Unbalanced journals cannot post | PASS | `UNBALANCED_JOURNAL`; DB tests |
| Posted journals cannot be silently modified | PASS | `prevent_posted_journal_mutation` trigger |
| Mirror reversals supported | PASS | `reverseJournalEntry`, bidirectional links |
| Reversals cannot double-reverse | PASS | `ALREADY_REVERSED` |
| Journal numbers unique | PASS | `entry_number` unique per company; company lock |
| Journal dates valid | PASS | `validateIsoDate` |
| Period lock respected | PASS | Service + deferred trigger |
| Duplicate posting prevented | PASS | Idempotency keys; concurrent tests |
| Failed transactions rollback | PASS | All in DB transaction; DB tests |
| Stored balances maintained | PASS | `applyBalanceDeltas`; rebuild test |
| Cash/accrual basis split | PARTIAL | `basis` supported; no production cash-basis lines; rebuild only accrual/both |

### 5.2 Journal calculation verification

The audit independently recalculated the demonstration entries and the controlled test entries.

**Test: Capital contribution K1,000,000**

Expected:

| Account | Debit | Credit |
|---|---:|---:|
| Cash/Bank | 1,000,000 | |
| Owner’s Capital | | 1,000,000 |

Result: the engine posts this pattern correctly when the caller supplies balanced lines. The accounting tests verify exact 4-decimal arithmetic.

**Test: Credit sale K300,000, COGS K180,000**

Expected:

| Account | Debit | Credit |
|---|---:|---:|
| Accounts Receivable | 300,000 | |
| Sales Revenue | | 300,000 |
| Cost of Sales | 180,000 | |
| Inventory | | 180,000 |

Result: **PARTIAL**. The revenue/AR side posts correctly. The COGS/inventory side posts only when the line references an inventory item and inventory is actually consumed. Custom lines with `unitCost` do **not** post COGS. See Section 11 and CRIT-09.

**Test: Customer payment K200,000 against K300,000 invoice**

Expected:

| Account | Debit | Credit |
|---|---:|---:|
| Bank | 200,000 | |
| Accounts Receivable | | 200,000 |
| Outstanding receivable | | 100,000 |

Result: **PASS** for the normal payment path. The engine balances and allocates correctly. The failure is in reversal, not in the original payment.

**Test: Supplier purchase K150,000 on credit**

Expected:

| Account | Debit | Credit |
|---|---:|---:|
| Inventory | 150,000 | |
| Accounts Payable | | 150,000 |

Result: **PASS** for the normal bill path (no production data in the actual DB; verified by commercial tests).

**Test: Depreciation K20,000**

Expected:

| Account | Debit | Credit |
|---|---:|---:|
| Depreciation Expense | 20,000 | |
| Accumulated Depreciation | | 20,000 |

Result: **PARTIAL**. The seeded depreciation journal is correct, but there is no fixed-asset register and no automated depreciation run. Depreciation is a manual/seed journal only.

**Test: Customer refund K20,000**

Result: **NOT IMPLEMENTED**. No refund service/route exists.

**Test: Wallet deposit / usage**

Result: **NOT IMPLEMENTED**. No wallet tables/routes/services.

### 5.3 Double-entry verdict

The **journal engine** is genuinely double-entry and well constrained. The **financial modules** do not always preserve double-entry integrity when documents are reversed or when source links are missing.

---

## 6. Journal Entry Audit

### 6.1 Actual journal population

| Company | Journal transactions | Journal lines | Source types |
|---|---:|---:|---|
| 1 | 6 | 18 | opening_balance, invoice ×3, check, depreciation |
| 2 | 2 | 4 | opening_balance, invoice |

No manual journals, credit memos, payments, bills, bill payments, vendor credits or closing entries exist in the actual database.

### 6.2 Journal integrity checks

| Check | Result | Evidence |
|---|---|---|
| Posted journals with no lines | PASS | 0 |
| Unbalanced posted journals | PASS | 0 |
| Zero-value journals | PASS | 0 |
| Dual-sided lines | PASS | 0 |
| Zero-value lines | PASS | 0 |
| Orphan journal lines | PASS | 0 |
| Duplicate entry numbers | PASS | 0 |
| Duplicate source postings | PASS | 0 |
| Null source references where required | PARTIAL | Opening balance and some seed check/depreciation rows have NULL `source_id` |
| Transactions outside fiscal periods | NOT VERIFIED | No fiscal periods exist |
| Manual journals on control accounts | PASS in data (0), **control gap in code** | No manual JEs in data; service permits them |

### 6.3 Journal traceability

This is a critical weakness:

- Company 1 invoice 1: `journal_txn_id = NULL`, although a journal with `source_type='invoice', source_id=1` exists.
- Company 2 invoice 2: `journal_txn_id = NULL`, although a journal with `source_type='invoice', source_id=2` exists.
- Both invoices also have **no invoice lines**.

The seed inserts invoices directly and posts journals separately, without backfilling `journal_txn_id` or creating invoice lines. The production service normally sets the link, but the default seeded database is defective. Any void/reverse operation that checks `journal_txn_id` will skip the reversal.

**Result:** 2 of 4 invoices in the actual database cannot be safely voided.

---

## 7. Financial Calculation Audit

### 7.1 Precision and rounding

| Item | Result |
|---|---|
| Monetary storage | `NUMERIC(19,4)` |
| Quantity storage | `NUMERIC(19,6)` |
| Tax rate storage | `NUMERIC(19,6)` |
| Calculation engine | BigInt exact arithmetic in `src/server/lib/decimal.ts` |
| Rounding modes | HALF_EVEN default; HALF_UP configurable |
| Floating-point in backend calculations | Not used for money |
| Floating-point in frontend display | Used; backend is authoritative |
| JS Number conversion | `toMoneyNumber` used for API/UI; precision risk only at extreme magnitudes |

**Result: PASS for backend arithmetic.**

### 7.2 Invoice calculations

Actual data:

| Invoice | Subtotal | Tax | Total | Paid | Balance | Math |
|---|---:|---:|---:|---:|---:|---|
| INV-PEP-1001 | 5,400 | 0 | 5,400 | 0 | 5,400 | PASS |
| INV-PEP-1002 | 675 | 0 | 675 | 0 | 675 | PASS |
| INV-PEP-1003 | 60,000 | 0 | 60,000 | 0 | 60,000 | PASS |
| INV-CB-9001 | 9,800 | 0 | 9,800 | 0 | 9,800 | PASS |

No invoice math errors were found: `total = subtotal + tax`, `amount_paid + balance_due = total`.

### 7.3 Missing invoice calculation features

| Feature | Status |
|---|---|
| Line subtotal = quantity × unit price | PASS |
| Line discounts | **NOT IMPLEMENTED** |
| Invoice-level discounts | **NOT IMPLEMENTED** |
| Additional charges | **NOT IMPLEMENTED** |
| Tax calculation | Implemented, but configuration/contract defects |
| Tax-inclusive pricing | **NOT IMPLEMENTED** |
| Early-payment discount accounting | **NOT IMPLEMENTED** |
| Rounding/decimal precision | PASS |

### 7.4 Tax calculation defect

`computeTax4` treats the input tax rate as **percentage points**:

```ts
// src/server/services/commercialHelpers.ts:351
export function computeTax4(taxable4, taxRatePct6, roundingMode) {
  // tax = taxable × rate / 100
}
```

But the frontend sends a fraction in two places:

- `NewInvoiceModal.tsx:98` initialises `taxRate` from `companyProfile.salesTaxRate`, which is `0.075` (fraction), and sends it at line 172.
- `SettingsView.tsx:146` saves `settings.salesTaxRate / 100` (fraction), while `companyApi` documents `salesTaxRate` as a percentage (`0–100`).

Controlled test:

- Invoice base K1,000, `taxRate = 0.075`
- Backend result: `tax_amount = 0.7500` (0.075%)
- If the user intended 7.5%, expected tax = K75.00
- Understatement: 100×.

Additionally, `InvoicesView.tsx:95` hard-codes the default `docTaxRate` to `'16'`, and sends it at line 510. The company’s `sales_tax_rate` is 0, and Prime Printing is not tax registered. A user who accepts the default creates a 16% tax invoice.

The backend does not use `companies.sales_tax_rate` at all in `salesService`; it accepts whatever `taxRate` the request supplies. There is no tax-registration flag and no 0–100 validation on invoice tax.

**Result: HIGH / CRITICAL for the business rule.**

---

## 8. Accounts Receivable Audit

### 8.1 Initial reconciliation

Actual data:

| Company | AR GL (1100) | Sum customer balances | Sum invoice balances | Difference |
|---|---:|---:|---:|---:|
| 1 | 66,075.0000 | 66,075.0000 | 66,075.0000 | 0 |
| 2 | 9,800.0000 | 9,800.0000 | 9,800.0000 | 0 |

AR aging (company 1, as of 2026-12-31):

| Bucket | Amount |
|---|---:|
| Current | 0 |
| 1–30 days | 65,400 |
| 31–60 days | 675 |
| 61–90 days | 0 |
| Over 90 days | 0 |
| Total | 66,075 |

The aging arithmetic is correct for the actual due dates.

### 8.2 AR failures

| Test | Expected | Actual | Status |
|---|---|---|---|
| Void invoice 1 (NULL journal link) | AR GL and customer balance both decrease by 5,400 | AR GL remains 66,075; customer balance 60,675; invoice voided; no reversal | **FAIL** |
| Void credit memo K100 | AR GL and customer balance both increase by 100 | AR GL 66,075; customer balance 65,975; credit memo voided with `remaining_credit = 100` | **FAIL** |
| AR aging after unapplied credit | Aging net of credit or show credit separately | Aging only lists positive invoice balances; ignores unapplied credits | **PARTIAL** |
| AR control reconciliation report | GL 1100 vs customer balances | No dedicated report | **NOT IMPLEMENTED** |
| Customer statement vs AR | Statement closing = customer balance | Matches in initial data; breaks after credit-memo void | **PARTIAL** |

### 8.3 Root cause

`recalculateCustomerBalance` subtracts **all** credit memos without filtering `status`:

```ts
// src/server/services/commercialHelpers.ts:500
SELECT COALESCE(SUM(remaining_credit), 0)
  FROM credit_memos
 WHERE company_id = $1 AND customer_id = $2
```

`voidCreditMemo` sets `status='voided'` but does not zero `remaining_credit`:

```ts
// src/server/services/salesService.ts:2078
await tx.query(`UPDATE credit_memos SET status = 'voided' ...`);
await recalculateCustomerBalance(tx, companyId, customerId);
```

Therefore a voided credit memo continues to reduce the customer balance while the GL has been reversed.

**Result: CRITICAL.**

---

## 9. Accounts Payable Audit

### 9.1 Data status

Actual data:

- Bills: 0
- Bill payments: 0
- Vendor credits: 0
- Vendors: 1
- AP GL (2000): 0
- Vendor balance: 0

**AP cannot be fully verified from production data.** The commercial test suite covers bill creation, part-payment, full payment, deposit drawdown, overpayment rejection, duplicate payment id, approval override and multi-company isolation, and passes.

### 9.2 AP code review findings

| Area | Result | Evidence |
|---|---|---|
| Bill total = subtotal + use tax treatment | PARTIAL | Bill total excludes use tax; use tax is expensed and credited to Sales Tax Payable. Balanced, but the bill document does not show the use-tax liability |
| Inventory receipt updates avg cost | PASS | Weighted average calculation present |
| Bill payment allocation | PASS | Allocations must not overpay; duplicate payment blocked |
| Vendor credit creation/application | PASS | Credit memo JE + application updates bill paid |
| Vendor credit void | **NOT IMPLEMENTED** | No `voidVendorCredit` service/route; `status` supports voided but no path |
| Credit application reversal | **NOT IMPLEMENTED** | No endpoint to un-apply a vendor credit |
| Void bill with vendor credit applied | **BLOCKED** | `voidBill` refuses when `amount_paid > 0`; credit cannot be voided → deadlock |
| AP aging vs vendor balance with unapplied credits | **PARTIAL** | Aging only lists positive bill balances; vendor credits are ignored |
| Supplier statement vs AP | **FAIL** | `generateSupplierStatement` includes voided bills and voided vendor credits; no status filters |
| AP control reconciliation report | **NOT IMPLEMENTED** | No GL 2000 vs vendor balance report |

### 9.3 Supplier statement defect

`generateSupplierStatement` (`src/server/services/purchasingService.ts:1829`) includes:

- prior bills without `status <> 'voided'`
- activity bills without `status <> 'voided'`
- prior/activity vendor credits without `status <> 'voided'`
- payments with `is_voided = false` only

If a bill is voided, its charge remains in the statement but is removed from vendor balance/AP aging. The statement closing balance will not agree with the vendor balance.

**Result: HIGH.**

---

## 10. Cash and Bank Audit

### 10.1 Actual bank position

Company 1:

| Account | GL balance | Bank register net | Difference |
|---|---:|---:|---:|
| 1010 Operating Checking | 83,150.0000 | -1,850.0000 | 85,000.0000 |
| 2050 Corporate Press Card | 0 | 0 | 0 |

Company 2:

| Account | GL balance | Bank register net | Difference |
|---|---:|---:|---:|
| 1010 Operating Checking | 42,000.0000 | 0 | 42,000.0000 |
| 2050 Corporate Press Card | 0 | 0 | 0 |

Company 1’s bank GL comprises an K85,000 opening balance and a -K1,850 bank charge/check. The bank register contains only the -K1,850 transaction. Its running balance starts at zero and therefore shows -K1,850.

### 10.2 Bank reconciliation

`previewReconciliation` for company 1, account 1010, statement ending K83,150:

| Scenario | Beginning | Cleared | Cleared ending | Statement | Difference |
|---|---:|---:|---:|---:|---:|
| No cleared transactions | 0 | 0 | 0 | 83,150 | 83,150 |
| Only the -1,850 bank transaction cleared | 0 | -1,850 | -1,850 | 83,150 | 85,000 |

The K85,000 opening balance can never be cleared because there is no opening-balance transaction in `bank_transactions`. The account cannot be reconciled to the GL.

### 10.3 Bank register design defect

`listBankTransactions` (`src/server/services/bankingService.ts:138`) builds a running balance from `bank_transactions` only. It does not include:

- the opening balance posted through the opening-balance wizard;
- manual journal entries that hit a bank account;
- any GL bank activity without a bank-register row.

The register’s running balance therefore does not equal the bank account’s GL balance.

### 10.4 Bank transaction void defect (CRITICAL)

`voidBankTransaction` (`src/server/services/bankingService.ts:910`) does the following:

1. Reverses the linked journal entry.
2. Marks the bank transaction voided.
3. Clears `payments.deposited_bank_txn_id` or `invoices.deposited_bank_txn_id` when present.
4. Does **not** void the customer payment, sales receipt or bill payment.
5. Does **not** recalculate customer or vendor balances.

Controlled test (company 1, payment K100 against invoice 1):

| State | AR GL | Invoice balance | Customer balance | Payment |
|---|---:|---:|---:|---|
| Before bank void | 65,975.0000 | 5,300.0000 | 5,300.0000 | active |
| After bank void | 66,075.0000 | 5,300.0000 | 5,300.0000 | active |

The GL was reversed by K100, but the source payment and invoice remained paid. The customer balance and AR GL now differ by K100.

The same defect applies to:

- customer payments;
- sales receipts;
- bill payments (the code clears only `payments`/`invoices`, not `bill_payments`);
- any bank transaction linked to a source document.

After the bank transaction is voided, the source document cannot be voided normally because `voidCustomerPayment`, `voidInvoice` or `voidBillPayment` calls `reverseJournalEntry` on an already-voided original journal and receives `ALREADY_REVERSED`.

**Result: CRITICAL.**

### 10.5 Cash on hand

There is no separate Cash account type. Bank and credit-card accounts only. Cash receipts/payments must be mapped to a Bank or Undeposited Funds account. For a business with cash sales, this is a **missing feature**.

---

## 11. Inventory and Cost of Sales Audit

### 11.1 Actual inventory position

| Item | Type | On hand | Unit cost | Avg cost | Value at avg cost |
|---|---|---:|---:|---:|---:|
| RM-A4-80G | raw_material | 120 | 145.0000 | 0.0000 | 0 |
| PP-EXBOOK-A4 | printed_product | 0 | 6.4000 | 0.0000 | 0 |
| ST-PEN-BOX | stationery | 48 | 18.0000 | 0.0000 | 0 |
| PS-DUPLEX-EXAM | printing_service | 0 | 0.3900 | 0.0000 | 0 |
| CB-NCR-A4 | printed_product | 0 | 22.0000 | 0.0000 | 0 |

Inventory GL (1200): **K16,114.0000**  
Inventory subledger valuation (`on_hand × avg_cost`): **K0**  
Difference: **K16,114.0000**

There are **zero inventory movements**.

The opening-balance journal debits inventory K18,264. A later seeded sale/COGS entry credits K2,150, leaving K16,114 in the GL. However:

- no inventory quantities were issued;
- no inventory movement rows were created;
- `avg_cost` was never set;
- the item quantities still reflect the pre-sale on-hand.

### 11.2 Valuation method inconsistency

The application does not use one consistent method:

| Area | Cost used |
|---|---|
| Purchase receipt | Weighted average `avg_cost`; `unit_cost` set to latest purchase cost |
| Production issue | `avg_cost` (fallback `unit_cost`) |
| Sales of stationery | `unit_cost` (latest cost), **not** `avg_cost` |
| Sales/BOM raw material | `unit_cost` of each BOM component, **not** `avg_cost` |
| Inventory valuation report | `avg_cost` |
| Inventory adjustment | `avg_cost` (fallback `unit_cost`) |
| COGS reconciliation | `ABS(quantity_delta) × unit_cost` from movements |

This means:

- two sales of the same material can use different costs depending on whether they go through production or direct sale;
- the GL inventory credit can differ from the subledger valuation;
- the COGS reconciliation can agree with the GL while the inventory valuation does not;
- voiding a purchase bill does not restore the prior `avg_cost` or `unit_cost`.

### 11.3 Void inventory defects

`voidBill` (`src/server/services/purchasingService.ts:943`):

- restores `on_hand` quantity;
- inserts a `void` movement at the **current** `avg_cost`;
- does **not** recalculate/restore the prior `avg_cost`;
- does **not** restore the prior `unit_cost`.

Example: opening 10 units at K10, purchase 10 at K20 → avg K15, unit K20. Void the purchase → on-hand 10 but avg remains K15 and unit remains K20. The remaining 10 units are now valued at K150 instead of K100, and future sales use K20 instead of K10.

`voidInvoice` (`src/server/services/salesService.ts:1151`):

- restores only `raw_material` and `stationery` items;
- does **not** restore `printed_product` stock;
- does not restore production WIP/COGS linked to a job.

### 11.4 COGS defects

| Test | Expected | Actual | Status |
|---|---|---|---|
| COGS GL vs inventory movement subledger | Equal | GL K2,150 vs subledger K0 | **FAIL** |
| Custom line with `unitCost` | COGS and inventory posted | Only AR/revenue posted; `total_cost` stored K100 but COGS unchanged | **FAIL** |
| BOM consumption with insufficient unreserved stock | Block or consume actual and adjust cost | If `reserved_qty = 0`, the code deducts `min(on_hand, required)` and proceeds; COGS uses actual consumed, invoice cost uses standard BOM cost | **FAIL** |
| COGS reconciliation after void | Void movement reverses subledger COGS | Void movement type excluded from reconciliation; original sale movement still counted | **FAIL** |
| Inventory valuation report coverage | All stock types | Only `raw_material` and `stationery`; printed products excluded | **FAIL** |

### 11.5 BOM consumption code defect

In `consumeLineInventory` (`src/server/services/salesService.ts:378`, especially line 555):

```ts
const nextRmOnHand6 =
  rmAvailable6 >= purchaseUnitsUsed6
    ? rmOnHand6 - purchaseUnitsUsed6
    : rmOnHand6 >= purchaseUnitsUsed6
      ? rmOnHand6 - purchaseUnitsUsed6
      : 0n;
```

Both branches are identical. When unreserved stock is insufficient and `reserved_qty = 0`, the code does not throw; it deducts what is on hand (possibly zero) and continues. The invoice’s cost uses the full BOM standard cost, while the GL COGS uses the lower actual consumed cost. This understates COGS and inventory and overstates invoice gross profit.

**Result: CRITICAL/HIGH.**

---

## 12. Wallet and Customer Credit Audit

### 12.1 Wallet

**NOT IMPLEMENTED.** There are no wallet tables, routes, services or UI components. Searches for “wallet” across the source and migrations return no implementation.

Consequences:

- Wallet deposit (Scenario J) cannot be performed.
- Wallet usage (Scenario K) cannot be performed.
- No customer wallet liability is recorded.
- No wallet transaction history or reconciliation exists.

### 12.2 Customer credit / deposits

The application represents customer credits as:

- unapplied customer payments (negative AR);
- unapplied credit memos (negative AR).

There is no separate customer-deposit/advance liability account posting. The `Unearned Contract Retainers` account 2300 exists, but no automatic posting uses it for wallet/deposit receipts.

This misclassifies customer deposits as negative accounts receivable rather than liabilities. It also means AR aging can overstate gross AR because it ignores unapplied credits.

### 12.3 Credit limit

`createInvoiceOrSalesReceipt` checks `customers.credit_limit` and blocks credit sales that would exceed it. In the actual data all credit limits are NULL, so no limit is enforced.

### 12.4 Customer statement

`generateCustomerStatement` includes invoices, payments and credit memos and computes a closing balance. It matches `customers.balance` in the initial data. It does not show unapplied payment remainders separately, and it breaks after a credit-memo void because the customer balance calculation is wrong.

**Result: PARTIAL / NOT IMPLEMENTED for wallet.**

---

## 13. Financial Statements Audit

### 13.1 Open-period statements (company 1, 2026-01-01 to 2026-12-31)

| Statement | Result |
|---|---|
| Trial Balance | PASS — total debit K310,539.0000 = total credit K310,539.0000, difference K0 |
| Balance Sheet | PASS — assets K280,139.0000 = liabilities + equity K280,139.0000, difference K0 |
| Profit & Loss | PASS — revenue K66,075, COGS K2,150, expenses K1,850, net income K60,875 |
| General Ledger | PASS — recomputes from posted lines |
| AR aging | PASS — K66,075, agrees with AR GL |
| AP aging | NOT VERIFIED — no bills |
| Inventory valuation | FAIL — K0 vs GL K16,114 |
| COGS reconciliation | FAIL — K0 vs GL K2,150 |

### 13.2 Closed-period statements

Controlled close of FY2026 with `generateClosingEntry: true`:

| Statement | Default result | Assessment |
|---|---|---|
| Trial Balance | Total debit/credit K376,614.0000, difference K0 | PASS mechanically |
| Balance Sheet | Assets K280,139 = liabilities + equity K280,139 | PASS |
| Profit & Loss | **All totals K0** | **FAIL** |
| Cash Flow | Net income K0; operating -K62,725; financing K60,875 (Retained Earnings); net change -K1,850; variance K0; `isReconciled=true` | **FAIL — reconciled but meaningless** |
| General Ledger | Includes closing entry; balances | PASS |

The “Exclude Adjusting” option was tested:

| Report | Exclude Adjusting result | Correct? |
|---|---|---|
| Profit & Loss | Net income K62,075 | **No** — excludes K1,200 depreciation as well as the closing entry; true net income is K60,875 |
| Balance Sheet | Fixed assets K116,000; equity K236,339 | **No** — excludes accumulated depreciation; true fixed assets K114,800 |
| Cash Flow | Unchanged; still net income K0 and retained earnings financing K60,875 | **No** — option ignored |

There is no “exclude closing entries only” option.

### 13.3 Conclusion

The open-period statements are correct. **Closed-period P&L and Cash Flow are not correct and cannot be made correct through the existing UI options.** This is a critical reporting failure.

---

## 14. Financial Year Audit

### 14.1 Configuration

- `companies.fiscal_year_start_month = 1` for both companies.
- Reports resolve fiscal year start from this month.
- `fiscal_periods` table exists.
- Actual database: **0 fiscal periods**.
- No period-close checklist or closed-period lock has been configured in the actual data.

### 14.2 Period close test

| Step | Result |
|---|---|
| Create FY2026 period | PASS |
| Close with closing entry | PASS — closing entry posted |
| P&L for FY2026 after close | **FAIL — K0** |
| Cash flow after close | **FAIL — retained earnings shown as financing** |
| Trial balance after close | PASS — balances |
| Balance sheet after close | PASS — balances |

### 14.3 Reopen / re-close test

| Step | Result |
|---|---|
| Reopen FY2026 | PASS — status open |
| Post new revenue K1,000 dated 2026-12-15 | PASS |
| P&L for FY2026 after reopen/new activity | **FAIL — K1,000, not K61,875** |
| Close FY2026 again | **FAIL — `IDEMPOTENCY_CONFLICT`** |
| Period status after failed re-close | Still open |
| Closing entries count | 1 |

Root cause: `reopenFiscalPeriod` does not reverse the prior closing entry; `closeFiscalPeriod` uses a fixed idempotency key based on company/period/end date; the second closing entry has different lines, so idempotency rejects it.

### 14.4 Other period findings

- The route enforces the close checklist, but the `closeFiscalPeriod` service itself does not; a direct service caller can bypass the checklist.
- `reopenFiscalPeriod` requires `periods:reopen` (Administrator only in the current role map).
- No automatic fiscal-year creation or year-end carry-forward beyond the closing entry.
- Master data (COA, inventory items) are not treated as financial-year transactions; this is correct.
- Transactions outside fiscal periods cannot be assessed because no periods exist.

**Result: CRITICAL.**

---

## 15. Transaction Lifecycle Audit

### 15.1 Normal lifecycle

| Stage | Result | Evidence |
|---|---|---|
| Quotation/estimate | PASS | Estimate service and conversion |
| Sales order / job | PASS | Production/job services |
| Invoice | PASS | Balanced JE; AR/revenue; COGS when inventory item |
| Customer payment | PASS | Balanced JE; allocation; AR relief |
| Receipt/bank deposit | PASS | Deposit/undeposited funds |
| Journal entry | PASS | Balanced, immutable |
| General Ledger | PASS | Recomputes |
| Trial Balance | PASS | Balances |
| Financial statements | PARTIAL | Open period correct; closed period wrong |

### 15.2 Void/reverse lifecycle

| Action | Result | Impact |
|---|---|---|
| Void invoice with linked journal | PARTIAL | Reverses JE; restores raw/stationery stock; does not restore printed product; blocks if paid |
| Void invoice with NULL journal link | **FAIL** | Invoice voided; JE remains; AR/revenue not reversed |
| Void sales receipt via invoice void | PASS if linked | Reverses bank txn and invoice |
| Void sales receipt via bank transaction void | **FAIL** | Invoice remains paid; GL reversed |
| Void customer payment | PASS if journal link present | Reverses JE, restores allocations, recalculates customer |
| Void customer payment after bank txn void | **FAIL** | `ALREADY_REVERSED`; payment remains active |
| Void credit memo | **FAIL** | GL reversed; customer balance not restored; `remaining_credit` unchanged |
| Apply credit memo then void invoice | **BLOCKED** | Invoice has amount_paid > 0; credit memo cannot be voided because applied; no application reversal |
| Void bill | PARTIAL | Reverses JE; restores stock; does not restore avg/unit cost; blocks if paid |
| Void bill payment | PASS if journal link present | Reverses JE, restores bill balances |
| Void bill payment after bank txn void | **FAIL** | `ALREADY_REVERSED`; bill payment remains active |
| Void bank transaction (standalone check/expense) | PASS | Reverses JE; marks bank txn voided |
| Void bank transaction (deposit) | PASS | Reverses deposit; payments return to undeposited |
| Void bank transaction (transfer) | PASS | Voids pair; reverses one JE |
| Void bank transaction (payment/sales receipt/bill payment) | **FAIL** | Source document remains; GL reversed; cannot subsequently void source |
| Customer refund | **NOT IMPLEMENTED** | No refund service |
| Sales return with inventory | **NOT IMPLEMENTED** | Credit memo is financial only |
| Purchase return with inventory | **NOT IMPLEMENTED** | Vendor credit is financial only |
| Edit posted transaction | **BLOCKED** | Immutability trigger |
| Duplicate posting | **PREVENTED** | Idempotency and unique document numbers |
| Offline synchronization | **NOT IMPLEMENTED** | No offline queue/sync |

### 15.3 Critical lifecycle findings

1. **Bank transaction void is not document-aware.** It reverses the GL but leaves the source document active. This is the single most dangerous defect.
2. **Null journal links make source documents unvoidable.** The seed data contains two such invoices.
3. **Credit-memo void leaves the customer balance wrong.**
4. **Credit-application reversal is missing**, creating a deadlock for invoices/bills with applied credits.
5. **Refunds, sales returns and purchase returns are missing**, so common correction scenarios cannot be performed.

---

## 16. Database Integrity Audit

### 16.1 Database platform

Prime ERP uses **PGlite**, a PostgreSQL-compatible embedded database, not SQLite. Data is stored in `.data/pms-pg`. The audit used an isolated copy; the live data directory was not modified.

### 16.2 Schema controls

| Control | Result | Evidence |
|---|---|---|
| Primary keys | PASS | All tables |
| Composite foreign keys `(company_id, id)` | PASS | Migrations |
| Unique constraints | PASS | Account codes, invoice numbers, payment numbers, journal entry numbers |
| Required fields | PASS | NOT NULL constraints |
| Numeric storage | PASS | `NUMERIC(19,4)` money, `NUMERIC(19,6)` quantity/rate |
| Check constraints | PASS | Non-negative debit/credit, valid types, status checks |
| Balanced-journal trigger | PASS | Deferred constraint trigger |
| Posted-journal immutability trigger | PASS | Blocks update/delete of posted entries |
| RLS / company isolation | PASS | Security and commercial tests |
| Audit log append-only | PASS | Hash-chained audit log |
| Orphan journal lines | PASS | 0 |
| Duplicate transaction references | PASS | 0 |
| Duplicate invoice/payment numbers | PASS | 0 |
| Null financial values | PASS | 0 |
| Invalid account references | PASS | 0 |
| Unbalanced journals | PASS | 0 |
| Transactions without source references | PARTIAL | Opening balance/check/depreciation seed rows have NULL `source_id` |
| Invalid financial-year references | NOT VERIFIED | No fiscal periods |
| Inconsistent customer balances | FAIL after void | See Section 8 |
| Inconsistent supplier balances | NOT VERIFIED | No bills/payments |
| Incorrect transaction dates | PASS | No obvious issues |
| SQLite numeric/float issue | N/A | PGlite numeric + BigInt |

### 16.3 Seed/data integrity

The default demo seed bypasses the service layer:

- invoices are inserted without `journal_txn_id`;
- invoices are inserted without lines;
- opening inventory is journaled without item quantities/avg cost;
- no inventory movements are created;
- no fiscal periods are created;
- bank opening balances are journaled without bank-register rows;
- fixed assets are not created;
- the depreciation journal has no linked asset.

This is not merely “demo data”; it is the data a fresh default installation receives.

**Result: PASS for schema controls, FAIL for seed/data integrity.**

---

## 17. Financial Reconciliation Results

| Reconciliation | Expected | Actual | Difference | Status |
|---|---|---|---:|---|
| Trial Balance debits = credits (company 1) | Equal | 310,539 = 310,539 | 0 | PASS |
| Balance Sheet assets = liabilities + equity (company 1) | Equal | 280,139 = 280,139 | 0 | PASS |
| AR GL 1100 = sum customer balances (company 1) | Equal | 66,075 = 66,075 | 0 | PASS |
| AR GL 1100 = sum customer balances (company 2) | Equal | 9,800 = 9,800 | 0 | PASS |
| AP GL 2000 = sum vendor balances | Equal | 0 = 0 | 0 | NOT VERIFIED (no bills) |
| Bank GL 1010 = bank register (company 1) | Equal | 83,150 vs -1,850 | 85,000 | **FAIL** |
| Bank GL 1010 = bank register (company 2) | Equal | 42,000 vs 0 | 42,000 | **FAIL** |
| Bank reconciliation (company 1) | Difference 0 | 83,150 / 85,000 | 83,150 / 85,000 | **FAIL** |
| Inventory GL 1200 = `on_hand × avg_cost` (company 1) | Equal | 16,114 vs 0 | 16,114 | **FAIL** |
| COGS GL = inventory movement subledger | Equal | 2,150 vs 0 | 2,150 | **FAIL** |
| AR GL after void invoice 1 | Decrease by 5,400 | Unchanged 66,075 | 5,400 | **FAIL** |
| AR GL after credit-memo void K100 | Increase by 100 | AR 66,075; customer 65,975 | 100 | **FAIL** |
| Bank/AR after bank transaction void K100 | Both unchanged or both reversed | AR 66,075; invoice/customer 5,300 | 100 | **FAIL** |
| P&L after period close | Historical K60,875 | K0 | 60,875 | **FAIL** |
| Cash flow after period close | Net income K60,875; no retained-earnings financing | Net income K0; financing K60,875 | 60,875 | **FAIL** |

### 17.1 Reconciliation conclusion

The open-period core reconciles. The correction workflows and bank/inventory subledgers do not. A user can create a mathematically balanced set of journals and still have materially wrong customer, bank, inventory and closed-period reports.

---

## 18. Automated Testing Coverage

### 18.1 Suites run

| Suite | Command | Result |
|---|---|---|
| Accounting foundation | `npm run test:accounting` | 10/10 PASS |
| Commercial financial | `npm run test:commercial` | 8/8 PASS |
| Finance controls | `npm run test:controls` | 10/10 PASS |
| Phase 9 workflows | `npm run test:workflows` | 7/7 PASS |
| Documents & invoicing | `npm run test:documents` | 5/5 PASS |
| Database/migrations | `npm run test:db` | 8/8 PASS |
| Security/auth isolation | `npm run test:security` | 9/9 PASS |
| Printing calculations | `npm run test:printing` | 18/18 PASS |
| SlowBooks migration | `npm run test:migration` | PASS |
| TypeScript typecheck | `npm run lint` | **FAIL** (unrelated advanced-actions test typing) |

**Total: 75+ automated checks passed; 0 financial test failures in the existing suites.**

### 18.2 What the tests cover well

- COA structure, hierarchy, cycle/depth guards, zero-balance deactivation.
- Exact decimal arithmetic and banker's rounding.
- Balanced/unbalanced journal rejection, dual-sided lines, inactive accounts, basis splits.
- Posted-journal immutability and mirror reversals.
- Stored balance tracking and rebuild.
- Opening balances, P&L block, 3900 auto-offset.
- Fiscal period soft/hard close and closed-period lock.
- Concurrent posting and idempotency.
- Multi-company isolation and RBAC.
- AR/AP/banking/FX/budget/tax commercial flows.
- Document/workflow/bank-rec E2E.
- Printing paper/toner calculations.
- SlowBooks migration/reconciliation.

### 18.3 Critical coverage gaps

The existing tests use clean in-memory databases and do **not** cover:

| Gap | Why it matters |
|---|---|
| P&L after period close | Current tests assert TB/BS/P&L before close or only TB/BS after close |
| Cash flow after period close | No test; retained earnings financing is wrong |
| Reopen → new activity → re-close | No test; `IDEMPOTENCY_CONFLICT` not caught |
| Bank transaction void linked to payment/sales receipt/bill payment | No test; critical cascade not caught |
| Bank opening balance in register/reconciliation | Tests use clean bank/undeposited flow without opening balance |
| Credit-memo void and customer balance | No test; `remaining_credit` and status filter not caught |
| Invoice with NULL `journal_txn_id` | Tests create invoices through services with links |
| Custom line with `unitCost` and no inventory item | No test; COGS omission not caught |
| Inventory valuation avg_cost vs unit_cost | Tests use clean purchases; mixed-cost/void not caught |
| Void bill and avg_cost restoration | No test |
| Printed-product stock restoration on void | No test |
| Tax fraction/percent contract | Tests pass explicit percentages; UI fraction path not tested |
| Company tax rate enforcement | No test; company rate is not used |
| Supplier statement with voided bills | No test |
| AR/AP aging with unapplied credits | No test |
| Manual journal to control accounts | No test |
| Demo seed in production | No test |

### 18.4 Proposed additional tests

The following regression tests should be added using the existing test harness and independent expected values:

1. `P&L after close must equal pre-close P&L; closing entry excluded.`
2. `Cash flow after close must not classify retained earnings as financing.`
3. `Reopen + new activity + re-close must succeed and produce full-period P&L.`
4. `Void bank transaction linked to payment must either be blocked or void the payment and restore AR.`
5. `Void bank transaction linked to sales receipt must either be blocked or void the invoice.`
6. `Void bank transaction linked to bill payment must either be blocked or void the bill payment and restore AP.`
7. `Bank register and reconciliation must include opening balance and manual bank JEs.`
8. `Void credit memo must restore customer balance and set remaining_credit to zero.`
9. `Void invoice with NULL journal_txn_id must reverse the source journal or be blocked.`
10. `Custom line with unitCost must post COGS/inventory or reject the cost.`
11. `Inventory valuation must use the same cost basis as COGS; void must restore avg/unit cost.`
12. `Void invoice must restore printed_product stock.`
13. `Invoice tax must come from company settings and be 0 when not tax registered.`
14. `Settings tax percentage must round-trip through the API without 100× error.`
15. `Supplier statement must exclude voided bills and credits.`
16. `AR/AP aging must reconcile to control accounts including unapplied credits.`

---

## 19. Security and Permissions Audit

### 19.1 Role permissions

| Role | Accounts | Journals | Banking | Invoices/Bills | Period close | Settings | Reports | Approve |
|---|---|---|---|---|---|---|---|---|
| Administrator | write/rebuild | write | write/reconcile | write | close/reopen | write | read | decide |
| Accountant | read | write | read | read | close | read | read | decide |
| Bookkeeper | write | write | write/reconcile | write | read | read | read | no |
| ProductionManager | read | read | read | read | read | read | read | no |
| Viewer | read | read | read | read | read | read | read | no |

### 19.2 What passes

- Server-side `requirePermission` on financial routes.
- Company isolation via RLS and company-scoped transactions.
- Posted-journal immutability.
- Self-approval prevention in maker-checker.
- Audit log is append-only and hash-chained.
- Financial settings require `companies:settings:write` (Administrator only).
- Cross-company parameter rejection.
- Security tests: 9/9 pass.

### 19.3 Security/control gaps

| Finding | Severity | Evidence |
|---|---|---|
| Void/reverse operations are not subject to maker-checker | **HIGH** | `POST /api/accounting/journals/:id/reverse` only requires `journals:write`; no `evaluateApprovalGate` |
| Void invoice/bill/payment/bank transaction only requires write permission | **HIGH** | Sales/purchasing/banking void routes |
| Bookkeeper can reverse any journal | **HIGH** | `reverseJournalEntry` restricts only Accountant to own journals |
| Manual journals can target control accounts (Bank/AR/AP/Inventory) | **HIGH** | `postJournalEntry` has no `is_control` rejection |
| Approval policies default to disabled | **MEDIUM** | `approval_policies.is_enabled DEFAULT FALSE`; threshold 0 |
| Demo seed runs by default in production | **HIGH** | `server.ts:13-16` `seedDemo: true`; known password `PrintingAdmin#2026` |
| No tax-registration flag | **MEDIUM** | `companies` has tax ID/rate but no registration status |
| No wallet/refund/return permissions because modules absent | **N/A** | Not implemented |

### 19.4 Demo seed risk

`server.ts` calls:

```ts
const db = await createServerDatabase(config, {
  inMemory: false,
  seedDemo: true,
});
```

`seedDemoWorkspaceIfEmpty` creates default users with a known password and demo companies. If this server is deployed to production with an empty database, it will create predictable administrator access and demo financial records. This is a **high security and data-integrity risk**.

---

## 20. Performance and Reliability Findings

### 20.1 What was verified

- 10 concurrent journal postings succeeded with no lost updates.
- Rebuild balances found 0 drift after concurrent posts.
- Company row locks are used for entry-number generation.
- Bank transactions use idempotency keys.
- Most financial writes are wrapped in a single DB transaction.
- Database constraints and triggers enforce balance/immutability.

### 20.2 Risks

| Risk | Severity | Notes |
|---|---|---|
| PGlite is embedded/single-process | MEDIUM | Suitable for single-node local use; not a scalable multi-user server database |
| AR aging loads all open invoices into JS | MEDIUM | `getArAgingReport` uses `listOpenInvoices` then loops |
| AP aging loads all open bills into JS | MEDIUM | `getApAgingReport` uses `listOpenBills` then loops |
| Customer/supplier statements load all rows | MEDIUM | No pagination |
| General Ledger may load all lines for an account | MEDIUM | Large histories can be slow/memory-heavy |
| No large-volume test | NOT VERIFIED | No 10k+ invoice/journal test |
| No offline queue | N/A | Not implemented |
| No backup/replication | MEDIUM | Single PGlite data directory |
| No connection pooling | MEDIUM | PGlite single connection; HTTP concurrency serialized |

### 20.3 Reliability verdict

The engine is reliable for small single-user workloads. It has **not** been verified for large accounting histories or multi-user production workloads.

---

## 21. Missing or Incomplete Features

| Feature | Status | Impact |
|---|---|---|
| Wallet / customer wallet | **NOT IMPLEMENTED** | Cannot perform wallet deposit/usage |
| Customer refunds | **NOT IMPLEMENTED** | Cannot refund a customer payment |
| Sales returns with inventory | **NOT IMPLEMENTED** | Credit memo reverses revenue/AR only; goods are not returned to stock |
| Purchase returns with inventory | **NOT IMPLEMENTED** | Vendor credit reverses AP only; goods are not returned to stock |
| Fixed-asset register | **NOT IMPLEMENTED** | `fixed_assets` tables exist, but no asset creation/UI/routes |
| Automated depreciation | **NOT IMPLEMENTED** | Depreciation is manual/seed only |
| AR/AP control reconciliation report | **NOT IMPLEMENTED** | No GL control vs subledger report |
| Customer deposit/advance liability | **NOT IMPLEMENTED** | Unapplied credits netted against AR |
| Supplier deposit/advance asset | **NOT IMPLEMENTED** | No unapplied bill-payment handling |
| Credit application reversal | **NOT IMPLEMENTED** | Applied invoice/bill credits cannot be unapplied |
| Vendor credit void | **NOT IMPLEMENTED** | Vendor credits cannot be cancelled |
| Cash on hand account | **NOT IMPLEMENTED** | Bank/credit-card only |
| Offline transaction queue/sync | **NOT IMPLEMENTED** | Online-only |
| Discounts and additional invoice charges | **NOT IMPLEMENTED** | Invoice total = subtotal + tax only |
| Tax-inclusive pricing | **NOT IMPLEMENTED** | Tax-exclusive only |
| Tax registration flag | **NOT IMPLEMENTED** | Cannot enforce “not tax registered” |
| Parent-account posting restriction | **NOT IMPLEMENTED** | Parent accounts can receive postings |
| Contra account creation via API | **INCOMPLETE** | `isContra` not accepted by account routes |
| Inventory valuation for printed products | **INCOMPLETE** | Report filters only raw_material/stationery |
| AR/AP aging with credits | **INCOMPLETE** | Aging ignores unapplied credits |
| Bank opening balance in register/reconciliation | **INCOMPLETE** | Register/reconciliation omit it |
| Closed-period P&L/Cash Flow | **BROKEN** | See Sections 13–14 |
| Period reopen/re-close | **BROKEN** | See Section 14 |

---

## 22. Critical Defects

### CRIT-01 — Bank transaction void breaks linked source documents

**Severity:** CRITICAL  
**Files:** `src/server/services/bankingService.ts:910-974`, `src/components/views/BankingRegisterView.tsx`  
**Description:** `voidBankTransaction` reverses the journal and marks the bank transaction voided, but does not void the linked customer payment, sales receipt or bill payment. It clears only `payments.deposited_bank_txn_id` / `invoices.deposited_bank_txn_id`. The source document remains active. A subsequent `voidCustomerPayment` / `voidInvoice` / `voidBillPayment` attempts to reverse an already-voided journal and fails with `ALREADY_REVERSED`.

**Evidence:** Company 1 payment K100:
- Before: AR GL 65,975; invoice balance 5,300; customer balance 5,300.
- After bank void: AR GL 66,075; invoice balance 5,300; customer balance 5,300.
- Payment still active; bank transaction voided.

**Impact:** Wrong AR/AP, wrong bank/GL reconciliation, orphaned customer/supplier balances, inability to correct the document through the normal service.

### CRIT-02 — Voiding an invoice with NULL `journal_txn_id` leaves the GL posted

**Severity:** CRITICAL  
**Files:** `src/server/services/salesService.ts:1151-1308`, `src/server/db.ts:178-480` (seed)  
**Description:** `voidInvoice` only reverses the journal if `inv.journal_txn_id` is set. The seed inserts invoices without the link. Voiding such an invoice marks it voided, restores inventory, but leaves AR/revenue posted.

**Evidence:** Company 1 invoice 1 (`journal_txn_id = NULL`):
- Before: AR GL 66,075; customer balance 66,075.
- After void: AR GL 66,075; customer balance 60,675; invoice status voided; no reversal.
- Difference: K5,400.

**Impact:** Overstated AR/revenue, understated customer balance, incorrect P&L.

### CRIT-03 — Credit-memo void does not restore customer balance

**Severity:** CRITICAL  
**Files:** `src/server/services/salesService.ts:2078-2167`, `src/server/services/commercialHelpers.ts:478-524`  
**Description:** `voidCreditMemo` reverses the JE and sets `status='voided'`, but leaves `remaining_credit` unchanged. `recalculateCustomerBalance` subtracts all credit memos without filtering status.

**Evidence:** Isolated K100 credit memo:
- Start: AR GL 66,075; customer balance 66,075.
- After credit memo: AR GL 65,975; customer balance 65,975.
- After void: AR GL 66,075; customer balance 65,975.
- Difference: K100.

**Impact:** Customer balance understated; AR control overstated; statements misstate.

### CRIT-04 — Closed-period Profit & Loss reports zero

**Severity:** CRITICAL  
**Files:** `src/server/services/financialReports.ts:576-740`, `src/server/services/accountingEngine.ts:933-1008`  
**Description:** The closing entry zeroes P&L accounts and is dated `period.end_date`. `getProfitAndLoss` includes all posted lines, including `source_type='closing_entry'`. After close, the P&L for the period is zero. The `excludeAdjusting` option is not a valid workaround because it also removes legitimate adjusting entries.

**Evidence:** FY2026 close:
- Default P&L: all totals K0.
- `excludeAdjusting`: net income K62,075 (true K60,875; K1,200 depreciation excluded).
- Trial Balance and Balance Sheet still balance.

**Impact:** Closed-period P&L is unusable; users cannot see historical revenue/expenses/profit.

### CRIT-05 — Cash Flow Statement after close is meaningless but “reconciled”

**Severity:** CRITICAL  
**Files:** `src/server/services/financialReports.ts:985-1192`  
**Description:** Cash flow computes net income from P&L account movements, including the closing entry. After close, net income is zero and the retained-earnings closing entry is classified as a financing inflow.

**Evidence:** FY2026 after close:
- Net income: K0
- Operating: -K62,725
- Financing: K60,875 (Retained Earnings)
- Net change: -K1,850
- Beginning cash: K85,000
- Ending cash: K83,150
- Variance: K0; `isReconciled=true`

**Impact:** A statement that appears reconciled is economically wrong.

### CRIT-06 — Period reopen does not reverse closing entry; re-close fails

**Severity:** CRITICAL  
**Files:** `src/server/services/accountingEngine.ts:1109-1161`, `accountingEngine.ts:1069-1080`  
**Description:** `reopenFiscalPeriod` sets the period open but leaves the closing entry posted. New activity is reported as the entire P&L. Re-closing uses a fixed idempotency key; different closing lines cause `IDEMPOTENCY_CONFLICT`, leaving the period open.

**Evidence:** After close/reopen/new K1,000 revenue:
- P&L FY2026: K1,000 (expected K61,875).
- Re-close: `IDEMPOTENCY_CONFLICT`.
- Period remains open; only one closing entry exists.

**Impact:** Closed periods cannot be corrected and re-closed; annual P&L is wrong after any reopen.

### CRIT-07 — Bank register and reconciliation omit opening balances/manual JEs

**Severity:** CRITICAL  
**Files:** `src/server/services/bankingService.ts:138-198`, `bankingService.ts:1467-1550`  
**Description:** `listBankTransactions` builds a running balance from `bank_transactions` only. `previewReconciliation` starts from the last completed reconciliation’s ending balance, not the GL opening balance. Opening-balance journals and manual bank JEs are invisible to both.

**Evidence:**
- Company 1 bank GL: K83,150.
- Bank register: -K1,850.
- Reconciliation preview: beginning 0, cleared 0, difference K83,150.
- With the only bank transaction cleared: difference K85,000.

**Impact:** Bank accounts cannot be reconciled; bank register and GL disagree.

### CRIT-08 — Inventory GL and subledger valuation do not reconcile

**Severity:** CRITICAL  
**Files:** `src/server/services/operationalReports.ts:391-458`, `src/server/db.ts:178-480`, `src/server/services/purchasingService.ts:780-832`, `src/server/services/salesService.ts:378-568`  
**Description:** Opening inventory is posted to the GL without creating item quantities/avg cost. The seed leaves `avg_cost = 0` for all items and creates no inventory movements. The valuation report uses `avg_cost`, so it reports K0 against a K16,114 GL balance.

**Evidence:** Company 1:
- Inventory GL: K16,114.
- `on_hand × avg_cost`: K0.
- Inventory movements: 0.
- Items: 5; all `avg_cost = 0`.

**Impact:** Inventory valuation, balance sheet inventory and COGS cannot be relied upon.

### CRIT-09 — COGS GL and subledger do not reconcile; custom-line costs are not posted

**Severity:** CRITICAL  
**Files:** `src/server/services/salesService.ts:722-1149` (especially 940-970), `src/server/services/operationalReports.ts:460-538`  
**Description:** For a custom line with `unitCost` but no `itemId`, the invoice stores `total_cost` but does not post COGS or credit inventory. The COGS reconciliation also excludes `void` movements.

**Evidence:** Custom invoice K1,000 with `unitCost = K100`:
- Invoice `total_cost = K100`.
- COGS GL remains K2,150.
- Inventory GL remains K16,114.
- AR increases by K1,000.
- Journal contains only AR and revenue.

**Impact:** Gross profit per invoice and GL gross profit diverge; inventory/COGS understated.

### CRIT-10 — Inventory valuation method is inconsistent

**Severity:** HIGH (bordering CRITICAL)  
**Files:** `src/server/services/salesService.ts:378-568`, `src/server/services/productionService.ts:1340-1420`, `src/server/services/purchasingService.ts:780-832`  
**Description:** Sales/BOM use `unit_cost`; production uses `avg_cost`; valuation uses `avg_cost`; COGS reconciliation uses movement `unit_cost`. Voiding a purchase does not restore prior avg/latest cost. Voiding an invoice does not restore printed-product stock.

**Impact:** Inventory valuation and COGS can diverge by purchase/sale/void sequence; stock can be lost.

### CRIT-11 — Tax configuration and calculation are not reliable

**Severity:** HIGH  
**Files:** `src/server/services/commercialHelpers.ts:351-365`, `src/server/services/salesService.ts:722-860`, `src/components/views/InvoicesView.tsx:95,510`, `src/components/modals/NewInvoiceModal.tsx:98,172`, `src/components/views/SettingsView.tsx:43,146`, `src/services/companyApi.ts:16-17`  
**Description:** The company tax rate is not used by invoice creation. The backend expects percentage points; two frontend paths send fractions. `InvoicesView` defaults to 16%. There is no tax-registration flag and no server-side 0–100 validation.

**Evidence:**
- Company `sales_tax_rate = 0`.
- `InvoicesView` default `docTaxRate = '16'`.
- Invoice with `taxRate = 0.075` produced K0.75 tax on K1,000 (0.075%), not K75.00 (7.5%).

**Impact:** Invoices can charge 16% tax despite the business being unregistered, or undercharge by 100× if a fraction is supplied.

### CRIT-12 — Demo seed runs by default with known credentials

**Severity:** HIGH  
**Files:** `server.ts:13-16`, `src/server/db.ts:178-480`  
**Description:** `seedDemo: true` is passed unconditionally. A fresh production database receives demo companies, users and a known administrator password.

**Impact:** Predictable administrative access and fictitious financial records in production.

---

## 23. Root Cause Analysis

### 23.1 Source-document link fragility

`journal_txn_id` is nullable and the seed does not backfill it. Services that void documents guard on `if (journal_txn_id)`. A missing link silently skips the accounting reversal. There is no database constraint requiring a posted source document to have a journal link.

### 23.2 Bank transaction void is GL-centric, not document-centric

The banking service treats a bank transaction as the primary object. When a bank transaction is linked to a payment, sales receipt or bill payment, the source document is not the primary object. Voiding the bank transaction therefore cannot correctly reverse the business document.

### 23.3 Closing-entry model conflates “zero the P&L” with “report the P&L”

The closing entry is dated on the last day of the period and included in all reports. Reports have no “exclude closing entries only” filter. The `excludeAdjusting` flag is too broad. Reopening does not reverse the closing entry, and re-closing uses a fixed idempotency key.

### 23.4 Bank register is a subset of the GL

The bank register is built from `bank_transactions`, not from all GL activity in bank accounts. Opening balances and manual journals are not represented. Reconciliation starts from the last reconciliation, not the GL.

### 23.5 Inventory uses multiple cost bases

Purchases maintain both `avg_cost` and `unit_cost`; production uses average; sales use latest; valuation uses average; COGS reconciliation uses movement latest. Opening balances and seed data do not populate `avg_cost`. Void operations do not restore prior costs.

### 23.6 Tax configuration is distributed and inconsistent

Company tax rate is stored but not used. Invoice tax is a request parameter. Frontend paths use different units. There is no registration flag. The UI default is a hard-coded 16%.

### 23.7 Currency configuration is Zambia-specific

Defaults and seed data use ZMW, TPIN and Zambian banks. The UI symbol K is shared with Malawi, masking the mismatch.

### 23.8 Seed bypasses services

The default seed writes invoices, journals, inventory and opening balances directly. It does not create the links, lines, movements or subledger values that the services would create. A fresh installation is therefore already inconsistent.

### 23.9 Testing uses clean, service-created data

Tests create documents through services, so they always have journal links, inventory movements and correct avg cost. They do not test legacy/seed data, void cascades, opening bank balances, closed-period P&L/CF, or reopen/re-close.

### 23.10 Security controls focus on creation, not correction

Maker-checker is applied to invoice/bill/payment/journal creation. Void and reverse operations bypass it. Manual journals can hit control accounts.

---

## 24. Recommended Corrections

### Priority 1 — Stop unsafe corrections (before any financial reliance)

1. **Block or cascade bank-transaction void for linked source documents.**
   - In `voidBankTransaction`, inspect `journal_transactions.source_type`.
   - If `source_type` is `payment`, `sales_receipt` or `bill_payment`, either:
     - reject with a message directing the user to void the source document, or
     - call `voidCustomerPayment`, `voidInvoice` or `voidBillPayment` in the same transaction.
   - Never clear `payments.deposited_bank_txn_id` / `invoices.deposited_bank_txn_id` for a payment/sales receipt.
   - Recalculate customer/vendor balances after any linked reversal.
   - Add regression tests for all three source types.

2. **Make journal links mandatory and backfill them.**
   - Add a migration to set `invoices.journal_txn_id` from `journal_transactions` where `source_type='invoice' AND source_id=invoices.id`.
   - Do the same for `bills`, `bill_payments`, `credit_memos`, `vendor_credits`, `payments`.
   - Add a NOT NULL constraint or a service-level invariant for posted documents.
   - Repair seed code to create invoices/lines/journals through services or to set all links.

3. **Fix credit-memo void.**
   - Set `remaining_credit = 0` when voiding an unapplied credit memo (or add a `voided_at` and exclude voided rows).
   - Filter `status <> 'voided'` in `recalculateCustomerBalance` and `recalculateVendorBalance`.
   - Add an application-reversal function so applied credit memos can be unapplied before voiding.
   - Recalculate customer balance and verify AR GL = customer balance.

4. **Prevent manual journals from posting to control accounts.**
   - Reject `is_control` accounts in `postJournalEntry` unless a dedicated subledger posting is used.
   - At minimum, block Bank, AccountsReceivable, AccountsPayable and Inventory control accounts.

5. **Require maker-checker for void/reverse.**
   - Add approval policies for `reversal`, `void_invoice`, `void_bill`, `void_payment`, `void_bank_transaction`.
   - Apply `evaluateApprovalGate` in the reverse and void routes.
   - Prevent the same user from posting and reversing above threshold.

### Priority 2 — Repair period-close reporting

6. **Exclude closing entries from P&L and Cash Flow.**
   - Add `AND jt.source_type <> 'closing_entry'` to P&L and cash-flow P&L aggregation.
   - Keep closing entries in Balance Sheet/Trial Balance/GL.
   - Add a specific “exclude closing entries” option if needed; do not overload `excludeAdjusting`.

7. **Make reopen reverse the closing entry.**
   - On reopen, post a mirror reversal of the closing entry (or mark it voided with a reversal) and link it to the reopen.
   - On re-close, use a new idempotency key that includes a close sequence/version.
   - Ensure P&L for the reopened period includes both pre-close and post-reopen activity.
   - Add tests for close → reopen → new activity → re-close.

8. **Fix Cash Flow classification.**
   - Compute net income from pre-close P&L activity, excluding closing entries.
   - Do not classify retained-earnings closing entries as financing.
   - Ensure `isReconciled` is not used to mask a zero-net-income result.

### Priority 3 — Repair bank register/reconciliation

9. **Include opening balances and manual bank JEs in the bank register.**
   - Build the register from GL bank-account lines, not only `bank_transactions`.
   - Add an “opening balance” row from the GL before the first bank transaction.
   - Include manual journals that hit the bank account.
   - Make the register running balance equal the bank account GL balance.

10. **Reconcile from the GL opening balance.**
    - `previewReconciliation` beginning balance should be the GL balance at the start date, adjusted for prior cleared items, not only the last reconciliation.
    - Add an opening-balance clearing mechanism.
    - Add a test with an opening balance.

### Priority 4 — Repair inventory and COGS

11. **Use one cost basis.**
    - Choose weighted average (recommended) and use `avg_cost` in sales, BOM, production, adjustments, valuation and COGS reconciliation.
    - Store the cost used on each movement and use it consistently in reports.
    - If standard/latest cost is intended, rename and remove `avg_cost` or stop using it in valuation.

12. **Restore costs on void.**
    - `voidBill` must restore prior `avg_cost` and `unit_cost`, not just quantity.
    - `voidInvoice` must restore printed-product stock and any production WIP/COGS.
    - Add tests for void after a price change.

13. **Fix custom-line COGS.**
    - If a custom line has `unitCost > 0`, either post COGS/inventory (requires an inventory item) or reject the cost.
    - Do not store `total_cost` on an invoice without a corresponding GL entry.

14. **Fix BOM under-consumption.**
    - If unreserved stock is insufficient, block the sale or post a documented shortage/variance.
    - Do not silently deduct `min(on_hand, required)` and continue.
    - Align invoice cost with actual GL COGS.

15. **Include all stock types in inventory valuation.**
    - Add `printed_product` and any other inventory types to `getInventoryValuationReport`.
    - Include void movements in COGS reconciliation or reverse them explicitly.

### Priority 5 — Repair tax and currency configuration

16. **Make company tax settings authoritative.**
    - Add `is_tax_registered` to `companies`.
    - `createInvoiceOrSalesReceipt` should use the company rate when the request does not specify one, and should force zero when not registered.
    - Validate `taxRate` between 0 and 100.
    - Add line-level `taxable` and customer exemption to credit memos.
    - Fix `SettingsView` to send percent (not fraction) and `NewInvoiceModal` to send percent.
    - Remove the hard-coded 16% default from `InvoicesView`; default to the company rate.

17. **Configure Malawi correctly.**
    - Change `base_currency` to `MWK` for Malawi companies.
    - Change the default in `db.ts`, `config.ts` and migration defaults.
    - Display `MWK` or `K` consistently with the currency code.
    - Replace Zambian seed companies/banks/TPIN with Malawi equivalents or make them configurable.

### Priority 6 — Security and data hygiene

18. **Disable demo seeding in production.**
    - Pass `seedDemo: false` when `NODE_ENV=production`.
    - Remove or rotate the default password.
    - Add a first-run setup flow that requires a real administrator.

19. **Restrict manual journals and reversals.**
    - Block control accounts.
    - Require maker-checker for reversals/voids.
    - Restrict Bookkeeper reversal to own journals or remove reversal permission.

20. **Repair seed data.**
    - Create invoices/lines/journals through services.
    - Set `avg_cost`, `unit_cost`, on-hand and inventory movements.
    - Create bank opening-balance register rows.
    - Create fiscal periods.
    - Create fixed assets and depreciation schedules if used.

### Priority 7 — Add missing modules

21. Implement customer refunds, sales returns with inventory, purchase returns with inventory, fixed-asset register/depreciation, wallet/customer deposits, AR/AP control reconciliation, cash-on-hand, credit-application reversal and vendor-credit void.

22. Add offline synchronization only if required; currently online-only.

### Priority 8 — Testing and performance

23. Add the regression tests listed in Section 18.4.
24. Add large-volume tests (10k invoices, 100k journal lines) and pagination for aging/statements/GL.
25. Consider migrating from embedded PGlite to a client/server PostgreSQL deployment if multi-user production is intended.

---

## 25. Proposed Implementation Phases

### Phase 1 — Emergency controls (days)

- Block unsafe bank-transaction void for linked documents.
- Backfill journal links; add NOT NULL/invariant.
- Fix credit-memo void and recalculation filters.
- Block manual journals to control accounts.
- Require approval for void/reverse.
- Disable demo seed in production.

**Exit criteria:** No void path can leave a source document active while its GL is reversed; no customer/vendor balance can diverge after a void; production does not seed demo users.

### Phase 2 — Data repair (days)

- Backfill missing journal links and invoice lines.
- Rebuild inventory `avg_cost`/quantities/movements.
- Create bank opening-balance register rows.
- Create fiscal periods.
- Reconcile AR/AP/bank/inventory/COGS and document differences.
- Repair or reverse the seeded invoices with null links.

**Exit criteria:** AR = customer balances, bank GL = register, inventory GL = valuation, COGS GL = subledger.

### Phase 3 — Period-close reporting (week)

- Exclude closing entries from P&L/Cash Flow.
- Make reopen reverse closing entries.
- Fix re-close idempotency.
- Fix cash-flow retained-earnings classification.
- Add close/reopen/reclose tests.

**Exit criteria:** Closed-period P&L equals pre-close P&L; cash flow is meaningful; reopen/reclose succeeds.

### Phase 4 — Bank register/reconciliation (week)

- Register from GL bank lines including opening balance/manual JEs.
- Reconcile from GL opening balance.
- Add opening-balance clearing.
- Add bank-rec tests.

**Exit criteria:** Bank register running balance = GL; reconciliation can reach zero.

### Phase 5 — Inventory/COGS (week)

- Single cost basis.
- Restore costs on void.
- Fix custom-line COGS.
- Fix BOM shortage handling.
- Include all stock types.
- Add inventory/COGS tests.

**Exit criteria:** Inventory valuation = GL; COGS = subledger; void restores stock and cost.

### Phase 6 — Tax/currency (week)

- Company tax settings authoritative.
- Tax registration flag.
- Fix percent/fraction.
- Remove 16% default.
- Change base currency/defaults to MWK.
- Add tax tests.

**Exit criteria:** No tax charged when unregistered; tax rate round-trips; reports use MWK.

### Phase 7 — Missing modules (weeks)

- Refunds, sales returns, purchase returns.
- Fixed assets/depreciation.
- Wallet/customer deposits or formal decision not to implement.
- AR/AP control reconciliation.
- Cash on hand.
- Credit application reversal/vendor credit void.

**Exit criteria:** Required business scenarios A–L can be performed and reconcile.

### Phase 8 — Security/performance (weeks)

- Role/approval review.
- Remove demo seed.
- Pagination/large-volume tests.
- Decide PGlite vs PostgreSQL.
- Backup/recovery.

**Exit criteria:** Security review passed; large-volume tests pass; backup/restore tested.

---

## 26. Final Financial Integrity Verdict

### **D — FINANCIALLY UNRELIABLE**

The double-entry journal engine is fundamentally sound: it posts balanced entries, enforces balance at the database level, protects posted journals, reverses entries, and supports idempotency. The open-period Trial Balance and Balance Sheet reconcile.

However, the financial system as a whole cannot be relied upon because:

- bank transaction void breaks linked payments, sales receipts and bill payments;
- invoices with missing journal links can be voided without reversing the GL;
- credit-memo void leaves customer balances wrong;
- closed-period P&L is zero and Cash Flow is meaningless;
- reopening a period does not reverse the closing entry and re-closing fails;
- bank register/reconciliation omit opening balances and manual bank entries;
- inventory GL and subledger valuation do not reconcile;
- COGS GL and subledger do not reconcile;
- inventory cost bases are inconsistent and void operations lose cost/stock;
- tax configuration can charge 16% despite an unregistered, zero-rate company;
- the database is configured for Zambia (ZMW), not Malawi (MWK);
- the default server seeds demo data and known credentials in production.

These are not cosmetic issues. They can produce materially incorrect customer, supplier, bank, inventory and closed-period financial statements. **Prime ERP must not be used as the system of record for financial reporting until the critical defects in Sections 22–24 are corrected and independently re-tested.**

---

## Appendix A — Test Results Table

| Test ID | Module | Test Description | Expected Result | Actual Result | Status | Evidence |
|---|---|---|---|---|---|---|
| T-01 | COA | Account structure, types, hierarchy, cycle/depth | Valid | 44 accounts, valid types, no cycles | PASS | COA queries; accounting tests |
| T-02 | COA | Account balances vs General Ledger | Equal | All accounts match ledger natural balance | PASS | `links-query` / stored balance query |
| T-03 | COA | Duplicate/invalid codes | None | None | PASS | Unique constraints; query |
| T-04 | COA | Inactive accounts with balance | None | None | PASS | Query |
| T-05 | COA | Contra account handling | 1590 credit/negative | 1590 credit/negative; API cannot create new | PARTIAL | Accounts query; routes |
| T-06 | COA | Posting to restricted parent accounts | Blocked | Not blocked | FAIL | No restriction logic |
| T-07 | Journal | Unbalanced journal rejected | Rejected | Rejected by app and DB trigger | PASS | Accounting tests |
| T-08 | Journal | Posted journal immutable | Rejected | Rejected | PASS | Accounting tests |
| T-09 | Journal | Mirror reversal | Original voided, reversal posted | Works | PASS | Accounting tests |
| T-10 | Journal | Duplicate posting/idempotency | No duplicate | Replay 200; modified payload 409 | PASS | Accounting tests |
| T-11 | Journal | Concurrent posting | No lost updates | 10/10 posts; 0 drift | PASS | Accounting tests |
| T-12 | Journal | Manual journal to control account | Blocked | Not blocked | FAIL | Code review; no data |
| T-13 | Journal | Journal source traceability | Every posted doc linked | 2 invoices NULL link | FAIL | DB query |
| T-14 | Trial Balance | Debits = credits (open period) | Equal | K310,539 = K310,539 | PASS | `reports-output` |
| T-15 | Balance Sheet | Assets = liabilities + equity | Equal | K280,139 = K280,139 | PASS | `reports-output` |
| T-16 | P&L | Open-period net income | K60,875 | K60,875 | PASS | `reports-output` |
| T-17 | P&L | Closed-period net income | K60,875 | K0 | FAIL | `close-test-output` |
| T-18 | P&L | Exclude Adjusting workaround | K60,875 | K62,075 (excludes depreciation) | FAIL | `close-exclude-output` |
| T-19 | Cash Flow | Closed-period net income | K60,875 | K0; retained earnings K60,875 financing | FAIL | `cashflow-close-output` |
| T-20 | Cash Flow | Reconciliation variance | 0 and meaningful | 0 but meaningless | FAIL | `cashflow-close-output` |
| T-21 | Period | Reopen + new activity P&L | K61,875 | K1,000 | FAIL | `reopen-output` |
| T-22 | Period | Re-close after reopen | Succeeds | `IDEMPOTENCY_CONFLICT`; period open | FAIL | `reopen-output` |
| T-23 | Period | Closed-period lock | Blocks postings | Blocks | PASS | Accounting tests |
| T-24 | Period | Close checklist via API | Blocks until complete | Blocks | PASS | Finance-controls test 4 |
| T-25 | AR | AR GL = customer balances (initial) | Equal | 66,075 = 66,075; 9,800 = 9,800 | PASS | DB query |
| T-26 | AR | Void invoice with NULL journal link | AR and customer both decrease | AR unchanged; customer -5,400 | FAIL | `void-test-output` |
| T-27 | AR | Void credit memo | AR and customer both increase | AR +100; customer unchanged | FAIL | `void-test2-output` |
| T-28 | AR | AR aging total vs AR GL | Equal | 66,075 = 66,075 | PASS | `reports-output` |
| T-29 | AR | AR aging with unapplied credits | Reconciles | Ignores credits | PARTIAL | Code review |
| T-30 | AR | Customer statement vs balance | Equal | Matches initial; breaks after CM void | PARTIAL | Code + test |
| T-31 | AP | Bill/AP normal flow | Balanced | Passes commercial tests; no data | PASS (tests) | Commercial suite |
| T-32 | AP | AP GL = vendor balance | Equal | 0 = 0; no bills | NOT VERIFIED | DB query |
| T-33 | AP | Vendor credit void | Supported | Not implemented | NOT IMPLEMENTED | Code search |
| T-34 | AP | Credit application reversal | Supported | Not implemented | NOT IMPLEMENTED | Code search |
| T-35 | AP | Supplier statement excludes voided | Yes | Includes voided | FAIL | Code review |
| T-36 | AP | AP aging with vendor credits | Reconciles | Ignores credits | PARTIAL | Code review |
| T-37 | Bank | Bank GL = register (company 1) | Equal | 83,150 vs -1,850 | FAIL | DB query |
| T-38 | Bank | Bank GL = register (company 2) | Equal | 42,000 vs 0 | FAIL | DB query |
| T-39 | Bank | Reconciliation with opening balance | Difference 0 | 83,150 / 85,000 | FAIL | `bankrec-output` |
| T-40 | Bank | Void bank txn linked to payment | Source also voided | Payment active; AR mismatch 100 | FAIL | `bankvoid-output` |
| T-41 | Bank | Void bank txn standalone | GL reversed | Works | PASS | Code review |
| T-42 | Bank | Void bank txn deposit | Payments return to undeposited | Works | PASS | Code review |
| T-43 | Inventory | Inventory GL = valuation | Equal | 16,114 vs 0 | FAIL | `reports-output` |
| T-44 | Inventory | Inventory movements exist | Yes | 0 | FAIL | DB query |
| T-45 | Inventory | avg_cost populated | Yes | All 0 | FAIL | DB query |
| T-46 | Inventory | Valuation includes printed products | Yes | Only raw/stationery | FAIL | Code review |
| T-47 | Inventory | Void bill restores avg/unit cost | Yes | Not restored | FAIL | Code review |
| T-48 | Inventory | Void invoice restores printed product | Yes | Not restored | FAIL | Code review |
| T-49 | COGS | COGS GL = subledger | Equal | 2,150 vs 0 | FAIL | `reports-output` |
| T-50 | COGS | Custom line with unitCost posts COGS | Yes | No COGS | FAIL | `invoice-test-output` |
| T-51 | COGS | COGS reconciliation after void | Reverses | Original movement still counted | FAIL | Code review |
| T-52 | COGS | BOM shortage handling | Block or adjust | Silently under-consumes | FAIL | Code review |
| T-53 | Invoice | Invoice math | Subtotal+tax=total; paid+balance=total | No errors | PASS | DB query |
| T-54 | Invoice | Payment allocation overrun | None | None | PASS | DB query |
| T-55 | Invoice | Discounts/additional charges | Supported | Not implemented | NOT IMPLEMENTED | Code review |
| T-56 | Tax | Company tax rate authoritative | Yes | Not used | FAIL | Code review |
| T-57 | Tax | Tax rate percent round-trip | 7.5% = K75 on K1,000 | 0.075% = K0.75 | FAIL | `invoice-test-output` |
| T-58 | Tax | No tax when unregistered | 0 | UI default 16% | FAIL | `InvoicesView` |
| T-59 | Tax | Tax-inclusive pricing | Supported | Not implemented | NOT IMPLEMENTED | Code review |
| T-60 | Currency | Malawi base currency | MWK | ZMW | FAIL | DB query |
| T-61 | Currency | Default new company | MWK | ZMW | FAIL | `db.ts:113` |
| T-62 | Period | Fiscal periods configured | Yes | 0 | NOT VERIFIED | DB query |
| T-63 | Fixed assets | Asset register/depreciation | Implemented | Not implemented | NOT IMPLEMENTED | Tables empty; no routes |
| T-64 | Wallet | Wallet deposit/usage | Implemented | Not implemented | NOT IMPLEMENTED | Code search |
| T-65 | Refunds | Customer refund | Implemented | Not implemented | NOT IMPLEMENTED | Code search |
| T-66 | Returns | Sales/purchase returns with inventory | Implemented | Not implemented | NOT IMPLEMENTED | Code search |
| T-67 | Security | RBAC / company isolation | Enforced | Enforced | PASS | Security tests |
| T-68 | Security | Posted journal immutability | Enforced | Enforced | PASS | DB tests |
| T-69 | Security | Maker-checker on void/reverse | Enforced | Not enforced | FAIL | Route review |
| T-70 | Security | Demo seed in production | Disabled | Enabled | FAIL | `server.ts:15` |
| T-71 | Database | Constraints/FKs/RLS | Enforced | Enforced | PASS | DB tests |
| T-72 | Database | Atomic rollback | Enforced | Enforced | PASS | DB tests |
| T-73 | Database | Null financial values | None | None | PASS | DB query |
| T-74 | Performance | Large-volume accounting | Acceptable | Not tested | NOT VERIFIED | No test |
| T-75 | Performance | Concurrent posting | No lost updates | 10/10 | PASS | Accounting tests |
| T-76 | Build | TypeScript typecheck | Pass | Fails in unrelated advanced-actions test | FAIL | `npm run lint` |

---

## Appendix B — Defect Classification Summary

| ID | Severity | Defect | Primary evidence |
|---|---|---|---|
| CRIT-01 | CRITICAL | Bank transaction void leaves source document active and GL reversed | `bankvoid-output` |
| CRIT-02 | CRITICAL | Void invoice with NULL journal link leaves GL posted | `void-test-output` |
| CRIT-03 | CRITICAL | Credit-memo void does not restore customer balance | `void-test2-output` |
| CRIT-04 | CRITICAL | Closed-period P&L is zero | `close-test-output` |
| CRIT-05 | CRITICAL | Closed-period Cash Flow is meaningless but “reconciled” | `cashflow-close-output` |
| CRIT-06 | CRITICAL | Reopen does not reverse closing entry; re-close fails | `reopen-output` |
| CRIT-07 | CRITICAL | Bank register/reconciliation omit opening balances | `bankrec-output` |
| CRIT-08 | CRITICAL | Inventory GL and subledger do not reconcile | `reports-output` |
| CRIT-09 | CRITICAL | COGS GL and subledger do not reconcile; custom-line COGS missing | `invoice-test-output` |
| CRIT-10 | HIGH | Inconsistent inventory cost basis; void does not restore cost/stock | Code review |
| CRIT-11 | HIGH | Tax configuration/contract defects; 16% default | `invoice-test-output`; UI code |
| CRIT-12 | HIGH | Demo seed runs in production with known credentials | `server.ts` |
| HIGH-01 | HIGH | Currency is ZMW, not MWK | DB query |
| HIGH-02 | HIGH | No AR/AP control reconciliation report | Code search |
| HIGH-03 | HIGH | Supplier statement includes voided bills/credits | Code review |
| HIGH-04 | HIGH | Customer deposits netted against AR, not liability | Code review |
| HIGH-05 | HIGH | No vendor credit void/application reversal | Code search |
| HIGH-06 | HIGH | No customer refund/sales return/purchase return | Code search |
| HIGH-07 | HIGH | No fixed-asset register/depreciation run | Tables/routes |
| HIGH-08 | HIGH | Approval policies default disabled; void/reverse bypass | Routes/migration |
| HIGH-09 | HIGH | Manual journals can hit control accounts | Code review |
| HIGH-10 | HIGH | AR/AP aging ignores unapplied credits | Code review |
| MED-01 | MEDIUM | Contra account cannot be created/changed via API | Route review |
| MED-02 | MEDIUM | No parent-account posting restriction | Code review |
| MED-03 | MEDIUM | Cash flow ignores `excludeAdjusting` | Code review |
| MED-04 | MEDIUM | Period close service bypasses checklist | Code review |
| MED-05 | MEDIUM | No tax registration flag; tax-inclusive unsupported | Code review |
| MED-06 | MEDIUM | Credit memo taxes all lines; no line taxable/customer exemption | Code review |
| MED-07 | MEDIUM | No credit application reversal; applied document deadlock | Code review |
| MED-08 | MEDIUM | No cash-on-hand account | COA review |
| MED-09 | MEDIUM | PGlite single-process / no large-volume validation | Architecture |
| MED-10 | MEDIUM | Aging/statements/GL load all rows | Code review |
| LOW-01 | LOW | 1590 stored balance negative vs normal credit | Display convention |
| LOW-02 | LOW | `parseDecimal4` ignores company rounding mode for >4dp | Decimal code |
| LOW-03 | LOW | `toMoneyNumber` JS number boundary | Decimal code |
| LOW-04 | LOW | Blank filter lines in report queries | Code hygiene |
| LOW-05 | LOW | Lint fails in unrelated advanced-actions test | `npm run lint` |

---

## Appendix C — Evidence and Reproduction Notes

All database tests were run against an isolated copy of `.data/pms-pg` in the OS temp directory. The live database was not modified. Controlled service tests used fresh copies of the same data.

Reproduction commands used:

```powershell
npm run test:accounting
npm run test:commercial
npm run test:controls
npm run test:workflows
npm run test:documents
npm run test:db
npm run test:security
npm run test:printing
npm run test:migration
npm run lint
```

Controlled audit scripts (temporary, outside the project source tree):

- `audit-db.mjs` / `audit-db2.mjs` — database integrity and reconciliation queries.
- `reports-test.ts` — TB/BS/P&L/inventory/COGS/aging/bank reports.
- `close-test.ts` — period close and P&L/TB/BS after close.
- `close-exclude-test.ts` — `excludeAdjusting` behavior.
- `cashflow-close-test.ts` — cash flow after close.
- `reopen-test.ts` — reopen, new activity, re-close.
- `void-test.ts` / `void-test2.ts` — invoice and credit-memo void behavior.
- `bankvoid-test.ts` — bank transaction void linked to a payment.
- `invoice-test.ts` — custom-line COGS and tax-rate contract.
- `bankrec-test.ts` — bank reconciliation opening balance.

Key raw results:

- Company 1 TB: total debit/credit K310,539.0000, difference K0.
- Company 1 BS: assets K280,139.0000, liabilities + equity K280,139.0000.
- Company 1 P&L: net income K60,875.0000.
- Company 1 AR: K66,075.0000 = customer balances K66,075.0000.
- Company 1 bank: GL K83,150.0000 vs register -K1,850.0000.
- Company 1 inventory: GL K16,114.0000 vs valuation K0.
- Company 1 COGS: GL K2,150.0000 vs subledger K0.
- FY2026 close: P&L K0; cash flow net income K0, financing K60,875, variance K0.
- FY2026 reopen + K1,000 revenue: P&L K1,000; re-close `IDEMPOTENCY_CONFLICT`.
- Invoice 1 void: AR K66,075 unchanged; customer balance K60,675; no reversal.
- Credit memo K100 void: AR K66,075; customer balance K65,975; `remaining_credit = 100`.
- Bank payment K100 void: AR K66,075; invoice/customer K5,300; payment active.
- Custom invoice K1,000, unitCost K100: total_cost K100; COGS unchanged K2,150; inventory unchanged K16,114.
- Tax test K1,000 at 0.075: tax K0.7500.

---

## Appendix D — Scope Limitations

1. The actual database is a sparse demonstration database, not a full production ledger. AP, payroll, fixed assets, wallet, refunds and returns could not be verified with production data.
2. No fiscal periods exist in the actual data, so closed-period behavior was tested on an isolated copy after creating a period.
3. The audit did not modify application source code. Test suites may rewrite their own report artifacts under `docs/accounting`; no source files were changed.
4. Performance at large transaction volumes was not tested.
5. Tax behavior was tested with controlled invoices; no real tax authority filing or validation was performed.
6. Offline synchronization is not implemented, so offline/online consistency could not be tested.
7. The audit’s verdict is based on the code and data available at the audit date. Later changes may alter the findings.

---

**End of report.**