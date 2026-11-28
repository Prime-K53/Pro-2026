import { emitAccountingUpdated } from './accountingApi';
import { buildQuery, downloadBlob, getAuthHeaders, requestBlob, requestJson } from './http';
import type { ApiInvoice } from './commercialApi';
import type {
  DocumentPreviewKind,
  GenerateWorkflowInvoicePayload,
  UnifiedDocumentRecord,
} from '../types/documents';

function normalizeGeneratedInvoice(raw: any): ApiInvoice {
  return {
    id: Number(raw.id),
    invoiceNumber: raw.invoiceNumber || raw.invoice_number || '',
    customerId: Number(raw.customerId ?? raw.customer_id),
    customerName: raw.customerName || raw.customer_name || '',
    invoiceDate: raw.invoiceDate || raw.invoice_date || raw.date || '',
    dueDate: raw.dueDate || raw.due_date || '',
    terms: raw.terms || 'Net 30',
    status: raw.status || 'open',
    isSalesReceipt: Boolean(raw.isSalesReceipt),
    currencyCode: raw.currencyCode || 'ZMW',
    exchangeRate: Number(raw.exchangeRate ?? 1),
    subtotal: Number(raw.subtotalNum ?? raw.subtotal ?? 0),
    taxRate: Number(raw.taxRate ?? 0),
    taxAmount: Number(raw.taxAmountNum ?? raw.tax_amount ?? 0),
    total: Number(raw.totalNum ?? raw.total ?? 0),
    amountPaid: Number(raw.amountPaidNum ?? raw.amountPaid ?? 0),
    balanceDue: Number(raw.balanceDueNum ?? raw.balance_due ?? 0),
    totalCost: Number(raw.totalCostNum ?? raw.total_cost ?? 0),
    grossProfit: Number(raw.grossProfitNum ?? raw.gross_profit ?? 0),
    journalTxnId:
      raw.journalTxnId !== null && raw.journalTxnId !== undefined
        ? Number(raw.journalTxnId)
        : null,
    notes: raw.notes || '',
    lines: Array.isArray(raw.lines) ? raw.lines : [],
  };
}

export interface ListDocumentsResponse {
  companyId: number;
  documents: UnifiedDocumentRecord[];
  countsByCategory: {
    all: number;
    sales: number;
    quotes: number;
    contracts_exams: number;
    purchasing: number;
    files: number;
  };
}

export interface AttachmentItem {
  attachmentId: number;
  storedFileId: number;
  entityType: string;
  entityId: number;
  notes: string;
  createdAt: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  sha256Hex: string;
  uploadedByUsername: string | null;
}

export const documentsApi = {
  async listDocuments(params: {
    category?: string;
    kind?: string;
    search?: string;
  } = {}): Promise<ListDocumentsResponse> {
    return requestJson<ListDocumentsResponse>(`/api/documents${buildQuery(params)}`);
  },

  async getDocumentPreview(kind: DocumentPreviewKind, id: number): Promise<any> {
    const d = await requestJson<{ preview: any }>(`/api/documents/preview/${kind}/${id}`);
    return d.preview;
  },

  async generateWorkflowInvoice(
    payload: GenerateWorkflowInvoicePayload
  ): Promise<{ invoice: ApiInvoice; idempotentReplay: boolean }> {
    const d = await requestJson<{ invoice: any; idempotentReplay: boolean }>(
      '/api/documents/generate-invoice',
      {
        method: 'POST',
        headers: payload.idempotencyKey
          ? { 'idempotency-key': payload.idempotencyKey }
          : undefined,
        body: JSON.stringify(payload),
      }
    );
    emitAccountingUpdated();
    return {
      invoice: normalizeGeneratedInvoice(d.invoice),
      idempotentReplay: Boolean(d.idempotentReplay),
    };
  },

  async listAttachments(entityType?: string, entityId?: number): Promise<AttachmentItem[]> {
    const d = await requestJson<{ attachments: AttachmentItem[] }>(
      `/api/attachments${buildQuery({ entityType, entityId })}`
    );
    return d.attachments;
  },

  async uploadAttachment(payload: {
    fileName: string;
    contentType: string;
    entityType: string;
    entityId: number;
    contentBase64?: string;
    contentText?: string;
    notes?: string;
  }): Promise<{ attachmentId: number; storedFileId: number; sizeBytes: number; sha256Hex: string }> {
    const d = await requestJson<any>('/api/attachments', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const att = d?.attachment ?? d;
    emitAccountingUpdated();
    return {
      attachmentId: Number(att.attachmentId),
      storedFileId: Number(att.fileId ?? att.storedFileId ?? 0),
      sizeBytes: Number(att.sizeBytes ?? 0),
      sha256Hex: att.sha256Hex ?? att.sha256 ?? '',
    };
  },

  async fetchAttachmentPreviewBlob(attachmentId: number): Promise<{ objectUrl: string; contentType: string }> {
    const res = await fetch(`/api/attachments/${attachmentId}/preview`, {
      credentials: 'include',
      headers: getAuthHeaders('GET'),
    });
    if (!res.ok) {
      throw new Error(`Failed to load file preview (${res.status})`);
    }
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const blob = await res.blob();
    return {
      objectUrl: URL.createObjectURL(blob),
      contentType,
    };
  },

  async downloadAttachment(attachmentId: number, fileName: string): Promise<void> {
    const blob = await requestBlob(`/api/attachments/${attachmentId}/download`);
    downloadBlob(blob, fileName || `document-${attachmentId}`);
  },

  async deleteAttachment(attachmentId: number): Promise<{ deleted: boolean; attachmentId: number }> {
    const d = await requestJson<{ deleted: boolean; attachmentId: number }>(
      `/api/attachments/${attachmentId}`,
      { method: 'DELETE' }
    );
    emitAccountingUpdated();
    return d;
  },
};
