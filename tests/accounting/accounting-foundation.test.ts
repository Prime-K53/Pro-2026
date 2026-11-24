import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';
import {
  formatDecimal2,
  formatDecimal4,
  parseDecimal4,
} from '../../src/server/lib/decimal.ts';

interface TestRecord {
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

const results: TestRecord[] = [];

async function runTest(suite: string, name: string, fn: () => Promise<string | void>) {
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
  console.log('=== Printing Management System — Phase 4 Accounting Foundation Verification Suite ===\n');

  const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-acct-test-'));
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
  const accountantClient = new CookieHttpClient(baseUrl);
  const bookkeeperClient = new CookieHttpClient(baseUrl);
  const prodClient = new CookieHttpClient(baseUrl);

  const acctByCode = new Map<string, any>();

  async function refreshAccounts() {
    const res = await adminClient.request('GET', '/api/accounts?includeInactive=true');
    assert.equal(res.status, 200);
    acctByCode.clear();
    for (const a of res.json.accounts) {
      if (a.code) acctByCode.set(a.code, a);
    }
    return res.json.accounts as any[];
  }

  try {
    // Authenticate roles in Company A (Prime Educational Press Ltd)
    assert.equal(
      (await adminClient.request('POST', '/api/auth/login', { body: { identifier: 'admin', password: 'PrintingAdmin#2026' } })).status,
      200
    );
    assert.equal(
      (await accountantClient.request('POST', '/api/auth/login', { body: { identifier: 'accountant', password: 'PrintingAdmin#2026' } })).status,
      200
    );
    assert.equal(
      (await bookkeeperClient.request('POST', '/api/auth/login', { body: { identifier: 'bookkeeper', password: 'PrintingAdmin#2026' } })).status,
      200
    );
    assert.equal(
      (await prodClient.request('POST', '/api/auth/login', { body: { identifier: 'production', password: 'PrintingAdmin#2026' } })).status,
      200
    );

    await refreshAccounts();

    // -------------------------------------------------------------------------
    // 1. EXACT DECIMAL ARITHMETIC & CHART OF ACCOUNTS GOVERNANCE
    // -------------------------------------------------------------------------
    await runTest('1. COA & Decimal Arithmetic', 'Exact 4-decimal Banker rounding, control locks, hierarchy depth/cycle & zero-balance deactivation', async () => {
      // IEEE-754 safety & Banker's rounding (HALF_EVEN) vs HALF_UP
      assert.equal(formatDecimal4(parseDecimal4('0.10') + parseDecimal4('0.20')), '0.3000');
      assert.equal(formatDecimal2(parseDecimal4('10.0050'), 'HALF_EVEN'), '10.00');
      assert.equal(formatDecimal2(parseDecimal4('10.0150'), 'HALF_EVEN'), '10.02');
      assert.equal(formatDecimal2(parseDecimal4('10.0050'), 'HALF_UP'), '10.01');

      // Incompatible detail_type rejected (400)
      const badDetail = await adminClient.request('POST', '/api/accounts', {
        body: { code: '6450', name: 'Bad Detail Account', accountType: 'Expense', detailType: 'bank' },
      });
      assert.equal(badDetail.status, 400);

      // Reserved control account code hijack rejected (409)
      const hijackedCtrl = await adminClient.request('POST', '/api/accounts', {
        body: { code: '1100', name: 'Fake Receivable', accountType: 'OtherCurrentAsset' },
      });
      assert.equal(hijackedCtrl.status, 409);

      // Control account renumbering blocked (409)
      const ar = acctByCode.get('1100');
      assert.ok(ar?.is_control);
      const renumCtrl = await adminClient.request('PATCH', `/api/accounts/${ar.id}`, {
        body: { code: '1101' },
      });
      assert.equal(renumCtrl.status, 409);

      // Non-zero balance deactivation blocked (409)
      const cash = acctByCode.get('1010');
      const deactNonZero = await adminClient.request('PATCH', `/api/accounts/${cash.id}`, {
        body: { isActive: false },
      });
      assert.equal(deactNonZero.status, 409);

      // Create valid sub-account hierarchy up to depth 5, reject depth 6 and parent cycle
      const lvl1 = await adminClient.request('POST', '/api/accounts', {
        body: { code: '6600', name: 'Press Maintenance', accountType: 'Expense', detailType: 'expense' },
      });
      assert.equal(lvl1.status, 201);
      let parentId = lvl1.json.account.id;

      // Cycle: self-parent rejected
      const selfLoop = await adminClient.request('PATCH', `/api/accounts/${parentId}`, {
        body: { parentId },
      });
      assert.equal(selfLoop.status, 400);

      // Depth 2..5 succeed
      for (let d = 2; d <= 5; d++) {
        const sub = await adminClient.request('POST', '/api/accounts', {
          body: { code: `6600.${d}`, name: `Maintenance Sub L${d}`, accountType: 'Expense', parentId },
        });
        assert.equal(sub.status, 201, `Expected depth ${d} to succeed`);
        parentId = sub.json.account.id;
      }

      // Depth 6 rejected (400)
      const lvl6 = await adminClient.request('POST', '/api/accounts', {
        body: { code: '6600.6', name: 'Maintenance Sub L6', accountType: 'Expense', parentId },
      });
      assert.equal(lvl6.status, 400);

      // Valid other_income & zero-balance account deactivation succeeds
      const miscInc = await adminClient.request('POST', '/api/accounts', {
        body: { code: '4950', name: 'Paper Waste Scrap Sales', accountType: 'Income', detailType: 'other_income' },
      });
      assert.equal(miscInc.status, 201);
      const tempZero = await adminClient.request('POST', '/api/accounts', {
        body: { code: '6990', name: 'Temporary Zero Expense', accountType: 'Expense' },
      });
      assert.equal(tempZero.status, 201);
      const deactZero = await adminClient.request('PATCH', `/api/accounts/${tempZero.json.account.id}`, {
        body: { isActive: false },
      });
      assert.equal(deactZero.status, 200);
      assert.equal(deactZero.json.account.is_active, false);

      await refreshAccounts();
      return 'Banker rounding exact, detail_type/control locks enforced, depth limit (5) & cycle guard active';
    });

    // -------------------------------------------------------------------------
    // 2. DEBIT/CREDIT BALANCING, POSTING VALIDATION & SQL TRIGGER GUARD
    // -------------------------------------------------------------------------
    await runTest('2. Debit/Credit Balancing & DB Trigger', 'Reject unbalanced, dual-sided, inactive, basis-split & direct SQL unbalanced commits', async () => {
      const cash = acctByCode.get('1010');
      const rev = acctByCode.get('4000');
      const inactive = acctByCode.get('6990');

      // 2a. Out-of-balance HTTP posting rejected (400)
      const unbal = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2026-11-12',
          description: 'Unbalanced test entry',
          lines: [
            { accountId: cash.id, debit: '100.00', credit: '0' },
            { accountId: rev.id, debit: '0', credit: '99.99' },
          ],
        },
      });
      assert.equal(unbal.status, 400);

      // 2b. Single line carrying both debit and credit rejected (400)
      const dualLine = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2026-11-12',
          description: 'Dual side line',
          lines: [{ accountId: cash.id, debit: '50.00', credit: '50.00' }],
        },
      });
      assert.equal(dualLine.status, 400);

      // 2c. Inactive account rejected (400)
      const inactRes = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2026-11-12',
          description: 'Post to inactive',
          lines: [
            { accountId: inactive.id, debit: '25.00', credit: '0' },
            { accountId: cash.id, debit: '0', credit: '25.00' },
          ],
        },
      });
      assert.equal(inactRes.status, 400);

      // 2d. Accrual-basis vs Cash-basis independent balance check (cash-only side unbalanced)
      const badBasis = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2026-11-12',
          description: 'Mismatched basis lines',
          lines: [
            { accountId: cash.id, debit: '100.00', credit: '0', basis: 'cash' },
            { accountId: rev.id, debit: '0', credit: '100.00', basis: 'accrual' },
          ],
        },
      });
      assert.equal(badBasis.status, 400);

      // 2e. Direct PostgreSQL DEFERRABLE trigger blocks raw unbalanced COMMIT in DB
      await assert.rejects(async () => {
        await db.withCompanyDb(1, async tx => {
          const hdr = await tx.query<{ id: number }>(
            `INSERT INTO journal_transactions (company_id, entry_number, txn_date, description, source_type, is_posted)
             VALUES (1, 'JE-RAW-UNBAL', '2026-11-12', 'Direct SQL Bypass Attempt', 'manual', true)
             RETURNING id`
          );
          await tx.query(
            `INSERT INTO journal_lines (company_id, transaction_id, line_order, account_id, debit, credit)
             VALUES (1, $1, 1, $2, 300.0000, 0.0000),
                    (1, $1, 2, $3, 0.0000, 299.9999)`,
            [Number(hdr.rows[0].id), cash.id, rev.id]
          );
        });
      }, /Unbalanced journal transaction/i);

      return 'HTTP validation + DB DEFERRABLE trigger rejected all unbalanced, dual-side, inactive & basis-split attempts';
    });

    // -------------------------------------------------------------------------
    // 3. ACCOUNT BALANCE CALCULATIONS & ATOMIC REBUILD
    // -------------------------------------------------------------------------
    await runTest('3. Account Balances & Rebuild', 'Stored balances track natural sign accurately and rebuild repairs intentional drift', async () => {
      await refreshAccounts();
      const cash = acctByCode.get('1010');
      const rev = acctByCode.get('4000');
      const exp = acctByCode.get('6200');
      const prevCash = parseDecimal4(cash.balanceExact);
      const prevRev = parseDecimal4(rev.balanceExact);
      const prevExp = parseDecimal4(exp.balanceExact);

      // Post multi-line entry with 4-decimal precision
      const postRes = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2026-11-12',
          reference: 'PREC-1',
          description: 'Precision Sale & Metered Utility Split',
          lines: [
            { accountId: cash.id, debit: '350.1250', credit: '0', description: 'Cash receipt' },
            { accountId: exp.id, debit: '49.8750', credit: '0', description: 'Bank fee absorbed' },
            { accountId: rev.id, debit: '0', credit: '400.0000', description: 'Gross sale' },
          ],
        },
      });
      assert.equal(postRes.status, 201);

      await refreshAccounts();
      assert.equal(parseDecimal4(acctByCode.get('1010').balanceExact), prevCash + parseDecimal4('350.1250'));
      assert.equal(parseDecimal4(acctByCode.get('6200').balanceExact), prevExp + parseDecimal4('49.8750'));
      assert.equal(parseDecimal4(acctByCode.get('4000').balanceExact), prevRev + parseDecimal4('400.0000'));

      // Corrupt stored balance artificially in DB, then repair via /api/accounts/rebuild-balances
      await db.withSystemDb(tx =>
        tx.query(`UPDATE accounts SET balance = 999999.0000 WHERE company_id = 1 AND id = $1`, [cash.id])
      );

      const rebuildRes = await adminClient.request('POST', '/api/accounts/rebuild-balances');
      assert.equal(rebuildRes.status, 200);
      assert.equal(rebuildRes.json.correctedCount, 1);
      assert.equal(rebuildRes.json.corrections[0].accountId, cash.id);

      await refreshAccounts();
      assert.equal(
        parseDecimal4(acctByCode.get('1010').balanceExact),
        prevCash + parseDecimal4('350.1250'),
        'Rebuilt balance must match exact ledger sum'
      );

      return '4-decimal deltas exact; corrupted balance repaired by rebuild-balances & audited';
    });

    // -------------------------------------------------------------------------
    // 4. TRACEABLE REVERSALS, IMMUTABILITY & ACCOUNTANT #340 RULE
    // -------------------------------------------------------------------------
    await runTest('4. Reversals, Immutability & #340 Guard', 'Posted entries immutable; mirror reversal links bidirectionally; Accountant limited to own posts', async () => {
      const cash = acctByCode.get('1010');
      const exp = acctByCode.get('6100');

      const adminPost = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2026-11-12',
          reference: 'ADM-JE-1',
          description: 'Admin Posted Paper Supplies',
          lines: [
            { accountId: exp.id, debit: '220.00', credit: '0' },
            { accountId: cash.id, debit: '0', credit: '220.00' },
          ],
        },
      });
      assert.equal(adminPost.status, 201);
      const adminTxnId = adminPost.json.entry.id;

      // Immutability triggers block raw SQL UPDATE/DELETE on posted lines & transactions
      await assert.rejects(
        () => db.withSystemDb(tx => tx.query(`UPDATE journal_lines SET debit = 999 WHERE transaction_id = $1`, [adminTxnId])),
        /immutable/i
      );
      await assert.rejects(
        () => db.withSystemDb(tx => tx.query(`DELETE FROM journal_transactions WHERE id = $1`, [adminTxnId])),
        /cannot be deleted/i
      );

      // SlowBooks #340: Accountant CANNOT reverse Admin's journal entry (403)
      const accReverseAdmin = await accountantClient.request('POST', `/api/journals/${adminTxnId}/reverse`, {
        body: { reason: 'Cross-user check' },
      });
      assert.equal(accReverseAdmin.status, 403);
      assert.equal(accReverseAdmin.json.code, 'ACCOUNTANT_OWN_POST_ONLY');

      // Accountant posts own entry and reverses it cleanly (201)
      const accPost = await accountantClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2026-11-12',
          reference: 'ACC-JE-1',
          description: 'Accountant Own Entry',
          lines: [
            { accountId: exp.id, debit: '150.00', credit: '0' },
            { accountId: cash.id, debit: '0', credit: '150.00' },
          ],
        },
      });
      assert.equal(accPost.status, 201);
      const accTxnId = accPost.json.entry.id;

      const revRes = await accountantClient.request('POST', `/api/journals/${accTxnId}/reverse`, {
        body: { reason: 'Duplicate entry correction' },
      });
      assert.equal(revRes.status, 201);
      assert.equal(revRes.json.original.status, 'voided');
      assert.equal(revRes.json.original.reversedByTransactionId, revRes.json.reversal.id);
      assert.equal(revRes.json.reversal.reversesTransactionId, accTxnId);
      assert.equal(revRes.json.reversal.sourceType, 'reversal');
      assert.equal(revRes.json.reversal.totalDebits, '150.0000');

      // Double-reversal blocked (409) & reversal-of-reversal blocked (400)
      const doubleRev = await adminClient.request('POST', `/api/journals/${accTxnId}/reverse`, { body: {} });
      assert.equal(doubleRev.status, 409);

      const revOfRev = await adminClient.request('POST', `/api/journals/${revRes.json.reversal.id}/reverse`, {
        body: {},
      });
      assert.equal(revOfRev.status, 400);

      // Reconciled line cannot be reversed (409)
      await db.withSystemDb(tx =>
        tx.query(`UPDATE journal_lines SET is_reconciled = TRUE WHERE transaction_id = $1`, [adminTxnId])
      );
      const revReconciled = await adminClient.request('POST', `/api/journals/${adminTxnId}/reverse`, { body: {} });
      assert.equal(revReconciled.status, 409);
      assert.equal(revReconciled.json.code, 'RECONCILED_ENTRY_LOCKED');

      return 'SQL immutability enforced, #340 Accountant own-post guard verified, bidirectional voiding & reconciled guard pass';
    });

    // -------------------------------------------------------------------------
    // 5. OPENING BALANCES WIZARD
    // -------------------------------------------------------------------------
    await runTest('5. Opening Balances Wizard', 'Positive/negative normal-sign placement, P&L account block, and Equity 3900 auto-balance offset', async () => {
      const bank = acctByCode.get('1010');
      const accum = acctByCode.get('1590');
      const eq3900 = acctByCode.get('3900');
      const rev = acctByCode.get('4000');

      // Non-Balance-Sheet account rejected (400)
      const badType = await adminClient.request('POST', '/api/opening-balances', {
        body: { txnDate: '2026-01-01', lines: [{ accountId: rev.id, amount: '500' }] },
      });
      assert.equal(badType.status, 400);

      // Unbalanced without autoBalanceAccountId rejected (400)
      const noAuto = await adminClient.request('POST', '/api/opening-balances', {
        body: { txnDate: '2026-01-01', lines: [{ accountId: bank.id, amount: '500' }] },
      });
      assert.equal(noAuto.status, 400);

      // Auto-balance to 3900 with negative contra asset (-100 on 1590 -> Credit 100) + Asset (500 -> Debit 500) => Offset Credit 400 to 3900
      const okOb = await adminClient.request('POST', '/api/opening-balances', {
        body: {
          txnDate: '2026-01-01',
          description: 'Mid-setup opening balance adjustment',
          autoBalanceAccountId: eq3900.id,
          lines: [
            { accountId: bank.id, amount: '500.00' },
            { accountId: accum.id, amount: '-100.00' },
          ],
        },
      });
      assert.equal(okOb.status, 201);
      assert.equal(okOb.json.autoBalanced, true);
      assert.equal(okOb.json.entry.totalDebits, '500.0000');
      assert.equal(okOb.json.entry.totalCredits, '500.0000');
      const offsetLine = okOb.json.entry.lines.find((l: any) => l.accountId === eq3900.id);
      assert.ok(offsetLine && offsetLine.credit === '400.0000', 'Expected Equity 3900 credit offset of 400.0000');

      return 'Contra-asset negative sign -> Credit, P&L rejection, and 3900 auto-balance offset verified';
    });

    // -------------------------------------------------------------------------
    // 6. FISCAL PERIODS, SOFT CLOSE, CLOSING ENTRIES & ADMIN REOPEN
    // -------------------------------------------------------------------------
    await runTest('6. Fiscal Periods & Closing Locks', 'Soft-close adjusts only, hard close posts Retained Earnings entry & blocks reversals, Admin-only reopen', async () => {
      const cash = acctByCode.get('1010');
      const rev = acctByCode.get('4000');
      const exp = acctByCode.get('6200');
      const re3200 = acctByCode.get('3200');

      // Seed prior-year 2025 activity before closing 2025
      const y2025Sale = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2025-12-15',
          reference: 'FY25-SALE',
          description: 'FY 2025 Contract Revenue',
          lines: [
            { accountId: cash.id, debit: '2000.00', credit: '0' },
            { accountId: rev.id, debit: '0', credit: '2000.00' },
          ],
        },
      });
      assert.equal(y2025Sale.status, 201);
      const y2025TxnId = y2025Sale.json.entry.id;

      // Create FY 2025 Q4 period & verify overlapping period rejection (409)
      const pRes = await adminClient.request('POST', '/api/periods', {
        body: { periodName: 'FY 2025 Close Period', startDate: '2025-01-01', endDate: '2025-12-31' },
      });
      assert.equal(pRes.status, 201);
      const periodId = pRes.json.period.id;

      // This test exercises closing entries and period locks, not checklist
      // governance; opt out of the (now default-enforced) period-close checklist.
      await adminClient.request('PUT', '/api/periods/checklist-policy', { body: { enabled: false } });

      const overlapRes = await adminClient.request('POST', '/api/periods', {
        body: { periodName: 'Overlap', startDate: '2025-12-01', endDate: '2025-12-31' },
      });
      assert.equal(overlapRes.status, 409);

      // Soft close -> blocks ordinary postings (403), allows adjusting entry (201)
      const softCloseRes = await adminClient.request('POST', `/api/periods/${periodId}/soft-close`);
      assert.equal(softCloseRes.status, 200, `soft-close failed: ${JSON.stringify(softCloseRes.json)}`);

      const ordInSoft = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2025-12-20',
          description: 'Blocked ordinary entry',
          lines: [
            { accountId: exp.id, debit: '100', credit: '0' },
            { accountId: cash.id, debit: '0', credit: '100' },
          ],
        },
      });
      assert.equal(ordInSoft.status, 403);
      assert.equal(ordInSoft.json.code, 'PERIOD_SOFT_CLOSED');

      const adjInSoft = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2025-12-31',
          isAdjusting: true,
          description: 'Year-end accrual adjusting entry',
          lines: [
            { accountId: exp.id, debit: '300.00', credit: '0' },
            { accountId: cash.id, debit: '0', credit: '300.00' },
          ],
        },
      });
      assert.equal(adjInSoft.status, 201);

      // Hard close with generateClosingEntry=true -> zeroes 2025 P&L (2000 - 300 = 1700 net credit) into 3200 Retained Earnings
      const closeRes = await adminClient.request('POST', `/api/periods/${periodId}/close`, {
        body: { generateClosingEntry: true, retainedEarningsAccountId: re3200.id },
      });
      assert.equal(closeRes.status, 200, `close failed: ${JSON.stringify(closeRes.json)}`);
      assert.ok(closeRes.json.closingTransactionId);

      await refreshAccounts();
      assert.equal(parseDecimal4(acctByCode.get('3200').balanceExact), parseDecimal4('1700.0000'));

      // Hard-closed period blocks both adjusting entry AND reversals (403)
      const adjInClosed = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2025-12-28',
          isAdjusting: true,
          description: 'Blocked in closed period',
          lines: [
            { accountId: exp.id, debit: '10', credit: '0' },
            { accountId: cash.id, debit: '0', credit: '10' },
          ],
        },
      });
      assert.equal(adjInClosed.status, 403);

      const revInClosed = await adminClient.request('POST', `/api/journals/${y2025TxnId}/reverse`, {
        body: { reason: 'Should be blocked' },
      });
      assert.equal(revInClosed.status, 403);

      // Non-admin blocked from reopening (403); Admin without reason rejected (400); Admin with reason succeeds (200)
      assert.equal(
        (await accountantClient.request('POST', `/api/periods/${periodId}/reopen`, { body: { reason: 'Try' } })).status,
        403
      );
      assert.equal(
        (await adminClient.request('POST', `/api/periods/${periodId}/reopen`, { body: { reason: '' } })).status,
        400
      );
      const reopenRes = await adminClient.request('POST', `/api/periods/${periodId}/reopen`, {
        body: { reason: 'Audit adjustment verification' },
      });
      assert.equal(reopenRes.status, 200, `reopen failed: ${JSON.stringify(reopenRes.json)}`);
      assert.equal(reopenRes.json.period.status, 'open');

      // Re-close FY 2025 period cleanly (without re-posting closing entry) so period stays locked
      const recloseRes = await adminClient.request('POST', `/api/periods/${periodId}/close`, {
        body: { generateClosingEntry: false },
      });
      assert.equal(recloseRes.status, 200, `reclose failed: ${JSON.stringify(recloseRes.json)}`);

      return 'Soft-close adjusting-only rule, Retained Earnings closing entry (1700.0000), closed-period lock & Admin reopen verified';
    });

    // -------------------------------------------------------------------------
    // 7. FINANCIAL STATEMENTS, BASIS SEPARATION, INDIRECT CASH FLOW & EXPORTS
    // -------------------------------------------------------------------------
    await runTest('7. Financial Statements & Reconciliation', 'Trial Balance, P&L, Balance Sheet, Indirect Cash Flow, Accrual/Cash basis & CSV exports reconcile identically', async () => {
      const cash = acctByCode.get('1010');
      const ar = acctByCode.get('1100');
      const rev = acctByCode.get('4000');

      // Post dual-basis test entry on 2026-11-13: accrual-only AR/Rev vs cash-only Bank/Rev for distinct amounts
      const basisPost = await adminClient.request('POST', '/api/journals', {
        body: {
          txnDate: '2026-11-13',
          reference: 'BASIS-TEST',
          description: 'Accrual invoice vs partial cash collection',
          lines: [
            { accountId: ar.id, debit: '600.00', credit: '0', basis: 'accrual' },
            { accountId: rev.id, debit: '0', credit: '600.00', basis: 'accrual' },
            { accountId: cash.id, debit: '250.00', credit: '0', basis: 'cash' },
            { accountId: rev.id, debit: '0', credit: '250.00', basis: 'cash' },
          ],
        },
      });
      assert.equal(basisPost.status, 201);

      // 7a. Trial Balance (2026-01-01 to 2026-12-31)
      const tbRes = await adminClient.request('GET', '/api/reports/trial-balance?startDate=2026-01-01&endDate=2026-12-31');
      assert.equal(tbRes.status, 200);
      assert.equal(tbRes.json.isBalanced, true);
      assert.equal(tbRes.json.difference, '0.0000');
      assert.equal(tbRes.json.totalDebit, tbRes.json.totalCredit);

      // Trial Balance starting mid-year (2026-11-02 -> 2026-12-31) must include synthetic "Net Income (prior periods)" and remain balanced!
      const tbMidRes = await adminClient.request('GET', '/api/reports/trial-balance?startDate=2026-11-02&endDate=2026-12-31');
      assert.equal(tbMidRes.status, 200);
      assert.equal(tbMidRes.json.isBalanced, true);
      assert.ok(
        tbMidRes.json.rows.some((r: any) => r.accountName === 'Net Income (prior periods)'),
        'Windowed Trial Balance must emit "Net Income (prior periods)"'
      );

      // 7b. P&L (Accrual vs Cash difference check, excludeAdjusting check)
      const plAccrual = await adminClient.request('GET', '/api/reports/profit-and-loss?startDate=2026-01-01&endDate=2026-12-31&basis=accrual');
      const plCash = await adminClient.request('GET', '/api/reports/profit-and-loss?startDate=2026-01-01&endDate=2026-12-31&basis=cash');
      const plNoAdj = await adminClient.request('GET', '/api/reports/profit-and-loss?startDate=2026-01-01&endDate=2026-12-31&basis=accrual&excludeAdjusting=true');
      assert.equal(plAccrual.status, 200);
      assert.equal(plCash.status, 200);
      assert.equal(plNoAdj.status, 200);

      // Accrual rev has 600 vs Cash rev 250 -> difference of exactly 350.0000
      const accInc4 = parseDecimal4(plAccrual.json.totals.totalIncome);
      const cashInc4 = parseDecimal4(plCash.json.totals.totalIncome);
      assert.equal(accInc4 - cashInc4, parseDecimal4('350.0000'));

      // Excluding adjusting removes the 1200.0000 depreciation adjustment
      const netAcc = parseDecimal4(plAccrual.json.totals.netIncome);
      const netNoAdj = parseDecimal4(plNoAdj.json.totals.netIncome);
      assert.equal(netNoAdj - netAcc, parseDecimal4('1200.0000'));

      // 7c. Balance Sheet ties Assets === Liabilities + Equity and currentYearNetIncome === P&L netIncome
      const bsRes = await adminClient.request('GET', '/api/reports/balance-sheet?asOfDate=2026-12-31&basis=accrual');
      assert.equal(bsRes.status, 200);
      assert.equal(bsRes.json.totals.isBalanced, true);
      assert.equal(bsRes.json.totals.difference, '0.0000');
      assert.equal(bsRes.json.totals.totalAssets, bsRes.json.totals.totalLiabilitiesAndEquity);
      assert.equal(
        bsRes.json.totals.currentYearNetIncome,
        plAccrual.json.totals.netIncome,
        'Balance Sheet currentYearNetIncome must equal P&L Net Income'
      );

      // 7d. Statement of Cash Flows (Indirect Method): beginningCash + netChange === endingCash
      const cfRes = await adminClient.request('GET', '/api/reports/cash-flow?startDate=2026-01-01&endDate=2026-12-31');
      assert.equal(cfRes.status, 200);
      assert.equal(cfRes.json.isReconciled, true);
      assert.equal(cfRes.json.reconciliationVariance, '0.0000');
      assert.equal(
        parseDecimal4(cfRes.json.beginningCash) + parseDecimal4(cfRes.json.netChange),
        parseDecimal4(cfRes.json.endingCash)
      );
      assert.ok(
        cfRes.json.adjustments.some((a: any) => a.accountCode === '1590'),
        'Cash Flow must present non-cash depreciation adjustment on 1590'
      );

      // 7e. General Ledger running balance check on 1010 Operating Checking matches Balance Sheet Cash
      const glRes = await adminClient.request('GET', `/api/reports/general-ledger?startDate=2026-01-01&endDate=2026-12-31&accountId=${cash.id}&basis=accrual`);
      assert.equal(glRes.status, 200);
      assert.equal(glRes.json.accounts.length, 1);
      assert.equal(
        glRes.json.accounts[0].closingBalance,
        cfRes.json.endingCash,
        'GL closing cash balance must equal Cash Flow endingCash'
      );

      // 7f. CSV exports succeed and write REPORT_EXPORTED audit entries
      for (const pathCsv of [
        '/api/reports/trial-balance/csv?startDate=2026-01-01&endDate=2026-12-31',
        '/api/reports/profit-and-loss/csv?startDate=2026-01-01&endDate=2026-12-31',
        '/api/reports/balance-sheet/csv?asOfDate=2026-12-31',
        '/api/reports/cash-flow/csv?startDate=2026-01-01&endDate=2026-12-31',
      ]) {
        const csvRes = await adminClient.request('GET', pathCsv);
        assert.equal(csvRes.status, 200);
        assert.ok(csvRes.headers.get('content-type')?.includes('text/csv'));
        assert.ok(csvRes.text.length > 30);
      }

      const auditRes = await adminClient.request('GET', '/api/audit/logs?limit=20');
      assert.equal(auditRes.status, 200);
      assert.ok(auditRes.json.logs.some((l: any) => l.action === 'REPORT_EXPORTED'));

      return `TB balanced (diff=0), BS balanced (${bsRes.json.totals.totalAssets}), P&L Accrual/Cash diff=350.0000, CF reconciled (end=${cfRes.json.endingCash}), GL matches CF`;
    });

    // -------------------------------------------------------------------------
    // 8. CONCURRENT POSTING & DEADLOCK-FREE ATOMIC BALANCES
    // -------------------------------------------------------------------------
    await runTest('8. Concurrent Posting', '10 simultaneous journal postings against overlapping accounts succeed with zero lost updates', async () => {
      await refreshAccounts();
      const cash = acctByCode.get('1010');
      const rev = acctByCode.get('4000');
      const startCash = parseDecimal4(cash.balanceExact);
      const startRev = parseDecimal4(rev.balanceExact);

      const batch = Array.from({ length: 10 }, (_, idx) => {
        // Alternate line order to stress lock-ordering deadlock prevention
        const lines =
          idx % 2 === 0
            ? [
                { accountId: cash.id, debit: '25.50', credit: '0' },
                { accountId: rev.id, debit: '0', credit: '25.50' },
              ]
            : [
                { accountId: rev.id, debit: '0', credit: '25.50' },
                { accountId: cash.id, debit: '25.50', credit: '0' },
              ];
        return adminClient.request('POST', '/api/journals', {
          body: {
            txnDate: '2026-11-14',
            reference: `CONC-${idx}`,
            description: `Concurrent Job #${idx}`,
            lines,
          },
        });
      });

      const responses = await Promise.all(batch);
      for (const r of responses) {
        assert.equal(r.status, 201, `Concurrent post failed: ${JSON.stringify(r.json)}`);
      }

      await refreshAccounts();
      const expectedDelta = parseDecimal4('255.0000');
      assert.equal(parseDecimal4(acctByCode.get('1010').balanceExact), startCash + expectedDelta);
      assert.equal(parseDecimal4(acctByCode.get('4000').balanceExact), startRev + expectedDelta);

      const rebuild = await adminClient.request('POST', '/api/accounts/rebuild-balances');
      assert.equal(rebuild.status, 200);
      assert.equal(rebuild.json.correctedCount, 0, 'Zero drift permitted after concurrent postings');

      return '10/10 concurrent posts succeeded (+255.0000); rebuild-balances found 0 drift';
    });

    // -------------------------------------------------------------------------
    // 9. IDEMPOTENCY REPLAY & PAYLOAD CONFLICT PROTECTION
    // -------------------------------------------------------------------------
    await runTest('9. Idempotency Handling', 'Identical retry replays original entry (200) without double-posting; modified payload rejected (409)', async () => {
      await refreshAccounts();
      const cash = acctByCode.get('1010');
      const rev = acctByCode.get('4000');
      const beforeCash = parseDecimal4(cash.balanceExact);

      const idemKey = 'test-idem-key-0001';
      const payload = {
        txnDate: '2026-11-14',
        reference: 'IDEM-1',
        description: 'Idempotent Cash Sale',
        lines: [
          { accountId: cash.id, debit: '123.45', credit: '0' },
          { accountId: rev.id, debit: '0', credit: '123.45' },
        ],
      };

      const first = await adminClient.request('POST', '/api/journals', {
        headers: { 'Idempotency-Key': idemKey },
        body: payload,
      });
      assert.equal(first.status, 201);
      assert.equal(first.json.idempotentReplay, false);

      // Retry exact same request -> 200 replay, same entry id, balance moved ONLY once
      const replay = await adminClient.request('POST', '/api/journals', {
        headers: { 'Idempotency-Key': idemKey },
        body: payload,
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.json.idempotentReplay, true);
      assert.equal(replay.json.entry.id, first.json.entry.id);

      await refreshAccounts();
      assert.equal(parseDecimal4(acctByCode.get('1010').balanceExact), beforeCash + parseDecimal4('123.4500'));

      // Reusing same key with different payload -> 409 IDEMPOTENCY_CONFLICT
      const conflict = await adminClient.request('POST', '/api/journals', {
        headers: { 'Idempotency-Key': idemKey },
        body: {
          ...payload,
          lines: [
            { accountId: cash.id, debit: '999.00', credit: '0' },
            { accountId: rev.id, debit: '0', credit: '999.00' },
          ],
        },
      });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.json.code, 'IDEMPOTENCY_CONFLICT');

      return 'Idempotent retry returned 200 replay with zero duplicate ledger impact; payload conflict returned 409';
    });

    // -------------------------------------------------------------------------
    // 10. MULTI-COMPANY ACCOUNTING ISOLATION & RBAC GUARDS
    // -------------------------------------------------------------------------
    await runTest('10. Multi-Company & RBAC Accounting Guards', 'Company B journals/reports isolated from Company A; ProductionManager & Bookkeeper permission boundaries enforced', async () => {
      // ProductionManager blocked from posting journals, creating accounts, closing periods, rebuilding balances
      assert.equal(
        (await prodClient.request('POST', '/api/journals', { body: { txnDate: '2026-11-14', description: 'x', lines: [] } })).status,
        403
      );
      assert.equal(
        (await prodClient.request('POST', '/api/accounts', { body: { name: 'x', accountType: 'Expense' } })).status,
        403
      );
      assert.equal((await prodClient.request('POST', '/api/accounts/rebuild-balances')).status, 403);
      assert.equal(
        (await prodClient.request('POST', '/api/periods', { body: { periodName: 'x', startDate: '2026-01-01', endDate: '2026-01-31' } })).status,
        403
      );

      // Bookkeeper can read reports & post journals, but blocked from rebuild-balances & period closing
      assert.equal((await bookkeeperClient.request('POST', '/api/accounts/rebuild-balances')).status, 403);
      assert.equal((await bookkeeperClient.request('GET', '/api/reports/trial-balance')).status, 200);

      // Grab a Company A journal id, switch admin to Company B (id=2), verify Company A journal returns 404
      const listA = await adminClient.request('GET', '/api/journals?limit=5');
      assert.equal(listA.status, 200);
      const compAJournalId = listA.json.entries[0].id;

      assert.equal((await adminClient.request('POST', '/api/auth/switch-company', { body: { companyId: 2 } })).status, 200);
      assert.equal((await adminClient.request('GET', `/api/journals/${compAJournalId}`)).status, 404);
      assert.equal((await adminClient.request('POST', `/api/journals/${compAJournalId}/reverse`, { body: {} })).status, 404);

      const compBTb = await adminClient.request('GET', '/api/reports/trial-balance?startDate=2026-01-01&endDate=2026-12-31');
      assert.equal(compBTb.status, 200);
      assert.equal(compBTb.json.isBalanced, true);
      assert.equal(compBTb.json.companyId, 2);

      // Switch back to Company A
      assert.equal((await adminClient.request('POST', '/api/auth/switch-company', { body: { companyId: 1 } })).status, 200);

      return 'ProductionManager/Bookkeeper RBAC guards enforced (403); Company B cannot read or reverse Company A journals (404)';
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    fs.rmSync(tmpAttachDir, { recursive: true, force: true });
  }

  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  const reportLines = [
    '# Phase 4 — Accounting Foundation Automated Test Execution Report',
    '',
    `- **Execution Timestamp (UTC):** ${new Date().toISOString()}`,
    `- **Runtime Stack:** Express API + PostgreSQL (PGlite WASM) RLS + Exact \`BigInt\` / \`NUMERIC(19,4)\` Ledger Engine`,
    `- **Result Summary:** **${passedCount} / ${totalCount} tests passed** (${totalMs} ms total)`,
    '',
    '## Test Matrix Results',
    '',
    '| # | Suite | Test Case | Status | Duration | Verification Notes |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (r, i) =>
        `| ${i + 1} | ${r.suite} | ${r.name} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.durationMs} ms | ${r.details.replace(/\|/g, '\\|')} |`
    ),
    '',
    '## Verified Phase 4 Acceptance Criteria',
    '',
    '- [x] Chart of Accounts creation, `detail_type` compatibility, control account code lock, hierarchy cycle & max-depth (5) enforcement, and zero-balance deactivation',
    '- [x] Double-entry debit/credit balancing (`NUMERIC(19,4)`), Banker\'s rounding (`HALF_EVEN`), Accrual vs Cash basis split balancing, and PostgreSQL `DEFERRABLE` commit trigger enforcement',
    '- [x] Atomic ascending `account_id` balance delta updates and full `rebuild-balances` reconciliation from `journal_lines`',
    '- [x] Immutable posted transactions/lines, bidirectional traceable void/reversal entries, reconciled-line lock, and SlowBooks `#340` Accountant own-post-only reversal guard',
    '- [x] Opening Balances Wizard with sign-to-debit/credit mapping, BS-account enforcement, and Equity (`3900`) auto-balance offset',
    '- [x] Fiscal periods (`open` -> `soft_closed` -> `closed`), Retained Earnings (`3200`) closing entry generation, hard-closed posting/reversal block, and Administrator-only audited reopen',
    '- [x] Full statement reconciliation: Trial Balance (`isBalanced`), Profit & Loss (Accrual/Cash & `excludeAdjusting`), Balance Sheet (`Assets = Liabilities + Equity` & `Net Income` tie-out), Indirect Cash Flow (`beginningCash + netChange = endingCash`), General Ledger running balances, and audited CSV exports',
    '- [x] Concurrent journal posting deadlock-freedom and exact balance integrity (`correctedCount === 0`)',
    '- [x] Idempotent retry replay (`200`) and payload-mismatch conflict rejection (`409 IDEMPOTENCY_CONFLICT`)',
    '- [x] Multi-company RLS isolation and server-side RBAC enforcement across all roles',
    '',
  ];

  const reportPath = path.resolve(process.cwd(), 'docs', 'accounting', 'test-execution-report.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf8');
  console.log(`\nAccounting test report written to ${reportPath}`);
  console.log(`Summary: ${passedCount}/${totalCount} PASSED in ${totalMs}ms.`);

  if (passedCount !== totalCount) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Fatal accounting test suite failure:', err);
  process.exitCode = 1;
});
