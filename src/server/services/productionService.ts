import { Transaction } from '@electric-sql/pglite';
import { writeAuditLog } from '../audit.ts';
import {
  AccountingError,
  ActorContext,
  JournalLineInput,
  postJournalEntry,
} from './accountingEngine.ts';
import {
  assertIsoDate,
  checkRouteIdempotency,
  divRoundBigInt,
  formatDecimal6,
  generateNextDocNumber,
  parseDecimal6,
  resolveWorkflowAccounts,
  saveRouteIdempotency,
  todayIsoDate,
} from './commercialHelpers.ts';
import {
  formatDecimal4,
  parseDecimal4,
  RoundingMode,
  toMoneyNumber,
} from '../lib/decimal.ts';
import {
  calculatePhotocopyPaper,
  lookupPaperStockFromDb,
  PhotocopyPlacementMode,
} from './paperCalc.ts';
import {
  calculateToner,
  lookupTonerAndMachineFromDb,
  TonerColorMode,
} from './tonerCalc.ts';
import {
  calculateBookPrintingWorkflow,
  calculatePhotocopyWorkflow,
  calculatePrintingServiceWorkflow,
  calculateTypeAndPrintingWorkflow,
} from './printingWorkflows.ts';
import { createInvoiceOrSalesReceipt } from './salesService.ts';

// ============================================================================
// PRINTING MACHINES
// ============================================================================

export async function listMachines(tx: Transaction, companyId: number) {
  const res = await tx.query<any>(
    `SELECT id, machine_code, name, machine_type, manufacturer, model,
            supports_duplex, max_paper_size, speed_ppm, click_cost_per_imp::text,
            meter_impressions::text, status, created_at::text
       FROM printing_machines
      WHERE company_id = $1
      ORDER BY id ASC`,
    [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    machineCode: r.machine_code,
    name: r.name,
    machineType: r.machine_type,
    manufacturer: r.manufacturer || '',
    model: r.model || '',
    supportsDuplex: Boolean(r.supports_duplex),
    maxPaperSize: r.max_paper_size,
    speedPpm: r.speed_ppm !== null ? Number(r.speed_ppm) : null,
    clickCostPerImp: Number(r.click_cost_per_imp),
    meterImpressions: Number(r.meter_impressions),
    status: r.status,
  }));
}

export async function createMachine(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    machineCode: string;
    name: string;
    machineType: string;
    manufacturer?: string | null;
    model?: string | null;
    supportsDuplex?: boolean;
    maxPaperSize?: string;
    speedPpm?: number | null;
    clickCostPerImp?: string | number;
  }
) {
  const machineCode = String(input.machineCode || '').trim();
  const name = String(input.name || '').trim();
  if (!machineCode || !name) {
    throw new AccountingError(400, 'machineCode and name are required');
  }
  const ins = await tx.query<{ id: number }>(
    `INSERT INTO printing_machines (
       company_id, machine_code, name, machine_type, manufacturer, model,
       supports_duplex, max_paper_size, speed_ppm, click_cost_per_imp, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::NUMERIC(19,6), 'active')
     RETURNING id`,
    [
      companyId,
      machineCode,
      name,
      input.machineType || 'digital_press',
      input.manufacturer?.trim() || null,
      input.model?.trim() || null,
      input.supportsDuplex !== undefined ? Boolean(input.supportsDuplex) : true,
      input.maxPaperSize || 'A3',
      input.speedPpm ? Number(input.speedPpm) : null,
      formatDecimal6(parseDecimal6(input.clickCostPerImp ?? 0)),
    ]
  );
  const id = Number(ins.rows[0].id);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_MACHINE_CREATED',
    tableName: 'printing_machines',
    recordId: id,
    newValues: { machineCode, name, machineType: input.machineType || 'digital_press' },
  });
  const list = await listMachines(tx, companyId);
  return list.find(m => m.id === id)!;
}

// ============================================================================
// PRINTING JOBS & SHARED PAPER/TONER COSTING
// ============================================================================

function toNumber6(s: string | number | null | undefined): number {
  return Number(s ?? 0);
}

function getEffectivePurchaseUnitCost6(item: { avg_cost: string; unit_cost: string }): bigint {
  const avg6 = parseDecimal6(item.avg_cost);
  return avg6 > 0n ? avg6 : parseDecimal6(item.unit_cost);
}

function usageToPurchaseUnits6(usageQty6: bigint, factor6: bigint, mode: RoundingMode): bigint {
  if (factor6 <= 0n) return usageQty6;
  return divRoundBigInt(usageQty6 * 1000000n, factor6, mode);
}

export async function listPrintingJobs(tx: Transaction, companyId: number) {
  const res = await tx.query<any>(
    `SELECT j.*, j.job_date::text AS job_date_text,
            j.budget_approved_at::text AS budget_approved_at_text,
            j.cancelled_at::text AS cancelled_at_text
       FROM printing_jobs j
      WHERE j.company_id = $1
      ORDER BY j.id DESC`,
    [companyId]
  );
  if (res.rows.length === 0) return [];
  const ids = res.rows.map((r: any) => Number(r.id));

  const matRes = await tx.query<any>(
    `SELECT m.*, ii.sku, ii.name AS item_name
       FROM job_material_requirements m
       JOIN inventory_items ii ON ii.company_id = m.company_id AND ii.id = m.raw_material_item_id
      WHERE m.company_id = $1 AND m.printing_job_id = ANY($2::BIGINT[])
      ORDER BY m.printing_job_id ASC, m.id ASC`,
    [companyId, ids]
  );
  const matsByJob = new Map<number, any[]>();
  for (const m of matRes.rows) {
    const jid = Number(m.printing_job_id);
    const arr = matsByJob.get(jid) ?? [];
    arr.push({
      id: Number(m.id),
      rawMaterialItemId: Number(m.raw_material_item_id),
      sku: m.sku,
      itemName: m.item_name,
      materialRole: m.material_role,
      usageUnit: m.usage_unit,
      plannedUsageQty: toNumber6(m.planned_usage_qty),
      plannedUnitCost: toNumber6(m.planned_unit_cost),
      plannedTotalCost: toMoneyNumber(parseDecimal4(m.planned_total_cost)),
      reservedUsageQty: toNumber6(m.reserved_usage_qty),
      issuedUsageQty: toNumber6(m.issued_usage_qty),
      actualGoodUsageQty: toNumber6(m.actual_good_usage_qty),
      wasteUsageQty: toNumber6(m.waste_usage_qty),
      returnedUsageQty: toNumber6(m.returned_usage_qty),
      issuedAvgUnitCost: toNumber6(m.issued_avg_unit_cost),
      wasteReason: m.waste_reason || null,
    });
    matsByJob.set(jid, arr);
  }

  return res.rows.map((r: any) => ({
    id: Number(r.id),
    jobNumber: r.job_number,
    jobType: r.job_type,
    customerId: r.customer_id !== null ? Number(r.customer_id) : null,
    customerName: r.customer_name,
    salesEstimateId: r.sales_estimate_id !== null ? Number(r.sales_estimate_id) : null,
    machineId: r.machine_id !== null ? Number(r.machine_id) : null,
    rawPaperItemId: Number(r.raw_paper_item_id),
    rawTonerItemId: Number(r.raw_toner_item_id),
    title: r.title,
    pages: Number(r.pages),
    copies: Number(r.copies),
    printSide: r.print_side,
    orderedQty: Number(r.ordered_qty),
    producedGoodQty: Number(r.produced_good_qty),
    qcApprovedQty: Number(r.qc_approved_qty),
    deliveredQty: Number(r.delivered_qty),
    invoicedQty: Number(r.invoiced_qty),
    sheetsUsed: toNumber6(r.sheets_used),
    impressionsUsed: toNumber6(r.impressions_used),
    paperCost: toMoneyNumber(parseDecimal4(r.paper_cost)),
    tonerCost: toMoneyNumber(parseDecimal4(r.toner_cost)),
    extraCost: toMoneyNumber(parseDecimal4(r.extra_cost)),
    totalCost: toMoneyNumber(parseDecimal4(r.total_cost)),
    manualSellingPrice: toMoneyNumber(parseDecimal4(r.manual_selling_price)),
    profit: toMoneyNumber(parseDecimal4(r.profit)),
    approvedBudgetMaterial: toMoneyNumber(parseDecimal4(r.approved_budget_material)),
    approvedBudgetLabour: toMoneyNumber(parseDecimal4(r.approved_budget_labour)),
    approvedBudgetMachine: toMoneyNumber(parseDecimal4(r.approved_budget_machine)),
    approvedBudgetTotal: toMoneyNumber(parseDecimal4(r.approved_budget_total)),
    budgetApprovedBy: r.budget_approved_by !== null ? Number(r.budget_approved_by) : null,
    budgetApprovedAt: r.budget_approved_at_text || null,
    actualMaterialCost: toMoneyNumber(parseDecimal4(r.actual_material_cost)),
    actualWasteCost: toMoneyNumber(parseDecimal4(r.actual_waste_cost)),
    actualLabourCost: toMoneyNumber(parseDecimal4(r.actual_labour_cost)),
    actualMachineCost: toMoneyNumber(parseDecimal4(r.actual_machine_cost)),
    wipCostAccumulated: toMoneyNumber(parseDecimal4(r.wip_cost_accumulated)),
    wipCostRelieved: toMoneyNumber(parseDecimal4(r.wip_cost_relieved)),
    reprintOfJobId: r.reprint_of_job_id !== null ? Number(r.reprint_of_job_id) : null,
    reprintReason: r.reprint_reason || null,
    cancellationReason: r.cancellation_reason || null,
    jobDate: r.job_date_text,
    status: r.status,
    invoiceId: r.invoice_id !== null ? Number(r.invoice_id) : null,
    wipJournalTxnId: r.wip_journal_txn_id !== null ? Number(r.wip_journal_txn_id) : null,
    cogsJournalTxnId: r.cogs_journal_txn_id !== null ? Number(r.cogs_journal_txn_id) : null,
    notes: r.notes || '',
    materialRequirements: matsByJob.get(Number(r.id)) ?? [],
  }));
}

export async function getPrintingJobById(tx: Transaction, companyId: number, jobId: number) {
  const jobs = await listPrintingJobs(tx, companyId);
  const found = jobs.find(j => j.id === jobId);
  if (!found) throw new AccountingError(404, `Printing job ${jobId} not found`);
  return found;
}

export interface CreatePrintingJobInput {
  jobType?: 'quick_photocopy' | 'type_and_printing' | 'general_print' | 'exam_paper' | 'printed_product';
  customerId?: number | null;
  customerName?: string;
  salesEstimateId?: number | null;
  printingEstimateId?: number | null;
  machineId?: number | null;
  paperSpecId?: number | null;
  rawPaperItemId: number;
  rawTonerItemId: number;
  title: string;
  pages: number;
  copies: number;
  orderedQty?: number;
  printSide?: 'Single-Sided' | 'Duplex';
  nUp?: number;
  makeReadySheets?: number;
  runningWastePct?: number;
  typingFeeMode?: 'flat' | 'per_page';
  typingFeeRate?: number;
  finishingCost?: number;
  finishingCostPerPage?: number;
  manualSellingPrice?: string | number;
  manualSellingPricePerSheet?: string | number;
  jobDate?: string;
  reprintOfJobId?: number | null;
  reprintReason?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
}

