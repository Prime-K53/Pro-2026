import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import {
  notifyTenantScheduler,
  processQueuedEmailsForCompany,
} from '../scheduler.ts';
import {
  REPORT_SCHEDULE_KEYS,
  createReportSchedule,
  deleteReportSchedule,
  getReportSchedule,
  listReportSchedules,
  runDueReportSchedules,
  runReportSchedule,
  updateReportSchedule,
} from '../services/reportSchedulingService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const msg = (err as any)?.message || 'Report schedule operation failed';
  console.error('[Report Schedule Error]', err);
  return res.status(500).json({ error: msg });
}

export function createReportSchedulingRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

  router.get('/report-schedules', requirePermission('reports:read'), async (req, res) => {
    try {
      const schedules = await db.withCompanyDb(req.auth!.companyId, tx =>
        listReportSchedules(tx, req.auth!.companyId)
      );
      return res.json({
        companyId: req.auth!.companyId,
        schedules,
        availableReports: REPORT_SCHEDULE_KEYS,
      });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/report-schedules', requirePermission('reports:schedule'), async (req, res) => {
    try {
      const schedule = await db.withCompanyDb(req.auth!.companyId, tx =>
        createReportSchedule(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      notifyTenantScheduler(req.auth!.companyId);
      return res.status(201).json({ schedule });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/report-schedules/:id', requirePermission('reports:read'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid report schedule id' });
      }
      const schedule = await db.withCompanyDb(req.auth!.companyId, tx =>
        getReportSchedule(tx, req.auth!.companyId, id)
      );
      return res.json({ schedule });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.patch('/report-schedules/:id', requirePermission('reports:schedule'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid report schedule id' });
      }
      const schedule = await db.withCompanyDb(req.auth!.companyId, tx =>
        updateReportSchedule(tx, req.auth!.companyId, toActor(req), id, req.body || {})
      );
      notifyTenantScheduler(req.auth!.companyId);
      return res.json({ schedule });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.delete('/report-schedules/:id', requirePermission('reports:schedule'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid report schedule id' });
      }
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        deleteReportSchedule(tx, req.auth!.companyId, toActor(req), id)
      );
      notifyTenantScheduler(req.auth!.companyId);
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/report-schedules/:id/run', requirePermission('reports:schedule'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid report schedule id' });
      }
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        runReportSchedule(tx, req.auth!.companyId, id, toActor(req))
      );
      // Manual runs attempt delivery immediately instead of leaving the mail
      // queued until the tenant's next scheduled timer.
      const delivery = await processQueuedEmailsForCompany(db, req.auth!.companyId).catch(err => {
        console.error('[Report Schedule] immediate delivery failed', err);
        return null;
      });
      // Re-arm after delivery so failed sends are retried at their backoff time.
      notifyTenantScheduler(req.auth!.companyId);
      return res.json({
        schedule: result.schedule,
        run: result.run,
        snapshot: result.snapshot,
        delivery,
      });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/report-schedules/run-due', requirePermission('reports:schedule'), async (req, res) => {
    try {
      const results = await db.withCompanyDb(req.auth!.companyId, tx =>
        runDueReportSchedules(tx, req.auth!.companyId, toActor(req))
      );
      const delivery = await processQueuedEmailsForCompany(db, req.auth!.companyId).catch(err => {
        console.error('[Report Schedule] immediate delivery failed', err);
        return null;
      });
      // Re-arm after delivery so failed sends are retried at their backoff time.
      notifyTenantScheduler(req.auth!.companyId);
      return res.json({ companyId: req.auth!.companyId, results, delivery });
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}