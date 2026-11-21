/**
 * @file contractRenderService.ts
 * @description Feature-flagged contract render-model service.
 *
 * Adapted from PrimeERPsystem/contracts/ + this project's existing
 * printingRecordsService/documentsService.
 *
 * This module is ADDITIVE:
 *   - It does not modify the existing documentsService output.
 *   - It does not modify the existing React preview.
 *   - It is called only when a client explicitly requests
 *     `GET /api/documents/render-model/contract/:id`.
 *
 * It loads a contract + assessments, maps them into the generic ERPDocument
 * envelope, optionally runs the ConsistencyLock pre-flight, and renders a
 * deterministic RenderModel from a LayoutBlueprint.
 */

import type { Transaction } from '@electric-sql/pglite';
import type { PrintingContract, ContractAssessmentMilestone } from '../../types/accounting.ts';
import type { RenderModel } from '../../types/renderModel.ts';
import type { ERPDocument } from '../../types/documentContract.ts';
import { mapContractToDocumentContract } from '../../types/documentContract.ts';
import { renderDocument } from './contractLayoutEngine.ts';
import { validateContractDocument, type ValidationResult } from './contractConsistencyLock.ts';
import { CONTRACT_PRIME_CLASSIC_BLUEPRINT, CONTRACT_BLUEPRINTS } from './contractBlueprints.ts';

export interface ContractRenderResult {
  document: ERPDocument<unknown, unknown>;
  renderModel: RenderModel;
  consistency: ValidationResult;
}

/**
 * Loads a printing contract and its assessments from the database and maps
 * them to the local PrintingContract shape used by the document layer.
 */
