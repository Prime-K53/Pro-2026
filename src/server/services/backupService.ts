import fs from 'node:fs';
import path from 'node:path';
import { ServerDatabase } from '../db.ts';

export interface BackupResult {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  createdAt: string;
}

export async function createDatabaseBackup(db: ServerDatabase, backupDir: string, retention = 10): Promise<BackupResult> {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `pms-backup-${stamp}.tar`;
  const filePath = path.join(backupDir, fileName);

  const blob = await db.pg.dumpDataDir();
  const buf = Buffer.from(await blob.arrayBuffer());
  fs.writeFileSync(filePath, buf);

  // integrity check: file exists, non-empty, readable
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error('Backup integrity check failed: empty or missing file');
  }

  // retention: keep newest N
  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('pms-backup-') && f.endsWith('.tar'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (let i = retention; i < files.length; i++) {
    try { fs.unlinkSync(path.join(backupDir, files[i].name)); } catch {}
  }

  return { fileName, filePath, sizeBytes: stat.size, createdAt: new Date().toISOString() };
}

export function listBackups(backupDir: string): string[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter(f => f.startsWith('pms-backup-') && f.endsWith('.tar'))
    .sort()
    .reverse();
}
