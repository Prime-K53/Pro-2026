import { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';
import { encryptSecret } from './secretCrypto.ts';

export interface Integration { id: number; companyId: number; name: string; type: string; config: any; status: string; createdAt: string; }
export interface Subscription { id: number; companyId: number; planId: number; planName: string; planPrice: string; status: string; startedAt: string; endsAt: string | null; createdAt: string; }
export interface ReleaseVersion { id: number; version: string; notes: string | null; releasedAt: string; isCurrent: boolean; }

export async function listIntegrations(tx: Transaction, companyId: number): Promise<Integration[]> {
  const res = await tx.query<any>(`SELECT * FROM integrations WHERE company_id = $1 ORDER BY name`, [companyId]);
  return res.rows.map((r: any) => ({ id: Number(r.id), companyId: Number(r.company_id), name: r.name, type: r.type, config: r.config, status: r.status, createdAt: r.created_at }));
}

export async function createIntegration(tx: Transaction, companyId: number, input: any): Promise<Integration> {
  const res = await tx.query<any>(`INSERT INTO integrations (company_id, name, type, config) VALUES ($1, $2, $3, $4) RETURNING *`,
    [companyId, input.name, input.type, JSON.stringify(input.config || {})]);
  const r = res.rows[0];
  return { id: Number(r.id), companyId: Number(r.company_id), name: r.name, type: r.type, config: r.config, status: r.status, createdAt: r.created_at };
}

export async function listSubscriptions(tx: Transaction, companyId: number): Promise<Subscription[]> {
  const res = await tx.query<any>(
    `SELECT s.*, sp.name AS plan_name, sp.price AS plan_price FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id WHERE s.company_id = $1 ORDER BY s.created_at DESC`,
    [companyId]
  );
  return res.rows.map((r: any) => ({ id: Number(r.id), companyId: Number(r.company_id), planId: Number(r.plan_id), planName: r.plan_name, planPrice: r.plan_price, status: r.status, startedAt: r.started_at, endsAt: r.ends_at, createdAt: r.created_at }));
}

export async function listReleases(tx: Transaction): Promise<ReleaseVersion[]> {
  const res = await tx.query<any>(`SELECT * FROM release_versions ORDER BY released_at DESC`);
  return res.rows.map((r: any) => ({ id: Number(r.id), version: r.version, notes: r.notes, releasedAt: r.released_at, isCurrent: r.is_current }));
}

export async function getMetrics(tx: Transaction, companyId: number): Promise<any> {
  const [inv, cust, items] = await Promise.all([
    tx.query<any>(`SELECT COUNT(*)::text AS cnt FROM invoices WHERE company_id = $1`, [companyId]),
    tx.query<any>(`SELECT COUNT(*)::text AS cnt FROM customers WHERE company_id = $1`, [companyId]),
    tx.query<any>(`SELECT COUNT(*)::text AS cnt FROM inventory_items WHERE company_id = $1`, [companyId]),
  ]);
  return { invoiceCount: Number(inv.rows[0].cnt), customerCount: Number(cust.rows[0].cnt), inventoryItemCount: Number(items.rows[0].cnt) };
}
// ─── System health ──────────────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  status: 'ok' | 'error' | 'not_configured';
  detail: string;
}

export interface SystemHealth {
  status: 'ok' | 'degraded';
  checks: HealthCheck[];
  uptimeSeconds: number;
  timestamp: string;
}

export async function getSystemHealth(
  tx: Transaction,
  backup?: { configured: boolean; ok: boolean; count: number; latest: { name: string; ageHours: number } | null }
): Promise<SystemHealth> {
  const checks: HealthCheck[] = [];

  try {
    await tx.query('SELECT 1');
    checks.push({ name: 'database', status: 'ok', detail: 'connected' });
  } catch (err: any) {
    checks.push({ name: 'database', status: 'error', detail: err?.message || String(err) });
  }

  try {
    const res = await tx.query<{ companies: number; users: number }>(
      `SELECT (SELECT COUNT(*) FROM companies)::int AS companies,
              (SELECT COUNT(*) FROM users)::int AS users`
    );
    checks.push({
      name: 'data',
      status: 'ok',
      detail: `companies=${res.rows[0].companies}, users=${res.rows[0].users}`,
    });
  } catch {
    checks.push({ name: 'data', status: 'error', detail: 'unable to read core tables' });
  }

  checks.push({ name: 'realtime', status: 'not_configured', detail: 'SSE/realtime not enabled' });
  if (backup && backup.configured) {
    checks.push({
      name: 'backups',
      status: backup.ok ? 'ok' : 'error',
      detail: backup.latest
        ? `latest=${backup.latest.name} (${backup.latest.ageHours}h ago), count=${backup.count}`
        : 'no backups found',
    });
  } else {
    checks.push({ name: 'backups', status: 'not_configured', detail: 'no backup provider configured' });
  }

  return {
    status: checks.some(c => c.status === 'error') ? 'degraded' : 'ok',
    checks,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

// ─── Secret rotation & audit monitoring ────────────────────────────────

export async function rotateIntegrationSecret(
  tx: Transaction,
  companyId: number,
  integrationId: number,
  secret: string
): Promise<Integration> {
  const res = await tx.query<any>(
    `SELECT * FROM integrations WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, integrationId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Integration not found', 'INTEGRATION_NOT_FOUND');
  }
  const row = res.rows[0];
  const config =
    typeof row.config === 'string' ? JSON.parse(row.config || '{}') : row.config || {};
  config.secret = encryptSecret(secret);
  const upd = await tx.query<any>(
    `UPDATE integrations SET config = $2::jsonb, updated_at = NOW()
      WHERE company_id = $1 AND id = $3 RETURNING *`,
    [companyId, JSON.stringify(config), integrationId]
  );
  const r = upd.rows[0];
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    name: r.name,
    type: r.type,
    config: r.config,
    status: r.status,
    createdAt: r.created_at,
  };
}

export interface AuditSummary {
  windowHours: number;
  actions: Array<{ action: string; count: number }>;
  critical: Array<{ action: string; count: number }>;
}

export async function getAuditSummary(tx: Transaction, companyId: number): Promise<AuditSummary> {
  const actions = await tx.query<{ action: string; count: number }>(
    `SELECT action, COUNT(*)::int AS count
       FROM audit_log
      WHERE company_id = $1 AND occurred_at >= NOW() - INTERVAL '24 hours'
      GROUP BY action ORDER BY count DESC`,
    [companyId]
  );
  const critical = await tx.query<{ action: string; count: number }>(
    `SELECT action, COUNT(*)::int AS count
       FROM audit_log
      WHERE company_id = $1
        AND occurred_at >= NOW() - INTERVAL '24 hours'
        AND action = ANY($2::text[])
      GROUP BY action ORDER BY count DESC`,
    [
      companyId,
      [
        'FAILED_LOGIN',
        'TWO_FACTOR_DISABLED',
        'USER_ROLE_CHANGED',
        'INTEGRATION_SECRET_ROTATED',
        'BACKUP_CREATED',
      ],
    ]
  );
  return { windowHours: 24, actions: actions.rows, critical: critical.rows };
}
