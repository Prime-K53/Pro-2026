# 05 — Idempotency Design (WP-00.4)

**Status:** Specification only. No code changed.
**Scope:** Contract create, renew, top-up, cancel (refund/forfeit), complete, and invoice generation.
**Core rule:** A financial operation is posted **at most once** per `(company_id, route, idempotency_key)`.

---

## 1. Design Choice: Same-Transaction Claim

There are two possible designs:

| Option | Claim transaction | Mutation transaction | Response persistence | Risk |
|---|---|---|---|---|
| **A — Same-transaction (recommended)** | Same as mutation | Same | Same | A concurrent request blocks on the unique index until the first resolves; no stale pending state |
| **B — Separate claim** | Commit `PROCESSING` first | Second transaction | Third update | Crash leaves a stale `PROCESSING`; requires lease/heartbeat/reconciliation; risk of unsafe takeover |

**Chosen design: Option A.**

The request-key claim, the financial mutation, the journal, the bank-subledger row, the audit entry, and the stored response are all written in **one database transaction**.

Consequences:

- If the transaction **commits**, the claim and the response commit together. A retry replays the stored response.
- If the transaction **rolls back**, the claim is rolled back. A retry starts a new attempt.
- A crash **before commit** rolls back everything; no financial rows and no claim.
- A crash **after commit** leaves the claim and response committed; a retry replays.
- A concurrent same-key request blocks on the unique index until the first transaction commits or rolls back, then either replays or starts fresh.
- There is **no timeout-based takeover**. A timeout only returns `409 IDEMPOTENCY_IN_PROGRESS` to the client; it never allows a second posting.

This satisfies the requirement that a second request cannot take over a still-running transaction.

---

## 2. Key Scope and Canonical Payload

### 2.1 Key scope

The unique key is:

```
(company_id, route, idempotency_key)
```

`route` is a stable operation name, not the raw URL:

| Operation | Route value |
|---|---|
| Create contract | `printing_contract_create` |
| Renew contract | `printing_contract_renew` |
| Top-up | `printing_contract_topup` |
| Cancel / refund / forfeit | `printing_contract_cancel` |
| Complete assessment | `printing_contract_complete` |
| Generate invoice | `document_invoice_generate` |
| Create exam batch | `printing_exam_batch_create` |
| Add assessment | `printing_contract_assessment_add` |

The `actor_user_id` is stored on the row. If a second actor uses the same key, return `409 IDEMPOTENCY_ACTOR_CONFLICT` rather than replaying another user's response.

The client must generate keys with a user/session component, e.g.:

```
contract-create-${userId}-${formSessionId}
contract-renew-${userId}-${contractId}-${formSessionId}
contract-complete-${userId}-${contractId}-${assessmentNumber}-${formSessionId}
```

This prevents accidental collisions between different actions and users.

### 2.2 Canonical payload

The payload hash is computed over a **canonical object with explicit fields**, not the raw request body. This avoids irrelevant fields (`idempotencyKey`, `actor`, timestamps) changing the hash.

Canonicalization rules:

1. Recursively sort object keys.
2. Normalize money to 4 decimal places using the existing exact-decimal helper (`parseDecimal4` / `formatDecimal4`).
3. Normalize quantities to 6 decimal places.
4. Drop `undefined` values.
5. Convert dates to `YYYY-MM-DD` strings.
6. Use a stable JSON serializer (`canonicalJsonStringify`).
7. Hash with SHA-256.

**Create contract canonical payload:**

```json
{
  "schoolCustomerId": 12,
  "title": "2026 Annual Examination Retainer",
  "academicYear": "2026",
  "startDate": "2026-01-15",
  "endDate": "2026-12-15",
  "totalPrepaidAmount": "60000.0000",
  "totalAssessments": 4,
  "depositBankAccountId": 3,
  "currencyCode": "ZMW",
  "assessments": [
    {
      "assessmentNumber": 1,
      "label": "Term 1 Mid-Term",
      "scheduledDate": "2026-03-10",
      "agreedAmount": "15000.0000",
      "rawPaperItemId": 10,
      "rawTonerItemId": 11,
      "estimatedSheets": "1200.000000",
      "estimatedImpressions": "2400.000000",
      "paperCost": "120.0000",
      "tonerCost": "40.0000"
    }
  ]
}
```

