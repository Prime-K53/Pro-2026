# Enterprise Header Redesign — Phase 2

Professional navy/gold application header with responsive navigation tiers, authoritative company identity and accessible keyboard behaviour. Every command from the previous menu bar and quick-action ribbon is preserved; only the presentation and responsive structure changed.

## Design tokens

| Token | Value | Use |
| --- | --- | --- |
| Primary navy | `#102E49` | Primary header row (all themes) |
| Secondary navy | `#173F60` | Quick-action toolbar |
| Midnight primary | `#0A1B2B` | Midnight primary row |
| Midnight toolbar | `#102E49` | Midnight toolbar |
| Gold | `#F5B800` | Brand mark, primary action, active indicators |
| Gold bright | `#FFD24D` | Focus ring and accent text |
| Panel navy | `#0B2134` (`#071522` Midnight) | Dropdown surface |
| Muted text | `#C8D6E4` / `#9DB2C6` | Secondary labels |
| Radius | `8px` | Buttons, dropdowns, avatars container |

Measured contrast on the primary header: user name `13.92:1`, user role `9.41:1`.

## Component architecture

```
src/components/layout/AppHeader.tsx
├── header/CompanyContext.tsx        authoritative name / TPIN / currency / fiscal year
├── header/GlobalSearch.tsx          Command Palette entry point (full or icon-only)
├── header/PrimaryNavigation.tsx     full, priority + More, Menu, or none
├── header/UserProfileMenu.tsx       profile, company switcher, themes, account actions
├── header/QuickActionsBar.tsx       all actions, primary + More, or one Quick Actions menu
│   ├── header/DropdownPanel.tsx     shared accessible menu surface
│   └── header/HeaderMenuItems.tsx   menu items + help shortcut sheet
└── config/navigation.ts             single source of truth for menus, actions, shortcuts
    hooks/useResponsiveHeader.ts     wide / medium / compact / mobile tiers
    hooks/useCompanyIdentity.ts      GET /api/companies/current + live refresh
```

`AppHeader` owns the action dispatcher. Every destination and modal command routes to the existing Accounting/Auth context handlers, so business logic is unchanged.

## Responsive behaviour

| Viewport | Navigation | Quick actions | Header heights | Horizontal overflow |
| --- | --- | --- | --- | --- |
| 1920 / 1440 / 1366 / 1280 | File, Edit, Lists, Activities, Reports, Banking, AI Agent, Help | All 8 | 62 / 46 px | None |
| 1024 | File, Lists, Reports, Banking, More | Invoice, Receive Payment, Enter Bill, Write Check, More | 62 / 46 px | None |
| 768 | Menu (all sections + Help) | Invoice, Receive Payment, More | 60 / 44 px | None |
| 390 / 360 | Drawer via hamburger | One Quick Actions menu (all 8 actions) | 60 / 44 px | None |

Brand text, user name/role and TPIN appear from 1280px. TPIN is hidden below 1280px and never rendered when the server has no registration value. The demo EIN no longer appears anywhere in the header.

Measured at every width in `after/measurements.json`: document, header and toolbar `scrollWidth === clientWidth`, and zero out-of-viewport header descendants.

## Accessibility

- Dropdown triggers expose `aria-haspopup="menu"`, `aria-expanded`, `aria-controls` and stable IDs.
- Panels use `role="menu"`, `aria-labelledby` and focus the first item on open.
- Arrow Up/Down, Home and End move between items; Escape closes and restores trigger focus; Tab leaving the panel closes it.
- Visible gold focus ring on every header control.
- All header buttons have accessible names (verified programmatically).
- Mobile drawer is a `role="dialog"` `aria-modal` region with a label, focus trap, scroll lock, Escape dismissal and focus restoration to the header toggle.
- Header-launched modals (IIF/OFX, OCR, Journal, Statement, Pay Bills) now expose dialog semantics and close with Escape; their close buttons are labelled.
- Company identity is a single labelled summary; loading state announces via `role="status"`.

## Functional preservation

Verified through the browser command suite:

