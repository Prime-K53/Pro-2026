import type { Transaction } from '@electric-sql/pglite';
import {
  formatDecimal2,
  formatDecimal4,
  parseDecimal4,
  RoundingMode,
  toMoneyNumber,
} from './decimal.ts';

export type PaperUnit = 'sheet' | 'ream' | 'pack' | 'kg';

export type PaperErrorCode =
  | 'MISSING_PAPER_CONVERSION'
  | 'UNAVAILABLE_STOCK'
  | 'INFEASIBLE_LAYOUT'
  | 'MISSING_MEASURED_CALIPER'
  | 'INVALID_PAPER_SPEC'
  | 'PAPER_STOCK_NOT_FOUND';

export class PaperCalculationError extends Error {
  public readonly code: PaperErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: PaperErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PaperCalculationError';
    this.code = code;
    this.details = details;
  }
}

export type SheetEdge = 'top' | 'bottom' | 'left' | 'right';
export type SignaturePlanMode = 'padded' | 'short_signature';
export type ImpositionOrientation = 'normal' | 'rotated';

export interface PaperMarginsMm {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PaperStockSpec {
  itemId: string | number;
  paperSpecId?: string | number | null;
  sku?: string;
  name: string;
  isActive?: boolean;
  isRawMaterial?: boolean;
  widthMm?: number | null;
  heightMm?: number | null;
  gsm?: number | null;
  measuredCaliperMm?: number | null;
  grainDirection?: 'long' | 'short' | null;
  purchaseUnit: string;
  usageUnit?: string;
  conversionFactor?: number | null;
  sheetsPerReam?: number | null;
  sheetsPerPack?: number | null;
  kgPerSheet?: number | null;
  purchaseUnitCost: number | string;
  onHandPurchaseUnits?: number | string | null;
}

export interface PaperMachineConstraints {
  machineId?: string | number;
  machineName?: string;
  maxSheetWidthMm?: number | null;
  maxSheetHeightMm?: number | null;
  supportsDuplex?: boolean;
  gripperEdge?: SheetEdge;
  gripperMarginMm?: number;
  defaultMarginsMm?: Partial<PaperMarginsMm>;
}

export interface UsableAreaInput {
  stockWidthMm: number;
  stockHeightMm: number;
  marginsMm?: Partial<PaperMarginsMm>;
  gripperEdge?: SheetEdge;
  gripperMarginMm?: number;
  machineMaxWidthMm?: number | null;
  machineMaxHeightMm?: number | null;
}

export interface UsableAreaResult {
  stockWidthMm: number;
  stockHeightMm: number;
  effectiveMarginsMm: PaperMarginsMm;
  usableWidthMm: number;
  usableHeightMm: number;
}

export interface ImpositionInput extends UsableAreaInput {
  trimWidthMm: number;
  trimHeightMm: number;
  bleedMm?: number;
  gutterXMm?: number;
  gutterYMm?: number;
  allowRotation?: boolean;
  forcedOrientation?: ImpositionOrientation;
  grainDirection?: 'long' | 'short' | null;
  requireGrainMatch?: boolean;
}

export interface ImpositionResult {
  orientation: ImpositionOrientation;
  columns: number;
  rows: number;
  pagesPerSide: number;
  usableWidthMm: number;
  usableHeightMm: number;
  cellWidthMm: number;
  cellHeightMm: number;
  portraitPagesPerSide: number;
  rotatedPagesPerSide: number;
  usedAreaMm2: number;
  totalStockAreaMm2: number;
  utilizationPct: number;
}

export interface SignaturePlanInput {
  documentPages: number;
  pagesPerSide: number;
  duplex: boolean;
  signatureSizePages?: number;
  mode?: SignaturePlanMode;
}

export interface SignaturePlanResult {
  documentPages: number;
  pagesPerSide: number;
  pagesPerSheet: number;
  signatureSizePages: number;
  mode: SignaturePlanMode;
  fullSignatures: number;
  shortSignaturePages: number;
  allocatedPages: number;
  paddingBlankPages: number;
  sheetsPerCopy: number;
  boundLeavesPerCopy: number;
}

export interface PaperSectionCostSummary {
  baseSheets: number;
  makeReadySheets: number;
  runningWasteSheets: number;
  totalSheets: number;
  printedSideImpressions: number;
  sheetWeightKg: number | null;
  totalWeightKg: number | null;
  costPerSheet: number;
  totalPaperCost: number;
  availableSheets: number | null;
  stockSufficient: boolean | null;
}

export interface BookTextSectionInput {
  stock: PaperStockSpec;
  pages: number;
  copies: number;
  trimWidthMm: number;
  trimHeightMm: number;
  duplex: boolean;
  bleedMm?: number;
  gutterXMm?: number;
  gutterYMm?: number;
  marginsMm?: Partial<PaperMarginsMm>;
  gripperEdge?: SheetEdge;
  gripperMarginMm?: number;
  machine?: PaperMachineConstraints;
  allowRotation?: boolean;
  forcedOrientation?: ImpositionOrientation;
  signatureSizePages?: number;
  signaturePlan?: SignaturePlanMode;
  makeReadySheets?: number;
  runningWastePct?: number;
  allowInsufficientStockPreview?: boolean;
}

export interface BookInsertSectionInput {
  name: string;
  stock: PaperStockSpec;
  pages: number;
  trimWidthMm: number;
  trimHeightMm: number;
  duplex: boolean;
  bleedMm?: number;
  gutterXMm?: number;
  gutterYMm?: number;
  marginsMm?: Partial<PaperMarginsMm>;
  gripperEdge?: SheetEdge;
  gripperMarginMm?: number;
  machine?: PaperMachineConstraints;
  allowRotation?: boolean;
  forcedOrientation?: ImpositionOrientation;
  makeReadySheets?: number;
  runningWastePct?: number;
  includedInSpine?: boolean;
}

export interface BookCoverSectionInput {
  stock: PaperStockSpec;
  bleedMm?: number;
  hingeMm?: number;
  flapMm?: number;
  wrapMm?: number;
  boardAllowanceMm?: number;
  marginsMm?: Partial<PaperMarginsMm>;
  gripperEdge?: SheetEdge;
  gripperMarginMm?: number;
  machine?: PaperMachineConstraints;
  allowRotation?: boolean;
  forcedOrientation?: ImpositionOrientation;
  printedSides?: 1 | 2;
  makeReadySheets?: number;
  runningWastePct?: number;
}

export interface FinishingMaterialLine {
  itemId?: string | number;
  name: string;
  unit: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
}

export interface BookPaperCalculationInput {
  copies: number;
  text: BookTextSectionInput;
  cover: BookCoverSectionInput;
  inserts?: BookInsertSectionInput[];
  finishingMaterials?: FinishingMaterialLine[];
  allowInsufficientStockPreview?: boolean;
  roundingMode?: RoundingMode;
}

export interface BookSectionResult {
  sectionName: string;
  imposition: ImpositionResult;
  signatures?: SignaturePlanResult;
  sheetsPerCopy: number;
  printedSideImpressionsPerCopy: number;
  quantities: PaperSectionCostSummary;
}

export interface BookPaperCalculationResult {
  copies: number;
  spineThicknessMm: number;
  flatCoverWidthMm: number;
  flatCoverHeightMm: number;
  text: BookSectionResult;
  cover: BookSectionResult;
  inserts: BookSectionResult[];
  finishingMaterials: FinishingMaterialLine[];
  finishingCostTotal: number;
  totals: {
    totalSheets: number;
    totalMakeReadySheets: number;
    totalRunningWasteSheets: number;
    totalPrintedSideImpressions: number;
    totalWeightKg: number | null;
    totalPaperCost: number;
  };
}

export type PhotocopyPlacementMode = 'simplex' | 'duplex' | 'mixed';

export interface PhotocopySegmentInput {
  label?: string;
  pages: number;
  mode: 'simplex' | 'duplex';
  nUp?: number;
}

export interface PhotocopyPaperInput {
  stock: PaperStockSpec;
  copies: number;
  mode: PhotocopyPlacementMode;
  pages?: number;
  nUp?: number;
  segments?: PhotocopySegmentInput[];
  makeReadySheets?: number;
  runningWastePct?: number;
  machine?: PaperMachineConstraints;
  trimWidthMm?: number;
  trimHeightMm?: number;
  bleedMm?: number;
  marginsMm?: Partial<PaperMarginsMm>;
  gripperEdge?: SheetEdge;
  gripperMarginMm?: number;
  allowInsufficientStockPreview?: boolean;
  roundingMode?: RoundingMode;
}

export interface PhotocopySegmentResult {
  label: string;
  pages: number;
  mode: 'simplex' | 'duplex';
  nUp: number;
  sheetsPerCopy: number;
  printedSideImpressionsPerCopy: number;
}

export interface PhotocopyPaperResult {
  copies: number;
  mode: PhotocopyPlacementMode;
  segments: PhotocopySegmentResult[];
  sheetsPerCopy: number;
  printedSideImpressionsPerCopy: number;
  quantities: PaperSectionCostSummary;
}

const SCALE6 = 1_000_000n;
const SCALE9 = 1_000_000_000n;

function parseScaled6(value: number | string): bigint {
  const str = typeof value === 'number' ? value.toFixed(6) : String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(str)) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Invalid numeric paper value: "${value}"`);
  }
  const neg = str.startsWith('-');
  const unsigned = str.replace(/^[+-]/, '');
  const [iRaw, fRaw = ''] = unsigned.split('.');
  const iPart = BigInt(iRaw || '0');
  const fPart = BigInt(fRaw.padEnd(6, '0').slice(0, 6));
  const scaled = iPart * SCALE6 + fPart;
  return neg ? -scaled : scaled;
}

function divRoundBigInt(num: bigint, den: bigint, mode: RoundingMode = 'HALF_EVEN'): bigint {
  if (den === 0n) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', 'Division by zero in paper calculation.');
  }
  const neg = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = a / b;
  const r = a % b;
  const twiceR = r * 2n;
  let res = q;
  if (twiceR > b || (twiceR === b && (mode === 'HALF_UP' || q % 2n === 1n))) {
    res += 1n;
  }
  return neg ? -res : res;
}

function toMicrometers(mm: number): bigint {
  if (!Number.isFinite(mm) || mm < 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Invalid millimeter dimension: ${mm}`);
  }
  return BigInt(Math.round(mm * 1000));
}

