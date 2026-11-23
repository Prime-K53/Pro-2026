// Generates a reproducible baseline inventory for the V2 gap-closure programme.
// Usage: node scripts/baseline-inventory.mjs
// Outputs: docs/baseline/routes.json, docs/baseline/routes.md, docs/baseline/migrations.md

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const ROUTES_DIR = path.join(ROOT, 'src', 'server', 'routes');
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');
const OUT_DIR = path.join(ROOT, 'docs', 'baseline');

fs.mkdirSync(OUT_DIR, { recursive: true });

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// ---- Route inventory -------------------------------------------------------
// Capture router.<method>('path', ...handlers) occurrences per file.
const methodRe = /\brouter\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const permRe = /requirePermission\(\s*['"]([^'"]+)['"]\s*\)/g;
const authRe = /requireAuth/g;

const files = fs
  .readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort();

const routes = [];
const fileSummaries = [];

for (const file of files) {
  const full = path.join(ROUTES_DIR, file);
  const src = fs.readFileSync(full, 'utf8');
  const perms = [...src.matchAll(permRe)].map((m) => m[1]);
  const requireAuthCount = (src.match(authRe) || []).length;

  const fileRoutes = [];
  let m;
  methodRe.lastIndex = 0;
  while ((m = methodRe.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const routePath = m[2];
    fileRoutes.push({ method, path: routePath, file });
    routes.push({ method, path: routePath, file });
  }

  fileSummaries.push({
    file,
    routeCount: fileRoutes.length,
    requireAuthRefs: requireAuthCount,
    requirePermissionRefs: perms.length,
    permissions: [...new Set(perms)].sort(),
  });
}

routes.sort((a, b) => a.file.localeCompare(b.file) || a.path.localeCompare(b.path));

// ---- Migration inventory ---------------------------------------------------
const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.up.sql'))
  .sort()
  .map((f) => {
    const base = f.replace(/\.up\.sql$/, '');
    const down = path.join(MIGRATIONS_DIR, `${base}.down.sql`);
    const upSql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    return {
      version: base.slice(0, 4),
      name: base.slice(5),
      hasDown: fs.existsSync(down),
      tables: (upSql.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-zA-Z0-9_"]+)/g) || []).map((s) =>
        s.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+/i, '').replace(/"/g, '')
      ),
      enablesRls: (upSql.match(/ENABLE ROW LEVEL SECURITY/g) || []).length,
    };
  });

// ---- Write JSON ------------------------------------------------------------
const baseline = {
  generatedAt: new Date().toISOString(),
  gitCommit: git('rev-parse HEAD'),
  gitBranch: git('rev-parse --abbrev-ref HEAD'),
  node: process.version,
  totals: {
    routeFiles: files.length,
    routes: routes.length,
    migrations: migrations.length,
  },
  routes,
  fileSummaries,
  migrations,
};

fs.writeFileSync(path.join(OUT_DIR, 'routes.json'), JSON.stringify(baseline, null, 2));

// ---- Write Markdown --------------------------------------------------------
const byFile = new Map();
for (const r of routes) {
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(r);
}

let md = `# Baseline Inventory\n\n`;
md += `Generated: ${baseline.generatedAt}\n\n`;
md += `- Commit: \`${baseline.gitCommit}\` (${baseline.gitBranch})\n`;
md += `- Node: ${baseline.node}\n`;
md += `- Route files: ${baseline.totals.routeFiles}\n`;
md += `- Routes: ${baseline.totals.routes}\n`;
md += `- Migrations: ${baseline.totals.migrations}\n\n`;

md += `## Authorization snapshot (per route file)\n\n`;
md += `| File | Routes | requireAuth refs | requirePermission refs | Permissions |\n`;
md += `|------|--------|------------------|------------------------|-------------|\n`;
for (const s of fileSummaries) {
  md += `| ${s.file} | ${s.routeCount} | ${s.requireAuthRefs} | ${s.requirePermissionRefs} | ${s.permissions.join(', ') || '—'} |\n`;
}

md += `\n## Routes\n\n`;
md += `| Method | Path | File |\n`;
md += `|--------|------|------|\n`;
for (const r of routes) {
  md += `| ${r.method} | \`${r.path}\` | ${r.file} |\n`;
}

md += `\n## Migrations\n\n`;
md += `| Version | Name | Down | RLS enables | Tables |\n`;
md += `|---------|------|------|-------------|--------|\n`;
for (const m of migrations) {
  md += `| ${m.version} | ${m.name} | ${m.hasDown ? 'yes' : '**NO**'} | ${m.enablesRls} | ${m.tables.join(', ') || '—'} |\n`;
}

fs.writeFileSync(path.join(OUT_DIR, 'routes.md'), md);

console.log(`Baseline written to ${path.relative(ROOT, OUT_DIR)}/`);
console.log(`Routes: ${routes.length} across ${files.length} files`);
console.log(`Migrations: ${migrations.length}`);
console.log(`Commit: ${baseline.gitCommit}`);