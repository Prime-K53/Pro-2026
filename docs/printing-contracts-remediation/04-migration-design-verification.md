# 04 — Migration Design Verification (WP-00.3)

**Status:** Verification only. No migration file was created or applied.
**Reviewed design:** `docs/printing-contracts-remediation/00-repository-verification.md` §10
**Repository head:** `0019_printing_smart_ops_and_pos.up.sql`
**Next available:** `0020`

---

## 1. Verification Result

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | Composite FKs reference valid unique composite keys | **PASS** | `invoices(company_id, id)` unique at `0003:151`; `journal_transactions(company_id, id)` unique at `0002:73`; `users(id)` is a global PK at `0001:81`; `accounts(company_id, id)` unique at `0002:38` |
| 2 | New tables follow RLS + FORCE conventions | **PASS** | `printing_number_counters` uses `ENABLE` + `FORCE` + `app_rls_allowed(company_id)` policy, matching `0007` and `0004` |
| 3 | Number counter function safe under concurrency | **PASS with guards** | `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is atomic per counter row; add company guard and width/overflow guard |
| 4 | Existing contract/exam numbers backfill without ambiguity | **PASS with corrections** | Backfill from number strings, not `start_date`; exam backfill missing in draft; preserve existing widths |
| 5 | Allocation trigger prevents concurrent over-allocation | **FAIL as drafted** | Trigger alone can deadlock; service must lock parent first. See MIG-02 |
| 6 | Trigger correct for INSERT / UPDATE / DELETE | **PARTIAL** | Covers insert/delete; `UPDATE OF agreed_amount` misses `contract_id`/`company_id`. See MIG-03 |
| 7 | Parent total and milestone changes cannot bypass invariant | **PASS with caveats** | Both triggers present; 40001 retry and count invariants need work. See MIG-04, MIG-12, MIG-13 |
| 8 | Compatible with PGlite migration harness | **NOT YET PROVEN** | Must run 0020 on disposable PGlite DB. Standard Postgres features, but constraint triggers must be exercised. See MIG-14 |
| 9 | Production recovery does not depend on destructive rollback | **PASS with procedure** | Roll-forward + backup/restore; down only on disposable DBs. See §6 |

**Overall:** The migration direction is sound, but **five high-severity design defects** must be corrected before writing 0020.

---

## 2. Defects in the Proposed SQL

### MIG-01 — HIGH — Identifier width change breaks the existing number format

**Draft plan:** `next_printing_number(..., 'CTR-', 4)` and `('EXM-', 5)`.
**Current format:**
- Contracts: `CTR-YYYY-NN` — 2-digit sequence (`printingRecordsService.ts:140`, `String(seq).padStart(2, '0')`).
- Exam papers: `EXM-YYYY-NNNN` — 4-digit sequence (`printingRecordsService.ts:342`, `padStart(4, '0')`).

**Impact:** A 4-digit contract number (`CTR-2026-0001`) is not the same format as the existing `CTR-2026-01`. It may break user expectations, exports, and any downstream parsing. Changing the format without a data migration/communication plan is unsafe.

**Required correction:**
- Preserve the existing widths: **2 for contracts, 4 for exam papers**.
- If the business wants wider numbers, treat it as a separate, approved format migration with a mapping table and communication.
- The overflow guard must fail safely when the existing width is exhausted (e.g., after 99 contracts in a year). Do not silently truncate or widen.

**Evidence:** `printingRecordsService.ts:140`, `342`; `0007:121` (`VARCHAR(64)`), `0007:238`.

---

### MIG-02 — HIGH — Allocation trigger alone can deadlock; service lock order is mandatory

**Draft trigger:**
```sql
SELECT total_prepaid_amount INTO v_total
  FROM printing_contracts
 WHERE company_id = ... AND id = v_contract_id
 FOR UPDATE;
