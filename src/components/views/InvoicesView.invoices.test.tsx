import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { InvoicesTable } from './InvoicesView';
import type { ApiInvoice } from '../../services/commercialApi';

const inv = (over: Partial<ApiInvoice> = {}): ApiInvoice => ({
  id: 1,
  invoiceNumber: 'INV-1',
  customerId: 5,
  customerName: 'Acme',
  invoiceDate: '2026-06-01',
  dueDate: '2026-06-30',
  terms: 'Net 30',
  status: 'open',
  isSalesReceipt: false,
  currencyCode: 'ZMW',
  exchangeRate: 1,
  subtotal: 1000,
  taxRate: 0,
  taxAmount: 0,
  total: 1000,
  totalCost: 400,
  grossProfit: 600,
  amountPaid: 0,
  balanceDue: 1000,
  lines: [],
  ...over,
} as ApiInvoice);

const props = (over: Partial<React.ComponentProps<typeof InvoicesTable>> = {}) => ({
  rows: [inv()],
  colSpan: 2,
  emptyMessage: 'No invoices.',
  selectedId: null,
  notify: vi.fn(),
  renderHeader: () => (
    <>
      <th>DOC #</th>
      <th>STATUS</th>
    </>
  ),
  renderCells: (r: ApiInvoice) => (
    <>
      <td>{r.invoiceNumber}</td>
      <td>{r.status}</td>
    </>
  ),
  onRowClick: vi.fn(),
  onRowContextMenu: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:x');
  (globalThis as any).URL.revokeObjectURL = vi.fn();
});

describe('InvoicesTable', () => {
  it('renders header and rows via render props', () => {
    render(<InvoicesTable {...props()} />);
    expect(screen.getByText('DOC #')).toBeInTheDocument();
    expect(screen.getByText('INV-1')).toBeInTheDocument();
  });

  it('left-click opens detail (onRowClick) and right-click opens context menu', () => {
    const onRowClick = vi.fn();
    const onRowContextMenu = vi.fn();
    render(<InvoicesTable {...props({ onRowClick, onRowContextMenu })} />);
    fireEvent.click(screen.getByText('INV-1'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(screen.getByText('INV-1'));
    expect(onRowContextMenu).toHaveBeenCalledTimes(1);
    expect(onRowContextMenu.mock.calls[0][1]).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  });

  it('supports select-all and exports selected rows', () => {
    const rows = [inv({ id: 1, invoiceNumber: 'INV-1' }), inv({ id: 2, invoiceNumber: 'INV-2' })];
    render(<InvoicesTable {...props({ rows })} />);
    fireEvent.click(screen.getByLabelText('Select all invoices'));
    const btn = screen.getByRole('button', { name: /Export selected/i });
    expect(within(btn).getByText(/2/)).toBeInTheDocument();
    fireEvent.click(btn);
    expect((globalThis as any).URL.createObjectURL).toHaveBeenCalled();
  });

  it('shows the empty message when there are no rows', () => {
    render(<InvoicesTable {...props({ rows: [] })} />);
    expect(screen.getByText('No invoices.')).toBeInTheDocument();
  });
});