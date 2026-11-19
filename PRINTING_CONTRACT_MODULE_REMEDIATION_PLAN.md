# Printing Contract Module — Remediation Plan to ≥99.8%

**Companion document:** `PRINTING_CONTRACT_MODULE_AUDIT_REPORT.md`
**Plan date:** 2026-11-19
**Target:** Close every S1/S2 finding, close every S3 finding, add a service/API/concurrency test matrix, ship one clean migration, and complete one zero-variance reconciliation run.

---

## 1. Objective and Exit Criteria

### 1.1 Objective

Make the printing-contract module financially correct, operationally idempotent, and client/server consistent, without changing the existing UX or the double-entry engine.

### 1.2 Exit criteria (all must be true)

1. **Zero S1 findings open.**
2. **Zero S2 findings open.**
3. **Zero S3 findings open.**
4. `npm run lint` passes.
5. `npm run test:printing`, `test:documents`, `test:workflows`, `test:db`, and the new `test:printing-contracts` all pass.
6. A new migration applies cleanly up and down against a seeded database.
7. A shadow-run reconciliation of 30 days of contract activity shows **0.00** variance between:
   - `SUM(printing_contracts.remaining_balance)` and the liability account balance;
   - `SUM(contract_assessment_milestones.agreed_amount)` per contract and `total_prepaid_amount - unallocated_amount`, where `unallocated_amount` is an explicit, intentional credit line (not a silent residual);
   - `bank_transactions` deposit/withdrawal totals and the bank account balance.
8. A double-submit of create/renew/complete produces exactly one contract, one deposit journal, and one completion journal.

### 1.3 Non-goals

- No change to paper/toner calculation algorithms.
- No change to the visual design system.
- No new tax engine.
- No multi-currency support (only add the column for future use).

---

## 2. Guiding Principles

1. **Backend is the source of truth for money.** The client may cache, but it must never post a local ledger entry when the backend is the system of record.
2. **Fail closed on financial operations.** If the server cannot confirm, show an error — do not show success.
3. **Every money movement gets an idempotency key.**
4. **Every state transition has a guard and an audit entry.**
5. **Invariants live in the database, not only in TypeScript.** Application checks are UX; DB constraints are correctness.
6. **No field may exist in one layer and not the others.** API serializer, SQL column, TS type, and UI must agree.
7. **Test the money paths first.** Create, complete, cancel, renew, top-up, and double-submit.

---

## 3. Phase Overview

| Phase | Name | Findings addressed | Exit gate |
|---|---|---|---|
| **0** | Safety net & baseline | — | Baseline tests green; branch created |
| **A** | Critical financial integrity | C-01…C-09 | All S1 closed; migration 0020 applied; service tests green |
| **B** | Data consistency & links | H-01…H-15, M-08, M-09 | All S2 closed; API tests green |
| **C** | Correctness & robustness | M-01…M-16, H-05, L-02, L-07 | All S3 closed; lint + tests green |
| **D** | Schema & backfill | Schema gaps, T-01…T-09 | Up/down migration clean; backfill verified |
| **E** | Certification | T-01…T-09, UAT | Full matrix green; zero-variance reconciliation |
| **F** | Polish & documentation | L-01…L-07 | Docs complete; no lint warnings |

**Dependency:** A → B → C → D → E → F. Phase 0 must complete first. Phase D can start in parallel with B/C once the column list is frozen, but the migration must be applied before Phase E.

---

## 4. Phase 0 — Safety Net and Baseline

### WP-00.1 — Freeze and branch

- Create branch `fix/printing-contracts-99`.
- Tag the current commit as `pre-contract-audit`.
- Record the current test results:
  - `npm run lint`
  - `npm run test:printing`
  - `npm run test:documents`
  - `npm run test:workflows`
  - `npm run test:db`
- **Exit:** baseline log committed to `docs/printing-contract-baseline.txt`.

### WP-00.2 — Characterization tests (no behavior change)

Add `tests/printing/contracts-characterization.test.ts` that captures current behavior for:

1. Create a contract with 2 assessments summing to the prepaid amount → 201, deposit journal balanced.
2. Create with mismatched sum → currently succeeds; mark as `EXPECTED_TO_CHANGE` with a TODO referencing C-01.
3. Complete assessment #1 twice → second call returns 409.
4. Cancel a contract with remaining balance → currently succeeds; mark `EXPECTED_TO_CHANGE` (C-03).
5. Renew an active contract → currently creates a second deposit; mark `EXPECTED_TO_CHANGE` (C-04).
6. Add an assessment to a 5-assessment contract → 400 `MAX_ASSESSMENTS`.
7. Remove assessment #3 from [1,2,3,4], then add → currently proposes #4; mark `EXPECTED_TO_CHANGE` (H-12).

**Exit:** characterization suite runs and documents the baseline.

---

## 5. Phase A — Critical Financial Integrity (S1)

### WP-A1 — Assessment sum invariant (C-01)

**Files**

- `src/server/services/printingRecordsService.ts`
- `db/migrations/0020_printing_contract_settlement_and_links.up.sql`

**Changes**

1. In `createPrintingContract`, after parsing assessments:
   - Parse each `agreedAmount` with `parseDecimal4`.
   - Compute `sumAgreed`.
   - Require `sumAgreed === totalPrepaid`; otherwise throw `AccountingError(400, 'Assessment amounts must sum to the total prepaid amount', 'ASSESSMENT_SUM_MISMATCH')`.
2. In `addContractAssessment`:
   - Load current milestones.
   - Compute `currentSum + newAgreed`.
   - If `currentSum + newAgreed > totalPrepaid`, reject with `ASSESSMENT_SUM_EXCEEDS_PREPAID`.
   - If `currentSum + newAgreed < totalPrepaid`, allow it but mark the contract `partially_allocated`; the UI must show the unallocated amount.
   - If the contract is already fully allocated (`currentSum === totalPrepaid`), reject with `ASSESSMENT_SUM_ALREADY_ALLOCATED` unless the caller also increases `total_prepaid_amount` via a top-up.
3. In `updateContractAssessment`:
   - Compute `currentSum - oldAgreed + newAgreed`.
   - Require `<= totalPrepaid`; reject `>`.
4. In `topUpContract`:
   - Require `newTotalPrepaid >= currentSum`.
   - The excess (`newTotalPrepaid - currentSum`) is an unallocated credit balance.
