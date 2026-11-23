# Prime ERP — V2 Gap-Closure Plan (to 99.8% Verified Quality)

**Status:** Draft for approval
**Supersedes:** the implementation checklist implied by `docs/gap-closure-report.md`
**Baseline evidence:** `docs/verification-report.md`, plus independent re-verification on 2026-11-22
**Guiding rule:** *Improve Prime ERP without destabilising what already works.* 99.8% is a **demonstrated** target, not a claim.

---

## 0. What re-verification actually found (baseline)

Verified by running `npm run lint` (pass), `npm run build` (pass), and the test suites (POS 19/19, phases 4–11 32/32, AI pass, 2FA pass), plus source inspection.

| Area | Reality | Consequence for V2 |
|---|---|---|
| Offline architecture | **No** IndexedDB, durable queue, or `/api/sync/ops` exists anywhere in `src` | V1 correction premise was false. V2 must either build it or explicitly scope it out per operation. |
| Authorization | New routers use `requireAuth` only; no `requirePermission` | Any authenticated user can hit admin/payroll/AI/2FA endpoints. **P0 fix.** |
| CSRF | `middleware/csrf.ts` exists but is **not registered** in `app.ts` | Cookie-auth CSRF is unprotected. **P0 fix.** |
| 2FA | Not enforced at login; `encryptSecret` is base64; `disableTwoFactor` ignores password; no rate limit; migration 0035 has no RLS | 2FA is cosmetic. **P0 fix.** |
| Payroll tax | US Social Security/Medicare/IRS/Ohio hardcoded | Wrong jurisdiction. **P0 fix.** |
| POS cash drawer | `cash_in/cash_out/cash_deposits` hardcoded `0`; shift stats keyed on `created_by`+time, not `shift_id` | Reconciliation is incomplete. **P0 fix.** |
| Frontend | 11 new components exist but **none are imported** in `App.tsx`/`SidebarNavigator` | Features are unreachable. **P0 fix.** |
| Migrations | Up/down pairs exist; numbers skip **0039** and **0042**; 0035 lacks RLS | New migrations start at **0044**; never reuse 0039/0042. |
| Test harness | New tests leave the HTTP server open (2FA test needs external `timeout`); no coverage runner; no e2e/a11y/perf | CI would hang. **P0 fix.** |

**V1 rating carried forward:** POS ~60%, AI ~30%, Security ~25%, Customers ~40%, Payroll ~30%, Delivery ~20%, Portal deferred (correct), Documents ~50%, Comms ~15%, BI ~25%, Admin ~20%. Programme-wide authorization/CSRF/offline/UI-integration all fail.

---

## 1. Architecture contract (corrected for the real codebase)

```
React/Vite UI  →  src/services/*.ts (typed fetch clients)
                      │  (cookie session; CSRF header)
                      ▼
        Express routers (src/server/routes/*.ts)
          requireAuth → rejectCrossCompanyParams → requirePermission(...)
                      ▼
        Service layer (src/server/services/*.ts)
          validation · idempotency · business rules · GL posting
                      ▼
        PostgreSQL via db.withCompanyDb(companyId)  (single company + RLS)
                      ▼
        Supabase (durable, authoritative)  +  audit_log
```

**Rules that V2 enforces everywhere:**

1. **Single company.** `company_id` is for configured-company scoping/data integrity, **not** tenant switching. Do not add tenant-switch UX or multi-tenant acceptance criteria.
2. **No offline theatre.** An operation is either (a) explicitly **online-only** (external providers, live AI, bank/Twilio calls) or (b) backed by a **real** durable queue. If (b) is not built in a phase, the UI must disable the action offline and say so.
3. **Accounting reuse.** All financial effects go through `accountingEngine.postJournalEntry` / existing COA resolution. Journal lines reference **account UUIDs**; codes are display-only. No legacy-code fallback. Respect `assertPeriodOpenForDate`.
4. **Permissions are mandatory.** Every mutating route declares a `Permission`; every new permission is added to `permissions.ts` and mapped in `ROLE_PERMISSION_SETS`.
5. **Evidence or it didn't happen.** Every "done" needs a test id + command + artifact. No PASS without evidence.

---

## 2. Phase 0 — Baseline & safety net (Gate 1–2)

**Goal:** make the current system measurable and protect it before changing anything.

### 0.1 Freeze and inventory
- Record `git rev-parse HEAD`, `schema_migrations` contents from the live DB, and a `docs/baseline/` snapshot of: migration list, table/column inventory, route inventory, permission matrix.
- Produce a **dependency map**: which routes → services → tables → GL accounts each module touches.
- Confirm 0039/0042 are genuinely unused (live `schema_migrations` + repo). **Do not reuse them.**

