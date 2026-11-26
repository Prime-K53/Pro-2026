# AGENTS.md

Agent guidance for this repository.

## Commands

- `pnpm dev` — run the app (Vite + Express via `tsx server.ts`).
- `pnpm build` — production build (`vite build`).
- `pnpm lint` — typecheck (`tsc --noEmit`). Note: there are pre-existing
  errors under `src/pdf/*` unrelated to most changes.
- `pnpm test` — backend tests (`node scripts/run-tests.mjs`, `node:test`).
- `pnpm test:unit` — frontend unit/component tests (Vitest + React Testing
  Library, jsdom). Config in `vitest.config.ts`; setup in `src/test/setup.ts`.
- `pnpm test:unit:watch` — Vitest watch mode.
- `pnpm test:e2e` — Playwright E2E.

## Frontend testing conventions

- Component/service tests live next to the code as `*.test.ts(x)` and are run
  by Vitest (`src/**/*.test.{ts,tsx}`).
- Build fixtures with `src/test/fixtures/contracts.ts` (`makeContract`,
  `makeActiveContract`, `makeCustomer`, `makeAssessment`).
- Mock contexts (`AccountingContext`, `AuthContext`) with `vi.mock` rather than
  spinning up providers.
- Backend tests remain on `node:test` via `pnpm test`; do not move them to
  Vitest.

## Printing contracts domain

- Data flow is backend-authoritative: `src/services/printingApi.ts` calls the
  server and local state updates only after confirmation. Money mutations send
  an `idempotency-key` header.
- Lifecycle actions are defined as `AdvancedActionDefinition`s and resolved via
  `src/actions/evaluateActions` + `AdvancedActionsMenu`.
- Contract status: `draft → active ↔ suspended → completed/exhausted`, plus
  terminal `cancelled` and `voided` (compensating reversal; returns retainer to
  the wallet).
- Migrations are numbered SQL under `db/migrations/` (latest applies on boot).