export async function createPrintingJob(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: CreatePrintingJobInput
) {
  const idem = await checkRouteIdempotency<{ job: any }>(
    tx,
    companyId,
    'printing_job_create',
    input.idempotencyKey,
    input
  );
  if (idem.hit) return { job: idem.response.job, idempotentReplay: true };

  const title = String(input.title || '').trim();
  if (!title) throw new AccountingError(400, 'Job title is required');
  const pages = Number(input.pages);
  const copies = Number(input.copies);
  if (!Number.isInteger(pages) || pages <= 0) throw new AccountingError(400, 'pages must be a positive integer');
  if (!Number.isInteger(copies) || copies <= 0) throw new AccountingError(400, 'copies must be a positive integer');

  const jobType = input.jobType || 'general_print';
  const printSide = input.printSide || 'Duplex';
  const jobDate = input.jobDate ? assertIsoDate(input.jobDate, 'jobDate') : todayIsoDate();

  let customerId = input.customerId ? Number(input.customerId) : null;
  let customerName = String(input.customerName || '').trim();

  if (input.salesEstimateId) {
    const estRes = await tx.query<{
      id: number;
      estimate_number: string;
      customer_id: number;
      status: string;
    }>(
      `SELECT id, estimate_number, customer_id, status
         FROM estimates
        WHERE company_id = $1 AND id = $2
        FOR UPDATE`,
      [companyId, Number(input.salesEstimateId)]
    );
    if (estRes.rows.length === 0) throw new AccountingError(404, 'Sales estimate not found');
    const est = estRes.rows[0];
    if (est.status !== 'accepted') {
      throw new AccountingError(
        409,
        `Estimate ${est.estimate_number} must be approved ('accepted') before job creation (current: '${est.status}')`,
        'ESTIMATE_NOT_APPROVED'
      );
    }
    customerId = customerId ?? Number(est.customer_id);
  }

  if (customerId !== null) {
    const custRes = await tx.query<{ company_name: string }>(
      `SELECT company_name FROM customers WHERE company_id = $1 AND id = $2`,
      [companyId, customerId]
    );
    if (custRes.rows.length === 0) throw new AccountingError(404, 'Customer not found');
    if (!customerName) customerName = custRes.rows[0].company_name;
  }
  if (!customerName) customerName = 'Walk-in Customer';

  const rawPaperId = Number(input.rawPaperItemId);
  const rawTonerId = Number(input.rawTonerItemId);

  // Load raw material rows to verify company ownership & effective inventory cost (avg_cost > 0 ? avg_cost : unit_cost)
  const paperRowRes = await tx.query<{
    id: number;
    name: string;
    item_type: string;
    usage_unit: string;
    unit_cost: string;
    avg_cost: string;
    conversion_factor: string;
    paper_spec_id: number | null;
  }>(
    `SELECT id, name, item_type, usage_unit, unit_cost::text, avg_cost::text, conversion_factor::text, paper_spec_id
       FROM inventory_items
      WHERE company_id = $1 AND id = $2`,
    [companyId, rawPaperId]
  );
  if (paperRowRes.rows.length === 0 || paperRowRes.rows[0].item_type !== 'raw_material') {
    throw new AccountingError(400, 'rawPaperItemId must refer to an active raw_material item');
  }
  const paperItem = paperRowRes.rows[0];

  const tonerRowRes = await tx.query<{
    id: number;
    name: string;
    item_type: string;
    usage_unit: string;
    unit_cost: string;
    avg_cost: string;
    conversion_factor: string;
  }>(
    `SELECT id, name, item_type, usage_unit, unit_cost::text, avg_cost::text, conversion_factor::text
       FROM inventory_items
      WHERE company_id = $1 AND id = $2`,
    [companyId, rawTonerId]
  );
  if (tonerRowRes.rows.length === 0 || tonerRowRes.rows[0].item_type !== 'raw_material') {
    throw new AccountingError(400, 'rawTonerItemId must refer to an active raw_material item');
  }
  const tonerItem = tonerRowRes.rows[0];

  const paperStock = await lookupPaperStockFromDb(tx, companyId, rawPaperId);
  const effectivePaperPurchaseCost = Number(formatDecimal6(getEffectivePurchaseUnitCost6(paperItem)));
  paperStock.purchaseUnitCost = effectivePaperPurchaseCost;

  const effectiveTonerPurchaseCost = Number(formatDecimal6(getEffectivePurchaseUnitCost6(tonerItem)));

  const mode: PhotocopyPlacementMode = printSide === 'Duplex' ? 'duplex' : 'simplex';
  let sheetsUsed = 0;
  let impressionsUsed = 0;
  let paperCost = 0;
  let tonerCost = 0;
  let extraCost =
    input.finishingCostPerPage !== undefined
      ? Math.round(Number(input.finishingCostPerPage) * pages * 100) / 100
      : Number(input.finishingCost ?? 0);

  if (input.machineId) {
    const dbToner = await lookupTonerAndMachineFromDb(tx, companyId, {
      machineId: Number(input.machineId),
      tonerItemIds: { K: rawTonerId },
    });
    if (dbToner.channels.K) {
      dbToner.channels.K.cartridgeCost = effectiveTonerPurchaseCost;
    }

    if (jobType === 'type_and_printing') {
      const wf = calculateTypeAndPrintingWorkflow({
        paperStock,
        tonerChannels: dbToner.channels,
        machine: dbToner.machine,
        colorMode: 'mono' as TonerColorMode,
        tonerMethod: 'rated_yield',
        copies,
        mode,
        pages,
        nUp: input.nUp ?? 1,
        makeReadySheets: input.makeReadySheets ?? 0,
        runningWastePct: input.runningWastePct ?? 0,
        typingFee: {
          mode: input.typingFeeMode || 'flat',
          rate: Number(input.typingFeeRate ?? 0),
          typedPages: pages,
        },
        commercialPricing: { sellingPrice: Number(input.manualSellingPrice ?? 0) },
        allowInsufficientStockPreview: true,
      });
      sheetsUsed = wf.paper.quantities.totalSheets;
      impressionsUsed = wf.paper.quantities.printedSideImpressions;
      paperCost = wf.commercial.materialPaperCost;
      tonerCost = wf.commercial.materialTonerCost ?? 0;
      extraCost += wf.commercial.typingFee;
    } else if (jobType === 'quick_photocopy') {
      const wf = calculatePhotocopyWorkflow({
        paperStock,
        tonerChannels: dbToner.channels,
        machine: dbToner.machine,
        colorMode: 'mono',
        tonerMethod: 'rated_yield',
        copies,
        mode,
        pages,
        nUp: input.nUp ?? 1,
        makeReadySheets: input.makeReadySheets ?? 0,
        runningWastePct: input.runningWastePct ?? 0,
        commercialPricing: { sellingPrice: Number(input.manualSellingPrice ?? 0) },
        allowInsufficientStockPreview: true,
      });
      sheetsUsed = wf.paper.quantities.totalSheets;
      impressionsUsed = wf.paper.quantities.printedSideImpressions;
      paperCost = wf.commercial.materialPaperCost;
      tonerCost = wf.commercial.materialTonerCost ?? 0;
    } else {
      const wf = calculatePrintingServiceWorkflow({
        paperStock,
        tonerChannels: dbToner.channels,
        machine: dbToner.machine,
        colorMode: 'mono',
        tonerMethod: 'rated_yield',
        copies,
        mode,
        pages,
        nUp: input.nUp ?? 1,
        makeReadySheets: input.makeReadySheets ?? 0,
        runningWastePct: input.runningWastePct ?? 0,
        commercialPricing: { sellingPrice: Number(input.manualSellingPrice ?? 0) },
        allowInsufficientStockPreview: true,
      });
      sheetsUsed = wf.paper.quantities.totalSheets;
      impressionsUsed = wf.paper.quantities.printedSideImpressions;
      paperCost = wf.commercial.materialPaperCost;
      tonerCost = wf.commercial.materialTonerCost ?? 0;
    }
  } else {
    // Still route through authoritative shared calculation engines (paperCalc.ts & tonerCalc.ts)
    const pRes = calculatePhotocopyPaper({
      stock: paperStock,
      copies,
      mode,
      pages,
      nUp: input.nUp ?? 1,
      makeReadySheets: input.makeReadySheets ?? 0,
      runningWastePct: input.runningWastePct ?? 0,
      allowInsufficientStockPreview: true,
    });
    // Prefer a real material-specification yield. A conversion factor of 1
    // means "1 cartridge = 1 cartridge", not "1 cartridge = 1 impression", so
    // only use it as a yield when it is greater than one. If neither source
    // provides a yield, use the established conservative 10,000-impression
    // default and let the caller see the cost as estimated, not actual.
    const tonerMs = await tx.query<{ yield_per_purchase_unit: string | null }>(
      `SELECT yield_per_purchase_unit::text
         FROM material_specifications
        WHERE company_id = $1 AND inventory_item_id = $2
        LIMIT 1`,
      [companyId, rawTonerId]
    );
    const specYield = tonerMs.rows[0]?.yield_per_purchase_unit
      ? Number(tonerMs.rows[0].yield_per_purchase_unit)
      : null;
    const convYield = Number(tonerItem.conversion_factor) > 1 ? Number(tonerItem.conversion_factor) : null;
    const yieldImp = specYield && specYield > 0 ? specYield : convYield ?? 10000;
    const tRes = calculateToner({
      machine: {
        machineId: 0,
        name: 'Standard Press',
        processType: 'digital_press',
        supportsColour: false,
        supportsDuplex: true,
        status: 'active',
      },
      channels: {
        K: {
          itemId: rawTonerId,
          sku: 'TONER-K',
          name: tonerItem.name,
          channel: 'K',
          isActive: true,
          cartridgeCost: effectiveTonerPurchaseCost,
          ratedYieldImpressions: yieldImp,
        },
      },
      colorMode: 'mono',
      method: 'rated_yield',
      impressions: {
        printedSideImpressions: pRes.quantities.printedSideImpressions,
      },
    });
    sheetsUsed = pRes.quantities.totalSheets;
    impressionsUsed = pRes.quantities.printedSideImpressions;
    paperCost = pRes.quantities.totalPaperCost;
    tonerCost = tRes.totalCost ?? 0;
    if (jobType === 'type_and_printing' && input.typingFeeRate) {
      extraCost +=
        (input.typingFeeMode || 'flat') === 'per_page'
          ? Number(input.typingFeeRate) * pages
          : Number(input.typingFeeRate);
    }
  }

  const orderedQty6 = parseDecimal6(input.orderedQty ?? copies);
  const resolvedManualSelling =
    input.manualSellingPricePerSheet !== undefined
      ? Math.round(Number(input.manualSellingPricePerSheet) * sheetsUsed * 100) / 100
      : input.manualSellingPrice ?? 0;
  const manualSelling4 = input.reprintOfJobId
    ? 0n
    : parseDecimal4(resolvedManualSelling);

  const jobNumber = await generateNextDocNumber(tx, companyId, 'printing_jobs', 'job_number', 'JOB');

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO printing_jobs (
       company_id, job_number, job_type, customer_id, customer_name,
       sales_estimate_id, printing_estimate_id, machine_id, paper_spec_id,
       raw_paper_item_id, raw_toner_item_id, title, pages, copies, print_side,
       ordered_qty, sheets_used, impressions_used, paper_cost, toner_cost, extra_cost,
       manual_selling_price, job_date, status, reprint_of_job_id, reprint_reason,
       reprint_authorized_by, created_by, notes
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15,
       $16::NUMERIC(19,4), $17::NUMERIC(19,6), $18::NUMERIC(19,6),
       $19::NUMERIC(19,4), $20::NUMERIC(19,4), $21::NUMERIC(19,4),
       $22::NUMERIC(19,4), $23::DATE, 'draft', $24, $25,
       $26, $27, $28
     ) RETURNING id`,
    [
      companyId,
      jobNumber,
      jobType,
      customerId,
      customerName,
      input.salesEstimateId ? Number(input.salesEstimateId) : null,
      input.printingEstimateId ? Number(input.printingEstimateId) : null,
      input.machineId ? Number(input.machineId) : null,
      input.paperSpecId ?? paperItem.paper_spec_id ?? null,
      rawPaperId,
      rawTonerId,
      title,
      pages,
      copies,
      printSide,
      formatDecimal4(divRoundBigInt(orderedQty6, 100n, 'HALF_EVEN')),
      formatDecimal6(parseDecimal6(sheetsUsed)),
      formatDecimal6(parseDecimal6(impressionsUsed)),
      formatDecimal4(parseDecimal4(paperCost)),
      formatDecimal4(parseDecimal4(tonerCost)),
      formatDecimal4(parseDecimal4(extraCost)),
      formatDecimal4(manualSelling4),
      jobDate,
      input.reprintOfJobId ? Number(input.reprintOfJobId) : null,
      input.reprintReason?.trim() || null,
      input.reprintOfJobId ? actor.userId : null,
      actor.userId,
      input.notes?.trim() || null,
    ]
  );
  const jobId = Number(ins.rows[0].id);

  // Populate structured Job Material Requirements (Paper + Toner)
  const paperConv6 = parseDecimal6(paperItem.conversion_factor || '1');
  const paperUsageCost6 = divRoundBigInt(getEffectivePurchaseUnitCost6(paperItem) * 1000000n, paperConv6, 'HALF_EVEN');
  if (sheetsUsed > 0) {
    await tx.query(
      `INSERT INTO job_material_requirements (
         company_id, printing_job_id, raw_material_item_id, material_role, usage_unit,
         planned_usage_qty, planned_unit_cost, planned_total_cost
       ) VALUES ($1, $2, $3, 'paper', $4, $5::NUMERIC(19,6), $6::NUMERIC(19,6), $7::NUMERIC(19,4))`,
      [
        companyId,
        jobId,
        rawPaperId,
        paperItem.usage_unit || 'Sheet',
        formatDecimal6(parseDecimal6(sheetsUsed)),
        formatDecimal6(paperUsageCost6),
        formatDecimal4(parseDecimal4(paperCost)),
      ]
    );
  }

  const tonerConv6 = parseDecimal6(tonerItem.conversion_factor || '1');
  const tonerUsageCost6 = divRoundBigInt(getEffectivePurchaseUnitCost6(tonerItem) * 1000000n, tonerConv6, 'HALF_EVEN');
  if (impressionsUsed > 0) {
    await tx.query(
      `INSERT INTO job_material_requirements (
         company_id, printing_job_id, raw_material_item_id, material_role, usage_unit,
         planned_usage_qty, planned_unit_cost, planned_total_cost
       ) VALUES ($1, $2, $3, 'toner', $4, $5::NUMERIC(19,6), $6::NUMERIC(19,6), $7::NUMERIC(19,4))`,
      [
        companyId,
        jobId,
        rawTonerId,
        tonerItem.usage_unit || 'Impression',
        formatDecimal6(parseDecimal6(impressionsUsed)),
        formatDecimal6(tonerUsageCost6),
        formatDecimal4(parseDecimal4(tonerCost)),
      ]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: input.reprintOfJobId ? 'CONTROLLED_REPRINT_CREATED' : 'PRINTING_JOB_CREATED',
    tableName: 'printing_jobs',
    recordId: jobId,
    newValues: {
      jobNumber,
      jobType,
      salesEstimateId: input.salesEstimateId || null,
      reprintOfJobId: input.reprintOfJobId || null,
      sheetsUsed,
      impressionsUsed,
      plannedMaterialCost: paperCost + tonerCost,
      manualSellingPrice: toMoneyNumber(manualSelling4),
    },
  });

  const job = await getPrintingJobById(tx, companyId, jobId);
  await saveRouteIdempotency(tx, companyId, 'printing_job_create', input.idempotencyKey, idem.payloadHash, 201, { job }, actor.userId);
  return { job, idempotentReplay: false };
}

export async function createPrintingJobFromEstimate(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  estimateId: number,
  input: Omit<CreatePrintingJobInput, 'salesEstimateId'>
) {
  const estRes = await tx.query<{
    id: number;
    estimate_number: string;
    customer_id: number;
    subtotal: string;
    status: string;
  }>(
    `SELECT id, estimate_number, customer_id, subtotal::text, status
       FROM estimates
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, estimateId]
  );
  if (estRes.rows.length === 0) throw new AccountingError(404, 'Sales estimate not found');
  const est = estRes.rows[0];
  if (est.status !== 'accepted') {
    throw new AccountingError(
      409,
      `Quotation ${est.estimate_number} cannot create a production job until approved (status: '${est.status}')`,
      'ESTIMATE_NOT_APPROVED'
    );
  }

  return createPrintingJob(tx, companyId, actor, {
    ...input,
    salesEstimateId: estimateId,
    customerId: input.customerId ?? Number(est.customer_id),
    manualSellingPrice: input.manualSellingPrice ?? est.subtotal,
  });
}