### 0.2 Test harness that actually terminates
- Add a test runner with coverage: **Vitest** (or `node:test` + `c8`). Add `test`, `test:coverage`, `test:e2e` scripts.
- Create a shared `tests/helpers/server.ts` that boots the app, exposes `baseUrl`, and **always** tears down in `finally` (`server.close()`, `db.close()`). Refactor existing tests to use it. This fixes the hanging 2FA/integration tests.
- Add `tests/helpers/auth.ts` to log in and return a cookie + CSRF token.

### 0.3 Baseline gates (must pass before Phase 1)
- [ ] `npm run lint` clean
- [ ] `npm run build` clean
- [ ] Full suite exits 0 with coverage report
- [ ] API authorization matrix snapshot: every route × role → expected allow/deny
- [ ] Accounting baseline: trial balance = 0 on seeded demo data
- [ ] Performance baseline: p95 for top 10 endpoints recorded

**Exit criterion:** reproducible baseline in CI. Any later regression is attributable.

---

## 3. Workstreams (each maps to phases; each has acceptance tests)

### WS-0 — Security & platform hardening (P0, blocks everything)

| # | Task | Files | Acceptance |
|---|---|---|---|
| S1 | Register `csrfProtection` after auth on all cookie-auth `/api` routes; issue token on login; exempt only webhooks (with signature) and public verify | `app.ts`, `middleware/csrf.ts` | Cookie POST without `X-CSRF-Token` → 403; with → 2xx |
| S2 | Add `requirePermission` to every new router; audit all existing routers for missing checks | `routes/{ai,payroll,customer,delivery,bi,admin,twoFactor,communications,documentQr}Routes.ts`, `permissions.ts` | Role matrix test: Read-Only cannot mutate; non-admin cannot hit `/admin/*` |
| S3 | Encrypt 2FA secrets with **AES-256-GCM** using `config.authSessionSecret`-derived key (or dedicated `TOTP_ENC_KEY`); rotate support | `twoFactorService.ts`, `config.ts` | Secret at rest is ciphertext; decrypt round-trips; wrong key fails closed |
| S4 | Enforce 2FA at login: if `enabled`, require `TOTP` step before issuing session; support backup codes; **re-auth password** to disable | `authRoutes.ts`, `twoFactorService.ts` | Login without code when enrolled → 401 `2FA_REQUIRED`; valid code → session; disable without password → 403 |
| S5 | Rate-limit OTP verify/disable (per user + per IP); lockout backoff | `twoFactorRoutes.ts`, `rateLimiter.ts` | 5 bad codes → 429 |
| S6 | Session rotation on login and privilege change; audit enrollment/disable/recovery | `authRoutes.ts`, `audit.ts` | `session_version` bumps; audit rows written |
| S7 | Add RLS to `user_two_factor_secrets`/`user_backup_codes` (or documented user-scoped policy) | new migration **0044** | RLS enabled + policy test |
| S8 | Secrets management: move AI/Twilio keys to env/secret store; never return plaintext; add rotation endpoint | `aiRoutes.ts`, `adminService.ts` | `GET /ai/config` never returns key; rotation writes new ciphertext |

### WS-1 — POS completion (P0)

| # | Task | Acceptance |
|---|---|---|
| P1 | Cash-drawer movements: table `pos_cash_movements` + endpoints for cash-in, cash-out, paid-in/out, deposits; each posts/records and is shift-scoped | Movement totals appear in shift close |
| P2 | Rewrite `closePosShift` stats to key on **`shift_id`** (not `created_by`+time); implement `ExpectedCash = OpeningFloat + CashSales + CashIn − CashRefunds − CashOut − CashDeposits` | Unit + integration test with mixed tenders (cash/card/MM) proving card/MM do **not** inflate cash |
| P3 | Refunds linked to original sale: `pos_refunds` referencing `pos_order_id`, authorization + reversal protection, inventory restore, GL reversal | Refund without original → 400; double refund → 409; GL balanced |
| P4 | Shift ownership: only owner or `pos:write` + manager override may close another's shift (audited) | Non-owner close → 403; override → audit row |
| P5 | Barcode uniqueness + duplicate detection at item create/update | Duplicate barcode rejected (unique index) |
| P6 | Stock concurrency: keep `FOR UPDATE`; add negative-stock guard + oversell test | Concurrent terminals never oversell |
| P7 | Suspended-sale recovery across refresh/restart (already partly present) → make deterministic with a client-generated `suspendId` | Resume after simulated restart returns same draft |
| P8 | Wire POS UI: route `ShiftManager`, `SuspendedSalesView` into `SmartOperationsView`/nav; POS offline banner when applicable | Nav reachable; E2E open/close shift |

