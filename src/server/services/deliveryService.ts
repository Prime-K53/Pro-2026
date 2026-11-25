import { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';

export interface Vehicle { id: number; companyId: number; registration: string; make: string | null; model: string | null; capacityKg: string | null; capacityVolume: string | null; status: string; createdAt: string; }
export interface Driver { id: number; companyId: number; employeeId: number | null; name: string; phone: string | null; licenseNumber: string; licenseExpiry: string | null; status: string; createdAt: string; }
export interface DeliverySchedule { id: number; companyId: number; deliveryNoteId: number; scheduledDate: string; timeWindow: string | null; assignedDriverId: number | null; assignedVehicleId: number | null; status: string; createdAt: string; }

export async function listVehicles(tx: Transaction, companyId: number): Promise<Vehicle[]> {
  const res = await tx.query<any>(`SELECT * FROM vehicles WHERE company_id = $1 ORDER BY registration`, [companyId]);
  return res.rows.map((r: any) => ({ id: Number(r.id), companyId: Number(r.company_id), registration: r.registration, make: r.make, model: r.model, capacityKg: r.capacity_kg, capacityVolume: r.capacity_volume, status: r.status, createdAt: r.created_at }));
}

export async function createVehicle(tx: Transaction, companyId: number, input: any): Promise<Vehicle> {
  const res = await tx.query<any>(`INSERT INTO vehicles (company_id, registration, make, model, capacity_kg, capacity_volume) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [companyId, input.registration, input.make || null, input.model || null, input.capacityKg || null, input.capacityVolume || null]);
  const r = res.rows[0];
  return { id: Number(r.id), companyId: Number(r.company_id), registration: r.registration, make: r.make, model: r.model, capacityKg: r.capacity_kg, capacityVolume: r.capacity_volume, status: r.status, createdAt: r.created_at };
}

export async function listDrivers(tx: Transaction, companyId: number): Promise<Driver[]> {
  const res = await tx.query<any>(`SELECT * FROM drivers WHERE company_id = $1 ORDER BY name`, [companyId]);
  return res.rows.map((r: any) => ({ id: Number(r.id), companyId: Number(r.company_id), employeeId: r.employee_id ? Number(r.employee_id) : null, name: r.name, phone: r.phone, licenseNumber: r.license_number, licenseExpiry: r.license_expiry, status: r.status, createdAt: r.created_at }));
}

export async function createDriver(tx: Transaction, companyId: number, input: any): Promise<Driver> {
  const res = await tx.query<any>(`INSERT INTO drivers (company_id, name, phone, license_number, license_expiry, employee_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [companyId, input.name, input.phone || null, input.licenseNumber, input.licenseExpiry || null, input.employeeId || null]);
  const r = res.rows[0];
  return { id: Number(r.id), companyId: Number(r.company_id), employeeId: r.employee_id ? Number(r.employee_id) : null, name: r.name, phone: r.phone, licenseNumber: r.license_number, licenseExpiry: r.license_expiry, status: r.status, createdAt: r.created_at };
}

export async function listSchedules(tx: Transaction, companyId: number): Promise<DeliverySchedule[]> {
  const res = await tx.query<any>(`SELECT * FROM delivery_schedules WHERE company_id = $1 ORDER BY scheduled_date`, [companyId]);
  return res.rows.map((r: any) => ({ id: Number(r.id), companyId: Number(r.company_id), deliveryNoteId: Number(r.delivery_note_id), scheduledDate: r.scheduled_date, timeWindow: r.time_window, assignedDriverId: r.assigned_driver_id ? Number(r.assigned_driver_id) : null, assignedVehicleId: r.assigned_vehicle_id ? Number(r.assigned_vehicle_id) : null, status: r.status, createdAt: r.created_at }));
}

export async function createSchedule(tx: Transaction, companyId: number, input: any): Promise<DeliverySchedule> {
  const res = await tx.query<any>(`INSERT INTO delivery_schedules (company_id, delivery_note_id, scheduled_date, time_window, assigned_driver_id, assigned_vehicle_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [companyId, input.deliveryNoteId, input.scheduledDate, input.timeWindow || null, input.assignedDriverId || null, input.assignedVehicleId || null]);
  const r = res.rows[0];
  return { id: Number(r.id), companyId: Number(r.company_id), deliveryNoteId: Number(r.delivery_note_id), scheduledDate: r.scheduled_date, timeWindow: r.time_window, assignedDriverId: r.assigned_driver_id ? Number(r.assigned_driver_id) : null, assignedVehicleId: r.assigned_vehicle_id ? Number(r.assigned_vehicle_id) : null, status: r.status, createdAt: r.created_at };
}

// ─── Delivery Note interfaces ────────────────────────────────────────────────

export interface DeliveryNote {
  id: number; companyId: number; deliveryNumber: string; customerId: number;
  dispatchDate: string; deliveredAt: string | null; driverName: string | null;
  vehicleReg: string | null; recipientName: string | null; status: string;
  notes: string | null; deliveryCost: string; createdAt: string;
  lines?: DeliveryNoteLine[];
}

export interface DeliveryNoteLine {
  id: number; companyId: number; deliveryNoteId: number;
  printingJobId: number | null; examPaperId: number | null;
  description: string; quantityDispatched: string;
}

function mapNote(r: any): DeliveryNote {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    deliveryNumber: r.delivery_number,
    customerId: Number(r.customer_id),
    dispatchDate: r.dispatch_date,
    deliveredAt: r.delivered_at ?? null,
    driverName: r.driver_name ?? null,
    vehicleReg: r.vehicle_reg ?? null,
    recipientName: r.recipient_name ?? null,
    status: r.status,
    notes: r.notes ?? null,
    deliveryCost: r.delivery_cost ?? '0',
    createdAt: r.created_at,
  };
}

function mapLine(l: any): DeliveryNoteLine {
  return {
    id: Number(l.id),
    companyId: Number(l.company_id),
    deliveryNoteId: Number(l.delivery_note_id),
    printingJobId: l.printing_job_id != null ? Number(l.printing_job_id) : null,
    examPaperId: l.exam_paper_id != null ? Number(l.exam_paper_id) : null,
    description: l.description,
    quantityDispatched: l.quantity_dispatched,
  };
}

// ─── Delivery Note CRUD ──────────────────────────────────────────────────────

export async function listDeliveryNotes(tx: Transaction, companyId: number): Promise<DeliveryNote[]> {
  const res = await tx.query<any>(
    `SELECT * FROM delivery_notes WHERE company_id = $1 ORDER BY dispatch_date DESC`,
    [companyId]
  );
  return res.rows.map(mapNote);
}

export async function getDeliveryNote(tx: Transaction, companyId: number, id: number): Promise<DeliveryNote> {
  const noteRes = await tx.query<any>(
    `SELECT * FROM delivery_notes WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  if (!noteRes.rows.length) throw new AccountingError(404, 'Delivery note not found', 'NOT_FOUND');
  const note = mapNote(noteRes.rows[0]);
  const linesRes = await tx.query<any>(
    `SELECT * FROM delivery_note_lines WHERE company_id = $1 AND delivery_note_id = $2`,
    [companyId, id]
  );
  note.lines = linesRes.rows.map(mapLine);
  return note;
}

export async function createDeliveryNote(tx: Transaction, companyId: number, input: any): Promise<DeliveryNote> {
  const year = new Date().getFullYear();
  const seqRes = await tx.query<any>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(delivery_number FROM '[0-9]+$') AS BIGINT)) + 1, 1) AS next_seq
     FROM delivery_notes WHERE company_id = $1 AND delivery_number LIKE $2`,
    [companyId, `DN-${year}-%`]
  );
  const seq = Number(seqRes.rows[0].next_seq);
  const deliveryNumber = `DN-${year}-${String(seq).padStart(4, '0')}`;

  const res = await tx.query<any>(
    `INSERT INTO delivery_notes (company_id, delivery_number, customer_id, dispatch_date, driver_name, vehicle_reg, recipient_name, notes, delivery_cost)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      companyId,
      deliveryNumber,
      input.customerId,
      input.dispatchDate,
      input.driverName || null,
      input.vehicleReg || null,
      input.recipientName || null,
      input.notes || null,
      input.deliveryCost || 0,
    ]
  );
  const note = mapNote(res.rows[0]);

  if (Array.isArray(input.lines) && input.lines.length > 0) {
    const lines: DeliveryNoteLine[] = [];
    for (const line of input.lines) {
      const lr = await tx.query<any>(
        `INSERT INTO delivery_note_lines (company_id, delivery_note_id, printing_job_id, exam_paper_id, description, quantity_dispatched)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [companyId, note.id, line.printingJobId || null, line.examPaperId || null, line.description, line.quantityDispatched]
      );
      lines.push(mapLine(lr.rows[0]));
    }
    note.lines = lines;
  } else {
    note.lines = [];
  }

  return note;
}

export async function dispatchDeliveryNote(
  tx: Transaction,
  companyId: number,
  id: number,
  input: { driverName?: string; vehicleReg?: string; assignedDriverId?: number; assignedVehicleId?: number }
): Promise<DeliveryNote> {
  const check = await tx.query<any>(
    `SELECT status FROM delivery_notes WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  if (!check.rows.length) throw new AccountingError(404, 'Delivery note not found', 'NOT_FOUND');
  if (check.rows[0].status !== 'prepared') {
    throw new AccountingError(422, `Cannot dispatch: delivery note is '${check.rows[0].status}', expected 'prepared'`, 'INVALID_STATUS');
  }

  const res = await tx.query<any>(
    `UPDATE delivery_notes
     SET status = 'in_transit',
         driver_name = COALESCE($3, driver_name),
         vehicle_reg = COALESCE($4, vehicle_reg)
     WHERE company_id = $1 AND id = $2
     RETURNING *`,
    [companyId, id, input.driverName || null, input.vehicleReg || null]
  );
  return mapNote(res.rows[0]);
}

export async function markDelivered(
  tx: Transaction,
  companyId: number,
  id: number,
  input: { recipientName?: string; notes?: string }
): Promise<DeliveryNote> {
  const check = await tx.query<any>(
    `SELECT status FROM delivery_notes WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  if (!check.rows.length) throw new AccountingError(404, 'Delivery note not found', 'NOT_FOUND');
  if (check.rows[0].status !== 'in_transit') {
    throw new AccountingError(422, `Cannot mark delivered: delivery note is '${check.rows[0].status}', expected 'in_transit'`, 'INVALID_STATUS');
  }

  const res = await tx.query<any>(
    `UPDATE delivery_notes
     SET status = 'delivered',
         delivered_at = NOW(),
         recipient_name = COALESCE($3, recipient_name),
         notes = COALESCE($4, notes)
     WHERE company_id = $1 AND id = $2
     RETURNING *`,
    [companyId, id, input.recipientName || null, input.notes || null]
  );
  return mapNote(res.rows[0]);
}

export async function cancelDeliveryNote(tx: Transaction, companyId: number, id: number): Promise<DeliveryNote> {
  const check = await tx.query<any>(
    `SELECT status FROM delivery_notes WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  if (!check.rows.length) throw new AccountingError(404, 'Delivery note not found', 'NOT_FOUND');
  if (!['prepared', 'in_transit'].includes(check.rows[0].status)) {
    throw new AccountingError(422, `Cannot cancel: delivery note is '${check.rows[0].status}'`, 'INVALID_STATUS');
  }

  const res = await tx.query<any>(
    `UPDATE delivery_notes SET status = 'cancelled' WHERE company_id = $1 AND id = $2 RETURNING *`,
    [companyId, id]
  );
  return mapNote(res.rows[0]);
}