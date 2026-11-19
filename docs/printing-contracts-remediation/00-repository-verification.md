# 00 — Repository Verification Report

**Project:** Prime ERP — Printing Management System
**Module:** Printing Contracts, Assessment Milestones, Prepaid Retainers, Examination Batches
**Audit basis:** `PRINTING_CONTRACT_MODULE_AUDIT_REPORT.md` (2026-11-19)
**Plan basis:** `PRINTING_CONTRACT_MODULE_REMEDIATION_PLAN.md` (2026-11-19)
**Verification date:** 2026-11-19
**Repository branch:** `main`
**Repository commit:** `933bcf3` — *Implement full advanced options for Invoices and Printing Contracts*
**Verification type:** Phase 0 — static repository inspection only
**Code changes made:** None
**Migrations applied:** None
**Tests executed:** None
**Build executed:** None

> **Phase 0 rule:** No production code, schema, or migration changes are authorised until this report is reviewed and the open business decisions in §11 are resolved.

---

## 1. Executive Summary

The audit's core findings are **largely reproducible in the current repository**, but several details need correction before implementation:

1. **The audit is accurate on the nine Critical findings.** Every S1 finding has a concrete code path and a reproducible failure mode. The most serious are the assessment-sum invariant, non-idempotent contract creation/renewal, unsettled cancellation, renew-without-cash, missing bank-subledger rows, and the client's optimistic/fire-and-forget mutation pattern.
2. **Two audit statements are imprecise and must be corrected:**
   - `addContractAssessment` **already requires `status = 'active'`** and locks the contract (`printingRecordsService.ts:728-731`). The audit's blanket statement that add/remove/update do not require active status is wrong. `removeContractAssessment` and `updateContractAssessment` do lack the check.
   - The draft plan's `currency_code DEFAULT 'ZMW'` is **not automatically correct for a Malawi deployment**, but neither is hardcoding `MWK`. The repository's canonical stored currency is **`companies.base_currency`, which currently defaults to `ZMW`** (`0001:59`, `db.ts:151`). The seed/demo company is ZMW. The correct fix is to use the company's configured `base_currency`, and separately obtain business sign-off if the deployment is genuinely MWK.
3. **A new currency defect was found:** `documentsService` hardcodes `currencyCode: 'ZMW'` for contract previews (`documentsService.ts:1184`), ignoring `companies.base_currency`. This is not in the original audit.
4. **A new idempotency defect was found:** `postJournalEntry` pre-checks `request_keys` but does **not lock or reserve the key** (`accountingEngine.ts:1563-1588`). Concurrent same-key requests can both pass the check; the unique index then turns the second into a `23505`/409 instead of a replay. Route-level helpers have the same race (`commercialHelpers.ts:414-439`). A proper claim/reservation protocol is required.
5. **A new frontend/backend discrimination gap was found:** `CompanyProfile.isServerEdition` exists (`types/accounting.ts:434`) but `AccountingContext` never uses it. The only discriminator is `contract.backendId`. This is the root cause of the local-fallback and refresh-precedence defects.
6. **No `credit_balance` or `partially_allocated` status exists** in the DB, TypeScript, API, or UI. The contract status is limited to `active | exhausted | cancelled` (`0007:134`, `types/accounting.ts:213`). Adding a new status would require changes to every query, filter, and UI branch. The recommended design is to keep the three statuses and use computed flags/read fields.
7. **No contract service tests exist.** `tests/printing` contains only `paper-toner-calc.test.ts`; `tests/documents` covers contract preview and one milestone invoice path; `tests/db/migration-suite.ts` is the DB harness; `tests/workflows` covers printing jobs, not contracts. `package.json` has no `test:printing-contracts` script.
8. **The repository is not in a clean state.** `git status` shows many pre-existing modified files unrelated to this audit. Phase 0 must record the baseline and create a branch/tag before any implementation; do not commit unrelated changes.

**Verification result:** 9/9 Critical confirmed, 15/15 High confirmed (one with corrected wording), 16/16 Medium confirmed, 7/7 Low confirmed. Plus **new findings N-01…N-18** and **six business decisions** that must be resolved before schema work.

---

## 2. Migration Head and Conventions

### 2.1 Current head

| Item | Value |
|---|---|
| Highest migration | `0019_printing_smart_ops_and_pos.up.sql` |
| `0020` exists? | **No** |
| Migrator | `db/migrator.ts` |
| Ordering | Lexicographic by filename |
| Applied tracking | `schema_migrations(version, name, checksum, applied_at)` (`0001:316-330`) |
| Naming | `NNNN_name.up.sql` / `NNNN_name.down.sql` |
| Execution | Each migration file is executed as a single script (`migrator.ts:32-44`) |
| RLS pattern | `ENABLE` + `FORCE` + `app_rls_allowed(company_id)` policy |
| Composite FK pattern | Local `(company_id, x_id)` → parent `(company_id, id)` |
| Tenant transaction | `withCompanyDb` sets `ROLE pms_app_role`, `app.bypass_rls='off'`, `app.current_company_id` (`db.ts:555-565`) |

**Conclusion:** migration `0020` is available and unused. All new objects must follow the existing RLS/composite-FK conventions.

### 2.2 Existing contract schema

`db/migrations/0007_printing_production_exams_contracts.up.sql`

| Table | Lines | Key facts |
|---|---|---|
| `printing_contracts` | 118-161 | Status `active/exhausted/cancelled` (134); unique `(company_id, contract_number)` (139); composite FKs to `customers`, `accounts` (bank + liability), `journal_transactions` (140-147); `remaining_balance <= total_prepaid_amount` (149); `completed_assessments <= total_assessments` (150); RLS forced (157-161) |
| `contract_assessment_milestones` | 163-196 | Status `pending/completed` (179); unique `(company_id, contract_id, assessment_number)` (185); composite FKs to contracts, inventory, journal, invoices (186-195); RLS forced (198-202); **no `linked_invoice_number`, `completed_by`, `completed_at`** |
| `exam_assessment_batches` | 205-232 | Unique `(company_id, school_customer_id, assessment_name, class_name)` (219); composite FKs to customers, contracts, invoices (220-225) |
| `exam_papers` | 234-275 | Status `queued/printing/completed/invoiced` (252); unique `(company_id, job_number)` (257), `(company_id, batch_id, subject_name)` (258); index `(company_id, status, production_date)` (269) |
| `printing_jobs` | 278-324 | `exam_paper_id` composite FK → `exam_papers` ON DELETE RESTRICT (316-317) |
| `delivery_note_lines` | 448-462 | `exam_paper_id` composite FK → `exam_papers` ON DELETE RESTRICT (460-461) |

**Important:** `printing_contracts.status` has **no `draft`** value in the current DB. The TypeScript type (`active | exhausted | cancelled`) matches. Any new status is a breaking schema + UI + query change.

### 2.3 Existing accounting/banking schema

| Table | Lines | Key facts |
|---|---|---|
| `accounts` | `0002:5-39` | `account_type` includes `Bank`, `OtherCurrentLiability`, `LongTermLiability`, `PayrollLiability`, `Income`, `OtherIncome` (12); unique `(company_id, lower(code))` (29); composite unique `(company_id, id)` (38) |
| `journal_transactions` | `0002:41-82`; `0009:8-10`, `38-39`; `0011:68-71` | Composite unique `(company_id, id)` (73); `idempotency_key` + unique index (0009); `source_type` includes `printing_contract` (0011) |
| `journal_lines` | `0002:84-103` | Composite FK to `journal_transactions` (102) |
| `invoices` | `0003:117-156` | Composite unique `(company_id, id)` (151); `source_type` includes `contract`/`contract_milestone` (0015:66-69) |
| `bank_transactions` | `0004:348-395`; `0010:216-227` | `journal_txn_id` composite FK (377-378); `status` default `posted` (0010:218); `offset_account_id` (219-220); `transfer_pair_txn_id` (221-222); `txn_type` extended to `Payment`, `Sales Receipt`, `Other` (225-226) |
| `bank_accounts` | `0004:394-412` | Separate from `accounts`; `gl_account_id` → `accounts` (410-411) |
| `request_keys` | `0001:281-297` | Unique `(company_id, route, idempotency_key)` (292); `payload_hash CHAR(64)` (286); `response_json` (289); `status_code` (290); RLS forced (295-297) |
| `users` | `0001:80-92` | Global `id` PK; **not company-scoped**; use `REFERENCES users(id)` for `cancelled_by`/`completed_by` |
| `companies` | `0001:46-73` | `base_currency CHAR(3) DEFAULT 'ZMW'` (59); `currency_symbol DEFAULT 'K'` (60); `rounding_mode DEFAULT 'HALF_EVEN'` (64); `decimal_places DEFAULT 2` (65); `is_server_edition` (66); **no timezone column** |

