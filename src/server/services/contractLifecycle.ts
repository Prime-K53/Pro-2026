/**
 * @file contractLifecycle.ts
 * @description Pure state-transition helper for Printing Contract lifecycle.
 *
 * Adapted from PrimeERPsystem/contracts/DocumentLifecycle.ts.
 *
 * This module is ADDITIVE: it does not replace the existing status guards in
 * printingRecordsService.ts. It provides a single source of truth for which
 * transitions are allowed and what role/permission each requires, so that:
 *
 *   - the existing service can adopt it incrementally (one guard at a time);
 *   - the audit report's H-02/H-04 findings are partially addressed by having
 *     an explicit table to point to;
 *   - future code paths (REST routes, new UI actions) have a single place to
 *     check validity.
 *
 * Design rules:
 *   - Keep the existing Printing System status names (`draft`, `active`,
 *     `suspended`, `completed`, `exhausted`, `cancelled`). Do NOT rename.
 *   - Do NOT make any network or DB call. This file is pure.
 *   - Do NOT throw new error types. Re-use `AccountingError` from the existing
 *     engine so error handling in routes remains unchanged.
 */

import { AccountingError } from './accountingEngine.ts';
import type { CompanyRole } from '../permissions.ts';

/**
 * The status values currently used by `printing_contracts.status`.
 *
 * Kept in sync with src/types/accounting.ts:PrintingContract['status'] and
 * with the SQL CHECK constraints in db/migrations/0007.
 */
export type PrintingContractStatus =
  | 'draft'
  | 'active'
  | 'suspended'
  | 'completed'
  | 'exhausted'
  | 'cancelled';

/**
 * Lifecycle actions that can move a contract from one status to another.
 *
 * Each action corresponds to an existing service method in
 * printingRecordsService.ts:
 *
 *   CREATE     → createPrintingContract
 *   ACTIVATE   → activatePrintingContract
 *   SUSPEND    → suspendContract
 *   RESUME     → resumeContract
 *   COMPLETE   → completeContractAssessment (final assessment)
 *   VOID       → cancelPrintingContract
 *
 * REVISE is intentionally omitted: the current Printing System uses
 * `amendPrintingContract` to mutate in place rather than void-and-replace.
 * Adding REVISE would change the amendment workflow and is out of scope.
 */
export type ContractLifecycleAction =
  | 'CREATE'
  | 'ACTIVATE'
  | 'SUSPEND'
  | 'RESUME'
  | 'COMPLETE'
  | 'VOID';

/**
 * A single row in the transition matrix.
 */
export interface ContractStateTransition {
  from: PrintingContractStatus | 'START';
  to: PrintingContractStatus;
  action: ContractLifecycleAction;
  /**
   * Minimum role required to perform the transition. Mirrors the existing
   * permission model in src/server/permissions.ts rather than inventing new
   * role names. Omit for "any authenticated actor".
   */
  requiredRoles?: CompanyRole[];
  /**
   * If true, the target status is immutable: payload cannot be edited after
   * the transition. Mirrors PrimeERP's `isImmutabilityTrigger`.
   */
  isImmutabilityTrigger?: boolean;
}

/**
 * The contract transition matrix.
 *
 * Each row corresponds to one legal (from, action) → to triple. Unknown
 * combinations are rejected by `assertTransition`.
 */
