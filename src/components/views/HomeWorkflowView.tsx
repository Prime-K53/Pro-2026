import React from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { STOCKED_ITEM_TYPES } from '../../types/accounting';
import { formatCurrency } from '../../utils/currency';
import {
  FileText,
  DollarSign,
  Receipt,
  CreditCard,
  Users,
  Building2,
  Package,
  BookOpen,
  Scale,
  Landmark,
  Sparkles,
  ShieldCheck,
  FileCheck2,
  BarChart3,
  Clock,
  CheckCircle2,
  Printer,
  FileSpreadsheet,
  Calculator,
} from 'lucide-react';

const FlowConnector: React.FC<{ accent?: 'blue' | 'amber' | 'emerald' }> = ({ accent = 'blue' }) => {
  const strokeColor =
    accent === 'amber'
      ? 'stroke-amber-400 dark:stroke-amber-700'
      : accent === 'emerald'
      ? 'stroke-emerald-400 dark:stroke-emerald-700'
      : 'stroke-blue-400 dark:stroke-blue-700';

  const fillColor =
    accent === 'amber'
      ? 'fill-amber-500 dark:fill-amber-600'
      : accent === 'emerald'
      ? 'fill-emerald-500 dark:fill-emerald-600'
      : 'fill-blue-500 dark:fill-blue-600';

  return (
    <div className="hidden md:flex items-center justify-center w-12 shrink-0 select-none" aria-hidden="true">
      <svg width="48" height="20" viewBox="0 0 48 20" className="overflow-visible">
        <line
          x1="0"
          y1="10"
          x2="38"
          y2="10"
          strokeWidth="2"
          className={`${strokeColor} flow-connector-animated`}
        />
        <polygon points="36,5 46,10 36,15" className={fillColor} />
      </svg>
    </div>
  );
};

