# PRIME ERP Advanced Actions Architecture

**Purpose:** Propose a reusable, secure, status-aware, permission-aware, transaction-aware contextual actions architecture that integrates with existing Prime ERP patterns without bypassing business logic.  
**Repository context (evidenced):** React + Vite frontend (`src/components/views/*`), shared UI primitive `src/components/common/RowActionMenu.tsx`, context-driven state (`AuthContext`, `AccountingContext`), frontend API clients (`src/services/*`), Express route/service backend (`src/server/routes/*`, `src/server/services/*`), RBAC (`src/server/permissions.ts`), audit/middleware controls (`src/server/audit.ts`, `src/server/middleware/auth.ts`).

## 1. Design Goals and Constraints

### Goals
- Provide a **single, consistent** contextual actions experience across modules.
- Make actions **record-aware** (entity type/id), **status-aware**, **permission-aware**, and **capability-aware** (only expose operations backed by verified services/APIs).
- Reuse existing modals, service clients, document preview flows, and backend workflows.
- Improve UX (grouping, discoverability, accessibility, confirmations) without changing financial/accounting semantics.
- Centralize policy evaluation for maintainability and testability.

### Non-negotiable constraints (must preserve)
- No bypass of existing backend services, RBAC, tenant isolation, fiscal-period controls, approvals, or audit logging.
- No direct client-side financial posting logic as source of truth; server remains authoritative.
- No deletion/editing of posted ledger records outside approved reversal/void workflows.
- No duplicate/invented capabilities (e.g. wallet/referral engines, sales-order module) unless separately implemented and verified.
- Preserve offline/sync behavior and existing navigation/modal patterns.

## 2. Recommended High-Level Architecture

### 2.1 Layers

1. **Action Definition Layer (declarative metadata + handlers)**
   - Module/record registries define available actions, labels, grouping, icons, prerequisites, confirmations, and execution adapters.
   - Handlers delegate to existing frontend services/context actions/modals (not raw fetch logic in views).

2. **Action Policy/Evaluation Layer (pure, testable)**
   - Computes `visible`, `enabled`, `disabledReason`, and required confirmations from:
     - record snapshot (type, id, status, balances, linkage flags),
     - current user permissions/role/company context,
     - module capability flags (feature/API availability),
     - runtime state (loading, pending mutation, selected company/period context where relevant).
   - Produces a normalized `ResolvedAction[]` for rendering.

3. **Action Execution Layer (command orchestration)**
   - Executes resolved actions through a standard pipeline:
     - pre-check (fresh permission/status where feasible),
     - optional confirmation dialog,
     - idempotency key generation for risk-prone mutations,
     - call existing service/client/modal workflow,
     - standardized success/error handling/toast,
     - cache invalidation/event dispatch (`ACCOUNTING_UPDATED_EVENT` or targeted refresh),
     - optional telemetry/audit-client event.

4. **Presentation Layer (shared UI components)**
   - Reusable contextual menu renderer (enhanced from `RowActionMenu` pattern) with grouping, search, keyboard accessibility, and consistent styling.

5. **Backend Contract Layer (existing, authoritative)**
   - Routes/services continue enforcing auth, tenant scope, permissions, status transitions, approvals, period locks, and audit logging.
   - Frontend must surface backend rejections clearly (409/403/422/approval-required states).

### 2.2 Suggested Frontend Structure (future implementation, additive)

```text
src/components/actions/
  AdvancedActionsMenu.tsx          # Presentational menu (grouped/searchable/accessible)
  AdvancedActionsTrigger.tsx       # Row/button trigger integration wrapper
  ActionConfirmDialog.tsx          # Standard confirmation UI (destructive/financial)
  actionUiTypes.ts                 # View-model types for resolved actions

src/actions/
  types.ts                         # Core contracts (ActionDefinition, ActionContext, etc.)
  evaluateActions.ts               # Pure policy/resolution engine
  executeAction.ts                 # Execution pipeline + idempotency/error normalization
  registry/
    index.ts                       # Registry lookup by module/record type
    customers.actions.ts
    invoices.actions.ts
    estimates.actions.ts
    bills.actions.ts
    purchaseOrders.actions.ts
    vendors.actions.ts
    inventory.actions.ts
    printingContracts.actions.ts
    quickPrint.actions.ts
    examinations.actions.ts
    banking.actions.ts
    chartOfAccounts.actions.ts
    journals.actions.ts           # if/when exposed
    reports.actions.ts
    users.actions.ts
    documents.actions.ts
  adapters/
    navigation.adapter.ts          # setCurrentView/open detail helpers
    documents.adapter.ts           # preview/print/download/share wrappers
    sales.adapter.ts               # commercialApi-backed sales workflows
    purchasing.adapter.ts          # commercialApi-backed AP/procurement workflows
    inventory.adapter.ts           # inventory adjustments/updates
    printing.adapter.ts            # printingApi/workflow actions
```

