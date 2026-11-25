import { emitAccountingUpdated } from './accountingApi';
import { requestJson } from './http';

export interface CompanySettings {
  id: number;
  slug: string;
  name: string;
  legalName: string;
  ein: string | null;
  address: string;
  cityStateZip: string;
  phone: string;
  email: string;
  website: string;
  currencySymbol: string;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  accountingMethod: string;
  /** Stored as a percentage (e.g. 16 means 16%), matching the backend contract. */
  salesTaxRate: number;
  roundingMode: string;
  decimalPlaces: number;
  /** Print-desk pricing defaults, company-scoped (company_settings key/value). */
  extraTypingFinishingPerPage: number;
  manualSellingPricePerSheet: number;
  theme: string;
  role: string;
  /** Company-scoped preferences (company_settings key/value). */
  defaultBankAccountId: string;
  defaultPaymentTerms: string;
  logoBase64: string;
  signatureBase64: string;
  documentFooter: string;
  invoiceNumberPrefix: string;
  defaultTaxCode: string;
}

export interface CompanySettingsUpdate {
  name?: string;
  legalName?: string;
  ein?: string;
  address?: string;
  cityStateZip?: string;
  phone?: string;
  email?: string;
  website?: string;
  salesTaxRate?: number;
  roundingMode?: string;
  decimalPlaces?: number;
  theme?: string;
  extraTypingFinishingPerPage?: number;
  manualSellingPricePerSheet?: number;
  defaultBankAccountId?: string;
  defaultPaymentTerms?: string;
  logoBase64?: string;
  signatureBase64?: string;
  documentFooter?: string;
  invoiceNumberPrefix?: string;
  defaultTaxCode?: string;
}

/**
 * Server-side company profile. This is the authoritative record; the browser
 * copy in AccountingContext is only a display cache.
 */
export const companyApi = {
  async getCurrent(): Promise<CompanySettings> {
    return requestJson<CompanySettings>('/api/companies/current');
  },
  async updateCurrent(payload: CompanySettingsUpdate): Promise<{ company: CompanySettings }> {
    // The PATCH response returns raw column names, so re-read the normalised
    // company settings shape rather than guessing at the payload mapping.
    await requestJson<{ company: unknown }>('/api/companies/current', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    const company = await companyApi.getCurrent();
    emitAccountingUpdated();
    return { company };
  },
};