5. Add a DB trigger `trg_validate_contract_assessment_sum` that runs `AFTER INSERT OR UPDATE OR DELETE` on `contract_assessment_milestones` and raises `ASSESSMENT_SUM_MISMATCH` if `SUM(agreed_amount) > total_prepaid_amount`.
   - Use a `DEFERRABLE INITIALLY DEFERRED` constraint trigger so the check runs at commit and allows multi-row inserts.
   - Add a second trigger on `printing_contracts AFTER UPDATE OF total_prepaid_amount` that repeats the `<=` check.
6. **Completion must not strand a credit balance.** Change `isExhausted`:
   ```ts
   const allAssessmentsDone = nextCompleted >= Number(row.total_assessments);
   const cashFullyConsumed = nextRemaining <= 0n;
   const isExhausted = allAssessmentsDone && cashFullyConsumed;
   const hasCreditBalance = allAssessmentsDone && !cashFullyConsumed;
   ```
   - If `hasCreditBalance`, set `status = 'active'` (or a new `credit_balance` status) and require a settlement action (refund/forfeit) or a renewal. The UI shows "All assessments completed — unallocated retainer of X. Refund or renew."
   - Never set `exhausted` while `remaining_balance > 0`.
7. Add a computed/read field `unallocatedAmount = total_prepaid_amount - SUM(agreed_amount)` and `creditBalance = remaining_balance` when all assessments are complete.
5. Update the UI:
   - `PrintingContractsView` already blocks `customMismatch` client-side; change tolerance from `0.05` to `0.005` (L-02) and display the exact residual.
   - `AddAssessmentModal` must show the remaining allocatable amount and disable submit when `currentSum + agreedAmount > totalPrepaid`.

**Acceptance criteria**

- Create with sum < prepaid → 400 `ASSESSMENT_SUM_MISMATCH`; no journal posted.
- Create with sum > prepaid → 400; no journal posted.
- Create with exact sum → 201; journal balanced.
- Direct SQL insert that makes `SUM(agreed_amount) > total_prepaid_amount` → transaction rolls back at commit.
- Add assessment that would exceed the prepaid total → 400; no row inserted.
- Add assessment that leaves an unallocated amount → allowed; UI shows the unallocated amount.
- Update assessment that breaks the `<=` invariant → 400; no row updated.
- Complete all assessments with `remaining_balance > 0` → status remains active/credit-balance, not `exhausted`.
- Complete all assessments with `remaining_balance = 0` → `exhausted`.

**Tests:** `T-01`, `T-04`.

---

### WP-A2 — Idempotent create and renew (C-02, C-07)

**Files**

- `src/server/services/printingRecordsService.ts`
- `src/server/routes/printingRoutes.ts`
- `src/services/printingApi.ts`

**Changes**

1. Define idempotency routes:
   - `printing_contract_create`
   - `printing_contract_renew`
   - `printing_contract_topup`
2. At the start of `createPrintingContract`:
   - Read `idempotencyKey` from input.
   - If present, query `request_keys` for `(company_id, route, idempotency_key)`.
   - If found and `payload_hash` matches, return the full create result plus `idempotentReplay: true` without posting again.
   - If found with a different hash, throw 409 `IDEMPOTENCY_CONFLICT`.
3. At the end of a successful create, insert into `request_keys` with the canonical payload hash and `{ contractId, contractNumber }`.
4. Pass the same key to `postJournalEntry` so the deposit journal is also idempotent.
5. Do the same for `renewPrintingContract` and the new top-up service.
6. Update `printingApi.createContract`, `renewContract`, and `topUpContract` to send the `idempotency-key` header.
7. Update `PrintingContractsView` to generate a stable key per form session (e.g., `contract-create-${crypto.randomUUID()}`) and reuse it on retry.

**Acceptance criteria**

- Two identical create requests with the same key → one contract, one journal, second returns 200 replay.
- Two identical renew requests with the same key → one new contract, one journal.
- Same key with a different payload → 409 `IDEMPOTENCY_CONFLICT`.
- No key → still allowed for backward compatibility, but the UI always sends one.

**Tests:** `T-01`, `T-03`, `T-07`.

---

### WP-A3 — Cancel with explicit settlement (C-03)

**Files**

- `db/migrations/0020...up.sql`
- `src/server/services/printingRecordsService.ts`
- `src/server/routes/printingRoutes.ts`
- `src/services/printingApi.ts`
- `src/components/views/PrintingContractsView.tsx`
- `src/context/AccountingContext.tsx`

**Schema additions**

```sql
ALTER TABLE printing_contracts
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN cancelled_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN cancellation_reason TEXT,
  ADD COLUMN settlement_mode VARCHAR(16)
    CHECK (settlement_mode IN ('refund', 'forfeit')),
  ADD COLUMN settled_amount NUMERIC(19,4) NOT NULL DEFAULT 0.0000
    CHECK (settled_amount >= 0),
  ADD COLUMN settlement_journal_txn_id BIGINT
    REFERENCES journal_transactions(company_id, id) ON DELETE RESTRICT;
```

**Service changes**

`setPrintingContractStatus(..., 'cancel', reason, options)` where `options.settlementMode: 'refund' | 'forfeit'`:

1. Lock the contract `FOR UPDATE`.
2. If `status === 'cancelled'` → 409.
3. If `remaining_balance > 0` and no `settlementMode` → 400 `SETTLEMENT_MODE_REQUIRED`.
4. If `settlementMode === 'refund'`:
   - Post Dr `liability_account_id` / Cr `deposit_bank_account_id` for `remaining_balance`.
   - Insert a `bank_transactions` row: `txn_type = 'Debit'`, `amount = remaining_balance`, `ref_number = contract_number`, `journal_txn_id = posted.id`, `payee = school name`, `memo = 'Refund of unearned contract balance'`.
   - Set `settled_amount = remaining_balance`, `settlement_journal_txn_id = posted.id`.
5. If `settlementMode === 'forfeit'`:
   - Post Dr `liability_account_id` / Cr income account for `remaining_balance`.
   - Set `settled_amount = remaining_balance`, `settlement_journal_txn_id = posted.id`.
6. Set `remaining_balance = 0`, `status = 'cancelled'`, `cancelled_at = NOW()`, `cancelled_by = actor.userId`, `cancellation_reason = reason`.
7. Audit with old/new status, settlement mode, settled amount, journal id.
8. If `remaining_balance === 0`, skip the journal and just cancel.

