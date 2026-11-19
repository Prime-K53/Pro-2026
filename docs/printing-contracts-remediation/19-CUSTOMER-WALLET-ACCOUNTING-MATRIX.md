# 19 — Customer Wallet Accounting Matrix

**Date:** 2026-11-19
**Phase:** A2 — Financial Architecture (documentation only)
**Status:** Proposed accounting treatment for business-owner/finance approval
**Scope:** Company-wide customer wallet

---

## A2.2 Approval Addendum (2026-11-19)

**AF-A1 — BUSINESS POLICY SELECTED — FINANCE VALIDATION REQUIRED.** The revenue-recognition event is **assessment completion (Option B)**. Assessment completion must not be followed by another revenue posting when the associated contract invoice is generated. Contract invoice generation must follow the approved non-duplicating accounting design. The exact tax, COGS and statutory-document treatment remains subject to Finance review. This is not Finance approval.

**AF-A3 — BUSINESS APPROVED — FINANCE IMPLEMENTATION VALIDATION REQUIRED.** Contract cancellation refunds use **Option B: release to wallet (Dr 2300 / Cr 2310), then refund from wallet (Dr 2310 / Cr Bank)**, both stages atomic, one bank debit, one wallet release, one wallet refund, duplicate-credit/refund prevention, and existing cancellation approval/destination/audit requirements.

**AF-A2 — PENDING — FINANCE/TAX REVIEW REQUIRED.** Tax recognition timing, contract invoice tax, COGS timing, and the acceptability of the non-posting contract invoice are unresolved.

W-01…W-08 are approved/accepted as recorded in `11-FINAL-BUSINESS-DECISION-REGISTER.md` and `24-PHASE-A2.2-BUSINESS-APPROVAL-RECORD.md`. **Phase A3 is not authorised.**

---

## 1. Accounting Model

The wallet uses a **two-liability model**:

| Account | Code | Type | Meaning |
|---|---|---|---|
| Operating Checking / Bank | `1010` (or company bank account) | Bank | Actual cash |
| Accounts Receivable | `1100` | AccountsReceivable | Customer owes |
| **Customer Wallet Funds** | **`2310` (proposed)** | OtherCurrentLiability | Unallocated prepaid customer funds |
| Unearned Contract Retainers | `2300` (seeded) | OtherCurrentLiability | Allocated contract funds |
| Printing & Sales Revenue | `4000` | Income | Earned revenue |
| Other Miscellaneous Income | `4900` | Income | Forfeitures / adjustments |
| Other Non-Operating Expense | `6900` | OtherExpense | Adjustments / write-offs |

**Key rules:**

1. A wallet deposit is **Dr Bank / Cr 2310**.
2. A contract allocation is **Dr 2310 / Cr 2300** (reclassification, no cash).
3. Contract consumption is **Dr 2300 / Cr 4000** (revenue recognition).
4. A wallet-funded invoice payment is **Dr 2310 / Cr 1100** (no bank movement).
5. A refund is **Dr 2310 / Cr Bank** (cash out).
6. A forfeiture is **Dr 2300 / Cr 4900** (no cash).
7. A reversal is a new compensating entry; never edit/delete the original.
8. Every wallet transaction has one journal; deposits/refunds also have one `bank_transactions` row.
9. No cash movement is posted twice.
10. No wallet balance is inferred from AR, bank, or contract balances.

---

## 2. Transaction Matrix

