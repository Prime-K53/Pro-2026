import type {
  ContractAssessmentMilestone,
  PrintingContract,
} from '../../types/accounting';

/**
 * Shared contract fixtures for frontend unit/component tests.
 *
 * These mirror the shape returned by `mapApiContract` and the bundled demo set
 * so tests can construct valid contracts without hitting the backend.
 */

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function makeAssessment(
  overrides: Partial<ContractAssessmentMilestone> = {}
): ContractAssessmentMilestone {
  const agreedAmount = overrides.agreedAmount ?? 20000;
  const totalCost = overrides.totalCost ?? 8000;
  return {
    assessmentNumber: 1,
    label: 'Assessment 1 — Term 1 Mid-Term Exams',
    scheduledDate: '2026-03-15',
    agreedAmount,
    rawPaperItemId: 'paper-1',
    rawTonerItemId: 'toner-1',
    estimatedSheets: 40000,
    estimatedImpressions: 80000,
    paperCost: Math.round(totalCost * 0.6),
    tonerCost: Math.round(totalCost * 0.4),
    totalCost,
    profit: agreedAmount - totalCost,
    status: 'pending',
    ...overrides,
  };
}

export function makeContract(
  overrides: Partial<PrintingContract> = {}
): PrintingContract {
  const totalPrepaidAmount = overrides.totalPrepaidAmount ?? 80000;
  const assessments =
    overrides.assessments ??
    [1, 2, 3, 4].map((n) =>
      makeAssessment({
        assessmentNumber: n,
        label: `Assessment ${n}`,
        agreedAmount: totalPrepaidAmount / 4,
      })
    );
  return {
    id: nextId('contract'),
    backendId: 1,
    contractNumber: 'PC-2026-0001',
    schoolCustomerId: 'customer-1',
    title: '2026 School Term Examination Printing Retainer',
    academicYear: '2026',
    startDate: '2026-01-10',
    endDate: '2026-12-15',
    totalPrepaidAmount,
    totalAssessments: 4,
    remainingBalance: totalPrepaidAmount,
    completedAssessments: 0,
    depositBankAccountId: 'bank-1',
    status: 'draft',
    liabilityAccountId: 2250,
    allocatedAmount: 0,
    unallocatedAmount: totalPrepaidAmount,
    creditBalance: false,
    source: 'backend',
    assessments,
    ...overrides,
  };
}

/** An active contract with a couple of completed assessments. */
export function makeActiveContract(
  overrides: Partial<PrintingContract> = {}
): PrintingContract {
  return makeContract({
    status: 'active',
    completedAssessments: 1,
    remainingBalance: 60000,
    allocatedAmount: 80000,
    activatedAt: '2026-01-12T09:00:00.000Z',
    assessments: [
      makeAssessment({ assessmentNumber: 1, status: 'completed', agreedAmount: 20000 }),
      makeAssessment({ assessmentNumber: 2, agreedAmount: 20000 }),
      makeAssessment({ assessmentNumber: 3, agreedAmount: 20000 }),
      makeAssessment({ assessmentNumber: 4, agreedAmount: 20000 }),
    ],
    ...overrides,
  });
}

/** A minimal customer record sufficient for the contract view. */
export function makeCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'customer-1',
    companyName: 'Riverside Secondary School',
    name: 'Riverside Secondary School',
    customerType: 'school',
    email: 'bursar@riverside.edu',
    phone: '+265 999 000 111',
    billingAddress: 'P.O. Box 1, Lilongwe',
    terms: 'Net 30',
    ...overrides,
  };
}