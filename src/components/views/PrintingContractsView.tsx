import React, { useState, useMemo } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ContractAssessmentMilestone, PrintingContract } from '../../types/accounting';
import { documentsApi } from '../../services/documentsApi';
import {
  mapApiPreviewToModel,
  mapContractToPreviewModel,
  mapLocalInvoiceToPreviewModel,
} from '../../types/documents';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';
import {
  AmendContractModal,
  AddAssessmentModal,
  RemoveAssessmentModal,
  ContractInfoModal,
  FundContractModal,
  ActivationRequestModal,
  CancelContractModal,
  TopUpContractModal,
  RenewContractModal,
  RecordAcceptanceModal,
  VoidContractModal,
  AmendmentsModal,
  SignContractModal,
  ReconciliationView,
} from '../modals/ContractActionModals';
import { computeContractIntegrity } from '../../utils/contractIntegrity';
import {
  FileSpreadsheet,
  Plus,
  CheckCircle2,
  Clock,
  Landmark,
  BookOpen,
  Copy,
  X,
  TrendingUp,
  SlidersHorizontal,
  Calendar,
  Eye,
  FileText,
  Paperclip,
  Upload,
  Pencil,
  DollarSign,
  Ban,
  Repeat,
  Play,
  Trash2,
  ClipboardCheck,
  Undo2,
  CalendarDays,
  ReceiptText,
} from 'lucide-react';
import {
  buildPaperStockFromInventoryItem,
  buildTonerSpecFromInventoryItem,
  calculateContractMilestoneEstimate,
} from '../../shared/printingWorkflows';
import type { TonerMachineSpec } from '../../shared/tonerCalc';

const CONTRACT_PRESS_CAPABILITY: TonerMachineSpec = {
  machineId: 'contract-digital-press',
  name: 'Contract Press',
  processType: 'digital_press',
  supportsColour: false,
  supportsDuplex: true,
  status: 'active',
};

