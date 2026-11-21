# Printing Contract Module — Remediation Plan to ≥99.8% (Gap-Closure)

**Companion documents:**
- `PRINTING_CONTRACT_MODULE_AUDIT_REPORT.md` (original audit, 2026-11-19)
- `PRINTING_CONTRACT_MODULE_REMEDIATION_PLAN.md` (original plan, 2026-11-19)
- Gap analysis produced 2026-11-21 (G-01 … G-27), reproduced in §2 below.

**Plan date:** 2026-11-21
**Target:** Close every gap G-01 … G-27, prove each with a test, and satisfy the original exit criteria in §15.

---

## 1. Objective and Exit Criteria

### 1.1 Objective

Close the 27 gaps identified against the seven guiding principles, without changing the double-entry engine, the visual design system, or the paper/toner costing algorithms.

### 1.2 Decisions taken (from the 2026-11-21 clarification)

| # | Decision | Consequence |
|---|---|---|
| D-1 | **Wallet-funded activation only.** A contract becomes `active` only by consuming a customer-wallet allocation that fully funds `total_prepaid_amount`. `createPrintingContract` is always a draft. | One funding path; refund/settlement works uniformly; the `activate: true` bypass is removed. |
| D-2 | **Exact-sum at creation; under-allocation handled explicitly.** Creation requires `SUM(agreed_amount) === total_prepaid_amount`. Later reassessment may leave an explicit `unallocated_amount`, and a **top-up** endpoint exists to grow the retainer. A contract whose assessments are all complete but whose `remaining_balance > 0` enters a `credit_balance` state and must be refunded or renewed. | Closes G-08, G-18, G-21 without stranding cash. |
| D-3 | **Legacy data: audit + quarantine, then enforce.** Ship the DB trigger `NOT VALID`, backfill number counters defensively, and gate production enforcement on a clean preflight report. | No migration failure on existing rows. |

### 1.3 Exit criteria (all must be true)

1. **Zero G-01 … G-27 open.**
2. `npm run lint` passes with zero errors.
3. `npm run test:printing`, `test:documents`, `test:workflows`, `test:db`, `test:contracts`, `test:amendments`, `test:wallet`, and the new `test:printing-contracts` all pass.
4. Migration `0023` applies up and down cleanly against a seeded database, including a database containing a legacy assessment-sum mismatch (quarantined, not migrated).
5. 20 concurrent `createPrintingContract` calls produce 20 unique numbers and 20 balanced journals.
6. 10 concurrent `completeContractAssessment` calls on one milestone produce exactly 1 success and 9 × 409.
7. Double-submit of create / renew / top-up / complete produces exactly one contract and one posting.
8. A contract can be created → funded → accepted → approved → activated → assessed → cancelled-with-refund **entirely through the HTTP API and the UI**.
9. A 30-day shadow run reconciles to **0.00** variance across: `SUM(remaining_balance)` vs liability balance, `SUM(agreed_amount)` vs `total_prepaid_amount - unallocated_amount`, and contract `bank_transactions` vs the bank GL account.

---

## 2. Gap Register (baseline)

| ID | Sev | Title | Status after this plan |
|---|---|---|---|
| G-01 | S1 | Client posts a local ledger on backend rejection; all other mutations optimistic + fire-and-forget | WP-F1 |
| G-02 | S1 | Refresh precedence undefined; empty backend never clears; no debounce/version guard | WP-F3 |
| G-03 | S1 | No path creates a `contract_activation` approval request; activation unreachable via API | WP-A1 |
| G-04 | S1 | No settlement UI; cancel always 400 when a balance remains | WP-A3 |
| G-05 | S1 | `activate: true` bypasses wallet/acceptance/approval; refund impossible for those contracts | WP-A1, WP-A2 |
| G-06 | S1 | Create and renew have no idempotency key | WP-A4 |
| G-07 | S2 | No DB-level assessment-sum constraint | WP-D1 |
| G-08 | S2 | Creation does not require exact allocation | WP-A5 |
| G-09 | S2 | Invoice links exist in UI/types but not in schema; `mapApiContract` drops lifecycle fields | WP-B1 |
| G-10 | S2 | `loadContract` omits lifecycle columns | WP-B1 |
| G-11 | S2 | `liabilityAccountId` read via `as any`; no `source` discriminator | WP-B2 |
| G-12 | S2 | Test matrix thin; migration suite ignores 0020–0022 | WP-E1–E3 |
| G-13 | S2 | Numbering still `MAX()` + lexicographic split; counters unused for contracts/exams | WP-A6 |
| G-14 | S2 | Exam batch does not validate the contract link | WP-B3 |
| G-15 | S2 | Exam paper status transitions unrestricted | WP-B4 |
| G-16 | S2 | Date validation regex-only; no range check | WP-C1 |
| G-17 | S2 | Error mapping leaks raw messages; FK/date/missing-field → 500 | WP-B5 |
| G-18 | S2 | No top-up endpoint | WP-A7 |
| G-19 | S3 | No pagination/filtering; `listPrintingContracts` N+1 | WP-C2 |
| G-20 | S3 | Account resolution falls back to unrelated accounts | WP-C3 |
| G-21 | S3 | Completion has no credit-balance handling | WP-A8 |
| G-22 | S3 | UI gates contract actions on `printing:write` while backend requires `printing:contracts:manage` | WP-C4 |
| G-23 | S4 | No contract-specific rate limiting | WP-C4 |
| G-24 | S3 | Attachment uploads hardcode `entityId: 1` | WP-B6 |
| G-25 | S4 | Client/server rounding split; `customMismatch` tolerance 0.05 | WP-C5 |
| G-26 | S3 | Add-assessment numbering `length + 1` collides after removal | WP-B7 |
| G-27 | S2 | Contract wallet modal reads `bank_transactions.ref_number = contractNumber`, which nothing writes | WP-A9 |

---

## 3. Phase Overview

| Phase | Name | Gaps closed | Exit gate |
|---|---|---|---|
| **0** | Baseline & safety net | — | Current tests recorded; branch created |
| **A** | Critical financial operability | G-03, G-04, G-05, G-06, G-08, G-13, G-18, G-21, G-27 | All S1 closed; money paths reachable end-to-end |
| **B** | Layer parity & links | G-09, G-10, G-11, G-14, G-15, G-17, G-24, G-26 | All S2 closed except DB trigger; API tests green |
| **C** | Robustness & correctness | G-16, G-19, G-20, G-22, G-23, G-25 | All S3/S4 closed; lint green |
| **D** | Schema, backfill & migration | G-07 (+ legacy quarantine) | Migration 0023 up/down clean; preflight report published |
| **E** | Certification | G-01, G-02, G-12 | Full matrix green; zero-variance reconciliation |
| **F** | Polish & documentation | — | Docs published; audit report updated |

**Dependency:** A → B → C → D → E → F. Phase D's column list must be frozen before Phase E, but the trigger work in D1 can proceed in parallel with B/C once G-09's columns are agreed.

