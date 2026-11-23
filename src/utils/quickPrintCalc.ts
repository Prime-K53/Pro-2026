import { InventoryItem, QuickPrintJobType } from '../types/accounting';

/**
 * Quick Print Calculation utilities
 *
 * Treats typing and printing selling charges as revenue, not material cost.
 * Calculates photocopying per physical sheet (duplex-aware).
 * Preserves separation between document pages, printed sheets and photocopy quantities.
 */

export interface QuickPrintEstimateInput {
  paperItem?: InventoryItem;
  tonerItem?: InventoryItem;
  paperUsageUnitCost?: number;
  tonerUsageUnitCost?: number;
  jobType: QuickPrintJobType;
  pages: number;
  copies: number;
  printSide: 'Single-Sided' | 'Duplex';
  extraCostPerPage?: number;
  sellingPricePerSheet?: number;
}

export interface QuickPrintEstimate {
  safePages: number;
  safeExtraPerPage: number;
  safePricePerSheet: number;
  sheetsUsed: number;
  impressionsUsed: number;
  paperCost: number;
  tonerCost: number;
  extraCostTotal: number;
  finishingCost: number;
  typingRevenue: number;
  photocopyRevenue: number;
  totalCost: number;
  sellingPriceTotal: number;
  realProfit: number;
  profitMarginPct: number;
  isEstimated: boolean;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function perUsageUnitCost(
  item: InventoryItem | undefined,
  explicit: number | undefined
): { cost: number; estimated: boolean } {
  if (explicit != null && Number.isFinite(explicit) && explicit >= 0) {
    return { cost: explicit, estimated: false };
  }
  const purchaseCost = Number(item?.cost ?? 0);
  const factor = Number(item?.conversionFactor ?? 0);
  if (factor > 0) {
    return { cost: purchaseCost / factor, estimated: false };
  }
  return { cost: 0, estimated: true };
}

export function computeQuickPrintEstimate(
  input: QuickPrintEstimateInput
): QuickPrintEstimate {
  const safePages = Math.max(1, Number(input.pages) || 1);
  const copies = Math.max(1, Number(input.copies) || 1);
  const isDuplex = input.printSide === 'Duplex';
  const sheetsUsed = isDuplex ? Math.ceil(safePages / 2) * copies : safePages * copies;
  const impressionsUsed = safePages * copies;

  const safeExtraPerPage = Math.max(0, Number(input.extraCostPerPage) || 0);
  const safePricePerSheet = Math.max(0, Number(input.sellingPricePerSheet) || 0);

  const paper = perUsageUnitCost(input.paperItem, input.paperUsageUnitCost);
  const toner = perUsageUnitCost(input.tonerItem, input.tonerUsageUnitCost);

  const paperCost = round2(sheetsUsed * paper.cost);
  const tonerCost = round2(impressionsUsed * toner.cost);
  // The per-page extra charge is priced per TYPED/FINISHED PAGE, not per
  // impression, matching the server engines (finishingCostPerPage * pages and
  // typingFee * typedPages). For type_and_printing it is service revenue; for
  // quick_photocopy / general_print it is a physical finishing expense.
  const extraCostTotal = round2(safeExtraPerPage * safePages);
  const isTypeAndPrinting = input.jobType === 'type_and_printing';
  const typingRevenue = isTypeAndPrinting ? extraCostTotal : 0;
  const finishingCost = isTypeAndPrinting ? 0 : extraCostTotal;

  // Material production cost never includes the typing service charge.
  const totalCost = round2(paperCost + tonerCost + finishingCost);

  const photocopyRevenue = round2(safePricePerSheet * sheetsUsed);
  // The customer-facing selling amount is the complete charge: photocopying plus
  // the typing & printing service fee.
  const sellingPriceTotal = round2(photocopyRevenue + typingRevenue);
  const realProfit = round2(sellingPriceTotal - totalCost);
  const profitMarginPct = sellingPriceTotal > 0 ? (realProfit / sellingPriceTotal) * 100 : 0;

  return {
    safePages,
    safeExtraPerPage,
    safePricePerSheet,
    sheetsUsed,
    impressionsUsed,
    paperCost,
    tonerCost,
    extraCostTotal,
    finishingCost,
    typingRevenue,
    photocopyRevenue,
    totalCost,
    sellingPriceTotal,
    realProfit,
    profitMarginPct,
    isEstimated: toner.estimated,
  };
}