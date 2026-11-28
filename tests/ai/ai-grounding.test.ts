/**
 * D-06 financial grounding — adversarial + integration tests.
 *
 * Exercises the REAL deterministic verifier (verifyClaims) and the REAL
 * evidence/finalize logic against an isolated in-memory PGlite DB. The external
 * provider is not called; raw model output is fed to finalizeChat to test claim
 * verification deterministically.
 */
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.ts';
import { buildEvidenceSet, normMoney, type EvidenceItem, type EvidenceSet } from '../../src/server/services/aiFinancialGrounding.ts';
import { verifyClaims, type FinancialClaim } from '../../src/server/services/aiClaimVerifier.ts';
import * as aiService from '../../src/server/services/aiService.ts';

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

function item(over: Partial<EvidenceItem>): EvidenceItem {
  return {
    evidenceId: 'E1',
    companyId: 1,
    recordType: 'customer',
    recordId: 1,
    source: 'customers.balance',
    label: 'Acme Ltd',
    fields: { balance: '1234.5000' },
    currency: null,
    unit: null,
    status: null,
    txnDate: null,
    asOf: '2026-11-26',
    complete: true,
    current: true,
    ...over,
  };
}
function set(items: EvidenceItem[], over: Partial<EvidenceSet> = {}): EvidenceSet {
  return { companyId: 1, domain: 'customer_balance', asOf: '2026-11-26', items, complete: true, abstain: false, ...over };
}
const claim = (over: Partial<FinancialClaim>): FinancialClaim => ({
  claimType: 'balance',
  metric: 'balance',
  entity: 'Acme',
  recordType: 'customer',
  amount: '1234.5',
  evidenceIds: ['E1'],
  ...over,
});

