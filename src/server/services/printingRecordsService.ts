import crypto from 'node:crypto';
import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, type ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';
import { writeAuditLog } from '../audit.ts';
import {
  allocateWalletFunds,
  getOrCreateWallet,
  recordWalletDeposit,
  refundWallet,
  releaseWalletAllocation,
} from './customerWalletService.ts';
import {
  approveJobBudget,
  cancelPrintingJob,
  createDeliveryNote,
  createPrintingJob,
  issueJobMaterials,
  recordProductionOperation,
  recordQualityInspection,
  reserveJobMaterials,
} from './productionService.ts';
import { divRoundBigInt, resolveWorkflowAccounts } from './commercialHelpers.ts';
import { hasPermission } from '../permissions.ts';
import {
  assertTransition,
  isImmutable,
  type PrintingContractStatus,
} from './contractLifecycle.ts';

/**
 * Server-owned printing production records: prepaid school retainers and
 * examination print batches.
 *
 * Both used to live only in the browser cache. The contract deposit is a real
 * balance-sheet movement (cash in, unearned revenue), so it is posted here.
 */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Atomically claims an idempotency key in the same transaction as the contract
 * mutation. Mirrors the wallet service pattern: insert with status 202/NULL,
 * then finalize the response before COMMIT. A concurrent request blocks on the
 * unique index and either replays the committed body or returns 409.
 */
async function claimPrintingIdempotency(
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
    if (existing.rows.length === 0) continue;

    const row = existing.rows[0];
    if (row.actor_user_id != null && Number(row.actor_user_id) !== Number(actorUserId)) {
      throw new AccountingError(409, 'Idempotency key belongs to another user', 'IDEMPOTENCY_ACTOR_CONFLICT');
    }
    if (row.payload_hash !== payloadHash) {
      throw new AccountingError(409, 'Idempotency key reused with a different payload', 'IDEMPOTENCY_CONFLICT');
    }
    if (row.status_code === 202 || row.response_json == null) {
      throw new AccountingError(409, 'A request with this idempotency key is still in progress', 'IDEMPOTENCY_IN_PROGRESS');
    }
    return { replay: { status: row.status_code, body: row.response_json } };
  }

  throw new AccountingError(409, 'Idempotency key could not be claimed', 'IDEMPOTENCY_CONFLICT');
}

async function completePrintingIdempotency(
  tx: Transaction,
  companyId: number,
  route: string,
  idempotencyKey: string | null | undefined,
  statusCode: number,
  body: unknown
): Promise<void> {
  const key = idempotencyKey?.trim().slice(0, 128);
  if (!key) return;
  await tx.query(
    `UPDATE request_keys
        SET status_code = $3, response_json = $4::jsonb
      WHERE company_id = $1 AND route = $2 AND idempotency_key = $5
        AND status_code = 202`,
    [companyId, route, statusCode, JSON.stringify(body ?? {}), key]
  );
}

function assertIsoDate(value: unknown, field: string): string {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AccountingError(400, `${field} must be YYYY-MM-DD`, 'INVALID_DATE');
  }
  // Reject impossible calendar dates (e.g. 2026-02-30) that would otherwise
  // surface later as an opaque Postgres cast error (G-16).
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new AccountingError(400, `${field} is not a valid calendar date`, 'INVALID_DATE');
  }
  return raw;
}

/**
 * Collision-safe company/year document number backed by printing_number_counters (G-13).
 *
 * `next_printing_number()` verifies `app.current_company_id` matches the requested
 * company, so callers that run outside `withCompanyDb` (system transactions in
 * tests and seeds) still allocate the right tenant's counter.
 */
async function nextPrintingNumber(
  tx: Transaction,
  companyId: number,
  scope: 'contract' | 'exam_paper',
  prefix: string,
  minPaddedWidth: number
): Promise<string> {
  const yearRes = await tx.query<{ year: number }>(
    `SELECT EXTRACT(YEAR FROM CURRENT_DATE)::INT AS year`
  );
  const year = Number(yearRes.rows[0]?.year || new Date().getFullYear());
  await tx.query(`SELECT set_config('app.current_company_id', $1, true)`, [String(companyId)]);
  const res = await tx.query<{ number: string }>(
    `SELECT next_printing_number($1, $2, $3, $4, $5) AS number`,
    [companyId, scope, year, prefix, minPaddedWidth]
  );
  const number = String(res.rows[0]?.number || '').trim();
  if (!number) {
    throw new AccountingError(500, 'Failed to allocate a printing document number', 'NUMBERING_FAILED');
  }
  return number;
}

/**
 * Resolves the unearned-revenue liability account from an explicit code list.
 * There is deliberately no "pick any liability" fallback: posting contract
 * money to an unrelated payroll or long-term liability account would silently
 * corrupt the balance sheet (G-20).
 */
async function resolveLiabilityAccount(tx: Transaction, companyId: number): Promise<number> {
  const byCode = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = TRUE AND code = ANY($2::TEXT[])
      ORDER BY array_position($2::TEXT[], code)
      LIMIT 1`,
    [companyId, ['2250', '2200', '2100', '2300']]
  );
  if (byCode.rows.length > 0) return Number(byCode.rows[0].id);

  throw new AccountingError(
    400,
    'No unearned-revenue liability account is configured for this company',
    'NO_CONTRACT_LIABILITY_ACCOUNT'
  );
}

/**
 * Resolves the earned-revenue income account from an explicit code list. No
 * generic "any income account" fallback (G-20).
 */
async function resolveIncomeAccount(tx: Transaction, companyId: number): Promise<number> {
  const byCode = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = TRUE AND code = ANY($2::TEXT[])
      ORDER BY array_position($2::TEXT[], code)
      LIMIT 1`,
    [companyId, ['4000', '4010', '4900']]
  );
  if (byCode.rows.length > 0) return Number(byCode.rows[0].id);

  throw new AccountingError(
    400,
    'No sales/income account is configured for this company',
    'NO_INCOME_ACCOUNT'
  );
}

export interface ContractAssessmentInput {
  assessmentNumber: number;
  label: string;
  scheduledDate: string;
  agreedAmount: string | number;
  rawPaperItemId?: number | null;
  rawTonerItemId?: number | null;
  estimatedSheets?: string | number | null;
  estimatedImpressions?: string | number | null;
  paperCost?: string | number | null;
  tonerCost?: string | number | null;
}

export interface CreatePrintingContractInput {
  schoolCustomerId: number;
  title: string;
  academicYear: string;
  startDate: string;
  endDate: string;
  totalPrepaidAmount: string | number;
  totalAssessments: number;
  depositBankAccountId: number;
  notes?: string | null;
  assessments: ContractAssessmentInput[];
  renewalOfContractId?: number | null;
  idempotencyKey?: string | null;
}

/**
 * Enforces the assessment-allocation invariant against the prepaid total (G-08).
 *
 * - `exact = true`  → SUM(agreed_amount) must equal total_prepaid_amount.
 *   Used at creation and activation, where every kwacha of the retainer must be
 *   assigned to a dated milestone before the contract can be funded.
 * - `exact = false` → SUM(agreed_amount) must not exceed total_prepaid_amount.
 *   Used for later reassessment, where leaving an explicit unallocated residual
 *   is legal (it is surfaced as `unallocated_amount` and settled explicitly).
 */
async function assertAssessmentAllocation(
  tx: Transaction,
  companyId: number,
  contractId: number,
  totalPrepaid: string | bigint,
  options: { exact: boolean }
): Promise<{ allocated: bigint; prepaid: bigint }> {
  const sumRes = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(agreed_amount), 0)::text AS total
       FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2`,
    [companyId, contractId]
  );
  const allocated = parseDecimal4(sumRes.rows[0]?.total || '0');
  const prepaid = typeof totalPrepaid === 'bigint' ? totalPrepaid : parseDecimal4(totalPrepaid);

  if (options.exact) {
    if (allocated !== prepaid) {
      throw new AccountingError(
        400,
        `Assessment allocation (${formatDecimal4(allocated)}) must equal the prepaid amount (${formatDecimal4(prepaid)})`,
        'ASSESSMENT_SUM_MISMATCH'
      );
    }
  } else if (allocated > prepaid) {
    throw new AccountingError(
      400,
      `Assessment allocation (${formatDecimal4(allocated)}) exceeds the prepaid amount (${formatDecimal4(prepaid)})`,
      'ASSESSMENT_SUM_EXCEEDS_PREPAID'
    );
  }

  return { allocated, prepaid };
}

export async function createPrintingContract(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: CreatePrintingContractInput
) {
  const schoolCustomerId = Number(input.schoolCustomerId);
  if (!Number.isInteger(schoolCustomerId) || schoolCustomerId <= 0) {
    throw new AccountingError(400, 'A school customer is required', 'INVALID_CUSTOMER');
  }
  const title = String(input.title || '').trim();
  if (!title) throw new AccountingError(400, 'Contract title is required', 'TITLE_REQUIRED');

  const startDate = assertIsoDate(input.startDate, 'startDate');
  const endDate = assertIsoDate(input.endDate, 'endDate');
  if (endDate < startDate) {
    throw new AccountingError(400, 'endDate cannot be earlier than startDate', 'INVALID_DATE_RANGE');
  }

  const totalPrepaid = parseDecimal4(input.totalPrepaidAmount);
  if (totalPrepaid <= 0n) {
    throw new AccountingError(400, 'totalPrepaidAmount must be greater than zero', 'INVALID_AMOUNT');
  }

  const totalAssessments = Number(input.totalAssessments);
  if (!Number.isInteger(totalAssessments) || totalAssessments < 2 || totalAssessments > 5) {
    throw new AccountingError(400, 'totalAssessments must be between 2 and 5', 'INVALID_ASSESSMENT_COUNT');
  }

  const depositBankAccountId = Number(input.depositBankAccountId);
  if (!Number.isInteger(depositBankAccountId) || depositBankAccountId <= 0) {
    throw new AccountingError(400, 'A deposit bank account is required', 'INVALID_BANK_ACCOUNT');
  }

  const bankCheck = await tx.query<{ id: number; account_type: string }>(
    `SELECT id, account_type FROM accounts WHERE company_id = $1 AND id = $2 AND is_active = TRUE`,
    [companyId, depositBankAccountId]
  );
  if (bankCheck.rows.length === 0 || bankCheck.rows[0].account_type !== 'Bank') {
    throw new AccountingError(400, 'The deposit account must be an active Bank account', 'INVALID_BANK_ACCOUNT');
  }

  const custCheck = await tx.query<{ id: number }>(
    `SELECT id FROM customers WHERE company_id = $1 AND id = $2`,
    [companyId, schoolCustomerId]
  );
  if (custCheck.rows.length === 0) {
    throw new AccountingError(404, 'School customer not found in active company', 'CUSTOMER_NOT_FOUND');
  }

  const assessments = Array.isArray(input.assessments) ? input.assessments : [];
  if (assessments.length !== totalAssessments) {
    throw new AccountingError(
      400,
      `Expected ${totalAssessments} assessment milestone(s) but received ${assessments.length}`,
      'ASSESSMENT_COUNT_MISMATCH'
    );
  }

  // Reject duplicate assessment numbers and out-of-window scheduled dates before
  // any write (G-08, G-16).
  const seenNumbers = new Set<number>();
  for (const a of assessments) {
    const n = Number(a.assessmentNumber);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw new AccountingError(400, 'assessmentNumber must be between 1 and 5', 'INVALID_ASSESSMENT_NUMBER');
    }
    if (seenNumbers.has(n)) {
      throw new AccountingError(409, `Assessment #${n} appears more than once`, 'ASSESSMENT_EXISTS');
    }
    seenNumbers.add(n);
    const scheduled = assertIsoDate(a.scheduledDate, 'scheduledDate');
    if (scheduled < startDate || scheduled > endDate) {
      throw new AccountingError(
        400,
        `Assessment #${n} scheduled date ${scheduled} is outside the contract window ${startDate}..${endDate}`,
        'ASSESSMENT_DATE_OUT_OF_RANGE'
      );
    }
  }

  // The liability account must exist up front so the contract is fundable later.
  const liabilityAccountId = await resolveLiabilityAccount(tx, companyId);

  // Exact-sum invariant at creation: every kwacha of the retainer must be
  // assigned to a milestone before the contract can be funded (G-08).
  const projectedSum = assessments.reduce((sum, a) => sum + parseDecimal4(a.agreedAmount ?? 0), 0n);
  if (projectedSum !== totalPrepaid) {
    throw new AccountingError(
      400,
      `Assessment allocation (${formatDecimal4(projectedSum)}) must equal the prepaid amount (${formatDecimal4(totalPrepaid)})`,
      'ASSESSMENT_SUM_MISMATCH'
    );
  }

  const claim = await claimPrintingIdempotency(
    tx,
    companyId,
    'printing_contract_create',
    input.idempotencyKey,
    actor.userId,
    {
      schoolCustomerId,
      title,
      academicYear: String(input.academicYear || '').trim() || `${startDate.slice(0, 4)}`,
      startDate,
      endDate,
      totalPrepaidAmount: formatDecimal4(totalPrepaid),
      totalAssessments,
      depositBankAccountId,
      notes: input.notes ?? null,
      renewalOfContractId: input.renewalOfContractId ?? null,
      assessments: assessments.map(a => ({
        assessmentNumber: Number(a.assessmentNumber),
        label: String(a.label || `Assessment ${a.assessmentNumber}`),
        scheduledDate: a.scheduledDate,
        agreedAmount: formatDecimal4(parseDecimal4(a.agreedAmount ?? 0)),
      })),
    }
  );
  if (claim.replay) {
    return { ...claim.replay.body, idempotentReplay: true } as any;
  }

  // Contracts are always created as drafts. Funding happens later, from the
  // customer wallet, so that every active contract is backed by real cash
  // (D-1 / G-05).
  const contractNumber = await nextPrintingNumber(tx, companyId, 'contract', 'CTR-', 4);

  const contractIns = await tx.query<{ id: number }>(
    `INSERT INTO printing_contracts (
       company_id, contract_number, school_customer_id, title, academic_year,
       start_date, end_date, total_prepaid_amount, total_assessments,
       remaining_balance, completed_assessments, deposit_bank_account_id,
       liability_account_id, deposit_journal_txn_id, status, notes,
       renewal_of_contract_id, activated_at, activated_by
     ) VALUES ($1, $2, $3, $4, $5, $6::DATE, $7::DATE, $8::NUMERIC(19,4), $9,
               $8::NUMERIC(19,4), 0, $10, $11, NULL, 'draft', $12, $13, NULL, NULL)
     RETURNING id`,
    [
      companyId,
      contractNumber,
      schoolCustomerId,
      title,
      String(input.academicYear || '').trim() || `${startDate.slice(0, 4)}`,
      startDate,
      endDate,
      formatDecimal4(totalPrepaid),
      totalAssessments,
      depositBankAccountId,
      liabilityAccountId,
      input.notes ?? null,
      input.renewalOfContractId ?? null,
    ]
  );
  const contractId = Number(contractIns.rows[0].id);

  for (const a of assessments) {
    const paperCost = parseDecimal4(a.paperCost ?? 0);
    const tonerCost = parseDecimal4(a.tonerCost ?? 0);
    await tx.query(
      `INSERT INTO contract_assessment_milestones (
         company_id, contract_id, assessment_number, label, scheduled_date, agreed_amount,
         raw_paper_item_id, raw_toner_item_id, estimated_sheets, estimated_impressions,
         paper_cost, toner_cost, status
       ) VALUES ($1, $2, $3, $4, $5::DATE, $6::NUMERIC(19,4), $7, $8, $9::NUMERIC(19,6),
                 $10::NUMERIC(19,6), $11::NUMERIC(19,4), $12::NUMERIC(19,4), 'pending')`,
      [
        companyId,
        contractId,
        Number(a.assessmentNumber),
        String(a.label || `Assessment ${a.assessmentNumber}`),
        assertIsoDate(a.scheduledDate, 'scheduledDate'),
        formatDecimal4(parseDecimal4(a.agreedAmount ?? 0)),
        a.rawPaperItemId ? Number(a.rawPaperItemId) : null,
        a.rawTonerItemId ? Number(a.rawTonerItemId) : null,
        formatDecimal4(parseDecimal4(a.estimatedSheets ?? 0)),
        formatDecimal4(parseDecimal4(a.estimatedImpressions ?? 0)),
        formatDecimal4(paperCost),
        formatDecimal4(tonerCost),
      ]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_CREATED',
    tableName: 'printing_contracts',
    recordId: contractId,
    newValues: {
      contractNumber,
      title,
      schoolCustomerId,
      totalPrepaidAmount: formatDecimal4(totalPrepaid),
      totalAssessments,
      status: 'draft',
      journalTransactionId: null,
    },
  });

  const result = {
    contractId,
    contractNumber,
    liabilityAccountId,
    status: 'draft' as const,
    depositJournalTransactionId: null as number | null,
    entryNumber: null as string | null,
    remainingBalance: formatDecimal4(totalPrepaid),
    idempotentReplay: false,
  };

  await completePrintingIdempotency(
    tx,
    companyId,
    'printing_contract_create',
    input.idempotencyKey,
    201,
    result
  );

  return result;
}

/** Returns the wallet allocation backing a contract, if any (G-03, G-27). */
async function findContractAllocation(
  tx: Transaction,
  companyId: number,
  contractId: number
): Promise<{ id: number; amount: string; walletId: number; status: string } | null> {
  const res = await tx.query<{ id: number; amount: string; wallet_id: number; status: string }>(
    `SELECT id, amount::text AS amount, wallet_id, status
       FROM customer_wallet_allocations
      WHERE company_id = $1 AND contract_id = $2 AND allocation_type = 'contract'
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE`,
    [companyId, contractId]
  );
  if (res.rows.length === 0) return null;
  return {
    id: Number(res.rows[0].id),
    amount: String(res.rows[0].amount),
    walletId: Number(res.rows[0].wallet_id),
    status: String(res.rows[0].status),
  };
}

/**
 * Funds a draft contract from the customer wallet (G-03, G-05).
 *
 * This is the only way a contract becomes funded. It must be called before
 * activation; the allocation is created with `increaseContractTotals: false`
 * because the contract already carries the prepaid total from creation.
 */
export async function fundContractFromWallet(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: { idempotencyKey?: string | null; notes?: string | null } = {}
) {
  const row = await loadContract(tx, companyId, contractId, true);
  if (row.status !== 'draft') {
    throw new AccountingError(409, 'Only draft contracts can be funded', 'CONTRACT_NOT_DRAFT');
  }

  const totalPrepaid = parseDecimal4(row.total_prepaid_amount);

  // A contract is funded once, for its full prepaid total. Refusing a second
  // allocation here keeps the wallet allocation and the contract totals in step;
  // additional money is added through the explicit top-up path (G-18).
  const alreadyAllocatedRes = await tx.query<{ allocated: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS allocated
       FROM customer_wallet_allocations
      WHERE company_id = $1 AND contract_id = $2 AND allocation_type = 'contract'`,
    [companyId, contractId]
  );
  const alreadyAllocated = parseDecimal4(alreadyAllocatedRes.rows[0]?.allocated || '0');
  if (alreadyAllocated >= totalPrepaid) {
    throw new AccountingError(
      409,
      `Contract is already funded for ${formatDecimal4(alreadyAllocated)}. Use a top-up to add funds.`,
      'CONTRACT_ALREADY_FUNDED'
    );
  }
  const remainingToFund = totalPrepaid - alreadyAllocated;

  const wallet = await getOrCreateWallet(tx, companyId, Number(row.school_customer_id));

  const allocation = await allocateWalletFunds(tx, companyId, actor, {
    customerId: Number(row.school_customer_id),
    walletId: wallet.walletId,
    contractId,
    amount: formatDecimal4(remainingToFund),
    idempotencyKey: input.idempotencyKey ?? null,
    allowDraft: true,
    increaseContractTotals: false,
    notes: input.notes ?? 'Contract funding allocation',
  });

  await tx.query(
    `UPDATE printing_contracts
        SET allocated_amount = $3::NUMERIC(19,4)
      WHERE company_id = $1 AND id = $2`,
    [companyId, contractId, formatDecimal4(totalPrepaid)]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_FUNDED',
    tableName: 'printing_contracts',
    recordId: contractId,
    newValues: {
      contractNumber: row.contract_number,
      amount: formatDecimal4(remainingToFund),
      allocationId: allocation.allocationId,
      walletTransactionId: allocation.walletTransaction.id,
      journalTransactionId: allocation.walletTransaction.journalTxnId,
    },
  });

  return {
    allocationId: allocation.allocationId,
    amount: formatDecimal4(remainingToFund),
    walletTransactionId: allocation.walletTransaction.id,
    journalTransactionId: allocation.walletTransaction.journalTxnId,
  };
}

/**
 * Records a pending `contract_activation` approval request (G-03).
 *
 * Nothing else creates these rows, so without this producer activation is
 * unreachable through the API and a draft contract can never be activated.
 */
export async function requestContractActivation(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: { reason?: string; amount?: string | number; payload?: unknown } = {}
) {
  const row = await loadContract(tx, companyId, contractId);
  if (row.status !== 'draft') {
    throw new AccountingError(409, 'Only draft contracts can be submitted for activation', 'CONTRACT_NOT_DRAFT');
  }

  const reason = String(input.reason || '').trim() || 'Contract activation';
  const payload = input.payload ?? { contractId, reason };
  const payloadHash = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
  const todayRes = await tx.query<{ today: string }>(`SELECT CURRENT_DATE::TEXT AS today`);

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO approval_requests (
       company_id, action_type, entity_type, entity_id, amount, requested_by,
       status, payload_json, business_date, payload_hash
     ) VALUES ($1, 'contract_activation', 'printing_contract', $2, $3, $4, 'pending', $5::jsonb, $6::DATE, $7)
     RETURNING id`,
    [
      companyId,
      contractId,
      formatDecimal4(parseDecimal4(input.amount ?? row.total_prepaid_amount)),
      actor.userId,
      JSON.stringify(payload),
      todayRes.rows[0].today,
      payloadHash,
    ]
  );

  const requestId = Number(ins.rows[0].id);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_ACTIVATION_REQUESTED',
    tableName: 'approval_requests',
    recordId: requestId,
    newValues: { contractId, contractNumber: row.contract_number, reason },
  });

  return { requestId, status: 'pending' as const };
}

