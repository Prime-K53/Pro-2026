# 11 — Final Business Decision Register (36 Decisions)

**Status:** **APPROVED — all 36 decisions**
**Approval date:** 2026-11-19
**Approval source:** Phase A Implementation Master Prompt (business owner authorisation). No wet signature was supplied; the approvals are recorded from that prompt.
**Supersedes:** `02-business-decisions.md` for D-01…D-12 where the Phase A prompt adds or refines requirements.
**Rule:** These decisions are binding for Phase A. Any deviation requires a new written decision.

---

## 1. Decision Summary

### Core decisions D-01…D-12

| ID | Decision | Status | Date |
|---|---|---|---|
| D-01 | Currency: Malawi MWK, symbol K, source `companies.base_currency`, multi-country preserved | APPROVED | 2026-11-19 |
| D-02 | Cancellation: authorised, reason, refund/forfeit, second-person approval, Finance-selected destination, threshold | APPROVED | 2026-11-19 |
| D-03 | Forfeiture: existing Other Income account, fail safely, no Printing Revenue substitution | APPROVED | 2026-11-19 |
| D-04 | Top-ups/unused funds: auto top-up active, suspended approval, no reopen completed, reject cancelled, no double count | APPROVED | 2026-11-19 |
| D-05 | Completion/funding: complete only when all assessments done; exhaustion blocks allocation, not lifecycle | APPROVED | 2026-11-19 |
| D-06 | Colour: mono + colour, one setting per contract, inherited by assessments, no override | APPROVED | 2026-11-19 |
| D-07 | Roles: Administrator, Accountant (Finance), Contract Manager; separate operational/financial approval | APPROVED | 2026-11-19 |
| D-08 | Timezone: company-configured, default Africa/Blantyre, UTC storage, local display/numbering | APPROVED | 2026-11-19 |
| D-09 | Renewal/reactivation: no reactivation; renewal is a new contract referencing predecessor | APPROVED | 2026-11-19 |
| D-10 | Initial allocation: draft, no deposit at draft, exact allocation, wallet funds, signature, atomic | APPROVED | 2026-11-19 |
| D-11 | Numbering: preserve formats, 2-digit contract minimum, 4-digit exam minimum, natural overflow | APPROVED | 2026-11-19 |
| D-12 | Legacy: read-only preflight, quarantine, preserve originals, separate approval | APPROVED | 2026-11-19 |
| D-13 | Customer wallet: dedicated company-wide subledger, two-liability model, no AR/bank/contract conflation | APPROVED | 2026-11-19 |

### Additional decisions B-01…B-10

| ID | Decision | Status | Date |
|---|---|---|---|
| B-01 | Preserve multi-country currency; Malawi uses MWK | APPROVED | 2026-11-19 |
| B-02 | Introduce dedicated `suspended` contract status | APPROVED | 2026-11-19 |
| B-03 | Insufficient funding keeps contract active but blocks assessment allocation | APPROVED | 2026-11-19 |
| B-04 | One colour setting for the entire contract | APPROVED | 2026-11-19 |
| B-05 | Accountant represents Finance | APPROVED | 2026-11-19 |
| B-06 | Dedicated Contract Manager role | APPROVED | 2026-11-19 |
| B-07 | Finance selects authorised bank/cash refund destination | APPROVED | 2026-11-19 |
| B-08 | Settlement recorded separately from lifecycle status | APPROVED | 2026-11-19 |
| B-09 | Quarantine inconsistent legacy records | APPROVED | 2026-11-19 |
| B-10 | Business owner approval plus documented Finance and Operations reviews | APPROVED | 2026-11-19 |

### Additional decisions R01…R10

| ID | Decision | Status | Date |
|---|---|---|---|
| R01 | Renewal duplicates previous terms into a new independent contract | APPROVED | 2026-11-19 |
| R02 | Assessment changes after activation require Accountant or Administrator approval | APPROVED | 2026-11-19 |
| R03 | Formal amendments require customer acceptance | APPROVED | 2026-11-19 |
| R04 | Administrator or Contract Manager may suspend/resume | APPROVED | 2026-11-19 |
| R05 | Automatically notify customers when funding is insufficient | APPROVED | 2026-11-19 |
| R06 | Accountant alone authorises use/transfer/refund of unused completed-contract funds | APPROVED | 2026-11-19 |
| R07 | Customer signature required before activation | APPROVED | 2026-11-19 |
| R08 | Every cancellation requires independent second-person approval | APPROVED | 2026-11-19 |
| R09 | Additional refund approval above configurable threshold | APPROVED | 2026-11-19 |
| R10 | No automatic contract expiry | APPROVED | 2026-11-19 |

