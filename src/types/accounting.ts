export type AccountType =
  | 'Bank'
  | 'AccountsReceivable'
  | 'OtherCurrentAsset'
  | 'Inventory'
  | 'FixedAsset'
  | 'AccountsPayable'
  | 'CreditCard'
  | 'OtherCurrentLiability'
  | 'PayrollLiability'
  | 'LongTermLiability'
  | 'Equity'
  | 'Income'
  | 'CostOfGoodsSold'
  | 'Expense'
  | 'OtherExpense';

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  description?: string;
  parentId?: string;
  balance: number;
  isSystem?: boolean;
}

export interface Customer {
  id: string;
  name: string;
  companyName: string;
  email: string;
  phone: string;
  billingAddress: string;
  terms: 'Due on Receipt' | 'Net 15' | 'Net 30' | 'Net 60';
  balance: number;
  notes?: string;
  customerType?: 'school' | 'corporate' | 'individual';
}

export interface Vendor {
  id: string;
  name: string;
  companyName: string;
  email: string;
  phone: string;
  address: string;
  einOrSsn?: string;
  defaultExpenseAccountId?: string;
  terms: 'Due on Receipt' | 'Net 15' | 'Net 30' | 'Net 60';
  balance: number;
}

export type ItemType = 'raw_material' | 'printed_product' | 'stationery' | 'printing_service';

export const INVOICEABLE_ITEM_TYPES: ItemType[] = [
  'printed_product',
  'stationery',
  'printing_service',
];

export const STOCKED_ITEM_TYPES: ItemType[] = ['raw_material', 'stationery'];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  raw_material: 'Raw Material',
  printed_product: 'Printed Product (BOM)',
  stationery: 'Stationary Item',
  printing_service: 'Printing Service',
};

export interface BomComponent {
  rawMaterialId: string;
  quantityPerUnit: number; // Measured in the Raw Material's usageUnit (e.g. Sheets, Impressions, Staples)
}

export interface ItemVariant {
  id: string;
  name: string; // e.g., '2 Quire', 'A4 Standard', 'Blue Ink'
  sku: string;
  cost: number; // Auto-calculated from bomLines for printed_product variants
  salesPrice: number; // Manually entered
  onHand: number; // Tracked for stationery variants; always 0 for printed_product
  reorderPoint: number; // Tracked for stationery variants; always 0 for printed_product
  bomLines?: BomComponent[];
}

export interface InventoryItem {
  id: string;
  name: string;
  sku: string;
  type: ItemType;
  description: string;
  cost: number; // For raw_material: cost per purchaseUnit. For printed_product & printing_service: driven from BOM raw material costs.
  salesPrice: number; // Manually entered selling price (0 for raw_material)
  onHand: number; // Tracked in purchaseUnit for raw_material / stationery; 0 for printed_product & printing_service
  reorderPoint: number;
  // Raw Material Unit Conversion (e.g., Bought in Ream = 500 Sheets)
  purchaseUnit?: string; // e.g. 'Ream', 'Cartridge', 'Pack', 'Box'
  usageUnit?: string; // e.g. 'Sheet', 'Impression', 'Staple'
  conversionFactor?: number; // Number of usageUnits inside 1 purchaseUnit
  assetAccountId: string;
  cogsAccountId: string;
  incomeAccountId: string;
  bomLines?: BomComponent[]; // Supported on printed_product AND printing_service (Quick Photocopy, Type & Printing, etc.)
  variants?: ItemVariant[]; // Supported on stationery AND printed_product
}

export type QuickPrintJobType = 'quick_photocopy' | 'type_and_printing' | 'general_print';

export interface QuickPrintJob {
  id: string;
  jobNumber: string;
  customerId?: string;
  customerName: string;
  jobType: QuickPrintJobType;
  title: string;
  pages: number;
  copies: number;
  printSide: 'Single-Sided' | 'Duplex';
  rawPaperItemId: string;
  rawTonerItemId: string;
  sheetsUsed: number;
  impressionsUsed: number;
  paperCost: number;
  tonerCost: number;
  typingFee?: number;
  extraCostPerPage?: number; // Extra typing / finishing cost charged per page
  extraCost: number;
  totalCost: number;
  sellingPricePerSheet?: number; // Manually entered selling price per sheet
  sellingPriceTotal: number; // Calculated total selling price (sellingPricePerSheet * sheetsUsed)
  profit: number;
  date: string;
  invoiceId?: string;
  backendInvoiceId?: number;
  linkedInvoiceNumber?: string;
  notes?: string;
}

export type ExamPaperStatus =
  | 'draft'
  | 'scheduled'
  | 'queued'
  | 'reserved'
  | 'printing'
  | 'qc_hold'
  | 'qc_passed'
  | 'completed'
  | 'packed'
  | 'dispatched'
  | 'delivered'
  | 'invoiced'
  | 'cancelled'
  | 'reprinted';

