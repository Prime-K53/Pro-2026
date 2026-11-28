export type DocType = 'INVOICE' | 'QUOTATION' | 'ORDER' | 'SALES_ORDER' | 'PO' | 'SUBSCRIPTION' | 'EXAMINATION_INVOICE' | 'DELIVERY_NOTE' | 'RECEIPT' | 'SUPPLIER_PAYMENT' | 'SALES_EXCHANGE' | 'ACCOUNT_STATEMENT' | 'ACCOUNT_STATEMENT_SUMMARY' | 'PRINTING_CONTRACT' | 'CONTRACT_SCHEDULE' | 'CONTRACT_COMPLETION_RECEIPT' | 'FISCAL_REPORT' | 'POS_RECEIPT' | 'WORK_ORDER';

export interface FilePreviewDescriptor {
  title?: string;
  source?: string;
  url?: string;
  contentType?: string;
  mimeType?: string;
  /** Stored-file identifier, when the preview is backed by an attachment. */
  fileId?: string;
  /** Original upload name, used for mime sniffing when no mime is declared. */
  fileName?: string;
  /** Declared source/download URLs used to resolve the preview target. */
  sourceUrl?: string;
  downloadUrl?: string;
  publicUrl?: string;
  [key: string]: unknown;
}
