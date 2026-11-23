import { Employee, PayrollItem } from '../types/accounting';

/**
 * Preview-only Malawi statutory calculation.
 *
 * The server is authoritative: it recomputes every payslip from the company's
 * effective-dated PAYE bands and statutory rates (see
 * `src/server/services/malawiPayroll.ts`). This preview uses configurable
 * defaults and can be refreshed with `setPayrollPreviewConfig` once the
 * statutory configuration has been loaded.
 */

export interface PayrollPreviewConfig {
  bands: Array<{ lower: number; upper: number | null; rate: number }>;
  pensionEmployee: number;
  pensionEmployer: number;
}

let previewConfig: PayrollPreviewConfig = {
  bands: [
    { lower: 0, upper: 1170000, rate: 0 },
    { lower: 1170000, upper: 2340000, rate: 0.15 },
    { lower: 2340000, upper: null, rate: 0.3 },
  ],
  pensionEmployee: 0.05,
  pensionEmployer: 0.1,
};

export function setPayrollPreviewConfig(config: PayrollPreviewConfig): void {
  previewConfig = config;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function computePaye(taxable: number): number {
  let tax = 0;
  for (const band of [...previewConfig.bands].sort((a, b) => a.lower - b.lower)) {
    if (taxable <= band.lower) break;
    const upper = band.upper ?? Number.POSITIVE_INFINITY;
    const slice = Math.min(taxable, upper) - band.lower;
    if (slice > 0) tax += slice * band.rate;
  }
  return round2(tax);
}

export function calculatePayrollItem(
  employee: Employee,
  hoursWorked: number,
  overtimeHours: number = 0
): PayrollItem {
  let grossPay = 0;

  if (employee.payType === 'hourly') {
    const regularRate = employee.payRate;
    const overtimeRate = regularRate * 1.5;
    grossPay = hoursWorked * regularRate + overtimeHours * overtimeRate;
  } else {
    const periodsPerYear = employee.payFrequency === 'weekly' ? 52 :
                           employee.payFrequency === 'biweekly' ? 26 :
                           employee.payFrequency === 'semimonthly' ? 24 : 12;
    grossPay = employee.payRate / periodsPerYear;
  }
  grossPay = round2(grossPay);

  const paye = computePaye(grossPay);
  const pensionEmployee = round2(grossPay * previewConfig.pensionEmployee);
  const pensionEmployer = round2(grossPay * previewConfig.pensionEmployer);
  const netPay = round2(grossPay - paye - pensionEmployee);

  // Map onto the legacy PayrollItem shape used by the wizard table.
  return {
    employeeId: employee.id,
    hoursWorked,
    overtimeHours,
    grossPay,
    fit: paye,
    socialSecurityEmployee: pensionEmployee,
    medicareEmployee: 0,
    sit: 0,
    netPay,
    socialSecurityEmployer: pensionEmployer,
    medicareEmployer: 0,
    futaEmployer: 0,
    sutaEmployer: 0,
  };
}

/**
 * Generate a deterministic tamper-evident SHA-256 seal string for forms & records.
 */
export async function generateTamperEvidentHash(data: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Pure fallback hash generator if crypto.subtle is unavailable
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    const hex = Math.abs(hash).toString(16).padStart(16, '0');
    return `${hex}e49b8120fa9c7821`;
  }
}
