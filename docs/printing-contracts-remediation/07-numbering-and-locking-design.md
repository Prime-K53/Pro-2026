# 07 — Numbering and Locking Design (Stage 2)

**Date:** 2026-11-19
**Covers:** MIG-01 (number format), MIG-02 (trigger locking/deadlocks), MIG-09 (exam backfill)
**Mode:** Documentation only — no migration or code changed

---

## 1. Executive Summary

The existing numbering is **not** a per-year sequence. It is a **global per-company sequence** with the year embedded as a label:

- Contracts: `CTR-YYYY-NN`, `seq = MAX(contract_number) + 1` across all years (`printingRecordsService.ts:135-140`).
- Exams: `EXM-YYYY-NNNN`, `seq = MAX(job_number) + 1` across all years (`printingRecordsService.ts:323-327`, `342`).

The corrected design preserves that behaviour, uses a **numeric** company-scoped counter, treats the width as a **minimum** (natural overflow, no truncation), and backfills with `GREATEST` so reruns cannot regress.

The lock design establishes a strict order:

```
counter → parent contract → milestone → journal/bank → audit/request_keys
```

Every mutation path acquires locks in non-decreasing rank order. The only cross-order risk (renew) is fixed by generating the new number **before** locking the old contract.

---

## 2. MIG-01 — Number Format and Sequence

### 2.1 Verified current behaviour

| Item | Contract | Exam paper |
|---|---|---|
| Format | `CTR-YYYY-NN` | `EXM-YYYY-NNNN` |
| Code | `printingRecordsService.ts:140` | `printingRecordsService.ts:342` |
| Sequence source | `MAX(contract_number)` across all years (`135-139`) | `MAX(job_number)` across all years (`323-327`) |
| Minimum width | 2 | 4 |
| Unique constraint | `(company_id, contract_number)` (`0007:139`) | `(company_id, job_number)` (`0007:257`) |
| Year source | `new Date().getUTCFullYear()` | `new Date().getUTCFullYear()` |
| Counter table | None | None |

**Key conclusion:** the sequence is global per company, not reset each year. A per-year counter would change existing numbering behaviour. D-11 says "preserve existing format" and "avoid resetting counters"; the corrected design therefore uses a **global** counter.

### 2.2 Corrected counter table

```sql
CREATE TABLE printing_number_counters (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  scope      VARCHAR(32) NOT NULL
             CHECK (scope IN ('contract','exam_paper')),
  last_value INTEGER NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, scope)
);

ALTER TABLE printing_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE printing_number_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY p_printing_number_counters_isolation
  ON printing_number_counters
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));
```

### 2.3 Corrected function

```sql
CREATE OR REPLACE FUNCTION next_printing_number(
  p_company_id BIGINT,
  p_scope      TEXT,
  p_prefix     TEXT,
  p_min_width  INT
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_last    INT;
  v_current BIGINT;
BEGIN
  v_current := NULLIF(current_setting('app.current_company_id', true), '')::BIGINT;
  IF v_current IS NULL OR p_company_id IS DISTINCT FROM v_current THEN
    RAISE EXCEPTION 'PRINTING_NUMBER_COMPANY_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF p_scope NOT IN ('contract','exam_paper') THEN
    RAISE EXCEPTION 'PRINTING_NUMBER_INVALID_SCOPE' USING ERRCODE = 'P0001';
  END IF;
  IF p_prefix IS NULL OR p_prefix = '' THEN
    RAISE EXCEPTION 'PRINTING_NUMBER_INVALID_PREFIX' USING ERRCODE = 'P0001';
  END IF;
  IF p_min_width IS NULL OR p_min_width < 1 OR p_min_width > 10 THEN
    RAISE EXCEPTION 'PRINTING_NUMBER_INVALID_WIDTH' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO printing_number_counters (company_id, scope, last_value)
  VALUES (p_company_id, p_scope, 1)
  ON CONFLICT (company_id, scope)
  DO UPDATE SET last_value = printing_number_counters.last_value + 1,
                updated_at = NOW()
  RETURNING last_value INTO v_last;

  RETURN p_prefix || LPAD(v_last::TEXT, p_min_width, '0');
END;
$$;
```

