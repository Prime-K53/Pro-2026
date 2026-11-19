# 06 — Migration Design Remediation Report (Stage 2)

**Date:** 2026-11-19
**Branch:** `fix/printing-contracts-99`
**Base commit:** `933bcf32b9e570f97ef9d2f864274fd64c6d6e08`
**Mode:** Documentation only — no migration 0020 written or applied
**Business decisions:** D-01…D-12 APPROVED (see `02-business-decisions.md`)

---

## 1. Executive Summary

Stage 2 re-verified all 18 migration findings against the live repository and the approved business decisions. The original 0020 design was directionally sound but **not sufficient** for the approved decisions.

The approved D-05 and D-10 require a **contract lifecycle expansion** that the current schema does not support:

- `printing_contracts.status` currently allows only `active | exhausted | cancelled` (`0007:134`).
- D-10 requires a `draft` state and a separate activation step.
- D-05 requires a `completed` state where the remaining balance stays attached.
- The current `createPrintingContract` posts the deposit journal immediately and creates an `active` contract (`printingRecordsService.ts:142-170`).
- The current `completeContractAssessment` sets `exhausted` when all assessments are done, even with a positive balance (`printingRecordsService.ts:994-1019`).

D-08 requires a company timezone column that does not exist. D-07 requires a Contract Manager role that does not exist. D-06 requires colour/terms fields that do not exist.

The corrected design therefore expands 0020 (or splits it into 0020 + 0021) to include:

1. Contract lifecycle statuses `draft` and `completed`.
2. Currency `MWK` from `companies.base_currency`.
3. Company timezone `Africa/Blantyre`.
4. Cancellation/settlement metadata.
5. Deposit/milestone invoice links.
6. A global, numeric, company-scoped numbering counter with minimum-width formatting and natural overflow.
7. Allocation, count, and balance integrity triggers.
8. Legacy preflight before strict constraints.

**Stage 2 verdict:** **STAGE 2 COMPLETE WITH CONDITIONS** — all 18 findings have dispositions and the five high-severity defects are corrected, but implementation must not start until the lifecycle expansion, timezone, RBAC, colour, and PGlite trigger test are incorporated and accepted.

---

## 2. Approved Decision Impact on the Migration

| Decision | Schema impact | Service/lifecycle impact | Migration required |
|---|---|---|---|
| D-01 Currency | `printing_contracts.currency_code`; `documentsService` uses company currency | Set from `companies.base_currency`; update Malawi company to `MWK` | Yes |
| D-02 Cancellation | `cancelled_at`, `cancelled_by`, `cancellation_reason`, `settlement_mode`, `settled_amount`, `settlement_journal_txn_id` | Cancel posts refund/forfeit; audit | Yes |
| D-03 Forfeiture | None (uses existing `4900` Other Income) | Resolve by code/subtype; fail closed | No |
| D-04 Top-ups | None | New top-up service/route; bank Deposit row | No |
| D-05 Completed | Add `completed` to status CHECK | Completion sets `completed`, keeps balance | **Yes — high** |
| D-06 Colour | `color_mode`/terms on contract or milestone | Pass colour to costing; update press capability | **Yes — medium** |
| D-07 Permissions | `company_memberships.role` CHECK + `printing:contracts:manage` | New role/permission; route/UI guards | **Yes — role CHECK** |
| D-08 Timezone | `companies.timezone` | Company-local dates; UTC timestamps | **Yes — medium** |
| D-09 Reactivation | Uses settlement columns | Reject activate after cancel/settle | No (uses D-02 columns) |
| D-10 Draft | Add `draft` to status CHECK; `activated_at/by` | Split create/activate; no journal at draft | **Yes — high** |
| D-11 Numbering | `printing_number_counters` + function | Replace MAX/UTC generators | **Yes — high** |
| D-12 Legacy | None | Read-only preflight; separate approval | No (data process) |

**Critical path:** D-10 and D-05 must be designed together because they both change the status model and the completion/activation transitions.

---

## 3. Disposition Table — All 18 Migration Findings

