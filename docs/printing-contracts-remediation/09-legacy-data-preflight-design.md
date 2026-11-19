# 09 — Legacy Data Preflight Design (Stage 2)

**Date:** 2026-11-19
**Covers:** MIG-15 (legacy allocations and credit balances), D-12
**Mode:** Documentation only — no queries executed against production, no data changed

---

## 1. Executive Summary

The existing database may contain contracts with:

- assessment allocations that exceed or fall short of the prepaid amount;
- a remaining balance that does not equal `total_prepaid_amount - SUM(completed agreed_amount)`;
- count mismatches between `printing_contracts` and `contract_assessment_milestones`;
- cancelled contracts with a positive balance;
- completed/exhausted contracts with an unallocated credit balance;
- missing deposit journals or bank-subledger rows;
- malformed or duplicate contract/exam numbers;
- missing/inactive liability or bank accounts;
- completed milestones without a journal, or journals without a completed milestone;
- orphaned invoice links or bank references.

**D-12 requires a read-only preflight, a reconciliation report, separate business/finance approval, and controlled audited remediation. No automatic historical correction is permitted.**

This document specifies the read-only queries, exception taxonomy, reconciliation methodology, reporting, approval workflow, and remediation strategy.

---

## 2. Scope and Non-Goals

### 2.1 In scope

- Read-only queries over `printing_contracts`, `contract_assessment_milestones`, `bank_transactions`, `journal_transactions`, `journal_lines`, `invoices`, `accounts`, `customers`.
- Classification of exceptions.
- Financial impact quantification.
- Reporting and sign-off.
- A controlled remediation runbook (not executed here).

### 2.2 Out of scope

- Automatic UPDATE/INSERT/DELETE.
- Rewriting historical contract numbers.
- Changing historical currency.
- Re-posting or reversing journals without finance approval.
- Modifying the chart of accounts.
- Enabling strict constraints before remediation.

---

## 3. Read-Only Execution Rules

1. Use a **read-only transaction**:
   ```sql
   BEGIN TRANSACTION READ ONLY;
   SET LOCAL statement_timeout = '120s';
   -- run queries
   ROLLBACK;
   ```
2. Use a **reporting role** or `app.bypass_rls='on'` only for the read-only system query. Do not use the application role for cross-company reads.
3. Run **per company** where possible; if a cross-company report is required, include `company_id` in every row and do not expose other tenants' data.
4. Export results to CSV with a timestamp and query version.
5. Never run `VACUUM`, `ALTER`, `UPDATE`, `DELETE`, or `INSERT` in the preflight transaction.
6. Record the exact SQL, parameters, row counts, and duration.

---

## 4. Query Catalog

### Q-01 — Allocation over/under

**Purpose:** find contracts where the sum of milestone agreed amounts exceeds or is less than the prepaid amount.

```sql
SELECT pc.company_id,
       pc.id,
       pc.contract_number,
       pc.status,
       pc.total_prepaid_amount,
       COALESCE(SUM(ms.agreed_amount), 0) AS allocated_amount,
       pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0) AS unallocated_amount,
       COUNT(ms.id) AS milestone_count
  FROM printing_contracts pc
  LEFT JOIN contract_assessment_milestones ms
    ON ms.company_id = pc.company_id
   AND ms.contract_id = pc.id
 GROUP BY pc.company_id, pc.id, pc.contract_number, pc.status, pc.total_prepaid_amount
HAVING COALESCE(SUM(ms.agreed_amount), 0) > pc.total_prepaid_amount
    OR (pc.status = 'active' AND COALESCE(SUM(ms.agreed_amount), 0) < pc.total_prepaid_amount)
 ORDER BY pc.company_id, pc.id;
```

**Interpretation:**
- `allocated_amount > total_prepaid_amount` → `ALLOCATION_OVER` (manual adjustment required).
- `allocated_amount < total_prepaid_amount` on an active contract → `ALLOCATION_UNDER` (may be intentional unallocated credit; confirm with business).

---

### Q-02 — Remaining balance vs completed assessments

**Purpose:** verify `remaining_balance = total_prepaid_amount - SUM(agreed_amount WHERE status='completed')`.

