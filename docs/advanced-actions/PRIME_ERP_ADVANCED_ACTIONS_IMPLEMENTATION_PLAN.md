# PRIME ERP Advanced Actions Implementation Plan

**Status:** Planning document (Phase 1 audit output). **No application source code modified.**  
**Objective:** Implement a unified, secure, status-aware, permission-aware, transaction-aware Advanced Contextual Actions System incrementally, reusing existing Prime ERP services/routes/modals and preserving financial integrity.

## 1. Implementation Principles

- **Reuse before build:** invoke existing `src/services/*` clients, view modals, document preview flows, and backend routes/services; do not duplicate business logic.
- **Authoritative backend:** all authorization, status transitions, period/approval checks, posting rules, and audit logging remain server-enforced.
- **Capability-gated rollout:** expose only actions backed by verified frontend+backend behavior in the current repository.
- **Incremental migration:** introduce shared infrastructure first, then migrate modules in risk-controlled phases with regression tests per phase.
- **Safety first:** financial/inventory/access-control actions require confirmations, idempotency/double-submit protection, and explicit error/approval handling.

## 2. Phased Roadmap

| Phase | Scope | Key deliverables | Dependencies | Primary risks | Verification/regression |
|---|---|---|---|---|---|
| **A. Shared Action Infrastructure** | Core architecture and UI primitives | Action types/contracts, policy evaluator, registry loader, execution pipeline, confirmation handling, idempotency helper, enhanced `AdvancedActionsMenu` (or evolved `RowActionMenu`), adapters for navigation/modals/documents/notifications/refresh | `AuthContext` permissions/role, `AccountingContext` actions/events, existing `RowActionMenu` patterns, API error conventions (`src/services/http.ts`) | Regressing existing menus; over-abstraction; accessibility gaps | Unit tests for evaluator/executor; component tests for menu (a11y, keyboard, grouping); smoke test existing views unchanged when feature-flagged/off |
| **B. Sales & Receivables** | Customers, invoices/sales receipts, payments, credit memos, estimates/quotes, reminders/statements (verified subset) | `customers` and `invoices/estimates` registries; status/permission rules; payment/void/convert/apply-credit confirmations; idempotent mutation wiring; document preview/email/share actions where supported | Phase A; `commercialApi.ts`, `documentsApi.ts`, `salesRoutes.ts`, approval-gated invoice/receive flows | Duplicate payments/invoices, invalid voids, stale balance/status UI, approval-required handling | Integration tests for receive payment, partial payment, void, estimate approve/reject/convert, credit memo apply; backend auth/status rejection cases; AR/audit regression |
| **C. Purchasing & Payables** | Vendors, purchase orders, requisitions, goods receipts, bills, bill payments, vendor credits | Purchasing/vendor registries; PO receive/convert-to-bill actions; bill pay/void/credit application flows; approval and 3-way/receipt safeguards surfaced | Phase A (and patterns from B); `purchasingRoutes.ts`, procurement services, `commercialApi.ts` | Duplicate receipts/bills/payments, quantity/amount mismatches, period/approval violations | Tests for PO receive partial/full, GRN, bill create/pay/void, vendor credit apply; idempotency and approval-gate scenarios |
| **D. Inventory & Production** | Inventory items/BOM/adjustments, quick print, examinations, printing jobs/production operations (verified) | Inventory/printing registries; stock adjustment confirmation+reason; job status transitions; material/production actions mapped to verified endpoints only | Phases A–C patterns; `printingApi.ts`, inventory/production services/routes | Unauthorized stock valuation changes, invalid job transitions, COGS/WIP posting side effects | Tests for adjustments, item updates, job lifecycle transitions, invoice-link generation duplicate prevention; inventory valuation regression checks |
| **E. Dispatch & Delivery** | Delivery notes/dispatch records (only if verified UI+API exposure) | Delivery registry/actions or explicitly defer with gap log | Phase D; verified delivery routes/services/UI | Exposing unverified operations; duplicate delivery confirmation | Validate entity/status API support before enabling; E2E for dispatch/confirm/partial/fail if implemented |
| **F. Accounting & Banking** | Banking register/transactions, reconciliation, chart of accounts, journals, period/approval controls integration | Banking/accounting registries; reconcile/reverse/transfer guards; journal post/reverse safeguards; account deactivation eligibility checks | Phase A; `accountingApi.ts`, banking/finance controls APIs/routes | Posted-ledger corruption, reconciliation lock bypass, period-close violations | Tests for reconcile/reverse, journal post/reverse, period restrictions, COA protections; audit log assertions |
| **G. Specialized Modules** | Printing contracts, assessments, unified documents; **wallet/referral only if verified implementations exist** | Contracts/documents registries; milestone/invoice-link actions; explicit "not available" handling for missing domains | Phases B/D; `documentsApi.ts`, printing/contract services | Duplicate contract invoicing/job generation; inventing wallet/referral behavior | Contract milestone completion/linking tests; document preview/open-source regression; gap verification for wallet/referral |
| **H. Administration & Reporting** | Users/permissions, audit views, settings/admin ops (verified), reports/exports/scheduling, payroll/tax actions where verified | Admin/report registries; sensitive confirmations; export/schedule actions; role/permission change safeguards | Phase A; `user/company/report/finance` APIs, permissions matrix | Privilege escalation, unauthorized exports, accidental deactivation/session issues | RBAC/tenant isolation tests, admin mutation audit tests, report export/schedule regression, accessibility pass |

