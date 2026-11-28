import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  Button,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  ModalHeader,
  ModalShell,
  StatusBadge,
  Tabs,
} from './ui';
import { DamageQuantityControl } from '../inventory/StockDamageModal';
import { AmountControl } from '../modals/WriteCheckModal';

/**
 * Rendered-DOM accessibility contracts for the shared primitives.
 *
 * These assert the actual DOM relationship (label[for] -> control id,
 * aria-describedby -> existing element), not React element props.
 */

const controlId = (testId: string) => screen.getByTestId(testId).id;

describe('FormField label association', () => {
  it('labels a native input', () => {
    render(
      <FormField label="Customer name">
        <input data-testid="name" />
      </FormField>
    );
    const id = controlId('name');
    expect(id).not.toBe('');
    expect(screen.getByText('Customer name')).toHaveAttribute('for', id);
    expect(document.getElementById(id)).toBe(screen.getByTestId('name'));
  });

  it('labels a native select', () => {
    render(
      <FormField label="Channel">
        <select data-testid="channel">
          <option value="a">A</option>
        </select>
      </FormField>
    );
    const id = controlId('channel');
    expect(screen.getByText('Channel')).toHaveAttribute('for', id);
  });

  it('labels a native textarea', () => {
    render(
      <FormField label="Notes">
        <textarea data-testid="notes" />
      </FormField>
    );
    const id = controlId('notes');
    expect(screen.getByText('Notes')).toHaveAttribute('for', id);
  });

  it('resolves hint and error descriptions to real elements', () => {
    render(
      <FormField label="Amount" hint="In Kwacha" error="Required">
        <input data-testid="amount" />
      </FormField>
    );
    const describedBy = screen.getByTestId('amount').getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const target = document.getElementById(describedBy as string);
    expect(target).not.toBeNull();
    expect(target?.textContent).toBe('Required');
  });

  it('gives sibling fields unique ids', () => {
    render(
      <>
        <FormField label="First">
          <input data-testid="first" />
        </FormField>
        <FormField label="Second">
          <input data-testid="second" />
        </FormField>
      </>
    );
    const a = controlId('first');
    const b = controlId('second');
    expect(a).not.toBe('');
    expect(b).not.toBe('');
    expect(a).not.toBe(b);
    expect(screen.getByText('First')).toHaveAttribute('for', a);
    expect(screen.getByText('Second')).toHaveAttribute('for', b);
  });
});