// ============================================================================
// BUDGET APPROVAL
// ============================================================================

export async function approveJobBudget(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  jobId: number,
  input?: {
    budgetMaterial?: string | number;
    budgetLabour?: string | number;
    budgetMachine?: string | number;
    note?: string;
  }
) {
  const res = await tx.query<{
    id: number;
    job_number: string;
    status: string;
    paper_cost: string;
    toner_cost: string;
    extra_cost: string;
  }>(
    `SELECT id, job_number, status, paper_cost::text, toner_cost::text, extra_cost::text
       FROM printing_jobs
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, jobId]
  );
  if (res.rows.length === 0) throw new AccountingError(404, 'Printing job not found');
  const job = res.rows[0];
  if (['cancelled', 'completed'].includes(job.status)) {
    throw new AccountingError(409, `Cannot approve budget for ${job.status} job ${job.job_number}`);
  }

  const defaultMat4 = parseDecimal4(job.paper_cost) + parseDecimal4(job.toner_cost) + parseDecimal4(job.extra_cost);
  const mat4 = input?.budgetMaterial !== undefined ? parseDecimal4(input.budgetMaterial) : defaultMat4;
  const lab4 = parseDecimal4(input?.budgetLabour ?? 0);
  const mac4 = parseDecimal4(input?.budgetMachine ?? 0);
  const total4 = mat4 + lab4 + mac4;
  const nextStatus = job.status === 'draft' ? 'budget_approved' : job.status;

  await tx.query(
    `UPDATE printing_jobs
        SET approved_budget_material = $3::NUMERIC(19,4),
            approved_budget_labour = $4::NUMERIC(19,4),
            approved_budget_machine = $5::NUMERIC(19,4),
            approved_budget_total = $6::NUMERIC(19,4),
            budget_approved_by = $7,
            budget_approved_at = NOW(),
            status = $8,
            notes = CASE WHEN $9::TEXT IS NOT NULL THEN COALESCE(notes || ' | ', '') || $9 ELSE notes END
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      jobId,
      formatDecimal4(mat4),
      formatDecimal4(lab4),
      formatDecimal4(mac4),
      formatDecimal4(total4),
      actor.userId,
      nextStatus,
      input?.note?.trim() || null,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'JOB_BUDGET_APPROVED',
    tableName: 'printing_jobs',
    recordId: jobId,
    newValues: {
      approvedBudgetMaterial: formatDecimal4(mat4),
      approvedBudgetLabour: formatDecimal4(lab4),
      approvedBudgetMachine: formatDecimal4(mac4),
      approvedBudgetTotal: formatDecimal4(total4),
    },
  });

  return getPrintingJobById(tx, companyId, jobId);
}

// ============================================================================
// MATERIAL RESERVATION, ISSUE TO PRODUCTION, CONSUMPTION/WASTE & RETURN
// ============================================================================

export async function reserveJobMaterials(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  jobId: number,
  input?: { idempotencyKey?: string | null }
) {
  const idem = await checkRouteIdempotency<{ job: any }>(
    tx,
    companyId,
    `job_reserve_${jobId}`,
    input?.idempotencyKey,
    { jobId }
  );
  if (idem.hit) return { job: idem.response.job, idempotentReplay: true };

  const jRes = await tx.query<{ id: number; job_number: string; status: string }>(
    `SELECT id, job_number, status FROM printing_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, jobId]
  );
  if (jRes.rows.length === 0) throw new AccountingError(404, 'Printing job not found');
  const job = jRes.rows[0];
  if (['cancelled', 'completed'].includes(job.status)) {
    throw new AccountingError(409, `Cannot reserve materials for ${job.status} job ${job.job_number}`);
  }

  const reqs = await tx.query<{
    id: number;
    raw_material_item_id: number;
    planned_usage_qty: string;
    reserved_usage_qty: string;
    issued_usage_qty: string;
  }>(
    `SELECT id, raw_material_item_id, planned_usage_qty::text, reserved_usage_qty::text, issued_usage_qty::text
       FROM job_material_requirements
      WHERE company_id = $1 AND printing_job_id = $2
      ORDER BY raw_material_item_id ASC, id ASC
      FOR UPDATE`,
    [companyId, jobId]
  );

  // Deadlock-free lock ordering on inventory_items
  const itemIds = Array.from(new Set(reqs.rows.map(r => Number(r.raw_material_item_id)))).sort((a, b) => a - b);
  const itemsById = new Map<number, any>();
  for (const itemId of itemIds) {
    const itRes = await tx.query<any>(
      `SELECT id, name, on_hand::text, COALESCE(reserved_qty, 0)::text AS reserved_qty, conversion_factor::text
         FROM inventory_items
        WHERE company_id = $1 AND id = $2
        FOR UPDATE`,
      [companyId, itemId]
    );
    if (itRes.rows.length > 0) itemsById.set(itemId, itRes.rows[0]);
  }

  let reservedAny = false;
  for (const r of reqs.rows) {
    const planned6 = parseDecimal6(r.planned_usage_qty);
    const alreadyReserved6 = parseDecimal6(r.reserved_usage_qty);
    const alreadyIssued6 = parseDecimal6(r.issued_usage_qty);
    const toReserveUsage6 = planned6 - alreadyReserved6 - alreadyIssued6;
    if (toReserveUsage6 <= 0n) continue;

    const item = itemsById.get(Number(r.raw_material_item_id));
    if (!item) continue;
    const factor6 = parseDecimal6(item.conversion_factor || '1');
    const reservePurchase6 = usageToPurchaseUnits6(toReserveUsage6, factor6, 'HALF_EVEN');

    const onHand6 = parseDecimal6(item.on_hand);
    const currReserved6 = parseDecimal6(item.reserved_qty);
    const available6 = onHand6 - currReserved6;
    if (available6 < reservePurchase6) {
      throw new AccountingError(
        409,
        `Insufficient unreserved stock for "${item.name}" (available: ${formatDecimal6(available6)}, needed: ${formatDecimal6(reservePurchase6)})`,
        'INSUFFICIENT_UNRESERVED_STOCK'
      );
    }

    const nextItemReserved6 = currReserved6 + reservePurchase6;
    item.reserved_qty = formatDecimal6(nextItemReserved6);

    await tx.query(
      `UPDATE inventory_items SET reserved_qty = $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`,
      [companyId, Number(item.id), item.reserved_qty]
    );
    await tx.query(
      `UPDATE job_material_requirements SET reserved_usage_qty = reserved_usage_qty + $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`,
      [companyId, Number(r.id), formatDecimal6(toReserveUsage6)]
    );
    reservedAny = true;
  }

  if (!reservedAny) {
    throw new AccountingError(
      409,
      `All planned materials for job ${job.job_number} are already reserved or issued`,
      'MATERIALS_ALREADY_RESERVED'
    );
  }

  if (['draft', 'budget_approved'].includes(job.status)) {
    await tx.query(
      `UPDATE printing_jobs SET status = 'queued' WHERE company_id = $1 AND id = $2`,
      [companyId, jobId]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'JOB_MATERIALS_RESERVED',
    tableName: 'printing_jobs',
    recordId: jobId,
  });

  const out = await getPrintingJobById(tx, companyId, jobId);
  await saveRouteIdempotency(tx, companyId, `job_reserve_${jobId}`, input?.idempotencyKey, idem.payloadHash, 200, { job: out }, actor.userId);
  return { job: out, idempotentReplay: false };
}

export async function issueJobMaterials(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  jobId: number,
  input?: {
    issueDate?: string;
    idempotencyKey?: string | null;
    lines?: Array<{ requirementId?: number; rawMaterialItemId?: number; issueUsageQty?: string | number }>;
  }
) {
  const idem = await checkRouteIdempotency<{ job: any; journalTxnId: number }>(
    tx,
    companyId,
    `job_issue_${jobId}`,
    input?.idempotencyKey,
    { jobId, ...input }
  );
  if (idem.hit) return { ...idem.response, idempotentReplay: true };

  const jRes = await tx.query<{
    id: number;
    job_number: string;
    status: string;
    budget_approved_at: string | null;
  }>(
    `SELECT id, job_number, status, budget_approved_at::text
       FROM printing_jobs
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, jobId]
  );
  if (jRes.rows.length === 0) throw new AccountingError(404, 'Printing job not found');
  const job = jRes.rows[0];
  if (['cancelled', 'completed'].includes(job.status)) {
    throw new AccountingError(409, `Cannot issue materials to ${job.status} job ${job.job_number}`);
  }
  if (!job.budget_approved_at) {
    throw new AccountingError(
      409,
      `Job ${job.job_number} budget must be approved before issuing materials to production`,
      'BUDGET_NOT_APPROVED'
    );
  }

  const issueDate = input?.issueDate ? assertIsoDate(input.issueDate, 'issueDate') : todayIsoDate();
  const ctx = await resolveWorkflowAccounts(tx, companyId, actor);

  const reqs = await tx.query<{
    id: number;
    raw_material_item_id: number;
    planned_usage_qty: string;
    reserved_usage_qty: string;
    issued_usage_qty: string;
    issued_avg_unit_cost: string;
  }>(
    `SELECT id, raw_material_item_id, planned_usage_qty::text, reserved_usage_qty::text,
            issued_usage_qty::text, issued_avg_unit_cost::text
       FROM job_material_requirements
      WHERE company_id = $1 AND printing_job_id = $2
      ORDER BY raw_material_item_id ASC, id ASC
      FOR UPDATE`,
    [companyId, jobId]
  );

  const reqById = new Map<number, typeof reqs.rows[0]>();
  const reqByItem = new Map<number, typeof reqs.rows[0]>();
  for (const r of reqs.rows) {
    reqById.set(Number(r.id), r);
    reqByItem.set(Number(r.raw_material_item_id), r);
  }

  const targetLines: Array<{
    requirementId?: number;
    rawMaterialItemId?: number;
    issueUsageQty?: string | number;
  }> = Array.isArray(input?.lines) && input!.lines.length > 0
    ? input!.lines
    : reqs.rows.map(r => ({ requirementId: Number(r.id) }));

  // Lock referenced inventory_items in sorted ascending order
  const itemIds = Array.from(
    new Set(
      targetLines
        .map(tl => {
          const r = tl.requirementId
            ? reqById.get(Number(tl.requirementId))
            : tl.rawMaterialItemId
            ? reqByItem.get(Number(tl.rawMaterialItemId))
            : undefined;
          return r ? Number(r.raw_material_item_id) : tl.rawMaterialItemId ? Number(tl.rawMaterialItemId) : 0;
        })
        .filter(id => id > 0)
    )
  ).sort((a, b) => a - b);

  const itemsById = new Map<number, any>();
  for (const itemId of itemIds) {
    const itRes = await tx.query<any>(
      `SELECT id, name, on_hand::text, COALESCE(reserved_qty, 0)::text AS reserved_qty,
              avg_cost::text, unit_cost::text, conversion_factor::text, asset_account_id
         FROM inventory_items
        WHERE company_id = $1 AND id = $2
        FOR UPDATE`,
      [companyId, itemId]
    );
    if (itRes.rows.length > 0) itemsById.set(itemId, itRes.rows[0]);
  }

  const creditByAssetAcct = new Map<number, bigint>();
  let totalIssuedCost4 = 0n;

  for (const tl of targetLines) {
    const req = tl.requirementId
      ? reqById.get(Number(tl.requirementId))
      : tl.rawMaterialItemId
      ? reqByItem.get(Number(tl.rawMaterialItemId))
      : undefined;
    if (!req) throw new AccountingError(404, 'Material requirement not found on job');

    const planned6 = parseDecimal6(req.planned_usage_qty);
    const prevIssued6 = parseDecimal6(req.issued_usage_qty);
    const prevReserved6 = parseDecimal6(req.reserved_usage_qty);
    const defaultRemaining6 = planned6 - prevIssued6;
    const issueUsage6 =
      tl.issueUsageQty !== undefined ? parseDecimal6(tl.issueUsageQty) : defaultRemaining6;

    if (issueUsage6 <= 0n) continue;
    // Prevent duplicate full issue when remaining planned is already 0 and caller didn't explicitly issue extra overrun
    if (tl.issueUsageQty === undefined && defaultRemaining6 <= 0n) continue;

    const item = itemsById.get(Number(req.raw_material_item_id));
    if (!item) throw new AccountingError(404, 'Raw material inventory item not found');

    const factor6 = parseDecimal6(item.conversion_factor || '1');
    const issuePurchase6 = usageToPurchaseUnits6(issueUsage6, factor6, ctx.roundingMode);
    const releaseReservedUsage6 = prevReserved6 < issueUsage6 ? prevReserved6 : issueUsage6;
    const itemReserved6 = parseDecimal6(item.reserved_qty);
    const releaseReservedPurchase6Raw = usageToPurchaseUnits6(releaseReservedUsage6, factor6, ctx.roundingMode);
    const releaseReservedPurchase6 =
      releaseReservedPurchase6Raw < itemReserved6 ? releaseReservedPurchase6Raw : itemReserved6;

    const onHand6 = parseDecimal6(item.on_hand);
    const effectiveOtherReserved6 = itemReserved6 - releaseReservedPurchase6;
    if (onHand6 < issuePurchase6) {
      throw new AccountingError(
        409,
        `Insufficient stock for "${item.name}" (on hand: ${formatDecimal6(onHand6)}, issue needed: ${formatDecimal6(issuePurchase6)})`,
        'INSUFFICIENT_STOCK'
      );
    }
    if (onHand6 - effectiveOtherReserved6 < issuePurchase6) {
      throw new AccountingError(
        409,
        `Insufficient unreserved stock for "${item.name}" to issue to job ${job.job_number}`,
        'INSUFFICIENT_UNRESERVED_STOCK'
      );
    }

    const effPurchaseCost6 = getEffectivePurchaseUnitCost6(item);
    const usageUnitCost6 = divRoundBigInt(effPurchaseCost6 * 1000000n, factor6, ctx.roundingMode);
    // Exact 4-decimal cost = issuePurchase6 * effPurchaseCost6 / 10^8
    const issueCost4 = divRoundBigInt(issuePurchase6 * effPurchaseCost6, 100000000n, ctx.roundingMode);

    const nextOnHand6 = onHand6 - issuePurchase6;
    const nextItemReserved6 = itemReserved6 - releaseReservedPurchase6;
    item.on_hand = formatDecimal6(nextOnHand6);
    item.reserved_qty = formatDecimal6(nextItemReserved6);

    await tx.query(
      `UPDATE inventory_items
          SET on_hand = $3::NUMERIC(19,6),
              reserved_qty = $4::NUMERIC(19,6)
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(item.id), item.on_hand, item.reserved_qty]
    );

    await tx.query(
      `INSERT INTO inventory_movements (
         company_id, item_id, movement_type, quantity_delta, unit_cost,
         balance_qty, balance_avg_cost, source_type, source_id
       ) VALUES ($1, $2, 'production_consume', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'printing_job', $7)`,
      [
        companyId,
        Number(item.id),
        formatDecimal6(-issuePurchase6),
        formatDecimal6(effPurchaseCost6),
        item.on_hand,
        formatDecimal6(effPurchaseCost6),
        jobId,
      ]
    );

    const nextReqIssued6 = prevIssued6 + issueUsage6;
    const nextReqReserved6 = prevReserved6 - releaseReservedUsage6;
    const prevReqAvg6 = parseDecimal6(req.issued_avg_unit_cost);
    const prevVal8 = prevIssued6 * prevReqAvg6;
    const addedVal8 = issueUsage6 * usageUnitCost6;
    const nextReqAvg6 = nextReqIssued6 > 0n ? divRoundBigInt(prevVal8 + addedVal8, nextReqIssued6, ctx.roundingMode) : 0n;

    await tx.query(
      `UPDATE job_material_requirements
          SET reserved_usage_qty = $3::NUMERIC(19,6),
              issued_usage_qty = $4::NUMERIC(19,6),
              issued_avg_unit_cost = $5::NUMERIC(19,6)
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(req.id), formatDecimal6(nextReqReserved6), formatDecimal6(nextReqIssued6), formatDecimal6(nextReqAvg6)]
    );

    if (issueCost4 > 0n) {
      totalIssuedCost4 += issueCost4;
      const assetAcct = Number(item.asset_account_id) || ctx.inventory1200;
      creditByAssetAcct.set(assetAcct, (creditByAssetAcct.get(assetAcct) ?? 0n) + issueCost4);
    }
  }

  if (totalIssuedCost4 === 0n && itemIds.length > 0) {
    throw new AccountingError(
      409,
      `No remaining planned material quantities left to issue for job ${job.job_number}`,
      'MATERIALS_ALREADY_ISSUED'
    );
  }

  const jeLines: JournalLineInput[] = [
    {
      accountId: ctx.wip1250,
      debit: formatDecimal4(totalIssuedCost4),
      credit: '0.0000',
      description: `Materials issued to WIP — Job ${job.job_number}`,
    },
  ];
  for (const [acctId, amt4] of creditByAssetAcct.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: acctId,
        debit: '0.0000',
        credit: formatDecimal4(amt4),
        description: `Inventory issued to production — Job ${job.job_number}`,
      });
    }
  }

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: issueDate,
    description: `Material Issue to Production — ${job.job_number}`,
    reference: job.job_number,
    sourceType: 'production_wip',
    sourceId: jobId,
    idempotencyKey: input?.idempotencyKey ? `wip-issue-${companyId}-${jobId}-${input.idempotencyKey}` : undefined,
    lines: jeLines,
  });

  await tx.query(
    `UPDATE printing_jobs
        SET actual_material_cost = actual_material_cost + $3::NUMERIC(19,4),
            wip_cost_accumulated = wip_cost_accumulated + $3::NUMERIC(19,4),
            wip_journal_txn_id = COALESCE(wip_journal_txn_id, $4),
            status = CASE WHEN status IN ('draft', 'budget_approved', 'queued') THEN 'in_production' ELSE status END
      WHERE company_id = $1 AND id = $2`,
    [companyId, jobId, formatDecimal4(totalIssuedCost4), posted.transaction.id]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'JOB_MATERIALS_ISSUED',
    tableName: 'printing_jobs',
    recordId: jobId,
    newValues: { issuedCost: formatDecimal4(totalIssuedCost4), journalTxnId: posted.transaction.id },
  });

  const out = { job: await getPrintingJobById(tx, companyId, jobId), journalTxnId: posted.transaction.id };
  await saveRouteIdempotency(tx, companyId, `job_issue_${jobId}`, input?.idempotencyKey, idem.payloadHash, 200, out, actor.userId);
  return { ...out, idempotentReplay: false };
}

