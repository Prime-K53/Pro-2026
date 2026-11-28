/**
 * Phase 1 — Financial intelligence evidence domains + aggregate verification.
 *
 * Uses the REAL buildEvidenceSet against an isolated in-memory PGlite DB and the
 * REAL verifyClaims. The external provider is never called.
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import { buildEvidenceSet, resolvePeriod } from '../../src/server/services/aiFinancialGrounding.ts';
import { verifyClaims, type FinancialClaim } from '../../src/server/services/aiClaimVerifier.ts';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  [FAIL] ${name} — ${err?.message || err}`);
  }
}

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const { db } = srv;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(`SELECT id FROM companies ORDER BY id ASC LIMIT 1`);
      return Number(r.rows[0].id);
    });

    console.log('=== Phase 1: Financial Intelligence Domains ===\n');

    const domains: Array<[string, string]> = [
      ['what is our net profit this year', 'profit_and_loss'],
      ['show me the balance sheet', 'balance_sheet'],
      ['give me the cash flow statement', 'cash_flow'],
      ['show the trial balance', 'trial_balance'],
      ['accounts receivable aging', 'ar_aging'],
      ['accounts payable aging', 'ap_aging'],
      ['budget vs actual for this year', 'budget_vs_actual'],
      ['printing job profitability this year', 'job_profitability'],
      ['inventory valuation', 'inventory_valuation'],
    ];

    for (const [q, expectedDomain] of domains) {
      await test(`domain routes to ${expectedDomain} (non-abstain) for "${q}"`, async () => {
        const ev = await db.withCompanyDb(companyId, (tx: any) =>
          buildEvidenceSet(tx, companyId, 'Administrator', q)
        );
        assert.equal(ev.domain, expectedDomain, `expected ${expectedDomain}, got ${ev.domain}`);
        assert.equal(ev.abstain, false, `should not abstain: ${ev.abstainReason || ''}`);
        assert.ok(ev.items.length >= 1, 'expected at least one evidence item');
      });
    }

    await test('role without reports:read abstains on profit question', async () => {
      const ev = await db.withCompanyDb(companyId, (tx: any) =>
        buildEvidenceSet(tx, companyId, 'NoAccess', 'what is our net profit')
      );
      assert.equal(ev.domain, 'profit_and_loss');
      assert.equal(ev.abstain, true);
      assert.equal(ev.items.length, 0);
    });

    await test('aggregate claim matching the report total verifies', async () => {
      const ev = await db.withCompanyDb(companyId, (tx: any) =>
        buildEvidenceSet(tx, companyId, 'Administrator', 'net profit this year')
      );
      const item = ev.items[0];
      const amount = item.fields.netIncome;
      const claim: FinancialClaim = {
        claimType: 'aggregate',
        metric: 'netIncome',
        recordType: 'profit_and_loss',
        amount,
        evidenceIds: [item.evidenceId],
      };
      const v = verifyClaims([claim], ev);
      assert.equal(v.verified.length, 1, JSON.stringify(v.rejected));
      assert.equal(v.verified[0].citations[0].evidenceId, item.evidenceId);
    });

    await test('fabricated aggregate amount is rejected', async () => {
      const ev = await db.withCompanyDb(companyId, (tx: any) =>
        buildEvidenceSet(tx, companyId, 'Administrator', 'net profit this year')
      );
      const item = ev.items[0];
      const claim: FinancialClaim = {
        claimType: 'aggregate',
        metric: 'netIncome',
        recordType: 'profit_and_loss',
        amount: '999999.9999',
        evidenceIds: [item.evidenceId],
      };
      const v = verifyClaims([claim], ev);
      assert.equal(v.verified.length, 0);
      assert.equal(v.rejected[0].reason, 'amount_mismatch');
    });

    await test('aggregate spanning two report records is rejected', () => {
      const ev = {
        companyId: 1,
        domain: 'profit_and_loss',
        asOf: '2026-11-27',
        complete: true,
        abstain: false,
        items: [
          { evidenceId: 'E1', companyId: 1, recordType: 'profit_and_loss', recordId: 0, source: 'x', label: 'P&L A', fields: { netIncome: '100.0000' }, currency: null, unit: null, status: null, txnDate: null, asOf: '2026-11-27', complete: true, current: true },
          { evidenceId: 'E2', companyId: 1, recordType: 'profit_and_loss', recordId: 1, source: 'y', label: 'P&L B', fields: { netIncome: '50.0000' }, currency: null, unit: null, status: null, txnDate: null, asOf: '2026-11-27', complete: true, current: true },
        ],
      } as any;
      const claim: FinancialClaim = { claimType: 'aggregate', metric: 'netIncome', recordType: 'profit_and_loss', amount: '150', evidenceIds: ['E1', 'E2'] };
      const v = verifyClaims([claim], ev);
      assert.equal(v.verified.length, 0);
      assert.equal(v.rejected[0].reason, 'unsupported_aggregate');
    });

    await test('resolvePeriod parses explicit month/year', () => {
      const p = resolvePeriod('what was profit in November 2026');
      assert.equal(p.startDate, '2026-11-01');
      assert.equal(p.endDate, '2026-11-30');
    });

    await test('resolvePeriod parses explicit ISO date', () => {
      const p = resolvePeriod('balance sheet as of 2026-03-15');
      assert.equal(p.asOfDate, '2026-03-15');
    });

    console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await srv.close();
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});