| ID | Finding | Disposition | Corrected design reference |
|---|---|---|---|
| **MIG-01** | Number-format changes | **FIX REQUIRED** | §4.1, `07-numbering-and-locking-design.md` |
| **MIG-02** | Trigger locking/deadlocks | **FIX REQUIRED** | §4.2, `07-numbering-and-locking-design.md` |
| **MIG-03** | Trigger misses `contract_id`/`company_id` updates | **FIX REQUIRED** | §4.3 |
| **MIG-04** | Assessment counts not maintained | **FIX REQUIRED** | §4.4, `08-assessment-integrity-design.md` |
| **MIG-05** | Pending idempotency state is a convention | **FIX REQUIRED** | §4.5, `05-idempotency-design.md` |
| **MIG-06** | `currency_code` service dependency | **FIX REQUIRED** | §4.6 |
| **MIG-07** | Settlement columns lack consistency CHECKs | **FIX REQUIRED** | §4.7 |
| **MIG-08** | Cancellation metadata consistency | **FIX REQUIRED** | §4.8 |
| **MIG-09** | Exam-paper numbering backfill missing | **FIX REQUIRED** | §4.9, `07-numbering-and-locking-design.md` |
| **MIG-10** | `version` column unused | **FIX REQUIRED** — remove from 0020; add later if used | §4.10 |
| **MIG-11** | Number function needs company guard/error mapping | **FIX REQUIRED** | §4.11 |
| **MIG-12** | `40001` serialization failures not handled | **FIX REQUIRED** | §4.12 |
| **MIG-13** | Missing `remaining_balance` vs completed invariant | **FIX REQUIRED** | §4.13 |
| **MIG-14** | PGlite compatibility not proven | **FIX REQUIRED — UNVERIFIED** | §4.14 |
| **MIG-15** | Legacy allocations/credit balances | **FIX REQUIRED** | §4.15, `09-legacy-data-preflight-design.md` |
| **MIG-16** | `CHAR(3)` vs `VARCHAR(3)` | **ACCEPTED RISK** | §4.16 |
| **MIG-17** | Counter table lacks CHECKs | **FIX REQUIRED** | §4.17 |
| **MIG-18** | Function parameter guards | **FIX REQUIRED** | §4.18 |

No finding is omitted. No finding is marked ALREADY RESOLVED because the current code still contains the defects; the corrections are design-only until implemented.

---

## 4. Detailed Findings

### 4.1 MIG-01 — Number-format changes

**Root cause:** The original draft proposed 4-digit contracts and 5-digit exams, and a failure when the sequence exceeded the width.

**Verified actual behaviour:**
- Contracts: `CTR-YYYY-NN` — `String(seq).padStart(2, '0')` (`printingRecordsService.ts:140`).
- Exams: `EXM-YYYY-NNNN` — `padStart(4, '0')` (`printingRecordsService.ts:342`).
- Sequence is `MAX(...)+1` **across all years**, not per-year (`135-139`, `323-327`).
- No counter table.

**Corrected design:**
- Preserve `CTR-YYYY-NN` and `EXM-YYYY-NNNN`.
- Width is a **minimum**, not a maximum. `LPAD(seq, 2, '0')` / `LPAD(seq, 4, '0')`.
- Natural overflow: 100 → `CTR-2026-100`; 10000 → `EXM-2026-10000`. No truncation, no exception at width.
- Numeric company-scoped counter with a **global** `last_value` to preserve the existing cross-year sequence. Do not reset to 1 at year rollover.
- Counter table `printing_number_counters(company_id, scope, last_value)` with PK `(company_id, scope)`, RLS + FORCE.
- Backfill with `GREATEST` and rerunnable upsert.
- Year from company timezone (D-08), not UTC.

**Acceptance tests:**
- 150 sequential creates → unique `CTR-YYYY-0001`…`CTR-YYYY-0150`.
- 20 concurrent creates → 20 unique numbers.
- Sequence at 99 → 100 produces `CTR-YYYY-100` (not truncated/failed).
- Exam sequence at 9999 → 10000 produces `EXM-YYYY-10000`.
- Rerun backfill → no regression.

**Disposition:** FIX REQUIRED. See `07-numbering-and-locking-design.md`.

---

### 4.2 MIG-02 — Trigger locking and deadlocks

