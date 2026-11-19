# 12 — Phase A1 Architecture Verification

**Date:** 2026-11-19
**Branch:** `fix/printing-contracts-99`
**Base commit:** `933bcf32b9e570f97ef9d2f864274fd64c6d6e08`
**Mode:** Verification only — no code, schema, or migration changes
**Verdict:** **A1 COMPLETE WITH CRITICAL BLOCKER** — the assumed customer-wallet architecture does not exist.

---

## 1. Executive Summary

Phase A1 verified the live repository, the printing-contract module, the database schema, the financial services, RBAC, audit logging, document storage, synchronisation, and tenant isolation.

**Critical finding:** the Phase A master prompt assumes an existing **customer wallet** (`Customer wallet balance`, `WalletTransaction`). **No such table, entity, or service exists in the repository.**

What exists instead:

| Concept | Actual implementation | Meaning |
|---|---|---|
| `customers.balance` | `0003:20`; recomputed in `commercialHelpers.ts:511-519` | **Accounts receivable**: open invoices − credit memos − unapplied payments. It is what the customer owes, not prepaid funds. |
| `bank_transactions` | `0004:348-395` | Bank subledger. Deposits/debits against bank accounts. |
| `accounts.balance` | `0002`; updated in `accountingEngine.ts:652` | General-ledger account balances. |
| `printing_contracts.remaining_balance` | `0007:127` | Unearned contract liability. |
| Contract "wallet" UI | `printingApi.ts:294`; `printingRoutes.ts:593`; `printingRecordsService.ts:1042` | Reads `bank_transactions` by contract reference. Not a customer wallet. |

**Consequences:**
- D-04 (top-ups/unused funds), D-05 (funding eligibility), D-10 (activation requires wallet funds), R05 (insufficient-funds notification), and R06 (unused completed-contract funds) cannot be implemented safely until the business defines what "wallet" means.
- Phase A2 must **stop** at this blocker per the master prompt: "Stop if the existing wallet architecture cannot be safely reconciled."
- Do not replace the customer wallet with a bank balance (explicitly prohibited by the prompt). Do not invent a wallet design without approval.

**Other material gaps:**
- No `draft`, `suspended`, or `completed` contract status.
- No `companies.timezone` column.
- No Contract Manager role or contract-specific permissions.
- No contract cancellation/refund/forfeiture approval action types.
- No signature/acceptance table, no OTP/SMS provider.
- No contract amendment versioning or settlement table.
- No contract `currency_code` or colour/terms fields.
- Contract numbering uses `MAX(...)+1`, not a counter.
- `printingApi` does not send idempotency keys; the frontend is optimistic/fire-and-forget.

These are design/implementation dependencies for A3–A9, not A1 blockers except the wallet.

---

## 2. Repository State and Safety

| Item | Value |
|---|---|
| Requested path in prompt | `D:\Application\PrimeERPsystem` |
| **Actual repository path** | `C:\Users\Rhonald Chiwatu\Desktop\Projects\Printing System` |
| Branch | `fix/printing-contracts-99` |
| Commit | `933bcf32b9e570f97ef9d2f864274fd64c6d6e08` |
| Working-tree entries | 137 (pre-existing user changes) |
| Staged changes | None |
| Code/schema/migration changes by A1 | **0** |
| Commits created | 0 |

**Safety actions:**
- Verified branch and commit before inspection.
- Inspected staged, unstaged, and untracked files.
- Did not reset, clean, stash, overwrite, or commit.
- Only read files and wrote documentation under `docs/printing-contracts-remediation/`.

**Path discrepancy:** the prompt's `D:\Application\PrimeERPsystem` does not match the active workspace. All findings below refer to the actual path. If `D:\Application\PrimeERPsystem` is a separate clone, it must be inspected separately; this report does not cover it.

---

## 3. Document Reconciliation

| Document | Status | Use in A1 |
|---|---|---|
| `00-repository-verification.md` | Exists | 47 audit findings + 18 new |
| `00-repository-state.txt` | Exists | Git state |
| `01-baseline.txt` | Exists | Lint PASS; printing 17/18; documents 7/7; workflows 7/7; db 8/8; build PASS |
| `02-business-decisions.md` | Exists | D-01…D-12 approved (Stage 2) |
| `03-phase-0-closeout.md` | Exists | Phase 0 not approved for implementation |
| `04-migration-design-verification.md` | Exists | 18 migration findings |
| `05-idempotency-design.md` | Exists | Same-transaction claim design |
| `06-migration-design-remediation.md` | Exists | Corrected 0020 design |
| `07-numbering-and-locking-design.md` | Exists | Counter + lock order |
| `08-assessment-integrity-design.md` | Exists | Trigger-owned counts |
| `09-legacy-data-preflight-design.md` | Exists | Read-only preflight |
| `10-stage-2-verification-report.md` | Exists | Stage 2 complete with conditions |
| `11-FINAL-BUSINESS-DECISION-REGISTER.md` | **Created in A1** | All 36 decisions |
| `12-PHASE-A1-ARCHITECTURE-VERIFICATION.md` | **This report** | A1 evidence |

