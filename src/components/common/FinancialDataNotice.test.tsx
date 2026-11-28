import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FinancialDataNotice } from './FinancialDataNotice';

/**
 * The notice is the only place a view says "these figures cannot be trusted".
 * It must stay silent for verified data and always offer a retry otherwise.
 */

describe('FinancialDataNotice', () => {
  it('renders nothing when the figure is ready', () => {
    render(<FinancialDataNotice state="ready" label="purchasing data" onRetry={vi.fn()} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces loading without implying success', () => {
    render(<FinancialDataNotice state="loading" label="purchasing data" />);
    expect(screen.getByRole('status')).toHaveTextContent(/Loading purchasing data/i);
  });

  it('offers a working retry when the data is unavailable', () => {
    const onRetry = vi.fn();
    render(<FinancialDataNotice state="unavailable" label="purchasing data" onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/unavailable/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('marks retained figures as stale and offers a retry', () => {
    const onRetry = vi.fn();
    render(<FinancialDataNotice state="stale" label="payroll data" onRetry={onRetry} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/stale payroll data/i);
    expect(status).toHaveTextContent(/out of date/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});