import React, { Suspense, lazy, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AccountingProvider, useAccounting } from './context/AccountingContext';
import { AuthPortal } from './components/auth/AuthPortal';
import { AppHeader } from './components/layout/AppHeader';
import { SidebarNavigator } from './components/layout/SidebarNavigator';
import { StatusBar } from './components/layout/StatusBar';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';

// Views
import { HomeWorkflowView } from './components/views/HomeWorkflowView';
import { DashboardView } from './components/views/DashboardView';
import { InvoicesView } from './components/views/InvoicesView';
import { CustomersView } from './components/views/CustomersView';
import { BillsView } from './components/views/BillsView';
import { VendorsView } from './components/views/VendorsView';
import { BankingRegisterView } from './components/views/BankingRegisterView';
import { BankReconciliationView } from './components/views/BankReconciliationView';
import { InventoryView } from './components/views/InventoryView';
import { QuickPrintView } from './components/views/QuickPrintView';
import { PayrollView } from './components/views/PayrollView';
import { TaxFormsView } from './components/views/TaxFormsView';
import { SalesTrendsView, KpiScorecardView } from './components/bi/SalesTrendsView';
import { BiDashboard } from './components/bi/BiDashboard';
import { HealthDashboard } from './components/admin/HealthDashboard';
import { SubscriptionManager } from './components/admin/SubscriptionManager';
import { VehicleManagement, DriverManagement } from './components/delivery/VehicleManagement';
import { DeliveryScheduling } from './components/delivery/DeliveryScheduling';
import { ConsentManagement } from './components/communications/ConsentManagement';
import { InboxView } from './components/communications/InboxView';
import { CustomerContactsTab } from './components/customers/CustomerContactsTab';
import { DeductionRulesView } from './components/payroll/DeductionRulesView';
import { SalaryAdvanceModal } from './components/payroll/SalaryAdvanceModal';
import { FinanceControlsView } from './components/views/FinanceControlsView';
import { AiAgentView } from './components/views/AiAgentView';
import { SettingsView } from './components/views/SettingsView';
import { AccessControlView } from './components/views/AccessControlView';
import { FixedAssetsView } from './components/views/FixedAssetsView';
import { InventoryOperationsView } from './components/views/InventoryOperationsView';
import { ProductionScheduleView } from './components/views/ProductionScheduleView';
import { canAccessView, VIEW_REQUIRED_PERMISSION } from './config/viewPermissions';

// Route-level code splitting for the heaviest views. These are only needed when
// the operator actually opens them, so keeping them out of the first-load
// bundle removes ~a third of the initial JavaScript.
const ChartOfAccountsView = lazy(() =>
  import('./components/views/ChartOfAccountsView').then(m => ({ default: m.ChartOfAccountsView }))
);
const ReportsView = lazy(() =>
  import('./components/views/ReportsView').then(m => ({ default: m.ReportsView }))
);
const PrintingContractsView = lazy(() =>
  import('./components/views/PrintingContractsView').then(m => ({ default: m.PrintingContractsView }))
);
const ExaminationView = lazy(() =>
  import('./components/views/ExaminationView').then(m => ({ default: m.ExaminationView }))
);
const AllDocumentsView = lazy(() =>
  import('./components/views/AllDocumentsView').then(m => ({ default: m.AllDocumentsView }))
);
const SmartOperationsView = lazy(() =>
  import('./components/views/SmartOperationsView').then(m => ({ default: m.SmartOperationsView }))
);