| # | Transaction | Debit | Credit | Wallet effect | Bank effect | Contract effect | Audit action | Idempotency route |
|---|---|---|---|---|---|---|---|---|
| 1 | Customer deposit — bank | `1010` Bank | `2310` Wallet | **Credit** +amount | `bank_transactions` Deposit (positive) | None | `WALLET_DEPOSIT_POSTED` | `wallet_deposit` |
| 2 | Customer deposit — cash | Cash/OtherCurrentAsset | `2310` Wallet | **Credit** +amount | Cash receipt (if tracked) | None | `WALLET_DEPOSIT_POSTED` | `wallet_deposit` |
| 3 | Customer deposit — mobile money | Mobile-money clearing | `2310` Wallet | **Credit** +amount | Settlement row when cleared | None | `WALLET_DEPOSIT_POSTED` | `wallet_deposit` |
| 4 | Contract activation allocation | `2310` Wallet | `2300` Contract | **Debit** −amount | None | Contract created/activated; allocation +amount | `WALLET_CONTRACT_ALLOCATED` | `wallet_allocation` |
| 5 | Contract top-up | `1010` Bank | `2310` Wallet | **Credit** +amount | Deposit | — | `WALLET_DEPOSIT_POSTED` | `wallet_topup` |
| 6 | Contract top-up allocation | `2310` Wallet | `2300` Contract | **Debit** −amount | None | Contract totals +amount | `WALLET_CONTRACT_ALLOCATED` | `wallet_topup` |
| 7 | Wallet-funded invoice payment | `2310` Wallet | `1100` AR | **Debit** −amount | **None** | None | `WALLET_INVOICE_PAID` | `wallet_invoice_payment` |
| 8 | Sales-order payment (future) | `2310` Wallet | `1100` AR / order liability | **Debit** −amount | None | None | `WALLET_ORDER_PAID` | `wallet_order_payment` |
| 9 | Contract consumption | `2300` Contract | `4000` Revenue | No unallocated change; allocation `consumed` +amount | None | Contract `remaining_balance` −amount; allocation consumed +amount | `WALLET_CONTRACT_CONSUMED` | `wallet_contract_consumption` |
| 10 | Unallocated wallet refund | `2310` Wallet | `1010` Bank | **Debit** −amount | `bank_transactions` Debit (negative) | None | `WALLET_REFUND_POSTED` | `wallet_refund` |
| 11 | Contract unused-funds refund — release | `2300` Contract | `2310` Wallet | **Credit** +remaining | None | Contract `remaining_balance` = 0; allocation `released` +remaining | `WALLET_CONTRACT_RELEASED` | `wallet_release` |
| 12 | Contract unused-funds refund — cash | `2310` Wallet | `1010` Bank | **Debit** −remaining | `bank_transactions` Debit (negative) | None | `WALLET_REFUND_POSTED` | `wallet_refund` |
| 13 | Contract forfeiture | `2300` Contract | `4900` Other Income | No wallet change; allocation `forfeited` +remaining | None | Contract `remaining_balance` = 0; allocation cancelled | `WALLET_CONTRACT_FORFEITED` | `wallet_forfeit` |
| 14 | Reverse deposit | `2310` Wallet | `1010` Bank | **Debit** −amount | `bank_transactions` Debit (negative) | None | `WALLET_REVERSAL_POSTED` | `wallet_reversal` |
| 15 | Reverse invoice payment | `1100` AR | `2310` Wallet | **Credit** +amount | None | Invoice balance restored | `WALLET_REVERSAL_POSTED` | `wallet_reversal` |
| 16 | Reverse allocation | `2300` Contract | `2310` Wallet | **Credit** +amount | None | Contract totals −amount | `WALLET_REVERSAL_POSTED` | `wallet_reversal` |
| 17 | Adjustment — reduce wallet | `2310` Wallet | `6900` Other Expense / approved | **Debit** −amount | None | None | `WALLET_ADJUSTMENT_POSTED` | `wallet_adjustment` |
| 18 | Adjustment — increase wallet | `4900` Other Income / approved | `2310` Wallet | **Credit** +amount | None | None | `WALLET_ADJUSTMENT_POSTED` | `wallet_adjustment` |
| 19 | Write-off unallocated funds | `2310` Wallet | `4900` Other Income | **Debit** −amount | None | None | `WALLET_WRITE_OFF_POSTED` | `wallet_writeoff` |
| 20 | Wallet-to-wallet transfer (same customer/currency) | `2310` Wallet A | `2310` Wallet B | Two rows: debit A, credit B | None | None | `WALLET_TRANSFER_POSTED` | `wallet_transfer` |