async function resolveForfeitureIncomeAccount(tx: Transaction, companyId: number): Promise<number> {
  const res = await tx.query<{ id: number; code: string | null; name: string }>(
    `SELECT id, code, name
       FROM accounts
      WHERE company_id = $1
        AND is_active = TRUE
        AND (code = '4900' OR detail_type = 'other_income')
      ORDER BY (code = '4900') DESC, id ASC
      LIMIT 1`,
    [companyId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(
      400,
      'No active Other Income account (4900 / other_income) is configured for forfeiture',
      'NO_FORFEITURE_INCOME_ACCOUNT'
    );
  }
  return Number(res.rows[0].id);
}

export async function recordContractAcceptance(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: {
    method: 'drawn' | 'otp' | 'upload';
    signerName: string;
    signerEmail?: string | null;
    signerPhone?: string | null;
    documentVersion: string;
    evidenceFileId?: number | null;
    otpVerified?: boolean;
    outcome?: 'accepted' | 'rejected';
    ipAddress?: string | null;
  }
) {
  const contract = await loadContract(tx, companyId, contractId);
  const signerName = String(input.signerName || '').trim();
  if (!signerName) throw new AccountingError(400, 'Signer name is required', 'SIGNER_REQUIRED');
  const documentVersion = String(input.documentVersion || '').trim();
  if (!documentVersion) {
    throw new AccountingError(400, 'Document version is required', 'DOCUMENT_VERSION_REQUIRED');
  }
  const outcome = input.outcome === 'rejected' ? 'rejected' : 'accepted';
  const otpVerifiedAt =
    input.method === 'otp' && input.otpVerified ? new Date().toISOString() : null;

  const ins = await tx.query<{ id: number; accepted_at: string }>(
    `INSERT INTO contract_acceptances (
       company_id, contract_id, method, signer_name, signer_email, signer_phone,
       document_version, evidence_file_id, otp_verified_at, outcome, ip_address, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, accepted_at`,
    [
      companyId,
      contractId,
      input.method,
      signerName,
      input.signerEmail?.trim() || null,
      input.signerPhone?.trim() || null,
      documentVersion,
      input.evidenceFileId ?? null,
      otpVerifiedAt,
      outcome,
      input.ipAddress?.trim() || null,
      actor.userId,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_ACCEPTANCE_RECORDED',
    tableName: 'contract_acceptances',
    recordId: Number(ins.rows[0].id),
    newValues: {
      contractId,
      contractNumber: contract.contract_number,
      method: input.method,
      signerName,
      documentVersion,
      outcome,
      otpVerifiedAt,
    },
  });

  return {
    id: Number(ins.rows[0].id),
    contractId,
    method: input.method,
    outcome,
    acceptedAt: String(ins.rows[0].accepted_at),
  };
}

export async function activatePrintingContract(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number
) {
  const row = await loadContract(tx, companyId, contractId, true);

  if (row.status === 'active') {
    return getPrintingContract(tx, companyId, contractId);
  }
  if (row.status !== 'draft') {
    throw new AccountingError(409, 'Only draft contracts can be activated', 'CONTRACT_NOT_DRAFT');
  }
  // The lifecycle matrix (contractLifecycle.ts) is the single authority on which
  // roles may perform a transition; the status guard above preserves the precise
  // CONTRACT_NOT_DRAFT error for callers.
  assertTransition(row.status as PrintingContractStatus, 'ACTIVATE', 'active', actor.role);

  // Exact-sum invariant, enforced through the shared helper (G-08).
  await assertAssessmentAllocation(tx, companyId, contractId, row.total_prepaid_amount, {
    exact: true,
  });

  const acceptance = await tx.query<{ id: number }>(
    `SELECT id FROM contract_acceptances
      WHERE company_id = $1 AND contract_id = $2 AND outcome = 'accepted'
      ORDER BY accepted_at DESC
      LIMIT 1`,
    [companyId, contractId]
  );
  if (acceptance.rows.length === 0) {
    throw new AccountingError(
      409,
      'Customer acceptance is required before activation',
      'CUSTOMER_ACCEPTANCE_REQUIRED'
    );
  }

  const approval = await tx.query<{ id: number }>(
    `SELECT id FROM approval_requests
      WHERE company_id = $1
        AND action_type = 'contract_activation'
        AND entity_type = 'printing_contract'
        AND entity_id = $2
        AND status = 'approved'
        AND consumed_at IS NULL
      ORDER BY decided_at DESC
      LIMIT 1
      FOR UPDATE`,
    [companyId, contractId]
  );
  if (approval.rows.length === 0) {
    throw new AccountingError(
      409,
      'An approved contract activation request is required',
      'ACTIVATION_APPROVAL_REQUIRED'
    );
  }

  // Activation only consumes funding that already exists. It never creates the
  // allocation (G-05): the contract must have been funded from the wallet first.
  const allocation = await findContractAllocation(tx, companyId, contractId);
  if (!allocation) {
    throw new AccountingError(
      409,
      'Contract is not funded. Allocate retainer funds from the customer wallet before activation.',
      'CONTRACT_NOT_FUNDED'
    );
  }

  const allocCheck = await tx.query<{ journal_txn_id: number | null }>(
    `SELECT wt.journal_txn_id
       FROM customer_wallet_transactions wt
      WHERE wt.company_id = $1 AND wt.allocation_id = $2
      ORDER BY wt.id ASC
      LIMIT 1`,
    [companyId, allocation.id]
  );
  const depositJournalTxnId = allocCheck.rows[0]?.journal_txn_id ?? null;

  await tx.query(
    `UPDATE printing_contracts
        SET status = 'active',
            activated_at = NOW(),
            activated_by = $3,
            deposit_journal_txn_id = $4,
            allocated_amount = $6::NUMERIC(19,4),
            customer_acceptance_id = $5
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      contractId,
      actor.userId,
      depositJournalTxnId,
      Number(acceptance.rows[0].id),
      allocation.amount,
    ]
  );

  await tx.query(
    `UPDATE approval_requests
        SET consumed_at = NOW()
      WHERE company_id = $1 AND id = $2 AND consumed_at IS NULL`,
    [companyId, Number(approval.rows[0].id)]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_ACTIVATED',
    tableName: 'printing_contracts',
    recordId: contractId,
    oldValues: { status: 'draft' },
    newValues: {
      status: 'active',
      acceptanceId: Number(acceptance.rows[0].id),
      allocationId: allocation.id,
      allocatedAmount: allocation.amount,
      journalTransactionId: depositJournalTxnId,
      approvalRequestId: Number(approval.rows[0].id),
    },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export async function suspendContract(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  reason: string
) {
  const row = await loadContract(tx, companyId, contractId, true);
  if (row.status !== 'active') {
    throw new AccountingError(409, 'Only active contracts can be suspended', 'CONTRACT_NOT_ACTIVE');
  }
  assertTransition(row.status as PrintingContractStatus, 'SUSPEND', 'suspended', actor.role);
  const trimmed = String(reason || '').trim();
  if (!trimmed) {
    throw new AccountingError(400, 'A suspension reason is required', 'SUSPENSION_REASON_REQUIRED');
  }

  await tx.query(
    `UPDATE printing_contracts
        SET status = 'suspended',
            suspended_at = NOW(),
            suspended_by = $3,
            suspension_reason = $4
      WHERE company_id = $1 AND id = $2`,
    [companyId, contractId, actor.userId, trimmed]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_SUSPENDED',
    tableName: 'printing_contracts',
    recordId: contractId,
    oldValues: { status: row.status },
    newValues: { status: 'suspended', reason: trimmed },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export async function resumeContract(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number
) {
  const row = await loadContract(tx, companyId, contractId, true);
  if (row.status !== 'suspended') {
    throw new AccountingError(409, 'Only suspended contracts can be resumed', 'CONTRACT_NOT_SUSPENDED');
  }
  assertTransition(row.status as PrintingContractStatus, 'RESUME', 'active', actor.role);

  await tx.query(
    `UPDATE printing_contracts
        SET status = 'active',
            resumed_at = NOW(),
            resumed_by = $3
      WHERE company_id = $1 AND id = $2`,
    [companyId, contractId, actor.userId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_RESUMED',
    tableName: 'printing_contracts',
    recordId: contractId,
    oldValues: { status: row.status },
    newValues: { status: 'active' },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export async function cancelPrintingContract(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: {
    reason: string;
    settlementMode?: 'refund' | 'forfeit' | null;
    refundBankAccountId?: number | null;
  }
) {
  const row = await loadContract(tx, companyId, contractId, true);
  if (row.status === 'cancelled') {
    throw new AccountingError(409, 'Contract is already cancelled', 'CONTRACT_ALREADY_CANCELLED');
  }
  if (!['active', 'suspended', 'completed'].includes(row.status)) {
    throw new AccountingError(409, 'Contract cannot be cancelled in its current status', 'INVALID_CONTRACT_STATUS');
  }
  assertTransition(row.status as PrintingContractStatus, 'VOID', 'cancelled', actor.role);
  const reason = String(input.reason || '').trim();
  if (!reason) {
    throw new AccountingError(400, 'A cancellation reason is required', 'CANCELLATION_REASON_REQUIRED');
  }

  const remaining = parseDecimal4(row.remaining_balance);
  let settlementMode: 'refund' | 'forfeit' | null = input.settlementMode ?? null;
  let settledAmount = 0n;
  let settlementJournalId: number | null = null;

  if (remaining > 0n) {
    if (!settlementMode) {
      throw new AccountingError(400, 'Settlement mode is required when a balance remains', 'SETTLEMENT_MODE_REQUIRED');
    }

    const wallet = await getOrCreateWallet(tx, companyId, Number(row.school_customer_id));
    const alloc = await tx.query<{ id: number }>(
      `SELECT id FROM customer_wallet_allocations
        WHERE company_id = $1 AND contract_id = $2 AND allocation_type = 'contract'
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE`,
      [companyId, contractId]
    );
    if (alloc.rows.length === 0) {
      throw new AccountingError(409, 'Contract allocation not found', 'CONTRACT_ALLOCATION_NOT_FOUND');
    }
    const allocationId = Number(alloc.rows[0].id);

    if (settlementMode === 'refund') {
      if (!input.refundBankAccountId) {
        throw new AccountingError(400, 'Refund bank account is required', 'REFUND_BANK_ACCOUNT_REQUIRED');
      }

      await releaseWalletAllocation(tx, companyId, actor, {
        customerId: Number(row.school_customer_id),
        walletId: wallet.walletId,
        allocationId,
        amount: formatDecimal4(remaining),
        idempotencyKey: `contract-cancel-${contractId}-release`,
        notes: `Release for cancellation: ${reason}`,
      });

      const refund = await refundWallet(tx, companyId, actor, {
        customerId: Number(row.school_customer_id),
        walletId: wallet.walletId,
        amount: formatDecimal4(remaining),
        bankAccountId: Number(input.refundBankAccountId),
        idempotencyKey: `contract-cancel-${contractId}-refund`,
        memo: `Contract cancellation refund: ${reason}`,
      });

      settledAmount = remaining;
      settlementJournalId = refund.walletTransaction.journalTxnId;
    } else {
      const todayRes = await tx.query<{ today: string }>(`SELECT CURRENT_DATE::TEXT AS today`);
      const today = todayRes.rows[0].today;
      const forfeitureIncomeAccountId = await resolveForfeitureIncomeAccount(tx, companyId);

      const posted = await postJournalEntry(tx, companyId, actor, {
        txnDate: today,
        description: `Contract ${row.contract_number} forfeiture — ${reason}`,
        reference: row.contract_number,
        sourceType: 'printing_contract',
        sourceId: contractId,
        idempotencyKey: `contract-forfeit-${contractId}`,
        lines: [
          {
            accountId: Number(row.liability_account_id),
            debit: formatDecimal4(remaining),
            credit: '0.0000',
            description: 'Forfeit unearned contract liability',
          },
          {
            accountId: forfeitureIncomeAccountId,
            debit: '0.0000',
            credit: formatDecimal4(remaining),
            description: 'Contract forfeiture income',
          },
        ],
      });

      await tx.query(
        `UPDATE customer_wallet_allocations
            SET forfeited_amount = forfeited_amount + $3::NUMERIC(19,4),
                status = CASE
                  WHEN forfeited_amount + $3 + consumed_amount + released_amount >= amount
                  THEN 'cancelled' ELSE status END
          WHERE company_id = $1 AND id = $2`,
        [companyId, allocationId, formatDecimal4(remaining)]
      );

      settledAmount = remaining;
      settlementJournalId = posted.transaction.id;
    }
  }

  await tx.query(
    `UPDATE printing_contracts
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancelled_by = $3,
            cancellation_reason = $4,
            settlement_mode = $5,
            settled_amount = $6::NUMERIC(19,4),
            settlement_journal_txn_id = $7,
            remaining_balance = 0
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      contractId,
      actor.userId,
      reason,
      settlementMode,
      formatDecimal4(settledAmount),
      settlementJournalId,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_CANCELLED',
    tableName: 'printing_contracts',
    recordId: contractId,
    oldValues: { status: row.status, remainingBalance: formatDecimal4(remaining) },
    newValues: {
      status: 'cancelled',
      reason,
      settlementMode,
      settledAmount: formatDecimal4(settledAmount),
      settlementJournalTxnId: settlementJournalId,
    },
  });

  return getPrintingContract(tx, companyId, contractId);
}

/**
 * Void a contract as a compensating reversal for one raised in error.
 *
 * Distinct from `cancelPrintingContract`:
 *   - cancel settles a remaining balance by refunding to the bank or
 *     forfeiting to income;
 *   - void returns any unallocated retainer to the customer wallet (the exact
 *     inverse of the funding allocation) and posts no income/forfeit.
 *
 * Void is only permitted while nothing has been consumed
 * (`completed_assessments = 0`) and a positive balance remains, is idempotent
 * (a second void is a 409), and is terminal.
 */
export async function voidPrintingContract(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: { reason: string }
) {
  const row = await loadContract(tx, companyId, contractId, true);
  if (row.status === 'voided') {
    throw new AccountingError(409, 'Contract is already voided', 'CONTRACT_ALREADY_VOIDED');
  }
  if (!['draft', 'active', 'suspended'].includes(row.status)) {
    throw new AccountingError(
      409,
      'Contract cannot be voided in its current status',
      'INVALID_CONTRACT_STATUS'
    );
  }
  assertTransition(row.status as PrintingContractStatus, 'VOID', 'voided', actor.role);

  const reason = String(input.reason || '').trim();
  if (!reason) {
    throw new AccountingError(400, 'A void reason is required', 'VOID_REASON_REQUIRED');
  }
  if (Number(row.completed_assessments) > 0) {
    throw new AccountingError(
      409,
      'A contract with completed assessments cannot be voided; cancel it instead',
      'CONTRACT_HAS_COMPLETED_ASSESSMENTS'
    );
  }

  const remaining = parseDecimal4(row.remaining_balance);
  if (remaining <= 0n) {
    throw new AccountingError(
      409,
      'There is no remaining retainer to void',
      'NOTHING_TO_VOID'
    );
  }

  const wallet = await getOrCreateWallet(tx, companyId, Number(row.school_customer_id));
  const alloc = await tx.query<{ id: number }>(
    `SELECT id FROM customer_wallet_allocations
      WHERE company_id = $1 AND contract_id = $2 AND allocation_type = 'contract'
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE`,
    [companyId, contractId]
  );
  if (alloc.rows.length === 0) {
    throw new AccountingError(409, 'Contract allocation not found', 'CONTRACT_ALLOCATION_NOT_FOUND');
  }
  const allocationId = Number(alloc.rows[0].id);

  await releaseWalletAllocation(tx, companyId, actor, {
    customerId: Number(row.school_customer_id),
    walletId: wallet.walletId,
    allocationId,
    amount: formatDecimal4(remaining),
    idempotencyKey: `contract-void-${contractId}-release`,
    notes: `Void reversal: ${reason}`,
  });

  await tx.query(
    `UPDATE printing_contracts
        SET status = 'voided',
            voided_at = NOW(),
            voided_by = $3,
            void_reason = $4,
            remaining_balance = 0,
            credit_balance = FALSE
      WHERE company_id = $1 AND id = $2`,
    [companyId, contractId, actor.userId, reason]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_VOIDED',
    tableName: 'printing_contracts',
    recordId: contractId,
    oldValues: { status: row.status, remainingBalance: formatDecimal4(remaining) },
    newValues: { status: 'voided', reason, releasedToWallet: formatDecimal4(remaining) },
  });

  return getPrintingContract(tx, companyId, contractId);
}

/**
 * Read-only reconciliation report for printing contracts, grouped by customer.
 *
 * Surfaces commercial value, funding position, document gaps and suspected
 * discrepancies without mutating anything.
 */
export async function getContractReconciliation(tx: Transaction, companyId: number) {
  const res = await tx.query<{
    school_customer_id: string;
    contract_count: string;
    total_value: string;
    consumed: string;
    reserved: string;
    total_assessments: string;
    completed_assessments: string;
    missing_docs: string;
    discrepancies: string;
  }>(
    `SELECT
        school_customer_id::text AS school_customer_id,
        COUNT(*)::text AS contract_count,
        COALESCE(SUM(total_prepaid_amount), 0)::text AS total_value,
        COALESCE(SUM(total_prepaid_amount - remaining_balance), 0)::text AS consumed,
        COALESCE(SUM(remaining_balance), 0)::text AS reserved,
        COALESCE(SUM(total_assessments), 0)::text AS total_assessments,
        COALESCE(SUM(completed_assessments), 0)::text AS completed_assessments,
        COUNT(*) FILTER (WHERE status = 'active' AND deposit_invoice_id IS NULL)::text AS missing_docs,
        COUNT(*) FILTER (WHERE credit_balance = TRUE OR (status = 'completed' AND remaining_balance > 0))::text AS discrepancies
      FROM printing_contracts
     WHERE company_id = $1
     GROUP BY school_customer_id
     ORDER BY school_customer_id ASC`,
    [companyId]
  );

  const customers = res.rows.map(r => ({
    customerId: Number(r.school_customer_id),
    contractCount: Number(r.contract_count),
    totalValue: Number(r.total_value),
    consumed: Number(r.consumed),
    reserved: Number(r.reserved),
    totalAssessments: Number(r.total_assessments),
    completedAssessments: Number(r.completed_assessments),
    missingDocuments: Number(r.missing_docs),
    discrepancies: Number(r.discrepancies),
  }));

  const totals = customers.reduce(
    (acc, c) => ({
      customers: acc.customers + 1,
      contracts: acc.contracts + c.contractCount,
      discrepancies: acc.discrepancies + c.discrepancies,
      missingDocuments: acc.missingDocuments + c.missingDocuments,
      totalValue: acc.totalValue + c.totalValue,
    }),
    { customers: 0, contracts: 0, discrepancies: 0, missingDocuments: 0, totalValue: 0 }
  );

  return { customers, totals };
}

/**
 * List the append-only signature ceremony records for a contract.
 */
export async function listContractSignatures(
  tx: Transaction,
  companyId: number,
  contractId: number
) {
  const res = await tx.query(
    `SELECT id, signer_role, signer_name, method, document_version, signed_at
       FROM contract_signatures
      WHERE company_id = $1 AND contract_id = $2
      ORDER BY signed_at ASC, id ASC`,
    [companyId, contractId]
  );
  return res.rows;
}

/**
 * Record a signature in the contract signing ceremony.
 *
 * The company must sign before the customer, each role signs at most once, and
 * records are append-only (never updated or deleted).
 */
export async function recordContractSignature(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: {
    signerRole: 'company' | 'customer';
    signerName: string;
    method: 'drawn' | 'typed' | 'upload';
    signatureData: string;
    documentVersion?: string | null;
  }
) {
  const contract = await loadContract(tx, companyId, contractId);
  const signerName = String(input.signerName || '').trim();
  if (!signerName) throw new AccountingError(400, 'Signer name is required', 'SIGNER_REQUIRED');
  const signatureData = String(input.signatureData || '').trim();
  if (!signatureData) {
    throw new AccountingError(400, 'Signature data is required', 'SIGNATURE_DATA_REQUIRED');
  }
  if (input.signerRole !== 'company' && input.signerRole !== 'customer') {
    throw new AccountingError(400, 'Invalid signer role', 'INVALID_SIGNER_ROLE');
  }

  const existing = await tx.query<{ signer_role: string }>(
    `SELECT signer_role FROM contract_signatures
      WHERE company_id = $1 AND contract_id = $2
      ORDER BY signed_at ASC, id ASC`,
    [companyId, contractId]
  );
  const roles = existing.rows.map(r => r.signer_role);
  if (roles.includes(input.signerRole)) {
    throw new AccountingError(
      409,
      `The ${input.signerRole} has already signed`,
      'ALREADY_SIGNED'
    );
  }
  if (input.signerRole === 'customer' && !roles.includes('company')) {
    throw new AccountingError(
      409,
      'The company must sign before the customer',
      'COMPANY_SIGNATURE_REQUIRED'
    );
  }

  const ins = await tx.query<{ id: number; signed_at: string }>(
    `INSERT INTO contract_signatures (
       company_id, contract_id, signer_role, signer_name, method, signature_data,
       document_version, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, signed_at`,
    [
      companyId,
      contractId,
      input.signerRole,
      signerName,
      input.method,
      signatureData,
      input.documentVersion?.trim() || null,
      actor.userId,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_SIGNED',
    tableName: 'contract_signatures',
    recordId: Number(ins.rows[0].id),
    newValues: {
      contractId,
      contractNumber: contract.contract_number,
      signerRole: input.signerRole,
      signerName,
      method: input.method,
    },
  });

  return { id: Number(ins.rows[0].id), signedAt: String(ins.rows[0].signed_at) };
}

export interface ExamPaperInput {
  subjectName: string;
  pages: number;
  copies: number;
  teacherCopies?: number;
  plannedProductionQuantity?: number;
  billableQuantity?: number;
  rawPaperItemId: number;
  rawTonerItemId: number;
  printSide?: string;
  bindingType?: string;
  paperSize?: string;
  printingItemId?: number | null;
  machineId?: number | null;
  makeReadySheets?: string | number | null;
  runningWastePct?: string | number | null;
  // Accepted for legacy callers but deliberately ignored: the server computes
  // sheets, impressions and costs from trusted inventory/specification records.
  sheetsUsed?: string | number | null;
  impressionsUsed?: string | number | null;
  paperCost?: string | number | null;
  tonerCost?: string | number | null;
  productionDate?: string | null;
  notes?: string | null;
}

export interface ExamClassInput {
  className: string;
  learnersCount: number;
  pricePerLearner: string | number;
  contractId?: number | null;
  assessmentNumber?: number | null;
  papers: ExamPaperInput[];
}

export interface CreateExamBatchInput {
  schoolCustomerId: number;
  assessmentName: string;
  className?: string;
  learnersCount?: number;
  pricePerLearner?: string | number;
  contractId?: number | null;
  assessmentNumber?: number | null;
  papers?: ExamPaperInput[];
  classes?: ExamClassInput[];
  dueDate?: string | null;
  priority?: string | null;
  idempotencyKey?: string | null;
}

type ExamBatchRow = {
  id: number;
  school_customer_id: number;
  assessment_name: string;
  class_name: string;
  learners_count: number;
  price_per_learner: string;
  contract_id: number | null;
  assessment_number: number | null;
};

function normalizeExamClasses(input: CreateExamBatchInput): ExamClassInput[] {
  const supplied = Array.isArray(input.classes) ? input.classes : [];
  if (supplied.length > 0) return supplied;
  if (!String(input.className || '').trim()) {
    throw new AccountingError(400, 'className is required', 'MISSING_BATCH_FIELDS');
  }
  return [
    {
      className: String(input.className),
      learnersCount: Number(input.learnersCount),
      pricePerLearner: input.pricePerLearner ?? 0,
      contractId: input.contractId ?? null,
      assessmentNumber: input.assessmentNumber ?? null,
      papers: Array.isArray(input.papers) ? input.papers : [],
    },
  ];
}

async function assertExamContract(
  tx: Transaction,
  companyId: number,
  schoolCustomerId: number,
  contractId: number | null,
  assessmentNumber: number | null
): Promise<void> {
  if (contractId == null) return;
  const contract = await tx.query<{
    id: number;
    school_customer_id: number;
    total_assessments: number;
    status: string;
  }>(
    `SELECT id, school_customer_id, total_assessments, status
       FROM printing_contracts
      WHERE company_id = $1 AND id = $2
      FOR SHARE`,
    [companyId, contractId]
  );
  if (contract.rows.length === 0) {
    throw new AccountingError(404, 'Contract not found', 'CONTRACT_NOT_FOUND');
  }
  const c = contract.rows[0];
  if (Number(c.school_customer_id) !== schoolCustomerId) {
    throw new AccountingError(400, 'The contract belongs to a different school', 'CONTRACT_SCHOOL_MISMATCH');
  }
  if (assessmentNumber == null || assessmentNumber < 1 || assessmentNumber > Number(c.total_assessments)) {
    throw new AccountingError(
      400,
      `assessmentNumber must be between 1 and ${c.total_assessments} for this contract`,
      'ASSESSMENT_OUT_OF_RANGE'
    );
  }
  const ms = await tx.query<{ status: string }>(
    `SELECT status FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2 AND assessment_number = $3
      FOR SHARE`,
    [companyId, contractId, assessmentNumber]
  );
  if (ms.rows.length === 0) {
    throw new AccountingError(404, 'Assessment not found on this contract', 'ASSESSMENT_NOT_FOUND');
  }
  if (ms.rows[0].status !== 'pending') {
    throw new AccountingError(409, 'The referenced assessment is no longer pending', 'ASSESSMENT_NOT_PENDING');
  }
  if (c.status !== 'active') {
    throw new AccountingError(409, 'The contract is not active', 'CONTRACT_NOT_ACTIVE');
  }
}

