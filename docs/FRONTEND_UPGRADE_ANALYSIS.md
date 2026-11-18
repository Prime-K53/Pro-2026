# Frontend Audit & Upgrade Report

Scope: the React/Vite client only. No financial backend, journal logic, schema, permission rule or
API contract was modified. Every new screen calls endpoints that already existed on the server.

---

## 1. Architecture snapshot

| Layer | Location | Notes |
| --- | --- | --- |
| App shell | `src/App.tsx` | 21 views, 15 global modals, toolbar + sidebar + status bar |
| Session | `src/context/AuthContext.tsx` | Cookie session, per-request company membership, RBAC permission list |
| Workspace cache | `src/context/AccountingContext.tsx` | ~2,900 lines; demo/seed data **and** client-side posting maths persisted to `localStorage` |
| API clients | `src/services/{accounting,commercial,documents,financeControls}Api.ts` | Thin `fetch` wrappers around `/api/*` |
| Views | `src/components/views/*` | Mixed generations: some fully server-driven, some still demo-cache driven |
| Backend | `src/server/**` | Express + PostgreSQL, transactional double-entry engine, period locks, approvals, audit hash chain |

The server is the system of record. The browser cache is a UI convenience that has, in places, been
presented as if it were the ledger.

---

## 2. Findings

### High impact (implemented)

1. **Misleading product chrome.** The status bar and sidebar described the app as "Local-First
   Storage", "Local Vault", "Zero Telemetry" and "Desktop Pro", and the toolbar exposed a fake
   "Server Mode / Desktop Local" toggle that only flipped a localStorage boolean. The app is a
   server-backed multi-tenant system.
   - `StatusBar` now shows the verified company, role and the time of the last GL sync.
   - `SidebarNavigator` footer shows the active company and "Server-verified access".
   - `TopMenuToolbar` shows a read-only "Server-backed · role" badge instead of the fake toggle.
   - `index.html` metadata no longer claims a local-first desktop product.

2. **False "ledger balanced" indicator.** The status bar recomputed a trial balance from the
   browser cache, which cannot see journal-level truth and could disagree with the server.
   - Now calls `GET /api/reports/trial-balance` (gated by `reports:read`) on mount and after every
     `pms:accounting-updated` event, and renders the server's `isBalanced` and difference.
   - A/R, A/P and cash in the footer are derived from the returned trial-balance rows.
   - Roles without report access see an explicit "verification requires reports access" state.

3. **Company settings never reached the server.** "Save Preferences" only wrote to
   `localStorage`; `PATCH /api/companies/current` existed but was unused.
   - New `src/services/companyApi.ts` consumes `GET/PATCH /api/companies/current`.
   - `SettingsView` now loads authoritative values (name, legal name, tax ID, tax rate, base
     currency, fiscal year start, role), saves through the API, reloads the session, and shows an
     audit-trail confirmation.
   - Saving is disabled without `companies:settings:write`, with an explanation instead of a silent
     no-op.
   - The fictional "Zero Cloud Dependencies / LAN server binding" panel and `.sbp` "encrypted
     ledger" copy were replaced with accurate workspace facts. The browser cache export/restore is
     clearly labelled as a working copy, not a ledger backup.

4. **Procurement was invisible in the UI.** The backend had purchase requisitions, demand
   replenishment, goods receipts and supplier bills from POs, but the frontend had no client
   methods and no screens.
   - `commercialApi` now covers `GET/POST /requisitions`, `POST /requisitions/demand`,
     `POST /requisitions/:id/approve`, `POST /requisitions/:id/convert-po`,
     `GET/POST /goods-receipts` and `POST /purchase-orders/:id/bill`.
   - `BillsView` gained **Requisitions** and **Goods Receipts** tabs: submit, approve, convert to PO,
     scan reorder levels, and record a physical receipt. Goods receipts explicitly explain that
     receiving stock posts no supplier bill.

5. **Estimate approval workflow was unreachable.** `POST /estimates/:id/approve|reject` existed but
   the sales screen only offered "Convert to invoice".
   - Both actions are now in the estimate row menu, permission-gated by `estimates:write`.

6. **No crash containment.** A rendering error anywhere unmounted the entire app.
   - `App.tsx` now wraps the workspace in an error boundary with a safe reload path; no financial
     action is implied or retried.

### High impact (recommended, not changed)

7. **Client-side financial calculations duplicated in `AccountingContext`.** `addInvoice`,
   `recordPaymentReceived`, payroll and inventory adjustments recompute COGS, tax and GL balances in
   the browser and persist them to `localStorage`. The server computes the same values
   transactionally, so the two can diverge. The durable fix is to make the context a read-only
   projection of API data and route all posting through the existing endpoints. This is an
   architectural change spanning most views and was deliberately left out of this pass.

8. **Demo credentials exposed on the login screen.** `AuthPortal` renders role quick-fill buttons
   including the shared demo password. Keep it only behind an explicit demo/build flag before a
   production release.

9. **Sensitive financial data in `localStorage`.** The workspace cache key
   `slowbooks_pro_2026_data_v1` stores invoices, bills and payroll snapshots in clear text. Retire it
   together with item 7.

### Medium impact