export const HomeWorkflowView: React.FC = () => {
  const {
    setCurrentView,
    setIsNewInvoiceOpen,
    setIsReceivePaymentOpen,
    setIsEnterBillOpen,
    setIsPayBillsOpen,
    setIsWriteCheckOpen,
    setIsOcrScannerOpen,
    invoices,
    estimates,
    bills,
    accounts,
    employees,
    inventoryItems,
    quickPrintJobs,
    examPapers,
    printingContracts,
    companyProfile,
  } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const unpaidInvoices = invoices.filter(i => i.balanceDue > 0);
  const totalAr = unpaidInvoices.reduce((sum, i) => sum + i.balanceDue, 0);

  const unpaidBills = bills.filter(b => b.balanceDue > 0);
  const totalAp = unpaidBills.reduce((sum, b) => sum + b.balanceDue, 0);

  const lowStockCount = inventoryItems.filter(
    i => STOCKED_ITEM_TYPES.includes(i.type) && i.onHand <= i.reorderPoint
  ).length;
  const readyExamsCount = examPapers.filter(p => p.status === 'completed').length;
  const activeContractsCount = printingContracts.filter(c => c.status === 'active').length;

  const operatingAccount = accounts.find(a => a.id === companyProfile.defaultBankAccountId);
  const cashOnHand = operatingAccount ? operatingAccount.balance : 0;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Top KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <button
          onClick={() => setCurrentView('banking')}
          className="surface surface-hover p-4 flex items-center justify-between text-left"
        >
          <div>
            <div className="text-xs font-semibold text-slate-500">Operating Cash</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
              {formatCurrency(cashOnHand, currency)}
            </div>
            <div className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">
              Checking #1010 · Click to open register
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <Landmark className="w-5 h-5" />
          </div>
        </button>

        <button
          onClick={() => setCurrentView('invoices')}
          className="surface surface-hover p-4 flex items-center justify-between text-left"
        >
          <div>
            <div className="text-xs font-semibold text-slate-500">Open Receivables (A/R)</div>
            <div className="text-xl font-bold font-mono text-brand-600 dark:text-brand-400 mt-1 tabular-nums">
              {formatCurrency(totalAr, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-medium">
              {unpaidInvoices.length} unpaid customer invoices
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-brand-50 dark:bg-brand-950/50 text-brand-600 dark:text-brand-400 flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5" />
          </div>
        </button>

        <button
          onClick={() => setCurrentView('bills')}
          className="surface surface-hover p-4 flex items-center justify-between text-left"
        >
          <div>
            <div className="text-xs font-semibold text-slate-500">Open Payables (A/P)</div>
            <div className="text-xl font-bold font-mono text-rose-600 dark:text-rose-400 mt-1 tabular-nums">
              {formatCurrency(totalAp, currency)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 font-medium">
              {unpaidBills.length} pending supplier bills
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0">
            <Receipt className="w-5 h-5" />
          </div>
        </button>

        <div className="surface p-4 !border-transparent !bg-gradient-to-br !from-slate-900 !to-slate-800 text-white flex items-center justify-between shadow-pop">
          <div>
            <div className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              <span>AI Receipt OCR</span>
            </div>
            <div className="text-sm font-bold mt-1 text-slate-100">
              835 Local Operations
            </div>
            <button
              onClick={() => setIsOcrScannerOpen(true)}
              className="mt-1 text-[11px] font-semibold text-amber-300 hover:text-amber-200 underline text-left cursor-pointer"
            >
              Launch Receipt Scanner →
            </button>
          </div>
          <div className="w-10 h-10 rounded-lg bg-white/10 text-amber-300 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* The Classic Flowchart Navigator Workbench */}
      <div className="surface p-6 space-y-8">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
          <div>
            <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-brand-700 to-brand-500 bg-clip-text text-transparent">
              Company Accounting Flow Navigator
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Interactive QuickBooks-heritage pipeline — select any stage to create transactions, manage stock, or reconcile ledgers.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-slate-600 dark:text-slate-300">
            <span>Server-backed ledger</span>
            <span aria-hidden="true">·</span>
            <span>{companyProfile.accountingMethod === 'accrual' ? 'Accrual Basis' : 'Cash Basis'}</span>
          </div>
        </div>

        {/* 1. CUSTOMERS & RECEIVABLES PIPELINE */}
        <section className="space-y-3">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-400">
            <span className="flex items-center gap-2">
              <Users className="w-4 h-4 text-brand-600" />
              <span className="text-slate-900 dark:text-white font-bold">01. Customers & Accounts Receivable</span>
            </span>
            <button
              onClick={() => setCurrentView('customers')}
              className="text-brand-600 dark:text-brand-400 hover:underline font-semibold whitespace-nowrap"
            >
              Open Customer Center →
            </button>
          </div>

          <div className="p-5 rounded-xl bg-slate-50/80 dark:bg-slate-850/80 bg-workbench-grid border border-slate-200 dark:border-slate-800 flex flex-wrap md:flex-nowrap items-center justify-between gap-3">
            {/* Node 0: Quick Photocopy & Print */}
            <button
              onClick={() => setCurrentView('quick-print')}
              className="flex-1 min-w-[130px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-cyan-500 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-cyan-50 dark:bg-cyan-950/60 text-cyan-600 dark:text-cyan-400 flex items-center justify-center group-hover:bg-cyan-600 group-hover:text-white transition-colors">
                <Calculator className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-slate-900 dark:text-slate-100">Quick Print Desk</div>
              <div className="text-[11px] text-slate-500 font-mono">
                {quickPrintJobs.length} jobs logged
              </div>
            </button>

            <FlowConnector accent="blue" />

            {/* Node 1: Examination Production */}
            <button
              onClick={() => setCurrentView('examinations')}
              className="flex-1 min-w-[130px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-indigo-500 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                <Printer className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-slate-900 dark:text-slate-100">Examination Print</div>
              <div className="text-[11px] text-slate-500 font-mono">
                {readyExamsCount} ready to bill
              </div>
            </button>

            <FlowConnector accent="blue" />

            {/* Node 2: Printing Contracts */}
            <button
              onClick={() => setCurrentView('contracts')}
              className="flex-1 min-w-[130px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-brand-500 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 flex items-center justify-center group-hover:bg-brand-600 group-hover:text-white transition-colors">
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-slate-900 dark:text-slate-100">Printing Contracts</div>
              <div className="text-[11px] text-slate-500 font-mono">
                {activeContractsCount} active retainers
              </div>
            </button>

            <FlowConnector accent="blue" />

            {/* Node 3: Create Invoices (Primary) */}
            <button
              onClick={() => setIsNewInvoiceOpen(true)}
              className="flex-1 min-w-[130px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border-2 border-brand-500 hover:border-brand-600 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-gradient-to-br from-brand-500 to-brand-600 text-white flex items-center justify-center group-hover:scale-105 shadow-glow transition-transform">
                <FileText className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-brand-600 dark:text-brand-400">Create Invoices</div>
              <div className="text-[11px] text-slate-500 font-mono">
                {unpaidInvoices.length} open · Alt+N
              </div>
            </button>

            <FlowConnector accent="blue" />

            {/* Node 4: Receive Payments */}
            <button
              onClick={() => setIsReceivePaymentOpen(true)}
              className="flex-1 min-w-[130px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-emerald-500 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center group-hover:bg-emerald-600 group-hover:text-white transition-colors">
                <DollarSign className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-slate-900 dark:text-slate-100">Receive Payments</div>
              <div className="text-[11px] text-slate-500">Apply to A/R</div>
            </button>
          </div>
        </section>

        {/* 2. VENDORS & ACCOUNTS PAYABLE PIPELINE */}
        <section className="space-y-3">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-400">
            <span className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-amber-600" />
              <span className="text-slate-900 dark:text-white font-bold">02. Vendors, Perpetual Inventory & Payables</span>
            </span>
            <button
              onClick={() => setCurrentView('vendors')}
              className="text-amber-600 dark:text-amber-400 hover:underline font-semibold whitespace-nowrap"
            >
              Open Vendor Center →
            </button>
          </div>

          <div className="p-5 rounded-xl bg-slate-50/80 dark:bg-slate-850/80 bg-workbench-grid border border-slate-200 dark:border-slate-800 flex flex-wrap md:flex-nowrap items-center justify-between gap-3">
            {/* Node 1: Receive Stock */}
            <button
              onClick={() => setCurrentView('inventory')}
              className="flex-1 min-w-[140px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-amber-500 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center group-hover:bg-amber-600 group-hover:text-white transition-colors">
                <Package className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-slate-900 dark:text-slate-100">Receive Stock</div>
              <div className={`text-[11px] font-mono ${lowStockCount > 0 ? 'text-rose-600 dark:text-rose-400 font-semibold' : 'text-slate-500'}`}>
                {lowStockCount > 0 ? `${lowStockCount} low stock` : `${inventoryItems.length} SKUs`}
              </div>
            </button>

            <FlowConnector accent="amber" />

            {/* Node 2: Enter Bills */}
            <button
              onClick={() => setIsEnterBillOpen(true)}
              className="flex-1 min-w-[140px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border-2 border-amber-500 hover:border-amber-600 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-amber-500 text-slate-950 flex items-center justify-center group-hover:scale-105 transition-transform">
                <Receipt className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-amber-600 dark:text-amber-400">Enter Bills</div>
              <div className="text-[11px] text-slate-500 font-mono">
                {unpaidBills.length} open · Alt+B
              </div>
            </button>

            <FlowConnector accent="amber" />

            {/* Node 3: Pay Bills */}
            <button
              onClick={() => setIsPayBillsOpen(true)}
              className="flex-1 min-w-[140px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-rose-500 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center group-hover:bg-rose-600 group-hover:text-white transition-colors">
                <CreditCard className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-slate-900 dark:text-slate-100">Pay Bills</div>
              <div className="text-[11px] text-slate-500">Batch Disbursement</div>
            </button>

            <FlowConnector accent="amber" />

            {/* Node 4: Write Checks */}
            <button
              onClick={() => setIsWriteCheckOpen(true)}
              className="flex-1 min-w-[140px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-brand-500 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 flex items-center justify-center group-hover:bg-brand-600 group-hover:text-white transition-colors">
                <CreditCard className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-slate-900 dark:text-slate-100">Write Checks</div>
              <div className="text-[11px] text-slate-500 font-mono">Alt+W</div>
            </button>
          </div>
        </section>

        {/* 3. EMPLOYEES & US PAYROLL PIPELINE */}
        <section className="space-y-3">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-400">
            <span className="flex items-center gap-2">
              <Users className="w-4 h-4 text-emerald-600" />
              <span className="text-slate-900 dark:text-white font-bold">03. Employees & US Payroll Engine</span>
            </span>
            <button
              onClick={() => setCurrentView('payroll')}
              className="text-emerald-600 dark:text-emerald-400 hover:underline font-semibold whitespace-nowrap"
            >
              Open Payroll Center →
            </button>
          </div>

          <div className="p-5 rounded-xl bg-slate-50/80 dark:bg-slate-850/80 bg-workbench-grid border border-slate-200 dark:border-slate-800 flex flex-wrap md:flex-nowrap items-center justify-between gap-3">
            {/* Node 1: Enter Time */}
            <button
              onClick={() => setCurrentView('payroll')}
              className="flex-1 min-w-[160px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-emerald-500 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center group-hover:bg-emerald-600 group-hover:text-white transition-colors">
                <Clock className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-slate-900 dark:text-slate-100">Employee Hours</div>
              <div className="text-[11px] text-slate-500 font-mono">
                {employees.length} active staff
              </div>
            </button>

            <FlowConnector accent="emerald" />

            {/* Node 2: Run Payroll */}
            <button
              onClick={() => setCurrentView('payroll')}
              className="flex-1 min-w-[160px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border-2 border-emerald-500 hover:border-emerald-600 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-emerald-600 text-white flex items-center justify-center group-hover:scale-105 transition-transform">
                <DollarSign className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-emerald-600 dark:text-emerald-400">Pay Employees</div>
              <div className="text-[11px] text-slate-500 font-mono">FIT · FICA · Alt+P</div>
            </button>

            <FlowConnector accent="emerald" />

            {/* Node 3: Tax Liabilities & IRS Forms */}
            <button
              onClick={() => setCurrentView('tax-forms')}
              className="flex-1 min-w-[160px] flex flex-col items-center gap-2 p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-indigo-500 hover:shadow-sm transition-all active:scale-[0.98] group text-center"
            >
              <div className="w-11 h-11 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                <FileCheck2 className="w-5 h-5" />
              </div>
              <div className="font-bold text-xs text-slate-900 dark:text-slate-100">Tax Forms & Filings</div>
              <div className="text-[11px] text-slate-500">941 · 940 · W-2 · 1099</div>
            </button>
          </div>
        </section>

        {/* 4. BANKING, GENERAL LEDGER & REPORTS */}
        <section className="space-y-3">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-400">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-slate-600 dark:text-slate-400" />
              <span className="text-slate-900 dark:text-white font-bold">04. Banking, General Ledger & Statements</span>
            </span>
            <button
              onClick={() => setCurrentView('reports')}
              className="text-slate-600 dark:text-slate-400 hover:underline font-semibold whitespace-nowrap"
            >
              Open Report Center (Alt+R) →
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <button
              onClick={() => setCurrentView('accounts')}
              className="p-4 rounded-xl bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 hover:border-brand-500 hover:bg-white dark:hover:bg-slate-800 text-left transition-all group"
            >
              <BookOpen className="w-5 h-5 text-indigo-600 dark:text-indigo-400 mb-2.5 group-hover:scale-105 transition-transform" />
              <div className="font-bold text-xs text-slate-900 dark:text-white">Chart of Accounts</div>
              <div className="text-[11px] text-slate-500 mt-1">
                {accounts.length} GAAP accounts & journal lines
              </div>
            </button>

            <button
              onClick={() => setCurrentView('banking')}
              className="p-4 rounded-xl bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 hover:border-brand-500 hover:bg-white dark:hover:bg-slate-800 text-left transition-all group"
            >
              <Landmark className="w-5 h-5 text-brand-600 dark:text-brand-400 mb-2.5 group-hover:scale-105 transition-transform" />
              <div className="font-bold text-xs text-slate-900 dark:text-white">Check Register</div>
              <div className="text-[11px] text-slate-500 mt-1">
                Real-time cleared transaction register
              </div>
            </button>

            <button
              onClick={() => setCurrentView('reconciliation')}
              className="p-4 rounded-xl bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 hover:border-emerald-500 hover:bg-white dark:hover:bg-slate-800 text-left transition-all group"
            >
              <Scale className="w-5 h-5 text-emerald-600 dark:text-emerald-400 mb-2.5 group-hover:scale-105 transition-transform" />
              <div className="font-bold text-xs text-slate-900 dark:text-white">Reconcile Accounts</div>
              <div className="text-[11px] text-slate-500 mt-1">
                Balance statement delta to {formatCurrency(0, currency)}
              </div>
            </button>

            <button
              onClick={() => setCurrentView('reports')}
              className="p-4 rounded-xl bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 hover:border-amber-500 hover:bg-white dark:hover:bg-slate-800 text-left transition-all group"
            >
              <BarChart3 className="w-5 h-5 text-amber-600 dark:text-amber-400 mb-2.5 group-hover:scale-105 transition-transform" />
              <div className="font-bold text-xs text-slate-900 dark:text-white">Financial Statements</div>
              <div className="text-[11px] text-slate-500 mt-1">
                Accrual & Cash P&L, Balance Sheet
              </div>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
