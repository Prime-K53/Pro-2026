# PRIME ERP Existing Actions Audit

**Audit type:** Read-only UI/interaction and capability audit (no source changes).  
**Primary evidence:** `src/components/common/RowActionMenu.tsx`, grep/read results across `src/components/views/*`, `src/App.tsx`, `src/server/routes/salesRoutes.ts`, `src/server/routes/purchasingRoutes.ts`, `src/server/permissions.ts`, `src/types/accounting.ts`, and prior audit summaries.

## 1. Existing Interaction Patterns (Repository Evidence)

| Pattern | Evidence | Assessment |
|---|---|---|
| Shared three-dot row action menu | `src/components/common/RowActionMenu.tsx` (portal dropdown, `MoreHorizontal`, `aria-haspopup="menu"`, per-item `onClick`, `disabled`, `danger`, `dividerBefore`) | **Implemented (shared primitive)**. Lightweight and reused, but not a domain-aware action engine. |
| Per-view action menu adoption | `RowActionMenu` imports/usages found in views including `AllDocumentsView.tsx`, `BankingRegisterView.tsx`, `BillsView.tsx`, `ChartOfAccountsView.tsx`, `CustomersView.tsx`, `ExaminationView.tsx`, `InventoryView.tsx`, `InvoicesView.tsx`, `PayrollView.tsx`, `PrintingContractsView.tsx`, `QuickPrintView.tsx`, `ReportsView.tsx`, `VendorsView.tsx` (grep evidence) | **Implemented (widespread, inconsistent depth)**. Menu contents are defined ad hoc per view/record context. |
| Row click to open/select record | Selection/state patterns observed in sampled views (e.g. selected account/customer/vendor/contract patterns in grep snippets such as `ChartOfAccountsView.tsx`, `CustomersView.tsx`, `PrintingContractsView.tsx`); `onRowClick` not consistently named/found globally | **Partially implemented / UNVERIFIED per module**. Behavior varies by screen and is not standardized. |
| Double-click interactions | No repository-wide evidence of standardized `onDoubleClick` row workflow found in audited search patterns | **Not evidenced / likely missing as standard**. |
| Right-click contextual menus | No standardized `onContextMenu`/context-menu system evidenced | **Not evidenced / likely missing**. |
| Multi-row selection / bulk actions | Checkbox/selection traces observed in some views (e.g. `ReportsView.tsx`, `TaxFormsView.tsx`, `ChartOfAccountsView.tsx`, `BankReconciliationView.tsx` grep hits) | **Partially implemented in isolated screens; UNVERIFIED coverage**. No unified bulk-action framework evidenced. |
| Status-dependent actions | Domain statuses exist (`InvoiceStatus`, estimate/bill/printing/exam/contract statuses in `src/types/accounting.ts`; route/service workflows enforce transitions in backend) but `RowActionMenu` has no status policy abstraction | **Partially implemented (ad hoc UI + backend enforcement)**. |
| Permission-dependent actions | Backend RBAC enforced via `requirePermission` in routes/middleware (`src/server/routes/*.ts`, `src/server/middleware/auth.ts`, `src/server/permissions.ts`); frontend has `useAuth().hasPermission` checks in sampled views | **Partially implemented**. UI gating not guaranteed to be complete/consistent for every action. |
| Confirmation before destructive operations | Modal/form/button-driven confirmations exist in various flows (`UNVERIFIED` exhaustive list); `RowActionMenu` does not provide built-in confirmation metadata | **Partially implemented (ad hoc)**. |
| Audit logging for important operations | Server-side audit infrastructure and operation logging evidenced (`src/server/audit.ts`, middleware cross-company audit, approval/finance services; docs/report claims) | **Implemented on backend for many operations; UNVERIFIED per-action completeness**. |
| Consistent action menus across modules | Each view composes its own `items` arrays; no central registry/grouping conventions enforced | **Not implemented (inconsistent by design today)**. |

## 2. Existing Row Action Menu Capability (Component-Level)

**File:** `src/components/common/RowActionMenu.tsx`