// Modals
import { CommandPalette } from './components/modals/CommandPalette';
import { NewInvoiceModal } from './components/modals/NewInvoiceModal';
import { ReceivePaymentModal } from './components/modals/ReceivePaymentModal';
import { EnterBillModal } from './components/modals/EnterBillModal';
import { WriteCheckModal } from './components/modals/WriteCheckModal';
import { JournalEntryModal } from './components/modals/JournalEntryModal';
import { NewCustomerModal } from './components/modals/NewCustomerModal';
import { NewVendorModal } from './components/modals/NewVendorModal';
import { NewItemModal } from './components/modals/NewItemModal';
import { NewEmployeeModal } from './components/modals/NewEmployeeModal';
import { OcrReceiptModal } from './components/modals/OcrReceiptModal';
import { PayBillsModal } from './components/modals/PayBillsModal';
import { IifImportModal } from './components/modals/IifImportModal';
import { CustomerStatementModal } from './components/modals/CustomerStatementModal';
import { DocumentPreviewModal } from './components/modals/DocumentPreviewModal';
import { PosModal } from './components/modals/PosModal';

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[UI Error Boundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#f6f7fb] p-6 dark:bg-[#070b14]">
          <div className="w-full max-w-md overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-pop dark:border-white/10 dark:bg-slate-900">
            <div className="h-1.5 w-full bg-gradient-to-r from-rose-500 via-rose-400 to-amber-400" />
            <div className="space-y-4 p-7">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <div className="space-y-1.5">
                <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                  This screen could not be displayed
                </h1>
                <p className="text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
                  The interface hit an unexpected rendering error. Your server data was not changed. Reload
                  to continue; if it repeats, share the details below with an administrator.
                </p>
              </div>
              <pre className="max-h-32 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-rose-700 dark:border-white/10 dark:bg-slate-950 dark:text-rose-300">
                {this.state.error.message}
              </pre>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="btn btn-primary w-full"
              >
                Reload workspace
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const ViewLoadingFallback: React.FC = () => (
  <div className="p-6 sm:p-8">
    <div className="flex items-center gap-2.5 text-xs font-medium text-slate-500 dark:text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin text-brand-600 dark:text-brand-400" />
      <span>Loading workspace module…</span>
    </div>
    <div className="mt-5 space-y-4">
      <div className="skeleton h-9 w-72 max-w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div className="skeleton h-36 rounded-2xl" />
        <div className="skeleton h-36 rounded-2xl" />
        <div className="skeleton h-36 rounded-2xl" />
      </div>
      <div className="skeleton h-56 w-full rounded-2xl" />
    </div>
  </div>
);

const AccessDeniedView: React.FC<{ viewId: string; onHome: () => void }> = ({ viewId, onHome }) => {
  const required = VIEW_REQUIRED_PERMISSION[viewId];
  const label = viewId.replace(/-/g, ' ');
  return (
    <div className="p-6 sm:p-8">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-pop dark:border-white/10 dark:bg-slate-900">
        <div className="h-1.5 w-full bg-gradient-to-r from-amber-400 via-amber-300 to-slate-300" />
        <div className="space-y-4 p-7">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="space-y-1.5">
            <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">
              You do not have access to this module
            </h1>
            <p className="text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
              The <strong className="text-slate-700 dark:text-slate-300">{label}</strong> module
              {required ? (
                <>
                  {' '}requires the{' '}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {required}
                  </span>{' '}
                  permission
                </>
              ) : null}
              , which your role does not hold. Ask an administrator to grant it, or return to the
              workflow overview.
            </p>
          </div>
          <button type="button" onClick={onHome} className="btn btn-primary w-full">
            Back to Flow Navigator
          </button>
        </div>
      </div>
    </div>
  );
};

const AppContent: React.FC = () => {
  const { activeCompany, permissions } = useAuth();
  const {
    currentView,
    setCurrentView,
    companyProfile,
    updateCompanyProfile,
    activeShortcutNotice,
    dismissShortcutNotice,
  } = useAccounting();

  useEffect(() => {
    if (!activeCompany) return;
    if (
      companyProfile.name !== activeCompany.name ||
      companyProfile.currentUserRole !== activeCompany.role
    ) {
      updateCompanyProfile({
        name: activeCompany.name,
        currentUserRole: activeCompany.role,
      });
    }
  }, [activeCompany, companyProfile.name, companyProfile.currentUserRole, updateCompanyProfile]);

  const isClassic = companyProfile.theme === 'classic';
  const isMidnight = companyProfile.theme === 'midnight';

  const renderActiveView = () => {
    switch (currentView) {
      case 'workflow':
        return <HomeWorkflowView />;
      case 'dashboard':
        return <DashboardView />;
      case 'invoices':
        return <InvoicesView />;
      case 'customers':
        return <CustomersView />;
      case 'bills':
        return <BillsView />;
      case 'vendors':
        return <VendorsView />;
      case 'banking':
        return <BankingRegisterView />;
      case 'fixed-assets':
        return <FixedAssetsView />;
      case 'reconciliation':
        return <BankReconciliationView />;
      case 'inventory':
        return <InventoryView />;
      case 'inventory-operations':
        return <InventoryOperationsView />;
      case 'quick-print':
        return <QuickPrintView />;
      case 'examinations':
        return <ExaminationView />;
      case 'production-schedule':
        return <ProductionScheduleView />;
      case 'contracts':
        return <PrintingContractsView />;
      case 'payroll':
        return <PayrollView />;
      case 'tax-forms':
        return <TaxFormsView />;
      case 'accounts':
        return <ChartOfAccountsView />;
      case 'reports':
        return <ReportsView />;
      case 'finance-controls':
        return <FinanceControlsView />;
      case 'ai-agent':
        return <AiAgentView />;
      case 'settings':
        return <SettingsView />;
      case 'access-control':
        return <AccessControlView />;
      case 'documents':
        return <AllDocumentsView />;
      case 'smart-operations':
        return <SmartOperationsView />;
      case 'sales-trends':
        return <SalesTrendsView />;
      case 'kpi-scorecard':
        return <KpiScorecardView />;
      case 'bi-dashboard':
        return <BiDashboard />;
      case 'health':
        return <HealthDashboard />;
      case 'system-admin':
        return <SubscriptionManager />;
      case 'delivery-fleet':
        return (
          <div className="space-y-6 p-6">
            <DeliveryScheduling />
            <VehicleManagement />
            <DriverManagement />
          </div>
        );
      case 'consent-management':
        return <ConsentManagement />;
      case 'communications-inbox':
        return <InboxView />;
      case 'deduction-rules':
        return <DeductionRulesView />;
      case 'salary-advances':
        return <SalaryAdvanceModal onClose={() => setCurrentView('payroll')} />;
      default:
        return <HomeWorkflowView />;
    }
  };

  return (
    <div
      className={`theme-${companyProfile.theme} flex h-screen flex-col overflow-hidden font-sans text-slate-900 transition-colors dark:text-slate-100 ${
        isClassic
          ? 'bg-[#eef3f8]'
          : isMidnight
          ? 'bg-[#070b14]'
          : 'bg-[#f6f7fb]'
      }`}
    >
      {/* Primary application header and quick-action toolbar */}
      <AppHeader />

      {/* Main Workspace Frame */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Navigation Sidebar */}
        <SidebarNavigator />

        {/* Primary Viewport */}
        <main className="flex-1 overflow-y-auto print:overflow-visible">
          <Suspense fallback={<ViewLoadingFallback />}>
            {canAccessView(currentView, permissions) ? (
              renderActiveView()
            ) : (
              <AccessDeniedView viewId={currentView} onHome={() => setCurrentView('workflow')} />
            )}
          </Suspense>
        </main>
      </div>

      {/* Operational Status Bar */}
      <StatusBar />

      {/* Floating Toast Notification Portal */}
      {activeShortcutNotice && (
        <div
          role="status"
          aria-live="polite"
          className={`animate-toast-enter no-print fixed right-5 bottom-11 z-50 flex max-w-sm items-center gap-3 rounded-2xl border py-3 pr-2.5 pl-3.5 text-[13px] font-medium shadow-pop backdrop-blur-md ${
            activeShortcutNotice.tone === 'error'
              ? 'border-rose-500/30 bg-rose-600 text-white'
              : activeShortcutNotice.tone === 'warning'
              ? 'border-amber-400/40 bg-amber-400 text-amber-950'
              : activeShortcutNotice.tone === 'info'
              ? 'border-brand-500/40 bg-brand-600 text-white'
              : 'border-slate-200/80 bg-white text-slate-800 dark:border-white/10 dark:bg-slate-900 dark:text-slate-100'
          }`}
        >
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
              activeShortcutNotice.tone === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-500/15'
                : 'bg-white/15'
            }`}
          >
            {activeShortcutNotice.tone === 'error' ? (
              <AlertTriangle className="h-4 w-4" />
            ) : activeShortcutNotice.tone === 'warning' ? (
              <AlertTriangle className="h-4 w-4" />
            ) : activeShortcutNotice.tone === 'info' ? (
              <Info className="h-4 w-4" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            )}
          </span>
          <span className="min-w-0 flex-1 leading-snug">{activeShortcutNotice.text}</span>
          <button
            onClick={dismissShortcutNotice}
            className="shrink-0 rounded-lg p-1.5 transition-colors hover:bg-black/10 dark:hover:bg-white/10"
            aria-label="Dismiss notification"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Global Interactive Modals */}
      <CommandPalette />
      <NewInvoiceModal />
      <ReceivePaymentModal />
      <EnterBillModal />
      <WriteCheckModal />
      <JournalEntryModal />
      <NewCustomerModal />
      <NewVendorModal />
      <NewItemModal />
      <NewEmployeeModal />
      <OcrReceiptModal />
      <PayBillsModal />
      <IifImportModal />
      <CustomerStatementModal />
      <DocumentPreviewModal />
      <PosModal />
    </div>
  );
};

const AuthenticatedWorkspace: React.FC = () => {
  const { loading, authenticated } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[#f6f7fb] text-slate-500 dark:bg-[#070b14] dark:text-slate-400">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-card dark:bg-slate-900">
          <Loader2 className="h-5 w-5 animate-spin text-brand-600 dark:text-brand-400" />
        </span>
        <p className="text-xs font-semibold tracking-wide">Verifying session and company access...</p>
      </div>
    );
  }

  if (!authenticated) {
    return <AuthPortal />;
  }

  return (
    <AccountingProvider>
      <AppContent />
    </AccountingProvider>
  );
};

export default function App() {
  return (
    <AppErrorBoundary>
      <AuthProvider>
        <AuthenticatedWorkspace />
      </AuthProvider>
    </AppErrorBoundary>
  );
}
