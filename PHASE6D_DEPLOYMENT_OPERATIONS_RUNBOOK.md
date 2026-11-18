# PHASE 6D — DEPLOYMENT & OPERATIONS RUNBOOK

## 1. Production installation
1. Install Node.js 22+.
2. Clone/copy application to a permanent directory (e.g., C:\PrimeERP).
3. Run `npm install`.
4. Run `npm run build` (creates `dist/`).
5. Configure environment variables (see section 2).
6. Start with `npm start` (NODE_ENV=production).

## 2. Environment configuration
Required env vars:
- NODE_ENV=production
- PORT (default 3000)
- PMS_PG_DATA_DIR (default .data/pms-pg) — MUST point to a persistent, backed-up directory outside the app source tree for updates.
- PMS_ATTACHMENTS_DIR (default .data/attachments)
- SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, SUPABASE_JWKS_URL
- AUTH_SESSION_SECRET (generate a strong random value; do not use fallback)
- AUTH_SESSION_TTL_SECONDS, AUTH_IDLE_TIMEOUT_SECONDS
- SMTP_* (optional, for report email)
- PMS_BACKUP_DIR (optional, default .data/backups)

## 3. Database initialization and migrations
- On startup, createServerDatabase initializes PGlite at PMS_PG_DATA_DIR.
- Migrations (0001-0016) auto-run.
- NEVER delete or replace the data directory during updates.

## 4. Backup scheduling
- Manual: POST /api/backup (admin). Response includes fileName, sizeBytes.
- Listing: GET /api/backups.
- Recommend scheduling via Windows Task Scheduler calling the endpoint or a script using createDatabaseBackup.
- Retention: default 10 most recent backups.

## 5. Application shutdown and restart
- Graceful shutdown on SIGINT/SIGTERM: scheduler stops, server closes, db closes.
- Restart: stop process, start with `npm start`. Data persists in PMS_PG_DATA_DIR.

## 6. Recovery procedure
1. Stop the application.
2. Identify the backup file in the backup directory.
3. Restore using PGlite loadDataDir (see Phase 6A drill): create a new PGlite instance with loadDataDir = backup blob, verify SELECT 1 and table/account counts, then replace data dir only after verification and explicit authorization.
4. Never overwrite production data dir without a verified backup and authorization.
5. Verify TB and BS balance after restore.

## 7. Rollback procedure
- Keep previous application build (dist/) and database backup before updating.
- To rollback: stop app, restore previous dist, restore database from pre-update backup, restart.

## 8. Administrator/operator runbook
- Health check: GET /api/health (returns database status).
- Logs: structured JSON to stdout; capture via process manager.
- Backup verification: run restore drill periodically.
- UAT: invoice, payment, bill, check, reporting workflows.

## 9. Docker
Not currently provided. Deployment is Node.js + PGlite file storage on Windows. Docker optional if containerizing, but must mount a persistent volume for PMS_PG_DATA_DIR.

## 10. Outstanding
- Automated backup scheduler (Windows Task Scheduler) to be configured by operator.
- Structured log aggregation (optional).
- Rate limiting is in-memory (single instance).

## Final verdict
PASS WITH CONDITIONS — Deployment procedure documented; operator must configure backups and verify restore drill in production environment.
