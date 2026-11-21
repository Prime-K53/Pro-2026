# EXAM_PRINTING_CONTENT_STORAGE_DESIGN.md

**Module:** PRIME ERP — Examination Printing
**Phase:** 0 — Repository-First Baseline Audit
**Date:** 21 November 2026

This document specifies the **target** design for confidential examination content (D4 + Phase 2). It is a design, not an implementation record. Every item marked **[PROPOSED]** requires the approvals noted and must not be represented as complete.

---

## 1. Current state (verified)

- No confidential-content subsystem exists.
- Generic storage: `stored_files` (`0006:345-357`) + `attachments` (`0006:365-383`), local filesystem, base64-over-JSON upload, cookie-authenticated download (`protectedRoutes.ts:669-770`), inline preview (`documentsRoutes.ts:187-225`).
- No encryption at rest, no signed URLs, no versioning, no retention/disposal, no sensitivity classification.
- `exams:view_confidential` defined but unenforced.
- `exams:view` returns cost fields to all holders.

This design adds a dedicated confidential store for examination artwork and proofs without disturbing the existing generic attachment flow used elsewhere.

---

## 2. Design principles

1. **Application-authorised access only.** Every confidential endpoint checks `exams:view_confidential` (or a narrower grant) **and** company scope before any bytes are served. Direct storage access must not be possible without going through the app.
2. **No permanent public URLs.** Access is via short-lived signed URLs issued per request; URLs expire and are bound to a purpose (view/download).
3. **Encryption in transit and at rest.** TLS in transit; content encrypted at rest with a key the database does not hold.
4. **Tenant isolation.** Content metadata is company-scoped (RLS + composite FK); file keys embed the company id and are unguessable.
5. **Full auditability.** Every upload, view, download, failed attempt and disposal writes an immutable audit record with actor identity.
6. **Retention-aware.** Content is retained 7 years from formal exam completion (D4, pending Legal), then securely deleted after a hold check.

---

## 3. Data model **[PROPOSED]**

New migration (next free number, see Migration Plan). Additive only.

### 3.1 `exam_confidential_files`

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT identity PK | |
| `company_id` | BIGINT NOT NULL → companies | tenant scope |
| `exam_paper_id` | BIGINT NULL → exam_papers (composite) | optional link to a paper |
| `exam_batch_id` | BIGINT NULL → exam_assessment_batches (composite) | optional link to a batch |
| `category` | VARCHAR(24) NOT NULL | `artwork` \| `proof` \| `marking_scheme` \| `answer_sheet` \| `other` (CHECK) |
| `version` | INTEGER NOT NULL DEFAULT 1 | per `(company_id, logical_name)` |
| `logical_name` | VARCHAR(200) NOT NULL | groups versions of the same document |
| `original_name` | VARCHAR(255) NOT NULL | display name |
| `content_type` | VARCHAR(120) NOT NULL | server-validated allowlist |
| `size_bytes` | BIGINT NOT NULL CHECK >= 0 | |
| `sha256_hex` | CHAR(64) NOT NULL | integrity + dedupe |
| `storage_key` | VARCHAR(400) NOT NULL | opaque, embeds company id, **not** a public path |
| `encryption_key_id` | VARCHAR(80) NOT NULL | references KMS/keyring id (never the key itself) |
| `watermarked` | BOOLEAN NOT NULL DEFAULT FALSE | proof watermark status |
| `retention_started_at` | TIMESTAMPTZ | set at formal exam completion |
| `retention_until` | TIMESTAMPTZ | `retention_started_at + 7 years` (computed) |
| `disposed_at` | TIMESTAMPTZ NULL | set on authorised disposal |
| `disposed_by` | BIGINT NULL → users | |
| `disposal_reason` | TEXT NULL | |
| `legal_hold` | BOOLEAN NOT NULL DEFAULT FALSE | blocks disposal |
| `uploaded_by` | BIGINT NOT NULL → users | |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Constraints:
- `UNIQUE (company_id, id)` for composite FKs.
- `UNIQUE (company_id, logical_name, version)`.
- `CHECK (category IN (...))`.
- RLS ENABLE+FORCE + `app_rls_allowed(company_id)`.
- Append-only for disposal fields (trigger preventing clear-once-set, mirroring `exam_paper_events` immutability pattern).

