import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as deliveryService from '../services/deliveryService.ts';

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
  const msg = (err as any)?.message || 'Delivery service error';
  console.error('[Delivery Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createDeliveryRoutes(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requireReadOrWrite } = createAuthMiddleware(db);
  router.use('/delivery', requireAuth, csrfProtection);
  router.use('/delivery', requireReadOrWrite('delivery:read', 'delivery:write'));

  router.get('/delivery/vehicles', async (req: Request, res: Response) => {
    try { const auth = req.auth!; return res.json({ vehicles: await db.withCompanyDb(auth.companyId, (tx: Transaction) => deliveryService.listVehicles(tx, auth.companyId)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.post('/delivery/vehicles', async (req: Request, res: Response) => {
    try { const auth = req.auth!; if (!req.body?.registration) return res.status(400).json({ error: 'registration is required' });
      return res.status(201).json({ vehicle: await db.withCompanyDb(auth.companyId, (tx: Transaction) => deliveryService.createVehicle(tx, auth.companyId, req.body)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.get('/delivery/drivers', async (req: Request, res: Response) => {
    try { const auth = req.auth!; return res.json({ drivers: await db.withCompanyDb(auth.companyId, (tx: Transaction) => deliveryService.listDrivers(tx, auth.companyId)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.post('/delivery/drivers', async (req: Request, res: Response) => {
    try { const auth = req.auth!; if (!req.body?.name || !req.body?.licenseNumber) return res.status(400).json({ error: 'name and licenseNumber are required' });
      return res.status(201).json({ driver: await db.withCompanyDb(auth.companyId, (tx: Transaction) => deliveryService.createDriver(tx, auth.companyId, req.body)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.get('/delivery/schedules', async (req: Request, res: Response) => {
    try { const auth = req.auth!; return res.json({ schedules: await db.withCompanyDb(auth.companyId, (tx: Transaction) => deliveryService.listSchedules(tx, auth.companyId)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.post('/delivery/schedules', async (req: Request, res: Response) => {
    try { const auth = req.auth!; if (!req.body?.deliveryNoteId || !req.body?.scheduledDate) return res.status(400).json({ error: 'deliveryNoteId and scheduledDate are required' });
      return res.status(201).json({ schedule: await db.withCompanyDb(auth.companyId, (tx: Transaction) => deliveryService.createSchedule(tx, auth.companyId, req.body)) }); }
    catch (err) { return handleError(res, err); }
  });

  return router;
}