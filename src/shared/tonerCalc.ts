import type { Transaction } from '@electric-sql/pglite';
import { formatDecimal2, RoundingMode, toMoneyNumber } from './decimal.ts';

export type TonerChannel = 'K' | 'C' | 'M' | 'Y';
export type TonerColorMode = 'mono' | 'colour';
export type TonerCalculationMethod = 'calibrated' | 'rated_yield' | 'coverage_based' | 'auto';
export type EvidenceAvailability = 'available' | 'provisional' | 'unavailable';

export type TonerErrorCode =
  | 'UNSUPPORTED_MACHINE_PROCESS'
  | 'COLOUR_MODE_NOT_SUPPORTED'
  | 'INVALID_TONER_SPEC'
  | 'INVALID_METER_READING'
  | 'MISSING_TONER_CHANNEL'
  | 'MACHINE_NOT_FOUND'
  | 'TONER_STOCK_NOT_FOUND';

export class TonerCalculationError extends Error {
  public readonly code: TonerErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: TonerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TonerCalculationError';
    this.code = code;
    this.details = details;
  }
}

export const TONER_SUPPORTED_PROCESS_TYPES = [
  'digital_press',
  'photocopier',
  'laser_printer',
  'toner',
] as const;

export interface TonerMachineSpec {
  machineId: string | number;
  name: string;
  processType: string;
  supportsColour: boolean;
  supportsDuplex?: boolean;
  status?: string;
}

export interface TonerCalibrationEvidence {
  evidenceStatus: 'verified' | 'unverified';
  calibratedGramsPerImpression?: number | null;
  measuredSampleGrams?: number | null;
  measuredSampleImpressions?: number | null;
  notes?: string;
}

export interface TonerCoverageEvidence {
  evidenceStatus: 'validated' | 'unvalidated' | 'estimated';
  coveragePct: number;
  notes?: string;
}

export interface TonerChannelSpec {
  itemId: string | number;
  sku?: string;
  name: string;
  channel: TonerChannel;
  isActive?: boolean;
  cartridgeCost?: number | string | null;
  cartridgeTonerMassGrams?: number | null;
  ratedYieldImpressions?: number | null;
  ratedCoveragePct?: number | null;
  calibration?: TonerCalibrationEvidence | null;
}

export interface TonerImpressionInput {
  /** Exact physical printed-side impressions per channel (preferred when mono/colour pages differ) */
  byChannel?: Partial<Record<TonerChannel, number>>;
  /** Physical printed sides carrying toner (used when applying uniform mono or 4-colour coverage) */
  printedSideImpressions?: number;
  /** Optional make-ready/spoilage printed sides (counted separately and never conflated with blank backs) */
  makeReadyPrintedSides?: number;
  /** Optional photocopy segments fallback if caller passes raw segment sides */
  segments?: Array<{
    pages: number;
    copies: number;
    mode: 'simplex' | 'duplex';
    nUp?: number;
    colorMode?: TonerColorMode;
  }>;
}

export interface TonerCalculationInput {
  machine: TonerMachineSpec;
  colorMode: TonerColorMode;
  method?: TonerCalculationMethod;
  impressions: TonerImpressionInput;
  channels: Partial<Record<TonerChannel, TonerChannelSpec>>;
  coverageByChannel?: Partial<Record<TonerChannel, TonerCoverageEvidence | null>>;
  coverageUniform?: TonerCoverageEvidence | null;
  roundingMode?: RoundingMode;
}

export interface TonerChannelResult {
  channel: TonerChannel;
  itemId: string | number;
  itemName: string;
  impressions: number;
  methodUsed: 'calibrated' | 'rated_yield' | 'coverage_based' | 'unavailable';
  massGrams: number | null;
  massStatus: EvidenceAvailability;
  massReason: string;
  cost: number | null;
  costStatus: EvidenceAvailability;
  costReason: string;
}

export interface TonerCalculationResult {
  machineId: string | number;
  machineName: string;
  processType: string;
  colorMode: TonerColorMode;
  requestedMethod: TonerCalculationMethod;
  totalPrintedSideImpressions: number;
  channels: Partial<Record<TonerChannel, TonerChannelResult>>;
  totalMassGrams: number | null;
  totalMassStatus: EvidenceAvailability;
  totalCost: number | null;
  totalCostStatus: EvidenceAvailability;
  formattedTotalCost2: string | null;
  warnings: string[];
}

