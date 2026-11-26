import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => ({
    companyProfile: { theme: 'classic' },
    triggerShortcutNotice: vi.fn(),
    setIsJournalEntryOpen: vi.fn(),
  }),
}));

import { accountingApi } from '../../services/accountingApi';
import type { ApiJournalEntry } from '../../services/accountingApi';
import { JournalLedgerTable } from './ChartOfAccountsView';

const line = (id: number, accountId: number, debit: number, credit: number) => ({
  id,
  lineOrder: id,
  accountId,
  accountCode: `ACC-${accountId}`,
  accountName: `Account ${accountId}`,
  accountType: 'Expense' as const,
  basis: 'both' as const,
  description: null,
  debit: String(debit),
  credit: String(credit),
  debitNum: debit,
  creditNum: credit,
  isReconciled: false,
});

const entry = (over: Partial<ApiJournalEntry> = {}): ApiJournalEntry => ({
  id: 1,
  companyId: 1,
  entryNumber: 'JE-1',
  txnDate: '2026-06-01',
  reference: 'REF-1',
  description: 'Test journal',
  memo: null,
  sourceType: 'manual',
  sourceId: null,
  status: 'posted',
  isPosted: true,
  isAdjusting: false,
  reversesTransactionId: null,
  reversedByTransactionId: null,
  postedAt: '2026-06-01T00:00:00.000Z',
  postedBy: 1,
  postedByUsername: 'kabweb',
  totalDebits: '100',
  totalCredits: '100',
  lines: [line(1, 10, 100, 0), line(2, 20, 0, 100)],
  ...over,
});

const baseProps = (over: Partial<React.ComponentProps<typeof JournalLedgerTable>> = {}) => ({
  journals: [entry()],
  currency: 'K',
  authenticated: true,
  permissions: ['journals:read'],
  role: 'Accountant',
  companyId: 1,
  canWriteJournals: false,
  isPeriodRestricted: () => false,
  onOpenAccount: vi.fn(),
  onReverse: vi.fn(),
  notify: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('GL JournalLedgerTable — detail drawer', () => {
  it('opens the shared drawer on left-click with debit/credit lines and totals', () => {
    render(<JournalLedgerTable {...baseProps()} />);
    fireEvent.click(screen.getByText('JE-1'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Debit / Credit lines')).toBeInTheDocument();
    expect(within(dialog).getByText(/Account 10/)).toBeInTheDocument();
    expect(within(dialog).getByText('Balanced')).toBeInTheDocument();
    expect(within(dialog).getAllByText(/100\.00/).length).toBeGreaterThan(0);
  });
});

describe('GL JournalLedgerTable — menu parity & status/permission gating', () => {
  it('three-dot and right-click expose identical actions for a posted entry', async () => {
    const props = baseProps({
      canWriteJournals: true,
      permissions: ['journals:read', 'journals:write', 'accounts:read'],
    });
    const { unmount } = render(<JournalLedgerTable {...props} />);
    fireEvent.click(screen.getByLabelText('Actions for JE-1'));
    const threeDot = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(threeDot).toContain('Reverse (Void) Entry');
    unmount();

    render(<JournalLedgerTable {...props} />);
    fireEvent.contextMenu(screen.getByText('JE-1'));
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    const context = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(context).toEqual(threeDot);
  });

  it('hides Reverse without journals:write permission', () => {
    render(<JournalLedgerTable {...baseProps({ canWriteJournals: false })} />);
    fireEvent.click(screen.getByLabelText('Actions for JE-1'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(items).not.toContain('Reverse (Void) Entry');
    expect(items).toContain('View Details');
  });

  it('hides Reverse when the accounting period is restricted', () => {
    render(
      <JournalLedgerTable
        {...baseProps({ canWriteJournals: true, permissions: ['journals:read', 'journals:write'], isPeriodRestricted: () => true })}
      />
    );
    fireEvent.click(screen.getByLabelText('Actions for JE-1'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(items).not.toContain('Reverse (Void) Entry');
  });

  it('offers View Reversal (not Reverse) for a voided entry', () => {
    const voided = entry({ id: 2, entryNumber: 'JE-2', status: 'voided', reversedByTransactionId: 1 });
    render(
      <JournalLedgerTable
        {...baseProps({ journals: [voided], canWriteJournals: true, permissions: ['journals:read', 'journals:write'] })}
      />
    );
    fireEvent.click(screen.getByLabelText('Actions for JE-2'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(items).toContain('View Reversal');
    expect(items).not.toContain('Reverse (Void) Entry');
  });

  it('does not offer Reverse on a draft entry', () => {
    const draft = entry({ id: 3, entryNumber: 'JE-3', status: 'draft', isPosted: false, postedAt: null, postedByUsername: null });
    render(
      <JournalLedgerTable
        {...baseProps({ journals: [draft], canWriteJournals: true, permissions: ['journals:read', 'journals:write'] })}
      />
    );
    fireEvent.click(screen.getByLabelText('Actions for JE-3'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(items).not.toContain('Reverse (Void) Entry');
  });

  it('gates View Audit History on audit:read (not journals:read)', () => {
    const withoutAudit = baseProps({ permissions: ['journals:read', 'journals:write'] });
    const { unmount } = render(<JournalLedgerTable {...withoutAudit} />);
    fireEvent.click(screen.getByLabelText('Actions for JE-1'));
    expect(
      within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent)
    ).not.toContain('View Audit History');
    unmount();

    render(
      <JournalLedgerTable
        {...baseProps({ permissions: ['journals:read', 'journals:write', 'audit:read'] })}
      />
    );
    fireEvent.click(screen.getByLabelText('Actions for JE-1'));
    expect(
      within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent)
    ).toContain('View Audit History');
  });
});

describe('GL JournalLedgerTable — multi-select bulk reversal', () => {
  it('selects all and reverses eligible journals with per-record results', async () => {
    const spy = vi
      .spyOn(accountingApi, 'reverseJournal')
      .mockResolvedValue({ original: entry(), reversal: entry({ id: 99, status: 'posted' }) });
    const journals = [entry({ id: 1, entryNumber: 'JE-1' }), entry({ id: 2, entryNumber: 'JE-2' })];
    render(
      <JournalLedgerTable
        {...baseProps({ journals, canWriteJournals: true, permissions: ['journals:read', 'journals:write'] })}
      />
    );

    fireEvent.click(screen.getByLabelText('Select all journals'));
    const bulkBtn = screen.getByRole('button', { name: /Reverse eligible/i });
    fireEvent.click(bulkBtn);

    // Confirmation dialog requires a reason.
    const reason = await screen.findByPlaceholderText(/reason/i);
    fireEvent.change(reason, { target: { value: 'bulk reversal test' } });
    fireEvent.click(screen.getByRole('button', { name: /^Reverse$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/2 succeeded/)).toBeInTheDocument());
    expect(spy.mock.calls[0][1]?.reason).toBe('bulk reversal test');
  });
});

describe('GL JournalLedgerTable — empty state', () => {
  it('renders an empty message when there are no journals', () => {
    render(<JournalLedgerTable {...baseProps({ journals: [] })} />);
    expect(screen.getByText(/No journal transactions posted yet/i)).toBeInTheDocument();
  });
});