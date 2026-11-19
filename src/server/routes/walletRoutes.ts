import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { AccountingError, ActorContext } from '../services/accountingEngine.ts';
import { parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import {
  allocateWalletFunds,
  applyWalletToInvoice,
  getWalletStatement,
  recordWalletDeposit,
  reconcileWallet,
  refundWallet,
  setWalletStatus,
} from '../services/customerWalletService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleWalletError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  console.error('Unhandled wallet route error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}

function walletIdFromReq(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AccountingError(400, 'Invalid wallet id', 'INVALID_WALLET_ID');
  }
  return id;
}

function idempotencyKeyFromReq(req: Request): string | null {
  const header = req.headers['idempotency-key'];
  const key = (Array.isArray(header) ? header[0] : header) || req.body?.idempotencyKey || null;
  return key ? String(key).trim().slice(0, 128) : null;
}

export function createWalletRouter(_db: ServerDatabase, _rateLimits?: unknown, _logger?: unknown): Router {
  const router = Router();
  const db = _db;
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  router.use(requireAuth, rejectCrossCompanyParams);

  async function assertWalletBelongsToCustomer(
    companyId: number,
    walletId: number,
    customerId: number
  ): Promise<void> {
    await db.withCompanyDb(companyId, async tx => {
      const res = await tx.query<{ customer_id: number }>(
        `SELECT customer_id FROM customer_wallets WHERE company_id = $1 AND id = $2 LIMIT 1`,
        [companyId, walletId]
      );
      if (res.rows.length === 0) {
        throw new AccountingError(404, 'Customer wallet not found', 'WALLET_NOT_FOUND');
      }
      if (Number(res.rows[0].customer_id) !== Number(customerId)) {
        throw new AccountingError(400, 'Wallet does not belong to the customer', 'WALLET_CUSTOMER_MISMATCH');
      }
    });
  }

  // GET /api/wallets
  router.get('/wallets', requirePermission('wallet:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const customerId = req.query.customerId ? Number(req.query.customerId) : null;
      const wallets = await db.withCompanyDb(auth.companyId, async tx => {
        const result = await tx.query<any>(
          `SELECT id, customer_id, currency_code, liability_account_id,
                  balance::text AS balance, status, version
             FROM customer_wallets
            WHERE company_id = $1
              AND ($2::BIGINT IS NULL OR customer_id = $2)
            ORDER BY id ASC`,
          [auth.companyId, customerId]
        );
        return result.rows.map((r: any) => ({
          id: Number(r.id),
          customerId: Number(r.customer_id),
          currencyCode: String(r.currency_code),
          liabilityAccountId: Number(r.liability_account_id),
          balance: toMoneyNumber(parseDecimal4(String(r.balance))),
          status: String(r.status),
          version: Number(r.version),
        }));
      });
      return res.json({ wallets });
    } catch (err) {
      return handleWalletError(res, err);
    }
  });

  // GET /api/wallets/:id
  router.get('/wallets/:id', requirePermission('wallet:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const walletId = walletIdFromReq(req);
      const statement = await db.withCompanyDb(auth.companyId, tx => getWalletStatement(tx, auth.companyId, walletId));
      return res.json(statement);
    } catch (err) {
      return handleWalletError(res, err);
    }
  });

  // GET /api/wallets/:id/transactions
  router.get('/wallets/:id/transactions', requirePermission('wallet:transactions:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const walletId = walletIdFromReq(req);
      const statement = await db.withCompanyDb(auth.companyId, tx => getWalletStatement(tx, auth.companyId, walletId));
      return res.json({ walletId, transactions: statement.transactions, closingBalance: statement.closingBalance });
    } catch (err) {
      return handleWalletError(res, err);
    }
  });

  // GET /api/wallets/:id/reconciliation
  router.get('/wallets/:id/reconciliation', requirePermission('wallet:reconcile'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const walletId = walletIdFromReq(req);
      const items = await db.withCompanyDb(auth.companyId, tx => reconcileWallet(tx, auth.companyId, walletId));
      return res.json({ items });
    } catch (err) {
      return handleWalletError(res, err);
    }
  });

  // POST /api/wallets/:id/deposits
  router.post('/wallets/:id/deposits', requirePermission('wallet:deposit'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const walletId = walletIdFromReq(req);
      const body = req.body || {};
      const customerId = Number(body.customerId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        throw new AccountingError(400, 'customerId is required', 'CUSTOMER_REQUIRED');
      }
      await assertWalletBelongsToCustomer(auth.companyId, walletId, customerId);

      const result = await db.withCompanyDb(auth.companyId, tx =>
        recordWalletDeposit(tx, auth.companyId, toActor(req), {
          customerId,
          amount: body.amount,
          bankAccountId: Number(body.bankAccountId),
          currencyCode: body.currencyCode ?? null,
          txnDate: body.txnDate ?? undefined,
          referenceNumber: body.referenceNumber ?? null,
          memo: body.memo ?? null,
          idempotencyKey: idempotencyKeyFromReq(req),
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleWalletError(res, err);
    }
  });

  // POST /api/wallets/:id/allocations
  router.post('/wallets/:id/allocations', requirePermission('wallet:allocate'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const walletId = walletIdFromReq(req);
      const body = req.body || {};
      const customerId = Number(body.customerId);
      const contractId = Number(body.contractId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        throw new AccountingError(400, 'customerId is required', 'CUSTOMER_REQUIRED');
      }
      if (!Number.isInteger(contractId) || contractId <= 0) {
        throw new AccountingError(400, 'contractId is required', 'CONTRACT_REQUIRED');
      }
      await assertWalletBelongsToCustomer(auth.companyId, walletId, customerId);

      const result = await db.withCompanyDb(auth.companyId, tx =>
        allocateWalletFunds(tx, auth.companyId, toActor(req), {
          customerId,
          walletId,
          contractId,
          amount: body.amount,
          currencyCode: body.currencyCode ?? null,
          idempotencyKey: idempotencyKeyFromReq(req),
          notes: body.notes ?? null,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleWalletError(res, err);
    }
  });

  // POST /api/wallets/:id/payments
  router.post('/wallets/:id/payments', requirePermission('wallet:apply'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const walletId = walletIdFromReq(req);
      const body = req.body || {};
      const customerId = Number(body.customerId);
      const invoiceId = Number(body.invoiceId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        throw new AccountingError(400, 'customerId is required', 'CUSTOMER_REQUIRED');
      }
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        throw new AccountingError(400, 'invoiceId is required', 'INVOICE_REQUIRED');
      }
      await assertWalletBelongsToCustomer(auth.companyId, walletId, customerId);

      const result = await db.withCompanyDb(auth.companyId, tx =>
        applyWalletToInvoice(tx, auth.companyId, toActor(req), {
          customerId,
          invoiceId,
          amount: body.amount,
          walletId,
          txnDate: body.txnDate ?? undefined,
          idempotencyKey: idempotencyKeyFromReq(req),
          memo: body.memo ?? null,
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleWalletError(res, err);
    }
  });

  // POST /api/wallets/:id/refunds
  router.post('/wallets/:id/refunds', requirePermission('wallet:refund'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const walletId = walletIdFromReq(req);
      const body = req.body || {};
      const customerId = Number(body.customerId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        throw new AccountingError(400, 'customerId is required', 'CUSTOMER_REQUIRED');
      }
      await assertWalletBelongsToCustomer(auth.companyId, walletId, customerId);

      const result = await db.withCompanyDb(auth.companyId, tx =>
        refundWallet(tx, auth.companyId, toActor(req), {
          customerId,
          walletId,
          amount: body.amount,
          bankAccountId: Number(body.bankAccountId),
          txnDate: body.txnDate ?? undefined,
          referenceNumber: body.referenceNumber ?? null,
          memo: body.memo ?? null,
          idempotencyKey: idempotencyKeyFromReq(req),
        })
      );
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      return handleWalletError(res, err);
    }
  });

  // PATCH /api/wallets/:id/status
  router.patch('/wallets/:id/status', requirePermission('wallet:configure'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const walletId = walletIdFromReq(req);
      const body = req.body || {};
      const status = String(body.status || '');
      if (!['active', 'frozen', 'closed'].includes(status)) {
        throw new AccountingError(400, 'Invalid wallet status', 'INVALID_WALLET_STATUS');
      }
      await db.withCompanyDb(auth.companyId, tx =>
        setWalletStatus(tx, auth.companyId, toActor(req), {
          walletId,
          status: status as 'active' | 'frozen' | 'closed',
          reason: body.reason ?? null,
        })
      );
      return res.json({ ok: true });
    } catch (err) {
      return handleWalletError(res, err);
    }
  });

  return router;
}