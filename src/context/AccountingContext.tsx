import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import {
  Account,
  Customer,
  Vendor,
  InventoryItem,
  BomComponent,
  INVOICEABLE_ITEM_TYPES,
  ExamPaper,
  ExamPaperStatus,
  PrintingContract,
  ContractAssessmentMilestone,
  QuickPrintJob,
  Invoice,
  InvoiceLine,
  Estimate,
  PaymentReceived,
  Bill,
  BillLine,
  BillPayment,
  Employee,
  PayrollRun,
  PayrollItem,
  JournalEntry,
  BankTransaction,
  BankReconciliation,
  CompanyProfile,
  AuditLog,
} from '../types/accounting';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../data/defaultChartOfAccounts';
import {
  INITIAL_COMPANY_PROFILE,
  INITIAL_CUSTOMERS,
  INITIAL_VENDORS,
  INITIAL_INVENTORY_ITEMS,
  INITIAL_EXAM_PAPERS,
  INITIAL_PRINTING_CONTRACTS,
  INITIAL_QUICK_PRINT_JOBS,
  INITIAL_INVOICES,
  INITIAL_ESTIMATES,
  INITIAL_BILLS,
  INITIAL_EMPLOYEES,
  INITIAL_PAYROLL_RUNS,
  INITIAL_BANK_TRANSACTIONS,
  INITIAL_AUDIT_LOGS,
} from '../data/initialDemoData';
import { generateTamperEvidentHash } from '../services/taxCalculation';
import { accountingApi, ACCOUNTING_UPDATED_EVENT, ApiAccount, ApiJournalEntry } from '../services/accountingApi';
import { getCurrencySymbol } from '../utils/currency';
import {
  buildPaperStockFromInventoryItem,
  buildTonerSpecFromInventoryItem,
  calculateContractMilestoneEstimate,
  calculateExaminationProductionWorkflow,
  calculatePhotocopyWorkflow,
  calculatePrintingServiceWorkflow,
  calculateTypeAndPrintingWorkflow,
} from '../shared/printingWorkflows';
import type { TonerMachineSpec } from '../shared/tonerCalc';
import type { DocumentPreviewModel, GenerateWorkflowInvoicePayload } from '../types/documents';
import type { ToastNotice, ToastTone } from '../types/toast';
import { documentsApi } from '../services/documentsApi';
import { commercialApi, type ApiInvoice, type ApiVendor, type ApiBill, type ApiBankTransaction } from '../services/commercialApi';
import { printingApi } from '../services/printingApi';
import { payrollApi, type ApiEmployee } from '../services/payrollApi';

/** Payslip row nested inside a `GET /api/payroll/runs` entry. */
interface ApiPayslip {
  employeeId: number;
  hoursRegular: number;
  hoursOvertime: number;
  grossPay: number;
  paye: number;
  pensionEmployee: number;
  pensionEmployer: number;
  otherDeductions: number;
  employerOther: number;
  netPay: number;
}

function mapPayslipToPayrollItem(p: ApiPayslip): PayrollItem {
  return {
    employeeId: String(p.employeeId),
    hoursWorked: Number(p.hoursRegular ?? 0),
    overtimeHours: Number(p.hoursOvertime ?? 0),
    grossPay: Number(p.grossPay ?? 0),
    fit: Number(p.paye ?? 0),
    socialSecurityEmployee: Number(p.pensionEmployee ?? 0),
    medicareEmployee: 0,
    sit: Number(p.otherDeductions ?? 0),
    netPay: Number(p.netPay ?? 0),
    socialSecurityEmployer: Number(p.pensionEmployer ?? 0),
    medicareEmployer: Number(p.employerOther ?? 0),
    futaEmployer: 0,
    sutaEmployer: 0,
  };
}

function mapApiEmployeeToEmployee(e: ApiEmployee): Employee {
  const payFrequency = (['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(e.payFrequency || '')
    ? e.payFrequency
    : 'monthly') as Employee['payFrequency'];
  return {
    id: String(e.id),
    firstName: e.firstName,
    lastName: e.lastName,
    title: e.jobTitle || '',
    email: e.email || '',
    phone: '',
    ssnMasked: e.ssnMasked || '',
    hireDate: e.hireDate || '',
    payType: e.payType === 'salary' ? 'salary' : 'hourly',
    payRate: Number(e.payRate ?? 0),
    payFrequency,
    filingStatus: 'single',
    w4Allowances: 0,
    directDepositRouting: '',
    directDepositAccountMasked: '',
    department: e.department || '',
  };
}

// ---------------------------------------------------------------------------
// Server → context mappers for the financial entities.
//
// The server is the source of truth for every financial record; these mappers
// normalise the API row shapes (snake/camel aliases, string ids, broader enums)
// into the context types so the browser working copy mirrors the ledger instead
// of a demo seed. Fields the list endpoints do not return fall back to safe
// defaults (empty string / zero / empty array).
// ---------------------------------------------------------------------------

function normalizeVendorTerms(raw: unknown): Vendor['terms'] {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('receipt')) return 'Due on Receipt';
  if (s.includes('15')) return 'Net 15';
  if (s.includes('60')) return 'Net 60';
  return 'Net 30';
}

function mapApiVendorToVendor(v: ApiVendor & Record<string, any>): Vendor {
  return {
    id: String(v.id),
    name: v.name || '',
    companyName: v.companyName || '',
    email: v.email || '',
    phone: v.phone || '',
    address: v.address || '',
    einOrSsn: v.taxId || v.einOrSsn || '',
    defaultExpenseAccountId:
      v.defaultExpenseAccountId != null ? String(v.defaultExpenseAccountId) : undefined,
    terms: normalizeVendorTerms(v.terms),
    balance: Number(v.balance ?? 0),
  };
}

function normalizeInvoiceStatus(raw: unknown): Invoice['status'] {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'paid' || s === 'partial' || s === 'overdue' || s === 'draft' || s === 'sent') {
    return s;
  }
  if (s === 'open') return 'sent';
  return 'draft';
}

function mapApiInvoiceToInvoice(inv: ApiInvoice & Record<string, any>): Invoice {
  const lines: InvoiceLine[] = Array.isArray(inv.lines)
    ? inv.lines.map((l: any, idx: number) => ({
        id: String(l.id ?? `line-${idx}`),
        itemId: l.itemId != null ? String(l.itemId) : undefined,
        variantId: l.variantId != null ? String(l.variantId) : undefined,
        variantName: l.variantName,
        description: l.description || '',
        quantity: Number(l.quantity ?? 0),
        rate: Number(l.rate ?? 0),
        amount: Number(l.amount ?? 0),
        unitCost: l.unitCost != null ? Number(l.unitCost) : undefined,
        totalCost: l.totalCost != null ? Number(l.totalCost) : undefined,
        taxable: Boolean(l.taxable),
      }))
    : [];
  return {
    id: String(inv.id),
    invoiceNumber: inv.invoiceNumber || inv.invoice_number || '',
    customerId: String(inv.customerId ?? inv.customer_id ?? ''),
    date: inv.date || inv.invoiceDate || inv.invoice_date || '',
    dueDate: inv.dueDate || inv.due_date || '',
    terms: inv.terms || '',
    status: normalizeInvoiceStatus(inv.status),
    lines,
    subtotal: Number(inv.subtotalNum ?? inv.subtotal ?? 0),
    taxRate: Number(inv.taxRate ?? 0),
    taxAmount: Number(inv.taxAmountNum ?? inv.taxAmount ?? 0),
    total: Number(inv.totalNum ?? inv.total ?? 0),
    totalCost: inv.totalCostNum != null ? Number(inv.totalCostNum) : undefined,
    grossProfit: inv.grossProfitNum != null ? Number(inv.grossProfitNum) : undefined,
    amountPaid: Number(inv.amountPaidNum ?? inv.amountPaid ?? 0),
    balanceDue: Number(inv.balanceDueNum ?? inv.balanceDue ?? 0),
    backendInvoiceId: inv.id != null ? Number(inv.id) : undefined,
    notes: inv.notes,
  };
}

function normalizeBillStatus(raw: unknown): Bill['status'] {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'open' || s === 'partial' || s === 'paid' || s === 'overdue') return s;
  if (s === 'posted' || s === 'approved') return 'open';
  return 'open';
}

function mapApiBillToBill(b: ApiBill & Record<string, any>): Bill {
  const lines: BillLine[] = Array.isArray(b.lines)
    ? b.lines.map((l: any, idx: number) => ({
        id: String(l.id ?? `bill-${b.id}-line-${l.lineOrder ?? idx}`),
        accountId: String(l.accountId ?? l.account_id ?? ''),
        description: l.description || '',
        amount: Number(l.amount ?? 0),
      }))
    : [];
  return {
    id: String(b.id),
    billNumber: b.billNumber || '',
    vendorId: String(b.vendorId ?? b.vendor_id ?? ''),
    date: b.billDate || b.date || '',
    dueDate: b.dueDate || '',
    terms: b.terms || '',
    status: normalizeBillStatus(b.status),
    lines,
    total: Number(b.total ?? 0),
    amountPaid: Number(b.amountPaid ?? 0),
    balanceDue: Number(b.balanceDue ?? 0),
    memo: b.memo,
  };
}

function normalizeJournalSource(raw: unknown): JournalEntry['source'] {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('invoice')) return 'invoice';
  if (s.includes('bill')) return 'bill';
  if (s.includes('payroll')) return 'payroll';
  if (s.includes('payment') || s.includes('receipt')) return 'payment';
  if (s.includes('reconcil')) return 'reconciliation';
  if (s.includes('contract')) return 'contract';
  if (s.includes('quick')) return 'quick_print';
  return 'manual';
}

function mapApiJournalEntry(e: ApiJournalEntry & Record<string, any>): JournalEntry {
  return {
    id: String(e.id),
    entryNumber: e.entryNumber || '',
    date: e.txnDate || e.date || '',
    memo: e.memo ?? '',
    lines: Array.isArray(e.lines)
      ? e.lines.map((l: any) => ({
          id: String(l.id ?? ''),
          accountId: String(l.accountId ?? ''),
          description: l.description ?? '',
          debit: Number(l.debitNum ?? l.debit ?? 0),
          credit: Number(l.creditNum ?? l.credit ?? 0),
        }))
      : [],
    source: normalizeJournalSource(e.sourceType),
    sourceRefId: e.sourceId != null ? String(e.sourceId) : undefined,
  };
}

function normalizeBankTxnType(raw: unknown): BankTransaction['type'] {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('check')) return 'Check';
  if (s.includes('deposit')) return 'Deposit';
  if (s.includes('transfer')) return 'Transfer';
  if (s.includes('bill')) return 'Bill Payment';
  if (s.includes('fee')) return 'Fee';
  return 'Debit';
}

function mapApiBankTransaction(t: ApiBankTransaction & Record<string, any>): BankTransaction {
  return {
    id: String(t.id),
    accountId: String(t.accountId ?? ''),
    date: t.date || '',
    payee: t.payee || '',
    type: normalizeBankTxnType(t.type),
    refNumber: t.refNumber,
    memo: t.memo || '',
    amount: Number(t.amount ?? 0),
    balance: Number(t.runningBalance ?? t.balance ?? 0),
    isCleared: Boolean(t.cleared),
    category: t.category,
  };
}

function mapApiQuickPrintJob(r: any): QuickPrintJob {
  const paperCost = Number(r.paper_cost ?? 0);
  const tonerCost = Number(r.toner_cost ?? 0);
  const extraCost = Number(r.extra_cost ?? 0);
  const sellingPriceTotal = Number(r.manual_selling_price ?? 0);
  const totalCost = paperCost + tonerCost + extraCost;
  return {
    id: String(r.id),
    backendJobId: r.id != null ? Number(r.id) : undefined,
    jobNumber: r.job_number || '',
    customerId: r.customer_id != null ? String(r.customer_id) : undefined,
    customerName: r.customer_name || '',
    jobType: (r.job_type || 'quick_photocopy') as QuickPrintJob['jobType'],
    title: r.title || '',
    pages: Number(r.pages ?? 0),
    copies: Number(r.copies ?? 0),
    printSide: r.print_side === 'Duplex' ? 'Duplex' : 'Single-Sided',
    rawPaperItemId: r.raw_paper_item_id != null ? String(r.raw_paper_item_id) : '',
    rawTonerItemId: r.raw_toner_item_id != null ? String(r.raw_toner_item_id) : '',
    sheetsUsed: Number(r.sheets_used ?? 0),
    impressionsUsed: Number(r.impressions_used ?? 0),
    paperCost,
    tonerCost,
    extraCost,
    totalCost,
    sellingPriceTotal,
    profit: sellingPriceTotal - totalCost,
    date: String(r.job_date ?? '').slice(0, 10),
    backendInvoiceId: r.invoice_id != null ? Number(r.invoice_id) : undefined,
  };
}

const WORKSPACE_PRESS_CAPABILITY: TonerMachineSpec = {
  machineId: 'workspace-digital-press',
  name: 'Production Digital Press',
  processType: 'digital_press',
  supportsColour: false,
  supportsDuplex: true,
  status: 'active',
};

/**
 * Only *presentation* preferences are cached in the browser.
 *
 * The previous key (`slowbooks_pro_2026_data_v1`) stored invoices, bills,
 * payroll runs and journal entries in clear text and duplicated the server
 * ledger. It is deleted on boot; the server is the system of record.
 */
const PREFS_STORAGE_KEY = 'pms_workspace_prefs_v1';
const LEGACY_FINANCIAL_CACHE_KEY = 'slowbooks_pro_2026_data_v1';

interface WorkspacePrefs {
  theme?: CompanyProfile['theme'];
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  cityStateZip?: string;
  defaultBankAccountId?: string;
}

interface ConsolidatedExamInvoiceOptions {
  notes?: string;
  includeTax?: boolean;
  contractId?: string;
  assessmentNumber?: number;
}

export interface AssessmentActualStats {
  sheets: number;
  impressions: number;
  paperCost: number;
  tonerCost: number;
  totalCost: number;
  papersCount: number;
}

/**
 * Financial data domains whose contents are owned by the backend ledger.
 *
 * Each domain carries an explicit load state so the UI can tell the difference
 * between "the server returned nothing", "the request failed" and "these rows
 * are real but were loaded by an earlier successful refresh". Bundled demo
 * seeds are never used to fill a domain after a failed request.
 */
export type FinancialDataDomain =
  | 'accounts'
  | 'customers'
  | 'vendors'
  | 'inventoryItems'
  | 'invoices'
  | 'bills'
  | 'journalEntries'
  | 'bankTransactions'
  | 'reconciliations'
  | 'quickPrintJobs'
  | 'employees'
  | 'payrollRuns'
  | 'printingContracts'
  | 'examPapers';

export const FINANCIAL_DATA_DOMAINS: readonly FinancialDataDomain[] = [
  'accounts',
  'customers',
  'vendors',
  'inventoryItems',
  'invoices',
  'bills',
  'journalEntries',
  'bankTransactions',
  'reconciliations',
  'quickPrintJobs',
  'employees',
  'payrollRuns',
  'printingContracts',
  'examPapers',
];

export type FinancialDataStatus = 'loading' | 'ready' | 'error';

export interface FinancialDataState {
  /** Outcome of the last completed load. `ready` means the rows came from the server. */
  status: FinancialDataStatus;
  /** A refresh is currently in flight. */
  refreshing: boolean;
  /** The visible rows are real server data from an earlier load and a later refresh failed. */
  stale: boolean;
  /** ISO timestamp of the last successful load, or null when nothing was ever loaded. */
  loadedAt: string | null;
  /** Message from the last failed load, or null. */
  error: string | null;
}

interface AccountingContextType {
  companyProfile: CompanyProfile;
  setCompanyProfile: React.Dispatch<React.SetStateAction<CompanyProfile>>;
  updateCompanyProfile: (updates: Partial<CompanyProfile>) => void;

  accounts: Account[];
  setAccounts: React.Dispatch<React.SetStateAction<Account[]>>;
  addAccount: (account: Omit<Account, 'id'>) => Account;
  getAccountById: (id: string) => Account | undefined;

  customers: Customer[];
  addCustomer: (customer: Omit<Customer, 'id' | 'balance'>) => Customer;
  updateCustomer: (id: string, updates: Partial<Customer>) => void;
  getCustomerById: (id: string) => Customer | undefined;

  vendors: Vendor[];
  addVendor: (vendor: Omit<Vendor, 'id' | 'balance'>) => Vendor;
  updateVendor: (id: string, updates: Partial<Vendor>) => void;
  getVendorById: (id: string) => Vendor | undefined;

  inventoryItems: InventoryItem[];
  addInventoryItem: (item: Omit<InventoryItem, 'id'>) => InventoryItem;
  updateInventoryItem: (id: string, updates: Partial<InventoryItem>) => void;
  adjustInventoryStock: (itemId: string, adjustmentQty: number, reason: string) => void;
  getRawUsageUnitCost: (rawMaterialId: string, itemsSnapshot?: InventoryItem[]) => number;
  computeBomUnitCost: (bomLines?: BomComponent[], itemsSnapshot?: InventoryItem[]) => number;
  getItemUnitCost: (item: InventoryItem, variantId?: string) => number;

  quickPrintJobs: QuickPrintJob[];
  addQuickPrintJob: (
    jobData: Omit<
      QuickPrintJob,
      | 'id'
      | 'jobNumber'
      | 'sheetsUsed'
      | 'impressionsUsed'
      | 'paperCost'
      | 'tonerCost'
      | 'totalCost'
      | 'profit'
      | 'sellingPriceTotal'
      | 'extraCost'
    > & { extraCost?: number; sellingPriceTotal?: number },
    options?: { createInvoice?: boolean; idempotencyKey?: string }
  ) => Promise<QuickPrintJob>;

  examPapers: ExamPaper[];
  addExamPaper: (
    paper: Omit<
      ExamPaper,
      'id' | 'jobNumber' | 'totalAmount' | 'sheetsUsed' | 'impressionsUsed' | 'paperCost' | 'tonerCost' | 'materialCost'
    >
  ) => ExamPaper;
  addExamPapersBatch: (
    papers: Omit<
      ExamPaper,
      'id' | 'jobNumber' | 'totalAmount' | 'sheetsUsed' | 'impressionsUsed' | 'paperCost' | 'tonerCost' | 'materialCost'
    >[],
    options?: { submissionId?: string }
  ) => Promise<ExamPaper[]>;
  updateExamPaper: (paperId: string, updates: Partial<ExamPaper>) => void;
  editExamPaper: (
    paperId: string,
    updates: {
      subjectName?: string;
      pages?: number;
      copies?: number;
      printSide?: string;
      bindingType?: string;
      paperSize?: string;
      productionDate?: string | null;
      notes?: string | null;
      reason?: string | null;
    }
  ) => Promise<ExamPaper>;
  updateExamPaperStatus: (
    paperId: string,
    status: ExamPaperStatus,
    options?: {
      reason?: string | null;
      goodCopies?: number;
      spoiledCopies?: number;
      packageCount?: number;
      sealReference?: string | null;
      qcNotes?: string | null;
    }
  ) => Promise<void>;
  deliverExamPaper: (
    paperId: string,
    input?: {
      dispatchDate?: string | null;
      recipientName?: string | null;
      driverName?: string | null;
      vehicleReg?: string | null;
      notes?: string | null;
    }
  ) => Promise<void>;
  deleteExamPaper: (paperId: string) => Promise<void>;
  cancelExamPaper: (
    paperId: string,
    options: { reason: string; returnUnusedMaterials?: boolean }
  ) => Promise<void>;
  reprintExamPaper: (
    paperId: string,
    options: { reason: string; copies?: number; productionDate?: string | null }
  ) => Promise<any>;
  getExamPaperEvents: (paperId: string) => Promise<any[]>;
  approveExamBatchSpec: (batchId: number, notes?: string | null) => Promise<any>;
  getExamReconciliation: () => Promise<any>;
  createConsolidatedSchoolInvoice: (
    examPaperIds: string[],
    options?: ConsolidatedExamInvoiceOptions
  ) => Promise<Invoice | null>;