export interface MeterResetEvent {
  meterBeforeReset: number;
  meterAfterReset: number;
  reason?: string;
}

export interface CartridgeRunSegment {
  cartridgeId: string;
  channel: TonerChannel;
  cartridgeCost: number;
  ratedYieldImpressions: number;
  impressionsUsedOnCartridge: number;
  installedDuringRun?: boolean;
  calibratedGramsPerImpression?: number | null;
  cartridgeTonerMassGrams?: number | null;
}

export interface MachineMeterEvaluationInput {
  machine: TonerMachineSpec;
  startMeter: number;
  endMeter: number;
  resetEvent?: MeterResetEvent | null;
  cartridgeSegments?: CartridgeRunSegment[];
}

export interface CartridgeChargeDetail {
  cartridgeId: string;
  channel: TonerChannel;
  installedDuringRun: boolean;
  impressionsUsedOnCartridge: number;
  ratedYieldImpressions: number;
  fractionConsumed: number;
  remainingFraction: number;
  remainingYieldImpressions: number;
  chargedFullCartridge: false; // Invariant guarantee
  allocatedCost: number;
  allocatedMassGrams: number | null;
  massStatus: EvidenceAvailability;
}

export interface MachineMeterEvaluationResult {
  machineId: string | number;
  totalMeterImpressions: number;
  resetApplied: boolean;
  meterProvesImpressionCount: true;
  meterProvesPhysicalTonerMass: false;
  physicalTonerMassStatus: 'unavailable';
  physicalTonerMassReason: string;
  cartridgeCharges: CartridgeChargeDetail[];
  totalAllocatedCartridgeCost: number;
  warnings: string[];
}

function roundNum(val: number, decimals = 6): number {
  const f = 10 ** decimals;
  return Math.round(val * f) / f;
}

function roundMoney(val: number, mode: RoundingMode = 'HALF_EVEN'): number {
  const scaled = Math.round(val * 100);
  const diff = Math.abs(val * 100 - Math.trunc(val * 100));
  if (mode === 'HALF_UP' && Math.abs(diff - 0.5) < 1e-9) {
    return (Math.trunc(val * 100) + 1) / 100;
  }
  return scaled / 100;
}

function worstStatus(statuses: EvidenceAvailability[]): EvidenceAvailability {
  if (statuses.length === 0) return 'unavailable';
  if (statuses.includes('unavailable')) return 'unavailable';
  if (statuses.includes('provisional')) return 'provisional';
  return 'available';
}

export function assertTonerProcessMachine(machine: TonerMachineSpec): void {
  const proc = (machine.processType || '').trim().toLowerCase();
  if (!(TONER_SUPPORTED_PROCESS_TYPES as readonly string[]).includes(proc)) {
    throw new TonerCalculationError(
      'UNSUPPORTED_MACHINE_PROCESS',
      `Machine "${machine.name}" has process type "${machine.processType}", which is not a toner-based printing process.`,
      { machineId: machine.machineId, processType: machine.processType }
    );
  }
  if (machine.status && machine.status !== 'active') {
    throw new TonerCalculationError(
      'UNSUPPORTED_MACHINE_PROCESS',
      `Machine "${machine.name}" is currently "${machine.status}" and unavailable for production.`,
      { machineId: machine.machineId, status: machine.status }
    );
  }
}

