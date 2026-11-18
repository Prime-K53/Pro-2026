import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transaction } from '@electric-sql/pglite';

export type SlowBooksId = string | number;

export interface SlowBooksCompanyRecord {
  id: SlowBooksId;
  slug?: string;
  name: string;
  legal_name?: string;
  tax_id_ein?: string | null;
  address?: string | null;
  city_state_zip?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  base_currency?: string;
  currency_symbol?: string;
  fiscal_year_start_month?: number;
  accounting_method?: 'accrual' | 'cash';
  sales_tax_rate?: string | number;
  rounding_mode?: 'HALF_EVEN' | 'HALF_UP';
  decimal_places?: number;
  is_active?: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
  created_at?: string;
}

export interface SlowBooksUserRecord {
  id: SlowBooksId;
  username: string;
  email: string;
  display_name?: string;
  password_hash?: string;
  role?: string;
  is_active?: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
  session_version?: number;
  expires_on?: string | null;
  last_login_at?: string | null;
  created_at?: string;
}

export interface SlowBooksMembershipRecord {
  id?: SlowBooksId;
  company_id: SlowBooksId;
  user_id: SlowBooksId;
  role: string;
  is_default?: boolean;
  is_active?: boolean;
  expires_on?: string | null;
  revoked_at?: string | null;
}

export interface SlowBooksPaymentTermRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  name: string;
  kind?: 'standard' | 'date_driven';
  net_days?: number;
  due_day?: number | null;
  cutoff_days?: number | null;
  discount_percent?: string | number;
  discount_days?: number;
  discount_day?: number | null;
  is_active?: boolean;
}

export interface SlowBooksClassRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  name: string;
  parent_id?: SlowBooksId | null;
  is_active?: boolean;
}

export interface SlowBooksAccountRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  code?: string | null;
  name: string;
  account_type: string;
  detail_type?: string | null;
  bank_kind?: 'bank' | 'credit_card' | null;
  description?: string | null;
  parent_id?: SlowBooksId | null;
  normal_balance?: 'debit' | 'credit';
  is_system?: boolean;
  is_control?: boolean;
  is_active?: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
  expected_balance?: string | number;
  created_at?: string;
}

export interface SlowBooksFiscalPeriodRecord {
  id?: SlowBooksId;
  company_id: SlowBooksId;
  period_name: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'soft_closed' | 'closed';
  closing_txn_id?: SlowBooksId | null;
  closed_at?: string | null;
  notes?: string | null;
}

export interface SlowBooksCustomerRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  parent_customer_id?: SlowBooksId | null;
  customer_type?: string;
  name: string;
  company_name?: string;
  email?: string | null;
  phone?: string | null;
  billing_address?: string | null;
  shipping_address?: string | null;
  payment_term_id?: SlowBooksId | null;
  terms_label?: string | null;
  credit_limit?: string | number | null;
  expected_balance?: string | number | null;
  is_tax_exempt?: boolean;
  notes?: string | null;
  is_active?: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
  created_at?: string;
}

export interface SlowBooksResellerPermitRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  customer_id: SlowBooksId;
  jurisdiction: string;
  permit_number: string;
  issued_at?: string | null;
  expires_at?: string | null;
  is_active?: boolean;
}

export interface SlowBooksVendorRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  name: string;
  company_name?: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  ein_or_ssn?: string | null;
  is_1099_eligible?: boolean;
  default_expense_account_id?: SlowBooksId | null;
  payment_term_id?: SlowBooksId | null;
  terms_label?: string | null;
  expected_balance?: string | number | null;
  is_active?: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
  created_at?: string;
}

export interface SlowBooksItemRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  sku: string;
  name: string;
  /** SlowBooks types ('product'|'service'|'material'|'labor'|'inventory'|'non_inventory') or PMS types */
  item_type: string;
  description?: string | null;
  unit_cost?: string | number;
  avg_cost?: string | number;
  sales_price?: string | number;
  on_hand?: string | number;
  reorder_point?: string | number;
  purchase_unit?: string;
  usage_unit?: string;
  conversion_factor?: string | number;
  is_taxable?: boolean;
  asset_account_id?: SlowBooksId | null;
  cogs_account_id?: SlowBooksId | null;
  income_account_id?: SlowBooksId | null;
  is_active?: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
  created_at?: string;
}

export interface SlowBooksInventoryMovementRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  item_id: SlowBooksId;
  movement_at?: string;
  movement_type: string;
  quantity_delta: string | number;
  unit_cost: string | number;
  balance_qty: string | number;
  balance_avg_cost: string | number;
  source_type: string;
  source_id: SlowBooksId;
}

export interface SlowBooksInventoryAdjustmentRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  adj_date: string;
  memo?: string | null;
  journal_txn_id?: SlowBooksId | null;
}

export interface SlowBooksEstimateLineRecord {
  id?: SlowBooksId;
  item_id?: SlowBooksId | null;
  description: string;
  quantity: string | number;
  unit_cost?: string | number;
  rate: string | number;
  amount: string | number;
  taxable?: boolean;
  class_id?: SlowBooksId | null;
}

export interface SlowBooksEstimateRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  estimate_number: string;
  customer_id: SlowBooksId;
  estimate_date: string;
  expiry_date?: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'invoiced' | 'expired';
  subtotal: string | number;
  tax_rate?: string | number;
  tax_amount: string | number;
  total: string | number;
  total_cost?: string | number;
  notes?: string | null;
  lines: SlowBooksEstimateLineRecord[];
}

export interface SlowBooksInvoiceLineRecord {
  id?: SlowBooksId;
  item_id?: SlowBooksId | null;
  description: string;
  quantity: string | number;
  rate: string | number;
  amount: string | number;
  unit_cost?: string | number;
  total_cost?: string | number;
  taxable?: boolean;
  class_id?: SlowBooksId | null;
}

export interface SlowBooksInvoiceRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  invoice_number: string;
  customer_id: SlowBooksId;
  invoice_date: string;
  due_date: string;
  payment_term_id?: SlowBooksId | null;
  terms_label?: string;
  po_number?: string | null;
  status: string;
  is_sales_receipt?: boolean;
  is_tax_exempt?: boolean;
  currency_code?: string;
  exchange_rate?: string | number;
  subtotal: string | number;
  tax_rate?: string | number;
  tax_amount: string | number;
  total: string | number;
  total_cost?: string | number;
  amount_paid: string | number;
  balance_due: string | number;
  journal_txn_id?: SlowBooksId | null;
  source_estimate_id?: SlowBooksId | null;
  class_id?: SlowBooksId | null;
  notes?: string | null;
  is_deleted?: boolean;
  lines: SlowBooksInvoiceLineRecord[];
}

export interface SlowBooksPaymentAllocationRecord {
  invoice_id: SlowBooksId;
  amount: string | number;
  from_remainder?: boolean;
}

export interface SlowBooksPaymentRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  payment_number: string;
  customer_id: SlowBooksId;
  payment_date: string;
  amount: string | number;
  payment_method?: string;
  reference_number?: string | null;
  deposit_to_account_id: SlowBooksId;
  is_voided?: boolean;
  is_deleted?: boolean;
  journal_txn_id?: SlowBooksId | null;
  memo?: string | null;
  allocations?: SlowBooksPaymentAllocationRecord[];
}

export interface SlowBooksCreditMemoRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  credit_number: string;
  customer_id: SlowBooksId;
  credit_date: string;
  status: string;
  subtotal: string | number;
  tax_rate?: string | number;
  tax_amount: string | number;
  total: string | number;
  remaining_credit: string | number;
  journal_txn_id?: SlowBooksId | null;
  memo?: string | null;
  lines: Array<{
    item_id?: SlowBooksId | null;
    description: string;
    quantity: string | number;
    rate: string | number;
    amount: string | number;
    class_id?: SlowBooksId | null;
  }>;
  applications?: Array<{
    invoice_id: SlowBooksId;
    amount: string | number;
    applied_date?: string;
  }>;
}

export interface SlowBooksPurchaseOrderRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  po_number: string;
  vendor_id: SlowBooksId;
  po_date: string;
  expected_date?: string | null;
  status: string;
  total: string | number;
  notes?: string | null;
  lines: Array<{
    id?: SlowBooksId;
    item_id?: SlowBooksId | null;
    account_id?: SlowBooksId | null;
    description: string;
    quantity: string | number;
    received_qty?: string | number;
    rate: string | number;
    amount: string | number;
    class_id?: SlowBooksId | null;
  }>;
}

export interface SlowBooksBillLineRecord {
  id?: SlowBooksId;
  account_id: SlowBooksId;
  item_id?: SlowBooksId | null;
  description: string;
  quantity: string | number;
  unit_cost?: string | number;
  amount: string | number;
  use_tax_rate?: string | number;
  class_id?: SlowBooksId | null;
}

