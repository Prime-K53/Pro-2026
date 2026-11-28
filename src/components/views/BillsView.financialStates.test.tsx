import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * BillsView shows an A/P KPI strip derived from the purchasing load. Those
 * figures must never appear as K0/0 while loading or after a failed load.
 */

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => ({
    companyProfile: { name: 'Prime', currency: 'K' },
    triggerShortcutNotice: vi.fn(),
  }),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    activeCompany: { id: 1, name: 'Prime' },
    hasPermission: () => true,
    authenticated: true,
    permissions: ['bills:read'],
  }),
}));

vi.mock('../../services/accountingApi', () => ({
  ACCOUNTING_UPDATED_EVENT: 'accounting-updated',
  accountingApi: { listAccounts: vi.fn() },
}));

vi.mock('../../services/commercialApi', () => ({
  commercialApi: {
    listBills: vi.fn(),
    listPurchaseOrders: vi.fn(),
    listBillPayments: vi.fn(),
    listVendorCredits: vi.fn(),
    listVendors: vi.fn(),
    listInventory: vi.fn(),
    listRequisitions: vi.fn(),
    listGoodsReceipts: vi.fn(),
  },
}));

vi.mock('../../services/printingApi', () => ({
  printingApi: { listJobs: vi.fn() },
}));

vi.mock('../../hooks/useFxRates', () => ({
  useFxRates: () => ({ options: [], baseCurrency: 'K', rateFor: () => 1 }),
}));

import { BillsView } from './BillsView';
import { accountingApi } from '../../services/accountingApi';
import { commercialApi } from '../../services/commercialApi';
import { printingApi } from '../../services/printingApi';

const api = {
  accountingApi: accountingApi as any,
  commercialApi: commercialApi as any,
  printingApi: printingApi as any,
};

const KPI_LABEL = 'Total Outstanding A/P';

const stubAll = () => {
  api.accountingApi.listAccounts.mockResolvedValue([]);
  api.commercialApi.listPurchaseOrders.mockResolvedValue([]);
  api.commercialApi.listBillPayments.mockResolvedValue([]);
  api.commercialApi.listVendorCredits.mockResolvedValue([]);
  api.commercialApi.listVendors.mockResolvedValue([]);
  api.commercialApi.listInventory.mockResolvedValue([]);
  api.commercialApi.listRequisitions.mockResolvedValue([]);
  api.commercialApi.listGoodsReceipts.mockResolvedValue([]);
  api.printingApi.listJobs.mockResolvedValue([]);
};

beforeEach(() => {
  stubAll();
});

describe('BillsView A/P KPI states', () => {
  it('1. shows a loading notice and no KPI totals while loading', () => {
    api.commercialApi.listBills.mockReturnValue(new Promise(() => {}));
    render(<BillsView />);
    expect(screen.getByText(/Loading purchasing data/i)).toBeInTheDocument();
    expect(screen.queryByText(KPI_LABEL)).not.toBeInTheDocument();
  });

  it('2. shows no derived A/P total when the initial load failed', async () => {
    api.commercialApi.listBills.mockRejectedValue(new Error('ledger unavailable'));
    render(<BillsView />);
    await waitFor(() =>
      expect(screen.getByText(/purchasing data unavailable/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(KPI_LABEL)).not.toBeInTheDocument();
  });

  it('4. shows a genuine empty state (K0) when the server returns no bills', async () => {
    api.commercialApi.listBills.mockResolvedValue([]);
    render(<BillsView />);
    await waitFor(() => expect(screen.getByText(KPI_LABEL)).toBeInTheDocument());
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });

  it('6. marks retained KPI figures as stale after a failed refresh', async () => {
    api.commercialApi.listBills.mockResolvedValue([]);
    // Real rows are held, so a failed refresh must mark them stale rather than
    // pretending the (empty) result is unavailable.
    api.commercialApi.listVendors.mockResolvedValue([{ id: 'v1', name: 'Acme Supplies' }]);
    render(<BillsView />);
    await waitFor(() => expect(screen.getByText(KPI_LABEL)).toBeInTheDocument());

    api.commercialApi.listBills.mockRejectedValue(new Error('timeout'));
    fireEvent(window, new Event('accounting-updated'));

    await waitFor(() => expect(screen.getByText(/stale purchasing data/i)).toBeInTheDocument());
    // Retained figures stay visible but are explicitly flagged.
    expect(screen.getByText(KPI_LABEL)).toBeInTheDocument();
  });

  it('8. retry after a failure restores the KPI figures', async () => {
    api.commercialApi.listBills.mockRejectedValueOnce(new Error('down'));
    render(<BillsView />);
    await waitFor(() => expect(screen.getByText(/purchasing data unavailable/i)).toBeInTheDocument());
    expect(screen.queryByText(KPI_LABEL)).not.toBeInTheDocument();

    api.commercialApi.listBills.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByText(KPI_LABEL)).toBeInTheDocument());
  });
});