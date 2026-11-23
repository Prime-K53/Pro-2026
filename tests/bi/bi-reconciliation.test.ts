/**
 * WS-8 BI/GL reconciliation and WS-9 admin health.
 */
import assert from 'node:assert/strict';
import { startTestServer, loginAdmin } from '../helpers/testServer.ts';

async function main() {
  const srv = await startTestServer();
  try {
    const admin = await loginAdmin(srv.baseUrl);
    const c = admin.client;

    // KPI scorecard now includes gross profit and margin.
    const kpi = await c.request('GET', '/api/bi/kpi-scorecard');
    assert.equal(kpi.status, 200, kpi.text);
    assert.ok('grossProfit' in kpi.json.kpis, 'grossProfit must be present');
    assert.ok('grossMargin' in kpi.json.kpis, 'grossMargin must be present');

    // BI totals reconcile to the GL.
    const recon = await c.request('GET', '/api/bi/reconciliation');
    assert.equal(recon.status, 200, recon.text);
    assert.ok(Array.isArray(recon.json.checks) && recon.json.checks.length >= 2);
    assert.equal(
      recon.json.balanced,
      true,
      `BI reconciliation failed: ${JSON.stringify(recon.json.checks)}`
    );

    // AR ageing buckets are returned in order.
    const ageing = await c.request('GET', '/api/bi/ar-ageing');
    assert.equal(ageing.status, 200, ageing.text);
    const buckets = ageing.json.buckets.map((b: any) => b.bucket);
    assert.deepEqual(buckets, ['current', '1-30', '31-60', '61-90', '90+']);

    // Admin health reports structured checks.
    const health = await c.request('GET', '/api/admin/health');
    assert.equal(health.status, 200, health.text);
    assert.equal(health.json.status, 'ok');
    const names = health.json.checks.map((x: any) => x.name);
    assert.ok(names.includes('database'), 'database check must be present');

    // KPI targets can be set and listed.
    const setTarget = await c.request('PUT', '/api/bi/kpi-targets', {
      body: { kpiKey: 'revenue', targetValue: 10000, period: 'monthly' },
    });
    assert.equal(setTarget.status, 201, setTarget.text);
    const targets = await c.request('GET', '/api/bi/kpi-targets');
    assert.equal(targets.status, 200);
    assert.ok(targets.json.targets.some((t: any) => t.kpiKey === 'revenue'));

    // Variance is computed against the target.
    const kpi2 = await c.request('GET', '/api/bi/kpi-scorecard');
    assert.equal(kpi2.status, 200);
    assert.equal(Number(kpi2.json.kpis.revenueTarget), 10000);
    assert.ok(kpi2.json.kpis.revenueVariance !== null, 'variance must be computed');

    // Sales split (settled vs outstanding).
    const split = await c.request('GET', '/api/bi/sales-split');
    assert.equal(split.status, 200, split.text);
    assert.ok('settled' in split.json && 'outstanding' in split.json);

    // Restore readiness is a runbook, not an HTTP restore.
    const ready = await c.request('GET', '/api/admin/restore/readiness');
    assert.equal(ready.status, 200, ready.text);
    assert.ok('canRestore' in ready.json);
    assert.equal(ready.json.method, 'operator-runbook');

    // Revenue drill-down returns underlying invoices.
    const drill = await c.request('GET', '/api/bi/drilldown/revenue?limit=10');
    assert.equal(drill.status, 200, drill.text);
    assert.ok(Array.isArray(drill.json.rows));

    // Backup status endpoint reports configuration state.
    const backup = await c.request('GET', '/api/admin/backup/status');
    assert.equal(backup.status, 200, backup.text);
    assert.ok('configured' in backup.json);

    console.log('✅ BI reconciliation & admin health tests passed');
  } finally {
    await srv.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});