export async function recordMaterialConsumptionAndWaste(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  jobId: number,
  input: {
    lines: Array<{
      requirementId?: number;
      rawMaterialItemId?: number;
      actualGoodUsageQty: string | number;
      wasteUsageQty?: string | number;
      wasteReason?: string | null;
    }>;
  }
) {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new AccountingError(400, 'At least one consumption line is required');
  }
  const jRes = await tx.query<{ id: number; job_number: string; status: string }>(
    `SELECT id, job_number, status FROM printing_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, jobId]
  );
  if (jRes.rows.length === 0) throw new AccountingError(404, 'Printing job not found');
  if (jRes.rows[0].status === 'cancelled') {
    throw new AccountingError(409, 'Cannot record material consumption on a cancelled job');
  }

  let addedWasteCost4 = 0n;
  const variances: any[] = [];

  for (const l of input.lines) {
    const reqRes = await tx.query<{
      id: number;
      raw_material_item_id: number;
      planned_usage_qty: string;
      planned_total_cost: string;
      issued_usage_qty: string;
      actual_good_usage_qty: string;
      waste_usage_qty: string;
      returned_usage_qty: string;
      issued_avg_unit_cost: string;
    }>(
      l.requirementId
        ? `SELECT id, raw_material_item_id, planned_usage_qty::text, planned_total_cost::text,
                  issued_usage_qty::text, actual_good_usage_qty::text, waste_usage_qty::text,
                  returned_usage_qty::text, issued_avg_unit_cost::text
             FROM job_material_requirements WHERE company_id = $1 AND printing_job_id = $2 AND id = $3 FOR UPDATE`
        : `SELECT id, raw_material_item_id, planned_usage_qty::text, planned_total_cost::text,
                  issued_usage_qty::text, actual_good_usage_qty::text, waste_usage_qty::text,
                  returned_usage_qty::text, issued_avg_unit_cost::text
             FROM job_material_requirements WHERE company_id = $1 AND printing_job_id = $2 AND raw_material_item_id = $3 FOR UPDATE`,
      [companyId, jobId, Number(l.requirementId ?? l.rawMaterialItemId)]
    );
    if (reqRes.rows.length === 0) throw new AccountingError(404, 'Job material requirement not found');
    const r = reqRes.rows[0];

    const addGood6 = parseDecimal6(l.actualGoodUsageQty);
    const addWaste6 = parseDecimal6(l.wasteUsageQty ?? 0);
    if (addGood6 < 0n || addWaste6 < 0n) {
      throw new AccountingError(400, 'Consumption and waste quantities cannot be negative');
    }

    const issued6 = parseDecimal6(r.issued_usage_qty);
    const nextGood6 = parseDecimal6(r.actual_good_usage_qty) + addGood6;
    const nextWaste6 = parseDecimal6(r.waste_usage_qty) + addWaste6;
    const returned6 = parseDecimal6(r.returned_usage_qty);

    if (nextGood6 + nextWaste6 + returned6 > issued6 + 1n) {
      throw new AccountingError(
        409,
        `Actual consumption (${formatDecimal6(nextGood6 + nextWaste6)}) + returns (${formatDecimal6(returned6)}) exceeds issued quantity (${formatDecimal6(issued6)})`,
        'CONSUMPTION_EXCEEDS_ISSUED'
      );
    }

    const issuedAvg6 = parseDecimal6(r.issued_avg_unit_cost);
    const wasteCost4 = divRoundBigInt(addWaste6 * issuedAvg6, 100000000n, 'HALF_EVEN');
    addedWasteCost4 += wasteCost4;

    await tx.query(
      `UPDATE job_material_requirements
          SET actual_good_usage_qty = $3::NUMERIC(19,6),
              waste_usage_qty = $4::NUMERIC(19,6),
              waste_reason = COALESCE($5, waste_reason)
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(r.id), formatDecimal6(nextGood6), formatDecimal6(nextWaste6), l.wasteReason?.trim() || null]
    );

    const planned6 = parseDecimal6(r.planned_usage_qty);
    const qtyVariance6 = nextGood6 + nextWaste6 - planned6;
    const totalUsedCost4 = divRoundBigInt((nextGood6 + nextWaste6) * issuedAvg6, 100000000n, 'HALF_EVEN');
    const costVariance4 = totalUsedCost4 - parseDecimal4(r.planned_total_cost);

    variances.push({
      requirementId: Number(r.id),
      rawMaterialItemId: Number(r.raw_material_item_id),
      plannedUsageQty: toNumber6(r.planned_usage_qty),
      issuedUsageQty: toNumber6(r.issued_usage_qty),
      actualGoodUsageQty: Number(formatDecimal6(nextGood6)),
      wasteUsageQty: Number(formatDecimal6(nextWaste6)),
      qtyVariance: Number(formatDecimal6(qtyVariance6)),
      costVariance: toMoneyNumber(costVariance4),
    });
  }

  if (addedWasteCost4 > 0n) {
    await tx.query(
      `UPDATE printing_jobs
          SET actual_waste_cost = actual_waste_cost + $3::NUMERIC(19,4)
        WHERE company_id = $1 AND id = $2`,
      [companyId, jobId, formatDecimal4(addedWasteCost4)]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'JOB_CONSUMPTION_WASTE_RECORDED',
    tableName: 'printing_jobs',
    recordId: jobId,
    newValues: { addedWasteCost: formatDecimal4(addedWasteCost4), variances },
  });

  return { job: await getPrintingJobById(tx, companyId, jobId), variances };
}