### 2.4 `bank_transactions` semantics (verified)

- **Amount sign:** positive = inflow, negative = outflow. Evidence: `purchasingService.ts:1349-1374` inserts a negative amount for a bank withdrawal; `bankingService.ts:1165` records an expense with `formatDecimal4(-total4)`.
- **Allowed `txn_type` values (current):** `Check`, `Deposit`, `Transfer`, `Bill Payment`, `Debit`, `Fee`, `Credit Card Charge`, `Credit Card Refund`, `Payment`, `Sales Receipt`, `Other` (`0010:225-226`).
- **`running_balance`:** column default `0.0000` (`0004:387`). New application inserts do **not** set it. `listBankTransactions` computes the running balance **on read** (`bankingService.ts:177-181`). **Do not compute/persist running balance in contract code.**
- **`journal_txn_id`:** optional composite FK to `journal_transactions` (`0004:377-378`). Contract deposits/refunds should set it.
- **Canonical pattern:** `bankingService.recordExpense` (`bankingService.ts:368-440`) posts the journal, inserts the bank row with `journal_txn_id`, writes audit, and calls `saveRouteIdempotency`. This is the pattern to follow.

### 2.5 `request_keys` and idempotency (verified)

| Function | Location | Behaviour | Gap |
|---|---|---|---|
| `postJournalEntry` pre-check | `accountingEngine.ts:1563-1588` | Selects existing `request_keys` by `(company_id, route, idempotency_key)`, validates payload hash, returns stored response | No lock/claim; concurrent requests can both pass |
| `postJournalEntry` insert | `accountingEngine.ts:1788-1795` | `INSERT ... ON CONFLICT DO NOTHING` | If a concurrent request wins, this silently does nothing; the second journal insert is what fails (unique index), not a clean replay |
| `journal_transactions.idempotency_key` | `0009:8-10`, `38-39` | Unique index `(company_id, idempotency_key)` | Second insert → `23505` → 409, not replay |
| `checkRouteIdempotency` | `commercialHelpers.ts:414-439` | Selects `request_keys`, compares `JSON.stringify(payload)` | Non-canonical JSON; key order changes hash |
| `saveRouteIdempotency` | `commercialHelpers.ts:441-477` | `INSERT ... ON CONFLICT DO NOTHING` | No pending state; a claimed key with no response cannot be distinguished from an in-flight request |
| `request_keys` schema | `0001:281-297` | `status_code NOT NULL`, `response_json` nullable, no `status`/`completed_at` | Cannot represent `pending` without a convention (e.g., `status_code = 202`, `response_json IS NULL`) |

**Conclusion:** the existing mechanism is useful but **not concurrency-safe as a reservation**. The remediation must implement a claim step (insert key first, atomically), then update the response, and handle `pending` replays.

---

## 3. Currency Verification (Critical Correction to the Draft Plan)

### 3.1 What the repository actually stores

| Layer | Finding | Evidence |
|---|---|---|
| Schema default | `companies.base_currency CHAR(3) NOT NULL DEFAULT 'ZMW'` | `0001:59` |
| Service default | `createCompanyWithDefaults` default `baseCurrency = 'ZMW'` | `db.ts:151` |
| Insert | `createCompanyInTx` inserts `params.baseCurrency` | `db.ts:113` |
| Seed/demo | `createCompanyInTx` called without `baseCurrency`, so seed company is **ZMW** | `db.ts:224-231` |
| Company API | `baseCurrency` is accepted on create/update | `companyRoutes.ts:60`, `88` |
| Frontend profile | `CompanyProfile.currency` is the **symbol** (`K`), not ISO; `baseCurrency` is not on the profile | `types/accounting.ts:430-434` |
| Contract preview | Hardcodes `currencyCode: 'ZMW'` | `documentsService.ts:1184` |
| Other docs | Hardcode `'ZMW'` for invoices/receipts/etc. | `documentsService.ts:1237`, `1254`, `1270`, `1289`, `1355`, `1412`, `1564`, `1619` |

### 3.2 Conclusion

- The repository's **canonical stored currency today is `ZMW`**, not `MWK`.
- The master prompt's premise ("Malawi deployment → MWK") is a **business/data configuration decision**, not a code default. If the company is genuinely Malawian, the company record must be updated to `base_currency = 'MWK'`; the remediation must not hardcode either code.
- The draft plan's `currency_code DEFAULT 'ZMW'` should be rejected. The new contract `currency_code` must be:
  1. nullable during migration;
  2. backfilled from `companies.base_currency`;
  3. set `NOT NULL` after backfill;
  4. populated by the service from `companies.base_currency` on every new contract.
- The hardcoded `'ZMW'` in `documentsService.ts:1184` is a **new finding (N-01)** and must be replaced with the company's `base_currency`.

### 3.3 Required business sign-off

- Confirm the deployment currency: `ZMW` or `MWK`.
- If `MWK`, approve a data update to the company record and confirm that all document templates should use `MWK`.
- Do not introduce multi-currency behaviour in this remediation.

---

## 4. Date/Timezone Verification

### 4.1 Findings

| Location | Behaviour | Issue |
|---|---|---|
| `commercialHelpers.ts:54-56` `todayIsoDate()` | `new Date().toISOString().slice(0, 10)` | UTC date; Malawi (UTC+2) can be off by one after 22:00 local |
| `printingRecordsService.ts:965` | `new Date().toISOString().slice(0, 10)` | Same |
| `printingRecordsService.ts:328` | `new Date().getUTCFullYear()` | UTC year for exam job numbers |
| `printingRecordsService.ts:347` | `new Date().toISOString().slice(0, 10)` | UTC production date |
| `printingRecordsService.ts:140` | `new Date().getUTCFullYear()` | UTC year for contract numbers |
| `operationalReports.ts:162` | DB `CURRENT_DATE` | Correct pattern |
| `companies` | **No timezone column** | Cannot use "company timezone" today |

### 4.2 Conclusion

- Use the **database's configured business timezone** (`CURRENT_DATE`) for date-only values.
- For "now" timestamps, use `NOW()`/`CURRENT_TIMESTAMP` (already `TIMESTAMPTZ`).
- Do **not** add a company timezone column unless the business confirms multiple timezones; if added, backfill with a documented default.
- Fix all contract/exam date defaults and year derivations.

---

## 5. Roles, Permissions, and RBAC Verification

### 5.1 Current permissions

| Permission | Description | Evidence |
|---|---|---|
| `printing:read` | View machines, jobs, estimates, contracts, exam papers | `permissions.ts:60` |
| `printing:write` | Create/approve/issue/consume/finish/deliver jobs, **and** all contract mutations | `permissions.ts:61` |
| `invoices:write` | Create invoices | `permissions.ts:67` |
| `documents:read` | Read document previews | `permissions.ts:65` |

### 5.2 Current role grants

