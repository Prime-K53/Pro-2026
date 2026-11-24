/**
 * @file documentContract.ts
 * @description Generic document envelope + Printing Contract projection.
 *
 * Adapted from PrimeERPsystem/contracts/DocumentContract.ts.
 *
 * This module is ADDITIVE: it does not replace the existing PrintingContract
 * type or the existing printingRecordsService. It provides a stable envelope
 * that can be used by:
 *
 *   - the documentsService (to produce a contract preview with explicit
 *     identity, lifecycle, payload, links, and hash);
 *   - the new contract layout engine (A5);
 *   - any future API consumer that wants a renderer-agnostic contract view.
 *
 * Design rules:
 *   - Keep the existing `PrintingContract` fields as the source of truth.
 *   - Compute the envelope fields (uid, version, links, hash) on the fly.
 *   - Never mutate the input contract.
 */

import type {
  CompanyProfile,
  ContractAssessmentMilestone,
  PrintingContract,
} from './accounting.ts';
import { formatDecimal4, parseDecimal4 } from '../shared/decimal.ts';
import type { Money } from './money.ts';
import { moneyFromString } from './money.ts';

/**
 * Document states for the generic document envelope.
 *
 * These are kept separate from `PrintingContract['status']` so that the
 * generic document layer can evolve without coupling to the contract domain.
 * A mapping function (`mapContractStatusToDocumentState`) bridges the two.
 */
export type DocumentState =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'FINALIZED'
  | 'CANCELLED'
  | 'CLOSED';

/**
 * High-level document categories supported by the generic envelope.
 */
export type DocumentType =
  | 'PRINTING_CONTRACT'
  | 'CONTRACT_ASSESSMENT'
  | 'CONTRACT_INVOICE'
  | 'SALES_INVOICE'
  | 'DELIVERY_NOTE';

/**
 * Immutable identity and versioning info for a document.
 */
export interface DocumentIdentity {
  /** Global UUID or composite key for database/API tracking. */
  uid: string;
  /** Human-readable ID (e.g. contract_number). */
  sequenceId: string;
  /** Discriminator for logic. */
  type: DocumentType;
  /** Incremental version for audit trails. Currently always 1. */
  version: number;
  /** Reference to previous version if revised. Not yet enabled. */
  parentUid?: string;
  /** Tenant ID. In this project, company_id as string. */
  tenantId: string;
}

/**
 * Audit and lifecycle tracking for a document.
 */
export interface DocumentLifecycle {
  state: DocumentState;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
  /** User ID or username. */
  createdBy: string;
  /** User ID or username. */
  updatedBy: string;
  /** When it moved to FINALIZED/APPROVED. */
  finalizedAt?: string;
  /** Custom classification tags. */
  tags: string[];
}

/**
 * Relationship to another document.
 */
export interface DocumentLink {
  targetUid: string;
  targetType: DocumentType;
  relationship: 'SOURCE' | 'AMENDMENT' | 'FULFILLMENT' | 'PAYMENT';
}

/**
 * Totals block for a document payload.
 */
export interface DocumentTotals {
  subtotal: Money;
  discountTotal: Money;
  grandTotal: Money;
  currency: string;
}

/**
 * Generic payload structure.
 */
export interface DocumentPayload<THeader, TLine> {
  header: THeader;
  lines: TLine[];
  totals: DocumentTotals;
}

/**
 * The root document envelope.
 */
export interface ERPDocument<THeader = unknown, TLine = unknown> {
  identity: DocumentIdentity;
  lifecycle: DocumentLifecycle;
  payload: DocumentPayload<THeader, TLine>;
  metadata: Record<string, unknown>;
  links: DocumentLink[];
  /** SHA-256 of the canonicalized payload. Optional; filled by A4. */
  hash?: string;
}

/**
 * Contract-specific header for the payload.
 */
export interface ContractDocumentHeader {
  contractNumber: string;
  schoolCustomerId: string;
  schoolName: string;
  title: string;
  academicYear: string;
  startDate: string;
  endDate: string;
  totalPrepaidAmount: Money;
  totalAssessments: number;
  remainingBalance: Money;
  completedAssessments: number;
  depositBankAccountId: string;
  notes?: string;
}

/**
 * Contract assessment line for the payload.
 */
export interface ContractAssessmentLine {
  assessmentNumber: number;
  label: string;
  scheduledDate: string;
  agreedAmount: Money;
  estimatedSheets: number;
  estimatedImpressions: number;
  paperCost: Money;
  tonerCost: Money;
  totalCost: Money;
  profit: Money;
  status: 'pending' | 'completed';
  completedDate?: string;
  linkedInvoiceNumber?: string;
}

/**
 * Maps a PrintingContract status to a generic DocumentState.
 *
 * Mapping:
 *   draft      → DRAFT
 *   active     → APPROVED
 *   suspended  → PENDING_REVIEW
 *   completed  → FINALIZED
 *   exhausted  → FINALIZED
 *   cancelled  → CANCELLED
 */
