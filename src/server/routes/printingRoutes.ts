import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import {
  approveJobBudget,
  cancelPrintingJob,
  createControlledReprint,
  createDeliveryNote,
  createMachine,
  createPrintingJob,
  createPrintingJobFromEstimate,
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
  completeContractAssessment,
  createExamBatch,
  createPrintingContract,
  deleteExamPaper,
  getPrintingContract,
  listContractAmendments,
  listContractWalletTransactions,
  listExamPapers,
  listPrintingContracts,
  recordContractAcceptance,
  rejectContractAmendment,
  removeContractAssessment,
  renewPrintingContract,
  requestAssessmentChangeApproval,
  requestContractAmendment,
  resumeContract,
  setPrintingContractStatus,
  suspendContract,
  updateContractAssessment,
  updateExamPaperStatus,
} from '../services/printingRecordsService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handlePrintingError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  const msg = (err as any)?.message || 'Printing workflow error';
  if (pgCode === '23505' || pgCode === '23514' || pgCode === '23001') {
    return res.status(409).json({ error: msg, code: pgCode });
  }
  console.error('[Printing Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createPrintingRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  router.use(requireAuth, rejectCrossCompanyParams);

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
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordMaterialConsumptionAndWaste(tx, req.auth!.companyId, toActor(req), jobId, req.body || {})
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
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordProductionOperation(tx, req.auth!.companyId, toActor(req), jobId, req.body || {})
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
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordFinishingOperation(tx, req.auth!.companyId, toActor(req), jobId, req.body || {})
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

  // Prepaid school printing retainer. Posts the cash-in / unearned-revenue entry.
  router.post('/printing/contracts', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const contract = await db.withCompanyDb(req.auth!.companyId, tx =>
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
          assessments: Array.isArray(req.body?.assessments) ? req.body.assessments : [],
        })
      );
      return res.status(201).json({ contract });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  // Examination print batch (one class / subject group with its papers).
  router.post('/printing/exam-batches', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
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

  router.post('/printing/contracts/:id/cancel', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
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

  router.post('/printing/contracts/:id/renew', requirePermission('printing:contracts:manage'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid contract id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        renewPrintingContract(tx, req.auth!.companyId, toActor(req), id, req.body ?? undefined)
      );
      return res.status(201).json(result);
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

  /* ================================================================
   * Examination papers — read + status transitions + removal
   * ================================================================ */

  router.get('/printing/exam-papers', requirePermission('printing:read'), async (req: Request, res: Response) => {
    try {
      const papers = await db.withCompanyDb(req.auth!.companyId, tx =>
        listExamPapers(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, papers });
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.patch('/printing/exam-papers/:id/status', requirePermission('printing:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid exam paper id' });
      const status = String(req.body?.status || '').trim();
      if (!['queued', 'printing', 'completed'].includes(status)) {
        return res.status(400).json({ error: 'Invalid exam paper status' });
      }
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        updateExamPaperStatus(tx, req.auth!.companyId, toActor(req), id, status as 'queued' | 'printing' | 'completed')
      );
      return res.json(result);
    } catch (err) {
      return handlePrintingError(res, err);
    }
  });

  router.delete('/printing/exam-papers/:id', requirePermission('printing:write'), async (req: Request, res: Response) => {
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

  return router;
}
