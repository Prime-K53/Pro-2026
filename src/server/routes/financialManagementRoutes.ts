import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import {
  createSavedReport,
  deleteSavedReport,
  getBudgetMatrix,
  getBudgetVsActualReport,
  getFinancialAnalyticsDashboard,
  getTaxSummaryReport,
  listExchangeRates,
  listSavedReports,
  listTaxMappings,
  runSavedReport,
  upsertBudgetEntries,
  upsertExchangeRate,
  upsertTaxMapping,
} from '../services/financialManagementService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleFinancialMgmtError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  const msg = (err as any)?.message || 'Financial management operation failed';
  if (pgCode === '23505' || pgCode === '23514' || pgCode === '23001') {
    return res.status(409).json({ error: msg, code: pgCode });
  }
  console.error('[Financial Management Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createFinancialManagementRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

  // Budgets & Budget vs Actual
  router.get('/budgets', requirePermission('budgets:read'), async (req: Request, res: Response) => {
    try {
      const fiscalYear = Number(req.query.fiscalYear || new Date().getFullYear());
      const budget = await db.withCompanyDb(req.auth!.companyId, tx =>
        getBudgetMatrix(tx, req.auth!.companyId, fiscalYear)
      );
      return res.json({ companyId: req.auth!.companyId, ...budget });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  router.put('/budgets', requirePermission('budgets:write'), async (req: Request, res: Response) => {
    try {
      const fiscalYear = Number(req.body?.fiscalYear || new Date().getFullYear());
      const budget = await db.withCompanyDb(req.auth!.companyId, tx =>
        upsertBudgetEntries(tx, req.auth!.companyId, toActor(req), fiscalYear, req.body?.entries || [])
      );
      return res.json({ companyId: req.auth!.companyId, ...budget });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  router.get('/reports/budget-vs-actual', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const fiscalYear = Number(req.query.fiscalYear || new Date().getFullYear());
      const startMonth = req.query.startMonth ? Number(req.query.startMonth) : 1;
      const endMonth = req.query.endMonth ? Number(req.query.endMonth) : 12;
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getBudgetVsActualReport(tx, req.auth!.companyId, fiscalYear, startMonth, endMonth)
      );
      return res.json({ report });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  // Tax Mappings & Live Sales/Use Tax Reporting
  router.get('/tax/mappings', requirePermission('tax:read'), async (req: Request, res: Response) => {
    try {
      const mappings = await db.withCompanyDb(req.auth!.companyId, tx =>
        listTaxMappings(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, mappings });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  router.put('/tax/mappings', requirePermission('tax:write'), async (req: Request, res: Response) => {
    try {
      const mapping = await db.withCompanyDb(req.auth!.companyId, tx =>
        upsertTaxMapping(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.json({ mapping });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  router.get('/tax/summary', requirePermission('tax:read'), async (req: Request, res: Response) => {
    try {
      const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
      const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
      const summary = await db.withCompanyDb(req.auth!.companyId, tx =>
        getTaxSummaryReport(tx, req.auth!.companyId, startDate, endDate)
      );
      return res.json({ summary });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  // Foreign Exchange Rates
  router.get('/fx/rates', requirePermission('accounts:read'), async (req: Request, res: Response) => {
    try {
      const rates = await db.withCompanyDb(req.auth!.companyId, tx =>
        listExchangeRates(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, rates });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  router.put('/fx/rates', requirePermission('accounts:write'), async (req: Request, res: Response) => {
    try {
      const rate = await db.withCompanyDb(req.auth!.companyId, tx =>
        upsertExchangeRate(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ rate });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  // Saved Reports
  router.get('/saved-reports', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const savedReports = await db.withCompanyDb(req.auth!.companyId, tx =>
        listSavedReports(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, savedReports });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  router.post('/saved-reports', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const savedReport = await db.withCompanyDb(req.auth!.companyId, tx =>
        createSavedReport(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ savedReport });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  router.delete('/saved-reports/:id', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid saved report id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        deleteSavedReport(tx, req.auth!.companyId, id)
      );
      return res.json(result);
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  router.post('/saved-reports/:id/run', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid saved report id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        runSavedReport(tx, req.auth!.companyId, id)
      );
      return res.json(result);
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  // Financial Analytics Dashboard Overview
  router.get('/analytics/overview', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const overview = await db.withCompanyDb(req.auth!.companyId, tx =>
        getFinancialAnalyticsDashboard(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, overview });
    } catch (err) {
      return handleFinancialMgmtError(res, err);
    }
  });

  return router;
}
