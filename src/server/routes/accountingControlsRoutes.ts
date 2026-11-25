import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { listAccountingControlEvents, logAccountingControlEvent, setJournalApprovalStatus } from '../services/accountingControlsService.ts';
function toActor(req: Request): ActorContext { const a=req.auth!; return { userId:a.userId, username:a.username, role:a.role }; }
function handle(res: Response, err: unknown){ if(err instanceof AccountingError) return res.status(err.statusCode).json({error:err.message,code:err.code}); return res.status(500).json({error:(err as any)?.message||'Accounting controls failed'}); }
export function createAccountingControlsRouter(db: ServerDatabase): Router {
  const router = Router(); const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);
  router.get('/accounting/control-events', requirePermission('accounting:controls:read'), async (req,res)=>{ try { return res.json({ events: await db.withCompanyDb(req.auth!.companyId, tx=>listAccountingControlEvents(tx, req.auth!.companyId, Number(req.query.limit||100))) }); } catch(err){ return handle(res,err);} });
  router.post('/accounting/control-events', requirePermission('accounting:controls:write'), async (req,res)=>{ try { return res.status(201).json({ event: await db.withCompanyDb(req.auth!.companyId, tx=>logAccountingControlEvent(tx, req.auth!.companyId, toActor(req), req.body||{})) }); } catch(err){ return handle(res,err);} });
  router.post('/accounting/journals/:id/approval', requirePermission('accounting:controls:write'), async (req,res)=>{ try { return res.json({ journal: await db.withCompanyDb(req.auth!.companyId, tx=>setJournalApprovalStatus(tx, req.auth!.companyId, toActor(req), Number(req.params.id), String(req.body?.status||'approved') as any, req.body?.reason || null)) }); } catch(err){ return handle(res,err);} });
  return router;
}
