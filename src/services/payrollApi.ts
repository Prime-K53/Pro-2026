import { emitAccountingUpdated } from './accountingApi';
import { requestJson } from './http';

export interface PayrollStubInput {
  employeeId: number;
  hoursRegular: string | number;
  hoursOvertime: string | number;
}

export interface ApiPayrollRun {
  runId: number;
  runNumber: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  payDate: string;
  totalGross: number;
  totalNet: number;
  totalEmployeeTaxes: number;
  totalEmployerTaxes: number;
  journalTransactionId: number;
  entryNumber: string;
  items: Array<{
    employeeId: number;
    hoursRegular: number;
    hoursOvertime: number;
    grossPay: number;
    fit: number;
    socialSecurityEmployee: number;
    medicareEmployee: number;
    sit: number;
    netPay: number;
    socialSecurityEmployer: number;
    medicareEmployer: number;
    futaEmployer: number;
    sutaEmployer: number;
  }>;
}

/**
 * Employee directory row returned by `GET /api/employees`.
 *
 * Sensitive HR fields (`ssnMasked`, `payType`, `payRate`, `payFrequency`) are
 * only populated when the caller's role holds `employees:read_sensitive`
 * (Administrators). Payroll is Administrator-only, so the payroll centre always
 * receives the fields it needs to price the run.
 */
export interface ApiEmployee {
  id: number;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  department: string | null;
  email: string | null;
  hireDate?: string | null;
  ssnMasked?: string | null;
  payType?: string | null;
  payRate?: string | null;
  payFrequency?: string | null;
}

export const payrollApi = {
  async listEmployees(): Promise<ApiEmployee[]> {
    const d = await requestJson<{ employees: ApiEmployee[] }>('/api/employees');
    return d.employees || [];
  },

  async listRuns(): Promise<any[]> {
    const d = await requestJson<{ runs: any[] }>('/api/payroll/runs');
    return d.runs || [];
  },

  /**
   * Execute a payroll run. The server recomputes every amount from its own
   * employee records and posts the journal entry.
   */
  async runPayroll(payload: {
    payPeriodStart: string;
    payPeriodEnd: string;
    payDate: string;
    bankAccountId: number;
    items: PayrollStubInput[];
  }): Promise<ApiPayrollRun> {
    const d = await requestJson<{ run: ApiPayrollRun }>('/api/payroll/runs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.run;
  },
};
