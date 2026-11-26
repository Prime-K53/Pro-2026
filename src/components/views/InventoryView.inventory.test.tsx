import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InventoryTable } from './InventoryView';

interface Row { id: number; sku: string; }
const rows: Row[] = [
  { id: 1, sku: 'RM-1' },
  { id: 2, sku: 'RM-2' },
];

const props = (over: Partial<React.ComponentProps<typeof InventoryTable<Row>>> = {}) => ({
  rows,
  colSpan: 1,
  emptyMessage: 'No items.',
  selectedId: null,
  notify: vi.fn(),
  exportName: 'inv.csv',
  exportHeader: ['SKU'],
  exportRows: (rs: Row[]) => rs.map((r) => [r.sku]),
  renderHeader: () => <th>SKU</th>,
  renderCells: (r: Row) => <td>{r.sku}</td>,
  onRowClick: vi.fn(),
  onRowContextMenu: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:x');
  (globalThis as any).URL.revokeObjectURL = vi.fn();
});

describe('InventoryTable', () => {
  it('renders rows via render props', () => {
    render(<InventoryTable<Row> {...props()} />);
    expect(screen.getByText('SKU')).toBeInTheDocument();
    expect(screen.getByText('RM-1')).toBeInTheDocument();
  });

  it('left-click opens detail and right-click opens context menu', () => {
    const onRowClick = vi.fn();
    const onRowContextMenu = vi.fn();
    render(<InventoryTable<Row> {...props({ onRowClick, onRowContextMenu })} />);
    fireEvent.click(screen.getByText('RM-1'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(screen.getByText('RM-1'));
    expect(onRowContextMenu).toHaveBeenCalledTimes(1);
    expect(onRowContextMenu.mock.calls[0][1]).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  });

  it('select-all enables export', () => {
    render(<InventoryTable<Row> {...props()} />);
    fireEvent.click(screen.getByLabelText('Select all items'));
    const btn = screen.getByRole('button', { name: /Export selected/i });
    fireEvent.click(btn);
    expect((globalThis as any).URL.createObjectURL).toHaveBeenCalled();
  });

  it('shows empty message when no rows', () => {
    render(<InventoryTable<Row> {...props({ rows: [] })} />);
    expect(screen.getByText('No items.')).toBeInTheDocument();
  });
});