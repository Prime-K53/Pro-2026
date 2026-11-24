# End-to-End ERP Assessment — Printing System (SlowBooks Pro 2026 / Prime Press)

**Assessment date:** 2026-11-24
**Scope:** Full stack — React 19 + Vite frontend, Express + PGlite (Postgres 17) backend, 58 migrations, 44 test suites.
**Benchmark:** What a *real, production-grade ERP* for a printing/exam-printing company must do (finance, supply chain, production, compliance, security, reporting).

---

## 1. Overall Score

| Dimension | Weight | Score | Notes |
|---|---|---|---|
| **Accounting & financial engine** | 20% | **19/20** | Genuine double-entry, scaled-integer money, fiscal periods, closing/reopening, reversing entries, FX. Industry-grade. |
| **Multi-tenancy & security** | 15% | **14/15** | RLS with non-superuser role, session+membership versioning, IDOR guard, CSRF, rate limiting, 2FA. |
| **Core business operations** (printing, exams, contracts, inventory, POS, wallet) | 20% | **18/20** | Deep, real lifecycle state machines with double-entry posting. |
| **Supply chain** (sales, purchasing, AR/AP) | 15% | **13/15** | Full quote-to-cash and procure-to-pay; minor idempotency & tax-depth gaps. |
| **Payroll / compliance** | 10% | **7/10** | Real statutory engine, but demo roster wiring + no idempotency + weak tax-form fidelity. |
| **Frontend completeness & wiring** | 10% | **6/10** | ~80% wired; Payroll/Tax tabs use demo data; no URL routing; contradictory state stores. |
| **Missing ERP modules** (fixed assets, scheduling, deep inventory) | 10% | **5/10** | Fixed-asset register absent; press scheduling board absent; several inventory ops headless. |

### **Overall: 82 / 100**

**Verdict:** This is a **genuine, serious ERP** — not a demo. It has real double-entry accounting with integer money, PostgreSQL RLS tenancy that cannot be bypassed, real production/exam/contract lifecycles, and an unusually clean codebase (zero TODO/FIXME markers). It is at the level of a strong commercial mid-market ERP. The 18-point gap is concentrated in a handful of well-defined, addressable areas — primarily **frontend wiring holes, financial idempotency consistency, tax/compliance depth, and missing fixed-asset/scheduling modules** — not in foundational quality.

---

## 2. What is genuinely strong (why this is not a demo)

1. **Real double-entry accounting engine** (`accountingEngine.ts`, 2,089 lines)
   - Money as scaled `bigint` at 4 dp — no floating point in ledger math.
   - Balanced-entry enforcement, accrual vs cash basis lines, period-close locks (service + DEFERRABLE DB trigger), closing entries rolling P&L to retained earnings, reversing entries, idempotent journal posting with payload hashing.
   - Account hierarchy with cycle detection, depth limits, control-account protection (reserved codes cannot be hijacked/renumbered), contra accounts, sub-accounts.
   - `rebuildStoredBalances` — a real control to detect/correct ledger drift.

2. **True multi-tenant isolation** (`0001` migration, `db.ts`)
   - RLS `FORCE`d on every company table; app connects as `pms_app_role` (NOBYPASSRLS), so RLS cannot be escaped even by a bug.
   - `withCompanyDb` sets `app.current_company_id` per transaction; `withSystemDb` explicitly opts out.
   - Auth middleware tracks **session version** and **membership version** — role changes/revocations instantly invalidate live sessions.

3. **Security depth**: signed session cookies, Supabase JWT path, CSRF tokens bound to session, IDOR/cross-company parameter rejection with audit logging, rate limiting in prod, login-attempt tracking, 2FA, audit log on every mutation.

4. **Domain-correct printing logic**: `paperCalc.ts` (1,309 lines) and `tonerCalc.ts` (954 lines) do real imposition/signature/spine-caliper math and evidence-graded toner costing (meter vs mass vs coverage), refusing to invent conversion factors.

5. **Full production & exam lifecycles** with server-enforced transition matrices (`EXAM_STATUS_ALLOWED`) and double-entry WIP → COGS relief, material issue/return, spoilage variance, budget-approval gates.

6. **Financial reports**: General Ledger, Trial Balance, P&L, Balance Sheet, indirect Cash Flow with beginning+change=ending reconciliation — SlowBooks parity.

7. **44 test suites** covering accounting, security, RLS isolation, commercial, printing, payroll, POS, referral, wallet, AI, BI.

---

## 3. Material gaps & weaknesses (what holds it back from ~95)