export async function returnUnusedMaterials(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  jobId: number,
  input: {
    returnDate?: string;
    idempotencyKey?: string | null;
    lines: Array<{ requirementId?: number; rawMaterialItemId?: number; returnUsageQty: string | number }>;
  }
) {
  const idem = await checkRouteIdempotency<{ job: any; journalTxnId: number }>(
    tx,
    companyId,
    `job_return_${jobId}`,
    input.idempotencyKey,
    { jobId, ...input }
  );
  if (idem.hit) return { ...idem.response, idempotentReplay: true };

  const jRes = await tx.query<{ id: number; job_number: string; status: string }>(
    `SELECT id, job_number, status FROM printing_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, jobId]
  );
  if (jRes.rows.length === 0) throw new AccountingError(404, 'Printing job not found');
  const job = jRes.rows[0];
  if (job.status === 'cancelled') {
    throw new AccountingError(409, 'Job is already cancelled');
  }

  const returnDate = input.returnDate ? assertIsoDate(input.returnDate, 'returnDate') : todayIsoDate();
  const ctx = await resolveWorkflowAccounts(tx, companyId, actor);

  const debitByAsset = new Map<number, bigint>();
  let totalReturnCost4 = 0n;

  for (const l of input.lines) {
    const reqRes = await tx.query<any>(
      l.requirementId
        ? `SELECT * FROM job_material_requirements WHERE company_id = $1 AND printing_job_id = $2 AND id = $3 FOR UPDATE`
        : `SELECT * FROM job_material_requirements WHERE company_id = $1 AND printing_job_id = $2 AND raw_material_item_id = $3 FOR UPDATE`,
      [companyId, jobId, Number(l.requirementId ?? l.rawMaterialItemId)]
    );
    if (reqRes.rows.length === 0) throw new AccountingError(404, 'Job material requirement not found');
    const r = reqRes.rows[0];

    const returnUsage6 = parseDecimal6(l.returnUsageQty);
    if (returnUsage6 <= 0n) continue;

    const issued6 = parseDecimal6(r.issued_usage_qty);
    const used6 = parseDecimal6(r.actual_good_usage_qty) + parseDecimal6(r.waste_usage_qty) + parseDecimal6(r.returned_usage_qty);
    if (used6 + returnUsage6 > issued6 + 1n) {
      throw new AccountingError(
        409,
        `Return quantity (${formatDecimal6(returnUsage6)}) exceeds unconsumed issued stock (${formatDecimal6(issued6 - used6)})`,
        'RETURN_EXCEEDS_UNCONSUMED'
      );
    }

    const itRes = await tx.query<any>(
      `SELECT id, on_hand::text, avg_cost::text, unit_cost::text, conversion_factor::text, asset_account_id
         FROM inventory_items WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, Number(r.raw_material_item_id)]
    );
    const it = itRes.rows[0];
    const factor6 = parseDecimal6(it.conversion_factor || '1');
    const returnPurchase6 = usageToPurchaseUnits6(returnUsage6, factor6, ctx.roundingMode);
    const issuedAvg6 = parseDecimal6(r.issued_avg_unit_cost);
    const returnCost4 = divRoundBigInt(returnUsage6 * issuedAvg6, 100000000n, ctx.roundingMode);

    const prevOnHand6 = parseDecimal6(it.on_hand);
    const nextOnHand6 = prevOnHand6 + returnPurchase6;
    const prevEffCost6 = getEffectivePurchaseUnitCost6(it);
    const prevVal6 = divRoundBigInt(prevOnHand6 * prevEffCost6, 1000000n, ctx.roundingMode);
    const newAvg6 =
      nextOnHand6 > 0n
        ? divRoundBigInt((prevVal6 + returnCost4 * 100n) * 1000000n, nextOnHand6, ctx.roundingMode)
        : prevEffCost6;
    const returnPurchaseUnitCost6 =
      returnPurchase6 > 0n
        ? divRoundBigInt(returnCost4 * 100n * 1000000n, returnPurchase6, ctx.roundingMode)
        : prevEffCost6;

    await tx.query(
      `UPDATE inventory_items
          SET on_hand = $3::NUMERIC(19,6),
              avg_cost = $4::NUMERIC(19,6)
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(it.id), formatDecimal6(nextOnHand6), formatDecimal6(newAvg6)]
    );

    await tx.query(
      `INSERT INTO inventory_movements (
         company_id, item_id, movement_type, quantity_delta, unit_cost,
         balance_qty, balance_avg_cost, source_type, source_id
       ) VALUES ($1, $2, 'return_in', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $6::NUMERIC(19,6), 'printing_job', $7)`,
      [
        companyId,
        Number(it.id),
        formatDecimal6(returnPurchase6),
        formatDecimal6(returnPurchaseUnitCost6),
        formatDecimal6(nextOnHand6),
        formatDecimal6(newAvg6),
        jobId,
      ]
    );

    await tx.query(
      `UPDATE job_material_requirements
          SET returned_usage_qty = returned_usage_qty + $3::NUMERIC(19,6)
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(r.id), formatDecimal6(returnUsage6)]
    );

    totalReturnCost4 += returnCost4;
    const assetAcct = Number(it.asset_account_id) || ctx.inventory1200;
    debitByAsset.set(assetAcct, (debitByAsset.get(assetAcct) ?? 0n) + returnCost4);
  }

  if (totalReturnCost4 === 0n) {
    throw new AccountingError(400, 'No unused material quantity specified for return');
  }

  const jeLines: JournalLineInput[] = [];
  for (const [acctId, amt4] of debitByAsset.entries()) {
    if (amt4 > 0n) {
      jeLines.push({
        accountId: acctId,
        debit: formatDecimal4(amt4),
        credit: '0.0000',
        description: `Unused material returned from Job ${job.job_number}`,
      });
    }
  }
  jeLines.push({
    accountId: ctx.wip1250,
    debit: '0.0000',
    credit: formatDecimal4(totalReturnCost4),
    description: `WIP material return — Job ${job.job_number}`,
  });

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: returnDate,
    description: `Material Return from WIP — ${job.job_number}`,
    reference: job.job_number,
    sourceType: 'production_wip',
    sourceId: jobId,
    lines: jeLines,
  });

  await tx.query(
    `UPDATE printing_jobs
        SET actual_material_cost = GREATEST(0, actual_material_cost - $3::NUMERIC(19,4)),
            wip_cost_accumulated = GREATEST(wip_cost_relieved, wip_cost_accumulated - $3::NUMERIC(19,4))
      WHERE company_id = $1 AND id = $2`,
    [companyId, jobId, formatDecimal4(totalReturnCost4)]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'JOB_MATERIALS_RETURNED',
    tableName: 'printing_jobs',
    recordId: jobId,
    newValues: { returnCost: formatDecimal4(totalReturnCost4), journalTxnId: posted.transaction.id },
  });

  const out = { job: await getPrintingJobById(tx, companyId, jobId), journalTxnId: posted.transaction.id };
  await saveRouteIdempotency(tx, companyId, `job_return_${jobId}`, input.idempotencyKey, idem.payloadHash, 200, out, actor.userId);
  return { ...out, idempotentReplay: false };
}

// ============================================================================
// PRODUCTION & FINISHING OPERATIONS (LABOUR + MACHINE OVERHEAD + PARTIAL QTY)
// ============================================================================

export async function recordProductionOperation(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  jobId: number,
  input: {
    stage: 'prepress' | 'typesetting' | 'plate_making' | 'press_run' | 'duplex_pass';
    machineId?: number | null;
    operatorUserId?: number | null;
    goodSheets?: number;
    spoilageSheets?: number;
    producedQtyAdded?: number;
    actualHours?: string | number;
    labourRatePerHour?: string | number;
    labourCost?: string | number;
    impressionsRun?: number;
    machineCost?: string | number;
    operationDate?: string;
    notes?: string | null;
  }
) {
  const jRes = await tx.query<{
    id: number;
    job_number: string;
    status: string;
    ordered_qty: string;
    produced_good_qty: string;
    budget_approved_at: string | null;
  }>(
    `SELECT id, job_number, status, ordered_qty::text, produced_good_qty::text, budget_approved_at::text
       FROM printing_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, jobId]
  );
  if (jRes.rows.length === 0) throw new AccountingError(404, 'Printing job not found');
  const job = jRes.rows[0];
  if (['cancelled', 'completed'].includes(job.status)) {
    throw new AccountingError(409, `Cannot log operations on ${job.status} job ${job.job_number}`);
  }
  if (!job.budget_approved_at) {
    throw new AccountingError(409, `Approve budget on ${job.job_number} before production operations`, 'BUDGET_NOT_APPROVED');
  }

  const ordered4 = parseDecimal4(job.ordered_qty);
  const prevProduced4 = parseDecimal4(job.produced_good_qty);
  const addedProduced4 = parseDecimal4(input.producedQtyAdded ?? 0);
  if (addedProduced4 < 0n) throw new AccountingError(400, 'producedQtyAdded cannot be negative');
  if (prevProduced4 + addedProduced4 > ordered4) {
    throw new AccountingError(
      409,
      `Produced quantity (${toMoneyNumber(prevProduced4 + addedProduced4)}) would exceed ordered quantity (${toMoneyNumber(ordered4)})`,
      'PRODUCED_EXCEEDS_ORDERED'
    );
  }

  const opDate = input.operationDate ? assertIsoDate(input.operationDate, 'operationDate') : todayIsoDate();
  const actualHours4 = parseDecimal4(input.actualHours ?? 0);
  const labourRate4 = parseDecimal4(input.labourRatePerHour ?? 0);
  const labourCost4 =
    input.labourCost !== undefined
      ? parseDecimal4(input.labourCost)
      : divRoundBigInt(actualHours4 * labourRate4, 10000n, 'HALF_EVEN');

  const impressionsRun6 = parseDecimal6(input.impressionsRun ?? 0);
  let machineCost4 = parseDecimal4(input.machineCost ?? 0);
  const machineId = input.machineId ? Number(input.machineId) : null;
  if (machineId !== null) {
    const mRes = await tx.query<{ click_cost_per_imp: string }>(
      `SELECT click_cost_per_imp::text FROM printing_machines WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, machineId]
    );
    if (mRes.rows.length === 0) throw new AccountingError(404, 'Printing machine not found');
    if (input.machineCost === undefined && impressionsRun6 > 0n) {
      const click6 = parseDecimal6(mRes.rows[0].click_cost_per_imp);
      machineCost4 = divRoundBigInt(impressionsRun6 * click6, 100000000n, 'HALF_EVEN');
    }
    if (impressionsRun6 > 0n) {
      const wholeImp = Math.round(Number(formatDecimal6(impressionsRun6)));
      await tx.query(
        `UPDATE printing_machines SET meter_impressions = meter_impressions + $3 WHERE company_id = $1 AND id = $2`,
        [companyId, machineId, wholeImp]
      );
    }
  }

  const totalAddedWip4 = labourCost4 + machineCost4;
  let journalTxnId: number | null = null;
  if (totalAddedWip4 > 0n) {
    const ctx = await resolveWorkflowAccounts(tx, companyId, actor);
    const jeLines: JournalLineInput[] = [
      {
        accountId: ctx.wip1250,
        debit: formatDecimal4(totalAddedWip4),
        credit: '0.0000',
        description: `Production ${input.stage} conversion cost to WIP — ${job.job_number}`,
      },
    ];
    if (labourCost4 > 0n) {
      jeLines.push({
        accountId: ctx.directLabourAbsorbed2110,
        debit: '0.0000',
        credit: formatDecimal4(labourCost4),
        description: `Direct labour absorbed (${input.stage}) — ${job.job_number}`,
      });
    }
    if (machineCost4 > 0n) {
      jeLines.push({
        accountId: ctx.machineOverhead6310,
        debit: '0.0000',
        credit: formatDecimal4(machineCost4),
        description: `Machine overhead applied (${input.stage}) — ${job.job_number}`,
      });
    }
    const posted = await postJournalEntry(tx, companyId, actor, {
      txnDate: opDate,
      description: `Production Operation (${input.stage}) — ${job.job_number}`,
      reference: job.job_number,
      sourceType: 'production_wip',
      sourceId: jobId,
      lines: jeLines,
    });
    journalTxnId = posted.transaction.id;
  }

  const opIns = await tx.query<{ id: number }>(
    `INSERT INTO production_operations (
       company_id, printing_job_id, stage, machine_id, operator_user_id,
       good_sheets, spoilage_sheets, started_at, completed_at, status,
       actual_hours, labour_rate_per_hour, labour_cost, impressions_run, machine_cost,
       journal_txn_id, notes
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::NUMERIC(19,6), $7::NUMERIC(19,6), NOW(), NOW(), 'completed',
       $8::NUMERIC(10,4), $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11::NUMERIC(19,6), $12::NUMERIC(19,4),
       $13, $14
     ) RETURNING id`,
    [
      companyId,
      jobId,
      input.stage,
      machineId,
      input.operatorUserId ? Number(input.operatorUserId) : actor.userId,
      formatDecimal6(parseDecimal6(input.goodSheets ?? 0)),
      formatDecimal6(parseDecimal6(input.spoilageSheets ?? 0)),
      formatDecimal4(actualHours4),
      formatDecimal4(labourRate4),
      formatDecimal4(labourCost4),
      formatDecimal6(impressionsRun6),
      formatDecimal4(machineCost4),
      journalTxnId,
      input.notes?.trim() || null,
    ]
  );

  const nextProduced4 = prevProduced4 + addedProduced4;
  const nextStatus =
    nextProduced4 >= ordered4 && job.status === 'in_production'
      ? 'qc_pending'
      : ['draft', 'budget_approved', 'queued'].includes(job.status)
      ? 'in_production'
      : job.status;

  await tx.query(
    `UPDATE printing_jobs
        SET produced_good_qty = $3::NUMERIC(19,4),
            actual_labour_cost = actual_labour_cost + $4::NUMERIC(19,4),
            actual_machine_cost = actual_machine_cost + $5::NUMERIC(19,4),
            wip_cost_accumulated = wip_cost_accumulated + $6::NUMERIC(19,4),
            wip_journal_txn_id = COALESCE(wip_journal_txn_id, $7),
            status = $8
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      jobId,
      formatDecimal4(nextProduced4),
      formatDecimal4(labourCost4),
      formatDecimal4(machineCost4),
      formatDecimal4(totalAddedWip4),
      journalTxnId,
      nextStatus,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRODUCTION_OPERATION_RECORDED',
    tableName: 'production_operations',
    recordId: Number(opIns.rows[0].id),
    newValues: {
      printingJobId: jobId,
      stage: input.stage,
      producedQtyAdded: toMoneyNumber(addedProduced4),
      labourCost: formatDecimal4(labourCost4),
      machineCost: formatDecimal4(machineCost4),
      journalTxnId,
    },
  });

  return {
    operationId: Number(opIns.rows[0].id),
    journalTxnId,
    job: await getPrintingJobById(tx, companyId, jobId),
  };
}

export async function recordFinishingOperation(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  jobId: number,
  input: {
    finishingType: 'cutting' | 'folding' | 'collating' | 'stapling' | 'saddle_stitching' | 'spiral_binding' | 'perfect_binding' | 'lamination' | 'packaging';
    machineId?: number | null;
    consumableItemId?: number | null;
    consumableQty?: string | number;
    actualHours?: string | number;
    labourRatePerHour?: string | number;
    labourCost?: string | number;
    machineCost?: string | number;
    operationDate?: string;
    notes?: string | null;
  }
) {
  const jRes = await tx.query<{ id: number; job_number: string; status: string }>(
    `SELECT id, job_number, status FROM printing_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, jobId]
  );
  if (jRes.rows.length === 0) throw new AccountingError(404, 'Printing job not found');
  const job = jRes.rows[0];
  if (['cancelled', 'completed'].includes(job.status)) {
    throw new AccountingError(409, `Cannot finish ${job.status} job ${job.job_number}`);
  }

  const ctx = await resolveWorkflowAccounts(tx, companyId, actor);
  const opDate = input.operationDate ? assertIsoDate(input.operationDate, 'operationDate') : todayIsoDate();

  let consumableCost4 = 0n;
  let consumableAssetAcct = ctx.inventory1200;
  const consumableItemId = input.consumableItemId ? Number(input.consumableItemId) : null;
  const consumableQty6 = parseDecimal6(input.consumableQty ?? 0);

  if (consumableItemId !== null && consumableQty6 > 0n) {
    const itRes = await tx.query<any>(
      `SELECT id, name, on_hand::text, COALESCE(reserved_qty, 0)::text AS reserved_qty,
              avg_cost::text, unit_cost::text, conversion_factor::text, asset_account_id
         FROM inventory_items WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, consumableItemId]
    );
    if (itRes.rows.length === 0) throw new AccountingError(404, 'Finishing consumable item not found');
    const it = itRes.rows[0];
    const factor6 = parseDecimal6(it.conversion_factor || '1');
    const purchaseConsumed6 = usageToPurchaseUnits6(consumableQty6, factor6, ctx.roundingMode);
    const avail6 = parseDecimal6(it.on_hand) - parseDecimal6(it.reserved_qty);
    if (avail6 < purchaseConsumed6) {
      throw new AccountingError(409, `Insufficient unreserved finishing consumable "${it.name}"`, 'INSUFFICIENT_UNRESERVED_STOCK');
    }
    const effCost6 = getEffectivePurchaseUnitCost6(it);
    consumableCost4 = divRoundBigInt(purchaseConsumed6 * effCost6, 100000000n, ctx.roundingMode);
    const nextOnHand6 = parseDecimal6(it.on_hand) - purchaseConsumed6;
    consumableAssetAcct = Number(it.asset_account_id) || ctx.inventory1200;

    await tx.query(
      `UPDATE inventory_items SET on_hand = $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`,
      [companyId, consumableItemId, formatDecimal6(nextOnHand6)]
    );
    await tx.query(
      `INSERT INTO inventory_movements (
         company_id, item_id, movement_type, quantity_delta, unit_cost,
         balance_qty, balance_avg_cost, source_type, source_id
       ) VALUES ($1, $2, 'production_consume', $3::NUMERIC(19,6), $4::NUMERIC(19,6), $5::NUMERIC(19,6), $4::NUMERIC(19,6), 'printing_job', $6)`,
      [
        companyId,
        consumableItemId,
        formatDecimal6(-purchaseConsumed6),
        formatDecimal6(effCost6),
        formatDecimal6(nextOnHand6),
        jobId,
      ]
    );
  }

  const actualHours4 = parseDecimal4(input.actualHours ?? 0);
  const labourRate4 = parseDecimal4(input.labourRatePerHour ?? 0);
  const labourCost4 =
    input.labourCost !== undefined
      ? parseDecimal4(input.labourCost)
      : divRoundBigInt(actualHours4 * labourRate4, 10000n, ctx.roundingMode);
  const machineCost4 = parseDecimal4(input.machineCost ?? 0);
  const totalAdded4 = consumableCost4 + labourCost4 + machineCost4;

  let journalTxnId: number | null = null;
  if (totalAdded4 > 0n) {
    const jeLines: JournalLineInput[] = [
      {
        accountId: ctx.wip1250,
        debit: formatDecimal4(totalAdded4),
        credit: '0.0000',
        description: `Finishing (${input.finishingType}) WIP — ${job.job_number}`,
      },
    ];
    if (consumableCost4 > 0n) {
      jeLines.push({
        accountId: consumableAssetAcct,
        debit: '0.0000',
        credit: formatDecimal4(consumableCost4),
        description: `Finishing consumables issued — ${job.job_number}`,
      });
    }
    if (labourCost4 > 0n) {
      jeLines.push({
        accountId: ctx.directLabourAbsorbed2110,
        debit: '0.0000',
        credit: formatDecimal4(labourCost4),
        description: `Finishing direct labour — ${job.job_number}`,
      });
    }
    if (machineCost4 > 0n) {
      jeLines.push({
        accountId: ctx.machineOverhead6310,
        debit: '0.0000',
        credit: formatDecimal4(machineCost4),
        description: `Finishing machine overhead — ${job.job_number}`,
      });
    }
    const posted = await postJournalEntry(tx, companyId, actor, {
      txnDate: opDate,
      description: `Finishing Operation (${input.finishingType}) — ${job.job_number}`,
      reference: job.job_number,
      sourceType: 'production_wip',
      sourceId: jobId,
      lines: jeLines,
    });
    journalTxnId = posted.transaction.id;
  }

  const finIns = await tx.query<{ id: number }>(
    `INSERT INTO finishing_operations (
       company_id, printing_job_id, finishing_type, machine_id, consumable_item_id,
       consumable_qty, consumable_cost, operator_user_id, completed_at, status,
       actual_hours, labour_rate_per_hour, labour_cost, machine_cost, journal_txn_id, notes
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::NUMERIC(19,6), $7::NUMERIC(19,4), $8, NOW(), 'completed',
       $9::NUMERIC(10,4), $10::NUMERIC(19,4), $11::NUMERIC(19,4), $12::NUMERIC(19,4), $13, $14
     ) RETURNING id`,
    [
      companyId,
      jobId,
      input.finishingType,
      input.machineId ? Number(input.machineId) : null,
      consumableItemId,
      formatDecimal6(consumableQty6),
      formatDecimal4(consumableCost4),
      actor.userId,
      formatDecimal4(actualHours4),
      formatDecimal4(labourRate4),
      formatDecimal4(labourCost4),
      formatDecimal4(machineCost4),
      journalTxnId,
      input.notes?.trim() || null,
    ]
  );

  await tx.query(
    `UPDATE printing_jobs
        SET actual_material_cost = actual_material_cost + $3::NUMERIC(19,4),
            actual_labour_cost = actual_labour_cost + $4::NUMERIC(19,4),
            actual_machine_cost = actual_machine_cost + $5::NUMERIC(19,4),
            wip_cost_accumulated = wip_cost_accumulated + $6::NUMERIC(19,4),
            status = CASE WHEN status = 'in_production' THEN 'finishing' ELSE status END
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      jobId,
      formatDecimal4(consumableCost4),
      formatDecimal4(labourCost4),
      formatDecimal4(machineCost4),
      formatDecimal4(totalAdded4),
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'FINISHING_OPERATION_RECORDED',
    tableName: 'finishing_operations',
    recordId: Number(finIns.rows[0].id),
    newValues: { printingJobId: jobId, finishingType: input.finishingType, totalAddedCost: formatDecimal4(totalAdded4) },
  });

  return {
    finishingOperationId: Number(finIns.rows[0].id),
    journalTxnId,
    job: await getPrintingJobById(tx, companyId, jobId),
  };
}

