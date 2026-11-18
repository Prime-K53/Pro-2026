import { Transaction } from '@electric-sql/pglite';
import { writeAuditLog } from '../audit.ts';
import {
  AccountingError,
  ActorContext,
  JournalLineInput,
  postJournalEntry,
} from './accountingEngine.ts';
import {
  addDaysToIso,
  assertIsoDate,
  checkRouteIdempotency,
  computeTax4,
  convertForeign4ToBase4,
  divRoundBigInt,
  formatDecimal6,
  generateNextDocNumber,
  multiplyQty6ByRate4,
  parseDecimal6,
  recalculateVendorBalance,
  resolveExchangeRate6,
  resolveWorkflowAccounts,
  saveRouteIdempotency,
  todayIsoDate,
} from './commercialHelpers.ts';
import {
  formatDecimal4,
  parseDecimal4,
  toMoneyNumber,
} from '../lib/decimal.ts';

// ============================================================================
// PURCHASE REQUISITIONS & DEMAND GENERATION
// ============================================================================

export interface PurchaseRequisitionLineInput {
  itemId?: number | null;
  preferredVendorId?: number | null;
  description: string;
  quantity: string | number;
  estimatedUnitCost?: string | number;
}

export async function listPurchaseRequisitions(tx: Transaction, companyId: number) {
  const hdrRes = await tx.query<any>(
    `SELECT pr.id, pr.requisition_number, pr.req_date::text, pr.needed_by_date::text,
            pr.demand_source, pr.source_job_id, pr.status, pr.requested_by,
            pr.approved_by, pr.approved_at::text, pr.notes, pr.created_at::text
       FROM purchase_requisitions pr
      WHERE pr.company_id = $1
      ORDER BY pr.req_date DESC, pr.id DESC`,
    [companyId]
  );
  if (hdrRes.rows.length === 0) return [];

  const ids = hdrRes.rows.map((r: any) => Number(r.id));
  const linesRes = await tx.query<any>(
    `SELECT l.id, l.requisition_id, l.line_order, l.item_id, ii.sku AS item_sku, ii.name AS item_name,
            l.preferred_vendor_id, l.description, l.quantity::text, l.estimated_unit_cost::text
       FROM purchase_requisition_lines l
       LEFT JOIN inventory_items ii ON ii.company_id = l.company_id AND ii.id = l.item_id
      WHERE l.company_id = $1 AND l.requisition_id = ANY($2::BIGINT[])
      ORDER BY l.requisition_id ASC, l.line_order ASC`,
    [companyId, ids]
  );

  const linesByReq = new Map<number, any[]>();
  for (const l of linesRes.rows) {
    const rid = Number(l.requisition_id);
    const arr = linesByReq.get(rid) ?? [];
    arr.push({
      id: Number(l.id),
      lineOrder: Number(l.line_order),
      itemId: l.item_id !== null ? Number(l.item_id) : null,
      itemSku: l.item_sku || null,
      itemName: l.item_name || null,
      preferredVendorId: l.preferred_vendor_id !== null ? Number(l.preferred_vendor_id) : null,
      description: l.description,
      quantity: Number(l.quantity),
      estimatedUnitCost: Number(l.estimated_unit_cost),
    });
    linesByReq.set(rid, arr);
  }

  return hdrRes.rows.map((r: any) => ({
    id: Number(r.id),
    requisitionNumber: r.requisition_number,
    reqDate: r.req_date,
    neededByDate: r.needed_by_date || null,
    demandSource: r.demand_source,
    sourceJobId: r.source_job_id !== null ? Number(r.source_job_id) : null,
    status: r.status,
    requestedBy: r.requested_by !== null ? Number(r.requested_by) : null,
    approvedBy: r.approved_by !== null ? Number(r.approved_by) : null,
    approvedAt: r.approved_at || null,
    notes: r.notes || '',
    lines: linesByReq.get(Number(r.id)) ?? [],
  }));
}

