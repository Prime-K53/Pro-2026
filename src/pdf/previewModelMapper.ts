import type { DocumentPreviewModel, DocumentPreviewKind } from '../types/documents';
import type { DocType } from './stubs/stores/documentStore';
import type { PrimeDocData } from './schemas';

/**
 * Map the app's DocumentPreviewKind to the PrimeERPsystem DocType used by
 * PrimeDocument / PreviewModal.
 */
export function mapKindToDocType(kind: DocumentPreviewKind): DocType | null {
  switch (kind) {
    case 'invoice':
      return 'INVOICE';
    case 'sales_receipt':
      return 'RECEIPT';
    case 'estimate':
      return 'QUOTATION';
    case 'credit_memo':
      return 'SALES_EXCHANGE';
    case 'payment_receipt':
      return 'RECEIPT';
    case 'bill':
    case 'purchase_order':
      return 'PO';
    case 'contract':
      return 'PRINTING_CONTRACT';
    case 'exam_batch':
      return 'EXAMINATION_INVOICE';
    case 'printing_job':
      return 'WORK_ORDER';
    case 'attachment':
    default:
      return null;
  }
}

/**
 * Convert a DocumentPreviewModel (the app's internal preview shape) into the
 * PrimeDocData shape consumed by the real PrimeDocument renderer.
 */
export function mapPreviewModelToPrimeDoc(doc: DocumentPreviewModel): {
  type: DocType;
  data: PrimeDocData;
} | null {
  const type = mapKindToDocType(doc.kind);
  if (!type) return null;

  const currency = doc.currencyCode || doc.company.currency || 'K';
  const totals = doc.totals || ({} as DocumentPreviewModel['totals']);

  // POS counter receipts render with the dedicated thermal POS_RECEIPT layout.
  if (doc.posMeta) {
    const pm = doc.posMeta;
    const posData: Record<string, unknown> = {
      number: doc.documentNumber,
      receiptNumber: doc.documentNumber,
      date: doc.documentDate,
      customerName: doc.counterparty?.name || '',
      cashierName: pm.cashierName || 'System User',
      paymentMethod: pm.paymentMethod,
      items: pm.items,
      subtotal: totals.subtotal ?? 0,
      discount: pm.discount ?? 0,
      totalAmount: totals.total ?? 0,
      total: totals.total ?? 0,
      amount: totals.total ?? 0,
      amountTendered: pm.amountTendered ?? 0,
      changeGiven: pm.changeGiven ?? 0,
      status: doc.status,
      currency,
      documentType: 'POS_RECEIPT',
      securityQrCodeDataUrl: (doc as any).securityQrCodeDataUrl,
    };
    return { type: 'POS_RECEIPT', data: posData as unknown as PrimeDocData };
  }

  const items = (doc.lines || []).map(l => ({
    desc: l.description,
    qty: l.quantity,
    price: l.rate,
    total: l.amount,
  }));

  const totalAmount = totals.total ?? 0;
  const customerName = doc.counterparty?.name || '';
  const supplierName = doc.counterparty?.name || '';

  const base: Record<string, unknown> = {
    number: doc.documentNumber,
    documentNumber: doc.documentNumber,
    invoiceNumber: doc.documentNumber,
    receiptNumber: doc.documentNumber,
    quotationNumber: doc.documentNumber,
    orderNumber: doc.documentNumber,
    exchangeNumber: doc.documentNumber,
    paymentNumber: doc.documentNumber,
    paymentId: doc.documentNumber,
    contractNumber: doc.documentNumber,
    date: doc.documentDate,
    dueDate: doc.dueDate,
    paymentTerms: doc.terms,
    paymentMethod: doc.terms || 'Cash',
    clientName: customerName,
    customerName,
    supplierName,
    supplier: supplierName,
    cashierName: 'System User',
    reason: doc.notes || 'Credit note / return',
    address: doc.counterparty?.address || doc.company.address || '',
    phone: doc.counterparty?.phone || doc.company.phone || '',
    email: doc.counterparty?.email || doc.company.email || '',
    status: doc.status,
    currency,
    items,
    lines: items,
    subtotal: totals.subtotal ?? 0,
    discount: 0,
    taxAmount: totals.taxAmount ?? 0,
    totalAmount,
    total: totalAmount,
    amount: totalAmount,
    amountPaid: totals.amountPaid ?? 0,
    amountReceived: totals.total ?? 0,
    balanceDue: totals.balanceDue ?? 0,
    notes: doc.notes,
    documentType: type,
    // A stable content hash placeholder so contract validation passes; the
    // real hash is recomputed server-side for verification.
    contentHash: doc.documentNumber,
  };

  // Contract-specific fields
  if (type === 'PRINTING_CONTRACT' && doc.contractMeta) {
    const cm = doc.contractMeta;
    base.contractNumber = doc.documentNumber;
    base.title = cm.contractTitle;
    base.academicYear = cm.academicYear;
    base.totalPrepaidAmount = cm.totalPrepaidAmount;
    base.prepaidAmount = cm.totalPrepaidAmount;
    base.remainingBalance = cm.remainingBalance;
    base.status = doc.status;
      base.assessments = (cm.assessments || []).map(a => ({
        description: a.label,
        amount: a.agreedAmount,
        status: a.status,
      }));
    }

    // Extended intake fields (spec / delivery / zone / pricing) rendered on the
    // contract PDF when present.
    if (type === 'PRINTING_CONTRACT' && doc.contractExtras) {
      const ex = doc.contractExtras;
      if (ex.schoolZone) base.schoolZone = ex.schoolZone;
      if (ex.customerPhone) base.customerPhone = ex.customerPhone;
      if (ex.totalCandidature != null) base.totalCandidature = ex.totalCandidature;
      if (ex.sittings) base.assessmentSittings = ex.sittings;
      if (ex.chargePerCandidate != null) base.chargePerCandidate = ex.chargePerCandidate;
      if (ex.printSpecSummary) base.printSpecSummary = ex.printSpecSummary;
      if (ex.printPaperSummary) base.printPaperSummary = ex.printPaperSummary;
      if (ex.printColorSummary) base.printColorSummary = ex.printColorSummary;
      if (ex.printTypeSummary) base.printTypeSummary = ex.printTypeSummary;
      if (ex.printOrientation) base.printOrientation = ex.printOrientation;
      if (ex.printFinishing) base.printFinishing = ex.printFinishing;
      if (ex.printPackaging) base.printPackaging = ex.printPackaging;
      if (ex.pricingRulesSummary) base.pricingRulesSummary = ex.pricingRulesSummary;
      if (ex.deliveryTermsSummary) base.deliveryTermsSummary = ex.deliveryTermsSummary;
      if (ex.deliveryMethod) base.deliveryMethod = ex.deliveryMethod;
      if (ex.deliveryTimeline) base.deliveryTimeline = ex.deliveryTimeline;
      if (ex.deliveryAddress) base.deliveryAddress = ex.deliveryAddress;
      if (ex.deliveryNotes) base.deliveryNotes = ex.deliveryNotes;
      if (ex.terms) base.terms = ex.terms;
      if (ex.notes) base.notes = ex.notes;
    }

  return { type, data: base as unknown as PrimeDocData };
}