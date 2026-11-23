import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import * as malawiPayroll from '../services/malawiPayroll.ts';
import {
  listPayslips,
  getPayslip,
  reconcilePayrollRun,
  getPayrollBankFile,
  listSalaryStructures,
  createSalaryStructure,
  deleteSalaryStructure,
} from '../services/payrollService.ts';
import { Transaction } from '@electric-sql/pglite';

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const msg = (err as any)?.message || 'Payroll service error';
  console.error('[Payroll Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createPayrollRoutes(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requireReadOrWrite } = createAuthMiddleware(db);

  router.use('/payroll', requireAuth, csrfProtection);
  router.use('/payroll', requireReadOrWrite('payroll:read', 'payroll:write'));

  // Salary Advances CRUD
  router.get('/payroll/advances', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;
      const advances = await db.withCompanyDb(auth.companyId, (tx: Transaction) => {
        const params: any[] = [auth.companyId];
        let where = 'WHERE company_id = $1';
        if (employeeId) {
          params.push(employeeId);
          where += ` AND employee_id = $${params.length}`;
        }
        return tx.query<any>(`SELECT * FROM salary_advances ${where} ORDER BY created_at DESC`, params)
          .then((r: any) => r.rows.map((row: any) => ({
            id: Number(row.id),
            companyId: Number(row.company_id),
            employeeId: Number(row.employee_id),
            amount: row.amount,
            repaidAmount: row.repaid_amount,
            repaymentSchedule: row.repayment_schedule,
            status: row.status,
            createdAt: row.created_at,
          })));
      });
      return res.json({ advances });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/payroll/advances', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { employeeId, amount, repaymentSchedule } = req.body || {};
      if (!employeeId || !amount) {
        return res.status(400).json({ error: 'employeeId and amount are required' });
      }
      const advance = await db.withCompanyDb(auth.companyId, (tx: Transaction) => {
        return tx.query<any>(
          `INSERT INTO salary_advances (company_id, employee_id, amount, repayment_schedule)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [auth.companyId, employeeId, amount, JSON.stringify(repaymentSchedule || [])]
        ).then((r: any) => {
          const row = r.rows[0];
          return {
            id: Number(row.id),
            companyId: Number(row.company_id),
            employeeId: Number(row.employee_id),
            amount: row.amount,
            repaidAmount: row.repaid_amount,
            repaymentSchedule: row.repayment_schedule,
            status: row.status,
            createdAt: row.created_at,
          };
        });
      });
      return res.status(201).json({ advance });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // Deduction Rules CRUD
  router.get('/payroll/deduction-rules', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const rules = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        tx.query<any>(`SELECT * FROM payroll_deduction_rules WHERE company_id = $1 ORDER BY name`, [auth.companyId])
          .then((r: any) => r.rows.map((row: any) => ({
            id: Number(row.id),
            companyId: Number(row.company_id),
            deductionType: row.deduction_type,
            name: row.name,
            calculationMethod: row.calculation_method,
            formula: row.formula,
            applicableTo: row.applicable_to,
            isTaxDeductible: row.is_tax_deductible,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
            createdAt: row.created_at,
          })))
      );
      return res.json({ rules });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/payroll/deduction-rules', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { deductionType, name, calculationMethod, formula, applicableTo, isTaxDeductible, effectiveFrom, effectiveTo } = req.body || {};
      if (!deductionType || !name || !calculationMethod) {
        return res.status(400).json({ error: 'deductionType, name, and calculationMethod are required' });
      }
      const rule = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        tx.query<any>(
          `INSERT INTO payroll_deduction_rules (company_id, deduction_type, name, calculation_method, formula, applicable_to, is_tax_deductible, effective_from, effective_to)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [auth.companyId, deductionType, name, calculationMethod, formula || null, applicableTo || 'all', isTaxDeductible || false, effectiveFrom || new Date().toISOString().split('T')[0], effectiveTo || null]
        ).then((r: any) => {
          const row = r.rows[0];
          return {
            id: Number(row.id),
            companyId: Number(row.company_id),
            deductionType: row.deduction_type,
            name: row.name,
            calculationMethod: row.calculation_method,
            formula: row.formula,
            applicableTo: row.applicable_to,
            isTaxDeductible: row.is_tax_deductible,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
            createdAt: row.created_at,
          };
        })
      );
      return res.status(201).json({ rule });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // Employee Allowances CRUD
  router.get('/payroll/allowances', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;
      const allowances = await db.withCompanyDb(auth.companyId, (tx: Transaction) => {
        const params: any[] = [auth.companyId];
        let where = 'WHERE company_id = $1';
        if (employeeId) {
          params.push(employeeId);
          where += ` AND employee_id = $${params.length}`;
        }
        return tx.query<any>(`SELECT * FROM employee_allowances ${where} ORDER BY created_at DESC`, params)
          .then((r: any) => r.rows.map((row: any) => ({
            id: Number(row.id),
            companyId: Number(row.company_id),
            employeeId: Number(row.employee_id),
            allowanceType: row.allowance_type,
            amount: row.amount,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
            createdAt: row.created_at,
          })));
      });
      return res.json({ allowances });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/payroll/allowances', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { employeeId, allowanceType, amount, effectiveFrom, effectiveTo } = req.body || {};
      if (!employeeId || !allowanceType || amount === undefined) {
        return res.status(400).json({ error: 'employeeId, allowanceType, and amount are required' });
      }
      const allowance = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        tx.query<any>(
          `INSERT INTO employee_allowances (company_id, employee_id, allowance_type, amount, effective_from, effective_to)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [auth.companyId, employeeId, allowanceType, amount, effectiveFrom || new Date().toISOString().split('T')[0], effectiveTo || null]
        ).then((r: any) => {
          const row = r.rows[0];
          return {
            id: Number(row.id),
            companyId: Number(row.company_id),
            employeeId: Number(row.employee_id),
            allowanceType: row.allowance_type,
            amount: row.amount,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
            createdAt: row.created_at,
          };
        })
      );
      return res.status(201).json({ allowance });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // Bank file generation (CSV)
  router.get('/payroll/bank-file', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const payRunId = req.query.payRunId ? Number(req.query.payRunId) : null;
      if (!payRunId) {
        return res.status(400).json({ error: 'payRunId is required' });
      }

      const csv = await db.withCompanyDb(auth.companyId, (tx: Transaction) => {
        return tx.query<any>(
          `SELECT e.employee_number, e.first_name, e.last_name, eba.account_number, eba.bank_name, pr.net_pay::text
           FROM pay_runs pr
           JOIN employees e ON e.company_id = pr.company_id AND e.id = pr.employee_id
           LEFT JOIN employee_bank_accounts eba ON eba.company_id = e.company_id AND eba.employee_id = e.id
           WHERE pr.company_id = $1 AND pr.id = $2`,
          [auth.companyId, payRunId]
        ).then((r: any) => {
          const lines = ['EmployeeNumber,FirstName,LastName,AccountNumber,BankName,NetPay'];
          for (const row of r.rows) {
            lines.push(`${row.employee_number},${row.first_name},${row.last_name},${row.account_number || ''},${row.bank_name || ''},${row.net_pay}`);
          }
          return lines.join('\n');
        });
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="payroll-bank-file.csv"');
      return res.send(csv);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // ─── Malawi statutory configuration ──────────────────────────────────────
  router.get('/payroll/statutory-config', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const config = await db.withCompanyDb(auth.companyId, async (tx: Transaction) => ({
        bands: await malawiPayroll.listPayeBands(tx, auth.companyId),
        rates: await malawiPayroll.listStatutoryRates(tx, auth.companyId),
      }));
      return res.json(config);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/payroll/paye-bands', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const band = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        malawiPayroll.createPayeBand(tx, auth.companyId, req.body || {})
      );
      return res.status(201).json({ band });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.delete('/payroll/paye-bands/:id', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const deleted = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        malawiPayroll.deletePayeBand(tx, auth.companyId, Number(req.params.id))
      );
      return res.json({ deleted });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/payroll/statutory-rates', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const rate = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        malawiPayroll.createStatutoryRate(tx, auth.companyId, req.body || {})
      );
      return res.status(201).json({ rate });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.delete('/payroll/statutory-rates/:id', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const deleted = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        malawiPayroll.deleteStatutoryRate(tx, auth.companyId, Number(req.params.id))
      );
      return res.json({ deleted });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // ─── Payslips & reconciliation ───────────────────────────────────────────
  router.get('/payroll/runs/:id/payslips', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const runId = Number(req.params.id);
      if (!Number.isInteger(runId) || runId <= 0) {
        return res.status(400).json({ error: 'Invalid run id' });
      }
      const payslips = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        listPayslips(tx, auth.companyId, runId)
      );
      return res.json({ payslips });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/payroll/runs/:id/payslips/:employeeId', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const runId = Number(req.params.id);
      const employeeId = Number(req.params.employeeId);
      if (!Number.isInteger(runId) || !Number.isInteger(employeeId)) {
        return res.status(400).json({ error: 'Invalid run or employee id' });
      }
      const payslip = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        getPayslip(tx, auth.companyId, runId, employeeId)
      );
      if (!payslip) return res.status(404).json({ error: 'Payslip not found' });
      return res.json({ payslip });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get(
    '/payroll/runs/:id/payslips/:employeeId/print',
    async (req: Request, res: Response) => {
      try {
        const auth = req.auth!;
        const runId = Number(req.params.id);
        const employeeId = Number(req.params.employeeId);
        const { payslip, company } = await db.withCompanyDb(auth.companyId, async (tx: Transaction) => {
          const payslip = await getPayslip(tx, auth.companyId, runId, employeeId);
          const c = await tx.query<{
            name: string;
            address: string | null;
            city_state_zip: string | null;
            phone: string | null;
            email: string | null;
          }>(
            `SELECT name, address, city_state_zip, phone, email FROM companies WHERE id = $1 LIMIT 1`,
            [auth.companyId]
          );
          return { payslip, company: c.rows[0] || null };
        });
        if (!payslip) return res.status(404).json({ error: 'Payslip not found' });
        const esc = (v: unknown) =>
          String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
        const money = (n: number) => n.toFixed(2);
        const rows: Array<[string, number]> = [
          ['Gross Pay', payslip.grossPay],
          ['PAYE', payslip.paye],
          ['Pension (Employee)', payslip.pensionEmployee],
          ['Other Deductions', payslip.otherDeductions],
          ['Net Pay', payslip.netPay],
        ];
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${esc(payslip.runNumber)}</title>
<style>body{font-family:Arial,sans-serif;margin:40px;color:#111}h1{font-size:20px}table{border-collapse:collapse;margin-top:16px}td{padding:6px 12px;border-bottom:1px solid #ddd}td:last-child{text-align:right;font-variant-numeric:tabular-nums}.total td{font-weight:bold;border-top:2px solid #111}@media print{button{display:none}}</style></head>
<body>
<button onclick="window.print()">Print</button>
<div style="border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:18px">
  <div style="font-size:18px;font-weight:700">${esc(company?.name || 'Company')}</div>
  <div style="color:#555;font-size:12px">${esc([company?.address, company?.city_state_zip].filter(Boolean).join(', '))}</div>
  <div style="color:#555;font-size:12px">${esc([company?.phone, company?.email].filter(Boolean).join(' · '))}</div>
</div>
<h1>Payslip — ${esc(payslip.employeeName)}</h1>
<p>${esc(payslip.runNumber)} · ${esc(payslip.payPeriodStart)} to ${esc(payslip.payPeriodEnd)} · Pay date ${esc(payslip.payDate)}</p>
<table>${rows.map(([label, value], i) => `<tr class="${i === rows.length - 1 ? 'total' : ''}"><td>${esc(label)}</td><td>${money(value)}</td></tr>`).join('')}</table>
<p>Employer pension: ${money(payslip.pensionEmployer)}</p>
</body></html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } catch (err) {
        return handleError(res, err);
      }
    }
  );

  router.get('/payroll/runs/:id/reconciliation', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const runId = Number(req.params.id);
      if (!Number.isInteger(runId) || runId <= 0) {
        return res.status(400).json({ error: 'Invalid run id' });
      }
      const reconciliation = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        reconcilePayrollRun(tx, auth.companyId, runId)
      );
      return res.json(reconciliation);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/payroll/runs/:id/bank-file', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const runId = Number(req.params.id);
      if (!Number.isInteger(runId) || runId <= 0) {
        return res.status(400).json({ error: 'Invalid run id' });
      }
      const format = String(req.query.format || 'csv') === 'txt' ? 'txt' : 'csv';
      const file = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        getPayrollBankFile(tx, auth.companyId, runId, format)
      );
      res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      return res.send(file.content);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/payroll/salary-structures', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
      const structures = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        listSalaryStructures(tx, auth.companyId, employeeId)
      );
      return res.json({ structures });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/payroll/salary-structures', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const structure = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        createSalaryStructure(tx, auth.companyId, req.body || {})
      );
      return res.status(201).json({ structure });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.delete('/payroll/salary-structures/:id', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const deleted = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        deleteSalaryStructure(tx, auth.companyId, Number(req.params.id))
      );
      return res.json({ deleted });
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}