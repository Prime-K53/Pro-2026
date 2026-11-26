# Phase 3B — Sales Invoices Integration

**Scope:** Sales Invoices tab of `InvoicesView` only. No backend/schema/accounting changes.

## 1. Files changed
- `src/components/views/InvoicesView.tsx` — added `InvoicesTable` (+ inner) and `buildInvoiceSections`; replaced the invoices table with the shared `InvoicesTable` (adds left-click detail drawer, multi-select + bulk export); switched the invoice three-dot and right-click menus to the shared `TransactionActionMenu` / `TransactionContextMenu` (preserving the existing executor/confirmation logic); added `detailInvoice` state + `TransactionDetailDrawer`. Other tabs untouched.
- **Added** `src/components/views/InvoicesView.invoices.test.tsx` — 4 tests.
- `docs/transaction-interaction/phase3b-sales-invoices.md` — this report.

## 2. Components integrated
`TransactionDetailDrawer` (left-click), `TransactionActionMenu` (three-dot), `TransactionContextMenu` (right-click), `TransactionSelectionProvider`/`useTransactionSelection` (multi-select). Right-click and three-dot use the same resolved action definitions and the same executor.

## 3. Actions (unchanged, existing)
All existing invoice actions (view, receive payment, remind, apply deposit, write-off, void, convert, preview/print, etc.) are preserved — only the menu component wrapper changed. No new endpoints.

## 4. Status & permission mapping
Unchanged from the existing `buildInvoiceActionDefinitions` + `buildInvoiceActionContext` (status `draft/sent/partial/paid/overdue/voided`, permissions `invoices:read/write`, `payments:*`, `audit:read`).

## 5. Detail drawer
Shows document #, customer, dates, type (invoice/sales receipt), status, currency, total/amount paid/balance due, and linked payments (from the payments list). Audit shows the documented record-scoped limitation (no client-side filtering).

## 6. Multi-select & bulk
Checkbox per row + select-all + shift-range; bulk **Export selected (CSV)** (client-side, safe). No bulk void/reverse (no backend bulk endpoint).

## 7. Reconciliation/integrity
No accounting logic changed; existing void/reversal/period/permission rules remain authoritative.

## 8. Tests & results
- `InvoicesView.invoices.test.tsx` → **4/4 PASS** (render via render props; left-click→onRowClick; right-click→onRowContextMenu with point; select-all + export; empty state).
- `pnpm test:unit` → **66/66 PASS** (13 files).
- `pnpm lint` → **0 new errors**; baseline 59 unchanged.
- Menu parity is guaranteed by both menus using the same `AdvancedActionsMenu` engine (covered by Phase 1/2 parity tests).

## 9. Limitations
- Record-scoped audit needs backend enhancement (documented).
- No bulk invoice mutation endpoint; bulk is export-only.
- Multi-select is client-side (no persistence).

## 10. Existing workflows intact
Filters, search, sort, pagination, row highlight, three-dot/right-click actions, and all other tabs are unchanged. Full unit suite green; typecheck baseline unchanged.

**Status: PASS.** Awaiting review before Phase 3C (Supplier Payments / Purchase Bills).