**Activation change**

- `activate` from `cancelled` is allowed **only if** `settled_amount = 0` and `remaining_balance > 0`. Otherwise throw 409 `CONTRACT_SETTLED_CANNOT_REACTIVATE` and direct the user to renew/top-up.

**UI changes**

- Replace the single "Cancel Contract" action with a confirmation modal:
  - Shows remaining balance.
  - Radio: `Refund remaining balance` (default) / `Forfeit remaining balance`.
  - Reason textarea (required).
  - Explains the journal entry.
- `cancelPrintingContract` becomes async and awaits the backend; toast only on success.

**Acceptance criteria**

- Cancel with remaining > 0 and no mode → 400.
- Cancel with `refund` → liability reduced to 0, bank credited, `bank_transactions` row created, status cancelled.
- Cancel with `forfeit` → liability reduced to 0, income credited, status cancelled.
- Cancel with remaining = 0 → no journal, status cancelled.
- Reactivation after settlement → 409.
- Double cancel → 409.

**Tests:** `T-03`.

---

### WP-A4 — Renew with an explicit new deposit (C-04)

**Files**

- `src/server/services/printingRecordsService.ts`
- `src/server/routes/printingRoutes.ts`
- `src/services/printingApi.ts`
- `src/components/views/PrintingContractsView.tsx`
- `src/context/AccountingContext.tsx`

**Changes**

1. Change `renewPrintingContract` input to:
   ```ts
   {
     depositAmount: string | number;
     depositBankAccountId: number;
     depositDate: string;      // default today
     startDate: string;
     endDate: string;
     idempotencyKey?: string;
     assessments?: ContractAssessmentInput[]; // optional new schedule
   }
   ```
2. Validate:
   - `depositAmount > 0`.
   - Bank account exists, is active, and `account_type = 'Bank'`.
   - `endDate >= startDate`.
   - If `assessments` provided, their sum must equal `depositAmount` (WP-A1).
3. Post the deposit journal with `txnDate = depositDate`, `reference = newContractNumber`, `sourceType = 'printing_contract'`.
4. Insert the `bank_transactions` deposit row (WP-A6).
5. Create the new contract with the new dates/amount/schedule.
6. Do **not** reuse the old `start_date`, `end_date`, or `total_prepaid_amount`.
7. UI: "Renew Contract" opens a modal with amount, bank account, deposit date, new start/end dates, and an optional schedule editor. The old contract remains `exhausted`/`cancelled`.

**Acceptance criteria**

- Renew without `depositAmount` → 400.
- Renew with `depositAmount` → one new contract, one deposit journal, one bank transaction.
- Renew with the same idempotency key twice → one new contract.
- Old contract unchanged.

**Tests:** `T-03`.

---

### WP-A5 — Collision-safe number generation (C-05)

**Files**

- `db/migrations/0020...up.sql`
- `src/server/services/printingRecordsService.ts`
- `src/server/services/productionService.ts` (exam papers)

**Schema**

```sql
CREATE TABLE printing_number_counters (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  scope      VARCHAR(32) NOT NULL,   -- 'contract' | 'exam_paper' | 'delivery' | ...
  year       SMALLINT NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, scope, year)
);
ALTER TABLE printing_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE printing_number_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY p_printing_number_counters_isolation ON printing_number_counters
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));
```

**Function**

```sql
CREATE FUNCTION next_printing_number(
  p_company_id BIGINT, p_scope TEXT, p_year SMALLINT, p_prefix TEXT, p_width INT
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_last INT;
BEGIN
  INSERT INTO printing_number_counters (company_id, scope, year, last_value)
  VALUES (p_company_id, p_scope, p_year, 1)
  ON CONFLICT (company_id, scope, year)
  DO UPDATE SET last_value = printing_number_counters.last_value + 1
  RETURNING last_value INTO v_last;
  RETURN p_prefix || p_year || '-' || LPAD(v_last::TEXT, p_width, '0');
END;
$$;
```

**Service changes**

- Replace `MAX(contract_number)` logic with `next_printing_number(companyId, 'contract', year, 'CTR-', 4)`.
- Replace `MAX(job_number)` logic with `next_printing_number(companyId, 'exam_paper', year, 'EXM-', 5)`.
- Width 4 supports 9,999 contracts/year; width 5 supports 99,999 exam papers/year.

**Acceptance criteria**

- 150 sequential creates → unique numbers `CTR-YYYY-0001` … `CTR-YYYY-0150`.
- 20 concurrent creates → 20 unique numbers, no 23505.
- Existing numbers are preserved; new numbers continue after the current max (backfill the counter).

**Tests:** `T-07`.

---

### WP-A6 — Bank subledger row for deposits and settlements (C-06)

**Files**

- `src/server/services/printingRecordsService.ts`
- `src/server/services/accountingEngine.ts` (optional shared helper)

**Changes**

1. Add a helper `recordBankTransaction(tx, {...})` in `printingRecordsService.ts` (or a shared `bankingService` helper):
   - Insert into `bank_transactions` with `company_id`, `account_id = depositBankAccountId`, `txn_date`, `payee`, `txn_type`, `ref_number = contractNumber`, `memo`, `amount`, `running_balance`, `journal_txn_id`, `category`.
   - Compute `running_balance` from the current bank account balance plus/minus the amount, or leave 0 and let the banking view compute it. Prefer computing it to keep the register consistent.
2. Call it after:
   - `createPrintingContract` (Deposit).
   - `renewPrintingContract` (Deposit).
   - `topUpContract` (Deposit).
   - `cancel` with `refund` (Debit).
3. Update `listContractWalletTransactions` to read `bank_transactions` **and** fall back to journal lines when no bank rows exist (for legacy contracts).

**Acceptance criteria**

- After create, `bank_transactions` has one Deposit row with `journal_txn_id` matching the deposit journal.
- After refund cancel, one Debit row.
- Wallet modal shows the deposit and any refund, and the running balance reconciles to `remaining_balance` at each point.
- Bank reconciliation includes contract deposits.

**Tests:** `T-06`.

---

### WP-A7 — Fail-closed frontend mutations (C-08, C-09)

**Files**

- `src/context/AccountingContext.tsx`
- `src/components/views/PrintingContractsView.tsx`
- `src/components/modals/ContractActionModals.tsx`
- `src/services/http.ts`

**Principles**

