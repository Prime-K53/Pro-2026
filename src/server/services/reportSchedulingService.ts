import { Transaction } from '@electric-sql/pglite';
import { writeAuditLog } from '../audit.ts';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { todayIsoDate } from './commercialHelpers.ts';
import { getBalanceSheet, getCashFlowStatement, getProfitAndLoss, getTrialBalance } from './financialReports.ts';
import { getArAgingReport } from './salesService.ts';
import { getApAgingReport } from './purchasingService.ts';
import { getBudgetVsActualReport, getTaxSummaryReport } from './financialManagementService.ts';
import {
  getCogsReconciliationReport,
  getEstimateVsActualReport,
  getInventoryValuationReport,
  getPrintingJobProfitability,
  getPrintingSpoilageReport,
  getWipAgingReport,
} from './operationalReports.ts';

export const REPORT_SCHEDULE_KEYS = [
  { key: 'trial_balance', label: 'Trial Balance' },
  { key: 'profit_and_loss', label: 'Profit & Loss' },
  { key: 'balance_sheet', label: 'Balance Sheet' },
  { key: 'cash_flow', label: 'Statement of Cash Flows' },
  { key: 'ar_aging', label: 'Accounts Receivable Aging' },
  { key: 'ap_aging', label: 'Accounts Payable Aging' },
  { key: 'budget_vs_actual', label: 'Budget vs Actual' },
  { key: 'tax_summary', label: 'Tax Summary' },
  { key: 'job_profitability', label: 'Printing Job Profitability' },
  { key: 'wip_aging', label: 'WIP Aging' },
  { key: 'inventory_valuation', label: 'Inventory Valuation' },
  { key: 'cogs_reconciliation', label: 'COGS Reconciliation' },
] as const;

export type ReportScheduleKey = (typeof REPORT_SCHEDULE_KEYS)[number]['key'];
export type ReportFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export interface ReportScheduleRow {
  id: number;
  company_id: number;
  name: string;
  report_key: ReportScheduleKey;
  frequency: ReportFrequency;
  day_of_week: number | null;
  day_of_month: number | null;
  time_of_day: string;
  recipients: string[];
  filters_json: Record<string, unknown>;
  is_active: boolean;
  last_run_at: string | null;
  next_run_at: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

function mapSchedule(row: Record<string, unknown>): ReportScheduleRow {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    name: String(row.name),
    report_key: row.report_key as ReportScheduleKey,
    frequency: row.frequency as ReportFrequency,
    day_of_week: row.day_of_week === null || row.day_of_week === undefined ? null : Number(row.day_of_week),
    day_of_month: row.day_of_month === null || row.day_of_month === undefined ? null : Number(row.day_of_month),
    time_of_day: String(row.time_of_day).slice(0, 5),
    recipients: Array.isArray(row.recipients) ? (row.recipients as string[]) : [],
    filters_json: (row.filters_json as Record<string, unknown>) ?? {},
    is_active: Boolean(row.is_active),
    last_run_at: row.last_run_at ? String(row.last_run_at) : null,
    next_run_at: String(row.next_run_at),
    created_by: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function assertReportKey(value: unknown): ReportScheduleKey {
  const key = String(value || '');
  if (!REPORT_SCHEDULE_KEYS.some(r => r.key === key)) {
    throw new AccountingError(400, `Unsupported report key '${key}'`, 'INVALID_REPORT_KEY');
  }
  return key as ReportScheduleKey;
}

function parseTimeOfDay(value: unknown): string {
  const raw = String(value || '07:00');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
    throw new AccountingError(400, 'timeOfDay must be HH:MM (24-hour)', 'INVALID_TIME');
  }
  return raw;
}

function nextDateAtUtc(year: number, month: number, day: number, time: string): Date {
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(year, month, day, hh, mm, 0, 0));
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function addMonths(date: Date, months: number): Date {
  const copy = new Date(date.getTime());
  const day = copy.getUTCDate();
  copy.setUTCDate(1);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(copy.getUTCFullYear(), copy.getUTCMonth() + 1, 0)).getUTCDate();
  copy.setUTCDate(Math.min(day, lastDay));
  return copy;
}

