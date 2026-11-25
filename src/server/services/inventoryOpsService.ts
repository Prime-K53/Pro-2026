import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, reverseJournalEntry, type ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { writeAuditLog } from '../audit.ts';
import { resolveCounterAccountId } from './inventoryService.ts';

/**
 * Server-side advanced inventory operations: damage write-offs, internal
 * location transfers, physical stock counts and item deactivation.
 *
 * Every function runs inside the caller's `db.withCompanyDb` transaction, so a
 * stock movement and its general-ledger entry commit or roll back together.
 *
 * Financial safety rules honoured here:
 *   * `inventory_items.on_hand` is the one authoritative company-wide quantity.
 *     Location balances must sum to it; `assertLocationBalancesReconcile`
 *     re-checks that invariant before COMMIT.
 *   * All arithmetic uses exact 4-decimal scaled BigInts. No float is ever used
 *     for a quantity or a monetary value.
 *   * A posted stock count or transfer is immutable; re-posting is rejected.
 */

const STOCKED_TYPES = ['raw_material', 'stationery'];
const DEFAULT_LOCATION = 'Main';

function parseQty(value: unknown, label: string): bigint {
  const scaled = parseDecimal4(value as string | number);
  if (scaled < 0n) {
    throw new AccountingError(400, `${label} cannot be negative`, 'NEGATIVE_QUANTITY');
  }
  return scaled;
}

function assertIsoDate(value: string | null | undefined, fallback: string): string {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AccountingError(400, 'date must be YYYY-MM-DD', 'INVALID_DATE');
  }
  return raw;
}

/**
 * Normalise a DATE value returned by the driver to a strict YYYY-MM-DD string.
 *
 * PGlite hands DATE columns back as strings but the exact shape depends on the
 * driver build, so anything that is not already ISO is parsed rather than
 * sliced — slicing a Date's toString() yields "Tue Nov 18" which fails the
 * journal validator later with a confusing message.
 */
function toIsoDate(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function normaliseLocation(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (raw.length > 120) {
    throw new AccountingError(400, 'Location must be 120 characters or fewer', 'INVALID_LOCATION');
  }
  return raw;
}

/**
 * Guard for the on_hand = SUM(location balances) invariant.
 * Rows with no stock_balances record are treated as sitting entirely at the
 * default location, which is how items created before 0018 are seeded.
 */
async function assertLocationBalancesReconcile(
  tx: Transaction,
  companyId: number,
  itemId: number,
  expectedOnHand4: bigint,
  sku: string
) {
  const res = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(qty), 0)::text AS total
       FROM stock_balances
      WHERE company_id = $1 AND item_id = $2 AND COALESCE(variant_id, 0) = 0`,
    [companyId, itemId]
  );
  const total4 = parseDecimal4(res.rows[0].total);
  if (total4 !== expectedOnHand4) {
    throw new AccountingError(
      409,
      `Location balances for ${sku} (${formatDecimal4(total4)}) no longer match on_hand (${formatDecimal4(expectedOnHand4)})`,
      'LOCATION_BALANCE_MISMATCH'
    );
  }
}

/**
 * Generate a human-readable document number for a stock document.
 *
 * The company row is locked for the duration so concurrent requests in the same
 * company serialise on the sequence, then the count-based candidate is probed
 * for collisions (a deleted document would otherwise reuse a number).
 */
async function generateDocNumber(
  tx: Transaction,
  companyId: number,
  table: 'stock_transfers' | 'stock_counts',
  column: 'transfer_number' | 'count_number',
  prefix: string
): Promise<string> {
  await tx.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [companyId]);

  const countRes = await tx.query<{ next_seq: string }>(
    `SELECT (COUNT(*) + 1)::text AS next_seq FROM ${table} WHERE company_id = $1`,
    [companyId]
  );
  const start = Number(countRes.rows[0].next_seq) || 1;

  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = `${prefix}-${String(start + attempt).padStart(5, '0')}`;
    const clash = await tx.query<{ id: number }>(
      `SELECT id FROM ${table} WHERE company_id = $1 AND ${column} = $2 LIMIT 1`,
      [companyId, candidate]
    );
    if (clash.rows.length === 0) return candidate;
  }

  throw new AccountingError(
    409,
    `Could not allocate a unique ${prefix} number. Please retry.`,
    'DOC_NUMBER_EXHAUSTED'
  );
}

async function requireStockedItem(
  tx: Transaction,
  companyId: number,
  itemId: number,
  { forUpdate = true }: { forUpdate?: boolean } = {}
): Promise<Record<string, any>> {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AccountingError(400, 'Invalid inventory item id', 'INVALID_ITEM_ID');
  }
  const res = await tx.query(
    `SELECT id, company_id, sku, name, item_type, is_active,
            unit_cost::text  AS unit_cost,
            avg_cost::text   AS avg_cost,
            on_hand::text    AS on_hand,
            COALESCE(reserved_qty, 0)::text AS reserved_qty,
            asset_account_id, location
       FROM inventory_items
      WHERE company_id = $1 AND id = $2
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [companyId, id]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Inventory item not found in active company', 'ITEM_NOT_FOUND');
  }
  const item = res.rows[0] as Record<string, any>;
  if (!STOCKED_TYPES.includes(String(item.item_type))) {
    throw new AccountingError(
      400,
      `Only stocked items (raw material or stationery) can be affected. "${item.name}" is not a stocked item.`,
      'ITEM_NOT_STOCKED'
    );
  }
  return item;
}

/* ---------------------------------------------------------------------------
   Damage / write-off
   --------------------------------------------------------------------------- */

export interface RecordDamageInput {
  quantity: string | number;
  reason?: string | null;
  reasonCode?: string | null;
  damageDate?: string | null;
  counterAccountId?: number | null;
  unitCost?: string | number | null;
  idempotencyKey?: string | null;
  jobReference?: string | null;
  scrapType?: string | null;
}

/**
 * Writes off damaged stock. Decrements on_hand, records a `damage` movement and
 * posts the write-off to the configured shrinkage/expense account.
 */