- For any contract with `backendId`, the backend is authoritative.
- For local demo contracts (no `backendId`), keep the local ledger path, but mark them `source: 'local'` and never mix them with backend contracts in financial reports.
- Never mutate local accounts/bank transactions when the backend returns a 4xx.
- Await every backend call before showing success.
- On network failure, show a recoverable error and keep the form open; do not post locally.

**Implementation**

1. Add a helper in `AccountingContext`:
   ```ts
   async function mutateContract<T>(
     backendCall: () => Promise<T>,
     options: { fallbackLocal?: () => void; financial: boolean }
   ): Promise<T>
   ```
   - `try` backend call.
   - On `ApiError` with `status >= 400 && < 500` → rethrow (no local fallback).
   - On network error (`TypeError`, `fetch failed`) → if `financial` rethrow; else allow fallback only for non-financial demo data.
2. Change `addPrintingContract`:
   - If `backendCustomerId && backendBankAccountId`, call the API.
   - On 4xx, rethrow and show the error; do not create a local contract.
   - On network error, rethrow with a clear message ("Cannot reach the server. No contract was created.").
   - Only use the local path when there is no backend (demo mode) and the user is not authenticated against a server.
3. Change `completeContractAssessment`, `cancelPrintingContract`, `activatePrintingContract`, `renewPrintingContract`, `amendPrintingContract`, `addContractAssessment`, `removeContractAssessment`, `updateContractAssessment` to `async` and:
   - Await the backend call.
   - Update local state only after success (or update optimistically and roll back on error).
   - Return `{ ok: true, data }` or throw.
4. Update all call sites:
   - `PrintingContractsView` action handlers `await` the call; toast success only after it resolves; toast error on rejection.
   - Disable the relevant buttons while `contractActionBusy` is true.
   - `ContractActionModals` submit handlers `await` and close only on success.
5. Add a small `useContractMutation` hook to standardize pending/error state.

**Acceptance criteria**

- Backend 400 on create → no local contract, no local ledger change, error toast.
- Backend 500/network on complete → local state unchanged, error toast, milestone still pending.
- Backend success on complete → local state updates once, success toast.
- Rapid double-click on complete → one journal, one deduction.
- Cancel/renew/amend/add/remove show success only after the server confirms.

**Tests:** `T-04`, `T-08`, frontend context tests.

---

## 6. Phase B — Data Consistency and Links (S2)

### WP-B1 — Persist invoice links (H-10, H-11, H-14, H-15)

**Schema**

```sql
ALTER TABLE printing_contracts
  ADD COLUMN deposit_invoice_id BIGINT REFERENCES invoices(company_id, id) ON DELETE RESTRICT,
  ADD COLUMN deposit_invoice_number VARCHAR(64);
```

For milestones, `linked_invoice_id` already exists; add `linked_invoice_number` if not present (it is not in 0007). Add it.

**Service**

- `hydrateContract` returns `depositInvoiceId`, `depositBackendInvoiceId`, `depositInvoiceNumber`.
- `serializeMilestone` returns `linkedInvoiceId` (number), `linkedInvoiceNumber`.
- Add `linkContractDepositInvoice(tx, companyId, actor, contractId, { invoiceId, invoiceNumber })`.
- Add `linkMilestoneInvoice(tx, companyId, actor, contractId, assessmentNumber, { invoiceId, invoiceNumber })`.
- Audit both.

**Documents**

- `mapContractToPreviewModel` milestone payload adds:
  ```ts
  postgresContractId: contract.backendId,
  postgresMilestoneNumber: nextPending.assessmentNumber,
  ```
- `PrintingContractsView.openContractPreview` `onInvoiceGenerated` handles both:
  - If it was a retainer invoice (no deposit invoice before), call `linkContractDepositInvoice`.
  - If it was a milestone invoice, call `linkMilestoneInvoice` with `nextPending.assessmentNumber`.
- `handleGenerateMilestoneInvoice` calls `linkMilestoneInvoice` after generation.

**Frontend mapping**

- `mapApiContract` maps the new fields.
- `PrintingContract` type adds `depositInvoiceId`, `depositBackendInvoiceId`, `depositInvoiceNumber`.
- `ContractAssessmentMilestone` already has the fields; map them.

**Acceptance criteria**

- Create contract → generate retainer invoice → refresh page → "Preview Retainer Invoice" still visible.
- Generate milestone invoice → refresh → milestone shows the linked invoice number and "Preview Linked Invoice".
- `contract_assessment_milestones.linked_invoice_id` and `linked_invoice_number` are populated.
- `printing_contracts.deposit_invoice_id` is populated.
- Generating the same milestone invoice twice does not create a second invoice (idempotency key).

**Tests:** `T-02`, `T-05`, document integration test extension.

---

### WP-B2 — Assessment add/remove/update hardening (H-01, H-02, H-12)

**Service**

- `addContractAssessment`:
  - `loadContract(..., FOR UPDATE)`.
  - Require `status = 'active'`.
  - Require `assessmentNumber` between 1 and 5.
  - Require the number is not already used.
  - Enforce the sum invariant (WP-A1).
- `removeContractAssessment`:
  - `loadContract(..., FOR UPDATE)`.
  - Require `status = 'active'`.
  - Require `total_assessments > 2`.
  - Require milestone `pending`.
- `updateContractAssessment`:
  - `loadContract(..., FOR UPDATE)`.
  - Require `status = 'active'`.
  - Enforce the sum invariant.
- `amendPrintingContract`:
  - `loadContract(..., FOR UPDATE)`.
  - Allow title/academicYear/notes for any status.
  - Allow date changes only when `status = 'active'` and no assessment is completed; otherwise 409 `CONTRACT_DATES_LOCKED`.

**UI**

- `AddAssessmentModal`:
  - `nextNumber = first free slot in 1..5`, not `length + 1`.
  - Show "Remaining allocatable: X".
  - Disable submit if `agreedAmount > remainingAllocatable`.
- `RemoveAssessmentModal`: only list pending assessments (already does).
- `AmendContractModal`: disable date fields when `completedAssessments > 0`, with a tooltip.

**Acceptance criteria**

- Remove #3 from [1,2,3,4] → [1,2,4]; add → #3 (not #4).
- Add to a 5-assessment contract → 400.
- Add to a cancelled/exhausted contract → 400 `CONTRACT_NOT_ACTIVE`.
- Update an assessment on a cancelled contract → 400.
- Amend dates after a completion → 409 `CONTRACT_DATES_LOCKED`.
- Sum invariant enforced on add/update.

