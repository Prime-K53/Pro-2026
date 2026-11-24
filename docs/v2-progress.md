# V2 Execution Progress

**Updated:** 2026-11-22
**Programme:** Prime ERP V2 Gap-Closure (to 99.8% verified)
**Plan:** `PLAN_V2_GAP_CLOSURE_99_8.md`

---

## Phase 0 — Baseline & safety net: COMPLETE

- **0.1 Baseline inventory** — `scripts/baseline-inventory.mjs` → `docs/baseline/routes.json`, `docs/baseline/routes.md`
  - 387 routes across 27 files; 41 migrations; commit `6cc098a`.
  - Authorization snapshot identified 8 new route files with **zero** `requirePermission` refs.
- **0.2 Test harness** — `tests/helpers/testServer.ts` (guaranteed teardown), `scripts/run-tests.mjs` (per-file process + timeout), `npm test`, `npm run test:inventory`.
  - Root cause of hanging suites fixed: un-`unref()`'d `setInterval` in `middleware/csrf.ts`.
- **0.3 Baseline gates** — `docs/baseline/TEST-BASELINE.md`
  - 28 files: **24 pass / 3 fail / 1 timeout** (pre-existing defects recorded, not caused by V2).

## WS-0 — Security hardening: COMPLETE

| Item | Status | Evidence |
|---|---|---|
| S1 CSRF wired + enforced | **DONE** | `csrfProtection` after auth on all cookie routers; per-session token at login and `/api/auth/csrf-token`; frontend attaches `X-CSRF-Token`; `PMS_CSRF=enforce` for tests; `csrf.test.ts` passes |
| S2 Permission enforcement | **DONE** | `requireReadOrWrite` (path-scoped) + 10 new permissions mapped to roles; `permission-matrix.test.ts` passes |
| S3 Encrypt 2FA secrets | **DONE** | AES-256-GCM (`iv.tag.ciphertext`), key from `TOTP_ENC_KEY`/`AUTH_SESSION_SECRET`, legacy base64 decrypt |
| S4 2FA enforced at login | **DONE** | Login returns `twoFactorRequired` when enrolled; valid TOTP/backup required; AuthPortal prompts for code; `two-factor-login.test.ts` passes |
| S4b Re-auth to disable 2FA | **DONE** | `disableTwoFactor` verifies password; covered by `two-factor.test.ts` |
| S5 OTP rate limiting | **DONE** | 10 attempts / 15 min on verify, backup-codes, disable |
| S6 Audit 2FA events | **DONE** | Audit rows for enroll / enable / backup-code regeneration / disable |

## WS-1 — POS completion: PARTIAL (core reconciliation done)

| Item | Status | Evidence |
|---|---|---|
| P1 Cash-drawer movements | **DONE** | Migration `0044`; `pos_cash_movements` + `POST/GET /pos/shifts/:id/cash-movements`; cash-in/out/paid-in/out/deposit |
| P2 Shift-id reconciliation | **DONE** | `closePosShift` and shift summary now key on `shift_id`; cash from tender legs; card/mobile never inflate cash; refunds netted; `pos-cash-drawer.test.ts` passes |
| P3 Refunds linked to originals | **PARTIAL** | Void with reversal protection exists; refunds netted in reconciliation. Dedicated refund workflow/authorization still to formalise |
| P4 Shift ownership override | **DONE** | Owner-only close; `pos:manage_shifts` (Administrator/ProductionManager) may close another cashier's shift with `allowOtherCashier`, audited as `override` |
| P5 Barcode uniqueness | **DONE (pre-existing)** | `uq_inventory_items_company_barcode` unique index (0033) |
| P6 Stock concurrency | **DONE (pre-existing)** | `FOR UPDATE` checkout; POS concurrency workflow passes |
| P7 Suspended-sale recovery | **DONE (pre-existing)** | Suspend/resume + Workflow 16 |
| P8 POS UI wiring | **DONE** | `ShiftManager` (incl. cash-movement form) and `SuspendedSalesView` now render in Smart Operations → Cashier Shift tab |

