import { emitAccountingUpdated } from './accountingApi';
import { buildQuery, requestJson } from './http';

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
  totalCost: number;
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
      totalCost: Number(j.totalCost ?? j.total_cost ?? 0),
      budgetApprovedAt: j.budgetApprovedAt || null,
      materials: Array.isArray(j.materials) ? j.materials : [],
    }));
  },

  async getJob(id: number): Promise<ApiPrintingJob> {
    const d = await requestJson<{ job: any }>(`/api/printing/jobs/${id}`);
    return d.job;
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

  /** Create a prepaid school printing retainer (posts the deposit journal). */
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
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Create an examination print batch (class + subject papers). */
  async createExamBatch(payload: {
    schoolCustomerId: number;
    assessmentName: string;
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
      sheetsUsed?: string | number | null;
      impressionsUsed?: string | number | null;
      paperCost?: string | number | null;
      tonerCost?: string | number | null;
      productionDate?: string | null;
      notes?: string | null;
    }>;
  }) {
    const d = await requestJson<{ batch: any }>('/api/printing/exam-batches', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.batch;
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

  /** Activate a previously cancelled contract. */
  async activateContract(id: number): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}/activate`, {
      method: 'POST',
      body: '{}',
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Cancel an active contract. */
  async cancelContract(id: number, reason?: string): Promise<any> {
    const d = await requestJson<{ contract: any }>(`/api/printing/contracts/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d.contract;
  },

  /** Renew a contract into a fresh retainer period (posts a new deposit journal). */
  async renewContract(id: number): Promise<any> {
    const d = await requestJson<any>(`/api/printing/contracts/${id}/renew`, {
      method: 'POST',
      body: '{}',
    });
    emitAccountingUpdated();
    return d;
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

  /** Bank/wallet transactions recorded against a contract number. */
  async getContractWalletTransactions(id: number): Promise<any[]> {
    const d = await requestJson<{ transactions: any[] }>(
      `/api/printing/contracts/${id}/wallet-transactions`
    );
    return d.transactions || [];
  },

  // ---- Examination papers: read + status + removal ----

  /** List examination print papers for the active company. */
  async listExamPapers(): Promise<any[]> {
    const d = await requestJson<{ papers: any[] }>('/api/printing/exam-papers');
    return d.papers || [];
  },

  /** Move an examination paper through queued → printing → completed. */
  async updateExamPaperStatus(id: number, status: 'queued' | 'printing' | 'completed'): Promise<any> {
    const d = await requestJson<any>(`/api/printing/exam-papers/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
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
