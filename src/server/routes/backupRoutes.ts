import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { createDatabaseBackup, listBackups } from '../services/backupService.ts';
import { logger } from '../logger.ts';
import path from 'node:path';

export function createBackupRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection);

  // Backups are an administrative operation — never a read-only one. The
  // backup directory is fixed server-side and never taken from the client.
  const backupDir = path.resolve(process.cwd(), '.data', 'backups');

  router.post('/backup', requirePermission('admin:write'), async (req: Request, res: Response) => {
    try {
      const result = await createDatabaseBackup(db, backupDir, Number(req.body?.retention || 10));
      logger.info('backup_created', { fileName: result.fileName, sizeBytes: result.sizeBytes });
      return res.status(201).json(result);
    } catch (err: any) {
      logger.error('backup_failed', { error: err?.message || String(err) });
      return res.status(500).json({ error: err?.message || 'Backup failed' });
    }
  });

  router.get('/backups', requirePermission('admin:write'), async (_req: Request, res: Response) => {
    return res.json({ backups: listBackups(backupDir) });
  });

  return router;
}