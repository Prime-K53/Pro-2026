import crypto from 'node:crypto';
import { Transaction } from '@electric-sql/pglite';
import {
  AccountingError,
  ActorContext,
  JournalLineInput,
  postJournalEntry,
} from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal4, parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import {
  assertIsoDate,
  generateNextDocNumber,
  recalculateCustomerBalance,
  resolveCommercialContext,
} from './commercialHelpers.ts';

export interface WalletTransactionRecord {
  id: number;
  walletId: number;
  walletNumber: string;
  txnType: string;
  direction: 'credit' | 'debit';
  amount: number;
  balanceAfter: number;
  referenceType: string | null;
  referenceId: number | null;
  journalTxnId: number | null;
  bankTxnId: number | null;
  paymentId: number | null;
  reversesTxnId: number | null;
  description: string;
  createdAt: string;
}

export interface WalletSummary {
  id: number;
  customerId: number;
  currencyCode: string;
  liabilityAccountId: number;
  balance: number;
  status: 'active' | 'frozen' | 'closed';
  version: number;
}

export interface WalletStatement {
  wallet: WalletSummary;
  openingBalance: number;
  transactions: WalletTransactionRecord[];
  closingBalance: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Atomically claims an idempotency key in the same transaction as the financial
 * mutation. The row is inserted with status 202/response NULL and updated to the
 * final response before COMMIT. A concurrent request blocks on the unique index,
 * then either replays the committed response or returns 409 IN_PROGRESS.
 */
async function claimWalletIdempotency(
  tx: Transaction,
  companyId: number,
  route: string,
  idempotencyKey: string | null | undefined,
  actorUserId: number,
  payload: unknown
): Promise<{ replay?: { status: number; body: any } }> {
  const key = idempotencyKey?.trim().slice(0, 128);
  if (!key) return {};

  const payloadHash = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');

  for (let attempt = 0; attempt < 2; attempt++) {
    const ins = await tx.query<{ id: number }>(
      `INSERT INTO request_keys (
         company_id, route, idempotency_key, actor_user_id, payload_hash, status_code, response_json
       ) VALUES ($1, $2, $3, $4, $5, 202, NULL)
       ON CONFLICT (company_id, route, idempotency_key) DO NOTHING
       RETURNING id`,
      [companyId, route, key, actorUserId, payloadHash]
    );

    if (ins.rows.length > 0) return {};

    const existing = await tx.query<{
      actor_user_id: number | null;
      payload_hash: string;
      status_code: number;
      response_json: any;
    }>(
      `SELECT actor_user_id, payload_hash, status_code, response_json
         FROM request_keys
        WHERE company_id = $1 AND route = $2 AND idempotency_key = $3
        FOR UPDATE`,
      [companyId, route, key]
    );

    if (existing.rows.length === 0) {
      // The competing transaction rolled back between the insert and the select.
      continue;
    }

    const row = existing.rows[0];
    if (row.actor_user_id != null && Number(row.actor_user_id) !== Number(actorUserId)) {
      throw new AccountingError(409, 'Idempotency key belongs to another user', 'IDEMPOTENCY_ACTOR_CONFLICT');
    }
    if (row.payload_hash !== payloadHash) {
      throw new AccountingError(409, 'Idempotency key reused with a different payload', 'IDEMPOTENCY_CONFLICT');
    }
    if (Number(row.status_code) === 202 && row.response_json == null) {
      throw new AccountingError(409, 'Original request is still in progress', 'IDEMPOTENCY_IN_PROGRESS');
    }
    return { replay: { status: Number(row.status_code) || 200, body: row.response_json } };
  }

  throw new AccountingError(409, 'Idempotency key is in an unknown state', 'IDEMPOTENCY_CONFLICT');
}

async function completeWalletIdempotency(
  tx: Transaction,
  companyId: number,
  route: string,
  idempotencyKey: string | null | undefined,
  status: number,
  body: unknown
): Promise<void> {
  const key = idempotencyKey?.trim().slice(0, 128);
  if (!key) return;
  await tx.query(
    `UPDATE request_keys
        SET status_code = $1, response_json = $2::jsonb
      WHERE company_id = $3 AND route = $4 AND idempotency_key = $5`,
    [status, JSON.stringify(body), companyId, route, key]
  );
}

function mapWalletTransaction(row: any): WalletTransactionRecord {
  return {
    id: Number(row.id),
    walletId: Number(row.wallet_id),
    walletNumber: String(row.wallet_number),
    txnType: String(row.txn_type),
    direction: row.direction === 'credit' ? 'credit' : 'debit',
    amount: toMoneyNumber(parseDecimal4(String(row.amount))),
    balanceAfter: toMoneyNumber(parseDecimal4(String(row.balance_after))),
    referenceType: row.reference_type != null ? String(row.reference_type) : null,
    referenceId: row.reference_id != null ? Number(row.reference_id) : null,
    journalTxnId: row.journal_txn_id != null ? Number(row.journal_txn_id) : null,
    bankTxnId: row.bank_txn_id != null ? Number(row.bank_txn_id) : null,
    paymentId: row.payment_id != null ? Number(row.payment_id) : null,
    reversesTxnId: row.reverses_txn_id != null ? Number(row.reverses_txn_id) : null,
    description: String(row.description || ''),
    createdAt: String(row.created_at || ''),
  };
}

async function companyToday(tx: Transaction, companyId: number): Promise<string> {
  const res = await tx.query<{ today: string }>(
    `SELECT (NOW() AT TIME ZONE c.timezone)::DATE::TEXT AS today
       FROM companies c WHERE c.id = $1 LIMIT 1`,
    [companyId]
  );
  return res.rows[0]?.today || new Date().toISOString().slice(0, 10);
}

async function companyYear(tx: Transaction, companyId: number): Promise<number> {
  const res = await tx.query<{ year: number }>(
    `SELECT EXTRACT(YEAR FROM (NOW() AT TIME ZONE c.timezone)::DATE)::INT AS year
       FROM companies c WHERE c.id = $1 LIMIT 1`,
    [companyId]
  );
  return Number(res.rows[0]?.year || new Date().getUTCFullYear());
}

async function nextWalletNumber(tx: Transaction, companyId: number): Promise<string> {
  const year = await companyYear(tx, companyId);
  const res = await tx.query<{ number: string }>(
    `SELECT next_printing_number($1, 'wallet_txn', $2, 'WLT', 4) AS number`,
    [companyId, year]
  );
  const value = res.rows[0]?.number;
  if (!value) throw new AccountingError(500, 'Failed to allocate wallet number', 'WALLET_NUMBER_ERROR');
  return String(value);
}

export async function resolveWalletLiabilityAccount(
  tx: Transaction,
  companyId: number
): Promise<number> {
  const setting = await tx.query<{ setting_value: string | null }>(
    `SELECT setting_value FROM company_settings
      WHERE company_id = $1 AND setting_key = 'wallet_liability_account_code' LIMIT 1`,
    [companyId]
  );
  const code = (setting.rows[0]?.setting_value || '2310').trim();

  const res = await tx.query<{
    id: number;
    name: string;
    account_type: string;
    normal_balance: string;
    is_active: boolean;
  }>(
    `SELECT id, name, account_type, normal_balance, is_active
       FROM accounts
      WHERE company_id = $1 AND code = $2 LIMIT 1`,
    [companyId, code]
  );

  if (
    res.rows.length === 0 ||
    !res.rows[0].is_active ||
    res.rows[0].normal_balance !== 'credit' ||
    !['OtherCurrentLiability', 'LongTermLiability'].includes(res.rows[0].account_type)
  ) {
    throw new AccountingError(
      400,
      `Wallet liability account "${code}" is missing, inactive, or not a credit-normal liability account`,
      'NO_WALLET_LIABILITY_ACCOUNT'
    );
  }

  return Number(res.rows[0].id);
}

export async function getOrCreateWallet(
  tx: Transaction,
  companyId: number,
  customerId: number,
  currencyCode?: string | null
): Promise<{ walletId: number; customerName: string; currencyCode: string }> {
  const cust = await tx.query<{ id: number; company_name: string }>(
    `SELECT id, company_name FROM customers WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, customerId]
  );
  if (cust.rows.length === 0) {
    throw new AccountingError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
  }
  const customerName = String(cust.rows[0].company_name);

  const comp = await tx.query<{ base_currency: string }>(
    `SELECT base_currency FROM companies WHERE id = $1 LIMIT 1`,
    [companyId]
  );
  const baseCurrency = (comp.rows[0]?.base_currency || 'ZMW').toUpperCase();
  const currency = (currencyCode || baseCurrency).toUpperCase();

  if (currency !== baseCurrency) {
    throw new AccountingError(
      400,
      'Phase 1 customer wallets are base-currency only',
      'WALLET_CURRENCY_UNSUPPORTED'
    );
  }

  const existing = await tx.query<{ id: number }>(
    `SELECT id FROM customer_wallets
      WHERE company_id = $1 AND customer_id = $2 AND currency_code = $3 LIMIT 1`,
    [companyId, customerId, currency]
  );
  if (existing.rows.length > 0) {
    return { walletId: Number(existing.rows[0].id), customerName, currencyCode: currency };
  }

  const liabilityAccountId = await resolveWalletLiabilityAccount(tx, companyId);

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO customer_wallets (
       company_id, customer_id, currency_code, liability_account_id, balance, status
     ) VALUES ($1, $2, $3, $4, 0.0000, 'active')
     ON CONFLICT (company_id, customer_id, currency_code) DO NOTHING
     RETURNING id`,
    [companyId, customerId, currency, liabilityAccountId]
  );

  if (ins.rows.length > 0) {
    return { walletId: Number(ins.rows[0].id), customerName, currencyCode: currency };
  }

  const again = await tx.query<{ id: number }>(
    `SELECT id FROM customer_wallets
      WHERE company_id = $1 AND customer_id = $2 AND currency_code = $3 LIMIT 1`,
    [companyId, customerId, currency]
  );
  if (again.rows.length === 0) {
    throw new AccountingError(500, 'Failed to create customer wallet', 'WALLET_CREATE_FAILED');
  }
  return { walletId: Number(again.rows[0].id), customerName, currencyCode: currency };
}

async function lockWallet(
  tx: Transaction,
  companyId: number,
  walletId: number
): Promise<{
  id: number;
  customerId: number;
  balance: bigint;
  status: string;
  liabilityAccountId: number;
  currencyCode: string;
}> {
  const res = await tx.query<any>(
    `SELECT id, customer_id, balance::text AS balance, status,
            liability_account_id, currency_code
       FROM customer_wallets
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, walletId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Customer wallet not found', 'WALLET_NOT_FOUND');
  }
  const row = res.rows[0];
  return {
    id: Number(row.id),
    customerId: Number(row.customer_id),
    balance: parseDecimal4(String(row.balance)),
    status: String(row.status),
    liabilityAccountId: Number(row.liability_account_id),
    currencyCode: String(row.currency_code),
  };
}

async function insertWalletTransaction(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    walletId: number;
    customerId: number;
    walletNumber: string;
    txnType: string;
    direction: 'credit' | 'debit';
    amount: bigint;
    balanceAfter: bigint;
    referenceType?: string | null;
    referenceId?: number | null;
    allocationId?: number | null;
    journalTxnId?: number | null;
    bankTxnId?: number | null;
    paymentId?: number | null;
    reversesTxnId?: number | null;
    idempotencyKey?: string | null;
    description: string;
    notes?: string | null;
  }
): Promise<WalletTransactionRecord> {
  const res = await tx.query<{ id: number }>(
    `INSERT INTO customer_wallet_transactions (
       company_id, wallet_id, customer_id, wallet_number, txn_type, direction,
       amount, balance_after, reference_type, reference_id, allocation_id,
       journal_txn_id, bank_txn_id, payment_id, reverses_txn_id,
       idempotency_key, description, notes, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9, $10, $11,
       $12, $13, $14, $15,
       $16, $17, $18, $19
     )
     RETURNING id`,
    [
      companyId,
      input.walletId,
      input.customerId,
      input.walletNumber,
      input.txnType,
      input.direction,
      formatDecimal4(input.amount),
      formatDecimal4(input.balanceAfter),
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.allocationId ?? null,
      input.journalTxnId ?? null,
      input.bankTxnId ?? null,
      input.paymentId ?? null,
      input.reversesTxnId ?? null,
      input.idempotencyKey?.trim() || null,
      input.description,
      input.notes?.trim() || null,
      actor.userId,
    ]
  );

  const id = Number(res.rows[0].id);
  const row = await tx.query<any>(
    `SELECT * FROM customer_wallet_transactions WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  return mapWalletTransaction(row.rows[0]);
}

async function updateWalletBalance(
  tx: Transaction,
  companyId: number,
  walletId: number,
  nextBalance: bigint
): Promise<void> {
  await tx.query(
    `UPDATE customer_wallets
        SET balance = $3::NUMERIC(19,4),
            version = version + 1
      WHERE company_id = $1 AND id = $2`,
    [companyId, walletId, formatDecimal4(nextBalance)]
  );
}

export async function recordWalletDeposit(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    amount: string | number;
    bankAccountId: number;
    currencyCode?: string | null;
    txnDate?: string;
    referenceNumber?: string | null;
    memo?: string | null;
    idempotencyKey?: string | null;
  }
): Promise<{ walletTransaction: WalletTransactionRecord; idempotentReplay: boolean }> {
  const amount4 = parseDecimal4(input.amount);
  if (amount4 <= 0n) {
    throw new AccountingError(400, 'Wallet deposit amount must be greater than zero', 'INVALID_AMOUNT');
  }

  const canonicalPayload = {
    customerId: Number(input.customerId),
    amount: formatDecimal4(amount4),
    bankAccountId: Number(input.bankAccountId),
    currencyCode: input.currencyCode || null,
    txnDate: input.txnDate || null,
    referenceNumber: input.referenceNumber || null,
    memo: input.memo || null,
  };

  const claim = await claimWalletIdempotency(
    tx,
    companyId,
    'wallet_deposit',
    input.idempotencyKey,
    actor.userId,
    canonicalPayload
  );
  if (claim.replay) {
    return { ...claim.replay.body, idempotentReplay: true };
  }

  const txnDate = input.txnDate ? assertIsoDate(input.txnDate, 'txnDate') : await companyToday(tx, companyId);
  const ctx = await resolveCommercialContext(tx, companyId, actor);

  const bank = await tx.query<{ id: number; account_type: string }>(
    `SELECT id, account_type FROM accounts
      WHERE company_id = $1 AND id = $2 AND is_active = TRUE LIMIT 1`,
    [companyId, Number(input.bankAccountId)]
  );
  if (bank.rows.length === 0 || !['Bank', 'OtherCurrentAsset'].includes(bank.rows[0].account_type)) {
    throw new AccountingError(400, 'Deposit bank/cash account is invalid', 'INVALID_BANK_ACCOUNT');
  }
  const bankAccountId = Number(bank.rows[0].id);

  const wallet = await getOrCreateWallet(tx, companyId, Number(input.customerId), input.currencyCode);
  const locked = await lockWallet(tx, companyId, wallet.walletId);
  if (locked.status !== 'active') {
    throw new AccountingError(409, 'Wallet is not active', 'WALLET_NOT_ACTIVE');
  }

  const walletNumber = await nextWalletNumber(tx, companyId);
  const nextBalance4 = locked.balance + amount4;

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate,
    description: `Customer wallet deposit — ${walletNumber}`,
    reference: input.referenceNumber?.trim() || walletNumber,
    sourceType: 'customer_wallet',
    sourceId: locked.id,
    idempotencyKey: `wallet-deposit-${companyId}-${walletNumber}`,
    lines: [
      {
        accountId: bankAccountId,
        debit: formatDecimal4(amount4),
        credit: '0.0000',
        description: `Wallet deposit ${walletNumber}`,
        partyType: 'customer',
        partyId: locked.customerId,
      },
      {
        accountId: locked.liabilityAccountId,
        debit: '0.0000',
        credit: formatDecimal4(amount4),
        description: `Customer wallet liability ${walletNumber}`,
        partyType: 'customer',
        partyId: locked.customerId,
      },
    ],
  });

  const ba = await tx.query<{ id: number }>(
    `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
    [companyId, bankAccountId]
  );

  const bt = await tx.query<{ id: number }>(
    `INSERT INTO bank_transactions (
       company_id, account_id, bank_account_id, txn_date, payee, txn_type,
       ref_number, memo, amount, is_cleared, status, offset_account_id,
       journal_txn_id, customer_id, category
     ) VALUES (
       $1, $2, $3, $4::DATE, $5, 'Deposit',
       $6, $7, $8::NUMERIC(19,4), FALSE, 'posted', $9,
       $10, $11, 'Customer Wallet'
     )
     RETURNING id`,
    [
      companyId,
      bankAccountId,
      ba.rows[0] ? Number(ba.rows[0].id) : null,
      txnDate,
      wallet.customerName,
      input.referenceNumber?.trim() || walletNumber,
      input.memo?.trim() || `Customer wallet deposit ${walletNumber}`,
      formatDecimal4(amount4),
      locked.liabilityAccountId,
      posted.transaction.id,
      locked.customerId,
    ]
  );
  const bankTxnId = Number(bt.rows[0].id);

  const record = await insertWalletTransaction(tx, companyId, actor, {
    walletId: locked.id,
    customerId: locked.customerId,
    walletNumber,
    txnType: 'deposit',
    direction: 'credit',
    amount: amount4,
    balanceAfter: nextBalance4,
    referenceType: 'bank_transaction',
    referenceId: bankTxnId,
    journalTxnId: posted.transaction.id,
    bankTxnId,
    idempotencyKey: input.idempotencyKey ?? null,
    description: `Customer wallet deposit ${walletNumber}`,
    notes: input.memo ?? null,
  });

  await updateWalletBalance(tx, companyId, locked.id, nextBalance4);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_WALLET_DEPOSIT_POSTED',
    tableName: 'customer_wallet_transactions',
    recordId: record.id,
    newValues: {
      walletNumber,
      customerId: locked.customerId,
      amount: formatDecimal4(amount4),
      balanceAfter: formatDecimal4(nextBalance4),
      journalTxnId: posted.transaction.id,
      bankTxnId,
    },
  });

  await completeWalletIdempotency(
    tx,
    companyId,
    'wallet_deposit',
    input.idempotencyKey,
    201,
    { walletTransaction: record }
  );

  return { walletTransaction: record, idempotentReplay: false };
}

export async function allocateWalletFunds(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    walletId?: number;
    contractId: number;
    amount: string | number;
    currencyCode?: string | null;
    idempotencyKey?: string | null;
    notes?: string | null;
    allowDraft?: boolean;
    increaseContractTotals?: boolean;
  }
): Promise<{ walletTransaction: WalletTransactionRecord; allocationId: number; idempotentReplay: boolean }> {
  const amount4 = parseDecimal4(input.amount);
  if (amount4 <= 0n) {
    throw new AccountingError(400, 'Allocation amount must be greater than zero', 'INVALID_AMOUNT');
  }

  const canonicalPayload = {
    customerId: Number(input.customerId),
    contractId: Number(input.contractId),
    amount: formatDecimal4(amount4),
    currencyCode: input.currencyCode || null,
  };

  const claim = await claimWalletIdempotency(
    tx,
    companyId,
    'wallet_allocation',
    input.idempotencyKey,
    actor.userId,
    canonicalPayload
  );
  if (claim.replay) {
    return {
      ...claim.replay.body,
      idempotentReplay: true,
    };
  }

  const wallet = input.walletId
    ? { walletId: Number(input.walletId) }
    : await getOrCreateWallet(tx, companyId, Number(input.customerId), input.currencyCode);
  const walletId = wallet.walletId;

  const locked = await lockWallet(tx, companyId, walletId);
  if (locked.status !== 'active') {
    throw new AccountingError(409, 'Wallet is not active', 'WALLET_NOT_ACTIVE');
  }
  if (locked.balance < amount4) {
    throw new AccountingError(409, 'Insufficient wallet funds', 'INSUFFICIENT_WALLET_FUNDS');
  }

  const contract = await tx.query<any>(
    `SELECT id, contract_number, status, liability_account_id,
            total_prepaid_amount::text AS total_prepaid_amount,
            remaining_balance::text AS remaining_balance
       FROM printing_contracts
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, Number(input.contractId)]
  );
  if (contract.rows.length === 0) {
    throw new AccountingError(404, 'Contract not found', 'CONTRACT_NOT_FOUND');
  }
  const c = contract.rows[0];
  const contractStatus = String(c.status);
  const draftAllowed = input.allowDraft === true && contractStatus === 'draft';
  if (contractStatus !== 'active' && !draftAllowed) {
    throw new AccountingError(409, 'Contract is not active', 'CONTRACT_NOT_ACTIVE');
  }

  const contractLiability = await tx.query<{
    id: number;
    account_type: string;
    normal_balance: string;
    is_active: boolean;
  }>(
    `SELECT id, account_type, normal_balance, is_active
       FROM accounts
      WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, Number(c.liability_account_id)]
  );
  if (
    contractLiability.rows.length === 0 ||
    !contractLiability.rows[0].is_active ||
    contractLiability.rows[0].normal_balance !== 'credit' ||
    !['OtherCurrentLiability', 'LongTermLiability'].includes(contractLiability.rows[0].account_type)
  ) {
    throw new AccountingError(
      400,
      'Contract liability account is missing, inactive, or invalid',
      'INVALID_CONTRACT_LIABILITY_ACCOUNT'
    );
  }

  const existing = await tx.query<{ id: number; amount: string }>(
    `SELECT id, amount::text FROM customer_wallet_allocations
      WHERE company_id = $1 AND wallet_id = $2 AND allocation_type = 'contract' AND contract_id = $3
      FOR UPDATE`,
    [companyId, walletId, Number(input.contractId)]
  );

  let allocationId: number;
  if (existing.rows.length > 0) {
    allocationId = Number(existing.rows[0].id);
    const nextAmount4 = parseDecimal4(String(existing.rows[0].amount)) + amount4;
    await tx.query(
      `UPDATE customer_wallet_allocations
          SET amount = $3::NUMERIC(19,4), updated_at = NOW()
        WHERE company_id = $1 AND id = $2`,
      [companyId, allocationId, formatDecimal4(nextAmount4)]
    );
  } else {
    const ins = await tx.query<{ id: number }>(
      `INSERT INTO customer_wallet_allocations (
         company_id, wallet_id, customer_id, allocation_type, contract_id,
         amount, consumed_amount, released_amount, forfeited_amount,
         status, currency_code, created_by
       ) VALUES (
         $1, $2, $3, 'contract', $4,
         $5::NUMERIC(19,4), 0.0000, 0.0000, 0.0000,
         'active', $6, $7
       )
       RETURNING id`,
      [
        companyId,
        walletId,
        locked.customerId,
        Number(input.contractId),
        formatDecimal4(amount4),
        locked.currencyCode,
        actor.userId,
      ]
    );
    allocationId = Number(ins.rows[0].id);
  }

  const walletNumber = await nextWalletNumber(tx, companyId);
  const nextBalance4 = locked.balance - amount4;

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: await companyToday(tx, companyId),
    description: `Wallet allocation to contract ${c.contract_number} — ${walletNumber}`,
    reference: String(c.contract_number),
    sourceType: 'customer_wallet',
    sourceId: locked.id,
    idempotencyKey: `wallet-allocation-${companyId}-${walletNumber}`,
    lines: [
      {
        accountId: locked.liabilityAccountId,
        debit: formatDecimal4(amount4),
        credit: '0.0000',
        description: `Allocate wallet funds to ${c.contract_number}`,
        partyType: 'customer',
        partyId: locked.customerId,
      },
      {
        accountId: Number(c.liability_account_id),
        debit: '0.0000',
        credit: formatDecimal4(amount4),
        description: `Contract retainer liability ${c.contract_number}`,
        partyType: 'customer',
        partyId: locked.customerId,
      },
    ],
  });

  const record = await insertWalletTransaction(tx, companyId, actor, {
    walletId,
    customerId: locked.customerId,
    walletNumber,
    txnType: 'allocation',
    direction: 'debit',
    amount: amount4,
    balanceAfter: nextBalance4,
    referenceType: 'contract',
    referenceId: Number(input.contractId),
    allocationId,
    journalTxnId: posted.transaction.id,
    idempotencyKey: input.idempotencyKey ?? null,
    description: `Allocate wallet funds to contract ${c.contract_number}`,
    notes: input.notes ?? null,
  });

  await updateWalletBalance(tx, companyId, walletId, nextBalance4);

  if (input.increaseContractTotals !== false) {
    await tx.query(
      `UPDATE printing_contracts
          SET total_prepaid_amount = total_prepaid_amount + $3::NUMERIC(19,4),
              remaining_balance = remaining_balance + $4::NUMERIC(19,4)
        WHERE company_id = $1 AND id = $2`,
      [companyId, Number(input.contractId), formatDecimal4(amount4), formatDecimal4(amount4)]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_WALLET_ALLOCATED',
    tableName: 'customer_wallet_allocations',
    recordId: allocationId,
    newValues: {
      walletNumber,
      contractId: Number(input.contractId),
      contractNumber: String(c.contract_number),
      amount: formatDecimal4(amount4),
      balanceAfter: formatDecimal4(nextBalance4),
      journalTxnId: posted.transaction.id,
    },
  });

  await completeWalletIdempotency(
    tx,
    companyId,
    'wallet_allocation',
    input.idempotencyKey,
    201,
    { walletTransaction: record, allocationId }
  );

  return { walletTransaction: record, allocationId, idempotentReplay: false };
}

export async function releaseWalletAllocation(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    walletId: number;
    allocationId: number;
    amount: string | number;
    idempotencyKey?: string | null;
    notes?: string | null;
  }
): Promise<{ walletTransaction: WalletTransactionRecord; idempotentReplay: boolean }> {
  const amount4 = parseDecimal4(input.amount);
  if (amount4 <= 0n) {
    throw new AccountingError(400, 'Release amount must be greater than zero', 'INVALID_AMOUNT');
  }

  const canonicalPayload = {
    customerId: Number(input.customerId),
    walletId: Number(input.walletId),
    allocationId: Number(input.allocationId),
    amount: formatDecimal4(amount4),
  };

  const claim = await claimWalletIdempotency(
    tx,
    companyId,
    'wallet_release',
    input.idempotencyKey,
    actor.userId,
    canonicalPayload
  );
  if (claim.replay) {
    return { ...claim.replay.body, idempotentReplay: true };
  }

  const locked = await lockWallet(tx, companyId, Number(input.walletId));
  if (locked.status !== 'active') {
    throw new AccountingError(409, 'Wallet is not active', 'WALLET_NOT_ACTIVE');
  }

  const alloc = await tx.query<any>(
    `SELECT id, contract_id, allocation_type,
            amount::text AS amount,
            consumed_amount::text AS consumed_amount,
            released_amount::text AS released_amount,
            forfeited_amount::text AS forfeited_amount,
            status
       FROM customer_wallet_allocations
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, Number(input.allocationId)]
  );
  if (alloc.rows.length === 0) {
    throw new AccountingError(404, 'Wallet allocation not found', 'ALLOCATION_NOT_FOUND');
  }
  const a = alloc.rows[0];
  if (String(a.allocation_type) !== 'contract') {
    throw new AccountingError(400, 'Only contract allocations can be released', 'INVALID_ALLOCATION');
  }
  if (String(a.status) === 'cancelled') {
    throw new AccountingError(409, 'Allocation is already cancelled', 'ALLOCATION_CANCELLED');
  }

  const remaining4 =
    parseDecimal4(String(a.amount)) -
    parseDecimal4(String(a.consumed_amount)) -
    parseDecimal4(String(a.released_amount)) -
    parseDecimal4(String(a.forfeited_amount));
  if (amount4 > remaining4) {
    throw new AccountingError(409, 'Release exceeds allocation remaining', 'RELEASE_EXCEEDS_ALLOCATION');
  }

  const contract = await tx.query<{ liability_account_id: number; contract_number: string }>(
    `SELECT liability_account_id, contract_number
       FROM printing_contracts
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(a.contract_id)]
  );
  if (contract.rows.length === 0) {
    throw new AccountingError(404, 'Contract not found', 'CONTRACT_NOT_FOUND');
  }

  const walletNumber = await nextWalletNumber(tx, companyId);
  const nextBalance4 = locked.balance + amount4;

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: await companyToday(tx, companyId),
    description: `Release contract allocation ${contract.rows[0].contract_number} — ${walletNumber}`,
    reference: String(contract.rows[0].contract_number),
    sourceType: 'customer_wallet',
    sourceId: locked.id,
    idempotencyKey: `wallet-release-${companyId}-${walletNumber}`,
    lines: [
      {
        accountId: Number(contract.rows[0].liability_account_id),
        debit: formatDecimal4(amount4),
        credit: '0.0000',
        description: `Release contract liability ${contract.rows[0].contract_number}`,
        partyType: 'customer',
        partyId: locked.customerId,
      },
      {
        accountId: locked.liabilityAccountId,
        debit: '0.0000',
        credit: formatDecimal4(amount4),
        description: `Release to customer wallet ${walletNumber}`,
        partyType: 'customer',
        partyId: locked.customerId,
      },
    ],
  });

  const record = await insertWalletTransaction(tx, companyId, actor, {
    walletId: locked.id,
    customerId: locked.customerId,
    walletNumber,
    txnType: 'release',
    direction: 'credit',
    amount: amount4,
    balanceAfter: nextBalance4,
    referenceType: 'contract',
    referenceId: Number(a.contract_id),
    allocationId: Number(a.id),
    journalTxnId: posted.transaction.id,
    idempotencyKey: input.idempotencyKey ?? null,
    description: `Release contract allocation ${contract.rows[0].contract_number}`,
    notes: input.notes ?? null,
  });

  await updateWalletBalance(tx, companyId, locked.id, nextBalance4);

  const nextReleased4 = parseDecimal4(String(a.released_amount)) + amount4;
  const totalGone4 =
    parseDecimal4(String(a.consumed_amount)) +
    parseDecimal4(String(a.forfeited_amount)) +
    nextReleased4;
  const nextStatus = totalGone4 >= parseDecimal4(String(a.amount)) ? 'cancelled' : 'active';
  await tx.query(
    `UPDATE customer_wallet_allocations
        SET released_amount = $3::NUMERIC(19,4), status = $4, updated_at = NOW()
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(a.id), formatDecimal4(nextReleased4), nextStatus]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_WALLET_ALLOCATION_RELEASED',
    tableName: 'customer_wallet_allocations',
    recordId: Number(a.id),
    newValues: {
      walletNumber,
      amount: formatDecimal4(amount4),
      balanceAfter: formatDecimal4(nextBalance4),
      journalTxnId: posted.transaction.id,
      status: nextStatus,
    },
  });

  await completeWalletIdempotency(tx, companyId, 'wallet_release', input.idempotencyKey, 201, {
    walletTransaction: record,
  });

  return { walletTransaction: record, idempotentReplay: false };
}

