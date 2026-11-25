import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as leaveService from '../services/leaveService.ts';

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
  const msg = (err as any)?.message || 'Leave service error';
  console.error('[Leave Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createLeaveRoutes(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requireReadOrWrite, requirePermission } = createAuthMiddleware(db);
  router.use('/leave', requireAuth, csrfProtection);

  router.get('/leave/types', requireReadOrWrite('payroll:read', 'payroll:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      return res.json({
        leaveTypes: await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          leaveService.listLeaveTypes(tx, auth.companyId)
        ),
      });
    } catch (err) { return handleError(res, err); }
  });

  router.post('/leave/types', requirePermission('payroll:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      if (!req.body?.code || !req.body?.name) {
        return res.status(400).json({ error: 'code and name are required' });
      }
      return res.status(201).json({
        leaveType: await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          leaveService.createLeaveType(tx, auth.companyId, req.body)
        ),
      });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/leave/balances/:employeeId', requireReadOrWrite('payroll:read', 'payroll:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const employeeId = Number(req.params.employeeId);
      if (!employeeId) return res.status(400).json({ error: 'Invalid employeeId' });
      const year = req.query.year ? Number(req.query.year) : undefined;
      return res.json({
        balances: await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          leaveService.getEmployeeLeaveBalances(tx, auth.companyId, employeeId, year)
        ),
      });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/leave/requests', requireReadOrWrite('payroll:read', 'payroll:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const filters = {
        employeeId: req.query.employeeId ? Number(req.query.employeeId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
      };
      return res.json({
        requests: await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          leaveService.listLeaveRequests(tx, auth.companyId, filters)
        ),
      });
    } catch (err) { return handleError(res, err); }
  });

  router.post('/leave/requests', requireReadOrWrite('payroll:read', 'payroll:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { employeeId, leaveTypeId, startDate, endDate, daysRequested, reason } = req.body || {};
      if (!employeeId || !leaveTypeId || !startDate || !endDate || !daysRequested) {
        return res.status(400).json({ error: 'employeeId, leaveTypeId, startDate, endDate, and daysRequested are required' });
      }
      return res.status(201).json({
        request: await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          leaveService.createLeaveRequest(tx, auth.companyId, {
            employeeId: Number(employeeId),
            leaveTypeId: Number(leaveTypeId),
            startDate,
            endDate,
            daysRequested: Number(daysRequested),
            reason,
          })
        ),
      });
    } catch (err) { return handleError(res, err); }
  });

  router.post('/leave/requests/:id/approve', requirePermission('payroll:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      return res.json({
        request: await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          leaveService.approveLeaveRequest(tx, auth.companyId, id, auth.userId)
        ),
      });
    } catch (err) { return handleError(res, err); }
  });

  router.post('/leave/requests/:id/reject', requirePermission('payroll:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      const reason = req.body?.rejectionReason || 'Rejected';
      return res.json({
        request: await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          leaveService.rejectLeaveRequest(tx, auth.companyId, id, reason)
        ),
      });
    } catch (err) { return handleError(res, err); }
  });

  router.post('/leave/requests/:id/cancel', requireReadOrWrite('payroll:read', 'payroll:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      return res.json({
        request: await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          leaveService.cancelLeaveRequest(tx, auth.companyId, id)
        ),
      });
    } catch (err) { return handleError(res, err); }
  });

  return router;
}
