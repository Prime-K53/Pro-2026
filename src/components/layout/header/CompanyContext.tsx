import React from 'react';
import { Building2 } from 'lucide-react';
import type { CompanySettings } from '../../../services/companyApi';

interface CompanyContextProps {
  company: CompanySettings | null;
  loading: boolean;
  error: string | null;
  fallbackName?: string;
}

interface RegistrationParts {
  label: string;
  value: string;
}

function parseRegistration(ein: string | null | undefined): RegistrationParts | null {
  if (!ein) return null;
  const raw = ein.trim();
  if (!raw) return null;

  const prefixed = raw.match(/^(TPIN|EIN|TIN)\s*[:\-]?\s*(.+)$/i);
  if (prefixed) {
    const value = prefixed[2].trim();
    if (!value) return null;
    return { label: prefixed[1].toUpperCase(), value };
  }

  return { label: 'Reg. No.', value: raw };
}

function fiscalMonthLabel(month: number | undefined): string | null {
  if (!month || month < 1 || month > 12) return null;
  return new Intl.DateTimeFormat('en', { month: 'long' }).format(new Date(2020, month - 1, 1));
}

/**
 * Company identity rendered from the authoritative `/api/companies/current`
 * payload. Registration details are hidden unless the server supplies them;
 * the demo EIN is never used as a fallback.
 */
export const CompanyContext: React.FC<CompanyContextProps> = ({
  company,
  loading,
  error,
  fallbackName,
}) => {
  const registration = parseRegistration(company?.ein);
  const displayName =
    company?.name?.trim() ||
    fallbackName?.trim() ||
    (loading ? 'Loading company…' : 'Company information unavailable');
  const fiscalMonth = fiscalMonthLabel(company?.fiscalYearStartMonth);

  const details = [
    displayName,
    registration ? `${registration.label} ${registration.value}` : null,
    company?.baseCurrency ? `Currency ${company.baseCurrency}` : null,
    fiscalMonth ? `Fiscal year starts ${fiscalMonth}` : null,
    error ? 'Server company profile unavailable' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className={`hdr-company${loading ? ' hdr-company-loading' : ''}${
        error ? ' hdr-company-error' : ''
      }`}
      title={details}
      aria-label={details}
    >
      <span className="hdr-company-icon" aria-hidden="true">
        <Building2 className="h-3.5 w-3.5" />
      </span>
      <span className="hdr-company-copy">
        <span className="hdr-company-name">{displayName}</span>
        {registration && !loading ? (
          <span
            className="hdr-company-meta"
            aria-label={`${registration.label} ${registration.value}`}
          >
            <span className="hdr-company-meta-label">{registration.label}</span>{' '}
            <span className="hdr-company-meta-value">{registration.value}</span>
          </span>
        ) : null}
      </span>
      {loading ? (
        <span className="sr-only" role="status" aria-live="polite">
          Loading company information
        </span>
      ) : null}
    </div>
  );
};