export async function createPurchaseRequisition(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    reqDate?: string;
    neededByDate?: string | null;
    demandSource?: 'manual' | 'reorder_level' | 'job_shortfall';
    sourceJobId?: number | null;
    submitImmediately?: boolean;
    notes?: string | null;
    lines: PurchaseRequisitionLineInput[];
  }
) {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'At least one requisition line is required', 'EMPTY_LINES');
  }
  const reqDate = input.reqDate ? assertIsoDate(input.reqDate, 'reqDate') : todayIsoDate();
  const neededByDate = input.neededByDate ? assertIsoDate(input.neededByDate, 'neededByDate') : null;
  const demandSource = input.demandSource || 'manual';
  if (!['manual', 'reorder_level', 'job_shortfall'].includes(demandSource)) {
    throw new AccountingError(400, `Invalid demandSource '${demandSource}'`);
  }

  const reqNumber = await generateNextDocNumber(
    tx,
    companyId,
    'purchase_requisitions',
    'requisition_number',
    'PR'
  );
  const initialStatus = input.submitImmediately === false ? 'draft' : 'submitted';

  const hdrRes = await tx.query<{ id: number }>(
    `INSERT INTO purchase_requisitions (
       company_id, requisition_number, req_date, needed_by_date, demand_source,
       source_job_id, status, requested_by, notes
     ) VALUES ($1, $2, $3::DATE, $4::DATE, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      companyId,
      reqNumber,
      reqDate,
      neededByDate,
      demandSource,
      input.sourceJobId ? Number(input.sourceJobId) : null,
      initialStatus,
      actor.userId,
      input.notes?.trim() || null,
    ]
  );
  const reqId = Number(hdrRes.rows[0].id);

  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    const itemId = l.itemId ? Number(l.itemId) : null;
    let estUnitCost6 = parseDecimal6(l.estimatedUnitCost ?? 0);
    if (itemId !== null) {
      const itRes = await tx.query<{ unit_cost: string; item_type: string }>(
        `SELECT unit_cost::text, item_type FROM inventory_items WHERE company_id = $1 AND id = $2`,
        [companyId, itemId]
      );
      if (itRes.rows.length === 0) {
        throw new AccountingError(404, `Inventory item ${itemId} not found in active company`);
      }
      if (!['raw_material', 'stationery'].includes(itRes.rows[0].item_type)) {
        throw new AccountingError(400, 'Purchase requisitions can only order raw_material or stationery items');
      }
      if (estUnitCost6 === 0n) {
        estUnitCost6 = parseDecimal6(itRes.rows[0].unit_cost);
      }
    }
    const qty6 = parseDecimal6(l.quantity);
    if (qty6 <= 0n) throw new AccountingError(400, `Line ${i + 1}: quantity must be > 0`);
    const desc = String(l.description || '').trim();
    if (!desc) throw new AccountingError(400, `Line ${i + 1}: description is required`);

    await tx.query(
      `INSERT INTO purchase_requisition_lines (
         company_id, requisition_id, line_order, item_id, preferred_vendor_id,
         description, quantity, estimated_unit_cost
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(19,6), $8::NUMERIC(19,6))`,
      [
        companyId,
        reqId,
        i + 1,
        itemId,
        l.preferredVendorId ? Number(l.preferredVendorId) : null,
        desc,
        formatDecimal6(qty6),
        formatDecimal6(estUnitCost6),
      ]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PURCHASE_REQUISITION_CREATED',
    tableName: 'purchase_requisitions',
    recordId: reqId,
    newValues: { requisitionNumber: reqNumber, demandSource, lineCount: input.lines.length },
  });

  const all = await listPurchaseRequisitions(tx, companyId);
  return all.find(r => r.id === reqId)!;
}

export async function generateDemandRequisitions(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input?: { jobId?: number | null; preferredVendorId?: number | null; targetMultiplier?: number }
) {
  const lines: PurchaseRequisitionLineInput[] = [];
  let demandSource: 'reorder_level' | 'job_shortfall' = 'reorder_level';
  const sourceJobId = input?.jobId ? Number(input.jobId) : null;

  if (sourceJobId) {
    demandSource = 'job_shortfall';
    const reqs = await tx.query<{
      raw_material_item_id: number;
      planned_usage_qty: string;
      issued_usage_qty: string;
      item_name: string;
      on_hand: string;
      reserved_qty: string;
      conversion_factor: string;
      unit_cost: string;
    }>(
      `SELECT jmr.raw_material_item_id, jmr.planned_usage_qty::text, jmr.issued_usage_qty::text,
              ii.name AS item_name, ii.on_hand::text, COALESCE(ii.reserved_qty, 0)::text AS reserved_qty,
              ii.conversion_factor::text, ii.unit_cost::text
         FROM job_material_requirements jmr
         JOIN inventory_items ii ON ii.company_id = jmr.company_id AND ii.id = jmr.raw_material_item_id
        WHERE jmr.company_id = $1 AND jmr.printing_job_id = $2`,
      [companyId, sourceJobId]
    );
    for (const r of reqs.rows) {
      const neededUsage6 = parseDecimal6(r.planned_usage_qty) - parseDecimal6(r.issued_usage_qty);
      if (neededUsage6 <= 0n) continue;
      const factor6 = parseDecimal6(r.conversion_factor || '1');
      const availPurchase6 = parseDecimal6(r.on_hand) - parseDecimal6(r.reserved_qty);
      const availUsage6 = divRoundBigInt(availPurchase6 * factor6, 1000000n, 'HALF_EVEN');
      if (availUsage6 < neededUsage6) {
        const deficitUsage6 = neededUsage6 - (availUsage6 > 0n ? availUsage6 : 0n);
        // Round up to whole purchase units or exact purchase units
        const rawPurchase6 = divRoundBigInt(deficitUsage6 * 1000000n, factor6, 'HALF_UP');
        const wholeUnits = rawPurchase6 % 1000000n === 0n ? rawPurchase6 : (rawPurchase6 / 1000000n + 1n) * 1000000n;
        lines.push({
          itemId: Number(r.raw_material_item_id),
          preferredVendorId: input?.preferredVendorId || null,
          description: `Job #${sourceJobId} material shortfall — ${r.item_name}`,
          quantity: formatDecimal6(wholeUnits > 0n ? wholeUnits : 1000000n),
          estimatedUnitCost: r.unit_cost,
        });
      }
    }
  } else {
    const lowStock = await tx.query<{
      id: number;
      name: string;
      on_hand: string;
      reserved_qty: string;
      reorder_point: string;
      unit_cost: string;
    }>(
      `SELECT id, name, on_hand::text, COALESCE(reserved_qty, 0)::text AS reserved_qty,
              reorder_point::text, unit_cost::text
         FROM inventory_items
        WHERE company_id = $1
          AND is_active = TRUE
          AND item_type IN ('raw_material', 'stationery')
          AND reorder_point > 0
          AND (on_hand - COALESCE(reserved_qty, 0)) <= reorder_point
        ORDER BY id ASC`,
      [companyId]
    );
    const mult = BigInt(Math.max(1, Math.round(input?.targetMultiplier ?? 2)));
    for (const item of lowStock.rows) {
      const avail6 = parseDecimal6(item.on_hand) - parseDecimal6(item.reserved_qty);
      const reorder6 = parseDecimal6(item.reorder_point);
      const target6 = reorder6 * mult;
      const orderQty6 = target6 - (avail6 > 0n ? avail6 : 0n);
      if (orderQty6 > 0n) {
        lines.push({
          itemId: Number(item.id),
          preferredVendorId: input?.preferredVendorId || null,
          description: `Reorder replenishment — ${item.name}`,
          quantity: formatDecimal6(orderQty6),
          estimatedUnitCost: item.unit_cost,
        });
      }
    }
  }

  if (lines.length === 0) {
    return { generated: false, requisition: null };
  }

  const requisition = await createPurchaseRequisition(tx, companyId, actor, {
    demandSource,
    sourceJobId,
    submitImmediately: true,
    notes:
      demandSource === 'job_shortfall'
        ? `Auto-generated material demand from Printing Job #${sourceJobId}`
        : 'Auto-generated from low-stock reorder threshold check',
    lines,
  });

  return { generated: true, requisition };
}