```sql
SELECT pc.company_id,
       pc.id,
       pc.contract_number,
       pc.status,
       pc.total_prepaid_amount,
       pc.remaining_balance,
       COALESCE(SUM(ms.agreed_amount), 0) AS completed_amount,
       pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0) AS expected_remaining,
       pc.remaining_balance
         - (pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0)) AS variance
  FROM printing_contracts pc
  LEFT JOIN contract_assessment_milestones ms
    ON ms.company_id = pc.company_id
   AND ms.contract_id = pc.id
   AND ms.status = 'completed'
 GROUP BY pc.company_id, pc.id, pc.contract_number, pc.status,
          pc.total_prepaid_amount, pc.remaining_balance
HAVING pc.remaining_balance
       <> pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0)
 ORDER BY ABS(pc.remaining_balance
              - (pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0))) DESC;
```

**Interpretation:** `BALANCE_MISMATCH`.

---

### Q-03 — Count mismatches

```sql
SELECT pc.company_id,
       pc.id,
       pc.contract_number,
       pc.total_assessments,
       COUNT(ms.id) AS actual_total,
       pc.completed_assessments,
       COUNT(ms.id) FILTER (WHERE ms.status = 'completed') AS actual_completed
  FROM printing_contracts pc
  LEFT JOIN contract_assessment_milestones ms
    ON ms.company_id = pc.company_id
   AND ms.contract_id = pc.id
 GROUP BY pc.company_id, pc.id, pc.contract_number,
          pc.total_assessments, pc.completed_assessments
HAVING pc.total_assessments <> COUNT(ms.id)
    OR pc.completed_assessments <> COUNT(ms.id) FILTER (WHERE ms.status = 'completed')
 ORDER BY pc.company_id, pc.id;
```

**Interpretation:** `COUNT_MISMATCH`.

---

### Q-04 — Cancelled contracts with a positive balance

```sql
SELECT company_id, id, contract_number, status, remaining_balance,
       total_prepaid_amount, updated_at
  FROM printing_contracts
 WHERE status = 'cancelled'
   AND remaining_balance > 0
 ORDER BY company_id, id;
```

**Interpretation:** `CANCELLED_WITH_BALANCE` — requires refund/forfeit or a documented write-off.

---

### Q-05 — Completed/exhausted contracts with a credit balance

```sql
SELECT company_id, id, contract_number, status, remaining_balance,
       total_prepaid_amount, completed_assessments, total_assessments
  FROM printing_contracts
 WHERE status IN ('completed','exhausted')
   AND remaining_balance > 0
 ORDER BY company_id, id;
```

**Interpretation:** `CREDIT_BALANCE` — D-05 says the balance stays attached; confirm whether refund/forfeit/renewal is required.

---

### Q-06 — Missing deposit journal

```sql
SELECT company_id, id, contract_number, status, total_prepaid_amount,
       deposit_journal_txn_id
  FROM printing_contracts
 WHERE deposit_journal_txn_id IS NULL
 ORDER BY company_id, id;
```

**Interpretation:** `MISSING_JOURNAL`. For legacy contracts created before the journal link, confirm whether the deposit was recorded elsewhere.

---

### Q-07 — Deposit journal without a bank-subledger row

```sql
SELECT pc.company_id,
       pc.id,
       pc.contract_number,
       pc.deposit_journal_txn_id,
       j.entry_number,
       j.txn_date,
       j.description
  FROM printing_contracts pc
  JOIN journal_transactions j
    ON j.company_id = pc.company_id
   AND j.id = pc.deposit_journal_txn_id
  LEFT JOIN bank_transactions bt
    ON bt.company_id = pc.company_id
   AND bt.journal_txn_id = pc.deposit_journal_txn_id
 WHERE pc.deposit_journal_txn_id IS NOT NULL
   AND bt.id IS NULL
 ORDER BY pc.company_id, pc.id;
```

**Interpretation:** `MISSING_BANK_ROW` — the GL has the deposit but the bank register does not. Requires a controlled bank-subledger insert after approval.

---

### Q-08 — Orphaned contract bank references

```sql
SELECT bt.company_id,
       bt.id,
       bt.txn_date,
       bt.txn_type,
       bt.amount,
       bt.ref_number,
       bt.journal_txn_id,
       bt.memo
  FROM bank_transactions bt
 WHERE bt.ref_number LIKE 'CTR-%'
   AND NOT EXISTS (
     SELECT 1
       FROM printing_contracts pc
      WHERE pc.company_id = bt.company_id
        AND pc.contract_number = bt.ref_number
   )
 ORDER BY bt.company_id, bt.id;
```

**Interpretation:** `ORPHAN_BANK_REF` — a bank row references a contract number that no longer exists. Do not delete; investigate.

---

### Q-09 — Malformed contract numbers

```sql
SELECT company_id, id, contract_number, status
  FROM printing_contracts
 WHERE contract_number !~ '^CTR-[0-9]{4}-[0-9]+$'
 ORDER BY company_id, id;
```

