import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import {
  createAndDispatchCampaign,
  createAutomationRule,
  createMarketingTemplate,
  createPromotion,
  createReferralCampaign,
  createReferralCode,
  createReferralProgram,
  getPriceCardWorkspace,
  getSmartOpsOverview,
  listMarketingWorkspace,
  listPromotions,
  listReferralWorkspace,
  payoutReferralReward,
  recordManualReferralConversion,
  recordReferralClick,
  resolveSmartOpsAccounts,
  runAutomationRuleNow,
  savePriceCardPreset,
  sendDirectCustomerMessage,
  toggleAutomationRule,
  toggleReferralProgram,
  updateMarketingMessageStatus,
  updatePromotion,
} from '../services/smartOpsService.ts';
import {
  checkoutPosOrder,
  getPosCatalogAndOrders,
  previewPosOrder,
  voidPosOrder,
} from '../services/posService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  const msg = (err as any)?.message || 'Smart Operations error';
  if (pgCode === '23505') {
    return res.status(409).json({ error: 'A record with that code already exists', code: pgCode });
  }
  if (pgCode === '23514' || pgCode === '23001') {
    return res.status(409).json({ error: msg, code: pgCode });
  }
  console.error('[SmartOps Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createSmartOpsRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  router.use(requireAuth, rejectCrossCompanyParams);

  // =========================================================================
  // SMART OPERATIONS OVERVIEW & STARTER INITIALIZATION
  // =========================================================================
  router.get('/smart-ops/overview', requirePermission('smart_ops:read'), async (req: Request, res: Response) => {
    try {
      const overview = await db.withCompanyDb(req.auth!.companyId, tx =>
        getSmartOpsOverview(tx, req.auth!.companyId)
      );
      return res.json(overview);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/initialize-accounts', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const accts = await resolveSmartOpsAccounts(tx, req.auth!.companyId, toActor(req));
        const companyId = req.auth!.companyId;

        const existingTpls = await tx.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM marketing_templates WHERE company_id = $1`,
          [companyId]
        );
        if (Number(existingTpls.rows[0].cnt) === 0) {
          const t1 = await createMarketingTemplate(tx, companyId, toActor(req), {
            name: 'POS Instant WhatsApp Receipt',
            category: 'receipt',
            channel: 'whatsapp',
            body: 'Thank you {{customerName}} for choosing {{companyName}}! Receipt {{receiptNumber}} (Total: {{total}}) is confirmed. Reply anytime for reprints or bulk stationery.',
          });
          const t2 = await createMarketingTemplate(tx, companyId, toActor(req), {
            name: 'Overdue Invoice Friendly Reminder',
            category: 'reminder',
            channel: 'whatsapp',
            body: 'Hello {{customerName}}, a friendly reminder from {{companyName}} regarding your open balance of {{balanceDue}}. Let us know if you need an updated statement.',
          });
          const t3 = await createMarketingTemplate(tx, companyId, toActor(req), {
            name: 'Term Print & Stationery Promo Drop',
            category: 'promotion',
            channel: 'whatsapp',
            body: 'Hi {{customerName}}! Enjoy special print & stationery pricing at {{companyName}}. Present code {{promoCode}} at our POS counter or reply to order.',
          });
          const t4 = await createMarketingTemplate(tx, companyId, toActor(req), {
            name: 'Advocate Referral Invitation',
            category: 'referral',
            channel: 'whatsapp',
            body: 'Hi {{customerName}}, share {{companyName}} with partner schools & businesses using code {{referralCode}} and earn rewards on every paid order!',
          });

          await createAutomationRule(tx, companyId, toActor(req), {
            name: 'Auto-Send WhatsApp Receipt on POS Checkout',
            triggerEvent: 'post_pos_receipt',
            templateId: t1.id,
            delayHours: 0,
            targetSegment: 'all',
          });
          await createAutomationRule(tx, companyId, toActor(req), {
            name: 'Weekly Overdue Balance WhatsApp Follow-Up',
            triggerEvent: 'invoice_overdue',
            templateId: t2.id,
            delayHours: 24,
            targetSegment: 'overdue',
          });
          await createAutomationRule(tx, companyId, toActor(req), {
            name: 'School Term Bulk Print Promo Broadcast',
            triggerEvent: 'promo_drop',
            templateId: t3.id,
            delayHours: 0,
            targetSegment: 'schools',
          });
          await createAutomationRule(tx, companyId, toActor(req), {
            name: 'VIP Advocate Referral Nudge',
            triggerEvent: 'referral_invite',
            templateId: t4.id,
            delayHours: 48,
            targetSegment: 'top_spenders',
          });
        }

        const existingProgs = await tx.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM referral_programs WHERE company_id = $1`,
          [companyId]
        );
        if (Number(existingProgs.rows[0].cnt) === 0) {
          const prog = await createReferralProgram(tx, companyId, toActor(req), {
            name: 'School & Corporate Print Partner Program',
            description: 'Referrer earns 5% commission reward; referred customer receives 5% off first POS order.',
            referrerRewardType: 'percent_commission',
            referrerRewardValue: 5,
            refereeDiscountType: 'percent',
            refereeDiscountValue: 5,
            minQualifyingSpend: 100,
          });
          await createReferralCampaign(tx, companyId, toActor(req), {
            programId: prog.id,
            name: 'WhatsApp Term Partner Drive',
            channel: 'whatsapp',
            trackingCode: 'TERM26-WA',
            targetReferrals: 30,
            budgetAmount: 500,
          });
        }

        const existingPromos = await tx.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM promotions WHERE company_id = $1`,
          [companyId]
        );
        if (Number(existingPromos.rows[0].cnt) === 0) {
          await createPromotion(tx, companyId, toActor(req), {
            code: 'PRINT10',
            name: '10% Bulk Print & Stationery Offer',
            description: '10% off orders above K 150 (max discount K 500)',
            discountType: 'percent',
            discountValue: 10,
            minOrderAmount: 150,
            maxDiscountAmount: 500,
            showOnPriceCard: true,
          });
        }

        return { initialized: true, accounts: accts };
      });
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // =========================================================================
  // PROMOTIONS
  // =========================================================================
  router.get('/smart-ops/promotions', requirePermission('smart_ops:read'), async (req: Request, res: Response) => {
    try {
      const data = await db.withCompanyDb(req.auth!.companyId, tx =>
        listPromotions(tx, req.auth!.companyId)
      );
      return res.json(data);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/promotions', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const promotion = await db.withCompanyDb(req.auth!.companyId, tx =>
        createPromotion(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ promotion });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.patch('/smart-ops/promotions/:id', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid promotion id' });
      const promotion = await db.withCompanyDb(req.auth!.companyId, tx =>
        updatePromotion(tx, req.auth!.companyId, toActor(req), id, req.body || {})
      );
      return res.json({ promotion });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // =========================================================================
  // REFERRALS (PROGRAMS, CAMPAIGNS, CODES, CONVERSIONS, PAYOUTS & ANALYTICS)
  // =========================================================================
  router.get('/smart-ops/referrals', requirePermission('smart_ops:read'), async (req: Request, res: Response) => {
    try {
      const data = await db.withCompanyDb(req.auth!.companyId, tx =>
        listReferralWorkspace(tx, req.auth!.companyId)
      );
      return res.json(data);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/programs', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const program = await db.withCompanyDb(req.auth!.companyId, tx =>
        createReferralProgram(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ program });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.patch('/smart-ops/referrals/programs/:id', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await db.withCompanyDb(req.auth!.companyId, tx =>
        toggleReferralProgram(tx, req.auth!.companyId, toActor(req), id, Boolean(req.body?.isActive))
      );
      return res.json({ ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/campaigns', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const campaign = await db.withCompanyDb(req.auth!.companyId, tx =>
        createReferralCampaign(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ campaign });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/codes', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const code = await db.withCompanyDb(req.auth!.companyId, tx =>
        createReferralCode(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ code });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/codes/:id/click', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await db.withCompanyDb(req.auth!.companyId, tx => recordReferralClick(tx, req.auth!.companyId, id));
      return res.json({ ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/events', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const event = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordManualReferralConversion(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ event });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/events/:id/payout', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const event = await db.withCompanyDb(req.auth!.companyId, tx =>
        payoutReferralReward(tx, req.auth!.companyId, toActor(req), id, req.body || {})
      );
      return res.json({ event });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // =========================================================================
  // MARKETING MESSAGES (WHATSAPP AUTOMATION, BULK CAMPAIGNS, COMMS LOG)
  // =========================================================================
  router.get('/smart-ops/marketing', requirePermission('smart_ops:read'), async (req: Request, res: Response) => {
    try {
      const data = await db.withCompanyDb(req.auth!.companyId, tx =>
        listMarketingWorkspace(tx, req.auth!.companyId)
      );
      return res.json(data);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/marketing/templates', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const template = await db.withCompanyDb(req.auth!.companyId, tx =>
        createMarketingTemplate(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ template });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/marketing/rules', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const rule = await db.withCompanyDb(req.auth!.companyId, tx =>
        createAutomationRule(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ rule });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.patch('/smart-ops/marketing/rules/:id', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await db.withCompanyDb(req.auth!.companyId, tx =>
        toggleAutomationRule(tx, req.auth!.companyId, id, Boolean(req.body?.isEnabled))
      );
      return res.json({ ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/marketing/rules/:id/run', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        runAutomationRuleNow(tx, req.auth!.companyId, toActor(req), id)
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/marketing/campaigns', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const campaign = await db.withCompanyDb(req.auth!.companyId, tx =>
        createAndDispatchCampaign(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ campaign });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/marketing/messages', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const message = await db.withCompanyDb(req.auth!.companyId, tx =>
        sendDirectCustomerMessage(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ message });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.patch('/smart-ops/marketing/messages/:id', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const status = req.body?.status;
      if (!['queued', 'sent', 'delivered', 'clicked', 'failed'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      await db.withCompanyDb(req.auth!.companyId, tx =>
        updateMarketingMessageStatus(tx, req.auth!.companyId, id, status)
      );
      return res.json({ ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // =========================================================================
  // PRICE CARDS (LIVE POS PRICING + PRESETS)
  // =========================================================================
  router.get('/smart-ops/price-cards', requirePermission('smart_ops:read'), async (req: Request, res: Response) => {
    try {
      const data = await db.withCompanyDb(req.auth!.companyId, tx =>
        getPriceCardWorkspace(tx, req.auth!.companyId)
      );
      return res.json(data);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/price-cards/presets', requirePermission('smart_ops:write'), async (req: Request, res: Response) => {
    try {
      const preset = await db.withCompanyDb(req.auth!.companyId, tx =>
        savePriceCardPreset(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ preset });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // =========================================================================
  // FULL POS TERMINAL
  // =========================================================================
  router.get('/pos/catalog', requirePermission('pos:read'), async (req: Request, res: Response) => {
    try {
      const data = await db.withCompanyDb(req.auth!.companyId, tx =>
        getPosCatalogAndOrders(tx, req.auth!.companyId)
      );
      return res.json(data);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/pos/preview', requirePermission('pos:read'), async (req: Request, res: Response) => {
    try {
      const preview = await db.withCompanyDb(req.auth!.companyId, tx =>
        previewPosOrder(tx, req.auth!.companyId, req.body || {})
      );
      return res.json(preview);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/pos/checkout', requirePermission('pos:write'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        checkoutPosOrder(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/pos/orders/:id/void', requirePermission('pos:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid POS order id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        voidPosOrder(tx, req.auth!.companyId, toActor(req), id, req.body?.reason)
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}
