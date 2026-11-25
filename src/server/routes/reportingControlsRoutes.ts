import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { createReportExportSnapshot, listReportExportSnapshots } from '../services/reportingControlsService.ts';
function toActor(req: Request): ActorContext { const a=req.auth!; return { userId:a.userId, username:a.username, role:a.role }; }
function handle(res: Response, err: unknown){ if(err instanceof AccountingError) return res.status(err.statusCode).json({error:err.message,code:err.code}); return res.status(500).json({error:(err as any)?.message||'Reporting controls failed'}); }
export function createReportingControlsRouter(db: ServerDatabase): Router {
  const router = Router(); const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);
  router.get('/reports/export-snapshots', requirePermission('reports:controls:read'), async (req,res)=>{ try { return res.json({ snapshots: await db.withCompanyDb(req.auth!.companyId, tx=>listReportExportSnapshots(tx, req.auth!.companyId, req.query.reportKey ? String(req.query.reportKey) : undefined)) }); } catch(err){ return handle(res,err);} });
  router.post('/reports/export-snapshots', requirePermission('reports:controls:write'), async (req,res)=>{ try { return res.status(201).json({ snapshot: await db.withCompanyDb(req.auth!.companyId, tx=>createReportExportSnapshot(tx, req.auth!.companyId, toActor(req), req.body||{})) }); } catch(err){ return handle(res,err);} });
  return router;
}
