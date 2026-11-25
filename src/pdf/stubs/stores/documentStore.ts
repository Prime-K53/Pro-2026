export type DocType = 'INVOICE' | 'QUOTATION' | 'ORDER' | 'SALES_ORDER' | 'PO' | 'SUBSCRIPTION' | 'EXAMINATION_INVOICE' | 'DELIVERY_NOTE' | 'RECEIPT' | 'SUPPLIER_PAYMENT' | 'SALES_EXCHANGE' | 'ACCOUNT_STATEMENT' | 'ACCOUNT_STATEMENT_SUMMARY' | 'PRINTING_CONTRACT' | 'CONTRACT_SCHEDULE' | 'CONTRACT_COMPLETION_RECEIPT' | 'FISCAL_REPORT' | 'POS_RECEIPT' | 'WORK_ORDER';

export interface FilePreviewDescriptor {
  title?: string;
  source?: string;
  url?: string;
  contentType?: string;
  mimeType?: string;
  [key: string]: unknown;
}