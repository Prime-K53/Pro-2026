import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Truthfulness tests for the financial-data freshness indicator.
 *
 * The status bar is the one always-visible place where a failed or stale
 * financial load is surfaced, so these tests pin its wording and retry wiring.
 */

const refreshFinancialData = vi.fn();

vi.mock('../../context/AccountingContext', () => ({
  useAccounting: () => ({
    companyProfile: { name: 'Prime', currency: 'K' },
    tableDensity: 'comfortable',
    setTableDensity: vi.fn(),
    triggerShortcutNotice: vi.fn(),
    financialData: (globalThis as any).__financialData,
    refreshFinancialData,
  }),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ activeCompany: { id: 1, name: 'Prime', role: 'Admin' }, hasPermission: () => false }),
}));

vi.mock('../../services/accountingApi', () => ({
  ACCOUNTING_UPDATED_EVENT: 'accounting-updated',
  accountingApi: { getTrialBalance: vi.fn().mockResolvedValue({ rows: [], isBalanced: true, difference: 0 }) },
}));

import { StatusBar } from './StatusBar';

const domain = (over: Record<string, unknown> = {}) => ({
  status: 'ready',
  refreshing: false,
  stale: false,
  loadedAt: '2026-01-01T00:00:00.000Z',
  error: null,
  ...over,
});

const setFinancialData = (value: unknown) => {
  (globalThis as any).__financialData = value;
};

beforeEach(() => {
  refreshFinancialData.mockClear();
});

describe('StatusBar financial freshness', () => {
  it('reports current data only after a successful load', () => {
    setFinancialData({ invoices: domain(), bills: domain() });
    render(<StatusBar />);
    expect(screen.getByText('Financial data current')).toBeInTheDocument();
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });

  it('reports unavailable data and offers a retry when the initial load failed', () => {
    setFinancialData({ invoices: domain({ status: 'error', loadedAt: null, error: 'network down' }) });
    render(<StatusBar />);
    const retry = screen.getByRole('button', { name: /Financial data unavailable/i });
    expect(retry).toBeInTheDocument();
    fireEvent.click(retry);
    expect(refreshFinancialData).toHaveBeenCalledTimes(1);
  });

  it('reports stale data after a failed refresh instead of claiming success', () => {
    setFinancialData({ invoices: domain({ stale: true, error: 'timeout' }) });
    render(<StatusBar />);
    expect(screen.getByText(/Some financial data stale/i)).toBeInTheDocument();
    expect(screen.queryByText('Financial data current')).not.toBeInTheDocument();
  });

  it('does not claim current data while a refresh is in flight with nothing loaded', () => {
    setFinancialData({ invoices: domain({ status: 'loading', refreshing: true, loadedAt: null }) });
    render(<StatusBar />);
    expect(screen.getByText(/Loading financial data/i)).toBeInTheDocument();
    expect(screen.queryByText('Financial data current')).not.toBeInTheDocument();
  });
});

describe('StatusBar freshness on small screens', () => {
  it('13. is discoverable at mobile widths (not hidden below md)', () => {
    setFinancialData({ invoices: domain({ status: 'error', loadedAt: null, error: 'down' }) });
    const { container } = render(<StatusBar />);
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    // The indicator must not be display:none below the md breakpoint.
    expect(region?.className).not.toMatch(/\bhidden\b/);
    expect(region?.className).toMatch(/\bflex\b/);
    // A concise mobile label is rendered alongside the full one.
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('14. keeps retry usable on mobile', () => {
    setFinancialData({ invoices: domain({ status: 'error', loadedAt: null, error: 'down' }) });
    render(<StatusBar />);
    const retry = screen.getByRole('button', { name: /retry/i });
    fireEvent.click(retry);
    expect(refreshFinancialData).toHaveBeenCalledTimes(1);
  });
});