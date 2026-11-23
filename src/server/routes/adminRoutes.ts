import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as adminService from '../services/adminService.ts';
import { getBackupStatus } from '../services/backupService.ts';
import { writeAuditLog } from '../audit.ts';
import path from 'node:path';

function defaultBackupDir(): string {
  return path.resolve(process.cwd(), '.data', 'backups');
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
  const msg = (err as any)?.message || 'Admin service error';
  console.error('[Admin Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createAdminRoutes(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requireReadOrWrite } = createAuthMiddleware(db);
  router.use('/admin', requireAuth, csrfProtection);
  router.use('/admin', requireReadOrWrite('admin:read', 'admin:write'));

  router.get('/admin/health', async (req: Request, res: Response) => {
    try {
      const backup = getBackupStatus(defaultBackupDir());
      const health = await db.withSystemDb((tx: Transaction) =>
        adminService.getSystemHealth(tx, backup)
      );
      return res.status(health.status === 'ok' ? 200 : 503).json(health);
    } catch (err) {
      return res.status(503).json({ status: 'degraded', database: 'error' });
    }
  });

  router.get('/admin/backup/status', async (req: Request, res: Response) => {
    try {
      return res.json(getBackupStatus(defaultBackupDir()));
    } catch (err) {
      return handleError(res, err);
    }
  });

  // Restore readiness only — restoration is an operator runbook, never an
  // unauthenticated/ordinary HTTP restore endpoint.
  router.get('/admin/restore/readiness', async (req: Request, res: Response) => {
    const backup = getBackupStatus(defaultBackupDir());
    return res.json({
      canRestore: backup.ok,
      backup,
      method: 'operator-runbook',
      runbook: 'docs/runbooks/restore.md',
      note: 'Restoration is a privileged, audited operator procedure. No HTTP restore endpoint is exposed.',
    });
  });

  router.get('/admin/integrations', async (req: Request, res: Response) => {
    try { const auth = req.auth!; return res.json({ integrations: await db.withCompanyDb(auth.companyId, (tx: Transaction) => adminService.listIntegrations(tx, auth.companyId)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.post('/admin/integrations', async (req: Request, res: Response) => {
    try { const auth = req.auth!; if (!req.body?.name || !req.body?.type) return res.status(400).json({ error: 'name and type are required' });
      return res.status(201).json({ integration: await db.withCompanyDb(auth.companyId, (tx: Transaction) => adminService.createIntegration(tx, auth.companyId, req.body)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.get('/admin/subscriptions', async (req: Request, res: Response) => {
    try { const auth = req.auth!; return res.json({ subscriptions: await db.withCompanyDb(auth.companyId, (tx: Transaction) => adminService.listSubscriptions(tx, auth.companyId)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.get('/admin/releases', async (req: Request, res: Response) => {
    try { const releases = await db.withSystemDb((tx: Transaction) => adminService.listReleases(tx)); return res.json({ releases }); }
    catch (err) { return handleError(res, err); }
  });

  router.get('/admin/metrics', async (req: Request, res: Response) => {
    try { const auth = req.auth!; return res.json({ metrics: await db.withCompanyDb(auth.companyId, (tx: Transaction) => adminService.getMetrics(tx, auth.companyId)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.post('/admin/integrations/:id/rotate-secret', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      if (!req.body?.secret) {
        return res.status(400).json({ error: 'secret is required' });
      }
      const integration = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        adminService.rotateIntegrationSecret(
          tx,
          auth.companyId,
          Number(req.params.id),
          String(req.body.secret)
        )
      );
      await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'INTEGRATION_SECRET_ROTATED',
          tableName: 'integrations',
          recordId: Number(req.params.id),
          newValues: { integrationId: Number(req.params.id) },
        })
      );
      return res.json({ integration });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/admin/audit/summary', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const summary = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        adminService.getAuditSummary(tx, auth.companyId)
      );
      return res.json(summary);
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}