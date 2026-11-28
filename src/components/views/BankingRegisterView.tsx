import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT, accountingApi, ApiAccount } from '../../services/accountingApi';
import { ApiBankAccount, ApiBankTransaction, commercialApi } from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
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
  CreditCard,
  CheckSquare,
  Square,
  Search,
  Scale,
  CheckCircle2,
  Copy,
  ArrowLeftRight,
  Plus,
  Upload,
  SlidersHorizontal,
  Printer,
  Ban,
  Loader2,
  Trash2,
  Eye,
  Download,
  BookOpen,
  Layers,
} from 'lucide-react';
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
} from '../common/ui';

interface BankRegisterTableProps {
  transactions: ApiBankTransaction[];
  allTransactions: ApiBankTransaction[];
  currency: string;
  tableDensity?: string;
  authenticated: boolean;
  permissions: string[];
  role: string | null;
  companyId: number | null;
  canWrite: boolean;
  onSelectBankAccount: (glAccountId: number) => void;
  onOpenGlAccount: (accountId: number) => void;
  reload: () => Promise<void> | void;
  notify: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
}

const bankTxRef = (tx: ApiBankTransaction) =>
  createTransactionRef(tx, {
    moduleKey: 'banking',
    entityType: 'bank_transaction',
    id: (t) => t.id,
    number: (t) => t.checkNumber || t.refNumber || t.type,
    status: (t) => t.status,
  });

const bankRefLabel = (tx: ApiBankTransaction) => tx.checkNumber || tx.refNumber || tx.type;

function buildBankSections(
  tx: ApiBankTransaction,
  currency: string,
  onOpenGlAccount: (accountId: number) => void
): DetailSection[] {
  const isDeposit = tx.amount >= 0;
  const sections: DetailSection[] = [
    {
      key: 'txn',
      title: 'Transaction',
      fields: [
        { label: 'Reference', value: bankRefLabel(tx), mono: true },
        { label: 'Date', value: tx.date, mono: true },
        { label: 'Type', value: tx.type },
        { label: 'Direction', value: isDeposit ? 'Deposit (+)' : 'Payment (-)' },
        { label: 'Amount', value: formatCurrency(Math.abs(tx.amount), currency), mono: true, tone: isDeposit ? 'emerald' : 'rose' },
        { label: 'Status', value: tx.status },
        { label: 'Cleared', value: tx.cleared ? 'Yes' : 'No' },
        { label: 'Reconciled', value: tx.reconciliationId ? `Yes (#${tx.reconciliationId})` : 'No' },
      ],
    },
    {
      key: 'classification',
      title: 'Classification',
      fields: [
        { label: 'Bank account', value: tx.accountName },
        { label: 'Category', value: tx.category || '—' },
        {
          label: 'Offset account',
          value:
            tx.offsetAccountId != null
              ? `${tx.offsetAccountName || ''}`.trim() || `#${tx.offsetAccountId}`
              : '—',
        },
        { label: 'Running balance', value: tx.status === 'posted' ? formatCurrency(tx.runningBalance, currency) : '—', mono: true },
      ],
    },
    {
      key: 'source',
      title: 'Source & links',
      fields: [
        { label: 'Payee / payer', value: tx.payee },
        { label: 'Memo', value: tx.memo || '—', span: 2 },
        { label: 'Journal txn', value: tx.journalTxnId ? `#${tx.journalTxnId}` : '—', mono: true },
        { label: 'Check #', value: tx.checkNumber || '—', mono: true },
        { label: 'Print later', value: tx.printLater ? 'Yes' : 'No' },
        { label: 'Printed at', value: tx.printedAt || '—' },
      ],
    },
  ];
  if (tx.offsetAccountId != null) {
    sections.push({
      key: 'related',
      title: 'Related records',
      content: (
        <div className="flex flex-wrap gap-2 text-[11px]">
          {tx.journalTxnId != null && (
            <button
              type="button"
              onClick={() => onOpenGlAccount(tx.offsetAccountId as number)}
              className="rounded border border-slate-300 dark:border-slate-700 px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Open in General Ledger
            </button>
          )}
          {tx.reconciliationId != null && (
            <span className="rounded border border-emerald-300 dark:border-emerald-800 px-2 py-1 text-emerald-700 dark:text-emerald-300">
              Reconciled #{tx.reconciliationId}
            </span>
          )}
        </div>
      ),
    });
  }
  return sections;
}

