import { requestJson } from './http';

export interface OcrLine {
  description: string;
  quantity: number;
  rate: number;
  amount: number;
  confidence?: number;
}

export interface OcrExtraction {
  kind: 'quote' | 'invoice';
  counterpartyName: string;
  counterpartyPhone?: string | null;
  counterpartyEmail?: string | null;
  date: string;
  currency: string;
  taxRate?: number | null;
  lines: OcrLine[];
  subtotal: number;
  tax?: number | null;
  total: number;
  confidence: number;
  rawText?: string | null;
}

export interface OcrExtractResult {
  id: string;
  imageHash: string;
  extraction: OcrExtraction;
  model: string;
  duplicate: boolean;
}

export const ocrApi = {
  async extract(kind: 'quote' | 'invoice', imageBase64: string, mime?: string): Promise<OcrExtractResult> {
    return requestJson<OcrExtractResult>('/api/ai/ocr/extract', {
      method: 'POST',
      body: JSON.stringify({ kind, imageBase64, mime }),
    });
  },
  async get(id: string): Promise<{ id: string; kind: string; extraction_jsonb: OcrExtraction; confidence: number; model: string; status: string }> {
    return requestJson(`/api/ai/ocr/${id}`);
  },
};