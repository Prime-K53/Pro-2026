import React, { useState, useMemo, useEffect } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { printingApi } from '../../services/printingApi';
import { useAuth } from '../../context/AuthContext';
import { ExamPaper } from '../../types/accounting';
import { documentsApi } from '../../services/documentsApi';
import {
  mapApiPreviewToModel,
  mapExamBatchToPreviewModel,
  mapLocalInvoiceToPreviewModel,
} from '../../types/documents';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';
import { appDialog } from '../../design-system';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { ExamGroupWorkflowModal } from './ExamGroupWorkflowModal';
import { useExamGroupSelection } from '../../hooks/useExamGroupSelection';
import { resolveActions } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';
import {
  BookOpen,
  Plus,
  Search,
  Printer,
  CheckCircle2,
  Clock,
  FileText,
  X,
  Trash2,
  Copy,
  Layers,
  AlertCircle,
  TrendingUp,
  Eye,
  Truck,
  History,
  RotateCcw,
  Ban,
  ShieldCheck,
  Package,
} from 'lucide-react';
import {
  buildPaperStockFromInventoryItem,
  buildTonerSpecFromInventoryItem,
  calculateExaminationProductionWorkflow,
} from '../../shared/printingWorkflows';
import type { TonerMachineSpec } from '../../shared/tonerCalc';

const EXAM_PRESS_CAPABILITY: TonerMachineSpec = {
  machineId: 'exam-digital-press',
  name: 'Examination Production Press',
  processType: 'digital_press',
  supportsColour: false,
  supportsDuplex: true,
  status: 'active',
};

interface DraftBatchRow {
  className: string;
  learnersCount: number;
  pricePerLearner: number;
  subjectName: string;
  pages: number;
  copies: number;
  bindingType: ExamPaper['bindingType'];
}

