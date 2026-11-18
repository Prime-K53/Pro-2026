import React, { useCallback, useEffect, useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { useAuth } from '../../context/AuthContext';
import { ACCOUNTING_UPDATED_EVENT, accountingApi, ApiAccount } from '../../services/accountingApi';
import { ApiBankAccount, ApiBankTransaction, commercialApi } from '../../services/commercialApi';
import { formatCurrency } from '../../utils/currency';
import { AdvancedActionsMenu } from '../actions/AdvancedActionsMenu';
import { resolveActions } from '../../actions/evaluateActions';
import type { ActionEligibilityContext, AdvancedActionDefinition } from '../../actions/types';
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
  X,
  AlertTriangle,
  Loader2,
  Trash2,
} from 'lucide-react';

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

  const buildTxActionContext = (tx: ApiBankTransaction, pendingId?: string | null): ActionEligibilityContext<ApiBankTransaction> => ({
    authenticated,
    permissions,
    role: activeCompany?.role || null,
    companyId: activeCompany?.id ?? null,
    moduleKey: 'banking',
    entityType: 'bank_transaction',
    record: tx,
    recordStatus: tx.status,
    pendingActionIds: pendingId ? [pendingId] : [],
  });

  const buildTxActionDefinitions = (tx: ApiBankTransaction, refLabel: string): AdvancedActionDefinition<ApiBankTransaction>[] => {
    const defs: AdvancedActionDefinition<ApiBankTransaction>[] = [];
    if (canWrite && tx.status === 'posted' && !tx.reconciliationId) {
      defs.push({
        id: 'tx.toggle-cleared',
        label: tx.cleared ? 'Mark Uncleared' : 'Mark Cleared',
        icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />,
        group: 'process',
        groupLabel: 'Reconciliation',
        requiredPermission: 'banking:write',
        execute: async () => {
          await commercialApi.toggleCleared(tx.id, !tx.cleared);
          await loadData();
        },
      });
      defs.push({
        id: 'tx.void',
        label: 'Void Transaction (Reverse GL)',
        icon: <Ban className="w-3.5 h-3.5 text-rose-600" />,
        group: 'danger',
        groupLabel: 'Sensitive operations',
        destructive: true,
        risk: 'destructive',
        requiredPermission: 'banking:write',
        confirmation: { title: `Void ${refLabel}`, message: 'Void this bank transaction and reverse its GL impact?', confirmLabel: 'Void', destructive: true },
        execute: async () => {
          await commercialApi.voidBankTransaction(tx.id, 'Voided in register');
          triggerShortcutNotice(`Voided ${refLabel} & reversed GL`);
          await loadData();
        },
      });
    }
    defs.push({
      id: 'tx.copy-ref',
      label: 'Copy Ref #',
      icon: <Copy className="w-3.5 h-3.5" />,
      group: 'admin',
      groupLabel: 'Other',
      requiredPermission: 'banking:read',
      execute: async () => {
        await navigator.clipboard?.writeText(refLabel);
        triggerShortcutNotice(`Copied ${refLabel}`);
      },
    });
    return defs;
  };

  const renderTxActions = (tx: ApiBankTransaction, refLabel: string) => {
    const defs = buildTxActionDefinitions(tx, refLabel);
    const ctx = buildTxActionContext(tx, null);
    const resolved = resolveActions(defs, ctx);
    if (resolved.length === 0) return null;
    return (
      <AdvancedActionsMenu<ApiBankTransaction>
        label={`Actions for ${refLabel}`}
        actions={resolved}
        executionContext={ctx}
        idempotencyRecordKey={tx.id}
        notify={(msg, tone) => triggerShortcutNotice(msg, tone)}
        onExecuteAction={async (action) => {
          const def = action.definition;
          if (typeof def.execute === 'function') {
            await def.execute(ctx, { notify: (m, t) => triggerShortcutNotice(m, t) });
          }
        }}
      />
    );
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            Cash, Banking & Check Register
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Live PostgreSQL bank & credit card registers with double-entry GL posting, CSV/OFX imports, banking rules & check print queue.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canWrite && (
            <>
              <button
                onClick={() => setModalKind('rules')}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" /> Rules ({rules.length})
              </button>
              <button
                onClick={() => setModalKind('import')}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold"
              >
                <Upload className="w-3.5 h-3.5" /> Import CSV/OFX
              </button>
              <button
                onClick={() => setModalKind('transfer')}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold"
              >
                <ArrowLeftRight className="w-3.5 h-3.5" /> Transfer
              </button>
              <button
                onClick={() => setModalKind('deposit')}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 text-xs font-semibold"
              >
                <Plus className="w-3.5 h-3.5" /> Deposit
              </button>
              <button
                onClick={() => setModalKind('expense')}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-sm"
              >
                <CreditCard className="w-4 h-4" /> Write Check / Expense
              </button>
            </>
          )}
          <button
            onClick={() => setCurrentView('reconciliation')}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-sm"
          >
            <Scale className="w-4 h-4" /> Reconcile
          </button>
        </div>
      </div>

      {errorMsg && (
        <div role="alert" className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 text-rose-800 dark:text-rose-200 text-xs flex items-center justify-between">
          <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="underline">Dismiss</button>
        </div>
      )}

      {/* Bank & Credit Card Account Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {bankAccounts.map(b => {
          const isSelected = b.glAccountId === selectedGlAccountId;
          return (
            <button
              key={b.id}
              onClick={() => setSelectedGlAccountId(b.glAccountId)}
              className={`p-4 rounded-xl text-left border transition-all ${
                isSelected
                  ? 'border-blue-600 bg-blue-50/60 dark:bg-blue-950/40 shadow-xs ring-1 ring-blue-500'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-bold text-slate-500">
                  {b.accountCode} · {b.institutionName}
                </span>
                {b.pendingImportCount > 0 && (
                  <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">
                    {b.pendingImportCount} Pending Review
                  </span>
                )}
              </div>
              <div className="font-bold text-sm text-slate-900 dark:text-white mt-1">{b.accountName}</div>
              <div className="font-mono text-lg font-bold text-slate-900 dark:text-slate-100 mt-2 tabular-nums">
                {formatCurrency(b.glBalance, currency)}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Next Check #: {b.nextCheckNumber}</div>
            </button>
          );
        })}
      </div>

      {/* Print Checks Queue Banner */}
      {canWrite && printQueueChecks.length > 0 && (
        <div className="p-3 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 font-semibold text-blue-900 dark:text-blue-200">
            <Printer className="w-4 h-4" />
            <span>{printQueueChecks.length} check(s) queued for printing ({printQueueChecks.map(c => c.checkNumber || c.refNumber).join(', ')})</span>
          </div>
          <button
            onClick={async () => {
              await commercialApi.markChecksPrinted(printQueueChecks.map(c => c.id));
              triggerShortcutNotice(`Marked ${printQueueChecks.length} check(s) as printed`);
              await loadData();
            }}
            className="px-3 py-1.5 rounded bg-blue-600 text-white font-bold text-xs"
          >
            Mark Queue Printed
          </button>
        </div>
      )}

      {/* Pending Imported Feed Items Review */}
      {canWrite && pendingFeedItems.length > 0 && (
        <div className="bg-amber-50/70 dark:bg-amber-950/20 rounded-xl border border-amber-300 dark:border-amber-800 overflow-hidden">
          <div className="px-4 py-2.5 bg-amber-100/70 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 text-xs font-bold text-amber-900 dark:text-amber-200">
            Imported Bank Feed — For Review ({pendingFeedItems.length})
          </div>
          <div className="divide-y divide-amber-200/70 dark:divide-amber-900/50 text-xs">
            {pendingFeedItems.map(item => {
              const targetAcct = catSelection[item.id] ?? item.offsetAccountId ?? expOffsetAcctId;
              return (
                <div key={item.id} className="p-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-slate-900 dark:text-white">{item.payee}</div>
                    <div className="text-[11px] text-slate-500 font-mono">{item.date} · {item.memo || 'Imported feed item'}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono font-bold tabular-nums ${item.amount >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {formatCurrency(item.amount, currency)}
                    </span>
                    <select
                      value={targetAcct}
                      onChange={e => setCatSelection(prev => ({ ...prev, [item.id]: Number(e.target.value) }))}
                      className="border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs bg-white dark:bg-slate-950"
                    >
                      {accounts.filter(a => a.is_active).map(a => (
                        <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={async () => {
                        try {
                          await commercialApi.categorizeFeedTxn(item.id, { offsetAccountId: targetAcct });
                          triggerShortcutNotice(`Categorized & posted ${item.payee} to GL`);
                          await loadData();
                        } catch (err: any) {
                          setErrorMsg(err?.message);
                        }
                      }}
                      className="px-3 py-1 rounded bg-emerald-600 text-white font-bold text-xs"
                    >
                      Add to Register
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Search and Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search payee, check #, category..."
              className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-850 text-xs outline-none"
            />
          </div>
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-medium">
            {(['all', 'cleared', 'uncleared', 'pending_import'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setClearedFilter(mode)}
                className={`px-2.5 py-1 rounded-md capitalize transition-colors ${
                  clearedFilter === mode ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-semibold shadow-xs' : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {mode === 'pending_import' ? 'Pending Feed' : mode}
              </button>
            ))}
          </div>
        </div>
        <div className="text-xs text-slate-500 font-mono tabular-nums">{visibleTxs.length} of {transactions.length} Transactions</div>
      </div>

      {/* Register Table */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-[#0f3d63] text-white uppercase tracking-wider font-bold text-[10px]">
              <tr>
                <th className="px-3 py-2.5 w-24">DATE</th>
                <th className="px-3 py-2.5 w-28">REF / CHK #</th>
                <th className="px-3 py-2.5">PAYEE / MEMO</th>
                <th className="px-3 py-2.5 w-40">CATEGORY / OFFSET</th>
                <th className="px-3 py-2.5 w-16 text-center">CLR</th>
                <th className="px-3 py-2.5 w-28 text-right">PAYMENT (-)</th>
                <th className="px-3 py-2.5 w-28 text-right">DEPOSIT (+)</th>
                <th className="px-3 py-2.5 w-32 text-right">RUNNING BAL</th>
                <th className="px-3 py-2.5 w-16 text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono text-xs">
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-10 text-center font-sans text-slate-400"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading register...</td></tr>
              ) : visibleTxs.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-10 text-center font-sans text-slate-400">No bank register entries match your filter.</td></tr>
              ) : (
                visibleTxs.map(tx => {
                  const isDisbursement = tx.amount < 0;
                  const cellPad = tableDensity === 'compact' ? 'px-3 py-2' : 'px-3 py-3';
                  const refLabel = tx.checkNumber || tx.refNumber || tx.type;
                  return (
                    <tr key={tx.id} className={`hover:bg-blue-50/50 dark:hover:bg-slate-850 ${tx.status === 'voided' ? 'opacity-50 line-through' : ''}`}>
                      <td className={`${cellPad} text-slate-600 dark:text-slate-400 whitespace-nowrap`}>{tx.date}</td>
                      <td className={`${cellPad} font-bold whitespace-nowrap`}>
                        {refLabel}
                        {tx.reconciliationId && <span className="ml-1 text-[10px] text-emerald-600" title="Reconciled">[R]</span>}
                      </td>
                      <td className={`${cellPad} font-sans`}>
                        <div className="font-semibold text-slate-900 dark:text-white">{tx.payee}</div>
                        <div className="text-[11px] text-slate-500 italic">{tx.memo || tx.type}</div>
                      </td>
                      <td className={`${cellPad} font-sans text-[11px] text-slate-600 dark:text-slate-400`}>
                        {tx.offsetAccountName || tx.category || '—'}
                      </td>
                      <td className={`${cellPad} text-center`}>
                        <button
                          disabled={!canWrite || tx.status !== 'posted' || Boolean(tx.reconciliationId)}
                          onClick={async () => {
                            try {
                              await commercialApi.toggleCleared(tx.id, !tx.cleared);
                              await loadData();
                            } catch (err: any) {
                              setErrorMsg(err?.message);
                            }
                          }}
                          className="cursor-pointer disabled:opacity-40"
                        >
                          {tx.cleared ? <CheckSquare className="w-4 h-4 text-emerald-600 mx-auto" /> : <Square className="w-4 h-4 text-slate-300 mx-auto" />}
                        </button>
                      </td>
                      <td className={`${cellPad} text-right font-bold tabular-nums`}>
                        {isDisbursement ? formatCurrency(Math.abs(tx.amount), currency) : ''}
                      </td>
                      <td className={`${cellPad} text-right font-bold tabular-nums text-emerald-600 dark:text-emerald-400`}>
                        {!isDisbursement ? formatCurrency(tx.amount, currency) : ''}
                      </td>
                      <td className={`${cellPad} text-right font-bold tabular-nums bg-slate-50 dark:bg-slate-850/50`}>
                        {tx.status === 'posted' ? formatCurrency(tx.runningBalance, currency) : '—'}
                      </td>
                      <td className={`${cellPad} text-right font-sans`}>
                        {renderTxActions(tx, refLabel)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* EXPENSE / CHECK MODAL */}
      {modalKind === 'expense' && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-xl shadow-2xl border overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Record Check, Expense, or Card Charge</span>
              <button onClick={() => setModalKind(null)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleExpenseSubmit} className="p-5 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Type</label>
                  <select value={expType} onChange={e => setExpType(e.target.value as any)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    <option value="Check">Check</option>
                    <option value="Debit">Expense / Debit</option>
                    <option value="Credit Card Charge">Credit Card Charge</option>
                    <option value="Fee">Bank Fee</option>
                  </select>
                </div>
                <div>
                  <label className="font-semibold block mb-1">Date</label>
                  <input type="date" value={expDate} onChange={e => setExpDate(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Payee *</label>
                  <input type="text" value={expPayee} onChange={e => setExpPayee(e.target.value)} placeholder="Payee name" className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950" required />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Vendor (Optional)</label>
                  <select
                    value={expVendorId}
                    onChange={e => {
                      setExpVendorId(e.target.value);
                      const v = vendors.find(x => String(x.id) === e.target.value);
                      if (v && !expPayee) setExpPayee(v.companyName);
                    }}
                    className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950"
                  >
                    <option value="">Non-vendor payee</option>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.companyName}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold block mb-1">Expense / Asset Account</label>
                  <select value={expOffsetAcctId} onChange={e => setExpOffsetAcctId(Number(e.target.value))} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                    {accounts.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="font-semibold block mb-1">Amount</label>
                  <input type="number" step="0.01" value={expAmount} onChange={e => setExpAmount(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono font-bold" required />
                </div>
              </div>
              {expType === 'Check' && (
                <div className="grid grid-cols-2 gap-3 items-center">
                  <div>
                    <label className="font-semibold block mb-1">Check # (Auto if blank)</label>
                    <input type="text" value={expCheckNum} onChange={e => setExpCheckNum(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" />
                  </div>
                  <label className="inline-flex items-center gap-2 pt-5 cursor-pointer">
                    <input type="checkbox" checked={expPrintLater} onChange={e => setExpPrintLater(e.target.checked)} />
                    <span>Queue check for printing</span>
                  </label>
                </div>
              )}
              <div>
                <label className="font-semibold block mb-1">Memo</label>
                <input type="text" value={expMemo} onChange={e => setExpMemo(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950" />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <button type="button" onClick={() => setModalKind(null)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy} className="px-5 py-2 rounded bg-blue-600 text-white font-bold">Post to GL</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DEPOSIT MODAL */}
      {modalKind === 'deposit' && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Record Bank Deposit</span>
              <button onClick={() => setModalKind(null)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleDepositSubmit} className="p-5 space-y-3 text-xs">
              <div><label className="font-semibold block mb-1">Received From</label><input type="text" value={depFrom} onChange={e => setDepFrom(e.target.value)} placeholder="Customer / Owner / Source" className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950" required /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="font-semibold block mb-1">Date</label><input type="date" value={depDate} onChange={e => setDepDate(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" /></div>
                <div><label className="font-semibold block mb-1">Amount</label><input type="number" step="0.01" value={depAmount} onChange={e => setDepAmount(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono font-bold" required /></div>
              </div>
              <div>
                <label className="font-semibold block mb-1">From Account (Credit GL Account)</label>
                <select value={depSourceAcctId} onChange={e => setDepSourceAcctId(Number(e.target.value))} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950">
                  {accounts.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                </select>
              </div>
              <div><label className="font-semibold block mb-1">Memo</label><input type="text" value={depMemo} onChange={e => setDepMemo(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950" /></div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <button type="button" onClick={() => setModalKind(null)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy} className="px-5 py-2 rounded bg-emerald-600 text-white font-bold">Record Deposit</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TRANSFER MODAL */}
      {modalKind === 'transfer' && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl shadow-2xl border overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Transfer Funds Between Accounts</span>
              <button onClick={() => setModalKind(null)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleTransferSubmit} className="p-5 space-y-3 text-xs">
              <div>
                <label className="font-semibold block mb-1">Transfer To Account</label>
                <select value={xferToAcctId} onChange={e => setXferToAcctId(Number(e.target.value))} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950" required>
                  {bankAccounts.filter(b => b.glAccountId !== selectedGlAccountId).map(b => (
                    <option key={b.id} value={b.glAccountId}>{b.accountCode} - {b.accountName}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="font-semibold block mb-1">Date</label><input type="date" value={xferDate} onChange={e => setXferDate(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono" /></div>
                <div><label className="font-semibold block mb-1">Amount</label><input type="number" step="0.01" value={xferAmount} onChange={e => setXferAmount(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950 font-mono font-bold" required /></div>
              </div>
              <div><label className="font-semibold block mb-1">Memo</label><input type="text" value={xferMemo} onChange={e => setXferMemo(e.target.value)} className="w-full border rounded px-2.5 py-2 bg-white dark:bg-slate-950" /></div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <button type="button" onClick={() => setModalKind(null)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy || !xferToAcctId} className="px-5 py-2 rounded bg-blue-600 text-white font-bold">Post Transfer</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* IMPORT CSV/OFX MODAL */}
      {modalKind === 'import' && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border overflow-hidden">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Import Bank Statement (CSV or OFX)</span>
              <button onClick={() => setModalKind(null)}><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleImportSubmit} className="p-5 space-y-3 text-xs">
              <p className="text-slate-500">Paste CSV (`date,payee,amount,memo,fitid`) or raw OFX (`&lt;OFX&gt;...`). Duplicate FITIDs are automatically deduplicated.</p>
              <textarea
                rows={7}
                value={importText}
                onChange={e => setImportText(e.target.value)}
                className="w-full border rounded p-2.5 font-mono text-[11px] bg-slate-50 dark:bg-slate-950"
                required
              />
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={importAutoApply} onChange={e => setImportAutoApply(e.target.checked)} />
                <span>Automatically post transactions matching Banking Rules</span>
              </label>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <button type="button" onClick={() => setModalKind(null)} className="px-4 py-2 rounded border">Cancel</button>
                <button type="submit" disabled={busy} className="px-5 py-2 rounded bg-blue-600 text-white font-bold">Run Import</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* BANKING RULES MODAL */}
      {modalKind === 'rules' && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-5 py-3 bg-[#0f3d63] text-white flex items-center justify-between">
              <span className="font-bold text-sm">Auto-Categorization Banking Rules</span>
              <button onClick={() => setModalKind(null)}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-4 overflow-y-auto text-xs">
              <form onSubmit={handleCreateRule} className="grid grid-cols-1 sm:grid-cols-4 gap-2 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border">
                <input type="text" placeholder="Rule Name" value={ruleName} onChange={e => setRuleName(e.target.value)} className="border rounded px-2 py-1.5 bg-white dark:bg-slate-950" required />
                <select value={ruleField} onChange={e => setRuleField(e.target.value as any)} className="border rounded px-2 py-1.5 bg-white dark:bg-slate-950">
                  <option value="payee">Payee contains</option>
                  <option value="memo">Memo contains</option>
                  <option value="amount">Exact amount</option>
                </select>
                <input type="text" placeholder="Pattern (e.g. ZESCO)" value={rulePattern} onChange={e => setRulePattern(e.target.value)} className="border rounded px-2 py-1.5 bg-white dark:bg-slate-950" required />
                <div className="flex gap-1">
                  <select value={ruleTargetAcctId} onChange={e => setRuleTargetAcctId(Number(e.target.value))} className="w-full border rounded px-2 py-1.5 bg-white dark:bg-slate-950">
                    {accounts.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                  </select>
                  <button type="submit" disabled={busy} className="px-2.5 py-1.5 rounded bg-blue-600 text-white font-bold shrink-0">Add</button>
                </div>
              </form>
              <div className="divide-y border rounded-lg">
                {rules.length === 0 ? (
                  <div className="p-4 text-center text-slate-400">No rules created yet.</div>
                ) : (
                  rules.map(r => (
                    <div key={r.id} className="p-3 flex items-center justify-between">
                      <div>
                        <div className="font-bold">{r.name}</div>
                        <div className="text-[11px] text-slate-500">When {r.matchField} matches "{r.matchPattern}" → {r.targetAccountName}</div>
                      </div>
                      <button
                        onClick={async () => {
                          await commercialApi.deleteBankRule(r.id);
                          await loadData();
                        }}
                        className="p-1 text-rose-600 hover:bg-rose-50 rounded"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