### Final decisions T01…T04

| ID | Decision | Status | Date |
|---|---|---|---|
| T01 | Approval separation: financial vs operational; no self-approval; independently recorded | APPROVED | 2026-11-19 |
| T02 | Amendments affect future uncompleted work only; preserve posted history | APPROVED | 2026-11-19 |
| T03 | Refund threshold: company-configurable, default K250,000, > threshold needs extra approval, store applied threshold | APPROVED | 2026-11-19 |
| T04 | Customer acceptance: drawn e-signature, OTP, or uploaded scanned signed contract; record full evidence | APPROVED | 2026-11-19 |

**Total: 36 decisions — all APPROVED.**

---

## 2. Detailed Decisions and Technical Implications

### D-01 — Currency

**Approved rule:** Malawi internal currency `MWK`; display symbol `K`; source of truth `companies.base_currency`; preserve multi-country support; other companies configure their own currency; no module-specific hardcoding.

**Technical implications:**
- Update the Malawi company record to `base_currency='MWK'`, `currency_symbol='K'` (data change, separate approval).
- Add `printing_contracts.currency_code`; backfill from `companies.base_currency`.
- Replace hardcoded `'ZMW'` in `documentsService.ts:561` and other contract/document paths.
- Do not change other companies' currencies.

**Verified status:** Current schema default is `ZMW` (`0001:59`); seed company is `ZMW` (`db.ts:151`, `224-231`). No contract `currency_code`. `documentsService` hardcodes `ZMW` at line 561.

---

### D-02 — Cancellation

**Approved rule:**
- Authorised cancellation only.
- Mandatory cancellation reason.
- Authorised user chooses refund or forfeiture, subject to agreed contract terms.
- Every cancellation requires independent second-person approval.
- Refund destination is an authorised bank or cash account selected by Finance.
- Record refund method, destination, amount, requester, approver.
- Additional approval for refunds above the configured threshold.
- Settlement recorded separately from lifecycle status.

**Technical implications:**
- Add cancellation/settlement columns: `cancelled_at`, `cancelled_by`, `cancellation_reason`, `settlement_mode`, `settled_amount`, `settlement_journal_txn_id`, `refund_method`, `refund_destination_account_id`, `refund_requested_by`, `refund_approved_by`, `refund_threshold_applied`.
- Add approval action types `contract_cancel`, `contract_refund`, `contract_forfeit` to `approval_policies`/`approval_requests` CHECKs.
- Refund: Dr contract liability / Cr Finance-selected bank or cash account; one `bank_transactions` row (negative amount, `journal_txn_id`).
- Forfeit: Dr contract liability / Cr `4900 Other Miscellaneous Income`; no bank row.
- Settlement is a separate record/table from the contract status; the contract status records lifecycle, the settlement records the financial event.
- Idempotency key for cancel/refund/forfeit.
- No reactivation after settlement (D-09).

**Verified status:** Current cancel sets status + notes only (`printingRecordsService.ts:622-642`); no settlement. `approval_requests` supports maker-checker (`approvalService.ts:496-508`) and thresholds (`approval_policies`), but action types exclude contract actions (`0013:14-17`, extended in `0014` but still no contract types). `bank_transactions` supports refunds with negative amount. `customers.balance` is AR, not a wallet.

---

### D-03 — Forfeiture

**Approved rule:** Use existing Other Income account; never auto-create; never substitute Printing Revenue; fail safely if missing/inactive; roll back on failure.

**Technical implications:**
- Resolve `4900 Other Miscellaneous Income` (`account_subtype='other_income'`, `account_type='Income'`) by code/subtype, active.
- If missing/inactive → `NO_FORFEITURE_INCOME_ACCOUNT`, rollback.
- Do not fall back to `4000/4010` Printing Revenue.
- Add a test for missing/inactive account.