| Capability | Status | Evidence/notes |
|---|---|---|
| Trigger button (three-dot) | Implemented | `MoreHorizontal` icon button with label/`aria-expanded`/`aria-haspopup` |
| Portal rendering & positioning | Implemented | `createPortal(..., document.body)`, viewport-aware open-up/down positioning |
| Click-outside / Escape / scroll-resize close | Implemented | Event listeners in `useEffect` |
| Item model | Implemented (basic) | `{id,label,icon,onClick,disabled,danger,dividerBefore}` |
| Grouping/sections taxonomy | Missing | No group headers/order policy beyond dividers |
| Search/filter actions | Missing | No searchable menu UI |
| Keyboard navigation within items | Partial/Missing | Escape closes; arrow-key/menuitem roving focus not evidenced |
| Status-aware visibility/enabled rules | Missing in component | Must be computed by caller |
| Permission-aware visibility/enabled rules | Missing in component | Must be computed by caller |
| Confirmation/destructive workflow integration | Missing in component | Caller handles dialogs/flows |
| Audit/telemetry hooks | Missing | No built-in instrumentation |
| Bulk/multi-select integration | Missing | Single-row action menu only |

## 3. Module Audit Matrix

Legend: **Yes** = evidenced, **Partial** = some evidence/inconsistent, **No** = not evidenced, **UNVERIFIED** = insufficient evidence in this pass.

| Module | Screen / Component | Row Click | Action Menu (3-dot) | Status Aware | Permission Aware | Audit | Evidence |
|---|---|---|---|---|---|---|---|
| Dashboard | `DashboardView.tsx` | UNVERIFIED | UNVERIFIED | Partial (data-driven widgets) | Partial (backend/UI) | Partial (backend ops) | `src/App.tsx`, dashboard data services |
| Workflow/Home | `HomeWorkflowView.tsx` | N/A/UNVERIFIED | No evidence | N/A | Partial | N/A | `src/App.tsx` |
| Customers | `CustomersView.tsx` | Partial (selection/detail patterns) | Yes | Partial | Partial | Partial | `RowActionMenu` import/usage; `commercialApi` calls |
| Invoices/Sales | `InvoicesView.tsx` | Partial | Yes | Partial (status tabs/filters/actions) | Partial (`hasPermission` checks) | Partial | `RowActionMenu`, tabs/statuses, sales routes/services |
| Estimates/Quotes | `InvoicesView.tsx` (estimates tab), sales domain | Partial | Partial (within sales UI) | Partial | Partial (`estimates:*` perms) | Partial | `commercialApi.list/create estimates`, `salesRoutes.ts` approve/reject/convert |
| Sales Orders | **Not discovered as dedicated module/view** | No evidence | No evidence | No evidence | No evidence | No evidence | No `SalesOrders*` view/route found in sampled inventory; `UNVERIFIED` if embedded elsewhere |
| Job Orders / Production jobs | `QuickPrintView.tsx`, `ExaminationView.tsx`, printing domain | Partial | Yes (printing views) | Partial (job/exam statuses) | Partial | Partial | `printingApi.ts`, `printingRoutes.ts`, types/statuses |
| Production operations | `ExaminationView.tsx`, `PrintingContractsView.tsx` (workflow-adjacent), backend services | UNVERIFIED | Partial | Partial | Partial (`printing:*`) | Partial | `productionService.ts`, `printingWorkflows.ts` |
| Delivery & Dispatch | Printing/delivery domain in backend/types (`UNVERIFIED` dedicated view) | UNVERIFIED | UNVERIFIED | Partial (delivery statuses in schema/types per audit) | Partial | Partial | DB/migration/docs evidence; UI screen `UNVERIFIED` |
| Inventory | `InventoryView.tsx` | Partial | Yes | Partial (stock/type rules) | Partial (`inventory:*`) | Partial | `RowActionMenu`, `commercialApi.update/adjust inventory` |
| Purchase Orders | `BillsView.tsx` (PO/requisition/GR tabs/workflows) | Partial | Yes | Partial (`PO` statuses in routes/services) | Partial (`bills:*`) | Partial | `purchasingRoutes.ts`, `BillsView.tsx` |
| Bills & Expenses | `BillsView.tsx` | Partial | Yes | Partial (open/partial/paid/voided) | Partial | Partial | `purchasingRoutes.ts`, `commercialApi` |
| Vendors | `VendorsView.tsx` | Partial (selection/detail) | Yes | Partial | Partial (`vendors:*`) | Partial | `RowActionMenu`, vendor endpoints |
| Banking | `BankingRegisterView.tsx` | Partial | Yes | Partial | Partial (`banking:*`) | Partial | Banking routes/services |
| Bank Reconciliation | `BankReconciliationView.tsx` | Partial | UNVERIFIED | Partial | Partial (`banking:reconcile`) | Partial | Route/service support evidenced; menu usage `UNVERIFIED` |
| Chart of Accounts | `ChartOfAccountsView.tsx` | Yes/Partial (selected account panel evidenced) | Yes | Partial (active/inactive/account type rules) | Partial (`accounts:*`) | Partial | `RowActionMenu` usage and selection code |
| Journal Entries | Accounting domain (`ChartOfAccountsView.tsx`/modals/routes) | UNVERIFIED | UNVERIFIED | Partial (draft/posted/voided) | Partial (`journals:*`) | Partial | `accountingRoutes.ts`, `JournalEntryModal.tsx`, types |
| Customer Wallet | **Not discovered** | No evidence | No evidence | No evidence | No evidence | No evidence | No wallet tables/types/routes found in inspected project scope |
| Printing Contracts | `PrintingContractsView.tsx` | Partial (selected contract) | Yes | Partial (active/exhausted/cancelled, milestone pending/completed) | Partial (`invoices/printing` perms as applicable) | Partial | `RowActionMenu`, contract/milestone types and flows |
| Referral Management | **Not discovered** | No evidence | No evidence | No evidence | No evidence | No evidence | No referral domain artifacts found in inspected project scope |
| Users & Permissions | `AccessControlView.tsx`, auth/company/user routes | UNVERIFIED | UNVERIFIED | Partial (active/expired/revoked membership states) | Yes (RBAC central) | Partial | `permissions.ts`, `userRoutes.ts`, `authRoutes.ts` |
| Reports | `ReportsView.tsx` | Partial | Yes | N/A/Partial | Partial (`reports:*`) | Partial | `RowActionMenu`, report routes/scheduling |
| Payroll | `PayrollView.tsx` | Partial | Yes | UNVERIFIED | Partial (`payroll:*`, sensitive restrictions) | Partial | `payrollApi.ts`, permissions |
| Tax Forms | `TaxFormsView.tsx` | UNVERIFIED | UNVERIFIED | UNVERIFIED | Partial (`tax:*`) | Partial | View present; details `UNVERIFIED` |
| All Documents | `AllDocumentsView.tsx` | Partial | Yes | Partial (cross-type statuses) | Partial (read/write by source/kind) | Partial | Unified document model, preview/attachment flows |
| Settings | `SettingsView.tsx` | N/A | No evidence | N/A | Partial (`companies:settings:write`) | Partial | Config/admin UI |

