# Phase 5 — Commercial & Financial API Reference

All endpoints require an authenticated session cookie or Bearer JWT, enforce PostgreSQL Row-Level Security (`app.current_company_id`), reject cross-company parameter spoofing (`rejectCrossCompanyParams`), and enforce role-based permissions (`requirePermission`). Mutating financial endpoints support `Idempotency-Key` headers.

## 1. Sales & Accounts Receivable (`/api/*`)

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/payment-terms` | `customers:read` | List company payment terms (`Net 15`, `Net 30`, etc.) |
| `GET` | `/api/customers` | `customers:read` | List customers with exact AR subledger balances |
| `POST` | `/api/customers` | `customers:write` | Create customer with terms, credit limit, and tax exemption |
| `PATCH` | `/api/customers/:id` | `customers:write` | Update customer details, credit limit, or active status |
| `GET` | `/api/customers/:id/statement` | `customers:read` | Generate period customer statement (`?periodStart=&periodEnd=&saveSnapshot=true`) |
| `GET` | `/api/reseller-permits` | `customers:read` | List tax-exemption reseller permits |
| `POST` | `/api/reseller-permits` | `customers:write` | Record reseller permit & mark customer tax-exempt |
| `GET` | `/api/invoices` | `invoices:read` | List invoices and sales receipts (`?customerId=&isSalesReceipt=`) |
| `GET` | `/api/invoices/:id` | `invoices:read` | Fetch single invoice or sales receipt with line detail |
| `POST` | `/api/invoices` | `invoices:write` | Post invoice or sales receipt (`isSalesReceipt: true`), deduct perpetual inventory, and post GL |
| `POST` | `/api/invoices/:id/void` | `invoices:write` | Void invoice/sales receipt, reverse GL journal, and restore inventory |
| `GET` | `/api/payments` | `invoices:read` | List customer payments and invoice allocations |
| `POST` | `/api/payments` | `invoices:write` | Record customer payment with multi-invoice allocation, overpayment credit, and FX gain/loss |
| `POST` | `/api/payments/:id/void` | `invoices:write` | Void payment, reverse GL journal, and restore invoice balances |
| `GET` | `/api/credit-memos` | `invoices:read` | List credit memos and remaining open credits |
| `POST` | `/api/credit-memos` | `invoices:write` | Issue credit memo and post GL revenue/VAT/AR reversal |
| `POST` | `/api/credit-memos/:id/apply` | `invoices:write` | Apply remaining credit memo balance to an open customer invoice |
| `POST` | `/api/credit-memos/:id/void` | `invoices:write` | Void unapplied credit memo and reverse GL |
| `GET` | `/api/estimates` | `estimates:read` | List estimates (`#824` redacts `totalCost`, `unitCost`, `estimatedProfit` unless `estimates:read_costs`) |
| `POST` | `/api/estimates` | `estimates:write` | Create quotation/estimate |
| `POST` | `/api/estimates/:id/convert` | `invoices:write` | Convert estimate to live posted invoice & mark estimate `invoiced` |
| `GET` | `/api/recurring-invoices` | `invoices:read` | List recurring invoice templates |
| `POST` | `/api/recurring-invoices` | `invoices:write` | Create recurring invoice schedule |
| `POST` | `/api/recurring-invoices/run-due` | `invoices:write` | Idempotently generate all due recurring invoices up to `asOfDate` |
| `GET` | `/api/communications` | `invoices:read` | List reminder rules, sent reminders, email templates, and email audit log |
| `POST` | `/api/invoices/:id/remind` | `invoices:write` | Dispatch overdue invoice reminder and record email log |
| `GET` | `/api/reports/ar-aging` | `reports:read` | Live 5-bucket AR Aging (`Current`, `1-30`, `31-60`, `61-90`, `>90`) |