function resolveChannelImpressions(
  input: TonerImpressionInput,
  colorMode: TonerColorMode
): { activeChannels: TonerChannel[]; counts: Record<TonerChannel, number>; physicalPrintedSides: number } {
  const counts: Record<TonerChannel, number> = { K: 0, C: 0, M: 0, Y: 0 };

  if (input.byChannel) {
    let maxSides = 0;
    (['K', 'C', 'M', 'Y'] as TonerChannel[]).forEach(ch => {
      const val = input.byChannel?.[ch] ?? 0;
      if (!Number.isFinite(val) || val < 0) {
        throw new TonerCalculationError('INVALID_TONER_SPEC', `Invalid impression count for channel ${ch}.`);
      }
      counts[ch] = val;
      if (val > maxSides) maxSides = val;
    });
    if (colorMode === 'mono' && (counts.C > 0 || counts.M > 0 || counts.Y > 0)) {
      throw new TonerCalculationError(
        'COLOUR_MODE_NOT_SUPPORTED',
        `Mono toner mode cannot receive C/M/Y channel impressions.`
      );
    }
    const activeChannels = (['K', 'C', 'M', 'Y'] as TonerChannel[]).filter(ch =>
      colorMode === 'mono' ? ch === 'K' : counts[ch] > 0 || ch === 'K'
    );
    return {
      activeChannels,
      counts,
      physicalPrintedSides: input.printedSideImpressions ?? maxSides,
    };
  }

  if (input.segments && input.segments.length > 0) {
    let totalPhysicalSides = 0;
    for (const seg of input.segments) {
      if (seg.pages <= 0 || seg.copies <= 0) {
        throw new TonerCalculationError('INVALID_TONER_SPEC', `Segment pages and copies must be positive.`);
      }
      const nUp = seg.nUp ?? 1;
      const sides = Math.ceil(seg.pages / nUp) * seg.copies;
      totalPhysicalSides += sides;
      const segColor = seg.colorMode ?? colorMode;
      if (segColor === 'colour' && colorMode === 'mono') {
        throw new TonerCalculationError(
          'COLOUR_MODE_NOT_SUPPORTED',
          `Cannot calculate colour segment impressions under mono mode.`
        );
      }
      counts.K += sides;
      if (segColor === 'colour') {
        counts.C += sides;
        counts.M += sides;
        counts.Y += sides;
      }
    }
    const extra = input.makeReadyPrintedSides ?? 0;
    if (extra > 0) {
      totalPhysicalSides += extra;
      counts.K += extra;
      if (colorMode === 'colour') {
        counts.C += extra;
        counts.M += extra;
        counts.Y += extra;
      }
    }
    const activeChannels: TonerChannel[] =
      colorMode === 'mono' ? ['K'] : ['K', 'C', 'M', 'Y'];
    return { activeChannels, counts, physicalPrintedSides: totalPhysicalSides };
  }

  const baseSides = input.printedSideImpressions ?? 0;
  const extraSides = input.makeReadyPrintedSides ?? 0;
  if (!Number.isFinite(baseSides) || baseSides < 0 || !Number.isFinite(extraSides) || extraSides < 0) {
    throw new TonerCalculationError('INVALID_TONER_SPEC', `Printed-side impressions must be >= 0.`);
  }
  const totalSides = baseSides + extraSides;
  counts.K = totalSides;
  if (colorMode === 'colour') {
    counts.C = totalSides;
    counts.M = totalSides;
    counts.Y = totalSides;
  }
  const activeChannels: TonerChannel[] = colorMode === 'mono' ? ['K'] : ['K', 'C', 'M', 'Y'];
  return { activeChannels, counts, physicalPrintedSides: totalSides };
}

function resolveCalibratedGramsPerImpression(cal?: TonerCalibrationEvidence | null): {
  gramsPerImp: number | null;
  verified: boolean;
  reason: string;
} {
  if (!cal) {
    return { gramsPerImp: null, verified: false, reason: 'No machine/toner calibration evidence provided.' };
  }
  let gpi: number | null = null;
  if (cal.calibratedGramsPerImpression !== undefined && cal.calibratedGramsPerImpression !== null) {
    if (cal.calibratedGramsPerImpression > 0) {
      gpi = cal.calibratedGramsPerImpression;
    }
  } else if (
    cal.measuredSampleGrams &&
    cal.measuredSampleGrams > 0 &&
    cal.measuredSampleImpressions &&
    cal.measuredSampleImpressions > 0
  ) {
    gpi = cal.measuredSampleGrams / cal.measuredSampleImpressions;
  }

  if (gpi === null || !(gpi > 0)) {
    return {
      gramsPerImp: null,
      verified: false,
      reason: 'Calibration evidence has no valid positive grams-per-impression measurement.',
    };
  }

  return {
    gramsPerImp: gpi,
    verified: cal.evidenceStatus === 'verified',
    reason:
      cal.evidenceStatus === 'verified'
        ? 'Verified calibration grams/impression.'
        : 'Calibration grams/impression is marked unverified (provisional).',
  };
}

