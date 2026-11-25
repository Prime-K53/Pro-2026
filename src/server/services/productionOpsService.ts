import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, type ActorContext } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';

const JOB_STATUSES = ['queued', 'in_production', 'finishing', 'qc_pending', 'ready', 'delivered', 'completed', 'cancelled'] as const;

async function requireJob(tx: Transaction, companyId: number, jobId: number) {
  const res = await tx.query<any>(
    `SELECT id, job_number, status FROM printing_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, jobId]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Printing job not found', 'JOB_NOT_FOUND');
  return res.rows[0];
}

async function requireMachine(tx: Transaction, companyId: number, machineId: number) {
  const res = await tx.query<any>(
    `SELECT id, machine_code, name, status FROM printing_machines WHERE company_id = $1 AND id = $2`,
    [companyId, machineId]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Machine not found', 'MACHINE_NOT_FOUND');
  return res.rows[0];
}

export async function assignMachineToJob(tx: Transaction, companyId: number, actor: ActorContext, input: { jobId: number; machineId: number; notes?: string | null }) {
  const job = await requireJob(tx, companyId, Number(input.jobId));
  const machine = await requireMachine(tx, companyId, Number(input.machineId));
  const ins = await tx.query<any>(
    `INSERT INTO job_machine_assignments (company_id, job_id, machine_id, assigned_by, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, assigned_at`,
    [companyId, Number(job.id), Number(machine.id), actor.userId, input.notes || null]
  );
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'JOB_MACHINE_ASSIGNED', tableName: 'job_machine_assignments', recordId: Number(ins.rows[0].id), newValues: { jobId: job.id, jobNumber: job.job_number, machineId: machine.id, machineCode: machine.machine_code } });
  return { assignmentId: Number(ins.rows[0].id), jobId: Number(job.id), jobNumber: job.job_number, machineId: Number(machine.id), machineCode: machine.machine_code, assignedAt: ins.rows[0].assigned_at };
}

export async function logMachineDowntime(tx: Transaction, companyId: number, actor: ActorContext, input: { machineId: number; jobId?: number | null; startedAt?: string | null; endedAt?: string | null; downtimeMinutes?: number | null; reasonCode?: string | null; reason?: string | null }) {
  const machine = await requireMachine(tx, companyId, Number(input.machineId));
  let jobId: number | null = null;
  if (input.jobId) { const job = await requireJob(tx, companyId, Number(input.jobId)); jobId = Number(job.id); }
  const startedAt = input.startedAt ? new Date(input.startedAt).toISOString() : new Date().toISOString();
  const endedAt = input.endedAt ? new Date(input.endedAt).toISOString() : null;
  let minutes = input.downtimeMinutes == null ? null : Number(input.downtimeMinutes);
  if (minutes == null && endedAt) {
    const diff = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000));
    minutes = diff;
  }
  const ins = await tx.query<any>(
    `INSERT INTO machine_downtime_events (company_id, machine_id, job_id, started_at, ended_at, downtime_minutes, reason_code, reason, created_by)
     VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7,$8,$9) RETURNING id`,
    [companyId, Number(machine.id), jobId, startedAt, endedAt, minutes, input.reasonCode || null, input.reason || null, actor.userId]
  );
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'MACHINE_DOWNTIME_LOGGED', tableName: 'machine_downtime_events', recordId: Number(ins.rows[0].id), newValues: { machineId: machine.id, jobId, downtimeMinutes: minutes, reasonCode: input.reasonCode || null } });
  return { downtimeId: Number(ins.rows[0].id), machineId: Number(machine.id), jobId, downtimeMinutes: minutes };
}

export async function moveJobStage(tx: Transaction, companyId: number, actor: ActorContext, input: { jobId: number; toStatus: string; reason?: string | null }) {
  const job = await requireJob(tx, companyId, Number(input.jobId));
  const toStatus = String(input.toStatus || '').trim();
  if (!JOB_STATUSES.includes(toStatus as any)) {
    throw new AccountingError(400, `Invalid job status: ${toStatus}`, 'INVALID_JOB_STATUS');
  }
  if (String(job.status) === toStatus) {
    return { jobId: Number(job.id), jobNumber: job.job_number, fromStatus: job.status, toStatus, idempotent: true };
  }
  await tx.query(`UPDATE printing_jobs SET status = $3, updated_at = NOW() WHERE company_id = $1 AND id = $2`, [companyId, Number(job.id), toStatus]);
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'JOB_STAGE_MOVED', tableName: 'printing_jobs', recordId: Number(job.id), oldValues: { status: job.status }, newValues: { status: toStatus, reason: input.reason || null } });
  return { jobId: Number(job.id), jobNumber: job.job_number, fromStatus: job.status, toStatus };
}

export async function listMachineDowntime(tx: Transaction, companyId: number, machineId?: number) {
  const params: any[] = [companyId];
  let where = 'WHERE d.company_id = $1';
  if (machineId) { params.push(machineId); where += ` AND d.machine_id = $${params.length}`; }
  const res = await tx.query<any>(
    `SELECT d.*, m.machine_code, m.name AS machine_name, j.job_number
       FROM machine_downtime_events d
       JOIN printing_machines m ON m.company_id = d.company_id AND m.id = d.machine_id
       LEFT JOIN printing_jobs j ON j.company_id = d.company_id AND j.id = d.job_id
      ${where}
      ORDER BY d.started_at DESC, d.id DESC LIMIT 200`,
    params
  );
  return res.rows.map((r: any) => ({ id: Number(r.id), machineId: Number(r.machine_id), machineCode: r.machine_code, machineName: r.machine_name, jobId: r.job_id == null ? null : Number(r.job_id), jobNumber: r.job_number || null, startedAt: r.started_at, endedAt: r.ended_at, downtimeMinutes: r.downtime_minutes == null ? null : Number(r.downtime_minutes), reasonCode: r.reason_code || '', reason: r.reason || '' }));
}
