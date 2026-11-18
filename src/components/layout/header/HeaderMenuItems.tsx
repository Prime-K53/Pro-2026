import React from 'react';
import { HELP_SHORTCUTS, type HeaderMenuItem } from '../../../config/navigation';

interface HeaderMenuItemsProps {
  items: HeaderMenuItem[];
  onSelect: (item: HeaderMenuItem) => void;
}

export const HeaderMenuItems: React.FC<HeaderMenuItemsProps> = ({ items, onSelect }) => (
  <>
    {items.map(item => {
      const Icon = item.icon;
      const toneClass =
        item.tone === 'accent'
          ? ' hdr-menu-item-accent'
          : item.tone === 'warn'
            ? ' hdr-menu-item-warn'
            : '';

      return (
        <React.Fragment key={item.id}>
          {item.separatorBefore && <div className="hdr-menu-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            data-menu-item
            className={`hdr-menu-item${toneClass}${item.emphasis ? ' hdr-menu-item-emphasis' : ''}`}
            onClick={() => onSelect(item)}
          >
            {Icon ? <Icon aria-hidden="true" className="hdr-menu-item-icon" /> : null}
            <span className="hdr-menu-item-label">{item.label}</span>
            {item.shortcut ? <kbd className="hdr-menu-shortcut">{item.shortcut}</kbd> : null}
          </button>
        </React.Fragment>
      );
    })}
  </>
);

interface HeaderHelpContentProps {
  compact?: boolean;
}

export const HeaderHelpContent: React.FC<HeaderHelpContentProps> = ({ compact = false }) => (
  <div className={`hdr-help${compact ? ' hdr-help-compact' : ''}`}>
    {!compact ? (
      <>
        <div className="hdr-help-title">Printing Management System</div>
        <p className="hdr-help-subtitle">Server-backed, multi-company accounting suite</p>
      </>
    ) : null}
    <div className="hdr-help-rows">
      {HELP_SHORTCUTS.map(shortcut => (
        <div key={shortcut.label} className="hdr-help-row">
          <span>{shortcut.label}</span>
          <kbd className="hdr-menu-shortcut">{shortcut.shortcut}</kbd>
        </div>
      ))}
    </div>
  </div>
);
