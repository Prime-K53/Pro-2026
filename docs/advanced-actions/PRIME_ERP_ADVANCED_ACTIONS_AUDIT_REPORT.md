# PRIME ERP Advanced Contextual Actions — Audit Report

**Date:** 2026-11-17  
**Repository audited:** `C:\Users\Rhonald Chiwatu\Desktop\Projects\Printing System`  
**Audit mode:** Read-only (repository discovery, analysis, design/documentation). **No application source code, schema, migrations, or database records were modified.**  
**Requested source document:** `PRIME_ERP_ADVANCED_ACTIONS_ARCHITECTURE.md` was **not present** in the workspace; this audit produces that architecture document and companion deliverables in `docs/advanced-actions/`.

## 1. Executive Summary

Prime ERP contains substantial domain coverage (sales/AR, purchasing/AP, banking, accounting, inventory, printing production/contracts/exams, documents, payroll/tax/admin/reporting surfaces) and meaningful backend controls (RBAC permissions, auth/tenant middleware, transactional services, approvals/period controls, audit infrastructure). However, it does **not** currently provide a unified, enterprise-grade **Advanced Contextual Actions System**.

Current row interactions rely on a **basic shared `RowActionMenu` primitive** (`src/components/common/RowActionMenu.tsx`) composed ad hoc per view. There is **no centralized action registry**, no consistent status/permission/capability policy engine, limited standardized confirmation/keyboard/bulk behavior, and uneven UX consistency. Backend capabilities are stronger than frontend orchestration, but action exposure must remain strictly aligned with verified workflows to protect financial and operational integrity.

This audit delivers module inventory, existing-actions audit, advanced-actions recommendations, status/permission eligibility rules, target architecture, and a phased implementation plan to introduce contextual actions safely.

## 2. Discovery Summary

| Metric | Count | Basis |
|---|---:|---|
| Frontend view modules discovered (`src/components/views`) | 20 | Directory inventory (`App.tsx` routes/views) |
| Backend route modules discovered (`src/server/routes`) | 16 | Directory inventory |
| Frontend API/service clients discovered (`src/services`) | 9 | Directory inventory |
| Backend service modules discovered (`src/server/services`) | 25 | Directory inventory (sampled in detail) |
| Shared action-menu component | 1 | `src/components/common/RowActionMenu.tsx` |
| Views with evidenced `RowActionMenu` usage | 13+ | Grep/import evidence (see existing actions audit) |
| Database migrations discovered | 16 versioned pairs (`0001`–`0016`) | `db/migrations/*` |
| RBAC roles defined | 5 | `src/server/permissions.ts` |
| Documented/typed record families (high-level) | 20+ | Types, routes, services, migrations (invoices, estimates, payments, credit memos, customers, vendors, bills, bill payments, vendor credits, POs/requisitions/GRNs, accounts/journals/periods, bank txns/reconciliations, inventory/BOM, printing jobs/exams/contracts/milestones, approvals/close tasks, documents/attachments, payroll entities; `UNVERIFIED` completeness) |

## 3. Existing Contextual Menus and Advanced Actions

| Area | Finding | Evidence |
|---|---|---|
| Existing contextual menus | Shared three-dot dropdown menu implemented and reused across multiple modules | `src/components/common/RowActionMenu.tsx`; view imports/usages |
| Existing advanced actions | **Partial/ad hoc only**: per-view actions wired to modals/services (e.g. view/preview/edit-like flows, payments, invoice/bill operations, inventory/document actions) vary by module | Sampled views (`CustomersView`, `InvoicesView`, `BillsView`, `VendorsView`, `InventoryView`, `AllDocumentsView`, etc.), `commercialApi.ts`, routes |
| Row click behavior | Inconsistent/partially evidenced (selection/detail in some screens) | Grep/read samples |
| Right-click menus | Not evidenced as a standard capability | Repository search |
| Bulk actions | Isolated evidence (checkbox/selection traces) but no unified framework | `ReportsView`, `TaxFormsView`, `BankReconciliationView`, `ChartOfAccountsView` traces |
| Status-aware behavior | Present in domain/backend and some UI logic; not centralized | Types, routes/services, per-view conditionals |
| Permission-aware behavior | Backend RBAC enforced; frontend checks exist but consistency unverified | `permissions.ts`, `middleware/auth.ts`, `hasPermission` usage |
| Audit logging | Backend audit mechanisms and mutating-operation logging evidenced | `audit.ts`, middleware/services, docs |