**Renew canonical payload:**

```json
{
  "contractId": 1,
  "depositAmount": "60000.0000",
  "depositBankAccountId": 3,
  "depositDate": "2027-01-05",
  "startDate": "2027-01-15",
  "endDate": "2027-12-15",
  "assessments": [ ... ]
}
```

**Top-up canonical payload:**

```json
{
  "contractId": 1,
  "amount": "10000.0000",
  "bankAccountId": 3,
  "depositDate": "2026-06-01",
  "notes": "Additional term retainer"
}
```

**Cancel canonical payload:**

```json
{
  "contractId": 1,
  "reason": "School withdrew",
  "settlementMode": "refund",
  "refundBankAccountId": 3
}
```

**Complete canonical payload:**

```json
{
  "contractId": 1,
  "assessmentNumber": 2,
  "examBatchNote": "Term 2 exams",
  "linkedInvoiceId": 44
}
```

**Invoice generation canonical payload:**

```json
{
  "sourceKind": "contract_milestone",
  "sourceRef": "CTR-2026-01",
  "postgresContractId": 1,
  "postgresMilestoneNumber": 2,
  "customerId": 12,
  "invoiceDate": "2026-06-01",
  "lines": [ ... ]
}
```

---

## 3. State Machine

```
NEW
  │ claim INSERT succeeds
  ▼
PROCESSING (uncommitted; status_code=202, response_json=NULL)
  │ commit
  ▼
COMPLETED (status_code=2xx, response_json=<body>)
  │
  ├─ same payload → replay COMPLETED
  └─ different payload → 409 IDEMPOTENCY_CONFLICT

PROCESSING
  │ rollback (error, crash, cancellation)
  ▼
NEW (no row)
```

There is no committed `PROCESSING` row in the recommended design. A `PROCESSING` row exists only inside the open transaction and is invisible to other transactions. If the transaction aborts, the row disappears.

**Observability:** to inspect in-flight requests, use `pg_stat_activity` (or an application-level log). Do not use a `request_keys` row as a progress indicator unless a separate `claimed_at`/`completed_at` schema is added and a **read-only** status endpoint is provided. Even then, a stale row must never authorize a second posting.

---

## 4. Transaction Flow

### 4.1 Pseudocode

```ts
async function withIdempotentFinancialOperation(tx, {
  companyId,
  route,
  idempotencyKey,
  actorUserId,
  payload,
  operation,
}) {
  if (!idempotencyKey) throw new AccountingError(400, 'Idempotency key required', 'IDEMPOTENCY_KEY_REQUIRED');

  const payloadHash = sha256(canonicalJsonStringify(payload));

  // 1. Claim the key atomically.
  const claim = await tx.query(
    `INSERT INTO request_keys
       (company_id, route, idempotency_key, actor_user_id, payload_hash, status_code, response_json)
     VALUES ($1, $2, $3, $4, $5, 202, NULL)
     ON CONFLICT (company_id, route, idempotency_key) DO NOTHING
     RETURNING id`,
    [companyId, route, idempotencyKey, actorUserId, payloadHash]
  );

  if (claim.rows.length === 0) {
    // 2. A row already exists. Read it (the unique index serializes with the
    //    open transaction; this SELECT waits until it commits/rolls back).
    const existing = await tx.query(
      `SELECT actor_user_id, payload_hash, status_code, response_json
         FROM request_keys
        WHERE company_id = $1 AND route = $2 AND idempotency_key = $3
        FOR UPDATE`,
      [companyId, route, idempotencyKey]
    );

    if (existing.rows.length === 0) {
      // The original transaction rolled back; retry as a new attempt.
      return withIdempotentFinancialOperation(tx, { companyId, route, idempotencyKey, actorUserId, payload, operation });
    }

    const row = existing.rows[0];

    if (row.actor_user_id !== actorUserId) {
      throw new AccountingError(409, 'Idempotency key belongs to another user', 'IDEMPOTENCY_ACTOR_CONFLICT');
    }
    if (row.payload_hash !== payloadHash) {
      throw new AccountingError(409, 'Idempotency key reused with a different payload', 'IDEMPOTENCY_CONFLICT');
    }
    if (row.status_code === 202 && row.response_json === null) {
      // Only possible if a separate claim transaction is used. In the
      // same-transaction design this should not be observable.
      throw new AccountingError(409, 'Original request is still in progress', 'IDEMPOTENCY_IN_PROGRESS');
    }

    // 3. Replay the stored response.
    return { replay: true, status: row.status_code, body: row.response_json };
  }

  // 4. We own the claim. Perform the operation.
  try {
    const result = await operation(tx);

    // 5. Persist the response in the SAME transaction.
    await tx.query(
      `UPDATE request_keys
          SET status_code = $1, response_json = $2::jsonb, completed_at = NOW()
        WHERE company_id = $3 AND route = $4 AND idempotency_key = $5`,
      [result.status, JSON.stringify(result.body), companyId, route, idempotencyKey]
    );

    return { replay: false, status: result.status, body: result.body };
  } catch (err) {
    // 6. Any error rolls back the claim and the mutation.
    throw err;
  }
}
```