---

## 4. Phase 0 — Baseline and Safety Net

### WP-00.1 — Freeze and record

- Tag the current commit `pre-contract-gap-closure`.
- Record: `npm run lint`, `test:printing`, `test:documents`, `test:workflows`, `test:db`, `test:contracts`, `test:amendments`, `test:wallet`.
- Write the output to `docs/printing-contracts-remediation/logs/10-baseline-2026-11-21.txt`.
- **Exit:** baseline log committed.

### WP-00.2 — Characterization tests (no behaviour change)

Add `tests/printing/contracts-gap-characterization.test.ts` capturing today's behaviour, each marked `EXPECTED_TO_CHANGE` with the gap ID:

1. Create with mismatched sum → currently 201; must become 400 (G-08).
2. Activate without an approval request → currently 409; must become reachable via a new route (G-03).
3. Cancel with remaining balance and no settlement mode → currently 400 from the API because the UI never sends one (G-04).
4. Create twice with no idempotency key → currently two contracts (G-06).
5. Add assessment after removing #3 from [1,2,3,4] → currently proposes #4 (G-26).
6. `completeContractAssessment` on an under-allocated contract → currently throws `INSUFFICIENT_CONTRACT_FUNDS` forever (G-21).
7. Contract wallet modal → currently always empty (G-27).

- **Exit:** characterization suite runs and documents the baseline.

---

## 5. Phase A — Critical Financial Operability (S1)

### WP-A1 — Reachable, wallet-funded activation (G-03, G-05)

**Principle:** a contract is funded exactly once, from the customer wallet, and only an approved + accepted contract may consume that funding.

**Service changes — `src/server/services/printingRecordsService.ts`**

