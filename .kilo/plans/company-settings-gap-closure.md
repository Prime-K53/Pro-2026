# Company Settings — Rating & Gap-Closure Plan

## 1. Executive Rating

**Overall: 58/100 — Grade C ("Needs Improvement")**

Company Settings is functionally correct for a narrow slice of fields (name, legal name, tax ID, tax rate, print pricing) and correctly locks accounting-integrity fields. But it exposes only ~40% of the `companies` schema, persists contact/branding/theme data to the browser only (not the server), and omits logo/signature/address configuration that the rest of the app (PDF documents, multi-user access) depends on.

| Dimension | Score | Notes |
|-----------|-------|-------|
| Field completeness (vs `companies` schema) | 45/100 | 6 of 15 columns editable; address, city, rounding, decimals, logo absent |
| Server persistence correctness | 55/100 | Core 4 fields persist; phone/email/website/theme are local-only |
| Accounting-integrity principles | 88/100 | Correctly read-only: method, currency, fiscal year (server-fixed) |
| Branding & document alignment | 35/100 | No logo/signature; PDF PrimeDocument expects `logoBase64`/`signatureBase64` |
| Multi-user consistency | 45/100 | Local-only contact/theme diverge per user/device |
| Usability & organization | 55/100 | Single long scroll, no tabs, no logo, limited validation UX |
| Data management (backup/restore) | 50/100 | Import/export is browser working-copy only; real server backup exists elsewhere |

## 2. What Works Today (keep)

- `name`, `legalName`, `ein`, `salesTaxRate` → `PATCH /api/companies/current` (audited).
- Print-desk pricing defaults (`extraTypingFinishingPerPage`, `manualSellingPricePerSheet`) → `company_settings` key/value (audited).
- Accounting method / currency / fiscal year correctly read-only (protects ledger integrity).
- Role/company/slug/fiscal-year display block (read-only facts).
- Browser working-copy export/import/reset/clear with clear "server untouched" messaging.
- Permission gate `companies:settings:write` (fixed to match role definition).

## 3. Gap Analysis (prioritized)

### G1 — Contact fields are local-only (HIGH)
`phone`, `email`, `website` exist as `companies` columns (migration 0001 lines 56–58) but `SettingsView` only writes them to `localStorage` (`pms_workspace_prefs_v1`). The server (source of truth) never receives them, so other users and the PDF renderer see stale/blank contact data.
**Impact:** Invoices/contracts/statements print wrong or empty company contact info for other users.

### G2 — Address & City/State/Zip not editable (HIGH)
`address` (line 54) and `city_state_zip` (line 55) exist in DB and in `CompanyProfile`, but are absent from `SettingsView` and the `CompanySettings` DTO. `PrimeDocument` uses `companyAddress` on every document.
**Impact:** Document headers/footers cannot show the company address.

### G3 — No logo / signature / QR branding (HIGH)
`PrimeDocument` and `companyAssetUtils` expect `logoBase64` / `signatureBase64`, but no settings field uploads them. Branding is a core requirement for the PDF design just ported.
**Impact:** All PDFs render without the company logo/signature.

### G4 — Theme not persisted to server (MEDIUM)
`theme` is a `companies` column and returned by `GET /current`, but `PATCH /current` never saves it; it lives in localStorage only.
**Impact:** Per-user/device theme divergence; not a true company setting.

### G5 — Rounding mode & decimal places not exposed (MEDIUM)
`rounding_mode` (line 64) and `decimal_places` (line 65) exist in DB but have no UI. For an accounting app these affect every monetary calculation/display.
**Impact:** Precision/rounding cannot be configured per company.

### G6 — Default bank account not settable here (MEDIUM)
`defaultBankAccountId` is in `CompanyProfile` and used for deposits/payments, but not in Settings or the DTO. No cross-link to Banking.
**Impact:** Users must hunt in Banking; no single source for the default deposit account.

### G7 — No company-level default payment terms (MEDIUM)
Customers/vendors carry `terms` (Due on Receipt / Net 15/30/60) and `getDefaultPaymentTermsLabel` reads `transactionSettings.defaultPaymentTermsDays`, but there is no company default to configure.
**Impact:** Inconsistent terms; PDF payment-terms box uses a hardcoded "Net 30".