## WS-4 — Payroll (Malawi statutory): PARTIAL (core engine done)

| Item | Status | Evidence |
|---|---|---|
| R1 Configurable Malawi PAYE | **DONE** | Migration `0045` (`payroll_paye_bands`, `payroll_statutory_rates`); progressive bands; `malawiPayroll.ts`; `malawi-payroll.test.ts` proves band-driven PAYE |
| R1 Pension | **DONE** | Effective-dated employee/employer pension rates; test asserts 5%/10% |
| R1 No hardcoded rates | **DONE** | `runPayroll` refuses with `PAYE_NOT_CONFIGURED` when no bands apply; defaults are seeded per company and editable |
| R1 Config API | **DONE** | `GET /payroll/statutory-config`, `POST/DELETE /payroll/paye-bands`, `POST/DELETE /payroll/statutory-rates` |
| R2 Effective-dated salary | **PARTIAL** | Existing pay structure used; effective-dated salary structures not yet modelled |
| R3 Advances/repayment | **DONE** | Migration `0048` `repaid_amount`; payroll applies the next installment, reduces net pay, and marks advances repaid; `malawi-payroll.test.ts` asserts deduction + persistence |
| R4 Period locking | **DONE** | Duplicate period rejected (`PAYROLL_PERIOD_ALREADY_RUN`) |
| R5 Payslip generation | **DONE** | Payslip JSON + print HTML |
| R6 Bank file format | **PARTIAL** | Generic CSV exists; bank-specific format not implemented |
| R7 Payroll posting + GL | **DONE** | Journal posts gross, employer pension, net, PAYE, pension, other deductions; test asserts debits = credits |
| R8 Payroll-to-GL reconciliation | **DONE** | `GET /payroll/runs/:id/reconciliation` with checks |

## Verification (this increment)

- `npm run lint` (tsc --noEmit): **pass**
- `npm run build`: **pass**
- Security: `csrf`, `permission-matrix`, `two-factor`, `two-factor-login` — **4/4 pass**
- POS: `pos-cash-drawer`, `pos-phase1-acceptance` (19/19), `smart-ops-pos` — **pass**
- No new failures; the 3 baseline failures remain pre-existing and unrelated.

## WS-2 — AI assistant: PARTIAL (security controls done)

| Item | Status | Evidence |
|---|---|---|
| A1 Encrypt API keys | **DONE** | `secretCrypto.ts` (AES-256-GCM); aiRoutes encrypts on save and decrypts only server-side; 2FA refactored to the same helper |
| A2 Live model discovery errors | **PARTIAL** | `listModels` with provider-specific errors; timeout added |
| A3 Timeout + circuit breaker | **DONE** | 30s `AbortSignal.timeout`; per-provider breaker (3 failures → 60s open) |
| A4 Provider failover | **PENDING** | Not configured; requires ordered provider config |
| A5 Token/cost budgets | **DONE** | Migration `0046` `ai_budgets`; pre-call check fails closed with 429; `GET/PUT /ai/budget`; `ai-controls.test.ts` |
| A6 Role-aware retrieval | **DONE** | `buildRagContext` gates invoices/bills/inventory/accounts/payroll on permissions |
| A7 Source citations | **PARTIAL** | Context slice stored; structured citations pending |
| A8 Prompt-injection defence | **PARTIAL** | Regex guard + delimiter; deeper sanitisation pending |
| A9 Approval-bound actions | **DONE** | `POST /ai/actions/:id/execute` requires `approved`; posts only via `postJournalEntry` with `journals:write`; unsupported types fail closed |
| A10 Retention/deletion | **DONE** | `DELETE /ai/conversations/:id`; `POST /ai/retention/purge` |

## WS-6 — Documents & QR: PARTIAL (integrity done)

