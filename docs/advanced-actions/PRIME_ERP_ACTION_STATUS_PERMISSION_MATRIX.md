# PRIME ERP Action Status and Permission Matrix

**Purpose:** Define eligibility rules for contextual actions based on actual/observed record states, RBAC permissions, backend validation, and financial/inventory safety controls.  
**Evidence:** `src/types/accounting.ts`, `src/server/permissions.ts`, `src/server/routes/salesRoutes.ts`, `src/server/routes/purchasingRoutes.ts`, `src/server/middleware/auth.ts`, `db/migrations/*` (statuses/constraints), and service audit findings.  
**Note:** Where exact status enums/endpoints are not fully verified per record subtype, entries are marked `UNVERIFIED` and must be validated before implementation.

## 1. Status Lifecycles (Discovered/Evidenced)

| Record type | Statuses/lifecycle (evidenced) | Source |
|---|---|---|
| Invoice | `draft`, `sent`, `partial`, `paid`, `overdue` (type); `voided` handled in routes/services | `src/types/accounting.ts`, `salesRoutes.ts` |
| Estimate | `pending`, `accepted`, `rejected`, `invoiced` | `src/types/accounting.ts`, sales services/routes |
| Bill | `open`, `partial`, `paid`, `overdue`; `voided` supported in service/route flows | `src/types/accounting.ts`, purchasing routes/services |
| Payment (customer/bill) | `is_voided` flag semantics (multi-state enum not primary) | DB/types/services (audit evidence) |
| Credit memo / vendor credit | `open`, `applied`, `voided` | Migrations/services audit evidence |
| Purchase order | `draft`, `open`, `partially_received`, `closed`, `cancelled` | Migrations/services audit evidence |
| Purchase requisition | `draft`, `submitted`, `approved`, `rejected`, `converted`, `cancelled` | Migration/service audit evidence |
| Goods receipt | `received`, `voided` | Migration/service audit evidence |
| Printing contract | `active`, `exhausted`, `cancelled` | `src/types/accounting.ts`, migrations |
| Contract assessment milestone | `pending`, `completed` | `src/types/accounting.ts`, migrations |
| Exam paper | `queued`, `printing`, `completed`, `invoiced` | `src/types/accounting.ts`, migrations |
| Printing job | `draft`, `budget_approved`, `queued`, `in_production`, `finishing`, `qc_pending`, `ready`, `partial_delivery`, `delivered`, `completed`, `cancelled` | Migrations/services/types audit |
| Journal transaction | `draft`, `posted`, `voided` (+ immutable posted controls) | Migrations/accounting engine audit |
| Fiscal period | `open`, `soft_closed`, `closed` | Migrations/accounting audit |
| Approval request | `pending`, `approved`, `rejected`, `cancelled` | Finance controls/approval audit |
| Bank reconciliation | `completed`, `reversed` (and completion state fields) | Banking migrations/services audit |
| Delivery note | `prepared`, `in_transit`, `delivered`, `partial`, `cancelled` | Migrations/docs audit (`UNVERIFIED` UI exposure) |

## 2. Role/Permission Baseline (RBAC)

**Roles:** `Administrator`, `Bookkeeper`, `Accountant`, `ProductionManager`, `Read-Only` (`src/server/permissions.ts`).

| Domain | Key permissions (examples) | Notes |
|---|---|---|
| Customers/AR | `customers:read/write`, `invoices:read/write`, `estimates:read/read_costs/write` | Estimate cost visibility restricted for some roles |
| Vendors/AP | `vendors:read/write`, `bills:read/write` | PO/requisition/GR flows currently gated under bills permissions in routes |
| Banking | `banking:read/write`, `banking:reconcile` | Reconciliation is sensitive financial operation |
| Accounting | `accounts:read/write/rebuild`, `journals:read/write`, `periods:read/close/reopen`, `approvals:*` | Posted ledger protections must remain server-enforced |
| Inventory/Printing | `inventory:read/write`, `printing:read/write`, `attachments:read/write` | Material/production actions can affect stock and WIP/COGS |
| Payroll/HR/Admin | `employees:*`, `payroll:*`, `users:*`, `companies:settings:write`, `audit:read` | Sensitive data redaction and admin separation apply |
| Reporting | `reports:read/export`, `reports:schedule` | Export/scheduling may have compliance implications |

**Rule:** UI visibility must follow permissions, but **backend authorization/validation is authoritative** (`requirePermission`, service guards, tenant checks).

## 3. Action Eligibility Matrix (Representative, High-Value Records)