| Role | `printing:write` | `printing:read` | `invoices:write` |
|---|---|---|---|
| Administrator | Yes (`ALL_PERMISSIONS`) | Yes | Yes |
| Accountant | Yes | Yes | Yes |
| Bookkeeper | Yes | Yes | Yes (via `invoices:read/write`) |
| ProductionManager | Yes | Yes | No |
| Read-Only | No | Yes | No |

Evidence: `permissions.ts:147-190` (role definitions), `226-256` (explicit grants).

### 5.3 Contract route guards

| Route | Permission | Line |
|---|---|---|
| `POST /printing/contracts` | `printing:write` | `printingRoutes.ts:328` |
| `POST /printing/contracts/:id/activate` | `printing:write` | `443` |
| `POST /printing/contracts/:id/cancel` | `printing:write` | `456` |
| `POST /printing/contracts/:id/renew` | `printing:write` | `469` |
| `POST /printing/contracts/:id/assessments` | `printing:write` | `482` |
| `PATCH /printing/contracts/:id/assessments/:n` | `printing:write` | `507-510` |
| `DELETE /printing/contracts/:id/assessments/:n` | `printing:write` | `539-542` |
| `POST /printing/contracts/:id/assessments/:n/complete` | `printing:write` | `560-563` |
| `GET /printing/contracts/:id/wallet-transactions` | `printing:read` | `584-586` |

### 5.4 Conclusion

- **ProductionManager can currently create contracts, cancel them, renew them, and recognise revenue** because it has `printing:write`.
- **Bookkeeper can also recognise revenue and settle contracts.**
- The remediation should introduce a narrow `printing:contracts:manage` permission for financial contract actions, separate from `printing:write` for production operations. This requires:
  - `ALL_PERMISSIONS` update;
  - `ROLE_DEFINITIONS` update;
  - explicit grants;
  - route guards;
  - UI `requiredPermission` updates;
  - tests.
- **Business decision required:** should ProductionManager or Bookkeeper retain contract settlement rights? Do not assume.

---

## 6. Frontend Backend/Demo Discrimination Verification

### 6.1 Current behaviour

| Item | Finding | Evidence |
|---|---|---|
| Demo contracts | `INITIAL_PRINTING_CONTRACTS` with `id: 'ctr-1'`, **no `backendId`** | `initialDemoData.ts:679-693` |
| API mapping | `backendId: Number(b.backendId ?? b.id)` | `AccountingContext.tsx:612-646` |
| Mutation branch | `if (ctr?.backendId)` → backend; else local ledger | `AccountingContext.tsx:2176-2208`, `2405-2416`, `2490-2499`, etc. |
| `isServerEdition` | Exists on `CompanyProfile` but **not used** by `AccountingContext` | `types/accounting.ts:434`; no usage in context |
| Refresh | `refreshPrintingContractsFromBackend` replaces local list if backend returns non-empty; returns early if empty | `AccountingContext.tsx:699-707` |
| Refresh trigger | Every `ACCOUNTING_UPDATED_EVENT` refreshes all contracts | `AccountingContext.tsx:719-731` |

### 6.2 Conclusion

- `backendId` is a **reliable per-contract discriminator** for contracts created through the API.
- It is **not a global mode flag**. A server-backed installation can still have local demo contracts until a refresh replaces them.
- The local-fallback bug is caused by treating any backend error as "no backend", not by a missing discriminator.
- The remediation should:
  - use `companyProfile.isServerEdition` + `authenticated` to decide whether the app is in server mode;
  - in server mode, never post local financial entries on backend failure;
  - keep demo records separate and never mix them into backend financial reports;
  - define refresh precedence explicitly (backend authoritative in server mode; empty backend clears stale server contracts).

---

## 7. Test Scripts and Harnesses Verification

### 7.1 `package.json` scripts (verified)

| Script | Command | Notes |
|---|---|---|
| `lint` | `tsc --noEmit` | Type check only; no ESLint |
| `test:printing` | `tsx tests/printing/paper-toner-calc.test.ts` | Paper/toner only |
| `test:documents` | `tsx tests/documents/documents-and-invoicing.test.ts` | Contract preview + one milestone invoice |
| `test:workflows` | `tsx tests/workflows/phase9-e2e-workflows.test.ts` | Printing jobs, materials, delivery, invoicing |
| `test:db` | `tsx tests/db/migration-suite.ts` | Migration/DB harness |
| `test:migrations` | Same as `test:db` | Alias |
| `test:export` | `tests/export/fixtures.test.ts` | Export package |
| `test:desktop` | `tests/desktop/app-shell.test.ts` | Desktop smoke |
| `test` | `npm run test:db && npm run test:printing` | **Does not include documents/workflows** |
| `build` | `vite build` | Frontend build |
| `serve` | `tsx src/server/index.ts` | Server |

**There is no `test:printing-contracts` script.** It must be added.

### 7.2 Harnesses

- **DB/migration harness:** `tests/db/migration-suite.ts` (in-memory PGlite, migrations).
- **API harness:** `tests/documents/documents-and-invoicing.test.ts` creates an in-memory server (`createServerDatabase(cfg, { inMemory: true, seedDemo: true })`), logs in as admin/accountant/production, and uses a cookie HTTP client. This is the pattern for new contract API tests.
- **Existing contract coverage:** `tests/documents/documents-and-invoicing.test.ts` seeds a contract/milestone, checks the preview, generates a milestone invoice with `postgresContractId`/`postgresMilestoneNumber`, and checks attachment isolation. It does **not** test create/complete/cancel/renew/top-up/idempotency.
- **No `tests/printing/contracts.test.ts`.** It must be created.

### 7.3 Baseline commands to record in Phase 0

```powershell
git status --short
git log -1 --oneline
npm run lint
npm run test:printing
npm run test:documents
npm run test:workflows
npm run test:db
npm run build
```

Record exact exit codes and output in `docs/printing-contracts-remediation/01-baseline.txt`.

---

## 8. Finding-by-Finding Verification

### 8.1 Critical (C-01…C-09)

