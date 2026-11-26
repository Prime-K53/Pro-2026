import { emitAccountingUpdated } from './accountingApi';
import { buildQuery, requestJson } from './http';

/**
 * Idempotency header for contract money mutations. The backend replays the
 * stored response for an identical key and rejects a reused key with a
 * different payload, so a double submit posts exactly once.
 */
function idempotencyHeaders(key?: string | null): Record<string, string> | undefined {
  const trimmed = key?.trim();
  return trimmed ? { 'idempotency-key': trimmed } : undefined;
}

export interface ApiPrintingJobMaterial {
  id: number;
  rawMaterialItemId: number;
  sku: string;
  itemName: string;
  materialRole: string;
  usageUnit: string;
  plannedUsageQty: number;
  plannedUnitCost: number;
  reservedUsageQty: number;
  issuedUsageQty: number;
  actualGoodUsageQty: number;
  wasteUsageQty: number;
}

export interface ApiPrintingJob {
  id: number;
  jobNumber: string;
  jobType: string;
  customerId: number | null;
  customerName: string;
  title: string;
  status: string;
  pages: number;
  copies: number;
  printSide: string;
  sheetsUsed: number;
  impressionsUsed: number;
  paperCost: number;
  tonerCost: number;
  extraCost: number;
  totalCost: number;
  manualSellingPrice: number;
  jobDate: string;
  invoiceId: number | null;
  parentJobId: number | null;
  notes: string;
  rawPaperItemId?: string;
  rawTonerItemId?: string;
  budgetApprovedAt: string | null;
  materials: ApiPrintingJobMaterial[];
}

