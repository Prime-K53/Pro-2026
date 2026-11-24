import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { parseDecimal4 } from '../lib/decimal.ts';
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
  createPosRefund,
  getPosCatalogAndOrders,
  getPosShiftTransactions,
  getCurrentUserShift,
  listPosRefunds,
  listPosShifts,
  listSuspendedSales,
  lookupBarcode,
  openPosShift,
  previewPosOrder,
  closePosShift,
  recordPosCashMovement,
  listPosCashMovements,
  resumePosOrder,
  suspendPosOrder,
  voidPosOrder,
} from '../services/posService.ts';
import { hasPermission } from '../permissions.ts';
import {
  activateCampaign,
  configureCampaign,
  recordFinanceApproval,
  recordManagementApproval,
  serializeTerms,
  setCampaignLifecycle,
} from '../services/referralConfigService.ts';
import { qualifyReferralEvent } from '../services/referralQualificationService.ts';
import { creditReferralRewardToWallet } from '../services/referralRewardService.ts';
import { reverseReferralReward } from '../services/referralReversalService.ts';
import {
  flagReferralHold,
  recordFraudDecision,
  recordIndependentDisputeReview,
} from '../services/referralFraudService.ts';
import { reconcileBudget } from '../services/referralBudgetService.ts';

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

  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

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
            description: 'Referrer earns commission reward; referred customer receives a first-order discount.',
            referrerRewardType: 'percent_commission',
            referrerRewardValue: 3,
            refereeDiscountType: 'percent',
            refereeDiscountValue: 5,
            minQualifyingSpend: 100,
          });
          // Demo campaign with EXPLICIT campaign-level terms (D-01-B). These are
          // illustrative demo values, not engine defaults; production campaigns
          // must be configured and approved by Finance/Management.
          const start = new Date().toISOString().slice(0, 10);
          const end = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const campaign = await createReferralCampaign(tx, companyId, toActor(req), {
            programId: prog.id,
            name: 'WhatsApp Term Partner Drive',
            channel: 'whatsapp',
            trackingCode: 'TERM26-WA',
            targetReferrals: 30,
            budgetAmount: 500,
            referrerRewardType: 'percent_commission',
            referrerRewardValue: 3,
            refereeDiscountType: 'percent',
            refereeDiscountValue: 5,
            maxReferrerRewardPerOrder: 100,
            maxRefereeDiscountPerOrder: 100,
            rewardApprovalThreshold: 250,
            attributionWindowDays: 90,
            eligibleItemTypes: ['stationery', 'printing_service', 'printed_product'],
            startsAt: start,
            endsAt: end,
          });
          await recordFinanceApproval(tx, companyId, toActor(req), campaign.id, 'Demo seed — illustrative');
          await recordManagementApproval(tx, companyId, toActor(req), campaign.id, 'Demo seed — illustrative');
          await activateCampaign(tx, companyId, toActor(req), campaign.id);
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
  // REFERRAL CONFIGURATION, QUALIFICATION, REWARD & GOVERNANCE
  // =========================================================================

  router.get('/smart-ops/referrals/attributions', requirePermission('referral:read'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        tx.query(
          `SELECT ra.*, c.company_name AS customer_name, rc.company_name AS referrer_name
             FROM referral_attributions ra
             LEFT JOIN customers c ON c.company_id = ra.company_id AND c.id = ra.customer_id
             LEFT JOIN customers rc ON rc.company_id = ra.company_id AND rc.id = ra.referrer_customer_id
            WHERE ra.company_id = $1
            ORDER BY ra.id DESC`,
          [req.auth!.companyId]
        )
      );
      return res.json({ attributions: result.rows });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/smart-ops/referrals/cases', requirePermission('referral:read'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        tx.query(`SELECT * FROM referral_cases WHERE company_id = $1 ORDER BY id DESC`, [req.auth!.companyId])
      );
      return res.json({ cases: result.rows });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.patch('/smart-ops/referrals/campaigns/:id/config', requirePermission('referral:configure_financials'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const terms = await db.withCompanyDb(req.auth!.companyId, tx =>
        configureCampaign(tx, req.auth!.companyId, toActor(req), id, req.body || {})
      );
      return res.json({ terms: serializeTerms(terms) });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/campaigns/:id/finance-approval', requirePermission('referral:configure_financials'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await db.withCompanyDb(req.auth!.companyId, tx =>
        recordFinanceApproval(tx, req.auth!.companyId, toActor(req), id, req.body?.note ?? null)
      );
      return res.json({ ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/campaigns/:id/management-approval', requirePermission('referral:activate_campaigns'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await db.withCompanyDb(req.auth!.companyId, tx =>
        recordManagementApproval(tx, req.auth!.companyId, toActor(req), id, req.body?.note ?? null)
      );
      return res.json({ ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/campaigns/:id/activate', requirePermission('referral:activate_campaigns'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const terms = await db.withCompanyDb(req.auth!.companyId, tx =>
        activateCampaign(tx, req.auth!.companyId, toActor(req), id)
      );
      return res.json({ terms: serializeTerms(terms) });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/campaigns/:id/lifecycle', requirePermission('referral:activate_campaigns'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await db.withCompanyDb(req.auth!.companyId, tx =>
        setCampaignLifecycle(tx, req.auth!.companyId, toActor(req), id, req.body?.lifecycleStatus, req.body?.reason ?? null)
      );
      return res.json({ ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/smart-ops/referrals/campaigns/:id/budget', requirePermission('referral:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const reconciliation = await db.withCompanyDb(req.auth!.companyId, tx =>
        reconcileBudget(tx, req.auth!.companyId, id)
      );
      return res.json(reconciliation);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/events/:id/qualify', requirePermission('referral:approve_rewards'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const qualified = await qualifyReferralEvent(tx, req.auth!.companyId, toActor(req), id, {
          deliveryEvidence: req.body?.deliveryEvidence ?? null,
        });
        // A1-C: below-threshold rewards are credited automatically after qualification.
        const evRes = await tx.query<any>(
          `SELECT reward_amount, terms_snapshot FROM referral_events WHERE company_id = $1 AND id = $2`,
          [req.auth!.companyId, id]
        );
        const ev = evRes.rows[0];
        const reward4 = ev ? parseDecimal4(String(ev.reward_amount)) : 0n;
        const threshold4 = ev?.terms_snapshot?.rewardApprovalThreshold4 != null
          ? parseDecimal4(String(ev.terms_snapshot.rewardApprovalThreshold4))
          : null;
        let credit: any = null;
        if (!qualified.alreadyQualified && reward4 > 0n && threshold4 != null && reward4 < threshold4) {
          const accts = await resolveSmartOpsAccounts(tx, req.auth!.companyId, toActor(req));
          const prog = await tx.query<{ reward_expense_account_id: number | null }>(
            `SELECT rp.reward_expense_account_id FROM referral_events re
               JOIN referral_programs rp ON rp.company_id = re.company_id AND rp.id = re.program_id
              WHERE re.company_id = $1 AND re.id = $2`,
            [req.auth!.companyId, id]
          );
          const expenseAccountId = prog.rows[0]?.reward_expense_account_id
            ? Number(prog.rows[0].reward_expense_account_id)
            : accts.marketingExpense6450;
          credit = await creditReferralRewardToWallet(tx, req.auth!.companyId, toActor(req), { eventId: id, expenseAccountId });
        }
        return { qualified, credit };
      });
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/events/:id/credit', requirePermission('referral:credit_rewards'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const accts = await resolveSmartOpsAccounts(tx, req.auth!.companyId, toActor(req));
        const prog = await tx.query<{ reward_expense_account_id: number | null }>(
          `SELECT rp.reward_expense_account_id FROM referral_events re
             JOIN referral_programs rp ON rp.company_id = re.company_id AND rp.id = re.program_id
            WHERE re.company_id = $1 AND re.id = $2`,
          [req.auth!.companyId, id]
        );
        const expenseAccountId = prog.rows[0]?.reward_expense_account_id
          ? Number(prog.rows[0].reward_expense_account_id)
          : accts.marketingExpense6450;
        return creditReferralRewardToWallet(tx, req.auth!.companyId, toActor(req), { eventId: id, expenseAccountId });
      });
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/events/:id/reverse', requirePermission('referral:reverse_rewards'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        reverseReferralReward(tx, req.auth!.companyId, toActor(req), {
          eventId: id,
          amount: req.body?.amount ?? null,
          reason: req.body?.reason ?? null,
        })
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/cases', requirePermission('referral:investigate_fraud'), async (req: Request, res: Response) => {
    try {
      const caseId = await db.withCompanyDb(req.auth!.companyId, tx =>
        flagReferralHold(tx, req.auth!.companyId, toActor(req), {
          attributionId: req.body?.attributionId ?? null,
          eventId: req.body?.eventId ?? null,
          reason: req.body?.reason ?? 'Suspicious referral',
          evidence: req.body?.evidence ?? null,
        })
      );
      return res.status(201).json({ caseId });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/cases/:id/decision', requirePermission('referral:decide_fraud'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await db.withCompanyDb(req.auth!.companyId, tx =>
        recordFraudDecision(tx, req.auth!.companyId, toActor(req), {
          caseId: id,
          decision: req.body?.decision,
          reason: req.body?.reason ?? '',
          evidence: req.body?.evidence ?? null,
        })
      );
      return res.json({ ok: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/smart-ops/referrals/cases/:id/review', requirePermission('referral:review_disputes'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await db.withCompanyDb(req.auth!.companyId, tx =>
        recordIndependentDisputeReview(tx, req.auth!.companyId, toActor(req), {
          caseId: id,
          reviewerUserId: Number(req.body?.reviewerUserId),
          outcome: req.body?.outcome,
          reason: req.body?.reason ?? '',
        })
      );
      return res.json({ ok: true });
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

  // =========================================================================
  // POS SHIFTS
  // =========================================================================
  router.get('/pos/shifts/current', requirePermission('pos:read'), async (req: Request, res: Response) => {
    try {
      const shift = await db.withCompanyDb(req.auth!.companyId, tx =>
        getCurrentUserShift(tx, req.auth!.companyId, req.auth!.userId)
      );
      return res.json({ shift });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/pos/shifts', requirePermission('pos:read'), async (req: Request, res: Response) => {
    try {
      const filters: { status?: 'open' | 'closed'; cashierId?: number; limit?: number } = {};
      if (req.query.status === 'open' || req.query.status === 'closed') filters.status = req.query.status;
      if (req.query.cashierId) filters.cashierId = Number(req.query.cashierId);
      if (req.query.limit) filters.limit = Number(req.query.limit);
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        listPosShifts(tx, req.auth!.companyId, filters)
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/pos/shifts', requirePermission('pos:write'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        openPosShift(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/pos/shifts/:id/close', requirePermission('pos:write'), async (req: Request, res: Response) => {
    try {
      const shiftId = Number(req.params.id);
      if (!Number.isInteger(shiftId) || shiftId <= 0) return res.status(400).json({ error: 'Invalid shift id' });
      const allowOther =
        req.body?.allowOtherCashier === true &&
        hasPermission(req.auth!.role, 'pos:manage_shifts');
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        closePosShift(tx, req.auth!.companyId, toActor(req), shiftId, {
          ...(req.body || {}),
          allowOtherCashier: allowOther,
        })
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/pos/shifts/:id/cash-movements', requirePermission('pos:write'), async (req: Request, res: Response) => {
    try {
      const shiftId = Number(req.params.id);
      if (!Number.isInteger(shiftId) || shiftId <= 0) return res.status(400).json({ error: 'Invalid shift id' });
      const movement = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordPosCashMovement(tx, req.auth!.companyId, toActor(req), shiftId, req.body || {})
      );
      return res.status(201).json({ movement });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/pos/shifts/:id/cash-movements', requirePermission('pos:read'), async (req: Request, res: Response) => {
    try {
      const shiftId = Number(req.params.id);
      if (!Number.isInteger(shiftId) || shiftId <= 0) return res.status(400).json({ error: 'Invalid shift id' });
      const movements = await db.withCompanyDb(req.auth!.companyId, tx =>
        listPosCashMovements(tx, req.auth!.companyId, shiftId)
      );
      return res.json({ movements });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.get('/pos/shifts/:id/transactions', requirePermission('pos:read'), async (req: Request, res: Response) => {
    try {
      const shiftId = Number(req.params.id);
      if (!Number.isInteger(shiftId) || shiftId <= 0) return res.status(400).json({ error: 'Invalid shift id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        getPosShiftTransactions(tx, req.auth!.companyId, shiftId)
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // =========================================================================
  // POS SUSPENDED SALES
  // =========================================================================
  router.get('/pos/suspended', requirePermission('pos:read'), async (req: Request, res: Response) => {
    try {
      const filters: { status?: 'suspended' | 'resumed'; shiftId?: number } = {};
      if (req.query.status === 'suspended' || req.query.status === 'resumed') filters.status = req.query.status;
      if (req.query.shiftId) filters.shiftId = Number(req.query.shiftId);
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        listSuspendedSales(tx, req.auth!.companyId, filters)
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/pos/orders/:id/suspend', requirePermission('pos:write'), async (req: Request, res: Response) => {
    try {
      const orderId = Number(req.params.id);
      if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'Invalid POS order id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        suspendPosOrder(tx, req.auth!.companyId, toActor(req), {
          posOrderId: orderId,
          notes: req.body?.notes,
          suspendId: req.body?.suspendId ?? null,
        })
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/pos/suspended/:id/resume', requirePermission('pos:write'), async (req: Request, res: Response) => {
    try {
      const suspendedId = Number(req.params.id);
      if (!Number.isInteger(suspendedId) || suspendedId <= 0) return res.status(400).json({ error: 'Invalid suspended sale id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        resumePosOrder(tx, req.auth!.companyId, toActor(req), { suspendedSaleId: suspendedId })
      );
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

// =========================================================================
  // POS BARCODE
  // =========================================================================
  router.post('/pos/scan', requirePermission('pos:read'), async (req: Request, res: Response) => {
    try {
      const barcode = String(req.body?.barcode || '').trim();
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        lookupBarcode(tx, req.auth!.companyId, barcode)
      );
      if (!result.found) {
        return res.status(404).json(result);
      }
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // =========================================================================
  // POS REFUNDS
  // =========================================================================
  router.get('/pos/refunds', requirePermission('pos:read'), async (req: Request, res: Response) => {
    try {
      const filters: { posOrderId?: number; shiftId?: number } = {};
      if (req.query.posOrderId) filters.posOrderId = Number(req.query.posOrderId);
      if (req.query.shiftId) filters.shiftId = Number(req.query.shiftId);
      const refunds = await db.withCompanyDb(req.auth!.companyId, tx =>
        listPosRefunds(tx, req.auth!.companyId, filters)
      );
      return res.json({ refunds });
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/pos/orders/:id/refund', requirePermission('pos:write'), async (req: Request, res: Response) => {
    try {
      const orderId = Number(req.params.id);
      if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'Invalid POS order id' });
      const { amount, reason, shiftId } = req.body || {};
      if (amount === undefined || amount === null || amount === '') {
        return res.status(400).json({ error: 'amount is required' });
      }
      const refund = await db.withCompanyDb(req.auth!.companyId, tx =>
        createPosRefund(tx, req.auth!.companyId, toActor(req), {
          posOrderId: orderId,
          amount,
          reason: reason ?? null,
          shiftId: shiftId ?? null,
        })
      );
      return res.status(201).json({ refund });
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}
