# 08 — Assessment Integrity Design (Stage 2)

**Date:** 2026-11-19
**Covers:** MIG-04 (assessment counts)
**Mode:** Documentation only — no migration or code changed

---

## 1. Executive Summary

`printing_contracts.total_assessments` and `completed_assessments` are currently maintained **manually by the service**:

- Add: `UPDATE printing_contracts SET total_assessments = total_assessments + 1` (`printingRecordsService.ts:773-776`).
- Remove: `... total_assessments - 1` (`819-822`).
- Complete: `... completed_assessments = $2` (`1016`).

This is unsafe because:

1. Direct SQL can insert/delete/update milestones without touching the parent counts.
2. A service bug or an interrupted transaction can leave the counts wrong.
3. The DB CHECK `completed_assessments <= total_assessments` (`0007:150`) only fails if the parent row is updated; a direct milestone delete does not update the parent, so the check is not evaluated.
4. Concurrent insert/delete can race with the manual `+1`/`-1`.

**Corrected design:** **trigger-owned counts**. The service stops maintaining counts; database triggers recompute them from the milestone rows after every insert, status change, or delete. A validation trigger rejects any attempt to set the counts incorrectly.

This is robust against direct SQL, concurrency, and service bugs.

---

## 2. Current Behaviour and Failure Modes

### 2.1 Current count maintenance

| Operation | Service code | Count update |
|---|---|---|
| Create contract | `printingRecordsService.ts:164-215` | Inserts `total_assessments` and `completed_assessments=0` |
| Add assessment | `721-789` | `total_assessments + 1` |
| Remove assessment | `791-835` | `total_assessments - 1` |
| Complete assessment | `933-1040` | `completed_assessments = nextCompleted` |
| Amend | `570-610` | None |
| Cancel/activate/renew | `612-705` | None |

### 2.2 Failure modes

| Failure | Example | Consequence |
|---|---|---|
| Direct SQL insert | `INSERT INTO contract_assessment_milestones ...` without updating parent | `total_assessments` too low; CHECK `completed <= total` may not fire |
| Direct SQL delete | `DELETE FROM contract_assessment_milestones ...` without updating parent | `total_assessments` too high; contract can never complete correctly |
| Direct SQL status update | `UPDATE ... SET status='completed'` without updating parent | `completed_assessments` too low; revenue not recognized; contract not completed |
| Concurrent add | Two transactions both read `total_assessments=2`, both `+1` | Lost update; count = 3 instead of 4 |
| Concurrent remove | Two transactions both `-1` | Lost update; count too low |
| Service bug | Completion updates milestone but not parent | Counts drift |
| Interrupted transaction | Partial commit (should not happen with one transaction, but possible with manual SQL) | Counts drift |

---

## 3. Options Analysis

| Option | Robust against direct SQL? | Complexity | Performance | Verdict |
|---|---|---|---|---|
| **A. Service-only counts** (current) | No | Low | Low | Rejected |
| **B. Trigger-owned counts** | Yes | Medium | Low (per milestone) | **Recommended** |
| **C. Recompute on read** (no stored counts) | Yes | Medium | Higher (aggregate per read) | Not chosen; counts are used in CHECK/UI |
| **D. Generated columns** | Not possible across tables | — | — | Rejected |

**Recommendation: Option B — trigger-owned counts.**

---

## 4. Trigger Design

### 4.1 Principles

- The **milestone triggers** are the only mechanism that changes `total_assessments` / `completed_assessments`.
- The service stops manual count updates.
- Every trigger that changes counts locks the parent contract first.
- A **validation trigger** on `printing_contracts` recomputes the expected counts and rejects a mismatch, so direct SQL cannot set wrong counts.
- Deferred triggers run at commit, so multi-row operations are consistent.
- `completed` milestone deletion is blocked.

### 4.2 `BEFORE INSERT` — count and range guard

```sql
CREATE OR REPLACE FUNCTION trg_milestone_before_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_count INT;
  v_parent_status VARCHAR(20);
BEGIN
  SELECT total_assessments, status
    INTO v_count, v_parent_status
    FROM printing_contracts
   WHERE company_id = NEW.company_id AND id = NEW.contract_id
   FOR UPDATE;

  IF v_parent_status = 'cancelled' THEN
    RAISE EXCEPTION 'CONTRACT_CANCELLED' USING ERRCODE = 'P0001';
  END IF;

  IF v_count >= 5 THEN
    RAISE EXCEPTION 'MAX_ASSESSMENTS' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.assessment_number < 1 OR NEW.assessment_number > 5 THEN
    RAISE EXCEPTION 'INVALID_ASSESSMENT_NUMBER' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_milestone_bi
  BEFORE INSERT ON contract_assessment_milestones
  FOR EACH ROW EXECUTE FUNCTION trg_milestone_before_insert();
```

### 4.3 `BEFORE DELETE` — minimum count and completed block