export async function applyWalletToInvoice(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    invoiceId: number;
    amount: string | number;
    walletId?: number;
    txnDate?: string;
    idempotencyKey?: string | null;
    memo?: string | null;
  }
): Promise<{ walletTransaction: WalletTransactionRecord; paymentId: number; idempotentReplay: boolean }> {
  const amount4 = parseDecimal4(input.amount);
  if (amount4 <= 0n) {
    throw new AccountingError(400, 'Payment amount must be greater than zero', 'INVALID_AMOUNT');
  }

  const canonicalPayload = {
    customerId: Number(input.customerId),
    invoiceId: Number(input.invoiceId),
    amount: formatDecimal4(amount4),
    txnDate: input.txnDate || null,
  };

  const claim = await claimWalletIdempotency(
    tx,
    companyId,
    'wallet_invoice_payment',
    input.idempotencyKey,
    actor.userId,
    canonicalPayload
  );
  if (claim.replay) {
    return { ...claim.replay.body, idempotentReplay: true };
  }

  const txnDate = input.txnDate ? assertIsoDate(input.txnDate, 'txnDate') : await companyToday(tx, companyId);
  const ctx = await resolveCommercialContext(tx, companyId, actor);

  const wallet = input.walletId
    ? { walletId: Number(input.walletId) }
    : await getOrCreateWallet(tx, companyId, Number(input.customerId));
  const locked = await lockWallet(tx, companyId, wallet.walletId);
  if (locked.status !== 'active') {
    throw new AccountingError(409, 'Wallet is not active', 'WALLET_NOT_ACTIVE');
  }
  if (locked.balance < amount4) {
    throw new AccountingError(409, 'Insufficient wallet funds', 'INSUFFICIENT_WALLET_FUNDS');
  }

  const inv = await tx.query<any>(
    `SELECT id, customer_id, status, total::text AS total,
            amount_paid::text AS amount_paid, balance_due::text AS balance_due
       FROM invoices
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, Number(input.invoiceId)]
  );
  if (inv.rows.length === 0) {
    throw new AccountingError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  }
  const invoice = inv.rows[0];
  if (Number(invoice.customer_id) !== locked.customerId) {
    throw new AccountingError(400, 'Invoice belongs to a different customer', 'CUSTOMER_MISMATCH');
  }
  if (String(invoice.status) === 'voided') {
    throw new AccountingError(409, 'Voided invoice cannot be paid', 'INVOICE_VOIDED');
  }
  const balanceDue4 = parseDecimal4(String(invoice.balance_due));
  if (amount4 > balanceDue4) {
    throw new AccountingError(400, 'Payment exceeds invoice balance due', 'PAYMENT_EXCEEDS_BALANCE');
  }

  const paymentNumber = await generateNextDocNumber(tx, companyId, 'payments', 'payment_number', 'PMT');
  const pmt = await tx.query<{ id: number }>(
    `INSERT INTO payments (
       company_id, payment_number, customer_id, payment_date, amount, payment_method,
       reference_number, deposit_to_account_id, memo,
       currency_code, exchange_rate, foreign_amount
     ) VALUES (
       $1, $2, $3, $4::DATE, $5::NUMERIC(19,4), 'Wallet',
       $6, $7, $8,
       $9, 1.000000, $10::NUMERIC(19,4)
     )
     RETURNING id`,
    [
      companyId,
      paymentNumber,
      locked.customerId,
      txnDate,
      formatDecimal4(amount4),
      input.memo?.trim() || `Wallet payment ${paymentNumber}`,
      locked.liabilityAccountId,
      input.memo?.trim() || `Customer wallet invoice payment ${paymentNumber}`,
      ctx.baseCurrency,
      formatDecimal4(amount4),
    ]
  );
  const paymentId = Number(pmt.rows[0].id);

  await tx.query(
    `INSERT INTO payment_allocations (company_id, payment_id, invoice_id, amount, from_remainder)
     VALUES ($1, $2, $3, $4::NUMERIC(19,4), FALSE)`,
    [companyId, paymentId, Number(input.invoiceId), formatDecimal4(amount4)]
  );

  const nextPaid4 = parseDecimal4(String(invoice.amount_paid)) + amount4;
  const nextBalance4 = balanceDue4 - amount4;
  const nextStatus = nextBalance4 === 0n ? 'paid' : 'partial';
  await tx.query(
    `UPDATE invoices
        SET amount_paid = $3::NUMERIC(19,4),
            balance_due = $4::NUMERIC(19,4),
            status = $5
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(input.invoiceId), formatDecimal4(nextPaid4), formatDecimal4(nextBalance4), nextStatus]
  );

  const walletNumber = await nextWalletNumber(tx, companyId);
  const walletBalanceAfter4 = locked.balance - amount4;

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate,
    description: `Customer wallet invoice payment — ${paymentNumber}`,
    reference: paymentNumber,
    sourceType: 'payment',
    sourceId: paymentId,
    idempotencyKey: `wallet-invoice-${companyId}-${walletNumber}`,
    lines: [
      {
        accountId: locked.liabilityAccountId,
        debit: formatDecimal4(amount4),
        credit: '0.0000',
        description: `Wallet payment ${paymentNumber}`,
        partyType: 'customer',
        partyId: locked.customerId,
      },
      {
        accountId: ctx.ar1100,
        debit: '0.0000',
        credit: formatDecimal4(amount4),
        description: `Accounts receivable relief ${paymentNumber}`,
        partyType: 'customer',
        partyId: locked.customerId,
      },
    ],
  });

  await tx.query(
    `UPDATE payments SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, paymentId, posted.transaction.id]
  );

  const record = await insertWalletTransaction(tx, companyId, actor, {
    walletId: locked.id,
    customerId: locked.customerId,
    walletNumber,
    txnType: 'invoice_payment',
    direction: 'debit',
    amount: amount4,
    balanceAfter: walletBalanceAfter4,
    referenceType: 'payment',
    referenceId: paymentId,
    journalTxnId: posted.transaction.id,
    paymentId,
    idempotencyKey: input.idempotencyKey ?? null,
    description: `Wallet payment ${paymentNumber} for invoice ${invoice.invoice_number ?? input.invoiceId}`,
    notes: input.memo ?? null,
  });

  await updateWalletBalance(tx, companyId, locked.id, walletBalanceAfter4);
  await recalculateCustomerBalance(tx, companyId, locked.customerId);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_WALLET_INVOICE_PAID',
    tableName: 'customer_wallet_transactions',
    recordId: record.id,
    newValues: {
      walletNumber,
      paymentId,
      invoiceId: Number(input.invoiceId),
      amount: formatDecimal4(amount4),
      balanceAfter: formatDecimal4(walletBalanceAfter4),
      journalTxnId: posted.transaction.id,
    },
  });

  await completeWalletIdempotency(
    tx,
    companyId,
    'wallet_invoice_payment',
    input.idempotencyKey,
    201,
    { walletTransaction: record, paymentId }
  );

  return { walletTransaction: record, paymentId, idempotentReplay: false };
}

export async function refundWallet(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: {
    customerId: number;
    walletId?: number;
    amount: string | number;
    bankAccountId: number;
    txnDate?: string;
    referenceNumber?: string | null;
    memo?: string | null;
    idempotencyKey?: string | null;
  }
): Promise<{ walletTransaction: WalletTransactionRecord; bankTransactionId: number; idempotentReplay: boolean }> {
  const amount4 = parseDecimal4(input.amount);
  if (amount4 <= 0n) {
    throw new AccountingError(400, 'Refund amount must be greater than zero', 'INVALID_AMOUNT');
  }

  const canonicalPayload = {
    customerId: Number(input.customerId),
    amount: formatDecimal4(amount4),
    bankAccountId: Number(input.bankAccountId),
    txnDate: input.txnDate || null,
    referenceNumber: input.referenceNumber || null,
  };

  const claim = await claimWalletIdempotency(
    tx,
    companyId,
    'wallet_refund',
    input.idempotencyKey,
    actor.userId,
    canonicalPayload
  );
  if (claim.replay) {
    return {
      ...claim.replay.body,
      idempotentReplay: true,
    };
  }

  const txnDate = input.txnDate ? assertIsoDate(input.txnDate, 'txnDate') : await companyToday(tx, companyId);
  const ctx = await resolveCommercialContext(tx, companyId, actor);

  const bank = await tx.query<{ id: number; account_type: string }>(
    `SELECT id, account_type FROM accounts
      WHERE company_id = $1 AND id = $2 AND is_active = TRUE LIMIT 1`,
    [companyId, Number(input.bankAccountId)]
  );
  if (bank.rows.length === 0 || !['Bank', 'OtherCurrentAsset'].includes(bank.rows[0].account_type)) {
    throw new AccountingError(400, 'Refund bank/cash account is invalid', 'INVALID_BANK_ACCOUNT');
  }
  const bankAccountId = Number(bank.rows[0].id);

  const wallet = input.walletId
    ? { walletId: Number(input.walletId) }
    : await getOrCreateWallet(tx, companyId, Number(input.customerId));
  const locked = await lockWallet(tx, companyId, wallet.walletId);
  if (locked.status !== 'active') {
    throw new AccountingError(409, 'Wallet is not active', 'WALLET_NOT_ACTIVE');
  }
  if (locked.balance < amount4) {
    throw new AccountingError(409, 'Insufficient wallet funds for refund', 'INSUFFICIENT_WALLET_FUNDS');
  }

  const walletNumber = await nextWalletNumber(tx, companyId);
  const nextBalance4 = locked.balance - amount4;

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate,
    description: `Customer wallet refund — ${walletNumber}`,
    reference: input.referenceNumber?.trim() || walletNumber,
    sourceType: 'customer_wallet',
    sourceId: locked.id,
    idempotencyKey: `wallet-refund-${companyId}-${walletNumber}`,
    lines: [
      {
        accountId: locked.liabilityAccountId,
        debit: formatDecimal4(amount4),
        credit: '0.0000',
        description: `Wallet refund ${walletNumber}`,
        partyType: 'customer',
        partyId: locked.customerId,
      },
      {
        accountId: bankAccountId,
        debit: '0.0000',
        credit: formatDecimal4(amount4),
        description: `Refund to bank ${walletNumber}`,
        partyType: 'customer',
        partyId: locked.customerId,
      },
    ],
  });

  const ba = await tx.query<{ id: number }>(
    `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
    [companyId, bankAccountId]
  );

  const bt = await tx.query<{ id: number }>(
    `INSERT INTO bank_transactions (
       company_id, account_id, bank_account_id, txn_date, payee, txn_type,
       ref_number, memo, amount, is_cleared, status, offset_account_id,
       journal_txn_id, customer_id, category
     ) VALUES (
       $1, $2, $3, $4::DATE, $5, 'Debit',
       $6, $7, $8::NUMERIC(19,4), FALSE, 'posted', $9,
       $10, $11, 'Customer Wallet'
     )
     RETURNING id`,
    [
      companyId,
      bankAccountId,
      ba.rows[0] ? Number(ba.rows[0].id) : null,
      txnDate,
      'Customer wallet refund',
      input.referenceNumber?.trim() || walletNumber,
      input.memo?.trim() || `Customer wallet refund ${walletNumber}`,
      formatDecimal4(-amount4),
      locked.liabilityAccountId,
      posted.transaction.id,
      locked.customerId,
    ]
  );
  const bankTxnId = Number(bt.rows[0].id);

  const record = await insertWalletTransaction(tx, companyId, actor, {
    walletId: locked.id,
    customerId: locked.customerId,
    walletNumber,
    txnType: 'refund',
    direction: 'debit',
    amount: amount4,
    balanceAfter: nextBalance4,
    referenceType: 'bank_transaction',
    referenceId: bankTxnId,
    journalTxnId: posted.transaction.id,
    bankTxnId,
    idempotencyKey: input.idempotencyKey ?? null,
    description: `Customer wallet refund ${walletNumber}`,
    notes: input.memo ?? null,
  });

  await updateWalletBalance(tx, companyId, locked.id, nextBalance4);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_WALLET_REFUND_POSTED',
    tableName: 'customer_wallet_transactions',
    recordId: record.id,
    newValues: {
      walletNumber,
      amount: formatDecimal4(amount4),
      balanceAfter: formatDecimal4(nextBalance4),
      journalTxnId: posted.transaction.id,
      bankTxnId,
    },
  });

  await completeWalletIdempotency(
    tx,
    companyId,
    'wallet_refund',
    input.idempotencyKey,
    201,
    { walletTransaction: record, bankTransactionId: bankTxnId }
  );

  return { walletTransaction: record, bankTransactionId: bankTxnId, idempotentReplay: false };
}