function roundNum(val: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

export function normalizePaperUnit(unit: string): PaperUnit {
  const u = (unit || '').trim().toLowerCase();
  if (u === 'sheet' || u === 'sheets' || u === 'sht' || u === 'shts') return 'sheet';
  if (u === 'ream' || u === 'reams' || u === 'rm') return 'ream';
  if (u === 'pack' || u === 'packs' || u === 'pkt' || u === 'pkts') return 'pack';
  if (u === 'kg' || u === 'kgs' || u === 'kilogram' || u === 'kilograms') return 'kg';
  throw new PaperCalculationError(
    'MISSING_PAPER_CONVERSION',
    `Unsupported paper unit "${unit}". Supported units are sheet, ream, pack, and kg.`,
    { unit }
  );
}

/**
 * Computes weight of a single sheet in kilograms: (widthMm * heightMm * gsm) / 1,000,000,000.
 * Returns null when physical dimensions or GSM are not supplied.
 */
export function computeSheetWeightKg(stock: PaperStockSpec): number | null {
  if (stock.kgPerSheet !== undefined && stock.kgPerSheet !== null) {
    if (!(stock.kgPerSheet > 0)) {
      throw new PaperCalculationError(
        'MISSING_PAPER_CONVERSION',
        `Invalid kgPerSheet (${stock.kgPerSheet}) on "${stock.name}".`
      );
    }
    return stock.kgPerSheet;
  }
  const w = stock.widthMm;
  const h = stock.heightMm;
  const gsm = stock.gsm;
  if (!w || w <= 0 || !h || h <= 0 || !gsm || gsm <= 0) {
    return null;
  }
  // Exact micrometer-based numerator: (w * 1000) * (h * 1000) * gsm / 1e15
  const wUm = toMicrometers(w);
  const hUm = toMicrometers(h);
  const gsmScaled = BigInt(Math.round(gsm * 1000));
  // kg * 1e9 = (wUm * hUm * gsmScaled) / 1e9 -> preserve 9 decimal digits of kg precision
  const kg9 = divRoundBigInt(wUm * hUm * gsmScaled, SCALE9, 'HALF_EVEN');
  return Number(kg9) / 1_000_000_000;
}

/**
 * Resolves exact number of sheets in 1 unit of `unit` using ONLY explicit conversion data.
 * Throws MISSING_PAPER_CONVERSION if conversion evidence is absent.
 */
export function resolveSheetsPerUnit(stock: PaperStockSpec, unitInput: string): number {
  const inputLower = (unitInput || '').trim().toLowerCase();
  const purchaseUnitLower = (stock.purchaseUnit || '').trim().toLowerCase();
  const usageUnitLower = (stock.usageUnit || 'sheet').trim().toLowerCase();
  const hasExplicitPurchaseToSheetFactor =
    stock.conversionFactor !== undefined &&
    stock.conversionFactor !== null &&
    stock.conversionFactor > 0 &&
    (usageUnitLower === 'sheet' || usageUnitLower === 'sheets' || usageUnitLower === '');

  const isStandardPaperUnit = ['sheet', 'sheets', 'sht', 'shts', 'ream', 'reams', 'rm', 'pack', 'packs', 'pkt', 'pkts', 'kg', 'kgs', 'kilogram', 'kilograms'].includes(inputLower);
  if (!isStandardPaperUnit && inputLower && inputLower === purchaseUnitLower && hasExplicitPurchaseToSheetFactor) {
    return stock.conversionFactor!;
  }

  const unit = normalizePaperUnit(unitInput);

  if (unit === 'sheet') return 1;

  if (unit === 'ream') {
    if (stock.sheetsPerReam !== undefined && stock.sheetsPerReam !== null && stock.sheetsPerReam > 0) {
      return stock.sheetsPerReam;
    }
    if (
      hasExplicitPurchaseToSheetFactor &&
      (purchaseUnitLower === 'ream' || purchaseUnitLower === 'reams')
    ) {
      return stock.conversionFactor!;
    }
    throw new PaperCalculationError(
      'MISSING_PAPER_CONVERSION',
      `Paper stock "${stock.name}" is missing an explicit sheetsPerReam conversion factor.`,
      { itemId: stock.itemId, requestedUnit: 'ream' }
    );
  }

  if (unit === 'pack') {
    if (stock.sheetsPerPack !== undefined && stock.sheetsPerPack !== null && stock.sheetsPerPack > 0) {
      return stock.sheetsPerPack;
    }
    if (
      hasExplicitPurchaseToSheetFactor &&
      (purchaseUnitLower === 'pack' || purchaseUnitLower === 'packs')
    ) {
      return stock.conversionFactor!;
    }
    throw new PaperCalculationError(
      'MISSING_PAPER_CONVERSION',
      `Paper stock "${stock.name}" is missing an explicit sheetsPerPack conversion factor.`,
      { itemId: stock.itemId, requestedUnit: 'pack' }
    );
  }

  // unit === 'kg'
  const sheetWeightKg = computeSheetWeightKg(stock);
  if (sheetWeightKg !== null && sheetWeightKg > 0) {
    return 1 / sheetWeightKg;
  }
  if (
    hasExplicitPurchaseToSheetFactor &&
    (purchaseUnitLower === 'kg' || purchaseUnitLower === 'kilogram' || purchaseUnitLower === 'kilograms')
  ) {
    return stock.conversionFactor!;
  }
  throw new PaperCalculationError(
    'MISSING_PAPER_CONVERSION',
    `Paper stock "${stock.name}" cannot convert to/from kg without valid widthMm, heightMm, and gsm (or kgPerSheet).`,
    { itemId: stock.itemId, requestedUnit: 'kg' }
  );
}

/**
 * Converts a paper quantity between sheet, ream, pack, and kg using authoritative stock specs.
 */
export function convertPaperUnits(params: {
  quantity: number;
  fromUnit: string;
  toUnit: string;
  stock: PaperStockSpec;
}): number {
  const { quantity, fromUnit, toUnit, stock } = params;
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Paper quantity must be >= 0 (received ${quantity}).`);
  }
  const fromNorm = normalizePaperUnit(fromUnit);
  const toNorm = normalizePaperUnit(toUnit);
  if (fromNorm === toNorm) return quantity;

  const sheetsPerFrom = resolveSheetsPerUnit(stock, fromNorm);
  const sheetsPerTo = resolveSheetsPerUnit(stock, toNorm);

  if (fromNorm === 'kg') {
    const kgPerSheet = 1 / sheetsPerFrom;
    const sheets = quantity / kgPerSheet;
    return toNorm === 'sheet' ? sheets : roundNum(sheets / sheetsPerTo, 9);
  }
  if (toNorm === 'kg') {
    const sheets = quantity * sheetsPerFrom;
    const kgPerSheet = 1 / sheetsPerTo;
    return roundNum(sheets * kgPerSheet, 9);
  }

  const sheets = quantity * sheetsPerFrom;
  return roundNum(sheets / sheetsPerTo, 9);
}

/**
 * Computes exact cost per sheet and total cost for N sheets from the stock's purchaseUnitCost and purchaseUnit.
 */
export function computePaperCostForSheets(params: {
  stock: PaperStockSpec;
  sheets: number;
  roundingMode?: RoundingMode;
}): { costPerSheetExact: number; totalCost: number; formattedTotalCost2: string; formattedTotalCost4: string } {
  const { stock, sheets, roundingMode = 'HALF_EVEN' } = params;
  if (!Number.isFinite(sheets) || sheets < 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Sheet count must be >= 0 (received ${sheets}).`);
  }
  const sheetsPerPurchaseUnit = resolveSheetsPerUnit(stock, stock.purchaseUnit);
  const purchaseUnitCost4 = parseDecimal4(stock.purchaseUnitCost);
  if (purchaseUnitCost4 < 0n) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Paper purchase unit cost cannot be negative.`);
  }

  const sheets6 = parseScaled6(sheets);
  const perUnitSheets6 = parseScaled6(sheetsPerPurchaseUnit);
  // totalCost4 = round((sheets6 * purchaseUnitCost4) / perUnitSheets6)
  const totalCost4 = divRoundBigInt(sheets6 * purchaseUnitCost4, perUnitSheets6, roundingMode);
  const costPerSheetNum = Number(purchaseUnitCost4) / 10000 / sheetsPerPurchaseUnit;

  return {
    costPerSheetExact: roundNum(costPerSheetNum, 8),
    totalCost: toMoneyNumber(totalCost4, roundingMode),
    formattedTotalCost2: formatDecimal2(totalCost4, roundingMode),
    formattedTotalCost4: formatDecimal4(totalCost4),
  };
}

/**
 * Validates stock activity and availability in sheets.
 */
export function assertPaperStockAvailable(
  stock: PaperStockSpec,
  requiredSheets: number,
  options?: { allowInsufficientStockPreview?: boolean }
): { availableSheets: number | null; stockSufficient: boolean | null } {
  if (stock.isActive === false) {
    throw new PaperCalculationError(
      'UNAVAILABLE_STOCK',
      `Paper stock "${stock.name}" is inactive and unavailable for production.`,
      { itemId: stock.itemId }
    );
  }
  if (stock.isRawMaterial === false) {
    throw new PaperCalculationError(
      'UNAVAILABLE_STOCK',
      `Inventory item "${stock.name}" is not a raw_material item.`,
      { itemId: stock.itemId }
    );
  }
  if (stock.onHandPurchaseUnits === undefined || stock.onHandPurchaseUnits === null) {
    return { availableSheets: null, stockSufficient: null };
  }
  const onHandNum = Number(stock.onHandPurchaseUnits);
  if (!Number.isFinite(onHandNum) || onHandNum < 0) {
    throw new PaperCalculationError('UNAVAILABLE_STOCK', `Invalid stock balance on "${stock.name}".`);
  }
  const sheetsPerPurchaseUnit = resolveSheetsPerUnit(stock, stock.purchaseUnit);
  const availableSheets = roundNum(onHandNum * sheetsPerPurchaseUnit, 6);
  const stockSufficient = availableSheets + 1e-6 >= requiredSheets;

  if (!stockSufficient && !options?.allowInsufficientStockPreview) {
    throw new PaperCalculationError(
      'UNAVAILABLE_STOCK',
      `Insufficient paper stock for "${stock.name}": required ${requiredSheets} sheets, available ${availableSheets} sheets.`,
      { itemId: stock.itemId, requiredSheets, availableSheets }
    );
  }

  return { availableSheets, stockSufficient };
}

/**
 * Computes usable printable sheet area after subtracting edge margins, gripper margin, and checking machine max dimensions.
 */
export function computeUsableArea(input: UsableAreaInput): UsableAreaResult {
  const { stockWidthMm, stockHeightMm, marginsMm, gripperEdge = 'top', gripperMarginMm = 0 } = input;
  if (!Number.isFinite(stockWidthMm) || stockWidthMm <= 0 || !Number.isFinite(stockHeightMm) || stockHeightMm <= 0) {
    throw new PaperCalculationError(
      'INVALID_PAPER_SPEC',
      `Stock dimensions must be positive (got ${stockWidthMm}mm × ${stockHeightMm}mm).`
    );
  }

  if (input.machineMaxWidthMm && input.machineMaxHeightMm) {
    const fitsNormal =
      stockWidthMm <= input.machineMaxWidthMm + 1e-6 &&
      stockHeightMm <= input.machineMaxHeightMm + 1e-6;
    const fitsRotated =
      stockHeightMm <= input.machineMaxWidthMm + 1e-6 &&
      stockWidthMm <= input.machineMaxHeightMm + 1e-6;
    if (!fitsNormal && !fitsRotated) {
      throw new PaperCalculationError(
        'INFEASIBLE_LAYOUT',
        `Stock sheet (${stockWidthMm}×${stockHeightMm}mm) exceeds machine maximum sheet size (${input.machineMaxWidthMm}×${input.machineMaxHeightMm}mm).`,
        { stockWidthMm, stockHeightMm, maxWidthMm: input.machineMaxWidthMm, maxHeightMm: input.machineMaxHeightMm }
      );
    }
  }

  if (!Number.isFinite(gripperMarginMm) || gripperMarginMm < 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Gripper margin cannot be negative.`);
  }

  const baseTop = marginsMm?.top ?? 0;
  const baseBottom = marginsMm?.bottom ?? 0;
  const baseLeft = marginsMm?.left ?? 0;
  const baseRight = marginsMm?.right ?? 0;

  if (baseTop < 0 || baseBottom < 0 || baseLeft < 0 || baseRight < 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Sheet margins cannot be negative.`);
  }

  const effectiveMarginsMm: PaperMarginsMm = {
    top: gripperEdge === 'top' ? Math.max(baseTop, gripperMarginMm) : baseTop,
    bottom: gripperEdge === 'bottom' ? Math.max(baseBottom, gripperMarginMm) : baseBottom,
    left: gripperEdge === 'left' ? Math.max(baseLeft, gripperMarginMm) : baseLeft,
    right: gripperEdge === 'right' ? Math.max(baseRight, gripperMarginMm) : baseRight,
  };

  const usableWUm =
    toMicrometers(stockWidthMm) -
    toMicrometers(effectiveMarginsMm.left) -
    toMicrometers(effectiveMarginsMm.right);
  const usableHUm =
    toMicrometers(stockHeightMm) -
    toMicrometers(effectiveMarginsMm.top) -
    toMicrometers(effectiveMarginsMm.bottom);

  if (usableWUm <= 0n || usableHUm <= 0n) {
    throw new PaperCalculationError(
      'INFEASIBLE_LAYOUT',
      `Margins and gripper leave zero or negative printable area on ${stockWidthMm}×${stockHeightMm}mm sheet.`,
      { stockWidthMm, stockHeightMm, effectiveMarginsMm }
    );
  }

  return {
    stockWidthMm,
    stockHeightMm,
    effectiveMarginsMm,
    usableWidthMm: Number(usableWUm) / 1000,
    usableHeightMm: Number(usableHUm) / 1000,
  };
}

function fitCountInDimension(usableUm: bigint, cellUm: bigint, gutterUm: bigint): number {
  if (cellUm <= 0n || usableUm < cellUm) return 0;
  return Number((usableUm + gutterUm) / (cellUm + gutterUm));
}

/**
 * Solves exact 2D press imposition (normal vs 90° rotated) respecting bleed, gutters, gripper, and margins.
 */
export function computeImposition(input: ImpositionInput): ImpositionResult {
  const {
    trimWidthMm,
    trimHeightMm,
    bleedMm = 0,
    gutterXMm = 0,
    gutterYMm = 0,
    allowRotation = true,
    forcedOrientation,
  } = input;

  if (trimWidthMm <= 0 || trimHeightMm <= 0) {
    throw new PaperCalculationError(
      'INVALID_PAPER_SPEC',
      `Trim dimensions must be positive (got ${trimWidthMm}×${trimHeightMm}mm).`
    );
  }
  if (bleedMm < 0 || gutterXMm < 0 || gutterYMm < 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Bleed and gutter dimensions cannot be negative.`);
  }

  const usable = computeUsableArea(input);
  const usableWUm = toMicrometers(usable.usableWidthMm);
  const usableHUm = toMicrometers(usable.usableHeightMm);

  const cellWUm = toMicrometers(trimWidthMm) + 2n * toMicrometers(bleedMm);
  const cellHUm = toMicrometers(trimHeightMm) + 2n * toMicrometers(bleedMm);
  const gutterXUm = toMicrometers(gutterXMm);
  const gutterYUm = toMicrometers(gutterYMm);

  const colsNormal = fitCountInDimension(usableWUm, cellWUm, gutterXUm);
  const rowsNormal = fitCountInDimension(usableHUm, cellHUm, gutterYUm);
  const portraitPagesPerSide = colsNormal * rowsNormal;

  const colsRotated = fitCountInDimension(usableWUm, cellHUm, gutterXUm);
  const rowsRotated = fitCountInDimension(usableHUm, cellWUm, gutterYUm);
  const rotatedPagesPerSide = colsRotated * rowsRotated;

  let chosenOrientation: ImpositionOrientation;
  let columns: number;
  let rows: number;
  let pagesPerSide: number;

  if (forcedOrientation === 'normal' || (!allowRotation && forcedOrientation !== 'rotated')) {
    chosenOrientation = 'normal';
    columns = colsNormal;
    rows = rowsNormal;
    pagesPerSide = portraitPagesPerSide;
  } else if (forcedOrientation === 'rotated') {
    chosenOrientation = 'rotated';
    columns = colsRotated;
    rows = rowsRotated;
    pagesPerSide = rotatedPagesPerSide;
  } else {
    if (rotatedPagesPerSide > portraitPagesPerSide) {
      chosenOrientation = 'rotated';
      columns = colsRotated;
      rows = rowsRotated;
      pagesPerSide = rotatedPagesPerSide;
    } else {
      chosenOrientation = 'normal';
      columns = colsNormal;
      rows = rowsNormal;
      pagesPerSide = portraitPagesPerSide;
    }
  }

  if (pagesPerSide <= 0) {
    throw new PaperCalculationError(
      'INFEASIBLE_LAYOUT',
      `Finished size ${trimWidthMm}×${trimHeightMm}mm (with ${bleedMm}mm bleed) does not fit inside usable sheet area ${usable.usableWidthMm}×${usable.usableHeightMm}mm.`,
      {
        trimWidthMm,
        trimHeightMm,
        bleedMm,
        usableWidthMm: usable.usableWidthMm,
        usableHeightMm: usable.usableHeightMm,
      }
    );
  }

  const cellWidthMm = Number(cellWUm) / 1000;
  const cellHeightMm = Number(cellHUm) / 1000;
  const usedAreaMm2 = roundNum(pagesPerSide * cellWidthMm * cellHeightMm, 4);
  const totalStockAreaMm2 = roundNum(usable.stockWidthMm * usable.stockHeightMm, 4);
  const utilizationPct = roundNum((usedAreaMm2 / totalStockAreaMm2) * 100, 2);

  return {
    orientation: chosenOrientation,
    columns,
    rows,
    pagesPerSide,
    usableWidthMm: usable.usableWidthMm,
    usableHeightMm: usable.usableHeightMm,
    cellWidthMm,
    cellHeightMm,
    portraitPagesPerSide,
    rotatedPagesPerSide,
    usedAreaMm2,
    totalStockAreaMm2,
    utilizationPct,
  };
}