**Reconciliation note:** Stage 2 D-05/D-10 did not include customer signature or the funding-exhaustion rule; the Phase A prompt adds them. `11-FINAL-BUSINESS-DECISION-REGISTER.md` records the refinements. No decision was silently changed.

---

## 4. Existing Printing Contract Module

### 4.1 Database objects

| Object | Location | Current definition |
|---|---|---|
| `printing_contracts` | `0007:118-161` | `status` CHECK `active/exhausted/cancelled` (134); unique `(company_id, contract_number)` (139); composite FKs to `customers`, `accounts` (bank + liability), `journal_transactions` (140-147); `remaining_balance <= total_prepaid_amount` (149); `completed_assessments <= total_assessments` (150); RLS forced (157-161) |
| `contract_assessment_milestones` | `0007:163-202` | `status` `pending/completed` (179); unique `(company_id, contract_id, assessment_number)` (185); composite FKs (186-195); RLS forced (198-202); no `linked_invoice_number`, `completed_by`, `completed_at`, `color_mode` |
| `exam_assessment_batches` | `0007:205-232` | Unique `(company_id, school_customer_id, assessment_name, class_name)` (219); composite FKs (220-225) |
| `exam_papers` | `0007:234-275` | `status` `queued/printing/completed/invoiced` (252); unique `(company_id, job_number)` (257), `(company_id, batch_id, subject_name)` (258); index `(company_id, status, production_date)` (269) |

**Missing contract columns:** `currency_code`, `draft/suspended/completed` status, `color_mode`, `colour_included`, `activated_at/by`, `completed_at/by`, `cancelled_at/by/reason`, `settlement_mode/amount/journal`, `refund_*`, `deposit_invoice_id/number`, `renewal_of_contract_id`, `version`, `customer_signature_id`, `customer_acceptance_id`.

### 4.2 Service

`src/server/services/printingRecordsService.ts`

| Function | Lines | Current behaviour | Gap |
|---|---|---|---|
| `assertIsoDate` | 14-20 | Regex only | No real calendar validation |
| `resolveLiabilityAccount` | 22-46 | Codes 2250/2200/2100/2300; falls back to any liability incl. PayrollLiability | Unsafe fallback |
| `createPrintingContract` | 74-270 | `MAX(contract_number)+1` (135-140); posts deposit journal (142-161); inserts `active` (164-170); inserts milestones (190-215) | No draft; no idempotency; no currency; no sum check; no bank row |
| `createExamBatch` | 271-397 | `MAX(job_number)+1` (323-327); UTC year (328) | No contract validation; no counter |
| `amendPrintingContract` | 570-610 | No `FOR UPDATE`; updates title/dates/notes | No lock; no version; no approval |
| `setPrintingContractStatus` | 612-671 | Cancel sets status + notes (622-642); activate allows cancelled→active (643-667) | No settlement; no second-person approval; no reactivation guard |
| `renewPrintingContract` | 673-705 | Calls create with old dates/amount | No real deposit; no predecessor |
| `addContractAssessment` | 721-789 | Locks contract; requires active; inserts; `total_assessments+1` | No sum check; no exam_batch_note; no approval |
| `removeContractAssessment` | 791-835 | Locks contract; min 2; pending only; `total_assessments-1` | No status check; no sum check |
| `updateContractAssessment` | 837-906 | No parent lock; milestone `FOR UPDATE`; updates | No parent lock; no status check; no sum check |
| `resolveIncomeAccount` | 908-931 | Codes 4000/4010/4900; falls back to any Income | Unsafe fallback |
| `completeContractAssessment` | 933-1040 | Locks contract + milestone; clamps deduction (960-963); UTC date (965); `exhausted` when all done or zero (994-996) | Silent clamp; no funding check; no `completed`; UTC |
| `listContractWalletTransactions` | 1042-1073 | Reads `bank_transactions` by `ref_number` | Empty for backend contracts (no bank row) |
| `updateExamPaperStatus` | 1167-1206 | Only blocks `invoiced` | No transition table |
| `deleteExamPaper` | 1208-1244 | Blocks invoiced/completed | FK violation → 500 |

### 4.3 Routes

`src/server/routes/printingRoutes.ts`

| Route | Lines | Permission | Gap |
|---|---|---|---|
| `POST /printing/contracts` | 328-348 | `printing:write` | No idempotency; no draft |
| `GET /printing/contracts` | 400-409 | `printing:read` | No pagination/filter |
| `PATCH /printing/contracts/:id` | 424-441 | `printing:write` | No approval |
| `POST .../activate` | 443-454 | `printing:write` | No signature/funding check |
| `POST .../cancel` | 456-467 | `printing:write` | No settlement/approval |
| `POST .../renew` | 469-480 | `printing:write` | No deposit |
| `POST .../assessments` | 482-505 | `printing:write` | No sum/approval |
| `PATCH/DELETE .../assessments/:n` | 507-558 | `printing:write` | No approval |
| `POST .../assessments/:n/complete` | 560-582 | `printing:write` | No idempotency; clamp |
| `GET .../wallet-transactions` | 584-605 | `printing:read` | Empty |
| `GET /printing/exam-papers` | 611-620 | `printing:read` | No filters |
| `PATCH .../exam-papers/:id/status` | 622-637 | `printing:write` | No transitions |
| `DELETE .../exam-papers/:id` | 639-650 | `printing:write` | FK → 500 |

