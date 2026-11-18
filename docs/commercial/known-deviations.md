# Phase 5 — Known Deviations & Intentional Architecture Enhancements

1. **Default Currency & Tax Regime (`ZMW` / `K` & Statutory VAT):**
   - While preserving SlowBooks' multi-currency and sales/use tax mechanics (`tax_category_mappings`, `reseller_permits`, `use_tax_rate`), company defaults use Zambian Kwacha (`ZMW` / `K`) and Zambia Revenue Authority (`ZRA`) VAT terminology.
   - Forms `941`, `940`, `W-2`, and `1099-NEC` remain accessible inside `TaxFormsView.tsx` alongside the primary live PostgreSQL **Sales & Use Tax Return (VAT)** tab.

2. **Perpetual Inventory 4-Type Printing Model & Raw Material Unit Conversion:**
   - SlowBooks inventory items are extended to enforce the 4 printing-house item classifications (`raw_material`, `printed_product`, `stationery`, `printing_service`):
     - `raw_material` items are strictly blocked from invoicing (`400 RAW_MATERIAL_NOT_INVOICEABLE`) and apply `conversion_factor` (e.g., `1 Ream = 500 Sheets`) upon vendor Bill / PO receipt.
     - `printed_product` and `printing_service` consume BOM raw material components dynamically on invoicing rather than tracking finished-goods stock.

3. **Strict Atomic Phase 4 Ledger & Bank Reconciliation Lock:**
   - Unlike legacy client-side state updates, all commercial mutations (`invoices`, `payments`, `credit_memos`, `bills`, `bill_payments`, `vendor_credits`, `bank_transactions`) post exclusively through `accountingEngine.ts` with `BigInt` / `NUMERIC(19,4)` precision and PostgreSQL `DEFERRABLE` balance triggers.
   - Completing a bank reconciliation sets `journal_lines.is_reconciled = TRUE`, physically preventing direct GL reversals or bank transaction voids (`409 RECONCILED_ENTRY_LOCKED`) unless an audited reconciliation reversal is recorded first.

4. **Estimate Internal Cost Redaction (`#824`):**
   - Preserves SlowBooks `#824`: `estimates:read` omits `unitCost`, `totalCost`, and `estimatedProfit` for `Accountant` and `Read-Only` roles; `estimates:read_costs` is required to view internal production costing and profit margins.

5. **Out-of-Scope Deferred Modules:**
   - Payroll Runs / HR (`employees`, `payroll_runs`), Printing Examination Batches, and School Printing Contracts remain on the existing schema/context pending Phase 6 (Printing Production & Payroll/HR migration).
