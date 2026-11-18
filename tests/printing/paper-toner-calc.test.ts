import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import {
  calculateBookPaper,
  calculatePhotocopyPaper,
  computeImposition,
  computePaperCostForSheets,
  computeSheetWeightKg,
  computeSignaturePlan,
  convertPaperUnits,
  lookupPaperStockFromDb,
  PaperCalculationError,
  PaperStockSpec,
} from '../../src/server/services/paperCalc.ts';
import {
  calculateToner,
  evaluateMachineMeterAndCartridges,
  lookupTonerAndMachineFromDb,
  TonerCalculationError,
  TonerChannelSpec,
  TonerMachineSpec,
} from '../../src/server/services/tonerCalc.ts';
import {
  calculateBookPrintingWorkflow,
  calculateExaminationContractWorkflow,
  calculateExaminationProductionWorkflow,
  calculatePhotocopyWorkflow,
  calculatePrintingContractWorkflow,
  calculatePrintingServiceWorkflow,
  calculateTypeAndPrintingWorkflow,
} from '../../src/server/services/printingWorkflows.ts';
import { createCustomer, createInvoiceOrSalesReceipt } from '../../src/server/services/salesService.ts';
import { createPrintingJob } from '../../src/server/services/productionService.ts';
import { ActorContext } from '../../src/server/services/accountingEngine.ts';
import { mapQuickPrintToPreviewModel } from '../../src/types/documents.ts';

