import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as fixedAssetService from '../services/fixedAssetService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  if (pgCode === '23505') return res.status(409).json({ error: 'Duplicate record', code: 'DUPLICATE_KEY' });
  if (pgCode === '23514') return res.status(409).json({ error: 'Check constraint violated', code: 'CHECK_CONSTRAINT' });
  if (pgCode === '23503') return res.status(409).json({ error: 'Related record is required or in use', code: 'FOREIGN_KEY_CONSTRAINT' });
  if (pgCode === '23502') return res.status(400).json({ error: 'A required field is missing', code: 'MISSING_REQUIRED_FIELD' });
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  console.error(`[Fixed Asset Route Error ${requestId}]`, err);
  return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId });
}

export function createFixedAssetRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requirePermission } = createAuthMiddleware(db);
  router.use(requireAuth, csrfProtection);

  // Asset types -------------------------------------------------------------

  router.get('/fixed-asset-types', requirePermission('accounts:read'), async (req: Request, res: Response) => {
    try {
      const types = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        fixedAssetService.listFixedAssetTypes(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, types });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/fixed-asset-types', requirePermission('accounts:write'), async (req: Request, res: Response) => {
    try {
      const type = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        fixedAssetService.createFixedAssetType(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ type });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // Assets ------------------------------------------------------------------

  router.get('/fixed-assets', requirePermission('accounts:read'), async (req: Request, res: Response) => {
    try {
      const assets = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        fixedAssetService.listFixedAssets(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, assets });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/fixed-assets/roll-forward', requirePermission('accounts:read'), async (req: Request, res: Response) => {
    try {
      const summary = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        fixedAssetService.getAssetRollForward(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, summary });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/fixed-assets/:id', requirePermission('accounts:read'), async (req: Request, res: Response) => {
    try {
      const asset = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        fixedAssetService.getFixedAsset(tx, req.auth!.companyId, Number(req.params.id))
      );
      return res.json({ asset });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/fixed-assets', requirePermission('accounts:write'), async (req: Request, res: Response) => {
    try {
      const asset = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        fixedAssetService.createFixedAsset(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ asset });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // Depreciation run --------------------------------------------------------

  router.post('/fixed-assets/depreciation/run', requirePermission('accounts:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        fixedAssetService.runDepreciation(tx, req.auth!.companyId, toActor(req), {
          periodDate: req.body?.periodDate ?? null,
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // Disposal ----------------------------------------------------------------

  router.post('/fixed-assets/:id/dispose', requirePermission('accounts:write'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, (tx: Transaction) =>
        fixedAssetService.disposeFixedAsset(tx, req.auth!.companyId, toActor(req), Number(req.params.id), req.body || {})
      );
      return res.status(201).json({ disposal: result });
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}