import React, { useRef } from 'react';
import {
  ChevronDown,
  Menu as MenuIcon,
  MoreHorizontal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import {
  HEADER_MENUS,
  PRIORITY_MENU_IDS,
  getMenuActiveState,
  type HeaderActionId,
  type HeaderMenuDefinition,
  type HeaderMenuItem,
} from '../../../config/navigation';
import type { HeaderTier } from '../../../hooks/useResponsiveHeader';
import { DropdownPanel } from './DropdownPanel';
import { HeaderHelpContent, HeaderMenuItems } from './HeaderMenuItems';

interface NavDropdownProps {
  id: string;
  label: string;
  accessibleLabel?: string;
  icon?: LucideIcon;
  open: boolean;
  active?: boolean;
  triggerClassName?: string;
  panelClassName?: string;
  align?: 'start' | 'end';
  onOpenChange: (open: boolean) => void;
  onAction: (action: HeaderActionId) => void;
  renderMenu: (select: (item: HeaderMenuItem) => void) => React.ReactNode;
}

const NavDropdown: React.FC<NavDropdownProps> = ({
  id,
  label,
  accessibleLabel,
  icon: Icon,
  open,
  active = false,
  triggerClassName = 'hdr-nav-trigger',
  panelClassName = '',
  align = 'start',
  onOpenChange,
  onAction,
  renderMenu,
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const buttonId = `hdr-${id}-button`;
  const panelId = `hdr-${id}-menu`;

  const handleSelect = (item: HeaderMenuItem) => {
    onOpenChange(false);
    if (item.action) onAction(item.action);
    // Returning focus to the trigger is the expected menu-button behaviour for
    // navigation commands. Modal-opening commands take focus when they mount.
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  return (
    <div className="hdr-nav-item">
      <button
        ref={triggerRef}
        id={buttonId}
        type="button"
        className={triggerClassName}
        data-active={active ? 'true' : undefined}
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
        {Icon ? <Icon aria-hidden="true" className="hdr-nav-trigger-icon" /> : null}
        <span className="hdr-nav-trigger-label">{label}</span>
        <ChevronDown aria-hidden="true" className="hdr-nav-trigger-chevron" />
      </button>

      <DropdownPanel
        id={panelId}
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={triggerRef}
        labelledBy={buttonId}
        align={align}
        className={panelClassName}
      >
        {renderMenu(handleSelect)}
      </DropdownPanel>
    </div>
  );
};

interface FlattenedMenusProps {
  menus: HeaderMenuDefinition[];
  onSelect: (item: HeaderMenuItem) => void;
}

const FlattenedMenus: React.FC<FlattenedMenusProps> = ({ menus, onSelect }) => (
  <div className="hdr-menu-groups">
    {menus.map(menu => (
      <div key={menu.id} className="hdr-menu-group" role="group" aria-label={menu.label}>
        <div className="hdr-menu-heading" aria-hidden="true">
          {menu.label}
        </div>
        {menu.id === 'help' ? (
          <HeaderHelpContent compact />
        ) : (
          <HeaderMenuItems items={menu.items} onSelect={onSelect} />
        )}
      </div>
    ))}
    {!menus.some(menu => menu.id === 'help') ? (
      <div className="hdr-menu-group" role="group" aria-label="Help & shortcuts">
        <div className="hdr-menu-heading" aria-hidden="true">
          Help &amp; Shortcuts
        </div>
        <HeaderHelpContent compact />
      </div>
    ) : null}
  </div>
);

interface PrimaryNavigationProps {
  tier: HeaderTier;
  currentView: string;
  openMenuId: string | null;
  onOpenChange: (id: string | null) => void;
  onAction: (action: HeaderActionId) => void;
}

export const PrimaryNavigation: React.FC<PrimaryNavigationProps> = ({
  tier,
  currentView,
  openMenuId,
  onOpenChange,
  onAction,
}) => {
  if (tier === 'mobile') return null;

  const isMenuOpen = (id: string) => openMenuId === `nav-${id}`;
  const setMenuOpen = (id: string) => (open: boolean) => onOpenChange(open ? `nav-${id}` : null);

  const menuContent = (menu: HeaderMenuDefinition, select: (item: HeaderMenuItem) => void) =>
    menu.id === 'help' ? (
      <HeaderHelpContent />
    ) : (
      <HeaderMenuItems items={menu.items} onSelect={select} />
    );

  if (tier === 'compact') {
    const active = HEADER_MENUS.some(menu => getMenuActiveState(menu, currentView));
    return (
      <nav className="hdr-nav" aria-label="Primary navigation">
        <NavDropdown
          id="nav-menu"
          label="Menu"
          accessibleLabel="All navigation menus"
          icon={MenuIcon}
          active={active}
          open={isMenuOpen('menu')}
          onOpenChange={setMenuOpen('menu')}
          onAction={onAction}
          triggerClassName="hdr-nav-trigger hdr-nav-trigger-menu"
          panelClassName="hdr-menu-panel-wide"
          renderMenu={select => <FlattenedMenus menus={HEADER_MENUS} onSelect={select} />}
        />
      </nav>
    );
  }

  if (tier === 'medium') {
    const priorityMenus = HEADER_MENUS.filter(menu => PRIORITY_MENU_IDS.includes(menu.id));
    const overflowMenus = HEADER_MENUS.filter(menu => !PRIORITY_MENU_IDS.includes(menu.id));
    const overflowActive = overflowMenus.some(menu => getMenuActiveState(menu, currentView));

    return (
      <nav className="hdr-nav" aria-label="Primary navigation">
        {priorityMenus.map(menu => (
          <NavDropdown
            key={menu.id}
            id={`nav-${menu.id}`}
            label={menu.triggerLabel ?? menu.label}
            accessibleLabel={menu.triggerLabel ? menu.label : undefined}
            active={getMenuActiveState(menu, currentView)}
            open={isMenuOpen(menu.id)}
            onOpenChange={setMenuOpen(menu.id)}
            onAction={onAction}
            renderMenu={select => menuContent(menu, select)}
          />
        ))}
        <NavDropdown
          id="nav-more"
          label="More"
          accessibleLabel="More navigation menus"
          icon={MoreHorizontal}
          active={overflowActive}
          open={isMenuOpen('more')}
          onOpenChange={setMenuOpen('more')}
          onAction={onAction}
          triggerClassName="hdr-nav-trigger hdr-nav-trigger-more"
          panelClassName="hdr-menu-panel-wide"
          renderMenu={select => <FlattenedMenus menus={overflowMenus} onSelect={select} />}
        />
      </nav>
    );
  }

  return (
    <nav className="hdr-nav" aria-label="Primary navigation">
      {HEADER_MENUS.map(menu => (
        <NavDropdown
          key={menu.id}
          id={`nav-${menu.id}`}
          label={menu.triggerLabel ?? menu.label}
          accessibleLabel={menu.triggerLabel ? menu.label : undefined}
          icon={menu.id === 'ai' ? Sparkles : undefined}
          active={getMenuActiveState(menu, currentView)}
          open={isMenuOpen(menu.id)}
          onOpenChange={setMenuOpen(menu.id)}
          onAction={onAction}
          renderMenu={select => menuContent(menu, select)}
        />
      ))}
    </nav>
  );
};
