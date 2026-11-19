# 21 — Customer Wallet Legacy Reconciliation

**Date:** 2026-11-19
**Phase:** A2 — Financial Architecture (documentation only)
**Status:** Read-only investigation and migration proposal; no data changed
**Scope:** Existing financial records before customer-wallet implementation

---

## 1. Objective

Classify existing financial records so the wallet can be introduced without:

- converting accounts-receivable balances into wallet funds automatically;
- converting unapplied payments into wallet deposits automatically;
- changing historical bank, contract, or GL records;
- silently rewriting financial history.

**D-12 and B-09 apply:** read-only preflight, quarantine uncertain records, preserve originals, separate approval before any remediation.

---

## 2. Non-Goals

- No UPDATE/INSERT/DELETE.
- No journal postings.
- No AR-to-wallet conversion.
- No contract-balance transfer.
- No renumbering.
- No account creation.
- No automatic correction.

---

## 3. Read-Only Execution Rules

1. Use `BEGIN TRANSACTION READ ONLY` and `SET LOCAL statement_timeout`.
2. Use a reporting role or `app.bypass_rls='on'` **only** for the read-only system query; include `company_id` in every row.
3. Export results to CSV with a timestamp and query version.
4. Do not run on production during business hours; use a replica/standby if available.
5. Record row counts and duration.

---

## 4. Legacy Data Inventory

### 4.1 Customers and AR

```sql
SELECT company_id, id, company_name, balance, currency_code
  FROM customers
 ORDER BY company_id, id;
```

`customers.balance` is **AR**, not wallet (`commercialHelpers.ts:478-521`). Classify as `AR`.

### 4.2 Open invoices

```sql
SELECT company_id, id, invoice_number, customer_id, status,
       total, amount_paid, balance_due, currency_code
  FROM invoices
 WHERE status <> 'voided'
   AND balance_due > 0
 ORDER BY company_id, customer_id, id;
```

Classify as `AR`.

### 4.3 Credit memos

```sql
SELECT company_id, id, credit_number, customer_id, status,
       total, remaining_credit
  FROM credit_memos
 WHERE status <> 'voided'
 ORDER BY company_id, customer_id, id;
```

Classify as `AR_CREDIT`.

### 4.4 Payments and unapplied remainders

```sql
SELECT p.company_id,
       p.id,
       p.payment_number,
       p.customer_id,
       p.payment_date,
       p.amount,
       p.currency_code,
       p.journal_txn_id,
       COALESCE(a.alloc_sum, 0) AS allocated,
       p.amount - COALESCE(a.alloc_sum, 0) AS unapplied
  FROM payments p
  LEFT JOIN (
    SELECT payment_id, SUM(amount) AS alloc_sum
      FROM payment_allocations
     GROUP BY payment_id
  ) a ON a.payment_id = p.id
 WHERE p.is_voided = FALSE
 ORDER BY p.company_id, p.customer_id, p.id;
```

**Unapplied payments:**

```sql
SELECT p.company_id, p.id, p.payment_number, p.customer_id,
       p.amount, p.currency_code,
       p.amount - COALESCE(a.alloc_sum, 0) AS unapplied
  FROM payments p
  LEFT JOIN (
    SELECT payment_id, SUM(amount) AS alloc_sum
      FROM payment_allocations GROUP BY payment_id
  ) a ON a.payment_id = p.id
 WHERE p.is_voided = FALSE
   AND p.amount - COALESCE(a.alloc_sum, 0) > 0
 ORDER BY p.company_id, p.customer_id, p.id;
```

Classify as `UNAPPLIED_PAYMENT_REVIEW`. These are **AR credits**, not wallet funds.

### 4.5 Bank transactions

```sql
SELECT company_id, id, txn_date, txn_type, amount, ref_number,
       journal_txn_id, customer_id, status
  FROM bank_transactions
 ORDER BY company_id, id;
```

Classify as `BANK_TRANSACTION`.

### 4.6 Contract-linked bank transactions

```sql
SELECT bt.company_id, bt.id, bt.txn_date, bt.txn_type, bt.amount,
       bt.ref_number, bt.journal_txn_id, bt.customer_id
  FROM bank_transactions bt
 WHERE bt.ref_number LIKE 'CTR-%'
 ORDER BY bt.company_id, bt.id;
```

