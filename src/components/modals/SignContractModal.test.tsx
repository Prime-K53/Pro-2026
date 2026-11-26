import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeActiveContract } from '../../test/fixtures/contracts';

let store: any[] = [];
const recordContractSignature = vi.fn(async (_id: string, p: any) => {
  store.push({ signer_role: p.signerRole, signer_name: p.signerName });
});

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => ({
    listContractSignatures: async () => [...store],
    recordContractSignature,
    triggerShortcutNotice: vi.fn(),
  }),
}));

import { SignContractModal } from '../modals/ContractActionModals';

describe('SignContractModal ceremony order', () => {
  beforeEach(() => {
    store = [];
    recordContractSignature.mockClear();
  });

  it('requires the company signature before the customer', async () => {
    const user = userEvent.setup();
    render(<SignContractModal contract={makeActiveContract()} onClose={() => {}} />);

    // Company signs first.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Sign as company/i })).toBeInTheDocument()
    );
    await user.type(screen.getByPlaceholderText(/Full name of signatory/i), 'Jane CFO');
    await user.click(screen.getByRole('button', { name: /Sign as company/i }));

    // Now the customer step appears.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Sign as customer/i })).toBeInTheDocument()
    );
    expect(recordContractSignature).toHaveBeenCalledTimes(1);
  });
});