import { emitAccountingUpdated } from './accountingApi';
import { buildQuery, requestJson } from './http';

export interface ApiCustomer {
  id: number;
  name: string;
  companyName: string;
  email: string;
  phone: string;
  address: string;
  terms: string;
  creditLimit: number | null;
  taxExempt: boolean;
  balance: number;
  balanceStr: string;
  isActive: boolean;
}

export interface ApiInvoice {
  id: number;
  invoiceNumber: string;
  customerId: number;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  terms: string;
  status: string;
  isSalesReceipt: boolean;
  currencyCode: string;
  exchangeRate: number;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  totalCost: number;
  grossProfit: number;
  journalTxnId: number | null;
  notes: string;
  lines: Array<{
    lineOrder: number;
    itemId: number | null;
    variantId: number | null;
    description: string;
    quantity: number;
    unitCost: number;
    rate: number;
    amount: number;
    taxable: boolean;
  }>;
}

export interface ApiVendor {
  id: number;
  name: string;
  companyName: string;
  email: string;
  phone: string;
  address: string;
  taxId: string;
  is1099Eligible: boolean;
  defaultExpenseAccountId: number | null;
  terms: string;
  balance: number;
  isActive: boolean;
}

export interface ApiBill {
  id: number;
  billNumber: string;
  vendorId: number;
  vendorName: string;
  billDate: string;
  dueDate: string;
  terms: string;
  status: string;
  total: number;
  amountPaid: number;
  balanceDue: number;
  purchaseOrderId: number | null;
  currencyCode: string;
  exchangeRate: number;
  journalTxnId: number | null;
  memo: string;
  lines: Array<{
    lineOrder: number;
    accountId: number;
    accountName: string;
    itemId: number | null;
    description: string;
    quantity: number;
    unitCost: number;
    amount: number;
    useTaxRate: number;
  }>;
}

export interface ApiPurchaseOrder {
  id: number;
  poNumber: string;
  vendorId: number;
  vendorName: string;
  poDate: string;
  expectedDate: string | null;
  shipTo: string;
  status: string;
  total: number;
  notes: string;
  lines: Array<{
    id: number;
    lineOrder: number;
    itemId: number | null;
    accountId: number | null;
    description: string;
    quantity: number;
    receivedQty: number;
    rate: number;
    amount: number;
    billedAmount: number;
  }>;
}

export interface ApiBankAccount {
  id: number;
  glAccountId: number;
  accountCode: string;
  accountName: string;
  accountType: string;
  institutionName: string;
  accountMask: string;
  feedProvider: string;
  lastSyncedAt: string | null;
  nextCheckNumber: number;
  glBalance: number;
  pendingImportCount: number;
}

export interface ApiBankTransaction {
  id: number;
  accountId: number;
  accountName: string;
  date: string;
  payee: string;
  type: string;
  refNumber: string;
  memo: string;
  amount: number;
  runningBalance: number;
  cleared: boolean;
  status: 'pending_import' | 'posted' | 'voided';
  reconciliationId: number | null;
  journalTxnId: number | null;
  category: string;
  offsetAccountId: number | null;
  offsetAccountName: string;
  checkNumber: string;
  printLater: boolean;
  printedAt: string | null;
}