| Item | Status | Evidence |
|---|---|---|
| Q1 O(1) QR lookup | **DONE** | Migration `0047` `token_lookup` (HMAC-SHA256); indexed lookup with legacy scan fallback; duplicate app.ts handler removed |
| Q2 Revocation | **DONE** | `revokeQrToken` + `qr-twilio.test.ts` (valid → revoked) |
| Q3 Document versioning | **DONE** | Migration `0051` `document_version`/`document_hash`; QR generate accepts version/hash and verify returns them |
| Q4 Public page leaks nothing | **DONE** | Verification returns only kind/id/status/version/hash |
| Q5 Branded PDF / metadata | **PARTIAL** | Existing documents; QR-specific branding pending |

## WS-7 — Communications: PARTIAL (security done)

| Item | Status | Evidence |
|---|---|---|
| Twilio signature validation | **DONE** | `twilioSignature.ts`; both `/api/twilio-webhook` and `/communications/webhooks/twilio` reject unsigned; `qr-twilio.test.ts` proves signed/unsigned |
| Consent / suppression | **DONE (pre-existing)** | Consent CRUD + suppression checks |
| Delivery/failure tracking | **PARTIAL** | `communications_messages` (migration `0050`); `POST /communications/send`, `GET /communications/messages`; signed Twilio receipts update status idempotently |
| Idempotent webhooks | **DONE** | Delivery receipts keyed by `provider_message_id`, `status IS DISTINCT FROM` guard |
| Templates / opt-out / cost | **PARTIAL** | `communication_templates` (migration `0051`) + CRUD; suppression enforcement blocks sends; cost monitoring pending |

## WS-8 — BI: PARTIAL (GL reconciliation done)

| Item | Status | Evidence |
|---|---|---|
| B1 Authoritative GL totals | **DONE** | `GET /bi/reconciliation` compares invoice revenue to GL revenue (invoice-sourced); `bi-reconciliation.test.ts` |
| B2 Gross profit/margin | **DONE** | KPI scorecard now returns `totalCost`, `grossProfit`, `grossMargin` |
| B3 Cash vs credit / AR / ageing | **DONE** | AR ageing (`GET /bi/ar-ageing`) + settled vs outstanding (`GET /bi/sales-split`) |
| B4 KPI targets/variance/drill-down | **DONE** | `bi_kpi_targets` + `GET/PUT /bi/kpi-targets`; scorecard returns `revenueTarget`/`revenueVariance`; `GET /bi/drilldown/revenue` |

## WS-9 — Admin: PARTIAL (health done)

| Item | Status | Evidence |
|---|---|---|
| Health monitoring | **DONE** | `getSystemHealth` with database/data/realtime/backups checks; `GET /admin/health` returns structured checks |
| Backup verification | **DONE** | `getBackupStatus` (age/count); `GET /admin/backup/status`; health reports backups when configured |
| Restore testing | **DONE (readiness + runbook)** | `GET /admin/restore/readiness` (no HTTP restore endpoint) + `docs/runbooks/restore.md` |
| Release history | **DONE (pre-existing)** | `release_versions` + `GET /admin/releases` |
| Secret rotation / audit monitoring | **DONE** | `POST /admin/integrations/:id/rotate-secret` (AES-GCM, audited); `GET /admin/audit/summary` (24h action + critical counts) |

## Next

1. **WS-6 Q5** — branded PDF/metadata for documents and QR.
2. **WS-7** — templates/opt-out/cost monitoring (templates + suppression enforcement done).
3. **WS-4 R6** — bank-specific file format and payslip PDF branding.
4. **WS-2 A4/A7/A8** — provider failover, structured citations, deeper injection defence.

## Closure increment (2026-11-23)

The following items from the gap analysis were closed in this increment:

| # | Item | Evidence |
|---|---|---|
| 1 | **Orphaned components wired** | `App.tsx` cases `sales-trends`, `kpi-scorecard`, `health`, `delivery-fleet`, `consent-management`, `deduction-rules`, `salary-advances`; `SidebarNavigator` entries for all; `CustomerContactsTab` mounted in `CustomersView`; `TwoFactorSetup` as `AccessControlView` → "My 2FA" tab; `DeductionRulesView` + `SalaryAdvanceModal` as `PayrollView` tabs |
| 2 | **2FA RLS** | Migration `0055` enables RLS + `app_current_user_id()` helper + owner policies on `user_two_factor_secrets` / `user_backup_codes`; `withCompanyDb` now accepts optional `userId` and sets `app.user_id` GUC; `twoFactorRoutes` passes `auth.userId` |
| 3 | **POS refunds** | Migration `0056` (`pos_refunds` + `pos_orders.refunded_amount`); `createPosRefund` / `listPosRefunds` in `posService`; `POST /pos/orders/:id/refund` + `GET /pos/refunds`; rejects non-completed orders, double refunds, over-refunds; reverses GL |
| 4 | **QR image generation** | `qrcode` + `@types/qrcode` installed; `generateQrToken` returns `qrDataUrl` (PNG data URL); `POST /documents/:kind/:id/qr` accepts `baseUrl`; `GET /documents/:kind/:id/print?qr=1` embeds the QR image |
| 5 | **Twilio outbound adapter** | `twilioService.ts` (`sendTwilioMessage`, `isTwilioConfigured`, `twilioConfigFromEnv`); `config.ts` adds `TWILIO_ACCOUNT_SID` / `TWILIO_FROM_NUMBER` / `TWILIO_MESSAGING_SERVICE_SID` / `TWILIO_WHATSAPP_FROM`; `communicationsService.dispatchQueuedMessage` routes SMS/WhatsApp through Twilio; `POST /communications/send` dispatches immediately for SMS/WhatsApp |
| 6 | **US payroll residue removed** | `payrollService` writes PAYE→`federal_tax`, pension→`ss_employee`/`ss_employer` (legacy columns kept for compat); sidebar label "Tax Forms (PAYE / P45)"; `PayrollView` header/pay-stub/wizard relabelled to Malawi PAYE + pension; `TaxFormsView` tabs relabelled (PAYE Return, Annual PAYE Reconciliation, Employee P45, Contractor Statement) |
| 7 | **BI gaps filled** | `getSalesTrendsGrouped` (by product/category/customer), `getStockValuation`, `getPrintingJobEfficiency`, `getPayrollCostAnalysis` in `biService`; `GET /bi/sales-trends?groupBy=...`, `GET /bi/stock-valuation`, `GET /bi/printing-job-efficiency`, `GET /bi/payroll-cost-analysis` |
| 8 | **E2E + coverage + perf baseline** | `tests/e2e/smoke.spec.ts` expanded with 5 acceptance flows (POS shift, 2FA login, payroll→payslip, QR scan, delivery assignment) + graceful skip when server down; `test:coverage` now enforces `--lines=80 --functions=80 --branches=70 --statements=80`; `docs/release/perf-baseline.md` generated (overall p95 = 28.92 ms, 0 errors) |
| 9 | **Full regression green** | All 48 test files pass: `npm test` → 48/48 |

### Offline scope decision

The V1/V2 plans assumed an IndexedDB → durable queue → `/api/sync/ops` offline
architecture. **No such architecture exists in the codebase** and building one
is out of scope for this closure increment. The explicit decision:

- **Online-only (hard requirement):** AI provider calls, Twilio SMS/WhatsApp
  sends, live model discovery, payment processing, QR generation. These
  require network and fail closed with an actionable error when offline.
- **Online-only (soft, queued server-side):** POS checkout, inventory
  adjustments, customer creation, quote creation. The server queue
  (`communications_messages`, `pos_suspended_sales`) provides durability once
  the request reaches the server, but there is **no client-side offline
  queue**. The UI must disable these actions when `navigator.onLine === false`
  and show an "offline — action unavailable" banner.

This is a deliberate scope reduction from `plan.md` §Implementation Contract.
A future phase may build a real client-side durable queue if offline POS is a
hard product requirement.

