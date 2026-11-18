import React, { useState, useEffect, useRef } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { formatCurrency } from '../../utils/currency';
import {
  Search,
  FileText,
  Receipt,
  Users,
  Building2,
  Package,
  BookOpen,
  Sparkles,
  CreditCard,
  Scale,
  X,
  ArrowRight,
  Printer,
  FileSpreadsheet,
  Calculator,
  FolderOpen,
} from 'lucide-react';

export const CommandPalette: React.FC = () => {
  const {
    isCommandPaletteOpen,
    setIsCommandPaletteOpen,
    setCurrentView,
    setIsNewInvoiceOpen,
    setIsEnterBillOpen,
    setIsWriteCheckOpen,
    setIsReceivePaymentOpen,
    setIsOcrScannerOpen,
    invoices,
    customers,
    vendors,
    inventoryItems,
    accounts,
    companyProfile,
  } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCommandPaletteOpen) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isCommandPaletteOpen]);

  if (!isCommandPaletteOpen) return null;

  const lower = query.toLowerCase().trim();

  // Filter actions
  const actions = [
    {
      id: 'act-invoice',
      title: 'Create New Invoice',
      subtitle: 'Shortcut: Alt+N',
      icon: FileText,
      handler: () => {
        setIsNewInvoiceOpen(true);
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-bill',
      title: 'Enter Vendor Bill',
      subtitle: 'Shortcut: Alt+B',
      icon: Receipt,
      handler: () => {
        setIsEnterBillOpen(true);
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-check',
      title: 'Write Check',
      subtitle: 'Shortcut: Alt+W',
      icon: CreditCard,
      handler: () => {
        setIsWriteCheckOpen(true);
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-payment',
      title: 'Receive Customer Payment',
      subtitle: 'Apply payments against open invoices',
      icon: FileText,
      handler: () => {
        setIsReceivePaymentOpen(true);
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-ocr',
      title: 'AI Receipt OCR Scanner',
      subtitle: 'Scan receipt image and auto-extract expenses',
      icon: Sparkles,
      handler: () => {
        setIsOcrScannerOpen(true);
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-quick-print',
      title: 'Open Quick Photocopy & Type/Print Desk',
      subtitle: 'Raw-material paper & toner costing with manual selling price & real profit',
      icon: Calculator,
      handler: () => {
        setCurrentView('quick-print');
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-examinations',
      title: 'Open Examination Printing Module',
      subtitle: 'Schedule class/subject papers & create consolidated school invoices',
      icon: Printer,
      handler: () => {
        setCurrentView('examinations');
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-contracts',
      title: 'Open School Printing Contracts',
      subtitle: 'Prepaid lump-sum retainers & 2–5 assessment deductions',
      icon: FileSpreadsheet,
      handler: () => {
        setCurrentView('contracts');
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-documents',
      title: 'Open All Documents Center',
      subtitle: 'Unified invoices, quotes, contracts, exams & uploaded files vault',
      icon: FolderOpen,
      handler: () => {
        setCurrentView('documents');
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-payroll',
      title: 'Open Payroll Center',
      subtitle: 'Run payroll, view pay stubs & Form 941',
      icon: Users,
      handler: () => {
        setCurrentView('payroll');
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-reconcile',
      title: 'Reconcile Bank Statement',
      subtitle: `Match cleared transactions to ${formatCurrency(0, currency)} difference`,
      icon: Scale,
      handler: () => {
        setCurrentView('reconciliation');
        setIsCommandPaletteOpen(false);
      },
    },
    {
      id: 'act-reports',
      title: 'Financial Reports Center',
      subtitle: 'P&L, Balance Sheet, Cash Flow, Trial Balance',
      icon: BookOpen,
      handler: () => {
        setCurrentView('reports');
        setIsCommandPaletteOpen(false);
      },
    },
  ].filter(
    a => !lower || a.title.toLowerCase().includes(lower) || a.subtitle.toLowerCase().includes(lower)
  );

  // Filter records
  const matchingInvoices = invoices.filter(
    i =>
      !lower ||
      i.invoiceNumber.toLowerCase().includes(lower) ||
      customers.find(c => c.id === i.customerId)?.companyName.toLowerCase().includes(lower)
  ).slice(0, 4);

  const matchingCustomers = customers.filter(
    c =>
      !lower ||
      c.name.toLowerCase().includes(lower) ||
      c.companyName.toLowerCase().includes(lower)
  ).slice(0, 4);

  const matchingVendors = vendors.filter(
    v =>
      !lower ||
      v.name.toLowerCase().includes(lower) ||
      v.companyName.toLowerCase().includes(lower)
  ).slice(0, 4);

  const matchingItems = inventoryItems.filter(
    i =>
      !lower ||
      i.name.toLowerCase().includes(lower) ||
      i.sku.toLowerCase().includes(lower)
  ).slice(0, 4);

  const matchingAccounts = accounts.filter(
    a =>
      !lower ||
      a.name.toLowerCase().includes(lower) ||
      a.code.includes(lower)
  ).slice(0, 4);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-start justify-center pt-20 p-4">
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[80vh]">
        {/* Search Input */}
        <div className="flex items-center px-4 py-3 border-b border-slate-200 dark:border-slate-800 gap-3">
          <Search className="w-5 h-5 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Type a command, transaction #, customer, vendor, or account..."
            className="w-full bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 outline-none"
            onKeyDown={e => {
              if (e.key === 'Escape') setIsCommandPaletteOpen(false);
            }}
          />
          <button
            onClick={() => setIsCommandPaletteOpen(false)}
            className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results List */}
        <div className="overflow-y-auto p-2 space-y-4 text-xs">
          {/* Quick Actions */}
          {actions.length > 0 && (
            <div>
              <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Quick Actions
              </div>
              <div className="space-y-1">
                {actions.map(act => {
                  const Icon = act.icon;
                  return (
                    <button
                      key={act.id}
                      onClick={act.handler}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left transition-colors group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-300 group-hover:bg-amber-400 group-hover:text-slate-950 transition-colors">
                          <Icon className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="font-semibold text-slate-800 dark:text-slate-200">
                            {act.title}
                          </div>
                          <div className="text-[11px] text-slate-500">{act.subtitle}</div>
                        </div>
                      </div>
                      <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-slate-600 dark:group-hover:text-slate-300 transition-colors" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Invoices */}
          {matchingInvoices.length > 0 && (
            <div>
              <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Invoices
              </div>
              <div className="space-y-1">
                {matchingInvoices.map(inv => {
                  const cust = customers.find(c => c.id === inv.customerId);
                  return (
                    <button
                      key={inv.id}
                      onClick={() => {
                        setCurrentView('invoices');
                        setIsCommandPaletteOpen(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 text-blue-500" />
                        <span className="font-semibold font-mono">{inv.invoiceNumber}</span>
                        <span className="text-slate-600 dark:text-slate-400">· {cust?.companyName}</span>
                      </div>
                      <div className="font-mono tabular-nums text-slate-700 dark:text-slate-300 font-semibold">
                        {formatCurrency(inv.total, currency)}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Customers */}
          {matchingCustomers.length > 0 && (
            <div>
              <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Customers
              </div>
              <div className="space-y-1">
                {matchingCustomers.map(cust => (
                  <button
                    key={cust.id}
                    onClick={() => {
                      setCurrentView('customers');
                      setIsCommandPaletteOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <Users className="w-3.5 h-3.5 text-emerald-500" />
                      <span className="font-semibold">{cust.companyName}</span>
                      <span className="text-slate-500">({cust.name})</span>
                    </div>
                    <div className="font-mono tabular-nums text-blue-600 dark:text-blue-400 font-semibold">
                      Bal: {formatCurrency(cust.balance, currency)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Vendors */}
          {matchingVendors.length > 0 && (
            <div>
              <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Vendors
              </div>
              <div className="space-y-1">
                {matchingVendors.map(v => (
                  <button
                    key={v.id}
                    onClick={() => {
                      setCurrentView('vendors');
                      setIsCommandPaletteOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <Building2 className="w-3.5 h-3.5 text-amber-500" />
                      <span className="font-semibold">{v.companyName}</span>
                    </div>
                    <div className="font-mono tabular-nums text-rose-600 dark:text-rose-400 font-semibold">
                      Due: {formatCurrency(v.balance, currency)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Chart of Accounts */}
          {matchingAccounts.length > 0 && (
            <div>
              <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Chart of Accounts
              </div>
              <div className="space-y-1">
                {matchingAccounts.map(acc => (
                  <button
                    key={acc.id}
                    onClick={() => {
                      setCurrentView('accounts');
                      setIsCommandPaletteOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <BookOpen className="w-3.5 h-3.5 text-indigo-500" />
                      <span className="font-mono font-bold text-slate-500">{acc.code}</span>
                      <span className="font-medium">{acc.name}</span>
                    </div>
                    <div className="font-mono tabular-nums font-semibold">
                      {formatCurrency(acc.balance, currency)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer shortcuts helper */}
        <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 flex items-center justify-between text-[11px] text-slate-500">
          <div className="flex items-center gap-2">
            <span>Navigation:</span>
            <kbd className="px-1 bg-white dark:bg-slate-800 border rounded text-[10px]">Esc to close</kbd>
          </div>
          <span>Printing Management System Global Index</span>
        </div>
      </div>
    </div>
  );
};