function normalizeInvoice(raw: any): ApiInvoice {
  return {
    id: Number(raw.id),
    invoiceNumber: raw.invoiceNumber || raw.invoice_number || '',
    customerId: Number(raw.customerId ?? raw.customer_id),
    customerName: raw.customerName || raw.customer_name || '',
    invoiceDate: raw.invoiceDate || raw.invoice_date || raw.date || '',
    dueDate: raw.dueDate || raw.due_date || '',
    terms: raw.terms || 'Net 30',
    status: raw.status || 'open',
    isSalesReceipt: Boolean(raw.isSalesReceipt),
    currencyCode: raw.currencyCode || 'ZMW',
    exchangeRate: Number(raw.exchangeRate ?? 1),
    subtotal: Number(raw.subtotalNum ?? raw.subtotal ?? 0),
    taxRate: Number(raw.taxRate ?? 0),
    taxAmount: Number(raw.taxAmountNum ?? raw.tax_amount ?? 0),
    total: Number(raw.totalNum ?? raw.total ?? 0),
    amountPaid: Number(raw.amountPaidNum ?? raw.amountPaid ?? 0),
    balanceDue: Number(raw.balanceDueNum ?? raw.balance_due ?? 0),
    totalCost: Number(raw.totalCostNum ?? raw.total_cost ?? 0),
    grossProfit: Number(raw.grossProfitNum ?? raw.gross_profit ?? 0),
    journalTxnId: raw.journalTxnId !== null && raw.journalTxnId !== undefined ? Number(raw.journalTxnId) : null,
    notes: raw.notes || '',
    lines: Array.isArray(raw.lines) ? raw.lines : [],
  };
}

