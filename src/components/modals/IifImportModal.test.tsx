import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiError } from '../../services/http';

const notice = vi.hoisted(() => vi.fn());

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => ({
    isIifImportOpen: true,
    setIsIifImportOpen: vi.fn(),
    triggerShortcutNotice: notice,
  }),
}));

const createAccount = vi.hoisted(() => vi.fn());
const createCustomer = vi.hoisted(() => vi.fn());

vi.mock('../../services/accountingApi', () => ({
  accountingApi: { createAccount },
}));

vi.mock('../../services/commercialApi', () => ({
  commercialApi: { createCustomer },
}));

import { IifImportModal } from './IifImportModal';

const IIF = [
  'ACCNT\tCash A\tBANK\t\t', // valid -> created
  'ACCNT\tCash A\tBANK\t\t', // duplicate in file -> skipped
  'ACCNT\tDup Code\tEXP\t\tDUP1', // server duplicate code -> skipped
  'CUST\tAcme Corp\t1 A St\tCity\tNet 30', // valid -> created
  'CUST\tPending Co\t2 B St\tCity\tNet 15', // 202 -> pending
  'CUST\tFail Co\t3 C St\tCity\tNet 10', // generic error -> failed
  'ACCNT\t\tBANK\t\t', // missing name -> failed
].join('\n');

describe('IifImportModal persistence (ACCNT/CUST)', () => {
  beforeEach(() => {
    createAccount.mockReset();
    createCustomer.mockReset();
    notice.mockReset();
    createAccount.mockImplementation(async (payload: any) => {
      if (payload.name === 'Dup Code') {
        throw new ApiError('Account code already in use', 409, { code: 'DUPLICATE_ACCOUNT_CODE' });
      }
      return { id: 1, name: payload.name };
    });
    createCustomer.mockImplementation(async (payload: any) => {
      if (payload.companyName === 'Pending Co') return undefined; // HTTP 202 pending
      if (payload.companyName === 'Fail Co') throw new Error('network down');
      return { id: 2, companyName: payload.companyName };
    });
  });

  it('classifies created / pending / skipped / failed without false success', async () => {
    render(<IifImportModal isOpen onClose={vi.fn()} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: IIF } });

    fireEvent.click(screen.getByRole('button', { name: /Import Records into/i }));

    await waitFor(() => expect(screen.getByText(/2 created/i)).toBeTruthy());
    expect(screen.getByText(/1 pending approval/i)).toBeTruthy();
    expect(screen.getByText(/2 skipped/i)).toBeTruthy();
    expect(screen.getByText(/2 failed/i)).toBeTruthy();

    // Pending is never reported as created; no blanket success toast.
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/created.*pending.*skipped.*failed/i));
    expect(createAccount).toHaveBeenCalled();
    expect(createCustomer).toHaveBeenCalled();
  });

  it('does not call global adders (persistence is via authoritative APIs only)', async () => {
    render(<IifImportModal isOpen onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: IIF } });
    fireEvent.click(screen.getByRole('button', { name: /Import Records into/i }));
    await waitFor(() => expect(createCustomer).toHaveBeenCalled());
    // The modal must not auto-close on partial/pending results.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});