export interface ExamPaper {
  id: string;
  backendId?: number;
  jobNumber: string;
  schoolCustomerId: string;
  assessmentName: string;
  className: string;
  learnersCount: number; // Pricing is per learner in each class (not per subject)
  pricePerLearner: number; // Manually entered selling price per learner in this class
  subjectName: string;
  pages: number;
  copies: number;
  teacherCopies?: number; // D3: fixed at 2 free teacher copies per paper
  plannedProductionQuantity?: number; // D3: learner quantity + teacher copies
  billableQuantity?: number; // D3: accepted billable learner quantity (never invoiced for teacher copies)
  acceptedLearnerQuantity?: number; // D3: accepted learner copies after QC
  damagedTeacherCopies?: number;
  damagedLearnerCopies?: number;
  replacementTeacherCopies?: number;
  replacementLearnerCopies?: number;
  paperSize: 'A4' | 'A3' | 'B5' | 'Letter';
  printSide: 'Single-Sided' | 'Duplex';
  bindingType: 'Stapled' | 'Saddle-Stitched' | 'Loose Leaf' | 'Booklet';
  paperSpecId?: string;
  printingItemId?: string;
  productionJobId?: number;
  rawPaperItemId?: string;
  rawTonerItemId?: string;
  ratePerPage: number; // Reference rate; consolidated class billing uses learnersCount * pricePerLearner
  totalAmount: number;
  sheetsUsed: number;
  impressionsUsed: number;
  paperCost: number;
  tonerCost: number;
  materialCost: number;
  costStatus?: 'authoritative' | 'estimated' | 'unavailable' | 'legacy_unverified';
  costWarnings?: string[];
  status: ExamPaperStatus;
  productionDate: string;
  qcStatus?: string;
  qcApprovedCopies?: number;
  goodCopies?: number;
  spoiledCopies?: number;
  wasteSheets?: number;
  startedAt?: string;
  completedAt?: string;
  packedAt?: string;
  dispatchedAt?: string;
  deliveredAt?: string;
  cancelledAt?: string;
  reprintOfPaperId?: number;
  reprintReason?: string;
  productionVersion?: number;
  qcNotes?: string;
  packageCount?: number;
  sealReference?: string;
  deliveryNoteId?: number;
  invoiceId?: string;
  backendInvoiceId?: number;
  linkedInvoiceNumber?: string;
  contractId?: string;
  assessmentNumber?: number;
  notes?: string;
}

export interface ContractAssessmentMilestone {
  assessmentNumber: number;
  label: string;
  scheduledDate: string; // Specific scheduled date for this assessment
  agreedAmount: number; // Revenue deducted for this assessment
  rawPaperItemId?: string;
  rawTonerItemId?: string;
  estimatedSheets: number;
  estimatedImpressions: number;
  paperCost: number;
  tonerCost: number;
  totalCost: number;
  profit: number;
  status: 'pending' | 'completed';
  completedDate?: string;
  examBatchNote?: string;
  linkedInvoiceId?: string;
  backendInvoiceId?: number;
  linkedInvoiceNumber?: string;
}

export interface PrintingContract {
  id: string;
  backendId?: number;
  contractNumber: string;
  schoolCustomerId: string;
  title: string;
  academicYear: string;
  startDate: string;
  endDate: string;
  totalPrepaidAmount: number;
  totalAssessments: 2 | 3 | 4 | 5;
  remainingBalance: number;
  completedAssessments: number;
  depositBankAccountId: string;
  status: 'draft' | 'active' | 'suspended' | 'completed' | 'exhausted' | 'cancelled';
  activatedAt?: string;
  activatedBy?: number;
  completedAt?: string;
  completedBy?: number;
  suspendedAt?: string;
  suspendedBy?: number;
  suspensionReason?: string;
  resumedAt?: string;
  resumedBy?: number;
  renewalOfContractId?: number;
  customerAcceptanceId?: number;
  /** Liability account carrying the unearned retainer (G-11). */
  liabilityAccountId?: number;
  /** Sum of agreed assessment amounts not yet spent (G-18). */
  unallocatedAmount?: number;
  /** Funds already allocated from the customer wallet. */
  allocatedAmount?: number;
  /** All assessments complete but retainer cash remains (G-21). */
  creditBalance?: boolean;
  updatedAt?: string;
  /** Whether this contract came from the server or the bundled demo set (G-11). */
  source?: 'backend' | 'local';
  assessments: ContractAssessmentMilestone[];
  depositInvoiceId?: string;
  depositBackendInvoiceId?: number;
  depositInvoiceNumber?: string;
  notes?: string;
}