function evaluateChannelToner(params: {
  channel: TonerChannel;
  spec: TonerChannelSpec;
  impressions: number;
  requestedMethod: TonerCalculationMethod;
  coverage?: TonerCoverageEvidence | null;
  roundingMode: RoundingMode;
}): TonerChannelResult {
  const { channel, spec, impressions, requestedMethod, coverage, roundingMode } = params;
  const cartridgeCost =
    spec.cartridgeCost !== undefined && spec.cartridgeCost !== null
      ? Number(spec.cartridgeCost)
      : null;

  if (cartridgeCost !== null && (!Number.isFinite(cartridgeCost) || cartridgeCost < 0)) {
    throw new TonerCalculationError('INVALID_TONER_SPEC', `Invalid cartridgeCost on channel ${channel}.`);
  }

  const cal = resolveCalibratedGramsPerImpression(spec.calibration);
  const ratedYield =
    spec.ratedYieldImpressions && spec.ratedYieldImpressions > 0
      ? spec.ratedYieldImpressions
      : null;
  const ratedCoverage =
    spec.ratedCoveragePct && spec.ratedCoveragePct > 0 ? spec.ratedCoveragePct : null;
  const cartridgeMass =
    spec.cartridgeTonerMassGrams && spec.cartridgeTonerMassGrams > 0
      ? spec.cartridgeTonerMassGrams
      : null;

  const tryCalibrated = (): TonerChannelResult => {
    if (cal.gramsPerImp === null) {
      return {
        channel,
        itemId: spec.itemId,
        itemName: spec.name,
        impressions,
        methodUsed: 'unavailable',
        massGrams: null,
        massStatus: 'unavailable',
        massReason: cal.reason,
        cost: null,
        costStatus: 'unavailable',
        costReason: cal.reason,
      };
    }

    const massGrams = roundNum(impressions * cal.gramsPerImp, 6);
    const massStatus: EvidenceAvailability = cal.verified ? 'available' : 'provisional';

    if (cartridgeCost !== null && cartridgeMass !== null) {
      const rawCost = (massGrams / cartridgeMass) * cartridgeCost;
      return {
        channel,
        itemId: spec.itemId,
        itemName: spec.name,
        impressions,
        methodUsed: 'calibrated',
        massGrams,
        massStatus,
        massReason: cal.reason,
        cost: roundMoney(rawCost, roundingMode),
        costStatus: cal.verified ? 'available' : 'provisional',
        costReason: cal.verified
          ? 'Cost computed from calibrated toner mass and cartridge unit cost.'
          : 'Cost is provisional because calibration evidence is unverified.',
      };
    }

    if (cartridgeCost !== null && ratedYield !== null) {
      // Mass known from calibration, cost falls back to rated yield only provisionally if cartridge mass missing
      const rawCost = (impressions / ratedYield) * cartridgeCost;
      return {
        channel,
        itemId: spec.itemId,
        itemName: spec.name,
        impressions,
        methodUsed: 'calibrated',
        massGrams,
        massStatus,
        massReason: cal.reason,
        cost: roundMoney(rawCost, roundingMode),
        costStatus: 'provisional',
        costReason:
          'Calibrated mass available, but cartridgeTonerMassGrams is missing; cost estimated via rated yield.',
      };
    }

    return {
      channel,
      itemId: spec.itemId,
      itemName: spec.name,
      impressions,
      methodUsed: 'calibrated',
      massGrams,
      massStatus,
      massReason: cal.reason,
      cost: null,
      costStatus: 'unavailable',
      costReason: 'Calibrated mass available, but cartridgeCost / cartridgeTonerMassGrams is missing.',
    };
  };

  const tryRatedYield = (): TonerChannelResult => {
    if (ratedYield === null) {
      return {
        channel,
        itemId: spec.itemId,
        itemName: spec.name,
        impressions,
        methodUsed: 'unavailable',
        massGrams: null,
        massStatus: 'unavailable',
        massReason: `Channel ${channel} is missing manufacturer ratedYieldImpressions.`,
        cost: null,
        costStatus: 'unavailable',
        costReason: `Channel ${channel} is missing manufacturer ratedYieldImpressions.`,
      };
    }
    if (cartridgeCost === null) {
      return {
        channel,
        itemId: spec.itemId,
        itemName: spec.name,
        impressions,
        methodUsed: 'unavailable',
        massGrams: cartridgeMass !== null ? roundNum((impressions / ratedYield) * cartridgeMass, 6) : null,
        massStatus: cartridgeMass !== null ? 'provisional' : 'unavailable',
        massReason:
          cartridgeMass !== null
            ? 'Provisional mass inferred from rated yield; uncalibrated.'
            : 'Physical toner mass unavailable without calibration or cartridgeTonerMassGrams.',
        cost: null,
        costStatus: 'unavailable',
        costReason: `Channel ${channel} is missing cartridgeCost.`,
      };
    }

    const rawCost = (impressions / ratedYield) * cartridgeCost;
    const estMass =
      cartridgeMass !== null ? roundNum((impressions / ratedYield) * cartridgeMass, 6) : null;

    return {
      channel,
      itemId: spec.itemId,
      itemName: spec.name,
      impressions,
      methodUsed: 'rated_yield',
      massGrams: estMass,
      massStatus: estMass !== null ? 'provisional' : 'unavailable',
      massReason:
        estMass !== null
          ? 'Provisional nominal mass derived from rated yield at manufacturer basis coverage; not calibrated.'
          : 'Physical toner mass is unavailable from rated yield alone without cartridgeTonerMassGrams or calibration.',
      cost: roundMoney(rawCost, roundingMode),
      costStatus: 'available',
      costReason: 'Cost derived from manufacturer rated yield and cartridge cost.',
    };
  };

  const tryCoverageBased = (): TonerChannelResult => {
    if (!coverage || !(coverage.coveragePct > 0)) {
      return {
        channel,
        itemId: spec.itemId,
        itemName: spec.name,
        impressions,
        methodUsed: 'unavailable',
        massGrams: null,
        massStatus: 'unavailable',
        massReason: `Coverage percentage evidence is missing for channel ${channel}.`,
        cost: null,
        costStatus: 'unavailable',
        costReason: `Coverage percentage evidence is missing for channel ${channel}.`,
      };
    }
    if (ratedYield === null || ratedCoverage === null) {
      return {
        channel,
        itemId: spec.itemId,
        itemName: spec.name,
        impressions,
        methodUsed: 'unavailable',
        massGrams: null,
        massStatus: 'unavailable',
        massReason: `Channel ${channel} requires ratedYieldImpressions and ratedCoveragePct for coverage-based scaling.`,
        cost: null,
        costStatus: 'unavailable',
        costReason: `Channel ${channel} requires ratedYieldImpressions and ratedCoveragePct for coverage-based scaling.`,
      };
    }

    const equivalentRatedImpressions = impressions * (coverage.coveragePct / ratedCoverage);
    const isValidated = coverage.evidenceStatus === 'validated';
    const statusForCoverage: EvidenceAvailability = isValidated ? 'available' : 'provisional';

    const massGrams =
      cartridgeMass !== null
        ? roundNum((equivalentRatedImpressions / ratedYield) * cartridgeMass, 6)
        : null;
    const massStatus: EvidenceAvailability =
      massGrams !== null ? statusForCoverage : 'unavailable';
    const massReason =
      massGrams === null
        ? `Coverage scaling computed, but cartridgeTonerMassGrams is missing for channel ${channel}.`
        : isValidated
        ? `Mass scaled from validated ${coverage.coveragePct}% coverage vs ${ratedCoverage}% rated basis.`
        : `Provisional mass: job coverage (${coverage.coveragePct}%) is marked ${coverage.evidenceStatus}.`;

    const cost =
      cartridgeCost !== null
        ? roundMoney((equivalentRatedImpressions / ratedYield) * cartridgeCost, roundingMode)
        : null;
    const costStatus: EvidenceAvailability = cost !== null ? statusForCoverage : 'unavailable';
    const costReason =
      cost === null
        ? `Cartridge cost is missing for channel ${channel}.`
        : isValidated
        ? `Cost scaled from validated ${coverage.coveragePct}% coverage vs ${ratedCoverage}% rated basis.`
        : `Provisional cost: job coverage (${coverage.coveragePct}%) is marked ${coverage.evidenceStatus}.`;

    return {
      channel,
      itemId: spec.itemId,
      itemName: spec.name,
      impressions,
      methodUsed: 'coverage_based',
      massGrams,
      massStatus,
      massReason,
      cost,
      costStatus,
      costReason,
    };
  };

  if (requestedMethod === 'calibrated') return tryCalibrated();
  if (requestedMethod === 'rated_yield') return tryRatedYield();
  if (requestedMethod === 'coverage_based') return tryCoverageBased();

  // requestedMethod === 'auto': verified calibration -> validated coverage -> rated yield -> provisional
  if (cal.gramsPerImp !== null && cal.verified) {
    return tryCalibrated();
  }
  if (coverage && coverage.coveragePct > 0 && coverage.evidenceStatus === 'validated' && ratedYield && ratedCoverage) {
    return tryCoverageBased();
  }
  if (ratedYield !== null && cartridgeCost !== null) {
    return tryRatedYield();
  }
  if (cal.gramsPerImp !== null) {
    return tryCalibrated();
  }
  if (coverage && coverage.coveragePct > 0) {
    return tryCoverageBased();
  }
  return tryRatedYield();
}

