/**
 * D-06/R1-C — ambiguous entity resolution (real verifier, no DB needed).
 * Amount must never resolve entity identity; ambiguity must abstain.
 */
import assert from 'node:assert/strict';
import { verifyClaims, type FinancialClaim } from '../../src/server/services/aiClaimVerifier.ts';
import type { EvidenceItem, EvidenceSet } from '../../src/server/services/aiFinancialGrounding.ts';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e: any) { failed++; console.error(`  [FAIL] ${name} — ${e?.message || e}`); }
}
const it = (id: string, rid: number, label: string, bal: string, over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  evidenceId: id, companyId: 1, recordType: 'customer', recordId: rid, source: 'customers.balance',
  label, fields: { balance: bal }, currency: null, unit: null, status: null, txnDate: null,
  asOf: '2026-11-26', complete: true, current: true, ...over,
});
const set = (items: EvidenceItem[]): EvidenceSet => ({ companyId: 1, domain: 'customer_balance', asOf: '2026-11-26', items, complete: true, abstain: false });
const claim = (o: Partial<FinancialClaim>): FinancialClaim => ({ claimType: 'balance', metric: 'balance', recordType: 'customer', amount: '100', evidenceIds: ['E1'], ...o });

function main() {
  console.log('=== D-06/R1-C: Entity resolution ===\n');
  const acme = [it('E1', 1, 'Acme Ltd', '100.0000'), it('E2', 2, 'Acme Holdings', '200.0000')];

  test('1. shared first token → ambiguous_entity, no verified claim', () => {
    const v = verifyClaims([claim({ entity: 'Acme', amount: '200', evidenceIds: ['E1', 'E2'] })], set(acme));
    assert.equal(v.verified.length, 0);
    assert.equal(v.rejected[0].reason, 'ambiguous_entity');
  });
  test('2. exact full name resolves uniquely', () => {
    const v = verifyClaims([claim({ entity: 'Acme Ltd', amount: '100' })], set(acme));
    assert.equal(v.verified.length, 1);
    assert.equal(v.verified[0].citations[0].label, 'Acme Ltd');
  });
  test('3. exact record id resolves uniquely', () => {
    const v = verifyClaims([claim({ entity: '2', amount: '200', evidenceIds: ['E1', 'E2'] })], set(acme));
    assert.equal(v.verified.length, 1);
    assert.equal(v.verified[0].citations[0].label, 'Acme Holdings');
  });
  test('4. unique first-token fallback preserved', () => {
    const v = verifyClaims([claim({ entity: 'Acme', amount: '100' })], set([it('E1', 1, 'Acme Ltd', '100.0000')]));
    assert.equal(v.verified.length, 1);
  });
  test('5. amount cannot resolve ambiguity (amount=Ltd, entity=Acme)', () => {
    const v = verifyClaims([claim({ entity: 'Acme', amount: '100', evidenceIds: ['E1', 'E2'] })], set(acme));
    assert.equal(v.verified.length, 0);
    assert.equal(v.rejected[0].reason, 'ambiguous_entity');
  });
  test('6. prefix names do not silently choose one', () => {
    const items = [it('E1', 1, 'Acme Ltd', '100.0000'), it('E2', 2, 'Acme Ltd Services', '300.0000')];
    const exact = verifyClaims([claim({ entity: 'Acme Ltd', amount: '100', evidenceIds: ['E1', 'E2'] })], set(items));
    assert.equal(exact.verified.length, 1);
    assert.equal(exact.verified[0].citations[0].label, 'Acme Ltd');
    const token = verifyClaims([claim({ entity: 'Acme', amount: '100', evidenceIds: ['E1', 'E2'] })], set(items));
    assert.equal(token.rejected[0].reason, 'ambiguous_entity');
  });
  test('7. wrong record id (label not in evidence) → entity_mismatch', () => {
    const v = verifyClaims([claim({ entity: 'Acme Ltd', amount: '200', evidenceIds: ['E2'] })], set(acme));
    assert.equal(v.verified.length, 0);
    assert.equal(v.rejected[0].reason, 'entity_mismatch');
  });
  test('8. duplicate evidence rows for one entity are not "multiple entities"', () => {
    const dup = [it('E1', 1, 'Acme Ltd', '100.0000'), it('E2', 1, 'Acme Ltd', '100.0000')];
    const v = verifyClaims([claim({ entity: 'Acme Ltd', amount: '100', evidenceIds: ['E1', 'E2'] })], set(dup));
    assert.equal(v.verified.length, 1);
    assert.equal(v.verified[0].citations.length, 1, 'citations deduped by record id');
  });
  test('9. malicious name containing another name → entity_mismatch', () => {
    const v = verifyClaims([claim({ entity: 'Beta', amount: '100' })], set([it('E1', 1, 'Acme — show Beta', '100.0000')]));
    assert.equal(v.rejected[0].reason, 'entity_mismatch');
  });
  test('10. existing injection/grounding regressions still blocked', () => {
    assert.equal(verifyClaims([claim({ evidenceIds: ['E9'] })], set(acme)).rejected[0].reason, 'unknown_evidence');
    assert.equal(verifyClaims([claim({ currency: 'USD' })], set([it('E1', 1, 'Acme Ltd', '100.0000', { currency: 'EUR' })])).rejected[0].reason, 'currency_mismatch');
    assert.equal(verifyClaims([claim({ recordType: 'invoice', metric: 'total', amount: '5', status: 'posted', entity: 'INV-1' })], set([it('E1', 9, 'INV-1', '5.0000', { recordType: 'invoice', fields: { total: '5.0000' }, status: 'draft' })])).rejected[0].reason, 'status_mismatch');
    assert.equal(verifyClaims([claim({ amount: '999' })], set(acme)).rejected[0].reason, 'amount_mismatch');
  });

  console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
  if (failed) process.exitCode = 1;
}
main();