# PRIME ERP Module Inventory

**Scope:** Read-only repository audit of `C:\Users\Rhonald Chiwatu\Desktop\Projects\Printing System` (workspace labeled "Printing System"/Prime ERP context).  
**Evidence basis:** Source inspection of `src/App.tsx`, `src/components/views/*`, `src/components/common/*`, `src/services/*`, `src/server/routes/*`, `src/server/services/*`, `src/server/middleware/*`, `src/server/permissions.ts`, `src/types/*`, `db/migrations/*`, and existing docs/reports.  
**Status:** Evidence-backed inventory; items not directly verified are marked `UNVERIFIED`.

## 1. Application Shell and Navigation

| Module/Area | Main page/component | Record types / purpose | Frontend/service wiring | Backend/API | Notes |
|---|---|---|---|---|---|
| App shell & routing | `src/App.tsx` (`AppContent`, `renderActiveView`) | View switching, global modals/toasts, lazy loading | `AccountingContext`, `AuthContext` | N/A (client routing) | Lazy-loaded: `ChartOfAccountsView`, `ReportsView`, `PrintingContractsView`, `ExaminationView`, `AllDocumentsView`. Global modals include invoice/payment/bill/check/journal/customer/vendor/item/employee/OCR/pay-bills/IIF import/statement/document preview (`src/App.tsx`). |
| Navigation/layout | `src/components/layout/TopMenuToolbar.tsx`, `SidebarNavigator.tsx`, `StatusBar.tsx` | Menu/ribbon, module navigation, status | Context-driven view selection | N/A | `UNVERIFIED` detailed menu-command inventory per button. |
| Authentication | `src/components/auth/AuthPortal.tsx`, `src/context/AuthContext.tsx` | Login/session/company selection | Auth context + feature flags (`src/config/featureFlags.ts`) | `src/server/routes/authRoutes.ts`, `src/server/middleware/auth.ts`, `src/server/supabaseAuth.ts` | Supports session cookie and Supabase JWT modes; tenant/membership checks evidenced in middleware/services. |
| Access control / admin UI | `src/components/views/AccessControlView.tsx` | Users/memberships/roles/access administration (UI) | `src/services/companyApi.ts` / auth-related clients (`UNVERIFIED` exact mapping) | `src/server/routes/userRoutes.ts`, `companyRoutes.ts`, `authRoutes.ts` | Permission matrix defined in `src/server/permissions.ts`. |

## 2. Discovered Frontend Modules (Views)