export const printingApi = {
  async listJobs(params: { status?: string } = {}): Promise<ApiPrintingJob[]> {
    const d = await requestJson<{ jobs: any[] }>(`/api/printing/jobs${buildQuery(params)}`);
    return (d.jobs || []).map((j: any) => ({
      id: Number(j.id),
      jobNumber: j.jobNumber || j.job_number || '',
      jobType: j.jobType || j.job_type || '',
      customerId: j.customerId ?? null,
      customerName: j.customerName || j.customer_name || '',
      title: j.title || '',
      status: j.status || '',
      pages: Number(j.pages || 0),
      copies: Number(j.copies || 0),
      printSide: j.printSide || j.print_side || '',
      sheetsUsed: Number(j.sheetsUsed ?? j.sheets_used ?? 0),
      impressionsUsed: Number(j.impressionsUsed ?? j.impressions_used ?? 0),
      paperCost: Number(j.paperCost ?? j.paper_cost ?? 0),
      tonerCost: Number(j.tonerCost ?? j.toner_cost ?? 0),
      extraCost: Number(j.extraCost ?? j.extra_cost ?? 0),
      totalCost: Number(j.totalCost ?? j.total_cost ?? 0),
      manualSellingPrice: Number(j.manualSellingPrice ?? j.manual_selling_price ?? 0),
      jobDate: j.jobDate || j.job_date || '',
      invoiceId: j.invoiceId != null ? Number(j.invoiceId) : null,
      parentJobId:
        j.parentJobId != null
          ? Number(j.parentJobId)
          : j.parent_job_id != null
          ? Number(j.parent_job_id)
          : null,
      notes: j.notes || '',
      rawPaperItemId: String(j.rawPaperItemId ?? j.raw_paper_item_id ?? ''),
      rawTonerItemId: String(j.rawTonerItemId ?? j.raw_toner_item_id ?? ''),
      budgetApprovedAt: j.budgetApprovedAt || null,
      materials: Array.isArray(j.materials) ? j.materials : [],
    }));
  },

  async getJob(id: number): Promise<ApiPrintingJob> {
    const d = await requestJson<{ job: any }>(`/api/printing/jobs/${id}`);
    return d.job;
  },

  /**
   * Quick-print desk posting. Creates the printing job, approves its budget and
   * issues the planned paper/toner into WIP in one server transaction, so stock
   * and the cost ledger stay in step with the desk. The returned job carries the
   * authoritative sheets, impressions and costs — the browser must not
   * recompute or re-deduct them.
   */
  async postQuickPrintJob(payload: {
    jobType?: 'quick_photocopy' | 'type_and_printing' | 'general_print';
    customerId?: number | null;
    customerName?: string;
    rawPaperItemId: number;
    rawTonerItemId: number;
    title: string;
    pages: number;
    copies: number;
    printSide?: 'Single-Sided' | 'Duplex';
    typingFeeMode?: 'flat' | 'per_page';
    typingFeeRate?: number;
    finishingCost?: number;
    finishingCostPerPage?: number;
    manualSellingPrice?: number;
    manualSellingPricePerSheet?: number;
    jobDate?: string;
    notes?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ job: any; wipJournalTxnId: number | null }> {
    const d = await requestJson<any>('/api/printing/quick-jobs', {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return { job: d.job, wipJournalTxnId: d.wipJournalTxnId ?? null };
  },

  /**
   * Recent quick-print desk jobs (newest first) for the desk history panel.
   */
  async listQuickPrintJobs(limit = 50): Promise<any[]> {
    const d = await requestJson<{ jobs: any[] }>(`/api/printing/quick-jobs?limit=${limit}`);
    return d.jobs || [];
  },

  /**
   * Bills an existing quick-print job onto an invoice that was raised elsewhere
   * (combined invoice modal or POS checkout). Relieves the job's WIP to COGS once
   * and ties the relief to the invoice's cost so gross profit is not doubled.
   */
  async linkJobInvoice(jobId: number, invoiceId: number): Promise<any> {
    const d = await requestJson<{ link: any }>(`/api/printing/jobs/${jobId}/invoice-link`, {
      method: 'POST',
      body: JSON.stringify({ invoiceId }),
    });
    emitAccountingUpdated();
    return d.link;
  },

  async approveBudget(id: number): Promise<any> {
    const d = await requestJson<any>(`/api/printing/jobs/${id}/approve-budget`, {
      method: 'POST',
      body: '{}',
    });
    emitAccountingUpdated();
    return d;
  },

  async cancelJob(id: number, reason?: string): Promise<any> {
    const d = await requestJson<any>(`/api/printing/jobs/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d;
  },

  async invoiceJob(id: number, payload: Record<string, unknown> = {}): Promise<any> {
    const d = await requestJson<any>(`/api/printing/jobs/${id}/invoice`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d;
  },

  async getJobProfitability(id: number): Promise<any> {
    const d = await requestJson<{ report: any }>(`/api/printing/jobs/${id}/profitability`);
    return d.report;
  },

  /** Create a prepaid school printing retainer. Always creates a draft. */
  async createContract(payload: {
    schoolCustomerId: number;
    title: string;
    academicYear: string;
    startDate: string;
    endDate: string;
    totalPrepaidAmount: string | number;
    totalAssessments: number;
    depositBankAccountId: number;
    notes?: string | null;
    renewalOfContractId?: number | null;
    idempotencyKey?: string | null;
    assessments: Array<{
      assessmentNumber: number;
      label: string;
      scheduledDate: string;
      agreedAmount: string | number;
      rawPaperItemId?: number | null;
      rawTonerItemId?: number | null;
      estimatedSheets?: string | number | null;
      estimatedImpressions?: string | number | null;
      paperCost?: string | number | null;
      tonerCost?: string | number | null;
    }>;
  }) {
    const d = await requestJson<{ contract: any }>('/api/printing/contracts', {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Allocate customer-wallet funds to a draft contract (D-1 funding path). */
  async fundContract(id: number, idempotencyKey?: string | null): Promise<any> {
    const d = await requestJson<{ funding: any }>(`/api/printing/contracts/${id}/fund`, {
      method: 'POST',
      headers: idempotencyHeaders(idempotencyKey),
      body: JSON.stringify({}),
    });
    emitAccountingUpdated();
    return d.funding;
  },

  /** Record a pending contract-activation approval request (G-03). */
  async requestActivation(
    id: number,
    payload: { reason?: string; amount?: string | number; idempotencyKey?: string | null } = {}
  ): Promise<any> {
    const d = await requestJson<{ request: any }>(`/api/printing/contracts/${id}/activation-requests`, {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.request;
  },

  /** Record customer acceptance of a contract document. */
  async recordAcceptance(
    id: number,
    payload: {
      method: 'drawn' | 'otp' | 'upload';
      signerName: string;
      signerEmail?: string | null;
      signerPhone?: string | null;
      documentVersion: string;
      evidenceFileId?: number | null;
      otpVerified?: boolean;
      outcome?: 'accepted' | 'rejected';
    }
  ): Promise<any> {
    const d = await requestJson<{ acceptance: any }>(`/api/printing/contracts/${id}/acceptances`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.acceptance;
  },

  /** Add a real new deposit to an active contract's retainer (G-18). */
  async topUpContract(
    id: number,
    payload: {
      amount: string | number;
      bankAccountId: number;
      depositDate: string;
      notes?: string | null;
      idempotencyKey?: string | null;
    }
  ): Promise<any> {
    const d = await requestJson<{ deposit: any }>(`/api/printing/contracts/${id}/deposits`, {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.deposit;
  },

  /** Create an examination print batch (one or more classes, with subject papers). */
  async createExamBatch(payload: {
    schoolCustomerId: number;
    assessmentName: string;
    className?: string;
    learnersCount?: number;
    pricePerLearner?: string | number;
    contractId?: number | null;
    assessmentNumber?: number | null;
    papers?: Array<{
      subjectName: string;
      pages: number;
      copies: number;
      rawPaperItemId: number;
      rawTonerItemId: number;
      printSide?: string;
      bindingType?: string;
      paperSize?: string;
      printingItemId?: number | null;
      machineId?: number | null;
      makeReadySheets?: string | number | null;
      runningWastePct?: string | number | null;
      productionDate?: string | null;
      notes?: string | null;
    }>;
    classes?: Array<{
      className: string;
      learnersCount: number;
      pricePerLearner: string | number;
      contractId?: number | null;
      assessmentNumber?: number | null;
      papers: Array<{
        subjectName: string;
        pages: number;
        copies: number;
        rawPaperItemId: number;
        rawTonerItemId: number;
        printSide?: string;
        bindingType?: string;
        paperSize?: string;
        printingItemId?: number | null;
        machineId?: number | null;
        makeReadySheets?: string | number | null;
        runningWastePct?: string | number | null;
        productionDate?: string | null;
        notes?: string | null;
      }>;
    }>;
    dueDate?: string | null;
    priority?: string | null;
    idempotencyKey?: string | null;
  }) {
    const d = await requestJson<{ batch: any }>('/api/printing/exam-batches', {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    return d.batch;
  },

  // ---- Examination batch group: one-click production & invoicing ----

  async listExamGroups(params: { schoolCustomerId?: number | null; assessmentName?: string | null } = {}): Promise<any[]> {
    const d = await requestJson<{ groups: any[] }>(`/api/printing/exam-groups${buildQuery(params as any)}`);
    return d.groups || [];
  },

  /** Authoritative group for a selected examination batch (persisted relationship). */
  async getExamGroupForBatch(batchId: number): Promise<any> {
    const d = await requestJson<{ group: any }>(`/api/printing/exam-batches/${batchId}/group`);
    return d.group;
  },

  async generateExamGroupProduction(groupId: number, idempotencyKey?: string | null): Promise<any> {
    const d = await requestJson<{ summary: any }>(`/api/printing/exam-groups/${groupId}/generate-production`, {
      method: 'POST',
      headers: idempotencyHeaders(idempotencyKey),
      body: JSON.stringify({ idempotencyKey }),
    });
    return d.summary;
  },

  async completeExamGroupProduction(
    groupId: number,
    payload: { idempotencyKey?: string | null; goodCopiesByPaper?: Record<string, number>; spoiledCopiesByPaper?: Record<string, number> } = {}
  ): Promise<any> {
    const d = await requestJson<{ summary: any }>(`/api/printing/exam-groups/${groupId}/complete-production`, {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    return d.summary;
  },

  async approveExamGroupQc(
    groupId: number,
    payload: { idempotencyKey?: string | null; qcNotesByPaper?: Record<string, string> } = {}
  ): Promise<any> {
    const d = await requestJson<{ summary: any }>(`/api/printing/exam-groups/${groupId}/approve-qc`, {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    return d.summary;
  },

  async deliverExamGroupChildren(
    groupId: number,
    payload: {
      idempotencyKey?: string | null;
      dispatchDate?: string | null;
      recipientName?: string | null;
      driverName?: string | null;
      vehicleReg?: string | null;
      notes?: string | null;
    } = {}
  ): Promise<any> {
    const d = await requestJson<{ summary: any }>(`/api/printing/exam-groups/${groupId}/deliver`, {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    return d.summary;
  },

  async postExamGroupInvoice(
    groupId: number,
    payload: { idempotencyKey?: string | null; includeTax?: boolean; taxRate?: number; notes?: string | null } = {}
  ): Promise<any> {
    const d = await requestJson<{ summary: any }>(`/api/printing/exam-groups/${groupId}/invoice`, {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.summary;
  },

  async getExamGroupSummary(groupId: number): Promise<any> {
    const d = await requestJson<{ summary: any }>(`/api/printing/exam-groups/${groupId}/summary`);
    return d.summary;
  },

  // ---- Printing Contracts: read + lifecycle (advanced options) ----

  /** List all printing contracts (with assessment schedules) for the active company. */
  async listContracts(): Promise<any[]> {
    const d = await requestJson<{ contracts: any[] }>('/api/printing/contracts');
    return d.contracts || [];
  },

  /** Fetch a single printing contract with its assessment milestones. */
  async getContract(id: number): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}`);
    return d.contract;
  },

  /** Amend contract metadata (title, academic year, dates, notes). */
  async amendContract(
    id: number,
    payload: { title?: string; academicYear?: string; startDate?: string; endDate?: string; notes?: string | null }
  ): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Activate a funded, accepted and approved draft contract. */
  async activateContract(id: number): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}/activate`, {
      method: 'POST',
      body: '{}',
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Cancel an active contract with an explicit settlement mode (G-04). */
  async cancelContract(
    id: number,
    options: { reason?: string; settlementMode?: 'refund' | 'forfeit'; refundBankAccountId?: number | null } = {}
  ): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Renew a contract into a fresh retainer period with a real new deposit (G-05). */
  async renewContract(
    id: number,
    payload: {
      depositAmount?: string | number;
      depositBankAccountId?: number;
      startDate?: string;
      endDate?: string;
      title?: string;
      academicYear?: string;
      assessments?: any[];
      idempotencyKey?: string | null;
    } = {}
  ): Promise<any> {
    const d = await requestJson<any>(`/api/printing/contracts/${id}/renew`, {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.contract ?? d;
  },

  /** Add an assessment milestone to an active contract. */
  async addContractAssessment(
    id: number,
    payload: {
      assessmentNumber: number;
      label: string;
      scheduledDate: string;
      agreedAmount: string | number;
      rawPaperItemId?: number | null;
      rawTonerItemId?: number | null;
      estimatedSheets?: string | number | null;
      estimatedImpressions?: string | number | null;
      paperCost?: string | number | null;
      tonerCost?: string | number | null;
      examBatchNote?: string | null;
    }
  ): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}/assessments`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Update a pending assessment milestone (label, date, agreed amount, costs). */
  async updateContractAssessment(
    id: number,
    assessmentNumber: number,
    payload: {
      label?: string;
      scheduledDate?: string;
      agreedAmount?: string | number;
      rawPaperItemId?: number | null;
      rawTonerItemId?: number | null;
      estimatedSheets?: string | number | null;
      estimatedImpressions?: string | number | null;
      paperCost?: string | number | null;
      tonerCost?: string | number | null;
    }
  ): Promise<any> {
    const d = await requestJson<{ contract: any }>(
      `/api/printing/contracts/${id}/assessments/${assessmentNumber}`,
      { method: 'PATCH', body: JSON.stringify(payload) }
    );
    emitAccountingUpdated();
    return d.contract;
  },

  /** Remove a pending assessment milestone from a contract. */
  async removeContractAssessment(id: number, assessmentNumber: number): Promise<any> {
    const d = await requestJson<{ contract: any }>(
      `/api/printing/contracts/${id}/assessments/${assessmentNumber}`,
      { method: 'DELETE' }
    );
    emitAccountingUpdated();
    return d.contract;
  },

  /**
   * Complete a pending assessment: deducts the agreed amount from the prepaid
   * retainer and recognizes the revenue through the general ledger.
   */
  async completeContractAssessment(
    id: number,
    assessmentNumber: number,
    payload: { examBatchNote?: string | null; linkedInvoiceId?: number | null } = {}
  ): Promise<any> {
    const d = await requestJson<{ contract: any }>(
      `/api/printing/contracts/${id}/assessments/${assessmentNumber}/complete`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
    emitAccountingUpdated();
    return d.contract;
  },

  /** Link a generated retainer invoice to its contract (G-09). */
  async linkDepositInvoice(
    id: number,
    payload: { invoiceId: number; invoiceNumber?: string | null }
  ): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}/deposit-invoice`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Link a generated assessment invoice to its milestone (G-09). */
  async linkMilestoneInvoice(
    id: number,
    assessmentNumber: number,
    payload: { invoiceId: number; invoiceNumber?: string | null }
  ): Promise<any> {
    const d = await requestJson<{ contract: any }>(
      `/api/printing/contracts/${id}/assessments/${assessmentNumber}/invoice-link`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
    emitAccountingUpdated();
    return d.contract;
  },

  /** Bank/wallet transactions recorded against a contract number. */
  async getContractWalletTransactions(id: number): Promise<any[]> {
    const d = await requestJson<{ transactions: any[] }>(
      `/api/printing/contracts/${id}/wallet-transactions`
    );
    return d.transactions || [];
  },

  /** Suspend an active contract (active → suspended). */
  async suspendContract(id: number, reason?: string): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Void a contract as a compensating reversal (returns retainer to wallet). */
  async voidContract(id: number, reason: string): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Read-only reconciliation report grouped by customer. */
  async getContractReconciliation(): Promise<any> {
    const d = await requestJson<{ report: any }>('/api/printing/contracts/reconciliation');
    return d.report;
  },

  /** List the append-only signature ceremony records for a contract. */
  async listSignatures(id: number): Promise<any[]> {
    const d = await requestJson<{ signatures: any[] }>(
      `/api/printing/contracts/${id}/signatures`
    );
    return d.signatures || [];
  },

  /** Record a company/customer signature (company signs before customer). */
  async recordSignature(
    id: number,
    payload: {
      signerRole: 'company' | 'customer';
      signerName: string;
      method: 'drawn' | 'typed' | 'upload';
      signatureData: string;
      documentVersion?: string | null;
    }
  ): Promise<any> {
    const d = await requestJson<{ signature: any }>(
      `/api/printing/contracts/${id}/signatures`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
    emitAccountingUpdated();
    return d.signature;
  },

  /** Resume a suspended contract (suspended → active). */
  async resumeContract(id: number): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}/resume`, {
      method: 'POST',
      body: '{}',
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** List the amendment requests raised against a contract. */
  async listAmendments(id: number): Promise<any[]> {
    const d = await requestJson<{ amendments: any[] }>(
      `/api/printing/contracts/${id}/amendments`
    );
    return d.amendments || [];
  },

  /** Approve a pending contract amendment (applies its delta server-side). */
  async approveAmendment(id: number, amendmentId: number, notes?: string | null): Promise<any> {
    const d = await requestJson<{ contract: any }>(
      `/api/printing/contracts/${id}/amendments/${amendmentId}/approve`,
      { method: 'POST', body: JSON.stringify({ notes: notes ?? null }) }
    );
    emitAccountingUpdated();
    return d.contract;
  },

  /** Reject a pending contract amendment. */
  async rejectAmendment(id: number, amendmentId: number, notes?: string | null): Promise<any> {
    const d = await requestJson<{ contract: any }>(
      `/api/printing/contracts/${id}/amendments/${amendmentId}/reject`,
      { method: 'POST', body: JSON.stringify({ notes: notes ?? null }) }
    );
    emitAccountingUpdated();
    return d.contract;
  },

  /** Request approval for an assessment change (date/amount/costs) on an active contract. */
  async requestAssessmentChange(
    id: number,
    payload: {
      assessmentNumber: number;
      scheduledDate?: string;
      agreedAmount?: string | number;
      reason?: string | null;
      idempotencyKey?: string | null;
    }
  ): Promise<any> {
    const d = await requestJson<{ request: any }>(
      `/api/printing/contracts/${id}/assessment-changes`,
      {
        method: 'POST',
        headers: idempotencyHeaders(payload.idempotencyKey),
        body: JSON.stringify(payload),
      }
    );
    emitAccountingUpdated();
    return d.request;
  },

  // ---- Examination papers: read + status + removal ----

  /** List examination print papers for the active company. */
  async listExamPapers(): Promise<any[]> {
    const d = await requestJson<{ papers: any[] }>('/api/printing/exam-papers');
    return d.papers || [];
  },

  /** Edit an examination paper's details before production begins (requires exams:edit). */
  async updateExamPaper(
    id: number,
    payload: {
      subjectName?: string;
      pages?: number;
      copies?: number;
      printSide?: string;
      bindingType?: string;
      paperSize?: string;
      productionDate?: string | null;
      notes?: string | null;
      reason?: string | null;
      idempotencyKey?: string | null;
    }
  ): Promise<any> {
    const d = await requestJson<any>(`/api/printing/exam-papers/${id}`, {
      method: 'PATCH',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d;
  },

  /** Move an examination paper through the server-enforced transition matrix. */
  async updateExamPaperStatus(
    id: number,
    status:
      | 'queued'
      | 'printing'
      | 'completed'
      | 'qc_hold'
      | 'qc_passed'
      | 'packed'
      | 'dispatched',
    options: {
      reason?: string | null;
      goodCopies?: number;
      spoiledCopies?: number;
      packageCount?: number;
      sealReference?: string | null;
      qcNotes?: string | null;
    } = {}
  ): Promise<any> {
    const d = await requestJson<any>(`/api/printing/exam-papers/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...options }),
    });
    emitAccountingUpdated();
    return d;
  },

  /** Cancel an examination paper before delivery, releasing its reservations. */
  async cancelExamPaper(
    id: number,
    payload: { reason: string; returnUnusedMaterials?: boolean }
  ): Promise<any> {
    const d = await requestJson<any>(`/api/printing/exam-papers/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d;
  },

  /** Raise a controlled reprint as a new linked production record. */
  async reprintExamPaper(
    id: number,
    payload: {
      reason: string;
      copies?: number;
      productionDate?: string | null;
      idempotencyKey?: string | null;
    }
  ): Promise<any> {
    const d = await requestJson<{ reprint: any }>(`/api/printing/exam-papers/${id}/reprint`, {
      method: 'POST',
      headers: idempotencyHeaders(payload.idempotencyKey),
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.reprint;
  },

  /** Append-only production timeline for one examination paper. */
  async listExamPaperEvents(id: number): Promise<any[]> {
    const d = await requestJson<{ events: any[] }>(`/api/printing/exam-papers/${id}/events`);
    return d.events || [];
  },

  /** Examination batch register with aggregated production counts and totals. */
  async listExamBatches(
    params: { status?: string; schoolCustomerId?: number } = {}
  ): Promise<any[]> {
    const d = await requestJson<{ batches: any[] }>(
      `/api/printing/exam-batches${buildQuery(params)}`
    );
    return d.batches || [];
  },

  /** Freeze the approved production specification for a batch. */
  async approveExamBatchSpec(id: number, notes?: string | null): Promise<any> {
    const d = await requestJson<any>(`/api/printing/exam-batches/${id}/approve-spec`, {
      method: 'POST',
      body: JSON.stringify({ notes: notes ?? null }),
    });
    emitAccountingUpdated();
    return d;
  },

  /** Authoritative examination reconciliation report (read-only). */
  async getExamReconciliation(): Promise<any> {
    const d = await requestJson<{ report: any }>('/api/printing/exam-reconciliation');
    return d.report;
  },

  /** Record delivery of a completed, QC-approved examination paper. */
  async deliverExamPaper(
    id: number,
    payload: {
      dispatchDate?: string | null;
      recipientName?: string | null;
      driverName?: string | null;
      vehicleReg?: string | null;
      notes?: string | null;
    } = {}
  ): Promise<any> {
    const d = await requestJson<any>(`/api/printing/exam-papers/${id}/deliver`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d;
  },

  /** Remove an uninvoiced, incomplete examination paper. */
  async deleteExamPaper(id: number): Promise<any> {
    const d = await requestJson<any>(`/api/printing/exam-papers/${id}`, { method: 'DELETE' });
    emitAccountingUpdated();
    return d;
  },
};
