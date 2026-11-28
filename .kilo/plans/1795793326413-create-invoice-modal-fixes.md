# Create Invoice Modal — Fix Plan

## Context
End-to-end flow: `src/components/modals/NewInvoiceModal.tsx` → `commercialApi.createInvoice` (`src/services/commercialApi.ts:394`) → `POST /api/invoices` (`src/server/routes/salesRoutes.ts:355`) → `createInvoiceOrSalesReceipt` (`src/server/services/salesService.ts:1149`). Embedded `QuickPrintJobModal` posts desk jobs; AI path uses `aiApi.proposeInvoice`/`executeAction` (`src/services/v2Api.ts:872-903`).

The backend is already correct and authoritative (decimal math, double-entry, inventory, credit limit, tax exemption, FX, idempotency, approval gate, audit). The defects are the client not using those capabilities. This plan is **client-only**: no schema/migration, no new atomic endpoint. Backend remains the authority for totals, permissions, credit limits and idempotency. Partial failure stays explicit.

## Locked decisions
1. **Idempotency** — send a stable `idempotencyKey` on invoice create; reuse across retries; regenerate only after success.
2. **Tax-exempt totals** — client preview must match server (zero tax for valid exempt customers); send `isTaxExempt`.
3. **Currency/FX** — invoice in the customer's `currencyCode` (never silent fallback); use existing `useFxRates` hook; show revenue totals in invoice currency; hide COGS/GP for foreign currency; block save if currency missing/unsupported or no rate.
4. **Credit limit** — show limit/balance/available; warn when projected exceeds; optional `Override reason` → `creditOverrideReason`; backend enforces permission.
5. **AI path** — "Approve & create" becomes "Apply draft to form"; user saves via normal path. Never call `executeAction` from the modal. Applying over existing lines requires explicit replace/append confirmation.
6. **Discount/other charges** — stay line-level; fix rounding via largest-remainder allocation; tax the same base the server will; other charges remain a taxable line (documented policy).
7. **Reset** — full deterministic reset on open; keep all state (and keys/line ids) on failure.
8. **Unsaved guard** — confirm before discard on Cancel/×/overlay/Escape.
9. **Accessibility** — label/associate all inputs, `aria-label` search, Enter-to-add, `role="alert"` errors.
10. **Loading/empty** — disable form while loading; clear empty-customer guidance.

## Tasks (ordered)

### 1. Idempotency & submit safety
- `NewInvoiceModal.tsx`: add `const idemKeyRef = useRef<string>('')`; set a new `crypto.randomUUID()` in the open-reset effect and after a successful save.
- Include `idempotencyKey: idemKeyRef.current` in the `payload` (`~line 439`). Backend already reads `body.idempotencyKey` (`salesRoutes.ts:374`) and dedupes (`salesService.ts:1157-1160`).
- Keep quick-print keys `inv-quick-${line.id}` stable; do **not** reset `lines` on failure (only on open/success).

### 2. Tax-exempt totals
- Derive `isExempt = Boolean(selectedCustomer?.isTaxExempt && selectedCustomer?.taxExemptionValid && (!taxExemptionExpiry || taxExemptionExpiry >= date))`.
- `taxRate = isExempt ? 0 : taxPercent`; `taxAmount = isExempt ? 0 : max(0,net)*rate`; `total` accordingly (`~360-362`).
- Add `isTaxExempt: isExempt` to payload; show a "Tax exempt" badge in the summary.

### 3. Discount / other-charges rounding + tax base
- Replace per-line `rate*(1-discountFraction)` (`~388,424`) with integer/4-dp **largest-remainder** allocation so `Σ discounted line amounts == round(subtotal - discountAmount, 4)`; derive each line's effective rate from its allocated amount.
- Compute tax on `Σ discounted amounts + otherChargesValue` (same base the server sees).
- Keep other charges as a line with `taxable: !isExempt` (`~428-437`); add a code comment noting per-charge taxability policy is a known limitation.
- In the success toast, use the **server-returned** `inv.total`/`inv.balanceDue`, not the client `total` (`~468-470`).

### 4. Currency / FX
- Consume `useFxRates()` (`src/hooks/useFxRates.ts`) → `baseCurrency`, `rateFor`, `loading`, `error` (mirror `InvoicesView.tsx:706,952,1007,2438-2453`).
- Add `invoiceCurrency` state, default `selectedCustomer?.currencyCode || baseCurrency`; update on customer change.
- If `invoiceCurrency !== baseCurrency`: require a rate (`rateFor(invoiceCurrency)` or a manual rate input as in InvoicesView); if absent, disable Save and show "No exchange rate available for <CUR>".
- Send `currencyCode` and `exchangeRate` (1 when base) in payload.
- Show currency label; when foreign, hide Cost of Sales / Gross Profit and show "Server computes cost/margin".

