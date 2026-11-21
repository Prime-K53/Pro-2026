# CUSTOMER CENTER MODULE — END-TO-END ERP AUDIT REPORT

**Audit type:** Audit ONLY (no code changes, no remediation implemented)  
**Subject:** Customer Center module (Receivables / Customer Master Data)  
**Repository:** Printing System / Prime ERP  
**Branch:** `fix/printing-contracts-99`  
**Status:** Findings documented; remediation NOT applied  

---

## 1. Executive Summary

The Customer Center module is the customer-facing receivables hub of this ERP. End to end it covers: customer master data creation/maintenance, reseller permits, customer statements with aging, customer payments and voids, credit memos, a customer wallet with double-entry journal posting, idempotency keys, maker-checker approval on payments/invoices/credit memos, role-based access control (`customers:read` / `customers:write`), and an audit log.

**Overall rating: PARTIAL / NEEDS IMPROVEMENT.** The module implements the transactional "happy path" (create customer → invoice → pay → statement) with solid controls on payments, but it falls short of correct ERP Customer Center principles in master-data governance, credit management, real aging, payment allocation, multi-currency, and collections. Several gaps represent material receivables-integrity risks.

---

## 2. Scope — What Constitutes the "Customer Center"

Files/components in scope:

| Layer | File | Purpose |
|-------|------|---------|
| UI — main view | `src/components/views/CustomersView.tsx` | Customer list, search, filters, selected-customer detail, statement snapshot, outstanding totals |
| UI — create | `src/components/modals/NewCustomerModal.tsx` | Customer onboarding form (name, contact, address, terms, credit limit, tax-exempt, currency, type, opening balance) |
| UI — statement | `src/components/modals/CustomerStatementModal.tsx` | Printable customer billing statement + aging buckets + remittance slip |
| Frontend API | `src/services/commercialApi.ts` | `ApiCustomer` type; `listCustomers`, `createCustomer`, `updateCustomer`, `getCustomerStatement` |
| Server routes | `src/server/routes/salesRoutes.ts` | `GET/POST/PATCH /customers`, `GET /customers/:id/statement`, reseller permits, customer payments/voids, credit memos |
| Wallet routes | `src/server/routes/walletRoutes.ts` | `/wallets/:id/allocations` (allocate wallet funds, apply wallet to invoice) |
| Server services | `src/server/services/customerWalletService.ts` | Wallet transactions, invoice payment, refunds, idempotency, journal posting, audit log |
| Helpers | `src/server/services/commercialHelpers.ts` | `recalculateCustomerBalance`, `resolveExchangeRate6`, AR control account (1100) |
| Engine | `src/server/services/accountingEngine.ts` | `postJournalEntry` (double-entry) |
| Types | `src/types/accounting.ts` | `Customer` interface |
| Permissions | `src/server/permissions.ts` | `customers:read`, `customers:write` (+ role grants) |
| Context | `src/context/AccountingContext.tsx` | Local `addCustomer` / `getCustomerById` + frontend customer state |

There is **no single dedicated `CustomerCenter` module folder**; customer capability is spread across the view, two modals, the commercial API, sales/wallet routes, and wallet/commercial services. This dispersion is itself a discoverability/maintainability observation.

---

## 3. Evaluation Framework — Correct ERP Principles for a Customer Center

A correct Customer Center (Accounts Receivable / Customer Master Data) must satisfy these principles:

| # | Principle | What "correct" looks like |
|---|-----------|---------------------------|
| P1 | **Single Source of Customer Truth** | One unique customer code/ID as natural key; centralized master; duplicate prevention; no shadow customer records. |
| P2 | **Controlled Customer Lifecycle** | Create/change/deactivate (soft-delete, no hard delete) under approval + audit trail; reactivation path; status = Active / Inactive / Blocked. |
| P3 | **Receivables Subledger Integrity** | Customer balance deterministically = open invoices − credits − unapplied payments; reconciles to GL AR control account (1100). |
| P4 | **Open-Item Payment Application** | Receipts applied to specific invoices (open items); unapplied cash tracked; prevents double-collection and misstated balances. |
| P5 | **Credit Management & Controls** | Credit limit + credit hold; enforcement at order/invoice; overdue flagging; blocks new transactions when over limit/hold. |
| P6 | **Aging & Collections** | Real aging buckets computed from invoice due dates (Current / 1–30 / 31–60 / 61–90 / 90+); dunning/collections; customer statements. |
| P7 | **Multi-Currency & Revaluation** | Customer currency; FX rates; period-end revaluation; unrealized FX gain/loss. |
| P8 | **Segregation of Duties & Approval** | Role-based permissions; maker-checker approval on sensitive master-data and transactions. |
| P9 | **Immutable Posting & Audit Trail** | Void/reverse rather than delete; every posting references a journal txn; full audit log; idempotency on retries. |
| P10 | **GL Integration** | Customer postings hit AR control account, revenue, tax liability, bank; trial-balance impact; subledger-to-GL reconciliation. |
| P11 | **Customer Communication** | Statements, email delivery, remittance advice, payment receipts. |
| P12 | **Tax & Compliance** | Tax ID / registration number; exemption certificates; withholding rules per customer. |
| P13 | **Reporting & Analytics** | AR by customer, aging report, customer ledger, top customers, sales by customer, customer profitability. |
| P14 | **Interoperability** | Links to sales/orders, inventory, printing jobs, bank, GL, tax. |

Rating scale used: **Compliant / Partial / Gap**.

---

## 4. End-to-End Process Walkthrough (as implemented)

```
Customer onboarding (NewCustomerModal → POST /customers → createCustomer)
      │
      ▼
Customer master stored (customers table); balance seeded from openingBalance
      │
      ▼
Sales invoice created for customer (POST /invoices → createInvoiceOrSalesReceipt;
      maker-checker gate; posts Dr AR 1100 / Cr Revenue)
      │
      ▼
Customer payment received (POST /payments → recordCustomerPayment;
      maker-checker gate; idempotency; posts Dr Wallet Liability / Cr AR)
      │
      ▼
Wallet transaction + balance recalculation (recalculateCustomerBalance)
      │
      ▼
Customer statement (GET /customers/:id/statement → generateCustomerStatement;
      printable; aging buckets)
      │
      ▼
Credit memo / void / refund as needed
```

Strengths observed in this flow:
- Maker-checker approval gate exists for invoices, customer payments, and credit memos (`evaluateApprovalGate` / `consumeApprovalRequest`).
- Idempotency keys on payment/wallet operations (`request_keys` table, `claimWalletIdempotency` / `completeWalletIdempotency`).
- Double-entry journal posting via `postJournalEntry`; customer payments hit AR control account (`ar1100`) and a customer-wallet liability account.
- `recalculateCustomerBalance` recomputes `customers.balance` from open invoices − credits − unapplied payments (subledger integrity attempt).
- `payment_allocations` table exists (referenced in `recalculateCustomerBalance`), so open-item allocation is modeled at the DB layer.
- Role-based permissions (`customers:read` / `customers:write`) enforced on routes.
- `writeAuditLog` captures `CUSTOMER_WALLET_INVOICE_PAID` and similar actions with recordId and newValues.
- Payments are voided (not hard-deleted) — `voidCustomerPayment`.
- Reseller permits (jurisdiction, expiry, certificate number) supported.
- Customer statement is printable with opening/closing balance and running balance per line.
- Multi-currency customer records supported (`currencyCode`, `resolveExchangeRate6`).
---

## 5. Principle-by-Principle Rating

