import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, type ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { writeAuditLog } from '../audit.ts';

/**
 * Server-side payroll execution.
 *
 * Payroll used to be computed in the browser and "posted" by mutating local
 * account balances, so the general ledger never saw it. The server now
 * recomputes every amount from its own employee records and posts the
 * resulting journal entry in the same transaction as the pay-run rows.
 */

export interface PayrollHoursInput {
  employeeId: number;
  hoursRegular: string | number;
  hoursOvertime: string | number;
}

export interface RunPayrollInput {
  payPeriodStart: string;
  payPeriodEnd: string;
  payDate: string;
  bankAccountId: number;
  items: PayrollHoursInput[];
}

export interface PayrollComputation {
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
}

function assertIsoDate(value: unknown, field: string): string {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AccountingError(400, `${field} must be YYYY-MM-DD`, 'INVALID_DATE');
  }
  return raw;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Payroll tax computation.
 *
 * Mirrors `src/services/taxCalculation.ts` so the browser preview and the
 * server's authoritative numbers agree, but the server value is the one that
 * reaches the ledger.
 */
export function computePayrollItem(
  employee: {
    id: number;
    payType: string;
    payRate: number;
    payFrequency: string;
    w4Allowances: number;
    filingStatus: string;
  },
  hoursWorked: number,
  overtimeHours: number
): PayrollComputation {
  let grossPay = 0;

  if (employee.payType === 'hourly') {
    const regularRate = employee.payRate;
    const overtimeRate = regularRate * 1.5;
    grossPay = hoursWorked * regularRate + overtimeHours * overtimeRate;
  } else {
    const periodsPerYear =
      employee.payFrequency === 'weekly'
        ? 52
        : employee.payFrequency === 'biweekly'
        ? 26
        : employee.payFrequency === 'semimonthly'
        ? 24
        : 12;
    grossPay = employee.payRate / periodsPerYear;
  }
  grossPay = round2(grossPay);

  const socialSecurityEmployee = round2(grossPay * 0.062);
  const socialSecurityEmployer = socialSecurityEmployee;
  const medicareEmployee = round2(grossPay * 0.0145);
  const medicareEmployer = medicareEmployee;

  const allowanceValue = 180.0;
  const taxableGross = Math.max(0, grossPay - employee.w4Allowances * allowanceValue);

  let fitRate = 0.1;
  if (employee.filingStatus === 'single') {
    if (taxableGross > 3800) fitRate = 0.24;
    else if (taxableGross > 1800) fitRate = 0.22;
    else if (taxableGross > 900) fitRate = 0.12;
  } else if (employee.filingStatus === 'married') {
    if (taxableGross > 5500) fitRate = 0.24;
    else if (taxableGross > 3200) fitRate = 0.22;
    else if (taxableGross > 1600) fitRate = 0.12;
  } else {
    if (taxableGross > 4200) fitRate = 0.24;
    else if (taxableGross > 2200) fitRate = 0.22;
    else if (taxableGross > 1200) fitRate = 0.12;
  }

  const fit = round2(taxableGross * fitRate);
  const sit = round2(grossPay * 0.04);
  const netPay = round2(grossPay - (socialSecurityEmployee + medicareEmployee + fit + sit));
  const futaEmployer = round2(grossPay * 0.006);
  const sutaEmployer = round2(grossPay * 0.027);

  return {
    employeeId: employee.id,
    hoursRegular: hoursWorked,
    hoursOvertime: overtimeHours,
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

interface AccountRow {
  id: number;
  code: string | null;
  account_type: string;
}

/** Resolve an account by preferred code, then by account type. */
async function resolveAccount(
  tx: Transaction,
  companyId: number,
  preferredCodes: string[],
  fallbackTypes: string[]
): Promise<number | null> {
  const byCode = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = TRUE AND code = ANY($2::TEXT[])
      ORDER BY array_position($2::TEXT[], code)
      LIMIT 1`,
    [companyId, preferredCodes]
  );
  if (byCode.rows.length > 0) return Number(byCode.rows[0].id);

  const byType = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = TRUE AND account_type = ANY($2::TEXT[])
      ORDER BY id LIMIT 1`,
    [companyId, fallbackTypes]
  );
  return byType.rows.length > 0 ? Number(byType.rows[0].id) : null;
}

export async function runPayroll(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: RunPayrollInput
) {
  const payPeriodStart = assertIsoDate(input.payPeriodStart, 'payPeriodStart');
  const payPeriodEnd = assertIsoDate(input.payPeriodEnd, 'payPeriodEnd');
  const payDate = assertIsoDate(input.payDate, 'payDate');
  if (payPeriodEnd < payPeriodStart) {
    throw new AccountingError(400, 'payPeriodEnd cannot be earlier than payPeriodStart', 'INVALID_PERIOD');
  }

  const bankAccountId = Number(input.bankAccountId);
  if (!Number.isInteger(bankAccountId) || bankAccountId <= 0) {
    throw new AccountingError(400, 'A valid bank account is required to disburse payroll', 'INVALID_BANK_ACCOUNT');
  }

  const bankCheck = await tx.query<{ id: number; account_type: string }>(
    `SELECT id, account_type FROM accounts WHERE company_id = $1 AND id = $2 AND is_active = TRUE`,
    [companyId, bankAccountId]
  );
  if (bankCheck.rows.length === 0) {
    throw new AccountingError(400, 'Payroll bank account not found in active company', 'INVALID_BANK_ACCOUNT');
  }
  if (bankCheck.rows[0].account_type !== 'Bank') {
    throw new AccountingError(400, 'Payroll must be disbursed from a Bank account', 'INVALID_BANK_ACCOUNT');
  }

  const hoursByEmployee = new Map<number, { regular: number; overtime: number }>();
  for (const item of input.items || []) {
    const empId = Number(item.employeeId);
    if (!Number.isInteger(empId) || empId <= 0) continue;
    hoursByEmployee.set(empId, {
      regular: Math.max(0, Number(item.hoursRegular) || 0),
      overtime: Math.max(0, Number(item.hoursOvertime) || 0),
    });
  }
  if (hoursByEmployee.size === 0) {
    throw new AccountingError(400, 'No employee hours supplied for this payroll run', 'NO_PAYROLL_ITEMS');
  }

  const empIds = Array.from(hoursByEmployee.keys());
  const empRes = await tx.query<{
    id: number;
    first_name: string;
    last_name: string;
    pay_type: string;
    pay_rate: string;
    pay_frequency: string;
    w4_allowances: number;
    filing_status: string;
    is_active: boolean;
  }>(
    `SELECT id, first_name, last_name, pay_type, pay_rate::text, pay_frequency,
            w4_allowances, filing_status, is_active
       FROM employees
      WHERE company_id = $1 AND id = ANY($2::BIGINT[])`,
    [companyId, empIds]
  );
  if (empRes.rows.length === 0) {
    throw new AccountingError(400, 'No employees matched the supplied payroll lines', 'NO_PAYROLL_EMPLOYEES');
  }

  const computations: PayrollComputation[] = [];
  for (const emp of empRes.rows) {
    if (!emp.is_active) continue;
    const hours = hoursByEmployee.get(Number(emp.id))!;
    computations.push(
      computePayrollItem(
        {
          id: Number(emp.id),
          payType: emp.pay_type,
          payRate: Number(emp.pay_rate),
          payFrequency: emp.pay_frequency,
          w4Allowances: Number(emp.w4_allowances || 0),
          filingStatus: emp.filing_status,
        },
        hours.regular,
        hours.overtime
      )
    );
  }
  if (computations.length === 0) {
    throw new AccountingError(400, 'No active employees matched the supplied payroll lines', 'NO_PAYROLL_EMPLOYEES');
  }

  const sum = (pick: (c: PayrollComputation) => number) =>
    computations.reduce((acc, c) => acc + pick(c), 0);

  const totalGross = round2(sum(c => c.grossPay));
  const totalNet = round2(sum(c => c.netPay));
  const totalFit = round2(sum(c => c.fit));
  const totalSit = round2(sum(c => c.sit));
  const totalEmployeeFica = round2(sum(c => c.socialSecurityEmployee + c.medicareEmployee));
  const totalEmployerFica = round2(sum(c => c.socialSecurityEmployer + c.medicareEmployer));
  const totalFica = round2(totalEmployeeFica + totalEmployerFica);
  const totalUnemployment = round2(sum(c => c.futaEmployer + c.sutaEmployer));
  const totalEmployerTaxes = round2(totalEmployerFica + totalUnemployment);
  const totalEmployeeTaxes = round2(totalFit + totalSit + totalEmployeeFica);

  const accounts: AccountRow[] = (
    await tx.query<AccountRow>(
      `SELECT id, code, account_type FROM accounts WHERE company_id = $1 AND is_active = TRUE`,
      [companyId]
    )
  ).rows;

  const findByCode = (codes: string[]): number | null => {
    for (const code of codes) {
      const hit = accounts.find(a => a.code === code);
      if (hit) return Number(hit.id);
    }
    return null;
  };
  const findByType = (types: string[]): number | null => {
    const hit = accounts.find(a => types.includes(a.account_type));
    return hit ? Number(hit.id) : null;
  };

  const salaryExpenseId =
    findByCode(['6010', '6000']) ??
    findByType(['Expense', 'OtherExpense']) ??
    (await resolveAccount(tx, companyId, ['6010', '6000'], ['Expense', 'OtherExpense']));
  const employerTaxExpenseId = findByCode(['6020']) ?? salaryExpenseId ?? findByType(['Expense', 'OtherExpense']);
  const fitPayableId = findByCode(['2100']) ?? findByType(['PayrollLiability']);
  const ficaPayableId = findByCode(['2110']) ?? fitPayableId;
  const sitPayableId = findByCode(['2120']) ?? fitPayableId;
  const unemploymentPayableId = findByCode(['2130']) ?? fitPayableId;

  if (!salaryExpenseId) {
    throw new AccountingError(400, 'No salary expense account is configured for this company', 'NO_PAYROLL_ACCOUNTS');
  }
  if (!fitPayableId || !ficaPayableId || !sitPayableId || !unemploymentPayableId) {
    throw new AccountingError(400, 'Payroll liability accounts are not configured for this company', 'NO_PAYROLL_ACCOUNTS');
  }

  const salaryExpenseAccount = salaryExpenseId;
  const employerTaxExpenseAccount = employerTaxExpenseId ?? salaryExpenseAccount;
  const fitPayableAccount = fitPayableId;
  const ficaPayableAccount = ficaPayableId;
  const sitPayableAccount = sitPayableId;
  const unemploymentPayableAccount = unemploymentPayableId;

  const runNumberRes = await tx.query<{ n: string }>(
    `SELECT COALESCE(MAX(run_number), '') AS n FROM pay_runs WHERE company_id = $1`,
    [companyId]
  );
  const runNumber = `PR-${new Date().getUTCFullYear()}-${String(runNumberRes.rows[0].n.split('-').pop() || 0 + 1).padStart(4, '0')}`;

  const journalLines = [
    {
      accountId: salaryExpenseAccount,
      debit: formatDecimal4(parseDecimal4(totalGross)),
      credit: '0',
      description: 'Gross payroll expense',
    },
    {
      accountId: employerTaxExpenseAccount,
      debit: formatDecimal4(parseDecimal4(totalEmployerTaxes)),
      credit: '0',
      description: 'Employer payroll taxes (FICA, FUTA, SUTA)',
    },
    {
      accountId: bankAccountId,
      debit: '0',
      credit: formatDecimal4(parseDecimal4(totalNet)),
      description: 'Net payroll disbursement',
    },
    {
      accountId: ficaPayableAccount,
      debit: '0',
      credit: formatDecimal4(parseDecimal4(totalFica)),
      description: 'FICA payable (employee + employer)',
    },
    {
      accountId: fitPayableAccount,
      debit: '0',
      credit: formatDecimal4(parseDecimal4(totalFit)),
      description: 'Federal income tax payable',
    },
    {
      accountId: sitPayableAccount,
      debit: '0',
      credit: formatDecimal4(parseDecimal4(totalSit)),
      description: 'State income tax payable',
    },
    {
      accountId: unemploymentPayableAccount,
      debit: '0',
      credit: formatDecimal4(parseDecimal4(totalUnemployment)),
      description: 'Unemployment tax payable (FUTA/SUTA)',
    },
  ];

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: payDate,
    description: `Payroll run ${runNumber}`,
    memo: `Payroll ${payPeriodStart} → ${payPeriodEnd} paid ${payDate}`,
    reference: runNumber,
    sourceType: 'payroll',
    sourceId: null,
    lines: journalLines.map(l => ({
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: l.description,
    })),
  });

  const runIns = await tx.query<{ id: number }>(
    `INSERT INTO pay_runs (
       company_id, run_number, pay_period_start, pay_period_end, pay_date, bank_account_id,
       total_gross, total_net, total_employee_taxes, total_employer_taxes, status, journal_txn_id
     ) VALUES ($1, $2, $3::DATE, $4::DATE, $5::DATE, $6, $7::NUMERIC(19,4), $8::NUMERIC(19,4),
               $9::NUMERIC(19,4), $10::NUMERIC(19,4), 'processed', $11)
     RETURNING id`,
    [
      companyId,
      runNumber,
      payPeriodStart,
      payPeriodEnd,
      payDate,
      bankAccountId,
      formatDecimal4(parseDecimal4(totalGross)),
      formatDecimal4(parseDecimal4(totalNet)),
      formatDecimal4(parseDecimal4(totalEmployeeTaxes)),
      formatDecimal4(parseDecimal4(totalEmployerTaxes)),
      posted.transaction.id,
    ]
  );
  const runId = Number(runIns.rows[0].id);

  for (const c of computations) {
    await tx.query(
      `INSERT INTO pay_stubs (
         company_id, pay_run_id, employee_id, hours_regular, hours_overtime, gross_pay,
         federal_tax, state_tax, ss_employee, medicare_employee, net_pay,
         ss_employer, medicare_employer, futa_employer, suta_employer
       ) VALUES ($1, $2, $3, $4::NUMERIC(10,4), $5::NUMERIC(10,4), $6::NUMERIC(19,4),
                 $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9::NUMERIC(19,4), $10::NUMERIC(19,4),
                 $11::NUMERIC(19,4), $12::NUMERIC(19,4), $13::NUMERIC(19,4), $14::NUMERIC(19,4), $15::NUMERIC(19,4))`,
      [
        companyId,
        runId,
        c.employeeId,
        formatDecimal4(parseDecimal4(c.hoursRegular)),
        formatDecimal4(parseDecimal4(c.hoursOvertime)),
        formatDecimal4(parseDecimal4(c.grossPay)),
        formatDecimal4(parseDecimal4(c.fit)),
        formatDecimal4(parseDecimal4(c.sit)),
        formatDecimal4(parseDecimal4(c.socialSecurityEmployee)),
        formatDecimal4(parseDecimal4(c.medicareEmployee)),
        formatDecimal4(parseDecimal4(c.netPay)),
        formatDecimal4(parseDecimal4(c.socialSecurityEmployer)),
        formatDecimal4(parseDecimal4(c.medicareEmployer)),
        formatDecimal4(parseDecimal4(c.futaEmployer)),
        formatDecimal4(parseDecimal4(c.sutaEmployer)),
      ]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PAYROLL_PROCESSED',
    tableName: 'pay_runs',
    recordId: runId,
    newValues: {
      runNumber,
      payPeriodStart,
      payPeriodEnd,
      payDate,
      employeeCount: computations.length,
      totalGross,
      totalNet,
      totalEmployeeTaxes,
      totalEmployerTaxes,
      journalTransactionId: posted.transaction.id,
    },
  });

  return {
    runId,
    runNumber,
    payPeriodStart,
    payPeriodEnd,
    payDate,
    totalGross,
    totalNet,
    totalEmployeeTaxes,
    totalEmployerTaxes,
    journalTransactionId: posted.transaction.id,
    entryNumber: posted.transaction.entryNumber,
    items: computations,
  };
}

