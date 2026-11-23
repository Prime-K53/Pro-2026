import type { InventoryItem } from '../../types/accounting.ts';
import { RoundingMode } from '../lib/decimal.ts';
import {
  BookPaperCalculationInput,
  BookPaperCalculationResult,
  calculateBookPaper,
  calculatePhotocopyPaper,
  computePaperCostForSheets,
  FinishingMaterialLine,
  PaperMarginsMm,
  PaperStockSpec,
  PhotocopyPaperInput,
  PhotocopyPaperResult,
  PhotocopyPlacementMode,
  PhotocopySegmentInput,
  SheetEdge,
} from './paperCalc.ts';
import {
  calculateToner,
  TonerCalculationInput,
  TonerCalculationMethod,
  TonerCalculationResult,
  TonerChannel,
  TonerChannelSpec,
  TonerColorMode,
  TonerCoverageEvidence,
  TonerMachineSpec,
} from './tonerCalc.ts';

export type ApprovedPrintingServiceCategory =
  | 'book_printing'
  | 'photocopying'
  | 'examination_production'
  | 'examination_contract'
  | 'printing_contract'
  | 'printing_service'
  | 'type_and_printing';

export interface CommercialPricingOverlay {
  sellingPrice?: number;
  contractPrice?: number;
  discountAmount?: number;
  promotionAmount?: number;
}

export interface CommercialFinancialSummary {
  materialPaperCost: number;
  materialTonerCost: number | null;
  finishingCost: number;
  typingFee: number;
  typingRevenue: number;
  extraCost: number;
  totalProductionCost: number | null;
  grossSellingPrice: number;
  discountAmount: number;
  netRevenue: number;
  realProfit: number | null;
  profitMarginPct: number | null;
  tonerCostStatus: TonerCalculationResult['totalCostStatus'];
  tonerMassStatus: TonerCalculationResult['totalMassStatus'];
}

export interface TypingFeeConfig {
  mode: 'flat' | 'per_page';
  rate: number;
  typedPages?: number;
}

