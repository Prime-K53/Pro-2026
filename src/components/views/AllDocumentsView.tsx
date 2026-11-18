import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT } from '../../services/accountingApi';
import { documentsApi } from '../../services/documentsApi';
import {
  DocumentPreviewKind,
  UnifiedDocumentCategory,
  UnifiedDocumentRecord,
  mapApiPreviewToModel,
  mapContractToPreviewModel,
  mapExamBatchToPreviewModel,
  mapLocalInvoiceToPreviewModel,
  mapQuickPrintToPreviewModel,
} from '../../types/documents';
import { formatCurrency } from '../../utils/currency';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';
import {
  FolderOpen,
  Search,
  Upload,
  Eye,
  Printer,
  Download,
  FileSpreadsheet,
  Trash2,
  FileText,
  Receipt,
  BookOpen,
  Paperclip,
  Loader2,
  AlertTriangle,
  ExternalLink,
  X,
} from 'lucide-react';

const KIND_LABELS: Record<DocumentPreviewKind, string> = {
  invoice: 'Invoice',
  sales_receipt: 'Sales Receipt',
  estimate: 'Quote / Estimate',
  credit_memo: 'Credit Memo',
  payment_receipt: 'Payment Receipt',
  bill: 'Vendor Bill',
  purchase_order: 'Purchase Order',
  contract: 'Printing Contract',
  exam_batch: 'Exam Production Sheet',
  printing_job: 'Quick Print Job',
  attachment: 'Uploaded File',
};

function getStatusColorClass(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'paid' || s === 'completed' || s === 'active' || s === 'posted' || s === 'stored') {
    return 'text-emerald-700 dark:text-emerald-400';
  }
  if (s === 'invoiced' || s === 'sent') {
    return 'text-blue-700 dark:text-blue-400';
  }
  if (s === 'partial' || s === 'pending' || s === 'pending_invoice' || s === 'printing' || s === 'queued') {
    return 'text-amber-700 dark:text-amber-400';
  }
  if (s === 'voided' || s === 'cancelled' || s === 'overdue' || s === 'rejected') {
    return 'text-rose-700 dark:text-rose-400';
  }
  return 'text-slate-600 dark:text-slate-400';
}

