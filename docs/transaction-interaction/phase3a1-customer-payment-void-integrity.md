# Phase 3A.1 — Customer Payment Void Integrity (Read-Only Diagnostic)

**Scope:** existing `POST /api/payments/:id/void` backend workflow only.
**Mode:** read-only source inspection + existing-test review. No code/schema/data changes.
**Verdict:** **CONDITIONAL PASS** (see §8).

---

## 1. Execution path (ordered call sequence)

```
HTTP POST /api/payments/:id/void
  └─ requireAuth → csrfProtection → requirePermission('invoices:write')   salesRoutes.ts:614
  └─ validate id (integer > 0)                                            salesRoutes.ts:616-617
  └─ key = header 'idempotency-key' | body.idempotencyKey                 salesRoutes.ts:618
  └─ runIdempotent(companyId,'payment_void',key,{id,reason},userId,fn)    salesRoutes.ts:619-623, 87-102
       └─ db.withCompanyDb(companyId, tx => {                             salesRoutes.ts:96
            checkRouteIdempotency(tx,...) → hit? replay response           salesRoutes.ts:97-98
            body = await fn(tx)  →  voidCustomerPayment(...)               salesRoutes.ts:99
            saveRouteIdempotency(tx,...)                                   salesRoutes.ts:100
          })
  └─ voidCustomerPayment(tx, companyId, actor, id, reason)                salesService.ts:2390-2479
       ├─ SELECT payments ... FOR UPDATE                                   salesService.ts:2397-2407
       ├─ 404 if not found                                                 salesService.ts:2408
       ├─ 409 if is_voided already                                         salesService.ts:2410
       ├─ if journal_txn_id:
       │    reverseJournalEntry(tx,...,{reason,idempotencyKey:'void-pmt-<j>'})  salesService.ts:2413-2418
       │      └─ accountingEngine.ts:1832-1987 (see §3)
       │    UPDATE bank_transactions SET status='voided' WHERE journal_txn_id  salesService.ts:2419-2422
       ├─ for each payment_allocations row (FOR UPDATE invoice):           salesService.ts:2426-2461
       │    nextPaid = max(curPaid - alloc, 0); recompute balance/status
       ├─ UPDATE payments SET is_voided = TRUE                             salesService.ts:2463
       ├─ recalculateCustomerBalance(tx, companyId, customer_id)           salesService.ts:2464 → commercialHelpers.ts:585
       └─ writeAuditLog CUSTOMER_PAYMENT_VOIDED (old/new values)           salesService.ts:2466-2475
```

Entire sequence runs inside **one** `db.withCompanyDb` transaction; any thrown error rolls the whole unit back.

---

## 2. Files & line references

| Concern | Location |
|---|---|
| Route + permission + idempotency wrapper | `src/server/routes/salesRoutes.ts:614-628`, helper `:87-102` |
| Void service | `src/server/services/salesService.ts:2390-2479` |
| Reversal engine | `src/server/services/accountingEngine.ts:1832-1987` |
| Period gate | `accountingEngine.ts:1924-1927` (`assertPeriodOpenForDate`) |
| Allocation restore | `salesService.ts:2426-2461` |
| Customer balance recompute | `src/server/services/commercialHelpers.ts:537-595` |
| Audit writer | `src/server/audit.ts` (`writeAuditLog`) |
| Payment create/allocation (context) | `salesService.ts:1829+`, allocations insert `:2029-2032`, `:2328-2331` |

---

## 3. Accounting-entry impact

- Original posted journal is reversed by `reverseJournalEntry`, which builds **equal and opposite** lines (`debit = l.credit`, `credit = l.debit`) — `accountingEngine.ts:1933-1942` — and posts them via `postJournalEntry` with `sourceType:'reversal'`, `reversesTransactionId=original` (`:1944-1954`).
- Original entry is **not mutated financially**; only `status='voided'` and `reversed_by_transaction_id` are set (`:1957-1963`). Reversal is a new compensating entry.
- Reversal is blocked if original is not posted (`:1868`), is itself a reversal (`:1871`), contains reconciled lines (`:1914`), or the period is closed (`:1924-1927`).
- Reversal-of-reversal and double reversal are rejected `409 ALREADY_REVERSED` (`:1883`), with an idempotent replay path when the same idempotency key is retried (`:1874-1881`).
- Payment void also marks any linked `bank_transactions` row `voided` (`salesService.ts:2419-2422`).
- **Assessment:** equal-and-opposite, balanced, original preserved. Verified by test (balanced reversal + trial balance) and source.