## 3. Cross-Phase Dependencies and Sequencing Notes

1. **Phase A is mandatory** before module migrations to avoid repeated ad hoc logic.
2. **B before C/F financial expansions** is recommended to harden payment/void/idempotency/approval UX patterns on the most common AR flows.
3. **D depends on verified inventory/production contracts**; do not expose actions without confirmed status machines and posting side effects.
4. **E and G (wallet/referral/sales orders/delivery UI gaps)** require discovery confirmation gates: if not implemented, mark `MISSING/UNVERIFIED` and exclude from rollout.
5. **H must include security regression** for RBAC, tenant isolation, and audit logging on every sensitive action.

## 4. Detailed Work Breakdown (Implementation Backlog)

### A. Shared Infrastructure
- Define action/domain types and normalized permission helpers.
- Build pure evaluator (`visible/enabled/reason/group/order`) with policy tests.
- Implement execution pipeline (pending guard, confirm, idempotency, service call, standardized result handling, refresh).
- Create `AdvancedActionsMenu` UI (groups, dividers, danger zone, search threshold, disabled reasons, keyboard/a11y).
- Add capability registry to suppress unverified actions globally/per module.
- Add instrumentation hooks (optional) without leaking sensitive payloads.

### B–H. Module Migrations (per module template)
- Inventory existing actions and entry points (menu items, buttons, modals, service calls).
- Map each to verified backend operation and record-status rules.
- Implement registry definitions and adapters (no business-rule duplication).
- Replace inline action arrays incrementally behind a feature flag.
- Add confirmations/reasons for destructive-financial-inventory actions.
- Validate refresh behavior and cross-view consistency (list/detail/documents).
- Document unsupported requested actions as gaps, not placeholders.

## 5. Risk Register and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Duplicate financial transactions (double click/retry) | High (P0) | Medium | Idempotency keys, action-level pending locks, server-side duplicate guards, user-visible in-progress states |
| Invalid state transitions exposed in UI | High | Medium | Status-aware evaluator + backend rejection handling + disabled reasons from authoritative state |
| Permission leakage in UI or API misuse | High (P0) | Medium | Central permission checks, hide/disable consistently, mandatory backend RBAC tests, tenant-scope regression |
| Breaking existing workflows during migration | Medium/High | Medium | Feature flags, per-module rollout, preserve legacy menu fallback, regression suite per phase |
| Inventory/COGS/WIP inconsistencies from new actions | High | Medium | Restrict to verified services, require confirmations/reasons, validate posting outcomes and reports |
| Unverified modules implemented prematurely (wallet/referral/sales orders/delivery) | High | Medium | Capability gate + discovery checklist + explicit defer decisions |
| Accessibility regressions in new menu | Medium | Medium | Keyboard/ARIA acceptance criteria, component tests, manual a11y verification |
| Performance issues from policy evaluation/rendering in large tables | Low/Medium | Low | Memoized resolution, lightweight record snapshots, virtualization-compatible trigger rendering |

## 6. Testing Strategy (Required per Phase)

### 6.1 Automated
- **Unit:** action evaluator rules (status/permission/capability), confirmation/idempotency selection, registry integrity.
- **Component:** `AdvancedActionsMenu` interactions (open/close, grouping, search, keyboard nav, disabled/danger states, portal positioning).
- **Integration (frontend):** action execution with mocked adapters/services covering success, validation error, permission denied, conflict/duplicate, approval-required.
- **Backend/API regression (where applicable):** verify existing endpoints enforce status/permission/tenant/idempotency and emit audits for migrated actions.

### 6.2 Manual / E2E (critical paths)
- Receive/partial payment, void invoice, apply credit memo.
- PO receive/partial receive, create/pay/void bill, apply vendor credit.
- Inventory adjustment (reason + audit), printing job lifecycle and invoice generation/linking.
- Bank reconciliation/reversal, journal post/reverse (authorized), period/approval controls.
- User/role changes, report export/schedule, document preview/open-source flows.

