# 10 — Stage 2 Verification Report

**Date:** 2026-11-19
**Branch:** `fix/printing-contracts-99`
**Base commit:** `933bcf32b9e570f97ef9d2f864274fd64c6d6e08`
**Mode:** Documentation only — no migration 0020 written or applied
**Verdict:** **STAGE 2 COMPLETE WITH CONDITIONS**

---

## A. Repository State Before and After

| Item | Before Stage 2 | After Stage 2 |
|---|---|---|
| Branch | `fix/printing-contracts-99` | `fix/printing-contracts-99` |
| Commit | `933bcf32b9e570f97ef9d2f864274fd64c6d6e08` | `933bcf32b9e570f97ef9d2f864274fd64c6d6e08` |
| Working-tree entries | 137 | 137 |
| Staged changes | None | None |
| Uncommitted user changes | Preserved | Preserved |
| Commits created | 0 | 0 |
| Source/schema/test changes by Stage 2 | 0 | 0 |
| Migrations written/applied | 0 | 0 |

**Safety checks performed:**
- Confirmed branch and commit before any work.
- Inspected staged, unstaged, and untracked files.
- Did not run `git reset`, `git clean`, `git stash`, destructive checkout, or commit.
- Did not edit `src/`, `db/`, `tests/`, or `package.json`.
- Only documentation under `docs/printing-contracts-remediation/` was created or updated.

---

## B. Documentation Files Created or Updated

| File | Action | Purpose |
|---|---|---|
| `docs/printing-contracts-remediation/02-business-decisions.md` | **Updated** | D-01…D-12 marked APPROVED with final decisions and technical implications |
| `docs/printing-contracts-remediation/06-migration-design-remediation.md` | **Created** | Full 18-finding disposition and corrected migration design |
| `docs/printing-contracts-remediation/07-numbering-and-locking-design.md` | **Created** | MIG-01, MIG-02, MIG-09: numbering, lock order, concurrency |
| `docs/printing-contracts-remediation/08-assessment-integrity-design.md` | **Created** | MIG-04: trigger-owned assessment counts |
| `docs/printing-contracts-remediation/09-legacy-data-preflight-design.md` | **Created** | MIG-15: read-only legacy preflight and reconciliation |
| `docs/printing-contracts-remediation/10-stage-2-verification-report.md` | **Created** | This report |

Existing Phase 0 documents were not overwritten:
- `00-repository-verification.md`
- `00-repository-state.txt`
- `01-baseline.txt`
- `03-phase-0-closeout.md`
- `04-migration-design-verification.md`
- `05-idempotency-design.md`

---

## C. MIG-01 through MIG-18 Disposition Table