type ExamPaperEventInput = {
  companyId: number;
  batchId: number;
  paperId: number;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorUserId: number | null;
  reason?: string | null;
  quantityDelta?: string | number | null;
  inventoryTxnId?: number | null;
  journalTxnId?: number | null;
  invoiceId?: number | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
};

async function insertExamPaperEvent(tx: Transaction, event: ExamPaperEventInput): Promise<void> {
  await tx.query(
    `INSERT INTO exam_paper_events (
       company_id, batch_id, paper_id, event_type, from_status, to_status,
       actor_user_id, reason, quantity_delta, inventory_txn_id, journal_txn_id,
       invoice_id, idempotency_key, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::NUMERIC(19,6), $10, $11, $12, $13, $14::jsonb)`,
    [
      event.companyId,
      event.batchId,
      event.paperId,
      event.eventType,
      event.fromStatus,
      event.toStatus,
      event.actorUserId,
      event.reason ?? null,
      event.quantityDelta != null ? String(event.quantityDelta) : null,
      event.inventoryTxnId ?? null,
      event.journalTxnId ?? null,
      event.invoiceId ?? null,
      event.idempotencyKey ?? null,
      JSON.stringify(event.metadata ?? {}),
    ]
  );
}

async function createExamProductionJob(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  params: {
    schoolCustomerId: number;
    customerName: string;
    assessmentName: string;
    className: string;
    paper: ExamPaperInput;
    subjectName: string;
    pages: number;
    copies: number;
    teacherCopies?: number;
    printSide: 'Single-Sided' | 'Duplex';
    productionDate: string;
    idempotencyKey: string | null;
  }
) {
  const p = params.paper;
  // D3: the press run produces learner + teacher copies. ordered_qty reflects
  // the full production quantity so produced_qty never exceeds it.
  const teacherCopies = params.teacherCopies != null ? Number(params.teacherCopies) : 0;
  const orderedQty = Number(params.copies) + teacherCopies;
  const job = await createPrintingJob(tx, companyId, actor, {
    jobType: 'exam_paper',
    customerId: params.schoolCustomerId,
    customerName: params.customerName,
    rawPaperItemId: Number(p.rawPaperItemId),
    rawTonerItemId: Number(p.rawTonerItemId),
    machineId: p.machineId ? Number(p.machineId) : null,
    title: `${params.assessmentName} — ${params.className} — ${params.subjectName}`,
    pages: params.pages,
    copies: orderedQty,
    orderedQty,
    printSide: params.printSide,
    makeReadySheets: p.makeReadySheets != null ? Number(p.makeReadySheets) : 0,
    runningWastePct: p.runningWastePct != null ? Number(p.runningWastePct) : 0,
    jobDate: params.productionDate,
    manualSellingPrice: 0,
    notes: p.notes ?? null,
    idempotencyKey: params.idempotencyKey
      ? `${params.idempotencyKey}:exam-job:${params.className}:${params.subjectName}`
      : null,
  });
  return job.job;
}

export async function createExamBatch(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: CreateExamBatchInput
) {
  const route = 'exam_batch_create';
  const claim = await claimPrintingIdempotency(
    tx,
    companyId,
    route,
    input.idempotencyKey,
    actor.userId,
    input
  );
  if (claim.replay) return claim.replay.body.batch;

  const schoolCustomerId = Number(input.schoolCustomerId);
  if (!Number.isInteger(schoolCustomerId) || schoolCustomerId <= 0) {
    throw new AccountingError(400, 'A school customer is required', 'INVALID_CUSTOMER');
  }
  const assessmentName = String(input.assessmentName || '').trim();
  if (!assessmentName) {
    throw new AccountingError(400, 'assessmentName is required', 'MISSING_BATCH_FIELDS');
  }

  const custCheck = await tx.query<{ id: number; company_name: string }>(
    `SELECT id, company_name FROM customers WHERE company_id = $1 AND id = $2`,
    [companyId, schoolCustomerId]
  );
  if (custCheck.rows.length === 0) {
    throw new AccountingError(404, 'School customer not found in active company', 'CUSTOMER_NOT_FOUND');
  }
  const customerName = custCheck.rows[0].company_name;

  const classes = normalizeExamClasses(input);
  const seenClasses = new Set<string>();
  for (const cls of classes) {
    const key = String(cls.className || '').trim().toLowerCase();
    if (!key) throw new AccountingError(400, 'className is required for every class', 'MISSING_BATCH_FIELDS');
    if (seenClasses.has(key)) {
      throw new AccountingError(400, `Duplicate class '${cls.className}' in the same examination submission`, 'DUPLICATE_CLASS');
    }
    seenClasses.add(key);
    if (!Number.isInteger(Number(cls.learnersCount)) || Number(cls.learnersCount) <= 0) {
      throw new AccountingError(400, 'learnersCount must be a positive integer for every class', 'INVALID_LEARNER_COUNT');
    }
    if (!Array.isArray(cls.papers) || cls.papers.length === 0) {
      throw new AccountingError(400, `At least one paper is required for ${cls.className}`, 'NO_PAPERS');
    }
  }

  const priority = ['low', 'normal', 'high', 'urgent'].includes(String(input.priority))
    ? String(input.priority)
    : 'normal';
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = input.dueDate ? assertIsoDate(input.dueDate, 'dueDate') : null;
  if (dueDate && dueDate < today) {
    throw new AccountingError(400, 'dueDate cannot be before today', 'INVALID_DUE_DATE');
  }

  const createdBatches: Array<{
    batchId: number;
    className: string;
    learnersCount: number;
    pricePerLearner: number;
    classRevenue: number;
    dueDate: string | null;
    priority: string;
  }> = [];
  const createdPapers: any[] = [];

  for (const cls of classes) {
    const className = String(cls.className).trim();
    const learnersCount = Number(cls.learnersCount);
    const pricePerLearner = Number(cls.pricePerLearner ?? 0);
    if (!Number.isFinite(pricePerLearner) || pricePerLearner < 0) {
      throw new AccountingError(400, 'pricePerLearner must be a non-negative number', 'INVALID_PRICE');
    }
    const contractId = cls.contractId ? Number(cls.contractId) : null;
    const assessmentNumber = cls.assessmentNumber ? Number(cls.assessmentNumber) : null;
    await assertExamContract(tx, companyId, schoolCustomerId, contractId, assessmentNumber);

    const batchIns = await tx.query<{ id: number }>(
      `INSERT INTO exam_assessment_batches (
         company_id, school_customer_id, assessment_name, class_name, learners_count,
         price_per_learner, contract_id, assessment_number, status, due_date, priority
       ) VALUES ($1, $2, $3, $4, $5, $6::NUMERIC(19,4), $7, $8, 'scheduled', $9::DATE, $10)
       RETURNING id`,
      [
        companyId,
        schoolCustomerId,
        assessmentName,
        className,
        learnersCount,
        formatDecimal4(parseDecimal4(pricePerLearner)),
        contractId,
        assessmentNumber,
        dueDate,
        priority,
      ]
    );
    const batchId = Number(batchIns.rows[0].id);
    createdBatches.push({
      batchId,
      className,
      learnersCount,
      pricePerLearner,
      classRevenue: Math.round(learnersCount * pricePerLearner * 10000) / 10000,
      dueDate,
      priority,
    });

    for (const p of cls.papers) {
      const subjectName = String(p.subjectName || '').trim();
      if (!subjectName) {
        throw new AccountingError(400, 'subjectName is required for every examination paper', 'MISSING_SUBJECT');
      }
      const pages = Number(p.pages);
      const copies = Number(p.copies);
      if (!Number.isInteger(pages) || pages <= 0 || !Number.isInteger(copies) || copies <= 0) {
        throw new AccountingError(400, 'pages and copies must be positive integers', 'INVALID_PAPER_QUANTITY');
      }
      if (copies < learnersCount) {
        throw new AccountingError(
          400,
          `copies (${copies}) cannot be below the ${learnersCount} learners in ${className}`,
          'COPIES_BELOW_LEARNERS'
        );
      }
      const rawPaperItemId = Number(p.rawPaperItemId);
      const rawTonerItemId = Number(p.rawTonerItemId);
      if (!Number.isInteger(rawPaperItemId) || !Number.isInteger(rawTonerItemId)) {
        throw new AccountingError(400, 'rawPaperItemId and rawTonerItemId are required', 'INVALID_MATERIAL');
      }
      if (rawPaperItemId === rawTonerItemId) {
        throw new AccountingError(400, 'Paper and toner must reference different inventory items', 'INVALID_MATERIAL');
      }
      const matRes = await tx.query<{ id: number; item_type: string; is_active: boolean; paper_spec_id: number | null }>(
        `SELECT id, item_type, is_active, paper_spec_id
           FROM inventory_items
          WHERE company_id = $1 AND id = ANY($2::BIGINT[])`,
        [companyId, [rawPaperItemId, rawTonerItemId]]
      );
      if (matRes.rows.length !== 2 || matRes.rows.some(r => r.item_type !== 'raw_material' || !r.is_active)) {
        throw new AccountingError(400, 'Paper and toner must be active raw_material items in this company', 'INVALID_MATERIAL');
      }
      const paperItem = matRes.rows.find(r => Number(r.id) === rawPaperItemId)!;

      let printingItemId: number | null = p.printingItemId ? Number(p.printingItemId) : null;
      if (printingItemId != null) {
        const svc = await tx.query<{ item_type: string; is_active: boolean }>(
          `SELECT item_type, is_active FROM inventory_items WHERE company_id = $1 AND id = $2`,
          [companyId, printingItemId]
        );
        if (svc.rows.length === 0 || svc.rows[0].item_type !== 'printing_service' || !svc.rows[0].is_active) {
          throw new AccountingError(400, 'printingItemId must be an active printing_service item', 'INVALID_PRINTING_ITEM');
        }
      }

      const paperSize = ['A4', 'A3', 'B5', 'Letter'].includes(String(p.paperSize))
        ? String(p.paperSize)
        : 'A4';
      const printSide: 'Single-Sided' | 'Duplex' = p.printSide === 'Single-Sided' ? 'Single-Sided' : 'Duplex';
      const bindingType = ['Stapled', 'Saddle-Stitched', 'Loose Leaf', 'Booklet'].includes(String(p.bindingType))
        ? String(p.bindingType)
        : 'Stapled';
      const productionDate = assertIsoDate(p.productionDate, today);
      const jobNumber = await nextPrintingNumber(tx, companyId, 'exam_paper', 'EXM-', 4);

      const teacherCopies = 2; // D3: fixed rule — exactly two free teacher copies per paper
      const plannedQty = p.plannedProductionQuantity ?? (copies + teacherCopies);
      const billableQty = p.billableQuantity ?? copies;

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO exam_papers (
           company_id, batch_id, job_number, subject_name, pages, copies,
           teacher_copies, planned_production_quantity, billable_quantity,
           raw_paper_item_id, raw_toner_item_id, paper_spec_id, print_side, binding_type,
           sheets_used, impressions_used, paper_cost, toner_cost, status, production_date,
           notes, paper_size, printing_item_id, machine_id, created_by, queued_at,
           cost_status, cost_warnings
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   0, 0, 0, 0, 'queued', $15::DATE, $16, $17, $18, $19, $20, NOW(),
                   'estimated', '[]'::jsonb)
         RETURNING id`,
        [
          companyId,
          batchId,
          jobNumber,
          subjectName,
          pages,
          copies,
          teacherCopies,
          plannedQty,
          billableQty,
          rawPaperItemId,
          rawTonerItemId,
          paperItem.paper_spec_id != null ? Number(paperItem.paper_spec_id) : null,
          printSide,
          bindingType,
          productionDate,
          p.notes ?? null,
          paperSize,
          printingItemId,
          p.machineId ? Number(p.machineId) : null,
          actor.userId,
        ]
      );
      const paperId = Number(ins.rows[0].id);

      const job = await createExamProductionJob(tx, companyId, actor, {
        schoolCustomerId,
        customerName,
        assessmentName,
        className,
paper: { ...p, rawPaperItemId, rawTonerItemId },
        subjectName,
        pages,
        copies,
        teacherCopies,
        printSide,
        productionDate,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      const costStatus =
        job.impressionsUsed > 0 && job.tonerCost <= 0 ? 'unavailable' : 'estimated';
      const costWarnings =
        costStatus === 'unavailable'
          ? JSON.stringify([
              'Toner cost could not be established from a rated yield or material specification; review before invoicing.',
            ])
          : '[]';

      await tx.query(
        `UPDATE exam_papers
            SET production_job_id = $3,
                sheets_used = $4::NUMERIC(19,6),
                impressions_used = $5::NUMERIC(19,6),
                paper_cost = $6::NUMERIC(19,4),
                toner_cost = $7::NUMERIC(19,4),
                cost_status = $8,
                cost_warnings = $9::jsonb
          WHERE company_id = $1 AND id = $2`,
        [
          companyId,
          paperId,
          Number(job.id),
          job.sheetsUsed,
          job.impressionsUsed,
          job.paperCost,
          job.tonerCost,
          costStatus,
          costWarnings,
        ]
      );
      await tx.query(
        `UPDATE printing_jobs SET exam_paper_id = $3 WHERE company_id = $1 AND id = $2`,
        [companyId, Number(job.id), paperId]
      );

      await insertExamPaperEvent(tx, {
        companyId,
        batchId,
        paperId,
        eventType: 'created',
        fromStatus: null,
        toStatus: 'queued',
        actorUserId: actor.userId,
        reason: 'Examination paper created from server-authoritative batch',
        journalTxnId: null,
        invoiceId: null,
        idempotencyKey: input.idempotencyKey
          ? `${input.idempotencyKey}:paper:${paperId}`
          : null,
        metadata: {
          productionJobId: Number(job.id),
          productionJobNumber: job.jobNumber,
          costStatus,
          sheetsUsed: job.sheetsUsed,
          impressionsUsed: job.impressionsUsed,
        },
      });

      createdPapers.push({
        id: String(paperId),
        backendId: paperId,
        jobNumber,
        subjectName,
        className,
        assessmentName,
        learnersCount,
        pricePerLearner,
        pages,
        copies,
        paperSize,
        printSide,
        bindingType,
        printingItemId: printingItemId != null ? String(printingItemId) : undefined,
        rawPaperItemId: String(rawPaperItemId),
        rawTonerItemId: String(rawTonerItemId),
        sheetsUsed: job.sheetsUsed,
        impressionsUsed: job.impressionsUsed,
        paperCost: job.paperCost,
        tonerCost: job.tonerCost,
        materialCost: job.paperCost + job.tonerCost,
        costStatus,
        costWarnings: JSON.parse(costWarnings),
        status: 'queued',
        productionDate,
        productionJobId: Number(job.id),
        productionJobNumber: job.jobNumber,
        totalAmount: Math.round(learnersCount * pricePerLearner * 10000) / 10000,
      });
    }

    const totals = await tx.query<{ paper: string; toner: string }>(
      `SELECT COALESCE(SUM(paper_cost), 0)::text AS paper,
              COALESCE(SUM(toner_cost), 0)::text AS toner
         FROM exam_papers
        WHERE company_id = $1 AND batch_id = $2`,
      [companyId, batchId]
    );
    await tx.query(
      `UPDATE exam_assessment_batches
          SET total_paper_cost = $3::NUMERIC(19,4),
              total_toner_cost = $4::NUMERIC(19,4)
        WHERE company_id = $1 AND id = $2`,
      [companyId, batchId, totals.rows[0].paper, totals.rows[0].toner]
    );
  }

  const out = {
    batchId: createdBatches[0]?.batchId,
    batches: createdBatches,
    assessmentName,
    className: createdBatches[0]?.className,
    learnersCount: createdBatches[0]?.learnersCount,
    papers: createdPapers,
  };

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'EXAM_BATCH_CREATED',
    tableName: 'exam_assessment_batches',
    recordId: out.batchId ?? 0,
    newValues: {
      assessmentName,
      classes: createdBatches.map(b => ({
        batchId: b.batchId,
        className: b.className,
        learnersCount: b.learnersCount,
        pricePerLearner: b.pricePerLearner,
      })),
      paperCount: createdPapers.length,
      jobNumbers: createdPapers.map(c => c.jobNumber),
    },
  });

  await completePrintingIdempotency(tx, companyId, route, input.idempotencyKey, 201, { batch: out });
  return out;
}

/* ------------------------------------------------------------------ *
 * Printing Contracts — read + lifecycle (amend / activate / cancel /
 * renew / assessment add-remove-update / complete & revenue recognition)
 *
 * These power the contextual "advanced options" on the Printing Contracts
 * page. Every mutation is company-isolated, permission-guarded at the
 * route layer, audited, and — where it moves money — posted through the
 * same double-entry engine the rest of the ledger uses.
 * ------------------------------------------------------------------ */

type ContractRow = {
  id: number;
  contract_number: string;
  school_customer_id: number;
  title: string;
  academic_year: string;
  start_date: string;
  end_date: string;
  total_prepaid_amount: string;
  total_assessments: number;
  remaining_balance: string;
  completed_assessments: number;
  deposit_bank_account_id: number;
  liability_account_id: number;
  status: string;
  notes: string | null;
  activated_at?: string | null;
  activated_by?: number | null;
  completed_at?: string | null;
  completed_by?: number | null;
  suspended_at?: string | null;
  suspended_by?: number | null;
  suspension_reason?: string | null;
  resumed_at?: string | null;
  resumed_by?: number | null;
  renewal_of_contract_id?: number | null;
  customer_acceptance_id?: number | null;
  deposit_invoice_id?: number | null;
  deposit_invoice_number?: string | null;
  unallocated_amount?: string;
  allocated_amount?: string;
  credit_balance?: boolean;
  updated_at?: string | null;
};

type MilestoneRow = {
  id: number;
  contract_id: number;
  assessment_number: number;
  label: string;
  scheduled_date: string;
  agreed_amount: string;
  raw_paper_item_id: number | null;
  raw_toner_item_id: number | null;
  estimated_sheets: string;
  estimated_impressions: string;
  paper_cost: string;
  toner_cost: string;
  total_cost: string | number;
  profit: string | number;
  status: string;
  completed_date: string | null;
  journal_txn_id: number | null;
  linked_invoice_id: number | null;
  linked_invoice_number?: string | null;
  exam_batch_note: string | null;
};

function toNum(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function loadContract(
  tx: Transaction,
  companyId: number,
  contractId: number,
  forUpdate = false
): Promise<ContractRow> {
  const res = await tx.query<ContractRow>(
    `SELECT id, contract_number, school_customer_id, title, academic_year,
            start_date::text AS start_date, end_date::text AS end_date,
            total_prepaid_amount::text AS total_prepaid_amount, total_assessments,
            remaining_balance::text AS remaining_balance, completed_assessments,
            deposit_bank_account_id, liability_account_id,
            deposit_invoice_id, deposit_invoice_number,
            unallocated_amount::text AS unallocated_amount,
            allocated_amount::text AS allocated_amount,
            credit_balance, status, notes,
            activated_at, activated_by, completed_at, completed_by,
            suspended_at, suspended_by, suspension_reason,
            resumed_at, resumed_by, renewal_of_contract_id, customer_acceptance_id,
            updated_at::text AS updated_at
       FROM printing_contracts
      WHERE company_id = $1 AND id = $2
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [companyId, contractId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Printing contract not found in active company', 'CONTRACT_NOT_FOUND');
  }
  return res.rows[0];
}

async function loadMilestones(tx: Transaction, companyId: number, contractId: number): Promise<MilestoneRow[]> {
  const res = await tx.query<MilestoneRow>(
    `SELECT id, contract_id, assessment_number, label, scheduled_date::text AS scheduled_date,
            agreed_amount, raw_paper_item_id, raw_toner_item_id, estimated_sheets,
            estimated_impressions, paper_cost, toner_cost, total_cost, profit, status,
            completed_date::text AS completed_date, journal_txn_id, linked_invoice_id,
            linked_invoice_number, exam_batch_note
       FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2
      ORDER BY assessment_number ASC`,
    [companyId, contractId]
  );
  return res.rows;
}

function serializeMilestone(m: MilestoneRow) {
  return {
    id: m.id,
    assessmentNumber: Number(m.assessment_number),
    label: m.label,
    scheduledDate: m.scheduled_date,
    agreedAmount: toNum(m.agreed_amount),
    rawPaperItemId: m.raw_paper_item_id != null ? String(m.raw_paper_item_id) : undefined,
    rawTonerItemId: m.raw_toner_item_id != null ? String(m.raw_toner_item_id) : undefined,
    estimatedSheets: toNum(m.estimated_sheets),
    estimatedImpressions: toNum(m.estimated_impressions),
    paperCost: toNum(m.paper_cost),
    tonerCost: toNum(m.toner_cost),
    totalCost: toNum(m.total_cost),
    profit: toNum(m.profit),
    status: m.status,
    completedDate: m.completed_date ?? undefined,
    examBatchNote: m.exam_batch_note ?? undefined,
    backendInvoiceId: m.linked_invoice_id != null ? Number(m.linked_invoice_id) : undefined,
    linkedInvoiceNumber: m.linked_invoice_number ?? undefined,
    journalTxnId: m.journal_txn_id != null ? Number(m.journal_txn_id) : undefined,
  };
}

async function hydrateContract(
  tx: Transaction,
  companyId: number,
  row: ContractRow,
  milestones?: MilestoneRow[]
) {
  const ms = milestones ?? (await loadMilestones(tx, companyId, row.id));
  return {
    id: String(row.id),
    backendId: Number(row.id),
    contractNumber: row.contract_number,
    schoolCustomerId: String(row.school_customer_id),
    title: row.title,
    academicYear: row.academic_year,
    startDate: row.start_date,
    endDate: row.end_date,
    totalPrepaidAmount: toNum(row.total_prepaid_amount),
    totalAssessments: Number(row.total_assessments),
    remainingBalance: toNum(row.remaining_balance),
    completedAssessments: Number(row.completed_assessments),
    depositBankAccountId: String(row.deposit_bank_account_id),
    liabilityAccountId: Number(row.liability_account_id),
    status: row.status,
    notes: row.notes ?? undefined,
    activatedAt: row.activated_at ?? undefined,
    activatedBy: row.activated_by != null ? Number(row.activated_by) : undefined,
    completedAt: row.completed_at ?? undefined,
    completedBy: row.completed_by != null ? Number(row.completed_by) : undefined,
    suspendedAt: row.suspended_at ?? undefined,
    suspendedBy: row.suspended_by != null ? Number(row.suspended_by) : undefined,
    suspensionReason: row.suspension_reason ?? undefined,
    resumedAt: row.resumed_at ?? undefined,
    resumedBy: row.resumed_by != null ? Number(row.resumed_by) : undefined,
    renewalOfContractId:
      row.renewal_of_contract_id != null ? Number(row.renewal_of_contract_id) : undefined,
    customerAcceptanceId:
      row.customer_acceptance_id != null ? Number(row.customer_acceptance_id) : undefined,
    depositInvoiceId: row.deposit_invoice_id != null ? Number(row.deposit_invoice_id) : undefined,
    depositInvoiceNumber: row.deposit_invoice_number ?? undefined,
    unallocatedAmount: row.unallocated_amount != null ? toNum(row.unallocated_amount) : undefined,
    allocatedAmount: row.allocated_amount != null ? toNum(row.allocated_amount) : undefined,
    creditBalance: row.credit_balance === true,
    updatedAt: row.updated_at ?? undefined,
    source: 'backend' as const,
    assessments: ms.map(serializeMilestone),
  };
}

export async function listPrintingContracts(tx: Transaction, companyId: number) {
  // One query for contracts, one for all milestones — no per-row N+1 (G-19).
  const res = await tx.query<ContractRow>(
    `SELECT id, contract_number, school_customer_id, title, academic_year,
            start_date::text AS start_date, end_date::text AS end_date,
            total_prepaid_amount::text AS total_prepaid_amount, total_assessments,
            remaining_balance::text AS remaining_balance, completed_assessments,
            deposit_bank_account_id, liability_account_id,
            deposit_invoice_id, deposit_invoice_number,
            unallocated_amount::text AS unallocated_amount,
            allocated_amount::text AS allocated_amount,
            credit_balance, status, notes,
            activated_at, activated_by, completed_at, completed_by,
            suspended_at, suspended_by, suspension_reason,
            resumed_at, resumed_by, renewal_of_contract_id, customer_acceptance_id,
            updated_at::text AS updated_at
       FROM printing_contracts
      WHERE company_id = $1
      ORDER BY id DESC`,
    [companyId]
  );

  if (res.rows.length === 0) return [];

  const milestones = await tx.query<MilestoneRow & { contract_id: number }>(
    `SELECT id, contract_id, assessment_number, label,
            scheduled_date::text AS scheduled_date, agreed_amount,
            raw_paper_item_id, raw_toner_item_id, estimated_sheets,
            estimated_impressions, paper_cost, toner_cost, total_cost, profit, status,
            completed_date::text AS completed_date, journal_txn_id, linked_invoice_id,
            linked_invoice_number, exam_batch_note
       FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = ANY($2::BIGINT[])
      ORDER BY contract_id ASC, assessment_number ASC`,
    [companyId, res.rows.map(r => Number(r.id))]
  );

  const byContract = new Map<number, MilestoneRow[]>();
  for (const m of milestones.rows) {
    const key = Number(m.contract_id);
    const list = byContract.get(key) ?? [];
    list.push(m);
    byContract.set(key, list);
  }

  const out = [];
  for (const row of res.rows) {
    out.push(await hydrateContract(tx, companyId, row, byContract.get(Number(row.id)) ?? []));
  }
  return out;
}

export async function getPrintingContract(tx: Transaction, companyId: number, contractId: number) {
  const row = await loadContract(tx, companyId, contractId);
  return hydrateContract(tx, companyId, row);
}

export interface AmendPrintingContractInput {
  title?: string;
  academicYear?: string;
  startDate?: string;
  endDate?: string;
  notes?: string | null;
}

export async function amendPrintingContract(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: AmendPrintingContractInput
) {
  const row = await loadContract(tx, companyId, contractId, true);
  if (row.status !== 'draft') {
    throw new AccountingError(
      409,
      'Formal amendments must use the amendment workflow',
      'AMENDMENT_WORKFLOW_REQUIRED'
    );
  }

  const title = input.title !== undefined ? String(input.title).trim() : row.title;
  if (!title) throw new AccountingError(400, 'Contract title is required', 'TITLE_REQUIRED');

  const academicYear =
    input.academicYear !== undefined ? String(input.academicYear).trim() : row.academic_year;
  const startDate =
    input.startDate !== undefined ? assertIsoDate(input.startDate, 'startDate') : row.start_date;
  const endDate = input.endDate !== undefined ? assertIsoDate(input.endDate, 'endDate') : row.end_date;
  if (endDate < startDate) {
    throw new AccountingError(400, 'endDate cannot be earlier than startDate', 'INVALID_DATE_RANGE');
  }
  const notes = input.notes !== undefined ? input.notes ?? null : row.notes;

  await tx.query(
    `UPDATE printing_contracts
        SET title = $1, academic_year = $2, start_date = $3::DATE, end_date = $4::DATE, notes = $5
      WHERE company_id = $6 AND id = $7`,
    [title, academicYear || `${startDate.slice(0, 4)}`, startDate, endDate, notes, companyId, contractId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_AMENDED',
    tableName: 'printing_contracts',
    recordId: contractId,
    newValues: { title, academicYear, startDate, endDate },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export async function requestContractAmendment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: {
    amendmentType: 'terms' | 'schedule' | 'amount';
    reason: string;
    title?: string;
    academicYear?: string;
    startDate?: string;
    endDate?: string;
    notes?: string | null;
    assessments?: Array<{
      assessmentNumber: number;
      label?: string;
      scheduledDate?: string;
      agreedAmount?: string | number;
    }>;
  }
) {
  const row = await loadContract(tx, companyId, contractId, true);

  if (row.status === 'draft') {
    throw new AccountingError(409, 'Draft contracts can be amended directly', 'DRAFT_AMENDMENT_DIRECT');
  }
  // Immutability is defined centrally in contractLifecycle.ts.
  if (isImmutable(row.status as PrintingContractStatus)) {
    throw new AccountingError(409, 'Contract cannot be amended in its current status', 'INVALID_CONTRACT_STATUS');
  }

  const reason = String(input.reason || '').trim();
  if (!reason) {
    throw new AccountingError(400, 'An amendment reason is required', 'AMENDMENT_REASON_REQUIRED');
  }

  const oldValues = {
    title: row.title,
    academicYear: row.academic_year,
    startDate: row.start_date,
    endDate: row.end_date,
    notes: row.notes,
  };
  const newValues = {
    title: input.title !== undefined ? String(input.title).trim() : row.title,
    academicYear:
      input.academicYear !== undefined ? String(input.academicYear).trim() : row.academic_year,
    startDate:
      input.startDate !== undefined ? assertIsoDate(input.startDate, 'startDate') : row.start_date,
    endDate: input.endDate !== undefined ? assertIsoDate(input.endDate, 'endDate') : row.end_date,
    notes: input.notes !== undefined ? input.notes ?? null : row.notes,
    assessments: input.assessments ?? [],
  };
  if (newValues.endDate < newValues.startDate) {
    throw new AccountingError(400, 'endDate cannot be earlier than startDate', 'INVALID_DATE_RANGE');
  }
  if (!newValues.title) {
    throw new AccountingError(400, 'Contract title is required', 'TITLE_REQUIRED');
  }

  const versionRes = await tx.query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next
       FROM contract_amendments
      WHERE company_id = $1 AND contract_id = $2`,
    [companyId, contractId]
  );
  const version = Number(versionRes.rows[0].next);

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO contract_amendments (
       company_id, contract_id, version, amendment_type, reason,
       old_values, new_values, status, requested_by
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'pending_acceptance', $8)
     RETURNING id`,
    [
      companyId,
      contractId,
      version,
      input.amendmentType,
      reason,
      JSON.stringify(oldValues),
      JSON.stringify(newValues),
      actor.userId,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_AMENDMENT_REQUESTED',
    tableName: 'contract_amendments',
    recordId: Number(ins.rows[0].id),
    newValues: { contractId, version, amendmentType: input.amendmentType, reason },
  });

  return {
    id: Number(ins.rows[0].id),
    contractId,
    version,
    status: 'pending_acceptance' as const,
    amendmentType: input.amendmentType,
  };
}

export async function approveContractAmendment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  amendmentId: number,
  approvalRequestId?: number | null
) {
  const amendmentRes = await tx.query<any>(
    `SELECT * FROM contract_amendments WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, amendmentId]
  );
  if (amendmentRes.rows.length === 0) {
    throw new AccountingError(404, 'Contract amendment not found', 'AMENDMENT_NOT_FOUND');
  }
  const amendment = amendmentRes.rows[0];
  if (String(amendment.status) !== 'pending_acceptance') {
    throw new AccountingError(409, 'Amendment is not pending acceptance', 'AMENDMENT_NOT_PENDING');
  }
  if (Number(amendment.requested_by) === Number(actor.userId)) {
    throw new AccountingError(409, 'You cannot approve your own amendment', 'SELF_APPROVAL_FORBIDDEN');
  }

  const contractId = Number(amendment.contract_id);
  const row = await loadContract(tx, companyId, contractId, true);
  if (['cancelled', 'completed', 'exhausted'].includes(row.status)) {
    throw new AccountingError(409, 'Contract cannot be amended in its current status', 'INVALID_CONTRACT_STATUS');
  }

  const acceptance = await tx.query<{ id: number }>(
    `SELECT id FROM contract_acceptances
      WHERE company_id = $1 AND contract_id = $2 AND outcome = 'accepted'
        AND document_version = $3
      ORDER BY accepted_at DESC
      LIMIT 1`,
    [companyId, contractId, String(amendment.version)]
  );
  if (acceptance.rows.length === 0) {
    throw new AccountingError(409, 'Customer acceptance is required', 'CUSTOMER_ACCEPTANCE_REQUIRED');
  }

  const approval = approvalRequestId
    ? await tx.query<any>(
        `SELECT * FROM approval_requests WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, approvalRequestId]
      )
    : await tx.query<any>(
        `SELECT * FROM approval_requests
          WHERE company_id = $1 AND action_type = 'contract_amendment'
            AND entity_type = 'printing_contract' AND entity_id = $2
            AND status = 'approved' AND consumed_at IS NULL
          ORDER BY decided_at DESC
          LIMIT 1
          FOR UPDATE`,
        [companyId, contractId]
      );

  if (approval.rows.length === 0) {
    throw new AccountingError(409, 'An approved amendment request is required', 'AMENDMENT_APPROVAL_REQUIRED');
  }
  const apr = approval.rows[0];
  if (String(apr.action_type) !== 'contract_amendment' || Number(apr.entity_id) !== contractId) {
    throw new AccountingError(400, 'Approval does not match this contract', 'APPROVAL_MISMATCH');
  }
  if (String(apr.status) !== 'approved') {
    throw new AccountingError(409, 'Approval is not approved', 'APPROVAL_NOT_APPROVED');
  }
  if (apr.consumed_at) {
    throw new AccountingError(409, 'Approval has already been consumed', 'APPROVAL_ALREADY_CONSUMED');
  }

  const nv = amendment.new_values || {};
  const newTitle = nv.title ?? row.title;
  const newAcademicYear = nv.academicYear ?? row.academic_year;
  const newStartDate = nv.startDate ?? row.start_date;
  const newEndDate = nv.endDate ?? row.end_date;
  const newNotes = nv.notes !== undefined ? nv.notes : row.notes;
  if (newEndDate < newStartDate) {
    throw new AccountingError(400, 'endDate cannot be earlier than startDate', 'INVALID_DATE_RANGE');
  }

  await tx.query(
    `UPDATE printing_contracts
        SET title = $3,
            academic_year = $4,
            start_date = $5::DATE,
            end_date = $6::DATE,
            notes = $7
      WHERE company_id = $1 AND id = $2`,
    [companyId, contractId, newTitle, newAcademicYear || `${newStartDate.slice(0, 4)}`, newStartDate, newEndDate, newNotes]
  );

  if (Array.isArray(nv.assessments)) {
    for (const change of nv.assessments) {
      await tx.query(
        `UPDATE contract_assessment_milestones
            SET label = COALESCE($3, label),
                scheduled_date = COALESCE($4::DATE, scheduled_date),
                agreed_amount = COALESCE($5::NUMERIC(19,4), agreed_amount)
          WHERE company_id = $1 AND contract_id = $2 AND assessment_number = $6 AND status = 'pending'`,
        [
          companyId,
          contractId,
          change.label ?? null,
          change.scheduledDate ?? null,
          change.agreedAmount != null ? formatDecimal4(parseDecimal4(change.agreedAmount)) : null,
          Number(change.assessmentNumber),
        ]
      );
    }
  }

  const sumRes = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(agreed_amount), 0)::text AS total
       FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2`,
    [companyId, contractId]
  );
  if (parseDecimal4(sumRes.rows[0].total) > parseDecimal4(row.total_prepaid_amount)) {
    throw new AccountingError(400, 'Assessment allocation exceeds the prepaid amount', 'ASSESSMENT_SUM_MISMATCH');
  }

  await tx.query(
    `UPDATE contract_amendments
        SET status = 'effective',
            approved_by = $2,
            approved_at = NOW(),
            acceptance_id = $3,
            effective_at = NOW()
      WHERE company_id = $1 AND id = $4`,
    [companyId, actor.userId, Number(acceptance.rows[0].id), Number(amendment.id)]
  );

  await tx.query(
    `UPDATE approval_requests SET consumed_at = NOW()
      WHERE company_id = $1 AND id = $2 AND consumed_at IS NULL`,
    [companyId, Number(apr.id)]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_AMENDMENT_APPROVED',
    tableName: 'contract_amendments',
    recordId: Number(amendment.id),
    oldValues: { status: amendment.status },
    newValues: { status: 'effective', version: amendment.version, acceptanceId: Number(acceptance.rows[0].id) },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export async function rejectContractAmendment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  amendmentId: number,
  reason: string
) {
  const amendmentRes = await tx.query<any>(
    `SELECT * FROM contract_amendments WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, amendmentId]
  );
  if (amendmentRes.rows.length === 0) {
    throw new AccountingError(404, 'Contract amendment not found', 'AMENDMENT_NOT_FOUND');
  }
  if (String(amendmentRes.rows[0].status) !== 'pending_acceptance') {
    throw new AccountingError(409, 'Amendment is not pending', 'AMENDMENT_NOT_PENDING');
  }

  await tx.query(
    `UPDATE contract_amendments SET status = 'rejected' WHERE company_id = $1 AND id = $2`,
    [companyId, amendmentId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_AMENDMENT_REJECTED',
    tableName: 'contract_amendments',
    recordId: amendmentId,
    newValues: { status: 'rejected', reason },
  });

  return { id: amendmentId, status: 'rejected' as const };
}

