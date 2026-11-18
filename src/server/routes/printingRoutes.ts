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
  createExamBatch,
  createPrintingContract,
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
  router.post('/printing/contracts', requirePermission('printing:write'), async (req: Request, res: Response) => {
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

  return router;
}