| ID | Finding | Disposition | Corrected design |
|---|---|---|---|
| **MIG-01** | Number-format changes | **FIX REQUIRED** | Global numeric counter; `CTR-YYYY-NN` / `EXM-YYYY-NNNN`; minimum width; natural overflow; no truncation |
| **MIG-02** | Trigger locking/deadlocks | **FIX REQUIRED** | Strict counter → contract → milestone → journal order; renew generates number first; update locks parent first |
| **MIG-03** | Trigger misses `contract_id`/`company_id` updates | **FIX REQUIRED** | `AFTER INSERT OR UPDATE OR DELETE`; block cross-contract moves |
| **MIG-04** | Assessment counts | **FIX REQUIRED** | Trigger-owned counts; completed-milestone deletion block; validation trigger |
| **MIG-05** | Pending idempotency state | **FIX REQUIRED** | Same-transaction claim; no committed pending state; no takeover |
| **MIG-06** | `currency_code` | **FIX REQUIRED** | Backfill from `companies.base_currency`; MWK; no hardcoded ZMW |
| **MIG-07** | Settlement consistency CHECKs | **FIX REQUIRED** | Settlement mode/amount/journal consistency CHECK |
| **MIG-08** | Cancellation metadata | **FIX REQUIRED** | `cancelled_at`/`cancelled_by`/reason; backfill and CHECK |
| **MIG-09** | Exam-paper numbering backfill | **FIX REQUIRED** | `EXM-YYYY-NNNN` backfill with `GREATEST`; malformed report; natural overflow |
| **MIG-10** | `version` column unused | **FIX REQUIRED** | Remove from 0020; add later only when optimistic concurrency is implemented |
| **MIG-11** | Number function guards | **FIX REQUIRED** | Company guard, scope/prefix/width guards, stable error codes |
| **MIG-12** | `40001` handling | **FIX REQUIRED** | Map to 409; retry once; concurrency test |
| **MIG-13** | Remaining balance invariant | **FIX REQUIRED** | `remaining = prepaid − SUM(completed agreed)`; trigger/preflight |
| **MIG-14** | PGlite compatibility | **FIX REQUIRED — UNVERIFIED** | Disposable PGlite test required before implementation |
| **MIG-15** | Legacy allocations/credit balances | **FIX REQUIRED** | Read-only preflight; D-12 approval; controlled audited remediation |
| **MIG-16** | `CHAR(3)` vs `VARCHAR(3)` | **ACCEPTED RISK** | `CHAR(3)` matches `companies.base_currency`; document fixed-length/TRIM behaviour |
| **MIG-17** | Counter table CHECKs | **FIX REQUIRED** | `last_value >= 0`; `scope IN ('contract','exam_paper')` |
| **MIG-18** | Function parameter guards | **FIX REQUIRED** | `p_width` 1..10; non-empty prefix; allowed scope |

**No finding is omitted. No finding is marked ALREADY RESOLVED or NOT APPLICABLE** because the current code still contains the defects; the corrections are design-only until implemented.

---

## D. Technical Explanation of the Five Corrected High-Severity Findings

### D.1 MIG-01 — Numbering

**Original defect:** The draft proposed 4-digit contracts and 5-digit exams, and a failure at width overflow.

**Verified actual behaviour:**
- Contracts: `CTR-YYYY-NN`, 2-digit minimum (`printingRecordsService.ts:140`).
- Exams: `EXM-YYYY-NNNN`, 4-digit minimum (`printingRecordsService.ts:342`).
- Sequence is `MAX(...)+1` **globally per company**, not per year (`135-139`, `323-327`).

**Correction:**
- Preserve `CTR-YYYY-NN` and `EXM-YYYY-NNNN`.
- Use a numeric `printing_number_counters` table with `ON CONFLICT DO UPDATE ... RETURNING`.
- `LPAD` is a **minimum width**; natural overflow to 3/5 digits. No truncation, no exception.
- Global sequence preserves existing behaviour; no reset at year rollover.
- Year from company timezone (D-08).
- Backfill with `GREATEST`; rerunnable.

**Evidence:** `07-numbering-and-locking-design.md` §2–§3.

### D.2 MIG-02 — Lock ordering

**Original defect:** The allocation trigger locks the parent at commit, but the service can lock a child first, causing deadlocks.

**Verified paths:**
- `renewPrintingContract` locks the old contract (`printingRecordsService.ts:678`) then calls `createPrintingContract`, which would lock the counter → inversion.
- `updateContractAssessment` locks the milestone (`850-855`) without locking the parent → inversion with `completeContractAssessment`.

**Correction:**
- Mandatory order: **counter → parent contract → milestone → journal/bank → audit/request_keys**.
- `renew`: generate the new number **before** locking the old contract.
- `update`: lock the parent contract first.
- Trigger functions re-lock the parent with `FOR UPDATE`.
- Direct SQL that locks a child first is unsupported for financial workflows.

**Evidence:** `07-numbering-and-locking-design.md` §4.

### D.3 MIG-04 — Assessment counts

**Original defect:** Counts are maintained manually by the service; direct SQL can bypass them.

