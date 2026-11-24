import { requestJson } from './http';

export interface ApiTaxCode {
  id: number;
  code: string;
  name: string;
  rate: string;
  jurisdiction: string;
  is_active: boolean;
}

export const taxApi = {
  async listCodes(): Promise<ApiTaxCode[]> {
    const d = await requestJson<{ codes: ApiTaxCode[] }>('/api/tax-codes');
    return d.codes || [];
  },
  async createCode(payload: {
    code: string;
    name: string;
    rate: string | number;
    jurisdiction?: string | null;
  }): Promise<ApiTaxCode> {
    const d = await requestJson<{ code: ApiTaxCode }>('/api/tax-codes', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.code;
  },
  async summary(startDate: string, endDate: string): Promise<any> {
    const qs = new URLSearchParams({ startDate, endDate });
    return requestJson(`/api/reports/tax-summary?${qs.toString()}`);
  },
};