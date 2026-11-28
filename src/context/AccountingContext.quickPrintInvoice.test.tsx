import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Quick-print invoice creation must not report success when the server invoice
 * was not created, and a retry must not create a duplicate invoice.
 */

vi.mock('../services/accountingApi', () => ({
  ACCOUNTING_UPDATED_EVENT: 'accounting-updated',
  accountingApi: { listAccounts: vi.fn(), listJournals: vi.fn() },
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
    createInvoice: vi.fn(),
  },
}));
vi.mock('../services/printingApi', () => ({
  printingApi: {
    listContracts: vi.fn(),
    listExamPapers: vi.fn(),
    listQuickPrintJobs: vi.fn(),
    postQuickSale: vi.fn(),
  },
}));
vi.mock('../services/payrollApi', () => ({
  payrollApi: { listEmployees: vi.fn(), listRuns: vi.fn() },
}));
vi.mock('../services/documentsApi', () => ({
  documentsApi: { generateWorkflowInvoice: vi.fn() },
}));

import { AccountingProvider, useAccounting } from './AccountingContext';
import { accountingApi } from '../services/accountingApi';
import { commercialApi } from '../services/commercialApi';
import { printingApi } from '../services/printingApi';
import { payrollApi } from '../services/payrollApi';
import { documentsApi } from '../services/documentsApi';

const api = {
  accountingApi: accountingApi as any,
  commercialApi: commercialApi as any,
  printingApi: printingApi as any,
  payrollApi: payrollApi as any,
  documentsApi: documentsApi as any,
};

const jobData = {
  customerId: 'cust-1',
  customerName: 'Acme School',
  jobType: 'photocopy' as const,
  title: 'Exam pack',
  pages: 10,
  copies: 2,
  printSide: 'Single-Sided' as const,
  sellingPricePerSheet: 1,
  sellingPriceTotal: 20,
  date: '2026-06-01',
};

let outcome: { job?: any; error?: any };
let jobCount = 0;
// The caller (QuickPrintView) owns the idempotency key and reuses it across a
// retry; the probe mirrors that by passing a stable key on every click.
const IDEM_KEY = 'qp-probe-fixed-key';

const Probe: React.FC = () => {
  const { addQuickPrintJob, quickPrintJobs } = useAccounting();
  jobCount = quickPrintJobs.length;
  return (
    <button
      type="button"
      onClick={async () => {
        outcome = {};
        try {
          outcome.job = await addQuickPrintJob(jobData as any, { createInvoice: true, idempotencyKey: IDEM_KEY });
        } catch (err) {
          outcome.error = err;
        }
      }}
    >
      post-job
    </button>
  );
};

const stubEmptyLists = () => {
  api.accountingApi.listAccounts.mockResolvedValue([]);
  api.accountingApi.listJournals.mockResolvedValue([]);
  api.commercialApi.listCustomers.mockResolvedValue([
    { id: 'cust-1', name: 'Acme School', companyName: 'Acme School', balance: 0, terms: 'Net 30' },
  ]);
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
  api.commercialApi.createInvoice.mockResolvedValue({ id: 9, invoiceNumber: 'INV-0009' });
};

beforeEach(() => {
  outcome = {};
  // Vitest 4 no longer clears call history for vi.fn() created inside vi.mock
  // factories between tests, so reset explicitly to keep per-test counts honest.
  api.printingApi.postQuickSale.mockReset();
  stubEmptyLists();
});

describe('addQuickPrintJob invoice creation', () => {
  it('10. posts the job and links the server invoice on success', async () => {
    api.printingApi.postQuickSale.mockResolvedValue({
      mode: 'on_account',
      job: {
        id: 7,
        jobNumber: 'JOB-0007',
        jobType: 'photocopy',
        title: 'Exam pack',
        pages: 10,
        copies: 2,
        printSide: 'Single-Sided',
        customerId: 1,
        customerName: 'Acme School',
        jobDate: '2026-06-01',
        sheetsUsed: 20,
        impressionsUsed: 20,
        paperCost: 0.2,
        tonerCost: 0.02,
        totalCost: 0.22,
        manualSellingPrice: 20,
        profit: 19.78,
      },
      invoice: { id: 5, invoiceNumber: 'INV-0005', total: '20.00' },
      wipJournalTxnId: 1,
      idempotentReplay: false,
    });
    render(
      <AccountingProvider>
        <Probe />
      </AccountingProvider>
    );
    fireEvent.click(screen.getByText('post-job'));

    // Success is reported only after the server-authoritative request resolves.
    await waitFor(() => expect(outcome.job).toBeDefined());
    expect(outcome.error).toBeUndefined();
    expect(outcome.job.backendInvoiceId).toBe(5);
    expect(outcome.job.linkedInvoiceNumber).toBe('INV-0005');
    expect(jobCount).toBe(1);
    expect(api.printingApi.postQuickSale).toHaveBeenCalledTimes(1);
  });

  it('11. does not report success when the server-authoritative request fails', async () => {
    api.printingApi.postQuickSale.mockRejectedValue(new Error('503 service unavailable'));
    render(
      <AccountingProvider>
        <Probe />
      </AccountingProvider>
    );
    fireEvent.click(screen.getByText('post-job'));

    // A failed request must surface the error and never look successful.
    await waitFor(() => expect(outcome.error).toBeDefined());
    expect(String(outcome.error.message)).toMatch(/503 service unavailable/i);
    expect(outcome.job).toBeUndefined();
    expect(jobCount).toBe(0);
  });

  it('12. a retry reuses the same idempotency key so no duplicate sale is created', async () => {
    api.printingApi.postQuickSale.mockRejectedValueOnce(new Error('offline'));
    render(
      <AccountingProvider>
        <Probe />
      </AccountingProvider>
    );

    fireEvent.click(screen.getByText('post-job'));
    await waitFor(() => expect(outcome.error).toBeDefined());

    api.printingApi.postQuickSale.mockResolvedValue({
      mode: 'on_account',
      job: {
        id: 8,
        jobNumber: 'JOB-0008',
        jobType: 'photocopy',
        title: 'Exam pack',
        pages: 10,
        copies: 2,
        printSide: 'Single-Sided',
        customerId: 1,
        customerName: 'Acme School',
        jobDate: '2026-06-01',
        sheetsUsed: 20,
        impressionsUsed: 20,
        paperCost: 0.2,
        tonerCost: 0.02,
        totalCost: 0.22,
        manualSellingPrice: 20,
        profit: 19.78,
      },
      invoice: { id: 6, invoiceNumber: 'INV-0006', total: '20.00' },
      wipJournalTxnId: 2,
      idempotentReplay: false,
    });
    fireEvent.click(screen.getByText('post-job'));
    await waitFor(() => expect(outcome.job).toBeDefined());

    expect(api.printingApi.postQuickSale).toHaveBeenCalledTimes(2);
    const keys = api.printingApi.postQuickSale.mock.calls.map(
      (call: any[]) => call[0].idempotencyKey
    );
    expect(keys[0]).toBe(IDEM_KEY);
    expect(keys[1]).toBe(keys[0]);
    expect(jobCount).toBe(1);
  });
});