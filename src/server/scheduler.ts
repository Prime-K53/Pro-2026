import crypto from 'node:crypto';
import os from 'node:os';
import { ServerDatabase } from './db.ts';
import { getNextDueReportAt, runDueReportSchedules } from './services/reportSchedulingService.ts';
import { writeAuditLog } from './audit.ts';
import { recoverAllUnresolved, detectAnomalies } from './services/aiService.ts';
import { runPredictiveChecks } from './services/predictiveService.ts';

let nodemailer: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null;
}

const SCHEDULER_OWNER_ID = `${os.hostname().slice(0, 48)}:${process.pid}:${crypto
  .randomBytes(4)
  .toString('hex')}`;
const DEFAULT_LEASE_TTL_MS = Number(process.env.SCHEDULER_LEASE_TTL_MS || 120_000);
const DEFAULT_DISCOVERY_INTERVAL_MS = Number(process.env.SCHEDULER_DISCOVERY_INTERVAL_MS || 60_000);
const IDLE_RECHECK_MS = Number(process.env.SCHEDULER_IDLE_RECHECK_MS || 300_000);
const EMAIL_CLAIM_TTL_MS = Number(process.env.SMTP_CLAIM_TTL_MS || 300_000);
const MAX_EMAIL_ATTEMPTS = Math.max(1, Number(process.env.SMTP_MAX_ATTEMPTS || 5));
const EMAIL_RETRY_BASE_MS = Math.max(1_000, Number(process.env.SMTP_RETRY_BASE_MS || 60_000));
const MAX_EMAIL_BATCH = 50;
const MAX_TIMER_DELAY_MS = 6 * 60 * 60 * 1000;
const SMTP_NOT_CONFIGURED = 'SMTP transport not configured';

function createTransport() {
  const host = process.env.SMTP_HOST;
  if (!host || !nodemailer) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
}

function senderAddress(): string {
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@printing-system.local';
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 6));
  return Math.min(EMAIL_RETRY_BASE_MS * 2 ** exponent, 24 * 60 * 60 * 1000);
}

interface EmailQueueRow {
  id: number;
  recipient: string;
  subject: string;
  body: string | null;
  entity_type: string | null;
  entity_id: number | null;
  attempts: number;
  status: string;
}