10. **Unconsumed backend surface still remaining** (verified against routes):
    - `POST /credit-memos/:id/void` — wired in `InvoicesView`
    - `PATCH/DELETE /report-schedules/:id` — toggle + delete + full edit now wired in `FinanceControlsView`
    - `POST /approvals/:id/cancel` — wired in `FinanceControlsView`
    - `GET /permissions/matrix` — wired in `AccessControlView`
    - `GET /journals/:id` — wired as a detail modal in `ChartOfAccountsView`
    - `POST /purchase-orders/:id/bill` — wired in `BillsView`
    - `POST /requisitions/demand` (incl. `jobId`) — wired in `BillsView`

11. **Single 1.23 MB JS chunk.** `vite build` warns above 500 kB. Route-level `React.lazy` for the
    heaviest views (`ChartOfAccounts`, `Reports`, `PrintingContracts`, `Examination`,
    `AllDocuments`) would cut first-load cost. No behaviour change required.

12. **Four near-identical API clients** each re-implement `fetch`, JSON parsing and error shaping.
    Consolidating into one `requestJson` (plus a 401 → `refreshStatus()` interceptor) would remove
    drift; today a session expiry surfaces as a generic "Request failed".

13. **Hard-coded currency dropdowns.** `BillsView` and `InvoicesView` list only ZMW/USD/ZAR while the
    backend supports arbitrary FX rates via `/api/fx/rates`. These should read the FX store.

14. **Inconsistent visual language.** Buttons, tables, inputs and status pills were re-declared per
    screen with slightly different radii, heights and focus styles. Added shared primitives:
    - `src/components/common/ui.tsx` — `PageHeader`, `Panel`, `StatCard`, `StatusBadge`,
      `EmptyState`, `InlineAlert`.
    - `src/index.css` — `.surface`, `.surface-header`, `.app-input`, `.btn*`, `.data-table`,
      `.badge`, `.skeleton`, theme-aware `color-scheme`, reduced-motion handling.
    New and touched screens use them; remaining screens can migrate incrementally.

15. **Loading/empty/error states vary by screen.** Dashboard now uses skeleton KPI tiles and a
    retryable alert-feed error; other views still show a spinner or silent blank table. The new
    `EmptyState`/`InlineAlert` primitives are the intended target state.

### Low impact

16. Toast notifications have a single success tone even when they announce a failure-adjacent state;
    consider typed toasts (`success | error | info`).
17. Global keyboard shortcuts live in `AccountingContext` with `[]` deps; they capture the first
    render's `triggerShortcutNotice` closure. Harmless today, fragile if the handler grows.
18. Several lists fetch everything with no pagination or server-side filter. Fine for current
    volumes, but A/R, A/P and journals will need it at scale.

---

## 3. Changes delivered

| File | Change |
| --- | --- |
| `src/index.css` | Shared surface/control/table/badge/skeleton utilities, dark `color-scheme`, reduced motion |
| `src/components/common/ui.tsx` | New shared UI primitives (presentation only, no financial logic) |
| `src/services/companyApi.ts` | New client for `GET/PATCH /api/companies/current` (normalises the PATCH response by re-reading) |
| `src/services/commercialApi.ts` | Requisitions, demand scan, approve, convert-to-PO, goods receipts, PO→bill, estimate approve/reject |
| `src/components/layout/StatusBar.tsx` | Server-verified trial balance, real A/R, A/P, cash, session identity, GL sync time |
| `src/components/layout/SidebarNavigator.tsx` | Verified company/role footer replaces "Local Vault / Zero Telemetry" |
| `src/components/layout/TopMenuToolbar.tsx` | Removed fake server-mode toggle; correct help copy |
| `src/components/views/SettingsView.tsx` | Server-persisted company profile, permission gating, accurate working-copy language |
| `src/components/views/DashboardView.tsx` | `/api/dashboard/alerts` feed, skeleton KPIs, refresh control, retryable alert error |
| `src/components/views/BillsView.tsx` | Requisition and goods-receipt tabs, new requisition/convert/receipt modals |
| `src/components/views/InvoicesView.tsx` | Estimate approve/reject actions |
| `src/App.tsx` | Top-level error boundary |
| `index.html` | Correct product metadata |
| `docs/FRONTEND_UPGRADE_ANALYSIS.md` | This report |

---

## 4. Verification

- `npm run build` (Vite production build): **passes**, 1,721 modules transformed; only the existing
  large-chunk and ineffective-dynamic-import warnings remain.
- Frontend-only `tsc --noEmit` (server folder excluded): **0 errors**.
- `npm run lint` (whole repo `tsc --noEmit`): **0 errors** at final verification.

Note on the typecheck baseline: at the start of this task the full typecheck failed on syntax
corruption in `src/server/services/accountingEngine.ts` (SQL fragments pasted into the
`updateAccount` payload literal). No server file was modified by this task; by final verification
the repository typecheck passed cleanly. Because that file changed outside this work, keep
`npm run lint` in CI so any regression is caught immediately.

---

## 5. Recommended next steps, in order

1. Keep `npm run lint` and `npm run build` as required CI gates; the baseline server file corruption
   should not be allowed to return.
2. Make `AccountingContext` a read-only projection of server data; delete client-side posting maths
   and the `localStorage` financial cache.
3. Gate the demo credential quick-fill behind a demo/development flag.
4. Add route-level code splitting for the five heaviest views.
5. Consolidate the API clients and add a global session-expiry handler.
6. Feed the FX rate store into every currency selector.
7. Add pagination + server-side search to invoices, bills and journals.
8. Migrate remaining views onto the shared primitives, screen by screen.