export async function approvePurchaseRequisition(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  requisitionId: number,
  note?: string
) {
  const res = await tx.query<{ id: number; status: string; requisition_number: string }>(
    `SELECT id, status, requisition_number
       FROM purchase_requisitions
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, requisitionId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Purchase requisition not found');
  }
  const req = res.rows[0];
  if (!['draft', 'submitted'].includes(req.status)) {
    throw new AccountingError(
      409,
      `Requisition ${req.requisition_number} cannot be approved from status '${req.status}'`,
      'INVALID_REQUISITION_STATUS'
    );
  }

  await tx.query(
    `UPDATE purchase_requisitions
        SET status = 'approved',
            approved_by = $3,
            approved_at = NOW(),
            notes = CASE WHEN $4::TEXT IS NOT NULL THEN COALESCE(notes || ' | ', '') || $4 ELSE notes END
      WHERE company_id = $1 AND id = $2`,
    [companyId, requisitionId, actor.userId, note?.trim() || null]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PURCHASE_REQUISITION_APPROVED',
    tableName: 'purchase_requisitions',
    recordId: requisitionId,
    oldValues: { status: req.status },
    newValues: { status: 'approved', note: note || null },
  });

  const all = await listPurchaseRequisitions(tx, companyId);
  return all.find(r => r.id === requisitionId)!;
}

export async function convertRequisitionToPurchaseOrder(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  requisitionId: number,
  input: {
    vendorId: number;
    poDate?: string;
    expectedDate?: string | null;
    notes?: string | null;
    lineOverrides?: Array<{ lineId?: number; itemId?: number; rate?: string | number; quantity?: string | number }>;
  }
) {
  const reqRes = await tx.query<{ id: number; requisition_number: string; status: string }>(
    `SELECT id, requisition_number, status
       FROM purchase_requisitions
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, requisitionId]
  );
  if (reqRes.rows.length === 0) {
    throw new AccountingError(404, 'Purchase requisition not found');
  }
  const req = reqRes.rows[0];
  if (req.status === 'converted') {
    throw new AccountingError(
      409,
      `Requisition ${req.requisition_number} has already been converted to a Purchase Order`,
      'REQUISITION_ALREADY_CONVERTED'
    );
  }
  if (req.status !== 'approved') {
    throw new AccountingError(
      409,
      `Requisition ${req.requisition_number} must be approved before converting to a Purchase Order (status: ${req.status})`,
      'REQUISITION_NOT_APPROVED'
    );
  }

  const vendorId = Number(input.vendorId);
  const vRes = await tx.query<{ id: number; company_name: string }>(
    `SELECT id, company_name FROM vendors WHERE company_id = $1 AND id = $2`,
    [companyId, vendorId]
  );
  if (vRes.rows.length === 0) throw new AccountingError(404, 'Vendor not found');

  const linesRes = await tx.query<{
    id: number;
    item_id: number | null;
    description: string;
    quantity: string;
    estimated_unit_cost: string;
  }>(
    `SELECT id, item_id, description, quantity::text, estimated_unit_cost::text
       FROM purchase_requisition_lines
      WHERE company_id = $1 AND requisition_id = $2
      ORDER BY line_order ASC, id ASC`,
    [companyId, requisitionId]
  );
  if (linesRes.rows.length === 0) {
    throw new AccountingError(400, 'Requisition has no lines to convert');
  }

  const ctx = await resolveWorkflowAccounts(tx, companyId, actor);
  const poDate = input.poDate ? assertIsoDate(input.poDate, 'poDate') : todayIsoDate();
  const expectedDate = input.expectedDate ? assertIsoDate(input.expectedDate, 'expectedDate') : null;
  const poNumber = await generateNextDocNumber(tx, companyId, 'purchase_orders', 'po_number', 'PO');

  const overrideByLine = new Map<number, { rate?: string | number; quantity?: string | number }>();
  const overrideByItem = new Map<number, { rate?: string | number; quantity?: string | number }>();
  for (const ov of input.lineOverrides ?? []) {
    if (ov.lineId) overrideByLine.set(Number(ov.lineId), ov);
    if (ov.itemId) overrideByItem.set(Number(ov.itemId), ov);
  }

  let total4 = 0n;
  const preparedLines: Array<{
    itemId: number | null;
    accountId: number;
    description: string;
    qty6: bigint;
    rate4: bigint;
    amt4: bigint;
  }> = [];

  for (const l of linesRes.rows) {
    const lid = Number(l.id);
    const itemId = l.item_id !== null ? Number(l.item_id) : null;
    const ov = overrideByLine.get(lid) ?? (itemId ? overrideByItem.get(itemId) : undefined);
    const qty6 = parseDecimal6(ov?.quantity ?? l.quantity);
    const rate4 = parseDecimal4(ov?.rate ?? l.estimated_unit_cost);
    const amt4 = multiplyQty6ByRate4(qty6, rate4, ctx.roundingMode);

    let accountId = ctx.inventory1200;
    if (itemId) {
      const itRes = await tx.query<{ asset_account_id: number }>(
        `SELECT asset_account_id FROM inventory_items WHERE company_id = $1 AND id = $2`,
        [companyId, itemId]
      );
      if (itRes.rows.length > 0) accountId = Number(itRes.rows[0].asset_account_id);
    }

    total4 += amt4;
    preparedLines.push({
      itemId,
      accountId,
      description: l.description,
      qty6,
      rate4,
      amt4,
    });
  }

  const poIns = await tx.query<{ id: number }>(
    `INSERT INTO purchase_orders (
       company_id, po_number, vendor_id, po_date, expected_date, status, total, requisition_id, notes
     ) VALUES ($1, $2, $3, $4::DATE, $5::DATE, 'open', $6::NUMERIC(19,4), $7, $8)
     RETURNING id`,
    [
      companyId,
      poNumber,
      vendorId,
      poDate,
      expectedDate,
      formatDecimal4(total4),
      requisitionId,
      input.notes?.trim() || `Converted from ${req.requisition_number}`,
    ]
  );
  const poId = Number(poIns.rows[0].id);

  const poLinesOut: any[] = [];
  for (let i = 0; i < preparedLines.length; i++) {
    const l = preparedLines[i];
    const lineIns = await tx.query<{ id: number }>(
      `INSERT INTO purchase_order_lines (
         company_id, purchase_order_id, line_order, item_id, account_id, description,
         quantity, rate, amount
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(19,6), $8::NUMERIC(19,4), $9::NUMERIC(19,4))
       RETURNING id`,
      [
        companyId,
        poId,
        i + 1,
        l.itemId,
        l.accountId,
        l.description,
        formatDecimal6(l.qty6),
        formatDecimal4(l.rate4),
        formatDecimal4(l.amt4),
      ]
    );
    poLinesOut.push({
      id: Number(lineIns.rows[0].id),
      itemId: l.itemId,
      accountId: l.accountId,
      description: l.description,
      quantity: Number(formatDecimal6(l.qty6)),
      rate: toMoneyNumber(l.rate4),
      amount: toMoneyNumber(l.amt4),
    });
  }

  await tx.query(
    `UPDATE purchase_requisitions SET status = 'converted' WHERE company_id = $1 AND id = $2`,
    [companyId, requisitionId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'REQUISITION_CONVERTED_TO_PO',
    tableName: 'purchase_orders',
    recordId: poId,
    newValues: { poNumber, requisitionId, requisitionNumber: req.requisition_number, total: formatDecimal4(total4) },
  });

  return {
    purchaseOrder: {
      id: poId,
      poNumber,
      requisitionId,
      vendorId,
      vendorName: vRes.rows[0].company_name,
      poDate,
      expectedDate,
      status: 'open',
      total: toMoneyNumber(total4),
      lines: poLinesOut,
    },
  };
}