**Root cause:** The allocation trigger locks the parent at commit, but the service does not consistently lock the parent first. This can deadlock.

**Verified mutation paths:**

| Path | Current lock order | Issue |
|---|---|---|
| `createPrintingContract` | counter (MAX) → contract insert → milestones → journal | No row lock; counter race |
| `amendPrintingContract` | none → contract update | No parent lock |
| `setPrintingContractStatus` | contract FOR UPDATE | Good |
| `renewPrintingContract` | old contract FOR UPDATE → create new (counter) | **Lock-order inversion**: contract then counter |
| `addContractAssessment` | contract FOR UPDATE → milestone insert | Good |
| `removeContractAssessment` | contract FOR UPDATE → milestone delete | Good |
| `updateContractAssessment` | milestone FOR UPDATE (no parent) | **Missing parent lock** |
| `completeContractAssessment` | contract FOR UPDATE → milestone FOR UPDATE | Good |
| `createExamBatch` | counter → batch → papers | No contract lock; add if linking |
| `updateExamPaperStatus` | paper FOR UPDATE | Fine |

**Corrected lock order (mandatory):**

1. **Counter** (if a number is needed).
2. **Parent contract** `FOR UPDATE`.
3. **Milestone rows** `FOR UPDATE`.
4. **Journal / bank / audit / request_keys**.

**Renew fix:** generate the new number **before** locking the old contract:
```
counter → old contract FOR UPDATE → new contract insert → journal → bank → audit
```
This removes the cycle.

**Trigger role:** defence-in-depth only. The trigger's `SELECT ... FOR UPDATE` at commit is not a substitute for service-level parent-first locking.

**Deadlock analysis:**
- Two concurrent `renew` calls: both lock counter first; one waits; no cycle.
- `complete` (contract → milestone) vs `update` (contract → milestone): both lock contract first; no cycle.
- `create` (counter → new contract) vs `renew` (counter → old contract → new contract): both counter first; no cycle.
- Direct SQL that locks a child before the parent can still deadlock; document that direct DML is unsupported for financial workflows.

**Acceptance tests:**
- 20 concurrent creates.
- 10 concurrent completes on the same milestone.
- 10 concurrent renews on the same contract.
- 10 concurrent top-ups.
- Two concurrent edits to different milestones of the same contract.
- Two concurrent edits to the same milestone.

**Disposition:** FIX REQUIRED. See `07-numbering-and-locking-design.md`.

---

### 4.3 MIG-03 — Trigger update columns

**Root cause:** `AFTER INSERT OR UPDATE OF agreed_amount OR DELETE` misses `contract_id`/`company_id` changes.

**Corrected design:**
- Use `AFTER INSERT OR UPDATE OR DELETE` (all updates), or explicitly `UPDATE OF agreed_amount, contract_id, company_id`.
- Block cross-contract moves in the service; a milestone belongs to one contract.
- Add a test that directly updates `contract_id` and confirms the invariant is checked.

**Disposition:** FIX REQUIRED.

---

### 4.4 MIG-04 — Assessment counts

**Root cause:** `total_assessments` and `completed_assessments` are maintained manually by the service (`printingRecordsService.ts:773-776`, `819-822`, `1016`); direct SQL can bypass them.

**Corrected design:** trigger-owned counts.
- `BEFORE INSERT` on milestones: lock parent, check `COUNT(*) < 5`, validate assessment number.
- `BEFORE DELETE`: lock parent, check `COUNT(*) > 2`, block deleting a `completed` milestone.
- `BEFORE UPDATE OF status`: block `completed → pending`; allow `pending → completed`.
- `AFTER INSERT OR UPDATE OF status OR DELETE` (deferred): recompute `total_assessments` and `completed_assessments` from the rows and update the parent.
- Remove manual count updates from the service; the trigger owns the counts.
- Add reconciliation queries and tests.

**Trade-off:** Trigger-owned counts are robust against direct SQL but centralize logic. Service-only counts are simpler but unsafe. The approved decision D-05/D-10 and the audit's integrity requirements favour triggers.