export async function listContractAmendments(tx: Transaction, companyId: number, contractId: number) {
  const res = await tx.query<any>(
    `SELECT id, contract_id, version, amendment_type, reason, old_values, new_values,
            status, requested_by, approved_by, approved_at, acceptance_id, effective_at, created_at
       FROM contract_amendments
      WHERE company_id = $1 AND contract_id = $2
      ORDER BY version DESC`,
    [companyId, contractId]
  );
  return res.rows.map((row: any) => ({
    id: Number(row.id),
    contractId: Number(row.contract_id),
    version: Number(row.version),
    amendmentType: String(row.amendment_type),
    reason: String(row.reason),
    oldValues: row.old_values,
    newValue: row.new_values,
    status: String(row.status),
    requestedBy: Number(row.requested_by),
    approvedBy: row.approved_by != null ? Number(row.approved_by) : null,
    approvedAt: row.approved_at ?? null,
    acceptanceId: row.acceptance_id != null ? Number(row.acceptance_id) : null,
    effectiveAt: row.effective_at ?? null,
    createdAt: String(row.created_at),
  }));
}

export async function requestAssessmentChangeApproval(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: { reason: string; amount?: string | number; payload?: unknown }
) {
  const row = await loadContract(tx, companyId, contractId);
  if (!['active', 'suspended'].includes(row.status)) {
    throw new AccountingError(409, 'Contract is not active', 'CONTRACT_NOT_ACTIVE');
  }
  const reason = String(input.reason || '').trim();
  if (!reason) {
    throw new AccountingError(400, 'A reason is required', 'REASON_REQUIRED');
  }

  const payload = input.payload ?? { contractId, reason };
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const todayRes = await tx.query<{ today: string }>(`SELECT CURRENT_DATE::TEXT AS today`);

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO approval_requests (
       company_id, action_type, entity_type, entity_id, amount, requested_by,
       status, payload_json, business_date, payload_hash
     ) VALUES ($1, 'contract_assessment_change', 'printing_contract', $2, $3, $4, 'pending', $5::jsonb, $6::DATE, $7)
     RETURNING id`,
    [
      companyId,
      contractId,
      formatDecimal4(parseDecimal4(input.amount ?? 0)),
      actor.userId,
      JSON.stringify(payload),
      todayRes.rows[0].today,
      payloadHash,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CONTRACT_ASSESSMENT_CHANGE_REQUESTED',
    tableName: 'approval_requests',
    recordId: Number(ins.rows[0].id),
    newValues: { contractId, reason, amount: formatDecimal4(parseDecimal4(input.amount ?? 0)) },
  });

  return { id: Number(ins.rows[0].id), status: 'pending' as const };
}

async function consumeAssessmentChangeApproval(
  tx: Transaction,
  companyId: number,
  contractId: number
): Promise<void> {
  const res = await tx.query<{ id: number }>(
    `SELECT id FROM approval_requests
      WHERE company_id = $1 AND action_type = 'contract_assessment_change'
        AND entity_type = 'printing_contract' AND entity_id = $2
        AND status = 'approved' AND consumed_at IS NULL
      ORDER BY decided_at DESC
      LIMIT 1
      FOR UPDATE`,
    [companyId, contractId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(
      409,
      'An approved assessment-change request is required',
      'ASSESSMENT_CHANGE_APPROVAL_REQUIRED'
    );
  }
  await tx.query(
    `UPDATE approval_requests SET consumed_at = NOW()
      WHERE company_id = $1 AND id = $2 AND consumed_at IS NULL`,
    [companyId, Number(res.rows[0].id)]
  );
}

async function assertAssessmentChangeApproval(
  tx: Transaction,
  companyId: number,
  contractId: number,
  status: string
): Promise<void> {
  if (!['draft', 'active'].includes(status)) {
    throw new AccountingError(409, 'Only draft or active contracts can change assessments', 'CONTRACT_NOT_ACTIVE');
  }
  if (status !== 'draft') {
    await consumeAssessmentChangeApproval(tx, companyId, contractId);
  }
}

export async function setPrintingContractStatus(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  action: 'activate' | 'cancel',
  reason?: string | null,
  options?: { settlementMode?: 'refund' | 'forfeit'; refundBankAccountId?: number | null }
) {
  if (action === 'activate') {
    return activatePrintingContract(tx, companyId, actor, contractId);
  }
  return cancelPrintingContract(tx, companyId, actor, contractId, {
    reason: reason ?? '',
    settlementMode: options?.settlementMode ?? null,
    refundBankAccountId: options?.refundBankAccountId ?? null,
  });
}

export async function renewPrintingContract(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input?: {
    title?: string;
    academicYear?: string;
    startDate?: string;
    endDate?: string;
    depositAmount?: string | number;
    depositBankAccountId?: number;
    assessments?: ContractAssessmentInput[];
    idempotencyKey?: string | null;
  }
) {
  const row = await loadContract(tx, companyId, contractId);

  // A renewal is a genuinely new agreement: it requires a real new deposit and
  // never inherits the old dates or amounts (G-05 residual).
  if (row.status !== 'completed' && row.status !== 'credit_balance' && row.status !== 'active') {
    throw new AccountingError(409, 'This contract cannot be renewed in its current state', 'CONTRACT_NOT_RENEWABLE');
  }
  const depositAmount = parseDecimal4(input?.depositAmount ?? 0);
  if (depositAmount <= 0n) {
    throw new AccountingError(400, 'A deposit amount greater than zero is required to renew', 'DEPOSIT_AMOUNT_REQUIRED');
  }
  const depositBankAccountId = Number(input?.depositBankAccountId ?? row.deposit_bank_account_id);
  const bankCheck = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND id = $2 AND is_active = TRUE AND account_type = 'Bank'`,
    [companyId, depositBankAccountId]
  );
  if (bankCheck.rows.length === 0) {
    throw new AccountingError(400, 'A valid deposit bank account is required', 'INVALID_BANK_ACCOUNT');
  }

  const startDate = assertIsoDate(input?.startDate ?? row.start_date, 'startDate');
  const endDate = assertIsoDate(input?.endDate ?? row.end_date, 'endDate');
  if (endDate < startDate) {
    throw new AccountingError(400, 'endDate cannot be earlier than startDate', 'INVALID_DATE_RANGE');
  }

  const assessments = input?.assessments ?? (await loadMilestones(tx, companyId, contractId)).map(m => ({
    assessmentNumber: Number(m.assessment_number),
    label: m.label,
    scheduledDate: m.scheduled_date,
    agreedAmount: m.agreed_amount,
    rawPaperItemId: m.raw_paper_item_id,
    rawTonerItemId: m.raw_toner_item_id,
    estimatedSheets: m.estimated_sheets,
    estimatedImpressions: m.estimated_impressions,
    paperCost: m.paper_cost,
    tonerCost: m.toner_cost,
  }));

  return createPrintingContract(tx, companyId, actor, {
    schoolCustomerId: row.school_customer_id,
    title: input?.title ?? `${row.title} (renewal)`,
    academicYear: input?.academicYear ?? row.academic_year,
    startDate,
    endDate,
    totalPrepaidAmount: formatDecimal4(depositAmount),
    totalAssessments: assessments.length,
    depositBankAccountId,
    notes: row.notes,
    renewalOfContractId: contractId,
    idempotencyKey: input?.idempotencyKey ?? null,
    assessments,
  });
}

/** Tops up an active contract retainer with a real new deposit (G-18). */
export async function topUpContract(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: {
    amount: string | number;
    bankAccountId: number;
    depositDate: string;
    idempotencyKey?: string | null;
    notes?: string | null;
  }
) {
  const row = await loadContract(tx, companyId, contractId, true);
  if (row.status !== 'active') {
    throw new AccountingError(409, 'Only active contracts can be topped up', 'CONTRACT_NOT_ACTIVE');
  }

  const amount = parseDecimal4(input.amount);
  if (amount <= 0n) {
    throw new AccountingError(400, 'Top-up amount must be greater than zero', 'INVALID_AMOUNT');
  }

  const bankAccountId = Number(input.bankAccountId);
  const bankCheck = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND id = $2 AND is_active = TRUE AND account_type = 'Bank'`,
    [companyId, bankAccountId]
  );
  if (bankCheck.rows.length === 0) {
    throw new AccountingError(400, 'A valid deposit bank account is required', 'INVALID_BANK_ACCOUNT');
  }

  const depositDate = assertIsoDate(input.depositDate, 'depositDate');

  const claim = await claimPrintingIdempotency(
    tx,
    companyId,
    'printing_contract_topup',
    input.idempotencyKey,
    actor.userId,
    {
      contractId,
      amount: formatDecimal4(amount),
      bankAccountId,
      depositDate,
      notes: input.notes ?? null,
    }
  );
  if (claim.replay) return { ...claim.replay.body, idempotentReplay: true } as any;

  const idempotencyKey = String(input.idempotencyKey ?? '');

  // A top-up is real new money, so it enters through the wallet: the bank is
  // debited, the wallet liability credited, then the wallet funds the contract
  // retainer. Routing it this way keeps the contract wallet trail (G-27) complete
  // and keeps every kwacha traceable to a bank deposit.
  const deposit = await recordWalletDeposit(tx, companyId, actor, {
    customerId: Number(row.school_customer_id),
    amount: formatDecimal4(amount),
    bankAccountId,
    txnDate: depositDate,
    referenceNumber: row.contract_number,
    memo: input.notes ?? `Retainer top-up for ${row.contract_number}`,
    idempotencyKey: idempotencyKey ? `topup-deposit-${idempotencyKey}` : null,
  });

  const allocation = await allocateWalletFunds(tx, companyId, actor, {
    customerId: Number(row.school_customer_id),
    walletId: deposit.walletTransaction.walletId,
    contractId,
    amount: formatDecimal4(amount),
    idempotencyKey: idempotencyKey ? `topup-allocation-${idempotencyKey}` : null,
    allowDraft: false,
    increaseContractTotals: false,
    notes: `Contract retainer top-up: ${input.notes ?? row.contract_number}`,
  });

  await tx.query(
    `UPDATE printing_contracts
        SET total_prepaid_amount = total_prepaid_amount + $3::NUMERIC(19,4),
            remaining_balance = remaining_balance + $4::NUMERIC(19,4),
            unallocated_amount = unallocated_amount + $5::NUMERIC(19,4),
            allocated_amount = allocated_amount + $6::NUMERIC(19,4)
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      contractId,
      formatDecimal4(amount),
      formatDecimal4(amount),
      formatDecimal4(amount),
      formatDecimal4(amount),
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_TOPPED_UP',
    tableName: 'printing_contracts',
    recordId: contractId,
    newValues: {
      contractNumber: row.contract_number,
      amount: formatDecimal4(amount),
      bankAccountId,
      depositDate,
      walletTransactionId: deposit.walletTransaction.id,
      allocationId: allocation.allocationId,
      journalTransactionId: deposit.walletTransaction.journalTxnId,
    },
  });

  const result = {
    contractId,
    amount: formatDecimal4(amount),
    walletTransactionId: deposit.walletTransaction.id,
    allocationId: allocation.allocationId,
    journalTransactionId: deposit.walletTransaction.journalTxnId,
    idempotentReplay: false,
  };

  await completePrintingIdempotency(
    tx,
    companyId,
    'printing_contract_topup',
    input.idempotencyKey,
    201,
    result
  );

  return result;
}

