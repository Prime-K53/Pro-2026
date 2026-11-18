import type {
  ActionConfirmation,
  ActionEligibilityContext,
  ActionEvaluation,
  AdvancedActionDefinition,
  ResolvedAdvancedAction,
} from './types';

function uniqueStrings(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return Array.from(new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0)));
}

function hasAllPermissions(userPerms: readonly string[], required: readonly string[]): string[] {
  const set = new Set(userPerms);
  return required.filter((p) => !set.has(p));
}

function hasAnyPermission(userPerms: readonly string[], anyOf: readonly string[]): boolean {
  if (anyOf.length === 0) return true;
  const set = new Set(userPerms);
  return anyOf.some((p) => set.has(p));
}

function resolveConfirmation<TRecord>(
  action: AdvancedActionDefinition<TRecord>,
  ctx: ActionEligibilityContext<TRecord>
): ActionConfirmation | undefined {
  if (!action.confirmation) return undefined;
  return typeof action.confirmation === 'function' ? action.confirmation(ctx, action) : action.confirmation;
}

export function evaluateAction<TRecord = unknown>(
  action: AdvancedActionDefinition<TRecord>,
  ctx: ActionEligibilityContext<TRecord>
): ActionEvaluation {
  const userPerms = Array.isArray(ctx.permissions) ? ctx.permissions : [];
  const confirmation = resolveConfirmation(action, ctx);

  // Feature flag gate (action-level)
  if (action.featureFlag) {
    const enabledFlag = ctx.featureFlags?.[action.featureFlag] === true;
    if (!enabledFlag) {
      return { visible: false, enabled: false, state: 'hidden', reason: 'Feature not enabled', confirmation };
    }
  }

  // Authentication (frontend hint only; backend remains authoritative)
  if (!ctx.authenticated) {
    return { visible: false, enabled: false, state: 'hidden', reason: 'Authentication required', confirmation };
  }

  // Permission eligibility (all-of)
  const required = uniqueStrings([
    ...(action.requiredPermission ? [action.requiredPermission] : []),
    ...(action.requiredPermissions || []),
  ]);
  const missingPermissionsAll = hasAllPermissions(userPerms, required);
  if (missingPermissionsAll.length > 0) {
    return {
      visible: false,
      enabled: false,
      state: 'hidden',
      reason: 'Missing required permission',
      missingPermissions: missingPermissionsAll,
      confirmation,
    };
  }

  // Permission eligibility (any-of)
  const anyPerms = uniqueStrings(action.anyPermissions);
  if (anyPerms.length > 0 && !hasAnyPermission(userPerms, anyPerms)) {
    return {
      visible: false,
      enabled: false,
      state: 'hidden',
      reason: 'Missing required permission',
      missingPermissions: anyPerms,
      confirmation,
    };
  }

  // Custom visibility hook (deterministic; caller responsibility)
  if (typeof action.isVisible === 'function') {
    const visible = action.isVisible(ctx, action);
    if (!visible) {
      return { visible: false, enabled: false, state: 'hidden', reason: 'Not available for this record', confirmation };
    }
  }

  // Capability requirements
  const recordCaps = new Set(uniqueStrings(ctx.recordCapabilities));
  const requiredCaps = uniqueStrings(action.requiredCapabilities);
  const missingCapabilities = requiredCaps.filter((c) => !recordCaps.has(c));
  if (missingCapabilities.length > 0) {
    return {
      visible: true,
      enabled: false,
      state: 'disabled',
      reason: 'Required record capability unavailable',
      missingCapabilities,
      confirmation,
    };
  }

  // Status applicability (uses verified recordStatus provided by caller; no hardcoded status taxonomy)
  const statuses = uniqueStrings(action.applicableStatuses);
  if (statuses.length > 0) {
    const current = ctx.recordStatus ?? null;
    if (!current || !statuses.includes(current)) {
      return {
        visible: true,
        enabled: false,
        state: 'disabled',
        reason: current ? `Not available in status: ${current}` : 'Record status unavailable',
        confirmation,
      };
    }
  }

  // Runtime restrictions (visible but not executable)
  if (ctx.explicitlyDisabled) {
    return { visible: true, enabled: false, state: 'disabled', reason: 'Action disabled', confirmation };
  }
  if (ctx.isRecordProcessing) {
    return { visible: true, enabled: false, state: 'disabled', reason: 'Record is currently processing', confirmation };
  }
  if (ctx.approvalState && ['pending_approval', 'awaiting_approval', 'approval_required'].includes(ctx.approvalState)) {
    return {
      visible: true,
      enabled: false,
      state: 'disabled',
      reason: 'Action blocked pending approval',
      confirmation,
    };
  }
  if (ctx.financialPeriodRestricted) {
    return {
      visible: true,
      enabled: false,
      state: 'disabled',
      reason: 'Action restricted by financial period controls',
      confirmation,
    };
  }

  // Pending execution state
  if (ctx.pendingActionIds && ctx.pendingActionIds.includes(action.id)) {
    return { visible: true, enabled: false, state: 'pending', reason: 'Action in progress', confirmation };
  }

  // Custom enabled hook
  if (typeof action.isEnabled === 'function') {
    const result = action.isEnabled(ctx, action);
    if (typeof result === 'boolean') {
      if (!result) {
        return { visible: true, enabled: false, state: 'disabled', reason: 'Action not currently available', confirmation };
      }
    } else if (result && result.enabled === false) {
      return {
        visible: true,
        enabled: false,
        state: 'disabled',
        reason: result.reason || 'Action not currently available',
        confirmation,
      };
    }
  }

  return { visible: true, enabled: true, state: 'enabled', confirmation };
}

export function resolveActions<TRecord = unknown>(
  actions: readonly AdvancedActionDefinition<TRecord>[],
  ctx: ActionEligibilityContext<TRecord>,
  options: { includeHidden?: boolean; includeDisabled?: boolean } = {}
): ResolvedAdvancedAction<TRecord>[] {
  const includeHidden = options.includeHidden === true;
  const includeDisabled = options.includeDisabled !== false;

  const resolved = actions
    .map((definition) => ({ definition, evaluation: evaluateAction(definition, ctx) }))
    .filter(({ evaluation }) => (includeHidden || evaluation.visible))
    .filter(({ evaluation }) => (includeDisabled || evaluation.enabled));

  resolved.sort((a, b) => {
    const oa = a.definition.order ?? 0;
    const ob = b.definition.order ?? 0;
    if (oa !== ob) return oa - ob;
    return a.definition.label.localeCompare(b.definition.label);
  });

  return resolved;
}

export function isActionExecutable<TRecord = unknown>(resolved: ResolvedAdvancedAction<TRecord>): boolean {
  return resolved.evaluation.visible && resolved.evaluation.enabled && resolved.evaluation.state === 'enabled';
}

export function groupResolvedActions<TRecord = unknown>(
  resolved: readonly ResolvedAdvancedAction<TRecord>[]
): Array<{ key: string; label?: string; actions: ResolvedAdvancedAction<TRecord>[] }> {
  const groups = new Map<string, { key: string; label?: string; actions: ResolvedAdvancedAction<TRecord>[] }>();
  for (const item of resolved) {
    const key = item.definition.group || 'default';
    const label = item.definition.groupLabel;
    if (!groups.has(key)) groups.set(key, { key, label, actions: [] });
    const g = groups.get(key)!;
    if (!g.label && label) g.label = label;
    g.actions.push(item);
  }
  return Array.from(groups.values());
}
