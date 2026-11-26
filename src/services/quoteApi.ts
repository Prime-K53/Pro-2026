import { requestJson } from './http';

export interface ApiQuoteLine {
  description: string;
  quantity: string;
  rate: string;
  amount: string;
}

export interface ApiQuoteVersion {
  id: number;
  version_no: number;
  lines: ApiQuoteLine[];
  subtotal: string;
  tax_rate?: string;
  tax_amount: string;
  total: string;
  notes: string | null;
  created_at: string;
}

export interface ApiQuote {
  id: number;
  quote_number: string;
  customer_id: number;
  customer_name?: string;
  title: string;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';
  current_version: number;
  total: string;
  tax_rate?: string;
  valid_until: string | null;
  created_at?: string;
  notes?: string | null;
}

export interface ApiQuoteDetail {
  quote: ApiQuote;
  versions: ApiQuoteVersion[];
}

export const quoteApi = {
  async list(): Promise<ApiQuote[]> {
    const d = await requestJson<{ quotes: ApiQuote[] }>('/api/quotes');
    return d.quotes || [];
  },
  async get(id: number): Promise<ApiQuoteDetail> {
    return requestJson<ApiQuoteDetail>(`/api/quotes/${id}`);
  },
  async create(payload: {
    customerId: number;
    title: string;
    validUntil?: string | null;
    notes?: string | null;
    taxRate?: number | null;
    lines: Array<{ description: string; quantity: string | number; rate: string | number }>;
  }): Promise<ApiQuoteDetail> {
    return requestJson<ApiQuoteDetail>('/api/quotes', { method: 'POST', body: JSON.stringify(payload) });
  },
  async addVersion(
    id: number,
    payload: {
      lines: Array<{ description: string; quantity: string | number; rate: string | number }>;
      notes?: string | null;
      taxRate?: number | null;
    }
  ): Promise<ApiQuoteDetail> {
    return requestJson<ApiQuoteDetail>(`/api/quotes/${id}/versions`, { method: 'POST', body: JSON.stringify(payload) });
  },
  async setStatus(id: number, status: string): Promise<ApiQuoteDetail> {
    return requestJson<ApiQuoteDetail>(`/api/quotes/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
  },
  async convert(id: number): Promise<{ quote: ApiQuote; invoice: any }> {
    return requestJson<{ quote: ApiQuote; invoice: any }>(`/api/quotes/${id}/convert`, { method: 'POST' });
  },
};