### 4.4 API client

`src/services/printingApi.ts`

- `createContract` (97-126) sends no `idempotency-key`.
- `cancelContract` (188-196) sends only `{reason}`.
- `renewContract` (208-215) sends `{}`.
- `addContractAssessment` (229-257) sends no idempotency key.
- `completeContractAssessment` (294-306) sends no idempotency key.
- `getContractWalletTransactions` (294) reads the contract wallet view.

### 4.5 Frontend

`src/context/AccountingContext.tsx`

- `mapApiContract` (612-646) drops deposit invoice links and milestone local invoice links.
- `refreshPrintingContractsFromBackend` (699-707) returns early on an empty list; non-empty replaces all local contracts.
- `ACCOUNTING_UPDATED_EVENT` triggers a global refresh (719-731).
- `addPrintingContract` (2128-2263): backend try/catch (2176-2208) falls back to a local ledger on **any** error (2223-2253).
- `updateContractAssessment` (2265-2335): optimistic local update, fire-and-forget API.
- `completeContractAssessment` (2359-2468): optimistic update before API; backend call not awaited; success shown.
- `cancelPrintingContract` (2488-2503), `activatePrintingContract` (2505-2516), `renewPrintingContract` (2518-2550), `amendPrintingContract` (2552-2572), `addContractAssessment` (2574-2603), `removeContractAssessment` (2605-2623): optimistic/fire-and-forget.

`src/components/views/PrintingContractsView.tsx`

- `customMismatch` tolerance `0.05` (265).
- `openContractPreview` (325-345) links only the deposit invoice.
- `handleAttachContractFile` (503-535) hardcodes `entityId: 1` (522).
- Contract actions (582-590) call sync fire-and-forget functions and toast success.
- "Edit Draft" action visible when `status !== 'active'` (588) — there is no draft status.

`src/components/modals/ContractActionModals.tsx`

- `AddAssessmentModal` uses `assessments.length + 1` (167).
- `ContractInfoModal` reads `(contract as any).liabilityAccountId` (500).
- Wallet view uses a heuristic running balance (537-565).

### 4.6 Types

`src/types/accounting.ts`

- `ContractAssessmentMilestone` (178-197): `linkedInvoiceId`, `backendInvoiceId`, `linkedInvoiceNumber` (but DB has no `linked_invoice_number`).
- `PrintingContract` (199-219): `status: 'active' | 'exhausted' | 'cancelled'` (213); `depositInvoiceId`, `depositBackendInvoiceId`, `depositInvoiceNumber` (215-217) exist in TS but not DB; `liabilityAccountId` missing.

### 4.7 Documents

`src/types/documents.ts`

- `mapContractToPreviewModel` (369-524): milestone payload (416-440) omits `postgresContractId`/`postgresMilestoneNumber`.
- `canGenerateInvoice` for contract requires `status === 'active'` (307) — will need `completed`/`suspended` handling.
- `currencyCode: 'ZMW'` hardcoded (561 in `documentsService.ts`; `documents.ts` uses company currency in some places).

`src/server/services/documentsService.ts`

- Contract preview (1155-1235) returns `status`, `total_prepaid_amount`, `remaining_balance`, `deposit_journal_txn_id`; hardcodes `currencyCode: 'ZMW'` at 561.
- `generateInvoiceFromWorkflow` (1444-1524) supports idempotency and links milestones when `postgresContractId` + `postgresMilestoneNumber` are present (1515-1521).

---

## 5. Database Inventory (Relevant Objects)