/**
 * Authoritative shared toner calculation engine.
 * - Rejects non-toner machine processes and colour mode on mono machines
 * - Handles mono (K) and colour (K/C/M/Y) channels separately
 * - Uses physical printed-side impressions only (no blank duplex backs)
 * - Supports calibrated, rated_yield, coverage_based, and auto selection without inventing missing data
 */
export function calculateToner(input: TonerCalculationInput): TonerCalculationResult {
  const {
    machine,
    colorMode,
    method = 'auto',
    impressions,
    channels,
    coverageByChannel,
    coverageUniform,
    roundingMode = 'HALF_EVEN',
  } = input;

  assertTonerProcessMachine(machine);

  if (colorMode === 'colour' && !machine.supportsColour) {
    throw new TonerCalculationError(
      'COLOUR_MODE_NOT_SUPPORTED',
      `Machine "${machine.name}" is mono-only and cannot run colour toner jobs.`,
      { machineId: machine.machineId }
    );
  }

  const resolved = resolveChannelImpressions(impressions, colorMode);
  const warnings: string[] = [];
  const channelResults: Partial<Record<TonerChannel, TonerChannelResult>> = {};
  const massStatuses: EvidenceAvailability[] = [];
  const costStatuses: EvidenceAvailability[] = [];

  for (const ch of resolved.activeChannels) {
    const spec = channels[ch];
    if (!spec) {
      throw new TonerCalculationError(
        'MISSING_TONER_CHANNEL',
        `Channel ${ch} toner specification is required for ${colorMode} mode on "${machine.name}".`,
        { channel: ch, colorMode }
      );
    }
    if (spec.isActive === false) {
      throw new TonerCalculationError(
        'INVALID_TONER_SPEC',
        `Toner item "${spec.name}" (${ch}) is inactive.`
      );
    }

    const cov = coverageByChannel?.[ch] !== undefined ? coverageByChannel[ch] : coverageUniform;
    const chResult = evaluateChannelToner({
      channel: ch,
      spec,
      impressions: resolved.counts[ch],
      requestedMethod: method,
      coverage: cov,
      roundingMode,
    });
    channelResults[ch] = chResult;
    massStatuses.push(chResult.massStatus);
    costStatuses.push(chResult.costStatus);

    if (chResult.massStatus !== 'available') {
      warnings.push(`[${ch} mass: ${chResult.massStatus}] ${chResult.massReason}`);
    }
    if (chResult.costStatus !== 'available') {
      warnings.push(`[${ch} cost: ${chResult.costStatus}] ${chResult.costReason}`);
    }
  }

  const activeResults = Object.values(channelResults).filter(
    (r): r is TonerChannelResult => r !== undefined
  );
  const allMassPresent = activeResults.length > 0 && activeResults.every(r => r.massGrams !== null);
  const allCostPresent = activeResults.length > 0 && activeResults.every(r => r.cost !== null);

  const totalMassGrams = allMassPresent
    ? roundNum(activeResults.reduce((s, r) => s + (r.massGrams || 0), 0), 6)
    : null;
  const totalCost = allCostPresent
    ? roundMoney(activeResults.reduce((s, r) => s + (r.cost || 0), 0), roundingMode)
    : null;

  const formattedTotalCost2 =
    totalCost !== null ? formatDecimal2(BigInt(Math.round(totalCost * 10000)), roundingMode) : null;

  return {
    machineId: machine.machineId,
    machineName: machine.name,
    processType: machine.processType,
    colorMode,
    requestedMethod: method,
    totalPrintedSideImpressions: resolved.physicalPrintedSides,
    channels: channelResults,
    totalMassGrams,
    totalMassStatus: allMassPresent ? worstStatus(massStatuses) : 'unavailable',
    totalCost,
    totalCostStatus: allCostPresent ? worstStatus(costStatuses) : 'unavailable',
    formattedTotalCost2,
    warnings,
  };
}