### G8 — Document/invoice defaults absent (LOW–MEDIUM)
No invoice number prefix, default tax code, default PO/terms, or document footer text configuration (the PDF `resolveFooterText` reads `config.footer` which is never set).
**Impact:** Limited document customization.

### G9 — Data management could mislead (LOW)
"Restore/Reload/Clear" are browser working-copy ops; a real server backup exists (`/admin/backup`, `backupRoutes.ts`) but Settings doesn't surface or link it.
**Impact:** Users may believe they backed up server data.

### G10 — Usability (LOW)
Single 543-line scroll form, no tabs/sections nav, no logo preview, validation only via `InlineAlert`.
**Impact:** Hard to navigate as settings grow.

## 4. Remediation Plan (phased)

### Phase 1 — Server persistence for existing fields (G1, G4)
1. `companyRoutes.ts` `PATCH /current`: accept and persist `phone`, `email`, `website`, `theme` (COALESCE pattern + audit `COMPANY_SETTINGS_UPDATED`).
2. `companyRoutes.ts` `GET /current`: return `phone`, `email`, `website`, `address`, `cityStateZip`, `theme` in the DTO.
3. `companyApi.ts` `CompanySettings` + `updateCurrent` payload: add the new fields.
4. `SettingsView.tsx`: change contact fields from local-only to server-backed (remove the "local only" note; include them in `handleSaveCompany`).
5. `AccountingContext.tsx`: keep localStorage as a fast cache but treat server as source of truth on load.

### Phase 2 — Address & branding (G2, G3)
1. Add `address`, `cityStateZip` inputs to `SettingsView` (Legal Entity section).
2. Add a **Branding** section: logo upload (PNG/JPG → base64) and signature upload, persisted via new `company_settings` keys (`logo_base64`, `signature_base64`) or `companies` columns; reuse `resolvePdfReadyImageDataUrl` from `companyAssetUtils`.
3. `GET/PATCH /current`: read/write `logo_base64`, `signature_base64` through `company_settings` (like print pricing).
4. Wire `hydrateCompanyPdfAssets` to read the persisted logo/signature so PDFs pick them up.

### Phase 3 — Financial precision & defaults (G5, G6, G7)
1. Expose `roundingMode` (HALF_EVEN/HALF_UP) and `decimalPlaces` (2–4) in Settings (validated, audited).
2. Add a **Default Deposit Account** selector populated from bank accounts; persist `default_bank_account_id`.
3. Add **Default Payment Terms** (Due on Receipt / Net 15/30/60 or days) persisted to `company_settings`; make `getDefaultPaymentTermsLabel` read it.

### Phase 4 — Document defaults (G8)
1. Add document footer text, invoice number prefix, default tax code fields persisted via `company_settings`.
2. Make `resolveFooterText` read the persisted footer.

### Phase 5 — Data management & UX (G9, G10)
1. Add a "Server backup" card linking to `/admin/backup` (admin only) and clarify browser vs server scope.
2. Refactor `SettingsView` into tabbed sections (Legal Entity, Branding, Financial, Documents, Data) with a section nav and logo preview.

## 5. Acceptance Criteria
- `PATCH /api/companies/current` persists name, legalName, ein, salesTaxRate, phone, email, website, address, cityStateZip, theme, roundingMode, decimalPlaces, defaultBankAccountId, defaultPaymentTerms, logo, signature, footer — each audited.
- `GET /current` returns all of the above.
- Settings UI exposes every editable field with server persistence and a logo/signature preview.
- A second user in the same company sees the same contact/branding/theme (server is source of truth).
- PDF documents render the persisted logo, signature, address, contact, and footer.
- Accounting-integrity fields (method, currency, fiscal year) remain read-only.
- Typecheck + build pass.

## 6. Files to Modify
- `src/server/routes/companyRoutes.ts` (GET/PATCH persistence + audit)
- `src/services/companyApi.ts` (DTO + payload)
- `src/components/views/SettingsView.tsx` (fields, branding, tabs)
- `src/context/AccountingContext.tsx` (server-authoritative load)
- `src/pdf/companyAssetUtils.ts` / `templateSettings.ts` (read persisted logo/signature/footer)
- `db/migrations/00XX_company_settings_expansion.up/down.sql` (if new columns/keys needed)