| Object | Location | Key columns / constraints |
|---|---|---|
| `companies` | `0001:46-73` | `base_currency CHAR(3) DEFAULT 'ZMW'` (59); `currency_symbol DEFAULT 'K'` (60); `rounding_mode` (64); `decimal_places` (65); `is_server_edition` (66); **no timezone** |
| `users` | `0001:80-92` | Global `id` PK; no company scope |
| `company_memberships` | `0001:95-110` | `role` CHECK `Administrator/Accountant/Bookkeeper/ProductionManager/Read-Only` (106) |
| `company_settings` | `0001:174-187` | Key-value per company; RLS forced |
| `request_keys` | `0001:190-204` | Unique `(company_id, route, idempotency_key)` (200); `payload_hash CHAR(64)`; `response_json`; RLS forced |
| `accounts` | `0002:5-39` | `account_type` includes `Bank`, `OtherCurrentLiability`, `LongTermLiability`, `PayrollLiability`, `Income`; unique `(company_id, lower(code))`; composite `(company_id,id)` |
| `journal_transactions` | `0002:41-82`; `0009:8-10`, `38-39` | Unique `(company_id,id)`; `idempotency_key` unique index; `source_type` includes `printing_contract` (0011) |
| `journal_lines` | `0002:84-103` | Composite FK to journal |
| `customers` | `0003:6-31` | `balance NUMERIC(19,4)` (20) — **AR balance**; `email`, `phone`; composite `(company_id,id)` |
| `invoices` | `0003:117-156` | Composite `(company_id,id)` (151); `source_type` includes contract/milestone (0015) |
| `bank_transactions` | `0004:348-395`; `0010:216-227` | `journal_txn_id` composite FK (377-378); `status` default posted (218); `offset_account_id` (219); `txn_type` includes Check/Deposit/Transfer/Bill Payment/Debit/Fee/Credit Card Charge/Credit Card Refund/Payment/Sales Receipt/Other (225-226) |
| `bank_accounts` | `0004:394-412` | `gl_account_id` → accounts; RLS forced |
| `stored_files` | `0006:345-357` | `storage_kind`, `original_name`, `content_type`, `size_bytes`, `sha256_hex`, `storage_key`; RLS forced |
| `attachments` | `0006:365-375` | `entity_type`, `entity_id`, `stored_file_id`; RLS forced |
| `email_log` | `0006:417-427` | `status queued/sent/failed` (0014 adds `skipped`); RLS forced |
| `audit_log` | `0006:436-450` | Append-only; `sha256_hash`; RLS; trigger `trg_audit_log_append_only` (456+) |
| `approval_policies` | `0013:11-27` | `action_type` CHECK 6 types; `threshold_amount`; `is_enabled`; `require_note`; RLS forced |
| `approval_requests` | `0013:43-73`; `0014` | `action_type` CHECK 8 types after 0014; `requested_by`, `decided_by`, `payload_json`, `idempotency_key`, `consumed_at`; RLS forced; unique idempotency index (75-77) |
| `printing_contracts` | `0007:118-161` | As above |
| `contract_assessment_milestones` | `0007:163-202` | As above |
| `exam_assessment_batches` | `0007:205-232` | As above |
| `exam_papers` | `0007:234-275` | As above |

**Migration head:** `0019_printing_smart_ops_and_pos.up.sql`; `0020` unused.

---

## 6. Customer Wallet Verification (Critical)

### 6.1 Search evidence

- `grep -i "wallet"` across `db/migrations`: **no table**.
- `grep "WalletTransaction|customer_wallet|wallet_balance"` across `src`: only the contract wallet UI/service.
- No `customer_wallets`, `wallet_transactions`, `wallet_entries`, or `WalletTransaction` entity.

### 6.2 What "wallet" currently means in the code

| Reference | Meaning |
|---|---|
| `printingApi.getContractWalletTransactions` (`printingApi.ts:294`) | Calls `/api/printing/contracts/:id/wallet-transactions` |
| `printingRoutes.ts:593` | Calls `listContractWalletTransactions(tx, companyId, contractNumber)` |
| `printingRecordsService.ts:1042-1073` | `SELECT ... FROM bank_transactions WHERE company_id=$1 AND ref_number=$2 ORDER BY txn_date, id` |
| `ContractInfoModal` (`ContractActionModals.tsx:537-565`) | Renders bank transactions with a heuristic running balance |

**It is a bank-transaction view filtered by contract number. It is not a customer wallet.**

### 6.3 Why `customers.balance` is not a wallet

`commercialHelpers.ts:511-519`:

```ts
const net4 = parseDecimal4(openInv.rows[0].total_due)
  - parseDecimal4(openCm.rows[0].total_credit)
  - parseDecimal4(unappliedPmt.rows[0].unapplied);
await tx.query(
  `UPDATE customers SET balance = $3::NUMERIC(19,4) WHERE company_id = $1 AND id = $2`,
  [companyId, customerId, formatDecimal4(net4)]
);
```

This is **accounts receivable**: open invoices minus credit memos minus unapplied payments. A positive balance means the customer owes the company. A negative balance would be a credit, but the field is not a wallet ledger and is recomputed from AR documents. It cannot be used as a prepaid wallet without a new subledger.

### 6.4 Conclusion

**The customer-wallet subledger does not exist.** The Phase A prompt's A2 requirement to "verify Customer wallet implementation" and "WalletTransaction" cannot be satisfied.

**Options for business decision (required before A2):**

1. **Map "wallet" to the bank subledger** (`bank_transactions`) plus the contract liability (`printing_contracts.remaining_balance`). This is the smallest change but conflicts with the prompt's "Do not replace customer wallet balances with bank balances."
2. **Build a new customer-wallet subledger**:
   - `customer_wallets` (company_id, customer_id, balance, currency_code);
   - `customer_wallet_transactions` (deposit, allocation, consumption, refund, transfer, adjustment);
   - double-entry postings to a liability account;
   - service + API + UI + tests.
   This is a significant new financial module and requires architecture approval.
3. **Use an existing AR credit mechanism** (credit memos/unapplied payments) as the wallet. This is not a wallet and would conflate AR with prepaid funds.

**Recommendation:** Option 2 if the business truly means a prepaid customer wallet; Option 1 only with explicit approval and a revised understanding of "wallet." **Do not proceed with A2 until this is decided.**

---

## 7. Financial Services Map

