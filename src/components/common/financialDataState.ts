import { useAccounting, type FinancialDataDomain } from '../../context/AccountingContext';

/**
 * Truthful presentation state for a financial figure.
 *
 * A figure may only be shown as current when every input it depends on was
 * loaded successfully and no later refresh failed:
 * - `loading`     — the inputs are still being fetched; nothing is known yet.
 * - `ready`       — inputs loaded successfully (a genuine zero is a real zero).
 * - `stale`       — inputs were loaded once, but a later refresh failed.
 * - `unavailable` — the inputs never loaded; no figure can be derived.
 */
export type FinancialFigureState = 'loading' | 'ready' | 'stale' | 'unavailable';

export interface FinancialFigureSource {
  /** True while the authoritative request for these inputs is in flight. */
  loading: boolean;
  /** Message from the last failed request, or null. */
  error: string | null;
  /** True when real rows are already held for these inputs. */
  hasData: boolean;
}

/**
 * Resolve how a derived figure may be presented.
 *
 * Deliberately total-order: a failed request always wins over retained rows so
 * a refresh failure can never be presented as current data.
 */
export const resolveFinancialFigureState = (source: FinancialFigureSource): FinancialFigureState => {
  if (source.loading) return 'loading';
  if (source.error) return source.hasData ? 'stale' : 'unavailable';
  return 'ready';
};

/** Build the source state for a figure derived from AccountingContext domains. */
export const financialFigureSourceFromDomains = (
  financialData: Record<FinancialDataDomain, { status: string; error: string | null }>,
  domains: FinancialDataDomain[]
): FinancialFigureSource => {
  const states = domains.map(d => financialData[d]);
  const loading = states.some(s => s.status === 'loading');
  const error = states.map(s => s.error).find(e => Boolean(e)) ?? null;
  return { loading, error, hasData: states.some(s => s.status === 'ready') };
};

/** Convenience hook: resolve the presentation state for context-backed domains. */
export const useFinancialFigureState = (domains: FinancialDataDomain[]): FinancialFigureState => {
  const { financialData } = useAccounting();
  return resolveFinancialFigureState(financialFigureSourceFromDomains(financialData, domains));
};