### WS-2 — AI assistant (P1)

| # | Task | Acceptance |
|---|---|---|
| A1 | Encrypt API keys (AES-GCM); never echo; rotation | Ciphertext at rest |
| A2 | Live connectivity check + model discovery with provider-specific errors | Bad key → actionable 502 message |
| A3 | Timeout + retry (bounded) + circuit breaker per provider | Provider hang → fail within N s; breaker opens |
| A4 | Optional failover only when configured (ordered provider list) | Failover test with stubbed provider |
| A5 | Token/cost/usage budget per company/user; enforce before call | Over budget → 429/402, no provider call |
| A6 | Role-aware retrieval: `buildRagContext(tx, companyId, role, query)` filters by permitted data | Read-Only cannot retrieve restricted records |
| A7 | Structured citations: return `[{table, id, label}]` per answer; store on message | Citations persisted and rendered |
| A8 | Prompt-injection defense-in-depth: delimit DB content, strip control tokens, treat retrieved text as data not instructions; keep regex as one layer | Injection fixtures blocked |
| A9 | Proposed actions: bind to approval workflow; execution requires `approvals:decide` and posts via accounting services only | Unapproved action cannot execute; financial action posts through GL |
| A10 | Retention/deletion policy for conversations/messages | TTL/purge job + manual delete |

### WS-3 — Customers (P2)

| # | Task | Acceptance |
|---|---|---|
| C1 | Contact roles + primary-contact enforcement (already partly) | One primary per customer |
| C2 | Multiple addresses (billing/shipping) as first-class rows; branch defaults validated | Default branch must exist & belong to customer |
| C3 | Duplicate-contact detection (name+phone/email fuzzy) on create | Warn/block duplicates |
| C4 | Merge customers with audit trail; reassign transactions; preserve history | Merge is reversible/audited |
| C5 | Deactivate branch (soft) preserving historical transactions | Deactivated branch hidden but referenced by old docs |

### WS-4 — Payroll (P0/P1)

| # | Task | Acceptance |
|---|---|---|
| R1 | **Replace US tax engine** with configurable **Malawi** statutory engine: PAYE bands, pension (employee/employer), other statutory deductions — all **effective-dated config tables**, no hardcoded rates | Known PAYE fixtures compute correctly; rate change by effective date |
| R2 | Effective-dated salary structures; configurable allowance types | Historical payroll uses period-correct structure |
| R3 | Advances: approval + repayment schedule + balance tracking; loans/deductions balances | Repayment reduces balance; over-repay blocked |
| R4 | Payroll period locking; recalculation/amendment controls | Locked period rejects changes |
| R5 | Payslip generation (branded PDF, metadata) | Payslip totals = gross − deductions = net |
| R6 | Bank file in the **actual bank format** (configurable template), not generic CSV | Format validated against bank spec fixture |
| R7 | Payroll posting + reversal via accounting services; payroll-to-GL reconciliation | Debits=credits; net pay = liabilities − payments |
| R8 | Wire payroll UI (advances, deduction rules, payslips) into nav | Reachable + E2E |

### WS-5 — Delivery & fleet (P3)

| # | Task | Acceptance |
|---|---|---|
| D1 | Vehicle/driver availability validation on assignment; licence/insurance/registration expiry alerts | Expired → block assignment or warn per policy |
| D2 | Maintenance history + cost capture | History persisted |
| D3 | Scheduling conflict detection (driver/vehicle double-booking) | Overlap → 409 |
| D4 | Route + stop tracking; proof-of-delivery attachment integrity (hash) | POD tamper detected |
| D5 | Failed delivery + redelivery workflow | Redelivery linked to attempt |
| D6 | Delivery cost allocation to jobs/orders, feeding existing profitability reports | Cost shows in job profitability, reconciles |

### WS-6 — Documents & QR (P3)

| # | Task | Acceptance |
|---|---|---|
| Q1 | Store a **lookup hash** (HMAC of token with server key) in a dedicated column; verify by single indexed lookup, not O(n) scan | Verification is O(1); old rows migrated |
| Q2 | Remove duplicate public QR handler; keep one path | Single route, no shadowing |
| Q3 | Document version tracking + integrity check against correct version | Scan resolves to specific version |
| Q4 | QR revocation + status/timestamps; public page reveals **no** confidential fields | Response schema test |
| Q5 | Branded PDF + consistent metadata; regeneration audit | Regeneration logged |

