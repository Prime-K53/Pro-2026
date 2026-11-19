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
} from '../modals/ContractActionModals';
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
} from 'lucide-react';
import {
  buildPaperStockFromInventoryItem,
  buildTonerSpecFromInventoryItem,
  calculateContractMilestoneEstimate,
} from '../../server/services/printingWorkflows';
import type { TonerMachineSpec } from '../../server/services/tonerCalc';

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
    cancelPrintingContract,
    activatePrintingContract,
    renewPrintingContract,
    amendPrintingContract,
    addContractAssessment,
    removeContractAssessment,
    generateAndSyncWorkflowInvoice,
    getInvoiceById,
    openDocumentPreview,
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

  // Contract action modal (amend / add / remove / financials / wallet / history / progress)
  type ContractModalState =
    | {
        type: 'amend' | 'add' | 'remove' | 'financials' | 'wallet' | 'history' | 'progress';
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
  const customMismatch = !splitEvenly && Math.abs(draftSum - totalPrepaidAmount) > 0.05;

  const handleCreateContract = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!schoolCustomerId || totalPrepaidAmount <= 0 || customMismatch) return;

    const created = await addPrintingContract({
      schoolCustomerId,
      title,
      academicYear,
      startDate,
      endDate,
      totalPrepaidAmount,
      totalAssessments,
      depositBankAccountId,
      assessments: draftAssessmentsList,
      notes: contractNotes,
    });

    setSelectedContractId(created.id);
    setIsNewContractOpen(false);
    triggerShortcutNotice(
      `Created prepaid contract ${created.contractNumber} (${totalAssessments} dated assessments · ${formatCurrency(totalPrepaidAmount, currency)})`
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
    const school = customers.find(c => c.id === contract.schoolCustomerId);
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
    const school = customers.find(c => c.id === contract.schoolCustomerId);
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
    const school = customers.find(c => c.id === contract.schoolCustomerId);
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
      await documentsApi.uploadAttachment({
        fileName: attachFile.name,
        contentType: attachFile.type || 'application/octet-stream',
        entityType: 'printing_contract',
        entityId: 1,
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
    if (contract.status === 'active') {
      defs.push({ id: 'contract.amend', label: 'Amend Contract', icon: <Pencil className="w-3.5 h-3.5 text-slate-600" />, group: 'admin', groupLabel: 'Contract management', requiredPermission: 'printing:write', execute: async () => setActiveModal({ type: 'amend', contractId: contract.id }) });
      defs.push({ id: 'contract.cancel', label: 'Cancel Contract', icon: <Ban className="w-3.5 h-3.5 text-rose-600" />, group: 'danger', groupLabel: 'Sensitive operations', destructive: true, risk: 'destructive', requiredPermission: 'printing:write', confirmation: { title: `Cancel ${contract.contractNumber}`, message: 'Cancel this contract.', confirmLabel: 'Cancel Contract', destructive: true }, execute: async () => { cancelPrintingContract(contract.id, 'Cancelled from contract register'); triggerShortcutNotice(`Cancelled ${contract.contractNumber}`); } });
    }
    if (contract.status !== 'active') {
      defs.push({ id: 'contract.activate', label: 'Activate Contract', icon: <Play className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:write', execute: async () => { activatePrintingContract(contract.id); triggerShortcutNotice(`Activated ${contract.contractNumber}`); } });
      defs.push({ id: 'contract.renew', label: 'Renew Contract', icon: <Repeat className="w-3.5 h-3.5 text-blue-600" />, group: 'process', groupLabel: 'Contract management', requiredPermission: 'printing:write', execute: async () => { renewPrintingContract(contract.id); triggerShortcutNotice(`Renewed ${contract.contractNumber}`); } });
    }
    defs.push({ id: 'contract.edit-draft', label: 'Edit Draft', icon: <Pencil className="w-3.5 h-3.5 text-slate-600" />, group: 'admin', groupLabel: 'Contract management', requiredPermission: 'printing:write', isVisible: () => contract.status !== 'active', execute: async () => setActiveModal({ type: 'amend', contractId: contract.id }) });
    defs.push({ id: 'contract.add-assessment', label: 'Add Assessment', icon: <Plus className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Assessments', requiredPermission: 'printing:write', execute: async () => setActiveModal({ type: 'add', contractId: contract.id }) });
    defs.push({ id: 'contract.remove-assessment', label: 'Remove Eligible Assessment', icon: <Trash2 className="w-3.5 h-3.5 text-rose-600" />, group: 'danger', groupLabel: 'Assessments', destructive: true, requiredPermission: 'printing:write', execute: async () => setActiveModal({ type: 'remove', contractId: contract.id }) });
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

        <button
          onClick={() => setIsNewContractOpen(true)}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-xs transition-all active:scale-95"
        >
          <Plus className="w-4 h-4" />
          <span>New Prepaid School Contract</span>
        </button>
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
              Account #2250 · {totalCompletedAssessments}/{totalAgreedAssessments} completed
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
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="font-bold text-sm text-slate-900 dark:text-white">
            Active & Historical School Contracts
          </h2>
          <span className="text-[11px] text-slate-500">
            Select a contract row to view specific assessment dates & real profit
          </span>
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
              {printingContracts.map(contract => {
                const school = customers.find(c => c.id === contract.schoolCustomerId);
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
                      {contract.status === 'active' ? (
                        <span className="text-emerald-700 dark:text-emerald-400">Active</span>
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
          <div className="w-full max-w-4xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-amber-400" />
                <h2 className="font-bold text-base">
                  New Prepaid School Printing Contract (Dated Assessments & Costing)
                </h2>
              </div>
              <button
                onClick={() => setIsNewContractOpen(false)}
                className="p-1 text-white/80 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateContract} className="p-5 space-y-4 text-xs overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Deposit Bank Account</label>
                  <select
                    value={depositBankAccountId}
                    onChange={e => setDepositBankAccountId(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs text-slate-900 dark:text-slate-100 outline-none"
                    required
                  >
                    {bankAccounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.code} - {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-2 space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Agreement Title</label>
                  <input
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Academic Year</label>
                  <input
                    type="text"
                    value={academicYear}
                    onChange={e => setAcademicYear(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs font-mono outline-none"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">
                    Total Prepaid Lump Sum ({currencySymbol})
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    value={totalPrepaidAmount}
                    onChange={e => handleTotalPrepaidChange(parseFloat(e.target.value) || 0)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-sm font-mono font-bold outline-none"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Contract Start Date</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">Contract End Date</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                    required
                  />
                </div>
              </div>

              {/* Raw Paper & Toner selectors for Contract Costing */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">
                    Contract Paper Raw Material ({currencySymbol}{paperUnitCost.toFixed(4)}/Sheet)
                  </label>
                  <select
                    value={draftPaperItemId}
                    onChange={e => setDraftPaperItemId(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                  >
                    {rawMaterials.map(rm => (
                      <option key={rm.id} value={rm.id}>
                        {rm.sku} · {rm.name} ({currencySymbol}{getRawUsageUnitCost(rm.id).toFixed(4)}/{rm.usageUnit || 'Unit'})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300">
                    Contract Toner Raw Material ({currencySymbol}{tonerUnitCost.toFixed(4)}/Imp)
                  </label>
                  <select
                    value={draftTonerItemId}
                    onChange={e => setDraftTonerItemId(e.target.value)}
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                  >
                    {rawMaterials.map(rm => (
                      <option key={rm.id} value={rm.id}>
                        {rm.sku} · {rm.name} ({currencySymbol}{getRawUsageUnitCost(rm.id).toFixed(4)}/{rm.usageUnit || 'Unit'})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Number of Assessments (2, 3, 4, or 5) */}
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-bold text-slate-900 dark:text-white">
                      Agreed Number of Assessments (2 to 5) — Specific Date & Costing
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Set each assessment&apos;s specific date, deduction amount, and paper/toner volume to view real profit per assessment.
                    </div>
                  </div>
                  <div className="flex items-center gap-1 p-1 bg-slate-200 dark:bg-slate-800 rounded-lg">
                    {([2, 3, 4, 5] as const).map(num => (
                      <button
                        key={num}
                        type="button"
                        onClick={() => handleAssessmentsCountChange(num)}
                        className={`px-3 py-1 rounded-md text-xs font-bold transition-colors ${
                          totalAssessments === num
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-700 dark:text-slate-300 hover:bg-white/60'
                        }`}
                      >
                        {num} Assessments
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300 font-medium">
                  <input
                    type="checkbox"
                    checked={splitEvenly}
                    onChange={e => setSplitEvenly(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600"
                  />
                  <span>
                    Equal agreed deduction per assessment ({formatCurrency(totalPrepaidAmount / totalAssessments, currency)} each)
                  </span>
                </label>

                <div className="grid grid-cols-12 gap-2 text-[10px] font-bold uppercase text-slate-500 px-1">
                  <div className="col-span-3">ASSESSMENT LABEL</div>
                  <div className="col-span-2">SPECIFIC DATE</div>
                  <div className="col-span-2 text-right">AMOUNT ({currencySymbol})</div>
                  <div className="col-span-1 text-right">SHEETS</div>
                  <div className="col-span-2 text-right">IMPRESSIONS</div>
                  <div className="col-span-2 text-right">EST. PROFIT</div>
                </div>

                <div className="space-y-2">
                  {draftAssessmentsList.map((draft, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-3">
                        <input
                          type="text"
                          value={assessmentLabels[idx] || ''}
                          onChange={e =>
                            setAssessmentLabels(prev =>
                              prev.map((lbl, i) => (i === idx ? e.target.value : lbl))
                            )
                          }
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs outline-none"
                          required
                        />
                      </div>
                      <div className="col-span-2">
                        <input
                          type="date"
                          value={assessmentDates[idx] || startDate}
                          onChange={e =>
                            setAssessmentDates(prev =>
                              prev.map((dt, i) => (i === idx ? e.target.value : dt))
                            )
                          }
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs font-mono outline-none"
                          required
                        />
                      </div>
                      <div className="col-span-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          readOnly={splitEvenly}
                          value={splitEvenly ? draft.agreedAmount : customAmounts[idx] || 0}
                          onChange={e =>
                            setCustomAmounts(prev =>
                              prev.map((amt, i) =>
                                i === idx ? parseFloat(e.target.value) || 0 : amt
                              )
                            )
                          }
                          className={`w-full border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-right font-mono font-bold outline-none ${
                            splitEvenly
                              ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                              : 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
                          }`}
                        />
                      </div>
                      <div className="col-span-1">
                        <input
                          type="number"
                          min="0"
                          value={assessmentSheets[idx] || 0}
                          onChange={e =>
                            setAssessmentSheets(prev =>
                              prev.map((s, i) => (i === idx ? parseInt(e.target.value) || 0 : s))
                            )
                          }
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1.5 text-xs text-right font-mono outline-none"
                          title="Estimated paper sheets"
                        />
                      </div>
                      <div className="col-span-2">
                        <input
                          type="number"
                          min="0"
                          value={assessmentImpressions[idx] || 0}
                          onChange={e =>
                            setAssessmentImpressions(prev =>
                              prev.map((imp, i) =>
                                i === idx ? parseInt(e.target.value) || 0 : imp
                              )
                            )
                          }
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 text-xs text-right font-mono outline-none"
                          title="Estimated toner impressions"
                        />
                      </div>
                      <div className="col-span-2 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        <div>{formatCurrency(draft.profit, currency)}</div>
                        <div className="text-[10px] font-normal text-slate-500">
                          Cost: {formatCurrency(draft.totalCost, currency)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {customMismatch && (
                  <div className="text-[11px] font-semibold text-rose-600">
                    Custom assessment amounts ({formatCurrency(draftSum, currency)}) must equal total prepaid sum ({formatCurrency(totalPrepaidAmount, currency)}).
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Agreement Notes</label>
                <input
                  type="text"
                  value={contractNotes}
                  onChange={e => setContractNotes(e.target.value)}
                  placeholder="Optional retainer conditions or paper specifications"
                  className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md px-3 py-2 text-xs outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsNewContractOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={customMismatch}
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold shadow-sm"
                >
                  Save & Deposit Prepaid Retainer
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