export interface SlowBooksBillRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  bill_number: string;
  vendor_id: SlowBooksId;
  bill_date: string;
  due_date: string;
  payment_term_id?: SlowBooksId | null;
  terms_label?: string;
  status: string;
  total: string | number;
  amount_paid: string | number;
  balance_due: string | number;
  journal_txn_id?: SlowBooksId | null;
  purchase_order_id?: SlowBooksId | null;
  memo?: string | null;
  is_deleted?: boolean;
  lines: SlowBooksBillLineRecord[];
}

export interface SlowBooksBillPaymentRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  payment_number: string;
  vendor_id: SlowBooksId;
  payment_date: string;
  amount: string | number;
  bank_account_id: SlowBooksId;
  check_number?: string | null;
  is_voided?: boolean;
  journal_txn_id?: SlowBooksId | null;
  memo?: string | null;
  allocations?: Array<{
    bill_id: SlowBooksId;
    amount: string | number;
  }>;
}

export interface SlowBooksVendorCreditRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  credit_number: string;
  vendor_id: SlowBooksId;
  original_bill_id?: SlowBooksId | null;
  credit_date: string;
  status: string;
  total: string | number;
  remaining_credit: string | number;
  journal_txn_id?: SlowBooksId | null;
  memo?: string | null;
  lines: Array<{
    account_id: SlowBooksId;
    item_id?: SlowBooksId | null;
    description: string;
    quantity: string | number;
    rate: string | number;
    amount: string | number;
    class_id?: SlowBooksId | null;
  }>;
  applications?: Array<{
    bill_id: SlowBooksId;
    amount: string | number;
    applied_date?: string;
  }>;
}

export interface SlowBooksJournalLineRecord {
  id?: SlowBooksId;
  line_order?: number;
  account_id: SlowBooksId;
  basis?: 'both' | 'accrual' | 'cash';
  description?: string | null;
  debit: string | number;
  credit: string | number;
  class_id?: SlowBooksId | null;
  party_type?: 'customer' | 'vendor' | 'employee' | null;
  party_id?: SlowBooksId | null;
  is_reconciled?: boolean;
}

export interface SlowBooksJournalRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  entry_number: string;
  txn_date: string;
  reference?: string | null;
  description?: string | null;
  memo?: string | null;
  source_type: string;
  source_id?: SlowBooksId | null;
  source_ref?: string | null;
  source_kind?: string | null;
  source_difference?: string | number | null;
  class_id?: SlowBooksId | null;
  status: 'draft' | 'posted' | 'voided';
  is_posted?: boolean;
  is_adjusting?: boolean;
  reverses_transaction_id?: SlowBooksId | null;
  reversed_by_transaction_id?: SlowBooksId | null;
  is_deleted?: boolean;
  created_at?: string;
  lines: SlowBooksJournalLineRecord[];
}

export interface SlowBooksOpeningBalanceRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  txn_date: string;
  description?: string | null;
  lines: Array<{
    account_id: SlowBooksId;
    debit: string | number;
    credit: string | number;
    description?: string | null;
  }>;
}

export interface SlowBooksBankAccountRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  gl_account_id: SlowBooksId;
  institution_name: string;
  account_mask?: string | null;
  feed_provider?: string;
  next_check_number?: number;
  is_active?: boolean;
}

export interface SlowBooksReconciliationRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  account_id: SlowBooksId;
  bank_account_id?: SlowBooksId | null;
  statement_date: string;
  statement_ending_balance: string | number;
  beginning_balance: string | number;
  cleared_total: string | number;
  difference: string | number;
  status?: 'completed' | 'reversed';
  completed_at?: string | null;
}

export interface SlowBooksBankTransactionRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  account_id: SlowBooksId;
  bank_account_id?: SlowBooksId | null;
  txn_date: string;
  payee: string;
  txn_type: string;
  ref_number?: string | null;
  memo?: string | null;
  amount: string | number;
  running_balance?: string | number;
  is_cleared?: boolean;
  reconciliation_id?: SlowBooksId | null;
  journal_txn_id?: SlowBooksId | null;
  external_fitid?: string | null;
  category?: string | null;
  status?: 'pending_import' | 'posted' | 'voided';
  check_number?: string | null;
  print_later?: boolean;
}

