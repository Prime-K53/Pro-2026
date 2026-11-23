/**
 * Unit tests for the shared quick-print estimate engine (desk / POS / invoice).
 *
 * Proves the frontend calculator and the server agree on the revenue contract:
 *  - typing & printing is revenue, never material cost;
 *  - the per-page extra charge is priced per page, not per impression/copy;
 *  - physical finishing stays a cost.
 */
import assert from 'node:assert/strict';
import { computeQuickPrintEstimate } from '../../src/utils/quickPrintCalc.ts';
import { mapQuickPrintToPreviewModel } from '../../src/types/documents.ts';
import type { QuickPrintJob } from '../../src/types/accounting.ts';
import type { CompanyProfile } from '../../src/types/accounting.ts';

const results: Array<{ name: string; passed: boolean; detail: string }> = [];

function runTest(group: string, name: string, fn: () => string) {
  try {
    const detail = fn();
    results.push({ name: `${group} :: ${name}`, passed: true, detail });
    console.log(`  [PASS] (${group}) ${name} — ${detail}`);
  } catch (err: any) {
    results.push({ name: `${group} :: ${name}`, passed: false, detail: err?.message ?? String(err) });
    console.error(`  [FAIL] (${group}) ${name} — ${err?.message ?? err}`);
  }
}

const PAPER_UNIT = 30; // K per sheet
const TONER_UNIT = 5; // K per impression

runTest('CalcEngine', '1. Acceptance example reconciles exactly (typing revenue + photocopy revenue)', () => {
  const est = computeQuickPrintEstimate({
    jobType: 'type_and_printing',
    pages: 2,
    copies: 3,
    printSide: 'Duplex',
    paperUsageUnitCost: PAPER_UNIT,
    tonerUsageUnitCost: TONER_UNIT,
    extraCostPerPage: 1000,
    sellingPricePerSheet: 150,
  });
  assert.equal(est.sheetsUsed, 3); // ceil(2/2) * 3
  assert.equal(est.impressionsUsed, 6); // 2 * 3
  assert.equal(est.paperCost, 90);
  assert.equal(est.tonerCost, 30);
  assert.equal(est.finishingCost, 0);
  assert.equal(est.totalCost, 120);
  assert.equal(est.typingRevenue, 2000);
  assert.equal(est.photocopyRevenue, 450);
  assert.equal(est.sellingPriceTotal, 2450);
  assert.equal(est.realProfit, 2330);
  return `selling=${est.sellingPriceTotal}, cost=${est.totalCost}, profit=${est.realProfit}`;
});

runTest('CalcEngine', '2. Typing is per page, not per impression or per copy', () => {
  const est = computeQuickPrintEstimate({
    jobType: 'type_and_printing',
    pages: 2,
    copies: 10,
    printSide: 'Duplex',
    paperUsageUnitCost: PAPER_UNIT,
    tonerUsageUnitCost: TONER_UNIT,
    extraCostPerPage: 1000,
    sellingPricePerSheet: 150,
  });
  // 2 pages x 10 copies = 10 sheets, 20 impressions
  assert.equal(est.sheetsUsed, 10);
  assert.equal(est.impressionsUsed, 20);
  assert.equal(est.extraCostTotal, 2000); // 1000 * 2 pages, NOT 1000 * 20 impressions
  assert.equal(est.typingRevenue, 2000);
  assert.equal(est.photocopyRevenue, 1500); // 150 * 10
  assert.equal(est.sellingPriceTotal, 3500);
  return `typing=${est.typingRevenue} (not ${1000 * 20})`;
});

runTest('CalcEngine', '3. Photocopy-only job carries no typing revenue', () => {
  const est = computeQuickPrintEstimate({
    jobType: 'quick_photocopy',
    pages: 2,
    copies: 3,
    printSide: 'Duplex',
    paperUsageUnitCost: PAPER_UNIT,
    tonerUsageUnitCost: TONER_UNIT,
    sellingPricePerSheet: 150,
  });
  assert.equal(est.typingRevenue, 0);
  assert.equal(est.photocopyRevenue, 450);
  assert.equal(est.sellingPriceTotal, 450);
  assert.equal(est.totalCost, 120);
  assert.equal(est.realProfit, 330);
  return `selling=${est.sellingPriceTotal}, profit=${est.realProfit}`;
});

runTest('CalcEngine', '4. Physical finishing stays a cost for quick_photocopy', () => {
  const est = computeQuickPrintEstimate({
    jobType: 'quick_photocopy',
    pages: 2,
    copies: 3,
    printSide: 'Duplex',
    paperUsageUnitCost: PAPER_UNIT,
    tonerUsageUnitCost: TONER_UNIT,
    extraCostPerPage: 2,
    sellingPricePerSheet: 150,
  });
  assert.equal(est.finishingCost, 4); // 2 * 2 pages
  assert.equal(est.typingRevenue, 0);
  assert.equal(est.totalCost, 124); // 120 + 4 finishing
  assert.equal(est.sellingPriceTotal, 450); // finishing is NOT added to the selling price
  assert.equal(est.realProfit, 326);
  return `finishing=${est.finishingCost} in cost, selling=${est.sellingPriceTotal}`;
});

