import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => ({
    companyProfile: { theme: 'classic', currency: 'K' },
    triggerShortcutNotice: vi.fn(),
    tableDensity: 'comfortable',
    setCurrentView: vi.fn(),
  }),
}));

import { commercialApi } from '../../services/commercialApi';
import type { ApiBankTransaction } from '../../services/commercialApi';
import { BankRegisterTable } from './BankingRegisterView';

const tx = (over: Partial<ApiBankTransaction> = {}): ApiBankTransaction => ({
  id: 1,
  accountId: 10,
  accountName: 'Main Bank',
  date: '2026-06-01',
  payee: 'ZESCO',
  type: 'Check',
  refNumber: 'CHK-001',
  memo: 'Electricity',
  amount: -100,
  runningBalance: 900,
  cleared: false,
  status: 'posted',
  reconciliationId: null,
  journalTxnId: 5,
  category: 'Utilities',
  offsetAccountId: 20,
  offsetAccountName: 'Power Expense',
  checkNumber: 'CHK-001',
  printLater: false,
  printedAt: null,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof BankRegisterTable>> = {}) => ({
  transactions: [tx()],
  allTransactions: [tx()],
  currency: 'K',
  tableDensity: 'comfortable',
  authenticated: true,
  permissions: ['banking:read'],
  role: 'Accountant',
  companyId: 1,
  canWrite: false,
  onSelectBankAccount: vi.fn(),
  onOpenGlAccount: vi.fn(),
  reload: vi.fn(),
  notify: vi.fn(),
  ...over,
});

beforeEach(() => vi.restoreAllMocks());

describe('BankRegisterTable — detail drawer', () => {
  it('opens the shared drawer on left-click with transaction + classification', () => {
    render(<BankRegisterTable {...props()} />);
    fireEvent.click(screen.getByText('CHK-001'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Transaction')).toBeInTheDocument();
    expect(within(dialog).getByText('Classification')).toBeInTheDocument();
    expect(within(dialog).getByText('Main Bank')).toBeInTheDocument();
    expect(within(dialog).getAllByText('posted').length).toBeGreaterThan(0);
  });
});

describe('BankRegisterTable — parity, status & permission gating', () => {
  it('three-dot and right-click expose identical actions', async () => {
    const p = props({ canWrite: true, permissions: ['banking:read', 'banking:write'] });
    const { unmount } = render(<BankRegisterTable {...p} />);
    fireEvent.click(screen.getByLabelText('Actions for CHK-001'));
    const threeDot = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    unmount();

    render(<BankRegisterTable {...p} />);
    fireEvent.contextMenu(screen.getByText('CHK-001'));
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    const context = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(context).toEqual(threeDot);
  });

  it('hides write actions without banking:write', () => {
    render(<BankRegisterTable {...props({ canWrite: false })} />);
    fireEvent.click(screen.getByLabelText('Actions for CHK-001'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(items).not.toContain('Void Transaction (Reverse GL)');
    expect(items).not.toContain('Mark Cleared');
    expect(items).toContain('View Transaction');
  });

  it('does not offer void/clear on pending_import rows (not posted)', () => {
    const pending = tx({ id: 2, status: 'pending_import', cleared: false, runningBalance: 0 });
    render(
      <BankRegisterTable
        {...props({ transactions: [pending], allTransactions: [pending], canWrite: true, permissions: ['banking:read', 'banking:write'] })}
      />
    );
    fireEvent.click(screen.getByLabelText('Actions for CHK-001'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(items).not.toContain('Void Transaction (Reverse GL)');
    expect(items).not.toContain('Mark Cleared');
  });

  it('does not offer void/clear on voided rows', () => {
    const voided = tx({ id: 3, status: 'voided' });
    render(
      <BankRegisterTable
        {...props({ transactions: [voided], allTransactions: [voided], canWrite: true, permissions: ['banking:read', 'banking:write'] })}
      />
    );
    fireEvent.click(screen.getByLabelText('Actions for CHK-001'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(items).not.toContain('Void Transaction (Reverse GL)');
  });

  it('does not offer void/clear on reconciled rows', () => {
    const reconciled = tx({ id: 4, reconciliationId: 7, cleared: true });
    render(
      <BankRegisterTable
        {...props({ transactions: [reconciled], allTransactions: [reconciled], canWrite: true, permissions: ['banking:read', 'banking:write'] })}
      />
    );
    fireEvent.click(screen.getByLabelText('Actions for CHK-001'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(items).not.toContain('Void Transaction (Reverse GL)');
    expect(items).not.toContain('Mark Uncleared');
  });

  it('labels the cleared toggle by current cleared state', () => {
    const uncleared = tx({ id: 5, cleared: false });
    const { unmount } = render(
      <BankRegisterTable {...props({ transactions: [uncleared], allTransactions: [uncleared], canWrite: true, permissions: ['banking:read', 'banking:write'] })} />
    );
    fireEvent.click(screen.getByLabelText('Actions for CHK-001'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent)).toContain('Mark Cleared');
    unmount();

    const cleared = tx({ id: 6, cleared: true });
    render(
      <BankRegisterTable {...props({ transactions: [cleared], allTransactions: [cleared], canWrite: true, permissions: ['banking:read', 'banking:write'] })} />
    );
    fireEvent.click(screen.getByLabelText('Actions for CHK-001'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent)).toContain('Mark Uncleared');
  });

  it('gates View Audit History on audit:read', () => {
    const { unmount } = render(<BankRegisterTable {...props({ permissions: ['banking:read'] })} />);
    fireEvent.click(screen.getByLabelText('Actions for CHK-001'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent)).not.toContain(
      'View Audit History'
    );
    unmount();

    render(<BankRegisterTable {...props({ permissions: ['banking:read', 'audit:read'] })} />);
    fireEvent.click(screen.getByLabelText('Actions for CHK-001'));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent)).toContain(
      'View Audit History'
    );
  });
});

describe('BankRegisterTable — multi-select bulk safety', () => {
  it('marks only queued checks printed and reports results', async () => {
    const spy = vi.spyOn(commercialApi, 'markChecksPrinted').mockResolvedValue({ printedCount: 1 });
    const rows = [
      tx({ id: 11, checkNumber: 'CHK-011', printLater: true }),
      tx({ id: 12, checkNumber: 'CHK-012', printLater: true }),
      tx({ id: 13, checkNumber: 'CHK-013', printLater: false }),
    ];
    render(
      <BankRegisterTable
        {...props({ transactions: rows, allTransactions: rows, canWrite: true, permissions: ['banking:read', 'banking:write'] })}
      />
    );

    fireEvent.click(screen.getByLabelText('Select all transactions'));
    fireEvent.click(screen.getByRole('button', { name: /Mark Printed/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Mark Printed$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/2 succeeded/)).toBeInTheDocument());
    expect(screen.getByText(/1 skipped/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export selected/i })).toBeInTheDocument();
  });

  it('prevents duplicate execution when the bulk button is clicked twice', async () => {
    const spy = vi.spyOn(commercialApi, 'markChecksPrinted').mockResolvedValue({ printedCount: 1 });
    const rows = [tx({ id: 21, checkNumber: 'CHK-021', printLater: true })];
    render(
      <BankRegisterTable
        {...props({ transactions: rows, allTransactions: rows, canWrite: true, permissions: ['banking:read', 'banking:write'] })}
      />
    );
    fireEvent.click(screen.getByLabelText('Select all transactions'));
    const btn = screen.getByRole('button', { name: /Mark Printed/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Mark Printed$/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });
});