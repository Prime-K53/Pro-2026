import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ActionEligibilityContext, ResolvedAdvancedAction } from '../actions/types';
import { TransactionContextMenu } from './TransactionContextMenu';
import type { TransactionRef } from './types';

/**
 * TransactionInteractionProvider
 * -----------------------------------------------------------------------------
 * Page-level host for the shared detail drawer and the right-click context menu.
 * Modules keep their own layout/sections; the provider only owns the transient
 * "which row is open / where is the menu" state so there is a single, consistent
 * interaction surface per screen.
 */

interface DetailRequest {
  ref: TransactionRef;
  /** Module-supplied drawer element (built with TransactionDetailDrawer). */
  node: React.ReactNode;
}

interface ContextMenuRequest<TRecord = unknown> {
  ref: TransactionRef;
  point: { x: number; y: number };
  actions: ResolvedAdvancedAction<TRecord>[];
  onExecuteAction?: (
    action: ResolvedAdvancedAction<TRecord>,
    reason?: string
  ) => Promise<void> | void;
  executionContext?: ActionEligibilityContext<TRecord>;
  idempotencyRecordKey?: string | number | null;
  notify?: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
  label?: string;
}

interface TransactionInteractionContextValue {
  openDetail: (request: DetailRequest) => void;
  closeDetail: () => void;
  openContextMenu: <TRecord = unknown>(request: ContextMenuRequest<TRecord>) => void;
  closeContextMenu: () => void;
}

const TransactionInteractionContext = createContext<TransactionInteractionContextValue | null>(
  null
);

export const TransactionInteractionProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [detail, setDetail] = useState<DetailRequest | null>(null);
  const [context, setContext] = useState<ContextMenuRequest<any> | null>(null);

  const openDetail = useCallback((request: DetailRequest) => {
    setContext(null);
    setDetail(request);
  }, []);
  const closeDetail = useCallback(() => setDetail(null), []);
  const openContextMenu = useCallback(<TRecord = unknown,>(request: ContextMenuRequest<TRecord>) => {
    setDetail(null);
    setContext(request as ContextMenuRequest<any>);
  }, []);
  const closeContextMenu = useCallback(() => setContext(null), []);

  const value = useMemo<TransactionInteractionContextValue>(
    () => ({ openDetail, closeDetail, openContextMenu, closeContextMenu }),
    [openDetail, closeDetail, openContextMenu, closeContextMenu]
  );

  return (
    <TransactionInteractionContext.Provider value={value}>
      {children}
      {detail?.node}
      {context && (
        <TransactionContextMenu
          actions={context.actions}
          point={context.point}
          onClose={closeContextMenu}
          label={context.label}
          onExecuteAction={context.onExecuteAction}
          executionContext={context.executionContext}
          idempotencyRecordKey={context.idempotencyRecordKey}
          notify={context.notify}
        />
      )}
    </TransactionInteractionContext.Provider>
  );
};

export function useTransactionInteraction(): TransactionInteractionContextValue {
  const ctx = useContext(TransactionInteractionContext);
  if (!ctx) {
    throw new Error(
      'useTransactionInteraction must be used within a TransactionInteractionProvider'
    );
  }
  return ctx;
}