export interface ContractAssessmentMutation {
  assessmentNumber: number;
  label?: string;
  scheduledDate?: string;
  agreedAmount?: string | number;
  rawPaperItemId?: number | null;
  rawTonerItemId?: number | null;
  estimatedSheets?: string | number | null;
  estimatedImpressions?: string | number | null;
  paperCost?: string | number | null;
  tonerCost?: string | number | null;
  examBatchNote?: string | null;
}

export async function addContractAssessment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: ContractAssessmentMutation
) {
  const row = await loadContract(tx, companyId, contractId, true);
  await assertAssessmentChangeApproval(tx, companyId, contractId, row.status);
  if (row.total_assessments >= 5) {
    throw new AccountingError(400, 'A contract cannot exceed 5 assessments', 'MAX_ASSESSMENTS');
  }

  const assessmentNumber = Number(input.assessmentNumber);
  if (!Number.isInteger(assessmentNumber) || assessmentNumber < 1 || assessmentNumber > 5) {
    throw new AccountingError(400, 'assessmentNumber must be between 1 and 5', 'INVALID_ASSESSMENT_NUMBER');
  }

  const dup = await tx.query<{ id: number }>(
    `SELECT id FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2 AND assessment_number = $3`,
    [companyId, contractId, assessmentNumber]
  );
  if (dup.rows.length > 0) {
    throw new AccountingError(409, `Assessment #${assessmentNumber} already exists`, 'ASSESSMENT_EXISTS');
  }

  const newAgreed = parseDecimal4(input.agreedAmount ?? 0);
  // Zero is legal for tracking-only milestones; negative is not.
  if (newAgreed < 0n) {
    throw new AccountingError(400, 'agreedAmount cannot be negative', 'INVALID_AMOUNT');
  }

  const scheduledDate = assertIsoDate(input.scheduledDate, 'scheduledDate');
  if (scheduledDate < row.start_date || scheduledDate > row.end_date) {
    throw new AccountingError(
      400,
      `scheduled date ${scheduledDate} is outside the contract window ${row.start_date}..${row.end_date}`,
      'ASSESSMENT_DATE_OUT_OF_RANGE'
    );
  }

  await tx.query(
    `INSERT INTO contract_assessment_milestones (
       company_id, contract_id, assessment_number, label, scheduled_date, agreed_amount,
       raw_paper_item_id, raw_toner_item_id, estimated_sheets, estimated_impressions,
       paper_cost, toner_cost, status
     ) VALUES ($1, $2, $3, $4, $5::DATE, $6::NUMERIC(19,4), $7, $8,
               $9::NUMERIC(19,6), $10::NUMERIC(19,6), $11::NUMERIC(19,4), $12::NUMERIC(19,4), 'pending')`,
    [
      companyId,
      contractId,
      assessmentNumber,
      String(input.label || `Assessment ${assessmentNumber}`),
      scheduledDate,
      formatDecimal4(newAgreed),
      input.rawPaperItemId != null ? Number(input.rawPaperItemId) : null,
      input.rawTonerItemId != null ? Number(input.rawTonerItemId) : null,
      formatDecimal4(parseDecimal4(input.estimatedSheets ?? 0)),
      formatDecimal4(parseDecimal4(input.estimatedImpressions ?? 0)),
      formatDecimal4(parseDecimal4(input.paperCost ?? 0)),
      formatDecimal4(parseDecimal4(input.tonerCost ?? 0)),
    ]
  );

  await tx.query(
    `UPDATE printing_contracts SET total_assessments = total_assessments + 1 WHERE company_id = $1 AND id = $2`,
    [companyId, contractId]
  );

  // Later reassessment may leave an explicit unallocated residual (D-2).
  const allocation = await assertAssessmentAllocation(tx, companyId, contractId, row.total_prepaid_amount, {
    exact: false,
  });
  const unallocated = allocation.prepaid - allocation.allocated;
  await tx.query(
    `UPDATE printing_contracts SET unallocated_amount = $3::NUMERIC(19,4) WHERE company_id = $1 AND id = $2`,
    [companyId, contractId, formatDecimal4(unallocated)]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CONTRACT_ASSESSMENT_ADDED',
    tableName: 'contract_assessment_milestones',
    recordId: contractId,
    newValues: {
      assessmentNumber,
      totalAssessments: row.total_assessments + 1,
      agreedAmount: formatDecimal4(newAgreed),
      unallocatedAmount: formatDecimal4(unallocated),
    },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export async function removeContractAssessment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  assessmentNumber: number
) {
  const row = await loadContract(tx, companyId, contractId, true);
  await assertAssessmentChangeApproval(tx, companyId, contractId, row.status);
  if (row.total_assessments <= 2) {
    throw new AccountingError(400, 'A contract must keep at least 2 assessments', 'MIN_ASSESSMENTS');
  }

  const ms = await tx.query<{ id: number; status: string }>(
    `SELECT id, status FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2 AND assessment_number = $3`,
    [companyId, contractId, assessmentNumber]
  );
  if (ms.rows.length === 0) {
    throw new AccountingError(404, `Assessment #${assessmentNumber} not found`, 'ASSESSMENT_NOT_FOUND');
  }
  if (ms.rows[0].status !== 'pending') {
    throw new AccountingError(400, 'Only pending assessments can be removed', 'ASSESSMENT_NOT_PENDING');
  }

  await tx.query(
    `DELETE FROM contract_assessment_milestones WHERE company_id = $1 AND contract_id = $2 AND assessment_number = $3`,
    [companyId, contractId, assessmentNumber]
  );
  await tx.query(
    `UPDATE printing_contracts SET total_assessments = total_assessments - 1 WHERE company_id = $1 AND id = $2`,
    [companyId, contractId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CONTRACT_ASSESSMENT_REMOVED',
    tableName: 'contract_assessment_milestones',
    recordId: contractId,
    oldValues: { assessmentNumber },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export async function updateContractAssessment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  assessmentNumber: number,
  input: ContractAssessmentMutation
) {
  const row = await loadContract(tx, companyId, contractId, true);
  await assertAssessmentChangeApproval(tx, companyId, contractId, row.status);

  const ms = await tx.query<MilestoneRow>(
    `SELECT id, contract_id, assessment_number, label, scheduled_date::text AS scheduled_date,
            agreed_amount, raw_paper_item_id, raw_toner_item_id, estimated_sheets,
            estimated_impressions, paper_cost, toner_cost, total_cost, profit, status,
            completed_date::text AS completed_date, journal_txn_id, linked_invoice_id,
            linked_invoice_number, exam_batch_note
       FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2 AND assessment_number = $3
      FOR UPDATE`,
    [companyId, contractId, assessmentNumber]
  );
  if (ms.rows.length === 0) {
    throw new AccountingError(404, `Assessment #${assessmentNumber} not found`, 'ASSESSMENT_NOT_FOUND');
  }
  const current = ms.rows[0];
  if (current.status !== 'pending') {
    throw new AccountingError(400, 'Completed assessments cannot be edited', 'ASSESSMENT_COMPLETED');
  }

  const label = input.label !== undefined ? String(input.label).trim() : current.label;
  if (!label) throw new AccountingError(400, 'Assessment label is required', 'LABEL_REQUIRED');
  const scheduledDate =
    input.scheduledDate !== undefined ? assertIsoDate(input.scheduledDate, 'scheduledDate') : current.scheduled_date;
  if (scheduledDate < row.start_date || scheduledDate > row.end_date) {
    throw new AccountingError(
      400,
      `scheduled date ${scheduledDate} is outside the contract window ${row.start_date}..${row.end_date}`,
      'ASSESSMENT_DATE_OUT_OF_RANGE'
    );
  }
  const agreedAmount = parseDecimal4(input.agreedAmount !== undefined ? input.agreedAmount : current.agreed_amount);
  if (agreedAmount < 0n) throw new AccountingError(400, 'agreedAmount cannot be negative', 'INVALID_AMOUNT');

  const oldAgreed = parseDecimal4(current.agreed_amount);
  const sumRes = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(agreed_amount), 0)::text AS total
       FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2`,
    [companyId, contractId]
  );
  const projected = parseDecimal4(sumRes.rows[0].total) - oldAgreed + agreedAmount;
  if (projected > parseDecimal4(row.total_prepaid_amount)) {
    throw new AccountingError(
      400,
      'Assessment allocation exceeds the prepaid amount',
      'ASSESSMENT_SUM_MISMATCH'
    );
  }

  await tx.query(
    `UPDATE contract_assessment_milestones
        SET label = $1, scheduled_date = $2::DATE, agreed_amount = $3::NUMERIC(19,4),
            raw_paper_item_id = $4, raw_toner_item_id = $5,
            estimated_sheets = $6::NUMERIC(19,6), estimated_impressions = $7::NUMERIC(19,6),
            paper_cost = $8::NUMERIC(19,4), toner_cost = $9::NUMERIC(19,4)
      WHERE company_id = $10 AND id = $11`,
    [
      label,
      scheduledDate,
      formatDecimal4(agreedAmount),
      input.rawPaperItemId !== undefined ? (input.rawPaperItemId != null ? Number(input.rawPaperItemId) : null) : current.raw_paper_item_id,
      input.rawTonerItemId !== undefined ? (input.rawTonerItemId != null ? Number(input.rawTonerItemId) : null) : current.raw_toner_item_id,
      formatDecimal4(parseDecimal4(input.estimatedSheets !== undefined ? input.estimatedSheets ?? 0 : current.estimated_sheets)),
      formatDecimal4(parseDecimal4(input.estimatedImpressions !== undefined ? input.estimatedImpressions ?? 0 : current.estimated_impressions)),
      formatDecimal4(parseDecimal4(input.paperCost !== undefined ? input.paperCost ?? 0 : current.paper_cost)),
      formatDecimal4(parseDecimal4(input.tonerCost !== undefined ? input.tonerCost ?? 0 : current.toner_cost)),
      companyId,
      current.id,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CONTRACT_ASSESSMENT_UPDATED',
    tableName: 'contract_assessment_milestones',
    recordId: current.id,
    newValues: { assessmentNumber, label, scheduledDate, agreedAmount: formatDecimal4(agreedAmount) },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export async function completeContractAssessment(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  assessmentNumber: number,
  options: { examBatchNote?: string | null; linkedInvoiceId?: number | null } = {}
) {
  const row = await loadContract(tx, companyId, contractId, true);
  if (row.status !== 'active') {
    throw new AccountingError(400, 'Contract is not active', 'CONTRACT_NOT_ACTIVE');
  }

  const ms = await tx.query<{ id: number; status: string; agreed_amount: string }>(
    `SELECT id, status, agreed_amount
       FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2 AND assessment_number = $3
      FOR UPDATE`,
    [companyId, contractId, assessmentNumber]
  );
  if (ms.rows.length === 0) {
    throw new AccountingError(404, `Assessment #${assessmentNumber} not found`, 'ASSESSMENT_NOT_FOUND');
  }
  if (ms.rows[0].status !== 'pending') {
    throw new AccountingError(409, `Assessment #${assessmentNumber} is already completed`, 'ASSESSMENT_COMPLETED');
  }

  const milestone = ms.rows[0];
  const agreed = parseDecimal4(milestone.agreed_amount);
  const remaining = parseDecimal4(row.remaining_balance);
  if (agreed > remaining) {
    throw new AccountingError(
      409,
      `Insufficient contract balance: assessment requires ${formatDecimal4(agreed)} but only ${formatDecimal4(remaining)} remains`,
      'INSUFFICIENT_CONTRACT_FUNDS'
    );
  }
  const deduction = agreed;

  const todayRes = await tx.query<{ today: string }>(`SELECT CURRENT_DATE::TEXT AS today`);
  const today = todayRes.rows[0].today;
  let journalTxnId: number | null = null;

  if (deduction > 0n) {
    const incomeAccountId = await resolveIncomeAccount(tx, companyId);
    const posted = await postJournalEntry(tx, companyId, actor, {
      txnDate: today,
      description: `Contract ${row.contract_number} — assessment #${assessmentNumber} revenue recognition`,
      memo: `Deduct prepaid retainer and recognize earned printing revenue (${row.contract_number})`,
      reference: row.contract_number,
      sourceType: 'printing_contract',
      sourceId: contractId,
      idempotencyKey: `contract-complete-${contractId}-${assessmentNumber}`,
      lines: [
        {
          accountId: Number(row.liability_account_id),
          debit: formatDecimal4(deduction),
          description: 'Deduct unearned contract revenue',
        },
        {
          accountId: incomeAccountId,
          credit: formatDecimal4(deduction),
          description: 'Recognize earned printing revenue',
        },
      ],
    });
    journalTxnId = posted.transaction.id;
  }

  const nextRemaining = remaining - deduction;
  const nextCompleted = Number(row.completed_assessments) + 1;
  const allDone = nextCompleted >= Number(row.total_assessments);
  // Every milestone is complete but cash remains: the contract enters the
  // explicit credit-balance state and the operator must refund or renew (D-2).
  const creditBalance = allDone && nextRemaining > 0n;
  const nextStatus = allDone ? (creditBalance ? 'active' : 'completed') : 'active';

  // Completion (active → completed) is a lifecycle transition; the matrix is the
  // authority on who may perform it. A credit-balance hold stays `active` and is
  // not a transition.
  if (nextStatus !== row.status) {
    assertTransition(
      row.status as PrintingContractStatus,
      'COMPLETE',
      nextStatus as PrintingContractStatus,
      actor.role
    );
  }

  await tx.query(
    `UPDATE contract_assessment_milestones
        SET status = 'completed', completed_date = $1::DATE,
            completed_at = NOW(), completed_by = $6,
            exam_batch_note = $2, journal_txn_id = $3, linked_invoice_id = $4
      WHERE company_id = $5 AND id = $7`,
    [
      today,
      options.examBatchNote ?? `Assessment #${assessmentNumber} completed & deducted`,
      journalTxnId,
      options.linkedInvoiceId != null ? Number(options.linkedInvoiceId) : null,
      companyId,
      actor.userId,
      milestone.id,
    ]
  );

  await tx.query(
    `UPDATE printing_contracts
        SET remaining_balance = $1::NUMERIC(19,4),
            completed_assessments = $2,
            status = $3::VARCHAR(20),
            credit_balance = $7,
            completed_at = CASE WHEN $3::VARCHAR(20) = 'completed' THEN NOW() ELSE completed_at END,
            completed_by = CASE WHEN $3::VARCHAR(20) = 'completed' THEN $6::BIGINT ELSE completed_by END
      WHERE company_id = $4 AND id = $5`,
    [
      formatDecimal4(nextRemaining),
      nextCompleted,
      nextStatus,
      companyId,
      contractId,
      actor.userId,
      creditBalance,
    ]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CONTRACT_ASSESSMENT_COMPLETED',
    tableName: 'contract_assessment_milestones',
    recordId: milestone.id,
    oldValues: { assessmentNumber, status: 'pending' },
    newValues: {
      status: 'completed',
      deduction: formatDecimal4(deduction),
      remainingBalance: formatDecimal4(nextRemaining),
      completedAssessments: nextCompleted,
      journalTransactionId: journalTxnId,
      creditBalance: creditBalance ? formatDecimal4(nextRemaining) : null,
    },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export interface ContractWalletMovement {
  id: number;
  date: string;
  type: 'deposit' | 'allocation' | 'completion' | 'refund' | 'forfeit' | 'topup';
  amount: number;
  balanceAfter: number;
  refNumber: string | null;
  memo: string | null;
  journalTxnId: number | null;
  source: 'bank' | 'wallet' | 'gl';
}

/**
 * Reconciling contract money trail (G-27).
 *
 * The previous implementation read `bank_transactions.ref_number = contractNumber`,
 * but wallet deposits and refunds write `ref_number = walletNumber`, so the modal
 * was always empty. This reads the sources that actually exist, in order:
 * wallet allocations, the wallet transactions they point at, bank rows joined on
 * the journal, and — for legacy contracts — the GL lines on the contract's
 * liability account.
 */
/** Links a generated retainer invoice to its contract so the link survives reload (G-09). */
export async function linkContractDepositInvoice(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  input: { invoiceId: number; invoiceNumber?: string | null }
) {
  const row = await loadContract(tx, companyId, contractId);
  const invoiceId = Number(input.invoiceId);
  const inv = await tx.query<{ id: number; invoice_number: string }>(
    `SELECT id, invoice_number FROM invoices WHERE company_id = $1 AND id = $2`,
    [companyId, invoiceId]
  );
  if (inv.rows.length === 0) {
    throw new AccountingError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  }

  const invoiceNumber = input.invoiceNumber ?? inv.rows[0].invoice_number ?? null;

  await tx.query(
    `UPDATE printing_contracts
        SET deposit_invoice_id = $3, deposit_invoice_number = $4
      WHERE company_id = $1 AND id = $2`,
    [companyId, contractId, invoiceId, invoiceNumber]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_CONTRACT_INVOICE_LINKED',
    tableName: 'printing_contracts',
    recordId: contractId,
    newValues: {
      contractNumber: row.contract_number,
      depositInvoiceId: invoiceId,
      depositInvoiceNumber: invoiceNumber,
    },
  });

  return getPrintingContract(tx, companyId, contractId);
}

/** Links a generated assessment invoice to its milestone (G-09). */
export async function linkMilestoneInvoice(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  contractId: number,
  assessmentNumber: number,
  input: { invoiceId: number; invoiceNumber?: string | null }
) {
  const row = await loadContract(tx, companyId, contractId);
  const ms = await tx.query<{ id: number }>(
    `SELECT id FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2 AND assessment_number = $3`,
    [companyId, contractId, assessmentNumber]
  );
  if (ms.rows.length === 0) {
    throw new AccountingError(404, `Assessment #${assessmentNumber} not found`, 'ASSESSMENT_NOT_FOUND');
  }

  const invoiceId = Number(input.invoiceId);
  const inv = await tx.query<{ id: number; invoice_number: string }>(
    `SELECT id, invoice_number FROM invoices WHERE company_id = $1 AND id = $2`,
    [companyId, invoiceId]
  );
  if (inv.rows.length === 0) {
    throw new AccountingError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  }
  const invoiceNumber = input.invoiceNumber ?? inv.rows[0].invoice_number ?? null;

  await tx.query(
    `UPDATE contract_assessment_milestones
        SET linked_invoice_id = $3, linked_invoice_number = $4
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(ms.rows[0].id), invoiceId, invoiceNumber]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'PRINTING_MILESTONE_INVOICE_LINKED',
    tableName: 'contract_assessment_milestones',
    recordId: contractId,
    newValues: {
      contractNumber: row.contract_number,
      assessmentNumber,
      linkedInvoiceId: invoiceId,
      linkedInvoiceNumber: invoiceNumber,
    },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export async function listContractWalletTransactions(
  tx: Transaction,
  companyId: number,
  contractNumber: string
): Promise<ContractWalletMovement[]> {
  const contractRes = await tx.query<{ id: number; remaining_balance: string; total_prepaid_amount: string }>(
    `SELECT id, remaining_balance, total_prepaid_amount
       FROM printing_contracts
      WHERE company_id = $1 AND contract_number = $2`,
    [companyId, contractNumber]
  );
  if (contractRes.rows.length === 0) {
    throw new AccountingError(404, 'Printing contract not found', 'CONTRACT_NOT_FOUND');
  }
  const contractId = Number(contractRes.rows[0].id);
  const totalPrepaid = toMoneyNumber(parseDecimal4(contractRes.rows[0].total_prepaid_amount));

  // 1. Wallet allocations backing this contract (the only true funding events).
  const allocations = await tx.query<{
    id: number;
    allocation_type: string;
    amount: string;
    created_at: string;
    journal_txn_id: number | null;
    wallet_id: number;
  }>(
    `SELECT a.id, a.allocation_type, a.amount::text AS amount, a.created_at::text AS created_at,
            wt.journal_txn_id, a.wallet_id
       FROM customer_wallet_allocations a
       LEFT JOIN customer_wallet_transactions wt
         ON wt.company_id = a.company_id AND wt.allocation_id = a.id
      WHERE a.company_id = $1 AND a.contract_id = $2
      ORDER BY a.created_at ASC, a.id ASC`,
    [companyId, contractId]
  );

  // 2. Bank rows that share a journal with any of the above or with the contract.
  const journalIds = allocations.rows
    .map(r => r.journal_txn_id)
    .filter((id): id is number => id != null);
  const bankRows = journalIds.length
    ? await tx.query<{
        id: number;
        txn_date: string;
        txn_type: string;
        amount: string;
        ref_number: string | null;
        memo: string | null;
        journal_txn_id: number | null;
      }>(
        `SELECT id, txn_date::text AS txn_date, txn_type, amount::text AS amount,
                ref_number, memo, journal_txn_id
           FROM bank_transactions
          WHERE company_id = $1 AND journal_txn_id = ANY($2::BIGINT[])
          ORDER BY txn_date ASC, id ASC`,
        [companyId, journalIds]
      )
    : { rows: [] as any[] };

  const movements: Array<Omit<ContractWalletMovement, 'balanceAfter'>> = [];

  for (const a of allocations.rows) {
    const amount = toMoneyNumber(parseDecimal4(a.amount));
    movements.push({
      id: Number(a.id),
      date: a.created_at.slice(0, 10),
      type: a.allocation_type === 'contract' ? 'allocation' : 'deposit',
      amount,
      refNumber: null,
      memo: `Wallet allocation (${a.wallet_id})`,
      journalTxnId: a.journal_txn_id,
      source: 'wallet',
    });
  }

  // Bank rows already represented by a wallet allocation above would double-count
  // the same journal, so only rows on journals we have not seen are added here.
  const coveredJournalIds = new Set(
    allocations.rows.map(r => r.journal_txn_id).filter((id): id is number => id != null)
  );
  for (const b of bankRows.rows) {
    if (b.journal_txn_id != null && coveredJournalIds.has(Number(b.journal_txn_id))) continue;
    movements.push({
      id: 10_000_000 + Number(b.id),
      date: b.txn_date,
      type: b.txn_type === 'Deposit' ? 'topup' : 'refund',
      amount: toMoneyNumber(parseDecimal4(b.amount)),
      refNumber: b.ref_number,
      memo: b.memo,
      journalTxnId: b.journal_txn_id,
      source: 'bank',
    });
  }

  // 3. Legacy fallback: GL lines on the contract's liability account when no
  //    wallet allocation or bank row exists at all.
  if (movements.length === 0) {
    const liabilityRes = await tx.query<{ liability_account_id: number | null }>(
      `SELECT liability_account_id FROM printing_contracts
        WHERE company_id = $1 AND id = $2`,
      [companyId, contractId]
    );
    const liabilityAccountId = liabilityRes.rows[0]?.liability_account_id ?? null;
    if (liabilityAccountId != null) {
      const gl = await tx.query<{
        id: number;
        txn_date: string;
        debit: string;
        credit: string;
        description: string | null;
        entry_number: string | null;
      }>(
        `SELECT jl.id, t.txn_date::text AS txn_date, jl.debit::text AS debit,
                jl.credit::text AS credit, jl.description, t.entry_number
           FROM journal_lines jl
           JOIN journal_transactions t ON t.company_id = jl.company_id AND t.id = jl.journal_txn_id
          WHERE jl.company_id = $1 AND jl.account_id = $2
            AND (t.source_type = 'printing_contract' OR t.source_type IS NULL)
          ORDER BY t.txn_date ASC, jl.id ASC`,
        [companyId, liabilityAccountId]
      );
      for (const g of gl.rows) {
        // Liability increases on credit (funding), decreases on debit (completion).
        const credit = toMoneyNumber(parseDecimal4(g.credit));
        const debit = toMoneyNumber(parseDecimal4(g.debit));
        movements.push({
          id: 20_000_000 + Number(g.id),
          date: g.txn_date,
          type: credit > 0 ? 'allocation' : 'completion',
          amount: credit > 0 ? credit : debit,
          refNumber: g.entry_number,
          memo: g.description,
          journalTxnId: null,
          source: 'gl',
        });
      }
    }
  }

  movements.sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));

  // Running balance from zero: each allocation adds retainer, each completion,
  // refund or forfeiture draws it down, so the last row lands on remaining_balance.
  let running = 0;
  return movements.map(m => {
    const signed = m.type === 'completion' || m.type === 'refund' || m.type === 'forfeit' ? -m.amount : m.amount;
    running = Math.round((running + signed) * 10000) / 10000;
    return { ...m, balanceAfter: running };
  });
}

/* ------------------------------------------------------------------ *
 * Examination papers — status transitions + removal
 * ------------------------------------------------------------------ */

type ExamPaperRow = {
  id: number;
  job_number: string;
  school_customer_id: number;
  contract_id: number | null;
  assessment_number: number | null;
  assessment_name: string;
  class_name: string;
  learners_count: number;
  price_per_learner: string;
  subject_name: string;
  pages: number;
  copies: number;
  teacher_copies: number | null;
  planned_production_quantity: number | null;
  billable_quantity: number | null;
  accepted_learner_quantity: number | null;
  damaged_teacher_copies: number | null;
  damaged_learner_copies: number | null;
  replacement_teacher_copies: number | null;
  replacement_learner_copies: number | null;
  paper_spec_id: number | null;
  raw_paper_item_id: number;
  raw_toner_item_id: number;
  print_side: string;
  binding_type: string;
  paper_size: string;
  printing_item_id: number | null;
  production_job_id: number | null;
  sheets_used: string;
  impressions_used: string;
  paper_cost: string;
  toner_cost: string;
  material_cost: string;
  status: string;
  production_date: string;
  invoice_id: number | null;
  delivery_note_id: number | null;
  qc_status: string;
  qc_approved_copies: number;
  good_copies: number;
  spoiled_copies: number;
  waste_sheets: string;
  cost_status: string;
  cost_warnings: any;
  started_at: string | null;
  completed_at: string | null;
  packed_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  reprint_of_paper_id: number | null;
  reprint_reason: string | null;
  production_version: number;
  qc_notes: string | null;
  package_count: number | null;
  seal_reference: string | null;
  created_by: number | null;
  notes: string | null;
};

const EXAM_PAPER_SELECT = `
  SELECT p.id, p.job_number,
         b.school_customer_id, b.contract_id, b.assessment_number,
         b.assessment_name, b.class_name, b.learners_count, b.price_per_learner,
         p.subject_name, p.pages, p.copies,
         p.teacher_copies, p.planned_production_quantity, p.billable_quantity,
         p.accepted_learner_quantity, p.damaged_teacher_copies, p.damaged_learner_copies,
         p.replacement_teacher_copies, p.replacement_learner_copies,
         p.paper_spec_id,
         p.raw_paper_item_id, p.raw_toner_item_id, p.print_side, p.binding_type,
         p.paper_size, p.printing_item_id, p.production_job_id,
         p.sheets_used, p.impressions_used, p.paper_cost, p.toner_cost, p.material_cost,
         p.status, p.production_date::text AS production_date, p.invoice_id,
         p.delivery_note_id, p.qc_status, p.qc_approved_copies, p.good_copies,
         p.spoiled_copies, p.waste_sheets, p.cost_status, p.cost_warnings,
         p.started_at::text AS started_at, p.completed_at::text AS completed_at,
         p.packed_at::text AS packed_at, p.dispatched_at::text AS dispatched_at,
         p.delivered_at::text AS delivered_at, p.cancelled_at::text AS cancelled_at,
         p.reprint_of_paper_id, p.reprint_reason, p.production_version,
         p.qc_notes, p.package_count, p.seal_reference,
         p.created_by, p.notes
    FROM exam_papers p
    JOIN exam_assessment_batches b
      ON b.company_id = p.company_id AND b.id = p.batch_id`;

function serializeExamPaper(r: ExamPaperRow) {
  const learnersCount = Number(r.learners_count);
  const pricePerLearner = toNum(r.price_per_learner);
  return {
    id: String(r.id),
    backendId: Number(r.id),
    jobNumber: r.job_number,
    schoolCustomerId: String(r.school_customer_id),
    assessmentName: r.assessment_name,
    className: r.class_name,
    learnersCount,
    pricePerLearner,
    subjectName: r.subject_name,
    pages: Number(r.pages),
    copies: Number(r.copies),
    teacherCopies: r.teacher_copies != null ? Number(r.teacher_copies) : undefined,
    plannedProductionQuantity: r.planned_production_quantity != null ? Number(r.planned_production_quantity) : undefined,
    billableQuantity: r.billable_quantity != null ? Number(r.billable_quantity) : undefined,
    acceptedLearnerQuantity: r.accepted_learner_quantity != null ? Number(r.accepted_learner_quantity) : undefined,
    damagedTeacherCopies: r.damaged_teacher_copies != null ? Number(r.damaged_teacher_copies) : undefined,
    damagedLearnerCopies: r.damaged_learner_copies != null ? Number(r.damaged_learner_copies) : undefined,
    replacementTeacherCopies: r.replacement_teacher_copies != null ? Number(r.replacement_teacher_copies) : undefined,
    replacementLearnerCopies: r.replacement_learner_copies != null ? Number(r.replacement_learner_copies) : undefined,
    paperSize: r.paper_size,
    printSide: r.print_side,
    bindingType: r.binding_type,
    paperSpecId: r.paper_spec_id != null ? String(r.paper_spec_id) : undefined,
    printingItemId: r.printing_item_id != null ? String(r.printing_item_id) : undefined,
    productionJobId: r.production_job_id != null ? Number(r.production_job_id) : undefined,
    rawPaperItemId: String(r.raw_paper_item_id),
    rawTonerItemId: String(r.raw_toner_item_id),
    ratePerPage: 0,
    totalAmount: Number((learnersCount * pricePerLearner).toFixed(2)),
    sheetsUsed: toNum(r.sheets_used),
    impressionsUsed: toNum(r.impressions_used),
    paperCost: toNum(r.paper_cost),
    tonerCost: toNum(r.toner_cost),
    materialCost: toNum(r.material_cost),
    status: r.status,
    productionDate: r.production_date,
    contractId: r.contract_id != null ? String(r.contract_id) : undefined,
    assessmentNumber: r.assessment_number != null ? Number(r.assessment_number) : undefined,
    backendInvoiceId: r.invoice_id != null ? Number(r.invoice_id) : undefined,
    invoiceId: r.invoice_id != null ? String(r.invoice_id) : undefined,
    deliveryNoteId: r.delivery_note_id != null ? Number(r.delivery_note_id) : undefined,
    qcStatus: r.qc_status,
    qcApprovedCopies: Number(r.qc_approved_copies),
    goodCopies: Number(r.good_copies),
    spoiledCopies: Number(r.spoiled_copies),
    wasteSheets: toNum(r.waste_sheets),
    costStatus: r.cost_status,
    costWarnings: Array.isArray(r.cost_warnings) ? r.cost_warnings : [],
    startedAt: r.started_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
    packedAt: r.packed_at ?? undefined,
    dispatchedAt: r.dispatched_at ?? undefined,
    deliveredAt: r.delivered_at ?? undefined,
    cancelledAt: r.cancelled_at ?? undefined,
    reprintOfPaperId: r.reprint_of_paper_id != null ? Number(r.reprint_of_paper_id) : undefined,
    reprintReason: r.reprint_reason ?? undefined,
    productionVersion: Number(r.production_version ?? 1),
    qcNotes: r.qc_notes ?? undefined,
    packageCount: r.package_count != null ? Number(r.package_count) : undefined,
    sealReference: r.seal_reference ?? undefined,
    createdBy: r.created_by != null ? Number(r.created_by) : undefined,
    notes: r.notes ?? undefined,
  };
}

/**
 * Edit an examination paper's details before production begins.
 *
 * Guardrails:
 *  - Only editable while the paper is `queued` and the batch spec is not frozen
 *    (once the specification is approved/production starts, use a controlled
 *    reprint instead).
 *  - D3: teacher copies are fixed (never user-editable); planned production =
 *    learner copies + teacher copies and billable = learner copies.
 *  - The linked printing job's ordered quantity is kept in sync so the press run
 *    produces the edited quantity.
 *  - Every edit is appended to the immutable `exam_paper_events` timeline.
 */
export async function updateExamPaperDetails(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  paperId: number,
  input: {
    subjectName?: string;
    pages?: number;
    copies?: number;
    printSide?: string;
    bindingType?: string;
    paperSize?: string;
    productionDate?: string | null;
    notes?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }
) {
  const route = 'exam_paper_edit';
  const claim = await claimPrintingIdempotency(
    tx,
    companyId,
    route,
    input.idempotencyKey,
    actor.userId,
    { paperId, ...input }
  );
  if (claim.replay) return claim.replay.body.paper;

  const res = await tx.query<{
    id: number;
    batch_id: number;
    job_number: string;
    status: string;
    subject_name: string;
    pages: number;
    copies: number;
    teacher_copies: number | null;
    print_side: string;
    binding_type: string;
    paper_size: string;
    production_job_id: number | null;
    spec_frozen: boolean;
  }>(
    `SELECT p.id, p.batch_id, p.job_number, p.status, p.subject_name, p.pages, p.copies,
            p.teacher_copies, p.print_side, p.binding_type, p.paper_size, p.production_job_id,
            b.spec_frozen
       FROM exam_papers p
       JOIN exam_assessment_batches b
         ON b.company_id = p.company_id AND b.id = p.batch_id
      WHERE p.company_id = $1 AND p.id = $2
      FOR UPDATE OF p`,
    [companyId, paperId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Examination paper not found in active company', 'EXAM_PAPER_NOT_FOUND');
  }
  const p = res.rows[0];

  if (p.status !== 'queued') {
    throw new AccountingError(
      409,
      `Examination paper ${p.job_number} can only be edited while queued (current status: ${p.status})`,
      'EXAM_PAPER_NOT_EDITABLE'
    );
  }
  if (p.spec_frozen) {
    throw new AccountingError(
      409,
      `The production specification for ${p.job_number} is frozen; cancel and raise a controlled reprint to change it`,
      'EXAM_SPEC_FROZEN'
    );
  }

  const teacherCopies = p.teacher_copies != null ? Number(p.teacher_copies) : 2;

  const nextCopies = input.copies != null ? Number(input.copies) : Number(p.copies);
  if (!Number.isInteger(nextCopies) || nextCopies <= 0) {
    throw new AccountingError(400, 'copies must be a positive integer', 'INVALID_PAPER_QUANTITY');
  }
  const nextPages = input.pages != null ? Number(input.pages) : Number(p.pages);
  if (!Number.isInteger(nextPages) || nextPages <= 0) {
    throw new AccountingError(400, 'pages must be a positive integer', 'INVALID_PAPER_PAGES');
  }
  const nextSubject =
    input.subjectName != null ? String(input.subjectName).trim() : p.subject_name;
  if (!nextSubject) {
    throw new AccountingError(400, 'subjectName cannot be blank', 'MISSING_BATCH_FIELDS');
  }
  const nextProductionDate =
    input.productionDate != null ? assertIsoDate(input.productionDate, 'productionDate') : null;

  // D3: teacher copies are fixed; planned = learner + teacher, billable = learner.
  const nextPlanned = nextCopies + teacherCopies;
  const nextBillable = nextCopies;

  const changed =
    nextSubject !== p.subject_name ||
    nextPages !== Number(p.pages) ||
    nextCopies !== Number(p.copies) ||
    input.printSide !== undefined ||
    input.bindingType !== undefined ||
    input.paperSize !== undefined ||
    input.productionDate !== undefined ||
    input.notes !== undefined;

  if (changed) {
    await tx.query(
      `UPDATE exam_papers
          SET subject_name = $3,
              pages = $4,
              copies = $5,
              planned_production_quantity = $6,
              billable_quantity = $7,
              print_side = COALESCE($8, print_side),
              binding_type = COALESCE($9, binding_type),
              paper_size = COALESCE($10, paper_size),
              production_date = COALESCE($11::DATE, production_date),
              notes = COALESCE($12, notes),
              updated_at = NOW()
        WHERE company_id = $1 AND id = $2`,
      [
        companyId,
        paperId,
        nextSubject,
        nextPages,
        nextCopies,
        nextPlanned,
        nextBillable,
        input.printSide ?? null,
        input.bindingType ?? null,
        input.paperSize ?? null,
        nextProductionDate,
        input.notes != null ? String(input.notes).trim() || null : null,
      ]
    );

    // Keep the linked production job in sync so it produces the edited quantity.
    if (p.production_job_id != null) {
      await tx.query(
        `UPDATE printing_jobs
            SET pages = $3,
                copies = $4,
                ordered_qty = $5,
                updated_at = NOW()
          WHERE company_id = $1 AND id = $2`,
        [companyId, Number(p.production_job_id), nextPages, nextPlanned, nextPlanned]
      );
    }

    await insertExamPaperEvent(tx, {
      companyId,
      batchId: Number(p.batch_id),
      paperId,
      eventType: 'edited',
      fromStatus: p.status,
      toStatus: p.status,
      actorUserId: actor.userId,
      reason: input.reason ?? 'Examination paper details edited',
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:edit:${paperId}` : null,
      metadata: {
        previous: {
          subjectName: p.subject_name,
          pages: Number(p.pages),
          copies: Number(p.copies),
          printSide: p.print_side,
          bindingType: p.binding_type,
          paperSize: p.paper_size,
        },
        updated: {
          subjectName: nextSubject,
          pages: nextPages,
          copies: nextCopies,
          plannedProductionQuantity: nextPlanned,
          billableQuantity: nextBillable,
        },
      },
    });

    await writeAuditLog(tx, {
      companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'EXAM_PAPER_EDITED',
      tableName: 'exam_papers',
      recordId: paperId,
      newValues: {
        jobNumber: p.job_number,
        previousCopies: Number(p.copies),
        copies: nextCopies,
        pages: nextPages,
        plannedProductionQuantity: nextPlanned,
      },
    });
  }

  const updated = await tx.query<ExamPaperRow>(
    `${EXAM_PAPER_SELECT}
      WHERE p.company_id = $1 AND p.id = $2`,
    [companyId, paperId]
  );
  if (updated.rows.length === 0) {
    throw new AccountingError(404, 'Examination paper not found in active company', 'EXAM_PAPER_NOT_FOUND');
  }
  const paper = serializeExamPaper(updated.rows[0]);

  await completePrintingIdempotency(tx, companyId, route, input.idempotencyKey, 200, { paper });
  return paper;
}