### 4.2 Important details

- **The `INSERT ... ON CONFLICT DO NOTHING` is the claim.** If it returns a row, this transaction owns the key.
- **The `SELECT ... FOR UPDATE` after a conflict** waits for the open transaction to commit/roll back. It then sees either the committed row or no row.
- **The response is persisted in the same transaction.** This is the critical invariant.
- **No `lock_timeout` takeover.** If a `lock_timeout` is set and the `INSERT` times out, the route returns `409 IDEMPOTENCY_IN_PROGRESS`; the client backs off and retries. The timeout does not modify or delete the original claim.
- **No `status_code=202` is ever committed.** If a future design adds an explicit pending state, it must not authorize a second posting.

---

## 5. Scenario Matrix

| Scenario | Expected behaviour | Posting count |
|---|---|---|
| First request, valid | Claim succeeds; operation posts; response stored; 201 | 1 |
| Same key, same payload, sequential retry | Conflict on claim; SELECT sees COMPLETED; replay stored 201 | 1 |
| Same key, same payload, concurrent | One claims; the other blocks on unique index, then replays COMPLETED | 1 |
| Same key, different payload | Claim conflict; hash mismatch; 409 `IDEMPOTENCY_CONFLICT` | 1 (the first) |
| Same key, different actor | Claim conflict; actor mismatch; 409 `IDEMPOTENCY_ACTOR_CONFLICT` | 1 (the first) |
| First request fails validation before posting | Transaction rolls back; no claim; client corrects and retries with same key | 0 (first), 1 (retry) |
| First request fails after journal insert but before commit | Transaction rolls back; journal and claim disappear; retry posts once | 1 (retry) |
| First request commits, client times out, retry | Claim exists; COMPLETED; replay | 1 |
| First request still running, client times out, retry | Retry blocks on unique index; then replays or starts fresh; 409 `IN_PROGRESS` if lock timeout | 1 (eventual) |
| Original transaction terminated (crash) | Claim rolled back; retry starts fresh | 1 (retry) |
| Original transaction committed, process crashed before HTTP response | Claim + response committed; retry replays | 1 |
| Two different operations, same key | Different `route` → separate rows; both proceed | 2 (correct) |
| Invoice generation, same key | One invoice, one journal; retry replays | 1 |
| Cancel refund, same key | One refund journal, one bank row; retry replays | 1 |
| Renew, same key | One new contract, one deposit journal; retry replays | 1 |
| Top-up, same key | One top-up journal, one bank row; retry replays | 1 |

---

## 6. Failure Handling

### 6.1 Fails before posting

- The transaction rolls back, including the claim.
- The client receives the original error (4xx/5xx).
- The client may retry with the same key and a corrected payload; it will be treated as a new attempt.
- **No financial rows exist.**

### 6.2 Fails after journal creation but before response persistence

