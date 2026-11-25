import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { listTaxAccountMappings, listTaxFilingPeriods, markTaxFilingPeriodFiled, upsertTaxAccountMapping, upsertTaxFilingPeriod } from '../services/taxComplianceControlsService.ts';
function toActor(req: Request): ActorContext { const a=req.auth!; return { userId:a.userId, username:a.username, role:a.role }; }
function handle(res: Response, err: unknown){ if(err instanceof AccountingError) return res.status(err.statusCode).json({error:err.message,code:err.code}); return res.status(500).json({error:(err as any)?.message||'Tax controls failed'}); }
export function createTaxComplianceControlsRouter(db: ServerDatabase): Router {
  const router = Router(); const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);
  router.get('/tax/filing-periods', requirePermission('tax:controls:read'), async (req,res)=>{ try { return res.json({ periods: await db.withCompanyDb(req.auth!.companyId, tx=>listTaxFilingPeriods(tx, req.auth!.companyId)) }); } catch(err){ return handle(res,err);} });
  router.post('/tax/filing-periods', requirePermission('tax:controls:write'), async (req,res)=>{ try { return res.status(201).json({ period: await db.withCompanyDb(req.auth!.companyId, tx=>upsertTaxFilingPeriod(tx, req.auth!.companyId, toActor(req), req.body||{})) }); } catch(err){ return handle(res,err);} });
  router.post('/tax/filing-periods/:id/file', requirePermission('tax:controls:write'), async (req,res)=>{ try { return res.json({ period: await db.withCompanyDb(req.auth!.companyId, tx=>markTaxFilingPeriodFiled(tx, req.auth!.companyId, toActor(req), Number(req.params.id), req.body?.reference || null)) }); } catch(err){ return handle(res,err);} });
  router.get('/tax/account-mappings', requirePermission('tax:controls:read'), async (req,res)=>{ try { return res.json({ mappings: await db.withCompanyDb(req.auth!.companyId, tx=>listTaxAccountMappings(tx, req.auth!.companyId)) }); } catch(err){ return handle(res,err);} });
  router.post('/tax/account-mappings', requirePermission('tax:controls:write'), async (req,res)=>{ try { return res.status(201).json({ mapping: await db.withCompanyDb(req.auth!.companyId, tx=>upsertTaxAccountMapping(tx, req.auth!.companyId, toActor(req), req.body||{})) }); } catch(err){ return handle(res,err);} });
  return router;
}