function formatStatusLabel(status: string): string {
  return String(status || 'open')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

export const AllDocumentsView: React.FC = () => {
  const {
    companyProfile,
    customers,
    invoices: localInvoices,
    printingContracts,
    examPapers,
    quickPrintJobs,
    tableDensity,
    openDocumentPreview,
    generateAndSyncWorkflowInvoice,
    linkContractDepositInvoice,
    linkExamPapersInvoice,
    linkQuickPrintInvoice,
    getInvoiceById,
    triggerShortcutNotice,
  } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();

  const currency = companyProfile.currency || 'K';
  const canReadBills = hasPermission('bills:read');
  const canReadCosts = hasPermission('estimates:read_costs');
  const canWriteInvoices = hasPermission('invoices:write');
  const canWriteAttachments = hasPermission('attachments:write');

  const [pgDocuments, setPgDocuments] = useState<UnifiedDocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [categoryFilter, setCategoryFilter] = useState<'all' | UnifiedDocumentCategory>('all');
  const [kindFilter, setKindFilter] = useState<'all' | DocumentPreviewKind>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Upload Attachment Modal
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [uploadEntityType, setUploadEntityType] = useState('company_vault');
  const [uploadEntityId, setUploadEntityId] = useState('1');
  const [uploadNotes, setUploadNotes] = useState('');
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadContentType, setUploadContentType] = useState('application/octet-stream');
  const [uploadBase64, setUploadBase64] = useState('');
  const [uploading, setUploading] = useState(false);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const resp = await documentsApi.listDocuments();
      setPgDocuments(resp.documents || []);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to load company documents');
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    const handler = () => loadDocuments();
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, [loadDocuments]);

  // Merge Postgres records cleanly with active AccountingContext workflows, deduplicated by doc number/uid
  const mergedDocuments = useMemo(() => {
    const seenDocNumbers = new Set<string>(
      pgDocuments.map(d => d.documentNumber.trim().toLowerCase())
    );
    const seenUids = new Set<string>(pgDocuments.map(d => d.uid));
    const list: UnifiedDocumentRecord[] = [...pgDocuments];

    // 1. Active Contracts in AccountingContext
    for (const ctr of printingContracts) {
      const docKey = ctr.contractNumber.trim().toLowerCase();
      if (seenDocNumbers.has(docKey)) continue;
      seenDocNumbers.add(docKey);
      const school = customers.find(c => c.id === ctr.schoolCustomerId);
      list.push({
        uid: `ws-contract-${ctr.id}`,
        id: ctr.id,
        kind: 'contract',
        category: 'contracts_exams',
        documentNumber: ctr.contractNumber,
        title: ctr.title,
        counterpartyName: school?.companyName || 'School Institution',
        counterpartyId: ctr.schoolCustomerId,
        documentDate: ctr.startDate,
        dueDate: ctr.endDate,
        status: ctr.status,
        amount: ctr.totalPrepaidAmount,
        balanceDue: ctr.remainingBalance,
        currencyCode: currency,
        journalTxnId: null,
        linkedInvoiceId: ctr.depositBackendInvoiceId ?? ctr.depositInvoiceId ?? null,
        linkedInvoiceNumber: ctr.depositInvoiceNumber ?? null,
        canGenerateInvoice: !ctr.depositInvoiceId && !ctr.depositBackendInvoiceId,
        notes: ctr.notes || '',
        source: 'workspace',
        workspaceRef: { contractId: ctr.id },
      });
    }

    // 2. Active Examination Class Batches in AccountingContext
    const examGroups = new Map<string, typeof examPapers>();
    for (const paper of examPapers) {
      const key = `${paper.schoolCustomerId}__${paper.assessmentName}__${paper.className}`;
      const arr = examGroups.get(key) || [];
      arr.push(paper);
      examGroups.set(key, arr);
    }
    for (const [, group] of examGroups) {
      const lead = group[0];
      const uid = `ws-exam-${lead.id}`;
      if (seenUids.has(uid)) continue;
      const school = customers.find(c => c.id === lead.schoolCustomerId);
      const allInvoiced = group.every(p => p.status === 'invoiced');
      const linked = group.find(p => p.backendInvoiceId || p.invoiceId || p.linkedInvoiceNumber);
      const classRevenue = Math.round(lead.learnersCount * lead.pricePerLearner * 100) / 100;
      const docNum = `${lead.jobNumber}${group.length > 1 ? ` (+${group.length - 1})` : ''}`;
      if (seenDocNumbers.has(docNum.trim().toLowerCase())) continue;

      list.push({
        uid,
        id: lead.id,
        kind: 'exam_batch',
        category: 'contracts_exams',
        documentNumber: docNum,
        title: `${lead.assessmentName} — ${lead.className} (${group.length} subject papers)`,
        counterpartyName: school?.companyName || 'School Institution',
        counterpartyId: lead.schoolCustomerId,
        documentDate: lead.productionDate,
        dueDate: null,
        status: allInvoiced ? 'invoiced' : lead.status,
        amount: classRevenue,
        balanceDue: null,
        currencyCode: currency,
        journalTxnId: null,
        linkedInvoiceId: linked?.backendInvoiceId ?? linked?.invoiceId ?? null,
        linkedInvoiceNumber: linked?.linkedInvoiceNumber ?? null,
        canGenerateInvoice: group.some(p => p.status !== 'invoiced'),
        notes: lead.notes || '',
        source: 'workspace',
        workspaceRef: { examPaperIds: group.map(p => p.id) },
      });
    }

    // 3. Active Quick Print Jobs in AccountingContext
    for (const job of quickPrintJobs) {
      const docKey = job.jobNumber.trim().toLowerCase();
      if (seenDocNumbers.has(docKey)) continue;
      seenDocNumbers.add(docKey);
      list.push({
        uid: `ws-qpr-${job.id}`,
        id: job.id,
        kind: 'printing_job',
        category: 'contracts_exams',
        documentNumber: job.jobNumber,
        title: job.title,
        counterpartyName: job.customerName,
        counterpartyId: job.customerId || null,
        documentDate: job.date,
        dueDate: null,
        status: job.invoiceId || job.backendInvoiceId ? 'invoiced' : 'completed',
        amount: job.sellingPriceTotal,
        balanceDue: null,
        currencyCode: currency,
        journalTxnId: null,
        linkedInvoiceId: job.backendInvoiceId ?? job.invoiceId ?? null,
        linkedInvoiceNumber: job.linkedInvoiceNumber ?? null,
        canGenerateInvoice: !job.invoiceId && !job.backendInvoiceId,
        notes: job.notes || '',
        source: 'workspace',
        workspaceRef: { quickPrintJobId: job.id },
      });
    }

    // 4. Local-only Invoices not already returned from Postgres
    for (const inv of localInvoices) {
      const docKey = inv.invoiceNumber.trim().toLowerCase();
      if (seenDocNumbers.has(docKey)) continue;
      seenDocNumbers.add(docKey);
      const cust = customers.find(c => c.id === inv.customerId);
      list.push({
        uid: `ws-inv-${inv.id}`,
        id: inv.id,
        kind: 'invoice',
        category: 'sales',
        documentNumber: inv.invoiceNumber,
        title: `Invoice ${inv.invoiceNumber}`,
        counterpartyName: cust?.companyName || 'Customer',
        counterpartyId: inv.customerId,
        documentDate: inv.date,
        dueDate: inv.dueDate,
        status: inv.status,
        amount: inv.total,
        balanceDue: inv.balanceDue,
        currencyCode: currency,
        journalTxnId: null,
        linkedInvoiceId: inv.backendInvoiceId ?? inv.id,
        linkedInvoiceNumber: inv.invoiceNumber,
        canGenerateInvoice: false,
        notes: inv.notes || '',
        source: 'workspace',
      });
    }

    list.sort((a, b) => (b.documentDate || '').localeCompare(a.documentDate || ''));
    return list;
  }, [pgDocuments, printingContracts, examPapers, quickPrintJobs, localInvoices, customers, currency]);

  const counts = useMemo(() => {
    return {
      all: mergedDocuments.length,
      sales: mergedDocuments.filter(d => d.category === 'sales').length,
      quotes: mergedDocuments.filter(d => d.category === 'quotes').length,
      contracts_exams: mergedDocuments.filter(d => d.category === 'contracts_exams').length,
      purchasing: mergedDocuments.filter(d => d.category === 'purchasing').length,
      files: mergedDocuments.filter(d => d.category === 'files').length,
    };
  }, [mergedDocuments]);

  const filteredDocuments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return mergedDocuments.filter(d => {
      if (categoryFilter !== 'all' && d.category !== categoryFilter) return false;
      if (kindFilter !== 'all' && d.kind !== kindFilter) return false;
      if (q) {
        return (
          d.documentNumber.toLowerCase().includes(q) ||
          d.title.toLowerCase().includes(q) ||
          d.counterpartyName.toLowerCase().includes(q) ||
          d.status.toLowerCase().includes(q) ||
          d.notes.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [mergedDocuments, categoryFilter, kindFilter, searchQuery]);

  // KPIs
  const salesTotalValue = mergedDocuments
    .filter(d => d.kind === 'invoice' || d.kind === 'sales_receipt')
    .reduce((s, d) => s + (d.amount || 0), 0);
  const contractsAndExamsCount = counts.contracts_exams;
  const vaultFilesCount = counts.files;

  const handlePreviewDocument = async (doc: UnifiedDocumentRecord) => {
    setBusyId(doc.uid);
    setErrorMsg(null);
    try {
      if (doc.source === 'postgres' && typeof doc.id === 'number') {
        const preview = await documentsApi.getDocumentPreview(doc.kind, doc.id);
        openDocumentPreview(mapApiPreviewToModel(preview, currency));
        return;
      }

      // Workspace fallback mappers
      if (doc.kind === 'contract' && doc.workspaceRef?.contractId) {
        const ctr = printingContracts.find(c => c.id === doc.workspaceRef!.contractId);
        if (ctr) {
          const cust = customers.find(c => c.id === ctr.schoolCustomerId);
          openDocumentPreview(
            mapContractToPreviewModel({
              contract: ctr,
              customer: cust,
              companyProfile,
              companyNameOverride: activeCompany?.name,
              includeCosts: canReadCosts,
              onInvoiceGenerated: ({ apiInvoice, localInvoice }) => {
                linkContractDepositInvoice(ctr.id, {
                  invoiceId: localInvoice?.id,
                  backendInvoiceId: apiInvoice.id,
                  invoiceNumber: apiInvoice.invoiceNumber,
                });
              },
            })
          );
          return;
        }
      }

      if (doc.kind === 'exam_batch' && doc.workspaceRef?.examPaperIds) {
        const papers = examPapers.filter(p => doc.workspaceRef!.examPaperIds!.includes(p.id));
        if (papers.length > 0) {
          const cust = customers.find(c => c.id === papers[0].schoolCustomerId);
          openDocumentPreview(
            mapExamBatchToPreviewModel({
              papers,
              customer: cust,
              companyProfile,
              companyNameOverride: activeCompany?.name,
              includeCosts: canReadCosts,
              onInvoiceGenerated: ({ apiInvoice, localInvoice }) => {
                linkExamPapersInvoice(
                  papers.map(p => p.id),
                  {
                    invoiceId: localInvoice?.id,
                    backendInvoiceId: apiInvoice.id,
                    invoiceNumber: apiInvoice.invoiceNumber,
                  }
                );
              },
            })
          );
          return;
        }
      }

      if (doc.kind === 'printing_job' && doc.workspaceRef?.quickPrintJobId) {
        const job = quickPrintJobs.find(j => j.id === doc.workspaceRef!.quickPrintJobId);
        if (job) {
          const cust = job.customerId
            ? customers.find(c => c.id === job.customerId)
            : undefined;
          openDocumentPreview(
            mapQuickPrintToPreviewModel({
              job,
              customer: cust,
              companyProfile,
              companyNameOverride: activeCompany?.name,
              includeCosts: canReadCosts,
              onInvoiceGenerated: ({ apiInvoice, localInvoice }) => {
                linkQuickPrintInvoice(job.id, {
                  invoiceId: localInvoice?.id,
                  backendInvoiceId: apiInvoice.id,
                  invoiceNumber: apiInvoice.invoiceNumber,
                });
              },
            })
          );
          return;
        }
      }

      if (doc.kind === 'invoice') {
        const local = getInvoiceById(String(doc.id));
        if (local) {
          const cust = customers.find(c => c.id === local.customerId);
          openDocumentPreview(
            mapLocalInvoiceToPreviewModel({
              invoice: local,
              customer: cust,
              companyProfile,
              companyNameOverride: activeCompany?.name,
            })
          );
        }
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load document preview');
    } finally {
      setBusyId(null);
    }
  };

  const handleGenerateInvoiceFromRow = async (doc: UnifiedDocumentRecord) => {
    setBusyId(doc.uid);
    setErrorMsg(null);
    try {
      // If Estimate in Postgres -> convert via commercialApi
      if (doc.source === 'postgres' && doc.kind === 'estimate' && typeof doc.id === 'number') {
        const res = await import('../../services/commercialApi').then(m =>
          m.commercialApi.convertEstimate(Number(doc.id))
        );
        triggerShortcutNotice(`Converted ${doc.documentNumber} → Invoice ${res.invoice?.invoiceNumber}`);
        if (res.invoice?.id) {
          const preview = await documentsApi.getDocumentPreview('invoice', res.invoice.id);
          openDocumentPreview(mapApiPreviewToModel(preview, currency));
        }
        await loadDocuments();
        return;
      }

      // Workspace Contract
      if (doc.kind === 'contract' && doc.workspaceRef?.contractId) {
        const ctr = printingContracts.find(c => c.id === doc.workspaceRef!.contractId);
        if (!ctr) return;
        const cust = customers.find(c => c.id === ctr.schoolCustomerId);
        const model = mapContractToPreviewModel({
          contract: ctr,
          customer: cust,
          companyProfile,
          companyNameOverride: activeCompany?.name,
          includeCosts: canReadCosts,
        });
        if (!model.generateInvoiceInput) return;
        const { apiInvoice, localInvoice } = await generateAndSyncWorkflowInvoice(
          model.generateInvoiceInput,
          { localCustomerId: ctr.schoolCustomerId }
        );
        linkContractDepositInvoice(ctr.id, {
          invoiceId: localInvoice.id,
          backendInvoiceId: apiInvoice.id,
          invoiceNumber: apiInvoice.invoiceNumber,
        });
        triggerShortcutNotice(`Generated Invoice ${apiInvoice.invoiceNumber} for ${ctr.contractNumber}`);
        const preview = await documentsApi.getDocumentPreview('invoice', apiInvoice.id);
        openDocumentPreview(mapApiPreviewToModel(preview, currency));
        return;
      }

      // Workspace Exam Batch
      if (doc.kind === 'exam_batch' && doc.workspaceRef?.examPaperIds) {
        const papers = examPapers.filter(
          p => doc.workspaceRef!.examPaperIds!.includes(p.id) && p.status !== 'invoiced'
        );
        if (papers.length === 0) return;
        const cust = customers.find(c => c.id === papers[0].schoolCustomerId);
        const model = mapExamBatchToPreviewModel({
          papers,
          customer: cust,
          companyProfile,
          companyNameOverride: activeCompany?.name,
          includeCosts: canReadCosts,
        });
        if (!model.generateInvoiceInput) return;
        const { apiInvoice, localInvoice } = await generateAndSyncWorkflowInvoice(
          model.generateInvoiceInput,
          { localCustomerId: papers[0].schoolCustomerId }
        );
        linkExamPapersInvoice(
          papers.map(p => p.id),
          {
            invoiceId: localInvoice.id,
            backendInvoiceId: apiInvoice.id,
            invoiceNumber: apiInvoice.invoiceNumber,
          }
        );
        triggerShortcutNotice(`Generated Exam Invoice ${apiInvoice.invoiceNumber}`);
        const preview = await documentsApi.getDocumentPreview('invoice', apiInvoice.id);
        openDocumentPreview(mapApiPreviewToModel(preview, currency));
        return;
      }

      // Workspace Quick Print Job
      if (doc.kind === 'printing_job' && doc.workspaceRef?.quickPrintJobId) {
        const job = quickPrintJobs.find(j => j.id === doc.workspaceRef!.quickPrintJobId);
        if (!job) return;
        const cust = job.customerId ? customers.find(c => c.id === job.customerId) : undefined;
        const model = mapQuickPrintToPreviewModel({
          job,
          customer: cust,
          companyProfile,
          companyNameOverride: activeCompany?.name,
          includeCosts: canReadCosts,
        });
        if (!model.generateInvoiceInput) return;
        const { apiInvoice, localInvoice } = await generateAndSyncWorkflowInvoice(
          model.generateInvoiceInput,
          { localCustomerId: job.customerId }
        );
        linkQuickPrintInvoice(job.id, {
          invoiceId: localInvoice.id,
          backendInvoiceId: apiInvoice.id,
          invoiceNumber: apiInvoice.invoiceNumber,
        });
        triggerShortcutNotice(`Generated Invoice ${apiInvoice.invoiceNumber} for ${job.jobNumber}`);
        const preview = await documentsApi.getDocumentPreview('invoice', apiInvoice.id);
        openDocumentPreview(mapApiPreviewToModel(preview, currency));
        return;
      }

      // Postgres Contract / Exam Batch / Printing Job
      if (doc.source === 'postgres' && typeof doc.id === 'number') {
        const { invoice: apiInvoice } = await documentsApi.generateWorkflowInvoice({
          sourceKind:
            doc.kind === 'contract'
              ? 'contract'
              : doc.kind === 'exam_batch'
              ? 'exam_batch'
              : doc.kind === 'printing_job'
              ? 'quick_print'
              : 'custom',
          sourceRef: doc.documentNumber,
          customerId: typeof doc.counterpartyId === 'number' ? doc.counterpartyId : undefined,
          customerName: doc.counterpartyName,
          notes: `Generated from ${doc.documentNumber}: ${doc.title}`,
          lines: [
            {
              description: `${doc.documentNumber}: ${doc.title}`,
              quantity: 1,
              rate: doc.amount > 0 ? doc.amount : 0,
              taxable: false,
            },
          ],
          postgresContractId: doc.kind === 'contract' ? doc.id : undefined,
          postgresExamBatchId: doc.kind === 'exam_batch' ? doc.id : undefined,
          postgresPrintingJobId: doc.kind === 'printing_job' ? doc.id : undefined,
        });
        triggerShortcutNotice(`Generated Invoice ${apiInvoice.invoiceNumber}`);
        await loadDocuments();
        const preview = await documentsApi.getDocumentPreview('invoice', apiInvoice.id);
        openDocumentPreview(mapApiPreviewToModel(preview, currency));
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Invoice generation failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleOpenLinkedInvoice = async (doc: UnifiedDocumentRecord) => {
    setBusyId(doc.uid);
    try {
      if (typeof doc.linkedInvoiceId === 'number') {
        const preview = await documentsApi.getDocumentPreview('invoice', doc.linkedInvoiceId);
        openDocumentPreview(mapApiPreviewToModel(preview, currency));
        return;
      }
      if (typeof doc.linkedInvoiceId === 'string') {
        const local = getInvoiceById(doc.linkedInvoiceId);
        if (local) {
          const cust = customers.find(c => c.id === local.customerId);
          openDocumentPreview(
            mapLocalInvoiceToPreviewModel({
              invoice: local,
              customer: cust,
              companyProfile,
              companyNameOverride: activeCompany?.name,
            })
          );
        }
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load linked invoice');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteAttachment = async (doc: UnifiedDocumentRecord) => {
    if (!doc.fileInfo) return;
    setBusyId(doc.uid);
    setErrorMsg(null);
    try {
      await documentsApi.deleteAttachment(doc.fileInfo.attachmentId);
      triggerShortcutNotice(`Removed ${doc.fileInfo.originalName} from All Documents`);
      await loadDocuments();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to delete attachment');
    } finally {
      setBusyId(null);
    }
  };

  const buildDocActionContext = (doc: UnifiedDocumentRecord, pendingId?: string | null): ActionEligibilityContext<UnifiedDocumentRecord> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'documents',
    entityType: doc.kind,
    record: doc,
    recordStatus: doc.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const buildDocActionDefinitions = (doc: UnifiedDocumentRecord): AdvancedActionDefinition<UnifiedDocumentRecord>[] => {
    const defs: AdvancedActionDefinition<UnifiedDocumentRecord>[] = [
      {
        id: 'doc.preview-print',
        label: 'Open Print Preview',
        icon: <Printer className="w-3.5 h-3.5 text-slate-600" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'documents:read',
        execute: async () => { await handlePreviewDocument(doc); },
      },
    ];
    if (doc.canGenerateInvoice && canWriteInvoices) {
      defs.push({
        id: 'doc.generate-invoice',
        label: doc.kind === 'estimate' ? 'Convert Estimate to Invoice' : 'Generate Invoice',
        icon: <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />,
        group: 'process',
        groupLabel: 'Actions',
        requiredPermission: 'invoices:write',
        execute: async () => { await handleGenerateInvoiceFromRow(doc); },
      });
    }
    if (doc.linkedInvoiceId && doc.kind !== 'invoice') {
      defs.push({
        id: 'doc.view-linked-invoice',
        label: `Preview Linked Invoice${doc.linkedInvoiceNumber ? ` (${doc.linkedInvoiceNumber})` : ''}`,
        icon: <ExternalLink className="w-3.5 h-3.5 text-blue-600" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'invoices:read',
        execute: async () => { await handleOpenLinkedInvoice(doc); },
      });
    }
    if (doc.fileInfo) {
      defs.push({
        id: 'doc.download-file',
        label: 'Download File',
        icon: <Download className="w-3.5 h-3.5 text-blue-600" />,
        group: 'view',
        groupLabel: 'File',
        requiredPermission: 'documents:read',
        execute: async () => { await documentsApi.downloadAttachment(doc.fileInfo!.attachmentId, doc.fileInfo!.originalName); },
      });
      if (canWriteAttachments) {
        defs.push({
          id: 'doc.delete-file',
          label: 'Delete File from Vault',
          icon: <Trash2 className="w-3.5 h-3.5 text-rose-600" />,
          group: 'danger',
          groupLabel: 'Sensitive operations',
          destructive: true,
          risk: 'destructive',
          requiredPermission: 'attachments:write',
          confirmation: { title: `Delete ${doc.fileInfo.originalName}`, message: 'Delete this file from the vault?', confirmLabel: 'Delete', destructive: true },
          execute: async () => { await handleDeleteAttachment(doc); },
        });
      }
    }
    return defs;
  };

  const renderDocActions = (doc: UnifiedDocumentRecord) => {
    const defs = buildDocActionDefinitions(doc);
    const ctx = buildDocActionContext(doc, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<UnifiedDocumentRecord>
        label={`Document actions for ${doc.documentNumber}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={doc.uid}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => {
          const def = action.definition;
          if (typeof def.execute === 'function') {
            await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) });
          }
        }}
      />
    );
  };

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFileName(file.name);
    setUploadContentType(file.type || 'application/octet-stream');
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      setUploadBase64(base64);
    };
    reader.readAsDataURL(file);
  };

  const handleSubmitUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFileName || !uploadBase64) return;
    setUploading(true);
    setErrorMsg(null);
    try {
      await documentsApi.uploadAttachment({
        fileName: uploadFileName,
        contentType: uploadContentType,
        entityType: uploadEntityType,
        entityId: Math.max(1, parseInt(uploadEntityId, 10) || 1),
        contentBase64: uploadBase64,
        notes: uploadNotes.trim() || undefined,
      });
      triggerShortcutNotice(`Uploaded ${uploadFileName} to Company Vault`);
      setIsUploadOpen(false);
      setUploadFileName('');
      setUploadBase64('');
      setUploadNotes('');
      await loadDocuments();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const categoryTabs: Array<{ id: 'all' | UnifiedDocumentCategory; label: string; count: number }> = [
    { id: 'all', label: 'All Documents', count: counts.all },
    { id: 'sales', label: 'Invoices & Receipts', count: counts.sales },
    { id: 'quotes', label: 'Quotes & Estimates', count: counts.quotes },
    { id: 'contracts_exams', label: 'Contracts & Exams', count: counts.contracts_exams },
    ...(canReadBills
      ? [{ id: 'purchasing' as const, label: 'Bills & Purchasing', count: counts.purchasing }]
      : []),
    { id: 'files', label: 'Uploaded Files', count: counts.files },
  ];

  const cellPad = tableDensity === 'compact' ? 'px-4 py-2' : 'px-4 py-3';

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            All Documents & File Vault
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Unified repository of Invoices, Sales Receipts, Estimates, School Contracts, Examination Sheets, Vendor Bills, and Uploaded Files.
          </p>
        </div>

        {canWriteAttachments && (
          <button
            onClick={() => setIsUploadOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-xs"
          >
            <Upload className="w-4 h-4" />
            <span>Upload & Attach Document</span>
          </button>
        )}
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs flex items-center justify-between"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            <span>{errorMsg}</span>
          </span>
          <button onClick={() => setErrorMsg(null)} className="underline font-semibold">
            Dismiss
          </button>
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Total Indexed Documents
            </div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {counts.all}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">Company-isolated ledger & vault</div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <FolderOpen className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Invoices & Receipts Value
            </div>
            <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1 tabular-nums">
              {formatCurrency(salesTotalValue, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono">
              {counts.sales} commercial documents
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Contracts & Exam Sheets
            </div>
            <div className="text-xl font-bold font-mono text-indigo-600 dark:text-indigo-400 mt-1 tabular-nums">
              {contractsAndExamsCount}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Ready for preview & invoicing
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <BookOpen className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Uploaded Vault Files
            </div>
            <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400 mt-1 tabular-nums">
              {vaultFilesCount}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              PDFs, scans, snapshots & files
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
            <Paperclip className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Category Tabs, Kind Filter & Search */}
      <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-semibold">
          {categoryTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setCategoryFilter(tab.id)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                categoryFilter === tab.id
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <select
            value={kindFilter}
            onChange={e => setKindFilter(e.target.value as any)}
            className="bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100 outline-none"
          >
            <option value="all">All Document Types</option>
            {Object.entries(KIND_LABELS).map(([k, label]) => {
              if (!canReadBills && (k === 'bill' || k === 'purchase_order')) return null;
              return (
                <option key={k} value={k}>
                  {label}
                </option>
              );
            })}
          </select>

          <div className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 absolute left-3 top-2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search doc #, title, school, customer..."
              className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-850 text-xs text-slate-900 dark:text-slate-100 outline-none"
            />
          </div>
        </div>
      </div>

      {/* Unified Documents Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        {loading ? (
          <div className="py-12 flex items-center justify-center gap-2 text-xs text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading unified document index...
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-3">DOCUMENT #</th>
                  <th className="px-4 py-3">TYPE</th>
                  <th className="px-4 py-3">TITLE & REFERENCE</th>
                  <th className="px-4 py-3">COUNTERPARTY</th>
                  <th className="px-4 py-3">DATE</th>
                  <th className="px-4 py-3 text-right">AMOUNT</th>
                  <th className="px-4 py-3 text-center">STATUS</th>
                  <th className="px-4 py-3 text-right">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                {filteredDocuments.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-slate-500 font-sans">
                      No documents match the current filter.
                    </td>
                  </tr>
                ) : (
                  filteredDocuments.map(doc => {
                    const isBusy = busyId === doc.uid;
                    return (
                      <tr key={doc.uid} className="hover:bg-slate-50 dark:hover:bg-slate-850/50">
                        <td className={`${cellPad} font-bold text-blue-600 dark:text-blue-400 whitespace-nowrap`}>
                          <button
                            type="button"
                            onClick={() => handlePreviewDocument(doc)}
                            className="hover:underline text-left"
                          >
                            {doc.documentNumber}
                          </button>
                        </td>
                        <td className={`${cellPad} font-sans text-slate-600 dark:text-slate-300 whitespace-nowrap`}>
                          {KIND_LABELS[doc.kind]}
                        </td>
                        <td className={`${cellPad} font-sans max-w-xs`}>
                          <div className="font-semibold text-slate-900 dark:text-white truncate">
                            {doc.title}
                          </div>
                          {(doc.linkedInvoiceNumber || doc.notes) && (
                            <div className="text-[11px] text-slate-500 truncate">
                              {doc.linkedInvoiceNumber
                                ? `Linked Invoice: ${doc.linkedInvoiceNumber}`
                                : doc.notes}
                            </div>
                          )}
                        </td>
                        <td className={`${cellPad} font-sans font-medium text-slate-800 dark:text-slate-200`}>
                          {doc.counterpartyName}
                        </td>
                        <td className={`${cellPad} text-slate-500 whitespace-nowrap tabular-nums`}>
                          {doc.documentDate}
                        </td>
                        <td className={`${cellPad} text-right font-bold tabular-nums text-slate-900 dark:text-white`}>
                          {doc.kind === 'attachment' && doc.fileInfo
                            ? `${(doc.fileInfo.sizeBytes / 1024).toFixed(1)} KB`
                            : formatCurrency(doc.amount || 0, currency)}
                        </td>
                        <td className={`${cellPad} text-center font-sans text-[11px] font-semibold`}>
                          <span className={getStatusColorClass(doc.status)}>
                            {formatStatusLabel(doc.status)}
                          </span>
                        </td>
                        <td className={`${cellPad} text-right font-sans whitespace-nowrap`}>
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handlePreviewDocument(doc)}
                              disabled={isBusy}
                              className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1"
                            >
                              {isBusy ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Eye className="w-3 h-3 text-blue-600" />
                              )}
                              <span>Preview</span>
                            </button>

                            {renderDocActions(doc)}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Upload & Attach Document Modal */}
      {isUploadOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm flex items-center gap-2">
                <Upload className="w-4 h-4 text-amber-400" />
                <span>Upload & Attach Document to Company Vault</span>
              </span>
              <button onClick={() => setIsUploadOpen(false)} className="p-1 text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitUpload} className="p-5 space-y-4 text-xs">
              <div>
                <label className="font-semibold block mb-1 text-slate-700 dark:text-slate-300">
                  Select File (PDF, Image, CSV, Text, Word/Document) *
                </label>
                <input
                  type="file"
                  onChange={handleFileSelected}
                  className="w-full border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 bg-slate-50 dark:bg-slate-950"
                  required
                />
                {uploadFileName && (
                  <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-1 font-mono">
                    Ready: {uploadFileName} ({uploadContentType})
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1 text-slate-700 dark:text-slate-300">
                    Link To Module
                  </label>
                  <select
                    value={uploadEntityType}
                    onChange={e => setUploadEntityType(e.target.value)}
                    className="w-full border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2 bg-white dark:bg-slate-950"
                  >
                    <option value="company_vault">General Company Vault</option>
                    <option value="printing_contract">School Printing Contract</option>
                    <option value="exam_batch">Examination Batch</option>
                    <option value="invoice">Invoice / Sales Receipt</option>
                    <option value="estimate">Quote / Estimate</option>
                    <option value="bill">Vendor Bill</option>
                  </select>
                </div>

                <div>
                  <label className="font-semibold block mb-1 text-slate-700 dark:text-slate-300">
                    Record Reference ID
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={uploadEntityId}
                    onChange={e => setUploadEntityId(e.target.value)}
                    className="w-full border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2 bg-white dark:bg-slate-950 font-mono"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="font-semibold block mb-1 text-slate-700 dark:text-slate-300">
                  Description / Notes
                </label>
                <input
                  type="text"
                  value={uploadNotes}
                  onChange={e => setUploadNotes(e.target.value)}
                  placeholder="e.g. Signed 2026 school printing agreement scan"
                  className="w-full border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2 bg-white dark:bg-slate-950"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsUploadOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uploading || !uploadBase64}
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold flex items-center gap-1.5"
                >
                  {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Receipt className="w-3.5 h-3.5" />}
                  <span>Save to Documents</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
