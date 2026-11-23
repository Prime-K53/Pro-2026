import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';
import { ServerConfig } from '../../src/server/config.ts';
import { hashPassword } from '../../src/server/supabaseAuth.ts';
import {
  buildReconciliationMarkdownReport,
} from '../../src/server/services/slowbooksMigrationService.ts';
import {
  canonicalJsonHash,
  SlowBooksSourceBundle,
} from '../../src/server/services/slowbooksSourceAdapter.ts';

function makeConfig(tmpDir: string): ServerConfig {
  return {
    port: 0,
    nodeEnv: 'test',
    appUrl: 'http://localhost:3000',
    dbDataDir: path.join(tmpDir, 'pg'),
    attachmentsDir: path.join(tmpDir, 'attachments'),
    supabaseUrl: '',
    supabasePublishableKey: '',
    supabaseSecretKey: '',
    supabaseJwksUrl: '',
    authSessionSecret: 'phase10-test-secret-key-0123456789abcdef',
    sessionTtlSeconds: 3600,
    idleTimeoutSeconds: 1800,
    cookieName: 'pms_session',
    isProduction: false,
    twilioAuthToken: null,
  };
}

class TestHttpClient {
  private cookieHeader = '';
  constructor(private readonly baseUrl: string) {}

  async request(method: string, reqPath: string, body?: unknown) {
    const res = await fetch(`${this.baseUrl}${reqPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookieHeader ? { Cookie: this.cookieHeader } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/pms_session=[^;]+/);
      if (m) this.cookieHeader = m[0];
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }
}

function buildTestSlowBooksBundle(): SlowBooksSourceBundle {
  return {
    sourceSystem: 'SlowBooks-Pro-2026',
    exportedAt: '2026-11-15T22:00:00Z',
    asOfDate: '2026-12-31',
    companies: [
      {
        id: 'SB-COMP-101',
        slug: 'zambezi-litho-press',
        name: 'Zambezi Litho & Press Ltd',
        legal_name: 'Zambezi Litho & Press Limited',
        tax_id_ein: 'TPIN-99100234',
        base_currency: 'ZMW',
        currency_symbol: 'K',
        fiscal_year_start_month: 1,
        accounting_method: 'accrual',
        sales_tax_rate: 16,
        rounding_mode: 'HALF_EVEN',
        decimal_places: 2,
        is_active: true,
      },
      {
        id: 'SB-COMP-202',
        slug: 'kitwe-packaging-labels',
        name: 'Kitwe Packaging & Labels Co',
        legal_name: 'Kitwe Packaging & Labels Co Ltd',
        tax_id_ein: 'TPIN-88200456',
        base_currency: 'ZMW',
        currency_symbol: 'K',
        fiscal_year_start_month: 1,
        accounting_method: 'accrual',
        sales_tax_rate: 16,
        rounding_mode: 'HALF_EVEN',
        decimal_places: 2,
        is_active: true,
      },
    ],
    users: [
      {
        id: 'SB-U-1',
        username: 'zl_director',
        email: 'director@zambezilitho.zm',
        display_name: 'Mwamba Chileshe',
        role: 'Administrator',
        is_active: true,
      },
      {
        id: 'SB-U-2',
        username: 'zl_cpa',
        email: 'cpa@zambezilitho.zm',
        display_name: 'Lombe Banda',
        role: 'Accountant',
        is_active: true,
      },
      {
        id: 'SB-U-3',
        username: 'zl_legacy_clerk',
        email: 'legacy@zambezilitho.zm',
        display_name: 'Former Clerk',
        role: 'Bookkeeper',
        is_active: false,
        is_archived: true,
      },
      {
        id: 'SB-U-4',
        username: 'kp_manager',
        email: 'ops@kitwepack.zm',
        display_name: 'Chipo Zulu',
        role: 'ProductionManager',
        is_active: true,
      },
    ],
    company_memberships: [
      { id: 'MEM-1', company_id: 'SB-COMP-101', user_id: 'SB-U-1', role: 'Administrator', is_default: true },
      { id: 'MEM-2', company_id: 'SB-COMP-101', user_id: 'SB-U-2', role: 'Accountant', is_default: true },
      { id: 'MEM-3', company_id: 'SB-COMP-101', user_id: 'SB-U-3', role: 'Bookkeeper', is_active: false },
      { id: 'MEM-4', company_id: 'SB-COMP-101', user_id: 'SB-U-2', role: 'Accountant' }, // duplicate membership
      { id: 'MEM-5', company_id: 'SB-COMP-202', user_id: 'SB-U-1', role: 'Administrator', is_default: false },
      { id: 'MEM-6', company_id: 'SB-COMP-202', user_id: 'SB-U-4', role: 'ProductionManager', is_default: true },
    ],
    settings: [
      { company_id: 'SB-COMP-101', setting_key: 'invoice_prefix', setting_value: 'ZLP-' },
      { company_id: 'SB-COMP-202', setting_key: 'invoice_prefix', setting_value: 'KPL-' },
    ],
    payment_terms: [
      { id: 'PT-1', company_id: 'SB-COMP-101', name: 'Net 30', kind: 'standard', net_days: 30 },
      { id: 'PT-2', company_id: 'SB-COMP-101', name: '2/10 Net 30', kind: 'standard', net_days: 30, discount_percent: 2, discount_days: 10 },
      { id: 'PT-3', company_id: 'SB-COMP-101', name: 'Net 30', kind: 'standard', net_days: 30 }, // duplicate term
      { id: 'PT-4', company_id: 'SB-COMP-202', name: 'Due on Receipt', kind: 'standard', net_days: 0 },
    ],
    classes: [
      { id: 'CLS-1', company_id: 'SB-COMP-101', name: 'Press Floor' },
      { id: 'CLS-2', company_id: 'SB-COMP-101', name: 'Academic Books', parent_id: 'CLS-1' },
      { id: 'CLS-3', company_id: 'SB-COMP-202', name: 'Packaging Line' },
    ],
    accounts: [
      // Company 101 COA
      { id: 'A-1010', company_id: 'SB-COMP-101', code: '1010', name: 'Operating Checking', account_type: 'Bank', bank_kind: 'bank', is_system: true, is_control: true },
      { id: 'A-1010-DUP', company_id: 'SB-COMP-101', code: '1010', name: 'Duplicate Operating Checking', account_type: 'Bank', bank_kind: 'bank' }, // duplicate
      { id: 'A-1100', company_id: 'SB-COMP-101', code: '1100', name: 'Accounts Receivable', account_type: 'AccountsReceivable', is_system: true, is_control: true },
      { id: 'A-1200', company_id: 'SB-COMP-101', code: '1200', name: 'Inventory Asset', account_type: 'Inventory', is_system: true, is_control: true },
      { id: 'A-1500', company_id: 'SB-COMP-101', code: '1500', name: 'Heidelberg Offset Press', account_type: 'FixedAsset' },
      { id: 'A-1590', company_id: 'SB-COMP-101', code: '1590', name: 'Accumulated Depreciation', account_type: 'FixedAsset' },
      { id: 'A-2000', company_id: 'SB-COMP-101', code: '2000', name: 'Accounts Payable', account_type: 'AccountsPayable', is_system: true, is_control: true },
      { id: 'A-2200', company_id: 'SB-COMP-101', code: '2200', name: 'Sales Tax Payable', account_type: 'OtherCurrentLiability', is_system: true, is_control: true },
      { id: 'A-3000', company_id: 'SB-COMP-101', code: '3000', name: 'Owner Capital', account_type: 'Equity' },
      { id: 'A-3200', company_id: 'SB-COMP-101', code: '3200', name: 'Retained Earnings', account_type: 'Equity', is_system: true, is_control: true },
      { id: 'A-4000', company_id: 'SB-COMP-101', code: '4000', name: 'Printing & Sales Revenue', account_type: 'Income', is_system: true, is_control: true },
      { id: 'A-5000', company_id: 'SB-COMP-101', code: '5000', name: 'Cost of Goods Sold', account_type: 'CostOfGoodsSold', is_system: true, is_control: true },
      { id: 'A-6100', company_id: 'SB-COMP-101', code: '6100', name: 'Payroll Expenses', account_type: 'Expense' },
      { id: 'A-6200', company_id: 'SB-COMP-101', code: '6200', name: 'Rent & Utilities', account_type: 'Expense' },
      { id: 'A-6990', company_id: 'SB-COMP-101', code: '6990', name: 'Legacy Travel (Archived)', account_type: 'Expense', is_archived: true },

      // Company 202 COA
      { id: 'B-1010', company_id: 'SB-COMP-202', code: '1010', name: 'Kitwe Bank Account', account_type: 'Bank', bank_kind: 'bank', is_system: true, is_control: true },
      { id: 'B-1100', company_id: 'SB-COMP-202', code: '1100', name: 'Accounts Receivable', account_type: 'AccountsReceivable', is_system: true, is_control: true },
      { id: 'B-1200', company_id: 'SB-COMP-202', code: '1200', name: 'Inventory Asset', account_type: 'Inventory', is_system: true, is_control: true },
      { id: 'B-2000', company_id: 'SB-COMP-202', code: '2000', name: 'Accounts Payable', account_type: 'AccountsPayable', is_system: true, is_control: true },
      { id: 'B-3000', company_id: 'SB-COMP-202', code: '3000', name: 'Owner Equity', account_type: 'Equity' },
      { id: 'B-4000', company_id: 'SB-COMP-202', code: '4000', name: 'Packaging Revenue', account_type: 'Income', is_system: true, is_control: true },
      { id: 'B-5000', company_id: 'SB-COMP-202', code: '5000', name: 'Cost of Goods Sold', account_type: 'CostOfGoodsSold', is_system: true, is_control: true },
    ],
    fiscal_periods: [
      { id: 'FP-2025-Q4', company_id: 'SB-COMP-101', period_name: 'FY2025-Q4', start_date: '2025-10-01', end_date: '2025-12-31', status: 'closed', closed_at: '2026-01-10T10:00:00Z' },
      { id: 'FP-2026-Q1', company_id: 'SB-COMP-101', period_name: 'FY2026-Q1', start_date: '2026-01-01', end_date: '2026-03-31', status: 'soft_closed' },
      { id: 'FP-2026-FY', company_id: 'SB-COMP-202', period_name: 'FY2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' },
    ],
    customers: [
      { id: 'C-1', company_id: 'SB-COMP-101', customer_type: 'school', name: 'Kabwe High School', company_name: 'Kabwe High School', email: 'bursar@kabwehigh.zm', payment_term_id: 'PT-1', is_tax_exempt: true },
      { id: 'C-2', company_id: 'SB-COMP-101', customer_type: 'corporate', name: 'Copperbelt Publishing', company_name: 'Copperbelt Publishing Ltd', email: 'ap@cbpub.zm', payment_term_id: 'PT-2' },
      { id: 'C-2-DUP', company_id: 'SB-COMP-101', customer_type: 'corporate', name: 'Copperbelt Publishing', company_name: 'Copperbelt Publishing Ltd' }, // duplicate
      { id: 'C-3-ARCH', company_id: 'SB-COMP-101', customer_type: 'individual', name: 'Dormant School Account', company_name: 'Dormant School', is_archived: true },
      { id: 'C-201', company_id: 'SB-COMP-202', customer_type: 'corporate', name: 'Mopani Agro Packs', company_name: 'Mopani Agro Packs Ltd', email: 'finance@mopaniagro.zm' },
    ],
    reseller_permits: [
      { id: 'RP-1', company_id: 'SB-COMP-101', customer_id: 'C-1', jurisdiction: 'ZRA-EDU', permit_number: 'EX-EDU-2026-88', issued_at: '2026-01-01', expires_at: '2027-12-31' },
    ],
    invoice_messages: [
      { id: 'IM-1', company_id: 'SB-COMP-101', name: 'Standard Footer', kind: 'invoice', body: 'Thank you for printing with Zambezi Litho & Press.' },
    ],
    vendors: [
      { id: 'V-1', company_id: 'SB-COMP-101', name: 'Lusaka Paper Distributors', company_name: 'Lusaka Paper Distributors Ltd', email: 'sales@lusakapaper.zm', default_expense_account_id: 'A-1200', payment_term_id: 'PT-1' },
      { id: 'V-1-DUP', company_id: 'SB-COMP-101', name: 'Lusaka Paper Distributors', company_name: 'Lusaka Paper Distributors Ltd' }, // duplicate
      { id: 'V-2-ARCH', company_id: 'SB-COMP-101', name: 'Old Toner Co (Archived)', company_name: 'Old Toner Co', is_archived: true },
      { id: 'V-201', company_id: 'SB-COMP-202', name: 'Kitwe Pulp & Foil', company_name: 'Kitwe Pulp & Foil Ltd', default_expense_account_id: 'B-1200' },
    ],
    items: [
      { id: 'IT-RM-1', company_id: 'SB-COMP-101', sku: 'ZLP-PAPER-A4', name: 'A4 80gsm Offset Paper Ream', item_type: 'material', unit_cost: '120.000000', avg_cost: '120.000000', sales_price: '0.0000', on_hand: '50.000000', purchase_unit: 'Ream', usage_unit: 'Sheet', conversion_factor: '500.000000', asset_account_id: 'A-1200', cogs_account_id: 'A-5000', income_account_id: 'A-4000' },
      { id: 'IT-ST-1', company_id: 'SB-COMP-101', sku: 'ZLP-NOTEBOOK', name: 'Hardcover A4 Ledger Book', item_type: 'inventory', unit_cost: '25.000000', avg_cost: '25.000000', sales_price: '60.0000', on_hand: '40.000000', asset_account_id: 'A-1200', cogs_account_id: 'A-5000', income_account_id: 'A-4000' },
      { id: 'IT-PP-1', company_id: 'SB-COMP-101', sku: 'ZLP-TEXTBOOK', name: 'Printed Biology Textbook', item_type: 'printed_product', unit_cost: '18.000000', sales_price: '45.0000', on_hand: '0.000000', asset_account_id: 'A-1200', cogs_account_id: 'A-5000', income_account_id: 'A-4000' },
      { id: 'IT-PS-1', company_id: 'SB-COMP-101', sku: 'ZLP-EXAM-SVC', name: 'Examination Printing Service', item_type: 'service', unit_cost: '0.500000', sales_price: '1.5000', on_hand: '0.000000', asset_account_id: 'A-1200', cogs_account_id: 'A-5000', income_account_id: 'A-4000' },
      { id: 'IT-DUP', company_id: 'SB-COMP-101', sku: 'ZLP-NOTEBOOK', name: 'Duplicate Ledger Book SKU', item_type: 'inventory', unit_cost: '25.000000', sales_price: '60.0000', on_hand: '0.000000' }, // duplicate SKU
      { id: 'IT-ARCH', company_id: 'SB-COMP-101', sku: 'ZLP-OLD-CAL', name: '2024 Wall Calendar', item_type: 'printed_product', unit_cost: '10.000000', sales_price: '20.0000', on_hand: '0.000000', is_archived: true },
      { id: 'IT-BAD-RM', company_id: 'SB-COMP-101', sku: 'ZLP-BAD-RM', name: 'Corrupt Priced Raw Material', item_type: 'raw_material', unit_cost: '50.000000', sales_price: '99.0000', on_hand: '0.000000' }, // REJECTED: raw_material cannot have sales_price > 0
      { id: 'IT-201', company_id: 'SB-COMP-202', sku: 'KPL-CARTON', name: 'Corrugated Box 20x20', item_type: 'stationery', unit_cost: '15.000000', avg_cost: '15.000000', sales_price: '35.0000', on_hand: '100.000000', asset_account_id: 'B-1200', cogs_account_id: 'B-5000', income_account_id: 'B-4000' },
    ],
    inventory_adjustments: [
      { id: 'IADJ-1', company_id: 'SB-COMP-101', adj_date: '2026-01-15', memo: 'Initial stock count verification' },
    ],
    inventory_movements: [
      { id: 'IMV-1', company_id: 'SB-COMP-101', item_id: 'IT-RM-1', movement_type: 'purchase', quantity_delta: '50.000000', unit_cost: '120.000000', balance_qty: '50.000000', balance_avg_cost: '120.000000', source_type: 'opening', source_id: '1' },
    ],
    // Opening Balances (Exact 4-decimal math: 50000 + 7000 + 120000 - 15000 = 162000)
    opening_balances: [
      {
        id: 'OB-101',
        company_id: 'SB-COMP-101',
        txn_date: '2025-11-01',
        description: 'Historical Opening Balances (Closed FY2025-Q4)',
        lines: [
          { account_id: 'A-1010', debit: '50000.0000', credit: '0.0000', description: 'Opening Bank Balance' },
          { account_id: 'A-1200', debit: '7000.0000', credit: '0.0000', description: 'Opening Inventory (50*120 + 40*25)' },
          { account_id: 'A-1500', debit: '120000.0000', credit: '0.0000', description: 'Offset Press Asset' },
          { account_id: 'A-1590', debit: '0.0000', credit: '15000.0000', description: 'Accumulated Depr' },
          { account_id: 'A-3000', debit: '0.0000', credit: '162000.0000', description: 'Owner Capital' },
        ],
      },
      {
        id: 'OB-202',
        company_id: 'SB-COMP-202',
        txn_date: '2026-01-01',
        description: 'Kitwe Opening Balances',
        lines: [
          { account_id: 'B-1010', debit: '30000.0000', credit: '0.0000' },
          { account_id: 'B-1200', debit: '1500.0000', credit: '0.0000' },
          { account_id: 'B-3000', debit: '0.0000', credit: '31500.0000' },
        ],
      },
    ],
    transactions: [
      // Historical 2025 transaction inside CLOSED period FY2025-Q4 (must load cleanly before locking period!)
      {
        id: 'JE-2025-1',
        company_id: 'SB-COMP-101',
        entry_number: 'SB-JE-2025-001',
        txn_date: '2025-12-15',
        description: '2025 Closed-Period Rent Payment',
        source_type: 'check',
        status: 'posted',
        is_posted: true,
        lines: [
          { account_id: 'A-6200', debit: '2500.3333', credit: '0.0000', class_id: 'CLS-1' },
          { account_id: 'A-1010', debit: '0.0000', credit: '2500.3333' },
        ],
      },
      // Invoice JE + Payment JE + Reversal pair in 2026
      {
        id: 'JE-INV-1',
        company_id: 'SB-COMP-101',
        entry_number: 'SB-JE-2026-001',
        txn_date: '2026-02-10',
        description: 'Invoice ZLP-1001 — Kabwe High School',
        source_type: 'invoice',
        status: 'posted',
        is_posted: true,
        lines: [
          { account_id: 'A-1100', debit: '4500.0000', credit: '0.0000', party_type: 'customer', party_id: 'C-1' },
          { account_id: 'A-4000', debit: '0.0000', credit: '4500.0000' },
        ],
      },
      {
        id: 'JE-PMT-1',
        company_id: 'SB-COMP-101',
        entry_number: 'SB-JE-2026-002',
        txn_date: '2026-02-20',
        description: 'Customer Payment ZLP-PMT-01',
        source_type: 'payment',
        status: 'posted',
        is_posted: true,
        lines: [
          { account_id: 'A-1010', debit: '1500.0000', credit: '0.0000' },
          { account_id: 'A-1100', debit: '0.0000', credit: '1500.0000', party_type: 'customer', party_id: 'C-1' },
        ],
      },
      {
        id: 'JE-BILL-1',
        company_id: 'SB-COMP-101',
        entry_number: 'SB-JE-2026-003',
        txn_date: '2026-03-01',
        description: 'Vendor Bill LSK-8801 — Lusaka Paper Distributors',
        source_type: 'bill',
        status: 'posted',
        is_posted: true,
        lines: [
          { account_id: 'A-5000', debit: '1200.6667', credit: '0.0000' },
          { account_id: 'A-2000', debit: '0.0000', credit: '1200.6667', party_type: 'vendor', party_id: 'V-1' },
        ],
      },
      {
        id: 'JE-ORIG-1',
        company_id: 'SB-COMP-101',
        entry_number: 'SB-JE-2026-004',
        txn_date: '2026-04-02',
        description: 'Accrued Expense Entry (later reversed)',
        source_type: 'manual',
        status: 'voided',
        is_posted: true,
        reversed_by_transaction_id: 'JE-REV-1',
        lines: [
          { account_id: 'A-6200', debit: '500.0000', credit: '0.0000' },
          { account_id: 'A-1010', debit: '0.0000', credit: '500.0000' },
        ],
      },
      {
        id: 'JE-REV-1',
        company_id: 'SB-COMP-101',
        entry_number: 'SB-REV-2026-004',
        txn_date: '2026-04-03',
        description: 'VOID: Accrued Expense Entry',
        source_type: 'reversal',
        status: 'posted',
        is_posted: true,
        reverses_transaction_id: 'JE-ORIG-1',
        lines: [
          { account_id: 'A-1010', debit: '500.0000', credit: '0.0000' },
          { account_id: 'A-6200', debit: '0.0000', credit: '500.0000' },
        ],
      },
      {
        id: 'JE-DEL-1',
        company_id: 'SB-COMP-101',
        entry_number: 'SB-JE-DEL-001',
        txn_date: '2026-04-05',
        description: 'Deleted Draft Entry',
        source_type: 'manual',
        status: 'draft',
        is_posted: false,
        is_deleted: true,
        lines: [
          { account_id: 'A-6200', debit: '100.0000', credit: '0.0000' },
          { account_id: 'A-1010', debit: '0.0000', credit: '100.0000' },
        ],
      },
      {
        id: 'JE-DUP-1',
        company_id: 'SB-COMP-101',
        entry_number: 'SB-JE-2026-001', // duplicate entry number
        txn_date: '2026-02-10',
        description: 'Duplicate Invoice JE',
        source_type: 'invoice',
        status: 'posted',
        is_posted: true,
        lines: [
          { account_id: 'A-1100', debit: '4500.0000', credit: '0.0000' },
          { account_id: 'A-4000', debit: '0.0000', credit: '4500.0000' },
        ],
      },
      {
        id: 'JE-CORRUPT-1',
        company_id: 'SB-COMP-101',
        entry_number: 'SB-JE-BAD-999',
        txn_date: '2026-04-10',
        description: 'Corrupt Unbalanced Source Journal',
        source_type: 'manual',
        status: 'posted',
        is_posted: true,
        lines: [
          { account_id: 'A-6200', debit: '125.0000', credit: '0.0000' },
          { account_id: 'A-1010', debit: '0.0000', credit: '100.0000' },
        ],
      },
      // Company 202 GL entry
      {
        id: 'JE-202-1',
        company_id: 'SB-COMP-202',
        entry_number: 'KP-JE-001',
        txn_date: '2026-05-01',
        description: 'Invoice KPL-5001 — Mopani Agro Packs',
        source_type: 'invoice',
        status: 'posted',
        is_posted: true,
        lines: [
          { account_id: 'B-1100', debit: '3500.0000', credit: '0.0000', party_type: 'customer', party_id: 'C-201' },
          { account_id: 'B-4000', debit: '0.0000', credit: '3500.0000' },
        ],
      },
    ],
    estimates: [
      {
        id: 'EST-1',
        company_id: 'SB-COMP-101',
        estimate_number: 'EST-ZLP-01',
        customer_id: 'C-1',
        estimate_date: '2026-02-01',
        expiry_date: '2026-03-01',
        status: 'invoiced',
        subtotal: '4500.0000',
        tax_rate: 0,
        tax_amount: '0.0000',
        total: '4500.0000',
        total_cost: '1800.0000',
        lines: [{ item_id: 'IT-PP-1', description: 'Printed Biology Textbooks (100x)', quantity: 100, unit_cost: 18, rate: 45, amount: 4500 }],
      },
    ],
    invoices: [
      {
        id: 'INV-1',
        company_id: 'SB-COMP-101',
        invoice_number: 'ZLP-1001',
        customer_id: 'C-1',
        invoice_date: '2026-02-10',
        due_date: '2026-03-12',
        status: 'partial',
        subtotal: '4500.0000',
        tax_rate: 0,
        tax_amount: '0.0000',
        total: '4500.0000',
        total_cost: '1800.0000',
        amount_paid: '1500.0000',
        balance_due: '3000.0000',
        journal_txn_id: 'JE-INV-1',
        source_estimate_id: 'EST-1',
        lines: [{ item_id: 'IT-PP-1', description: 'Printed Biology Textbooks (100x)', quantity: 100, rate: 45, amount: 4500, unit_cost: 18, total_cost: 1800 }],
      },
      {
        id: 'INV-DEL',
        company_id: 'SB-COMP-101',
        invoice_number: 'ZLP-DEL-00',
        customer_id: 'C-2',
        invoice_date: '2026-02-15',
        due_date: '2026-03-15',
        status: 'voided',
        subtotal: '200.0000',
        tax_rate: 0,
        tax_amount: '0.0000',
        total: '200.0000',
        amount_paid: '0.0000',
        balance_due: '200.0000',
        is_deleted: true,
        lines: [{ item_id: 'IT-ST-1', description: 'Voided Order', quantity: 1, rate: 200, amount: 200 }],
      },
      {
        id: 'INV-CORRUPT-RM',
        company_id: 'SB-COMP-101',
        invoice_number: 'ZLP-BAD-RM',
        customer_id: 'C-2',
        invoice_date: '2026-03-05',
        due_date: '2026-04-05',
        status: 'sent',
        subtotal: '600.0000',
        tax_rate: 0,
        tax_amount: '0.0000',
        total: '600.0000',
        amount_paid: '0.0000',
        balance_due: '600.0000',
        lines: [{ item_id: 'IT-RM-1', description: 'Illegal direct sale of raw material paper', quantity: 5, rate: 120, amount: 600 }],
      },
      {
        id: 'INV-201',
        company_id: 'SB-COMP-202',
        invoice_number: 'KPL-5001',
        customer_id: 'C-201',
        invoice_date: '2026-05-01',
        due_date: '2026-05-01',
        status: 'sent',
        subtotal: '3500.0000',
        tax_rate: 0,
        tax_amount: '0.0000',
        total: '3500.0000',
        total_cost: '1500.0000',
        amount_paid: '0.0000',
        balance_due: '3500.0000',
        journal_txn_id: 'JE-202-1',
        lines: [{ item_id: 'IT-201', description: 'Corrugated Boxes (100x)', quantity: 100, rate: 35, amount: 3500, unit_cost: 15, total_cost: 1500 }],
      },
    ],
    payments: [
      {
        id: 'PMT-1',
        company_id: 'SB-COMP-101',
        payment_number: 'ZLP-PMT-01',
        customer_id: 'C-1',
        payment_date: '2026-02-20',
        amount: '1500.0000',
        payment_method: 'ACH / Wire',
        deposit_to_account_id: 'A-1010',
        journal_txn_id: 'JE-PMT-1',
        allocations: [{ invoice_id: 'INV-1', amount: '1500.0000' }],
      },
    ],
    purchase_orders: [
      {
        id: 'PO-1',
        company_id: 'SB-COMP-101',
        po_number: 'PO-ZLP-01',
        vendor_id: 'V-1',
        po_date: '2026-02-25',
        status: 'closed',
        total: '1200.6667',
        lines: [{ item_id: 'IT-RM-1', account_id: 'A-5000', description: 'Offset Plates & Ink Supplies', quantity: 10, received_qty: 10, rate: '120.0667', amount: '1200.6667' }],
      },
    ],
    bills: [
      {
        id: 'BILL-1',
        company_id: 'SB-COMP-101',
        bill_number: 'LSK-8801',
        vendor_id: 'V-1',
        bill_date: '2026-03-01',
        due_date: '2026-03-31',
        status: 'open',
        total: '1200.6667',
        amount_paid: '0.0000',
        balance_due: '1200.6667',
        journal_txn_id: 'JE-BILL-1',
        purchase_order_id: 'PO-1',
        lines: [{ account_id: 'A-5000', item_id: 'IT-RM-1', description: 'Offset Supplies', quantity: 10, unit_cost: '120.0667', amount: '1200.6667' }],
      },
      {
        id: 'BILL-BAD-DATE',
        company_id: 'SB-COMP-101',
        bill_number: 'LSK-BAD-DATE',
        vendor_id: 'V-1',
        bill_date: '2026-03-20',
        due_date: '2026-03-01', // REJECTED: due_date < bill_date
        status: 'open',
        total: '300.0000',
        amount_paid: '0.0000',
        balance_due: '300.0000',
        lines: [{ account_id: 'A-6200', description: 'Corrupt Date Bill', quantity: 1, amount: '300.0000' }],
      },
    ],
    bank_accounts: [
      { id: 'BA-101', company_id: 'SB-COMP-101', gl_account_id: 'A-1010', institution_name: 'Zanaco Lusaka Main', account_mask: '1010', feed_provider: 'manual', next_check_number: 2050 },
      { id: 'BA-202', company_id: 'SB-COMP-202', gl_account_id: 'B-1010', institution_name: 'Stanbic Kitwe', account_mask: '2020', feed_provider: 'manual', next_check_number: 3001 },
    ],
    reconciliations: [
      { id: 'REC-1', company_id: 'SB-COMP-101', account_id: 'A-1010', bank_account_id: 'BA-101', statement_date: '2026-02-28', statement_ending_balance: '48999.6667', beginning_balance: '50000.0000', cleared_total: '-1000.3333', difference: '0.0000', status: 'completed' },
    ],
    bank_transactions: [
      { id: 'BT-1', company_id: 'SB-COMP-101', account_id: 'A-1010', bank_account_id: 'BA-101', txn_date: '2025-12-15', payee: 'Lusaka Landlord', txn_type: 'Check', ref_number: '2048', amount: '-2500.3333', is_cleared: true, reconciliation_id: 'REC-1', journal_txn_id: 'JE-2025-1', check_number: '2048' },
      { id: 'BT-2', company_id: 'SB-COMP-101', account_id: 'A-1010', bank_account_id: 'BA-101', txn_date: '2026-02-20', payee: 'Kabwe High School', txn_type: 'Deposit', amount: '1500.0000', is_cleared: true, reconciliation_id: 'REC-1', journal_txn_id: 'JE-PMT-1' },
    ],
    bank_rules: [
      { id: 'BR-1', company_id: 'SB-COMP-101', name: 'ZESCO Utility Rule', match_field: 'payee', match_pattern: 'ZESCO', target_account_id: 'A-6200', priority: 10 },
    ],
    employees: [
      {
        id: 'EMP-1',
        company_id: 'SB-COMP-101',
        first_name: 'Kelvin',
        last_name: 'Mwanza',
        job_title: 'Lead Lithographer',
        hire_date: '2022-05-01',
        pay_type: 'salary',
        pay_rate: '14000.0000',
        pay_frequency: 'monthly',
        ssn_last4_masked: '***-**-9012',
        bank_accounts: [{ routing_number: '010001', account_masked: '****4421', account_kind: 'checking', split_percent: 100 }],
      },
    ],
    fixed_asset_types: [
      { id: 'FAT-1', company_id: 'SB-COMP-101', name: 'Printing Presses', asset_account_id: 'A-1500', accum_depr_account_id: 'A-1590', depreciation_method: 'straight_line', effective_life_years: 10 },
    ],
    fixed_assets: [
      { id: 'FA-1', company_id: 'SB-COMP-101', asset_type_id: 'FAT-1', asset_number: 'FA-PRESS-01', name: 'Heidelberg Speedmaster 4-Color', purchase_date: '2023-01-15', purchase_price: '120000.0000', salvage_value: '10000.0000', accumulated_depreciation: '15000.0000' },
    ],
    budgets: [
      { id: 'BDG-1', company_id: 'SB-COMP-101', account_id: 'A-4000', fiscal_year: 2026, fiscal_month: 2, amount: '25000.0000' },
    ],
    tax_category_mappings: [
      { id: 'TAX-1', company_id: 'SB-COMP-101', account_id: 'A-2200', tax_line: 'ZRA VAT Output Control' },
    ],
    saved_reports: [
      { id: 'SR-1', company_id: 'SB-COMP-101', name: 'Monthly Press P&L', report_type: 'profit_and_loss', parameters: { basis: 'accrual' } },
    ],
    documents: [
      { id: 'DOC-1', company_id: 'SB-COMP-101', original_name: 'kabwe-po-scan.pdf', content_type: 'application/pdf', size_bytes: 18420, sha256_hex: 'a'.repeat(64), storage_key: 'slowbooks/doc-1.pdf', entity_type: 'invoices', entity_id: 'INV-1' },
    ],
    audit_log: [
      { id: 'AUD-1', company_id: 'SB-COMP-101', occurred_at: '2026-02-10T09:15:00Z', actor_username: 'zl_director', action: 'INVOICE_POSTED', table_name: 'invoices', record_id: 'INV-1', new_values: { invoice_number: 'ZLP-1001', total: '4500.0000' } },
    ],
    deprecated_records: [
      { id: 'SOV-91', company_id: 'SB-COMP-101', source_table: 'sov_lines', summary: 'Legacy Construction SOV Schedule Line #91 archived during PMS consolidation', amount: '0.0000', payload: { division: '03-Concrete' } },
      { id: 'IKG-12', company_id: 'SB-COMP-101', source_table: 'in_kind_gifts', summary: 'Legacy Nonprofit In-Kind Paper Donation #12 archived', amount: '0.0000', payload: { donor: 'Book Aid' } },
    ],
  };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-phase10-mig-'));
  const bundlePath = path.join(tmpDir, 'slowbooks-source-readonly.json');
  const backupDir = path.join(tmpDir, 'backups');
  const bundle = buildTestSlowBooksBundle();
  const initialSourceHash = canonicalJsonHash(bundle);
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), { encoding: 'utf8', mode: 0o444 });
  const initialFileBytes = fs.readFileSync(bundlePath, 'utf8');

  const config = makeConfig(tmpDir);
  const db: ServerDatabase = await createServerDatabase(config, { inMemory: true, seedDemo: true });
  const app = createApiExpressApp(db);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    console.log('1) Authenticating as seeded Administrator...');
    const client = new TestHttpClient(baseUrl);
    const login = await client.request('POST', '/api/auth/login', {
      username: 'admin',
      password: 'PrintingAdmin#2026',
    });
    assert.equal(login.status, 200, `Login failed: ${JSON.stringify(login.json)}`);

    // Snapshot counts before Dry-Run
    const snapshotCounts = async () =>
      db.withSystemDb(async tx => {
        const q = async (tbl: string) => Number((await tx.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ${tbl}`)).rows[0].c);
        return {
          companies: await q('companies'),
          users: await q('users'),
          accounts: await q('accounts'),
          customers: await q('customers'),
          vendors: await q('vendors'),
          inventory_items: await q('inventory_items'),
          invoices: await q('invoices'),
          bills: await q('bills'),
          journal_transactions: await q('journal_transactions'),
        };
      });

    const beforeCounts = await snapshotCounts();

    console.log('2) Running Phase 10 Dry-Run Migration (SAVEPOINT rollback)...');
    const dryRunRes = await client.request('POST', '/api/migrations/slowbooks/dry-run', {
      sourceFilePath: bundlePath,
      backupDir,
      batchKey: 'PHASE10-DRYRUN-01',
    });
    assert.equal(dryRunRes.status, 200, `Dry-run failed: ${JSON.stringify(dryRunRes.json)}`);
    assert.equal(dryRunRes.json.mode, 'dry_run');
    assert.equal(dryRunRes.json.dryRunZeroMutationVerified, true);
    assert.equal(dryRunRes.json.companyReports.length, 2);
    assert.ok(dryRunRes.json.exceptionsPreview.length >= 6, 'Dry-run should preview all exceptions/rejections');

    // Assert zero business-table mutations after dry-run
    const afterDryRunCounts = await snapshotCounts();
    assert.deepEqual(afterDryRunCounts, beforeCounts, 'Dry-run MUST NOT mutate any live business table!');

    // Verify source & target backup artifacts exist and source file was untouched
    assert.equal(fs.readFileSync(bundlePath, 'utf8'), initialFileBytes, 'Source file must remain untouched');
    assert.equal(canonicalJsonHash(bundle), initialSourceHash, 'Source bundle hash unchanged');
    assert.ok(fs.existsSync(dryRunRes.json.sourceBackupPath), 'Source backup artifact must exist');
    assert.ok(fs.existsSync(dryRunRes.json.targetBackupPath), 'Target pre-migration backup must exist');

    console.log('3) Executing Live SlowBooks Migration (Batch 1)...');
    const execRes = await client.request('POST', '/api/migrations/slowbooks/execute', {
      sourceFilePath: bundlePath,
      backupDir,
      batchKey: 'PHASE10-LIVE-01',
    });
    assert.equal(execRes.status, 201, `Execute failed: ${JSON.stringify(execRes.json)}`);
    const batchId = Number(execRes.json.batchId);
    const reports: any[] = execRes.json.companyReports;
    assert.equal(reports.length, 2);

    const comp1Report = reports.find(r => r.sourceCompanyId === 'SB-COMP-101');
    const comp2Report = reports.find(r => r.sourceCompanyId === 'SB-COMP-202');
    assert.ok(comp1Report && comp2Report);

    const comp1Id = Number(comp1Report.companyId);
    const comp2Id = Number(comp2Report.companyId);

    // Check Trial Balance & Balance Sheet balanced on BOTH companies
    assert.equal(comp1Report.financialStatements.trialBalanceBalanced, true);
    assert.equal(comp1Report.financialStatements.balanceSheetBalanced, true);
    assert.equal(comp2Report.financialStatements.trialBalanceBalanced, true);
    assert.equal(comp2Report.financialStatements.balanceSheetBalanced, true);

    // Check 100% Entity Count Reconciliation (sourceCount === migrated + dup + archived + rejected)
    assert.equal(comp1Report.countsReconciled, true, `Comp 1 counts did not foot: ${JSON.stringify(comp1Report.entityCounts)}`);
    assert.equal(comp2Report.countsReconciled, true, `Comp 2 counts did not foot: ${JSON.stringify(comp2Report.entityCounts)}`);

    // Check Company 2 exact zero-variance match across every metric
    assert.equal(comp2Report.trialBalance.reconciled, true);
    assert.equal(comp2Report.accountsReceivable.reconciled, true);
    assert.equal(comp2Report.inventoryValuation.reconciled, true);

    // Check Company 1 discrepancies are automatically explained by quarantined corrupt rows
    assert.ok(comp1Report.discrepancies.length >= 2, 'Comp 1 should explain quarantined corrupt journal + invoice variances');
    for (const d of comp1Report.discrepancies) {
      assert.equal(d.explained, true, `Unexplained discrepancy: ${JSON.stringify(d)}`);
      assert.ok(d.relatedExceptionIds.length > 0);
    }

    // Check exact decimal preservation on 2025 closed-period rent & 2026 bill (2500.3333 & 1200.6667)
    const expRentAcct = comp1Report.accountBalances.find((a: any) => a.code === '6200');
    assert.equal(expRentAcct.targetBalance, '2500.3333');
    const apAcct = comp1Report.accountBalances.find((a: any) => a.code === '2000');
    assert.equal(apAcct.targetBalance, '1200.6667');

    // Verify closed historical fiscal period FY2025-Q4 is locked now & rejects new postings
    await db.withCompanyDb(comp1Id, async tx => {
      const fp = await tx.query<{ status: string }>(
        `SELECT status FROM fiscal_periods WHERE company_id = $1 AND period_name = 'FY2025-Q4'`,
        [comp1Id]
      );
      assert.equal(fp.rows[0].status, 'closed', 'Historical closed period must be re-locked after loading its historical journals');
    });

    console.log('4) Verifying Repeatable Idempotent Re-Execution...');
    const rerunRes = await client.request('POST', '/api/migrations/slowbooks/execute', {
      sourceFilePath: bundlePath,
      backupDir,
      batchKey: 'PHASE10-RERUN-02',
    });
    assert.equal(rerunRes.status, 201);
    const rerunComp1 = rerunRes.json.companyReports.find((r: any) => r.sourceCompanyId === 'SB-COMP-101');
    assert.equal(rerunComp1.companyId, comp1Id, 'Idempotent rerun must reuse exact migrated company ID');
    assert.equal(rerunComp1.trialBalance.targetDebit, comp1Report.trialBalance.targetDebit, 'Rerun must not double-post journals');

    console.log('5) Verifying Cutover Sign-Off Blocks While Open Rejected Exceptions Exist...');
    const blockedSignOff = await client.request('POST', `/api/migrations/slowbooks/batches/${batchId}/sign-off`, {
      sourceFilePath: bundlePath,
    });
    assert.equal(blockedSignOff.status, 409, 'Sign-off MUST block while rejected exceptions remain open');
    assert.equal(blockedSignOff.json.code, 'CUTOVER_RECONCILIATION_BLOCKED');

    console.log('6) Switching Company & Resolving Rejected Exceptions + Testing Multi-Company Isolation...');
    const sw1 = await client.request('POST', '/api/auth/switch-company', { companyId: comp1Id });
    assert.equal(sw1.status, 200);

    // Fetch Company 1 exceptions via company-isolated endpoint
    const excs1 = await client.request('GET', `/api/migrations/slowbooks/batches/${batchId}/exceptions`);
    assert.equal(excs1.status, 200);
    const openRej1 = (excs1.json.exceptions as any[]).filter(
      e => e.disposition === 'rejected' && e.resolution_status === 'open'
    );
    assert.equal(openRej1.length, 4, 'Expected 4 open rejected exceptions in Company 1 (bad item, bad JE, raw_material invoice, bad bill date)');

    for (const ex of openRej1) {
      const r = await client.request('POST', `/api/migrations/slowbooks/exceptions/${ex.id}/resolve`, {
        status: 'accepted',
        note: `Verified quarantine & variance explanation for ${ex.source_entity}:${ex.source_id}`,
      });
      assert.equal(r.status, 200);
    }

    // Verify source-reference traceability & cross-company isolation
    const comp1Invoices = await client.request('GET', '/api/invoices');
    assert.equal(comp1Invoices.status, 200);
    const zlpInv = (comp1Invoices.json.invoices as any[]).find(i => i.invoice_number === 'ZLP-1001');
    assert.ok(zlpInv, 'ZLP-1001 must be visible in Company 1');

    const srcRef1 = await client.request('GET', `/api/migrations/slowbooks/source-reference/invoices/${zlpInv.id}`);
    assert.equal(srcRef1.status, 200);
    assert.equal(srcRef1.json.references[0].source_id, 'INV-1');

    // Cross-company parameter tampering attempt -> 403
    const crossParamAttempt = await client.request('GET', `/api/invoices?companyId=${comp2Id}`);
    assert.equal(crossParamAttempt.status, 403);

    // Switch to Company 2 and verify Company 1's invoice is completely invisible
    const sw2 = await client.request('POST', '/api/auth/switch-company', { companyId: comp2Id });
    assert.equal(sw2.status, 200);
    const comp2Invoices = await client.request('GET', '/api/invoices');
    assert.equal(comp2Invoices.status, 200);
    assert.equal((comp2Invoices.json.invoices as any[]).some(i => i.invoice_number === 'ZLP-1001'), false);
    const kplInv = (comp2Invoices.json.invoices as any[]).find(i => i.invoice_number === 'KPL-5001');
    assert.ok(kplInv, 'KPL-5001 must be visible in Company 2');

    // Attempting to look up Company 1 invoice source reference while in Company 2 returns empty under RLS
    const crossRefAttempt = await client.request('GET', `/api/migrations/slowbooks/source-reference/invoices/${zlpInv.id}`);
    assert.equal(crossRefAttempt.status, 200);
    assert.equal(crossRefAttempt.json.references.length, 0);

    console.log('7) Completing Production Cutover Sign-Off...');
    const signedOff = await client.request('POST', `/api/migrations/slowbooks/batches/${batchId}/sign-off`, {
      sourceFilePath: bundlePath,
      signOffNotes: 'Phase 10 SlowBooks-Pro-2026 financial & entity-count reconciliation signed off for cutover.',
    });
    assert.equal(signedOff.status, 200, `Sign-off failed: ${JSON.stringify(signedOff.json)}`);
    assert.equal(signedOff.json.cutoverApproved, true);

    console.log('8) Testing Controlled Migration Rollback & Recovery on Isolated Batch...');
    const rollbackBundle: SlowBooksSourceBundle = {
      sourceSystem: 'SlowBooks-Pro-2026',
      companies: [{ id: 'SB-RB-999', slug: 'rollback-test-co', name: 'Rollback Test Co', base_currency: 'ZMW', currency_symbol: 'K' }],
      users: [],
      accounts: [
        { id: 'RB-1010', company_id: 'SB-RB-999', code: '1010', name: 'Bank', account_type: 'Bank', bank_kind: 'bank' },
        { id: 'RB-3000', company_id: 'SB-RB-999', code: '3000', name: 'Equity', account_type: 'Equity' },
      ],
      opening_balances: [
        {
          id: 'RB-OB-1',
          company_id: 'SB-RB-999',
          txn_date: '2026-06-01',
          lines: [
            { account_id: 'RB-1010', debit: '12000.0000', credit: '0.0000' },
            { account_id: 'RB-3000', debit: '0.0000', credit: '12000.0000' },
          ],
        },
      ],
    };
    // Switch back to seeded demo company 1 before calling execute/rollback
    await client.request('POST', '/api/auth/switch-company', { companyId: 1 });
    const rbExec = await client.request('POST', '/api/migrations/slowbooks/execute', {
      bundle: rollbackBundle,
      backupDir,
      batchKey: 'PHASE10-ROLLBACK-TEST',
    });
    assert.equal(rbExec.status, 201);
    const rbBatchId = Number(rbExec.json.batchId);
    const rbCompanyId = Number(rbExec.json.companyReports[0].companyId);

    const rbResult = await client.request('POST', `/api/migrations/slowbooks/batches/${rbBatchId}/rollback`, {
      reason: 'Automated Phase 10 rollback verification test',
    });
    assert.equal(rbResult.status, 200);
    assert.equal(rbResult.json.status, 'rolled_back');

    await db.withSystemDb(async tx => {
      const c = await tx.query<{ is_active: boolean }>(`SELECT is_active FROM companies WHERE id = $1`, [rbCompanyId]);
      assert.equal(c.rows[0].is_active, false, 'Rolled-back company must be deactivated');
      const accts = await tx.query<{ balance: string }>(`SELECT balance::text FROM accounts WHERE company_id = $1`, [rbCompanyId]);
      for (const a of accts.rows) {
        assert.equal(a.balance, '0.0000', 'All account balances must reverse to 0.0000 on rollback');
      }
    });

    console.log('9) Generating Phase 10 Reconciliation Report Artifact...');
    const finalReportRes = await client.request('GET', `/api/migrations/slowbooks/batches/${batchId}`);
    assert.equal(finalReportRes.status, 200);
    const b = finalReportRes.json.batch;
    const md = buildReconciliationMarkdownReport({
      batchKey: b.batch_key,
      sourceSystem: b.source_system,
      sourceSha256: b.source_sha256,
      sourceBackupPath: b.source_backup_path,
      sourceBackupSha256: b.source_backup_sha256,
      targetBackupPath: b.target_backup_path,
      targetBackupSha256: b.target_backup_sha256,
      cutoverApproved: Boolean(b.cutover_approved),
      signedOffBy: 'admin',
      signedOffAt: b.signed_off_at,
      signOffNotes: b.sign_off_notes,
      companyReports: signedOff.json.companyReports,
      isolationVerified: true,
      rollbackVerified: true,
      dryRunVerified: true,
    });
    const reportOutPath = path.resolve(process.cwd(), 'docs/migration/phase10-migration-reconciliation-report.md');
    fs.mkdirSync(path.dirname(reportOutPath), { recursive: true });
    fs.writeFileSync(reportOutPath, md, 'utf8');

    console.log('ALL PHASE 10 SLOWBOOKS MIGRATION & FINANCIAL RECONCILIATION TESTS PASSED!');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('Phase 10 test failed:', err);
  process.exit(1);
});