export async function recordStockDamage(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  itemId: number,
  input: RecordDamageInput
) {
  const item = await requireStockedItem(tx, companyId, itemId);
  const qty4 = parseQty(input.quantity, 'Damage quantity');
  if (qty4 === 0n) {
    throw new AccountingError(400, 'Damage quantity must be greater than zero', 'INVALID_DAMAGE_QTY');
  }

  const today = new Date().toISOString().slice(0, 10);
  const damageDate = assertIsoDate(input.damageDate, today);

  const prevOnHand4 = parseDecimal4(item.on_hand);
  const reserved4 = parseDecimal4(item.reserved_qty);
  const nextOnHand4 = prevOnHand4 - qty4;
  if (nextOnHand4 < 0n) {
    throw new AccountingError(
      409,
      `Damage would take "${item.name}" below zero on hand (current ${item.on_hand})`,
      'NEGATIVE_STOCK'
    );
  }
  if (qty4 + reserved4 > prevOnHand4) {
    throw new AccountingError(
      409,
      `Damage would consume reserved stock for "${item.name}" (on hand ${item.on_hand}, reserved ${item.reserved_qty})`,
      'RESERVED_STOCK_CONFLICT'
    );
  }

  const unitCost4 =
    input.unitCost !== undefined && input.unitCost !== null
      ? parseDecimal4(input.unitCost)
      : parseDecimal4(item.avg_cost) || parseDecimal4(item.unit_cost);
  if (unitCost4 < 0n) {
    throw new AccountingError(400, 'Unit cost cannot be negative', 'INVALID_UNIT_COST');
  }

  const value4 = (qty4 * unitCost4) / 10000n;
  if (value4 === 0n) {
    throw new AccountingError(400, 'Damage has no monetary value', 'ZERO_VALUE_DAMAGE');
  }

  const counterAccountId = await resolveCounterAccountId(tx, companyId, -1, input.counterAccountId);
  const reason = String(input.reason || '').trim() || 'Damaged stock write-off';
  const reasonCode = String(input.reasonCode || 'damaged').trim() || 'damaged';
  const description = `Stock damage — ${item.sku} ${item.name} (${formatDecimal4(qty4)})`;

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: damageDate,
    description,
    memo: reason,
    reference: item.sku,
    sourceType: 'inventory_damage',
    sourceId: Number(item.id),
    idempotencyKey: input.idempotencyKey || null,
    lines: [
      { accountId: Number(item.asset_account_id), credit: formatDecimal4(value4), description },
      { accountId: counterAccountId, debit: formatDecimal4(value4), description: 'Stock damage write-off' },
    ],
  });

  await tx.query(
    `UPDATE inventory_items
        SET on_hand = $3::NUMERIC(19,6)
      WHERE company_id = $1 AND id = $2`,
    [companyId, item.id, formatDecimal4(nextOnHand4)]
  );

  const dmgLocation = normaliseLocation((item as any).location, DEFAULT_LOCATION);
  const balRes = await tx.query<{ id: number; qty: string }>(
    `SELECT id, qty::text AS qty FROM stock_balances
      WHERE company_id = $1 AND item_id = $2 AND COALESCE(variant_id, 0) = 0 AND lower(location) = lower($3)
      FOR UPDATE`,
    [companyId, item.id, dmgLocation]
  );
  if (balRes.rows.length === 0) {
    // Legacy: no balance row; create one reflecting remaining on-hand at default location
    await tx.query(
      `INSERT INTO stock_balances (company_id, item_id, variant_id, location, qty)
       VALUES ($1, $2, NULL, $3, $4::NUMERIC(19,6))`,
      [companyId, item.id, dmgLocation, formatDecimal4(nextOnHand4)]
    );
  } else {
    const balQty4 = parseDecimal4(balRes.rows[0].qty);
    const nextBal4 = balQty4 - qty4;
    if (nextBal4 < 0n) {
      throw new AccountingError(409, `Damage exceeds stock at ${dmgLocation} for "${item.name}"`, 'INSUFFICIENT_LOCATION_STOCK');
    }
    await tx.query(
      `UPDATE stock_balances SET qty = $3::NUMERIC(19,6), updated_at = NOW() WHERE company_id = $1 AND id = $2`,
      [companyId, balRes.rows[0].id, formatDecimal4(nextBal4)]
    );
  }

  await tx.query(
    `INSERT INTO inventory_movements (
       company_id, item_id, movement_type, quantity_delta, unit_cost,
       balance_qty, balance_avg_cost, source_type, source_id, location
     ) VALUES ($1, $2, 'damage', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'stock_damage', $7, $8)`,
    [
      companyId,
      item.id,
      formatDecimal4(-qty4),
      formatDecimal4(unitCost4),
      formatDecimal4(nextOnHand4),
      formatDecimal4(unitCost4),
      posted.transaction.id,
      dmgLocation,
    ]
  );

  const dmgIns = await tx.query<{ id: number }>(
    `INSERT INTO stock_damages (
       company_id, item_id, damage_date, quantity, unit_cost, reason_code, reason,
       journal_txn_id, created_by, job_reference, scrap_type
     ) VALUES ($1, $2, $3::DATE, $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      companyId,
      item.id,
      damageDate,
      formatDecimal4(qty4),
      formatDecimal4(unitCost4),
      reasonCode,
      reason,
      posted.transaction.id,
      actor.userId,
      input.jobReference ? String(input.jobReference).trim() : null,
      input.scrapType ? String(input.scrapType).trim() : 'scrap',
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'INVENTORY_DAMAGED',
    tableName: 'stock_damages',
    recordId: Number(dmgIns.rows[0].id),
    newValues: {
      itemId: Number(item.id),
      sku: item.sku,
      quantity: formatDecimal4(qty4),
      value: formatDecimal4(value4),
      reasonCode,
      reason,
      onHandBefore: item.on_hand,
      onHandAfter: formatDecimal4(nextOnHand4),
      journalTransactionId: posted.transaction.id,
    },
  });

  await assertLocationBalancesReconcile(tx, companyId, Number(item.id), nextOnHand4, String(item.sku));

  return {
    damageId: Number(dmgIns.rows[0].id),
    itemId: Number(item.id),
    sku: item.sku,
    name: item.name,
    quantity: formatDecimal4(qty4),
    unitCost: formatDecimal4(unitCost4),
    value: formatDecimal4(value4),
    onHandBefore: item.on_hand,
    onHandAfter: formatDecimal4(nextOnHand4),
    reasonCode,
    journalTransactionId: posted.transaction.id,
    entryNumber: posted.transaction.entryNumber,
    idempotentReplay: posted.idempotentReplay,
  };
}

/* ---------------------------------------------------------------------------
   Internal stock transfer
   --------------------------------------------------------------------------- */

export interface TransferStockInput {
  fromLocation?: string | null;
  toLocation?: string | null;
  transferDate?: string | null;
  notes?: string | null;
  transferMode?: 'direct' | 'two_step';
  lines: Array<{ itemId: number; quantity: string | number; variantId?: number | null; lotId?: number | null }>;
}

/**
 * Moves stock between two storage locations.
 *
 * A transfer is stock-neutral for the company (on_hand is unchanged) and
 * GL-neutral (two mirrored movements at the same avg_cost net to zero), so no
 * journal is posted. Only the per-location balances and the movement ledger
 * change, which keeps the perpetual inventory internally consistent.
 */
export async function transferStock(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: TransferStockInput
) {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'A transfer requires at least one line', 'NO_TRANSFER_LINES');
  }

  const fromLocation = normaliseLocation(input.fromLocation, DEFAULT_LOCATION);
  const toLocation = normaliseLocation(input.toLocation, 'Secondary');
  if (fromLocation.toLowerCase() === toLocation.toLowerCase()) {
    throw new AccountingError(400, 'Source and destination locations must differ', 'SAME_LOCATION');
  }

  const today = new Date().toISOString().slice(0, 10);
  const transferDate = assertIsoDate(input.transferDate, today);
  const transferMode = input.transferMode === 'two_step' ? 'two_step' : 'direct';
  const transitLocation = `IN_TRANSIT::${toLocation}`;

  const transferNumber = await generateDocNumber(tx, companyId, 'stock_transfers', 'transfer_number', 'TRF');
  const transferIns = await tx.query<{ id: number }>(
    `INSERT INTO stock_transfers (
       company_id, transfer_number, transfer_date, from_location, to_location, notes, created_by, transfer_mode, status, dispatched_at
     ) VALUES ($1, $2, $3::DATE, $4, $5, $6, $7, $8, $9, CASE WHEN $8 = 'two_step' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [companyId, transferNumber, transferDate, fromLocation, toLocation, input.notes || null, actor.userId, transferMode, transferMode === 'two_step' ? 'in_transit' : 'draft']
  );
  const transferId = Number(transferIns.rows[0].id);

  let inTransitAccountId: number | null = null;
  if (transferMode === 'two_step') {
    const inTransitRes = await tx.query<{ id: number }>(
      `SELECT id FROM accounts
        WHERE company_id = $1 AND is_active = TRUE
          AND (code = '1320' OR LOWER(COALESCE(name,'')) LIKE '%in transit%' OR LOWER(COALESCE(name,'')) LIKE '%in-transit%')
        ORDER BY CASE WHEN code = '1320' THEN 0 ELSE 1 END, id ASC LIMIT 1`,
      [companyId]
    );
    inTransitAccountId = inTransitRes.rows[0]?.id ?? null;
    if (!inTransitAccountId) {
      throw new AccountingError(400, 'Stock in-transit account not found (expected code 1320 or name containing "in transit")', 'MISSING_IN_TRANSIT_ACCOUNT');
    }
  }

  const applied: Array<Record<string, any>> = [];
  let totalValue4 = 0n;

  for (const raw of input.lines) {
    const itemId = Number(raw.itemId);
    const variantId = raw.variantId != null ? Number(raw.variantId) : null;
    const qty4 = parseQty(raw.quantity, 'Transfer quantity');
    if (qty4 === 0n) throw new AccountingError(400, 'Transfer quantity must be greater than zero', 'INVALID_TRANSFER_QTY');

    const item = await requireStockedItem(tx, companyId, itemId);
    const onHand4 = parseDecimal4(item.on_hand);
    const unitCost4 = parseDecimal4(item.avg_cost) || parseDecimal4(item.unit_cost);
    const value4 = (qty4 * unitCost4) / 10000n;
    totalValue4 += value4;

    await tx.query(
      `INSERT INTO stock_transfer_lines (company_id, transfer_id, item_id, variant_id, quantity, unit_cost, lot_id)
       VALUES ($1, $2, $3, $4, $5::NUMERIC(19,6), $6::NUMERIC(19,6), $7)`,
      [companyId, transferId, itemId, variantId, formatDecimal4(qty4), formatDecimal4(unitCost4), raw.lotId ? Number(raw.lotId) : null]
    );

    const srcRes = await tx.query<{ id: number; qty: string }>(
      `SELECT id, qty::text AS qty FROM stock_balances
        WHERE company_id = $1 AND item_id = $2 AND COALESCE(variant_id, 0) = COALESCE($3, 0)
          AND lower(location) = lower($4)
        FOR UPDATE`,
      [companyId, itemId, variantId, fromLocation]
    );

    let srcQty4: bigint;
    if (srcRes.rows.length === 0) {
      if (qty4 > onHand4) {
        throw new AccountingError(409, `"${item.name}" has only ${formatDecimal4(onHand4)} on hand; cannot transfer ${formatDecimal4(qty4)} from ${fromLocation}`, 'INSUFFICIENT_LOCATION_STOCK');
      }
      srcQty4 = onHand4;
      await tx.query(
        `INSERT INTO stock_balances (company_id, item_id, variant_id, location, qty)
         VALUES ($1, $2, $3, $4, $5::NUMERIC(19,6))`,
        [companyId, itemId, variantId, fromLocation, formatDecimal4(onHand4 - qty4)]
      );
    } else {
      srcQty4 = parseDecimal4(srcRes.rows[0].qty);
      if (qty4 > srcQty4) {
        throw new AccountingError(409, `"${item.name}" has only ${formatDecimal4(srcQty4)} at ${fromLocation}; cannot transfer ${formatDecimal4(qty4)}`, 'INSUFFICIENT_LOCATION_STOCK');
      }
      await tx.query(
        `UPDATE stock_balances SET qty = $3::NUMERIC(19,6), updated_at = NOW() WHERE company_id = $1 AND id = $2`,
        [companyId, srcRes.rows[0].id, formatDecimal4(srcQty4 - qty4)]
      );
    }

    const dstLocation = transferMode === 'two_step' ? transitLocation : toLocation;
    const dstRes = await tx.query<{ id: number; qty: string }>(
      `SELECT id, qty::text AS qty FROM stock_balances
        WHERE company_id = $1 AND item_id = $2 AND COALESCE(variant_id, 0) = COALESCE($3, 0)
          AND lower(location) = lower($4)`,
      [companyId, itemId, variantId, dstLocation]
    );
    if (dstRes.rows.length === 0) {
      await tx.query(
        `INSERT INTO stock_balances (company_id, item_id, variant_id, location, qty)
         VALUES ($1, $2, $3, $4, $5::NUMERIC(19,6))`,
        [companyId, itemId, variantId, dstLocation, formatDecimal4(qty4)]
      );
    } else {
      const dstQty4 = parseDecimal4(dstRes.rows[0].qty);
      await tx.query(
        `UPDATE stock_balances SET qty = $3::NUMERIC(19,6), updated_at = NOW() WHERE company_id = $1 AND id = $2`,
        [companyId, dstRes.rows[0].id, formatDecimal4(dstQty4 + qty4)]
      );
    }

    await tx.query(
      `INSERT INTO inventory_movements (
         company_id, item_id, movement_type, quantity_delta, unit_cost,
         balance_qty, balance_avg_cost, source_type, source_id, location
       ) VALUES ($1, $2, 'transfer', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'stock_transfer', $7, $8)`,
      [companyId, itemId, formatDecimal4(-qty4), formatDecimal4(unitCost4), formatDecimal4(onHand4), formatDecimal4(unitCost4), transferId, fromLocation]
    );
    await tx.query(
      `INSERT INTO inventory_movements (
         company_id, item_id, movement_type, quantity_delta, unit_cost,
         balance_qty, balance_avg_cost, source_type, source_id, location
       ) VALUES ($1, $2, 'transfer', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'stock_transfer', $7, $8)`,
      [companyId, itemId, formatDecimal4(qty4), formatDecimal4(unitCost4), formatDecimal4(onHand4), formatDecimal4(unitCost4), transferId, dstLocation]
    );

    await assertLocationBalancesReconcile(tx, companyId, itemId, onHand4, String(item.sku));

    applied.push({
      itemId: Number(item.id),
      sku: item.sku,
      name: item.name,
      quantity: formatDecimal4(qty4),
      unitCost: formatDecimal4(unitCost4),
      value: formatDecimal4(value4),
    });
  }

  let journalTxnId: number | null = null;
  if (transferMode === 'two_step' && totalValue4 > 0n) {
    const assetTotals = new Map<number, bigint>();
    for (const raw of input.lines) {
      const item = await requireStockedItem(tx, companyId, Number(raw.itemId));
      const qty4 = parseQty(raw.quantity, 'Transfer quantity');
      const unitCost4 = parseDecimal4(item.avg_cost) || parseDecimal4(item.unit_cost);
      const v4 = (qty4 * unitCost4) / 10000n;
      assetTotals.set(Number(item.asset_account_id), (assetTotals.get(Number(item.asset_account_id)) ?? 0n) + v4);
    }
    const jeLines: any[] = [];
    for (const [assetId, v4] of assetTotals.entries()) {
      if (v4 <= 0n) continue;
      jeLines.push({ accountId: inTransitAccountId, debit: formatDecimal4(v4), credit: '0.0000', description: `Stock in transit ${transferNumber}` });
      jeLines.push({ accountId: assetId, debit: '0.0000', credit: formatDecimal4(v4), description: `Stock dispatched to transit ${transferNumber}` });
    }
    if (jeLines.length > 0) {
      const posted = await postJournalEntry(tx, companyId, actor, {
        txnDate: transferDate,
        description: `Two-step stock transfer dispatch ${transferNumber}`,
        sourceType: 'inventory_transfer',
        sourceId: transferId,
        idempotencyKey: `stock-transfer-dispatch:${transferId}`,
        lines: jeLines,
      });
      journalTxnId = posted.transaction.id;
    }
  }

  await tx.query(
    `UPDATE stock_transfers
        SET status = $3,
            dispatched_at = CASE WHEN $4 = 'two_step' THEN COALESCE(dispatched_at, NOW()) ELSE dispatched_at END,
            dispatch_journal_txn_id = COALESCE($5, dispatch_journal_txn_id)
      WHERE company_id = $1 AND id = $2`,
    [companyId, transferId, transferMode === 'two_step' ? 'in_transit' : 'posted', transferMode, journalTxnId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'INVENTORY_TRANSFERRED',
    tableName: 'stock_transfers',
    recordId: transferId,
    newValues: { transferNumber, fromLocation, toLocation, lines: applied, notes: input.notes || null, transferMode, journalTxnId },
  });

  return {
    transferId,
    transferNumber,
    fromLocation,
    toLocation,
    lines: applied,
    transferMode,
    status: transferMode === 'two_step' ? 'in_transit' : 'posted',
    journalTxnId,
    glImpact: transferMode === 'two_step' ? 'posted' : 'none',
    note: transferMode === 'two_step'
      ? 'Two-step transfer dispatched to in-transit; receive to complete destination move.'
      : 'Transfers are stock-neutral and do not post a journal entry.',
  };
}

