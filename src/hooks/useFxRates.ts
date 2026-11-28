import { useCallback, useEffect, useMemo, useState } from 'react';
import { commercialApi } from '../services/commercialApi';
import { companyApi } from '../services/companyApi';
import { useAuth } from '../context/AuthContext';

export interface FxRate {
  id: number;
  fromCurrency: string;
  toCurrency: string;
  rateDate: string;
  rate: number;
  rateStr: string;
  source: string;
}

export interface CurrencyOption {
  code: string;
  label: string;
  isBase: boolean;
  /** Latest stored rate from this currency to the company base currency, if known. */
  rateToBase: number | null;
}

const ALWAYS_AVAILABLE = ['ZMW', 'USD', 'ZAR', 'GBP', 'EUR'];

export interface UseFxRatesResult {
  options: CurrencyOption[];
  baseCurrency: string;
  loading: boolean;
  error: string | null;
  /** Latest rate from `code` to the company base currency, or null when unknown. */
  rateFor: (code: string) => number | null;
  refresh: () => void;
}

/**
 * Loads the company's FX rate store and derives the currency list used by
 * every currency selector.
 *
 * Previously the invoice and bill screens hard-coded ZMW/USD/ZAR even though
 * the server supports arbitrary ISO currency codes through `/api/fx/rates`.
 */
export function useFxRates(): UseFxRatesResult {
  const { activeCompany, hasPermission } = useAuth();
  const canRead = hasPermission('accounts:read');
  const [rates, setRates] = useState<FxRate[]>([]);
  const [companyBase, setCompanyBase] = useState<string | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    if (!canRead) {
      setRates([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // The company record owns the base currency; the rate store only
        // describes the conversion pairs against it.
        const company = await companyApi.getCurrent().catch(() => null);
        if (cancelled) return;
        setCompanyBase(company?.baseCurrency?.toUpperCase() || null);

        const rows = await commercialApi.listExchangeRates();
        if (cancelled) return;
        setRates(
          (rows || []).map((r: any) => ({
            id: Number(r.id),
            fromCurrency: String(r.fromCurrency || r.from_currency || '').toUpperCase(),
            toCurrency: String(r.toCurrency || r.to_currency || '').toUpperCase(),
            rateDate: r.rateDate || r.rate_date || '',
            rate: Number(r.rate ?? 0),
            rateStr: String(r.rateStr ?? r.rate ?? '0'),
            source: r.source || 'manual',
          }))
        );
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Unable to load exchange rates');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canRead, activeCompany?.id, nonce]);

  const baseCurrency = useMemo(() => {
    if (companyBase) return companyBase;
    const toBase = rates.find(r => r.toCurrency && r.toCurrency !== r.fromCurrency);
    return toBase?.toCurrency || '';
  }, [companyBase, rates]);

  const options = useMemo<CurrencyOption[]>(() => {
    const codes = new Set<string>();
    ALWAYS_AVAILABLE.forEach(c => codes.add(c));
    rates.forEach(r => {
      if (r.fromCurrency && r.fromCurrency !== baseCurrency) codes.add(r.fromCurrency);
      if (r.toCurrency && r.toCurrency !== baseCurrency) codes.add(r.toCurrency);
    });
    if (baseCurrency) codes.add(baseCurrency);

    return Array.from(codes)
      .filter(Boolean)
      .sort((a, b) => (a === baseCurrency ? -1 : b === baseCurrency ? 1 : a.localeCompare(b)))
      .map(code => ({
        code,
        label: baseCurrency && code === baseCurrency ? `${code} (Base)` : code,
        isBase: Boolean(baseCurrency && code === baseCurrency),
        rateToBase: baseCurrency ? latestRateToBase(code, baseCurrency, rates) : null,
      }));
  }, [rates, baseCurrency]);

  const rateFor = useCallback(
    (code: string) => (baseCurrency ? latestRateToBase(code.toUpperCase(), baseCurrency, rates) : null),
    [rates, baseCurrency]
  );

  return { options, baseCurrency, loading, error, rateFor, refresh };
}

/** Most recent stored rate converting `from` into `base` (direct or inverted). */
function latestRateToBase(from: string, base: string, rates: FxRate[]): number | null {
  if (!from || !base) return null;
  if (from === base) return 1;

  const toBase = rates.find(r => r.fromCurrency === from && r.toCurrency === base);
  if (toBase && toBase.rate > 0) return toBase.rate;

  const fromBase = rates.find(r => r.fromCurrency === base && r.toCurrency === from);
  if (fromBase && fromBase.rate > 0) return 1 / fromBase.rate;

  return null;
}
