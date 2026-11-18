import React, { useRef } from 'react';
import {
  Building2,
  ChevronDown,
  CircleHelp,
  LogOut,
  Palette,
  Printer,
  Server,
  Settings,
  Shield,
  Sparkles,
} from 'lucide-react';
import { useAccounting } from '../../../context/AccountingContext';
import { useAuth } from '../../../context/AuthContext';
import type { ThemeStyle } from '../../../types/accounting';
import { DropdownPanel } from './DropdownPanel';
import { HeaderHelpContent } from './HeaderMenuItems';

interface UserProfileMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrint: () => void;
}

const THEMES: ThemeStyle[] = ['classic', 'slate', 'midnight'];

const THEME_LABELS: Record<ThemeStyle, string> = {
  classic: 'Classic Blue',
  slate: 'Modern Slate',
  midnight: 'Midnight Dark',
};

export const UserProfileMenu: React.FC<UserProfileMenuProps> = ({
  open,
  onOpenChange,
  onPrint,
}) => {
  const { user, activeCompany, companies, switchCompany, logout } = useAuth();
  const { companyProfile, updateCompanyProfile, setCurrentView, setIsCommandPaletteOpen } =
    useAccounting();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const userDisplayName = user?.displayName || user?.username || 'User';
  const userInitials =
    userDisplayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase())
      .join('') || 'U';
  const role = activeCompany?.role || companyProfile.currentUserRole;

  const closeAndRun = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  const navigateTo = (view: string) => closeAndRun(() => setCurrentView(view));

  return (
    <div className="hdr-user">
      <button
        ref={triggerRef}
        id="hdr-user-menu-button"
        type="button"
        className="hdr-user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="hdr-user-menu"
        aria-label={`Account menu for ${userDisplayName}, ${role}`}
        title={`${userDisplayName} — ${role}`}
        onClick={() => onOpenChange(!open)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) onOpenChange(true);
          }
        }}
      >
        <span className="hdr-avatar" aria-hidden="true">
          {userInitials}
          <span className="hdr-avatar-status" />
        </span>
        <span className="hdr-user-copy" aria-hidden="true">
          <span className="hdr-user-name">{userDisplayName}</span>
          <span className="hdr-user-role">{role}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`hdr-user-chevron${open ? ' is-open' : ''}`}
        />
      </button>

      <DropdownPanel
        id="hdr-user-menu"
        open={open}
        onClose={() => onOpenChange(false)}
        anchorRef={triggerRef}
        labelledBy="hdr-user-menu-button"
        align="end"
        className="hdr-user-panel"
      >
        <div className="hdr-user-panel-identity">
          <div className="hdr-user-panel-copy">
            <div className="hdr-user-panel-name">{userDisplayName}</div>
            <div className="hdr-user-panel-email">{user?.email || 'No email on file'}</div>
          </div>
          <span className="hdr-avatar hdr-avatar-lg" aria-hidden="true">
            {userInitials}
          </span>
        </div>

        {activeCompany ? (
          <div className="hdr-user-company">
            <Building2 aria-hidden="true" className="hdr-user-company-icon" />
            <span className="hdr-user-company-name">{activeCompany.name}</span>
            <span className="hdr-role-badge">{role}</span>
          </div>
        ) : null}

        {companies.length > 1 ? (
          <div className="hdr-user-section" role="group" aria-label="Switch company">
            <div className="hdr-menu-heading">Switch company</div>
            <div className="hdr-company-list">
              {companies.map(company => {
                const isActive = activeCompany?.id === company.id;
                return (
                  <button
                    key={company.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    data-menu-item
                    className={`hdr-menu-item hdr-company-option${isActive ? ' is-active' : ''}`}
                    onClick={() => {
                      onOpenChange(false);
                      void switchCompany(Number(company.id));
                    }}
                  >
                    <Building2 aria-hidden="true" className="hdr-menu-item-icon" />
                    <span className="hdr-menu-item-label">{company.name}</span>
                    <span className="hdr-company-option-role">{company.role}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="hdr-user-section" role="group" aria-label="Appearance">
          <div className="hdr-menu-heading">
            <Palette aria-hidden="true" className="hdr-menu-heading-icon" />
            Appearance
          </div>
          <div className="hdr-theme-grid">
            {THEMES.map(theme => {
              const isActive = companyProfile.theme === theme;
              return (
                <button
                  key={theme}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  aria-label={THEME_LABELS[theme]}
                  title={THEME_LABELS[theme]}
                  data-menu-item
                  className={`hdr-theme-option${isActive ? ' is-active' : ''}`}
                  onClick={() => updateCompanyProfile({ theme })}
                >
                  <span className="hdr-theme-dot" data-theme-dot={theme} aria-hidden="true" />
                  <span className="hdr-theme-label">{THEME_LABELS[theme]}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="hdr-user-section" role="group" aria-label="Account and workspace">
          <button
            type="button"
            role="menuitem"
            data-menu-item
            className="hdr-menu-item"
            onClick={() => navigateTo('access-control')}
          >
            <Shield aria-hidden="true" className="hdr-menu-item-icon hdr-icon-emerald" />
            <span className="hdr-menu-item-label">Manage Users &amp; Permissions</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-item
            className="hdr-menu-item"
            onClick={() => navigateTo('settings')}
          >
            <Settings aria-hidden="true" className="hdr-menu-item-icon" />
            <span className="hdr-menu-item-label">Company Settings</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-item
            className="hdr-menu-item hdr-menu-item-accent"
            onClick={() =>
              closeAndRun(() => {
                setIsCommandPaletteOpen(true);
              })
            }
          >
            <Sparkles aria-hidden="true" className="hdr-menu-item-icon" />
            <span className="hdr-menu-item-label">Command Palette</span>
            <kbd className="hdr-menu-shortcut">Ctrl+K</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-item
            className="hdr-menu-item"
            onClick={() => closeAndRun(onPrint)}
          >
            <Printer aria-hidden="true" className="hdr-menu-item-icon" />
            <span className="hdr-menu-item-label">Print Current View</span>
            <kbd className="hdr-menu-shortcut">Ctrl+P</kbd>
          </button>
        </div>

        <div className="hdr-user-section" role="group" aria-label="Help and shortcuts">
          <div className="hdr-menu-heading">
            <CircleHelp aria-hidden="true" className="hdr-menu-heading-icon" />
            Help &amp; Shortcuts
          </div>
          <HeaderHelpContent compact />
        </div>

        <div className="hdr-menu-separator" role="separator" />
        <button
          type="button"
          role="menuitem"
          data-menu-item
          className="hdr-menu-item hdr-menu-item-warn"
          onClick={() => closeAndRun(() => void logout())}
        >
          <LogOut aria-hidden="true" className="hdr-menu-item-icon" />
          <span className="hdr-menu-item-label">Sign Out</span>
        </button>

        <div className="hdr-user-footer">
          <Server aria-hidden="true" className="hdr-user-footer-icon" />
          <span>Server-backed · {role}</span>
        </div>
      </DropdownPanel>
    </div>
  );
};
