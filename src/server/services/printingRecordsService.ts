import crypto from 'node:crypto';
import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, type ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { writeAuditLog } from '../audit.ts';
import {
  allocateWalletFunds,
  getOrCreateWallet,
  refundWallet,
  releaseWalletAllocation,
} from './customerWalletService.ts';

/**
 * Server-owned printing production records: prepaid school retainers and
 * examination print batches.
 *
 * Both used to live only in the browser cache. The contract deposit is a real
 * balance-sheet movement (cash in, unearned revenue), so it is posted here.
 */

function assertIsoDate(value: unknown, field: string): string {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AccountingError(400, `${field} must be YYYY-MM-DD`, 'INVALID_DATE');
  }
  return raw;
}

async function resolveLiabilityAccount(tx: Transaction, companyId: number): Promise<number> {
  const byCode = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = TRUE AND code = ANY($2::TEXT[])
      ORDER BY array_position($2::TEXT[], code)
      LIMIT 1`,
    [companyId, ['2250', '2200', '2100', '2300']]
  );
  if (byCode.rows.length > 0) return Number(byCode.rows[0].id);

  const byType = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = TRUE
        AND account_type IN ('OtherCurrentLiability', 'LongTermLiability', 'PayrollLiability')
      ORDER BY id LIMIT 1`,
    [companyId]
  );
  if (byType.rows.length > 0) return Number(byType.rows[0].id);

  throw new AccountingError(
    400,
    'No unearned-revenue liability account is configured for this company',
    'NO_CONTRACT_LIABILITY_ACCOUNT'
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
  activate?: boolean;
  renewalOfContractId?: number | null;
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

  const liabilityAccountId = await resolveLiabilityAccount(tx, companyId);

  const yearRes = await tx.query<{ year: number }>(
    `SELECT EXTRACT(YEAR FROM CURRENT_DATE)::INT AS year`
  );
  const year = Number(yearRes.rows[0]?.year || new Date().getFullYear());

  const numRes = await tx.query<{ n: string }>(
    `SELECT COALESCE(MAX(contract_number), '') AS n FROM printing_contracts WHERE company_id = $1`,
    [companyId]
  );
  const seq = Number(numRes.rows[0].n.split('-').pop() || 0) + 1;
  const contractNumber = `CTR-${year}-${String(seq).padStart(2, '0')}`;

  const activate = input.activate === true;
  let posted: Awaited<ReturnType<typeof postJournalEntry>> | null = null;

  if (activate) {
    posted = await postJournalEntry(tx, companyId, actor, {
      txnDate: startDate,
      description: `Prepaid printing retainer — ${title}`,
      memo: `Contract ${contractNumber} for ${totalAssessments} assessment(s)`,
      reference: contractNumber,
      sourceType: 'printing_contract',
      sourceId: null,
      lines: [
        {
          accountId: depositBankAccountId,
          debit: formatDecimal4(totalPrepaid),
          description: 'Retainer deposit received',
        },
        {
          accountId: liabilityAccountId,
          credit: formatDecimal4(totalPrepaid),
          description: 'Unearned printing contract revenue',
        },
      ],
    });
  }

  const contractIns = await tx.query<{ id: number }>(
    `INSERT INTO printing_contracts (
       company_id, contract_number, school_customer_id, title, academic_year,
       start_date, end_date, total_prepaid_amount, total_assessments,
       remaining_balance, completed_assessments, deposit_bank_account_id,
       liability_account_id, deposit_journal_txn_id, status, notes,
       renewal_of_contract_id, activated_at, activated_by
     ) VALUES ($1, $2, $3, $4, $5, $6::DATE, $7::DATE, $8::NUMERIC(19,4), $9,
               $8::NUMERIC(19,4), 0, $10, $11, $12, $13::VARCHAR(20), $14, $15,
               CASE WHEN $13::VARCHAR(20) = 'active' THEN NOW() ELSE NULL END,
               CASE WHEN $13::VARCHAR(20) = 'active' THEN $16::BIGINT ELSE NULL END)
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
      posted ? posted.transaction.id : null,
      activate ? 'active' : 'draft',
      input.notes ?? null,
      input.renewalOfContractId ?? null,
      actor.userId,
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
        assertIsoDate(a.scheduledDate, startDate),
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
      status: activate ? 'active' : 'draft',
      journalTransactionId: posted ? posted.transaction.id : null,
    },
  });

  return {
    contractId,
    contractNumber,
    liabilityAccountId,
    status: activate ? 'active' : 'draft',
    depositJournalTransactionId: posted ? posted.transaction.id : null,
    entryNumber: posted ? posted.transaction.entryNumber : null,
    remainingBalance: formatDecimal4(totalPrepaid),
  };
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

  const sumRes = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(agreed_amount), 0)::text AS total
       FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2`,
    [companyId, contractId]
  );
  const allocated = parseDecimal4(sumRes.rows[0]?.total || '0');
  const totalPrepaid = parseDecimal4(row.total_prepaid_amount);
  if (allocated !== totalPrepaid) {
    throw new AccountingError(
      400,
      `Assessment allocation (${formatDecimal4(allocated)}) must equal the prepaid amount (${formatDecimal4(totalPrepaid)}) before activation`,
      'ASSESSMENT_SUM_MISMATCH'
    );
  }

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

  const wallet = await getOrCreateWallet(tx, companyId, Number(row.school_customer_id));
  const allocation = await allocateWalletFunds(tx, companyId, actor, {
    customerId: Number(row.school_customer_id),
    walletId: wallet.walletId,
    contractId,
    amount: formatDecimal4(totalPrepaid),
    idempotencyKey: `contract-activate-${contractId}`,
    allowDraft: true,
    increaseContractTotals: false,
    notes: 'Contract activation allocation',
  });

  await tx.query(
    `UPDATE printing_contracts
        SET status = 'active',
            activated_at = NOW(),
            activated_by = $3,
            deposit_journal_txn_id = $4,
            customer_acceptance_id = $5
      WHERE company_id = $1 AND id = $2`,
    [
      companyId,
      contractId,
      actor.userId,
      allocation.walletTransaction.journalTxnId,
      Number(acceptance.rows[0].id),
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
      allocationId: allocation.allocationId,
      walletTransactionId: allocation.walletTransaction.id,
      journalTransactionId: allocation.walletTransaction.journalTxnId,
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

export interface ExamPaperInput {
  subjectName: string;
  pages: number;
  copies: number;
  rawPaperItemId: number;
  rawTonerItemId: number;
  printSide?: string;
  bindingType?: string;
  sheetsUsed?: string | number | null;
  impressionsUsed?: string | number | null;
  paperCost?: string | number | null;
  tonerCost?: string | number | null;
  productionDate?: string | null;
  notes?: string | null;
}

export interface CreateExamBatchInput {
  schoolCustomerId: number;
  assessmentName: string;
  className: string;
  learnersCount: number;
  pricePerLearner: string | number;
  contractId?: number | null;
  assessmentNumber?: number | null;
  papers: ExamPaperInput[];
}

export async function createExamBatch(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: CreateExamBatchInput
) {
  const schoolCustomerId = Number(input.schoolCustomerId);
  if (!Number.isInteger(schoolCustomerId) || schoolCustomerId <= 0) {
    throw new AccountingError(400, 'A school customer is required', 'INVALID_CUSTOMER');
  }
  const assessmentName = String(input.assessmentName || '').trim();
  const className = String(input.className || '').trim();
  if (!assessmentName || !className) {
    throw new AccountingError(400, 'assessmentName and className are required', 'MISSING_BATCH_FIELDS');
  }
  const learnersCount = Number(input.learnersCount);
  if (!Number.isInteger(learnersCount) || learnersCount <= 0) {
    throw new AccountingError(400, 'learnersCount must be a positive integer', 'INVALID_LEARNER_COUNT');
  }

  const custCheck = await tx.query<{ id: number }>(
    `SELECT id FROM customers WHERE company_id = $1 AND id = $2`,
    [companyId, schoolCustomerId]
  );
  if (custCheck.rows.length === 0) {
    throw new AccountingError(404, 'School customer not found in active company', 'CUSTOMER_NOT_FOUND');
  }

  const papers = Array.isArray(input.papers) ? input.papers : [];
  if (papers.length === 0) {
    throw new AccountingError(400, 'At least one examination paper is required', 'NO_PAPERS');
  }

  const batchIns = await tx.query<{ id: number }>(
    `INSERT INTO exam_assessment_batches (
       company_id, school_customer_id, assessment_name, class_name, learners_count,
       price_per_learner, contract_id, assessment_number
     ) VALUES ($1, $2, $3, $4, $5, $6::NUMERIC(19,4), $7, $8)
     RETURNING id`,
    [
      companyId,
      schoolCustomerId,
      assessmentName,
      className,
      learnersCount,
      formatDecimal4(parseDecimal4(input.pricePerLearner ?? 0)),
      input.contractId ? Number(input.contractId) : null,
      input.assessmentNumber ? Number(input.assessmentNumber) : null,
    ]
  );
  const batchId = Number(batchIns.rows[0].id);

  const numRes = await tx.query<{ n: string }>(
    `SELECT COALESCE(MAX(job_number), '') AS n FROM exam_papers WHERE company_id = $1`,
    [companyId]
  );
  const seq = Number(numRes.rows[0].n.split('-').pop() || 0) + 1;
  const year = new Date().getUTCFullYear();

  const created: Array<{ id: number; jobNumber: string; subjectName: string }> = [];
  for (let i = 0; i < papers.length; i++) {
    const p = papers[i];
    const subjectName = String(p.subjectName || '').trim();
    if (!subjectName) {
      throw new AccountingError(400, 'subjectName is required for every examination paper', 'MISSING_SUBJECT');
    }
    const pages = Number(p.pages);
    const copies = Number(p.copies);
    if (!Number.isInteger(pages) || pages <= 0 || !Number.isInteger(copies) || copies <= 0) {
      throw new AccountingError(400, 'pages and copies must be positive integers', 'INVALID_PAPER_QUANTITY');
    }
    const jobNumber = `EXM-${year}-${String(seq + i).padStart(4, '0')}`;
    const printSide = p.printSide === 'Single-Sided' ? 'Single-Sided' : 'Duplex';
    const bindingType = ['Stapled', 'Saddle-Stitched', 'Loose Leaf', 'Booklet'].includes(String(p.bindingType))
      ? String(p.bindingType)
      : 'Stapled';
    const productionDate = assertIsoDate(p.productionDate, new Date().toISOString().slice(0, 10));

    const ins = await tx.query<{ id: number }>(
      `INSERT INTO exam_papers (
         company_id, batch_id, job_number, subject_name, pages, copies,
         raw_paper_item_id, raw_toner_item_id, print_side, binding_type,
         sheets_used, impressions_used, paper_cost, toner_cost, status, production_date, notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11::NUMERIC(19,6), $12::NUMERIC(19,6), $13::NUMERIC(19,4), $14::NUMERIC(19,4),
                 'queued', $15::DATE, $16)
       RETURNING id`,
      [
        companyId,
        batchId,
        jobNumber,
        subjectName,
        pages,
        copies,
        Number(p.rawPaperItemId),
        Number(p.rawTonerItemId),
        printSide,
        bindingType,
        formatDecimal4(parseDecimal4(p.sheetsUsed ?? 0)),
        formatDecimal4(parseDecimal4(p.impressionsUsed ?? 0)),
        formatDecimal4(parseDecimal4(p.paperCost ?? 0)),
        formatDecimal4(parseDecimal4(p.tonerCost ?? 0)),
        productionDate,
        p.notes ?? null,
      ]
    );
    created.push({ id: Number(ins.rows[0].id), jobNumber, subjectName });
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'EXAM_BATCH_CREATED',
    tableName: 'exam_assessment_batches',
    recordId: batchId,
    newValues: {
      assessmentName,
      className,
      learnersCount,
      paperCount: created.length,
      jobNumbers: created.map(c => c.jobNumber),
    },
  });

  return { batchId, assessmentName, className, learnersCount, papers: created };
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
            total_prepaid_amount, total_assessments, remaining_balance,
            completed_assessments, deposit_bank_account_id, liability_account_id,
            status, notes
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
            exam_batch_note
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
    journalTxnId: m.journal_txn_id != null ? Number(m.journal_txn_id) : undefined,
  };
}

async function hydrateContract(tx: Transaction, companyId: number, row: ContractRow) {
  const milestones = await loadMilestones(tx, companyId, row.id);
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
    assessments: milestones.map(serializeMilestone),
  };
}