export async function listExamPapers(tx: Transaction, companyId: number) {
  const res = await tx.query<ExamPaperRow>(
    `${EXAM_PAPER_SELECT}
      WHERE p.company_id = $1
      ORDER BY p.id DESC`,
    [companyId]
  );
  return res.rows.map(serializeExamPaper);
}

export type ExamPaperStatusValue =
  | 'queued'
  | 'printing'
  | 'completed'
  | 'qc_hold'
  | 'qc_passed'
  | 'packed'
  | 'dispatched';

/**
 * Server-enforced examination production transition matrix. Only the listed
 * edges may be taken; invoiced/cancelled papers are terminal for this endpoint.
 * Each edge has a matching permission enforced at the route layer:
 *   queued -> printing        exams:produce
 *   printing -> completed     exams:qc
 *   printing -> qc_passed     exams:qc
 *   printing -> qc_hold       exams:qc
 *   qc_hold -> printing       exams:produce
 *   qc_passed -> packed       exams:dispatch
 *   packed -> dispatched      exams:dispatch
 *   dispatched -> delivered   exams:deliver
 */
export const EXAM_STATUS_ALLOWED: Record<string, string[]> = {
  draft: ['scheduled', 'queued', 'cancelled'],
  scheduled: ['queued', 'cancelled'],
  queued: ['printing', 'cancelled'],
  reserved: ['printing', 'cancelled'],
  printing: ['completed', 'qc_passed', 'qc_hold', 'queued', 'cancelled'],
  qc_hold: ['printing', 'qc_passed', 'cancelled'],
  qc_passed: ['completed', 'packed', 'delivered', 'cancelled'],
  completed: ['packed', 'dispatched', 'delivered', 'cancelled'],
  packed: ['dispatched', 'delivered', 'cancelled'],
  dispatched: ['delivered'],
  delivered: ['invoiced'],
  invoiced: [],
  cancelled: [],
  reprinted: [],
};