| # | Principle | Rating | Evidence / Rationale |
|---|-----------|--------|----------------------|
| P1 | Single Source of Customer Truth | **Partial** | One `customers` table, but no unique customer code/natural key (auto-increment numeric `id` only). No duplicate-detection or customer-merge capability. |
| P2 | Controlled Customer Lifecycle | **Partial** | Create/read/update exist; `isActive` soft-delete flag exists. **No approval gate on customer creation** (`POST /customers` has `requirePermission` only, no `evaluateApprovalGate`), unlike invoices/payments/credit memos. No explicit Blocked status, no reactivation workflow. |
| P3 | Receivables Subledger Integrity | **Partial** | `recalculateCustomerBalance` derives balance from invoices/credits/unapplied payments and writes `customers.balance`. AR control account (1100) is used. Opening balance entered at onboarding (`openingBalance`) is not clearly posted to the GL as an opening AR entry — risk of subledger-to-GL opening mismatch. |
| P4 | Open-Item Payment Application | **Gap** | `payment_allocations` table and `applyWalletToInvoice`/`allocateWalletFunds` exist at service/route layer, but **there is no payment-allocation UI/workbench in the Customer Center** (CustomersView references no allocation/apply action). Payments can be recorded without being applied to specific invoices. |
| P5 | Credit Management & Controls | **Gap** | `creditLimit` and `taxExempt` are stored and displayed, but **no credit-limit enforcement** at invoicing (no credit check, no block when over limit), no **credit hold** status, no overdue auto-flagging, no collections trigger. Credit limit is display-only. |
| P6 | Aging & Collections | **Gap** | Aging buckets in `CustomerStatementModal` are **hardcoded/fabricated** (`totalBalance * 0.7`, `* 0.3`, 31–60 = 0, 60+ = 0) rather than computed from invoice due dates. No dunning, no collections workflow. Statement date filtering exists in the API (`periodStart`/`periodEnd`) but is **not exposed in the UI** (called with only `{ saveSnapshot: true }`). |
| P7 | Multi-Currency & Revaluation | **Partial** | Customer currency (`currencyCode`) and FX resolution (`resolveExchangeRate6`) exist. **No period-end customer-currency revaluation** and no unrealized FX gain/loss posting. |
| P8 | Segregation of Duties & Approval | **Partial** | Role-based permissions exist and maker-checker applies to payments/invoices/credit memos. **Gap:** customer master creation/edits are not under maker-checker, so a single user with `customers:write` can create a customer (high credit limit) and transact without independent approval. |
| P9 | Immutable Posting & Audit Trail | **Compliant** | Void-not-delete for payments; journal transaction references on wallet records; idempotency keys; `writeAuditLog` with action/table/recordId/newValues; tamper-evident hash pattern used elsewhere in the context. |
| P10 | GL Integration | **Partial** | Customer postings hit AR (1100), wallet liability, revenue; double-entry via `postJournalEntry`. **Gap:** no explicit subledger-to-GL reconciliation report for AR; opening customer balances may not be posted to the GL. |
| P11 | Customer Communication | **Partial** | Printable customer statement with remittance slip; print button; copy invoice #; Open Invoices Center link. **Gap:** no email delivery of statements, no payment receipt email to customer, no statement archive/history (snapshot saved but not retrievable as a series). |
| P12 | Tax & Compliance | **Gap** | `taxExempt` boolean only. **No tax ID / VAT / GST / registration number field**, no exemption certificate tracking, no withholding rules per customer. |
| P13 | Reporting & Analytics | **Partial** | Customer list with total outstanding; statement view. **Gap:** no aging report by customer, no AR-by-customer ledger, no top-customers / sales-by-customer report, no customer profitability, no collections dashboard. |
| P14 | Interoperability | **Partial** | Customers link to invoices, payments, wallet, printing contracts (schoolCustomerId), exam papers, quick print jobs. **Gap:** no customer price level / sales territory / salesperson assignment. |

**Aggregate: 1 Compliant, 8 Partial, 5 Gap out of 14 principles.**


---

## 6. Gap Register

