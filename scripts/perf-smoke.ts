/**
 * p95 performance smoke test.
 *
 * Boots an in-memory server with seeded demo data, logs in, and exercises the
 * hottest read endpoints N times. Writes a baseline report to
 * docs/release/perf-baseline.md.
 *
 * Usage: npm run perf:smoke [-- --runs 50]
 */
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, loginAdmin } from '../tests/helpers/testServer.ts';

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  const runsArgIndex = process.argv.indexOf('--runs');
  const runs = runsArgIndex >= 0 ? Number(process.argv[runsArgIndex + 1]) || 50 : 50;

  const srv = await startTestServer();
  try {
    const admin = await loginAdmin(srv.baseUrl);
    const endpoints = [
      '/api/accounts',
      '/api/invoices',
      '/api/inventory',
      '/api/pos/catalog',
      '/api/bi/kpi-scorecard',
      '/api/payroll/advances',
    ];

    const results: Array<{ endpoint: string; p50: number; p95: number; max: number; errors: number }> = [];

    for (const endpoint of endpoints) {
      const durations: number[] = [];
      let errors = 0;
      for (let i = 0; i < runs; i++) {
        const started = performance.now();
        const res = await fetch(`${srv.baseUrl}${endpoint}`, {
          headers: { Cookie: (admin.client as any).cookie },
        });
        durations.push(performance.now() - started);
        if (res.status >= 400) errors++;
      }
      results.push({
        endpoint,
        p50: Math.round(percentile(durations, 50) * 100) / 100,
        p95: Math.round(percentile(durations, 95) * 100) / 100,
        max: Math.round(Math.max(...durations) * 100) / 100,
        errors,
      });
    }

    const allP95 = results.map(r => r.p95);
    const overallP95 = percentile(allP95, 95);
    const totalErrors = results.reduce((s, r) => s + r.errors, 0);

    const lines = [
      '# Performance Baseline',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Runs per endpoint: ${runs}`,
      '',
      '| Endpoint | p50 (ms) | p95 (ms) | max (ms) | errors |',
      '|----------|----------|----------|----------|--------|',
      ...results.map(r => `| ${r.endpoint} | ${r.p50} | ${r.p95} | ${r.max} | ${r.errors} |`),
      '',
      `**Overall p95: ${overallP95} ms · errors: ${totalErrors}**`,
      '',
    ];
    const outDir = path.join(process.cwd(), 'docs', 'release');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'perf-baseline.md'), lines.join('\n'));
    console.log(lines.join('\n'));
    if (totalErrors > 0) process.exit(1);
  } finally {
    await srv.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});