| Record type | Action | Eligible statuses | Required permission(s) | UI visibility condition | Backend validation required | Financial impact | Inventory impact | Audit required | Offline compatible | Confirmation |
|---|---|---|---|---|---|---|---|---|---|---|
| Customer | View profile/statement | Any active/known | `customers:read` | Always when readable | Tenant scope, entity exists | None (read) / snapshot persistence if saved | None | Read optional; snapshot write audited | UNVERIFIED | No |
| Customer | Edit | Active/editable (`UNVERIFIED` exact status field) | `customers:write` | Has permission | Field validation, tenant scope | Indirect (terms/credit/tax settings) | None | Yes | UNVERIFIED | Optional |
| Invoice/Sales Receipt | View/preview/print | Any | `invoices:read` | Always when readable | Tenant scope, doc access | None | None | Optional | UNVERIFIED | No |
| Invoice | Edit draft | `draft` (and not posted/voided) `UNVERIFIED` | `invoices:write` | Draft + permission | Status/period/posting checks | Possible | Possible if lines/items change | Yes | UNVERIFIED | Yes (save) |
| Invoice | Receive payment / partial | Open states: `sent/partial/overdue` and `balanceDue>0`, not `voided/paid` | `invoices:write` (+ banking context) | Balance due > 0 | Allocation/balance/period/idempotency/duplicate prevention | **Yes (AR/cash)** | None direct | **Yes** | UNVERIFIED | **Yes** |
| Invoice | Create/apply credit memo | Eligible posted/open balances `UNVERIFIED` exact | `invoices:write` | Eligible balance/status | Amount caps, linkage, period checks | **Yes** | Possible if returns/restock modeled `UNVERIFIED` | **Yes** | UNVERIFIED | **Yes** |
| Invoice | Void | Not `voided`; posted/paid constraints per policy | `invoices:write` (+ approval controls if configured) | Eligible + permission | Reversal/void workflow, period/settlement rules, idempotency | **High** | Possible downstream | **Yes** | UNVERIFIED | **Strong destructive confirmation** |
| Invoice | Send reminder/email/share | Non-voided, contact/config valid | `invoices:read` or write/comms perms `UNVERIFIED` | Contact exists/configured | Template/config/recipient validation | None | None | Yes (send log) | UNVERIFIED | Optional |
| Estimate | Edit/approve/reject/convert | `pending`/`accepted` depending on action; `invoiced` terminal for convert | `estimates:write` (+ approval gate possible) | Status-specific | Transition rules, cost redaction, conversion idempotency | Potential (on convert) | Potential (stock checks/reservations `UNVERIFIED`) | Yes | UNVERIFIED | Yes |
| Purchase Order | Receive / partial receive / convert to bill | `open`/`partially_received` | `bills:write` (route-gated) + approval for receive gate | Receivable qty/status | Qty bounds, 3-way/receipt rules, approval gate, idempotency | **Yes (AP/inventory accrual paths)** | **Yes** | **Yes** | UNVERIFIED | **Yes** |
| Requisition | Approve / convert to PO | `submitted/approved` as applicable | `bills:write` | Status-specific | Status transition, vendor/item validation | Indirect/procurement commitment | Indirect | Yes | UNVERIFIED | Yes |
| Goods Receipt | Record / void | PO/lines receivable; receipt `received` for void `UNVERIFIED` | `bills:write` | Eligible | Qty/inventory linkage, posting rules | **Yes** | **Yes** | **Yes** | UNVERIFIED | **Yes** |
| Bill | Pay / partial pay | `open/partial/overdue`, `balanceDue>0`, not `voided` | `bills:write` | Balance due > 0 | Allocation/bank/period/idempotency | **Yes (AP/cash)** | None direct | **Yes** | UNVERIFIED | **Yes** |
| Bill | Void | Not `voided`, policy/period allows | `bills:write` | Eligible | Linked payments/credits/period checks | **High** | Possible indirect | **Yes** | UNVERIFIED | **Strong** |
| Vendor Credit | Create/apply/void | Credit/bill eligibility | `bills:write` | Eligible | Amount/open balance/status checks | **Yes** | Possible returns `UNVERIFIED` | **Yes** | UNVERIFIED | **Yes** |
| Inventory Item | Adjust stock / stock count / damage | Stocked item types; reason required | `inventory:write` | Permission + stocked item | Qty delta, reason, posting, valuation method effects | **Yes (valuation/COGS/WIP depending)** | **Yes** | **Yes** | UNVERIFIED | **Yes (reason required)** |
| Inventory Item | Deactivate | No blocking open dependencies `UNVERIFIED` | `inventory:write` | Permission + policy | Referential/workflow checks | Low/indirect | Operational | Yes | UNVERIFIED | Yes |
| Printing Job / Quick Print | Generate invoice / link invoice | Completed/eligible, not already invoiced-linked (per workflow) | `invoices:write`, `printing:read/write` as applicable | Eligible + linkage absent | Duplicate prevention, customer/link validation | **Yes** | Possible material/COGS already posted | **Yes** | UNVERIFIED | **Yes** |
| Printing Job | Status transitions (start/pause/complete/QC/deliver) | Valid adjacent states only | `printing:write` | Current status allows | State machine validation, prerequisites (materials/QC) | Indirect/possible WIP-COGS | Possible | Yes | UNVERIFIED | Yes for irreversible steps |
| Printing Contract | Complete assessment / link deposit or milestone invoice | Contract `active`, milestone `pending` | `printing:write` and/or `invoices:write` | Eligible milestone | Date/amount/linkage/idempotency checks | **Yes** | Indirect | **Yes** | UNVERIFIED | **Yes** |
| Bank Reconciliation | Reconcile / reverse | Reconcilable state; completed for reversal with policy | `banking:reconcile` (+write) | Eligible session/state | Zero-difference/lock rules, transaction matching integrity | **Yes** | None | **Yes** | UNVERIFIED | **Strong** |
| Chart of Accounts / Account | Edit/deactivate | Non-system/eligible, no posted-history restrictions for destructive ops | `accounts:write` | Permission + eligibility | System-account/history/ledger constraints | Potential reporting/control impact | None | Yes | UNVERIFIED | Yes |
| Journal Entry | Post / reverse | `draft` to post; `posted` to reverse; open period | `journals:write` | Status-specific | Balanced lines, period open, immutable posted entries, reversal linkage | **High** | None direct | **Yes** | UNVERIFIED | **Strong** |
| Period Close | Close / reopen / waive tasks | Period/task state eligible | `periods:close/reopen`, `approvals:decide` as applicable | Role/permission + checklist complete for close | Checklist/evidence, segregation-of-duties, lock enforcement | **High (controls)** | Indirect | **Yes** | UNVERIFIED | **Strong** |
| Approval Request | Approve / reject | `pending` only | `approvals:decide` (+ maker-checker rules) | Pending + authorized | No self-approval, threshold/policy match, entity linkage | **Potentially high** | Potential | **Yes** | UNVERIFIED | Yes |
| User/Membership | Invite/edit role/deactivate/revoke/reset access | Membership state eligible | `users:invite/manage`, admin settings perms | Admin-only UI | Tenant scope, role validity, session invalidation, no privilege escalation bypass | Indirect (controls) | None | **Yes** | UNVERIFIED | **Strong** |
| Report/Export | Export/schedule | N/A | `reports:read/export/schedule` | Permission and data scope | Tenant scoping, parameter validation | None direct | None | Yes (export/schedule log if implemented) | UNVERIFIED | Optional |

