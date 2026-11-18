# Phase 2B Implementation Report — Advanced Contextual Actions

**Date:** 2026-11-18  
**Scope:** Incremental migration of contextual row actions to the shared advanced action framework (opt-in, additive).  
**Constraint:** No database/schema/migration changes, no new financial logic; all operations delegate to existing services.

## Implemented in this pass

### 1. Invoices & Estimates (already present, stabilized)
- `src/components/views/InvoicesView.tsx` uses `AdvancedActionsMenu` with status/permission-aware definitions for invoices and estimates.
- Fixed type alignment in `tests/advanced-actions/phase2b1-invoices-actions.test.ts` (`priority` → `order`) so typecheck passes.

### 2. Customers (migrated)
- `src/components/views/CustomersView.tsx` now renders customer invoice rows through `AdvancedActionsMenu`.
- Added document preview support (`handleOpenPreview`) and action definitions: View & Print, Generate Statement, Open Sales Center, Copy Doc #.
- Auth context extended to provide `authenticated`/`permissions` for policy evaluation.

### 3. Bills / Accounts Payable (migrated)
- `src/components/views/BillsView.tsx` now renders bill rows through `AdvancedActionsMenu`.
- Action definitions: Pay Bill, Void Bill (Reverse GL) with confirmation, Copy Bill #.
- Auth context extended to provide `authenticated`/`permissions`.

### 4. Vendors (migrated)
- `src/components/views/VendorsView.tsx` now renders vendor bill rows through `AdvancedActionsMenu`.
- Action definitions: Go to Bills & POs, Supplier Statement, Copy Bill #.

### 5. All Documents (migrated)
- `src/components/views/AllDocumentsView.tsx` now renders document rows through `AdvancedActionsMenu`.
- Action definitions: Open Print Preview, Generate/Convert Invoice, Preview Linked Invoice, Download/Delete vault files.

### 6. Quick Print (migrated)
- `src/components/views/QuickPrintView.tsx` now renders job rows through `AdvancedActionsMenu`.
- Action definitions: Preview Receipt, Generate/Preview Linked Invoice, Load Specs into Calculator, Copy Job #.

### 7. Banking Register (migrated)
- `src/components/views/BankingRegisterView.tsx` now renders transaction rows through `AdvancedActionsMenu`.
- Action definitions: Mark Cleared/Uncleared, Void Transaction (Reverse GL) with confirmation, Copy Ref #.

### All view modules migrated (this pass completed)
- `src/components/views/InventoryView.tsx` (item menu + variants modal simplified)
- `src/components/views/ExaminationView.tsx` (class summary + subject queue menus)
- `src/components/views/PayrollView.tsx` (wizard employee + run + employee directory menus)
- `src/components/views/ReportsView.tsx` (trial balance + AR/AP aging menus)
- `src/components/views/ChartOfAccountsView.tsx` (accounts + journals + periods menus)
- `src/components/views/PrintingContractsView.tsx` (contracts + assessment milestone menus)

No view-level `RowActionMenu` usages remain (only `CustomerStatementModal` and `PayBillsModal` still use legacy menu).

## Verification
- `npm run lint` (`tsc --noEmit`): PASS.
- `npm run build`: PASS.
- `npx tsx tests/advanced-actions/phase2a-advanced-actions.test.ts`: 15/15 PASS.
- `npx tsx tests/advanced-actions/phase2b1-invoices-actions.test.ts`: 11/11 PASS.
- `npm run test:commercial`: 8/8 PASS.

## Remaining modules (per plan)
Delivery/Dispatch, Users/Permissions, Dashboard, plus unverified domains (Sales Orders, Wallet, Referrals) remain on custom buttons. `CustomerStatementModal` and `PayBillsModal` still use legacy `RowActionMenu`. These should be migrated in subsequent phases following the same pattern, with per-action verification against backend endpoints and status machines.

## Safety notes
- Backend remains authoritative for authorization, status transitions, period/approval controls, posting, and audit.
- No direct deletion/editing of posted financial transactions is exposed.
- Destructive actions (voids) include confirmation and reason capture where applicable.