## 4. Key Gaps and Risks (Evidence-Based)

| ID | Finding | Classification | Evidence |
|---|---|---|---|
| EA-01 | No reusable, domain-aware contextual action architecture (registry, status/permission policy engine, grouped/searchable menu, confirmation contract) | P1 | `RowActionMenu.tsx` basic API; ad hoc per-view item arrays |
| EA-02 | Action visibility/enabled logic duplicated and inconsistent across views; backend remains authoritative but UX parity is uncertain | P1 | Per-view implementations; `requirePermission`/services on backend |
| EA-03 | No standardized row-click/right-click/bulk-action interaction model across modules | P2 | Mixed patterns; no global framework found |
| EA-04 | Destructive/financial actions rely on ad hoc confirmations; no uniform confirmation/audit metadata contract in UI layer | P0/P1 (financial modules) | Menu component lacks confirmation support; critical ops exist in sales/purchasing/accounting |
| EA-05 | Accessibility/keyboard navigation in action menus likely incomplete (beyond Escape/trigger semantics) | P2/P3 | `RowActionMenu.tsx` implementation |
| EA-06 | Modules referenced by master prompt but not discovered as first-class UI/entities (Sales Orders, Customer Wallet, Referral Management, dedicated Delivery/Dispatch screen) | P1 (gap) / UNVERIFIED | Inventory scan; absence in inspected views/types/routes |

## 5. Audit Conclusion

Prime ERP has a **reusable visual row-menu primitive** and **meaningful backend controls** (RBAC, approvals, audit logging, transactional services), but it does **not** yet implement a unified, status-aware, permission-aware, transaction-safe **Advanced Contextual Actions System**. Existing actions are predominantly **module-local compositions** over `RowActionMenu` and modal/service calls, with uneven interaction consistency and incomplete evidence of standardized bulk/context-menu behavior.