**Interpretation:** `MALFORMED_NUMBER`. Report only; never renumber historical rows.

---

### Q-10 — Malformed exam-paper numbers

```sql
SELECT company_id, id, job_number, status
  FROM exam_papers
 WHERE job_number !~ '^EXM-[0-9]{4}-[0-9]+$'
 ORDER BY company_id, id;
```

**Interpretation:** `MALFORMED_NUMBER`.

---

### Q-11 — Duplicate contract/exam numbers

```sql
SELECT company_id, contract_number, COUNT(*)
  FROM printing_contracts
 GROUP BY company_id, contract_number
 HAVING COUNT(*) > 1;

SELECT company_id, job_number, COUNT(*)
  FROM exam_papers
 GROUP BY company_id, job_number
 HAVING COUNT(*) > 1;
```

**Interpretation:** `DUPLICATE_NUMBER` (unique constraints should prevent; investigate if present).

---

### Q-12 — Missing or inactive liability/bank accounts

```sql
SELECT pc.company_id,
       pc.id,
       pc.contract_number,
       pc.liability_account_id,
       la.code AS liability_code,
       la.name AS liability_name,
       la.is_active AS liability_active,
       pc.deposit_bank_account_id,
       ba.code AS bank_code,
       ba.name AS bank_name,
       ba.is_active AS bank_active
  FROM printing_contracts pc
  LEFT JOIN accounts la
    ON la.company_id = pc.company_id AND la.id = pc.liability_account_id
  LEFT JOIN accounts ba
    ON ba.company_id = pc.company_id AND ba.id = pc.deposit_bank_account_id
 WHERE la.id IS NULL
    OR ba.id IS NULL
    OR la.is_active = FALSE
    OR ba.is_active = FALSE
 ORDER BY pc.company_id, pc.id;
```

**Interpretation:** `MISSING_ACCOUNT` / `INACTIVE_ACCOUNT`.

---

### Q-13 — Completed milestone without a journal

```sql
SELECT ms.company_id,
       ms.contract_id,
       ms.assessment_number,
       ms.status,
       ms.completed_date,
       ms.agreed_amount,
       ms.journal_txn_id
  FROM contract_assessment_milestones ms
 WHERE ms.status = 'completed'
   AND ms.journal_txn_id IS NULL
 ORDER BY ms.company_id, ms.contract_id, ms.assessment_number;
```

**Interpretation:** `MILESTONE_COMPLETED_NO_JOURNAL`.

---

### Q-14 — Journal without completed milestone

```sql
SELECT ms.company_id,
       ms.contract_id,
       ms.assessment_number,
       ms.status,
       ms.agreed_amount,
       ms.journal_txn_id
  FROM contract_assessment_milestones ms
 WHERE ms.journal_txn_id IS NOT NULL
   AND ms.status <> 'completed'
 ORDER BY ms.company_id, ms.contract_id, ms.assessment_number;
```

**Interpretation:** `MILESTONE_JOURNAL_NOT_COMPLETED`.

---

### Q-15 — Contracts with no milestones

```sql
SELECT pc.company_id, pc.id, pc.contract_number, pc.status,
       pc.total_assessments, pc.total_prepaid_amount
  FROM printing_contracts pc
 WHERE NOT EXISTS (
   SELECT 1 FROM contract_assessment_milestones ms
    WHERE ms.company_id = pc.company_id AND ms.contract_id = pc.id
 )
 ORDER BY pc.company_id, pc.id;
```

**Interpretation:** `NO_MILESTONES`.

---

### Q-16 — Invalid total assessments / remaining balance

```sql
SELECT company_id, id, contract_number, total_assessments,
       completed_assessments, remaining_balance, total_prepaid_amount
  FROM printing_contracts
 WHERE total_assessments NOT BETWEEN 2 AND 5
    OR completed_assessments < 0
    OR completed_assessments > total_assessments
    OR remaining_balance < 0
    OR remaining_balance > total_prepaid_amount
 ORDER BY company_id, id;
```

**Interpretation:** `INVALID_TOTAL_ASSESSMENTS` / `INVALID_REMAINING_BALANCE` (CHECKs should prevent; investigate if present).

---

### Q-17 — Assessment date outside contract window