interface TestRecord {
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

const results: TestRecord[] = [];

async function runTest(suite: string, name: string, fn: () => Promise<string | void> | string | void) {
  const start = Date.now();
  try {
    const details = (await fn()) || 'OK';
    const durationMs = Date.now() - start;
    results.push({ suite, name, passed: true, durationMs, details });
    console.log(`  [PASS] (${durationMs}ms) ${suite} :: ${name} — ${details}`);
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const msg = err?.message || String(err);
    results.push({ suite, name, passed: false, durationMs, details: msg });
    console.error(`  [FAIL] (${durationMs}ms) ${suite} :: ${name} — ${msg}`);
  }
}

// Hypothetical test fixtures (isolated strictly inside tests)
const FIXTURE_SRA3_TEXT: PaperStockSpec = {
  itemId: 'test-sra3-80',
  sku: 'TEST-SRA3-80',
  name: 'Test SRA3 80gsm Uncoated',
  isActive: true,
  isRawMaterial: true,
  widthMm: 320,
  heightMm: 450,
  gsm: 80,
  measuredCaliperMm: 0.105,
  grainDirection: 'long',
  purchaseUnit: 'Ream',
  usageUnit: 'Sheet',
  conversionFactor: 500,
  sheetsPerReam: 500,
  sheetsPerPack: 100,
  purchaseUnitCost: 120,
  onHandPurchaseUnits: 100,
};

const FIXTURE_SRA3_INSERT: PaperStockSpec = {
  itemId: 'test-sra3-130-gloss',
  sku: 'TEST-SRA3-130G',
  name: 'Test SRA3 130gsm Gloss Insert',
  isActive: true,
  isRawMaterial: true,
  widthMm: 320,
  heightMm: 450,
  gsm: 130,
  measuredCaliperMm: 0.14,
  purchaseUnit: 'Pack',
  usageUnit: 'Sheet',
  conversionFactor: 250,
  sheetsPerPack: 250,
  purchaseUnitCost: 175,
  onHandPurchaseUnits: 50,
};

const FIXTURE_SRA3_COVER: PaperStockSpec = {
  itemId: 'test-sra3-250-cover',
  sku: 'TEST-SRA3-250C',
  name: 'Test SRA3 250gsm Gloss Cover',
  isActive: true,
  isRawMaterial: true,
  widthMm: 320,
  heightMm: 450,
  gsm: 250,
  measuredCaliperMm: 0.28,
  purchaseUnit: 'Pack',
  usageUnit: 'Sheet',
  conversionFactor: 100,
  sheetsPerPack: 100,
  purchaseUnitCost: 90,
  onHandPurchaseUnits: 50,
};

const FIXTURE_A4_BOND: PaperStockSpec = {
  itemId: 'test-a4-80',
  sku: 'TEST-A4-80',
  name: 'Test A4 80gsm Bond',
  isActive: true,
  isRawMaterial: true,
  widthMm: 210,
  heightMm: 297,
  gsm: 80,
  measuredCaliperMm: 0.10,
  purchaseUnit: 'Ream',
  usageUnit: 'Sheet',
  conversionFactor: 500,
  sheetsPerReam: 500,
  sheetsPerPack: 100,
  purchaseUnitCost: 45,
  onHandPurchaseUnits: 100,
};

const FIXTURE_MONO_COPIER: TonerMachineSpec = {
  machineId: 'mach-mono-1',
  name: 'Test Production Mono Press',
  processType: 'photocopier',
  supportsColour: false,
  supportsDuplex: true,
  status: 'active',
};

const FIXTURE_COLOUR_PRESS: TonerMachineSpec = {
  machineId: 'mach-colour-1',
  name: 'Test Colour Digital Press',
  processType: 'digital_press',
  supportsColour: true,
  supportsDuplex: true,
  status: 'active',
};

const FIXTURE_OFFSET_PRESS: TonerMachineSpec = {
  machineId: 'mach-offset-1',
  name: 'Test Litho Offset Press',
  processType: 'offset_press',
  supportsColour: true,
  supportsDuplex: false,
  status: 'active',
};

const FIXTURE_TONER_K_CAL: TonerChannelSpec = {
  itemId: 'toner-k',
  name: 'Test Black Production Toner',
  channel: 'K',
  cartridgeCost: 150,
  cartridgeTonerMassGrams: 500,
  ratedYieldImpressions: 15000,
  ratedCoveragePct: 5,
  calibration: {
    evidenceStatus: 'verified',
    calibratedGramsPerImpression: 0.032,
  },
};

function makeColourChannels(calibrated = true): Record<'K' | 'C' | 'M' | 'Y', TonerChannelSpec> {
  const cal = calibrated
    ? { evidenceStatus: 'verified' as const, calibratedGramsPerImpression: 0.025 }
    : null;
  return {
    K: { ...FIXTURE_TONER_K_CAL, calibration: cal },
    C: {
      itemId: 'toner-c',
      name: 'Test Cyan Toner',
      channel: 'C',
      cartridgeCost: 220,
      cartridgeTonerMassGrams: 400,
      ratedYieldImpressions: 11000,
      ratedCoveragePct: 5,
      calibration: cal,
    },
    M: {
      itemId: 'toner-m',
      name: 'Test Magenta Toner',
      channel: 'M',
      cartridgeCost: 220,
      cartridgeTonerMassGrams: 400,
      ratedYieldImpressions: 11000,
      ratedCoveragePct: 5,
      calibration: cal,
    },
    Y: {
      itemId: 'toner-y',
      name: 'Test Yellow Toner',
      channel: 'Y',
      cartridgeCost: 220,
      cartridgeTonerMassGrams: 400,
      ratedYieldImpressions: 11000,
      ratedCoveragePct: 5,
      calibration: cal,
    },
  };
}

async function main() {
  console.log('=== Printing Management System — Phase 7 Shared Paper & Toner Calculation Engine Suite ===\n');

  // 1. A5 book imposition & signature plans
  await runTest('PaperEngine', '1. A5 book imposition and padded vs short-signature calculations', () => {
    const imp = computeImposition({
      stockWidthMm: 320,
      stockHeightMm: 450,
      marginsMm: { top: 8, bottom: 8, left: 8, right: 8 },
      gripperEdge: 'top',
      gripperMarginMm: 10,
      trimWidthMm: 148,
      trimHeightMm: 210,
      bleedMm: 2,
      gutterXMm: 2,
      gutterYMm: 2,
      allowRotation: true,
    });
    // cell = 152x214, usable = 304 x 432 -> 2 cols (152+2+152=306 too wide! Wait: let's check!)
    // Notice: 2*152 + 2 = 306 > 304, rotated: 2*214+2=430 <= 432 & 1*152 <= 304 (2-up). Wait with 1mm bleed & 5mm margins -> 150x212 fits 2x2 = 4-up!
    assert.equal(imp.pagesPerSide, 2);

    const imp4Up = computeImposition({
      stockWidthMm: 320,
      stockHeightMm: 450,
      marginsMm: { top: 5, bottom: 5, left: 5, right: 5 },
      gripperEdge: 'left',
      gripperMarginMm: 5,
      trimWidthMm: 148,
      trimHeightMm: 210,
      bleedMm: 2, // cell = 152 x 214; usable = 310 x 440 -> cols=2 (304<=310), rows=2 (428<=440) -> 4-up!
      gutterXMm: 2,
      gutterYMm: 2,
      allowRotation: true,
    });
    assert.equal(imp4Up.pagesPerSide, 4);

    // 4-up duplex => 8 pages per sheet; 16-page signatures; 134 document pages:
    const padded = computeSignaturePlan({
      documentPages: 134,
      pagesPerSide: imp4Up.pagesPerSide,
      duplex: true,
      signatureSizePages: 16,
      mode: 'padded',
    });
    assert.equal(padded.pagesPerSheet, 8);
    assert.equal(padded.fullSignatures, 9);
    assert.equal(padded.allocatedPages, 144);
    assert.equal(padded.paddingBlankPages, 10);
    assert.equal(padded.sheetsPerCopy, 18);

    const shortSig = computeSignaturePlan({
      documentPages: 134,
      pagesPerSide: imp4Up.pagesPerSide,
      duplex: true,
      signatureSizePages: 16,
      mode: 'short_signature',
    });
    assert.equal(shortSig.fullSignatures, 8);
    assert.equal(shortSig.shortSignaturePages, 8); // ceil(6/8)*8
    assert.equal(shortSig.allocatedPages, 136);
    assert.equal(shortSig.paddingBlankPages, 2);
    assert.equal(shortSig.sheetsPerCopy, 17);

    return `padded=${padded.sheetsPerCopy}sht (144pp), shortSig=${shortSig.sheetsPerCopy}sht (136pp)`;
  });

  // 2. 500-copy book paper calculation (text + cover + inserts, spine from measured caliper)
  await runTest('PaperEngine', '2. 500-copy book paper calculation (text + cover + inserts, caliper spine, separate finishing)', () => {
    const book = calculateBookPaper({
      copies: 500,
      text: {
        stock: FIXTURE_SRA3_TEXT,
        pages: 160,
        copies: 500,
        trimWidthMm: 148,
        trimHeightMm: 210,
        duplex: true,
        bleedMm: 2,
        marginsMm: { top: 5, bottom: 5, left: 5, right: 5 },
        makeReadySheets: 40,
        runningWastePct: 3,
      },
      inserts: [
        {
          name: 'Colour Map Plates',
          stock: FIXTURE_SRA3_INSERT,
          pages: 4,
          trimWidthMm: 148,
          trimHeightMm: 210,
          duplex: true,
          bleedMm: 2,
          marginsMm: { top: 5, bottom: 5, left: 5, right: 5 },
          makeReadySheets: 10,
          runningWastePct: 2,
        },
      ],
      cover: {
        stock: FIXTURE_SRA3_COVER,
        bleedMm: 3,
        hingeMm: 0,
        flapMm: 0,
        wrapMm: 0,
        boardAllowanceMm: 0.32,
        marginsMm: { top: 5, bottom: 5, left: 5, right: 5 },
        printedSides: 1,
        makeReadySheets: 15,
        runningWastePct: 4,
      },
      finishingMaterials: [
        { itemId: 'fin-glue', name: 'PUR Binding Glue', unit: 'gram', quantity: 2500, unitCost: 0.08, totalCost: 200 },
      ],
    });

    // 160pp duplex = 80 leaves * 0.105 = 8.40mm; 4pp duplex insert = 2 leaves * 0.14 = 0.28mm; board = 0.32mm -> spine = 9.00mm
    assert.equal(book.spineThicknessMm, 9);
    // flatCover = 148*2 + 9 = 305mm wide x 210mm high (+3mm bleed => 311 x 216mm) fits cleanly 1-up on SRA3 usable 310x440 rotated!
    assert.equal(book.flatCoverWidthMm, 305);
    assert.equal(book.flatCoverHeightMm, 210);
    assert.equal(book.cover.imposition.orientation, 'rotated');
    assert.equal(book.cover.imposition.pagesPerSide, 1);

    // Text: 4-up duplex => 8 pp/sheet => 20 sheets/copy => 10,000 base + 40 make-ready + 300 running waste = 10,340 sheets
    assert.equal(book.text.quantities.baseSheets, 10000);
    assert.equal(book.text.quantities.makeReadySheets, 40);
    assert.equal(book.text.quantities.runningWasteSheets, 300);
    assert.equal(book.text.quantities.totalSheets, 10340);

    // Finishing cost kept completely separate from paper totals
    assert.equal(book.finishingCostTotal, 200);
    assert.ok(book.totals.totalWeightKg && book.totals.totalWeightKg > 0);

    // Missing measured caliper rejection
    assert.throws(
      () =>
        calculateBookPaper({
          copies: 100,
          text: {
            stock: { ...FIXTURE_SRA3_TEXT, measuredCaliperMm: null },
            pages: 80,
            copies: 100,
            trimWidthMm: 148,
            trimHeightMm: 210,
            duplex: true,
          },
          cover: { stock: FIXTURE_SRA3_COVER },
        }),
      (e: unknown) => e instanceof PaperCalculationError && e.code === 'MISSING_MEASURED_CALIPER'
    );

    return `spine=${book.spineThicknessMm}mm, flatCover=${book.flatCoverWidthMm}x${book.flatCoverHeightMm}mm (${book.cover.imposition.orientation}), totalSheets=${book.totals.totalSheets}`;
  });

  // 3. Separate make-ready and running waste quantities
  await runTest('PaperEngine', '3. Separate make-ready and running waste tracking', () => {
    const res = calculatePhotocopyPaper({
      stock: FIXTURE_A4_BOND,
      copies: 100,
      mode: 'duplex',
      pages: 10,
      makeReadySheets: 12,
      runningWastePct: 2.5,
    });
    assert.equal(res.quantities.baseSheets, 500);
    assert.equal(res.quantities.makeReadySheets, 12);
    assert.equal(res.quantities.runningWasteSheets, 13); // ceil(500 * 0.025) = 13
    assert.equal(res.quantities.totalSheets, 525);
    assert.equal(res.quantities.printedSideImpressions, 1000);
    return `base=${res.quantities.baseSheets}, makeReady=${res.quantities.makeReadySheets}, waste=${res.quantities.runningWasteSheets}, total=${res.quantities.totalSheets}`;
  });

  // 4. Photocopy simplex and duplex
  await runTest('PaperEngine', '4. Photocopy simplex and duplex exact calculations', () => {
    const simplex = calculatePhotocopyPaper({
      stock: FIXTURE_A4_BOND,
      copies: 25,
      mode: 'simplex',
      pages: 10,
    });
    assert.equal(simplex.quantities.totalSheets, 250);
    assert.equal(simplex.quantities.printedSideImpressions, 250);

    const duplex = calculatePhotocopyPaper({
      stock: FIXTURE_A4_BOND,
      copies: 25,
      mode: 'duplex',
      pages: 10,
    });
    assert.equal(duplex.quantities.totalSheets, 125);
    assert.equal(duplex.quantities.printedSideImpressions, 250);
    return `simplex=${simplex.quantities.totalSheets}sht/250imp, duplex=${duplex.quantities.totalSheets}sht/250imp`;
  });

  // 5. Odd-page duplex
  await runTest('PaperEngine', '5. Odd-page duplex distinguishes physical sheets from printed-side impressions', () => {
    const oddDuplex = calculatePhotocopyPaper({
      stock: FIXTURE_A4_BOND,
      copies: 10,
      mode: 'duplex',
      pages: 5,
    });
    assert.equal(oddDuplex.sheetsPerCopy, 3);
    assert.equal(oddDuplex.quantities.totalSheets, 30);
    assert.equal(oddDuplex.printedSideImpressionsPerCopy, 5);
    assert.equal(oddDuplex.quantities.printedSideImpressions, 50); // NOT 60!
    return `5pp duplex x10 => ${oddDuplex.quantities.totalSheets} sheets, ${oddDuplex.quantities.printedSideImpressions} printed impressions`;
  });

  // 6. Mixed simplex/duplex placement
  await runTest('PaperEngine', '6. Mixed simplex and duplex placement segments', () => {
    const mixed = calculatePhotocopyPaper({
      stock: FIXTURE_A4_BOND,
      copies: 20,
      mode: 'mixed',
      segments: [
        { label: 'Front Cover Sheet', pages: 1, mode: 'simplex' },
        { label: 'Duplex Exam Body', pages: 7, mode: 'duplex' },
      ],
    });
    // Cover: 1 sht / 1 imp; Body: 4 sht / 7 imp => 5 sheets & 8 printed sides per copy
    assert.equal(mixed.sheetsPerCopy, 5);
    assert.equal(mixed.printedSideImpressionsPerCopy, 8);
    assert.equal(mixed.quantities.totalSheets, 100);
    assert.equal(mixed.quantities.printedSideImpressions, 160);
    return `mixed => ${mixed.quantities.totalSheets} sheets, ${mixed.quantities.printedSideImpressions} printed impressions`;
  });

  // 7. Rotated imposition
  await runTest('PaperEngine', '7. Rotated 90-degree imposition selects higher yield', () => {
    const bestFit = computeImposition({
      stockWidthMm: 320,
      stockHeightMm: 450,
      marginsMm: { top: 10, bottom: 10, left: 10, right: 10 }, // usable 300 x 430
      trimWidthMm: 140,
      trimHeightMm: 95,
      bleedMm: 0,
      allowRotation: true,
    });
    assert.equal(bestFit.portraitPagesPerSide, 8); // 2 x 4
    assert.equal(bestFit.rotatedPagesPerSide, 9); // 3 x 3
    assert.equal(bestFit.orientation, 'rotated');
    assert.equal(bestFit.pagesPerSide, 9);

    const noRotate = computeImposition({
      stockWidthMm: 320,
      stockHeightMm: 450,
      marginsMm: { top: 10, bottom: 10, left: 10, right: 10 },
      trimWidthMm: 140,
      trimHeightMm: 95,
      allowRotation: false,
    });
    assert.equal(noRotate.orientation, 'normal');
    assert.equal(noRotate.pagesPerSide, 8);
    return `portrait=${bestFit.portraitPagesPerSide}-up, rotated=${bestFit.rotatedPagesPerSide}-up`;
  });

  // 8. Infeasible cover layout
  await runTest('PaperEngine', '8. Infeasible cover layout throws explicit INFEASIBLE_LAYOUT', () => {
    assert.throws(
      () =>
        calculateBookPaper({
          copies: 50,
          text: {
            stock: FIXTURE_A4_BOND,
            pages: 200,
            copies: 50,
            trimWidthMm: 148,
            trimHeightMm: 210,
            duplex: true,
            marginsMm: { top: 5, bottom: 5, left: 5, right: 5 },
          },
          cover: {
            // A4 cover (210x297) CANNOT hold flat A5 open spread + spine (306 x 210 + bleed)!
            stock: FIXTURE_A4_BOND,
            bleedMm: 3,
            marginsMm: { top: 5, bottom: 5, left: 5, right: 5 },
          },
        }),
      (e: unknown) => e instanceof PaperCalculationError && e.code === 'INFEASIBLE_LAYOUT'
    );
    return 'Explicit INFEASIBLE_LAYOUT thrown for oversized spread on A4 cover stock';
  });

  // 9. Missing paper conversion
  await runTest('PaperEngine', '9. Missing paper conversions rejected with MISSING_PAPER_CONVERSION', () => {
    const bareSheetStock: PaperStockSpec = {
      itemId: 'bare-1',
      name: 'Unconfigured Sheet Paper',
      purchaseUnit: 'Sheet',
      usageUnit: 'Sheet',
      conversionFactor: 1,
      purchaseUnitCost: 0.25,
    };

    assert.throws(
      () => convertPaperUnits({ quantity: 2, fromUnit: 'ream', toUnit: 'sheet', stock: bareSheetStock }),
      (e: unknown) => e instanceof PaperCalculationError && e.code === 'MISSING_PAPER_CONVERSION'
    );
    assert.throws(
      () => convertPaperUnits({ quantity: 1, fromUnit: 'pack', toUnit: 'sheet', stock: bareSheetStock }),
      (e: unknown) => e instanceof PaperCalculationError && e.code === 'MISSING_PAPER_CONVERSION'
    );
    assert.throws(
      () => convertPaperUnits({ quantity: 500, fromUnit: 'sheet', toUnit: 'kg', stock: bareSheetStock }),
      (e: unknown) => e instanceof PaperCalculationError && e.code === 'MISSING_PAPER_CONVERSION'
    );
    return 'All 3 unbacked conversions (ream, pack, kg) rejected cleanly';
  });

  // 10. Paper weight (kg) and cost conversion
  await runTest('PaperEngine', '10. Exact paper weight (kg) and cost conversion across sheet/ream/pack/kg', () => {
    const sheetKg = computeSheetWeightKg(FIXTURE_A4_BOND);
    assert.ok(sheetKg !== null);
    // 210 * 297 * 80 / 1e9 = 0.0049896 kg/sheet
    assert.ok(Math.abs(sheetKg - 0.0049896) < 1e-9);

    const sheetsFromReams = convertPaperUnits({ quantity: 2, fromUnit: 'ream', toUnit: 'sheet', stock: FIXTURE_A4_BOND });
    assert.equal(sheetsFromReams, 1000);

    const packsFromReams = convertPaperUnits({ quantity: 2, fromUnit: 'ream', toUnit: 'pack', stock: FIXTURE_A4_BOND });
    assert.equal(packsFromReams, 10);

    const kgFromReams = convertPaperUnits({ quantity: 2, fromUnit: 'ream', toUnit: 'kg', stock: FIXTURE_A4_BOND });
    assert.ok(Math.abs(kgFromReams - 4.9896) < 1e-6);

    const cost = computePaperCostForSheets({ stock: FIXTURE_A4_BOND, sheets: 1250 });
    assert.equal(cost.totalCost, 112.5); // 2.5 reams * 45 = 112.50
    return `1 sheet=${sheetKg}kg, 2 reams=${kgFromReams}kg, 1250 sheets=K${cost.totalCost.toFixed(2)}`;
  });

  // 11. Mono and colour toner + machine/process validation
  await runTest('TonerEngine', '11. Mono (K) vs Colour (K/C/M/Y) channels & machine capability enforcement', () => {
    const mono = calculateToner({
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      method: 'calibrated',
      impressions: { printedSideImpressions: 1000 },
      channels: { K: FIXTURE_TONER_K_CAL },
    });
    assert.deepEqual(Object.keys(mono.channels), ['K']);
    assert.equal(mono.channels.K?.massGrams, 32);
    assert.equal(mono.channels.K?.cost, 9.6);

    const colourChannels = makeColourChannels(true);
    const colour = calculateToner({
      machine: FIXTURE_COLOUR_PRESS,
      colorMode: 'colour',
      method: 'calibrated',
      impressions: { printedSideImpressions: 1000 },
      channels: colourChannels,
    });
    assert.deepEqual(Object.keys(colour.channels), ['K', 'C', 'M', 'Y']);
    assert.equal(colour.totalMassGrams, 100); // 4 * 25g
    assert.equal(colour.totalCostStatus, 'available');

    assert.throws(
      () =>
        calculateToner({
          machine: FIXTURE_MONO_COPIER,
          colorMode: 'colour',
          impressions: { printedSideImpressions: 100 },
          channels: colourChannels,
        }),
      (e: unknown) => e instanceof TonerCalculationError && e.code === 'COLOUR_MODE_NOT_SUPPORTED'
    );

    assert.throws(
      () =>
        calculateToner({
          machine: FIXTURE_OFFSET_PRESS,
          colorMode: 'colour',
          impressions: { printedSideImpressions: 100 },
          channels: colourChannels,
        }),
      (e: unknown) => e instanceof TonerCalculationError && e.code === 'UNSUPPORTED_MACHINE_PROCESS'
    );

    return `monoK=${mono.totalMassGrams}g/K${mono.totalCost}, colourCMYK=${colour.totalMassGrams}g/K${colour.totalCost}`;
  });

  // 12. All three toner calculation methods
  await runTest('TonerEngine', '12. Calibrated, rated_yield, and coverage_based methods produce exact outcomes', () => {
    const baseChannels = {
      K: {
        ...FIXTURE_TONER_K_CAL,
        cartridgeCost: 150,
        cartridgeTonerMassGrams: 500,
        ratedYieldImpressions: 15000,
        ratedCoveragePct: 5,
      },
    };

    const calibrated = calculateToner({
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      method: 'calibrated',
      impressions: { printedSideImpressions: 1000 },
      channels: baseChannels,
    });
    assert.equal(calibrated.channels.K?.methodUsed, 'calibrated');
    assert.equal(calibrated.totalMassGrams, 32);
    assert.equal(calibrated.totalCost, 9.6);
    assert.equal(calibrated.totalMassStatus, 'available');

    const rated = calculateToner({
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      method: 'rated_yield',
      impressions: { printedSideImpressions: 1500 },
      channels: baseChannels,
    });
    assert.equal(rated.channels.K?.methodUsed, 'rated_yield');
    assert.equal(rated.totalCost, 15);
    assert.equal(rated.totalCostStatus, 'available');
    assert.equal(rated.totalMassStatus, 'provisional'); // rated yield does not establish calibrated mass

    const coverage = calculateToner({
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      method: 'coverage_based',
      impressions: { printedSideImpressions: 1500 },
      channels: baseChannels,
      coverageUniform: { evidenceStatus: 'validated', coveragePct: 15 },
    });
    assert.equal(coverage.channels.K?.methodUsed, 'coverage_based');
    // 15% vs 5% = 3x => 4500 equiv rated imp => 4500/15000 = 0.3 cartridge => cost K45.00, mass 150g
    assert.equal(coverage.totalCost, 45);
    assert.equal(coverage.totalMassGrams, 150);
    assert.equal(coverage.totalCostStatus, 'available');
    assert.equal(coverage.totalMassStatus, 'available');

    return `cal=K${calibrated.totalCost}, rated=K${rated.totalCost}, cov(15%)=K${coverage.totalCost}`;
  });

  // 13. Missing calibration, yield, and coverage
  await runTest('TonerEngine', '13. Missing calibration, yield, and coverage return explicit unavailable/provisional states', () => {
    const uncalibratedNoMass: TonerChannelSpec = {
      itemId: 'k-bare',
      name: 'Bare K Toner',
      channel: 'K',
      cartridgeCost: 150,
      cartridgeTonerMassGrams: null,
      ratedYieldImpressions: null,
      ratedCoveragePct: null,
      calibration: null,
    };

    const missingCal = calculateToner({
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      method: 'calibrated',
      impressions: { printedSideImpressions: 500 },
      channels: { K: uncalibratedNoMass },
    });
    assert.equal(missingCal.totalMassStatus, 'unavailable');
    assert.equal(missingCal.totalCostStatus, 'unavailable');
    assert.equal(missingCal.totalCost, null);

    const missingYield = calculateToner({
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      method: 'rated_yield',
      impressions: { printedSideImpressions: 500 },
      channels: { K: uncalibratedNoMass },
    });
    assert.equal(missingYield.totalCostStatus, 'unavailable');

    const unvalidatedCov = calculateToner({
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      method: 'coverage_based',
      impressions: { printedSideImpressions: 1500 },
      channels: { K: { ...FIXTURE_TONER_K_CAL, cartridgeTonerMassGrams: 500 } },
      coverageUniform: { evidenceStatus: 'unvalidated', coveragePct: 10 },
    });
    assert.equal(unvalidatedCov.totalCostStatus, 'provisional');
    assert.equal(unvalidatedCov.totalMassStatus, 'provisional');

    const missingCov = calculateToner({
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      method: 'coverage_based',
      impressions: { printedSideImpressions: 1500 },
      channels: { K: FIXTURE_TONER_K_CAL },
    });
    assert.equal(missingCov.totalCostStatus, 'unavailable');
    return 'All missing/unvalidated evidence cases classified without invented defaults';
  });

  // 14. Counter reset & mid-run cartridge replacement + meter mass rejection
  await runTest('TonerEngine', '14. Meter counter reset, fractional cartridge replacement & meter-only mass rejection', () => {
    assert.throws(
      () =>
        evaluateMachineMeterAndCartridges({
          machine: FIXTURE_MONO_COPIER,
          startMeter: 999200,
          endMeter: 450,
          resetEvent: null,
        }),
      (e: unknown) => e instanceof TonerCalculationError && e.code === 'INVALID_METER_READING'
    );

    const meterRes = evaluateMachineMeterAndCartridges({
      machine: FIXTURE_MONO_COPIER,
      startMeter: 999200,
      endMeter: 450,
      resetEvent: { meterBeforeReset: 1000000, meterAfterReset: 0, reason: '1M rollover' },
      cartridgeSegments: [
        {
          cartridgeId: 'CART-K-OLD',
          channel: 'K',
          cartridgeCost: 150,
          ratedYieldImpressions: 15000,
          impressionsUsedOnCartridge: 800,
          installedDuringRun: false,
        },
        {
          cartridgeId: 'CART-K-NEW',
          channel: 'K',
          cartridgeCost: 150,
          ratedYieldImpressions: 15000,
          impressionsUsedOnCartridge: 450,
          installedDuringRun: true,
        },
      ],
    });

    assert.equal(meterRes.totalMeterImpressions, 1250);
    assert.equal(meterRes.resetApplied, true);
    assert.equal(meterRes.meterProvesPhysicalTonerMass, false);
    assert.equal(meterRes.physicalTonerMassStatus, 'unavailable');

    const newCart = meterRes.cartridgeCharges[1];
    assert.equal(newCart.installedDuringRun, true);
    assert.equal(newCart.chargedFullCartridge, false);
    assert.equal(newCart.allocatedCost, 4.5); // (450 / 15000) * 150 = K4.50, NEVER K150.00!
    assert.equal(newCart.remainingYieldImpressions, 14550);
    assert.equal(meterRes.totalAllocatedCartridgeCost, 12.5); // 8.00 + 4.50
    return `meter=${meterRes.totalMeterImpressions}imp, newCartridgeCharge=K${newCart.allocatedCost} (NOT K150)`;
  });

  // 15. Typing fee separation in Type and Printing
  await runTest('Workflows', '15. Type and Printing separates configurable typing fee from physical printing consumption', () => {
    const flatJob = calculateTypeAndPrintingWorkflow({
      paperStock: FIXTURE_A4_BOND,
      tonerChannels: { K: FIXTURE_TONER_K_CAL },
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      copies: 10,
      mode: 'duplex',
      pages: 5, // 30 sheets, 50 printed impressions
      typingFee: { mode: 'flat', rate: 25 },
      extraFinishingCost: 5,
      commercialPricing: { sellingPrice: 80 },
    });
    assert.equal(flatJob.typingFee.amount, 25);
    assert.equal(flatJob.paper.quantities.totalSheets, 30);
    assert.equal(flatJob.commercial.materialPaperCost, 2.7); // 30 * 0.09
    assert.equal(flatJob.commercial.materialTonerCost, 0.48); // 50 * 0.032 * (150/500) = 1.6g * 0.3 = 0.48
    assert.equal(flatJob.commercial.totalProductionCost, 33.18); // 2.70 + 0.48 + 5 + 25

    const perPageJob = calculateTypeAndPrintingWorkflow({
      paperStock: FIXTURE_A4_BOND,
      tonerChannels: { K: FIXTURE_TONER_K_CAL },
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      copies: 10,
      mode: 'duplex',
      pages: 5,
      typingFee: { mode: 'per_page', rate: 6, typedPages: 5 },
      commercialPricing: { sellingPrice: 80 },
    });
    assert.equal(perPageJob.typingFee.amount, 30);
    // Physical paper & toner remain identical regardless of typing fee mode!
    assert.equal(perPageJob.paper.quantities.totalSheets, flatJob.paper.quantities.totalSheets);
    assert.equal(perPageJob.toner.totalMassGrams, flatJob.toner.totalMassGrams);
    return `flatTyping=K${flatJob.typingFee.amount}, perPageTyping=K${perPageJob.typingFee.amount}, paper=30sht`;
  });

  // 16. Contract pricing / discount / selling rate independence across workflows
  await runTest('Workflows', '16. Contract prices, discounts & selling rates never alter physical paper or toner mass', () => {
    const fullRateContract = calculateExaminationContractWorkflow({
      agreedAssessmentAmount: 50000,
      discountAmount: 0,
      subjects: [
        {
          subjectName: 'Mathematics',
          className: 'Form 1',
          assessmentName: 'Term 2',
          learnersCount: 180,
          pricePerLearner: 15,
          pages: 7,
          copies: 180,
          mode: 'duplex',
          paperStock: FIXTURE_A4_BOND,
          tonerChannels: { K: FIXTURE_TONER_K_CAL },
          machine: FIXTURE_MONO_COPIER,
          colorMode: 'mono',
        },
      ],
    });

    const heavilyDiscountedContract = calculateExaminationContractWorkflow({
      agreedAssessmentAmount: 12000,
      discountAmount: 4000,
      subjects: [
        {
          subjectName: 'Mathematics',
          className: 'Form 1',
          assessmentName: 'Term 2',
          learnersCount: 180,
          pricePerLearner: 5,
          pages: 7,
          copies: 180,
          mode: 'duplex',
          paperStock: FIXTURE_A4_BOND,
          tonerChannels: { K: FIXTURE_TONER_K_CAL },
          machine: FIXTURE_MONO_COPIER,
          colorMode: 'mono',
        },
      ],
    });

    assert.equal(
      fullRateContract.production.totals.totalSheets,
      heavilyDiscountedContract.production.totals.totalSheets
    );
    assert.equal(
      fullRateContract.production.totals.totalImpressions,
      heavilyDiscountedContract.production.totals.totalImpressions
    );
    assert.equal(
      fullRateContract.production.papers[0].toner.totalMassGrams,
      heavilyDiscountedContract.production.papers[0].toner.totalMassGrams
    );
    assert.notEqual(
      fullRateContract.assessmentProfit,
      heavilyDiscountedContract.assessmentProfit
    );

    const bookHigh = calculateBookPrintingWorkflow({
      paper: {
        copies: 200,
        text: { stock: FIXTURE_SRA3_TEXT, pages: 80, copies: 200, trimWidthMm: 148, trimHeightMm: 210, duplex: true, marginsMm: { top: 5, bottom: 5, left: 5, right: 5 } },
        cover: { stock: FIXTURE_SRA3_COVER, bleedMm: 2, marginsMm: { top: 5, bottom: 5, left: 5, right: 5 } },
      },
      toner: { machine: FIXTURE_MONO_COPIER, colorMode: 'mono', method: 'calibrated', channels: { K: FIXTURE_TONER_K_CAL } },
      commercialPricing: { sellingPrice: 12000, discountAmount: 0 },
    });
    const bookPromo = calculateBookPrintingWorkflow({
      paper: {
        copies: 200,
        text: { stock: FIXTURE_SRA3_TEXT, pages: 80, copies: 200, trimWidthMm: 148, trimHeightMm: 210, duplex: true, marginsMm: { top: 5, bottom: 5, left: 5, right: 5 } },
        cover: { stock: FIXTURE_SRA3_COVER, bleedMm: 2, marginsMm: { top: 5, bottom: 5, left: 5, right: 5 } },
      },
      toner: { machine: FIXTURE_MONO_COPIER, colorMode: 'mono', method: 'calibrated', channels: { K: FIXTURE_TONER_K_CAL } },
      commercialPricing: { sellingPrice: 12000, discountAmount: 3500, promotionAmount: 1000 },
    });
    assert.equal(bookHigh.paper.totals.totalSheets, bookPromo.paper.totals.totalSheets);
    assert.equal(bookHigh.toner.totalMassGrams, bookPromo.toner.totalMassGrams);

    const ctr = calculatePrintingContractWorkflow({
      paperStock: FIXTURE_A4_BOND,
      tonerChannels: { K: FIXTURE_TONER_K_CAL },
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      copies: 50,
      mode: 'duplex',
      pages: 4,
      agreedAmount: 500,
      discountAmount: 100,
    });
    assert.equal(ctr.paper.quantities.totalSheets, 100);

    const svc = calculatePrintingServiceWorkflow({
      paperStock: FIXTURE_A4_BOND,
      tonerChannels: { K: FIXTURE_TONER_K_CAL },
      machine: FIXTURE_MONO_COPIER,
      colorMode: 'mono',
      copies: 50,
      mode: 'duplex',
      pages: 4,
      commercialPricing: { sellingPrice: 300 },
    });
    assert.equal(svc.paper.quantities.totalSheets, ctr.paper.quantities.totalSheets);

    return 'All workflows keep physical paper/toner strictly invariant under pricing & discount changes';
  });

  // 17. DB lookup integration + Duplicate inventory consumption / GL protection check
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-print-test-'));
  const cfg = { ...loadServerConfig(), nodeEnv: 'test', isProduction: false, attachmentsDir: tmpDir };
  const db: ServerDatabase = await createServerDatabase(cfg, { inMemory: true, seedDemo: true });

  try {
    await runTest('Integration', '17. PostgreSQL lookup + single BOM deduction & single GL posting on invoice creation', async () => {
      const ids = await db.withSystemDb(async tx => {
        const compRes = await tx.query<{ id: number }>(`SELECT id FROM companies ORDER BY id ASC LIMIT 1`);
        const companyId = Number(compRes.rows[0].id);
        const memRes = await tx.query<{ user_id: number }>(
          `SELECT user_id FROM company_memberships WHERE company_id = $1 AND role = 'Administrator' LIMIT 1`,
          [companyId]
        );
        return { companyId, userId: Number(memRes.rows[0].user_id) };
      });

      const { companyId, userId } = ids;
      const txResult = await db.withCompanyDb(companyId, async tx => {
        await tx.query(`SELECT set_config('app.current_user_id', $1, TRUE)`, [String(userId)]);

        // Resolve seeded accounts cleanly
        const acctRes = await tx.query<{ id: number; account_type: string }>(
          `SELECT id, account_type FROM accounts WHERE company_id = $1 AND is_active = TRUE ORDER BY id ASC`,
          [companyId]
        );
        const firstByType = (t: string) => Number(acctRes.rows.find(a => a.account_type === t)!.id);
        const bankId = firstByType('Bank');
        const arId = firstByType('AccountsReceivable');
        const invId = firstByType('Inventory');
        const revId = firstByType('Income');
        const cogsId = firstByType('CostOfGoodsSold');

        // Paper spec, machine, raw paper & raw toner
        const ps = await tx.query<{ id: number }>(
          `INSERT INTO paper_specifications (company_id, spec_code, name, size_code, width_mm, height_mm, gsm, finish, grain_direction, sheets_per_ream)
           VALUES ($1, 'PS-A4-80', 'A4 80gsm Bond', 'A4', 210.00, 297.00, 80, 'uncoated', 'long', 500) RETURNING id`,
          [companyId]
        );
        const paperSpecId = Number(ps.rows[0].id);

        const rawPaper = await tx.query<{ id: number }>(
          `INSERT INTO inventory_items (company_id, sku, name, item_type, unit_cost, avg_cost, sales_price, on_hand, purchase_unit, usage_unit, conversion_factor, paper_spec_id, asset_account_id, cogs_account_id, income_account_id)
           VALUES ($1, 'RM-A4', 'A4 Bond Paper', 'raw_material', 50.000000, 50.000000, 0.0000, 10.000000, 'Ream', 'Sheet', 500.000000, $2, $3, $4, $5) RETURNING id`,
          [companyId, paperSpecId, invId, cogsId, revId]
        );
        const rawPaperId = Number(rawPaper.rows[0].id);

        const rawToner = await tx.query<{ id: number }>(
          `INSERT INTO inventory_items (company_id, sku, name, item_type, unit_cost, avg_cost, sales_price, on_hand, purchase_unit, usage_unit, conversion_factor, asset_account_id, cogs_account_id, income_account_id)
           VALUES ($1, 'RM-TONER-K', 'Black Press Toner', 'raw_material', 150.000000, 150.000000, 0.0000, 4.000000, 'Cartridge', 'Impression', 15000.000000, $2, $3, $4) RETURNING id`,
          [companyId, invId, cogsId, revId]
        );
        const rawTonerId = Number(rawToner.rows[0].id);

        await tx.query(
          `INSERT INTO material_specifications (company_id, inventory_item_id, material_category, yield_per_purchase_unit, coverage_basis_pct, color_channel)
           VALUES ($1, $2, 'toner', 15000.0000, 5.0000, 'K')`,
          [companyId, rawTonerId]
        );

        const mach = await tx.query<{ id: number }>(
          `INSERT INTO printing_machines (company_id, machine_code, name, machine_type, supports_duplex, max_paper_size, status)
           VALUES ($1, 'PRESS-1', 'Canon VarioPrint', 'digital_press', TRUE, 'A3', 'active') RETURNING id`,
          [companyId]
        );
        const machineId = Number(mach.rows[0].id);

        // Lookup directly from DB via paperCalc & tonerCalc
        const dbPaperStock = await lookupPaperStockFromDb(tx, companyId, rawPaperId);
        assert.equal(dbPaperStock.widthMm, 210);
        assert.equal(dbPaperStock.sheetsPerReam, 500);
        assert.equal(dbPaperStock.measuredCaliperMm, null); // Schema does not invent caliper

        const dbToner = await lookupTonerAndMachineFromDb(tx, companyId, {
          machineId,
          tonerItemIds: { K: rawTonerId },
        });
        assert.equal(dbToner.channels.K?.calibration, null); // Schema does not invent calibration

        // Run shared calculation against DB records (1000 sheets duplex = 2000 impressions)
        const wf = calculatePhotocopyWorkflow({
          paperStock: dbPaperStock,
          tonerChannels: dbToner.channels,
          machine: dbToner.machine,
          colorMode: 'mono',
          tonerMethod: 'auto',
          copies: 100,
          mode: 'duplex',
          pages: 10, // 5 sheets/copy = 500 sheets (1 ream = K50), 1000 imp (1/15 cartridge = K10)
          commercialPricing: { sellingPrice: 200 },
        });
        assert.equal(wf.paper.quantities.totalSheets, 500);
        assert.equal(wf.paper.quantities.totalPaperCost, 50);
        assert.equal(wf.toner.totalCost, 10);
        assert.equal(wf.toner.totalMassStatus, 'unavailable'); // DB has no calibration grams column

        // Now create a Printed Product with a 1-ream (500-sheet) + 1000-imp BOM and invoice it ONCE
        const prod = await tx.query<{ id: number }>(
          `INSERT INTO inventory_items (company_id, sku, name, item_type, unit_cost, avg_cost, sales_price, on_hand, asset_account_id, cogs_account_id, income_account_id)
           VALUES ($1, 'PRT-EXAM-PACK', 'Printed Exam Pack', 'printed_product', 60.000000, 60.000000, 200.0000, 0.000000, $2, $3, $4) RETURNING id`,
          [companyId, invId, cogsId, revId]
        );
        const prodId = Number(prod.rows[0].id);
        await tx.query(
          `INSERT INTO item_bom_components (company_id, parent_item_id, raw_material_item_id, quantity_per_unit)
           VALUES ($1, $2, $3, 500.000000), ($1, $2, $4, 1000.000000)`,
          [companyId, prodId, rawPaperId, rawTonerId]
        );

        const actor: ActorContext = {
          userId,
          username: 'admin',
          role: 'Administrator',
        };
        const cust = await createCustomer(tx, companyId, actor, {
          name: 'Dr. Test Bursar',
          companyName: 'Test Secondary School',
          customerType: 'school',
        });

        // Snapshot baseline movement & journal counts on seeded company before invoicing
        const preMovRes = await tx.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM inventory_movements WHERE company_id = $1`,
          [companyId]
        );
        const preMovCount = Number(preMovRes.rows[0].cnt);

        const preJeRes = await tx.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM journal_transactions WHERE company_id = $1`,
          [companyId]
        );
        const preJeCount = Number(preJeRes.rows[0].cnt);

        const { invoice: inv } = await createInvoiceOrSalesReceipt(tx, companyId, actor, {
          customerId: cust.id,
          invoiceDate: '2026-06-01',
          dueDate: '2026-07-01',
          lines: [{ itemId: prodId, description: 'Exam Pack Run', quantity: 1, rate: 200, taxable: false }],
        });

        // Verify raw paper deducted ONCE (10 -> 9 reams), toner deducted ONCE, and only 1 new GL journal posted
        const afterPaper = await tx.query<{ on_hand: string }>(
          `SELECT on_hand::text FROM inventory_items WHERE company_id = $1 AND id = $2`,
          [companyId, rawPaperId]
        );
        assert.equal(Number(afterPaper.rows[0].on_hand), 9);

        const movs = await tx.query<{ item_id: number; movement_type: string }>(
          `SELECT item_id, movement_type FROM inventory_movements WHERE company_id = $1 AND source_type = 'invoice' AND source_id = $2 ORDER BY id ASC`,
          [companyId, inv.id]
        );
        assert.equal(movs.rows.length, 2); // exactly 1 movement per BOM raw material, zero duplicates
        assert.equal(movs.rows[0].movement_type, 'production_consume');

        const postMovRes = await tx.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM inventory_movements WHERE company_id = $1`,
          [companyId]
        );
        assert.equal(Number(postMovRes.rows[0].cnt) - preMovCount, 2);

        const postJeRes = await tx.query<{ id: number }>(
          `SELECT id FROM journal_transactions WHERE company_id = $1 ORDER BY id DESC`,
          [companyId]
        );
        assert.equal(postJeRes.rows.length - preJeCount, 1);

        const jLines = await tx.query<{ account_id: number; debit: string; credit: string }>(
          `SELECT account_id, debit::text, credit::text FROM journal_lines WHERE transaction_id = $1`,
          [postJeRes.rows[0].id]
        );
        const totalDr = jLines.rows.reduce((s, l) => s + Number(l.debit), 0);
        const totalCr = jLines.rows.reduce((s, l) => s + Number(l.credit), 0);
        assert.equal(totalDr, totalCr);
        assert.ok(inv.id > 0 && bankId > 0 && arId > 0);
        return `DB lookup verified, single BOM deduction (10->9 reams), 1 balanced GL journal (Dr/Cr=${totalDr})`;
      });
      return txResult;
    });

    await runTest('Integration', '18. Duplex vs Single-Sided per-sheet toner, per-page extra finishing cost & per-sheet manual selling price', async () => {
      // A. Equal sheet comparison: 100 sheets Duplex (2 pages/sheet = 200 impressions) vs 100 sheets Single-Sided (1 page/sheet = 100 impressions)
      const duplex100Sheets = calculatePhotocopyWorkflow({
        paperStock: FIXTURE_A4_BOND,
        tonerChannels: { K: FIXTURE_TONER_K_CAL },
        machine: FIXTURE_MONO_COPIER,
        colorMode: 'mono',
        tonerMethod: 'rated_yield',
        copies: 100,
        mode: 'duplex',
        pages: 2, // 1 sheet/copy * 100 copies = 100 sheets, 2 sides/sheet = 200 impressions
      });
      const simplex100Sheets = calculatePhotocopyWorkflow({
        paperStock: FIXTURE_A4_BOND,
        tonerChannels: { K: FIXTURE_TONER_K_CAL },
        machine: FIXTURE_MONO_COPIER,
        colorMode: 'mono',
        tonerMethod: 'rated_yield',
        copies: 100,
        mode: 'simplex',
        pages: 1, // 1 sheet/copy * 100 copies = 100 sheets, 1 side/sheet = 100 impressions
      });
      assert.equal(duplex100Sheets.paper.quantities.totalSheets, 100);
      assert.equal(simplex100Sheets.paper.quantities.totalSheets, 100);
      assert.equal(duplex100Sheets.paper.quantities.printedSideImpressions, 200); // 2 sides/sheet
      assert.equal(simplex100Sheets.paper.quantities.printedSideImpressions, 100); // 1 side/sheet
      assert.equal(duplex100Sheets.toner.totalCost, 2); // 200 * 0.01 = K2.00 (K0.02/sheet)
      assert.equal(simplex100Sheets.toner.totalCost, 1); // 100 * 0.01 = K1.00 (K0.01/sheet)

      // B. Backend createPrintingJob: per-page finishingCostPerPage & per-sheet manualSellingPricePerSheet
      const ids = await db.withSystemDb(async tx => {
        const compRes = await tx.query<{ id: number }>(`SELECT id FROM companies ORDER BY id ASC LIMIT 1`);
        const companyId = Number(compRes.rows[0].id);
        const memRes = await tx.query<{ user_id: number }>(
          `SELECT user_id FROM company_memberships WHERE company_id = $1 AND role = 'Administrator' LIMIT 1`,
          [companyId]
        );
        return { companyId, userId: Number(memRes.rows[0].user_id) };
      });
      const actor: ActorContext = { userId: ids.userId, username: 'admin', role: 'Administrator' };

      const jobRes = await db.withCompanyDb(ids.companyId, async tx => {
        await tx.query(`SELECT set_config('app.current_user_id', $1, TRUE)`, [String(ids.userId)]);
        const acctRes = await tx.query<{ id: number; account_type: string }>(
          `SELECT id, account_type FROM accounts WHERE company_id = $1 AND is_active = TRUE ORDER BY id ASC`,
          [ids.companyId]
        );
        const firstByType = (t: string) => Number(acctRes.rows.find(a => a.account_type === t)!.id);
        const invId = firstByType('Inventory');
        const revId = firstByType('Income');
        const cogsId = firstByType('CostOfGoodsSold');

        const paperRes = await tx.query<{ id: number }>(
          `INSERT INTO inventory_items (company_id, sku, name, item_type, unit_cost, avg_cost, sales_price, on_hand, purchase_unit, usage_unit, conversion_factor, asset_account_id, cogs_account_id, income_account_id)
           VALUES ($1, 'RM-A4-QP', 'A4 Bond QP', 'raw_material', 45.000000, 45.000000, 0.0000, 20.000000, 'Ream', 'Sheet', 500.000000, $2, $3, $4) RETURNING id`,
          [ids.companyId, invId, cogsId, revId]
        );
        const tonerRes = await tx.query<{ id: number }>(
          `INSERT INTO inventory_items (company_id, sku, name, item_type, unit_cost, avg_cost, sales_price, on_hand, purchase_unit, usage_unit, conversion_factor, asset_account_id, cogs_account_id, income_account_id)
           VALUES ($1, 'RM-TON-QP', 'Black Toner QP', 'raw_material', 150.000000, 150.000000, 0.0000, 5.000000, 'Cartridge', 'Impression', 15000.000000, $2, $3, $4) RETURNING id`,
          [ids.companyId, invId, cogsId, revId]
        );

        const created = await createPrintingJob(tx, ids.companyId, actor, {
          jobType: 'quick_photocopy',
          title: '10pp Duplex x25 Per-Sheet Price & Per-Page Extra',
          pages: 10,
          copies: 25,
          printSide: 'Duplex',
          rawPaperItemId: Number(paperRes.rows[0].id),
          rawTonerItemId: Number(tonerRes.rows[0].id),
          finishingCostPerPage: 2.0, // 10 pages * K2.00/page = K20.00
          manualSellingPricePerSheet: 1.5, // 125 sheets * K1.50/sheet = K187.50
        });
        assert.equal(created.job.sheetsUsed, 125);
        assert.equal(created.job.impressionsUsed, 250);
        assert.equal(created.job.paperCost, 11.25);
        assert.equal(created.job.tonerCost, 2.5);
        assert.equal(created.job.extraCost, 20);
        assert.equal(created.job.totalCost, 33.75);
        assert.equal(created.job.manualSellingPrice, 187.5);
        assert.equal(created.job.profit, 153.75);
        return created.job;
      });

      // C. Document preview / invoice mapper uses sheetsUsed * sellingPricePerSheet
      const preview = mapQuickPrintToPreviewModel({
        job: {
          id: 'qp-test',
          jobNumber: 'QPR-TEST-1',
          customerName: 'Test Walk-In',
          jobType: 'quick_photocopy',
          title: 'Test Duplex Run',
          pages: 10,
          copies: 25,
          printSide: 'Duplex',
          rawPaperItemId: 'item-raw-1',
          rawTonerItemId: 'item-raw-2',
          sheetsUsed: 125,
          impressionsUsed: 250,
          paperCost: 11.25,
          tonerCost: 2.5,
          extraCostPerPage: 2,
          extraCost: 20,
          totalCost: 33.75,
          sellingPricePerSheet: 1.5,
          sellingPriceTotal: 187.5,
          profit: 153.75,
          date: '2026-11-16',
        },
        companyProfile: {
          name: 'Test Press',
          legalName: 'Test Press Ltd',
          ein: '123',
          currency: 'K',
          address: '',
          cityStateZip: '',
          phone: '',
          email: '',
          website: '',
          fiscalYearStartMonth: 1,
          accountingMethod: 'accrual',
          defaultBankAccountId: 'acc-1010',
          salesTaxRate: 0,
          theme: 'classic',
          isServerEdition: false,
          serverAddress: '',
          currentUserRole: 'Administrator',
        },
      });
      assert.equal(preview.lines[0].quantity, 125);
      assert.equal(preview.lines[0].rate, 1.5);
      assert.equal(preview.lines[0].amount, 187.5);
      assert.equal(preview.totals.total, 187.5);

      return `duplex100sht=200imp/K2.00, simplex100sht=100imp/K1.00, 125sht*K1.50=K${jobRes.manualSellingPrice}, 10pp*K2.00=K${jobRes.extraCost}`;
    });
  } finally {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.length - passedCount;
  console.log(`\nSummary: ${passedCount}/${results.length} passed, ${failedCount} failed.`);
  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