function BankRegisterInner({
  transactions,
  allTransactions,
  currency,
  tableDensity,
  authenticated,
  permissions,
  role,
  companyId,
  canWrite,
  onSelectBankAccount,
  onOpenGlAccount,
  reload,
  notify,
}: BankRegisterTableProps) {
  const selection = useTransactionSelection();
  const [detail, setDetail] = useState<ApiBankTransaction | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    point: { x: number; y: number };
    tx: ApiBankTransaction;
    resolved: ResolvedAdvancedAction<ApiBankTransaction>[];
    ctx: ActionEligibilityContext<ApiBankTransaction>;
  } | null>(null);

  useEffect(() => {
    selection.setOrderedIds(transactions.map((t) => t.id));
  }, [transactions, selection]);

  const ctxFor = useCallback(
    (tx: ApiBankTransaction): ActionEligibilityContext<ApiBankTransaction> => {
      const caps: string[] = [];
      if (tx.status === 'posted') caps.push('posted');
      if (tx.cleared) caps.push('cleared');
      if (tx.reconciliationId) caps.push('reconciled');
      if (tx.printLater && !tx.printedAt) caps.push('print_queued');
      return {
        authenticated,
        permissions,
        role,
        companyId,
        moduleKey: 'banking',
        entityType: 'bank_transaction',
        record: tx,
        recordStatus: tx.status,
        recordCapabilities: caps,
      };
    },
    [authenticated, permissions, role, companyId]
  );

  const buildActions = useCallback(
    (tx: ApiBankTransaction): AdvancedActionDefinition<ApiBankTransaction>[] => {
      const defs: AdvancedActionDefinition<ApiBankTransaction>[] = [
        {
          id: 'view',
          label: 'View Transaction',
          icon: <Eye className="w-3.5 h-3.5" />,
          group: 'view',
          groupLabel: 'Transaction',
          requiredPermission: 'banking:read',
          execute: async () => setDetail(tx),
        },
        {
          id: 'copy-ref',
          label: 'Copy Reference',
          icon: <Copy className="w-3.5 h-3.5" />,
          group: 'admin',
          groupLabel: 'Other',
          requiredPermission: 'banking:read',
          execute: async () => {
            await navigator.clipboard?.writeText(bankRefLabel(tx));
            notify(`Copied ${bankRefLabel(tx)}`);
          },
        },
      ];
      if (canWrite && tx.status === 'posted' && !tx.reconciliationId) {
        defs.push({
          id: 'toggle-cleared',
          label: tx.cleared ? 'Mark Uncleared' : 'Mark Cleared',
          icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />,
          group: 'process',
          groupLabel: 'Reconciliation',
          requiredPermission: 'banking:write',
          execute: async () => {
            await commercialApi.toggleCleared(tx.id, !tx.cleared);
            await reload();
          },
        });
      }
      if (canWrite && tx.status === 'posted' && tx.printLater && !tx.printedAt) {
        defs.push({
          id: 'mark-printed',
          label: 'Mark Check Printed',
          icon: <Printer className="w-3.5 h-3.5" />,
          group: 'process',
          groupLabel: 'Reconciliation',
          requiredPermission: 'banking:write',
          execute: async () => {
            await commercialApi.markChecksPrinted([tx.id]);
            notify(`Marked ${bankRefLabel(tx)} printed`);
            await reload();
          },
        });
      }
      if (canWrite && tx.status === 'posted' && !tx.reconciliationId) {
        defs.push({
          id: 'void',
          label: 'Void Transaction (Reverse GL)',
          icon: <Ban className="w-3.5 h-3.5 text-rose-600" />,
          group: 'danger',
          groupLabel: 'Sensitive operations',
          destructive: true,
          risk: 'destructive',
          requiredPermission: 'banking:write',
          confirmation: {
            title: `Void ${bankRefLabel(tx)}`,
            message: 'Void this bank transaction and reverse its GL impact?',
            confirmLabel: 'Void',
            destructive: true,
            requireReason: true,
            reasonLabel: 'Void reason',
          },
          execute: async (_ctx, helpers) => {
            await commercialApi.voidBankTransaction(tx.id, helpers.reason || 'Voided in register');
            notify(`Voided ${bankRefLabel(tx)} & reversed GL`);
            await reload();
          },
        });
      }
      defs.push({
        id: 'open-bank-account',
        label: 'Open Bank Account',
        icon: <ArrowLeftRight className="w-3.5 h-3.5" />,
        group: 'navigation',
        groupLabel: 'Navigation',
        requiredPermission: 'banking:read',
        execute: async () => onSelectBankAccount(tx.accountId),
      });
      if (tx.offsetAccountId != null) {
        defs.push({
          id: 'open-gl-account',
          label: 'Open GL Account',
          icon: <Layers className="w-3.5 h-3.5" />,
          group: 'navigation',
          groupLabel: 'Navigation',
          requiredPermission: 'accounts:read',
          execute: async () => onOpenGlAccount(tx.offsetAccountId as number),
        });
      }
      defs.push({
        id: 'audit',
        label: 'View Audit History',
        icon: <BookOpen className="w-3.5 h-3.5" />,
        group: 'investigate',
        groupLabel: 'Investigation',
        requiredPermission: 'audit:read',
        execute: async () => setDetail(tx),
      });
      return defs;
    },
    [canWrite, notify, onOpenGlAccount, onSelectBankAccount, reload]
  );

  const executeFrom = useCallback(
    (ctx: ActionEligibilityContext<ApiBankTransaction>) =>
      async (action: ResolvedAdvancedAction<ApiBankTransaction>) => {
        const def = action.definition;
        if (typeof def.execute === 'function') {
          await def.execute(ctx, { notify });
        }
      },
    [notify]
  );

  const detailRef = useMemo(() => (detail ? bankTxRef(detail) : null), [detail]);
  const audit = useTransactionAudit(undefined, detailRef, Boolean(detail));
  const canReadAudit = permissions.includes('audit:read');
  const allSelected = transactions.length > 0 && transactions.every((t) => selection.isSelected(t.id));
  const selected = allTransactions.filter((t) => selection.isSelected(t.id));
  const cellPad = tableDensity === 'compact' ? 'px-3 py-2' : 'px-3 py-3';

  const markPrintedBulk: AdvancedActionDefinition<ApiBankTransaction> = {
    id: 'bulk-mark-printed',
    label: 'Mark Printed',
    icon: <Printer className="w-3.5 h-3.5" />,
    group: 'process',
    requiredPermission: 'banking:write',
    applicableStatuses: ['posted'],
    isEnabled: (ctx) => {
      const tx = ctx.record as ApiBankTransaction;
      return tx.printLater && !tx.printedAt
        ? { enabled: true }
        : { enabled: false, reason: 'Not queued for printing' };
    },
    confirmation: {
      title: 'Mark selected checks printed',
      message: 'Mark the selected queued checks as printed?',
      confirmLabel: 'Mark Printed',
    },
    execute: async (ctx) => {
      const tx = ctx.record as ApiBankTransaction;
      await commercialApi.markChecksPrinted([tx.id]);
      return { status: 'success', message: `Marked ${bankRefLabel(tx)} printed` };
    },
  };

  const exportSelected = () => {
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Date', 'Reference', 'Payee', 'Type', 'Category', 'Amount', 'Cleared', 'Status'];
    const lines = selected.map((t) =>
      [t.date, bankRefLabel(t), t.payee, t.type, t.category, t.amount, t.cleared ? 'Yes' : 'No', t.status]
        .map(cell)
        .join(',')
    );
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bank-register-selection.csv';
    a.click();
    URL.revokeObjectURL(url);
    notify(`Exported ${selected.length} transaction(s)`);
  };

  return (
    <>
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <TransactionBulkActionToolbar
            definitions={[markPrintedBulk]}
            records={selected}
            getRef={bankTxRef}
            buildContext={ctxFor}
            notify={notify}
          />
          <button
            type="button"
            onClick={exportSelected}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Download className="w-3.5 h-3.5" /> Export selected
          </button>
        </div>
      )}

      <div className="surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 dark:bg-white/[0.04] text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-white/[0.08] uppercase tracking-wider font-semibold text-[11px]">
              <tr>
                <th className="px-3 py-2.5 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all transactions"
                    checked={allSelected}
                    onChange={() => (allSelected ? selection.clear() : selection.selectAll(transactions.map((t) => t.id)))}
                  />
                </th>
                <th className="px-3 py-2.5 w-24">Date</th>
                <th className="px-3 py-2.5 w-28">Ref / Chk #</th>
                <th className="px-3 py-2.5">Payee / Memo</th>
                <th className="px-3 py-2.5 w-40">Category / Offset</th>
                <th className="px-3 py-2.5 w-16 text-center">Clr</th>
                <th className="px-3 py-2.5 w-28 text-right">Payment (-)</th>
                <th className="px-3 py-2.5 w-28 text-right">Deposit (+)</th>
                <th className="px-3 py-2.5 w-32 text-right">Running Bal</th>
                <th className="px-3 py-2.5 w-16 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono text-xs">
              {transactions.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center font-sans text-slate-400">
                    No bank register entries match your filter.
                  </td>
                </tr>
              ) : (
                transactions.map((tx) => {
                  const isDisbursement = tx.amount < 0;
                  const refLabel = bankRefLabel(tx);
                  const ctx = ctxFor(tx);
                  const resolved = resolveActions(buildActions(tx), ctx);
                  const isSelected = selection.isSelected(tx.id);
                  return (
                    <tr
                      key={tx.id}
                      onClick={() => setDetail(tx)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ point: { x: e.clientX, y: e.clientY }, tx, resolved, ctx });
                      }}
                      className={`cursor-pointer transition-colors hover:bg-blue-50/50 dark:hover:bg-slate-850 ${
                        tx.status === 'voided' ? 'opacity-50 line-through' : ''
                      } ${isSelected ? 'bg-blue-50 dark:bg-blue-950/40' : ''}`}
                    >
                      <td className={`${cellPad} align-top`} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${refLabel}`}
                          checked={isSelected}
                          onChange={(e) => selection.toggle(tx.id, { shiftKey: (e.nativeEvent as MouseEvent).shiftKey })}
                        />
                      </td>
                      <td className={`${cellPad} text-slate-600 dark:text-slate-400 whitespace-nowrap align-top`}>{tx.date}</td>
                      <td className={`${cellPad} font-bold whitespace-nowrap align-top`}>
                        {refLabel}
                        {tx.reconciliationId && (
                          <span className="ml-1 text-[10px] text-emerald-600" title="Reconciled">[R]</span>
                        )}
                      </td>
                      <td className={`${cellPad} font-sans align-top`}>
                        <div className="font-semibold text-slate-900 dark:text-white">{tx.payee}</div>
                        <div className="text-[11px] text-slate-500 italic">{tx.memo || tx.type}</div>
                      </td>
                      <td className={`${cellPad} font-sans text-[11px] text-slate-600 dark:text-slate-400 align-top`}>
                        {tx.offsetAccountName || tx.category || '—'}
                      </td>
                      <td className={`${cellPad} text-center align-top`}>
                        {tx.cleared ? (
                          <CheckSquare className="w-4 h-4 text-emerald-600 mx-auto" />
                        ) : (
                          <Square className="w-4 h-4 text-slate-300 mx-auto" />
                        )}
                      </td>
                      <td className={`${cellPad} text-right font-bold tabular-nums align-top`}>
                        {isDisbursement ? formatCurrency(Math.abs(tx.amount), currency) : ''}
                      </td>
                      <td className={`${cellPad} text-right font-bold tabular-nums text-emerald-600 dark:text-emerald-400 align-top`}>
                        {!isDisbursement ? formatCurrency(tx.amount, currency) : ''}
                      </td>
                      <td className={`${cellPad} text-right font-bold tabular-nums bg-slate-50 dark:bg-slate-850/50 align-top`}>
                        {tx.status === 'posted' ? formatCurrency(tx.runningBalance, currency) : '—'}
                      </td>
                      <td className={`${cellPad} text-right font-sans align-top`} onClick={(e) => e.stopPropagation()}>
                        {resolved.length > 0 && (
                          <TransactionActionMenu
                            label={`Actions for ${refLabel}`}
                            actions={resolved}
                            executionContext={ctx}
                            idempotencyRecordKey={tx.id}
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
        title={detail ? `Bank Transaction ${bankRefLabel(detail)}` : 'Bank Transaction'}
        number={detail?.date}
        typeLabel={detail?.type}
        statusBadge={
          detail ? (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                detail.status === 'posted'
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                  : detail.status === 'voided'
                    ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
              }`}
            >
              {detail.status}
            </span>
          ) : null
        }
        sections={detail ? buildBankSections(detail, currency, onOpenGlAccount) : []}
        actions={
          detail
            ? (() => {
                const ctx = ctxFor(detail);
                const resolved = resolveActions(buildActions(detail), ctx);
                return resolved.length > 0 ? (
                  <TransactionActionMenu
                    label={`Actions for ${bankRefLabel(detail)}`}
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
          label={`Actions for ${bankRefLabel(contextMenu.tx)}`}
          executionContext={contextMenu.ctx}
          idempotencyRecordKey={contextMenu.tx.id}
          notify={notify}
          onExecuteAction={executeFrom(contextMenu.ctx)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

export const BankRegisterTable: React.FC<BankRegisterTableProps> = (props) => (
  <TransactionSelectionProvider>
    <BankRegisterInner {...props} />
  </TransactionSelectionProvider>
);

export const BankingRegisterView: React.FC = () => {
  const { setCurrentView, companyProfile, tableDensity, triggerShortcutNotice } = useAccounting();
  const { activeCompany, hasPermission, authenticated, permissions } = useAuth();
  const currency = companyProfile.currency || 'K';
  const canWrite = hasPermission('banking:write');

  const [bankAccounts, setBankAccounts] = useState<ApiBankAccount[]>([]);
  const [selectedGlAccountId, setSelectedGlAccountId] = useState<number>(0);
  const [transactions, setTransactions] = useState<ApiBankTransaction[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<ApiAccount[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [clearedFilter, setClearedFilter] = useState<'all' | 'cleared' | 'uncleared' | 'pending_import'>('all');

  // Pending feed categorization state per row
  const [catSelection, setCatSelection] = useState<Record<number, number>>({});

  // Modals: Check/Expense, Deposit, Transfer, Import, Rules
  const [modalKind, setModalKind] = useState<'expense' | 'deposit' | 'transfer' | 'import' | 'rules' | null>(null);

  // Expense / Check form
  const [expType, setExpType] = useState<'Check' | 'Debit' | 'Credit Card Charge' | 'Fee'>('Check');
  const [expPayee, setExpPayee] = useState('');
  const [expVendorId, setExpVendorId] = useState('');
  const [expOffsetAcctId, setExpOffsetAcctId] = useState<number>(0);
  const [expAmount, setExpAmount] = useState('0');
  const [expCheckNum, setExpCheckNum] = useState('');
  const [expPrintLater, setExpPrintLater] = useState(false);
  const [expDate, setExpDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expMemo, setExpMemo] = useState('');

  // Deposit form
  const [depFrom, setDepFrom] = useState('');
  const [depSourceAcctId, setDepSourceAcctId] = useState<number>(0);
  const [depAmount, setDepAmount] = useState('0');
  const [depDate, setDepDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [depMemo, setDepMemo] = useState('');

  // Transfer form
  const [xferToAcctId, setXferToAcctId] = useState<number>(0);
  const [xferAmount, setXferAmount] = useState('0');
  const [xferDate, setXferDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [xferMemo, setXferMemo] = useState('');

  // Import CSV/OFX form
  const [importText, setImportText] = useState(
    'date,payee,amount,memo,fitid\n2026-11-12,ZESCO Power Utility,-850.00,Monthly electricity,FIT-ZESCO-101\n2026-11-12,St. Mary School Deposit,4200.00,Invoice settlement,FIT-STMAY-102'
  );
  const [importAutoApply, setImportAutoApply] = useState(true);

  // Rule form
  const [ruleName, setRuleName] = useState('');
  const [ruleField, setRuleField] = useState<'payee' | 'memo' | 'amount'>('payee');
  const [rulePattern, setRulePattern] = useState('');
  const [ruleTargetAcctId, setRuleTargetAcctId] = useState<number>(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [baList, ruleList, acctList, vList] = await Promise.all([
        commercialApi.listBankAccounts(),
        commercialApi.listBankRules(),
        accountingApi.listAccounts(),
        commercialApi.listVendors(),
      ]);
      setBankAccounts(baList);
      setRules(ruleList);
      setAccounts(acctList);
      setVendors(vList);

      const activeGl = selectedGlAccountId && baList.some(b => b.glAccountId === selectedGlAccountId)
        ? selectedGlAccountId
        : baList[0]?.glAccountId || 0;
      if (activeGl !== selectedGlAccountId) {
        setSelectedGlAccountId(activeGl);
      }
      if (activeGl) {
        const txns = await commercialApi.listBankTransactions({ accountId: activeGl });
        setTransactions(txns);
      } else {
        setTransactions([]);
      }

      const expAcct = acctList.find(a => a.account_type === 'Expense' && a.is_active);
      const revAcct = acctList.find(a => a.account_type === 'Income' && a.is_active);
      if (expAcct && !expOffsetAcctId) {
        setExpOffsetAcctId(expAcct.id);
        setRuleTargetAcctId(expAcct.id);
      }
      if (revAcct && !depSourceAcctId) {
        setDepSourceAcctId(revAcct.id);
      }
      const otherBank = baList.find(b => b.glAccountId !== activeGl);
      if (otherBank && !xferToAcctId) {
        setXferToAcctId(otherBank.glAccountId);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to load bank register');
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id, selectedGlAccountId, expOffsetAcctId, depSourceAcctId, xferToAcctId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const handler = () => loadData();
    window.addEventListener(ACCOUNTING_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ACCOUNTING_UPDATED_EVENT, handler);
  }, [loadData]);

  const pendingFeedItems = transactions.filter(t => t.status === 'pending_import');
  const printQueueChecks = transactions.filter(t => t.status === 'posted' && t.printLater && !t.printedAt);

  const visibleTxs = transactions.filter(tx => {
    if (clearedFilter === 'cleared' && !tx.cleared) return false;
    if (clearedFilter === 'uncleared' && (tx.cleared || tx.status === 'pending_import')) return false;
    if (clearedFilter === 'pending_import' && tx.status !== 'pending_import') return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      tx.payee.toLowerCase().includes(q) ||
      tx.memo.toLowerCase().includes(q) ||
      tx.refNumber.toLowerCase().includes(q) ||
      tx.category.toLowerCase().includes(q)
    );
  });

  const handleExpenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.recordExpenseOrCheck({
        bankGlAccountId: selectedGlAccountId,
        txnDate: expDate,
        payee: expPayee,
        txnType: expType,
        vendorId: expVendorId ? Number(expVendorId) : undefined,
        checkNumber: expCheckNum.trim() || undefined,
        printLater: expPrintLater,
        memo: expMemo || undefined,
        lines: [{ accountId: expOffsetAcctId, amount: expAmount, memo: expMemo || undefined }],
      });
      triggerShortcutNotice(`Posted ${expType} for ${expPayee} to GL`);
      setModalKind(null);
      setExpPayee('');
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to record check/expense');
    } finally {
      setBusy(false);
    }
  };

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.recordDeposit({
        bankGlAccountId: selectedGlAccountId,
        txnDate: depDate,
        receivedFrom: depFrom || 'Cash / Customer Deposit',
        memo: depMemo || undefined,
        lines: [{ accountId: depSourceAcctId, amount: depAmount, memo: depMemo || undefined }],
      });
      triggerShortcutNotice(`Recorded Bank Deposit to GL`);
      setModalKind(null);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to record deposit');
    } finally {
      setBusy(false);
    }
  };

  const handleTransferSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.recordTransfer({
        fromAccountId: selectedGlAccountId,
        toAccountId: xferToAcctId,
        amount: xferAmount,
        txnDate: xferDate,
        memo: xferMemo || undefined,
      });
      triggerShortcutNotice('Funds transfer posted to GL');
      setModalKind(null);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Transfer failed');
    } finally {
      setBusy(false);
    }
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await commercialApi.importBankStatement({
        bankGlAccountId: selectedGlAccountId,
        rawText: importText,
        autoApplyRules: importAutoApply,
      });
      triggerShortcutNotice(
        `Imported ${res.importedCount} transaction(s), skipped ${res.skippedDuplicates} duplicate(s), auto-posted ${res.autoPostedCount}`
      );
      setModalKind(null);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      await commercialApi.createBankRule({
        name: ruleName,
        matchField: ruleField,
        matchPattern: rulePattern,
        targetAccountId: ruleTargetAcctId,
      });
      setRuleName('');
      setRulePattern('');
      triggerShortcutNotice('Created bank categorization rule');
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Rule creation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell>
      <PageHeader
        title="Cash, Banking & Check Register"
        subtitle="Live PostgreSQL bank & credit card registers with double-entry GL posting, CSV/OFX imports, banking rules & check print queue."
        icon={<CreditCard className="w-5 h-5" strokeWidth={1.75} />}
        actions={
          <>
            {canWrite && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setModalKind('rules')}
                  icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
                >
                  Rules ({rules.length})
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setModalKind('import')}
                  icon={<Upload className="w-3.5 h-3.5" />}
                >
                  Import CSV/OFX
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setModalKind('transfer')}
                  icon={<ArrowLeftRight className="w-3.5 h-3.5" />}
                >
                  Transfer
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setModalKind('deposit')}
                  icon={<Plus className="w-3.5 h-3.5" />}
                >
                  Deposit
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setModalKind('expense')}
                  icon={<CreditCard className="w-3.5 h-3.5" />}
                >
                  Write Check / Expense
                </Button>
              </>
            )}
            <Button
              variant="emerald"
              size="sm"
              onClick={() => setCurrentView('reconciliation')}
              icon={<Scale className="w-3.5 h-3.5" />}
            >
              Reconcile
            </Button>
          </>
        }
      />

      {errorMsg && (
        <InlineAlert tone="error" onDismiss={() => setErrorMsg(null)}>
          {errorMsg}
        </InlineAlert>
      )}

      {/* Bank & Credit Card Account Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {bankAccounts.map(b => {
          const isSelected = b.glAccountId === selectedGlAccountId;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => setSelectedGlAccountId(b.glAccountId)}
              className={`surface p-4 text-left transition-all ${
                isSelected
                  ? 'border-brand-600 bg-brand-50/50 dark:border-brand-500 dark:bg-brand-500/10 ring-1 ring-brand-600/40'
                  : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {b.accountCode} · {b.institutionName}
                </span>
                {b.pendingImportCount > 0 && (
                  <StatusBadge tone="warning">
                    {b.pendingImportCount} Pending Review
                  </StatusBadge>
                )}
              </div>
              <div className="font-semibold text-sm text-slate-900 dark:text-white mt-1">{b.accountName}</div>
              <div className="font-mono text-lg font-bold text-slate-900 dark:text-slate-100 mt-2 tabular-nums">
                {formatCurrency(b.glBalance, currency)}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">Next Check #: {b.nextCheckNumber}</div>
            </button>
          );
        })}
      </div>

      {/* Print Checks Queue Banner */}
      {canWrite && printQueueChecks.length > 0 && (
        <InlineAlert
          tone="info"
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                await commercialApi.markChecksPrinted(printQueueChecks.map(c => c.id));
                triggerShortcutNotice(`Marked ${printQueueChecks.length} check(s) as printed`);
                await loadData();
              }}
            >
              Mark Queue Printed
            </Button>
          }
        >
          <span className="inline-flex items-center gap-2 font-semibold">
            <Printer className="w-4 h-4 shrink-0" />
            <span>{printQueueChecks.length} check(s) queued for printing ({printQueueChecks.map(c => c.checkNumber || c.refNumber).join(', ')})</span>
          </span>
        </InlineAlert>
      )}

      {/* Pending Imported Feed Items Review */}
      {canWrite && pendingFeedItems.length > 0 && (
        <div className="surface border-amber-300 dark:border-amber-500/30 overflow-hidden">
          <div className="surface-header bg-amber-50/80 dark:bg-amber-500/10 text-xs font-semibold text-amber-900 dark:text-amber-200">
            Imported Bank Feed — For Review ({pendingFeedItems.length})
          </div>
          <div className="divide-y divide-slate-200 dark:divide-white/[0.06] text-xs">
            {pendingFeedItems.map(item => {
              const targetAcct = catSelection[item.id] ?? item.offsetAccountId ?? expOffsetAcctId;
              return (
                <div key={item.id} className="p-3.5 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-white">{item.payee}</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">{item.date} · {item.memo || 'Imported feed item'}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`font-mono font-bold tabular-nums ${item.amount >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                      {formatCurrency(item.amount, currency)}
                    </span>
                    <select
                      value={targetAcct}
                      onChange={e => setCatSelection(prev => ({ ...prev, [item.id]: Number(e.target.value) }))}
                      className="app-input !w-auto !py-1.5 text-xs"
                    >
                      {accounts.filter(a => a.is_active).map(a => (
                        <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                      ))}
                    </select>
                    <Button
                      variant="emerald"
                      size="sm"
                      onClick={async () => {
                        try {
                          await commercialApi.categorizeFeedTxn(item.id, { offsetAccountId: targetAcct });
                          triggerShortcutNotice(`Categorized & posted ${item.payee} to GL`);
                          await loadData();
                        } catch (err: any) {
                          setErrorMsg(err?.message);
                        }
                      }}
                    >
                      Add to Register
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Search and Filters */}
      <div className="surface p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search payee, check #, category..."
              className="app-input !pl-9 text-xs"
            />
          </div>
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100/80 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.08] rounded-lg text-xs font-medium">
            {(['all', 'cleared', 'uncleared', 'pending_import'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => setClearedFilter(mode)}
                className={`px-2.5 py-1 rounded-md capitalize whitespace-nowrap shrink-0 transition-colors ${
                  clearedFilter === mode
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-semibold shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {mode === 'pending_import' ? 'Pending Feed' : mode}
              </button>
            ))}
          </div>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">{visibleTxs.length} of {transactions.length} Transactions</div>
      </div>

      {/* Register Table */}
      {loading ? (
        <div className="surface px-4 py-10 text-center font-sans text-slate-500 dark:text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
          Loading register...
        </div>
      ) : (
        <BankRegisterTable
          transactions={visibleTxs}
          allTransactions={transactions}
          currency={currency}
          tableDensity={tableDensity}
          authenticated={authenticated}
          permissions={permissions}
          role={activeCompany?.role || null}
          companyId={activeCompany?.id ?? null}
          canWrite={canWrite}
          onSelectBankAccount={(gl) => setSelectedGlAccountId(gl)}
          onOpenGlAccount={() => setCurrentView('chart-of-accounts')}
          reload={loadData}
          notify={(m, t) => triggerShortcutNotice(m, t)}
        />
      )}

      {/* EXPENSE / CHECK MODAL */}
      <ModalShell open={modalKind === 'expense'} onClose={() => setModalKind(null)} size="lg">
        <ModalHeader
          title="Record Check, Expense, or Card Charge"
          icon={<CreditCard className="w-4 h-4" strokeWidth={1.75} />}
          tone="brand"
          onClose={() => setModalKind(null)}
        />
        <form id="bank-expense-form" onSubmit={handleExpenseSubmit}>
          <ModalBody>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <FormField label="Type">
                <select value={expType} onChange={e => setExpType(e.target.value as any)} className="app-input">
                  <option value="Check">Check</option>
                  <option value="Debit">Expense / Debit</option>
                  <option value="Credit Card Charge">Credit Card Charge</option>
                  <option value="Fee">Bank Fee</option>
                </select>
              </FormField>
              <FormField label="Date">
                <input type="date" value={expDate} onChange={e => setExpDate(e.target.value)} className="app-input app-input-mono" />
              </FormField>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <FormField label="Payee" required>
                <input type="text" value={expPayee} onChange={e => setExpPayee(e.target.value)} placeholder="Payee name" className="app-input" required />
              </FormField>
              <FormField label="Vendor (Optional)">
                <select
                  value={expVendorId}
                  onChange={e => {
                    setExpVendorId(e.target.value);
                    const v = vendors.find(x => String(x.id) === e.target.value);
                    if (v && !expPayee) setExpPayee(v.companyName);
                  }}
                  className="app-input"
                >
                  <option value="">Non-vendor payee</option>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.companyName}</option>)}
                </select>
              </FormField>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <FormField label="Expense / Asset Account">
                <select value={expOffsetAcctId} onChange={e => setExpOffsetAcctId(Number(e.target.value))} className="app-input">
                  {accounts.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                </select>
              </FormField>
              <FormField label="Amount" required>
                <input type="number" step="0.01" value={expAmount} onChange={e => setExpAmount(e.target.value)} className="app-input app-input-mono font-bold" required />
              </FormField>
            </div>
            {expType === 'Check' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center text-xs">
                <FormField label="Check # (Auto if blank)">
                  <input type="text" value={expCheckNum} onChange={e => setExpCheckNum(e.target.value)} className="app-input app-input-mono" />
                </FormField>
                <label className="inline-flex items-center gap-2 pt-5 cursor-pointer text-slate-700 dark:text-slate-200">
                  <input type="checkbox" checked={expPrintLater} onChange={e => setExpPrintLater(e.target.checked)} />
                  <span>Queue check for printing</span>
                </label>
              </div>
            )}
            <FormField label="Memo">
              <input type="text" value={expMemo} onChange={e => setExpMemo(e.target.value)} className="app-input" />
            </FormField>
          </ModalBody>
          <ModalFooter
            onCancel={() => setModalKind(null)}
            form="bank-expense-form"
            submitLabel="Post to GL"
            busy={busy}
            tone="brand"
          />
        </form>
      </ModalShell>

      {/* DEPOSIT MODAL */}
      <ModalShell open={modalKind === 'deposit'} onClose={() => setModalKind(null)} size="md">
        <ModalHeader
          title="Record Bank Deposit"
          icon={<Plus className="w-4 h-4" strokeWidth={1.75} />}
          tone="emerald"
          onClose={() => setModalKind(null)}
        />
        <form id="bank-deposit-form" onSubmit={handleDepositSubmit}>
          <ModalBody>
            <FormField label="Received From" required>
              <input type="text" value={depFrom} onChange={e => setDepFrom(e.target.value)} placeholder="Customer / Owner / Source" className="app-input" required />
            </FormField>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <FormField label="Date">
                <input type="date" value={depDate} onChange={e => setDepDate(e.target.value)} className="app-input app-input-mono" />
              </FormField>
              <FormField label="Amount" required>
                <input type="number" step="0.01" value={depAmount} onChange={e => setDepAmount(e.target.value)} className="app-input app-input-mono font-bold" required />
              </FormField>
            </div>
            <FormField label="From Account (Credit GL Account)">
              <select value={depSourceAcctId} onChange={e => setDepSourceAcctId(Number(e.target.value))} className="app-input">
                {accounts.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
              </select>
            </FormField>
            <FormField label="Memo">
              <input type="text" value={depMemo} onChange={e => setDepMemo(e.target.value)} className="app-input" />
            </FormField>
          </ModalBody>
          <ModalFooter
            onCancel={() => setModalKind(null)}
            form="bank-deposit-form"
            submitLabel="Record Deposit"
            busy={busy}
            tone="emerald"
          />
        </form>
      </ModalShell>

      {/* TRANSFER MODAL */}
      <ModalShell open={modalKind === 'transfer'} onClose={() => setModalKind(null)} size="md">
        <ModalHeader
          title="Transfer Funds Between Accounts"
          icon={<ArrowLeftRight className="w-4 h-4" strokeWidth={1.75} />}
          tone="brand"
          onClose={() => setModalKind(null)}
        />
        <form id="bank-transfer-form" onSubmit={handleTransferSubmit}>
          <ModalBody>
            <FormField label="Transfer To Account" required>
              <select value={xferToAcctId} onChange={e => setXferToAcctId(Number(e.target.value))} className="app-input" required>
                {bankAccounts.filter(b => b.glAccountId !== selectedGlAccountId).map(b => (
                  <option key={b.id} value={b.glAccountId}>{b.accountCode} - {b.accountName}</option>
                ))}
              </select>
            </FormField>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <FormField label="Date">
                <input type="date" value={xferDate} onChange={e => setXferDate(e.target.value)} className="app-input app-input-mono" />
              </FormField>
              <FormField label="Amount" required>
                <input type="number" step="0.01" value={xferAmount} onChange={e => setXferAmount(e.target.value)} className="app-input app-input-mono font-bold" required />
              </FormField>
            </div>
            <FormField label="Memo">
              <input type="text" value={xferMemo} onChange={e => setXferMemo(e.target.value)} className="app-input" />
            </FormField>
          </ModalBody>
          <ModalFooter
            onCancel={() => setModalKind(null)}
            form="bank-transfer-form"
            submitLabel="Post Transfer"
            busy={busy}
            disabled={!xferToAcctId}
            tone="brand"
          />
        </form>
      </ModalShell>

      {/* IMPORT CSV/OFX MODAL */}
      <ModalShell open={modalKind === 'import'} onClose={() => setModalKind(null)} size="xl">
        <ModalHeader
          title="Import Bank Statement (CSV or OFX)"
          icon={<Upload className="w-4 h-4" strokeWidth={1.75} />}
          tone="brand"
          onClose={() => setModalKind(null)}
        />
        <form id="bank-import-form" onSubmit={handleImportSubmit}>
          <ModalBody>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Paste CSV (<code className="font-mono">date,payee,amount,memo,fitid</code>) or raw OFX (<code className="font-mono">&lt;OFX&gt;...</code>). Duplicate FITIDs are automatically deduplicated.
            </p>
            <textarea
              rows={7}
              value={importText}
              onChange={e => setImportText(e.target.value)}
              className="app-input app-input-mono text-[11px]"
              required
            />
            <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-slate-700 dark:text-slate-200">
              <input type="checkbox" checked={importAutoApply} onChange={e => setImportAutoApply(e.target.checked)} />
              <span>Automatically post transactions matching Banking Rules</span>
            </label>
          </ModalBody>
          <ModalFooter
            onCancel={() => setModalKind(null)}
            form="bank-import-form"
            submitLabel="Run Import"
            busy={busy}
            tone="brand"
          />
        </form>
      </ModalShell>

      {/* BANKING RULES MODAL */}
      <ModalShell open={modalKind === 'rules'} onClose={() => setModalKind(null)} size="xl">
        <ModalHeader
          title="Auto-Categorization Banking Rules"
          icon={<SlidersHorizontal className="w-4 h-4" strokeWidth={1.75} />}
          tone="brand"
          onClose={() => setModalKind(null)}
        />
        <ModalBody>
          <div className="space-y-4 text-xs">
            <form onSubmit={handleCreateRule} className="surface grid grid-cols-1 sm:grid-cols-4 gap-2 p-3">
              <input type="text" placeholder="Rule Name" value={ruleName} onChange={e => setRuleName(e.target.value)} className="app-input" required />
              <select value={ruleField} onChange={e => setRuleField(e.target.value as any)} className="app-input">
                <option value="payee">Payee contains</option>
                <option value="memo">Memo contains</option>
                <option value="amount">Exact amount</option>
              </select>
              <input type="text" placeholder="Pattern (e.g. ZESCO)" value={rulePattern} onChange={e => setRulePattern(e.target.value)} className="app-input" required />
              <div className="flex gap-1.5">
                <select value={ruleTargetAcctId} onChange={e => setRuleTargetAcctId(Number(e.target.value))} className="app-input">
                  {accounts.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                </select>
                <Button type="submit" variant="primary" size="sm" loading={busy}>Add</Button>
              </div>
            </form>
            <div className="surface divide-y divide-slate-200 dark:divide-white/[0.06] overflow-hidden">
              {rules.length === 0 ? (
                <div className="p-4 text-center text-slate-400">No rules created yet.</div>
              ) : (
                rules.map(r => (
                  <div key={r.id} className="p-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">{r.name}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">When {r.matchField} matches "{r.matchPattern}" → {r.targetAccountName}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await commercialApi.deleteBankRule(r.id);
                        await loadData();
                      }}
                      className="!text-rose-600 hover:!bg-rose-50 dark:hover:!bg-rose-500/15"
                      icon={<Trash2 className="w-4 h-4" />}
                      aria-label={`Delete rule ${r.name}`}
                    >
                      Delete
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </ModalBody>
        <div className="flex shrink-0 items-center justify-end border-t border-slate-200/70 bg-slate-50/60 px-5 py-3.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <Button variant="secondary" onClick={() => setModalKind(null)}>Close</Button>
        </div>
      </ModalShell>
    </PageShell>
  );
};
