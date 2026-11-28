import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Financial data trust tests.
 *
 * These lock in the Stage 1 rule: the ERP must never present unavailable,
 * failed or stale backend financial data as successfully loaded current data,
 * and must never substitute bundled demo rows for a failed request.
 */

vi.mock('../services/accountingApi', () => ({
  ACCOUNTING_UPDATED_EVENT: 'accounting-updated',
  accountingApi: {
    listAccounts: vi.fn(),
    listJournals: vi.fn(),
  },
}));

vi.mock('../services/commercialApi', () => ({
  commercialApi: {
    listCustomers: vi.fn(),
    listVendors: vi.fn(),
    listInventory: vi.fn(),
    listInvoices: vi.fn(),
    listBills: vi.fn(),
    listBankTransactions: vi.fn(),
    listReconciliations: vi.fn(),
  },
}));

vi.mock('../services/printingApi', () => ({
  printingApi: {
    listContracts: vi.fn(),
    listExamPapers: vi.fn(),
    listQuickPrintJobs: vi.fn(),
  },
}));

vi.mock('../services/payrollApi', () => ({
  payrollApi: {
    listEmployees: vi.fn(),
    listRuns: vi.fn(),
  },
}));

import { AccountingProvider, useAccounting } from './AccountingContext';
import { INITIAL_COMPANY_PROFILE } from '../data/initialDemoData';
import { accountingApi } from '../services/accountingApi';
import { commercialApi } from '../services/commercialApi';
import { printingApi } from '../services/printingApi';
import { payrollApi } from '../services/payrollApi';

const api = {
  accountingApi: accountingApi as any,
  commercialApi: commercialApi as any,
  printingApi: printingApi as any,
  payrollApi: payrollApi as any,
};

/** A server invoice row in the shape `mapApiInvoiceToInvoice` consumes. */
const invoiceRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  invoiceNumber: 'INV-0001',
  customerId: 7,
  customerName: 'Acme School',
  date: '2026-06-01',
  dueDate: '2026-06-30',
  status: 'issued',
  subtotalNum: 100,
  taxAmountNum: 16,
  totalNum: 116,
  amountPaidNum: 0,
  balanceDueNum: 116,
  lines: [],
  ...over,
});

/** A server account row with a genuine zero balance. */
const accountRow = (over: Record<string, unknown> = {}) => ({
  id: 10,
  code: '1000',
  name: 'Cash on Hand',
  account_type: 'Bank',
  description: null,
  parent_id: null,
  balanceNum: 0,
  is_system: false,
  ...over,
});

const Probe: React.FC = () => {
  const {
    invoices,
    accounts,
    financialData,
    refreshFinancialData,
    companyProfile,
  } = useAccounting();
  const invoiceState = financialData.invoices;
  const accountState = financialData.accounts;
  return (
    <div>
      <span data-testid="invoice-count">{invoices.length}</span>
      <span data-testid="invoice-number">{invoices[0]?.invoiceNumber ?? 'none'}</span>
      <span data-testid="account-count">{accounts.length}</span>
      <span data-testid="account-balance">{accounts[0]?.balance ?? 'none'}</span>
      <span data-testid="status">{invoiceState.status}</span>
      <span data-testid="refreshing">{String(invoiceState.refreshing)}</span>
      <span data-testid="stale">{String(invoiceState.stale)}</span>
      <span data-testid="loaded-at">{invoiceState.loadedAt ?? 'null'}</span>
      <span data-testid="error">{invoiceState.error ?? 'null'}</span>
      <span data-testid="account-status">{accountState.status}</span>
      <span data-testid="company">{companyProfile.name}</span>
      <button type="button" onClick={() => refreshFinancialData('invoices')}>
        retry-invoices
      </button>
      <button type="button" onClick={() => refreshFinancialData()}>
        retry-all
      </button>
    </div>
  );
};

const renderProbe = () =>
  render(
    <AccountingProvider>
      <Probe />
    </AccountingProvider>
  );

/** Make every backend call succeed with an empty list by default. */
const stubAllEmpty = () => {
  api.accountingApi.listAccounts.mockResolvedValue([]);
  api.accountingApi.listJournals.mockResolvedValue([]);
  api.commercialApi.listCustomers.mockResolvedValue([]);
  api.commercialApi.listVendors.mockResolvedValue([]);
  api.commercialApi.listInventory.mockResolvedValue([]);
  api.commercialApi.listInvoices.mockResolvedValue([]);
  api.commercialApi.listBills.mockResolvedValue([]);
  api.commercialApi.listBankTransactions.mockResolvedValue([]);
  api.commercialApi.listReconciliations.mockResolvedValue([]);
  api.printingApi.listContracts.mockResolvedValue([]);
  api.printingApi.listExamPapers.mockResolvedValue([]);
  api.printingApi.listQuickPrintJobs.mockResolvedValue([]);
  api.payrollApi.listEmployees.mockResolvedValue([]);
  api.payrollApi.listRuns.mockResolvedValue([]);
};

beforeEach(() => {
  stubAllEmpty();
});

