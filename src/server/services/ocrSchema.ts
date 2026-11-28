import { z } from 'zod';

/**
 * Structured extraction returned by the vision model for a quote/invoice OCR.
 * The model is instructed to return ONLY this JSON; totals are recomputed
 * server-side and never trusted from the model.
 */
export const OcrLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  amount: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
});
export type OcrLine = z.infer<typeof OcrLineSchema>;

export const OcrExtractionSchema = z.object({
  kind: z.enum(['quote', 'invoice', 'receipt', 'supplier_bill']),
  counterpartyName: z.string().min(1),
  counterpartyPhone: z.string().optional().nullable(),
  counterpartyEmail: z.string().optional().nullable(),
  date: z.string().min(1),
  currency: z.string().min(1),
  taxRate: z.number().min(0).max(100).optional().nullable(),
  paymentMethod: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  discount: z.number().nonnegative().optional().nullable(),
  lines: z.array(OcrLineSchema).min(1),
  subtotal: z.number().nonnegative(),
  tax: z.number().nonnegative().optional().nullable(),
  total: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  rawText: z.string().optional().nullable(),
});
export type OcrExtraction = z.infer<typeof OcrExtractionSchema>;

export type OcrKind = OcrExtraction['kind'];

/** Parse + validate model output; throws a friendly error on malformed JSON. */
export function parseOcrExtraction(raw: string): OcrExtraction {
  let json: unknown;
  try {
    const cleaned = raw
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    json = JSON.parse(cleaned);
  } catch {
    throw new Error('The AI returned an unreadable extraction. Please try a clearer image.');
  }
  const parsed = OcrExtractionSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`The AI extraction was incomplete: ${parsed.error.issues[0]?.message || 'invalid'}`);
  }
  return parsed.data;
}