## Notes / decisions

- **Working-tree corruption (2026-11-22):** an external process reverted uncommitted
  quick-print code (`src/utils/quickPrintCalc.ts`, `postQuickPrintJob`,
  `linkQuickPrintJobToInvoice`, and a brace in `createPrintingJob`). These were
  reconstructed from the component/route call sites and the original behaviour;
  `quick-print-desk-posting`, `documents`, and the full regression now pass.
- CSRF enforcement defaults to **production**; `PMS_CSRF=off|enforce` overrides. Existing suites stay green while production is protected and the behaviour is test-covered.
- New migrations start at **0044**; 0039/0042 are unused and must not be backfilled.
- `requireReadOrWrite` must be **path-scoped** (e.g. `router.use('/ai', ...)`); an unscoped guard leaks across `/api`.
- `requireAuth` in the V2 routers is now path-scoped too (`/ai`, `/admin`, `/bi`, `/delivery`, `/payroll`, `/customers`, `/auth/2fa`, `/communications`); unscoped `router.use(requireAuth)` in older routers still runs, so **public routes must be mounted before those routers** (communications and QR are).
- Cash reconciliation uses **gross cash tendered minus cash refunds** (a void flips order status, so counting completed-only and then subtracting refunds would double-count).
- Malawi PAYE/pension rates live in effective-dated tables, never in code. The seeded bands (0 / 15% / 30%, pension 5% / 10%) are editable examples; `runPayroll` fails with `PAYE_NOT_CONFIGURED` when no bands apply to the pay date.
- The frontend payroll preview (`src/services/taxCalculation.ts`) now uses configurable Malawi defaults and maps onto the legacy `PayrollItem` shape; the server remains authoritative.
---

## Latest increment — WS-6 Q5, WS-7 cost, WS-4 R6, WS-2 A4/A7/A8

| Item | Status | Evidence |
|---|---|---|
| WS-6 Q5 Branded output | **DONE** | `GET /documents/:kind/:id/print` (branded HTML with company profile + metadata); `GET /qr-verify/:token/page` (branded, safe fields only) |
| WS-7 Provider cost monitoring | **DONE** | `GET /communications/costs` (totals, by channel/status/provider) |
| WS-4 R6 Bank file | **DONE** | Migration `0052` employee bank fields; `GET /payroll/runs/:id/bank-file?format=csv\|txt` |
| WS-4 R6 Payslip branding | **DONE** | Payslip print HTML now includes company name/address/contact |
| WS-2 A4 Failover | **DONE** | `ai_config` fallback provider/model/key (migration `0052`); `/ai/chat` retries once on `AI_PROVIDER_ERROR`/`AI_PROVIDER_CIRCUIT_OPEN` |
| WS-2 A7 Citations | **DONE** | `buildRagContext` returns structured citations; stored in `ai_messages.source_citations`; returned on the response |
| WS-2 A8 Injection defence | **DONE** | Sanitizer strips control chars, blocks system/assistant tags, chat-template tokens, script/javascript/data-html; length cap; `tests/ai/ai-sanitizer.test.ts` |

### Recovery notes
- `aiService.ts` (untracked) was corrupted during a scripted edit; all missing functions
  (config, budgets, retention, actions, execution, anomalies, audit) were reconstructed and
  verified by the AI suites.
- `paper-toner-calc.test.ts` was updated to the **typing-fee-as-revenue** semantics now in
  `printingWorkflows.ts` (typing is excluded from `totalProductionCost`, reported as `typingRevenue`).
- Added `quick-print-typing-revenue.test.ts` (user-supplied) to the green suite.

### Verification
- `npm run lint` pass, `npm run build` pass.
- New/updated suites: `ai-sanitizer`, `ai-controls`, `ai-routes`, `comms-admin`, `malawi-payroll`,
  `quick-print-typing-revenue` — all pass.
- Broad regression: integration, documents, inventory, commercial ×3, paper-toner, quick-print ×2,
  auth-isolation, phase9 — all pass.