export async function listPrintingContracts(tx: Transaction, companyId: number) {
  const res = await tx.query<ContractRow>(
    `SELECT id, contract_number, school_customer_id, title, academic_year,
            start_date::text AS start_date, end_date::text AS end_date,
            total_prepaid_amount::text AS total_prepaid_amount, total_assessments,
            remaining_balance::text AS remaining_balance, completed_assessments,
            deposit_bank_account_id, liability_account_id, status, notes,
            activated_at, activated_by, completed_at, completed_by,
            suspended_at, suspended_by, suspension_reason,
            resumed_at, resumed_by, renewal_of_contract_id, customer_acceptance_id
       FROM printing_contracts
      WHERE company_id = $1
      ORDER BY id DESC`,
    [companyId]
  );
  const out = [];
  for (const row of res.rows) {
    out.push(await hydrateContract(tx, companyId, row));
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
  if (['cancelled', 'completed', 'exhausted'].includes(row.status)) {
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
    totalPrepaidAmount?: string | number;
    assessments?: ContractAssessmentInput[];
  }
) {
  const row = await loadContract(tx, companyId, contractId);
  const milestones = await loadMilestones(tx, companyId, contractId);

  const startDate = input?.startDate ?? row.start_date;
  const endDate = input?.endDate ?? row.end_date;
  if (endDate < startDate) {
    throw new AccountingError(400, 'endDate cannot be earlier than startDate', 'INVALID_DATE_RANGE');
  }

  return createPrintingContract(tx, companyId, actor, {
    schoolCustomerId: row.school_customer_id,
    title: input?.title ?? row.title,
    academicYear: input?.academicYear ?? row.academic_year,
    startDate,
    endDate,
    totalPrepaidAmount: input?.totalPrepaidAmount ?? row.total_prepaid_amount,
    totalAssessments: input?.assessments?.length ?? row.total_assessments,
    depositBankAccountId: row.deposit_bank_account_id,
    notes: row.notes,
    renewalOfContractId: contractId,
    assessments: input?.assessments ?? milestones.map(m => ({
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
    })),
  });
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
  const sumRes = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(agreed_amount), 0)::text AS total
       FROM contract_assessment_milestones
      WHERE company_id = $1 AND contract_id = $2`,
    [companyId, contractId]
  );
  if (parseDecimal4(sumRes.rows[0].total) + newAgreed > parseDecimal4(row.total_prepaid_amount)) {
    throw new AccountingError(
      400,
      'Assessment allocation exceeds the prepaid amount',
      'ASSESSMENT_SUM_MISMATCH'
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
      assertIsoDate(input.scheduledDate, row.start_date),
      formatDecimal4(parseDecimal4(input.agreedAmount ?? 0)),
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

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'CONTRACT_ASSESSMENT_ADDED',
    tableName: 'contract_assessment_milestones',
    recordId: contractId,
    newValues: { assessmentNumber, totalAssessments: row.total_assessments + 1 },
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
            exam_batch_note
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

async function resolveIncomeAccount(tx: Transaction, companyId: number): Promise<number> {
  const byCode = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = TRUE AND code = ANY($2::TEXT[])
      ORDER BY array_position($2::TEXT[], code)
      LIMIT 1`,
    [companyId, ['4000', '4010', '4900']]
  );
  if (byCode.rows.length > 0) return Number(byCode.rows[0].id);

  const byType = await tx.query<{ id: number }>(
    `SELECT id FROM accounts
      WHERE company_id = $1 AND is_active = TRUE AND account_type IN ('Income', 'OtherIncome')
      ORDER BY id LIMIT 1`,
    [companyId]
  );
  if (byType.rows.length > 0) return Number(byType.rows[0].id);

  throw new AccountingError(
    400,
    'No sales/income account is configured for this company',
    'NO_INCOME_ACCOUNT'
  );
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
            completed_at = CASE WHEN $3::VARCHAR(20) = 'completed' THEN NOW() ELSE completed_at END,
            completed_by = CASE WHEN $3::VARCHAR(20) = 'completed' THEN $6::BIGINT ELSE completed_by END
      WHERE company_id = $4 AND id = $5`,
    [formatDecimal4(nextRemaining), nextCompleted, allDone ? 'completed' : 'active', companyId, contractId, actor.userId]
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
    },
  });

  return getPrintingContract(tx, companyId, contractId);
}

export async function listContractWalletTransactions(tx: Transaction, companyId: number, contractNumber: string) {
  const res = await tx.query<{
    id: number;
    account_name: string;
    txn_date: string;
    payee: string;
    txn_type: string;
    ref_number: string | null;
    memo: string | null;
    amount: string;
    category: string | null;
  }>(
    `SELECT t.id, a.name AS account_name, t.txn_date::text AS txn_date, t.payee,
            t.txn_type, t.ref_number, t.memo, t.amount, t.category
       FROM bank_transactions t
       JOIN accounts a ON a.company_id = t.company_id AND a.id = t.account_id
      WHERE t.company_id = $1 AND t.ref_number = $2
      ORDER BY t.txn_date DESC, t.id DESC`,
    [companyId, contractNumber]
  );
  return res.rows.map(r => ({
    id: Number(r.id),
    accountName: r.account_name,
    date: r.txn_date,
    payee: r.payee,
    type: r.txn_type,
    refNumber: r.ref_number,
    memo: r.memo ?? undefined,
    amount: toNum(r.amount),
    category: r.category ?? undefined,
  }));
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
  paper_spec_id: number | null;
  raw_paper_item_id: number;
  raw_toner_item_id: number;
  print_side: string;
  binding_type: string;
  sheets_used: string;
  impressions_used: string;
  paper_cost: string;
  toner_cost: string;
  material_cost: string;
  status: string;
  production_date: string;
  invoice_id: number | null;
  notes: string | null;
};

const EXAM_PAPER_SELECT = `
  SELECT p.id, p.job_number,
         b.school_customer_id, b.contract_id, b.assessment_number,
         b.assessment_name, b.class_name, b.learners_count, b.price_per_learner,
         p.subject_name, p.pages, p.copies, p.paper_spec_id,
         p.raw_paper_item_id, p.raw_toner_item_id, p.print_side, p.binding_type,
         p.sheets_used, p.impressions_used, p.paper_cost, p.toner_cost, p.material_cost,
         p.status, p.production_date::text AS production_date, b.invoice_id, p.notes
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
    paperSize: 'A4',
    printSide: r.print_side,
    bindingType: r.binding_type,
    printingItemId: r.paper_spec_id != null ? String(r.paper_spec_id) : undefined,
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
    notes: r.notes ?? undefined,
  };
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

