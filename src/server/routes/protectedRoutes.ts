import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, Request, Response, NextFunction } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { hasPermission } from '../permissions.ts';
import { writeAuditLog } from '../audit.ts';
import { AccountingError, type ActorContext } from '../services/accountingEngine.ts';
import {
  adjustInventoryStock,
  updateInventoryItem,
} from '../services/inventoryService.ts';
import {
  getBom,
  getInventoryItemDetail,
  getInventoryLedger,
  getInventoryTransactions,
  getMaterialConsumption,
  getReorderLevels,
  getSupplierHistory,
  listInventoryMovements,
} from '../services/inventoryReadService.ts';
import {
  createStockCount,
  deactivateInventoryItem,
  postStockCount,
  recordStockDamage,
  transferStock,
} from '../services/inventoryOpsService.ts';
import { runPayroll, listPayslips } from '../services/payrollService.ts';

function toActor(req: Request): ActorContext {
  const auth = req.auth!;
  return { userId: auth.userId, username: auth.username, role: auth.role };
}

function handleProtectedError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const message = err instanceof Error ? err.message : 'Unexpected server error';
  return res.status(500).json({ error: message });
}

export function createProtectedBusinessRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  // Every route below enforces session auth + cross-company parameter guard + role RBAC + PostgreSQL RLS!
  router.use(requireAuth, csrfProtection, rejectCrossCompanyParams);

  // Inventory Catalog (Isolated & RBAC)
  router.get('/inventory', requirePermission('inventory:read'), async (req: Request, res: Response) => {
    const auth = req.auth!;
    const rows = await db.withCompanyDb(auth.companyId, async tx => {
      const r = await tx.query(
        `SELECT id, company_id, sku, name, item_type, description,
                unit_cost::text, avg_cost::text, sales_price::text,
                on_hand::text, COALESCE(reserved_qty, 0)::text AS reserved_qty,
                reorder_point::text, purchase_unit, usage_unit, conversion_factor::text,
                paper_spec_id
           FROM inventory_items
          WHERE is_active = TRUE
          ORDER BY id ASC`
      );
      return r.rows;
    });
    return res.json({ companyId: auth.companyId, items: rows });
  });

  router.post('/inventory', requirePermission('inventory:write'), async (req: Request, res: Response) => {
    const auth = req.auth!;
    const b = req.body || {};
    const sku = String(b.sku || '').trim();
    const name = String(b.name || '').trim();
    const itemType = String(b.itemType || 'raw_material');
    if (!sku || !name) return res.status(400).json({ error: 'sku and name are required' });
    if (!['raw_material', 'printed_product', 'stationery', 'printing_service'].includes(itemType)) {
      return res.status(400).json({ error: `Invalid itemType '${itemType}'` });
    }
    try {
      const item = await db.withCompanyDb(auth.companyId, async tx => {
        const accts = await tx.query<{ id: number; code: string | null; account_type: string }>(
          `SELECT id, code, account_type FROM accounts WHERE company_id = $1 AND is_active = TRUE`,
          [auth.companyId]
        );
        const byCode = new Map<string, number>();
        const byType = new Map<string, number>();
        for (const a of accts.rows) {
          if (a.code) byCode.set(a.code, Number(a.id));
          if (!byType.has(a.account_type)) byType.set(a.account_type, Number(a.id));
        }
        const assetAcct = Number(b.assetAccountId || byCode.get('1200') || byType.get('Inventory'));
        const cogsAcct = Number(b.cogsAccountId || byCode.get('5000') || byType.get('CostOfGoodsSold'));
        const incomeAcct = Number(b.incomeAccountId || byCode.get('4000') || byType.get('Income'));

        let paperSpecId: number | null = b.paperSpecId ? Number(b.paperSpecId) : null;
        if (b.paperSpec && !paperSpecId) {
          const ps = b.paperSpec;
          const psIns = await tx.query<{ id: number }>(
            `INSERT INTO paper_specifications (
               company_id, spec_code, name, size_code, width_mm, height_mm, gsm, finish, grain_direction,
               sheets_per_ream, measured_caliper_mm, sheets_per_pack
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
            [
              auth.companyId,
              String(ps.specCode || `${sku}-SPEC`),
              String(ps.name || name),
              ps.sizeCode || 'A4',
              Number(ps.widthMm || 210),
              Number(ps.heightMm || 297),
              Number(ps.gsm || 80),
              ps.finish || 'uncoated',
              ps.grainDirection || 'long',
              Number(ps.sheetsPerReam || b.conversionFactor || 500),
              ps.measuredCaliperMm != null ? Number(ps.measuredCaliperMm) : null,
              ps.sheetsPerPack != null ? Number(ps.sheetsPerPack) : null,
            ]
          );
          paperSpecId = Number(psIns.rows[0].id);
        }

        const ins = await tx.query<any>(
          `INSERT INTO inventory_items (
             company_id, sku, name, item_type, description, unit_cost, avg_cost, sales_price,
             on_hand, reorder_point, purchase_unit, usage_unit, conversion_factor, paper_spec_id,
             asset_account_id, cogs_account_id, income_account_id
           ) VALUES (
             $1, $2, $3, $4, $5, $6::NUMERIC(19,6), $7::NUMERIC(19,6), $8::NUMERIC(19,4),
             $9::NUMERIC(19,6), $10::NUMERIC(19,6), $11, $12, $13::NUMERIC(19,6), $14,
             $15, $16, $17
           ) RETURNING id, company_id, sku, name, item_type, unit_cost::text, avg_cost::text, sales_price::text, on_hand::text, purchase_unit, usage_unit, conversion_factor::text, paper_spec_id`,
          [
            auth.companyId,
            sku,
            name,
            itemType,
            b.description || null,
            Number(b.unitCost ?? 0),
            Number(b.avgCost ?? b.unitCost ?? 0),
            itemType === 'raw_material' ? 0 : Number(b.salesPrice ?? 0),
            ['printed_product', 'printing_service'].includes(itemType) ? 0 : Number(b.onHand ?? 0),
            Number(b.reorderPoint ?? 0),
            b.purchaseUnit || 'Unit',
            b.usageUnit || 'Unit',
            Number(b.conversionFactor ?? 1),
            paperSpecId,
            assetAcct,
            cogsAcct,
            incomeAcct,
          ]
        );
        const created = ins.rows[0];
        if (b.materialSpec) {
          const ms = b.materialSpec;
          await tx.query(
            `INSERT INTO material_specifications (
               company_id, inventory_item_id, material_category, yield_per_purchase_unit, coverage_basis_pct,
               color_channel, cartridge_toner_mass_grams
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              auth.companyId,
              Number(created.id),
              ms.materialCategory || 'toner',
              ms.yieldPerPurchaseUnit ?? null,
              ms.coverageBasisPct ?? 5,
              ms.colorChannel || 'K',
              ms.cartridgeTonerMassGrams != null ? Number(ms.cartridgeTonerMassGrams) : null,
            ]
          );
        }
        return created;
      });
      return res.status(201).json({ item });
    } catch (err: any) {
      if (err?.code === '23505') return res.status(409).json({ error: `SKU '${sku}' already exists` });
      return res.status(500).json({ error: err?.message || 'Failed to create inventory item' });
    }
  });

  // Update inventory item master data (costs, reorder point, conversion, naming).
  router.patch('/inventory/:id', requirePermission('inventory:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid inventory item id' });
      const item = await db.withCompanyDb(auth.companyId, tx =>
        updateInventoryItem(tx, auth.companyId, toActor(req), id, req.body || {})
      );
      return res.json({ item });
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Perpetual-inventory stock adjustment. Updates on_hand, writes the movement
  // ledger row and posts the matching general-ledger entry in one transaction.
  router.post('/inventory/:id/adjust', requirePermission('inventory:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid inventory item id' });
      const result = await db.withCompanyDb(auth.companyId, tx =>
        adjustInventoryStock(tx, auth.companyId, toActor(req), id, {
          adjustmentQty: req.body?.adjustmentQty ?? req.body?.quantity ?? 0,
          reason: req.body?.reason ?? null,
          adjustmentDate: req.body?.adjustmentDate ?? req.body?.date ?? null,
          counterAccountId: req.body?.counterAccountId ?? null,
          unitCost: req.body?.unitCost ?? null,
          idempotencyKey:
            (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null,
          approvalRequestId: req.body?.approvalRequestId ?? null,
        })
      );
      if (result.approvalRequired) {
        return res.status(202).json({
          approvalRequired: true,
          approvalRequest: result.approvalRequest,
          message:
            'This inventory write-off requires approval before it is committed. An approver must approve the request, then re-submit with the approvalRequestId.',
        });
      }
      return res.status(201).json({ adjustment: result });
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // --- Inventory read models (advanced operations) -----------------------------
  // All read-only. Each returns exact fixed-point strings (::text -> decimal4)
  // so the browser never re-derives a monetary figure from a float.

  // NOTE: the static /inventory/reorder-levels path MUST be registered before
  // the dynamic /inventory/:id routes, otherwise Express matches "reorder-levels"
  // as an :id and the request 400s.

  // Company-wide reorder levels and shortfall summary.
  router.get('/inventory/reorder-levels', requirePermission('inventory:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const levels = await db.withCompanyDb(auth.companyId, tx =>
        getReorderLevels(tx, auth.companyId)
      );
      return res.json(levels);
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Item detail: master record + variants + BOM components + valuation.
  router.get('/inventory/:id', requirePermission('inventory:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      // Non-numeric ids (e.g. /inventory/valuation) belong to another router.
      if (!Number.isInteger(id) || id <= 0) return next();
      const detail = await db.withCompanyDb(auth.companyId, tx =>
        getInventoryItemDetail(tx, auth.companyId, id)
      );
      return res.json(detail);
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Raw movement audit stream, newest first, paginated.
  router.get('/inventory/:id/movements', requirePermission('inventory:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid inventory item id' });
      const result = await db.withCompanyDb(auth.companyId, tx =>
        listInventoryMovements(tx, auth.companyId, id, {
          limit: req.query.limit,
          offset: req.query.offset,
          movementType: req.query.movementType as string | undefined,
        })
      );
      return res.json(result);
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Running-balance stock ledger using the stored balance_qty/balance_avg_cost.
  router.get('/inventory/:id/ledger', requirePermission('inventory:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid inventory item id' });
      const ledger = await db.withCompanyDb(auth.companyId, tx =>
        getInventoryLedger(tx, auth.companyId, id)
      );
      return res.json(ledger);
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Bill of materials for an item, with rolled-up unit cost at moving average.
  router.get('/inventory/:id/bom', requirePermission('inventory:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid inventory item id' });
      const bom = await db.withCompanyDb(auth.companyId, tx =>
        getBom(tx, auth.companyId, id)
      );
      return res.json(bom);
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Actual material consumption across printing jobs.
  router.get('/inventory/:id/consumption', requirePermission('inventory:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid inventory item id' });
      const consumption = await db.withCompanyDb(auth.companyId, tx =>
        getMaterialConsumption(tx, auth.companyId, id)
      );
      return res.json(consumption);
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Journal transactions + damage register tied to this item.
  router.get('/inventory/:id/transactions', requirePermission('inventory:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid inventory item id' });
      const transactions = await db.withCompanyDb(auth.companyId, tx =>
        getInventoryTransactions(tx, auth.companyId, id)
      );
      return res.json(transactions);
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Supplier/purchase history for this item, aggregated per vendor.
  router.get('/inventory/:id/supplier-history', requirePermission('inventory:read'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid inventory item id' });
      const history = await db.withCompanyDb(auth.companyId, tx =>
        getSupplierHistory(tx, auth.companyId, id)
      );
      return res.json(history);
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // --- Inventory advanced write operations ------------------------------------
  // Each is gated by its own permission so a role can read the catalog and
  // adjust quantities without being able to move stock between locations.

  // Damage / spoilage write-off. Decrements stock and posts the expense.
  router.post('/inventory/:id/damage', requirePermission('inventory:damage'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid inventory item id' });
      const result = await db.withCompanyDb(auth.companyId, tx =>
        recordStockDamage(tx, auth.companyId, toActor(req), id, {
          quantity: req.body?.quantity ?? 0,
          reason: req.body?.reason ?? null,
          reasonCode: req.body?.reasonCode ?? null,
          damageDate: req.body?.damageDate ?? req.body?.date ?? null,
          counterAccountId: req.body?.counterAccountId ?? null,
          unitCost: req.body?.unitCost ?? null,
          idempotencyKey:
            (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null,
        })
      );
      return res.status(201).json({ damage: result });
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Deactivate an item (only when it has no stock and no historical references).
  router.post('/inventory/:id/deactivate', requirePermission('inventory:deactivate'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid inventory item id' });
      const result = await db.withCompanyDb(auth.companyId, tx =>
        deactivateInventoryItem(tx, auth.companyId, toActor(req), id)
      );
      return res.json({ item: result });
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Internal stock transfer between storage locations (stock- and GL-neutral).
  router.post('/inventory/transfer', requirePermission('inventory:transfer'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const result = await db.withCompanyDb(auth.companyId, tx =>
        transferStock(tx, auth.companyId, toActor(req), {
          fromLocation: req.body?.fromLocation ?? null,
          toLocation: req.body?.toLocation ?? null,
          transferDate: req.body?.transferDate ?? req.body?.date ?? null,
          notes: req.body?.notes ?? null,
          lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
        })
      );
      return res.status(201).json({ transfer: result });
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Physical stock counts. POST creates a draft, then /:id/post applies it.
  router.post('/stock-counts', requirePermission('inventory:count'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const result = await db.withCompanyDb(auth.companyId, tx =>
        createStockCount(tx, auth.companyId, toActor(req), {
          countDate: req.body?.countDate ?? req.body?.date ?? null,
          notes: req.body?.notes ?? null,
          lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
        })
      );
      return res.status(201).json({ stockCount: result });
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  router.post('/stock-counts/:id/post', requirePermission('inventory:count'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid stock count id' });
      const result = await db.withCompanyDb(auth.companyId, tx =>
        postStockCount(tx, auth.companyId, toActor(req), id, {
          counterAccountId: req.body?.counterAccountId ?? null,
          notes: req.body?.notes ?? null,
          idempotencyKey:
            (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null,
        })
      );
      return res.status(201).json({ stockCount: result });
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // 5. Employees (Sensitive fields redacted for Bookkeeper & Read-Only; completely blocked for Accountant & ProductionManager)
  router.get('/employees', requirePermission('employees:read'), async (req: Request, res: Response) => {
    const auth = req.auth!;
    const includeSensitive = hasPermission(auth.role, 'employees:read_sensitive');
    const employees = await db.withCompanyDb(auth.companyId, async tx => {
      const r = await tx.query<{
        id: number;
        first_name: string;
        last_name: string;
        job_title: string | null;
        department: string | null;
        email: string | null;
        ssn_last4_masked: string | null;
        hire_date: string | null;
        pay_type: string;
        pay_rate: string;
        pay_frequency: string;
      }>(
        `SELECT id, first_name, last_name, job_title, department, email,
                ssn_last4_masked, hire_date::text AS hire_date, pay_type, pay_rate::text, pay_frequency
           FROM employees
          WHERE is_active = TRUE
          ORDER BY id ASC`
      );
      return r.rows.map(e => {
        const pub = {
          id: Number(e.id),
          firstName: e.first_name,
          lastName: e.last_name,
          jobTitle: e.job_title,
          department: e.department,
          email: e.email,
          hireDate: e.hire_date ? String(e.hire_date).slice(0, 10) : null,
        };
        if (!includeSensitive) return pub;
        return {
          ...pub,
          ssnMasked: e.ssn_last4_masked,
          payType: e.pay_type,
          payRate: e.pay_rate,
          payFrequency: e.pay_frequency,
        };
      });
    });

    return res.json({ companyId: auth.companyId, sensitiveHrIncluded: includeSensitive, employees });
  });

  // Create an employee record (server-owned HR directory).
  router.post('/employees', requirePermission('employees:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const b = req.body || {};
      const firstName = String(b.firstName || b.first_name || '').trim();
      const lastName = String(b.lastName || b.last_name || '').trim();
      if (!firstName || !lastName) {
        return res.status(400).json({ error: 'firstName and lastName are required' });
      }
      const payType = String(b.payType || b.pay_type || 'hourly');
      if (!['hourly', 'salary'].includes(payType)) {
        return res.status(400).json({ error: `Invalid payType '${payType}'` });
      }
      const payFrequency = String(b.payFrequency || b.pay_frequency || 'biweekly');
      if (!['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(payFrequency)) {
        return res.status(400).json({ error: `Invalid payFrequency '${payFrequency}'` });
      }
      const filingStatus = String(b.filingStatus || b.filing_status || 'single');
      if (!['single', 'married', 'head_of_household'].includes(filingStatus)) {
        return res.status(400).json({ error: `Invalid filingStatus '${filingStatus}'` });
      }
      const hireDate = String(b.hireDate || b.hire_date || new Date().toISOString().slice(0, 10));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) {
        return res.status(400).json({ error: 'hireDate must be YYYY-MM-DD' });
      }

      const employee = await db.withCompanyDb(auth.companyId, async tx => {
        const ins = await tx.query<{ id: number }>(
          `INSERT INTO employees (
             company_id, first_name, last_name, job_title, department, email, phone,
             ssn_last4_masked, hire_date, pay_type, pay_rate, pay_frequency,
             filing_status, w4_allowances
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::DATE, $10, $11::NUMERIC(19,4),
                     $12, $13, $14::SMALLINT)
           RETURNING id`,
          [
            auth.companyId,
            firstName,
            lastName,
            b.jobTitle || b.job_title || null,
            b.department || null,
            b.email || null,
            b.phone || null,
            b.ssnLast4Masked || b.ssn_last4_masked || null,
            hireDate,
            payType,
            Number(b.payRate ?? b.pay_rate ?? 0),
            payFrequency,
            filingStatus,
            Number(b.w4Allowances ?? b.w4_allowances ?? 0),
          ]
        );
        const employeeId = Number(ins.rows[0].id);
        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'EMPLOYEE_CREATED',
          tableName: 'employees',
          recordId: employeeId,
          newValues: { firstName, lastName, payType, payFrequency, hireDate },
        });
        return { id: employeeId, firstName, lastName };
      });

      return res.status(201).json({ employee });
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // Execute a payroll run: recompute amounts server-side and post the journal.
  router.post('/payroll/runs', requirePermission('payroll:write'), async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const result = await db.withCompanyDb(auth.companyId, tx =>
        runPayroll(tx, auth.companyId, toActor(req), {
          payPeriodStart: req.body?.payPeriodStart,
          payPeriodEnd: req.body?.payPeriodEnd,
          payDate: req.body?.payDate,
          bankAccountId: Number(req.body?.bankAccountId),
          items: Array.isArray(req.body?.items) ? req.body.items : [],
          idempotencyKey:
            (req.headers['idempotency-key'] as string | undefined) || req.body?.idempotencyKey || null,
        })
      );
      return res.status(201).json({ run: result });
    } catch (err) {
      return handleProtectedError(res, err);
    }
  });

  // 6. Payroll Runs (Administrator ONLY)
  router.get('/payroll/runs', requirePermission('payroll:read'), async (req: Request, res: Response) => {
    const auth = req.auth!;
    const runs = await db.withCompanyDb(auth.companyId, async tx => {
      const r = await tx.query<{
        id: number;
        run_number: string;
        pay_period_start: string;
        pay_period_end: string;
        pay_date: string;
        total_gross: string;
        total_net: string;
        total_employee_taxes: string;
        total_employer_taxes: string;
        status: string;
        journal_txn_id: number | null;
        entry_number: string | null;
        item_count: number;
      }>(
        `SELECT pr.id, pr.run_number,
                pr.pay_period_start::text AS pay_period_start,
                pr.pay_period_end::text   AS pay_period_end,
                pr.pay_date::text         AS pay_date,
                pr.total_gross::text      AS total_gross,
                pr.total_net::text        AS total_net,
                pr.total_employee_taxes::text AS total_employee_taxes,
                pr.total_employer_taxes::text AS total_employer_taxes,
                pr.status, pr.journal_txn_id, jt.entry_number,
                (SELECT COUNT(*) FROM pay_stubs ps
                  WHERE ps.company_id = pr.company_id AND ps.pay_run_id = pr.id)::int AS item_count
           FROM pay_runs pr
           LEFT JOIN journal_transactions jt
             ON jt.company_id = pr.company_id AND jt.id = pr.journal_txn_id
          ORDER BY pr.pay_date DESC`
      );
      const out: any[] = [];
      for (const row of r.rows) {
        const payslips = await listPayslips(tx, auth.companyId, Number(row.id));
        out.push({ ...row, items: payslips });
      }
      return out;
    });
    return res.json({ companyId: auth.companyId, runs });
  });

  // 7. Financial Reports & Audited Exports (Strictly isolated via RLS)
  router.get('/reports/financial', requirePermission('reports:read'), async (req: Request, res: Response) => {
    const auth = req.auth!;
    const summary = await db.withCompanyDb(auth.companyId, async tx => {
      const invTotals = await tx.query<{
        invoice_count: string;
        total_revenue: string;
        total_receivable: string;
        total_cost: string;
      }>(
        `SELECT COUNT(*)::text AS invoice_count,
                COALESCE(SUM(subtotal), 0)::NUMERIC(19,4)::text AS total_revenue,
                COALESCE(SUM(balance_due), 0)::NUMERIC(19,4)::text AS total_receivable,
                COALESCE(SUM(total_cost), 0)::NUMERIC(19,4)::text AS total_cost
           FROM invoices
          WHERE status <> 'voided'`
      );
      const acctCount = await tx.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM accounts`);
      return {
        ...invTotals.rows[0],
        accountCount: Number(acctCount.rows[0].cnt),
      };
    });

    return res.json({
      companyId: auth.companyId,
      companyName: auth.companyName,
      generatedBy: auth.username,
      summary,
    });
  });

  router.get('/reports/export', requirePermission('reports:export'), async (req: Request, res: Response) => {
    const auth = req.auth!;
    const data = await db.withCompanyDb(auth.companyId, async tx => {
      const invoices = await tx.query<{
        invoice_number: string;
        invoice_date: string;
        status: string;
        subtotal: string;
        tax_amount: string;
        total: string;
        balance_due: string;
      }>(
        `SELECT invoice_number, invoice_date::text, status, subtotal::text,
                tax_amount::text, total::text, balance_due::text
           FROM invoices
          ORDER BY id ASC`
      );
      await writeAuditLog(tx, {
        companyId: auth.companyId,
        actorUserId: auth.userId,
        actorUsername: auth.username,
        action: 'REPORT_EXPORTED',
        tableName: 'invoices',
        recordId: auth.companyId,
        newValues: { format: 'csv', rowCount: invoices.rows.length },
      });
      return invoices.rows;
    });

    const csvLines = [
      'invoice_number,invoice_date,status,subtotal,tax_amount,total,balance_due',
      ...data.map(
        r => `${r.invoice_number},${r.invoice_date},${r.status},${r.subtotal},${r.tax_amount},${r.total},${r.balance_due}`
      ),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="company-${auth.companyId}-ledger-export.csv"`);
    return res.send(csvLines.join('\n'));
  });

  // 8. Protected Company-Isolated Attachments (Upload & IDOR-safe Download)
  router.post('/attachments', requirePermission('attachments:write'), async (req: Request, res: Response) => {
    const auth = req.auth!;
    const originalName = path.basename(String(req.body?.fileName || 'document.txt')).slice(0, 200);
    const contentType = String(req.body?.contentType || 'text/plain').slice(0, 100);
    const entityType = String(req.body?.entityType || 'invoice').slice(0, 60);
    const entityId = Number(req.body?.entityId || 1);
    const contentBase64 = String(req.body?.contentBase64 || '');
    const contentText = req.body?.contentText !== undefined ? String(req.body.contentText) : null;
    const notes = req.body?.notes ? String(req.body.notes).slice(0, 1000) : null;

    const buffer =
      contentText !== null
        ? Buffer.from(contentText, 'utf8')
        : Buffer.from(contentBase64, 'base64');

    if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Attachment content must be between 1 byte and 5MB' });
    }

    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const storageKey = `company_${auth.companyId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const companyDir = path.join(db.config.attachmentsDir, `company_${auth.companyId}`);
    fs.mkdirSync(companyDir, { recursive: true });
    fs.writeFileSync(path.join(companyDir, path.basename(storageKey)), buffer);

    const record = await db.withCompanyDb(auth.companyId, async tx => {
      const fRes = await tx.query<{ id: number }>(
        `INSERT INTO stored_files (
           company_id, storage_kind, original_name, content_type, size_bytes, sha256_hex, storage_key, created_by
         ) VALUES ($1, 'local', $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [auth.companyId, originalName, contentType, buffer.length, sha, storageKey, auth.userId]
      );
      const fileId = Number(fRes.rows[0].id);

      const attRes = await tx.query<{ id: number }>(
        `INSERT INTO attachments (company_id, stored_file_id, entity_type, entity_id, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [auth.companyId, fileId, entityType, entityId, notes]
      );
      await writeAuditLog(tx, {
        companyId: auth.companyId,
        actorUserId: auth.userId,
        actorUsername: auth.username,
        action: 'ATTACHMENT_UPLOADED',
        tableName: 'attachments',
        recordId: Number(attRes.rows[0].id),
        newValues: { originalName, entityType, entityId, sizeBytes: buffer.length, notes },
      });

      return { attachmentId: Number(attRes.rows[0].id), fileId, originalName, sha256: sha, notes };
    });

    return res.status(201).json({ attachment: record });
  });

  router.get(
    '/attachments/:id/download',
    requirePermission('attachments:read'),
    async (req: Request, res: Response) => {
      const auth = req.auth!;
      const attachmentId = Number(req.params.id);
      if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
        return res.status(400).json({ error: 'Invalid attachment id' });
      }

      const fileRow = await db.withCompanyDb(auth.companyId, async tx => {
        const r = await tx.query<{
          id: number;
          company_id: number;
          original_name: string;
          content_type: string;
          storage_key: string;
        }>(
          `SELECT a.id, a.company_id, f.original_name, f.content_type, f.storage_key
             FROM attachments a
             JOIN stored_files f ON f.company_id = a.company_id AND f.id = a.stored_file_id
            WHERE a.id = $1
            LIMIT 1`,
          [attachmentId]
        );
        return r.rows[0] || null;
      });

      if (!fileRow) {
        return res.status(404).json({ error: 'Attachment not found in active company' });
      }

      const filePath = path.join(
        db.config.attachmentsDir,
        `company_${auth.companyId}`,
        path.basename(fileRow.storage_key)
      );
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Attachment payload missing from company vault' });
      }

      res.setHeader('Content-Type', fileRow.content_type);
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(fileRow.original_name)}"`);
      return res.send(fs.readFileSync(filePath));
    }
  );

  return router;
}
