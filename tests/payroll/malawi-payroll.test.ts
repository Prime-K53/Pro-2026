/**
 * WS-4 Malawi statutory payroll tests.
 *
 * Verifies that:
 *  - PAYE is computed from configurable, effective-dated bands (no hardcoding)
 *  - pension employee/employer rates come from configuration
 *  - net pay = gross - PAYE - pension employee
 *  - the payroll journal balances
 *  - a missing configuration fails loudly instead of silently under-taxing
 */
import assert from 'node:assert/strict';
import { startTestServer, loginAdmin } from '../helpers/testServer.ts';

async function main() {
  const srv = await startTestServer();
  try {
    const admin = await loginAdmin(srv.baseUrl);
    const c = admin.client;

    // Seeded defaults exist.
    const cfg0 = await c.request('GET', '/api/payroll/statutory-config');
    assert.equal(cfg0.status, 200);
    assert.ok(cfg0.json.bands.length > 0, 'seeded PAYE bands must exist');

    // Configure simple bands effective 2020 (so they apply to a 2023 pay date,
    // while the seeded 2024 defaults do not).
    const band1 = await c.request('POST', '/api/payroll/paye-bands', {
      body: { lowerBound: 0, upperBound: 1000, rate: 0, effectiveFrom: '2020-01-01' },
    });
    assert.equal(band1.status, 201, band1.text);
    const band2 = await c.request('POST', '/api/payroll/paye-bands', {
      body: { lowerBound: 1000, upperBound: null, rate: 0.2, effectiveFrom: '2020-01-01' },
    });
    assert.equal(band2.status, 201, band2.text);
    assert.equal(
      (await c.request('POST', '/api/payroll/statutory-rates', {
        body: { rateType: 'pension_employee', rate: 0.05, effectiveFrom: '2020-01-01' },
      })).status,
      201
    );
    assert.equal(
      (await c.request('POST', '/api/payroll/statutory-rates', {
        body: { rateType: 'pension_employer', rate: 0.1, effectiveFrom: '2020-01-01' },
      })).status,
      201
    );

    // Pick the seeded employee and a bank account.
    const empRes = await c.request('GET', '/api/employees');
    assert.equal(empRes.status, 200);
    const employees = empRes.json.employees || empRes.json.rows || empRes.json;
    const employee = employees[0];
    assert.ok(employee?.id, 'expected at least one employee');

    const accRes = await c.request('GET', '/api/accounts');
    assert.equal(accRes.status, 200);
    const accounts = accRes.json.accounts || accRes.json.rows || accRes.json;
    const bank = accounts.find((a: any) => a.accountType === 'Bank' || a.account_type === 'Bank');
    assert.ok(bank?.id, 'expected a bank account');

    // A pay date with no configuration must fail loudly.
    const unconfigured = await c.request('POST', '/api/payroll/runs', {
      body: {
        payPeriodStart: '2019-01-01',
        payPeriodEnd: '2019-01-31',
        payDate: '2019-01-31',
        bankAccountId: bank.id,
        items: [{ employeeId: employee.id, hoursRegular: 0, hoursOvertime: 0 }],
      },
    });
    assert.equal(unconfigured.status, 400, 'missing PAYE config must be rejected');
    assert.equal(unconfigured.json.code, 'PAYE_NOT_CONFIGURED');

    // Run payroll for 2023-06 with the custom bands.
    const run = await c.request('POST', '/api/payroll/runs', {
      body: {
        payPeriodStart: '2023-06-01',
        payPeriodEnd: '2023-06-30',
        payDate: '2023-06-30',
        bankAccountId: bank.id,
        items: [{ employeeId: employee.id, hoursRegular: 0, hoursOvertime: 0 }],
      },
    });
    assert.equal(run.status, 201, `payroll run failed: ${run.text}`);

    const result = run.json.run;
    const item = result.items[0];
    // Gross = 12500 / 12 = 1041.67
    const gross = 1041.67;
    const expectedPaye = Math.round((gross - 1000) * 0.2 * 100) / 100; // 8.33
    const expectedPensionEmployee = Math.round(gross * 0.05 * 100) / 100; // 52.08
    const expectedNet = Math.round((gross - expectedPaye - expectedPensionEmployee) * 100) / 100;

    assert.equal(item.grossPay, gross, 'gross pay');
    assert.equal(item.paye, expectedPaye, 'PAYE from configured bands');
    assert.equal(item.pensionEmployee, expectedPensionEmployee, 'employee pension');
    assert.equal(item.pensionEmployer, Math.round(gross * 0.1 * 100) / 100, 'employer pension');
    assert.equal(item.netPay, expectedNet, 'net pay');

    // The payroll journal must balance.
    const j = await c.request('GET', `/api/journals/${result.journalTransactionId}`);
    assert.equal(j.status, 200);
    let debit = 0;
    let credit = 0;
    for (const line of j.json.entry.lines) {
      debit += Number(line.debit);
      credit += Number(line.credit);
    }
    assert.ok(Math.abs(debit - credit) < 0.01, `journal unbalanced: ${debit} != ${credit}`);

    // Payslip + reconciliation.
    const payslips = await c.request('GET', `/api/payroll/runs/${result.runId}/payslips`);
    assert.equal(payslips.status, 200);
    assert.equal(payslips.json.payslips.length, 1);
    assert.equal(payslips.json.payslips[0].paye, expectedPaye);

    const recon = await c.request('GET', `/api/payroll/runs/${result.runId}/reconciliation`);
    assert.equal(recon.status, 200);
    assert.equal(recon.json.balanced, true, JSON.stringify(recon.json.checks));

    // Period locking: the same pay period cannot be run twice.
    const duplicate = await c.request('POST', '/api/payroll/runs', {
      body: {
        payPeriodStart: '2023-06-01',
        payPeriodEnd: '2023-06-30',
        payDate: '2023-06-30',
        bankAccountId: bank.id,
        items: [{ employeeId: employee.id, hoursRegular: 0, hoursOvertime: 0 }],
      },
    });
    assert.equal(duplicate.status, 409, 'duplicate period must be rejected');
    assert.equal(duplicate.json.code, 'PAYROLL_PERIOD_ALREADY_RUN');

    // Advance repayment is applied in a later pay period.
    const advRes = await c.request('POST', '/api/payroll/advances', {
      body: { employeeId: employee.id, amount: 1000, repaymentSchedule: [{ amount: 200 }] },
    });
    assert.equal(advRes.status, 201, advRes.text);

    const run2 = await c.request('POST', '/api/payroll/runs', {
      body: {
        payPeriodStart: '2023-07-01',
        payPeriodEnd: '2023-07-31',
        payDate: '2023-07-31',
        bankAccountId: bank.id,
        items: [{ employeeId: employee.id, hoursRegular: 0, hoursOvertime: 0 }],
      },
    });
    assert.equal(run2.status, 201, run2.text);
    const item2 = run2.json.run.items[0];
    assert.equal(item2.otherDeductions, 200, 'advance installment must be deducted');
    assert.equal(
      item2.netPay,
      Math.round((gross - expectedPaye - expectedPensionEmployee - 200) * 100) / 100,
      'net pay must reflect the advance repayment'
    );

    const advances = await c.request('GET', '/api/payroll/advances');
    const saved = advances.json.advances.find((a: any) => a.id === advRes.json.advance.id);
    assert.ok(saved, 'advance must be listed');
    assert.equal(Number(saved.repaidAmount), 200, 'repaid amount must be persisted');

    // Bank file generation.
    const bankFile = await c.request('GET', `/api/payroll/runs/${result.runId}/bank-file?format=csv`);
    assert.equal(bankFile.status, 200, bankFile.text);
    assert.match(
      bankFile.text,
      /employee_name,bank_name,account_name,account_number,net_pay,currency/,
      'bank file must have a stable header'
    );
    const txtFile = await c.request('GET', `/api/payroll/runs/${result.runId}/bank-file?format=txt`);
    assert.equal(txtFile.status, 200);
    assert.ok(txtFile.text.includes('|'), 'txt bank file must be pipe-delimited');

    // Effective-dated salary structure drives gross pay.
    const struct = await c.request('POST', '/api/payroll/salary-structures', {
      body: {
        employeeId: employee.id,
        effectiveFrom: '2023-09-01',
        payType: 'salary',
        payRate: 240000,
        payFrequency: 'monthly',
      },
    });
    assert.equal(struct.status, 201, struct.text);
    const run3 = await c.request('POST', '/api/payroll/runs', {
      body: {
        payPeriodStart: '2023-09-01',
        payPeriodEnd: '2023-09-30',
        payDate: '2023-09-30',
        bankAccountId: bank.id,
        items: [{ employeeId: employee.id, hoursRegular: 0, hoursOvertime: 0 }],
      },
    });
    assert.equal(run3.status, 201, run3.text);
    assert.equal(run3.json.run.items[0].grossPay, 20000, 'salary structure must drive gross pay');

    console.log('✅ Malawi statutory payroll tests passed');
  } finally {
    await srv.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});