| Service | Location | Responsibility | Contract relevance |
|---|---|---|---|
| `postJournalEntry` | `accountingEngine.ts:1523-1816` | Balanced double-entry, period check, account validation, idempotency pre-check (1563-1588), `request_keys` insert (1788-1795), audit (1797) | Authoritative posting engine |
| `postOpeningBalances` | `accountingEngine.ts` | Opening balances | Not contract-specific |
| `recordExpense` | `bankingService.ts:368-440` | Journal + negative `bank_transactions` row + audit + route idempotency | Canonical bank-out pattern |
| `recordDeposit` | `bankingService.ts:443+` | Journal + positive bank row | Canonical bank-in pattern |
| `listBankTransactions` | `bankingService.ts:138-181` | Computes running balance on read (177-181) | Do not persist running balance |
| `createInvoiceOrSalesReceipt` | `salesService.ts:2170+` | Invoice/receipt + approval gate + idempotency | Invoice generation |
| `createBill`/payments | `purchasingService.ts` | Negative bank amount for withdrawals (1349-1374) | Sign convention |
| `generateInvoiceFromWorkflow` | `documentsService.ts:1444-1524` | Contract/milestone invoice + idempotency + milestone link (1515-1521) | Invoice link |
| `evaluateApprovalGate` | `approvalService.ts:253-404` | Threshold policy, pending request, idempotency, replay | Reusable for contract approvals |
| `approveRequest`/`rejectRequest` | `approvalService.ts:519-586` | Maker-checker; `assertCanDecide` (496-508) blocks self-approval | Reusable |
| `consumeApprovalRequest` | `approvalService.ts:407-446` | One-time consumption | Reusable |

**Key point:** the double-entry engine and approval framework are solid and should be reused. The missing piece is a **customer wallet subledger**, not a new journal engine.

---

## 8. Approval Infrastructure

### 8.1 Existing

| Object | Evidence | Capability |
|---|---|---|
| `approval_policies` | `0013:11-27` | Per-company/action threshold, enabled, require note |
| `approval_requests` | `0013:43-73`; `0014` | Pending/approved/rejected/cancelled; requested_by/decided_by; payload; idempotency; consumed_at |
| `APPROVAL_ACTION_TYPES` | `approvalService.ts:16-25` | `invoice`, `bill`, `customer_payment`, `bill_payment`, `journal_entry`, `credit_memo`, `estimate_conversion`, `po_receive` |
| DB CHECKs | `0013:14-17`, `46-49`; `0014:5-17` | Same 8 after 0014 |
| `assertCanDecide` | `approvalService.ts:496-508` | Requester cannot approve own request |
| `evaluateApprovalGate` | `approvalService.ts:253-404` | Threshold + idempotency + replay |
| `consumeApprovalRequest` | `approvalService.ts:407-446` | One-time consumption |

### 8.2 Gaps for the 36 decisions

- No `contract_cancel`, `contract_refund`, `contract_forfeit`, `contract_topup`, `contract_assessment_change`, `contract_activation`, `contract_amendment` action types.
- `approval_policies` defaults are disabled with threshold 0; T03 requires a `contract_refund` policy default K250,000.
- No contract-specific approval entity types.
- `approval_requests.amount` supports refunds/fees; good.
- `payload_json` can store contract/cancellation details; good.
- No second-person approval for operational contract actions yet (R04/R08/T01).
- No "approval threshold applied" snapshot on the contract/settlement; T03 requires storing it.

**Design:** extend both CHECKs (or add a new contract-approval table) and seed `contract_refund` with default 250000. Reuse `evaluateApprovalGate`/`consumeApprovalRequest`.

---

## 9. Audit Logging

- `writeAuditLog` (`audit.ts:17-40`): company, actor, action, table, record, old/new values, changed fields, SHA-256 hash, source.
- `audit_log` is append-only: trigger `trg_audit_log_append_only` rejects UPDATE/DELETE (`0006:456-466`).
- All contract mutations call `writeAuditLog` (create, amend, cancel, activate, renew, add/remove/update, complete, exam status/delete).
- Gaps: no audit for settlement/refund/forfeit separately, no signature/acceptance audit, no approval-specific contract audit (approvalService writes its own audit, which is good).

**Assessment:** strong foundation; extend actions for contract settlement/signature/amendment/renewal.

---

## 10. Document, Signature, and Storage

### 10.1 Existing

| Object | Evidence | Capability |
|---|---|---|
| `stored_files` | `0006:345-357` | `storage_kind`, `original_name`, `content_type`, `size_bytes`, `sha256_hex`, `storage_key`; RLS forced |
| `attachments` | `0006:365-375` | `entity_type`, `entity_id`, `stored_file_id`; index `(company_id, entity_type, entity_id)` |
| `documentsService` | `1155-1235`, `1444-1524` | Contract preview, invoice generation, milestone link |
| `email_log` | `0006:417-427` | Email delivery status; 0014 adds `skipped` |
| Scheduler | `scheduler.ts` | Email retries, audit |

### 10.2 Gaps for T04

- No `contract_acceptances` table.
- No drawn-signature capture (canvas/vector) or storage format.
- No OTP service or SMS provider. `grep` for `otp|verification_code|twilio|sendSms` found **no files**.
- No customer signer identity verification beyond `customers.email`/`customers.phone`.
- No document versioning for contracts.
- No acceptance evidence hash/immutable record.

**Assessment:** uploaded scanned signed contracts can use `stored_files` + `attachments`. Drawn e-signature and OTP require new components/services. T04 cannot be fully implemented without an OTP delivery decision (email OTP is feasible with nodemailer; SMS requires a provider).

