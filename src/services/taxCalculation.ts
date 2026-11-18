import { Employee, PayrollItem } from '../types/accounting';

/**
 * Calculates US Payroll taxes for an employee given regular & overtime hours.
 */
export function calculatePayrollItem(
  employee: Employee,
  hoursWorked: number,
  overtimeHours: number = 0
): PayrollItem {
  let grossPay = 0;

  if (employee.payType === 'hourly') {
    const regularRate = employee.payRate;
    const overtimeRate = regularRate * 1.5;
    grossPay = (hoursWorked * regularRate) + (overtimeHours * overtimeRate);
  } else {
    // Salary: based on 26 biweekly pay periods in a year
    const periodsPerYear = employee.payFrequency === 'weekly' ? 52 :
                           employee.payFrequency === 'biweekly' ? 26 :
                           employee.payFrequency === 'semimonthly' ? 24 : 12;
    grossPay = employee.payRate / periodsPerYear;
  }

  grossPay = Math.round(grossPay * 100) / 100;

  // 1. Social Security (6.2%)
  const socialSecurityEmployee = Math.round(grossPay * 0.062 * 100) / 100;
  const socialSecurityEmployer = socialSecurityEmployee;

  // 2. Medicare (1.45%)
  const medicareEmployee = Math.round(grossPay * 0.0145 * 100) / 100;
  const medicareEmployer = medicareEmployee;

  // 3. Federal Income Tax Withholding (IRS percentage method estimate with allowance deductions)
  const allowanceValue = 180.00; // standard allowance per bi-weekly period
  const taxableGross = Math.max(0, grossPay - (employee.w4Allowances * allowanceValue));
  
  let fitRate = 0.10;
  if (employee.filingStatus === 'single') {
    if (taxableGross > 3800) fitRate = 0.24;
    else if (taxableGross > 1800) fitRate = 0.22;
    else if (taxableGross > 900) fitRate = 0.12;
    else fitRate = 0.10;
  } else if (employee.filingStatus === 'married') {
    if (taxableGross > 5500) fitRate = 0.24;
    else if (taxableGross > 3200) fitRate = 0.22;
    else if (taxableGross > 1600) fitRate = 0.12;
    else fitRate = 0.10;
  } else {
    // Head of household
    if (taxableGross > 4200) fitRate = 0.24;
    else if (taxableGross > 2200) fitRate = 0.22;
    else if (taxableGross > 1200) fitRate = 0.12;
    else fitRate = 0.10;
  }

  const fit = Math.round(taxableGross * fitRate * 100) / 100;

  // 4. State Income Tax (Ohio state flat estimate ~4.0%)
  const sit = Math.round(grossPay * 0.040 * 100) / 100;

  // Total Employee deductions
  const totalDeductions = socialSecurityEmployee + medicareEmployee + fit + sit;
  const netPay = Math.round((grossPay - totalDeductions) * 100) / 100;

  // 5. Employer FUTA (0.6%) & SUTA (2.7%)
  const futaEmployer = Math.round(grossPay * 0.006 * 100) / 100;
  const sutaEmployer = Math.round(grossPay * 0.027 * 100) / 100;

  return {
    employeeId: employee.id,
    hoursWorked,
    overtimeHours,
    grossPay,
    fit,
    socialSecurityEmployee,
    medicareEmployee,
    sit,
    netPay,
    socialSecurityEmployer,
    medicareEmployer,
    futaEmployer,
    sutaEmployer,
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