runTest('CalcEngine', '5. Duplex vs simplex sheet count is independent of typing', () => {
  const duplex = computeQuickPrintEstimate({
    jobType: 'type_and_printing',
    pages: 5,
    copies: 4,
    printSide: 'Duplex',
    paperUsageUnitCost: PAPER_UNIT,
    tonerUsageUnitCost: TONER_UNIT,
    extraCostPerPage: 100,
    sellingPricePerSheet: 10,
  });
  const simplex = computeQuickPrintEstimate({
    jobType: 'type_and_printing',
    pages: 5,
    copies: 4,
    printSide: 'Single-Sided',
    paperUsageUnitCost: PAPER_UNIT,
    tonerUsageUnitCost: TONER_UNIT,
    extraCostPerPage: 100,
    sellingPricePerSheet: 10,
  });
  // duplex: ceil(5/2)=3 sheets/copy * 4 = 12 sheets, 20 impressions
  assert.equal(duplex.sheetsUsed, 12);
  assert.equal(duplex.impressionsUsed, 20);
  // simplex: 5 sheets/copy * 4 = 20 sheets, 20 impressions
  assert.equal(simplex.sheetsUsed, 20);
  assert.equal(simplex.impressionsUsed, 20);
  // typing is per page and identical for both
  assert.equal(duplex.typingRevenue, 500);
  assert.equal(simplex.typingRevenue, 500);
  // photocopy differs by sheet count
  assert.equal(duplex.photocopyRevenue, 120);
  assert.equal(simplex.photocopyRevenue, 200);
  return `duplex=${duplex.sheetsUsed}sht/${duplex.photocopyRevenue}, simplex=${simplex.sheetsUsed}sht/${simplex.photocopyRevenue}`;
});

runTest('ReceiptMapper', '6. Two-line receipt splits typing and photocopy without double charging', () => {
  const job = {
    id: 'qp-test',
    jobNumber: 'QPR-2026-TEST',
    jobType: 'type_and_printing',
    date: '2026-11-22',
    customerName: 'Walk-In',
    rawPaperItemId: 'paper',
    rawTonerItemId: 'toner',
    title: 'Typed & copied',
    pages: 2,
    copies: 3,
    printSide: 'Duplex',
    sheetsUsed: 3,
    impressionsUsed: 6,
    paperCost: 90,
    tonerCost: 30,
    typingFee: 2000,
    extraCost: 0,
    totalCost: 120,
    sellingPricePerSheet: 150,
    sellingPriceTotal: 2450,
    profit: 2330,
  } as unknown as QuickPrintJob;

  const preview = mapQuickPrintToPreviewModel({
    job,
    companyProfile: { currency: 'K' } as CompanyProfile,
  });

  assert.equal(preview.lines.length, 2, 'receipt must show two lines');
  const typingLine = preview.lines.find(l => /Typing/i.test(l.description));
  const copyLine = preview.lines.find(l => /Photocopying/i.test(l.description));
  assert.ok(typingLine, 'typing line present');
  assert.ok(copyLine, 'photocopy line present');
  assert.equal(typingLine!.amount, 2000, 'typing line amount');
  assert.equal(copyLine!.amount, 450, 'photocopy line amount');
  assert.equal(typingLine!.amount + copyLine!.amount, 2450, 'lines sum to selling price');
  assert.equal(preview.totals.total, 2450, 'receipt total');
  assert.equal(preview.totals.totalCost, 120, 'receipt material cost');
  assert.equal(preview.totals.grossProfit, 2330, 'receipt gross profit');

  const genLines = preview.generateInvoiceInput?.lines ?? [];
  assert.equal(genLines.length, 2, 'invoice payload must also split into two lines');
  const genTotal = genLines.reduce((s, l) => s + l.quantity * l.rate, 0);
  assert.equal(genTotal, 2450, 'invoice lines sum to selling price (no double count)');
  return `typing=${typingLine!.amount} + photocopy=${copyLine!.amount} = ${preview.totals.total}`;
});

runTest('ReceiptMapper', '7. Photocopy-only receipt stays a single line', () => {
  const job = {
    id: 'qp-test-2',
    jobNumber: 'QPR-2026-TEST2',
    jobType: 'quick_photocopy',
    date: '2026-11-22',
    customerName: 'Walk-In',
    rawPaperItemId: 'paper',
    rawTonerItemId: 'toner',
    title: 'Copied',
    pages: 2,
    copies: 3,
    printSide: 'Duplex',
    sheetsUsed: 3,
    impressionsUsed: 6,
    paperCost: 90,
    tonerCost: 30,
    typingFee: 0,
    extraCost: 0,
    totalCost: 120,
    sellingPricePerSheet: 150,
    sellingPriceTotal: 450,
    profit: 330,
  } as unknown as QuickPrintJob;

  const preview = mapQuickPrintToPreviewModel({
    job,
    companyProfile: { currency: 'K' } as CompanyProfile,
  });
  assert.equal(preview.lines.length, 1, 'single line for photocopy-only');
  assert.equal(preview.totals.total, 450, 'receipt total');
  return `lines=${preview.lines.length}, total=${preview.totals.total}`;
});

const passed = results.filter(r => r.passed).length;
const failed = results.length - passed;
console.log(`\nSummary: ${passed}/${results.length} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);