export const PrintingContractsView: React.FC = () => {
  const {
    companyProfile,
    customers,
    accounts,
    bankTransactions,
    inventoryItems,
    printingContracts,
    addPrintingContract,
    updateContractAssessment,
    completeContractAssessment,
    linkContractDepositInvoice,
    linkMilestoneInvoice,
    cancelPrintingContract,
    activatePrintingContract,
    renewPrintingContract,
    amendPrintingContract,
    suspendContract,
    resumeContract,
    voidPrintingContract,
    addContractAssessment,
    removeContractAssessment,
    generateAndSyncWorkflowInvoice,
    getInvoiceById,
    openDocumentPreview,
    openPrimePreview,
    getRawUsageUnitCost,
    getAssessmentActualStats,
    setCurrentView,
    triggerShortcutNotice,
  } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const canInvoice = hasPermission('invoices:write');
  const canReadCosts = hasPermission('estimates:read_costs');
  const canUploadAttachment = hasPermission('attachments:write');
  const currency = companyProfile.currency || 'K';
  const currencySymbol = getCurrencySymbol(currency);

  const bankAccounts = useMemo(() => accounts.filter(a => a.type === 'Bank'), [accounts]);
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

  const [selectedContractId, setSelectedContractId] = useState<string>(
    printingContracts[0]?.id || ''
  );

  // Contract action modal (amend / add / remove / financials / wallet / history /
  // progress / fund / activation / cancel / topup / renew)
  type ContractModalState =
    | {
        type:
          | 'amend'
          | 'add'
          | 'remove'
          | 'financials'
          | 'wallet'
          | 'history'
          | 'progress'
          | 'fund'
          | 'activation'
          | 'cancel'
          | 'topup'
          | 'renew'
          | 'acceptance'
          | 'void'
          | 'amendments'
          | 'sign'
          | 'reconciliation';
        contractId: string;
      }
    | null;
  const [activeModal, setActiveModal] = useState<ContractModalState>(null);
  const activeContract = activeModal
    ? printingContracts.find(c => c.id === activeModal.contractId) || null
    : null;

  // Create Contract Modal State
  const [isNewContractOpen, setIsNewContractOpen] = useState(false);
  const [schoolCustomerId, setSchoolCustomerId] = useState(
    customers.find(c => c.customerType === 'school')?.id || customers[0]?.id || ''
  );
  const [title, setTitle] = useState('2026 School Term Examination Printing Retainer');
  const [academicYear, setAcademicYear] = useState('2026');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState('2026-12-15');
  const [totalPrepaidAmount, setTotalPrepaidAmount] = useState<number>(80000);
  const [totalAssessments, setTotalAssessments] = useState<2 | 3 | 4 | 5>(4);
  const [splitEvenly, setSplitEvenly] = useState(true);
  const [customAmounts, setCustomAmounts] = useState<number[]>([20000, 20000, 20000, 20000, 0]);
  const [assessmentLabels, setAssessmentLabels] = useState<string[]>([
    'Assessment 1 — Term 1 Mid-Term Exams',
    'Assessment 2 — Term 1 End-of-Term Exams',
    'Assessment 3 — Term 2 Mock Exams',
    'Assessment 4 — Term 3 Final Exams',
    'Assessment 5 — Supplementary National Prep',
  ]);
  const [assessmentDates, setAssessmentDates] = useState<string[]>([
    '2026-03-15',
    '2026-05-20',
    '2026-08-14',
    '2026-11-25',
    '2026-12-10',
  ]);
  const [assessmentSheets, setAssessmentSheets] = useState<number[]>([40000, 42000, 40000, 45000, 30000]);
  const [assessmentImpressions, setAssessmentImpressions] = useState<number[]>([80000, 84000, 80000, 90000, 60000]);
  const [draftPaperItemId, setDraftPaperItemId] = useState<string>(defaultPaperId);
  const [draftTonerItemId, setDraftTonerItemId] = useState<string>(defaultTonerId);

  const [depositBankAccountId, setDepositBankAccountId] = useState(
    bankAccounts[0]?.id || companyProfile.defaultBankAccountId
  );
  const [contractNotes, setContractNotes] = useState('');

  // Extended new-contract form (PrimeERP-style sections)
  type ContractLineItem = {
    id: string;
    item: string;
    grade: string;
    subject: string;
    qty: number;
    unitPrice: number;
  };
  const newLine = (over: Partial<ContractLineItem> = {}): ContractLineItem => ({
    id: `li-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    item: '',
    grade: '',
    subject: '',
    qty: 1,
    unitPrice: 0,
    ...over,
  });
  const [schoolZone, setSchoolZone] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [expectedCandidates, setExpectedCandidates] = useState<number>(0);
  const [sittings, setSittings] = useState('Once Off');
  const [pricingModel, setPricingModel] = useState<'' | 'per_candidate'>('');
  const [chargePerCandidate, setChargePerCandidate] = useState<number>(0);
  const [taxHandling, setTaxHandling] = useState('');
  const [discount, setDiscount] = useState('');
  const [urgentFee, setUrgentFee] = useState('');
  const [pricingNotes, setPricingNotes] = useState('');
  const [lineItems, setLineItems] = useState<ContractLineItem[]>([
    newLine({ item: 'Term 2 Grade 7 Mathematics' }),
    newLine({ item: 'Term 2 Grade 7 English' }),
  ]);
  const [paperSize, setPaperSize] = useState('');
  const [paperType, setPaperType] = useState('');
  const [paperWeight, setPaperWeight] = useState('');
  const [colour, setColour] = useState('');
  const [sides, setSides] = useState('');
  const [orientation, setOrientation] = useState('');
  const [pagesPerCopy, setPagesPerCopy] = useState<number>(0);
  const [copies, setCopies] = useState<number>(0);
  const [finishing, setFinishing] = useState('');
  const [packaging, setPackaging] = useState('');
  const [specNotes, setSpecNotes] = useState('');
  const [deliveryMethod, setDeliveryMethod] = useState('');
  const [deliveryTimeline, setDeliveryTimeline] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryPackaging, setDeliveryPackaging] = useState('');
  const [deliveryNotes, setDeliveryNotes] = useState('');
  const [generalTerms, setGeneralTerms] = useState('');

  const lineAmount = (li: ContractLineItem) =>
    Math.round((li.qty || 0) * (li.unitPrice || 0) * 100) / 100;
  const contractTotal = lineItems.reduce((s, li) => s + lineAmount(li), 0);
  const candidateTotal =
    pricingModel === 'per_candidate' ? expectedCandidates * chargePerCandidate : 0;
  const effectiveContractTotal = candidateTotal > 0 ? candidateTotal : contractTotal;
  const lineItemsValid = lineItems.length >= 2 && lineItems.length <= 5;

  // Complete Assessment Deduction Modal State
  const [deductionTarget, setDeductionTarget] = useState<{
    contractId: string;
    milestone: ContractAssessmentMilestone;
  } | null>(null);
  const [examBatchNote, setExamBatchNote] = useState('');

  // Edit Assessment Date & Paper/Toner Modal
  const [editTarget, setEditTarget] = useState<{
    contractId: string;
    assessmentNumber: number;
    label: string;
    scheduledDate: string;
    agreedAmount: number;
    rawPaperItemId: string;
    rawTonerItemId: string;
    estimatedSheets: number;
    estimatedImpressions: number;
  } | null>(null);

  const selectedContract =
    printingContracts.find(c => c.id === selectedContractId) || printingContracts[0];

  // Attach Contract File Modal & Action State
  const [isAttachModalOpen, setIsAttachModalOpen] = useState(false);
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [attachNotes, setAttachNotes] = useState('');
  const [attachUploading, setAttachUploading] = useState(false);
  const [contractActionBusy, setContractActionBusy] = useState(false);

  // Register search / status filter / pagination
  const [contractSearch, setContractSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | PrintingContract['status']>('all');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  const filteredContracts = useMemo(() => {
    const q = contractSearch.trim().toLowerCase();
    return printingContracts.filter(c => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (!q) return true;
      const school = customers.find(cu => cu.id === c.schoolCustomerId);
      return (
        c.contractNumber.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        (school?.companyName || school?.name || '').toLowerCase().includes(q)
      );
    });
  }, [printingContracts, customers, contractSearch, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredContracts.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedContracts = filteredContracts.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  const handleAssessmentsCountChange = (count: 2 | 3 | 4 | 5) => {
    setTotalAssessments(count);
    const even = Math.round((totalPrepaidAmount / count) * 100) / 100;
    const next = [0, 0, 0, 0, 0];
    for (let i = 0; i < count; i++) {
      next[i] =
        i === count - 1
          ? Math.round((totalPrepaidAmount - even * (count - 1)) * 100) / 100
          : even;
    }
    setCustomAmounts(next);
  };

  const handleTotalPrepaidChange = (val: number) => {
    setTotalPrepaidAmount(val);
    if (splitEvenly) {
      const even = Math.round((val / totalAssessments) * 100) / 100;
      const next = [0, 0, 0, 0, 0];
      for (let i = 0; i < totalAssessments; i++) {
        next[i] =
          i === totalAssessments - 1
            ? Math.round((val - even * (totalAssessments - 1)) * 100) / 100
            : even;
      }
      setCustomAmounts(next);
    }
  };

  const paperUnitCost = draftPaperItemId ? getRawUsageUnitCost(draftPaperItemId) : 0;
  const tonerUnitCost = draftTonerItemId ? getRawUsageUnitCost(draftTonerItemId) : 0;
  const draftPaperMat = rawMaterials.find(r => r.id === draftPaperItemId);
  const draftTonerMat = rawMaterials.find(r => r.id === draftTonerItemId);

  const buildDraftAssessments = (): ContractAssessmentMilestone[] => {
    const even = Math.round((totalPrepaidAmount / totalAssessments) * 100) / 100;
    const paperStock = draftPaperMat ? buildPaperStockFromInventoryItem(draftPaperMat) : null;
    const tonerChannels = draftTonerMat ? { K: buildTonerSpecFromInventoryItem(draftTonerMat, 'K') } : null;

    return Array.from({ length: totalAssessments }).map((_, idx) => {
      const agreed = splitEvenly
        ? idx === totalAssessments - 1
          ? Math.round((totalPrepaidAmount - even * (totalAssessments - 1)) * 100) / 100
          : even
        : customAmounts[idx] || 0;
      const estSheets = assessmentSheets[idx] || 0;
      const estImp = assessmentImpressions[idx] || 0;
      const est = calculateContractMilestoneEstimate({
        paperStock,
        tonerChannels,
        machine: CONTRACT_PRESS_CAPABILITY,
        estimatedSheets: estSheets,
        estimatedImpressions: estImp,
        agreedAmount: agreed,
      });
      return {
        assessmentNumber: idx + 1,
        label: assessmentLabels[idx] || `Assessment ${idx + 1}`,
        scheduledDate: assessmentDates[idx] || startDate,
        agreedAmount: agreed,
        rawPaperItemId: draftPaperItemId || undefined,
        rawTonerItemId: draftTonerItemId || undefined,
        estimatedSheets: estSheets,
        estimatedImpressions: estImp,
        paperCost: est.paperCost,
        tonerCost: est.tonerCost,
        totalCost: est.totalCost,
        profit: est.profit,
        status: 'pending',
      };
    });
  };

  const draftAssessmentsList = buildDraftAssessments();
  const draftSum = draftAssessmentsList.reduce((s, a) => s + a.agreedAmount, 0);
  // Tolerance tightened to half a cent so a 0.01 discrepancy is rejected (G-25).
  const customMismatch = !splitEvenly && Math.abs(draftSum - totalPrepaidAmount) > 0.005;

  const handleCreateContract = async (e: React.FormEvent) => {
    e.preventDefault();
    const candidateTotal =
      pricingModel === 'per_candidate' ? expectedCandidates * chargePerCandidate : 0;
    const effectiveTotal = candidateTotal > 0 ? candidateTotal : contractTotal;
    if (!schoolCustomerId || effectiveTotal <= 0 || !lineItemsValid) {
      triggerShortcutNotice('Add 2–5 priced line items (or per-candidate pricing) and a customer.', 'error');
      return;
    }
    if (endDate < startDate) {
      triggerShortcutNotice('End date cannot be before the start date.', 'error');
      return;
    }

    const perAssessmentSheets = pagesPerCopy > 0 && copies > 0 ? pagesPerCopy * copies : 0;
    // When per-candidate pricing drives the total, distribute it across the
    // line items so the assessment amounts still sum to the contract total.
    const baseWeights = lineItems.map(li => lineAmount(li));
    const weightSum = baseWeights.reduce((s, w) => s + w, 0);
    let allocated = 0;
    const assessments: ContractAssessmentMilestone[] = lineItems.map((li, idx) => {
      const isLast = idx === lineItems.length - 1;
      let amount: number;
      if (candidateTotal > 0) {
        amount = isLast
          ? Math.round((effectiveTotal - allocated) * 100) / 100
          : Math.round((effectiveTotal * (weightSum > 0 ? baseWeights[idx] / weightSum : 1 / lineItems.length)) * 100) / 100;
        allocated += amount;
      } else {
        amount = lineAmount(li);
      }
      return {
        assessmentNumber: idx + 1,
        label: [li.item, li.grade && `Grade ${li.grade}`, li.subject]
          .filter(Boolean)
          .join(' · ') || `Item ${idx + 1}`,
        scheduledDate: startDate,
        agreedAmount: amount,
        rawPaperItemId: draftPaperItemId || undefined,
        rawTonerItemId: draftTonerItemId || undefined,
        estimatedSheets: perAssessmentSheets,
        estimatedImpressions: 0,
        paperCost: 0,
        tonerCost: 0,
        totalCost: 0,
        profit: amount,
        status: 'pending',
      };
    });

    // Persist the extended sections that have no dedicated columns as a
    // structured, readable block appended to the contract notes.
    const detailLines = [
      schoolZone && `School zone: ${schoolZone}`,
      customerPhone && `Customer phone: ${customerPhone}`,
      expectedCandidates > 0 && `Expected candidates: ${expectedCandidates}`,
      `Sittings: ${sittings}`,
      pricingModel === 'per_candidate' &&
        `Pricing: ${formatCurrency(chargePerCandidate, currency)} per candidate`,
      taxHandling && `Tax handling: ${taxHandling}`,
      discount && `Discount: ${discount}`,
      urgentFee && `Urgent fee: ${urgentFee}`,
      pricingNotes && `Pricing notes: ${pricingNotes}`,
      (paperSize || paperType || paperWeight) &&
        `Paper: ${[paperSize, paperType, paperWeight && `${paperWeight}gsm`]
          .filter(Boolean)
          .join(' · ')}`,
      (colour || sides || orientation) &&
        `Print: ${[colour, sides, orientation].filter(Boolean).join(' · ')}`,
      pagesPerCopy > 0 && `Pages per copy: ${pagesPerCopy}`,
      copies > 0 && `Copies: ${copies}`,
      finishing && `Finishing: ${finishing}`,
      packaging && `Packaging: ${packaging}`,
      specNotes && `Specification notes: ${specNotes}`,
      deliveryMethod && `Delivery method: ${deliveryMethod}`,
      deliveryTimeline && `Delivery timeline: ${deliveryTimeline}`,
      deliveryAddress && `Delivery address: ${deliveryAddress}`,
      deliveryPackaging && `Delivery packaging: ${deliveryPackaging}`,
      deliveryNotes && `Delivery notes: ${deliveryNotes}`,
      generalTerms && `General terms: ${generalTerms}`,
      contractNotes && `Notes: ${contractNotes}`,
    ].filter(Boolean);
    const composedNotes = detailLines.join('\n');

    const created = await addPrintingContract({
      schoolCustomerId,
      title,
      academicYear,
      startDate,
      endDate,
      totalPrepaidAmount: effectiveTotal,
      totalAssessments: lineItems.length as 2 | 3 | 4 | 5,
      depositBankAccountId,
      assessments,
      notes: composedNotes || contractNotes,
      schoolZone,
      customerPhone,
      expectedCandidates,
      sittings,
      pricingModel,
      chargePerCandidate,
      taxHandling,
      discount,
      urgentFee,
      pricingNotes,
      printSpec: {
        paperSize,
        paperType,
        paperWeight,
        colour,
        sides,
        orientation,
        pagesPerCopy,
        copies,
        finishing,
        packaging,
        notes: specNotes,
      },
      delivery: {
        method: deliveryMethod,
        timeline: deliveryTimeline,
        address: deliveryAddress,
        packaging: deliveryPackaging,
        notes: deliveryNotes,
      },
      generalTerms,
    });

    setSelectedContractId(created.id);
    setIsNewContractOpen(false);
    triggerShortcutNotice(
      `Created prepaid contract ${created.contractNumber} (${lineItems.length} items · ${formatCurrency(effectiveTotal, currency)})`
    );
  };

  const handleConfirmAssessmentDeduction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deductionTarget) return;

    await completeContractAssessment(
      deductionTarget.contractId,
      deductionTarget.milestone.assessmentNumber,
      examBatchNote
    );

    triggerShortcutNotice(
      `Completed ${deductionTarget.milestone.label} and deducted ${formatCurrency(deductionTarget.milestone.agreedAmount, currency)}!`
    );
    setDeductionTarget(null);
    setExamBatchNote('');
  };

  const handleSaveAssessmentEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget) return;
    updateContractAssessment(editTarget.contractId, editTarget.assessmentNumber, {
      label: editTarget.label,
      scheduledDate: editTarget.scheduledDate,
      rawPaperItemId: editTarget.rawPaperItemId || undefined,
      rawTonerItemId: editTarget.rawTonerItemId || undefined,
      estimatedSheets: editTarget.estimatedSheets,
      estimatedImpressions: editTarget.estimatedImpressions,
    });
    triggerShortcutNotice(
      `Updated Assessment #${editTarget.assessmentNumber} date & paper/toner profit calculation`
    );
    setEditTarget(null);
  };

  const openContractPreview = (contract: PrintingContract) => {
    const school = customers.find(c => String(c.id) === String(contract.schoolCustomerId));
    openDocumentPreview(
      mapContractToPreviewModel({
        contract,
        customer: school,
        companyProfile,
        companyNameOverride: activeCompany?.name,
        includeCosts: canReadCosts,
        onInvoiceGenerated: ({ apiInvoice, localInvoice }) => {
          if (!contract.depositInvoiceId && !contract.depositBackendInvoiceId) {
            linkContractDepositInvoice(contract.id, {
              invoiceId: localInvoice?.id,
              backendInvoiceId: apiInvoice.id,
              invoiceNumber: apiInvoice.invoiceNumber,
            });
          }
        },
      })
    );
  };

  const openSchedulePreview = async (contract: PrintingContract) => {
    const school = customers.find(c => String(c.id) === String(contract.schoolCustomerId));
    const { hash } = await computeContractIntegrity(contract);
    const schedule = contract.assessments.map((a, i) => ({
      sequence: i + 1,
      assessmentName: a.label,
      assessmentDate: a.scheduledDate,
      status: a.status,
      unitPrice: a.agreedAmount,
    }));
    openPrimePreview(
      'CONTRACT_SCHEDULE',
      {
        contractNumber: contract.contractNumber,
        date: contract.startDate,
        version: 1,
        status: contract.status,
        customerName: school?.companyName || school?.name || '',
        schoolName: school?.companyName,
        academicYear: contract.academicYear,
        periodStart: contract.startDate,
        periodEnd: contract.endDate,
        schedule,
        totalAssessments: contract.totalAssessments,
        scheduleComplete: contract.assessments.every(a => a.scheduledDate),
        missingDateSequences: contract.assessments
          .map((a, i) => (a.scheduledDate ? 0 : i + 1))
          .filter(n => n > 0),
        scheduledCount: contract.assessments.filter(a => a.scheduledDate).length,
        consumedCount: contract.completedAssessments,
        releasedCount: 0,
        contentHash: hash,
        companyName: activeCompany?.name,
      },
      `Schedule · ${contract.contractNumber}`
    );
  };

  const openReceiptPreview = async (
    contract: PrintingContract,
    milestone?: ContractAssessmentMilestone
  ) => {
    const school = customers.find(c => String(c.id) === String(contract.schoolCustomerId));
    const item =
      milestone ||
      contract.assessments.find(a => a.status === 'completed') ||
      contract.assessments[0];
    if (!item) {
      triggerShortcutNotice('No assessment to build a completion receipt from.', 'error');
      return;
    }
    const { hash } = await computeContractIntegrity(contract);
    openPrimePreview(
      'CONTRACT_COMPLETION_RECEIPT',
      {
        receiptNumber: `CR-${contract.contractNumber}-${item.assessmentNumber}`,
        contractNumber: contract.contractNumber,
        date: contract.startDate,
        version: 1,
        status: contract.status,
        customerName: school?.companyName || school?.name || '',
        schoolName: school?.companyName,
        academicYear: contract.academicYear,
        item: {
          assessmentName: item.label,
          consumedAt: item.completedDate,
          unitPrice: item.agreedAmount,
        },
        sequence: item.assessmentNumber,
        totalAssessments: contract.totalAssessments,
        completedToDate: contract.completedAssessments,
        remainingAssessments: contract.totalAssessments - contract.completedAssessments,
        contractValue: contract.totalPrepaidAmount,
        amountDebited: item.agreedAmount,
        totalConsumedToDate: contract.allocatedAmount,
        remainingReservedFunds: contract.remainingBalance,
        unallocatedFunds: contract.unallocatedAmount,
        walletBalanceAfter: 0,
        walletTransactionId: '',
        ledgerEntryId: '',
        contentHash: hash,
        companyName: activeCompany?.name,
      },
      `Completion Receipt · ${contract.contractNumber}`
    );
  };

  const openLinkedInvoiceByRef = async (ref: {
    invoiceId?: string;
    backendInvoiceId?: number;
    invoiceNumber?: string;
  }) => {
    if (ref.backendInvoiceId) {
      try {
        const raw = await documentsApi.getDocumentPreview('invoice', ref.backendInvoiceId);
        openDocumentPreview(mapApiPreviewToModel(raw, currency));
        return;
      } catch {
        // fallback to local invoice
      }
    }
    if (ref.invoiceId) {
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

  const handleGenerateRetainerInvoice = async (contract: PrintingContract) => {
    if (!canInvoice || contractActionBusy) return;
    const school = customers.find(c => String(c.id) === String(contract.schoolCustomerId));
    const totalCost = contract.assessments.reduce((s, a) => s + (a.totalCost || 0), 0);
    setContractActionBusy(true);
    try {
      const { apiInvoice, localInvoice } = await generateAndSyncWorkflowInvoice(
        {
          sourceKind: 'contract',
          sourceRef: contract.contractNumber,
          customerName: school?.companyName || school?.name || 'School Institution',
          customerEmail: school?.email,
          customerPhone: school?.phone,
          customerAddress: school?.billingAddress,
          customerType: school?.customerType || 'school',
          invoiceDate: contract.startDate,
          dueDate: contract.endDate,
          terms: school?.terms || 'Net 30',
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
        },
        { localCustomerId: contract.schoolCustomerId }
      );
      linkContractDepositInvoice(contract.id, {
        invoiceId: localInvoice.id,
        backendInvoiceId: apiInvoice.id,
        invoiceNumber: apiInvoice.invoiceNumber,
      });
      triggerShortcutNotice(
        `Generated retainer invoice ${apiInvoice.invoiceNumber} for ${contract.contractNumber}`
      );
      try {
        const raw = await documentsApi.getDocumentPreview('invoice', apiInvoice.id);
        openDocumentPreview(mapApiPreviewToModel(raw, currency));
      } catch {
        openDocumentPreview(
          mapLocalInvoiceToPreviewModel({
            invoice: localInvoice,
            customer: school,
            companyProfile,
            companyNameOverride: activeCompany?.name,
          })
        );
      }
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to generate retainer invoice', 'error');
    } finally {
      setContractActionBusy(false);
    }
  };

  const handleGenerateMilestoneInvoice = async (
    contract: PrintingContract,
    milestone: ContractAssessmentMilestone
  ) => {
    if (!canInvoice || contractActionBusy) return;
    const school = customers.find(c => String(c.id) === String(contract.schoolCustomerId));
    setContractActionBusy(true);
    try {
      const { apiInvoice, localInvoice } = await generateAndSyncWorkflowInvoice(
        {
          sourceKind: 'contract_milestone',
          sourceRef: `${contract.contractNumber}-A${milestone.assessmentNumber}`,
          customerName: school?.companyName || school?.name || 'School Institution',
          customerEmail: school?.email,
          customerPhone: school?.phone,
          customerAddress: school?.billingAddress,
          customerType: school?.customerType || 'school',
          invoiceDate: new Date().toISOString().slice(0, 10),
          dueDate: milestone.scheduledDate,
          terms: school?.terms || 'Net 30',
          taxRate: 0,
          notes: `Assessment #${milestone.assessmentNumber} Invoice under Contract ${contract.contractNumber} (${contract.title}).`,
          idempotencyKey: `contract-ms-${contract.id}-${milestone.assessmentNumber}`,
          lines: [
            {
              description: `${contract.contractNumber} · #${milestone.assessmentNumber}: ${milestone.label} (${milestone.scheduledDate})`,
              quantity: 1,
              rate: milestone.agreedAmount,
              unitCost: milestone.totalCost || 0,
              taxable: false,
            },
          ],
        },
        { localCustomerId: contract.schoolCustomerId }
      );
      updateContractAssessment(contract.id, milestone.assessmentNumber, {
        linkedInvoiceId: localInvoice.id,
        backendInvoiceId: apiInvoice.id,
        linkedInvoiceNumber: apiInvoice.invoiceNumber,
      });
      // Persist the link so it survives a refresh (G-09).
      try {
        await linkMilestoneInvoice(contract.id, milestone.assessmentNumber, {
          invoiceId: localInvoice.id,
          backendInvoiceId: apiInvoice.id,
          invoiceNumber: apiInvoice.invoiceNumber,
        });
      } catch {
        /* the local link is already set; a failed server link is non-fatal */
      }
      triggerShortcutNotice(
        `Generated assessment invoice ${apiInvoice.invoiceNumber} for #${milestone.assessmentNumber}`
      );
      try {
        const raw = await documentsApi.getDocumentPreview('invoice', apiInvoice.id);
        openDocumentPreview(mapApiPreviewToModel(raw, currency));
      } catch {
        openDocumentPreview(
          mapLocalInvoiceToPreviewModel({
            invoice: localInvoice,
            customer: school,
            companyProfile,
            companyNameOverride: activeCompany?.name,
          })
        );
      }
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to generate assessment invoice', 'error');
    } finally {
      setContractActionBusy(false);
    }
  };

  const handleAttachContractFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!attachFile || !selectedContract || attachUploading) return;
    setAttachUploading(true);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          const idx = result.indexOf(',');
          resolve(idx >= 0 ? result.slice(idx + 1) : result);
        };
        reader.onerror = () => reject(new Error('Failed to read selected file'));
        reader.readAsDataURL(attachFile);
      });
      // Attachments must target the real backend record, never a hardcoded id (G-24).
      const targetEntityId = selectedContract.backendId ?? Number(selectedContract.id);
      if (!Number.isInteger(targetEntityId) || targetEntityId <= 0 || !selectedContract.backendId) {
        triggerShortcutNotice('This contract has no server record, so files cannot be attached.', 'error');
        setIsAttachModalOpen(false);
        return;
      }
      await documentsApi.uploadAttachment({
        fileName: attachFile.name,
        contentType: attachFile.type || 'application/octet-stream',
        entityType: 'printing_contract',
        entityId: targetEntityId,
        contentBase64,
        notes: attachNotes.trim() || `Contract ${selectedContract.contractNumber}: ${selectedContract.title}`,
      });
      triggerShortcutNotice(`Attached "${attachFile.name}" to All Documents Center`);
      setIsAttachModalOpen(false);
      setAttachFile(null);
      setAttachNotes('');
    } catch (err: any) {
      triggerShortcutNotice(err?.message || 'Failed to upload contract attachment', 'error');
    } finally {
      setAttachUploading(false);
    }
  };

  // KPI metrics
  const totalContracted = printingContracts.reduce((s, c) => s + c.totalPrepaidAmount, 0);
  const totalRemainingRetainer = printingContracts.reduce((s, c) => s + c.remainingBalance, 0);
  const totalContractMaterialCost = printingContracts.reduce(
    (s, c) => s + c.assessments.reduce((as, a) => as + (a.totalCost || 0), 0),
    0
  );
  const totalContractProfit = totalContracted - totalContractMaterialCost;
  const totalCompletedAssessments = printingContracts.reduce(
    (s, c) => s + c.completedAssessments,
    0
  );
  const totalAgreedAssessments = printingContracts.reduce((s, c) => s + c.totalAssessments, 0);

  const buildContractActionContext = (record: any, pendingId?: string | null): ActionEligibilityContext<any> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'printing_contracts',
    entityType: 'contract',
    record,
    recordStatus: record?.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const renderContractActions = (contract: any, nextPending: any) => {
    const defs: AdvancedActionDefinition<any>[] = [
      { id: 'preview-contract', label: 'Preview & Print Contract', icon: <Eye className="w-3.5 h-3.5 text-slate-700" />, group: 'view', groupLabel: 'Contract', requiredPermission: 'printing:read', execute: async () => openContractPreview(contract) },
      { id: 'preview-schedule', label: 'Preview Schedule', icon: <CalendarDays className="w-3.5 h-3.5 text-indigo-600" />, group: 'view', groupLabel: 'Contract', requiredPermission: 'printing:read', execute: async () => openSchedulePreview(contract) },
      { id: 'preview-receipt', label: 'Preview Completion Receipt', icon: <ReceiptText className="w-3.5 h-3.5 text-emerald-600" />, group: 'view', groupLabel: 'Contract', requiredPermission: 'printing:read', execute: async () => openReceiptPreview(contract) },
    ];
    if (!contract.depositInvoiceId && !contract.depositBackendInvoiceId && canInvoice) defs.push({ id: 'generate-retainer-inv', label: 'Generate Retainer Invoice', icon: <FileText className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Invoice', requiredPermission: 'invoices:write', execute: async () => handleGenerateRetainerInvoice(contract) });
    if (contract.depositInvoiceId || contract.depositBackendInvoiceId) defs.push({ id: 'preview-retainer-inv', label: `Preview Retainer Invoice${contract.depositInvoiceNumber ? ` (${contract.depositInvoiceNumber})` : ''}`, icon: <FileText className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Invoice', requiredPermission: 'invoices:read', execute: async () => openLinkedInvoiceByRef({ invoiceId: contract.depositInvoiceId, backendInvoiceId: contract.depositBackendInvoiceId, invoiceNumber: contract.depositInvoiceNumber }) });
    defs.push({ id: 'inspect-schedule', label: 'View Assessment Schedule', icon: <FileSpreadsheet className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Contract', requiredPermission: 'printing:read', execute: async () => setSelectedContractId(contract.id) });
    if (nextPending) defs.push({ id: 'deduct-next', label: `Complete & Deduct Assessment #${nextPending.assessmentNumber}`, icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Assessment', requiredPermission: 'printing:write', execute: async () => { setDeductionTarget({ contractId: contract.id, milestone: nextPending }); setExamBatchNote(''); } });
    defs.push({ id: 'open-exams', label: 'Open Examination Module', icon: <BookOpen className="w-3.5 h-3.5 text-indigo-600" />, group: 'view', groupLabel: 'Contract', requiredPermission: 'printing:read', execute: async () => setCurrentView('examinations') });
    defs.push({ id: 'copy-contract', label: 'Copy Contract #', icon: <Copy className="w-3.5 h-3.5" />, group: 'admin', groupLabel: 'Other', requiredPermission: 'printing:read', execute: async () => { await navigator.clipboard?.writeText(contract.contractNumber); triggerShortcutNotice(`Copied ${contract.contractNumber}`); } });
    defs.push({ id: 'contract.view', label: 'View Contract', icon: <Eye className="w-3.5 h-3.5 text-slate-600" />, group: 'view', groupLabel: 'Contract', requiredPermission: 'printing:read', execute: async () => setSelectedContractId(contract.id) });
    defs.push({ id: 'contract.view-assessments', label: 'View Covered Assessments', icon: <FileSpreadsheet className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Contract', requiredPermission: 'printing:read', execute: async () => setSelectedContractId(contract.id) });
    defs.push({ id: 'contract.prepaid', label: `View Prepaid Amount (${formatCurrency(contract.totalPrepaidAmount, currency)})`, icon: <DollarSign className="w-3.5 h-3.5 text-emerald-600" />, group: 'view', groupLabel: 'Financials', requiredPermission: 'printing:read', execute: async () => setActiveModal({ type: 'financials', contractId: contract.id }) });
    defs.push({ id: 'contract.remaining', label: `View Remaining Balance (${formatCurrency(contract.remainingBalance, currency)})`, icon: <DollarSign className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Financials', requiredPermission: 'printing:read', execute: async () => setActiveModal({ type: 'financials', contractId: contract.id }) });
    defs.push({ id: 'contract.production-progress', label: 'View Production Progress', icon: <BookOpen className="w-3.5 h-3.5 text-indigo-600" />, group: 'view', groupLabel: 'Production', requiredPermission: 'printing:read', execute: async () => setActiveModal({ type: 'progress', contractId: contract.id }) });
    defs.push({ id: 'contract.wallet-tx', label: 'View Wallet Transactions', icon: <FileText className="w-3.5 h-3.5 text-slate-600" />, group: 'view', groupLabel: 'Financials', requiredPermission: 'printing:read', execute: async () => setActiveModal({ type: 'wallet', contractId: contract.id }) });
    defs.push({ id: 'contract.history', label: 'View Contract History', icon: <FileText className="w-3.5 h-3.5 text-slate-600" />, group: 'view', groupLabel: 'Contract', requiredPermission: 'printing:read', execute: async () => setActiveModal({ type: 'history', contractId: contract.id }) });
    defs.push({ id: 'contract.amendments', label: 'View / Manage Amendments', icon: <Pencil className="w-3.5 h-3.5 text-indigo-600" />, group: 'view', groupLabel: 'Contract', requiredPermission: 'printing:read', isVisible: () => contract.status !== 'voided' && contract.status !== 'cancelled', execute: async () => setActiveModal({ type: 'amendments', contractId: contract.id }) });
    defs.push({ id: 'contract.sign', label: 'Signing Ceremony', icon: <ClipboardCheck className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', isVisible: () => contract.status === 'draft' || contract.status === 'active', execute: async () => setActiveModal({ type: 'sign', contractId: contract.id }) });

    // Contract-money actions require the dedicated manage permission (G-22).
    if (contract.status === 'draft') {
      defs.push({ id: 'contract.fund', label: `Allocate Retainer from Wallet (${formatCurrency(contract.totalPrepaidAmount, currency)})`, icon: <DollarSign className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'fund', contractId: contract.id }) });
      if (!contract.customerAcceptanceId) defs.push({ id: 'contract.record-acceptance', label: 'Record Customer Acceptance', icon: <ClipboardCheck className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'acceptance', contractId: contract.id }) });
      defs.push({ id: 'contract.request-activation', label: 'Request Activation Approval', icon: <ClipboardCheck className="w-3.5 h-3.5 text-blue-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'activation', contractId: contract.id }) });
    }
    if (contract.status === 'active') {
      defs.push({ id: 'contract.amend', label: 'Amend Contract', icon: <Pencil className="w-3.5 h-3.5 text-slate-600" />, group: 'admin', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'amend', contractId: contract.id }) });
      defs.push({ id: 'contract.topup', label: 'Top Up Retainer', icon: <DollarSign className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'topup', contractId: contract.id }) });
      defs.push({ id: 'contract.suspend', label: 'Suspend Contract', icon: <Clock className="w-3.5 h-3.5 text-amber-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', execute: async () => { await suspendContract(contract.id, 'Suspended from contract register'); triggerShortcutNotice(`Suspended ${contract.contractNumber}`); } });
      defs.push({ id: 'contract.void', label: 'Void Contract (return retainer to wallet)', icon: <Ban className="w-3.5 h-3.5 text-rose-600" />, group: 'danger', groupLabel: 'Sensitive operations', destructive: true, risk: 'destructive', requiredPermission: 'printing:contracts:manage', isVisible: () => contract.completedAssessments === 0, execute: async () => setActiveModal({ type: 'void', contractId: contract.id }) });
      defs.push({ id: 'contract.cancel', label: 'Cancel Contract', icon: <Ban className="w-3.5 h-3.5 text-rose-600" />, group: 'danger', groupLabel: 'Sensitive operations', destructive: true, risk: 'destructive', requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'cancel', contractId: contract.id }) });
    }
    if (contract.status === 'suspended') {
      defs.push({ id: 'contract.resume', label: 'Resume Contract', icon: <Play className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', execute: async () => { await resumeContract(contract.id); triggerShortcutNotice(`Resumed ${contract.contractNumber}`); } });
      defs.push({ id: 'contract.void', label: 'Void Contract (return retainer to wallet)', icon: <Ban className="w-3.5 h-3.5 text-rose-600" />, group: 'danger', groupLabel: 'Sensitive operations', destructive: true, risk: 'destructive', requiredPermission: 'printing:contracts:manage', isVisible: () => contract.completedAssessments === 0, execute: async () => setActiveModal({ type: 'void', contractId: contract.id }) });
    }
    if (contract.creditBalance && contract.status === 'active') {
      defs.push({ id: 'contract.credit-refund', label: `Refund Unallocated Retainer (${formatCurrency(contract.remainingBalance, currency)})`, icon: <Undo2 className="w-3.5 h-3.5 text-amber-600" />, group: 'danger', groupLabel: 'Sensitive operations', destructive: true, risk: 'destructive', requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'cancel', contractId: contract.id }) });
      defs.push({ id: 'contract.credit-renew', label: 'Renew to Clear Retainer', icon: <Repeat className="w-3.5 h-3.5 text-blue-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'renew', contractId: contract.id }) });
    }
    if (contract.status !== 'active' && contract.status !== 'draft') {
      defs.push({ id: 'contract.activate', label: 'Activate Contract', icon: <Play className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', execute: async () => { await activatePrintingContract(contract.id); triggerShortcutNotice(`Activated ${contract.contractNumber}`); } });
    }
    if (contract.status === 'active' || contract.status === 'completed' || contract.status === 'cancelled') {
      defs.push({ id: 'contract.renew', label: 'Renew Contract', icon: <Repeat className="w-3.5 h-3.5 text-blue-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'renew', contractId: contract.id }) });
    }
    defs.push({ id: 'contract.edit-draft', label: 'Edit Draft', icon: <Pencil className="w-3.5 h-3.5 text-slate-600" />, group: 'admin', groupLabel: 'Contract management', requiredPermission: 'printing:contracts:manage', isVisible: () => contract.status === 'draft', execute: async () => setActiveModal({ type: 'amend', contractId: contract.id }) });
    defs.push({ id: 'contract.add-assessment', label: 'Add Assessment', icon: <Plus className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Assessments', requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'add', contractId: contract.id }) });
    defs.push({ id: 'contract.remove-assessment', label: 'Remove Eligible Assessment', icon: <Trash2 className="w-3.5 h-3.5 text-rose-600" />, group: 'danger', groupLabel: 'Assessments', destructive: true, requiredPermission: 'printing:contracts:manage', execute: async () => setActiveModal({ type: 'remove', contractId: contract.id }) });
    const ctx = buildContractActionContext(contract, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for ${contract.contractNumber}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={contract.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => { const def = action.definition; if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) }); }}
      />
    );
  };

  const renderMilestoneActions = (selectedContract: any, milestone: any, profit: number, canInvoice: boolean, defaultPaperId: any, defaultTonerId: any) => {
    const defs: AdvancedActionDefinition<any>[] = [];
    if (!milestone.linkedInvoiceId && !milestone.backendInvoiceId && canInvoice) defs.push({ id: 'generate-milestone-inv', label: `Generate Assessment Invoice (${formatCurrency(milestone.agreedAmount, currency)})`, icon: <FileText className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Invoice', requiredPermission: 'invoices:write', execute: async () => handleGenerateMilestoneInvoice(selectedContract, milestone) });
    if (milestone.linkedInvoiceId || milestone.backendInvoiceId) defs.push({ id: 'preview-milestone-inv', label: `Preview Linked Invoice${milestone.linkedInvoiceNumber ? ` (${milestone.linkedInvoiceNumber})` : ''}`, icon: <FileText className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Invoice', requiredPermission: 'invoices:read', execute: async () => openLinkedInvoiceByRef({ invoiceId: milestone.linkedInvoiceId, backendInvoiceId: milestone.backendInvoiceId, invoiceNumber: milestone.linkedInvoiceNumber }) });
    defs.push({ id: 'edit-date-costing', label: 'Edit Date & Paper/Toner Calculation', icon: <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-600" />, group: 'admin', groupLabel: 'Assessment', requiredPermission: 'printing:write', execute: async () => setEditTarget({ contractId: selectedContract.id, assessmentNumber: milestone.assessmentNumber, label: milestone.label, scheduledDate: milestone.scheduledDate, agreedAmount: milestone.agreedAmount, rawPaperItemId: milestone.rawPaperItemId || defaultPaperId, rawTonerItemId: milestone.rawTonerItemId || defaultTonerId, estimatedSheets: milestone.estimatedSheets || 0, estimatedImpressions: milestone.estimatedImpressions || 0 }) });
    if (milestone.status === 'pending') defs.push({ id: 'complete-deduct', label: `Mark Completed & Deduct ${formatCurrency(milestone.agreedAmount, currency)}`, icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Assessment', requiredPermission: 'printing:write', execute: async () => { setDeductionTarget({ contractId: selectedContract.id, milestone }); setExamBatchNote(''); } });
    if (milestone.status === 'completed') defs.push({ id: 'preview-assessment-receipt', label: 'Preview Completion Receipt', icon: <ReceiptText className="w-3.5 h-3.5 text-emerald-600" />, group: 'view', groupLabel: 'Assessment', requiredPermission: 'printing:read', execute: async () => openReceiptPreview(selectedContract, milestone) });
    defs.push({ id: 'go-exam-jobs', label: 'Open Examination Jobs', icon: <BookOpen className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Assessment', requiredPermission: 'printing:read', execute: async () => setCurrentView('examinations') });
    defs.push({ id: 'copy-milestone', label: 'Copy Milestone Summary', icon: <Copy className="w-3.5 h-3.5" />, group: 'admin', groupLabel: 'Other', requiredPermission: 'printing:read', execute: async () => { await navigator.clipboard?.writeText(`${selectedContract.contractNumber} - ${milestone.label} (${milestone.scheduledDate} · Amt ${formatCurrency(milestone.agreedAmount, currency)} · Profit ${formatCurrency(profit, currency)})`); triggerShortcutNotice('Copied assessment milestone details'); } });
    const ctx = buildContractActionContext(milestone, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for Assessment #${milestone.assessmentNumber}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={milestone.id || milestone.assessmentNumber}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => { const def = action.definition; if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) }); }}
      />
    );
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            School Printing Contracts & Assessment Profit Schedule
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Manage lump-sum school agreements (2 to 5 assessments), each with a specific scheduled date, prepaid deduction, and paper & toner profit calculation.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveModal({ type: 'reconciliation', contractId: selectedContractId })}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-semibold transition-colors"
          >
            <Landmark className="w-4 h-4" />
            <span>Reconciliation</span>
          </button>
          <button
            onClick={() => setIsNewContractOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-xs transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" />
            <span>New Prepaid School Contract</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Total Contract Deposits
            </div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {formatCurrency(totalContracted, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {printingContracts.length} school agreements
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Remaining Prepaid Balance
            </div>
            <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400 mt-1 tabular-nums">
              {formatCurrency(totalRemainingRetainer, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {selectedContract?.liabilityAccountId ? `Account #${selectedContract.liabilityAccountId} · ` : ''}
              {totalCompletedAssessments}/{totalAgreedAssessments} completed
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
            <Landmark className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Paper & Toner Budget
            </div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {formatCurrency(totalContractMaterialCost, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Driven from Raw Material costs
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              Projected Contract Profit
            </div>
            <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1 tabular-nums">
              {formatCurrency(totalContractProfit, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-mono">
              {totalContracted > 0 ? ((totalContractProfit / totalContracted) * 100).toFixed(1) : '0.0'}% contract margin
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <TrendingUp className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Contracts Register Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-bold text-sm text-slate-900 dark:text-white">
            Active & Historical School Contracts
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={contractSearch}
              onChange={e => {
                setContractSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search contract #, school or title"
              className="w-56 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] text-slate-900 outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <select
              value={statusFilter}
              onChange={e => {
                setStatusFilter(e.target.value as 'all' | PrintingContract['status']);
                setPage(1);
              }}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] text-slate-900 outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="completed">Completed</option>
              <option value="exhausted">Exhausted</option>
              <option value="cancelled">Cancelled</option>
              <option value="voided">Voided</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-3">CONTRACT #</th>
                <th className="px-4 py-3">SCHOOL / AGREEMENT TITLE</th>
                <th className="px-4 py-3 text-center">ASSESSMENTS</th>
                <th className="px-4 py-3 text-right">PREPAID SUM</th>
                <th className="px-4 py-3 text-right">DEDUCTED</th>
                <th className="px-4 py-3 text-right">REMAINING BAL</th>
                <th className="px-4 py-3 text-right">EST. NET PROFIT</th>
                <th className="px-4 py-3 text-center">STATUS</th>
                <th className="px-4 py-3 text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {pagedContracts.map(contract => {
                const school = customers.find(c => String(c.id) === String(contract.schoolCustomerId));
                const deducted = contract.totalPrepaidAmount - contract.remainingBalance;
                const nextPending = contract.assessments.find(a => a.status === 'pending');
                const isSelected = selectedContract?.id === contract.id;
                const contractProfit = contract.assessments.reduce(
                  (s, a) => s + (a.profit ?? a.agreedAmount - (a.totalCost || 0)),
                  0
                );

                return (
                  <tr
                    key={contract.id}
                    onClick={() => setSelectedContractId(contract.id)}
                    className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-850/50 ${
                      isSelected ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''
                    }`}
                  >
                    <td className="px-4 py-3 font-bold text-slate-900 dark:text-white whitespace-nowrap">
                      {contract.contractNumber}
                    </td>
                    <td className="px-4 py-3 font-sans">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {school?.companyName || 'School'}
                      </div>
                      <div className="text-[11px] text-slate-500">{contract.title}</div>
                    </td>
                    <td className="px-4 py-3 text-center font-bold tabular-nums text-slate-800 dark:text-slate-200">
                      {contract.completedAssessments} / {contract.totalAssessments}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {formatCurrency(contract.totalPrepaidAmount, currency)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-blue-600 dark:text-blue-400 font-semibold">
                      {formatCurrency(deducted, currency)}
                    </td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums text-slate-900 dark:text-white">
                      {formatCurrency(contract.remainingBalance, currency)}
                    </td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(contractProfit, currency)}
                    </td>
                    <td className="px-4 py-3 text-center font-sans text-[11px] font-semibold">
                      {contract.creditBalance && (
                        <span className="mr-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          Credit balance
                        </span>
                      )}
                      {contract.status === 'active' ? (
                        <span className="text-emerald-700 dark:text-emerald-400">Active</span>
                      ) : contract.status === 'draft' ? (
                        <span className="text-blue-600 dark:text-blue-400">Draft</span>
                      ) : contract.status === 'suspended' ? (
                        <span className="text-amber-600 dark:text-amber-400">Suspended</span>
                      ) : contract.status === 'cancelled' ? (
                        <span className="text-rose-600 dark:text-rose-400">Cancelled</span>
                      ) : contract.status === 'voided' ? (
                        <span className="text-slate-500 line-through">Voided</span>
                      ) : (
                        <span className="text-slate-500">Completed / Exhausted</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-sans" onClick={e => e.stopPropagation()}>
                      {renderContractActions(contract, nextPending)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filteredContracts.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-[11px] text-slate-500 dark:border-slate-800">
            <span>
              Showing {(currentPage - 1) * PAGE_SIZE + 1}–
              {Math.min(currentPage * PAGE_SIZE, filteredContracts.length)} of {filteredContracts.length}
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="rounded border border-slate-300 px-2 py-1 font-semibold disabled:opacity-40 dark:border-slate-700"
              >
                Prev
              </button>
              <span className="font-mono">
                {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="rounded border border-slate-300 px-2 py-1 font-semibold disabled:opacity-40 dark:border-slate-700"
              >
                Next
              </button>
            </span>
          </div>
        )}
      </div>

      {/* Selected Contract Assessment Drawdown & Profitability Schedule */}
      {selectedContract && (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-[11px] font-mono font-bold text-slate-500">
                {selectedContract.contractNumber} · {selectedContract.academicYear} Academic Year · {selectedContract.startDate} to {selectedContract.endDate}
              </div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white mt-0.5">
                {customers.find(c => c.id === selectedContract.schoolCustomerId)?.companyName} — Dated Assessment & Profit Schedule
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => openContractPreview(selectedContract)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-semibold transition-colors"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>Preview Contract</span>
              </button>

              {/* Activation checklist: Accepted / Funded / Approved (G-03). */}
              {selectedContract.status === 'draft' && (
                <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-[11px] font-sans dark:border-slate-700 dark:bg-slate-800">
                  <span
                    className={
                      selectedContract.customerAcceptanceId
                        ? 'text-emerald-600 font-bold'
                        : 'text-slate-500'
                    }
                  >
                    {selectedContract.customerAcceptanceId ? '✔ Accepted' : '○ Not accepted'}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span
                    className={
                      (selectedContract.allocatedAmount ?? 0) >= selectedContract.totalPrepaidAmount
                        ? 'text-emerald-600 font-bold'
                        : 'text-slate-500'
                    }
                  >
                    {(selectedContract.allocatedAmount ?? 0) >= selectedContract.totalPrepaidAmount
                      ? '✔ Funded'
                      : '○ Not funded'}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">○ Approval pending</span>
                  <button
                    type="button"
                    onClick={() => setActiveModal({ type: 'fund', contractId: selectedContract.id })}
                    className="ml-1 rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-emerald-500"
                  >
                    Allocate
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveModal({ type: 'activation', contractId: selectedContract.id })}
                    className="rounded bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-blue-500"
                  >
                    Request Approval
                  </button>
                </div>
              )}

              {canUploadAttachment && (
                <button
                  type="button"
                  onClick={() => setIsAttachModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 text-xs font-semibold transition-colors"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                  <span>Attach Contract File</span>
                </button>
              )}

              {!selectedContract.depositInvoiceId && !selectedContract.depositBackendInvoiceId ? (
                canInvoice && (
                  <button
                    type="button"
                    disabled={contractActionBusy}
                    onClick={() => handleGenerateRetainerInvoice(selectedContract)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold shadow-xs transition-all"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>{contractActionBusy ? 'Generating...' : 'Generate Retainer Invoice'}</span>
                  </button>
                )
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    openLinkedInvoiceByRef({
                      invoiceId: selectedContract.depositInvoiceId,
                      backendInvoiceId: selectedContract.depositBackendInvoiceId,
                      invoiceNumber: selectedContract.depositInvoiceNumber,
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 text-xs font-semibold transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>
                    Preview Retainer Invoice
                    {selectedContract.depositInvoiceNumber ? ` (${selectedContract.depositInvoiceNumber})` : ''}
                  </span>
                </button>
              )}

              <div className="flex items-center gap-6 font-mono ml-2">
                <div className="text-right">
                  <div className="text-[10px] text-slate-500 uppercase font-sans font-bold">
                    Remaining Prepaid Fund
                  </div>
                  <div className="text-lg font-bold text-blue-600 dark:text-blue-400 tabular-nums">
                    {formatCurrency(selectedContract.remainingBalance, currency)}{' '}
                    <span className="text-xs font-normal text-slate-400">
                      / {formatCurrency(selectedContract.totalPrepaidAmount, currency)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Drawdown Progress Bar */}
          <div className="px-5 py-3 bg-slate-50 dark:bg-slate-850 border-b border-slate-200 dark:border-slate-800">
            {selectedContract.creditBalance && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                <span>
                  All assessments completed but{' '}
                  <strong className="font-mono">
                    {formatCurrency(selectedContract.remainingBalance, currency)}
                  </strong>{' '}
                  of the retainer is unallocated. Refund it to the school or renew the contract.
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveModal({ type: 'cancel', contractId: selectedContract.id })}
                    className="rounded bg-amber-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-amber-500"
                  >
                    Refund
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveModal({ type: 'renew', contractId: selectedContract.id })}
                    className="rounded bg-blue-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-blue-500"
                  >
                    Renew
                  </button>
                </span>
              </div>
            )}
            <div className="flex justify-between text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              <span>
                Assessments Completed: {selectedContract.completedAssessments} of{' '}
                {selectedContract.totalAssessments}
              </span>
              <span className="font-mono tabular-nums">
                {Math.round(
                  ((selectedContract.totalPrepaidAmount - selectedContract.remainingBalance) /
                    (selectedContract.totalPrepaidAmount || 1)) *
                    100
                )}
                % Consumed
              </span>
            </div>
            <div className="w-full h-2.5 bg-slate-200 dark:bg-slate-800 rounded overflow-hidden">
              <div
                className="h-full bg-emerald-600 transition-all duration-300"
                style={{
                  width: `${Math.min(
                    100,
                    ((selectedContract.totalPrepaidAmount - selectedContract.remainingBalance) /
                      (selectedContract.totalPrepaidAmount || 1)) *
                      100
                  )}%`,
                }}
              />
            </div>
          </div>

          {/* Milestones Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">ASSESSMENT MILESTONE</th>
                  <th className="px-4 py-3">SCHEDULED DATE</th>
                  <th className="px-4 py-3 text-right">PAPER + TONER CALCULATION</th>
                  <th className="px-4 py-3 text-right">AGREED AMOUNT</th>
                  <th className="px-4 py-3 text-right">ASSESSMENT PROFIT</th>
                  <th className="px-4 py-3 text-center">STATUS</th>
                  <th className="px-4 py-3 text-right">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                {selectedContract.assessments.map(milestone => {
                  const actuals = getAssessmentActualStats(
                    selectedContract.id,
                    milestone.assessmentNumber
                  );
                  const usedCost =
                    actuals.papersCount > 0 ? actuals.totalCost : milestone.totalCost || 0;
                  const usedSheets =
                    actuals.papersCount > 0 ? actuals.sheets : milestone.estimatedSheets || 0;
                  const usedImps =
                    actuals.papersCount > 0
                      ? actuals.impressions
                      : milestone.estimatedImpressions || 0;
                  const usedPaperCost =
                    actuals.papersCount > 0 ? actuals.paperCost : milestone.paperCost || 0;
                  const usedTonerCost =
                    actuals.papersCount > 0 ? actuals.tonerCost : milestone.tonerCost || 0;
                  const profit = Math.round((milestone.agreedAmount - usedCost) * 100) / 100;
                  const marginPct =
                    milestone.agreedAmount > 0 ? (profit / milestone.agreedAmount) * 100 : 0;

                  return (
                    <tr
                      key={milestone.assessmentNumber}
                      className="hover:bg-slate-50 dark:hover:bg-slate-850/50"
                    >
                      <td className="px-4 py-3 font-bold text-slate-500">
                        #{milestone.assessmentNumber}
                      </td>
                      <td className="px-4 py-3 font-sans">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {milestone.label}
                        </div>
                        {milestone.examBatchNote && (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {milestone.examBatchNote}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-semibold text-slate-900 dark:text-white inline-flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5 text-blue-600" />
                          <span>{milestone.scheduledDate}</span>
                        </div>
                        {milestone.completedDate && (
                          <div className="text-[10px] text-emerald-600 dark:text-emerald-400">
                            Completed: {milestone.completedDate}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-amber-700 dark:text-amber-400">
                        <div className="font-bold">{formatCurrency(usedCost, currency)}</div>
                        <div className="text-[10px] text-slate-500">
                          {usedSheets.toLocaleString()} shts ({formatCurrency(usedPaperCost, currency)}) ·{' '}
                          {usedImps.toLocaleString()} imp ({formatCurrency(usedTonerCost, currency)})
                        </div>
                        {actuals.papersCount > 0 && (
                          <div className="text-[10px] text-indigo-600 dark:text-indigo-400 font-sans">
                            Actual from {actuals.papersCount} linked exam job(s)
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-bold tabular-nums text-slate-900 dark:text-white">
                        {formatCurrency(milestone.agreedAmount, currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-bold tabular-nums">
                        <div
                          className={
                            profit >= 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }
                        >
                          {formatCurrency(profit, currency)}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {marginPct.toFixed(1)}% margin
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center font-sans text-[11px]">
                        {milestone.status === 'completed' ? (
                          <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Deducted
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-semibold text-amber-600 dark:text-amber-400">
                            <Clock className="w-3.5 h-3.5" /> Pending
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-sans">
                        {renderMilestoneActions(selectedContract, milestone, profit, canInvoice, defaultPaperId, defaultTonerId)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

{/* New Prepaid School Contract Modal */}
      {isNewContractOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-5xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[94vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-amber-400" />
                <h2 className="font-bold text-base">New Printing Contract</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsNewContractOpen(false)}
                className="p-1 text-white/80 hover:text-white"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateContract} className="p-5 space-y-6 text-xs overflow-y-auto">
              {/* Title */}
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">
                  Title <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. 2026 Term 2 examination printing agreement"
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm outline-none"
                  required
                />
              </div>

              {/* Parties & Type */}
              <section className="space-y-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Parties &amp; Type</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Customer <span className="text-rose-500">*</span></label>
                    <select
                      value={schoolCustomerId}
                      onChange={e => setSchoolCustomerId(e.target.value)}
                      className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                      required
                    >
                      {customers.map(c => (
                        <option key={c.id} value={c.id}>{c.companyName}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">School zone</label>
                    <input type="text" value={schoolZone} onChange={e => setSchoolZone(e.target.value)} placeholder="e.g. Mankhamba ZONE" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Customer phone</label>
                    <input type="text" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="e.g. 265899233626" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Academic year</label>
                    <input type="text" value={academicYear} onChange={e => setAcademicYear(e.target.value)} placeholder="e.g. 2026/27 (blank = from period)" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono outline-none" />
                  </div>
                </div>
              </section>

              {/* Candidature */}
              <section className="space-y-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Candidature</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Expected candidates</label>
                    <input type="number" min="0" value={expectedCandidates} onChange={e => setExpectedCandidates(parseInt(e.target.value) || 0)} placeholder="e.g. 450" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Sittings</label>
                    <input type="text" value={sittings} onChange={e => setSittings(e.target.value)} placeholder="e.g. Once Off / Morning + Afternoon" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                </div>
              </section>

              {/* Pricing Rules */}
              <section className="space-y-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Pricing Rules</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Pricing model</label>
                    <select value={pricingModel} onChange={e => setPricingModel(e.target.value as '' | 'per_candidate')} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none">
                      <option value="">Select…</option>
                      <option value="per_candidate">Charge per candidate</option>
                    </select>
                  </div>
                  {pricingModel === 'per_candidate' && (
                    <div className="space-y-1">
                      <label className="font-semibold text-slate-700 dark:text-slate-300">Charge per candidate ({currencySymbol})</label>
                      <input type="number" step="0.01" min="0" value={chargePerCandidate} onChange={e => setChargePerCandidate(parseFloat(e.target.value) || 0)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono outline-none" />
                    </div>
                  )}
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Tax handling</label>
                    <input type="text" value={taxHandling} onChange={e => setTaxHandling(e.target.value)} placeholder="e.g. VAT inclusive" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Discount</label>
                    <input type="text" value={discount} onChange={e => setDiscount(e.target.value)} placeholder="e.g. 5% for 500+ candidates" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Urgent fee</label>
                    <input type="text" value={urgentFee} onChange={e => setUrgentFee(e.target.value)} placeholder="e.g. 10% express surcharge" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Pricing notes</label>
                  <input type="text" value={pricingNotes} onChange={e => setPricingNotes(e.target.value)} placeholder="Reprint, over-run rules…" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                </div>
              </section>

              {/* Commercials & Period */}
              <section className="space-y-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Commercials &amp; Period</h3>
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase font-bold">
                      <tr>
                        <th className="px-2 py-2">Assessment item</th>
                        <th className="px-2 py-2">Grade</th>
                        <th className="px-2 py-2">Subject</th>
                        <th className="px-2 py-2 text-right">Qty</th>
                        <th className="px-2 py-2 text-right">Unit price</th>
                        <th className="px-2 py-2 text-right">Amount</th>
                        <th className="px-2 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {lineItems.map(li => (
                        <tr key={li.id} className="border-t border-slate-100 dark:border-slate-800">
                          <td className="px-2 py-1.5"><input type="text" value={li.item} onChange={e => setLineItems(prev => prev.map(x => x.id === li.id ? { ...x, item: e.target.value } : x))} placeholder="e.g. Term 2 Grade 7 Mathematics" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 outline-none" /></td>
                          <td className="px-2 py-1.5 w-20"><input type="text" value={li.grade} onChange={e => setLineItems(prev => prev.map(x => x.id === li.id ? { ...x, grade: e.target.value } : x))} placeholder="—" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 outline-none" /></td>
                          <td className="px-2 py-1.5 w-28"><input type="text" value={li.subject} onChange={e => setLineItems(prev => prev.map(x => x.id === li.id ? { ...x, subject: e.target.value } : x))} placeholder="—" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 outline-none" /></td>
                          <td className="px-2 py-1.5 w-16"><input type="number" min="0" value={li.qty} onChange={e => setLineItems(prev => prev.map(x => x.id === li.id ? { ...x, qty: parseInt(e.target.value) || 0 } : x))} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-right outline-none" /></td>
                          <td className="px-2 py-1.5 w-24"><input type="number" step="0.01" min="0" value={li.unitPrice} onChange={e => setLineItems(prev => prev.map(x => x.id === li.id ? { ...x, unitPrice: parseFloat(e.target.value) || 0 } : x))} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-right outline-none" /></td>
                          <td className="px-2 py-1.5 text-right font-bold text-slate-900 dark:text-white">{formatCurrency(lineAmount(li), currency)}</td>
                          <td className="px-2 py-1.5 text-right">
                            <button type="button" onClick={() => setLineItems(prev => prev.filter(x => x.id !== li.id))} disabled={lineItems.length <= 2} className="text-rose-600 disabled:opacity-30" aria-label="Remove item">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between">
                  <button type="button" onClick={() => setLineItems(prev => [...prev, newLine()])} disabled={lineItems.length >= 5} className="inline-flex items-center gap-1 text-blue-600 font-semibold disabled:opacity-40">
                    <Plus className="w-3.5 h-3.5" /> Add item
                  </button>
                  <div className="font-mono text-sm">
                    Entitlement {lineItems.length} · Contract total{' '}
                    <span className="font-bold text-emerald-600 dark:text-emerald-400">{formatCurrency(effectiveContractTotal, currency)}</span>
                    {candidateTotal > 0 && (
                      <span className="ml-1 text-[10px] font-normal text-slate-500">
                        ({expectedCandidates} × {formatCurrency(chargePerCandidate, currency)})
                      </span>
                    )}
                  </div>
                </div>
                {!lineItemsValid && (
                  <p className="text-[11px] font-semibold text-rose-600">A contract needs between 2 and 5 line items.</p>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Start date</label>
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" required />
                  </div>
                  <div className="sm:col-span-2 space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">End date (may cross FY)</label>
                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" required />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Deposit bank account</label>
                  <select value={depositBankAccountId} onChange={e => setDepositBankAccountId(e.target.value)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" required>
                    {bankAccounts.map(a => (
                      <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                    ))}
                  </select>
                </div>
              </section>

              {/* Printing Specification */}
              <section className="space-y-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Printing Specification</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Paper size</label>
                    <select value={paperSize} onChange={e => setPaperSize(e.target.value)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none">
                      <option value="">Select…</option>
                      {['A4', 'A3', 'A5', 'Legal', 'Letter'].map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Paper type</label>
                    <input type="text" value={paperType} onChange={e => setPaperType(e.target.value)} placeholder="e.g. Bond, Art, Manilla" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Paper weight (gsm)</label>
                    <input type="text" value={paperWeight} onChange={e => setPaperWeight(e.target.value)} placeholder="e.g. 80" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Colour</label>
                    <select value={colour} onChange={e => setColour(e.target.value)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none">
                      <option value="">Select…</option>
                      {['Black & White', 'Full Colour', 'Two Colour'].map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Sides</label>
                    <select value={sides} onChange={e => setSides(e.target.value)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none">
                      <option value="">Select…</option>
                      {['Single-Sided', 'Duplex'].map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Orientation</label>
                    <select value={orientation} onChange={e => setOrientation(e.target.value)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none">
                      <option value="">Select…</option>
                      {['Portrait', 'Landscape'].map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Pages per copy</label>
                    <input type="number" min="0" value={pagesPerCopy} onChange={e => setPagesPerCopy(parseInt(e.target.value) || 0)} placeholder="e.g. 8" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Copies</label>
                    <input type="number" min="0" value={copies} onChange={e => setCopies(parseInt(e.target.value) || 0)} placeholder="e.g. 500" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Finishing</label>
                    <input type="text" value={finishing} onChange={e => setFinishing(e.target.value)} placeholder="e.g. Stapling, Binding, Lamination" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Packaging (print)</label>
                    <input type="text" value={packaging} onChange={e => setPackaging(e.target.value)} placeholder="e.g. Boxed per class" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Specification notes</label>
                  <input type="text" value={specNotes} onChange={e => setSpecNotes(e.target.value)} placeholder="Artwork, proofing, quality…" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                </div>
              </section>

              {/* Delivery Terms */}
              <section className="space-y-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Delivery Terms</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Delivery method</label>
                    <select value={deliveryMethod} onChange={e => setDeliveryMethod(e.target.value)} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none">
                      <option value="">Select…</option>
                      {['School pickup', 'Delivered to school', 'Courier'].map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Delivery timeline</label>
                    <input type="text" value={deliveryTimeline} onChange={e => setDeliveryTimeline(e.target.value)} placeholder="e.g. 3 days before exam date" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Delivery address</label>
                    <input type="text" value={deliveryAddress} onChange={e => setDeliveryAddress(e.target.value)} placeholder="School / collection point address" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Delivery packaging</label>
                    <input type="text" value={deliveryPackaging} onChange={e => setDeliveryPackaging(e.target.value)} placeholder="e.g. Sealed per subject" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300">Delivery notes</label>
                    <input type="text" value={deliveryNotes} onChange={e => setDeliveryNotes(e.target.value)} placeholder="Contact person, proof of delivery…" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none" />
                  </div>
                </div>
              </section>

              {/* Terms & Notes */}
              <section className="space-y-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Terms &amp; Notes</h3>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">General terms</label>
                  <textarea value={generalTerms} onChange={e => setGeneralTerms(e.target.value)} rows={2} placeholder="General contract terms — specifics live in the sections above" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs resize-none outline-none" />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Notes</label>
                  <textarea value={contractNotes} onChange={e => setContractNotes(e.target.value)} rows={2} placeholder="Any additional notes" className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs resize-none outline-none" />
                </div>
              </section>

              <div className="sticky bottom-0 -mx-5 -mb-5 px-5 py-3 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
                <button type="button" onClick={() => setIsNewContractOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300">
                  Cancel
                </button>
                <button type="submit" disabled={!lineItemsValid || effectiveContractTotal <= 0} className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold shadow-sm">
                  Save Contract
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Assessment Specific Date & Paper/Toner Calculation Modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">
                Edit Assessment #{editTarget.assessmentNumber} Date & Costing
              </span>
              <button
                onClick={() => setEditTarget(null)}
                className="p-1 text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveAssessmentEdit} className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Assessment Label</label>
                  <input
                    type="text"
                    value={editTarget.label}
                    onChange={e => setEditTarget({ ...editTarget, label: e.target.value })}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 outline-none"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Specific Scheduled Date</label>
                  <input
                    type="date"
                    value={editTarget.scheduledDate}
                    onChange={e => setEditTarget({ ...editTarget, scheduledDate: e.target.value })}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 font-mono outline-none"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Paper Raw Material</label>
                  <select
                    value={editTarget.rawPaperItemId}
                    onChange={e => setEditTarget({ ...editTarget, rawPaperItemId: e.target.value })}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 outline-none"
                  >
                    {rawMaterials.map(rm => (
                      <option key={rm.id} value={rm.id}>
                        {rm.sku} ({currencySymbol}{getRawUsageUnitCost(rm.id).toFixed(4)}/{rm.usageUnit || 'Unit'})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Estimated Sheets</label>
                  <input
                    type="number"
                    min="0"
                    value={editTarget.estimatedSheets}
                    onChange={e =>
                      setEditTarget({
                        ...editTarget,
                        estimatedSheets: parseInt(e.target.value) || 0,
                      })
                    }
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 font-mono text-right outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Toner Raw Material</label>
                  <select
                    value={editTarget.rawTonerItemId}
                    onChange={e => setEditTarget({ ...editTarget, rawTonerItemId: e.target.value })}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 outline-none"
                  >
                    {rawMaterials.map(rm => (
                      <option key={rm.id} value={rm.id}>
                        {rm.sku} ({currencySymbol}{getRawUsageUnitCost(rm.id).toFixed(4)}/{rm.usageUnit || 'Unit'})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Estimated Impressions</label>
                  <input
                    type="number"
                    min="0"
                    value={editTarget.estimatedImpressions}
                    onChange={e =>
                      setEditTarget({
                        ...editTarget,
                        estimatedImpressions: parseInt(e.target.value) || 0,
                      })
                    }
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 font-mono text-right outline-none"
                  />
                </div>
              </div>

              {(() => {
                const pC = editTarget.estimatedSheets * getRawUsageUnitCost(editTarget.rawPaperItemId);
                const tC = editTarget.estimatedImpressions * getRawUsageUnitCost(editTarget.rawTonerItemId);
                const totC = pC + tC;
                const prof = editTarget.agreedAmount - totC;
                return (
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 space-y-1 font-mono">
                    <div className="flex justify-between">
                      <span className="font-sans text-slate-500">Paper + Toner Cost:</span>
                      <span className="font-bold text-amber-700 dark:text-amber-400">
                        {formatCurrency(totC, currency)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-sans text-slate-500">Agreed Assessment Amount:</span>
                      <span className="font-bold">{formatCurrency(editTarget.agreedAmount, currency)}</span>
                    </div>
                    <div className="flex justify-between border-t border-slate-200 dark:border-slate-700 pt-1 text-emerald-600 dark:text-emerald-400 font-bold">
                      <span className="font-sans">Calculated Assessment Profit:</span>
                      <span>{formatCurrency(prof, currency)}</span>
                    </div>
                  </div>
                );
              })()}

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditTarget(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold"
                >
                  Save Assessment Calculation
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Complete Assessment & Deduct Agreed Sum Modal */}
      {deductionTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Complete Assessment & Deduct Sum</span>
              <button
                onClick={() => setDeductionTarget(null)}
                className="p-1 text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleConfirmAssessmentDeduction} className="p-5 space-y-4 text-xs">
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 space-y-1">
                <div className="font-bold text-slate-900 dark:text-white text-sm">
                  {deductionTarget.milestone.label}
                </div>
                <div className="text-[11px] font-mono text-slate-500">
                  Scheduled Date: {deductionTarget.milestone.scheduledDate}
                </div>
                <div className="text-slate-500 pt-1">
                  Agreed deduction from school prepaid lump sum:
                </div>
                <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 tabular-nums">
                  -{formatCurrency(deductionTarget.milestone.agreedAmount, currency)}
                </div>
                <div className="text-[11px] font-mono text-slate-600 dark:text-slate-300 pt-1">
                  Material Cost: {formatCurrency(deductionTarget.milestone.totalCost || 0, currency)} · Est. Profit:{' '}
                  <strong className="text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(
                      deductionTarget.milestone.profit ??
                        deductionTarget.milestone.agreedAmount -
                          (deductionTarget.milestone.totalCost || 0),
                      currency
                    )}
                  </strong>
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">
                  Completed Examination Batch Note
                </label>
                <textarea
                  value={examBatchNote}
                  onChange={e => setExamBatchNote(e.target.value)}
                  placeholder="e.g. Delivered 1,240 booklets across Form 1–4; signed off by Senior Master."
                  rows={3}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md p-2.5 text-xs outline-none"
                />
              </div>

              <div className="text-[11px] text-slate-500">
                Accounting automatically debits #2250 Unearned Contract Revenue and credits #4010 Printing Sales Revenue.
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setDeductionTarget(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
                >
                  Confirm & Deduct Amount
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Attach Contract Document Modal */}
      {isAttachModalOpen && selectedContract && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-amber-400" />
                <span className="font-bold text-sm">
                  Attach File to {selectedContract.contractNumber}
                </span>
              </div>
              <button
                onClick={() => setIsAttachModalOpen(false)}
                className="p-1 text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAttachContractFile} className="p-5 space-y-4 text-xs">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">
                  Signed Agreement / Supporting File
                </label>
                <input
                  type="file"
                  onChange={e => setAttachFile(e.target.files?.[0] || null)}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Notes</label>
                <input
                  type="text"
                  value={attachNotes}
                  onChange={e => setAttachNotes(e.target.value)}
                  placeholder={`Contract ${selectedContract.contractNumber} signed copy`}
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAttachModalOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!attachFile || attachUploading}
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold"
                >
                  {attachUploading ? 'Uploading...' : 'Upload to All Documents'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Contract action modals (ERP-grade) */}
      {activeModal?.type === 'amend' && activeContract && (
        <AmendContractModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'add' && activeContract && (
        <AddAssessmentModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'remove' && activeContract && (
        <RemoveAssessmentModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'fund' && activeContract && (
        <FundContractModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'activation' && activeContract && (
        <ActivationRequestModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'cancel' && activeContract && (
        <CancelContractModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'topup' && activeContract && (
        <TopUpContractModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'renew' && activeContract && (
        <RenewContractModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'acceptance' && activeContract && (
        <RecordAcceptanceModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'void' && activeContract && (
        <VoidContractModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'amendments' && activeContract && (
        <AmendmentsModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'sign' && activeContract && (
        <SignContractModal contract={activeContract} onClose={() => setActiveModal(null)} />
      )}
      {activeModal?.type === 'reconciliation' && (
        <ReconciliationView onClose={() => setActiveModal(null)} />
      )}
      {activeContract &&
        activeModal &&
        (activeModal.type === 'financials' ||
          activeModal.type === 'wallet' ||
          activeModal.type === 'history' ||
          activeModal.type === 'progress') && (
          <ContractInfoModal
            mode={activeModal.type}
            contract={activeContract}
            onClose={() => setActiveModal(null)}
          />
        )}
    </div>
  );
};
