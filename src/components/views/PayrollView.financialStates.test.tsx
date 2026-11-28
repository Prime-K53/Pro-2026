import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * PayrollView derives its grand totals from the backend-owned employee roster.
 * These tests pin that the totals are never presented as current when the
 * roster failed to load, and that a failed refresh marks them stale.
 */

const refreshFinancialData = vi.fn();

const employee = (over: Record<string, unknown> = {}) => ({
  id: 'emp-1',
  name: 'Jane Doe',
  role: 'Press Operator',
  payType: 'hourly',
  payRate: 50,
  allowances: 0,
  taxStatus: 'Single',
  ...over,
});

const setContext = (over: Record<string, unknown> = {}) => {
  (globalThis as any).__ctx = {
    employees: [employee()],
    payrollRuns: [],
    accounts: [],
    financialData: {
      employees: { status: 'ready', refreshing: false, stale: false, loadedAt: '2026-01-01', error: null },
      payrollRuns: { status: 'ready', refreshing: false, stale: false, loadedAt: '2026-01-01', error: null },
    },
    refreshFinancialData,
    setIsNewEmployeeOpen: vi.fn(),
    setCurrentView: vi.fn(),
    companyProfile: { name: 'Prime', currency: 'K', defaultBankAccountId: '' },
    triggerShortcutNotice: vi.fn(),
    ...over,
  };
};

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => (globalThis as any).__ctx,
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ authenticated: true, permissions: ['payroll:read'], activeCompany: { id: 1, name: 'Prime' } }),
}));

vi.mock('../../services/payrollApi', () => ({
  payrollApi: { runPayroll: vi.fn(), listRuns: vi.fn().mockResolvedValue([]) },
}));

import { PayrollView } from './PayrollView';

const openWizard = () => {
  const tab = screen.getAllByText('Run New Pay Period')[0];
  fireEvent.click(tab);
};

beforeEach(() => {
  refreshFinancialData.mockClear();
  setContext();
});

describe('PayrollView financial figure states', () => {
  it('1. shows a loading notice and no totals while the roster is loading', () => {
    setContext({
      employees: [],
      financialData: {
        employees: { status: 'loading', refreshing: true, stale: false, loadedAt: null, error: null },
        payrollRuns: { status: 'loading', refreshing: true, stale: false, loadedAt: null, error: null },
      },
    });
    render(<PayrollView />);
    openWizard();
    expect(screen.getByText(/Loading payroll data/i)).toBeInTheDocument();
    expect(screen.queryByText('Gross Wages (Dr. Payroll Exp):')).not.toBeInTheDocument();
  });

  it('2. shows no derived totals when the initial load failed', () => {
    setContext({
      employees: [],
      financialData: {
        employees: { status: 'error', refreshing: false, stale: false, loadedAt: null, error: 'roster unavailable' },
        payrollRuns: { status: 'error', refreshing: false, stale: false, loadedAt: null, error: 'roster unavailable' },
      },
    });
    render(<PayrollView />);
    openWizard();
    expect(screen.getByRole('alert')).toHaveTextContent(/payroll data unavailable/i);
    expect(screen.queryByText('Gross Wages (Dr. Payroll Exp):')).not.toBeInTheDocument();
    expect(screen.queryByText('Net Direct Deposit (Cr. Bank):')).not.toBeInTheDocument();
  });

  it('5. renders the calculated totals from successfully loaded data', () => {
    render(<PayrollView />);
    openWizard();
    expect(screen.getByText('Gross Wages (Dr. Payroll Exp):')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('6. marks retained totals as stale after a failed refresh', () => {
    setContext({
      financialData: {
        employees: { status: 'ready', refreshing: false, stale: true, loadedAt: '2026-01-01', error: 'timeout' },
        payrollRuns: { status: 'ready', refreshing: false, stale: false, loadedAt: '2026-01-01', error: null },
      },
    });
    render(<PayrollView />);
    openWizard();
    expect(screen.getByText(/stale payroll data/i)).toBeInTheDocument();
    // Retained real data stays visible, but is explicitly flagged.
    expect(screen.getByText('Gross Wages (Dr. Payroll Exp):')).toBeInTheDocument();
  });

  it('8. retry re-runs the real backend load', () => {
    setContext({
      employees: [],
      financialData: {
        employees: { status: 'error', refreshing: false, stale: false, loadedAt: null, error: 'down' },
        payrollRuns: { status: 'error', refreshing: false, stale: false, loadedAt: null, error: 'down' },
      },
    });
    render(<PayrollView />);
    openWizard();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refreshFinancialData).toHaveBeenCalled();
  });
});