/* ---------------------------------------------------------------------------
   Physical stock count
   --------------------------------------------------------------------------- */

export interface StockCountInput {
  countDate?: string | null;
  notes?: string | null;
  lines: Array<{ itemId: number; countedQty: string | number; variantId?: number | null; unitCost?: string | number | null }>;
}

/**
 * Creates a draft physical stock count. Nothing moves until the count is
 * posted, so the warehouse can enter figures without disturbing live stock.
 */
export async function createStockCount(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: StockCountInput
) {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'A stock count requires at least one line', 'NO_COUNT_LINES');
  }

  const today = new Date().toISOString().slice(0, 10);
  const countDate = assertIsoDate(input.countDate, today);

  const countNumber = await generateDocNumber(tx, companyId, 'stock_counts', 'count_number', 'SC');

  const head = await tx.query<{ id: number }>(
    `INSERT INTO stock_counts (company_id, count_number, count_date, notes, created_by)
     VALUES ($1, $2, $3::DATE, $4, $5)
     RETURNING id`,
    [companyId, countNumber, countDate, input.notes || null, actor.userId]
  );
  const countId = Number(head.rows[0].id);

  const lines: Array<Record<string, any>> = [];

  for (const raw of input.lines) {
    const itemId = Number(raw.itemId);
    const variantId = raw.variantId != null ? Number(raw.variantId) : null;
    const counted4 = parseQty(raw.countedQty, 'Counted quantity');

    const item = await requireStockedItem(tx, companyId, itemId, { forUpdate: false });
    const onHand4 = parseDecimal4(item.on_hand);
    const unitCost4 =
      raw.unitCost !== undefined && raw.unitCost !== null
        ? parseDecimal4(raw.unitCost)
        : parseDecimal4(item.avg_cost) || parseDecimal4(item.unit_cost);

    const ins = await tx.query<{ id: number; variance_qty: string; variance_value: string }>(
      `INSERT INTO stock_count_lines (
         company_id, count_id, item_id, variant_id, system_qty, counted_qty, unit_cost
       ) VALUES ($1, $2, $3, $4, $5::NUMERIC(19,6), $6::NUMERIC(19,6), $7::NUMERIC(19,6))
       RETURNING id, variance_qty::text AS variance_qty, variance_value::text AS variance_value`,
      [
        companyId,
        countId,
        itemId,
        variantId,
        formatDecimal4(onHand4),
        formatDecimal4(counted4),
        formatDecimal4(unitCost4),
      ]
    );

    lines.push({
      lineId: Number(ins.rows[0].id),
      itemId: Number(item.id),
      sku: item.sku,
      name: item.name,
      systemQty: formatDecimal4(onHand4),
      countedQty: formatDecimal4(counted4),
      unitCost: formatDecimal4(unitCost4),
      varianceQty: ins.rows[0].variance_qty,
      varianceValue: ins.rows[0].variance_value,
    });
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'STOCK_COUNT_CREATED',
    tableName: 'stock_counts',
    recordId: countId,
    newValues: { countNumber, countDate, lineCount: lines.length, status: 'draft' },
  });

  return {
    countId,
    countNumber,
    countDate,
    status: 'draft' as const,
    lines,
    note: 'Draft count created. Post it to apply variances to stock and the general ledger.',
  };
}

