import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import {
  ACCOUNTING_UPDATED_EVENT,
  accountingApi,
  ApiAccount,
  ApiAccountType,
  ApiDetailType,
  ApiFiscalPeriod,
  ApiGeneralLedgerReport,
  ApiJournalEntry,
} from '../../services/accountingApi';
import { formatCurrency } from '../../utils/currency';
import {
  Button,
  FormField,
  InlineAlert,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  PageHeader,
  PageShell,
  StatusBadge,
  Tabs,
} from '../common/ui';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions } from '../../actions/evaluateActions';
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
  TransactionBulkActionToolbar,
  TransactionAuditTimeline,
  useTransactionAudit,
  createTransactionRef,
  type DetailSection,
} from '../../transaction-interaction';
import {
  Plus,
  Search,
  Scale,
  Eye,
  Copy,
  RefreshCw,
  RotateCcw,
  Lock,
  Unlock,
  CheckCircle2,
  AlertTriangle,
  Pencil,
  Calendar,
  BookOpen,
  Layers,
} from 'lucide-react';

type CoaTab = 'accounts' | 'journals' | 'opening' | 'periods';

const ACCOUNT_TYPE_OPTIONS: Array<{ value: ApiAccountType; label: string; defaultDetail: ApiDetailType }> = [
  { value: 'Bank', label: 'Bank', defaultDetail: 'bank' },
  { value: 'AccountsReceivable', label: 'Accounts Receivable', defaultDetail: 'accounts_receivable' },
  { value: 'OtherCurrentAsset', label: 'Other Current Asset', defaultDetail: 'other_current_asset' },
  { value: 'Inventory', label: 'Inventory Asset', defaultDetail: 'other_current_asset' },
  { value: 'FixedAsset', label: 'Fixed Asset', defaultDetail: 'fixed_asset' },
  { value: 'AccountsPayable', label: 'Accounts Payable', defaultDetail: 'accounts_payable' },
  { value: 'CreditCard', label: 'Credit Card', defaultDetail: 'credit_card' },
  { value: 'OtherCurrentLiability', label: 'Other Current Liability', defaultDetail: 'other_current_liability' },
  { value: 'PayrollLiability', label: 'Payroll Liability', defaultDetail: 'payroll_liabilities' },
  { value: 'LongTermLiability', label: 'Long-Term Liability', defaultDetail: 'long_term_liability' },
  { value: 'Equity', label: 'Equity', defaultDetail: 'equity' },
  { value: 'Income', label: 'Income / Revenue', defaultDetail: 'income' },
  { value: 'CostOfGoodsSold', label: 'Cost of Goods Sold', defaultDetail: 'cost_of_goods_sold' },
  { value: 'Expense', label: 'Operating Expense', defaultDetail: 'expense' },
  { value: 'OtherExpense', label: 'Other Non-Operating Expense', defaultDetail: 'other_expense' },
];

const DETAIL_OPTIONS_BY_TYPE: Record<ApiAccountType, Array<{ value: ApiDetailType; label: string }>> = {
  Bank: [{ value: 'bank', label: 'Bank' }],
  AccountsReceivable: [{ value: 'accounts_receivable', label: 'Accounts Receivable' }],
  OtherCurrentAsset: [
    { value: 'other_current_asset', label: 'Other Current Asset' },
    { value: 'other_asset', label: 'Other Asset' },
  ],
  Inventory: [{ value: 'other_current_asset', label: 'Inventory / Current Asset' }],
  FixedAsset: [
    { value: 'fixed_asset', label: 'Fixed Asset' },
    { value: 'other_asset', label: 'Other Asset' },
  ],
  AccountsPayable: [{ value: 'accounts_payable', label: 'Accounts Payable' }],
  CreditCard: [{ value: 'credit_card', label: 'Credit Card' }],
  OtherCurrentLiability: [{ value: 'other_current_liability', label: 'Other Current Liability' }],
  PayrollLiability: [{ value: 'payroll_liabilities', label: 'Payroll Liabilities' }],
  LongTermLiability: [{ value: 'long_term_liability', label: 'Long-Term Liability' }],
  Equity: [{ value: 'equity', label: 'Equity' }],
  Income: [
    { value: 'income', label: 'Operating Income' },
    { value: 'other_income', label: 'Other Income' },
  ],
  CostOfGoodsSold: [{ value: 'cost_of_goods_sold', label: 'Cost of Goods Sold' }],
  Expense: [
    { value: 'expense', label: 'Operating Expense' },
    { value: 'other_expense', label: 'Other Expense' },
  ],
  OtherExpense: [{ value: 'other_expense', label: 'Other Non-Operating Expense' }],
};

const BALANCE_SHEET_TYPE_SET = new Set<ApiAccountType>([
  'Bank',
  'AccountsReceivable',
  'OtherCurrentAsset',
  'Inventory',
  'FixedAsset',
  'AccountsPayable',
  'CreditCard',
  'OtherCurrentLiability',
  'PayrollLiability',
  'LongTermLiability',
  'Equity',
]);

const DEBIT_NORMAL_TYPE_SET = new Set<ApiAccountType>([
  'Bank',
  'AccountsReceivable',
  'OtherCurrentAsset',
  'Inventory',
  'FixedAsset',
  'CostOfGoodsSold',
  'Expense',
  'OtherExpense',
]);

interface JournalLedgerTableProps {
  journals: ApiJournalEntry[];
  currency: string;
  authenticated: boolean;
  permissions: string[];
  role: string | null;
  companyId: number | null;
  canWriteJournals: boolean;
  isPeriodRestricted: (txnDate: string) => boolean;
  onOpenAccount: (accountId: number) => void;
  onReverse: (entry: ApiJournalEntry) => void;
  notify: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
}

const journalRef = (entry: ApiJournalEntry) =>
  createTransactionRef(entry, {
    moduleKey: 'accounting',
    entityType: 'journal',
    id: (e) => e.id,
    number: (e) => e.entryNumber,
    status: (e) => e.status,
  });

const canReverseJournal = (entry: ApiJournalEntry, canWrite: boolean): boolean =>
  canWrite &&
  entry.status === 'posted' &&
  entry.sourceType !== 'reversal' &&
  entry.reversesTransactionId === null &&
  entry.reversedByTransactionId === null;

