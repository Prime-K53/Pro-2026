import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, type ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { writeAuditLog } from '../audit.ts';

/**
 * Server-side inventory master data and perpetual-inventory adjustments.
 *
 * The browser used to mutate `on_hand` locally and fake the corresponding
 * balance-sheet entry. Both now happen here, inside one transaction, so the
 * stock ledger and the general ledger can never disagree.
 */

export interface AdjustInventoryInput {
  adjustmentQty: string | number;
  reason?: string | null;
  adjustmentDate?: string | null;
  /** Optional counter account for the value of the adjustment. */
  counterAccountId?: number | null;
  unitCost?: string | number | null;
  idempotencyKey?: string | null;
}

function parseQuantity(value: string | number): bigint {
  const scaled = parseDecimal4(value);
  if (scaled === 0n) {
    throw new AccountingError(400, 'Adjustment quantity must not be zero', 'INVALID_ADJUSTMENT_QTY');
  }
  return scaled;
}

function assertIsoDate(value: string | null | undefined, fallback: string): string {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AccountingError(400, 'adjustmentDate must be YYYY-MM-DD', 'INVALID_DATE');
  }
  return raw;
}

/**
 * Resolve the account that absorbs the value of a stock adjustment.
 *
 * A decrease (shrinkage / write-off) is an expense; an increase (found stock /
 * correction) is other income. An explicit `counterAccountId` always wins.
 */
export async function resolveCounterAccountId(
  tx: Transaction,
  companyId: number,
  direction: 1 | -1,
  explicitAccountId?: number | null
): Promise<number> {
  if (explicitAccountId) {
    const acc = await tx.query<{ id: number; account_type: string }>(
      `SELECT id, account_type FROM accounts
        WHERE company_id = $1 AND id = $2 AND is_active = TRUE`,
      [companyId, Number(explicitAccountId)]
    );
    if (acc.rows.length === 0) {
      throw new AccountingError(400, 'Counter account not found in active company', 'COUNTER_ACCOUNT_NOT_FOUND');
    }
    return Number(acc.rows[0].id);
  }

  const preferred =
    direction === -1
      ? `code IN ('5900', '5990', '5910') OR code LIKE '59%'`
      : `code IN ('4900', '4990', '4950') OR code LIKE '49%'`;

  const preferredTypes =
    direction === -1
      ? `account_type IN ('Expense', 'OtherExpense')`
      : `account_type IN ('OtherIncome')`;

  const first = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = TRUE AND (${preferredTypes})
      ORDER BY CASE WHEN ${preferred} THEN 0 ELSE 1 END, code NULLS LAST, id
      LIMIT 1`,
    [companyId]
  );
  if (first.rows.length > 0) return Number(first.rows[0].id);

  const fallback = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = TRUE AND account_type IN ('Expense', 'OtherExpense', 'OtherIncome')
      ORDER BY id LIMIT 1`,
    [companyId]
  );
  if (fallback.rows.length > 0) return Number(fallback.rows[0].id);

  throw new AccountingError(
    400,
    'No counter account is available to record the inventory adjustment. Set up an expense or other-income account first, or pass counterAccountId.',
    'NO_COUNTER_ACCOUNT'
  );
}