```
This runs in a **deferred constraint trigger at COMMIT**.

**Deadlock scenario:**
1. Transaction A locks milestone M (e.g., `UPDATE contract_assessment_milestones ... FOR UPDATE`) and then, at commit, tries to lock parent contract C.
2. Transaction B locks parent contract C (`SELECT ... FOR UPDATE`) and then tries to update milestone M.
3. A waits for C; B waits for M → deadlock.

**Required correction:**
- **All milestone mutations must lock the parent contract first**, in this order:
  1. `SELECT ... FROM printing_contracts WHERE company_id=$1 AND id=$2 FOR UPDATE`
  2. then read/insert/update/delete the milestone.
- The trigger remains as defence-in-depth, not as the primary lock.
- Add a concurrency test with two transactions updating different milestones of the same contract and two transactions updating the same milestone.

**Current service state:**
- `addContractAssessment` locks the parent (`printingRecordsService.ts:728`). Good.
- `removeContractAssessment` locks the parent (`798`). Good.
- `updateContractAssessment` does **not** lock the parent (`845`). Must fix.
- `amendPrintingContract` does **not** lock the parent (`575`). Must fix.
- `completeContractAssessment` locks the parent (`941`). Good.

---

### MIG-03 — MEDIUM — Trigger misses `contract_id` / `company_id` updates

**Draft trigger:**
```sql
AFTER INSERT OR UPDATE OF agreed_amount OR DELETE
```
If a milestone is moved to another contract or company, the allocation sums of both the old and new contract change, but the trigger does not fire.

**Required correction:**
- Use `AFTER INSERT OR UPDATE OR DELETE` (all updates), or explicitly `UPDATE OF agreed_amount, contract_id, company_id`.
- Better: **block cross-contract moves in the service**. A milestone belongs to one contract; moving it is not a normal business operation.
- Add a test that directly updates `contract_id` and confirms the invariant is checked.

---

### MIG-04 — HIGH — Trigger does not maintain `total_assessments` / `completed_assessments`

**Current schema:**
- `printing_contracts.total_assessments` is manually maintained by the service (`printingRecordsService.ts:773-776`, `819-822`).
- `CHECK (completed_assessments <= total_assessments)` at `0007:150`.

**Problem:** Direct SQL can insert/delete milestones without updating the parent counts. The allocation trigger checks only `SUM(agreed_amount)`, not counts. Direct SQL can therefore create `completed_assessments > total_assessments` or `total_assessments` outside 2..5 without the parent row being updated.

**Required correction (choose one):**
1. **Preferred:** Add `BEFORE INSERT OR DELETE` triggers on `contract_assessment_milestones` that update `printing_contracts.total_assessments` and validate the CHECK atomically.
2. **Alternative:** Document that direct SQL is unsupported; enforce through a DB role that denies direct DML on these tables and only allows service functions. This is harder in the current app role.
3. **Minimum:** Add a trigger that rejects deleting a completed milestone directly and rejects inserting a milestone when it would exceed 5 or fall below 2.

**Also:** Add a trigger/constraint to keep `completed_assessments` consistent with `COUNT(*) WHERE status='completed'`. At minimum, add a reconciliation query to Phase D preflight.

---

### MIG-05 — MEDIUM — Pending idempotency state is a convention, not schema

**Draft:** Use `request_keys.status_code = 202` and `response_json IS NULL` as "pending".

**Schema reality (`0001:281-297`):**
- `status_code INTEGER NOT NULL` — 202 is allowed.
- `response_json JSONB` nullable — NULL is allowed.
- No `status`/`completed_at` column.

**Problem:** Existing `checkRouteIdempotency` treats any row as a replay and returns `{status, body}`. If it returns `{status: 202, body: null}`, callers may try to use a null body. The route must explicitly handle 202 as "in progress" and return 409/425.

**Required correction:**
- Add a shared helper that returns a discriminated result:
  - `{ kind: 'replay', status, body }`
  - `{ kind: 'in_progress' }`
  - `{ kind: 'conflict' }`
  - `{ kind: 'new' }`
- Update every caller to handle `in_progress`.
- Optionally add `claimed_at TIMESTAMPTZ` and `completed_at TIMESTAMPTZ` columns to make pending state explicit and observable. This is a schema addition; decide in Phase D.

---

### MIG-06 — MEDIUM — `currency_code` is correct, but service changes are a hard dependency

**Draft:** Add nullable `currency_code CHAR(3)`, backfill from `companies.base_currency`, then `SET NOT NULL`.

**Assessment:** The SQL is correct. However:
- Every insert path (`createPrintingContract`, `renewPrintingContract`, any seed/test insert) must set `currency_code` from `companies.base_currency`.
- `CHAR(3)` is consistent with `companies.base_currency CHAR(3)` (`0001:59`); keep it.
- Preflight must confirm no company has `base_currency IS NULL` (it is `NOT NULL`).
- The contract preview must stop hardcoding `'ZMW'` (`documentsService.ts:1184`) and use the contract/company currency.

**Required correction:** No SQL defect; add a Phase A service dependency and a Phase C document-template fix.

---

### MIG-07 — MEDIUM — Settlement columns lack consistency CHECKs

**Draft:**
```sql
settlement_mode VARCHAR(16) CHECK (settlement_mode IS NULL OR settlement_mode IN ('refund','forfeit')),
settled_amount NUMERIC(19,4) NOT NULL DEFAULT 0.0000 CHECK (settled_amount >= 0),
settlement_journal_txn_id BIGINT
```

**Missing:**
- `settlement_mode = 'refund'` should require `settled_amount > 0` and `settlement_journal_txn_id IS NOT NULL`.
- `settlement_mode = 'forfeit'` should require `settled_amount > 0` and `settlement_journal_txn_id IS NOT NULL`; no bank row.
- `settlement_mode IS NULL` should imply `settled_amount = 0` and `settlement_journal_txn_id IS NULL`.
- `settlement_mode` should only be set when `status = 'cancelled'`.

**Required correction:** Add a `CHECK` constraint or enforce in the service with a test. A DB CHECK is stronger:
```sql
CHECK (
  (settlement_mode IS NULL AND settled_amount = 0 AND settlement_journal_txn_id IS NULL)
  OR
  (settlement_mode IN ('refund','forfeit') AND settled_amount > 0 AND settlement_journal_txn_id IS NOT NULL)
)
```

---

### MIG-08 — MEDIUM — Cancellation metadata consistency

**Draft:** Adds `cancelled_at`, `cancelled_by`, `cancellation_reason`.

**Missing:**
- `status = 'cancelled'` should imply `cancelled_at IS NOT NULL`.
- `status <> 'cancelled'` should imply `cancelled_at IS NULL` and `settlement_mode IS NULL`.

**Required correction:**
- Backfill `cancelled_at = updated_at` for existing `status = 'cancelled'` rows (documented assumption).
- Add a CHECK or enforce in the service.
- Do not add the CHECK until the backfill is verified; otherwise the migration fails on legacy rows.

---

### MIG-09 — HIGH — Exam-paper number backfill is missing

**Draft:** Only contract backfill is shown.

**Current exam format:** `EXM-YYYY-NNNN` (`printingRecordsService.ts:342`), unique `(company_id, job_number)` (`0007:257`).

**Required correction:** Add:
```sql
INSERT INTO printing_number_counters (company_id, scope, year, last_value)
SELECT p.company_id,
       'exam_paper',
       CAST(split_part(p.job_number, '-', 2) AS SMALLINT),
       MAX(CAST(split_part(p.job_number, '-', 3) AS INTEGER))
  FROM exam_papers p
 WHERE p.job_number ~ '^EXM-[0-9]{4}-[0-9]+$'
 GROUP BY p.company_id, split_part(p.job_number, '-', 2);
