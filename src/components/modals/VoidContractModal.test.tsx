import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeActiveContract } from '../../test/fixtures/contracts';

const voidPrintingContract = vi.fn();

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => ({
    voidPrintingContract,
    triggerShortcutNotice: vi.fn(),
  }),
}));

import { VoidContractModal } from '../modals/ContractActionModals';

describe('VoidContractModal', () => {
  beforeEach(() => voidPrintingContract.mockClear());

  it('requires a reason before voiding', async () => {
    const user = userEvent.setup();
    render(<VoidContractModal contract={makeActiveContract()} onClose={() => {}} />);
    const button = screen.getByRole('button', { name: /Void Contract/i });
    expect(button).toBeDisabled();
    await user.type(screen.getByPlaceholderText(/Raised in error/i), 'duplicate');
    expect(button).toBeEnabled();
  });

  it('calls voidPrintingContract with the entered reason', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<VoidContractModal contract={makeActiveContract()} onClose={onClose} />);
    await user.type(screen.getByPlaceholderText(/Raised in error/i), 'duplicate of PC-1');
    await user.click(screen.getByRole('button', { name: /Void Contract/i }));
    expect(voidPrintingContract).toHaveBeenCalledWith(expect.any(String), 'duplicate of PC-1');
    expect(onClose).toHaveBeenCalled();
  });
});