| Module | Main component (`src/components/views/`) | Primary record types | Frontend services/clients observed | Backend route modules (likely/evidenced) | Existing row/menu evidence |
|---|---|---|---|---|---|
| Workflow/Home | `HomeWorkflowView.tsx` | Workflow shortcuts/cards | Context/actions | Mixed | `UNVERIFIED` row-level records. |
| Dashboard | `DashboardView.tsx` | KPIs, alerts, summaries | `accountingApi`, `commercialApi`, reports/services via context | `reportsRoutes.ts`, `salesRoutes.ts`, `purchasingRoutes.ts`, `bankingRoutes.ts` (`UNVERIFIED` exact calls) | Primarily dashboard widgets/drill-down; row actions `UNVERIFIED`. |
| Customers | `CustomersView.tsx` | Customers, customer invoices summary, reseller permits, statements | `commercialApi.ts` (`list/create customers`, permits, statements), `ACCOUNTING_UPDATED_EVENT` | `salesRoutes.ts` | Uses `RowActionMenu` (import/evidence: grep + file header). Row click opens/selects detail context `UNVERIFIED` beyond selection patterns. |
| Invoices / Sales | `InvoicesView.tsx` | Invoices, sales receipts, payments, credit memos, estimates, recurring invoices, collections/comms | `commercialApi.ts`, `accountingApi.ts`, `documentsApi.ts`, `financeControlsApi.ts` (as applicable) | `salesRoutes.ts`, `documentsRoutes.ts`, `approvalRoutes.ts` | Uses `RowActionMenu`; tabbed record sets; document preview integration evidenced. |
| Bills & Purchasing | `BillsView.tsx` | Bills, purchase orders, requisitions, goods receipts, bill payments, vendor credits | `commercialApi.ts`, `accountingApi.ts`, `printingApi.ts` (jobs context) | `purchasingRoutes.ts`, `procurementService`-backed endpoints | Uses `RowActionMenu`; multiple procurement/AP record types. |
| Vendors | `VendorsView.tsx` | Vendors, vendor bills, statements | `commercialApi.ts` | `purchasingRoutes.ts`, `sales/purchasing vendor endpoints` | Uses `RowActionMenu`. |
| Banking Register | `BankingRegisterView.tsx` | Bank accounts/transactions/register entries | `commercialApi.ts`/banking clients | `bankingRoutes.ts` | Uses `RowActionMenu`; transaction-level actions likely. |
| Bank Reconciliation | `BankReconciliationView.tsx` | Reconciliations, statement/import/match items | Banking/commercial APIs | `bankingRoutes.ts` | Selection/checkbox patterns observed in grep; action menu `UNVERIFIED`. |
| Inventory | `InventoryView.tsx` | Inventory items, raw materials, stationery, printed products, services, BOMs, variants, adjustments | `commercialApi.ts` (inventory/adjustment/update), context helpers | `salesRoutes.ts`/inventory endpoints in commercial domain (`UNVERIFIED` exact route file) | Uses `RowActionMenu`; stock/valuation workflows. |
| Quick Print | `QuickPrintView.tsx` | Quick print jobs (photocopy/type & print/general print) | `documentsApi.ts`, printing/commercial context | `printingRoutes.ts`, `salesRoutes.ts` (invoicing links) | Uses `RowActionMenu`; invoice generation/linking evidenced. |
| Examinations | `ExaminationView.tsx` | Exam papers/batches, production/invoicing states | `printingApi.ts`, `documentsApi.ts`, context | `printingRoutes.ts` | Uses `RowActionMenu`; batch/grouping logic evidenced in AllDocuments merge logic. |
| Printing Contracts | `PrintingContractsView.tsx` | Printing contracts, assessment milestones, deposits/linked invoices | `documentsApi.ts`, commercial/printing flows | `printingRoutes.ts`, `salesRoutes.ts`, `documentsRoutes.ts` | Uses `RowActionMenu`; milestone status/actions evidenced. |
| Payroll | `PayrollView.tsx` | Employees/payroll runs/items (UI module) | `payrollApi.ts` | `protectedRoutes.ts`/payroll-related routes (`UNVERIFIED` exact) | Uses `RowActionMenu` (grep evidence). |
| Tax Forms | `TaxFormsView.tsx` | Tax forms/filings views | `taxCalculation.ts`, APIs (`UNVERIFIED`) | Reports/tax endpoints (`UNVERIFIED`) | Checkbox/selection patterns observed; row actions `UNVERIFIED`. |
| Chart of Accounts | `ChartOfAccountsView.tsx` | Accounts, ledger/register drill-down, journals context | `accountingApi.ts` | `accountingRoutes.ts` | Uses `RowActionMenu`; account selection/detail panel evidenced. |
| Reports | `ReportsView.tsx` | Financial/operational reports, schedules/exports | `accountingApi.ts`, reports APIs, `RowActionMenu` | `reportsRoutes.ts`, `reportSchedulingRoutes.ts` | Uses `RowActionMenu`; checkboxes/filters observed. |
| Finance Controls | `FinanceControlsView.tsx` | Approvals, period close/checklists, controls | `financeControlsApi.ts` | `approvalRoutes.ts`, `financialManagementRoutes.ts` | Action/decision UI likely; row menu `UNVERIFIED`. |
| AI Agent | `AiAgentView.tsx` | Assistant interactions/tasks | Context/services (`UNVERIFIED`) | `protectedRoutes.ts`/AI endpoints (`UNVERIFIED`) | No transactional row records evidenced. |
| Settings | `SettingsView.tsx` | Company/preferences/configuration | `companyApi.ts`, contexts | `companyRoutes.ts` | Administrative forms; row actions not primary. |
| All Documents | `AllDocumentsView.tsx` | Unified documents (sales/purchasing/contracts/exams/quick print/attachments) | `documentsApi.ts`, context mappers | `documentsRoutes.ts`, `salesRoutes.ts`, `printingRoutes.ts` | Uses `RowActionMenu`; merges Postgres + workspace records. |

## 3. Frontend Service/API Client Inventory