**Note:** rows 4 and 5/6 are alternatives: activation allocates from existing wallet funds; a top-up deposits new cash and allocates it. Both use the same two-liability treatment.

---

## 2.1 Revenue Recognition and Contract Invoices — CRITICAL CORRECTION

### Current behaviour (verified)

1. **Contract assessment completion** posts revenue:
   - `printingRecordsService.ts:970-990`: **Dr 2300 Unearned Contract Retainers / Cr 4000 Printing & Sales Revenue**.
2. **Contract milestone invoice generation** posts revenue again:
   - `salesService.ts:1004-1027`: **Dr 1100 Accounts Receivable / Cr 4000 Printing & Sales Revenue** (the invoice path does not branch on contract source).
3. **Production completion, delivery, and customer acceptance** do not post contract revenue; `productionService.ts` posts WIP/COGS only.
4. **Invoice creation** therefore risks **double revenue recognition** for any contract assessment that was already completed and then invoiced.

### Required correction (Finance decision AF-A1/AF-A2)

Choose **one** revenue recognition event and make the other path non-revenue:

| Option | Revenue event | Assessment completion | Contract invoice / receipt | Consequence |
|---|---|---|---|---|
| **A** | Contract invoice / receipt | Updates status/remaining only; **no revenue** | Dr 2300 / Cr 4000; no AR; paid from contract | Requires a contract-funded invoice path |
| **B** | Assessment completion (current) | Dr 2300 / Cr 4000 | **Nil-GL receipt**: no AR, no revenue, no COGS; `journal_txn_id=NULL` | Least invasive; preserves current revenue timing |
| **C** | Production completion / delivery / acceptance | No revenue | No revenue | Requires new events; not current |

**Recommendation:** Option B (assessment completion + nil-GL contract receipt) is the least invasive and preserves the current revenue timing. Option A is cleaner for tax invoicing but requires a contract-funded invoice path. **Finance must choose. Until then, contract milestone invoices must not post Dr AR / Cr 4000.**

**Never allow both assessment completion and contract invoice to post revenue.**

### Contract invoice GL rules

- **Option B:** contract invoice/receipt has `journal_txn_id = NULL`; it is a billing document, not a GL event. `amount_paid = total`, `balance_due = 0`, no AR. It must not post COGS; production WIP relief remains separate.
- **Option A:** contract invoice/receipt posts Dr 2300 / Cr 4000; `amount_paid = total`, `balance_due = 0`, `deposit_to_account_id = 2300`, no bank row, no AR.
- **Tax:** if the contract invoice is a tax invoice, Finance/tax must confirm how sales tax is posted without double-counting revenue. This is **AF-A2**.
- **COGS:** contract invoices must not post inventory COGS if production WIP relief already posted it. Finance must confirm. This is **AF-A2**.

### Contract invoice linkage

The current `invoices` table has no `source_type`/`source_ref`/`contract_id` column. The document service passes `postgresContractId`/`postgresMilestoneNumber` to `generateInvoiceFromWorkflow`, but `createInvoiceOrSalesReceipt` does not store them. **Required:** add `invoices.source_type`, `invoices.source_ref`, `invoices.contract_id`, `invoices.milestone_number` (or an equivalent link table) so contract invoices can be identified and prevented from double-posting.

---

## 2.2 Deposit vs Allocation — Explicit Distinction

| Event | Cash? | Wallet unallocated | Contract allocation | GL |
|---|---|---|---|---|
| **Deposit** | Yes (bank/cash in) | **+amount** | None | Dr Bank / Cr 2310 |
| **Allocation** | **No** | **−amount** | **+amount** | Dr 2310 / Cr 2300 |
| **Top-up** | Yes (bank in) | +amount then −amount | +amount | Dr Bank / Cr 2310; Dr 2310 / Cr 2300 |
| **Consumption** | No | unchanged | consumed +amount | Dr 2300 / Cr 4000 |
| **Release** | No | +amount | released +amount | Dr 2300 / Cr 2310 |
| **Refund** | Yes (bank out) | −amount | None (or after release) | Dr 2310 / Cr Bank |