### 3.2 `exam_confidential_file_access` (append-only audit)

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT identity PK | |
| `company_id` | BIGINT NOT NULL | |
| `file_id` | BIGINT NOT NULL → exam_confidential_files (composite) | |
| `action` | VARCHAR(16) NOT NULL | `upload` \| `view` \| `download` \| `failed_access` \| `dispose` (CHECK) |
| `actor_user_id` | BIGINT NOT NULL → users | |
| `actor_ip` | VARCHAR(64) NULL | |
| `user_agent` | VARCHAR(300) NULL | |
| `signed_url_id` | VARCHAR(80) NULL | correlates to issued URL |
| `outcome` | VARCHAR(16) NOT NULL | `success` \| `denied` \| `expired` (CHECK) |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Constraints: RLS + append-only trigger (no UPDATE/DELETE).

### 3.3 `exam_confidential_signed_urls` (short-lived URL registry)

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT identity PK | |
| `company_id` | BIGINT NOT NULL | |
| `file_id` | BIGINT NOT NULL (composite) | |
| `token_hash` | CHAR(64) NOT NULL | SHA-256 of the opaque token (never store raw) |
| `purpose` | VARCHAR(8) NOT NULL | `view` \| `download` |
| `issued_to_user_id` | BIGINT NOT NULL | bound to requester |
| `expires_at` | TIMESTAMPTZ NOT NULL | short TTL (e.g. 120s) |
| `consumed_at` | TIMESTAMPTZ NULL | single-use on download |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Constraints: RLS; `CHECK (expires_at > created_at)`; consumed rows rejected on reuse.

---

## 4. Access flow **[PROPOSED]**

```
Client (ExaminationView "view artwork"/"download proof")
  │  1. GET/POST /api/printing/exam-confidential/:fileId/signed-url?purpose=view
  ▼
Route: requireAuth + requirePermission('exams:view_confidential') + rejectCrossCompanyParams
  │  2. withCompanyDb(companyId) → verify file belongs to company (404 if not)
  │  3. Verify caller is permitted for THIS file (role + any paper-level ACL)
  │  4. Mint opaque token; store token_hash with 120s expiry + user binding
  │  5. Write audit: signed_url_issued
  ▼
Returns short-lived signed URL: /api/printing/exam-confidential/:fileId/content?token=...&expires=...
  │
  ▼
Client fetches URL
  │  6. Route re-checks auth (cookie) OR validates token (hash match, not expired, not consumed, user match)
  │  7. Load encrypted blob by storage_key; decrypt with keyring; stream
  │  8. Set Content-Disposition: attachment; Content-Type from allowlist; Cache-Control: no-store
  │  9. Mark token consumed (download) ; write audit: download success (actor, ip, ua)
  ▼
Bytes to client (never a public URL; never guessable; expires; single-use for download)
```

Rules:
- **No endpoint returns a permanent/public URL.** The signed URL is per-request, expiring, and (for download) single-use.
- **Every confidential endpoint enforces `exams:view_confidential`** (not `exams:view`) and company scope.
- **Direct storage access is impossible from outside the app** — blobs live outside the web root (or in a private bucket) and are only read by the server after authorisation.
- **Failed/expired/revoked attempts** write `failed_access`/`denied`/`expired` audit rows and return 403/404 without leaking existence.

---

## 5. Encryption & key management **[PROPOSED]**

- **At rest:** envelope encryption. A per-object content key (DEK) encrypts the blob; the DEK is wrapped by a key-encryption key (KEK) held in a keyring/KMS (or an environment-provided master key in dev). The database stores only `encryption_key_id` (the wrapped-DEK reference), never the KEK or plaintext DEK.
- **In transit:** TLS terminated at the server/proxy; `HSTS` and secure cookies.
- **Key rotation:** KEK rotation re-wraps DEKs without re-encrypting blobs; tracked by `encryption_key_id`.
- **No plaintext in DB, logs or error messages.** Object keys are opaque and include a random component.

