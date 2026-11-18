# Phase 5 — Financial Posting Matrix (Double-Entry GL Integration)

Every commercial and banking event posts **atomically** through `postJournalEntry()` or `reverseJournalEntry()` in `src/server/services/accountingEngine.ts` within a single PostgreSQL transaction. No separate or shadow ledger exists. All amounts are calculated using exact 4-decimal `BigInt` fixed-point arithmetic (`NUMERIC(19,4)`) and Banker's rounding (`HALF_EVEN`).

## Transaction Posting Matrix

| Commercial Module & Event | Source Type | Debit Account(s) | Credit Account(s) | Subledger & Stock Impact |
|---|---|---|---|---|
| **Invoice** (Standard Credit Sale) | `invoice` | `1100` Accounts Receivable (Base Total)<br>`5000` COGS (if stocked/BOM cost > 0) | `4000` / Item Income (Subtotal)<br>`2200` Sales Tax / VAT Payable (Tax)<br>`1200` Inventory Asset (Cost) | `customers.balance += total`; `on_hand -= qty` (stationery & BOM raw materials) |
| **Sales Receipt** (`is_sales_receipt = true`) | `sales_receipt` | `1010` Bank / Cash Deposit Account (Base Total)<br>`5000` COGS (Cost) | `4000` / Item Income (Subtotal)<br>`2200` Sales Tax / VAT Payable (Tax)<br>`1200` Inventory Asset (Cost) | Inserts `bank_transactions` (`+amount`); `on_hand -= qty` |
| **Void Invoice / Sales Receipt** | `reversal` | Exact inverse of original JE (`4000`, `2200`, `1200`) | Exact inverse of original JE (`1100` or `1010`, `5000`) | Blocked `409` if payments applied; restores `inventory_movements` & `on_hand`; voids receipt bank row |
| **Customer Payment** (Same Currency) | `payment` | `1010` / Target Bank Account | `1100` Accounts Receivable | Allocates to `payment_allocations`; updates `invoices.amount_paid`, `balance_due`, `status`; handles unapplied remainder |
| **Customer Payment** (Foreign Currency FX) | `payment` | `1010` Bank (at Payment FX Rate)<br>`6900` FX Loss *(if settled < booked)* | `1100` AR (at Original Invoice Rate)<br>`4900` FX Gain *(if settled > booked)* | Relieves AR completely so `balance_due = 0.00` upon full foreign currency settlement |
| **Credit Memo** | `credit_memo` | `4000` / Item Income (Subtotal)<br>`2200` Sales Tax Payable (Tax) | `1100` Accounts Receivable (Total) | `credit_memos.remaining_credit = total`; reduces customer balance; applied via `credit_applications` |
| **Vendor Bill** (Expense & Stocked Inventory) | `bill` | Expense Account (Expense lines)<br>`1200` Inventory Asset (Stocked items)<br>Expense Account *(Use Tax Debit)* | `2000` Accounts Payable (Base Total)<br>`2200` Use Tax Payable *(Use Tax Credit)* | Raw material `on_hand += qty * conversion_factor`; recomputes weighted-average `avg_cost` |
| **Void Vendor Bill** | `reversal` | `2000` Accounts Payable, `2200` Use Tax | Expense / `1200` Inventory Asset | Blocked `409` if payments applied; reverses inventory receipt (`inventory_movements`) |
| **Bill Payment** (Local & FX) | `bill_payment` | `2000` Accounts Payable (at Bill Rate)<br>`6900` FX Loss *(if paid > booked)* | `1010` / Bank Account (at Payment Rate)<br>`4900` FX Gain *(if paid < booked)* | Inserts `bank_transactions` (`-amount`) & `bank_check_details` (auto check#); updates `bills.balance_due` |
| **Vendor Credit** | `vendor_credit` | `2000` Accounts Payable | Expense / Asset Account | `vendor_credits.remaining_credit = total`; applied to open bills via `vendor_credit_applications` |
| **Check / Expense / CC Charge** | `check` / `expense` / `credit_card_charge` | Expense / Asset split line accounts | `1010` Bank or `2100` Credit Card | Inserts `bank_transactions` (`-amount`) & optional `bank_check_details` (`print_later` queue) |
| **Bank Deposit** (`deposit_other_lines`) | `deposit` | `1010` / Target Bank Account | Source split line accounts (Income / Other Asset / Equity) | Inserts `bank_transactions` (`+amount`) & `deposit_other_lines` |
| **Inter-Account Transfer** | `transfer` | Destination Bank Account | Source Bank Account | Single GL journal; paired `bank_transactions` (`outId` <-> `inId` via `transfer_pair_txn_id`) |
| **Bank Feed Categorization** | `deposit` / `expense` | Bank (`+`) or Offset Expense (`-`) | Offset Income (`+`) or Bank (`-`) | Transitions `pending_import` -> `posted` with `journal_txn_id` |
| **Void Bank Transaction** | `reversal` | Exact inverse of original bank JE | Exact inverse of original bank JE | Blocked `409 RECONCILED_ENTRY_LOCKED` if `reconciliation_id IS NOT NULL` or `journal_lines.is_reconciled = TRUE` |