export async function adjustInventoryStock(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  itemId: number,
  input: AdjustInventoryInput
) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AccountingError(400, 'Invalid inventory item id', 'INVALID_ITEM_ID');
  }

  const delta4 = parseQuantity(input.adjustmentQty);
  const today = new Date().toISOString().slice(0, 10);
  const adjDate = assertIsoDate(input.adjustmentDate, today);

  const itemRes = await tx.query<{
    id: number;
    sku: string;
    name: string;
    item_type: string;
    unit_cost: string;
    avg_cost: string;
    on_hand: string;
    asset_account_id: number;
  }>(
    `SELECT id, sku, name, item_type, unit_cost::text, avg_cost::text, on_hand::text, asset_account_id
       FROM inventory_items
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, id]
  );
  if (itemRes.rows.length === 0) {
    throw new AccountingError(404, 'Inventory item not found in active company', 'ITEM_NOT_FOUND');
  }
  const item = itemRes.rows[0];

  if (!['raw_material', 'stationery'].includes(item.item_type)) {
    throw new AccountingError(
      400,
      `Only stocked items (raw material or stationery) can be adjusted. "${item.name}" is not a stocked item.`,
      'ITEM_NOT_STOCKED'
    );
  }

  const prevOnHand4 = parseDecimal4(item.on_hand);
  const nextOnHand4 = prevOnHand4 + delta4;
  if (nextOnHand4 < 0n) {
    throw new AccountingError(
      409,
      `Adjustment would take "${item.name}" below zero on hand (current ${item.on_hand})`,
      'NEGATIVE_STOCK'
    );
  }

  // Unit cost: prefer the moving average, fall back to the standard cost.
  const unitCost4 =
    input.unitCost !== undefined && input.unitCost !== null
      ? parseDecimal4(input.unitCost)
      : parseDecimal4(item.avg_cost) || parseDecimal4(item.unit_cost);
  if (unitCost4 < 0n) {
    throw new AccountingError(400, 'Unit cost cannot be negative', 'INVALID_UNIT_COST');
  }

  const value4 = (delta4 * unitCost4) / 10000n; // 4dp quantity × 4dp cost → 4dp value
  if (value4 === 0n) {
    throw new AccountingError(400, 'Adjustment has no monetary value', 'ZERO_VALUE_ADJUSTMENT');
  }

  const direction: 1 | -1 = delta4 > 0n ? 1 : -1;
  const counterAccountId = await resolveCounterAccountId(
    tx,
    companyId,
    direction,
    input.counterAccountId
  );

  const reason = String(input.reason || '').trim() || 'Manual stock adjustment';
  const description = `Inventory adjustment — ${item.sku} ${item.name} (${delta4 > 0n ? '+' : ''}${formatDecimal4(delta4)})`;

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: adjDate,
    description,
    memo: reason,
    reference: item.sku,
    sourceType: 'inventory_adjustment',
    sourceId: id,
    idempotencyKey: input.idempotencyKey || null,
    lines:
      direction === 1
        ? [
            { accountId: Number(item.asset_account_id), debit: formatDecimal4(value4), description },
            { accountId: counterAccountId, credit: formatDecimal4(value4), description: 'Inventory gain (found stock)' },
          ]
        : [
            { accountId: Number(item.asset_account_id), credit: formatDecimal4(value4), description },
            { accountId: counterAccountId, debit: formatDecimal4(value4), description: 'Inventory shrinkage / write-off' },
          ],
  });

  await tx.query(
    `UPDATE inventory_items
        SET on_hand = $3::NUMERIC(19,6),
            avg_cost = CASE WHEN $4 > 0 THEN $5::NUMERIC(19,6) ELSE avg_cost END
      WHERE company_id = $1 AND id = $2`,
    [companyId, id, formatDecimal4(nextOnHand4), unitCost4, formatDecimal4(unitCost4)]
  );

  await tx.query(
    `INSERT INTO inventory_movements (
       company_id, item_id, movement_type, quantity_delta, unit_cost,
       balance_qty, balance_avg_cost, source_type, source_id
     ) VALUES ($1, $2, 'adjustment', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'inventory_adjustment', $7)`,
    [
      companyId,
      id,
      formatDecimal4(delta4),
      formatDecimal4(unitCost4),
      formatDecimal4(nextOnHand4),
      formatDecimal4(unitCost4),
      posted.transaction.id,
    ]
  );

  const adjIns = await tx.query<{ id: number }>(
    `INSERT INTO inventory_adjustments (company_id, adj_date, memo, journal_txn_id, created_by)
     VALUES ($1, $2::DATE, $3, $4, $5)
     RETURNING id`,
    [companyId, adjDate, reason, posted.transaction.id, actor.userId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'INVENTORY_ADJUSTED',
    tableName: 'inventory_items',
    recordId: id,
    newValues: {
      sku: item.sku,
      quantityDelta: formatDecimal4(delta4),
      onHandBefore: item.on_hand,
      onHandAfter: formatDecimal4(nextOnHand4),
      value: formatDecimal4(value4),
      reason,
      journalTransactionId: posted.transaction.id,
    },
  });

  return {
    adjustmentId: Number(adjIns.rows[0].id),
    itemId: id,
    sku: item.sku,
    name: item.name,
    quantityDelta: formatDecimal4(delta4),
    onHandBefore: item.on_hand,
    onHandAfter: formatDecimal4(nextOnHand4),
    unitCost: formatDecimal4(unitCost4),
    value: formatDecimal4(value4),
    counterAccountId,
    journalTransactionId: posted.transaction.id,
    entryNumber: posted.transaction.entryNumber,
    idempotentReplay: posted.idempotentReplay,
  };
}

export interface UpdateInventoryItemInput {
  sku?: string | null;
  name?: string;
  description?: string | null;
  reorderPoint?: string | number | null;
  unitCost?: string | number | null;
  salesPrice?: string | number | null;
  purchaseUnit?: string | null;
  usageUnit?: string | null;
  conversionFactor?: string | number | null;
  barcode?: string | null;
}

export async function updateInventoryItem(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  itemId: number,
  input: UpdateInventoryItemInput
) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AccountingError(400, 'Invalid inventory item id', 'INVALID_ITEM_ID');
  }

  const current = await tx.query<Record<string, any>>(
    `SELECT id, sku, name, description, unit_cost::text, avg_cost::text, sales_price::text,
            reorder_point::text, purchase_unit, usage_unit, conversion_factor::text, item_type
       FROM inventory_items
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, id]
  );
  if (current.rows.length === 0) {
    throw new AccountingError(404, 'Inventory item not found in active company', 'ITEM_NOT_FOUND');
  }
  const item = current.rows[0];

  const name = input.name === undefined ? item.name : String(input.name).trim();
  if (!name) throw new AccountingError(400, 'Item name is required', 'NAME_REQUIRED');

  // SKU is the item's business identifier, so it is renameable but must stay
  // unique within the company (enforced by uq_inventory_items_company_sku_lower).
  const sku =
    input.sku === undefined || input.sku === null ? item.sku : String(input.sku).trim();
  if (!sku) throw new AccountingError(400, 'SKU is required', 'SKU_REQUIRED');
  if (sku.length > 64) {
    throw new AccountingError(400, 'SKU must be 64 characters or fewer', 'INVALID_SKU');
  }
  if (sku.toLowerCase() !== String(item.sku).toLowerCase()) {
    const clash = await tx.query<{ id: number }>(
      `SELECT id FROM inventory_items
        WHERE company_id = $1 AND LOWER(sku) = LOWER($2) AND id <> $3
        LIMIT 1`,
      [companyId, sku, id]
    );
    if (clash.rows.length > 0) {
      throw new AccountingError(
        409,
        `SKU "${sku}" is already used by another item in this company`,
        'DUPLICATE_SKU'
      );
    }
  }

  const description = input.description === undefined ? item.description : input.description;
  const reorderPoint =
    input.reorderPoint === undefined || input.reorderPoint === null
      ? item.reorder_point
      : formatDecimal4(parseDecimal4(input.reorderPoint));
  const unitCost =
    input.unitCost === undefined || input.unitCost === null
      ? item.unit_cost
      : formatDecimal4(parseDecimal4(input.unitCost));
  const salesPrice =
    input.salesPrice === undefined || input.salesPrice === null
      ? item.sales_price
      : formatDecimal4(parseDecimal4(input.salesPrice));
  const purchaseUnit = input.purchaseUnit === undefined ? item.purchase_unit : input.purchaseUnit;
  const usageUnit = input.usageUnit === undefined ? item.usage_unit : input.usageUnit;
  const conversionFactor =
    input.conversionFactor === undefined || input.conversionFactor === null
      ? item.conversion_factor
      : formatDecimal4(parseDecimal4(input.conversionFactor));

  if (parseDecimal4(conversionFactor) <= 0n) {
    throw new AccountingError(400, 'conversionFactor must be greater than zero', 'INVALID_CONVERSION_FACTOR');
  }
  if (item.item_type === 'raw_material' && parseDecimal4(salesPrice) !== 0n) {
    throw new AccountingError(
      400,
      'Raw materials cannot carry a customer selling price',
      'RAW_MATERIAL_NOT_FOR_SALE'
    );
  }

  // Barcode handling
  let barcode: string | null = null;
  if (input.barcode === undefined) {
    barcode = item.barcode;
  } else if (input.barcode === null || input.barcode === '') {
    barcode = null;
  } else {
    barcode = String(input.barcode).trim();
    if (barcode) {
      const barcodeRes = await tx.query<{ id: number }>(
        `SELECT id FROM inventory_items WHERE company_id = $1 AND barcode = $2 AND id <> $3 LIMIT 1`,
        [companyId, barcode, id]
      );
      if (barcodeRes.rows.length > 0) {
        throw new AccountingError(
          409,
          `Barcode "${barcode}" is already used by another item in this company`,
          'DUPLICATE_BARCODE'
        );
      }
    }
  }

  const updated = await tx.query<Record<string, any>>(
    `UPDATE inventory_items
        SET sku = $11,
            name = $3,
            description = $4,
            reorder_point = $5::NUMERIC(19,6),
            unit_cost = $6::NUMERIC(19,6),
            sales_price = $7::NUMERIC(19,4),
            purchase_unit = $8,
            usage_unit = $9,
            conversion_factor = $10::NUMERIC(19,6),
            barcode = $12
      WHERE company_id = $1 AND id = $2
      RETURNING id, sku, name, description, unit_cost::text, avg_cost::text, sales_price::text,
                on_hand::text, reorder_point::text, purchase_unit, usage_unit, conversion_factor::text, barcode`,
    [companyId, id, name, description, reorderPoint, unitCost, salesPrice, purchaseUnit, usageUnit, conversionFactor, sku, barcode]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'INVENTORY_ITEM_UPDATED',
    tableName: 'inventory_items',
    recordId: id,
    oldValues: { sku: item.sku, name: item.name },
    newValues: {
      sku,
      name,
      reorderPoint,
      unitCost,
      salesPrice,
      conversionFactor,
    },
  });

  return updated.rows[0];
}