export const ExaminationView: React.FC = () => {
  const {
    companyProfile,
    customers,
    inventoryItems,
    examPapers,
    printingContracts,
    addExamPapersBatch,
    updateExamPaper,
    editExamPaper,
    updateExamPaperStatus,
    deliverExamPaper,
    deleteExamPaper,
    cancelExamPaper,
    reprintExamPaper,
    getExamPaperEvents,
    getExamReconciliation,
    createConsolidatedSchoolInvoice,
    linkExamPapersInvoice,
    getRawUsageUnitCost,
    getInvoiceById,
    openDocumentPreview,
    setCurrentView,
    triggerShortcutNotice,
  } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const canReadCosts = hasPermission('estimates:read_costs');
  const currency = companyProfile.currency || 'K';
  const currencySymbol = getCurrencySymbol(currency);

  const rawMaterials = useMemo(
    () => inventoryItems.filter(i => i.type === 'raw_material'),
    [inventoryItems]
  );
  const defaultPaperId =
    rawMaterials.find(r => (r.usageUnit || '').toLowerCase().includes('sheet'))?.id ||
    rawMaterials[0]?.id ||
    '';
  const defaultTonerId =
    rawMaterials.find(r => (r.usageUnit || '').toLowerCase().includes('impression'))?.id ||
    rawMaterials[1]?.id ||
    rawMaterials[0]?.id ||
    '';

  const printServiceItems = useMemo(
    () => inventoryItems.filter(i => i.type === 'printing_service' || i.type === 'printed_product'),
    [inventoryItems]
  );

  // Filters & selection
  const [selectedSchoolFilter, setSelectedSchoolFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPaperIds, setSelectedPaperIds] = useState<string[]>([]);

  // Batch / New Exam Job Modal state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [batchSubmissionId, setBatchSubmissionId] = useState(
    () => `exam-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const [schoolCustomerId, setSchoolCustomerId] = useState(
    customers.find(c => c.customerType === 'school')?.id || customers[0]?.id || ''
  );
  const [assessmentName, setAssessmentName] = useState('Term 2 End-of-Term Examinations');
  const [paperSize, setPaperSize] = useState<ExamPaper['paperSize']>('A4');
  const [printSide, setPrintSide] = useState<ExamPaper['printSide']>('Duplex');
  const [printingItemId, setPrintingItemId] = useState(printServiceItems[0]?.id || 'item-srv-3');
  const [rawPaperItemId, setRawPaperItemId] = useState(defaultPaperId);
  const [rawTonerItemId, setRawTonerItemId] = useState(defaultTonerId);
  const [productionDate, setProductionDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [batchRows, setBatchRows] = useState<DraftBatchRow[]>([
    {
      className: 'Form 1',
      learnersCount: 180,
      pricePerLearner: 12.0,
      subjectName: 'Mathematics',
      pages: 8,
      copies: 180,
      bindingType: 'Stapled',
    },
    {
      className: 'Form 1',
      learnersCount: 180,
      pricePerLearner: 12.0,
      subjectName: 'English Language',
      pages: 12,
      copies: 180,
      bindingType: 'Saddle-Stitched',
    },
  ]);

  // Production timeline, cancellation, reprint and reconciliation modals
  const [timelinePaper, setTimelinePaper] = useState<ExamPaper | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<any[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ExamPaper | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [reprintTarget, setReprintTarget] = useState<ExamPaper | null>(null);
  const [reprintReason, setReprintReason] = useState('');
  const [reprintCopies, setReprintCopies] = useState(0);
  const [examActionBusy, setExamActionBusy] = useState(false);
  const [reconciliation, setReconciliation] = useState<any>(null);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);

  // Consolidated Invoice Confirmation Modal
  const [isInvoiceReviewOpen, setIsInvoiceReviewOpen] = useState(false);
  const [invoiceIncludeTax, setInvoiceIncludeTax] = useState(false);
  // One-click batch production & invoicing: the group is resolved from the
  // *selected examination batch's* persisted exam_batch_group_id (server
  // authority), never from the school or a global "most recent" id.
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [examBatches, setExamBatches] = useState<any[]>([]);
  const { group: resolvedGroup, status: groupStatus, error: groupError } = useExamGroupSelection(selectedBatchId);
  const [workflowGroupId, setWorkflowGroupId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSelectedBatchId(null);
    setExamBatches([]);
    const sid =
      selectedSchoolFilter !== 'all' && /^\d+$/.test(selectedSchoolFilter)
        ? Number(selectedSchoolFilter)
        : null;
    if (sid == null) return;
    (async () => {
      try {
        const list = await printingApi.listExamBatches({ schoolCustomerId: sid });
        if (!cancelled) setExamBatches(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setExamBatches([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSchoolFilter]);
  const [selectedContractId, setSelectedContractId] = useState('');
  const [selectedAssessmentNumber, setSelectedAssessmentNumber] = useState<number | ''>('');
  const [invoiceNotes, setInvoiceNotes] = useState('');

  // Filtering logic
  const filteredPapers = useMemo(() => {
    return examPapers.filter(paper => {
      if (selectedSchoolFilter !== 'all' && paper.schoolCustomerId !== selectedSchoolFilter) {
        return false;
      }
      if (statusFilter !== 'all' && paper.status !== statusFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const schoolName =
          customers.find(c => c.id === paper.schoolCustomerId)?.companyName.toLowerCase() || '';
        return (
          paper.jobNumber.toLowerCase().includes(q) ||
          paper.className.toLowerCase().includes(q) ||
          paper.subjectName.toLowerCase().includes(q) ||
          paper.assessmentName.toLowerCase().includes(q) ||
          schoolName.includes(q)
        );
      }
      return true;
    });
  }, [examPapers, selectedSchoolFilter, statusFilter, searchQuery, customers]);

  // Class-level Summary Grouping (Pricing is PER LEARNER in each class, NOT per subject!)
  const classSummaries = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        schoolCustomerId: string;
        schoolName: string;
        assessmentName: string;
        className: string;
        learnersCount: number;
        pricePerLearner: number;
        classRevenue: number;
        totalPages: number;
        totalSheets: number;
        totalImpressions: number;
        totalPaperCost: number;
        totalTonerCost: number;
        totalMaterialCost: number;
        realProfit: number;
        papers: ExamPaper[];
        allInvoiced: boolean;
      }
    >();

    filteredPapers.forEach(p => {
      const key = `${p.schoolCustomerId}__${p.assessmentName}__${p.className}`;
      const existing = groups.get(key);
      if (!existing) {
        const schoolName =
          customers.find(c => c.id === p.schoolCustomerId)?.companyName || 'School';
        const classRev = p.learnersCount * p.pricePerLearner;
        groups.set(key, {
          key,
          schoolCustomerId: p.schoolCustomerId,
          schoolName,
          assessmentName: p.assessmentName,
          className: p.className,
          learnersCount: p.learnersCount,
          pricePerLearner: p.pricePerLearner,
          classRevenue: classRev,
          totalPages: p.pages,
          totalSheets: p.sheetsUsed,
          totalImpressions: p.impressionsUsed,
          totalPaperCost: p.paperCost,
          totalTonerCost: p.tonerCost,
          totalMaterialCost: p.materialCost,
          realProfit: classRev - p.materialCost,
          papers: [p],
          allInvoiced: p.status === 'invoiced',
        });
      } else {
        existing.totalPages += p.pages;
        existing.totalSheets += p.sheetsUsed;
        existing.totalImpressions += p.impressionsUsed;
        existing.totalPaperCost += p.paperCost;
        existing.totalTonerCost += p.tonerCost;
        existing.totalMaterialCost += p.materialCost;
        existing.realProfit = existing.classRevenue - existing.totalMaterialCost;
        existing.papers.push(p);
        if (p.status !== 'invoiced') existing.allInvoiced = false;
      }
    });

    return Array.from(groups.values());
  }, [filteredPapers, customers]);

  // Selection helpers
  const selectedPapers = useMemo(
    () => examPapers.filter(p => selectedPaperIds.includes(p.id) && p.status !== 'invoiced'),
    [examPapers, selectedPaperIds]
  );

  // Class-grouped consolidated billing breakdown for selected papers
  const selectedClassBillingGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        className: string;
        assessmentName: string;
        learnersCount: number;
        pricePerLearner: number;
        classAmount: number;
        materialCost: number;
        papers: ExamPaper[];
      }
    >();
    selectedPapers.forEach(p => {
      const k = `${p.className}__${p.assessmentName}`;
      const cur = map.get(k);
      if (!cur) {
        map.set(k, {
          className: p.className,
          assessmentName: p.assessmentName,
          learnersCount: p.learnersCount,
          pricePerLearner: p.pricePerLearner,
          classAmount: Math.round(p.learnersCount * p.pricePerLearner * 100) / 100,
          materialCost: p.materialCost,
          papers: [p],
        });
      } else {
        cur.materialCost = Math.round((cur.materialCost + p.materialCost) * 100) / 100;
        cur.papers.push(p);
      }
    });
    return Array.from(map.values());
  }, [selectedPapers]);

  const selectedSchoolIds = useMemo(
    () => Array.from(new Set(selectedPapers.map(p => p.schoolCustomerId))),
    [selectedPapers]
  );

  const hasMultipleSchoolsSelected = selectedSchoolIds.length > 1;
  const activeConsolidatedSchoolId = selectedSchoolIds.length === 1 ? selectedSchoolIds[0] : null;
  const activeConsolidatedSchool = activeConsolidatedSchoolId
    ? customers.find(c => c.id === activeConsolidatedSchoolId)
    : undefined;

  const schoolActiveContracts = useMemo(() => {
    if (!activeConsolidatedSchoolId) return [];
    return printingContracts.filter(
      c => c.schoolCustomerId === activeConsolidatedSchoolId && c.status === 'active'
    );
  }, [printingContracts, activeConsolidatedSchoolId]);

  const togglePaperSelection = (paper: ExamPaper) => {
    if (paper.status !== 'delivered') return;
    setSelectedPaperIds(prev =>
      prev.includes(paper.id) ? prev.filter(id => id !== paper.id) : [...prev, paper.id]
    );
  };

  const handleSelectReadyForSchool = (schoolId: string) => {
    const deliveredIds = examPapers
      .filter(p => p.schoolCustomerId === schoolId && p.status === 'delivered')
      .map(p => p.id);
    setSelectedPaperIds(deliveredIds);
    if (deliveredIds.length === 0) {
      triggerShortcutNotice(
        'No delivered, uninvoiced examination papers are ready for this school.',
        'warning'
      );
    }
  };

  const handleAddBatchRow = () => {
    const last = batchRows[batchRows.length - 1];
    setBatchRows(prev => [
      ...prev,
      {
        className: last?.className || 'Form 2',
        learnersCount: last?.learnersCount || 160,
        pricePerLearner: last?.pricePerLearner || 12.0,
        subjectName: '',
        pages: 10,
        copies: last?.learnersCount || 160,
        bindingType: 'Stapled',
      },
    ]);
  };

  const handleUpdateBatchRow = (
    index: number,
    field: keyof DraftBatchRow,
    value: string | number
  ) => {
    setBatchRows(prev => {
      const next = prev.map((row, idx) => {
        if (idx !== index) return row;
        const updated = { ...row, [field]: value };
        if (field === 'learnersCount' && typeof value === 'number') {
          updated.copies = value;
        }
        return updated;
      });

      // Keep same className rows synced cleanly on learnersCount & pricePerLearner
      const edited = next[index];
      if (field === 'learnersCount' || field === 'pricePerLearner') {
        return next.map((r, idx) =>
          idx !== index && r.className.trim().toLowerCase() === edited.className.trim().toLowerCase()
            ? {
                ...r,
                learnersCount: edited.learnersCount,
                pricePerLearner: edited.pricePerLearner,
                copies: field === 'learnersCount' ? edited.learnersCount : r.copies,
              }
            : r
        );
      }
      return next;
    });
  };

  const paperUnitCost = rawPaperItemId ? getRawUsageUnitCost(rawPaperItemId) : 0;
  const tonerUnitCost = rawTonerItemId ? getRawUsageUnitCost(rawTonerItemId) : 0;
  const selectedPaperMat = rawMaterials.find(r => r.id === rawPaperItemId);
  const selectedTonerMat = rawMaterials.find(r => r.id === rawTonerItemId);

  // Live batch preview cost & class-grouped revenue through the shared engine
  const batchPreview = useMemo(() => {
    if (!selectedPaperMat || !selectedTonerMat || batchRows.length === 0) {
      const classRevMap = new Map<string, number>();
      batchRows.forEach(r => {
        const clsKey = r.className.trim().toLowerCase();
        if (clsKey && !classRevMap.has(clsKey)) {
          classRevMap.set(clsKey, r.learnersCount * r.pricePerLearner);
        }
      });
      const revenue = Array.from(classRevMap.values()).reduce((s, v) => s + v, 0);
      return {
        totalSheets: 0,
        totalImp: 0,
        pCost: 0,
        tCost: 0,
        matCost: 0,
        revenue,
        profit: revenue,
      };
    }

    const paperStock = buildPaperStockFromInventoryItem(selectedPaperMat);
    const tonerK = buildTonerSpecFromInventoryItem(selectedTonerMat, 'K');
    const wf = calculateExaminationProductionWorkflow(
      batchRows.map((r, idx) => ({
        subjectName: r.subjectName || `Subject ${idx + 1}`,
        className: r.className || `Class ${idx + 1}`,
        assessmentName,
        learnersCount: Math.max(1, r.learnersCount),
        pricePerLearner: Math.max(0, r.pricePerLearner),
        pages: Math.max(1, r.pages),
        copies: Math.max(1, r.copies),
        mode: printSide === 'Duplex' ? 'duplex' : 'simplex',
        paperStock,
        tonerChannels: { K: tonerK },
        machine: EXAM_PRESS_CAPABILITY,
        colorMode: 'mono',
        allowInsufficientStockPreview: true,
      }))
    );

    return {
      totalSheets: wf.totals.totalSheets,
      totalImp: wf.totals.totalImpressions,
      pCost: wf.totals.totalPaperCost,
      tCost: wf.totals.totalTonerCost,
      matCost: wf.totals.totalMaterialCost,
      revenue: wf.totals.totalClassRevenue,
      profit: wf.totals.totalProfit,
    };
  }, [batchRows, printSide, selectedPaperMat, selectedTonerMat, assessmentName]);

  const handleSubmitExamBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    const validRows = batchRows.filter(r => r.className.trim() && r.subjectName.trim());
    if (!schoolCustomerId || validRows.length === 0) return;

    try {
      const created = await addExamPapersBatch(
        validRows.map(row => ({
          schoolCustomerId,
          assessmentName,
          className: row.className.trim(),
          learnersCount: Math.max(1, row.learnersCount),
          pricePerLearner: Math.max(0, row.pricePerLearner),
          subjectName: row.subjectName.trim(),
          pages: Math.max(1, row.pages),
          copies: Math.max(1, row.copies),
          paperSize,
          printSide,
          bindingType: row.bindingType,
          printingItemId,
          rawPaperItemId: rawPaperItemId || undefined,
          rawTonerItemId: rawTonerItemId || undefined,
          ratePerPage: 0,
          status: 'queued',
          productionDate,
          notes,
        })),
        { submissionId: batchSubmissionId }
      );
      triggerShortcutNotice(
        `Server confirmed ${created.length} examination print job(s) in the production queue.`
      );
      setIsAddModalOpen(false);
    } catch (err: any) {
      triggerShortcutNotice(
        err?.message || 'The server rejected the examination batch. Nothing was created.',
        'error'
      );
    }
  };

  const openExamTimeline = async (paper: ExamPaper) => {
    setTimelinePaper(paper);
    setTimelineEvents([]);
    setTimelineLoading(true);
    try {
      setTimelineEvents(await getExamPaperEvents(paper.id));
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Could not load the production timeline.', 'error');
    } finally {
      setTimelineLoading(false);
    }
  };

  const openExamReconciliation = async () => {
    setReconciliationOpen(true);
    setReconciliation(null);
    try {
      setReconciliation(await getExamReconciliation());
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Could not load the reconciliation report.', 'error');
    }
  };

  const handleCancelExamPaper = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelTarget || !cancelReason.trim()) return;
    setExamActionBusy(true);
    try {
      await cancelExamPaper(cancelTarget.id, { reason: cancelReason.trim() });
      triggerShortcutNotice(`Cancelled ${cancelTarget.jobNumber} and released its commitments.`);
      setCancelTarget(null);
      setCancelReason('');
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'The server rejected the cancellation.', 'error');
    } finally {
      setExamActionBusy(false);
    }
  };

  const handleReprintExamPaper = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reprintTarget || !reprintReason.trim()) return;
    setExamActionBusy(true);
    try {
      const created = await reprintExamPaper(reprintTarget.id, {
        reason: reprintReason.trim(),
        copies: reprintCopies > 0 ? reprintCopies : undefined,
      });
      triggerShortcutNotice(
        `Created controlled reprint ${created?.jobNumber || ''} for ${reprintTarget.jobNumber}.`
      );
      setReprintTarget(null);
      setReprintReason('');
      setReprintCopies(0);
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'The server rejected the reprint.', 'error');
    } finally {
      setExamActionBusy(false);
    }
  };

  const handleOpenConsolidatedReview = (paperIdsOverride?: string[]) => {
    if (paperIdsOverride) {
      setSelectedPaperIds(paperIdsOverride);
    }
    setSelectedContractId('');
    setSelectedAssessmentNumber('');
    setInvoiceNotes('');
    setIsInvoiceReviewOpen(true);
  };

  const openLinkedInvoicePreview = async (ref?: {
    invoiceId?: string;
    backendInvoiceId?: number;
  }) => {
    if (ref?.backendInvoiceId) {
      try {
        const raw = await documentsApi.getDocumentPreview('invoice', ref.backendInvoiceId);
        openDocumentPreview(mapApiPreviewToModel(raw, currency));
        return;
      } catch {
        // fallback to local invoice
      }
    }
    if (ref?.invoiceId) {
      const localInv = getInvoiceById(ref.invoiceId);
      if (localInv) {
        const customer = customers.find(c => c.id === localInv.customerId);
        openDocumentPreview(
          mapLocalInvoiceToPreviewModel({
            invoice: localInv,
            customer,
            companyProfile,
            companyNameOverride: activeCompany?.name,
          })
        );
        return;
      }
    }
    setCurrentView('invoices');
  };

  const openExamSheetPreview = (papers: ExamPaper[]) => {
    if (papers.length === 0) return;
    const school = customers.find(c => c.id === papers[0].schoolCustomerId);
    openDocumentPreview(
      mapExamBatchToPreviewModel({
        papers,
        customer: school,
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
  };

  const handleConfirmConsolidatedInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedPapers.length === 0 || hasMultipleSchoolsSelected) return;

    let created: Awaited<ReturnType<typeof createConsolidatedSchoolInvoice>> = null;
    try {
      created = await createConsolidatedSchoolInvoice(
        selectedPapers.map(p => p.id),
        {
          includeTax: invoiceIncludeTax,
          notes: invoiceNotes || undefined,
          contractId: selectedContractId || undefined,
          assessmentNumber:
            selectedContractId && selectedAssessmentNumber !== ''
              ? Number(selectedAssessmentNumber)
              : undefined,
        }
      );
    } catch (err: any) {
      triggerShortcutNotice(
        err?.message || 'Invoice generation failed. No invoice was posted.',
        'error'
      );
      return;
    }

    if (created) {
      setSelectedPaperIds([]);
      setIsInvoiceReviewOpen(false);
      triggerShortcutNotice(
        `Created consolidated invoice ${created.invoiceNumber} (${selectedClassBillingGroups.length} class lines, Profit: ${formatCurrency(created.grossProfit || 0, currency)})`
      );
      if (created.backendInvoiceId) {
        try {
          const raw = await documentsApi.getDocumentPreview('invoice', created.backendInvoiceId);
          openDocumentPreview(mapApiPreviewToModel(raw, currency));
          return;
        } catch {
          // fallback to local preview
        }
      }
      const customer = customers.find(c => c.id === created.customerId);
      openDocumentPreview(
        mapLocalInvoiceToPreviewModel({
          invoice: created,
          customer,
          companyProfile,
          companyNameOverride: activeCompany?.name,
        })
      );
    }
  };

  // KPIs (Class-deduplicated revenue so multi-subject classes aren't double-counted)
  const queuedOrPrintingCount = examPapers.filter(
    p => p.status === 'queued' || p.status === 'printing'
  ).length;
  const readyToInvoiceCount = examPapers.filter(p => p.status === 'delivered').length;
  const readyClassRevenue = useMemo(() => {
    const m = new Map<string, number>();
    examPapers
      .filter(p => p.status === 'delivered')
      .forEach(p => {
        const k = `${p.schoolCustomerId}__${p.assessmentName}__${p.className}`;
        if (!m.has(k)) m.set(k, p.learnersCount * p.pricePerLearner);
      });
    return Array.from(m.values()).reduce((s, v) => s + v, 0);
  }, [examPapers]);

  const totalExamProfit = useMemo(() => {
    const revMap = new Map<string, number>();
    let matSum = 0;
    examPapers.forEach(p => {
      const k = `${p.schoolCustomerId}__${p.assessmentName}__${p.className}`;
      if (!revMap.has(k)) revMap.set(k, p.learnersCount * p.pricePerLearner);
      matSum += p.materialCost || 0;
    });
    const revSum = Array.from(revMap.values()).reduce((s, v) => s + v, 0);
    return { revSum, matSum, profit: revSum - matSum };
  }, [examPapers]);

  const consolidatedSubtotal = selectedClassBillingGroups.reduce((s, g) => s + g.classAmount, 0);
  const consolidatedMaterialCost = selectedClassBillingGroups.reduce((s, g) => s + g.materialCost, 0);
  const consolidatedProfit = Math.round((consolidatedSubtotal - consolidatedMaterialCost) * 100) / 100;
  const consolidatedTax = invoiceIncludeTax
    ? Math.round(consolidatedSubtotal * companyProfile.salesTaxRate * 100) / 100
    : 0;
  const consolidatedTotal = Math.round((consolidatedSubtotal + consolidatedTax) * 100) / 100;

  const buildExamActionContext = (record: any, pendingId?: string | null): ActionEligibilityContext<any> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'examination',
    entityType: 'exam_paper',
    record,
    recordStatus: record?.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const renderClassActions = (cls: any) => {
    const uninvoicedIds = cls.papers.filter((p: any) => p.status !== 'invoiced').map((p: any) => p.id);
    const defs: AdvancedActionDefinition<any>[] = [
      {
        id: 'exam.preview-class-sheet',
        label: 'Preview Production Sheet',
        icon: <Eye className="w-3.5 h-3.5 text-slate-700" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'exams:view',
        execute: async () => openExamSheetPreview(cls.papers),
      },
    ];
    if (uninvoicedIds.length > 0) {
      defs.push({
        id: 'exam.select-class-papers',
        label: `Select ${uninvoicedIds.length} Class Papers`,
        icon: <Layers className="w-3.5 h-3.5 text-blue-600" />,
        group: 'process',
        groupLabel: 'Actions',
        requiredPermission: 'exams:view',
        execute: async () => setSelectedPaperIds(uninvoicedIds),
      });
      defs.push({
        id: 'exam.invoice-class-now',
        label: 'Invoice This Class Now',
        icon: <FileText className="w-3.5 h-3.5 text-emerald-600" />,
        group: 'process',
        groupLabel: 'Actions',
        requiredPermission: 'exams:invoice',
        execute: async () => handleOpenConsolidatedReview(uninvoicedIds),
      });
    } else {
      defs.push({
        id: 'exam.preview-linked-invoice',
        label: 'Preview Linked Invoice',
        icon: <FileText className="w-3.5 h-3.5 text-blue-600" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'invoices:read',
        execute: async () => openLinkedInvoicePreview(cls.papers.find((p: any) => p.backendInvoiceId || p.invoiceId) || cls.papers[0]),
      });
    }
    const ctx = buildExamActionContext(cls, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for ${cls.className}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={cls.key}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => {
          const def = action.definition;
          if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) });
        }}
      />
    );
  };

  const renderPaperActions = (paper: any) => {
    const defs: AdvancedActionDefinition<any>[] = [
      {
        id: 'exam.preview-paper-sheet',
        label: 'Preview Production Sheet',
        icon: <Eye className="w-3.5 h-3.5 text-slate-700" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'exams:view',
        execute: async () => openExamSheetPreview([paper]),
      },
      {
        id: 'exam.timeline',
        label: 'Production Timeline & Audit',
        icon: <History className="w-3.5 h-3.5 text-slate-700" />,
        group: 'view',
        groupLabel: 'Audit',
        requiredPermission: 'exams:view',
        execute: async () => openExamTimeline(paper),
      },
    ];
    if (paper.status === 'queued') {
      defs.push({ id: 'exam.edit-paper', label: 'Edit Paper Details (before production)', icon: <FileText className="w-3.5 h-3.5 text-slate-600" />, group: 'admin', groupLabel: 'Other', requiredPermission: 'exams:edit', execute: async () => {
        const subjectRaw = await appDialog.prompt({
          title: `Edit ${paper.jobNumber}`,
          message: 'Update the examination subject name before production starts.',
          label: 'Subject name',
          defaultValue: paper.subjectName,
          required: true,
        });
        if (subjectRaw == null) return;
        const copiesRaw = await appDialog.prompt({
          title: `Edit ${paper.jobNumber} Copies`,
          message: `Learner copies for ${paper.jobNumber} (teacher copies stay fixed at ${paper.teacherCopies ?? 2}).`,
          label: 'Learner copies',
          defaultValue: String(paper.copies),
          inputType: 'number',
          required: true,
        });
        if (copiesRaw == null) return;
        const copies = Number(copiesRaw);
        if (!Number.isInteger(copies) || copies <= 0) { triggerShortcutNotice('Copies must be a positive integer.', 'error'); return; }
        const pagesRaw = await appDialog.prompt({
          title: `Edit ${paper.jobNumber} Pages`,
          message: `Update the total page count for ${paper.jobNumber}.`,
          label: 'Page count',
          defaultValue: String(paper.pages),
          inputType: 'number',
          required: true,
        });
        if (pagesRaw == null) return;
        const pages = Number(pagesRaw);
        if (!Number.isInteger(pages) || pages <= 0) { triggerShortcutNotice('Pages must be a positive integer.', 'error'); return; }
        try {
          await editExamPaper(paper.id, { subjectName: subjectRaw.trim(), copies, pages, reason: 'Edited before production' });
          triggerShortcutNotice(`Updated ${paper.jobNumber}.`);
        } catch (err: any) {
          triggerShortcutNotice(err?.message || 'The server rejected the edit.', 'error');
        }
      } });
      defs.push({ id: 'exam.start-printing', label: 'Start Press Printing (Reserve & Issue Materials)', icon: <Printer className="w-3.5 h-3.5 text-amber-600" />, group: 'process', groupLabel: 'Production', requiredPermission: 'exams:produce', execute: async () => { try { await updateExamPaperStatus(paper.id, 'printing'); } catch (err: any) { triggerShortcutNotice(err?.message || 'The server rejected the production start.', 'error'); } } });
    }
    if (paper.status === 'printing') {
      defs.push({ id: 'exam.complete-print', label: 'Pass QC & Complete Production', icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Quality Control', requiredPermission: 'exams:qc', execute: async () => { try { await updateExamPaperStatus(paper.id, 'completed'); triggerShortcutNotice(`Completed ${paper.jobNumber} and recorded QC approval`); } catch (err: any) { triggerShortcutNotice(err?.message || 'The server rejected the QC pass.', 'error'); } } });
      defs.push({ id: 'exam.qc-hold', label: 'Place on QC Hold', icon: <AlertCircle className="w-3.5 h-3.5 text-rose-600" />, group: 'process', groupLabel: 'Quality Control', requiredPermission: 'exams:qc', execute: async () => {
        const reason = await appDialog.prompt({
          title: `QC Hold — ${paper.jobNumber}`,
          message: `Specify the quality-control reason for holding ${paper.jobNumber}.`,
          label: 'QC hold reason',
          required: true,
          destructive: true,
          multiline: true,
        });
        if (!reason?.trim()) return;
        try { await updateExamPaperStatus(paper.id, 'qc_hold', { reason: reason.trim() }); triggerShortcutNotice(`${paper.jobNumber} placed on QC hold.`); } catch (err: any) { triggerShortcutNotice(err?.message || 'The server rejected the QC hold.', 'error'); }
      } });
    }
    if (paper.status === 'qc_hold') {
      defs.push({ id: 'exam.qc-rework', label: 'Authorise Rework (back to press)', icon: <RotateCcw className="w-3.5 h-3.5 text-amber-600" />, group: 'process', groupLabel: 'Quality Control', requiredPermission: 'exams:produce', execute: async () => {
        const reason = await appDialog.prompt({
          title: `Authorise Rework — ${paper.jobNumber}`,
          message: `Enter the rework authorisation reason for returning ${paper.jobNumber} to press.`,
          label: 'Rework reason',
          required: true,
          tone: 'amber',
          multiline: true,
        });
        if (!reason?.trim()) return;
        try { await updateExamPaperStatus(paper.id, 'printing', { reason: reason.trim() }); triggerShortcutNotice(`${paper.jobNumber} authorised for rework.`); } catch (err: any) { triggerShortcutNotice(err?.message || 'The server rejected the rework.', 'error'); }
      } });
    }
    if (paper.status === 'completed' || paper.status === 'qc_passed') {
      defs.push({ id: 'exam.pack', label: 'Record Packing', icon: <Package className="w-3.5 h-3.5 text-indigo-600" />, group: 'process', groupLabel: 'Dispatch', requiredPermission: 'exams:dispatch', execute: async () => {
        const countRaw = await appDialog.prompt({
          title: `Record Packing — ${paper.jobNumber}`,
          message: `Enter the number of sealed packages for ${paper.jobNumber}.`,
          label: 'Package count',
          defaultValue: '1',
          inputType: 'number',
          required: true,
        });
        if (countRaw == null) return;
        const count = Number(countRaw);
        if (!Number.isInteger(count) || count < 0) { triggerShortcutNotice('Package count must be a non-negative integer.', 'error'); return; }
        const seal = await appDialog.prompt({
          title: `Seal Reference — ${paper.jobNumber}`,
          message: 'Enter an optional tamper-evident seal reference.',
          label: 'Seal reference (optional)',
          defaultValue: '',
        });
        if (seal === null) return;
        try { await updateExamPaperStatus(paper.id, 'packed', { packageCount: count, sealReference: seal || null }); triggerShortcutNotice(`Packed ${paper.jobNumber}.`); } catch (err: any) { triggerShortcutNotice(err?.message || 'The server rejected the packing record.', 'error'); }
      } });
    }
    if (paper.status === 'completed' || paper.status === 'qc_passed' || paper.status === 'packed') {
      defs.push({ id: 'exam.dispatch', label: 'Record Dispatch', icon: <Truck className="w-3.5 h-3.5 text-indigo-600" />, group: 'process', groupLabel: 'Dispatch', requiredPermission: 'exams:dispatch', execute: async () => { try { await updateExamPaperStatus(paper.id, 'dispatched'); triggerShortcutNotice(`Dispatched ${paper.jobNumber}.`); } catch (err: any) { triggerShortcutNotice(err?.message || 'The server rejected the dispatch.', 'error'); } } });
    }
    if (['completed', 'qc_passed', 'packed', 'dispatched'].includes(paper.status)) {
      defs.push({ id: 'exam.deliver-paper', label: 'Record Delivery to School', icon: <Truck className="w-3.5 h-3.5 text-blue-600" />, group: 'process', groupLabel: 'Delivery', requiredPermission: 'exams:deliver', execute: async () => { try { await deliverExamPaper(paper.id); triggerShortcutNotice(`Recorded delivery for ${paper.jobNumber}`); } catch (err: any) { triggerShortcutNotice(err?.message || 'The server rejected the delivery.', 'error'); } } });
    }
    if (paper.status === 'delivered') {
      defs.push({ id: 'exam.select-school-ready', label: 'Select All Delivered for School', icon: <Layers className="w-3.5 h-3.5 text-blue-600" />, group: 'process', groupLabel: 'Actions', requiredPermission: 'exams:view', execute: async () => handleSelectReadyForSchool(paper.schoolCustomerId) });
      defs.push({ id: 'exam.invoice-now', label: 'Invoice This Paper Now', icon: <FileText className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Actions', requiredPermission: 'exams:invoice', execute: async () => handleOpenConsolidatedReview([paper.id]) });
    } else if (paper.status === 'invoiced') {
      defs.push({ id: 'exam.preview-linked-invoice', label: 'Preview Linked Invoice', icon: <FileText className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Document', requiredPermission: 'invoices:read', execute: async () => openLinkedInvoicePreview(paper) });
    }
    if (['printing', 'qc_hold', 'qc_passed', 'completed', 'packed', 'dispatched', 'delivered', 'invoiced'].includes(paper.status)) {
      defs.push({ id: 'exam.reprint', label: 'Raise Controlled Reprint', icon: <RotateCcw className="w-3.5 h-3.5 text-rose-600" />, group: 'process', groupLabel: 'Quality Control', requiredPermission: 'exams:produce', execute: async () => { setReprintTarget(paper); setReprintReason(''); setReprintCopies(Number(paper.copies) || 0); } });
    }
    if (!['dispatched', 'delivered', 'invoiced', 'cancelled'].includes(paper.status)) {
      defs.push({ id: 'exam.cancel-paper', label: 'Cancel Examination Paper', icon: <Ban className="w-3.5 h-3.5 text-rose-600" />, group: 'danger', groupLabel: 'Sensitive operations', destructive: true, risk: 'destructive', requiredPermission: 'exams:cancel', execute: async () => { setCancelTarget(paper); setCancelReason(''); } });
    }
    defs.push({ id: 'exam.copy-job', label: 'Copy Job Number', icon: <Copy className="w-3.5 h-3.5" />, group: 'admin', groupLabel: 'Other', requiredPermission: 'exams:view', execute: async () => { await navigator.clipboard?.writeText(paper.jobNumber); triggerShortcutNotice(`Copied ${paper.jobNumber}`); } });
    if (!['invoiced', 'cancelled', 'delivered'].includes(paper.status)) {
      defs.push({ id: 'exam.delete-job', label: 'Remove Uninvoiced Job', icon: <Trash2 className="w-3.5 h-3.5" />, group: 'danger', groupLabel: 'Sensitive operations', destructive: true, risk: 'destructive', requiredPermission: 'exams:cancel', confirmation: { title: `Remove ${paper.jobNumber}`, message: 'Remove this uninvoiced job?', confirmLabel: 'Remove', destructive: true }, execute: async () => deleteExamPaper(paper.id) });
    }
    const ctx = buildExamActionContext(paper, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for ${paper.jobNumber}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={paper.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => {
          const def = action.definition;
          if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) });
        }}
      />
    );
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            Examination Printing & Per-Learner Class Billing
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Schools are billed per learner in each class (not per subject), while every subject paper calculates real paper & toner cost from Raw Materials.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {selectedPapers.length > 0 && (
            <button
              onClick={() => handleOpenConsolidatedReview()}
              disabled={hasMultipleSchoolsSelected}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs shadow-xs transition-all active:scale-95"
            >
              <FileText className="w-4 h-4" />
              <span>
                Invoice Selected ({selectedClassBillingGroups.length} Classes / {selectedPapers.length} Papers · {formatCurrency(consolidatedSubtotal, currency)})
              </span>
            </button>
          )}
          <button
            onClick={openExamReconciliation}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 font-bold text-xs shadow-xs transition-all active:scale-95"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Reconciliation</span>
          </button>
          <select
            value={selectedBatchId ?? ''}
            onChange={e => setSelectedBatchId(e.target.value ? Number(e.target.value) : null)}
            className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 font-bold text-xs max-w-[220px]"
            aria-label="Select examination batch"
          >
            <option value="">Select examination batch…</option>
            {examBatches.map(b => (
              <option key={b.backendId} value={b.backendId}>
                {b.className} · {b.assessmentName}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              if (resolvedGroup) setWorkflowGroupId(resolvedGroup.examBatchGroupId);
            }}
            disabled={!resolvedGroup}
            title={
              groupError
                ? groupError
                : groupStatus === 'empty'
                ? selectedBatchId == null
                  ? 'Select an examination batch first.'
                  : 'The selected examination batch has not been prepared into a production group.'
                : undefined
            }
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs shadow-xs transition-all active:scale-95"
          >
            <Printer className="w-4 h-4" />
            <span>Generate Production &amp; Invoice</span>
          </button>
          <button
            onClick={() => {
              setBatchSubmissionId(`exam-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`);
              setIsAddModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-xs transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" />
            <span>Schedule Class / Subject Exams</span>
          </button>
        </div>
      </div>

      {groupError && (
        <div className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-[11px] text-rose-800 dark:text-rose-200">
          {groupError}
        </div>
      )}
      {groupStatus === 'empty' && selectedBatchId != null && !groupError && (
        <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-[11px] text-slate-500">
          The selected examination batch has not been prepared into a production group. Schedule it to enable one-click production &amp; invoicing.
        </div>
      )}

      {/* Warning if multiple schools selected */}
      {hasMultipleSchoolsSelected && (
        <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 flex items-center justify-between text-xs text-amber-800 dark:text-amber-300">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>
              Multiple schools selected. A consolidated examination invoice can only combine classes & subjects from one school at a time.
            </span>
          </div>
          <button
            onClick={() => setSelectedPaperIds([])}
            className="font-bold underline ml-4 whitespace-nowrap"
          >
            Clear Selection
          </button>
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Active Press Queue
            </div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {queuedOrPrintingCount} Papers
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {readyToInvoiceCount} completed & ready
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
            <Printer className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Ready Class Billing
            </div>
            <div className="text-xl font-bold font-mono text-blue-600 dark:text-blue-400 mt-1 tabular-nums">
              {formatCurrency(readyClassRevenue, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Per-learner class value ready
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Paper & Toner Cost
            </div>
            <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400 mt-1 tabular-nums">
              {formatCurrency(totalExamProfit.matSum, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Raw material cost across {examPapers.length} papers
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <BookOpen className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Real Exam Profit
            </div>
            <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1 tabular-nums">
              {formatCurrency(totalExamProfit.profit, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono">
              {totalExamProfit.revSum > 0
                ? ((totalExamProfit.profit / totalExamProfit.revSum) * 100).toFixed(1)
                : '0.0'}
              % gross margin
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <TrendingUp className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Filter Bar + Quick School Batch Selector */}
      <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedSchoolFilter}
            onChange={e => setSelectedSchoolFilter(e.target.value)}
            className="bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100 outline-none"
          >
            <option value="all">All Schools ({customers.length})</option>
            {customers.map(c => (
              <option key={c.id} value={c.id}>
                {c.companyName}
              </option>
            ))}
          </select>

          {selectedSchoolFilter !== 'all' && (
            <button
              onClick={() => handleSelectReadyForSchool(selectedSchoolFilter)}
              className="px-2.5 py-1.5 rounded-lg border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 text-xs font-semibold hover:bg-blue-100 transition-colors"
            >
              Select Ready Papers for School
            </button>
          )}

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs">
            {[
              { id: 'all', label: 'All' },
              { id: 'queued', label: 'Queued' },
              { id: 'printing', label: 'Printing' },
              { id: 'qc_hold', label: 'QC Hold' },
              { id: 'completed', label: 'QC Passed' },
              { id: 'packed', label: 'Packed' },
              { id: 'dispatched', label: 'Dispatched' },
              { id: 'delivered', label: 'Delivered' },
              { id: 'invoiced', label: 'Invoiced' },
              { id: 'cancelled', label: 'Cancelled' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setStatusFilter(tab.id)}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  statusFilter === tab.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-bold shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 absolute left-3 top-2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search school, class, subject..."
            className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-850 text-xs text-slate-900 dark:text-slate-100 outline-none"
          />
        </div>
      </div>

      {/* Class-Level Per-Learner Billing & Profitability Summary */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="font-bold text-sm text-slate-900 dark:text-white">
              Class-Level Billing & Real Profitability (Per Learner × Class)
            </h2>
            <p className="text-[11px] text-slate-500">
              Subjects in the same class share one per-learner charge; paper & toner costs accumulate across every subject paper printed for that class.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2.5">SCHOOL / ASSESSMENT</th>
                <th className="px-4 py-2.5">CLASS</th>
                <th className="px-4 py-2.5">SUBJECTS INCLUDED</th>
                <th className="px-4 py-2.5 text-right">LEARNERS × RATE</th>
                <th className="px-4 py-2.5 text-right">CLASS BILLING</th>
                <th className="px-4 py-2.5 text-right">PAPER + TONER COST</th>
                <th className="px-4 py-2.5 text-right">CLASS PROFIT</th>
                <th className="px-4 py-2.5 text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {classSummaries.map(cls => {
                const margin = cls.classRevenue > 0 ? (cls.realProfit / cls.classRevenue) * 100 : 0;
                const uninvoicedIds = cls.papers
                  .filter(p => p.status !== 'invoiced')
                  .map(p => p.id);
                return (
                  <tr key={cls.key} className="hover:bg-slate-50 dark:hover:bg-slate-850/50">
                    <td className="px-4 py-2.5 font-sans">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {cls.schoolName}
                      </div>
                      <div className="text-[11px] text-slate-500">{cls.assessmentName}</div>
                    </td>
                    <td className="px-4 py-2.5 font-sans font-bold text-slate-800 dark:text-slate-200">
                      {cls.className}
                    </td>
                    <td className="px-4 py-2.5 font-sans text-[11px] text-slate-600 dark:text-slate-300">
                      <div>{cls.papers.map(p => `${p.subjectName} (${p.pages}pp)`).join(', ')}</div>
                      <div className="text-[10px] font-mono text-slate-400">
                        {cls.totalSheets.toLocaleString()} sheets · {cls.totalImpressions.toLocaleString()} imp
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {cls.learnersCount} × {formatCurrency(cls.pricePerLearner, currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold tabular-nums text-slate-900 dark:text-white">
                      {formatCurrency(cls.classRevenue, currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-amber-700 dark:text-amber-400">
                      <div>{formatCurrency(cls.totalMaterialCost, currency)}</div>
                      <div className="text-[10px] text-slate-400">
                        P:{formatCurrency(cls.totalPaperCost, currency)} · T:{formatCurrency(cls.totalTonerCost, currency)}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold tabular-nums">
                      <div
                        className={
                          cls.realProfit >= 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-rose-600 dark:text-rose-400'
                        }
                      >
                        {formatCurrency(cls.realProfit, currency)}
                      </div>
                      <div className="text-[10px] text-slate-400">{margin.toFixed(1)}%</div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-sans">
                      {renderClassActions(cls)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Subject-Level Examination Production Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="font-bold text-sm text-slate-900 dark:text-white">
            Subject Paper Press Production Queue
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-3 w-8 text-center">SEL</th>
                <th className="px-4 py-3">JOB #</th>
                <th className="px-4 py-3">SCHOOL / ASSESSMENT</th>
                <th className="px-4 py-3">CLASS (LEARNERS)</th>
                <th className="px-4 py-3">SUBJECT PAPER</th>
                <th className="px-4 py-3 text-right">PAGES × COPIES</th>
                <th className="px-4 py-3 text-right">SHEETS / IMP</th>
                <th className="px-4 py-3 text-right">PAPER + TONER COST</th>
                <th className="px-4 py-3 text-center">PRODUCTION STATUS</th>
                <th className="px-4 py-3 text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {filteredPapers.map(paper => {
                const school = customers.find(c => c.id === paper.schoolCustomerId);
                const isSelected = selectedPaperIds.includes(paper.id);
                const canSelect = paper.status === 'delivered';

                return (
                  <tr
                    key={paper.id}
                    className={`hover:bg-slate-50 dark:hover:bg-slate-850/50 ${
                      isSelected ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''
                    }`}
                  >
                    <td className="px-3 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={!canSelect}
                        onChange={() => togglePaperSelection(paper)}
                        className="rounded border-slate-300 text-blue-600 cursor-pointer disabled:opacity-30"
                        title={
                          canSelect
                            ? 'Select for consolidated school invoice'
                            : 'Delivered papers only can be invoiced'
                        }
                      />
                    </td>
                    <td className="px-4 py-3 font-bold text-slate-900 dark:text-white whitespace-nowrap">
                      {paper.jobNumber}
                    </td>
                    <td className="px-4 py-3 font-sans">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {school?.companyName || 'Unknown School'}
                      </div>
                      <div className="text-[11px] text-slate-500">{paper.assessmentName}</div>
                    </td>
                    <td className="px-4 py-3 font-sans whitespace-nowrap">
                      <div className="font-semibold text-slate-800 dark:text-slate-200">
                        {paper.className}
                      </div>
                      <div className="text-[10px] font-mono text-slate-500">
                        {paper.learnersCount} learners @ {formatCurrency(paper.pricePerLearner, currency)}/ea
                      </div>
                    </td>
                    <td className="px-4 py-3 font-sans">
                      <div className="font-medium text-slate-900 dark:text-white">
                        {paper.subjectName}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {paper.paperSize} · {paper.printSide} · {paper.bindingType}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {paper.pages} pp × {paper.copies}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                      <div>{paper.sheetsUsed.toLocaleString()} shts</div>
                      <div className="text-[10px] text-slate-400">
                        {paper.impressionsUsed.toLocaleString()} imp
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-amber-700 dark:text-amber-400">
                      <div className="font-bold">{formatCurrency(paper.materialCost, currency)}</div>
                      <div className="text-[10px] text-slate-400">
                        P:{formatCurrency(paper.paperCost, currency)} · T:{formatCurrency(paper.tonerCost, currency)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center font-sans text-[11px]">
                      {paper.status === 'queued' && (
                        <span className="font-semibold text-slate-600 dark:text-slate-300 inline-flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-400" /> Queued
                        </span>
                      )}
                      {paper.status === 'printing' && (
                        <span className="font-semibold text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
                          <Printer className="w-3 h-3" /> On Press
                        </span>
                      )}
                      {paper.status === 'qc_hold' && (
                        <span className="font-semibold text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" /> QC Hold
                        </span>
                      )}
                      {(paper.status === 'completed' || paper.status === 'qc_passed') && (
                        <span className="font-semibold text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> QC Passed
                        </span>
                      )}
                      {paper.status === 'packed' && (
                        <span className="font-semibold text-indigo-600 dark:text-indigo-400 inline-flex items-center gap-1">
                          <Package className="w-3 h-3" /> Packed
                        </span>
                      )}
                      {paper.status === 'dispatched' && (
                        <span className="font-semibold text-indigo-600 dark:text-indigo-400 inline-flex items-center gap-1">
                          <Truck className="w-3 h-3" /> Dispatched
                        </span>
                      )}
                      {paper.status === 'cancelled' && (
                        <span className="font-semibold text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
                          <Ban className="w-3 h-3" /> Cancelled
                        </span>
                      )}
                      {paper.status === 'delivered' && (
                        <span className="font-semibold text-blue-600 dark:text-blue-400 inline-flex items-center gap-1">
                          <Truck className="w-3 h-3" /> Delivered · Ready to Invoice
                        </span>
                      )}
                      {paper.status === 'invoiced' && (
                        <button
                          onClick={() => openLinkedInvoicePreview(paper)}
                          title="Preview Linked Invoice"
                          className="font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {paper.linkedInvoiceNumber ? `Invoiced (${paper.linkedInvoiceNumber})` : 'Invoiced'}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-sans">
                      {renderPaperActions(paper)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Multi-Class / Multi-Subject Examination Batch Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-5xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-amber-400" />
                <h2 className="font-bold text-base">
                  Schedule School Examination Papers (Per-Learner Class Pricing)
                </h2>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="p-1 text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitExamBatch} className="p-5 space-y-4 text-xs overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-3.5 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">School Customer</label>
                  <select
                    value={schoolCustomerId}
                    onChange={e => setSchoolCustomerId(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                    required
                  >
                    {customers.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.companyName}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Assessment / Exam Term</label>
                  <input
                    type="text"
                    value={assessmentName}
                    onChange={e => setAssessmentName(e.target.value)}
                    placeholder="e.g. Term 2 End-of-Term Exams"
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Production Date</label>
                  <input
                    type="date"
                    value={productionDate}
                    onChange={e => setProductionDate(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Paper Size & Side</label>
                  <div className="flex gap-2">
                    <select
                      value={paperSize}
                      onChange={e => setPaperSize(e.target.value as any)}
                      className="w-1/2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                    >
                      <option value="A4">A4</option>
                      <option value="A3">A3</option>
                      <option value="B5">B5</option>
                      <option value="Letter">Letter</option>
                    </select>
                    <select
                      value={printSide}
                      onChange={e => setPrintSide(e.target.value as any)}
                      className="w-1/2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                    >
                      <option value="Duplex">Duplex (2pp/sheet)</option>
                      <option value="Single-Sided">Single-Sided</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">
                    Raw Paper Stock ({currencySymbol}{paperUnitCost.toFixed(4)}/Sheet)
                  </label>
                  <select
                    value={rawPaperItemId}
                    onChange={e => setRawPaperItemId(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                  >
                    <option value="">-- None --</option>
                    {rawMaterials.map(rm => (
                      <option key={rm.id} value={rm.id}>
                        {rm.sku} · {rm.name} ({rm.onHand} {rm.purchaseUnit || 'Units'})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">
                    Raw Toner Stock ({currencySymbol}{tonerUnitCost.toFixed(4)}/Imp)
                  </label>
                  <select
                    value={rawTonerItemId}
                    onChange={e => setRawTonerItemId(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-2 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                  >
                    <option value="">-- None --</option>
                    {rawMaterials.map(rm => (
                      <option key={rm.id} value={rm.id}>
                        {rm.sku} · {rm.name} ({rm.onHand} {rm.purchaseUnit || 'Units'})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="text-[11px] text-blue-700 dark:text-blue-300 bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-lg px-3 py-2">
                Pricing is billed <strong>per learner in each class</strong> (Learners × Price/Learner), regardless of how many subjects are added for that class. Paper & toner cost is computed automatically per subject paper.
              </div>

              {/* Dynamic Class + Subject rows */}
              <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                <div className="bg-slate-100 dark:bg-slate-800 px-3 py-2 text-[10px] font-bold uppercase text-slate-600 dark:text-slate-300 grid grid-cols-12 gap-2">
                  <div className="col-span-2">CLASS / GRADE</div>
                  <div className="col-span-1 text-right">LEARNERS</div>
                  <div className="col-span-2 text-right">PRICE/LEARNER ({currencySymbol})</div>
                  <div className="col-span-3">SUBJECT / PAPER</div>
                  <div className="col-span-1 text-right">PAGES</div>
                  <div className="col-span-1 text-right">COPIES</div>
                  <div className="col-span-2 text-right">PAPER+TONER COST</div>
                </div>

                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                  {batchRows.map((row, idx) => {
                    const shts = (printSide === 'Duplex' ? Math.ceil(row.pages / 2) : row.pages) * row.copies;
                    const imps = row.pages * row.copies;
                    const rowMatCost = shts * paperUnitCost + imps * tonerUnitCost;
                    return (
                      <div key={idx} className="p-2.5 grid grid-cols-12 gap-2 items-center">
                        <div className="col-span-2">
                          <input
                            type="text"
                            value={row.className}
                            onChange={e => handleUpdateBatchRow(idx, 'className', e.target.value)}
                            placeholder="e.g. Form 2"
                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs outline-none"
                            required
                          />
                        </div>
                        <div className="col-span-1">
                          <input
                            type="number"
                            min="1"
                            value={row.learnersCount}
                            onChange={e =>
                              handleUpdateBatchRow(idx, 'learnersCount', parseInt(e.target.value) || 1)
                            }
                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-xs text-right font-mono outline-none"
                            required
                          />
                        </div>
                        <div className="col-span-2">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={row.pricePerLearner}
                            onChange={e =>
                              handleUpdateBatchRow(
                                idx,
                                'pricePerLearner',
                                parseFloat(e.target.value) || 0
                              )
                            }
                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-right font-mono font-bold outline-none"
                            required
                          />
                        </div>
                        <div className="col-span-3">
                          <input
                            type="text"
                            value={row.subjectName}
                            onChange={e => handleUpdateBatchRow(idx, 'subjectName', e.target.value)}
                            placeholder="e.g. Biology Paper I"
                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs outline-none"
                            required
                          />
                        </div>
                        <div className="col-span-1">
                          <input
                            type="number"
                            min="1"
                            value={row.pages}
                            onChange={e =>
                              handleUpdateBatchRow(idx, 'pages', parseInt(e.target.value) || 1)
                            }
                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-xs text-right font-mono outline-none"
                            required
                          />
                        </div>
                        <div className="col-span-1">
                          <input
                            type="number"
                            min="1"
                            value={row.copies}
                            onChange={e =>
                              handleUpdateBatchRow(idx, 'copies', parseInt(e.target.value) || 1)
                            }
                            className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-xs text-right font-mono outline-none"
                            required
                          />
                        </div>
                        <div className="col-span-2 flex items-center justify-end gap-1 font-mono font-semibold text-amber-700 dark:text-amber-400">
                          <span>{formatCurrency(rowMatCost, currency)}</span>
                          {batchRows.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                setBatchRows(prev => prev.filter((_, i) => i !== idx))
                              }
                              className="text-slate-400 hover:text-rose-500 ml-1"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="p-3 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
                  <button
                    type="button"
                    onClick={handleAddBatchRow}
                    className="flex items-center gap-1.5 font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Class / Subject Paper</span>
                  </button>
                  <div className="flex flex-wrap items-center gap-4 font-mono text-xs">
                    <span className="text-slate-600 dark:text-slate-400">
                      Paper+Toner Cost:{' '}
                      <strong className="text-amber-700 dark:text-amber-400">
                        {formatCurrency(batchPreview.matCost, currency)}
                      </strong>
                    </span>
                    <span className="text-slate-600 dark:text-slate-400">
                      Class Billing:{' '}
                      <strong className="text-slate-900 dark:text-white">
                        {formatCurrency(batchPreview.revenue, currency)}
                      </strong>
                    </span>
                    <span className="text-emerald-700 dark:text-emerald-400 font-bold">
                      Real Batch Profit: {formatCurrency(batchPreview.profit, currency)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Billing Service Item</label>
                  <select
                    value={printingItemId}
                    onChange={e => setPrintingItemId(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                  >
                    {printServiceItems.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Production Instructions</label>
                  <input
                    type="text"
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder="Optional sealing, packaging, or answer-sheet instructions"
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-sm"
                >
                  Queue {batchRows.length} Exam Paper Job(s)
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Consolidated School Invoice Modal (Per-Learner Class Lines + Real Profit) */}
      {isInvoiceReviewOpen && activeConsolidatedSchool && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-amber-400" />
                <h2 className="font-bold text-base">
                  Consolidated School Exam Invoice (Per-Learner Class Billing)
                </h2>
              </div>
              <button
                onClick={() => setIsInvoiceReviewOpen(false)}
                className="p-1 text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleConfirmConsolidatedInvoice} className="p-5 space-y-4 text-xs overflow-y-auto">
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div>
                  <div className="text-[11px] text-slate-500 uppercase font-bold">School Customer</div>
                  <div className="text-sm font-bold text-slate-900 dark:text-white">
                    {activeConsolidatedSchool.companyName}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {selectedClassBillingGroups.length} class billing line(s) covering{' '}
                    {selectedPapers.length} subject examination paper(s)
                  </div>
                </div>
                <div className="text-right font-mono">
                  <div className="text-[11px] text-slate-500">Total Invoice</div>
                  <div className="text-lg font-bold text-blue-600 dark:text-blue-400 tabular-nums">
                    {formatCurrency(consolidatedTotal, currency)}
                  </div>
                  <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-bold">
                    Real Profit: {formatCurrency(consolidatedProfit, currency)} (
                    {consolidatedSubtotal > 0
                      ? ((consolidatedProfit / consolidatedSubtotal) * 100).toFixed(1)
                      : '0.0'}
                    %)
                  </div>
                </div>
              </div>

              {/* Class-Grouped Billing Breakdown */}
              <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800 max-h-56 overflow-y-auto">
                {selectedClassBillingGroups.map((grp, idx) => (
                  <div key={idx} className="px-3.5 py-2.5 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {grp.className} · {grp.learnersCount} learners ×{' '}
                        {formatCurrency(grp.pricePerLearner, currency)}/learner
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Subjects: {grp.papers.map(p => `${p.subjectName} (${p.pages}pp)`).join(', ')}
                      </div>
                      <div className="text-[10px] font-mono text-amber-700 dark:text-amber-400">
                        Paper + Toner Cost: {formatCurrency(grp.materialCost, currency)} · Class Profit:{' '}
                        {formatCurrency(grp.classAmount - grp.materialCost, currency)}
                      </div>
                    </div>
                    <div className="font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                      {formatCurrency(grp.classAmount, currency)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Optional Prepaid Printing Contract Settlement */}
              {schoolActiveContracts.length > 0 && (
                <div className="p-3.5 rounded-lg bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-200 dark:border-indigo-900 space-y-3">
                  <div className="font-bold text-indigo-900 dark:text-indigo-200">
                    Optional: Deduct from School Prepaid Printing Contract
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                        Select Active Contract
                      </label>
                      <select
                        value={selectedContractId}
                        onChange={e => {
                          setSelectedContractId(e.target.value);
                          const ctr = schoolActiveContracts.find(c => c.id === e.target.value);
                          const firstPending = ctr?.assessments.find(a => a.status === 'pending');
                          setSelectedAssessmentNumber(firstPending ? firstPending.assessmentNumber : '');
                        }}
                        className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs outline-none"
                      >
                        <option value="">-- Standard Invoice (Bill to A/R) --</option>
                        {schoolActiveContracts.map(c => (
                          <option key={c.id} value={c.id}>
                            {c.contractNumber} (Bal: {formatCurrency(c.remainingBalance, currency)})
                          </option>
                        ))}
                      </select>
                    </div>

                    {selectedContractId && (
                      <div className="space-y-1">
                        <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                          Contract Assessment Milestone to Deduct
                        </label>
                        <select
                          value={selectedAssessmentNumber}
                          onChange={e =>
                            setSelectedAssessmentNumber(
                              e.target.value ? Number(e.target.value) : ''
                            )
                          }
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs outline-none"
                          required
                        >
                          {schoolActiveContracts
                            .find(c => c.id === selectedContractId)
                            ?.assessments.filter(a => a.status === 'pending')
                            .map(a => (
                              <option key={a.assessmentNumber} value={a.assessmentNumber}>
                                #{a.assessmentNumber}: {a.label} ({a.scheduledDate} · {formatCurrency(a.agreedAmount, currency)})
                              </option>
                            ))}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-4">
                <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300 font-medium">
                  <input
                    type="checkbox"
                    checked={invoiceIncludeTax}
                    onChange={e => setInvoiceIncludeTax(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600"
                  />
                  <span>Apply Sales Tax ({(companyProfile.salesTaxRate * 100).toFixed(1)}%)</span>
                </label>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Invoice Memo</label>
                <input
                  type="text"
                  value={invoiceNotes}
                  onChange={e => setInvoiceNotes(e.target.value)}
                  placeholder="Optional custom note on the consolidated invoice"
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsInvoiceReviewOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow-sm"
                >
                  Generate Consolidated School Invoice
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Production Timeline & Audit Modal */}
      {timelinePaper && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[88vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-amber-400" />
                <h2 className="font-bold text-base">
                  Production Timeline — {timelinePaper.jobNumber}
                </h2>
              </div>
              <button onClick={() => setTimelinePaper(null)} className="p-1 text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto text-xs space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Status</div>
                  <div className="font-bold text-slate-900 dark:text-white">{timelinePaper.status}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">QC</div>
                  <div className="font-bold text-slate-900 dark:text-white">{timelinePaper.qcStatus || 'pending'}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Good / Spoiled</div>
                  <div className="font-bold text-slate-900 dark:text-white">
                    {timelinePaper.goodCopies ?? 0} / {timelinePaper.spoiledCopies ?? 0}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Production version</div>
                  <div className="font-bold text-slate-900 dark:text-white">
                    v{timelinePaper.productionVersion ?? 1}
                  </div>
                </div>
              </div>
              {timelineLoading && <div className="text-slate-500">Loading authoritative events…</div>}
              {!timelineLoading && timelineEvents.length === 0 && (
                <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300">
                  No production events have been recorded for this paper yet.
                </div>
              )}
              <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
                {timelineEvents.map(ev => (
                  <div key={ev.id} className="p-3 flex items-start justify-between gap-4">
                    <div>
                      <div className="font-bold text-slate-900 dark:text-white">
                        {ev.eventType}
                        {ev.fromStatus || ev.toStatus
                          ? ` · ${ev.fromStatus || '—'} → ${ev.toStatus || '—'}`
                          : ''}
                      </div>
                      {ev.reason && <div className="text-[11px] text-slate-500 mt-0.5">{ev.reason}</div>}
                      <div className="text-[10px] font-mono text-slate-400 mt-1">
                        {ev.journalTxnId ? `Journal #${ev.journalTxnId} · ` : ''}
                        {ev.invoiceId ? `Invoice #${ev.invoiceId} · ` : ''}
                        {ev.quantityDelta != null ? `Qty ${ev.quantityDelta} · ` : ''}
                        actor #{ev.actorUserId ?? '—'}
                      </div>
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 whitespace-nowrap">
                      {String(ev.createdAt).slice(0, 19).replace('T', ' ')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Controlled Cancellation Modal */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleCancelExamPaper}
            className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden"
          >
            <div className="px-5 py-3 bg-rose-700 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Ban className="w-5 h-5" />
                <h2 className="font-bold text-base">Cancel {cancelTarget.jobNumber}</h2>
              </div>
              <button type="button" onClick={() => setCancelTarget(null)} className="p-1 text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-xs">
              <p className="text-slate-600 dark:text-slate-300">
                The server releases material reservations, returns unused issued material and writes off
                non-recoverable WIP. The record is retained with an append-only cancellation event.
                Delivered, dispatched and invoiced papers cannot be cancelled.
              </p>
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">
                  Cancellation reason (required)
                </label>
                <textarea
                  value={cancelReason}
                  onChange={e => setCancelReason(e.target.value)}
                  rows={3}
                  required
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                  placeholder="Why is this examination paper being cancelled?"
                />
              </div>
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setCancelTarget(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Keep Paper
                </button>
                <button
                  type="submit"
                  disabled={examActionBusy || !cancelReason.trim()}
                  className="px-5 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white font-bold"
                >
                  {examActionBusy ? 'Cancelling…' : 'Cancel Paper'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Controlled Reprint Modal */}
      {reprintTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleReprintExamPaper}
            className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden"
          >
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-amber-400" />
                <h2 className="font-bold text-base">Raise Reprint — {reprintTarget.jobNumber}</h2>
              </div>
              <button type="button" onClick={() => setReprintTarget(null)} className="p-1 text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3 text-xs">
              <p className="text-slate-600 dark:text-slate-300">
                A reprint creates a new production record linked to the original. The original paper,
                its costs and its invoice are never modified.
              </p>
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Reprint reason (required)</label>
                <textarea
                  value={reprintReason}
                  onChange={e => setReprintReason(e.target.value)}
                  rows={3}
                  required
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                  placeholder="e.g. QC failure, damaged in transit, exam office shortage"
                />
              </div>
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Reprint copies</label>
                <input
                  type="number"
                  min="1"
                  value={reprintCopies}
                  onChange={e => setReprintCopies(parseInt(e.target.value) || 0)}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono outline-none"
                />
              </div>
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setReprintTarget(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={examActionBusy || !reprintReason.trim()}
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold"
                >
                  {examActionBusy ? 'Creating reprint…' : 'Create Reprint Job'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Examination Reconciliation Modal */}
      {reconciliationOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[88vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-amber-400" />
                <h2 className="font-bold text-base">Examination Reconciliation</h2>
              </div>
              <button onClick={() => setReconciliationOpen(false)} className="p-1 text-white/80 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto text-xs space-y-2">
              {!reconciliation && <div className="text-slate-500">Reading authoritative records…</div>}
              {reconciliation?.checks?.map((check: any) => (
                <div
                  key={check.key}
                  className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3"
                >
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-white">{check.label}</div>
                    {check.detail && (
                      <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                        {Object.entries(check.detail)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold tabular-nums text-slate-700 dark:text-slate-200">
                      {check.value}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full font-bold uppercase text-[9px] ${
                        check.status === 'critical'
                          ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300'
                          : check.status === 'attention'
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
                            : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                      }`}
                    >
                      {check.status}
                    </span>
                  </div>
                </div>
              ))}
              {reconciliation && (
                <div className="text-[10px] font-mono text-slate-400 pt-2">
                  Generated {String(reconciliation.generatedAt).slice(0, 19).replace('T', ' ')} ·{' '}
                  {reconciliation.criticalCount} critical · {reconciliation.attentionCount} attention
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {workflowGroupId != null && (
        <ExamGroupWorkflowModal groupId={workflowGroupId} onClose={() => setWorkflowGroupId(null)} />
      )}
    </div>
  );
};