  printingContracts: PrintingContract[];
  addPrintingContract: (
    contractData: Omit<PrintingContract, 'id' | 'contractNumber' | 'remainingBalance' | 'completedAssessments' | 'status'>
  ) => Promise<PrintingContract>;
  updateContractAssessment: (
    contractId: string,
    assessmentNumber: number,
    updates: Partial<ContractAssessmentMilestone>
  ) => void;
  linkContractDepositInvoice: (
    contractId: string,
    ref: { invoiceId?: string; backendInvoiceId?: number; invoiceNumber?: string }
  ) => Promise<void>;
  linkMilestoneInvoice: (
    contractId: string,
    assessmentNumber: number,
    ref: { invoiceId?: string; backendInvoiceId?: number; invoiceNumber?: string }
  ) => Promise<void>;
  cancelPrintingContract: (
    contractId: string,
    options?: { reason?: string; settlementMode?: 'refund' | 'forfeit'; refundBankAccountId?: number | null }
  ) => Promise<void>;
  activatePrintingContract: (contractId: string) => Promise<void>;
  renewPrintingContract: (
    contractId: string,
    deposit?: { amount?: string | number; bankAccountId?: number; startDate?: string; endDate?: string }
  ) => Promise<void>;
  amendPrintingContract: (contractId: string, updates: Partial<PrintingContract>) => Promise<void>;
  suspendContract: (contractId: string, reason?: string) => Promise<void>;
  resumeContract: (contractId: string) => Promise<void>;
  listContractAmendments: (contractId: string) => Promise<any[]>;
  approveContractAmendment: (
    contractId: string,
    amendmentId: number,
    notes?: string | null
  ) => Promise<void>;
  rejectContractAmendment: (
    contractId: string,
    amendmentId: number,
    notes?: string | null
  ) => Promise<void>;
  recordContractAcceptance: (
    contractId: string,
    payload: {
      method: 'drawn' | 'otp' | 'upload';
      signerName: string;
      signerEmail?: string | null;
      signerPhone?: string | null;
      documentVersion: string;
      evidenceFileId?: number | null;
      otpVerified?: boolean;
      outcome?: 'accepted' | 'rejected';
    }
  ) => Promise<void>;
  voidPrintingContract: (contractId: string, reason: string) => Promise<void>;
  listContractSignatures: (contractId: string) => Promise<any[]>;
  getContractReconciliation: () => Promise<any>;
  recordContractSignature: (
    contractId: string,
    payload: {
      signerRole: 'company' | 'customer';
      signerName: string;
      method: 'drawn' | 'typed' | 'upload';
      signatureData: string;
      documentVersion?: string | null;
    }
  ) => Promise<void>;
  addContractAssessment: (contractId: string, milestone: ContractAssessmentMilestone) => void;
  removeContractAssessment: (contractId: string, assessmentNumber: number) => void;
  completeContractAssessment: (
    contractId: string,
    assessmentNumber: number,
    examBatchNote?: string,
    linkedInvoiceId?: string
  ) => Promise<void>;
  getAssessmentActualStats: (contractId: string, assessmentNumber: number) => AssessmentActualStats;
  linkQuickPrintInvoice: (
    jobId: string,
    ref: { invoiceId?: string; backendInvoiceId?: number; invoiceNumber?: string }
  ) => void;
  linkExamPapersInvoice: (
    paperIds: string[],
    ref: { invoiceId?: string; backendInvoiceId?: number; invoiceNumber?: string }
  ) => void;
  generateAndSyncWorkflowInvoice: (
    payload: GenerateWorkflowInvoicePayload,
    options?: { localCustomerId?: string }
  ) => Promise<{ apiInvoice: ApiInvoice; localInvoice: Invoice }>;
  listExamGroups: (params?: { schoolCustomerId?: number | null; assessmentName?: string | null }) => Promise<any[]>;
  getExamGroupForBatch: (batchId: number) => Promise<any>;
  getExamGroupSummary: (groupId: number) => Promise<any>;
  runExamGroupWorkflow: (
    groupId: number,
    options?: {
      goodCopiesByPaper?: Record<string, number>;
      spoiledCopiesByPaper?: Record<string, number>;
      dispatchDate?: string | null;
      recipientName?: string | null;
      includeTax?: boolean;
      taxRate?: number;
      notes?: string | null;
      onProgress?: (step: string, summary: any) => void;
    }
  ) => Promise<any>;

  invoices: Invoice[];
  addInvoice: (
    invoiceData: Omit<Invoice, 'id' | 'invoiceNumber' | 'status' | 'amountPaid' | 'balanceDue'> & {
      invoiceNumber?: string;
    }
  ) => Promise<Invoice>;
  markInvoicePaid: (invoiceId: string, paymentMethod?: string) => Promise<void>;
  getInvoiceById: (id: string) => Invoice | undefined;

  estimates: Estimate[];
  addEstimate: (estimateData: Omit<Estimate, 'id' | 'estimateNumber' | 'status'>) => Estimate;
  convertEstimateToInvoice: (estimateId: string) => Promise<Invoice | null>;

  paymentsReceived: PaymentReceived[];
  recordPaymentReceived: (payment: Omit<PaymentReceived, 'id' | 'paymentNumber'>) => Promise<PaymentReceived>;

  bills: Bill[];
  addBill: (billData: Omit<Bill, 'id' | 'billNumber' | 'status' | 'amountPaid' | 'balanceDue'>) => Promise<Bill>;
  payBill: (billId: string, bankAccountId: string, checkNumber?: string) => Promise<BillPayment>;

  billPayments: BillPayment[];

  employees: Employee[];
  addEmployee: (employeeData: Omit<Employee, 'id'>) => Employee;
  updateEmployee: (id: string, updates: Partial<Employee>) => void;

  payrollRuns: PayrollRun[];
  processPayrollRun: (payrollData: Omit<PayrollRun, 'id' | 'runNumber' | 'status'>) => Promise<PayrollRun>;

  journalEntries: JournalEntry[];
  addJournalEntry: (entry: Omit<JournalEntry, 'id' | 'entryNumber'>) => Promise<JournalEntry>;

  bankTransactions: BankTransaction[];
  addBankTransaction: (tx: Omit<BankTransaction, 'id' | 'balance' | 'isCleared'>) => BankTransaction;
  toggleTransactionCleared: (txId: string) => void;
  importBankTransactions: (txs: Omit<BankTransaction, 'id' | 'balance' | 'isCleared'>[]) => void;

  reconciliations: BankReconciliation[];
  commitReconciliation: (rec: Omit<BankReconciliation, 'id' | 'reconciledAt'>) => Promise<BankReconciliation>;

  auditLogs: AuditLog[];
  logAuditAction: (action: string, entityType: string, entityId: string, details: string) => Promise<void>;

  // Navigation
  currentView: string;
  setCurrentView: (view: string) => void;

  // Modals
  isNewInvoiceOpen: boolean;
  setIsNewInvoiceOpen: (open: boolean) => void;
  isReceivePaymentOpen: boolean;
  setIsReceivePaymentOpen: (open: boolean) => void;
  isEnterBillOpen: boolean;
  setIsEnterBillOpen: (open: boolean) => void;
  isPayBillsOpen: boolean;
  setIsPayBillsOpen: (open: boolean) => void;
  isWriteCheckOpen: boolean;
  setIsWriteCheckOpen: (open: boolean) => void;
  isJournalEntryOpen: boolean;
  setIsJournalEntryOpen: (open: boolean) => void;
  isNewCustomerOpen: boolean;
  setIsNewCustomerOpen: (open: boolean) => void;
  isNewVendorOpen: boolean;
  setIsNewVendorOpen: (open: boolean) => void;
  isNewItemOpen: boolean;
  setIsNewItemOpen: (open: boolean) => void;
  isNewEmployeeOpen: boolean;
  setIsNewEmployeeOpen: (open: boolean) => void;
  isOcrScannerOpen: boolean;
  setIsOcrScannerOpen: (open: boolean) => void;
  isIifImportOpen: boolean;
  setIsIifImportOpen: (open: boolean) => void;
  isStatementOpen: boolean;
  setIsStatementOpen: (open: boolean) => void;
  isCommandPaletteOpen: boolean;
  setIsCommandPaletteOpen: (open: boolean) => void;
  isPosModalOpen: boolean;
  setIsPosModalOpen: (open: boolean) => void;
  previewDocument: DocumentPreviewModel | null;
  openDocumentPreview: (doc: DocumentPreviewModel) => void;
  closeDocumentPreview: () => void;
  /** Global PrimeDocument preview (type + data rendered by the real PDF engine). */
  primePreview: { type: string; data: any; title?: string } | null;
  openPrimePreview: (type: string, data: any, title?: string) => void;
  closePrimePreview: () => void;

  // Backup & Reset
  resetToDemoData: () => void;
  clearAllData: () => void;
  exportDataToJson: () => void;
  importDataFromJson: (jsonData: string) => boolean;

  // UI Engine Preferences
  isSidebarCollapsed: boolean;
  setIsSidebarCollapsed: (collapsed: boolean) => void;
  isMobileDrawerOpen: boolean;
  setIsMobileDrawerOpen: (open: boolean) => void;
  tableDensity: 'compact' | 'comfortable';
  setTableDensity: (density: 'compact' | 'comfortable') => void;

  // Keyboard shortcut banner / Toast
  activeShortcutNotice: ToastNotice | null;
  triggerShortcutNotice: (text: string, tone?: ToastTone) => void;
  dismissShortcutNotice: () => void;

  // Financial data trust state
  /**
   * Per-domain load state for every backend-owned financial collection. Read
   * this before presenting a financial figure as current: `status: 'error'`
   * with `loadedAt: null` means nothing is loaded, and `stale: true` means the
   * visible rows are real but predate a failed refresh.
   */
  financialData: Record<FinancialDataDomain, FinancialDataState>;
  /**
   * Re-run the backend load for one domain, or for every domain when omitted.
   * Only successful loads update the data; failures keep the truthful state.
   */
  refreshFinancialData: (domain?: FinancialDataDomain) => Promise<void>;
}

const AccountingContext = createContext<AccountingContextType | undefined>(undefined);