**Tests:** `T-04`.

---

### WP-B3 — Exam batch contract validation (H-03, M-08)

**Service**

In `createExamBatch`, when `contractId` is provided:

1. Load the contract `FOR UPDATE` (or at least a consistent read).
2. Verify `contract.school_customer_id === schoolCustomerId`; else 400 `CONTRACT_SCHOOL_MISMATCH`.
3. Verify `assessmentNumber` is between 1 and `contract.total_assessments`; else 400 `ASSESSMENT_OUT_OF_RANGE`.
4. Verify the assessment exists and is `pending`; else 409 `ASSESSMENT_NOT_PENDING`.
5. Optionally verify `contract.status = 'active'`; else 409 `CONTRACT_NOT_ACTIVE`.

**UI**

- When creating an exam batch from a contract, pre-select the contract and assessment; disable invalid combinations.

**Acceptance criteria**

- Batch for School A referencing School B's contract → 400.
- `assessmentNumber = 6` on a 5-assessment contract → 400.
- Completed assessment → 409.
- Valid link → 201.

**Tests:** `T-05`.

---

### WP-B4 — Exam paper status transitions (H-04)

**Service**

- Allowed transitions:
  - `queued → printing`
  - `printing → completed`
  - `printing → queued` (rework, requires `reason`)
  - No transition out of `completed` or `invoiced`.
- Add `status_reason` column? Optional; at minimum audit the change.
- Block `completed → *` and `invoiced → *` with 409 `INVALID_EXAM_STATUS_TRANSITION`.

**Acceptance criteria**

- `queued → completed` → 400.
- `completed → queued` → 409.
- `printing → completed` → 200.
- `invoiced → printing` → 409.

**Tests:** `T-05`.

---

### WP-B5 — Error mapping and safe messages (H-07, H-08, L-05)

**Route**

```ts
if (pgCode === '23505') return 409 ...
if (pgCode === '23514') return 409 ...
if (pgCode === '23001') return 409 ...
if (pgCode === '23503') return 409 { code: 'FOREIGN_KEY_CONSTRAINT' }
if (pgCode === '22P02' || pgCode === '22007') return 400 { code: 'INVALID_VALUE' }
if (pgCode === '23502') return 400 { code: 'MISSING_REQUIRED_FIELD' }
if (pgCode === '40001') return 409 { code: 'SERIALIZATION_CONFLICT' }
```

- For unknown errors: log the full error server-side with the correlation id; return `{ error: 'Internal server error', requestId }` with 500.
- Never return `err.message` for unknown errors.

**Acceptance criteria**

- Invalid date string → 400 `INVALID_VALUE`.
- Delete an exam paper linked to a job → 409 `FOREIGN_KEY_CONSTRAINT`.
- Missing required field → 400 `MISSING_REQUIRED_FIELD`.
- Unknown error → 500 generic + requestId; no DB text.

**Tests:** `T-08`.

---

### WP-B6 — Top-up / additional deposit (H-09)

**Route**

`POST /printing/contracts/:id/deposits` with `requirePermission('printing:contracts:manage')` (or `printing:write` until WP-C8).

**Service**

```ts
topUpContract(tx, companyId, actor, contractId, {
  amount, bankAccountId, depositDate, idempotencyKey, notes?
})
```

1. Lock contract `FOR UPDATE`.
2. Require `status = 'active'`.
3. Validate bank account (Bank, active).
4. Validate `amount > 0`.
5. Post Dr Bank / Cr `liability_account_id` for `amount`.
6. Insert `bank_transactions` Deposit row.
7. `UPDATE printing_contracts SET total_prepaid_amount = total_prepaid_amount + amount, remaining_balance = remaining_balance + amount`.
8. Audit `PRINTING_CONTRACT_TOPPED_UP`.
9. Idempotency via `request_keys` route `printing_contract_topup`.

**UI**

- Add a "Top Up Retainer" action on active contracts.
- Modal: amount, bank account, date, notes.
- Show new total and remaining.

**Acceptance criteria**

- Top-up posts one balanced journal and one bank transaction.
- `total_prepaid_amount` and `remaining_balance` increase by the amount.
- Double submit with same key → one top-up.
- Top-up on cancelled/exhausted → 409.

**Tests:** `T-03`.

---

### WP-B7 — Attachment entity ID (M-09)

**File**

- `src/components/views/PrintingContractsView.tsx:518-525`

**Change**

```ts
const entityId = selectedContract.backendId ?? Number(selectedContract.id);
if (!entityId) { triggerShortcutNotice('Save the contract to the server before attaching files', 'error'); return; }
await documentsApi.uploadAttachment({ ..., entityType: 'printing_contract', entityId, ... });
```

**Acceptance criteria**

- Upload on contract #7 → attachment row `entity_id = 7`.
- Contract preview for #7 lists the attachment.
- Contract #1 does not list it.

**Tests:** document integration test extension.

---

## 7. Phase C — Correctness and Robustness (S3)

### WP-C1 — Date validation (H-05)

- Replace `assertIsoDate` with a real calendar check:
  ```ts
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) throw ...
  ```
- Enforce `startDate <= scheduledDate <= endDate` for every assessment.
- Enforce `assessmentNumber` unique and within 1..`totalAssessments`.
- Use a shared `todayIsoDate()` (DB `CURRENT_DATE` or company timezone).

### WP-C2 — Account resolution hardening (M-02)

- `resolveLiabilityAccount`: codes `['2250','2200','2100','2300']`; if none, throw `NO_CONTRACT_LIABILITY_ACCOUNT`. Remove the `PayrollLiability` fallback.
- `resolveIncomeAccount`: codes `['4000','4010','4900']`; if none, throw `NO_INCOME_ACCOUNT`. Remove the generic income fallback.
- Add a company-settings check at contract creation: both accounts must exist and be active.

### WP-C3 — Timezone-safe dates (M-03)

- Add `todayIsoDate()` in `src/server/lib/dates.ts`:
  ```ts
  export function todayIsoDate(): string {
    return new Date().toISOString().slice(0, 10);
  }
  ```
  Or, better, `SELECT CURRENT_DATE` in the DB for consistency.
- Use it in `completeContractAssessment`, `createExamBatch` defaults, and invoice dates.