### 6.3 Acceptance criteria (per migrated action)
- Menu item appears only when capability exists and policy allows (or is correctly disabled with reason).
- Confirmation shown for configured destructive/financial/inventory operations.
- Backend response is authoritative; UI handles success/error/approval-required deterministically.
- Relevant records/lists refresh and audit trail is created for mutating operations.
- No regression in existing module behavior outside the migrated action set.

## 7. Rollout and Governance

- **Feature flags:** enable by module (`actions.customers`, `actions.invoices`, etc.) for staged rollout and quick rollback.
- **Telemetry/monitoring:** track action invocation, failure/approval rates, and duplicate-prevention hits (privacy-safe).
- **Documentation updates:** maintain action registry docs and status/permission matrix as source-of-truth artifacts when capabilities change.
- **Sign-off gates per phase:** functional verification, security/RBAC review for sensitive domains, financial regression review, and accessibility check.

## 8. Likely Files/Areas to Modify in Future Implementation (No Changes Made Now)

| Area | Likely files |
|---|---|
| Shared action framework/UI | `src/components/common/RowActionMenu.tsx` (evolve/wrap), new `src/components/actions/*`, new `src/actions/*` |
| Context/integration hooks | `src/context/AuthContext.tsx`, `src/context/AccountingContext.tsx`, `src/services/http.ts` (idempotency/header helpers if needed) |
| Sales/AR views | `src/components/views/CustomersView.tsx`, `src/components/views/InvoicesView.tsx`, `src/components/views/AllDocumentsView.tsx` |
| Purchasing/AP views | `src/components/views/BillsView.tsx`, `src/components/views/VendorsView.tsx` |
| Inventory/printing views | `src/components/views/InventoryView.tsx`, `src/components/views/QuickPrintView.tsx`, `src/components/views/ExaminationView.tsx`, `src/components/views/PrintingContractsView.tsx` |
| Banking/accounting/admin/report views | `src/components/views/BankingRegisterView.tsx`, `BankReconciliationView.tsx`, `ChartOfAccountsView.tsx`, `ReportsView.tsx`, `FinanceControlsView.tsx`, `AccessControlView.tsx`, `PayrollView.tsx`, `TaxFormsView.tsx` |
| Client adapters (if needed) | `src/services/commercialApi.ts`, `accountingApi.ts`, `documentsApi.ts`, `printingApi.ts`, `financeControlsApi.ts`, `payrollApi.ts`, `companyApi.ts` |
| Backend (only for verified gaps, with separate approval) | `src/server/routes/*`, `src/server/services/*`, permission/audit tests — **only when required to support a verified missing capability; not part of Phase A UI refactor** |

## 9. Open Decisions / Preconditions

- Confirm authoritative status fields per record in API payloads (some UI states inferred from balances/flags).
- Decide hide-vs-disable policy per permission/state scenario (globally consistent default recommended).
- Validate presence/absence of Sales Orders, Delivery UI, Wallet, and Referral modules before scheduling related implementation.
- Confirm idempotency-key support across all targeted mutating endpoints; add server support only through approved backend changes if gaps are found.

## Phase 2A Progress Update (2026-11-17)

**Status:** **Implemented (opt-in infrastructure, no module migrations).**  
**Scope delivered:** Shared action types/contracts (`src/actions/types.ts`), deterministic eligibility evaluator (`src/actions/evaluateActions.ts`), central in-memory registry (`src/actions/registry.ts`), execution pipeline with confirmation/reason handling and client-side duplicate-submission protection plus compatible idempotency-key helpers (`src/actions/executeAction.ts`, `src/actions/idempotency.ts`), reusable accessible `AdvancedActionsMenu` with grouping/disabled reasons/confirmation dialog (`src/components/actions/AdvancedActionsMenu.tsx`), backward-compatible `RowActionMenu` wrapper preserving legacy API/behavior (`src/components/common/RowActionMenu.tsx`), and opt-in feature flag helpers (`src/config/featureFlags.ts`, `VITE_ADVANCED_ACTIONS`).

**Verification:** `npx tsx tests/advanced-actions/phase2a-advanced-actions.test.ts` **15/15 PASS**; `npm run lint` (`tsc --noEmit`) **PASS**; `npm run build` **PASS**.  
**Constraints honored:** No database/schema/migration changes, no API contract changes, no accounting/financial/inventory/payroll/tax logic changes, no module-specific action menus migrated, backend remains authoritative.  
**Report:** `docs/advanced-actions/PHASE_2A_IMPLEMENTATION_REPORT.md`.

**Known conditions:** No project-level React component test runner found (menu DOM/a11y covered by implementation + build/typecheck, not automated UI tests); backend idempotency is endpoint-dependent (frontend protection/keys do not guarantee server idempotency). Pre-existing repo test-suite status not re-established in this pass.