export interface SlowBooksBankRuleRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  name: string;
  match_field: 'payee' | 'memo' | 'amount';
  match_pattern: string;
  target_account_id: SlowBooksId;
  default_vendor_id?: SlowBooksId | null;
  default_customer_id?: SlowBooksId | null;
  default_class_id?: SlowBooksId | null;
  priority?: number;
  is_active?: boolean;
}

export interface SlowBooksEmployeeRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  first_name: string;
  last_name: string;
  job_title?: string | null;
  department?: string | null;
  email?: string | null;
  phone?: string | null;
  ssn_last4_masked?: string | null;
  hire_date: string;
  termination_date?: string | null;
  pay_type: 'hourly' | 'salary';
  pay_rate: string | number;
  pay_frequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
  filing_status?: 'single' | 'married' | 'head_of_household';
  w4_allowances?: number;
  is_active?: boolean;
  bank_accounts?: Array<{
    routing_number: string;
    account_masked: string;
    account_kind: 'checking' | 'savings';
    split_percent?: string | number;
    is_primary?: boolean;
  }>;
}

export interface SlowBooksBenefitCodeRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  code: string;
  name: string;
  kind: 'deduction' | 'contribution' | 'tax_exempt' | 'garnishment';
  calc_method: 'flat' | 'percent_gross' | 'tiered';
  liability_acct_id?: SlowBooksId | null;
  expense_acct_id?: SlowBooksId | null;
  is_active?: boolean;
}

export interface SlowBooksPayRunRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  run_number: string;
  pay_period_start: string;
  pay_period_end: string;
  pay_date: string;
  bank_account_id: SlowBooksId;
  total_gross: string | number;
  total_net: string | number;
  total_employee_taxes: string | number;
  total_employer_taxes: string | number;
  status: 'draft' | 'processed' | 'voided';
  journal_txn_id?: SlowBooksId | null;
  stubs?: Array<{
    id?: SlowBooksId;
    employee_id: SlowBooksId;
    hours_regular?: string | number;
    hours_overtime?: string | number;
    gross_pay: string | number;
    federal_tax?: string | number;
    state_tax?: string | number;
    ss_employee?: string | number;
    medicare_employee?: string | number;
    net_pay: string | number;
    ss_employer?: string | number;
    medicare_employer?: string | number;
    futa_employer?: string | number;
    suta_employer?: string | number;
  }>;
}

export interface SlowBooksFixedAssetTypeRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  name: string;
  asset_account_id?: SlowBooksId | null;
  accum_depr_account_id?: SlowBooksId | null;
  depr_expense_account_id?: SlowBooksId | null;
  depreciation_method?: 'straight_line' | 'declining_balance';
  effective_life_years?: string | number | null;
  annual_rate?: string | number | null;
}

export interface SlowBooksFixedAssetRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  asset_type_id: SlowBooksId;
  asset_number: string;
  name: string;
  purchase_date: string;
  purchase_price: string | number;
  salvage_value?: string | number;
  accumulated_depreciation?: string | number;
  last_depreciation_date?: string | null;
  disposal_date?: string | null;
  status?: 'registered' | 'disposed';
  description?: string | null;
}

export interface SlowBooksDocumentRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  storage_kind?: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  sha256_hex: string;
  storage_key: string;
  entity_type?: string | null;
  entity_id?: SlowBooksId | null;
  notes?: string | null;
  created_at?: string;
}

export interface SlowBooksAuditRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  occurred_at: string;
  actor_username?: string | null;
  action: string;
  table_name: string;
  record_id: SlowBooksId;
  old_values?: Record<string, unknown> | null;
  new_values?: Record<string, unknown> | null;
  changed_fields?: string[] | null;
  sha256_hash?: string | null;
}

export interface SlowBooksDeprecatedVerticalRecord {
  id: SlowBooksId;
  company_id: SlowBooksId;
  source_table: string;
  summary: string;
  amount?: string | number;
  payload?: Record<string, unknown>;
}

