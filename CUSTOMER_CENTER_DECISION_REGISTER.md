# CUSTOMER CENTER — FINANCE DECISION REGISTER

**Project:** Prime ERP / Printing System  
**Module:** Customer Center — Customer Master Data, AR and Collections  
**Branch:** `fix/printing-contracts-99`  
**Status:** Decisions documented for implementation (pending formal finance sign-off)  
**Approach:** Standard ERP accounting assumptions applied where policy is not yet explicitly configured; all decisions flagged for finance review.

---

## D-1 — Opening Balance Treatment

**Decision:** Opening AR balances are recognized through traceable opening invoices linked to an opening journal entry. No separate `customers.balance` seed is permitted.

**Rationale:**
- The `customers.balance` column is a cached derived value (recalculated by `recalculateCustomerBalance`).
- Opening invoices provide an auditable source document with invoice number, date, and journal reference.
- Posting through `postJournalEntry` to AR control account 1100 maintains double-entry integrity.
- Prevents double-counting (no separate opening journal + opening invoice).

**Implementation:**
- Opening balance amount is converted to an opening invoice (`INV-OPEN-{customerCode}-{YYYY}`) with `status = 'sent'`, `invoice_date` = opening date, `balance_due` = opening amount.
- The opening invoice posts a journal: Dr AR 1100, Cr Opening Balance Equity 3900.
- Migration script prevents duplicate opening invoices (idempotency key `opening-balance-{customerId}`).
- Customer `balance` is recalculated after opening invoice creation.

**Finance approval required:** YES — confirm offset account (3900 Owner Capital & Equity vs dedicated Opening Balance Equity account).

---

## D-2 — Opening AR Control Account Offset

**Decision:** Opening AR is offset to account `3900` (Owner Capital & Equity), consistent with the existing `postOpeningBalances` pattern in `db.ts` seed.

**Rationale:** The existing chart of accounts already uses `3900` for opening balance offsets in the seed data. Using the same account maintains consistency.

**Finance approval required:** YES — confirm whether a dedicated opening balance equity account should be created instead.

---

## D-3 — Unapplied Receipt Treatment

**Decision:** Unapplied receipts reduce the customer's outstanding AR balance for credit exposure and aging purposes. Unapplied amounts remain available for future allocation.

**Rationale:**
- The existing `recalculateCustomerBalance` already subtracts unapplied payments from the balance.
- An overpayment is a legitimate credit against the customer's account.
- Unapplied receipts are tracked separately in `payment_allocations` (`from_remainder = FALSE` for allocated, remainder tracked as unapplied).

**Implementation:**
- `recalculateCustomerBalance` continues to treat unapplied receipts as balance-reducing.
- Aging calculations treat unapplied receipts as a credit against the oldest open invoices (FIFO) per approved policy.
- Finance must configure whether unapplied receipts reduce credit exposure.

**Finance approval required:** YES — confirm unapplied receipts reduce credit exposure.

---

## D-4 — Wallet Liability vs Ordinary Receipts

**Decision:** Wallet balances and ordinary customer receipts are maintained as separate liability/AR categories. Wallet funds do NOT reduce credit exposure until applied to an invoice.

**Rationale:**
- `customer_wallets.balance` is a liability (account 2310 Customer Wallet Funds), not AR.
- `applyWalletToInvoice` posts Dr Wallet Liability, Cr AR 1100 — only at application time does AR get relieved.
- Credit exposure is based on AR (open invoices − credits − unapplied ordinary receipts), not wallet balances.

**Implementation:**
- Credit check service queries `customers.balance` (AR-based), not wallet balance.
- Wallet application reduces AR and creates an allocation-equivalent journal entry.
- Wallet refunds reverse through `reverseJournalEntry`.

**Finance approval required:** YES — confirm wallet balances do not reduce credit exposure until applied.

---

## D-5 — Payment Allocation Accounting

**Decision:** Payment allocation follows: Dr Bank 1010 (or undeposited funds), Cr AR 1100 per invoice. FX differences post to FX Gain 4900 / FX Loss 6900.

**Rationale:**
- Existing `recordCustomerPayment` already implements this pattern.
- Base-currency amount is used for AR relief to ensure invoice balance reaches exactly zero when paid in full at the original invoice rate.
- Foreign currency allocations use the invoice's original exchange rate for AR relief.

