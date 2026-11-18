import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCOUNTING_UPDATED_EVENT } from '../services/accountingApi';
import { companyApi, type CompanySettings } from '../services/companyApi';

interface CompanyIdentityState {
  company: CompanySettings | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Reads the active company from the server rather than trusting the browser
 * display cache. Registration details are only ever rendered from this
 * authoritative payload, so demo data can never leak into the header.
 */
export function useCompanyIdentity(companyId: number | undefined): CompanyIdentityState {
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [loading, setLoading] = useState(Boolean(companyId));
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    if (!companyId) {
      requestSequence.current += 1;
      setCompany(null);
      setLoading(false);
      setError(null);
      return;
    }

    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError(null);

    try {
      const result = await companyApi.getCurrent();
      if (requestSequence.current !== sequence) return;
      setCompany(result);
    } catch (err) {
      if (requestSequence.current !== sequence) return;
      setCompany(null);
      setError(err instanceof Error ? err.message : 'Company information is unavailable');
    } finally {
      if (requestSequence.current === sequence) {
        setLoading(false);
      }
    }
  }, [companyId]);

  // A company switch must never keep the previous company's registration
  // number on screen while the new payload is in flight.
  useEffect(() => {
    setCompany(null);
    void load();
  }, [load]);

  useEffect(() => {
    const handleAccountingUpdated = () => {
      void load();
    };
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handleAccountingUpdated);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handleAccountingUpdated);
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return { company, loading, error, reload };
}