Classify as `BANK_CONTRACT_LINKED` if a matching contract exists; otherwise `ORPHAN_BANK_REF`.

### 4.7 Contracts

```sql
SELECT company_id, id, contract_number, school_customer_id, status,
       total_prepaid_amount, remaining_balance,
       deposit_journal_txn_id, liability_account_id, deposit_bank_account_id
  FROM printing_contracts
 ORDER BY company_id, id;
```

Classify as `CONTRACT_LIABILITY` (not wallet).

### 4.8 Contract deposit journals

```sql
SELECT pc.company_id, pc.id, pc.contract_number,
       pc.deposit_journal_txn_id,
       j.entry_number, j.txn_date, j.description, j.source_type, j.source_id
  FROM printing_contracts pc
  LEFT JOIN journal_transactions j
    ON j.company_id = pc.company_id AND j.id = pc.deposit_journal_txn_id
 ORDER BY pc.company_id, pc.id;
```

**Missing deposit journal:**

```sql
SELECT company_id, id, contract_number, status, total_prepaid_amount
  FROM printing_contracts
 WHERE deposit_journal_txn_id IS NULL;
```

**Journal without bank row:**

```sql
SELECT pc.company_id, pc.id, pc.contract_number,
       pc.deposit_journal_txn_id, j.entry_number
  FROM printing_contracts pc
  JOIN journal_transactions j
    ON j.company_id = pc.company_id AND j.id = pc.deposit_journal_txn_id
  LEFT JOIN bank_transactions bt
    ON bt.company_id = pc.company_id AND bt.journal_txn_id = pc.deposit_journal_txn_id
 WHERE pc.deposit_journal_txn_id IS NOT NULL
   AND bt.id IS NULL;
```

### 4.9 Contract allocations and balances

```sql
SELECT pc.company_id, pc.id, pc.contract_number, pc.status,
       pc.total_prepaid_amount,
       COALESCE(SUM(ms.agreed_amount), 0) AS allocated,
       pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0) AS unallocated,
       pc.completed_assessments,
       COUNT(ms.id) FILTER (WHERE ms.status = 'completed') AS actual_completed
  FROM printing_contracts pc
  LEFT JOIN contract_assessment_milestones ms
    ON ms.company_id = pc.company_id AND ms.contract_id = pc.id
 GROUP BY pc.company_id, pc.id, pc.contract_number, pc.status,
          pc.total_prepaid_amount, pc.completed_assessments
 ORDER BY pc.company_id, pc.id;
```

### 4.10 Contract remaining vs completed

```sql
SELECT pc.company_id, pc.id, pc.contract_number,
       pc.remaining_balance,
       pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0) AS expected_remaining,
       pc.remaining_balance
         - (pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0)) AS variance
  FROM printing_contracts pc
  LEFT JOIN contract_assessment_milestones ms
    ON ms.company_id = pc.company_id AND ms.contract_id = pc.id
   AND ms.status = 'completed'
 GROUP BY pc.company_id, pc.id, pc.contract_number,
          pc.remaining_balance, pc.total_prepaid_amount
HAVING pc.remaining_balance
       <> pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0);
```

### 4.11 Contract milestones without journals

```sql
SELECT company_id, contract_id, assessment_number, status, agreed_amount,
       journal_txn_id
  FROM contract_assessment_milestones
 WHERE status = 'completed'
   AND journal_txn_id IS NULL;
```

### 4.12 Malformed contract/exam numbers

```sql
SELECT company_id, id, contract_number
  FROM printing_contracts
 WHERE contract_number !~ '^CTR-[0-9]{4}-[0-9]+$';

SELECT company_id, id, job_number
  FROM exam_papers
 WHERE job_number !~ '^EXM-[0-9]{4}-[0-9]+$';
```

### 4.13 Currency codes

```sql
SELECT company_id, id, contract_number, currency_code
  FROM printing_contracts
 WHERE currency_code IS NULL;
-- after currency_code is added; before then, compare to companies.base_currency
```

### 4.14 Journal source types