- File: working-copy export payload, restore via file input, IIF/OFX modal, print invocation, demo-list reset confirmation.
- Edit: company preferences navigation, general journal modal.
- Lists: accounts, inventory, customers, vendors, employee directory.
- Activities: invoice, receive payment, enter bill, pay bills, write check, statements, payroll.
- Reports: every item navigates to the Reports Center (unchanged behaviour).
- Banking: register, reconciliation, bank feeds.
- AI: receipt OCR modal, anomaly auditor, agent API destination.
- Search/Command Palette: button and Ctrl+K.
- Account menu: profile, 2-company switcher with real server switch, three themes, permissions, settings, palette, print, help, sign out.
- Shortcuts: Alt+N, Alt+B, Alt+W, Alt+P, Alt+D.
- Responsiveness: all four tiers, menu contents, drawer behaviour, no overflow.

### Not tested

- Actual OS print preview/output (the `window.print()` call is verified).
- Executing an IIF/OFX import, OCR posting or journal posting (dialogs open; mutations intentionally not run).
- Saving the export to disk (payload, filename and anchor trigger verified; headless Edge suppresses downloads).
- Screen-reader announcement pass with assistive technology (ARIA and keyboard behaviour verified in Chromium).
- Firefox/Safari (Edge/Chromium only).
- Theme persistence across a hard reload (live switching verified for all three themes).

## Verification results

| Check | Result |
| --- | --- |
| `npm run lint` | 9 pre-existing errors, 0 new |
| `npm run build` | Passed — 1745 modules |
| Browser interaction/a11y suite | 82 / 82 passed |
| File action suite | 6 / 6 passed |
| Command sweep | 8 / 8 passed |
| `test:accounting` | 10 / 10 |
| `test:security` | 6 / 6 |
| `test:db` | 8 / 8 |
| `test:commercial` | 8 / 8 |
| `test:controls` | 10 / 10 |
| `test:printing` | 18 / 18 |
| `test:workflows` | 7 / 7 |
| `test:documents` | 7 / 7 |
| `test:migration` | 9 / 9 stages |
| Phase 2A advanced actions | 15 / 15 |
| Phase 2B.1 invoice actions | 11 / 11 at runtime (9 baseline type errors remain) |

Machine-readable evidence is in `after/interaction-checks.json`, `after/file-action-checks.json`, `after/command-sweep-checks.json` and `after/measurements.json`.

## Files

Created:

- `src/config/navigation.ts`
- `src/hooks/useResponsiveHeader.ts`
- `src/hooks/useCompanyIdentity.ts`
- `src/components/layout/AppHeader.tsx`
- `src/components/layout/header/{DropdownPanel,HeaderMenuItems,PrimaryNavigation,GlobalSearch,CompanyContext,UserProfileMenu,QuickActionsBar}.tsx`

Modified:

- `src/App.tsx` — renders `AppHeader`
- `src/index.css` — scoped `.app-header` design system, Midnight overrides, responsive rules
- `src/components/layout/SidebarNavigator.tsx` — dialog drawer semantics, focus trap/restore, navigation landmark
- `src/components/modals/{IifImportModal,OcrReceiptModal,JournalEntryModal,CustomerStatementModal,PayBillsModal}.tsx` — dialog semantics, labelled close buttons, Escape dismissal
- `docs/accounting/test-execution-report.md` — regenerated by the accounting suite

## Remaining defects / technical debt

- `src/components/layout/TopMenuToolbar.tsx` is now unused; retained for rollback and should be deleted once the new header is signed off.
- All dropdown panels share the dark navy surface regardless of theme (intentional for cohesion); a light Slate/Classic panel variant would need a design decision.
- The pre-existing StatusBar overlaps its centre and right groups at 768px (`Cash … Compact Rows`). It is outside the header scope and was unchanged.
- Nine pre-existing TypeScript errors remain in `tests/advanced-actions/phase2b1-invoices-actions.test.ts` (`priority` not on `AdvancedActionDefinition`). Not fixed by request.
- Vite warns about `__dirname` in `vite.config.ts`; build is unaffected.
- One 404 console resource remains (likely favicon); unrelated to the header.

## Screenshots

`before/` and `after/` contain matching captures at 1920, 1440, 1366, 1024, 768, 390 and 360 px. Additional interaction states: `after-user-menu-1920.png`, `after-midnight-1920.png`, `after-more-1024.png`, `after-menu-768.png`, `after-quick-actions-390.png`, `after-drawer-390.png`.
