import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';

const dataDir = (process.env.PMS_PG_DATA_DIR || path.resolve(process.cwd(), '.data', 'pms-pg')).trim();
const version = process.argv[2] || '0065';
const checksum = process.argv[3];

if (!checksum) {
  console.error('Usage: tsx db/repair-checksum.ts <version> <checksum_sha256>');
  process.exit(1);
}

const pg = new PGlite(dataDir);
try {
  const res = await pg.query(
    `UPDATE schema_migrations SET checksum_sha256 = $1 WHERE version = $2 RETURNING version, name`,
    [checksum, version]
  );
  if (res.rows.length === 0) {
    console.error(`No applied migration found for version ${version}`);
  } else {
    console.log(`Updated checksum for ${version} (${(res.rows[0] as any).name}) -> ${checksum}`);
  }
} finally {
  await pg.close();
}