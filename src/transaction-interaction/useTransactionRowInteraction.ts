import React, { useCallback } from 'react';
import type { TransactionRef } from './types';

/**
 * useTransactionRowInteraction
 * -----------------------------------------------------------------------------
 * Wires a table row to the shared interaction surface:
 *  - left-click  → open the detail drawer (ignores clicks on inner controls)
 *  - right-click → open the context menu at the pointer, suppressing the native
 *                  browser menu
 *
 * Selection (checkboxes) is intentionally NOT handled here — it belongs to
 * TransactionSelectionProvider so it stays independent of module selection.
 */

interface RowInteractionOptions {
  onOpenDetail: (ref: TransactionRef) => void;
  onOpenContextMenu: (ref: TransactionRef, point: { x: number; y: number }) => void;
}

const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, [role="menuitem"], [data-no-row-click]';

export function useTransactionRowInteraction({
  onOpenDetail,
  onOpenContextMenu,
}: RowInteractionOptions) {
  const onClick = useCallback(
    (e: React.MouseEvent, ref: TransactionRef) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(INTERACTIVE_SELECTOR)) return;
      onOpenDetail(ref);
    },
    [onOpenDetail]
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent, ref: TransactionRef) => {
      e.preventDefault();
      onOpenContextMenu(ref, { x: e.clientX, y: e.clientY });
    },
    [onOpenContextMenu]
  );

  return { onClick, onContextMenu };
}