**Verified status:** Seed `4900` exists with `account_type='Income'`, `account_subtype='other_income'` (`db.ts:63`). `resolveIncomeAccount` currently falls back to any `Income` (`printingRecordsService.ts:908-931`).

---

### D-04 — Top-ups and unused funds

**Approved rule:**
- Confirmed payments automatically top up active contracts.
- Record wallet Deposit transactions.
- Suspended contracts require authorised approval before top-up.
- Completed contracts do not automatically reopen.
- Cancelled contracts reject automatic top-ups.
- Prevent double-counting.
- Remaining funds stay attached to completed contracts.
- Subsequent use/transfer/refund requires Accountant authorisation and audit.

**Technical implications:**
- New top-up service/route with idempotency.
- Status guards: `active` auto; `suspended` requires approval; `completed` reject reopen; `cancelled` reject.
- Wallet Deposit: **the customer wallet subledger does not exist yet** — see §3. If "wallet" means the bank subledger, use `bank_transactions` Deposit; if it means a customer wallet, build it.
- No double counting: idempotency + unique bank row + no manual balance.
- Unused completed-contract funds: Accountant-only action (R06), audited.

**Verified status:** No top-up service. No customer wallet table. `printing_contracts.remaining_balance` is the contract liability. `bank_transactions` is the bank subledger. **BLOCKER: wallet architecture undefined.**

---

### D-05 — Completion and funding

**Approved rule:**
- Complete a contract only when all required assessments are completed.
- Funding exhaustion does not automatically complete or suspend.
- Keep contract active but block further assessment allocation when funds are insufficient.
- A qualifying top-up restores funding eligibility.
- Remaining funds stay attached to completed contracts.

**Technical implications:**
- `status='completed'` when all assessments completed; `remaining_balance` stays.
- `status='suspended'` is a lifecycle action (R04), not an automatic funding result.
- Funding check before allocating/completing an assessment: `remaining_balance >= agreed_amount`; if insufficient, block with `INSUFFICIENT_CONTRACT_FUNDS`, keep active.
- Top-up restores eligibility.
- No automatic expiry (R10).

**Verified status:** Current `completeContractAssessment` sets `exhausted` when all done or remaining <= 0 (`printingRecordsService.ts:994-1019`), and clamps deduction (`960-963`). No `suspended`/`completed` status. No funding pre-check.

---

### D-06 — Colour printing

**Approved rule:** Support mono and colour; colour explicitly in contract terms; one colour setting for the entire contract; every assessment inherits; pricing/BOM/consumption reflect it; no assessment-level override.

**Technical implications:**
- Add `printing_contracts.color_mode` (`mono`/`colour`) and a terms/evidence field.
- Remove/avoid assessment-level colour override.
- Pass `colorMode` to `calculateContractMilestoneEstimate`; support CMY channels.
- Update press capability `supportsColour: true` where colour is offered.
- Separate pricing/BOM/consumption tests.
- Do not change mono behaviour.

**Verified status:** No colour/terms fields on contracts/milestones. `printingWorkflows.ts:675` only uses `tonerChannels.K`; `productionService.ts:419/445/465/514` hardcodes `mono`; `PrintingContractsView.tsx:55`, `AccountingContext.tsx:68`, `ExaminationView.tsx:42`, `QuickPrintView.tsx:39` set `supportsColour:false`.

---

### D-07 — Roles and permissions

**Approved rule:**
- Administrator: system oversight and authorised approvals.
- Accountant: Finance and financial authority.
- Contract Manager: dedicated operational contract-management role.
- Bookkeeper and Production Manager do not automatically receive contract financial authority.
- Separate operational and financial approval permissions.
- Enforce on backend endpoints.

**Technical implications:**
- Add `printing:contracts:read`, `printing:contracts:manage` (operational), `printing:contracts:approve_financial` (financial), `printing:contracts:approve_operational`.
- Add `ContractManager` to `company_memberships.role` CHECK (`0001:106`) and `ROLE_DEFINITIONS`.
- Remove `printing:contracts:manage`/financial authority from Bookkeeper/ProductionManager.
- Accountant gets financial approval; Administrator gets both; Contract Manager gets operational.
- Update routes/UI/tests.