**Implementation:**
- No change to existing journal posting logic.
- Allocation reversal reverses the payment journal and restores invoice balances.

**Finance approval required:** NO — existing implementation matches standard practice.

---

## D-6 — Credit Memo Treatment

**Decision:** Credit memos post Dr Sales Returns & Allowances (contra-revenue), Cr AR 1100. Credit memos reduce customer balance and credit exposure.

**Rationale:**
- Existing `createCreditMemo` already posts to AR 1100.
- Credit memo reduces `remaining_credit` and customer `balance` via `recalculateCustomerBalance`.

**Implementation:**
- No change to existing journal posting logic.
- Credit memo application creates `credit_applications` records and reduces invoice `balance_due`.

**Finance approval required:** NO — existing implementation matches standard practice.

---

## D-7 — Bad Debt Write-Off

**Decision:** Deferred to a future phase. No write-off functionality exists in the current codebase.

**Implementation:** Not implemented in this phase.

**Finance approval required:** YES — when write-off functionality is required, approve bad debt expense account and approval threshold.

---

## D-8 — FX Revaluation Method

**Decision:** Period-end revaluation uses the closing exchange rate from `exchange_rates` table. Unrealized FX gain/loss posts to account 4900 (FX Gain) / 6900 (FX Loss). Realized FX is recognized at settlement (payment allocation time).

**Rationale:**
- `resolveExchangeRate6` already resolves rates from `exchange_rates`.
- Accounts 4900 (FX Gain) and 6900 (FX Loss) already exist in the chart of accounts.
- Realized FX is calculated at payment allocation time as `cashReceivedBase4 - totalArCredit4`.

**Implementation:**
- Revaluation run identifies open foreign-currency receivables, applies closing rate, posts unrealized FX journal.
- Revaluation runs tracked in a new `fx_revaluation_runs` table with idempotency prevention.

**Finance approval required:** YES — confirm FX gain/loss accounts and period-end rate source.

---

## D-9 — Credit Limit Calculation

**Decision:** Credit exposure = open invoice balance − open credit memos − unapplied receipts. Wallet balances do NOT reduce exposure. Credit limit is a hard cap unless an approved override exists.

**Rationale:**
- Matches existing `recalculateCustomerBalance` output.
- Prevents over-extension of credit based on wallet funds that may not be applied to the specific invoice.

**Implementation:**
- Credit check service computes exposure from authoritative subledger.
- Invoice posting calls credit check service before creating the invoice.
- Overrides require `customers:change_credit_limit` permission + reason + approval.

**Finance approval required:** YES — confirm credit exposure formula.

---

## D-10 — Tax Exemption

**Decision:** Tax exemption requires `is_tax_exempt = TRUE` AND a valid reseller permit (jurisdiction, permit number, expiry date). Exemption without a valid certificate is not honored.

**Rationale:**
- Existing `reseller_permits` table supports jurisdiction/permit_number/expires_at.
- `is_tax_exempt` boolean alone is insufficient for audit compliance.

**Implementation:**
- Tax-exempt status is validated against active, non-expired reseller permits at invoice posting time.
- Exemption certificate expiry alerts are included in the customer profile.

**Finance approval required:** YES — confirm tax exemption validation rules.

---

## Decision Register Summary

| ID | Decision | Status | Finance Approval Required |
|----|----------|--------|---------------------------|
| D-1 | Opening balances as opening invoices | Documented | YES |
| D-2 | Opening AR offset to account 3900 | Documented | YES |
| D-3 | Unapplied receipts reduce balance/exposure | Documented | YES |
| D-4 | Wallet liability separate from AR | Documented | YES |
| D-5 | Payment allocation: Dr Bank, Cr AR | Documented | NO |
| D-6 | Credit memo: Dr contra-revenue, Cr AR | Documented | NO |
| D-7 | Bad debt write-off deferred | Documented | YES (future) |
| D-8 | FX revaluation at period-end closing rate | Documented | YES |
| D-9 | Credit exposure formula defined | Documented | YES |
| D-10 | Tax exemption requires valid permit | Documented | YES |

**Blocked items pending finance approval:** D-1, D-2, D-3, D-4, D-8, D-9, D-10  
**Unblocked items:** D-5, D-6 (existing implementation matches)

Implementation proceeds on unblocked items; blocked items are implemented with configurable parameters pending finance confirmation.