### 3.1 Frontend wiring holes (highest-visible-impact)
- **PayrollView** shows a **fictional employee roster** from demo context (`AccountingContext.tsx:845`); `payrollApi.listRuns()` exists but is **never called**; there is **no `listEmployees` client method**. Only the "Run" button hits the server. → *A live payroll run against a fake roster.*
- **TaxFormsView** 941/940/W-2/1099 tabs are computed from demo data and stamp a **"Simulated tamper-evident hash"** under a **"SHA-256 Verified"** badge (`TaxFormsView.tsx:146-159`) — compliance-misleading.
- **QuickPrintView** job history is browser-only (`quickPrintJobs` never hydrated; `printingApi` has POST but no GET). History lost on reload.
- **Sidebar badges** (open invoices/bills/low stock) read demo context while the screens show live server data → contradictory numbers.
- **Two parallel state stores**: `AccountingContext.tsx` (3,848 lines) holds a browser working copy for half the entities while views fetch live for the other half.
- **No URL routing** (no react-router) — no deep links, no Back/Forward, no shareable URLs, no per-route guards.
- **Server code imported into the client bundle** — `ExaminationView.tsx`, `PrintingContractsView.tsx`, `AccountingContext.tsx` import `buildPaperStockFromInventoryItem` / costing functions from `../../server/services/printingWorkflows`.

### 3.2 Financial idempotency & control consistency
- **Journal-posting paths without route idempotency keys:**
  - `cancelPrintingJob` (`productionService.ts:2476`) posts a WIP write-off, guarded only by a status check.
  - `runPayroll` (`payrollService.ts:141`) posts a payroll journal with **no idempotency key** (only a per-period DB guard).
  - `createVendorCredit` (`purchasingService.ts:1991`) posts a journal, no key.
  - Several voids/applies (`voidInvoice`, `voidCustomerPayment`, `applyCreditMemoToInvoice`, `applyUnappliedPaymentToInvoice`, `voidBill`, `voidBillPayment`) rely on status guards only.
- **Inventory shrinkage write-offs** post directly with no approval gate (`inventoryService.ts`).
- **Period-close checklist enforcement is OFF by default** (`periodCloseService.ts:390`) — advisory unless an admin opts in.

### 3.3 Tax & statutory depth
- **Single flat sales-tax rate** per company (`salesService.ts:1232,1297`) — no multi-rate / per-line tax codes / tax jurisdictions.
- **Use-tax dumped onto the first expense account** (`purchasingService.ts:1322-1330`) instead of a clearing account.
- **No 1099/W-9/withholding workflow** despite `is_1099_eligible` fields existing.
- **US-named payroll columns repurposed for Malawi** with several hard-coded `'0'` (`payrollService.ts:439-456`) — a schema smell.

### 3.4 Unadopted / dead code
- **`contractLifecycle.ts`** (255 lines) is a clean declarative transition matrix but is **never imported anywhere** — the contract service uses ad-hoc inline `if (row.status !== 'draft')` guards at 59 sites instead. Two sources of truth.
- **`printingApi.getJobProfitability`** is dead client code (no UI caller).
- Several `commercialApi` inventory methods (`transferInventory`, `recordDamage`, `getItemMovements`, `getItemLedger`, `getBom`, `getConsumption`, `reorderLevels`, `supplierHistory`) have **no UI callers**.

### 3.5 Missing ERP modules
- **Fixed-asset register & depreciation schedule** — Fixed assets exist only as GL accounts (1500/1590); depreciation is a manual adjusting JE. No asset register, no automated depreciation, no roll-forward. For a press-heavy business this is a notable gap.
- **Production / press scheduling board** — backend has `GET /api/printing/jobs` and full stage model, but no screen lists jobs by status or assigns machines/operators. Job time & machine-run capture has no UI.
- **Warehouse/bin locations** — `stock_balances_by_location` exists (migration 0018) but there is no multi-location UI; most inventory ops are headless.
- **Customer/supplier self-service portal** — no acknowledgements/statements/approvals portal.
- **Formal versioned quotation document** for large commercial jobs (QuickPrint covers counter work only; contracts capture acceptances but no quote doc).

### 3.6 Costing fidelity schema limits
- `measuredCaliperMm`, toner calibration, `cartridgeTonerMassGrams`, coverage, `sheetsPerPack` are **not persisted** (`paperCalc.ts:1298,1304`; `tonerCalc.ts:931-934`) — so DB-driven "auto" costing degrades to rated-yield/estimated rather than calibrated actuals.
- **4dp vs 6dp quantity precision mismatch** in inventory adjustments (`inventoryService.ts:24-30`).

---

## 4. Gap-Closure Plan

Structured into four phases by priority and effort. Each item is independently shippable.

