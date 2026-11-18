import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { createDatabaseBackup, listBackups } from '../services/backupService.ts';
import { logger } from '../logger.ts';
import path from 'node:path';

export function createBackupRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth);

  router.post('/backup', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const backupDir = (req.body?.backupDir as string) || path.resolve(process.cwd(), '.data', 'backups');
      const result = await createDatabaseBackup(db, backupDir, Number(req.body?.retention || 10));
      logger.info('backup_created', { fileName: result.fileName, sizeBytes: result.sizeBytes });
      return res.status(201).json(result);
    } catch (err: any) {
      logger.error('backup_failed', { error: err?.message || String(err) });
      return res.status(500).json({ error: err?.message || 'Backup failed' });
    }
  });

  router.get('/backups', requirePermission('reports:read'), async (req: Request, res: Response) => {
    const backupDir = (req.query?.backupDir as string) || path.resolve(process.cwd(), '.data', 'backups');
    return res.json({ backups: listBackups(backupDir) });
  });

  return router;
}