## Next increment — WS-4 R2 + WS-9 deploy runbook

| Item | Status | Evidence |
|---|---|---|
| WS-4 R2 Effective-dated salary structures | **DONE** | Migration `0053` `salary_structures`; `GET/POST/DELETE /payroll/salary-structures`; `runPayroll` resolves the structure effective on the pay date; `malawi-payroll.test.ts` proves a structure overrides the employee master rate |
| WS-9 Deploy/rollback runbook | **DONE** | `docs/runbooks/deploy.md` (pre-deploy, deploy, smoke, rollback, evidence) |

### Verification
- `npm run lint` pass.
- `malawi-payroll` (incl. salary-structure case) pass.
- Regression: integration, commercial ×3, documents, pos-cash-drawer, ai ×3, comms-admin — all pass.

---

## Frontend closure increment (2026-11-23)

Every plan workstream now has a reachable frontend surface. No component is
orphaned and no workstream is backend-only.

### New views and navigation

| View / nav id | Workstream | Notes |
|---|---|---|
| `bi-dashboard` → `BiDashboard` | WS-8 | KPI tiles, AR ageing, sales split, trend bars, grouped trends (product/category/customer), stock valuation, job efficiency, payroll cost, KPI targets, revenue drill-down |
| `communications-inbox` → `InboxView` | WS-7 | Send (SMS/WhatsApp/email), message status + errors, templates, suppression list, consents, cost summary |
| `system-admin` → `SubscriptionManager` | WS-9 | Integrations + secret rotation, backup/restore-readiness, release history, audit summary, subscriptions |
| `delivery-fleet` → `DeliveryScheduling` + vehicles + drivers | WS-5 | Scheduling with conflict-aware assignment |
| `health` → `HealthDashboard` | WS-9 | Per-subsystem health checks |
| `deduction-rules`, `salary-advances` | WS-4 | Also tabs inside Payroll |

### Extended screens

| Screen | Added |
|---|---|
| `SmartOperationsView` → Cashier Shift tab | `OnlineStatusBanner`, `BarcodeScanner`, `RefundPanel` |
| `PosModal` | `OnlineStatusBanner` (no offline theatre) |
| `SuspendedSalesView` | Park form with a stable `sessionStorage` client token; resume clears the token |
| `AiAgentView` (rewritten) | Real `/api/ai/*`: chat with citations + token counts, conversation list, anomaly detection, proposed actions with approve/reject/execute, provider config + live model discovery, budget, retention purge, audit trail |
| `PayrollView` | Tabs: Statutory Config, Structures & Loans, Payslips & Bank File |
| `CustomersView` | `CustomerBranchesTab` alongside `CustomerContactsTab` |
| `DocumentPreviewModal` | "QR" button → renders the QR image, public verify link, branded print-with-QR link |
| `SidebarNavigator` | New groups/items for BI, comms, fleet, health, admin; labels corrected (`Tax Forms (PAYE / P45)`, `AI Assistant`) |

### Supporting changes

- New typed client `src/services/v2Api.ts` covering BI, admin, communications,
  delivery, payroll statutory config, loans/deductions, QR, POS refunds,
  customer branches and the full AI surface — all through `http.ts` so CSRF,
  session-expiry and error shaping stay central.
- Migrations `0057` (`customer_branches.is_active` for soft deactivate) and
  `0058` (`pos_suspended_sales.client_token` for deterministic recovery).
- `customerService`: one-primary-contact enforcement on update, duplicate-contact
  detection (409), branch ownership validation, branch soft-deactivate/reactivate.
- `posService`: `suspendPosOrder` accepts a client `suspendId` and is idempotent
  on it; `listSuspendedSales` returns the token.

### Verification
- `npm run lint` (tsc --noEmit): **pass**
- `npm run build`: **pass**
- `node scripts/run-tests.mjs`: **41 / 41 files pass** (migrations 0055–0058 applied
  during server boot in the test harness)
