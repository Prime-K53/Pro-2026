import React from 'react';
import { AdvancedActionsMenu } from '../components/actions/AdvancedActionsMenu';
import type { TransactionMenuProps } from './types';

export interface TransactionContextMenuProps<TRecord = unknown>
  extends TransactionMenuProps<TRecord> {
  /** Viewport coordinates from the originating contextmenu event. */
  point: { x: number; y: number };
  /** Called when the menu closes (Escape / outside click / scroll). */
  onClose?: () => void;
}

/**
 * TransactionContextMenu (right-click)
 * -----------------------------------------------------------------------------
 * Renders the SAME `AdvancedActionsMenu` as the three-dot trigger, in
 * context-menu mode (`contextPoint` + `hideTrigger`). Positioning, viewport
 * clamping, keyboard navigation, Escape/outside close and the execution
 * pipeline are all provided by the shared menu component.
 */
export function TransactionContextMenu<TRecord = unknown>({
  actions,
  point,
  onClose,
  label = 'Transaction actions',
  pendingActionId = null,
  onExecuteAction,
  executionContext,
  idempotencyRecordKey,
  notify,
  className,
}: TransactionContextMenuProps<TRecord>) {
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
      hideTrigger
      contextPoint={point}
      onContextClose={onClose}
    />
  );
}