**Verified status:** Current roles: Administrator, Accountant, Bookkeeper, ProductionManager, Read-Only. `printing:read`/`printing:write` at `permissions.ts:60-61`. Bookkeeper and ProductionManager have `printing:write` (`167-183`). Accountant has `approvals:decide` but only `printing:read` (`218`). No ContractManager. No contract-specific permissions.

---

### D-08 — Timezone

**Approved rule:** Company-configured timezone; default `Africa/Blantyre`; UTC timestamps; local display; local time for numbering/date calculations.

**Technical implications:**
- Add `companies.timezone TEXT NOT NULL DEFAULT 'Africa/Blantyre'`.
- Add `company_today(companyId)` / `company_now(companyId)` helpers.
- Store `TIMESTAMPTZ` in UTC; display local.
- Replace UTC year/date derivations in contract/exam numbering and completion.
- Add boundary tests.

**Verified status:** No `companies.timezone`. `todayIsoDate()` UTC (`commercialHelpers.ts:54-56`); contract/exam UTC year/date (`printingRecordsService.ts:140`, `328`, `347`, `965`).

---

### D-09 — Renewal and reactivation

**Approved rule:** Cancelled/settled cannot reactivate; renewal creates a new independent contract; previous terms may be copied; new contract references predecessor; no automatic balance transfer; settlement recorded separately.

**Technical implications:**
- Reject `activate` on cancelled/settled.
- New `renewal_of_contract_id` column on `printing_contracts` (composite FK to `printing_contracts(company_id,id)`).
- Renewal copies terms (title, dates, colour, assessment schedule) but creates new assessments and new deposit.
- No wallet balance transfer.
- Settlement record separate.

**Verified status:** Current `activate` allows cancelled→active (`printingRecordsService.ts:643-667`). `renewPrintingContract` reuses old dates/amount (`673-705`). No predecessor reference.

---

### D-10 — Initial allocation and activation

**Approved rule:**
- New contracts begin as drafts.
- No deposit journal from draft creation.
- Exact approved allocation before activation.
- Sufficient customer wallet funds required.
- Customer signature mandatory before activation.
- Allocation and activation atomic.
- Prevent duplicate allocation/double counting.

**Technical implications:**
- Add `draft` status; split `createPrintingContract` (draft, no journal) and `activatePrintingContract` (validate, post, activate).
- Add `activated_at`, `activated_by`, `customer_signature_id`, `customer_acceptance_id`.
- Wallet funding check — **wallet architecture undefined** (see §3).
- Idempotency for create/activate.
- Atomic transaction.

**Verified status:** Current create posts the deposit and inserts `active` (`printingRecordsService.ts:142-170`). No draft/signature/acceptance. **BLOCKER: wallet architecture undefined.**

---

### D-11 — Numbering

**Approved rule:** Preserve formats; contract 2-digit minimum; exam `EXM-YYYY-NNNN` 4-digit minimum; natural overflow; verify historical scope/concurrency.

**Technical implications:**
- `printing_number_counters(company_id, scope, last_value)` with RLS.
- `next_printing_number` with `ON CONFLICT DO UPDATE ... RETURNING`.
- `LPAD` minimum width; natural overflow; no truncation.
- Global sequence to preserve existing behaviour.
- Backfill with `GREATEST`.

**Verified status:** Current `MAX` + `padStart` (`printingRecordsService.ts:135-140`, `323-327`, `342`); no counter table.

---

### D-12 — Legacy data

**Approved rule:** Read-only preflight; reconcile; quarantine; preserve originals; proceed only with safe records; no automatic corrections; separate approval.

**Technical implications:** See `09-legacy-data-preflight-design.md`; execute read-only; D-12 approval; controlled remediation.

**Verified status:** No legacy preflight executed; no DB connection.

---

### D-13 — Customer Wallet Architecture

**Approved rule:**
- Build a dedicated **company-wide customer-wallet subledger** (Option B, Scope A).
- The wallet supports customer deposits, invoice payments, sales-order payments (when available), printing-contract allocations, other authorised ERP transactions, refunds, reversals, adjustments, statements, and reconciliation.
- The wallet is a **liability** representing customer prepaid funds.
- It is **not** the same as `customers.balance` (AR), `bank_transactions` (bank subledger), or `printing_contracts.remaining_balance` (contract liability).
- Do not replace customer wallet balances with bank balances.
- Do not treat contract remaining balance as unallocated wallet funds.
- One authoritative wallet service and ledger; modules must not maintain separate wallet balances.

