import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { approveDocument, listDocumentVersions, setDocumentRetention, purgeExpiredRetentions } from '../services/documentControlService.ts';
function toActor(req: Request): ActorContext { const a=req.auth!; return { userId:a.userId, username:a.username, role:a.role }; }
function handle(res: Response, err: unknown){ if(err instanceof AccountingError) return res.status(err.statusCode).json({error:err.message,code:err.code}); return res.status(500).json({error:(err as any)?.message||'Document control failed'}); }
export function createDocumentControlRouter(db: ServerDatabase): Router {
  const router = Router(); const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);
  router.get('/documents/:entityType/:entityId/versions', requirePermission('documents:control:read'), async (req,res)=>{ try { return res.json({ documents: await db.withCompanyDb(req.auth!.companyId, tx=>listDocumentVersions(tx, req.auth!.companyId, String(req.params.entityType), Number(req.params.entityId))) }); } catch(err){ return handle(res,err);} });
  router.post('/documents/:id/approve', requirePermission('documents:control:write'), async (req,res)=>{ try { return res.json({ document: await db.withCompanyDb(req.auth!.companyId, tx=>approveDocument(tx, req.auth!.companyId, toActor(req), Number(req.params.id), Boolean(req.body?.approved), req.body?.reason || null)) }); } catch(err){ return handle(res,err);} });
  router.post('/documents/:id/retention', requirePermission('documents:control:write'), async (req,res)=>{ try { return res.json({ document: await db.withCompanyDb(req.auth!.companyId, tx=>setDocumentRetention(tx, req.auth!.companyId, toActor(req), Number(req.params.id), req.body?.retentionUntil || null)) }); } catch(err){ return handle(res,err);} });
  router.post('/documents/retention/purge', requirePermission('documents:control:write'), async (req,res)=>{ try { return res.json(await db.withCompanyDb(req.auth!.companyId, tx=>purgeExpiredRetentions(tx, req.auth!.companyId, toActor(req), db.config.attachmentsDir))); } catch(err){ return handle(res,err);} });
  return router;
}
