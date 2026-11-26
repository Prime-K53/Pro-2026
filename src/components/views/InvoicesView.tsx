import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT, accountingApi, ApiAccount } from '../../services/accountingApi';
import { ApiCustomer, ApiInvoice, commercialApi } from '../../services/commercialApi';
import { useFxRates } from '../../hooks/useFxRates';
import { Pagination, pageSlice } from '../common/Pagination';
import { documentsApi } from '../../services/documentsApi';
import { DocumentPreviewKind, mapApiPreviewToModel } from '../../types/documents';
import { formatCurrency } from '../../utils/currency';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions, isActionExecutable } from '../../actions/evaluateActions';
import type {
  ActionEligibilityContext,
  AdvancedActionDefinition,
  ResolvedAdvancedAction,
} from '../../actions/types';
import {
  TransactionDetailDrawer,
  TransactionActionMenu,
  TransactionContextMenu,
  TransactionSelectionProvider,
  useTransactionSelection,
  TransactionAuditTimeline,
  useTransactionAudit,
  createTransactionRef,
  type DetailSection,
} from '../../transaction-interaction';
import {
  FileText,
  FileCheck2,
  Plus,
  Search,
  Printer,
  DollarSign,
  CheckCircle2,
  Clock,
  ArrowRight,
  ArrowLeft,
  Copy,
  X,
  ArrowUpDown,
  Ban,
  Mail,
  Repeat,
  Play,
  CreditCard,
  AlertTriangle,
  Loader2,
  Lock,
  Eye,
  Wallet,
  Scissors,
  ShieldAlert,
  Download,
  BookOpen,
  Layers,
} from 'lucide-react';
import { downloadPrimeDocument } from '../../pdf/generatePrimeDocumentBlob';
import { getStoredCompanyConfig } from '../../pdf/templateSettings';
import { ApplyCustomerDepositModal } from '../modals/ApplyCustomerDepositModal';
import { WriteOffBalanceModal } from '../modals/WriteOffBalanceModal';

type SalesTab = 'invoices' | 'payments' | 'creditMemos' | 'estimates' | 'recurring' | 'collections';

interface PaymentLike {
  id: number;
  paymentNumber: string;
  customerId?: number | null;
  customerName: string;
  paymentDate: string;
  paymentMethod: string;
  depositAccountId?: number | null;
  depositAccountName?: string;
  amount: number;
  isVoided?: boolean;
  allocations?: Array<{ invoiceId?: number; invoiceNumber: string; amount: number }>;
  createdBy?: string | null;
  createdAt?: string | null;
  reversedBy?: string | null;
  reversedAt?: string | null;
}

interface CustomerPaymentsTableProps {
  payments: PaymentLike[];
  currency: string;
  authenticated: boolean;
  permissions: string[];
  role: string | null;
  companyId: number | null;
  canWrite: boolean;
  onPreview: (id: number) => void;
  onOpenCustomer: (customerId: number) => void;
  reload: () => Promise<void> | void;
  notify: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
}

const paymentRef = (p: PaymentLike) =>
  createTransactionRef(p, {
    moduleKey: 'payments',
    entityType: 'customer_payment',
    id: (x) => x.id,
    number: (x) => x.paymentNumber,
    status: (x) => (x.isVoided ? 'voided' : 'posted'),
  });

const allocatedOf = (p: PaymentLike) => (p.allocations || []).reduce((s, a) => s + Number(a.amount || 0), 0);