export interface InvoiceLine {
  id: string;
  itemId?: string;
  variantId?: string;
  variantName?: string;
  description: string;
  quantity: number;
  rate: number; // Manual selling unit price
  amount: number;
  unitCost?: number; // Raw-material-driven unit cost
  totalCost?: number; // quantity * unitCost
  taxable: boolean;
}

export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'overdue';

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  date: string;
  dueDate: string;
  terms: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  totalCost?: number; // Real production/material cost
  grossProfit?: number; // subtotal - totalCost
  amountPaid: number;
  balanceDue: number;
  backendInvoiceId?: number;
  notes?: string;
}

export interface Estimate {
  id: string;
  estimateNumber: string;
  customerId: string;
  date: string;
  expiryDate: string;
  status: 'pending' | 'accepted' | 'rejected' | 'invoiced';
  lines: InvoiceLine[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  notes?: string;
}

export interface PaymentReceived {
  id: string;
  paymentNumber: string;
  customerId: string;
  invoiceId: string;
  date: string;
  amount: number;
  paymentMethod: 'Check' | 'Credit Card' | 'Cash' | 'ACH / Wire';
  referenceNumber?: string;
  depositToAccountId: string;
  memo?: string;
}

export interface BillLine {
  id: string;
  accountId: string;
  description: string;
  amount: number;
}

export type BillStatus = 'open' | 'partial' | 'paid' | 'overdue';

export interface Bill {
  id: string;
  billNumber: string;
  vendorId: string;
  date: string;
  dueDate: string;
  terms: string;
  status: BillStatus;
  lines: BillLine[];
  total: number;
  amountPaid: number;
  balanceDue: number;
  memo?: string;
}

export interface BillPayment {
  id: string;
  paymentNumber: string;
  vendorId: string;
  billId: string;
  date: string;
  amount: number;
  bankAccountId: string;
  checkNumber?: string;
  memo?: string;
}

export type EmployeeFilingStatus = 'single' | 'married' | 'head_of_household';

export interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  phone: string;
  ssnMasked: string;
  hireDate: string;
  payType: 'hourly' | 'salary';
  payRate: number;
  payFrequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
  filingStatus: EmployeeFilingStatus;
  w4Allowances: number;
  directDepositRouting: string;
  directDepositAccountMasked: string;
  department: string;
}

export interface PayrollItem {
  employeeId: string;
  hoursWorked: number;
  overtimeHours: number;
  grossPay: number;
  fit: number;
  socialSecurityEmployee: number;
  medicareEmployee: number;
  sit: number;
  netPay: number;
  socialSecurityEmployer: number;
  medicareEmployer: number;
  futaEmployer: number;
  sutaEmployer: number;
}

export interface PayrollRun {
  id: string;
  runNumber: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  payDate: string;
  totalGross: number;
  totalNet: number;
  totalEmployeeTaxes: number;
  totalEmployerTaxes: number;
  items: PayrollItem[];
  bankAccountId: string;
  status: 'processed';
}

export interface JournalLine {
  id: string;
  accountId: string;
  description: string;
  debit: number;
  credit: number;
}

export interface JournalEntry {
  id: string;
  entryNumber: string;
  date: string;
  memo: string;
  lines: JournalLine[];
  source?: 'manual' | 'invoice' | 'bill' | 'payroll' | 'payment' | 'reconciliation' | 'contract' | 'quick_print';
  sourceRefId?: string;
}

export interface BankTransaction {
  id: string;
  accountId: string;
  date: string;
  payee: string;
  type: 'Check' | 'Deposit' | 'Transfer' | 'Bill Payment' | 'Debit' | 'Fee';
  refNumber?: string;
  memo: string;
  amount: number;
  balance: number;
  isCleared: boolean;
  category?: string;
}

export interface BankReconciliation {
  id: string;
  accountId: string;
  statementDate: string;
  statementEndingBalance: number;
  clearedBalance: number;
  difference: number;
  clearedTxIds: string[];
  reconciledAt: string;
}

export type ThemeStyle = 'classic' | 'slate' | 'midnight';

export interface CompanyProfile {
  name: string;
  legalName: string;
  ein: string;
  address: string;
  cityStateZip: string;
  phone: string;
  email: string;
  website: string;
  fiscalYearStartMonth: number;
  accountingMethod: 'accrual' | 'cash';
  currency: string;
  defaultBankAccountId: string;
  salesTaxRate: number;
  theme: ThemeStyle;
  isServerEdition: boolean;
  serverAddress: string;
  currentUserRole: 'Administrator' | 'Bookkeeper' | 'Accountant' | 'ProductionManager' | 'Read-Only';
}

export interface AuditLog {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  entityType: string;
  entityId: string;
  details: string;
  sha256Hash: string;
}