export async function updateExamPaperStatus(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  paperId: number,
  nextStatus: ExamPaperStatusValue,
  options: {
    reason?: string | null;
    goodCopies?: number;
    spoiledCopies?: number;
    packageCount?: number;
    sealReference?: string | null;
    qcNotes?: string | null;
  } = {}
) {
  const res = await tx.query<{
    id: number;
    batch_id: number;
    job_number: string;
    status: string;
    copies: number;
    teacher_copies: number | null;
    planned_production_quantity: number | null;
    production_job_id: number | null;
    sheets_used: string;
    impressions_used: string;
  }>(
    `SELECT id, batch_id, job_number, status, copies,
            teacher_copies, planned_production_quantity, production_job_id,
            sheets_used::text, impressions_used::text
       FROM exam_papers
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, paperId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Examination paper not found in active company', 'EXAM_PAPER_NOT_FOUND');
  }
  const paper = res.rows[0];
  if (paper.status === 'invoiced' || paper.status === 'cancelled') {
    throw new AccountingError(
      409,
      `${paper.status} examination papers cannot change status`,
      'INVALID_EXAM_STATUS_TRANSITION'
    );
  }

  const legal = EXAM_STATUS_ALLOWED[paper.status] ?? [];
  if (!legal.includes(nextStatus)) {
    throw new AccountingError(
      409,
      `Cannot move an examination paper from ${paper.status} to ${nextStatus}`,
      'INVALID_EXAM_STATUS_TRANSITION'
    );
  }
  const reason = String(options.reason || '').trim();
  if ((nextStatus === 'queued' || nextStatus === 'qc_hold') && !reason) {
    throw new AccountingError(
      400,
      nextStatus === 'qc_hold'
        ? 'A QC failure reason is required to place an examination paper on QC hold'
        : 'A reason is required to move a printing paper back to queued',
      'REASON_REQUIRED'
    );
  }

  const teacherCopies = paper.teacher_copies != null ? Number(paper.teacher_copies) : 2;
  const plannedQty =
    paper.planned_production_quantity != null
      ? Number(paper.planned_production_quantity)
      : Number(paper.copies) + teacherCopies;

  const goodCopies =
    options.goodCopies != null && Number.isInteger(Number(options.goodCopies))
      ? Number(options.goodCopies)
      : plannedQty;
  const spoiledCopies =
    options.spoiledCopies != null && Number.isInteger(Number(options.spoiledCopies))
      ? Number(options.spoiledCopies)
      : 0;
  if (
    goodCopies < 0 ||
    spoiledCopies < 0 ||
    spoiledCopies > plannedQty ||
    ((nextStatus === 'completed' || nextStatus === 'qc_passed') &&
      goodCopies + spoiledCopies > plannedQty)
  ) {
    throw new AccountingError(
      400,
      'Good and spoiled copies must be non-negative and cannot exceed the planned production quantity',
      'INVALID_QC_QUANTITY'
    );
  }

  // D3: teacher copies are fulfilled first and never invoiced. The accepted
  // (billable) learner quantity is the good output minus the teacher allowance,
  // clamped to zero so a short run reduces billable learner copies.
  const acceptedLearnerQty = Math.max(0, goodCopies - teacherCopies);

  let productionJobId: number | null = paper.production_job_id ? Number(paper.production_job_id) : null;
  let journalTxnId: number | null = null;

  // New server-authoritative papers have a linked printing_jobs row. Drive the
  // existing production/inventory/accounting services rather than mutating
  // exam status in isolation. Legacy papers without a production job keep the
  // original status-only behaviour for backward compatibility.
  if (productionJobId != null) {
    if (nextStatus === 'printing') {
      if (paper.status === 'qc_hold') {
        // Rework after QC failure: materials are already issued and the press
        // run was already counted, so only the execution checkpoint moves back.
        // Adding production quantity again would double-count output.
        await tx.query(
          `UPDATE exam_papers
              SET status = 'printing', qc_status = 'in_progress', qc_notes = $3
            WHERE company_id = $1 AND id = $2`,
          [companyId, paperId, options.qcNotes ?? reason]
        );
      } else {
        const jobRes = await tx.query<{ budget_approved_at: string | null }>(
          `SELECT budget_approved_at::text
             FROM printing_jobs
            WHERE company_id = $1 AND id = $2
            FOR UPDATE`,
          [companyId, productionJobId]
        );
        if (jobRes.rows.length === 0) {
          throw new AccountingError(409, 'Linked production job not found for examination paper', 'EXAM_PRODUCTION_JOB_MISSING');
        }
        if (!jobRes.rows[0].budget_approved_at) {
          await approveJobBudget(tx, companyId, actor, productionJobId);
        }
        await reserveJobMaterials(tx, companyId, actor, productionJobId);
        const issued = await issueJobMaterials(tx, companyId, actor, productionJobId);
        journalTxnId = issued.journalTxnId;

        await recordProductionOperation(tx, companyId, actor, productionJobId, {
          stage: 'press_run',
          producedQtyAdded: plannedQty,
          goodSheets: Number(paper.sheets_used),
          spoilageSheets: 0,
          impressionsRun: Number(paper.impressions_used),
          operationDate: new Date().toISOString().slice(0, 10),
          notes: 'Examination paper press run',
        });

        await tx.query(
          `UPDATE exam_papers
              SET status = 'printing', started_at = NOW(), qc_status = 'in_progress'
            WHERE company_id = $1 AND id = $2`,
          [companyId, paperId]
        );
      }
    } else if (nextStatus === 'completed' || nextStatus === 'qc_passed') {
      const jobRes = await tx.query<{ produced_good_qty: string; status: string }>(
        `SELECT produced_good_qty::text, status FROM printing_jobs
          WHERE company_id = $1 AND id = $2 FOR UPDATE`,
        [companyId, productionJobId]
      );
      if (jobRes.rows.length === 0) {
        throw new AccountingError(409, 'Linked production job not found for examination paper', 'EXAM_PRODUCTION_JOB_MISSING');
      }
      if (Number(jobRes.rows[0].produced_good_qty) <= 0) {
        throw new AccountingError(
          409,
          'Production must be started before the examination paper can complete QC',
          'EXAM_PRODUCTION_NOT_STARTED'
        );
      }
      await recordQualityInspection(tx, companyId, actor, productionJobId, {
        sampleSize: plannedQty,
        defectCount: spoiledCopies,
        registrationOk: true,
        printDensityOk: true,
        bindingOk: true,
        disposition: 'approved',
        approvedQty: goodCopies,
        notes: options.qcNotes ?? 'Examination paper QC approval',
      });
      await tx.query(
        `UPDATE exam_papers
            SET status = $4, qc_status = 'passed',
                qc_approved_copies = $3, good_copies = $3, spoiled_copies = $5,
                accepted_learner_quantity = $6, billable_quantity = $6,
                qc_notes = $7, completed_at = COALESCE(completed_at, NOW())
          WHERE company_id = $1 AND id = $2`,
        [companyId, paperId, goodCopies, nextStatus, spoiledCopies, acceptedLearnerQty, options.qcNotes ?? null]
      );
    } else if (nextStatus === 'qc_hold') {
      await recordQualityInspection(tx, companyId, actor, productionJobId, {
        sampleSize: plannedQty,
        defectCount: spoiledCopies > 0 ? spoiledCopies : 1,
        registrationOk: false,
        printDensityOk: false,
        bindingOk: false,
        disposition: 'rejected',
        notes: reason,
      });
      await tx.query(
        `UPDATE exam_papers
            SET status = 'qc_hold', qc_status = 'failed', qc_notes = $3
          WHERE company_id = $1 AND id = $2`,
        [companyId, paperId, options.qcNotes ?? reason]
      );
    } else if (nextStatus === 'packed') {
      if (options.packageCount != null && (!Number.isInteger(Number(options.packageCount)) || Number(options.packageCount) < 0)) {
        throw new AccountingError(400, 'packageCount must be a non-negative integer', 'INVALID_PACKAGE_COUNT');
      }
      await tx.query(
        `UPDATE exam_papers
            SET status = 'packed', packed_at = NOW(),
                package_count = $3, seal_reference = $4
          WHERE company_id = $1 AND id = $2`,
        [
          companyId,
          paperId,
          options.packageCount != null ? Number(options.packageCount) : null,
          options.sealReference ?? null,
        ]
      );
    } else if (nextStatus === 'dispatched') {
      await tx.query(
        `UPDATE exam_papers SET status = 'dispatched', dispatched_at = NOW()
          WHERE company_id = $1 AND id = $2`,
        [companyId, paperId]
      );
    } else if (nextStatus === 'queued') {
      const issuedRes = await tx.query<{ issued: string }>(
        `SELECT COALESCE(SUM(issued_usage_qty), 0)::text AS issued
           FROM job_material_requirements
          WHERE company_id = $1 AND printing_job_id = $2`,
        [companyId, productionJobId]
      );
      if (Number(issuedRes.rows[0]?.issued || 0) > 0) {
        throw new AccountingError(
          409,
          'Materials have already been issued. Record a controlled rework/return before moving this paper back to queued.',
          'REWORK_AFTER_MATERIAL_ISSUE'
        );
      }
      await tx.query(
        `UPDATE exam_papers SET status = 'queued', started_at = NULL WHERE company_id = $1 AND id = $2`,
        [companyId, paperId]
      );
    }
  } else {
    await tx.query(`UPDATE exam_papers SET status = $1 WHERE company_id = $2 AND id = $3`, [
      nextStatus,
      companyId,
      paperId,
    ]);
  }

  await insertExamPaperEvent(tx, {
    companyId,
    batchId: Number(paper.batch_id),
    paperId,
    eventType: 'status_changed',
    fromStatus: paper.status,
    toStatus: nextStatus,
    actorUserId: actor.userId,
    reason: options.reason ?? null,
    quantityDelta: nextStatus === 'qc_passed' || nextStatus === 'completed' ? goodCopies : null,
    journalTxnId,
    metadata: { productionJobId, spoiledCopies },
  });

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'EXAM_PAPER_STATUS_UPDATED',
    tableName: 'exam_papers',
    recordId: paperId,
    oldValues: { status: paper.status },
    newValues: {
      status: nextStatus,
      reason: options.reason ?? null,
      productionJobId,
      journalTxnId,
      goodCopies,
      spoiledCopies,
      packageCount: options.packageCount ?? null,
    },
  });

  return { paperId, jobNumber: paper.job_number, status: nextStatus, productionJobId, journalTxnId };
}

/**
 * Controlled examination cancellation. Completed/delivered/invoiced papers are
 * never hard-deleted: they require a credit-note/reversal workflow. Before that
 * point the linked production job releases reservations, returns unused
 * material and writes off non-recoverable WIP through the existing production
 * service, and the cancellation is recorded as an append-only event.
 */
export async function cancelExamPaper(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  paperId: number,
  input: { reason: string; returnUnusedMaterials?: boolean }
) {
  const reason = String(input.reason || '').trim();
  if (!reason) {
    throw new AccountingError(400, 'Cancellation reason is required', 'REASON_REQUIRED');
  }
  const res = await tx.query<{
    id: number;
    batch_id: number;
    job_number: string;
    status: string;
    production_job_id: number | null;
  }>(
    `SELECT id, batch_id, job_number, status, production_job_id
       FROM exam_papers
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, paperId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Examination paper not found in active company', 'EXAM_PAPER_NOT_FOUND');
  }
  const paper = res.rows[0];
  if (paper.status === 'cancelled') {
    throw new AccountingError(409, 'Examination paper is already cancelled', 'EXAM_PAPER_ALREADY_CANCELLED');
  }
  if (['delivered', 'invoiced', 'dispatched'].includes(paper.status)) {
    throw new AccountingError(
      409,
      `${paper.status} examination papers cannot be cancelled; use a credit-note or reversal workflow`,
      'EXAM_PAPER_NOT_CANCELLABLE'
    );
  }

  if (paper.production_job_id) {
    await cancelPrintingJob(tx, companyId, actor, Number(paper.production_job_id), {
      reason: `Examination cancellation ${paper.job_number}: ${reason}`,
      returnUnusedMaterials: input.returnUnusedMaterials !== false,
    });
  }

  await tx.query(
    `UPDATE exam_papers
        SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $3,
            cancellation_reason = $4
      WHERE company_id = $1 AND id = $2`,
    [companyId, paperId, actor.userId, reason]
  );

  await insertExamPaperEvent(tx, {
    companyId,
    batchId: Number(paper.batch_id),
    paperId,
    eventType: 'cancelled',
    fromStatus: paper.status,
    toStatus: 'cancelled',
    actorUserId: actor.userId,
    reason,
    metadata: { productionJobId: paper.production_job_id ?? null },
  });

  // Cancel the batch header once no live paper remains.
  await tx.query(
    `UPDATE exam_assessment_batches b
        SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $3,
            cancellation_reason = $4
      WHERE b.company_id = $1 AND b.id = $2
        AND NOT EXISTS (
          SELECT 1 FROM exam_papers p
           WHERE p.company_id = b.company_id AND p.batch_id = b.id
             AND p.status <> 'cancelled'
        )`,
    [companyId, Number(paper.batch_id), actor.userId, reason]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'EXAM_PAPER_CANCELLED',
    tableName: 'exam_papers',
    recordId: paperId,
    oldValues: { status: paper.status },
    newValues: { status: 'cancelled', reason, productionJobId: paper.production_job_id ?? null },
  });

  return { paperId, jobNumber: paper.job_number, status: 'cancelled' };
}

/**
 * Controlled reprint. Creates a new production record in the same batch linked
 * to its parent. The original paper, its costs and its invoice stay untouched.
 */
export async function createExamReprint(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  paperId: number,
  input: { reason: string; copies?: number; productionDate?: string | null; idempotencyKey?: string | null }
) {
  const route = 'exam_reprint';
  const claim = await claimPrintingIdempotency(
    tx,
    companyId,
    route,
    input.idempotencyKey,
    actor.userId,
    { paperId, ...input }
  );
  if (claim.replay) return claim.replay.body.reprint;

  const reason = String(input.reason || '').trim();
  if (!reason) {
    throw new AccountingError(400, 'reprintReason is required for a controlled reprint', 'REASON_REQUIRED');
  }
  const res = await tx.query<{
    id: number;
    batch_id: number;
    job_number: string;
    subject_name: string;
    pages: number;
    copies: number;
    paper_spec_id: number | null;
    raw_paper_item_id: number;
    raw_toner_item_id: number;
    print_side: string;
    binding_type: string;
    paper_size: string;
    printing_item_id: number | null;
    machine_id: number | null;
    production_version: number;
    status: string;
    school_customer_id: number;
    assessment_name: string;
    class_name: string;
    assessment_number: number | null;
    contract_id: number | null;
  }>(
    `SELECT p.id, p.batch_id, p.job_number, p.subject_name, p.pages, p.copies,
            p.paper_spec_id, p.raw_paper_item_id, p.raw_toner_item_id,
            p.print_side, p.binding_type, p.paper_size, p.printing_item_id,
            p.machine_id, p.production_version, p.status,
            b.school_customer_id, b.assessment_name, b.class_name,
            b.assessment_number, b.contract_id
       FROM exam_papers p
       JOIN exam_assessment_batches b
         ON b.company_id = p.company_id AND b.id = p.batch_id
      WHERE p.company_id = $1 AND p.id = $2
      FOR UPDATE OF p`,
    [companyId, paperId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Examination paper not found in active company', 'EXAM_PAPER_NOT_FOUND');
  }
  const parent = res.rows[0];
  if (parent.status === 'cancelled') {
    throw new AccountingError(409, 'A cancelled examination paper cannot be reprinted', 'EXAM_PAPER_CANCELLED');
  }
  if (!['printing', 'qc_hold', 'qc_passed', 'completed', 'packed', 'dispatched', 'delivered', 'invoiced'].includes(parent.status)) {
    throw new AccountingError(
      409,
      `A reprint can only be raised after production has started (current: ${parent.status})`,
      'EXAM_REPRINT_NOT_ELIGIBLE'
    );
  }

  const copies = input.copies != null ? Number(input.copies) : Number(parent.copies);
  if (!Number.isInteger(copies) || copies <= 0) {
    throw new AccountingError(400, 'copies must be a positive integer', 'INVALID_PAPER_QUANTITY');
  }
  const productionDate = input.productionDate
    ? assertIsoDate(input.productionDate, 'productionDate')
    : new Date().toISOString().slice(0, 10);
  const jobNumber = await nextPrintingNumber(tx, companyId, 'exam_paper', 'EXM-', 4);
  const productionVersion = Number(parent.production_version || 1) + 1;

  // D3: reprints do not automatically grant teacher copies; they are replacements/additional production.
  const teacherCopies = 0;
  const plannedQty = copies;
  const billableQty = copies;

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO exam_papers (
       company_id, batch_id, job_number, subject_name, pages, copies,
       teacher_copies, planned_production_quantity, billable_quantity,
       raw_paper_item_id, raw_toner_item_id, paper_spec_id, print_side, binding_type,
       sheets_used, impressions_used, paper_cost, toner_cost, status, production_date,
       notes, paper_size, printing_item_id, machine_id, created_by, queued_at,
       cost_status, cost_warnings, reprint_of_paper_id, reprint_reason, production_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               0, 0, 0, 0, 'queued', $15::DATE, $16, $17, $18, $19, $20, NOW(),
               'estimated', '[]'::jsonb, $21, $22, $23)
     RETURNING id`,
    [
      companyId,
      Number(parent.batch_id),
      jobNumber,
      parent.subject_name,
      Number(parent.pages),
      copies,
      teacherCopies,
      plannedQty,
      billableQty,
      Number(parent.raw_paper_item_id),
      Number(parent.raw_toner_item_id),
      parent.paper_spec_id != null ? Number(parent.paper_spec_id) : null,
      parent.print_side,
      parent.binding_type,
      productionDate,
      `Controlled reprint of ${parent.job_number}: ${reason}`,
      parent.paper_size,
      parent.printing_item_id != null ? Number(parent.printing_item_id) : null,
      parent.machine_id != null ? Number(parent.machine_id) : null,
      actor.userId,
      paperId,
      reason,
      productionVersion,
    ]
  );
  const newPaperId = Number(ins.rows[0].id);

  const job = await createExamProductionJob(tx, companyId, actor, {
    schoolCustomerId: Number(parent.school_customer_id),
    customerName: String(parent.assessment_name),
    assessmentName: parent.assessment_name,
    className: parent.class_name,
    paper: {
      subjectName: parent.subject_name,
      pages: Number(parent.pages),
      copies,
      rawPaperItemId: Number(parent.raw_paper_item_id),
      rawTonerItemId: Number(parent.raw_toner_item_id),
      printSide: parent.print_side === 'Single-Sided' ? 'Single-Sided' : 'Duplex',
      paperSize: parent.paper_size,
      productionDate,
      machineId: parent.machine_id != null ? Number(parent.machine_id) : undefined,
      notes: `Reprint of ${parent.job_number}: ${reason}`,
    },
    subjectName: `${parent.subject_name} (Reprint)`,
    pages: Number(parent.pages),
    copies,
    printSide: parent.print_side === 'Single-Sided' ? 'Single-Sided' : 'Duplex',
    productionDate,
    idempotencyKey: input.idempotencyKey ?? null,
  });

  const costStatus = job.impressionsUsed > 0 && job.tonerCost <= 0 ? 'unavailable' : 'estimated';
  const costWarnings =
    costStatus === 'unavailable'
      ? JSON.stringify([
          'Toner cost could not be established from a rated yield or material specification; review before invoicing.',
        ])
      : '[]';

  await tx.query(
    `UPDATE exam_papers
        SET production_job_id = $3,
            sheets_used = $4::NUMERIC(19,6),
            impressions_used = $5::NUMERIC(19,6),
            paper_cost = $6::NUMERIC(19,4),
            toner_cost = $7::NUMERIC(19,4),
            cost_status = $8,
            cost_warnings = $9::jsonb
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      newPaperId,
      Number(job.id),
      job.sheetsUsed,
      job.impressionsUsed,
      job.paperCost,
      job.tonerCost,
      costStatus,
      costWarnings,
    ]
  );
  await tx.query(
    `UPDATE printing_jobs SET exam_paper_id = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, Number(job.id), newPaperId]
  );
  await tx.query(
    `UPDATE exam_assessment_batches
        SET total_paper_cost = COALESCE((SELECT SUM(paper_cost) FROM exam_papers
              WHERE company_id = $1 AND batch_id = $2), 0),
            total_toner_cost = COALESCE((SELECT SUM(toner_cost) FROM exam_papers
              WHERE company_id = $1 AND batch_id = $2), 0)
      WHERE company_id = $1 AND id = $2`,
    [companyId, Number(parent.batch_id)]
  );

  await insertExamPaperEvent(tx, {
    companyId,
    batchId: Number(parent.batch_id),
    paperId: newPaperId,
    eventType: 'reprinted',
    fromStatus: null,
    toStatus: 'queued',
    actorUserId: actor.userId,
    reason,
    idempotencyKey: input.idempotencyKey
      ? `${input.idempotencyKey}:reprint:${newPaperId}`
      : null,
    metadata: { parentPaperId: paperId, parentJobNumber: parent.job_number, productionVersion },
  });

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'EXAM_PAPER_REPRINTED',
    tableName: 'exam_papers',
    recordId: newPaperId,
    newValues: {
      parentPaperId: paperId,
      parentJobNumber: parent.job_number,
      jobNumber,
      productionVersion,
      reason,
      copies,
    },
  });

  const out = {
    paperId: newPaperId,
    jobNumber,
    subjectName: parent.subject_name,
    batchId: Number(parent.batch_id),
    reprintOfPaperId: paperId,
    productionJobId: Number(job.id),
    productionVersion,
    status: 'queued',
  };
  await completePrintingIdempotency(tx, companyId, route, input.idempotencyKey, 201, { reprint: out });
  return out;
}

/** Append-only examination production timeline for one paper. */
export async function listExamPaperEvents(tx: Transaction, companyId: number, paperId: number) {
  const paper = await tx.query<{ id: number }>(
    `SELECT id FROM exam_papers WHERE company_id = $1 AND id = $2`,
    [companyId, paperId]
  );
  if (paper.rows.length === 0) {
    throw new AccountingError(404, 'Examination paper not found in active company', 'EXAM_PAPER_NOT_FOUND');
  }
  const res = await tx.query<any>(
    `SELECT id, event_type, from_status, to_status, actor_user_id, reason,
            quantity_delta::text, inventory_txn_id, journal_txn_id, invoice_id,
            idempotency_key, metadata, created_at::text
       FROM exam_paper_events
      WHERE company_id = $1 AND paper_id = $2
      ORDER BY id ASC`,
    [companyId, paperId]
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    eventType: r.event_type,
    fromStatus: r.from_status ?? undefined,
    toStatus: r.to_status ?? undefined,
    actorUserId: r.actor_user_id != null ? Number(r.actor_user_id) : undefined,
    reason: r.reason ?? undefined,
    quantityDelta: r.quantity_delta != null ? toNum(r.quantity_delta) : undefined,
    inventoryTxnId: r.inventory_txn_id != null ? Number(r.inventory_txn_id) : undefined,
    journalTxnId: r.journal_txn_id != null ? Number(r.journal_txn_id) : undefined,
    invoiceId: r.invoice_id != null ? Number(r.invoice_id) : undefined,
    idempotencyKey: r.idempotency_key ?? undefined,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
  }));
}

/** Batch register for the examination workspace. */
export async function listExamBatches(
  tx: Transaction,
  companyId: number,
  filters: { status?: string | null; schoolCustomerId?: number | null } = {}
) {
  const params: unknown[] = [companyId];
  let where = `b.company_id = $1`;
  if (filters.status) {
    params.push(filters.status);
    where += ` AND b.status = $${params.length}`;
  }
  if (filters.schoolCustomerId) {
    params.push(Number(filters.schoolCustomerId));
    where += ` AND b.school_customer_id = $${params.length}`;
  }
  const res = await tx.query<any>(
    `SELECT b.id, b.assessment_name, b.class_name, b.learners_count,
            b.price_per_learner::text, b.class_revenue::text,
            b.contract_id, b.assessment_number, b.status,
            b.due_date::text AS due_date, b.priority,
            b.total_paper_cost::text, b.total_toner_cost::text, b.invoice_id,
            b.spec_frozen, b.spec_version, b.spec_hash, b.spec_approved_at::text,
            b.school_customer_id, c.company_name,
            COUNT(p.id)::int AS paper_count,
            COUNT(p.id) FILTER (WHERE p.status = 'invoiced')::int AS invoiced_papers,
            COUNT(p.id) FILTER (WHERE p.status = 'delivered')::int AS delivered_papers,
            COUNT(p.id) FILTER (WHERE p.status = 'cancelled')::int AS cancelled_papers,
            COALESCE(SUM(p.good_copies), 0)::int AS good_copies,
            COALESCE(SUM(p.spoiled_copies), 0)::int AS spoiled_copies
       FROM exam_assessment_batches b
       JOIN customers c ON c.company_id = b.company_id AND c.id = b.school_customer_id
       LEFT JOIN exam_papers p ON p.company_id = b.company_id AND p.batch_id = b.id
      WHERE ${where}
      GROUP BY b.id, c.company_name
      ORDER BY b.id DESC`,
    params
  );
  return res.rows.map(r => ({
    backendId: Number(r.id),
    assessmentName: r.assessment_name,
    className: r.class_name,
    schoolCustomerId: String(r.school_customer_id),
    schoolName: r.company_name,
    learnersCount: Number(r.learners_count),
    pricePerLearner: toNum(r.price_per_learner),
    classRevenue: toNum(r.class_revenue),
    contractId: r.contract_id != null ? String(r.contract_id) : undefined,
    assessmentNumber: r.assessment_number != null ? Number(r.assessment_number) : undefined,
    status: r.status,
    dueDate: r.due_date ?? undefined,
    priority: r.priority,
    totalPaperCost: toNum(r.total_paper_cost),
    totalTonerCost: toNum(r.total_toner_cost),
    invoiceId: r.invoice_id != null ? Number(r.invoice_id) : undefined,
    specFrozen: Boolean(r.spec_frozen),
    specVersion: Number(r.spec_version),
    specHash: r.spec_hash ?? undefined,
    specApprovedAt: r.spec_approved_at ?? undefined,
    paperCount: Number(r.paper_count),
    invoicedPapers: Number(r.invoiced_papers),
    deliveredPapers: Number(r.delivered_papers),
    cancelledPapers: Number(r.cancelled_papers),
    goodCopies: Number(r.good_copies),
    spoiledCopies: Number(r.spoiled_copies),
  }));
}

/**
 * Freeze the approved production specification for a batch. The hash is
 * computed from the current paper specifications so any later change can be
 * proven to differ from what was approved.
 */
export async function approveExamBatchSpecification(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  batchId: number,
  input: { notes?: string | null } = {}
) {
  const batch = await tx.query<any>(
    `SELECT id, spec_version, spec_frozen, spec_hash, assessment_name, class_name
       FROM exam_assessment_batches
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, batchId]
  );
  if (batch.rows.length === 0) {
    throw new AccountingError(404, 'Examination batch not found in active company', 'EXAM_BATCH_NOT_FOUND');
  }
  const row = batch.rows[0];
  if (row.spec_frozen) {
    return {
      batchId,
      specFrozen: true,
      specVersion: Number(row.spec_version),
      specHash: row.spec_hash,
      idempotentReplay: true,
    };
  }
  const papers = await tx.query<any>(
    `SELECT id, subject_name, pages, copies,
            teacher_copies, planned_production_quantity, billable_quantity,
            paper_size, print_side, binding_type,
            raw_paper_item_id, raw_toner_item_id, printing_item_id
       FROM exam_papers
      WHERE company_id = $1 AND batch_id = $2
      ORDER BY id ASC`,
    [companyId, batchId]
  );
  if (papers.rows.length === 0) {
    throw new AccountingError(400, 'An examination batch without papers cannot be approved', 'NO_PAPERS');
  }
  const spec = papers.rows.map(p => ({
    subjectName: p.subject_name,
    pages: Number(p.pages),
    copies: Number(p.copies),
    teacherCopies: p.teacher_copies != null ? Number(p.teacher_copies) : 2,
    plannedProductionQuantity: p.planned_production_quantity != null ? Number(p.planned_production_quantity) : Number(p.copies) + 2,
    billableQuantity: p.billable_quantity != null ? Number(p.billable_quantity) : Number(p.copies),
    paperSize: p.paper_size,
    printSide: p.print_side,
    bindingType: p.binding_type,
    rawPaperItemId: Number(p.raw_paper_item_id),
    rawTonerItemId: Number(p.raw_toner_item_id),
    printingItemId: p.printing_item_id != null ? Number(p.printing_item_id) : null,
  }));
  const specHash = crypto.createHash('sha256').update(stableStringify(spec)).digest('hex');
  const nextVersion = Number(row.spec_version) + 1;

  await tx.query(
    `UPDATE exam_assessment_batches
        SET spec_frozen = TRUE, spec_version = $3, spec_hash = $4,
            spec_approved_at = NOW(), spec_approved_by = $5
      WHERE company_id = $1 AND id = $2`,
    [companyId, batchId, nextVersion, specHash, actor.userId]
  );

  for (const p of papers.rows) {
    await insertExamPaperEvent(tx, {
      companyId,
      batchId,
      paperId: Number(p.id),
      eventType: 'spec_approved',
      fromStatus: null,
      toStatus: null,
      actorUserId: actor.userId,
      reason: input.notes ?? 'Production specification approved and frozen',
      metadata: { specHash, specVersion: nextVersion },
    });
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'EXAM_SPEC_APPROVED',
    tableName: 'exam_assessment_batches',
    recordId: batchId,
    newValues: { specHash, specVersion: nextVersion, notes: input.notes ?? null },
  });

  return { batchId, specFrozen: true, specVersion: nextVersion, specHash, idempotentReplay: false };
}

