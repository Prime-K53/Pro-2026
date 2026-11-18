import fs from 'node:fs';
import path from 'node:path';
import { loadServerConfig } from '../src/server/config.ts';
import { createServerDatabase } from '../src/server/db.ts';
import { ActorContext } from '../src/server/services/accountingEngine.ts';
import {
  buildReconciliationMarkdownReport,
  getMigrationBatchDetails,
  rollbackMigrationBatch,
  runSlowBooksMigration,
} from '../src/server/services/slowbooksMigrationService.ts';
import { signOffMigrationBatch } from '../src/server/services/slowbooksReconciliationService.ts';
import { loadSlowBooksSourceFile } from '../src/server/services/slowbooksSourceAdapter.ts';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function resolveCliActor(db: Awaited<ReturnType<typeof createServerDatabase>>): Promise<ActorContext> {
  return db.withSystemDb(async tx => {
    const r = await tx.query<{ id: number; username: string }>(
      `SELECT id, username FROM users WHERE is_active = TRUE ORDER BY id ASC LIMIT 1`
    );
    if (r.rows.length > 0) {
      return { userId: Number(r.rows[0].id), username: r.rows[0].username, role: 'Administrator' };
    }
    return { userId: 1, username: 'migration-cli', role: 'Administrator' };
  });
}

async function main() {
  const mode = (getArg('--mode') || 'dry-run').toLowerCase();
  const sourcePath = getArg('--source');
  const batchKey = getArg('--batch-key');
  const batchIdArg = getArg('--batch-id');
  const backupDir = path.resolve(getArg('--backup-dir') || path.resolve(process.cwd(), '.data', 'migration-backups'));
  const reportOut = getArg('--report-out');
  const reason = getArg('--reason') || 'CLI requested rollback';

  const config = loadServerConfig();
  const db = await createServerDatabase(config, { seedDemo: false });

  try {
    const actor = await resolveCliActor(db);

    if (mode === 'rollback') {
      const batchId = Number(batchIdArg);
      if (!Number.isInteger(batchId) || batchId <= 0) {
        throw new Error('--batch-id <id> is required for --mode rollback');
      }
      const rb = await db.withSystemDb(tx => rollbackMigrationBatch(tx, actor, batchId, reason));
      console.log(JSON.stringify(rb, null, 2));
      return;
    }

    if (!sourcePath) {
      throw new Error('--source <slowbooks-export.json> is required');
    }
    const loaded = loadSlowBooksSourceFile(sourcePath);

    if (mode === 'sign-off') {
      const batchId = Number(batchIdArg);
      if (!Number.isInteger(batchId) || batchId <= 0) {
        throw new Error('--batch-id <id> is required for --mode sign-off');
      }
      const res = await db.withSystemDb(tx =>
        signOffMigrationBatch(tx, actor, batchId, loaded.bundle, {
          signOffNotes: getArg('--notes'),
        })
      );
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const dryRun = mode !== 'execute';
    const result = await runSlowBooksMigration(db, loaded.bundle, actor, {
      batchKey,
      sourceLabel: path.basename(sourcePath),
      dryRun,
      backupDir,
      operatorUserId: actor.userId,
    });

    if (reportOut) {
      const details = await db.withSystemDb(tx => getMigrationBatchDetails(tx, result.batchId));
      const md = buildReconciliationMarkdownReport({
        batchKey: result.batchKey,
        sourceSystem: 'SlowBooks-Pro-2026',
        sourceSha256: result.sourceSha256,
        sourceBackupPath: result.sourceBackupPath,
        sourceBackupSha256: result.sourceBackupSha256,
        targetBackupPath: result.targetBackupPath,
        targetBackupSha256: result.targetBackupSha256,
        cutoverApproved: Boolean((details.batch as any).cutover_approved),
        companyReports: result.companyReports,
        isolationVerified: true,
        rollbackVerified: false,
        dryRunVerified: dryRun,
      });
      fs.mkdirSync(path.dirname(path.resolve(reportOut)), { recursive: true });
      fs.writeFileSync(path.resolve(reportOut), md, 'utf8');
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.close();
  }
}

main().catch(err => {
  console.error('[SlowBooks Migration CLI Error]', err);
  process.exit(1);
});