### Phase 1 — Correctness & trust (do first; low effort, high risk-reduction)
1. **Wire Payroll to real data.** Add `payrollApi.listRuns()` (exists) + new `listEmployees` endpoint/client; hydrate `PayrollView` from server; remove demo roster. *(Blocks a live payroll run on fictional data.)*
2. **Fix TaxFormsView integrity.** Either compute 941/940/W-2/1099 from real payroll runs/vendors, or remove the tabs behind a "not available" banner; **delete the fake "SHA-256 Verified" badge** and the `|| 12850.00` fallback. *(Compliance-misleading UI.)*
3. **Add route idempotency keys** to all journal-posting paths: `cancelPrintingJob`, `runPayroll`, `createVendorCredit`, and the void/apply operations. Reuse the existing `request_keys` pattern from `salesService`.
4. **Unify contract state machine.** Refactor `printingRecordsService.ts` to call `contractLifecycle.ts`'s `assertTransition`/`canTransition`, removing the 59 ad-hoc inline guards; delete the "not yet wired" header. *(Two sources of truth today.)*
5. **Add approval gate to inventory shrinkage write-offs** (threshold + second-approver), consistent with job-budget approvals.

### Phase 2 — Frontend coherence (medium effort)
6. **Adopt a router** (`react-router` or `wouter`): URL per view, Back/Forward, deep links, per-route permission guard. Replace the `currentView` switch in `App.tsx`.
7. **Consolidate state.** Either fully hydrate all entities from the server (preferred) or clearly separate "demo" vs "live" with a banner. Target: delete the browser working-copy path for financial entities; shrink `AccountingContext.tsx` (currently 3,848 lines).
8. **Fix sidebar badges** to read live server aggregates (invoices/bills/low-stock counts) instead of demo context.
9. **Remove server imports from client bundle** — move shared costing math into `src/shared/` (isomorphic) or call a `/api/printing/quote` endpoint.
10. **Add QuickPrint history**: `GET /api/printing/quick-jobs` + hydration effect.

### Phase 3 — ERP module completion (higher effort)
11. **Fixed-asset register module**: `assets` table (cost, in-service date, method, useful life, salvage, accumulated depreciation, status), automated monthly depreciation posting JE (`depreciation` source type already exists), asset roll-forward report, disposal/retirement workflow. Reuse `1500`/`1590` GL accounts.
12. **Production scheduling board**: screen listing jobs by status/stage, assign to machine + operator, machine-run time capture (click/running cost inputs) feeding the existing WIP posting. Wire `printingApi.getJobProfitability`.
13. **Inventory depth UI**: surface the already-built `transferInventory`, `recordDamage`, `getItemMovements`, `getItemLedger`, `getBom`, `getConsumption`, `reorderLevels`, `supplierHistory` endpoints. Add a multi-location stock view on `stock_balances_by_location`.
14. **Persist costing calibration** columns (caliper, toner calibration, coverage, pack sizes) so "auto" costing uses actuals, not rated-yield fallback.

### Phase 4 — Compliance & scale depth (ongoing)
15. **Multi-rate tax engine**: tax codes table (rate, jurisdiction, effective dates), per-line/per-item tax assignment, tax summary by jurisdiction; replace single flat rate.
16. **Use-tax clearing account** instead of first-expense dump; proper withholding/W-9/1099 workflow for eligible vendors.
17. **Self-service portal** (customer statements/acknowledgements, supplier invoice submission) — optional but differentiating.
18. **Formal versioned quote document** for commercial jobs (estimate → versioned quote → PO → job), distinct from counter QuickPrint.
19. **Make period-close checklist enforcement on by default** (or per-company policy with a safe default of enforced).

---

## 5. Effort / Impact summary

| Item | Effort | Impact | Priority |
|---|---|---|---|
| Payroll real-data wiring | S | High | P1 |
| Tax forms integrity fix | S | High | P1 |
| Idempotency keys (5 paths) | M | High | P1 |
| Contract lifecycle unification | M | Medium | P1 |
| Inventory write-off approval | S | Medium | P1 |
| Router + URL model | M | Medium | P2 |
| State consolidation | L | Medium | P2 |
| Sidebar badges live | S | Low | P2 |
| Client/server costing split | M | Medium | P2 |
| QuickPrint history | S | Low | P2 |
| Fixed-asset module | L | High | P3 |
| Production scheduling board | L | High | P3 |
| Inventory ops UI | M | Medium | P3 |
| Costing calibration persistence | M | Medium | P3 |
| Multi-rate tax engine | L | High | P4 |
| Use-tax/withholding | M | Medium | P4 |
| Self-service portal | L | Low | P4 |
| Versioned quote document | M | Medium | P4 |

---

## 6. Bottom line

The foundation is **genuinely production-grade**: a real double-entry ledger, real tenant isolation, real domain lifecycles, real reporting, and a clean, well-tested codebase. The score is held below 90 by a concentrated set of **wiring and depth gaps** rather than architectural weakness. Closing **Phase 1** (idempotency, payroll/tax correctness, contract unification, write-off approvals) is the highest-leverage work — it removes the compliance- and trust-affecting defects at modest effort. Phases 2–4 then convert an already-strong ERP into a comprehensive one.