### WS-7 — Communications (P3)

| # | Task | Acceptance |
|---|---|---|
| M1 | **Twilio webhook signature validation** (or provider HMAC) on the public webhook; reject unsigned | Unsigned → 403; signed fixture → 200 |
| M2 | Idempotent webhook processing (event id unique) | Duplicate webhook processed once |
| M3 | Consent: source+timestamp, channel-specific, withdrawal; suppression checks before send | Withdrawn consent blocks send |
| M4 | Outbound send with delivery/failure tracking; retry queue + dead-letter | Failed message retried then DLQ |
| M5 | Template version tracking; duplicate-message prevention | Same template+recipient window blocked |
| M6 | Provider usage/cost monitoring | Usage recorded |
| M7 | WhatsApp vs SMS as separate channels | Channel-scoped consent |

### WS-8 — Business intelligence (P4)

| # | Task | Acceptance |
|---|---|---|
| B1 | All metrics from authoritative records (GL + subledgers), reconciled | BI totals tie to trial balance |
| B2 | Add required KPIs: cash vs credit, GP/margin, AR aging, payment performance, inventory turnover/valuation, cashier performance, job profitability, wastage/efficiency, payroll cost | Each KPI has a test with known expected value |
| B3 | KPI targets, actuals, variance | Variance math tested |
| B4 | Drill-down KPI → underlying transactions | Click-through endpoint returns rows |

### WS-9 — System administration (P1)

| # | Task | Acceptance |
|---|---|---|
| S9 | Monitoring: DB connectivity, sync/queue health (if built), realtime, storage, background jobs, error tracking | Health endpoint reports each subsystem |
| S10 | Backup **verification** + **restore test** (provider-supported, privileged, audited, pre-restore backup, runbook). **No blind HTTP restore endpoint.** | Restore drill documented + evidenced |
| S11 | Release version history + controlled deploy/rollback procedure | Rollback runbook tested |
| S12 | Integration secret management + rotation; audit-log monitoring/alerts | Rotation + alert test |
| S13 | Remove `max_companies`; subscription limits = users/modules/storage/usage/support | No company-count limit |

---

## 4. Programme-wide acceptance gates

Every phase must satisfy **all** of these before "done":

1. **Regression:** existing frontend/backend/DB/POS/inventory tests still pass.
2. **Authorization:** route × role matrix tests pass (100% of mutating routes).
3. **Idempotency:** retries do not duplicate transactions (tested per mutating endpoint).
4. **Accounting reconciliation:** for financial phases, `Σdebits = Σcredits` and subledger↔GL tie-out on **real records**, not mock totals.
5. **Data integrity:** migration up/down on a copy; row counts preserved; no silent data loss.
6. **Offline:** supported ops survive disconnect+restart **or** are explicitly online-only and disabled offline.
7. **Audit:** sensitive ops produce audit rows.
8. **Performance:** no p95 regression beyond agreed baseline.
9. **Accessibility:** keyboard operable, contrast, clear validation (WCAG 2.2 AA target).
10. **Evidence:** test command + artifact link in the phase acceptance report.

### 4.1 Test taxonomy (new)
- **Unit** (Vitest) for services (tax, cash reconciliation, QR verify, tender math).
- **Integration** (HTTP) for routes incl. auth/CSRF/permission matrix.
- **Accounting regression** for GL tie-out.
- **E2E** (Playwright) for: POS shift open→sale→close, 2FA login, payroll run→payslip, QR scan, delivery assignment.
- **Security regression** (authz matrix, CSRF, 2FA bypass, webhook signature, rate limits).
- **Accessibility** (axe) and **performance** (p95) checks.

### 4.2 Quality targets (measurement definitions)
| Dimension | Target | How measured |
|---|---|---|
| Automated regression | 100% release gate | CI |
| Critical workflow tests | 100% | E2E |
| Accounting reconciliation | 100% | GL tie-out jobs |
| Auth/authz tests | 100% routes | Matrix |
| Critical/high security findings | 0 open | Security suite + review |
| Overall coverage | ≥ 90% lines | Vitest coverage |
| Critical logic coverage | ≥ 95% branches | Vitest |
| API contract compliance | ≥ 99.8% | Contract tests |
| Availability | 99.8% monthly | Monitoring |
| Performance | p95 baselines | Load test |
| Accessibility | WCAG 2.2 AA | axe |
| Runbooks | 100% of prod features | Docs review |

**Zero tolerance:** financial, security, data-integrity, sync failures. 99.8% ≠ permission for 0.2% financial failures.

---

## 5. Migration plan