export interface SlowBooksSourceBundle {
  sourceSystem?: string;
  exportedAt?: string;
  asOfDate?: string;
  companies: SlowBooksCompanyRecord[];
  users: SlowBooksUserRecord[];
  company_memberships?: SlowBooksMembershipRecord[];
  settings?: Array<{ company_id: SlowBooksId; setting_key: string; setting_value: string }>;
  payment_terms?: SlowBooksPaymentTermRecord[];
  classes?: SlowBooksClassRecord[];
  accounts: SlowBooksAccountRecord[];
  fiscal_periods?: SlowBooksFiscalPeriodRecord[];
  customers?: SlowBooksCustomerRecord[];
  reseller_permits?: SlowBooksResellerPermitRecord[];
  invoice_messages?: Array<{ id?: SlowBooksId; company_id: SlowBooksId; name: string; kind: 'invoice' | 'estimate' | 'statement'; body: string }>;
  vendors?: SlowBooksVendorRecord[];
  items?: SlowBooksItemRecord[];
  inventory_adjustments?: SlowBooksInventoryAdjustmentRecord[];
  inventory_movements?: SlowBooksInventoryMovementRecord[];
  estimates?: SlowBooksEstimateRecord[];
  invoices?: SlowBooksInvoiceRecord[];
  payments?: SlowBooksPaymentRecord[];
  credit_memos?: SlowBooksCreditMemoRecord[];
  recurring_invoices?: Array<{
    id: SlowBooksId;
    company_id: SlowBooksId;
    customer_id: SlowBooksId;
    frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
    start_date: string;
    end_date?: string | null;
    next_due: string;
    is_active?: boolean;
    tax_rate?: string | number;
    notes?: string | null;
    lines: Array<{ item_id?: SlowBooksId | null; description: string; quantity: string | number; rate: string | number; is_taxable?: boolean }>;
  }>;
  purchase_orders?: SlowBooksPurchaseOrderRecord[];
  bills?: SlowBooksBillRecord[];
  bill_payments?: SlowBooksBillPaymentRecord[];
  vendor_credits?: SlowBooksVendorCreditRecord[];
  transactions?: SlowBooksJournalRecord[];
  opening_balances?: SlowBooksOpeningBalanceRecord[];
  bank_accounts?: SlowBooksBankAccountRecord[];
  reconciliations?: SlowBooksReconciliationRecord[];
  bank_transactions?: SlowBooksBankTransactionRecord[];
  bank_rules?: SlowBooksBankRuleRecord[];
  employees?: SlowBooksEmployeeRecord[];
  benefit_codes?: SlowBooksBenefitCodeRecord[];
  employee_benefits?: Array<{
    id?: SlowBooksId;
    company_id: SlowBooksId;
    employee_id: SlowBooksId;
    benefit_code_id: SlowBooksId;
    employee_rate: string | number;
    employer_rate: string | number;
    ytd_employee?: string | number;
    ytd_employer?: string | number;
  }>;
  pay_runs?: SlowBooksPayRunRecord[];
  pto_policies?: Array<{
    id: SlowBooksId;
    company_id: SlowBooksId;
    name: string;
    pto_type: 'vacation' | 'sick' | 'personal';
    accrual_method: 'per_hour' | 'per_period' | 'annual';
    accrual_rate: string | number;
    max_balance?: string | number | null;
  }>;
  pto_accruals?: Array<{
    id?: SlowBooksId;
    company_id: SlowBooksId;
    employee_id: SlowBooksId;
    policy_id: SlowBooksId;
    balance_hrs: string | number;
    accrued_ytd?: string | number;
    used_ytd?: string | number;
  }>;
  time_entries?: Array<{
    id: SlowBooksId;
    company_id: SlowBooksId;
    employee_id: SlowBooksId;
    entry_date: string;
    hours_regular: string | number;
    hours_overtime?: string | number;
    status?: 'draft' | 'submitted' | 'approved' | 'paid';
    notes?: string | null;
  }>;
  fixed_asset_types?: SlowBooksFixedAssetTypeRecord[];
  fixed_assets?: SlowBooksFixedAssetRecord[];
  budgets?: Array<{
    id?: SlowBooksId;
    company_id: SlowBooksId;
    account_id: SlowBooksId;
    fiscal_year: number;
    fiscal_month: number;
    amount: string | number;
    class_id?: SlowBooksId | null;
  }>;
  tax_category_mappings?: Array<{
    id?: SlowBooksId;
    company_id: SlowBooksId;
    account_id: SlowBooksId;
    tax_line: string;
  }>;
  saved_reports?: Array<{
    id: SlowBooksId;
    company_id: SlowBooksId;
    name: string;
    report_type: string;
    parameters?: Record<string, unknown>;
  }>;
  documents?: SlowBooksDocumentRecord[];
  ocr_templates?: Array<{
    id: SlowBooksId;
    company_id: SlowBooksId;
    merchant_key: string;
    merchant_name: string;
    fields_json?: Record<string, unknown>;
    use_count?: number;
  }>;
  email_templates?: Array<{
    id: SlowBooksId;
    company_id: SlowBooksId;
    kind: string;
    subject: string;
    body: string;
    is_default?: boolean;
  }>;
  audit_log?: SlowBooksAuditRecord[];
  document_audits?: Array<{
    id: SlowBooksId;
    company_id: SlowBooksId;
    entity_type: string;
    entity_id: SlowBooksId;
    event_type: string;
    actor_username?: string | null;
    details?: string | null;
    created_at?: string;
  }>;
  qbo_mappings?: Array<{
    id?: SlowBooksId;
    company_id: SlowBooksId;
    entity_type: string;
    local_id: SlowBooksId;
    external_id: string;
    sync_token?: string | null;
  }>;
  deprecated_records?: SlowBooksDeprecatedVerticalRecord[];
}

