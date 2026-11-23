// One-off: wire csrfProtection after requireAuth in routers that authenticate
// at the router level. Per-route routers are handled separately.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('src/server/routes');
const skip = new Set(['authRoutes.ts', 'userRoutes.ts', 'companyRoutes.ts', 'documentQrRoutes.ts']);

let changed = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
  if (skip.has(file)) continue;
  const full = path.join(dir, file);
  let src = fs.readFileSync(full, 'utf8');
  if (!src.includes('router.use(requireAuth')) continue;
  if (src.includes('csrfProtection')) continue;

  // Add import next to the createAuthMiddleware import.
  const importRe = /import\s*\{[^}]*createAuthMiddleware[^}]*\}\s*from\s*['"]\.\.\/middleware\/auth\.ts['"];?/;
  if (!importRe.test(src)) {
    console.warn(`! ${file}: createAuthMiddleware import not found, skipping`);
    continue;
  }
  src = src.replace(importRe, (m) => `${m}\nimport { csrfProtection } from '../middleware/csrf.ts';`);

  src = src.replace(
    /router\.use\(requireAuth,\s*rejectCrossCompanyParams\)/g,
    'router.use(requireAuth, csrfProtection, rejectCrossCompanyParams)'
  );
  src = src.replace(
    /router\.use\(requireAuth\)/g,
    'router.use(requireAuth, csrfProtection)'
  );

  fs.writeFileSync(full, src);
  changed++;
  console.log(`patched ${file}`);
}
console.log(`\n${changed} files patched`);