export interface EmailDeliverySummary {
  companyId: number;
  processed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

/**
 * Delivers queued report mail for one tenant only.
 *
 * Rows are claimed by moving `next_attempt_at` forward, so a second process
 * (or a manual run racing the scheduler) cannot immediately pick the same row.
 */
export async function processQueuedEmailsForCompany(
  db: ServerDatabase,
  companyId: number
): Promise<EmailDeliverySummary> {
  const summary: EmailDeliverySummary = {
    companyId,
    processed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
  };
  const transport = createTransport();
  const from = senderAddress();
  const claimUntil = new Date(Date.now() + EMAIL_CLAIM_TTL_MS).toISOString();

  const claimed = await db.withCompanyDb(companyId, async (tx: any) => {
    const res = await tx.query(
      `SELECT id, recipient, subject, body, entity_type, entity_id, attempts, status
         FROM email_log
        WHERE company_id = $1
          AND next_attempt_at <= NOW()
          AND (
                status = 'queued'
             OR (status = 'skipped' AND last_error = $2)
          )
        ORDER BY id ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      [companyId, SMTP_NOT_CONFIGURED, MAX_EMAIL_BATCH]
    );
    const rows = res.rows as EmailQueueRow[];
    if (rows.length > 0) {
      await tx.query(
        `UPDATE email_log
            SET next_attempt_at = $3::TIMESTAMPTZ
          WHERE company_id = $1 AND id = ANY($2::BIGINT[])`,
        [companyId, rows.map(row => Number(row.id)), claimUntil]
      );
    }
    return rows;
  });

  for (const row of claimed) {
    summary.processed += 1;
    const attempts = Number(row.attempts || 0) + 1;

    if (!transport) {
      await db.withCompanyDb(companyId, async (tx: any) => {
        await tx.query(
          `UPDATE email_log
              SET status = 'skipped',
                  last_error = $3,
                  next_attempt_at = NOW() + INTERVAL '15 minutes'
            WHERE company_id = $1 AND id = $2`,
          [companyId, row.id, SMTP_NOT_CONFIGURED]
        );
      });
      summary.skipped += 1;
      continue;
    }

    const text =
      row.body ||
      `Scheduled report delivery. Reference: ${row.entity_type || 'report'} #${row.entity_id || ''}`;

    try {
      await transport.sendMail({
        from,
        to: row.recipient,
        subject: row.subject,
        text,
      });
      await db.withCompanyDb(companyId, async (tx: any) => {
        await tx.query(
          `UPDATE email_log
              SET status = 'sent',
                  attempts = $3,
                  last_error = NULL,
                  sent_at = NOW(),
                  next_attempt_at = NOW()
            WHERE company_id = $1 AND id = $2`,
          [companyId, row.id, attempts]
        );
      });
      summary.sent += 1;
    } catch (err: any) {
      const message = err?.message || String(err);
      const finalFailure = attempts >= MAX_EMAIL_ATTEMPTS;
      const delayMs = retryDelayMs(attempts);
      await db.withCompanyDb(companyId, async (tx: any) => {
        await tx.query(
          `UPDATE email_log
              SET status = $3,
                  attempts = $4,
                  last_error = $5,
                  next_attempt_at = NOW() + ($6::NUMERIC * INTERVAL '1 millisecond')
            WHERE company_id = $1 AND id = $2`,
          [companyId, row.id, finalFailure ? 'failed' : 'queued', attempts, message, delayMs]
        );
        await writeAuditLog(tx, {
          companyId,
          actorUsername: 'system',
          action: finalFailure ? 'EMAIL_DELIVERY_FAILED' : 'EMAIL_DELIVERY_RETRY_SCHEDULED',
          tableName: 'email_log',
          recordId: Number(row.id),
          newValues: {
            recipient: row.recipient,
            attempts,
            error: message,
            nextAttemptInMs: finalFailure ? null : delayMs,
          },
        });
      });
      if (finalFailure) summary.failed += 1;
      else summary.retried += 1;
      console.error(
        `[Scheduler] email delivery ${finalFailure ? 'failed permanently' : 'will retry'} ` +
          `for company ${companyId} (email_log #${row.id}): ${message}`
      );
    }
  }

  return summary;
}

/** Deliver queued mail for every active tenant (legacy/admin helper). */
export async function processQueuedEmails(db: ServerDatabase): Promise<number> {
  const companyIds = await listActiveCompanyIds(db);
  let sent = 0;
  for (const companyId of companyIds) {
    try {
      const summary = await processQueuedEmailsForCompany(db, companyId);
      sent += summary.sent;
    } catch (err) {
      console.error('[Scheduler] email processing failed for company', companyId, err);
    }
  }
  return sent;
}

async function listActiveCompanyIds(db: ServerDatabase): Promise<number[]> {
  return db.withSystemDb(async (tx: any) => {
    const res = await tx.query(`SELECT id FROM companies WHERE is_active = TRUE ORDER BY id ASC`);
    return res.rows.map((r: any) => Number(r.id));
  });
}

async function getTenantSchedulerActor(db: ServerDatabase, companyId: number) {
  return db.withCompanyDb(companyId, async (tx: any) => {
    const res = await tx.query(
      `SELECT u.id, u.username
         FROM company_memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.company_id = $1 AND m.role = 'Administrator' AND m.is_active = TRUE
        ORDER BY m.id ASC
        LIMIT 1`,
      [companyId]
    );
    return res.rows[0]
      ? {
          userId: Number(res.rows[0].id),
          username: String(res.rows[0].username),
          role: 'Administrator' as const,
        }
      : null;
  });
}

async function acquireTenantLease(
  db: ServerDatabase,
  companyId: number,
  ttlMs = DEFAULT_LEASE_TTL_MS
): Promise<boolean> {
  return db.withSystemDb(async (tx: any) => {
    const res = await tx.query(
      `INSERT INTO scheduler_leases (company_id, lease_owner, lease_expires_at, updated_at)
       VALUES ($1, $2, NOW() + ($3::NUMERIC * INTERVAL '1 millisecond'), NOW())
       ON CONFLICT (company_id) DO UPDATE
          SET lease_owner = EXCLUDED.lease_owner,
              lease_expires_at = EXCLUDED.lease_expires_at,
              updated_at = NOW()
        WHERE scheduler_leases.lease_expires_at < NOW()
           OR scheduler_leases.lease_owner = EXCLUDED.lease_owner
       RETURNING company_id`,
      [companyId, SCHEDULER_OWNER_ID, ttlMs]
    );
    return res.rows.length > 0;
  });
}

async function releaseTenantLease(
  db: ServerDatabase,
  companyId: number,
  lastError: string | null
): Promise<void> {
  try {
    await db.withSystemDb(async (tx: any) => {
      await tx.query(
        `UPDATE scheduler_leases
            SET lease_expires_at = NOW(),
                last_tick_at = NOW(),
                last_error = $3,
                updated_at = NOW()
          WHERE company_id = $1 AND lease_owner = $2`,
        [companyId, SCHEDULER_OWNER_ID, lastError]
      );
    });
  } catch (err) {
    console.error('[Scheduler] failed to release tenant lease', companyId, err);
  }
}

/** Earliest pending tenant work: next report schedule or next email retry. */
export async function getTenantNextWorkAt(
  db: ServerDatabase,
  companyId: number
): Promise<Date | null> {
  return db.withCompanyDb(companyId, async (tx: any) => {
    const reportAt = await getNextDueReportAt(tx, companyId);
    const emailRes = await tx.query(
      `SELECT MIN(next_attempt_at)::text AS next_attempt_at
         FROM email_log
        WHERE company_id = $1 AND status IN ('queued', 'skipped')`,
      [companyId]
    );
    const emailValue = emailRes.rows[0]?.next_attempt_at;
    const emailAt = emailValue ? new Date(emailValue) : null;
    const candidates = [reportAt, emailAt].filter(
      (value): value is Date => value instanceof Date && !Number.isNaN(value.getTime())
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((earliest, value) => (value < earliest ? value : earliest));
  });
}

export interface TenantTickResult {
  companyId: number;
  leased: boolean;
  reportRuns: Array<{ scheduleId: number; name: string; status: string; runId?: number }>;
  email: EmailDeliverySummary | null;
  nextRunAt: string | null;
  error: string | null;
}

/**
 * Runs one tenant's due report schedules and mail queue under a per-tenant
 * lease. The lease makes the cron safe to run from more than one process.
 */
export async function runTenantTick(
  db: ServerDatabase,
  companyId: number,
  now = new Date()
): Promise<TenantTickResult> {
  const leased = await acquireTenantLease(db, companyId);
  if (!leased) {
    return {
      companyId,
      leased: false,
      reportRuns: [],
      email: null,
      nextRunAt: null,
      error: null,
    };
  }

  let error: string | null = null;
  let reportRuns: TenantTickResult['reportRuns'] = [];
  let email: EmailDeliverySummary | null = null;
  try {
    const actor = await getTenantSchedulerActor(db, companyId);
    if (actor) {
      reportRuns = await db.withCompanyDb(companyId, (tx: any) =>
        runDueReportSchedules(tx, companyId, actor, now)
      );
    }
    // Operational anomaly detection (low stock, wastage, delays, unprofitable jobs).
    try {
      await db.withCompanyDb(companyId, (tx: any) => detectAnomalies(tx, companyId));
    } catch (err) {
      console.error('[Scheduler] anomaly detection failed for company', companyId, err);
    }
    // Predictive signals (duplicate/unusual expense, likely shortages).
    try {
      await db.withCompanyDb(companyId, (tx: any) => runPredictiveChecks(tx, companyId));
    } catch (err) {
      console.error('[Scheduler] predictive checks failed for company', companyId, err);
    }
    email = await processQueuedEmailsForCompany(db, companyId);
  } catch (err: any) {
    error = err?.message || String(err);
    console.error('[Scheduler] tenant tick failed for company', companyId, err);
  } finally {
    await releaseTenantLease(db, companyId, error);
  }

  let nextRunAt: string | null = null;
  try {
    const next = await getTenantNextWorkAt(db, companyId);
    nextRunAt = next ? next.toISOString() : null;
  } catch (err) {
    console.error('[Scheduler] failed to compute next tenant wake-up', companyId, err);
  }

  return { companyId, leased: true, reportRuns, email, nextRunAt, error };
}

/** Run every active tenant once (compatibility/admin entry point). */
export async function runSchedulerTick(db: ServerDatabase): Promise<void> {
  const companyIds = await listActiveCompanyIds(db);
  for (const companyId of companyIds) {
    try {
      await runTenantTick(db, companyId);
    } catch (err) {
      console.error('[Scheduler] tenant tick failed for company', companyId, err);
    }
  }
}

export interface SchedulerHandle {
  stop(): void;
  refresh(): Promise<void>;
  runTenantNow(companyId: number): Promise<TenantTickResult>;
}

/**
 * Per-tenant scheduler: each company gets a timer armed at its own earliest
 * due report/email retry instead of a process-wide 60 second report sweep.
 * A lightweight discovery pass only registers newly created tenants.
 */
class TenantScheduler {
  private timers = new Map<number, NodeJS.Timeout>();
  private targets = new Map<number, number>();
  private tenants = new Set<number>();
  private idleCheckedAt = new Map<number, number>();
  private ticking = new Set<number>();
  private stopped = false;
  private discoveryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly db: ServerDatabase) {}

  start(discoveryIntervalMs: number): void {
    this.stopped = false;
    void this.discoverTenants();
    this.discoveryTimer = setInterval(() => {
      void this.discoverTenants();
    }, Math.max(5_000, discoveryIntervalMs));
    this.discoveryTimer.unref?.();
  }

  async discoverTenants(): Promise<void> {
    if (this.stopped) return;
    try {
      const ids = await listActiveCompanyIds(this.db);
      const active = new Set(ids);
      for (const companyId of ids) {
        if (!this.tenants.has(companyId)) {
          this.tenants.add(companyId);
          this.idleCheckedAt.delete(companyId);
          await this.armTenant(companyId);
        } else if (!this.timers.has(companyId)) {
          // Idle tenants are re-checked occasionally so schedules created
          // out-of-process are still picked up without a 60 second sweep.
          const lastCheck = this.idleCheckedAt.get(companyId) ?? 0;
          if (Date.now() - lastCheck >= Math.max(5_000, IDLE_RECHECK_MS)) {
            await this.armTenant(companyId);
          }
        }
      }
      for (const companyId of Array.from(this.tenants)) {
        if (!active.has(companyId)) {
          this.clearTimer(companyId);
          this.tenants.delete(companyId);
          this.idleCheckedAt.delete(companyId);
        }
      }
    } catch (err) {
      console.error('[Scheduler] tenant discovery failed', err);
    }
  }

  async armTenant(companyId: number): Promise<void> {
    if (this.stopped || this.timers.has(companyId)) return;
    try {
      const next = await getTenantNextWorkAt(this.db, companyId);
      this.schedule(companyId, next);
    } catch (err) {
      console.error('[Scheduler] failed to arm tenant', companyId, err);
      this.schedule(companyId, new Date(Date.now() + DEFAULT_DISCOVERY_INTERVAL_MS));
    } finally {
      this.idleCheckedAt.set(companyId, Date.now());
    }
  }

  async rescheduleTenant(companyId: number): Promise<void> {
    if (this.stopped) return;
    this.tenants.add(companyId);
    this.clearTimer(companyId);
    await this.armTenant(companyId);
  }

  private schedule(companyId: number, next: Date | null): void {
    this.clearTimer(companyId);
    if (this.stopped || !next) return;
    const target = next.getTime();
    const delay = Math.max(0, Math.min(target - Date.now(), MAX_TIMER_DELAY_MS));
    const handle = setTimeout(() => {
      void this.fire(companyId);
    }, delay);
    handle.unref?.();
    this.timers.set(companyId, handle);
    this.targets.set(companyId, target);
  }

  private async fire(companyId: number): Promise<void> {
    if (this.stopped) return;
    const target = this.targets.get(companyId) ?? 0;
    this.clearTimer(companyId);

    // Timer was capped at MAX_TIMER_DELAY_MS and work is not actually due yet.
    if (target > Date.now() + 1_000) {
      this.schedule(companyId, new Date(target));
      return;
    }
    if (this.ticking.has(companyId)) {
      await this.armTenant(companyId);
      return;
    }

    this.ticking.add(companyId);
    try {
      const result = await runTenantTick(this.db, companyId);
      this.schedule(
        companyId,
        result.nextRunAt ? new Date(result.nextRunAt) : null
      );
    } catch (err) {
      console.error('[Scheduler] tenant timer failed', companyId, err);
      this.schedule(companyId, new Date(Date.now() + DEFAULT_DISCOVERY_INTERVAL_MS));
    } finally {
      this.ticking.delete(companyId);
    }
  }

  private clearTimer(companyId: number): void {
    const handle = this.timers.get(companyId);
    if (handle) {
      clearTimeout(handle);
      this.timers.delete(companyId);
    }
    this.targets.delete(companyId);
  }

  stop(): void {
    this.stopped = true;
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    for (const companyId of Array.from(this.timers.keys())) {
      this.clearTimer(companyId);
    }
    this.tenants.clear();
  }
}

let activeScheduler: TenantScheduler | null = null;

/**
 * Re-arm a tenant's timer after a schedule is created/updated/removed or run
 * manually. No-op when the scheduler is not running (tests, CLI helpers).
 */
export function notifyTenantScheduler(companyId: number): void {
  if (!activeScheduler) return;
  void activeScheduler.rescheduleTenant(companyId);
}

export function startScheduler(
  db: ServerDatabase,
  discoveryIntervalMs = DEFAULT_DISCOVERY_INTERVAL_MS
): SchedulerHandle {
  if (activeScheduler) activeScheduler.stop();
  const scheduler = new TenantScheduler(db);
  activeScheduler = scheduler;
  scheduler.start(discoveryIntervalMs);

  // D-05/R2 operational recovery: detect stale reserved/invoking attempts at
  // startup and periodically. Never releases; failures are isolated/logged.
  const runRecovery = () => {
    void recoverAllUnresolved(db).catch((err) =>
      console.error('[AI Recovery] failed:', (err as any)?.message || err)
    );
  };
  runRecovery();
  const recoveryTimer = setInterval(runRecovery, 30 * 60 * 1000);
  if (typeof (recoveryTimer as any).unref === 'function') (recoveryTimer as any).unref();

  return {
    stop() {
      clearInterval(recoveryTimer);
      scheduler.stop();
      if (activeScheduler === scheduler) activeScheduler = null;
    },
    async refresh() {
      await scheduler.discoverTenants();
    },
    async runTenantNow(companyId: number) {
      return runTenantTick(db, companyId);
    },
  };
}
