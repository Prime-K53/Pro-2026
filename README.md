# Printing Management System

A full-stack printing & accounting ERP (React 19 + Vite + Express + embedded PostgreSQL via PGlite). Covers accounting (invoices, bills, banking, inventory), printing operations (quick print, production, exams, printing contracts), payroll, POS, AI document OCR, and analytics — with row-level tenant isolation, an append-only audit trail, and a checksummed migration system.

## Prerequisites
- Node.js >= 20
- pnpm (or npm)

## Getting started
```bash
pnpm install
cp .env.example .env   # fill in Supabase + secrets
pnpm dev               # starts Express + Vite middleware at http://localhost:3000
```

## Scripts
| Command | Description |
|---------|-------------|
| `pnpm dev` | Dev server (Express + Vite) |
| `pnpm build` | Production frontend build |
| `pnpm start` | Run the production server (serves `dist/`) |
| `pnpm lint` | TypeScript typecheck |
| `pnpm test` | Run the test suite |
| `pnpm test:coverage` | Coverage (80/80/70 gates) |
| `pnpm test:e2e` | Playwright E2E |

## Production configuration
In production the server **refuses to start** without `AUTH_SESSION_SECRET` and `TOTP_ENC_KEY`, and demo/seed data is never created. Set:
- `AUTH_SESSION_SECRET` — `openssl rand -hex 32`
- `TOTP_ENC_KEY` — `openssl rand -hex 32`
- `APP_URL`, `CORS_ALLOWED_ORIGINS` (comma-separated)
- `NODE_ENV=production`

## Deployment
- **Docker:** `docker build -t pms . && docker run -p 3000:3000 --env-file .env pms`
- **Manual:** `pnpm build && pnpm start` (see `docs/runbooks/deploy.md`)

## Architecture & docs
- `docs/database/database-architecture.md`, `ERD.md`
- `docs/commercial/api-documentation.md`
- `docs/runbooks/deploy.md`, `docs/runbooks/restore.md`
- `docs/security/*`, `docs/release/*`

## Security
Row-level security with a least-privilege DB role, scrypt password hashing, HMAC-signed sessions, CSRF protection, Helmet headers, CORS allowlist, encrypted secrets at rest, and an append-only (hash-chained) audit log. Backups are admin-only with a fixed server-side directory.