### WP-C4 — Refresh precedence and race handling (M-10, M-11)

- Add `source: 'backend' | 'local'` to `PrintingContract` (or infer from `backendId`).
- `refreshPrintingContractsFromBackend`:
  - If `list.length > 0` → replace backend contracts, keep local-only contracts only if `!isServerEdition`.
  - If `list.length === 0` and `isServerEdition` → set `[]`.
  - If `list.length === 0` and `!isServerEdition` → keep demo.
- Replace the global refresh on every `ACCOUNTING_UPDATED_EVENT` with:
  - A targeted `refreshContract(id)` after each mutation.
  - A debounced full refresh (e.g., 500 ms) for external events.
- Add a `refreshVersion` ref to discard stale responses.

### WP-C5 — Wallet reconciliation (M-12)

- After WP-A6, read `bank_transactions` for the contract.
- Compute the running balance from the contract's liability journal lines:
  ```sql
  SELECT l.debit, l.credit, t.txn_date, t.entry_number, t.description
  FROM journal_lines l
  JOIN journal_transactions t ON t.company_id = l.company_id AND t.id = l.transaction_id
  WHERE l.company_id = $1 AND l.account_id = $2
    AND (t.reference = $3 OR (t.source_type = 'printing_contract' AND t.source_id = $4))
  ORDER BY t.txn_date, t.id
  ```
- Display "Per bank register" and "Per GL" side by side, with a variance indicator.
- The modal must end at `remainingBalance`.

### WP-C6 — Serialization parity and types (M-04, M-05, M-13, M-14)

- `PrintingContract`:
  - Add `liabilityAccountId?: number`, `updatedAt?: string`, `depositInvoiceId?`, `depositBackendInvoiceId?`, `depositInvoiceNumber?`, `source?: 'backend' | 'local'`.
- `ContractAssessmentMilestone`:
  - Add `linkedInvoiceNumber?` (already), `backendInvoiceId?` (already).
- `hydrateContract` returns all fields.
- `mapApiContract` maps all fields.
- `ContractInfoModal` uses `contract.liabilityAccountId` instead of `(contract as any)`.
- `nextPending` filter uses `!a.linkedInvoiceId && !a.backendInvoiceId`.

### WP-C7 — N+1, pagination, filters (M-01, M-06, M-07)

- `listPrintingContracts`: one query for contracts, one query for all milestones `WHERE contract_id = ANY($2)`, group in memory.
- Add query params:
  - `GET /printing/contracts?status=&customerId=&limit=&offset=`
  - `GET /printing/exam-papers?contractId=&assessmentNumber=&status=&limit=&offset=`
  - `GET /printing/jobs?status=&customerId=&limit=&offset=`
- Add `GET /printing/exam-batches?contractId=&schoolCustomerId=`.
- Return `{ items, total, limit, offset }` for paginated endpoints.

### WP-C8 — RBAC split and rate limiting (M-15, M-16)

- Add permission `printing:contracts:manage`.
- Grant to Administrator, Bookkeeper, Accountant. Do **not** grant to ProductionManager by default.
- Require `printing:contracts:manage` for:
  - create contract
  - top-up
  - cancel with settlement
  - renew
  - complete assessment (revenue recognition)
  - add/remove/update assessment
- Keep `printing:write` for production operations (jobs, materials, QC, delivery).
- Add rate limits in `app.ts`:
  - `POST /printing/contracts`, `/renew`, `/:id/deposits`, `/:id/assessments/:n/complete` → e.g., 20/min per user.
- Update `ROLE_DEFINITIONS` and the permission matrix test.

### WP-C9 — Persist `exam_batch_note` (H-06)

- Add `exam_batch_note` to the INSERT in `addContractAssessment` and `createPrintingContract`.
- Add it to `ContractAssessmentInput` (create path).
- Map it in `serializeMilestone` (already).

### WP-C10 — Rounding parity (L-02, L-07)

- Replace client `round2` with a shared helper:
  ```ts
  import { parseDecimal4, formatDecimal2 } from '../server/lib/decimal';
  export function round2(v: number): number {
    return Number(formatDecimal2(parseDecimal4(v), 'HALF_EVEN'));
  }
  ```
- Use it in `PrintingContractsView`, `ContractActionModals`, and `AccountingContext`.
- Change `customMismatch` tolerance to `0.005`.
- Add a test that client and server produce the same 2-dp result for half-cent cases.

---

## 8. Phase D — Schema, Backfill and Migration

### WP-D1 — Migration 0020

Create `db/migrations/0020_printing_contract_settlement_and_links.up.sql` and `.down.sql`.

**Up**

1. `printing_contracts`:
   - `deposit_invoice_id`, `deposit_invoice_number`
   - `cancelled_at`, `cancelled_by`, `cancellation_reason`
   - `settlement_mode`, `settled_amount`, `settlement_journal_txn_id`
   - `currency_code VARCHAR(3) NOT NULL DEFAULT 'ZMW'`
   - `version INTEGER NOT NULL DEFAULT 1`
2. `contract_assessment_milestones`:
   - `linked_invoice_number VARCHAR(64)`
   - `completed_by BIGINT REFERENCES users(id) ON DELETE RESTRICT`
   - `completed_at TIMESTAMPTZ`
3. `printing_number_counters` table + RLS + `next_printing_number` function.
4. Trigger `trg_validate_contract_assessment_sum` (deferred).
5. Indexes:
   - `ix_printing_contracts_company_status`
   - `ix_contract_milestones_company_status`
   - `ix_contract_milestones_contract_number`
6. Backfill counters:
   ```sql
   INSERT INTO printing_number_counters (company_id, scope, year, last_value)
   SELECT company_id, 'contract', EXTRACT(YEAR FROM start_date)::SMALLINT,
          COALESCE(MAX(CAST(split_part(contract_number, '-', 3) AS INTEGER)), 0)
   FROM printing_contracts GROUP BY company_id, EXTRACT(YEAR FROM start_date);
   ```
   (Guard against non-numeric suffixes.)
7. Backfill `currency_code` from `companies.currency`.
8. Backfill `completed_at = completed_date::TIMESTAMPTZ` where `status = 'completed'`.

**Down**

- Drop trigger, function, counters table, new columns, indexes. Reverse order.
- Do not drop data needed by older code.

### WP-D2 — Backfill verification

