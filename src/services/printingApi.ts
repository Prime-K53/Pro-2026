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
};
