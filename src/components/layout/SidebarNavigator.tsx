import React, { useEffect, useRef } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { STOCKED_ITEM_TYPES } from '../../types/accounting';
import {
  GitMerge,
  LayoutDashboard,
  FileText,
  Users,
  Building2,
  Receipt,
  Landmark,
  Scale,
  Package,
  BadgeDollarSign,
  FileCheck2,
  BookOpen,
  BarChart3,
  Sparkles,
  Settings,
  ShieldCheck,
  Printer,
  FileSpreadsheet,
  Calculator,
  FolderOpen,
  ClipboardCheck,
  Zap,
  X,
} from 'lucide-react';

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  count?: string | number;
  countTone?: string;
}

interface NavGroup {
  groupTitle: string;
  items: NavItem[];
}

export const SidebarNavigator: React.FC = () => {
  const {
    currentView,
    setCurrentView,
    invoices,
    bills,
    inventoryItems,
    quickPrintJobs,
    examPapers,
    printingContracts,
    companyProfile,
    isSidebarCollapsed,
    isMobileDrawerOpen,
    setIsMobileDrawerOpen,
  } = useAccounting();
  const { activeCompany } = useAuth();

  const drawerRef = useRef<HTMLElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Accessible drawer behaviour: focus moves into the dialog, Tab is trapped,
  // background scrolling is locked, and focus returns to the header trigger.
  useEffect(() => {
    if (!isMobileDrawerOpen) return;

    // Prefer the header toggle: programmatic opens leave focus elsewhere, and
    // focus must land back on the control that owns the drawer.
    const opener = document.querySelector<HTMLElement>('[data-header-nav-toggle]');
    restoreFocusRef.current =
      opener ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => drawerCloseRef.current?.focus(), 30);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const root = drawerRef.current;
      if (!root) return;

      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(element => element.getClientRects().length > 0);

      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      const restoreTarget = restoreFocusRef.current;
      if (restoreTarget && document.body.contains(restoreTarget)) {
        window.setTimeout(() => restoreTarget.focus(), 0);
      }
    };
  }, [isMobileDrawerOpen]);

  const openInvoicesCount = invoices.filter(i => i.status !== 'paid').length;
  const openBillsCount = bills.filter(b => b.status === 'open').length;
  const lowStockCount = inventoryItems.filter(
    i => STOCKED_ITEM_TYPES.includes(i.type) && i.onHand <= i.reorderPoint
  ).length;
  const readyExamsCount = examPapers.filter(p => p.status === 'completed').length;
  const activeContractsCount = printingContracts.filter(c => c.status === 'active').length;

  const isClassic = companyProfile.theme === 'classic';
  const isMidnight = companyProfile.theme === 'midnight';

  const navGroups: NavGroup[] = [
    {
      groupTitle: 'Workflow & Insights',
      items: [
        { id: 'workflow', label: 'Flow Navigator', icon: GitMerge },
        { id: 'dashboard', label: 'Executive Dashboard', icon: LayoutDashboard },
        { id: 'documents', label: 'All Documents', icon: FolderOpen },
      ],
    },
    {
      groupTitle: 'Customers & Sales',
      items: [
        {
          id: 'invoices',
          label: 'Invoices & A/R',
          icon: FileText,
          count: openInvoicesCount > 0 ? openInvoicesCount : undefined,
          countTone: 'text-blue-600 dark:text-blue-400',
        },
        { id: 'customers', label: 'Customer Center', icon: Users },
        { id: 'smart-operations', label: 'Smart Operations', icon: Zap },
      ],
    },
    {
      groupTitle: 'Vendors & Expenses',
      items: [
        {
          id: 'bills',
          label: 'Bills & A/P',
          icon: Receipt,
          count: openBillsCount > 0 ? openBillsCount : undefined,
          countTone: 'text-amber-600 dark:text-amber-400',
        },
        { id: 'vendors', label: 'Vendor Center', icon: Building2 },
      ],
    },
    {
      groupTitle: 'Banking & Ledger',
      items: [
        { id: 'banking', label: 'Check Register', icon: Landmark },
        { id: 'reconciliation', label: 'Bank Reconciliation', icon: Scale },
        { id: 'accounts', label: 'Chart of Accounts', icon: BookOpen },
      ],
    },
    {
      groupTitle: 'Printing Operations & Contracts',
      items: [
        {
          id: 'quick-print',
          label: 'Quick Photocopy & Print',
          icon: Calculator,
          count: quickPrintJobs.length > 0 ? quickPrintJobs.length : undefined,
          countTone: 'text-blue-600 dark:text-blue-400',
        },
        {
          id: 'examinations',
          label: 'Examination Module',
          icon: Printer,
          count: readyExamsCount > 0 ? `${readyExamsCount} ready` : undefined,
          countTone: 'text-emerald-600 dark:text-emerald-400',
        },
        {
          id: 'contracts',
          label: 'Printing Contracts',
          icon: FileSpreadsheet,
          count: activeContractsCount > 0 ? activeContractsCount : undefined,
          countTone: 'text-indigo-600 dark:text-indigo-400',
        },
        {
          id: 'inventory',
          label: 'Inventory & BOM Catalog',
          icon: Package,
          count: lowStockCount > 0 ? `${lowStockCount} low` : undefined,
          countTone: 'text-rose-600 dark:text-rose-400',
        },
      ],
    },
    {
      groupTitle: 'Payroll & Compliance',
      items: [
        { id: 'payroll', label: 'Payroll Center', icon: BadgeDollarSign },
        { id: 'tax-forms', label: 'Tax Forms (941 / W-2)', icon: FileCheck2 },
      ],
    },
    {
      groupTitle: 'Analytics & Administration',
      items: [
        { id: 'reports', label: 'Financial Reports', icon: BarChart3 },
        { id: 'finance-controls', label: 'Finance Controls', icon: ClipboardCheck },
        { id: 'ai-agent', label: 'AI Agent & 835-Op API', icon: Sparkles },
        { id: 'access-control', label: 'Users & Multi-Company', icon: ShieldCheck },
        { id: 'settings', label: 'Company Settings', icon: Settings },
      ],
    },
  ];

  const handleNavClick = (id: string) => {
    setCurrentView(id);
    setIsMobileDrawerOpen(false);
  };

  const sidebarContent = (collapsed: boolean) => (
      <div className="flex flex-col justify-between h-full">
      <nav className="space-y-1 px-2 py-3" aria-label="Workspace navigation">
        {navGroups.map((group, gIdx) => (
          <div key={gIdx} className="space-y-0.5">
            {!collapsed && <div className="nav-group-label">{group.groupTitle}</div>}

            {group.items.map(item => {
              const Icon = item.icon;
              const isActive = currentView === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => handleNavClick(item.id)}
                  title={collapsed ? item.label : undefined}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={item.label}
                  className={`nav-item ${collapsed ? 'nav-item-collapsed' : ''} ${
                    isActive ? 'nav-item-active' : ''
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Icon
                      className={`nav-icon ${
                        isActive
                          ? 'text-white'
                          : isClassic
                          ? 'text-[#0f3d63]'
                          : 'text-slate-400 dark:text-slate-500'
                      }`}
                    />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </div>

                  {!collapsed && item.count !== undefined && (
                    <span
                      className={`nav-count ${
                        isActive ? 'nav-count-active' : item.countTone || 'text-slate-500'
                      }`}
                    >
                      {item.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Sidebar Footer — reflects the verified server session */}
      {!collapsed ? (
        <div className="space-y-2 border-t border-slate-200/80 p-3.5 dark:border-white/[0.06]">
          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-400">
            <span className="flex min-w-0 items-center gap-1.5 font-semibold">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-500/10">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              </span>
              <span className="truncate" title={activeCompany?.name}>
                {activeCompany?.name || 'Authenticated company'}
              </span>
            </span>
            <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
              Verified
            </span>
          </div>
          <div className="text-[10px] text-slate-400 dark:text-slate-500">
            {activeCompany ? `${activeCompany.role} · Server-verified access` : 'Server-verified access'}
          </div>
        </div>
      ) : (
        <div
          className="flex justify-center border-t border-slate-200/80 p-3.5 dark:border-white/[0.06]"
          title={activeCompany ? `${activeCompany.name} · ${activeCompany.role}` : 'Server-verified session'}
        >
          <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        </div>
      )}
    </div>
  );

  const themeBg = isClassic
    ? 'bg-[#eef4f9] border-slate-300/70 dark:border-white/[0.06]'
    : isMidnight
    ? 'bg-slate-950 border-white/[0.06]'
    : 'bg-white/80 border-slate-200/80 dark:bg-slate-900/60 dark:border-white/[0.06]';

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside
        id="app-navigation-sidebar"
        aria-label="Main navigation"
        className={`no-print hidden shrink-0 flex-col overflow-y-auto backdrop-blur-xl transition-colors select-none lg:flex ${
          isSidebarCollapsed ? 'w-16' : 'w-72'
        } ${themeBg}`}
      >
        {sidebarContent(isSidebarCollapsed)}
      </aside>

      {/* Mobile / Narrow Viewport Slide-Over Drawer */}
      {isMobileDrawerOpen && (
        <div className="no-print fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-950/40 backdrop-blur-sm"
            aria-hidden="true"
            onClick={() => setIsMobileDrawerOpen(false)}
          />
          <aside
            ref={drawerRef}
            id="app-navigation-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className={`animate-pop-enter relative z-10 flex h-full w-72 max-w-[80vw] flex-col overflow-y-auto border-r shadow-pop ${themeBg}`}
          >
            <div className="flex items-center justify-between border-b border-slate-200/80 px-4 py-3 dark:border-white/[0.06]">
              <span className="text-[10px] font-bold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
                Navigation
              </span>
              <button
                ref={drawerCloseRef}
                type="button"
                onClick={() => setIsMobileDrawerOpen(false)}
                className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-white/[0.06] dark:hover:text-white"
                aria-label="Close navigation menu"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{sidebarContent(false)}</div>
          </aside>
        </div>
      )}
    </>
  );
};