- `SELECT COUNT(*) FROM printing_contracts WHERE remaining_balance < 0` → 0.
- `SELECT COUNT(*) FROM contracts WHERE remaining_balance > total_prepaid_amount` → 0.
- `SELECT contract_id, SUM(agreed_amount), total_prepaid_amount` → no mismatches (if legacy mismatches exist, quarantine them in a report and require manual adjustment before enabling the trigger).
- `SELECT COUNT(*) FROM printing_number_counters` → one row per company/year.

### WP-D3 — Migration test

- Add to `tests/db/migration-suite.ts`:
  - Apply 0020 up.
  - Insert a contract + assessments that sum correctly → passes.
  - Insert a mismatch → fails.
  - Call `next_printing_number` 150 times → unique.
  - Apply down → schema returns to 0019.

---

## 9. Phase E — Test and Certification

### WP-E1 — Service tests (`tests/printing/contracts.test.ts`)

Use the existing in-memory pglite harness (`createServerDatabase(cfg, { inMemory: true, seedDemo: true })`) and `db.withCompanyDb`.

| Test | Covers |
|---|---|
| Create contract happy path | C-01, C-02, A6 |
| Create with sum < prepaid → 400 | C-01 |
| Create with sum > prepaid → 400 | C-01 |
| Create with duplicate idempotency key → replay | C-02 |
| Create with same key, different payload → 409 | C-02 |
| Complete assessment → balanced journal, remaining reduced | C-01, A3 |
| Complete twice → 409 | A3 |
| Complete all → exhausted, remaining 0 | A3 |
| Cancel with refund → liability 0, bank credited, status cancelled | C-03 |
| Cancel with forfeit → liability 0, income credited | C-03 |
| Cancel without settlement mode → 400 | C-03 |
| Renew with deposit → new contract, new journal | C-04 |
| Renew without deposit → 400 | C-04 |
| Top-up → totals increase, journal balanced | H-09 |
| Add assessment happy path | H-02, H-12 |
| Add assessment after removal → correct number | H-12 |
| Add to 5-assessment contract → 400 | H-02 |
| Add to cancelled contract → 400 | H-02 |
| Remove pending assessment | H-02 |
| Remove completed assessment → 400 | H-02 |
| Update pending assessment | H-02 |
| Update completed assessment → 400 | H-02 |
| Amend active contract | H-01 |
| Amend dates after completion → 409 | H-01 |
| Exam batch with cross-school contract → 400 | H-03 |
| Exam batch with out-of-range assessment → 400 | H-03 |
| Exam paper status transitions | H-04 |
| 150 sequential contract numbers | C-05 |
| 20 concurrent contract numbers | C-05 |

### WP-E2 — API tests

Extend `tests/documents/documents-and-invoicing.test.ts` or add `tests/printing/contracts-api.test.ts`:

- `POST /api/printing/contracts` with idempotency key → 201, replay 200.
- `POST /api/printing/contracts/:id/cancel` with refund → 200, bank transaction exists.
- `POST /api/printing/contracts/:id/renew` → 201, new contract.
- `POST /api/printing/contracts/:id/deposits` → 201.
- `POST /api/printing/contracts/:id/assessments/:n/complete` twice → 200 then 409.
- RBAC: ProductionManager can create a job but cannot complete an assessment (after WP-C8).
- Error mapping: invalid date → 400; FK violation → 409; unknown → 500 generic.

### WP-E3 — Concurrency tests

- 20 parallel `createPrintingContract` calls → 20 unique numbers, 20 contracts, 20 balanced journals.
- 10 parallel `completeContractAssessment` on the same milestone → exactly 1 success, 9 × 409.
- 10 parallel `cancel` on the same contract → exactly 1 success.
- 10 parallel `topUp` with the same idempotency key → exactly 1 top-up.

### WP-E4 — Frontend/context tests

- Mock `printingApi` to reject with 400 on create → context does not add a contract and does not mutate accounts.
- Mock reject on complete → milestone remains pending and an error is surfaced.
- Mock success → state updates once.
- Refresh with backend non-empty → local demo contracts handled per WP-C4.
- `mapApiContract` preserves deposit/milestone invoice links.

### WP-E5 — UAT script

A step-by-step script for a school bursar:

1. Create a 4-assessment contract with K80,000, split evenly.
2. Verify the deposit journal and bank transaction.
3. Generate the retainer invoice and preview it.
4. Complete assessment #1 → verify remaining K60,000 and the income journal.
5. Generate the assessment #1 invoice → verify the milestone link.
6. Add a pending assessment → verify numbering.
7. Cancel with refund → verify the refund journal and bank debit.
8. Renew with a new deposit → verify the new contract and journal.
9. Reload the page after each step → verify nothing disappears.

### WP-E6 — Reconciliation and shadow run

- Run 30 days of production-like data in a staging DB.
- Compare:
  - `SUM(remaining_balance)` vs liability account balance.
  - `SUM(agreed_amount)` per contract vs `total_prepaid_amount`.
  - `SUM(bank_transactions.amount)` for deposits/debits vs bank account movement.
  - `SUM(journal_lines)` vs `SUM(bank_transactions)` for contract-related entries.
- Target: **0.00 variance** in all three.
- Sign off with a one-page certificate appended to the audit report.

---

## 10. Phase F — Polish and Documentation

### WP-F1 — UX and docs

- Add an empty state to `PrintingContractsView` when no contracts exist.
- Add a "Top Up Retainer" action and modal.
- Add a cancellation settlement modal.
- Add a renewal modal with deposit details.
- Add a "Contract History" endpoint backed by `audit_log`:
  - `GET /printing/contracts/:id/history` returns audit events for the contract and its milestones.
- Add `docs/printing-contracts.md`:
  - Lifecycle diagram.
  - Accounting entries for create/complete/refund/forfeit/top-up/renew.
  - Invariants.
  - Idempotency keys.
  - RBAC matrix.

### WP-F2 — Type and lint cleanup

- Remove `as any` casts in `ContractInfoModal`.
- Fix `totalAssessments` cast with a runtime guard.
- Run `npm run lint`.
- Ensure no `console.log` in production paths.

---

## 11. Traceability Matrix

