# Phase 3 — Authentication, Users, Sessions & Multi-Company Architecture

## 1. Reconstructed Company & Tenant Model (`SlowBooks-Pro-2026` Heritage)

In the reference `SlowBooks-Pro-2026` system, each company book is an isolated database boundary and global users hold per-company role memberships (`User ↔ CompanyMembership ↔ Company`), rather than mixing tenants inside shared unguarded tables.

In **Printing Management System**, this relationship is implemented cleanly without inventing an unrequested extra "tenant" layer:

```
  [Supabase Auth / Global User (`users`)]
                 │
                 │ 1 : N  (membership_version, role, is_active, expires_on, revoked_at)
                 ▼
       [Company Membership (`company_memberships`)]
                 │
                 │ N : 1
                 ▼
          [Company (`companies`)] ◄──── Active Tenant Isolation Boundary (RLS + Composite FKs)
```

- **Company = Isolation Boundary:** Every financial, inventory, HR/Payroll, exam production, contract, document, and audit table carries a mandatory `company_id` column, composite `(company_id, id)` foreign keys, and PostgreSQL `FORCE ROW LEVEL SECURITY` evaluated under least-privilege role `pms_app_role` (`NOSUPERUSER NOBYPASSRLS`).
- **One User, Many Companies:** A user (e.g., Director or External Accountant) can hold memberships in multiple separate company books (`Prime Educational Press Ltd`, `Copperbelt Printers & Stationery`, etc.) with independent roles per company.

---

## 2. Dual-Layer Authentication & Revocable Session Architecture

1. **Supabase Auth Integration (`ES256` JWKS + Admin Sync):**
   - Server configuration reads `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, and `SUPABASE_JWKS_URL` strictly from server environment variables (never exposed as user API-key prompts in UI).
   - Bearer JWT tokens are verified via `jose` `createRemoteJWKSet` against Supabase's `ES256` JWKS endpoint (`verifySupabaseJwt`), and user creations/resets synchronize with Supabase Auth Admin API when configured.
2. **Salted Password Hashing & HttpOnly Server-Tracked Sessions (`auth_sessions`):**
   - Passwords are hashed locally with salted Node `crypto.scryptSync` (`N=16384, r=8, p=1`), verified in constant time.
   - Browser clients receive an HMAC-SHA256 signed `HttpOnly; SameSite=Lax` cookie (`pms_session`), referencing a hashed row in `auth_sessions`.
   - Every authenticated request re-validates **in a single atomic database lookup**:
     - Valid HMAC signature + non-revoked session row (`revoked_at IS NULL`)
     - Absolute TTL (`expires_at > NOW()`) and inactivity idle timeout (`last_seen_at`)
     - Global user status (`users.is_active = TRUE` and `expires_on` not elapsed)
     - Global `users.session_version` matches the session's recorded `user_session_version`
     - Active company status (`companies.is_active = TRUE`)
     - Active membership status (`company_memberships.is_active = TRUE`, `revoked_at IS NULL`, `expires_on` not elapsed)
     - Company `company_memberships.membership_version` matches `auth_sessions.membership_version`

**Result:** Role changes, membership revocations, global deactivations, logouts, and password resets take effect **immediately** on the very next HTTP request—zero stale JWT waiting window.

---

## 3. Anti-IDOR & Parameter Tampering Protections

1. **Server-Derived Tenant Context:** Endpoints **never** read a target `companyId` from query params, request headers, or request bodies to authorize queries. The active `companyId` comes strictly from the verified server session (`req.auth.companyId`).
2. **`rejectCrossCompanyParams` Middleware:** Any request supplying `companyId`, `company_id`, or `X-Company-Id` that does not match `req.auth.companyId` is immediately rejected with `403 Forbidden` and writes a `CROSS_COMPANY_ATTEMPT` row into tamper-evident `audit_log`.
3. **Database RLS Enforcement:** All business queries run inside `db.withCompanyDb(req.auth.companyId, tx => ...)` which executes `SET LOCAL ROLE pms_app_role` and `set_config('app.current_company_id', companyId, true)`. Even if a SQL `WHERE` clause omitted `company_id`, PostgreSQL rejects cross-company rows and writes.
4. **Protected Attachments & Exports:** Uploaded files are persisted under company-scoped directories (`company_<id>/`), indexed in RLS-protected `stored_files` / `attachments`, sanitized with `path.basename`, and CSV report exports write `REPORT_EXPORTED` audit records inside `withCompanyDb`.
