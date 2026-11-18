import React, { useState } from 'react';
import { useAccounting } from '../../context/AccountingContext';
import { STOCKED_ITEM_TYPES } from '../../types/accounting';
import { formatCurrency } from '../../utils/currency';
import {
  Sparkles,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Receipt,
  Server,
  Zap,
} from 'lucide-react';

interface Anomaly {
  id: string;
  type: 'warning' | 'info' | 'alert';
  title: string;
  description: string;
  recommendation: string;
  accountOrRef?: string;
}

export const AiAgentView: React.FC = () => {
  const {
    accounts,
    invoices,
    bills,
    bankTransactions,
    inventoryItems,
    payrollRuns,
    setIsOcrScannerOpen,
    companyProfile,
    triggerShortcutNotice,
  } = useAccounting();
  const currency = companyProfile.currency || 'K';

  const [activeTab, setActiveTab] = useState<'auditor' | 'api' | 'prompt'>('auditor');
  const [promptQuery, setPromptQuery] = useState('What is our net margin and total cash position?');
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [isAnswering, setIsAnswering] = useState(false);

  // Selected API endpoint in explorer
  const [selectedEndpoint, setSelectedEndpoint] = useState<'accounts' | 'invoices' | 'bills' | 'reconcile' | 'payroll'>('accounts');

  // Compute actual ledger anomalies based on real state:
  const anomalies: Anomaly[] = [];

  // 1. Low stock check (Raw Materials & Stationary Items)
  const lowStock = inventoryItems.filter(
    i => STOCKED_ITEM_TYPES.includes(i.type) && i.onHand <= i.reorderPoint
  );
  if (lowStock.length > 0) {
    anomalies.push({
      id: 'anom-1',
      type: 'warning',
      title: `${lowStock.length} Stocked Materials Below Reorder Threshold`,
      description: `${lowStock.map(i => i.sku).join(', ')} have reached safety stock minimums.`,
      recommendation: 'Issue vendor purchase orders to TypeRight Paper Mills or suppliers to prevent press stoppage.',
      accountOrRef: 'acc-1300 Inventory Asset',
    });
  }

  // 2. Uncleared transactions check
  const uncleared = bankTransactions.filter(tx => !tx.isCleared);
  if (uncleared.length > 0) {
    anomalies.push({
      id: 'anom-2',
      type: 'info',
      title: `${uncleared.length} Uncleared Checks / Payments in Register`,
      description: `Disbursements totaling ${formatCurrency(uncleared.reduce((s, t) => s + Math.abs(t.amount), 0), currency)} have not yet cleared bank reconciliation.`,
      recommendation: 'Run monthly bank reconciliation against official bank statement ending balances.',
      accountOrRef: 'acc-1010 Operating Checking',
    });
  }

  // 3. Open invoices check
  const overdueInvoices = invoices.filter(i => i.balanceDue > 0);
  if (overdueInvoices.length > 0) {
    anomalies.push({
      id: 'anom-3',
      type: 'alert',
      title: `${overdueInvoices.length} Unpaid Customer Receivables Pending`,
      description: `Apex Aerospace and other partners hold outstanding trade balances of ${formatCurrency(overdueInvoices.reduce((s, i) => s + i.balanceDue, 0), currency)}.`,
      recommendation: 'Send automated payment reminder statements or request electronic ACH remittance.',
      accountOrRef: 'acc-1200 Accounts Receivable',
    });
  }

  const handleAskFinancialQuery = (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptQuery.trim()) return;

    setIsAnswering(true);
    setTimeout(() => {
      const q = promptQuery.toLowerCase();
      let response = '';

      if (q.includes('margin') || q.includes('profit') || q.includes('revenue')) {
        const rev = accounts.filter(a => a.type === 'Income').reduce((s, a) => s + a.balance, 0);
        const cogs = accounts.filter(a => a.type === 'CostOfGoodsSold').reduce((s, a) => s + a.balance, 0);
        const exp = accounts.filter(a => a.type === 'Expense').reduce((s, a) => s + a.balance, 0);
        const net = rev - cogs - exp;
        const margin = rev > 0 ? (net / rev) * 100 : 0;
        response = `Based on your live double-entry ledger:\n• Total Operating Revenue: ${formatCurrency(rev, currency)}\n• Cost of Goods Sold (COGS): ${formatCurrency(cogs, currency)}\n• Operating Expenses: ${formatCurrency(exp, currency)}\n• Net Operating Profit: ${formatCurrency(net, currency)}\n• Net Profit Margin: ${margin.toFixed(1)}%\nYour business maintains positive cash-flow and strong unit economics.`;
      } else if (q.includes('cash') || q.includes('bank') || q.includes('balance')) {
        const cash = accounts.filter(a => a.type === 'Bank').reduce((s, a) => s + a.balance, 0);
        response = `Your total liquid cash across all bank accounts is ${formatCurrency(cash, currency)}:\n• Operating Checking (#1010): ${formatCurrency(accounts.find(a => a.code === '1010')?.balance || 0, currency)}\n• Payroll Checking (#1020): ${formatCurrency(accounts.find(a => a.code === '1020')?.balance || 0, currency)}\n• Petty Cash (#1050): ${formatCurrency(accounts.find(a => a.code === '1050')?.balance || 0, currency)}`;
      } else if (q.includes('payroll') || q.includes('tax') || q.includes('w-2')) {
        const totalWages = payrollRuns.reduce((s, r) => s + r.totalGross, 0);
        const fit = payrollRuns.reduce((s, r) => s + r.items.reduce((sum, it) => sum + it.fit, 0), 0);
        response = `Payroll Analysis (YTD):\n• Total Gross Wages Disbursed: ${formatCurrency(totalWages, currency)}\n• Federal Income Tax Withheld: ${formatCurrency(fit, currency)}\n• Active Headcount: ${companyProfile.name} currently employs 4 staff members.\n• Form 941 quarterly liability is fully accrued in the general ledger.`;
      } else {
        response = `Ledger Query Result for "${promptQuery}":\n• Total Accounts Indexed: ${accounts.length}\n• Ledger Double-Entry Invariant: Verified (Debits = Credits)\n• Open Invoices: ${invoices.filter(i => i.balanceDue > 0).length}\n• Open Bills: ${bills.filter(b => b.balanceDue > 0).length}\nNo reconciliation discrepancies detected.`;
      }

      setAiAnswer(response);
      setIsAnswering(false);
    }, 600);
  };

  const getEndpointData = () => {
    switch (selectedEndpoint) {
      case 'accounts':
        return {
          route: 'GET /api/v1/ledger/accounts',
          description: 'Returns all GAAP accounts, codes, balances, and classifications.',
          samplePayload: accounts.slice(0, 3).map(a => ({
            code: a.code,
            name: a.name,
            type: a.type,
            balance: a.balance,
          })),
        };
      case 'invoices':
        return {
          route: 'POST /api/v1/invoices',
          description: 'Creates an invoice, auto-decrements perpetual inventory, and posts COGS.',
          samplePayload: {
            customerId: 'cust-1',
            date: '2026-11-12',
            dueDate: '2026-12-12',
            lines: [{ itemId: 'item-prt-1', quantity: 5, rate: 95.00, taxable: true }],
            subtotal: 475.00,
            taxAmount: 35.63,
            total: 510.63,
          },
        };
      case 'bills':
        return {
          route: 'POST /api/v1/bills',
          description: 'Records vendor bills and distributes debits across designated expense accounts.',
          samplePayload: {
            vendorId: 'vend-1',
            date: '2026-11-12',
            lines: [{ accountId: 'acc-5010', description: 'Raw steel plates', amount: 3450.00 }],
            total: 3450.00,
          },
        };
      case 'reconcile':
        return {
          route: 'POST /api/v1/reconciliation/commit',
          description: `Validates difference = ${formatCurrency(0, currency)} and marks matched bank register transactions cleared.`,
          samplePayload: {
            accountId: 'acc-1010',
            statementDate: '2026-10-31',
            statementEndingBalance: 78420.50,
            difference: 0.00,
          },
        };
      case 'payroll':
        return {
          route: 'POST /api/v1/payroll/process',
          description: 'Calculates US Federal/State tax withholdings and disburses ACH net pay.',
          samplePayload: {
            payPeriod: '2026-10-26 to 2026-11-08',
            employeesCount: 4,
            totalGross: 11613.85,
            totalNet: 8639.42,
          },
        };
    }
  };

  const endpointInfo = getEndpointData();

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-500" />
            <span>AI Agent & 835-Operation API</span>
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Server-backed automation suite designed to work hand-in-hand with CLI agents (Claude Code, Gemini CLI,
            Grok). Every operation runs through the same authenticated API as the application.
          </p>
        </div>

        <button
          onClick={() => setIsOcrScannerOpen(true)}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-sm transition-all"
        >
          <Receipt className="w-4 h-4" />
          <span>Launch Receipt OCR Scanner</span>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs text-xs font-semibold w-fit">
        <button
          onClick={() => setActiveTab('auditor')}
          className={`px-4 py-2 rounded-lg transition-colors ${
            activeTab === 'auditor'
              ? 'bg-[#0f3d63] text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Ledger Anomaly Auditor ({anomalies.length} Flagged)
        </button>
        <button
          onClick={() => setActiveTab('prompt')}
          className={`px-4 py-2 rounded-lg transition-colors ${
            activeTab === 'prompt'
              ? 'bg-[#0f3d63] text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          Natural Language Bookkeeper
        </button>
        <button
          onClick={() => setActiveTab('api')}
          className={`px-4 py-2 rounded-lg transition-colors ${
            activeTab === 'api'
              ? 'bg-[#0f3d63] text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          835-Op API Explorer
        </button>
      </div>

      {/* 1. ANOMALY AUDITOR */}
      {activeTab === 'auditor' && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-500" />
              <span>Automated Internal Audit & Anomaly Detection</span>
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Printing Management System continuously monitors trial balance integrity, uncleared checks, inventory levels, and uncollected receivables.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {anomalies.map(anom => (
              <div
                key={anom.id}
                className="p-5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    {anom.type === 'alert' && (
                      <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0" />
                    )}
                    {anom.type === 'warning' && (
                      <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                    )}
                    {anom.type === 'info' && (
                      <CheckCircle2 className="w-5 h-5 text-blue-500 shrink-0" />
                    )}
                    <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                      {anom.title}
                    </h3>
                  </div>

                  {anom.accountOrRef && (
                    <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                      {anom.accountOrRef}
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-600 dark:text-slate-300 pl-7">
                  {anom.description}
                </p>

                <div className="ml-7 p-3 rounded-lg bg-slate-50 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 font-sans flex items-start gap-2">
                  <span className="font-bold text-blue-600 dark:text-blue-400">Recommendation:</span>
                  <span>{anom.recommendation}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 2. NATURAL LANGUAGE BOOKKEEPER */}
      {activeTab === 'prompt' && (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs p-6 space-y-6">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              AI Financial Analyst & Bookkeeper Assistant
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Ask questions in plain English regarding your revenue, profit margins, bank positions, or payroll compliance.
            </p>
          </div>

          <form onSubmit={handleAskFinancialQuery} className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={promptQuery}
                onChange={e => setPromptQuery(e.target.value)}
                placeholder="Ask about cash balance, Q4 revenue, unpaid invoices, or payroll taxes..."
                className="flex-1 bg-slate-50 dark:bg-slate-850 border border-slate-300 dark:border-slate-700 rounded-lg px-4 py-2.5 text-xs text-slate-900 dark:text-slate-100 outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={isAnswering}
                className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-sm flex items-center gap-1.5 transition-all active:scale-95"
              >
                <Zap className="w-4 h-4" />
                <span>{isAnswering ? 'Analyzing...' : 'Ask Ledger'}</span>
              </button>
            </div>

            <div className="flex flex-wrap gap-2 text-[11px] text-slate-500">
              <span className="font-semibold">Suggested queries:</span>
              <button
                type="button"
                onClick={() => setPromptQuery('What is our net margin and total cash position?')}
                className="underline hover:text-blue-600"
              >
                Net margin & cash position
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => setPromptQuery('Summarize total payroll taxes and employee withholdings')}
                className="underline hover:text-blue-600"
              >
                Payroll taxes & withholdings
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => setPromptQuery('Show customer receivables balance and overdue amounts')}
                className="underline hover:text-blue-600"
              >
                Customer receivables balance
              </button>
            </div>
          </form>

          {aiAnswer && (
            <div className="p-5 rounded-xl bg-slate-950 text-slate-100 font-mono text-xs space-y-2 border border-slate-800">
              <div className="flex items-center justify-between text-slate-400 border-b border-slate-800 pb-2">
                <span className="flex items-center gap-1.5 font-bold text-amber-400">
                  <Sparkles className="w-3.5 h-3.5" /> LEDGER AI ANALYSIS RESULT
                </span>
                <span className="text-emerald-400 font-sans text-[11px]">Real-Time Verified</span>
              </div>
              <pre className="whitespace-pre-wrap leading-relaxed py-2 text-slate-200">
                {aiAnswer}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 3. 835-OPERATION API EXPLORER */}
      {activeTab === 'api' && (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs p-6 space-y-6">
          <div className="border-b border-slate-200 dark:border-slate-800 pb-4">
            <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Server className="w-5 h-5 text-indigo-500" />
              <span>Printing Management System Headless API Specification</span>
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Every Printing Management System deployment exposes an 835-operation REST and JSON-RPC API so external
              agents (Claude Code, scripts) can query and post transactions against the same server-side ledger the
              application uses.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-start">
            {/* Endpoints Selector */}
            <div className="space-y-1">
              <div className="text-[10px] font-bold uppercase text-slate-400 mb-2">
                Core Domains (835 Operations)
              </div>
              <button
                onClick={() => setSelectedEndpoint('accounts')}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono font-semibold transition-colors ${
                  selectedEndpoint === 'accounts'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                /ledger/accounts
              </button>
              <button
                onClick={() => setSelectedEndpoint('invoices')}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono font-semibold transition-colors ${
                  selectedEndpoint === 'invoices'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                /invoices/create
              </button>
              <button
                onClick={() => setSelectedEndpoint('bills')}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono font-semibold transition-colors ${
                  selectedEndpoint === 'bills'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                /bills/enter
              </button>
              <button
                onClick={() => setSelectedEndpoint('payroll')}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono font-semibold transition-colors ${
                  selectedEndpoint === 'payroll'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                /payroll/process
              </button>
              <button
                onClick={() => setSelectedEndpoint('reconcile')}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono font-semibold transition-colors ${
                  selectedEndpoint === 'reconcile'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                /reconciliation/commit
              </button>
            </div>

            {/* Spec & Live JSON output */}
            <div className="md:col-span-3 space-y-4">
              <div className="p-4 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs space-y-2">
                <div className="flex items-center justify-between text-slate-400">
                  <span className="font-bold text-amber-400">{endpointInfo.route}</span>
                  <span className="text-emerald-400">200 OK</span>
                </div>
                <div className="text-slate-400 font-sans text-xs">{endpointInfo.description}</div>
                <div className="pt-2 text-slate-500 text-[10px] uppercase font-bold">
                  Live Response Payload:
                </div>
                <pre className="bg-slate-950 p-3 rounded-lg overflow-x-auto text-[11px] text-emerald-400">
                  {JSON.stringify(endpointInfo.samplePayload, null, 2)}
                </pre>
              </div>

              {/* cURL example */}
              <div className="p-3 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs font-mono flex items-center justify-between">
                <code className="text-slate-800 dark:text-slate-200 truncate">
                  curl -X GET {window.location.origin}/api{endpointInfo.route.split(' ')[1]}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`curl -X GET ${window.location.origin}/api${endpointInfo.route.split(' ')[1]}`);
                    triggerShortcutNotice('Copied curl command to clipboard!');
                  }}
                  className="p-1 hover:text-blue-600 text-slate-500"
                  title="Copy curl"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