**Natural overflow:** `LPAD(100, 2, '0')` → `'100'`. No truncation, no exception. The `VARCHAR(64)` columns accommodate growth.

**Year:** the caller builds the prefix with the company-local year:

```ts
const year = await companyYear(tx, companyId); // from companies.timezone
const number = await next_printing_number(tx, companyId, 'contract', `CTR-${year}-`, 2);
```

For exams:

```ts
const number = await next_printing_number(tx, companyId, 'exam_paper', `EXM-${year}-`, 4);
```

### 2.4 Backfill

**Contracts:**

```sql
INSERT INTO printing_number_counters (company_id, scope, last_value)
SELECT pc.company_id,
       'contract',
       MAX(CAST(split_part(pc.contract_number, '-', 3) AS INTEGER))
  FROM printing_contracts pc
 WHERE pc.contract_number ~ '^CTR-[0-9]{4}-[0-9]+$'
 GROUP BY pc.company_id
ON CONFLICT (company_id, scope)
DO UPDATE SET last_value = GREATEST(
  printing_number_counters.last_value,
  EXCLUDED.last_value
);
```

**Exams:**

```sql
INSERT INTO printing_number_counters (company_id, scope, last_value)
SELECT p.company_id,
       'exam_paper',
       MAX(CAST(split_part(p.job_number, '-', 3) AS INTEGER))
  FROM exam_papers p
 WHERE p.job_number ~ '^EXM-[0-9]{4}-[0-9]+$'
 GROUP BY p.company_id
ON CONFLICT (company_id, scope)
DO UPDATE SET last_value = GREATEST(
  printing_number_counters.last_value,
  EXCLUDED.last_value
);
```

**Malformed numbers (report, do not cast):**

```sql
SELECT company_id, contract_number
  FROM printing_contracts
 WHERE contract_number !~ '^CTR-[0-9]{4}-[0-9]+$';

SELECT company_id, job_number
  FROM exam_papers
 WHERE job_number !~ '^EXM-[0-9]{4}-[0-9]+$';
```

**Duplicate check (unique constraint should prevent, but verify):**

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

### 2.5 Numbering examples

| Existing last number | Next | Notes |
|---|---|---|
| `CTR-2025-09` | `CTR-2026-10` | Global sequence; year label changes |
| `CTR-2026-99` | `CTR-2026-100` | Natural overflow, no truncation |
| `CTR-2026-999` | `CTR-2026-1000` | Natural overflow |
| `EXM-2025-0099` | `EXM-2026-0100` | Global sequence; 4-digit minimum |
| `EXM-2026-9999` | `EXM-2026-10000` | Natural overflow, no truncation |

**Rejected alternative:** per-year reset (`CTR-2026-01` after `CTR-2025-09`). This changes existing behaviour and is not approved by D-11.

---

## 3. MIG-09 — Exam-Paper Numbering Backfill

### 3.1 Verified format

- `EXM-YYYY-NNNN`, 4-digit minimum (`printingRecordsService.ts:342`).
- `MAX(job_number)+1` across all years (`323-327`).
- Unique `(company_id, job_number)` (`0007:257`).
- No counter table.

### 3.2 Backfill requirements

1. **Inspect historical numbers:** list all `EXM-` numbers, grouped by year and sequence.
2. **Identify valid combinations:** regex `^EXM-[0-9]{4}-[0-9]+$`.
3. **Identify malformed:** regex fail; report, do not cast.
4. **Identify duplicates:** group by `(company_id, job_number)`; unique constraint should prevent.
5. **Determine maximum existing sequence:** `MAX(CAST(split_part(job_number,'-',3) AS INTEGER))`.
6. **Preserve historical references:** never renumber existing rows.
7. **Prevent counter regression:** `GREATEST` on conflict.
8. **Safe to rerun:** idempotent upsert.
9. **Handle overflow:** natural overflow at 10000; no truncation.
10. **Protect concurrent numbering:** `ON CONFLICT DO UPDATE ... RETURNING`.

### 3.3 Inspection queries

