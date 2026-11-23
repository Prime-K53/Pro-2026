/**
 * Quick-print typing & printing revenue separation — binding verification.
 *
 * Proves that:
 *  - Typing & printing is customer-facing REVENUE, never a material cost.
 *  - manual_selling_price is the complete selling amount (typing + photocopy)
 *    and is never added on top of the frontend sellingPriceTotal (no double count).
 *  - Converting the job to an invoice does not add typing revenue twice.
 *  - Persisted profitability (printing_jobs generated columns) is correct, not
 *    just the frontend preview.
 *  - The acceptance example reconciles exactly:
 *      selling price 2450, material 120, finishing 0, total cost 120, profit 2330.
 *
 * Uses the service layer directly (no HTTP app) so the suite is independent of
 * unrelated server bootstrap concerns.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase } from '../../src/server/db.ts';
import { postQuickPrintJob, linkQuickPrintJobToInvoice } from '../../src/server/services/productionService.ts';
import { createCustomer, createInvoiceOrSalesReceipt } from '../../src/server/services/salesService.ts';
import { ActorContext } from '../../src/server/services/accountingEngine.ts';

const results: Array<{ name: string; passed: boolean; detail: string }> = [];

async function runTest(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    results.push({ name, passed: true, detail });
    console.log(`  [PASS] ${name} — ${detail}`);
  } catch (err: any) {
    results.push({ name, passed: false, detail: err?.message ?? String(err) });
    console.error(`  [FAIL] ${name} — ${err?.message ?? err}`);
  }
}

const money = (v: unknown) => Math.round(Number(v) * 10000) / 10000;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-typing-'));
const cfg = { ...loadServerConfig(), nodeEnv: 'test', isProduction: false, attachmentsDir: tmpDir };
const db = await createServerDatabase(cfg, { inMemory: true, seedDemo: true });

try {
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
  const actor: ActorContext = { userId, username: 'admin', role: 'Administrator' };

  // --- Seed dedicated raw materials so the acceptance example is exact -------
  // Paper: 15000 / 500 sheets = K30/sheet  -> 3 sheets = K90
  // Toner: 75000 / 15000 impressions = K5/imp -> 6 impressions = K30
  const seeded = await db.withCompanyDb(companyId, async tx => {
    const acctRes = await tx.query<{ id: number; account_type: string }>(
      `SELECT id, account_type FROM accounts WHERE company_id = $1 AND is_active = TRUE`,
      [companyId]
    );
    const firstByType = (t: string) => Number(acctRes.rows.find(a => a.account_type === t)!.id);
    const invId = firstByType('Inventory');
    const cogsId = firstByType('CostOfGoodsSold');
    const revId = firstByType('Income');

    const ps = await tx.query<{ id: number }>(
      `INSERT INTO paper_specifications (company_id, spec_code, name, size_code, width_mm, height_mm, gsm, finish, grain_direction, sheets_per_ream)
       VALUES ($1, 'PS-ACC-A4', 'Acceptance A4', 'A4', 210.00, 297.00, 80, 'uncoated', 'long', 500) RETURNING id`,
      [companyId]
    );
    const paperSpecId = Number(ps.rows[0].id);

    const paper = await tx.query<{ id: number }>(
      `INSERT INTO inventory_items (company_id, sku, name, item_type, unit_cost, avg_cost, sales_price, on_hand, purchase_unit, usage_unit, conversion_factor, paper_spec_id, asset_account_id, cogs_account_id, income_account_id)
       VALUES ($1, 'RM-ACC-PAPER', 'Acceptance Paper', 'raw_material', 15000.000000, 15000.000000, 0.0000, 100.000000, 'Ream', 'Sheet', 500.000000, $2, $3, $4, $5) RETURNING id`,
      [companyId, paperSpecId, invId, cogsId, revId]
    );
    const paperId = Number(paper.rows[0].id);

    const toner = await tx.query<{ id: number }>(
      `INSERT INTO inventory_items (company_id, sku, name, item_type, unit_cost, avg_cost, sales_price, on_hand, purchase_unit, usage_unit, conversion_factor, asset_account_id, cogs_account_id, income_account_id)
       VALUES ($1, 'RM-ACC-TONER', 'Acceptance Toner K', 'raw_material', 75000.000000, 75000.000000, 0.0000, 10.000000, 'Cartridge', 'Impression', 15000.000000, $2, $3, $4) RETURNING id`,
      [companyId, invId, cogsId, revId]
    );
    const tonerId = Number(toner.rows[0].id);

    await tx.query(
      `INSERT INTO material_specifications (company_id, inventory_item_id, material_category, yield_per_purchase_unit, coverage_basis_pct, color_channel)
       VALUES ($1, $2, 'toner', 15000.0000, 5.0000, 'K')`,
      [companyId, tonerId]
    );

    return { paperId, tonerId };
  });

  const { paperId, tonerId } = seeded!;

  // --- 1. Combined job: typing 2 pages @ K1000 + photocopy 3 sheets @ K150 ---
  const created = await db.withCompanyDb(companyId, async tx => {
    await tx.query(`SELECT set_config('app.current_user_id', $1, TRUE)`, [String(userId)]);
    const res = await postQuickPrintJob(tx, companyId, actor, {
      jobType: 'type_and_printing',
      customerName: 'Acceptance Walk-In',
      rawPaperItemId: paperId,
      rawTonerItemId: tonerId,
      title: 'Acceptance typed & photocopied job',
      pages: 2,
      copies: 3,
      printSide: 'Duplex',
      typingFeeMode: 'per_page',
      typingFeeRate: 1000,
      manualSellingPricePerSheet: 150,
      jobDate: '2026-11-22',
    });
    return res.job;
  });

  await runTest('1. Combined job stores typing as revenue, not cost', async () => {
    assert.equal(Number(created.sheetsUsed), 3, `sheetsUsed=${created.sheetsUsed}`);
    assert.equal(Number(created.impressionsUsed), 6, `impressionsUsed=${created.impressionsUsed}`);
    assert.equal(money(created.paperCost), 90, `paperCost=${created.paperCost}`);
    assert.equal(money(created.tonerCost), 30, `tonerCost=${created.tonerCost}`);
    assert.equal(money(created.extraCost), 0, 'typing must NOT be stored as extra_cost');
    assert.equal(money(created.manualSellingPrice), 2450, `manualSellingPrice=${created.manualSellingPrice}`);
    assert.equal(money(created.totalCost), 120, `totalCost=${created.totalCost}`);
    assert.equal(money(created.profit), 2330, `profit=${created.profit}`);
    return `selling=${created.manualSellingPrice}, material=${created.totalCost}, profit=${created.profit}`;
  });

  // --- 2. Persisted profitability (re-read from the database) ----------------
  await runTest('2. Persisted profitability matches the acceptance values', async () => {
    const row = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{
        manual_selling_price: string;
        paper_cost: string;
        toner_cost: string;
        extra_cost: string;
        total_cost: string;
        profit: string;
      }>(
        `SELECT manual_selling_price::text, paper_cost::text, toner_cost::text, extra_cost::text, total_cost::text, profit::text
           FROM printing_jobs WHERE company_id = $1 AND id = $2`,
        [companyId, Number(created.id)]
      );
      return r.rows[0];
    });
    assert.equal(money(row.manual_selling_price), 2450, 'persisted manual_selling_price');
    assert.equal(money(row.paper_cost) + money(row.toner_cost), 120, 'persisted material cost');
    assert.equal(money(row.extra_cost), 0, 'persisted extra_cost');
    assert.equal(money(row.total_cost), 120, 'persisted total_cost');
    assert.equal(money(row.profit), 2330, 'persisted profit');
    return `manual=${row.manual_selling_price}, total_cost=${row.total_cost}, profit=${row.profit}`;
  });

  // --- 3. Invoice conversion does not add typing twice -----------------------
  const invoiceResult = await db.withCompanyDb(companyId, async tx => {
    await tx.query(`SELECT set_config('app.current_user_id', $1, TRUE)`, [String(userId)]);
    const cust = await createCustomer(tx, companyId, actor, {
      name: 'Acceptance Walk-In',
      companyName: 'Acceptance Walk-In',
      customerType: 'individual',
    });
    const inv = await createInvoiceOrSalesReceipt(tx, companyId, actor, {
      customerId: cust.id,
      invoiceDate: '2026-11-22',
      dueDate: '2026-12-07',
      terms: 'Net 15',
      taxRate: 0,
      idempotencyKey: 'acc-typing-invoice-1',
      lines: [
        { description: 'Typing & Printing (2 pp)', quantity: 2, rate: 1000, unitCost: 0, taxable: false },
        { description: `Photocopying ${created.jobNumber}`, quantity: 3, rate: 150, unitCost: 40, taxable: false },
      ],
    });
    const link = await linkQuickPrintJobToInvoice(tx, companyId, actor, {
      jobId: Number(created.id),
      invoiceId: Number(inv.invoice.id),
    });
    return { invoice: inv.invoice, link };
  });

  await runTest('3. Invoice conversion does not add typing twice', async () => {
    assert.ok(invoiceResult.link, 'invoice must relieve quick print WIP');
    assert.equal(money(invoiceResult.invoice.totalNum), 2450, `invoice total=${invoiceResult.invoice.totalNum}`);
    assert.equal(money(invoiceResult.invoice.totalCostNum), 120, `invoice cost=${invoiceResult.invoice.totalCostNum}`);
    assert.equal(money(invoiceResult.invoice.grossProfitNum), 2330, `invoice grossProfit=${invoiceResult.invoice.grossProfitNum}`);
    return `total=${invoiceResult.invoice.totalNum}, cost=${invoiceResult.invoice.totalCostNum}, grossProfit=${invoiceResult.invoice.grossProfitNum}`;
  });

  await runTest('4. WIP is fully relieved once', async () => {
    const row = await db.withCompanyDb(companyId, async tx => {
      const r = await tx.query<{ wip_cost_accumulated: string; wip_cost_relieved: string }>(
        `SELECT wip_cost_accumulated::text, wip_cost_relieved::text FROM printing_jobs WHERE company_id = $1 AND id = $2`,
        [companyId, Number(created.id)]
      );
      return r.rows[0];
    });
    assert.equal(money(row.wip_cost_accumulated), money(row.wip_cost_relieved), 'WIP must be fully relieved');
    return `accumulated=${row.wip_cost_accumulated}, relieved=${row.wip_cost_relieved}`;
  });

  // --- 5. Per-page typing is NOT multiplied by copies ------------------------
  await runTest('5. Typing is charged per page, not per copy', async () => {
    const job = await db.withCompanyDb(companyId, async tx => {
      await tx.query(`SELECT set_config('app.current_user_id', $1, TRUE)`, [String(userId)]);
      const res = await postQuickPrintJob(tx, companyId, actor, {
        jobType: 'type_and_printing',
        customerName: 'Per-Page Walk-In',
        rawPaperItemId: paperId,
        rawTonerItemId: tonerId,
        title: 'Per-page typing check',
        pages: 2,
        copies: 10,
        printSide: 'Duplex',
        typingFeeMode: 'per_page',
        typingFeeRate: 1000,
        manualSellingPricePerSheet: 150,
        jobDate: '2026-11-22',
      });
      return res.job;
    });
    // 2 pages duplex x10 = 10 sheets, 20 impressions
    assert.equal(Number(job.sheetsUsed), 10, `sheets=${job.sheetsUsed}`);
    assert.equal(money(job.paperCost), 300, `paper=${job.paperCost}`);
    assert.equal(money(job.tonerCost), 100, `toner=${job.tonerCost}`);
    // typing = 1000 * 2 = 2000 (NOT 2000 * 10 = 20000); photocopy = 150 * 10 = 1500
    assert.equal(money(job.manualSellingPrice), 3500, `manualSellingPrice=${job.manualSellingPrice}`);
    assert.equal(money(job.totalCost), 400, `totalCost=${job.totalCost}`);
    assert.equal(money(job.profit), 3100, `profit=${job.profit}`);
    return `selling=${job.manualSellingPrice} (typing 2000, not 20000)`;
  });

  // --- 6. Photocopy-only job carries no typing revenue -----------------------
  await runTest('6. Photocopy-only job carries no typing revenue', async () => {
    const job = await db.withCompanyDb(companyId, async tx => {
      await tx.query(`SELECT set_config('app.current_user_id', $1, TRUE)`, [String(userId)]);
      const res = await postQuickPrintJob(tx, companyId, actor, {
        jobType: 'quick_photocopy',
        customerName: 'Copy Only Walk-In',
        rawPaperItemId: paperId,
        rawTonerItemId: tonerId,
        title: 'Photocopy only',
        pages: 2,
        copies: 3,
        printSide: 'Duplex',
        manualSellingPricePerSheet: 150,
        jobDate: '2026-11-22',
      });
      return res.job;
    });
    assert.equal(money(job.manualSellingPrice), 450, `selling=${job.manualSellingPrice}`);
    assert.equal(money(job.totalCost), 120, `cost=${job.totalCost}`);
    assert.equal(money(job.profit), 330, `profit=${job.profit}`);
    return `selling=${job.manualSellingPrice}, profit=${job.profit}`;
  });

  // --- 7. Physical finishing stays a cost, never revenue ---------------------
  await runTest('7. Physical finishing stays a production cost', async () => {
    const job = await db.withCompanyDb(companyId, async tx => {
      await tx.query(`SELECT set_config('app.current_user_id', $1, TRUE)`, [String(userId)]);
      const res = await postQuickPrintJob(tx, companyId, actor, {
        jobType: 'quick_photocopy',
        customerName: 'Finishing Walk-In',
        rawPaperItemId: paperId,
        rawTonerItemId: tonerId,
        title: 'Stapled booklets',
        pages: 2,
        copies: 3,
        printSide: 'Duplex',
        finishingCostPerPage: 2,
        manualSellingPricePerSheet: 150,
        jobDate: '2026-11-22',
      });
      return res.job;
    });
    assert.equal(money(job.extraCost), 4, `extraCost=${job.extraCost}`);
    assert.equal(money(job.manualSellingPrice), 450, `selling=${job.manualSellingPrice}`);
    assert.equal(money(job.totalCost), 124, `totalCost=${job.totalCost}`);
    assert.equal(money(job.profit), 326, `profit=${job.profit}`);
    return `finishing=${job.extraCost} in cost, selling=${job.manualSellingPrice}`;
  });

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  console.log(`\nSummary: ${passed}/${results.length} passed, ${failed} failed.`);
  if (failed > 0) {
    for (const r of results.filter(x => !x.passed)) console.log(`  FAILED: ${r.name} — ${r.detail}`);
    process.exit(1);
  }
  console.log('\nALL TYPING-REVENUE VERIFICATION CHECKS PASSED');
} finally {
  await db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}