```sql
SELECT source_type, COUNT(*), SUM(debit), SUM(credit)
  FROM journal_transactions
 GROUP BY source_type
 ORDER BY source_type;
```

### 4.15 Bank references without contracts

```sql
SELECT bt.company_id, bt.id, bt.txn_date, bt.txn_type, bt.amount,
       bt.ref_number, bt.journal_txn_id
  FROM bank_transactions bt
 WHERE bt.ref_number LIKE 'CTR-%'
   AND NOT EXISTS (
     SELECT 1 FROM printing_contracts pc
      WHERE pc.company_id = bt.company_id
        AND pc.contract_number = bt.ref_number
   );
```

---

## 5. Classification Taxonomy

| Code | Meaning | Wallet action |
|---|---|---|
| `VERIFIED_PREPAID_WALLET_CANDIDATE` | A payment explicitly received as prepaid funds with no invoice/contract allocation and customer agreement | Eligible for approved conversion; not automatic |
| `VERIFIED_CONTRACT_ALLOCATION` | Contract with deposit journal, liability account, and remaining balance | Remains contract liability; not wallet |
| `AR` | Invoice/credit memo/payment allocated to invoices | Remains AR |
| `AR_CREDIT` | Credit memo remaining credit | Remains AR credit |
| `UNAPPLIED_PAYMENT_REVIEW` | Payment remainder not allocated | Review; not wallet unless approved |
| `BANK_TRANSACTION` | Bank/cash movement | Remains bank |
| `BANK_CONTRACT_LINKED` | Bank row linked to a contract | Remains contract funding |
| `CONTRACT_LIABILITY` | Contract prepaid/remaining | Remains contract liability |
| `ORPHAN_BANK_REF` | Bank row references missing contract | Quarantine; investigate |
| `MISSING_JOURNAL` | Contract/payment without journal | Quarantine; investigate |
| `BALANCE_MISMATCH` | Contract remaining ≠ expected | Quarantine; finance review |
| `COUNT_MISMATCH` | Stored counts ≠ actual | Quarantine; trigger reconciliation |
| `MALFORMED_NUMBER` | Number outside format | Report only; never renumber |
| `DUPLICATE_NUMBER` | Duplicate contract/exam number | Quarantine; investigate |
| `UNRESOLVED` | Anything not classified | Quarantine; manual review |

---

## 6. Reconciliation Methodology

1. Run all queries in a read-only transaction.
2. Export CSV per query with company, record id, amount, currency.
3. Classify each row.
4. Quantify by class:
   - count;
   - absolute amount;
   - currency.
5. Finance review:
   - AR balances;
   - unapplied payments;
   - contract liabilities;
   - bank rows;
   - missing journals.
6. Quarantine uncertain records; do not include them in the wallet opening balances.
7. Approve remediation under D-12.
8. Execute only approved, audited changes.
9. Re-run the preflight; target zero unexplained exceptions.

---

## 7. Safe Migration Proposal

### 7.1 Default: wallets start at zero

- No historical balance is converted.
- Existing AR, bank, and contract liabilities remain unchanged.
- New wallet deposits are recorded from the go-live date.
- This is the safest and recommended default.

### 7.2 Optional: approved conversion of unapplied payments

Only if the business explicitly approves and the customer agrees:

```
Dr 1100 Accounts Receivable       X
    Cr 2310 Customer Wallet Funds     X
```

- No cash movement.
- The payment must be unapplied and clearly a customer credit.
- The conversion must be per payment/customer, approved, and audited.
- **Required schema/service change:** mark the payment as converted so `recalculateCustomerBalance` does not subtract it again.
  - Add `payments.wallet_conversion_txn_id` (FK to wallet txn), or
  - create a dedicated clearing allocation that excludes it from unapplied.
  - Without this, the AR balance would double-count the credit.
- **Do not run this automatically.**

### 7.3 Contract balances

- Existing contract deposits remain in `2300 Unearned Contract Retainers`.
- **They remain in their current contract-liability accounting until an independently authorised migration/reconciliation process.**
- Do not move them to `2310`.
- If a contract is cancelled and funds are released, use the approved cancellation workflow:
  - Dr 2300 / Cr 2310 (release), then refund if approved (Option B); or
  - Dr 2300 / Cr Bank directly (Option A).
