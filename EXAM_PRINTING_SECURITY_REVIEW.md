# EXAM_PRINTING_SECURITY_REVIEW.md

**Module:** PRIME ERP — Examination Printing
**Phase:** 0 — Repository-First Baseline Audit
**Date:** 21 November 2026

Scope: authentication, authorization, tenant isolation and confidential-content handling as they affect the Examination Printing Module. Findings are evidence-cited. This review records the **current** state and the **required** controls; it is not a certification.

---

## 1. Authentication (verified)

- Two paths, both resolved in `createAuthMiddleware` (`src/server/middleware/auth.ts:89`):
  1. **Signed HttpOnly cookie** `pms_session` = `<rawToken>.<HMAC-SHA256>` (`supabaseAuth.ts:117-136`, constant-time compare). Raw token stored only as SHA-256 hash (`auth.ts:108`). Identity from `auth_sessions`→`users`→`companies`→`company_memberships` join (`:110-143`). Per-request re-validation of revocation, expiry, idle timeout, user/company/membership active, `session_version`, `membership_version` (`:151-185`).
  2. **Supabase Bearer JWT** verified via JWKS (`supabaseAuth.ts:49-73`), issuer-checked; local user resolved by `supabase_uid = sub OR lower(email)=lower(claims.email)` (`auth.ts:251-257`).
- Password hashing: salted scrypt N=16384 (supabaseAuth.ts:79-103).
- `companyId`, `membershipId`, `role` are **server-derived**, never client-supplied (`auth.ts:196-212`).

**Hardening gaps (verified):**
- Bearer JWT path has **no audience/algorithm pinning** (`supabaseAuth.ts:57-61`) and an **email-claim fallback** (`auth.ts:251-257`) — a Supabase email claim matching a local user maps to that user. Low risk with EC JWKS but should be pinned.
- Session HMAC fallback secret is deterministic `sha256(cwd)` when `AUTH_SESSION_SECRET` unset (`config.ts:27-30,54`).

## 2. Authorization model (verified)

- 94 permissions in `permissions.ts:16-110`; 5 roles; `hasPermission(role, permission)` (`:424-426`).
- 12 exam permissions (`:76-87`). **Only 8 are enforced**: `exams:view/create/approve/produce/qc/dispatch/deliver/cancel`. **Dead (defined, never enforced): `exams:view_confidential`, `exams:edit`, `exams:invoice`, `exams:manage_permissions`.**
- Exam routes protected (`printingRoutes.ts:469,942,954,970,995,1027,1044,1065,1081,1092,1111`). Status route uses inline `hasPermission` (`:1004-1008`) instead of middleware.
- Exam invoicing is gated by `invoices:write` (`documentsRoutes.ts:144-146`), **not** `exams:invoice` — a segregation-of-duties gap (ProductionManager cannot invoice, but a Bookkeeper/Accountant can without the exam-specific grant; conversely `exams:invoice` grants are meaningless).

## 3. Tenant isolation (verified for exam endpoints)

- `withCompanyDb` sets `SET LOCAL ROLE pms_app_role` + `app.current_company_id` (`db.ts:620-630`); `pms_app_role` is `NOBYPASSRLS` (`0001:26-28`).
- RLS ENABLE+FORCE + `app_rls_allowed(company_id)` on all exam tables (`0007:228-275`, `0024:202-246`).
- Composite FKs `(company_id, parent_id)` on all exam children — cross-tenant references fail at DB even with `bypass_rls` on (verified `migration-suite.ts:365-409`).
- `rejectCrossCompanyParams` → 403 + `CROSS_COMPANY_ATTEMPT` audit on param/header/body tampering (`auth.ts:347-391`).
- Every service query filters `WHERE company_id = $1`.
- **Cross-tenant object access returns 404** (row filtered by RLS), while **parameter tampering returns 403**. Consistent policy: 404 for object, 403 for param.

**Gap:** no exam-specific negative tests exist. Tenant isolation is implemented but not proven for exam endpoints (Phase 6).

## 4. Confidential content (verified absent — ZERO-TOLERANCE BLOCKER)

- **No** artwork/proof upload, storage, versioning, encryption, signed URL, or watermarking for exams anywhere.
- `exams:view_confidential` is granted to Administrator/ProductionManager/Accountant (`permissions.ts:183,323,367`) but enforced by **no route**.
- Exam read endpoints return `paperCost`/`tonerCost`/`materialCost`/`classRevenue` to any `exams:view` holder including Read-Only and Bookkeeper (`printingRecordsService.ts:3397-3399,4172-4179`), **bypassing** the `estimates:read_costs` redaction used elsewhere.
- Generic file storage (`stored_files`/`attachments`, `0006:345-383`) is local-filesystem, base64-over-JSON upload (`protectedRoutes.ts:669-723`), cookie-authenticated download, **no encryption at rest, no signed URLs, no expiry, no versioning**.
- Attachment preview served `Content-Disposition: inline` with client-supplied `Content-Type` (`documentsRoutes.ts:214-219`) + `X-Content-Type-Options: nosniff` but **no CSP** → stored-XSS risk on the app origin.

