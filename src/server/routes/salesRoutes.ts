import { Router, Request, Response } from 'express';
import { writeAuditLog } from '../audit.ts';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { hasPermission } from '../permissions.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { computeTax4, parseDecimal6 } from '../services/commercialHelpers.ts';
import { parseDecimal4 } from '../lib/decimal.ts';
import {
  consumeApprovalRequest,
  evaluateApprovalGate,
  sumLineAmounts4,
} from '../services/approvalService.ts';
import {
  applyCreditMemoToInvoice,
  applyUnappliedPaymentToInvoice,
  approveEstimate,
  convertEstimateToInvoice,
  createCreditMemo,
  createCustomer,
  createEstimate,
  createInvoiceOrSalesReceipt,
  createRecurringInvoice,
  createResellerPermit,
  dispatchInvoiceReminder,
  generateCustomerStatement,
  getArAgingReport,
  getCustomerCreditProfile,
  listCommunicationsAndReminders,
  listCreditMemos,
  listCustomerStatements,
  listCustomers,
  listEstimates,
  listInvoices,
  listPayments,
  listPaymentTerms,
  listRecurringInvoices,
  listResellerPermits,
  listUnappliedPayments,
  recordCustomerPayment,
  rejectEstimate,
  runDueRecurringInvoices,
  sendCustomerStatement,
  updateCustomer,
  voidCreditMemo,
  voidCustomerPayment,
  voidInvoice,
} from '../services/salesService.ts';
import {
  listFxRevaluationRuns,
  postFxRevaluation,
  previewFxRevaluation,
} from '../services/fxRevaluationService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleSalesError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const pgCode = (err as any)?.code;
  const msg = (err as any)?.message || 'Sales operation failed';
  if (pgCode === '23505' || pgCode === '23514' || pgCode === '23001') {
    return res.status(409).json({ error: msg, code: pgCode });
  }
  console.error('[Sales Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createSalesRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

  // Payment Terms
  router.get('/payment-terms', requirePermission('customers:read'), async (req: Request, res: Response) => {
    try {
      const terms = await db.withCompanyDb(req.auth!.companyId, tx => listPaymentTerms(tx, req.auth!.companyId));
      return res.json({ companyId: req.auth!.companyId, terms });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  // Customers & Reseller Permits
  router.get('/customers', requirePermission('customers:read'), async (req: Request, res: Response) => {
    try {
      const customers = await db.withCompanyDb(req.auth!.companyId, tx => listCustomers(tx, req.auth!.companyId));
      return res.json({ companyId: req.auth!.companyId, customers });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/customers', requirePermission('customers:write'), async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || body.idempotencyKey || null;
      const gate = await db.withCompanyDb(req.auth!.companyId, tx =>
        evaluateApprovalGate(tx, req.auth!.companyId, toActor(req), {
          actionType: 'customer',
          entityType: 'customer',
          amount: 0n,
          businessDate: new Date().toISOString().slice(0, 10),
          payload: body,
          approvalRequestId: body.approvalRequestId ? Number(body.approvalRequestId) : null,
          idempotencyKey,
        })
      );
      if (gate.requiresApproval) {
        return res.status(202).json({
          approvalRequired: true,
          approvalRequest: gate.request,
          message: 'Customer master creation requires approval before it is committed.',
        });
      }

      const customer = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const created = await createCustomer(tx, req.auth!.companyId, toActor(req), body);
        if (gate.request) {
          await consumeApprovalRequest(
            tx,
            req.auth!.companyId,
            toActor(req),
            gate.request.id,
            'customer',
            created.id
          );
        }
        return created;
      });
      return res.status(201).json({ customer });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.patch('/customers/:id', requirePermission('customers:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid customer id' });
      const body = req.body || {};
      const actionType =
        body.creditLimit !== undefined
          ? 'credit_limit_change'
          : body.customerStatus === 'active'
          ? 'credit_hold_release'
          : 'customer';
      const gate = await db.withCompanyDb(req.auth!.companyId, tx =>
        evaluateApprovalGate(tx, req.auth!.companyId, toActor(req), {
          actionType,
          entityType: 'customer',
          amount: body.creditLimit !== undefined ? parseDecimal4(body.creditLimit ?? 0) : 0n,
          businessDate: new Date().toISOString().slice(0, 10),
          payload: body,
          approvalRequestId: body.approvalRequestId ? Number(body.approvalRequestId) : null,
          idempotencyKey: body.idempotencyKey || null,
        })
      );
      if (gate.requiresApproval) {
        return res.status(202).json({
          approvalRequired: true,
          approvalRequest: gate.request,
          message: 'Customer master change requires approval before it is committed.',
        });
      }

      const customer = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const updated = await updateCustomer(tx, req.auth!.companyId, toActor(req), id, body);
        if (gate.request) {
          await consumeApprovalRequest(
            tx,
            req.auth!.companyId,
            toActor(req),
            gate.request.id,
            'customer',
            id
          );
        }
        return updated;
      });
      return res.json({ customer });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.get('/customers/:id/credit-profile', requirePermission('customers:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid customer id' });
      const profile = await db.withCompanyDb(req.auth!.companyId, tx =>
        getCustomerCreditProfile(tx, req.auth!.companyId, id)
      );
      return res.json({ profile });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.get('/customers/:id/unapplied-payments', requirePermission('invoices:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid customer id' });
      const payments = await db.withCompanyDb(req.auth!.companyId, tx =>
        listUnappliedPayments(tx, req.auth!.companyId, id)
      );
      return res.json({ payments });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.get('/customers/:id/statements', requirePermission('customers:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid customer id' });
      const statements = await db.withCompanyDb(req.auth!.companyId, tx =>
        listCustomerStatements(tx, req.auth!.companyId, id, Number(req.query.limit) || 25)
      );
      return res.json({ statements });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/customers/:id/statement/send', requirePermission('statements:send'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid customer id' });
      const body = req.body || {};
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        sendCustomerStatement(tx, req.auth!.companyId, toActor(req), {
          customerId: id,
          periodStart: body.periodStart || undefined,
          periodEnd: body.periodEnd || undefined,
          recipient: body.recipient || undefined,
        })
      );
      return res.status(202).json(result);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.get('/customers/:id/statement', requirePermission('customers:read'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid customer id' });
      const statement = await db.withCompanyDb(req.auth!.companyId, tx =>
        generateCustomerStatement(tx, req.auth!.companyId, toActor(req), {
          customerId: id,
          periodStart: req.query.periodStart ? String(req.query.periodStart) : undefined,
          periodEnd: req.query.periodEnd ? String(req.query.periodEnd) : undefined,
          saveSnapshot: req.query.saveSnapshot === 'true',
        })
      );
      return res.json({ statement });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.get('/reseller-permits', requirePermission('customers:read'), async (req: Request, res: Response) => {
    try {
      const customerId = req.query.customerId ? Number(req.query.customerId) : undefined;
      const permits = await db.withCompanyDb(req.auth!.companyId, tx =>
        listResellerPermits(tx, req.auth!.companyId, customerId)
      );
      return res.json({ companyId: req.auth!.companyId, permits });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/reseller-permits', requirePermission('customers:write'), async (req: Request, res: Response) => {
    try {
      const permit = await db.withCompanyDb(req.auth!.companyId, tx =>
        createResellerPermit(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ permit });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  // Invoices & Sales Receipts
  router.get('/invoices', requirePermission('invoices:read'), async (req: Request, res: Response) => {
    try {
      const customerId = req.query.customerId ? Number(req.query.customerId) : undefined;
      const isSalesReceipt =
        req.query.isSalesReceipt === 'true'
          ? true
          : req.query.includeSalesReceipts === 'false' || req.query.isSalesReceipt === 'false'
          ? false
          : undefined;
      const raw = await db.withCompanyDb(req.auth!.companyId, tx =>
        listInvoices(tx, req.auth!.companyId, { customerId, isSalesReceipt })
      );
      // Include snake_case alias invoice_number for security test backwards compatibility
      const invoices = raw.map(inv => ({ ...inv, invoice_number: inv.invoiceNumber }));
      return res.json({ companyId: req.auth!.companyId, invoices });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.get('/invoices/:id', requirePermission('invoices:read'), async (req: Request, res: Response) => {
    try {
      const invoiceId = Number(req.params.id);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        return res.status(400).json({ error: 'Invalid invoice id' });
      }
      const list = await db.withCompanyDb(req.auth!.companyId, tx =>
        listInvoices(tx, req.auth!.companyId)
      );
      const found = list.find(i => i.id === invoiceId);
      if (!found) return res.status(404).json({ error: 'Invoice not found in active company' });
      return res.json({ invoice: { ...found, invoice_number: found.invoiceNumber } });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/invoices', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const lines =
        Array.isArray(body.lines) && body.lines.length > 0
          ? body.lines
          : Number(body.total) > 0
          ? [
              {
                description: String(body.notes || 'Commercial Invoice Charge'),
                quantity: 1,
                rate: body.total,
                unitCost: 0,
                taxable: false,
              },
            ]
          : [];

      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || body.idempotencyKey || null;

      const subtotal4 = sumLineAmounts4(lines);
      const total4 = subtotal4 + computeTax4(subtotal4, parseDecimal6(body.taxRate ?? 0), 'HALF_EVEN');
      const gate = await db.withCompanyDb(req.auth!.companyId, tx =>
        evaluateApprovalGate(tx, req.auth!.companyId, toActor(req), {
          actionType: 'invoice',
          entityType: body.isSalesReceipt ? 'sales_receipt' : 'invoice',
          amount: total4,
          businessDate: body.invoiceDate,
          payload: { ...body, lines },
          approvalRequestId: body.approvalRequestId ? Number(body.approvalRequestId) : null,
          idempotencyKey,
        })
      );
      if (gate.requiresApproval) {
        return res.status(202).json({
          approvalRequired: true,
          approvalRequest: gate.request,
          message: 'Invoice requires maker-checker approval before it can be created.',
        });
      }

      const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const created = await createInvoiceOrSalesReceipt(tx, req.auth!.companyId, toActor(req), {
          ...body,
          lines,
          idempotencyKey,
        });
        if (gate.request) {
          await consumeApprovalRequest(
            tx,
            req.auth!.companyId,
            toActor(req),
            gate.request.id,
            body.isSalesReceipt ? 'sales_receipt' : 'invoice',
            created.invoice.id
          );
        }
        return created;
      });
      return res.status(result.idempotentReplay ? 200 : 201).json({
        invoice: { ...result.invoice, invoice_number: result.invoice.invoiceNumber },
        idempotentReplay: result.idempotentReplay,
      });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.patch('/invoices/:id/notes', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const invoiceId = Number(req.params.id);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        return res.status(400).json({ error: 'Invalid invoice id' });
      }
      const note = String(req.body?.note ?? req.body?.notes ?? '').trim();
      if (!note) return res.status(400).json({ error: 'Note is required' });
      const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const found = await tx.query<{ id: number; notes: string | null }>(
          `SELECT id, notes FROM invoices WHERE company_id = $1 AND id = $2`,
          [req.auth!.companyId, invoiceId]
        );
        if (found.rows.length === 0) return null;
        const existing = found.rows[0].notes || '';
        const updated = existing ? `${existing}\n[${new Date().toISOString()}] ${note}` : `[${new Date().toISOString()}] ${note}`;
        await tx.query(
          `UPDATE invoices SET notes = $1 WHERE company_id = $2 AND id = $3`,
          [updated, req.auth!.companyId, invoiceId]
        );
        await writeAuditLog(tx, {
          companyId: req.auth!.companyId,
          actorUserId: req.auth!.userId ?? null,
          actorUsername: req.auth!.username ?? null,
          action: 'invoice.note',
          tableName: 'invoices',
          recordId: invoiceId,
          newValues: { note },
          source: 'api',
        });
        return { ok: true };
      });
      if (!result) return res.status(404).json({ error: 'Invoice not found in active company' });
      return res.json(result);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/invoices/:id/void', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid invoice id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        voidInvoice(tx, req.auth!.companyId, toActor(req), id, req.body?.reason)
      );
      return res.json(result);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  // Customer Payments
  router.get('/payments', requirePermission('invoices:read'), async (req: Request, res: Response) => {
    try {
      const customerId = req.query.customerId ? Number(req.query.customerId) : undefined;
      const payments = await db.withCompanyDb(req.auth!.companyId, tx =>
        listPayments(tx, req.auth!.companyId, customerId)
      );
      return res.json({ companyId: req.auth!.companyId, payments });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/payments', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const body = req.body || {};
      const amount4 = parseDecimal4(body.amount ?? 0);
      const gate = await db.withCompanyDb(req.auth!.companyId, tx =>
        evaluateApprovalGate(tx, req.auth!.companyId, toActor(req), {
          actionType: 'customer_payment',
          entityType: 'customer_payment',
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
          message: 'Customer payment requires maker-checker approval before posting.',
        });
      }

      const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const created = await recordCustomerPayment(tx, req.auth!.companyId, toActor(req), {
          ...body,
          idempotencyKey,
        });
        if (gate.request) {
          await consumeApprovalRequest(
            tx,
            req.auth!.companyId,
            toActor(req),
            gate.request.id,
            'customer_payment',
            created.payment.id
          );
        }
        return created;
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/payments/:id/allocate', requirePermission('payments:allocate'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid payment id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        applyUnappliedPaymentToInvoice(tx, req.auth!.companyId, toActor(req), id, req.body || {})
      );
      return res.status(201).json(result);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/payments/:id/void', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid payment id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        voidCustomerPayment(tx, req.auth!.companyId, toActor(req), id, req.body?.reason)
      );
      return res.json(result);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  // Credit Memos
  router.get('/credit-memos', requirePermission('invoices:read'), async (req: Request, res: Response) => {
    try {
      const customerId = req.query.customerId ? Number(req.query.customerId) : undefined;
      const creditMemos = await db.withCompanyDb(req.auth!.companyId, tx =>
        listCreditMemos(tx, req.auth!.companyId, customerId)
      );
      return res.json({ companyId: req.auth!.companyId, creditMemos });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/credit-memos', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;
      const body = req.body || {};
      const amount4 = sumLineAmounts4(body.lines);
      const gate = await db.withCompanyDb(req.auth!.companyId, tx =>
        evaluateApprovalGate(tx, req.auth!.companyId, toActor(req), {
          actionType: 'credit_memo',
          entityType: 'credit_memo',
          amount: amount4,
          businessDate: body.creditDate,
          payload: body,
          approvalRequestId: body.approvalRequestId ? Number(body.approvalRequestId) : null,
          idempotencyKey,
        })
      );
      if (gate.requiresApproval) {
        return res.status(202).json({
          approvalRequired: true,
          approvalRequest: gate.request,
          message: 'Credit memo requires maker-checker approval before posting.',
        });
      }

      const result = await db.withCompanyDb(req.auth!.companyId, async tx => {
        const created = await createCreditMemo(tx, req.auth!.companyId, toActor(req), {
          ...body,
          idempotencyKey,
        });
        if (gate.request) {
          await consumeApprovalRequest(
            tx,
            req.auth!.companyId,
            toActor(req),
            gate.request.id,
            'credit_memo',
            created.creditMemo.id
          );
        }
        return created;
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/credit-memos/:id/apply', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid credit memo id' });
      const creditMemo = await db.withCompanyDb(req.auth!.companyId, tx =>
        applyCreditMemoToInvoice(tx, req.auth!.companyId, toActor(req), id, req.body || {})
      );
      return res.json({ creditMemo });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/credit-memos/:id/void', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid credit memo id' });
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        voidCreditMemo(tx, req.auth!.companyId, toActor(req), id, req.body?.reason)
      );
      return res.json(result);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  // Estimates / Quotations (preserves #824 cost/profit redaction)
  router.get('/estimates', requirePermission('estimates:read'), async (req: Request, res: Response) => {
    try {
      const includeCosts = hasPermission(req.auth!.role, 'estimates:read_costs');
      const estimates = await db.withCompanyDb(req.auth!.companyId, tx =>
        listEstimates(tx, req.auth!.companyId, includeCosts)
      );
      return res.json({
        companyId: req.auth!.companyId,
        costDetailsIncluded: includeCosts,
        estimates,
      });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/estimates', requirePermission('estimates:write'), async (req: Request, res: Response) => {
    try {
      const estimate = await db.withCompanyDb(req.auth!.companyId, tx =>
        createEstimate(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ estimate });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/estimates/:id/approve', requirePermission('estimates:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid estimate id' });
      const estimate = await db.withCompanyDb(req.auth!.companyId, tx =>
        approveEstimate(tx, req.auth!.companyId, toActor(req), id, req.body?.note)
      );
      return res.json({ estimate });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/estimates/:id/reject', requirePermission('estimates:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid estimate id' });
      const estimate = await db.withCompanyDb(req.auth!.companyId, tx =>
        rejectEstimate(tx, req.auth!.companyId, toActor(req), id, req.body?.reason)
      );
      return res.json({ estimate });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/estimates/:id/convert', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid estimate id' });
      const auth = req.auth!;
      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null;

      const result = await db.withCompanyDb(auth.companyId, async tx => {
        const estRes = await tx.query<{ total: string }>(
          `SELECT COALESCE(SUM(quantity * rate), 0)::NUMERIC(19,4)::text AS total
             FROM estimate_lines
            WHERE company_id = $1 AND estimate_id = $2`,
          [auth.companyId, id]
        );
        const amount4 = parseDecimal4(estRes.rows[0]?.total ?? 0);
        const gate = await evaluateApprovalGate(tx, auth.companyId, toActor(req), {
          actionType: 'estimate_conversion',
          entityType: 'estimate',
          amount: amount4,
          businessDate: null,
          payload: { estimateId: id },
          approvalRequestId: req.body?.approvalRequestId ? Number(req.body.approvalRequestId) : null,
          idempotencyKey,
        });
        if (gate.requiresApproval) {
          return { gate, converted: null as any };
        }
        const converted = await convertEstimateToInvoice(tx, auth.companyId, toActor(req), id);
        if (gate.request) {
          await consumeApprovalRequest(
            tx,
            auth.companyId,
            toActor(req),
            gate.request.id,
            'invoice',
            converted.invoice.id
          );
        }
        return { gate, converted };
      });

      if (result.gate.requiresApproval) {
        return res.status(202).json({
          approvalRequired: true,
          approvalRequest: result.gate.request,
          message: 'Estimate conversion requires maker-checker approval before invoicing.',
        });
      }
      return res.status(201).json(result.converted);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  // AR Aging
  // FX Revaluation (D-8)
  router.get('/fx-revaluation/preview', requirePermission('fx:revalue'), async (req: Request, res: Response) => {
    try {
      const preview = await db.withCompanyDb(req.auth!.companyId, tx =>
        previewFxRevaluation(tx, req.auth!.companyId, toActor(req), {
          asOfDate: req.query.asOfDate ? String(req.query.asOfDate) : null,
          currencyCode: req.query.currencyCode ? String(req.query.currencyCode) : null,
        })
      );
      return res.json({ preview });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/fx-revaluation', requirePermission('fx:revalue'), async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        postFxRevaluation(tx, req.auth!.companyId, toActor(req), {
          asOfDate: body.asOfDate || null,
          currencyCode: body.currencyCode || null,
        })
      );
      return res.status(201).json(result);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.get('/fx-revaluation/runs', requirePermission('fx:revalue'), async (req: Request, res: Response) => {
    try {
      const runs = await db.withCompanyDb(req.auth!.companyId, tx =>
        listFxRevaluationRuns(tx, req.auth!.companyId, Number(req.query.limit) || 20)
      );
      return res.json({ runs });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.get('/reports/ar-aging', requirePermission('reports:read'), async (req: Request, res: Response) => {
    try {
      const asOfDate = req.query.asOfDate ? String(req.query.asOfDate) : undefined;
      const report = await db.withCompanyDb(req.auth!.companyId, tx =>
        getArAgingReport(tx, req.auth!.companyId, asOfDate)
      );
      return res.json({ report });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  // Recurring Invoices
  router.get('/recurring-invoices', requirePermission('invoices:read'), async (req: Request, res: Response) => {
    try {
      const recurringInvoices = await db.withCompanyDb(req.auth!.companyId, tx =>
        listRecurringInvoices(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, recurringInvoices });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/recurring-invoices', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const recurringInvoice = await db.withCompanyDb(req.auth!.companyId, tx =>
        createRecurringInvoice(tx, req.auth!.companyId, toActor(req), req.body || {})
      );
      return res.status(201).json({ recurringInvoice });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/recurring-invoices/run-due', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const result = await db.withCompanyDb(req.auth!.companyId, tx =>
        runDueRecurringInvoices(tx, req.auth!.companyId, toActor(req), req.body?.asOfDate)
      );
      return res.json(result);
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  // Collections / Reminders & Communications Log
  router.get('/communications', requirePermission('invoices:read'), async (req: Request, res: Response) => {
    try {
      const data = await db.withCompanyDb(req.auth!.companyId, tx =>
        listCommunicationsAndReminders(tx, req.auth!.companyId)
      );
      return res.json({ companyId: req.auth!.companyId, ...data });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  router.post('/invoices/:id/remind', requirePermission('invoices:write'), async (req: Request, res: Response) => {
    try {
      const invoiceId = Number(req.params.id);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) return res.status(400).json({ error: 'Invalid invoice id' });
      const reminder = await db.withCompanyDb(req.auth!.companyId, tx =>
        dispatchInvoiceReminder(tx, req.auth!.companyId, toActor(req), {
          invoiceId,
          ruleId: req.body?.ruleId,
          recipient: req.body?.recipient,
          subject: req.body?.subject,
        })
      );
      return res.status(201).json({ reminder });
    } catch (err) {
      return handleSalesError(res, err);
    }
  });

  return router;
}
