import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { parseDecimal4 } from '../lib/decimal.ts';
import { consumeApprovalRequest, evaluateApprovalGate, sumLineAmounts4 } from '../services/approvalService.ts';
import {
  applyVendorCreditToBill,
  createBill,
  createPurchaseOrder,
  createVendor,
  createVendorCredit,
  generateSupplierStatement,
  getApAgingReport,
  listBillPayments,
  listBills,
  listPurchaseOrders,
  listVendorCredits,
  listVendors,
  receivePurchaseOrderToBill,
  recordBillPayment,
  updateVendor,
  voidBill,
  voidBillPayment,
} from '../services/purchasingService.ts';
import {
  approvePurchaseRequisition,
  convertRequisitionToPurchaseOrder,
  createPurchaseRequisition,
  createSupplierBillFromPo,
  generateDemandRequisitions,
  listGoodsReceipts,
  listPurchaseRequisitions,
  recordGoodsReceipt,
} from '../services/procurementService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handlePurchasingError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  const msg = (err as any)?.message || 'Purchasing operation failed';
  if (pgCode === '23505' || pgCode === '23514' || pgCode === '23001') {
    return res.status(409).json({ error: msg, code: pgCode });
  }
  console.error('[Purchasing Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createPurchasingRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  router.use(requireAuth, rejectCrossCompanyParams);

  // Vendors
  router.get('/vendors', requirePermission('vendors:read'), async (req: Request, res: Response) => {
    try {
      const vendors = await db.withCompanyDb(req.auth!.companyId, tx => listVendors(tx, req.auth!.companyId));
      return res.json({ companyId: req.auth!.companyId, vendors });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/vendors', requirePermission('vendors:write'), async (req: Request, res: Response) => {
    try {
      const vendor = await db.withCompanyDb(req.auth!.companyId, tx =>
        createVendor(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ vendor });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.patch('/vendors/:id', requirePermission('vendors:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid vendor id' });
      const vendor = await db.withCompanyDb(req.auth!.companyId, tx =>
        updateVendor(tx, req.auth!.companyId, toActor(req), id, req.body || {})
      );
      return res.json({ vendor });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.get('/vendors/:id/statement', requirePermission('vendors:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid vendor id' });
      const statement = await db.withCompanyDb(req.auth!.companyId, tx =>
        generateSupplierStatement(tx, req.auth!.companyId, {
          vendorId: id,
          periodStart: req.query.periodStart ? String(req.query.periodStart) : undefined,
          periodEnd: req.query.periodEnd ? String(req.query.periodEnd) : undefined,
        })
      );
      return res.json({ statement });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  // Purchase Orders
  router.get('/purchase-orders', requirePermission('bills:read'), async (req: Request, res: Response) => {
    try {
      const purchaseOrders = await db.withCompanyDb(req.auth!.companyId, tx =>
        listPurchaseOrders(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, purchaseOrders });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/purchase-orders', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const purchaseOrder = await db.withCompanyDb(req.auth!.companyId, tx =>
        createPurchaseOrder(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ purchaseOrder });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/purchase-orders/:id/receive', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid purchase order id' });
      const auth = req.auth!;
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;

      const result = await db.withCompanyDb(auth.companyId, async tx => {
        const poRes = await tx.query<{ total: string }>(
          `SELECT total::text FROM purchase_orders WHERE company_id = $1 AND id = $2`,
          [auth.companyId, id]
        );
        const amount4 = parseDecimal4(poRes.rows[0]?.total ?? 0);
        const gate = await evaluateApprovalGate(tx, auth.companyId, toActor(req), {
          actionType: 'po_receive',
          entityType: 'purchase_order',
          amount: amount4,
          businessDate: req.body?.billDate || req.body?.receiptDate,
          payload: { poId: id, ...(req.body || {}) },
          approvalRequestId: req.body?.approvalRequestId ? Number(req.body.approvalRequestId) : null,
          idempotencyKey,
        });
        if (gate.requiresApproval) {
          return { gate, received: null as any };
        }
        const received = await receivePurchaseOrderToBill(tx, auth.companyId, toActor(req), id, {
          ...(req.body || {}),
          idempotencyKey,
        });
        if (gate.request) {
          const receivedAny = received as any;
          await consumeApprovalRequest(
            tx,
            auth.companyId,
            toActor(req),
            gate.request.id,
            'bill',
            receivedAny?.bill?.id ?? 0
          );
        }
        return { gate, received };
      });

      if (result.gate.requiresApproval) {
        return res.status(202).json({
          approvalRequired: true,
          approvalRequest: result.gate.request,
          message: 'Purchase order receiving requires maker-checker approval before bill creation.',
        });
      }
      return res.status(201).json(result.received);
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  // Purchase Requisitions & Demand Replenishment
  router.get('/requisitions', requirePermission('bills:read'), async (req: Request, res: Response) => {
    try {
      const requisitions = await db.withCompanyDb(req.auth!.companyId, tx =>
        listPurchaseRequisitions(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, requisitions });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/requisitions', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const requisition = await db.withCompanyDb(req.auth!.companyId, tx =>
        createPurchaseRequisition(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ requisition });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/requisitions/demand', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        generateDemandRequisitions(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(result.generated ? 201 : 200).json(result);
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/requisitions/:id/approve', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid requisition id' });
      const requisition = await db.withCompanyDb(req.auth!.companyId, tx =>
        approvePurchaseRequisition(tx, req.auth!.companyId, toActor(req), id, req.body?.note)
      );
      return res.json({ requisition });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/requisitions/:id/convert-po', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid requisition id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        convertRequisitionToPurchaseOrder(tx, req.auth!.companyId, toActor(req), id, req.body || {})
      );
      return res.status(201).json(result);
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  // Supplier Bill from PO (Purchases In Transit / GRNI 3-Way Support)
  router.post('/purchase-orders/:id/bill', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid purchase order id' });
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        createSupplierBillFromPo(tx, req.auth!.companyId, toActor(req), id, {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  // Physical Goods Receipts
  router.get('/goods-receipts', requirePermission('bills:read'), async (req: Request, res: Response) => {
    try {
      const purchaseOrderId = req.query.purchaseOrderId ? Number(req.query.purchaseOrderId) : undefined;
      const goodsReceipts = await db.withCompanyDb(req.auth!.companyId, tx =>
        listGoodsReceipts(tx, req.auth!.companyId, purchaseOrderId)
      );
      return res.json({ companyId: req.auth!.companyId, goodsReceipts });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/goods-receipts', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        recordGoodsReceipt(tx, req.auth!.companyId, toActor(req), {
          ...(req.body || {}),
          idempotencyKey,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  // Bills
  router.get('/bills', requirePermission('bills:read'), async (req: Request, res: Response) => {
    try {
      const vendorId = req.query.vendorId ? Number(req.query.vendorId) : undefined;
      const bills = await db.withCompanyDb(req.auth!.companyId, tx => listBills(tx, req.auth!.companyId, vendorId));
      return res.json({ companyId: req.auth!.companyId, bills });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/bills', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const body = req.body || {};
      const amount4 = sumLineAmounts4(body.lines, 'quantity', 'unitCost');
      const gate = await db.withCompanyDb(req.auth!.companyId, tx =>
        evaluateApprovalGate(tx, req.auth!.companyId, toActor(req), {
          actionType: 'bill',
          entityType: 'bill',
          amount: amount4,
          businessDate: body.billDate,
          payload: body,
          approvalRequestId: body.approvalRequestId ? Number(body.approvalRequestId) : null,
          idempotencyKey,
        })
      );
      if (gate.requiresApproval) {
        return res.status(202).json({
          approvalRequired: true,
          approvalRequest: gate.request,
          message: 'Vendor bill requires maker-checker approval before posting.',
        });
      }

      const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const created = await createBill(tx, req.auth!.companyId, toActor(req), {
          ...body,
          idempotencyKey,
        });
        if (gate.request) {
          await consumeApprovalRequest(
            tx,
            req.auth!.companyId,
            toActor(req),
            gate.request.id,
            'bill',
            created.bill.id
          );
        }
        return created;
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/bills/:id/void', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid bill id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        voidBill(tx, req.auth!.companyId, toActor(req), id, req.body?.reason)
      );
      return res.json(result);
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  // Bill Payments
  router.get('/bill-payments', requirePermission('bills:read'), async (req: Request, res: Response) => {
    try {
      const vendorId = req.query.vendorId ? Number(req.query.vendorId) : undefined;
      const billPayments = await db.withCompanyDb(req.auth!.companyId, tx =>
        listBillPayments(tx, req.auth!.companyId, vendorId)
      );
      return res.json({ companyId: req.auth!.companyId, billPayments });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/bill-payments', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const body = req.body || {};
      const amount4 = parseDecimal4(body.amount ?? 0);
      const gate = await db.withCompanyDb(req.auth!.companyId, tx =>
        evaluateApprovalGate(tx, req.auth!.companyId, toActor(req), {
          actionType: 'bill_payment',
          entityType: 'bill_payment',
          amount: amount4,
          businessDate: body.paymentDate,
          payload: body,
          approvalRequestId: body.approvalRequestId ? Number(body.approvalRequestId) : null,
          idempotencyKey,
        })
      );
      if (gate.requiresApproval) {
        return res.status(202).json({
          approvalRequired: true,
          approvalRequest: gate.request,
          message: 'Bill payment requires maker-checker approval before posting.',
        });
      }

      const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const created = await recordBillPayment(tx, req.auth!.companyId, toActor(req), {
          ...body,
          idempotencyKey,
        });
        if (gate.request) {
          await consumeApprovalRequest(
            tx,
            req.auth!.companyId,
            toActor(req),
            gate.request.id,
            'bill_payment',
            created.billPayment.id
          );
        }
        return created;
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/bill-payments/:id/void', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid bill payment id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        voidBillPayment(tx, req.auth!.companyId, toActor(req), id, req.body?.reason)
      );
      return res.json(result);
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  // Vendor Credits
  router.get('/vendor-credits', requirePermission('bills:read'), async (req: Request, res: Response) => {
    try {
      const vendorId = req.query.vendorId ? Number(req.query.vendorId) : undefined;
      const vendorCredits = await db.withCompanyDb(req.auth!.companyId, tx =>
        listVendorCredits(tx, req.auth!.companyId, vendorId)
      );
      return res.json({ companyId: req.auth!.companyId, vendorCredits });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/vendor-credits', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const vendorCredit = await db.withCompanyDb(req.auth!.companyId, tx =>
        createVendorCredit(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ vendorCredit });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  router.post('/vendor-credits/:id/apply', requirePermission('bills:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid vendor credit id' });
      const vendorCredit = await db.withCompanyDb(req.auth!.companyId, tx =>
        applyVendorCreditToBill(tx, req.auth!.companyId, toActor(req), id, req.body || {})
      );
      return res.json({ vendorCredit });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  // AP Aging
  router.get('/reports/ap-aging', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const asOfDate = req.query.asOfDate ? String(req.query.asOfDate) : undefined;
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getApAgingReport(tx, req.auth!.companyId, asOfDate)
      );
      return res.json({ report });
    } catch (err) {
      return handlePurchasingError(res, err);
    }
  });

  return router;
}
