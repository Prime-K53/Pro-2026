import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => ({
    isNewInvoiceOpen: true,
    setIsNewInvoiceOpen: vi.fn(),
    setIsNewCustomerOpen: vi.fn(),
    companyProfile: { currency: 'ZMW', salesTaxRate: 0.16 },
    triggerShortcutNotice: vi.fn(),
  }),
}));

const fx = vi.hoisted(() => ({ baseCurrency: 'ZMW', rateFor: (_code: string): number | null => 1 }));

vi.mock('../../hooks/useFxRates', () => ({
  useFxRates: () => ({ baseCurrency: fx.baseCurrency, rateFor: fx.rateFor, options: [], loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock('../../services/commercialApi', () => ({
  commercialApi: {
    listCustomers: vi.fn(),
    listInventory: vi.fn(),
    getCustomerCreditProfile: vi.fn(),
    createInvoice: vi.fn(),
  },
}));

vi.mock('../../services/accountingApi', () => ({
  accountingApi: { listAccounts: vi.fn() },
}));

vi.mock('../../services/printingApi', () => ({
  printingApi: { postQuickPrintJob: vi.fn(), linkJobInvoice: vi.fn() },
}));

vi.mock('../../services/v2Api', () => ({
  aiApi: { chat: vi.fn(), proposeInvoice: vi.fn(), setActionStatus: vi.fn(), executeAction: vi.fn() },
}));

vi.mock('./QuickPrintJobModal', () => ({ QuickPrintJobModal: () => null }));

import { NewInvoiceModal } from './NewInvoiceModal';
import { commercialApi } from '../../services/commercialApi';
import { accountingApi } from '../../services/accountingApi';
import { aiApi } from '../../services/v2Api';

const customer = (over: Record<string, unknown> = {}) => ({
  id: 1,
  companyName: 'Acme',
  email: 'a@acme.test',
  currencyCode: 'ZMW',
  balance: 0,
  isTaxExempt: false,
  taxExemptionValid: true,
  taxExemptionExpiry: null,
  ...over,
});

const item = { id: 10, name: 'A4 Paper', sales_price: 50, item_type: 'stationery', unit_cost: 20 };

async function openAndLoad() {
  render(<NewInvoiceModal />);
  await waitFor(() => expect(screen.queryByText('Loading customers & items…')).not.toBeInTheDocument());
}

async function addItem() {
  fireEvent.change(screen.getByLabelText('Item'), { target: { value: 'A4' } });
  fireEvent.mouseDown(await screen.findByText('A4 Paper'));
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.baseCurrency = 'ZMW';
  fx.rateFor = () => 1;
  (commercialApi.listCustomers as any).mockResolvedValue([customer()]);
  (commercialApi.listInventory as any).mockResolvedValue([item]);
  (accountingApi.listAccounts as any).mockResolvedValue([{ id: 5, account_type: 'Bank', is_active: true }]);
  (commercialApi.getCustomerCreditProfile as any).mockResolvedValue({
    creditLimit: null,
    availableCredit: null,
    exposure: 0,
    overLimit: false,
    creditHold: false,
  });
});

describe('NewInvoiceModal', () => {
  it('tax-exempt customer: zero tax in preview and isTaxExempt:true in payload', async () => {
    (commercialApi.listCustomers as any).mockResolvedValue([customer({ isTaxExempt: true })]);
    (commercialApi.createInvoice as any).mockResolvedValue({ id: 1, invoiceNumber: 'INV-1', total: 50 });
    await openAndLoad();
    await addItem();

    expect(screen.getByText('Tax exempt')).toBeInTheDocument();
    expect(screen.getByText('Sales Tax (0%)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save & Finalise' }));
    await waitFor(() => expect(commercialApi.createInvoice).toHaveBeenCalledTimes(1));
    const payload = (commercialApi.createInvoice as any).mock.calls[0][0];
    expect(payload.isTaxExempt).toBe(true);
    expect(payload.lines[0].taxable).toBe(false);
  });

  it('idempotency key: stable across retry, changed after confirmed success', async () => {
    (commercialApi.createInvoice as any)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ id: 1, invoiceNumber: 'INV-1', total: 50 });
    await openAndLoad();
    await addItem();

    fireEvent.click(screen.getByRole('button', { name: 'Save & Finalise' }));
    await waitFor(() => expect(commercialApi.createInvoice).toHaveBeenCalledTimes(1));
    const firstKey = (commercialApi.createInvoice as any).mock.calls[0][0].idempotencyKey;
    expect(firstKey).toBeTruthy();

    // Retry after failure reuses the same key.
    fireEvent.click(screen.getByRole('button', { name: 'Save & Finalise' }));
    await waitFor(() => expect(commercialApi.createInvoice).toHaveBeenCalledTimes(2));
    const retryKey = (commercialApi.createInvoice as any).mock.calls[1][0].idempotencyKey;
    expect(retryKey).toBe(firstKey);

    // A subsequent new attempt rotates the key.
    fireEvent.click(screen.getByRole('button', { name: 'Save & Finalise' }));
    await waitFor(() => expect(commercialApi.createInvoice).toHaveBeenCalledTimes(3));
    const nextKey = (commercialApi.createInvoice as any).mock.calls[2][0].idempotencyKey;
    expect(nextKey).not.toBe(firstKey);
  });

  it('AI Apply draft populates lines and never calls executeAction', async () => {
    (aiApi.proposeInvoice as any).mockResolvedValue({
      action: { id: 7 },
      preview: [{ description: '500 A4 flyers', quantity: 500, rate: 1.5, taxable: true }],
    });
    await openAndLoad();

    fireEvent.click(screen.getByRole('button', { name: 'AI Invoice' }));
    fireEvent.change(screen.getByLabelText('Describe the invoice'), { target: { value: '500 flyers' } });
    fireEvent.click(screen.getByRole('button', { name: 'AI draft' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Apply draft to form' }));

    expect(await screen.findByDisplayValue('500 A4 flyers')).toBeInTheDocument();
    expect(aiApi.executeAction).not.toHaveBeenCalled();
    expect(aiApi.setActionStatus).not.toHaveBeenCalled();
  });

  it('AI draft over existing lines: Cancel and Replace behave correctly', async () => {
    (aiApi.proposeInvoice as any).mockResolvedValue({
      action: { id: 7 },
      preview: [{ description: 'AI line', quantity: 2, rate: 10, taxable: true }],
    });
    await openAndLoad();
    await addItem();

    fireEvent.click(screen.getByRole('button', { name: 'AI Invoice' }));
    fireEvent.change(screen.getByLabelText('Describe the invoice'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'AI draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply draft to form' }));

    // Confirmation panel appears with three choices.
    expect(await screen.findByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Append' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Cancel' }).length).toBeGreaterThan(0);

    // Cancel keeps the existing line only.
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
    expect(screen.getByDisplayValue('A4 Paper')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('AI line')).not.toBeInTheDocument();

    // Replace swaps to the AI line only.
    fireEvent.click(screen.getByRole('button', { name: 'Apply draft to form' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    expect(screen.queryByDisplayValue('A4 Paper')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('AI line')).toBeInTheDocument();
  });

  it('AI draft over existing lines: Append keeps both', async () => {
    (aiApi.proposeInvoice as any).mockResolvedValue({
      action: { id: 7 },
      preview: [{ description: 'AI line', quantity: 2, rate: 10, taxable: true }],
    });
    await openAndLoad();
    await addItem();

    fireEvent.click(screen.getByRole('button', { name: 'AI Invoice' }));
    fireEvent.change(screen.getByLabelText('Describe the invoice'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'AI draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply draft to form' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Append' }));

    expect(screen.getByDisplayValue('A4 Paper')).toBeInTheDocument();
    expect(screen.getByDisplayValue('AI line')).toBeInTheDocument();
  });

  it('foreign currency without a rate blocks saving', async () => {
    fx.rateFor = () => null;
    (commercialApi.listCustomers as any).mockResolvedValue([customer({ currencyCode: 'USD' })]);
    await openAndLoad();
    await addItem();
    expect(screen.getByText(/No exchange rate for USD/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save & Finalise' })).toBeDisabled();
  });

  it('renders added line items in the table (regression: empty table)', async () => {
    await openAndLoad();
    await addItem();
    // Line 1 is the initial blank line; line 2 is the added A4 Paper item.
    expect(screen.getByDisplayValue('A4 Paper')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity for line 2')).toHaveValue(1);
    expect(screen.getByLabelText('Price for line 2')).toHaveValue(50);
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(2); // header + line
  });

  it('uses configured company base currency, not hardcoded ZMW', async () => {
    fx.baseCurrency = 'MWK';
    (commercialApi.listCustomers as any).mockResolvedValue([customer({ currencyCode: 'MWK' })]);
    await openAndLoad();
    await addItem();
    expect(screen.getAllByText(/MWK/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/ZMW/)).not.toBeInTheDocument();
  });

  it('shows unavailable cost/profit when line cost is unknown', async () => {
    await openAndLoad();
    await addItem();
    // Catalog item has known unit cost in this fixture, so profit is shown.
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    // Give the initial blank line a description but no known cost.
    fireEvent.change(screen.getByLabelText('Description for line 1'), { target: { value: 'Manual service' } });
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
  });

  it('tax field is policy-driven and read-only', async () => {
    await openAndLoad();
    const taxInput = screen.getByLabelText('Tax %') as HTMLInputElement;
    expect(taxInput).toBeDisabled();
    expect(taxInput).toHaveAttribute('readOnly');
  });
});