**Acceptance tests:**
- Insert 5th milestone → accepted; 6th → rejected.
- Delete to 1 → rejected.
- Delete a completed milestone → rejected.
- Direct SQL insert without count update → trigger reconciles at commit.
- Concurrent insert/delete → counts consistent.

**Disposition:** FIX REQUIRED. See `08-assessment-integrity-design.md`.

---

### 4.5 MIG-05 — Pending idempotency state

**Root cause:** The draft used `status_code=202`/`response_json NULL` as a pending convention, but existing helpers treat any row as a replay.

**Corrected design:** same-transaction claim (see `05-idempotency-design.md`).
- The claim, mutation, journal, bank row, audit, and response are in one transaction.
- There is **no committed pending row**.
- A concurrent request blocks on the unique index, then replays or starts fresh.
- If observability is required, add `claimed_at`/`completed_at` (read-only), never a takeover.

**Disposition:** FIX REQUIRED — resolved by design; implementation must use the same-transaction helper.

---

### 4.6 MIG-06 — `currency_code`

**Root cause:** The draft added `currency_code DEFAULT 'ZMW'`; D-01 requires `MWK` from `companies.base_currency`.

**Corrected design:**
- `currency_code CHAR(3)` nullable.
- Backfill `UPDATE printing_contracts pc SET currency_code = c.base_currency FROM companies c WHERE ...`.
- `SET NOT NULL` after backfill.
- Service sets it from `companies.base_currency` on create/renew/top-up.
- Replace `documentsService.ts:561` hardcoded `'ZMW'`.
- Update the Malawi company to `base_currency='MWK'`, `currency_symbol='K'` (data change, separate approval).

**Acceptance tests:**
- Create contract in an MWK company → `currency_code='MWK'`.
- Preview shows `MWK` / `K`.
- No hardcoded `'ZMW'` remains in contract/document code.

**Disposition:** FIX REQUIRED.

---

### 4.7 MIG-07 — Settlement consistency CHECKs

**Corrected design:**
```sql
CHECK (
  (settlement_mode IS NULL AND settled_amount = 0 AND settlement_journal_txn_id IS NULL)
  OR
  (settlement_mode IN ('refund','forfeit') AND settled_amount > 0 AND settlement_journal_txn_id IS NOT NULL)
)
```
- `settlement_mode` only on `cancelled` (service guard; optionally a CHECK).
- `settled_amount` cannot exceed `remaining_balance` at cancellation (service/trigger).
- Add tests for refund/forfeit/zero-balance.

**Disposition:** FIX REQUIRED.

---

### 4.8 MIG-08 — Cancellation metadata

**Corrected design:**
- `status='cancelled'` → `cancelled_at IS NOT NULL`, `cancelled_by IS NOT NULL`, `cancellation_reason IS NOT NULL`.
- `status<>'cancelled'` → `cancelled_at IS NULL`, `settlement_mode IS NULL`.
- Backfill `cancelled_at = updated_at` for existing cancelled rows (documented assumption).
- Add CHECK only after backfill verification.

**Disposition:** FIX REQUIRED.

---

### 4.9 MIG-09 — Exam-paper numbering backfill

**Verified actual format:** `EXM-YYYY-NNNN` (`printingRecordsService.ts:342`), unique `(company_id, job_number)` (`0007:257`), global MAX sequence (`323-327`).

**Corrected backfill:**
```sql
INSERT INTO printing_number_counters (company_id, scope, last_value)
SELECT p.company_id,
       'exam_paper',
       MAX(CAST(split_part(p.job_number, '-', 3) AS INTEGER))
  FROM exam_papers p
 WHERE p.job_number ~ '^EXM-[0-9]{4}-[0-9]+$'
 GROUP BY p.company_id
ON CONFLICT (company_id, scope)
DO UPDATE SET last_value = GREATEST(printing_number_counters.last_value, EXCLUDED.last_value);
```
- Report malformed numbers first: `job_number !~ '^EXM-[0-9]{4}-[0-9]+$'`.
- Rerunnable via `GREATEST`.
- Preserve historical references; never renumber.
- Natural overflow at 10000.
- Concurrent numbering via `ON CONFLICT DO UPDATE ... RETURNING`.

