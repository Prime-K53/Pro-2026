import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import {
  ApprovalStatus,
  approveApprovalRequest,
  cancelApprovalRequest,
  getApprovalRequest,
  listApprovalPolicies,
  listApprovalRequests,
  rejectApprovalRequest,
  updateApprovalPolicy,
} from '../services/approvalService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  const msg = (err as any)?.message || 'Approval operation failed';
  if (pgCode === '23505' || pgCode === '23514') {
    return res.status(409).json({ error: msg, code: pgCode });
  }
  console.error('[Approval Route Error]', err);
  return res.status(500).json({ error: msg });
}

const VALID_STATUSES: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'cancelled'];

export function createApprovalRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

  router.get('/approvals/policies', requirePermission('approvals:read'), async (req: Request, res: Response) => {
    try {
      const policies = await db.withCompanyDb(req.auth!.companyId, tx =>
        listApprovalPolicies(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, policies });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.put('/approvals/policies', requirePermission('approvals:configure'), async (req: Request, res: Response) => {
    try {
      const policy = await db.withCompanyDb(req.auth!.companyId, tx =>
        updateApprovalPolicy(tx, req.auth!.companyId, toActor(req), {
          actionType: req.body?.actionType,
          thresholdAmount: req.body?.thresholdAmount ?? req.body?.threshold,
          isEnabled: req.body?.isEnabled,
          requireNote: req.body?.requireNote,
        })
      );
      return res.json({ policy });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/approvals', requirePermission('approvals:read'), async (req: Request, res: Response) => {
    try {
      const rawStatus = req.query.status ? String(req.query.status) : 'pending';
      const status = VALID_STATUSES.includes(rawStatus as ApprovalStatus)
        ? (rawStatus as ApprovalStatus)
        : 'pending';
      const requests = await db.withCompanyDb(req.auth!.companyId, tx =>
        listApprovalRequests(tx, req.auth!.companyId, status === 'pending' ? 'pending' : status)
      );
      return res.json({ companyId: req.auth!.companyId, status, requests });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/approvals/:id', requirePermission('approvals:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid approval request id' });
      }
      const request = await db.withCompanyDb(req.auth!.companyId, tx =>
        getApprovalRequest(tx, req.auth!.companyId, id)
      );
      return res.json({ request });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/approvals/:id/approve', requirePermission('approvals:decide'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid approval request id' });
      }
      const request = await db.withCompanyDb(req.auth!.companyId, tx =>
        approveApprovalRequest(tx, req.auth!.companyId, toActor(req), id, req.body?.note)
      );
      return res.json({ request });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/approvals/:id/reject', requirePermission('approvals:decide'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid approval request id' });
      }
      const request = await db.withCompanyDb(req.auth!.companyId, tx =>
        rejectApprovalRequest(tx, req.auth!.companyId, toActor(req), id, String(req.body?.note || ''))
      );
      return res.json({ request });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/approvals/:id/cancel', requirePermission('approvals:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid approval request id' });
      }
      const request = await db.withCompanyDb(req.auth!.companyId, tx =>
        cancelApprovalRequest(tx, req.auth!.companyId, toActor(req), id)
      );
      return res.json({ request });
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}