```
- Report malformed exam numbers first.
- Replace the `MAX(job_number)` logic in `createExamBatch` with the counter.
- Preserve the 4-digit width.

---

### MIG-10 — LOW — `version` column is unused

**Draft:** Adds `version INTEGER NOT NULL DEFAULT 1`.

**Problem:** No service currently uses it. If it is not used, it is dead schema.

**Required correction (choose one):**
- Use it for optimistic concurrency: `UPDATE ... WHERE id=$1 AND version=$2`, increment `version`, and return 409 on mismatch.
- Or remove it from 0020 and add it later when the service uses it.

---

### MIG-11 — MEDIUM — Number function needs a company guard and safe error mapping

**Draft function:** `next_printing_number(p_company_id, ...)`.

**Problems:**
- If called with a `p_company_id` different from `app.current_company_id`, RLS may block it, but the error is opaque. Add an explicit guard.
- `RAISE EXCEPTION ... ERRCODE = '22001'` surfaces as a generic 500 unless mapped. Use a stable domain error (e.g., `PRINTING_NUMBER_OVERFLOW`) and map to 409/400.
- `p_prefix`/`p_width` need guards (`p_width > 0`, `p_prefix IS NOT NULL`).

**Required correction:**
```sql
IF p_company_id IS NULL OR p_company_id <> NULLIF(current_setting('app.current_company_id', true), '')::BIGINT THEN
  RAISE EXCEPTION 'PRINTING_NUMBER_COMPANY_MISMATCH' USING ERRCODE = 'P0001';
