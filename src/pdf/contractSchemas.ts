/**
 * Zod validation schemas for generated printing-contract documents.
 *
 * These gate the data handed to the PDF renderer so a malformed contract
 * document fails fast with a clear error instead of rendering a broken page.
 * Kept framework-agnostic so both the React preview and the server render path
 * can validate the same shape.
 */

import { z } from 'zod';

const Money = z.union([z.string(), z.number()]);

export const contractDocumentHeaderSchema = z.object({
  contractNumber: z.string().min(1),
  schoolCustomerId: z.string().min(1),
  schoolName: z.string(),
  title: z.string(),
  academicYear: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  totalPrepaidAmount: Money,
  totalAssessments: z.number().int().min(2).max(5),
  remainingBalance: Money,
  completedAssessments: z.number().int().min(0),
  depositBankAccountId: z.string(),
  notes: z.string().optional(),
});

export const contractAssessmentLineSchema = z.object({
  assessmentNumber: z.number().int().min(1),
  label: z.string(),
  scheduledDate: z.string(),
  agreedAmount: Money,
  estimatedSheets: z.number().int().min(0),
  estimatedImpressions: z.number().int().min(0),
  paperCost: Money,
  tonerCost: Money,
  totalCost: Money,
  profit: Money,
  status: z.enum(['pending', 'completed']),
  completedDate: z.string().optional(),
  linkedInvoiceNumber: z.string().optional(),
});

export const contractDocumentSchema = z.object({
  header: contractDocumentHeaderSchema,
  lines: z.array(contractAssessmentLineSchema).min(1),
});

export type ContractDocumentInput = z.infer<typeof contractDocumentSchema>;

/**
 * Validate a contract document. Returns `{ success, data }` on success or
 * `{ success: false, error }` with a readable message on failure.
 */
export function validateContractDocument(input: unknown):
  | { success: true; data: ContractDocumentInput }
  | { success: false; error: string } {
  const result = contractDocumentSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  const first = result.error.issues[0];
  const path = first?.path?.join('.') || 'document';
  return { success: false, error: `${path}: ${first?.message ?? 'invalid'}` };
}