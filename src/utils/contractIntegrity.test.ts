import { describe, it, expect } from 'vitest';
import {
  stableStringify,
  computeContractIntegrity,
  shortIntegrityCode,
} from './contractIntegrity';
import { makeContract } from '../test/fixtures/contracts';

describe('contract integrity', () => {
  it('stableStringify is key-order independent', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('shortIntegrityCode formats as xxxx-xxxx-xxxx', () => {
    expect(shortIntegrityCode('0123456789abcdef')).toBe('0123-4567-89ab');
  });

  it('produces a deterministic hash for the same contract', async () => {
    const a = await computeContractIntegrity(makeContract({ id: 'x', backendId: 1 }));
    const b = await computeContractIntegrity(makeContract({ id: 'y', backendId: 2 }));
    // Same material fields (id/backendId excluded) → identical hash.
    expect(a.hash).toBe(b.hash);
    expect(a.shortCode).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  });

  it('changes the hash when a material field changes', async () => {
    const base = await computeContractIntegrity(makeContract());
    const changed = await computeContractIntegrity(
      makeContract({ title: 'A different title' })
    );
    expect(changed.hash).not.toBe(base.hash);
  });
});