export function computeNextRun(
  frequency: ReportFrequency,
  timeOfDay: string,
  from: Date,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null
): Date {
  const time = parseTimeOfDay(timeOfDay);
  if (frequency === 'daily') {
    let candidate = nextDateAtUtc(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), time);
    if (candidate.getTime() <= from.getTime()) candidate = addDays(candidate, 1);
    return candidate;
  }
  if (frequency === 'weekly') {
    const targetDow = dayOfWeek === null || dayOfWeek === undefined ? 1 : dayOfWeek;
    if (targetDow < 0 || targetDow > 6) {
      throw new AccountingError(400, 'dayOfWeek must be between 0 (Sunday) and 6 (Saturday)', 'INVALID_DAY_OF_WEEK');
    }
    for (let i = 0; i < 8; i++) {
      const candidate = addDays(
        nextDateAtUtc(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), time),
        i
      );
      if (candidate.getUTCDay() === targetDow && candidate.getTime() > from.getTime()) {
        return candidate;
      }
    }
  }
  if (frequency === 'monthly') {
    const targetDay = dayOfMonth === null || dayOfMonth === undefined ? 1 : dayOfMonth;
    if (targetDay < 1 || targetDay > 28) {
      throw new AccountingError(400, 'dayOfMonth must be between 1 and 28', 'INVALID_DAY_OF_MONTH');
    }
    for (let i = 0; i < 14; i++) {
      const base = addMonths(nextDateAtUtc(from.getUTCFullYear(), from.getUTCMonth(), 1, time), i);
      const candidate = nextDateAtUtc(base.getUTCFullYear(), base.getUTCMonth(), targetDay, time);
      if (candidate.getTime() > from.getTime()) return candidate;
    }
  }
  // quarterly: Jan, Apr, Jul, Oct
  const targetDay = dayOfMonth === null || dayOfMonth === undefined ? 1 : dayOfMonth;
  if (targetDay < 1 || targetDay > 28) {
    throw new AccountingError(400, 'dayOfMonth must be between 1 and 28', 'INVALID_DAY_OF_MONTH');
  }
  for (let i = 0; i < 12; i++) {
    const base = addMonths(nextDateAtUtc(from.getUTCFullYear(), from.getUTCMonth(), 1, time), i);
    if (base.getUTCMonth() % 3 !== 0) continue;
    const candidate = nextDateAtUtc(base.getUTCFullYear(), base.getUTCMonth(), targetDay, time);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  throw new AccountingError(400, 'Unable to compute next run', 'INVALID_SCHEDULE');
}

function normalizeRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => String(v || '').trim())
    .filter(v => v.length > 0)
    .slice(0, 50);
}

function renderReportEmailBody(schedule: ReportScheduleRow, snapshot: Record<string, unknown>): string {
  const generatedAt = new Date().toISOString();
  const serialized = JSON.stringify(snapshot, null, 2);
  const maxLength = 180_000;
  const reportText =
    serialized.length > maxLength
      ? `${serialized.slice(0, maxLength)}\n... (truncated)`
      : serialized;
  return [
    schedule.name,
    '',
    `Report: ${schedule.report_key}`,
    `Frequency: ${schedule.frequency}`,
    `Generated: ${generatedAt}`,
    '',
    'Report data (JSON):',
    reportText,
  ].join('\n');
}

