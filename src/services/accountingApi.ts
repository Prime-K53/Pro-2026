import { buildQuery, downloadBlob, requestBlob, requestJson } from './http';

export type ApiAccountType =
  | 'Bank'
  | 'AccountsReceivable'
  | 'OtherCurrentAsset'
  | 'Inventory'
  | 'FixedAsset'
  | 'AccountsPayable'
  | 'CreditCard'
  | 'OtherCurrentLiability'
  | 'PayrollLiability'
  | 'LongTermLiability'
  | 'Equity'
  | 'Income'
  | 'CostOfGoodsSold'
  | 'Expense'
  | 'OtherExpense';

export type ApiDetailType =
  | 'bank'
  | 'accounts_receivable'
  | 'other_current_asset'
  | 'fixed_asset'
  | 'other_asset'
  | 'accounts_payable'
  | 'credit_card'
  | 'other_current_liability'
  | 'payroll_liabilities'
  | 'long_term_liability'
  | 'equity'
  | 'income'
  | 'other_income'
  | 'cost_of_goods_sold'
  | 'expense'
  | 'other_expense';

export interface ApiAccount {
  id: number;
  company_id: number;
  code: string | null;
  name: string;
  account_type: ApiAccountType;
  detail_type: ApiDetailType;
  bank_kind: 'bank' | 'credit_card' | null;
  description: string | null;
  parent_id: number | null;
  normal_balance: 'debit' | 'credit';
  is_system: boolean;
  is_control: boolean;
  is_contra: boolean;
  is_active: boolean;
  balance: string;
  balanceExact: string;
  balanceNum: number;
}

export interface ApiJournalLine {
  id: number;
  lineOrder: number;
  accountId: number;
  accountCode: string | null;
  accountName: string;
  accountType: ApiAccountType;
  basis: 'both' | 'accrual' | 'cash';
  description: string | null;
  debit: string;
  credit: string;
  debitNum: number;
  creditNum: number;
  isReconciled: boolean;
}

export interface ApiJournalEntry {
  id: number;
  companyId: number;
  entryNumber: string;
  txnDate: string;
  reference: string | null;
  description: string | null;
  memo: string | null;
  sourceType: string;
  sourceId: number | null;
  status: 'draft' | 'posted' | 'voided';
  isPosted: boolean;
  isAdjusting: boolean;
  reversesTransactionId: number | null;
  reversedByTransactionId: number | null;
  postedAt: string | null;
  postedBy: number | null;
  postedByUsername: string | null;
  totalDebits: string;
  totalCredits: string;
  lines: ApiJournalLine[];
}

export interface ApiFiscalPeriod {
  id: number;
  company_id: number;
  period_name: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'soft_closed' | 'closed';
  closed_by: number | null;
  closed_at: string | null;
  closing_txn_id: number | null;
  notes: string | null;
  reopened_by: number | null;
  reopened_at: string | null;
}

export interface ApiStatementLine {
  accountId: number | null;
  accountCode: string | null;
  accountName: string;
  accountPath: string;
  detailType: string;
  amount: string;
  amountNum: number;
  syntheticLine?: string;
}

export interface ApiProfitAndLossReport {
  companyId: number;
  startDate: string;
  endDate: string;
  basis: 'accrual' | 'cash';
  excludeAdjusting: boolean;
  hideZero: boolean;
  sections: {
    income: ApiStatementLine[];
    cogs: ApiStatementLine[];
    expenses: ApiStatementLine[];
    otherIncome: ApiStatementLine[];
    otherExpense: ApiStatementLine[];
  };
  hasOther: boolean;
  totals: {
    totalOperatingIncome: string;
    totalOperatingIncomeNum: number;
    totalIncome: string;
    totalIncomeNum: number;
    totalCogs: string;
    totalCogsNum: number;
    operatingGrossProfit: string;
    operatingGrossProfitNum: number;
    grossProfit: string;
    grossProfitNum: number;
    totalOperatingExpenses: string;
    totalOperatingExpensesNum: number;
    totalExpenses: string;
    totalExpensesNum: number;
    netOperatingIncome: string;
    netOperatingIncomeNum: number;
    totalOtherIncome: string;
    totalOtherIncomeNum: number;
    totalOtherExpense: string;
    totalOtherExpenseNum: number;
    netOtherIncome: string;
    netOtherIncomeNum: number;
    netIncome: string;
    netIncomeNum: number;
  };
}