```sql
SELECT ms.company_id,
       ms.contract_id,
       ms.assessment_number,
       ms.scheduled_date,
       pc.start_date,
       pc.end_date
  FROM contract_assessment_milestones ms
  JOIN printing_contracts pc
    ON pc.company_id = ms.company_id AND pc.id = ms.contract_id
 WHERE ms.scheduled_date < pc.start_date
    OR ms.scheduled_date > pc.end_date
 ORDER BY ms.company_id, ms.contract_id, ms.assessment_number;
```

**Interpretation:** `DATE_OUT_OF_RANGE`.

---

### Q-18 — Orphaned invoice links

```sql
SELECT pc.company_id,
       pc.id,
       pc.contract_number,
       pc.deposit_invoice_id
  FROM printing_contracts pc
 WHERE pc.deposit_invoice_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM invoices i
      WHERE i.company_id = pc.company_id AND i.id = pc.deposit_invoice_id
   );

SELECT ms.company_id,
       ms.contract_id,
       ms.assessment_number,
       ms.linked_invoice_id
  FROM contract_assessment_milestones ms
 WHERE ms.linked_invoice_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM invoices i
      WHERE i.company_id = ms.company_id AND i.id = ms.linked_invoice_id
   );
```

**Interpretation:** `ORPHAN_INVOICE_LINK`.

---

### Q-19 — Deposit journal source mismatch

```sql
SELECT pc.company_id,
       pc.id,
       pc.contract_number,
       pc.deposit_journal_txn_id,
       j.source_type,
       j.source_id,
       j.reference
  FROM printing_contracts pc
  JOIN journal_transactions j
    ON j.company_id = pc.company_id AND j.id = pc.deposit_journal_txn_id
 WHERE j.source_type <> 'printing_contract'
    OR j.source_id <> pc.id
 ORDER BY pc.company_id, pc.id;
```

**Interpretation:** `DEPOSIT_JOURNAL_SOURCE_MISMATCH`.

---

### Q-20 — Bank rows with a contract reference but no journal link

```sql
SELECT bt.company_id,
       bt.id,
       bt.txn_date,
       bt.txn_type,
       bt.amount,
       bt.ref_number,
       bt.journal_txn_id
  FROM bank_transactions bt
 WHERE bt.ref_number LIKE 'CTR-%'
   AND bt.journal_txn_id IS NULL
 ORDER BY bt.company_id, bt.id;
```

**Interpretation:** `BANK_ROW_NO_JOURNAL`.

---

### Q-21 — Currency mismatch (after `currency_code` exists)

```sql
SELECT pc.company_id,
       pc.id,
       pc.contract_number,
       pc.currency_code,
       c.base_currency
  FROM printing_contracts pc
  JOIN companies c ON c.id = pc.company_id
 WHERE pc.currency_code IS DISTINCT FROM c.base_currency
 ORDER BY pc.company_id, pc.id;
```

**Interpretation:** `CURRENCY_MISMATCH` — only after the currency column is added.

---

## 5. Exception Taxonomy

| Code | Meaning | Typical treatment |
|---|---|---|
| `ALLOCATION_OVER` | Milestone sum > prepaid | Finance adjustment; reduce agreed amounts or increase prepaid with approval |
| `ALLOCATION_UNDER` | Milestone sum < prepaid | Confirm intentional unallocated credit; document |
| `CREDIT_BALANCE` | Completed/exhausted with balance > 0 | D-05: keep attached; refund/forfeit/renew per policy |
| `BALANCE_MISMATCH` | Remaining ≠ prepaid − completed | Finance adjustment; audit |
| `COUNT_MISMATCH` | Stored counts ≠ actual rows | Trigger reconciliation; audit |
| `CANCELLED_WITH_BALANCE` | Cancelled with balance > 0 | Refund/forfeit or write-off; audit |
| `MISSING_JOURNAL` | No deposit journal | Investigate; reconstruct or document |
| `MISSING_BANK_ROW` | Journal without bank row | Controlled bank-subledger insert; audit |
| `ORPHAN_BANK_REF` | Bank row references missing contract | Investigate; do not delete |
| `MALFORMED_NUMBER` | Number outside `CTR-YYYY-NN` / `EXM-YYYY-NNNN` | Report only; never renumber |
| `DUPLICATE_NUMBER` | Duplicate contract/exam number | Investigate; unique constraint should prevent |
| `MISSING_ACCOUNT` | Liability/bank account missing | Configure account; audit |
| `INACTIVE_ACCOUNT` | Liability/bank account inactive | Reactivate or reassign; audit |
| `MILESTONE_COMPLETED_NO_JOURNAL` | Completed without journal | Reconstruct or reverse; finance approval |
| `MILESTONE_JOURNAL_NOT_COMPLETED` | Journal without completed status | Investigate; correct status or reverse |
| `NO_MILESTONES` | Contract with no assessments | Add or cancel; business decision |
| `INVALID_TOTAL_ASSESSMENTS` | Count outside 2..5 | Trigger reconciliation; audit |
| `INVALID_REMAINING_BALANCE` | Balance < 0 or > prepaid | Finance adjustment; audit |
| `DATE_OUT_OF_RANGE` | Assessment outside contract window | Amend dates with audit |
| `ORPHAN_INVOICE_LINK` | Invoice link missing | Clear link with audit |
| `DEPOSIT_JOURNAL_SOURCE_MISMATCH` | Journal source not contract | Investigate |
| `BANK_ROW_NO_JOURNAL` | Bank row without journal | Link or reverse; audit |
| `CURRENCY_MISMATCH` | Contract currency ≠ company currency | Backfill/correct with approval |

