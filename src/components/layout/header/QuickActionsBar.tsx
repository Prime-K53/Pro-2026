import React, { useRef } from 'react';
import { ChevronDown, MoreHorizontal, Zap, type LucideIcon } from 'lucide-react';
import {
  COMPACT_QUICK_ACTION_IDS,
  PRIMARY_QUICK_ACTION_IDS,
  QUICK_ACTIONS,
  type HeaderActionId,
  type HeaderMenuItem,
  type QuickActionDefinition,
} from '../../../config/navigation';
import type { HeaderTier } from '../../../hooks/useResponsiveHeader';
import { DropdownPanel } from './DropdownPanel';
import { HeaderMenuItems } from './HeaderMenuItems';

const toMenuItem = (action: QuickActionDefinition): HeaderMenuItem => ({
  id: `quick-${action.id}`,
  label: action.label,
  icon: action.icon,
  shortcut: action.shortcut,
  action: action.action,
  tone: action.tone === 'gold' ? 'accent' : 'default',
});

const actionTitle = (action: QuickActionDefinition) =>
  action.shortcut ? `${action.label} (${action.shortcut})` : action.label;

interface QuickActionButtonProps {
  action: QuickActionDefinition;
  onAction: (action: HeaderActionId) => void;
}

const QuickActionButton: React.FC<QuickActionButtonProps> = ({ action, onAction }) => {
  const Icon = action.icon;
  return (
    <button
      type="button"
      className={`hdr-quick-btn hdr-quick-btn-${action.tone}`}
      title={actionTitle(action)}
      aria-label={action.label}
      onClick={() => onAction(action.action)}
    >
      <Icon aria-hidden="true" className="hdr-quick-btn-icon" />
      <span className="hdr-quick-btn-label">{action.shortLabel}</span>
    </button>
  );
};

interface QuickMenuProps {
  id: string;
  label: string;
  accessibleLabel?: string;
  panelHeading: string;
  icon: LucideIcon;
  items: QuickActionDefinition[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (action: HeaderActionId) => void;
  triggerClassName: string;
  panelClassName?: string;
}

const QuickMenu: React.FC<QuickMenuProps> = ({
  id,
  label,
  accessibleLabel,
  panelHeading,
  icon: Icon,
  items,
  open,
  onOpenChange,
  onAction,
  triggerClassName,
  panelClassName = '',
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const buttonId = `hdr-${id}-button`;
  const panelId = `hdr-${id}-menu`;

  const handleSelect = (item: HeaderMenuItem) => {
    onOpenChange(false);
    if (item.action) onAction(item.action);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  return (
    <div className="hdr-quick-menu-wrap">
      <button
        ref={triggerRef}
        id={buttonId}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={accessibleLabel}
        onClick={() => onOpenChange(!open)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) onOpenChange(true);
          }
        }}
      >
        <Icon aria-hidden="true" className="hdr-quick-btn-icon" />
        <span>{label}</span>
        <ChevronDown aria-hidden="true" className="hdr-quick-chevron" />
      </button>

      <DropdownPanel
        id={panelId}
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={triggerRef}
        labelledBy={buttonId}
        align="start"
        className={`hdr-quick-panel ${panelClassName}`.trim()}
      >
        <div className="hdr-menu-heading" aria-hidden="true">
          {panelHeading}
        </div>
        <HeaderMenuItems items={items.map(toMenuItem)} onSelect={handleSelect} />
      </DropdownPanel>
    </div>
  );
};

interface QuickActionsBarProps {
  tier: HeaderTier;
  openMenuId: string | null;
  onOpenChange: (id: string | null) => void;
  onAction: (action: HeaderActionId) => void;
}

export const QuickActionsBar: React.FC<QuickActionsBarProps> = ({
  tier,
  openMenuId,
  onOpenChange,
  onAction,
}) => {
  if (tier === 'mobile') {
    return (
      <div className="hdr-quick-actions" aria-label="Quick actions">
        <QuickMenu
          id="quick-actions"
          label="Quick Actions"
          accessibleLabel="Quick actions"
          panelHeading="Quick Actions"
          icon={Zap}
          items={QUICK_ACTIONS}
          open={openMenuId === 'quick-actions'}
          onOpenChange={open => onOpenChange(open ? 'quick-actions' : null)}
          onAction={onAction}
          triggerClassName="hdr-quick-menu-trigger"
          panelClassName="hdr-quick-panel-wide"
        />
      </div>
    );
  }

  let visibleActions = QUICK_ACTIONS;
  let overflowActions: QuickActionDefinition[] = [];

  if (tier === 'medium') {
    visibleActions = QUICK_ACTIONS.filter(action =>
      PRIMARY_QUICK_ACTION_IDS.includes(action.id)
    );
    overflowActions = QUICK_ACTIONS.filter(
      action => !PRIMARY_QUICK_ACTION_IDS.includes(action.id)
    );
  } else if (tier === 'compact') {
    visibleActions = QUICK_ACTIONS.filter(action => COMPACT_QUICK_ACTION_IDS.includes(action.id));
    overflowActions = QUICK_ACTIONS.filter(
      action => !COMPACT_QUICK_ACTION_IDS.includes(action.id)
    );
  }

  return (
    <div className="hdr-quick-actions" aria-label="Quick actions">
      {visibleActions.map((action, index) => (
        <React.Fragment key={action.id}>
          {tier === 'wide' && index === 4 ? (
            <span className="hdr-quick-divider" aria-hidden="true" />
          ) : null}
          <QuickActionButton action={action} onAction={onAction} />
        </React.Fragment>
      ))}

      {overflowActions.length > 0 ? (
        <QuickMenu
          id="quick-more"
          label="More"
          accessibleLabel="More quick actions"
          panelHeading="More actions"
          icon={MoreHorizontal}
          items={overflowActions}
          open={openMenuId === 'quick-more'}
          onOpenChange={open => onOpenChange(open ? 'quick-more' : null)}
          onAction={onAction}
          triggerClassName="hdr-quick-btn hdr-quick-btn-more"
          panelClassName="hdr-quick-panel-wide"
        />
      ) : null}
    </div>
  );
};