**Acceptance tests:**
- Backfill with 9,999 existing papers → next is `EXM-YYYY-10000`.
- Rerun backfill → no regression.
- Malformed numbers reported, not cast.
- 20 concurrent exam batch creates → unique numbers.

**Disposition:** FIX REQUIRED. See `07-numbering-and-locking-design.md`.

---

### 4.10 MIG-10 — `version` column

**Root cause:** The draft added `version` but no service uses it.

**Corrected design:** remove `version` from 0020 to keep the migration minimal. Add it in a later migration only when optimistic concurrency is implemented (`UPDATE ... WHERE version = $expected`, increment).

**Disposition:** FIX REQUIRED (remove from 0020).

---

### 4.11 MIG-11 — Number function guards

**Corrected design:**
- Company guard: `p_company_id` must equal `app.current_company_id`.
- Parameter guards: `p_width > 0`, `p_prefix` non-empty, `p_scope` in allowed set.
- Stable error codes: `PRINTING_NUMBER_COMPANY_MISMATCH`, `PRINTING_NUMBER_INVALID_ARGUMENT`.
- Map to 409/400 in `handlePrintingError`.

**Disposition:** FIX REQUIRED.

---

### 4.12 MIG-12 — `40001` handling

**Corrected design:**
- Map `40001` to 409 `SERIALIZATION_CONFLICT`.
- Retry contract mutations once on 40001 at the service/route level.
- Add a concurrency test.

**Disposition:** FIX REQUIRED.

---

### 4.13 MIG-13 — Remaining balance vs completed assessments

**Corrected design:**
- Invariant: `remaining_balance = total_prepaid_amount - SUM(agreed_amount WHERE status='completed')`.
- Add a deferred trigger or a preflight + reconciliation query.
- The trigger must lock the parent and run after completion updates.
- Add a test that directly corrupts the balance and confirms the trigger rejects/reconciles.

**Disposition:** FIX REQUIRED.

---

### 4.14 MIG-14 — PGlite compatibility

**Current status:** UNVERIFIED. Standard Postgres features are used, but `CREATE CONSTRAINT TRIGGER ... DEFERRABLE` and `plpgsql` must be exercised in the in-memory PGlite harness.

**Corrected design:**
- Add a disposable migration test in `tests/db/migration-suite.ts` (Phase D, not now).
- Apply 0020 up, insert valid/invalid allocations, call the counter, apply down.
- If PGlite does not support constraint triggers, fall back to service-level enforcement + a simpler trigger, and document the limitation.

**Disposition:** FIX REQUIRED — UNVERIFIED until the PGlite test runs.

---

### 4.15 MIG-15 — Legacy allocations and credit balances

**Corrected design:** read-only preflight, no automatic corrections. Full queries and methodology in `09-legacy-data-preflight-design.md`.

**Disposition:** FIX REQUIRED (design complete; execution requires DB access and D-12 sign-off).

---

### 4.16 MIG-16 — `CHAR(3)` vs `VARCHAR(3)`

**Assessment:** `companies.base_currency` is `CHAR(3)` (`0001:59`). Using `CHAR(3)` for `printing_contracts.currency_code` is consistent. `CHAR(3)` pads with spaces; comparisons should use `TRIM` or fixed-length semantics.

**Disposition:** ACCEPTED RISK — document the fixed-length behaviour; no change required.

---

### 4.17 MIG-17 — Counter table CHECKs

**Corrected design:**
```sql
CHECK (last_value >= 0),
CHECK (scope IN ('contract', 'exam_paper'))
```
or document allowed scopes.

**Disposition:** FIX REQUIRED.

---

### 4.18 MIG-18 — Function parameter guards

**Corrected design:**
```sql
IF p_width IS NULL OR p_width <= 0 OR p_width > 10 THEN
  RAISE EXCEPTION 'PRINTING_NUMBER_INVALID_WIDTH' USING ERRCODE = 'P0001';
END IF;
IF p_prefix IS NULL OR p_prefix = '' THEN
  RAISE EXCEPTION 'PRINTING_NUMBER_INVALID_PREFIX' USING ERRCODE = 'P0001';
END IF;
```

**Disposition:** FIX REQUIRED.

---

## 5. Corrected Migration 0020 Design