| ID | Gap | Principle | Severity | Description |
|----|-----|-----------|----------|-------------|
| G-01 | No maker-checker approval on customer master creation | P2, P8 | High | `POST /customers` lacks `evaluateApprovalGate`. A user can create a customer (with credit limit) and transact without independent approval. |
| G-02 | Aging buckets are hardcoded, not date-computed | P6 | High | Statement aging shows fixed percentages instead of real buckets from invoice due dates — misstates collections risk. |
| G-03 | No payment open-item allocation UI | P4 | High | `payment_allocations` exists at the DB/service layer but the Customer Center has no allocation workbench; payments may remain unapplied and balances misstated. |
| G-04 | Credit limit not enforced | P5 | High | `creditLimit` stored/displayed but no credit check or block at invoicing; no credit-hold status. |
| G-05 | No unique customer code / duplicate prevention | P1 | Medium | Numeric auto-increment ID only; no customer code (e.g., CUST-0001), duplicate detection, or merge. |
| G-06 | Opening balance not posted to GL | P3, P10 | Medium | `openingBalance` captured at onboarding but no clear opening AR journal entry → subledger-to-GL opening mismatch risk. |
| G-07 | No period-end FX revaluation | P7 | Medium | Foreign-currency customer receivables not restated; no unrealized FX gain/loss. |
| G-08 | Statement date filtering not exposed in UI | P6 | Medium | API supports `periodStart`/`periodEnd` but CustomersView calls with only `{ saveSnapshot: true }`. |
| G-09 | No statement archive / email delivery | P11 | Medium | Snapshot saved but no statement history/retrieval or emailing to customers. |
| G-10 | No tax ID / exemption certificate fields | P12 | Medium | `taxExempt` boolean only; no tax registration/VAT/GST number or certificate tracking. |
| G-11 | No collections / dunning workflow | P6 | Medium | No overdue auto-flagging, dunning letters, or collections escalation. |
| G-12 | Limited AR reporting | P13 | Medium | No aging report, AR-by-customer ledger, top-customers, or collections dashboard. |
| G-13 | No billing/shipping address separation | P1 | Low | Single address field; no distinct ship-to or multiple addresses. |
---

## 7. Strengths (what is done well)

1. **Controls on transactions** — maker-checker approval on invoices, customer payments, credit memos; role-based `customers:read`/`customers:write`.
2. **Idempotency** — `request_keys` with payload hash and replay protection on wallet/payment operations.
3. **Double-entry posting** — customer payments post to AR control account (1100) and a customer-wallet liability account via `postJournalEntry`.
4. **Immutability** — payments voided rather than deleted; journal references on wallet transactions; audit log with `writeAuditLog`.
5. **Subledger balance recomputation** — `recalculateCustomerBalance` derives `customers.balance` from open invoices − credits − unapplied payments.
6. **Customer statement** — printable statement with opening/closing balance, running balance per line, remittance slip.
7. **Multi-currency foundation** — customer currency + FX rate resolution exist.
8. **Reseller permits** — jurisdiction, certificate number, expiry supported.

---

## 8. Audit Conclusion

The Customer Center module delivers a usable core receivables workflow (onboard → invoice → pay → statement) with strong transactional controls (approval, idempotency, double-entry, immutability). However, it does **not** yet meet correct ERP Customer Center principles in master-data governance (no customer code, no duplicate control, no lifecycle approval), credit management (limit not enforced), receivables integrity (no payment allocation UI, hardcoded aging), multi-currency (no revaluation), tax/compliance (no tax ID), or collections/reporting.

**The highest-priority audit findings are G-01 (unapproved customer master creation), G-02 (fabricated aging), G-03 (no open-item allocation UI), and G-04 (credit limit not enforced).** These directly affect receivables integrity and financial statement reliability.

This report is **audit only**. No source files were modified and no remediation plan is included here.

---

## 9. Methodology & Limitations

- Analysis based on static review of the repository at branch `fix/printing-contracts-99`; no runtime execution or database inspection was performed.
- Ratings reflect implemented code, not intended design.
- Frontend type (`ApiCustomer`) and backend `customers` table schema were inferred from route/service usage; the physical DDL was not inspected.
- Optional capabilities (customer self-service portal, CRM integration) are noted as out of scope and not rated as gaps.

| G-14 | No customer classification beyond simple type | P1 | Low | `customerType` (school/corporate/individual) only; no territory, salesperson, price level, or customer group. |