## 4. Missing, Duplicate, and Unsafe Actions

### Missing / gap areas (high relevance)
- **Unified action registry/policy engine** (status, permission, capability, confirmation, grouping, search, keyboard model). **P1**
- **Standardized bulk contextual actions** with per-record validation and partial-failure reporting. **P2**
- **Dedicated modules/capabilities requested but not discovered/verified:** Sales Orders UI/entity workflow, Customer Wallet, Referral Management, dedicated Delivery & Dispatch UI (backend/domain traces may exist; UI/end-to-end unverified). **P1 gaps / UNVERIFIED**
- Consistent action coverage for revisions/version history, refunds, some deactivate/archive/export paths where APIs/UI are not fully verified. **P2/UNVERIFIED**

### Duplicate actions
- No systemic duplicate engine found; **risk of duplicated logic** exists because actions are reimplemented per view (similar labels/flows with divergent guards). **P2**

### Unsafe actions (must not be offered)
- Direct delete/edit of posted financial transactions or historical ledger entries. **P0**
- Bypassing approvals, period locks, tenant/RBAC checks, or audit logging. **P0**
- Direct unauthorized inventory quantity/valuation manipulation outside approved adjustment/posting workflows. **P0/P1**
- Uncontrolled void/reversal/payment/receipt operations without confirmation, idempotency, and server validation. **P0**

## 5. Backend Capability, Permission, Status, and UX Gaps

| Gap category | Findings | Priority |
|---|---|---|
| Backend capability gaps | Some requested actions lack verified endpoints/workflows (wallet, referrals, sales-order-specific operations, certain delivery/bulk/refund flows). `UNVERIFIED` where not traced end-to-end. | P1/P2 |
| Permission gaps (UX/process) | Central RBAC exists, but UI action gating/disabled reasons are not uniformly derived from a single policy source; risk of inconsistent exposure (backend still blocks). | P1 |
| Status-management gaps | Rich statuses exist, but transition-aware action eligibility is not centralized in UI; stale client state can present invalid actions until backend rejects. | P1 |
| UX inconsistencies | Ad hoc menu contents/order/grouping/labels/icons/confirmations; limited accessibility features in menu; no global search/right-click/bulk interaction model. | P2/P3 |
| Financial integrity risks | High-impact operations (payments, voids, receipts, conversions, posting, reconciliation, stock adjustments) require stricter uniform confirmation/idempotency/feedback patterns in UI orchestration. | P0/P1 |

## 6. Recommended Architecture (Summary)

Adopt an additive, layered design:
1. **Declarative action registries** per module/record type (metadata + adapters to existing services/modals).
2. **Pure policy evaluator** resolving visibility/enabled/disabled reasons from status, permissions, and verified capabilities.
3. **Execution pipeline** with double-submit guard, confirmations/reason capture, idempotency keys, standardized error/approval handling, and scoped refresh.
4. **Enhanced accessible menu UI** (grouped, searchable when needed, keyboard/ARIA compliant, danger isolation) evolved from `RowActionMenu`.
5. **Backend remains authoritative** for auth, tenant isolation, transitions, approvals, period controls, posting, and audit.

See: `docs/advanced-actions/PRIME_ERP_ADVANCED_ACTIONS_ARCHITECTURE.md`.

## 7. Priority Classification

| Priority | Items |
|---|---|
| **P0 — Critical financial/security risk** | Prevent posted-ledger delete/edit; enforce confirmation+idempotency+audit for payments/voids/reversals/receipts/reconciliation/stock adjustments; maintain RBAC/tenant/approval/period enforcement; block unsafe actions. |
| **P1 — Essential operational functionality** | Unified action framework; status/permission-aware registries for core AR/AP/inventory/printing/accounting flows; verified receive/pay/convert/receive-goods/job lifecycle actions; admin/report access controls. |
| **P2 — Advanced productivity feature** | Bulk actions, exports/scheduling integrations, cross-record navigation/history, consistent communication/print/download actions, module gap closures where verified. |
| **P3 — Convenience and UX enhancement** | Menu search polish, icon/label harmonization, shortcuts (if implemented), non-critical quick actions and layout refinements. |

## 8. Implementation Roadmap (Recommended Safe Sequence)

