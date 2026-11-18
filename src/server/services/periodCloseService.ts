import { Transaction } from '@electric-sql/pglite';
import { writeAuditLog } from '../audit.ts';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import { getTrialBalance } from './financialReports.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { hasPendingApprovals } from './approvalService.ts';

interface PeriodRow {
  id: number;
  company_id: number;
  period_name: string;
  start_date: string;
  end_date: string;
  status: string;
}

export interface PeriodChecklistTask {
  id: number;
  company_id: number;
  period_id: number;
  task_key: string;
  label: string;
  category: string;
  is_required: boolean;
  is_manual: boolean;
  status: 'pending' | 'complete' | 'waived';
  evidence_json: Record<string, unknown>;
  notes: string | null;
  completed_by: number | null;
  completed_at: string | null;
  sort_order: number;
}

export interface PeriodChecklistResult {
  period: PeriodRow;
  tasks: PeriodChecklistTask[];
  allRequiredComplete: boolean;
  canClose: boolean;
  enforced: boolean;
}

const SETTING_KEY = 'period_close_requires_checklist';
const TOLERANCE4 = 100n; // 0.0100 currency units

const AUTO_TASKS: Array<{
  taskKey: string;
  label: string;
  category: string;
  sortOrder: number;
  isRequired: boolean;
}> = [
  {
    taskKey: 'trial_balance_balanced',
    label: 'Trial balance is balanced for the period',
    category: 'ledger',
    sortOrder: 10,
    isRequired: true,
  },
  {
    taskKey: 'bank_reconciled',
    label: 'All bank transactions in the period are reconciled',
    category: 'banking',
    sortOrder: 20,
    isRequired: true,
  },
  {
    taskKey: 'ar_subledger_ties',
    label: 'Accounts receivable subledger ties to the general ledger',
    category: 'subledger',
    sortOrder: 30,
    isRequired: true,
  },
  {
    taskKey: 'ap_subledger_ties',
    label: 'Accounts payable subledger ties to the general ledger',
    category: 'subledger',
    sortOrder: 40,
    isRequired: true,
  },
  {
    taskKey: 'inventory_subledger_ties',
    label: 'Inventory valuation ties to the inventory asset general ledger',
    category: 'subledger',
    sortOrder: 50,
    isRequired: true,
  },
  {
    taskKey: 'pending_approvals_cleared',
    label: 'No approval requests remain pending for the period',
    category: 'controls',
    sortOrder: 60,
    isRequired: true,
  },
];

const MANUAL_TASKS: Array<{
  taskKey: string;
  label: string;
  category: string;
  sortOrder: number;
  isRequired: boolean;
  instructions: string;
}> = [
  {
    taskKey: 'accruals_reviewed',
    label: 'Accruals and prepayments reviewed',
    category: 'adjustments',
    sortOrder: 70,
    isRequired: false,
    instructions: 'Confirm accrued expenses, prepaid expenses, and unearned revenue are complete.',
  },
  {
    taskKey: 'fx_revaluation_reviewed',
    label: 'Foreign currency balances revalued',
    category: 'adjustments',
    sortOrder: 80,
    isRequired: false,
    instructions: 'Review open AR/AP in foreign currency and post realized/unrealized FX adjustments.',
  },
  {
    taskKey: 'recurring_invoices_reviewed',
    label: 'Recurring invoices and memorized transactions reviewed',
    category: 'review',
    sortOrder: 90,
    isRequired: false,
    instructions: 'Confirm all due recurring invoices were generated and no duplicates were created.',
  },
  {
    taskKey: 'management_signoff',
    label: 'Management sign-off obtained for period close',
    category: 'governance',
    sortOrder: 100,
    isRequired: true,
    instructions: 'A manager or director must review the period-end reports and sign off before close.',
  },
];

function mapTask(row: Record<string, unknown>): PeriodChecklistTask {
  return {
    id: Number(row.id),
    company_id: Number(row.company_id),
    period_id: Number(row.period_id),
    task_key: String(row.task_key),
    label: String(row.label),
    category: String(row.category),
    is_required: Boolean(row.is_required),
    is_manual: Boolean(row.is_manual),
    status: row.status as PeriodChecklistTask['status'],
    evidence_json: (row.evidence_json as Record<string, unknown>) ?? {},
    notes: row.notes ? String(row.notes) : null,
    completed_by: row.completed_by === null || row.completed_by === undefined ? null : Number(row.completed_by),
    completed_at: row.completed_at ? String(row.completed_at) : null,
    sort_order: Number(row.sort_order ?? 100),
  };
}

