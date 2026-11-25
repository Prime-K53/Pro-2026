/**
 * Typed client for the V2 gap-closure endpoints (WS-2 … WS-9).
 *
 * Everything funnels through `requestJson` from `http.ts` so cookie session,
 * CSRF headers, error shaping and session-expiry handling stay in one place.
 */
import { requestJson, requestBlob, downloadBlob, buildQuery } from './http';

// ─── WS-8 Business intelligence ────────────────────────────────────────────

export interface SalesTrend {
  period: string;
  invoiceCount: number;
  revenue: string;
  cost: string;
  margin: string;
}

export interface GroupedSalesTrend {
  groupKey: string;
  groupLabel: string;
  invoiceCount: number;
  revenue: string;
  cost: string;
  margin: string;
}

export interface KpiScorecard {
  totalInvoices: number;
  totalRevenue: string;
  totalCost: string;
  grossProfit: string;
  grossMargin: string;
  revenueTarget: string | null;
  revenueVariance: string | null;
  totalCustomers: number;
  totalInventoryItems: number;
  outstandingReceivables: string;
}

export interface KpiTarget {
  id: number;
  kpiKey: string;
  targetValue: string;
  period: string;
  effectiveFrom: string;
}

export interface ArAgeingBucket {
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
  count: number;
  amount: string;
}

export interface SalesSplit {
  settled: string;
  outstanding: string;
  total: string;
}

export interface StockValuationItem {
  itemId: number;
  sku: string;
  name: string;
  itemType: string;
  onHand: string;
  unitCost: string;
  totalValue: string;
}

export interface PrintingJobEfficiency {
  jobId: number;
  jobNumber: string;
  status: string;
  totalCost: string;
  totalRevenue: string;
  margin: string;
  marginPct: string;
}

export interface PayrollCostSummary {
  totalGross: string;
  totalPAYE: string;
  totalPensionEmployee: string;
  totalPensionEmployer: string;
  totalOtherDeductions: string;
  totalNet: string;
  headcount: number;
}

export interface RevenueDrilldownRow {
  id: number;
  number: string;
  customer: string;
  date: string;
  total: string;
  status: string;
}

export interface BiReconciliation {
  balanced: boolean;
  invoiceRevenue: string;
  glRevenue: string;
  invoiceReceivables: string;
  glReceivables: string;
  checks: Array<{
    name: string;
    ok: boolean;
    gated: boolean;
    invoice: string;
    gl: string;
    difference: string;
  }>;
}

export const biApi = {
  salesTrends: (period = 'monthly') =>
    requestJson<{ trends: SalesTrend[] }>(`/api/bi/sales-trends${buildQuery({ period })}`),
  salesTrendsGrouped: (groupBy: 'product' | 'category' | 'customer', period = 'monthly') =>
    requestJson<{ trends: GroupedSalesTrend[] }>(
      `/api/bi/sales-trends${buildQuery({ period, groupBy })}`
    ),
  kpiScorecard: () => requestJson<{ kpis: KpiScorecard }>('/api/bi/kpi-scorecard'),
  kpiTargets: () => requestJson<{ targets: KpiTarget[] }>('/api/bi/kpi-targets'),
  upsertKpiTarget: (payload: { kpiKey: string; targetValue: number; period?: string }) =>
    requestJson<{ target: KpiTarget }>('/api/bi/kpi-targets', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  arAgeing: () => requestJson<{ buckets: ArAgeingBucket[] }>('/api/bi/ar-ageing'),
  salesSplit: () => requestJson<SalesSplit>('/api/bi/sales-split'),
  stockValuation: () => requestJson<{ items: StockValuationItem[] }>('/api/bi/stock-valuation'),
  jobEfficiency: () =>
    requestJson<{ jobs: PrintingJobEfficiency[] }>('/api/bi/printing-job-efficiency'),
  payrollCost: () => requestJson<PayrollCostSummary>('/api/bi/payroll-cost-analysis'),
  drilldownRevenue: (limit = 50) =>
    requestJson<{ rows: RevenueDrilldownRow[] }>(
      `/api/bi/drilldown/revenue${buildQuery({ limit })}`
    ),
  reconciliation: () => requestJson<BiReconciliation>('/api/bi/reconciliation'),
  inventoryTurnover: () =>
    requestJson<{ items: Array<{ name: string; sku: string; onHand: string; totalMovement: string }> }>(
      '/api/bi/inventory-turnover'
    ),
  cashierPerformance: () =>
    requestJson<{
      cashiers: Array<{ cashier: string; orderCount: number; totalSales: string }>;
    }>('/api/bi/pos-cashier-performance'),
};

// ─── WS-9 System administration ────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  status: 'ok' | 'error' | 'not_configured';
  detail: string;
}