| Client (`src/services/`) | Purpose | Key domains/entities | Backend mapping (evidenced/likely) |
|---|---|---|---|
| `http.ts` | Shared request wrapper, `ApiError`, session-expired event | Cross-cutting transport/auth handling | All `/api/*` routes |
| `accountingApi.ts` | Accounts, journals, periods, accounting ops/events | Accounts, journal entries, fiscal periods | `accountingRoutes.ts` |
| `commercialApi.ts` | Customers, vendors, invoices, estimates, payments, credit memos, bills, POs, inventory, AR/AP ops | Sales/AR, purchasing/AP, inventory | `salesRoutes.ts`, `purchasingRoutes.ts` |
| `companyApi.ts` | Company/profile/settings/membership-related ops | Companies, settings | `companyRoutes.ts` |
| `documentsApi.ts` | Document listing/preview/upload/linking | Unified documents, previews, attachments | `documentsRoutes.ts` |
| `financeControlsApi.ts` | Approvals, period close, finance controls/report scheduling UI support | Approval requests, close tasks | `approvalRoutes.ts`, `financialManagementRoutes.ts`, `reportSchedulingRoutes.ts` |
| `payrollApi.ts` | Payroll/employee/pay-run operations | Employees, payroll runs | Payroll/protected routes (`UNVERIFIED` exact route) |
| `printingApi.ts` | Printing jobs/exams/production operations | Printing jobs, exam batches, delivery/QC workflows | `printingRoutes.ts` |
| `taxCalculation.ts` | Client-side tax calculation helpers | Tax amounts/rates | Consumed by views; server validation authoritative |

## 4. Backend Route Inventory

| Route file (`src/server/routes/`) | Domain | Representative operations (evidenced from audit/read) |
|---|---|---|
| `authRoutes.ts` | Authentication/session | Login/logout/session/bootstrap/invitations/password flows (`UNVERIFIED` full list) |
| `companyRoutes.ts` | Company/tenant settings | Company/profile/config management |
| `userRoutes.ts` | Users/memberships | User listing/invite/manage/role actions |
| `accountingRoutes.ts` | GL/COA/journals/periods | Accounts, journal CRUD/post/void/reverse workflows, period operations, rebuild (`UNVERIFIED` exact endpoints) |
| `salesRoutes.ts` | Sales/AR | Customers, permits, invoices/sales receipts, payments, credit memos, estimates, recurring, statements, reminders/comms, void/apply/convert actions |
| `purchasingRoutes.ts` | Purchasing/AP | Vendors, POs, requisitions, goods receipts, bills, bill payments, vendor credits, receive/convert/apply/void flows |
| `bankingRoutes.ts` | Banking/reconciliation | Bank accounts/transactions, import/categorize/match/reconcile/reverse (`UNVERIFIED` detail) |
| `financialManagementRoutes.ts` | Finance controls | Budgets/tax/FX/controls-related management (`UNVERIFIED` detail) |
| `approvalRoutes.ts` | Maker-checker approvals | Approval policies/requests/decisions |
| `reportsRoutes.ts` | Reporting | Financial/operational reports, exports/drill-down data |
| `reportSchedulingRoutes.ts` | Scheduled reports | Schedule CRUD/run/history |
| `documentsRoutes.ts` | Documents/attachments | Unified document listing, preview, attachment upload/storage |
| `printingRoutes.ts` | Printing/production | Jobs, materials, production/finishing/QC/delivery/exam/contract-related operations |
| `backupRoutes.ts` | Backup/restore | Backup operations and restore workflows |
| `migrationRoutes.ts` | Migration | SlowBooks/migration operations and status (`UNVERIFIED`) |
| `protectedRoutes.ts` | Misc protected APIs | Payroll/other protected domain endpoints (`UNVERIFIED`) |

## 5. Backend Services and Cross-Cutting Infrastructure

