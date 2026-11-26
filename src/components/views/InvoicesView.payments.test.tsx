import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => ({
    companyProfile: { theme: 'classic', currency: 'K' },
    triggerShortcutNotice: vi.fn(),
    tableDensity: 'comfortable',
    setCurrentView: vi.fn(),
    openDocumentPreview: vi.fn(),
    setIsStatementOpen: vi.fn(),
  }),
}));

import { commercialApi } from '../../services/commercialApi';
import { CustomerPaymentsTable } from './InvoicesView';

const payment = (over: Record<string, unknown> = {}) => ({
  id: 1,
  paymentNumber: 'PMT-001',
  customerId: 5,
  customerName: 'St. Mary School',
  paymentDate: '2026-06-01',
  paymentMethod: 'Bank Transfer',
  depositAccountId: 10,
  depositAccountName: 'Main Bank',
  amount: 1000,
  isVoided: false,
  allocations: [{ invoiceId: 2, invoiceNumber: 'INV-2', amount: 600 }],
  createdBy: 'kabweb',
  createdAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof CustomerPaymentsTable>> = {}) => ({
  payments: [payment()],
  currency: 'K',
  authenticated: true,
  permissions: ['invoices:read'],
  role: 'Accountant',
  companyId: 1,
  canWrite: false,
  onPreview: vi.fn(),
  onOpenCustomer: vi.fn(),
  reload: vi.fn(),
  notify: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:x');
  (globalThis as any).URL.revokeObjectURL = vi.fn();
});

describe('CustomerPaymentsTable — detail drawer', () => {
  it('opens the drawer on left-click with payment + allocations', () => {
    render(<CustomerPaymentsTable {...props()} />);
    fireEvent.click(screen.getByText('PMT-001'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Payment')).toBeInTheDocument();
    expect(within(dialog).getByText('Linked invoices & allocations')).toBeInTheDocument();
    expect(within(dialog).getByText('INV-2')).toBeInTheDocument();
    expect(within(dialog).getByText('St. Mary School')).toBeInTheDocument();
    // Unallocated = 1000 - 600 = 400
    expect(within(dialog).getAllByText(/400\.00/).length).toBeGreaterThan(0);
  });
});

describe('CustomerPaymentsTable — parity, permissions, status', () => {
  it('three-dot and right-click expose identical actions', async () => {
    const p = props({ canWrite: true, permissions: ['invoices:read', 'invoices:write'] });
    const { unmount } = render(<CustomerPaymentsTable {...p} />);
    fireEvent.click(screen.getByLabelText('Actions for PMT-001'));
    const threeDot = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    unmount();

    render(<CustomerPaymentsTable {...p} />);
    fireEvent.contextMenu(screen.getByText('PMT-001'));
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    const context = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(context).toEqual(threeDot);
  });

  it('hides Void without invoices:write', () => {
    render(<CustomerPaymentsTable {...props({ canWrite: false })} />);
    fireEvent.click(screen.getByLabelText('Actions for PMT-001'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(items).not.toContain('Void Payment (Reverse GL)');
    expect(items).toContain('View Payment');
  });

  it('hides Void on an already voided payment', () => {
    const voided = payment({ id: 2, paymentNumber: 'PMT-002', isVoided: true });
    render(
      <CustomerPaymentsTable
        {...props({ payments: [voided], canWrite: true, permissions: ['invoices:read', 'invoices:write'] })}
      />
    );
    fireEvent.click(screen.getByLabelText('Actions for PMT-002'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(items).not.toContain('Void Payment (Reverse GL)');
  });

  it('gates View Audit History on audit:read', () => {
    const { unmount } = render(<CustomerPaymentsTable {...props({ permissions: ['invoices:read'] })} />);
    fireEvent.click(screen.getByLabelText('Actions for PMT-001'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent)).not.toContain(
      'View Audit History'
    );
    unmount();
    render(<CustomerPaymentsTable {...props({ permissions: ['invoices:read', 'audit:read'] })} />);
    fireEvent.click(screen.getByLabelText('Actions for PMT-001'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent)).toContain(
      'View Audit History'
    );
  });
});

describe('CustomerPaymentsTable — reversal safeguards', () => {
  it('requires a reason and calls the existing void endpoint once', async () => {
    const spy = vi.spyOn(commercialApi, 'voidPayment').mockResolvedValue({ ok: true } as any);
    render(<CustomerPaymentsTable {...props({ canWrite: true, permissions: ['invoices:read', 'invoices:write'] })} />);

    fireEvent.click(screen.getByLabelText('Actions for PMT-001'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Void Payment/i }));
    const reason = await screen.findByPlaceholderText(/reason/i);
    fireEvent.change(reason, { target: { value: 'customer overpaid' } });
    fireEvent.click(screen.getByRole('button', { name: /^Void$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][1]).toBe('customer overpaid');
  });
});

describe('CustomerPaymentsTable — multi-select export', () => {
  it('shows an export action when rows are selected', () => {
    render(<CustomerPaymentsTable {...props()} />);
    fireEvent.click(screen.getByLabelText('Select all payments'));
    const btn = screen.getByRole('button', { name: /Export selected/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect((globalThis as any).URL.createObjectURL).toHaveBeenCalled();
  });
});