export interface SystemHealth {
  status: 'ok' | 'degraded';
  checks: HealthCheck[];
  uptimeSeconds: number;
  timestamp: string;
}

export interface Integration {
  id: number;
  companyId: number;
  name: string;
  type: string;
  status: string;
  createdAt: string;
}

export interface Subscription {
  id: number;
  companyId: number;
  planId: number;
  planName: string;
  planPrice: string;
  status: string;
  startedAt: string | null;
  endsAt: string | null;
  createdAt: string;
}

export interface ReleaseVersion {
  id: number;
  version: string;
  notes: string | null;
  releasedAt: string;
  isCurrent: boolean;
}

export interface AuditSummary {
  windowHours: number;
  totalActions: number;
  criticalActions: number;
  byAction: Array<{ action: string; count: number }>;
}

export interface AdminMetrics {
  invoiceCount: number;
  customerCount: number;
  inventoryItemCount: number;
}

export const adminApi = {
  health: () => requestJson<SystemHealth>('/api/admin/health'),
  backupStatus: () => requestJson<any>('/api/admin/backup/status'),
  restoreReadiness: () => requestJson<any>('/api/admin/restore/readiness'),
  metrics: () => requestJson<{ metrics: AdminMetrics }>('/api/admin/metrics'),
  integrations: () => requestJson<{ integrations: Integration[] }>('/api/admin/integrations'),
  createIntegration: (payload: { name: string; type: string; config?: unknown }) =>
    requestJson<{ integration: Integration }>('/api/admin/integrations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  rotateIntegrationSecret: (id: number, secret: string) =>
    requestJson<{ integration: Integration }>(`/api/admin/integrations/${id}/rotate-secret`, {
      method: 'POST',
      body: JSON.stringify({ secret }),
    }),
  subscriptions: () =>
    requestJson<{ subscriptions: Subscription[] }>('/api/admin/subscriptions'),
  releases: () => requestJson<{ releases: ReleaseVersion[] }>('/api/admin/releases'),
  auditSummary: () => requestJson<AuditSummary>('/api/admin/audit/summary'),
};

// ─── WS-7 Communications ───────────────────────────────────────────────────

export interface Consent {
  id: number;
  customerId: number;
  channel: 'email' | 'sms' | 'whatsapp';
  consentType: 'marketing' | 'transactional' | 'both';
  status: 'granted' | 'withdrawn';
  source: string | null;
  createdAt: string;
}

export interface Suppression {
  id: number;
  channel: string;
  recipient: string;
  reason: string | null;
  createdAt: string;
}

export interface CommunicationMessage {
  id: number;
  channel: string;
  recipient: string;
  body: string;
  status: string;
  provider: string | null;
  providerMessageId: string | null;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface CommunicationTemplate {
  id: number;
  name: string;
  channel: string;
  body: string;
  createdAt: string;
}

export interface CommunicationsCostSummary {
  totalMessages: number;
  totalCost: string;
  byChannel: Array<{ channel: string; count: number; cost: string }>;
  byStatus: Array<{ status: string; count: number }>;
  byProvider: Array<{ provider: string; count: number }>;
}

export const commsApi = {
  consents: () => requestJson<{ consents: Consent[] }>('/api/communications/consents'),
  createConsent: (payload: {
    customerId: number;
    channel: string;
    consentType: string;
    status?: string;
    source?: string;
  }) =>
    requestJson<{ consent: Consent }>('/api/communications/consents', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  suppressions: () =>
    requestJson<{ suppressions: Suppression[] }>('/api/communications/suppressions'),
  createSuppression: (payload: { channel: string; recipient: string; reason?: string }) =>
    requestJson<{ suppression: Suppression }>('/api/communications/suppressions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  send: (payload: { channel: string; recipient: string; body: string }) =>
    requestJson<{ message: CommunicationMessage }>('/api/communications/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  messages: (limit = 100) =>
    requestJson<{ messages: CommunicationMessage[] }>(
      `/api/communications/messages${buildQuery({ limit })}`
    ),
  templates: () =>
    requestJson<{ templates: CommunicationTemplate[] }>('/api/communications/templates'),
  createTemplate: (payload: { name: string; channel: string; body: string }) =>
    requestJson<{ template: CommunicationTemplate }>('/api/communications/templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  costs: () => requestJson<CommunicationsCostSummary>('/api/communications/costs'),
};

// ─── WS-5 Delivery & fleet ─────────────────────────────────────────────────

export interface Vehicle {
  id: number;
  registration: string;
  make: string | null;
  model: string | null;
  capacityKg: string | null;
  status: string;
}

export interface Driver {
  id: number;
  name: string;
  phone: string | null;
  licenseNumber: string;
  licenseExpiry: string | null;
  status: string;
}

export interface DeliverySchedule {
  id: number;
  deliveryNoteId: number;
  scheduledDate: string;
  timeWindow: string | null;
  assignedDriverId: number | null;
  assignedVehicleId: number | null;
  status: string;
}

export const deliveryApi = {
  vehicles: () => requestJson<{ vehicles: Vehicle[] }>('/api/delivery/vehicles'),
  createVehicle: (payload: {
    registration: string;
    make?: string;
    model?: string;
    capacityKg?: number;
  }) =>
    requestJson<{ vehicle: Vehicle }>('/api/delivery/vehicles', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  drivers: () => requestJson<{ drivers: Driver[] }>('/api/delivery/drivers'),
  createDriver: (payload: {
    name: string;
    phone?: string;
    licenseNumber: string;
    licenseExpiry?: string;
  }) =>
    requestJson<{ driver: Driver }>('/api/delivery/drivers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  schedules: () => requestJson<{ schedules: DeliverySchedule[] }>('/api/delivery/schedules'),
  createSchedule: (payload: {
    deliveryNoteId: number;
    scheduledDate: string;
    timeWindow?: string;
    assignedDriverId?: number;
    assignedVehicleId?: number;
  }) =>
    requestJson<{ schedule: DeliverySchedule }>('/api/delivery/schedules', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  notes: () => requestJson<{ deliveryNotes: any[] }>('/api/delivery/notes'),
  getNote: (id: number) => requestJson<{ deliveryNote: any }>(`/api/delivery/notes/${id}`),
  createNote: (payload: {
    customerId: number;
    dispatchDate: string;
    driverName?: string;
    vehicleReg?: string;
    notes?: string;
    deliveryCost?: number;
    lines?: Array<{ description: string; quantityDispatched: number; printingJobId?: number; examPaperId?: number }>;
  }) =>
    requestJson<{ deliveryNote: any }>('/api/delivery/notes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  dispatchNote: (id: number, payload?: { driverName?: string; vehicleReg?: string }) =>
    requestJson<{ deliveryNote: any }>(`/api/delivery/notes/${id}/dispatch`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    }),
  markDelivered: (id: number, payload?: { recipientName?: string; notes?: string }) =>
    requestJson<{ deliveryNote: any }>(`/api/delivery/notes/${id}/deliver`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    }),
  cancelNote: (id: number) =>
    requestJson<{ deliveryNote: any }>(`/api/delivery/notes/${id}/cancel`, {
      method: 'POST',
    }),
};

export const leaveApi = {
  types: () => requestJson<{ leaveTypes: any[] }>('/api/leave/types'),
  createType: (payload: { code: string; name: string; accrualDays?: number; maxCarryForward?: number; isPaid?: boolean }) =>
    requestJson<{ leaveType: any }>('/api/leave/types', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  requests: (params?: { employeeId?: number; status?: string }) => {
    const q = new URLSearchParams();
    if (params?.employeeId) q.set('employeeId', String(params.employeeId));
    if (params?.status) q.set('status', params.status);
    const qs = q.toString();
    return requestJson<{ requests: any[] }>(`/api/leave/requests${qs ? `?${qs}` : ''}`);
  },
  createRequest: (payload: {
    employeeId: number;
    leaveTypeId: number;
    startDate: string;
    endDate: string;
    daysRequested: number;
    reason?: string;
  }) =>
    requestJson<{ request: any }>('/api/leave/requests', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  approveRequest: (id: number) =>
    requestJson<{ request: any }>(`/api/leave/requests/${id}/approve`, {
      method: 'POST',
    }),
  rejectRequest: (id: number, reason: string) =>
    requestJson<{ request: any }>(`/api/leave/requests/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ rejectionReason: reason }),
    }),
  cancelRequest: (id: number) =>
    requestJson<{ request: any }>(`/api/leave/requests/${id}/cancel`, {
      method: 'POST',
    }),
  balances: (employeeId: number, year?: number) =>
    requestJson<{ balances: any[] }>(`/api/leave/balances/${employeeId}${year ? `?year=${year}` : ''}`),
};

// ─── WS-4 Payroll statutory configuration ──────────────────────────────────

export interface PayeBand {
  id: number;
  lowerBound: number;
  upperBound: number | null;
  /** Fraction between 0 and 1. */
  rate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export type StatutoryRateType = 'pension_employee' | 'pension_employer' | 'other_statutory';

export interface StatutoryRate {
  id: number;
  rateType: StatutoryRateType;
  /** Fraction between 0 and 1. */
  rate: number;
  basis: 'gross' | 'basic';
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface StatutoryConfig {
  bands: PayeBand[];
  rates: StatutoryRate[];
}

export interface SalaryStructure {
  id: number;
  companyId: number;
  employeeId: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  payType: string;
  payRate: string;
  payFrequency: string;
  currency: string | null;
  notes: string | null;
}

export interface EmployeeLoan {
  id: number;
  companyId: number;
  employeeId: number;
  principal: string;
  balance: string;
  installment: string;
  status: string;
}

export interface EmployeeDeduction {
  id: number;
  companyId: number;
  employeeId: number;
  deductionType: string;
  amount: string;
  calculationMethod: 'fixed' | 'percentage';
  status: string;
}

export interface Payslip {
  runId: number;
  runNumber: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  payDate: string;
  employeeId: number;
  employeeName: string;
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

export const payrollConfigApi = {
  statutoryConfig: () => requestJson<StatutoryConfig>('/api/payroll/statutory-config'),
  createPayeBand: (payload: {
    lowerBound: number;
    upperBound?: number | null;
    /** Fraction between 0 and 1. */
    rate: number;
    effectiveFrom?: string;
  }) =>
    requestJson<{ band: PayeBand }>('/api/payroll/paye-bands', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deletePayeBand: (id: number) =>
    requestJson<{ deleted: boolean }>(`/api/payroll/paye-bands/${id}`, { method: 'DELETE' }),
  createStatutoryRate: (payload: {
    rateType: StatutoryRateType;
    rate: number;
    basis?: 'gross' | 'basic';
    effectiveFrom?: string;
  }) =>
    requestJson<{ rate: StatutoryRate }>('/api/payroll/statutory-rates', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteStatutoryRate: (id: number) =>
    requestJson<{ deleted: boolean }>(`/api/payroll/statutory-rates/${id}`, {
      method: 'DELETE',
    }),

  salaryStructures: (employeeId?: number) =>
    requestJson<{ structures: SalaryStructure[] }>(
      `/api/payroll/salary-structures${buildQuery({ employeeId })}`
    ),
  createSalaryStructure: (payload: {
    employeeId: number;
    effectiveFrom?: string;
    effectiveTo?: string | null;
    payType: 'salary' | 'hourly';
    payRate: number;
    payFrequency?: string;
    currency?: string;
    notes?: string;
  }) =>
    requestJson<{ structure: SalaryStructure }>('/api/payroll/salary-structures', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteSalaryStructure: (id: number) =>
    requestJson<{ deleted: boolean }>(`/api/payroll/salary-structures/${id}`, {
      method: 'DELETE',
    }),

  loans: (employeeId?: number) =>
    requestJson<{ loans: EmployeeLoan[] }>(`/api/payroll/loans${buildQuery({ employeeId })}`),
  createLoan: (payload: {
    employeeId: number;
    principal: number;
    installment: number;
  }) =>
    requestJson<{ loan: EmployeeLoan }>('/api/payroll/loans', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deductions: (employeeId?: number) =>
    requestJson<{ deductions: EmployeeDeduction[] }>(
      `/api/payroll/deductions${buildQuery({ employeeId })}`
    ),
  createDeduction: (payload: {
    employeeId: number;
    deductionType: string;
    amount: number;
    calculationMethod?: 'fixed' | 'percentage';
  }) =>
    requestJson<{ deduction: EmployeeDeduction }>('/api/payroll/deductions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  payslips: (runId: number) =>
    requestJson<{ payslips: Payslip[] }>(`/api/payroll/runs/${runId}/payslips`),
  payslipPrintUrl: (runId: number, employeeId: number) =>
    `/api/payroll/runs/${runId}/payslips/${employeeId}/print`,
  reconciliation: (runId: number) =>
    requestJson<any>(`/api/payroll/runs/${runId}/reconciliation`),

  /** Download the bank payment file (CSV or TXT) for a pay run. */
  async downloadBankFile(runId: number, format: 'csv' | 'txt' = 'csv'): Promise<void> {
    const blob = await requestBlob(
      `/api/payroll/runs/${runId}/bank-file${buildQuery({ format })}`
    );
    downloadBlob(blob, `payroll-bank-file-${runId}.${format}`);
  },
};

// ─── WS-6 Documents & QR ───────────────────────────────────────────────────

export interface QrGenerationResult {
  token: string;
  hash: string;
  qrDataUrl: string;
}

export const documentQrApi = {
  generate: (kind: string, id: number, payload: { version?: number; contentHash?: string } = {}) =>
    requestJson<QrGenerationResult>(`/api/documents/${kind}/${id}/qr`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  revoke: (kind: string, id: number) =>
    requestJson<{ revoked: boolean }>(`/api/documents/${kind}/${id}/qr/revoke`, {
      method: 'POST',
    }),
  verify: (token: string) => requestJson<any>(`/api/qr-verify/${encodeURIComponent(token)}`),
  verifyPageUrl: (token: string) => `/api/qr-verify/${encodeURIComponent(token)}/page`,
  printUrl: (kind: string, id: number, withQr = false) =>
    `/api/documents/${kind}/${id}/print${withQr ? '?qr=1' : ''}`,
};

// ─── WS-1 POS refunds ──────────────────────────────────────────────────────

export interface PosRefund {
  id: number;
  companyId: number;
  posOrderId: number;
  shiftId: number | null;
  refundedBy: number;
  amount: string;
  reason: string | null;
  status: string;
  createdAt: string;
}

export const posRefundApi = {
  list: (filters: { posOrderId?: number; shiftId?: number } = {}) =>
    requestJson<{ refunds: PosRefund[] }>(`/api/pos/refunds${buildQuery(filters)}`),
  create: (orderId: number, payload: { amount: number; reason?: string; shiftId?: number }) =>
    requestJson<{ refund: PosRefund }>(`/api/pos/orders/${orderId}/refund`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

// ─── WS-3 Customers: branches ──────────────────────────────────────────────

export interface CustomerBranch {
  id: number;
  companyId: number;
  customerId: number;
  branchName: string;
  address: string | null;
  phone: string | null;
  isBillingDefault: boolean;
  isShippingDefault: boolean;
  deliveryInstructions: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export const customerBranchApi = {
  list: (customerId: number, includeInactive = false) =>
    requestJson<{ branches: CustomerBranch[] }>(
      `/api/customers/${customerId}/branches${buildQuery({ includeInactive })}`
    ),
  create: (customerId: number, payload: Partial<CustomerBranch>) =>
    requestJson<{ branch: CustomerBranch }>(`/api/customers/${customerId}/branches`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  update: (customerId: number, branchId: number, payload: Partial<CustomerBranch>) =>
    requestJson<{ branch: CustomerBranch }>(
      `/api/customers/${customerId}/branches/${branchId}`,
      { method: 'PATCH', body: JSON.stringify(payload) }
    ),
  /** Soft-deactivate: keeps the row for historical documents. */
  remove: (customerId: number, branchId: number) =>
    requestJson<{ deactivated: boolean; branch: CustomerBranch }>(
      `/api/customers/${customerId}/branches/${branchId}`,
      { method: 'DELETE' }
    ),
  reactivate: (customerId: number, branchId: number) =>
    requestJson<{ branch: CustomerBranch }>(
      `/api/customers/${customerId}/branches/${branchId}/reactivate`,
      { method: 'POST' }
    ),
};

// ─── WS-2 AI assistant ─────────────────────────────────────────────────────

export interface AiConfig {
  enabled: boolean;
  provider: string | null;
  modelName: string | null;
  hasApiKey: boolean;
}

export interface AiConversation {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiCitation {
  kind: string;
  id: number;
  label: string;
}

export interface AiMessage {
  id: number;
  companyId: number;
  conversationId: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sourceCitations: { context?: string; citations?: AiCitation[] } | null;
  tokenCount: number | null;
  createdAt: string;
}

export interface AiAnomaly {
  id: number;
  companyId: number;
  anomalyType: string;
  severity: string;
  description: string;
  evidence: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AiProposedAction {
  id: number;
  companyId: number;
  conversationId: number | null;
  actionType: string;
  description: string;
  parameters: unknown;
  status: 'pending' | 'approved' | 'rejected' | 'executed';
  approvalId: number | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiBudget {
  companyId: number;
  monthlyTokenLimit: number;
  monthlyCostLimit: number;
  costPer1kTokens: number;
}

export interface AiChatResult {
  conversationId: number;
  message: AiMessage;
  response: AiMessage;
}

export const aiApi = {
  config: () => requestJson<{ config: AiConfig | null }>('/api/ai/config'),
  saveConfig: (payload: {
    provider: string;
    modelName: string;
    apiKey?: string;
    enabled?: boolean;
    fallbackProvider?: string;
    fallbackModel?: string;
    fallbackApiKey?: string;
  }) =>
    requestJson<{ config: AiConfig }>('/api/ai/config', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  models: (provider: string, apiKey: string) =>
    requestJson<{ models: Array<{ id: string; name?: string }> }>('/api/ai/models', {
      method: 'POST',
      body: JSON.stringify({ provider, apiKey }),
    }),

  conversations: () =>
    requestJson<{ conversations: AiConversation[] }>('/api/ai/conversations'),
  createConversation: (title: string) =>
    requestJson<{ conversation: AiConversation }>('/api/ai/conversations', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  deleteConversation: (id: number) =>
    requestJson<{ deleted: boolean }>(`/api/ai/conversations/${id}`, { method: 'DELETE' }),
  messages: (conversationId: number) =>
    requestJson<{ messages: AiMessage[] }>(`/api/ai/conversations/${conversationId}/messages`),
  chat: (payload: { message: string; conversationId?: number }) =>
    requestJson<AiChatResult>('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  anomalies: () => requestJson<{ alerts: AiAnomaly[] }>('/api/ai/anomalies'),
  detectAnomalies: () =>
    requestJson<{ alerts: AiAnomaly[] }>('/api/ai/anomalies/detect', { method: 'POST' }),

  actions: (status?: string) =>
    requestJson<{ actions: AiProposedAction[] }>(
      `/api/ai/actions${buildQuery({ status })}`
    ),
  proposeAction: (payload: {
    actionType: string;
    description: string;
    parameters?: unknown;
    conversationId?: number;
  }) =>
    requestJson<{ action: AiProposedAction }>('/api/ai/actions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  setActionStatus: (id: number, status: 'approved' | 'rejected') =>
    requestJson<{ action: AiProposedAction }>(`/api/ai/actions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  executeAction: (id: number) =>
    requestJson<{ action: AiProposedAction }>(`/api/ai/actions/${id}/execute`, {
      method: 'POST',
    }),

  budget: () => requestJson<{ budget: AiBudget }>('/api/ai/budget'),
  saveBudget: (payload: {
    monthlyTokenLimit?: number;
    monthlyCostLimit?: number;
    costPer1kTokens?: number;
  }) =>
    requestJson<{ budget: AiBudget }>('/api/ai/budget', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  audit: (limit = 50) =>
    requestJson<{
      logs: Array<{
        id: number;
        userId: number;
        action: string;
        query: string;
        responseSummary: string | null;
        createdAt: string;
      }>;
    }>(`/api/ai/audit${buildQuery({ limit })}`),

  purge: (olderThanDays = 90) =>
    requestJson<{ purged: number }>('/api/ai/retention/purge', {
      method: 'POST',
      body: JSON.stringify({ olderThanDays }),
    }),
};