```sql
CREATE OR REPLACE FUNCTION trg_milestone_before_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_count INT;
BEGIN
  SELECT total_assessments
    INTO v_count
    FROM printing_contracts
   WHERE company_id = OLD.company_id AND id = OLD.contract_id
   FOR UPDATE;

  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'COMPLETED_ASSESSMENT_CANNOT_BE_DELETED' USING ERRCODE = 'P0001';
  END IF;

  IF v_count <= 2 THEN
    RAISE EXCEPTION 'MIN_ASSESSMENTS' USING ERRCODE = 'P0001';
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_milestone_bd
  BEFORE DELETE ON contract_assessment_milestones
  FOR EACH ROW EXECUTE FUNCTION trg_milestone_before_delete();
```

### 4.4 `BEFORE UPDATE OF status` — completed is terminal

```sql
CREATE OR REPLACE FUNCTION trg_milestone_before_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'completed' AND NEW.status <> 'completed' THEN
    RAISE EXCEPTION 'COMPLETED_ASSESSMENT_CANNOT_BE_REOPENED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_milestone_bu_status
  BEFORE UPDATE OF status ON contract_assessment_milestones
  FOR EACH ROW EXECUTE FUNCTION trg_milestone_before_status();
```

### 4.5 `AFTER` count reconciliation — deferred

```sql
CREATE OR REPLACE FUNCTION trg_milestone_reconcile_counts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_contract_id BIGINT;
  v_company_id  BIGINT;
  v_total       INT;
  v_completed   INT;
BEGIN
  v_contract_id := COALESCE(NEW.contract_id, OLD.contract_id);
  v_company_id  := COALESCE(NEW.company_id, OLD.company_id);

  PERFORM 1 FROM printing_contracts
   WHERE company_id = v_company_id AND id = v_contract_id
   FOR UPDATE;

  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE status = 'completed')
    INTO v_total, v_completed
    FROM contract_assessment_milestones
   WHERE company_id = v_company_id AND contract_id = v_contract_id;

  UPDATE printing_contracts
     SET total_assessments = v_total,
         completed_assessments = v_completed
   WHERE company_id = v_company_id AND id = v_contract_id;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_milestone_reconcile
  AFTER INSERT OR UPDATE OF status OR DELETE
  ON contract_assessment_milestones
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_milestone_reconcile_counts();
```

### 4.6 `AFTER UPDATE` validation on the parent

This rejects direct SQL that sets wrong counts:

```sql
CREATE OR REPLACE FUNCTION trg_contract_validate_counts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_total     INT;
  v_completed INT;
BEGIN
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE status = 'completed')
    INTO v_total, v_completed
    FROM contract_assessment_milestones
   WHERE company_id = NEW.company_id AND contract_id = NEW.id;

  IF NEW.total_assessments <> v_total OR NEW.completed_assessments <> v_completed THEN
    RAISE EXCEPTION 'ASSESSMENT_COUNT_MISMATCH: expected %/%, got %/%',
      v_total, v_completed, NEW.total_assessments, NEW.completed_assessments
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_contract_validate_counts
  AFTER UPDATE OF total_assessments, completed_assessments
  ON printing_contracts
  FOR EACH ROW EXECUTE FUNCTION trg_contract_validate_counts();
```

**Why this works:** the count reconciliation trigger updates the parent to the correct values before the validation trigger runs. Direct SQL that sets wrong counts fails the validation.

### 4.7 Service changes

- Remove manual count updates:
  - `printingRecordsService.ts:773-776` (add) — remove.
  - `819-822` (remove) — remove.
  - `1016` (`completed_assessments = $2`) — remove; the trigger recomputes.
- Keep `total_assessments` in the initial insert? The trigger will reconcile after the milestone inserts; the initial insert can set `0`, and the deferred trigger sets the correct count at commit. But the CHECK `total_assessments BETWEEN 2 AND 5` would fail if `0` is inserted and the trigger is deferred. Options:
  - Insert the contract with the correct `total_assessments` initially (from the input) and let the trigger reconcile; or
  - Make the count trigger `AFTER` but not deferred, so it runs before commit and updates the count; the CHECK on the parent is evaluated at the end of the statement, and the trigger updates within the same statement. For a multi-row insert of milestones, the trigger runs per row and updates the parent; the final count is correct. If the trigger is not deferred, it runs immediately after each row, so the parent count is updated before the next row. This avoids the `0` CHECK issue. But a deferred trigger is better for multi-row consistency. The initial contract insert can set `total_assessments` to the number of assessments being inserted (e.g., 4), so the CHECK passes. Then the milestone inserts happen; the deferred trigger reconciles to 4. Good.
  - For `draft` creation, the contract is inserted with the assessments in the same transaction; set `total_assessments` to the input count. The trigger reconciles.
- For activation, no count change.
- For completion, update milestone status; the trigger increments `completed_assessments`; the service updates `remaining_balance`/`status` (completed/exhausted) without touching counts.

### 4.8 Interaction with D-05/D-10