**Status:** D4 (7-year retention) and Phase 2 (confidential security) are entirely unimplemented. This is the primary certification blocker.

## 5. Broader security posture (verified, affects exam confidentiality)

| # | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | Critical | Migration ETL routes return **all tenants'** data to any `audit:read` holder (queries `SET LOCAL app.bypass_rls='on'`, no company predicate) | `migrationRoutes.ts:117-143,283-318`; `slowbooksMigrationService.ts:4055-4099` |
| S2 | Critical | Migrated users with no source hash get active accounts with hard-coded password `MigratedSlowBooks#2026`, `must_change_password=FALSE` | `slowbooksMigrationService.ts:466,500` |
| S3 | High | `POST /api/backup`, `GET /api/backups` require only `reports:read` (Read-Only has it), dump whole cluster, return server file path; `backupDir` client-controlled | `backupRoutes.ts:13,25`; `backupService.ts:12-39` |
| S4 | High | `exams:view_confidential` unenforced; exam costs leak to Read-Only/Bookkeeper | §4 |
| S5 | High | No `helmet`/CSP/CORS/CSRF; production cookies `SameSite=None`; inline attachment preview → stored XSS | `app.ts`, `documentsRoutes.ts:214-220`, `protectedRoutes.ts:672` |
| S6 | Medium | `exams:invoice`/`exams:edit`/`exams:manage_permissions` dead permissions | §2 |
| S7 | Medium | Rate limiting production-only, in-memory/per-process; `login_attempts` written but never read (no lockout) | `app.ts:59-64`; `rateLimiter.ts`; `audit.ts:53-62` |
| S8 | Medium | Session HMAC fallback deterministic when `AUTH_SESSION_SECRET` unset | `config.ts:27-30,54` |

S1–S3 are **not examination-module defects** but they undermine the tenant-isolation and confidentiality guarantees the exam module relies on (shared DB, shared backup, shared migration tooling). They must be resolved or explicitly risk-accepted before certification.

## 6. Required security tests (Phase 2/6)

The confidential-content gate is zero-tolerance. Phase 2 must add automated tests proving:

1. ProductionManager without `exams:view_confidential` receives HTTP 403 on confidential endpoints.
2. Another company's authorised user cannot access confidential content (404).
3. Cross-company access follows the established 403/404 policy.
4. Expired signed URLs cannot be reused.
5. Revoked permissions prevent subsequent access.
6. Direct storage access cannot bypass application authorisation.
7. Every successful confidential download has an auditable identity and event.
8. Failed unauthorised access attempts are recorded appropriately.

Plus Phase 6 negative tests for every exam endpoint (papers, batches, production events, reservations, material issues, reconciliation, reprints, cancellation, invoice transitions, confidential files), other-company ids, missing permissions, cancelled/invoiced terminal states.

## 7. Threat review (documented)

| Threat | Vector | Current control | Gap / Required action |
|---|---|---|---|
| Cross-tenant data access | Forged paper/batch id | RLS + composite FK + 404 | Proven for DB; needs exam endpoint negative tests |
| Cost/revenue disclosure | `exams:view` (incl. Read-Only) | none for exam costs | Enforce `estimates:read_costs`-style redaction or `exams:view_confidential` for cost fields |
| Confidential artwork leak | No confidential endpoint | n/a | Implement Phase 2 store with signed URLs + `exams:view_confidential` |
| Stored XSS via upload | Inline preview, client Content-Type | `nosniff` only | Add CSP, force `attachment` disposition, content-type allowlist |
| Backup exfiltration | `reports:read` on backup routes | none beyond permission | Restrict to admin; never expose server paths |
| Migration data leak | `bypass_rls` migration routes | none | Add company scoping or admin-only |
| Default/hard-coded credentials | Demo seed + migrated users | demo seed only in dev; migrated users hard-coded | Force reset; remove demo seed in prod |
| Session forgery | Deterministic HMAC fallback | cookie HMAC | Require `AUTH_SESSION_SECRET` in prod |
| Rate-limit bypass | In-memory, per-process, `x-forwarded-for` spoof for audit | none | `trust proxy` + shared store + account lockout |

## 8. Security verdict

**Not secure enough for confidential examination content.** Tenant isolation and authentication are strong and RLS-backed, but:
- Confidential content is entirely unprotected (Phase 2 blocker).
- `exams:view_confidential` and `exams:invoice` are dead permissions.
- Cost fields leak to read-only roles.
- Shared infrastructure (migration routes, backups, inline preview) has high-severity issues that undermine the confidentiality guarantee.

These must be closed and independently tested before any 99.8% certification claim.