/**
 * Computes book signatures and physical sheets per copy for padded vs short-signature plans.
 */
export function computeSignaturePlan(input: SignaturePlanInput): SignaturePlanResult {
  const { documentPages, pagesPerSide, duplex, mode = 'padded' } = input;
  if (!Number.isInteger(documentPages) || documentPages <= 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `documentPages must be a positive integer.`);
  }
  if (!Number.isInteger(pagesPerSide) || pagesPerSide <= 0) {
    throw new PaperCalculationError('INFEASIBLE_LAYOUT', `pagesPerSide must be a positive integer.`);
  }

  const pagesPerSheet = duplex ? pagesPerSide * 2 : pagesPerSide;
  const signatureSizePages = input.signatureSizePages ?? pagesPerSheet;

  if (!Number.isInteger(signatureSizePages) || signatureSizePages <= 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `signatureSizePages must be a positive integer.`);
  }
  if (signatureSizePages % pagesPerSheet !== 0) {
    throw new PaperCalculationError(
      'INFEASIBLE_LAYOUT',
      `Signature size (${signatureSizePages} pages) must be a multiple of pages per press sheet (${pagesPerSheet}).`,
      { signatureSizePages, pagesPerSheet }
    );
  }

  if (mode === 'padded') {
    const fullSignatures = Math.ceil(documentPages / signatureSizePages);
    const allocatedPages = fullSignatures * signatureSizePages;
    const paddingBlankPages = allocatedPages - documentPages;
    const sheetsPerCopy = allocatedPages / pagesPerSheet;
    const boundLeavesPerCopy = duplex ? allocatedPages / 2 : allocatedPages;
    return {
      documentPages,
      pagesPerSide,
      pagesPerSheet,
      signatureSizePages,
      mode,
      fullSignatures,
      shortSignaturePages: 0,
      allocatedPages,
      paddingBlankPages,
      sheetsPerCopy,
      boundLeavesPerCopy,
    };
  }

  // mode === 'short_signature'
  const fullSignatures = Math.floor(documentPages / signatureSizePages);
  const remainderPages = documentPages % signatureSizePages;
  const shortSignatureSheets = remainderPages > 0 ? Math.ceil(remainderPages / pagesPerSheet) : 0;
  const shortSignaturePages = shortSignatureSheets * pagesPerSheet;
  const allocatedPages = fullSignatures * signatureSizePages + shortSignaturePages;
  const paddingBlankPages = allocatedPages - documentPages;
  const sheetsPerCopy = allocatedPages / pagesPerSheet;
  const boundLeavesPerCopy = duplex ? allocatedPages / 2 : allocatedPages;

  return {
    documentPages,
    pagesPerSide,
    pagesPerSheet,
    signatureSizePages,
    mode,
    fullSignatures,
    shortSignaturePages,
    allocatedPages,
    paddingBlankPages,
    sheetsPerCopy,
    boundLeavesPerCopy,
  };
}