1. Add `findContractAllocation(tx, companyId, contractId)` returning the single `customer_wallet_allocations` row for `allocation_type = 'contract'`, or `null`.
2. Rewrite `activatePrintingContract` (`:369-490`):
   - Lock the contract `FOR UPDATE`.
   - `active` → return current state (idempotent).
   - `draft` → require, in order: a `contract_acceptances` row with `outcome = 'accepted'`; an **approved, unconsumed** `approval_requests` row with `action_type = 'contract_activation'`; and an **existing** allocation whose `amount >= total_prepaid_amount`.
   - Verify `SUM(agreed_amount) === total_prepaid_amount` (reuse WP-A5's helper).
   - Set `status = 'active'`, `activated_at = NOW()`, `activated_by`, `deposit_journal_txn_id = allocation.journal_txn_id`, `customer_acceptance_id`.
   - Consume the approval request.
   - Audit `PRINTING_CONTRACT_ACTIVATED` with acceptance id, allocation id, journal id.
   - **Do not** allocate funds here — funding happens at deposit time (step 4).
3. **Remove** the `activate?: boolean` flag from `CreatePrintingContractInput` and the `activate: true` branch (`:156-180`). `createPrintingContract` always produces a draft and never posts a journal.
4. Add `fundContractFromWallet(tx, companyId, actor, contractId, { idempotencyKey })`:
   - Lock the contract; require `status = 'draft'`.
   - Call `allocateWalletFunds(..., allowDraft: true, increaseContractTotals: true)`.
   - Audit `PRINTING_CONTRACT_FUNDED`.
   - Return `{ allocationId, amount, walletTransactionId }`.
5. Update `db.ts:388-398`: replace the direct `activate: true` seed with draft → `recordWalletDeposit` → `fundContractFromWallet` → `recordContractAcceptance` → insert an approved `contract_activation` request → `activatePrintingContract`. The seed must end with an `active`, fully allocated, accepted, approved contract.

**Route changes — `src/server/routes/printingRoutes.ts`**

6. `POST /printing/contracts/:id/fund` → `requirePermission('printing:contracts:manage')`, body `{ idempotencyKey? }`, calls `fundContractFromWallet`.
7. `POST /printing/contracts/:id/activation-requests` → `requirePermission('printing:contracts:manage')`, body `{ amount, reason, payload? }`, inserts an `approval_requests` row with `action_type = 'contract_activation'`, `entity_type = 'printing_contract'`, `entity_id = contractId`, `status = 'pending'`, and returns `{ requestId }`. This is the missing producer for G-03.
8. `POST /printing/contracts/:id/activate` continues to call `setPrintingContractStatus(..., 'activate')` but now returns 409 `CONTRACT_NOT_FUNDED` when no allocation exists.

**Client — `src/services/printingApi.ts`**

9. Add `fundContract(id, idempotencyKey?)`, `requestActivation(id, payload)`, `recordAcceptance(id, payload)`, `activateContract(id)`.

**UI — `src/components/views/PrintingContractsView.tsx`**

10. For a `draft` contract, show a **Funding** panel: wallet balance, required amount, shortfall, and a "Allocate from Wallet" action that calls `fundContract`.
11. Show an **Activation checklist** on drafts: `Accepted` / `Funded` / `Approved`, each with its own action button (`Record Acceptance`, `Allocate from Wallet`, `Request Activation Approval`). The "Activate Contract" button is enabled only when all three are green.
12. After activation succeeds, refresh from the backend (WP-F3) rather than trusting the optimistic update.

**Acceptance criteria**

- Create → 201, `status = 'draft'`, no journal posted.
- Activate a draft with no acceptance → 409 `CUSTOMER_ACCEPTANCE_REQUIRED`.
- Activate with acceptance but no approval → 409 `ACTIVATION_APPROVAL_REQUIRED`.
- Activate with acceptance + approval but no allocation → 409 `CONTRACT_NOT_FUNDED`.
- Fund a draft → one wallet allocation, `total_prepaid_amount` and `remaining_balance` both increased by the funded amount.
- Fund twice with the same idempotency key → one allocation.
- Activate a fully satisfied draft → 200, `status = 'active'`, `deposit_journal_txn_id` set, approval consumed.
- Double activate → 200 replay, no second posting.
- The seed database contains exactly one active, fully funded, accepted contract.
- No code path posts a deposit journal without a corresponding wallet allocation.

**Tests:** `T-01`, `T-02`, `T-03`.

---

### WP-A2 — Settlement-aware cancellation, reachable from the UI (G-04)

**Service:** `cancelPrintingContract` already implements refund and forfeit correctly (`:566-721`). No change to the money logic. Add one guard:
- When `settlementMode === 'refund'` and no allocation exists (a legacy direct-activate contract), throw 409 `CONTRACT_NOT_REFUNDABLE` with a message directing the operator to forfeit or migrate.

**API client:** extend `cancelContract(id, { reason, settlementMode, refundBankAccountId })`.

**UI:** replace the single "Cancel Contract" action with a confirmation modal:
- Shows `remainingBalance`.
- Radio: `Refund remaining balance` (default) / `Forfeit remaining balance`.
- Reason textarea (required).
- Bank-account select for refunds (active Bank accounts only).
- Plain-language explanation of the journal entry that will be posted.

**Acceptance criteria**

- Cancel with remaining > 0 and no mode → 400 `SETTLEMENT_MODE_REQUIRED`.
- Cancel with `refund` → liability 0, bank credited, one `bank_transactions` Debit row, `settled_amount = remaining`, `settlement_journal_txn_id` set.
- Cancel with `forfeit` → liability 0, income credited, no bank row.
- Cancel with remaining = 0 → no journal, status cancelled.
- Reactivation after settlement → 409.
- Double cancel → 409.
- The modal appears in the UI and the success toast fires only after the server confirms.

**Tests:** `T-03`, `T-06`.

---

### WP-A3 — Explicit credit-balance settlement (G-21)

**Service — `completeContractAssessment` (`:1862-1981`)**

Replace the `allDone` block:

```ts
const allDone = nextCompleted >= Number(row.total_assessments);
const cashFullyConsumed = nextRemaining <= 0n;
const status = allDone
  ? (cashFullyConsumed ? 'completed' : 'active')
  : 'active';
```

- When `allDone && !cashFullyConsumed`, also set `credit_balance = TRUE` and record `credit_balance_amount = nextRemaining` in the audit entry, and emit a domain event / log line `CONTRACT_CREDIT_BALANCE` so the UI can prompt.
- Keep the existing `INSUFFICIENT_CONTRACT_FUNDS` 409 for an assessment larger than the remaining balance (do not clamp) — this is correct now that under-allocation is explicit and top-ups exist.

**Schema (WP-D1):** add `credit_balance BOOLEAN NOT NULL DEFAULT FALSE` and `unallocated_amount NUMERIC(19,4) NOT NULL DEFAULT 0.0000` to `printing_contracts`.

**UI:** when `credit_balance` is true, show "All assessments completed — unallocated retainer of X. Refund or renew." with both actions.

**Acceptance criteria**

- Complete all assessments with `remaining_balance = 0` → `completed`.
- Complete all assessments with `remaining_balance > 0` → stays `active`, `credit_balance = TRUE`, prompt shown.
- From the credit-balance state, refund → liability 0, status cancelled.
- From the credit-balance state, renew → new draft contract, old contract unchanged.

**Tests:** `T-04`.

---

### WP-A4 — Idempotent create and renew (G-06)

**Service**

1. Add `idempotencyKey?: string | null` to `CreatePrintingContractInput`.
2. At the top of `createPrintingContract`, before any write:
   - If a key is present, `SELECT * FROM request_keys WHERE company_id = $1 AND route = 'printing_contract_create' AND idempotency_key = $2 FOR UPDATE`.
   - Found + matching `payload_hash` → return `{ ...stored.body, idempotentReplay: true }` with no posting.
   - Found + different hash → 409 `IDEMPOTENCY_CONFLICT`.
3. At the end, insert into `request_keys` with the canonical hash of `{ schoolCustomerId, title, academicYear, startDate, endDate, totalPrepaidAmount, totalAssessments, depositBankAccountId, assessments[] }` and body `{ contractId, contractNumber, status }`.
4. Pass the same key to `postJournalEntry` when a journal is posted.
5. `renewPrintingContract` accepts `idempotencyKey?` and forwards it; its canonical payload includes `contractId` + the new-dates/amount block.
6. Add `topUpContract` (WP-A7) with route `printing_contract_topup`.

**Route**

7. `POST /printing/contracts` and `POST /printing/contracts/:id/renew` read `req.headers['idempotency-key'] || req.body?.idempotencyKey`, pass it through, and return `result.idempotentReplay ? 200 : 201` (matching the pattern already used by jobs and invoicing at `printingRoutes.ts:119-133`).

**Client**

8. `printingApi.createContract` / `renewContract` / `topUpContract` send the `idempotency-key` header.
9. `PrintingContractsView` generates a stable key per form session (`contract-create-${crypto.randomUUID()}`) and reuses it on retry.

**Acceptance criteria**

- Two identical creates with the same key → one contract, one journal, second returns 200 replay.
- Same key, different payload → 409 `IDEMPOTENCY_CONFLICT`.
- Two identical renews with the same key → one new contract.
- No key → still allowed (backward compatibility) but the UI always sends one.

**Tests:** `T-01`, `T-03`, `T-05`.

---

### WP-A5 — Exact-sum invariant at creation (G-08)

**Service**

1. Extract `assertAssessmentAllocation(tx, companyId, contractId, { exact: boolean })`:
   - `exact = true` → require `SUM(agreed_amount) === total_prepaid_amount`, else 400 `ASSESSMENT_SUM_MISMATCH` with both amounts in the message.
   - `exact = false` → require `SUM(agreed_amount) <= total_prepaid_amount`, else 400 `ASSESSMENT_SUM_EXCEEDS_PREPAID`.
2. `createPrintingContract` calls it with `exact: true` after inserting milestones and before returning.
3. `activatePrintingContract` calls it with `exact: true` (already does, refactor to the helper).
4. `addContractAssessment` / `updateContractAssessment` / `approveContractAmendment` call it with `exact: false` (already do, refactor to the helper).
5. `approveContractAmendment` must validate the projected sum **before** applying milestone updates, not after.

**Acceptance criteria**

- Create with sum < prepaid → 400, no contract row.
- Create with sum > prepaid → 400, no contract row.
- Create with exact sum → 201 draft.
- Add that leaves an unallocated amount → allowed; `unallocated_amount` recomputed.
- Add that exceeds prepaid → 400.
- Amendment that would exceed prepaid → 400 and no milestone updated.

**Tests:** `T-01`, `T-04`.

---

### WP-A6 — Collision-safe number generation (G-13)

**Schema (WP-D1)**

- `printing_number_counters` already exists (migration `0020`). Add a `UNIQUE (company_id, scope)` guard and extend the `scope` CHECK to include `'contract'` and `'exam_paper'`.

**Service**

1. Add `nextPrintingNumber(tx, companyId, scope, year, prefix, width)` wrapping `SELECT next_printing_number(...)`.
2. `createPrintingContract`: replace `MAX(contract_number)` + `split('-').pop()` (`:149-154`) with `nextPrintingNumber(tx, companyId, 'contract', year, 'CTR-', 4)`. Format becomes `CTR-YYYY-0001`.
3. `createExamBatch`: replace `MAX(job_number)` + `split('-').pop()` (`:802-821`) with `nextPrintingNumber(tx, companyId, 'exam_paper', year, 'EXM-', 5)`. Format becomes `EXM-YYYY-00001`.
4. Existing numbers are preserved; new numbers continue after the current max (backfill in WP-D2).

**Acceptance criteria**

- 150 sequential creates → `CTR-YYYY-0001` … `CTR-YYYY-0150`, all unique.
- 20 concurrent creates → 20 unique numbers, zero `23505`.
- Existing `CTR-2026-01` style numbers remain valid and unchanged.
- Counter rows exist per company/year after first use.

**Tests:** `T-05`, `T-07`.

---

### WP-A7 — Top-up / additional deposit (G-18)

**Route**

`POST /printing/contracts/:id/deposits` with `requirePermission('printing:contracts:manage')`, body `{ amount, bankAccountId, depositDate, idempotencyKey?, notes? }`.

**Service — `topUpContract(tx, companyId, actor, contractId, input)`**

1. Lock the contract `FOR UPDATE`; require `status = 'active'` (409 `CONTRACT_NOT_ACTIVE`).
2. Validate `amount > 0` (400 `INVALID_AMOUNT`).
3. Validate the bank account exists, is active, and `account_type = 'Bank'` (400 `INVALID_BANK_ACCOUNT`).
4. Idempotency via `request_keys` route `printing_contract_topup` (WP-A4 pattern).
5. `postJournalEntry`: Dr Bank / Cr `liability_account_id`, `reference = contract_number`, `sourceType = 'printing_contract'`, `sourceId = contractId`, `idempotencyKey`.
6. Insert a `bank_transactions` Deposit row with `ref_number = contract_number`, `journal_txn_id`, `payee = school name`, `memo`.
7. `UPDATE printing_contracts SET total_prepaid_amount = total_prepaid_amount + amount, remaining_balance = remaining_balance + amount, unallocated_amount = unallocated_amount + amount`.
8. Audit `PRINTING_CONTRACT_TOPPED_UP`.

**UI:** "Top Up Retainer" action on active contracts → modal with amount, bank account, date, notes; shows the resulting total and remaining balance.

**Acceptance criteria**

- Top-up posts one balanced journal and one `bank_transactions` Deposit row.
- `total_prepaid_amount` and `remaining_balance` both increase by the amount.
- Double submit with the same key → one top-up.
- Top-up on a cancelled/exhausted/completed contract → 409.
- After a top-up, `unallocated_amount` reflects the new headroom.

**Tests:** `T-03`, `T-06`.

---

### WP-A8 — Renewal requires a real new deposit (G-05 residual, C-04)

**Service — `renewPrintingContract` (`:1556-1603`)**

1. Change the input to `{ depositAmount, depositBankAccountId?, depositDate?, startDate, endDate, idempotencyKey?, assessments? }`.
2. Validate `depositAmount > 0`; bank account active and `Bank`; `endDate >= startDate`; if `assessments` provided, their sum must equal `depositAmount` (WP-A5).
3. Do **not** reuse the old `start_date`, `end_date`, `total_prepaid_amount`, or `deposit_bank_account_id`.
4. Create the successor via `createPrintingContract` (draft), then `fundContractFromWallet` with the new deposit, then leave acceptance/approval to the normal activation flow.
5. Set `renewal_of_contract_id` on the successor (already supported).
6. The old contract's status is unchanged.

**UI:** "Renew Contract" opens a modal with deposit amount, bank account, deposit date, new start/end dates, and an optional schedule editor pre-filled from the old contract.

**Acceptance criteria**

- Renew without `depositAmount` → 400.
- Renew with `depositAmount` → one new draft contract, one wallet allocation, one journal, one bank transaction.
- Renew twice with the same idempotency key → one successor.
- Old contract unchanged.
- Renewing an `active` contract → 409 `CONTRACT_NOT_RENEWABLE`.

**Tests:** `T-03`.

---

### WP-A9 — Contract wallet view that actually reconciles (G-27)

**Root cause:** `listContractWalletTransactions` (`:1983-2014`) reads `bank_transactions WHERE ref_number = contractNumber`, but wallet deposits and refunds write `ref_number = walletNumber` (`customerWalletService.ts:512-530, 1291-1309`).

**Service**

1. Rewrite `listContractWalletTransactions` to read, in order:
   - `customer_wallet_allocations` for the contract (amount, type, journal id, date);
   - `customer_wallet_transactions` joined to the wallet via the allocation;
   - `bank_transactions` joined on `journal_txn_id` (covers direct bank postings such as top-ups);
   - fall back to `journal_lines` for the contract's liability account when no bank rows exist (legacy contracts).
2. Return a unified shape: `{ id, date, type: 'deposit'|'allocation'|'completion'|'refund'|'forfeit'|'topup', amount, balanceAfter, refNumber, memo, journalTxnId, source: 'bank'|'wallet'|'gl' }`.
3. Compute `balanceAfter` from `remaining_balance` at each step so the modal ends at `remaining_balance`.

**UI:** `ContractInfoModal` wallet mode shows a running balance, a "Per bank register" vs "Per GL" pair, and a variance indicator. Must end at `remainingBalance`.

**Acceptance criteria**

- After activation, the wallet modal shows the allocation and the funding deposit.
- After a completion, the modal shows the deduction and the running balance decreases.
- After a refund cancel, the modal shows the debit and ends at 0.
- `SUM(amount)` of the modal rows reconciles to `total_prepaid_amount` and the final row equals `remaining_balance`.
- Legacy contracts with no bank rows still render from GL lines.

**Tests:** `T-06`.

---

## 6. Phase B — Layer Parity and Links (S2)

### WP-B1 — Persist invoice links and lifecycle fields (G-09, G-10)

**Schema (WP-D1)**

```sql
ALTER TABLE printing_contracts
  ADD COLUMN deposit_invoice_id BIGINT,
  ADD COLUMN deposit_invoice_number VARCHAR(64),
  ADD COLUMN unallocated_amount NUMERIC(19,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN credit_balance BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE contract_assessment_milestones
  ADD COLUMN linked_invoice_number VARCHAR(64);

ALTER TABLE printing_contracts
  DROP CONSTRAINT IF EXISTS fk_printing_contracts_deposit_invoice;
ALTER TABLE printing_contracts
  ADD CONSTRAINT fk_printing_contracts_deposit_invoice
  FOREIGN KEY (company_id, deposit_invoice_id)
  REFERENCES invoices (company_id, id) ON DELETE RESTRICT;
```

**Service**

1. `loadContract` (`:944-965`) must select the full column set: `activated_at, activated_by, completed_at, completed_by, suspended_at, suspended_by, suspension_reason, resumed_at, resumed_by, renewal_of_contract_id, customer_acceptance_id, deposit_invoice_id, deposit_invoice_number, unallocated_amount, credit_balance, updated_at`.
2. `hydrateContract` returns `depositInvoiceId`, `depositBackendInvoiceId`, `depositInvoiceNumber`, `unallocatedAmount`, `creditBalance`, `updatedAt`, `source: 'backend'`.
3. `serializeMilestone` returns `linkedInvoiceId`, `linkedInvoiceNumber`.
4. Add `linkContractDepositInvoice(tx, companyId, actor, contractId, { invoiceId, invoiceNumber })` and `linkMilestoneInvoice(tx, companyId, actor, contractId, assessmentNumber, { invoiceId, invoiceNumber })`, both audited.
5. Route `POST /printing/contracts/:id/deposit-invoice` and `POST /printing/contracts/:id/assessments/:n/invoice-link` (permission `invoices:write`).

**Documents**

6. `mapContractToPreviewModel` milestone payload adds `postgresContractId: contract.backendId` and `postgresMilestoneNumber: nextPending.assessmentNumber` (`documents.ts:416-440`).
7. `PrintingContractsView.openContractPreview` `onInvoiceGenerated` handles both retainer and milestone cases and calls the appropriate link endpoint.

**Client**

8. `mapApiContract` (`AccountingContext.tsx:612-646`) maps every new field, including lifecycle metadata and invoice links.
9. `PrintingContract` type adds `liabilityAccountId?: number`, `updatedAt?: string`, `source?: 'backend'|'local'`, `unallocatedAmount?: number`, `creditBalance?: boolean`.
10. `ContractAssessmentMilestone` already has `linkedInvoiceNumber`; map it.

**Acceptance criteria**

- Create → generate retainer invoice → refresh → "Preview Retainer Invoice" still visible.
- Generate milestone invoice → refresh → milestone shows the linked invoice number and "Preview Linked Invoice".
- `printing_contracts.deposit_invoice_id` and `contract_assessment_milestones.linked_invoice_number` are populated.
- Generating the same milestone invoice twice does not create a second invoice.
- `getPrintingContract` and `listPrintingContracts` return identical shapes.

**Tests:** `T-02`, `T-08`.

---

### WP-B2 — Type safety and source discriminator (G-11)

1. `ContractInfoModal` uses `contract.liabilityAccountId` instead of `(contract as any).liabilityAccountId` (`ContractActionModals.tsx:500`).
2. `PrintingContract.source: 'backend' | 'local'` drives the fail-closed rule in WP-F1.
3. `totalAssessments` cast gets a runtime guard: `if (![2,3,4,5].includes(n)) throw`.
4. `nextPending` filter uses `!a.linkedInvoiceId && !a.backendInvoiceId && !a.linkedInvoiceNumber` (`documents.ts:388`).

**Acceptance criteria**

- No `as any` in contract modals.
- `nextPending` never offers an already-invoiced milestone.
- `source` is set correctly for backend and demo contracts.

**Tests:** `T-08`.

---

### WP-B3 — Exam batch contract validation (G-14)

`createExamBatch` (`:750-876`), when `contractId` is provided:

1. Load the contract; verify `contract.school_customer_id === schoolCustomerId`, else 400 `CONTRACT_SCHOOL_MISMATCH`.
2. Verify `1 <= assessmentNumber <= contract.total_assessments`, else 400 `ASSESSMENT_OUT_OF_RANGE`.
3. Verify the assessment exists and is `pending`, else 409 `ASSESSMENT_NOT_PENDING`.
4. Optionally verify `contract.status = 'active'`, else 409 `CONTRACT_NOT_ACTIVE`.

**Acceptance criteria**

- Batch for School A referencing School B's contract → 400.
- `assessmentNumber = 6` on a 5-assessment contract → 400.
- Completed assessment → 409.
- Valid link → 201.

**Tests:** `T-05`.

---

### WP-B4 — Exam paper status transitions (G-15)

Allowed: `queued → printing`, `printing → completed`, `printing → queued` (rework, requires `reason`). Block everything out of `completed` and `invoiced` with 409 `INVALID_EXAM_STATUS_TRANSITION`.

**Acceptance criteria**

- `queued → completed` → 400.
- `completed → queued` → 409.
- `printing → completed` → 200.
- `invoiced → *` → 409.

**Tests:** `T-05`.

---

### WP-B5 — Error mapping and safe messages (G-17)

`handlePrintingError` (`printingRoutes.ts:58-69`):

```ts
if (pgCode === '23505' || pgCode === '23514' || pgCode === '23001') return 409;
if (pgCode === '23503') return 409 { code: 'FOREIGN_KEY_CONSTRAINT' };
if (pgCode === '22P02' || pgCode === '22007') return 400 { code: 'INVALID_VALUE' };
if (pgCode === '23502') return 400 { code: 'MISSING_REQUIRED_FIELD' };
if (pgCode === '40001') return 409 { code: 'SERIALIZATION_CONFLICT' };
// unknown: log server-side with a correlation id, return 500 { error: 'Internal server error', requestId }
```

**Acceptance criteria**

- Invalid date string → 400 `INVALID_VALUE`.
- Delete an exam paper linked to a job → 409 `FOREIGN_KEY_CONSTRAINT`.
- Missing required field → 400 `MISSING_REQUIRED_FIELD`.
- Unknown error → 500 generic + `requestId`, no DB text.

**Tests:** `T-08`.

---

### WP-B6 — Attachment entity id (G-24)

`PrintingContractsView.tsx:522`: replace `entityId: 1` with `selectedContract.backendId ?? Number(selectedContract.id)`, and refuse with a clear error when the contract has no backend id.

**Acceptance criteria**

- Upload on contract #7 → `entity_id = 7`.
- Contract preview for #7 lists the attachment; contract #1 does not.

**Tests:** document integration test extension.

---

### WP-B7 — Assessment numbering and allocation UX (G-26)

1. `ContractActionModals.tsx:167`: `nextNumber = first free slot in 1..5`, not `length + 1`.
2. Show "Remaining allocatable: X" and disable submit when `agreedAmount > remainingAllocatable`.
3. `RemoveAssessmentModal` lists only pending assessments (already does).

**Acceptance criteria**

- Remove #3 from [1,2,3,4] → [1,2,4]; add → #3 (not #4).
- Add to a 5-assessment contract → 400.
- Add to a cancelled/exhausted contract → 400 `CONTRACT_NOT_ACTIVE`.

**Tests:** `T-04`.

---

## 7. Phase C — Robustness and Correctness (S3/S4)

### WP-C1 — Real date validation (G-16)

```ts
const d = new Date(`${raw}T00:00:00Z`);
if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) throw new AccountingError(400, `${field} is not a valid date`, 'INVALID_DATE');
```

- Enforce `startDate <= scheduledDate <= endDate` for every assessment (create, add, update, amendment).
- Enforce `assessmentNumber` unique and within `1..totalAssessments`.
- Use `SELECT CURRENT_DATE` for "today" (already done in completion and cancellation).

**Acceptance criteria**

- `2026-02-30` → 400 `INVALID_DATE`.
- Scheduled date outside the contract window → 400 `ASSESSMENT_DATE_OUT_OF_RANGE`.

**Tests:** `T-08`.

---

### WP-C2 — Pagination, filtering, N+1 (G-19)

1. `listPrintingContracts`: one query for contracts, one query for all milestones `WHERE contract_id = ANY($2)`, group in memory.
2. `GET /printing/contracts?status=&customerId=&limit=&offset=` → `{ items, total, limit, offset }`.
3. `GET /printing/exam-papers?contractId=&assessmentNumber=&status=&limit=&offset=`.
4. `GET /printing/exam-batches?contractId=&schoolCustomerId=`.
5. `GET /printing/jobs?status=&customerId=&limit=&offset=`.

**Acceptance criteria**

- `listPrintingContracts` issues exactly 2 queries.
- Paginated endpoints return the envelope and respect `limit`/`offset`.
- Filters exclude non-matching rows.

**Tests:** `T-02`.

---

### WP-C3 — Account resolution hardening (G-20)

- `resolveLiabilityAccount`: codes `['2250','2200','2100','2300']`; if none, throw `NO_CONTRACT_LIABILITY_ACCOUNT`. Remove the `PayrollLiability` / generic-liability fallback (`:39-46`).
- `resolveIncomeAccount`: codes `['4000','4010','4900']`; if none, throw `NO_INCOME_ACCOUNT`. Remove the generic-income fallback (`:1847-1853`).
- At contract creation, verify both accounts exist and are active.

**Acceptance criteria**

- Company without a `2250`-family liability account → 400 `NO_CONTRACT_LIABILITY_ACCOUNT` at creation.
- Company without an income account → 400 `NO_INCOME_ACCOUNT` at completion.

**Tests:** `T-08`.

---

### WP-C4 — RBAC alignment and rate limiting (G-22, G-23)

1. UI gates: contract create / activate / cancel / renew / amend / assessments / complete require `printing:contracts:manage`; production actions require `printing:write`; cost visibility requires `estimates:read_costs`; invoicing requires `invoices:write`. Update every `requiredPermission` in `PrintingContractsView.tsx` (`:570, 581-586`).
2. Rate limits in `app.ts`: `POST /printing/contracts`, `/renew`, `/:id/deposits`, `/:id/assessments/:n/complete` → 20/min per user.
3. Update the permission-matrix test to assert the new grants and denials.

**Acceptance criteria**

- Bookkeeper sees no contract-money buttons but retains all production buttons.
- 21st create in a minute → 429.
- Permission-matrix test passes.

**Tests:** `T-08`.

---

### WP-C5 — Rounding parity (G-25)

1. Add `src/server/lib/decimal.ts` exports usable from the client (or a thin `src/lib/money.ts` re-exporting the same BigInt helpers).
2. Replace client `round2` (`AccountingContext.tsx:335`, `documents.ts:696`, `printingWorkflows.ts:96`) with the shared `HALF_EVEN` helper.
3. Change `customMismatch` tolerance from `0.05` to `0.005` (`PrintingContractsView.tsx:265`) and display the exact residual.

**Acceptance criteria**

- Client and server produce identical 2-dp results for half-cent cases.
- `customMismatch` rejects a 0.01 discrepancy.

**Tests:** `T-01`.

---

## 8. Phase D — Schema, Backfill and Migration

### WP-D1 — Migration `0023_printing_contract_gap_closure`

Create `db/migrations/0023_printing_contract_gap_closure.up.sql` / `.down.sql`.

**Up**

1. `printing_contracts`:
   - `deposit_invoice_id BIGINT`, `deposit_invoice_number VARCHAR(64)`
   - `unallocated_amount NUMERIC(19,4) NOT NULL DEFAULT 0.0000`
   - `credit_balance BOOLEAN NOT NULL DEFAULT FALSE`
   - FK to `invoices (company_id, id) ON DELETE RESTRICT`
   - `CHECK (unallocated_amount >= 0)`, `CHECK (credit_balance = FALSE OR status <> 'completed')`
2. `contract_assessment_milestones`:
   - `linked_invoice_number VARCHAR(64)`
3. `printing_number_counters`: extend the `scope` CHECK to include `'contract'`, `'exam_paper'`; add `UNIQUE (company_id, scope)`.
4. **Assessment-sum trigger** (G-07):
   - `trg_validate_contract_assessment_sum` — `DEFERRABLE INITIALLY DEFERRED` constraint trigger, `AFTER INSERT OR UPDATE OR DELETE ON contract_assessment_milestones`, raising `ASSESSMENT_SUM_MISMATCH` when `SUM(agreed_amount) > total_prepaid_amount`.
   - `trg_validate_contract_total_prepaid` — `AFTER UPDATE OF total_prepaid_amount ON printing_contracts`, same check.
   - **Created `NOT VALID`** per D-3; a follow-up migration runs `VALIDATE CONSTRAINT` once the preflight report is clean.
5. Indexes: `ix_contract_milestones_company_status`, `ix_contract_milestones_contract_number`.
6. Backfill counters from existing contract numbers, guarded against non-numeric suffixes:
   ```sql
   INSERT INTO printing_number_counters (company_id, scope, year, last_value)
   SELECT company_id, 'contract', EXTRACT(YEAR FROM start_date)::SMALLINT,
          COALESCE(MAX(NULLIF(regexp_replace(contract_number, '^CTR-\d{4}-', ''), '')::INTEGER), 0)
   FROM printing_contracts
   WHERE contract_number ~ '^CTR-\d{4}-\d+$'
   GROUP BY company_id, EXTRACT(YEAR FROM start_date)
   ON CONFLICT (company_id, scope, year) DO NOTHING;
   ```
   Same for `'exam_paper'` with the `EXM-` pattern.
7. Backfill `unallocated_amount = total_prepaid_amount - COALESCE(SUM(agreed_amount), 0)` per contract.
8. Backfill `credit_balance = (completed_assessments >= total_assessments AND remaining_balance > 0)`.

**Down**

- Drop triggers, function usage, new columns, new indexes, and the new counter scopes. Reverse order. Do not drop data required by older code.

### WP-D2 — Preflight and quarantine (D-3)

`scripts/printing-contract-preflight.ts`:

1. `SELECT contract_id, SUM(agreed_amount), total_prepaid_amount FROM contract_assessment_milestones JOIN printing_contracts … GROUP BY … HAVING SUM(agreed_amount) <> total_prepaid_amount` → write `docs/printing-contracts-remediation/logs/preflight-mismatches.csv`.
2. `SELECT COUNT(*) FROM printing_contracts WHERE remaining_balance < 0` → must be 0.
3. `SELECT COUNT(*) FROM printing_contracts WHERE remaining_balance > total_prepaid_amount` → must be 0.
4. Non-numeric contract numbers → list for manual renumbering.
5. Exit non-zero if any unquarantined mismatch remains.

### WP-D3 — Migration test

Extend `tests/db/migration-suite.ts`:

- Apply 0023 up.
- Insert a contract + assessments that sum correctly → passes.
- Insert a mismatch → fails at commit.
- Call `next_printing_number` 150 times → unique.
- Apply down → schema returns to 0022.

**Acceptance criteria**

- Migration 0023 up/down clean on a seeded DB.
- Legacy mismatch is quarantined by the preflight and does not block the migration.
- `VALIDATE CONSTRAINT` succeeds after cleanup.

---

## 9. Phase E — Test and Certification

### WP-E1 — Service tests (`tests/printing/contracts.test.ts`)

| Test | Covers |
|---|---|
| Create happy path (draft, no journal) | G-05, G-08 |
| Create with sum < prepaid → 400 | G-08 |
| Create with sum > prepaid → 400 | G-08 |
| Create with duplicate idempotency key → replay | G-06 |
| Create with same key, different payload → 409 | G-06 |
| Fund draft → allocation, totals increase | G-03, G-05 |
| Activate without acceptance → 409 | G-03 |
| Activate without approval → 409 | G-03 |
| Activate without funding → 409 `CONTRACT_NOT_FUNDED` | G-03 |
| Activate fully satisfied → active, approval consumed | G-03 |
| Double activate → replay | G-03 |
| Complete assessment → balanced journal, remaining reduced | G-21 |
| Complete twice → 409 | G-21 |
| Complete all → completed, remaining 0 | G-21 |
| Complete all with residual → active + credit_balance | G-21 |
| Credit-balance refund → liability 0 | G-21, G-04 |
| Credit-balance renew → new draft | G-21, G-05 |
| Cancel with refund → liability 0, bank debit, bank row | G-04 |
| Cancel with forfeit → liability 0, income credit | G-04 |
| Cancel without settlement mode → 400 | G-04 |
| Cancel with remaining 0 → no journal | G-04 |
| Reactivate after settlement → 409 | G-04 |
| Renew with deposit → new draft + allocation | G-05 |
| Renew without deposit → 400 | G-05 |
| Renew an active contract → 409 | G-05 |
| Top-up → totals increase, journal + bank row | G-18 |
| Top-up double submit → one | G-18 |
| Add assessment happy path | G-26 |
| Add after removal → correct number | G-26 |
| Add to 5-assessment contract → 400 | G-26 |
| Add to cancelled contract → 400 | G-26 |
| Remove pending → allowed | G-26 |
| Remove completed → 400 | G-26 |
| Update pending → allowed | G-26 |
| Update completed → 400 | G-26 |
| Amend active → allowed | — |
| Amend dates after completion → 409 | — |
| Exam batch cross-school → 400 | G-14 |
| Exam batch out-of-range assessment → 400 | G-14 |
| Exam paper transitions | G-15 |
| 150 sequential contract numbers | G-13 |
| 20 concurrent contract numbers | G-13 |

### WP-E2 — API tests (`tests/printing/contracts-api.test.ts`)

- `POST /api/printing/contracts` with idempotency key → 201, replay 200.
- `POST /api/printing/contracts/:id/fund` → 200.
- `POST /api/printing/contracts/:id/activation-requests` → 201.
- `POST /api/printing/contracts/:id/activate` → 200 after all prerequisites.
- `POST /api/printing/contracts/:id/cancel` with refund → 200, bank transaction exists.
- `POST /api/printing/contracts/:id/renew` → 201.
- `POST /api/printing/contracts/:id/deposits` → 201.
- `POST /api/printing/contracts/:id/assessments/:n/complete` twice → 200 then 409.
- RBAC: Bookkeeper can create a job but cannot complete an assessment.
- Error mapping: invalid date → 400; FK violation → 409; unknown → 500 generic.
- Rate limit: 21st create in a minute → 429.

### WP-E3 — Concurrency tests

- 20 parallel `createPrintingContract` → 20 unique numbers, 20 balanced journals.
- 10 parallel `completeContractAssessment` on one milestone → 1 success, 9 × 409.
- 10 parallel `cancel` → 1 success.
- 10 parallel `topUp` with the same idempotency key → 1 top-up.
- 10 parallel `activate` → 1 success.

### WP-E4 — Frontend/context tests

- Mock `printingApi.createContract` to reject with 400 → context adds no contract and mutates no accounts.
- Mock reject on complete → milestone remains pending, error surfaced.
- Mock success → state updates once.
- Refresh with a non-empty backend → backend contracts replace local ones; demo contracts handled per WP-F3.
- `mapApiContract` preserves invoice links and lifecycle fields.

### WP-E5 — UAT script

1. Create a 4-assessment contract with K80,000, split evenly → draft.
2. Record customer acceptance.
3. Request activation approval; approve it as a second user.
4. Deposit K80,000 into the customer wallet; fund the contract.
5. Activate → verify the activation journal and wallet allocation.
6. Generate the retainer invoice and preview it.
7. Complete assessment #1 → verify remaining K60,000 and the income journal.
8. Generate the assessment #1 invoice → verify the milestone link.
9. Add a pending assessment → verify numbering.
10. Top up K10,000 → verify totals and the bank row.
11. Cancel with refund → verify the refund journal, bank debit, and wallet modal ending at 0.
12. Renew with a new deposit → verify the successor draft and allocation.
13. Reload after each step → verify nothing disappears.

### WP-E6 — Reconciliation and shadow run

- 30 days of production-like data in staging.
- Compare: `SUM(remaining_balance)` vs liability balance; `SUM(agreed_amount)` per contract vs `total_prepaid_amount - unallocated_amount`; `SUM(bank_transactions.amount)` for contract-related rows vs the bank GL movement.
- Target: **0.00** variance in all three.
- Sign off with a one-page certificate appended to the audit report.

---

## 10. Phase F — Polish and Documentation

### WP-F1 — Fail-closed frontend (G-01, G-02)

1. Add `mutateContract<T>(backendCall, { fallbackLocal?, financial })` in `AccountingContext`:
   - 4xx → rethrow, no local fallback.
   - Network error + financial → rethrow with "Cannot reach the server. No contract was created."
   - Network error + non-financial + demo mode → allow fallback.
2. `addPrintingContract`: use the helper; never create a local contract when the backend returns 4xx.
3. Make `completeContractAssessment`, `cancelPrintingContract`, `activatePrintingContract`, `renewPrintingContract`, `amendPrintingContract`, `addContractAssessment`, `removeContractAssessment`, `updateContractAssessment` async; await the backend; update local state only on success (or roll back on error).
4. Update all call sites in `PrintingContractsView` to await, toast only on success, and disable buttons while `contractActionBusy` is true.
5. Add `refreshVersion` ref and debounce (500 ms) the global refresh; add `refreshContract(id)` after each mutation.
6. `refreshPrintingContractsFromBackend`: if the backend list is non-empty → replace backend contracts, keep local-only contracts only when `!isServerEdition`; if empty and `isServerEdition` → set `[]`; if empty and `!isServerEdition` → keep demo.

**Acceptance criteria**

- Backend 400 on create → no local contract, no local ledger change, error toast.
- Backend 500/network on complete → local state unchanged, error toast, milestone still pending.
- Backend success → local state updates once, success toast.
- Rapid double-click on complete → one journal, one deduction.
- Cancel/renew/amend/add/remove show success only after the server confirms.

### WP-F2 — UX and documentation

- Empty state on `PrintingContractsView` when no contracts exist.
- "Top Up Retainer" action and modal.
- Cancellation settlement modal.
- Renewal modal with deposit details.
- `GET /printing/contracts/:id/history` backed by `audit_log`.
- `docs/printing-contracts.md`: lifecycle diagram, accounting entries for create/fund/activate/complete/refund/forfeit/top-up/renew, invariants, idempotency keys, RBAC matrix.
- Update `PRINTING_CONTRACT_MODULE_AUDIT_REPORT.md` with the certification results.

### WP-F3 — Type and lint cleanup

- Remove remaining `as any` in contract code paths.
- Runtime guard on `totalAssessments`.
- No `console.log` in production paths.
- `npm run lint` clean.

---

## 11. Traceability Matrix

| Gap | Work package | Test |
|---|---|---|
| G-01 | WP-F1 | T-04, T-08 |
| G-02 | WP-F1 | T-09 |
| G-03 | WP-A1 | T-01, T-02 |
| G-04 | WP-A2 | T-03, T-06 |
| G-05 | WP-A1, WP-A8 | T-01, T-03 |
| G-06 | WP-A4 | T-01, T-03, T-05 |
| G-07 | WP-D1 | T-06 |
| G-08 | WP-A5 | T-01, T-04 |
| G-09 | WP-B1 | T-02, T-08 |
| G-10 | WP-B1 | T-02 |
| G-11 | WP-B2 | T-02, T-08 |
| G-12 | WP-E1–E4 | T-01…T-09 |
| G-13 | WP-A6 | T-05, T-07 |
| G-14 | WP-B3 | T-05 |
| G-15 | WP-B4 | T-05 |
| G-16 | WP-C1 | T-08 |
| G-17 | WP-B5 | T-08 |
| G-18 | WP-A7 | T-03, T-06 |
| G-19 | WP-C2 | T-02 |
| G-20 | WP-C3 | T-08 |
| G-21 | WP-A3 | T-04 |
| G-22 | WP-C4 | T-08 |
| G-23 | WP-C4 | T-08 |
| G-24 | WP-B6 | T-02 |
| G-25 | WP-C5 | T-01 |
| G-26 | WP-B7 | T-04 |
| G-27 | WP-A9 | T-06 |

---

## 12. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Legacy contracts have assessment sums ≠ prepaid total | High | Migration trigger blocks inserts/updates | WP-D2 preflight + quarantine; trigger shipped `NOT VALID`; `VALIDATE CONSTRAINT` only after cleanup |
| Renewal UX change breaks existing workflows | Medium | Users cannot renew as before | Keep a "quick renew" that asks only for deposit amount/date, with sensible defaults |
| RBAC split locks out Bookkeepers/ProductionManagers | Medium | Production staff cannot manage contracts | Grant `printing:contracts:manage` to a Bookkeeper variant if needed; document the matrix; UI gates aligned in WP-C4 |
| Idempotency keys collide across users | Low | Wrong replay | Scope keys by `company_id`; include a form/session UUID |
| Removing the `activate: true` bypass breaks the seed or tests | Medium | Demo data or CI fails | WP-A1 step 5 rewrites the seed; WP-00.2 characterizes the old behaviour first |
| Credit-balance state confuses operators | Medium | Contracts sit active with residual cash | WP-A3 UI prompt with explicit refund/renew actions; audit event on entry |
| Wallet-funded activation exposes a funding gap at activation time | Medium | Activation fails late | WP-A1 shows a live funding panel and checklist before the operator attempts activation |
| Bank subledger double-counts with the journal | Medium | Cash overstated | WP-A9 reads each movement once; reconciliation test in WP-E6 |

---

## 13. Definition of Done / Certification Checklist

- [ ] All G-01 … G-27 closed and verified by tests.
- [ ] `npm run lint` passes with zero errors.
- [ ] `npm run test:printing` passes.
- [ ] `npm run test:documents` passes.
- [ ] `npm run test:workflows` passes.
- [ ] `npm run test:db` passes.
- [ ] `npm run test:contracts` passes.
- [ ] `npm run test:amendments` passes.
- [ ] `npm run test:wallet` passes.
- [ ] `npm run test:printing-contracts` passes (new).
- [ ] Migration 0023 applies up and down cleanly on a seeded DB.
- [ ] Legacy preflight report published; quarantined mismatches listed.
- [ ] 20 concurrent creates produce 20 unique contract numbers.
- [ ] 10 concurrent completes produce exactly 1 success.
- [ ] Double-submit create/renew/top-up/complete produces exactly one posting.
- [ ] Cancel with refund and forfeit both balance to zero.
- [ ] Renew requires and records a real deposit.
- [ ] A contract can be created → funded → accepted → approved → activated → assessed → refunded entirely through the API and the UI.
- [ ] Wallet modal reconciles to `remaining_balance`.
- [ ] Contract preview and milestone invoice links survive a refresh.
- [ ] Attachment uploads target the correct contract.
- [ ] RBAC matrix updated and tested.
- [ ] 30-day shadow run shows 0.00 variance.
- [ ] `docs/printing-contracts.md` published.
- [ ] Audit report updated with the certification results.

---

## 14. Suggested Execution Order

| Day | Work |
|---|---|
| 1 | WP-00.1, WP-00.2 |
| 2–3 | WP-A5, WP-A4, WP-A6 |
| 4–5 | WP-A1, WP-A2 (create/fund/activate/cancel reachable) |
| 6 | WP-A3, WP-A7, WP-A8 (credit balance, top-up, renew) |
| 7 | WP-A9, WP-B1 (wallet reconciliation, invoice links) |
| 8 | WP-B2, WP-B3, WP-B4, WP-B5, WP-B6, WP-B7 |
| 9 | WP-C1, WP-C2, WP-C3, WP-C4, WP-C5 |
| 10 | WP-D1, WP-D2, WP-D3 |
| 11–12 | WP-E1, WP-E2, WP-E3, WP-E4 |
| 13 | WP-F1, WP-F2, WP-F3 |
| 14 | WP-E5 (UAT), WP-E6 (shadow run), sign-off |

**Critical path:** WP-A4 → WP-A1 → WP-A2 → WP-A9 → WP-B1 → WP-F1 → WP-E1 → WP-E6.

---

## 15. Definition of "99.8%"

The module reaches 99.8% when:

1. Every G-01 … G-27 is closed and has a passing test.
2. The DB rejects any assessment schedule whose agreed amounts **exceed** the prepaid total, and creation requires exact allocation.
3. Every contract money movement is idempotent and, where it touches the bank, has a bank subledger row.
4. The client never reports success for a server rejection.
5. A contract can be taken from creation to refund entirely through the product, with no direct SQL.
6. A 30-day shadow run reconciles to 0.00 across contracts, GL, and bank.
7. The remaining 0.2% is reserved for unknown production edge cases discovered during the shadow run; certification is renewed after that run.

---

## 16. Appendix — Commands

```powershell
# Baseline
npm run lint
npm run test:printing
npm run test:documents
npm run test:workflows
npm run test:db
npm run test:contracts
npm run test:amendments
npm run test:wallet

# New contract suite
npm run test:printing-contracts

# Migration
npm run test:db

# Preflight
npx tsx scripts/printing-contract-preflight.ts

# Type check
npm run lint
```

Add to `package.json`:

```json
"test:printing-contracts": "tsx tests/printing/contracts.test.ts"
```