import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeContract, makeCustomer } from '../../test/fixtures/contracts';

// --- Mock the two contexts the view consumes ---------------------------------
const suspendContract = vi.fn();
const resumeContract = vi.fn();

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => ({
    companyProfile: { currency: 'ZMW', defaultBankAccountId: 'bank-1' },
    customers: [makeCustomer()],
    accounts: [],
    bankTransactions: [],
    inventoryItems: [],
    printingContracts: [
      makeContract({ id: 'c1', contractNumber: 'PC-0001', status: 'active', backendId: 1 }),
      makeContract({ id: 'c2', contractNumber: 'PC-0002', status: 'draft', backendId: 2 }),
    ],
    addPrintingContract: vi.fn(),
    updateContractAssessment: vi.fn(),
    completeContractAssessment: vi.fn(),
    linkContractDepositInvoice: vi.fn(),
    linkMilestoneInvoice: vi.fn(),
    cancelPrintingContract: vi.fn(),
    activatePrintingContract: vi.fn(),
    renewPrintingContract: vi.fn(),
    amendPrintingContract: vi.fn(),
    suspendContract,
    resumeContract,
    addContractAssessment: vi.fn(),
    removeContractAssessment: vi.fn(),
    generateAndSyncWorkflowInvoice: vi.fn(),
    getInvoiceById: vi.fn(),
    openDocumentPreview: vi.fn(),
    getRawUsageUnitCost: () => 0,
    getAssessmentActualStats: () => ({
      papersCount: 0,
      totalCost: 0,
      sheets: 0,
      impressions: 0,
      paperCost: 0,
      tonerCost: 0,
    }),
    setCurrentView: vi.fn(),
    triggerShortcutNotice: vi.fn(),
  }),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    activeCompany: { id: 1, name: 'Prime ERP', role: 'Admin' },
    hasPermission: () => true,
    authenticated: true,
    permissions: ['printing:read', 'printing:write', 'printing:contracts:manage'],
  }),
}));

import { PrintingContractsView } from '../views/PrintingContractsView';

describe('PrintingContractsView register', () => {
  beforeEach(() => {
    suspendContract.mockClear();
    resumeContract.mockClear();
  });

  it('renders the register heading and contract rows', () => {
    render(<PrintingContractsView />);
    expect(screen.getByText(/School Printing Contracts/i)).toBeInTheDocument();
    expect(screen.getByText('PC-0001')).toBeInTheDocument();
    expect(screen.getByText('PC-0002')).toBeInTheDocument();
  });

  it('filters rows by search text', async () => {
    const user = userEvent.setup();
    render(<PrintingContractsView />);
    const search = screen.getByPlaceholderText(/Search contract/i);
    await user.type(search, '0002');
    expect(screen.getByText('PC-0002')).toBeInTheDocument();
    expect(screen.queryByText('PC-0001')).not.toBeInTheDocument();
  });

  it('filters rows by status', async () => {
    const user = userEvent.setup();
    render(<PrintingContractsView />);
    const select = screen.getByDisplayValue('All statuses');
    await user.selectOptions(select, 'draft');
    expect(screen.getByText('PC-0002')).toBeInTheDocument();
    expect(screen.queryByText('PC-0001')).not.toBeInTheDocument();
  });

  it('opens the new-contract modal with the sectioned form', async () => {
    const user = userEvent.setup();
    render(<PrintingContractsView />);
    await user.click(screen.getByRole('button', { name: /New Prepaid School Contract/i }));
    expect(screen.getByText(/Parties & Type/i)).toBeInTheDocument();
    expect(screen.getByText(/Pricing Rules/i)).toBeInTheDocument();
    expect(screen.getByText(/Commercials & Period/i)).toBeInTheDocument();
    expect(screen.getByText(/Printing Specification/i)).toBeInTheDocument();
    expect(screen.getByText(/Delivery Terms/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/2026 Term 2 examination printing agreement/i)).toBeInTheDocument();
  });
});