export const commercialApi = {
  // Customers & Sales
  async listCustomers(): Promise<ApiCustomer[]> {
    const d = await requestJson<{ customers: ApiCustomer[] }>('/api/customers');
    return d.customers;
  },
  async createCustomer(payload: Partial<ApiCustomer> & { companyName: string }): Promise<ApiCustomer> {
    const d = await requestJson<{ customer: ApiCustomer }>('/api/customers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.customer;
  },
  async updateCustomer(id: number, payload: Partial<ApiCustomer>): Promise<ApiCustomer> {
    const d = await requestJson<{ customer: ApiCustomer }>(`/api/customers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.customer;
  },
  async getCustomerStatement(id: number, params: { periodStart?: string; periodEnd?: string; saveSnapshot?: boolean } = {}) {
    const d = await requestJson<{ statement: any }>(`/api/customers/${id}/statement${buildQuery(params)}`);
    return d.statement;
  },
  async listResellerPermits(customerId?: number) {
    const d = await requestJson<{ permits: any[] }>(`/api/reseller-permits${buildQuery({ customerId })}`);
    return d.permits;
  },
  async createResellerPermit(payload: { customerId: number; permitNumber: string; state?: string; expiresAt?: string; notes?: string }) {
    const d = await requestJson<{ permit: any }>('/api/reseller-permits', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.permit;
  },
  async listInvoices(params: { customerId?: number; isSalesReceipt?: boolean } = {}): Promise<ApiInvoice[]> {
    const d = await requestJson<{ invoices: any[] }>(`/api/invoices${buildQuery(params)}`);
    return d.invoices.map(normalizeInvoice);
  },
  async createInvoice(payload: any): Promise<ApiInvoice> {
    const d = await requestJson<{ invoice: any }>('/api/invoices', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return normalizeInvoice(d.invoice);
  },
  async updateInvoiceNotes(id: number, note: string) {
    const d = await requestJson<any>(`/api/invoices/${id}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    });
    emitAccountingUpdated();
    return d;
  },
  async voidInvoice(id: number, reason?: string) {
    const d = await requestJson<any>(`/api/invoices/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d;
  },
  async listPayments(customerId?: number) {
    const d = await requestJson<{ payments: any[] }>(`/api/payments${buildQuery({ customerId })}`);
    return d.payments;
  },
  async recordPayment(payload: any) {
    const d = await requestJson<any>('/api/payments', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.payment;
  },
  async voidPayment(id: number, reason?: string) {
    const d = await requestJson<any>(`/api/payments/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d;
  },
  async listCreditMemos(customerId?: number) {
    const d = await requestJson<{ creditMemos: any[] }>(`/api/credit-memos${buildQuery({ customerId })}`);
    return d.creditMemos;
  },
  async createCreditMemo(payload: any) {
    const d = await requestJson<any>('/api/credit-memos', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.creditMemo;
  },
  async applyCreditMemo(id: number, payload: { invoiceId: number; amount: number | string; appliedDate?: string }) {
    const d = await requestJson<{ creditMemo: any }>(`/api/credit-memos/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.creditMemo;
  },
  async voidCreditMemo(id: number, reason?: string) {
    const d = await requestJson<{ creditMemo: any }>(`/api/credit-memos/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d.creditMemo;
  },
  async listEstimates() {
    const d = await requestJson<{ costDetailsIncluded: boolean; estimates: any[] }>('/api/estimates');
    return d;
  },
  async createEstimate(payload: any) {
    const d = await requestJson<{ estimate: any }>('/api/estimates', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.estimate;
  },
  async convertEstimate(id: number) {
    const d = await requestJson<any>(`/api/estimates/${id}/convert`, { method: 'POST', body: '{}' });
    emitAccountingUpdated();
    return d;
  },
  async getArAging(asOfDate?: string) {
    const d = await requestJson<{ report: any }>(`/api/reports/ar-aging${buildQuery({ asOfDate })}`);
    return d.report;
  },
  async listRecurringInvoices() {
    const d = await requestJson<{ recurringInvoices: any[] }>('/api/recurring-invoices');
    return d.recurringInvoices;
  },
  async createRecurringInvoice(payload: any) {
    const d = await requestJson<{ recurringInvoice: any }>('/api/recurring-invoices', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.recurringInvoice;
  },
  async runDueRecurringInvoices(asOfDate?: string) {
    const d = await requestJson<any>('/api/recurring-invoices/run-due', {
      method: 'POST',
      body: JSON.stringify({ asOfDate }),
    });
    emitAccountingUpdated();
    return d;
  },
  async getCommunications() {
    return requestJson<any>('/api/communications');
  },
  async sendInvoiceReminder(invoiceId: number, payload: { recipient?: string; subject?: string } = {}) {
    const d = await requestJson<{ reminder: any }>(`/api/invoices/${invoiceId}/remind`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.reminder;
  },

  // Purchasing & Payables
  async listVendors(): Promise<ApiVendor[]> {
    const d = await requestJson<{ vendors: ApiVendor[] }>('/api/vendors');
    return d.vendors;
  },
  async createVendor(payload: any): Promise<ApiVendor> {
    const d = await requestJson<{ vendor: ApiVendor }>('/api/vendors', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.vendor;
  },
  async getVendorStatement(id: number, params: { periodStart?: string; periodEnd?: string } = {}) {
    const d = await requestJson<{ statement: any }>(`/api/vendors/${id}/statement${buildQuery(params)}`);
    return d.statement;
  },
  async listPurchaseOrders(): Promise<ApiPurchaseOrder[]> {
    const d = await requestJson<{ purchaseOrders: ApiPurchaseOrder[] }>('/api/purchase-orders');
    return d.purchaseOrders;
  },
  async createPurchaseOrder(payload: any): Promise<ApiPurchaseOrder> {
    const d = await requestJson<{ purchaseOrder: ApiPurchaseOrder }>('/api/purchase-orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.purchaseOrder;
  },
  async receivePurchaseOrder(poId: number, payload: any = {}) {
    const d = await requestJson<any>(`/api/purchase-orders/${poId}/receive`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d;
  },
  async listBills(vendorId?: number): Promise<ApiBill[]> {
    const d = await requestJson<{ bills: ApiBill[] }>(`/api/bills${buildQuery({ vendorId })}`);
    return d.bills;
  },
  async createBill(payload: any): Promise<ApiBill> {
    const d = await requestJson<{ bill: ApiBill }>('/api/bills', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.bill;
  },
  async voidBill(id: number, reason?: string) {
    const d = await requestJson<any>(`/api/bills/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d;
  },
  async listBillPayments(vendorId?: number) {
    const d = await requestJson<{ billPayments: any[] }>(`/api/bill-payments${buildQuery({ vendorId })}`);
    return d.billPayments;
  },
  async recordBillPayment(payload: any) {
    const d = await requestJson<any>('/api/bill-payments', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.billPayment;
  },
  async voidBillPayment(id: number, reason?: string) {
    const d = await requestJson<any>(`/api/bill-payments/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d;
  },
  async listVendorCredits(vendorId?: number) {
    const d = await requestJson<{ vendorCredits: any[] }>(`/api/vendor-credits${buildQuery({ vendorId })}`);
    return d.vendorCredits;
  },
  async createVendorCredit(payload: any) {
    const d = await requestJson<{ vendorCredit: any }>('/api/vendor-credits', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.vendorCredit;
  },
  async applyVendorCredit(id: number, payload: { billId: number; amount: number | string }) {
    const d = await requestJson<{ vendorCredit: any }>(`/api/vendor-credits/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.vendorCredit;
  },
  async getApAging(asOfDate?: string) {
    const d = await requestJson<{ report: any }>(`/api/reports/ap-aging${buildQuery({ asOfDate })}`);
    return d.report;
  },

  // Banking & Reconciliation
  async listBankAccounts(): Promise<ApiBankAccount[]> {
    const d = await requestJson<{ bankAccounts: ApiBankAccount[] }>('/api/banking/accounts');
    return d.bankAccounts;
  },
  async linkBankAccount(payload: any): Promise<ApiBankAccount> {
    const d = await requestJson<{ bankAccount: ApiBankAccount }>('/api/banking/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.bankAccount;
  },
  async listBankTransactions(params: { accountId?: number; status?: string } = {}): Promise<ApiBankTransaction[]> {
    const d = await requestJson<{ transactions: ApiBankTransaction[] }>(`/api/banking/transactions${buildQuery(params)}`);
    return d.transactions;
  },
  async recordExpenseOrCheck(payload: any) {
    const d = await requestJson<{ transaction: ApiBankTransaction }>('/api/banking/expenses', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.transaction;
  },
  async markChecksPrinted(bankTxnIds: number[]) {
    const d = await requestJson<{ printedCount: number }>('/api/banking/checks/print', {
      method: 'POST',
      body: JSON.stringify({ bankTxnIds }),
    });
    return d;
  },
  async recordDeposit(payload: any) {
    const d = await requestJson<{ transaction: ApiBankTransaction }>('/api/banking/deposits', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.transaction;
  },
  async recordTransfer(payload: any) {
    const d = await requestJson<any>('/api/banking/transfers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d;
  },
  async voidBankTransaction(id: number, reason?: string) {
    const d = await requestJson<any>(`/api/banking/transactions/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d;
  },
  async toggleCleared(id: number, cleared: boolean) {
    return requestJson<any>(`/api/banking/transactions/${id}/cleared`, {
      method: 'PATCH',
      body: JSON.stringify({ cleared }),
    });
  },
  async listBankRules() {
    const d = await requestJson<{ rules: any[] }>('/api/banking/rules');
    return d.rules;
  },
  async createBankRule(payload: any) {
    const d = await requestJson<{ rule: any }>('/api/banking/rules', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.rule;
  },
  async deleteBankRule(id: number) {
    return requestJson<any>(`/api/banking/rules/${id}`, { method: 'DELETE' });
  },
  async importBankStatement(payload: any) {
    const d = await requestJson<any>('/api/banking/imports', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d;
  },
  async categorizeFeedTxn(id: number, payload: { offsetAccountId: number; vendorId?: number | null; customerId?: number | null; memo?: string }) {
    const d = await requestJson<{ transaction: ApiBankTransaction }>(`/api/banking/transactions/${id}/categorize`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.transaction;
  },
  async listReconciliations(accountId?: number) {
    const d = await requestJson<{ reconciliations: any[] }>(`/api/banking/reconciliations${buildQuery({ accountId })}`);
    return d.reconciliations;
  },
  async previewReconciliation(payload: any) {
    const d = await requestJson<{ preview: any }>('/api/banking/reconciliations/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.preview;
  },
  async completeReconciliation(payload: any) {
    const d = await requestJson<{ reconciliation: any }>('/api/banking/reconciliations/complete', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.reconciliation;
  },
  async reverseReconciliation(id: number, reason: string) {
    const d = await requestJson<{ reconciliation: any }>(`/api/banking/reconciliations/${id}/reverse`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d.reconciliation;
  },

  // Budgets, Tax, FX, Saved Reports, Analytics
  async getBudgetMatrix(fiscalYear: number) {
    return requestJson<{ fiscalYear: number; rows: any[] }>(`/api/budgets${buildQuery({ fiscalYear })}`);
  },
  async saveBudgetEntries(fiscalYear: number, entries: Array<{ accountId: number; fiscalMonth: number; amount: number | string }>) {
    return requestJson<{ fiscalYear: number; rows: any[] }>('/api/budgets', {
      method: 'PUT',
      body: JSON.stringify({ fiscalYear, entries }),
    });
  },
  async getBudgetVsActual(fiscalYear: number, startMonth = 1, endMonth = 12) {
    const d = await requestJson<{ report: any }>(`/api/reports/budget-vs-actual${buildQuery({ fiscalYear, startMonth, endMonth })}`);
    return d.report;
  },
  async getTaxSummary(startDate?: string, endDate?: string) {
    const d = await requestJson<{ summary: any }>(`/api/tax/summary${buildQuery({ startDate, endDate })}`);
    return d.summary;
  },
  async upsertTaxMapping(accountId: number, taxLine: string) {
    const d = await requestJson<{ mapping: any }>('/api/tax/mappings', {
      method: 'PUT',
      body: JSON.stringify({ accountId, taxLine }),
    });
    return d.mapping;
  },
  async listExchangeRates() {
    const d = await requestJson<{ rates: any[] }>('/api/fx/rates');
    return d.rates;
  },
  async upsertExchangeRate(payload: { fromCurrency: string; toCurrency?: string; rateDate?: string; rate: number | string; source?: string }) {
    const d = await requestJson<{ rate: any }>('/api/fx/rates', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return d.rate;
  },
  async listSavedReports() {
    const d = await requestJson<{ savedReports: any[] }>('/api/saved-reports');
    return d.savedReports;
  },
  async createSavedReport(payload: { name: string; reportType: string; parameters?: Record<string, any> }) {
    const d = await requestJson<{ savedReport: any }>('/api/saved-reports', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.savedReport;
  },
  async deleteSavedReport(id: number) {
    return requestJson<any>(`/api/saved-reports/${id}`, { method: 'DELETE' });
  },
  async runSavedReport(id: number) {
    return requestJson<any>(`/api/saved-reports/${id}/run`, { method: 'POST', body: '{}' });
  },
  async getAnalyticsOverview() {
    const d = await requestJson<{ overview: any }>('/api/analytics/overview');
    return d.overview;
  },
  async listInventory() {
    const d = await requestJson<{ items: any[] }>('/api/inventory');
    return d.items;
  },

  /** Create an inventory catalog item on the server. */
  async createInventoryItem(payload: {
    name: string;
    sku: string;
    itemType: string;
    description?: string | null;
    unitCost?: string | number;
    salesPrice?: string | number;
    onHand?: string | number;
    reorderPoint?: string | number;
    purchaseUnit?: string;
    usageUnit?: string;
    conversionFactor?: string | number;
    assetAccountId?: number;
    cogsAccountId?: number;
    incomeAccountId?: number;
  }) {
    const d = await requestJson<{ item: any }>('/api/inventory', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.item;
  },

  /** Update inventory item master data (server-owned). */
  async updateInventoryItem(
    id: number,
    payload: {
      sku?: string;
      name?: string;
      description?: string | null;
      reorderPoint?: string | number | null;
      unitCost?: string | number | null;
      salesPrice?: string | number | null;
      purchaseUnit?: string | null;
      usageUnit?: string | null;
      conversionFactor?: string | number | null;
    }
  ) {
    const d = await requestJson<{ item: any }>(`/api/inventory/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.item;
  },

  /**
   * Adjust on-hand stock. The server updates the quantity, writes the
   * perpetual-inventory movement and posts the matching ledger entry.
   */
  async adjustInventoryStock(
    id: number,
    payload: {
      adjustmentQty: string | number;
      reason?: string | null;
      adjustmentDate?: string | null;
      counterAccountId?: number | null;
      unitCost?: string | number | null;
    }
  ) {
    const d = await requestJson<{ adjustment: any }>(`/api/inventory/${id}/adjust`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.adjustment;
  },

  /** Full item detail: master record, variants, BOM components, valuation. */
  async getInventoryItem(id: number) {
    return requestJson<{
      item: any;
      variants: any[];
      bom: any[];
      lastMovement: any | null;
    }>(`/api/inventory/${id}`);
  },

  /** Raw movement audit stream (newest first, paginated). */
  async getInventoryMovements(
    id: number,
    params?: { limit?: number; offset?: number; movementType?: string }
  ) {
    const qs = new URLSearchParams();
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));
    if (params?.movementType) qs.set('movementType', params.movementType);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return requestJson<{ movements: any[]; total: number; limit: number; offset: number }>(
      `/api/inventory/${id}/movements${suffix}`
    );
  },

  /** Running-balance stock ledger using the stored balances. */
  async getInventoryLedger(id: number) {
    return requestJson<{
      item: any;
      ledger: any[];
      summary: {
        movementCount: number;
        totalReceipts: string;
        totalIssues: string;
        netMovement: string;
      };
    }>(`/api/inventory/${id}/ledger`);
  },

  /** BOM components with rolled-up unit cost at moving average. */
  async getInventoryBom(id: number) {
    return requestJson<{ components: any[]; computedUnitCost: string }>(
      `/api/inventory/${id}/bom`
    );
  },

  /** Actual material consumption for this item across printing jobs. */
  async getInventoryConsumption(id: number) {
    return requestJson<{ jobs: any[]; summary: any }>(`/api/inventory/${id}/consumption`);
  },

  /** Journal transactions and damage register tied to this item. */
  async getInventoryTransactions(id: number) {
    return requestJson<{ transactions: any[]; damages: any[] }>(
      `/api/inventory/${id}/transactions`
    );
  },

  /** Supplier/purchase history for this item, aggregated per vendor. */
  async getInventorySupplierHistory(id: number) {
    return requestJson<{ purchases: any[]; vendors: any[] }>(
      `/api/inventory/${id}/supplier-history`
    );
  },

  /** Company-wide reorder levels and shortfall summary. */
  async getReorderLevels() {
    return requestJson<{ items: any[]; summary: any }>('/api/inventory/reorder-levels');
  },

  /**
   * Write off damaged stock. Decrements on_hand and posts the expense.
   * Returns the damage register row with the resulting on_hand.
   */
  async recordStockDamage(
    id: number,
    payload: {
      quantity: string | number;
      reason?: string | null;
      reasonCode?: string | null;
      damageDate?: string | null;
      counterAccountId?: number | null;
      unitCost?: string | number | null;
      idempotencyKey?: string;
    }
  ) {
    const d = await requestJson<{ damage: any }>(`/api/inventory/${id}/damage`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.damage;
  },

  /** Deactivate an item (requires zero on-hand stock and no historical references). */
  async deactivateInventoryItem(id: number) {
    const d = await requestJson<{ item: any }>(`/api/inventory/${id}/deactivate`, {
      method: 'POST',
    });
    emitAccountingUpdated();
    return d.item;
  },

  /** Move stock between storage locations. Stock-neutral, posts no journal. */
  async transferStock(payload: {
    fromLocation?: string | null;
    toLocation?: string | null;
    transferDate?: string | null;
    notes?: string | null;
    lines: Array<{ itemId: number; quantity: string | number; variantId?: number | null }>;
  }) {
    const d = await requestJson<{ transfer: any }>('/api/inventory/transfer', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.transfer;
  },

  /** Create a draft physical stock count. */
  async createStockCount(payload: {
    countDate?: string | null;
    notes?: string | null;
    lines: Array<{
      itemId: number;
      countedQty: string | number;
      variantId?: number | null;
      unitCost?: string | number | null;
    }>;
  }) {
    const d = await requestJson<{ stockCount: any }>('/api/stock-counts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d.stockCount;
  },

  /** Post a draft stock count, applying variances to stock and the ledger. */
  async postStockCount(
    id: number,
    payload?: {
      counterAccountId?: number | null;
      notes?: string | null;
      idempotencyKey?: string;
    }
  ) {
    const d = await requestJson<{ stockCount: any }>(`/api/stock-counts/${id}/post`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    });
    emitAccountingUpdated();
    return d.stockCount;
  },

  /** Create an employee in the server-owned HR directory. */
  async createEmployee(payload: {
    firstName: string;
    lastName: string;
    jobTitle?: string | null;
    department?: string | null;
    email?: string | null;
    phone?: string | null;
    hireDate?: string;
    payType: 'hourly' | 'salary';
    payRate: string | number;
    payFrequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
    filingStatus?: 'single' | 'married' | 'head_of_household';
    w4Allowances?: number;
  }) {
    const d = await requestJson<{ employee: any }>('/api/employees', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.employee;
  },

  // Purchase Requisitions & Goods Receipts (procurement workflow)
  async listRequisitions() {
    const d = await requestJson<{ requisitions: any[] }>('/api/requisitions');
    return d.requisitions;
  },
  async createRequisition(payload: {
    reqDate?: string;
    neededByDate?: string | null;
    demandSource?: 'manual' | 'reorder_level' | 'job_shortfall';
    sourceJobId?: number | null;
    submitImmediately?: boolean;
    notes?: string | null;
    lines: Array<{
      itemId?: number | null;
      preferredVendorId?: number | null;
      description: string;
      quantity: string | number;
      estimatedUnitCost: string | number;
    }>;
  }) {
    const d = await requestJson<{ requisition: any }>('/api/requisitions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return d.requisition;
  },
  async generateDemandRequisitions(payload: { jobId?: number | null; preferredVendorId?: number | null } = {}) {
    return requestJson<{ generated: boolean; requisition?: any; lines?: any[] }>('/api/requisitions/demand', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  async approveRequisition(id: number, note?: string) {
    const d = await requestJson<{ requisition: any }>(`/api/requisitions/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
    return d.requisition;
  },
  async convertRequisitionToPo(
    id: number,
    payload: {
      vendorId: number;
      poDate?: string;
      expectedDate?: string | null;
      notes?: string | null;
    }
  ) {
    const d = await requestJson<{ purchaseOrder: any }>(`/api/requisitions/${id}/convert-po`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d;
  },
  async createBillFromPurchaseOrder(poId: number, payload: any = {}) {
    const d = await requestJson<any>(`/api/purchase-orders/${poId}/bill`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d;
  },
  async listGoodsReceipts(purchaseOrderId?: number) {
    const d = await requestJson<{ goodsReceipts: any[] }>(
      `/api/goods-receipts${buildQuery({ purchaseOrderId })}`
    );
    return d.goodsReceipts;
  },
  async recordGoodsReceipt(payload: {
    purchaseOrderId: number;
    receiptDate?: string;
    notes?: string | null;
    lines?: Array<{ poLineId: number; receiveQty?: string | number; unitCost?: string | number }>;
  }) {
    const d = await requestJson<any>('/api/goods-receipts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return d;
  },

  // Estimate approval workflow
  async approveEstimate(id: number) {
    const d = await requestJson<{ estimate: any }>(`/api/estimates/${id}/approve`, {
      method: 'POST',
      body: '{}',
    });
    emitAccountingUpdated();
    return d.estimate;
  },
  async rejectEstimate(id: number, reason?: string) {
    const d = await requestJson<{ estimate: any }>(`/api/estimates/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return d.estimate;
  },
};
