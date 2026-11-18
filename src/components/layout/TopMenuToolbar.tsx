import React, { useState, useRef, useEffect } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import {
  FileText,
  DollarSign,
  CreditCard,
  Receipt,
  Users,
  Search,
  Server,
  Shield,
  Download,
  CheckCircle2,
  RefreshCw,
  FolderOpen,
  Printer,
  Sparkles,
  PanelLeft,
  Building2,
  LogOut,
  User,
  Settings,
  ChevronDown,
  Palette,
  CircleHelp,
  Plug,
} from 'lucide-react';
import { ThemeStyle } from '../../types/accounting';

export const TopMenuToolbar: React.FC = () => {
  const {
    user,
    activeCompany,
    companies,
    switchCompany,
    logout,
  } = useAuth();
  const {
    companyProfile,
    updateCompanyProfile,
    currentView,
    setCurrentView,
    setIsNewInvoiceOpen,
    setIsEnterBillOpen,
    setIsPayBillsOpen,
    setIsWriteCheckOpen,
    setIsReceivePaymentOpen,
    setIsJournalEntryOpen,
    setIsNewCustomerOpen,
    setIsNewVendorOpen,
    setIsNewItemOpen,
    setIsNewEmployeeOpen,
    setIsOcrScannerOpen,
    setIsIifImportOpen,
    setIsStatementOpen,
    setIsCommandPaletteOpen,
    resetToDemoData,
    exportDataToJson,
    importDataFromJson,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    isMobileDrawerOpen,
    setIsMobileDrawerOpen,
  } = useAccounting();

  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);

  // Close menus on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveMenu(null);
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);
  useEffect(() => {
    const handleDocClick = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleDocClick);
    return () => document.removeEventListener('mousedown', handleDocClick);
  }, []);

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = event => {
        const content = event.target?.result as string;
        if (content) {
          importDataFromJson(content);
        }
      };
      reader.readAsText(file);
    }
    if (e.target) e.target.value = '';
  };

  const handlePrint = () => {
    window.print();
  };

  const userDisplayName = user?.displayName || user?.username || 'User';
  const userInitials = userDisplayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || 'U';
  const themeLabel: Record<ThemeStyle, string> = {
    classic: 'Classic Blue',
    slate: 'Modern Slate',
    midnight: 'Midnight Dark',
  };
  const themeDotClass: Record<ThemeStyle, string> = {
    classic: 'bg-amber-400',
    slate: 'bg-white ring-1 ring-slate-400',
    midnight: 'bg-brand-600',
  };

  return (
    <div
      ref={menuBarRef}
      className="app-topbar no-print select-none"
    >
      {/* Hidden file input for company data import */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleImportFile}
        accept=".sbp,.json"
        className="hidden"
      />

      {/* Primary Desktop Menu Bar (File, Edit, Lists, Activities, Reports, Banking, AI, Help) */}
      <div className="app-topbar-row">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          {/* Sidebar Drawer / Collapse Toggle */}
          <button
            onClick={() => {
              if (window.innerWidth < 1024) {
                setIsMobileDrawerOpen(!isMobileDrawerOpen);
              } else {
                setIsSidebarCollapsed(!isSidebarCollapsed);
              }
            }}
            className="topbar-icon-btn"
            title="Toggle Navigation Sidebar"
            aria-label="Toggle Navigation Sidebar"
          >
            <PanelLeft className="w-4 h-4" />
          </button>

          {/* Logo / Brand mark */}
          <button
            onClick={() => setCurrentView('workflow')}
            className="brand-lockup"
            title="Printing Management System Home"
          >
            <span className="brand-mark">
              PM
            </span>
            <span className="brand-name">
              Printing <span className="brand-name-accent">Management</span> System
            </span>
          </button>

          <div className="hidden min-w-0 items-center gap-0.5 whitespace-nowrap lg:flex">
          {/* Menu Item: File */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'file' ? null : 'file')} aria-expanded={activeMenu === 'file'} aria-haspopup="menu"
              className={`menu-trigger ${
                activeMenu === 'file' ? 'menu-trigger-open' : ''
              }`}
            >
              File
            </button>
            {activeMenu === 'file' && (
              <div className="menu-pop w-56">
                <button
                  onClick={() => {
                    exportDataToJson();
                    setActiveMenu(null);
                  }}
                  className="menu-item flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Download className="w-3.5 h-3.5 text-slate-500" /> Download Browser Working Copy (.json)
                  </span>
                </button>
                <button
                  onClick={() => {
                    fileInputRef.current?.click();
                    setActiveMenu(null);
                  }}
                  className="menu-item flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <FolderOpen className="w-3.5 h-3.5 text-slate-500" /> Restore Browser Working Copy
                  </span>
                </button>
                <button
                  onClick={() => {
                    setIsIifImportOpen(true);
                    setActiveMenu(null);
                  }}
                  className="menu-item menu-item-accent flex items-center justify-between font-semibold"
                >
                  <span className="flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5" /> Import QuickBooks IIF / OFX...
                  </span>
                </button>
                <div className="menu-separator"></div>
                <button
                  onClick={() => {
                    handlePrint();
                    setActiveMenu(null);
                  }}
                  className="menu-item flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Printer className="w-3.5 h-3.5 text-slate-500" /> Print View
                  </span>
                  <span className="text-slate-400">Ctrl+P</span>
                </button>
                <div className="menu-separator"></div>
                <button
                  onClick={() => {
                    if (confirm('Reset the cached lists in this browser to the default sample data? The server ledger is not changed.')) {
                      resetToDemoData();
                    }
                    setActiveMenu(null);
                  }}
                  className="menu-item menu-item-warn flex items-center gap-2"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Reload Demo Lists in Browser
                </button>
              </div>
            )}
          </div>

          {/* Menu Item: Edit */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'edit' ? null : 'edit')} aria-expanded={activeMenu === 'edit'} aria-haspopup="menu"
              className={`menu-trigger ${
                activeMenu === 'edit' ? 'menu-trigger-open' : ''
              }`}
            >
              Edit
            </button>
            {activeMenu === 'edit' && (
              <div className="menu-pop w-52">
                <button
                  onClick={() => {
                    setCurrentView('settings');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Company Preferences & EIN
                </button>
                <button
                  onClick={() => {
                    setIsJournalEntryOpen(true);
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Make General Journal Entries
                </button>
              </div>
            )}
          </div>

          {/* Menu Item: Lists */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'lists' ? null : 'lists')} aria-expanded={activeMenu === 'lists'} aria-haspopup="menu"
              className={`menu-trigger ${
                activeMenu === 'lists' ? 'menu-trigger-open' : ''
              }`}
            >
              Lists
            </button>
            {activeMenu === 'lists' && (
              <div className="menu-pop w-56">
                <button
                  onClick={() => {
                    setCurrentView('accounts');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Chart of Accounts (Ctrl+A)
                </button>
                <button
                  onClick={() => {
                    setCurrentView('inventory');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Item & Service List (Ctrl+I)
                </button>
                <button
                  onClick={() => {
                    setCurrentView('customers');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Customer Center (Ctrl+J)
                </button>
                <button
                  onClick={() => {
                    setCurrentView('vendors');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Vendor Center
                </button>
                <button
                  onClick={() => {
                    setCurrentView('payroll');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Employee Directory
                </button>
              </div>
            )}
          </div>

          {/* Menu Item: Activities */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'activities' ? null : 'activities')} aria-expanded={activeMenu === 'activities'} aria-haspopup="menu"
              className={`menu-trigger ${
                activeMenu === 'activities' ? 'menu-trigger-open' : ''
              }`}
            >
              Activities
            </button>
            {activeMenu === 'activities' && (
              <div className="menu-pop w-56">
                <button
                  onClick={() => {
                    setIsNewInvoiceOpen(true);
                    setActiveMenu(null);
                  }}
                  className="menu-item flex justify-between"
                >
                  <span>Create Invoice</span>
                  <span className="text-slate-400">Alt+N</span>
                </button>
                <button
                  onClick={() => {
                    setIsReceivePaymentOpen(true);
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Receive Customer Payments
                </button>
                <div className="menu-separator"></div>
                <button
                  onClick={() => {
                    setIsEnterBillOpen(true);
                    setActiveMenu(null);
                  }}
                  className="menu-item flex justify-between"
                >
                  <span>Enter Bills</span>
                  <span className="text-slate-400">Alt+B</span>
                </button>
                <button
                  onClick={() => {
                    setIsPayBillsOpen(true);
                    setActiveMenu(null);
                  }}
                  className="menu-item flex justify-between"
                >
                  <span>Pay Bills (Batch Disbursement)</span>
                </button>
                <button
                  onClick={() => {
                    setIsWriteCheckOpen(true);
                    setActiveMenu(null);
                  }}
                  className="menu-item flex justify-between"
                >
                  <span>Write Checks</span>
                  <span className="text-slate-400">Alt+W</span>
                </button>
                <button
                  onClick={() => {
                    setIsStatementOpen(true);
                    setActiveMenu(null);
                  }}
                  className="menu-item flex justify-between"
                >
                  <span>Customer Billing Statements</span>
                </button>
                <div className="menu-separator"></div>
                <button
                  onClick={() => {
                    setCurrentView('payroll');
                    setActiveMenu(null);
                  }}
                  className="menu-item flex justify-between"
                >
                  <span>Pay Employees / Run Payroll</span>
                  <span className="text-slate-400">Alt+P</span>
                </button>
              </div>
            )}
          </div>

          {/* Menu Item: Reports */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'reports' ? null : 'reports')} aria-expanded={activeMenu === 'reports'} aria-haspopup="menu"
              className={`menu-trigger ${
                activeMenu === 'reports' ? 'menu-trigger-open' : ''
              }`}
            >
              Reports
            </button>
            {activeMenu === 'reports' && (
              <div className="menu-pop w-64">
                <button
                  onClick={() => {
                    setCurrentView('reports');
                    setActiveMenu(null);
                  }}
                  className="menu-item font-semibold"
                >
                  Report Center
                </button>
                <div className="menu-separator"></div>
                <button
                  onClick={() => {
                    setCurrentView('reports');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Profit & Loss (Income Statement)
                </button>
                <button
                  onClick={() => {
                    setCurrentView('reports');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Balance Sheet (Standard)
                </button>
                <button
                  onClick={() => {
                    setCurrentView('reports');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Statement of Cash Flows
                </button>
                <button
                  onClick={() => {
                    setCurrentView('reports');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Trial Balance (Debits/Credits)
                </button>
                <button
                  onClick={() => {
                    setCurrentView('reports');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  A/R Aging & A/P Aging
                </button>
                <button
                  onClick={() => {
                    setCurrentView('reports');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Tamper-Evident Audit Trail
                </button>
              </div>
            )}
          </div>

          {/* Menu Item: Online Banking */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'banking' ? null : 'banking')} aria-expanded={activeMenu === 'banking'} aria-haspopup="menu"
              className={`menu-trigger ${
                activeMenu === 'banking' ? 'menu-trigger-open' : ''
              }`}
            >
              Banking
            </button>
            {activeMenu === 'banking' && (
              <div className="menu-pop w-56">
                <button
                  onClick={() => {
                    setCurrentView('banking');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Check Register & Ledger
                </button>
                <button
                  onClick={() => {
                    setCurrentView('reconciliation');
                    setActiveMenu(null);
                  }}
                  className="menu-item font-semibold"
                >
                  Reconcile Bank Account
                </button>
                <button
                  onClick={() => {
                    setCurrentView('banking');
                    setActiveMenu(null);
                  }}
                  className="menu-item"
                >
                  Bank Feeds (SimpleFIN / OFX)
                </button>
              </div>
            )}
          </div>

          {/* Menu Item: AI Agent */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'ai' ? null : 'ai')} aria-expanded={activeMenu === 'ai'} aria-haspopup="menu"
              className={`menu-trigger ${
                activeMenu === 'ai' ? 'menu-trigger-open' : ''
              }`}
            >
              <Sparkles className="w-3 h-3 text-amber-300" />
              <span>AI Agent & OCR</span>
            </button>
            {activeMenu === 'ai' && (
              <div className="menu-pop w-64">
                <button
                  onClick={() => {
                    setIsOcrScannerOpen(true);
                    setActiveMenu(null);
                  }}
                  className="menu-item flex items-center gap-2"
                >
                  <Receipt className="w-3.5 h-3.5 text-blue-500" />
                  <span>AI Receipt OCR Scanner</span>
                </button>
                <button
                  onClick={() => {
                    setCurrentView('ai-agent');
                    setActiveMenu(null);
                  }}
                  className="menu-item flex items-center gap-2"
                >
                  <Shield className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Ledger Anomaly Auditor</span>
                </button>
                <button
                  onClick={() => {
                    setCurrentView('ai-agent');
                    setActiveMenu(null);
                  }}
                  className="menu-item flex items-center gap-2"
                >
                  <Server className="w-3.5 h-3.5 text-amber-500" />
                  <span>Agent API (835 Operations)</span>
                </button>
              </div>
            )}
          </div>

          {/* Menu Item: Help */}
          <div className="relative">
            <button
              onClick={() => setActiveMenu(activeMenu === 'help' ? null : 'help')} aria-expanded={activeMenu === 'help'} aria-haspopup="menu"
              className={`menu-trigger ${
                activeMenu === 'help' ? 'menu-trigger-open' : ''
              }`}
            >
              Help
            </button>
            {activeMenu === 'help' && (
              <div className="menu-pop w-64">
                <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800">
                  <div className="font-bold text-slate-900 dark:text-white">Printing Management System</div>
                  <div className="text-[11px] text-slate-500">Server-backed, multi-company accounting suite</div>
                </div>
                <div className="px-3 py-2 text-[11px] space-y-1 text-slate-600 dark:text-slate-300">
                  <div className="flex justify-between">
                    <span>New Invoice</span>
                    <kbd className="menu-kbd">Alt+N</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span>Enter Bill</span>
                    <kbd className="menu-kbd">Alt+B</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span>Write Check</span>
                    <kbd className="menu-kbd">Alt+W</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span>Payroll Center</span>
                    <kbd className="menu-kbd">Alt+P</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span>Global Search</span>
                    <kbd className="menu-kbd">Ctrl+K</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span>Toggle Theme</span>
                    <kbd className="menu-kbd">Alt+D</kbd>
                  </div>
                </div>
              </div>
            )}
          </div>
          </div>
        </div>

        {/* Right Header Controls */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Quick Search Palette Trigger */}
          <button
            onClick={() => setIsCommandPaletteOpen(true)}
            className="topbar-pill shrink-0 gap-1.5 px-2.5 py-1.5 whitespace-nowrap sm:gap-2"
            title="Search anything (Ctrl+K)"
          >
            <Search className="w-3.5 h-3.5 text-slate-400" />
            <span className="hidden min-[1440px]:inline">Search records...</span>
            <kbd className="menu-kbd hidden lg:inline">Ctrl+K</kbd>
          </button>

          {/* User Avatar Menu */}
          <div ref={userMenuRef} className="relative">
            <button
              onClick={() => setUserMenuOpen(open => !open)}
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              title={`${userDisplayName} — ${activeCompany?.role || companyProfile.currentUserRole}`}
              className="group flex shrink-0 items-center gap-2 rounded-full p-0.5 pr-1 transition-colors hover:bg-slate-900/[0.04] dark:hover:bg-white/[0.06]"
            >
              <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-[11px] font-bold text-white shadow-glow ring-2 ring-white/80 dark:ring-slate-900/80">
                {userInitials}
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500 dark:border-slate-900" />
              </span>
              <span className="hidden min-[1280px]:flex min-w-0 flex-col items-start leading-tight">
                <span className="max-w-[9rem] truncate text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                  {userDisplayName}
                </span>
                <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">
                  {activeCompany?.role || companyProfile.currentUserRole}
                </span>
              </span>
              <ChevronDown
                className={`hidden h-3.5 w-3.5 text-slate-400 transition-transform sm:block ${
                  userMenuOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {userMenuOpen && (
              <div
                className="menu-pop right-0 left-auto w-72"
                style={{ transformOrigin: 'top right' }}
              >
                {/* Identity header — avatar on the right */}
                <div className="flex items-center gap-3 border-b border-slate-200/70 px-3 py-3 dark:border-white/[0.06]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold text-slate-900 dark:text-white">
                      {userDisplayName}
                    </div>
                    <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                      {user?.email || 'No email on file'}
                    </div>
                  </div>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white shadow-glow">
                    {userInitials}
                  </span>
                </div>

                {/* Active company + role */}
                {activeCompany && (
                  <div className="border-b border-slate-200/70 px-3 py-2.5 dark:border-white/[0.06]">
                    <div className="flex items-center gap-2 text-[11px]">
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-brand-600 dark:text-brand-300" />
                      <span className="truncate font-semibold text-slate-700 dark:text-slate-200">
                        {activeCompany.name}
                      </span>
                      <span className="ml-auto shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                        {activeCompany.role || companyProfile.currentUserRole}
                      </span>
                    </div>
                  </div>
                )}

                {/* Company switcher */}
                {companies.length > 1 && (
                  <div className="border-b border-slate-200/70 px-3 py-2.5 dark:border-white/[0.06]">
                    <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.09em] text-slate-400">
                      Switch company
                    </div>
                    <div className="max-h-40 space-y-0.5 overflow-y-auto">
                      {companies.map(c => (
                        <button
                          key={c.id}
                          onClick={() => {
                            switchCompany(Number(c.id));
                            setUserMenuOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ${
                            activeCompany?.id === c.id
                              ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
                              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/[0.06]'
                          }`}
                        >
                          <Building2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
                          <span className="min-w-0 flex-1 truncate">{c.name}</span>
                          <span className="shrink-0 text-[10px] font-medium text-slate-400">
                            {c.role}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Theme switcher */}
                <div className="border-b border-slate-200/70 px-3 py-2.5 dark:border-white/[0.06]">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.09em] text-slate-400">
                    <Palette className="h-3 w-3" />
                    Appearance
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {(['classic', 'slate', 'midnight'] as ThemeStyle[]).map(t => (
                      <button
                        key={t}
                        onClick={() => updateCompanyProfile({ theme: t })}
                        aria-label={themeLabel[t]}
                        title={themeLabel[t]}
                        className={`flex flex-col items-center gap-1 rounded-lg px-1.5 py-1.5 text-[10px] font-medium transition-colors ${
                          companyProfile.theme === t
                            ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-200 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-500/30'
                            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-white'
                        }`}
                      >
                        <span className={`block h-2.5 w-2.5 rounded-full ${themeDotClass[t]}`} />
                        <span className="truncate">{themeLabel[t]}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Account & workspace actions */}
                <div className="p-1.5">
                  <button
                    onClick={() => {
                      setCurrentView('access-control');
                      setUserMenuOpen(false);
                    }}
                    className="menu-item flex items-center gap-2"
                  >
                    <Shield className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                    <span className="flex-1">Manage Users &amp; Permissions</span>
                  </button>
                  <button
                    onClick={() => {
                      setCurrentView('settings');
                      setUserMenuOpen(false);
                    }}
                    className="menu-item flex items-center gap-2"
                  >
                    <Settings className="w-3.5 h-3.5 text-slate-500" />
                    <span className="flex-1">Company Settings</span>
                  </button>
                  <button
                    onClick={() => {
                      setIsCommandPaletteOpen(true);
                      setUserMenuOpen(false);
                    }}
                    className="menu-item menu-item-accent flex items-center gap-2"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span className="flex-1">Command Palette</span>
                    <kbd className="menu-kbd">Ctrl+K</kbd>
                  </button>
                  <button
                    onClick={() => {
                      handlePrint();
                      setUserMenuOpen(false);
                    }}
                    className="menu-item flex items-center gap-2"
                  >
                    <Printer className="w-3.5 h-3.5 text-slate-500" />
                    <span className="flex-1">Print Current View</span>
                    <kbd className="menu-kbd">Ctrl+P</kbd>
                  </button>
                  <div className="menu-separator"></div>
                  <div className="px-2.5 pb-1.5 pt-1">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.09em] text-slate-400">
                      <CircleHelp className="h-3 w-3" />
                      Help &amp; Shortcuts
                    </div>
                    <div className="mt-1 space-y-0.5 text-[11px] text-slate-600 dark:text-slate-300">
                      <div className="flex justify-between">
                        <span>New Invoice</span>
                        <kbd className="menu-kbd">Alt+N</kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>Enter Bill</span>
                        <kbd className="menu-kbd">Alt+B</kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>Write Check</span>
                        <kbd className="menu-kbd">Alt+W</kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>Payroll Center</span>
                        <kbd className="menu-kbd">Alt+P</kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>Global Search</span>
                        <kbd className="menu-kbd">Ctrl+K</kbd>
                      </div>
                    </div>
                  </div>
                  <div className="menu-separator"></div>
                  <button
                    onClick={() => {
                      logout();
                      setUserMenuOpen(false);
                    }}
                    className="menu-item menu-item-warn flex items-center gap-2"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span className="flex-1">Sign Out</span>
                  </button>
                </div>

                {/* Server-backed indicator */}
                <div className="flex items-center gap-1.5 border-t border-slate-200/70 px-3 py-2 text-[10px] text-slate-400 dark:border-white/[0.06]">
                  <Server className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  <span>Server-backed · {activeCompany?.role || companyProfile.currentUserRole}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick action ribbon */}
      <div className="ribbon flex items-center justify-between gap-3 overflow-x-auto px-3 py-2 text-xs">
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => setIsNewInvoiceOpen(true)}
            className="ribbon-cta"
            title="Create Invoice (Alt+N)"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>+ Invoice</span>
          </button>

          <button
            onClick={() => setIsReceivePaymentOpen(true)}
            className="ribbon-cta-emerald"
            title="Receive Customer Payment"
          >
            <DollarSign className="w-3.5 h-3.5" />
            <span>Receive Payment</span>
          </button>

          <div className="ribbon-divider"></div>

          <button
            onClick={() => setIsEnterBillOpen(true)}
            className="ribbon-btn"
            title="Enter Vendor Bill (Alt+B)"
          >
            <Receipt className="w-3.5 h-3.5 text-rose-300" />
            <span>Enter Bill</span>
          </button>

          <button
            onClick={() => setIsWriteCheckOpen(true)}
            className="ribbon-btn"
            title="Write Check (Alt+W)"
          >
            <CreditCard className="w-3.5 h-3.5 text-blue-300" />
            <span>Write Check</span>
          </button>

          <div className="ribbon-divider"></div>

          <button
            onClick={() => setCurrentView('payroll')}
            className="ribbon-btn"
            title="Run US Payroll (Alt+P)"
          >
            <Users className="w-3.5 h-3.5 text-emerald-300" />
            <span>Run Payroll</span>
          </button>

          <button
            onClick={() => setIsOcrScannerOpen(true)}
            className="ribbon-btn"
            title="AI Receipt Scanner"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-300" />
            <span>AI Receipt OCR</span>
          </button>

          <button
            onClick={() => setCurrentView('reconciliation')}
            className="ribbon-btn"
            title="Reconcile Bank Statement"
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-cyan-300" />
            <span>Reconcile</span>
          </button>

          <button
            onClick={() => setIsJournalEntryOpen(true)}
            className="ribbon-btn"
            title="Make General Journal Entry"
          >
            <span>Journal Entry</span>
          </button>
        </div>

        {/* Company Active Name indicator */}
        <div className="ml-4 hidden shrink-0 items-center gap-2 text-xs whitespace-nowrap opacity-90 xl:flex">
          <span className="ribbon-company">{companyProfile.name}</span>
          <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">·</span>
          <span className="ribbon-meta">
            EIN {companyProfile.ein}
          </span>
        </div>
      </div>
    </div>
  );
};