END IF;
```
Map `PRINTING_NUMBER_OVERFLOW` to a stable 409/400 response.

---

### MIG-12 — MEDIUM — `40001` serialization failures are not handled

**Problem:** Deferred constraint triggers at commit can raise `40001` (serialization_failure) when a concurrent transaction commits between the statement and the trigger. The current `handlePrintingError` maps `23505/23514/23001` but not `40001` (`printingRoutes.ts:56`).

**Required correction:**
- Map `40001` to 409 `SERIALIZATION_CONFLICT`.
- Retry contract mutations once or twice on 40001 at the service/route level.
- Add a concurrency test.

---

### MIG-13 — MEDIUM — Missing `remaining_balance` vs completed-assessment invariant

**Current invariant:** `remaining_balance = total_prepaid_amount - SUM(agreed_amount WHERE status='completed')`.

**Problem:** The DB CHECK only enforces `remaining_balance <= total_prepaid_amount` and `>= 0`. Direct SQL or a service bug can break the equation.

**Required correction:**
- Add a deferred trigger or a reconciliation query in Phase D preflight:
```sql
SELECT pc.id, pc.remaining_balance,
       pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0) AS expected_remaining
  FROM printing_contracts pc
  LEFT JOIN contract_assessment_milestones ms
    ON ms.company_id = pc.company_id AND ms.contract_id = pc.id AND ms.status = 'completed'
 GROUP BY pc.id, pc.remaining_balance, pc.total_prepaid_amount
HAVING pc.remaining_balance <> pc.total_prepaid_amount - COALESCE(SUM(ms.agreed_amount), 0);
```
- If the trigger is added, it must run after completion updates and lock the parent consistently.

---

### MIG-14 — MEDIUM — PGlite compatibility not yet proven

**Standard Postgres features used:** `CREATE CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, `plpgsql`, `FOR UPDATE`, `ON CONFLICT DO UPDATE ... RETURNING`, `LPAD`, `split_part`, regex `~`.

**Assessment:** Likely supported, but **must be proven** by applying 0020 to an in-memory PGlite DB in `tests/db/migration-suite.ts` before Phase A.

**Required correction:** Add a disposable migration test:
- Apply 0020.
- Insert a contract + milestones that satisfy the invariant.
- Insert a violating set and confirm the deferred trigger aborts at commit.
- Call `next_printing_number` 150 times and confirm uniqueness.
- Apply 0020 down on a disposable DB and confirm the schema returns to 0019.

---

### MIG-15 — HIGH — Legacy credit balances are not addressed by the migration

**Problem:** Existing contracts may have:
- `completed_assessments = total_assessments` and `remaining_balance > 0` (credit balance).
- `SUM(agreed_amount) <> total_prepaid_amount` (allocation mismatch).

**The migration triggers will not fix these; they will only prevent new ones.**

**Required correction:**
- Phase D preflight reports these rows.
- Business decision D-05 determines the treatment (refund/forfeit/carry forward).
- Do not enable strict constraints until the rows are reconciled or quarantined.
- Add a signed-off quarantine report.

---

### MIG-16 — LOW — `CHAR(3)` vs `VARCHAR(3)`

`companies.base_currency` is `CHAR(3)` (`0001:59`). Using `CHAR(3)` for `printing_contracts.currency_code` is consistent. Note that `CHAR(3)` pads with spaces; comparisons should use `TRIM` or rely on the fixed length. No change required; document.

---

### MIG-17 — LOW — Counter table constraints

Add:
```sql
CHECK (last_value >= 0),
CHECK (scope IN ('contract', 'exam_paper'))
```
or document allowed scopes. Minor.

---

### MIG-18 — LOW — Function parameter guards

