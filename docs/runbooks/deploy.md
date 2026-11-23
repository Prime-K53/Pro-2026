# Deploy & Rollback Runbook

**Scope:** Prime ERP production releases.
**Rule:** deploy only after the release gates pass and a verified backup exists.

## Pre-deploy

- [ ] All release gates green (unit, integration, regression, authz, accounting, security, e2e).
- [ ] `npm run lint` and `npm run build` pass.
- [ ] Migration plan reviewed; `schema_migrations` compared to live DB.
- [ ] Verified backup exists (`GET /admin/backup/status` → `ok: true`).
- [ ] Change approval recorded; release notes written.

## Deploy

1. Announce maintenance window (if the migration is not backward compatible).
2. Take a fresh backup/snapshot.
3. Apply migrations via the normal migration runner (never hand-edit `schema_migrations`).
4. Deploy the application build.
5. Smoke test:
   - `GET /api/health` → `status: ok`
   - Login as an administrator
   - Open POS, raise a test invoice, run a no-op payroll preview
   - `GET /api/admin/backup/status` → `ok: true`
6. Monitor error rates, p95 latency, and sync/queue health for the agreed soak period.
7. Record the release version and evidence in the change log.

## Rollback

1. Stop writes / place in maintenance mode.
2. Redeploy the previous application build.
3. If a migration was applied and is not backward compatible, restore the pre-deploy snapshot (see `restore.md`) — do not attempt to "unapply" destructive DDL on a live database.
4. Re-run the smoke tests.
5. Resume writes and monitor.
6. Record the rollback and root cause.

## Evidence

Attach to the change record: backup status, migration status, test results, smoke-test output, monitoring snapshot, and sign-off.