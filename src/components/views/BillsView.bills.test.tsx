import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BillsTable } from './BillsView';

interface Row { id: number; label: string; }
const rows: Row[] = [
  { id: 1, label: 'BILL-1' },
  { id: 2, label: 'BILL-2' },
];

const props = (over: Partial<React.ComponentProps<typeof BillsTable>> = {}) => ({
  rows,
  colSpan: 1,
  emptyMessage: 'No bills.',
  selectedId: null,
  notify: vi.fn(),
  exportName: 'x.csv',
  exportHeader: ['Label'],
  exportRows: (rs: Row[]) => rs.map((r) => [r.label]),
  renderHeader: () => <th>LABEL</th>,
  renderCells: (r: Row) => <td>{r.label}</td>,
  onRowClick: vi.fn(),
  onRowContextMenu: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:x');
  (globalThis as any).URL.revokeObjectURL = vi.fn();
});

describe('BillsTable', () => {
  it('renders rows via render props', () => {
    render(<BillsTable {...props()} />);
    expect(screen.getByText('LABEL')).toBeInTheDocument();
    expect(screen.getByText('BILL-1')).toBeInTheDocument();
  });

  it('left-click and right-click invoke callbacks with a point', () => {
    const onRowClick = vi.fn();
    const onRowContextMenu = vi.fn();
    render(<BillsTable {...props({ onRowClick, onRowContextMenu })} />);
    fireEvent.click(screen.getByText('BILL-1'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(screen.getByText('BILL-1'));
    expect(onRowContextMenu).toHaveBeenCalledTimes(1);
    expect(onRowContextMenu.mock.calls[0][1]).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  });

  it('select-all enables export of selected rows', () => {
    render(<BillsTable {...props()} />);
    fireEvent.click(screen.getByLabelText('Select all rows'));
    const btn = screen.getByRole('button', { name: /Export selected/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect((globalThis as any).URL.createObjectURL).toHaveBeenCalled();
  });

  it('shows empty message when no rows', () => {
    render(<BillsTable {...props({ rows: [] })} />);
    expect(screen.getByText('No bills.')).toBeInTheDocument();
  });
});