/** Earliest active report schedule for a tenant, used to arm the per-tenant timer. */
export async function getNextDueReportAt(tx: Transaction, companyId: number): Promise<Date | null> {
  const res = await tx.query<{ next_run_at: string | null }>(
    `SELECT MIN(next_run_at)::text AS next_run_at
       FROM report_schedules
      WHERE company_id = $1 AND is_active = TRUE`,
    [companyId]
  );
  const value = res.rows[0]?.next_run_at;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function listReportSchedules(tx: Transaction, companyId: number): Promise<ReportScheduleRow[]> {
  const res = await tx.query<Record<string, unknown>>(
    `SELECT * FROM report_schedules
      WHERE company_id = $1
      ORDER BY is_active DESC, next_run_at ASC, id ASC`,
    [companyId]
  );
  return res.rows.map(mapSchedule);
}

export async function getReportSchedule(
  tx: Transaction,
  companyId: number,
  id: number
): Promise<ReportScheduleRow> {
  const res = await tx.query<Record<string, unknown>>(
    `SELECT * FROM report_schedules WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, id]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Report schedule not found', 'REPORT_SCHEDULE_NOT_FOUND');
  }
  return mapSchedule(res.rows[0]);
}

export async function createReportSchedule(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: Record<string, unknown>
): Promise<ReportScheduleRow> {
  const name = String(input.name || '').trim();
  if (!name) throw new AccountingError(400, 'name is required', 'SCHEDULE_NAME_REQUIRED');
  const reportKey = assertReportKey(input.reportKey ?? input.report_key);
  const frequency = String(input.frequency || 'monthly') as ReportFrequency;
  if (!['daily', 'weekly', 'monthly', 'quarterly'].includes(frequency)) {
    throw new AccountingError(400, 'frequency must be daily, weekly, monthly, or quarterly', 'INVALID_FREQUENCY');
  }
  const timeOfDay = parseTimeOfDay(input.timeOfDay ?? input.time_of_day ?? '07:00');
  const dayOfWeek =
    input.dayOfWeek === undefined || input.dayOfWeek === null ? null : Number(input.dayOfWeek);
  const dayOfMonth =
    input.dayOfMonth === undefined || input.dayOfMonth === null ? null : Number(input.dayOfMonth);
  const recipients = normalizeRecipients(input.recipients);
  const filters = (input.filters as Record<string, unknown>) || (input.filters_json as Record<string, unknown>) || {};
  const nextRun = computeNextRun(frequency, timeOfDay, new Date(), dayOfWeek, dayOfMonth);

  const ins = await tx.query<Record<string, unknown>>(
    `INSERT INTO report_schedules (
       company_id, name, report_key, frequency, day_of_week, day_of_month, time_of_day,
       recipients, filters_json, is_active, next_run_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::TIME, $8::TEXT[], $9::JSONB, $10, $11, $12
     )
     RETURNING *`,
    [
      companyId,
      name,
      reportKey,
      frequency,
      dayOfWeek,
      dayOfMonth,
      timeOfDay,
      recipients,
      JSON.stringify(filters),
      input.isActive === undefined ? true : Boolean(input.isActive),
      nextRun.toISOString(),
      actor.userId,
    ]
  );
  const schedule = mapSchedule(ins.rows[0]);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REPORT_SCHEDULE_CREATED',
    tableName: 'report_schedules',
    recordId: schedule.id,
    newValues: {
      name: schedule.name,
      reportKey: schedule.report_key,
      frequency: schedule.frequency,
      recipients: schedule.recipients,
    },
  });
  return schedule;
}

export async function updateReportSchedule(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  id: number,
  input: Record<string, unknown>
): Promise<ReportScheduleRow> {
  const current = await getReportSchedule(tx, companyId, id);
  const name = input.name === undefined ? current.name : String(input.name || '').trim();
  if (!name) throw new AccountingError(400, 'name is required', 'SCHEDULE_NAME_REQUIRED');
  const reportKey =
    input.reportKey === undefined && input.report_key === undefined
      ? current.report_key
      : assertReportKey(input.reportKey ?? input.report_key);
  const frequency =
    input.frequency === undefined ? current.frequency : (String(input.frequency) as ReportFrequency);
  if (!['daily', 'weekly', 'monthly', 'quarterly'].includes(frequency)) {
    throw new AccountingError(400, 'Invalid frequency', 'INVALID_FREQUENCY');
  }
  const timeOfDay =
    input.timeOfDay === undefined && input.time_of_day === undefined
      ? current.time_of_day
      : parseTimeOfDay(input.timeOfDay ?? input.time_of_day);
  const dayOfWeek =
    input.dayOfWeek === undefined
      ? current.day_of_week
      : input.dayOfWeek === null
      ? null
      : Number(input.dayOfWeek);
  const dayOfMonth =
    input.dayOfMonth === undefined
      ? current.day_of_month
      : input.dayOfMonth === null
      ? null
      : Number(input.dayOfMonth);
  const recipients =
    input.recipients === undefined ? current.recipients : normalizeRecipients(input.recipients);
  const filters =
    input.filters === undefined && input.filters_json === undefined
      ? current.filters_json
      : (input.filters as Record<string, unknown>) ||
        (input.filters_json as Record<string, unknown>) ||
        {};
  const isActive = input.isActive === undefined ? current.is_active : Boolean(input.isActive);
  const nextRun = computeNextRun(frequency, timeOfDay, new Date(), dayOfWeek, dayOfMonth);

  const updated = await tx.query<Record<string, unknown>>(
    `UPDATE report_schedules
        SET name = $3,
            report_key = $4,
            frequency = $5,
            day_of_week = $6,
            day_of_month = $7,
            time_of_day = $8::TIME,
            recipients = $9::TEXT[],
            filters_json = $10::JSONB,
            is_active = $11,
            next_run_at = $12
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [
      companyId,
      id,
      name,
      reportKey,
      frequency,
      dayOfWeek,
      dayOfMonth,
      timeOfDay,
      recipients,
      JSON.stringify(filters),
      isActive,
      nextRun.toISOString(),
    ]
  );
  const schedule = mapSchedule(updated.rows[0]);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REPORT_SCHEDULE_UPDATED',
    tableName: 'report_schedules',
    recordId: id,
    oldValues: { name: current.name, frequency: current.frequency, nextRunAt: current.next_run_at },
    newValues: { name: schedule.name, frequency: schedule.frequency, nextRunAt: schedule.next_run_at },
  });
  return schedule;
}

