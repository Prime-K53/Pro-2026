import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, type ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { writeAuditLog } from '../audit.ts';

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

  const numRes = await tx.query<{ n: string }>(
    `SELECT COALESCE(MAX(contract_number), '') AS n FROM printing_contracts WHERE company_id = $1`,
    [companyId]
  );
  const seq = Number(numRes.rows[0].n.split('-').pop() || 0) + 1;
  const contractNumber = `CTR-${new Date().getUTCFullYear()}-${String(seq).padStart(2, '0')}`;

  const posted = await postJournalEntry(tx, companyId, actor, {
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

  const contractIns = await tx.query<{ id: number }>(
    `INSERT INTO printing_contracts (
       company_id, contract_number, school_customer_id, title, academic_year,
       start_date, end_date, total_prepaid_amount, total_assessments,
       remaining_balance, completed_assessments, deposit_bank_account_id,
       liability_account_id, deposit_journal_txn_id, status, notes
     ) VALUES ($1, $2, $3, $4, $5, $6::DATE, $7::DATE, $8::NUMERIC(19,4), $9,
               $8::NUMERIC(19,4), 0, $10, $11, $12, 'active', $13)
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
      posted.transaction.id,
      input.notes ?? null,
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
      journalTransactionId: posted.transaction.id,
    },
  });

  return {
    contractId,
    contractNumber,
    liabilityAccountId,
    depositJournalTransactionId: posted.transaction.id,
    entryNumber: posted.transaction.entryNumber,
    remainingBalance: formatDecimal4(totalPrepaid),
  };
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

