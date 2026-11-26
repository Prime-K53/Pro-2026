import { describe, it, expect } from 'vitest';
import { validateContractDocument } from './contractSchemas';

const validDoc = {
  header: {
    contractNumber: 'PC-2026-0001',
    schoolCustomerId: 'customer-1',
    schoolName: 'Riverside Secondary School',
    title: '2026 Retainer',
    academicYear: '2026',
    startDate: '2026-01-10',
    endDate: '2026-12-15',
    totalPrepaidAmount: '80000',
    totalAssessments: 4,
    remainingBalance: '80000',
    completedAssessments: 0,
    depositBankAccountId: 'bank-1',
  },
  lines: [
    {
      assessmentNumber: 1,
      label: 'Assessment 1',
      scheduledDate: '2026-03-15',
      agreedAmount: '20000',
      estimatedSheets: 40000,
      estimatedImpressions: 80000,
      paperCost: '4800',
      tonerCost: '3200',
      totalCost: '8000',
      profit: '12000',
      status: 'pending',
    },
  ],
};

describe('validateContractDocument', () => {
  it('accepts a well-formed contract document', () => {
    const res = validateContractDocument(validDoc);
    expect(res.success).toBe(true);
  });

  it('rejects a document with too few assessments in the header', () => {
    const bad = {
      ...validDoc,
      header: { ...validDoc.header, totalAssessments: 1 },
    };
    const res = validateContractDocument(bad);
    expect(res.success).toBe(false);
  });

  it('rejects a document with no lines', () => {
    const res = validateContractDocument({ ...validDoc, lines: [] });
    expect(res.success).toBe(false);
  });
});