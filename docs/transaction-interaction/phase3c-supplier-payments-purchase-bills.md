# Phase 3C — Supplier Payments & Purchase Bills Integration

**Scope:** `BillsView` bills tab (Purchase Bills) + payments tab (Supplier Payments). No backend/schema/accounting changes.

## 1. Files changed
- `src/components/views/BillsView.tsx` — added generic `BillsTable` (render-prop, multi-select + bulk export), `buildBillSections`, `buildBillPaymentSections`, bill-payment context/actions/render; replaced bills & payments tables with `BillsTable`; switched bill three-dot to `TransactionActionMenu`; added right-click `TransactionContextMenu` for both tabs; added `TransactionDetailDrawer` for a bill and a supplier payment; added `detailBill`/`detailBillPayment`/`billContextMenu` state. Other tabs (POs, requisitions, goods receipts, vendor credits) untouched.
- **Added** `src/components/views/BillsView.bills.test.tsx` — 4 tests.
- `docs/transaction-interaction/phase3c-supplier-payments-purchase-bills.md` — this report.

## 2. Components integrated
`TransactionDetailDrawer` (left-click), `TransactionActionMenu` (three-dot), `TransactionContextMenu` (right-click), `TransactionSelectionProvider`/`useTransactionSelection` (multi-select). Right-click and three-dot share the same resolved definitions and executor.

## 3. Actions (existing + supplier payment)
- **Purchase Bill:** existing `buildBillActionDefinitions` (pay, void, inspect 3-way match, approve override, payment hold/release, copy #) — unchanged, now via shared menu + right-click.
- **Supplier Payment:** view, copy #, void (bills:write, not voided, reason required) via existing `commercialApi.voidBillPayment`.

## 4. Status & permission mapping
Bills: `open/partial/paid/overdue/voided` + `matchStatus`/`paymentHold` (existing). Supplier payments: `posted`/`voided`. Permissions `bills:read/write` (backend-authoritative).

## 5. Detail drawers
Bill: bill #, vendor, dates, status, match, hold, currency, total/paid/balance. Supplier payment: payment #, vendor, date, check/ref, bank account, amount, status. Audit shows the documented record-scoped limitation.

## 6. Multi-select & bulk
Checkbox + select-all + shift-range; bulk **Export selected (CSV)** (client-side, safe) for both tabs. No bulk void/pay (no backend bulk endpoint).

## 7. Integrity
No accounting logic changed; existing void/pay/match/hold/period/permission rules remain authoritative.

## 8. Tests & results
- `BillsView.bills.test.tsx` → **4/4 PASS** (render; left-click→onRowClick; right-click→onRowContextMenu with point; select-all+export; empty).
- `pnpm test:unit` → **70/70 PASS** (14 files).
- `pnpm lint` → **0 new errors**; baseline 59 unchanged.
- Menu parity guaranteed (shared `AdvancedActionsMenu` engine).

## 9. Limitations
- Record-scoped audit needs backend enhancement (documented).
- Bulk is export-only (no bulk mutation endpoint).
- Multi-select is client-side.

## 10. Existing workflows intact
Filters, pagination, batch payment run, three-way match, holds, and all other tabs unchanged. Full unit suite green; typecheck baseline unchanged.

**Status: PASS.** Awaiting review before Phase 3D (Inventory Transactions).