| Finding | Work package | Test |
|---|---|---|
| C-01 | WP-A1 | T-01, T-04 |
| C-02 | WP-A2 | T-01, T-03 |
| C-03 | WP-A3 | T-03 |
| C-04 | WP-A4 | T-03 |
| C-05 | WP-A5 | T-07 |
| C-06 | WP-A6 | T-06 |
| C-07 | WP-A2 | T-01, T-03 |
| C-08 | WP-A7 | T-04, T-08 |
| C-09 | WP-A7 | T-04, T-08 |
| H-01 | WP-B2 | T-04 |
| H-02 | WP-B2 | T-04 |
| H-03 | WP-B3 | T-05 |
| H-04 | WP-B4 | T-05 |
| H-05 | WP-C1 | T-08 |
| H-06 | WP-C9 | T-04 |
| H-07 | WP-B5 | T-08 |
| H-08 | WP-B5 | T-08 |
| H-09 | WP-B6 | T-03 |
| H-10 | WP-B1 | T-02 |
| H-11 | WP-B1 | T-02 |
| H-12 | WP-B2 | T-04 |
| H-13 | WP-A7 | T-04, T-08 |
| H-14 | WP-B1 | T-02 |
| H-15 | WP-B1 | T-02 |
| M-01 | WP-C7 | T-02 |
| M-02 | WP-C2 | T-08 |
| M-03 | WP-C3 | T-02 |
| M-04 | WP-C6 | T-02 |
| M-05 | WP-C6 | T-02 |
| M-06 | WP-C7 | T-08 |
| M-07 | WP-C7 | T-05 |
| M-08 | WP-B3 | T-05 |
| M-09 | WP-B7 | T-02 |
| M-10 | WP-C4 | T-09 |
| M-11 | WP-C4 | T-09 |
| M-12 | WP-C5 | T-06 |
| M-13 | WP-C6 | T-02 |
| M-14 | WP-C6 | T-02 |
| M-15 | WP-C8 | T-08 |
| M-16 | WP-C8 | T-08 |
| L-01 | WP-F2 | T-04 |
| L-02 | WP-C10 | T-01 |
| L-03 | WP-F1 | T-09 |
| L-04 | WP-F1 | T-08 |
| L-05 | WP-B5 | T-08 |
| L-06 | WP-F1 | — |
| L-07 | WP-C10 | T-01 |

---

## 12. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Legacy contracts have assessment sums ≠ prepaid total | High | Migration trigger blocks inserts/updates | Pre-migration audit; quarantine and adjust legacy data; make the trigger `NOT VALID` + `VALIDATE CONSTRAINT` after cleanup |
| Renewal UX change breaks existing workflows | Medium | Users cannot renew as before | Keep a "quick renew" path that asks only for the deposit amount/date, with sensible defaults |
| RBAC split locks out ProductionManagers | Medium | Production staff cannot manage contracts | Grant `printing:contracts:manage` to a `ProductionManager` variant if needed; document the matrix |
| Idempotency keys collide across users | Low | Wrong replay | Scope keys by `company_id` and `actor_user_id` if necessary; include a form/session UUID |
| Migration 0020 is large | Medium | Deployment risk | Split into 0020 (columns/indexes), 0021 (trigger/counters), 0022 (backfill) if needed |
| Client/server rounding differs by 0.01 | Low | Reconciliation variance | WP-C10 shared helper + test |
| Bank subledger double-counts with journal | Medium | Cash overstated | Define `bank_transactions` as the bank-side subledger; never post the same movement twice; add a reconciliation test |

---

## 13. Definition of Done / Certification Checklist

- [ ] All S1 findings closed and verified by tests.
- [ ] All S2 findings closed and verified by tests.
- [ ] All S3 findings closed and verified by tests.
- [ ] `npm run lint` passes with zero errors.
- [ ] `npm run test:printing` passes.
- [ ] `npm run test:documents` passes.
- [ ] `npm run test:workflows` passes.
- [ ] `npm run test:db` passes.
- [ ] `npm run test:printing-contracts` passes (new).
- [ ] Migration 0020 applies up and down cleanly on a seeded DB.
- [ ] 20 concurrent creates produce 20 unique contract numbers.
- [ ] 10 concurrent completes produce exactly 1 success.
- [ ] Double-submit create/renew/complete produces exactly one posting.
- [ ] Cancel with refund and forfeit both balance to zero.
- [ ] Renew requires and records a real deposit.
- [ ] Wallet modal reconciles to `remaining_balance`.
- [ ] Contract preview and milestone invoice links survive a refresh.
- [ ] Attachment uploads target the correct contract.
- [ ] RBAC matrix updated and tested.
- [ ] 30-day shadow run shows 0.00 variance.
- [ ] `docs/printing-contracts.md` published.
- [ ] Audit report updated with the certification results.

---

## 14. Suggested Execution Order (First Two Weeks)

| Day | Work |
|---|---|
| 1 | WP-00.1, WP-00.2 |
| 2–3 | WP-D1 (columns/counters/trigger), WP-A1, WP-A5 |
| 4–5 | WP-A2, WP-A6, WP-A7 (create/complete fail-closed) |
| 6–7 | WP-A3, WP-A4 (cancel/renew) |
| 8–9 | WP-B1, WP-B2 (links, assessment hardening) |
| 10 | WP-B3, WP-B4, WP-B5 |
| 11 | WP-B6, WP-B7, WP-C1–C3 |
| 12 | WP-C4–C7 |
| 13 | WP-C8–C10, WP-F2 |
| 14 | WP-E1–E4, WP-F1 |

**Critical path:** WP-A1 → WP-A2 → WP-A7 → WP-A3 → WP-A4 → WP-B1 → WP-E1 → WP-E6.

---

## 15. Definition of "99.8%"

The module reaches 99.8% when:

1. Every S1/S2/S3 finding is closed and has a passing test.
2. The DB rejects any assessment schedule whose agreed amounts **exceed** the prepaid total, and creation requires exact allocation.
3. Every contract money movement is idempotent and has a bank subledger row.
4. The client never reports success for a server rejection.
5. A 30-day shadow run reconciles to 0.00 across contracts, GL, and bank.
6. The remaining 0.2% is reserved for unknown production edge cases discovered during the shadow run; the certification is renewed after that run.

---

## 16. Appendix — Commands

```powershell
# Baseline
npm run lint
npm run test:printing
npm run test:documents
npm run test:workflows
npm run test:db

# New contract suite
npm run test:printing-contracts

# Migration
npm run test:db

# Type check
npm run lint
```

Add to `package.json`:

```json
"test:printing-contracts": "tsx tests/printing/contracts.test.ts"
```