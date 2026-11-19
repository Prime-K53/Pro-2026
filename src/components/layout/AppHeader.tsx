import React, { useEffect, useRef, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import type { HeaderActionId } from '../../config/navigation';
import { useCompanyIdentity } from '../../hooks/useCompanyIdentity';
import { useResponsiveHeader } from '../../hooks/useResponsiveHeader';
import { CompanyContext } from './header/CompanyContext';
import { GlobalSearch } from './header/GlobalSearch';
import { PrimaryNavigation } from './header/PrimaryNavigation';
import { QuickActionsBar } from './header/QuickActionsBar';
import { UserProfileMenu } from './header/UserProfileMenu';

/**
 * Application header.
 *
 * The primary row carries identity, navigation, search and the account menu.
 * The secondary toolbar carries the quick actions and authoritative company
 * context. All commands are routed through the metadata-driven action
 * dispatcher below so the original handlers remain the single implementation.
 */
export const AppHeader: React.FC = () => {
  const { activeCompany } = useAuth();
  const {
    currentView,
    setCurrentView,
    setIsNewInvoiceOpen,
    setIsEnterBillOpen,
    setIsPayBillsOpen,
    setIsWriteCheckOpen,
    setIsReceivePaymentOpen,
    setIsJournalEntryOpen,
    setIsOcrScannerOpen,
    setIsIifImportOpen,
    setIsStatementOpen,
    setIsCommandPaletteOpen,
    setIsPosModalOpen,
    resetToDemoData,
    exportDataToJson,
    importDataFromJson,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    isMobileDrawerOpen,
    setIsMobileDrawerOpen,
  } = useAccounting();

  const { tier, isNarrow } = useResponsiveHeader();
  const companyIdentity = useCompanyIdentity(activeCompany?.id);

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Navigation and drawer changes should never leave a stale dropdown open.
  useEffect(() => {
    setOpenMenuId(null);
  }, [currentView]);

  useEffect(() => {
    if (isMobileDrawerOpen) setOpenMenuId(null);
  }, [isMobileDrawerOpen]);

  const handleImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = loadEvent => {
        const content = loadEvent.target?.result as string;
        if (content) {
          importDataFromJson(content);
        }
      };
      reader.readAsText(file);
    }
    if (event.target) event.target.value = '';
  };

  const handlePrint = () => {
    window.print();
  };

  const handleNavigationToggle = () => {
    if (isNarrow) {
      setIsMobileDrawerOpen(!isMobileDrawerOpen);
    } else {
      setIsSidebarCollapsed(!isSidebarCollapsed);
    }
  };

  const runAction = (action: HeaderActionId) => {
    switch (action) {
      case 'file.export':
        exportDataToJson();
        return;
      case 'file.restore':
        fileInputRef.current?.click();
        return;
      case 'file.import':
        setIsIifImportOpen(true);
        return;
      case 'file.print':
        handlePrint();
        return;
      case 'file.reset':
        if (
          confirm(
            'Reset the cached lists in this browser to the default sample data? The server ledger is not changed.'
          )
        ) {
          resetToDemoData();
        }
        return;
      case 'edit.settings':
        setCurrentView('settings');
        return;
      case 'edit.journal':
        setIsJournalEntryOpen(true);
        return;
      case 'lists.accounts':
        setCurrentView('accounts');
        return;
      case 'lists.inventory':
        setCurrentView('inventory');
        return;
      case 'lists.customers':
        setCurrentView('customers');
        return;
      case 'lists.vendors':
        setCurrentView('vendors');
        return;
      case 'lists.payroll':
        setCurrentView('payroll');
        return;
      case 'activities.invoice':
        setIsNewInvoiceOpen(true);
        return;
      case 'activities.receive-payment':
        setIsReceivePaymentOpen(true);
        return;
      case 'activities.enter-bill':
        setIsEnterBillOpen(true);
        return;
      case 'activities.pay-bills':
        setIsPayBillsOpen(true);
        return;
      case 'activities.write-check':
        setIsWriteCheckOpen(true);
        return;
      case 'activities.statements':
        setIsStatementOpen(true);
        return;
      case 'activities.payroll':
        setCurrentView('payroll');
        return;
      case 'activities.pos':
        setIsPosModalOpen(true);
        return;
      case 'smart-ops.open':
        setCurrentView('smart-operations');
        return;
      case 'reports.open':
        setCurrentView('reports');
        return;
      case 'banking.register':
        setCurrentView('banking');
        return;
      case 'banking.reconcile':
        setCurrentView('reconciliation');
        return;
      case 'banking.feeds':
        setCurrentView('banking');
        return;
      case 'ai.ocr':
        setIsOcrScannerOpen(true);
        return;
      case 'ai.agent':
        setCurrentView('ai-agent');
        return;
      default:
        return;
    }
  };

  const navigationLabel = isNarrow
    ? isMobileDrawerOpen
      ? 'Close navigation menu'
      : 'Open navigation menu'
    : isSidebarCollapsed
      ? 'Expand navigation sidebar'
      : 'Collapse navigation sidebar';

  return (
    <header className="app-header no-print select-none" data-header-tier={tier}>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleImportFile}
        accept=".sbp,.json"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      <div className="app-header-primary">
        <div className="app-header-left">
          <button
            type="button"
            className="hdr-icon-btn hdr-nav-toggle"
            onClick={handleNavigationToggle}
            title={navigationLabel}
            aria-label={navigationLabel}
            aria-controls={isNarrow ? 'app-navigation-drawer' : 'app-navigation-sidebar'}
            aria-expanded={isNarrow ? isMobileDrawerOpen : !isSidebarCollapsed}
            data-header-nav-toggle
          >
            <PanelLeft aria-hidden="true" className="h-4 w-4" />
          </button>

          <button
            type="button"
            className="hdr-brand"
            onClick={() => setCurrentView('workflow')}
            title="Printing Management System Home"
            aria-label="Printing Management System home"
          >
            <span className="hdr-brand-mark" aria-hidden="true">
              PM
            </span>
            <span className="hdr-brand-text">
              Printing <span className="hdr-brand-text-accent">Management</span> System
            </span>
          </button>

          <PrimaryNavigation
            tier={tier}
            currentView={currentView}
            openMenuId={openMenuId}
            onOpenChange={setOpenMenuId}
            onAction={runAction}
          />
        </div>

        <div className="app-header-right">
          <GlobalSearch
            tier={tier}
            onOpen={() => {
              setOpenMenuId(null);
              setIsCommandPaletteOpen(true);
            }}
          />
          <span className="hdr-divider" aria-hidden="true" />
          <UserProfileMenu
            open={openMenuId === 'user'}
            onOpenChange={open => setOpenMenuId(open ? 'user' : null)}
            onPrint={handlePrint}
          />
        </div>
      </div>

      <div className="app-header-toolbar">
        <QuickActionsBar
          tier={tier}
          openMenuId={openMenuId}
          onOpenChange={setOpenMenuId}
          onAction={runAction}
        />
        <CompanyContext
          company={companyIdentity.company}
          loading={companyIdentity.loading}
          error={companyIdentity.error}
          fallbackName={activeCompany?.name}
        />
      </div>
    </header>
  );
};