function resolveMeasuredCaliper(stock: PaperStockSpec, sectionLabel: string): number {
  if (stock.measuredCaliperMm === undefined || stock.measuredCaliperMm === null || !(stock.measuredCaliperMm > 0)) {
    throw new PaperCalculationError(
      'MISSING_MEASURED_CALIPER',
      `Measured paper caliper (mm) is required on ${sectionLabel} stock "${stock.name}" to calculate book spine thickness.`,
      { itemId: stock.itemId, sectionLabel }
    );
  }
  return stock.measuredCaliperMm;
}

function buildSectionQuantities(params: {
  stock: PaperStockSpec;
  baseSheets: number;
  makeReadySheets: number;
  runningWastePct: number;
  printedSideImpressions: number;
  allowInsufficientStockPreview?: boolean;
  roundingMode?: RoundingMode;
}): PaperSectionCostSummary {
  const {
    stock,
    baseSheets,
    makeReadySheets,
    runningWastePct,
    printedSideImpressions,
    allowInsufficientStockPreview,
    roundingMode = 'HALF_EVEN',
  } = params;

  if (!Number.isInteger(makeReadySheets) || makeReadySheets < 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `makeReadySheets must be a non-negative integer.`);
  }
  if (!Number.isFinite(runningWastePct) || runningWastePct < 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `runningWastePct must be >= 0.`);
  }

  const runningWasteSheets = Math.ceil(baseSheets * (runningWastePct / 100));
  const totalSheets = baseSheets + makeReadySheets + runningWasteSheets;

  const stockStatus = assertPaperStockAvailable(stock, totalSheets, { allowInsufficientStockPreview });
  const sheetWeightKg = computeSheetWeightKg(stock);
  const totalWeightKg = sheetWeightKg !== null ? roundNum(totalSheets * sheetWeightKg, 6) : null;
  const cost = computePaperCostForSheets({ stock, sheets: totalSheets, roundingMode });

  return {
    baseSheets,
    makeReadySheets,
    runningWasteSheets,
    totalSheets,
    printedSideImpressions,
    sheetWeightKg: sheetWeightKg !== null ? roundNum(sheetWeightKg, 9) : null,
    totalWeightKg,
    costPerSheet: cost.costPerSheetExact,
    totalPaperCost: cost.totalCost,
    availableSheets: stockStatus.availableSheets,
    stockSufficient: stockStatus.stockSufficient,
  };
}

