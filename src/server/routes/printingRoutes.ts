import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { parseDecimal4 } from '../../shared/decimal.ts';
import { rateLimit } from '../rateLimiter.ts';
import { hasPermission, type Permission } from '../permissions.ts';
import {
  approveJobBudget,
  cancelPrintingJob,
  createControlledReprint,
  createDeliveryNote,
  createMachine,
  createPrintingJob,
  createPrintingJobFromEstimate,
  linkQuickPrintJobToInvoice,
  postQuickPrintJob,
  listQuickPrintJobs,
  getInventoryValuationReport,
  getJobProfitabilityReport,
  getPrintingJobById,
  invoiceDeliveredJob,
  issueJobMaterials,
  listMachines,
  listPrintingJobs,
  recordFinishingOperation,
  recordMaterialConsumptionAndWaste,
  recordProductionOperation,
  recordQualityInspection,
  reserveJobMaterials,
  returnUnusedMaterials,
} from '../services/productionService.ts';
import {
  addContractAssessment,
  amendPrintingContract,
  approveContractAmendment,
  approveExamBatchSpecification,
  cancelExamPaper,
  completeContractAssessment,
  createExamBatch,
  createExamReprint,
  createPrintingContract,
  deleteExamPaper,
  deliverExamPaper,
  getExaminationReconciliation,
  listExamBatches,
  listExamPaperEvents,
  fundContractFromWallet,
  getPrintingContract,
  getContractReconciliation,
  listContractAmendments,
  listContractWalletTransactions,
  listExamPapers,
  listPrintingContracts,
  linkContractDepositInvoice,
  linkMilestoneInvoice,
  recordContractAcceptance,
  recordContractSignature,
  listContractSignatures,
  rejectContractAmendment,
  removeContractAssessment,
  renewPrintingContract,
  requestAssessmentChangeApproval,
  requestContractActivation,
  requestContractAmendment,
  resumeContract,
  setPrintingContractStatus,
  suspendContract,
  topUpContract,
  updateContractAssessment,
  updateExamPaperDetails,
  updateExamPaperStatus,
  voidPrintingContract,
  generateExamGroupProduction,
  completeExamGroupProduction,
  approveExamGroupQc,
  deliverExamGroupChildren,
  postExamGroupInvoice,
  getExamGroupSummary,
  listExamGroups,
  getExamGroupForBatch,
} from '../services/printingRecordsService.ts';
import { generateInvoiceFromWorkflow } from '../services/documentsService.ts';
import { recordCustomerPayment } from '../services/salesService.ts';
import { evaluateApprovalGate } from '../services/approvalService.ts';
import { checkRouteIdempotency, saveRouteIdempotency } from '../services/commercialHelpers.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handlePrintingError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  // Map Postgres constraint/code failures onto safe, typed client responses
  // instead of leaking raw SQL text (G-17).
  if (pgCode === '23505') return res.status(409).json({ error: 'Duplicate record', code: 'DUPLICATE_KEY' });
  if (pgCode === '23514') return res.status(409).json({ error: 'Check constraint violated', code: 'CHECK_CONSTRAINT' });
  if (pgCode === '23001') return res.status(409).json({ error: 'Restrict violation', code: 'RESTRICT_VIOLATION' });
  if (pgCode === '23503') return res.status(409).json({ error: 'Related record is required or in use', code: 'FOREIGN_KEY_CONSTRAINT' });
  if (pgCode === '23502') return res.status(400).json({ error: 'A required field is missing', code: 'MISSING_REQUIRED_FIELD' });
  if (pgCode === '22P02' || pgCode === '22007' || pgCode === '22003') {
    return res.status(400).json({ error: 'Invalid value supplied', code: 'INVALID_VALUE' });
  }
  if (pgCode === '40001') return res.status(409).json({ error: 'Concurrent update, please retry', code: 'SERIALIZATION_CONFLICT' });
  if (pgCode === '40P01') return res.status(409).json({ error: 'Deadlock detected, please retry', code: 'DEADLOCK' });

  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  console.error(`[Printing Route Error ${requestId}]`, err);
  return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR', requestId });
}