```sql
-- Distribution by year
SELECT company_id,
       split_part(job_number, '-', 2) AS year,
       COUNT(*) AS papers,
       MIN(CAST(split_part(job_number, '-', 3) AS INTEGER)) AS min_seq,
       MAX(CAST(split_part(job_number, '-', 3) AS INTEGER)) AS max_seq
  FROM exam_papers
 WHERE job_number ~ '^EXM-[0-9]{4}-[0-9]+$'
 GROUP BY company_id, split_part(job_number, '-', 2)
 ORDER BY company_id, year;

-- Malformed
SELECT company_id, id, job_number
  FROM exam_papers
 WHERE job_number !~ '^EXM-[0-9]{4}-[0-9]+$';

-- Duplicates
SELECT company_id, job_number, COUNT(*)
  FROM exam_papers
 GROUP BY company_id, job_number
 HAVING COUNT(*) > 1;
```

### 3.4 Backfill (rerunnable)

```sql
INSERT INTO printing_number_counters (company_id, scope, last_value)
SELECT p.company_id,
       'exam_paper',
       MAX(CAST(split_part(p.job_number, '-', 3) AS INTEGER))
  FROM exam_papers p
 WHERE p.job_number ~ '^EXM-[0-9]{4}-[0-9]+$'
 GROUP BY p.company_id
ON CONFLICT (company_id, scope)
DO UPDATE SET last_value = GREATEST(
  printing_number_counters.last_value,
  EXCLUDED.last_value
);
```

### 3.5 Acceptance tests

| Test | Expected |
|---|---|
| 9,999 existing papers | Next is `EXM-YYYY-10000` |
| Rerun backfill | `last_value` unchanged |
| Malformed number | Reported; not cast; not counted |
| Duplicate number | Reported; unique constraint prevents |
| 20 concurrent exam batches | 20 unique numbers |
| Rollback | Counter increment rolled back; gap acceptable; no duplicate |

---

## 4. MIG-02 — Lock Ordering and Deadlock Analysis

### 4.1 Lock ranks

All locks are acquired in non-decreasing rank order:

| Rank | Resource | Lock |
|---:|---|---|
| 1 | Number counter row | `INSERT ... ON CONFLICT DO UPDATE` (row lock) |
| 2 | Parent contract row | `SELECT ... FOR UPDATE` |
| 3 | Milestone rows | `SELECT ... FOR UPDATE` or `INSERT`/`UPDATE`/`DELETE` |
| 4 | Journal / bank rows | `INSERT` (FK locks) |
| 5 | Audit / request_keys | `INSERT`/`UPDATE` |

**Rule:** never acquire a lower-rank lock while holding a higher-rank lock.

### 4.2 Path-by-path lock order

| Path | Acquired order | Correct? | Correction |
|---|---|---|---|
| `createPrintingContract` (draft) | counter → contract insert → milestone inserts → audit | **Yes** (after counter design) | Use `next_printing_number` before insert |
| `activatePrintingContract` | contract FOR UPDATE → journal → bank → contract update → audit | **Yes** | Ensure contract lock first |
| `amendPrintingContract` | contract FOR UPDATE → milestone reads → contract update → audit | **Yes** | Add parent lock |
| `setPrintingContractStatus` (cancel/complete/activate) | contract FOR UPDATE → journal/bank → contract update → audit | **Yes** | Ensure settlement columns |
| `renewPrintingContract` | **old contract FOR UPDATE → counter** | **No** | Generate new number **before** old contract lock |
| `addContractAssessment` | contract FOR UPDATE → milestone insert → count trigger → audit | **Yes** | Trigger locks parent again (re-lock is fine) |
| `removeContractAssessment` | contract FOR UPDATE → milestone delete → count trigger → audit | **Yes** | Add status check |
| `updateContractAssessment` | **milestone FOR UPDATE only** | **No** | Lock parent contract first |
| `completeContractAssessment` | contract FOR UPDATE → milestone FOR UPDATE → journal → milestone update → contract update → audit | **Yes** | No clamp; set `completed` |
| `createExamBatch` | counter → batch insert → paper inserts → audit | **Yes** | If linking contract, contract lock after counter |
| `updateExamPaperStatus` | paper FOR UPDATE → paper update → audit | **Yes** | Transition table |
| `deleteExamPaper` | paper FOR UPDATE → delete → audit | **Yes** | Map 23503 |
| `topUpContract` | contract FOR UPDATE → journal → bank → contract update → audit | **Yes** | New service |
| `generateInvoiceFromWorkflow` | contract/milestone read → invoice insert → journal → milestone link → audit | **Yes** | No counter |
| `linkContractDepositInvoice` | contract FOR UPDATE → contract update → audit | **Yes** | New service |

