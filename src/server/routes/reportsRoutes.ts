import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import {
  getCogsReconciliationReport,
  getEstimateVsActualReport,
  getInventoryValuationReport,
  getPrintingJobProfitability,
  getPrintingSpoilageReport,
  getWipAgingReport,
} from '../services/operationalReports.ts';
import { getDashboardAlerts } from '../services/reportSchedulingService.ts';

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const msg = (err as any)?.message || 'Report failed';
  console.error('[Operational Report Error]', err);
  return res.status(500).json({ error: msg });
}

function dateOptions(req: Request) {
  return {
    startDate: req.query.startDate ? String(req.query.startDate) : undefined,
    endDate: req.query.endDate ? String(req.query.endDate) : undefined,
  };
}

export function createReportsRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, rejectCrossCompanyParams);

  router.get('/reports/printing-job-profitability', requirePermission('reports:read'), async (req, res) => {
    try {
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getPrintingJobProfitability(tx, req.auth!.companyId, dateOptions(req))
      );
      return res.json({ report });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/reports/wip-aging', requirePermission('reports:read'), async (req, res) => {
    try {
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getWipAgingReport(tx, req.auth!.companyId)
      );
      return res.json({ report });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/reports/printing-spoilage', requirePermission('reports:read'), async (req, res) => {
    try {
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getPrintingSpoilageReport(tx, req.auth!.companyId, dateOptions(req))
      );
      return res.json({ report });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/reports/estimate-vs-actual', requirePermission('reports:read'), async (req, res) => {
    try {
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getEstimateVsActualReport(tx, req.auth!.companyId, dateOptions(req))
      );
      return res.json({ report });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/reports/inventory-valuation', requirePermission('reports:read'), async (req, res) => {
    try {
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getInventoryValuationReport(tx, req.auth!.companyId)
      );
      return res.json({ report });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/reports/cogs-reconciliation', requirePermission('reports:read'), async (req, res) => {
    try {
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getCogsReconciliationReport(tx, req.auth!.companyId, dateOptions(req))
      );
      return res.json({ report });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/dashboard/alerts', requirePermission('reports:read'), async (req, res) => {
    try {
      const alerts = await db.withCompanyDb(req.auth!.companyId, tx =>
        getDashboardAlerts(tx, req.auth!.companyId)
      );
      return res.json(alerts);
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}