/**
 * Evaluates machine meter readings, counter reset events, and mid-run cartridge replacements.
 * Enforces:
 * - Meter readings NEVER prove physical toner mass
 * - Installing a new cartridge mid-run NEVER charges 100% of the cartridge to the job
 */
export function evaluateMachineMeterAndCartridges(
  input: MachineMeterEvaluationInput,
  roundingMode: RoundingMode = 'HALF_EVEN'
): MachineMeterEvaluationResult {
  const { machine, startMeter, endMeter, resetEvent, cartridgeSegments = [] } = input;
  assertTonerProcessMachine(machine);

  if (!Number.isFinite(startMeter) || startMeter < 0 || !Number.isFinite(endMeter) || endMeter < 0) {
    throw new TonerCalculationError(
      'INVALID_METER_READING',
      `Machine meter readings must be non-negative (got start=${startMeter}, end=${endMeter}).`
    );
  }

  let totalMeterImpressions: number;
  let resetApplied = false;

  if (endMeter < startMeter) {
    if (!resetEvent) {
      throw new TonerCalculationError(
        'INVALID_METER_READING',
        `End meter (${endMeter}) is lower than start meter (${startMeter}) without a recorded counter reset event.`,
        { startMeter, endMeter }
      );
    }
    if (
      resetEvent.meterBeforeReset < startMeter ||
      resetEvent.meterAfterReset < 0 ||
      endMeter < resetEvent.meterAfterReset
    ) {
      throw new TonerCalculationError(
        'INVALID_METER_READING',
        `Invalid meter reset event bounds: start=${startMeter}, beforeReset=${resetEvent.meterBeforeReset}, afterReset=${resetEvent.meterAfterReset}, end=${endMeter}.`
      );
    }
    totalMeterImpressions =
      resetEvent.meterBeforeReset - startMeter + (endMeter - resetEvent.meterAfterReset);
    resetApplied = true;
  } else if (resetEvent) {
    totalMeterImpressions =
      resetEvent.meterBeforeReset - startMeter + (endMeter - resetEvent.meterAfterReset);
    resetApplied = true;
  } else {
    totalMeterImpressions = endMeter - startMeter;
  }

  const warnings: string[] = [
    'Machine meter click counter establishes impression count only and cannot serve as proof of physical toner mass.',
  ];

  const cartridgeCharges: CartridgeChargeDetail[] = cartridgeSegments.map(seg => {
    if (!(seg.ratedYieldImpressions > 0)) {
      throw new TonerCalculationError(
        'INVALID_TONER_SPEC',
        `Cartridge "${seg.cartridgeId}" requires ratedYieldImpressions > 0.`
      );
    }
    if (seg.impressionsUsedOnCartridge < 0 || seg.cartridgeCost < 0) {
      throw new TonerCalculationError(
        'INVALID_TONER_SPEC',
        `Cartridge "${seg.cartridgeId}" cannot have negative impressions or cost.`
      );
    }
    const fractionConsumed = roundNum(seg.impressionsUsedOnCartridge / seg.ratedYieldImpressions, 6);
    const remainingFraction = roundNum(Math.max(0, 1 - fractionConsumed), 6);
    const remainingYieldImpressions = Math.max(
      0,
      seg.ratedYieldImpressions - seg.impressionsUsedOnCartridge
    );
    const allocatedCost = roundMoney(fractionConsumed * seg.cartridgeCost, roundingMode);

    let allocatedMassGrams: number | null = null;
    let massStatus: EvidenceAvailability = 'unavailable';
    if (seg.calibratedGramsPerImpression && seg.calibratedGramsPerImpression > 0) {
      allocatedMassGrams = roundNum(
        seg.impressionsUsedOnCartridge * seg.calibratedGramsPerImpression,
        6
      );
      massStatus = 'available';
    } else if (seg.cartridgeTonerMassGrams && seg.cartridgeTonerMassGrams > 0) {
      allocatedMassGrams = roundNum(fractionConsumed * seg.cartridgeTonerMassGrams, 6);
      massStatus = 'provisional';
    }

    return {
      cartridgeId: seg.cartridgeId,
      channel: seg.channel,
      installedDuringRun: Boolean(seg.installedDuringRun),
      impressionsUsedOnCartridge: seg.impressionsUsedOnCartridge,
      ratedYieldImpressions: seg.ratedYieldImpressions,
      fractionConsumed,
      remainingFraction,
      remainingYieldImpressions,
      chargedFullCartridge: false,
      allocatedCost,
      allocatedMassGrams,
      massStatus,
    };
  });

  const totalAllocatedCartridgeCost = roundMoney(
    cartridgeCharges.reduce((s, c) => s + c.allocatedCost, 0),
    roundingMode
  );

  return {
    machineId: machine.machineId,
    totalMeterImpressions,
    resetApplied,
    meterProvesImpressionCount: true,
    meterProvesPhysicalTonerMass: false,
    physicalTonerMassStatus: 'unavailable',
    physicalTonerMassReason:
      'Meter counter readings prove impression counts only; physical toner mass requires verified calibration or validated cartridge mass & coverage.',
    cartridgeCharges,
    totalAllocatedCartridgeCost,
    warnings,
  };
}