export async function deleteReportSchedule(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  id: number
): Promise<{ deleted: boolean; id: number }> {
  await getReportSchedule(tx, companyId, id);
  await tx.query(`DELETE FROM report_schedules WHERE company_id = $1 AND id = $2`, [companyId, id]);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REPORT_SCHEDULE_DELETED',
    tableName: 'report_schedules',
    recordId: id,
  });
  return { deleted: true, id };
}

export async function generateReportSnapshot(
  tx: Transaction,
  companyId: number,
  reportKey: ReportScheduleKey,
  filters: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const startDate = filters.startDate ? String(filters.startDate) : undefined;
  const endDate = filters.endDate ? String(filters.endDate) : todayIsoDate();
  switch (reportKey) {
    case 'trial_balance':
      return getTrialBalance(tx, companyId, { startDate, endDate });
    case 'profit_and_loss':
      return getProfitAndLoss(tx, companyId, { startDate, endDate });
    case 'balance_sheet':
      return getBalanceSheet(tx, companyId, { asOfDate: endDate });
    case 'cash_flow':
      return getCashFlowStatement(tx, companyId, { startDate, endDate });
    case 'ar_aging':
      return getArAgingReport(tx, companyId, endDate);
    case 'ap_aging':
      return getApAgingReport(tx, companyId, endDate);
    case 'budget_vs_actual':
      return getBudgetVsActualReport(
        tx,
        companyId,
        Number(filters.fiscalYear || new Date().getUTCFullYear()),
        Number(filters.startMonth || 1),
        Number(filters.endMonth || 12)
      );
    case 'tax_summary':
      return getTaxSummaryReport(tx, companyId, startDate, endDate);
    case 'job_profitability':
      return getPrintingJobProfitability(tx, companyId, { startDate, endDate });
    case 'wip_aging':
      return getWipAgingReport(tx, companyId);
    case 'inventory_valuation':
      return getInventoryValuationReport(tx, companyId);
    case 'cogs_reconciliation':
      return getCogsReconciliationReport(tx, companyId, { startDate, endDate });
    default:
      throw new AccountingError(400, 'Unsupported report key', 'INVALID_REPORT_KEY');
  }
}

