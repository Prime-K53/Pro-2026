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