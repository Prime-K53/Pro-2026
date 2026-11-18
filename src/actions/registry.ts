import type { AdvancedActionDefinition } from './types';

/**
 * Central in-memory action registry for opt-in advanced actions.
 * Phase 2A provides infrastructure only; module-specific business actions
 * are registered by future phases (no module migrations in Phase 2A).
 */
const definitions = new Map<string, AdvancedActionDefinition<any>>();

export function registerAction<TRecord = unknown>(action: AdvancedActionDefinition<TRecord>): void {
  if (!action?.id) {
    throw new Error('Action definition requires a stable id');
  }
  definitions.set(action.id, action as AdvancedActionDefinition<any>);
}

export function registerActions<TRecord = unknown>(actions: readonly AdvancedActionDefinition<TRecord>[]): void {
  for (const a of actions) registerAction(a);
}

export function unregisterAction(actionId: string): boolean {
  return definitions.delete(actionId);
}

export function clearActionRegistry(): void {
  definitions.clear();
}

export function getActionDefinition<TRecord = unknown>(actionId: string): AdvancedActionDefinition<TRecord> | undefined {
  return definitions.get(actionId) as AdvancedActionDefinition<TRecord> | undefined;
}

export function listRegisteredActions<TRecord = unknown>(filter?: {
  moduleKey?: string;
  entityType?: string;
}): AdvancedActionDefinition<TRecord>[] {
  const all = Array.from(definitions.values()) as AdvancedActionDefinition<TRecord>[];
  if (!filter) return all;
  return all.filter((a) => {
    if (filter.moduleKey && a.moduleKey !== filter.moduleKey) return false;
    if (filter.entityType && a.entityType !== filter.entityType) return false;
    return true;
  });
}