## 4. Allocation & invoice-balance impact

- `payment_allocations` rows are **read, never deleted** (`salesService.ts:2426-2429`) → allocation history remains traceable.
- For each allocation the invoice is locked `FOR UPDATE` and `amount_paid` is reduced by the allocated amount (floored at 0), `balance_due = total - amount_paid`, and status re-derived (`sent`/`partial`/`paid`), preserving `disputed`/`written_off` (`:2430-2459`).
- Unallocated/prepayment payments have no allocation rows → nothing to restore; the voided payment is excluded from unapplied receipts (`commercialHelpers.ts:556-566`, `is_voided = FALSE`).
- Customer balance recomputed deterministically from non-voided open invoices minus unapplied credit memos/receipts (`commercialHelpers.ts:537-595`); voided payment excluded → balances correct.
- **Assessment:** partial, full and unallocated cases handled correctly by source. Full/partial restoration is **source-verified only** (no dedicated assertion in tests).

## 5. Idempotency & concurrency assessment

- **Route idempotency:** `request_keys` keyed by `('payment_void', key)`; a retried identical request replays the stored response (`salesRoutes.ts:97-98,100`).
- **Service idempotency:** reversal uses `idempotencyKey = 'void-pmt-<journalTxnId>'` (`salesService.ts:2416`); a repeated reversal with the same key returns the existing reversal (`accountingEngine.ts:1874-1881`).
- **Double void:** second call sees `is_voided` → `409` (`salesService.ts:2410`) — backend-enforced, independent of UI.
- **Concurrent voids:** `SELECT ... FOR UPDATE` on the payment row serializes; the loser then observes `is_voided` → `409`. Same-key concurrent retries replay idempotently.
- **Missing/blank reason:** backend does **not** reject a blank reason; it substitutes a default note (`salesService.ts:2415`, `accountingEngine.ts:1930`). Reason is mandatory only in the frontend. **Gap (Medium).**
- **No valid posted entries:** if `journal_txn_id` is null the reversal is skipped but allocations/balance/`is_voided` still apply; if the journal exists but is not posted, `reverseJournalEntry` throws `NOT_POSTED` → full rollback.
- **Half-failure:** single transaction → all-or-nothing rollback (no partial commit).

## 6. Test evidence & gaps

**Verified by automated test**
- Payment void returns 200, reversal journal balances, trial balance stays balanced — `tests/commercial/commercial-financial.test.ts:413-419` (unallocated/overpayment case).

**Verified by source inspection only**
- Equal-and-opposite reversal lines; original preserved (`accountingEngine.ts:1933-1963`).
- Allocation restore + invoice balance/status recompute (`salesService.ts:2426-2461`).
- Double-void 409, concurrency `FOR UPDATE`, closed-period block, non-posted block.
- Route + service idempotency.

**Not verified / evidence missing (recommended tests, not added in this phase)**
- Double-void → 409 assertion.
- Concurrent void requests (one 200, one 409/replay).
- Closed accounting period → void rejected + rollback.
- Partial allocation and fully allocated payment → invoice `amount_paid`/`balance_due`/status restored exactly.
- Blank/missing reason behaviour (currently accepted).
- Payment with no posted journal (`journal_txn_id = null`).
- Mid-transaction DB failure rollback.

## 7. Risk classification

| Area | Risk |
|---|---|
| Reversal accounting correctness (equal/opposite, balanced) | **Low** |
| Original record & allocation history preservation | **Low** |
| Double-void / concurrency protection | **Low** |
| Closed-period enforcement | **Low** |
| Allocation/invoice restoration correctness | **Medium** (source-verified, not asserted in tests) |
| Mandatory reason enforcement (backend) | **Medium** (not enforced server-side) |
| Test coverage of the above | **Medium** |

Overall residual risk: **Medium**.

## 8. Final verdict

**CONDITIONAL PASS.**

The void workflow correctly reverses the accounting (equal-and-opposite compensating entry, original preserved), restores invoice balances/allocations without deleting history, recomputes customer balances, and is protected by `FOR UPDATE` + `409` + dual idempotency + period gates — all backend-enforced. Conditions:
1. Backend does not mandate a non-blank reversal reason (frontend-only). Recommend a server-side check.
2. Several integrity scenarios (double-void, concurrency, closed period, partial/full allocation restoration, null-journal) lack automated assertions; add tests before treating reversal as fully validated.

No application code, schema, or data was modified during this diagnostic.