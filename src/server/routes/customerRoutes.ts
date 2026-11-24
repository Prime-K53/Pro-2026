import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as customerService from '../services/customerService.ts';

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const msg = (err as any)?.message || 'Customer service error';
  console.error('[Customer Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createCustomerRoutes(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requireReadOrWrite } = createAuthMiddleware(db);

  router.use('/customers', requireAuth, csrfProtection);
  router.use('/customers', requireReadOrWrite('customers:read', 'customers:write'));

  // ─── Contacts ───────────────────────────────────────────────────────

  router.get('/customers/:id/contacts', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const customerId = Number(req.params.id);
      const contacts = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        customerService.listContacts(tx, auth.companyId, customerId)
      );
      return res.json({ contacts });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/customers/:id/contacts', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const customerId = Number(req.params.id);
      const contact = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        customerService.createContact(tx, auth.companyId, customerId, req.body || {})
      );
      return res.status(201).json({ contact });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.patch('/customers/:id/contacts/:contactId', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const contactId = Number(req.params.contactId);
      const contact = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        customerService.updateContact(tx, auth.companyId, contactId, req.body || {})
      );
      return res.json({ contact });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.delete('/customers/:id/contacts/:contactId', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const contactId = Number(req.params.contactId);
      await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        customerService.deleteContact(tx, auth.companyId, contactId)
      );
      return res.json({ deleted: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // ─── Branches ────────────────────────────────────────────────────────

  router.get('/customers/:id/branches', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const customerId = Number(req.params.id);
      const includeInactive = String(req.query.includeInactive || '') === 'true';
      const branches = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        customerService.listBranches(tx, auth.companyId, customerId, includeInactive)
      );
      return res.json({ branches });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/customers/:id/branches', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const customerId = Number(req.params.id);
      const branch = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        customerService.createBranch(tx, auth.companyId, customerId, req.body || {})
      );
      return res.status(201).json({ branch });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.patch('/customers/:id/branches/:branchId', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const branchId = Number(req.params.branchId);
      const branch = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        customerService.updateBranch(tx, auth.companyId, branchId, req.body || {})
      );
      return res.json({ branch });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.delete('/customers/:id/branches/:branchId', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const branchId = Number(req.params.branchId);
      // Soft deactivate — the row is kept so historical documents still resolve.
      const branch = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        customerService.deactivateBranch(tx, auth.companyId, branchId)
      );
      return res.json({ deactivated: true, branch });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/customers/:id/branches/:branchId/reactivate', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const branchId = Number(req.params.branchId);
      const branch = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        customerService.reactivateBranch(tx, auth.companyId, branchId)
      );
      return res.json({ branch });
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}