/**
 * Posts a draft count: applies each variance as a `count_adjust` movement and
 * posts the net value to the shrinkage/income accounts. Re-posting is rejected.
 */
export async function postStockCount(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  countId: number,
  input: { counterAccountId?: number | null; idempotencyKey?: string | null; notes?: string | null } = {}
) {
  const id = Number(countId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AccountingError(400, 'Invalid stock count id', 'INVALID_COUNT_ID');
  }

  const headRes = await tx.query(
    `SELECT id, count_number, count_date, status FROM stock_counts
      WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, id]
  );
  if (headRes.rows.length === 0) {
    throw new AccountingError(404, 'Stock count not found in active company', 'COUNT_NOT_FOUND');
  }
  const head = headRes.rows[0] as Record<string, any>;
  if (head.status !== 'draft') {
    throw new AccountingError(
      409,
      `Stock count ${head.count_number} is ${head.status} and cannot be posted again`,
      'COUNT_NOT_DRAFT'
    );
  }

  const lineRes = await tx.query(
    `SELECT l.id, l.item_id, l.variant_id,
            l.system_qty::text  AS system_qty,
            l.counted_qty::text AS counted_qty,
            l.unit_cost::text   AS unit_cost,
            l.variance_qty::text   AS variance_qty,
            l.variance_value::text AS variance_value
       FROM stock_count_lines l
      WHERE l.company_id = $1 AND l.count_id = $2
      ORDER BY l.id ASC`,
    [companyId, id]
  );

  if (lineRes.rows.length === 0) {
    throw new AccountingError(400, 'Stock count has no lines to post', 'EMPTY_COUNT');
  }

  const countDate = toIsoDate(head.count_date);
  let netVariance4 = 0n;
  const applied: Array<Record<string, any>> = [];
  // Variance value accumulated per inventory asset account. A count can span
  // items that post to different asset accounts, so one journal entry is raised
  // per affected asset account rather than mis-posting everything to one.
  const byAsset = new Map<number, { assetAccountId: number; net4: bigint }>();

  for (const row of lineRes.rows as Array<Record<string, any>>) {
    const item = await requireStockedItem(tx, companyId, row.item_id);
    const variance4 = parseDecimal4(row.variance_qty);
    const unitCost4 = parseDecimal4(row.unit_cost);
    if (variance4 === 0n) {
      applied.push({
        itemId: Number(item.id),
        sku: item.sku,
        name: item.name,
        systemQty: row.system_qty,
        countedQty: row.counted_qty,
        unitCost: formatDecimal4(unitCost4),
        varianceQty: '0.0000',
        value: '0.0000',
      });
      continue;
    }

    const prevOnHand4 = parseDecimal4(item.on_hand);
    const nextOnHand4 = prevOnHand4 + variance4;

    if (nextOnHand4 < 0n) {
      throw new AccountingError(
        409,
        `Counted quantity for "${item.name}" (${row.counted_qty}) is below zero`,
        'NEGATIVE_COUNTED_QTY'
      );
    }

    await tx.query(
      `UPDATE inventory_items SET on_hand = $3::NUMERIC(19,6)
        WHERE company_id = $1 AND id = $2`,
      [companyId, item.id, formatDecimal4(nextOnHand4)]
    );

    await tx.query(
      `INSERT INTO inventory_movements (
         company_id, item_id, movement_type, quantity_delta, unit_cost,
         balance_qty, balance_avg_cost, source_type, source_id, location
       ) VALUES ($1, $2, 'count_adjust', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'stock_count', $7, $8)`,
      [
        companyId,
        item.id,
        formatDecimal4(variance4),
        formatDecimal4(unitCost4),
        formatDecimal4(nextOnHand4),
        formatDecimal4(unitCost4),
        id,
        item.location || DEFAULT_LOCATION,
      ]
    );

    const value4 = (variance4 * unitCost4) / 10000n;
    netVariance4 += value4;

    if (value4 !== 0n) {
      const assetId = Number(item.asset_account_id);
      if (!assetId) {
        throw new AccountingError(
          400,
          `"${item.name}" has no inventory asset account configured`,
          'MISSING_ASSET_ACCOUNT'
        );
      }
      const bucket = byAsset.get(assetId) ?? { assetAccountId: assetId, net4: 0n };
      bucket.net4 += value4;
      byAsset.set(assetId, bucket);
    }

    applied.push({
      itemId: Number(item.id),
      sku: item.sku,
      name: item.name,
      systemQty: row.system_qty,
      countedQty: row.counted_qty,
      unitCost: formatDecimal4(unitCost4),
      varianceQty: formatDecimal4(variance4),
      value: formatDecimal4(value4),
    });
  }

  // Post one balanced journal entry per affected inventory asset account.
  // Positive variance  -> debit inventory, credit shrinkage/income.
  // Negative variance  -> debit shrinkage/expense, credit inventory.
  const journals: Array<{ journalTransactionId: number; entryNumber: string; idempotentReplay: boolean }> = [];

  for (const bucket of byAsset.values()) {
    const amount = bucket.net4 > 0n ? bucket.net4 : -bucket.net4;
    const counterAccountId = await resolveCounterAccountId(
      tx,
      companyId,
      bucket.net4 > 0n ? 1 : -1,
      input.counterAccountId
    );
    const description = `Stock count ${head.count_number} variance`;
    const posted = await postJournalEntry(tx, companyId, actor, {
      txnDate: countDate,
      description,
      memo: input.notes || `Physical stock count ${head.count_number}`,
      reference: String(head.count_number),
      sourceType: 'stock_count',
      sourceId: id,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${bucket.assetAccountId}` : null,
      lines:
        bucket.net4 > 0n
          ? [
              { accountId: bucket.assetAccountId, debit: formatDecimal4(amount), description },
              { accountId: counterAccountId, credit: formatDecimal4(amount), description },
            ]
          : [
              { accountId: counterAccountId, debit: formatDecimal4(amount), description },
              { accountId: bucket.assetAccountId, credit: formatDecimal4(amount), description },
            ],
    });
    journals.push({
      journalTransactionId: posted.transaction.id,
      entryNumber: posted.transaction.entryNumber,
      idempotentReplay: posted.idempotentReplay,
    });
  }

  const journalTransactionId = journals.length > 0 ? journals[0].journalTransactionId : null;
  const entryNumber = journals.length > 0 ? journals[0].entryNumber : null;
  const idempotentReplay = journals.some(j => j.idempotentReplay);

  // stock_counts.journal_txn_id links the primary entry. When a count spans
  // several asset accounts the remaining entries are still fully traceable via
  // inventory_movements.source_id and the audit log.
  await tx.query(
    `UPDATE stock_counts SET status = 'posted', journal_txn_id = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, id, journalTransactionId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'STOCK_COUNT_POSTED',
    tableName: 'stock_counts',
    recordId: id,
    newValues: {
      countNumber: head.count_number,
      lineCount: applied.length,
      netVariance: formatDecimal4(netVariance4),
      journalTransactionId,
    },
  });

  return {
    countId: id,
    countNumber: head.count_number,
    status: 'posted' as const,
    lines: applied,
    netVariance: formatDecimal4(netVariance4),
    journalTransactionId,
    entryNumber,
    idempotentReplay,
  };
}

/* ---------------------------------------------------------------------------
   Deactivation
   --------------------------------------------------------------------------- */

/**
 * Deactivates an inventory item. Refuses when the item still has on-hand stock
 * or is referenced by bills, invoices or job material requirements, so history
 * can never be silently orphaned.
 */
export async function deactivateInventoryItem(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  itemId: number
) {
  const item = await requireStockedItem(tx, companyId, itemId);
  const onHand4 = parseDecimal4(item.on_hand);

  if (onHand4 !== 0n) {
    throw new AccountingError(
      409,
      `"${item.name}" still has ${item.on_hand} on hand. Zero or write off the stock before deactivating.`,
      'ITEM_HAS_STOCK'
    );
  }
  if (item.is_active === false) {
    throw new AccountingError(409, `"${item.name}" is already inactive`, 'ITEM_ALREADY_INACTIVE');
  }

  const refs = await tx.query<{ kind: string; cnt: string }>(
    `SELECT 'bill' AS kind, COUNT(*)::text AS cnt FROM bill_lines
      WHERE company_id = $1 AND item_id = $2
     UNION ALL
     SELECT 'invoice', COUNT(*)::text FROM invoice_lines
      WHERE company_id = $1 AND item_id = $2
     UNION ALL
     SELECT 'job', COUNT(*)::text FROM job_material_requirements
      WHERE company_id = $1 AND raw_material_item_id = $2`,
    [companyId, item.id]
  );
  const referenced = (refs.rows as Array<Record<string, any>>).filter(r => Number(r.cnt) > 0);

  if (referenced.length > 0) {
    const detail = referenced.map(r => `${r.kind}: ${r.cnt}`).join(', ');
    throw new AccountingError(
      409,
      `"${item.name}" is referenced by historical transactions (${detail}) and cannot be deactivated.`,
      'ITEM_IN_USE'
    );
  }

  await tx.query(
    `UPDATE inventory_items SET is_active = FALSE WHERE company_id = $1 AND id = $2`,
    [companyId, item.id]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'INVENTORY_DEACTIVATED',
    tableName: 'inventory_items',
    recordId: Number(item.id),
    oldValues: { isActive: true, onHand: item.on_hand },
    newValues: { isActive: false },
  });

  return { itemId: Number(item.id), sku: item.sku, name: item.name, isActive: false };
}

export async function receiveStockTransfer(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  transferId: number,
  input: { lines?: Array<{ lineId?: number; itemId?: number; variantId?: number | null; lotId?: number | null; receivedQty: string | number }>; idempotencyKey?: string } = {}
) {
  const res = await tx.query<any>(
    `SELECT id, transfer_number, status, transfer_mode, from_location, to_location,
            transfer_date::text AS transfer_date, dispatch_journal_txn_id
       FROM stock_transfers WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, transferId]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Transfer not found', 'TRANSFER_NOT_FOUND');
  const tr = res.rows[0];
  if (tr.status === 'posted') {
    return { transferId: Number(tr.id), transferNumber: tr.transfer_number, status: 'posted', idempotent: true };
  }
  if (!['in_transit', 'partially_received'].includes(String(tr.status))) {
    throw new AccountingError(409, `Transfer cannot be received from status ${tr.status}`, 'INVALID_TRANSFER_STATUS');
  }

  const toLocation = normaliseLocation(tr.to_location, 'Secondary');
  const transitLocation = `IN_TRANSIT::${toLocation}`;
  const today = new Date().toISOString().slice(0, 10);

  const linesRes = await tx.query<any>(
    `SELECT l.id AS line_id, l.item_id, l.variant_id, l.quantity::text AS quantity,
            COALESCE(l.received_qty, 0)::text AS received_qty, l.unit_cost::text AS unit_cost, l.lot_id,
            i.name, i.sku, i.on_hand::text AS on_hand, i.avg_cost::text AS avg_cost, i.unit_cost::text AS item_unit_cost,
            i.asset_account_id
       FROM stock_transfer_lines l
       JOIN inventory_items i ON i.company_id = l.company_id AND i.id = l.item_id
      WHERE l.company_id = $1 AND l.transfer_id = $2
      ORDER BY l.id ASC`,
    [companyId, transferId]
  );

  const requested = Array.isArray(input.lines) && input.lines.length > 0 ? input.lines : null;
  const receivePlan: Array<{ line: any; receiveQty4: bigint }> = [];
  const priorAllZero = linesRes.rows.every((l: any) => parseQty(l.received_qty || 0, 'Received quantity') === 0n);

  for (const line of linesRes.rows) {
    const lineId = Number(line.line_id);
    const qty4 = parseQty(line.quantity, 'Transfer quantity');
    const already4 = parseQty(line.received_qty || 0, 'Received quantity');
    const remaining4 = qty4 - already4;
    if (remaining4 <= 0n) continue;

    let receiveQty4 = remaining4;
    if (requested) {
      const reqLine = requested.find(r =>
        (r.lineId != null && Number(r.lineId) === lineId) ||
        (r.lineId == null && Number(r.itemId) === Number(line.item_id) && Number(r.variantId ?? 0) === Number(line.variant_id ?? 0) && Number(r.lotId ?? 0) === Number(line.lot_id ?? 0))
      );
      if (!reqLine) continue;
      receiveQty4 = parseQty(reqLine.receivedQty, 'receivedQty');
      if (receiveQty4 <= 0n) throw new AccountingError(400, `receivedQty must be > 0 for line ${lineId}`, 'INVALID_RECEIVED_QTY');
      if (receiveQty4 > remaining4) {
        throw new AccountingError(409, `Cannot receive ${formatDecimal4(receiveQty4)} for ${line.sku}; remaining is ${formatDecimal4(remaining4)}`, 'RECEIVE_EXCEEDS_REMAINING');
      }
    }
    receivePlan.push({ line, receiveQty4 });
  }

  if (receivePlan.length === 0) {
    const allReceived = linesRes.rows.every((l: any) => parseQty(l.received_qty || 0, 'Received quantity') >= parseQty(l.quantity, 'Transfer quantity'));
    if (allReceived) {
      await tx.query(`UPDATE stock_transfers SET status = 'posted', received_at = COALESCE(received_at, NOW()) WHERE company_id = $1 AND id = $2`, [companyId, transferId]);
      return { transferId: Number(tr.id), transferNumber: tr.transfer_number, status: 'posted', idempotent: true };
    }
    throw new AccountingError(400, 'No receivable lines selected', 'NO_RECEIVABLE_LINES');
  }

  const applied: Array<Record<string, any>> = [];
  const valueByAsset = new Map<number, bigint>();
  let totalReceivedValue4 = 0n;

  for (const { line, receiveQty4 } of receivePlan) {
    const itemId = Number(line.item_id);
    const variantId = line.variant_id == null ? null : Number(line.variant_id);
    const onHand4 = parseDecimal4(line.on_hand);
    const unitCost4 = parseDecimal4(line.avg_cost) || parseDecimal4(line.unit_cost) || parseDecimal4(line.item_unit_cost);
    const value4 = (receiveQty4 * unitCost4) / 10000n;
    totalReceivedValue4 += value4;
    const assetAccountId = Number(line.asset_account_id);
    valueByAsset.set(assetAccountId, (valueByAsset.get(assetAccountId) ?? 0n) + value4);

    const srcRes = await tx.query<{ id: number; qty: string }>(
      `SELECT id, qty::text AS qty FROM stock_balances
        WHERE company_id = $1 AND item_id = $2 AND COALESCE(variant_id, 0) = COALESCE($3, 0)
          AND lower(location) = lower($4)
        FOR UPDATE`,
      [companyId, itemId, variantId, transitLocation]
    );
    if (srcRes.rows.length === 0) {
      throw new AccountingError(409, `In-transit stock not found for ${line.sku} at ${transitLocation}`, 'MISSING_IN_TRANSIT_STOCK');
    }
    const srcQty4 = parseDecimal4(srcRes.rows[0].qty);
    if (receiveQty4 > srcQty4) {
      throw new AccountingError(409, `In-transit quantity insufficient for ${line.sku}: have ${formatDecimal4(srcQty4)}, need ${formatDecimal4(receiveQty4)}`, 'INSUFFICIENT_IN_TRANSIT_STOCK');
    }
    await tx.query(
      `UPDATE stock_balances SET qty = $3::NUMERIC(19,6), updated_at = NOW() WHERE company_id = $1 AND id = $2`,
      [companyId, srcRes.rows[0].id, formatDecimal4(srcQty4 - receiveQty4)]
    );

    const dstRes = await tx.query<{ id: number; qty: string }>(
      `SELECT id, qty::text AS qty FROM stock_balances
        WHERE company_id = $1 AND item_id = $2 AND COALESCE(variant_id, 0) = COALESCE($3, 0)
          AND lower(location) = lower($4)
        FOR UPDATE`,
      [companyId, itemId, variantId, toLocation]
    );
    if (dstRes.rows.length === 0) {
      await tx.query(
        `INSERT INTO stock_balances (company_id, item_id, variant_id, location, qty)
         VALUES ($1, $2, $3, $4, $5::NUMERIC(19,6))`,
        [companyId, itemId, variantId, toLocation, formatDecimal4(receiveQty4)]
      );
    } else {
      const dstQty4 = parseDecimal4(dstRes.rows[0].qty);
      await tx.query(
        `UPDATE stock_balances SET qty = $3::NUMERIC(19,6), updated_at = NOW() WHERE company_id = $1 AND id = $2`,
        [companyId, dstRes.rows[0].id, formatDecimal4(dstQty4 + receiveQty4)]
      );
    }

    await tx.query(
      `INSERT INTO inventory_movements (
         company_id, item_id, movement_type, quantity_delta, unit_cost,
         balance_qty, balance_avg_cost, source_type, source_id, location
       ) VALUES ($1, $2, 'transfer', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'stock_transfer_receipt', $7, $8)`,
      [companyId, itemId, formatDecimal4(-receiveQty4), formatDecimal4(unitCost4), formatDecimal4(onHand4), formatDecimal4(unitCost4), transferId, transitLocation]
    );
    await tx.query(
      `INSERT INTO inventory_movements (
         company_id, item_id, movement_type, quantity_delta, unit_cost,
         balance_qty, balance_avg_cost, source_type, source_id, location
       ) VALUES ($1, $2, 'transfer', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'stock_transfer_receipt', $7, $8)`,
      [companyId, itemId, formatDecimal4(receiveQty4), formatDecimal4(unitCost4), formatDecimal4(onHand4), formatDecimal4(unitCost4), transferId, toLocation]
    );

    await tx.query(
      `UPDATE stock_transfer_lines SET received_qty = (COALESCE(received_qty,0) + $3::NUMERIC(19,6)) WHERE company_id = $1 AND id = $2`,
      [companyId, Number(line.line_id), formatDecimal4(receiveQty4)]
    );

    await assertLocationBalancesReconcile(tx, companyId, itemId, onHand4, String(line.sku));
    applied.push({ lineId: Number(line.line_id), itemId, sku: line.sku, name: line.name, quantity: formatDecimal4(receiveQty4), remainingAfter: formatDecimal4(parseQty(line.quantity, 'q') - parseQty(line.received_qty || 0, 'r') - receiveQty4) });
  }

  const allAfter = await tx.query<any>(
    `SELECT quantity::text AS quantity, COALESCE(received_qty,0)::text AS received_qty FROM stock_transfer_lines WHERE company_id = $1 AND transfer_id = $2`,
    [companyId, transferId]
  );
  const fullyReceived = allAfter.rows.length > 0 && allAfter.rows.every((r: any) => parseQty(r.received_qty, 'r') >= parseQty(r.quantity, 'q'));
  const anyReceived = allAfter.rows.some((r: any) => parseQty(r.received_qty, 'r') > 0n);

  let receiveJournalTxnId: number | null = null;
  let dispatchJournalTxnId = tr.dispatch_journal_txn_id ? Number(tr.dispatch_journal_txn_id) : null;
  if (!dispatchJournalTxnId) {
    const jeRes = await tx.query<{ id: number }>(
      `SELECT id FROM journal_transactions
        WHERE company_id = $1 AND source_type = 'inventory_transfer' AND source_id = $2
          AND reverses_transaction_id IS NULL AND is_posted = TRUE
        ORDER BY id DESC LIMIT 1`,
      [companyId, transferId]
    );
    dispatchJournalTxnId = jeRes.rows[0]?.id ?? null;
  }

  if (totalReceivedValue4 > 0n) {
    // Determine in-transit account from dispatch JE or by lookup
    let inTransitAccountId: number | null = null;
    if (dispatchJournalTxnId) {
      const itRes = await tx.query<{ account_id: number }>(
        `SELECT account_id FROM journal_lines WHERE company_id = $1 AND transaction_id = $2 AND debit > 0 ORDER BY id ASC LIMIT 1`,
        [companyId, dispatchJournalTxnId]
      );
      inTransitAccountId = itRes.rows[0]?.account_id ?? null;
    }
    if (!inTransitAccountId) {
      const inTransitRes = await tx.query<{ id: number }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND is_active = TRUE AND (code = '1320' OR LOWER(COALESCE(name,'')) LIKE '%in transit%') ORDER BY CASE WHEN code='1320' THEN 0 ELSE 1 END, id ASC LIMIT 1`,
        [companyId]
      );
      inTransitAccountId = inTransitRes.rows[0]?.id ?? null;
    }
    if (inTransitAccountId) {
      const jeLines: any[] = [];
      for (const [assetId, v4] of valueByAsset.entries()) {
        if (v4 <= 0n) continue;
        jeLines.push({ accountId: assetId, debit: formatDecimal4(v4), credit: '0.0000', description: `Stock received from transit ${tr.transfer_number}` });
        jeLines.push({ accountId: inTransitAccountId, debit: '0.0000', credit: formatDecimal4(v4), description: `Clear in-transit for ${tr.transfer_number}` });
      }
      if (jeLines.length > 0) {
        const receivingAllInOneShot = fullyReceived && priorAllZero && !requested;
        const idem = input.idempotencyKey
          ? `stock-transfer-receive:${transferId}:${input.idempotencyKey}`
          : receivingAllInOneShot
            ? `stock-transfer-receive:${transferId}`
            : `stock-transfer-receive:${transferId}:${applied.map(a => `${a.lineId}:${a.quantity}:${a.remainingAfter}`).join('|')}`;
        const posted = await postJournalEntry(tx, companyId, actor, {
          txnDate: today,
          description: `Stock transfer receipt ${tr.transfer_number}${fullyReceived ? '' : ' (partial)'}`,
          sourceType: 'inventory_transfer',
          sourceId: transferId,
          idempotencyKey: idem,
          lines: jeLines,
        });
        receiveJournalTxnId = posted.transaction.id;
      }
    }
  }

  const nextStatus = fullyReceived ? 'posted' : (anyReceived ? 'partially_received' : tr.status);
  await tx.query(
    `UPDATE stock_transfers
        SET status = $3::text,
            received_at = CASE WHEN $3::text = 'posted' THEN COALESCE(received_at, NOW()) ELSE received_at END,
            received_by_user_id = $4::bigint,
            receive_journal_txn_id = COALESCE($5::bigint, receive_journal_txn_id)
      WHERE company_id = $1 AND id = $2`,
    [companyId, transferId, nextStatus, actor.userId, receiveJournalTxnId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'STOCK_TRANSFER_RECEIVED',
    tableName: 'stock_transfers',
    recordId: transferId,
    newValues: { status: nextStatus, dispatchJournalTxnId, receiveJournalTxnId, lines: applied, partial: !fullyReceived },
  });

  return {
    transferId: Number(tr.id),
    transferNumber: tr.transfer_number,
    status: nextStatus,
    fromLocation: normaliseLocation(tr.from_location, DEFAULT_LOCATION),
    toLocation,
    lines: applied,
    dispatchJournalTxnId,
    receiveJournalTxnId,
    fullyReceived,
    partial: !fullyReceived,
  };
}

export async function recordScrapWriteOff(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { itemId: number; quantity: string | number; reasonCode?: string | null; reason?: string | null; jobReference?: string | null; damageDate?: string | null }
) {
  const damage = await recordStockDamage(tx, companyId, actor, Number(input.itemId), {
    quantity: input.quantity,
    reason: input.reason || 'Scrap write-off',
    reasonCode: input.reasonCode || 'scrap',
    damageDate: input.damageDate || null,
    jobReference: input.jobReference || null,
    scrapType: 'scrap',
  });
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'INVENTORY_SCRAP_WRITTEN_OFF',
    tableName: 'stock_damages',
    recordId: damage.damageId,
    newValues: { itemId: input.itemId, quantity: String(input.quantity), jobReference: input.jobReference || null },
  });
  return damage;
}

export async function listInventoryLots(tx: Transaction, companyId: number, itemId?: number) {
  const params: any[] = [companyId];
  let where = 'WHERE l.company_id = $1';
  if (itemId) { params.push(itemId); where += ` AND l.item_id = $${params.length}`; }
  const res = await tx.query<any>(
    `SELECT l.id, l.item_id, l.lot_number, l.supplier_roll_id, l.paper_grain,
            l.receipt_date::text AS receipt_date, l.expiry_date::text AS expiry_date,
            l.quantity_on_hand::text AS quantity_on_hand, l.created_at,
            i.sku, i.name AS item_name
       FROM inventory_lots l
       JOIN inventory_items i ON i.company_id = l.company_id AND i.id = l.item_id
      ${where}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 500`,
    params
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    itemId: Number(r.item_id),
    sku: r.sku,
    itemName: r.item_name,
    lotNumber: r.lot_number,
    supplierRollId: r.supplier_roll_id || '',
    paperGrain: r.paper_grain || '',
    receiptDate: r.receipt_date,
    expiryDate: r.expiry_date,
    quantityOnHand: r.quantity_on_hand,
    createdAt: r.created_at,
  }));
}

export async function createInventoryLot(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { itemId: number; lotNumber: string; supplierRollId?: string | null; paperGrain?: string | null; receiptDate?: string | null; expiryDate?: string | null; quantityOnHand?: string | number | null }
) {
  const itemId = Number(input.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) throw new AccountingError(400, 'Invalid itemId', 'INVALID_ITEM');
  const item = await requireStockedItem(tx, companyId, itemId);
  const lotNumber = String(input.lotNumber || '').trim();
  if (!lotNumber) throw new AccountingError(400, 'lotNumber is required', 'MISSING_LOT_NUMBER');
  const qty4 = parseQty(input.quantityOnHand ?? 0, 'quantityOnHand');
  const ins = await tx.query<any>(
    `INSERT INTO inventory_lots (company_id, item_id, lot_number, supplier_roll_id, paper_grain, receipt_date, expiry_date, quantity_on_hand)
     VALUES ($1,$2,$3,$4,$5,$6::DATE,$7::DATE,$8::NUMERIC(19,6))
     ON CONFLICT (company_id, item_id, lot_number) DO UPDATE
       SET supplier_roll_id = COALESCE(EXCLUDED.supplier_roll_id, inventory_lots.supplier_roll_id),
           paper_grain = COALESCE(EXCLUDED.paper_grain, inventory_lots.paper_grain),
           receipt_date = COALESCE(EXCLUDED.receipt_date, inventory_lots.receipt_date),
           expiry_date = COALESCE(EXCLUDED.expiry_date, inventory_lots.expiry_date),
           quantity_on_hand = EXCLUDED.quantity_on_hand
     RETURNING *`,
    [companyId, item.id, lotNumber, input.supplierRollId || null, input.paperGrain || null, input.receiptDate || null, input.expiryDate || null, formatDecimal4(qty4)]
  );
  const r = ins.rows[0];
  await writeAuditLog(tx, { companyId, actorUserId: actor.userId, actorUsername: actor.username, action: 'INVENTORY_LOT_UPSERTED', tableName: 'inventory_lots', recordId: Number(r.id), newValues: { itemId, lotNumber } });
  return { id: Number(r.id), itemId, lotNumber, quantityOnHand: r.quantity_on_hand };
}