**Correction:**
- `BEFORE INSERT`: lock parent; enforce max 5; validate assessment number.
- `BEFORE DELETE`: lock parent; enforce min 2; block deleting completed milestones.
- `BEFORE UPDATE OF status`: completed is terminal.
- `AFTER INSERT/UPDATE OF status/DELETE` (deferred): recompute `total_assessments` and `completed_assessments`.
- `AFTER UPDATE` validation on the parent: reject wrong counts.
- Service stops manual count updates.

**Evidence:** `08-assessment-integrity-design.md`.

### D.4 MIG-09 — Exam backfill

**Original defect:** Only contract backfill was designed.

**Correction:**
- Backfill `exam_papers` by `MAX(CAST(split_part(job_number,'-',3) AS INTEGER))`.
- Rerunnable with `GREATEST`.
- Report malformed numbers with `^EXM-[0-9]{4}-[0-9]+$`.
- Natural overflow at 10000.
- Concurrent numbering via the counter.

**Evidence:** `07-numbering-and-locking-design.md` §3.

### D.5 MIG-15 — Legacy preflight

**Original defect:** No read-only preflight or reconciliation methodology.

**Correction:**
- 21 read-only queries covering allocations, balances, counts, cancelled/completed contracts, missing journals/bank rows, malformed/duplicate numbers, missing accounts, orphan invoice links, and currency.
- Exception taxonomy with 23 codes.
- Reconciliation methodology and reporting format.
- D-12 approval workflow; no automatic correction.
- Controlled, audited remediation with backup and roll-forward.

**Evidence:** `09-legacy-data-preflight-design.md`.

---

## E. Read-Only Legacy Preflight Methodology

**Principle:** Inspect first, classify, quantify, approve, then remediate.

1. **Read-only transaction:** `BEGIN TRANSACTION READ ONLY`, `statement_timeout`, `ROLLBACK`.
2. **Snapshot:** run all queries; export CSV with timestamp and query version.
3. **Classify:** map each row to an exception code.
4. **Quantify:** sum amounts by exception class and company.
5. **Review:** finance and business review each exception.
6. **Approve:** D-12 sign-off with a remediation plan.
7. **Backup:** verified backup before any change.
8. **Remediate:** controlled, audited changes, one class at a time.
9. **Verify:** re-run the same queries; target zero unexplained exceptions.
10. **Certify:** attach before/after reports to `FINAL-CERTIFICATION.md`.

**No automatic historical correction. No destructive rollback. No renumbering.**

**Execution status:** DESIGN COMPLETE; **NOT EXECUTED** because Stage 2 has no production DB connection and D-12 requires a read-only environment plus finance approval.

---

## F. Remaining Technical Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `draft`/`completed` status expansion not implemented | **High** | 0020 must alter the status CHECK and update TS/UI/query branches; add tests |
| `companies.timezone` column missing | **High** | Add column + `company_today()` helper; replace UTC date derivations |
| `ContractManager` role missing | **High** | Add role to `company_memberships.role` CHECK + permission; update UI/routes |
| Colour/terms fields missing | **Medium** | Add `color_mode`/terms; pass colour to costing; update press capability |
| PGlite constraint-trigger support unverified | **High** | Disposable PGlite test; fallback to service-level + simpler trigger |
| Legacy preflight not executed | **High** | Execute on read-only replica/standby with D-12 approval |
| "Wallet" terminology gap | **Medium** | No customer-wallet table exists; map to bank subledger + contract liability; confirm with business |
| "Suspended" status undefined | **Medium** | Map to `cancelled` or add a new status with approval |
| D-10 "sufficient wallet funds" undefined | **High** | Define the balance source (GL bank balance vs bank register) before activation |
| Pre-existing `test:printing` SKU collision | Low | Out of scope; separate test-hardening ticket |
| Pre-existing user changes in working tree | Medium | Do not commit unrelated changes; implementation must isolate its diff |
| `CHAR(3)` fixed-length comparison | Low | Use `TRIM`/fixed-length semantics; documented |
| `40001` retries may still conflict | Medium | Bounded retry + 409 response; test |

