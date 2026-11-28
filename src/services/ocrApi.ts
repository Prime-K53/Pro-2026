import { requestJson } from './http';

export type OcrKind = 'quote' | 'invoice' | 'receipt' | 'supplier_bill';

export interface OcrLine {
  description: string;
  quantity: number;
  rate: number;
  amount: number;
  confidence?: number;
}

export interface OcrExtraction {
  kind: OcrKind;
  counterpartyName: string;
  counterpartyPhone?: string | null;
  counterpartyEmail?: string | null;
  date: string;
  currency: string;
  taxRate?: number | null;
  paymentMethod?: string | null;
  reference?: string | null;
  discount?: number | null;
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
  /** Confidence below the gate — the draft must be reviewed before use. */
  needsReview: boolean;
  /** A prior non-identical document with the same business identity exists. */
  businessDuplicate: boolean;
}

export const ocrApi = {
  async extract(kind: OcrKind, imageBase64: string, mime?: string): Promise<OcrExtractResult> {
    return requestJson<OcrExtractResult>('/api/ai/ocr/extract', {
      method: 'POST',
      body: JSON.stringify({ kind, imageBase64, mime }),
    });
  },
  async get(id: string): Promise<{ id: string; kind: string; extraction_jsonb: OcrExtraction; confidence: number; model: string; status: string }> {
    return requestJson(`/api/ai/ocr/${id}`);
  },
};