1. **Phase A — Shared Action Infrastructure:** contracts, evaluator, executor, menu/a11y, adapters, feature flags.
2. **Phase B — Sales & Receivables:** customers, invoices/receipts, payments, credit memos, estimates.
3. **Phase C — Purchasing & Payables:** vendors, POs/requisitions/GRNs, bills, payments, vendor credits.
4. **Phase D — Inventory & Production:** inventory/BOM/adjustments, quick print, exams/jobs/production (verified).
5. **Phase E — Dispatch & Delivery:** only for verified UI/API workflows.
6. **Phase F — Accounting & Banking:** banking/reconciliation, COA, journals, approvals/period controls.
7. **Phase G — Specialized Modules:** printing contracts, documents; wallet/referral only if verified.
8. **H — Administration & Reporting:** users/permissions, payroll/tax/reporting/admin ops (verified).

Each phase requires verification and regression testing before rollout.

## 9. Testing Strategy (Summary)

- **Unit/component:** policy evaluator, registry rules, menu accessibility/keyboard/grouping, confirmation and idempotency behavior.
- **Integration:** per-action execution with mocked/real adapters covering success, permission denial, invalid status, conflicts/duplicates, and approval-required responses.
- **E2E/regression:** critical AR/AP/inventory/production/banking/accounting/admin flows; audit-log and refresh verification.
- **Non-functional/safety:** double-submit prevention, tenant/RBAC enforcement, fiscal-period and approval gates, responsive behavior.
- **Rule:** rendering an action does **not** constitute implementation correctness.

## 10. Files Likely to Require Modification During Future Implementation

**Frontend (additive/evolution):** `src/components/common/RowActionMenu.tsx`, new `src/components/actions/*`, new `src/actions/*`, selected views in `src/components/views/*` (Customers, Invoices, Bills, Vendors, Inventory, QuickPrint, Examination, PrintingContracts, BankingRegister, BankReconciliation, ChartOfAccounts, Reports, FinanceControls, AccessControl, Payroll, TaxForms, AllDocuments), `src/context/AuthContext.tsx`, `src/context/AccountingContext.tsx`, and service adapters in `src/services/*` as needed.  
**Backend (only if verified gaps require):** targeted `src/server/routes/*` or `src/server/services/*` changes under separate controlled approval; **no backend changes required for Phase A UI architecture scaffolding**.

## 11. High-Risk Financial/Security Concerns

- **P0:** Any future action exposing posted-transaction mutation/deletion, bypassing approvals/period locks, or missing idempotency on payments/voids/conversions/receipts can compromise ledger integrity.
- **P0:** Privilege/tenant-boundary regressions in action exposure or endpoint handling (UI must not be trusted; server controls must hold).
- **P1:** Stock adjustment and production/invoicing linkage actions can create valuation/COGS/WIP discrepancies if not routed through verified transactional services with audit and confirmations.
- **P1:** Inconsistent permission/status gating can cause operational errors and user distrust even when backend rejects invalid requests.

## 12. Areas with Insufficient Repository Evidence (UNVERIFIED)

- Complete, per-screen row-click/double-click/context-menu behavior and all bulk-selection flows.
- Full endpoint-level behavior matrix for every route/service (audit sampled key domains; exhaustive tracing not completed in this pass).
- Dedicated, end-to-end implemented modules for **Sales Orders**, **Customer Wallet**, **Referral Management**, and fully exposed **Delivery & Dispatch** UI workflows.
- Offline transaction/sync support for contextual actions (project-level offline mechanism not evidenced in inspected source).
- Some edit/duplicate/deactivate/archive/refund/revision capabilities where UI intent or backend support was not conclusively verified.

## 13. Deliverables Created

Created in `docs/advanced-actions/`:
1. `PRIME_ERP_MODULE_INVENTORY.md`
2. `PRIME_ERP_EXISTING_ACTIONS_AUDIT.md`
3. `PRIME_ERP_ADVANCED_ACTIONS_MATRIX.md`
4. `PRIME_ERP_ACTION_STATUS_PERMISSION_MATRIX.md`
5. `PRIME_ERP_ADVANCED_ACTIONS_ARCHITECTURE.md`
6. `PRIME_ERP_ADVANCED_ACTIONS_IMPLEMENTATION_PLAN.md`
7. `PRIME_ERP_ADVANCED_ACTIONS_AUDIT_REPORT.md`

## 14. Verification and Completion Statement

- **No application source files were modified** during this audit/documentation task.
- **No database schemas, migrations, or records were modified.**
- Documentation was produced from repository evidence available in this workspace; verified findings and recommendations are distinguished, and unverified items are explicitly labeled.
