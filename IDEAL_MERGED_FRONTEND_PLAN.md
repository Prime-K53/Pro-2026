# Ideal Merged Printing-Contracts Frontend — Implementation Plan

Goal: evolve **this app** (`C:\Users\Rhonald Chiwatu\Desktop\Projects\Printing System`) into the ideal frontend by keeping its **backend-authoritative data flow** and **action framework** (`src/actions/*` + `AdvancedActionsMenu`) while porting **PrimeERP's feature depth and test coverage**.

Target app: Printing System. Test stack: add **Vitest + @testing-library/react + jsdom** (alongside existing `node:test`). Scope: **full parity, delivered in phases**.

## Guiding constraints
- Preserve fail-closed, backend-authoritative money flow (`printingApi` → server confirms before local mutation; idempotency headers). Do **not** adopt PrimeERP's local-first IndexedDB model.
- Every new user action is expressed as an `AdvancedActionDefinition` and resolved through `resolveActions`/`AdvancedActionsMenu` — no ad-hoc buttons for lifecycle operations.
- No contract data in `localStorage` (existing rule). New UI state only.
- Reuse existing primitives: `ModalFrame`/`Field`/`Btn`, `contractModalChrome`-style tokens (port a tokens module), `PreviewModal`/`PrimeDocument`.

## Current-state facts (verified)
- Backend routes already exist in `src/server/routes/printingRoutes.ts`: `suspend`, `resume`, `acceptances`, `amendments` (POST/GET), `amendments/:id/approve|reject`, `assessment-changes`. Service fns in `printingRecordsService.ts` back them.
- Frontend `src/services/printingApi.ts` is **missing wrappers** for: suspend, resume, recordAcceptance (exists in api? yes `recordAcceptance` present), amendments list/approve/reject, assessment-changes. (Confirm each during Phase 0.)
- Backend **lacks**: distinct `void` (only `cancel`), signing-ceremony endpoints, contract reconciliation endpoint, contract integrity hash/verification token.
- No frontend tests exist; runner is `node scripts/run-tests.mjs` (`node:test`). Backend contract tests live in `tests/printing/*` and `tests/contracts/render-golden.test.ts`.

---

## Phase 0 — Test & type infrastructure (do first)
1. Add dev deps: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `jsdom`, `@vitest/coverage-v8`.
2. Add `vitest.config.ts` (environment `jsdom`, `setupFiles` for jest-dom, `include: ['src/**/*.test.{ts,tsx}']`) kept separate from `playwright.config.ts` and the `node:test` runner.
3. Add `src/test/setup.ts` and a `test` script; keep `node:test` script for backend.
4. Add a shared test fixture factory for contracts/customers (`src/test/fixtures/contracts.ts`) mirroring PrimeERP's `contract-integrity-vector.json` approach.
5. Replace high-risk `any` at API boundaries with types: `mapApiContract`, `mapApiPreviewToModel`, action `record: any` in the contract view. Add a `PrintingContractViewProps`/typed record for the action context.
Validation: `npm test` runs both runners green with one smoke component test.

## Phase 1 — API client parity (wire existing backend)
1. Extend `src/services/printingApi.ts` with typed wrappers: `suspendContract`, `resumeContract`, `recordAcceptance` (verify), `listAmendments`, `approveAmendment`, `rejectAmendment`, `requestAssessmentChange`.
2. Extend `AccountingContext` with matching methods that call the API first, mutate local state only on success (mirror `cancelPrintingContract`/`amendPrintingContract` pattern), and emit `ACCOUNTING_UPDATED_EVENT`.
3. Unit tests (node:test) for each new client method (request shape, idempotency key, error propagation).
Validation: new client tests green; manual server round-trip for suspend/resume/amendment.

## Phase 2 — Lifecycle UX gaps (suspend/resume, acceptance, search/filter)
1. Add action definitions in `renderContractActions` for Suspend (active→suspended) and Resume (suspended→active), gated by `printing:contracts:manage`, using `AdvancedActionsMenu`.
2. Add "Record Customer Acceptance" action (draft) wired to `recordAcceptance`; surface accepted/not-accepted in the activation checklist (already read-only today).
3. Add search box + status filter + pagination to the contracts register (currently renders all rows).
4. Component tests (Vitest/RTL): role gating, suspend/resume transitions, acceptance recording, search/filter.
Validation: `PrintingContracts.lifecycle.test.tsx` green.

