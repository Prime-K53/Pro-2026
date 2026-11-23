import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, type ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { writeAuditLog } from '../audit.ts';
import {
  computeMalawiItem,
  loadMalawiConfig,
  type MalawiStatutoryConfig,
} from './malawiPayroll.ts';

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
  paye: number;
  pensionEmployee: number;
  pensionEmployer: number;
  otherDeductions: number;
  employerOther: number;
  netPay: number;
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
  },
  hoursWorked: number,
  overtimeHours: number,
  config: MalawiStatutoryConfig,
  otherDeductions = 0
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

  const item = computeMalawiItem(grossPay, config);
  const deductions = round2(Math.max(0, otherDeductions));
  const netPay = round2(item.grossPay - item.paye - item.pensionEmployee - deductions);
  return {
    employeeId: employee.id,
    hoursRegular: hoursWorked,
    hoursOvertime: overtimeHours,
    ...item,
    otherDeductions: deductions,
    netPay,
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

  // Period locking: one processed run per pay period.
  const dupRes = await tx.query<{ id: number }>(
    `SELECT id FROM pay_runs
      WHERE company_id = $1 AND pay_period_start = $2::date AND pay_period_end = $3::date
      LIMIT 1`,
    [companyId, payPeriodStart, payPeriodEnd]
  );
  if (dupRes.rows.length > 0) {
    throw new AccountingError(
      409,
      'A payroll run already exists for this pay period',
      'PAYROLL_PERIOD_ALREADY_RUN'
    );
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

  const config = await loadMalawiConfig(tx, companyId, payDate);
  if (!config) {
    throw new AccountingError(
      400,
      'PAYE bands are not configured for this pay date. Configure Malawi statutory rates before running payroll.',
      'PAYE_NOT_CONFIGURED'
    );
  }

  // Salary advance repayments: apply the next installment per active advance.
  const advanceRes = await tx.query<any>(
    `SELECT id, employee_id, amount::text AS amount, repaid_amount::text AS repaid_amount, repayment_schedule
       FROM salary_advances
      WHERE company_id = $1 AND status = 'active' AND employee_id = ANY($2::BIGINT[])`,
    [companyId, empIds]
  );
  const advancesByEmployee = new Map<number, Array<{ id: number; installment: number }>>();
  for (const a of advanceRes.rows) {
    const outstanding = Math.max(0, Number(a.amount) - Number(a.repaid_amount ?? 0));
    if (outstanding <= 0) continue;
    const schedule = Array.isArray(a.repayment_schedule) ? a.repayment_schedule : [];
    const first = Number(schedule[0]?.amount ?? 0);
    const installment = round2(Math.min(outstanding, first > 0 ? first : outstanding));
    if (installment <= 0) continue;
    const list = advancesByEmployee.get(Number(a.employee_id)) ?? [];
    list.push({ id: Number(a.id), installment });
    advancesByEmployee.set(Number(a.employee_id), list);
  }

  const computations: PayrollComputation[] = [];
  for (const emp of empRes.rows) {
    if (!emp.is_active) continue;
    const hours = hoursByEmployee.get(Number(emp.id))!;
    const advanceDeduction = (advancesByEmployee.get(Number(emp.id)) ?? []).reduce(
      (sum, a) => sum + a.installment,
      0
    );
    const structure = await getEffectiveSalaryStructure(tx, companyId, Number(emp.id), payDate);
    computations.push(
      computePayrollItem(
        {
          id: Number(emp.id),
          payType: structure?.payType ?? emp.pay_type,
          payRate: structure?.payRate ?? Number(emp.pay_rate),
          payFrequency: structure?.payFrequency ?? emp.pay_frequency,
        },
        hours.regular,
        hours.overtime,
        config,
        advanceDeduction
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
  const totalPaye = round2(sum(c => c.paye));
  const totalPensionEmployee = round2(sum(c => c.pensionEmployee));
  const totalPensionEmployer = round2(sum(c => c.pensionEmployer));
  const totalOtherDeductions = round2(sum(c => c.otherDeductions));
  const totalEmployerOther = round2(sum(c => c.employerOther));
  const totalEmployerTaxes = round2(totalPensionEmployer + totalEmployerOther);
  const totalEmployeeTaxes = round2(totalPaye + totalPensionEmployee + totalOtherDeductions);

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
  const employerPensionExpenseId =
    findByCode(['6020']) ?? salaryExpenseId ?? findByType(['Expense', 'OtherExpense']);
  const payePayableId = findByCode(['2100']) ?? findByType(['PayrollLiability']);
  const pensionPayableId = findByCode(['2110']) ?? payePayableId;
  const otherDeductionsPayableId = findByCode(['2120']) ?? payePayableId;

  if (!salaryExpenseId) {
    throw new AccountingError(400, 'No salary expense account is configured for this company', 'NO_PAYROLL_ACCOUNTS');
  }
  if (!payePayableId) {
    throw new AccountingError(400, 'Payroll liability accounts are not configured for this company', 'NO_PAYROLL_ACCOUNTS');
  }

  const salaryExpenseAccount = salaryExpenseId;
  const employerPensionExpenseAccount = employerPensionExpenseId ?? salaryExpenseAccount;
  const payePayableAccount = payePayableId;
  const pensionPayableAccount = pensionPayableId ?? salaryExpenseId;
  const otherDeductionsPayableAccount = otherDeductionsPayableId ?? salaryExpenseId;

  const runNumberRes = await tx.query<{ n: string }>(
    `SELECT COALESCE(MAX(run_number), '') AS n FROM pay_runs WHERE company_id = $1`,
    [companyId]
  );
  const lastRunNumber = Number(runNumberRes.rows[0].n.split('-').pop() || 0);
  const runNumber = `PR-${new Date().getUTCFullYear()}-${String(lastRunNumber + 1).padStart(4, '0')}`;

  const totalPensionPayable = round2(totalPensionEmployee + totalPensionEmployer);

  const journalLines = [
    {
      accountId: salaryExpenseAccount,
      debit: formatDecimal4(parseDecimal4(totalGross)),
      credit: '0',
      description: 'Gross payroll expense',
    },
    {
      accountId: employerPensionExpenseAccount,
      debit: formatDecimal4(parseDecimal4(totalEmployerTaxes)),
      credit: '0',
      description: 'Employer pension / statutory contributions',
    },
    {
      accountId: bankAccountId,
      debit: '0',
      credit: formatDecimal4(parseDecimal4(totalNet)),
      description: 'Net payroll disbursement',
    },
    {
      accountId: payePayableAccount,
      debit: '0',
      credit: formatDecimal4(parseDecimal4(totalPaye)),
      description: 'PAYE payable',
    },
    {
      accountId: pensionPayableAccount,
      debit: '0',
      credit: formatDecimal4(parseDecimal4(totalPensionPayable)),
      description: 'Pension payable (employee + employer)',
    },
    {
      accountId: otherDeductionsPayableAccount,
      debit: '0',
      credit: formatDecimal4(parseDecimal4(totalOtherDeductions)),
      description: 'Other deductions payable',
    },
  ].filter(l => parseDecimal4(l.debit) !== 0n || parseDecimal4(l.credit) !== 0n);

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
         ss_employer, medicare_employer, futa_employer, suta_employer,
         paye, pension_employee, pension_employer, other_deductions, employer_other
       ) VALUES ($1, $2, $3, $4::NUMERIC(10,4), $5::NUMERIC(10,4), $6::NUMERIC(19,4),
                 $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9::NUMERIC(19,4), $10::NUMERIC(19,4),
                 $11::NUMERIC(19,4), $12::NUMERIC(19,4), $13::NUMERIC(19,4), $14::NUMERIC(19,4), $15::NUMERIC(19,4),
                 $16::NUMERIC(19,4), $17::NUMERIC(19,4), $18::NUMERIC(19,4), $19::NUMERIC(19,4), $20::NUMERIC(19,4))`,
      [
        companyId,
        runId,
        c.employeeId,
        formatDecimal4(parseDecimal4(c.hoursRegular)),
        formatDecimal4(parseDecimal4(c.hoursOvertime)),
        formatDecimal4(parseDecimal4(c.grossPay)),
        '0', // federal_tax (legacy)
        '0', // state_tax (legacy)
        '0', // ss_employee (legacy)
        '0', // medicare_employee (legacy)
        formatDecimal4(parseDecimal4(c.netPay)),
        '0', // ss_employer (legacy)
        '0', // medicare_employer (legacy)
        '0', // futa_employer (legacy)
        '0', // suta_employer (legacy)
        formatDecimal4(parseDecimal4(c.paye)),
        formatDecimal4(parseDecimal4(c.pensionEmployee)),
        formatDecimal4(parseDecimal4(c.pensionEmployer)),
        formatDecimal4(parseDecimal4(c.otherDeductions)),
        formatDecimal4(parseDecimal4(c.employerOther)),
      ]
    );
  }

  // Persist salary advance repayments for this run.
  for (const advances of advancesByEmployee.values()) {
    for (const adv of advances) {
      await tx.query(
        `UPDATE salary_advances
            SET repaid_amount = repaid_amount + $2::NUMERIC(12,2),
                status = CASE WHEN repaid_amount + $2::NUMERIC(12,2) >= amount THEN 'repaid' ELSE status END,
                updated_at = NOW()
          WHERE company_id = $1 AND id = $3 AND status = 'active'`,
        [companyId, formatDecimal4(parseDecimal4(adv.installment)), adv.id]
      );
    }
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


// ─── Payslips & payroll-to-GL reconciliation ────────────────────────────

export interface Payslip {
  runId: number;
  runNumber: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  payDate: string;
  employeeId: number;
  employeeName: string;
  hoursRegular: number;
  hoursOvertime: number;
  grossPay: number;
  paye: number;
  pensionEmployee: number;
  pensionEmployer: number;
  otherDeductions: number;
  employerOther: number;
  netPay: number;
}

const PAYSLIP_SELECT = `
  SELECT ps.pay_run_id, pr.run_number,
         pr.pay_period_start::text AS pay_period_start,
         pr.pay_period_end::text   AS pay_period_end,
         pr.pay_date::text         AS pay_date,
         ps.employee_id, e.first_name, e.last_name,
         ps.hours_regular, ps.hours_overtime,
         ps.gross_pay::text AS gross_pay,
         ps.paye::text AS paye,
         ps.pension_employee::text AS pension_employee,
         ps.pension_employer::text AS pension_employer,
         ps.other_deductions::text AS other_deductions,
         ps.employer_other::text AS employer_other,
         ps.net_pay::text AS net_pay
    FROM pay_stubs ps
    JOIN pay_runs pr ON pr.company_id = ps.company_id AND pr.id = ps.pay_run_id
    JOIN employees e ON e.company_id = ps.company_id AND e.id = ps.employee_id
   WHERE ps.company_id = $1 AND ps.pay_run_id = $2`;

function mapPayslip(r: any): Payslip {
  return {
    runId: Number(r.pay_run_id),
    runNumber: r.run_number,
    payPeriodStart: String(r.pay_period_start).slice(0, 10),
    payPeriodEnd: String(r.pay_period_end).slice(0, 10),
    payDate: String(r.pay_date).slice(0, 10),
    employeeId: Number(r.employee_id),
    employeeName: [r.first_name, r.last_name].filter(Boolean).join(' '),
    hoursRegular: Number(r.hours_regular),
    hoursOvertime: Number(r.hours_overtime),
    grossPay: Number(r.gross_pay),
    paye: Number(r.paye),
    pensionEmployee: Number(r.pension_employee),
    pensionEmployer: Number(r.pension_employer),
    otherDeductions: Number(r.other_deductions),
    employerOther: Number(r.employer_other),
    netPay: Number(r.net_pay),
  };
}

export async function listPayslips(
  tx: Transaction,
  companyId: number,
  runId: number
): Promise<Payslip[]> {
  const res = await tx.query<any>(`${PAYSLIP_SELECT} ORDER BY e.last_name, e.first_name`, [
    companyId,
    runId,
  ]);
  return res.rows.map(mapPayslip);
}

export async function getPayslip(
  tx: Transaction,
  companyId: number,
  runId: number,
  employeeId: number
): Promise<Payslip | null> {
  const res = await tx.query<any>(
    `${PAYSLIP_SELECT} AND ps.employee_id = $3 LIMIT 1`,
    [companyId, runId, employeeId]
  );
  return res.rows.length > 0 ? mapPayslip(res.rows[0]) : null;
}

export interface PayrollReconciliation {
  runId: number;
  runNumber: string;
  balanced: boolean;
  run: {
    totalGross: number;
    totalNet: number;
    totalEmployeeTaxes: number;
    totalEmployerTaxes: number;
  };
  stubs: {
    count: number;
    gross: number;
    paye: number;
    pensionEmployee: number;
    pensionEmployer: number;
    otherDeductions: number;
    employerOther: number;
    net: number;
  };
  journal: { debit: number; credit: number };
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export async function reconcilePayrollRun(
  tx: Transaction,
  companyId: number,
  runId: number
): Promise<PayrollReconciliation> {
  const runRes = await tx.query<any>(
    `SELECT id, run_number, total_gross::text AS total_gross, total_net::text AS total_net,
            total_employee_taxes::text AS total_employee_taxes,
            total_employer_taxes::text AS total_employer_taxes,
            journal_txn_id
       FROM pay_runs WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, runId]
  );
  if (runRes.rows.length === 0) {
    throw new AccountingError(404, 'Payroll run not found', 'PAYROLL_RUN_NOT_FOUND');
  }
  const run = runRes.rows[0];

  const stubRes = await tx.query<any>(
    `SELECT COUNT(*)::text AS count,
            COALESCE(SUM(gross_pay), 0)::text AS gross,
            COALESCE(SUM(paye), 0)::text AS paye,
            COALESCE(SUM(pension_employee), 0)::text AS pension_employee,
            COALESCE(SUM(pension_employer), 0)::text AS pension_employer,
            COALESCE(SUM(other_deductions), 0)::text AS other_deductions,
            COALESCE(SUM(employer_other), 0)::text AS employer_other,
            COALESCE(SUM(net_pay), 0)::text AS net
       FROM pay_stubs WHERE company_id = $1 AND pay_run_id = $2`,
    [companyId, runId]
  );
  const s = stubRes.rows[0];

  const journalRes = await tx.query<{ debit: string; credit: string }>(
    `SELECT COALESCE(SUM(debit), 0)::text AS debit, COALESCE(SUM(credit), 0)::text AS credit
       FROM journal_lines WHERE company_id = $1 AND transaction_id = $2`,
    [companyId, Number(run.journal_txn_id)]
  );
  const j = journalRes.rows[0];

  const runGross = Number(run.total_gross);
  const runNet = Number(run.total_net);
  const stubGross = Number(s.gross);
  const stubNet = Number(s.net);
  const debit = Number(j.debit);
  const credit = Number(j.credit);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

  const checks = [
    { name: 'journal_debits_equal_credits', ok: near(debit, credit), detail: `${debit} vs ${credit}` },
    { name: 'run_gross_equals_stub_gross', ok: near(runGross, stubGross), detail: `${runGross} vs ${stubGross}` },
    { name: 'run_net_equals_stub_net', ok: near(runNet, stubNet), detail: `${runNet} vs ${stubNet}` },
    {
      name: 'net_plus_deductions_equals_gross',
      ok: near(stubGross, stubNet + Number(s.paye) + Number(s.pension_employee) + Number(s.other_deductions)),
      detail: 'gross = net + PAYE + pension + other',
    },
  ];

  return {
    runId: Number(run.id),
    runNumber: run.run_number,
    balanced: checks.every(c => c.ok),
    run: {
      totalGross: runGross,
      totalNet: runNet,
      totalEmployeeTaxes: Number(run.total_employee_taxes),
      totalEmployerTaxes: Number(run.total_employer_taxes),
    },
    stubs: {
      count: Number(s.count),
      gross: stubGross,
      paye: Number(s.paye),
      pensionEmployee: Number(s.pension_employee),
      pensionEmployer: Number(s.pension_employer),
      otherDeductions: Number(s.other_deductions),
      employerOther: Number(s.employer_other),
      net: stubNet,
    },
    journal: { debit, credit },
    checks,
  };
}

// ─── Phase 5 Extensions: Advances, Deduction Rules, Allowances ────────

export interface SalaryAdvance {
  id: number;
  companyId: number;
  employeeId: number;
  amount: string;
  repaidAmount: string;
  repaymentSchedule: any;
  status: string;
  createdAt: string;
}

export interface DeductionRule {
  id: number;
  companyId: number;
  deductionType: string;
  name: string;
  calculationMethod: string;
  formula: string | null;
  applicableTo: string;
  isTaxDeductible: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
}

export interface EmployeeAllowance {
  id: number;
  companyId: number;
  employeeId: number;
  allowanceType: string;
  amount: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
}

export async function listAdvances(tx: Transaction, companyId: number, employeeId?: number): Promise<SalaryAdvance[]> {
  const params: any[] = [companyId];
  let where = 'WHERE company_id = $1';
  if (employeeId) { params.push(employeeId); where += ` AND employee_id = $${params.length}`; }
  const res = await tx.query<any>(`SELECT * FROM salary_advances ${where} ORDER BY created_at DESC`, params);
  return res.rows.map((r: any) => ({ id: Number(r.id), companyId: Number(r.company_id), employeeId: Number(r.employee_id), amount: r.amount, repaidAmount: r.repaid_amount, repaymentSchedule: r.repayment_schedule, status: r.status, createdAt: r.created_at }));
}

export async function createAdvance(tx: Transaction, companyId: number, employeeId: number, amount: number, repaymentSchedule?: any): Promise<SalaryAdvance> {
  const res = await tx.query<any>(`INSERT INTO salary_advances (company_id, employee_id, amount, repayment_schedule) VALUES ($1, $2, $3, $4) RETURNING *`, [companyId, employeeId, amount, JSON.stringify(repaymentSchedule || [])]);
  const r = res.rows[0];
  return { id: Number(r.id), companyId: Number(r.company_id), employeeId: Number(r.employee_id), amount: r.amount, repaidAmount: r.repaid_amount, repaymentSchedule: r.repayment_schedule, status: r.status, createdAt: r.created_at };
}

export async function listDeductionRules(tx: Transaction, companyId: number): Promise<DeductionRule[]> {
  const res = await tx.query<any>(`SELECT * FROM payroll_deduction_rules WHERE company_id = $1 ORDER BY name`, [companyId]);
  return res.rows.map((r: any) => ({ id: Number(r.id), companyId: Number(r.company_id), deductionType: r.deduction_type, name: r.name, calculationMethod: r.calculation_method, formula: r.formula, applicableTo: r.applicable_to, isTaxDeductible: r.is_tax_deductible, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, createdAt: r.created_at }));
}

export async function createDeductionRule(tx: Transaction, companyId: number, input: any): Promise<DeductionRule> {
  const res = await tx.query<any>(`INSERT INTO payroll_deduction_rules (company_id, deduction_type, name, calculation_method, formula, applicable_to, is_tax_deductible, effective_from, effective_to) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [companyId, input.deductionType, input.name, input.calculationMethod, input.formula || null, input.applicableTo || 'all', input.isTaxDeductible || false, input.effectiveFrom || null, input.effectiveTo || null]);
  const r = res.rows[0];
  return { id: Number(r.id), companyId: Number(r.company_id), deductionType: r.deduction_type, name: r.name, calculationMethod: r.calculation_method, formula: r.formula, applicableTo: r.applicable_to, isTaxDeductible: r.is_tax_deductible, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, createdAt: r.created_at };
}

export async function listAllowances(tx: Transaction, companyId: number, employeeId?: number): Promise<EmployeeAllowance[]> {
  const params: any[] = [companyId];
  let where = 'WHERE company_id = $1';
  if (employeeId) { params.push(employeeId); where += ` AND employee_id = $${params.length}`; }
  const res = await tx.query<any>(`SELECT * FROM employee_allowances ${where} ORDER BY created_at DESC`, params);
  return res.rows.map((r: any) => ({ id: Number(r.id), companyId: Number(r.company_id), employeeId: Number(r.employee_id), allowanceType: r.allowance_type, amount: r.amount, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, createdAt: r.created_at }));
}

export async function createAllowance(tx: Transaction, companyId: number, input: any): Promise<EmployeeAllowance> {
  const res = await tx.query<any>(`INSERT INTO employee_allowances (company_id, employee_id, allowance_type, amount, effective_from, effective_to) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [companyId, input.employeeId, input.allowanceType, input.amount, input.effectiveFrom || null, input.effectiveTo || null]);
  const r = res.rows[0];
  return { id: Number(r.id), companyId: Number(r.company_id), employeeId: Number(r.employee_id), allowanceType: r.allowance_type, amount: r.amount, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, createdAt: r.created_at };
}

// ─── Bank file (WS-4 R6) ───────────────────────────────────────────────

export interface PayrollBankFile {
  format: 'csv' | 'txt';
  filename: string;
  content: string;
}

function csvEscape(value: unknown): string {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Generate a bank payment file for a payroll run.
 *
 * `format=csv` (default) emits a generic, spreadsheet-friendly CSV;
 * `format=txt` emits a pipe-delimited file. The column set is stable so a
 * bank-specific mapping can be layered on without changing the service.
 */
export async function getPayrollBankFile(
  tx: Transaction,
  companyId: number,
  runId: number,
  format: 'csv' | 'txt' = 'csv'
): Promise<PayrollBankFile> {
  const runRes = await tx.query<{ run_number: string }>(
    `SELECT run_number FROM pay_runs WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, runId]
  );
  if (runRes.rows.length === 0) {
    throw new AccountingError(404, 'Payroll run not found', 'PAYROLL_RUN_NOT_FOUND');
  }
  const compRes = await tx.query<{ currency_symbol: string | null }>(
    `SELECT currency_symbol FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  );
  const currency = compRes.rows[0]?.currency_symbol || '';

  const res = await tx.query<{
    first_name: string;
    last_name: string;
    bank_name: string | null;
    bank_account_name: string | null;
    bank_account_number: string | null;
    net_pay: string;
  }>(
    `SELECT e.first_name, e.last_name, e.bank_name, e.bank_account_name,
            e.bank_account_number, ps.net_pay::text AS net_pay
       FROM pay_stubs ps
       JOIN employees e ON e.company_id = ps.company_id AND e.id = ps.employee_id
      WHERE ps.company_id = $1 AND ps.pay_run_id = $2
      ORDER BY e.last_name, e.first_name`,
    [companyId, runId]
  );

  const runNumber = runRes.rows[0].run_number;
  if (format === 'txt') {
    const lines = res.rows.map(r => {
      const name = `${r.first_name} ${r.last_name}`.trim();
      return [
        name,
        r.bank_name || '',
        r.bank_account_name || name,
        r.bank_account_number || '',
        Number(r.net_pay).toFixed(2),
        currency,
      ].join('|');
    });
    return {
      format: 'txt',
      filename: `${runNumber}-bank.txt`,
      content: lines.join('\n'),
    };
  }

  const header = 'employee_name,bank_name,account_name,account_number,net_pay,currency';
  const lines = res.rows.map(r => {
    const name = `${r.first_name} ${r.last_name}`.trim();
    return [
      name,
      r.bank_name || '',
      r.bank_account_name || name,
      r.bank_account_number || '',
      Number(r.net_pay).toFixed(2),
      currency,
    ]
      .map(csvEscape)
      .join(',');
  });
  return {
    format: 'csv',
    filename: `${runNumber}-bank.csv`,
    content: [header, ...lines].join('\n'),
  };
}

// ─── Effective-dated salary structures (WS-4 R2) ───────────────────────

export interface SalaryStructure {
  id: number;
  companyId: number;
  employeeId: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  payType: string;
  payRate: string;
  payFrequency: string;
  currency: string | null;
  notes: string | null;
}

function mapSalaryStructure(r: any): SalaryStructure {
  return {
    id: Number(r.id),
    companyId: Number(r.company_id),
    employeeId: Number(r.employee_id),
    effectiveFrom: String(r.effective_from).slice(0, 10),
    effectiveTo: r.effective_to ? String(r.effective_to).slice(0, 10) : null,
    payType: r.pay_type,
    payRate: r.pay_rate,
    payFrequency: r.pay_frequency,
    currency: r.currency ?? null,
    notes: r.notes ?? null,
  };
}

export async function listSalaryStructures(
  tx: Transaction,
  companyId: number,
  employeeId?: number
): Promise<SalaryStructure[]> {
  const res = await tx.query<any>(
    `SELECT * FROM salary_structures
      WHERE company_id = $1 AND ($2::BIGINT IS NULL OR employee_id = $2)
      ORDER BY employee_id, effective_from DESC`,
    [companyId, employeeId ?? null]
  );
  return res.rows.map(mapSalaryStructure);
}

export async function createSalaryStructure(
  tx: Transaction,
  companyId: number,
  input: {
    employeeId: number;
    effectiveFrom: string;
    effectiveTo?: string | null;
    payType: string;
    payRate: number;
    payFrequency: string;
    currency?: string | null;
    notes?: string | null;
  }
): Promise<SalaryStructure> {
  if (!['salary', 'hourly'].includes(input.payType)) {
    throw new AccountingError(400, 'payType must be salary or hourly', 'INVALID_PAY_TYPE');
  }
  if (!(Number(input.payRate) >= 0)) {
    throw new AccountingError(400, 'payRate must be zero or greater', 'INVALID_PAY_RATE');
  }
  const res = await tx.query<any>(
    `INSERT INTO salary_structures
       (company_id, employee_id, effective_from, effective_to, pay_type, pay_rate, pay_frequency, currency, notes)
     VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      companyId,
      input.employeeId,
      input.effectiveFrom,
      input.effectiveTo || null,
      input.payType,
      input.payRate,
      input.payFrequency,
      input.currency || null,
      input.notes || null,
    ]
  );
  return mapSalaryStructure(res.rows[0]);
}

export async function deleteSalaryStructure(
  tx: Transaction,
  companyId: number,
  id: number
): Promise<boolean> {
  const res = await tx.query(
    `DELETE FROM salary_structures WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  return (res as any).rowCount > 0;
}

export async function getEffectiveSalaryStructure(
  tx: Transaction,
  companyId: number,
  employeeId: number,
  payDate: string
): Promise<{ payType: string; payRate: number; payFrequency: string } | null> {
  const res = await tx.query<any>(
    `SELECT pay_type, pay_rate::text AS pay_rate, pay_frequency
       FROM salary_structures
      WHERE company_id = $1 AND employee_id = $2
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [companyId, employeeId, payDate]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    payType: r.pay_type,
    payRate: Number(r.pay_rate),
    payFrequency: r.pay_frequency,
  };
}
