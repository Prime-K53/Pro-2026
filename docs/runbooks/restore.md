# Restore Runbook

**Scope:** Prime ERP database restoration.
**Rule:** Restoration is a privileged, explicitly confirmed, audited operator
procedure. There is **no** ordinary HTTP endpoint that restores a production
database.

## Preconditions

- [ ] A verified backup exists (`GET /admin/backup/status` → `ok: true`).
- [ ] The operator has database provider access (Supabase/Postgres).
- [ ] A pre-restore backup has been taken immediately before the restore.
- [ ] Change approval is recorded.

## Procedure

1. **Freeze writes** — place the application in maintenance mode (stop the
   service or disable the load balancer route).
2. **Take a pre-restore backup** using the provider's snapshot/PITR feature.
   Record the snapshot id and timestamp.
3. **Identify the restore point** — choose the latest verified backup or a
   point-in-time recovery target.
4. **Restore** using the provider's supported recovery capability
   (Supabase PITR / database snapshot restore). Do not restore over a live
   primary without provider guidance.
5. **Verify** after restore:
   - `npm run test:accounting` (trial balance = 0).
   - `GET /admin/health` → `status: ok`.
   - Spot-check recent invoices, payments, and inventory counts.
   - Confirm `schema_migrations` matches the deployed release.
6. **Resume writes** and monitor error rates and sync health.
7. **Record** the restore in the audit log: operator, timestamp, restore
   point, pre-restore snapshot id, verification results.

## Rollback

If verification fails, restore the pre-restore snapshot and repeat from step 1.

## Evidence

Attach to the change record: backup status output, snapshot id, test results,
and sign-off.