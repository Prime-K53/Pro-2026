# Test Evidence — V2 Release Candidate

**Generated:** 2026-11-23
**Commit:** (working tree, pre-commit)
**Node:** v24.22.1

## Gates

| Gate | Result | Evidence |
|---|---|---|
| TypeScript (`npm run lint`) | **PASS** | `tsc --noEmit` clean |
| Build (`npm run build`) | **PASS** | Vite build succeeded |
| Full test suite | **PASS (40/40 files)** | `node scripts/run-tests.mjs` in two batches |
| Performance smoke | **PASS** | `docs/release/perf-baseline.md` (overall p95 41.04 ms, 0 errors) |
| Coverage | **BASELINE ONLY** | `docs/release/coverage-baseline.md` (31.57% lines on representative subset) |
| E2E (Playwright) | **PENDING** | `tests/e2e/smoke.spec.ts` + `playwright.config.ts`; requires browser install |
| Accessibility (axe) | **PENDING** | Requires Playwright + `@axe-core/playwright` |

## Full suite

Batch A (19 files): accounting, advanced-actions ×2, ai ×3, bi, commercial ×3,
contracts/render-golden, debug-customer, documents, finance-controls, integration,
inventory, migration, payroll, contracts-gap-closure — **19/19 pass**.

Batch B (22 files): pos ×2, printing ×11, referral, security ×7, smart-ops, wallet — **22/22 pass**.

**Total: 40 unique files, 0 failures, 0 timeouts.**

## E2E / a11y prerequisites

```
npm i -D @playwright/test @axe-core/playwright
npx playwright install chromium
npm run dev            # terminal 1
npm run test:e2e       # terminal 2
```

## Honest status

The V2 programme is **not yet at 99.8%**. Automated tests and performance are green,
but overall coverage is below the 90% target and E2E/a11y have not been executed.
See `docs/release/coverage-baseline.md` for the gap and next steps.