export interface StandardSheetPrintWorkflowInput {
  paperStock: PaperStockSpec;
  tonerChannels: Partial<Record<TonerChannel, TonerChannelSpec>>;
  machine: TonerMachineSpec;
  colorMode: TonerColorMode;
  tonerMethod?: TonerCalculationMethod;
  coverageUniform?: TonerCoverageEvidence | null;
  coverageByChannel?: Partial<Record<TonerChannel, TonerCoverageEvidence | null>>;
  copies: number;
  mode: PhotocopyPlacementMode;
  pages?: number;
  nUp?: number;
  segments?: PhotocopySegmentInput[];
  makeReadySheets?: number;
  runningWastePct?: number;
  makeReadyImpressions?: number;
  trimWidthMm?: number;
  trimHeightMm?: number;
  bleedMm?: number;
  marginsMm?: Partial<PaperMarginsMm>;
  gripperEdge?: SheetEdge;
  gripperMarginMm?: number;
  finishingMaterials?: FinishingMaterialLine[];
  commercialPricing?: CommercialPricingOverlay;
  allowInsufficientStockPreview?: boolean;
  roundingMode?: RoundingMode;
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

function computeCommercialSummary(params: {
  paperCost: number;
  toner: TonerCalculationResult;
  finishingCost?: number;
  typingFee?: number;
  extraCost?: number;
  commercialPricing?: CommercialPricingOverlay;
}): CommercialFinancialSummary {
  const finishingCost = round2(params.finishingCost ?? 0);
  const typingFee = round2(params.typingFee ?? 0);
  const extraCost = round2(params.extraCost ?? 0);
  const tonerCost = params.toner.totalCost;
  // Typing & printing is a customer-facing service revenue, never a material
  // production cost. Physical finishing (staple/bind) and extra material charges
  // stay in the production cost.
  const totalProductionCost =
    tonerCost !== null
      ? round2(params.paperCost + tonerCost + finishingCost + extraCost)
      : null;

  const grossSellingPrice = round2(
    params.commercialPricing?.contractPrice ?? params.commercialPricing?.sellingPrice ?? 0
  );
  const discountAmount = round2(
    (params.commercialPricing?.discountAmount ?? 0) +
      (params.commercialPricing?.promotionAmount ?? 0)
  );
  const netRevenue = round2(grossSellingPrice - discountAmount);
  // Typing revenue is additive to the net selling revenue when the caller quotes
  // photocopying only. It is tracked explicitly so profit is not understated.
  const totalRevenue = round2(netRevenue + typingFee);
  const realProfit =
    totalProductionCost !== null ? round2(totalRevenue - totalProductionCost) : null;
  const profitMarginPct =
    realProfit !== null && totalRevenue > 0 ? round2((realProfit / totalRevenue) * 100) : null;

  return {
    materialPaperCost: round2(params.paperCost),
    materialTonerCost: tonerCost,
    finishingCost,
    typingFee,
    typingRevenue: typingFee,
    extraCost,
    totalProductionCost,
    grossSellingPrice,
    discountAmount,
    netRevenue,
    realProfit,
    profitMarginPct,
    tonerCostStatus: params.toner.totalCostStatus,
    tonerMassStatus: params.toner.totalMassStatus,
  };
}

/**
 * Helper: Adapts an InventoryItem raw material to PaperStockSpec or TonerChannelSpec without inventing missing physical dimensions or calibration.
 */
export function buildPaperStockFromInventoryItem(
  item: InventoryItem,
  overrides?: Partial<PaperStockSpec>
): PaperStockSpec {
  const pUnit = (item.purchaseUnit || 'Ream').trim();
  const pUnitLower = pUnit.toLowerCase();
  const factor = item.conversionFactor && item.conversionFactor > 0 ? item.conversionFactor : null;
  return {
    itemId: item.id,
    sku: item.sku,
    name: item.name,
    isActive: true,
    isRawMaterial: item.type === 'raw_material',
    purchaseUnit: pUnit,
    usageUnit: item.usageUnit || 'Sheet',
    conversionFactor: factor,
    sheetsPerReam: pUnitLower === 'ream' || pUnitLower === 'reams' ? factor : null,
    sheetsPerPack: pUnitLower === 'pack' || pUnitLower === 'packs' ? factor : null,
    purchaseUnitCost: item.cost,
    onHandPurchaseUnits: item.onHand,
    ...overrides,
  };
}

export function buildTonerSpecFromInventoryItem(
  item: InventoryItem,
  channel: TonerChannel = 'K',
  overrides?: Partial<TonerChannelSpec>
): TonerChannelSpec {
  return {
    itemId: item.id,
    sku: item.sku,
    name: item.name,
    channel,
    isActive: true,
    cartridgeCost: item.cost,
    ratedYieldImpressions:
      item.conversionFactor && item.conversionFactor > 0 ? item.conversionFactor : null,
    ...overrides,
  };
}

// ============================================================================
// 1. BOOK PRINTING (Printed Products — Signatures, Caliper Spine, Finishing)
// ============================================================================
export interface BookPrintingWorkflowInput {
  paper: BookPaperCalculationInput;
  toner: Omit<TonerCalculationInput, 'impressions'> & {
    impressions?: TonerCalculationInput['impressions'];
  };
  commercialPricing?: CommercialPricingOverlay;
}

export interface BookPrintingWorkflowResult {
  serviceCategory: 'book_printing';
  paper: BookPaperCalculationResult;
  toner: TonerCalculationResult;
  finishingMaterials: FinishingMaterialLine[];
  commercial: CommercialFinancialSummary;
}

export function calculateBookPrintingWorkflow(
  input: BookPrintingWorkflowInput
): BookPrintingWorkflowResult {
  const paper = calculateBookPaper(input.paper);
  const toner = calculateToner({
    ...input.toner,
    impressions: input.toner.impressions ?? {
      printedSideImpressions: paper.totals.totalPrintedSideImpressions,
    },
  });

  const commercial = computeCommercialSummary({
    paperCost: paper.totals.totalPaperCost,
    toner,
    finishingCost: paper.finishingCostTotal,
    commercialPricing: input.commercialPricing,
  });

  return {
    serviceCategory: 'book_printing',
    paper,
    toner,
    finishingMaterials: paper.finishingMaterials,
    commercial,
  };
}

// ============================================================================
// 2. PHOTOCOPYING (Simplex, Duplex, Mixed)
// ============================================================================
export interface PhotocopyWorkflowResult {
  serviceCategory: 'photocopying';
  paper: PhotocopyPaperResult;
  toner: TonerCalculationResult;
  finishingMaterials: FinishingMaterialLine[];
  commercial: CommercialFinancialSummary;
}

export function calculatePhotocopyWorkflow(
  input: StandardSheetPrintWorkflowInput
): PhotocopyWorkflowResult {
  const paperInput: PhotocopyPaperInput = {
    stock: input.paperStock,
    copies: input.copies,
    mode: input.mode,
    pages: input.pages,
    nUp: input.nUp,
    segments: input.segments,
    makeReadySheets: input.makeReadySheets ?? 0,
    runningWastePct: input.runningWastePct ?? 0,
    machine: {
      machineId: input.machine.machineId,
      machineName: input.machine.name,
      supportsDuplex: input.machine.supportsDuplex,
      gripperEdge: input.gripperEdge,
      gripperMarginMm: input.gripperMarginMm,
      defaultMarginsMm: input.marginsMm,
    },
    trimWidthMm: input.trimWidthMm,
    trimHeightMm: input.trimHeightMm,
    bleedMm: input.bleedMm,
    marginsMm: input.marginsMm,
    gripperEdge: input.gripperEdge,
    gripperMarginMm: input.gripperMarginMm,
    allowInsufficientStockPreview: input.allowInsufficientStockPreview,
    roundingMode: input.roundingMode,
  };

  const paper = calculatePhotocopyPaper(paperInput);
  const toner = calculateToner({
    machine: input.machine,
    colorMode: input.colorMode,
    method: input.tonerMethod ?? 'auto',
    impressions: {
      printedSideImpressions: paper.quantities.printedSideImpressions,
      makeReadyPrintedSides: input.makeReadyImpressions ?? 0,
    },
    channels: input.tonerChannels,
    coverageUniform: input.coverageUniform,
    coverageByChannel: input.coverageByChannel,
    roundingMode: input.roundingMode,
  });

  const finishingMaterials = input.finishingMaterials ?? [];
  const finishingCost = finishingMaterials.reduce((s, f) => s + f.totalCost, 0);

  return {
    serviceCategory: 'photocopying',
    paper,
    toner,
    finishingMaterials,
    commercial: computeCommercialSummary({
      paperCost: paper.quantities.totalPaperCost,
      toner,
      finishingCost,
      commercialPricing: input.commercialPricing,
    }),
  };
}

// ============================================================================
// 3. EXAMINATION PRODUCTION (Per-Learner Class Pricing + Shared Subject Paper/Toner)
// ============================================================================
export interface ExamSubjectPrintSpec {
  subjectName: string;
  className: string;
  assessmentName: string;
  learnersCount: number;
  pricePerLearner: number;
  pages: number;
  copies: number;
  mode: 'simplex' | 'duplex';
  paperStock: PaperStockSpec;
  tonerChannels: Partial<Record<TonerChannel, TonerChannelSpec>>;
  machine: TonerMachineSpec;
  colorMode: TonerColorMode;
  tonerMethod?: TonerCalculationMethod;
  makeReadySheets?: number;
  runningWastePct?: number;
  allowInsufficientStockPreview?: boolean;
}

export interface ExamPaperWorkflowResult {
  subjectName: string;
  className: string;
  assessmentName: string;
  paper: PhotocopyPaperResult;
  toner: TonerCalculationResult;
  sheetsUsed: number;
  impressionsUsed: number;
  paperCost: number;
  tonerCost: number;
  materialCost: number;
  classBillingAmount: number;
}

export interface ExamClassBillingSummary {
  className: string;
  assessmentName: string;
  learnersCount: number;
  pricePerLearner: number;
  classRevenue: number;
  totalSheets: number;
  totalImpressions: number;
  totalPaperCost: number;
  totalTonerCost: number;
  totalMaterialCost: number;
  realProfit: number;
}

export interface ExaminationProductionWorkflowResult {
  serviceCategory: 'examination_production';
  papers: ExamPaperWorkflowResult[];
  classSummaries: ExamClassBillingSummary[];
  totals: {
    totalSheets: number;
    totalImpressions: number;
    totalPaperCost: number;
    totalTonerCost: number;
    totalMaterialCost: number;
    totalClassRevenue: number;
    totalProfit: number;
  };
}

export function calculateExaminationProductionWorkflow(
  subjects: ExamSubjectPrintSpec[]
): ExaminationProductionWorkflowResult {
  const papers: ExamPaperWorkflowResult[] = subjects.map(sub => {
    const paper = calculatePhotocopyPaper({
      stock: sub.paperStock,
      copies: sub.copies,
      mode: sub.mode,
      pages: sub.pages,
      makeReadySheets: sub.makeReadySheets ?? 0,
      runningWastePct: sub.runningWastePct ?? 0,
      allowInsufficientStockPreview: sub.allowInsufficientStockPreview,
    });
    const toner = calculateToner({
      machine: sub.machine,
      colorMode: sub.colorMode,
      method: sub.tonerMethod ?? 'auto',
      impressions: { printedSideImpressions: paper.quantities.printedSideImpressions },
      channels: sub.tonerChannels,
    });
    const paperCost = paper.quantities.totalPaperCost;
    const tonerCost = toner.totalCost ?? 0;
    const materialCost = round2(paperCost + tonerCost);
    const classBillingAmount = round2(sub.learnersCount * sub.pricePerLearner);

    return {
      subjectName: sub.subjectName,
      className: sub.className,
      assessmentName: sub.assessmentName,
      paper,
      toner,
      sheetsUsed: paper.quantities.totalSheets,
      impressionsUsed: paper.quantities.printedSideImpressions,
      paperCost,
      tonerCost,
      materialCost,
      classBillingAmount,
    };
  });

  // Class-level per-learner billing aggregation (price is per learner in each class, not per subject)
  const classMap = new Map<string, ExamClassBillingSummary>();
  for (let i = 0; i < subjects.length; i++) {
    const sub = subjects[i];
    const res = papers[i];
    const key = `${sub.className.trim().toLowerCase()}__${sub.assessmentName.trim().toLowerCase()}`;
    const existing = classMap.get(key);
    if (!existing) {
      const classRevenue = round2(sub.learnersCount * sub.pricePerLearner);
      classMap.set(key, {
        className: sub.className,
        assessmentName: sub.assessmentName,
        learnersCount: sub.learnersCount,
        pricePerLearner: sub.pricePerLearner,
        classRevenue,
        totalSheets: res.sheetsUsed,
        totalImpressions: res.impressionsUsed,
        totalPaperCost: res.paperCost,
        totalTonerCost: res.tonerCost,
        totalMaterialCost: res.materialCost,
        realProfit: round2(classRevenue - res.materialCost),
      });
    } else {
      existing.totalSheets += res.sheetsUsed;
      existing.totalImpressions += res.impressionsUsed;
      existing.totalPaperCost = round2(existing.totalPaperCost + res.paperCost);
      existing.totalTonerCost = round2(existing.totalTonerCost + res.tonerCost);
      existing.totalMaterialCost = round2(existing.totalMaterialCost + res.materialCost);
      existing.realProfit = round2(existing.classRevenue - existing.totalMaterialCost);
    }
  }

  const classSummaries = Array.from(classMap.values());
  const totalPaperCost = round2(papers.reduce((s, p) => s + p.paperCost, 0));
  const totalTonerCost = round2(papers.reduce((s, p) => s + p.tonerCost, 0));
  const totalMaterialCost = round2(totalPaperCost + totalTonerCost);
  const totalClassRevenue = round2(classSummaries.reduce((s, c) => s + c.classRevenue, 0));

  return {
    serviceCategory: 'examination_production',
    papers,
    classSummaries,
    totals: {
      totalSheets: papers.reduce((s, p) => s + p.sheetsUsed, 0),
      totalImpressions: papers.reduce((s, p) => s + p.impressionsUsed, 0),
      totalPaperCost,
      totalTonerCost,
      totalMaterialCost,
      totalClassRevenue,
      totalProfit: round2(totalClassRevenue - totalMaterialCost),
    },
  };
}

// ============================================================================
// 4. EXAMINATION CONTRACTS (Exam Runs Matched Against Contract Milestones)
// ============================================================================
export interface ExaminationContractWorkflowInput {
  agreedAssessmentAmount: number;
  discountAmount?: number;
  subjects: ExamSubjectPrintSpec[];
}

export interface ExaminationContractWorkflowResult {
  serviceCategory: 'examination_contract';
  production: ExaminationProductionWorkflowResult;
  contractAgreedAmount: number;
  discountAmount: number;
  netContractRevenue: number;
  assessmentProfit: number;
}

export function calculateExaminationContractWorkflow(
  input: ExaminationContractWorkflowInput
): ExaminationContractWorkflowResult {
  // Physical production consumption NEVER depends on contract pricing or discounts
  const production = calculateExaminationProductionWorkflow(input.subjects);
  const discountAmount = round2(input.discountAmount ?? 0);
  const netContractRevenue = round2(input.agreedAssessmentAmount - discountAmount);
  const assessmentProfit = round2(netContractRevenue - production.totals.totalMaterialCost);

  return {
    serviceCategory: 'examination_contract',
    production,
    contractAgreedAmount: round2(input.agreedAssessmentAmount),
    discountAmount,
    netContractRevenue,
    assessmentProfit,
  };
}

// ============================================================================
// 5. PRINTING CONTRACTS (Assessment Schedule Costing Independent of Contract Pricing)
// ============================================================================
export interface PrintingContractWorkflowInput extends StandardSheetPrintWorkflowInput {
  agreedAmount: number;
  discountAmount?: number;
}

export interface PrintingContractWorkflowResult {
  serviceCategory: 'printing_contract';
  paper: PhotocopyPaperResult;
  toner: TonerCalculationResult;
  commercial: CommercialFinancialSummary;
}

export function calculatePrintingContractWorkflow(
  input: PrintingContractWorkflowInput
): PrintingContractWorkflowResult {
  const res = calculatePhotocopyWorkflow({
    ...input,
    commercialPricing: {
      contractPrice: input.agreedAmount,
      discountAmount: input.discountAmount ?? 0,
    },
  });
  return {
    serviceCategory: 'printing_contract',
    paper: res.paper,
    toner: res.toner,
    commercial: res.commercial,
  };
}

// ============================================================================
// 6. PRINTING SERVICES (General / Commercial Press Services)
// ============================================================================
export interface PrintingServiceWorkflowResult {
  serviceCategory: 'printing_service';
  paper: PhotocopyPaperResult;
  toner: TonerCalculationResult;
  finishingMaterials: FinishingMaterialLine[];
  commercial: CommercialFinancialSummary;
}

export function calculatePrintingServiceWorkflow(
  input: StandardSheetPrintWorkflowInput
): PrintingServiceWorkflowResult {
  const res = calculatePhotocopyWorkflow(input);
  return {
    serviceCategory: 'printing_service',
    paper: res.paper,
    toner: res.toner,
    finishingMaterials: res.finishingMaterials,
    commercial: res.commercial,
  };
}

// ============================================================================
// 7. TYPE AND PRINTING (Separate Configurable Typing Fee + Paper/Toner Engine)
// ============================================================================
export interface TypeAndPrintingWorkflowInput extends StandardSheetPrintWorkflowInput {
  typingFee: TypingFeeConfig;
  extraFinishingCost?: number;
}

export interface TypeAndPrintingWorkflowResult {
  serviceCategory: 'type_and_printing';
  typingFee: {
    mode: 'flat' | 'per_page';
    rate: number;
    typedPages: number;
    amount: number;
  };
  paper: PhotocopyPaperResult;
  toner: TonerCalculationResult;
  commercial: CommercialFinancialSummary;
}

export function calculateTypeAndPrintingWorkflow(
  input: TypeAndPrintingWorkflowInput
): TypeAndPrintingWorkflowResult {
  const typedPages = input.typingFee.typedPages ?? input.pages ?? 1;
  const typingAmount =
    input.typingFee.mode === 'per_page'
      ? round2(input.typingFee.rate * typedPages)
      : round2(input.typingFee.rate);

  const printRes = calculatePhotocopyWorkflow({
    ...input,
    commercialPricing: input.commercialPricing,
  });

  const extraFinishing = round2(input.extraFinishingCost ?? 0);
  const finishingTotal = round2(printRes.commercial.finishingCost + extraFinishing);
  const tonerCost = printRes.toner.totalCost;
  // Printing production cost remains paper + toner + physical finishing. The
  // typing fee is a customer-facing service revenue, never a material cost, so it
  // is excluded here and added to revenue below.
  const totalProductionCost =
    tonerCost !== null
      ? round2(printRes.paper.quantities.totalPaperCost + tonerCost + finishingTotal)
      : null;

  const grossSellingPrice = round2(
    input.commercialPricing?.contractPrice ?? input.commercialPricing?.sellingPrice ?? 0
  );
  const discountAmount = round2(
    (input.commercialPricing?.discountAmount ?? 0) +
      (input.commercialPricing?.promotionAmount ?? 0)
  );
  const netRevenue = round2(grossSellingPrice - discountAmount);
  const totalRevenue = round2(netRevenue + typingAmount);
  const realProfit =
    totalProductionCost !== null ? round2(totalRevenue - totalProductionCost) : null;
  const profitMarginPct =
    realProfit !== null && totalRevenue > 0 ? round2((realProfit / totalRevenue) * 100) : null;

  return {
    serviceCategory: 'type_and_printing',
    typingFee: {
      mode: input.typingFee.mode,
      rate: round2(input.typingFee.rate),
      typedPages,
      amount: typingAmount,
    },
    paper: printRes.paper,
    toner: printRes.toner,
    commercial: {
      materialPaperCost: printRes.commercial.materialPaperCost,
      materialTonerCost: printRes.commercial.materialTonerCost,
      finishingCost: finishingTotal,
      typingFee: typingAmount,
      typingRevenue: typingAmount,
      extraCost: extraFinishing,
      totalProductionCost,
      grossSellingPrice,
      discountAmount,
      netRevenue,
      realProfit,
      profitMarginPct,
      tonerCostStatus: printRes.toner.totalCostStatus,
      tonerMassStatus: printRes.toner.totalMassStatus,
    },
  };
}

/**
 * Computes Printing Contract milestone paper & toner costs for estimated sheet and impression budgets
 * strictly through paperCalc and tonerCalc without altering physical volume from contract revenue.
 */
export function calculateContractMilestoneEstimate(params: {
  paperStock?: PaperStockSpec | null;
  tonerChannels?: Partial<Record<TonerChannel, TonerChannelSpec>> | null;
  machine: TonerMachineSpec;
  estimatedSheets: number;
  estimatedImpressions: number;
  agreedAmount: number;
  discountAmount?: number;
  colorMode?: TonerColorMode;
}): {
  paperCost: number;
  tonerCost: number;
  totalCost: number;
  profit: number;
  tonerCostStatus: TonerCalculationResult['totalCostStatus'];
} {
  const paperCost = params.paperStock
    ? computePaperCostForSheets({ stock: params.paperStock, sheets: Math.max(0, params.estimatedSheets) }).totalCost
    : 0;
  let tonerCost = 0;
  let tonerCostStatus: TonerCalculationResult['totalCostStatus'] = 'unavailable';

  if (params.tonerChannels && params.tonerChannels.K) {
    const tonerRes = calculateToner({
      machine: params.machine,
      colorMode: params.colorMode ?? 'mono',
      method: 'auto',
      impressions: { printedSideImpressions: Math.max(0, params.estimatedImpressions) },
      channels: params.tonerChannels,
    });
    tonerCost = tonerRes.totalCost ?? 0;
    tonerCostStatus = tonerRes.totalCostStatus;
  }

  const totalCost = round2(paperCost + tonerCost);
  const netRevenue = round2(params.agreedAmount - (params.discountAmount ?? 0));
  return {
    paperCost,
    tonerCost,
    totalCost,
    profit: round2(netRevenue - totalCost),
    tonerCostStatus,
  };
}