| ID | Status | Exact location | Evidence / reproduction | Proposed narrow fix | Migration impact | Audit correction |
|---|---|---|---|---|---|---|
| **C-01** | **Confirmed** | `printingRecordsService.ts:124-131` (count only), `190-215` (milestone insert), `960-963` (clamp), `994-996` (`isExhausted`); `0007:163-196` (no sum constraint) | Create accepts any `agreedAmount` values; complete deducts `min(agreed, remaining)`; contract becomes `exhausted` when `completed >= total` even if `remaining > 0` | Exact sum at create; `SUM <= total_prepaid` on add/update; no silent clamp; credit-balance state when all complete with balance; deferred DB trigger | 0020 trigger + computed/read fields; **no new status** | Wording should distinguish **create exact** vs **later ≤**; audit's "sum to prepaid" is too absolute for top-ups |
| **C-02** | **Confirmed** | `printingRoutes.ts:328-348` (no key read); `printingRecordsService.ts:142-161` (journal with no key); `accountingEngine.ts:1563-1588` (pre-check, no lock) | Two identical creates post two contracts and two deposit journals; retry after timeout double-counts | Claim `request_keys` atomically before mutation; pass key to `postJournalEntry`; replay original response; conflict on different payload | No schema change if using `status_code=202`/`response_json NULL` pending convention; otherwise add `completed_at` | Audit says "no idempotency key" — accurate at route level; `postJournalEntry` supports keys but is not wired and is race-prone |
| **C-03** | **Confirmed** | `printingRecordsService.ts:622-642` (cancel) | Cancel sets status + notes only; `remaining_balance` and liability untouched; no refund/forfeit journal | Add `settlement_mode` (`refund`/`forfeit`); post Dr liability / Cr bank or income; insert bank row for refund; set cancellation metadata; block reactivation after settlement | 0020 columns: `cancelled_at`, `cancelled_by`, `cancellation_reason`, `settlement_mode`, `settled_amount`, `settlement_journal_txn_id` | Correct |
| **C-04** | **Confirmed** | `printingRecordsService.ts:673-705` | Renew calls `createPrintingContract` with old `start_date`, `end_date`, `total_prepaid_amount`, `deposit_bank_account_id`; posts a bank debit/unearned credit without new cash | Require `depositAmount`, `depositBankAccountId`, `depositDate`, new dates, optional schedule; post one deposit journal + bank row; new contract; idempotency | Uses 0020 columns; no extra table | Correct |
| **C-05** | **Confirmed** | `printingRecordsService.ts:135-140` (contract MAX), `323-327` + `342` (exam MAX); `0007:139`, `257` (unique) | `MAX(contract_number)` string split; `CTR-2026-99` vs `CTR-2026-100` breaks lexicographic MAX; concurrent creates collide; exam papers same at 10,000 | Transactional company/year counter table + `next_printing_number()`; backfill from actual series; overflow guard; RLS | 0020: `printing_number_counters` + function | Audit only mentioned contracts; **exam papers are also affected** |
| **C-06** | **Confirmed** | `printingRecordsService.ts:142-161` (no bank insert); `1042-1073` (wallet reads `bank_transactions`); `bankingService.ts:368-440` (canonical pattern) | Backend contract deposits never create `bank_transactions`; wallet modal is empty; bank reconciliation is blind | Insert one `bank_transactions` row per deposit/top-up/refund, linked via `journal_txn_id`; sign convention (positive inflow, negative outflow); do not set `running_balance`; idempotent | No schema change | Correct |
| **C-07** | **Confirmed** | `printingRoutes.ts:328-348`, `469-480`; `printingApi.ts:97-126`, `208-215` | Routes do not read `idempotency-key`; API does not send it | Route + service + API changes; same claim protocol as C-02 | None | Correct |
| **C-08** | **Confirmed** | `AccountingContext.tsx:2176-2208` (try/catch), `2223-2253` (local fallback) | Any backend error (including 400/409) falls through to local contract creation and local ledger/bank mutation | Distinguish `ApiError` 4xx (rethrow, no local mutation) from network/5xx (fail closed); no local ledger for server-backed contracts | None | Correct |
| **C-09** | **Confirmed** | `AccountingContext.tsx:2265-2335`, `2359-2468` (optimistic update before API), `2488-2623`; `PrintingContractsView.tsx:291-306`, `582-590` | Complete updates local state first, calls API without await, shows success; cancel/activate/renew/amend/add/remove are sync fire-and-forget | Make all contract mutations async; await backend; rollback on error; disable repeat submits; toast only after confirmation; reuse idempotency keys | None | Correct |

### 8.2 High (H-01…H-15)

| ID | Status | Exact location | Evidence | Proposed narrow fix | Migration impact | Audit correction |
|---|---|---|---|---|---|---|
| **H-01** | **Partially confirmed** | `printingRecordsService.ts:570-610` (`amend` no `FOR UPDATE`), `837-906` (`updateContractAssessment` loads contract without `FOR UPDATE`; locks milestone only) | Amend and update can interleave with completion/cancel | Lock parent contract `FOR UPDATE` in amend/update; reject date changes after completion; use `version`/`updated_at` | 0020 `version` column (optional) | Audit said "amend/update do not lock" — correct; **add already locks** |
| **H-02** | **Partially confirmed** | `addContractAssessment` `728-731` (**does** require active); `removeContractAssessment` `798-801` (no status); `updateContractAssessment` `845` (no status) | Add is guarded; remove/update are not | Require `status='active'` in all three; lock parent; audit | None | **Correction:** audit's blanket "add/remove/update do not require active" is wrong; only remove/update |
| **H-03** | **Confirmed** | `printingRecordsService.ts:271-397` | No contract load/validation in `createExamBatch`; `contract_id`/`assessment_number` accepted blindly | Validate contract belongs to school, assessment in range, assessment pending, contract active; stable errors | None | Correct |
| **H-04** | **Confirmed** | `printingRecordsService.ts:1167-1206` | Only `invoiced` blocked; `completed → queued` allowed; `queued → completed` allowed | Explicit transition table: `queued→printing`, `printing→completed`, `printing→queued` (reason), no exit from `completed`/`invoiced` | None | Correct |
| **H-05** | **Confirmed** | `printingRecordsService.ts:14-20`; `87-91`, `205`; `amend` `584-589` | Regex only; `2026-02-30` passes; no `start ≤ scheduled ≤ end`; no unique assessment pre-check | Real calendar validation; range check; unique/sequential check | None | Correct |
| **H-06** | **Confirmed** | Route `498` passes `examBatchNote`; service `addContractAssessment` INSERT `750-771` omits it; `createPrintingContract` INSERT `190-215` omits it; input type `48-59` omits it | Note is silently dropped | Trace UI field → persist on correct entity/column; add round-trip test; or remove the route parameter | None | Correct |
| **H-07** | **Confirmed** | `printingRoutes.ts:50-61` | No `23503`, `22P02`, `22007`, `23502`, `40001` mapping; unknown → 500 | Map known codes to 409/400; generic 500 + request ID | None | Add concrete repro: delete an exam paper with a `printing_jobs` or `delivery_note_lines` row → `23503` → 500 |
| **H-08** | **Confirmed** | `printingRoutes.ts:54-60` | Unknown errors return `err.message` | Log full detail server-side; return generic message + `requestId` | None | Correct |
| **H-09** | **Confirmed** | Route inventory; no top-up endpoint | Cannot add a deposit to an existing contract | Add `POST /printing/contracts/:id/deposits` + service + UI; Dr Bank / Cr liability; bank row; totals update; idempotency | None | Correct |
| **H-10** | **Confirmed** | `AccountingContext.tsx:612-646`; `printingRecordsService.ts:492-536` | `mapApiContract` drops deposit invoice fields and milestone `linkedInvoiceId`/`linkedInvoiceNumber`; after refresh links disappear | Return and map all invoice fields; persist deposit invoice columns; add `linked_invoice_number` | 0020: `deposit_invoice_id`, `deposit_invoice_number`, `linked_invoice_number` | Correct |
| **H-11** | **Confirmed** | `types/documents.ts:416-440` (milestone payload); `PrintingContractsView.tsx:325-345` (onInvoiceGenerated only deposit); `documentsService.ts:1515-1521` | Milestone payload omits `postgresContractId`/`postgresMilestoneNumber`; backend already supports linking when present | Add fields to payload; link milestone in callback; test reload | None | Correct |
| **H-12** | **Confirmed** | `ContractActionModals.tsx:167` | `nextNumber = assessments.length + 1`; after removing #3 from [1,2,3,4], proposes #4 (exists) | Compute first free slot in 1..5; server validates | None | Correct |
| **H-13** | **Confirmed** | `PrintingContractsView.tsx:582-590`; `AccountingContext.tsx:2408-2415` | Cancel/activate/renew sync + immediate toast; complete does not await API | Async + await + error toast + pending state | None | Correct |
| **H-14** | **Confirmed** | `types/documents.ts:416-440` | Same as H-11; milestone invoice payload lacks link fields | Same as H-11 | None | Correct (merge with H-11) |
| **H-15** | **Confirmed** | `types/accounting.ts:215-217`; `printingRecordsService.ts:515-536`; `0007:118-151` | Deposit invoice fields exist in TS but no DB columns; local-only | Add columns + composite FK; return/map; audit link | 0020 columns | Correct |

### 8.3 Medium (M-01…M-16)

