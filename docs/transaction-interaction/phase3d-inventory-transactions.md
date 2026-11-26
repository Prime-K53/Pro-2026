# Phase 3D — Inventory Transactions Integration

**Scope:** `InventoryView` item/stock table. No backend/schema/accounting changes. `InventoryOperationsView` (stock movements/ledger) is a read-only operational viewer and was left unchanged.

## 1. Files changed
- `src/components/views/InventoryView.tsx` — added generic `InventoryTable` (card-less, multi-select + bulk export); replaced the item table with it; row left-click now opens the existing `InventoryItemDrawer` (via `setDetailItemId`); switched the three-dot and right-click menus to `TransactionActionMenu` / `TransactionContextMenu` (existing executor preserved); added `Download` icon + shared imports.
- **Added** `src/components/views/InventoryView.inventory.test.tsx` — 4 tests.
- `docs/transaction-interaction/phase3d-inventory-transactions.md` — this report.

## 2. Components integrated
`TransactionActionMenu` (three-dot), `TransactionContextMenu` (right-click), `TransactionSelectionProvider`/`useTransactionSelection` (multi-select). Left-click reuses the existing rich `InventoryItemDrawer`. Right-click and three-dot share the same resolved definitions/executor.

## 3. Actions (existing, unchanged)
`buildInventoryActionDefinitions` (adjust stock, edit, duplicate, archive, etc.) — unchanged, now via shared menu + right-click.

## 4. Status & permissions
Item types/categories + `inventory:*` permissions (backend-authoritative). No new statuses.

## 5. Detail
Left-click opens the existing `InventoryItemDrawer` (item details, variants, BOM, movements).

## 6. Multi-select & bulk
Checkbox + select-all + shift-range; bulk **Export selected (CSV)** (client-side, safe). No bulk stock mutation.

## 7. Integrity
No inventory/stock logic changed; existing adjust/transfer/count services and permissions remain authoritative.

## 8. Tests & results
- `InventoryView.inventory.test.tsx` → **4/4 PASS** (render; left-click→onRowClick; right-click→onRowContextMenu with point; select-all+export; empty).
- `pnpm test:unit` → **74/74 PASS** (15 files).
- `pnpm lint` → **0 new errors**; baseline 59 unchanged.

## 9. Limitations
- Record-scoped audit needs backend enhancement (documented).
- Bulk is export-only.
- `InventoryOperationsView` movements/ledger remain read-only (no per-row actions).

## 10. Existing workflows intact
Filters, tabs, adjust/edit/BOM/variant modals, transfer receive, stock count, and the existing item drawer are unchanged. Full unit suite green; typecheck baseline unchanged.

**Status: PASS.** Awaiting review before Phase 3E (Bank Transactions / Cashbook already done in 2B; remaining: any other transaction screens).