export async function getWalletStatement(
  tx: Transaction,
  companyId: number,
  walletId: number
): Promise<WalletStatement> {
  const w = await tx.query<any>(
    `SELECT id, customer_id, currency_code, liability_account_id,
            balance::text AS balance, status, version
       FROM customer_wallets
      WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, walletId]
  );
  if (w.rows.length === 0) {
    throw new AccountingError(404, 'Customer wallet not found', 'WALLET_NOT_FOUND');
  }
  const row = w.rows[0];

  const txns = await tx.query<any>(
    `SELECT * FROM customer_wallet_transactions
      WHERE company_id = $1 AND wallet_id = $2
      ORDER BY created_at ASC, id ASC`,
    [companyId, walletId]
  );

  const transactions = txns.rows.map(mapWalletTransaction);
  const closing = parseDecimal4(String(row.balance));

  return {
    wallet: {
      id: Number(row.id),
      customerId: Number(row.customer_id),
      currencyCode: String(row.currency_code),
      liabilityAccountId: Number(row.liability_account_id),
      balance: toMoneyNumber(closing),
      status: row.status === 'frozen' ? 'frozen' : row.status === 'closed' ? 'closed' : 'active',
      version: Number(row.version),
    },
    openingBalance: 0,
    transactions,
    closingBalance: toMoneyNumber(closing),
  };
}

export async function reconcileWallet(
  tx: Transaction,
  companyId: number,
  walletId?: number
): Promise<Array<{ walletId: number; balance: number; ledgerBalance: number; variance: number }>> {
  const res = await tx.query<any>(
    `SELECT w.id,
            w.balance::text AS balance,
            COALESCE(SUM(CASE WHEN t.direction = 'credit' THEN t.amount ELSE -t.amount END), 0)::text AS ledger_balance
       FROM customer_wallets w
       LEFT JOIN customer_wallet_transactions t
         ON t.company_id = w.company_id AND t.wallet_id = w.id
      WHERE w.company_id = $1
        AND ($2::BIGINT IS NULL OR w.id = $2)
      GROUP BY w.id, w.balance`,
    [companyId, walletId ?? null]
  );

  return res.rows.map((r: any) => {
    const balance = toMoneyNumber(parseDecimal4(String(r.balance)));
    const ledger = toMoneyNumber(parseDecimal4(String(r.ledger_balance)));
    return {
      walletId: Number(r.id),
      balance,
      ledgerBalance: ledger,
      variance: Math.round((balance - ledger) * 10000) / 10000,
    };
  });
}

export async function setWalletStatus(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { walletId: number; status: 'active' | 'frozen' | 'closed'; reason?: string | null }
): Promise<void> {
  const locked = await lockWallet(tx, companyId, Number(input.walletId));

  if (input.status === 'closed') {
    if (locked.balance > 0n) {
      throw new AccountingError(409, 'Wallet must have zero balance before closure', 'WALLET_NOT_ZERO');
    }
    const active = await tx.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM customer_wallet_allocations
        WHERE company_id = $1 AND wallet_id = $2 AND status = 'active'
          AND (amount - consumed_amount - released_amount - forfeited_amount) > 0`,
      [companyId, locked.id]
    );
    if (Number(active.rows[0]?.cnt || 0) > 0) {
      throw new AccountingError(409, 'Wallet has active allocations', 'WALLET_HAS_ALLOCATIONS');
    }
  }

  await tx.query(
    `UPDATE customer_wallets SET status = $3, version = version + 1
      WHERE company_id = $1 AND id = $2`,
    [companyId, locked.id, input.status]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CUSTOMER_WALLET_STATUS_CHANGED',
    tableName: 'customer_wallets',
    recordId: locked.id,
    oldValues: { status: locked.status },
    newValues: { status: input.status, reason: input.reason ?? null },
  });
}