**Approved accounting model (two-liability):**
- `2310 Customer Wallet Funds` — unallocated prepaid funds (proposed account).
- `2300 Unearned Contract Retainers` — allocated contract funds (existing).
- Deposit: Dr Bank / Cr 2310.
- Contract allocation: Dr 2310 / Cr 2300.
- Contract consumption: Dr 2300 / Cr 4000.
- Wallet invoice payment: Dr 2310 / Cr 1100; no bank row.
- Refund: Dr 2310 / Cr Bank; bank Debit row.
- Forfeiture: Dr 2300 / Cr 4900.
- Reversals are new compensating entries; no edits/deletes.

**Technical implications:**
- New tables: `customer_wallets`, `customer_wallet_transactions`, `customer_wallet_allocations`.
- `payments.payment_method` CHECK extended with `Wallet`.
- `recordCustomerPayment` wallet-funded branch.
- Contract activation allocates from wallet; draft posts no deposit.
- `2310` account must be explicitly configured; no auto-creation.
- Wallet operations are online-only; no offline wallet.
- Wallet permissions separate from contract/production permissions.
- No historical AR/unapplied-payment conversion without approval.

**Verified status:** No wallet tables/services exist; `customers.balance` is AR (`commercialHelpers.ts:478-521`); contract deposits post to contract liability (`printingRecordsService.ts:142-161`); no sales-order/portal/offline modules.

---

## Wallet Design Decisions W-01…W-08 — APPROVED / TECHNICAL DESIGN ACCEPTED (A2.2)

These decisions were **proposed** in Phase A2/A2.1 and **approved by the business owner on 2026-11-19 (Phase A2.2)**. W-05 and W-06 are technical design decisions accepted on the same date; they are not represented as implemented or configured.

| ID | Approved decision | Status | Final decision | Date approved |
|---|---|---|---|---|
| W-01 | Two-liability accounting model: `2310 Customer Wallet Funds` and `2300 Unearned Contract Retainers` | **BUSINESS APPROVED** | Approved | 2026-11-19 |
| W-02 | Reuse existing `payments`/`payment_allocations` for wallet-funded invoice settlement, with required compatibility safeguards | **BUSINESS APPROVED** | Approved | 2026-11-19 |
| W-03 | Contract consumption recorded through contract allocation records and accounting journals, without a second wallet debit | **BUSINESS APPROVED** | Approved | 2026-11-19 |
| W-04 | Base-currency wallets only in Phase 1 | **BUSINESS APPROVED** | Approved | 2026-11-19 |
| W-05 | Company-configured and validated `2310` account; no automatic account creation | **TECHNICAL DESIGN ACCEPTED** | Accepted (not implemented/configured) | 2026-11-19 |
| W-06 | Refund threshold through `approval_policies`, with applied threshold snapshot | **TECHNICAL DESIGN ACCEPTED** | Accepted (not implemented/configured) | 2026-11-19 |
| W-07 | Wallet numbering `WLT-YYYY-NNNN`, four-digit minimum, transactionally allocated per company/year | **BUSINESS APPROVED** | Approved | 2026-11-19 |
| W-08 | Frozen blocks debits; credits require approval. Closed blocks all new transactions and requires settlement before closure | **BUSINESS APPROVED** | Approved | 2026-11-19 |

**Approval note:** the earlier A2/A2.1 register recorded these as PROPOSED/PENDING. They were subsequently approved on 2026-11-19. The historical proposal text remains in the A2/A2.1 reports; this register reflects the current decision status.

### AF-A1…AF-A6 — Accounting Policy Status (A2.2)