---

## 11. Notifications

- `email_log` + `scheduler.ts` provide queued email, retry, failure logging, and audit.
- `email_templates` exist (`0006` around 400).
- No SMS/WhatsApp provider verified for OTP; `smartOpsService` has WhatsApp **click-to-chat links**, not automated sends.
- R05 insufficient-funds notifications can use email + scheduler, but need:
  - a trigger/event on funding insufficiency;
  - a template;
  - deduplication (one per contract/assessment/funding state);
  - customer contact verification;
  - retry/failure handling.

**Assessment:** partial; email is feasible, SMS/OTP is not.

---

## 12. RBAC and Permissions

### 12.1 Existing

| Permission | Line | Description |
|---|---|---|
| `printing:read` | `permissions.ts:60` | View machines, jobs, estimates, contracts, exams |
| `printing:write` | `permissions.ts:61` | Create/approve/issue/consume/finish/deliver jobs **and all contract mutations** |
| `invoices:write` | `permissions.ts:67` | Create invoices |
| `approvals:read` | `permissions.ts` | View approvals |
| `approvals:decide` | `permissions.ts` | Decide approvals (Accountant) |

Roles:
- Administrator: all permissions.
- Accountant: `approvals:decide`, `printing:read`, journals, banking reconcile; no `printing:write` (based on lines 218-219).
- Bookkeeper: `printing:write`, `banking:write`, `approvals:read`; no `approvals:decide`.
- ProductionManager: `printing:write`, estimates, inventory, sales, purchases.
- Read-Only: read.

### 12.2 Middleware

- `requireAuth` (auth.ts).
- `rejectCrossCompanyParams` (auth.ts:347-391): rejects `companyId`/`company_id`/`X-Company-Id` mismatches, logs `CROSS_COMPANY_ATTEMPT`.
- `requirePermission` (auth.ts:393-406): checks `hasPermission(auth.role, permission)`.

### 12.3 Gaps for D-07/T01

