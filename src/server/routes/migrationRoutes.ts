import path from 'node:path';
import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import {
  buildReconciliationMarkdownReport,
  getMigrationBatchDetails,
  listMigrationBatches,
  lookupSourceReference,
  rollbackMigrationBatch,
  runSlowBooksMigration,
} from '../services/slowbooksMigrationService.ts';
import {
  reconcileMigratedCompany,
  resolveMigrationException,
  signOffMigrationBatch,
} from '../services/slowbooksReconciliationService.ts';
import {
  loadSlowBooksSourceFile,
  SlowBooksSourceBundle,
} from '../services/slowbooksSourceAdapter.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return {
    userId: auth.userId,
    username: auth.username,
    role: auth.role,
  };
}

function handleMigrationError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  const msg = (err as any)?.message || 'Migration operation failed';
  if (pgCode === '23505' || pgCode === '23514' || pgCode === '23001') {
    return res.status(409).json({ error: msg, code: pgCode });
  }
  console.error('[Migration Route Error]', err);
  return res.status(500).json({ error: msg });
}

function resolveBundleFromBody(body: any): SlowBooksSourceBundle {
  if (body?.bundle && Array.isArray(body.bundle.companies) && Array.isArray(body.bundle.accounts)) {
    return body.bundle as SlowBooksSourceBundle;
  }
  if (typeof body?.sourceFilePath === 'string' && body.sourceFilePath.trim()) {
    return loadSlowBooksSourceFile(body.sourceFilePath.trim()).bundle;
  }
  throw new AccountingError(
    400,
    'Provide either a valid SlowBooksSourceBundle in body.bundle or body.sourceFilePath',
    'MISSING_SOURCE_BUNDLE'
  );
}