async function loadContractForRender(
  tx: Transaction,
  companyId: number,
  contractId: number
): Promise<PrintingContract> {
  const contractRes = await tx.query<{
    id: number;
    contract_number: string;
    school_customer_id: number;
    title: string;
    academic_year: string;
    start_date: string;
    end_date: string;
    total_prepaid_amount: string;
    total_assessments: number;
    remaining_balance: string;
    completed_assessments: string;
    deposit_bank_account_id: string;
    status: string;
    activated_at: string | null;
    activated_by: number | null;
    completed_at: string | null;
    completed_by: number | null;
    suspended_at: string | null;
    suspended_by: number | null;
    suspension_reason: string | null;
    resumed_at: string | null;
    resumed_by: number | null;
    renewal_of_contract_id: number | null;
    customer_acceptance_id: number | null;
    liability_account_id: string | null;
    unallocated_amount: string | null;
    allocated_amount: string | null;
    credit_balance: boolean;
    updated_at: string | null;
    notes: string | null;
  }>(
    `SELECT id, contract_number, school_customer_id, title, academic_year,
            start_date::text AS start_date, end_date::text AS end_date,
            total_prepaid_amount::text, total_assessments, remaining_balance::text,
            completed_assessments::text, deposit_bank_account_id::text,
            status, activated_at::text, activated_by, completed_at::text,
            completed_by, suspended_at::text, suspended_by, suspension_reason,
            resumed_at::text, resumed_by, renewal_of_contract_id,
            customer_acceptance_id, liability_account_id::text,
            unallocated_amount::text, allocated_amount::text, credit_balance,
            updated_at::text, notes
       FROM printing_contracts
      WHERE company_id = $1 AND id = $2
      LIMIT 1`,
    [companyId, contractId]
  );

  if (contractRes.rows.length === 0) {
    throw new Error(`Printing contract ${contractId} not found`);
  }

  const r = contractRes.rows[0];

  const milestoneRes = await tx.query<{
    assessment_number: number;
    label: string;
    scheduled_date: string;
    agreed_amount: string;
    raw_paper_item_id: string | null;
    raw_toner_item_id: string | null;
    estimated_sheets: string;
    estimated_impressions: string;
    paper_cost: string;
    toner_cost: string;
    total_cost: string;
    profit: string;
    status: string;
    completed_date: string | null;
    exam_batch_note: string | null;
    linked_invoice_id: string | null;
    backend_invoice_id: number | null;
    linked_invoice_number: string | null;
  }>(
    `SELECT assessment_number, label, scheduled_date::text AS scheduled_date,
            agreed_amount::text, raw_paper_item_id::text, raw_toner_item_id::text,
            estimated_sheets::text, estimated_impressions::text,
            paper_cost::text, toner_cost::text, total_cost::text, profit::text,
            status, completed_date::text, exam_batch_note,
            linked_invoice_id::text, linked_invoice_number
       FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2
      ORDER BY assessment_number ASC`,
    [companyId, contractId]
  );

  const assessments: ContractAssessmentMilestone[] = milestoneRes.rows.map((m) => ({
    assessmentNumber: Number(m.assessment_number),
    label: m.label,
    scheduledDate: m.scheduled_date,
    agreedAmount: Number(m.agreed_amount),
    rawPaperItemId: m.raw_paper_item_id ?? undefined,
    rawTonerItemId: m.raw_toner_item_id ?? undefined,
    estimatedSheets: Number(m.estimated_sheets),
    estimatedImpressions: Number(m.estimated_impressions),
    paperCost: Number(m.paper_cost),
    tonerCost: Number(m.toner_cost),
    totalCost: Number(m.total_cost),
    profit: Number(m.profit),
    status: m.status === 'completed' ? 'completed' : 'pending',
    completedDate: m.completed_date ?? undefined,
    examBatchNote: m.exam_batch_note ?? undefined,
    linkedInvoiceId: m.linked_invoice_id ?? undefined,
    linkedInvoiceNumber: m.linked_invoice_number ?? undefined,
  }));

  const numeric = (value: string | null | undefined) => (value == null ? 0 : Number(value));

  return {
    id: String(r.id),
    backendId: Number(r.id),
    contractNumber: r.contract_number,
    schoolCustomerId: String(r.school_customer_id),
    title: r.title,
    academicYear: r.academic_year,
    startDate: r.start_date,
    endDate: r.end_date,
    totalPrepaidAmount: numeric(r.total_prepaid_amount),
    totalAssessments: Number(r.total_assessments) as 2 | 3 | 4 | 5,
    remainingBalance: numeric(r.remaining_balance),
    completedAssessments: Number(r.completed_assessments),
    depositBankAccountId: r.deposit_bank_account_id ?? '',
    status: r.status as PrintingContract['status'],
    activatedAt: r.activated_at ?? undefined,
    activatedBy: r.activated_by ?? undefined,
    completedAt: r.completed_at ?? undefined,
    completedBy: r.completed_by ?? undefined,
    suspendedAt: r.suspended_at ?? undefined,
    suspendedBy: r.suspended_by ?? undefined,
    suspensionReason: r.suspension_reason ?? undefined,
    resumedAt: r.resumed_at ?? undefined,
    resumedBy: r.resumed_by ?? undefined,
    renewalOfContractId: r.renewal_of_contract_id ?? undefined,
    customerAcceptanceId: r.customer_acceptance_id ?? undefined,
    liabilityAccountId: r.liability_account_id != null ? Number(r.liability_account_id) : undefined,
    unallocatedAmount: numeric(r.unallocated_amount),
    allocatedAmount: numeric(r.allocated_amount),
    creditBalance: Boolean(r.credit_balance),
    updatedAt: r.updated_at ?? undefined,
    source: 'backend',
    assessments,
    depositInvoiceId: undefined,
    depositBackendInvoiceId: undefined,
    depositInvoiceNumber: undefined,
    notes: r.notes ?? undefined,
  };
}

/**
 * Renders a contract into a deterministic RenderModel using the classic
 * contract blueprint.
 *
 * If `blueprintId` is omitted, the classic blueprint is used.
 */
export async function renderContractToRenderModel(
  tx: Transaction,
  companyId: number,
  contractId: number,
  options: { blueprintId?: string; checkConsistency?: boolean } = {}
): Promise<ContractRenderResult> {
  const contract = await loadContractForRender(tx, companyId, contractId);
  const document = mapContractToDocumentContract(contract, contract.assessments);

  const blueprint =
    CONTRACT_BLUEPRINTS[options.blueprintId ?? 'contract.prime.classic'] ??
    CONTRACT_PRIME_CLASSIC_BLUEPRINT;

  const renderModel = renderDocument(document, blueprint);

  const consistency = options.checkConsistency === false
    ? { isValid: true, errors: [], warnings: [], fingerprint: '' }
    : validateContractDocument(
        document,
        { strictMode: false, checkOverlaps: true, checkPageBoundaries: true },
        renderModel
      );

  return { document, renderModel, consistency };
}