| ID | Status | Exact location | Evidence | Proposed narrow fix | Migration impact | Audit correction |
|---|---|---|---|---|---|---|
| **M-01** | **Confirmed** | `printingRecordsService.ts:538-555` | One `loadMilestones` query per contract | Batch-load milestones `WHERE contract_id = ANY($2)`; group in memory | Index on `contract_id` | Correct |
| **M-02** | **Confirmed** | `printingRecordsService.ts:22-46` (liability), `908-931` (income) | Liability falls back to `PayrollLiability`; income falls back to any `Income`; `OtherIncome` is not a valid `account_type` | Explicit configured accounts; fail closed; remove PayrollLiability fallback; remove invalid `OtherIncome` | None | Add note: `OtherIncome` is invalid in `0002:12` |
| **M-03** | **Confirmed** | `printingRecordsService.ts:965`; `328`, `347`, `140`; `commercialHelpers.ts:54-56` | UTC date/year; no company timezone | Use DB `CURRENT_DATE`/`NOW()`; add timezone column only if approved | Optional `timezone` column | Correct |
| **M-04** | **Confirmed** | `printingRecordsService.ts:515-536`; `types/accounting.ts:199-219` | No `updatedAt`; `liabilityAccountId` number vs string; type missing | Return `updatedAt`, `liabilityAccountId`; add to type; use `version` for concurrency | 0020 `version` (optional) | Correct |
| **M-05** | **Confirmed** | `printingRecordsService.ts:492-513`; `0007:163-196` | `linked_invoice_id` returned only as `backendInvoiceId`; no invoice number | Add `linked_invoice_number`; return `linkedInvoiceId`/`linkedInvoiceNumber` | 0020 column | Correct |
| **M-06** | **Confirmed** | `printingRoutes.ts:91-98`, `400-409`, `611-620` | No pagination/filters on contracts/exam papers/jobs | Add `limit`, `offset`, `status`, `customerId`, `contractId`; return `{items,total}` | Indexes | Correct |
| **M-07** | **Confirmed** | `printingRoutes.ts:611-620`; no exam-batch GET | No `GET /printing/exam-batches`; exam papers unfiltered | Add list endpoint + filters | None | Correct |
| **M-08** | **Confirmed** | `printingRecordsService.ts:271-397` | Duplicate of H-03 | Same as H-03 | None | Merge with H-03 for implementation; keep ID for traceability |
| **M-09** | **Confirmed** | `PrintingContractsView.tsx:518-525` | `entityId: 1` hardcoded | Use `selectedContract.backendId`; disable if no backend | None | Correct |
| **M-10** | **Confirmed** | `AccountingContext.tsx:699-707` | Empty backend list returns early; non-empty replaces all local; source precedence undefined | Define: server mode → backend authoritative; empty clears; demo mode → keep demo; separate `source` field | None | Correct |
| **M-11** | **Confirmed** | `AccountingContext.tsx:719-731` | Every `ACCOUNTING_UPDATED_EVENT` refreshes all contracts | Targeted `refreshContract(id)` after mutation; debounce global refresh; version guard | None | Correct |
| **M-12** | **Confirmed** | `ContractActionModals.tsx:537-565` | Wallet running balance heuristic (`amount > 0` = deposit); no GL reconciliation | Use authoritative bank rows + GL liability lines; show variance | None | Correct |
| **M-13** | **Confirmed** | `ContractActionModals.tsx:500`; `types/accounting.ts:199-219` | `(contract as any).liabilityAccountId` | Add `liabilityAccountId?: number`; remove `as any` | None | Correct |
| **M-14** | **Confirmed** | `types/documents.ts:388`; `AccountingContext.tsx:644` | `nextPending` checks only `!linkedInvoiceId`, ignores `backendInvoiceId` | Check both; use persisted link fields | None | Correct |
| **M-15** | **Confirmed** | `app.ts:58-63` | Global production rate limits only | Add stricter limits for create/renew/top-up/complete | None | Correct |
| **M-16** | **Confirmed** | `permissions.ts:147-190`, `226-256`; `printingRoutes.ts:560-582` | ProductionManager/Bookkeeper can recognise revenue via `printing:write` | Add `printing:contracts:manage`; split production vs financial | Permission seed update | Correct |

### 8.4 Low (L-01…L-07)

| ID | Status | Exact location | Evidence | Proposed narrow fix | Migration impact | Audit correction |
|---|---|---|---|---|---|---|
| **L-01** | **Confirmed** | `AccountingContext.tsx:2578` | `(c.totalAssessments + 1) as 2\|3\|4\|5` can exceed 5 | Runtime guard; max 5 | None | Correct |
| **L-02** | **Confirmed** | `PrintingContractsView.tsx:265` | `Math.abs(draftSum - total) > 0.05` | Use `0.005` or exact decimal comparison | None | Correct |
| **L-03** | **Confirmed** | `PrintingContractsView.tsx` schedule conditional | No empty state when no contracts | Add empty state | None | Correct |
| **L-04** | **Confirmed** | `ContractActionModals.tsx:402-438` | History synthesized client-side; omits amend/cancel/activate/renew | Add `GET /printing/contracts/:id/history` from `audit_log` | None | Correct |
| **L-05** | **Confirmed** | `printingRoutes.ts:60` | Raw 500 message | Generic 500 + request ID | None | Correct |
| **L-06** | **Confirmed** | No module docs | No lifecycle/accounting documentation | Add `docs/printing-contracts.md` | None | Correct |
| **L-07** | **Confirmed** | `AccountingContext.tsx:335` (`Math.round`), `printingWorkflows.ts:96-98` (`Math.round`), `decimal.ts:70-79` (`HALF_EVEN`) | Client/server rounding differs | Shared dependency-safe helper; parity tests | None | Add `types/documents.ts:696` as another `Math.round` site |

---

## 9. New Findings Discovered During Verification

These were not in the original audit but are material to the remediation.

| ID | Severity | Finding | Evidence | Required action |
|---|---|---|---|---|
| **N-01** | High | Contract preview hardcodes `currencyCode: 'ZMW'` | `documentsService.ts:1184` | Use `companies.base_currency` |
| **N-02** | High | `companies.base_currency` defaults to `ZMW`; seed company is `ZMW`; conflicts with Malawi/MWK premise | `0001:59`; `db.ts:151`; `db.ts:224-231` | Business decision; do not hardcode either code |
| **N-03** | Critical | `postJournalEntry` idempotency pre-check is not concurrency-safe; unique index turns race into 409 | `accountingEngine.ts:1563-1588`; `0009:38-39` | Claim/reservation protocol |
| **N-04** | High | `checkRouteIdempotency` uses non-canonical `JSON.stringify` | `commercialHelpers.ts:414-439` | Canonical hash helper |
| **N-05** | High | `request_keys` has no pending state; `saveRouteIdempotency` `ON CONFLICT DO NOTHING` | `0001:281-297`; `commercialHelpers.ts:441-477` | Use `status_code=202`/`response_json NULL` or add `completed_at` |
| **N-06** | High | `printingApi` never sends `idempotency-key` | `printingApi.ts:97-325` | Add headers/params to all financial calls |
| **N-07** | High | `CompanyProfile.isServerEdition` unused; `backendId` is the only discriminator | `types/accounting.ts:434`; `AccountingContext.tsx` | Use `isServerEdition` + `authenticated` for mode |
| **N-08** | High | `printing_contracts` has no `currency_code` | `0007:118-151` | Add nullable → backfill → NOT NULL |
| **N-09** | High | No cancellation metadata (`cancelled_at/by/reason`, `settlement_*`) | `0007:118-151` | Add columns |
| **N-10** | Medium | No `completed_by`/`completed_at` on milestones | `0007:163-196` | Add columns |
| **N-11** | High | No `deposit_invoice_id`/`deposit_invoice_number` on contracts | `0007:118-151`; `types/accounting.ts:215-217` | Add columns + composite FK |
| **N-12** | Medium | No `linked_invoice_number` on milestones | `0007:163-196`; `types/accounting.ts:196` | Add column |
| **N-13** | Medium | No `credit_balance`/`partially_allocated` status; adding one is a breaking change | `0007:134`; `types/accounting.ts:213` | Keep 3 statuses; use computed flags/read fields |
| **N-14** | Medium | `exam_papers` has no `cancelled` status | `0007:252`; `printingRoutes.ts:627` | Do not add; use transition table within existing statuses |
| **N-15** | Medium | `bank_transactions.txn_type` was extended in 0010; sign convention is signed amount; `running_balance` is computed on read | `0010:216-227`; `bankingService.ts:177-181`; `purchasingService.ts:1349-1374` | Use `Deposit` (positive) / `Debit` (negative); do not persist running balance |
| **N-16** | Medium | No indexes on `printing_contracts(company_id, status)` or milestones | `0007` | Add indexes |
| **N-17** | Medium | Contract/exam year and date defaults use UTC | `printingRecordsService.ts:140`, `328`, `347`, `965` | Use DB `CURRENT_DATE`/company timezone |
| **N-18** | High | Deleting an exam paper with a `printing_jobs` or `delivery_note_lines` row raises `23503`, mapped to 500 | `0007:316-317`, `460-461`; `printingRoutes.ts:50-61` | Map `23503` → 409; consider blocking delete with a domain error |