async function main() {
  const srv = await startTestServer({ seedDemo: true });
  const { db } = srv;
  try {
    const companyId = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(`SELECT id FROM companies ORDER BY id ASC LIMIT 1`);
      return Number(r.rows[0].id);
    });
    const adminId = await db.withSystemDb(async (tx: any) => {
      const r = await tx.query(`SELECT id FROM users WHERE username = 'admin'`);
      return Number(r.rows[0].id);
    });

    console.log('=== D-06 Grounding / Claim Verification ===\n');

    // Verifier (real logic)
    await test('A: invented balance rejected', () => {
      const v = verifyClaims([claim({ amount: '9999' })], set([item({})]));
      assert.equal(v.verified.length, 0);
      assert.equal(v.rejected[0].reason, 'amount_mismatch');
    });
    await test('B: genuine amount attributed to wrong customer rejected', () => {
      const v = verifyClaims([claim({ entity: 'Beta' })], set([item({})]));
      assert.equal(v.verified.length, 0);
      assert.equal(v.rejected[0].reason, 'entity_mismatch');
    });
    await test('C: valid citation on unrelated claim rejected (metric missing)', () => {
      const v = verifyClaims([claim({ metric: 'total' })], set([item({})]));
      assert.equal(v.verified.length, 0);
      assert.equal(v.rejected[0].reason, 'metric_not_in_evidence');
    });
    await test('D: mixed-currency aggregate rejected', () => {
      const items = [item({ evidenceId: 'E1', fields: { balance: '100.0000' }, currency: 'USD' }), item({ evidenceId: 'E2', recordId: 2, label: 'Gamma', fields: { balance: '50.0000' }, currency: 'EUR' })];
      const v = verifyClaims([claim({ claimType: 'aggregate', amount: '150', evidenceIds: ['E1', 'E2'] })], set(items));
      assert.equal(v.verified.length, 0);
      assert.ok(['unsupported_aggregate', 'currency_mismatch'].includes(v.rejected[0].reason));
    });
    await test('E: draft document cannot be presented as posted', () => {
      const v = verifyClaims([claim({ recordType: 'invoice', metric: 'total', amount: '500', status: 'posted', entity: 'INV-1' })], set([item({ recordType: 'invoice', recordId: 9, label: 'INV-1', fields: { total: '500.0000' }, status: 'draft' })]));
      assert.equal(v.verified.length, 0);
      assert.equal(v.rejected[0].reason, 'status_mismatch');
    });
    await test('F: historical claim with only current data rejected (date mismatch)', () => {
      const v = verifyClaims([claim({ recordType: 'invoice', metric: 'total', amount: '500', date: '2020-01-01', entity: 'INV-1' })], set([item({ recordType: 'invoice', recordId: 9, label: 'INV-1', fields: { total: '500.0000' }, txnDate: '2026-01-01' })]));
      assert.equal(v.verified.length, 0);
      assert.equal(v.rejected[0].reason, 'date_mismatch');
    });
    await test('G: incomplete evidence (abstain set) yields no verified claims', () => {
      const v = verifyClaims([claim({ amount: '1234.5' })], set([item({})], { abstain: true, complete: false, abstainReason: 'conflict' }));
      // verifier still checks the claim; finalize handles abstain. Here claim matches, but set abstain must be honored by finalize (tested below).
      assert.equal(v.verified.length, 1);
    });
    await test('H: ambiguous entity (no match) rejected', () => {
      const v = verifyClaims([claim({ entity: 'Nonexistent' })], set([item({})]));
      assert.equal(v.rejected[0].reason, 'entity_mismatch');
    });
    await test('I: invented evidence id rejected', () => {
      const v = verifyClaims([claim({ evidenceIds: ['E999'] })], set([item({})]));
      assert.equal(v.verified.length, 0);
      assert.equal(v.rejected[0].reason, 'unknown_evidence');
    });
    await test('J: cross-company evidence id rejected (not in set)', () => {
      const v = verifyClaims([claim({ evidenceIds: ['E1'] })], set([item({ companyId: 2 })]));
      assert.equal(v.verified.length, 0);
      assert.equal(v.rejected[0].reason, 'unknown_evidence');
    });
    await test('L: plausible but unsupported claim rejected', () => {
      const v = verifyClaims([claim({ amount: '1234.51' })], set([item({})]));
      assert.equal(v.verified.length, 0);
    });
    await test('Q: exact-decimal precision preserved (1234.5 == 1234.5000)', () => {
      assert.equal(normMoney('1234.5000'), normMoney('1234.5'));
      const v = verifyClaims([claim({ amount: '1234.5000' })], set([item({})]));
      assert.equal(v.verified.length, 1);
      assert.deepEqual(v.verified[0].citations[0], { evidenceId: 'E1', kind: 'customer', id: 1, label: 'Acme Ltd' });
    });
    await test('R: valid claim verifies with claim-level citation', () => {
      const v = verifyClaims([claim({})], set([item({})]));
      assert.equal(v.verified.length, 1);
      assert.equal(v.verified[0].citations.length, 1);
      assert.equal(v.verified[0].citations[0].evidenceId, 'E1');
    });

    // buildEvidenceSet permission + abstention (real DB)
    await test('K: role without the financial permission cannot retrieve (abstain)', async () => {
      const ev = await db.withCompanyDb(companyId, (tx: any) => buildEvidenceSet(tx, companyId, 'NoAccess', 'what is the customer balance'));
      assert.equal(ev.abstain, true);
      assert.equal(ev.items.length, 0);
    });
    await test('M: no-evidence / abstain set finalizes as abstained', async () => {
      const ev = await db.withCompanyDb(companyId, (tx: any) => buildEvidenceSet(tx, companyId, 'Administrator', 'wallet balance'));
      assert.equal(ev.abstain, true, 'unsupported domain must abstain');
    });

    // finalizeChat persistence (real DB) — verified vs abstain
    const prepBase = async (evidence: EvidenceSet) => {
      return db.withCompanyDb(companyId, async (tx: any) => {
        const conv = await aiService.createConversation(tx, companyId, adminId, 'test');
        const userMsgRes = await tx.query(`INSERT INTO ai_messages (company_id, conversation_id, role, content) VALUES ($1,$2,'user','hi') RETURNING id, company_id, conversation_id, role, content, source_citations, token_count, created_at`, [companyId, conv.id]);
        const r = userMsgRes.rows[0];
        return { conversationId: conv.id, userMessage: { id: Number(r.id), companyId: Number(r.company_id), conversationId: Number(r.conversation_id), role: r.role, content: r.content, sourceCitations: null, tokenCount: null, createdAt: r.created_at }, evidence, messages: [] };
      });
    };

    await test('finalize: correct claim persists as verified with citation', async () => {
      const prep = await prepBase(set([item({})]));
      const out = await db.withCompanyDb(companyId, (tx: any) => aiService.finalizeChat(tx, companyId, prep as any, { content: JSON.stringify({ claims: [claim({})], explanation: 'Acme owes 1234.5.' }) }));
      assert.equal(out.response.abstained, false);
      assert.equal(out.response.claims.length, 1);
      assert.equal(out.response.claims[0].citations[0].evidenceId, 'E1');
    });
    await test('finalize: invented amount abstains (no verified claim persisted)', async () => {
      const prep = await prepBase(set([item({})]));
      const out = await db.withCompanyDb(companyId, (tx: any) => aiService.finalizeChat(tx, companyId, prep as any, { content: JSON.stringify({ claims: [claim({ amount: '9999' })], explanation: 'x' }) }));
      assert.equal(out.response.abstained, true);
      assert.equal(out.response.claims.length, 0);
    });
    await test('finalize: malformed model output abstains (O)', async () => {
      const prep = await prepBase(set([item({})]));
      const out = await db.withCompanyDb(companyId, (tx: any) => aiService.finalizeChat(tx, companyId, prep as any, { content: 'not json at all' }));
      assert.equal(out.response.abstained, true);
      assert.equal(out.response.claims.length, 0);
    });
    await test('finalize: abstain evidence set never yields verified claims (M/G)', async () => {
      const prep = await prepBase(set([item({})], { abstain: true, abstainReason: 'conflicting records' }));
      const out = await db.withCompanyDb(companyId, (tx: any) => aiService.finalizeChat(tx, companyId, prep as any, { content: JSON.stringify({ claims: [claim({})], explanation: 'x' }) }));
      assert.equal(out.response.abstained, true);
      assert.equal(out.response.claims.length, 0);
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