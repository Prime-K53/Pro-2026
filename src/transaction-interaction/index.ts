/**
 * Transaction Interaction System — Phase 1 core (shared framework).
 *
 * Reuses the authoritative action engine in src/actions/* for all evaluation
 * and execution. This module is additive and performs no business logic.
 */
export * from './types';
export * from './helpers';

export { TransactionActionMenu } from './TransactionActionMenu';
export { TransactionContextMenu } from './TransactionContextMenu';
export type { TransactionContextMenuProps } from './TransactionContextMenu';

export { TransactionDetailDrawer } from './TransactionDetailDrawer';
export type { TransactionDetailDrawerProps } from './TransactionDetailDrawer';

export {
  TransactionAuditTimeline,
  useTransactionAudit,
} from './TransactionAuditTimeline';
export type {
  TransactionAuditTimelineProps,
  UseTransactionAuditResult,
} from './TransactionAuditTimeline';

export {
  TransactionSelectionProvider,
  useTransactionSelection,
} from './TransactionSelectionProvider';
export type { SelectionId } from './TransactionSelectionProvider';

export { TransactionBulkActionToolbar } from './TransactionBulkActionToolbar';
export type { TransactionBulkActionToolbarProps } from './TransactionBulkActionToolbar';

export {
  TransactionInteractionProvider,
  useTransactionInteraction,
} from './TransactionInteractionProvider';

export { useTransactionRowInteraction } from './useTransactionRowInteraction';

export {
  registerTransactionModule,
  unregisterTransactionModule,
  getTransactionModule,
  listTransactionModules,
  clearTransactionRegistry,
  resolveTransactionActions,
} from './TransactionActionRegistry';

export {
  buildEligibilityContext,
  evaluateForRecord,
} from './TransactionPermissionResolver';
export type { BuildContextArgs } from './TransactionPermissionResolver';

export { resolveRecordStatus, isStatusApplicable } from './TransactionStatusResolver';