---

## 10. Proposed Migration Design (Corrected)

### 10.1 Principles

- **No `ZMW` default** for new columns. Use `companies.base_currency`.
- **Composite FKs must match local columns.** A one-column FK cannot reference `(company_id, id)`.
- **No new contract status.** Keep `active | exhausted | cancelled`; represent credit balance with `remaining_balance > 0` + computed flags.
- **RLS + FORCE** on any new table.
- **Deferred trigger** for the allocation invariant, with parent-row locking.
- **Roll-forward first.** `.down.sql` is for disposable test DBs only.

### 10.2 `printing_contracts` additions

```sql
ALTER TABLE printing_contracts
  ADD COLUMN deposit_invoice_id BIGINT,
  ADD COLUMN deposit_invoice_number VARCHAR(64),
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN cancelled_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN cancellation_reason TEXT,
  ADD COLUMN settlement_mode VARCHAR(16)
    CHECK (settlement_mode IS NULL OR settlement_mode IN ('refund', 'forfeit')),
  ADD COLUMN settled_amount NUMERIC(19,4) NOT NULL DEFAULT 0.0000
    CHECK (settled_amount >= 0),
  ADD COLUMN settlement_journal_txn_id BIGINT,
  ADD COLUMN currency_code CHAR(3),
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Composite FKs (local column + company_id)
ALTER TABLE printing_contracts
  ADD CONSTRAINT fk_contracts_deposit_invoice
  FOREIGN KEY (company_id, deposit_invoice_id)
  REFERENCES invoices (company_id, id) ON DELETE RESTRICT;

ALTER TABLE printing_contracts
  ADD CONSTRAINT fk_contracts_settlement_journal
  FOREIGN KEY (company_id, settlement_journal_txn_id)
  REFERENCES journal_transactions (company_id, id) ON DELETE RESTRICT;

-- Backfill currency from the company, then enforce NOT NULL.
UPDATE printing_contracts pc
   SET currency_code = c.base_currency
  FROM companies c
 WHERE c.id = pc.company_id
   AND pc.currency_code IS NULL;

ALTER TABLE printing_contracts
  ALTER COLUMN currency_code SET NOT NULL;
```

**Why `currency_code` is nullable first:** existing rows have no currency; a hardcoded default would be wrong. Backfill from the company and then enforce.

### 10.3 `contract_assessment_milestones` additions

```sql
ALTER TABLE contract_assessment_milestones
  ADD COLUMN linked_invoice_number VARCHAR(64),
  ADD COLUMN completed_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN completed_at TIMESTAMPTZ;
```

### 10.4 Number counters

```sql
CREATE TABLE printing_number_counters (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  scope      VARCHAR(32) NOT NULL,
  year       SMALLINT NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, scope, year)
);

ALTER TABLE printing_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE printing_number_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY p_printing_number_counters_isolation
  ON printing_number_counters
  USING (app_rls_allowed(company_id))
  WITH CHECK (app_rls_allowed(company_id));
```

Function sketch (must include an overflow guard):

```sql
CREATE FUNCTION next_printing_number(
  p_company_id BIGINT,
  p_scope TEXT,
  p_year SMALLINT,
  p_prefix TEXT,
  p_width INT
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_last INT;
  v_text TEXT;
BEGIN
  INSERT INTO printing_number_counters (company_id, scope, year, last_value)
  VALUES (p_company_id, p_scope, p_year, 1)
  ON CONFLICT (company_id, scope, year)
  DO UPDATE SET last_value = printing_number_counters.last_value + 1
  RETURNING last_value INTO v_last;

  v_text := v_last::TEXT;
  IF length(v_text) > p_width THEN
    RAISE EXCEPTION 'PRINTING_NUMBER_OVERFLOW: %/%/%/%',
      p_company_id, p_scope, p_year, v_last
      USING ERRCODE = '22001';
  END IF;

  RETURN p_prefix || p_year || '-' || LPAD(v_text, p_width, '0');
END;
$$;
```

**Backfill:** from the actual number strings, not `start_date`. Guard malformed suffixes:

```sql
-- Report malformed legacy numbers first; do not silently cast.
SELECT company_id, contract_number
  FROM printing_contracts
 WHERE contract_number !~ '^CTR-[0-9]{4}-[0-9]+$';

-- Then seed counters from the numeric suffix.
INSERT INTO printing_number_counters (company_id, scope, year, last_value)
SELECT pc.company_id,
       'contract',
       CAST(split_part(pc.contract_number, '-', 2) AS SMALLINT),
       MAX(CAST(split_part(pc.contract_number, '-', 3) AS INTEGER))
  FROM printing_contracts pc
 WHERE pc.contract_number ~ '^CTR-[0-9]{4}-[0-9]+$'
 GROUP BY pc.company_id, split_part(pc.contract_number, '-', 2);
```

### 10.5 Allocation invariant trigger

The invariant must be **`SUM(agreed_amount) <= total_prepaid_amount`**, not equality, because top-ups can create an intentional unallocated credit.

```sql
CREATE OR REPLACE FUNCTION validate_contract_allocation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_contract_id BIGINT;
  v_total NUMERIC(19,4);
  v_sum NUMERIC(19,4);
BEGIN
  v_contract_id := COALESCE(NEW.contract_id, OLD.contract_id);

  -- Lock the parent so concurrent child writes serialise.
  SELECT total_prepaid_amount INTO v_total
    FROM printing_contracts
   WHERE company_id = COALESCE(NEW.company_id, OLD.company_id)
     AND id = v_contract_id
   FOR UPDATE;

  SELECT COALESCE(SUM(agreed_amount), 0) INTO v_sum
    FROM contract_assessment_milestones
   WHERE company_id = COALESCE(NEW.company_id, OLD.company_id)
     AND contract_id = v_contract_id;

  IF v_sum > v_total THEN
    RAISE EXCEPTION 'ASSESSMENT_SUM_MISMATCH: % > %',
      v_sum, v_total
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_validate_contract_allocation
  AFTER INSERT OR UPDATE OF agreed_amount OR DELETE
  ON contract_assessment_milestones
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_contract_allocation();
```

**Also trigger on parent total changes** (top-up):

```sql
CREATE OR REPLACE FUNCTION validate_contract_total_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_sum NUMERIC(19,4);
BEGIN
  SELECT COALESCE(SUM(agreed_amount), 0) INTO v_sum
    FROM contract_assessment_milestones
   WHERE company_id = NEW.company_id AND contract_id = NEW.id;

  IF v_sum > NEW.total_prepaid_amount THEN
    RAISE EXCEPTION 'ASSESSMENT_SUM_MISMATCH: % > %',
      v_sum, NEW.total_prepaid_amount
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_validate_contract_total
  AFTER UPDATE OF total_prepaid_amount
  ON printing_contracts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_contract_total_change();
```