/**
 * Examination reconciliation over authoritative records only. Every check is
 * read-only and reports the exact figure so a discrepancy is never hidden.
 */
export async function getExaminationReconciliation(tx: Transaction, companyId: number) {
  const scalar = async (sql: string, params: unknown[] = [companyId]) => {
    const r = await tx.query<{ value: string }>(sql, params);
    return toNum(r.rows[0]?.value ?? 0);
  };

  const invoicedWithoutDelivery = await scalar(
    `SELECT COUNT(*)::text AS value FROM exam_papers
      WHERE company_id = $1 AND status = 'invoiced' AND delivered_at IS NULL`
  );
  const deliveredWithoutLink = await scalar(
    `SELECT COUNT(*)::text AS value
       FROM exam_papers p
       LEFT JOIN exam_paper_invoice_links l
         ON l.company_id = p.company_id AND l.paper_id = p.id
      WHERE p.company_id = $1 AND p.status = 'delivered' AND l.id IS NULL`
  );
  const duplicateLinks = await scalar(
    `SELECT COUNT(*)::text AS value FROM (
       SELECT paper_id FROM exam_paper_invoice_links
        WHERE company_id = $1 GROUP BY paper_id HAVING COUNT(*) > 1
     ) x`
  );
  const unverifiedCosts = await scalar(
    `SELECT COUNT(*)::text AS value FROM exam_papers
      WHERE company_id = $1 AND cost_status IN ('legacy_unverified', 'unavailable')`
  );
  const overConsumed = await scalar(
    `SELECT COUNT(*)::text AS value FROM job_material_requirements
      WHERE company_id = $1
        AND (actual_good_usage_qty + waste_usage_qty + returned_usage_qty) > issued_usage_qty`
  );
  const negativeStock = await scalar(
    `SELECT COUNT(*)::text AS value FROM inventory_items
      WHERE company_id = $1 AND item_type = 'raw_material' AND (on_hand < 0 OR reserved_qty < 0)`
  );
  const wipRow = await tx.query<{ accumulated: string; relieved: string }>(
    `SELECT COALESCE(SUM(wip_cost_accumulated), 0)::text AS accumulated,
            COALESCE(SUM(wip_cost_relieved), 0)::text AS relieved
       FROM printing_jobs
      WHERE company_id = $1 AND job_type = 'exam_paper'`,
    [companyId]
  );
  const wipAccumulated4 = parseDecimal4(wipRow.rows[0]?.accumulated ?? 0);
  const wipRelieved4 = parseDecimal4(wipRow.rows[0]?.relieved ?? 0);
  const negativeWip = wipRelieved4 > wipAccumulated4;
  const batchCostMismatch = await scalar(
    `SELECT COUNT(*)::text AS value FROM exam_assessment_batches b
      WHERE b.company_id = $1
        AND (
          b.total_paper_cost <> COALESCE((SELECT SUM(p.paper_cost) FROM exam_papers p
             WHERE p.company_id = b.company_id AND p.batch_id = b.id), 0)
          OR b.total_toner_cost <> COALESCE((SELECT SUM(p.toner_cost) FROM exam_papers p
             WHERE p.company_id = b.company_id AND p.batch_id = b.id), 0)
        )`
  );
  const frozenSpecs = await scalar(
    `SELECT COUNT(*)::text AS value FROM exam_assessment_batches
      WHERE company_id = $1 AND spec_frozen = TRUE`
  );
  const activeBatches = await scalar(
    `SELECT COUNT(*)::text AS value FROM exam_assessment_batches WHERE company_id = $1`
  );

  const checks = [
    {
      key: 'invoiced_without_delivery',
      label: 'Invoiced papers without a delivery timestamp',
      value: invoicedWithoutDelivery,
      expected: 0,
      status: invoicedWithoutDelivery === 0 ? 'ok' : 'critical',
    },
    {
      key: 'delivered_without_invoice_link',
      label: 'Delivered papers with no invoice link',
      value: deliveredWithoutLink,
      expected: 0,
      status: 'ok',
      informational: true,
    },
    {
      key: 'duplicate_invoice_links',
      label: 'Papers linked to more than one invoice',
      value: duplicateLinks,
      expected: 0,
      status: duplicateLinks === 0 ? 'ok' : 'critical',
    },
    {
      key: 'over_consumed_materials',
      label: 'Material requirements consuming more than issued',
      value: overConsumed,
      expected: 0,
      status: overConsumed === 0 ? 'ok' : 'critical',
    },
    {
      key: 'negative_raw_material_stock',
      label: 'Raw material items with negative on-hand or reserved quantity',
      value: negativeStock,
      expected: 0,
      status: negativeStock === 0 ? 'ok' : 'critical',
    },
    {
      key: 'negative_exam_wip',
      label: 'Examination WIP relieved above accumulated cost',
      value: negativeWip ? 1 : 0,
      expected: 0,
      status: negativeWip ? 'critical' : 'ok',
      detail: {
        wipAccumulated: toMoneyNumber(wipAccumulated4),
        wipRelieved: toMoneyNumber(wipRelieved4),
      },
    },
    {
      key: 'batch_cost_mismatch',
      label: 'Batch cost totals not equal to their paper costs',
      value: batchCostMismatch,
      expected: 0,
      status: batchCostMismatch === 0 ? 'ok' : 'attention',
    },
    {
      key: 'unverified_production_costs',
      label: 'Papers with unavailable or legacy-unverified production cost',
      value: unverifiedCosts,
      expected: 0,
      status: unverifiedCosts === 0 ? 'ok' : 'attention',
      informational: true,
    },
    {
      key: 'frozen_spec_coverage',
      label: 'Batches with a frozen approved production specification',
      value: frozenSpecs,
      expected: activeBatches,
      status: activeBatches > 0 && frozenSpecs < activeBatches ? 'attention' : 'ok',
      informational: true,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    checks,
    criticalCount: checks.filter(c => c.status === 'critical').length,
    attentionCount: checks.filter(c => c.status === 'attention').length,
  };
}

export async function deliverExamPaper(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  paperId: number,
  input: {
    dispatchDate?: string | null;
    recipientName?: string | null;
    driverName?: string | null;
    vehicleReg?: string | null;
    notes?: string | null;
  } = {}
) {
  const res = await tx.query<{
    id: number;
    batch_id: number;
    job_number: string;
    status: string;
    copies: number;
    good_copies: number;
    production_job_id: number | null;
    delivery_note_id: number | null;
    school_customer_id: number;
    assessment_name: string;
    class_name: string;
    subject_name: string;
  }>(
    `SELECT p.id, p.batch_id, p.job_number, p.status, p.copies, p.good_copies, p.production_job_id,
            p.delivery_note_id, b.school_customer_id, b.assessment_name, b.class_name, p.subject_name
       FROM exam_papers p
       JOIN exam_assessment_batches b
         ON b.company_id = p.company_id AND b.id = p.batch_id
      WHERE p.company_id = $1 AND p.id = $2
      FOR UPDATE OF p`,
    [companyId, paperId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Examination paper not found in active company', 'EXAM_PAPER_NOT_FOUND');
  }
  const paper = res.rows[0];
  if (paper.delivery_note_id != null || paper.status === 'delivered' || paper.status === 'invoiced') {
    throw new AccountingError(409, 'Examination paper has already been delivered', 'EXAM_PAPER_ALREADY_DELIVERED');
  }
  if (!['completed', 'qc_passed', 'packed', 'dispatched'].includes(paper.status)) {
    throw new AccountingError(
      409,
      `Examination paper must be completed and QC-approved before delivery (current: ${paper.status})`,
      'EXAM_PAPER_NOT_READY_FOR_DELIVERY'
    );
  }
  if (!paper.production_job_id) {
    throw new AccountingError(409, 'Examination paper has no linked production job to dispatch', 'EXAM_PRODUCTION_JOB_MISSING');
  }

  const dispatchDate = input.dispatchDate
    ? assertIsoDate(input.dispatchDate, 'dispatchDate')
    : new Date().toISOString().slice(0, 10);
  // Deliver only good (QC-approved) copies. A short delivery is legitimate and
  // must never claim the spoiled quantity was dispatched.
  const deliverQty =
    Number(paper.good_copies) > 0 ? Number(paper.good_copies) : Number(paper.copies);
  const note = await createDeliveryNote(tx, companyId, actor, {
    customerId: Number(paper.school_customer_id),
    dispatchDate,
    recipientName: input.recipientName ?? null,
    driverName: input.driverName ?? null,
    vehicleReg: input.vehicleReg ?? null,
    notes: input.notes ?? null,
    lines: [
      {
        printingJobId: Number(paper.production_job_id),
        quantityDispatched: deliverQty,
        description: `${paper.job_number} — ${paper.class_name} ${paper.subject_name}`,
      },
    ],
  });
  const deliveryNoteId = Number(note.deliveryNote.id);

  await tx.query(
    `UPDATE exam_papers
        SET status = 'delivered', delivered_at = NOW(),
            delivery_note_id = $3, good_copies = $4
      WHERE company_id = $1 AND id = $2`,
    [companyId, paperId, deliveryNoteId, deliverQty]
  );
  await insertExamPaperEvent(tx, {
    companyId,
    batchId: Number(paper.batch_id),
    paperId,
    eventType: 'delivered',
    fromStatus: paper.status,
    toStatus: 'delivered',
    actorUserId: actor.userId,
    reason: input.notes ?? null,
    quantityDelta: deliverQty,
    metadata: { deliveryNoteId, deliveryNumber: note.deliveryNote.deliveryNumber, shortDelivery: deliverQty < Number(paper.copies) },
  });
  await tx.query(
    `UPDATE exam_assessment_batches b
        SET status = 'delivered'
      WHERE b.company_id = $1 AND b.id = $2
        AND b.status IN ('scheduled', 'in_production')
        AND NOT EXISTS (
          SELECT 1 FROM exam_papers p
           WHERE p.company_id = b.company_id AND p.batch_id = b.id
             AND p.status NOT IN ('delivered', 'invoiced')
        )`,
    [companyId, Number(paper.batch_id)]
  );

  return { paperId, status: 'delivered', deliveryNote: note.deliveryNote };
}

/**
 * Link one or more delivered examination papers to an existing invoice and
 * relieve their accumulated WIP to COGS exactly once. The invoice itself is
 * created by the shared sales service; this function only adds the exam-specific
 * linkage and the WIP→COGS journal that item-less invoice lines cannot post.
 */
export async function linkExamPapersToInvoice(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  params: {
    invoiceId: number;
    customerId: number;
    paperIds: number[];
  }
): Promise<{
  invoiceId: number;
  linkedPaperIds: number[];
  wipRelieved: number;
  cogsJournalId: number | null;
}> {
  const ids = Array.from(new Set(params.paperIds.map(Number).filter(n => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) {
    throw new AccountingError(400, 'At least one examination paper id is required for invoice linking', 'NO_EXAM_PAPERS');
  }
  // Segregation of duties: exam invoicing requires the dedicated exams:invoice
  // permission, not just the generic invoices:write gate on the route.
  if (!hasPermission(actor.role, 'exams:invoice')) {
    throw new AccountingError(403, 'Invoicing examination papers requires the exams:invoice permission', 'EXAMS_INVOICE_PERMISSION_REQUIRED');
  }
  const invRes = await tx.query<{ id: number; invoice_number: string; customer_id: number; total_cost: string }>(
    `SELECT id, invoice_number, customer_id, total_cost::text
       FROM invoices WHERE company_id = $1 AND id = $2 FOR UPDATE`,
    [companyId, params.invoiceId]
  );
  if (invRes.rows.length === 0) {
    throw new AccountingError(404, 'Invoice not found in active company', 'INVOICE_NOT_FOUND');
  }
  const invoice = invRes.rows[0];
  if (Number(invoice.customer_id) !== Number(params.customerId)) {
    throw new AccountingError(400, 'Invoice customer does not match the examination school', 'INVOICE_CUSTOMER_MISMATCH');
  }

  const papersRes = await tx.query<{
    id: number;
    batch_id: number;
    status: string;
    invoice_id: number | null;
    copies: number;
    billable_quantity: number | null;
    production_job_id: number | null;
    school_customer_id: number;
    learners_count: number;
    price_per_learner: string;
    subject_count: string;
    wip_accumulated: string | null;
    wip_relieved: string | null;
  }>(
    `SELECT p.id, p.batch_id, p.status, p.invoice_id, p.copies,
            COALESCE(p.billable_quantity, p.copies) AS billable_quantity,
            p.production_job_id,
            b.school_customer_id, b.learners_count, b.price_per_learner::text,
            (SELECT COUNT(*)::text FROM exam_papers x
              WHERE x.company_id = p.company_id AND x.batch_id = p.batch_id) AS subject_count,
            j.wip_cost_accumulated::text AS wip_accumulated,
            j.wip_cost_relieved::text AS wip_relieved
       FROM exam_papers p
       JOIN exam_assessment_batches b
         ON b.company_id = p.company_id AND b.id = p.batch_id
       LEFT JOIN printing_jobs j
         ON j.company_id = p.company_id AND j.id = p.production_job_id
      WHERE p.company_id = $1 AND p.id = ANY($2::BIGINT[])
      ORDER BY p.id ASC
      FOR UPDATE OF p`,
    [companyId, ids]
  );
  if (papersRes.rows.length !== ids.length) {
    throw new AccountingError(404, 'One or more examination papers were not found in the active company', 'EXAM_PAPER_NOT_FOUND');
  }

  let relief4 = 0n;
  const allocations: Array<{
    paperId: number;
    batchId: number;
    productionJobId: number;
    quantity: string;
    amount: string;
  }> = [];
  for (const p of papersRes.rows) {
    if (Number(p.school_customer_id) !== Number(params.customerId)) {
      throw new AccountingError(400, 'All examination papers must belong to the invoice school', 'EXAM_SCHOOL_MISMATCH');
    }
    if (p.status !== 'delivered') {
      throw new AccountingError(
        409,
        `Examination paper ${p.id} must be delivered before invoicing (current: ${p.status})`,
        'EXAM_PAPER_NOT_DELIVERED'
      );
    }
    if (p.invoice_id != null) {
      throw new AccountingError(409, `Examination paper ${p.id} is already invoiced`, 'EXAM_PAPER_ALREADY_INVOICED');
    }
    if (!p.production_job_id) {
      throw new AccountingError(409, `Examination paper ${p.id} has no production job`, 'EXAM_PRODUCTION_JOB_MISSING');
    }
    const already = await tx.query<{ id: number }>(
      `SELECT id FROM exam_paper_invoice_links WHERE company_id = $1 AND paper_id = $2`,
      [companyId, p.id]
    );
    if (already.rows.length > 0) {
      throw new AccountingError(409, `Examination paper ${p.id} already has an invoice link`, 'EXAM_PAPER_ALREADY_INVOICED');
    }

    const accumulated4 = parseDecimal4(p.wip_accumulated ?? 0);
    const relieved4 = parseDecimal4(p.wip_relieved ?? 0);
    const paperRelief4 = accumulated4 - relieved4;
    if (paperRelief4 <= 0n) {
      throw new AccountingError(
        409,
        `Examination paper ${p.id} has no accumulated production cost to relieve to COGS`,
        'EXAM_PAPER_HAS_NO_WIP'
      );
    }
    relief4 += paperRelief4;

    const classRevenue4 = parseDecimal4(
      Number(p.learners_count) * Number(p.price_per_learner)
    );
    const subjectCount = Math.max(1, Number(p.subject_count));
    const allocation4 = divRoundBigInt(classRevenue4, BigInt(subjectCount), 'HALF_EVEN');
    const billableQty = Number(p.billable_quantity ?? p.copies);
    allocations.push({
      paperId: Number(p.id),
      batchId: Number(p.batch_id),
      productionJobId: Number(p.production_job_id),
      quantity: formatDecimal4(parseDecimal4(billableQty)),
      amount: formatDecimal4(allocation4),
    });
  }

  let cogsJournalId: number | null = null;
  if (relief4 > 0n) {
    const ctx = await resolveWorkflowAccounts(tx, companyId, actor);
    const posted = await postJournalEntry(tx, companyId, actor, {
      txnDate: new Date().toISOString().slice(0, 10),
      description: `Examination WIP relief to COGS — Invoice ${invoice.invoice_number}`,
      reference: invoice.invoice_number,
      sourceType: 'exam_production',
      sourceId: params.invoiceId,
      idempotencyKey: `exam-cogs-${companyId}-${params.invoiceId}`,
      lines: [
        {
          accountId: ctx.cogs5000,
          debit: formatDecimal4(relief4),
          credit: '0.0000',
          description: `Examination production COGS — ${invoice.invoice_number}`,
        },
        {
          accountId: ctx.wip1250,
          debit: '0.0000',
          credit: formatDecimal4(relief4),
          description: `Relieve examination WIP — ${invoice.invoice_number}`,
        },
      ],
    });
    cogsJournalId = posted.transaction.id;
  }

  // Exam invoice lines intentionally carry no inventory cost (WIP already
  // consumed the materials). Replace any client-supplied item-less line cost
  // with the exact WIP relief so gross profit and total_cost are not doubled.
  const lineCostRes = await tx.query<{ cost: string }>(
    `SELECT COALESCE(SUM(total_cost), 0)::text AS cost
       FROM invoice_lines
      WHERE company_id = $1 AND invoice_id = $2 AND item_id IS NULL`,
    [companyId, params.invoiceId]
  );
  const lineCost4 = parseDecimal4(lineCostRes.rows[0]?.cost ?? 0);
  const nextInvoiceCost4 = parseDecimal4(invoice.total_cost) - lineCost4 + relief4;
  await tx.query(
    `UPDATE invoices SET total_cost = $3::NUMERIC(19,4) WHERE company_id = $1 AND id = $2`,
    [companyId, params.invoiceId, formatDecimal4(nextInvoiceCost4 > 0n ? nextInvoiceCost4 : 0n)]
  );

  const linkedPaperIds: number[] = [];
  for (const allocation of allocations) {
    const ins = await tx.query<{ id: number }>(
      `INSERT INTO exam_paper_invoice_links (
         company_id, paper_id, batch_id, invoice_id, customer_id,
         linked_quantity, linked_amount, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6::NUMERIC(19,4), $7::NUMERIC(19,4), $8)
       ON CONFLICT (company_id, paper_id) DO NOTHING
       RETURNING id`,
      [
        companyId,
        allocation.paperId,
        allocation.batchId,
        params.invoiceId,
        params.customerId,
        allocation.quantity,
        allocation.amount,
        actor.userId,
      ]
    );
    if (ins.rows.length === 0) {
      throw new AccountingError(409, `Examination paper ${allocation.paperId} was invoiced concurrently`, 'EXAM_PAPER_ALREADY_INVOICED');
    }
    await tx.query(
      `UPDATE printing_jobs
          SET invoice_id = $3,
              invoiced_qty = ordered_qty,
              wip_cost_relieved = wip_cost_accumulated,
              cogs_journal_txn_id = COALESCE(cogs_journal_txn_id, $4),
              status = 'completed'
        WHERE company_id = $1 AND id = $2`,
      [companyId, allocation.productionJobId, params.invoiceId, cogsJournalId]
    );
    await tx.query(
      `UPDATE exam_papers
          SET status = 'invoiced', invoice_id = $3
        WHERE company_id = $1 AND id = $2`,
      [companyId, allocation.paperId, params.invoiceId]
    );
    await insertExamPaperEvent(tx, {
      companyId,
      batchId: allocation.batchId,
      paperId: allocation.paperId,
      eventType: 'invoiced',
      fromStatus: 'delivered',
      toStatus: 'invoiced',
      actorUserId: actor.userId,
      invoiceId: params.invoiceId,
      journalTxnId: cogsJournalId,
      metadata: {
        invoiceNumber: invoice.invoice_number,
        linkedQuantity: allocation.quantity,
        linkedAmount: allocation.amount,
      },
    });
    linkedPaperIds.push(allocation.paperId);
  }

  const batchIds = Array.from(new Set(allocations.map(a => a.batchId)));
  if (batchIds.length > 0) {
    await tx.query(
      `UPDATE exam_assessment_batches b
          SET invoice_id = COALESCE(b.invoice_id, $3),
              status = CASE
                WHEN NOT EXISTS (
                  SELECT 1 FROM exam_papers p
                   WHERE p.company_id = b.company_id AND p.batch_id = b.id
                     AND p.status <> 'invoiced'
                ) THEN 'invoiced'
                ELSE b.status
              END
        WHERE b.company_id = $1 AND b.id = ANY($2::BIGINT[])`,
      [companyId, batchIds, params.invoiceId]
    );
  }

  return {
    invoiceId: params.invoiceId,
    linkedPaperIds,
    wipRelieved: toNum(formatDecimal4(relief4)),
    cogsJournalId,
  };
}

export async function deleteExamPaper(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  paperId: number
) {
  const res = await tx.query<{ id: number; job_number: string; status: string; production_job_id: number | null }>(
    `SELECT id, job_number, status, production_job_id FROM exam_papers
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, paperId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Examination paper not found in active company', 'EXAM_PAPER_NOT_FOUND');
  }
  const paper = res.rows[0];
  if (['invoiced', 'completed', 'delivered', 'cancelled'].includes(paper.status)) {
    throw new AccountingError(
      400,
      `${paper.status} examination papers cannot be removed; use a controlled cancellation/reversal`,
      'EXAM_PAPER_IMMUTABLE'
    );
  }

  // A linked production job holds material reservations/requirements. Remove
  // only when no material has been issued; otherwise force the controlled path.
  if (paper.production_job_id) {
    const issued = await tx.query<{ issued: string }>(
      `SELECT COALESCE(SUM(issued_usage_qty), 0)::text AS issued
         FROM job_material_requirements
        WHERE company_id = $1 AND printing_job_id = $2`,
      [companyId, paper.production_job_id]
    );
    if (Number(issued.rows[0]?.issued || 0) > 0) {
      throw new AccountingError(
        409,
        'Cannot delete an examination paper after materials have been issued',
        'EXAM_PAPER_MATERIALS_ISSUED'
      );
    }
  }

  await tx.query(`DELETE FROM exam_papers WHERE company_id = $1 AND id = $2`, [companyId, paperId]);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'EXAM_PAPER_DELETED',
    tableName: 'exam_papers',
    recordId: paperId,
    oldValues: { jobNumber: paper.job_number, status: paper.status },
  });

  return { deleted: true, paperId, jobNumber: paper.job_number };
}

