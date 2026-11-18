import type { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';

/**
 * Read models for inventory.
 *
 * Every function here is read-only: it issues SELECTs inside the caller's
 * `db.withCompanyDb` transaction and returns plain JSON-safe rows. Nothing in
 * this module writes, so it cannot desynchronise the perpetual stock ledger
 * from the general ledger.
 *
 * Monetary and quantity columns are cast to ::text and re-emitted through
 * formatDecimal4 so the browser receives exact fixed-point strings instead of
 * IEEE-754 rounded numbers. The schema has no floating-point columns and the
 * migration suite asserts that, so the UI must never reintroduce float math.
 */

const STOCKED_TYPES = ['raw_material', 'stationery'];
const VALUED_TYPES = ['raw_material', 'stationery', 'printed_product'];

function toId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AccountingError(400, `Invalid ${label}`, `INVALID_${label.toUpperCase()}`);
  }
  return id;
}

function paging(limit: unknown, offset: unknown): { limit: number; offset: number } {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  return { limit: lim, offset: off };
}

async function requireItem(
  tx: Transaction,
  companyId: number,
  itemId: number
): Promise<Record<string, any>> {
  const res = await tx.query(
    `SELECT id, company_id, sku, name, item_type, description,
            unit_cost::text  AS unit_cost,
            avg_cost::text   AS avg_cost,
            sales_price::text AS sales_price,
            on_hand::text    AS on_hand,
            COALESCE(reserved_qty, 0)::text AS reserved_qty,
            reorder_point::text AS reorder_point,
            purchase_unit, usage_unit,
            conversion_factor::text AS conversion_factor,
            location, is_active, is_taxable,
            asset_account_id, cogs_account_id, income_account_id,
            paper_spec_id
       FROM inventory_items
      WHERE company_id = $1 AND id = $2`,
    [companyId, itemId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Inventory item not found in active company', 'ITEM_NOT_FOUND');
  }
  return res.rows[0] as Record<string, any>;
}

/**
 * Single item plus its variants, BOM components and current valuation.
 * `unitCost` is the standard/purchase cost; `avgCost` is the moving average
 * that the server uses as the valuation basis. Do not conflate them.
 */
export async function getInventoryItemDetail(
  tx: Transaction,
  companyId: number,
  itemId: number
) {
  const id = toId(itemId, 'inventory item id');
  const item = await requireItem(tx, companyId, id);

  const variants = await tx.query(
    `SELECT id, variant_name, sku,
            unit_cost::text  AS unit_cost,
            sales_price::text AS sales_price,
            on_hand::text    AS on_hand,
            COALESCE(reserved_qty, 0)::text AS reserved_qty,
            reorder_point::text AS reorder_point,
            is_active
       FROM item_variants
      WHERE company_id = $1 AND item_id = $2
      ORDER BY variant_name ASC, id ASC`,
    [companyId, id]
  );

  const bom = await tx.query(
    `SELECT b.id,
            b.parent_variant_id,
            b.raw_material_item_id,
            b.quantity_per_unit::text AS quantity_per_unit,
            b.notes,
            r.sku    AS raw_material_sku,
            r.name   AS raw_material_name,
            r.usage_unit AS raw_material_usage_unit,
            r.conversion_factor::text AS raw_material_conversion_factor,
            r.avg_cost::text AS raw_material_avg_cost,
            r.unit_cost::text AS raw_material_unit_cost,
            r.on_hand::text AS raw_material_on_hand
       FROM item_bom_components b
       JOIN inventory_items r
         ON r.company_id = b.company_id AND r.id = b.raw_material_item_id
      WHERE b.company_id = $1 AND b.parent_item_id = $2
      ORDER BY r.name ASC, b.id ASC`,
    [companyId, id]
  );

  // BOM-driven unit cost: Σ (raw avg_cost / conversion_factor) × qty_per_unit.
  // Mirrors calcBomUnitCost on the client but sourced from the server ledger.
  let bomUnitCost4 = 0n;
  for (const row of bom.rows as Array<Record<string, any>>) {
    const avgCost4 = parseDecimal4(row.raw_material_avg_cost);
    const qty4 = parseDecimal4(row.quantity_per_unit);
    bomUnitCost4 += (avgCost4 * qty4) / 10000n;
  }

  const onHand4 = parseDecimal4(item.on_hand);
  const avgCost4 = parseDecimal4(item.avg_cost);
  const valuation4 = (onHand4 * avgCost4) / 10000n;

  const lastMovement = await tx.query(
    `SELECT movement_at, movement_type, quantity_delta::text AS quantity_delta,
            balance_qty::text AS balance_qty,
            balance_avg_cost::text AS balance_avg_cost,
            unit_cost::text AS unit_cost
       FROM inventory_movements
      WHERE company_id = $1 AND item_id = $2
      ORDER BY movement_at DESC, id DESC
      LIMIT 1`,
    [companyId, id]
  );

  return {
    item: {
      ...item,
      on_hand: formatDecimal4(onHand4),
      avg_cost: formatDecimal4(avgCost4),
      valuation: formatDecimal4(valuation4),
      is_stocked: STOCKED_TYPES.includes(String(item.item_type)),
      is_valued: VALUED_TYPES.includes(String(item.item_type)),
      bom_unit_cost: formatDecimal4(bomUnitCost4),
    },
    variants: variants.rows,
    bom: bom.rows,
    lastMovement: lastMovement.rows[0] ?? null,
  };
}

/**
 * Raw stock movement history, newest first, paginated. This is the audit
 * stream written by sales, purchasing, production and adjustment services.
 */
export async function listInventoryMovements(
  tx: Transaction,
  companyId: number,
  itemId: number,
  params: { limit?: unknown; offset?: unknown; movementType?: string | null } = {}
) {
  const id = toId(itemId, 'inventory item id');
  const { limit, offset } = paging(params.limit, params.offset);
  const movementType = String(params.movementType || '').trim();

  const clauses = ['company_id = $1', 'item_id = $2'];
  const values: unknown[] = [companyId, id];
  if (movementType) {
    values.push(movementType);
    clauses.push(`movement_type = $${values.length}`);
  }

  const rows = await tx.query(
    `SELECT id, variant_id, movement_at, movement_type,
            quantity_delta::text AS quantity_delta,
            unit_cost::text     AS unit_cost,
            balance_qty::text   AS balance_qty,
            balance_avg_cost::text AS balance_avg_cost,
            source_type, source_id, reverses_movement_id
       FROM inventory_movements
      WHERE ${clauses.join(' AND ')}
      ORDER BY movement_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    values
  );

  const countRes = await tx.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM inventory_movements WHERE ${clauses.join(' AND ')}`,
    values
  );

  return { movements: rows.rows, total: Number(countRes.rows[0].cnt), limit, offset };
}

/**
 * Running-balance ledger. The movements table already stores balance_qty and
 * balance_avg_cost per row, so the ledger is read oldest-first and exposes
 * those stored balances rather than recomputing them. Recomputing in the
 * browser would risk float drift and would disagree with the stored audit row.
 */
export async function getInventoryLedger(
  tx: Transaction,
  companyId: number,
  itemId: number
) {
  const id = toId(itemId, 'inventory item id');
  const item = await requireItem(tx, companyId, id);

  const rows = await tx.query(
    `SELECT id, movement_at, movement_type, variant_id,
            quantity_delta::text AS quantity_delta,
            unit_cost::text     AS unit_cost,
            balance_qty::text   AS balance_qty,
            balance_avg_cost::text AS balance_avg_cost,
            source_type, source_id
       FROM inventory_movements
      WHERE company_id = $1 AND item_id = $2
      ORDER BY movement_at ASC, id ASC`,
    [companyId, id]
  );

  let receipts = 0n;
  let issues = 0n;
  const ledger = (rows.rows as Array<Record<string, any>>).map(row => {
    const delta4 = parseDecimal4(row.quantity_delta);
    if (delta4 >= 0n) receipts += delta4;
    else issues += -delta4;
    return {
      ...row,
      direction: delta4 >= 0n ? 'in' : 'out',
    };
  });

  return {
    item: {
      id: item.id,
      sku: item.sku,
      name: item.name,
      item_type: item.item_type,
      on_hand: formatDecimal4(parseDecimal4(item.on_hand)),
      avg_cost: formatDecimal4(parseDecimal4(item.avg_cost)),
    },
    ledger: ledger.slice(-200),
    summary: {
      movementCount: ledger.length,
      totalReceipts: formatDecimal4(receipts),
      totalIssues: formatDecimal4(issues),
      netMovement: formatDecimal4(receipts - issues),
    },
  };
}

/** BOM components for an item (read-only; the trigger enforces raw-material parents). */
export async function getBom(tx: Transaction, companyId: number, itemId: number) {
  const id = toId(itemId, 'inventory item id');
  await requireItem(tx, companyId, id);

  const rows = await tx.query(
    `SELECT b.id,
            b.parent_variant_id,
            b.raw_material_item_id,
            b.quantity_per_unit::text AS quantity_per_unit,
            b.notes,
            r.sku  AS raw_material_sku,
            r.name AS raw_material_name,
            r.usage_unit AS raw_material_usage_unit,
            r.purchase_unit AS raw_material_purchase_unit,
            r.conversion_factor::text AS raw_material_conversion_factor,
            r.avg_cost::text AS raw_material_avg_cost,
            r.unit_cost::text AS raw_material_unit_cost,
            r.on_hand::text AS raw_material_on_hand,
            r.reorder_point::text AS raw_material_reorder_point
       FROM item_bom_components b
       JOIN inventory_items r
         ON r.company_id = b.company_id AND r.id = b.raw_material_item_id
      WHERE b.company_id = $1 AND b.parent_item_id = $2
      ORDER BY r.name ASC, b.id ASC`,
    [companyId, id]
  );

  // Per-line extended cost at the moving average, and the rolled-up unit cost.
  let unitCost4 = 0n;
  const components = (rows.rows as Array<Record<string, any>>).map(row => {
    const avgCost4 = parseDecimal4(row.raw_material_avg_cost);
    const qty4 = parseDecimal4(row.quantity_per_unit);
    const extended4 = (avgCost4 * qty4) / 10000n;
    unitCost4 += extended4;
    return {
      ...row,
      extended_unit_cost: formatDecimal4(extended4),
    };
  });

  return { components, computedUnitCost: formatDecimal4(unitCost4) };
}

/**
 * Actual material consumption for an item, aggregated across printing jobs.
 * Uses issued/actual/waste/returned quantities so the caller can see both the
 * good output and the spoilage without a second query.
 */
export async function getMaterialConsumption(
  tx: Transaction,
  companyId: number,
  itemId: number
) {
  const id = toId(itemId, 'inventory item id');
  await requireItem(tx, companyId, id);

  const rows = await tx.query(
    `SELECT m.id,
            m.printing_job_id,
            j.job_number,
            j.status AS job_status,
            m.material_role,
            m.usage_unit,
            m.planned_usage_qty::text AS planned_usage_qty,
            m.issued_usage_qty::text  AS issued_usage_qty,
            m.actual_good_usage_qty::text AS actual_good_usage_qty,
            m.waste_usage_qty::text  AS waste_usage_qty,
            m.returned_usage_qty::text AS returned_usage_qty,
            m.reserved_usage_qty::text AS reserved_usage_qty,
            m.issued_avg_unit_cost::text AS issued_avg_unit_cost,
            m.planned_total_cost::text AS planned_total_cost,
            m.waste_reason
       FROM job_material_requirements m
       JOIN printing_jobs j
         ON j.company_id = m.company_id AND j.id = m.printing_job_id
      WHERE m.company_id = $1 AND m.raw_material_item_id = $2
      ORDER BY m.printing_job_id DESC, m.id DESC`,
    [companyId, id]
  );

  let issued = 0n;
  let good = 0n;
  let waste = 0n;
  let returned = 0n;
  let issuedValue4 = 0n;
  let wasteValue4 = 0n;

  for (const row of rows.rows as Array<Record<string, any>>) {
    issued += parseDecimal4(row.issued_usage_qty);
    good += parseDecimal4(row.actual_good_usage_qty);
    waste += parseDecimal4(row.waste_usage_qty);
    returned += parseDecimal4(row.returned_usage_qty);
    const unit4 = parseDecimal4(row.issued_avg_unit_cost);
    issuedValue4 += (parseDecimal4(row.issued_usage_qty) * unit4) / 10000n;
    wasteValue4 += (parseDecimal4(row.waste_usage_qty) * unit4) / 10000n;
  }

  return {
    jobs: rows.rows,
    summary: {
      jobCount: (rows.rows as unknown[]).length,
      totalIssued: formatDecimal4(issued),
      totalGood: formatDecimal4(good),
      totalWaste: formatDecimal4(waste),
      totalReturned: formatDecimal4(returned),
      wasteValue: formatDecimal4(wasteValue4),
      issuedValue: formatDecimal4(issuedValue4),
      wastePct: issued > 0n ? `${((Number(waste) / Number(issued)) * 100).toFixed(2)}%` : '0.00%',
    },
  };
}

/**
 * Journal transactions that touched this item (source_type =
 * 'inventory_adjustment' and source_id = item id), plus damage and count
 * postings once those write paths are used.
 */
export async function getInventoryTransactions(
  tx: Transaction,
  companyId: number,
  itemId: number
) {
  const id = toId(itemId, 'inventory item id');
  await requireItem(tx, companyId, id);

  const rows = await tx.query(
    `SELECT t.id, t.entry_number, t.txn_date, t.description, t.reference,
            t.source_type, t.source_id, t.is_adjusting, t.created_at
       FROM journal_transactions t
      WHERE t.company_id = $1
        AND ( (t.source_type = 'inventory_adjustment' AND t.source_id = $2)
              OR t.id IN (
                   SELECT d.journal_txn_id FROM stock_damages d
                    WHERE d.company_id = $1 AND d.item_id = $2 AND d.journal_txn_id IS NOT NULL
                   UNION
                   SELECT c.journal_txn_id FROM stock_counts c
                    WHERE c.company_id = $1 AND c.journal_txn_id IS NOT NULL
                      AND EXISTS (SELECT 1 FROM stock_count_lines l
                                   WHERE l.company_id = c.company_id AND l.count_id = c.id
                                     AND l.item_id = $2)
              ) )
      ORDER BY t.txn_date DESC, t.id DESC`,
    [companyId, id]
  );

  const damages = await tx.query(
    `SELECT id, damage_date, quantity::text AS quantity,
            unit_cost::text AS unit_cost, value::text AS value,
            reason_code, reason, journal_txn_id
       FROM stock_damages
      WHERE company_id = $1 AND item_id = $2
      ORDER BY damage_date DESC, id DESC`,
    [companyId, id]
  );

  return { transactions: rows.rows, damages: damages.rows };
}

/** Every stocked item with its reorder position and shortfall. */
export async function getReorderLevels(tx: Transaction, companyId: number) {
  const rows = await tx.query(
    `SELECT i.id, i.sku, i.name, i.item_type, i.purchase_unit, i.usage_unit,
            i.on_hand::text      AS on_hand,
            COALESCE(i.reserved_qty, 0)::text AS reserved_qty,
            i.reorder_point::text AS reorder_point,
            i.avg_cost::text      AS avg_cost,
            i.location,
            COALESCE((
              SELECT SUM(v.on_hand)
                FROM item_variants v
               WHERE v.company_id = i.company_id AND v.item_id = i.id AND v.is_active = TRUE
            ), 0)::text AS variant_on_hand
       FROM inventory_items i
      WHERE i.company_id = $1
        AND i.is_active = TRUE
        AND i.item_type = ANY($2::text[])
      ORDER BY i.name ASC, i.id ASC`,
    [companyId, STOCKED_TYPES]
  );

  const items = (rows.rows as Array<Record<string, any>>).map(row => {
    const onHand4 = parseDecimal4(row.on_hand);
    const reserved4 = parseDecimal4(row.reserved_qty);
    const reorder4 = parseDecimal4(row.reorder_point);
    const available4 = onHand4 - reserved4;
    const shortfall4 = reorder4 > available4 ? reorder4 - available4 : 0n;
    return {
      ...row,
      available: formatDecimal4(available4),
      shortfall: formatDecimal4(shortfall4),
      needsReorder: shortfall4 > 0n,
      reorderStatus:
        onHand4 <= 0n
          ? 'out_of_stock'
          : shortfall4 > 0n
          ? 'below_reorder'
          : 'healthy',
    };
  });

  return {
    items,
    summary: {
      total: items.length,
      belowReorder: items.filter(i => i.needsReorder).length,
      outOfStock: items.filter(i => i.reorderStatus === 'out_of_stock').length,
    },
  };
}

/**
 * Item-level supplier history: which vendors billed this SKU, at what unit
 * cost, and when. Joins bill lines to bills and vendors.
 */
export async function getSupplierHistory(
  tx: Transaction,
  companyId: number,
  itemId: number
) {
  const id = toId(itemId, 'inventory item id');
  await requireItem(tx, companyId, id);

  const rows = await tx.query(
    `SELECT v.id   AS vendor_id,
            v.company_name AS vendor_name,
            b.id   AS bill_id,
            b.bill_number,
            b.bill_date,
            b.status AS bill_status,
            bl.quantity::text  AS quantity,
            bl.unit_cost::text AS unit_cost,
            bl.amount::text    AS line_amount
       FROM bill_lines bl
       JOIN bills b   ON b.company_id = bl.company_id AND b.id = bl.bill_id
       JOIN vendors v ON v.company_id = bl.company_id AND v.id = b.vendor_id
      WHERE bl.company_id = $1 AND bl.item_id = $2
      ORDER BY b.bill_date DESC, b.id DESC`,
    [companyId, id]
  );

  const byVendor = new Map<string, { vendorId: any; vendorName: any; orders: number; quantity: bigint; value: bigint; lastDate: any }>();
  for (const row of rows.rows as Array<Record<string, any>>) {
    const key = String(row.vendor_id);
    const qty4 = parseDecimal4(row.quantity);
    const value4 = parseDecimal4(row.line_amount);
    const existing = byVendor.get(key);
    if (existing) {
      existing.orders += 1;
      existing.quantity += qty4;
      existing.value += value4;
    } else {
      byVendor.set(key, {
        vendorId: row.vendor_id,
        vendorName: row.vendor_name,
        orders: 1,
        quantity: qty4,
        value: value4,
        lastDate: row.bill_date,
      });
    }
  }

  return {
    purchases: rows.rows,
    vendors: Array.from(byVendor.values())
      .sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1))
      .map(v => ({
        vendorId: v.vendorId,
        vendorName: v.vendorName,
        orders: v.orders,
        totalQuantity: formatDecimal4(v.quantity),
        totalValue: formatDecimal4(v.value),
        lastPurchaseDate: v.lastDate,
      })),
  };
}