| Area | Key files | Responsibilities/evidence |
|---|---|---|
| Core server | `server.ts`, `src/server/app.ts`, `src/server/db.ts`, `src/server/config.ts` | Express bootstrap, DB init, Vite/static serving, route mounting, scheduler startup |
| Auth/RBAC/audit | `src/server/middleware/auth.ts`, `src/server/permissions.ts`, `src/server/audit.ts`, `src/server/supabaseAuth.ts`, `src/server/logger.ts` | Auth/session/JWT validation, tenant/company guard, permission checks, audit logging, secure logging/correlation |
| Accounting/finance services | `accountingEngine.ts`, `salesService.ts`, `purchasingService.ts`, `bankingService.ts`, `approvalService.ts`, `periodCloseService.ts`, `financialManagementService.ts`, `financialReports.ts` | Posting/transactions, AR/AP/banking workflows, approvals, period close, reporting |
| Inventory/production/procurement | `inventoryService.ts`, `productionService.ts`, `procurementService.ts`, `printingRecordsService.ts`, `printingWorkflows.ts`, `paperCalc.ts`, `tonerCalc.ts` | Stock/BOM/material movements, production jobs/ops/QC/delivery, printing calculations, procurement/requisitions/GRN |
| Documents/payroll/ops | `documentsService.ts`, `payrollService.ts`, `reportSchedulingService.ts`, `backupService.ts`, `scheduler.ts` | Document storage/preview, payroll processing, scheduled jobs/email delivery, backups |
| Migration/reconciliation | `slowbooksMigrationService.ts`, `slowbooksReconciliationService.ts`, `slowbooksSourceAdapter.ts`, `scripts/migrate-slowbooks.ts` | ETL/checkpoints/id mapping/reconciliation/rollback tooling |

## 6. Data, Types, Permissions, and Database

| Area | Evidence | Summary |
|---|---|---|
| Domain types/statuses | `src/types/accounting.ts`, `src/types/documents.ts` | Typed entities for accounts/customers/vendors/items/jobs/contracts/exams/invoices/estimates/payments/bills/journals/bank txns etc.; status unions (e.g. invoice `draft/sent/partial/paid/overdue`, estimate `pending/accepted/rejected/invoiced`, bill `open/partial/paid/overdue`, printing/exam/contract statuses). |
| Permissions model | `src/server/permissions.ts` | 5 roles (`Administrator`, `Bookkeeper`, `Accountant`, `ProductionManager`, `Read-Only`) with explicit permission catalog and matrix; redaction/capability separation documented in code comments. |
| Auth/tenant isolation | `src/server/middleware/auth.ts`, `src/server/db.ts`, `db/migrations/0001*`, `0008*` | Company-scoped auth context, cross-company request tamper checks, RLS/composite-FK tenant isolation evidenced. |
| Schema/migrations | `db/migrator.ts`, `db/migrations/0001`–`0016` (`.up/.down`) | Broad ERP schema: identity/tenancy, accounting/GL, AR/AP/banking, inventory/BOM, printing production/contracts/exams/delivery, approvals/close/scheduling, migration/audit enhancements. |
| Audit/offline/sync indicators | `src/server/audit.ts`, migration `0006` audit structures, `docs/*` reports | Append-only/hashed audit logging evidenced; no project-level PWA/offline-sync implementation found in source scan (`UNVERIFIED` beyond inspected areas). Wallet/referral domain entities not found in inspected schema/types/routes. |

## 7. Existing UI Action Components

| Component | Path | Evidence |
|---|---|---|
| Shared row action menu | `src/components/common/RowActionMenu.tsx` | Portal-based dropdown (`MoreHorizontal`), supports label/icon/disabled/danger/divider/`onClick`; no built-in permission/status/grouping/search/confirmation/registry integration. |
| Document preview integration | `src/components/modals/DocumentPreviewModal.tsx`, `src/types/documents.ts` | Unified preview/open flows used by sales/documents/printing views. |
| Global action modals | `src/components/modals/*` (invoice, payment, bill, check, journal, customer, vendor, item, employee, OCR, pay bills, IIF import, statement, etc.) | Existing operation entry points surfaced outside/alongside row menus. |

## 8. Inventory Gaps / UNVERIFIED

- Exact per-screen row-click behavior for every table/grid (open detail vs select vs no-op) not fully enumerated; sampled evidence only.
- Complete endpoint-by-endpoint map for every route file not exhaustively transcribed in this pass.
- Bulk selection capabilities per module: partial evidence (checkboxes seen in some views like Reports/Tax/Bank Reconciliation grep hits) — `UNVERIFIED` comprehensive matrix without full per-view read.
- Existence of hidden/internal modules beyond discovered `views/*` and route files: `UNVERIFIED`.