function buildJournalSections(
  entry: ApiJournalEntry,
  currency: string,
  related: ApiJournalEntry[],
  onOpenRelated: (entry: ApiJournalEntry) => void,
  onOpenAccount: (accountId: number) => void
): DetailSection[] {
  const totalDebit = entry.lines.reduce((s, l) => s + l.debitNum, 0);
  const totalCredit = entry.lines.reduce((s, l) => s + l.creditNum, 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.005;
  const relatedReversal = entry.reversedByTransactionId
    ? related.find((e) => e.id === entry.reversedByTransactionId)
    : undefined;
  const relatedOriginal = entry.reversesTransactionId
    ? related.find((e) => e.id === entry.reversesTransactionId)
    : undefined;

  return [
    {
      key: 'journal',
      title: 'Journal',
      fields: [
        { label: 'Reference', value: entry.reference || '—', mono: true },
        { label: 'Transaction date', value: entry.txnDate, mono: true },
        { label: 'Source', value: entry.sourceType },
        { label: 'Adjusting', value: entry.isAdjusting ? 'Yes' : 'No' },
        { label: 'Posted by', value: entry.postedByUsername || '—' },
        { label: 'Posted at', value: entry.postedAt || '—' },
      ],
    },
    {
      key: 'description',
      title: 'Description',
      content: (
        <p className="text-xs text-slate-700 dark:text-slate-200">
          {entry.description || '—'}
        </p>
      ),
    },
    {
      key: 'lines',
      title: 'Debit / Credit lines',
      content: (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="py-1.5 pr-2">Account</th>
                <th className="py-1.5 px-2 text-right">Debit</th>
                <th className="py-1.5 px-2 text-right">Credit</th>
                <th className="py-1.5 pl-2">Basis</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {entry.lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-1.5 pr-2 font-sans">
                    <button
                      type="button"
                      onClick={() => onOpenAccount(l.accountId)}
                      className="text-left hover:underline text-slate-800 dark:text-slate-200"
                    >
                      {l.accountCode ? `${l.accountCode} ` : ''}
                      {l.accountName}
                    </button>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-blue-600 dark:text-blue-400">
                    {l.debitNum > 0 ? formatCurrency(l.debitNum, currency) : ''}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                    {l.creditNum > 0 ? formatCurrency(l.creditNum, currency) : ''}
                  </td>
                  <td className="py-1.5 pl-2 text-slate-500">{l.basis}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="font-bold border-t border-slate-200 dark:border-slate-700">
              <tr>
                <td className="py-1.5 pr-2">Totals</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{formatCurrency(totalDebit, currency)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{formatCurrency(totalCredit, currency)}</td>
                <td className="py-1.5 pl-2">
                  <span className={balanced ? 'text-emerald-600' : 'text-rose-600'}>
                    {balanced ? 'Balanced' : 'Out of balance'}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ),
    },
    {
      key: 'related',
      title: 'Related transactions',
      content:
        relatedReversal || relatedOriginal ? (
          <div className="flex flex-wrap gap-2 text-[11px]">
            {relatedOriginal && (
              <button
                type="button"
                onClick={() => onOpenRelated(relatedOriginal)}
                className="rounded border border-slate-300 dark:border-slate-700 px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Reverses {relatedOriginal.entryNumber}
              </button>
            )}
            {relatedReversal && (
              <button
                type="button"
                onClick={() => onOpenRelated(relatedReversal)}
                className="rounded border border-slate-300 dark:border-slate-700 px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Reversed by {relatedReversal.entryNumber}
              </button>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-slate-400">No related transactions.</p>
        ),
    },
  ];
}

function JournalLedgerInner({
  journals,
  currency,
  authenticated,
  permissions,
  role,
  companyId,
  canWriteJournals,
  isPeriodRestricted,
  onOpenAccount,
  onReverse,
  notify,
}: JournalLedgerTableProps) {
  const selection = useTransactionSelection();
  const [detail, setDetail] = useState<ApiJournalEntry | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    point: { x: number; y: number };
    entry: ApiJournalEntry;
    resolved: ResolvedAdvancedAction<ApiJournalEntry>[];
    ctx: ActionEligibilityContext<ApiJournalEntry>;
  } | null>(null);

  useEffect(() => {
    selection.setOrderedIds(journals.map((j) => j.id));
  }, [journals, selection]);

  const ctxFor = useCallback(
    (entry: ApiJournalEntry): ActionEligibilityContext<ApiJournalEntry> => ({
      authenticated,
      permissions,
      role,
      companyId,
      moduleKey: 'accounting',
      entityType: 'journal',
      record: entry,
      recordStatus: entry.status,
      financialPeriodRestricted: isPeriodRestricted(entry.txnDate),
    }),
    [authenticated, permissions, role, companyId, isPeriodRestricted]
  );

  const buildActions = useCallback(
    (entry: ApiJournalEntry): AdvancedActionDefinition<ApiJournalEntry>[] => {
      const defs: AdvancedActionDefinition<ApiJournalEntry>[] = [
        {
          id: 'view',
          label: 'View Details',
          icon: <Eye className="w-3.5 h-3.5" />,
          group: 'view',
          groupLabel: 'Journal',
          requiredPermission: 'journals:read',
          execute: async () => setDetail(entry),
        },
      ];
      if (canReverseJournal(entry, canWriteJournals) && !isPeriodRestricted(entry.txnDate)) {
        defs.push({
          id: 'reverse',
          label: 'Reverse (Void) Entry',
          icon: <RotateCcw className="w-3.5 h-3.5 text-rose-600" />,
          group: 'danger',
          groupLabel: 'Sensitive operations',
          destructive: true,
          risk: 'destructive',
          requiredPermission: 'journals:write',
          confirmation: {
            title: `Reverse ${entry.entryNumber}`,
            message: 'Reverse this journal entry using a compensating entry?',
            confirmLabel: 'Reverse',
            destructive: true,
          },
          execute: async () => onReverse(entry),
        });
      }
      defs.push({
        id: 'copy-entry',
        label: 'Copy Entry #',
        icon: <Copy className="w-3.5 h-3.5" />,
        group: 'admin',
        groupLabel: 'Other',
        requiredPermission: 'journals:read',
        execute: async () => {
          await navigator.clipboard?.writeText(entry.entryNumber);
          notify(`Copied ${entry.entryNumber}`);
        },
      });
      if (entry.reversedByTransactionId) {
        defs.push({
          id: 'view-reversal',
          label: 'View Reversal',
          icon: <RotateCcw className="w-3.5 h-3.5" />,
          group: 'view',
          groupLabel: 'Journal',
          requiredPermission: 'journals:read',
          execute: async () => {
            const rev = journals.find((j) => j.id === entry.reversedByTransactionId);
            if (rev) setDetail(rev);
            else notify('Reversal entry not found in the loaded range', 'warning');
          },
        });
      }
      defs.push({
        id: 'audit',
        label: 'View Audit History',
        icon: <BookOpen className="w-3.5 h-3.5" />,
        group: 'investigate',
        groupLabel: 'Investigation',
        requiredPermission: 'audit:read',
        execute: async () => setDetail(entry),
      });
      if (entry.lines[0]) {
        defs.push({
          id: 'open-account',
          label: 'Open Ledger Account',
          icon: <Layers className="w-3.5 h-3.5" />,
          group: 'navigation',
          groupLabel: 'Navigation',
          requiredPermission: 'accounts:read',
          execute: async () => onOpenAccount(entry.lines[0].accountId),
        });
      }
      return defs;
    },
    [canWriteJournals, isPeriodRestricted, journals, notify, onOpenAccount, onReverse]
  );

  const executeFrom = useCallback(
    (ctx: ActionEligibilityContext<ApiJournalEntry>) =>
      async (action: ResolvedAdvancedAction<ApiJournalEntry>) => {
        const def = action.definition;
        if (typeof def.execute === 'function') {
          await def.execute(ctx, { notify });
        }
      },
    [notify]
  );

  const detailRef = useMemo(() => (detail ? journalRef(detail) : null), [detail]);
  const audit = useTransactionAudit(undefined, detailRef, Boolean(detail));
  const allSelected = journals.length > 0 && journals.every((j) => selection.isSelected(j.id));
  const canReadAudit = permissions.includes('audit:read');

  const bulkReverse: AdvancedActionDefinition<ApiJournalEntry> = {
    id: 'bulk-reverse',
    label: 'Reverse eligible',
    icon: <RotateCcw className="w-3.5 h-3.5" />,
    group: 'process',
    requiredPermission: 'journals:write',
    applicableStatuses: ['posted'],
    destructive: true,
    risk: 'destructive',
    confirmation: {
      title: 'Reverse eligible journals',
      message: 'Reverse every selected posted journal using compensating entries?',
      confirmLabel: 'Reverse',
      destructive: true,
      requireReason: true,
      reasonLabel: 'Reversal reason',
    },
    execute: async (ctx, helpers) => {
      const entry = ctx.record as ApiJournalEntry;
      await accountingApi.reverseJournal(entry.id, {
        reason: helpers.reason,
        idempotencyKey: helpers.idempotencyKey,
      });
      return { status: 'success', message: `Reversed ${entry.entryNumber}` };
    },
  };

  const selectedEntries = journals.filter((j) => selection.isSelected(j.id));

  return (
    <>
      {selectedEntries.length > 0 && (
        <TransactionBulkActionToolbar
          definitions={[bulkReverse]}
          records={selectedEntries}
          getRef={journalRef}
          buildContext={ctxFor}
          notify={notify}
        />
      )}

      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2.5 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all journals"
                    checked={allSelected}
                    onChange={() => (allSelected ? selection.clear() : selection.selectAll(journals.map((j) => j.id)))}
                  />
                </th>
                <th className="px-4 py-2.5">ENTRY #</th>
                <th className="px-4 py-2.5">DATE</th>
                <th className="px-4 py-2.5">SOURCE / DESCRIPTION</th>
                <th className="px-4 py-2.5">SPLIT LINES</th>
                <th className="px-4 py-2.5 text-right">AMOUNT</th>
                <th className="px-4 py-2.5 text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {journals.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No journal transactions posted yet.
                  </td>
                </tr>
              ) : (
                journals.map((je) => {
                  const ctx = ctxFor(je);
                  const resolved = resolveActions(buildActions(je), ctx);
                  const isSelected = selection.isSelected(je.id);
                  return (
                    <tr
                      key={je.id}
                      onClick={() => setDetail(je)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ point: { x: e.clientX, y: e.clientY }, entry: je, resolved, ctx });
                      }}
                      className={`cursor-pointer transition-colors ${
                        je.status === 'voided' ? 'bg-slate-50/70 dark:bg-slate-850/40 opacity-75' : ''
                      } ${isSelected ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-850/50'}`}
                    >
                      <td className="px-3 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${je.entryNumber}`}
                          checked={isSelected}
                          onChange={(e) => selection.toggle(je.id, { shiftKey: (e.nativeEvent as MouseEvent).shiftKey })}
                        />
                      </td>
                      <td className="px-4 py-3 font-mono font-bold text-slate-900 dark:text-white align-top whitespace-nowrap">
                        <div>{je.entryNumber}</div>
                        <div className="text-[10px] font-normal text-slate-500">
                          {je.status.toUpperCase()}
                          {je.isAdjusting ? ' · ADJ' : ''}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-600 dark:text-slate-300 align-top whitespace-nowrap">
                        <div>{je.txnDate}</div>
                        {je.reference && <div className="text-[10px] text-slate-400">Ref: {je.reference}</div>}
                      </td>
                      <td className="px-4 py-3 align-top max-w-xs">
                        <div className="font-semibold text-slate-900 dark:text-white">{je.description || '—'}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          Source: {je.sourceType}
                          {je.postedByUsername ? ` · Posted by ${je.postedByUsername}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="space-y-1 font-mono text-[11px]">
                          {je.lines.map((l) => (
                            <div key={l.id} className="flex items-center justify-between gap-4">
                              <span className="font-sans text-slate-700 dark:text-slate-300">
                                {l.accountCode ? `${l.accountCode} ` : ''}
                                {l.accountName}
                              </span>
                              <span className="tabular-nums shrink-0">
                                {l.debitNum > 0 ? (
                                  <span className="text-blue-600 dark:text-blue-400">Dr {formatCurrency(l.debitNum, currency)}</span>
                                ) : (
                                  <span className="text-emerald-600 dark:text-emerald-400">Cr {formatCurrency(l.creditNum, currency)}</span>
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-bold align-top whitespace-nowrap">
                        {formatCurrency(Number(je.totalDebits), currency)}
                      </td>
                      <td className="px-4 py-3 text-right align-top" onClick={(e) => e.stopPropagation()}>
                        {resolved.length > 0 && (
                          <TransactionActionMenu
                            label={`Actions for ${je.entryNumber}`}
                            actions={resolved}
                            executionContext={ctx}
                            idempotencyRecordKey={je.id}
                            notify={notify}
                            onExecuteAction={executeFrom(ctx)}
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
        title={detail ? `Journal ${detail.entryNumber}` : 'Journal'}
        number={detail?.txnDate}
        typeLabel={detail?.sourceType}
        statusBadge={
          detail ? (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                detail.status === 'posted'
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                  : detail.status === 'voided'
                    ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                    : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
              }`}
            >
              {detail.status}
            </span>
          ) : null
        }
        sections={detail ? buildJournalSections(detail, currency, journals, setDetail, onOpenAccount) : []}
        actions={
          detail
            ? (() => {
                const ctx = ctxFor(detail);
                const resolved = resolveActions(buildActions(detail), ctx);
                return resolved.length > 0 ? (
                  <TransactionActionMenu
                    label={`Actions for ${detail.entryNumber}`}
                    actions={resolved}
                    executionContext={ctx}
                    idempotencyRecordKey={detail.id}
                    notify={notify}
                    onExecuteAction={executeFrom(ctx)}
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
          label={`Actions for ${contextMenu.entry.entryNumber}`}
          executionContext={contextMenu.ctx}
          idempotencyRecordKey={contextMenu.entry.id}
          notify={notify}
          onExecuteAction={executeFrom(contextMenu.ctx)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

export const JournalLedgerTable: React.FC<JournalLedgerTableProps> = (props) => (
  <TransactionSelectionProvider>
    <JournalLedgerInner {...props} />
  </TransactionSelectionProvider>
);

export const ChartOfAccountsView: React.FC = () => {
  const { companyProfile, setIsJournalEntryOpen, triggerShortcutNotice } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const currency = companyProfile.currency || 'K';

  const canWriteAccounts = hasPermission('accounts:write');
  const canRebuild = hasPermission('accounts:rebuild');
  const canReadJournals = hasPermission('journals:read');
  const canWriteJournals = hasPermission('journals:write');
  const canClosePeriods = hasPermission('periods:close');
  const canReopenPeriods = hasPermission('periods:reopen');

  const [activeTab, setActiveTab] = useState<CoaTab>('accounts');
  const [accounts, setAccounts] = useState<ApiAccount[]>([]);
  const [journals, setJournals] = useState<ApiJournalEntry[]>([]);
  const [periods, setPeriods] = useState<ApiFiscalPeriod[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [accountRegister, setAccountRegister] = useState<ApiGeneralLedgerReport['accounts'][0] | null>(null);

  const [loading, setLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [showInactive, setShowInactive] = useState(false);

  // Add / Edit Account modal state
  const [accountModalMode, setAccountModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingAccount, setEditingAccount] = useState<ApiAccount | null>(null);
  const [acctCode, setAcctCode] = useState('');
  const [acctName, setAcctName] = useState('');
  const [acctType, setAcctType] = useState<ApiAccountType>('Expense');
  const [acctDetailType, setAcctDetailType] = useState<ApiDetailType>('expense');
  const [acctParentId, setAcctParentId] = useState<string>('');
  const [acctDesc, setAcctDesc] = useState('');
  const [acctSaving, setAcctSaving] = useState(false);

  // Reversal dialog state
  const [reversingEntry, setReversingEntry] =
  useState<ApiJournalEntry | null>(null);
  const [viewingJournal, setViewingJournal] = useState<ApiJournalEntry | null>(null);
  const [reversalDate, setReversalDate] = useState('');
  const [reversalReason, setReversalReason] = useState('');
  const [reversalSubmitting, setReversalSubmitting] = useState(false);

  // Opening balances wizard state
  const [obDate, setObDate] = useState('2026-01-01');
  const [obDesc, setObDesc] = useState('Opening Balances');
  const [obAmounts, setObAmounts] = useState<Record<number, string>>({});
  const [obAutoEquityId, setObAutoEquityId] = useState<string>('');
  const [obSubmitting, setObSubmitting] = useState(false);

  // Fiscal periods state
  const [newPeriodName, setNewPeriodName] = useState('');
  const [newPeriodStart, setNewPeriodStart] = useState('2026-10-01');
  const [newPeriodEnd, setNewPeriodEnd] = useState('2026-10-31');
  const [closingTargetPeriod, setClosingTargetPeriod] = useState<ApiFiscalPeriod | null>(null);
  const [generateClosingEntry, setGenerateClosingEntry] = useState(true);
  const [closingNotes, setClosingNotes] = useState('');
  const [reopenTargetPeriod, setReopenTargetPeriod] = useState<ApiFiscalPeriod | null>(null);
  const [reopenReason, setReopenReason] = useState('');

  const loadWorkspaceData = useCallback(async () => {
    setLoading(true);
    setErrorBanner(null);
    try {
      const [acctList, periodList, journalList] = await Promise.all([
        accountingApi.listAccounts(showInactive),
        accountingApi.listPeriods().catch(() => [] as ApiFiscalPeriod[]),
        canReadJournals ? accountingApi.listJournals({ limit: 150 }) : Promise.resolve([] as ApiJournalEntry[]),
      ]);
      setAccounts(acctList);
      setPeriods(periodList);
      setJournals(journalList);
      setSelectedAccountId(prev => {
        if (prev && acctList.some(a => a.id === prev)) return prev;
        return acctList[0]?.id ?? null;
      });
      setObAutoEquityId(prev => {
        if (prev && acctList.some(a => String(a.id) === prev && a.account_type === 'Equity')) return prev;
        const eq = acctList.find(a => a.code === '3900') || acctList.find(a => a.account_type === 'Equity');
        return eq ? String(eq.id) : '';
      });
    } catch (err: any) {
      setErrorBanner(err?.message || 'Unable to load accounting data');
    } finally {
      setLoading(false);
    }
  }, [showInactive, canReadJournals, activeCompany?.id]);

  useEffect(() => {
    loadWorkspaceData();
  }, [loadWorkspaceData]);

  useEffect(() => {
    const handler = () => loadWorkspaceData();
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, [loadWorkspaceData]);

  // Load GL Register for selected account
  useEffect(() => {
    if (!selectedAccountId || activeTab !== 'accounts') {
      setAccountRegister(null);
      return;
    }
    let cancelled = false;
    accountingApi
      .getGeneralLedger({
        accountId: selectedAccountId,
        startDate: '2026-01-01',
        endDate: '2099-12-31',
      })
      .then(rep => {
        if (!cancelled) setAccountRegister(rep.accounts[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setAccountRegister(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId, activeTab, journals.length, accounts.length]);

  const filteredAccounts = useMemo(
    () =>
      accounts.filter(acc => {
        const q = searchQuery.trim().toLowerCase();
        const matchesSearch =
          !q ||
          acc.name.toLowerCase().includes(q) ||
          (acc.code || '').toLowerCase().includes(q) ||
          acc.account_type.toLowerCase().includes(q);
        if (!matchesSearch) return false;
        if (filterType !== 'all') return acc.account_type === filterType;
        return true;
      }),
    [accounts, searchQuery, filterType]
  );

  const selectedAccount = accounts.find(a => a.id === selectedAccountId) || filteredAccounts[0] || null;

  const openCreateAccountModal = () => {
    setAccountModalMode('create');
    setEditingAccount(null);
    setAcctCode('');
    setAcctName('');
    setAcctType('Expense');
    setAcctDetailType('expense');
    setAcctParentId('');
    setAcctDesc('');
  };

  const openEditAccountModal = (acc: ApiAccount) => {
    setAccountModalMode('edit');
    setEditingAccount(acc);
    setAcctCode(acc.code || '');
    setAcctName(acc.name);
    setAcctType(acc.account_type);
    setAcctDetailType(acc.detail_type);
    setAcctParentId(acc.parent_id ? String(acc.parent_id) : '');
    setAcctDesc(acc.description || '');
  };

  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setAcctSaving(true);
    setErrorBanner(null);
    try {
      if (accountModalMode === 'create') {
        await accountingApi.createAccount({
          code: acctCode.trim() || null,
          name: acctName.trim(),
          accountType: acctType,
          detailType: acctDetailType,
          parentId: acctParentId ? Number(acctParentId) : null,
          description: acctDesc.trim() || undefined,
        });
        triggerShortcutNotice(`Created account ${acctCode ? `${acctCode} ` : ''}${acctName}`);
      } else if (accountModalMode === 'edit' && editingAccount) {
        await accountingApi.updateAccount(editingAccount.id, {
          code: acctCode.trim() || null,
          name: acctName.trim(),
          detailType: acctDetailType,
          parentId: acctParentId ? Number(acctParentId) : null,
          description: acctDesc.trim() || null,
        });
        triggerShortcutNotice(`Updated account ${acctName}`);
      }
      setAccountModalMode(null);
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to save account');
    } finally {
      setAcctSaving(false);
    }
  };

  const handleToggleAccountActive = async (acc: ApiAccount) => {
    setErrorBanner(null);
    try {
      await accountingApi.updateAccount(acc.id, { isActive: !acc.is_active });
      triggerShortcutNotice(`${acc.is_active ? 'Deactivated' : 'Reactivated'} account ${acc.name}`);
    } catch (err: any) {
      setErrorBanner(err?.message || 'Unable to change account status');
    }
  };

  const handleRebuildBalances = async () => {
    setErrorBanner(null);
    try {
      const res = await accountingApi.rebuildBalances();
      triggerShortcutNotice(
        `Verified ${res.checkedCount} accounts (${res.correctedCount} balance corrections applied)`
      );
    } catch (err: any) {
      setErrorBanner(err?.message || 'Failed to rebuild stored balances');
    }
  };

  const handleConfirmReverse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reversingEntry) return;
    setReversalSubmitting(true);
    setErrorBanner(null);
    try {
      const res = await accountingApi.reverseJournal(reversingEntry.id, {
        reversalDate: reversalDate || undefined,
        reason: reversalReason.trim() || undefined,
      });
      triggerShortcutNotice(`Posted reversal ${res.reversal.entryNumber} voiding ${reversingEntry.entryNumber}`);
      setReversingEntry(null);
      setReversalReason('');
    } catch (err: any) {
      setErrorBanner(err?.message || 'Unable to reverse journal entry');
    } finally {
      setReversalSubmitting(false);
    }
  };

  // Opening Balances totals preview
  const bsAccounts = useMemo(
    () => accounts.filter(a => a.is_active && BALANCE_SHEET_TYPE_SET.has(a.account_type)),
    [accounts]
  );
  const equityAccounts = useMemo(
    () => accounts.filter(a => a.is_active && a.account_type === 'Equity'),
    [accounts]
  );

  const obTotals = useMemo(() => {
    let debitCents = 0;
    let creditCents = 0;
    const lines: Array<{ accountId: number; amount: string }> = [];
    for (const acc of bsAccounts) {
      const raw = (obAmounts[acc.id] || '').trim();
      if (!raw) continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num === 0) continue;
      lines.push({ accountId: acc.id, amount: raw });
      const cents = Math.round(Math.abs(num) * 100);
      const debitNormal = DEBIT_NORMAL_TYPE_SET.has(acc.account_type);
      const isDebit = num > 0 ? debitNormal : !debitNormal;
      if (isDebit) debitCents += cents;
      else creditCents += cents;
    }
    return {
      lines,
      debit: debitCents / 100,
      credit: creditCents / 100,
      diff: (debitCents - creditCents) / 100,
    };
  }, [bsAccounts, obAmounts]);

  const handlePostOpeningBalances = async (e: React.FormEvent) => {
    e.preventDefault();
    if (obTotals.lines.length === 0 || obSubmitting) return;
    setObSubmitting(true);
    setErrorBanner(null);
    try {
      const res = await accountingApi.postOpeningBalances({
        txnDate: obDate,
        description: obDesc.trim() || 'Opening Balances',
        autoBalanceAccountId: obTotals.diff !== 0 && obAutoEquityId ? Number(obAutoEquityId) : null,
        lines: obTotals.lines,
      });
      triggerShortcutNotice(`Posted Opening Balances (${res.entry.entryNumber})`);
      setObAmounts({});
      setActiveTab('journals');
    } catch (err: any) {
      setErrorBanner(err?.message || 'Unable to post opening balances');
    } finally {
      setObSubmitting(false);
    }
  };

  const handleCreatePeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorBanner(null);
    try {
      await accountingApi.createPeriod({
        periodName: newPeriodName.trim(),
        startDate: newPeriodStart,
        endDate: newPeriodEnd,
      });
      setNewPeriodName('');
      triggerShortcutNotice('Fiscal period created');
    } catch (err: any) {
      setErrorBanner(err?.message || 'Unable to create fiscal period');
    }
  };

  const handleSoftClosePeriod = async (p: ApiFiscalPeriod) => {
    setErrorBanner(null);
    try {
      await accountingApi.softClosePeriod(p.id);
      triggerShortcutNotice(`Soft-closed "${p.period_name}" (adjusting entries only)`);
    } catch (err: any) {
      setErrorBanner(err?.message || 'Unable to soft-close period');
    }
  };

  const handleConfirmClosePeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!closingTargetPeriod) return;
    setErrorBanner(null);
    try {
      const res = await accountingApi.closePeriod(closingTargetPeriod.id, {
        generateClosingEntry,
        notes: closingNotes.trim() || undefined,
      });
      triggerShortcutNotice(
        res.closingTransactionId
          ? `Closed "${closingTargetPeriod.period_name}" & posted closing entry`
          : `Closed "${closingTargetPeriod.period_name}"`
      );
      setClosingTargetPeriod(null);
      setClosingNotes('');
    } catch (err: any) {
      setErrorBanner(err?.message || 'Unable to close fiscal period');
    }
  };

  const handleConfirmReopenPeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reopenTargetPeriod) return;
    setErrorBanner(null);
    try {
      await accountingApi.reopenPeriod(reopenTargetPeriod.id, reopenReason.trim());
      triggerShortcutNotice(`Reopened "${reopenTargetPeriod.period_name}"`);
      setReopenTargetPeriod(null);
      setReopenReason('');
    } catch (err: any) {
      setErrorBanner(err?.message || 'Unable to reopen fiscal period');
    }
  };

  const buildCoaActionContext = (record: any, pendingId?: string | null): ActionEligibilityContext<any> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'accounting',
    entityType: 'account',
    record,
    recordStatus: record?.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const renderAccountActions = (acc: any) => {
    const defs: AdvancedActionDefinition<any>[] = [
      { id: 'inspect', label: 'Inspect GL Register', icon: <Eye className="w-3.5 h-3.5 text-blue-600" />, group: 'view', groupLabel: 'Account', requiredPermission: 'accounting:read', execute: async () => setSelectedAccountId(acc.id) },
    ];
    if (canWriteAccounts) defs.push({ id: 'edit', label: 'Edit Account', icon: <Pencil className="w-3.5 h-3.5 text-slate-600" />, group: 'admin', groupLabel: 'Master data', requiredPermission: 'accounting:write', execute: async () => openEditAccountModal(acc) });
    if (canWriteJournals) defs.push({ id: 'journal-entry', label: 'Post Journal Entry', icon: <Scale className="w-3.5 h-3.5 text-emerald-600" />, group: 'process', groupLabel: 'Account', requiredPermission: 'accounting:write', execute: async () => setIsJournalEntryOpen(true) });
    if (canWriteAccounts && !acc.is_system && !acc.is_control) defs.push({ id: 'toggle-active', label: acc.is_active ? 'Deactivate Account' : 'Reactivate Account', icon: <Lock className="w-3.5 h-3.5 text-amber-600" />, group: 'admin', groupLabel: 'Master data', requiredPermission: 'accounting:write', execute: async () => handleToggleAccountActive(acc) });
    defs.push({ id: 'copy-code', label: 'Copy Account Label', icon: <Copy className="w-3.5 h-3.5" />, group: 'admin', groupLabel: 'Other', requiredPermission: 'accounting:read', execute: async () => { await navigator.clipboard?.writeText(`${acc.code || ''} - ${acc.name}`.trim()); triggerShortcutNotice(`Copied ${acc.code || ''} ${acc.name}`); } });
    const ctx = buildCoaActionContext(acc, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for account ${acc.code || acc.name}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={acc.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => { const def = action.definition; if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) }); }}
      />
    );
  };

  const isPeriodRestricted = useCallback(
    (txnDate: string) =>
      periods.some((p) => p.status !== 'open' && txnDate >= p.start_date && txnDate <= p.end_date),
    [periods]
  );

  const handleOpenLedgerAccount = useCallback((accountId: number) => {
    setSelectedAccountId(accountId);
    setActiveTab('accounts');
  }, []);

  const renderPeriodActions = (p: any) => {
    const defs: AdvancedActionDefinition<any>[] = [];
    if (canClosePeriods && p.status === 'open') defs.push({ id: 'soft-close', label: 'Soft-Close (Adjusting Only)', icon: <Lock className="w-3.5 h-3.5 text-amber-600" />, group: 'process', groupLabel: 'Period', requiredPermission: 'accounting:close', execute: async () => handleSoftClosePeriod(p) });
    if (canClosePeriods && p.status !== 'closed') defs.push({ id: 'hard-close', label: 'Close Period & Lock', icon: <CheckCircle2 className="w-3.5 h-3.5 text-rose-600" />, group: 'danger', groupLabel: 'Period', destructive: true, risk: 'destructive', requiredPermission: 'accounting:close', confirmation: { title: `Close ${p.period_name}`, message: 'Close this period?', confirmLabel: 'Close', destructive: true }, execute: async () => { setClosingTargetPeriod(p); setGenerateClosingEntry(true); setClosingNotes(''); } });
    if (canReopenPeriods && p.status !== 'open') defs.push({ id: 'reopen', label: 'Reopen Period', icon: <RotateCcw className="w-3.5 h-3.5 text-brand-600" />, group: 'admin', groupLabel: 'Period', requiredPermission: 'accounting:reopen', execute: async () => { setReopenTargetPeriod(p); setReopenReason(''); } });
    defs.push({ id: 'copy-period', label: 'Copy Period Name', icon: <Copy className="w-3.5 h-3.5" />, group: 'admin', groupLabel: 'Other', requiredPermission: 'accounting:read', execute: async () => { await navigator.clipboard?.writeText(p.period_name); triggerShortcutNotice(`Copied ${p.period_name}`); } });
    const ctx = buildCoaActionContext(p, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<any>
        label={`Actions for period ${p.period_name}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={p.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => { const def = action.definition; if (typeof def.execute === 'function') await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) }); }}
      />
    );
  };

  const coaTabs = [
    { id: 'accounts', label: 'Chart of Accounts', icon: <BookOpen className="h-3.5 w-3.5" />, count: accounts.length },
    ...(canReadJournals
      ? [{ id: 'journals', label: 'General Journal', icon: <Layers className="h-3.5 w-3.5" />, count: journals.length }]
      : []),
    ...(canWriteJournals
      ? [{ id: 'opening', label: 'Opening Balances', icon: <Scale className="h-3.5 w-3.5" /> }]
      : []),
    { id: 'periods', label: 'Fiscal Periods', icon: <Calendar className="h-3.5 w-3.5" />, count: periods.length },
  ];

  return (
    <PageShell>
      <PageHeader
        title="Chart of Accounts & General Ledger"
        subtitle="Double-entry Chart of Accounts, immutable journals, traceable reversals, opening balances and period closing locks."
        icon={<BookOpen className="h-4.5 w-4.5" />}
        actions={
          <>
            {canRebuild && (
              <Button variant="secondary" size="sm" onClick={handleRebuildBalances}>
                <RefreshCw className="h-3.5 w-3.5" />
                Rebuild Balances
              </Button>
            )}
            {canWriteJournals && (
              <Button variant="secondary" size="sm" onClick={() => setIsJournalEntryOpen(true)}>
                <Scale className="h-3.5 w-3.5" />
                New Journal Entry
              </Button>
            )}
            {canWriteAccounts && (
              <Button variant="primary" size="sm" onClick={openCreateAccountModal}>
                <Plus className="h-3.5 w-3.5" />
                Add Account
              </Button>
            )}
          </>
        }
      />

      <Tabs
        items={coaTabs}
        activeId={activeTab}
        onChange={id => setActiveTab(id as CoaTab)}
        ariaLabel="Accounting sections"
      />

      {errorBanner && (
        <InlineAlert tone="rose" onDismiss={() => setErrorBanner(null)}>
          {errorBanner}
        </InlineAlert>
      )}

      {/* TAB 1: CHART OF ACCOUNTS & LIVE REGISTER */}
      {activeTab === 'accounts' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 surface overflow-hidden">
            <div className="surface-header flex-wrap gap-2">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search account code or name..."
                  className="app-input pl-8"
                />
              </div>

              <select
                value={filterType}
                onChange={e => setFilterType(e.target.value)}
                className="app-input !w-auto min-w-[160px]"
              >
                <option value="all">All Account Types</option>
                {ACCOUNT_TYPE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>

              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showInactive}
                  onChange={e => setShowInactive(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Show Inactive</span>
              </label>
            </div>

            <div className="overflow-x-auto max-h-[620px] overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 uppercase tracking-wider font-bold text-[10px] sticky top-0 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-2.5 w-16">CODE</th>
                    <th className="px-4 py-2.5">ACCOUNT NAME</th>
                    <th className="px-4 py-2.5">TYPE / NORMAL</th>
                    <th className="px-4 py-2.5 text-right">BALANCE</th>
                    <th className="px-4 py-2.5 text-right">ACTIONS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                        Loading Chart of Accounts...
                      </td>
                    </tr>
                  ) : filteredAccounts.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                        No accounts match your filter.
                      </td>
                    </tr>
                  ) : (
                    filteredAccounts.map(acc => {
                      const isSelected = acc.id === selectedAccount?.id;
                      return (
                        <tr
                          key={acc.id}
                          onClick={() => setSelectedAccountId(acc.id)}
                          className={`cursor-pointer transition-colors ${
                            !acc.is_active ? 'opacity-55' : ''
                          } ${
                            isSelected
                              ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-900 dark:text-blue-100'
                              : 'hover:bg-slate-50 dark:hover:bg-slate-850/50'
                          }`}
                        >
                          <td className="px-4 py-2.5 font-mono font-bold text-slate-500">
                            {acc.code || '—'}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                              {acc.parent_id ? <span className="text-slate-400">↳</span> : null}
                              <span>{acc.name}</span>
                              {acc.is_control && (
                                <span className="text-[10px] font-mono text-amber-700 dark:text-amber-400">
                                  [Control]
                                </span>
                              )}
                              {!acc.is_active && (
                                <span className="text-[10px] font-mono text-slate-400">[Inactive]</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-[11px] text-slate-500">
                            {acc.account_type.replace(/([A-Z])/g, ' $1').trim()} ·{' '}
                            <span className="uppercase">{acc.normal_balance}</span>
                          </td>
                          <td
                            className={`px-4 py-2.5 text-right font-mono tabular-nums font-bold ${
                              acc.balanceNum < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'
                            }`}
                          >
                            {formatCurrency(acc.balanceNum, currency)}
                          </td>
                          <td className="px-4 py-2.5 text-right" onClick={e => e.stopPropagation()}>
                            {renderAccountActions(acc)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right Column: Live General Ledger Register Drill-Down */}
          <div className="lg:col-span-5">
            {selectedAccount ? (
              <div className="surface p-5 space-y-4">
                <div className="border-b border-slate-200 dark:border-white/[0.08] pb-3 flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-xs font-bold text-slate-500">
                      {selectedAccount.code || 'No Code'} · {selectedAccount.account_type} ({selectedAccount.detail_type})
                    </div>
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white mt-0.5">
                      {selectedAccount.name}
                    </h2>
                    {selectedAccount.description && (
                      <p className="text-xs text-slate-500 mt-1">{selectedAccount.description}</p>
                    )}
                  </div>
                  <span className="font-mono text-[11px] uppercase text-slate-500">
                    Normal: {selectedAccount.normal_balance}
                  </span>
                </div>

                <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500">Current Ledger Balance</span>
                  <span className="text-xl font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                    {formatCurrency(selectedAccount.balanceNum, currency)}
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    General Ledger Register History
                  </div>
                  {!accountRegister || accountRegister.entries.length === 0 ? (
                    <div className="p-6 text-center text-slate-400 text-xs bg-slate-50 dark:bg-slate-850 rounded-lg">
                      No posted ledger lines on this account yet.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs max-h-[380px] overflow-y-auto">
                      {accountRegister.entries.map(line => (
                        <div key={line.lineId} className="py-2.5 flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                              {line.description}
                            </div>
                            <div className="font-mono text-[11px] text-slate-400">
                              {line.txnDate} · {line.entryNumber}
                              {line.isAdjusting ? ' · ADJ' : ''}
                              {line.voided ? ' · VOID' : ''}
                            </div>
                          </div>
                          <div className="text-right font-mono tabular-nums shrink-0">
                            {line.debitNum > 0 ? (
                              <div className="font-bold text-blue-600 dark:text-blue-400">
                                Dr {formatCurrency(line.debitNum, currency)}
                              </div>
                            ) : (
                              <div className="font-bold text-emerald-600 dark:text-emerald-400">
                                Cr {formatCurrency(line.creditNum, currency)}
                              </div>
                            )}
                            <div className="text-[11px] text-slate-500">
                              Bal {formatCurrency(line.runningBalanceNum, currency)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* TAB 2: GENERAL JOURNAL & TRACEABLE REVERSALS */}
      {activeTab === 'journals' && (
        <JournalLedgerTable
          journals={journals}
          currency={currency}
          authenticated={authenticated}
          permissions={permissions}
          role={activeCompany?.role || null}
          companyId={activeCompany?.id ?? null}
          canWriteJournals={canWriteJournals}
          isPeriodRestricted={isPeriodRestricted}
          onOpenAccount={handleOpenLedgerAccount}
          onReverse={(entry) => {
            setReversingEntry(entry);
            setReversalDate(entry.txnDate);
            setReversalReason('');
          }}
          notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        />
      )}

      {/* TAB 3: OPENING BALANCES WIZARD */}
      {activeTab === 'opening' && (
        <form
          onSubmit={handlePostOpeningBalances}
          className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Opening Balances Setup
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Enter positive opening amounts in each account&apos;s natural direction (or negative for contra accounts such as Accumulated Depreciation).
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-600 dark:text-slate-300 mb-1">As-Of Date</label>
                <input
                  type="date"
                  value={obDate}
                  onChange={e => setObDate(e.target.value)}
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 font-mono"
                  required
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-600 dark:text-slate-300 mb-1">Description</label>
                <input
                  type="text"
                  value={obDesc}
                  onChange={e => setObDesc(e.target.value)}
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5"
                />
              </div>
            </div>
          </div>

          <div className="overflow-x-auto max-h-[420px] overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/70 text-[10px] uppercase font-bold text-slate-500 sticky top-0 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-2.5">CODE</th>
                  <th className="px-4 py-2.5">BALANCE SHEET ACCOUNT</th>
                  <th className="px-4 py-2.5">NORMAL SIDE</th>
                  <th className="px-4 py-2.5 text-right w-44">OPENING AMOUNT ({currency})</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {bsAccounts.map(acc => (
                  <tr key={acc.id}>
                    <td className="px-4 py-2 font-mono text-slate-500">{acc.code || '—'}</td>
                    <td className="px-4 py-2 font-semibold text-slate-900 dark:text-white">{acc.name}</td>
                    <td className="px-4 py-2 text-[11px] uppercase font-mono text-slate-500">
                      {acc.normal_balance}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        value={obAmounts[acc.id] ?? ''}
                        onChange={e => setObAmounts(prev => ({ ...prev, [acc.id]: e.target.value }))}
                        className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1 text-right font-mono tabular-nums outline-none"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="flex flex-wrap items-center gap-5 font-mono tabular-nums">
              <span>Debits: <strong>{formatCurrency(obTotals.debit, currency)}</strong></span>
              <span>Credits: <strong>{formatCurrency(obTotals.credit, currency)}</strong></span>
              <span>
                Difference:{' '}
                <strong className={obTotals.diff === 0 ? 'text-emerald-600' : 'text-amber-600'}>
                  {formatCurrency(Math.abs(obTotals.diff), currency)}
                </strong>
              </span>
            </div>

            {obTotals.diff !== 0 && (
              <div className="flex items-center gap-2">
                <label className="text-slate-600 dark:text-slate-300 font-semibold">Auto-Balance Equity Account:</label>
                <select
                  value={obAutoEquityId}
                  onChange={e => setObAutoEquityId(e.target.value)}
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1.5 text-xs"
                >
                  <option value="">None (Require exact balance)</option>
                  {equityAccounts.map(eq => (
                    <option key={eq.id} value={String(eq.id)}>
                      {eq.code ? `${eq.code} - ` : ''}{eq.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <Button
              type="submit"
              variant="emerald"
              disabled={obTotals.lines.length === 0 || obSubmitting || (obTotals.diff !== 0 && !obAutoEquityId)}
            >
              {obSubmitting ? 'Posting...' : 'Post Opening Balances'}
            </Button>
          </div>
        </form>
      )}

      {/* TAB 4: FISCAL PERIODS & CLOSING LOCKS */}
      {activeTab === 'periods' && (
        <div className="space-y-4">
          {canClosePeriods && (
            <form
              onSubmit={handleCreatePeriod}
              className="surface p-4 flex flex-wrap items-end gap-3 text-xs"
            >
              <div className="flex-1 min-w-[180px] space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Period Name</label>
                <input
                  type="text"
                  value={newPeriodName}
                  onChange={e => setNewPeriodName(e.target.value)}
                  placeholder="e.g. Oct 2026 or FY 2025"
                  className="app-input"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">Start Date</label>
                <input
                  type="date"
                  value={newPeriodStart}
                  onChange={e => setNewPeriodStart(e.target.value)}
                  className="app-input font-mono"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">End Date</label>
                <input
                  type="date"
                  value={newPeriodEnd}
                  onChange={e => setNewPeriodEnd(e.target.value)}
                  className="app-input font-mono"
                  required
                />
              </div>
              <Button type="submit" variant="primary" size="sm">
                Create Fiscal Period
              </Button>
            </form>
          )}

          <div className="surface overflow-hidden">
            <table className="data-table">
              <thead>
                <tr>
                  <th>PERIOD</th>
                  <th>DATE RANGE</th>
                  <th>STATUS</th>
                  <th>CLOSING NOTES</th>
                  <th className="text-right">ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {periods.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                      No fiscal periods defined yet. Create a period above to enforce soft-close or hard-close accounting locks.
                    </td>
                  </tr>
                ) : (
                  periods.map(p => (
                    <tr key={p.id}>
                      <td className="font-semibold text-slate-900 dark:text-white">{p.period_name}</td>
                      <td className="font-mono text-slate-600 dark:text-slate-300">
                        {p.start_date} to {p.end_date}
                      </td>
                      <td>
                        {p.status === 'closed' && <StatusBadge tone="rose">Closed (Locked)</StatusBadge>}
                        {p.status === 'soft_closed' && <StatusBadge tone="amber">Soft-Closed</StatusBadge>}
                        {p.status === 'open' && <StatusBadge tone="emerald">Open</StatusBadge>}
                      </td>
                      <td className="text-slate-500">{p.notes || '—'}</td>
                      <td className="text-right">
                        {renderPeriodActions(p)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ADD / EDIT ACCOUNT MODAL */}
      <ModalShell open={Boolean(accountModalMode)} onClose={() => setAccountModalMode(null)} size="md">
        <ModalHeader
          title={accountModalMode === 'create' ? 'Add Account to Chart of Accounts' : 'Edit Account'}
          subtitle="Configure account code, classification and statement placement"
          icon={<BookOpen className="h-4.5 w-4.5" />}
          onClose={() => setAccountModalMode(null)}
        />
        <form onSubmit={handleSaveAccount} className="flex min-h-0 flex-1 flex-col">
          <ModalBody className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Account Code">
                <input
                  type="text"
                  value={acctCode}
                  onChange={e => setAcctCode(e.target.value)}
                  placeholder="e.g. 6450"
                  disabled={Boolean(editingAccount?.is_control)}
                  className="app-input font-mono"
                />
              </FormField>
              <FormField label="Account Type">
                <select
                  value={acctType}
                  disabled={accountModalMode === 'edit'}
                  onChange={e => {
                    const next = e.target.value as ApiAccountType;
                    setAcctType(next);
                    const def = ACCOUNT_TYPE_OPTIONS.find(o => o.value === next)?.defaultDetail || 'expense';
                    setAcctDetailType(def);
                  }}
                  className="app-input"
                >
                  {ACCOUNT_TYPE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>

            <FormField label="Detail Type (Statement Placement)">
              <select
                value={acctDetailType}
                onChange={e => setAcctDetailType(e.target.value as ApiDetailType)}
                className="app-input"
              >
                {(DETAIL_OPTIONS_BY_TYPE[acctType] || []).map(d => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField label="Account Name" required>
              <input
                type="text"
                value={acctName}
                onChange={e => setAcctName(e.target.value)}
                placeholder="e.g. Press Maintenance & Spares"
                className="app-input"
                required
              />
            </FormField>

            <FormField label="Parent Account (Optional)">
              <select
                value={acctParentId}
                onChange={e => setAcctParentId(e.target.value)}
                className="app-input"
              >
                <option value="">None (Top-Level Account)</option>
                {accounts
                  .filter(a => a.id !== editingAccount?.id && a.account_type === acctType)
                  .map(a => (
                    <option key={a.id} value={String(a.id)}>
                      {a.code ? `${a.code} - ` : ''}{a.name}
                    </option>
                  ))}
              </select>
            </FormField>

            <FormField label="Description">
              <input
                type="text"
                value={acctDesc}
                onChange={e => setAcctDesc(e.target.value)}
                placeholder="Optional ledger description"
                className="app-input"
              />
            </FormField>
          </ModalBody>
          <ModalFooter
            right={
              <>
                <Button variant="secondary" onClick={() => setAccountModalMode(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={acctSaving}>
                  {acctSaving ? 'Saving...' : 'Save Account'}
                </Button>
              </>
            }
          />
        </form>
      </ModalShell>

      {/* VIEW JOURNAL DETAILS MODAL */}
      <ModalShell open={Boolean(viewingJournal)} onClose={() => setViewingJournal(null)} size="2xl">
        <ModalHeader
          title={`Journal ${viewingJournal?.entryNumber ?? ''}`}
          subtitle={viewingJournal?.description || undefined}
          icon={<Layers className="h-4.5 w-4.5" />}
          onClose={() => setViewingJournal(null)}
        />
        {viewingJournal && (
          <>
            <ModalBody className="space-y-4">
              <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-xs text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-slate-300">
                <div><span className="font-semibold text-slate-900 dark:text-white">Date:</span> <span className="font-mono">{viewingJournal.txnDate}</span></div>
                <div><span className="font-semibold text-slate-900 dark:text-white">Source:</span> {viewingJournal.sourceType}</div>
                <div><span className="font-semibold text-slate-900 dark:text-white">Status:</span> <span className="uppercase font-mono">{viewingJournal.status}</span></div>
                <div><span className="font-semibold text-slate-900 dark:text-white">Reference:</span> {viewingJournal.reference || '—'}</div>
              </div>
              <div className="surface overflow-hidden">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th className="text-right">Debit</th>
                      <th className="text-right">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewingJournal.lines.map(l => (
                      <tr key={l.id}>
                        <td>
                          {l.accountCode ? `${l.accountCode} ` : ''}{l.accountName}
                          {l.basis !== 'both' ? ` [${l.basis}]` : ''}
                        </td>
                        <td className="text-right font-mono tabular-nums text-brand-600 dark:text-brand-400">
                          {l.debitNum > 0 ? formatCurrency(l.debitNum, currency) : ''}
                        </td>
                        <td className="text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                          {l.creditNum > 0 ? formatCurrency(l.creditNum, currency) : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ModalBody>
            <ModalFooter right={<Button variant="secondary" onClick={() => setViewingJournal(null)}>Close</Button>} />
          </>
        )}
      </ModalShell>

      {/* REVERSE (VOID) JOURNAL ENTRY MODAL */}
      <ModalShell open={Boolean(reversingEntry)} onClose={() => setReversingEntry(null)} size="md">
        <ModalHeader
          title={`Reverse Journal Entry ${reversingEntry?.entryNumber ?? ''}`}
          icon={<RotateCcw className="h-4.5 w-4.5" />}
          tone="rose"
          onClose={() => setReversingEntry(null)}
        />
        {reversingEntry && (
          <form onSubmit={handleConfirmReverse} className="flex min-h-0 flex-1 flex-col">
            <ModalBody className="space-y-4">
              <InlineAlert tone="amber">
                Posted entries cannot be deleted or edited. Reversing creates a mirror-image entry swapping all debits and credits and marks{' '}
                <strong>{reversingEntry.entryNumber}</strong> as voided.
              </InlineAlert>
              <FormField label="Reversal Date" required>
                <input
                  type="date"
                  value={reversalDate}
                  onChange={e => setReversalDate(e.target.value)}
                  className="app-input font-mono"
                  required
                />
              </FormField>
              <FormField label="Audit Reason" required>
                <input
                  type="text"
                  value={reversalReason}
                  onChange={e => setReversalReason(e.target.value)}
                  placeholder="Reason for voiding/reversing..."
                  className="app-input"
                  required
                />
              </FormField>
            </ModalBody>
            <ModalFooter
              right={
                <>
                  <Button variant="secondary" onClick={() => setReversingEntry(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="danger" disabled={reversalSubmitting}>
                    {reversalSubmitting ? 'Reversing...' : 'Confirm Reversal'}
                  </Button>
                </>
              }
            />
          </form>
        )}
      </ModalShell>

      {/* HARD CLOSE PERIOD MODAL */}
      <ModalShell open={Boolean(closingTargetPeriod)} onClose={() => setClosingTargetPeriod(null)} size="md">
        <ModalHeader
          title={`Close Fiscal Period — ${closingTargetPeriod?.period_name ?? ''}`}
          icon={<Lock className="h-4.5 w-4.5" />}
          tone="rose"
          onClose={() => setClosingTargetPeriod(null)}
        />
        {closingTargetPeriod && (
          <form onSubmit={handleConfirmClosePeriod} className="flex min-h-0 flex-1 flex-col">
            <ModalBody className="space-y-4 text-xs">
              <p className="text-slate-600 dark:text-slate-300">
                Closing permanently blocks all new journal entries and reversals dated between{' '}
                <strong className="font-mono">{closingTargetPeriod.start_date}</strong> and{' '}
                <strong className="font-mono">{closingTargetPeriod.end_date}</strong>.
              </p>
              <label className="flex items-start gap-2 cursor-pointer text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={generateClosingEntry}
                  onChange={e => setGenerateClosingEntry(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300"
                />
                <span>
                  <strong>Generate Year-End Closing Journal Entry</strong> — transfer net Income/Expense balances in this period to Retained Earnings (3200).
                </span>
              </label>
              <FormField label="Closing Notes (Optional)">
                <input
                  type="text"
                  value={closingNotes}
                  onChange={e => setClosingNotes(e.target.value)}
                  placeholder="Sign-off note..."
                  className="app-input"
                />
              </FormField>
            </ModalBody>
            <ModalFooter
              right={
                <>
                  <Button variant="secondary" onClick={() => setClosingTargetPeriod(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="danger">
                    Close &amp; Lock Period
                  </Button>
                </>
              }
            />
          </form>
        )}
      </ModalShell>

      {/* REOPEN PERIOD MODAL */}
      <ModalShell open={Boolean(reopenTargetPeriod)} onClose={() => setReopenTargetPeriod(null)} size="md">
        <ModalHeader
          title={`Reopen Fiscal Period — ${reopenTargetPeriod?.period_name ?? ''}`}
          icon={<Unlock className="h-4.5 w-4.5" />}
          tone="amber"
          onClose={() => setReopenTargetPeriod(null)}
        />
        {reopenTargetPeriod && (
          <form onSubmit={handleConfirmReopenPeriod} className="flex min-h-0 flex-1 flex-col">
            <ModalBody className="space-y-4">
              <FormField label="Mandatory Audit Reason" required>
                <input
                  type="text"
                  value={reopenReason}
                  onChange={e => setReopenReason(e.target.value)}
                  placeholder="Explain why this locked period is being reopened..."
                  className="app-input"
                  required
                />
              </FormField>
            </ModalBody>
            <ModalFooter
              right={
                <>
                  <Button variant="secondary" onClick={() => setReopenTargetPeriod(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="amber">
                    Reopen Period
                  </Button>
                </>
              }
            />
          </form>
        )}
      </ModalShell>
    </PageShell>
  );
};