---

## 6. Reconciliation Methodology

1. **Snapshot:** run all queries in a single read-only transaction; export CSV.
2. **Normalize:** convert numeric values to 4 dp; classify each row.
3. **Quantify:** sum absolute amounts per exception class; identify balance-sheet and P&L impact.
4. **Review:** finance and business review each exception.
5. **Approve:** D-12 sign-off with a remediation plan.
6. **Remediate:** controlled, audited transactions; one exception class at a time.
7. **Verify:** re-run the same queries; target zero unexplained exceptions.
8. **Certify:** attach the before/after reports to `FINAL-CERTIFICATION.md`.

---

## 7. Reporting Format

`legacy-preflight-report-YYYY-MM-DD.csv`:

```
company_id,exception_code,record_type,record_id,contract_number,field,stored_value,expected_value,variance_amount,currency,recommended_treatment,status
```

Summary report:

```
Total exceptions: N
By class:
  ALLOCATION_OVER: N (amount X)
  CREDIT_BALANCE: N (amount Y)
  ...
By company:
  ...
```

---

## 8. Approval Workflow (D-12)

| Step | Owner | Output |
|---|---|---|
| 1. Run preflight | DBA/Engineer | Read-only CSV |
| 2. Classify | Finance | Exception report |
| 3. Quantify | Finance | Financial impact |
| 4. Propose treatment | Finance/Business | Remediation plan |
| 5. Approve | Business owner + Finance | Signed approval |
| 6. Backup | DBA | Verified backup |
| 7. Execute | Engineer | Controlled, audited transactions |
| 8. Verify | Finance | Zero-unexplained report |
| 9. Certify | Finance | Sign-off |

**No remediation may run without step 5.**

---

## 9. Remediation Strategy

### 9.1 Principles

- One exception class at a time.
- Every change is audited (`audit_log` action `LEGACY_CONTRACT_REMEDIATION`).
- Every change has a before/after value and an approval reference.
- No change to historical contract/exam numbers.
- No change to historical currency.
- No journal reversal without finance approval.
- Re-run the preflight after each class.

### 9.2 Roll-forward

- Apply fixes as new data changes, not schema rollbacks.
- If a fix is wrong, apply a correcting entry with a new audit record.
- Never use a destructive down migration on production.

### 9.3 Backup and restore

- Full backup before remediation.
- Restore procedure documented and tested.
- Point-in-time recovery if available.

---

## 10. Test Scenarios

| Scenario | Expected |
|---|---|
| Clean seeded DB | Zero exceptions |
| Seed `ALLOCATION_OVER` | Detected with amount |
| Seed `CREDIT_BALANCE` | Detected |
| Seed `MISSING_BANK_ROW` | Detected |
| Seed malformed number | Reported, not cast |
| Seed duplicate number | Detected (if constraint allows) |
| Rerun preflight | Same results; no mutation |
| Read-only enforcement | UPDATE/DELETE fail |
| Remediation without approval | Blocked by process |
| Remediation with approval | Audit records; re-run zero |

---

## 11. Acceptance Criteria

- [ ] All queries are read-only and documented.
- [ ] Every exception class is defined.
- [ ] The report format is reproducible.
- [ ] D-12 approval is required before any change.
- [ ] No automatic historical correction.
- [ ] Backup/restore is documented.
- [ ] Re-run after remediation shows zero unexplained exceptions.

---

## 12. Conclusion

The preflight is a read-only, evidence-driven process. It must be executed against a database backup/standby or a read-only replica, classified by finance, approved under D-12, and remediated only through controlled audited changes. The queries in this document are design references; they must be validated against the live schema and data before execution.