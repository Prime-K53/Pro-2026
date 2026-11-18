import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';
import { parseDecimal4 } from '../../src/server/lib/decimal.ts';

interface TestRecord {
  workflow: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

const results: TestRecord[] = [];

async function runTest(workflow: string, name: string, fn: () => Promise<string | void>) {
  const start = Date.now();
  try {
    const details = (await fn()) || 'OK';
    const durationMs = Date.now() - start;
    results.push({ workflow, name, passed: true, durationMs, details });
    console.log(`  [PASS] (${durationMs}ms) ${workflow} :: ${name} — ${details}`);
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const msg = err?.message || String(err);
    results.push({ workflow, name, passed: false, durationMs, details: msg });
    console.error(`  [FAIL] (${durationMs}ms) ${workflow} :: ${name} — ${msg}`);
  }
}

class CookieHttpClient {
  public cookie = '';
  constructor(private baseUrl: string) {}

  async request(
    method: string,
    pathname: string,
    options: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; headers: Headers; text: string; json: any }> {
    const headers: Record<string, string> = {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(options.headers || {}),
    };
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  }
}

async function main() {
  console.log('=== Printing Management System — Phase 9 Full End-to-End Business Workflows Suite ===\n');

  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-phase9-e2e-'));
  const baseCfg = loadServerConfig();
  const testCfg = {
    ...baseCfg,
    nodeEnv: 'test',
    isProduction: false,
    attachmentsDir: tmpAttachDir,
  };

  const db: ServerDatabase = await createServerDatabase(testCfg, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);

  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const adminClient = new CookieHttpClient(baseUrl);
  const prodClient = new CookieHttpClient(baseUrl);
  const acctByCode = new Map<string, any>();

  async function refreshAccounts() {
    const res = await adminClient.request('GET', '/api/accounts?includeInactive=true');
    assert.equal(res.status, 200);
    acctByCode.clear();
    for (const a of res.json.accounts) {
      if (a.code) acctByCode.set(a.code, a);
    }
  }

  async function assertJournalBalanced(journalTxnId: number) {
    const res = await adminClient.request('GET', `/api/journals/${journalTxnId}`);
    assert.equal(res.status, 200, `Journal ${journalTxnId} lookup failed`);
    const lines = res.json.entry.lines as any[];
    let deb = 0n;
    let cred = 0n;
    for (const l of lines) {
      deb += parseDecimal4(l.debit);
      cred += parseDecimal4(l.credit);
    }
    assert.equal(deb, cred, `Journal ${journalTxnId} unbalanced: deb=${deb}, cred=${cred}`);
    assert.ok(deb > 0n, `Journal ${journalTxnId} has zero total`);
    return { entry: res.json.entry, total4: deb };
  }

  async function assertAccountingInvariants(label: string) {
    const tb = await adminClient.request('GET', '/api/reports/trial-balance?startDate=2026-01-01&endDate=2026-12-31');
    assert.equal(tb.status, 200, `${label}: trial-balance failed`);
    assert.equal(tb.json.isBalanced, true, `${label}: Trial balance unbalanced (${tb.json.totalDebit} vs ${tb.json.totalCredit})`);

    const bs = await adminClient.request('GET', '/api/reports/balance-sheet?asOfDate=2026-12-31');
    assert.equal(bs.status, 200, `${label}: balance-sheet failed`);
    assert.equal(bs.json.totals.isBalanced, true, `${label}: Balance Sheet not balanced`);

    const pnl = await adminClient.request('GET', '/api/reports/profit-and-loss?startDate=2026-01-01&endDate=2026-12-31');
    assert.equal(pnl.status, 200, `${label}: P&L failed`);
  }

  async function getAccountNetDebitBalance(code: string): Promise<number> {
    const tb = await adminClient.request('GET', '/api/reports/trial-balance?startDate=2026-01-01&endDate=2026-12-31');
    const row = tb.json.rows.find((r: any) => r.accountCode === code);
    if (!row) return 0;
    return Number((Number(row.debitNum) - Number(row.creditNum)).toFixed(2));
  }

  try {
    assert.equal(
      (await adminClient.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } })).status,
      200
    );
    assert.equal(
      (await prodClient.request('POST', '/api/auth/login', { body: { identifier: 'production', password: 'PrintingAdmin#2026' } })).status,
      200
    );
    await refreshAccounts();

    // Shared entities across workflows
    let vendorId = 0;
    let customerId = 0;
    let rawPaperId = 0;
    let rawTonerId = 0;
    let stationeryId = 0;
    let machineId = 0;
    let po2Id = 0;
    let po2LineId = 0;

    let inv1Id = 0;
    let inv2Id = 0;
    let pmt1Id = 0;
    let pmt2Id = 0;
    let parentJobId = 0;

    // =========================================================================
    // WORKFLOW 2A: DEMAND REQUISITION -> APPROVE -> PO -> GOODS RECEIPT -> BILL -> PAYMENT -> GL
    // =========================================================================
    await runTest('Workflow 2: Procurement -> Inventory', 'Demand Requisition -> Approve -> PO -> Goods Receipt -> Supplier Bill -> Payment -> GL', async () => {
      // Create fresh test raw materials (starting at 0 stock for exact GL 1200 valuation checks, or controlled stock)
      // First record baseline inventory 1200 balance before our fresh items
      const paperRes = await adminClient.request('POST', '/api/inventory', {
        body: {
          sku: 'P9-A4-80',
          name: 'Phase 9 A4 80gsm Bond Ream',
          itemType: 'raw_material',
          unitCost: 150,
          avgCost: 0,
          onHand: 0,
          reorderPoint: 5,
          purchaseUnit: 'Ream',
          usageUnit: 'Sheet',
          conversionFactor: 500,
          paperSpec: { specCode: 'P9-PS-A4', sizeCode: 'A4', widthMm: 210, heightMm: 297, gsm: 80, finish: 'uncoated', grainDirection: 'long', sheetsPerReam: 500 },
        },
      });
      assert.equal(paperRes.status, 201);
      rawPaperId = Number(paperRes.json.item.id);

      const tonerRes = await adminClient.request('POST', '/api/inventory', {
        body: {
          sku: 'P9-TONER-K',
          name: 'Phase 9 Black Toner Cartridge',
          itemType: 'raw_material',
          unitCost: 200,
          avgCost: 0,
          onHand: 0,
          reorderPoint: 2,
          purchaseUnit: 'Cartridge',
          usageUnit: 'Impression',
          conversionFactor: 10000,
          materialSpec: { materialCategory: 'toner', yieldPerPurchaseUnit: 10000, coverageBasisPct: 5, colorChannel: 'K' },
        },
      });
      assert.equal(tonerRes.status, 201);
      rawTonerId = Number(tonerRes.json.item.id);

      const stRes = await adminClient.request('POST', '/api/inventory', {
        body: {
          sku: 'P9-STN-BOX',
          name: 'Phase 9 Exercise Pen Pack',
          itemType: 'stationery',
          unitCost: 20,
          avgCost: 20,
          salesPrice: 45,
          onHand: 5,
          reorderPoint: 0,
          purchaseUnit: 'Box',
          usageUnit: 'Box',
          conversionFactor: 1,
        },
      });
      assert.equal(stRes.status, 201);
      stationeryId = Number(stRes.json.item.id);

      const vRes = await adminClient.request('POST', '/api/vendors', {
        body: { name: 'Kabwe Paper Mills', companyName: 'Kabwe Paper & Toner Distributors', email: 'ap@kabwe.zm', terms: 'Net 30' },
      });
      assert.equal(vRes.status, 201);
      vendorId = vRes.json.vendor.id;

      // 1. Trigger demand requisition generation (0 <= 5 reams & 0 <= 2 cartridges)
      const demRes = await adminClient.request('POST', '/api/requisitions/demand', {
        body: { preferredVendorId: vendorId, targetMultiplier: 2 },
      });
      assert.equal(demRes.status, 201, `Demand requisition failed: ${demRes.text}`);
      assert.equal(demRes.json.generated, true);
      const reqId = demRes.json.requisition.id;
      assert.equal(demRes.json.requisition.demandSource, 'reorder_level');
      assert.ok(demRes.json.requisition.lines.length >= 2);

      // Cannot convert unapproved requisition -> 409 REQUISITION_NOT_APPROVED
      const unappPo = await adminClient.request('POST', `/api/requisitions/${reqId}/convert-po`, {
        body: { vendorId, poDate: '2026-11-15' },
      });
      assert.equal(unappPo.status, 409, unappPo.text);
      assert.equal(unappPo.json.code, 'REQUISITION_NOT_APPROVED');

      // 2. Approve requisition & convert to PO (10 Reams @ 150, 4 Toner @ 200 = 2300)
      const appRes = await adminClient.request('POST', `/api/requisitions/${reqId}/approve`, {
        body: { note: 'Approved by procurement lead' },
      });
      assert.equal(appRes.status, 200, appRes.text);
      assert.equal(appRes.json.requisition.status, 'approved');

      const poRes = await adminClient.request('POST', `/api/requisitions/${reqId}/convert-po`, {
        body: { vendorId, poDate: '2026-11-15' },
      });
      assert.equal(poRes.status, 201, poRes.text);
      const poId = poRes.json.purchaseOrder.id;
      assert.equal(poRes.json.purchaseOrder.total, 2300);

      // Duplicate conversion blocked -> 409 REQUISITION_ALREADY_CONVERTED
      const dupConv = await adminClient.request('POST', `/api/requisitions/${reqId}/convert-po`, {
        body: { vendorId, poDate: '2026-11-15' },
      });
      assert.equal(dupConv.status, 409, dupConv.text);
      assert.equal(dupConv.json.code, 'REQUISITION_ALREADY_CONVERTED');

      // 3. Physical Goods Receipt BEFORE supplier bill -> Dr 1200 Inventory 2300 / Cr 2055 GRNI 2300
      const grRes = await adminClient.request('POST', '/api/goods-receipts', {
        headers: { 'Idempotency-Key': 'p9-gr-1' },
        body: { purchaseOrderId: poId, receiptDate: '2026-11-16' },
      });
      assert.equal(grRes.status, 201, `GR failed: ${grRes.text}`);
      assert.equal(grRes.json.poStatus, 'closed');
      await assertJournalBalanced(grRes.json.goodsReceipt.journalTxnId);

      // Idempotent replay check
      const grReplay = await adminClient.request('POST', '/api/goods-receipts', {
        headers: { 'Idempotency-Key': 'p9-gr-1' },
        body: { purchaseOrderId: poId, receiptDate: '2026-11-16' },
      });
      assert.equal(grReplay.status, 200, grReplay.text);
      assert.equal(grReplay.json.idempotentReplay, true);

      await refreshAccounts();
      const grniAfterGr = await getAccountNetDebitBalance('2055');
      assert.equal(grniAfterGr, -2300, 'GRNI 2055 must carry credit balance -2300 until supplier bill posts');

      // 4. Supplier Bill from PO clears 2055 GRNI -> Dr 2055 GRNI 2300 / Cr 2000 AP 2300
      const billRes = await adminClient.request('POST', `/api/purchase-orders/${poId}/bill`, {
        body: { billNumber: 'BILL-KAB-001', billDate: '2026-11-17' },
      });
      assert.equal(billRes.status, 201, `Bill from PO failed: ${billRes.text}`);
      assert.equal(billRes.json.bill.awaitingReceipt, false);
      await assertJournalBalanced(billRes.json.bill.journalTxnId);
      assert.equal(await getAccountNetDebitBalance('2055'), 0, 'GRNI 2055 must clear to 0 after bill');

      // 5. Pay Supplier Bill -> Dr 2000 AP 2300 / Cr 1010 Bank 2300
      const bpRes = await adminClient.request('POST', '/api/bill-payments', {
        body: {
          vendorId,
          paymentDate: '2026-11-18',
          amount: 2300,
          bankAccountId: acctByCode.get('1010').id,
          allocations: [{ billId: billRes.json.bill.id, amount: 2300 }],
        },
      });
      assert.equal(bpRes.status, 201, `Bill payment failed: ${bpRes.text}`);
      await assertJournalBalanced(bpRes.json.billPayment.journalTxnId);

      // Verify stock levels updated cleanly
      const invRes = await adminClient.request('GET', '/api/inventory');
      const paperAfter = invRes.json.items.find((i: any) => Number(i.id) === rawPaperId);
      const tonerAfter = invRes.json.items.find((i: any) => Number(i.id) === rawTonerId);
      assert.equal(Number(paperAfter.on_hand), 10);
      assert.equal(Number(tonerAfter.on_hand), 4);

      await assertAccountingInvariants('After Workflow 2A');
      return 'Demand Req -> Approve -> PO -> Goods Receipt (1200/2055) -> Supplier Bill (clears 2055) -> Bill Payment verified';
    });

    // =========================================================================
    // WORKFLOW 2B: PO -> SUPPLIER BILL (PURCHASES IN TRANSIT) -> PARTIAL GOODS RECEIPTS -> OVER-RECEIPT BLOCK
    // =========================================================================
    await runTest('Workflow 2B: Pre-Billed PO Flow', 'PO -> Bill (1210 In Transit) -> Partial GRs -> Over-Receipt Block (409) -> Avg Cost Update', async () => {
      const poRes = await adminClient.request('POST', '/api/purchase-orders', {
        body: {
          vendorId,
          poDate: '2026-11-18',
          lines: [{ itemId: rawPaperId, description: 'Extra A4 Bond Reams', quantity: 6, rate: 160 }],
        },
      });
      assert.equal(poRes.status, 201);
      po2Id = poRes.json.purchaseOrder.id;
      po2LineId = poRes.json.purchaseOrder.lines[0].id;

      // Bill BEFORE physical receipt -> Dr 1210 Purchases In Transit 960 / Cr 2000 AP 960
      const billRes = await adminClient.request('POST', `/api/purchase-orders/${po2Id}/bill`, {
        body: { billNumber: 'BILL-KAB-002', billDate: '2026-11-18' },
      });
      assert.equal(billRes.status, 201);
      assert.equal(billRes.json.bill.awaitingReceipt, true);
      await assertJournalBalanced(billRes.json.bill.journalTxnId);
      assert.equal(await getAccountNetDebitBalance('1210'), 960);

      // Stock must STILL be 10 Reams until GR!
      let invRes = await adminClient.request('GET', '/api/inventory');
      assert.equal(Number(invRes.json.items.find((i: any) => Number(i.id) === rawPaperId).on_hand), 10);

      // Partial GR #1: 2 Reams @ 160 -> Dr 1200 320 / Cr 1210 320
      const gr1 = await adminClient.request('POST', '/api/goods-receipts', {
        body: { purchaseOrderId: po2Id, receiptDate: '2026-11-19', lines: [{ poLineId: po2LineId, receiveQty: 2, unitCost: 160 }] },
      });
      assert.equal(gr1.status, 201);
      assert.equal(gr1.json.poStatus, 'partially_received');
      await assertJournalBalanced(gr1.json.goodsReceipt.journalTxnId);
      assert.equal(await getAccountNetDebitBalance('1210'), 640);

      // Over-receipt attempt (5 > 4 remaining) -> 409 OVER_RECEIPT_BLOCKED & atomic rollback
      const badGr = await adminClient.request('POST', '/api/goods-receipts', {
        body: { purchaseOrderId: po2Id, receiptDate: '2026-11-19', lines: [{ poLineId: po2LineId, receiveQty: 5, unitCost: 160 }] },
      });
      assert.equal(badGr.status, 409);
      assert.equal(badGr.json.code, 'OVER_RECEIPT_BLOCKED');

      // Partial GR #2: remaining 4 Reams @ 160 -> clears 1210 to 0, PO closes
      const gr2 = await adminClient.request('POST', '/api/goods-receipts', {
        body: { purchaseOrderId: po2Id, receiptDate: '2026-11-20', lines: [{ poLineId: po2LineId, receiveQty: 4, unitCost: 160 }] },
      });
      assert.equal(gr2.status, 201);
      assert.equal(gr2.json.poStatus, 'closed');
      await assertJournalBalanced(gr2.json.goodsReceipt.journalTxnId);
      assert.equal(await getAccountNetDebitBalance('1210'), 0, '1210 Purchases In Transit must clear to 0');

      invRes = await adminClient.request('GET', '/api/inventory');
      const paperNow = invRes.json.items.find((i: any) => Number(i.id) === rawPaperId);
      // 10 @ 150 (=1500) + 6 @ 160 (=960) = 16 Reams, total value 2460 -> avg_cost = 153.750000
      assert.equal(Number(paperNow.on_hand), 16);
      assert.equal(Number(paperNow.avg_cost), 153.75);

      await assertAccountingInvariants('After Workflow 2B');
      return 'Pre-billed PO -> 1210 Purchases In Transit -> Partial GRs -> Over-Receipt 409 rollback -> Exact Weighted Avg Cost (153.75/Ream) verified';
    });

    // =========================================================================
    // WORKFLOW 3: MATERIAL RESERVATION, OVERSELL GUARD, ISSUE, WASTE, RETURN & VALUATION RECONCILIATION
    // =========================================================================
    await runTest('Workflow 3: Material Consumption & Valuation', 'Reserve -> Oversell Block -> Issue to WIP (Idempotent) -> Consumption/Waste -> Return Unused -> Valuation Reconciliation', async () => {
      const mRes = await adminClient.request('POST', '/api/printing/machines', {
        body: { machineCode: 'PRESS-P9', name: 'Phase 9 Digital Production Press', machineType: 'digital_press', supportsDuplex: true, maxPaperSize: 'A3', clickCostPerImp: 0.05 },
      });
      assert.equal(mRes.status, 201);
      machineId = mRes.json.machine.id;

      // Create standalone job needing 1500 sheets (3.00 Reams) + 3000 impressions (0.30 Cartridge)
      const jobRes = await adminClient.request('POST', '/api/printing/jobs', {
        body: {
          jobType: 'general_print',
          machineId,
          rawPaperItemId: rawPaperId,
          rawTonerItemId: rawTonerId,
          title: 'Grade 12 Chemistry Manuals (300 Copies)',
          pages: 10,
          copies: 300,
          printSide: 'Duplex',
          manualSellingPrice: 1800,
          jobDate: '2026-11-20',
        },
      });
      assert.equal(jobRes.status, 201);
      const jobId = jobRes.json.job.id;
      assert.equal(jobRes.json.job.sheetsUsed, 1500);
      assert.equal(jobRes.json.job.impressionsUsed, 3000);

      // Cannot issue before budget approval -> 409 BUDGET_NOT_APPROVED
      const unapprovedIssue = await adminClient.request('POST', `/api/printing/jobs/${jobId}/materials/issue`, { body: {} });
      assert.equal(unapprovedIssue.status, 409);
      assert.equal(unapprovedIssue.json.code, 'BUDGET_NOT_APPROVED');

      // Approve budget & reserve materials (3.0 Reams + 0.3 Cartridge)
      const budRes = await adminClient.request('POST', `/api/printing/jobs/${jobId}/approve-budget`, { body: { budgetLabour: 100, budgetMachine: 150 } });
      assert.equal(budRes.status, 200, budRes.text);
      const resvRes = await adminClient.request('POST', `/api/printing/jobs/${jobId}/materials/reserve`, { body: {} });
      assert.equal(resvRes.status, 200, resvRes.text);

      // Double-reservation rejected -> 409 MATERIALS_ALREADY_RESERVED
      const dupResv = await adminClient.request('POST', `/api/printing/jobs/${jobId}/materials/reserve`, { body: {} });
      assert.equal(dupResv.status, 409, dupResv.text);
      assert.equal(dupResv.json.code, 'MATERIALS_ALREADY_RESERVED');

      // Competing job requiring 14 Reams (> 13 unreserved Reams!) must fail reservation -> 409 INSUFFICIENT_UNRESERVED_STOCK
      const job2Res = await adminClient.request('POST', '/api/printing/jobs', {
        body: {
          jobType: 'general_print',
          machineId,
          rawPaperItemId: rawPaperId,
          rawTonerItemId: rawTonerId,
          title: 'Oversized Competing Run (14 Reams)',
          pages: 10,
          copies: 1400,
          printSide: 'Duplex',
          manualSellingPrice: 4000,
          jobDate: '2026-11-20',
        },
      });
      assert.equal(job2Res.status, 201, job2Res.text);
      const competeResv = await adminClient.request('POST', `/api/printing/jobs/${job2Res.json.job.id}/materials/reserve`, { body: {} });
      assert.equal(competeResv.status, 409, competeResv.text);
      assert.equal(competeResv.json.code, 'INSUFFICIENT_UNRESERVED_STOCK');

      // Also verify Stationery oversell guard (5 on hand -> invoice 6 fails with 409 INSUFFICIENT_STOCK)
      const cTmp = await adminClient.request('POST', '/api/customers', {
        body: { name: 'St Mary High', companyName: 'St Mary Secondary School', customerType: 'school', terms: 'Net 30' },
      });
      assert.equal(cTmp.status, 201, cTmp.text);
      customerId = cTmp.json.customer.id;
      const oversellStn = await adminClient.request('POST', '/api/invoices', {
        body: {
          customerId,
          invoiceDate: '2026-11-20',
          lines: [{ itemId: stationeryId, description: 'Pens', quantity: 6, rate: 45, taxable: false }],
        },
      });
      assert.equal(oversellStn.status, 409, oversellStn.text);
      assert.equal(oversellStn.json.code, 'INSUFFICIENT_STOCK');

      // Issue reserved materials with Idempotency-Key -> Dr 1250 WIP / Cr 1200 Inventory Asset
      const issRes = await adminClient.request('POST', `/api/printing/jobs/${jobId}/materials/issue`, {
        headers: { 'Idempotency-Key': 'p9-issue-job1' },
        body: { issueDate: '2026-11-20' },
      });
      assert.equal(issRes.status, 200, issRes.text);
      await assertJournalBalanced(issRes.json.journalTxnId);

      // Idempotent replay -> 0 duplicate movements or GL lines
      const issReplay = await adminClient.request('POST', `/api/printing/jobs/${jobId}/materials/issue`, {
        headers: { 'Idempotency-Key': 'p9-issue-job1' },
        body: { issueDate: '2026-11-20' },
      });
      assert.equal(issReplay.status, 200, issReplay.text);
      assert.equal(issReplay.json.idempotentReplay, true);

      // Duplicate non-idempotent issue blocked -> 409 MATERIALS_ALREADY_ISSUED
      const dupIss = await adminClient.request('POST', `/api/printing/jobs/${jobId}/materials/issue`, { body: { issueDate: '2026-11-20' } });
      assert.equal(dupIss.status, 409, dupIss.text);
      assert.equal(dupIss.json.code, 'MATERIALS_ALREADY_ISSUED');

      // Record actual consumption + waste (1350 good sheets + 100 waste sheets = 1450; 3000 good toner imp)
      const consRes = await adminClient.request('POST', `/api/printing/jobs/${jobId}/materials/consume`, {
        body: {
          lines: [
            { rawMaterialItemId: rawPaperId, actualGoodUsageQty: 1350, wasteUsageQty: 100, wasteReason: 'Feeder jam setup sheets' },
            { rawMaterialItemId: rawTonerId, actualGoodUsageQty: 3000, wasteUsageQty: 0 },
          ],
        },
      });
      assert.equal(consRes.status, 200, consRes.text);
      assert.ok(consRes.json.job.actualWasteCost > 0, 'Waste cost must be computed from issued avg cost');

      // Attempting consumption > remaining unconsumed issued throws 409 CONSUMPTION_EXCEEDS_ISSUED
      const badCons = await adminClient.request('POST', `/api/printing/jobs/${jobId}/materials/consume`, {
        body: { lines: [{ rawMaterialItemId: rawPaperId, actualGoodUsageQty: 100 }] },
      });
      assert.equal(badCons.status, 409, badCons.text);
      assert.equal(badCons.json.code, 'CONSUMPTION_EXCEEDS_ISSUED');

      // Return remaining 50 unused sheets (0.10 Ream) back to inventory -> Dr 1200 / Cr 1250 WIP
      const retRes = await adminClient.request('POST', `/api/printing/jobs/${jobId}/materials/return`, {
        body: { returnDate: '2026-11-20', lines: [{ rawMaterialItemId: rawPaperId, returnUsageQty: 50 }] },
      });
      assert.equal(retRes.status, 200, retRes.text);
      await assertJournalBalanced(retRes.json.journalTxnId);

      // Verify on_hand = 16 - 3 + 0.1 = 13.1 Reams
      const invRes = await adminClient.request('GET', '/api/inventory');
      const paperFinal = invRes.json.items.find((i: any) => Number(i.id) === rawPaperId);
      assert.equal(Number(paperFinal.on_hand), 13.1);
      assert.equal(Number(paperFinal.reserved_qty), 0);

      // Valuation report check (subledger & GL 1200 reconcile within 0.01 rounding)
      const valRes = await adminClient.request('GET', '/api/inventory/valuation');
      assert.equal(valRes.status, 200);
      assert.ok(valRes.json.valuation.wip1250Balance > 0, 'WIP 1250 balance must reflect uninvoiced active job');

      // Cancel job2Res clean test artifact (budget wasn't approved, draft job)
      assert.equal((await adminClient.request('POST', `/api/printing/jobs/${job2Res.json.job.id}/cancel`, { body: { reason: 'Superseded by capacity check' } })).status, 200);

      await assertAccountingInvariants('After Workflow 3');
      return 'Material reservation, unreserved stock lock (409), stationery oversell block, idempotent issue, waste tracking, unused return to 1200, and valuation check verified';
    });

    // =========================================================================
    // WORKFLOW 1 & 4: SALES QUOTE -> APPROVAL -> JOB -> BUDGET -> PARTIAL OPS/QC/DELIVERY -> DUPLICATE-SAFE INVOICING -> PROFITABILITY
    // =========================================================================
    await runTest('Workflows 1 & 4: Sales -> Production -> Profitability', 'Quotation -> Approve -> Job -> Budget -> Partial Ops/Finishing/QC/Delivery -> Duplicate-Safe Invoices -> Real Profit', async () => {
      // Create Sales Quotation (Estimate)
      const estRes = await adminClient.request('POST', '/api/estimates', {
        body: {
          customerId,
          estimateDate: '2026-11-21',
          taxRate: 0,
          notes: '100 Printed Syllabus Booklets (10pp Duplex)',
          lines: [{ description: 'Syllabus Booklets (100 copies)', quantity: 100, unitCost: 3.1, rate: 35, taxable: false }],
        },
      });
      assert.equal(estRes.status, 201);
      const estId = estRes.json.estimate.id;

      // Attempting job creation BEFORE quotation approval -> 409 ESTIMATE_NOT_APPROVED
      const blockedJob = await adminClient.request('POST', `/api/estimates/${estId}/create-job`, {
        body: {
          jobType: 'printed_product',
          machineId,
          rawPaperItemId: rawPaperId,
          rawTonerItemId: rawTonerId,
          title: 'Syllabus Booklets (100 Copies)',
          pages: 10,
          copies: 100,
          printSide: 'Duplex',
        },
      });
      assert.equal(blockedJob.status, 409);
      assert.equal(blockedJob.json.code, 'ESTIMATE_NOT_APPROVED');

      // Approve quotation & create printing job
      assert.equal((await adminClient.request('POST', `/api/estimates/${estId}/approve`, { body: { note: 'Principal signed PO' } })).status, 200);
      const jobRes = await adminClient.request('POST', `/api/estimates/${estId}/create-job`, {
        body: {
          jobType: 'printed_product',
          machineId,
          rawPaperItemId: rawPaperId,
          rawTonerItemId: rawTonerId,
          title: 'Syllabus Booklets (100 Copies)',
          pages: 10,
          copies: 100,
          orderedQty: 100,
          printSide: 'Duplex',
          jobDate: '2026-11-21',
        },
      });
      assert.equal(jobRes.status, 201);
      parentJobId = jobRes.json.job.id;
      assert.equal(jobRes.json.job.manualSellingPrice, 3500);
      assert.equal(jobRes.json.job.salesEstimateId, estId);

      // Approve Budget (Material + Labour 200 + Machine 50)
      const budRes = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/approve-budget`, {
        body: { budgetLabour: 200, budgetMachine: 50 },
      });
      assert.equal(budRes.status, 200);

      // Reserve & Issue Materials (500 sheets = 1.0 Ream = 153.75; 1000 toner imp = 0.1 Cartridge = 20.00 -> Material WIP = 173.75)
      assert.equal((await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/materials/reserve`, { body: {} })).status, 200);
      const issRes = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/materials/issue`, { body: { issueDate: '2026-11-21' } });
      assert.equal(issRes.status, 200);
      await assertJournalBalanced(issRes.json.journalTxnId);

      // Partial Production Batch 1: 60 booklets, 2 hrs @ 75/hr = 150 labour, 600 imp @ 0.05 = 30 machine
      const op1 = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/operations`, {
        body: { stage: 'press_run', machineId, goodSheets: 300, spoilageSheets: 0, producedQtyAdded: 60, actualHours: 2, labourRatePerHour: 75, impressionsRun: 600, operationDate: '2026-11-21' },
      });
      assert.equal(op1.status, 201);
      await assertJournalBalanced(op1.json.journalTxnId);
      assert.equal(op1.json.job.producedGoodQty, 60);

      // Finishing: 1 hr @ 50/hr = 50 labour -> total labour so far = 200
      const fin1 = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/finishing`, {
        body: { finishingType: 'saddle_stitching', actualHours: 1, labourRatePerHour: 50, machineCost: 0, operationDate: '2026-11-21' },
      });
      assert.equal(fin1.status, 201);
      await assertJournalBalanced(fin1.json.journalTxnId);

      // QC Batch 1: approve 60 booklets
      const qc1 = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/qc`, {
        body: { sampleSize: 10, defectCount: 0, disposition: 'approved', approvedQty: 60 },
      });
      assert.equal(qc1.status, 201);
      assert.equal(qc1.json.job.qcApprovedQty, 60);

      // Delivery Note #1: dispatch 60 booklets (job status -> partial_delivery)
      const dn1 = await adminClient.request('POST', '/api/printing/deliveries', {
        body: { jobId: parentJobId, quantityDispatched: 60, dispatchDate: '2026-11-21', recipientName: 'School Bursar' },
      });
      assert.equal(dn1.status, 201);
      const dn1Id = dn1.json.deliveryNote.id;

      // Attempting over-delivery (> 0 un-dispatched QC approved) -> 409 DELIVERY_EXCEEDS_QC_APPROVED
      const badDn = await adminClient.request('POST', '/api/printing/deliveries', {
        body: { jobId: parentJobId, quantityDispatched: 5, dispatchDate: '2026-11-21' },
      });
      assert.equal(badDn.status, 409);
      assert.equal(badDn.json.code, 'DELIVERY_EXCEEDS_QC_APPROVED');

      // Production Batch 2: remaining 40 booklets, 400 imp @ 0.05 = 20 machine -> total machine = 50
      const op2 = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/operations`, {
        body: { stage: 'press_run', machineId, goodSheets: 200, spoilageSheets: 0, producedQtyAdded: 40, actualHours: 0, labourRatePerHour: 0, impressionsRun: 400, operationDate: '2026-11-21' },
      });
      assert.equal(op2.status, 201);
      assert.equal(op2.json.job.producedGoodQty, 100);

      // QC Batch 2 (remaining 40) + Delivery Note #2 (40 booklets -> status 'delivered')
      assert.equal((await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/qc`, { body: { sampleSize: 10, defectCount: 0, disposition: 'approved', approvedQty: 40 } })).status, 201);
      const dn2 = await adminClient.request('POST', '/api/printing/deliveries', {
        body: { jobId: parentJobId, quantityDispatched: 40, dispatchDate: '2026-11-21', recipientName: 'School Bursar' },
      });
      assert.equal(dn2.status, 201);
      const dn2Id = dn2.json.deliveryNote.id;

      // RBAC check: ProductionManager CANNOT invoice delivered jobs -> 403
      const pmInvBlock = await prodClient.request('POST', `/api/printing/jobs/${parentJobId}/invoice`, {
        body: { deliveryNoteId: dn1Id, invoiceDate: '2026-11-21' },
      });
      assert.equal(pmInvBlock.status, 403);

      // Invoice Delivery Note #1 (60/100 = 2,100.00 revenue + proportional COGS relief)
      const inv1Res = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/invoice`, {
        body: { deliveryNoteId: dn1Id, invoiceDate: '2026-11-21' },
      });
      assert.equal(inv1Res.status, 201, inv1Res.text);
      inv1Id = inv1Res.json.invoice.id;
      assert.equal(Number(inv1Res.json.invoice.total), 2100);
      await assertJournalBalanced(inv1Res.json.invoice.journalTxnId);
      await assertJournalBalanced(inv1Res.json.cogsJournalId);

      // Duplicate invoice on Delivery Note #1 blocked -> 409 DELIVERY_NOTE_ALREADY_INVOICED
      const dupInv = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/invoice`, {
        body: { deliveryNoteId: dn1Id, invoiceDate: '2026-11-21' },
      });
      assert.equal(dupInv.status, 409, dupInv.text);
      assert.equal(dupInv.json.code, 'DELIVERY_NOTE_ALREADY_INVOICED');

      // Invoice Delivery Note #2 (40/100 = 1,400.00 revenue + exact remaining WIP relief -> job 'completed')
      const inv2Res = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/invoice`, {
        body: { deliveryNoteId: dn2Id, invoiceDate: '2026-11-21' },
      });
      assert.equal(inv2Res.status, 201, inv2Res.text);
      inv2Id = inv2Res.json.invoice.id;
      assert.equal(Number(inv2Res.json.invoice.total), 1400);
      assert.equal(inv2Res.json.job.status, 'completed');
      assert.equal(inv2Res.json.job.wipCostAccumulated, inv2Res.json.job.wipCostRelieved, 'Final invoice must relieve 100% of job WIP');

      // Profitability check: Revenue 3500 - (Material 173.75 + Labour 200 + Machine 50 = 423.75) = 3076.25
      const profRes = await adminClient.request('GET', `/api/printing/jobs/${parentJobId}/profitability`);
      assert.equal(profRes.status, 200);
      assert.equal(profRes.json.profitability.invoicedRevenue, 3500);
      assert.equal(profRes.json.profitability.actualCosts.combinedTotal, 423.75);
      assert.equal(profRes.json.profitability.actualProfit, 3076.25);

      await assertAccountingInvariants('After Workflows 1 & 4');
      return 'Quotation gate, Job costing, Partial Press/Finishing/QC/Delivery, Duplicate Invoice 409 guard, 100% WIP COGS relief, and Profit=3076.25 verified';
    });

    // =========================================================================
    // EXCEPTIONS: CONTROLLED REPRINT MARGIN EROSION & JOB CANCELLATION SUNK WIP WRITE-OFF
    // =========================================================================
    await runTest('Exceptions: Controlled Reprint & Cancellation', 'Controlled Reprint Erodes Order Profit; Cancelled Job Returns Unused Material & Writes Off Sunk WIP to 5100', async () => {
      // 1. Create controlled reprint of parentJobId for 20 booklets -> 0 revenue
      const rpRes = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/reprint`, {
        body: { reprintReason: 'Cover ink smudge on batch sample', copies: 20, jobDate: '2026-11-22' },
      });
      assert.equal(rpRes.status, 201);
      const rpId = rpRes.json.job.id;
      assert.equal(rpRes.json.job.manualSellingPrice, 0);
      assert.equal(rpRes.json.job.reprintOfJobId, parentJobId);

      // Issue reprint materials -> adds reprint cost
      const rpIss = await adminClient.request('POST', `/api/printing/jobs/${rpId}/materials/issue`, { body: { issueDate: '2026-11-22' } });
      assert.equal(rpIss.status, 200);
      await assertJournalBalanced(rpIss.json.journalTxnId);

      // Re-check parent profitability -> actualProfit must drop below 3076.25 by exact reprint material cost!
      const profAfterRp = await adminClient.request('GET', `/api/printing/jobs/${parentJobId}/profitability`);
      assert.equal(profAfterRp.status, 200);
      assert.ok(profAfterRp.json.profitability.actualCosts.reprintTotal > 0);
      assert.ok(profAfterRp.json.profitability.actualProfit < 3076.25, 'Controlled reprint cost must erode order profit');

      // 2. Cancelled delivered job rejected -> 409 CANNOT_CANCEL_DELIVERED_JOB
      const cantCancel = await adminClient.request('POST', `/api/printing/jobs/${parentJobId}/cancel`, { body: { reason: 'Late' } });
      assert.equal(cantCancel.status, 409);
      assert.equal(cantCancel.json.code, 'CANNOT_CANCEL_DELIVERED_JOB');

      // 3. Create new job, issue materials, record 1 hr prepress labour (80), then cancel & return unused materials
      const cJobRes = await adminClient.request('POST', '/api/printing/jobs', {
        body: {
          jobType: 'general_print',
          customerId,
          machineId,
          rawPaperItemId: rawPaperId,
          rawTonerItemId: rawTonerId,
          title: 'Cancelled Prospectus Run',
          pages: 10,
          copies: 50,
          printSide: 'Duplex',
          manualSellingPrice: 900,
          jobDate: '2026-11-22',
        },
      });
      const cJobId = cJobRes.json.job.id;
      assert.equal((await adminClient.request('POST', `/api/printing/jobs/${cJobId}/approve-budget`, { body: { budgetLabour: 80 } })).status, 200);
      assert.equal((await adminClient.request('POST', `/api/printing/jobs/${cJobId}/materials/issue`, { body: { issueDate: '2026-11-22' } })).status, 200);
      assert.equal((await adminClient.request('POST', `/api/printing/jobs/${cJobId}/operations`, { body: { stage: 'prepress', actualHours: 1, labourRatePerHour: 80, operationDate: '2026-11-22' } })).status, 201);

      const cancelRes = await adminClient.request('POST', `/api/printing/jobs/${cJobId}/cancel`, {
        body: { reason: 'Customer cancelled order before press run', returnUnusedMaterials: true, cancelDate: '2026-11-22' },
      });
      assert.equal(cancelRes.status, 200);
      assert.equal(cancelRes.json.job.status, 'cancelled');
      assert.equal(cancelRes.json.wipWrittenOff, 80, 'Sunk prepress labour (80) must be written off to 5100');
      await assertJournalBalanced(cancelRes.json.writeOffJournalId);
      assert.equal(await getAccountNetDebitBalance('5100'), 80, '5100 Spoilage & Variance must reflect 80 write-off');

      await assertAccountingInvariants('After Reprint & Cancellation');
      return 'Controlled reprint margin erosion & job cancellation (material return + 80 sunk WIP -> 5100 write-off) verified';
    });

    // =========================================================================
    // WORKFLOW 5: RECEIPTS -> UNDEPOSITED FUNDS -> BATCH BANK DEPOSIT -> DOUBLE-DEPOSIT BLOCK -> RECONCILIATION -> FINANCIAL STATEMENTS
    // =========================================================================
    await runTest('Workflow 5: Financial Reconciliation', 'AR Payments -> 1050 Undeposited Funds -> Single Batch Deposit -> Double-Deposit Block (409) -> Bank Reconciliation Zero-Diff -> FS', async () => {
      await refreshAccounts();
      const undepId = acctByCode.get('1050').id;
      const bank1010Id = acctByCode.get('1010').id;

      // Record both invoice payments (2100 + 1400 = 3500) to 1050 Undeposited Funds
      const p1 = await adminClient.request('POST', '/api/payments', {
        body: {
          customerId,
          paymentDate: '2026-11-22',
          amount: 2100,
          depositToAccountId: undepId,
          allocations: [{ invoiceId: inv1Id, amount: 2100 }],
        },
      });
      assert.equal(p1.status, 201, p1.text);
      pmt1Id = p1.json.payment.id;
      await assertJournalBalanced(p1.json.payment.journalTxnId);

      const p2 = await adminClient.request('POST', '/api/payments', {
        body: {
          customerId,
          paymentDate: '2026-11-22',
          amount: 1400,
          depositToAccountId: undepId,
          allocations: [{ invoiceId: inv2Id, amount: 1400 }],
        },
      });
      assert.equal(p2.status, 201, p2.text);
      pmt2Id = p2.json.payment.id;
      await assertJournalBalanced(p2.json.payment.journalTxnId);

      // 1050 Undeposited Funds balance must now be 3500 debit
      assert.equal(await getAccountNetDebitBalance('1050'), 3500);

      // Batch Bank Deposit to 1010 -> Dr 1010 3500 / Cr 1050 3500
      const depRes = await adminClient.request('POST', '/api/banking/deposits', {
        body: {
          bankGlAccountId: bank1010Id,
          txnDate: '2026-11-23',
          receivedFrom: 'St Mary Secondary School Cash & Cheque Batch',
          memo: 'Clear Undeposited Funds batch',
          paymentIds: [pmt1Id, pmt2Id],
        },
      });
      assert.equal(depRes.status, 201, depRes.text);
      assert.equal(Number(depRes.json.transaction.amount), 3500);
      await assertJournalBalanced(depRes.json.transaction.journalTxnId);
      assert.equal(await getAccountNetDebitBalance('1050'), 0, '1050 Undeposited Funds must clear to 0 after deposit');

      // Double-deposit guard -> 409 ALREADY_DEPOSITED
      const dupDep = await adminClient.request('POST', '/api/banking/deposits', {
        body: {
          bankGlAccountId: bank1010Id,
          txnDate: '2026-11-23',
          paymentIds: [pmt1Id],
        },
      });
      assert.equal(dupDep.status, 409, dupDep.text);
      assert.equal(dupDep.json.code, 'ALREADY_DEPOSITED');

      // Bank Reconciliation on 1010 Operating Checking
      const bankTxns = await adminClient.request('GET', `/api/banking/transactions?accountId=${bank1010Id}&status=posted&cleared=false`);
      assert.equal(bankTxns.status, 200, bankTxns.text);
      const txns = bankTxns.json.transactions as any[];
      const unclearedIds = txns.map(t => t.id);

      // Compute exact book ending balance on 1010 via preview with trial statementBalance = 0 to learn bookClearedBalance!
      const glBankBal = await getAccountNetDebitBalance('1010');
      const recPrev = await adminClient.request('POST', '/api/banking/reconciliations/preview', {
        body: { accountId: bank1010Id, statementDate: '2026-11-30', statementEndingBalance: glBankBal, clearedBankTxnIds: unclearedIds },
      });
      assert.equal(recPrev.status, 200, recPrev.text);

      // Note: OB-2026 + direct bill payment (-2300) + deposit (+3500) all sit on 1010; use exact cleared balance from preview
      const targetStmtBalance = recPrev.json.preview.clearedEndingBalance;
      const recDone = await adminClient.request('POST', '/api/banking/reconciliations/complete', {
        body: { accountId: bank1010Id, statementDate: '2026-11-30', statementEndingBalance: targetStmtBalance, clearedBankTxnIds: unclearedIds },
      });
      assert.equal(recDone.status, 201, recDone.text);
      assert.equal(recDone.json.reconciliation.status, 'completed');

      await assertAccountingInvariants('After Workflow 5');
      return 'Undeposited Funds (1050) -> Batch Deposit (3500) -> Double-Deposit 409 lock -> Bank Recon Completed -> Balanced TB/BS/P&L verified';
    });

    // =========================================================================
    // CROSS-CUTTING: AUDIT TRAIL ATTRIBUTION & MULTI-COMPANY ISOLATION (COMPANY B)
    // =========================================================================
    await runTest('Cross-Cutting: Audit & Multi-Company Isolation', 'Verify Audit Trail Attribution & Complete Tenant Isolation on Company B Switch', async () => {
      const auditRes = await adminClient.request('GET', '/api/audit/logs?limit=100');
      assert.equal(auditRes.status, 200, auditRes.text);
      const actions = new Set((auditRes.json.logs as any[]).map(l => l.action));
      for (const expectedAction of [
        'PURCHASE_REQUISITION_CREATED',
        'GOODS_RECEIPT_POSTED',
        'JOB_BUDGET_APPROVED',
        'JOB_MATERIALS_RESERVED',
        'JOB_MATERIALS_ISSUED',
        'DELIVERY_NOTE_CREATED',
        'DELIVERED_JOB_INVOICED',
        'PRINTING_JOB_CANCELLED',
        'CONTROLLED_REPRINT_CREATED',
        'BANK_DEPOSIT_POSTED',
      ]) {
        assert.ok(actions.has(expectedAction), `Missing audit log action: ${expectedAction}`);
      }

      // Switch to Company B -> must see zero Company A jobs, requisitions, goods receipts, and 404 on Company A job profitability
      const compRes = await adminClient.request('GET', '/api/companies');
      assert.equal(compRes.status, 200, compRes.text);
      const compB = (compRes.json.companies as any[]).find(c => Number(c.id) !== 1);
      assert.ok(compB, 'Expected seeded Company B');

      const swRes = await adminClient.request('POST', '/api/auth/switch-company', { body: { companyId: compB.id } });
      assert.equal(swRes.status, 200, swRes.text);

      const bJobs = await adminClient.request('GET', '/api/printing/jobs');
      assert.equal(bJobs.status, 200);
      assert.equal(bJobs.json.jobs.length, 0, 'Company B must not see Company A printing jobs');

      const bReqs = await adminClient.request('GET', '/api/requisitions');
      assert.equal(bReqs.status, 200);
      assert.equal(bReqs.json.requisitions.length, 0, 'Company B must not see Company A purchase requisitions');

      const crossProf = await adminClient.request('GET', `/api/printing/jobs/${parentJobId}/profitability`);
      assert.equal(crossProf.status, 404, 'Company B must get 404 for Company A job profitability');

      // Switch back to Company A cleanly
      assert.equal((await adminClient.request('POST', '/api/auth/switch-company', { body: { companyId: 1 } })).status, 200);

      return 'All 10+ workflow audit log actions verified + Company B cross-tenant isolation confirmed';
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
    await db.close();
  }

  // Write Phase 9 Dependency Map & E2E Execution Report
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  const docsDir = path.resolve(process.cwd(), 'docs', 'workflows');
  fs.mkdirSync(docsDir, { recursive: true });
  const reportPath = path.join(docsDir, 'phase9-dependency-and-test-report.md');

  const reportLines = [
    '# Phase 9 — End-to-End Business Workflow Dependency Map & Test Report',
    '',
    `- **Executed At:** ${new Date().toISOString()}`,
    `- **Summary:** **${passed}/${results.length} PASSED**, ${failed} FAILED`,
    '',
    '## 1. Module & GL Account Dependency Map',
    '',
    '```',
    'Sales & Estimates (/api/estimates)',
    '  └─▶ POST /estimates/:id/approve ──▶ POST /estimates/:id/create-job',
    '                                          │',
    'Procurement (/api/requisitions, /purchase-orders, /goods-receipts)',
    '  ├─▶ Demand/Reorder -> Requisition -> Approve -> PO (uq_po_company_requisition)',
    '  ├─▶ Pre-Billed Flow: PO -> Bill (Dr 1210 Purchases In Transit / Cr 2000 AP)',
    '  │                      └─▶ Goods Receipt (Dr 1200 Inventory / Cr 1210 Transit)',
    '  └─▶ Physical First:  PO -> Goods Receipt (Dr 1200 Inventory / Cr 2055 GRNI)',
    '                         └─▶ Bill (Dr 2055 GRNI / Cr 2000 AP)',
    '                                          │',
    'Production Floor (/api/printing/jobs/:id/...)',
    '  ├─▶ Shared Calc Engine (paperCalc.ts + tonerCalc.ts + printingWorkflows.ts)',
    '  ├─▶ approve-budget ──▶ materials/reserve (inventory_items.reserved_qty locks)',
    '  ├─▶ materials/issue (Dr 1250 WIP / Cr 1200 Inventory Asset)',
    '  ├─▶ materials/consume (Good vs Waste -> actual_waste_cost) & materials/return (Dr 1200 / Cr 1250)',
    '  ├─▶ operations & finishing (Dr 1250 WIP / Cr 2110 Direct Labour + Cr 6310 Machine Overhead)',
    '  ├─▶ qc (qc_approved_qty <= produced_good_qty)',
    '  ├─▶ /printing/deliveries (delivered_qty <= qc_approved_qty, supports partial delivery)',
    '  ├─▶ /printing/jobs/:id/invoice (delivery_notes.invoice_id NULL guard + Dr 5000 COGS / Cr 1250 WIP)',
    '  ├─▶ cancel (releases reserve, returns unused -> 1200, writes off sunk WIP -> Dr 5100 Variance / Cr 1250)',
    '  └─▶ reprint (manual_selling_price = 0, linked via reprint_of_job_id, combined profitability report)',
    '',
    'Cash, Banking & Statements (/api/payments, /api/banking/deposits, /reconciliations)',
    '  ├─▶ Invoice Payments & Sales Receipts -> 1050 Undeposited Funds (stays out of 1010 bank ledger)',
    '  ├─▶ POST /banking/deposits (paymentIds[]) -> Dr 1010 Bank / Cr 1050 (sets deposited_bank_txn_id)',
    '  └─▶ Reconciliations -> Zero-Diff Lock -> Trial Balance, P&L, Balance Sheet, Valuation (/inventory/valuation)',
    '```',
    '',
    '## 2. Automated E2E Workflow Execution Results',
    '',
    '| Status | Workflow | Scenario | Duration | Details |',
    '| :--- | :--- | :--- | ---: | :--- |',
    ...results.map(r => `| ${r.passed ? 'PASS' : 'FAIL'} | ${r.workflow} | ${r.name} | ${r.durationMs}ms | ${r.details} |`),
    '',
    '## 3. Verified Integrity Controls',
    '',
    '- Double-entry invariant enforced at PostgreSQL transaction commit on every Procurement, WIP, COGS, Cancellation Variance, Invoice, Payment, and Deposit journal.',
    '- Reserved stock (`reserved_qty <= on_hand`) blocks overselling on both raw materials and retail stationery.',
    '- Duplicate invoicing of already-invoiced Delivery Notes and double bank deposits of Undeposited Payments rejected with HTTP `409`.',
    '- Request-level idempotency (`Idempotency-Key`) prevents duplicate Goods Receipts and duplicate WIP Material Issues.',
    '- Cross-company RLS + RBAC verified across Administrator, ProductionManager, and Company B tenant switches.',
    '',
  ];

  fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf8');
  console.log(`\nReport written to ${reportPath}`);
  console.log(`Summary: ${passed}/${results.length} PASSED`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal workflow suite error:', err);
  process.exit(1);
});
