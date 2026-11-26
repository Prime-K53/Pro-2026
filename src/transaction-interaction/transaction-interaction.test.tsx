import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

// AdvancedActionsMenu consumes useAccounting; provide a lightweight double.
vi.mock('../context/AccountingContext', () => ({
  useAccounting: () => ({
    companyProfile: { theme: 'classic' },
    triggerShortcutNotice: vi.fn(),
  }),
}));

import type { AdvancedActionDefinition, ResolvedAdvancedAction } from '../actions/types';
import {
  TransactionActionMenu,
  TransactionContextMenu,
  TransactionDetailDrawer,
  TransactionSelectionProvider,
  useTransactionSelection,
  TransactionBulkActionToolbar,
  TransactionAuditTimeline,
  useTransactionAudit,
  buildEligibilityContext,
  resolveTransactionActions,
  registerTransactionModule,
  clearTransactionRegistry,
  createTransactionRef,
} from './index';
import type { TransactionModuleConfig } from './index';

const resolved = (
  def: AdvancedActionDefinition<any>,
  over: Partial<ResolvedAdvancedAction<any>['evaluation']> = {}
): ResolvedAdvancedAction<any> => ({
  definition: def,
  evaluation: { visible: true, enabled: true, state: 'enabled', ...over },
});

beforeEach(() => {
  clearTransactionRegistry();
});

describe('registry + engine integration', () => {
  it('hides actions the user lacks permission for and disables status-mismatched actions', () => {
    const defs: AdvancedActionDefinition<{ status: string }>[] = [
      { id: 'view', label: 'View', group: 'view' },
      {
        id: 'post',
        label: 'Post',
        group: 'process',
        requiredPermission: 'journals:write',
        applicableStatuses: ['posted'],
      },
    ];
    const config: TransactionModuleConfig<{ status: string }> = {
      moduleKey: 'gl',
      entityType: 'journal',
      actions: defs,
      resolveStatus: (r) => ({ status: r.status }),
    };
    registerTransactionModule(config);

    // No permission → post hidden.
    const ctxNoPerm = buildEligibilityContext(config, {
      authenticated: true,
      permissions: ['journals:read'],
      record: { status: 'posted' },
    });
    const resolvedNoPerm = resolveTransactionActions(config, ctxNoPerm);
    expect(resolvedNoPerm.map((r) => r.definition.id)).toEqual(['view']);

    // Permission but wrong status → post visible but disabled.
    const ctxWrongStatus = buildEligibilityContext(config, {
      authenticated: true,
      permissions: ['journals:write'],
      record: { status: 'draft' },
    });
    const resolvedWrong = resolveTransactionActions(config, ctxWrongStatus);
    const post = resolvedWrong.find((r) => r.definition.id === 'post');
    expect(post).toBeTruthy();
    expect(post!.evaluation.visible).toBe(true);
    expect(post!.evaluation.enabled).toBe(false);
  });
});