**Service rules (not DB):**
- Create: `SUM(agreed_amount) === total_prepaid_amount` (exact).
- Add/update: `SUM(agreed_amount) <= total_prepaid_amount`.
- Top-up: `new_total >= current_sum`; excess is unallocated.
- Completion: post exactly `agreed_amount`; reject if `remaining < agreed`; do not clamp.
- All assessments complete + `remaining > 0`: remain `active` (or a read-only "credit balance" view); require refund/forfeit/renewal.

### 10.6 Indexes

```sql
CREATE INDEX ix_printing_contracts_company_status
  ON printing_contracts (company_id, status);

CREATE INDEX ix_contract_milestones_company_status
  ON contract_assessment_milestones (company_id, status);

CREATE INDEX ix_contract_milestones_contract_number
  ON contract_assessment_milestones (company_id, contract_id, assessment_number);
```

### 10.7 Down migration

- Drop triggers, functions, counters table, indexes, and new columns.
- **Do not** drop columns that contain financial history in production.
- Document the point after which destructive down migration is prohibited.
- Up/down tests only on disposable seeded DBs.

### 10.8 Preflight / legacy data

Before enabling strict constraints:

1. Report contracts where `SUM(agreed_amount) > total_prepaid_amount`.
2. Report contracts where `SUM(agreed_amount) < total_prepaid_amount` and `completed_assessments = total_assessments` and `remaining_balance > 0`.
3. Report malformed contract/exam numbers.
4. Report contracts with missing/unknown liability or bank accounts.
5. Report `remaining_balance < 0` or `> total_prepaid_amount` (should be impossible).
6. Quarantine mismatches; do not silently rewrite financial data.

---

## 11. Open Business Decisions (Required Before Schema/Code)

| # | Decision | Why it blocks | Recommended default (for sign-off) |
|---|---|---|---|
| **D-01** | Is the deployment currency `ZMW` or `MWK`? | Determines `currency_code` backfill and document templates | Use `companies.base_currency`; if Malawi, update company to `MWK` and re-label documents |
| **D-02** | Refund policy for cancelled contracts | C-03 cannot be implemented without a settlement mode | Require explicit `refund` or `forfeit`; refund to a selected active bank account; never arbitrary |
| **D-03** | Which income account for forfeiture? | C-03 forfeiture needs a target account | Explicit `4000/4010/4900` config; no fallback to arbitrary income |
| **D-04** | Is top-up allowed? How is unallocated credit handled? | H-09 and C-01 depend on allocation policy | Allow top-up; show unallocated amount; require allocation or refund before completion |
| **D-05** | What happens when all assessments complete with a positive balance? | C-01 completion state | Keep contract `active` with a "credit balance" flag; require refund/forfeit/renewal; never mark exhausted |
| **D-06** | Is colour printing supported for contracts? | M-17 / colour costing observation | If no, block/warn colour jobs and document; if yes, add channel-aware costing + capability config |
| **D-07** | Which roles may create/complete/cancel/renew/top-up contracts? | M-16 RBAC split | Administrator, Accountant, Bookkeeper; **not** ProductionManager by default |
| **D-08** | Timezone source | M-03 date correctness | DB session timezone (`CURRENT_DATE`); add company timezone only if multi-timezone is real |
| **D-09** | Can a settled/cancelled contract be reactivated? | C-03 activation guard | No; require renewal/new contract |
| **D-10** | Is exact allocation at creation still the business rule? | C-01 create validation | Yes: `SUM === total_prepaid` at creation |

---

## 12. Corrected Dependency Order

```
Phase 0 (this report + baseline tests)
        │
        ▼
Business decisions D-01…D-10
        │
        ▼
Phase D1: migration 0020 (columns, counters, indexes, triggers, backfill)
        │
        ▼
Phase A1: allocation invariants (service + trigger + no clamp)
Phase A2: idempotency claim protocol (create/renew/top-up/complete/cancel)
Phase A6: bank subledger integration
Phase A7: fail-closed frontend
Phase A3: cancellation settlement
Phase A4: renewal with real deposit
Phase A5: number counters
        │
        ▼
Phase B1: invoice links
Phase B2: assessment hardening
Phase B3: exam batch validation
Phase B4: exam status transitions
Phase B5: error mapping
Phase B6: top-up endpoint
Phase B7: attachment identity
        │
        ▼
Phase C1–C10: robustness/security/performance
        │
        ▼
Phase E: service/API/concurrency/UAT tests + reconciliation
        │
        ▼
Phase F: docs/release
```

**Why migration first:** C-03/C-04/H-10/H-15 all require columns; doing them without a migration would create a second, conflicting schema change. The service-only fixes (A1 validation, A2 claim protocol, A7 frontend) can be developed in parallel, but must not ship before the migration.

---

## 13. Phase Execution Plan (Corrected)

### Phase 0 — Baseline (current)

- [x] Repository inspection.
- [x] This verification report.
- [ ] Record `git status`, `git log -1`, `npm run lint`, all test commands, and exit codes in `01-baseline.txt`.
- [ ] Create branch `fix/printing-contracts-99` (or repo convention).
- [ ] Add characterization tests for current contract behaviour (expected-to-change marked).
- [ ] Present this report and D-01…D-10 for review.

**Gate:** report reviewed; business decisions recorded; baseline green/known-failing documented.

### Phase A — Critical financial integrity

| ID | Work | Depends on |
|---|---|---|
| A1 | Allocation invariants: exact at create, ≤ later, no clamp, credit-balance completion, deferred trigger | D-04, D-05, D-10, 0020 trigger |
| A2 | Idempotency claim/reservation protocol; canonical hash; pending state; replay/conflict | D-01? no; 0020 optional `request_keys` convention |
| A3 | Cancellation settlement: refund/forfeit, bank row, metadata, no reactivation | D-02, D-03, D-09, 0020 columns |
| A4 | Renewal with real deposit: new amount/date/bank, new contract, idempotency | 0020 columns, A2 |
| A5 | Collision-safe contract + exam numbers: counter table/function, backfill, overflow | 0020 counters |
| A6 | Bank subledger: deposit/top-up/refund rows linked to journal; no running balance | A3, A4, N-15 |
| A7 | Fail-closed frontend: async, rollback, no local ledger, idempotency keys, pending state | N-06, N-07 |

**Gate:** all nine S1 findings have failing-then-passing tests; atomicity proven; no false-success/local-fallback path remains.

### Phase B — Workflow and data links

| ID | Work | Depends on |
|---|---|---|
| B1 | Persist deposit/milestone invoice links; payload fields; callback; reload | 0020 columns, A7 |
| B2 | Lock parent; require active; first-free numbering; sum checks; date lock | A1 |
| B3 | Exam batch contract/school/assessment validation | — |
| B4 | Exam paper transition table | — |
| B5 | Safe error mapping; generic 500 + request ID | — |
| B6 | Top-up endpoint + service + UI | A1, A2, A6 |
| B7 | Attachment entity ID | — |

**Gate:** all H findings closed with service/API/document tests.

### Phase C — Robustness, correctness, security, performance

| ID | Work |
|---|---|
| C1 | Real date validation + range + business timezone |
| C2 | Explicit liability/income accounts; remove PayrollLiability and invalid `OtherIncome` |
| C3 | Timezone-safe dates |
| C4 | Refresh precedence + race handling; use `isServerEdition` |
| C5 | Wallet reconciliation: bank register + GL variance |
| C6 | Serialization/type parity; remove `as any`; add `liabilityAccountId`, `updatedAt` |
| C7 | N+1 fix; pagination/filters; exam-batch list |
| C8 | RBAC split + rate limits |
| C9 | `exam_batch_note` end-to-end persistence |
| C10 | Shared exact-decimal rounding; HALF_EVEN parity |
| C11 | Colour costing decision + block/warn or implement |

**Gate:** all M findings and required L findings pass; no type escape hatches or hidden fallbacks.

