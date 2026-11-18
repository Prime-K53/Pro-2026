import { emitAccountingUpdated } from './accountingApi';
import { requestJson } from './http';

export interface CompanySettings {
  id: number;
  slug: string;
  name: string;
  legalName: string;
  ein: string | null;
  currencySymbol: string;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  accountingMethod: string;
  /** Stored as a percentage (e.g. 16 means 16%), matching the backend contract. */
  salesTaxRate: number;
  theme: string;
  role: string;
}

/**
 * Server-side company profile. This is the authoritative record; the browser
 * copy in AccountingContext is only a display cache.
 */
export const companyApi = {
  async getCurrent(): Promise<CompanySettings> {
    return requestJson<CompanySettings>('/api/companies/current');
  },

  async updateCurrent(payload: {
    name?: string;
    legalName?: string;
    ein?: string;
    salesTaxRate?: number;
  }): Promise<{ company: CompanySettings }> {
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