> Implementation must use the existing `crypto`/platform facilities. Do not introduce a new secret store without Operations approval.

---

## 6. Watermarking **[PROPOSED]**

- Proofs and artwork classified `proof`/`artwork` may be watermarked on download with the requesting user's identity + timestamp (visible + metadata) to deter leaks.
- Watermarking is applied at download time (server-rendered or header-embedded per format). Original stored blob remains unmodified.
- Whether watermarking is mandatory per category is a **business decision** (Operations) — flagged pending.

---

## 7. Retention & disposal (D4) **[PROPOSED — Legal pending]**

- **Commencement:** formal examination completion date (per paper/batch). When a paper reaches its terminal `completed`/`delivered` state tied to a formal exam, `retention_started_at` is set and `retention_until = +7 years`.
- **Protection:** while `legal_hold = TRUE` or `now < retention_until`, disposal is blocked.
- **Disposal job:** a scheduled, audited job (see `scheduler.ts` pattern) that:
  1. Selects `retention_until < now() AND legal_hold = FALSE AND disposed_at IS NULL`.
  2. Re-checks holds (school/contract/legal).
  3. Securely deletes the encrypted blob (crypto-shred the DEK).
  4. Sets `disposed_at/disposed_by/disposal_reason`, writes `dispose` audit row.
- **Exceptional deletion** (before retention end) requires explicit authorisation (Records/Legal) and an audit record.
- **Statutory/contractual longer retention** overrides the 7-year default (Legal to confirm).

**Gate:** The 7-year commencement is **selected** but **not Legally approved**. Disposal logic must not run against production until Records/Legal sign-off (hold procedures, exceptional deletion, longer-retention rules).

---

## 8. Audit events

| Action | Table | Trigger |
|---|---|---|
| Upload | `exam_confidential_file_access` + `audit_log` | on store |
| View (URL issued) | `exam_confidential_file_access` (`signed_url_issued`) | on mint |
| Download success | `exam_confidential_file_access` (`download/success`) | on serve |
| Failed/expired/denied | `exam_confidential_file_access` (`failed_access/denied/expired`) | on rejection |
| Disposal | `exam_confidential_file_access` (`dispose`) + `audit_log` | on secure delete |

All access tables are append-only (no UPDATE/DELETE) and company-scoped.

---

## 9. Tenant isolation for content

- Metadata tables RLS-scoped + composite FKs to `exam_papers`/`exam_assessment_batches` (company, id).
- File keys embed company id and a random component; a valid key from company A cannot resolve company B's blob because the DB lookup is RLS-scoped and the key is unguessable.
- Signed URLs are bound to the issuing user and company; cross-company use fails (404) and is audited.

---

## 10. Testing (Phase 2 gate)

The 8 security tests in `EXAM_PRINTING_SECURITY_REVIEW.md` §6 must pass, plus:
- Blob is unreadable without the server (direct storage path guess returns nothing/decrypt failure).
- Expired token rejected; single-use download token rejected on reuse.
- Revoked `exams:view_confidential` blocks subsequent access immediately.
- Every success has actor identity + event; every failure recorded.
- Cross-company signed URL → 404 + audit.

---

## 11. Open decisions before implementation

| # | Decision | Owner |
|---|---|---|
| C-1 | Retention commencement sign-off + hold/exceptional-deletion procedures | Records/Legal |
| C-2 | Statutory/school/contractual longer-retention overrides | Records/Legal |
| C-3 | Watermarking mandatory per category | Operations |
| C-4 | Keyring/KMS choice and rotation policy | Security/Operations |
| C-5 | Whether `exams:view_confidential` is the right grant or a narrower per-paper ACL is needed | Product/Security |

No production deployment of this subsystem until C-1 and C-4 are resolved.