export async function updateExamPaperStatus(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  paperId: number,
  nextStatus: 'queued' | 'printing' | 'completed'
) {
  const res = await tx.query<{ id: number; job_number: string; status: string }>(
    `SELECT id, job_number, status FROM exam_papers
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, paperId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Examination paper not found in active company', 'EXAM_PAPER_NOT_FOUND');
  }
  const paper = res.rows[0];
  if (paper.status === 'invoiced') {
    throw new AccountingError(400, 'Invoiced examination papers cannot change status', 'EXAM_PAPER_INVOICED');
  }

  await tx.query(`UPDATE exam_papers SET status = $1 WHERE company_id = $2 AND id = $3`, [
    nextStatus,
    companyId,
    paperId,
  ]);

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'EXAM_PAPER_STATUS_UPDATED',
    tableName: 'exam_papers',
    recordId: paperId,
    oldValues: { status: paper.status },
    newValues: { status: nextStatus },
  });

  return { paperId, jobNumber: paper.job_number, status: nextStatus };
}

export async function deleteExamPaper(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  paperId: number
) {
  const res = await tx.query<{ id: number; job_number: string; status: string }>(
    `SELECT id, job_number, status FROM exam_papers
      WHERE company_id = $1 AND id = $2
      FOR UPDATE`,
    [companyId, paperId]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Examination paper not found in active company', 'EXAM_PAPER_NOT_FOUND');
  }
  const paper = res.rows[0];
  if (paper.status === 'invoiced') {
    throw new AccountingError(400, 'Invoiced examination papers cannot be removed', 'EXAM_PAPER_INVOICED');
  }
  if (paper.status === 'completed') {
    throw new AccountingError(400, 'Completed examination papers cannot be removed', 'EXAM_PAPER_COMPLETED');
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

