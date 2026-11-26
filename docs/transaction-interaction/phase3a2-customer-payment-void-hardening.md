# Phase 3A.2 — Customer Payment Void Backend Hardening

**Scope:** customer payment void/reversal backend only. No architecture redesign.
**Result:** **PASS** (41/41 hardening checks; targeted suite green; no new type errors).

---

## 1. Files changed

| File | Change |
|---|---|
| `src/server/routes/salesRoutes.ts` | Added server-side mandatory-reason validation to `POST /api/payments/:id/void` (reject missing/null/empty/whitespace, trim, reject before any mutation). |
| `tests/commercial/customer-payment-void-hardening.test.ts` | **New** isolated (in-memory, seeded) DB-backed integrity suite (41 checks). |
| `docs/transaction-interaction/phase3a2-customer-payment-void-hardening.md` | This report. |

No changes to `reverseJournalEntry`, the transaction architecture, schemas, or unrelated Sales/GL/Bank code.

## 2. Server-side reason validation

`salesRoutes.ts` void route now:
```ts
const rawReason = req.body?.reason;
const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
if (!reason) return res.status(400).json({ error: 'A non-empty reversal reason is required' });
```
- Rejects missing, `null`, empty and whitespace-only reasons with `400` **before** `runIdempotent`/any financial mutation.
- Trims leading/trailing whitespace; the trimmed value is passed to `voidCustomerPayment` and stored in the audit `newValues.reason` and the reversal description.
- No default reason is substituted on the API path.
- Idempotency payload now includes the trimmed `reason`; a same-key request with a **different** reason produces a different `payloadHash` → `checkRouteIdempotency` returns `409` (cannot bypass already-voided protection).

## 3. Test coverage matrix

| Scenario | Test (file::name) | Expected | Actual | DB before/after | Balances asserted |
|---|---|---|---|---|---|
| A1 Unallocated | hardening::A1* | void 200, reversal balanced, 1 reversal, 0 allocations, payment preserved+voided | PASS | yes (reversal/alloc counts) | journal balanced |
| A2 Partial | hardening::A2* | invoice paid→0, balance→1000, status sent, 1 allocation preserved, 1 reversal | PASS | yes | journal balanced |
| A3 Full | hardening::A3* | invoice paid→0, balance→1000, 1 allocation preserved, 1 reversal | PASS | yes | journal balanced |
| A Customer balance | hardening::A customer balance | 3000 after voids | PASS | before/after | customer balance |
| B1 Duplicate | hardening::B1* | repeat void 409, no new reversal | PASS | yes | — |
| B2 Concurrent | hardening::B2* | statuses ∈ {200,409}, exactly 1 reversal | PASS (200/200 replay) | yes | — |
| B3 Diff reason same key | hardening::B3* | 200 then 409, 1 reversal | PASS | yes | — |
| C Period | hardening::C* | period with posted entry cannot be closed (void-in-closed-period unreachable) | PASS | yes | — |
| D Rollback | hardening::D* | reconciled-line failure → payment/invoice/alloc unchanged, 0 reversal | PASS | yes | invoice unchanged |
| E Invalid/incomplete | hardening::E* | missing/whitespace/null reason 400; null journal voids w/o reversal; FK blocks dangling ref | PASS | yes | invoice restored |
| Trial balance | hardening::Trial balance | balanced after all voids | PASS | — | trial balance |

All scenarios check DB state before and after and assert ledger (balanced) and invoice/customer balances where applicable.

## 4. Accounting integrity results
- Original payments preserved (present, `is_voided=true`); allocations never deleted (traceable).
- Reversal is equal-and-opposite and balanced; exactly one reversal per original (no duplicates).
- Invoice `amount_paid`/`balance_due`/status restored for partial and full cases; unallocated has no allocation to restore; customer balance recomputed correctly (3000).
- Trial balance and balance sheet remain balanced after all voids.

## 5. Idempotency & concurrency results
- Repeated void → `409`; no second reversal.
- Concurrent same-key → one real + one idempotent replay (`200/200`), single reversal.
- Same key + different reason → `409` (payload-hash conflict); no bypass.
- Null journal → void succeeds with `reversalJournalId=null` (no fabricated reversal); allocations still restored.
- Dangling journal id is impossible (FK `fk_payments_journal`).

## 6. Regression results
- Targeted: `node scripts/run-tests.mjs customer-payment-void-hardening` → **PASS** (41/41).
- Accounting action engine: `node scripts/run-tests.mjs advanced-actions` → 6/7 files pass.
- Typecheck: `pnpm lint` → **0 new errors**; baseline unchanged (59 pre-existing under `src/pdf/*`, `vite.config.ts`, `vitest.config.ts`).
- Pre-existing failure (separate, unrelated): `tests/commercial/ar-advanced-actions.test.ts` (DB-backed AR write-off/deposit idempotency) — fails independently of this change; no backend payment code touched by it.

## 7. Remaining limitations
- Period protection for payment void is enforced structurally: a period containing posted entries cannot be closed, so a posted payment cannot reside in a closed period; the test verifies the close is rejected rather than a direct closed-period void (unreachable by design).
- Rollback is exercised via a reconciled-line lock (mid-reversal failure) rather than an injected DB fault; both prove all-or-nothing behaviour.
- Dangling journal references are prevented by the FK, so "invalid journal id" is a constraint guarantee, not a runtime void path.

## 8. Final verdict

**PASS.** Server-side reason is now mandatory (400 on missing/blank, trimmed, no default), and the isolated integrity suite verifies allocation restoration (unallocated/partial/full), preservation of originals, single balanced reversal, duplicate/concurrent/idempotency protection, period immutability, rollback, and invalid-record handling — 41/41 checks green with no new type errors.