describe('TransactionDetailDrawer', () => {
  it('renders module-specific sections and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <TransactionDetailDrawer
        open
        onClose={onClose}
        title="Sales Invoice"
        number="INV-1"
        typeLabel="invoice"
        statusBadge={<span>open</span>}
        sections={[
          {
            key: 'main',
            title: 'Details',
            fields: [{ label: 'Amount', value: '$10.00', mono: true, tone: 'teal' }],
          },
        ]}
      />
    );
    expect(screen.getByText('Sales Invoice')).toBeInTheDocument();
    expect(screen.getByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('TransactionSelectionProvider', () => {
  const Harness = () => {
    const s = useTransactionSelection();
    return (
      <div>
        <button onClick={() => s.setOrderedIds(['a', 'b', 'c', 'd'])}>order</button>
        <button onClick={() => s.selectAll(['a', 'b', 'c', 'd'])}>all</button>
        <button onClick={() => s.clear()}>clear</button>
        <button onClick={() => s.toggle('b')}>toggle-b</button>
        <button onClick={() => s.toggle('d', { shiftKey: true })}>shift-d</button>
        <span data-testid="sel">{s.selectedIds.join(',')}</span>
      </div>
    );
  };

  it('supports select-all, shift-range and clear independently', () => {
    render(
      <TransactionSelectionProvider>
        <Harness />
      </TransactionSelectionProvider>
    );
    fireEvent.click(screen.getByText('order'));
    fireEvent.click(screen.getByText('all'));
    expect(screen.getByTestId('sel').textContent).toBe('a,b,c,d');

    fireEvent.click(screen.getByText('clear'));
    fireEvent.click(screen.getByText('order'));
    fireEvent.click(screen.getByText('toggle-b'));
    fireEvent.click(screen.getByText('shift-d'));
    expect(screen.getByTestId('sel').textContent).toBe('b,c,d');
  });
});

describe('three-dot and right-click parity', () => {
  const actions = [
    resolved({ id: 'open', label: 'Open transaction', group: 'view' }),
    resolved({ id: 'print', label: 'Print', group: 'documents' }),
  ];

  it('expose identical actions through both entry points', async () => {
    const { unmount } = render(
      <TransactionActionMenu actions={actions} label="Row actions" />
    );
    fireEvent.click(screen.getByLabelText('Row actions'));
    const threeDot = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    unmount();

    render(<TransactionContextMenu actions={actions} point={{ x: 20, y: 20 }} label="Row actions" />);
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    const context = within(screen.getByRole('menu')).getAllByRole('menuitem').map((n) => n.textContent);
    expect(context).toEqual(threeDot);
  });

  it('supports keyboard navigation and Escape close', async () => {
    const onClose = vi.fn();
    render(
      <TransactionContextMenu
        actions={actions}
        point={{ x: 20, y: 20 }}
        label="Row actions"
        onClose={onClose}
      />
    );
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('TransactionBulkActionToolbar', () => {
  type Rec = { id: string; status: string; perms: string[] };
  const def: AdvancedActionDefinition<Rec> = {
    id: 'post',
    label: 'Post',
    group: 'process',
    requiredPermission: 'post:write',
    applicableStatuses: ['posted'],
    execute: vi.fn((ctx) => {
      const rec = ctx.record as Rec;
      if (rec.id === 'r4') throw new Error('boom');
      return { status: 'success' as const };
    }),
  };

  it('classifies success/failed/skipped and prevents duplicate submits', async () => {
    const records: Rec[] = [
      { id: 'r1', status: 'posted', perms: ['post:write'] },
      { id: 'r2', status: 'draft', perms: ['post:write'] },
      { id: 'r3', status: 'posted', perms: [] },
      { id: 'r4', status: 'posted', perms: ['post:write'] },
    ];
    const getRef = (r: Rec) => createTransactionRef(r, { moduleKey: 'm', entityType: 'e', id: (x) => x.id });
    const buildContext = (r: Rec) =>
      buildEligibilityContext(
        { moduleKey: 'm', entityType: 'e', actions: [def], resolveStatus: (x) => ({ status: x.status }) },
        { authenticated: true, permissions: r.perms, record: r }
      );

    render(
      <TransactionBulkActionToolbar
        definitions={[def]}
        records={records}
        getRef={getRef}
        buildContext={buildContext}
      />
    );

    const btn = screen.getByRole('button', { name: /Post/i });
    fireEvent.click(btn);
    fireEvent.click(btn); // duplicate submit should be ignored

    await waitFor(() => expect(screen.getByText(/1 succeeded/)).toBeInTheDocument());
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    expect(screen.getByText(/2 skipped/)).toBeInTheDocument();
    // execute ran once for r1 and once for r4 (not duplicated).
    expect((def.execute as any).mock.calls.length).toBe(2);
  });
});

describe('TransactionAuditTimeline', () => {
  it('renders read-only entries', () => {
    render(
      <TransactionAuditTimeline
        entries={[
          { id: 1, occurredAt: '2026-01-01T00:00:00.000Z', actorUsername: 'kabweb', action: 'INVOICE_POSTED' },
        ]}
      />
    );
    expect(screen.getByText('INVOICE_POSTED')).toBeInTheDocument();
    expect(screen.getByText(/kabweb/)).toBeInTheDocument();
  });

  it('shows a documented notice when no record-scoped loader is configured', async () => {
    const Loader = () => {
      const audit = useTransactionAudit(undefined, null);
      return <TransactionAuditTimeline entries={audit.entries} loading={audit.loading} notice={audit.notice} />;
    };
    render(<Loader />);
    await waitFor(() =>
      expect(screen.getByText(/Record-scoped audit retrieval is not configured/i)).toBeInTheDocument()
    );
  });
});