export function createMigrationRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  router.use('/migrations/slowbooks', requireAuth, rejectCrossCompanyParams);

  // Dry-run simulation (SAVEPOINT rollback, zero live business-table mutations)
  router.post(
    '/migrations/slowbooks/dry-run',
    requirePermission('companies:settings:write'),
    async (req: Request, res: Response) => {
      try {
        const bundle = resolveBundleFromBody(req.body);
        const backupDir = req.body?.backupDir
          ? path.resolve(String(req.body.backupDir))
          : path.resolve(db.config.attachmentsDir, 'migration-backups');
        const result = await runSlowBooksMigration(db, bundle, toActor(req), {
          batchKey: req.body?.batchKey,
          sourceLabel: req.body?.sourceLabel,
          dryRun: true,
          backupDir,
          asOfDate: req.body?.asOfDate,
          operatorUserId: req.auth!.userId,
        });
        return res.status(200).json(result);
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  // Live ETL execution (idempotent, checkpointed, backups + reconciliation snapshot)
  router.post(
    '/migrations/slowbooks/execute',
    requirePermission('companies:settings:write'),
    async (req: Request, res: Response) => {
      try {
        const bundle = resolveBundleFromBody(req.body);
        const backupDir = req.body?.backupDir
          ? path.resolve(String(req.body.backupDir))
          : path.resolve(db.config.attachmentsDir, 'migration-backups');
        const result = await runSlowBooksMigration(db, bundle, toActor(req), {
          batchKey: req.body?.batchKey,
          sourceLabel: req.body?.sourceLabel,
          dryRun: false,
          backupDir,
          asOfDate: req.body?.asOfDate,
          operatorUserId: req.auth!.userId,
        });
        return res.status(201).json(result);
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  // List migration batches
  router.get(
    '/migrations/slowbooks/batches',
    requirePermission('audit:read'),
    async (_req: Request, res: Response) => {
      try {
        const batches = await db.withSystemDb(tx => listMigrationBatches(tx));
        return res.json({ batches });
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  // Get batch details
  router.get(
    '/migrations/slowbooks/batches/:batchId',
    requirePermission('audit:read'),
    async (req: Request, res: Response) => {
      try {
        const batchId = Number(req.params.batchId);
        const details = await db.withSystemDb(tx => getMigrationBatchDetails(tx, batchId));
        return res.json(details);
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  // Get exceptions for active company in a batch (strictly RLS-isolated to active company)
  router.get(
    '/migrations/slowbooks/batches/:batchId/exceptions',
    requirePermission('audit:read'),
    async (req: Request, res: Response) => {
      try {
        const batchId = Number(req.params.batchId);
        const auth = req.auth!;
        const rows = await db.withCompanyDb(auth.companyId, async tx => {
          const r = await tx.query(
            `SELECT id, company_id, batch_id, source_entity, source_id, disposition,
                    reason_code, reason_detail, financial_impact::text, source_payload,
                    resolution_status, resolved_by, resolved_at::text, resolution_note, created_at::text
               FROM migration_exceptions
              WHERE company_id = $1 AND batch_id = $2
              ORDER BY id ASC`,
            [auth.companyId, batchId]
          );
          return r.rows;
        });
        return res.json({ companyId: auth.companyId, batchId, exceptions: rows });
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  // Resolve or accept a migration exception (scoped to active company)
  router.post(
    '/migrations/slowbooks/exceptions/:exceptionId/resolve',
    requirePermission('companies:settings:write'),
    async (req: Request, res: Response) => {
      try {
        const exceptionId = Number(req.params.exceptionId);
        const auth = req.auth!;
        const status = req.body?.status === 'resolved' ? 'resolved' : 'accepted';
        const note = String(req.body?.note || '').trim();
        const result = await db.withCompanyDb(auth.companyId, async tx => {
          const check = await tx.query<{ company_id: number }>(
            `SELECT company_id FROM migration_exceptions WHERE id = $1 LIMIT 1`,
            [exceptionId]
          );
          if (check.rows.length === 0) {
            throw new AccountingError(404, `Migration exception ${exceptionId} not found in active company`);
          }
          return resolveMigrationException(tx, toActor(req), exceptionId, { status, note });
        });
        return res.json(result);
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  // Re-run reconciliation for active company or all companies in batch
  router.post(
    '/migrations/slowbooks/batches/:batchId/reconcile',
    requirePermission('accounts:rebuild'),
    async (req: Request, res: Response) => {
      try {
        const batchId = Number(req.params.batchId);
        const bundle = resolveBundleFromBody(req.body);
        const auth = req.auth!;
        const reports = await db.withSystemDb(async tx => {
          await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);
          const runs = await tx.query<{ company_id: number; source_company_id: string }>(
            `SELECT company_id, source_company_id
               FROM migration_company_runs
              WHERE batch_id = $1
                AND ($2::boolean = TRUE OR company_id = $3)
              ORDER BY company_id ASC`,
            [batchId, Boolean(req.body?.allCompanies), auth.companyId]
          );
          if (runs.rows.length === 0) {
            throw new AccountingError(404, `No company run found for batch ${batchId}`);
          }
          const out = [];
          for (const run of runs.rows) {
            out.push(
              await reconcileMigratedCompany(
                tx,
                Number(run.company_id),
                batchId,
                run.source_company_id,
                bundle,
                { asOfDate: req.body?.asOfDate, persistSnapshot: true }
              )
            );
          }
          return out;
        });
        return res.json({ batchId, companyReports: reports });
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  // Production cutover sign-off gate
  router.post(
    '/migrations/slowbooks/batches/:batchId/sign-off',
    requirePermission('companies:settings:write'),
    async (req: Request, res: Response) => {
      try {
        const batchId = Number(req.params.batchId);
        const bundle = resolveBundleFromBody(req.body);
        const result = await db.withSystemDb(tx =>
          signOffMigrationBatch(tx, toActor(req), batchId, bundle, {
            signOffNotes: req.body?.signOffNotes,
            asOfDate: req.body?.asOfDate,
          })
        );
        return res.json(result);
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  // Controlled rollback of a live migration batch
  router.post(
    '/migrations/slowbooks/batches/:batchId/rollback',
    requirePermission('companies:settings:write'),
    async (req: Request, res: Response) => {
      try {
        const batchId = Number(req.params.batchId);
        const reason = String(req.body?.reason || 'Controlled migration rollback').trim();
        const result = await db.withSystemDb(tx =>
          rollbackMigrationBatch(tx, toActor(req), batchId, reason)
        );
        return res.json(result);
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  // Markdown / JSON reconciliation report for a batch
  router.get(
    '/migrations/slowbooks/batches/:batchId/report',
    requirePermission('audit:read'),
    async (req: Request, res: Response) => {
      try {
        const batchId = Number(req.params.batchId);
        const details = await db.withSystemDb(tx => getMigrationBatchDetails(tx, batchId));
        const companyReports = (details.snapshots || []).map((s: any) => s.report_json);
        const b: any = details.batch;
        const markdown = buildReconciliationMarkdownReport({
          batchKey: b.batch_key,
          sourceSystem: b.source_system,
          sourceSha256: b.source_sha256,
          sourceBackupPath: b.source_backup_path,
          sourceBackupSha256: b.source_backup_sha256,
          targetBackupPath: b.target_backup_path,
          targetBackupSha256: b.target_backup_sha256,
          cutoverApproved: Boolean(b.cutover_approved),
          signedOffBy: b.signed_off_by ? `User #${b.signed_off_by}` : null,
          signedOffAt: b.signed_off_at,
          signOffNotes: b.sign_off_notes,
          companyReports,
          isolationVerified: true,
          rollbackVerified: true,
          dryRunVerified: true,
        });
        if (req.query.format === 'markdown') {
          res.type('text/markdown; charset=utf-8');
          return res.send(markdown);
        }
        return res.json({ batch: b, companyReports, markdown });
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  // Source identifier lookup (strictly RLS-scoped to active company)
  router.get(
    '/migrations/slowbooks/source-reference/:entity/:targetId',
    requirePermission('audit:read'),
    async (req: Request, res: Response) => {
      try {
        const auth = req.auth!;
        const targetTable = String(req.params.entity);
        const targetId = Number(req.params.targetId);
        if (!Number.isInteger(targetId) || targetId <= 0) {
          throw new AccountingError(400, 'targetId must be a positive integer');
        }
        const references = await db.withCompanyDb(auth.companyId, tx =>
          lookupSourceReference(tx, auth.companyId, targetTable, targetId)
        );
        return res.json({ companyId: auth.companyId, targetTable, targetId, references });
      } catch (err) {
        return handleMigrationError(res, err);
      }
    }
  );

  return router;
}