- In the same-transaction design, this is a rollback: the journal and claim disappear.
- The client retries; exactly one journal is posted on the successful attempt.
- **No double posting.**

### 6.3 Client timeout followed by retry

- The client retries with the same key and same canonical payload.
- If the original committed: replay.
- If the original is still running: the retry waits on the unique index, then replays; or a `lock_timeout` returns 409 `IN_PROGRESS`.
- If the original rolled back: the retry proceeds as a new request.
- **No double posting.**

### 6.4 Pending request whose original transaction has terminated

- With same-transaction claim, a terminated transaction rolls back the claim. There is no pending row.
- If the DB connection is lost, the server aborts the transaction and rolls back the claim.
- If the transaction is still running, it holds the unique index; a retry blocks until it resolves. No takeover.
- **No stale pending state; no second posting.**

### 6.5 Process crash after commit

- The claim and response are committed atomically.
- The client may not have received the response, but a retry replays it.
- **Exactly one posting.**

### 6.6 Database error after commit

- If the response update fails, the whole transaction rolls back, including the financial mutation. The client retries.
- If the DB commits the financial mutation but the response update is in a separate transaction, that is a design violation. The same-transaction rule prevents it.

---

## 7. Route Coverage

| Route | Key required? | Route value | Notes |
|---|---|---|---|
| `POST /printing/contracts` | **Yes** | `printing_contract_create` | Deposit journal + bank row |
| `POST /printing/contracts/:id/renew` | **Yes** | `printing_contract_renew` | New contract + deposit journal + bank row |
| `POST /printing/contracts/:id/deposits` | **Yes** | `printing_contract_topup` | Top-up journal + bank row |
| `POST /printing/contracts/:id/cancel` | **Yes** | `printing_contract_cancel` | Refund/forfeit journal + optional bank row |
| `POST /printing/contracts/:id/assessments/:n/complete` | **Yes** | `printing_contract_complete` | Revenue journal |
| `POST /documents/generate-invoice` | **Yes** | `document_invoice_generate` | Invoice + journal; already has key support |
| `POST /printing/exam-batches` | Recommended | `printing_exam_batch_create` | No journal; prevents duplicate batches |
| `POST /printing/contracts/:id/assessments` | Recommended | `printing_contract_assessment_add` | Schedule change; prevents duplicate assessment |
| `PATCH /printing/contracts/:id/assessments/:n` | Optional | `printing_contract_assessment_update` | Idempotent by nature |
| `DELETE /printing/contracts/:id/assessments/:n` | Optional | `printing_contract_assessment_remove` | Idempotent by nature |

If a key is missing on a required route, return `400 IDEMPOTENCY_KEY_REQUIRED`. Do not silently allow a non-idempotent financial operation.

---

## 8. Schema Changes

The existing `request_keys` table is sufficient for the same-transaction design:

| Column | Use |
|---|---|
| `company_id` | Tenant scope |
| `route` | Operation name |
| `idempotency_key` | Client key |
| `actor_user_id` | Actor conflict check |
| `payload_hash` | Canonical payload comparison |
| `status_code` | Stored HTTP status |
| `response_json` | Stored response body |
| `created_at` | Claim time (already exists) |

**Optional additions (Phase D):**
- `completed_at TIMESTAMPTZ` — observability.
- `request_id UUID` — correlation with logs.
- `status VARCHAR(16)` — explicit `processing`/`completed`/`failed` (only if a separate claim transaction is adopted; not needed for Option A).

**Do not add a `status` column and then allow takeover based on age.** That would violate the safety requirement.

---

## 9. Code Changes (Phase A)

1. Add `src/server/lib/canonicalJson.ts` with `canonicalJsonStringify`.
2. Add `src/server/services/idempotencyService.ts` with:
   - `claimIdempotencyKey(tx, params)`
   - `completeIdempotencyKey(tx, params)`
   - `withIdempotentFinancialOperation(tx, params)`
3. Replace `checkRouteIdempotency`/`saveRouteIdempotency` usage in contract routes with the new helper. Keep the old helpers for other modules until they are migrated.
4. Update `postJournalEntry` to:
   - use the canonical hash;
   - treat a unique-index conflict as a replay/conflict, not a 500.
