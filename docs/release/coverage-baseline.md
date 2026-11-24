# Coverage Baseline — V2

**Generated:** 2026-11-23
**Runner:** `npm run test:coverage` (c8 + V8 coverage, wraps `scripts/run-tests.mjs`)
**Scope of this measurement:** representative subset
(`accounting`, `pos-cash-drawer`, `malawi-payroll`) with
`--include=src/server/**/*.ts --include=src/services/**/*.ts --include=src/utils/**/*.ts`.

## Measured

| Metric | Value |
|---|---|
| Lines | **31.57%** |
| Branches | 51.82% |
| Functions | 35.17% |

This is a **lower-bound baseline**: the include glob covers every server/service file,
including large modules not exercised by the subset. It is **not** the 90% target.

## Highest-leverage gaps (from the subset report)

| Module | Line coverage | Why it matters |
|---|---|---|
| `salesService.ts` | 6.34% | invoices, revenue, GL posting |
| `purchasingService.ts` | 4.49% | POs, goods receipt, payables |
| `procurementService.ts` | 4.14% | requisitions |
| `productionService.ts` | 17.94% | job costing, WIP→COGS, quick print |
| `smartOpsService.ts` | 8.65% | POS/smart operations |
| `twoFactorService.ts` | 28.16% | TOTP, backup codes, disable |
| `twilioSignature.ts` | 27.08% | webhook signature validation |
| `printingWorkflows.ts` | 40.11% | cost engines |
| `posService.ts` | 70.22% | already strong |
| `secretCrypto.ts` | 100% | crypto helper |

## Plan to reach ≥90% overall

1. **Unit tests for pure logic** (no DB): `malawiPayroll`, `quickPrintCalc`,
   `taxCalculation`, `twilioSignature`, `documentQrService` token lookup, `biService`
   calculations, `posService` tender/reconciliation helpers.
6. **Service tests with in-memory PGlite** for the highest-risk modules:
   `salesService`, `purchasingService`, `productionService`, `smartOpsService`,
   `payrollService`, `twoFactorService`.
7. **Route authz tests** for every new router (extend `permission-matrix`).
8. **CI gate**: `npm run test:coverage` with `c8 --check-coverage --lines 90 --branches 80`.
9. Iterate module-by-module; record each increase in this file.

## Command

```
npm run test:coverage            # full suite with coverage
npm run test:coverage -- ai      # subset
```

`coverage/` is gitignored; publish the lcov report as a build artifact.