### 4.3 Deadlock cycles and fixes

**Cycle 1: Renew vs Create**

- Old: `renew` locks old contract (rank 2), then calls `create` which locks counter (rank 1) → inversion.
- New: `renew` calls `next_printing_number` (rank 1) **before** locking the old contract (rank 2). No cycle.

**Cycle 2: Update vs Complete**

- Old: `update` locks milestone (rank 3) without parent; `complete` locks contract (rank 2) then waits for milestone → potential deadlock.
- New: `update` locks parent contract (rank 2) first, then milestone (rank 3). No cycle.

**Cycle 3: Trigger at commit vs service**

- A deferred trigger tries to lock the parent (rank 2) while the service holds a milestone (rank 3).
- New: the service always locks the parent first. The trigger's `FOR UPDATE` is a re-lock of a row the transaction already holds; no cycle.

**Cycle 4: Direct SQL**

- Direct SQL that locks a milestone before the parent can deadlock with a service transaction.
- Mitigation: triggers use parent-first; document that direct DML on these tables is unsupported for financial workflows. Optionally revoke direct DML from `pms_app_role` and require service functions.

### 4.4 Trigger execution order

- `BEFORE INSERT/DELETE/UPDATE` triggers run before the row change and can lock the parent.
- `AFTER ... DEFERRABLE INITIALLY DEFERRED` triggers run at commit and re-lock the parent.
- All trigger functions must:
  1. Resolve the contract id.
  2. `SELECT ... FROM printing_contracts WHERE company_id=$1 AND id=$2 FOR UPDATE`.
  3. Recompute the invariant.
  4. Raise or update.
- Do not use `SELECT ... FOR SHARE`; use `FOR UPDATE` for mutations.

### 4.5 Concurrent scenarios

| Scenario | Expected |
|---|---|
| 20 concurrent creates | 20 unique numbers; 20 contracts |
| 10 concurrent activates on same draft | One success; nine 409 |
| 10 concurrent completes on same milestone | One success; nine 409/replay |
| 10 concurrent renews on same contract | One new contract; nine 409 |
| 10 concurrent top-ups on same contract | Serialized; total correct; one bank row each |
| 2 concurrent edits to different milestones | Both succeed |
| 2 concurrent edits to same milestone | One succeeds; one 409/40001 |
| 2 concurrent deletes of different pending milestones | Both succeed if count stays ≥2 |
| 2 concurrent deletes that would drop below 2 | One succeeds; one 409 |
| 2 concurrent cancels | One succeeds; one 409 |
| 2 concurrent completions of different assessments | Both succeed if balance covers both; otherwise one 409 |
| Direct SQL insert without count update | Deferred trigger reconciles at commit |
| Direct SQL delete of completed milestone | Trigger rejects |

---

## 5. Acceptance Criteria

- [ ] Contract numbers preserve `CTR-YYYY-NN` and 2-digit minimum.
- [ ] Exam numbers preserve `EXM-YYYY-NNNN` and 4-digit minimum.
- [ ] Natural overflow at 100/10000 works without truncation.
- [ ] Backfill is rerunnable and never regresses.
- [ ] Malformed numbers are reported, not cast.
- [ ] 20 concurrent creates produce 20 unique numbers.
- [ ] 10 concurrent completes produce one success.
- [ ] 10 concurrent renews produce one new contract.
- [ ] All paths lock counter → contract → milestone.
- [ ] `renew` generates the number before locking the old contract.
- [ ] `updateContractAssessment` locks the parent first.
- [ ] Trigger functions lock the parent first.
- [ ] No deadlock in the tested concurrency matrix.

---

## 6. Conclusion

The corrected numbering design preserves the existing global per-company sequence, uses a numeric counter with minimum-width formatting and natural overflow, and backfills safely. The lock design establishes a strict counter → contract → milestone order and fixes the two inversion paths (renew, update). The concurrency matrix must be executed in Phase D/E before implementation is certified.