/**
 * Authoritative database lookup for machine and toner raw materials scoped by company_id.
 * Maps persisted fields faithfully without inventing missing calibration, colour support, or toner gram columns.
 */
export async function lookupTonerAndMachineFromDb(
  tx: Transaction,
  companyId: number,
  params: {
    machineId: number;
    tonerItemIds: Partial<Record<TonerChannel, number>>;
    machineSupportsColourOverride?: boolean;
  }
): Promise<{
  machine: TonerMachineSpec;
  channels: Partial<Record<TonerChannel, TonerChannelSpec>>;
}> {
  const mRes = await tx.query<{
    id: number;
    name: string;
    machine_type: string;
    supports_duplex: boolean;
    status: string;
  }>(
    `SELECT id, name, machine_type, supports_duplex, status
       FROM printing_machines
      WHERE company_id = $1 AND id = $2
      LIMIT 1`,
    [companyId, params.machineId]
  );

  if (mRes.rows.length === 0) {
    throw new TonerCalculationError(
      'MACHINE_NOT_FOUND',
      `Printing machine ${params.machineId} not found for company ${companyId}.`
    );
  }
  const mRow = mRes.rows[0];

  const channels: Partial<Record<TonerChannel, TonerChannelSpec>> = {};
  for (const ch of ['K', 'C', 'M', 'Y'] as TonerChannel[]) {
    const itemId = params.tonerItemIds[ch];
    if (!itemId) continue;

    const tRes = await tx.query<{
      id: number;
      sku: string;
      name: string;
      is_active: boolean;
      unit_cost: string;
      conversion_factor: string;
      yield_per_purchase_unit: string | null;
      coverage_basis_pct: string | null;
      color_channel: string | null;
    }>(
      `SELECT ii.id,
              ii.sku,
              ii.name,
              ii.is_active,
              ii.unit_cost::text,
              ii.conversion_factor::text,
              ms.yield_per_purchase_unit::text,
              ms.coverage_basis_pct::text,
              ms.color_channel
         FROM inventory_items ii
         LEFT JOIN material_specifications ms
           ON ms.company_id = ii.company_id AND ms.inventory_item_id = ii.id
        WHERE ii.company_id = $1 AND ii.id = $2
        LIMIT 1`,
      [companyId, itemId]
    );

    if (tRes.rows.length === 0) {
      throw new TonerCalculationError(
        'TONER_STOCK_NOT_FOUND',
        `Toner inventory item ${itemId} (channel ${ch}) not found for company ${companyId}.`
      );
    }
    const tRow = tRes.rows[0];
    const ratedYield =
      tRow.yield_per_purchase_unit !== null
        ? Number(tRow.yield_per_purchase_unit)
        : Number(tRow.conversion_factor) > 1
        ? Number(tRow.conversion_factor)
        : null;

    channels[ch] = {
      itemId: Number(tRow.id),
      sku: tRow.sku,
      name: tRow.name,
      channel: ch,
      isActive: tRow.is_active,
      cartridgeCost: Number(tRow.unit_cost),
      cartridgeTonerMassGrams: null, // Not stored in material_specifications SQL schema
      ratedYieldImpressions: ratedYield,
      ratedCoveragePct: tRow.coverage_basis_pct !== null ? Number(tRow.coverage_basis_pct) : null,
      calibration: null, // No machine/toner calibration log table in SQL schema
    };
  }

  const supportsColour =
    params.machineSupportsColourOverride !== undefined
      ? params.machineSupportsColourOverride
      : Boolean(channels.C || channels.M || channels.Y);

  return {
    machine: {
      machineId: Number(mRow.id),
      name: mRow.name,
      processType: mRow.machine_type,
      supportsColour,
      supportsDuplex: mRow.supports_duplex,
      status: mRow.status,
    },
    channels,
  };
}