export function canonicalJsonHash(data: unknown): string {
  const serialized = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

export function loadSlowBooksSourceFile(filePath: string): {
  bundle: SlowBooksSourceBundle;
  rawSha256: string;
  sizeBytes: number;
} {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  const rawSha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const parsed = JSON.parse(raw) as SlowBooksSourceBundle;
  if (!parsed || !Array.isArray(parsed.companies) || !Array.isArray(parsed.accounts)) {
    throw new Error(`Invalid SlowBooks bundle at ${abs}: expected companies[] and accounts[]`);
  }
  return {
    bundle: parsed,
    rawSha256,
    sizeBytes: Buffer.byteLength(raw, 'utf8'),
  };
}

export function createSourceBackupArtifact(
  bundle: SlowBooksSourceBundle,
  backupDir: string,
  batchKey: string
): { filePath: string; sha256: string; sizeBytes: number } {
  fs.mkdirSync(backupDir, { recursive: true });
  const safeKey = batchKey.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const filePath = path.join(backupDir, `source-slowbooks_${safeKey}.json`);
  const payload = JSON.stringify(bundle, null, 2);
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  fs.writeFileSync(filePath, payload, { encoding: 'utf8', mode: 0o444 });
  return { filePath, sha256, sizeBytes: Buffer.byteLength(payload, 'utf8') };
}

const BACKUP_SNAPSHOT_TABLES = [
  'companies',
  'users',
  'company_memberships',
  'payment_terms',
  'txn_classes',
  'accounts',
  'fiscal_periods',
  'customers',
  'reseller_permits',
  'vendors',
  'inventory_items',
  'estimates',
  'invoices',
  'payments',
  'credit_memos',
  'purchase_orders',
  'bills',
  'bill_payments',
  'vendor_credits',
  'journal_transactions',
  'journal_lines',
  'bank_accounts',
  'bank_transactions',
  'reconciliations',
  'employees',
  'pay_runs',
  'fixed_assets',
  'budgets',
  'audit_log',
] as const;

export async function createTargetDatabaseBackup(
  tx: Transaction,
  backupDir: string,
  batchKey: string
): Promise<{
  filePath: string;
  sha256: string;
  sizeBytes: number;
  snapshotSummary: { capturedAt: string; tableCounts: Record<string, number> };
}> {
  await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);
  const tables: Record<string, unknown[]> = {};
  const tableCounts: Record<string, number> = {};

  for (const tbl of BACKUP_SNAPSHOT_TABLES) {
    const res = await tx.query<Record<string, unknown>>(`SELECT * FROM ${tbl} ORDER BY id ASC`);
    tables[tbl] = res.rows;
    tableCounts[tbl] = res.rows.length;
  }

  const capturedAt = new Date().toISOString();
  const payloadObj = {
    schemaVersion: '0012',
    capturedAt,
    batchKey,
    tableCounts,
    tables,
  };
  const serialized = JSON.stringify(payloadObj);
  const sha256 = crypto.createHash('sha256').update(serialized).digest('hex');

  fs.mkdirSync(backupDir, { recursive: true });
  const safeKey = batchKey.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const filePath = path.join(backupDir, `target-pms-pre-migration_${safeKey}.json`);
  fs.writeFileSync(filePath, serialized, 'utf8');

  return {
    filePath,
    sha256,
    sizeBytes: Buffer.byteLength(serialized, 'utf8'),
    snapshotSummary: { capturedAt, tableCounts },
  };
}