**Integration principle:** keep existing `RowActionMenu.tsx` usable during migration; either evolve it into `AdvancedActionsMenu` or wrap/replace incrementally per view.

## 3. Core Interfaces (Proposed)

```ts
export type ActionRisk = 'safe' | 'sensitive' | 'financial' | 'inventory' | 'destructive';

export interface ActionContext<TRecord = unknown> {
  moduleKey: string;                 // e.g. 'invoices', 'bills', 'inventory'
  recordType: string;                // e.g. 'invoice', 'vendor', 'printing_contract'
  record: TRecord;
  companyId: string | number | null;
  role?: string | null;
  permissions: Set<string> | string[]; // normalized from AuthContext
  capabilities?: Record<string, boolean>; // verified API/UI capability flags
  selection?: { ids: Array<string | number>; records?: TRecord[] }; // bulk-aware
  now?: Date;
}

export interface ActionConfirmation {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  requireReason?: boolean;           // e.g. void/reverse/adjust stock
  impactSummary?: string;            // financial/inventory/audit impact text
}

export interface ActionDefinition<TRecord = unknown> {
  id: string;                        // stable, namespaced: 'invoice.receive_payment'
  label: string;
  description?: string;
  icon?: React.ComponentType<any> | string;
  group: 'view' | 'quick' | 'process' | 'communication' | 'print_export' | 'admin' | 'danger';
  order?: number;
  risk?: ActionRisk;

  // Capability and policy
  requiredPermissions?: string[];     // all-of by default
  anyPermissions?: string[];         // optional alternative set
  isCapabilityAvailable?: (ctx: ActionContext<TRecord>) => boolean;
  isVisible?: (ctx: ActionContext<TRecord>) => boolean;
  isEnabled?: (ctx: ActionContext<TRecord>) => boolean | { enabled: boolean; reason?: string };

  // UX/behavior
  confirmation?: ActionConfirmation | ((ctx: ActionContext<TRecord>) => ActionConfirmation | null);
  idempotency?: 'none' | 'recommended' | 'required';
  telemetryKey?: string;

  // Execution adapter (must call existing workflows/services/modals)
  execute: (ctx: ActionContext<TRecord>, helpers: ActionExecutionHelpers) => Promise<ActionExecutionResult>;
}

export interface ActionExecutionHelpers {
  navigateTo: (view: string, params?: Record<string, unknown>) => void;
  openModal: (name: string, params?: Record<string, unknown>) => void;
  openDocumentPreview: (...args: any[]) => Promise<void> | void;
  notify: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
  refresh: (scope?: 'record' | 'list' | 'module' | 'global') => Promise<void> | void;
  createIdempotencyKey?: (actionId: string, recordKey: string) => string;
}

export interface ActionExecutionResult {
  status: 'success' | 'noop' | 'cancelled' | 'approval_required' | 'error';
  message?: string;
  approvalRequestId?: string | number;
}
```

**Notes**
- `isVisible/isEnabled` must be deterministic and side-effect free.
- Permission checks in UI use normalized `AuthContext` permissions but never replace backend enforcement.
- `execute` must not embed business-rule forks that contradict server behavior; it orchestrates verified operations.

## 4. Action Resolution and Execution Flow

1. **View provides record context** (row/menu trigger) with `moduleKey`, `recordType`, and minimal record snapshot.
2. **Registry lookup** returns candidate `ActionDefinition[]` for the record type/module.
3. **Policy evaluation** (`evaluateActions`) filters/sorts and annotates actions:
   - hide unavailable capabilities or unauthorized actions (configurable: hide vs disabled+reason),
   - apply status/balance/linkage rules,
   - attach disabled reasons (e.g. "Invoice is voided", "Insufficient permission: invoices:write").
4. **Menu render** groups actions (`View`, `Quick Actions`, `Process`, `Communication`, `Print & Export`, `More`, `Danger`) and supports search when item count exceeds threshold.
5. **User selects action** -> execution pipeline:
   - guard against double-submit (action-level pending state),
   - confirmation dialog if required (with reason capture for destructive/financial ops),
   - generate/use idempotency key when `recommended|required`,
   - call existing client service/modal/navigation adapter,
   - handle `202 approval_required`/domain errors uniformly,
   - refresh affected data and emit UI notification.