**A deposit must never be posted twice.** If the deposit is recorded through an existing payment workflow, the wallet deposit must link to that journal/payment and must not create a second bank row.

---

## 2.3 Contract Cancellation Refund — Two Flows (AF-A3)

### Option A — direct contract liability → bank

```
Dr 2300 Unearned Contract Retainers   X
    Cr 1010 Bank                         X
```
- Allocation `released_amount += X` (or a new `refunded_amount`).
- Contract `remaining_balance = 0`.
- One bank Debit row.
- No wallet credit.
- Simpler; fewer steps.
- Wallet statement does not show the refund unless a memo transaction is recorded.

### Option B — release to wallet, then refund (recommended for a unified statement)

```
Step 1: Dr 2300 / Cr 2310   (release)
Step 2: Dr 2310 / Cr 1010   (refund)
```
- Allocation `released_amount += X`; wallet `release` (+X); wallet `refund` (−X).
- One bank Debit row.
- Both steps in **one transaction**, one idempotency key.
- The intermediate wallet credit is not spendable between steps.
- No duplicate credit: allocation released once, wallet credited once, refund debited once, bank debited once.

**Finance must choose (AF-A3).** Option B is recommended for a single customer wallet statement; Option A is acceptable if Finance prefers direct settlement, provided the allocation is closed and the refund is audited.

---

## 3. Detailed Journal Examples

### 3.1 Customer deposit — K10,000 bank transfer

**Journal:**
```
Dr 1010 Operating Checking        10,000.0000
    Cr 2310 Customer Wallet Funds    10,000.0000
```

**Bank subledger:**
```
bank_transactions: txn_type='Deposit', amount=+10,000.0000,
                   journal_txn_id=<journal>, customer_id=<customer>,
                   ref_number=<deposit ref>
```

**Wallet transaction:**
```
txn_type='deposit', direction='credit', amount=10,000.0000,
balance_after=<previous>+10,000.0000, reference_type='wallet_deposit',
reference_id=<id>, journal_txn_id=<journal>, bank_txn_id=<bank row>
```

**Wallet balance:** +10,000.

### 3.2 Contract activation — K60,000 allocation

**Journal:**
```
Dr 2310 Customer Wallet Funds     60,000.0000
    Cr 2300 Unearned Contract Retainers 60,000.0000
```

**Wallet transaction:**
```
txn_type='allocation', direction='debit', amount=60,000.0000,
balance_after=<previous>−60,000.0000, reference_type='contract',
reference_id=<contractId>, allocation_id=<allocation id>,
journal_txn_id=<journal>
```

**Allocation:**
```
customer_wallet_allocations: allocation_type='contract', contract_id=<id>,
amount=60,000, consumed=0, released=0, forfeited=0, status='active'
```

**Contract:** `status='active'`, `total_prepaid_amount=60,000`, `remaining_balance=60,000`.

**No bank movement.**

### 3.3 Contract top-up — K10,000

**Journal 1 (deposit):**
```
Dr 1010 Operating Checking        10,000.0000
    Cr 2310 Customer Wallet Funds    10,000.0000
```
**Journal 2 (allocation):**
```
Dr 2310 Customer Wallet Funds     10,000.0000
    Cr 2300 Unearned Contract Retainers 10,000.0000
```
**Wallet transactions:** `deposit` (+10,000), `allocation` (−10,000).
**Bank subledger:** one Deposit row.
**Contract:** totals +10,000.

### 3.4 Wallet-funded invoice payment — K5,000

**Journal:**
```
Dr 2310 Customer Wallet Funds      5,000.0000
    Cr 1100 Accounts Receivable        5,000.0000
```

**Payments row:**
```
payment_method='Wallet', deposit_to_account_id=<2310>,
journal_txn_id=<journal>, amount=5,000
```

**Payment allocation:**
```
payment_allocations: payment_id=<id>, invoice_id=<id>, amount=5,000
```

**Wallet transaction:**
```
txn_type='invoice_payment', direction='debit', amount=5,000,
reference_type='payment', reference_id=<paymentId>,
journal_txn_id=<journal>
```