## 2. Purchasing & Accounts Payable (`/api/*`)

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/vendors` | `vendors:read` | List vendors/suppliers with exact AP balances |
| `POST` | `/api/vendors` | `vendors:write` | Create vendor (`1099` flag, TPIN/EIN, default expense account, terms) |
| `PATCH` | `/api/vendors/:id` | `vendors:write` | Update vendor |
| `GET` | `/api/vendors/:id/statement` | `vendors:read` | Generate period supplier statement |
| `GET` | `/api/purchase-orders` | `bills:read` | List purchase orders and remaining unbilled quantities |
| `POST` | `/api/purchase-orders` | `bills:write` | Create open purchase order |
| `POST` | `/api/purchase-orders/:id/receive` | `bills:write` | Partial or complete PO receipt -> posts Bill, updates inventory & weighted average cost |
| `GET` | `/api/bills` | `bills:read` | List vendor bills |
| `POST` | `/api/bills` | `bills:write` | Post vendor bill (expense, inventory w/ conversion factor, use tax, duplicate `billNumber` guard `409`) |
| `POST` | `/api/bills/:id/void` | `bills:write` | Void unpaid bill, reverse GL journal, and reverse inventory receipt |
| `GET` | `/api/bill-payments` | `bills:read` | List AP bill payments |
| `POST` | `/api/bill-payments` | `bills:write` | Record multi-bill payment with auto check#, bank register entry, and FX gain/loss |
| `POST` | `/api/bill-payments/:id/void` | `bills:write` | Void bill payment, reverse GL, and restore bill balances |
| `GET` | `/api/vendor-credits` | `bills:read` | List vendor credits |
| `POST` | `/api/vendor-credits` | `bills:write` | Issue vendor credit & post AP debit journal |
| `POST` | `/api/vendor-credits/:id/apply` | `bills:write` | Apply vendor credit to open vendor bill |
| `GET` | `/api/reports/ap-aging` | `reports:read` | Live 5-bucket AP Aging (`Current`, `1-30`, `31-60`, `61-90`, `>90`) |

## 3. Cash, Banking & Reconciliation (`/api/banking/*`)

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/banking/accounts` | `banking:read` | List linked Bank/CreditCard GL accounts with GL balance & pending feed count |
| `POST` | `/api/banking/accounts` | `banking:write` | Link GL Bank/CreditCard account to banking metadata & starting check number |
| `GET` | `/api/banking/transactions` | `banking:read` | List bank register transactions (`?accountId=&status=&cleared=`) |
| `POST` | `/api/banking/expenses` | `banking:write` | Record Check (optional `printLater` queue), Expense, or Credit Card Charge |
| `POST` | `/api/banking/checks/print` | `banking:write` | Mark queued checks as printed |
| `POST` | `/api/banking/deposits` | `banking:write` | Record split deposit (`deposit_other_lines`) |
| `POST` | `/api/banking/transfers` | `banking:write` | Record paired inter-account transfer (`transfer_pair_txn_id`) with single GL journal |
| `POST` | `/api/banking/transactions/:id/void` | `banking:write` | Void unreconciled bank transaction (blocked `409` if reconciled) |
| `PATCH` | `/api/banking/transactions/:id/cleared` | `banking:write` | Toggle tentative cleared flag prior to reconciliation |
| `GET` | `/api/banking/rules` | `banking:read` | List automated bank-feed categorization rules |
| `POST` | `/api/banking/rules` | `banking:write` | Create bank-feed matching rule (`payee`, `memo`, `amount`) |
| `DELETE` | `/api/banking/rules/:id` | `banking:write` | Delete bank rule |
| `POST` | `/api/banking/imports` | `banking:write` | Import CSV or OFX `<STMTTRN>` payload with `external_fitid` deduplication & rule matching |
| `POST` | `/api/banking/transactions/:id/categorize` | `banking:write` | Categorize `pending_import` feed line into GL (`posted`) |
| `POST` | `/api/banking/transactions/:id/dismiss-duplicate` | `banking:write` | Dismiss duplicate pending feed line |
| `GET` | `/api/banking/reconciliations` | `banking:read` | List completed & reversed reconciliations |
| `POST` | `/api/banking/reconciliations/preview` | `banking:reconcile` | Preview cleared deposits/payments & exact `BigInt` difference |
| `POST` | `/api/banking/reconciliations/complete` | `banking:reconcile` | Enforce `difference === 0.0000`, finalize reconciliation, lock `journal_lines.is_reconciled = TRUE` |
| `POST` | `/api/banking/reconciliations/:id/reverse` | `banking:reconcile` | Audited reversal of reconciliation unlocking GL & bank transactions |

## 4. Budgets, Tax, FX, Saved Reports & Analytics

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/api/budgets` | `budgets:read` | Fetch 12-month budget matrix for `fiscalYear` |
| `PUT` | `/api/budgets` | `budgets:write` | Upsert monthly budget entries |
| `GET` | `/api/reports/budget-vs-actual` | `reports:read` | Compare budgeted vs actual GL activity by account & favorability |
| `GET` | `/api/tax/mappings` | `tax:read` | List GL-to-tax-schedule mappings |
| `PUT` | `/api/tax/mappings` | `tax:write` | Upsert GL account tax line mapping |
| `GET` | `/api/tax/summary` | `tax:read` | Aggregate gross/taxable/exempt sales, output VAT, credit memo reversals & purchase use tax |
| `GET` | `/api/fx/rates` | `accounts:read` | List FX exchange rates |
| `PUT` | `/api/fx/rates` | `accounts:write` | Upsert FX exchange rate pair & effective date |
| `GET` | `/api/saved-reports` | `reports:read` | List saved report configurations |
| `POST` | `/api/saved-reports` | `reports:read` | Create saved report preset |
| `POST` | `/api/saved-reports/:id/run` | `reports:read` | Execute saved report preset against live PostgreSQL data |
| `DELETE` | `/api/saved-reports/:id` | `reports:read` | Delete saved report preset |
| `GET` | `/api/analytics/overview` | `reports:read` | Executive dashboard KPIs, monthly revenue/expense series, AR/AP & stock alerts |