export interface ApiBalanceSheetReport {
  companyId: number;
  asOfDate: string;
  fiscalYearStartDate: string;
  basis: 'accrual' | 'cash';
  excludeAdjusting: boolean;
  hideZero: boolean;
  groups: {
    currentAssets: ApiStatementLine[];
    fixedAssets: ApiStatementLine[];
    otherAssets: ApiStatementLine[];
    currentLiabilities: ApiStatementLine[];
    longTermLiabilities: ApiStatementLine[];
    equity: ApiStatementLine[];
  };
  totals: {
    totalCurrentAssetsNum: number;
    totalFixedAssetsNum: number;
    totalOtherAssetsNum: number;
    totalAssetsNum: number;
    totalCurrentLiabilitiesNum: number;
    totalLongTermLiabilitiesNum: number;
    totalLiabilitiesNum: number;
    priorYearsNetIncomeNum: number;
    currentYearNetIncomeNum: number;
    totalEquityNum: number;
    totalLiabilitiesAndEquityNum: number;
    totalAssets: string;
    totalLiabilities: string;
    totalEquity: string;
    totalLiabilitiesAndEquity: string;
    difference: string;
    isBalanced: boolean;
  };
}

export interface ApiTrialBalanceReport {
  companyId: number;
  startDate: string;
  endDate: string;
  basis: 'accrual' | 'cash';
  excludeAdjusting: boolean;
  hideZero: boolean;
  rows: Array<{
    accountId: number | null;
    accountCode: string | null;
    accountName: string;
    accountPath: string;
    accountType: string;
    debit: string;
    credit: string;
    debitNum: number;
    creditNum: number;
    netBalanceNum: number;
  }>;
  totalDebit: string;
  totalCredit: string;
  totalDebitNum: number;
  totalCreditNum: number;
  difference: string;
  isBalanced: boolean;
}

export interface ApiCashFlowRow {
  accountId: number | null;
  accountCode: string | null;
  accountName: string;
  group: 'net_income' | 'adjustments' | 'working_capital' | 'investing' | 'financing';
  amount: string;
  amountNum: number;
}

export interface ApiCashFlowReport {
  companyId: number;
  startDate: string;
  endDate: string;
  netIncomeNum: number;
  adjustments: ApiCashFlowRow[];
  workingCapital: ApiCashFlowRow[];
  operating: ApiCashFlowRow[];
  investing: ApiCashFlowRow[];
  financing: ApiCashFlowRow[];
  totalOperatingNum: number;
  totalInvestingNum: number;
  totalFinancingNum: number;
  netChangeNum: number;
  beginningCashNum: number;
  endingCashNum: number;
  reconciliationVariance: string;
  isReconciled: boolean;
}

export interface ApiGeneralLedgerReport {
  companyId: number;
  startDate: string;
  endDate: string;
  accountId: number | null;
  basis: 'accrual' | 'cash';
  accounts: Array<{
    accountId: number;
    accountCode: string | null;
    accountName: string;
    accountPath: string;
    accountType: ApiAccountType;
    normalBalance: 'debit' | 'credit';
    openingBalanceNum: number;
    totalDebitNum: number;
    totalCreditNum: number;
    closingBalanceNum: number;
    entries: Array<{
      transactionId: number;
      lineId: number;
      entryNumber: string;
      txnDate: string;
      reference: string | null;
      description: string;
      sourceType: string;
      isAdjusting: boolean;
      status: string;
      voided: boolean;
      reversesTransactionId: number | null;
      reversedByTransactionId: number | null;
      debitNum: number;
      creditNum: number;
      runningBalanceNum: number;
    }>;
  }>;
}