export function mapContractStatusToDocumentState(
  status: PrintingContract['status']
): DocumentState {
  switch (status) {
    case 'draft':
      return 'DRAFT';
    case 'active':
      return 'APPROVED';
    case 'suspended':
      return 'PENDING_REVIEW';
    case 'completed':
      return 'FINALIZED';
    case 'exhausted':
      return 'FINALIZED';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'DRAFT';
  }
}

/**
 * Builds a Money value from a decimal string and a currency.
 */
function moneyFromDecimalString(amount: string, currency: string): Money {
  return moneyFromString(formatDecimal4(parseDecimal4(amount)), currency, 4);
}

/**
 * Builds a Money value from a number (for values that are already JS numbers).
 */
function moneyFromNumberValue(value: number, currency: string): Money {
  return moneyFromString(value.toFixed(4), currency, 4);
}

/**
 * Projects a PrintingContract + its assessments into the generic ERPDocument.
 *
 * This function is pure: it does not mutate the input and does not perform I/O.
 * The `company` argument is used to fill currency and company name in the
 * header. If omitted, defaults to ZMW and empty company name.
 */
export function mapContractToDocumentContract(
  contract: PrintingContract,
  assessments: ContractAssessmentMilestone[],
  company?: Pick<CompanyProfile, 'name' | 'legalName' | 'currency'> | null
): ERPDocument<ContractDocumentHeader, ContractAssessmentLine> {
  const currency = company?.currency ?? 'ZMW';
  const nowIso = new Date().toISOString();

  const header: ContractDocumentHeader = {
    contractNumber: contract.contractNumber,
    schoolCustomerId: contract.schoolCustomerId,
    schoolName: '', // Caller may overlay this from the customers join
    title: contract.title,
    academicYear: contract.academicYear,
    startDate: contract.startDate,
    endDate: contract.endDate,
    totalPrepaidAmount: moneyFromNumberValue(contract.totalPrepaidAmount, currency),
    totalAssessments: contract.totalAssessments,
    remainingBalance: moneyFromNumberValue(contract.remainingBalance, currency),
    completedAssessments: contract.completedAssessments,
    depositBankAccountId: contract.depositBankAccountId,
    notes: contract.notes,
  };

  const lines: ContractAssessmentLine[] = assessments.map((a) => ({
    assessmentNumber: a.assessmentNumber,
    label: a.label,
    scheduledDate: a.scheduledDate,
    agreedAmount: moneyFromNumberValue(a.agreedAmount, currency),
    estimatedSheets: a.estimatedSheets,
    estimatedImpressions: a.estimatedImpressions,
    paperCost: moneyFromNumberValue(a.paperCost, currency),
    tonerCost: moneyFromNumberValue(a.tonerCost, currency),
    totalCost: moneyFromNumberValue(a.totalCost, currency),
    profit: moneyFromNumberValue(a.profit, currency),
    status: a.status,
    completedDate: a.completedDate,
    linkedInvoiceNumber: a.linkedInvoiceNumber,
  }));

  const subtotalScaled = assessments.reduce(
    (acc, a) => acc + parseDecimal4(String(a.agreedAmount)),
    0n
  );

  const totals: DocumentTotals = {
    subtotal: moneyFromString(formatDecimal4(subtotalScaled), currency, 4),
    discountTotal: moneyFromString(formatDecimal4(0n), currency, 4),
    grandTotal: moneyFromNumberValue(contract.totalPrepaidAmount, currency),
    currency,
  };

  const links: DocumentLink[] = [];
  if (contract.renewalOfContractId != null) {
    links.push({
      targetUid: `contract-${contract.renewalOfContractId}`,
      targetType: 'PRINTING_CONTRACT',
      relationship: 'SOURCE',
    });
  }
  if (contract.depositInvoiceId) {
    links.push({
      targetUid: contract.depositInvoiceId,
      targetType: 'CONTRACT_INVOICE',
      relationship: 'PAYMENT',
    });
  }
  for (const a of assessments) {
    if (a.linkedInvoiceId) {
      links.push({
        targetUid: a.linkedInvoiceId,
        targetType: 'CONTRACT_INVOICE',
        relationship: 'FULFILLMENT',
      });
    }
  }

  return {
    identity: {
      uid: `contract-${contract.id}`,
      sequenceId: contract.contractNumber,
      type: 'PRINTING_CONTRACT',
      version: 1,
      tenantId: String(contract.schoolCustomerId),
    },
    lifecycle: {
      state: mapContractStatusToDocumentState(contract.status),
      createdAt: contract.startDate,
      updatedAt: contract.updatedAt ?? contract.startDate,
      createdBy: String(contract.activatedBy ?? ''),
      updatedBy: String(contract.completedBy ?? contract.activatedBy ?? ''),
      finalizedAt: contract.completedAt,
      tags: [contract.academicYear, contract.status],
    },
    payload: {
      header,
      lines,
      totals,
    },
    metadata: {
      liabilityAccountId: contract.liabilityAccountId,
      unallocatedAmount: contract.unallocatedAmount,
      allocatedAmount: contract.allocatedAmount,
      creditBalance: contract.creditBalance,
      source: contract.source ?? 'backend',
    },
    links,
  };
}