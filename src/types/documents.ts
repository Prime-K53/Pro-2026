import type {
  CompanyProfile,
  Customer,
  ExamPaper,
  Invoice,
  PrintingContract,
  QuickPrintJob,
} from './accounting';
import type { ApiInvoice } from '../services/commercialApi';

export type DocumentPreviewKind =
  | 'invoice'
  | 'sales_receipt'
  | 'estimate'
  | 'credit_memo'
  | 'payment_receipt'
  | 'bill'
  | 'purchase_order'
  | 'contract'
  | 'exam_batch'
  | 'printing_job'
  | 'attachment';

export type UnifiedDocumentCategory =
  | 'sales'
  | 'quotes'
  | 'contracts_exams'
  | 'purchasing'
  | 'files';

export interface UnifiedDocumentFileInfo {
  attachmentId: number;
  storedFileId: number;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  entityType: string;
  entityId: number;
  sha256Hex: string;
  uploadedByUsername: string | null;
}

export interface UnifiedDocumentRecord {
  uid: string;
  id: number | string;
  kind: DocumentPreviewKind;
  category: UnifiedDocumentCategory;
  documentNumber: string;
  title: string;
  counterpartyName: string;
  counterpartyId: number | string | null;
  documentDate: string;
  dueDate: string | null;
  status: string;
  amount: number;
  balanceDue: number | null;
  currencyCode: string;
  journalTxnId: number | null;
  linkedInvoiceId: number | string | null;
  linkedInvoiceNumber: string | null;
  canGenerateInvoice: boolean;
  fileInfo?: UnifiedDocumentFileInfo;
  notes: string;
  source: 'postgres' | 'workspace';
  // Optional client-side references for active workflow records not yet persisted in PG
  workspaceRef?: {
    contractId?: string;
    examPaperIds?: string[];
    quickPrintJobId?: string;
  };
}

export interface WorkflowInvoiceLineInput {
  itemId?: number | null;
  variantId?: number | null;
  description: string;
  quantity: number;
  rate: number;
  unitCost?: number;
  taxable?: boolean;
}

export interface GenerateWorkflowInvoicePayload {
  sourceKind: 'contract' | 'contract_milestone' | 'exam_batch' | 'quick_print' | 'estimate' | 'custom';
  sourceRef?: string | null;
  customerId?: number | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  customerType?: 'school' | 'corporate' | 'individual' | 'government' | 'nonprofit';
  invoiceDate?: string | null;
  dueDate?: string | null;
  terms?: string | null;
  isSalesReceipt?: boolean;
  taxRate?: number | string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  lines: WorkflowInvoiceLineInput[];
  postgresContractId?: number | null;
  postgresMilestoneNumber?: number | null;
  postgresExamBatchId?: number | null;
  postgresExamPaperIds?: number[] | null;
  postgresPrintingJobId?: number | null;
}