export async function runReportSchedule(
  tx: Transaction,
  companyId: number,
  id: number,
  actor: ActorContext
): Promise<{ schedule: ReportScheduleRow; run: Record<string, unknown>; snapshot: Record<string, unknown> }> {
  const schedule = await getReportSchedule(tx, companyId, id);
  const nextRun = computeNextRun(
    schedule.frequency,
    schedule.time_of_day,
    new Date(),
    schedule.day_of_week,
    schedule.day_of_month
  );
  let snapshot: Record<string, unknown>;
  try {
    snapshot = await generateReportSnapshot(tx, companyId, schedule.report_key, schedule.filters_json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const run = await tx.query<Record<string, unknown>>(
      `INSERT INTO report_schedule_runs (company_id, schedule_id, run_date, status, recipients_count, error_message)
       VALUES ($1, $2, $3::DATE, 'failed', $4, $5)
       RETURNING *`,
      [companyId, id, todayIsoDate(), schedule.recipients.length, message]
    );
    // Advance the schedule so a permanently broken report cannot hot-loop every tick.
    await tx.query(
      `UPDATE report_schedules SET last_run_at = NOW(), next_run_at = $3 WHERE company_id = $1 AND id = $2`,
      [companyId, id, nextRun.toISOString()]
    );
    await writeAuditLog(tx, {
      companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'REPORT_SCHEDULE_FAILED',
      tableName: 'report_schedule_runs',
      recordId: Number(run.rows[0].id),
      newValues: { scheduleId: id, error: message, nextRunAt: nextRun.toISOString() },
    });
    throw err;
  }

  const runRes = await tx.query<Record<string, unknown>>(
    `INSERT INTO report_schedule_runs (company_id, schedule_id, run_date, status, recipients_count, report_json)
     VALUES ($1, $2, $3::DATE, 'completed', $4, $5::JSONB)
     RETURNING *`,
    [companyId, id, todayIsoDate(), schedule.recipients.length, JSON.stringify(snapshot)]
  );
  const run = mapScheduleRun(runRes.rows[0]);
  const emailBody = renderReportEmailBody(schedule, snapshot);

  for (const recipient of schedule.recipients) {
    await tx.query(
      `INSERT INTO email_log (company_id, recipient, subject, entity_type, entity_id, status, sent_by, body)
       VALUES ($1, $2, $3, 'report_schedule', $4, 'queued', $5, $6)`,
      [
        companyId,
        recipient,
        `[Scheduled Report] ${schedule.name} — ${todayIsoDate()}`,
        id,
        actor.userId,
        emailBody,
      ]
    );
  }

  await tx.query(
    `UPDATE report_schedules SET last_run_at = NOW(), next_run_at = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, id, nextRun.toISOString()]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REPORT_SCHEDULE_RUN',
    tableName: 'report_schedule_runs',
    recordId: Number(run.id),
    newValues: {
      scheduleId: id,
      reportKey: schedule.report_key,
      recipients: schedule.recipients.length,
      nextRunAt: nextRun.toISOString(),
    },
  });

  return {
    schedule: { ...schedule, last_run_at: new Date().toISOString(), next_run_at: nextRun.toISOString() },
    run,
    snapshot,
  };
}

function mapScheduleRun(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    scheduleId: Number(row.schedule_id),
    runDate: String(row.run_date),
    status: String(row.status),
    recipientsCount: Number(row.recipients_count ?? 0),
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: String(row.created_at),
  };
}

export async function runDueReportSchedules(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  now = new Date()
): Promise<Array<{ scheduleId: number; name: string; status: string; runId?: number }>> {
  const dueRes = await tx.query<Record<string, unknown>>(
    `SELECT id, name FROM report_schedules
      WHERE company_id = $1 AND is_active = TRUE AND next_run_at <= $2
      ORDER BY next_run_at ASC, id ASC
      FOR UPDATE SKIP LOCKED`,
    [companyId, now.toISOString()]
  );
  const results: Array<{ scheduleId: number; name: string; status: string; runId?: number }> = [];
  for (const row of dueRes.rows) {
    const id = Number(row.id);
    try {
      const result = await runReportSchedule(tx, companyId, id, actor);
      results.push({
        scheduleId: id,
        name: String(row.name),
        status: 'completed',
        runId: Number(result.run.id),
      });
    } catch (err) {
      results.push({
        scheduleId: id,
        name: String(row.name),
        status: 'failed',
      });
    }
  }
  return results;
}

export async function getDashboardAlerts(tx: Transaction, companyId: number) {
  const today = todayIsoDate();
  const pendingRes = await tx.query<{ count: string; amount: string }>(
    `SELECT COUNT(*)::text AS count, COALESCE(SUM(amount), 0)::NUMERIC(19,4)::text AS amount
       FROM approval_requests
      WHERE company_id = $1 AND status = 'pending'`,
    [companyId]
  );
  const overdueRes = await tx.query<{ count: string; balance: string }>(
    `SELECT COUNT(*)::text AS count, COALESCE(SUM(balance_due), 0)::NUMERIC(19,4)::text AS balance
       FROM invoices
      WHERE company_id = $1
        AND status NOT IN ('paid', 'voided')
        AND due_date < $2::DATE`,
    [companyId, today]
  );
  const lowStockRes = await tx.query<Record<string, unknown>>(
    `SELECT id, sku, name, item_type, on_hand::text AS on_hand, reorder_point::text AS reorder_point
       FROM inventory_items
      WHERE company_id = $1
        AND item_type IN ('raw_material', 'stationery')
        AND reorder_point > 0
        AND on_hand <= reorder_point
      ORDER BY on_hand ASC, sku ASC`,
    [companyId]
  );
  const unclearedBankRes = await tx.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM bank_transactions
      WHERE company_id = $1 AND reconciliation_id IS NULL`,
    [companyId]
  );
  const wipOverBudgetRes = await tx.query<{ count: string; amount: string }>(
    `SELECT COUNT(*)::text AS count,
            COALESCE(SUM(actual_material_cost + actual_waste_cost + actual_labour_cost + actual_machine_cost - approved_budget_total), 0)::NUMERIC(19,4)::text AS amount
       FROM printing_jobs
      WHERE company_id = $1
        AND approved_budget_total > 0
        AND (actual_material_cost + actual_waste_cost + actual_labour_cost + actual_machine_cost) > approved_budget_total`,
    [companyId]
  );
  const stuckJobsRes = await tx.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM printing_jobs
      WHERE company_id = $1
        AND status IN ('queued', 'in_production', 'finishing', 'qc_pending')
        AND job_date < (CURRENT_DATE - INTERVAL '14 days')`,
    [companyId]
  );
  const policiesRes = await tx.query<{ disabled: string; total: string }>(
    `SELECT COUNT(*) FILTER (WHERE is_enabled = FALSE)::text AS disabled,
            COUNT(*)::text AS total
       FROM approval_policies
      WHERE company_id = $1`,
    [companyId]
  );
  const emailDeliveryRes = await tx.query<{ failed: string; skipped: string }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
            COUNT(*) FILTER (WHERE status = 'skipped')::text AS skipped
       FROM email_log
      WHERE company_id = $1`,
    [companyId]
  );

  const alerts: Array<Record<string, unknown>> = [];
  const pendingCount = Number(pendingRes.rows[0]?.count ?? 0);
  if (pendingCount > 0) {
    alerts.push({
      key: 'pending_approvals',
      severity: 'warning',
      title: 'Approval requests awaiting decision',
      count: pendingCount,
      amount: formatDecimal4(parseDecimal4(pendingRes.rows[0]?.amount ?? 0)),
      detail: 'Maker-checker queue has items that block release of documents.',
    });
  }
  const overdue = overdueRes.rows[0];
  if (Number(overdue?.count ?? 0) > 0) {
    alerts.push({
      key: 'overdue_receivables',
      severity: 'critical',
      title: 'Overdue customer invoices',
      count: Number(overdue?.count ?? 0),
      amount: formatDecimal4(parseDecimal4(overdue?.balance ?? 0)),
      detail: `Invoices past due before ${today}.`,
    });
  }
  if (lowStockRes.rows.length > 0) {
    alerts.push({
      key: 'low_stock',
      severity: 'warning',
      title: 'Raw materials at or below reorder point',
      count: lowStockRes.rows.length,
      items: lowStockRes.rows.map(r => ({
        itemId: Number(r.id),
        sku: String(r.sku),
        name: String(r.name),
        onHand: r.on_hand,
        reorderPoint: r.reorder_point,
      })),
    });
  }
  const uncleared = Number(unclearedBankRes.rows[0]?.count ?? 0);
  if (uncleared > 0) {
    alerts.push({
      key: 'unreconciled_bank',
      severity: 'warning',
      title: 'Bank transactions not reconciled',
      count: uncleared,
      detail: 'Open bank items require reconciliation before period close.',
    });
  }
  const wipOver = wipOverBudgetRes.rows[0];
  if (Number(wipOver?.count ?? 0) > 0) {
    alerts.push({
      key: 'wip_over_budget',
      severity: 'warning',
      title: 'Printing jobs over approved budget',
      count: Number(wipOver?.count ?? 0),
      amount: formatDecimal4(parseDecimal4(wipOver?.amount ?? 0)),
      detail: 'Actual accumulated cost exceeds approved job budget.',
    });
  }
  const stuck = Number(stuckJobsRes.rows[0]?.count ?? 0);
  if (stuck > 0) {
    alerts.push({
      key: 'stuck_jobs',
      severity: 'warning',
      title: 'Production jobs open for more than 14 days',
      count: stuck,
      detail: 'Jobs remain in queue/production/finishing/QC for over two weeks.',
    });
  }
  const disabledPolicies = Number(policiesRes.rows[0]?.disabled ?? 0);
  if (disabledPolicies > 0) {
    alerts.push({
      key: 'approval_policies_disabled',
      severity: 'info',
      title: 'Maker-checker policies not enabled',
      count: disabledPolicies,
      total: Number(policiesRes.rows[0]?.total ?? 0),
      detail:
        'Enable approval policies for invoices, bills, payments, journals, credit memos, estimate conversions, and PO receipts.',
    });
  }
  const failedEmails = Number(emailDeliveryRes.rows[0]?.failed ?? 0);
  if (failedEmails > 0) {
    alerts.push({
      key: 'email_delivery_failed',
      severity: 'warning',
      title: 'Report emails failed permanently',
      count: failedEmails,
      detail:
        'Check SMTP configuration, then re-run the affected report schedule to queue a fresh delivery.',
    });
  }
  const skippedEmails = Number(emailDeliveryRes.rows[0]?.skipped ?? 0);
  if (skippedEmails > 0) {
    alerts.push({
      key: 'email_delivery_skipped',
      severity: 'info',
      title: 'Report emails waiting for SMTP configuration',
      count: skippedEmails,
      detail: 'Emails are retained and will be delivered once SMTP_HOST is configured.',
    });
  }

  return {
    companyId,
    generatedAt: new Date().toISOString(),
    counts: {
      pendingApprovals: pendingCount,
      overdueInvoices: Number(overdue?.count ?? 0),
      lowStockItems: lowStockRes.rows.length,
      unreconciledBank: uncleared,
      wipOverBudget: Number(wipOver?.count ?? 0),
      stuckJobs: stuck,
      disabledApprovalPolicies: disabledPolicies,
      failedEmails,
      skippedEmails,
    },
    alerts,
  };
}