import React, { useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { Customer, Invoice } from '../../types/accounting';
import { formatCurrency, getCurrencySymbol } from '../../utils/currency';
import { RowActionMenu } from '../common/RowActionMenu';
import {
  FileText,
  Printer,
  Copy,
  ExternalLink,
} from 'lucide-react';
import { Button, DataTableShell, EmptyState, ModalHeader, ModalShell } from '../common/ui';

interface CustomerStatementModalProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const CustomerStatementModal: React.FC<CustomerStatementModalProps> = (props) => {
  const { isStatementOpen, setIsStatementOpen, customers, invoices, companyProfile, setCurrentView, triggerShortcutNotice, openPrimePreview } = useAccounting();
  const currency = companyProfile.currency || 'K';
  const currencySymbol = getCurrencySymbol(currency);
  const isOpen = props.isOpen !== undefined ? props.isOpen : isStatementOpen;
  const onClose = props.onClose || (() => setIsStatementOpen(false));

  const [selectedCustId, setSelectedCustId] = useState<string>(customers[0]?.id || '');
  const [statementDate, setStatementDate] = useState(new Date().toISOString().split('T')[0]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const customer = customers.find(c => c.id === selectedCustId) || customers[0];
  const customerInvoices = invoices.filter(i => i.customerId === customer?.id);
  const totalBalance = customer?.balance || 0;

  // Compute real aging from invoice due dates (not hardcoded percentages)
  const asOfDate = new Date(statementDate);
  const agingBuckets = {
    current: 0,
    d1_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90plus: 0,
  };

  for (const inv of customerInvoices) {
    if (String(inv.status) === 'voided' || inv.balanceDue <= 0) continue;
    const dueDate = new Date(inv.dueDate);
    const daysPastDue = Math.floor((asOfDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysPastDue <= 0) {
      agingBuckets.current += inv.balanceDue;
    } else if (daysPastDue <= 30) {
      agingBuckets.d1_30 += inv.balanceDue;
    } else if (daysPastDue <= 60) {
      agingBuckets.d31_60 += inv.balanceDue;
    } else if (daysPastDue <= 90) {
      agingBuckets.d61_90 += inv.balanceDue;
    } else {
      agingBuckets.d90plus += inv.balanceDue;
    }
  }

  return (
    <ModalShell open={isOpen} onClose={onClose} titleId="customer-statement-title" size="3xl">
      <ModalHeader
        title="Customer Billing Statement"
        subtitle="Account activity, invoice aging, and printable remittance slip"
        icon={<FileText className="w-5 h-5" strokeWidth={1.75} />}
        tone="brand"
        titleId="customer-statement-title"
        onClose={onClose}
      />

      {/* Options Toolbar (no-print) */}
      <div className="px-5 py-3 bg-slate-50 dark:bg-slate-900/80 border-b border-slate-200 dark:border-white/[0.07] flex flex-wrap items-center justify-between gap-4 text-xs no-print">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="statement-customer-select" className="font-semibold text-slate-700 dark:text-slate-300">
              Customer:
            </label>
            <select
              id="statement-customer-select"
              value={selectedCustId}
              onChange={e => setSelectedCustId(e.target.value)}
              className="app-input w-auto min-w-[220px]"
            >
              {customers.map(c => (
                <option key={c.id} value={c.id}>
                  {c.companyName} (Due: {formatCurrency(c.balance, currency)})
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="statement-date-input" className="font-semibold text-slate-700 dark:text-slate-300">
              Statement Date:
            </label>
            <input
              id="statement-date-input"
              type="date"
              value={statementDate}
              onChange={e => setStatementDate(e.target.value)}
              className="app-input app-input-mono w-auto"
            />
          </div>
        </div>

        <Button
          variant="primary"
          size="sm"
          disabled={!customer}
          icon={<Printer className="w-3.5 h-3.5" strokeWidth={1.75} />}
          onClick={() => {
            const totalDebit = customerInvoices.reduce((s, i) => s + (i.total || 0), 0);
            const totalCredit = customerInvoices.reduce((s, i) => s + (i.amountPaid || 0), 0);
            openPrimePreview(
              'ACCOUNT_STATEMENT',
              {
                number: `STMT-${customer?.id || '0'}`,
                statementNumber: `STMT-${customer?.id || '0'}`,
                date: statementDate,
                clientName: customer?.companyName || '',
                customerName: customer?.companyName || '',
                address: customer?.billingAddress || companyProfile.address || '',
                phone: customer?.phone || companyProfile.phone || '',
                openingBalance: 0,
                closingBalance: totalBalance,
                finalBalance: totalBalance,
                startDate: (customerInvoices.map(i => i.date).filter(Boolean).sort()[0]) || statementDate,
                endDate: statementDate,
                totalDebit,
                totalCredit,
                currency: currency,
                transactions: customerInvoices.map(inv => ({
                  date: inv.date,
                  reference: inv.invoiceNumber,
                  description: inv.notes || 'Invoice',
                  debit: inv.total || 0,
                  credit: inv.amountPaid || 0,
                  balance: inv.balanceDue || 0,
                })),
              },
              `Statement — ${customer?.companyName || ''}`
            );
          }}
        >
          Print Statement
        </Button>
      </div>

      {/* Printable Document Body */}
      <div className="p-6 sm:p-8 space-y-6 overflow-y-auto text-xs bg-white text-slate-900 font-sans">
        {!customer ? (
          <EmptyState
            title="No customers available"
            description="Create a customer account before generating a billing statement."
            icon={<FileText className="w-5 h-5" strokeWidth={1.75} />}
          />
        ) : (
          <>
          {/* Statement Header */}
          <div className="flex justify-between items-start border-b pb-4">
            <div>
              <h1 className="text-xl font-black uppercase text-slate-900 tracking-tight">
                {companyProfile.legalName}
              </h1>
              <div className="text-slate-600 text-[11px] leading-relaxed mt-1">
                {companyProfile.address} · {companyProfile.cityStateZip}
                <br />
                Phone: {companyProfile.phone} · EIN: {companyProfile.ein}
              </div>
            </div>

            <div className="text-right">
              <div className="text-2xl font-black text-[#0f3d63] tracking-wider">STATEMENT</div>
              <div className="font-mono text-xs font-bold text-slate-700 mt-1">
                Statement Date: {statementDate}
              </div>
              <div className="text-xs text-slate-500">Account: #{customer.id.toUpperCase()}</div>
            </div>
          </div>

          {/* Recipient Box */}
          <div className="p-4 rounded-lg bg-slate-50 border grid grid-cols-2 gap-4">
            <div>
              <span className="text-[10px] uppercase font-bold text-slate-400">To:</span>
              <div className="font-bold text-sm text-slate-900 mt-0.5">{customer.companyName}</div>
              <div className="text-slate-600">Attn: {customer.name}</div>
              <div className="text-slate-600">{customer.billingAddress}</div>
            </div>

            <div className="font-mono text-right space-y-1">
              <div>
                <span className="text-slate-500 font-sans text-[11px]">Payment Terms: </span>
                <span className="font-semibold">{customer.terms}</span>
              </div>
              <div>
                <span className="text-slate-500 font-sans text-[11px]">Total Balance Due: </span>
                <span className="font-black text-blue-700 text-sm">{formatCurrency(totalBalance, currency)}</span>
              </div>
            </div>
          </div>

          {/* Activity Table */}
          <div>
            <h3 className="font-bold text-xs uppercase tracking-wider mb-2 text-slate-800">
              Transaction Activity
            </h3>
            <DataTableShell className="rounded-lg border border-slate-300">
            <table className="w-full text-left">
              <thead className="bg-slate-100 font-bold text-[11px] uppercase text-slate-700 border-b border-slate-300">
                <tr>
                  <th className="p-2 border-r">DATE</th>
                  <th className="p-2 border-r">TRANSACTION / INVOICE #</th>
                  <th className="p-2 border-r">DESCRIPTION</th>
                  <th className="p-2 text-right border-r">AMOUNT</th>
                  <th className="p-2 text-right border-r">PAYMENTS</th>
                  <th className="p-2 text-right">BALANCE DUE</th>
                  <th className="p-2 text-right no-print">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 font-mono text-xs">
                {customerInvoices.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-4 text-center text-slate-400 font-sans">
                      No statement activity for this customer.
                    </td>
                  </tr>
                ) : (
                  customerInvoices.map(inv => (
                    <tr key={inv.id}>
                      <td className="p-2 border-r">{inv.date}</td>
                      <td className="p-2 border-r font-bold text-blue-700">{inv.invoiceNumber}</td>
                      <td className="p-2 border-r font-sans truncate max-w-[200px]">
                        {inv.notes || 'Industrial fabrication invoice'}
                      </td>
                      <td className="p-2 text-right border-r font-bold">{formatCurrency(inv.total, currency)}</td>
                      <td className="p-2 text-right border-r text-emerald-700">
                        -{formatCurrency(inv.amountPaid, currency)}
                      </td>
                      <td className="p-2 text-right font-black text-slate-900">
                        {formatCurrency(inv.balanceDue, currency)}
                      </td>
                      <td className="p-2 text-right font-sans no-print">
                        <RowActionMenu
                          label={`Actions for ${inv.invoiceNumber}`}
                          items={[
                            {
                              id: 'open-invoices',
                              label: 'Open Invoices Center',
                              icon: <ExternalLink className="w-3.5 h-3.5 text-blue-600" />,
                              onClick: () => {
                                setCurrentView('invoices');
                                onClose();
                              },
                            },
                            {
                              id: 'copy-inv',
                              label: 'Copy Invoice #',
                              icon: <Copy className="w-3.5 h-3.5" />,
                              dividerBefore: true,
                              onClick: () => {
                                navigator.clipboard?.writeText(inv.invoiceNumber);
                                triggerShortcutNotice(`Copied ${inv.invoiceNumber}`);
                              },
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </DataTableShell>
          </div>

          {/* Aging Summary Buckets */}
          <div className="border border-slate-300 rounded overflow-hidden">
            <div className="bg-slate-100 p-2 font-bold text-[11px] uppercase text-slate-700">
              Aging Analysis
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-300 text-center font-mono tabular-nums p-3">
              <div className="py-1 sm:py-0">
                <span className="text-[11px] font-sans text-slate-600">Current</span>
                <div className="font-bold mt-1">{formatCurrency(agingBuckets.current, currency)}</div>
              </div>
              <div className="py-1 sm:py-0">
                <span className="text-[11px] font-sans text-slate-600">1 - 30 Days</span>
                <div className="font-bold mt-1">{formatCurrency(agingBuckets.d1_30, currency)}</div>
              </div>
              <div className="py-1 sm:py-0">
                <span className="text-[11px] font-sans text-slate-600">31 - 60 Days</span>
                <div className="font-bold mt-1">{formatCurrency(agingBuckets.d31_60, currency)}</div>
              </div>
              <div className="py-1 sm:py-0">
                <span className="text-[11px] font-sans text-slate-600">60+ Days</span>
                <div className="font-bold mt-1 text-slate-700">{formatCurrency(agingBuckets.d61_90 + agingBuckets.d90plus, currency)}</div>
              </div>
            </div>
          </div>

          {/* Remittance Tear-off Slip */}
          <div className="border-t-2 border-dashed border-slate-400 pt-4 space-y-2">
            <div className="text-[11px] uppercase font-bold text-slate-600">
              Please Detach and Return With Your Remittance
            </div>
            <div className="flex flex-wrap justify-between items-center gap-2 text-xs font-mono">
              <div>
                Customer: <strong>{customer.companyName}</strong> · Account #{customer.id}
              </div>
              <div className="text-right">
                Amount Enclosed: {currencySymbol}___________________
              </div>
            </div>
          </div>
          </>
        )}
      </div>
    </ModalShell>
  );
};