/**
 * Full authoritative book paper calculator:
 * - Separate text, cover, and optional insert stocks
 * - Measured caliper spine thickness (never guessed)
 * - Signature plan (padded vs short_signature)
 * - Flat cover geometry & imposition feasibility check
 * - Separate make-ready, running waste, weight, cost, and finishing material passthrough
 */
export function calculateBookPaper(input: BookPaperCalculationInput): BookPaperCalculationResult {
  const { copies, text, cover, inserts = [], finishingMaterials = [], allowInsufficientStockPreview, roundingMode = 'HALF_EVEN' } = input;

  if (!Number.isInteger(copies) || copies <= 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Book copy count must be a positive integer.`);
  }
  if (!text.stock.widthMm || !text.stock.heightMm) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Text stock "${text.stock.name}" requires widthMm and heightMm.`);
  }
  if (!cover.stock.widthMm || !cover.stock.heightMm) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Cover stock "${cover.stock.name}" requires widthMm and heightMm.`);
  }

  // 1. Text imposition & signature plan
  const textImposition = computeImposition({
    stockWidthMm: text.stock.widthMm,
    stockHeightMm: text.stock.heightMm,
    marginsMm: text.marginsMm ?? text.machine?.defaultMarginsMm,
    gripperEdge: text.gripperEdge ?? text.machine?.gripperEdge,
    gripperMarginMm: text.gripperMarginMm ?? text.machine?.gripperMarginMm ?? 0,
    machineMaxWidthMm: text.machine?.maxSheetWidthMm,
    machineMaxHeightMm: text.machine?.maxSheetHeightMm,
    trimWidthMm: text.trimWidthMm,
    trimHeightMm: text.trimHeightMm,
    bleedMm: text.bleedMm ?? 0,
    gutterXMm: text.gutterXMm ?? 0,
    gutterYMm: text.gutterYMm ?? 0,
    allowRotation: text.allowRotation ?? true,
    forcedOrientation: text.forcedOrientation,
  });

  const textSignatures = computeSignaturePlan({
    documentPages: text.pages,
    pagesPerSide: textImposition.pagesPerSide,
    duplex: text.duplex,
    signatureSizePages: text.signatureSizePages,
    mode: text.signaturePlan ?? 'padded',
  });

  // Physical printed sides on text: count only sheets/sides carrying actual book pages (unpadded document sides),
  // wait: in booklet/signature printing, blank trailing pages do NOT carry ink/toner, while printed press sides carry document pages.
  // Actually, physical press sheet sides carrying at least 1 document page = ceil(documentPages / pagesPerSide) * copies!
  const textPrintedSidesPerCopy = Math.ceil(text.pages / textImposition.pagesPerSide);
  const textQuantities = buildSectionQuantities({
    stock: text.stock,
    baseSheets: copies * textSignatures.sheetsPerCopy,
    makeReadySheets: text.makeReadySheets ?? 0,
    runningWastePct: text.runningWastePct ?? 0,
    printedSideImpressions: copies * textPrintedSidesPerCopy,
    allowInsufficientStockPreview,
    roundingMode,
  });

  // 2. Inserts imposition & spine contribution
  let insertsSpineMm = 0;
  const insertResults: BookSectionResult[] = [];
  for (const ins of inserts) {
    if (!ins.stock.widthMm || !ins.stock.heightMm) {
      throw new PaperCalculationError('INVALID_PAPER_SPEC', `Insert stock "${ins.stock.name}" requires widthMm and heightMm.`);
    }
    const insImposition = computeImposition({
      stockWidthMm: ins.stock.widthMm,
      stockHeightMm: ins.stock.heightMm,
      marginsMm: ins.marginsMm ?? ins.machine?.defaultMarginsMm,
      gripperEdge: ins.gripperEdge ?? ins.machine?.gripperEdge,
      gripperMarginMm: ins.gripperMarginMm ?? ins.machine?.gripperMarginMm ?? 0,
      machineMaxWidthMm: ins.machine?.maxSheetWidthMm,
      machineMaxHeightMm: ins.machine?.maxSheetHeightMm,
      trimWidthMm: ins.trimWidthMm,
      trimHeightMm: ins.trimHeightMm,
      bleedMm: ins.bleedMm ?? 0,
      gutterXMm: ins.gutterXMm ?? 0,
      gutterYMm: ins.gutterYMm ?? 0,
      allowRotation: ins.allowRotation ?? true,
      forcedOrientation: ins.forcedOrientation,
    });

    const insertBoundLeaves = ins.duplex ? Math.ceil(ins.pages / 2) : ins.pages;
    if (ins.includedInSpine !== false) {
      const insCaliper = resolveMeasuredCaliper(ins.stock, `insert "${ins.name}"`);
      insertsSpineMm += insertBoundLeaves * insCaliper;
    }

    const insSheetsPerCopy = insertBoundLeaves / insImposition.pagesPerSide;
    const insBaseSheets = Math.ceil(copies * insSheetsPerCopy);
    const insPrintedSideImpressions = Math.ceil((copies * ins.pages) / insImposition.pagesPerSide);
    const insQuantities = buildSectionQuantities({
      stock: ins.stock,
      baseSheets: insBaseSheets,
      makeReadySheets: ins.makeReadySheets ?? 0,
      runningWastePct: ins.runningWastePct ?? 0,
      printedSideImpressions: insPrintedSideImpressions,
      allowInsufficientStockPreview,
      roundingMode,
    });

    insertResults.push({
      sectionName: ins.name,
      imposition: insImposition,
      sheetsPerCopy: insSheetsPerCopy,
      printedSideImpressionsPerCopy: ins.pages / insImposition.pagesPerSide,
      quantities: insQuantities,
    });
  }

  // 3. Spine thickness from measured caliper (strict — never guessed!)
  const textCaliperMm = resolveMeasuredCaliper(text.stock, 'book text');
  const boardAllowanceMm = cover.boardAllowanceMm ?? 0;
  if (boardAllowanceMm < 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `Cover boardAllowanceMm cannot be negative.`);
  }
  const spineThicknessMm = roundNum(
    textSignatures.boundLeavesPerCopy * textCaliperMm + insertsSpineMm + boardAllowanceMm,
    4
  );

  // 4. Flat open cover dimensions & imposition feasibility check
  const hingeMm = cover.hingeMm ?? 0;
  const flapMm = cover.flapMm ?? 0;
  const wrapMm = cover.wrapMm ?? 0;
  const flatCoverWidthMm = roundNum(text.trimWidthMm * 2 + spineThicknessMm + 2 * hingeMm + 2 * flapMm, 4);
  const flatCoverHeightMm = roundNum(text.trimHeightMm + 2 * wrapMm, 4);

  const coverImposition = computeImposition({
    stockWidthMm: cover.stock.widthMm,
    stockHeightMm: cover.stock.heightMm,
    marginsMm: cover.marginsMm ?? cover.machine?.defaultMarginsMm,
    gripperEdge: cover.gripperEdge ?? cover.machine?.gripperEdge,
    gripperMarginMm: cover.gripperMarginMm ?? cover.machine?.gripperMarginMm ?? 0,
    machineMaxWidthMm: cover.machine?.maxSheetWidthMm,
    machineMaxHeightMm: cover.machine?.maxSheetHeightMm,
    trimWidthMm: flatCoverWidthMm,
    trimHeightMm: flatCoverHeightMm,
    bleedMm: cover.bleedMm ?? 0,
    allowRotation: cover.allowRotation ?? true,
    forcedOrientation: cover.forcedOrientation,
  });

  // Cover sheets: 1 cover unit per copy divided across cover pagesPerSide (normally 1-up or 2-up)
  const coverSheetsPerCopy = 1 / coverImposition.pagesPerSide;
  const coverBaseSheets = Math.ceil(copies * coverSheetsPerCopy);
  const coverPrintedSidesCount = cover.printedSides ?? 1;
  const coverPrintedSideImpressions = Math.ceil((copies * coverPrintedSidesCount) / coverImposition.pagesPerSide);

  const coverQuantities = buildSectionQuantities({
    stock: cover.stock,
    baseSheets: coverBaseSheets,
    makeReadySheets: cover.makeReadySheets ?? 0,
    runningWastePct: cover.runningWastePct ?? 0,
    printedSideImpressions: coverPrintedSideImpressions,
    allowInsufficientStockPreview,
    roundingMode,
  });

  const finishingCostTotal = roundNum(
    finishingMaterials.reduce((s, f) => s + f.totalCost, 0),
    2
  );

  const allSections = [textQuantities, coverQuantities, ...insertResults.map(i => i.quantities)];
  const allWeightsKnown = allSections.every(s => s.totalWeightKg !== null);
  const totalWeightKg = allWeightsKnown
    ? roundNum(allSections.reduce((s, q) => s + (q.totalWeightKg || 0), 0), 6)
    : null;

  return {
    copies,
    spineThicknessMm,
    flatCoverWidthMm,
    flatCoverHeightMm,
    text: {
      sectionName: 'Text Block',
      imposition: textImposition,
      signatures: textSignatures,
      sheetsPerCopy: textSignatures.sheetsPerCopy,
      printedSideImpressionsPerCopy: textPrintedSidesPerCopy,
      quantities: textQuantities,
    },
    cover: {
      sectionName: 'Cover',
      imposition: coverImposition,
      sheetsPerCopy: coverSheetsPerCopy,
      printedSideImpressionsPerCopy: coverPrintedSidesCount / coverImposition.pagesPerSide,
      quantities: coverQuantities,
    },
    inserts: insertResults,
    finishingMaterials,
    finishingCostTotal,
    totals: {
      totalSheets: allSections.reduce((s, q) => s + q.totalSheets, 0),
      totalMakeReadySheets: allSections.reduce((s, q) => s + q.makeReadySheets, 0),
      totalRunningWasteSheets: allSections.reduce((s, q) => s + q.runningWasteSheets, 0),
      totalPrintedSideImpressions: allSections.reduce((s, q) => s + q.printedSideImpressions, 0),
      totalWeightKg,
      totalPaperCost: roundNum(allSections.reduce((s, q) => s + q.totalPaperCost, 0), 2),
    },
  };
}

/**
 * Authoritative Photocopy / Sheet Placement Calculator:
 * Supports simplex, duplex, and mixed segments (with exact odd-page duplex sheet vs printed-side impression accounting).
 */
export function calculatePhotocopyPaper(input: PhotocopyPaperInput): PhotocopyPaperResult {
  const {
    stock,
    copies,
    mode,
    pages,
    nUp = 1,
    segments,
    makeReadySheets = 0,
    runningWastePct = 0,
    machine,
    trimWidthMm,
    trimHeightMm,
    bleedMm = 0,
    marginsMm,
    gripperEdge,
    gripperMarginMm = 0,
    allowInsufficientStockPreview,
    roundingMode = 'HALF_EVEN',
  } = input;

  if (!Number.isInteger(copies) || copies <= 0) {
    throw new PaperCalculationError('INVALID_PAPER_SPEC', `copies must be a positive integer.`);
  }
  if (machine && machine.supportsDuplex === false && (mode === 'duplex' || (segments && segments.some(s => s.mode === 'duplex')))) {
    throw new PaperCalculationError(
      'INFEASIBLE_LAYOUT',
      `Machine "${machine.machineName || 'Press'}" does not support duplex placement.`
    );
  }
  if (trimWidthMm && trimHeightMm && stock.widthMm && stock.heightMm) {
    computeImposition({
      stockWidthMm: stock.widthMm,
      stockHeightMm: stock.heightMm,
      marginsMm: marginsMm ?? machine?.defaultMarginsMm,
      gripperEdge: gripperEdge ?? machine?.gripperEdge,
      gripperMarginMm: gripperMarginMm || machine?.gripperMarginMm || 0,
      machineMaxWidthMm: machine?.maxSheetWidthMm,
      machineMaxHeightMm: machine?.maxSheetHeightMm,
      trimWidthMm,
      trimHeightMm,
      bleedMm,
    });
  }

  let effectiveSegments: PhotocopySegmentInput[];
  if (mode === 'mixed') {
    if (!segments || segments.length === 0) {
      throw new PaperCalculationError(
        'INVALID_PAPER_SPEC',
        `Mixed simplex/duplex photocopy mode requires non-empty segments.`
      );
    }
    effectiveSegments = segments;
  } else {
    if (segments && segments.length > 0) {
      effectiveSegments = segments;
    } else {
      if (!pages || !Number.isInteger(pages) || pages <= 0) {
        throw new PaperCalculationError('INVALID_PAPER_SPEC', `pages must be a positive integer.`);
      }
      effectiveSegments = [{ label: mode === 'duplex' ? 'Duplex Body' : 'Simplex Body', pages, mode, nUp }];
    }
  }

  const segmentResults: PhotocopySegmentResult[] = effectiveSegments.map((seg, idx) => {
    const segNUp = seg.nUp ?? nUp ?? 1;
    if (!Number.isInteger(seg.pages) || seg.pages <= 0) {
      throw new PaperCalculationError('INVALID_PAPER_SPEC', `Segment pages must be a positive integer.`);
    }
    if (!Number.isInteger(segNUp) || segNUp <= 0) {
      throw new PaperCalculationError('INVALID_PAPER_SPEC', `Segment nUp must be a positive integer.`);
    }
    const printedSides = Math.ceil(seg.pages / segNUp);
    const sheetsPerCopy = seg.mode === 'duplex' ? Math.ceil(printedSides / 2) : printedSides;
    return {
      label: seg.label || `Segment ${idx + 1}`,
      pages: seg.pages,
      mode: seg.mode,
      nUp: segNUp,
      sheetsPerCopy,
      printedSideImpressionsPerCopy: printedSides,
    };
  });

  const sheetsPerCopy = segmentResults.reduce((s, r) => s + r.sheetsPerCopy, 0);
  const printedSideImpressionsPerCopy = segmentResults.reduce(
    (s, r) => s + r.printedSideImpressionsPerCopy,
    0
  );

  const quantities = buildSectionQuantities({
    stock,
    baseSheets: copies * sheetsPerCopy,
    makeReadySheets,
    runningWastePct,
    printedSideImpressions: copies * printedSideImpressionsPerCopy,
    allowInsufficientStockPreview,
    roundingMode,
  });

  return {
    copies,
    mode,
    segments: segmentResults,
    sheetsPerCopy,
    printedSideImpressionsPerCopy,
    quantities,
  };
}

/**
 * Authoritative database lookup for paper stock via inventory_items + paper_specifications.
 * Does NOT invent missing conversion, caliper, or dimension fields.
 */
export async function lookupPaperStockFromDb(
  tx: Transaction,
  companyId: number,
  inventoryItemId: number
): Promise<PaperStockSpec> {
  const res = await tx.query<{
    item_id: number;
    sku: string;
    name: string;
    item_type: string;
    is_active: boolean;
    unit_cost: string;
    on_hand: string;
    purchase_unit: string;
    usage_unit: string;
    conversion_factor: string;
    paper_spec_id: number | null;
    width_mm: string | null;
    height_mm: string | null;
    gsm: number | null;
    grain_direction: 'long' | 'short' | null;
    sheets_per_ream: number | null;
    measured_caliper_mm: string | null;
    sheets_per_pack: string | null;
  }>(
    `SELECT ii.id AS item_id,
            ii.sku,
            ii.name,
            ii.item_type,
            ii.is_active,
            ii.unit_cost::text,
            ii.on_hand::text,
            ii.purchase_unit,
            ii.usage_unit,
            ii.conversion_factor::text,
            ii.paper_spec_id,
            ps.width_mm::text,
            ps.height_mm::text,
            ps.gsm,
            ps.grain_direction,
            ps.sheets_per_ream,
            ps.measured_caliper_mm::text,
            ps.sheets_per_pack::text
       FROM inventory_items ii
       LEFT JOIN paper_specifications ps
         ON ps.company_id = ii.company_id AND ps.id = ii.paper_spec_id AND ps.is_active = TRUE
      WHERE ii.company_id = $1 AND ii.id = $2
      LIMIT 1`,
    [companyId, inventoryItemId]
  );

  if (res.rows.length === 0) {
    throw new PaperCalculationError(
      'PAPER_STOCK_NOT_FOUND',
      `Paper inventory item ${inventoryItemId} not found for company ${companyId}.`
    );
  }

  const row = res.rows[0];
  return {
    itemId: Number(row.item_id),
    paperSpecId: row.paper_spec_id !== null ? Number(row.paper_spec_id) : null,
    sku: row.sku,
    name: row.name,
    isActive: row.is_active,
    isRawMaterial: row.item_type === 'raw_material',
    widthMm: row.width_mm !== null ? Number(row.width_mm) : null,
    heightMm: row.height_mm !== null ? Number(row.height_mm) : null,
    gsm: row.gsm !== null ? Number(row.gsm) : null,
    measuredCaliperMm: row.measured_caliper_mm !== null ? Number(row.measured_caliper_mm) : null,
    grainDirection: row.grain_direction,
    purchaseUnit: row.purchase_unit,
    usageUnit: row.usage_unit,
    conversionFactor: Number(row.conversion_factor),
    sheetsPerReam: row.sheets_per_ream !== null ? Number(row.sheets_per_ream) : null,
    sheetsPerPack: row.sheets_per_pack !== null ? Number(row.sheets_per_pack) : null,
    kgPerSheet: null,
    purchaseUnitCost: row.unit_cost,
    onHandPurchaseUnits: row.on_hand,
  };
}
