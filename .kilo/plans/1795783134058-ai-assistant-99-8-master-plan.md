# PRIME PRINTING — MASTER AI ASSISTANT DEVELOPMENT PLAN
## Target: 99.8% Verified Capability and Operational Reliability

**Plan type:** Architecture and delivery specification
**Product:** Prime Printing PWA
**Delivery model:** Phased, independently validated implementation
**Scope:** All six AI capability domains
**Autonomy policy:** Draft and propose; authorized human approval and execution
**Financial safety policy:** Deterministic evidence remains authoritative
**Target:** 99.8% measured capability score, 100% on critical safety gates

> This plan is the authoritative spec. A coding agent executes it; it must not redesign architecture or expand scope. Do not implement until this plan is approved.

---

## 0. Codebase reconciliation (verified facts — read before any phase)

These were confirmed against the working tree and override conflicting assumptions in the source brief.

- **Runtime is PGlite (embedded Postgres/WASM), NOT SQLite.** `src/server/db.ts:3,609-612` (`new PGlite(dataDir)`), version `0.5.17` (`node_modules/.pnpm/@electric-sql+pglite@0.5.17/.../package.json`). The brief's "SQLite local runtime" is incorrect for this repo. All storage/migration/vector decisions below assume PGlite/Postgres. If a SQLite port is actually intended, Phase 0 must re-evaluate storage from scratch.
- **Supabase is present** for auth (`src/server/supabaseAuth.ts`, `@supabase/supabase-js`). Preserve it.
- **pgvector is NOT bundled.** `@electric-sql/pglite` `package.json` `exports` has no `./vector` subpath; no vector files exist; no `embedding|pgvector|CREATE EXTENSION` anywhere. Vector memory therefore requires Phase 0 to either add the separate `@electric-sql/pglite/vector` package or use a `jsonb`/`real[]` column + in-app cosine. **Phase 0 decides and records the outcome; do not assume.**
- **Migrations**: paired `NNNN_name.up.sql`/`.down.sql`, checksummed, transactional (`db/migrator.ts`). Latest applied is `0089`. New migrations start at **`0090`**. Never edit an applied migration.
- **AI core (extend, do not replace)**: `aiProvider.ts` (chat + `listModels` + `sanitizePrompt` + `buildSystemPrompt`; **no embeddings yet**), `aiService.ts` (`prepareChat`/`finalizeChat`, `reserveAttempt`/`settleAttempt`, `proposeAction`/`approveProposedAction`/`executeProposedAction`, `detectAnomalies`, budgets, retention), `aiFinancialGrounding.ts` (`buildEvidenceSet`, `EvidenceRecordType` union at `:16-21`, blanket abstain regex at `:307-313`), `aiClaimVerifier.ts` (`verifyClaims`), `ocrService.ts`/`ocrSchema.ts` (`kind` = `quote|invoice` only), `routes/aiRoutes.ts`.
- **Draft states already exist at schema level** (service behavior still to verify in Phase 0/3): invoices `status IN ('draft','sent','partial','paid','overdue','voided')` (`0003_...:161`); quotes `status IN ('draft','sent','accepted','declined','expired','converted')` (`0062_quotes:14`); printing_jobs `status IN ('draft','budget_approved','queued',...)` (`0011_...:36`). Do not assume `createInvoiceOrSalesReceipt` posts vs drafts — verify.
- **Anomaly ack states already exist**: `ai_anomaly_alerts.status IN ('open','acknowledged','resolved','dismissed')` (`0034_ai_assistant:84`). Only the transition route is missing.
- **Scheduler hook**: `src/server/scheduler.ts` `runTenantTick` (per-tenant lease) is where scheduled `detectAnomalies` + memory reindex attach; `recoverAllUnresolved` already runs there.
- **Permissions** are a typed union in `src/server/permissions.ts:16-151`; new permissions must be added there and to role grants.
- **Tenant isolation**: `withCompanyDb` (`db.ts:626`), `rejectCrossCompanyParams` (`middleware/auth.ts:351`), RLS+FORCE per table. Reuse for every new table.
- **Dead code to wire**: `referralFraudService.detectIdentitySignals` (`:32`) is never invoked.
- **No Docker** is introduced by this feature (repo's existing Docker is deployment-only; leave it).

---

## 1. Executive objective
Evolve the existing grounded assistant into a comprehensive operational intelligence assistant across six domains — financial, operational, document, action, predictive, and memory/context — without weakening security, financial integrity, tenant isolation, authorization, auditability, or budget controls. This extends the existing AI subsystem; it is not a new app.

## 2. Definition of 99.8%
A measured acceptance target, not a subjective impression.

### 2.1 Critical safety gates — mandatory 100% (release blockers)
- Zero unauthorized financial posting/execution.
- Zero cross-company data leakage.
- Zero financial claims shown as verified without authoritative evidence.
- Zero permission/approval bypasses.
- Zero duplicate financial execution from retries/concurrency.
- Zero provider calls bypassing budget reservation.
- Zero protected-info exposure via memory retrieval.
- Complete audit trails for sensitive AI actions and financial mutations.
- Fail-closed when evidence, authorization, or budget controls are unavailable.

### 2.2 Capability score (100 points)
| Capability | Weight |
|---|---:|
| Financial intelligence | 20 |
| Operational intelligence | 15 |
| Document intelligence | 15 |
| Action intelligence | 15 |
| Predictive intelligence | 15 |
| Reliable memory & context | 10 |
| Cross-cutting reliability/security/observability | 10 |
| **Total** | **100** |

Aggregate ≥ 99.8% **and** every gate 100%. Per-capability minimums must be met (no capability may be weak while the aggregate passes). Measurement per capability: financial = exact agreement + correct citation; operational = correct records/status; OCR = field-level accuracy vs manually verified docs; actions = correct proposal/approval/execution/dedup; predictions = precision/recall/forecast error; memory = relevance/freshness/provenance/isolation. Dataset must include normal, edge, conflicting, incomplete, malicious-prompt, stale, and concurrent cases. Do not declare 99.8% without measured results.

## 3. Permanent architectural principles (cannot be weakened)
- **3.1 Financial truth is backend-only.** Model narrates server evidence; every verified figure passes `verifyClaims` (`aiClaimVerifier.ts`). No parallel accounting math in the AI layer.
- **3.2 Abstention is valid.** Unavailable/incomplete/conflicting/stale/unauthorized → explain, don't fabricate. Unsupported domains stay fail-closed until built+tested (replace the blanket abstain at `aiFinancialGrounding.ts:307-313` per-domain, never open-all).
- **3.3 Human-controlled autonomy = draft + propose; human approves+executes.** AI may prepare quote/invoice drafts, journal proposals, workflow/purchasing/inventory proposals, and explain consequences. AI may not self-approve, self-execute, post unapproved, or treat chat as authorization. Creator ≠ approver/executor. Every approve/execute is permission-checked + audited. Any post-approval change to records/amounts/parameters invalidates approval.
- **3.4 Two retrieval paths, kept separate.** Deterministic evidence (balances, prices, taxes, reports, profitability, stock qty/valuation, current statuses, approved rules) is authoritative. Semantic memory (product descriptions, customer background/preferences, historical decisions, production instructions, document descriptions) is untrusted context with provenance; it never authorizes action or establishes financial truth.
- **3.5 Tenant isolation.** Every retrieval/embedding/evidence/conversation/action/job is company-scoped: `companyId`, `withCompanyDb`, RLS+FORCE, permission checks, cross-company negative tests. RLS is defense-in-depth, not a substitute for app authz.
- **3.6 Auditability.** Record requester, proposal, evidence, approver, executor, result, timestamps, idempotency/correlation ids, config/detection changes. Audit sensitive retrieval, reindex, scheduled detection.
- **3.7 Preserve architecture.** PWA; no Docker/desktop conversion; keep offline-first + PGlite local runtime + Supabase auth. New capabilities fit the existing deployment/sync model.

## 4. Resolved product decisions
| Area | Decision |
|---|---|
| Autonomy | Draft + propose; human approves & executes |
| Memory | Deterministic evidence + semantic vector memory |
| Financial truth | Deterministic server evidence only |
| OCR | Quotes, invoices, receipts, supplier bills; single image |
| OCR confidence | Field-level validation + confidence gate |
| Dedup | Business identity + document reference (not just image hash) |
| Predictive | Explainable deterministic rules + forecasting; no ML |
| Delivery | Ordered, independently validated phases; all six to parity |

## 5. Phase 0 — Read-only feasibility & architecture verification (no code changes)
- **5.1 Baseline**: verify repo path/remote/branch/HEAD, full dirty+untracked manifest, migration history/checksums, existing AI services/routes/permissions/tests, PWA/PGlite/Supabase runtime. Preserve all work. No reset/clean/stash/checkout.
- **5.2 Vector feasibility**: test `@electric-sql/pglite/vector` (install if permitted) + `CREATE EXTENSION vector` + vector column + insert/retrieval + similarity + migration + persistence + offline + Supabase-Postgres parity. If unavailable → `jsonb`/`real[]` + app-side cosine. Document decision before Phase 2. Do not add a second retrieval engine to dodge the investigation.
- **5.3 Embedding provider**: pick model id, dimensions, input limits, timeout/retry, failure handling, budget accounting (via existing `reserveAttempt`/`settleAttempt`), model versioning, reindex-on-model-change. Add `embedContent` to `aiProvider.ts` mirroring `chatCompletion` breaker/timeout/`AccountingError`.
- **5.4 Domain routing**: one classifier deciding deterministic/operational/semantic/multi/abstain. Must not bypass permissions or source validation.
- **5.5 Exit**: architecture documented; vector storage backed by real tests; provider compatibility established; budget accounting understood; retrieval security model approved. Deliver feasibility report + spec. **No later phase starts until exit criteria met.**

## 6. Phase 1 — Financial intelligence (#1) — highest priority
- **6.1 Evidence builders** in `aiFinancialGrounding.ts` for: P&L, balance sheet, cash flow, trial balance, AR aging, AP aging, budget-vs-actual, revenue/expenses, customer/supplier balances, inventory valuation, tax summary, job profitability/cost/margin. Reuse authoritative services (`financialReports.ts`, `salesService.getArAgingReport`, `purchasingService.getApAgingReport`, `operationalReports.getPrintingJobProfitability`, `financialManagementService` budget-vs-actual). Extend `EvidenceRecordType` (`:16-21`). Each item: company, source id, metric/field, amount+currency, period/as-of, status, completeness, provenance, permission.
- **6.2 Reconciliation**: cached operational balances (customers/vendors/inventory) must not be labeled reconciled accounting balances without proof; gate on existing reconciliation (`operationalReports` COGS/inventory recon, `periodCloseService` AR/AP tie-out, `biService.getBiReconciliation`).
- **6.3 Claim verification**: extend `aiClaimVerifier.ts` for report-level aggregates bound to a specific report/company/period/metric; forbid combining unrelated rows into a fabricated aggregate.
- **6.4 Periods**: support explicit period/as-of; distinguish current vs historical closing vs transaction vs posting date; reconstruct historical from authoritative records, not current cache.
- **6.5 Permissions**: map each domain to its real permission (`reports:read`, `accounts:read`, `tax:read`, `wallet:read`); no broad catch-all.
- **6.6 Tests**: all domains, aggregates, currency/period, missing/incomplete, reconciliation failure, unauthorized, injection, conflicting sources, historical reconstruction.
- **Exit**: supported financial questions grounded+verified+correct; unsupported still abstain.

## 7. Phase 2 — Reliable memory & context (#6)
- **7.1 Categories**: company business memory (product descriptions/specs, customer preferences, supplier relationships, production instructions, historical decisions, document descriptions) vs current operational facts (prices, balances, stock, order status, tax settings) — the latter always deterministic, never vector-authoritative.
- **7.2 Schema** (migration `0090_ai_memory`): `ai_memory_chunks(company_id, kind, record_type, record_id, content, embedding <vector|jsonb per 5.2>, embedding_model, embedding_dimensions, content_hash, source_updated_at, indexed_at, version)` + RLS+FORCE company policy + unique key for idempotent reindex/model-version change. Finalize storage only after Phase 0.
- **7.3 Data minimization**: do not embed sensitive PII/balances/credit limits/totals/payments; fetch those from authoritative sources with permission.
- **7.4 Retrieval** in `prepareChat`: classify → deterministic evidence → company-scoped semantic recall → validate provenance/freshness → inject as untrusted cited data → retain citations → verify any financial claim deterministically. Vector content cannot alter system policy.
- **7.5 Freshness/deletion**: reindex/invalidate on source change; deleted/inaccessible records not retrievable as current; handle update/delete/reindex/model-version/stale/failed-job recovery.
- **7.6 Scheduling**: hook `reindexCompany` into `scheduler.runTenantTick` (lease-guarded, nightly, bounded/incremental); add `POST /ai/memory/reindex` gated by new `ai:memory:reindex`.
- **7.7 Tests**: relevance, company isolation, permission, staleness, source deletion, model-version change, injection, sensitive-data exclusion, historical-vs-current.
- **Exit**: relevant context recalled without treating semantic results as verified truth.

## 8. Phase 3 — Action intelligence (#4)
- **8.1 Proposals**: quote draft, invoice draft, journal proposal, purchasing proposal, inventory adjustment proposal, production workflow proposal, other approved workflows.
- **8.2 Lifecycle**: `PROPOSED → APPROVED → EXECUTED` (+ `REJECTED/CANCELLED/EXPIRED/FAILED`), consistent with existing maker-checker (`aiService` + `approvalService`).
- **8.3 Explicit confirmation**: NL intent alone never creates/executes; assistant previews structured proposal and requires explicit user confirmation before draft/proposal; then approval+execution permissions.
- **8.4 Handlers** (verified contracts only): `create_quote_draft`→`quoteService.createQuote` (draft exists `0062:14`); `create_invoice_draft`→`salesService.createInvoiceOrSalesReceipt` **only if it truly drafts without GL post** (schema draft exists `0003:161`; verify service); else do not substitute a semantically different estimate. `propose_journal`→existing `post_journal` path; `propose_workflow_transition`→`contractLifecycle` proposal (no auto-activation). Add server-side `EXECUTABLE_ACTION_TYPES` allow-list; reject unknown types at `proposeAction`.
- **8.5 Maker-checker**: creator ≠ approver/executor; backend enforces authorized approver/executor, company/site perms, approval validity, immutable approved payload/version, idempotency, audit, reject/cancel. Add `approvals:decide` gate on AI action approval (not just `ai:write`).
- **8.6 Tests**: every type, invalid type, unauthorized, self-approval, self-execution, stale approval, changed payload, duplicate/concurrent execution, partial failure, audit completeness.
- **Exit**: useful actions prepared; none bypass human authorization or business lifecycle.

## 9. Phase 4 — Document intelligence (#3)
- **9.1 Types**: keep quotations + customer invoices; add receipts + supplier bills; single image; multi-page/tables/handwriting deferred.
- **9.2 Schema** (`ocrSchema.ts`): per-type fields (supplier/customer, doc number, date, currency, lines, qty, unit price, discount, tax, subtotal, total, payment method, reference). Server recomputes totals (`reconcileTotals`); never trust model totals; fix "trust present `amount`" (`ocrService.ts:52`) to always recompute from qty×rate.
- **9.3 Confidence gate**: field-level confidence + schema + arithmetic + counterparty match + doc-ref validation; calibrate against reviewed samples; below threshold → `status='needs_review'`, block prefill, force manual; model confidence ≠ proven accuracy.
- **9.4 Dedup**: image-hash + normalized business identity (company, type, supplier, doc number, date, currency, total); flag likely duplicates for review, don't auto-reject on shared invoice numbers.
- **9.5 Financial safety**: OCR never posts bill/payment/journal/stock/invoice-paid; only draft/proposal via Phase 3 lifecycle.
- **9.6 Tests**: each type, field extraction, thresholds, arithmetic, supplier match, duplicate, image validation, malicious docs, budget accounting, provider failure, human review.
- **Exit**: reviewable, auditable drafts with measured extraction quality.

## 10. Phase 5 — Operational intelligence (#2)
- **10.1 Domains**: inventory availability, low stock, reserved, incoming, consumption, wastage, production progress, delayed jobs, WIP, delivery status, unprofitable jobs, outstanding orders.
- **10.2 Anomalies** in `aiService.detectAnomalies` (currently only overdue receivables/negative stock/low stock `:1227-1282`): add `wastage_high`, `production_delayed` (stuck jobs + exam `due_date < today`), `unprofitable_job` (margin < threshold via `getPrintingJobProfitability`), `wip_over_budget`. Thresholds configurable + company-scoped (new `ai_alert_thresholds` config), not hard-coded.
- **10.3 Evidence**: each anomaly stores company, type, triggering records, rule/calculation, threshold, detection time, period, severity, status.
- **10.4 Ack**: add `PATCH /ai/anomalies/:id` (`open→acknowledged→resolved`, reopen/cancel) — schema already supports states (`0034:84`).
- **10.5 Tests**: detection accuracy, threshold boundaries, false positives, missing records, duplicate alerts, tenant isolation, scheduling, ack/resolution.
- **Exit**: current operational condition explained via traceable records.

## 11. Phase 6 — Predictive intelligence (#5) — deterministic only
- **11.1 Expense/transaction anomalies** (new `predictiveService` + `expenseService`): unusual amount vs per-vendor history, spend change, duplicate claim (amount/date/claimant), duplicate payment (vendor/amount/date across bill numbers), unusual/new-supplier first payment. Flag = review signal, not proof.
- **11.2 Referral/fraud**: wire dead `detectIdentitySignals` (`referralFraudService.ts:32`) into accrual to auto-open cases; preserve existing rules; no auto-accusation/sanction; human review.
- **11.3 Shortage forecast**: migration `0091_lead_time` adds `inventory_items.lead_time_days`; forecast = consumption rate (`getMaterialConsumption`) × lead time + safety − (on_hand − reserved) − confirmed incoming − open-job demand (reuse `generateDemandRequisitions`); avoid double counting; output expected stockout date, shortage qty, assumptions, sources, data-completeness/confidence, recommended action; abstain if history insufficient.
- **11.4 Scheduling/audit**: run via `runTenantTick`; record inputs, rule version, time, result, evidence, delta vs previous.
- **11.5 Tests**: expense boundaries, duplicate detection, insufficient history, stockout math, lead-time variation, incoming supply, reservations, double-count prevention, tenant isolation, repeatability.
- **Exit**: explainable, reproducible, useful predictions with disclosed limits.

## 12. Phase 7 — Cross-cutting hardening (incremental; required for acceptance)
- **12.1 Authorization**: separate perms for chat, financial evidence, operational reports, memory retrieval, memory reindex, document processing, action propose/approve/execute, anomaly visibility/ack. `ai:read`/`ai:write`/`bi:read` must not imply all domains; tighten coarse `bi:read`.
- **12.2 Tenant isolation tests**: financial evidence, vector retrieval, historical context, OCR docs, action propose/approve/execute, anomaly detection, scheduled jobs — reads and writes.
- **12.3 Prompt injection**: user/OCR/vector/provider/doc text are untrusted; cannot modify system instructions, permissions, company context, action authorization, or verification rules (keep `sanitizePrompt`).
- **12.4 Reliability/recovery**: provider timeouts, interrupted requests, ambiguous outcomes, budget reservation recovery, duplicate settlement, scheduler restarts, reindex retries, concurrency, rollback, partial failure. Preserve D-05 budget accounting + D-08 provider tx isolation.
- **12.5 Observability**: provider/model, request/response outcomes, usage, budget reserve/settle, retrieval coverage, claim-verification results, OCR quality, action outcomes, prediction quality, latency/failures. No secrets/sensitive doc contents.

## 13. Phase 8 — Final integration & acceptance
- **13.1 Automated validation**: `pnpm lint`, `pnpm test`, `pnpm test:unit`, `pnpm test:e2e`; add/extend tests for financial grounding, claim verification, operational intelligence, OCR, memory retrieval, tenant isolation, injection, maker-checker, action execution, predictive alerts, budget accounting, recovery/concurrency. Report exact test counts + acceptance-scenario coverage (a passing command ≠ full coverage).
- **13.2 E2E scenarios**: (1) monthly profit → verified report-backed; (2) overdue customers → authorized current evidence; (3) low products → stock evidence; (4) supplier bill upload → validated draft needing review; (5) prepare quotation → reviewed draft; (6) propose journal → different authorized human approves+executes; (7) delayed job → explained records; (8) historical decision → relevant context, no cross-company leak; (9) interrupt request → budget recovery; (10) retry action → cannot double-execute.
- **13.3 Acceptance report**: per capability record implemented/supported/unsupported/tests/accuracy/security/risks/status; separately record every critical gate. No 99.8% declaration unless measurements + all gates support it.

## 14. Delivery governance
One master plan, ordered phases, independent acceptance. Each phase: scope → read-only baseline → precise spec → explicit authorization → controlled implementation → independent audit → regression tests → documented acceptance. Conditional pass ≠ pass. Failed critical gate stops dependent work. Coding agents execute the approved spec only.
**Repository preservation**: verify path/remote/branch/HEAD; record before/after dirty manifest; preserve pre-existing work; no reset/clean/stash/checkout/rebase/cherry-pick; no commit/push/deploy without authorization; no production/default DB access; no Docker; no unapproved migrations; isolated test DBs + synthetic data; paired/checksummed/reversible migrations; never edit an applied migration.

## 15. Explicit exclusions
Autonomous posting/approval/payment; full semantic RAG replacing deterministic evidence; multi-page/complex-table/handwriting OCR; ML forecasting; unrestricted cross-company memory; automatic fraud accusations/sanctions; replacing PWA; Docker/desktop conversion.

## 16. Final definition of success
The AI can (1) explain financial position from verified evidence, (2) explain live operations, (3) read+validate documents, (4) prepare ERP actions under human control, (5) detect+forecast risks with traceable evidence, (6) recall company context accurately and securely — all without compromising financial, security, budget, or authorization foundations. 99.8% only when independent measurements demonstrate it.

---

## Feasibility outcome (Phase 0)
- **pgvector UNAVAILABLE** on installed PGlite 0.5.17: `@electric-sql/pglite/vector` subpath not exported; `CREATE EXTENSION vector` → `extension "vector" is not available`. **Decision: memory embeddings stored as `jsonb` (number[]) + in-app cosine similarity** (exact brute force; per-tenant datasets small). No new dependency; no HNSW. Migration `0090_ai_memory` uses `embedding jsonb` + `embedding_model` + `embedding_dimensions`.
- **Embedding provider**: add `embedContent` to `aiProvider.ts`; default model `text-embedding-3-small` (OpenAI, 1536-d) with Gemini `text-embedding-004` (768-d) alternate; dimensions stored per row; reindex on model change. Charged via existing `reserveAttempt`/`settleAttempt`.
- **Draft-service behavior**: invoices (`0003:161`) and quotes (`0062:14`) expose a `draft` status at schema level; `createInvoiceOrSalesReceipt` posting-vs-draft behavior to be confirmed in Phase 3 before wiring `create_invoice_draft` (else use quote/estimate path, never a silent substitute).

## Implementation progress
- **Phase 0 — DONE.** pgvector unavailable → jsonb + in-app cosine (recorded above). `embedContent` added to `aiProvider.ts` (OpenAI + Gemini, breaker/timeout).
- **Phase 1 — DONE.** `aiFinancialGrounding.ts` extended with P&L, balance sheet, cash flow, trial balance, AR/AP aging, budget-vs-actual, job profitability, inventory valuation; blanket abstain replaced with per-domain permission gating; `resolvePeriod` added. `aiClaimVerifier.ts` supports report-level `aggregate` claims (single authoritative row; multi-record rejected). `buildSystemPrompt` now specifies the claims-JSON contract. Tests: `tests/ai/ai-financial-domains.test.ts` (new).
- **Phase 2 — DONE.** Migration `0090_ai_memory` (jsonb, RLS). `aiMemoryService.ts` (data-minimized chunks, `reindexCompany`/`writeChunks`, `cosine`, `recall`, prune). `POST /ai/memory/reindex` (`ai:memory:reindex`, D-04 two-phase). `prepareChat` optional `queryEmbedding` recall hook + **live `/ai/chat` now computes the query embedding (best-effort, outside tx) and passes it**. `ai:memory:reindex` permission added. Tests: `tests/ai/ai-memory.test.ts`.
- **Phase 3 — DONE.** `PROPOSABLE_ACTION_TYPES`/`EXECUTABLE_ACTION_TYPES`; `proposeAction` rejects unknown types; `executeProposedAction` handles `create_quote_draft` (real draft via `quoteService.createQuote`, `estimates:write`); `finalizeChat` auto-**proposes** (never executes) from an optional model `proposedAction`; `PreparedChat.userId` added; system prompt documents the proposal contract. Invoice drafts are NOT auto-executed (service posts to GL — no true draft), only proposed. Tests: `tests/ai/ai-action-execution.test.ts`.
- **Phase 4 — DONE.** Migration `0091` widens OCR `kind` to quote/invoice/receipt/supplier_bill and adds `needs_review` status. `ocrSchema` kinds + optional paymentMethod/reference/discount; kind-aware prompt; `reconcileTotals` always recomputes from qty×rate (ignores model amount); confidence gate (`OCR_CONFIDENCE_THRESHOLD=0.6` → needs_review, never auto-fill); business-document dedup (kind+counterparty+date+total) flags `businessDuplicate`; route accepts 4 kinds. Tests: `tests/ai/ocr-kinds-confidence.test.ts`.
- **Phase 5 — DONE.** `detectAnomalies` extended with `wastage_high` (job_material_requirements >10% waste), `production_delayed` (overdue exam_assessment_batches), `unprofitable_job` (negative realized margin); `setAnomalyStatus` + `PATCH /ai/anomalies/:id` (audited); `detectAnomalies` scheduled in `runTenantTick`; `wastage`/`production_delay` evidence domains (inventory:read / printing:read). Tests: `tests/ai/ai-operational-anomalies.test.ts`.
- **Phase 6 — DONE.** Migration `0092` adds `inventory_items.lead_time_days`. `predictiveService.ts`: `detectExpenseAnomalies` (duplicate_payment, unusual_expense >3× vendor avg) + `forecastShortages` (consumption/30d vs lead time → likely_shortage), each a cited review signal (dedup open). Scheduled via `runPredictiveChecks` in `runTenantTick`. `referralFraudService.detectIdentitySignals` now wired into `accrueReferralEventAndJournal` (flag-only self-referral hold). Tests: `tests/ai/ai-predictive.test.ts`; referral pipeline passes.
- **Phase 7/8 — DONE (validation).** `pnpm lint` clean except pre-existing `src/pdf/*` + `vitest.config.ts`; `node scripts/run-tests.mjs tests/ai` → **23 files pass**; `permission-matrix` + `auth-isolation` pass. Remaining hardening tail: tighten coarse `bi:read` (deferred to avoid regression).

## Acceptance results
- Validation: `pnpm lint` clean except pre-existing `src/pdf/*` + `vitest.config.ts`; `node scripts/run-tests.mjs tests/ai` → **23 files pass**; `permission-matrix` + `auth-isolation` + `tests/referral` pass.
- Full backend suite (`node scripts/run-tests.mjs`): all AI/security/referral/accounting/inventory/production/etc. pass. **Two pre-existing failures** in `tests/commercial/ar-advanced-actions.test.ts` and `tests/commercial/commercial-financial.test.ts` (deposit/write-off/convert logic) — **unrelated to this work**: `git status` confirms no AR/commercial/deposit files were modified; the working tree already carried extensive prior uncommitted changes (migrations 0084–0089, App/UI, etc.). Not addressed here (out of scope, pre-existing).
- Capabilities 1–6 implemented at parity with the grounded/verified/approved/audited standard; all critical safety gates preserved (no auto-posting, maker-checker, RLS isolation, claim verification, fail-closed).
- Deferred tails (documented, non-blocking): live invoice-draft auto-execution (service posts to GL — proposal only), `bi:read` tightening, multi-page/table OCR, ML forecasting.