// ============================================================================
// QUALITY CONTROL, PARTIAL/FULL DELIVERY & DUPLICATE-SAFE INVOICING + COGS RELIEF
// ============================================================================

export async function recordQualityInspection(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  jobId: number,
  input: {
    sampleSize: number;
    defectCount?: number;
    registrationOk?: boolean;
    printDensityOk?: boolean;
    bindingOk?: boolean;
    disposition: 'approved' | 'rework' | 'rejected';
    approvedQty?: number;
    notes?: string | null;
  }
) {
  const jRes = await tx.query<{
    id: number;
    job_number: string;
    status: string;
    ordered_qty: string;
    produced_good_qty: string;
    qc_approved_qty: string;
  }>(
    `SELECT id, job_number, status, ordered_qty::text, produced_good_qty::text, qc_approved_qty::text
       FROM printing_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, jobId]
  );
  if (jRes.rows.length === 0) throw new AccountingError(404, 'Printing job not found');
  const job = jRes.rows[0];
  if (job.status === 'cancelled') {
    throw new AccountingError(409, 'Cannot inspect a cancelled job');
  }

  const sampleSize = Number(input.sampleSize);
  const defectCount = Number(input.defectCount ?? 0);
  if (!Number.isInteger(sampleSize) || sampleSize <= 0) throw new AccountingError(400, 'sampleSize must be > 0');

  const produced4 = parseDecimal4(job.produced_good_qty);
  const prevQc4 = parseDecimal4(job.qc_approved_qty);
  const ordered4 = parseDecimal4(job.ordered_qty);

  let approvedAdded4 = 0n;
  if (input.disposition === 'approved') {
    approvedAdded4 =
      input.approvedQty !== undefined ? parseDecimal4(input.approvedQty) : produced4 - prevQc4;
  }
  if (prevQc4 + approvedAdded4 > produced4) {
    throw new AccountingError(
      409,
      `QC approved quantity (${toMoneyNumber(prevQc4 + approvedAdded4)}) cannot exceed produced good quantity (${toMoneyNumber(produced4)})`,
      'QC_EXCEEDS_PRODUCED'
    );
  }

  const qcIns = await tx.query<{ id: number }>(
    `INSERT INTO quality_control_inspections (
       company_id, printing_job_id, inspector_user_id, sample_size, defect_count,
       registration_ok, print_density_ok, binding_ok, disposition, notes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      companyId,
      jobId,
      actor.userId,
      sampleSize,
      defectCount,
      input.registrationOk !== undefined ? Boolean(input.registrationOk) : true,
      input.printDensityOk !== undefined ? Boolean(input.printDensityOk) : true,
      input.bindingOk !== undefined ? Boolean(input.bindingOk) : true,
      input.disposition,
      input.notes?.trim() || null,
    ]
  );

  const nextQc4 = prevQc4 + approvedAdded4;
  const nextStatus =
    input.disposition === 'approved' && nextQc4 > 0n && ['in_production', 'finishing', 'qc_pending'].includes(job.status)
      ? nextQc4 >= ordered4
        ? 'ready'
        : 'qc_pending'
      : job.status;

  await tx.query(
    `UPDATE printing_jobs
        SET qc_approved_qty = $3::NUMERIC(19,4),
            status = $4
      WHERE company_id = $1 AND id = $2`,
    [companyId, jobId, formatDecimal4(nextQc4), nextStatus]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'QC_INSPECTION_RECORDED',
    tableName: 'quality_control_inspections',
    recordId: Number(qcIns.rows[0].id),
    newValues: {
      printingJobId: jobId,
      disposition: input.disposition,
      approvedQtyAdded: toMoneyNumber(approvedAdded4),
      totalQcApproved: toMoneyNumber(nextQc4),
    },
  });

  return {
    inspectionId: Number(qcIns.rows[0].id),
    job: await getPrintingJobById(tx, companyId, jobId),
  };
}