export interface ApiAuditLogRow {
  id: number;
  occurredAt: string;
  actorUserId: number | null;
  actorUsername: string | null;
  action: string;
  tableName: string;
  recordId: number;
  newValues: Record<string, unknown> | null;
  sha256Hash: string;
  source: string;
}

export const ACCOUNTING_UPDATED_EVENT = 'pms:accounting-updated';

export function emitAccountingUpdated(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ACCOUNTING_UPDATED_EVENT));
  }
}

export const accountingApi = {
  async listAccounts(includeInactive = false): Promise<ApiAccount[]> {
    const data = await requestJson<{ accounts: ApiAccount[] }>(
      `/api/accounts${buildQuery({ includeInactive })}`
    );
    return data.accounts;
  },

  async createAccount(payload: {
    code?: string | null;
    name: string;
    accountType: ApiAccountType;
    detailType?: ApiDetailType;
    description?: string;
    parentId?: number | null;
  }, idempotencyKey?: string | null): Promise<ApiAccount> {
    const data = await requestJson<{ account: ApiAccount }>('/api/accounts', {
      method: 'POST',
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return data.account;
  },

  async updateAccount(
    accountId: number,
    payload: {
      code?: string | null;
      name?: string;
      description?: string | null;
      detailType?: ApiDetailType;
      parentId?: number | null;
      isActive?: boolean;
    }
  ): Promise<ApiAccount> {
    const data = await requestJson<{ account: ApiAccount }>(`/api/accounts/${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return data.account;
  },

  async rebuildBalances(): Promise<{ checkedCount: number; correctedCount: number }> {
    const data = await requestJson<{ checkedCount: number; correctedCount: number }>(
      '/api/accounts/rebuild-balances',
      { method: 'POST', body: '{}' }
    );
    emitAccountingUpdated();
    return data;
  },

  async listJournals(params: { startDate?: string; endDate?: string; sourceType?: string; limit?: number } = {}): Promise<ApiJournalEntry[]> {
    const data = await requestJson<{ entries: ApiJournalEntry[] }>(
      `/api/journals${buildQuery(params)}`
    );
    return data.entries;
  },

  async getJournal(id: number): Promise<ApiJournalEntry> {
    const data = await requestJson<{ entry: ApiJournalEntry }>(`/api/journals/${id}`);
    return data.entry;
  },

  async postJournal(payload: {
    txnDate: string;
    description: string;
    reference?: string;
    isAdjusting?: boolean;
    idempotencyKey?: string;
    lines: Array<{
      accountId: number;
      debit: string | number;
      credit: string | number;
      description?: string;
      basis?: 'both' | 'accrual' | 'cash';
    }>;
  }): Promise<{ entry: ApiJournalEntry; idempotentReplay: boolean }> {
    const data = await requestJson<{ entry: ApiJournalEntry; idempotentReplay: boolean }>('/api/journals', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return data;
  },

  async reverseJournal(
    transactionId: number,
    payload: { reversalDate?: string; reason?: string; idempotencyKey?: string } = {}
  ): Promise<{ original: ApiJournalEntry; reversal: ApiJournalEntry }> {
    const data = await requestJson<{ original: ApiJournalEntry; reversal: ApiJournalEntry }>(
      `/api/journals/${transactionId}/reverse`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    emitAccountingUpdated();
    return data;
  },

  async getOpeningBalancesStatus(): Promise<{
    hasOpeningBalances: boolean;
    entries: Array<{ id: number; entryNumber: string; txnDate: string; status: string; description: string | null }>;
  }> {
    return requestJson('/api/opening-balances/status');
  },

  async postOpeningBalances(payload: {
    txnDate: string;
    description?: string;
    reference?: string;
    autoBalanceAccountId?: number | null;
    idempotencyKey?: string;
    lines: Array<{ accountId: number; amount: string | number }>;
  }): Promise<{ entry: ApiJournalEntry; autoBalanced: boolean }> {
    const data = await requestJson<{ entry: ApiJournalEntry; autoBalanced: boolean }>(
      '/api/opening-balances',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    emitAccountingUpdated();
    return data;
  },

  async listPeriods(): Promise<ApiFiscalPeriod[]> {
    const data = await requestJson<{ periods: ApiFiscalPeriod[] }>('/api/periods');
    return data.periods;
  },

  async createPeriod(payload: {
    periodName: string;
    startDate: string;
    endDate: string;
    notes?: string;
  }): Promise<ApiFiscalPeriod> {
    const data = await requestJson<{ period: ApiFiscalPeriod }>('/api/periods', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emitAccountingUpdated();
    return data.period;
  },

  async softClosePeriod(periodId: number): Promise<ApiFiscalPeriod> {
    const data = await requestJson<{ period: ApiFiscalPeriod }>(`/api/periods/${periodId}/soft-close`, {
      method: 'POST',
      body: '{}',
    });
    emitAccountingUpdated();
    return data.period;
  },

  async closePeriod(
    periodId: number,
    payload: { generateClosingEntry: boolean; retainedEarningsAccountId?: number; notes?: string }
  ): Promise<{ period: ApiFiscalPeriod; closingTransactionId: number | null }> {
    const data = await requestJson<{ period: ApiFiscalPeriod; closingTransactionId: number | null }>(
      `/api/periods/${periodId}/close`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    emitAccountingUpdated();
    return data;
  },

  async reopenPeriod(periodId: number, reason: string): Promise<ApiFiscalPeriod> {
    const data = await requestJson<{ period: ApiFiscalPeriod }>(`/api/periods/${periodId}/reopen`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    emitAccountingUpdated();
    return data.period;
  },

  async getGeneralLedger(params: {
    startDate?: string;
    endDate?: string;
    accountId?: number | null;
    basis?: 'accrual' | 'cash';
    excludeAdjusting?: boolean;
  }): Promise<ApiGeneralLedgerReport> {
    return requestJson(`/api/reports/general-ledger${buildQuery(params)}`);
  },

  async getTrialBalance(params: {
    startDate?: string;
    endDate?: string;
    basis?: 'accrual' | 'cash';
    excludeAdjusting?: boolean;
    hideZero?: boolean;
  }): Promise<ApiTrialBalanceReport> {
    return requestJson(`/api/reports/trial-balance${buildQuery(params)}`);
  },

  async getProfitAndLoss(params: {
    startDate?: string;
    endDate?: string;
    basis?: 'accrual' | 'cash';
    excludeAdjusting?: boolean;
    hideZero?: boolean;
  }): Promise<ApiProfitAndLossReport> {
    return requestJson(`/api/reports/profit-and-loss${buildQuery(params)}`);
  },

  async getBalanceSheet(params: {
    asOfDate?: string;
    basis?: 'accrual' | 'cash';
    excludeAdjusting?: boolean;
    hideZero?: boolean;
  }): Promise<ApiBalanceSheetReport> {
    return requestJson(`/api/reports/balance-sheet${buildQuery(params)}`);
  },

  async getCashFlow(params: { startDate?: string; endDate?: string }): Promise<ApiCashFlowReport> {
    return requestJson(`/api/reports/cash-flow${buildQuery(params)}`);
  },

  async getAuditLogs(limit = 100): Promise<ApiAuditLogRow[]> {
    const data = await requestJson<{ logs: ApiAuditLogRow[] }>(`/api/audit/logs${buildQuery({ limit })}`);
    return data.logs;
  },

  async downloadReportCsv(
    reportPath: 'trial-balance' | 'profit-and-loss' | 'balance-sheet' | 'cash-flow',
    params: Record<string, string | number | boolean | undefined | null>
  ): Promise<void> {
    const url = `/api/reports/${reportPath}/csv${buildQuery(params)}`;
    const blob = await requestBlob(url);
    downloadBlob(blob, `${reportPath}_${new Date().toISOString().slice(0, 10)}.csv`);
  },
};