export const CONTRACT_TRANSITIONS: ContractStateTransition[] = [
  // Creation: always starts in `draft`.
  { from: 'START', to: 'draft', action: 'CREATE' },

  // Draft → active: requires customer acceptance + approval (existing service
  // enforces this; the table records the role requirement only).
  {
    from: 'draft',
    to: 'active',
    action: 'ACTIVATE',
    requiredRoles: ['Administrator', 'Accountant'],
  },

  // Active ↔ suspended: requires a reason (existing service enforces).
  {
    from: 'active',
    to: 'suspended',
    action: 'SUSPEND',
    requiredRoles: ['Administrator', 'Accountant', 'Bookkeeper'],
  },
  {
    from: 'suspended',
    to: 'active',
    action: 'RESUME',
    requiredRoles: ['Administrator', 'Accountant', 'Bookkeeper'],
  },

  // Completion: all assessments done, no credit balance remaining.
  // The service may also transition to `active` when a credit balance remains;
  // that path is intentionally not in this table because it is a no-op status
  // change and should not be audited as a lifecycle event.
  {
    from: 'active',
    to: 'completed',
    action: 'COMPLETE',
    requiredRoles: ['Administrator', 'Accountant', 'Bookkeeper'],
    isImmutabilityTrigger: true,
  },
  {
    from: 'active',
    to: 'exhausted',
    action: 'COMPLETE',
    requiredRoles: ['Administrator', 'Accountant', 'Bookkeeper'],
    isImmutabilityTrigger: true,
  },

  // Cancellation: from active, suspended, or completed. The service also
  // requires a reason and a settlement mode (refund/forfeit) when a balance
  // remains; the table records the role requirement only.
  {
    from: 'active',
    to: 'cancelled',
    action: 'VOID',
    requiredRoles: ['Administrator'],
    isImmutabilityTrigger: true,
  },
  {
    from: 'suspended',
    to: 'cancelled',
    action: 'VOID',
    requiredRoles: ['Administrator'],
    isImmutabilityTrigger: true,
  },
  {
    from: 'completed',
    to: 'cancelled',
    action: 'VOID',
    requiredRoles: ['Administrator'],
    isImmutabilityTrigger: true,
  },
];

/**
 * States whose payload must not be edited after entry.
 *
 * Mirrors PrimeERP's IMMUTABILITY_RULES. In the current Printing System,
 * `amendPrintingContract` already refuses to mutate cancelled/completed/
 * exhausted contracts; this map makes that rule explicit and reusable.
 */
export const CONTRACT_IMMUTABILITY_RULES: Record<PrintingContractStatus, boolean> = {
  draft: false,      // editable
  active: false,     // amendable (with audit)
  suspended: false,  // amendable (with audit)
  completed: true,   // immutable
  exhausted: true,   // immutable
  cancelled: true,   // immutable
};

/**
 * Returns true if a transition from `from` to `to` via `action` is legal.
 */
export function canTransition(
  from: PrintingContractStatus,
  action: ContractLifecycleAction,
  to: PrintingContractStatus
): boolean {
  return CONTRACT_TRANSITIONS.some(
    (t) => t.from === from && t.action === action && t.to === to
  );
}

/**
 * Asserts that a transition is legal and that the actor's role is sufficient.
 *
 * Throws `AccountingError` with status 409 (Conflict) on an illegal transition
 * or 403 (Forbidden) on an insufficient role, matching the existing error
 * conventions in printingRecordsService.ts.
 *
 * This function is intended to be called from the existing service methods
 * BEFORE they execute their status UPDATE. It does not replace the existing
 * domain-specific guards (e.g. "customer acceptance required"); it complements
 * them.
 */
export function assertTransition(
  from: PrintingContractStatus,
  action: ContractLifecycleAction,
  to: PrintingContractStatus,
  actorRole: CompanyRole
): void {
  const transition = CONTRACT_TRANSITIONS.find(
    (t) => t.from === from && t.action === action && t.to === to
  );
  if (!transition) {
    throw new AccountingError(
      409,
      `Illegal contract transition: ${from} --${action}--> ${to}`,
      'ILLEGAL_CONTRACT_TRANSITION'
    );
  }
  if (transition.requiredRoles && !transition.requiredRoles.includes(actorRole)) {
    throw new AccountingError(
      403,
      `Role ${actorRole} is not allowed to perform ${action} (requires ${transition.requiredRoles.join(' or ')})`,
      'CONTRACT_TRANSITION_FORBIDDEN'
    );
  }
}

/**
 * Returns the target status for a given (from, action) pair, or `null` if no
 * transition is defined. Useful for UI code that wants to predict the next
 * status without duplicating the table.
 */
export function nextStatus(
  from: PrintingContractStatus,
  action: ContractLifecycleAction
): PrintingContractStatus | null {
  return CONTRACT_TRANSITIONS.find((t) => t.from === from && t.action === action)?.to ?? null;
}

/**
 * Returns the list of actions that are legal from `from`.
 */
export function allowedActions(from: PrintingContractStatus): ContractLifecycleAction[] {
  return CONTRACT_TRANSITIONS.filter((t) => t.from === from).map((t) => t.action);
}

/**
 * Returns true if `status` is immutable (no payload edits allowed).
 */
export function isImmutable(status: PrintingContractStatus): boolean {
  return CONTRACT_IMMUTABILITY_RULES[status];
}