- Historical contract balances are not wallet funds.
- **No automatic conversion of contract deposits, remaining balances, or unused funds.**

### 7.3.1 Contract invoice revenue risk (legacy)

**Risk:** if contract assessments were completed (revenue posted Dr 2300 / Cr 4000) and contract milestone invoices were generated (revenue posted Dr AR / Cr 4000), revenue may be **double-counted**. The current `invoices` table has no contract linkage, so detection is limited.

**Read-only detection:**

```sql
-- Completed assessments and their revenue recognition
SELECT ms.company_id, ms.contract_id, COUNT(*) AS completed,
       SUM(ms.agreed_amount) AS recognized_revenue
  FROM contract_assessment_milestones ms
 WHERE ms.status = 'completed'
 GROUP BY ms.company_id, ms.contract_id;

-- Contract-linked invoices (once invoices.source_type/contract_id are added)
SELECT i.company_id, i.id, i.invoice_number, i.contract_id, i.milestone_number,
       i.total, i.journal_txn_id
  FROM invoices i
 WHERE i.source_type = 'contract_milestone'
    OR i.contract_id IS NOT NULL;
```

**Until `invoices` has contract linkage:**
- Use `journal_transactions.source_type='invoice'` with descriptions/references matching contract numbers, if available.
- Review the document/invoice generation logs.
- Quarantine any contract with both completed assessments and a contract invoice.
- Finance must determine whether revenue was double-counted; **no automatic correction.**

**Required schema addition (future):** `invoices.source_type`, `invoices.source_ref`, `invoices.contract_id`, `invoices.milestone_number` (or a link table). This is not part of A2.1; it is an implementation dependency for AF-A1/AF-A2.

### 7.4 Bank transactions

- Existing bank transactions remain bank records.
- Contract-linked bank rows are not wallet deposits.
- Do not create wallet transactions for historical bank rows.

---

## 8. Quarantine

Create a quarantine report (not a table unless approved):

```
company_id, record_type, record_id, reference, amount, currency,
exception_code, evidence, recommended_treatment, status
```

Quarantined records are excluded from wallet opening balances and from financial reports until resolved.

---

## 9. Approval Workflow (D-12/B-09/B-10)

| Step | Owner | Output |
|---|---|---|
| 1. Run preflight | DBA/Engineer | Read-only CSV |
| 2. Classify | Finance | Exception report |
| 3. Quantify | Finance | Financial impact |
| 4. Propose treatment | Finance/Business | Remediation plan |
| 5. Approve | Business owner + Finance | Signed approval |
| 6. Backup | DBA | Verified backup |
| 7. Execute | Engineer | Controlled, audited changes |
| 8. Verify | Finance | Zero unexplained report |
| 9. Certify | Finance | Sign-off |

**No remediation without step 5.**

---

## 10. Test Scenarios

| Scenario | Expected |
|---|---|
| Clean DB | Zero exceptions |
| Unapplied payment | Classified `UNAPPLIED_PAYMENT_REVIEW`, not wallet |
| Contract with deposit journal | Classified `CONTRACT_LIABILITY` |
| Contract without journal | `MISSING_JOURNAL` |
| Bank row with contract ref but no contract | `ORPHAN_BANK_REF` |
| Contract remaining mismatch | `BALANCE_MISMATCH` |
| Malformed number | Reported, not renumbered |
| Rerun preflight | Same results; no mutation |
| Read-only enforcement | UPDATE/DELETE fail |
| Approved conversion | Wallet funded; AR credit reduced once; audit |
| No approval | Conversion blocked |

---

## 11. A2 Legacy Verdict

**Design complete; execution not performed.** The legacy data is expected to contain:

- AR customers/invoices/credit memos;
- unapplied payments (AR credits);
- bank transactions;
- contract liabilities and remaining balances;
- possible missing journals/bank rows and count/balance mismatches.

None of these are wallet funds. The default migration is **wallets start at zero**. Any conversion requires explicit approval and the schema/service change to prevent double-counting AR.

**No historical financial data was changed in A2.**