# Phase 3 — Security, RBAC & Multi-Company Isolation Test Execution Report

- **Execution Timestamp (UTC):** 2026-11-23T03:32:10.146Z
- **Runtime Stack:** Express HTTP Server + PostgreSQL (PGlite WASM) RLS + Supabase JWKS
- **Result Summary:** **6 / 6 tests passed** (2070 ms total)

## Test Matrix Results

| # | Suite | Test Case | Status | Duration | Verification Notes |
|---|---|---|---|---|---|
| 1 | 1. Authentication & Fail-Closed | Unauthenticated requests fail closed (401) on all protected endpoints | PASS | 157 ms | 12 protected endpoints rejected anon (401); live Supabase JWKS verified & forged JWT rejected |
| 2 | 2. Cross-Company Isolation | Block cross-tenant reads, attachments IDOR, report leaks & parameter tampering | PASS | 467 ms | Attachment IDOR blocked (404), cross-company invoice ID blocked (404), query/header/body tampering rejected (403) & audited |
| 3 | 3. Company Switching | Authorized switch changes RLS scope; unauthorized target company rejected (403) | PASS | 54 ms | Company B switch isolated inventory & financial view; unauthorized switch to Company C denied (403) |
| 4 | 4. Five-Role RBAC & Redaction | Enforce server-side role permissions, Payroll block, and Estimate/HR field redaction | PASS | 518 ms | Verified Administrator, Bookkeeper, Accountant (#824 redacted), and ProductionManager server enforcement |
| 5 | 5. Invitations, Read-Only & Revocation | Invite lifecycle, Read-Only mutation blocks, last-admin guard (409), instant revocation | PASS | 389 ms | One-time invite accepted & single-use enforced; Read-Only mutations blocked; last-admin guarded (409); revoked session failed immediately |
| 6 | 6. Deactivation, Logout, Expiry & Password Reset | Account deactivation, logout, idle expiry & password reset invalidate existing sessions immediately | PASS | 485 ms | Logout replay blocked (401), password reset killed prior sessions (401), deactivation blocked active session, expired session rejected |

## Verified Security Controls

- [x] Unauthenticated calls return `401 Unauthorized` across all protected APIs
- [x] Forged JWTs rejected (`401`); live Supabase ES256 JWKS endpoint verified reachable
- [x] Cross-company invoice IDs, attachments, financial summaries, and CSV exports isolated (`404`/`403`)
- [x] Cross-company query/header/body parameter tampering rejected (`403`) and logged as `CROSS_COMPANY_ATTEMPT`
- [x] Company switching verifies active membership and rotates RLS tenant context cleanly
- [x] All 5 RBAC roles enforced server-side (`Administrator`, `Bookkeeper`, `Accountant`, `ProductionManager`, `Read-Only`) including `#824` estimate cost redaction and HR/Payroll protection
- [x] One-time invitations, last-administrator protection (`409`), immediate revocation, deactivation, logout replay prevention, session expiry, and password-reset session invalidation verified
