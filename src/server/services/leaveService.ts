import { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';

export interface LeaveType {
  id: number;
  companyId: number;
  code: string;
  name: string;
  accrualDays: number;
  maxCarryForward: number;
  isPaid: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface LeaveBalance {
  id: number;
  companyId: number;
  employeeId: number;
  leaveTypeId: number;
  leaveTypeName?: string;
  year: number;
  openingBalance: number;
  accrued: number;
  taken: number;
  adjusted: number;
  remaining: number;
  updatedAt: string;
}

export interface LeaveRequest {
  id: number;
  companyId: number;
  employeeId: number;
  employeeName?: string;
  leaveTypeId: number;
  leaveTypeName?: string;
  startDate: string;
  endDate: string;
  daysRequested: number;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  approvedBy: number | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listLeaveTypes(tx: Transaction, companyId: number): Promise<LeaveType[]> {
  const res = await tx.query<any>(
    `SELECT * FROM leave_types WHERE company_id = $1 ORDER BY name ASC`,
    [companyId]
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    code: r.code,
    name: r.name,
    accrualDays: Number(r.accrual_days),
    maxCarryForward: Number(r.max_carry_forward),
    isPaid: Boolean(r.is_paid),
    isActive: Boolean(r.is_active),
    createdAt: r.created_at,
  }));
}

export async function createLeaveType(
  tx: Transaction,
  companyId: number,
  input: { code: string; name: string; accrualDays?: number; maxCarryForward?: number; isPaid?: boolean }
): Promise<LeaveType> {
  const res = await tx.query<any>(
    `INSERT INTO leave_types (company_id, code, name, accrual_days, max_carry_forward, is_paid)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      companyId,
      input.code.trim().toUpperCase(),
      input.name.trim(),
      input.accrualDays ?? 21,
      input.maxCarryForward ?? 5,
      input.isPaid ?? true,
    ]
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    code: r.code,
    name: r.name,
    accrualDays: Number(r.accrual_days),
    maxCarryForward: Number(r.max_carry_forward),
    isPaid: Boolean(r.is_paid),
    isActive: Boolean(r.is_active),
    createdAt: r.created_at,
  };
}

export async function getEmployeeLeaveBalances(
  tx: Transaction,
  companyId: number,
  employeeId: number,
  year: number = new Date().getFullYear()
): Promise<LeaveBalance[]> {
  const res = await tx.query<any>(
    `SELECT b.*, t.name AS leave_type_name
       FROM leave_balances b
       JOIN leave_types t ON t.id = b.leave_type_id
      WHERE b.company_id = $1 AND b.employee_id = $2 AND b.year = $3
      ORDER BY t.name ASC`,
    [companyId, employeeId, year]
  );
  return res.rows.map(r => {
    const opening = Number(r.opening_balance);
    const accrued = Number(r.accrued);
    const taken = Number(r.taken);
    const adjusted = Number(r.adjusted);
    return {
      id: Number(r.id),
      companyId: Number(r.company_id),
      employeeId: Number(r.employee_id),
      leaveTypeId: Number(r.leave_type_id),
      leaveTypeName: r.leave_type_name,
      year: Number(r.year),
      openingBalance: opening,
      accrued,
      taken,
      adjusted,
      remaining: opening + accrued + adjusted - taken,
      updatedAt: r.updated_at,
    };
  });
}

export async function listLeaveRequests(
  tx: Transaction,
  companyId: number,
  filters?: { employeeId?: number; status?: string }
): Promise<LeaveRequest[]> {
  let query = `
    SELECT lr.*, lt.name AS leave_type_name, e.first_name || ' ' || e.last_name AS employee_name
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      LEFT JOIN employees e ON e.id = lr.employee_id
     WHERE lr.company_id = $1
  `;
  const params: any[] = [companyId];

  if (filters?.employeeId) {
    params.push(filters.employeeId);
    query += ` AND lr.employee_id = $${params.length}`;
  }
  if (filters?.status) {
    params.push(filters.status);
    query += ` AND lr.status = $${params.length}`;
  }

  query += ` ORDER BY lr.created_at DESC`;

  const res = await tx.query<any>(query, params);
  return res.rows.map(r => ({
    id: Number(r.id),
    companyId: Number(r.company_id),
    employeeId: Number(r.employee_id),
    employeeName: r.employee_name || `Employee #${r.employee_id}`,
    leaveTypeId: Number(r.leave_type_id),
    leaveTypeName: r.leave_type_name,
    startDate: r.start_date,
    endDate: r.end_date,
    daysRequested: Number(r.days_requested),
    reason: r.reason,
    status: r.status,
    approvedBy: r.approved_by ? Number(r.approved_by) : null,
    approvedAt: r.approved_at,
    rejectionReason: r.rejection_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function createLeaveRequest(
  tx: Transaction,
  companyId: number,
  input: { employeeId: number; leaveTypeId: number; startDate: string; endDate: string; daysRequested: number; reason?: string }
): Promise<LeaveRequest> {
  if (input.daysRequested <= 0) {
    throw new AccountingError(400, 'daysRequested must be greater than 0', 'INVALID_DAYS');
  }

  const res = await tx.query<any>(
    `INSERT INTO leave_requests (company_id, employee_id, leave_type_id, start_date, end_date, days_requested, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      companyId,
      input.employeeId,
      input.leaveTypeId,
      input.startDate,
      input.endDate,
      input.daysRequested,
      input.reason || null,
    ]
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    employeeId: Number(r.employee_id),
    leaveTypeId: Number(r.leave_type_id),
    startDate: r.start_date,
    endDate: r.end_date,
    daysRequested: Number(r.days_requested),
    reason: r.reason,
    status: r.status,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function approveLeaveRequest(
  tx: Transaction,
  companyId: number,
  id: number,
  approvedBy: number
): Promise<LeaveRequest> {
  const reqRes = await tx.query<any>(
    `SELECT * FROM leave_requests WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, id]
  );
  if (!reqRes.rows.length) {
    throw new AccountingError(404, 'Leave request not found', 'NOT_FOUND');
  }
  const req = reqRes.rows[0];
  if (req.status !== 'pending') {
    throw new AccountingError(422, `Cannot approve: request is '${req.status}'`, 'INVALID_STATUS');
  }

  const year = new Date(req.start_date).getFullYear();

  // Upsert leave balance record and record taken days
  await tx.query(
    `INSERT INTO leave_balances (company_id, employee_id, leave_type_id, year, taken)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (company_id, employee_id, leave_type_id, year)
     DO UPDATE SET taken = leave_balances.taken + $5, updated_at = now()`,
    [companyId, req.employee_id, req.leave_type_id, year, req.days_requested]
  );

  const res = await tx.query<any>(
    `UPDATE leave_requests
        SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, id, approvedBy]
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    employeeId: Number(r.employee_id),
    leaveTypeId: Number(r.leave_type_id),
    startDate: r.start_date,
    endDate: r.end_date,
    daysRequested: Number(r.days_requested),
    reason: r.reason,
    status: r.status,
    approvedBy: Number(r.approved_by),
    approvedAt: r.approved_at,
    rejectionReason: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function rejectLeaveRequest(
  tx: Transaction,
  companyId: number,
  id: number,
  rejectionReason: string
): Promise<LeaveRequest> {
  const reqRes = await tx.query<any>(
    `SELECT * FROM leave_requests WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, id]
  );
  if (!reqRes.rows.length) {
    throw new AccountingError(404, 'Leave request not found', 'NOT_FOUND');
  }
  const req = reqRes.rows[0];
  if (req.status !== 'pending') {
    throw new AccountingError(422, `Cannot reject: request is '${req.status}'`, 'INVALID_STATUS');
  }

  const res = await tx.query<any>(
    `UPDATE leave_requests
        SET status = 'rejected', rejection_reason = $3, updated_at = now()
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [companyId, id, rejectionReason]
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    employeeId: Number(r.employee_id),
    leaveTypeId: Number(r.leave_type_id),
    startDate: r.start_date,
    endDate: r.end_date,
    daysRequested: Number(r.days_requested),
    reason: r.reason,
    status: r.status,
    approvedBy: null,
    approvedAt: null,
    rejectionReason: r.rejection_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function cancelLeaveRequest(
  tx: Transaction,
  companyId: number,
  id: number
): Promise<LeaveRequest> {
  const reqRes = await tx.query<any>(
    `SELECT * FROM leave_requests WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, id]
  );
  if (!reqRes.rows.length) {
    throw new AccountingError(404, 'Leave request not found', 'NOT_FOUND');
  }
  const req = reqRes.rows[0];
  if (req.status === 'cancelled') {
    throw new AccountingError(422, 'Request is already cancelled', 'ALREADY_CANCELLED');
  }

  // If was approved, reverse taken days in balance
  if (req.status === 'approved') {
    const year = new Date(req.start_date).getFullYear();
    await tx.query(
      `UPDATE leave_balances
          SET taken = GREATEST(0, taken - $5), updated_at = now()
        WHERE company_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND year = $4`,
      [companyId, req.employee_id, req.leave_type_id, year, req.days_requested]
    );
  }

  const res = await tx.query<any>(
    `UPDATE leave_requests SET status = 'cancelled', updated_at = now() WHERE company_id = $1 AND id = $2 RETURNING *`,
    [companyId, id]
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    employeeId: Number(r.employee_id),
    leaveTypeId: Number(r.leave_type_id),
    startDate: r.start_date,
    endDate: r.end_date,
    daysRequested: Number(r.days_requested),
    reason: r.reason,
    status: r.status,
    approvedBy: r.approved_by ? Number(r.approved_by) : null,
    approvedAt: r.approved_at,
    rejectionReason: r.rejection_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