## 4. Global Enforcement Rules (Must Apply to All Actions)

1. **Backend-first security:** Never rely on hidden/disabled menu items; every action endpoint must enforce authn, tenant/company scope, RBAC permission, and record-state validation.
2. **Status machine enforcement:** Reject invalid transitions server-side (including stale UI/client race conditions).
3. **Financial integrity:** No direct delete/edit of posted transactions/ledger history; use void/reversal/credit workflows as designed.
4. **Idempotency and duplicate prevention:** Payment, invoice generation, job/delivery confirmation, receipt/void, and conversion actions must be idempotent and protected against double-submit/retry duplication.
5. **Period controls:** Block or gate postings/voids/reversals according to fiscal-period close/reopen rules.
6. **Auditability:** All mutating and sensitive actions must emit structured audit records (actor, tenant, entity, before/after or event payload, timestamp, source/correlation).
7. **Confirmation UX for risk:** Destructive, financial, inventory-affecting, approval, and access-control actions require explicit confirmations with clear impact text.
8. **Offline/sync safety:** If/when offline-capable actions are introduced, they must preserve conflict resolution, replay idempotency, and server reconciliation; currently offline capability is largely `UNVERIFIED`/not implemented.

## 5. UNVERIFIED Areas Requiring Pre-Implementation Validation

- Exact editable fields and allowed transitions for draft vs posted records per module.
- Full endpoint coverage for deactivate/archive/edit/duplicate operations where UI intent exists but API evidence was not fully traced.
- Dedicated Sales Order and Delivery/Dispatch UI modules and their authoritative status machines.
- Wallet and Referral permission/status models (domains not discovered).
- Bulk action semantics and per-record partial-failure contracts across all modules.