export async function createDeliveryNote(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId?: number | null;
    dispatchDate?: string;
    driverName?: string | null;
    vehicleReg?: string | null;
    recipientName?: string | null;
    notes?: string | null;
    jobId?: number;
    quantityDispatched?: number;
    lines?: Array<{ printingJobId: number; quantityDispatched: number; description?: string }>;
  }
) {
  const reqLines =
    Array.isArray(input.lines) && input.lines.length > 0
      ? input.lines
      : input.jobId
      ? [{ printingJobId: Number(input.jobId), quantityDispatched: Number(input.quantityDispatched ?? 0) }]
      : [];

  if (reqLines.length === 0) {
    throw new AccountingError(400, 'At least one delivery line (printingJobId & quantityDispatched) is required');
  }

  const dispatchDate = input.dispatchDate ? assertIsoDate(input.dispatchDate, 'dispatchDate') : todayIsoDate();

  let customerId = input.customerId ? Number(input.customerId) : null;
  const lockedJobs: any[] = [];
  for (const rl of reqLines) {
    const jRes = await tx.query<any>(
      `SELECT id, job_number, title, customer_id, status, ordered_qty::text, qc_approved_qty::text, delivered_qty::text
         FROM printing_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, Number(rl.printingJobId)]
    );
    if (jRes.rows.length === 0) throw new AccountingError(404, `Printing job ${rl.printingJobId} not found`);
    const job = jRes.rows[0];
    if (job.status === 'cancelled') {
      throw new AccountingError(409, `Cannot deliver cancelled job ${job.job_number}`);
    }
    customerId = customerId ?? (job.customer_id !== null ? Number(job.customer_id) : null);

    const qc4 = parseDecimal4(job.qc_approved_qty);
    const prevDel4 = parseDecimal4(job.delivered_qty);
    const addDel4 = parseDecimal4(rl.quantityDispatched);
    if (addDel4 <= 0n) throw new AccountingError(400, 'quantityDispatched must be > 0');
    if (prevDel4 + addDel4 > qc4) {
      throw new AccountingError(
        409,
        `Dispatch quantity (${toMoneyNumber(prevDel4 + addDel4)}) exceeds QC-approved quantity (${toMoneyNumber(qc4)}) on job ${job.job_number}`,
        'DELIVERY_EXCEEDS_QC_APPROVED'
      );
    }
    lockedJobs.push({ job, prevDel4, addDel4, description: rl.description || `${job.job_number}: ${job.title}` });
  }

  if (!customerId) {
    throw new AccountingError(400, 'customerId is required on delivery note');
  }

  const deliveryNumber = await generateNextDocNumber(tx, companyId, 'delivery_notes', 'delivery_number', 'DN');
  const totalOrderedCheck = lockedJobs.every(l => l.prevDel4 + l.addDel4 >= parseDecimal4(l.job.ordered_qty));
  const dnStatus = totalOrderedCheck ? 'delivered' : 'partial';

  const dnIns = await tx.query<{ id: number }>(
    `INSERT INTO delivery_notes (
       company_id, delivery_number, customer_id, dispatch_date, delivered_at,
       driver_name, vehicle_reg, recipient_name, delivered_by, status, notes
     ) VALUES ($1, $2, $3, $4::DATE, NOW(), $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      companyId,
      deliveryNumber,
      customerId,
      dispatchDate,
      input.driverName?.trim() || null,
      input.vehicleReg?.trim() || null,
      input.recipientName?.trim() || null,
      actor.userId,
      dnStatus,
      input.notes?.trim() || null,
    ]
  );
  const deliveryNoteId = Number(dnIns.rows[0].id);

  for (const item of lockedJobs) {
    await tx.query(
      `INSERT INTO delivery_note_lines (
         company_id, delivery_note_id, printing_job_id, description, quantity_dispatched
       ) VALUES ($1, $2, $3, $4, $5::NUMERIC(19,4))`,
      [companyId, deliveryNoteId, Number(item.job.id), item.description, formatDecimal4(item.addDel4)]
    );

    const nextDel4 = item.prevDel4 + item.addDel4;
    const ord4 = parseDecimal4(item.job.ordered_qty);
    const nextJobStatus = nextDel4 >= ord4 ? 'delivered' : 'partial_delivery';
    await tx.query(
      `UPDATE printing_jobs SET delivered_qty = $3::NUMERIC(19,4), status = $4 WHERE company_id = $1 AND id = $2`,
      [companyId, Number(item.job.id), formatDecimal4(nextDel4), nextJobStatus]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'DELIVERY_NOTE_CREATED',
    tableName: 'delivery_notes',
    recordId: deliveryNoteId,
    newValues: {
      deliveryNumber,
      customerId,
      status: dnStatus,
      jobs: lockedJobs.map(l => ({ jobId: Number(l.job.id), qtyDispatched: toMoneyNumber(l.addDel4) })),
    },
  });

  return {
    deliveryNote: {
      id: deliveryNoteId,
      deliveryNumber,
      customerId,
      dispatchDate,
      status: dnStatus,
      lines: lockedJobs.map(l => ({
        printingJobId: Number(l.job.id),
        description: l.description,
        quantityDispatched: toMoneyNumber(l.addDel4),
      })),
    },
  };
}

export async function invoiceDeliveredJob(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  jobId: number,
  input?: {
    deliveryNoteId?: number | null;
    quantityToInvoice?: number;
    invoiceDate?: string;
    taxRate?: string | number;
    unitSellingPriceOverride?: string | number;
    idempotencyKey?: string | null;
  }
) {
  const idem = await checkRouteIdempotency<{ invoice: any; cogsJournalId: number | null; job: any }>(
    tx,
    companyId,
    `job_invoice_${jobId}`,
    input?.idempotencyKey,
    { jobId, ...input }
  );
  if (idem.hit) return { ...idem.response, idempotentReplay: true };

  const jRes = await tx.query<any>(
    `SELECT * FROM printing_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, jobId]
  );
  if (jRes.rows.length === 0) throw new AccountingError(404, 'Printing job not found');
  const job = jRes.rows[0];
  if (job.status === 'cancelled') {
    throw new AccountingError(409, `Cannot invoice cancelled job ${job.job_number}`, 'JOB_CANCELLED');
  }
  if (!job.customer_id) {
    throw new AccountingError(400, `Job ${job.job_number} has no customer attached`);
  }

  const ordered4 = parseDecimal4(job.ordered_qty);
  const delivered4 = parseDecimal4(job.delivered_qty);
  const prevInvoiced4 = parseDecimal4(job.invoiced_qty);

  let deliveryNoteLineId: number | null = null;
  let qtyToInvoice4 = 0n;

  if (input?.deliveryNoteId) {
    const dnId = Number(input.deliveryNoteId);
    const dnRes = await tx.query<{ id: number; delivery_number: string; invoice_id: number | null }>(
      `SELECT id, delivery_number, invoice_id FROM delivery_notes WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [companyId, dnId]
    );
    if (dnRes.rows.length === 0) throw new AccountingError(404, 'Delivery note not found');
    const dn = dnRes.rows[0];
    if (dn.invoice_id !== null) {
      throw new AccountingError(
        409,
        `Delivery note ${dn.delivery_number} has already been invoiced (invoiceId: ${dn.invoice_id})`,
        'DELIVERY_NOTE_ALREADY_INVOICED'
      );
    }
    const dnlRes = await tx.query<{ id: number; quantity_dispatched: string; invoiced_qty: string }>(
      `SELECT id, quantity_dispatched::text, invoiced_qty::text
         FROM delivery_note_lines
        WHERE company_id = $1 AND delivery_note_id = $2 AND printing_job_id = $3
        FOR UPDATE`,
      [companyId, dnId, jobId]
    );
    if (dnlRes.rows.length === 0) {
      throw new AccountingError(400, `Delivery note ${dn.delivery_number} has no line for job ${job.job_number}`);
    }
    const dnl = dnlRes.rows[0];
    deliveryNoteLineId = Number(dnl.id);
    qtyToInvoice4 = parseDecimal4(dnl.quantity_dispatched) - parseDecimal4(dnl.invoiced_qty);
  } else {
    qtyToInvoice4 =
      input?.quantityToInvoice !== undefined
        ? parseDecimal4(input.quantityToInvoice)
        : delivered4 - prevInvoiced4;
  }

  if (qtyToInvoice4 <= 0n) {
    throw new AccountingError(
      409,
      `No un-invoiced delivered quantity remaining on job ${job.job_number}`,
      'NOTHING_TO_INVOICE'
    );
  }
  if (prevInvoiced4 + qtyToInvoice4 > delivered4) {
    throw new AccountingError(
      409,
      `Invoice quantity (${toMoneyNumber(prevInvoiced4 + qtyToInvoice4)}) exceeds delivered quantity (${toMoneyNumber(delivered4)})`,
      'INVOICE_EXCEEDS_DELIVERED'
    );
  }

  const nextInvoiced4 = prevInvoiced4 + qtyToInvoice4;
  const sellingTotal4 = parseDecimal4(job.manual_selling_price);
  const wipAccum4 = parseDecimal4(job.wip_cost_accumulated);
  const wipRelieved4 = parseDecimal4(job.wip_cost_relieved);

  const isFinalTranche = nextInvoiced4 >= ordered4;
  let trancheRevenue4 = 0n;
  if (input?.unitSellingPriceOverride !== undefined) {
    const u4 = parseDecimal4(input.unitSellingPriceOverride);
    trancheRevenue4 = divRoundBigInt(qtyToInvoice4 * u4, 10000n, 'HALF_EVEN');
  } else {
    // Proportional tranche of job selling price
    trancheRevenue4 = divRoundBigInt(sellingTotal4 * qtyToInvoice4, ordered4, 'HALF_EVEN');
    if (isFinalTranche) {
      const priorProportional4 = divRoundBigInt(sellingTotal4 * prevInvoiced4, ordered4, 'HALF_EVEN');
      trancheRevenue4 = sellingTotal4 - priorProportional4;
    }
  }

  const trancheWipRelief4 = isFinalTranche
    ? wipAccum4 - wipRelieved4
    : divRoundBigInt(wipAccum4 * qtyToInvoice4, ordered4, 'HALF_EVEN');

  const invoiceDate = input?.invoiceDate ? assertIsoDate(input.invoiceDate, 'invoiceDate') : todayIsoDate();
  const invRes = await createInvoiceOrSalesReceipt(tx, companyId, actor, {
    customerId: Number(job.customer_id),
    invoiceDate,
    taxRate: input?.taxRate ?? 0,
    notes: `Production Invoice for ${job.job_number} — ${job.title} (${toMoneyNumber(qtyToInvoice4)}/${toMoneyNumber(ordered4)})`,
    lines: [
      {
        itemId: null, // CRITICAL: WIP already consumed raw materials; never re-deduct raw materials here
        description: `${job.title} (${job.job_number} — Qty ${toMoneyNumber(qtyToInvoice4)})`,
        quantity: 1,
        rate: formatDecimal4(trancheRevenue4),
        unitCost: 0,
        taxable: Number(input?.taxRate ?? 0) > 0,
      },
    ],
  });

  const invoiceId = invRes.invoice.id;
  let cogsJournalId: number | null = null;
  if (trancheWipRelief4 > 0n) {
    const ctx = await resolveWorkflowAccounts(tx, companyId, actor);
    const postedCogs = await postJournalEntry(tx, companyId, actor, {
      txnDate: invoiceDate,
      description: `WIP Relief to COGS — ${job.job_number} (Invoice ${invRes.invoice.invoiceNumber})`,
      reference: invRes.invoice.invoiceNumber,
      sourceType: 'production_cogs',
      sourceId: invoiceId,
      lines: [
        {
          accountId: ctx.cogs5000,
          debit: formatDecimal4(trancheWipRelief4),
          credit: '0.0000',
          description: `Production COGS recognized — ${job.job_number}`,
        },
        {
          accountId: ctx.wip1250,
          debit: '0.0000',
          credit: formatDecimal4(trancheWipRelief4),
          description: `Relieve WIP inventory — ${job.job_number}`,
        },
      ],
    });
    cogsJournalId = postedCogs.transaction.id;

    // Record exact relieved production cost on invoice header so gross_profit reflects true margin
    await tx.query(
      `UPDATE invoices
          SET total_cost = total_cost + $3::NUMERIC(19,4)
        WHERE company_id = $1 AND id = $2`,
      [companyId, invoiceId, formatDecimal4(trancheWipRelief4)]
    );
  }

  if (input?.deliveryNoteId && deliveryNoteLineId) {
    await tx.query(
      `UPDATE delivery_notes SET invoice_id = $3 WHERE company_id = $1 AND id = $2`,
      [companyId, Number(input.deliveryNoteId), invoiceId]
    );
    await tx.query(
      `UPDATE delivery_note_lines SET invoiced_qty = invoiced_qty + $3::NUMERIC(19,4) WHERE company_id = $1 AND id = $2`,
      [companyId, deliveryNoteLineId, formatDecimal4(qtyToInvoice4)]
    );
  }

  const nextJobStatus = isFinalTranche ? 'completed' : job.status;
  await tx.query(
    `UPDATE printing_jobs
        SET invoice_id = $3,
            invoiced_qty = $4::NUMERIC(19,4),
            wip_cost_relieved = wip_cost_relieved + $5::NUMERIC(19,4),
            cogs_journal_txn_id = COALESCE(cogs_journal_txn_id, $6),
            status = $7
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      jobId,
      invoiceId,
      formatDecimal4(nextInvoiced4),
      formatDecimal4(trancheWipRelief4),
      cogsJournalId,
      nextJobStatus,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'DELIVERED_JOB_INVOICED',
    tableName: 'printing_jobs',
    recordId: jobId,
    newValues: {
      invoiceId,
      invoiceNumber: invRes.invoice.invoiceNumber,
      qtyInvoiced: toMoneyNumber(qtyToInvoice4),
      wipRelieved: formatDecimal4(trancheWipRelief4),
      cogsJournalId,
    },
  });

  // Reload updated invoice
  const updatedInvRes = await tx.query<any>(
    `SELECT id, invoice_number, subtotal::text, total_cost::text, gross_profit::text, tax_amount::text, total::text, balance_due::text, status
       FROM invoices WHERE company_id = $1 AND id = $2`,
    [companyId, invoiceId]
  );
  const ui = updatedInvRes.rows[0];
  const out = {
    invoice: {
      ...invRes.invoice,
      totalCost: toMoneyNumber(parseDecimal4(ui.total_cost)),
      grossProfit: toMoneyNumber(parseDecimal4(ui.gross_profit)),
    },
    cogsJournalId,
    job: await getPrintingJobById(tx, companyId, jobId),
  };
  await saveRouteIdempotency(tx, companyId, `job_invoice_${jobId}`, input?.idempotencyKey, idem.payloadHash, 201, out, actor.userId);
  return { ...out, idempotentReplay: false };
}

// ============================================================================
// JOB CANCELLATION, CONTROLLED REPRINTS, JOB PROFITABILITY & INVENTORY VALUATION
// ============================================================================

export async function cancelPrintingJob(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  jobId: number,
  input: { reason: string; returnUnusedMaterials?: boolean; cancelDate?: string }
) {
  const reason = String(input.reason || '').trim();
  if (!reason) throw new AccountingError(400, 'Cancellation reason is required');

  const jRes = await tx.query<any>(
    `SELECT * FROM printing_jobs WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, jobId]
  );
  if (jRes.rows.length === 0) throw new AccountingError(404, 'Printing job not found');
  const job = jRes.rows[0];
  if (job.status === 'cancelled') throw new AccountingError(409, 'Job is already cancelled');
  if (parseDecimal4(job.delivered_qty) > 0n || parseDecimal4(job.invoiced_qty) > 0n || job.status === 'completed') {
    throw new AccountingError(
      409,
      `Cannot cancel job ${job.job_number} after delivery or invoicing`,
      'CANNOT_CANCEL_DELIVERED_JOB'
    );
  }

  const ctx = await resolveWorkflowAccounts(tx, companyId, actor);
  const cancelDate = input.cancelDate ? assertIsoDate(input.cancelDate, 'cancelDate') : todayIsoDate();

  // Release any unissued reservations
  const reqs = await tx.query<any>(
    `SELECT * FROM job_material_requirements WHERE company_id = $1 AND printing_job_id = $2 FOR UPDATE`,
    [companyId, jobId]
  );
  const returnLines: Array<{ requirementId: number; returnUsageQty: string }> = [];

  for (const r of reqs.rows) {
    const resUsage6 = parseDecimal6(r.reserved_usage_qty);
    if (resUsage6 > 0n) {
      const itRes = await tx.query<{ reserved_qty: string; conversion_factor: string }>(
        `SELECT COALESCE(reserved_qty, 0)::text AS reserved_qty, conversion_factor::text
           FROM inventory_items WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, Number(r.raw_material_item_id)]
      );
      const factor6 = parseDecimal6(itRes.rows[0].conversion_factor || '1');
      const relPurchase6 = usageToPurchaseUnits6(resUsage6, factor6, ctx.roundingMode);
      const currRes6 = parseDecimal6(itRes.rows[0].reserved_qty);
      const nextRes6 = currRes6 > relPurchase6 ? currRes6 - relPurchase6 : 0n;
      await tx.query(
        `UPDATE inventory_items SET reserved_qty = $3::NUMERIC(19,6) WHERE company_id = $1 AND id = $2`,
        [companyId, Number(r.raw_material_item_id), formatDecimal6(nextRes6)]
      );
      await tx.query(
        `UPDATE job_material_requirements SET reserved_usage_qty = 0.000000 WHERE company_id = $1 AND id = $2`,
        [companyId, Number(r.id)]
      );
    }

    if (input.returnUnusedMaterials) {
      const unconsumed6 =
        parseDecimal6(r.issued_usage_qty) -
        parseDecimal6(r.actual_good_usage_qty) -
        parseDecimal6(r.waste_usage_qty) -
        parseDecimal6(r.returned_usage_qty);
      if (unconsumed6 > 0n) {
        returnLines.push({ requirementId: Number(r.id), returnUsageQty: formatDecimal6(unconsumed6) });
      }
    }
  }

  if (returnLines.length > 0) {
    await returnUnusedMaterials(tx, companyId, actor, jobId, {
      returnDate: cancelDate,
      lines: returnLines,
    });
  }

  // Write off any remaining non-recoverable WIP to 5100 Spoilage & Production Variance
  const refreshed = await tx.query<{ wip_cost_accumulated: string; wip_cost_relieved: string }>(
    `SELECT wip_cost_accumulated::text, wip_cost_relieved::text FROM printing_jobs WHERE company_id = $1 AND id = $2`,
    [companyId, jobId]
  );
  const wipRemaining4 = parseDecimal4(refreshed.rows[0].wip_cost_accumulated) - parseDecimal4(refreshed.rows[0].wip_cost_relieved);
  let writeOffJournalId: number | null = null;

  if (wipRemaining4 > 0n) {
    const posted = await postJournalEntry(tx, companyId, actor, {
      txnDate: cancelDate,
      description: `Job Cancellation WIP Write-Off — ${job.job_number}: ${reason}`,
      reference: job.job_number,
      sourceType: 'production_variance',
      sourceId: jobId,
      lines: [
        {
          accountId: ctx.spoilageVariance5100,
          debit: formatDecimal4(wipRemaining4),
          credit: '0.0000',
          description: `Sunk WIP spoilage/cancellation variance — ${job.job_number}`,
        },
        {
          accountId: ctx.wip1250,
          debit: '0.0000',
          credit: formatDecimal4(wipRemaining4),
          description: `Clear cancelled job WIP — ${job.job_number}`,
        },
      ],
    });
    writeOffJournalId = posted.transaction.id;
  }

  await tx.query(
    `UPDATE printing_jobs
        SET status = 'cancelled',
            cancellation_reason = $3,
            cancelled_by = $4,
            cancelled_at = NOW(),
            wip_cost_relieved = wip_cost_accumulated,
            actual_waste_cost = actual_waste_cost + $5::NUMERIC(19,4),
            cogs_journal_txn_id = COALESCE(cogs_journal_txn_id, $6)
      WHERE company_id = $1 AND id = $2`,
    [companyId, jobId, reason, actor.userId, formatDecimal4(wipRemaining4), writeOffJournalId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_JOB_CANCELLED',
    tableName: 'printing_jobs',
    recordId: jobId,
    newValues: {
      reason,
      wipWrittenOff: formatDecimal4(wipRemaining4),
      writeOffJournalId,
    },
  });

  return {
    writeOffJournalId,
    wipWrittenOff: toMoneyNumber(wipRemaining4),
    job: await getPrintingJobById(tx, companyId, jobId),
  };
}

export async function createControlledReprint(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  parentJobId: number,
  input: {
    reprintReason: string;
    copies?: number;
    pages?: number;
    jobDate?: string;
    approveBudgetImmediately?: boolean;
    idempotencyKey?: string | null;
  }
) {
  const reprintReason = String(input.reprintReason || '').trim();
  if (!reprintReason) throw new AccountingError(400, 'reprintReason is required for controlled reprint authorization');

  const parent = await getPrintingJobById(tx, companyId, parentJobId);
  const res = await createPrintingJob(tx, companyId, actor, {
    jobType: parent.jobType,
    customerId: parent.customerId,
    customerName: parent.customerName,
    machineId: parent.machineId,
    rawPaperItemId: parent.rawPaperItemId,
    rawTonerItemId: parent.rawTonerItemId,
    title: `REPRINT: ${parent.title}`,
    pages: input.pages ?? parent.pages,
    copies: input.copies ?? parent.copies,
    orderedQty: input.copies ?? parent.copies,
    printSide: parent.printSide,
    manualSellingPrice: 0, // Controlled defect reprints carry 0 revenue so margin erosion is visible
    jobDate: input.jobDate,
    reprintOfJobId: parentJobId,
    reprintReason,
    idempotencyKey: input.idempotencyKey,
  });

  if (input.approveBudgetImmediately !== false) {
    const approved = await approveJobBudget(tx, companyId, actor, res.job.id, {
      note: `Authorized controlled reprint of ${parent.jobNumber}: ${reprintReason}`,
    });
    return { job: approved, idempotentReplay: res.idempotentReplay };
  }

  return res;
}

export async function getJobProfitabilityReport(tx: Transaction, companyId: number, jobId: number) {
  const parent = await getPrintingJobById(tx, companyId, jobId);
  const childrenRes = await tx.query<{ id: number }>(
    `SELECT id FROM printing_jobs WHERE company_id = $1 AND reprint_of_job_id = $2 ORDER BY id ASC`,
    [companyId, jobId]
  );
  const reprints: any[] = [];
  for (const c of childrenRes.rows) {
    reprints.push(await getPrintingJobById(tx, companyId, Number(c.id)));
  }

  const allJobIds = [jobId, ...reprints.map(r => r.id)];
  const invRes = await tx.query<{ revenue: string }>(
    `SELECT COALESCE(SUM(i.subtotal), 0)::NUMERIC(19,4)::text AS revenue
       FROM invoices i
      WHERE i.company_id = $1
        AND i.status <> 'voided'
        AND (
          i.id IN (SELECT invoice_id FROM printing_jobs WHERE company_id = $1 AND id = ANY($2::BIGINT[]) AND invoice_id IS NOT NULL)
          OR i.id IN (
            SELECT dn.invoice_id
              FROM delivery_notes dn
              JOIN delivery_note_lines dnl ON dnl.company_id = dn.company_id AND dnl.delivery_note_id = dn.id
             WHERE dn.company_id = $1 AND dnl.printing_job_id = ANY($2::BIGINT[]) AND dn.invoice_id IS NOT NULL
          )
        )`,
    [companyId, allJobIds]
  );

  const invoicedRevenue4 = parseDecimal4(invRes.rows[0].revenue);
  const quotedRevenue4 = parseDecimal4(parent.manualSellingPrice);
  const effectiveRevenue4 = invoicedRevenue4 > 0n ? invoicedRevenue4 : quotedRevenue4;

  const baseMaterial4 = parseDecimal4(parent.actualMaterialCost);
  const baseWaste4 = parseDecimal4(parent.actualWasteCost);
  const baseLabour4 = parseDecimal4(parent.actualLabourCost);
  const baseMachine4 = parseDecimal4(parent.actualMachineCost);
  const baseTotalActual4 = baseMaterial4 + baseLabour4 + baseMachine4;

  let reprintCost4 = 0n;
  for (const rp of reprints) {
    reprintCost4 +=
      parseDecimal4(rp.actualMaterialCost) +
      parseDecimal4(rp.actualLabourCost) +
      parseDecimal4(rp.actualMachineCost);
  }

  const combinedActualCost4 = baseTotalActual4 + reprintCost4;
  const approvedBudget4 = parseDecimal4(parent.approvedBudgetTotal);
  const budgetVariance4 = combinedActualCost4 - approvedBudget4;
  const actualProfit4 = effectiveRevenue4 - combinedActualCost4;
  const marginPct =
    effectiveRevenue4 > 0n
      ? Number(((Number(actualProfit4) / Number(effectiveRevenue4)) * 100).toFixed(2))
      : 0;

  return {
    jobId,
    jobNumber: parent.jobNumber,
    title: parent.title,
    status: parent.status,
    quotedRevenue: toMoneyNumber(quotedRevenue4),
    invoicedRevenue: toMoneyNumber(invoicedRevenue4),
    approvedBudget: {
      material: toMoneyNumber(parseDecimal4(parent.approvedBudgetMaterial)),
      labour: toMoneyNumber(parseDecimal4(parent.approvedBudgetLabour)),
      machine: toMoneyNumber(parseDecimal4(parent.approvedBudgetMachine)),
      total: toMoneyNumber(approvedBudget4),
    },
    actualCosts: {
      material: toMoneyNumber(baseMaterial4),
      wasteMemoIncludedInMaterial: toMoneyNumber(baseWaste4),
      labour: toMoneyNumber(baseLabour4),
      machine: toMoneyNumber(baseMachine4),
      baseJobTotal: toMoneyNumber(baseTotalActual4),
      reprintTotal: toMoneyNumber(reprintCost4),
      combinedTotal: toMoneyNumber(combinedActualCost4),
    },
    budgetVariance: toMoneyNumber(budgetVariance4),
    actualProfit: toMoneyNumber(actualProfit4),
    profitMarginPct: marginPct,
    reprints: reprints.map(r => ({
      id: r.id,
      jobNumber: r.jobNumber,
      reprintReason: r.reprintReason,
      totalCost: toMoneyNumber(
        parseDecimal4(r.actualMaterialCost) + parseDecimal4(r.actualLabourCost) + parseDecimal4(r.actualMachineCost)
      ),
    })),
  };
}

export async function getInventoryValuationReport(tx: Transaction, companyId: number) {
  const itemsRes = await tx.query<{
    id: number;
    sku: string;
    name: string;
    item_type: string;
    purchase_unit: string;
    usage_unit: string;
    conversion_factor: string;
    on_hand: string;
    reserved_qty: string;
    unit_cost: string;
    avg_cost: string;
  }>(
    `SELECT id, sku, name, item_type, purchase_unit, usage_unit, conversion_factor::text,
            on_hand::text, COALESCE(reserved_qty, 0)::text AS reserved_qty,
            unit_cost::text, avg_cost::text
       FROM inventory_items
      WHERE company_id = $1 AND is_active = TRUE AND item_type IN ('raw_material', 'stationery')
      ORDER BY id ASC`,
    [companyId]
  );

  let totalSubledgerValuation4 = 0n;
  const items = itemsRes.rows.map(r => {
    const onHand6 = parseDecimal6(r.on_hand);
    const reserved6 = parseDecimal6(r.reserved_qty);
    const available6 = onHand6 - reserved6;
    const effCost6 = getEffectivePurchaseUnitCost6(r);
    const valuation4 = divRoundBigInt(onHand6 * effCost6, 100000000n, 'HALF_EVEN');
    totalSubledgerValuation4 += valuation4;
    return {
      id: Number(r.id),
      sku: r.sku,
      name: r.name,
      itemType: r.item_type,
      purchaseUnit: r.purchase_unit,
      usageUnit: r.usage_unit,
      conversionFactor: Number(r.conversion_factor),
      onHand: Number(r.on_hand),
      reservedQty: Number(r.reserved_qty),
      availableQty: Number(formatDecimal6(available6)),
      unitCost: Number(r.unit_cost),
      avgCost: Number(r.avg_cost),
      valuationCost: toMoneyNumber(valuation4),
    };
  });

  const glRes = await tx.query<{ gl_balance: string }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::NUMERIC(19,4)::text AS gl_balance
       FROM journal_lines jl
       JOIN journal_transactions jt ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
       JOIN accounts a ON a.company_id = jl.company_id AND a.id = jl.account_id
      WHERE jl.company_id = $1 AND jt.is_posted = TRUE AND jl.basis IN ('both', 'accrual') AND a.code = '1200'`,
    [companyId]
  );
  const glInventory1200_4 = parseDecimal4(glRes.rows[0].gl_balance);

  const wipRes = await tx.query<{ wip_balance: string }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::NUMERIC(19,4)::text AS wip_balance
       FROM journal_lines jl
       JOIN journal_transactions jt ON jt.company_id = jl.company_id AND jt.id = jl.transaction_id
       JOIN accounts a ON a.company_id = jl.company_id AND a.id = jl.account_id
      WHERE jl.company_id = $1 AND jt.is_posted = TRUE AND jl.basis IN ('both', 'accrual') AND a.code = '1250'`,
    [companyId]
  );
  const wip1250_4 = parseDecimal4(wipRes.rows[0].wip_balance);

  return {
    items,
    totalSubledgerValuation: toMoneyNumber(totalSubledgerValuation4),
    glInventory1200Balance: toMoneyNumber(glInventory1200_4),
    valuationVariance: toMoneyNumber(totalSubledgerValuation4 - glInventory1200_4),
    wip1250Balance: toMoneyNumber(wip1250_4),
  };
}