### Phase D — Schema migration

- [ ] Final field list frozen.
- [ ] 0020 up/down written.
- [ ] Preflight reports run.
- [ ] Up migration on clean + representative legacy DBs.
- [ ] Down migration on disposable DB only.
- [ ] Direct SQL invariant tests.
- [ ] Production roll-forward + backup/restore documented.

**Gate:** clean up/down; data checks zero or signed-off quarantine; rollback procedure documented.

### Phase E — Certification

- [ ] Service tests (create/complete/cancel/renew/top-up/schedule/numbering/exam/status).
- [ ] API/security tests (auth, tenant, RBAC, error mapping, idempotency).
- [ ] Frontend/context tests (fail-closed, rollback, refresh, links).
- [ ] Concurrency tests (same key, same milestone, same contract).
- [ ] Reconciliation tests (contract ↔ GL liability; milestone ↔ income; bank ↔ journal).
- [ ] 30-day shadow run; 0.00 unexplained variance; finance sign-off.

**Gate:** all suites pass; exactly one posting under concurrency; reconciliation independently reproducible.

### Phase F — Documentation and release

- [ ] `docs/printing-contracts.md` (lifecycle, entries, statuses, idempotency, RBAC, migration, reconciliation).
- [ ] `FINAL-CERTIFICATION.md`.
- [ ] Release checklist, backup, roll-forward, monitoring.
- [ ] Update audit report with final status per finding.

**Gate:** all gates passed; no open S1/S2/S3; sign-offs recorded.

---

## 14. Traceability Baseline

| Severity | Count | IDs | Verified status |
|---|---:|---|---|
| Critical | 9 | C-01…C-09 | 9 confirmed |
| High | 15 | H-01…H-15 | 14 confirmed, 1 partially (H-02 wording corrected) |
| Medium | 16 | M-01…M-16 | 16 confirmed |
| Low | 7 | L-01…L-07 | 7 confirmed |
| **Total** | **47** | | **47 verified** |
| New | 18 | N-01…N-18 | 18 verified |

The final `FINAL-CERTIFICATION.md` must include one row per finding with:

`Finding ID | Verified status | Work package | Code location | Test name | Test result | Evidence | Residual risk`

No finding may be marked "closed" without a passing test or an explicit "not reproduced/obsolete" rationale.

---

## 15. Evidence Index

### 15.1 Schema

- `db/migrations/0001_core_identity_and_companies.up.sql:46-73` — companies (currency, rounding).
- `db/migrations/0001...up.sql:80-92` — users (global).
- `db/migrations/0001...up.sql:281-297` — request_keys.
- `db/migrations/0002_accounting_coa_and_gl.up.sql:5-39` — accounts.
- `db/migrations/0002...up.sql:41-103` — journal_transactions/lines.
- `db/migrations/0003_contacts_sales_and_receivables.up.sql:117-156` — invoices.
- `db/migrations/0004_purchases_payables_and_banking.up.sql:348-412` — bank_transactions/bank_accounts.
- `db/migrations/0007_printing_production_exams_contracts.up.sql:118-275` — contracts/milestones/exam batches/exam papers.
- `db/migrations/0009_accounting_foundation_enhancements.up.sql:8-10`, `38-39` — journal idempotency.
- `db/migrations/0010_commercial_fx_and_banking_enhancements.up.sql:216-227` — bank txn types/status.
- `db/migrations/0011_phase9_production_workflow_integration.up.sql:68-71` — printing source types.

### 15.2 Service

- `src/server/services/printingRecordsService.ts:14-20` — date validation.
- `src/server/services/printingRecordsService.ts:22-46` — liability account.
- `src/server/services/printingRecordsService.ts:74-270` — create contract.
- `src/server/services/printingRecordsService.ts:271-397` — create exam batch.
- `src/server/services/printingRecordsService.ts:492-536` — milestone/contract serialization.
- `src/server/services/printingRecordsService.ts:538-555` — list contracts (N+1).
- `src/server/services/printingRecordsService.ts:570-610` — amend.
- `src/server/services/printingRecordsService.ts:612-671` — status/cancel/activate.
- `src/server/services/printingRecordsService.ts:673-705` — renew.
- `src/server/services/printingRecordsService.ts:721-906` — add/remove/update assessment.
- `src/server/services/printingRecordsService.ts:908-1040` — income account + complete.
- `src/server/services/printingRecordsService.ts:1042-1073` — wallet.
- `src/server/services/printingRecordsService.ts:1167-1244` — exam status/delete.
- `src/server/services/accountingEngine.ts:1523-1816` — postJournalEntry.
- `src/server/services/bankingService.ts:138-181` — bank register/running balance.
- `src/server/services/bankingService.ts:368-440` — canonical expense/bank pattern.
- `src/server/services/commercialHelpers.ts:54-56` — todayIsoDate.
- `src/server/services/commercialHelpers.ts:331-477` — doc numbers + idempotency helpers.
- `src/server/services/documentsService.ts:1184` — hardcoded ZMW.
- `src/server/services/documentsService.ts:1444-1524` — invoice generation/linking.

### 15.3 Routes / API

- `src/server/routes/printingRoutes.ts:50-61` — error handler.
- `src/server/routes/printingRoutes.ts:328-650` — contract/exam routes.
- `src/server/routes/documentsRoutes.ts:110-127` — generate-invoice idempotency.
- `src/services/printingApi.ts:97-325` — contract API.
- `src/services/documentsApi.ts:81-91` — generate invoice.
- `src/services/http.ts:1-38` — ApiError/requestJson.

### 15.4 Frontend

- `src/context/AccountingContext.tsx:612-646` — mapApiContract.
- `src/context/AccountingContext.tsx:699-731` — refresh.
- `src/context/AccountingContext.tsx:2128-2623` — contract mutations.
- `src/components/views/PrintingContractsView.tsx:265` — customMismatch.
- `src/components/views/PrintingContractsView.tsx:291-345` — complete/preview.
- `src/components/views/PrintingContractsView.tsx:503-535` — attachment entityId.
- `src/components/views/PrintingContractsView.tsx:582-590` — actions.
- `src/components/modals/ContractActionModals.tsx:167` — add numbering.
- `src/components/modals/ContractActionModals.tsx:500` — liability as any.
- `src/components/modals/ContractActionModals.tsx:537-565` — wallet.
- `src/types/accounting.ts:178-219` — contract types.
- `src/types/documents.ts:369-524` — contract preview payload.
- `src/data/initialDemoData.ts:679+` — demo contracts.

### 15.5 Permissions / Tests

- `src/server/permissions.ts:60-61`, `147-190`, `226-256`.
- `package.json:13-29`.
- `tests/printing/paper-toner-calc.test.ts`.
- `tests/documents/documents-and-invoicing.test.ts:1-140`.
- `tests/db/migration-suite.ts`.
- `tests/workflows/phase9-e2e-workflows.test.ts`.

---

## 16. Phase 0 Completion Checklist

- [x] Repository inspected.
- [x] Migration head verified (`0019`, `0020` unused).
- [x] `bank_transactions` semantics verified.
- [x] `request_keys`/journal idempotency verified.
- [x] Currency verified (`ZMW` canonical; `MWK` not configured).
- [x] Timezone verified (UTC; no company timezone).
- [x] RBAC verified.
- [x] Frontend backend/demo discrimination verified.
- [x] Test scripts/harnesses verified.
- [x] All 47 audit findings verified.
- [x] New findings N-01…N-18 recorded.
- [x] Corrected migration design.
- [x] Corrected dependency order.
- [x] Phase execution plan.
- [x] Open business decisions.
- [ ] Baseline commands executed and recorded (`01-baseline.txt`).
- [ ] Branch/tag created.
- [ ] Report reviewed and approved.
- [ ] D-01…D-10 resolved.

**Status:** Phase 0 report complete; implementation not started. No production code, schema, or migrations changed.