| Status | Counts | Allowed changes |
|---|---|---|
| `draft` | total = number of assessments; completed = 0 | Add/remove pending; amend; activate |
| `active` | total = current; completed = done | Add/remove pending; complete pending; cancel |
| `completed` | total = all; completed = all | No add/remove; no status change |
| `exhausted` | total = all; completed = all | No add/remove |
| `cancelled` | total = current; completed = done | No add/remove; no reactivation |

- `BEFORE INSERT` allows inserts on `draft` and `active`; rejects `completed`/`exhausted`/`cancelled`.
- `BEFORE DELETE` allows deletes on `draft` and `active` only for pending; rejects `completed` always.
- `BEFORE UPDATE OF status` allows pending→completed on `active` only; rejects completed→pending.
- Completion of the final assessment sets `status='completed'` (if balance > 0) or `'exhausted'` (if balance = 0), and `completed_assessments` is updated by the trigger.

### 4.9 Count reconciliation queries (read-only)

```sql
-- Count mismatches
SELECT pc.company_id, pc.id, pc.contract_number,
       pc.total_assessments, COUNT(ms.id) AS actual_total,
       pc.completed_assessments,
       COUNT(ms.id) FILTER (WHERE ms.status = 'completed') AS actual_completed
  FROM printing_contracts pc
  LEFT JOIN contract_assessment_milestones ms
    ON ms.company_id = pc.company_id AND ms.contract_id = pc.id
 GROUP BY pc.id, pc.total_assessments, pc.completed_assessments
HAVING pc.total_assessments <> COUNT(ms.id)
    OR pc.completed_assessments <> COUNT(ms.id) FILTER (WHERE ms.status = 'completed');

-- Completed assessments without a journal
SELECT ms.company_id, ms.contract_id, ms.assessment_number
  FROM contract_assessment_milestones ms
 WHERE ms.status = 'completed' AND ms.journal_txn_id IS NULL;

-- Journal without completed status
SELECT ms.company_id, ms.contract_id, ms.assessment_number
  FROM contract_assessment_milestones ms
 WHERE ms.journal_txn_id IS NOT NULL AND ms.status <> 'completed';
```

---

## 5. Direct SQL Protections

1. **Triggers** enforce counts and block completed deletion.
2. **Validation trigger** rejects wrong parent counts.
3. **Role design:** `pms_app_role` should not have direct `INSERT/UPDATE/DELETE` on `contract_assessment_milestones` except through service functions. This is a stronger guarantee but requires revoking table privileges and granting `EXECUTE` on service functions. Evaluate in Phase D; if not feasible, document that direct SQL is unsupported.
4. **Audit:** direct SQL does not write `audit_log`; the service path does. This is another reason to restrict direct DML.

---

## 6. Concurrency

- All triggers lock the parent `FOR UPDATE`, serializing count changes.
- The deferred reconciliation runs at commit; concurrent transactions serialize on the parent.
- `40001` may occur; map to 409 and retry.
- Test matrix:
  - 10 concurrent adds to the same contract → one at a time; final count correct.
  - 10 concurrent removes → one at a time; min count enforced.
  - 10 concurrent completions → one at a time; final completed count correct.
  - 2 concurrent adds to different contracts → both succeed.
  - 2 concurrent adds to the same contract → both succeed if count < 5; final count 4.
  - 6 concurrent adds → four succeed, two 409 (max 5).
  - Direct SQL insert + service add → count reconciled.
  - Direct SQL delete of completed → rejected.

---

## 7. Test Matrix

| Test | Expected |
|---|---|
| Create draft with 4 assessments | `total_assessments=4`, `completed=0` |
| Add 5th assessment to 4 | `total=5` |
| Add 6th | 400 `MAX_ASSESSMENTS` |
| Remove to 2 | `total=2` |
| Remove to 1 | 400 `MIN_ASSESSMENTS` |
| Remove completed | 400 `COMPLETED_ASSESSMENT_CANNOT_BE_DELETED` |
| Complete one | `completed=1` |
| Complete all | `completed=total`, status `completed` or `exhausted` |
| Reopen completed | 400 `COMPLETED_ASSESSMENT_CANNOT_BE_REOPENED` |
| Direct SQL insert | Trigger reconciles at commit |
| Direct SQL wrong count | Validation trigger rejects |
| Concurrent adds | Serialized; final count correct |
| Concurrent removes | Serialized; min count enforced |
| Concurrent completions | Serialized; final count correct |

---

## 8. Acceptance Criteria

- [ ] Service no longer manually updates counts.
- [ ] Triggers own `total_assessments` and `completed_assessments`.
- [ ] Direct SQL cannot set wrong counts.
- [ ] Completed milestones cannot be deleted or reopened.
- [ ] Minimum 2 / maximum 5 enforced in the DB.
- [ ] Concurrent add/remove/complete produce correct counts.
- [ ] Count reconciliation queries return zero mismatches on a healthy DB.
- [ ] D-05/D-10 status interactions work.

---

## 9. Conclusion

Trigger-owned counts are the most robust approach. The service becomes simpler, direct SQL is protected, and concurrency is serialized by the parent lock. The trigger suite must be tested in PGlite before implementation is certified.