- Existing: `0001–0038`, `0040`, `0041`, `0043`. **0039 and 0042 are unused — do not backfill** (avoids reordering applied migrations).
- **New migrations start at `0044`**, one per workstream, always paired `.up.sql`/`.down.sql`, RLS enabled, reversible.
- Before each migration: read live `schema_migrations` + `information_schema`; confirm version unused; snapshot counts.
- No destructive DDL; no drop/overwrite of production rows; additive columns with defaults/backfills.

Indicative mapping:

| Migration | Workstream |
|---|---|
| 0044 | Security: 2FA RLS, OTP lockout, session rotation, secret metadata |
| 0045 | POS: `pos_cash_movements`, `pos_refunds`, shift-id indexes |
| 0046 | Payroll: statutory config, effective-dated structures, advances/loans, period locks, payslip metadata |
| 0047 | Delivery: assignment rules, maintenance, POD, cost allocation |
| 0048 | Documents: QR lookup hash, versions, integrity |
| 0049 | Communications: templates, message delivery, DLQ, idempotency |
| 0050 | BI: KPI targets, metric definitions |
| 0051 | Admin: monitoring, retention, subscription limits |

---

## 6. Execution order (keep phase numbers; Phase 7 deferred)

| Seq | Phase | Priority | Depends on |
|---|---|---|---|
| 0 | Baseline & test harness | P0 | — |
| 1 | WS-0 Security hardening | P0 | 0 |
| 2 | WS-1 POS completion | P0 | 0, 1 |
| 3 | WS-4 Payroll (Malawi statutory) | P0 | 0, 1 |
| 4 | WS-2 AI assistant | P1 | 0, 1 |
| 5 | WS-3 Customers | P2 | 0, 1 |
| 6 | WS-5 Delivery | P3 | 0, 1 |
| 7 | Customer portal | Deferred | — |
| 8 | WS-6 Documents/QR | P3 | 0, 1 |
| 9 | WS-7 Communications | P3 | 0, 1 |
| 10 | WS-8 BI | P4 | 0, 1, 2, 3 |
| 11 | WS-9 System admin | P1 | 0, 1 |

Rationale: security + test harness first (they gate honest measurement); POS and payroll are P0 because they carry financial risk; BI last because it must read reconciled data.

---

## 7. Release gates (per phase)

1. **G1 Discovery** — baseline evidence + dependency map.
2. **G2 Design** — schema changes, reused services, authz matrix, failure/recovery.
3. **G3 Implementation** — small reviewable changes; existing workflows intact.
4. **G4 Verification** — unit/integration/regression/security/offline/e2e.
5. **G5 Data verification** — before/after DB diff + financial reconciliation.
6. **G6 Deployment** — approval + backup + monitoring + recovery.
7. **G7 Closure** — evidence pack, test results, migration status, open issues, sign-off.

A phase cannot advance because code was written. It advances on **evidence**.

### Phase acceptance report template
```
Phase: <n> — <name>
Status: PASS / BLOCKED
Migrations: <versions, up/down verified, RLS>
Routes: <list, permission each>
Tests: <unit/integration/e2e counts + command>
Reconciliation: <GL tie-out result>
Security: <authz matrix, CSRF, 2FA, rate limits>
Performance: <p95 before/after>
Data: <row counts before/after>
Known issues: <...>
Sign-off: <name/date>
```

---

## 8. Risk register (top risks)

| Risk | Mitigation |
|---|---|
| US tax logic already shipped in payroll | Treat as defect; feature-flag Malawi engine; migrate data; do not silently overwrite historical runs |
| No real offline queue; building one is large | Scope per operation; mark online-only where acceptable; build queue only for POS/sales if required |
| Tests hang / no coverage runner | Phase 0 fixes teardown + adds Vitest/Playwright before feature work |
| Broad permission gaps | Central middleware + matrix tests; deny-by-default for new routes |
| Migration drift vs live DB | Phase 0 inventory; additive-only; 0044+ |
| Frontend components orphaned | Wire in same PR as backend; E2E proves reachability |
| Scope creep into multi-tenant/portal | Explicit non-goals in every phase design |

---

## 9. Definition of done (programme)

The programme is at 99.8% **only when**:
- All P0/P1/P2 phases pass their release gates with evidence.
- Full regression + authz + accounting + security + e2e suites are green in CI.
- Coverage ≥ 90% overall / ≥ 95% critical logic.
- p95 within baseline; WCAG 2.2 AA checks pass.
- Restore drill and rollback drill evidenced.
- No open critical/high security findings.
- A signed acceptance report exists per phase.

Until then, status is **NOT CERTIFIED**.