const migrateItemType = (rawType: string): InventoryItem['type'] => {
  switch (rawType) {
    case 'raw_material':
    case 'printed_product':
    case 'stationery':
    case 'printing_service':
      return rawType;
    case 'inventory':
      return 'stationery';
    case 'non_inventory':
      return 'printed_product';
    case 'service':
    case 'other_charge':
    default:
      return 'printing_service';
  }
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

// Coerce a local/demo id (e.g. "cust-123", "inv-PP-EXBOOK-A4") into a positive
// numeric backend id, or null when it is not a real server record.
const toBackendId = (v?: string | number | null): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const AccountingProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  /**
   * Load presentation preferences only.
   *
   * The legacy key held a full financial snapshot (invoices, bills, payroll,
   * journals) in clear text. It is removed on the first boot after the
   * upgrade so the stale copy cannot be mistaken for a ledger backup.
   */
  const loadInitialData = (): { prefs: WorkspacePrefs | null } => {
    try {
      localStorage.removeItem(LEGACY_FINANCIAL_CACHE_KEY);
    } catch {
      // storage unavailable (private mode / quota)
    }
    try {
      const saved = localStorage.getItem(PREFS_STORAGE_KEY);
      if (saved) {
        return { prefs: JSON.parse(saved) as WorkspacePrefs };
      }
    } catch {
      // corrupted cache — fall back to defaults
    }
    return { prefs: null };
  };

  const { prefs: savedPrefs } = loadInitialData();

  // Helper pure calculators
  const calcRawUsageUnitCost = (rawMaterialId: string, itemsList: InventoryItem[]): number => {
    const rawMat = itemsList.find(i => i.id === rawMaterialId);
    if (!rawMat) return 0;
    const factor = rawMat.conversionFactor && rawMat.conversionFactor > 0 ? rawMat.conversionFactor : 1;
    return round2(rawMat.cost / factor);
  };

  const calcBomUnitCost = (bomLines: BomComponent[] | undefined, itemsList: InventoryItem[]): number => {
    if (!bomLines || bomLines.length === 0) return 0;
    const total = bomLines.reduce((sum, comp) => {
      const unitCost = calcRawUsageUnitCost(comp.rawMaterialId, itemsList);
      return sum + unitCost * comp.quantityPerUnit;
    }, 0);
    return round2(total);
  };

  const recalculateDependentItemCosts = (itemsList: InventoryItem[]): InventoryItem[] => {
    return itemsList.map(item => {
      if (item.type === 'printed_product' || item.type === 'printing_service') {
        const updatedVariants = item.variants?.map(v => ({
          ...v,
          onHand: item.type === 'printed_product' ? 0 : v.onHand,
          reorderPoint: item.type === 'printed_product' ? 0 : v.reorderPoint,
          cost:
            v.bomLines && v.bomLines.length > 0
              ? calcBomUnitCost(v.bomLines, itemsList)
              : v.cost,
        }));
        const nextParentCost =
          item.bomLines && item.bomLines.length > 0
            ? calcBomUnitCost(item.bomLines, itemsList)
            : updatedVariants && updatedVariants.length > 0
            ? updatedVariants[0].cost
            : item.cost;
        return {
          ...item,
          cost: round2(nextParentCost),
          onHand: 0,
          reorderPoint: 0,
          variants: updatedVariants,
        };
      }

      if (item.type === 'stationery' && item.variants && item.variants.length > 0) {
        const sumOnHand = round2(item.variants.reduce((s, v) => s + (v.onHand || 0), 0));
        return {
          ...item,
          onHand: sumOnHand,
        };
      }

      return item;
    });
  };

  const [companyProfile, setCompanyProfile] = useState<CompanyProfile>(() => {
    const base = INITIAL_COMPANY_PROFILE;
    const prefs = savedPrefs;
    if (!prefs) return base;
    return {
      ...base,
      theme: prefs.theme ?? base.theme,
      phone: prefs.phone ?? base.phone,
      email: prefs.email ?? base.email,
      website: prefs.website ?? base.website,
      defaultBankAccountId: prefs.defaultBankAccountId ?? base.defaultBankAccountId,
    };
  });

  /**
   * The chart of accounts is server-owned. It starts empty and is filled only by
   * a successful `/api/accounts` load; a failed load leaves it empty and is
   * reported through `financialData.accounts` rather than substituting the
   * bundled demo chart.
   */
  const [accounts, setAccounts] = useState<Account[]>([]);

  /**
   * Load state for every backend-owned financial collection.
   *
   * `INITIAL_*` demo seeds are deliberately NOT used as the initial value of
   * these collections. The provider only mounts for an authenticated session,
   * so any demo row shown here would be indistinguishable from live company
   * data. A failed request therefore leaves the collection empty and the
   * domain in `status: 'error'` instead of silently showing demo figures.
   */
  const [financialData, setFinancialData] = useState<Record<FinancialDataDomain, FinancialDataState>>(
    () =>
      FINANCIAL_DATA_DOMAINS.reduce((acc, domain) => {
        acc[domain] = { status: 'loading', refreshing: true, stale: false, loadedAt: null, error: null };
        return acc;
      }, {} as Record<FinancialDataDomain, FinancialDataState>)
  );

  /** Domains with a load already in flight, so overlapping refreshes collapse. */
  const inFlightFinancialLoads = React.useRef<Set<FinancialDataDomain>>(new Set());

  /**
   * Domains whose refresh was requested while a load was already in flight.
   *
   * Without this the overlapping request would be dropped and the older
   * snapshot would be published as `current`, which is exactly the "a refresh
   * was requested but silently skipped" case the trust model must not allow.
   */
  const pendingFinancialRerun = React.useRef<Set<FinancialDataDomain>>(new Set());

  /**
   * Single funnel for every backend financial load.
   *
   * - Success (including a genuinely empty list) marks the domain `ready`.
   * - Failure with no previous success marks it `error` with no data.
   * - Failure after a previous success keeps the real rows but flags them
   *   `stale` and records the error, so a refresh failure can never be
   *   mistaken for a successful refresh.
   */
  const runFinancialLoad = React.useCallback(
    async (domain: FinancialDataDomain, loader: () => Promise<void>) => {
      if (inFlightFinancialLoads.current.has(domain)) {
        pendingFinancialRerun.current.add(domain);
        return;
      }
      inFlightFinancialLoads.current.add(domain);
      try {
        // Keep serving the newest request: if another refresh arrives while one
        // is running, run once more so the older result is never the final one.
        do {
          pendingFinancialRerun.current.delete(domain);
          setFinancialData(prev => ({
            ...prev,
            [domain]: { ...prev[domain], refreshing: true, error: null },
          }));
          try {
            await loader();
            setFinancialData(prev => ({
              ...prev,
              [domain]: {
                status: 'ready',
                refreshing: false,
                stale: false,
                loadedAt: new Date().toISOString(),
                error: null,
              },
            }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err || 'Request failed');
            console.warn(`[financial data] ${domain} load failed:`, err);
            setFinancialData(prev => {
              const prior = prev[domain];
              const hasLoadedRows = prior.loadedAt !== null;
              return {
                ...prev,
                [domain]: hasLoadedRows
                  ? { ...prior, status: 'ready', refreshing: false, stale: true, error: message }
                  : { status: 'error', refreshing: false, stale: false, loadedAt: null, error: message },
              };
            });
          }
        } while (pendingFinancialRerun.current.has(domain));
      } finally {
        inFlightFinancialLoads.current.delete(domain);
      }
    },
    []
  );

  const refreshAccountsFromBackend = () =>
    runFinancialLoad('accounts', async () => {
      const list = await accountingApi.listAccounts(true);
      const mapped: Account[] = list.map((a: ApiAccount) => ({
        id: String(a.id),
        code: a.code || '',
        name: a.name,
        type: a.account_type as any,
        description: a.description || undefined,
        parentId: a.parent_id !== null ? String(a.parent_id) : undefined,
        balance: a.balanceNum,
        isSystem: a.is_system,
      }));
      // An empty list is a real answer from the server, not a failure: publish
      // it so a genuine zero is never confused with unavailable data.
      setAccounts(mapped);
    });

  useEffect(() => {
    refreshAccountsFromBackend();
    const handler = () => { refreshAccountsFromBackend(); };
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, []);


  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);

  /**
   * Replace the demo inventory with the server's catalog.
   *
   * The server owns stock, costs and the movement ledger. `INITIAL_INVENTORY_ITEMS`
   * is only a pre-auth fallback; once a session exists the catalog comes from
   * the database so on_hand / avg_cost always agree with the general ledger.
   *
   * Monetary columns arrive as exact fixed-point strings from the API, so they
   * are parsed with parseFloat here and never recomputed from a float source.
   */
  const refreshInventoryFromBackend = () =>
    runFinancialLoad('inventoryItems', async () => {
      const list = await commercialApi.listInventory();
      const mapped: InventoryItem[] = (list as any[]).map((row) => {
        const migratedType = migrateItemType(row.item_type);
        const isRaw = migratedType === 'raw_material';
        const stocked =
          migratedType === 'printed_product' || migratedType === 'printing_service';
        return {
          id: String(row.id),
          sku: row.sku || '',
          name: row.name || '',
          type: migratedType,
          description: row.description || '',
          cost: Number(row.unit_cost ?? 0),
          salesPrice: Number(row.sales_price ?? 0),
          onHand: stocked ? 0 : Number(row.on_hand ?? 0),
          reorderPoint: stocked ? 0 : Number(row.reorder_point ?? 0),
          purchaseUnit: isRaw ? row.purchase_unit || 'Unit' : row.purchase_unit,
          usageUnit: isRaw ? row.usage_unit || 'Unit' : row.usage_unit,
          conversionFactor: isRaw ? Number(row.conversion_factor ?? 1) : row.conversion_factor,
          assetAccountId: row.asset_account_id != null ? String(row.asset_account_id) : '',
          cogsAccountId: row.cogs_account_id != null ? String(row.cogs_account_id) : '',
          incomeAccountId: row.income_account_id != null ? String(row.income_account_id) : '',
        } as InventoryItem;
      });
      setInventoryItems(recalculateDependentItemCosts(mapped));
    });

  useEffect(() => {
    refreshInventoryFromBackend();
    const handler = () => {
      refreshInventoryFromBackend();
    };
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, []);

  const [quickPrintJobs, setQuickPrintJobs] = useState<QuickPrintJob[]>([]);

  const [examPapers, setExamPapers] = useState<ExamPaper[]>([]);

  const [printingContracts, setPrintingContracts] = useState<PrintingContract[]>([]);

  // ---------------------------------------------------------------------------
  // Backend loaders — customers, printing contracts and examination papers.
  // Mirrors the accounts/inventory pattern: the server is the source of truth;
  // bundled demo data is only a fallback while the backend is empty/unreachable.
  // ---------------------------------------------------------------------------
  const mapApiCustomer = (r: any): Customer => ({
    id: String(r.id),
    name: r.name || '',
    companyName: r.companyName || r.name || '',
    email: r.email || '',
    phone: r.phone || '',
    billingAddress: r.billingAddress || '',
    terms: (r.terms as Customer['terms']) || 'Net 30',
    balance: Number(r.balance ?? 0),
    customerType: r.customerType,
  });

  const mapApiContract = (b: any): PrintingContract => ({
    id: String(b.backendId ?? b.id),
    backendId: Number(b.backendId ?? b.id),
    contractNumber: b.contractNumber,
    schoolCustomerId: String(b.schoolCustomerId),
    title: b.title,
    academicYear: b.academicYear,
    startDate: b.startDate,
    endDate: b.endDate,
    totalPrepaidAmount: Number(b.totalPrepaidAmount ?? 0),
    totalAssessments: Number(b.totalAssessments ?? 2) as 2 | 3 | 4 | 5,
    remainingBalance: Number(b.remainingBalance ?? 0),
    completedAssessments: Number(b.completedAssessments ?? 0),
    depositBankAccountId: String(b.depositBankAccountId ?? ''),
    status: (b.status ?? 'draft') as PrintingContract['status'],
    notes: b.notes ?? undefined,
    activatedAt: b.activatedAt ?? undefined,
    activatedBy: b.activatedBy != null ? Number(b.activatedBy) : undefined,
    completedAt: b.completedAt ?? undefined,
    completedBy: b.completedBy != null ? Number(b.completedBy) : undefined,
    suspendedAt: b.suspendedAt ?? undefined,
    suspendedBy: b.suspendedBy != null ? Number(b.suspendedBy) : undefined,
    suspensionReason: b.suspensionReason ?? undefined,
    resumedAt: b.resumedAt ?? undefined,
    resumedBy: b.resumedBy != null ? Number(b.resumedBy) : undefined,
    renewalOfContractId: b.renewalOfContractId != null ? Number(b.renewalOfContractId) : undefined,
    customerAcceptanceId:
      b.customerAcceptanceId != null ? Number(b.customerAcceptanceId) : undefined,
    liabilityAccountId: b.liabilityAccountId != null ? Number(b.liabilityAccountId) : undefined,
    unallocatedAmount: b.unallocatedAmount != null ? Number(b.unallocatedAmount) : undefined,
    allocatedAmount: b.allocatedAmount != null ? Number(b.allocatedAmount) : undefined,
    creditBalance: b.creditBalance === true,
    updatedAt: b.updatedAt ?? undefined,
    source: 'backend',
    depositInvoiceId: b.depositInvoiceId != null ? String(b.depositInvoiceId) : undefined,
    depositBackendInvoiceId:
      b.depositBackendInvoiceId != null ? Number(b.depositBackendInvoiceId) : undefined,
    depositInvoiceNumber: b.depositInvoiceNumber ?? undefined,
    assessments: (b.assessments || []).map((a: any) => ({
      assessmentNumber: Number(a.assessmentNumber),
      label: a.label,
      scheduledDate: a.scheduledDate,
      agreedAmount: Number(a.agreedAmount ?? 0),
      rawPaperItemId: a.rawPaperItemId != null ? String(a.rawPaperItemId) : undefined,
      rawTonerItemId: a.rawTonerItemId != null ? String(a.rawTonerItemId) : undefined,
      estimatedSheets: Number(a.estimatedSheets ?? 0),
      estimatedImpressions: Number(a.estimatedImpressions ?? 0),
      paperCost: Number(a.paperCost ?? 0),
      tonerCost: Number(a.tonerCost ?? 0),
      totalCost: Number(a.totalCost ?? 0),
      profit: Number(a.profit ?? 0),
      status: (a.status ?? 'pending') as ContractAssessmentMilestone['status'],
      completedDate: a.completedDate ?? undefined,
      examBatchNote: a.examBatchNote ?? undefined,
      backendInvoiceId: a.backendInvoiceId != null ? Number(a.backendInvoiceId) : undefined,
      linkedInvoiceNumber: a.linkedInvoiceNumber ?? undefined,
    })),
  });

  const mapApiExamPaper = (p: any): ExamPaper => ({
    id: String(p.backendId ?? p.id),
    backendId: Number(p.backendId ?? p.id),
    jobNumber: p.jobNumber,
    schoolCustomerId: String(p.schoolCustomerId),
    assessmentName: p.assessmentName,
    className: p.className,
    learnersCount: Number(p.learnersCount ?? 0),
    pricePerLearner: Number(p.pricePerLearner ?? 0),
    subjectName: p.subjectName,
    pages: Number(p.pages ?? 0),
    copies: Number(p.copies ?? 0),
    paperSize: (p.paperSize ?? 'A4') as ExamPaper['paperSize'],
    printSide: (p.printSide ?? 'Single-Sided') as ExamPaper['printSide'],
    bindingType: (p.bindingType ?? 'Stapled') as ExamPaper['bindingType'],
    paperSpecId: p.paperSpecId != null ? String(p.paperSpecId) : undefined,
    printingItemId: p.printingItemId != null ? String(p.printingItemId) : undefined,
    productionJobId: p.productionJobId != null ? Number(p.productionJobId) : undefined,
    rawPaperItemId: p.rawPaperItemId != null ? String(p.rawPaperItemId) : undefined,
    rawTonerItemId: p.rawTonerItemId != null ? String(p.rawTonerItemId) : undefined,
    ratePerPage: Number(p.ratePerPage ?? 0),
    totalAmount: Number(p.totalAmount ?? 0),
    sheetsUsed: Number(p.sheetsUsed ?? 0),
    impressionsUsed: Number(p.impressionsUsed ?? 0),
    paperCost: Number(p.paperCost ?? 0),
    tonerCost: Number(p.tonerCost ?? 0),
    materialCost: Number(p.materialCost ?? 0),
    costStatus: p.costStatus,
    costWarnings: Array.isArray(p.costWarnings) ? p.costWarnings : [],
    status: (p.status ?? 'queued') as ExamPaperStatus,
    productionDate: p.productionDate,
    qcStatus: p.qcStatus,
    qcApprovedCopies: Number(p.qcApprovedCopies ?? 0),
    goodCopies: Number(p.goodCopies ?? 0),
    spoiledCopies: Number(p.spoiledCopies ?? 0),
    wasteSheets: Number(p.wasteSheets ?? 0),
    startedAt: p.startedAt,
    completedAt: p.completedAt,
    deliveredAt: p.deliveredAt,
    deliveryNoteId: p.deliveryNoteId != null ? Number(p.deliveryNoteId) : undefined,
    invoiceId: p.invoiceId != null ? String(p.invoiceId) : undefined,
    backendInvoiceId: p.backendInvoiceId != null ? Number(p.backendInvoiceId) : undefined,
    contractId: p.contractId != null ? String(p.contractId) : undefined,
    assessmentNumber: p.assessmentNumber != null ? Number(p.assessmentNumber) : undefined,
    notes: p.notes ?? undefined,
  });

  const refreshCustomersFromBackend = () =>
    runFinancialLoad('customers', async () => {
      const list = await commercialApi.listCustomers();
      // The backend list is authoritative. Demo customers are never merged in:
      // a demo row would be indistinguishable from a live customer balance.
      setCustomers(list.map(mapApiCustomer));
    });

  const refreshPrintingContractsFromBackend = () =>
    runFinancialLoad('printingContracts', async () => {
      const list = await printingApi.listContracts();
      setPrintingContracts(list.map(mapApiContract));
    });

  const refreshExamPapersFromBackend = () =>
    runFinancialLoad('examPapers', async () => {
      const list = await printingApi.listExamPapers();
      setExamPapers(list.map(mapApiExamPaper));
    });

  useEffect(() => {
    refreshCustomersFromBackend();
    refreshPrintingContractsFromBackend();
    refreshExamPapersFromBackend();
    const handler = () => {
      refreshCustomersFromBackend();
      refreshPrintingContractsFromBackend();
      refreshExamPapersFromBackend();
    };
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  // Estimates are server-owned (`commercialApi.listEstimates`) but no view
  // reads the context copy — InvoicesView loads its own. It starts empty so the
  // bundled demo estimates are never exported or presented as company records.
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [paymentsReceived, setPaymentsReceived] = useState<PaymentReceived[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [billPayments, setBillPayments] = useState<BillPayment[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payrollRuns, setPayrollRuns] = useState<PayrollRun[]>([]);

  /**
   * The employee directory and payroll history are server-owned. The demo seeds
   * are only a pre-auth fallback; once a session exists these hydrate from
   * `/api/employees` and `/api/payroll/runs` so the payroll centre never runs
   * against a fictional roster. A failed load leaves the roster empty and the
   * domain in `status: 'error'` rather than showing demo employees.
   */
  const refreshEmployeesFromBackend = () =>
    runFinancialLoad('employees', async () => {
      const list = await payrollApi.listEmployees();
      setEmployees(list.map(mapApiEmployeeToEmployee));
    });

  const refreshPayrollRunsFromBackend = () =>
    runFinancialLoad('payrollRuns', async () => {
      const runs = await payrollApi.listRuns();
      const mapped: PayrollRun[] = (runs as any[]).map((r) => ({
        id: String(r.id),
        runNumber: r.run_number,
        payPeriodStart: String(r.pay_period_start ?? '').slice(0, 10),
        payPeriodEnd: String(r.pay_period_end ?? '').slice(0, 10),
        payDate: String(r.pay_date ?? '').slice(0, 10),
        totalGross: Number(r.total_gross ?? 0),
        totalNet: Number(r.total_net ?? 0),
        totalEmployeeTaxes: Number(r.total_employee_taxes ?? 0),
        totalEmployerTaxes: Number(r.total_employer_taxes ?? 0),
        items: Array.isArray(r.items) ? r.items.map(mapPayslipToPayrollItem) : [],
        bankAccountId: '',
        status: 'processed' as const,
      }));
      setPayrollRuns(mapped);
    });

  useEffect(() => {
    refreshEmployeesFromBackend();
    refreshPayrollRunsFromBackend();
    const handler = () => {
      refreshEmployeesFromBackend();
      refreshPayrollRunsFromBackend();
    };
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, []);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [bankTransactions, setBankTransactions] = useState<BankTransaction[]>([]);
  const [reconciliations, setReconciliations] = useState<BankReconciliation[]>([]);
  // Local import/export cache for the audit trail (`accountingApi.getAuditLogs`
  // is loaded directly by the views that display it). It starts empty so a
  // bundled demo trail is never exported as though it were the company's.
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  /**
   * Financial entities are server-owned. Every collection starts empty and is
   * published only after a successful API load, so the browser working copy
   * mirrors the ledger (and the sidebar badges read real counts). A failed load
   * records the error on the domain instead of substituting demo rows, and
   * every mutation path emits ACCOUNTING_UPDATED_EVENT so the lists refresh
   * after a write rather than drifting from the server.
   */
  const refreshVendorsFromBackend = () =>
    runFinancialLoad('vendors', async () => {
      const list = await commercialApi.listVendors();
      setVendors(list.map(mapApiVendorToVendor));
    });
  const refreshInvoicesFromBackend = () =>
    runFinancialLoad('invoices', async () => {
      const list = await commercialApi.listInvoices();
      setInvoices(list.map(mapApiInvoiceToInvoice));
    });
  const refreshBillsFromBackend = () =>
    runFinancialLoad('bills', async () => {
      const list = await commercialApi.listBills();
      setBills(list.map(mapApiBillToBill));
    });
  const refreshJournalEntriesFromBackend = () =>
    runFinancialLoad('journalEntries', async () => {
      const list = await accountingApi.listJournals();
      setJournalEntries(list.map(mapApiJournalEntry));
    });
  const refreshBankTransactionsFromBackend = () =>
    runFinancialLoad('bankTransactions', async () => {
      const list = await commercialApi.listBankTransactions();
      setBankTransactions(list.map(mapApiBankTransaction));
    });
  const refreshReconciliationsFromBackend = () =>
    runFinancialLoad('reconciliations', async () => {
      const list = await commercialApi.listReconciliations();
      setReconciliations(
        (list as any[]).map((r) => ({
          id: String(r.id),
          accountId: String(r.accountId ?? ''),
          statementDate: String(r.statementDate ?? '').slice(0, 10),
          statementEndingBalance: Number(r.statementEndingBalance ?? 0),
          clearedBalance: Number(r.clearedTotal ?? r.clearedBalance ?? 0),
          difference: Number(r.difference ?? 0),
          clearedTxIds: Array.isArray(r.clearedTxIds) ? r.clearedTxIds.map(String) : [],
          reconciledAt: r.completedAt ? String(r.completedAt) : '',
        }))
      );
    });
  const refreshQuickPrintJobsFromBackend = () =>
    runFinancialLoad('quickPrintJobs', async () => {
      const rows = await printingApi.listQuickPrintJobs();
      setQuickPrintJobs(rows.map(mapApiQuickPrintJob));
    });

  /**
   * Registry used by `refreshFinancialData` so a retry always re-runs the real
   * backend request for the requested domain.
   */
  const financialLoaders: Record<FinancialDataDomain, () => Promise<void>> = {
    accounts: refreshAccountsFromBackend,
    customers: refreshCustomersFromBackend,
    vendors: refreshVendorsFromBackend,
    inventoryItems: refreshInventoryFromBackend,
    invoices: refreshInvoicesFromBackend,
    bills: refreshBillsFromBackend,
    journalEntries: refreshJournalEntriesFromBackend,
    bankTransactions: refreshBankTransactionsFromBackend,
    reconciliations: refreshReconciliationsFromBackend,
    quickPrintJobs: refreshQuickPrintJobsFromBackend,
    employees: refreshEmployeesFromBackend,
    payrollRuns: refreshPayrollRunsFromBackend,
    printingContracts: refreshPrintingContractsFromBackend,
    examPapers: refreshExamPapersFromBackend,
  };
  const financialLoadersRef = React.useRef(financialLoaders);
  financialLoadersRef.current = financialLoaders;

  const refreshFinancialData = React.useCallback(async (domain?: FinancialDataDomain) => {
    const targets = domain ? [domain] : FINANCIAL_DATA_DOMAINS;
    await Promise.all(targets.map(d => financialLoadersRef.current[d]()));
  }, []);

  useEffect(() => {
    const refreshAll = () => {
      refreshFinancialData();
    };
    refreshAll();
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, refreshAll);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, refreshAll);
  }, []);

  // View state & modals
  // The active view is mirrored in the URL hash (#/<view>) so every screen has a
  // deep link and the browser Back/Forward buttons work. `setCurrentView` keeps
  // the historical (view: string) signature used across the app while driving the
  // hash; a `hashchange` listener keeps state in sync when the user navigates via
  // history or a pasted link.
  const readViewFromHash = (): string => {
    const raw = window.location.hash.replace(/^#\/?/, '').trim();
    return raw || 'workflow';
  };
  const [currentView, setCurrentViewState] = useState<string>(readViewFromHash);
  const setCurrentView = React.useCallback((view: string) => {
    setCurrentViewState(view);
    const target = `#/${view}`;
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
  }, []);
  useEffect(() => {
    const onHashChange = () => setCurrentViewState(readViewFromHash());
    window.addEventListener('hashchange', onHashChange);
    // Normalise a bare URL to the default workflow view so the address bar is
    // always shareable/deep-linkable.
    if (!window.location.hash) {
      window.history.replaceState(null, '', '#/workflow');
    }
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const [isNewInvoiceOpen, setIsNewInvoiceOpen] = useState(false);
  const [isReceivePaymentOpen, setIsReceivePaymentOpen] = useState(false);
  const [isEnterBillOpen, setIsEnterBillOpen] = useState(false);
  const [isPayBillsOpen, setIsPayBillsOpen] = useState(false);
  const [isWriteCheckOpen, setIsWriteCheckOpen] = useState(false);
  const [isJournalEntryOpen, setIsJournalEntryOpen] = useState(false);
  const [isNewCustomerOpen, setIsNewCustomerOpen] = useState(false);
  const [isNewVendorOpen, setIsNewVendorOpen] = useState(false);
  const [isNewItemOpen, setIsNewItemOpen] = useState(false);
  const [isNewEmployeeOpen, setIsNewEmployeeOpen] = useState(false);
  const [isOcrScannerOpen, setIsOcrScannerOpen] = useState(false);
  const [isIifImportOpen, setIsIifImportOpen] = useState(false);
  const [isStatementOpen, setIsStatementOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isPosModalOpen, setIsPosModalOpen] = useState(false);
  const [previewDocument, setPreviewDocument] = useState<DocumentPreviewModel | null>(null);
  const openDocumentPreview = (doc: DocumentPreviewModel) => setPreviewDocument(doc);
  const closeDocumentPreview = () => setPreviewDocument(null);
  const [primePreview, setPrimePreview] = useState<{ type: string; data: any; title?: string } | null>(null);
  const openPrimePreview = (type: string, data: any, title?: string) => setPrimePreview({ type, data, title });
  const closePrimePreview = () => setPrimePreview(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);
  const [tableDensity, setTableDensity] = useState<'compact' | 'comfortable'>('compact');
  const [activeShortcutNotice, setActiveShortcutNotice] = useState<ToastNotice | null>(null);
  const noticeTimerRef = React.useRef<number | null>(null);
  // Keeps the global key handler stable while always calling the latest notice fn.
  const triggerShortcutNoticeRef = React.useRef<(text: string, tone?: ToastTone) => void>(() => {});

  const triggerShortcutNotice = (text: string, tone: ToastTone = 'success') => {
    setActiveShortcutNotice({ text, tone });
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setActiveShortcutNotice(null);
    }, 3400);
  };

  triggerShortcutNoticeRef.current = triggerShortcutNotice;

  const dismissShortcutNotice = () => {
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
    }
    setActiveShortcutNotice(null);
  };

  // Sync theme class to document element
  useEffect(() => {
    const root = document.documentElement;
    if (companyProfile.theme === 'midnight') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [companyProfile.theme]);

  /**
   * Persist *presentation preferences only*.
   *
   * Financial records (invoices, bills, payroll, journals) are never written
   * to the browser. They are projections of the server ledger and are
   * re-fetched on demand.
   */
  useEffect(() => {
    const prefs: WorkspacePrefs = {
      theme: companyProfile.theme,
      phone: companyProfile.phone,
      email: companyProfile.email,
      website: companyProfile.website,
      address: companyProfile.address,
      cityStateZip: companyProfile.cityStateZip,
      defaultBankAccountId: companyProfile.defaultBankAccountId,
    };
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // quota or private mode
    }
  }, [
    companyProfile.theme,
    companyProfile.phone,
    companyProfile.email,
    companyProfile.website,
    companyProfile.address,
    companyProfile.cityStateZip,
    companyProfile.defaultBankAccountId,
  ]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const closeAllModals = () => {
      setIsNewInvoiceOpen(false);
      setIsReceivePaymentOpen(false);
      setIsEnterBillOpen(false);
      setIsPayBillsOpen(false);
      setIsWriteCheckOpen(false);
      setIsJournalEntryOpen(false);
      setIsNewCustomerOpen(false);
      setIsNewVendorOpen(false);
      setIsNewItemOpen(false);
      setIsNewEmployeeOpen(false);
      setIsOcrScannerOpen(false);
      setIsIifImportOpen(false);
      setIsStatementOpen(false);
      setIsCommandPaletteOpen(false);
      setIsPosModalOpen(false);
      setPreviewDocument(null);
      setPrimePreview(null);
      setIsMobileDrawerOpen(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement;
        if (
          target &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
        ) {
          target.blur();
        }
        closeAllModals();
        return;
      }

      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setIsCommandPaletteOpen(prev => !prev);
        return;
      }

      if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        setIsNewInvoiceOpen(true);
        triggerShortcutNoticeRef.current('New Invoice dialog opened (Alt+N)', 'info');
      } else if (e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setIsEnterBillOpen(true);
        triggerShortcutNoticeRef.current('Enter Vendor Bill dialog opened (Alt+B)', 'info');
      } else if (e.altKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        setIsWriteCheckOpen(true);
        triggerShortcutNoticeRef.current('Write Check dialog opened (Alt+W)', 'info');
      } else if (e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        setCurrentView('payroll');
        triggerShortcutNoticeRef.current('Navigated to Payroll Center (Alt+P)', 'info');
      } else if (e.altKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        setCurrentView('reports');
        triggerShortcutNoticeRef.current('Navigated to Financial Reports (Alt+R)', 'info');
      } else if (e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        setCompanyProfile(prev => ({
          ...prev,
          theme: prev.theme === 'midnight' ? 'classic' : 'midnight',
        }));
        triggerShortcutNoticeRef.current('Switched theme skin (Alt+D)', 'info');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Helper Lookups
  const getAccountById = (id: string) => accounts.find(a => a.id === id);
  const getCustomerById = (id: string) => customers.find(c => c.id === id);
  const getVendorById = (id: string) => vendors.find(v => v.id === id);
  const getInvoiceById = (id: string) => invoices.find(i => i.id === id);

  const updateCompanyProfile = (updates: Partial<CompanyProfile>) => {
    setCompanyProfile(prev => ({ ...prev, ...updates }));
  };

  const logAuditAction = async (
    action: string,
    entityType: string,
    entityId: string,
    details: string
  ) => {
    const timestamp = new Date().toISOString();
    const rawString = `${timestamp}|${companyProfile.name}|${action}|${entityType}|${entityId}|${details}`;
    const sha256Hash = await generateTamperEvidentHash(rawString);

    const newLog: AuditLog = {
      id: `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp,
      user: `${companyProfile.currentUserRole} (${companyProfile.email})`,
      action,
      entityType,
      entityId,
      details,
      sha256Hash,
    };
    setAuditLogs(prev => [newLog, ...prev]);
  };

  // 1. Chart of Accounts Management
  const addAccount = (accountData: Omit<Account, 'id'>): Account => {
    const newAccount: Account = {
      ...accountData,
      id: `acc-${Date.now()}`,
    };
    setAccounts(prev => [...prev, newAccount]);
    logAuditAction('CREATE_ACCOUNT', 'Account', newAccount.id, `Created account ${newAccount.code} - ${newAccount.name}`);
    accountingApi.createAccount({
      code: accountData.code || null,
      name: accountData.name,
      accountType: accountData.type as any,
      description: accountData.description,
      parentId: accountData.parentId ? Number(accountData.parentId) : null,
    }).then(() => { refreshAccountsFromBackend(); }).catch(() => { /* keep local fallback */ });
    return newAccount;
  };

  // 2. Customers Management
  const addCustomer = (customerData: Omit<Customer, 'id' | 'balance'>): Customer => {
    const newCustomer: Customer = {
      ...customerData,
      id: `cust-${Date.now()}`,
      balance: 0,
    };
    setCustomers(prev => [...prev, newCustomer]);
    logAuditAction('CREATE_CUSTOMER', 'Customer', newCustomer.id, `Added customer ${newCustomer.companyName || newCustomer.name}`);
    return newCustomer;
  };

  const updateCustomer = (id: string, updates: Partial<Customer>) => {
    setCustomers(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
  };

  // 3. Vendors Management
  const addVendor = (vendorData: Omit<Vendor, 'id' | 'balance'>): Vendor => {
    const newVendor: Vendor = {
      ...vendorData,
      id: `vend-${Date.now()}`,
      balance: 0,
    };
    setVendors(prev => [...prev, newVendor]);
    logAuditAction('CREATE_VENDOR', 'Vendor', newVendor.id, `Added vendor ${newVendor.companyName}`);
    return newVendor;
  };

  const updateVendor = (id: string, updates: Partial<Vendor>) => {
    setVendors(prev => prev.map(v => v.id === id ? { ...v, ...updates } : v));
  };

  // 4. Inventory Items Management (4 types + Unit Conversion + BOMs + Variants)
  const getRawUsageUnitCost = (rawMaterialId: string, itemsSnapshot?: InventoryItem[]): number => {
    return calcRawUsageUnitCost(rawMaterialId, itemsSnapshot || inventoryItems);
  };

  const computeBomUnitCost = (bomLines?: BomComponent[], itemsSnapshot?: InventoryItem[]): number => {
    return calcBomUnitCost(bomLines, itemsSnapshot || inventoryItems);
  };

  const getItemUnitCost = (item: InventoryItem, variantId?: string): number => {
    const variant = variantId ? item.variants?.find(v => v.id === variantId) : undefined;
    if (item.type === 'printed_product' || item.type === 'printing_service') {
      const effectiveBom =
        variant?.bomLines && variant.bomLines.length > 0
          ? variant.bomLines
          : item.bomLines;
      if (effectiveBom && effectiveBom.length > 0) {
        return computeBomUnitCost(effectiveBom);
      }
      return variant ? variant.cost : item.cost;
    }
    return variant ? variant.cost : item.cost;
  };

  const addInventoryItem = (itemData: Omit<InventoryItem, 'id'>): InventoryItem => {
    const isStocked = itemData.type === 'raw_material' || itemData.type === 'stationery';
    const supportsBom = itemData.type === 'printed_product' || itemData.type === 'printing_service';
    const supportsVariants = itemData.type === 'stationery' || itemData.type === 'printed_product';

    const cleanedVariants = supportsVariants && itemData.variants && itemData.variants.length > 0
      ? itemData.variants.map((v, idx) => ({
          ...v,
          id: v.id || `var-${Date.now()}-${idx}`,
          onHand: itemData.type === 'printed_product' ? 0 : (v.onHand || 0),
          reorderPoint: itemData.type === 'printed_product' ? 0 : (v.reorderPoint || 0),
          cost:
            itemData.type === 'printed_product' && v.bomLines && v.bomLines.length > 0
              ? computeBomUnitCost(v.bomLines)
              : v.cost,
        }))
      : undefined;

    const computedCost =
      supportsBom && itemData.bomLines && itemData.bomLines.length > 0
        ? computeBomUnitCost(itemData.bomLines)
        : cleanedVariants && itemData.type === 'printed_product'
        ? cleanedVariants[0].cost
        : itemData.cost;

    const totalStationeryOnHand =
      itemData.type === 'stationery' && cleanedVariants
        ? round2(cleanedVariants.reduce((s, v) => s + v.onHand, 0))
        : itemData.onHand;

    const newItem: InventoryItem = {
      ...itemData,
      id: `item-${Date.now()}`,
      cost: round2(computedCost),
      salesPrice: itemData.type === 'raw_material' ? 0 : itemData.salesPrice,
      onHand: isStocked ? totalStationeryOnHand : 0,
      reorderPoint: isStocked ? itemData.reorderPoint : 0,
      purchaseUnit: itemData.type === 'raw_material' ? (itemData.purchaseUnit || 'Ream') : undefined,
      usageUnit: itemData.type === 'raw_material' ? (itemData.usageUnit || 'Sheet') : undefined,
      conversionFactor:
        itemData.type === 'raw_material'
          ? Math.max(1, itemData.conversionFactor || 1)
          : undefined,
      bomLines: supportsBom ? itemData.bomLines || [] : undefined,
      variants: cleanedVariants,
    };
    setInventoryItems(prev => [...prev, newItem]);
    logAuditAction(
      'CREATE_ITEM',
      'InventoryItem',
      newItem.id,
      `Created ${newItem.type} item ${newItem.name} (${newItem.sku})`
    );
    return newItem;
  };

  const updateInventoryItem = (id: string, updates: Partial<InventoryItem>) => {
    setInventoryItems(prev => {
      const updatedList = prev.map(item => {
        if (item.id !== id) return item;
        const mergedType = updates.type || item.type;
        const isStocked = mergedType === 'raw_material' || mergedType === 'stationery';
        const supportsBom = mergedType === 'printed_product' || mergedType === 'printing_service';
        const supportsVariants = mergedType === 'stationery' || mergedType === 'printed_product';
        const nextBom = updates.bomLines !== undefined ? updates.bomLines : item.bomLines;
        const nextVariants = supportsVariants
          ? (updates.variants !== undefined ? updates.variants : item.variants)?.map(v => ({
              ...v,
              onHand: mergedType === 'printed_product' ? 0 : (v.onHand || 0),
              reorderPoint: mergedType === 'printed_product' ? 0 : (v.reorderPoint || 0),
            }))
          : undefined;

        const nextOnHand =
          mergedType === 'stationery' && nextVariants && nextVariants.length > 0
            ? round2(nextVariants.reduce((s, v) => s + (v.onHand || 0), 0))
            : isStocked
            ? (updates.onHand ?? item.onHand)
            : 0;

        return {
          ...item,
          ...updates,
          type: mergedType,
          cost: round2(updates.cost ?? item.cost),
          salesPrice: mergedType === 'raw_material' ? 0 : (updates.salesPrice ?? item.salesPrice),
          onHand: nextOnHand,
          reorderPoint: isStocked ? (updates.reorderPoint ?? item.reorderPoint) : 0,
          purchaseUnit: mergedType === 'raw_material' ? (updates.purchaseUnit ?? item.purchaseUnit ?? 'Unit') : undefined,
          usageUnit: mergedType === 'raw_material' ? (updates.usageUnit ?? item.usageUnit ?? 'Unit') : undefined,
          conversionFactor:
            mergedType === 'raw_material'
              ? Math.max(1, updates.conversionFactor ?? item.conversionFactor ?? 1)
              : undefined,
          bomLines: supportsBom ? nextBom : undefined,
          variants: nextVariants,
        };
      });
      // Propagate any raw material cost / conversion changes down to Printed Products & Printing Services
      return recalculateDependentItemCosts(updatedList);
    });
    logAuditAction('UPDATE_ITEM', 'InventoryItem', id, `Updated item ${id} and synced dependent costs`);
  };

  const adjustInventoryStock = (itemId: string, adjustmentQty: number, reason: string) => {
    setInventoryItems(prev =>
      prev.map(item => {
        if (item.id === itemId && (item.type === 'raw_material' || item.type === 'stationery')) {
          const newQty = Math.max(0, round4(item.onHand + adjustmentQty));
          return { ...item, onHand: newQty };
        }
        return item;
      })
    );
    logAuditAction(
      'ADJUST_INVENTORY',
      'InventoryItem',
      itemId,
      `Adjusted stock by ${adjustmentQty > 0 ? '+' : ''}${adjustmentQty} (${reason})`
    );
  };

  // 5. Invoicing & Accounts Receivable (Variants + BOM Raw-Material Unit Conversion + Real Gross Profit)
  const addInvoice = async (
    invoiceData: Omit<Invoice, 'id' | 'invoiceNumber' | 'status' | 'amountPaid' | 'balanceDue'> & {
      invoiceNumber?: string;
    }
  ): Promise<Invoice> => {
    // Safety guard: filter out any raw_material lines if injected externally
    const validLines = invoiceData.lines
      .filter(line => {
        if (!line.itemId) return true;
        const item = inventoryItems.find(i => i.id === line.itemId);
        return !item || INVOICEABLE_ITEM_TYPES.includes(item.type);
      })
      .map(line => {
        if (!line.itemId) {
          const unitCost = line.unitCost ?? 0;
          const totalCost = line.totalCost ?? round2(unitCost * line.quantity);
          return { ...line, unitCost, totalCost };
        }
        const item = inventoryItems.find(i => i.id === line.itemId);
        if (!item) return line;
        const variant = line.variantId ? item.variants?.find(v => v.id === line.variantId) : undefined;
        const unitCost = line.unitCost !== undefined ? line.unitCost : getItemUnitCost(item, line.variantId);
        const totalCost = line.totalCost !== undefined ? line.totalCost : round2(unitCost * line.quantity);
        return {
          ...line,
          variantName: line.variantName || variant?.name,
          unitCost: round4(unitCost),
          totalCost,
        };
      });

    const subtotal = round2(validLines.reduce((s, l) => s + l.amount, 0));
    const taxableSubtotal = validLines.filter(l => l.taxable).reduce((s, l) => s + l.amount, 0);
    const taxAmount = round2(taxableSubtotal * (invoiceData.taxRate ?? companyProfile.salesTaxRate));
    const total = round2(subtotal + taxAmount);
    const invoiceTotalCost = round2(validLines.reduce((s, l) => s + (l.totalCost || 0), 0));
    const grossProfit = round2(subtotal - invoiceTotalCost);

    const invoiceNum = invoiceData.invoiceNumber || `INV-${1000 + invoices.length + 1}`;
    const newInvoice: Invoice = {
      ...invoiceData,
      lines: validLines,
      subtotal,
      taxAmount,
      total,
      totalCost: invoiceTotalCost,
      grossProfit,
      id: `inv-${Date.now()}`,
      invoiceNumber: invoiceNum,
      status: 'sent',
      amountPaid: 0,
      balanceDue: total,
      backendInvoiceId: invoiceData.backendInvoiceId,
    };

    setInvoices(prev => [newInvoice, ...prev]);

    // Update customer balance
    setCustomers(prev =>
      prev.map(c =>
        c.id === invoiceData.customerId
          ? { ...c, balance: round2(c.balance + total) }
          : c
      )
    );

    // Compute aggregated stock deductions & COGS across Stationery (incl. variants) + Printed Product & Printing Service BOMs
    const rawPurchaseUnitDeductions: Record<string, number> = {};
    const stationeryParentDeductions: Record<string, number> = {};
    const stationeryVariantDeductions: Record<string, Record<string, number>> = {};
    let totalCogsAdjustment = 0;

    validLines.forEach(line => {
      if (!line.itemId) {
        totalCogsAdjustment += round2(line.totalCost || 0);
        return;
      }
      const item = inventoryItems.find(i => i.id === line.itemId);
      if (!item) return;

      const variant = line.variantId ? item.variants?.find(v => v.id === line.variantId) : undefined;

      if (item.type === 'stationery') {
        if (variant) {
          stationeryVariantDeductions[item.id] = stationeryVariantDeductions[item.id] || {};
          stationeryVariantDeductions[item.id][variant.id] =
            (stationeryVariantDeductions[item.id][variant.id] || 0) + line.quantity;
          totalCogsAdjustment += round2(line.quantity * variant.cost);
        } else {
          stationeryParentDeductions[item.id] = (stationeryParentDeductions[item.id] || 0) + line.quantity;
          totalCogsAdjustment += round2(line.quantity * item.cost);
        }
      } else if (item.type === 'printed_product' || item.type === 'printing_service') {
        // Deduct raw materials via BOM using exact purchaseUnit conversion!
        const effectiveBom =
          variant?.bomLines && variant.bomLines.length > 0 ? variant.bomLines : item.bomLines;
        if (effectiveBom && effectiveBom.length > 0) {
          effectiveBom.forEach(bom => {
            const rawItem = inventoryItems.find(r => r.id === bom.rawMaterialId);
            if (rawItem) {
              const factor =
                rawItem.conversionFactor && rawItem.conversionFactor > 0
                  ? rawItem.conversionFactor
                  : 1;
              const usageQty = bom.quantityPerUnit * line.quantity;
              const purchaseQty = usageQty / factor;
              rawPurchaseUnitDeductions[rawItem.id] =
                (rawPurchaseUnitDeductions[rawItem.id] || 0) + purchaseQty;
              totalCogsAdjustment += round2(usageQty * (rawItem.cost / factor));
            }
          });
        } else {
          totalCogsAdjustment += round2(line.quantity * getItemUnitCost(item, line.variantId));
        }
      }
    });

    if (
      Object.keys(rawPurchaseUnitDeductions).length > 0 ||
      Object.keys(stationeryParentDeductions).length > 0 ||
      Object.keys(stationeryVariantDeductions).length > 0
    ) {
      setInventoryItems(prev =>
        prev.map(item => {
          if (item.type === 'raw_material') {
            const deduct = rawPurchaseUnitDeductions[item.id];
            if (!deduct) return item;
            return {
              ...item,
              onHand: Math.max(0, round4(item.onHand - deduct)),
            };
          }
          if (item.type === 'stationery') {
            const varDeducts = stationeryVariantDeductions[item.id];
            if (varDeducts && item.variants && item.variants.length > 0) {
              const nextVariants = item.variants.map(v => {
                const vd = varDeducts[v.id] || 0;
                return vd ? { ...v, onHand: Math.max(0, round2(v.onHand - vd)) } : v;
              });
              const nextTotal = round2(nextVariants.reduce((s, v) => s + v.onHand, 0));
              return { ...item, variants: nextVariants, onHand: nextTotal };
            }
            const pDeduct = stationeryParentDeductions[item.id];
            if (!pDeduct) return item;
            return { ...item, onHand: Math.max(0, round2(item.onHand - pDeduct)) };
          }
          return item;
        })
      );
    }

    totalCogsAdjustment = round2(totalCogsAdjustment);

    // Update Chart of Accounts balances:
    // Debit A/R (+total), Credit Sales (+subtotal), Credit Tax Payable (+taxAmount)
    // Plus Perpetual Inventory COGS: Debit 5010 (+COGS), Credit 1300 (-COGS)
    setAccounts(prev =>
      prev.map(acc => {
        if (acc.code === '1200') {
          return { ...acc, balance: round2(acc.balance + newInvoice.total) };
        }
        if (acc.code === '4010') {
          return { ...acc, balance: round2(acc.balance + newInvoice.subtotal) };
        }
        if (acc.code === '2200' && newInvoice.taxAmount > 0) {
          return { ...acc, balance: round2(acc.balance + newInvoice.taxAmount) };
        }
        if (acc.code === '5010' && totalCogsAdjustment > 0) {
          return { ...acc, balance: round2(acc.balance + totalCogsAdjustment) };
        }
        if (acc.code === '1300' && totalCogsAdjustment > 0) {
          return { ...acc, balance: round2(acc.balance - totalCogsAdjustment) };
        }
        return acc;
      })
    );

    await logAuditAction(
      'CREATE_INVOICE',
      'Invoice',
      newInvoice.id,
      `Created ${newInvoice.invoiceNumber} (${getCurrencySymbol(companyProfile.currency)}${newInvoice.total.toFixed(2)}, Profit: ${getCurrencySymbol(companyProfile.currency)}${grossProfit.toFixed(2)})`
    );

    return newInvoice;
  };

  const markInvoicePaid = async (invoiceId: string, paymentMethod: string = 'Check') => {
    const inv = invoices.find(i => i.id === invoiceId);
    if (!inv || inv.balanceDue <= 0) return;

    await recordPaymentReceived({
      customerId: inv.customerId,
      invoiceId: inv.id,
      date: new Date().toISOString().split('T')[0],
      amount: inv.balanceDue,
      paymentMethod: paymentMethod as any,
      referenceNumber: `PMT-${Date.now().toString().slice(-4)}`,
      depositToAccountId: companyProfile.defaultBankAccountId,
      memo: `Paid in full for ${inv.invoiceNumber}`,
    });
  };

  // 5A. Quick Photocopy, Type & Printing Desk (Shared Paper & Toner Engine + Per-Page Extra Cost + Per-Sheet Selling Price)
  const addQuickPrintJob = async (
    jobData: Omit<
      QuickPrintJob,
      | 'id'
      | 'jobNumber'
      | 'sheetsUsed'
      | 'impressionsUsed'
      | 'paperCost'
      | 'tonerCost'
      | 'totalCost'
      | 'profit'
      | 'sellingPriceTotal'
      | 'extraCost'
    > & { extraCost?: number; sellingPriceTotal?: number },
    options?: { createInvoice?: boolean; idempotencyKey?: string }
  ): Promise<QuickPrintJob> => {
    // Authoritative server-side quick-print sale. The browser no longer
    // manufactures production, stock, invoice, payment or journal records; it
    // posts the desk inputs to the server (one atomic transaction) and renders
    // the authoritative result. The idempotency key is owned by the caller so a
    // retry of the same logical operation replays the original committed sale.
    const idempotencyKey =
      options?.idempotencyKey || `qp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const mode: 'on_account' | 'cash' = options?.createInvoice ? 'on_account' : 'cash';

    const result = await printingApi.postQuickSale({
      mode,
      jobType: jobData.jobType,
      customerId: jobData.customerId != null && jobData.customerId !== '' ? Number(jobData.customerId) : null,
      customerName: jobData.customerName,
      rawPaperItemId: Number(jobData.rawPaperItemId),
      rawTonerItemId: Number(jobData.rawTonerItemId),
      title: jobData.title,
      pages: Math.max(1, jobData.pages),
      copies: Math.max(1, jobData.copies),
      printSide: jobData.printSide as 'Single-Sided' | 'Duplex',
      typingFeeMode: jobData.jobType === 'type_and_printing' ? 'per_page' : undefined,
      typingFeeRate: jobData.extraCostPerPage,
      finishingCost: jobData.jobType === 'type_and_printing' ? undefined : jobData.extraCost,
      manualSellingPrice: jobData.sellingPriceTotal,
      manualSellingPricePerSheet: jobData.sellingPricePerSheet,
      jobDate: jobData.date,
      notes: jobData.notes,
      idempotencyKey,
    });

    const j = result.job;
    const created: QuickPrintJob = {
      ...jobData,
      id: `qp-${j.id}`,
      backendJobId: j.id,
      jobNumber: j.jobNumber,
      pages: j.pages,
      copies: j.copies,
      printSide: j.printSide as 'Single-Sided' | 'Duplex',
      sheetsUsed: j.sheetsUsed,
      impressionsUsed: j.impressionsUsed,
      paperCost: j.paperCost,
      tonerCost: j.tonerCost,
      extraCostPerPage: jobData.extraCostPerPage,
      typingFee: jobData.typingFee,
      extraCost: jobData.extraCost ?? 0,
      totalCost: j.totalCost,
      sellingPricePerSheet:
        j.sheetsUsed > 0 ? round4(j.manualSellingPrice / j.sheetsUsed) : jobData.sellingPricePerSheet,
      sellingPriceTotal: j.manualSellingPrice,
      profit: j.profit,
      invoiceId: result.invoice.invoiceNumber,
      backendInvoiceId: result.invoice.id,
      linkedInvoiceNumber: result.invoice.invoiceNumber,
    };

    setQuickPrintJobs(prev => [created, ...prev]);
    await logAuditAction(
      'CREATE_QUICK_PRINT_JOB',
      'QuickPrintJob',
      created.id,
      `Recorded ${j.jobNumber} (${created.jobType}) — Cost: ${getCurrencySymbol(companyProfile.currency)}${j.totalCost.toFixed(2)}, Sale: ${getCurrencySymbol(companyProfile.currency)}${j.manualSellingPrice.toFixed(2)}, Profit: ${getCurrencySymbol(companyProfile.currency)}${j.profit.toFixed(2)}`
    );

    return created;
  };

  // 5B. Examination Printing Module (Per-Learner Class Pricing + Shared Paper & Toner Engine)
  const buildExamPaperComputedFields = (
    paperData: Omit<
      ExamPaper,
      'id' | 'jobNumber' | 'totalAmount' | 'sheetsUsed' | 'impressionsUsed' | 'paperCost' | 'tonerCost' | 'materialCost'
    >
  ) => {
    const rawPaper = paperData.rawPaperItemId
      ? inventoryItems.find(i => i.id === paperData.rawPaperItemId && i.type === 'raw_material')
      : undefined;
    const rawToner = paperData.rawTonerItemId
      ? inventoryItems.find(i => i.id === paperData.rawTonerItemId && i.type === 'raw_material')
      : undefined;

    if (rawPaper && rawToner) {
      const wf = calculateExaminationProductionWorkflow([
        {
          subjectName: paperData.subjectName,
          className: paperData.className,
          assessmentName: paperData.assessmentName,
          learnersCount: paperData.learnersCount,
          pricePerLearner: paperData.pricePerLearner,
          pages: paperData.pages,
          copies: paperData.copies,
          mode: paperData.printSide === 'Duplex' ? 'duplex' : 'simplex',
          paperStock: buildPaperStockFromInventoryItem(rawPaper),
          tonerChannels: { K: buildTonerSpecFromInventoryItem(rawToner, 'K') },
          machine: WORKSPACE_PRESS_CAPABILITY,
          colorMode: 'mono',
          allowInsufficientStockPreview: true,
        },
      ]);
      const pRes = wf.papers[0];
      return {
        sheetsUsed: pRes.sheetsUsed,
        impressionsUsed: pRes.impressionsUsed,
        paperCost: pRes.paperCost,
        tonerCost: pRes.tonerCost,
        materialCost: pRes.materialCost,
        totalAmount: pRes.classBillingAmount,
      };
    }

    const totalAmount = round2(paperData.learnersCount * paperData.pricePerLearner);
    if (rawPaper) {
      const wf = calculatePhotocopyWorkflow({
        paperStock: buildPaperStockFromInventoryItem(rawPaper),
        tonerChannels: {
          K: {
            itemId: 'unselected-toner',
            name: 'Unselected Toner',
            channel: 'K',
            cartridgeCost: 0,
            ratedYieldImpressions: 1,
          },
        },
        machine: WORKSPACE_PRESS_CAPABILITY,
        colorMode: 'mono',
        copies: paperData.copies,
        mode: paperData.printSide === 'Duplex' ? 'duplex' : 'simplex',
        pages: paperData.pages,
        allowInsufficientStockPreview: true,
      });
      const sheetsUsed = wf.paper.quantities.totalSheets;
      const impressionsUsed = wf.paper.quantities.printedSideImpressions;
      const paperCost = wf.paper.quantities.totalPaperCost;
      return {
        sheetsUsed,
        impressionsUsed,
        paperCost,
        tonerCost: 0,
        materialCost: paperCost,
        totalAmount,
      };
    }

    const sheetsUsed =
      (paperData.printSide === 'Duplex' ? Math.ceil(paperData.pages / 2) : paperData.pages) *
      paperData.copies;
    const impressionsUsed = paperData.pages * paperData.copies;
    return {
      sheetsUsed,
      impressionsUsed,
      paperCost: 0,
      tonerCost: 0,
      materialCost: 0,
      totalAmount,
    };
  };

  const addExamPaper = (
    paperData: Omit<
      ExamPaper,
      'id' | 'jobNumber' | 'totalAmount' | 'sheetsUsed' | 'impressionsUsed' | 'paperCost' | 'tonerCost' | 'materialCost'
    >
  ): ExamPaper => {
    const computed = buildExamPaperComputedFields(paperData);
    const jobNum = `EXM-${new Date().getFullYear()}-${100 + examPapers.length + 1}`;

    const newPaper: ExamPaper = {
      ...paperData,
      ...computed,
      id: `exm-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      jobNumber: jobNum,
    };

    setExamPapers(prev => [newPaper, ...prev]);
    logAuditAction(
      'CREATE_EXAM_JOB',
      'ExamPaper',
      newPaper.id,
      `Queued exam print job ${jobNum}: ${newPaper.className} (${newPaper.learnersCount} learners @ ${getCurrencySymbol(companyProfile.currency)}${newPaper.pricePerLearner}) · ${newPaper.subjectName}`
    );
    return newPaper;
  };

  const addExamPapersBatch = async (
    papersData: Omit<
      ExamPaper,
      'id' | 'jobNumber' | 'totalAmount' | 'sheetsUsed' | 'impressionsUsed' | 'paperCost' | 'tonerCost' | 'materialCost'
    >[],
    options?: { submissionId?: string }
  ): Promise<ExamPaper[]> => {
    // Ensure all referenced ids are real backend records
    const backendCustomerId = toBackendId(papersData[0]?.schoolCustomerId);
    if (!backendCustomerId) {
      throw new Error('All referenced customer and material ids must be real backend records. No local records were created.');
    }

    const allServerIds =
      papersData.length > 0 &&
      papersData.every(p => toBackendId(p.rawPaperItemId) && toBackendId(p.rawTonerItemId));
    if (!allServerIds) {
      throw new Error('All referenced material ids must be real backend records. No local records were created.');
    }

    // Server-side creation
    const sample = papersData[0];
    const grouped = new Map<string, typeof papersData>();
    for (const paper of papersData) {
      const key = `${paper.className.trim().toLowerCase()}__${paper.assessmentName.trim().toLowerCase()}`;
      const rows = grouped.get(key) || [];
      rows.push(paper);
      grouped.set(key, rows);
    }
    const classes = Array.from(grouped.values()).map(rows => {
      const lead = rows[0];
      return {
        className: lead.className,
        learnersCount: lead.learnersCount,
        pricePerLearner: lead.pricePerLearner,
        contractId: toBackendId(lead.contractId),
        assessmentNumber: lead.assessmentNumber ?? null,
        papers: rows.map(p => ({
          subjectName: p.subjectName,
          pages: p.pages,
          copies: p.copies,
          rawPaperItemId: toBackendId(p.rawPaperItemId)!,
          rawTonerItemId: toBackendId(p.rawTonerItemId)!,
          printSide: p.printSide,
          bindingType: p.bindingType,
          paperSize: p.paperSize,
          printingItemId: toBackendId(p.printingItemId),
          productionDate: p.productionDate,
          notes: p.notes ?? null,
        })),
      };
    });
    let hash = 0;
    const seed = `${backendCustomerId}|${sample.assessmentName}|${options?.submissionId || ''}|${papersData
      .map(p => `${p.className}|${p.subjectName}|${p.pages}|${p.copies}`)
      .join(';')}`;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    const res = await printingApi.createExamBatch({
      schoolCustomerId: backendCustomerId,
      assessmentName: sample.assessmentName,
      classes,
      idempotencyKey: `exam-batch-${backendCustomerId}-${Math.abs(hash)}`,
    });
    const serverPapers: any[] = res?.papers || [];
    const byKey = new Map<string, any>();
    for (const sp of serverPapers) {
      byKey.set(`${String(sp.className).toLowerCase()}__${String(sp.subjectName).toLowerCase()}`, sp);
    }
    const created: ExamPaper[] = papersData.map((paperData, idx) => {
      const sp = byKey.get(
        `${paperData.className.trim().toLowerCase()}__${paperData.subjectName.trim().toLowerCase()}`
      );
      if (!sp?.backendId) {
        throw new Error(
          `Server did not return the created examination paper for ${paperData.className} · ${paperData.subjectName}. No local record was created.`
        );
      }
      return {
        ...paperData,
        id: String(sp.backendId),
        backendId: Number(sp.backendId),
        jobNumber: sp.jobNumber,
        paperSize: sp.paperSize ?? paperData.paperSize,
        printingItemId: sp.printingItemId ?? paperData.printingItemId,
        productionJobId: sp.productionJobId,
        sheetsUsed: Number(sp.sheetsUsed ?? 0),
        impressionsUsed: Number(sp.impressionsUsed ?? 0),
        paperCost: Number(sp.paperCost ?? 0),
        tonerCost: Number(sp.tonerCost ?? 0),
        materialCost: Number(sp.materialCost ?? 0),
        costStatus: sp.costStatus,
        costWarnings: Array.isArray(sp.costWarnings) ? sp.costWarnings : [],
        totalAmount: Number(sp.totalAmount ?? 0),
        status: (sp.status ?? 'queued') as ExamPaperStatus,
        productionDate: sp.productionDate ?? paperData.productionDate,
      };
    });
    setExamPapers(prev => [...created.slice().reverse(), ...prev]);
    await logAuditAction(
      'BATCH_EXAM_JOBS',
      'ExamPaper',
      created[0]?.id || 'batch',
      `Added ${created.length} class/subject examination print jobs`
    );
    return created;
  };

  // ---- Examination batch group: one-click production & invoicing ----
  // Drives the durable server-side checkpoints in order. Each checkpoint is
  // independently idempotent on the server, so a retry never duplicates jobs,
  // delivery notes, inventory movement, accounting entries or the invoice.
  const listExamGroups = (params?: { schoolCustomerId?: number | null; assessmentName?: string | null }): Promise<any[]> =>
    printingApi.listExamGroups(params);

  const getExamGroupForBatch = (batchId: number): Promise<any> => printingApi.getExamGroupForBatch(batchId);

  const getExamGroupSummary = (groupId: number): Promise<any> =>
    printingApi.getExamGroupSummary(groupId);

  const runExamGroupWorkflow = async (
    groupId: number,
    options?: {
      goodCopiesByPaper?: Record<string, number>;
      spoiledCopiesByPaper?: Record<string, number>;
      dispatchDate?: string | null;
      recipientName?: string | null;
      includeTax?: boolean;
      taxRate?: number;
      notes?: string | null;
      onProgress?: (step: string, summary: any) => void;
    }
  ): Promise<any> => {
    const key = (suffix: string) => `exam-group-${groupId}-${suffix}`;
    let summary = await printingApi.generateExamGroupProduction(groupId, key('generate'));
    options?.onProgress?.('production', summary);
    summary = await printingApi.completeExamGroupProduction(groupId, {
      idempotencyKey: key('production'),
      goodCopiesByPaper: options?.goodCopiesByPaper,
      spoiledCopiesByPaper: options?.spoiledCopiesByPaper,
    });
    options?.onProgress?.('qc', summary);
    summary = await printingApi.approveExamGroupQc(groupId, { idempotencyKey: key('qc') });
    options?.onProgress?.('delivery', summary);
    summary = await printingApi.deliverExamGroupChildren(groupId, {
      idempotencyKey: key('deliver'),
      dispatchDate: options?.dispatchDate ?? null,
      recipientName: options?.recipientName ?? null,
    });
    options?.onProgress?.('invoice', summary);
    summary = await printingApi.postExamGroupInvoice(groupId, {
      idempotencyKey: key('invoice'),
      includeTax: options?.includeTax,
      taxRate: options?.taxRate,
      notes: options?.notes,
    });
    await refreshExamPapersFromBackend();
    options?.onProgress?.('completed', summary);
    return summary;
  };

  const updateExamPaper = (paperId: string, updates: Partial<ExamPaper>) => {
    setExamPapers(prev =>
      prev.map(p => {
        if (p.id !== paperId) return p;
        const merged = { ...p, ...updates };
        const computed = buildExamPaperComputedFields(merged);
        return { ...merged, ...computed };
      })
    );
  };

  // Edit a backend examination paper's details before production begins. The
  // server enforces the guardrails (queued only, spec not frozen, teacher copies
  // fixed); the browser never simulates the change locally.
  const editExamPaper = async (
    paperId: string,
    updates: {
      subjectName?: string;
      pages?: number;
      copies?: number;
      printSide?: string;
      bindingType?: string;
      paperSize?: string;
      productionDate?: string | null;
      notes?: string | null;
      reason?: string | null;
    }
  ): Promise<ExamPaper> => {
    const target = examPapers.find(p => p.id === paperId);
    if (!target) throw new Error(`Examination paper ${paperId} was not found.`);
    const backendId = toBackendId(paperId);
    if (!backendId) {
      throw new Error('Only backend examination papers can be edited.');
    }
    const updated = await printingApi.updateExamPaper(backendId, {
      ...updates,
      idempotencyKey: `exam-edit-${backendId}-${Date.now()}`,
    });
    await refreshExamPapersFromBackend();
    const mapped = updated as ExamPaper;
    setExamPapers(prev =>
      prev.map(p => (p.id === paperId ? { ...p, ...mapped, id: p.id } : p))
    );
    return mapped;
  };

  const updateExamPaperStatus = async (
    paperId: string,
    nextStatus: ExamPaperStatus,
    options: {
      reason?: string | null;
      goodCopies?: number;
      spoiledCopies?: number;
      packageCount?: number;
      sealReference?: string | null;
      qcNotes?: string | null;
    } = {}
  ) => {
    const target = examPapers.find(p => p.id === paperId);
    if (!target || target.status === nextStatus) return;

    // Backend-confirmed papers must be transitioned by the server. The server
    // drives the linked printing job, inventory movements and WIP journal; the
    // browser must never simulate stock or COGS for them.
    if (target.backendId) {
      const serverStatuses = ['queued', 'printing', 'completed', 'qc_hold', 'qc_passed', 'packed', 'dispatched'];
      if (!serverStatuses.includes(nextStatus)) {
        throw new Error(`Unsupported server transition: ${nextStatus}`);
      }
      await printingApi.updateExamPaperStatus(target.backendId, nextStatus as any, options);
      await refreshExamPapersFromBackend();
    }

    setExamPapers(prev =>
      prev.map(p => (p.id === paperId ? { ...p, status: nextStatus } : p))
    );

    await logAuditAction(
      'UPDATE_EXAM_STATUS',
      'ExamPaper',
      paperId,
      `Exam job ${target.jobNumber} (${target.className} · ${target.subjectName}) marked ${nextStatus}`
    );
  };

  const deliverExamPaper = async (
    paperId: string,
    input: {
      dispatchDate?: string | null;
      recipientName?: string | null;
      driverName?: string | null;
      vehicleReg?: string | null;
      notes?: string | null;
    } = {}
  ) => {
    const target = examPapers.find(p => p.id === paperId);
    if (!target) throw new Error('Examination paper not found');
    if (!target.backendId) throw new Error('Delivery requires a server-confirmed examination paper');
    await printingApi.deliverExamPaper(target.backendId, input);
    setExamPapers(prev =>
      prev.map(p =>
        p.id === paperId
          ? { ...p, status: 'delivered', deliveredAt: new Date().toISOString() }
          : p
      )
    );
  };

  const deleteExamPaper = async (paperId: string) => {
    const target = examPapers.find(p => p.id === paperId);
    if (!target) return;
    if (target.backendId) {
      await printingApi.deleteExamPaper(target.backendId);
    }
    setExamPapers(prev => prev.filter(p => p.id !== paperId));
  };

  const cancelExamPaper = async (
    paperId: string,
    options: { reason: string; returnUnusedMaterials?: boolean }
  ) => {
    const target = examPapers.find(p => p.id === paperId);
    if (!target) throw new Error('Examination paper not found');
    if (!target.backendId) {
      throw new Error('Cancellation requires a server-confirmed examination paper');
    }
    await printingApi.cancelExamPaper(target.backendId, options);
    setExamPapers(prev =>
      prev.map(p =>
        p.id === paperId
          ? { ...p, status: 'cancelled', cancelledAt: new Date().toISOString() }
          : p
      )
    );
    await logAuditAction(
      'CANCEL_EXAM_PAPER',
      'ExamPaper',
      paperId,
      `Cancelled ${target.jobNumber}: ${options.reason}`
    );
  };

  const reprintExamPaper = async (
    paperId: string,
    options: { reason: string; copies?: number; productionDate?: string | null }
  ) => {
    const target = examPapers.find(p => p.id === paperId);
    if (!target) throw new Error('Examination paper not found');
    if (!target.backendId) {
      throw new Error('A reprint requires a server-confirmed examination paper');
    }
    const result = await printingApi.reprintExamPaper(target.backendId, {
      ...options,
      idempotencyKey: `exam-reprint-${target.backendId}-${Date.now()}`,
    });
    await refreshExamPapersFromBackend();
    return result;
  };

  const getExamPaperEvents = async (paperId: string) => {
    const target = examPapers.find(p => p.id === paperId);
    if (!target?.backendId) return [];
    return printingApi.listExamPaperEvents(target.backendId);
  };

  const approveExamBatchSpec = async (batchId: number, notes?: string | null) => {
    const result = await printingApi.approveExamBatchSpec(batchId, notes);
    await refreshExamPapersFromBackend();
    return result;
  };

  const getExamReconciliation = async () => printingApi.getExamReconciliation();

  const createConsolidatedSchoolInvoice = async (
    examPaperIds: string[],
    options?: ConsolidatedExamInvoiceOptions
  ): Promise<Invoice | null> => {
    const selectedPapers = examPapers.filter(
      p => examPaperIds.includes(p.id) && p.status !== 'invoiced'
    );
    if (selectedPapers.length === 0) return null;

    // Invoice eligibility is a server rule, mirrored here for UX. A paper must
    // have been produced, QC-approved and delivered before it can be billed.
    const notDelivered = selectedPapers.filter(p => p.status !== 'delivered');
    if (notDelivered.length > 0) {
      throw new Error(
        `Cannot invoice ${notDelivered.length} examination paper(s) before delivery: ${notDelivered
          .map(p => `${p.jobNumber} (${p.status})`)
          .join(', ')}`
      );
    }

    const schoolId = selectedPapers[0].schoolCustomerId;
    const sameSchool = selectedPapers.every(p => p.schoolCustomerId === schoolId);
    if (!sameSchool) {
      throw new Error('All selected examination papers must belong to the same school');
    }

    // P1-05: Never silently fall back to a local invoice. Every selected paper
    // must have a real backend record; otherwise the server cannot relieve WIP,
    // link the invoice, or post the COGS journal, and a local-only invoice would
    // report success while leaving the ledger inconsistent.
    const missingBackend = selectedPapers.filter(p => !p.backendId);
    if (missingBackend.length > 0) {
      throw new Error(
        `Cannot create a consolidated invoice: ${missingBackend.length} examination paper(s) have no backend record. ` +
          `All papers must be created on the server before invoicing: ${missingBackend
            .map(p => `${p.jobNumber} (${p.className} · ${p.subjectName})`)
            .join(', ')}`
      );
    }
    const useBackend = true;

    const school = customers.find(c => c.id === schoolId);
    const includeTax = options?.includeTax ?? false;

    // Group selected papers by Class Name (billing is PER LEARNER IN EACH CLASS, not per subject!)
    const classGroups = new Map<string, ExamPaper[]>();
    selectedPapers.forEach(paper => {
      const key = `${paper.className}__${paper.assessmentName}`;
      const list = classGroups.get(key) || [];
      list.push(paper);
      classGroups.set(key, list);
    });

    const lines: InvoiceLine[] = Array.from(classGroups.values()).map((group, idx) => {
      const lead = group[0];
      const learners = lead.learnersCount || lead.copies;
      const ratePerLearner = lead.pricePerLearner;
      const classAmount = round2(learners * ratePerLearner);
      const classMaterialCost = round2(group.reduce((s, p) => s + (p.materialCost || 0), 0));
      // Backend invoices must carry zero item-less line cost: the server posts
      // exact WIP→COGS relief from the linked production jobs. Keeping a
      // material cost on the line would double-count COGS and gross profit.
      const unitCostPerLearner = useBackend || learners <= 0 ? 0 : round4(classMaterialCost / learners);
      const subjectSummary = group.map(p => `${p.subjectName} (${p.pages}pp)`).join(', ');
      return {
        id: `exl-${Date.now()}-${idx}`,
        // Leave itemId undefined so addInvoice does not apply generic BOM double-deduction
        // (paper + toner usage is tracked & deducted cleanly via ExamPaper production)
        description: `${lead.className} (${lead.assessmentName}) — ${learners} learners · Subjects: ${subjectSummary}`,
        quantity: learners,
        rate: ratePerLearner,
        amount: classAmount,
        unitCost: unitCostPerLearner,
        totalCost: useBackend ? 0 : classMaterialCost,
        taxable: includeTax,
      };
    });

    const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const taxRate = includeTax ? companyProfile.salesTaxRate : 0;
    const taxAmount = round2(subtotal * taxRate);
    const total = round2(subtotal + taxAmount);
    const totalCost = round2(lines.reduce((s, l) => s + (l.totalCost || 0), 0));
    const grossProfit = round2(subtotal - totalCost);

    const today = new Date().toISOString().split('T')[0];
    const due = new Date();
    due.setDate(due.getDate() + 30);

    const classesList = Array.from(new Set(selectedPapers.map(p => p.className))).join(', ');
    const assessmentNames = Array.from(new Set(selectedPapers.map(p => p.assessmentName))).join(' / ');

    const contract = options?.contractId
      ? printingContracts.find(c => c.id === options.contractId)
      : undefined;

    let backendInvoiceId: number | undefined;
    let backendInvoiceNumber: string | undefined;

    if (useBackend) {
      const backendCustomerId = toBackendId(schoolId);
      const generated = await documentsApi.generateWorkflowInvoice({
        sourceKind: 'exam_batch',
        sourceRef: selectedPapers.map(p => p.jobNumber).join(','),
        customerId: backendCustomerId,
        customerName: school?.companyName || school?.name || 'School Institution',
        customerEmail: school?.email,
        customerPhone: school?.phone,
        customerAddress: school?.billingAddress,
        customerType: school?.customerType || 'school',
        invoiceDate: today,
        dueDate: due.toISOString().split('T')[0],
        terms: school?.terms || 'Net 30',
        taxRate: includeTax ? Math.round(companyProfile.salesTaxRate * 10000) / 100 : 0,
        notes:
          options?.notes ||
          `Consolidated school examination invoice (per-learner class pricing) for ${school?.companyName || 'School'} (${classesList}) — ${assessmentNames}.${
            contract ? ` Applied to Printing Contract ${contract.contractNumber} Assessment #${options?.assessmentNumber}.` : ''
          }`,
        idempotencyKey: `exam-invoice-${selectedPapers
          .map(p => p.backendId)
          .sort((a, b) => Number(a) - Number(b))
          .join('-')}`,
        postgresExamPaperIds: selectedPapers.map(p => Number(p.backendId)),
        lines: lines.map(l => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          unitCost: 0,
          taxable: l.taxable,
        })),
      });
      backendInvoiceId = generated.invoice.id;
      backendInvoiceNumber = generated.invoice.invoiceNumber;
    }

    const createdInvoice = await addInvoice({
      customerId: schoolId,
      date: today,
      dueDate: due.toISOString().split('T')[0],
      terms: school?.terms || 'Net 30',
      invoiceNumber: backendInvoiceNumber,
      backendInvoiceId,
      lines,
      subtotal,
      taxRate,
      taxAmount,
      total,
      totalCost: useBackend ? 0 : totalCost,
      grossProfit: useBackend ? subtotal : grossProfit,
      notes:
        options?.notes ||
        `Consolidated school examination invoice (per-learner class pricing) for ${school?.companyName || 'School'} (${classesList}) — ${assessmentNames}.${
          contract ? ` Applied to Printing Contract ${contract.contractNumber} Assessment #${options?.assessmentNumber}.` : ''
        }`,
    });

    // If linked to a Prepaid Printing Contract assessment, deduct the agreed contract amount
    // and offset Customer A/R on this consolidated invoice if prepaid funds cover it
    if (contract && options?.assessmentNumber) {
      const milestone = contract.assessments.find(
        a => a.assessmentNumber === options.assessmentNumber && a.status === 'pending'
      );
      if (milestone) {
        await completeContractAssessment(
          contract.id,
          milestone.assessmentNumber,
          `Consolidated Invoice ${createdInvoice.invoiceNumber} (${selectedPapers.length} exam papers)`,
          createdInvoice.id
        );
        updateContractAssessment(contract.id, milestone.assessmentNumber, {
          backendInvoiceId,
          linkedInvoiceNumber: createdInvoice.invoiceNumber,
        });

        const settlementApplied = Math.min(createdInvoice.total, milestone.agreedAmount);
        setInvoices(prev =>
          prev.map(inv => {
            if (inv.id !== createdInvoice.id) return inv;
            const newPaid = round2(settlementApplied);
            const newBal = Math.max(0, round2(inv.total - newPaid));
            return {
              ...inv,
              amountPaid: newPaid,
              balanceDue: newBal,
              status: newBal <= 0 ? 'paid' : 'partial',
            };
          })
        );
        setCustomers(prev =>
          prev.map(c =>
            c.id === schoolId
              ? { ...c, balance: Math.max(0, round2(c.balance - settlementApplied)) }
              : c
          )
        );
        setAccounts(prev =>
          prev.map(acc => {
            if (acc.code === '1200') {
              return { ...acc, balance: round2(acc.balance - settlementApplied) };
            }
            if (acc.code === '4010') {
              return { ...acc, balance: round2(acc.balance - settlementApplied) };
            }
            return acc;
          })
        );
      }
    }

    // Mark all included exam papers as invoiced & link invoiceId / backendInvoiceId / linkedInvoiceNumber
    setExamPapers(prev =>
      prev.map(p =>
        examPaperIds.includes(p.id)
          ? {
              ...p,
              status: 'invoiced',
              invoiceId: createdInvoice.id,
              backendInvoiceId,
              linkedInvoiceNumber: createdInvoice.invoiceNumber,
              contractId: options?.contractId || p.contractId,
              assessmentNumber: options?.assessmentNumber || p.assessmentNumber,
            }
          : p
      )
    );

    await logAuditAction(
      'CONSOLIDATED_EXAM_INVOICE',
      'Invoice',
      createdInvoice.id,
      `Generated consolidated invoice ${createdInvoice.invoiceNumber} for ${school?.companyName} (${lines.length} class lines covering ${selectedPapers.length} subject papers)`
    );

    return createdInvoice;
  };

  // 5C. Printing Contracts (School Prepaid Retainers, Specific Dates & Shared Paper/Toner Profit)
  const addPrintingContract = async (
    contractData: Omit<
      PrintingContract,
      'id' | 'contractNumber' | 'remainingBalance' | 'completedAssessments' | 'status'
    >
  ): Promise<PrintingContract> => {
    const ctrNum = `CTR-${new Date().getFullYear()}-${String(printingContracts.length + 1).padStart(2, '0')}`;
    const enrichedAssessments = contractData.assessments.map(a => {
      const pItem = a.rawPaperItemId
        ? inventoryItems.find(i => i.id === a.rawPaperItemId && i.type === 'raw_material')
        : undefined;
      const tItem = a.rawTonerItemId
        ? inventoryItems.find(i => i.id === a.rawTonerItemId && i.type === 'raw_material')
        : undefined;

      if (pItem || tItem) {
        const est = calculateContractMilestoneEstimate({
          paperStock: pItem ? buildPaperStockFromInventoryItem(pItem) : null,
          tonerChannels: tItem ? { K: buildTonerSpecFromInventoryItem(tItem, 'K') } : null,
          machine: WORKSPACE_PRESS_CAPABILITY,
          estimatedSheets: a.estimatedSheets || 0,
          estimatedImpressions: a.estimatedImpressions || 0,
          agreedAmount: a.agreedAmount,
        });
        return {
          ...a,
          paperCost: pItem ? est.paperCost : a.paperCost,
          tonerCost: tItem ? est.tonerCost : a.tonerCost,
          totalCost: round2((pItem ? est.paperCost : a.paperCost) + (tItem ? est.tonerCost : a.tonerCost)),
          profit: round2(a.agreedAmount - ((pItem ? est.paperCost : a.paperCost) + (tItem ? est.tonerCost : a.tonerCost))),
        };
      }
      const totalCost = round2((a.paperCost || 0) + (a.tonerCost || 0));
      return {
        ...a,
        totalCost,
        profit: round2(a.agreedAmount - totalCost),
      };
    });

    // Attempt server-side creation first when the customer and deposit account
    // are real backend records (numeric ids). The contract is created as a
    // DRAFT; funding, acceptance, approval and activation are separate steps.
    //
    // Fail-closed (G-01): a backend rejection or an unreachable server throws
    // and mutates no local state — the caller never sees a local-only contract
    // or a fabricated journal entry for a money movement.
    const backendCustomerId = toBackendId(contractData.schoolCustomerId);
    const backendBankAccountId = toBackendId(contractData.depositBankAccountId);
    let backendId: number | undefined;
    let effectiveNumber = ctrNum;
    if (backendCustomerId && backendBankAccountId) {
      const idempotencyKey = `contract-create-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const res = await printingApi.createContract({
        schoolCustomerId: backendCustomerId,
        title: contractData.title,
        academicYear: contractData.academicYear,
        startDate: contractData.startDate,
        endDate: contractData.endDate,
        totalPrepaidAmount: contractData.totalPrepaidAmount,
        totalAssessments: contractData.totalAssessments,
        depositBankAccountId: backendBankAccountId,
        notes: contractData.notes ?? null,
        idempotencyKey,
        assessments: enrichedAssessments.map(a => ({
          assessmentNumber: a.assessmentNumber,
          label: a.label,
          scheduledDate: a.scheduledDate,
          agreedAmount: a.agreedAmount,
          rawPaperItemId: toBackendId(a.rawPaperItemId),
          rawTonerItemId: toBackendId(a.rawTonerItemId),
          estimatedSheets: a.estimatedSheets,
          estimatedImpressions: a.estimatedImpressions,
          paperCost: a.paperCost,
          tonerCost: a.tonerCost,
        })),
      });
      if (res?.contractId) {
        backendId = Number(res.contractId);
        effectiveNumber = res.contractNumber || ctrNum;
      } else {
        throw new Error('The server did not return a contract. No contract was created.');
      }
    }

    const newContract: PrintingContract = {
      ...contractData,
      assessments: enrichedAssessments,
      id: backendId ? `ctr-${backendId}` : `ctr-${Date.now()}`,
      backendId,
      contractNumber: effectiveNumber,
      remainingBalance: contractData.totalPrepaidAmount,
      completedAssessments: 0,
      status: 'draft',
      source: backendId ? 'backend' : 'local',
      creditBalance: false,
      unallocatedAmount: 0,
      updatedAt: new Date().toISOString(),
    };

    setPrintingContracts(prev => [newContract, ...prev]);

    if (!backendId) {
      // Local-only (bundled demo) path: mirror the deposit in local ledger state.
      // Debit Bank Account (+totalPrepaidAmount), Credit 2250 Unearned Contract Revenue.
      setAccounts(prev =>
        prev.map(acc => {
          if (acc.id === newContract.depositBankAccountId) {
            return { ...acc, balance: round2(acc.balance + newContract.totalPrepaidAmount) };
          }
          if (acc.code === '2250') {
            return { ...acc, balance: round2(acc.balance + newContract.totalPrepaidAmount) };
          }
          return acc;
        })
      );

      const school = customers.find(c => c.id === newContract.schoolCustomerId);
      const bankTx: BankTransaction = {
        id: `tx-${Date.now()}`,
        accountId: newContract.depositBankAccountId,
        date: newContract.startDate,
        payee: school?.companyName || 'School Retainer Deposit',
        type: 'Deposit',
        refNumber: effectiveNumber,
        memo: `Prepaid printing retainer (${newContract.totalAssessments} assessments): ${newContract.title}`,
        amount: newContract.totalPrepaidAmount,
        balance: 0,
        isCleared: true,
        category: 'Unearned Contract Revenue',
      };
      setBankTransactions(prev => [bankTx, ...prev]);
    }

    await logAuditAction(
      'CREATE_PRINTING_CONTRACT',
      'PrintingContract',
      newContract.id,
      `Created prepaid contract ${effectiveNumber} with ${customers.find(c => c.id === newContract.schoolCustomerId)?.companyName || 'school'} for ${getCurrencySymbol(companyProfile.currency)}${newContract.totalPrepaidAmount.toFixed(2)} (${newContract.totalAssessments} assessments)`
    );

    return newContract;
  };

  const updateContractAssessment = (
    contractId: string,
    assessmentNumber: number,
    updates: Partial<ContractAssessmentMilestone>
  ) => {
    setPrintingContracts(prev =>
      prev.map(c => {
        if (c.id !== contractId) return c;
        return {
          ...c,
          assessments: c.assessments.map(a => {
            if (a.assessmentNumber !== assessmentNumber) return a;
            const merged = { ...a, ...updates };
            const pItem = merged.rawPaperItemId
              ? inventoryItems.find(i => i.id === merged.rawPaperItemId && i.type === 'raw_material')
              : undefined;
            const tItem = merged.rawTonerItemId
              ? inventoryItems.find(i => i.id === merged.rawTonerItemId && i.type === 'raw_material')
              : undefined;
            if (pItem || tItem) {
              const est = calculateContractMilestoneEstimate({
                paperStock: pItem ? buildPaperStockFromInventoryItem(pItem) : null,
                tonerChannels: tItem ? { K: buildTonerSpecFromInventoryItem(tItem, 'K') } : null,
                machine: WORKSPACE_PRESS_CAPABILITY,
                estimatedSheets: merged.estimatedSheets || 0,
                estimatedImpressions: merged.estimatedImpressions || 0,
                agreedAmount: merged.agreedAmount,
              });
              const paperCost = pItem ? est.paperCost : merged.paperCost;
              const tonerCost = tItem ? est.tonerCost : merged.tonerCost;
              const totalCost = round2(paperCost + tonerCost);
              return {
                ...merged,
                paperCost,
                tonerCost,
                totalCost,
                profit: round2(merged.agreedAmount - totalCost),
              };
            }
            const totalCost = round2((merged.paperCost || 0) + (merged.tonerCost || 0));
            return {
              ...merged,
              totalCost,
              profit: round2(merged.agreedAmount - totalCost),
            };
          }),
        };
      })
    );

    const ctr = printingContracts.find(c => c.id === contractId);
    if (ctr?.backendId) {
      const current = ctr.assessments.find(a => a.assessmentNumber === assessmentNumber);
      const merged = { ...current, ...updates } as ContractAssessmentMilestone;
      printingApi
        .updateContractAssessment(ctr.backendId, assessmentNumber, {
          label: merged.label,
          scheduledDate: merged.scheduledDate,
          agreedAmount: merged.agreedAmount,
          rawPaperItemId: toBackendId(merged.rawPaperItemId),
          rawTonerItemId: toBackendId(merged.rawTonerItemId),
          estimatedSheets: merged.estimatedSheets,
          estimatedImpressions: merged.estimatedImpressions,
          paperCost: merged.paperCost,
          tonerCost: merged.tonerCost,
        })
        .catch(() => {
          /* keep local fallback */
        });
    }
  };

  const getAssessmentActualStats = (
    contractId: string,
    assessmentNumber: number
  ): AssessmentActualStats => {
    const linked = examPapers.filter(
      p => p.contractId === contractId && p.assessmentNumber === assessmentNumber
    );
    const sheets = linked.reduce((s, p) => s + p.sheetsUsed, 0);
    const impressions = linked.reduce((s, p) => s + p.impressionsUsed, 0);
    const paperCost = round2(linked.reduce((s, p) => s + (p.paperCost || 0), 0));
    const tonerCost = round2(linked.reduce((s, p) => s + (p.tonerCost || 0), 0));
    const totalCost = round2(paperCost + tonerCost);
    return {
      sheets,
      impressions,
      paperCost,
      tonerCost,
      totalCost,
      papersCount: linked.length,
    };
  };

  const completeContractAssessment = async (
    contractId: string,
    assessmentNumber: number,
    examBatchNote?: string,
    linkedInvoiceId?: string
  ) => {
    const targetContract = printingContracts.find(c => c.id === contractId);
    if (!targetContract) return;

    const milestone = targetContract.assessments.find(
      a => a.assessmentNumber === assessmentNumber && a.status === 'pending'
    );
    if (!milestone) return;

    const today = new Date().toISOString().split('T')[0];
    const deduction = Math.min(milestone.agreedAmount, targetContract.remainingBalance);
    const nextRemaining = Math.max(0, round2(targetContract.remainingBalance - deduction));
    const nextCompleted = targetContract.completedAssessments + 1;
    const isExhausted = nextCompleted >= targetContract.totalAssessments || nextRemaining <= 0;

    setPrintingContracts(prev =>
      prev.map(c => {
        if (c.id !== contractId) return c;
        return {
          ...c,
          remainingBalance: nextRemaining,
          completedAssessments: nextCompleted,
          status: isExhausted ? 'exhausted' : 'active',
          assessments: c.assessments.map(a =>
            a.assessmentNumber === assessmentNumber
              ? {
                  ...a,
                  status: 'completed',
                  completedDate: today,
                  examBatchNote: examBatchNote || `Assessment #${assessmentNumber} completed & deducted`,
                  linkedInvoiceId,
                }
              : a
          ),
        };
      })
    );

    // Recognize Revenue from Prepaid Retainer:
    // Debit 2250 Unearned Contract Revenue (-deduction)
    // Credit 4010 Printing & Exam Production Sales (+deduction)
    if (targetContract.backendId) {
      // The backend owns the double-entry posting for server-backed contracts.
      // Posting again locally would double-count the revenue.
      printingApi
        .completeContractAssessment(targetContract.backendId, assessmentNumber, {
          examBatchNote: examBatchNote || null,
          linkedInvoiceId: toBackendId(linkedInvoiceId),
        })
        .catch(() => {
          /* keep local fallback */
        });
    } else {
      const unearnedAcc = accounts.find(a => a.code === '2250');
      const incomeAcc = accounts.find(a => a.code === '4010');

      setAccounts(prev =>
        prev.map(acc => {
          if (acc.code === '2250') {
            return { ...acc, balance: Math.max(0, round2(acc.balance - deduction)) };
          }
          if (acc.code === '4010') {
            return { ...acc, balance: round2(acc.balance + deduction) };
          }
          return acc;
        })
      );

      if (unearnedAcc && incomeAcc) {
        const jeNum = `JE-${5000 + journalEntries.length + 1}`;
        const recognitionJe: JournalEntry = {
          id: `je-${Date.now()}`,
          entryNumber: jeNum,
          date: today,
          memo: `Contract ${targetContract.contractNumber} — ${milestone.label} deduction & revenue recognition`,
          source: 'contract',
          sourceRefId: targetContract.id,
          lines: [
            {
              id: `jl-${Date.now()}-1`,
              accountId: unearnedAcc.id,
              description: `Deduct prepaid retainer for Assessment #${assessmentNumber}`,
              debit: deduction,
              credit: 0,
            },
            {
              id: `jl-${Date.now()}-2`,
              accountId: incomeAcc.id,
              description: `Recognize earned assessment printing revenue`,
              debit: 0,
              credit: deduction,
            },
          ],
        };
        setJournalEntries(prev => [recognitionJe, ...prev]);
      }
    }

    await logAuditAction(
      'COMPLETE_CONTRACT_ASSESSMENT',
      'PrintingContract',
      contractId,
      `Deducted ${getCurrencySymbol(companyProfile.currency)}${deduction.toFixed(2)} on ${targetContract.contractNumber} Assessment #${assessmentNumber}. Remaining balance: ${getCurrencySymbol(companyProfile.currency)}${nextRemaining.toFixed(2)}`
    );
  };

  const linkContractDepositInvoice = async (
    contractId: string,
    ref: { invoiceId?: string; backendInvoiceId?: number; invoiceNumber?: string }
  ) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (ctr?.backendId && ref.backendInvoiceId) {
      // Persist server-side so the link survives a refresh (G-09).
      const updated = await printingApi.linkDepositInvoice(ctr.backendId, {
        invoiceId: ref.backendInvoiceId,
        invoiceNumber: ref.invoiceNumber ?? null,
      });
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId
            ? {
                ...c,
                depositInvoiceId: ref.invoiceId ?? c.depositInvoiceId,
                depositBackendInvoiceId: ref.backendInvoiceId ?? c.depositBackendInvoiceId,
                depositInvoiceNumber:
                  ref.invoiceNumber ?? updated?.depositInvoiceNumber ?? c.depositInvoiceNumber,
              }
            : c
        )
      );
      return;
    }

    setPrintingContracts(prev =>
      prev.map(c =>
        c.id === contractId
          ? {
              ...c,
              depositInvoiceId: ref.invoiceId ?? c.depositInvoiceId,
              depositBackendInvoiceId: ref.backendInvoiceId ?? c.depositBackendInvoiceId,
              depositInvoiceNumber: ref.invoiceNumber ?? c.depositInvoiceNumber,
            }
          : c
      )
    );
  };

  /** Links a generated milestone invoice so it survives a refresh (G-09). */
  const linkMilestoneInvoice = async (
    contractId: string,
    assessmentNumber: number,
    ref: { invoiceId?: string; backendInvoiceId?: number; invoiceNumber?: string }
  ) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (ctr?.backendId && ref.backendInvoiceId) {
      const updated = await printingApi.linkMilestoneInvoice(ctr.backendId, assessmentNumber, {
        invoiceId: ref.backendInvoiceId,
        invoiceNumber: ref.invoiceNumber ?? null,
      });
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId ? { ...c, ...(updated ?? {}) } : c
        )
      );
      return;
    }

    setPrintingContracts(prev =>
      prev.map(c =>
        c.id === contractId
          ? {
              ...c,
              assessments: c.assessments.map(a =>
                a.assessmentNumber === assessmentNumber
                  ? {
                      ...a,
                      linkedInvoiceId: ref.invoiceId ?? a.linkedInvoiceId,
                      linkedInvoiceNumber: ref.invoiceNumber ?? a.linkedInvoiceNumber,
                    }
                  : a
              ),
            }
          : c
      )
    );
  };

  /**
   * Cancels a contract. When the backend owns the contract this is a real
   * settlement (refund or forfeit) and the local state only changes after the
   * server confirms (G-01, G-04).
   */
  const cancelPrintingContract = async (
    contractId: string,
    options: { reason?: string; settlementMode?: 'refund' | 'forfeit'; refundBankAccountId?: number | null } = {}
  ) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr) return;

    if (ctr.backendId) {
      const updated = await printingApi.cancelContract(ctr.backendId, {
        reason: options.reason,
        settlementMode: options.settlementMode ?? 'forfeit',
        refundBankAccountId: options.refundBankAccountId ?? null,
      });
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId
            ? {
                ...c,
                status: 'cancelled',
                remainingBalance: updated?.remainingBalance ?? 0,
                creditBalance: false,
                updatedAt: new Date().toISOString(),
                notes: options.reason
                  ? `${c.notes || ''}\nCancelled: ${options.reason}`.trim()
                  : c.notes,
              }
            : c
        )
      );
    } else {
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId
            ? {
                ...c,
                status: 'cancelled',
                remainingBalance: 0,
                creditBalance: false,
                notes: options.reason
                  ? `${c.notes || ''}\nCancelled: ${options.reason}`.trim()
                  : c.notes,
              }
            : c
        )
      );
    }
    logAuditAction(
      'CANCEL_PRINTING_CONTRACT',
      'PrintingContract',
      contractId,
      options.reason || 'Cancelled from contract register'
    );
  };

  /** Activates a funded, accepted and approved draft (D-1). */
  const activatePrintingContract = async (contractId: string) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr) return;

    if (ctr.backendId) {
      const updated = await printingApi.activateContract(ctr.backendId);
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId
            ? { ...c, status: updated?.status ?? 'active', updatedAt: new Date().toISOString() }
            : c
        )
      );
    } else {
      setPrintingContracts(prev =>
        prev.map(c => (c.id === contractId ? { ...c, status: 'active' } : c))
      );
    }
    logAuditAction('ACTIVATE_PRINTING_CONTRACT', 'PrintingContract', contractId, 'Activated from contract register');
  };

  /**
   * Renews a contract into a fresh retainer period. The backend requires a real
   * new deposit, so the successor is created server-side and the local copy is
   * replaced by the server's response (G-05, G-08).
   */
  const renewPrintingContract = async (
    contractId: string,
    deposit?: { amount?: string | number; bankAccountId?: number; startDate?: string; endDate?: string }
  ) => {
    const source = printingContracts.find(c => c.id === contractId);
    if (!source) return;

    if (source.backendId) {
      const res = await printingApi.renewContract(source.backendId, {
        depositAmount: deposit?.amount ?? source.totalPrepaidAmount,
        depositBankAccountId: deposit?.bankAccountId,
        startDate: deposit?.startDate,
        endDate: deposit?.endDate,
        idempotencyKey: `contract-renew-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      });
      if (!res?.contractId) {
        throw new Error('The server did not return the renewed contract.');
      }
      const renewed: PrintingContract = {
        ...source,
        ...res,
        id: `ctr-${res.contractId}`,
        backendId: Number(res.contractId),
        contractNumber: res.contractNumber || source.contractNumber,
        status: 'draft',
        remainingBalance: res.totalPrepaidAmount ?? source.totalPrepaidAmount,
        completedAssessments: 0,
        creditBalance: false,
        unallocatedAmount: res.unallocatedAmount ?? 0,
        source: 'backend',
        updatedAt: new Date().toISOString(),
      };
      setPrintingContracts(prev => [renewed, ...prev]);
      logAuditAction(
        'RENEW_PRINTING_CONTRACT',
        'PrintingContract',
        renewed.id,
        `Renewed from ${source.contractNumber}`
      );
      return;
    }

    const renewed: PrintingContract = {
      ...source,
      id: `ctr-${Date.now()}`,
      contractNumber: `CTR-${new Date().getFullYear()}-${String(printingContracts.length + 1).padStart(2, '0')}`,
      status: 'active',
      remainingBalance: source.totalPrepaidAmount,
      completedAssessments: 0,
      assessments: source.assessments.map(a => ({
        ...a,
        status: 'pending',
        completedDate: undefined,
        linkedInvoiceId: undefined,
        backendInvoiceId: undefined,
        linkedInvoiceNumber: undefined,
      })),
    };
    setPrintingContracts(prev => [renewed, ...prev]);
    logAuditAction('RENEW_PRINTING_CONTRACT', 'PrintingContract', renewed.id, `Renewed from ${source.contractNumber}`);
  };

  /** Amends contract metadata; local state updates only after the server confirms. */
  const amendPrintingContract = async (contractId: string, updates: Partial<PrintingContract>) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr) return;

    if (ctr.backendId) {
      const merged = { ...ctr, ...updates };
      const updated = await printingApi.amendContract(ctr.backendId, {
        title: merged.title,
        academicYear: merged.academicYear,
        startDate: merged.startDate,
        endDate: merged.endDate,
        notes: merged.notes ?? null,
      });
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId
            ? { ...c, ...updates, ...updated, updatedAt: new Date().toISOString() }
            : c
        )
      );
    } else {
      setPrintingContracts(prev => prev.map(c => (c.id === contractId ? { ...c, ...updates } : c)));
    }
    logAuditAction('AMEND_PRINTING_CONTRACT', 'PrintingContract', contractId, 'Amended from contract register');
  };

  /** Suspend an active contract; local state updates only after the server confirms. */
  const suspendContract = async (contractId: string, reason?: string) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr) return;
    if (ctr.backendId) {
      const updated = await printingApi.suspendContract(ctr.backendId, reason);
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId
            ? {
                ...c,
                status: updated?.status ?? 'suspended',
                suspendedAt: updated?.suspendedAt ?? new Date().toISOString(),
                suspensionReason: reason ?? updated?.suspensionReason,
                updatedAt: new Date().toISOString(),
              }
            : c
        )
      );
    } else {
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId
            ? { ...c, status: 'suspended', suspensionReason: reason }
            : c
        )
      );
    }
    logAuditAction('SUSPEND_PRINTING_CONTRACT', 'PrintingContract', contractId, reason || 'Suspended from contract register');
  };

  /** Resume a suspended contract; local state updates only after the server confirms. */
  const resumeContract = async (contractId: string) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr) return;
    if (ctr.backendId) {
      const updated = await printingApi.resumeContract(ctr.backendId);
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId
            ? {
                ...c,
                status: updated?.status ?? 'active',
                resumedAt: updated?.resumedAt ?? new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }
            : c
        )
      );
    } else {
      setPrintingContracts(prev =>
        prev.map(c => (c.id === contractId ? { ...c, status: 'active' } : c))
      );
    }
    logAuditAction('RESUME_PRINTING_CONTRACT', 'PrintingContract', contractId, 'Resumed from contract register');
  };

  /** Fetch the amendment request history for a contract (read-only). */
  const listContractAmendments = async (contractId: string): Promise<any[]> => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr?.backendId) return [];
    return printingApi.listAmendments(ctr.backendId);
  };

  /** Approve a pending amendment; replaces local state with the server's contract. */
  const approveContractAmendment = async (
    contractId: string,
    amendmentId: number,
    notes?: string | null
  ) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr?.backendId) return;
    const updated = await printingApi.approveAmendment(ctr.backendId, amendmentId, notes);
    if (updated) {
      setPrintingContracts(prev =>
        prev.map(c => (c.id === contractId ? mapApiContract(updated) : c))
      );
    }
    logAuditAction('APPROVE_CONTRACT_AMENDMENT', 'PrintingContract', contractId, `Approved amendment #${amendmentId}`);
  };

  /** Reject a pending amendment (no contract mutation beyond the request status). */
  const rejectContractAmendment = async (
    contractId: string,
    amendmentId: number,
    notes?: string | null
  ) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr?.backendId) return;
    await printingApi.rejectAmendment(ctr.backendId, amendmentId, notes);
    logAuditAction('REJECT_CONTRACT_AMENDMENT', 'PrintingContract', contractId, `Rejected amendment #${amendmentId}`);
  };

  /** Record customer acceptance of a contract document (G-03 evidence). */
  const recordContractAcceptance = async (
    contractId: string,
    payload: {
      method: 'drawn' | 'otp' | 'upload';
      signerName: string;
      signerEmail?: string | null;
      signerPhone?: string | null;
      documentVersion: string;
      evidenceFileId?: number | null;
      otpVerified?: boolean;
      outcome?: 'accepted' | 'rejected';
    }
  ) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr?.backendId) {
      throw new Error('This contract has no server record, so acceptance cannot be recorded.');
    }
    const acceptance = await printingApi.recordAcceptance(ctr.backendId, payload);
    setPrintingContracts(prev =>
      prev.map(c =>
        c.id === contractId
          ? {
              ...c,
              customerAcceptanceId:
                acceptance?.id != null ? Number(acceptance.id) : c.customerAcceptanceId,
              updatedAt: new Date().toISOString(),
            }
          : c
      )
    );
    logAuditAction(
      'RECORD_CONTRACT_ACCEPTANCE',
      'PrintingContract',
      contractId,
      `Customer acceptance via ${payload.method}`
    );
  };

  /** Void a contract (compensating reversal); local state updates after server confirms. */
  const voidPrintingContract = async (contractId: string, reason: string) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr) return;
    if (ctr.backendId) {
      const updated = await printingApi.voidContract(ctr.backendId, reason);
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId
            ? {
                ...c,
                status: updated?.status ?? 'voided',
                remainingBalance: 0,
                creditBalance: false,
                updatedAt: new Date().toISOString(),
                notes: reason ? `${c.notes || ''}\nVoided: ${reason}`.trim() : c.notes,
              }
            : c
        )
      );
    } else {
      setPrintingContracts(prev =>
        prev.map(c =>
          c.id === contractId
            ? { ...c, status: 'voided', remainingBalance: 0, creditBalance: false }
            : c
        )
      );
    }
    logAuditAction('VOID_PRINTING_CONTRACT', 'PrintingContract', contractId, reason || 'Voided from contract register');
  };

  /** Fetch the signature ceremony records for a contract (read-only). */
  const listContractSignatures = async (contractId: string): Promise<any[]> => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr?.backendId) return [];
    return printingApi.listSignatures(ctr.backendId);
  };

  /** Read-only reconciliation report grouped by customer. */
  const getContractReconciliation = async (): Promise<any> => {
    return printingApi.getContractReconciliation();
  };

  /** Record a company/customer signature in the signing ceremony. */
  const recordContractSignature = async (
    contractId: string,
    payload: {
      signerRole: 'company' | 'customer';
      signerName: string;
      method: 'drawn' | 'typed' | 'upload';
      signatureData: string;
      documentVersion?: string | null;
    }
  ) => {
    const ctr = printingContracts.find(c => c.id === contractId);
    if (!ctr?.backendId) {
      throw new Error('This contract has no server record, so it cannot be signed.');
    }
    await printingApi.recordSignature(ctr.backendId, payload);
    logAuditAction(
      'PRINTING_CONTRACT_SIGNED',
      'PrintingContract',
      contractId,
      `${payload.signerRole} signed via ${payload.method}`
    );
  };

  const addContractAssessment = (contractId: string, milestone: ContractAssessmentMilestone) => {
    setPrintingContracts(prev =>
      prev.map(c =>
        c.id === contractId
          ? { ...c, assessments: [...c.assessments, milestone], totalAssessments: (c.totalAssessments + 1) as 2 | 3 | 4 | 5 }
          : c
      )
    );
    const ctr = printingContracts.find(c => c.id === contractId);
    if (ctr?.backendId) {
      printingApi
        .addContractAssessment(ctr.backendId, {
          assessmentNumber: milestone.assessmentNumber,
          label: milestone.label,
          scheduledDate: milestone.scheduledDate,
          agreedAmount: milestone.agreedAmount,
          rawPaperItemId: toBackendId(milestone.rawPaperItemId),
          rawTonerItemId: toBackendId(milestone.rawTonerItemId),
          estimatedSheets: milestone.estimatedSheets,
          estimatedImpressions: milestone.estimatedImpressions,
          paperCost: milestone.paperCost,
          tonerCost: milestone.tonerCost,
          examBatchNote: milestone.examBatchNote ?? null,
        })
        .catch(() => {
          /* keep local fallback */
        });
    }
    logAuditAction('ADD_CONTRACT_ASSESSMENT', 'PrintingContract', contractId, `Added assessment #${milestone.assessmentNumber}`);
  };

  const removeContractAssessment = (contractId: string, assessmentNumber: number) => {
    setPrintingContracts(prev =>
      prev.map(c =>
        c.id === contractId
          ? {
              ...c,
              assessments: c.assessments.filter(a => a.assessmentNumber !== assessmentNumber),
            }
          : c
      )
    );
    const ctr = printingContracts.find(c => c.id === contractId);
    if (ctr?.backendId) {
      printingApi.removeContractAssessment(ctr.backendId, assessmentNumber).catch(() => {
        /* keep local fallback */
      });
    }
    logAuditAction('REMOVE_CONTRACT_ASSESSMENT', 'PrintingContract', contractId, `Removed assessment #${assessmentNumber}`);
  };

  const linkQuickPrintInvoice = (
    jobId: string,
    ref: { invoiceId?: string; backendInvoiceId?: number; invoiceNumber?: string }
  ) => {
    setQuickPrintJobs(prev =>
      prev.map(j =>
        j.id === jobId
          ? {
              ...j,
              invoiceId: ref.invoiceId ?? j.invoiceId,
              backendInvoiceId: ref.backendInvoiceId ?? j.backendInvoiceId,
              linkedInvoiceNumber: ref.invoiceNumber ?? j.linkedInvoiceNumber,
            }
          : j
      )
    );
  };

  const linkExamPapersInvoice = (
    paperIds: string[],
    ref: { invoiceId?: string; backendInvoiceId?: number; invoiceNumber?: string }
  ) => {
    setExamPapers(prev =>
      prev.map(p =>
        paperIds.includes(p.id)
          ? {
              ...p,
              status: 'invoiced',
              invoiceId: ref.invoiceId ?? p.invoiceId,
              backendInvoiceId: ref.backendInvoiceId ?? p.backendInvoiceId,
              linkedInvoiceNumber: ref.invoiceNumber ?? p.linkedInvoiceNumber,
            }
          : p
      )
    );
  };

  const generateAndSyncWorkflowInvoice = async (
    payload: GenerateWorkflowInvoicePayload,
    options?: { localCustomerId?: string }
  ): Promise<{ apiInvoice: ApiInvoice; localInvoice: Invoice }> => {
    const { invoice: apiInvoice } = await documentsApi.generateWorkflowInvoice(payload);
    const existingLocal = invoices.find(
      inv =>
        (inv.backendInvoiceId && inv.backendInvoiceId === apiInvoice.id) ||
        inv.invoiceNumber === apiInvoice.invoiceNumber
    );
    if (existingLocal) {
      return { apiInvoice, localInvoice: existingLocal };
    }

    const matchedCustomer =
      (options?.localCustomerId && customers.find(c => c.id === options.localCustomerId)) ||
      customers.find(
        c =>
          c.companyName.trim().toLowerCase() === (apiInvoice.customerName || '').trim().toLowerCase()
      ) ||
      customers[0];

    const localLines: InvoiceLine[] = (apiInvoice.lines || []).map((l, idx) => ({
      id: `wfl-${Date.now()}-${idx}`,
      description: l.description,
      quantity: Number(l.quantity),
      rate: Number(l.rate),
      amount: Number(l.amount),
      unitCost: Number(l.unitCost ?? 0),
      totalCost: round2(Number(l.unitCost ?? 0) * Number(l.quantity)),
      taxable: Boolean(l.taxable),
    }));

    const localInvoice = await addInvoice({
      customerId: matchedCustomer?.id || options?.localCustomerId || '',
      date: apiInvoice.invoiceDate || new Date().toISOString().slice(0, 10),
      dueDate: apiInvoice.dueDate || new Date().toISOString().slice(0, 10),
      terms: apiInvoice.terms || 'Net 30',
      invoiceNumber: apiInvoice.invoiceNumber,
      backendInvoiceId: apiInvoice.id,
      lines: localLines,
      subtotal: apiInvoice.subtotal,
      taxRate: apiInvoice.taxRate || 0,
      taxAmount: apiInvoice.taxAmount,
      total: apiInvoice.total,
      totalCost: apiInvoice.totalCost,
      grossProfit: apiInvoice.grossProfit,
      notes: apiInvoice.notes || '',
    });

    return { apiInvoice, localInvoice };
  };

  // 6. Receive Payment against Invoice
  const recordPaymentReceived = async (
    paymentData: Omit<PaymentReceived, 'id' | 'paymentNumber'>
  ): Promise<PaymentReceived> => {
    const pmtNum = `PMT-${2000 + paymentsReceived.length + 1}`;
    const newPayment: PaymentReceived = {
      ...paymentData,
      id: `pmt-${Date.now()}`,
      paymentNumber: pmtNum,
    };

    setPaymentsReceived(prev => [newPayment, ...prev]);

    setInvoices(prev =>
      prev.map(inv => {
        if (inv.id === paymentData.invoiceId) {
          const newPaid = round2(inv.amountPaid + paymentData.amount);
          const newBal = Math.max(0, round2(inv.total - newPaid));
          return {
            ...inv,
            amountPaid: newPaid,
            balanceDue: newBal,
            status: newBal <= 0 ? 'paid' : 'partial',
          };
        }
        return inv;
      })
    );

    setCustomers(prev =>
      prev.map(c =>
        c.id === paymentData.customerId
          ? { ...c, balance: Math.max(0, round2(c.balance - paymentData.amount)) }
          : c
      )
    );

    setAccounts(prev =>
      prev.map(acc => {
        if (acc.id === paymentData.depositToAccountId) {
          return { ...acc, balance: round2(acc.balance + paymentData.amount) };
        }
        if (acc.code === '1200') {
          return { ...acc, balance: round2(acc.balance - paymentData.amount) };
        }
        return acc;
      })
    );

    const targetCust = customers.find(c => c.id === paymentData.customerId);
    const bankTx: BankTransaction = {
      id: `tx-${Date.now()}`,
      accountId: paymentData.depositToAccountId,
      date: paymentData.date,
      payee: targetCust ? targetCust.companyName || targetCust.name : 'Customer Payment',
      type: 'Deposit',
      refNumber: paymentData.referenceNumber || pmtNum,
      memo: paymentData.memo || `Deposit for payment ${pmtNum}`,
      amount: paymentData.amount,
      balance: 0,
      isCleared: false,
      category: 'Accounts Receivable',
    };
    setBankTransactions(prev => [bankTx, ...prev]);

    await logAuditAction(
      'RECEIVE_PAYMENT',
      'PaymentReceived',
      newPayment.id,
      `Received payment of ${getCurrencySymbol(companyProfile.currency)}${newPayment.amount.toFixed(2)} from ${targetCust?.companyName || 'customer'}`
    );

    return newPayment;
  };

  // 7. Estimates
  const addEstimate = (estimateData: Omit<Estimate, 'id' | 'estimateNumber' | 'status'>): Estimate => {
    const estNum = `EST-${200 + estimates.length + 1}`;
    const newEst: Estimate = {
      ...estimateData,
      id: `est-${Date.now()}`,
      estimateNumber: estNum,
      status: 'pending',
    };
    setEstimates(prev => [newEst, ...prev]);
    logAuditAction('CREATE_ESTIMATE', 'Estimate', newEst.id, `Created estimate ${estNum} for ${getCurrencySymbol(companyProfile.currency)}${newEst.total.toFixed(2)}`);
    return newEst;
  };

  const convertEstimateToInvoice = async (estimateId: string): Promise<Invoice | null> => {
    const est = estimates.find(e => e.id === estimateId);
    if (!est) return null;

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);

    const inv = await addInvoice({
      customerId: est.customerId,
      date: new Date().toISOString().split('T')[0],
      dueDate: dueDate.toISOString().split('T')[0],
      terms: 'Net 30',
      lines: est.lines,
      subtotal: est.subtotal,
      taxRate: est.taxRate,
      taxAmount: est.taxAmount,
      total: est.total,
      notes: `Converted from Estimate ${est.estimateNumber}. ${est.notes || ''}`,
    });

    setEstimates(prev =>
      prev.map(e => (e.id === estimateId ? { ...e, status: 'invoiced' } : e))
    );

    return inv;
  };

  // 8. Bills & Accounts Payable
  const addBill = async (
    billData: Omit<Bill, 'id' | 'billNumber' | 'status' | 'amountPaid' | 'balanceDue'>
  ): Promise<Bill> => {
    const billNum = `BILL-${8890 + bills.length + 1}`;
    const newBill: Bill = {
      ...billData,
      id: `bill-${Date.now()}`,
      billNumber: billNum,
      status: 'open',
      amountPaid: 0,
      balanceDue: billData.total,
    };

    setBills(prev => [newBill, ...prev]);

    setVendors(prev =>
      prev.map(v =>
        v.id === billData.vendorId
          ? { ...v, balance: round2(v.balance + billData.total) }
          : v
      )
    );

    setAccounts(prev =>
      prev.map(acc => {
        if (acc.code === '2000') {
          return { ...acc, balance: round2(acc.balance + newBill.total) };
        }
        const lineMatch = billData.lines.find(l => l.accountId === acc.id);
        if (lineMatch) {
          return { ...acc, balance: round2(acc.balance + lineMatch.amount) };
        }
        return acc;
      })
    );

    await logAuditAction(
      'ENTER_BILL',
      'Bill',
      newBill.id,
      `Entered bill ${newBill.billNumber} for ${getCurrencySymbol(companyProfile.currency)}${newBill.total.toFixed(2)}`
    );

    return newBill;
  };

  const payBill = async (
    billId: string,
    bankAccountId: string,
    checkNumber?: string
  ): Promise<BillPayment> => {
    const targetBill = bills.find(b => b.id === billId);
    if (!targetBill) throw new Error('Bill not found');

    const paymentAmount = targetBill.balanceDue;
    const paymentNum = `BP-${1000 + billPayments.length + 1}`;

    const newPayment: BillPayment = {
      id: `bp-${Date.now()}`,
      paymentNumber: paymentNum,
      vendorId: targetBill.vendorId,
      billId: targetBill.id,
      date: new Date().toISOString().split('T')[0],
      amount: paymentAmount,
      bankAccountId,
      checkNumber: checkNumber || `CHK-${4000 + billPayments.length + 1}`,
      memo: `Payment for bill ${targetBill.billNumber}`,
    };

    setBillPayments(prev => [newPayment, ...prev]);

    setBills(prev =>
      prev.map(b =>
        b.id === billId
          ? {
              ...b,
              amountPaid: b.total,
              balanceDue: 0,
              status: 'paid',
            }
          : b
      )
    );

    setVendors(prev =>
      prev.map(v =>
        v.id === targetBill.vendorId
          ? { ...v, balance: Math.max(0, round2(v.balance - paymentAmount)) }
          : v
      )
    );

    setAccounts(prev =>
      prev.map(acc => {
        if (acc.id === bankAccountId) {
          return { ...acc, balance: round2(acc.balance - paymentAmount) };
        }
        if (acc.code === '2000') {
          return { ...acc, balance: round2(acc.balance - paymentAmount) };
        }
        return acc;
      })
    );

    const targetVendor = vendors.find(v => v.id === targetBill.vendorId);
    const bankTx: BankTransaction = {
      id: `tx-${Date.now()}`,
      accountId: bankAccountId,
      date: newPayment.date,
      payee: targetVendor?.companyName || 'Vendor Payment',
      type: 'Check',
      refNumber: newPayment.checkNumber,
      memo: newPayment.memo || `Bill payment ${paymentNum}`,
      amount: -paymentAmount,
      balance: 0,
      isCleared: false,
      category: 'Accounts Payable',
    };
    setBankTransactions(prev => [bankTx, ...prev]);

    await logAuditAction(
      'PAY_BILL',
      'BillPayment',
      newPayment.id,
      `Paid bill ${targetBill.billNumber} with check ${newPayment.checkNumber} for ${getCurrencySymbol(companyProfile.currency)}${paymentAmount.toFixed(2)}`
    );

    return newPayment;
  };

  // 9. Payroll Processing
  const addEmployee = (employeeData: Omit<Employee, 'id'>): Employee => {
    const newEmp: Employee = {
      ...employeeData,
      id: `emp-${100 + employees.length + 1}`,
    };
    setEmployees(prev => [...prev, newEmp]);
    logAuditAction('CREATE_EMPLOYEE', 'Employee', newEmp.id, `Added employee ${newEmp.firstName} ${newEmp.lastName}`);
    return newEmp;
  };

  const updateEmployee = (id: string, updates: Partial<Employee>) => {
    setEmployees(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e));
  };

  const processPayrollRun = async (
    payrollData: Omit<PayrollRun, 'id' | 'runNumber' | 'status'>
  ): Promise<PayrollRun> => {
    const runNum = `PR-${new Date().getFullYear()}-${payrollRuns.length + 1}`;
    const newRun: PayrollRun = {
      ...payrollData,
      id: `pr-${Date.now()}`,
      runNumber: runNum,
      status: 'processed',
    };

    setPayrollRuns(prev => [newRun, ...prev]);

    setAccounts(prev =>
      prev.map(acc => {
        if (acc.id === newRun.bankAccountId) {
          return { ...acc, balance: round2(acc.balance - newRun.totalNet) };
        }
        if (acc.code === '6010') {
          return { ...acc, balance: round2(acc.balance + newRun.totalGross) };
        }
        if (acc.code === '6020') {
          return { ...acc, balance: round2(acc.balance + newRun.totalEmployerTaxes) };
        }
        if (acc.code === '2100') {
          const totalFit = newRun.items.reduce((sum, item) => sum + item.fit, 0);
          return { ...acc, balance: round2(acc.balance + totalFit) };
        }
        if (acc.code === '2110') {
          const totalFica = newRun.items.reduce(
            (sum, item) => sum + item.socialSecurityEmployee + item.medicareEmployee + item.socialSecurityEmployer + item.medicareEmployer,
            0
          );
          return { ...acc, balance: round2(acc.balance + totalFica) };
        }
        if (acc.code === '2120') {
          const totalSit = newRun.items.reduce((sum, item) => sum + item.sit, 0);
          return { ...acc, balance: round2(acc.balance + totalSit) };
        }
        return acc;
      })
    );

    const bankTx: BankTransaction = {
      id: `tx-${Date.now()}`,
      accountId: newRun.bankAccountId,
      date: newRun.payDate,
      payee: `Payroll Run ${newRun.runNumber} (${newRun.items.length} employees)`,
      type: 'Transfer',
      refNumber: newRun.runNumber,
      memo: `Direct deposit distribution for period ending ${newRun.payPeriodEnd}`,
      amount: -newRun.totalNet,
      balance: 0,
      isCleared: true,
      category: 'Payroll Checking Account',
    };
    setBankTransactions(prev => [bankTx, ...prev]);

    await logAuditAction(
      'PROCESS_PAYROLL',
      'PayrollRun',
      newRun.id,
      `Processed payroll ${newRun.runNumber} for ${newRun.items.length} employees (${getCurrencySymbol(companyProfile.currency)}${newRun.totalGross.toFixed(2)} gross, ${getCurrencySymbol(companyProfile.currency)}${newRun.totalNet.toFixed(2)} net)`
    );

    return newRun;
  };

  // 10. General Journal Entries
  const addJournalEntry = async (
    entryData: Omit<JournalEntry, 'id' | 'entryNumber'>
  ): Promise<JournalEntry> => {
    const entryNum = `JE-${5000 + journalEntries.length + 1}`;
    const newEntry: JournalEntry = {
      ...entryData,
      id: `je-${Date.now()}`,
      entryNumber: entryNum,
    };

    setJournalEntries(prev => [newEntry, ...prev]);

    setAccounts(prev =>
      prev.map(acc => {
        const line = entryData.lines.find(l => l.accountId === acc.id);
        if (!line) return acc;

        const isDebitNormal = [
          'Bank',
          'AccountsReceivable',
          'OtherCurrentAsset',
          'Inventory',
          'FixedAsset',
          'CostOfGoodsSold',
          'Expense',
          'OtherExpense',
        ].includes(acc.type);

        const delta = isDebitNormal
          ? line.debit - line.credit
          : line.credit - line.debit;

        return {
          ...acc,
          balance: round2(acc.balance + delta),
        };
      })
    );

    await logAuditAction(
      'JOURNAL_ENTRY',
      'JournalEntry',
      newEntry.id,
      `Posted General Journal Entry ${newEntry.entryNumber}: ${newEntry.memo}`
    );

    return newEntry;
  };

  // 11. Bank Transactions & Reconciliation
  const addBankTransaction = (
    txData: Omit<BankTransaction, 'id' | 'balance' | 'isCleared'>
  ): BankTransaction => {
    const newTx: BankTransaction = {
      ...txData,
      id: `tx-${Date.now()}`,
      balance: 0,
      isCleared: false,
    };
    setBankTransactions(prev => [newTx, ...prev]);

    setAccounts(prev =>
      prev.map(acc =>
        acc.id === txData.accountId
          ? { ...acc, balance: round2(acc.balance + txData.amount) }
          : acc
      )
    );

    logAuditAction('BANK_TRANSACTION', 'BankTransaction', newTx.id, `${txData.type}: ${txData.payee} (${getCurrencySymbol(companyProfile.currency)}${Math.abs(txData.amount).toFixed(2)})`);
    return newTx;
  };

  const toggleTransactionCleared = (txId: string) => {
    setBankTransactions(prev =>
      prev.map(tx => (tx.id === txId ? { ...tx, isCleared: !tx.isCleared } : tx))
    );
  };

  const importBankTransactions = (txs: Omit<BankTransaction, 'id' | 'balance' | 'isCleared'>[]) => {
    const formatted = txs.map(tx => ({
      ...tx,
      id: `tx-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      balance: 0,
      isCleared: false,
    }));
    setBankTransactions(prev => [...formatted, ...prev]);
    logAuditAction('IMPORT_FEED', 'BankTransaction', 'batch', `Imported ${txs.length} bank transactions via bank feed.`);
  };

  const commitReconciliation = async (
    recData: Omit<BankReconciliation, 'id' | 'reconciledAt'>
  ): Promise<BankReconciliation> => {
    const newRec: BankReconciliation = {
      ...recData,
      id: `rec-${Date.now()}`,
      reconciledAt: new Date().toISOString(),
    };
    setReconciliations(prev => [newRec, ...prev]);

    setBankTransactions(prev =>
      prev.map(tx =>
        recData.clearedTxIds.includes(tx.id) ? { ...tx, isCleared: true } : tx
      )
    );

    await logAuditAction(
      'BANK_RECONCILIATION',
      'BankReconciliation',
      newRec.id,
      `Reconciled statement ending ${newRec.statementDate} with ending balance ${getCurrencySymbol(companyProfile.currency)}${newRec.statementEndingBalance.toFixed(2)} (Difference: ${getCurrencySymbol(companyProfile.currency)}${newRec.difference.toFixed(2)})`
    );

    return newRec;
  };

  // Reset & Clear
  /**
   * Mark every financial domain as no longer server-verified.
   *
   * Used by the explicit demo-reset and clear actions: the rows they install
   * are a local working copy, so the domains must not keep reporting
   * `stale: false` (which the status bar reads as "current").
   */
  const markFinancialDataUnverified = (reason: string) => {
    setFinancialData(prev => {
      const next = { ...prev };
      for (const domain of FINANCIAL_DATA_DOMAINS) {
        next[domain] = { ...prev[domain], refreshing: false, stale: true, error: reason };
      }
      return next;
    });
  };

  const resetToDemoData = () => {
    setCompanyProfile(INITIAL_COMPANY_PROFILE);
    setAccounts(DEFAULT_CHART_OF_ACCOUNTS);
    setCustomers(INITIAL_CUSTOMERS);
    setVendors(INITIAL_VENDORS);
    setInventoryItems(INITIAL_INVENTORY_ITEMS);
    setQuickPrintJobs(INITIAL_QUICK_PRINT_JOBS);
    setExamPapers(INITIAL_EXAM_PAPERS);
    setPrintingContracts(INITIAL_PRINTING_CONTRACTS);
    setInvoices(INITIAL_INVOICES);
    setEstimates(INITIAL_ESTIMATES);
    setPaymentsReceived([]);
    setBills(INITIAL_BILLS);
    setBillPayments([]);
    setEmployees(INITIAL_EMPLOYEES);
    setPayrollRuns(INITIAL_PAYROLL_RUNS);
    setJournalEntries([]);
    setBankTransactions(INITIAL_BANK_TRANSACTIONS);
    setReconciliations([]);
    setAuditLogs(INITIAL_AUDIT_LOGS);
    localStorage.removeItem(PREFS_STORAGE_KEY);
    markFinancialDataUnverified('Sample data loaded in this browser — not verified against the server ledger.');
    triggerShortcutNotice('Reloaded the sample lists in this browser. The server ledger is unchanged.', 'info');
  };

  const clearAllData = () => {
    setCustomers([]);
    setVendors([]);
    setInventoryItems([]);
    setQuickPrintJobs([]);
    setExamPapers([]);
    setPrintingContracts([]);
    setInvoices([]);
    setEstimates([]);
    setPaymentsReceived([]);
    setBills([]);
    setBillPayments([]);
    setPayrollRuns([]);
    setJournalEntries([]);
    setBankTransactions([]);
    setReconciliations([]);
    setAccounts(DEFAULT_CHART_OF_ACCOUNTS.map(a => ({ ...a, balance: 0 })));
    markFinancialDataUnverified('Local lists cleared in this browser — not verified against the server ledger.');
    triggerShortcutNotice('Cleared the cached lists in this browser. The server ledger is unchanged.', 'info');
  };

  const exportDataToJson = () => {
    const data = {
      version: 'Printing-Management-System-2026-v2',
      kind: 'browser-working-copy',
      note:
        'A snapshot of the lists currently held in this browser. It is NOT a backup of the server ledger and restoring it does not post any journal entry.',
      exportedAt: new Date().toISOString(),
      companyProfile,
      customers,
      vendors,
      inventoryItems,
      quickPrintJobs,
      examPapers,
      printingContracts,
      invoices,
      estimates,
      paymentsReceived,
      bills,
      billPayments,
      employees,
      payrollRuns,
      journalEntries,
      bankTransactions,
      reconciliations,
      auditLogs,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `PMS_working-copy_${companyProfile.name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    triggerShortcutNotice('Downloaded the browser working copy', 'info');
  };

  const importDataFromJson = (jsonData: string): boolean => {
    try {
      const parsed = JSON.parse(jsonData);
      if (parsed.companyProfile) {
        setCompanyProfile(parsed.companyProfile);
        // COA sourced from backend; do not override with imported legacy accounts.
        if (parsed.customers) setCustomers(parsed.customers);
        if (parsed.vendors) setVendors(parsed.vendors);
        if (parsed.inventoryItems) setInventoryItems(parsed.inventoryItems);
        if (parsed.quickPrintJobs) setQuickPrintJobs(parsed.quickPrintJobs);
        if (parsed.examPapers) setExamPapers(parsed.examPapers);
        if (parsed.printingContracts) setPrintingContracts(parsed.printingContracts);
        if (parsed.invoices) setInvoices(parsed.invoices);
        if (parsed.estimates) setEstimates(parsed.estimates);
        if (parsed.paymentsReceived) setPaymentsReceived(parsed.paymentsReceived);
        if (parsed.bills) setBills(parsed.bills);
        if (parsed.billPayments) setBillPayments(parsed.billPayments);
        if (parsed.employees) setEmployees(parsed.employees);
        if (parsed.payrollRuns) setPayrollRuns(parsed.payrollRuns);
        if (parsed.journalEntries) setJournalEntries(parsed.journalEntries);
        if (parsed.bankTransactions) setBankTransactions(parsed.bankTransactions);
        if (parsed.reconciliations) setReconciliations(parsed.reconciliations);
        if (parsed.auditLogs) setAuditLogs(parsed.auditLogs);
        triggerShortcutNotice(
          'Working copy restored into this browser. The server ledger was not changed.',
          'info'
        );
        return true;
      }
    } catch {
      // error parsing
    }
    return false;
  };

  return (
    <AccountingContext.Provider
      value={{
        companyProfile,
        setCompanyProfile,
        updateCompanyProfile,
        accounts,
        setAccounts,
        addAccount,
        getAccountById,
        customers,
        addCustomer,
        updateCustomer,
        getCustomerById,
        vendors,
        addVendor,
        updateVendor,
        getVendorById,
        inventoryItems,
        addInventoryItem,
        updateInventoryItem,
        adjustInventoryStock,
        getRawUsageUnitCost,
        computeBomUnitCost,
        getItemUnitCost,
        quickPrintJobs,
        addQuickPrintJob,
        examPapers,
        addExamPaper,
        addExamPapersBatch,
        listExamGroups,
        getExamGroupForBatch,
        getExamGroupSummary,
        runExamGroupWorkflow,
        updateExamPaper,
        editExamPaper,
        updateExamPaperStatus,
        deliverExamPaper,
        deleteExamPaper,
        cancelExamPaper,
        reprintExamPaper,
        getExamPaperEvents,
        approveExamBatchSpec,
        getExamReconciliation,
        createConsolidatedSchoolInvoice,
        printingContracts,
        addPrintingContract,
        updateContractAssessment,
        linkContractDepositInvoice,
        linkMilestoneInvoice,
        completeContractAssessment,
        cancelPrintingContract,
        activatePrintingContract,
        renewPrintingContract,
        amendPrintingContract,
    suspendContract,
    resumeContract,
    listContractAmendments,
    approveContractAmendment,
    rejectContractAmendment,
    recordContractAcceptance,
    voidPrintingContract,
    listContractSignatures,
    recordContractSignature,
    getContractReconciliation,
        addContractAssessment,
        removeContractAssessment,
        getAssessmentActualStats,
        linkQuickPrintInvoice,
        linkExamPapersInvoice,
        generateAndSyncWorkflowInvoice,
        invoices,
        addInvoice,
        markInvoicePaid,
        getInvoiceById,
        estimates,
        addEstimate,
        convertEstimateToInvoice,
        paymentsReceived,
        recordPaymentReceived,
        bills,
        addBill,
        payBill,
        billPayments,
        employees,
        addEmployee,
        updateEmployee,
        payrollRuns,
        processPayrollRun,
        journalEntries,
        addJournalEntry,
        bankTransactions,
        addBankTransaction,
        toggleTransactionCleared,
        importBankTransactions,
        reconciliations,
        commitReconciliation,
        auditLogs,
        logAuditAction,
        currentView,
        setCurrentView,
        isNewInvoiceOpen,
        setIsNewInvoiceOpen,
        isReceivePaymentOpen,
        setIsReceivePaymentOpen,
        isEnterBillOpen,
        setIsEnterBillOpen,
        isPayBillsOpen,
        setIsPayBillsOpen,
        isWriteCheckOpen,
        setIsWriteCheckOpen,
        isJournalEntryOpen,
        setIsJournalEntryOpen,
        isNewCustomerOpen,
        setIsNewCustomerOpen,
        isNewVendorOpen,
        setIsNewVendorOpen,
        isNewItemOpen,
        setIsNewItemOpen,
        isNewEmployeeOpen,
        setIsNewEmployeeOpen,
        isOcrScannerOpen,
        setIsOcrScannerOpen,
        isIifImportOpen,
        setIsIifImportOpen,
        isStatementOpen,
        setIsStatementOpen,
        isCommandPaletteOpen,
        setIsCommandPaletteOpen,
        isPosModalOpen,
        setIsPosModalOpen,
        previewDocument,
        openDocumentPreview,
        closeDocumentPreview,
        primePreview,
        openPrimePreview,
        closePrimePreview,
        resetToDemoData,
        clearAllData,
        exportDataToJson,
        importDataFromJson,
        isSidebarCollapsed,
        setIsSidebarCollapsed,
        isMobileDrawerOpen,
        setIsMobileDrawerOpen,
        tableDensity,
        setTableDensity,
        activeShortcutNotice,
        triggerShortcutNotice,
        dismissShortcutNotice,
        financialData,
        refreshFinancialData,
      }}
    >
      {children}
    </AccountingContext.Provider>
  );
};

export const useAccounting = () => {
  const context = useContext(AccountingContext);
  if (!context) {
    throw new Error('useAccounting must be used within an AccountingProvider');
  }
  return context;
};



