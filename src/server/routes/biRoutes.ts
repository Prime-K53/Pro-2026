import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as biService from '../services/biService.ts';

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
  const msg = (err as any)?.message || 'BI service error';
  console.error('[BI Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createBiRoutes(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requireReadOrWrite } = createAuthMiddleware(db);
  router.use('/bi', requireAuth, csrfProtection);
  router.use('/bi', requireReadOrWrite('bi:read', 'bi:read'));

  router.get('/bi/sales-trends', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const period = String(req.query.period || 'monthly');
      const groupBy = req.query.groupBy ? String(req.query.groupBy) : null;
      if (groupBy && ['product', 'category', 'customer'].includes(groupBy)) {
        const trends = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
          biService.getSalesTrendsGrouped(tx, auth.companyId, groupBy as any, period)
        );
        return res.json({ trends });
      }
      const trends = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getSalesTrends(tx, auth.companyId, period)
      );
      return res.json({ trends });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/kpi-scorecard', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const kpis = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getKpiScorecard(tx, auth.companyId)
      );
      return res.json({ kpis });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/inventory-turnover', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const items = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getInventoryTurnover(tx, auth.companyId)
      );
      return res.json({ items });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/pos-cashier-performance', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const cashiers = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getPosCashierPerformance(tx, auth.companyId)
      );
      return res.json({ cashiers });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/reconciliation', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const reconciliation = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getBiReconciliation(tx, auth.companyId)
      );
      return res.json(reconciliation);
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/ar-ageing', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const buckets = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getArAgeing(tx, auth.companyId)
      );
      return res.json({ buckets });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/kpi-targets', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const targets = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.listKpiTargets(tx, auth.companyId)
      );
      return res.json({ targets });
    } catch (err) { return handleError(res, err); }
  });

  router.put('/bi/kpi-targets', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      if (!req.body?.kpiKey || req.body?.targetValue === undefined) {
        return res.status(400).json({ error: 'kpiKey and targetValue are required' });
      }
      const target = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.upsertKpiTarget(tx, auth.companyId, req.body || {})
      );
      return res.status(201).json({ target });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/drilldown/revenue', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const limit = Number(req.query.limit || 50);
      const rows = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getRevenueDrilldown(tx, auth.companyId, limit)
      );
      return res.json({ rows });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/sales-split', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const split = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getSalesSplit(tx, auth.companyId)
      );
      return res.json(split);
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/stock-valuation', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const items = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getStockValuation(tx, auth.companyId)
      );
      return res.json({ items });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/printing-job-efficiency', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const jobs = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getPrintingJobEfficiency(tx, auth.companyId)
      );
      return res.json({ jobs });
    } catch (err) { return handleError(res, err); }
  });

  router.get('/bi/payroll-cost-analysis', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const summary = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        biService.getPayrollCostAnalysis(tx, auth.companyId)
      );
      return res.json(summary);
    } catch (err) { return handleError(res, err); }
  });

  return router;
}