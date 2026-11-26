import { describe, it, expect } from 'vitest';
import {
  canTransition,
  isImmutable,
  assertTransition,
  type PrintingContractStatus,
} from './contractLifecycle';

describe('contract lifecycle — void', () => {
  it('treats voided as immutable', () => {
    expect(isImmutable('voided')).toBe(true);
  });

  it('allows void from draft, active and suspended', () => {
    expect(canTransition('draft', 'VOID', 'voided')).toBe(true);
    expect(canTransition('active', 'VOID', 'voided')).toBe(true);
    expect(canTransition('suspended', 'VOID', 'voided')).toBe(true);
  });

  it('forbids void from completed / exhausted / cancelled', () => {
    expect(canTransition('completed', 'VOID', 'voided')).toBe(false);
    expect(canTransition('exhausted', 'VOID', 'voided')).toBe(false);
    expect(canTransition('cancelled', 'VOID', 'voided')).toBe(false);
  });

  it('assertTransition throws for an illegal void', () => {
    expect(() =>
      assertTransition('completed' as PrintingContractStatus, 'VOID', 'voided', 'Administrator')
    ).toThrowError(/Illegal contract transition/);
  });

  it('assertTransition permits an active void by an Administrator', () => {
    expect(() =>
      assertTransition('active' as PrintingContractStatus, 'VOID', 'voided', 'Administrator')
    ).not.toThrow();
  });
});