5. Update `printingRoutes.ts`:
   - read `idempotency-key` from header or body;
   - require it on financial routes;
   - pass it to the service;
   - return `result.idempotentReplay ? 200 : 201`.
6. Update `printingApi.ts`:
   - accept `idempotencyKey` in every financial payload;
   - send it as the `idempotency-key` header.
7. Update the frontend:
   - generate a stable key per form session;
   - reuse it on retry;
   - disable submit while pending.
8. Update `handlePrintingError`:
   - `23503` → 409 `FOREIGN_KEY_CONSTRAINT`
   - `22P02`/`22007` → 400 `INVALID_VALUE`
   - `23502` → 400 `MISSING_REQUIRED_FIELD`
   - `40001` → 409 `SERIALIZATION_CONFLICT`
   - `PRINTING_NUMBER_OVERFLOW` → 409 `PRINTING_NUMBER_OVERFLOW`
   - `IDEMPOTENCY_KEY_REQUIRED` → 400
   - `IDEMPOTENCY_CONFLICT` → 409
   - `IDEMPOTENCY_ACTOR_CONFLICT` → 409
   - `IDEMPOTENCY_IN_PROGRESS` → 409
   - unknown → 500 generic + request ID.

---

## 10. Test Matrix

| Test | Setup | Expected |
|---|---|---|
| Create same key same payload | Two sequential POSTs | 201 then 200 replay; one contract; one journal; one bank row |
| Create same key concurrent | `Promise.all` of two POSTs | One 201, one 200 replay; one contract |
| Create same key different payload | Second POST with different title | 409 `IDEMPOTENCY_CONFLICT`; one contract |
| Create same key different actor | Second POST as another user | 409 `IDEMPOTENCY_ACTOR_CONFLICT` |
| Create validation failure | Missing title | 400; no contract; retry with same key + valid payload → 201 |
| Complete same key concurrent | 10 POSTs on same milestone | One 200, nine 200 replay or 409; one journal |
| Complete after first failure | Force DB error before commit | Retry → 200; one journal |
| Cancel refund same key | Two POSTs | 200 then 200 replay; one refund journal; one bank row |
| Cancel forfeit same key | Two POSTs | 200 then 200 replay; one forfeit journal; no bank row |
| Renew same key | Two POSTs | 201 then 200 replay; one new contract; one deposit journal |
| Top-up same key | Two POSTs | 201 then 200 replay; one top-up journal |
| Invoice same key | Two POSTs | 201 then 200 replay; one invoice; one journal |
| Crash after commit | Commit then throw via test hook | Retry replays; one posting |
| Crash before commit | Throw before commit | Retry posts once; one posting |
| Timeout while running | Hold transaction open; second request with `lock_timeout` | 409 `IN_PROGRESS`; no second posting |

---

## 11. Guarantee Statement

A financial operation is posted **at most once** per `(company_id, route, idempotency_key)` because:

1. The claim is a unique row in `request_keys`.
2. The claim, mutation, journal, bank row, audit, and response are in the **same transaction**.
3. A committed claim always has a stored response.
4. A rolled-back claim leaves no row.
5. A concurrent request either blocks on the unique index or sees the committed row.
6. There is **no timeout-based takeover**; a timeout only returns `409 IN_PROGRESS` to the client.

The design does not rely on wall-clock timeouts, leases, or heuristic cleanup. It relies on database transaction atomicity and the unique constraint.

---

## 12. Open Items for Phase A

- Confirm the exact canonical field lists for each route with the service owners.
- Decide whether to persist failure responses (`4xx`) in `request_keys` or allow retries after rollback. Recommended: allow retries after rollback (simpler, safer).
- Decide whether to add `completed_at`/`request_id` for observability. Recommended: add them in 0020 or 0021.
- Confirm `lock_timeout` values per route (e.g., 5s) and the client backoff policy.
- Update the API documentation and frontend key generation.
- Add the test suite to `tests/printing/contracts.test.ts` and `package.json`.