### 5.1 Scope decision

The original 0020 is too small for the approved decisions. Two options:

- **Option A (recommended):** One 0020 containing contract lifecycle, currency, settlement, numbering, triggers, timezone, and colour/terms.
- **Option B:** Split:
  - 0020: contract lifecycle/currency/settlement/numbering/triggers.
  - 0021: company timezone, colour/terms, RBAC role.
  - 0022: legacy data remediation (if needed).

**Recommendation:** Option B if the review board wants smaller, independently testable migrations. The rest of this section describes the combined design; the split is a packaging decision.

### 5.2 Status lifecycle model

**Current:** `active | exhausted | cancelled` (`0007:134`).

**Approved target:**

| Status | Meaning | Journal? | Wallet movement? |
|---|---|---|---|
| `draft` | Created, not activated; assessments allocated | No | No |
| `active` | Activated; deposit received; assessments can complete | Yes (activation) | Yes (deposit) |
| `completed` | All required assessments completed; remaining balance stays attached | Yes (completions) | No automatic refund |
| `exhausted` | All assessments completed and remaining balance = 0 (optional sub-state) | Yes | No |
| `cancelled` | Terminated; refund/forfeit recorded | Yes (settlement) | Refund only if `refund` |

**Transitions:**

```
draft → active                  (activate: validate allocation + wallet, post deposit)
active → completed              (final assessment completed; balance stays)
active → exhausted              (final assessment completed; balance = 0)
active → cancelled              (settlement: refund/forfeit)
completed → cancelled?          (only with manual settlement; business decision)
exhausted → —                   (renew/new contract)
cancelled → —                   (never reactivate; D-09)
```

**Schema change:**
```sql
ALTER TABLE printing_contracts
  DROP CONSTRAINT printing_contracts_status_check;

ALTER TABLE printing_contracts
  ADD CONSTRAINT printing_contracts_status_check
  CHECK (status IN ('draft','active','completed','exhausted','cancelled'));
```

**Backfill:**
- `status='exhausted' AND completed_assessments >= total_assessments AND remaining_balance > 0` → `completed`.
- `status='active' AND completed_assessments >= total_assessments` → `completed` (if any legacy rows).
- `status='exhausted' AND remaining_balance = 0` → keep `exhausted`.
- `status='cancelled'` → keep `cancelled`; backfill `cancelled_at` from `updated_at`.

**TS/UI impact:**
- `types/accounting.ts:213` → add `'draft' | 'completed'`.
- `PrintingContractsView.tsx:792`, `AccountingContext.tsx:2386`, `documents.ts:307`, `ContractActionModals.tsx:426/434`, `SidebarNavigator.tsx:123`, `HomeWorkflowView.tsx:91`.
- `PrintingContractsView.tsx:588` "Edit Draft" should be visible only for `status='draft'`.

### 5.3 `printing_contracts` columns

```sql
ALTER TABLE printing_contracts
  ADD COLUMN currency_code CHAR(3),
  ADD COLUMN activated_at TIMESTAMPTZ,
  ADD COLUMN activated_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN completed_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN cancelled_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN cancellation_reason TEXT,
  ADD COLUMN settlement_mode VARCHAR(16)
    CHECK (settlement_mode IS NULL OR settlement_mode IN ('refund','forfeit')),
  ADD COLUMN settled_amount NUMERIC(19,4) NOT NULL DEFAULT 0.0000
    CHECK (settled_amount >= 0),
  ADD COLUMN settlement_journal_txn_id BIGINT,
  ADD COLUMN deposit_invoice_id BIGINT,
  ADD COLUMN deposit_invoice_number VARCHAR(64),
  ADD COLUMN color_mode VARCHAR(16) NOT NULL DEFAULT 'mono'
    CHECK (color_mode IN ('mono','colour')),
  ADD COLUMN colour_included BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE printing_contracts
  ADD CONSTRAINT fk_contracts_deposit_invoice
  FOREIGN KEY (company_id, deposit_invoice_id)
  REFERENCES invoices (company_id, id) ON DELETE RESTRICT;

ALTER TABLE printing_contracts
  ADD CONSTRAINT fk_contracts_settlement_journal
  FOREIGN KEY (company_id, settlement_journal_txn_id)
  REFERENCES journal_transactions (company_id, id) ON DELETE RESTRICT;

ALTER TABLE printing_contracts
  ADD CONSTRAINT ck_contracts_settlement
  CHECK (
    (settlement_mode IS NULL AND settled_amount = 0 AND settlement_journal_txn_id IS NULL)
    OR
    (settlement_mode IN ('refund','forfeit') AND settled_amount > 0 AND settlement_journal_txn_id IS NOT NULL)
  );

ALTER TABLE printing_contracts
  ADD CONSTRAINT ck_contracts_active_has_journal
  CHECK (status <> 'active' OR deposit_journal_txn_id IS NOT NULL);

ALTER TABLE printing_contracts
  ADD CONSTRAINT ck_contracts_cancelled_meta
  CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL)
    OR status <> 'cancelled'
  );
```