describe('ModalHeader title wiring', () => {
  it('renders the supplied title id on the heading', () => {
    render(<ModalHeader title="Invoice" titleId="invoice-title" onClose={() => {}} />);
    const heading = screen.getByRole('heading', { name: 'Invoice' });
    expect(heading).toHaveAttribute('id', 'invoice-title');
    expect(document.querySelectorAll('#invoice-title')).toHaveLength(1);
  });

  it('omits the id when no titleId is supplied', () => {
    render(<ModalHeader title="Plain" onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Plain' })).not.toHaveAttribute('id');
  });
});
describe('composite FormField controls', () => {
  it('StockDamage: label targets the number input, hint describes it, button stays separate', () => {
    render(
      <FormField label="Damage quantity" required hint="Maximum 12">
        <DamageQuantityControl
          quantity="3"
          onQuantityChange={() => {}}
          exceedsOnHand={false}
          showAllButton
          onSelectAll={() => {}}
        />
      </FormField>
    );
    const input = document.querySelector('input[type="number"]') as HTMLInputElement;
    const label = screen.getByText('Damage quantity');
    expect(label).toHaveAttribute('for', input.id);
    expect(input.id).not.toBe('');
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('Maximum 12').id);
    expect(document.getElementById(input.getAttribute('aria-describedby') as string)).not.toBeNull();
    // The adjacent button is a distinct control, not the labelled element.
    const button = screen.getByRole('button', { name: 'All' });
    expect(button).not.toHaveAttribute('id', input.id);
    expect(label.getAttribute('for')).not.toBe(button.id);
  });

  it('WriteCheck: label targets the number input, symbol is decorative, input stays required', () => {
    render(
      <FormField label="Amount" required hint="Recorded in K">
        <AmountControl amount={5} onAmountChange={() => {}} currencySymbol="K" />
      </FormField>
    );
    const input = document.querySelector('input[type="number"]') as HTMLInputElement;
    expect(screen.getByText('Amount')).toHaveAttribute('for', input.id);
    expect(input.id).not.toBe('');
    expect(input.required).toBe(true);
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('Recorded in K').id);
    const symbol = screen.getByText('K');
    expect(symbol).toHaveAttribute('class', expect.stringContaining('pointer-events-none'));
    expect(symbol.id).not.toBe(input.id);
  });
});
describe('dialog accessible names (composition level)', () => {
  it('A. POS composition exposes a unique labelled heading', () => {
    render(
      <ModalShell open onClose={() => {}} titleId="pos-modal-title">
        <ModalHeader titleId="pos-modal-title" title="Full Point-of-Sale (POS) Terminal" onClose={() => {}} />
      </ModalShell>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'pos-modal-title');
    const matches = document.querySelectorAll('#pos-modal-title');
    expect(matches).toHaveLength(1);
    expect(matches[0].tagName).toBe('H2');
    expect(matches[0].textContent).toBe('Full Point-of-Sale (POS) Terminal');
    expect(dialog.getAttribute('aria-labelledby')).toBe(matches[0].id);
  });

  it('B. close-shift composition exposes a unique labelled heading', () => {
    render(
      <ModalShell open onClose={() => {}} titleId="close-shift-title">
        <ModalHeader titleId="close-shift-title" title="Close shift" onClose={() => {}} />
      </ModalShell>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'close-shift-title');
    const matches = document.querySelectorAll('#close-shift-title');
    expect(matches).toHaveLength(1);
    expect(matches[0].tagName).toBe('H2');
    expect(matches[0].textContent).toBe('Close shift');
  });

  it('C. a shell without a title id claims no labelledby relationship', () => {
    render(
      <ModalShell open onClose={() => {}}>
        <ModalHeader title="Unnamed" onClose={() => {}} />
      </ModalShell>
    );
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-labelledby');
  });
});

describe('UI component & state primitives', () => {
  it('Button exposes aria-busy and disabled during loading state', () => {
    render(
      <Button loading loadingLabel="Saving invoice…">
        Save Invoice
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Saving invoice…' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  it('StatusBadge renders semantic icon with aria-hidden and readable text', () => {
    const { container } = render(
      <StatusBadge tone="success" showIcon>
        Paid
      </StatusBadge>
    );
    expect(screen.getByText('Paid')).toBeInTheDocument();
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('Tabs wires tablist, tab roles, aria-selected, and onChange', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        ariaLabel="Report views"
        value="summary"
        onChange={onChange}
        tabs={[
          { id: 'summary', label: 'Summary', badge: 2 },
          { id: 'ledger', label: 'Ledger' },
        ]}
      />
    );
    expect(screen.getByRole('tablist', { name: 'Report views' })).toBeInTheDocument();
    const summaryTab = screen.getByRole('tab', { name: /Summary/ });
    const ledgerTab = screen.getByRole('tab', { name: 'Ledger' });
    expect(summaryTab).toHaveAttribute('aria-selected', 'true');
    expect(ledgerTab).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(ledgerTab);
    expect(onChange).toHaveBeenCalledWith('ledger');
  });

  it('LoadingState, EmptyState, and ErrorState expose accessible roles and actions', () => {
    const onRetry = vi.fn();
    const onAction = vi.fn();
    render(
      <>
        <LoadingState label="Fetching ledger…" rows={2} />
        <EmptyState
          title="No receipts yet"
          description="Record a receipt to get started."
          action={<Button onClick={onAction}>New Receipt</Button>}
        />
        <ErrorState title="Sync failed" message="Network timeout" onRetry={onRetry} />
      </>
    );

    expect(screen.getByRole('status')).toHaveTextContent('Fetching ledger…');
    fireEvent.click(screen.getByRole('button', { name: 'New Receipt' }));
    expect(onAction).toHaveBeenCalledTimes(1);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Sync failed');
    expect(alert).toHaveTextContent('Network timeout');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});