import type {
  ActionEligibilityContext,
  AdvancedActionDefinition,
  ResolvedAdvancedAction,
} from '../actions/types';
import { evaluateAction } from '../actions/evaluateActions';
import type { TransactionModuleConfig } from './types';
import { resolveRecordStatus } from './TransactionStatusResolver';

/**
 * TransactionPermissionResolver
 * -----------------------------------------------------------------------------
 * Thin adapter over the authoritative engine. It builds the eligibility context
 * (auth + permissions + record status/capabilities) and delegates every decision
 * to `evaluateAction` from src/actions. It does NOT maintain a parallel ruleset.
 */

export interface BuildContextArgs<TRecord> {
  authenticated: boolean;
  permissions: readonly string[];
  role?: string | null;
  companyId?: string | number | null;
  record: TRecord;
  financialPeriodRestricted?: boolean;
  approvalState?: string | null;
  pendingActionIds?: readonly string[];
}

export function buildEligibilityContext<TRecord>(
  config: TransactionModuleConfig<TRecord>,
  args: BuildContextArgs<TRecord>
): ActionEligibilityContext<TRecord> {
  const { status, capabilities } = resolveRecordStatus(config, args.record);
  const base: ActionEligibilityContext<TRecord> = {
    authenticated: args.authenticated,
    permissions: args.permissions,
    role: args.role ?? null,
    companyId: args.companyId ?? null,
    moduleKey: config.moduleKey,
    entityType: config.entityType,
    record: args.record,
    recordStatus: status ?? null,
    recordCapabilities: capabilities ?? [],
    financialPeriodRestricted: args.financialPeriodRestricted ?? false,
    approvalState: args.approvalState ?? null,
    pendingActionIds: args.pendingActionIds ?? [],
  };
  return typeof config.buildContext === 'function'
    ? config.buildContext(args.record, base)
    : base;
}

/** Evaluate a single definition against a context (delegates to the engine). */
export function evaluateForRecord<TRecord>(
  definition: AdvancedActionDefinition<TRecord>,
  context: ActionEligibilityContext<TRecord>
): ResolvedAdvancedAction<TRecord> {
  return { definition, evaluation: evaluateAction(definition, context) };
}