### 5. Credit limit surfacing
- On customer select, fetch `commercialApi.getCustomerCreditProfile(id)`; compute `available = creditLimit - exposure` (base currency). Convert projected total to base via the rate.
- If `projectedBase > available`: show a prominent warning and reveal an `Override reason` textarea; send `creditOverrideReason` in payload. Do not imply the reason grants approval; backend returns 403/409 if unauthorized.

### 6. AI approve → apply to form
- Replace `aiApprove` (`~268-282`) with `applyAiDraft`: map `aiPreview` → `Line[]` (`itemId:''`, `unitCost:0`, `taxable` from preview), then `setLines` and `setMode('manual')`; remove `setActionStatus`/`executeAction` calls.
- If `validLineCount > 0`, prompt explicit **Replace / Append / Cancel** before mutating lines.
- Keep `aiDraft` (propose) unchanged. Leave the non-actionable "Ask" assist as-is (out of scope to remove).

### 7. Reset semantics
- Expand the open effect (`~187-220`) to reset **all** fields deterministically: lines, invoiceNumber, notes, discount, otherCharges, taxPercent (from `companyProfile.salesTaxRate`), terms (`Net 30`), date (today), customerId (first), bankAccountId (first active Bank), invoiceCurrency, AI/assist state, `lastAdded`, `error`, and `idemKeyRef`.
- On success: close (state discarded). On failure: keep everything.

### 8. Unsaved-changes guard
- `src/components/common/ui.tsx`: add optional `beforeClose?: () => boolean` to `ModalShellProps` (`~235`); in the Escape handler (`~279-283`) and overlay `onMouseDown` (`~315-317`) call `if (beforeClose && !beforeClose()) return;` before `onClose()`. Default `undefined` preserves current behavior for all other modals.
- `NewInvoiceModal`: compute `isDirty` (customer changed, any line description/qty/rate, notes, discount, charges, quickPrint lines) and pass `beforeClose` that confirms discard.

### 9. Accessibility
- `SearchDropdown`: add `aria-label={label}` to the input (`~77`); keep the visible label.
- Table inputs (`~692-719`): add `aria-label` ("Description", "Quantity", "Rate" + row number).
- Discount/other-charges/tax inputs (`~752-776`): add `htmlFor`/`id` pairs.
- Description input: add Enter-to-add-first-item handler (currently only the hint exists, `~733-737`).
- Error banner (`~801-805`): add `role="alert"` / `aria-live="assertive"`.

### 10. Loading / empty states
- Disable the line-item area and Save buttons while `loading` (`~819,827`); show "Loading customers & items…" in the footer (already partially there).
- When `customers.length === 0`: show "Add a customer first" with an optional button to open `NewCustomerModal`.

### 11. Explicit partial failure (quick print)
- Keep posted-job idempotency. On invoice-create failure after jobs posted, keep the form + keys and show the existing explicit message listing posted job ids and that the invoice was **not** created (`~472-476`). Do not auto-reset. Link failures remain surfaced (`~456-466`) but the invoice is still usable.

### 12. Tests — add `src/components/modals/NewInvoiceModal.test.tsx` (Vitest + RTL)
- Tax-exempt customer → displayed total has zero tax and payload `isTaxExempt:true`.
- Idempotency key present and identical across a simulated retry; changes after success.
- AI "Apply draft" populates lines and never calls `executeAction`; replace/append confirmation.
- Over-limit → warning + `creditOverrideReason` sent.
- Foreign currency without rate → Save disabled; with rate → `currencyCode`/`exchangeRate` sent.
- Reset on open clears prior entries; failure preserves entries.
- Unsaved guard blocks close when dirty.
- Discount allocation: Σ line amounts equals discounted subtotal (4-dp).

## Risks / safeguards
- Client/server rounding drift → integer largest-remainder allocation + server totals authoritative in UI/toast.
- `useFxRates` needs `accounts:read`; if unavailable, block with a clear message (no silent fallback).
- `ModalShell.beforeClose` must be optional/backward-compatible (all other modals unchanged).
- Backend remains the authority; if tests show the backend cannot prevent duplicates or validate totals, **stop and report a backend blocker** rather than masking it client-side.

## Out of scope
- Document-level discount/other-charges columns; atomic job+invoice DB transaction; schema migrations; server AI executor changes.

## Validation
- `pnpm test:unit` (new modal tests + existing 66 must stay green).
- `pnpm lint` (no new errors; `src/pdf/*` baseline unchanged).
- `pnpm test` (backend unchanged, should stay green).
- Manual: double-click Save (one invoice), tax-exempt customer (total matches), foreign-currency customer (rate required), over-limit (override), AI draft apply, discard guard.

## Open questions
- None material. Minor: whether to keep the non-actionable "Ask" assist (default: keep).