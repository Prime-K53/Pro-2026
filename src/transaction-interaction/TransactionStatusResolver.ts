import type { AdvancedActionDefinition } from '../actions/types';
import type { RecordStatusResolution, TransactionModuleConfig } from './types';

/**
 * TransactionStatusResolver
 * -----------------------------------------------------------------------------
 * Adapter that turns a module record into the `recordStatus` / `recordCapabilities`
 * the authoritative engine (src/actions/evaluateActions) expects. It invents no
 * status taxonomy: modules declare their own via `resolveStatus`, otherwise the
 * record's own `status` field is used.
 */

export function resolveRecordStatus<TRecord>(
  config: TransactionModuleConfig<TRecord>,
  record: TRecord
): RecordStatusResolution {
  if (typeof config.resolveStatus === 'function') {
    return config.resolveStatus(record);
  }
  const status = (record as { status?: string | null } | null | undefined)?.status ?? null;
  return { status };
}

/** Pure helper: is `status` accepted by the action's `applicableStatuses`? */
export function isStatusApplicable<TRecord>(
  action: AdvancedActionDefinition<TRecord>,
  status: string | null | undefined
): boolean {
  const allowed = action.applicableStatuses;
  if (!allowed || allowed.length === 0) return true;
  if (!status) return false;
  return allowed.includes(status);
}