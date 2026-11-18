import React from 'react';
import type { AdvancedActionDefinition, ResolvedAdvancedAction } from '../../actions/types';
import { evaluateAction } from '../../actions/evaluateActions';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';

/**
 * Legacy-compatible item shape preserved for existing RowActionMenu consumers.
 * Phase 2A: no behavior changes for legacy consumers; new framework is opt-in via AdvancedActionsMenu/actions APIs.
 */
export interface RowActionItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  dividerBefore?: boolean;
}

interface RowActionMenuProps {
  items: RowActionItem[];
  label?: string;
  className?: string;
}

function toLegacyResolvedActions(items: RowActionItem[]): ResolvedAdvancedAction<void>[] {
  const groups: string[] = [];
  let currentGroup = 'group-0';
  groups.push(currentGroup);

  return items.map((item, index) => {
    if (item.dividerBefore && index > 0) {
      currentGroup = `group-${index}`;
    }
    const definition: AdvancedActionDefinition<void> = {
      id: item.id,
      label: item.label,
      icon: item.icon,
      group: currentGroup,
      order: index,
      risk: item.danger ? 'destructive' : 'safe',
      destructive: item.danger,
      execute: () => {
        item.onClick();
      },
    };
    const evaluation = evaluateAction(definition, { authenticated: true, permissions: [] });
    const disabledEval = item.disabled
      ? { ...evaluation, enabled: false, state: 'disabled' as const, reason: evaluation.reason || 'Unavailable' }
      : evaluation;
    return { definition, evaluation: disabledEval };
  });
}

/**
 * Compatibility wrapper: preserves legacy props/API and delegates rendering/execution behavior
 * to the shared advanced menu implementation without enabling advanced policy features for callers.
 */
export function RowActionMenu({ items, label = 'Row actions', className = '' }: RowActionMenuProps) {
  const resolved = React.useMemo(() => toLegacyResolvedActions(items), [items]);
  return <AdvancedActionsMenu actions={resolved} label={label} className={className} />;
}

export type { RowActionItem as LegacyRowActionItem };