// ============================================================================
// SUPPLIER BILL FROM PO (SUPPORTS BOTH PRE-RECEIPT BILL & POST-GR GRNI BILLING)
// ============================================================================

export async function createSupplierBillFromPo(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  poId: number,
  input: {
    billNumber?: string;
    billDate?: string;
    dueDate?: string;
    terms?: string | null;
    currencyCode?: string;
    exchangeRate?: string | number;
    memo?: string | null;
    idempotencyKey?: string | null;
    billLines?: Array<{ poLineId: number; billQty?: string | number; unitCost?: string | number; useTaxRate?: string | number }>;
  }
) {
  const idem = await checkRouteIdempotency<{ bill: any }>(
    tx,
    companyId,
    'po_bill_create',
    input.idempotencyKey,
    { poId, ...input }
  );
  if (idem.hit) return { bill: idem.response.bill, idempotentReplay: true };

  const poRes = await tx.query<{
    id: number;
    po_number: string;
    vendor_id: number;
    status: string;
  }>(
    `SELECT id, po_number, vendor_id, status
       FROM purchase_orders
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, poId]
  );
  if (poRes.rows.length === 0) throw new AccountingError(404, 'Purchase order not found');
  const po = poRes.rows[0];
  if (po.status === 'cancelled') {
    throw new AccountingError(409, `Cannot bill cancelled Purchase Order ${po.po_number}`, 'PO_CANCELLED');
  }

  const vRes = await tx.query<{ id: number; company_name: string; terms_label: string }>(
    `SELECT id, company_name, terms_label FROM vendors WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, Number(po.vendor_id)]
  );
  const vendor = vRes.rows[0];

  const poLinesRes = await tx.query<{
    id: number;
    item_id: number | null;
    account_id: number | null;
    description: string;
    quantity: string;
    received_qty: string;
    billed_qty: string;
    rate: string;
    class_id: number | null;
  }>(
    `SELECT id, item_id, account_id, description, quantity::text, received_qty::text,
            billed_qty::text, rate::text, class_id
       FROM purchase_order_lines
      WHERE company_id = $1 AND purchase_order_id = $2
      ORDER BY id ASC
      FOR UPDATE`,
    [companyId, poId]
  );

  const lineById = new Map<number, typeof poLinesRes.rows[0]>();
  for (const r of poLinesRes.rows) lineById.set(Number(r.id), r);

  const ctx = await resolveWorkflowAccounts(tx, companyId, actor);
  const billDate = input.billDate ? assertIsoDate(input.billDate, 'billDate') : todayIsoDate();
  const termsLabel = input.terms?.trim() || vendor.terms_label || 'Net 30';
  const netDays = termsLabel.toLowerCase().includes('receipt')
    ? 0
    : Number(termsLabel.match(/\d+/)?.[0] || 30);
  const dueDate = input.dueDate ? assertIsoDate(input.dueDate, 'dueDate') : addDaysToIso(billDate, netDays);
  if (dueDate < billDate) {
    throw new AccountingError(400, 'Bill dueDate cannot be earlier than billDate');
  }

  const fx = await resolveExchangeRate6(
    tx,
    companyId,
    input.currencyCode,
    ctx.baseCurrency,
    billDate,
    input.exchangeRate
  );

  const requested: Array<{
    poLineId: number;
    billQty?: string | number;
    unitCost?: string | number;
    useTaxRate?: string | number;
  }> = Array.isArray(input.billLines) && input.billLines.length > 0
    ? input.billLines
    : poLinesRes.rows.map(l => ({
        poLineId: Number(l.id),
        billQty: formatDecimal6(parseDecimal6(l.quantity) - parseDecimal6(l.billed_qty)),
      }));

  const preparedLines: Array<{
    poLineId: number;
    itemId: number | null;
    isStocked: boolean;
    accountId: number;
    description: string;
    qty6: bigint;
    unitCost6: bigint;
    amountForeign4: bigint;
    amountBase4: bigint;
    useTaxRate6: bigint;
    useTaxBase4: bigint;
    classId: number | null;
    newBilledQty6: bigint;
    receivedUnbilledBase4: bigint;
    awaitingReceiptBase4: bigint;
    expenseDirectBase4: bigint;
  }> = [];

  let foreignTotal4 = 0n;
  let baseTotal4 = 0n;
  let anyAwaitingReceipt = false;

  for (const reqLine of requested) {
    const poLine = lineById.get(Number(reqLine.poLineId));
    if (!poLine) throw new AccountingError(404, `PO line ${reqLine.poLineId} not found`);
    const ordered6 = parseDecimal6(poLine.quantity);
    const prevBilled6 = parseDecimal6(poLine.billed_qty);
    const prevReceived6 = parseDecimal6(poLine.received_qty);
    const billQty6 =
      reqLine.billQty !== undefined ? parseDecimal6(reqLine.billQty) : ordered6 - prevBilled6;
    if (billQty6 <= 0n) continue;
    if (prevBilled6 + billQty6 > ordered6) {
      throw new AccountingError(
        409,
        `Cannot bill ${formatDecimal6(billQty6)} for "${poLine.description}"; only ${formatDecimal6(ordered6 - prevBilled6)} remains unbilled`,
        'OVER_BILLED_PO_LINE'
      );
    }

    const rate6 = parseDecimal6(reqLine.unitCost ?? poLine.rate);
    const rate4 = divRoundBigInt(rate6, 100n, ctx.roundingMode);
    const amountForeign4 = multiplyQty6ByRate4(billQty6, rate4, ctx.roundingMode);
    const amountBase4 = convertForeign4ToBase4(amountForeign4, fx.rate6, ctx.roundingMode);
    const useTaxRate6 = parseDecimal6(reqLine.useTaxRate ?? 0);
    const useTaxBase4 = computeTax4(amountBase4, useTaxRate6, ctx.roundingMode);

    let isStocked = false;
    const itemId = poLine.item_id !== null ? Number(poLine.item_id) : null;
    let expenseAcct = poLine.account_id ? Number(poLine.account_id) : ctx.cogs5000;
    if (itemId !== null) {
      const itRes = await tx.query<{ item_type: string }>(
        `SELECT item_type FROM inventory_items WHERE company_id = $1 AND id = $2`,
        [companyId, itemId]
      );
      if (itRes.rows.length > 0 && ['raw_material', 'stationery'].includes(itRes.rows[0].item_type)) {
        isStocked = true;
      }
    }

    // Split qty into: already received but unbilled (clears 2055 GRNI) vs not yet received (1210 Purchases In Transit)
    let receivedUnbilledBase4 = 0n;
    let awaitingReceiptBase4 = 0n;
    let expenseDirectBase4 = 0n;

    if (isStocked) {
      const unbilledReceivedQty6 = prevReceived6 > prevBilled6 ? prevReceived6 - prevBilled6 : 0n;
      const qtyClearingGrni6 = unbilledReceivedQty6 < billQty6 ? unbilledReceivedQty6 : billQty6;
      const qtyAwaitingGr6 = billQty6 - qtyClearingGrni6;

      if (qtyClearingGrni6 > 0n) {
        receivedUnbilledBase4 =
          qtyClearingGrni6 === billQty6
            ? amountBase4
            : divRoundBigInt(amountBase4 * qtyClearingGrni6, billQty6, ctx.roundingMode);
      }
      awaitingReceiptBase4 = amountBase4 - receivedUnbilledBase4;
      if (qtyAwaitingGr6 > 0n) anyAwaitingReceipt = true;
      expenseAcct = awaitingReceiptBase4 > 0n ? ctx.purchasesInTransit1210 : ctx.grni2055;
    } else {
      expenseDirectBase4 = amountBase4;
    }

    foreignTotal4 += amountForeign4;
    baseTotal4 += amountBase4;

    preparedLines.push({
      poLineId: Number(poLine.id),
      itemId,
      isStocked,
      accountId: expenseAcct,
      description: poLine.description,
      qty6: billQty6,
      unitCost6: rate6,
      amountForeign4,
      amountBase4,
      useTaxRate6,
      useTaxBase4,
      classId: poLine.class_id !== null ? Number(poLine.class_id) : null,
      newBilledQty6: prevBilled6 + billQty6,
      receivedUnbilledBase4,
      awaitingReceiptBase4,
      expenseDirectBase4,
    });
  }

  if (preparedLines.length === 0) {
    throw new AccountingError(400, 'No unbilled PO quantities remain to bill');
  }

  const billNumber =
    input.billNumber?.trim() || (await generateNextDocNumber(tx, companyId, 'bills', 'bill_number', 'BILL'));

  const dupBill = await tx.query<{ id: number }>(
    `SELECT id FROM bills WHERE company_id = $1 AND vendor_id = $2 AND LOWER(bill_number) = LOWER($3) LIMIT 1`,
    [companyId, Number(po.vendor_id), billNumber]
  );
  if (dupBill.rows.length > 0) {
    throw new AccountingError(409, `Duplicate bill number ${billNumber} for vendor`, 'DUPLICATE_BILL_NUMBER');
  }

  const insBill = await tx.query<{ id: number }>(
    `INSERT INTO bills (
       company_id, bill_number, vendor_id, bill_date, due_date, terms_label, status,
       total, amount_paid, balance_due, purchase_order_id, awaiting_receipt,
       currency_code, exchange_rate, foreign_total, foreign_balance_due, memo
     ) VALUES (
       $1, $2, $3, $4::DATE, $5::DATE, $6, 'open',
       $7::NUMERIC(19,4), 0.0000, $7::NUMERIC(19,4), $8, $9,
       $10, $11::NUMERIC(19,6), $12::NUMERIC(19,4), $12::NUMERIC(19,4), $13
     ) RETURNING id`,
    [
      companyId,
      billNumber,
      Number(po.vendor_id),
      billDate,
      dueDate,
      termsLabel,
      formatDecimal4(baseTotal4),
      poId,
      anyAwaitingReceipt,
      fx.currencyCode,
      fx.rateStr,
      formatDecimal4(foreignTotal4),
      input.memo?.trim() || `Supplier bill against PO ${po.po_number}`,
    ]
  );
  const billId = Number(insBill.rows[0].id);

  const debitsByAccount = new Map<number, bigint>();
  let totalUseTax4 = 0n;

  for (let i = 0; i < preparedLines.length; i++) {
    const l = preparedLines[i];
    await tx.query(
      `INSERT INTO bill_lines (
         company_id, bill_id, line_order, account_id, item_id, description,
         quantity, unit_cost, amount, use_tax_rate, class_id, po_line_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(19,6), $8::NUMERIC(19,6), $9::NUMERIC(19,4), $10::NUMERIC(9,6), $11, $12)`,
      [
        companyId,
        billId,
        i + 1,
        l.accountId,
        l.itemId,
        l.description,
        formatDecimal6(l.qty6),
        formatDecimal6(l.unitCost6),
        formatDecimal4(l.amountForeign4),
        formatDecimal6(l.useTaxRate6),
        l.classId,
        l.poLineId,
      ]
    );

    await tx.query(
      `UPDATE purchase_order_lines
          SET billed_qty = $3::NUMERIC(19,6),
              billed_amount = billed_amount + $4::NUMERIC(19,4)
        WHERE company_id = $1 AND id = $2`,
      [companyId, l.poLineId, formatDecimal6(l.newBilledQty6), formatDecimal4(l.amountBase4)]
    );

    if (l.receivedUnbilledBase4 > 0n) {
      debitsByAccount.set(
        ctx.grni2055,
        (debitsByAccount.get(ctx.grni2055) ?? 0n) + l.receivedUnbilledBase4
      );
    }
    if (l.awaitingReceiptBase4 > 0n) {
      debitsByAccount.set(
        ctx.purchasesInTransit1210,
        (debitsByAccount.get(ctx.purchasesInTransit1210) ?? 0n) + l.awaitingReceiptBase4 + l.useTaxBase4
      );
    }
    if (l.expenseDirectBase4 > 0n) {
      debitsByAccount.set(
        l.accountId,
        (debitsByAccount.get(l.accountId) ?? 0n) + l.expenseDirectBase4 + l.useTaxBase4
      );
    } else if (l.receivedUnbilledBase4 > 0n && l.useTaxBase4 > 0n) {
      debitsByAccount.set(
        ctx.cogs5000,
        (debitsByAccount.get(ctx.cogs5000) ?? 0n) + l.useTaxBase4
      );
    }
    totalUseTax4 += l.useTaxBase4;
  }

  const jeLines: JournalLineInput[] = [];
  for (const [acctId, amt4] of debitsByAccount.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: acctId,
        debit: formatDecimal4(amt4),
        credit: '0.0000',
        description: `Bill ${billNumber} (PO ${po.po_number}) — ${vendor.company_name}`,
        partyType: 'vendor',
        partyId: Number(po.vendor_id),
      });
    }
  }
  jeLines.push({
    accountId: ctx.ap2000,
    debit: '0.0000',
    credit: formatDecimal4(baseTotal4),
    description: `AP — Bill ${billNumber} (${vendor.company_name})`,
    partyType: 'vendor',
    partyId: Number(po.vendor_id),
  });
  if (totalUseTax4 > 0n) {
    jeLines.push({
      accountId: ctx.salesTax2200,
      debit: '0.0000',
      credit: formatDecimal4(totalUseTax4),
      description: `Use Tax Payable — Bill ${billNumber}`,
    });
  }

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: billDate,
    description: `Supplier Bill ${billNumber} (PO ${po.po_number}) — ${vendor.company_name}`,
    reference: billNumber,
    sourceType: 'bill',
    sourceId: billId,
    idempotencyKey: `bill-po-${companyId}-${billId}`,
    lines: jeLines,
  });

  await tx.query(
    `UPDATE bills SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, billId, posted.transaction.id]
  );

  await recalculateVendorBalance(tx, companyId, Number(po.vendor_id));

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'BILL_FROM_PO_CREATED',
    tableName: 'bills',
    recordId: billId,
    newValues: {
      billNumber,
      purchaseOrderId: poId,
      poNumber: po.po_number,
      awaitingReceipt: anyAwaitingReceipt,
      total: formatDecimal4(baseTotal4),
      journalTxnId: posted.transaction.id,
    },
  });

  const billOut = {
    id: billId,
    billNumber,
    vendorId: Number(po.vendor_id),
    vendorName: vendor.company_name,
    purchaseOrderId: poId,
    billDate,
    dueDate,
    status: 'open',
    awaitingReceipt: anyAwaitingReceipt,
    total: toMoneyNumber(baseTotal4),
    balanceDue: toMoneyNumber(baseTotal4),
    journalTxnId: posted.transaction.id,
  };
  await saveRouteIdempotency(tx, companyId, 'po_bill_create', input.idempotencyKey, idem.payloadHash, 201, { bill: billOut }, actor.userId);
  return { bill: billOut, idempotentReplay: false };
}

// ============================================================================
// GOODS RECEIPTS (INVENTORY RECEIPT, CONVERSION & 3-WAY GRNI / TRANSIT CLEARING)
// ============================================================================

export async function listGoodsReceipts(tx: Transaction, companyId: number, purchaseOrderId?: number) {
  const hdrRes = await tx.query<any>(
    `SELECT gr.id, gr.receipt_number, gr.purchase_order_id, po.po_number,
            gr.bill_id, gr.vendor_id, v.company_name AS vendor_name,
            gr.receipt_date::text, gr.received_by, gr.status, gr.journal_txn_id, gr.notes, gr.created_at::text
       FROM goods_receipts gr
       JOIN purchase_orders po ON po.company_id = gr.company_id AND po.id = gr.purchase_order_id
       JOIN vendors v ON v.company_id = gr.company_id AND v.id = gr.vendor_id
      WHERE gr.company_id = $1 ${purchaseOrderId ? 'AND gr.purchase_order_id = $2' : ''}
      ORDER BY gr.receipt_date DESC, gr.id DESC`,
    purchaseOrderId ? [companyId, purchaseOrderId] : [companyId]
  );
  if (hdrRes.rows.length === 0) return [];

  const ids = hdrRes.rows.map((r: any) => Number(r.id));
  const linesRes = await tx.query<any>(
    `SELECT l.id, l.goods_receipt_id, l.po_line_id, l.item_id, ii.sku, ii.name AS item_name,
            l.description, l.quantity_received::text, l.unit_cost::text
       FROM goods_receipt_lines l
       LEFT JOIN inventory_items ii ON ii.company_id = l.company_id AND ii.id = l.item_id
      WHERE l.company_id = $1 AND l.goods_receipt_id = ANY($2::BIGINT[])
      ORDER BY l.goods_receipt_id ASC, l.id ASC`,
    [companyId, ids]
  );

  const linesByGr = new Map<number, any[]>();
  for (const l of linesRes.rows) {
    const gid = Number(l.goods_receipt_id);
    const arr = linesByGr.get(gid) ?? [];
    arr.push({
      id: Number(l.id),
      poLineId: Number(l.po_line_id),
      itemId: l.item_id !== null ? Number(l.item_id) : null,
      sku: l.sku || null,
      itemName: l.item_name || null,
      description: l.description,
      quantityReceived: Number(l.quantity_received),
      unitCost: Number(l.unit_cost),
    });
    linesByGr.set(gid, arr);
  }

  return hdrRes.rows.map((r: any) => ({
    id: Number(r.id),
    receiptNumber: r.receipt_number,
    purchaseOrderId: Number(r.purchase_order_id),
    poNumber: r.po_number,
    billId: r.bill_id !== null ? Number(r.bill_id) : null,
    vendorId: Number(r.vendor_id),
    vendorName: r.vendor_name,
    receiptDate: r.receipt_date,
    receivedBy: r.received_by !== null ? Number(r.received_by) : null,
    status: r.status,
    journalTxnId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
    notes: r.notes || '',
    lines: linesByGr.get(Number(r.id)) ?? [],
  }));
}

export async function recordGoodsReceipt(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    purchaseOrderId: number;
    billId?: number | null;
    receiptDate?: string;
    receiptNumber?: string;
    notes?: string | null;
    idempotencyKey?: string | null;
    lines?: Array<{ poLineId: number; receiveQty?: string | number; unitCost?: string | number }>;
  }
) {
  const idem = await checkRouteIdempotency<{ goodsReceipt: any; poStatus: string }>(
    tx,
    companyId,
    'goods_receipt_create',
    input.idempotencyKey,
    input
  );
  if (idem.hit) return { ...idem.response, idempotentReplay: true };

  const poId = Number(input.purchaseOrderId);
  const poRes = await tx.query<{
    id: number;
    po_number: string;
    vendor_id: number;
    status: string;
  }>(
    `SELECT id, po_number, vendor_id, status
       FROM purchase_orders
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, poId]
  );
  if (poRes.rows.length === 0) throw new AccountingError(404, 'Purchase order not found');
  const po = poRes.rows[0];
  if (['closed', 'cancelled'].includes(po.status)) {
    throw new AccountingError(
      409,
      `Purchase order ${po.po_number} cannot receive goods in status '${po.status}'`,
      'PO_NOT_OPEN_FOR_RECEIPT'
    );
  }

  let linkedBillId: number | null = input.billId ? Number(input.billId) : null;
  if (linkedBillId !== null) {
    const bCheck = await tx.query<{ id: number; vendor_id: number; purchase_order_id: number | null }>(
      `SELECT id, vendor_id, purchase_order_id FROM bills WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, linkedBillId]
    );
    if (bCheck.rows.length === 0) throw new AccountingError(404, 'Linked bill not found');
    if (Number(bCheck.rows[0].vendor_id) !== Number(po.vendor_id)) {
      throw new AccountingError(400, 'Linked bill belongs to a different vendor');
    }
  }

  const poLinesRes = await tx.query<{
    id: number;
    item_id: number | null;
    account_id: number | null;
    description: string;
    quantity: string;
    received_qty: string;
    billed_qty: string;
    rate: string;
  }>(
    `SELECT id, item_id, account_id, description, quantity::text, received_qty::text,
            billed_qty::text, rate::text
       FROM purchase_order_lines
      WHERE company_id = $1 AND purchase_order_id = $2
      ORDER BY id ASC
      FOR UPDATE`,
    [companyId, poId]
  );
  const lineById = new Map<number, typeof poLinesRes.rows[0]>();
  for (const r of poLinesRes.rows) lineById.set(Number(r.id), r);

  const requestedLines: Array<{
    poLineId: number;
    receiveQty?: string | number;
    unitCost?: string | number;
  }> = Array.isArray(input.lines) && input.lines.length > 0
    ? input.lines
    : poLinesRes.rows.map(l => ({
        poLineId: Number(l.id),
        receiveQty: formatDecimal6(parseDecimal6(l.quantity) - parseDecimal6(l.received_qty)),
      }));

  const ctx = await resolveWorkflowAccounts(tx, companyId, actor);
  const receiptDate = input.receiptDate ? assertIsoDate(input.receiptDate, 'receiptDate') : todayIsoDate();
  const receiptNumber =
    input.receiptNumber?.trim() ||
    (await generateNextDocNumber(tx, companyId, 'goods_receipts', 'receipt_number', 'GR'));

  const hdrRes = await tx.query<{ id: number }>(
    `INSERT INTO goods_receipts (
       company_id, receipt_number, purchase_order_id, bill_id, vendor_id,
       receipt_date, received_by, status, notes
     ) VALUES ($1, $2, $3, $4, $5, $6::DATE, $7, 'received', $8)
     RETURNING id`,
    [
      companyId,
      receiptNumber,
      poId,
      linkedBillId,
      Number(po.vendor_id),
      receiptDate,
      actor.userId,
      input.notes?.trim() || null,
    ]
  );
  const grId = Number(hdrRes.rows[0].id);

  const jeDebits = new Map<number, bigint>();
  let creditTransit4 = 0n;
  let creditGrni4 = 0n;
  const createdLines: any[] = [];

  for (const reqLine of requestedLines) {
    const poLine = lineById.get(Number(reqLine.poLineId));
    if (!poLine) throw new AccountingError(404, `PO line ${reqLine.poLineId} not found`);

    const ordered6 = parseDecimal6(poLine.quantity);
    const prevReceived6 = parseDecimal6(poLine.received_qty);
    const prevBilled6 = parseDecimal6(poLine.billed_qty);
    const receiveQty6 =
      reqLine.receiveQty !== undefined ? parseDecimal6(reqLine.receiveQty) : ordered6 - prevReceived6;
    if (receiveQty6 <= 0n) continue;

    if (prevReceived6 + receiveQty6 > ordered6) {
      throw new AccountingError(
        409,
        `Cannot receive ${formatDecimal6(receiveQty6)} for "${poLine.description}"; only ${formatDecimal6(ordered6 - prevReceived6)} remains open`,
        'OVER_RECEIPT_BLOCKED'
      );
    }

    const unitCost6 = parseDecimal6(reqLine.unitCost ?? poLine.rate);
    const unitCost4 = divRoundBigInt(unitCost6, 100n, ctx.roundingMode);
    const receiptVal4 = multiplyQty6ByRate4(receiveQty6, unitCost4, ctx.roundingMode);

    await tx.query(
      `INSERT INTO goods_receipt_lines (
         company_id, goods_receipt_id, po_line_id, item_id, description, quantity_received, unit_cost
       ) VALUES ($1, $2, $3, $4, $5, $6::NUMERIC(19,6), $7::NUMERIC(19,6))`,
      [
        companyId,
        grId,
        Number(poLine.id),
        poLine.item_id !== null ? Number(poLine.item_id) : null,
        poLine.description,
        formatDecimal6(receiveQty6),
        formatDecimal6(unitCost6),
      ]
    );

    const nextReceived6 = prevReceived6 + receiveQty6;
    await tx.query(
      `UPDATE purchase_order_lines
          SET received_qty = $3::NUMERIC(19,6)
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(poLine.id), formatDecimal6(nextReceived6)]
    );

    // Split receipt value between pre-billed transit clearing (1210) vs unbilled GRNI (2055)
    const preBilledRemaining6 = prevBilled6 > prevReceived6 ? prevBilled6 - prevReceived6 : 0n;
    const qtyPreBilled6 = preBilledRemaining6 < receiveQty6 ? preBilledRemaining6 : receiveQty6;
    let transitAmt4 = 0n;
    if (qtyPreBilled6 > 0n) {
      transitAmt4 =
        qtyPreBilled6 === receiveQty6
          ? receiptVal4
          : divRoundBigInt(receiptVal4 * qtyPreBilled6, receiveQty6, ctx.roundingMode);
    }
    const grniAmt4 = receiptVal4 - transitAmt4;
    creditTransit4 += transitAmt4;
    creditGrni4 += grniAmt4;

    let debitAccountId = poLine.account_id ? Number(poLine.account_id) : ctx.inventory1200;

    if (poLine.item_id !== null) {
      const itemId = Number(poLine.item_id);
      const itRes = await tx.query<{
        id: number;
        item_type: string;
        on_hand: string;
        avg_cost: string;
        unit_cost: string;
        asset_account_id: number;
      }>(
        `SELECT id, item_type, on_hand::text, avg_cost::text, unit_cost::text, asset_account_id
           FROM inventory_items
          WHERE company_id = $1 AND id = $2
          FOR UPDATE`,
        [companyId, itemId]
      );
      if (itRes.rows.length > 0) {
        const it = itRes.rows[0];
        if (['raw_material', 'stationery'].includes(it.item_type)) {
          debitAccountId = Number(it.asset_account_id) || ctx.inventory1200;
          const prevQty6 = parseDecimal6(it.on_hand);
          const prevAvg6 = parseDecimal6(it.avg_cost);
          const prevUnit6 = parseDecimal6(it.unit_cost);
          const effectivePrevCost6 = prevAvg6 > 0n ? prevAvg6 : prevUnit6;
          const prevVal6 = divRoundBigInt(prevQty6 * effectivePrevCost6, 1000000n, ctx.roundingMode);
          const newVal6 = prevVal6 + receiptVal4 * 100n;
          const newQty6 = prevQty6 + receiveQty6;
          const newAvg6 = divRoundBigInt(newVal6 * 1000000n, newQty6, ctx.roundingMode);

          await tx.query(
            `UPDATE inventory_items
                SET on_hand = $3::NUMERIC(19,6),
                    avg_cost = $4::NUMERIC(19,6),
                    unit_cost = $5::NUMERIC(19,6)
              WHERE company_id = $1 AND id = $2`,
            [companyId, itemId, formatDecimal6(newQty6), formatDecimal6(newAvg6), formatDecimal6(unitCost6)]
          );

          await tx.query(
            `INSERT INTO inventory_movements (
               company_id, item_id, movement_type, quantity_delta, unit_cost,
               balance_qty, balance_avg_cost, source_type, source_id
             ) VALUES ($1, $2, 'purchase', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'goods_receipt', $7)`,
            [
              companyId,
              itemId,
              formatDecimal6(receiveQty6),
              formatDecimal6(unitCost6),
              formatDecimal6(newQty6),
              formatDecimal6(newAvg6),
              grId,
            ]
          );
        }
      }
    }

    if (receiptVal4 > 0n) {
      jeDebits.set(debitAccountId, (jeDebits.get(debitAccountId) ?? 0n) + receiptVal4);
    }

    createdLines.push({
      poLineId: Number(poLine.id),
      itemId: poLine.item_id !== null ? Number(poLine.item_id) : null,
      description: poLine.description,
      quantityReceived: Number(formatDecimal6(receiveQty6)),
      unitCost: Number(formatDecimal6(unitCost6)),
      amount: toMoneyNumber(receiptVal4),
    });
  }

  if (createdLines.length === 0) {
    throw new AccountingError(400, 'No open PO lines selected to receive');
  }

  const jeLines: JournalLineInput[] = [];
  for (const [acctId, amt4] of jeDebits.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: acctId,
        debit: formatDecimal4(amt4),
        credit: '0.0000',
        description: `Goods Receipt ${receiptNumber} — PO ${po.po_number}`,
        partyType: 'vendor',
        partyId: Number(po.vendor_id),
      });
    }
  }
  if (creditTransit4 > 0n) {
    jeLines.push({
      accountId: ctx.purchasesInTransit1210,
      debit: '0.0000',
      credit: formatDecimal4(creditTransit4),
      description: `Clear Purchases In Transit — GR ${receiptNumber}`,
      partyType: 'vendor',
      partyId: Number(po.vendor_id),
    });
  }
  if (creditGrni4 > 0n) {
    jeLines.push({
      accountId: ctx.grni2055,
      debit: '0.0000',
      credit: formatDecimal4(creditGrni4),
      description: `Accrued Purchases (GRNI) — GR ${receiptNumber}`,
      partyType: 'vendor',
      partyId: Number(po.vendor_id),
    });
  }

  let journalTxnId: number | null = null;
  if (jeLines.length > 0) {
    const posted = await postJournalEntry(tx, companyId, actor, {
      txnDate: receiptDate,
      description: `Goods Receipt ${receiptNumber} (PO ${po.po_number})`,
      reference: receiptNumber,
      sourceType: 'goods_receipt',
      sourceId: grId,
      idempotencyKey: `gr-post-${companyId}-${grId}`,
      lines: jeLines,
    });
    journalTxnId = posted.transaction.id;
    await tx.query(
      `UPDATE goods_receipts SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`,
      [companyId, grId, journalTxnId]
    );
  }

  // Re-evaluate PO completion status and clear awaiting_receipt flag on linked bills when fully received
  const remCheck = await tx.query<{ remaining_lines: string }>(
    `SELECT COUNT(*)::text AS remaining_lines
       FROM purchase_order_lines
      WHERE company_id = $1 AND purchase_order_id = $2 AND received_qty < quantity`,
    [companyId, poId]
  );
  const nextPoStatus = Number(remCheck.rows[0].remaining_lines) === 0 ? 'closed' : 'partially_received';
  await tx.query(
    `UPDATE purchase_orders SET status = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, poId, nextPoStatus]
  );
  if (nextPoStatus === 'closed') {
    await tx.query(
      `UPDATE bills SET awaiting_receipt = FALSE WHERE company_id = $1 AND purchase_order_id = $2`,
      [companyId, poId]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'GOODS_RECEIPT_POSTED',
    tableName: 'goods_receipts',
    recordId: grId,
    newValues: {
      receiptNumber,
      purchaseOrderId: poId,
      poStatus: nextPoStatus,
      journalTxnId,
      clearedTransit: formatDecimal4(creditTransit4),
      accruedGrni: formatDecimal4(creditGrni4),
    },
  });

  const payload = {
    goodsReceipt: {
      id: grId,
      receiptNumber,
      purchaseOrderId: poId,
      poNumber: po.po_number,
      billId: linkedBillId,
      receiptDate,
      journalTxnId,
      lines: createdLines,
    },
    poStatus: nextPoStatus,
  };
  await saveRouteIdempotency(tx, companyId, 'goods_receipt_create', input.idempotencyKey, idem.payloadHash, 201, payload, actor.userId);
  return { ...payload, idempotentReplay: false };
}