| ID | Decision | Status | Final decision | Date |
|---|---|---|---|---|
| AF-A1 | Revenue recognition event | **BUSINESS POLICY SELECTED — FINANCE VALIDATION REQUIRED** | Option B: assessment completion; contract invoice must not post revenue again | 2026-11-19 |
| AF-A2 | Tax and COGS treatment | **PENDING — FINANCE/TAX REVIEW REQUIRED** | — | — |
| AF-A3 | Contract cancellation refund flow | **BUSINESS APPROVED — FINANCE IMPLEMENTATION VALIDATION REQUIRED** | Option B: release to wallet, then refund | 2026-11-19 |
| AF-A4 | Account `2310` | **TECHNICAL VERIFICATION PENDING** | Company-configured and validated; no auto-create | — |
| AF-A5 | Refund threshold | **BUSINESS POLICY APPROVED — TECHNICAL VERIFICATION PENDING** | K250,000 default; > threshold requires additional approval; exactly K250,000 does not exceed | Approved under T03 |
| AF-A6 | Forfeiture account | **BUSINESS POLICY APPROVED — ACCOUNT VERIFICATION PENDING** | Existing Other Income account (`4900` / `other_income`); fail safely; no Printing Revenue substitution | Approved under D-03 |

**Phase A3 status:** **NOT AUTHORISED.** Implementation remains blocked pending AF-A2, AF-A1 finance validation, AF-A4/AF-A5/AF-A6 verification, independent schema/migration review, and explicit implementation authorisation.

### B-01 — Multi-country currency

**Approved:** Preserve multi-country; Malawi MWK. **Implication:** company-level currency, no global hardcoding.

### B-02 — Suspended status

**Approved:** Add `suspended`. **Implication:** status CHECK `draft/active/suspended/completed/exhausted/cancelled`; TS/UI/query branches; suspend/resume by Administrator/Contract Manager (R04).

### B-03 — Insufficient funding

**Approved:** Keep active, block allocation. **Implication:** funding pre-check; `INSUFFICIENT_CONTRACT_FUNDS`; no auto lifecycle transition.

### B-04 — One colour setting

**Approved:** Contract-level colour only. **Implication:** `printing_contracts.color_mode`; no milestone override.

### B-05 — Accountant = Finance

**Approved:** Accountant represents Finance. **Implication:** financial approvals require Accountant/Administrator.

### B-06 — Contract Manager role

**Approved:** Dedicated role. **Implication:** new role + permission set; operational approvals.

### B-07 — Finance selects refund destination

**Approved:** Finance selects authorised bank/cash account. **Implication:** refund destination field + validation + audit.

### B-08 — Settlement separate from status

**Approved:** Settlement record separate. **Implication:** `contract_settlements` table or equivalent; status remains lifecycle.

### B-09 — Quarantine legacy

**Approved:** Quarantine inconsistent records. **Implication:** legacy preflight + quarantine table/report.

### B-10 — Approval governance

**Approved:** Business owner + Finance/Operations reviews. **Implication:** documented approvals before migration/application.

---

### R01 — Renewal duplicates terms

**Approved:** New independent contract with copied terms. **Implication:** renewal service + predecessor reference.

### R02 — Assessment changes after activation

**Approved:** Accountant/Administrator approval. **Implication:** approval action type `contract_assessment_change`; maker-checker.

### R03 — Formal amendments require customer acceptance

**Approved:** Customer acceptance before amendment effective. **Implication:** amendment + acceptance records (T04).

### R04 — Suspend/resume

**Approved:** Administrator or Contract Manager. **Implication:** permission + status transitions + audit.

### R05 — Insufficient-funds notifications

**Approved:** Automatic customer notifications. **Implication:** email_log + scheduler; template; retry; no duplicate storms. **SMS/OTP provider absent.**

### R06 — Accountant-only unused funds

**Approved:** Accountant alone authorises use/transfer/refund of completed-contract unused funds. **Implication:** financial permission + approval + audit.

### R07 — Customer signature before activation

**Approved:** Mandatory. **Implication:** acceptance record + activation guard.

### R08 — Independent cancellation approval

**Approved:** Every cancellation requires second-person approval. **Implication:** approval request + maker-checker; no self-approval.

### R09 — Refund threshold

**Approved:** Configurable; additional approval above threshold. **Implication:** `approval_policies` action `contract_refund` default K250,000; store applied threshold.

### R10 — No automatic expiry

**Approved:** Contracts do not auto-expire. **Implication:** no scheduler-driven expiry; manual lifecycle only.

---

### T01 — Approval separation

**Approved:** Financial actions approved by Administrator/Accountant; operational by Administrator/Contract Manager; requester cannot approve; independently recorded. **Implication:** permission split + `approvalService.assertCanDecide` (already prevents self-approval) + new action types.