**Invoice:** `amount_paid` +5,000; `balance_due` −5,000; status updated.
**No bank transaction.**

### 3.5 Contract consumption — K15,000 assessment

**Journal:**
```
Dr 2300 Unearned Contract Retainers 15,000.0000
    Cr 4000 Printing & Sales Revenue    15,000.0000
```

**Allocation:**
```
consumed_amount += 15,000
```

**Contract:**
```
remaining_balance = 60,000 − 15,000 = 45,000
completed_assessments += 1
```

**Wallet unallocated balance:** unchanged.
**Bank:** none.
**Wallet transaction:** optional `contract_consumption` record with `allocation_id`, `amount=15,000`, `direction='debit'`, `balance_after=<wallet balance unchanged>`. If recorded, it must not alter the wallet balance; the allocation table is the authoritative consumption record.

### 3.6 Unallocated wallet refund — K2,000

**Journal:**
```
Dr 2310 Customer Wallet Funds      2,000.0000
    Cr 1010 Operating Checking         2,000.0000
```

**Bank subledger:**
```
bank_transactions: txn_type='Debit', amount=−2,000.0000,
                   journal_txn_id=<journal>, customer_id=<customer>
```

**Wallet transaction:**
```
txn_type='refund', direction='debit', amount=2,000,
reference_type='wallet_refund', reference_id=<id>,
journal_txn_id=<journal>, bank_txn_id=<bank row>
```

**Approval:** `wallet_refund` approval; threshold check.

### 3.7 Contract unused-funds refund — K5,000

**Step 1 — release from contract to wallet:**
```
Dr 2300 Unearned Contract Retainers  5,000.0000
    Cr 2310 Customer Wallet Funds        5,000.0000
```
Allocation `released_amount += 5,000`; contract `remaining_balance = 0`.
Wallet transaction `release` (`direction='credit'`, `amount=5,000`, `allocation_id`).

**Step 2 — refund from wallet:**
```
Dr 2310 Customer Wallet Funds        5,000.0000
    Cr 1010 Operating Checking           5,000.0000
```
Bank Debit −5,000; wallet transaction `refund` (`direction='debit'`, `amount=5,000`).

**Both steps in one transaction; one audit record per step; one idempotency key for the settlement.**

### 3.8 Contract forfeiture — K5,000

**Journal:**
```
Dr 2300 Unearned Contract Retainers  5,000.0000
    Cr 4900 Other Miscellaneous Income   5,000.0000
```

**Allocation:** `forfeited_amount += 5,000`, `status='cancelled'`.
**Contract:** `remaining_balance = 0`, `status='cancelled'`, settlement fields.
**No bank movement.**
**Approval:** `wallet_forfeit` / cancellation approval.

### 3.9 Reversals

**Reverse a deposit:**
```
Dr 2310 Customer Wallet Funds      2,000.0000
    Cr 1010 Operating Checking         2,000.0000
```
- New wallet transaction `reversal`, `direction='debit'`, `reverses_txn_id=<deposit id>`.
- Bank Debit −2,000.
- Requires wallet balance ≥ 2,000 or an approved adjustment.

**Reverse an invoice payment:**
```
Dr 1100 Accounts Receivable        5,000.0000
    Cr 2310 Customer Wallet Funds        5,000.0000
```
- Invoice balance restored; wallet credit +5,000.
- New wallet transaction `reversal`, `direction='credit'`, `reverses_txn_id=<invoice_payment id>`.

**Reverse an allocation:**
```
Dr 2300 Unearned Contract Retainers 60,000.0000
    Cr 2310 Customer Wallet Funds        60,000.0000
```
- Allocation `released_amount += 60,000`; contract totals reduced.
- Wallet credit +60,000.

### 3.10 Adjustments

**Reduce wallet:**
```
Dr 2310 Customer Wallet Funds        1,000.0000
    Cr 6900 Other Non-Operating Expense  1,000.0000
```
**Increase wallet:**
```
Dr 4900 Other Miscellaneous Income   1,000.0000
    Cr 2310 Customer Wallet Funds        1,000.0000
```
- `txn_type='adjustment'`, reason mandatory, approval required.
- Never use to convert AR to wallet.