**Backfill order:**
1. Add columns nullable.
2. Backfill `currency_code` from `companies.base_currency`.
3. Backfill `cancelled_at = updated_at` for cancelled rows.
4. Backfill `completed_at = (SELECT MAX(completed_date) ...)` for completed rows.
5. Add CHECKs **after** backfill verification.
6. `SET NOT NULL` on `currency_code`.

**Note:** `ck_contracts_cancelled_meta` requires a non-null reason for all cancelled rows. Legacy cancelled rows may have no reason; backfill `'Legacy cancellation (reason not recorded)'` only if the business approves, or make the CHECK `cancelled_at IS NOT NULL` only and enforce the reason in the service. Prefer the latter to avoid rewriting history.

### 5.4 `contract_assessment_milestones` columns

```sql
ALTER TABLE contract_assessment_milestones
  ADD COLUMN linked_invoice_number VARCHAR(64),
  ADD COLUMN completed_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN color_mode VARCHAR(16)
    CHECK (color_mode IS NULL OR color_mode IN ('mono','colour'));
```

### 5.5 Numbering counter

```sql
CREATE TABLE printing_number_counters (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  scope      VARCHAR(32) NOT NULL CHECK (scope IN ('contract','exam_paper')),
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

Function:

```sql
CREATE OR REPLACE FUNCTION next_printing_number(
  p_company_id BIGINT,
  p_scope TEXT,
  p_prefix TEXT,
  p_min_width INT
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_last INT;
  v_text TEXT;
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

  v_text := v_last::TEXT;
  RETURN p_prefix || LPAD(v_text, p_min_width, '0');
END;
$$;
```

**Year:** the caller passes `p_prefix` including the year, e.g. `'CTR-' || company_year || '-'`. The year is computed from the company timezone, not the function.

**Natural overflow:** `LPAD` does not truncate; `v_last=100`, `p_min_width=2` → `'100'`. No exception.

### 5.6 Triggers

1. **Allocation ceiling** (`SUM(agreed_amount) <= total_prepaid_amount`) — deferred, parent lock.
2. **Count reconciliation** (`total_assessments`, `completed_assessments`) — deferred, parent lock.
3. **Remaining balance invariant** (`remaining_balance = total_prepaid - SUM(completed agreed)`) — deferred or preflight.
4. **Status transition validation** — `draft → active`, `active → completed/exhausted/cancelled`; reject `cancelled → active`, `completed → active`, `exhausted → active`.
5. **Completed milestone deletion block** — `BEFORE DELETE` raise if `OLD.status='completed'`.

**Trigger ordering:** all triggers lock the parent first. The trigger functions must not assume a specific row lock; use `SELECT ... FOR UPDATE` on the parent.

### 5.7 Indexes

```sql
CREATE INDEX ix_printing_contracts_company_status
  ON printing_contracts (company_id, status);
CREATE INDEX ix_contract_milestones_company_status
  ON contract_assessment_milestones (company_id, status);
CREATE INDEX ix_contract_milestones_contract_number
  ON contract_assessment_milestones (company_id, contract_id, assessment_number);
```

### 5.8 Timezone

```sql
ALTER TABLE companies
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Africa/Blantyre';
```

Helper:
```sql
CREATE OR REPLACE FUNCTION company_today(p_company_id BIGINT)
RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT (NOW() AT TIME ZONE c.timezone)::DATE
    FROM companies c WHERE c.id = p_company_id;
$$;
```

Replace UTC date/year derivations in contract/exam numbering and completion.

### 5.9 Colour

- `printing_contracts.color_mode` + `colour_included`.
- `contract_assessment_milestones.color_mode` (optional; per-assessment override).
- `calculateContractMilestoneEstimate` must pass `colorMode` and colour channels.
- Press capability `supportsColour: true` where colour is offered.
- Separate pricing/BOM/consumption tests.

### 5.10 Down migration

- Drop triggers, functions, counters table, new columns, indexes.
- **Do not** drop columns with financial history in production.
- Down is for disposable test DBs only.
- Roll-forward: new `0021_fix...up.sql` for post-deployment defects; restore from backup only if necessary.

---

## 6. Dependencies and Migration Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `draft`/`completed` status CHECK change | Existing queries/UI may not handle new statuses | Update all status branches; add tests; backfill |
| `ck_contracts_active_has_journal` | Legacy active rows without journal fail | Preflight; backfill or relax constraint |
| `ck_contracts_cancelled_meta` | Legacy cancelled rows without reason fail | Backfill reason only with approval, or enforce in service |
| `currency_code NOT NULL` | Legacy rows without company currency fail | Backfill from companies; verify no NULL companies |
| `timezone` column | Existing UTC dates may shift at boundaries | Document; do not rewrite historical dates |
| PGlite constraint triggers | Migration test may fail | Disposable test; fallback to service-level |
| Role CHECK change | Existing roles may be affected | Add `ContractManager` without removing existing roles |
| `version` removal | If optimistic concurrency is needed later, add a new migration | Keep 0020 minimal |
| Legacy credit balances | Strict constraints may fail | Preflight + D-12 sign-off |

---

## 7. Verification Tests (Phase D)

| Test | Purpose |
|---|---|
| 0020 up on empty PGlite | Schema applies |
| 0020 up on seeded legacy DB | Backfills, no data loss |
| 0020 down on disposable DB | Schema returns to 0019 |
| Draft create → activate | No journal at draft; journal at activation |
| Activation with insufficient funds | Rejected; no journal |
| Complete final assessment with balance | `status='completed'`; balance unchanged |
| Complete final assessment with zero balance | `status='exhausted'` |
| Cancel refund | Liability zero; bank debit row; metadata |
| Cancel forfeit | Liability zero; `4900` credit; no bank row |
| Cancel with no settlement mode | Rejected |
| Reactivate cancelled | Rejected |
| Top-up active | Totals increase; bank Deposit row |
| Top-up completed/cancelled | Rejected |
| 150 sequential contract numbers | Unique |
| 20 concurrent creates | Unique |
| 10 concurrent completes | One success |
| 10 concurrent renews | One new contract |
| Allocation over/under | Rejected/allocated |
| Count triggers | Direct SQL reconciled |
| Remaining balance invariant | Direct corruption rejected |
| `40001` retry | One posting |
| PGlite trigger | Fires correctly |

---

## 8. Conclusion

The corrected design addresses all 18 migration findings and incorporates the approved decisions. The five high-severity defects are corrected:

- **MIG-01:** global numeric counter, minimum-width formatting, natural overflow, no truncation.
- **MIG-02:** mandatory counter → contract → milestone lock order; renew generates the number first.
- **MIG-04:** trigger-owned assessment counts + completed-milestone deletion block.
- **MIG-09:** verified exam backfill with `GREATEST`, malformed reporting, natural overflow.
- **MIG-15:** read-only preflight design; no automatic corrections.

**Conditions before implementation:**

1. The status lifecycle expansion (`draft`, `completed`) is accepted and all status branches are updated.
2. The timezone column and company-local date helper are accepted.
3. The RBAC role/permission change is accepted.
4. The colour/terms fields and costing changes are accepted.
5. The PGlite constraint-trigger test passes.
6. The legacy preflight is executed and signed off.
7. Explicit implementation authorisation is recorded.

**Stage 2 verdict:** **STAGE 2 COMPLETE WITH CONDITIONS.**