async function getPeriod(tx: Transaction, companyId: number, periodId: number): Promise<PeriodRow> {
  const res = await tx.query<PeriodRow>(
    `SELECT id, company_id, period_name, start_date::text AS start_date, end_date::text AS end_date, status
       FROM fiscal_periods
      WHERE company_id = $1 AND id = $2
      LIMIT 1`,
    [companyId, periodId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Fiscal period not found', 'PERIOD_NOT_FOUND');
  }
  return res.rows[0];
}

async function accountBalanceAtDate(
  tx: Transaction,
  companyId: number,
  accountCode: string,
  asOfDate: string
): Promise<bigint> {
  const res = await tx.query<{ balance: string }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::NUMERIC(19,4)::text AS balance
       FROM journal_lines jl
       JOIN journal_transactions jt
         ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
       JOIN accounts a
         ON a.company_id = jl.company_id AND a.id = jl.account_id
      WHERE jl.company_id = $1
        AND jt.is_posted = TRUE
        AND a.code = $2
        AND jt.txn_date <= $3::DATE`,
    [companyId, accountCode, asOfDate]
  );
  return parseDecimal4(res.rows[0]?.balance ?? '0');
}

async function computeAutoTasks(
  tx: Transaction,
  companyId: number,
  period: PeriodRow
): Promise<Array<{ taskKey: string; evidence: Record<string, unknown>; status: 'complete' | 'pending' }>> {
  const results: Array<{ taskKey: string; evidence: Record<string, unknown>; status: 'complete' | 'pending' }> = [];

  const tb = await getTrialBalance(tx, companyId, {
    startDate: period.start_date,
    endDate: period.end_date,
  });
  results.push({
    taskKey: 'trial_balance_balanced',
    evidence: {
      isBalanced: tb.isBalanced,
      totalDebit: tb.totalDebit,
      totalCredit: tb.totalCredit,
      difference: tb.difference,
    },
    status: tb.isBalanced ? 'complete' : 'pending',
  });

  const bankRes = await tx.query<{ uncleared: string; total: string }>(
    `SELECT
        COUNT(*) FILTER (WHERE reconciliation_id IS NULL)::text AS uncleared,
        COUNT(*)::text AS total
       FROM bank_transactions
      WHERE company_id = $1
        AND txn_date BETWEEN $2::DATE AND $3::DATE`,
    [companyId, period.start_date, period.end_date]
  );
  const unclearedCount = Number(bankRes.rows[0]?.uncleared ?? 0);
  results.push({
    taskKey: 'bank_reconciled',
    evidence: {
      unclearedCount,
      totalCount: Number(bankRes.rows[0]?.total ?? 0),
      asOfDate: period.end_date,
    },
    status: unclearedCount === 0 ? 'complete' : 'pending',
  });

  const arSubRes = await tx.query<{ balance: string }>(
    `SELECT COALESCE(SUM(balance), 0)::NUMERIC(19,4)::text AS balance FROM customers WHERE company_id = $1`,
    [companyId]
  );
  const arSub4 = parseDecimal4(arSubRes.rows[0]?.balance ?? '0');
  const arGl4 = await accountBalanceAtDate(tx, companyId, '1100', period.end_date);
  const arDiff4 = arSub4 - arGl4;
  results.push({
    taskKey: 'ar_subledger_ties',
    evidence: {
      subledger: formatDecimal4(arSub4),
      generalLedger: formatDecimal4(arGl4),
      difference: formatDecimal4(arDiff4),
      tolerance: formatDecimal4(TOLERANCE4),
    },
    status: (arDiff4 < 0n ? -arDiff4 : arDiff4) <= TOLERANCE4 ? 'complete' : 'pending',
  });

  const apSubRes = await tx.query<{ balance: string }>(
    `SELECT COALESCE(SUM(balance), 0)::NUMERIC(19,4)::text AS balance FROM vendors WHERE company_id = $1`,
    [companyId]
  );
  const apSub4 = parseDecimal4(apSubRes.rows[0]?.balance ?? '0');
  const apGl4 = await accountBalanceAtDate(tx, companyId, '2000', period.end_date);
  const apDiff4 = apSub4 - apGl4;
  results.push({
    taskKey: 'ap_subledger_ties',
    evidence: {
      subledger: formatDecimal4(apSub4),
      generalLedger: formatDecimal4(apGl4),
      difference: formatDecimal4(apDiff4),
      tolerance: formatDecimal4(TOLERANCE4),
    },
    status: (apDiff4 < 0n ? -apDiff4 : apDiff4) <= TOLERANCE4 ? 'complete' : 'pending',
  });

  const invSubRes = await tx.query<{ value: string }>(
    `SELECT COALESCE(SUM(ROUND(on_hand * avg_cost, 4)), 0)::NUMERIC(19,4)::text AS value
       FROM inventory_items
      WHERE company_id = $1 AND item_type IN ('raw_material', 'stationery')`,
    [companyId]
  );
  const invSub4 = parseDecimal4(invSubRes.rows[0]?.value ?? '0');
  const invGl4 = await accountBalanceAtDate(tx, companyId, '1200', period.end_date);
  const invDiff4 = invSub4 - invGl4;
  results.push({
    taskKey: 'inventory_subledger_ties',
    evidence: {
      subledger: formatDecimal4(invSub4),
      generalLedger: formatDecimal4(invGl4),
      difference: formatDecimal4(invDiff4),
      tolerance: formatDecimal4(TOLERANCE4),
    },
    status: (invDiff4 < 0n ? -invDiff4 : invDiff4) <= TOLERANCE4 ? 'complete' : 'pending',
  });

  const pending = await hasPendingApprovals(tx, companyId, period.start_date, period.end_date);
  results.push({
    taskKey: 'pending_approvals_cleared',
    evidence: { pendingCount: pending.count, pendingAmount: pending.amount },
    status: pending.count === 0 ? 'complete' : 'pending',
  });

  return results;
}

export async function getPeriodChecklist(
  tx: Transaction,
  companyId: number,
  periodId: number,
  _actor?: ActorContext
): Promise<PeriodChecklistResult> {
  const period = await getPeriod(tx, companyId, periodId);
  const autoResults = await computeAutoTasks(tx, companyId, period);

  for (const def of AUTO_TASKS) {
    const auto = autoResults.find(r => r.taskKey === def.taskKey)!;
    await tx.query(
      `INSERT INTO fiscal_period_close_tasks (
         company_id, period_id, task_key, label, category, is_required, is_manual,
         status, evidence_json, sort_order
       ) VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $8::JSONB, $9)
       ON CONFLICT (company_id, period_id, task_key) DO UPDATE SET
         label = EXCLUDED.label,
         category = EXCLUDED.category,
         is_required = EXCLUDED.is_required,
         evidence_json = EXCLUDED.evidence_json,
         status = CASE
           WHEN fiscal_period_close_tasks.status = 'waived' THEN 'waived'
           ELSE EXCLUDED.status
         END`,
      [
        companyId,
        periodId,
        def.taskKey,
        def.label,
        def.category,
        def.isRequired,
        auto.status,
        JSON.stringify(auto.evidence),
        def.sortOrder,
      ]
    );
  }

  for (const def of MANUAL_TASKS) {
    await tx.query(
      `INSERT INTO fiscal_period_close_tasks (
         company_id, period_id, task_key, label, category, is_required, is_manual,
         status, evidence_json, sort_order
       ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'pending', $7::JSONB, $8)
       ON CONFLICT (company_id, period_id, task_key) DO UPDATE SET
         label = EXCLUDED.label,
         category = EXCLUDED.category,
         is_required = EXCLUDED.is_required`,
      [
        companyId,
        periodId,
        def.taskKey,
        def.label,
        def.category,
        def.isRequired,
        JSON.stringify({ manual: true, instructions: def.instructions }),
        def.sortOrder,
      ]
    );
  }

  const res = await tx.query<Record<string, unknown>>(
    `SELECT t.*,
            u.display_name AS completed_by_name
       FROM fiscal_period_close_tasks t
       LEFT JOIN users u ON u.id = t.completed_by
      WHERE t.company_id = $1 AND t.period_id = $2
      ORDER BY t.sort_order ASC, t.id ASC`,
    [companyId, periodId]
  );

  const tasks = res.rows.map(mapTask);
  const enforced = await isChecklistEnforced(tx, companyId);
  const allRequiredComplete = tasks.filter(t => t.is_required).every(t => t.status !== 'pending');
  return {
    period,
    tasks,
    allRequiredComplete,
    canClose: allRequiredComplete,
    enforced,
  };
}

async function isChecklistEnforced(tx: Transaction, companyId: number): Promise<boolean> {
  const res = await tx.query<{ setting_value: string | null }>(
    `SELECT setting_value FROM company_settings WHERE company_id = $1 AND setting_key = $2 LIMIT 1`,
    [companyId, SETTING_KEY]
  );
  return String(res.rows[0]?.setting_value || '').toLowerCase() === 'true';
}

export async function enforcePeriodCloseChecklist(
  tx: Transaction,
  companyId: number,
  periodId: number
): Promise<void> {
  if (!(await isChecklistEnforced(tx, companyId))) return;
  const checklist = await getPeriodChecklist(tx, companyId, periodId);
  if (checklist.allRequiredComplete) return;
  const incomplete = checklist.tasks
    .filter(t => t.is_required && t.status === 'pending')
    .map(t => t.task_key);
  throw new AccountingError(
    409,
    `Period cannot be closed: required checklist tasks are incomplete (${incomplete.join(', ')})`,
    'CLOSE_CHECKLIST_INCOMPLETE'
  );
}

export async function completePeriodChecklistTask(
  tx: Transaction,
  companyId: number,
  periodId: number,
  actor: ActorContext,
  input: { taskKey: string; status?: 'complete' | 'waived'; notes?: string | null }
): Promise<PeriodChecklistTask> {
  const taskKey = String(input.taskKey || '').trim();
  if (!taskKey) {
    throw new AccountingError(400, 'taskKey is required', 'TASK_KEY_REQUIRED');
  }
  await getPeriodChecklist(tx, companyId, periodId, actor);

  const res = await tx.query<Record<string, unknown>>(
    `SELECT * FROM fiscal_period_close_tasks
      WHERE company_id = $1 AND period_id = $2 AND task_key = $3
      LIMIT 1`,
    [companyId, periodId, taskKey]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Checklist task not found', 'TASK_NOT_FOUND');
  }
  const task = mapTask(res.rows[0]);
  const status = input.status === 'waived' ? 'waived' : 'complete';
  const note = input.notes?.trim() || null;

  if (!task.is_manual) {
    throw new AccountingError(
      400,
      'Automatic checklist tasks are derived from ledger evidence and cannot be completed manually; waive them with a note if an override is required.',
      'AUTO_TASK_NOT_MANUAL'
    );
  }
  if (status === 'waived' && !note) {
    throw new AccountingError(400, 'A note is required when waiving a checklist task', 'WAIVER_NOTE_REQUIRED');
  }

  const updated = await tx.query<Record<string, unknown>>(
    `UPDATE fiscal_period_close_tasks
        SET status = $4,
            notes = $5,
            completed_by = $6,
            completed_at = NOW()
      WHERE company_id = $1 AND period_id = $2 AND task_key = $3
      RETURNING *`,
    [companyId, periodId, taskKey, status, note, actor.userId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: status === 'waived' ? 'PERIOD_CHECKLIST_WAIVED' : 'PERIOD_CHECKLIST_COMPLETED',
    tableName: 'fiscal_period_close_tasks',
    recordId: Number(updated.rows[0].id),
    oldValues: { status: task.status },
    newValues: { status, note },
  });

  return mapTask(updated.rows[0]);
}

export async function setPeriodCloseChecklistPolicy(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  enabled: boolean
): Promise<{ enabled: boolean }> {
  await tx.query(
    `INSERT INTO company_settings (company_id, setting_key, setting_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, setting_key)
     DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [companyId, SETTING_KEY, enabled ? 'true' : 'false']
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PERIOD_CLOSE_POLICY_UPDATED',
    tableName: 'company_settings',
    recordId: 0,
    newValues: { settingKey: SETTING_KEY, enabled },
  });
  return { enabled };
}