### 3.11 Wallet-funded sales-order payment (future)

No sales-order table exists today. When sales orders are introduced:
```
Dr 2310 Customer Wallet Funds        X
    Cr 1100 Accounts Receivable / order liability  X
```
- Wallet transaction `sales_order_payment`, `direction='debit'`.
- No bank movement.
- Same idempotency/approval rules.

---

## 4. Double-Entry Completeness Rules

1. Every journal balances: `SUM(debit) = SUM(credit)`.
2. Every wallet transaction has exactly one journal (except pure allocation/consumption records that do not change the unallocated wallet balance).
3. Deposits/refunds have exactly one `bank_transactions` row.
4. Wallet-funded invoice payments have **no** `bank_transactions` row.
5. No cash movement is posted twice.
6. Contract consumption does not create a bank row.
7. Forfeiture does not create a bank row.
8. Reversals are new entries; the original remains posted.
9. Period must be open (`postJournalEntry` validates).
10. Accounts must be active and exist for the company.

---

## 5. Revenue Recognition

- Revenue is recognized **only on contract consumption** (`Dr 2300 / Cr 4000`), not on:
  - wallet deposit;
  - contract activation/allocation;
  - job creation;
  - invoice generation.
- This is consistent with the existing `completeContractAssessment` model (`printingRecordsService.ts:933-1040`) and the approved D-05.
- Invoice generation from a contract is a billing document, not revenue recognition, unless the invoice itself is the revenue event (outside contract retainers).

---

## 6. Refund Threshold and Approvals

- Default threshold: **K250,000** (T03).
- A refund **greater than** K250,000 requires an additional independent approval.
- A refund **equal to** K250,000 does not exceed the threshold.
- Threshold is company-configurable (`approval_policies` for `wallet_refund` or `company_settings`).
- Store the threshold applied on the wallet transaction/settlement.
- Requester cannot approve their own request.
- Refund destination must be an authorised bank/cash account selected by Finance (D-02/B-07).
- Refund method and destination are recorded.

---

## 7. Revenue/Expense Accounts for Adjustments

| Adjustment type | Debit | Credit | Approval |
|---|---|---|---|
| Reduce wallet (customer liability) | `2310` | `6900` / approved | Accountant |
| Increase wallet (goodwill) | `4900` / approved | `2310` | Accountant |
| Write-off unallocated funds | `2310` | `4900` | Accountant + business owner above threshold |
| Forfeit contract funds | `2300` | `4900` | Cancellation approval |

Do not silently substitute Printing Revenue (`4000`) for forfeiture/adjustments (D-03).

---

## 8. Multi-Currency

- Phase 1: base-currency wallets only.
- If a wallet currency differs from the company base:
  - configure a liability account for that currency;
  - post the wallet at the transaction exchange rate;
  - record FX gain/loss on settlement;
  - never implicitly convert.
- The wallet transaction stores `currency_code` and `exchange_rate` (if applicable).

---

## 9. Summary of Debits/Credits by Event

| Event | Total debits | Total credits | Cash? | Revenue? |
|---|---|---|---|---|
| Deposit | Bank | Wallet liability | Yes (in) | No |
| Activation allocation | Wallet liability | Contract liability | No | No |
| Top-up | Bank | Wallet liability; then Wallet liability → Contract liability | Yes (in) | No |
| Invoice payment | Wallet liability | AR | No | No |
| Contract consumption | Contract liability | Revenue | No | Yes |
| Refund (unallocated) | Wallet liability | Bank | Yes (out) | No |
| Refund (contract) | Contract liability → Wallet liability; Wallet liability → Bank | — | Yes (out) | No |
| Forfeiture | Contract liability | Other income | No | Yes (other income) |
| Reversal | Opposite of original | Opposite of original | Depends | Reverses |
| Adjustment | Approved | Approved | No | No |

**A2 accounting design is complete and ready for finance review.**