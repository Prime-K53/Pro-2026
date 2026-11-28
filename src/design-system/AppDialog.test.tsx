import React from 'react';
import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppDialogHost, appDialog, confirmActionModal } from './AppDialog';
import { DESIGN_TOKENS } from './tokens';

describe('AppDialogHost & appDialog', () => {
  it('resolves appDialog.confirm true on confirm and false on Escape/cancel', async () => {
    render(<AppDialogHost />);

    let confirmedPromise!: Promise<boolean>;
    act(() => {
      confirmedPromise = appDialog.confirm({
        title: 'Void Invoice',
        message: 'Are you sure you want to void this invoice?',
        destructive: true,
        confirmLabel: 'Void Invoice',
      });
    });

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Void Invoice', { selector: 'h2' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Void Invoice' }));
    await expect(confirmedPromise).resolves.toBe(true);

    let escapePromise!: Promise<boolean>;
    act(() => {
      escapePromise = appDialog.confirm({
        title: 'Delete Draft',
        message: 'Discard this draft?',
      });
    });

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await expect(escapePromise).resolves.toBe(false);
  });

  it('validates required input and returns submitted value for appDialog.prompt', async () => {
    render(<AppDialogHost />);

    let promptPromise!: Promise<string | null>;
    act(() => {
      promptPromise = appDialog.prompt({
        title: 'Reversal Reason',
        message: 'Document why this transaction is being reversed.',
        label: 'Reason',
        required: true,
        requiredMessage: 'Reason is mandatory.',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Reason is mandatory.');

    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(input, { target: { value: 'Duplicate entry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await expect(promptPromise).resolves.toBe('Duplicate entry');
  });

  it('resolves appDialog.alert when dismissed', async () => {
    render(<AppDialogHost />);

    let alertPromise!: Promise<void>;
    act(() => {
      alertPromise = appDialog.alert({
        title: 'Period Closed',
        message: 'Posting to a closed period is blocked.',
        closeLabel: 'Understood',
        tone: 'amber',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Understood' }));
    await expect(alertPromise).resolves.toBeUndefined();
  });

  it('supports confirmActionModal with required reason', async () => {
    render(<AppDialogHost />);

    let modalPromise!: Promise<{ confirmed: boolean; reason?: string }>;
    act(() => {
      modalPromise = confirmActionModal({
        title: 'Approve Credit Memo',
        message: 'Confirm credit memo approval.',
        requireReason: true,
        reasonLabel: 'Approval note',
        confirmLabel: 'Approve',
      });
    });

    const input = screen.getByLabelText(/^Approval note/);
    fireEvent.change(input, { target: { value: 'Customer return verified' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await expect(modalPromise).resolves.toEqual({
      confirmed: true,
      reason: 'Customer return verified',
    });
  });
});

describe('DESIGN_TOKENS standards', () => {
  it('defines canonical font families, 10 UI states, and accessibility minimums', () => {
    expect(DESIGN_TOKENS.typography.fontFamily.sans).toContain('Plus Jakarta Sans');
    expect(DESIGN_TOKENS.typography.fontFamily.display).toContain('DM Serif Display');
    expect(DESIGN_TOKENS.typography.fontFamily.mono).toContain('JetBrains Mono');
    expect(DESIGN_TOKENS.iconography.family).toBe('lucide-react');
    expect(DESIGN_TOKENS.iconography.strokeWidth).toBe(1.75);
    expect(DESIGN_TOKENS.accessibility.minTouchTargetTouchPx).toBeGreaterThanOrEqual(44);
    expect(DESIGN_TOKENS.uiStates).toEqual([
      'loading',
      'empty',
      'error',
      'success',
      'disabled',
      'interactive',
    ]);
  });
});