---

## G. Verification Commands and Exit Codes

| Command | Exit code | Result |
|---|---:|---|
| `git rev-parse --abbrev-ref HEAD` | 0 | `fix/printing-contracts-99` |
| `git log -1 --format="%H %s"` | 0 | `933bcf32... Implement full advanced options for Invoices and Printing Contracts` |
| `git status --short \| Measure-Object -Line` | 0 | `137` (unchanged from Stage 1) |
| `git diff --cached --name-status` | 0 | Empty (no staged changes) |
| `npm run lint` | 0 | PASS — `tsc --noEmit`, no diagnostics |
| `Get-ChildItem docs/printing-contracts-remediation` | 0 | 11 files present |

**Read-only checks performed:**
- Branch/commit unchanged.
- Working-tree count unchanged (137).
- No staged changes.
- Lint passes.
- Only documentation files created/updated.

**Not run in Stage 2:**
- Full test suites (baseline remains valid; no source changed).
- Migrations.
- Database writes.
- Legacy preflight queries (no production DB connection).
- Any build or deployment.

---

## H. Confirmations

- **No production source code changed.** No file under `src/` was edited.
- **No schema changed.** No `db/migrations/*.sql` file was created or edited.
- **No migration was written or applied.** Migration 0020 remains unwritten and unapplied.
- **No tests were modified.** No file under `tests/` was edited.
- **No user changes were discarded.** No reset, clean, stash, destructive checkout, or commit.
- **No commit was created.** Branch and commit are unchanged.
- **No database connection was used.** No production writes or reads were performed.
- **Only documentation changed.** All new/updated files are under `docs/printing-contracts-remediation/`.

---

## I. Final Verdict

### **STAGE 2 COMPLETE WITH CONDITIONS**

**Completed:**

- All 18 migration findings have documented dispositions.
- MIG-01 is technically corrected (global numeric counter, minimum width, natural overflow).
- MIG-02 has verified lock ordering (counter → contract → milestone; renew fixed).
- MIG-04 has a complete integrity strategy (trigger-owned counts + validation).
- MIG-09 has a safe, rerunnable exam backfill design.
- MIG-15 has a complete read-only preflight design.
- Tenant isolation/RLS is addressed for new tables and numbering.
- Financial/idempotency design is consistent with the approved decisions.
- All D-01…D-12 are approved; no business decision remains blocked.
- Documentation is internally consistent.
- Existing user modifications are preserved.
- No production implementation occurred.

**Conditions before Phase A:**

1. **Status lifecycle expansion:** 0020 must add `draft` and `completed` to the status CHECK and update all TS/UI/query branches.
2. **Timezone:** add `companies.timezone` and the company-local date helper; replace UTC date/year derivations.
3. **RBAC:** add `printing:contracts:manage` and a `ContractManager` role (or approved equivalent).
4. **Colour:** add `color_mode`/terms fields and update costing/press capability.
5. **PGlite:** run the disposable migration test and prove constraint triggers work.
6. **Legacy preflight:** execute on a read-only replica/standby, classify, and obtain D-12 sign-off.
7. **D-10 definition:** define "sufficient available wallet funds" (GL bank balance vs bank register) before activation.
8. **Terminology:** confirm "wallet" and "suspended" mappings.
9. **Explicit implementation authorisation:** record approval to start Phase A.

**Implementation status:** **BLOCKED** until the conditions above are met and explicit authorisation is recorded.

---

## J. Sign-Off

| Role | Decision | Signature | Date |
|---|---|---|---|
| Business owner | Stage 2 design accepted | ________________ | __________ |
| Finance | Legacy preflight approach accepted | ________________ | __________ |
| Technical reviewer | Migration/locking/integrity design accepted | ________________ | __________ |

**Stage 2 is complete as a design exercise, with conditions. It is not implementation approval.**