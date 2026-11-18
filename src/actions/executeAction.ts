import { createActionIdempotencyKey } from './idempotency';
import { evaluateAction, isActionExecutable } from './evaluateActions';
import type {
  ActionConfirmation,
  ActionEligibilityContext,
  ActionExecutionHelpers,
  ActionExecutionResult,
  ResolvedAdvancedAction,
} from './types';

export interface ExecuteActionOptions<TRecord = unknown> {
  action: ResolvedAdvancedAction<TRecord>;
  context: ActionEligibilityContext<TRecord>;
  helpers?: ActionExecutionHelpers;
  /**
   * UI-provided confirmation/reason resolver. If confirmation is required and
   * no resolver is provided (or it returns cancelled), execution is cancelled.
   */
  requestConfirmation?: (
    confirmation: ActionConfirmation,
    action: ResolvedAdvancedAction<TRecord>
  ) => Promise<{ confirmed: boolean; reason?: string }>;
  /** Record key used for idempotency key derivation. */
  recordKey?: string | number | null;
}

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'Action execution failed';
  }
}

/**
 * Standard execution pipeline for opt-in advanced actions.
 * - Re-evaluates local eligibility immediately before execution using fresh context.
 * - Handles confirmation/reason requirements via injected UI resolver.
 * - Generates idempotency key when policy requests/requires it and helper/API contract allows.
 * - Delegates to the action's execute handler (which must call existing authorized workflows).
 * - Reports success only after confirmed handler completion.
 *
 * Duplicate-submission prevention is enforced by caller state (pendingActionId)
 * and by executability checks; backend idempotency depends on API support.
 * Backend authorization/validation remains authoritative for all real operations.
 */
export async function executeResolvedAction<TRecord = unknown>(
  options: ExecuteActionOptions<TRecord>
): Promise<ActionExecutionResult> {
  const { action, context, helpers, requestConfirmation, recordKey } = options;
  const def = action.definition;

  // Re-evaluate eligibility at execution time to reduce stale menu/state risk.
  // Callers must provide up-to-date context (permissions, record status, approvals, period, etc.).
  const evaluation = evaluateAction(def, context);
  const resolvedNow: ResolvedAdvancedAction<TRecord> = { definition: def, evaluation };

  if (!evaluation.visible) {
    return { status: 'error', message: evaluation.reason || 'Action is not available' };
  }
  if (!isActionExecutable(resolvedNow)) {
    if (evaluation.state === 'pending') {
      return { status: 'noop', message: 'Action is already in progress' };
    }
    return { status: 'error', message: evaluation.reason || 'Action cannot be executed' };
  }
  if (typeof def.execute !== 'function') {
    return { status: 'error', message: 'Action has no executable handler' };
  }

  let reason: string | undefined;
  const confirmation = evaluation.confirmation;
  if (confirmation) {
    if (!requestConfirmation) {
      return { status: 'cancelled', message: 'Confirmation required' };
    }
    const res = await requestConfirmation(confirmation, resolvedNow);
    if (!res.confirmed) {
      return { status: 'cancelled', message: 'Action cancelled' };
    }
    if (confirmation.requireReason) {
      reason = (res.reason || '').trim();
      if (!reason) {
        return { status: 'error', message: 'A reason is required to continue' };
      }
    } else if (res.reason) {
      reason = res.reason.trim() || undefined;
    }
  }

  let idempotencyKey: string | undefined;
  if (def.idempotency && def.idempotency !== 'none') {
    if (helpers?.createIdempotencyKey) {
      idempotencyKey = helpers.createIdempotencyKey(def.id, recordKey);
    } else {
      // Client-side key generation for handlers/APIs that can accept it.
      idempotencyKey = createActionIdempotencyKey(def.id, recordKey);
    }
  }

  try {
    const out = await def.execute(context, { ...(helpers || {}), idempotencyKey, reason });
    const result: ActionExecutionResult =
      out && typeof out === 'object' && 'status' in out
        ? (out as ActionExecutionResult)
        : { status: 'success' };

    // Only report success after handler completion (backend confirmation is the handler's responsibility).
    if (result.status === 'success') {
      if (result.message) helpers?.notify?.(result.message, 'success');
    } else if (result.status === 'approval_required') {
      helpers?.notify?.(result.message || 'Approval required before this action can complete.', 'info');
    } else if (result.status === 'error') {
      helpers?.notify?.(result.message || 'Action failed', 'error');
    }
    return result;
  } catch (err) {
    const message = normalizeErrorMessage(err);
    helpers?.notify?.(message, 'error');
    return { status: 'error', message, data: err };
  }
}