describe('financial data load states', () => {
  it('1. displays the rows returned by a successful backend load', async () => {
    api.commercialApi.listInvoices.mockResolvedValue([invoiceRow()]);
    renderProbe();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('invoice-count')).toHaveTextContent('1');
    expect(screen.getByTestId('invoice-number')).toHaveTextContent('INV-0001');
    expect(screen.getByTestId('loaded-at')).not.toHaveTextContent('null');
    expect(screen.getByTestId('error')).toHaveTextContent('null');
    expect(screen.getByTestId('stale')).toHaveTextContent('false');
  });

  it('2. does not expose bundled demo financial data when the initial load fails', async () => {
    api.commercialApi.listInvoices.mockRejectedValue(new Error('network down'));
    api.accountingApi.listAccounts.mockRejectedValue(new Error('network down'));
    renderProbe();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    // No demo invoice rows and no demo chart of accounts are substituted.
    expect(screen.getByTestId('invoice-count')).toHaveTextContent('0');
    expect(screen.getByTestId('account-count')).toHaveTextContent('0');
    expect(screen.getByTestId('invoice-number')).toHaveTextContent('none');
    expect(screen.getByTestId('loaded-at')).toHaveTextContent('null');
    expect(screen.getByTestId('stale')).toHaveTextContent('false');
    expect(screen.getByTestId('error')).toHaveTextContent('network down');
  });

  it('3. a failed refresh never reports success and records the error', async () => {
    api.commercialApi.listInvoices.mockResolvedValue([invoiceRow()]);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));

    api.commercialApi.listInvoices.mockRejectedValue(new Error('503'));
    fireEvent.click(screen.getByText('retry-invoices'));

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('503'));
    // The domain is not "ready with fresh data": it is stale.
    expect(screen.getByTestId('stale')).toHaveTextContent('true');
    expect(screen.getByTestId('refreshing')).toHaveTextContent('false');
  });

  it('4. retains real rows after a failed refresh but marks them stale', async () => {
    api.commercialApi.listInvoices.mockResolvedValue([invoiceRow()]);
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('invoice-count')).toHaveTextContent('1'));

    api.commercialApi.listInvoices.mockRejectedValue(new Error('timeout'));
    fireEvent.click(screen.getByText('retry-invoices'));

    await waitFor(() => expect(screen.getByTestId('stale')).toHaveTextContent('true'));
    // Continuity is preserved, but the rows are explicitly flagged stale.
    expect(screen.getByTestId('invoice-count')).toHaveTextContent('1');
    expect(screen.getByTestId('invoice-number')).toHaveTextContent('INV-0001');
    expect(screen.getByTestId('loaded-at')).not.toHaveTextContent('null');
  });

  it('5. keeps a genuine zero balance distinguishable from unavailable data', async () => {
    api.accountingApi.listAccounts.mockResolvedValue([accountRow({ balanceNum: 0 })]);
    renderProbe();

    await waitFor(() => expect(screen.getByTestId('account-status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('account-count')).toHaveTextContent('1');
    expect(screen.getByTestId('account-balance')).toHaveTextContent('0');
  });

  it('6. distinguishes an empty successful response from a failed request', async () => {
    api.commercialApi.listInvoices.mockResolvedValue([]);
    renderProbe();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('invoice-count')).toHaveTextContent('0');
    expect(screen.getByTestId('error')).toHaveTextContent('null');
    expect(screen.getByTestId('loaded-at')).not.toHaveTextContent('null');
  });

  it('7. a retry after failure loads the current server data', async () => {
    api.commercialApi.listInvoices.mockRejectedValueOnce(new Error('offline'));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));

    api.commercialApi.listInvoices.mockResolvedValue([invoiceRow({ id: 2, invoiceNumber: 'INV-0002' })]);
    fireEvent.click(screen.getByText('retry-invoices'));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(screen.getByTestId('invoice-number')).toHaveTextContent('INV-0002');
    expect(screen.getByTestId('stale')).toHaveTextContent('false');
    expect(screen.getByTestId('error')).toHaveTextContent('null');
  });

  it('8. repeated retry failures preserve the error state', async () => {
    api.commercialApi.listInvoices.mockRejectedValue(new Error('still down'));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));

    fireEvent.click(screen.getByText('retry-invoices'));
    await waitFor(() => expect(screen.getByTestId('refreshing')).toHaveTextContent('false'));
    expect(screen.getByTestId('status')).toHaveTextContent('error');
    expect(screen.getByTestId('error')).toHaveTextContent('still down');
    expect(screen.getByTestId('invoice-count')).toHaveTextContent('0');
    expect(screen.getByTestId('loaded-at')).toHaveTextContent('null');
  });

  it('9. exposes no rows to derive totals from when the load failed', async () => {
    api.commercialApi.listInvoices.mockRejectedValue(new Error('unauthorized'));
    renderProbe();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    // A consumer summing `invoices` would compute 0 from an empty list, but the
    // domain state tells it the figure is unavailable rather than a real zero.
    expect(screen.getByTestId('invoice-count')).toHaveTextContent('0');
    expect(screen.getByTestId('status')).toHaveTextContent('error');
    expect(screen.getByTestId('loaded-at')).toHaveTextContent('null');
  });

  it('10. preserves the authenticated company context across a failed load', async () => {
    api.commercialApi.listInvoices.mockRejectedValue(new Error('server error'));
    renderProbe();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    // The authenticated company profile is untouched by the failed load: no
    // fallback company, tenant or profile is substituted.
    expect(screen.getByTestId('company')).toHaveTextContent(INITIAL_COMPANY_PROFILE.name);
  });

  it('retries every domain when no domain is specified', async () => {
    api.commercialApi.listInvoices.mockRejectedValueOnce(new Error('down'));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));

    api.commercialApi.listInvoices.mockResolvedValue([invoiceRow()]);
    const callsBefore = api.commercialApi.listVendors.mock.calls.length;
    fireEvent.click(screen.getByText('retry-all'));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(api.commercialApi.listVendors.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});