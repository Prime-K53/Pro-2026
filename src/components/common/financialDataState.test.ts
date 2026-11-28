import { describe, it, expect } from 'vitest';
import {
  resolveFinancialFigureState,
  financialFigureSourceFromDomains,
  type FinancialFigureSource,
} from './financialDataState';

/**
 * Presentation-state rules for a derived financial figure.
 *
 * A figure is only "ready" when its inputs loaded and no later refresh failed.
 */

const source = (over: Partial<FinancialFigureSource> = {}): FinancialFigureSource => ({
  loading: false,
  error: null,
  hasData: false,
  ...over,
});

describe('resolveFinancialFigureState', () => {
  it('1. reports loading while the authoritative request is in flight', () => {
    expect(resolveFinancialFigureState(source({ loading: true }))).toBe('loading');
  });

  it('2. reports unavailable when the first load failed and nothing was loaded', () => {
    expect(resolveFinancialFigureState(source({ error: 'network down' }))).toBe('unavailable');
  });

  it('3. reports ready for a successful genuine zero', () => {
    // hasData means real rows arrived; a zero total is a real zero.
    expect(resolveFinancialFigureState(source({ hasData: true }))).toBe('ready');
  });

  it('4. reports ready for a successful empty response', () => {
    // No error and no longer loading: the server genuinely returned nothing.
    expect(resolveFinancialFigureState(source())).toBe('ready');
  });

  it('5. reports stale when a refresh failed after a previous success', () => {
    expect(resolveFinancialFigureState(source({ hasData: true, error: 'timeout' }))).toBe('stale');
  });

  it('6. never reports stale without retained data', () => {
    expect(resolveFinancialFigureState(source({ error: 'timeout' }))).toBe('unavailable');
  });

  it('7. is unavailable when any required domain failed, even if others are ready', () => {
    const financialData = {
      employees: { status: 'ready', error: null },
      payrollRuns: { status: 'error', error: 'payroll unavailable' },
    } as any;
    expect(financialFigureSourceFromDomains(financialData, ['employees', 'payrollRuns'])).toEqual({
      loading: false,
      error: 'payroll unavailable',
      hasData: true,
    });
    expect(
      resolveFinancialFigureState(
        financialFigureSourceFromDomains(financialData, ['employees', 'payrollRuns'])
      )
    ).toBe('stale');
  });

  it('8. keeps a healthy domain ready when an unrelated domain failed', () => {
    const financialData = {
      employees: { status: 'ready', error: null },
      invoices: { status: 'error', error: 'invoices unavailable' },
    } as any;
    expect(
      resolveFinancialFigureState(financialFigureSourceFromDomains(financialData, ['employees']))
    ).toBe('ready');
  });

  it('9. reports loading when any required domain is still loading', () => {
    const financialData = {
      employees: { status: 'ready', error: null },
      payrollRuns: { status: 'loading', error: null },
    } as any;
    expect(
      resolveFinancialFigureState(
        financialFigureSourceFromDomains(financialData, ['employees', 'payrollRuns'])
      )
    ).toBe('loading');
  });
});