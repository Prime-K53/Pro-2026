import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as commsService from '../services/communicationsService.ts';
import { validateTwilioSignature, twilioRequestUrl } from '../services/twilioSignature.ts';
import { logger } from '../logger.ts';

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
  const msg = (err as any)?.message || 'Communications service error';
  console.error('[Communications Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createCommunicationsRoutes(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, requireReadOrWrite } = createAuthMiddleware(db);

  // Twilio webhook (public)
  router.post('/communications/webhooks/twilio', async (req: Request, res: Response) => {
    const ok = validateTwilioSignature({
      url: twilioRequestUrl(req),
      form: (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>,
      signature: (req.get('x-twilio-signature') as string) || null,
      authToken: db.config.twilioAuthToken,
      isProduction: db.config.isProduction,
    });
    if (!ok) {
      return res.status(403).json({ error: 'Invalid Twilio signature' });
    }

    const sid = (req.body?.MessageSid as string) || null;
    const status = commsService.normalizeProviderStatus(req.body?.MessageStatus);
    if (sid && status) {
      try {
        await db.withSystemDb((tx: Transaction) =>
          commsService.recordReceiptByProviderMessageId(
            tx,
            sid,
            status,
            (req.body?.ErrorMessage as string) || null
          )
        );
      } catch (err) {
        logger.error('twilio_receipt_failed', { error: (err as any)?.message || String(err) });
      }
    }
    return res.status(200).json({ received: true });
  });

  router.use('/communications', requireAuth, csrfProtection);
  router.use('/communications', requireReadOrWrite('communications:read', 'communications:write'));

  router.get('/communications/consents', async (req: Request, res: Response) => {
    try { const auth = req.auth!; return res.json({ consents: await db.withCompanyDb(auth.companyId, (tx: Transaction) => commsService.listConsents(tx, auth.companyId)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.post('/communications/consents', async (req: Request, res: Response) => {
    try { const auth = req.auth!; if (!req.body?.customerId || !req.body?.channel || !req.body?.consentType) return res.status(400).json({ error: 'customerId, channel, and consentType are required' });
      return res.status(201).json({ consent: await db.withCompanyDb(auth.companyId, (tx: Transaction) => commsService.createConsent(tx, auth.companyId, req.body)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.get('/communications/suppressions', async (req: Request, res: Response) => {
    try { const auth = req.auth!; return res.json({ suppressions: await db.withCompanyDb(auth.companyId, (tx: Transaction) => commsService.listSuppressions(tx, auth.companyId)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.post('/communications/suppressions', async (req: Request, res: Response) => {
    try { const auth = req.auth!; if (!req.body?.channel || !req.body?.recipient) return res.status(400).json({ error: 'channel and recipient are required' });
      return res.status(201).json({ suppression: await db.withCompanyDb(auth.companyId, (tx: Transaction) => commsService.createSuppression(tx, auth.companyId, req.body)) }); }
    catch (err) { return handleError(res, err); }
  });

  router.post('/communications/send', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { channel, recipient, body, provider, providerMessageId } = req.body || {};
      if (!channel || !recipient || !body) {
        return res.status(400).json({ error: 'channel, recipient and body are required' });
      }
      const message = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        commsService.queueMessage(tx, auth.companyId, {
          channel,
          recipient,
          body,
          provider,
          providerMessageId,
        })
      );
      return res.status(201).json({ message });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/communications/messages', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const messages = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        commsService.listMessages(tx, auth.companyId, Number(req.query.limit || 100))
      );
      return res.json({ messages });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/communications/templates', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const templates = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        commsService.listTemplates(tx, auth.companyId)
      );
      return res.json({ templates });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/communications/templates', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { name, channel, body } = req.body || {};
      if (!name || !channel || !body) {
        return res.status(400).json({ error: 'name, channel and body are required' });
      }
      const template = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        commsService.createTemplate(tx, auth.companyId, { name, channel, body })
      );
      return res.status(201).json({ template });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/communications/costs', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const summary = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        commsService.getCommunicationsCostSummary(tx, auth.companyId)
      );
      return res.json(summary);
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}