### T02 — Amendment financial effects

**Approved:** Future uncompleted work only; preserve posted history; never rewrite completed assessments/invoices/receipts/wallet transactions/journals. **Implication:** amendment versioning + audit; no mutation of posted rows.

### T03 — Refund threshold

**Approved:** Company-configurable; default K250,000; `>` threshold needs additional approval; equal does not exceed; permission-controlled changes audited; store applied threshold. **Implication:** `approval_policies` row for `contract_refund` with default 250000; store `refund_threshold_applied` on the settlement.

### T04 — Customer acceptance

**Approved:** Three methods: drawn e-signature, OTP to registered phone/email, uploaded scanned signed contract. Record customer, signer, method, document version, evidence, timestamp, outcome. Mandatory before activation and amendments. **Implication:**
- `contract_acceptances` table with method/evidence/version/outcome.
- Signature capture (drawn) — new UI/canvas + stored file.
- OTP — **no OTP/SMS provider exists**; email OTP possible via nodemailer; SMS requires a provider. Mark as dependency.
- Uploaded scanned doc — `stored_files` + `attachments` exist.
- Activation/amendment guard checks acceptance.

---

## 3. Critical Architecture Finding: Customer Wallet

The Phase A prompt assumes an existing customer wallet (`Customer wallet balance`, `WalletTransaction`). **Repository verification found no such table or entity.**

What exists:

| Concept | Where | Meaning |
|---|---|---|
| `customers.balance` | `0003:20`; `commercialHelpers.ts:511-519` | **Accounts receivable** balance: open invoices − credit memos − unapplied payments. It is what the customer owes, not prepaid funds. |
| `bank_transactions` | `0004:348-395` | Bank subledger; deposits/debits; not a customer wallet. |
| `accounts.balance` | `0002`; `accountingEngine.ts:652` | General-ledger account balances; not a customer wallet. |
| `printing_contracts.remaining_balance` | `0007:127` | Unearned contract liability; not a customer wallet. |
| Contract "wallet" UI | `printingApi.ts:294`; `printingRoutes.ts:593`; `printingRecordsService.ts:1042` | Reads `bank_transactions` by contract reference. Not a wallet. |

**Conclusion:** The customer-wallet subledger does not exist. Phase A2 cannot "verify" it. The business must either:
1. Confirm that "wallet" means the bank subledger/contract liability and approve that mapping; or
2. Approve building a new customer-wallet subledger (table + journal + service + UI).

**This is a blocking dependency for D-04, D-05, D-10, R05, R06, and A2.** Do not invent a wallet design without approval.

---

## 4. Approval Record

| Role | Decisions | Approval | Date |
|---|---|---|---|
| Business owner | D-01…D-12, B-01…B-10, R01…R10, T01…T04 | APPROVED via Phase A master prompt | 2026-11-19 |
| Finance | D-01…D-05, D-07, D-09, D-10, R02, R06, R09, T01…T03 | APPROVED via Phase A master prompt | 2026-11-19 |
| Operations | D-02, D-04, D-06, R04, R05, R07, R08, T04 | APPROVED via Phase A master prompt | 2026-11-19 |

**No wet signature was supplied.** Formal sign-off is required before migration application (B-10).

---

## 5. Reconciliation with Stage 2

| Topic | Stage 2 | Phase A final | Change |
|---|---|---|---|
| D-02 cancellation | Refund/forfeit, reason, record | + second-person approval, Finance-selected destination, threshold | Refined |
| D-05 completion | Complete when assessments done; balance stays | + funding exhaustion blocks allocation, not lifecycle | Refined |
| D-06 colour | Support colour | + one setting per contract, no assessment override | Refined |
| D-07 roles | Administrator/Finance/Contract Manager | + Accountant = Finance, separate operational/financial, Bookkeeper/PM excluded | Refined |
| D-10 activation | Draft, exact allocation, wallet funds | + customer signature mandatory | Refined |
| B-02 suspended | Not in schema | New status | Added |
| T01–T04 | Not in Stage 2 | Approval separation, amendment effects, refund threshold, customer acceptance | Added |

No decision is silently changed; each refinement is recorded above.