export interface DocumentAttachmentSummary {
  attachmentId: number;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface DocumentPreviewModel {
  kind: DocumentPreviewKind;
  id?: number | string;
  backendId?: number;
  documentNumber: string;
  title: string;
  status: string;
  documentDate: string;
  dueDate?: string;
  terms?: string;
  currencyCode: string;
  company: {
    name: string;
    legalName?: string;
    ein?: string;
    currency: string;
    address?: string;
    cityStateZip?: string;
    phone?: string;
    email?: string;
  };
  counterparty: {
    roleLabel: string;
    id?: number | string;
    name: string;
    email?: string;
    phone?: string;
    address?: string;
  };
  lines: Array<{
    description: string;
    quantity: number;
    rate: number;
    amount: number;
    unitCost?: number;
    taxable?: boolean;
  }>;
  totals: {
    subtotal: number;
    taxRate?: number;
    taxAmount: number;
    total: number;
    amountPaid?: number;
    balanceDue?: number;
    totalCost?: number;
    grossProfit?: number;
  };
  journalEntryNumber?: string | null;
  notes?: string;
  contractMeta?: {
    contractTitle: string;
    academicYear: string;
    totalPrepaidAmount: number;
    remainingBalance: number;
    completedAssessments: number;
    totalAssessments: number;
    assessments: Array<{
      assessmentNumber: number;
      label: string;
      scheduledDate: string;
      agreedAmount: number;
      estimatedSheets: number;
      estimatedImpressions: number;
      totalCost: number;
      profit: number;
      status: string;
      completedDate?: string;
      linkedInvoiceId?: number | string;
      linkedInvoiceNumber?: string;
    }>;
  };
  contractExtras?: {
    schoolZone?: string;
    customerPhone?: string;
    totalCandidature?: number;
    sittings?: string;
    chargePerCandidate?: number;
    printSpecSummary?: string;
    printPaperSummary?: string;
    printColorSummary?: string;
    printTypeSummary?: string;
    printFinishing?: string;
    printPackaging?: string;
    printOrientation?: string;
    pricingRulesSummary?: string;
    deliveryTermsSummary?: string;
    deliveryMethod?: string;
    deliveryTimeline?: string;
    deliveryAddress?: string;
    deliveryNotes?: string;
    terms?: string;
    notes?: string;
  };
  examMeta?: {
    assessmentName: string;
    className: string;
    learnersCount: number;
    pricePerLearner: number;
    linkedInvoiceId?: number | string;
    linkedInvoiceNumber?: string;
    papers: Array<{
      jobNumber: string;
      subjectName: string;
      pages: number;
      copies: number;
      printSide: string;
      bindingType: string;
      sheetsUsed: number;
      impressionsUsed: number;
      materialCost: number;
      status: string;
    }>;
  };
  quickPrintMeta?: {
    jobType: string;
    pages: number;
    copies: number;
    printSide: string;
    sheetsUsed: number;
    impressionsUsed: number;
    paperCost: number;
    tonerCost: number;
    extraCost: number;
    typingRevenue?: number;
    photocopyRevenue?: number;
  };
  /** Present on POS counter receipts — drives the thermal POS_RECEIPT layout. */
  posMeta?: {
    cashierName?: string;
    paymentMethod: string;
    amountTendered: number;
    changeGiven: number;
    discount: number;
    items: Array<{ desc: string; qty: number; price: number; total: number }>;
  };
  fileMeta?: {
    attachmentId: number;
    originalName: string;
    contentType: string;
    sizeBytes: number;
    sha256Hex: string;
    entityType: string;
    entityId: number;
    textPreview?: string | null;
    previewUrl: string;
    downloadUrl: string;
  };
  attachments?: DocumentAttachmentSummary[];
  linkedInvoiceRef?: {
    localInvoiceId?: string;
    backendInvoiceId?: number;
    invoiceNumber?: string;
  };
  canGenerateInvoice?: boolean;
  generateInvoiceInput?: GenerateWorkflowInvoicePayload;
  onInvoiceGenerated?: (result: { apiInvoice: ApiInvoice; localInvoice?: Invoice }) => void;
}

export function mapApiPreviewToModel(raw: any, fallbackCurrency = 'K'): DocumentPreviewModel {
  const companyCurrency = raw?.company?.currency || fallbackCurrency || 'K';
  const linkedInvoiceId =
    raw?.examMeta?.linkedInvoiceId ??
    (raw?.kind === 'printing_job' ? raw?.linkedInvoiceId : undefined);
  const linkedInvoiceNumber =
    raw?.examMeta?.linkedInvoiceNumber ??
    (raw?.kind === 'printing_job' ? raw?.linkedInvoiceNumber : undefined);

  return {
    kind: raw.kind,
    id: raw.id,
    backendId: typeof raw.id === 'number' ? raw.id : undefined,
    documentNumber: raw.documentNumber || '',
    title: raw.title || 'DOCUMENT',
    status: raw.status || 'open',
    documentDate: raw.documentDate || '',
    dueDate: raw.dueDate || undefined,
    terms: raw.terms || undefined,
    currencyCode: raw.currencyCode || companyCurrency,
    company: {
      name: raw.company?.name || 'Company',
      legalName: raw.company?.legalName,
      ein: raw.company?.ein,
      currency: companyCurrency,
      address: raw.company?.address,
      cityStateZip: raw.company?.cityStateZip,
      phone: raw.company?.phone,
      email: raw.company?.email,
    },
    counterparty: {
      roleLabel: raw.counterparty?.roleLabel || 'Counterparty',
      id: raw.counterparty?.id,
      name: raw.counterparty?.name || 'Customer',
      email: raw.counterparty?.email,
      phone: raw.counterparty?.phone,
      address: raw.counterparty?.address,
    },
    lines: Array.isArray(raw.lines) ? raw.lines : [],
    totals: {
      subtotal: Number(raw.totals?.subtotal ?? 0),
      taxRate: raw.totals?.taxRate !== undefined ? Number(raw.totals.taxRate) : undefined,
      taxAmount: Number(raw.totals?.taxAmount ?? 0),
      total: Number(raw.totals?.total ?? 0),
      amountPaid:
        raw.totals?.amountPaid !== undefined ? Number(raw.totals.amountPaid) : undefined,
      balanceDue:
        raw.totals?.balanceDue !== undefined ? Number(raw.totals.balanceDue) : undefined,
      totalCost:
        raw.totals?.totalCost !== undefined ? Number(raw.totals.totalCost) : undefined,
      grossProfit:
        raw.totals?.grossProfit !== undefined ? Number(raw.totals.grossProfit) : undefined,
    },
    journalEntryNumber: raw.journalEntryNumber || null,
    notes: raw.notes || '',
    contractMeta: raw.contractMeta,
    examMeta: raw.examMeta,
    fileMeta: raw.fileMeta,
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    linkedInvoiceRef: linkedInvoiceId
      ? {
          backendInvoiceId: Number(linkedInvoiceId),
          invoiceNumber: linkedInvoiceNumber,
        }
      : undefined,
    canGenerateInvoice:
      (raw.kind === 'estimate' && raw.status !== 'invoiced') ||
      (raw.kind === 'exam_batch' && !raw.examMeta?.linkedInvoiceId) ||
      (raw.kind === 'contract' && raw.status === 'active'),
  };
}

export function mapLocalInvoiceToPreviewModel(params: {
  invoice: Invoice;
  customer?: Customer;
  companyProfile: CompanyProfile;
  companyNameOverride?: string;
}): DocumentPreviewModel {
  const { invoice, customer, companyProfile, companyNameOverride } = params;
  return {
    kind: 'invoice',
    id: invoice.id,
    backendId: invoice.backendInvoiceId,
    documentNumber: invoice.invoiceNumber,
    title: 'INVOICE',
    status: invoice.status,
    documentDate: invoice.date,
    dueDate: invoice.dueDate,
    terms: invoice.terms,
    currencyCode: companyProfile.currency || 'K',
    company: {
      name: companyNameOverride || companyProfile.name,
      legalName: companyProfile.legalName,
      ein: companyProfile.ein,
      currency: companyProfile.currency || 'K',
      address: companyProfile.address,
      cityStateZip: companyProfile.cityStateZip,
      phone: companyProfile.phone,
      email: companyProfile.email,
    },
    counterparty: {
      roleLabel: 'Bill To',
      id: customer?.id || invoice.customerId,
      name: customer?.companyName || customer?.name || 'Customer',
      email: customer?.email,
      phone: customer?.phone,
      address: customer?.billingAddress,
    },
    lines: invoice.lines.map(l => ({
      description: l.variantName ? `${l.description} (${l.variantName})` : l.description,
      quantity: l.quantity,
      rate: l.rate,
      amount: l.amount,
      unitCost: l.unitCost,
      taxable: l.taxable,
    })),
    totals: {
      subtotal: invoice.subtotal,
      taxRate: invoice.taxRate,
      taxAmount: invoice.taxAmount,
      total: invoice.total,
      amountPaid: invoice.amountPaid,
      balanceDue: invoice.balanceDue,
      totalCost: invoice.totalCost,
      grossProfit: invoice.grossProfit,
    },
    notes: invoice.notes || '',
  };
}

export function mapContractToPreviewModel(params: {
  contract: PrintingContract;
  customer?: Customer;
  companyProfile: CompanyProfile;
  companyNameOverride?: string;
  includeCosts?: boolean;
  onInvoiceGenerated?: (result: { apiInvoice: ApiInvoice; localInvoice?: Invoice }) => void;
}): DocumentPreviewModel {
  const {
    contract,
    customer,
    companyProfile,
    companyNameOverride,
    includeCosts = true,
    onInvoiceGenerated,
  } = params;
  const totalCost = contract.assessments.reduce((s, a) => s + (a.totalCost || 0), 0);
  const schoolName = customer?.companyName || customer?.name || 'School Institution';

  const nextPending = contract.assessments.find(a => a.status === 'pending' && !a.linkedInvoiceId);
  const hasRetainerInvoice = Boolean(contract.depositInvoiceNumber || contract.depositInvoiceId);

  const generateInvoiceInput: GenerateWorkflowInvoicePayload | undefined = !hasRetainerInvoice
    ? {
        sourceKind: 'contract',
        sourceRef: contract.contractNumber,
        customerName: schoolName,
        customerEmail: customer?.email,
        customerPhone: customer?.phone,
        customerAddress: customer?.billingAddress,
        customerType: customer?.customerType || 'school',
        invoiceDate: contract.startDate,
        dueDate: contract.endDate,
        terms: customer?.terms || 'Net 30',
        taxRate: 0,
        notes: `Printing Contract Retainer Invoice for ${contract.contractNumber} (${contract.title}, ${contract.academicYear}).`,
        idempotencyKey: `contract-retainer-${contract.id}`,
        lines: [
          {
            description: `${contract.contractNumber}: ${contract.title} (${contract.totalAssessments} Assessments Retainer)`,
            quantity: 1,
            rate: contract.totalPrepaidAmount,
            unitCost: Math.round(totalCost * 100) / 100,
            taxable: false,
          },
        ],
      }
    : nextPending
    ? {
        sourceKind: 'contract_milestone',
        sourceRef: `${contract.contractNumber}-A${nextPending.assessmentNumber}`,
        customerName: schoolName,
        customerEmail: customer?.email,
        customerPhone: customer?.phone,
        customerAddress: customer?.billingAddress,
        customerType: customer?.customerType || 'school',
        invoiceDate: new Date().toISOString().slice(0, 10),
        dueDate: nextPending.scheduledDate,
        terms: customer?.terms || 'Net 30',
        taxRate: 0,
        notes: `Assessment #${nextPending.assessmentNumber} Invoice under Contract ${contract.contractNumber} (${contract.title}).`,
        idempotencyKey: `contract-ms-${contract.id}-${nextPending.assessmentNumber}`,
        lines: [
          {
            description: `${contract.contractNumber} · #${nextPending.assessmentNumber}: ${nextPending.label} (${nextPending.scheduledDate})`,
            quantity: 1,
            rate: nextPending.agreedAmount,
            unitCost: nextPending.totalCost || 0,
            taxable: false,
          },
        ],
      }
    : undefined;

  return {
    kind: 'contract',
    id: contract.id,
    documentNumber: contract.contractNumber,
    title: 'SCHOOL PRINTING CONTRACT',
    status: contract.status,
    documentDate: contract.startDate,
    dueDate: contract.endDate,
    terms: `${contract.totalAssessments} Assessments (${contract.academicYear})`,
    currencyCode: companyProfile.currency || 'K',
    company: {
      name: companyNameOverride || companyProfile.name,
      legalName: companyProfile.legalName,
      ein: companyProfile.ein,
      currency: companyProfile.currency || 'K',
      address: companyProfile.address,
      cityStateZip: companyProfile.cityStateZip,
      phone: companyProfile.phone,
      email: companyProfile.email,
    },
    counterparty: {
      roleLabel: 'School Institution',
      id: customer?.id || contract.schoolCustomerId,
      name: schoolName,
      email: customer?.email,
      phone: customer?.phone,
      address: customer?.billingAddress,
    },
    contractMeta: {
      contractTitle: contract.title,
      academicYear: contract.academicYear,
      totalPrepaidAmount: contract.totalPrepaidAmount,
      remainingBalance: contract.remainingBalance,
      completedAssessments: contract.completedAssessments,
      totalAssessments: contract.totalAssessments,
      assessments: contract.assessments.map(a => ({
        assessmentNumber: a.assessmentNumber,
        label: a.label,
        scheduledDate: a.scheduledDate,
        agreedAmount: a.agreedAmount,
        estimatedSheets: a.estimatedSheets,
        estimatedImpressions: a.estimatedImpressions,
        totalCost: includeCosts ? a.totalCost : 0,
        profit: includeCosts ? a.profit : 0,
        status: a.status,
        completedDate: a.completedDate,
        linkedInvoiceId: a.linkedInvoiceId,
        linkedInvoiceNumber: a.linkedInvoiceNumber,
      })),
    },
    contractExtras: {
      schoolZone: contract.schoolZone || undefined,
      customerPhone: contract.customerPhone || undefined,
      totalCandidature: contract.expectedCandidates || undefined,
      sittings: contract.sittings || undefined,
      chargePerCandidate: contract.chargePerCandidate || undefined,
      printPaperSummary:
        [contract.printSpec?.paperSize, contract.printSpec?.paperType, contract.printSpec?.paperWeight && `${contract.printSpec.paperWeight}gsm`]
          .filter(Boolean)
          .join(' · ') || undefined,
      printColorSummary: contract.printSpec?.colour || undefined,
      printTypeSummary:
        [contract.printSpec?.sides, contract.printSpec?.orientation].filter(Boolean).join(' · ') || undefined,
      printOrientation: contract.printSpec?.orientation || undefined,
      printFinishing: contract.printSpec?.finishing || undefined,
      printPackaging: contract.printSpec?.packaging || undefined,
      printSpecSummary:
        [
          contract.printSpec?.paperSize,
          contract.printSpec?.paperType,
          contract.printSpec?.paperWeight && `${contract.printSpec.paperWeight}gsm`,
          contract.printSpec?.colour,
          contract.printSpec?.sides,
          contract.printSpec?.orientation,
          contract.printSpec?.pagesPerCopy ? `${contract.printSpec.pagesPerCopy} pages` : undefined,
          contract.printSpec?.copies ? `${contract.printSpec.copies} copies` : undefined,
          contract.printSpec?.finishing,
          contract.printSpec?.packaging,
          contract.printSpec?.notes,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      pricingRulesSummary:
        [
          contract.taxHandling && `Tax: ${contract.taxHandling}`,
          contract.discount && `Discount: ${contract.discount}`,
          contract.urgentFee && `Urgent: ${contract.urgentFee}`,
          contract.pricingNotes,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      deliveryMethod: contract.delivery?.method || undefined,
      deliveryTimeline: contract.delivery?.timeline || undefined,
      deliveryAddress: contract.delivery?.address || undefined,
      deliveryNotes: contract.delivery?.notes || undefined,
      deliveryTermsSummary:
        [
          contract.delivery?.method,
          contract.delivery?.timeline,
          contract.delivery?.address,
          contract.delivery?.packaging,
          contract.delivery?.notes,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      terms: contract.generalTerms || undefined,
      notes: contract.notes || undefined,
    },
    lines: contract.assessments.map(a => ({
      description: `#${a.assessmentNumber}: ${a.label} (Scheduled: ${a.scheduledDate})`,
      quantity: 1,
      rate: a.agreedAmount,
      amount: a.agreedAmount,
      unitCost: includeCosts ? a.totalCost : undefined,
    })),
    totals: {
      subtotal: contract.totalPrepaidAmount,
      taxAmount: 0,
      total: contract.totalPrepaidAmount,
      amountPaid: Math.round((contract.totalPrepaidAmount - contract.remainingBalance) * 100) / 100,
      balanceDue: contract.remainingBalance,
      totalCost: includeCosts ? Math.round(totalCost * 100) / 100 : undefined,
      grossProfit: includeCosts
        ? Math.round((contract.totalPrepaidAmount - totalCost) * 100) / 100
        : undefined,
    },
    notes: contract.notes || '',
    linkedInvoiceRef:
      contract.depositInvoiceId || contract.depositInvoiceNumber || contract.depositBackendInvoiceId
        ? {
            localInvoiceId: contract.depositInvoiceId,
            backendInvoiceId: contract.depositBackendInvoiceId,
            invoiceNumber: contract.depositInvoiceNumber,
          }
        : undefined,
    canGenerateInvoice: Boolean(generateInvoiceInput),
    generateInvoiceInput,
    onInvoiceGenerated,
  };
}

export function mapExamBatchToPreviewModel(params: {
  papers: ExamPaper[];
  customer?: Customer;
  companyProfile: CompanyProfile;
  companyNameOverride?: string;
  includeCosts?: boolean;
  onInvoiceGenerated?: (result: { apiInvoice: ApiInvoice; localInvoice?: Invoice }) => void;
}): DocumentPreviewModel {
  const {
    papers,
    customer,
    companyProfile,
    companyNameOverride,
    includeCosts = true,
    onInvoiceGenerated,
  } = params;
  const lead = papers[0];
  const schoolName = customer?.companyName || customer?.name || 'School Institution';

  // Deduplicate class revenue properly (per learner per class)
  const classGroups = new Map<string, ExamPaper[]>();
  for (const p of papers) {
    const key = `${p.className}__${p.assessmentName}`;
    const arr = classGroups.get(key) || [];
    arr.push(p);
    classGroups.set(key, arr);
  }

  const lines = Array.from(classGroups.values()).map(group => {
    const first = group[0];
    const learners = first.learnersCount || first.copies;
    const rate = first.pricePerLearner;
    const amount = Math.round(learners * rate * 100) / 100;
    const matCost = group.reduce((s, p) => s + (p.materialCost || 0), 0);
    const subjectList = group.map(p => `${p.subjectName} (${p.pages}pp)`).join(', ');
    return {
      description: `${first.className} (${first.assessmentName}) — ${learners} learners · Subjects: ${subjectList}`,
      quantity: learners,
      rate,
      amount,
      unitCost: includeCosts && learners > 0 ? Math.round((matCost / learners) * 10000) / 10000 : undefined,
      taxable: false,
    };
  });

  const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const totalCost = Math.round(papers.reduce((s, p) => s + (p.materialCost || 0), 0) * 100) / 100;
  const allInvoiced = papers.every(p => p.status === 'invoiced');
  const allDelivered = papers.every(p => p.status === 'delivered' || p.status === 'invoiced');
  const linkedInvPaper = papers.find(p => p.invoiceId || p.backendInvoiceId || p.linkedInvoiceNumber);

  const today = new Date().toISOString().slice(0, 10);
  const due = new Date();
  due.setDate(due.getDate() + 30);

  const uninvoicedPapers = papers.filter(p => p.status !== 'invoiced');

  return {
    kind: 'exam_batch',
    id: lead ? lead.id : 'exam-batch',
    documentNumber: lead ? `${lead.jobNumber}${papers.length > 1 ? ` (+${papers.length - 1})` : ''}` : 'EXAM-SHEET',
    title: 'EXAMINATION PRODUCTION & BILLING SHEET',
    status: allInvoiced ? 'invoiced' : lead?.status || 'queued',
    documentDate: lead?.productionDate || today,
    terms: customer?.terms || 'Net 30',
    currencyCode: companyProfile.currency || 'K',
    company: {
      name: companyNameOverride || companyProfile.name,
      legalName: companyProfile.legalName,
      ein: companyProfile.ein,
      currency: companyProfile.currency || 'K',
      address: companyProfile.address,
      cityStateZip: companyProfile.cityStateZip,
      phone: companyProfile.phone,
      email: companyProfile.email,
    },
    counterparty: {
      roleLabel: 'School Institution',
      id: customer?.id || lead?.schoolCustomerId,
      name: schoolName,
      email: customer?.email,
      phone: customer?.phone,
      address: customer?.billingAddress,
    },
    lines,
    examMeta: {
      assessmentName: lead?.assessmentName || 'Examination Batch',
      className: Array.from(new Set(papers.map(p => p.className))).join(', '),
      learnersCount: Array.from(classGroups.values()).reduce(
        (s, g) => s + (g[0].learnersCount || g[0].copies),
        0
      ),
      pricePerLearner: lead?.pricePerLearner || 0,
      linkedInvoiceId: linkedInvPaper?.backendInvoiceId || linkedInvPaper?.invoiceId,
      linkedInvoiceNumber: linkedInvPaper?.linkedInvoiceNumber,
      papers: papers.map(p => ({
        jobNumber: p.jobNumber,
        subjectName: `${p.className} · ${p.subjectName}`,
        pages: p.pages,
        copies: p.copies,
        printSide: p.printSide,
        bindingType: p.bindingType,
        sheetsUsed: p.sheetsUsed,
        impressionsUsed: p.impressionsUsed,
        materialCost: includeCosts ? p.materialCost : 0,
        status: p.status,
      })),
    },
    totals: {
      subtotal,
      taxAmount: 0,
      total: subtotal,
      totalCost: includeCosts ? totalCost : undefined,
      grossProfit: includeCosts ? Math.round((subtotal - totalCost) * 100) / 100 : undefined,
    },
    notes: lead?.notes || '',
    linkedInvoiceRef: linkedInvPaper
      ? {
          localInvoiceId: linkedInvPaper.invoiceId,
          backendInvoiceId: linkedInvPaper.backendInvoiceId,
          invoiceNumber: linkedInvPaper.linkedInvoiceNumber,
        }
      : undefined,
    canGenerateInvoice: allDelivered && uninvoicedPapers.length > 0,
    generateInvoiceInput:
      allDelivered && uninvoicedPapers.length > 0
        ? {
            sourceKind: 'exam_batch',
            sourceRef: lead?.jobNumber || 'exam-batch',
            customerName: schoolName,
            customerEmail: customer?.email,
            customerPhone: customer?.phone,
            customerAddress: customer?.billingAddress,
            customerType: customer?.customerType || 'school',
            invoiceDate: today,
            dueDate: due.toISOString().slice(0, 10),
            terms: customer?.terms || 'Net 30',
            taxRate: 0,
            notes: `Consolidated examination invoice for ${schoolName} — ${lead?.assessmentName || ''} (${uninvoicedPapers.length} subject papers).`,
            idempotencyKey: `exam-invoice-${uninvoicedPapers
              .map(p => p.backendId)
              .filter((id): id is number => typeof id === 'number')
              .sort((a, b) => a - b)
              .join('-')}`,
            postgresExamPaperIds: uninvoicedPapers
              .map(p => p.backendId)
              .filter((id): id is number => typeof id === 'number'),
            lines: lines.map(l => ({
              description: l.description,
              quantity: l.quantity,
              rate: l.rate,
              // WIP is relieved server-side from the linked production jobs.
              unitCost: 0,
              taxable: false,
            })),
          }
        : undefined,
    onInvoiceGenerated,
  };
}

export function mapQuickPrintToPreviewModel(params: {
  job: QuickPrintJob;
  customer?: Customer;
  companyProfile: CompanyProfile;
  companyNameOverride?: string;
  includeCosts?: boolean;
  onInvoiceGenerated?: (result: { apiInvoice: ApiInvoice; localInvoice?: Invoice }) => void;
}): DocumentPreviewModel {
  const {
    job,
    customer,
    companyProfile,
    companyNameOverride,
    includeCosts = true,
    onInvoiceGenerated,
  } = params;
  const due = new Date(job.date || new Date().toISOString().slice(0, 10));
  due.setDate(due.getDate() + 15);

  const round2 = (v: number) => Math.round(v * 100) / 100;
  // sellingPriceTotal is the complete customer-facing amount (photocopying plus
  // the typing & printing service fee). Split it so the receipt shows both
  // components without charging either twice.
  const typingRevenue = round2(job.typingFee || 0);
  const photocopyRevenue = round2(job.sellingPriceTotal - typingRevenue);
  const hasTypingLine = typingRevenue > 0 && job.pages > 0;

  const candidateRate =
    job.sellingPricePerSheet !== undefined
      ? round2(job.sellingPricePerSheet)
      : job.sheetsUsed > 0
      ? round2(photocopyRevenue / job.sheetsUsed)
      : photocopyRevenue;
  const usePerSheetLine =
    job.sheetsUsed > 0 && round2(candidateRate * job.sheetsUsed) === photocopyRevenue;
  const lineQty = usePerSheetLine ? job.sheetsUsed : 1;
  const lineRate = usePerSheetLine ? candidateRate : photocopyRevenue;
  const lineUnitCost = usePerSheetLine
    ? Math.round((job.totalCost / job.sheetsUsed) * 10000) / 10000
    : job.totalCost;

  const photocopyLine = {
    description: hasTypingLine
      ? `Photocopying — ${job.title} (${job.pages} pp × ${job.copies} copies, ${job.printSide} · ${job.sheetsUsed.toLocaleString()} sheets)`
      : `${job.title} (${job.pages} pp × ${job.copies} copies, ${job.printSide} · ${job.sheetsUsed.toLocaleString()} sheets)`,
    quantity: lineQty,
    rate: lineRate,
    amount: photocopyRevenue,
    unitCost: includeCosts ? lineUnitCost : undefined,
    taxable: false,
  };
  const typingLine = {
    description: `Typing & Printing (${job.pages} pp)`,
    quantity: job.pages,
    rate: round2(typingRevenue / job.pages),
    amount: typingRevenue,
    taxable: false,
  };
  const receiptLines = hasTypingLine ? [typingLine, photocopyLine] : [photocopyLine];

  return {
    kind: 'printing_job',
    id: job.id,
    documentNumber: job.jobNumber,
    title: 'QUICK PRINT / PHOTOCOPY RECEIPT',
    status: job.invoiceId || job.backendInvoiceId ? 'invoiced' : 'completed',
    documentDate: job.date,
    terms: job.invoiceId ? 'Billed to Invoice' : 'Counter Sale',
    currencyCode: companyProfile.currency || 'K',
    company: {
      name: companyNameOverride || companyProfile.name,
      legalName: companyProfile.legalName,
      ein: companyProfile.ein,
      currency: companyProfile.currency || 'K',
      address: companyProfile.address,
      cityStateZip: companyProfile.cityStateZip,
      phone: companyProfile.phone,
      email: companyProfile.email,
    },
    counterparty: {
      roleLabel: 'Customer',
      id: customer?.id || job.customerId,
      name: customer?.companyName || job.customerName || 'Walk-In Customer',
      email: customer?.email,
      phone: customer?.phone,
      address: customer?.billingAddress,
    },
    lines: receiptLines,
    quickPrintMeta: {
      jobType: job.jobType,
      pages: job.pages,
      copies: job.copies,
      printSide: job.printSide,
      sheetsUsed: job.sheetsUsed,
      impressionsUsed: job.impressionsUsed,
      paperCost: job.paperCost,
      tonerCost: job.tonerCost,
      extraCost: (job.typingFee || 0) + (job.extraCost || 0),
      typingRevenue,
      photocopyRevenue,
    },
    totals: {
      subtotal: job.sellingPriceTotal,
      taxAmount: 0,
      total: job.sellingPriceTotal,
      totalCost: includeCosts ? job.totalCost : undefined,
      grossProfit: includeCosts ? job.profit : undefined,
    },
    notes: job.notes || '',
    linkedInvoiceRef:
      job.invoiceId || job.backendInvoiceId || job.linkedInvoiceNumber
        ? {
            localInvoiceId: job.invoiceId,
            backendInvoiceId: job.backendInvoiceId,
            invoiceNumber: job.linkedInvoiceNumber,
          }
        : undefined,
    canGenerateInvoice: !job.invoiceId && !job.backendInvoiceId,
    generateInvoiceInput:
      !job.invoiceId && !job.backendInvoiceId
        ? {
            sourceKind: 'quick_print',
            sourceRef: job.jobNumber,
            customerName: customer?.companyName || job.customerName || 'Walk-In Counter Customer',
            customerEmail: customer?.email,
            customerPhone: customer?.phone,
            customerAddress: customer?.billingAddress,
            customerType: customer?.customerType || 'individual',
            invoiceDate: job.date,
            dueDate: due.toISOString().slice(0, 10),
            terms: customer?.terms || 'Due on Receipt',
            taxRate: 0,
            notes: job.notes || `Quick Print Job ${job.jobNumber}: ${job.title}`,
            idempotencyKey: `quick-print-${job.id}`,
            // Lets the server relieve this job's production WIP to COGS when the
            // invoice is raised later from the desk or the document list.
            postgresPrintingJobId: job.backendJobId ?? null,
            lines: hasTypingLine
              ? [
                  {
                    description: `Typing & Printing (${job.pages} pp)`,
                    quantity: job.pages,
                    rate: round2(typingRevenue / job.pages),
                    unitCost: 0,
                    taxable: false,
                  },
                  {
                    description: `${job.jobNumber}: Photocopying — ${job.title} (${job.pages} pp × ${job.copies} copies, ${job.printSide} · ${job.sheetsUsed.toLocaleString()} sheets)`,
                    quantity: lineQty,
                    rate: lineRate,
                    unitCost: lineUnitCost,
                    taxable: false,
                  },
                ]
              : [
                  {
                    description: `${job.jobNumber}: ${job.title} (${job.pages} pp × ${job.copies} copies, ${job.printSide} · ${job.sheetsUsed.toLocaleString()} sheets)`,
                    quantity: lineQty,
                    rate: lineRate,
                    unitCost: lineUnitCost,
                    taxable: false,
                  },
                ],
          }
        : undefined,
    onInvoiceGenerated,
  };
}