export function createPrintingRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  // Contract money movements are capped per user so a runaway client cannot
  // flood the ledger with journals (G-23).
  const contractMoneyLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    keyFn: req => `printing:${req.auth?.companyId ?? 'anon'}:${req.auth?.userId ?? req.ip}`,
  });

  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

  // Machines
  router.get('/printing/machines', requirePermission('printing:read'), async (req: Request, res: Response) => {
    try {
      const machines = await db.withCompanyDb(req.auth!.companyId, tx => listMachines(tx, req.auth!.companyId));
      return res.json({ companyId: req.auth!.companyId, machines });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/machines', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const machine = await db.withCompanyDb(req.auth!.companyId, tx =>
        createMachine(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ machine });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Printing Jobs & Estimates Conversion
  router.get('/printing/jobs', requirePermission('printing:read'), async (req: Request, res: Response) => {
    try {
      const jobs = await db.withCompanyDb(req.auth!.companyId, tx => listPrintingJobs(tx, req.auth!.companyId));
      return res.json({ companyId: req.auth!.companyId, jobs });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.get('/printing/jobs/:id', requirePermission('printing:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const job = await db.withCompanyDb(req.auth!.companyId, tx => getPrintingJobById(tx, req.auth!.companyId, id));
      return res.json({ job });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/jobs', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        createPrintingJob(tx, req.auth!.companyId, toActor(req), {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  /**
   * Recent quick-print desk jobs (newest first) for the desk history panel.
   */
  router.get('/printing/quick-jobs', requirePermission('printing:read'), async (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const jobs = await db.withCompanyDb(req.auth!.companyId, tx =>
        listQuickPrintJobs(tx, req.auth!.companyId, limit)
      );
      return res.json({ companyId: req.auth!.companyId, jobs });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  /**
   * Quick-print desk posting: job + budget approval + material issue to WIP in
   * one transaction. The desk no longer deducts stock in the browser.
   */
  router.post('/printing/quick-jobs', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        postQuickPrintJob(tx, req.auth!.companyId, toActor(req), {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  /**
   * Atomic quick-print sale (on-account or cash).
   *
   * Composes the existing production, invoicing and payment services inside a
   * SINGLE company-scoped transaction so a quick-print desk sale is all-or-
   * nothing: the production job, material issue, WIP, invoice (linked to the
   * job) and — for cash mode — the fully allocated payment commit together or
   * not at all. No financial calculation is duplicated here; the authoritative
   * invoice total from the invoice service drives the payment.
   */
  router.post(
    '/printing/quick-sales',
    requirePermission('printing:write'),
    requirePermission('invoices:write'),
    async (req: Request, res: Response) => {
      try {
        const body = req.body || {};
        const mode = body.mode === 'cash' ? 'cash' : body.mode === 'on_account' ? 'on_account' : null;
        if (!mode) {
          throw new AccountingError(400, "mode must be 'on_account' or 'cash'", 'INVALID_MODE');
        }
        const idempotencyKey =
          (req.headers['idempotency-key'] as string | undefined) || body.idempotencyKey || null;
        if (!idempotencyKey || !String(idempotencyKey).trim()) {
          throw new AccountingError(400, 'An idempotency-key header is required', 'IDEMPOTENCY_KEY_REQUIRED');
        }

        // The payload hash covers every financially meaningful input. The outer
        // request-key is the authoritative duplicate guard for the whole sale.
        const payloadHashInput = {
          mode,
          jobType: body.jobType ?? null,
          customerId: body.customerId ?? null,
          customerName: body.customerName ?? null,
          rawPaperItemId: body.rawPaperItemId ?? null,
          rawTonerItemId: body.rawTonerItemId ?? null,
          title: body.title ?? null,
          pages: body.pages ?? null,
          copies: body.copies ?? null,
          printSide: body.printSide ?? null,
          manualSellingPrice: body.manualSellingPrice ?? null,
          manualSellingPricePerSheet: body.manualSellingPricePerSheet ?? null,
          finishingCost: body.finishingCost ?? null,
          finishingCostPerPage: body.finishingCostPerPage ?? null,
          typingFeeMode: body.typingFeeMode ?? null,
          typingFeeRate: body.typingFeeRate ?? null,
          jobDate: body.jobDate ?? null,
          notes: body.notes ?? null,
          paymentMethod: mode === 'cash' ? body.paymentMethod ?? null : null,
          depositToAccountId: mode === 'cash' ? body.depositToAccountId ?? null : null,
          approvalRequestId: mode === 'cash' ? body.approvalRequestId ?? null : null,
        };

        const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
          const actor = toActor(req);
          const companyId = req.auth!.companyId;

          // 1. Outer idempotency check BEFORE any financial mutation.
          const idem = await checkRouteIdempotency<{ response: any }>(
            tx,
            companyId,
            'printing_quick_sale',
            idempotencyKey,
            payloadHashInput
          );
          if (idem.hit) {
            return { idempotentReplay: true, status: idem.statusCode, body: idem.response.response };
          }

          // 2. Production job + material issue + WIP (authoritative).
          const jobResult = await postQuickPrintJob(tx, companyId, actor, {
            jobType: body.jobType,
            customerId: body.customerId != null ? Number(body.customerId) : null,
            customerName: body.customerName,
            rawPaperItemId: Number(body.rawPaperItemId),
            rawTonerItemId: Number(body.rawTonerItemId),
            title: String(body.title ?? '').trim(),
            pages: Number(body.pages),
            copies: Number(body.copies),
            printSide: body.printSide,
            finishingCost: body.finishingCost,
            finishingCostPerPage: body.finishingCostPerPage,
            typingFeeMode: body.typingFeeMode,
            typingFeeRate: body.typingFeeRate,
            manualSellingPrice: body.manualSellingPrice,
            manualSellingPricePerSheet: body.manualSellingPricePerSheet,
            jobDate: body.jobDate,
            notes: body.notes,
            idempotencyKey,
          });
          const job = jobResult.job;
          const jobId = Number(job.id);
          const wipJournalTxnId = jobResult.wipJournalTxnId ?? null;

          // 3. Invoice linked to the production job. Line values come from the
          //    authoritative job; the invoice service computes the exact total.
          const jobDate = job.jobDate || new Date().toISOString().slice(0, 10);
          const due = new Date(jobDate);
          due.setDate(due.getDate() + 15);
          const dueStr = due.toISOString().split('T')[0];
          const sheets = Number(job.sheetsUsed) || 0;
          const sellingTotal = Number(job.manualSellingPrice) || 0;
          const totalCost = Number(job.totalCost) || 0;
          const lineDesc = `${job.jobNumber}: ${job.title} (${job.pages} pp × ${job.copies} copies, ${job.printSide} · ${sheets} sheets)`;

          const invoiceResult = await generateInvoiceFromWorkflow(tx, companyId, actor, {
            sourceKind: 'quick_print',
            sourceRef: job.jobNumber,
            customerId: job.customerId ?? undefined,
            customerName: job.customerName ?? undefined,
            invoiceDate: jobDate,
            dueDate: dueStr,
            terms: 'Due on Receipt',
            taxRate: 0,
            notes: job.notes || `Quick print desk order ${job.jobNumber}.`,
            idempotencyKey,
            postgresPrintingJobId: jobId,
            lines: [
              {
                description: lineDesc,
                quantity: 1,
                rate: sellingTotal,
                unitCost: totalCost,
                taxable: false,
              },
            ],
          });
          const invoice = invoiceResult.invoice;

          // 4. Cash mode: maker-checker gate + fully allocated payment.
          let payment: any = null;
          if (mode === 'cash') {
            const amount4 = parseDecimal4(invoice.total);
            const gate = await evaluateApprovalGate(tx, companyId, actor, {
              actionType: 'customer_payment',
              entityType: 'customer_payment',
              amount: amount4,
              businessDate: jobDate,
              payload: payloadHashInput,
              approvalRequestId: body.approvalRequestId != null ? Number(body.approvalRequestId) : null,
              idempotencyKey,
            });
            if (gate.requiresApproval) {
              // Abort the whole cash sale — never commit a job/invoice without a
              // recorded payment, and never bypass maker-checker.
              throw new AccountingError(
                409,
                'Cash sale requires maker-checker approval before it can be posted. Nothing was recorded.',
                'PAYMENT_APPROVAL_REQUIRED'
              );
            }
            const payResult = await recordCustomerPayment(tx, companyId, actor, {
              customerId: Number(job.customerId),
              paymentDate: jobDate,
              amount: invoice.total,
              paymentMethod: body.paymentMethod || 'Cash',
              depositToAccountId: body.depositToAccountId != null ? Number(body.depositToAccountId) : null,
              memo: `Quick print cash sale ${job.jobNumber}`,
              idempotencyKey,
              allocations: [{ invoiceId: Number(invoice.id), amount: invoice.total }],
            });
            payment = payResult.payment;
            if (!payment || payment.id == null) {
              throw new AccountingError(500, 'Payment was not recorded; cash sale aborted.', 'PAYMENT_NOT_RECORDED');
            }
          }

          const responseBody = {
            mode,
            job: {
              id: jobId,
              jobNumber: job.jobNumber,
              jobType: job.jobType,
              title: job.title,
              pages: job.pages,
              copies: job.copies,
              printSide: job.printSide,
              customerId: job.customerId ?? null,
              customerName: job.customerName ?? null,
              jobDate: job.jobDate ?? jobDate,
              sheetsUsed: job.sheetsUsed,
              impressionsUsed: job.impressionsUsed,
              paperCost: job.paperCost,
              tonerCost: job.tonerCost,
              totalCost: job.totalCost,
              manualSellingPrice: job.manualSellingPrice,
              profit: job.profit,
            },
            invoice: { id: Number(invoice.id), invoiceNumber: invoice.invoiceNumber, total: invoice.total },
            wipJournalTxnId,
            ...(mode === 'cash'
              ? {
                  payment: {
                    id: Number(payment.id),
                    amount: invoice.total,
                    allocations: [{ invoiceId: Number(invoice.id), amount: invoice.total, status: 'allocated' }],
                  },
                }
              : {}),
          };

          // 5. Persist the outer idempotency record inside the same transaction.
          await saveRouteIdempotency(
            tx,
            companyId,
            'printing_quick_sale',
            idempotencyKey,
            idem.payloadHash,
            201,
            { response: responseBody },
            actor.userId
          );

          return { idempotentReplay: false, status: 201, body: responseBody };
        });

        return res.status(result.status).json({ ...result.body, idempotentReplay: result.idempotentReplay });
      } catch (err) {
        return handlePrintingError(res, err);
      }
    }
  );

  /**
   * Attach an already-raised invoice to a quick-print job and relieve its WIP to
   * COGS. Used when quick-print work is billed on a combined invoice (invoice
   * modal / POS) instead of through the workflow invoice generator.
   */
  router.post('/printing/jobs/:id/invoice-link', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const invoiceId = Number(req.body?.invoiceId);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) return res.status(400).json({ error: 'invoiceId is required' });
      const link = await db.withCompanyDb(req.auth!.companyId, tx =>
        linkQuickPrintJobToInvoice(tx, req.auth!.companyId, toActor(req), { jobId, invoiceId })
      );
      return res.json({ link });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/estimates/:id/create-job', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const estimateId = Number(req.params.id);
      if (!Number.isInteger(estimateId) || estimateId <= 0) return res.status(400).json({ error: 'Invalid estimate id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        createPrintingJobFromEstimate(tx, req.auth!.companyId, toActor(req), estimateId, {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Budget Approval
  router.post('/printing/jobs/:id/approve-budget', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const job = await db.withCompanyDb(req.auth!.companyId, tx =>
        approveJobBudget(tx, req.auth!.companyId, toActor(req), jobId, req.body || {})
      );
      return res.json({ job });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Material Reservation, Issue to Production, Consumption & Waste, Return
  router.post('/printing/jobs/:id/materials/reserve', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        reserveJobMaterials(tx, req.auth!.companyId, toActor(req), jobId, { idempotencyKey })
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/jobs/:id/materials/issue', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        issueJobMaterials(tx, req.auth!.companyId, toActor(req), jobId, {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/jobs/:id/materials/consume', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordMaterialConsumptionAndWaste(tx, req.auth!.companyId, toActor(req), jobId, {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/jobs/:id/materials/return', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        returnUnusedMaterials(tx, req.auth!.companyId, toActor(req), jobId, {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Production & Finishing Operations
  router.post('/printing/jobs/:id/operations', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordProductionOperation(tx, req.auth!.companyId, toActor(req), jobId, {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(201).json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/jobs/:id/finishing', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordFinishingOperation(tx, req.auth!.companyId, toActor(req), jobId, {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(201).json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Quality Control & Deliveries
  router.post('/printing/jobs/:id/qc', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordQualityInspection(tx, req.auth!.companyId, toActor(req), jobId, req.body || {})
      );
      return res.status(201).json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/deliveries', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        createDeliveryNote(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Duplicate-Safe Delivered Job Invoicing (requires invoices:write financial permission!)
  router.post('/printing/jobs/:id/invoice', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        invoiceDeliveredJob(tx, req.auth!.companyId, toActor(req), jobId, {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Cancellation & Controlled Reprints
  router.post('/printing/jobs/:id/cancel', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        cancelPrintingJob(tx, req.auth!.companyId, toActor(req), jobId, req.body || {})
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/jobs/:id/reprint', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        createControlledReprint(tx, req.auth!.companyId, toActor(req), jobId, {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Prepaid school printing retainer. Always creates a DRAFT: the contract is
  // funded later from the customer wallet (D-1).
  router.post('/printing/contracts', contractMoneyLimit, requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        createPrintingContract(tx, req.auth!.companyId, toActor(req), {
          schoolCustomerId: Number(req.body?.schoolCustomerId),
          title: req.body?.title,
          academicYear: req.body?.academicYear,
          startDate: req.body?.startDate,
          endDate: req.body?.endDate,
          totalPrepaidAmount: req.body?.totalPrepaidAmount,
          totalAssessments: Number(req.body?.totalAssessments),
          depositBankAccountId: Number(req.body?.depositBankAccountId),
          notes: req.body?.notes ?? null,
          renewalOfContractId: req.body?.renewalOfContractId ?? null,
          assessments: Array.isArray(req.body?.assessments) ? req.body.assessments : [],
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json({ contract: result });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Fund a draft contract from the customer wallet (G-03, G-05).
  router.post(
    '/printing/contracts/:id/fund',
    contractMoneyLimit,
    requirePermission('printing:contracts:manage'),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
        const idempotencyKey =
          (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
        const funding = await db.withCompanyDb(req.auth!.companyId, tx =>
          fundContractFromWallet(tx, req.auth!.companyId, toActor(req), id, {
            idempotencyKey,
            notes: req.body?.notes ?? null,
          })
        );
        return res.status(201).json({ funding });
      } catch (err) {
        return handlePrintingError(res, err);
      }
    }
  );

  // Record a pending activation approval request (G-03).
  router.post(
    '/printing/contracts/:id/activation-requests',
    requirePermission('printing:contracts:manage'),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
        const request = await db.withCompanyDb(req.auth!.companyId, tx =>
          requestContractActivation(tx, req.auth!.companyId, toActor(req), id, {
            reason: req.body?.reason,
            amount: req.body?.amount,
            payload: req.body?.payload,
          })
        );
        return res.status(201).json({ request });
      } catch (err) {
        return handlePrintingError(res, err);
      }
    }
  );

  // Additional retainer deposit against an active contract (G-18).
  router.post(
    '/printing/contracts/:id/deposits',
    contractMoneyLimit,
    requirePermission('printing:contracts:manage'),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
        const idempotencyKey =
          (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
        const result = await db.withCompanyDb(req.auth!.companyId, tx =>
          topUpContract(tx, req.auth!.companyId, toActor(req), id, {
            amount: req.body?.amount,
            bankAccountId: Number(req.body?.bankAccountId),
            depositDate: req.body?.depositDate,
            notes: req.body?.notes ?? null,
            idempotencyKey,
          })
        );
        return res.status(result.idempotentReplay ? 200 : 201).json({ deposit: result });
      } catch (err) {
        return handlePrintingError(res, err);
      }
    }
  );

  // Examination print batch (one class / subject group with its papers).
  router.post('/printing/exam-batches', requirePermission('exams:create'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const batch = await db.withCompanyDb(req.auth!.companyId, tx =>
        createExamBatch(tx, req.auth!.companyId, toActor(req), {
          schoolCustomerId: Number(req.body?.schoolCustomerId),
          assessmentName: req.body?.assessmentName,
          className: req.body?.className,
          learnersCount: Number(req.body?.learnersCount),
          pricePerLearner: req.body?.pricePerLearner,
          contractId: req.body?.contractId ?? null,
          assessmentNumber: req.body?.assessmentNumber ?? null,
          papers: Array.isArray(req.body?.papers) ? req.body.papers : [],
          classes: Array.isArray(req.body?.classes) ? req.body.classes : undefined,
          dueDate: req.body?.dueDate ?? null,
          priority: req.body?.priority ?? null,
          idempotencyKey,
        })
      );
      return res.status(201).json({ batch });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Job Profitability & Inventory Valuation Reconciliation Reports
  router.get('/printing/jobs/:id/profitability', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const jobId = Number(req.params.id);
      if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: 'Invalid job id' });
      const profitability = await db.withCompanyDb(req.auth!.companyId, tx =>
        getJobProfitabilityReport(tx, req.auth!.companyId, jobId)
      );
      return res.json({ profitability });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.get('/inventory/valuation', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const valuation = await db.withCompanyDb(req.auth!.companyId, tx =>
        getInventoryValuationReport(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, valuation });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  /* ================================================================
   * Printing Contracts — read + lifecycle (advanced options)
   * ================================================================ */

  router.get('/printing/contracts', requirePermission('printing:read'), async (req: Request, res: Response) => {
    try {
      const contracts = await db.withCompanyDb(req.auth!.companyId, tx =>
        listPrintingContracts(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, contracts });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.get('/printing/contracts/:id', requirePermission('printing:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
        getPrintingContract(tx, req.auth!.companyId, id)
      );
      return res.json({ contract });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.patch('/printing/contracts/:id', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
        amendPrintingContract(tx, req.auth!.companyId, toActor(req), id, {
          title: req.body?.title,
          academicYear: req.body?.academicYear,
          startDate: req.body?.startDate,
          endDate: req.body?.endDate,
          notes: req.body?.notes,
        })
      );
      return res.json({ contract });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/activate', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
        setPrintingContractStatus(tx, req.auth!.companyId, toActor(req), id, 'activate')
      );
      return res.json({ contract });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/cancel', contractMoneyLimit, requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
        setPrintingContractStatus(tx, req.auth!.companyId, toActor(req), id, 'cancel', req.body?.reason ?? null, {
          settlementMode: req.body?.settlementMode ?? null,
          refundBankAccountId:
            req.body?.refundBankAccountId != null ? Number(req.body.refundBankAccountId) : null,
        })
      );
      return res.json({ contract });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/void', contractMoneyLimit, requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
        voidPrintingContract(tx, req.auth!.companyId, toActor(req), id, {
          reason: req.body?.reason ?? '',
        })
      );
      return res.json({ contract });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/renew', contractMoneyLimit, requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        renewPrintingContract(tx, req.auth!.companyId, toActor(req), id, {
          ...(req.body ?? {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json({ contract: result });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/suspend', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
        suspendContract(tx, req.auth!.companyId, toActor(req), id, String(req.body?.reason || ''))
      );
      return res.json({ contract });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/resume', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
        resumeContract(tx, req.auth!.companyId, toActor(req), id)
      );
      return res.json({ contract });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/acceptances', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const body = req.body || {};
      const method = String(body.method || '');
      if (!['drawn', 'otp', 'upload'].includes(method)) {
        return res.status(400).json({ error: 'Invalid acceptance method' });
      }
      const acceptance = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordContractAcceptance(tx, req.auth!.companyId, toActor(req), id, {
          method: method as 'drawn' | 'otp' | 'upload',
          signerName: String(body.signerName || ''),
          signerEmail: body.signerEmail ?? null,
          signerPhone: body.signerPhone ?? null,
          documentVersion: String(body.documentVersion || ''),
          evidenceFileId: body.evidenceFileId != null ? Number(body.evidenceFileId) : null,
          otpVerified: body.otpVerified === true,
          outcome: body.outcome === 'rejected' ? 'rejected' : 'accepted',
          ipAddress: body.ipAddress ?? null,
        })
      );
      return res.status(201).json({ acceptance });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.get('/printing/contracts/reconciliation', requirePermission('reports:view_reconciliation'), async (req: Request, res: Response) => {
    try {
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getContractReconciliation(tx, req.auth!.companyId)
      );
      return res.json({ report });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.get('/printing/contracts/:id/signatures', requirePermission('printing:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const signatures = await db.withCompanyDb(req.auth!.companyId, tx =>
        listContractSignatures(tx, req.auth!.companyId, id)
      );
      return res.json({ signatures });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/signatures', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const body = req.body || {};
      const method = String(body.method || '');
      if (!['drawn', 'typed', 'upload'].includes(method)) {
        return res.status(400).json({ error: 'Invalid signature method' });
      }
      const signature = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordContractSignature(tx, req.auth!.companyId, toActor(req), id, {
          signerRole: body.signerRole === 'customer' ? 'customer' : 'company',
          signerName: String(body.signerName || ''),
          method: method as 'drawn' | 'typed' | 'upload',
          signatureData: String(body.signatureData || ''),
          documentVersion: body.documentVersion ?? null,
        })
      );
      return res.status(201).json({ signature });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/amendments', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const body = req.body || {};
      const amendment = await db.withCompanyDb(req.auth!.companyId, tx =>
        requestContractAmendment(tx, req.auth!.companyId, toActor(req), id, {
          amendmentType: String(body.amendmentType || 'terms') as 'terms' | 'schedule' | 'amount',
          reason: String(body.reason || ''),
          title: body.title,
          academicYear: body.academicYear,
          startDate: body.startDate,
          endDate: body.endDate,
          notes: body.notes ?? null,
          assessments: Array.isArray(body.assessments) ? body.assessments : undefined,
        })
      );
      return res.status(201).json({ amendment });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.get('/printing/contracts/:id/amendments', requirePermission('printing:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const amendments = await db.withCompanyDb(req.auth!.companyId, tx =>
        listContractAmendments(tx, req.auth!.companyId, id)
      );
      return res.json({ amendments });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/amendments/:amendmentId/approve', requirePermission('approvals:decide'), async (req: Request, res: Response) => {
    try {
      const amendmentId = Number(req.params.amendmentId);
      if (!Number.isInteger(amendmentId) || amendmentId <= 0) {
        return res.status(400).json({ error: 'Invalid amendment id' });
      }
      const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
        approveContractAmendment(
          tx,
          req.auth!.companyId,
          toActor(req),
          amendmentId,
          req.body?.approvalRequestId != null ? Number(req.body.approvalRequestId) : null
        )
      );
      return res.json({ contract });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/amendments/:amendmentId/reject', requirePermission('approvals:decide'), async (req: Request, res: Response) => {
    try {
      const amendmentId = Number(req.params.amendmentId);
      if (!Number.isInteger(amendmentId) || amendmentId <= 0) {
        return res.status(400).json({ error: 'Invalid amendment id' });
      }
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        rejectContractAmendment(tx, req.auth!.companyId, toActor(req), amendmentId, String(req.body?.reason || ''))
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/assessment-changes', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const body = req.body || {};
      const request = await db.withCompanyDb(req.auth!.companyId, tx =>
        requestAssessmentChangeApproval(tx, req.auth!.companyId, toActor(req), id, {
          reason: String(body.reason || ''),
          amount: body.amount,
          payload: body.payload,
        })
      );
      return res.status(201).json({ request });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/contracts/:id/assessments', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
        addContractAssessment(tx, req.auth!.companyId, toActor(req), id, {
          assessmentNumber: Number(req.body?.assessmentNumber),
          label: req.body?.label,
          scheduledDate: req.body?.scheduledDate,
          agreedAmount: req.body?.agreedAmount,
          rawPaperItemId: req.body?.rawPaperItemId ?? null,
          rawTonerItemId: req.body?.rawTonerItemId ?? null,
          estimatedSheets: req.body?.estimatedSheets ?? null,
          estimatedImpressions: req.body?.estimatedImpressions ?? null,
          paperCost: req.body?.paperCost ?? null,
          tonerCost: req.body?.tonerCost ?? null,
          examBatchNote: req.body?.examBatchNote ?? null,
        })
      );
      return res.status(201).json({ contract });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.patch(
    '/printing/contracts/:id/assessments/:assessmentNumber',
    requirePermission('printing:contracts:manage'),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        const assessmentNumber = Number(req.params.assessmentNumber);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
        if (!Number.isInteger(assessmentNumber) || assessmentNumber <= 0) {
          return res.status(400).json({ error: 'Invalid assessment number' });
        }
        const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
          updateContractAssessment(tx, req.auth!.companyId, toActor(req), id, assessmentNumber, {
            assessmentNumber,
            label: req.body?.label,
            scheduledDate: req.body?.scheduledDate,
            agreedAmount: req.body?.agreedAmount,
            rawPaperItemId: req.body?.rawPaperItemId,
            rawTonerItemId: req.body?.rawTonerItemId,
            estimatedSheets: req.body?.estimatedSheets,
            estimatedImpressions: req.body?.estimatedImpressions,
            paperCost: req.body?.paperCost,
            tonerCost: req.body?.tonerCost,
          })
        );
        return res.json({ contract });
      } catch (err) {
        return handlePrintingError(res, err);
      }
    }
  );

  router.delete(
    '/printing/contracts/:id/assessments/:assessmentNumber',
    requirePermission('printing:contracts:manage'),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        const assessmentNumber = Number(req.params.assessmentNumber);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
        if (!Number.isInteger(assessmentNumber) || assessmentNumber <= 0) {
          return res.status(400).json({ error: 'Invalid assessment number' });
        }
        const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
          removeContractAssessment(tx, req.auth!.companyId, toActor(req), id, assessmentNumber)
        );
        return res.json({ contract });
      } catch (err) {
        return handlePrintingError(res, err);
      }
    }
  );

  router.post(
    '/printing/contracts/:id/assessments/:assessmentNumber/complete',
    requirePermission('printing:contracts:manage'),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        const assessmentNumber = Number(req.params.assessmentNumber);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
        if (!Number.isInteger(assessmentNumber) || assessmentNumber <= 0) {
          return res.status(400).json({ error: 'Invalid assessment number' });
        }
        const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
          completeContractAssessment(tx, req.auth!.companyId, toActor(req), id, assessmentNumber, {
            examBatchNote: req.body?.examBatchNote ?? null,
            linkedInvoiceId: req.body?.linkedInvoiceId != null ? Number(req.body.linkedInvoiceId) : null,
          })
        );
        return res.json({ contract });
      } catch (err) {
        return handlePrintingError(res, err);
      }
    }
  );

  router.get(
    '/printing/contracts/:id/wallet-transactions',
    requirePermission('printing:read'),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
        const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
          const contract = await getPrintingContract(tx, req.auth!.companyId, id);
          const transactions = await listContractWalletTransactions(
            tx,
            req.auth!.companyId,
            contract.contractNumber
          );
          return { contractNumber: contract.contractNumber, transactions };
        });
        return res.json(result);
      } catch (err) {
        return handlePrintingError(res, err);
      }
    }
  );

  // Link a generated retainer invoice to its contract (G-09).
  router.post(
    '/printing/contracts/:id/deposit-invoice',
    requirePermission('invoices:write'),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
        const invoiceId = Number(req.body?.invoiceId);
        if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
          return res.status(400).json({ error: 'A valid invoiceId is required' });
        }
        const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
          linkContractDepositInvoice(tx, req.auth!.companyId, toActor(req), id, {
            invoiceId,
            invoiceNumber: req.body?.invoiceNumber ?? null,
          })
        );
        return res.json({ contract });
      } catch (err) {
        return handlePrintingError(res, err);
      }
    }
  );

  // Link a generated assessment invoice to its milestone (G-09).
  router.post(
    '/printing/contracts/:id/assessments/:assessmentNumber/invoice-link',
    requirePermission('invoices:write'),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        const assessmentNumber = Number(req.params.assessmentNumber);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
        if (!Number.isInteger(assessmentNumber) || assessmentNumber < 1) {
          return res.status(400).json({ error: 'Invalid assessment number' });
        }
        const invoiceId = Number(req.body?.invoiceId);
        if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
          return res.status(400).json({ error: 'A valid invoiceId is required' });
        }
        const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
          linkMilestoneInvoice(tx, req.auth!.companyId, toActor(req), id, assessmentNumber, {
            invoiceId,
            invoiceNumber: req.body?.invoiceNumber ?? null,
          })
        );
        return res.json({ contract });
      } catch (err) {
        return handlePrintingError(res, err);
      }
    }
  );

  /* ================================================================
   * Examination papers — read + status transitions + removal
   * ================================================================ */

  router.get('/printing/exam-papers', requirePermission('exams:view'), async (req: Request, res: Response) => {
    try {
      const papers = await db.withCompanyDb(req.auth!.companyId, tx =>
        listExamPapers(tx, req.auth!.companyId)
      );
      // P0-02 (data-leak slice): exam cost fields are confidential. Only
      // holders of exams:view_confidential may see paper/toner/material cost,
      // cost status/warnings and physical consumption. Everyone else with
      // exams:view gets the operational fields with costs redacted.
      const canViewCosts = hasPermission(req.auth!.role, 'exams:view_confidential');
      const redacted = canViewCosts
        ? papers
        : papers.map(p => ({
            ...p,
            paperCost: undefined,
            tonerCost: undefined,
            materialCost: undefined,
            costStatus: undefined,
            costWarnings: undefined,
            sheetsUsed: undefined,
            impressionsUsed: undefined,
            wasteSheets: undefined,
          }));
      return res.json({ companyId: req.auth!.companyId, papers: redacted, costsRedacted: !canViewCosts });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Examination batch register with aggregated paper counts and totals.
  router.get('/printing/exam-batches', requirePermission('exams:view'), async (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const schoolRaw = req.query.schoolCustomerId;
      const schoolCustomerId =
        typeof schoolRaw === 'string' && /^\d+$/.test(schoolRaw) ? Number(schoolRaw) : null;
      const batches = await db.withCompanyDb(req.auth!.companyId, tx =>
        listExamBatches(tx, req.auth!.companyId, { status, schoolCustomerId })
      );
      // P0-02 (data-leak slice): redact aggregate cost totals unless the caller
      // holds exams:view_confidential.
      const canViewCosts = hasPermission(req.auth!.role, 'exams:view_confidential');
      const redacted = canViewCosts
        ? batches
        : batches.map(b => ({
            ...b,
            totalPaperCost: undefined,
            totalTonerCost: undefined,
          }));
      return res.json({ companyId: req.auth!.companyId, batches: redacted, costsRedacted: !canViewCosts });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Authoritative group identity for a selected examination batch. The group is
  // derived from the batch's persisted exam_batch_group_id (never a client guess).
  router.get('/printing/exam-batches/:id/group', requirePermission('exams:view'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam batch id' });
      const group = await db.withCompanyDb(req.auth!.companyId, tx =>
        getExamGroupForBatch(tx, req.auth!.companyId, id)
      );
      return res.json({ group });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Append-only production timeline for a paper.
  router.get('/printing/exam-papers/:id/events', requirePermission('exams:view'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam paper id' });
      const events = await db.withCompanyDb(req.auth!.companyId, tx =>
        listExamPaperEvents(tx, req.auth!.companyId, id)
      );
      return res.json({ paperId: id, events });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Status transitions carry a different duty per target state, so the required
  // permission is resolved server-side rather than trusting a single broad grant.
  const EXAM_TRANSITION_PERMISSION: Record<string, Permission> = {
    queued: 'exams:produce',
    printing: 'exams:produce',
    completed: 'exams:qc',
    qc_passed: 'exams:qc',
    qc_hold: 'exams:qc',
    packed: 'exams:dispatch',
    dispatched: 'exams:dispatch',
  };

  router.patch('/printing/exam-papers/:id/status', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam paper id' });
      const status = String(req.body?.status || '').trim();
      const permission = EXAM_TRANSITION_PERMISSION[status];
      if (!permission) {
        return res.status(400).json({ error: 'Invalid exam paper status' });
      }
      if (!hasPermission(req.auth!.role, permission)) {
        return res.status(403).json({
          error: `Role '${req.auth!.role}' lacks required permission '${permission}'`,
        });
      }
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        updateExamPaperStatus(tx, req.auth!.companyId, toActor(req), id, status as any, {
          reason: req.body?.reason ?? null,
          goodCopies: req.body?.goodCopies != null ? Number(req.body.goodCopies) : undefined,
          spoiledCopies:
            req.body?.spoiledCopies != null ? Number(req.body.spoiledCopies) : undefined,
          packageCount: req.body?.packageCount != null ? Number(req.body.packageCount) : undefined,
          sealReference: req.body?.sealReference ?? null,
          qcNotes: req.body?.qcNotes ?? null,
        })
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Edit an examination paper's details before production begins (spec not frozen,
  // paper still queued). Teacher copies remain fixed (D3); the linked production
  // job's ordered quantity is kept in sync.
  router.patch('/printing/exam-papers/:id', requirePermission('exams:edit'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam paper id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const paper = await db.withCompanyDb(req.auth!.companyId, tx =>
        updateExamPaperDetails(tx, req.auth!.companyId, toActor(req), id, {
          subjectName: req.body?.subjectName ?? undefined,
          pages: req.body?.pages != null ? Number(req.body.pages) : undefined,
          copies: req.body?.copies != null ? Number(req.body.copies) : undefined,
          printSide: req.body?.printSide ?? undefined,
          bindingType: req.body?.bindingType ?? undefined,
          paperSize: req.body?.paperSize ?? undefined,
          productionDate: req.body?.productionDate ?? undefined,
          notes: req.body?.notes ?? undefined,
          reason: req.body?.reason ?? null,
          idempotencyKey,
        })
      );
      return res.json(paper);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Controlled cancellation with mandatory reason and inventory release.
  router.post('/printing/exam-papers/:id/cancel', requirePermission('exams:cancel'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam paper id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        cancelExamPaper(tx, req.auth!.companyId, toActor(req), id, {
          reason: String(req.body?.reason || ''),
          returnUnusedMaterials: req.body?.returnUnusedMaterials !== false,
        })
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Controlled reprint: a new linked production record, never a mutation of the parent.
  router.post('/printing/exam-papers/:id/reprint', requirePermission('exams:produce'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam paper id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        createExamReprint(tx, req.auth!.companyId, toActor(req), id, {
          reason: String(req.body?.reason || req.body?.reprintReason || ''),
          copies: req.body?.copies != null ? Number(req.body.copies) : undefined,
          productionDate: req.body?.productionDate ?? null,
          idempotencyKey,
        })
      );
      return res.status(201).json({ reprint: result });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Freeze the approved production specification for a batch.
  router.post('/printing/exam-batches/:id/approve-spec', requirePermission('exams:approve'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam batch id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        approveExamBatchSpecification(tx, req.auth!.companyId, toActor(req), id, {
          notes: req.body?.notes ?? null,
        })
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Authoritative examination reconciliation (read-only).
  router.get('/printing/exam-reconciliation', requirePermission('exams:view'), async (req: Request, res: Response) => {
    try {
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getExaminationReconciliation(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, report });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/exam-papers/:id/deliver', requirePermission('exams:deliver'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam paper id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        deliverExamPaper(tx, req.auth!.companyId, toActor(req), id, {
          dispatchDate: req.body?.dispatchDate ?? null,
          recipientName: req.body?.recipientName ?? null,
          driverName: req.body?.driverName ?? null,
          vehicleReg: req.body?.vehicleReg ?? null,
          notes: req.body?.notes ?? null,
        })
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.delete('/printing/exam-papers/:id', requirePermission('exams:cancel'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam paper id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        deleteExamPaper(tx, req.auth!.companyId, toActor(req), id)
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // ---- Examination batch group: one-click production & invoicing ----
  // Each checkpoint is a durable, independently idempotent transaction. The
  // idempotency key is taken from the header (or body) and scoped per route.

  router.get('/printing/exam-groups', requirePermission('exams:view'), async (req: Request, res: Response) => {
    try {
      const schoolParam = req.query.schoolCustomerId;
      const schoolCustomerId =
        schoolParam != null && String(schoolParam).trim() && Number.isInteger(Number(schoolParam))
          ? Number(schoolParam)
          : null;
      const assessmentName = req.query.assessmentName != null ? String(req.query.assessmentName) : null;
      const groups = await db.withCompanyDb(req.auth!.companyId, tx =>
        listExamGroups(tx, req.auth!.companyId, { schoolCustomerId, assessmentName })
      );
      return res.json({ groups });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/exam-groups/:id/generate-production', requirePermission('exams:produce'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam group id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const summary = await db.withCompanyDb(req.auth!.companyId, tx =>
        generateExamGroupProduction(tx, req.auth!.companyId, toActor(req), { groupId: id, idempotencyKey })
      );
      return res.status(201).json({ summary });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/exam-groups/:id/complete-production', requirePermission('exams:qc'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam group id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const summary = await db.withCompanyDb(req.auth!.companyId, tx =>
        completeExamGroupProduction(tx, req.auth!.companyId, toActor(req), {
          groupId: id,
          idempotencyKey,
          goodCopiesByPaper: req.body?.goodCopiesByPaper ?? undefined,
          spoiledCopiesByPaper: req.body?.spoiledCopiesByPaper ?? undefined,
        })
      );
      return res.json({ summary });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/exam-groups/:id/approve-qc', requirePermission('exams:qc'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam group id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const summary = await db.withCompanyDb(req.auth!.companyId, tx =>
        approveExamGroupQc(tx, req.auth!.companyId, toActor(req), {
          groupId: id,
          idempotencyKey,
          qcNotesByPaper: req.body?.qcNotesByPaper ?? undefined,
        })
      );
      return res.json({ summary });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/exam-groups/:id/deliver', requirePermission('exams:deliver'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam group id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const summary = await db.withCompanyDb(req.auth!.companyId, tx =>
        deliverExamGroupChildren(tx, req.auth!.companyId, toActor(req), {
          groupId: id,
          idempotencyKey,
          dispatchDate: req.body?.dispatchDate ?? null,
          recipientName: req.body?.recipientName ?? null,
          driverName: req.body?.driverName ?? null,
          vehicleReg: req.body?.vehicleReg ?? null,
          notes: req.body?.notes ?? null,
        })
      );
      return res.json({ summary });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.post('/printing/exam-groups/:id/invoice', requirePermission('exams:invoice'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam group id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const summary = await db.withCompanyDb(req.auth!.companyId, tx =>
        postExamGroupInvoice(tx, req.auth!.companyId, toActor(req), {
          groupId: id,
          idempotencyKey,
          includeTax: Boolean(req.body?.includeTax),
          taxRate: req.body?.taxRate != null ? Number(req.body.taxRate) : undefined,
          notes: req.body?.notes ?? null,
        })
      );
      return res.status(201).json({ summary });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.get('/printing/exam-groups/:id/summary', requirePermission('exams:view'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam group id' });
      const summary = await db.withCompanyDb(req.auth!.companyId, tx =>
        getExamGroupSummary(tx, req.auth!.companyId, id)
      );
      return res.json({ summary });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  return router;
}