function buildPaymentSections(p: PaymentLike, currency: string): DetailSection[] {
  const allocated = allocatedOf(p);
  const unallocated = Number(p.amount || 0) - allocated;
  const sections: DetailSection[] = [
    {
      key: 'payment',
      title: 'Payment',
      fields: [
        { label: 'Payment #', value: p.paymentNumber, mono: true },
        { label: 'Date', value: p.paymentDate, mono: true },
        { label: 'Customer', value: p.customerName },
        { label: 'Method', value: p.paymentMethod },
        { label: 'Deposit account', value: p.depositAccountName || (p.depositAccountId ? `#${p.depositAccountId}` : '—') },
        { label: 'Amount', value: formatCurrency(Number(p.amount || 0), currency), mono: true, tone: 'emerald' },
        { label: 'Status', value: p.isVoided ? 'Voided' : 'Posted' },
        { label: 'Allocated', value: formatCurrency(allocated, currency), mono: true },
        { label: 'Unallocated', value: formatCurrency(unallocated, currency), mono: true, tone: unallocated > 0 ? 'amber' : 'default' },
      ],
    },
    {
      key: 'allocations',
      title: 'Linked invoices & allocations',
      content:
        p.allocations && p.allocations.length > 0 ? (
          <table className="w-full text-left text-[11px]">
            <thead className="text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="py-1.5 pr-2">Invoice</th>
                <th className="py-1.5 pl-2 text-right">Allocated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {p.allocations.map((a, i) => (
                <tr key={`${a.invoiceNumber}-${i}`}>
                  <td className="py-1.5 pr-2 font-sans">{a.invoiceNumber}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums">{formatCurrency(Number(a.amount || 0), currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[11px] text-slate-400">Unapplied / Prepayment (no linked invoices).</p>
        ),
    },
    {
      key: 'meta',
      title: 'Record keeping',
      fields: [
        { label: 'Created by', value: p.createdBy || '—' },
        { label: 'Created at', value: p.createdAt || '—' },
        ...(p.isVoided
          ? [
              { label: 'Reversed by', value: p.reversedBy || '—' },
              { label: 'Reversed at', value: p.reversedAt || '—' },
            ]
          : []),
      ],
    },
  ];
  return sections;
}

function buildInvoiceSections(
  inv: ApiInvoice,
  currency: string,
  payments: PaymentLike[]
): DetailSection[] {
  const linked = payments.filter(
    (p) => !p.isVoided && (p.allocations || []).some((a) => a.invoiceNumber === inv.invoiceNumber)
  );
  const sections: DetailSection[] = [
    {
      key: 'doc',
      title: 'Document',
      fields: [
        { label: 'Document #', value: inv.invoiceNumber, mono: true },
        { label: 'Customer', value: inv.customerName },
        { label: 'Invoice date', value: inv.invoiceDate, mono: true },
        { label: 'Due date', value: inv.dueDate, mono: true },
        { label: 'Type', value: inv.isSalesReceipt ? 'Sales Receipt' : 'Invoice' },
        { label: 'Status', value: inv.status },
        { label: 'Currency', value: inv.currencyCode || currency },
      ],
    },
    {
      key: 'amounts',
      title: 'Amounts',
      fields: [
        { label: 'Total', value: formatCurrency(inv.total, currency), mono: true },
        { label: 'Amount paid', value: formatCurrency(inv.amountPaid, currency), mono: true, tone: 'emerald' },
        { label: 'Balance due', value: formatCurrency(inv.balanceDue, currency), mono: true, tone: 'teal' },
      ],
    },
    {
      key: 'payments',
      title: 'Linked payments',
      content:
        linked.length > 0 ? (
          <table className="w-full text-left text-[11px]">
            <thead className="text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="py-1.5 pr-2">Payment</th>
                <th className="py-1.5 px-2">Date</th>
                <th className="py-1.5 pl-2 text-right">Allocated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {linked.map((p) => (
                <tr key={p.id}>
                  <td className="py-1.5 pr-2 font-sans">{p.paymentNumber}</td>
                  <td className="py-1.5 px-2">{p.paymentDate}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums">
                    {formatCurrency((p.allocations || []).filter((a) => a.invoiceNumber === inv.invoiceNumber).reduce((s, a) => s + Number(a.amount || 0), 0), currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[11px] text-slate-400">No linked payments.</p>
        ),
    },
  ];
  return sections;
}

function CustomerPaymentsInner({
  payments,
  currency,
  authenticated,
  permissions,
  role,
  companyId,
  canWrite,
  onPreview,
  onOpenCustomer,
  reload,
  notify,
}: CustomerPaymentsTableProps) {
  const selection = useTransactionSelection();
  const [detail, setDetail] = useState<PaymentLike | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    point: { x: number; y: number };
    payment: PaymentLike;
    resolved: ResolvedAdvancedAction<PaymentLike>[];
    ctx: ActionEligibilityContext<PaymentLike>;
  } | null>(null);

  useEffect(() => {
    selection.setOrderedIds(payments.map((p) => p.id));
  }, [payments, selection]);

  const ctxFor = useCallback(
    (p: PaymentLike): ActionEligibilityContext<PaymentLike> => ({
      authenticated,
      permissions,
      role,
      companyId,
      moduleKey: 'payments',
      entityType: 'customer_payment',
      record: p,
      recordStatus: p.isVoided ? 'voided' : 'posted',
    }),
    [authenticated, permissions, role, companyId]
  );

  const buildActions = useCallback(
    (p: PaymentLike): AdvancedActionDefinition<PaymentLike>[] => {
      const defs: AdvancedActionDefinition<PaymentLike>[] = [
        {
          id: 'view',
          label: 'View Payment',
          icon: <Eye className="w-3.5 h-3.5" />,
          group: 'view',
          groupLabel: 'Payment',
          requiredPermission: 'invoices:read',
          execute: async () => setDetail(p),
        },
        {
          id: 'copy-ref',
          label: 'Copy Payment Reference',
          icon: <Copy className="w-3.5 h-3.5" />,
          group: 'admin',
          groupLabel: 'Other',
          requiredPermission: 'invoices:read',
          execute: async () => {
            await navigator.clipboard?.writeText(p.paymentNumber);
            notify(`Copied ${p.paymentNumber}`);
          },
        },
        {
          id: 'preview',
          label: 'Preview Receipt',
          icon: <Printer className="w-3.5 h-3.5" />,
          group: 'documents',
          groupLabel: 'Documents',
          requiredPermission: 'invoices:read',
          execute: async () => onPreview(p.id),
        },
        {
          id: 'view-allocations',
          label: 'View Allocations',
          icon: <Layers className="w-3.5 h-3.5" />,
          group: 'investigate',
          groupLabel: 'Investigation',
          requiredPermission: 'invoices:read',
          execute: async () => setDetail(p),
        },
      ];
      if (p.customerId != null) {
        defs.push({
          id: 'open-customer',
          label: 'Open Customer Ledger',
          icon: <BookOpen className="w-3.5 h-3.5" />,
          group: 'navigation',
          groupLabel: 'Navigation',
          requiredPermission: 'invoices:read',
          execute: async () => onOpenCustomer(p.customerId as number),
        });
      }
      defs.push({
        id: 'audit',
        label: 'View Audit History',
        icon: <BookOpen className="w-3.5 h-3.5" />,
        group: 'investigate',
        groupLabel: 'Investigation',
        requiredPermission: 'audit:read',
        execute: async () => setDetail(p),
      });
      if (canWrite && !p.isVoided) {
        defs.push({
          id: 'void',
          label: 'Void Payment (Reverse GL)',
          icon: <Ban className="w-3.5 h-3.5 text-rose-600" />,
          group: 'danger',
          groupLabel: 'Sensitive operations',
          destructive: true,
          risk: 'destructive',
          requiredPermission: 'invoices:write',
          confirmation: {
            title: `Void ${p.paymentNumber}`,
            message: 'Void this customer payment and reverse its GL impact using the existing authorized workflow?',
            confirmLabel: 'Void',
            destructive: true,
            requireReason: true,
            reasonLabel: 'Void reason',
          },
          execute: async (_ctx, helpers) => {
            await commercialApi.voidPayment(p.id, helpers.reason || 'Voided by user');
            notify(`Voided payment ${p.paymentNumber} & reversed GL`);
            await reload();
          },
        });
      }
      return defs;
    },
    [canWrite, notify, onOpenCustomer, onPreview, reload]
  );

  const detailRef = useMemo(() => (detail ? paymentRef(detail) : null), [detail]);
  const audit = useTransactionAudit(undefined, detailRef, Boolean(detail));
  const canReadAudit = permissions.includes('audit:read');
  const allSelected = payments.length > 0 && payments.every((p) => selection.isSelected(p.id));
  const selected = payments.filter((p) => selection.isSelected(p.id));

  const exportSelected = () => {
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Payment', 'Customer', 'Date', 'Method', 'Amount', 'Allocated', 'Status'];
    const lines = selected.map((p) =>
      [p.paymentNumber, p.customerName, p.paymentDate, p.paymentMethod, p.amount, allocatedOf(p), p.isVoided ? 'Voided' : 'Posted']
        .map(cell)
        .join(',')
    );
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'customer-payments-selection.csv';
    a.click();
    URL.revokeObjectURL(url);
    notify(`Exported ${selected.length} payment(s)`);
  };

  return (
    <>
      {selected.length > 0 && (
        <div className="flex justify-end px-1">
          <button
            type="button"
            onClick={exportSelected}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Download className="w-3.5 h-3.5" /> Export selected ({selected.length})
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-[#e4ddd1] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-slate-900/70">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <span className="text-xs font-bold text-slate-900 dark:text-white">Customer Payments & Allocations</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase text-[10px] font-bold border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2.5 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all payments"
                    checked={allSelected}
                    onChange={() => (allSelected ? selection.clear() : selection.selectAll(payments.map((p) => p.id)))}
                  />
                </th>
                <th className="px-4 py-2.5">PAYMENT #</th>
                <th className="px-4 py-2.5">CUSTOMER</th>
                <th className="px-4 py-2.5">DATE</th>
                <th className="px-4 py-2.5">METHOD / DEPOSIT ACCT</th>
                <th className="px-4 py-2.5">APPLIED INVOICES</th>
                <th className="px-4 py-2.5 text-right">AMOUNT</th>
                <th className="px-4 py-2.5 text-center">STATUS</th>
                <th className="px-4 py-2.5 text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center font-sans text-slate-400">No payments posted yet.</td>
                </tr>
              ) : (
                payments.map((p) => {
                  const ctx = ctxFor(p);
                  const resolved = resolveActions(buildActions(p), ctx);
                  const isSelected = selection.isSelected(p.id);
                  return (
                    <tr
                      key={p.id}
                      onClick={() => setDetail(p)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ point: { x: e.clientX, y: e.clientY }, payment: p, resolved, ctx });
                      }}
                      className={`cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-850/50 ${
                        p.isVoided ? 'opacity-60' : ''
                      } ${isSelected ? 'bg-blue-50 dark:bg-blue-950/40' : ''}`}
                    >
                      <td className="px-3 py-2.5 align-top" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${p.paymentNumber}`}
                          checked={isSelected}
                          onChange={(e) => selection.toggle(p.id, { shiftKey: (e.nativeEvent as MouseEvent).shiftKey })}
                        />
                      </td>
                      <td className="px-4 py-2.5 font-bold text-[#1f8577] dark:text-[#5ec2b3] align-top">{p.paymentNumber}</td>
                      <td className="px-4 py-2.5 font-sans font-semibold align-top">{p.customerName}</td>
                      <td className="px-4 py-2.5 text-slate-500 align-top">{p.paymentDate}</td>
                      <td className="px-4 py-2.5 font-sans text-slate-600 dark:text-slate-300 align-top">
                        {p.paymentMethod} · {p.depositAccountName || '—'}
                      </td>
                      <td className="px-4 py-2.5 font-sans text-slate-600 dark:text-slate-300 align-top">
                        {(p.allocations || []).map((a) => `${a.invoiceNumber} (${formatCurrency(a.amount, currency)})`).join(', ') || 'Unapplied / Prepayment'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-bold tabular-nums text-emerald-600 dark:text-emerald-400 align-top">
                        {formatCurrency(p.amount, currency)}
                      </td>
                      <td className="px-4 py-2.5 text-center font-sans align-top">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${p.isVoided ? 'bg-slate-200 text-slate-700' : 'bg-emerald-100 text-emerald-800'}`}>
                          {p.isVoided ? 'Voided' : 'Posted'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-sans align-top" onClick={(e) => e.stopPropagation()}>
                        {resolved.length > 0 && (
                          <TransactionActionMenu
                            label={`Actions for ${p.paymentNumber}`}
                            actions={resolved}
                            executionContext={ctx}
                            idempotencyRecordKey={p.id}
                            notify={notify}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <TransactionDetailDrawer
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail ? `Payment ${detail.paymentNumber}` : 'Payment'}
        number={detail?.paymentDate}
        typeLabel={detail?.paymentMethod}
        statusBadge={
          detail ? (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                detail.isVoided
                  ? 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                  : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
              }`}
            >
              {detail.isVoided ? 'voided' : 'posted'}
            </span>
          ) : null
        }
        sections={detail ? buildPaymentSections(detail, currency) : []}
        actions={
          detail
            ? (() => {
                const ctx = ctxFor(detail);
                const resolved = resolveActions(buildActions(detail), ctx);
                return resolved.length > 0 ? (
                  <TransactionActionMenu
                    label={`Actions for ${detail.paymentNumber}`}
                    actions={resolved}
                    executionContext={ctx}
                    idempotencyRecordKey={detail.id}
                    notify={notify}
                  />
                ) : null;
              })()
            : null
        }
        audit={
          canReadAudit ? (
            <TransactionAuditTimeline
              entries={audit.entries}
              loading={audit.loading}
              error={audit.error}
              notice={audit.notice}
            />
          ) : (
            <p className="text-[11px] text-slate-500">
              You need the <span className="font-mono">audit:read</span> permission to view audit history.
            </p>
          )
        }
      />

      {contextMenu && (
        <TransactionContextMenu
          actions={contextMenu.resolved}
          point={contextMenu.point}
          label={`Actions for ${contextMenu.payment.paymentNumber}`}
          executionContext={contextMenu.ctx}
          idempotencyRecordKey={contextMenu.payment.id}
          notify={notify}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

export const CustomerPaymentsTable: React.FC<CustomerPaymentsTableProps> = (props) => (
  <TransactionSelectionProvider>
    <CustomerPaymentsInner {...props} />
  </TransactionSelectionProvider>
);

interface InvoicesTableProps {
  rows: ApiInvoice[];
  colSpan: number;
  emptyMessage: string;
  renderHeader: () => React.ReactNode;
  renderCells: (inv: ApiInvoice) => React.ReactNode;
  onRowClick: (inv: ApiInvoice) => void;
  onRowContextMenu: (inv: ApiInvoice, point: { x: number; y: number }) => void;
  selectedId: number | null;
  footer?: React.ReactNode;
  notify: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
}

function InvoicesTableInner({
  rows,
  colSpan,
  emptyMessage,
  renderHeader,
  renderCells,
  onRowClick,
  onRowContextMenu,
  selectedId,
  footer,
  notify,
}: InvoicesTableProps) {
  const selection = useTransactionSelection();
  useEffect(() => {
    selection.setOrderedIds(rows.map((r) => r.id));
  }, [rows, selection]);
  const selectedRows = rows.filter((r) => selection.isSelected(r.id));
  const allSelected = rows.length > 0 && rows.every((r) => selection.isSelected(r.id));

  const exportSelected = () => {
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Document', 'Customer', 'Date', 'Due', 'Total', 'Balance Due', 'Status'];
    const lines = selectedRows.map((r) =>
      [r.invoiceNumber, r.customerName, r.invoiceDate, r.dueDate, r.total, r.balanceDue, r.status].map(cell).join(',')
    );
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'invoices-selection.csv';
    a.click();
    URL.revokeObjectURL(url);
    notify(`Exported ${selectedRows.length} document(s)`);
  };

  return (
    <>
      {selectedRows.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={exportSelected}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Download className="w-3.5 h-3.5" /> Export selected ({selectedRows.length})
          </button>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-[#e4ddd1] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-slate-900/70">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800 select-none">
              <tr>
                <th className="px-3 py-3 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all invoices"
                    checked={allSelected}
                    onChange={() => (allSelected ? selection.clear() : selection.selectAll(rows.map((r) => r.id)))}
                  />
                </th>
                {renderHeader()}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={colSpan + 1} className="px-4 py-10 text-center text-slate-500 font-sans">
                    {emptyMessage}
                  </td>
                </tr>
              ) : (
                rows.map((inv) => {
                  const isSelected = selection.isSelected(inv.id);
                  return (
                    <tr
                      key={inv.id}
                      onClick={() => onRowClick(inv)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        onRowContextMenu(inv, { x: e.clientX, y: e.clientY });
                      }}
                      className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-850/50 ${
                        inv.status === 'voided' ? 'opacity-60' : ''
                      } ${isSelected ? 'bg-blue-50/70 dark:bg-blue-900/20' : selectedId === inv.id ? 'bg-blue-50/70 dark:bg-blue-900/20 ring-1 ring-inset ring-blue-200 dark:ring-blue-800' : ''}`}
                    >
                      <td className="px-3 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${inv.invoiceNumber}`}
                          checked={isSelected}
                          onChange={(e) => selection.toggle(inv.id, { shiftKey: (e.nativeEvent as MouseEvent).shiftKey })}
                        />
                      </td>
                      {renderCells(inv)}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {footer}
      </div>
    </>
  );
}

export const InvoicesTable: React.FC<InvoicesTableProps> = (props) => (
  <TransactionSelectionProvider>
    <InvoicesTableInner {...props} />
  </TransactionSelectionProvider>
);

export const InvoicesView: React.FC = () => {
  const { companyProfile, tableDensity, openDocumentPreview, triggerShortcutNotice, setIsStatementOpen, setCurrentView } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canWrite = hasPermission('invoices:write');
  const canWriteEst = hasPermission('estimates:write');
  const { options: fxOptions, baseCurrency, rateFor: fxRateFor } = useFxRates();

  const [activeTab, setActiveTab] = useState<SalesTab>('invoices');
  const [hubOpen, setHubOpen] = useState(false);
  const [invoiceFilter, setInvoiceFilter] = useState<'all' | 'open' | 'paid' | 'receipts' | 'voided'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<'invoiceNumber' | 'date' | 'dueDate' | 'total' | 'balanceDue'>('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<number | null>(null);
  const [detailInvoice, setDetailInvoice] = useState<ApiInvoice | null>(null);
  const [selectedEstimateId, setSelectedEstimateId] = useState<number | null>(null);
  const [rowContextMenu, setRowContextMenu] = useState<{ x: number; y: number; type: 'invoice' | 'estimate'; record: any } | null>(null);

  const [invoices, setInvoices] = useState<ApiInvoice[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [creditMemos, setCreditMemos] = useState<any[]>([]);
  const [estimates, setEstimates] = useState<any[]>([]);
  const [costDetailsIncluded, setCostDetailsIncluded] = useState(true);
  const [recurringList, setRecurringList] = useState<any[]>([]);
  const [comms, setComms] = useState<{ remindersSent: any[]; emailLog: any[]; reminderRules: any[] }>({
    remindersSent: [],
    emailLog: [],
    reminderRules: [],
  });
  const [customers, setCustomers] = useState<ApiCustomer[]>([]);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<ApiAccount[]>([]);
  const [aging, setAging] = useState<any>(null);

  const handleOpenPreview = async (kind: DocumentPreviewKind, id: number) => {
    try {
      const raw = await documentsApi.getDocumentPreview(kind, id);
      openDocumentPreview(mapApiPreviewToModel(raw, currency));
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load document preview');
    }
  };

  // Modals
  const [depositModalInvoice, setDepositModalInvoice] = useState<ApiInvoice | null>(null);
  const [writeOffModalInvoice, setWriteOffModalInvoice] = useState<ApiInvoice | null>(null);
  const [isDocModalOpen, setIsDocModalOpen] = useState(false);
  const [docMode, setDocMode] = useState<'invoice' | 'sales_receipt' | 'estimate'>('invoice');
  const [docCustomerId, setDocCustomerId] = useState<number>(0);
  const [docDate, setDocDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [docTaxRate, setDocTaxRate] = useState('16');
  const [docCurrency, setDocCurrency] = useState('ZMW');
  const [docExchangeRate, setDocExchangeRate] = useState('1');
  const [docDepositAcctId, setDocDepositAcctId] = useState<number>(0);
  const [docNotes, setDocNotes] = useState('');
  const [docLines, setDocLines] = useState<
    Array<{ itemId: string; description: string; quantity: string; rate: string; unitCost: string; taxable: boolean }>
  >([{ itemId: '', description: '', quantity: '1', rate: '0', unitCost: '0', taxable: true }]);

  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [pmtCustomerId, setPmtCustomerId] = useState<number>(0);
  const [pmtDate, setPmtDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [pmtMethod, setPmtMethod] = useState('ACH / Wire');
  const [pmtDepositAcctId, setPmtDepositAcctId] = useState<number>(0);
  const [pmtCurrency, setPmtCurrency] = useState('ZMW');
  const [pmtExchangeRate, setPmtExchangeRate] = useState('1');
  const [pmtRef, setPmtRef] = useState('');
  const [pmtAmount, setPmtAmount] = useState('');
  const [pmtAllocations, setPmtAllocations] = useState<Record<number, string>>({});

  const [isCreditMemoOpen, setIsCreditMemoOpen] = useState(false);
  const [cmCustomerId, setCmCustomerId] = useState<number>(0);
  const [cmDescription, setCmDescription] = useState('Print quality allowance / return');
  const [cmQuantity, setCmQuantity] = useState('1');
  const [cmRate, setCmRate] = useState('0');
  const [cmTaxRate, setCmTaxRate] = useState('16');
  const [cmMemo, setCmMemo] = useState('');

  const [applyCmTarget, setApplyCmTarget] = useState<any | null>(null);
  const [applyCmInvoiceId, setApplyCmInvoiceId] = useState<number>(0);
  const [applyCmAmount, setApplyCmAmount] = useState('');

  const [isRecurringModalOpen, setIsRecurringModalOpen] = useState(false);
  const [recCustomerId, setRecCustomerId] = useState<number>(0);
  const [recFreq, setRecFreq] = useState<'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual'>('monthly');
  const [recStartDate, setRecStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [recDesc, setRecDesc] = useState('Monthly School Printing Retainer');
  const [recQty, setRecQty] = useState('1');
  const [recRate, setRecRate] = useState('2500');
  const [recTaxRate, setRecTaxRate] = useState('16');

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [invList, pmtList, cmList, estResp, recList, commResp, custList, invItems, acctList, arAging] = await Promise.all([
        commercialApi.listInvoices(),
        commercialApi.listPayments(),
        commercialApi.listCreditMemos(),
        commercialApi.listEstimates(),
        commercialApi.listRecurringInvoices(),
        commercialApi.getCommunications(),
        commercialApi.listCustomers(),
        commercialApi.listInventory(),
        accountingApi.listAccounts(),
        commercialApi.getArAging(),
      ]);
      setInvoices(invList);
      setPayments(pmtList);
      setCreditMemos(cmList);
      setEstimates(estResp.estimates || []);
      setCostDetailsIncluded(Boolean(estResp.costDetailsIncluded));
      setRecurringList(recList);
      setAging(arAging);
      setComms({
        remindersSent: commResp.remindersSent || [],
        emailLog: commResp.emailLog || [],
        reminderRules: commResp.reminderRules || [],
      });
      setCustomers(custList);
      setInventoryItems(invItems);
      setAccounts(acctList);

      if (custList.length > 0 && !docCustomerId) {
        setDocCustomerId(custList[0].id);
        setPmtCustomerId(custList[0].id);
        setCmCustomerId(custList[0].id);
        setRecCustomerId(custList[0].id);
      }
      const bankAccts = acctList.filter(a => a.account_type === 'Bank' && a.is_active);
      if (bankAccts.length > 0 && !docDepositAcctId) {
        setDocDepositAcctId(bankAccts[0].id);
        setPmtDepositAcctId(bankAccts[0].id);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to load sales ledger');
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id, docCustomerId, docDepositAcctId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const handler = () => loadData();
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, [loadData]);

  const invoiceableItems = inventoryItems.filter(it => it.item_type !== 'raw_material');
  const bankAccounts = accounts.filter(a => (a.account_type === 'Bank' || a.account_type === 'OtherCurrentAsset') && a.is_active);

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const filteredInvoices = invoices
    .filter(inv => {
      const q = searchQuery.toLowerCase();
      const matches =
        !q ||
        inv.invoiceNumber.toLowerCase().includes(q) ||
        inv.customerName.toLowerCase().includes(q) ||
        inv.notes.toLowerCase().includes(q);
      if (!matches) return false;
      if (invoiceFilter === 'open') return inv.status !== 'voided' && !inv.isSalesReceipt && inv.balanceDue > 0;
      if (invoiceFilter === 'paid') return inv.status !== 'voided' && (inv.balanceDue === 0 || inv.status === 'paid');
      if (invoiceFilter === 'receipts') return inv.isSalesReceipt && inv.status !== 'voided';
      if (invoiceFilter === 'voided') return inv.status === 'voided';
      return true;
    })
    .sort((a, b) => {
      const mult = sortDir === 'asc' ? 1 : -1;
      if (sortField === 'total') return (a.total - b.total) * mult;
      if (sortField === 'balanceDue') return (a.balanceDue - b.balanceDue) * mult;
      if (sortField === 'invoiceNumber') return a.invoiceNumber.localeCompare(b.invoiceNumber) * mult;
      if (sortField === 'dueDate') return a.dueDate.localeCompare(b.dueDate) * mult;
      return a.invoiceDate.localeCompare(b.invoiceDate) * mult;
    });

  const pagedInvoices = pageSlice(filteredInvoices, page, pageSize);

  const salesFlowCards: Array<{
    id: SalesTab;
    label: string;
    description: string;
    icon: React.ElementType;
    count: number;
  }> = [
    {
      id: 'invoices',
      label: 'Invoices & Receipts',
      description: 'Official invoicing, sales receipts and live payment status.',
      icon: FileText,
      count: invoices.length,
    },
    {
      id: 'payments',
      label: 'Payments',
      description: 'Record and track payments received from your customers.',
      icon: CreditCard,
      count: payments.length,
    },
    {
      id: 'creditMemos',
      label: 'Credit Memos',
      description: 'Issue, apply and void customer credits against open invoices.',
      icon: Scissors,
      count: creditMemos.length,
    },
    {
      id: 'estimates',
      label: 'Estimates',
      description: 'Generate quotes and track approval through to conversion.',
      icon: FileCheck2,
      count: estimates.length,
    },
    {
      id: 'recurring',
      label: 'Recurring',
      description: 'Automated invoice schedules for retainers and repeat work.',
      icon: Repeat,
      count: recurringList.length,
    },
    {
      id: 'collections',
      label: 'Reminders & Email Log',
      description: 'Collections reminders and outbound communication audit.',
      icon: Mail,
      count: comms.remindersSent.length,
    },
  ];

  const openModalFor = (mode: 'invoice' | 'sales_receipt' | 'estimate') => {
    setDocMode(mode);
    setDocLines([{ itemId: '', description: '', quantity: '1', rate: '0', unitCost: '0', taxable: true }]);
    setDocNotes('');
    setDocCurrency(baseCurrency);
    setDocExchangeRate('1');
    setIsDocModalOpen(true);
  };

  const handleSelectItemOnLine = (idx: number, itemIdStr: string) => {
    const it = invoiceableItems.find(x => String(x.id) === itemIdStr);
    setDocLines(prev =>
      prev.map((l, i) =>
        i !== idx
          ? l
          : {
              ...l,
              itemId: itemIdStr,
              description: it ? it.name : l.description,
              rate: it ? String(Number(it.sales_price || 0)) : l.rate,
              unitCost: it ? String(Number(it.unit_cost || 0)) : l.unitCost,
            }
      )
    );
  };

  const handleSubmitDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docCustomerId) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const payloadLines = docLines.map(l => ({
        itemId: l.itemId ? Number(l.itemId) : null,
        description: l.description.trim() || 'Printing Service / Product',
        quantity: l.quantity || '1',
        rate: l.rate || '0',
        unitCost: l.unitCost || '0',
        taxable: l.taxable,
      }));

      if (docMode === 'estimate') {
        const est = await commercialApi.createEstimate({
          customerId: docCustomerId,
          estimateDate: docDate,
          taxRate: docTaxRate || '0',
          notes: docNotes || undefined,
          lines: payloadLines,
        });
        triggerShortcutNotice(`Created Estimate ${est.estimateNumber}`);
        setActiveTab('estimates');
      } else {
        const inv = await commercialApi.createInvoice({
          customerId: docCustomerId,
          invoiceDate: docDate,
          isSalesReceipt: docMode === 'sales_receipt',
          depositToAccountId: docMode === 'sales_receipt' ? docDepositAcctId : undefined,
          taxRate: docTaxRate || '0',
          currencyCode: docCurrency,
          exchangeRate: docCurrency === baseCurrency ? 1 : Number(docExchangeRate || 1),
          notes: docNotes || undefined,
          lines: payloadLines,
        });
        triggerShortcutNotice(
          `${docMode === 'sales_receipt' ? 'Sales Receipt' : 'Invoice'} ${inv.invoiceNumber} posted to General Ledger`
        );
        setActiveTab('invoices');
      }
      setIsDocModalOpen(false);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Document creation failed');
    } finally {
      setBusy(false);
    }
  };

  const openReceivePaymentForInvoice = (inv?: ApiInvoice) => {
    const cid = inv ? inv.customerId : customers[0]?.id || 0;
    setPmtCustomerId(cid);
    setPmtCurrency(inv?.currencyCode || baseCurrency);
    setPmtExchangeRate(String(inv?.exchangeRate || 1));
    if (inv) {
      setPmtAmount(String(inv.balanceDue));
      setPmtAllocations({ [inv.id]: String(inv.balanceDue) });
    } else {
      setPmtAmount('');
      setPmtAllocations({});
    }
    setIsPaymentModalOpen(true);
  };

  const openInvoicesForPmtCust = invoices.filter(
    i => i.customerId === pmtCustomerId && i.status !== 'voided' && !i.isSalesReceipt && i.balanceDue > 0
  );

  const handleSubmitPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      const allocs = Object.entries(pmtAllocations)
        .filter(([, amt]) => Number(amt) > 0)
        .map(([invoiceId, amount]) => ({ invoiceId: Number(invoiceId), amount }));
      const totalFromAllocs = allocs.reduce((s, a) => s + Number(a.amount), 0);
      const amountToSend = Number(pmtAmount) > 0 ? pmtAmount : String(totalFromAllocs);

      const pmt = await commercialApi.recordPayment({
        customerId: pmtCustomerId,
        paymentDate: pmtDate,
        paymentMethod: pmtMethod,
        depositToAccountId: pmtDepositAcctId || undefined,
        referenceNumber: pmtRef || undefined,
        currencyCode: pmtCurrency,
        exchangeRate: pmtCurrency === baseCurrency ? 1 : Number(pmtExchangeRate || 1),
        amount: amountToSend,
        allocations: allocs,
      });
      triggerShortcutNotice(`Recorded payment ${pmt.paymentNumber} & updated General Ledger`);
      setIsPaymentModalOpen(false);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Payment failed');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateCreditMemo = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await commercialApi.createCreditMemo({
        customerId: cmCustomerId,
        taxRate: cmTaxRate || '0',
        memo: cmMemo || undefined,
        lines: [{ description: cmDescription, quantity: cmQuantity || '1', rate: cmRate || '0' }],
      });
      triggerShortcutNotice(`Posted Credit Memo ${res.creditMemo?.creditNumber || ''}`);
      setIsCreditMemoOpen(false);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to create credit memo');
    } finally {
      setBusy(false);
    }
  };

  const handleApplyCreditMemo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!applyCmTarget || !applyCmInvoiceId) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.applyCreditMemo(applyCmTarget.id, {
        invoiceId: applyCmInvoiceId,
        amount: applyCmAmount,
      });
      triggerShortcutNotice(`Applied Credit Memo ${applyCmTarget.creditNumber} to invoice`);
      setApplyCmTarget(null);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to apply credit memo');
    } finally {
      setBusy(false);
    }
  };

  const handleVoidCreditMemo = async (cm: any) => {
    const reason = window.prompt(`Void credit memo ${cm.creditNumber}. Reason (optional):`) ?? '';
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.voidCreditMemo(cm.id, reason || undefined);
      triggerShortcutNotice(`Voided Credit Memo ${cm.creditNumber}`);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to void credit memo');
      triggerShortcutNotice(err?.message || 'Failed to void credit memo', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateRecurring = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.createRecurringInvoice({
        customerId: recCustomerId,
        frequency: recFreq,
        startDate: recStartDate,
        taxRate: recTaxRate || '0',
        lines: [{ description: recDesc, quantity: recQty || '1', rate: recRate || '0', taxable: true }],
      });
      triggerShortcutNotice('Recurring invoice schedule saved');
      setIsRecurringModalOpen(false);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to create recurring invoice');
    } finally {
      setBusy(false);
    }
  };

  const getStatusBadge = (inv: ApiInvoice) => {
    if (inv.status === 'voided') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          <Ban className="w-3 h-3" /> Voided
        </span>
      );
    }
    if (inv.isSalesReceipt || inv.status === 'paid' || inv.balanceDue === 0) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          <CheckCircle2 className="w-3 h-3" /> {inv.isSalesReceipt ? 'Receipt' : 'Paid'}
        </span>
      );
    }
    if (inv.status === 'partial') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <Clock className="w-3 h-3" /> Partial
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
        <Clock className="w-3 h-3" /> Open
      </span>
    );
  };
  const buildInvoiceActionContext = (inv: ApiInvoice, pendingId?: string | null): ActionEligibilityContext<ApiInvoice> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'invoices',
    entityType: inv.isSalesReceipt ? 'sales_receipt' : 'invoice',
    record: inv,
    recordStatus: inv.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const buildInvoiceActionDefinitions = (inv: ApiInvoice): AdvancedActionDefinition<ApiInvoice>[] => {
    const canReceivePayment = !inv.isSalesReceipt && inv.status !== 'voided' && inv.balanceDue > 0;
    const canSendReminder = canReceivePayment;
    const canVoid = inv.status !== 'voided' && inv.amountPaid === 0;
    const previewKind: DocumentPreviewKind = inv.isSalesReceipt ? 'sales_receipt' : 'invoice';
    return [
      {
        id: 'invoice.view',
        label: 'View & Print',
        icon: <Printer className="w-3.5 h-3.5 text-slate-600" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'invoices:read',
        execute: async () => { await handleOpenPreview(previewKind, inv.id); },
      },
      {
        id: 'invoice.receive-payment',
        label: 'Receive Payment',
        icon: <DollarSign className="w-3.5 h-3.5 text-emerald-600" />,
        group: 'process',
        groupLabel: 'Payments',
        requiredPermission: 'invoices:write',
        isVisible: () => canReceivePayment,
        isEnabled: () => canReceivePayment ? true : { enabled: false, reason: 'No open balance to receive' },
        execute: async () => { openReceivePaymentForInvoice(inv); },
      },
      {
        id: 'invoice.send-reminder',
        label: 'Send Payment Reminder',
        icon: <Mail className="w-3.5 h-3.5 text-blue-600" />,
        group: 'communication',
        groupLabel: 'Customer communication',
        requiredPermission: 'invoices:write',
        isVisible: () => canSendReminder,
        isEnabled: () => canSendReminder ? true : { enabled: false, reason: 'Invoice is not eligible for reminders' },
        execute: async () => {
          try {
            await commercialApi.sendInvoiceReminder(inv.id);
            triggerShortcutNotice(`Logged payment reminder for ${inv.invoiceNumber}`);
            await loadData();
          } catch (err: any) {
            setErrorMsg(err?.message || 'Failed to send reminder');
            throw err;
          }
        },
      },
      {
        id: 'invoice.void',
        label: 'Void Document (Reverse GL)',
        icon: <Ban className="w-3.5 h-3.5 text-rose-600" />,
        group: 'danger',
        groupLabel: 'Sensitive operations',
        destructive: true,
        risk: 'destructive',
        requiredPermission: 'invoices:write',
        isVisible: () => canVoid,
        isEnabled: () => canVoid ? true : { enabled: false, reason: 'Only unpaid, non-voided documents with no applied payments can be voided' },
        confirmation: {
          title: `Void ${inv.invoiceNumber}`,
          message: 'This will void the document and reverse its general ledger impact using the existing authorized workflow. Voiding cannot be used when applied payments/credits prevent it.',
          confirmLabel: 'Void Document',
          destructive: true,
          requireReason: false,
          reasonLabel: 'Reason (optional)',
          reasonPlaceholder: 'e.g. Posted in error',
          impactSummary: 'Financial impact: posts reversal entries and updates balances per backend rules.',
        },
        idempotency: 'recommended',
        execute: async (_ctx, helpers) => {
          try {
            await commercialApi.voidInvoice(inv.id, helpers.reason || 'Voided from Sales Ledger');
            triggerShortcutNotice(`Voided ${inv.invoiceNumber} & reversed GL entry`);
            await loadData();
            return { status: 'success' as const };
          } catch (err: any) {
            setErrorMsg(err?.message || 'Failed to void document');
            throw err;
          }
        },
      },
      {
        id: 'invoice.copy-number',
        label: 'Copy Document #',
        icon: <Copy className="w-3.5 h-3.5" />,
        group: 'admin',
        groupLabel: 'Other',
        requiredPermission: 'invoices:read',
        execute: async () => {
          await navigator.clipboard?.writeText(inv.invoiceNumber);
          triggerShortcutNotice(`Copied ${inv.invoiceNumber}`);
        },
      },
      {
        id: 'invoice.download-pdf',
        label: 'Download PDF',
        icon: <Printer className="w-3.5 h-3.5 text-slate-600" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'invoices:read',
        execute: async () => {
          try {
            const pdfData = {
              type: 'INVOICE',
              number: inv.invoiceNumber,
              date: inv.invoiceDate,
              dueDate: inv.dueDate,
              paymentTerms: inv.terms,
              clientName: inv.customerName,
              address: companyProfile.address,
              phone: companyProfile.phone,
              email: companyProfile.email,
              currency: inv.currencyCode,
              items: inv.lines.map((line: any) => ({
                desc: line.description,
                qty: line.quantity,
                price: line.rate,
                total: line.amount,
              })),
              subtotal: inv.subtotal,
              discount: 0,
              taxAmount: inv.taxAmount,
              totalAmount: inv.total,
              amountPaid: inv.amountPaid,
              balanceDue: inv.balanceDue,
              status: inv.status,
            };

            const config = {
              ...(getStoredCompanyConfig() || {}),
              companyName: companyProfile.name,
              address: companyProfile.address,
              phone: companyProfile.phone,
              email: companyProfile.email,
            };

            await downloadPrimeDocument('INVOICE', pdfData, config, `invoice-${inv.invoiceNumber}.pdf`);
            triggerShortcutNotice(`PDF downloaded for ${inv.invoiceNumber}`);
          } catch (err: any) {
            triggerShortcutNotice(`PDF download failed: ${err?.message || 'unknown error'}`, 'error');
          }
        },
      },
      {
        id: 'invoice.email',
        label: 'Email Invoice',
        icon: <Mail className="w-3.5 h-3.5 text-blue-600" />,
        group: 'communication',
        groupLabel: 'Customer communication',
        requiredPermission: 'invoices:write',
        isVisible: () => inv.status !== 'voided',
        execute: async () => {
          try {
            await commercialApi.sendInvoiceReminder(inv.id);
            triggerShortcutNotice(`Logged email delivery for ${inv.invoiceNumber}`);
            await loadData();
          } catch (err: any) {
            setErrorMsg(err?.message || 'Failed to email invoice');
            throw err;
          }
        },
      },
      {
        id: 'invoice.share',
        label: 'Share Invoice',
        icon: <Copy className="w-3.5 h-3.5 text-blue-600" />,
        group: 'communication',
        groupLabel: 'Customer communication',
        requiredPermission: 'invoices:read',
        execute: async () => {
          const link = `${window.location.origin}/invoices/${inv.id}`;
          await navigator.clipboard?.writeText(`${inv.invoiceNumber} ${link}`);
          triggerShortcutNotice(`Copied share link for ${inv.invoiceNumber}`);
        },
      },
      {
        id: 'invoice.receive-partial',
        label: 'Receive Partial Payment',
        icon: <DollarSign className="w-3.5 h-3.5 text-amber-600" />,
        group: 'process',
        groupLabel: 'Payments',
        requiredPermission: 'invoices:write',
        isVisible: () => canReceivePayment,
        isEnabled: () => (canReceivePayment ? true : { enabled: false, reason: 'No open balance to receive' }),
        execute: async () => { openReceivePaymentForInvoice(inv); },
      },
      {
        id: 'invoice.apply-deposit',
        label: 'Apply Customer Deposit',
        icon: <Wallet className="w-3.5 h-3.5 text-emerald-600" />,
        group: 'process',
        groupLabel: 'Payments & Prepayments',
        requiredPermission: 'invoices:write',
        isVisible: () => canReceivePayment,
        isEnabled: () => canReceivePayment ? true : { enabled: false, reason: 'No open balance to apply deposit' },
        execute: async () => { setDepositModalInvoice(inv); },
      },
      {
        id: 'invoice.toggle-dispute',
        label: inv.disputedAt ? 'Release Dispute / Hold' : 'Place on Dispute / Hold',
        icon: <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />,
        group: 'process',
        groupLabel: 'Disputes & Holds',
        requiredPermission: 'invoices:write',
        isVisible: () => inv.status !== 'voided' && inv.status !== 'draft',
        confirmation: inv.disputedAt
          ? {
              title: `Release hold on ${inv.invoiceNumber}`,
              message: 'This will release the dispute/hold from the invoice.',
              confirmLabel: 'Release Hold',
            }
          : {
              title: `Place ${inv.invoiceNumber} on hold`,
              message: 'This will flag the invoice as disputed/on hold. Provide a reason for the audit trail.',
              confirmLabel: 'Place Hold',
              requireReason: true,
              reasonLabel: 'Dispute reason',
              reasonPlaceholder: 'e.g. Customer queried paper quality / pricing',
            },
        execute: async (_ctx, helpers) => {
          try {
            await commercialApi.toggleInvoiceDispute(inv.id, helpers.reason, !inv.disputedAt);
            triggerShortcutNotice(`Updated dispute status for ${inv.invoiceNumber}`);
            await loadData();
          } catch (err: any) {
            setErrorMsg(err?.message || 'Failed to update dispute');
            throw err;
          }
        },
      },
      {
        id: 'invoice.write-off',
        label: 'Write-off Balance / Bad Debt',
        icon: <Scissors className="w-3.5 h-3.5 text-rose-600" />,
        group: 'danger',
        groupLabel: 'Adjustments & Write-offs',
        requiredPermission: 'invoices:writeoff',
        isVisible: () => canReceivePayment,
        isEnabled: () => canReceivePayment ? true : { enabled: false, reason: 'No open balance to write off' },
        execute: async () => { setWriteOffModalInvoice(inv); },
      },
      {
        id: 'invoice.payment-history',
        label: 'View Payment History',
        icon: <FileText className="w-3.5 h-3.5 text-slate-600" />,
        group: 'view',
        groupLabel: 'Payments',
        requiredPermission: 'invoices:read',
        execute: async () => {
          const related = payments.filter((p: any) => (p.allocations || []).some((a: any) => a.invoiceNumber === inv.invoiceNumber));
          if (related.length === 0) {
            triggerShortcutNotice(`No payments recorded for ${inv.invoiceNumber}`);
            return;
          }
          const summary = related.map((p: any) => `${p.paymentNumber}: ${formatCurrency(p.amount, currency)}`).join('\n');
          window.alert(`Payment history for ${inv.invoiceNumber}:\n${summary}`);
        },
      },
      {
        id: 'invoice.customer-statement',
        label: 'View Customer Statement',
        icon: <FileText className="w-3.5 h-3.5 text-blue-600" />,
        group: 'view',
        groupLabel: 'Customer',
        requiredPermission: 'invoices:read',
        execute: async () => { setIsStatementOpen(true); },
      },
      {
        id: 'invoice.create-credit-note',
        label: 'Create Credit Note',
        icon: <FileText className="w-3.5 h-3.5 text-amber-600" />,
        group: 'process',
        groupLabel: 'Adjustments',
        requiredPermission: 'invoices:write',
        execute: async () => {
          setCmCustomerId(inv.customerId);
          setIsCreditMemoOpen(true);
        },
      },
      {
        id: 'invoice.process-refund',
        label: 'Process Refund',
        icon: <DollarSign className="w-3.5 h-3.5 text-rose-600" />,
        group: 'danger',
        groupLabel: 'Sensitive operations',
        destructive: true,
        requiredPermission: 'invoices:write',
        confirmation: { title: `Refund ${inv.invoiceNumber}`, message: 'Process a refund via credit note / payment reversal workflow.', confirmLabel: 'Proceed', destructive: true },
        execute: async () => {
          setCmCustomerId(inv.customerId);
          setIsCreditMemoOpen(true);
          triggerShortcutNotice('Opened credit memo for refund processing');
        },
      },
      {
        id: 'invoice.record-note',
        label: 'Record Internal Note',
        icon: <FileText className="w-3.5 h-3.5 text-slate-600" />,
        group: 'admin',
        groupLabel: 'Other',
        requiredPermission: 'invoices:write',
        execute: async () => {
          const note = window.prompt(`Internal note for ${inv.invoiceNumber}:`);
          if (note === null) return;
          const trimmed = note.trim();
          if (!trimmed) return;
          try {
            await commercialApi.updateInvoiceNotes(inv.id, trimmed);
            triggerShortcutNotice(`Recorded internal note on ${inv.invoiceNumber}`);
            await loadData();
          } catch (err: any) {
            setErrorMsg(err?.message || 'Failed to record note');
            throw err;
          }
        },
      },
      {
        id: 'invoice.audit-history',
        label: 'View Audit History',
        icon: <FileText className="w-3.5 h-3.5 text-slate-600" />,
        group: 'view',
        groupLabel: 'Audit',
        requiredPermission: 'audit:read',
        execute: async () => {
          try {
            const res = await fetch(`/api/audit/logs?limit=200`, { credentials: 'include' });
            const data = await res.json();
            const logs = (data.logs || []).filter((l: any) => l.tableName === 'invoices' && l.recordId === inv.id);
            if (logs.length === 0) {
              triggerShortcutNotice(`No audit entries for ${inv.invoiceNumber}`);
              return;
            }
            const summary = logs.map((l: any) => `${l.occurredAt} ${l.action} by ${l.actorUsername || 'system'}`).join('\n');
            window.alert(`Audit history for ${inv.invoiceNumber}:\n${summary}`);
          } catch (err: any) {
            setErrorMsg(err?.message || 'Failed to load audit history');
          }
        },
      },
      {
        id: 'invoice.duplicate',
        label: 'Duplicate Invoice',
        icon: <Copy className="w-3.5 h-3.5 text-blue-600" />,
        group: 'process',
        groupLabel: 'Document',
        requiredPermission: 'invoices:write',
        confirmation: { title: `Duplicate ${inv.invoiceNumber}`, message: 'Create a new draft invoice copying all lines from this document.', confirmLabel: 'Duplicate' },
        execute: async () => {
          try {
            const lines = (inv.lines || []).map((l: any) => ({
              itemId: l.itemId,
              description: l.description,
              quantity: String(l.quantity),
              rate: String(l.rate),
              unitCost: String(l.unitCost),
              taxable: l.taxable,
            }));
            const created = await commercialApi.createInvoice({
              customerId: inv.customerId,
              invoiceDate: new Date().toISOString().slice(0, 10),
              isSalesReceipt: inv.isSalesReceipt,
              taxRate: String(inv.taxRate),
              currencyCode: inv.currencyCode,
              exchangeRate: inv.exchangeRate,
              notes: inv.notes,
              lines: lines.length ? lines : [{ description: 'Duplicated invoice', quantity: '1', rate: '0', unitCost: '0', taxable: false }],
            });
            triggerShortcutNotice(`Duplicated ${inv.invoiceNumber} -> ${created.invoiceNumber}`);
            await loadData();
          } catch (err: any) {
            setErrorMsg(err?.message || 'Failed to duplicate invoice');
            throw err;
          }
        },
      },
      {
        id: 'invoice.related-sales-order',
        label: 'View Related Sales Order',
        icon: <FileText className="w-3.5 h-3.5 text-slate-600" />,
        group: 'view',
        groupLabel: 'Related',
        requiredPermission: 'invoices:read',
        isVisible: () => false,
        execute: async () => {},
      },
      {
        id: 'invoice.related-job-order',
        label: 'View Related Job Order',
        icon: <FileText className="w-3.5 h-3.5 text-slate-600" />,
        group: 'view',
        groupLabel: 'Related',
        requiredPermission: 'invoices:read',
        execute: async () => { triggerShortcutNotice('Opening Examination module for related job orders'); },
      },
    ];
  };

  const buildEstimateActionContext = (est: any, pendingId?: string | null): ActionEligibilityContext<any> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'invoices',
    entityType: 'estimate',
    record: est,
    recordStatus: est.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const buildEstimateActionDefinitions = (est: any): AdvancedActionDefinition<any>[] => {
    const canDecide = est.status === 'pending' || est.status === 'submitted' || est.status === 'draft';
    const isPending = est.status === 'pending';
    const canConvert = est.status !== 'invoiced';
    return [
      {
        id: 'estimate.view',
        label: 'Preview & Print Estimate',
        icon: <Printer className="w-3.5 h-3.5 text-slate-600" />,
        group: 'view',
        groupLabel: 'Document',
        requiredPermission: 'estimates:read',
        execute: async () => { await handleOpenPreview('estimate', est.id); },
      },
      {
        id: 'estimate.approve',
        label: 'Approve Estimate',
        icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />,
        group: 'process',
        groupLabel: 'Estimate actions',
        requiredPermission: 'estimates:write',
        isVisible: () => canDecide,
        isEnabled: () => (isPending ? true : { enabled: false, reason: 'Only pending estimates can be approved' }),
        execute: async () => {
          try {
            await commercialApi.approveEstimate(est.id);
            triggerShortcutNotice(`Approved Estimate ${est.estimateNumber}`);
            await loadData();
          } catch (err: any) { setErrorMsg(err?.message); throw err; }
        },
      },
      {
        id: 'estimate.reject',
        label: 'Reject Estimate',
        icon: <X className="w-3.5 h-3.5 text-rose-600" />,
        group: 'danger',
        groupLabel: 'Sensitive operations',
        destructive: true,
        requiredPermission: 'estimates:write',
        isVisible: () => canDecide,
        isEnabled: () => (isPending ? true : { enabled: false, reason: 'Only pending estimates can be rejected' }),
        confirmation: {
          title: `Reject ${est.estimateNumber}`,
          message: 'Reject this estimate using the existing workflow.',
          confirmLabel: 'Reject Estimate',
          destructive: true,
        },
        execute: async (_ctx, helpers) => {
          try {
            await commercialApi.rejectEstimate(est.id, helpers.reason || 'Rejected from sales workspace');
            triggerShortcutNotice(`Rejected Estimate ${est.estimateNumber}`);
            await loadData();
          } catch (err: any) { setErrorMsg(err?.message); throw err; }
        },
      },
      {
        id: 'estimate.convert',
        label: est.status === 'invoiced' ? 'Already Invoiced' : 'Convert to Invoice',
        icon: <ArrowRight className="w-3.5 h-3.5 text-blue-600" />,
        group: 'process',
        groupLabel: 'Estimate actions',
        requiredPermission: 'invoices:write',
        isEnabled: () => (canConvert ? true : { enabled: false, reason: 'Estimate is already invoiced' }),
        confirmation: {
          title: `Convert ${est.estimateNumber}`,
          message: 'Convert this estimate to an invoice using the existing authorized workflow. If approval is required, the backend will return approval-required status.',
          confirmLabel: 'Convert to Invoice',
        },
        idempotency: 'recommended',
        execute: async () => {
          try {
            const res = await commercialApi.convertEstimate(est.id);
            if (res?.approvalRequired) {
              triggerShortcutNotice('Estimate conversion requires approval before invoicing', 'warning');
              await loadData();
              return { status: 'approval_required' as const, message: res?.message || 'Approval required' };
            }
            triggerShortcutNotice(`Converted ${est.estimateNumber} -> ${res.invoice?.invoiceNumber || 'invoice'}`);
            await loadData();
            if (res.invoice?.id) {
              await handleOpenPreview('invoice', res.invoice.id);
            }
            return { status: 'success' as const };
          } catch (err: any) { setErrorMsg(err?.message); throw err; }
        },
      },
    ];
  };

  const renderInvoiceActions = (inv: ApiInvoice) => {
    const defs = buildInvoiceActionDefinitions(inv);
    const ctx = buildInvoiceActionContext(inv, pendingActionId === `invoice:${inv.id}` ? pendingActionId : null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <TransactionActionMenu<ApiInvoice>
        label={`Actions for ${inv.invoiceNumber}`}
        actions={resolved}
        pendingActionId={pendingActionId}
        executionContext={buildInvoiceActionContext(inv, pendingActionId)}
        idempotencyRecordKey={inv.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => {
          const actionKey = `invoice:${inv.id}:${action.definition.id}`;
          setPendingActionId(actionKey);
          try {
            const freshCtx = buildInvoiceActionContext(inv, null);
            const freshEval = resolveActions([action.definition], freshCtx)[0];
            if (!freshEval || !isActionExecutable(freshEval)) {
              throw new Error(freshEval?.evaluation?.reason || 'Action is no longer available');
            }
            const def = freshEval.definition;
            // confirmation handled by menu internal path only when execute is provided via internal flow;
            // we execute here with fresh check and rely on definition.execute side effects/confirmations encoded? 
            // our defs include confirmation metadata but execute directly; handle confirmation via prompt-like not needed except void handled in execute? 
            // AdvancedActionsMenu shows confirmation only when using internal executor without onExecuteAction. Since we supply onExecuteAction, we must honor confirmation ourselves.
            let reason: string | undefined;
            const confirmation = freshEval.evaluation.confirmation || (typeof def.confirmation === 'function' ? def.confirmation(freshCtx, def) : def.confirmation);
            if (confirmation) {
              const defaultReason = confirmation.requireReason ? '' : '';
              const msg = `${confirmation.message}${confirmation.impactSummary ? '\n\n' + confirmation.impactSummary : ''}${confirmation.requireReason ? '\n\nReason required.' : (confirmation.reasonLabel ? '\n\nOptional reason:' : '')}`;
              if (confirmation.requireReason || confirmation.destructive) {
                const input = window.prompt(msg, defaultReason);
                if (input === null) return; // cancelled
                reason = (input || '').trim();
                if (confirmation.requireReason && !reason) throw new Error('A reason is required to continue');
              } else {
                const ok = window.confirm(msg);
                if (!ok) return;
              }
            }
            if (typeof def.execute === 'function') {
              await def.execute(freshCtx, { notify: (m, t) => triggerShortcutNotice(m, t), reason });
            }
          } catch (err: any) {
            setErrorMsg(err?.message || 'Action failed');
            triggerShortcutNotice(err?.message || 'Action failed', 'error');
          } finally {
            setPendingActionId(null);
          }
        }}
      />
    );
  };

  const renderEstimateActions = (est: any) => {
    const defs = buildEstimateActionDefinitions(est);
    const ctx = buildEstimateActionContext(est, pendingActionId === `estimate:${est.id}` ? pendingActionId : null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for ${est.estimateNumber}`}
        actions={resolved}
        pendingActionId={pendingActionId}
        executionContext={buildEstimateActionContext(est, pendingActionId)}
        idempotencyRecordKey={est.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => {
          const actionKey = `estimate:${est.id}:${action.definition.id}`;
          setPendingActionId(actionKey);
          try {
            const freshCtx = buildEstimateActionContext(est, null);
            const freshEval = resolveActions([action.definition], freshCtx)[0];
            if (!freshEval || !isActionExecutable(freshEval)) {
              throw new Error(freshEval?.evaluation?.reason || 'Action is no longer available');
            }
            const def = freshEval.definition;
            let reason: string | undefined;
            const confirmation = freshEval.evaluation.confirmation || (typeof def.confirmation === 'function' ? def.confirmation(freshCtx, def) : def.confirmation);
            if (confirmation) {
              const msg = `${confirmation.message}${confirmation.impactSummary ? '\n\n' + confirmation.impactSummary : ''}`;
              if (confirmation.requireReason || confirmation.destructive) {
                const input = window.prompt(msg, '');
                if (input === null) return;
                reason = (input || '').trim();
                if (confirmation.requireReason && !reason) throw new Error('A reason is required to continue');
              } else {
                const ok = window.confirm(msg);
                if (!ok) return;
              }
            }
            if (typeof def.execute === 'function') {
              await def.execute(freshCtx, { notify: (m, t) => triggerShortcutNotice(m, t), reason });
            }
          } catch (err: any) {
            setErrorMsg(err?.message || 'Action failed');
            triggerShortcutNotice(err?.message || 'Action failed', 'error');
          } finally {
            setPendingActionId(null);
          }
        }}
      />
    );
  };

  return (
    <div
      className="min-h-full bg-[#FEFDFB] px-5 py-10 text-[#23282A] dark:bg-[#070b14] dark:text-slate-100"
      style={{ fontFamily: "'Inter', 'Plus Jakarta Sans', sans-serif" }}
    >
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6">
        {!hubOpen && (
        <div className="relative mx-auto mb-2 flex w-full flex-col items-center pt-3.5 text-center">
          <div className="absolute left-1/2 top-0 h-1 w-[120px] -translate-x-1/2 rounded-full bg-gradient-to-r from-[#0f766e] via-[#3fa294] to-[#f59e0b]" />
          <h1
            className="mb-2 bg-gradient-to-br from-[#0f544c] to-[#3fa294] bg-clip-text text-[28px] font-normal tracking-[0.2px] text-transparent sm:text-[36px] dark:from-[#8be0d3] dark:to-[#3fa294]"
            style={{ fontFamily: "'DM Serif Display', Georgia, serif" }}
          >
            Sales Flow{' '}
            <span className="bg-gradient-to-br from-[#0f544c] to-[#2eb12e] bg-clip-text text-transparent dark:from-[#8be0d3] dark:to-[#2eb12e]">
              Command
            </span>
          </h1>
          <p className="mx-auto max-w-[520px] text-[13.5px] font-medium leading-relaxed text-[#5c6567] dark:text-slate-400">
            Sales, invoices &amp; receivables — live A/R ledger for receipts, payments, credits, estimates, recurring schedules and reminders.
          </p>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {canWriteEst && (
              <button
                onClick={() => openModalFor('estimate')}
                className="flex items-center gap-1.5 rounded-lg border border-[#e4ddd1] bg-white/80 px-3.5 py-2 text-xs font-semibold text-[#0f544c] transition-colors hover:border-[#3fa294] hover:bg-white dark:border-white/10 dark:bg-slate-900/60 dark:text-[#8be0d3] dark:hover:bg-slate-900"
              >
                <FileText className="h-3.5 w-3.5" />
                <span>New Quote</span>
              </button>
            )}
            {canWrite && (
              <>
                <button
                  onClick={() => openModalFor('sales_receipt')}
                  className="flex items-center gap-1.5 rounded-lg border border-[#1f8577]/35 bg-[#1f8577]/[0.06] px-3.5 py-2 text-xs font-semibold text-[#0f544c] transition-colors hover:border-[#1f8577] hover:bg-[#1f8577]/10 dark:border-[#3fa294]/40 dark:bg-[#1f8577]/10 dark:text-[#8be0d3]"
                >
                  <CreditCard className="h-3.5 w-3.5" />
                  <span>Sales Receipt</span>
                </button>
                <button
                  onClick={() => openReceivePaymentForInvoice()}
                  className="flex items-center gap-1.5 rounded-lg border border-[#e4ddd1] bg-white/80 px-3.5 py-2 text-xs font-semibold text-[#0f544c] transition-colors hover:border-[#3fa294] hover:bg-white dark:border-white/10 dark:bg-slate-900/60 dark:text-[#8be0d3] dark:hover:bg-slate-900"
                >
                  <DollarSign className="h-3.5 w-3.5 text-[#1f8577] dark:text-[#5ec2b3]" />
                  <span>Receive Payment</span>
                </button>
                <button
                  onClick={() => openModalFor('invoice')}
                  className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#1f8577] to-[#0f544c] px-4 py-2 text-xs font-bold text-white shadow-[0_4px_10px_-3px_rgba(31,133,119,0.5)] transition-transform hover:-translate-y-px"
                >
                  <Plus className="h-4 w-4" />
                  <span>New Invoice</span>
                </button>
              </>
            )}
          </div>
        </div>
        )}

      {!hubOpen && aging?.totals && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Outstanding', value: aging.totals.total, tone: 'text-slate-900 dark:text-white' },
            { label: 'Current', value: aging.totals.current, tone: 'text-emerald-600 dark:text-emerald-400' },
            { label: '1–30 days', value: aging.totals.days1To30, tone: 'text-amber-600 dark:text-amber-400' },
            { label: '31–60 days', value: aging.totals.days31To60, tone: 'text-orange-600 dark:text-orange-400' },
            { label: '61–90 days', value: aging.totals.days61To90, tone: 'text-rose-600 dark:text-rose-400' },
            { label: '90+ days', value: aging.totals.daysOver90, tone: 'text-rose-700 dark:text-rose-300' },
          ].map(k => (
            <div key={k.label} className="rounded-xl border border-[#e4ddd1] bg-white/80 p-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-slate-900/60">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[#5c6567] dark:text-slate-400">{k.label}</div>
              <div className={`font-mono text-sm font-bold ${k.tone}`}>{formatCurrency(Number(k.value) || 0, currency)}</div>
            </div>
          ))}
        </div>
      )}

      {errorMsg && (
        <div role="alert" className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 text-xs flex items-center justify-between">
          <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="text-xs underline">Dismiss</button>
        </div>
      )}

      {!hubOpen ? (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(220px, 100%), 1fr))' }}
        >
          {salesFlowCards.map(card => {
            const Icon = card.icon;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => {
                  setActiveTab(card.id);
                  setHubOpen(true);
                }}
                className="group relative flex w-full flex-col items-center justify-center gap-3.5 rounded-[14px] border border-[#e4ddd1] bg-[#FEFDFB] px-5 py-6 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-[#3fa294] hover:shadow-[0_4px_12px_rgba(31,133,119,0.1)] dark:border-white/10 dark:bg-slate-900/60"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#1f8577] to-[#0f544c] shadow-[0_4px_10px_-3px_rgba(31,133,119,0.4)]">
                  <Icon className="h-[22px] w-[22px] text-white" />
                </span>
                <span className="flex flex-col gap-1.5">
                  <span className="flex items-center justify-center gap-2">
                    <span className="m-0 text-base font-bold tracking-[0.01em] text-[#0f544c] dark:text-[#8be0d3]">
                      {card.label}
                    </span>
                    <span
                      className={`min-w-5 rounded-full px-2 py-[1px] text-center text-[10px] font-extrabold leading-[18px] ${
                        card.count > 0
                          ? 'bg-[#dc2626] text-white'
                          : 'bg-[#e4ddd1] text-[#5c6567] dark:bg-white/10 dark:text-slate-400'
                      }`}
                    >
                      {card.count}
                    </span>
                  </span>
                  <span className="m-0 text-[11px] leading-relaxed text-[#5c6567] dark:text-slate-400">
                    {card.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setHubOpen(false)}
              className="flex items-center gap-1.5 rounded-lg border border-[#e4ddd1] bg-white/80 px-3.5 py-2 text-xs font-semibold text-[#0f544c] transition-colors hover:border-[#3fa294] hover:bg-white dark:border-white/10 dark:bg-slate-900/60 dark:text-[#8be0d3] dark:hover:bg-slate-900"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Sales Flow</span>
            </button>
            <span className="text-sm font-bold text-[#0f544c] dark:text-[#8be0d3]">
              {salesFlowCards.find(card => card.id === activeTab)?.label}
            </span>
          </div>

          {loading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading commercial sales ledger...
            </div>
          ) : (
            <>
              {activeTab === 'invoices' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {(['all', 'open', 'paid', 'receipts', 'voided'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setInvoiceFilter(f)}
                      className={`px-3 py-1 rounded-md border text-[11px] font-semibold capitalize ${
                        invoiceFilter === f
                          ? 'bg-[#1f8577] text-white border-[#1f8577]'
                          : 'bg-white dark:bg-slate-900 border-[#e4ddd1] dark:border-white/10 text-[#5c6567] dark:text-slate-300'
                      }`}
                    >
                      {f === 'receipts' ? 'Sales Receipts' : f}
                    </button>
                  ))}
                </div>
                <div className="relative w-full sm:w-72">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[#5c6567]/60 dark:text-slate-500" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search #, customer, memo..."
                    className="w-full rounded-lg border border-[#e4ddd1] bg-[#FEFDFB] py-1.5 pl-9 pr-3 text-xs text-[#23282A] outline-none transition-colors focus:border-[#3fa294] focus:ring-2 focus:ring-[#3fa294]/20 dark:border-white/10 dark:bg-slate-950 dark:text-slate-100"
                  />
                </div>
              </div>

              <InvoicesTable
                rows={pagedInvoices}
                colSpan={9}
                emptyMessage="No invoices or sales receipts match the current filter."
                selectedId={selectedInvoiceId}
                notify={(m, t) => triggerShortcutNotice(m, t)}
                onRowClick={(inv) => {
                  setSelectedInvoiceId(inv.id);
                  setDetailInvoice(inv);
                }}
                onRowContextMenu={(inv, pt) => {
                  setSelectedInvoiceId(inv.id);
                  setRowContextMenu({ x: pt.x, y: pt.y, type: 'invoice', record: inv });
                }}
                renderHeader={() => (
                  <>
                    <th className="px-4 py-3">
                      <button onClick={() => toggleSort('invoiceNumber')} className="inline-flex items-center gap-1">
                        <span>DOC #</span> <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th className="px-4 py-3">CUSTOMER</th>
                    <th className="px-4 py-3">
                      <button onClick={() => toggleSort('date')} className="inline-flex items-center gap-1">
                        <span>DATE</span> <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th className="px-4 py-3">
                      <button onClick={() => toggleSort('dueDate')} className="inline-flex items-center gap-1">
                        <span>DUE DATE</span> <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-right">
                      <button onClick={() => toggleSort('total')} className="inline-flex items-center gap-1 ml-auto">
                        <span>TOTAL</span> <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </th>
                    <th className="px-4 py-3 text-right">COST</th>
                    <th className="px-4 py-3 text-right">GROSS PROFIT</th>
                    <th className="px-4 py-3 text-right">BALANCE DUE</th>
                    <th className="px-4 py-3 text-center">STATUS</th>
                    <th className="px-4 py-3 text-right">ACTIONS</th>
                  </>
                )}
                renderCells={(inv) => {
                  const cellPad = tableDensity === 'compact' ? 'px-4 py-2' : 'px-4 py-3';
                  const margin = inv.subtotal > 0 ? (inv.grossProfit / inv.subtotal) * 100 : 0;
                  return (
                    <>
                      <td className={`${cellPad} font-bold text-[#1f8577] dark:text-[#5ec2b3] whitespace-nowrap`}>
                        {inv.invoiceNumber}
                        {inv.currencyCode && inv.currencyCode !== baseCurrency && (
                          <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                            {inv.currencyCode}
                          </span>
                        )}
                      </td>
                      <td className={`${cellPad} font-sans font-semibold text-slate-900 dark:text-white`}>
                        {inv.customerName}
                      </td>
                      <td className={`${cellPad} text-slate-500 whitespace-nowrap`}>{inv.invoiceDate}</td>
                      <td className={`${cellPad} text-slate-500 whitespace-nowrap`}>{inv.dueDate}</td>
                      <td className={`${cellPad} text-right font-bold text-slate-900 dark:text-white tabular-nums`}>
                        {formatCurrency(inv.total, currency)}
                      </td>
                      <td className={`${cellPad} text-right text-slate-500 tabular-nums`}>
                        {formatCurrency(inv.totalCost, currency)}
                      </td>
                      <td className={`${cellPad} text-right font-bold tabular-nums`}>
                        <span className={inv.grossProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                          {formatCurrency(inv.grossProfit, currency)}
                        </span>
                        <div className="text-[10px] font-normal text-slate-400">{margin.toFixed(1)}%</div>
                      </td>
                      <td className={`${cellPad} text-right font-bold text-[#1f8577] dark:text-[#5ec2b3] tabular-nums`}>
                        {formatCurrency(inv.balanceDue, currency)}
                      </td>
                      <td className={`${cellPad} text-center font-sans`}>{getStatusBadge(inv)}</td>
                      <td className={`${cellPad} text-right font-sans`}>{renderInvoiceActions(inv)}</td>
                    </>
                  );
                }}
                footer={
                  <Pagination
                    page={page}
                    pageSize={pageSize}
                    total={filteredInvoices.length}
                    onPageChange={setPage}
                    onPageSizeChange={size => {
                      setPageSize(size);
                      setPage(1);
                    }}
                    label="documents"
                  />
                }
              />
            </div>
          )}
          {activeTab === 'payments' && (
            <div className="space-y-2">
              {canWrite && (
                <div className="flex justify-end">
                  <button
                    onClick={() => openReceivePaymentForInvoice()}
                    className="px-3 py-1.5 rounded-lg bg-[#1f8577] hover:bg-[#177065] text-white text-xs font-bold flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Record Payment
                  </button>
                </div>
              )}
              <CustomerPaymentsTable
                payments={payments}
                currency={currency}
                authenticated={authenticated}
                permissions={permissions}
                role={activeCompany?.role || null}
                companyId={activeCompany?.id ?? null}
                canWrite={canWrite}
                onPreview={(id) => handleOpenPreview('payment_receipt', id)}
                onOpenCustomer={() => setCurrentView('customers')}
                reload={loadData}
                notify={(m, t) => triggerShortcutNotice(m, t)}
              />
            </div>
          )}

          {activeTab === 'creditMemos' && (
            <div className="overflow-hidden rounded-xl border border-[#e4ddd1] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-slate-900/70">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-900 dark:text-white">Customer Credit Memos</span>
                {canWrite && (
                  <button
                    onClick={() => setIsCreditMemoOpen(true)}
                    className="px-3 py-1.5 rounded-lg bg-[#1f8577] hover:bg-[#177065] text-white text-xs font-bold flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Issue Credit Memo
                  </button>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase text-[10px] font-bold border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2.5">CREDIT #</th>
                      <th className="px-4 py-2.5">CUSTOMER</th>
                      <th className="px-4 py-2.5">DATE</th>
                      <th className="px-4 py-2.5 text-right">TOTAL CREDIT</th>
                      <th className="px-4 py-2.5 text-right">REMAINING</th>
                      <th className="px-4 py-2.5 text-center">STATUS</th>
                      <th className="px-4 py-2.5 text-right">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                    {creditMemos.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-8 text-center font-sans text-slate-400">No credit memos issued.</td></tr>
                    ) : (
                      creditMemos.map(cm => (
                        <tr key={cm.id}>
                          <td className="px-4 py-2.5 font-bold text-[#1f8577] dark:text-[#5ec2b3]">{cm.creditNumber}</td>
                          <td className="px-4 py-2.5 font-sans font-semibold">{cm.customerName}</td>
                          <td className="px-4 py-2.5 text-slate-500">{cm.creditDate}</td>
                          <td className="px-4 py-2.5 text-right font-bold tabular-nums">{formatCurrency(cm.total, currency)}</td>
                          <td className="px-4 py-2.5 text-right font-bold tabular-nums text-emerald-600">{formatCurrency(cm.remainingCredit, currency)}</td>
                          <td className="px-4 py-2.5 text-center font-sans uppercase text-[10px] font-bold">{cm.status}</td>
                          <td className="px-4 py-2.5 text-right font-sans">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                onClick={() => handleOpenPreview('credit_memo', cm.id)}
                                className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-semibold inline-flex items-center gap-1"
                              >
                                <Printer className="w-3 h-3" /> Preview
                              </button>
                              {canWrite && cm.status === 'open' && cm.remainingCredit > 0 && (
                                <button
                                  onClick={() => {
                                    const custOpen = invoices.filter(i => i.customerId === cm.customerId && i.status !== 'voided' && i.balanceDue > 0);
                                    setApplyCmTarget(cm);
                                    setApplyCmInvoiceId(custOpen[0]?.id || 0);
                                    setApplyCmAmount(String(Math.min(cm.remainingCredit, custOpen[0]?.balanceDue || cm.remainingCredit)));
                                  }}
                                  className="px-2.5 py-1 rounded bg-[#1f8577] text-white text-[11px] font-semibold"
                                >
                                  Apply to Invoice
                                </button>
                              )}
                              {canWrite && cm.status !== 'voided' && (
                                <button
                                  onClick={() => void handleVoidCreditMemo(cm)}
                                  className="px-2 py-1 rounded border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-[11px] font-semibold inline-flex items-center gap-1"
                                >
                                  <Ban className="w-3 h-3" /> Void
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'estimates' && (
            <div className="space-y-3">
              {!costDetailsIncluded && (
                <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-xs flex items-center gap-2">
                  <Lock className="w-4 h-4" />
                  <span>Production cost & estimated margin columns are redacted for your current role permissions.</span>
                </div>
              )}
              <div className="overflow-hidden rounded-xl border border-[#e4ddd1] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-slate-900/70">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase text-[10px] font-bold border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="px-4 py-3">ESTIMATE #</th>
                        <th className="px-4 py-3">CUSTOMER</th>
                        <th className="px-4 py-3">DATE</th>
                        <th className="px-4 py-3">EXPIRY</th>
                        <th className="px-4 py-3 text-right">TOTAL</th>
                        {costDetailsIncluded && <th className="px-4 py-3 text-right">EST. COST</th>}
                        {costDetailsIncluded && <th className="px-4 py-3 text-right">EST. PROFIT</th>}
                        <th className="px-4 py-3 text-center">STATUS</th>
                        <th className="px-4 py-3 text-right">ACTIONS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                      {estimates.map(est => (
                        <tr
                          key={est.id}
                          onClick={() => setSelectedEstimateId(est.id)}
                          onContextMenu={(e) => { e.preventDefault(); setSelectedEstimateId(est.id); setRowContextMenu({ x: e.clientX, y: e.clientY, type: 'estimate', record: est }); }}
                          className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-850/50 ${selectedEstimateId === est.id ? 'bg-blue-50/70 dark:bg-blue-900/20 ring-1 ring-inset ring-blue-200 dark:ring-blue-800' : ''}`}
                        >
                          <td className="px-4 py-3 font-bold text-[#1f8577] dark:text-[#5ec2b3]">{est.estimateNumber}</td>
                          <td className="px-4 py-3 font-sans font-semibold">{est.customerName}</td>
                          <td className="px-4 py-3 text-slate-500">{est.estimateDate}</td>
                          <td className="px-4 py-3 text-slate-500">{est.expiryDate}</td>
                          <td className="px-4 py-3 text-right font-bold tabular-nums">{formatCurrency(Number(est.totalNum ?? est.total), currency)}</td>
                          {costDetailsIncluded && (
                            <td className="px-4 py-3 text-right text-slate-500 tabular-nums">
                              {formatCurrency(Number(est.totalCostNum ?? est.totalCost ?? 0), currency)}
                            </td>
                          )}
                          {costDetailsIncluded && (
                            <td className="px-4 py-3 text-right font-bold text-emerald-600 tabular-nums">
                              {formatCurrency(Number(est.estimatedProfitNum ?? est.estimatedProfit ?? 0), currency)}
                            </td>
                          )}
                          <td className="px-4 py-3 text-center font-sans">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 uppercase">
                              {est.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-sans">
                            {renderEstimateActions(est)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'recurring' && (
            <div className="overflow-hidden rounded-xl border border-[#e4ddd1] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-slate-900/70">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <Repeat className="w-4 h-4 text-[#1f8577] dark:text-[#5ec2b3]" /> Recurring Invoice Schedules
                </span>
                {canWrite && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        try {
                          const res = await commercialApi.runDueRecurringInvoices();
                          triggerShortcutNotice(`Generated ${res.generatedCount} due recurring invoice(s)`);
                          await loadData();
                        } catch (err: any) {
                          setErrorMsg(err?.message);
                        }
                      }}
                      className="px-3 py-1.5 rounded-lg bg-[#1f8577] hover:bg-[#177065] text-white text-xs font-bold flex items-center gap-1"
                    >
                      <Play className="w-3.5 h-3.5" /> Run Due Schedules Now
                    </button>
                    <button
                      onClick={() => setIsRecurringModalOpen(true)}
                      className="px-3 py-1.5 rounded-lg bg-[#1f8577] hover:bg-[#177065] text-white text-xs font-bold flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" /> New Schedule
                    </button>
                  </div>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase text-[10px] font-bold border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2.5">CUSTOMER</th>
                      <th className="px-4 py-2.5">FREQUENCY</th>
                      <th className="px-4 py-2.5">NEXT DUE DATE</th>
                      <th className="px-4 py-2.5">LAST GENERATED</th>
                      <th className="px-4 py-2.5 text-right">GENERATED</th>
                      <th className="px-4 py-2.5">STATUS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                    {recurringList.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-8 text-center font-sans text-slate-400">No recurring invoice schedules configured.</td></tr>
                    ) : (
                      recurringList.map(r => (
                        <tr key={r.id}>
                          <td className="px-4 py-2.5 font-sans font-semibold">{r.customerName}</td>
                          <td className="px-4 py-2.5 capitalize">{r.frequency}</td>
                          <td className="px-4 py-2.5 text-[#1f8577] font-bold dark:text-[#5ec2b3]">{r.nextDue}</td>
                          <td className="px-4 py-2.5 text-slate-500">{r.lastGeneratedDate || '—'}</td>
                          <td className="px-4 py-2.5 text-right">{r.generatedCount}</td>
                          <td className="px-4 py-2.5 font-sans">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${r.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>
                              {r.isActive ? 'Active' : 'Completed'}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'collections' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="overflow-hidden rounded-xl border border-[#e4ddd1] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-slate-900/70">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 font-bold text-xs">
                  Collections & Payment Reminders Dispatched
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {comms.remindersSent.length === 0 ? (
                    <div className="p-6 text-center text-slate-400">No invoice reminders sent yet. Use Row Actions on any Open Invoice.</div>
                  ) : (
                    comms.remindersSent.map(rem => (
                      <div key={rem.id} className="p-3 flex items-center justify-between">
                        <div>
                          <div className="font-bold text-slate-900 dark:text-white">{rem.invoiceNumber} · {rem.customerName}</div>
                          <div className="text-[11px] text-slate-500">To: {rem.recipient} · Sent {new Date(rem.sentAt).toLocaleString()}</div>
                        </div>
                        <div className="text-right font-mono">
                          <div className="font-bold text-[#1f8577] dark:text-[#5ec2b3]">{formatCurrency(rem.balanceDue, currency)}</div>
                          <span className="text-[10px] uppercase text-emerald-600 font-bold">{rem.status}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-[#e4ddd1] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-slate-900/70">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 font-bold text-xs">
                  Outbound Communications Audit Log
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {comms.emailLog.length === 0 ? (
                    <div className="p-6 text-center text-slate-400">No communications logged yet.</div>
                  ) : (
                    comms.emailLog.map(em => (
                      <div key={em.id} className="p-3 flex items-center justify-between gap-3">
                        <div>
                          <div className="font-semibold text-slate-900 dark:text-white">{em.subject}</div>
                          <div className="text-[11px] text-slate-500">
                            {em.recipient} · {new Date(em.sentAt).toLocaleString()}
                            {Number(em.attempts || 0) > 0 ? ` · ${em.attempts} attempt(s)` : ''}
                          </div>
                          {em.lastError && (
                            <div className="text-[11px] text-rose-600 dark:text-rose-400">{em.lastError}</div>
                          )}
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            em.status === 'sent'
                              ? 'bg-emerald-100 text-emerald-800'
                              : em.status === 'failed'
                              ? 'bg-rose-100 text-rose-800'
                              : em.status === 'skipped'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {em.status}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
            </>
          )}
        </>
      )}

        <div className="mt-2 flex items-center justify-center gap-3.5 pb-2">
          <div className="h-px w-10 bg-[#e4ddd1] dark:bg-white/10" />
          <span className="text-[9px] font-extrabold uppercase tracking-[0.3px] text-[#5c6567] dark:text-slate-400">
            Operational Neural Link
          </span>
          <div className="h-px w-10 bg-[#e4ddd1] dark:bg-white/10" />
        </div>
      </div>

      {isDocModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[92vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">
                {docMode === 'estimate' ? 'New Customer Estimate / Quote' : docMode === 'sales_receipt' ? 'New Point-of-Sale Receipt' : 'New Customer Invoice'}
              </span>
              <button onClick={() => setIsDocModalOpen(false)} className="p-1 text-white/80 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmitDoc} className="p-5 space-y-4 overflow-y-auto text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="font-semibold text-slate-600 dark:text-slate-300 block mb-1">Customer *</label>
                  <select
                    value={docCustomerId}
                    onChange={e => setDocCustomerId(Number(e.target.value))}
                    className="w-full border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-2 bg-white dark:bg-slate-950"
                    required
                  >
                    {customers.map(c => (
                      <option key={c.id} value={c.id}>{c.companyName}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="font-semibold text-slate-600 dark:text-slate-300 block mb-1">Date</label>
                  <input type="date" value={docDate} onChange={e => setDocDate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" required />
                </div>
                <div>
                  <label className="font-semibold text-slate-600 dark:text-slate-300 block mb-1">Tax Rate (%)</label>
                  <input type="number" step="0.01" value={docTaxRate} onChange={e => setDocTaxRate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                </div>
              </div>

              {docMode !== 'estimate' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="font-semibold text-slate-600 dark:text-slate-300 block mb-1">Currency</label>
                    <select
                      value={docCurrency}
                      onChange={e => {
                        setDocCurrency(e.target.value);
                        if (e.target.value === baseCurrency) setDocExchangeRate('1');
                        else {
                          const known = fxRateFor(e.target.value);
                          if (known) setDocExchangeRate(String(known));
                        }
                      }}
                      className="w-full border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-2 bg-white dark:bg-slate-950"
                    >
                      {fxOptions.map(o => (
                        <option key={o.code} value={o.code}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  {docCurrency !== baseCurrency && (
                    <div>
                      <label className="font-semibold text-slate-600 dark:text-slate-300 block mb-1">FX Rate (to {baseCurrency})</label>
                      <input type="number" step="0.0001" value={docExchangeRate} onChange={e => setDocExchangeRate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                    </div>
                  )}
                  {docMode === 'sales_receipt' && (
                    <div>
                      <label className="font-semibold text-slate-600 dark:text-slate-300 block mb-1">Deposit To Account</label>
                      <select value={docDepositAcctId} onChange={e => setDocDepositAcctId(Number(e.target.value))} className="w-full border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-2 bg-white dark:bg-slate-950">
                        {bankAccounts.map(b => (
                          <option key={b.id} value={b.id}>{b.code} - {b.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between font-bold text-slate-700 dark:text-slate-300">
                  <span>Line Items (Raw materials excluded from invoicing)</span>
                  <button type="button" onClick={() => setDocLines(prev => [...prev, { itemId: '', description: '', quantity: '1', rate: '0', unitCost: '0', taxable: true }])} className="text-blue-600 hover:underline flex items-center gap-1">
                    <Plus className="w-3.5 h-3.5" /> Add Line
                  </button>
                </div>
                {docLines.map((line, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center p-2 rounded bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800">
                    <div className="col-span-3">
                      <select value={line.itemId} onChange={e => handleSelectItemOnLine(idx, e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-950">
                        <option value="">Custom / Freeform</option>
                        {invoiceableItems.map(it => (
                          <option key={it.id} value={it.id}>{it.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-4">
                      <input type="text" placeholder="Description" value={line.description} onChange={e => setDocLines(prev => prev.map((x, i) => (i === idx ? { ...x, description: e.target.value } : x)))} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-950" required />
                    </div>
                    <div className="col-span-2">
                      <input type="number" step="0.01" placeholder="Qty" value={line.quantity} onChange={e => setDocLines(prev => prev.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)))} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-950 font-mono text-right" />
                    </div>
                    <div className="col-span-2">
                      <input type="number" step="0.01" placeholder="Rate" value={line.rate} onChange={e => setDocLines(prev => prev.map((x, i) => (i === idx ? { ...x, rate: e.target.value } : x)))} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-950 font-mono text-right" />
                    </div>
                    <div className="col-span-1 text-center">
                      <input type="checkbox" checked={line.taxable} title="Taxable" onChange={e => setDocLines(prev => prev.map((x, i) => (i === idx ? { ...x, taxable: e.target.checked } : x)))} />
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <label className="font-semibold text-slate-600 dark:text-slate-300 block mb-1">Memo / Notes</label>
                <input type="text" value={docNotes} onChange={e => setDocNotes(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded-md px-2.5 py-2 bg-white dark:bg-slate-950" />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button type="button" onClick={() => setIsDocModalOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700">Cancel</button>
                <button type="submit" disabled={busy} className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold">{busy ? 'Posting...' : docMode === 'estimate' ? 'Save Quote' : 'Post to General Ledger'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isPaymentModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Receive Customer Payment</span>
              <button onClick={() => setIsPaymentModalOpen(false)} className="p-1 text-white/80 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmitPayment} className="p-5 space-y-4 overflow-y-auto text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Customer</label>
                  <select value={pmtCustomerId} onChange={e => { setPmtCustomerId(Number(e.target.value)); setPmtAllocations({}); }} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    {customers.map(c => (<option key={c.id} value={c.id}>{c.companyName}</option>))}
                  </select>
                </div>
                <div>
                  <label className="font-semibold block mb-1">Payment Date</label>
                  <input type="date" value={pmtDate} onChange={e => setPmtDate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Method</label>
                  <select value={pmtMethod} onChange={e => setPmtMethod(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    <option value="ACH / Wire">ACH / Wire</option>
                    <option value="Check">Check</option>
                    <option value="Cash">Cash</option>
                    <option value="Mobile Money">Mobile Money</option>
                    <option value="Credit Card">Credit Card</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Deposit To</label>
                  <select value={pmtDepositAcctId} onChange={e => setPmtDepositAcctId(Number(e.target.value))} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    {bankAccounts.map(b => (<option key={b.id} value={b.id}>{b.code} - {b.name}</option>))}
                  </select>
                </div>
                <div>
                  <label className="font-semibold block mb-1">Currency</label>
                  <select value={pmtCurrency} onChange={e => setPmtCurrency(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    {fxOptions.map(o => (<option key={o.code} value={o.code}>{o.code}</option>))}
                  </select>
                </div>
                {pmtCurrency !== baseCurrency && (
                  <div>
                    <label className="font-semibold block mb-1">FX Rate</label>
                    <input type="number" step="0.0001" value={pmtExchangeRate} onChange={e => setPmtExchangeRate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                  </div>
                )}
                <div>
                  <label className="font-semibold block mb-1">Total Payment ({pmtCurrency})</label>
                  <input type="number" step="0.01" value={pmtAmount} onChange={e => setPmtAmount(e.target.value)} placeholder="Auto or override" className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono font-bold" />
                </div>
              </div>
              <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 font-bold text-[11px] uppercase">Open Customer Invoices</div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-48 overflow-y-auto">
                  {openInvoicesForPmtCust.length === 0 ? (
                    <div className="p-4 text-center text-slate-400">No open invoices for this customer (amount posts as unapplied credit).</div>
                  ) : (
                    openInvoicesForPmtCust.map(inv => (
                      <div key={inv.id} className="p-2.5 flex items-center justify-between gap-3">
                        <div>
                          <div className="font-mono font-bold text-blue-600">{inv.invoiceNumber}</div>
                          <div className="text-[11px] text-slate-500">Due {inv.dueDate} · Balance: {formatCurrency(inv.balanceDue, currency)}</div>
                        </div>
                        <input type="number" step="0.01" value={pmtAllocations[inv.id] || ''} placeholder="0.00" onChange={e => setPmtAllocations(prev => ({ ...prev, [inv.id]: e.target.value }))} className="w-32 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-right font-mono bg-white dark:bg-slate-950" />
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button type="button" onClick={() => setIsPaymentModalOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700">Cancel</button>
                <button type="submit" disabled={busy} className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold">{busy ? 'Posting...' : 'Record Payment'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isCreditMemoOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Issue Credit Memo</span>
              <button onClick={() => setIsCreditMemoOpen(false)} className="p-1 text-white/80 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleCreateCreditMemo} className="p-5 space-y-3 text-xs">
              <div>
                <label className="font-semibold block mb-1">Customer</label>
                <select value={cmCustomerId} onChange={e => setCmCustomerId(Number(e.target.value))} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                  {customers.map(c => <option key={c.id} value={c.id}>{c.companyName}</option>)}
                </select>
              </div>
              <div>
                <label className="font-semibold block mb-1">Reason / Line Description</label>
                <input type="text" value={cmDescription} onChange={e => setCmDescription(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950" required />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div><label className="font-semibold block mb-1">Qty</label><input type="number" value={cmQuantity} onChange={e => setCmQuantity(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2 py-2 bg-white dark:bg-slate-950 font-mono" /></div>
                <div><label className="font-semibold block mb-1">Unit Credit</label><input type="number" step="0.01" value={cmRate} onChange={e => setCmRate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2 py-2 bg-white dark:bg-slate-950 font-mono" /></div>
                <div><label className="font-semibold block mb-1">Tax %</label><input type="number" step="0.01" value={cmTaxRate} onChange={e => setCmTaxRate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2 py-2 bg-white dark:bg-slate-950 font-mono" /></div>
              </div>
              <div>
                <label className="font-semibold block mb-1">Memo</label>
                <input type="text" value={cmMemo} onChange={e => setCmMemo(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950" />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button type="button" onClick={() => setIsCreditMemoOpen(false)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy} className="px-4 py-2 rounded bg-blue-600 text-white font-bold">Issue Credit Memo</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {applyCmTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Apply {applyCmTarget.creditNumber}</span>
              <button onClick={() => setApplyCmTarget(null)} className="p-1 text-white/80 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleApplyCreditMemo} className="p-5 space-y-3 text-xs">
              <div>
                <label className="font-semibold block mb-1">Target Open Invoice</label>
                <select value={applyCmInvoiceId} onChange={e => setApplyCmInvoiceId(Number(e.target.value))} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950" required>
                  <option value={0}>Select invoice...</option>
                  {invoices.filter(i => i.customerId === applyCmTarget.customerId && i.status !== 'voided' && i.balanceDue > 0).map(i => (
                    <option key={i.id} value={i.id}>{i.invoiceNumber} (Due: {formatCurrency(i.balanceDue, currency)})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="font-semibold block mb-1">Amount to Apply</label>
                <input type="number" step="0.01" value={applyCmAmount} onChange={e => setApplyCmAmount(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" required />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button type="button" onClick={() => setApplyCmTarget(null)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy || !applyCmInvoiceId} className="px-4 py-2 rounded bg-blue-600 text-white font-bold">Apply Credit</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isRecurringModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-300 dark:border-slate-800 overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">New Recurring Invoice Schedule</span>
              <button onClick={() => setIsRecurringModalOpen(false)} className="p-1 text-white/80 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleCreateRecurring} className="p-5 space-y-3 text-xs">
              <div>
                <label className="font-semibold block mb-1">Customer</label>
                <select value={recCustomerId} onChange={e => setRecCustomerId(Number(e.target.value))} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                  {customers.map(c => <option key={c.id} value={c.id}>{c.companyName}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="font-semibold block mb-1">Frequency</label>
                  <select value={recFreq} onChange={e => setRecFreq(e.target.value as any)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="annual">Annual</option>
                  </select>
                </div>
                <div>
                  <label className="font-semibold block mb-1">Start / Next Due Date</label>
                  <input type="date" value={recStartDate} onChange={e => setRecStartDate(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                </div>
              </div>
              <div>
                <label className="font-semibold block mb-1">Line Description</label>
                <input type="text" value={recDesc} onChange={e => setRecDesc(e.target.value)} className="w-full border border-slate-300 dark:border-slate-700 rounded px-2.5 py-2 bg-white dark:bg-slate-950" required />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div><label className="font-semibold block mb-1">Qty</label><input type="number" value={recQty} onChange={e => setRecQty(e.target.value)} className="w-full border rounded px-2 py-2 bg-white dark:bg-slate-950 font-mono" /></div>
                <div><label className="font-semibold block mb-1">Rate</label><input type="number" step="0.01" value={recRate} onChange={e => setRecRate(e.target.value)} className="w-full border rounded px-2 py-2 bg-white dark:bg-slate-950 font-mono" /></div>
                <div><label className="font-semibold block mb-1">Tax %</label><input type="number" step="0.01" value={recTaxRate} onChange={e => setRecTaxRate(e.target.value)} className="w-full border rounded px-2 py-2 bg-white dark:bg-slate-950 font-mono" /></div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button type="button" onClick={() => setIsRecurringModalOpen(false)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy} className="px-4 py-2 rounded bg-blue-600 text-white font-bold">Save Schedule</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {depositModalInvoice && (
        <ApplyCustomerDepositModal
          invoice={depositModalInvoice}
          isOpen={true}
          onClose={() => setDepositModalInvoice(null)}
          onSuccess={loadData}
        />
      )}
      {writeOffModalInvoice && (
        <WriteOffBalanceModal
          invoice={writeOffModalInvoice}
          isOpen={true}
          onClose={() => setWriteOffModalInvoice(null)}
          onSuccess={loadData}
        />
      )}

      <TransactionDetailDrawer
        open={Boolean(detailInvoice)}
        onClose={() => setDetailInvoice(null)}
        title={detailInvoice ? `Invoice ${detailInvoice.invoiceNumber}` : 'Invoice'}
        number={detailInvoice?.invoiceDate}
        typeLabel={detailInvoice?.isSalesReceipt ? 'Sales Receipt' : 'Invoice'}
        statusBadge={
          detailInvoice ? (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                detailInvoice.status === 'voided'
                  ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                  : detailInvoice.status === 'paid'
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                    : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
              }`}
            >
              {detailInvoice.status}
            </span>
          ) : null
        }
        sections={detailInvoice ? buildInvoiceSections(detailInvoice, currency, payments) : []}
        actions={detailInvoice ? renderInvoiceActions(detailInvoice) : null}
        audit={
          <p className="text-[11px] text-slate-500">
            Record-scoped audit requires a backend enhancement (see Phase 3A.1); no client-side filtering of the
            company-wide log is performed.
          </p>
        }
      />

      {rowContextMenu && (() => {
        if (rowContextMenu.type === 'invoice') {
          const inv = rowContextMenu.record as ApiInvoice;
          const defs = buildInvoiceActionDefinitions(inv);
          const ctx = buildInvoiceActionContext(inv, pendingActionId);
          const resolved = resolveActions(defs, ctx);
          return resolved.length > 0 ? (
            <TransactionContextMenu<ApiInvoice>
              label={`Actions for ${inv.invoiceNumber}`}
              actions={resolved}
              executionContext={ctx}
              idempotencyRecordKey={inv.id}
              notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
              point={{ x: rowContextMenu.x, y: rowContextMenu.y }}
              onClose={() => setRowContextMenu(null)}
              onExecuteAction={async (action) => {
                const actionKey = `invoice:${inv.id}:${action.definition.id}`;
                setPendingActionId(actionKey);
                try {
                  const freshCtx = buildInvoiceActionContext(inv, null);
                  const freshEval = resolveActions([action.definition], freshCtx)[0];
                  if (!freshEval || !isActionExecutable(freshEval)) throw new Error(freshEval?.evaluation?.reason || 'Action is no longer available');
                  const def = freshEval.definition;
                  let reason: string | undefined;
                  const confirmation = freshEval.evaluation.confirmation || (typeof def.confirmation === 'function' ? def.confirmation(freshCtx, def) : def.confirmation);
                  if (confirmation) {
                    const defaultReason = confirmation.requireReason ? '' : '';
                    const msg = `${confirmation.message}${confirmation.impactSummary ? '\n\n' + confirmation.impactSummary : ''}${confirmation.requireReason ? '\n\nReason required.' : (confirmation.reasonLabel ? '\n\nOptional reason:' : '')}`;
                    if (confirmation.requireReason || confirmation.destructive) {
                      const input = window.prompt(msg, defaultReason);
                      if (input === null) return;
                      reason = (input || '').trim();
                      if (confirmation.requireReason && !reason) throw new Error('A reason is required to continue');
                    } else {
                      const ok = window.confirm(msg);
                      if (!ok) return;
                    }
                  }
                  if (typeof def.execute === 'function') await def.execute(freshCtx, { notify: (m, t) => triggerShortcutNotice(m, t), reason });
                } catch (err: any) {
                  setErrorMsg(err?.message || 'Action failed');
                  triggerShortcutNotice(err?.message || 'Action failed', 'error');
                } finally {
                  setPendingActionId(null);
                }
              }}
            />
          ) : null;
        }
        const est = rowContextMenu.record;
        const defs = buildEstimateActionDefinitions(est);
        const ctx = buildEstimateActionContext(est, pendingActionId);
        const resolved = resolveActions(defs, ctx);
        return resolved.length > 0 ? (
          <AdvancedActionsMenu<any>
            label={`Actions for ${est.estimateNumber}`}
            actions={resolved}
            pendingActionId={pendingActionId}
            executionContext={ctx}
            idempotencyRecordKey={est.id}
            notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
            hideTrigger
            contextPoint={{ x: rowContextMenu.x, y: rowContextMenu.y }}
            onContextClose={() => setRowContextMenu(null)}
            onExecuteAction={async (action) => {
              const actionKey = `estimate:${est.id}:${action.definition.id}`;
              setPendingActionId(actionKey);
              try {
                const freshCtx = buildEstimateActionContext(est, null);
                const freshEval = resolveActions([action.definition], freshCtx)[0];
                if (!freshEval || !isActionExecutable(freshEval)) throw new Error(freshEval?.evaluation?.reason || 'Action is no longer available');
                const def = freshEval.definition;
                let reason: string | undefined;
                const confirmation = freshEval.evaluation.confirmation || (typeof def.confirmation === 'function' ? def.confirmation(freshCtx, def) : def.confirmation);
                if (confirmation) {
                  const defaultReason = confirmation.requireReason ? '' : '';
                  const msg = `${confirmation.message}${confirmation.impactSummary ? '\n\n' + confirmation.impactSummary : ''}${confirmation.requireReason ? '\n\nReason required.' : (confirmation.reasonLabel ? '\n\nOptional reason:' : '')}`;
                  if (confirmation.requireReason || confirmation.destructive) {
                    const input = window.prompt(msg, defaultReason);
                    if (input === null) return;
                    reason = (input || '').trim();
                    if (confirmation.requireReason && !reason) throw new Error('A reason is required to continue');
                  } else {
                    const ok = window.confirm(msg);
                    if (!ok) return;
                  }
                }
                if (typeof def.execute === 'function') await def.execute(freshCtx, { notify: (m, t) => triggerShortcutNotice(m, t), reason });
              } catch (err: any) {
                setErrorMsg(err?.message || 'Action failed');
                triggerShortcutNotice(err?.message || 'Action failed', 'error');
              } finally {
                setPendingActionId(null);
              }
            }}
          />
        ) : null;
      })()}

    </div>
  );
};
