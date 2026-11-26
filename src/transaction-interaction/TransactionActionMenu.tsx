import React from 'react';
import { AdvancedActionsMenu } from '../components/actions/AdvancedActionsMenu';
import type { TransactionMenuProps } from './types';

/**
 * TransactionActionMenu (three-dot)
 * -----------------------------------------------------------------------------
 * Discoverable per-row trigger. It renders the SAME `AdvancedActionsMenu` used by
 * right-click, with the SAME resolved actions and the SAME execution pipeline —
 * there is exactly one implementation behind both entry points.
 */
export function TransactionActionMenu<TRecord = unknown>({
  actions,
  label = 'Transaction actions',
  pendingActionId = null,
  onExecuteAction,
  executionContext,
  idempotencyRecordKey,
  notify,
  className,
}: TransactionMenuProps<TRecord>) {
  return (
    <AdvancedActionsMenu<TRecord>
      actions={actions}
      label={label}
      pendingActionId={pendingActionId}
      onExecuteAction={onExecuteAction}
      executionContext={executionContext}
      idempotencyRecordKey={idempotencyRecordKey}
      notify={notify}
      className={className}
    />
  );
}