6. **Backend validates and audits**; UI reflects authoritative outcome.

## 5. Status, Permission, and Capability Policy Model

### 5.1 Policy inputs
- **Record state:** status enum, posted/void flags, balances, linked IDs, reconciliation state, period state (if available in record payload).
- **Permissions:** RBAC permissions from `src/server/permissions.ts` exposed to UI session.
- **Capabilities:** verified feature flags/endpoints/services present in this repo (prevents showing "design-only" actions).

### 5.2 Policy rules
- Prefer **hide** for actions the user can never perform due to role restrictions in most contexts; prefer **disabled with reason** for actions blocked by current record state (improves learnability) — configurable per module.
- Destructive/financial actions require explicit confirmation and, where applicable, reason text.
- Bulk actions must evaluate eligibility **per selected record** and return partitioned results (`succeeded`, `skipped`, `failed`) without partial silent success.
- Any action touching posted financials/inventory must route through existing server workflows (void/reverse/adjustment/posting endpoints).

## 6. UX Specification (Contextual Menu)

- **Trigger:** row action button (existing three-dot pattern) and optional row-selection overflow; row-click behavior remains module-specific until standardized.
- **Structure:** grouped sections with separators and sticky group labels when long; destructive actions isolated in `Danger` group.
- **Discoverability:** optional typeahead/search for menus with many actions; show keyboard shortcuts only if actually implemented.
- **Accessibility:** full ARIA menu semantics, roving focus/arrow-key navigation, Enter/Space activation, Escape close, focus return to trigger, portal positioning within viewport.
- **Feedback:** loading state on selected action, disabled reasons via tooltip/inline subtitle, standardized success/error/approval-pending toasts.
- **Consistency:** shared iconography/labels/terminology aligned with existing Prime ERP theme and document/transaction vocabulary.

## 7. Integration with Existing Code (Migration Strategy)

### Phase 1 (infrastructure, no behavior change)
- Introduce types/evaluator/registry scaffolding and `AdvancedActionsMenu` component alongside `RowActionMenu`.
- Add adapters that wrap existing `commercialApi`, `documentsApi`, `printingApi`, `financeControlsApi`, and context modal openers.

### Phase 2 (pilot modules)
- Migrate **Invoices** and **Customers** first (high-value, existing endpoints/actions evidenced).
- Replace ad hoc action arrays with resolved registry actions while preserving current labels/workflows.

### Phase 3 (expand by domain)
- Bills/POs/Vendors -> Inventory/Printing/Contracts/Exams -> Banking/Accounting controls -> Reports/Admin/Documents.
- Standardize confirmations and idempotency handling for financial/inventory operations.

### Phase 4 (cleanup)
- Deprecate duplicated per-view menu logic; keep `RowActionMenu` as thin compatibility wrapper if needed.

**Compatibility:** Views continue to own data fetching and row rendering; only action composition/rendering/execution orchestration is centralized.

## 8. Security, Financial Integrity, and Observability

- **Security:** enforce RBAC and tenant scope server-side on every action endpoint; log cross-company tamper attempts (already evidenced in middleware).
- **Financial controls:** preserve double-entry posting, period locks, approval gates (maker-checker), and immutable posted journals; UI must handle `approvalRequired` responses.
- **Idempotency/double-submit protection:** required for payments, voids, invoice generation/conversion, receipts, delivery confirmations, and bulk operations; propagate idempotency keys where APIs support them.
- **Auditability:** server emits audit logs for mutating operations; client should include correlation metadata where supported and never suppress failure states.
- **Error handling:** normalize API errors (`ApiError`, validation/conflict/permission/approval states) into actionable user messages.

## 9. Testing Architecture Alignment

- **Unit tests:** policy evaluator (status/permission/capability matrices), registry completeness, confirmation/idempotency rules.
- **Component tests:** menu rendering/grouping/search/keyboard accessibility/disabled reasons.
- **Integration tests:** per-module action execution against mocked service adapters and approval/error paths.
- **E2E/regression (future):** critical flows (receive payment, void invoice, pay bill, receive PO/GRN, stock adjustment, post/reverse journal, approval decisions) including audit and refresh behavior.
- **Safety assertion:** a rendered menu item alone is not proof of correct/authorized backend behavior.

## 10. Out-of-Scope / Blocked Until Verified

- Creating new domain engines or records for **Sales Orders (dedicated)**, **Customer Wallet**, or **Referral Management** if not present in verified backend/schema.
- Any action that bypasses existing services, introduces direct ledger edits/deletes, or weakens tenant/permission/audit controls.
- Offline mutation support beyond currently implemented and verified synchronization mechanisms.