## Phase 3 — Void vs Cancel + backend void
1. Backend: add `voidPrintingContract` in `printingRecordsService.ts` as a **compensating reversal** (distinct from `cancel` which only releases reservation): reason required, idempotent, posts reversing ledger entries, terminal `voided` state; add `POST /printing/contracts/:id/void` with `contractMoneyLimit` + `printing:contracts:manage`. Add DB migration for `voided` status + reversal columns if not present.
2. Frontend: `printingApi.voidContract`; context method; action definitions distinguishing Cancel (release) vs Void (reversal, destructive, reason captured via `AdvancedActionsMenu`).
3. Tests: backend void (idempotent, concurrent-safe, closed-period refusal, ledger DR/CR) + frontend void-vs-cancel semantics.
Validation: backend void tests + `PrintingContracts.void.test.tsx` green.

## Phase 4 — Amendment request→approve workflow + signing ceremony
1. Frontend: replace direct `AmendContractModal` submit with request→approve flow using `listAmendments`/`approveAmendment`/`rejectAmendment`; show amendment history in a detail tab/modal; approvals gated by `approvals:decide`.
2. Backend: add signing-ceremony endpoints (`POST /printing/contracts/:id/signatures` company-then-customer order enforced, append-only history) + persistence; `SignatureCapture` component (port from PrimeERP, canvas draw + upload + validation).
3. Tests: amendment bounds/approval applies delta/voids signatures; ceremony ordering (customer disabled until company signs), dual-signature persistence.
Validation: amendment + ceremony suites green.

## Phase 5 — Reconciliation view + contract integrity/tamper-evidence
1. Backend: add `GET /printing/contracts/reconciliation` (per-customer: counts, commercial value, reserved/consumed/released/unfunded, missing docs, drift) — read-only, `reports:view_reconciliation`.
2. Backend: add contract content hash (canonical JSON + SHA-256) + per-doc verification token; expose via render-model and a verify path (reuse `documentQrRoutes`/existing QR verify).
3. Frontend: port `ContractReconciliationView` as a read-only modal launched from the hub; add integrity block to the contract PDF; Zod schemas gating `PRINTING_CONTRACT`/`CONTRACT_SCHEDULE`/`CONTRACT_COMPLETION_RECEIPT` in `src/pdf` and `PreviewModal`.
4. Tests: reconciliation render/aggregation; integrity vector parity (canonical JSON, SHA-256, short code, volatile-field exclusion); PDF schema/schedule/receipt/preamble-parity tests ported to Vitest.
Validation: reconciliation + integrity + PDF suites green.

## Phase 6 — De-duplication & polish
1. Extract duplicated retainer/milestone invoice payload builders (currently in both `PrintingContractsView` and `src/types/documents.ts`) into one shared module.
2. Extract a `contractModalChrome` tokens/shell module; migrate the 4 inline modals in the view to `ModalFrame`.
3. Replace hardcoded values (account #s, currency fallbacks, 2026 default dates) with config/derived values; add date-ordering validation in the new-contract modal.
4. Split the 1,800-line view: extract KPI strip, register table, schedule, and action-builder modules.
Validation: full test suite green; no behavior change (golden render test still passes).

---

## Cross-cutting validation
- After each phase: `npm run lint`, `npm run typecheck` (add if missing), `npm test` (node:test + Vitest), and targeted Playwright smoke for the contracts flow.
- Keep `tests/contracts/render-golden.test.ts` passing throughout (guards PDF/determinism).
- Update `AGENTS.md` with the new `npm test`/Vitest commands.

## Risks / open items
- DB migration needed for `voided` status and signature storage (confirm migration framework in `src/server/db.ts`).
- PrimeERP tests assume Zustand/local-first; all ported tests must be rewritten against this app's `printingApi`/context (backend-authoritative) — budget for adaptation, not copy-paste.
- Two render paths exist (React `PrimeDocument` vs server `contractLayoutEngine`); Phase 5 must pick one source of truth for integrity hashing to avoid divergence.
- Adding Vitest introduces a second runner — document clearly to avoid CI confusion.

## Suggested sequencing rationale
Phases 0–1 de-risk everything (types + wired endpoints). Phases 2–3 are low/medium effort with high value. Phases 4–5 are the largest (backend + UI + tests) and deliver the "test depth" that makes PrimeERP better. Phase 6 is cleanup with no behavior change.