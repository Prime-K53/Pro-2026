import type { ActionEligibilityContext, ResolvedAdvancedAction } from '../actions/types';
import { resolveActions } from '../actions/evaluateActions';
import type { TransactionModuleConfig } from './types';

/**
 * TransactionActionRegistry
 * -----------------------------------------------------------------------------
 * ADAPTER / CONFIGURATION LAYER ONLY.
 *
 * This is NOT a competing action registry. It stores per-module configuration
 * (the module's `AdvancedActionDefinition[]` plus status/detail/audit adapters)
 * and delegates ALL evaluation to the authoritative engine:
 *
 *   src/actions/evaluateActions.resolveActions  (visibility/enablement/ordering)
 *   src/actions/executeAction.executeResolvedAction (confirmation/idempotency/run)
 *
 * The existing `src/actions/registry.ts` remains the low-level definition store;
 * this registry is the transaction-interaction-facing configuration surface.
 */

const modules = new Map<string, TransactionModuleConfig<any>>();

export function registerTransactionModule<TRecord>(
  config: TransactionModuleConfig<TRecord>
): void {
  modules.set(config.moduleKey, config);
}

export function unregisterTransactionModule(moduleKey: string): void {
  modules.delete(moduleKey);
}

export function getTransactionModule<TRecord = unknown>(
  moduleKey: string
): TransactionModuleConfig<TRecord> | undefined {
  return modules.get(moduleKey) as TransactionModuleConfig<TRecord> | undefined;
}

export function listTransactionModules(): TransactionModuleConfig<any>[] {
  return Array.from(modules.values());
}

export function clearTransactionRegistry(): void {
  modules.clear();
}

/**
 * Resolve the eligible actions for a record using the authoritative engine.
 * Hidden actions are excluded; disabled actions are included (so the UI can
 * explain why they are unavailable) unless `includeDisabled` is false.
 */
export function resolveTransactionActions<TRecord>(
  config: TransactionModuleConfig<TRecord>,
  context: ActionEligibilityContext<TRecord>,
  options: { includeDisabled?: boolean } = {}
): ResolvedAdvancedAction<TRecord>[] {
  return resolveActions(config.actions, context, {
    includeHidden: false,
    includeDisabled: options.includeDisabled !== false,
  });
}