Add:
```sql
IF p_width IS NULL OR p_width <= 0 OR p_width > 10 THEN
  RAISE EXCEPTION 'INVALID_PRINTING_NUMBER_WIDTH' USING ERRCODE = 'P0001';
END IF;
IF p_prefix IS NULL OR p_prefix = '' THEN
  RAISE EXCEPTION 'INVALID_PRINTING_NUMBER_PREFIX' USING ERRCODE = 'P0001';
END IF;
```

---

## 3. Verified-Correct Items

| Item | Evidence | Assessment |
|---|---|---|
| `deposit_invoice_id` composite FK | `invoices` unique `(company_id, id)` at `0003:151` | Correct |
| `settlement_journal_txn_id` composite FK | `journal_transactions` unique `(company_id, id)` at `0002:73` | Correct |
| `cancelled_by` / `completed_by` FK | `users(id)` global PK at `0001:81` | Correct |
| RLS + FORCE on counters | Matches `0007:157-161`, `0004:384-392` | Correct |
| Atomic counter increment | `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` | Correct under concurrency |
| Backfill from number strings | `split_part` + regex; avoids `start_date` ambiguity | Correct approach |
| Allocation trigger covers insert/delete | `AFTER INSERT OR UPDATE OF agreed_amount OR DELETE` | Partial (see MIG-03) |
| Parent total trigger | `AFTER UPDATE OF total_prepaid_amount` | Correct |
| Roll-forward recovery | Down only on disposable DBs | Correct |

---

## 4. Required Corrections Before Writing 0020

1. **MIG-01:** Preserve existing number widths (2 contracts, 4 exams); fail safely on overflow.
2. **MIG-02:** Mandate parent-first locking in every milestone mutation; add deadlock tests.
3. **MIG-04:** Decide how to keep `total_assessments` / `completed_assessments` consistent; add triggers or document direct-SQL prohibition.
4. **MIG-09:** Add exam-paper counter backfill and replace `MAX(job_number)`.
5. **MIG-15:** Add legacy-data preflight and D-05 sign-off before strict constraints.
6. **MIG-03, MIG-05, MIG-07, MIG-08, MIG-11, MIG-12, MIG-13, MIG-14:** Apply the specific corrections above.

---

## 5. Migration Test Plan (Phase D)

| Test | Purpose |
|---|---|
| 0020 up on empty PGlite | Schema applies cleanly |
| 0020 up on seeded legacy DB | Backfills, constraints, no data loss |
| 0020 down on disposable DB | Down script works; schema returns to 0019 |
| Insert contract + 4 milestones summing exactly | Accepted |
| Insert contract + 4 milestones summing > total | Rejected at commit |
| Insert milestone without parent lock (direct SQL) | Trigger rejects or deadlocks safely |
| Concurrent 20 creates | 20 unique numbers, no duplicates |
| Concurrent 20 completes on same milestone | Exactly 1 success, 19 conflicts |
| Concurrent top-ups on same contract | Serialized, totals correct |
| `next_printing_number` 150 calls | Unique, no overflow |
| Malformed legacy number | Reported, not silently cast |

---

## 6. Production Recovery Strategy (WP-00.3 item 9)

**Principle:** Production recovery must not depend on a destructive `.down.sql`.

1. **Before migration:** full database backup + tested restore.
2. **Apply 0020 up** in a maintenance window.
3. **If a defect is found after deployment:** write a new `0021_fix...up.sql` (roll-forward). Do **not** run 0020 down.
4. **Point of no return:** once 0020 is applied to production, the down script is prohibited. The only recovery paths are:
   - roll-forward fix migration;
   - restore from the pre-migration backup (with data loss since the backup).
5. **Down script usage:** disposable test DBs only.
6. **Backup/restore procedure:** documented in `FINAL-CERTIFICATION.md` with exact commands and RPO/RTO.

---

## 7. Conclusion

The proposed migration is **directionally correct but not ready to write**. Five high-severity defects (MIG-01, MIG-02, MIG-04, MIG-09, MIG-15) and several medium defects must be resolved. The migration must not be created until:
- D-01…D-10 are approved;
- the number-width decision is made;
- the legacy-data preflight is run;
- the PGlite constraint-trigger test is added;
- the idempotency claim protocol is implemented alongside it.