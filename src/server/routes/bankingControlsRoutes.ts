import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { exportBankReconciliationRules, getBankGlDrilldown, importBankReconciliationRules, listBankReconciliationRules, upsertBankReconciliationRule } from '../services/bankingControlsService.ts';
function toActor(req: Request): ActorContext { const a=req.auth!; return { userId:a.userId, username:a.username, role:a.role }; }
function handle(res: Response, err: unknown){ if(err instanceof AccountingError) return res.status(err.statusCode).json({error:err.message,code:err.code}); return res.status(500).json({error:(err as any)?.message||'Banking controls failed'}); }
export function createBankingControlsRouter(db: ServerDatabase): Router {
  const router = Router(); const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);
  router.get('/banking/recon-rules', requirePermission('banking:rules:read'), async (req,res)=>{ try { return res.json({ rules: await db.withCompanyDb(req.auth!.companyId, tx=>listBankReconciliationRules(tx, req.auth!.companyId)) }); } catch(err){ return handle(res,err);} });
  router.post('/banking/recon-rules', requirePermission('banking:rules:manage'), async (req,res)=>{ try { return res.status(201).json({ rule: await db.withCompanyDb(req.auth!.companyId, tx=>upsertBankReconciliationRule(tx, req.auth!.companyId, toActor(req), req.body||{})) }); } catch(err){ return handle(res,err);} });
  router.get('/banking/recon-rules/export', requirePermission('banking:rules:read'), async (req,res)=>{ try { return res.json(await db.withCompanyDb(req.auth!.companyId, tx=>exportBankReconciliationRules(tx, req.auth!.companyId))); } catch(err){ return handle(res,err);} });
  router.post('/banking/recon-rules/import', requirePermission('banking:rules:manage'), async (req,res)=>{ try { return res.json(await db.withCompanyDb(req.auth!.companyId, tx=>importBankReconciliationRules(tx, req.auth!.companyId, toActor(req), Array.isArray(req.body?.rules)?req.body.rules:[]))); } catch(err){ return handle(res,err);} });
  router.get('/banking/accounts/:id/gl-drilldown', requirePermission('banking:rules:read'), async (req,res)=>{ try { const id=Number(req.params.id); return res.json({ rows: await db.withCompanyDb(req.auth!.companyId, tx=>getBankGlDrilldown(tx, req.auth!.companyId, id, Number(req.query.limit||100))) }); } catch(err){ return handle(res,err);} });
  return router;
}