- No `ContractManager` role.
- No contract-specific permissions.
- `printing:write` conflates production operations and contract financial actions.
- Bookkeeper/ProductionManager can currently create/complete/cancel contracts.
- No operational vs financial approval permission split.
- No self-approval guard at the contract route level (approvalService has one, but contract routes don't use it yet).

**Design:** add `ContractManager` to `company_memberships.role` CHECK and `ROLE_DEFINITIONS`; add `printing:contracts:read`, `printing:contracts:manage` (operational), `printing:contracts:approve_financial`, `printing:contracts:approve_operational`; remove contract financial authority from Bookkeeper/ProductionManager.

---

## 13. Synchronisation Architecture

### 13.1 Backend

- `printingApi` calls `/api/printing/*`.
- `printingRoutes` uses `db.withCompanyDb`.
- `documentsApi`/`documentsService` for preview/invoice.
- No idempotency headers in `printingApi`.

### 13.2 Frontend

- `AccountingContext` initializes `INITIAL_PRINTING_CONTRACTS` (demo; no `backendId`).
- `backendId` is the only backend/local discriminator.
- `refreshPrintingContractsFromBackend` (699-707):
  - returns early on an empty list;
  - replaces all contracts when non-empty.
- `ACCOUNTING_UPDATED_EVENT` triggers a global refresh (719-731).
- Mutations are optimistic/fire-and-forget:
  - `addPrintingContract` falls back to local ledger on any error (2176-2253).
  - `completeContractAssessment` updates local state before API, doesn't await (2359-2468).
  - cancel/activate/renew/amend/add/remove are sync fire-and-forget.
- `emitAccountingUpdated()` is called by `printingApi` after each request, causing refreshes.

### 13.3 Risks

- False success on backend rejection.
- Local ledger mutation on server error.
- Lost invoice links after refresh.
- Race between optimistic update and global refresh.
- `isServerEdition` exists on `CompanyProfile` but is not used by `AccountingContext`.

**Assessment:** the sync architecture is not safe for financial operations. Phase A7/A9 must make contract mutations await backend confirmation, remove local financial fallback, and use targeted refreshes.

---

## 14. Tenant Isolation and RLS

### 14.1 Verified

- `withCompanyDb` (`db.ts:555-565`):
  - `SET LOCAL ROLE pms_app_role`
  - `SET LOCAL app.bypass_rls = 'off'`
  - `SET LOCAL app.current_company_id = $1`
- All relevant tables have `ENABLE` + `FORCE` RLS and `app_rls_allowed(company_id)` policies:
  - `printing_contracts`, milestones, exams (`0007:157-161`, `198-202`, `229-232`, `272-275`).
  - `bank_transactions` (`0004:384-392`).
  - `request_keys` (`0001:203-204`).
  - `approval_policies`/`approval_requests` (`0013:33-38`, `89-94`).
  - `stored_files`/`attachments` (`0006:359-363`, `379-380`).
  - `audit_log` (`0006`).
- Composite FKs use `(company_id, id)`.
- `rejectCrossCompanyParams` rejects cross-company parameter tampering.

### 14.2 Gaps

- New tables (customer wallet, contract acceptances, amendments, settlements) must add RLS + FORCE + policy.
- `printing_number_counters` must be RLS-protected.
- Direct SQL with `withSystemDb` can bypass RLS; service-level company scoping is still required.

**Assessment:** strong existing isolation; new objects must follow the same pattern.

---

## 15. Numbering

- Contracts: `MAX(contract_number)+1`, UTC year, `padStart(2)` (`printingRecordsService.ts:135-140`).
- Exams: `MAX(job_number)+1`, UTC year, `padStart(4)` (`323-327`, `342`).
- No counter table.
- Global sequence across years.
- `VARCHAR(64)` columns.

**Gaps:** numeric counter, natural overflow, company scoping, year from company timezone, backfill. See `07-numbering-and-locking-design.md`.

---

## 16. Colour

- `printingWorkflows.calculateContractMilestoneEstimate` (653-696) accepts `colorMode` but only uses `tonerChannels.K` (675). Colour-only CMY is under-costed.
- `productionService.ts` hardcodes `colorMode: 'mono'` at 419, 445, 465, 514.
- `PrintingContractsView.tsx:55`, `AccountingContext.tsx:68`, `ExaminationView.tsx:42`, `QuickPrintView.tsx:39` set `supportsColour:false`.
- No `color_mode` on contracts/milestones; no terms field.
- Toner engine supports CMYK (`tonerCalc.ts:4-5`, `615-635`).

**Gaps:** contract-level colour, terms evidence, channel-aware costing, press capability, tests.

---

## 17. Status Lifecycle

Current: `active | exhausted | cancelled` (`0007:134`; `types/accounting.ts:213`).

Required by Phase A:
- `draft` (D-10)
- `active`
- `suspended` (B-02)
- `completed` (D-05)
- `cancelled`
- `exhausted` (optional/legacy; decide whether to keep)

Current transitions:
- `create` → `active` + deposit (`printingRecordsService.ts:164-170`).
- `complete` → `exhausted` when all done or zero (`994-1019`).
- `cancel` → `cancelled` (`622-642`).
- `activate` → `active` from cancelled (`643-667`).

**Gaps:** no draft, suspended, completed; no signature/approval gates; no funding check; no second-person approval; no settlement separation.

---

## 18. Gap Matrix vs the 36 Decisions

| Decision | Status | Evidence / gap |
|---|---|---|
| D-01 | PARTIAL | ZMW default; hardcoded ZMW at `documentsService.ts:561`; no contract currency |
| D-02 | PARTIAL | Approval framework exists; no contract action types/settlement columns |
| D-03 | PARTIAL | `4900` exists; unsafe income fallback |
| D-04 | MISSING / BLOCKED | No top-up; **no customer wallet** |
| D-05 | PARTIAL | Completes to `exhausted`; clamps; no funding check |
| D-06 | MISSING | No colour/terms; K-only; mono hardcoded |
| D-07 | PARTIAL | Roles exist; no ContractManager/contract permissions |
| D-08 | MISSING | No `companies.timezone` |
| D-09 | PARTIAL | Activate allowed from cancelled; renew reuses |
| D-10 | MISSING / BLOCKED | No draft/signature; create active + deposit; **wallet undefined** |
| D-11 | PARTIAL | MAX + pad; no counter |
| D-12 | DESIGN ONLY | Preflight not executed |
| B-01 | PARTIAL | Multi-country possible; ZMW default |
| B-02 | MISSING | No `suspended` |
| B-03 | MISSING | No funding pre-check |
| B-04 | MISSING | No contract colour |
| B-05 | PARTIAL | Accountant exists |
| B-06 | MISSING | No ContractManager |
| B-07 | PARTIAL | Bank accounts exist; no refund destination selection |
| B-08 | MISSING | No settlement table |
| B-09 | DESIGN ONLY | Quarantine not implemented |
| B-10 | PARTIAL | Docs exist; no signatures |
| R01 | PARTIAL | Renew exists but reuses terms/balances |
| R02 | MISSING | No approval for assessment changes |
| R03 | MISSING | No acceptance records |
| R04 | MISSING | No suspend/resume |
| R05 | PARTIAL | Email/log/scheduler; no contract trigger |
| R06 | PARTIAL | Accountant approvals; no contract unused-funds action |
| R07 | MISSING | No signature |
| R08 | PARTIAL | Approval framework; no contract cancellation action |
| R09 | PARTIAL | Approval policies; no contract refund default |
| R10 | PARTIAL | No auto expiry; but `exhausted` semantics |
| T01 | PARTIAL | `assertCanDecide` exists; no contract action types |
| T02 | PARTIAL | Amend updates in place; no versioning |
| T03 | PARTIAL | Approval policies; no contract refund default/threshold snapshot |
| T04 | MISSING | No acceptance table; no OTP/SMS; no drawn signature |

---

## 19. Implementation Dependencies and Proposed Sequence

### 19.1 Blocking decision

**Customer wallet architecture** must be decided before A2:
- Option 1: wallet = bank subledger + contract liability (requires revised business understanding).
- Option 2: build a customer-wallet subledger (recommended if prepaid funds are real).
- Option 3: use AR credit (not recommended).

### 19.2 Proposed sequence after the wallet decision

1. **A2 — Financial architecture:** define wallet, allocation, consumption, top-up, refund, forfeiture, settlement, renewal; map to journal/bank/wallet entries; idempotency.
2. **A3 — Migration design:** status (`draft/active/suspended/completed/exhausted/cancelled`), currency, timezone, settlement, refund fields, approval action types, ContractManager role, colour/terms, signature/acceptance, amendment versioning, renewal predecessor, numbering counters, triggers.
3. **A4 — Lifecycle services:** draft → active (approval + signature + allocation + wallet funds), suspend/resume, complete, cancel, no auto-expiry.
4. **A5 — Amendments/renewals:** versioned terms, future-only effects, predecessor, no balance transfer.
5. **A6 — Signatures/acceptance:** drawn e-signature, OTP (email first), uploaded scan; `stored_files`/`attachments`; acceptance record.
6. **A7 — Approvals/settlement:** contract action types, maker-checker, refund threshold K250,000, Finance-selected destination, Other Income, settlement record.
7. **A8 — Notifications:** email insufficient-funds with dedupe/retry; SMS/OTP dependency.
8. **A9 — Frontend:** dashboard, list, details, create draft, activate, assessments, amendments, renew, suspend/resume, cancel, refund/forfeit approval, settlement history, documents/signatures, audit, financial summaries.
9. **A10 — Tests:** lifecycle, funding, wallet, top-ups, completion, insufficient funds, colour/mono, amendments, renewal, signatures, approvals, refunds, forfeiture, settlement, idempotency, concurrency, isolation, RLS, audit, legacy.

### 19.3 Migration 0020 scope (after wallet decision)

- Status CHECK expansion.
- `currency_code`, `timezone` (companies), `color_mode`, `colour_included`.
- `activated_at/by`, `completed_at/by`, `cancelled_at/by/reason`.
- Settlement/refund fields or a `contract_settlements` table.
- `renewal_of_contract_id`.
- `deposit_invoice_id/number`; milestone `linked_invoice_number`, `completed_by/at`.
- Approval action types (both CHECKs).
- `ContractManager` role CHECK.
- `printing_number_counters` + function + triggers.
- `contract_acceptances`, `contract_amendments` (if not already).
- RLS/FORCE on new tables.
- Backfills and preflight.
- Down/roll-forward.

**Restriction:** 0020 must be independently reviewed (`14-MIGRATION-0020-INDEPENDENT-REVIEW.md`) and not applied without business-owner approval.

---

## 20. Risks and Blockers

| ID | Risk | Severity | Owner / action |
|---|---|---|---|
| A1-B1 | **No customer wallet** | **Critical** | Business decision before A2 |
| A1-B2 | No OTP/SMS provider | High | Email OTP first; SMS provider decision for T04 |
| A1-B3 | No ContractManager role | High | Migration 0020 |
| A1-B4 | No timezone | High | Migration 0020 + helper |
| A1-B5 | No draft/suspended/completed | High | Migration 0020 + service/UI |
| A1-B6 | No contract approval action types | High | Migration 0020 + approvalService |
| A1-B7 | No signature/acceptance table | High | New table + A6 |
| A1-B8 | No amendment versioning | Medium | New table + A5 |
| A1-B9 | No settlement table | High | New table + A7 |
| A1-B10 | PGlite constraint triggers unverified | High | Disposable test in Phase D |
| A1-B11 | Pre-existing `test:printing` SKU collision | Low | Out of scope; separate ticket |
| A1-B12 | Dirty working tree (137 entries) | Medium | Preserve; isolate Phase A diff |
| A1-B13 | `printingApi` no idempotency | High | A7/A9 |
| A1-B14 | Frontend optimistic/fire-and-forget | High | A7/A9 |
| A1-B15 | `printing_contracts` no currency/colour/settlement | High | Migration 0020 |
| A1-B16 | `documentsService` hardcoded ZMW | Medium | A3/A9 |
| A1-B17 | `customers.balance` is AR, not wallet | Critical | A1-B1 |
| A1-B18 | No SMS/OTP; email only | High | A1-B2 |

---

## 21. A1 Verdict

**A1 COMPLETE WITH CRITICAL BLOCKER.**

**Completed:**
- Repository state verified and preserved.
- Documents reconciled.
- Contract module mapped end-to-end.
- Database schema inventoried.
- Financial services mapped.
- Approval framework verified.
- Audit logging verified.
- Document storage verified.
- Notifications assessed.
- RBAC verified.
- Synchronisation architecture verified.
- RLS/tenant isolation verified.
- Numbering and colour gaps verified.
- 36-decision gap matrix produced.
- Implementation dependencies and sequence proposed.

**Critical blocker:**
- **The customer-wallet subledger does not exist.** `customers.balance` is AR; `bank_transactions` is the bank subledger; the contract "wallet" is a bank view. Phase A2 cannot proceed until the business defines/approves the wallet architecture.

**Next action:**
- Present this report and the wallet options to the business owner.
- Obtain a written decision on the wallet model.
- Then proceed to A2 (financial architecture) and A3 (migration design), with 0020 independent review before application.

**No code, schema, or migration was changed in A1.**