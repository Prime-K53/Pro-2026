# Test Baseline (Phase 0)

Generated: 2026-11-22
Commit: `6cc098a36b8f34fc20fcaa2b0d129e295ca9414c`
Runner: `node scripts/run-tests.mjs` (per-file process, per-file timeout)
Node: v24.22.1

## Result

- Files: 28
- Passed: 24
- Failed: 3
- Timed out: 1

## Non-passing files (pre-existing defects — to be triaged in Phase 0/WS-0)

| File | Status | Detail |
|------|--------|--------|
| `tests/security/auth-isolation.test.ts` | FAIL | Subtest 5 (invitations/read-only/revocation): `401 !== 200` |
| `tests/printing/paper-toner-calc.test.ts` | FAIL | Subtest 17: duplicate key `uq_inventory_items_company_sku_lower` (test data collision) |
| `tests/workflows/phase9-e2e-workflows.test.ts` | FAIL | Workflow 3 (material consumption/valuation): `400 !== 200` |
| `tests/printing/contracts-gap-closure.test.ts` | TIMEOUT | 7 subtests passed before 150s cap; needs a larger per-file timeout (likely ~300s), not necessarily a hang |

## Notes

- Before the V2 harness, several suites did not terminate because `middleware/csrf.ts`
  registered an un-`unref()`'d `setInterval`. Fixed in V2; suites now exit.
- Full-suite wall time is dominated by PGlite boot + full migration replay (~30–70s/file).
  Use `node scripts/run-tests.mjs <filter>` for fast iteration.
- Baseline artifacts: `docs/baseline/routes.json`, `docs/baseline/routes.md`.