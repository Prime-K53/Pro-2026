import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { assignMachineToJob, listMachineDowntime, logMachineDowntime, moveJobStage } from '../services/productionOpsService.ts';

function toActor(req: Request): ActorContext { const a = req.auth!; return { userId: a.userId, username: a.username, role: a.role }; }
function handleErr(res: Response, err: unknown) {
  if (err instanceof AccountingError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
  console.error('[ProductionOps Route Error]', err);
  return res.status(500).json({ error: (err as any)?.message || 'Production ops failed' });
}

export function createProductionOpsRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

  router.post('/production/jobs/:id/assign-machine', requirePermission('production:ops:write'), async (req, res) => {
    try {
      const jobId = Number(req.params.id);
      const result = await db.withCompanyDb(req.auth!.companyId, tx => assignMachineToJob(tx, req.auth!.companyId, toActor(req), { jobId, machineId: Number(req.body?.machineId), notes: req.body?.notes || null }));
      return res.status(201).json({ assignment: result });
    } catch (err) { return handleErr(res, err); }
  });

  router.post('/production/jobs/:id/move-stage', requirePermission('production:ops:write'), async (req, res) => {
    try {
      const jobId = Number(req.params.id);
      const result = await db.withCompanyDb(req.auth!.companyId, tx => moveJobStage(tx, req.auth!.companyId, toActor(req), { jobId, toStatus: String(req.body?.toStatus || ''), reason: req.body?.reason || null }));
      return res.json({ job: result });
    } catch (err) { return handleErr(res, err); }
  });

  router.post('/production/machines/:id/downtime', requirePermission('production:ops:write'), async (req, res) => {
    try {
      const machineId = Number(req.params.id);
      const result = await db.withCompanyDb(req.auth!.companyId, tx => logMachineDowntime(tx, req.auth!.companyId, toActor(req), { machineId, ...req.body }));
      return res.status(201).json({ downtime: result });
    } catch (err) { return handleErr(res, err); }
  });

  router.get('/production/machines/:id/downtime', requirePermission('production:ops:read'), async (req, res) => {
    try {
      const machineId = Number(req.params.id);
      const events = await db.withCompanyDb(req.auth!.companyId, tx => listMachineDowntime(tx, req.auth!.companyId, machineId));
      return res.json({ events });
    } catch (err) { return handleErr(res, err); }
  });

  return router;
}
