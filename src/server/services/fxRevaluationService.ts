import { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry } from './accountingEngine.ts';
import type { ActorContext } from './accountingEngine.ts';
import {
  convertForeign4ToBase4,
  formatDecimal6,
  resolveCommercialContext,
  resolveExchangeRate6,
} from './commercialHelpers.ts';
import { writeAuditLog } from '../audit.ts';
import { formatDecimal4, parseDecimal4, toMoneyNumber } from '../lib/decimal.ts';

/**
 * D-8: period-end revaluation of open foreign-currency AR. Each invoice is
 * revalued at the closing rate and the cumulative gain/loss already recognized
 * by earlier runs is deducted, so a second run at the same rate posts nothing.
 *
 * Currency of the subledger remains the transaction currency; only the base
 * carrying amount and the unrealized gain/loss accounts move.
 */

function assertIsoDate(value: string, field: string): string {
  const iso = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new AccountingError(400, `${field} must be YYYY-MM-DD`, 'INVALID_DATE');
  }
  return iso;
}

function defaultAsOfDate(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

interface RevaluationLineDraft {
  customerId: number;
  customerName: string;
  invoiceId: number;
  invoiceNumber: string;
  currencyCode: string;
  foreignBalance4: bigint;
  bookBase4: bigint;
  priorAdjustment4: bigint;
  carryingBase4: bigint;
  closingRate6: bigint;
  closingRateStr: string;
  revaluedBase4: bigint;
  gainLoss4: bigint;
}

interface RevaluationDraft {
  asOfDate: string;
  baseCurrency: string;
  lines: RevaluationLineDraft[];
  totalGain4: bigint;
  totalLoss4: bigint;
  net4: bigint;
}

async function buildDraft(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  asOfDateInput?: string | null,
  currencyFilter?: string | null
): Promise<RevaluationDraft> {
  const asOfDate = asOfDateInput
    ? assertIsoDate(asOfDateInput, 'asOfDate')
    : defaultAsOfDate();
  const ctx = await resolveCommercialContext(tx, companyId, actor);

  const params: Array<string | number> = [companyId, asOfDate, ctx.baseCurrency];
  let currencyClause = '';
  const filter = String(currencyFilter || '').trim().toUpperCase();
  if (filter) {
    if (!/^[A-Z]{3}$/.test(filter)) {
      throw new AccountingError(400, 'currencyCode must be a 3-letter ISO code', 'INVALID_CURRENCY');
    }
    params.push(filter);
    currencyClause = ` AND i.currency_code = $${params.length}`;
  }

  const invRes = await tx.query<{
    id: number;
    invoice_number: string;
    customer_id: number;
    customer_name: string;
    currency_code: string;
    exchange_rate: string;
    foreign_balance_due: string;
  }>(
    `SELECT i.id, i.invoice_number, i.customer_id, c.company_name AS customer_name,
            i.currency_code, i.exchange_rate::text, i.foreign_balance_due::text
       FROM invoices i
       JOIN customers c ON c.company_id = i.company_id AND c.id = i.customer_id
      WHERE i.company_id = $1
        AND i.invoice_date <= $2::DATE
        AND i.status <> 'voided'
        AND i.is_sales_receipt = FALSE
        AND i.foreign_balance_due > 0
        AND i.currency_code <> $3
        ${currencyClause}
      ORDER BY i.currency_code, c.company_name, i.id`,
    params
  );

  const lines: RevaluationLineDraft[] = [];
  let totalGain4 = 0n;
  let totalLoss4 = 0n;

  for (const r of invRes.rows) {
    const foreignBalance4 = parseDecimal4(r.foreign_balance_due);
    if (foreignBalance4 <= 0n) continue;

    const closing = await resolveExchangeRate6(
      tx,
      companyId,
      r.currency_code,
      ctx.baseCurrency,
      asOfDate,
      null
    );

    const priorRes = await tx.query<{ prior: string }>(
      `SELECT COALESCE(SUM(l.gain_loss), 0)::NUMERIC(19,4)::text AS prior
         FROM fx_revaluation_lines l
         JOIN fx_revaluation_runs run
           ON run.company_id = l.company_id AND run.id = l.run_id
        WHERE l.company_id = $1 AND l.invoice_id = $2 AND run.status = 'posted'`,
      [companyId, Number(r.id)]
    );
    const priorAdjustment4 = parseDecimal4(priorRes.rows[0].prior);

    const bookBase4 = convertForeign4ToBase4(
      foreignBalance4,
      parseBaseRate(r.exchange_rate),
      ctx.roundingMode
    );
    const revaluedBase4 = convertForeign4ToBase4(
      foreignBalance4,
      closing.rate6,
      ctx.roundingMode
    );
    const gainLoss4 = revaluedBase4 - bookBase4 - priorAdjustment4;
    const carryingBase4 = bookBase4 + priorAdjustment4;

    if (gainLoss4 > 0n) totalGain4 += gainLoss4;
    if (gainLoss4 < 0n) totalLoss4 += -gainLoss4;

    lines.push({
      customerId: Number(r.customer_id),
      customerName: r.customer_name,
      invoiceId: Number(r.id),
      invoiceNumber: r.invoice_number,
      currencyCode: r.currency_code,
      foreignBalance4,
      bookBase4,
      priorAdjustment4,
      carryingBase4: carryingBase4 < 0n ? 0n : carryingBase4,
      closingRate6: closing.rate6,
      closingRateStr: closing.rateStr,
      revaluedBase4,
      gainLoss4,
    });
  }

  return {
    asOfDate,
    baseCurrency: ctx.baseCurrency,
    lines,
    totalGain4,
    totalLoss4,
    net4: totalGain4 - totalLoss4,
  };
}

function parseBaseRate(rate: string): bigint {
  const [whole, fraction = ''] = String(rate).split('.');
  const padded = (fraction + '000000').slice(0, 6);
  return BigInt(whole || '0') * 1000000n + BigInt(padded || '0');
}

function presentDraft(draft: RevaluationDraft) {
  return {
    asOfDate: draft.asOfDate,
    baseCurrency: draft.baseCurrency,
    totalGain: toMoneyNumber(draft.totalGain4),
    totalLoss: toMoneyNumber(draft.totalLoss4),
    netAdjustment: toMoneyNumber(draft.net4),
    invoiceCount: draft.lines.length,
    lines: draft.lines.map(l => ({
      customerId: l.customerId,
      customerName: l.customerName,
      invoiceId: l.invoiceId,
      invoiceNumber: l.invoiceNumber,
      currencyCode: l.currencyCode,
      foreignBalance: toMoneyNumber(l.foreignBalance4),
      bookBaseBalance: toMoneyNumber(l.bookBase4),
      priorAdjustment: toMoneyNumber(l.priorAdjustment4),
      carryingBaseBalance: toMoneyNumber(l.carryingBase4),
      closingRate: formatDecimal6(l.closingRate6),
      revaluedBaseBalance: toMoneyNumber(l.revaluedBase4),
      gainLoss: toMoneyNumber(l.gainLoss4),
    })),
  };
}

export async function previewFxRevaluation(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { asOfDate?: string | null; currencyCode?: string | null }
) {
  const draft = await buildDraft(tx, companyId, actor, input.asOfDate, input.currencyCode);
  return { ...presentDraft(draft), posted: false, runId: null as number | null };
}

export async function postFxRevaluation(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { asOfDate?: string | null; currencyCode?: string | null }
) {
  const draft = await buildDraft(tx, companyId, actor, input.asOfDate, input.currencyCode);

  const existing = await tx.query<{ id: number }>(
    `SELECT id FROM fx_revaluation_runs WHERE company_id = $1 AND as_of_date = $2::DATE LIMIT 1`,
    [companyId, draft.asOfDate]
  );
  if (existing.rows.length > 0) {
    throw new AccountingError(
      409,
      `FX revaluation for ${draft.asOfDate} has already been posted`,
      'FX_REVALUATION_EXISTS'
    );
  }

  const ctx = await resolveCommercialContext(tx, companyId, actor);
  const runIns = await tx.query<{ id: number }>(
    `INSERT INTO fx_revaluation_runs (
       company_id, as_of_date, base_currency, status, total_gain, total_loss, created_by
     ) VALUES ($1, $2::DATE, $3, 'posted', $4::NUMERIC(19,4), $5::NUMERIC(19,4), $6)
     RETURNING id`,
    [
      companyId,
      draft.asOfDate,
      draft.baseCurrency,
      formatDecimal4(draft.totalGain4),
      formatDecimal4(draft.totalLoss4),
      actor.userId,
    ]
  );
  const runId = Number(runIns.rows[0].id);

  // Aggregate the per-invoice adjustment by customer so AR control lines stay
  // tied to the customer subledger.
  const byCustomer = new Map<number, bigint>();
  for (const l of draft.lines) {
    if (l.gainLoss4 === 0n) continue;
    byCustomer.set(l.customerId, (byCustomer.get(l.customerId) ?? 0n) + l.gainLoss4);
  }

  let journalTxnId: number | null = null;
  if (byCustomer.size > 0) {
    const journalLines: Array<{
      accountId: number;
      debit: string;
      credit: string;
      description: string;
      partyType?: 'customer';
      partyId?: number;
    }> = [];
    for (const [customerId, adjustment4] of byCustomer) {
      if (adjustment4 === 0n) continue;
      journalLines.push({
        accountId: ctx.ar1100,
        debit: adjustment4 > 0n ? formatDecimal4(adjustment4) : '0.0000',
        credit: adjustment4 < 0n ? formatDecimal4(-adjustment4) : '0.0000',
        description: `Unrealized FX revaluation ${draft.asOfDate}`,
        partyType: 'customer',
        partyId: customerId,
      });
    }
    if (draft.totalGain4 > 0n) {
      journalLines.push({
        accountId: ctx.fxGain4900,
        debit: '0.0000',
        credit: formatDecimal4(draft.totalGain4),
        description: `Unrealized FX gain ${draft.asOfDate}`,
      });
    }
    if (draft.totalLoss4 > 0n) {
      journalLines.push({
        accountId: ctx.fxLoss6900,
        debit: formatDecimal4(draft.totalLoss4),
        credit: '0.0000',
        description: `Unrealized FX loss ${draft.asOfDate}`,
      });
    }

    const posted = await postJournalEntry(tx, companyId, actor, {
      txnDate: draft.asOfDate,
      description: `Unrealized FX revaluation as of ${draft.asOfDate}`,
      reference: `FX-REVAL-${draft.asOfDate}`,
      sourceType: 'fx_gain_loss',
      sourceId: runId,
      idempotencyKey: `fx-revaluation-${draft.asOfDate}`,
      lines: journalLines,
    });
    journalTxnId = posted.transaction.id;
    await tx.query(
      `UPDATE fx_revaluation_runs SET journal_txn_id = $3 WHERE company_id = $1 AND id = $2`,
      [companyId, runId, journalTxnId]
    );
  }

  for (const l of draft.lines) {
    await tx.query(
      `INSERT INTO fx_revaluation_lines (
         company_id, run_id, customer_id, invoice_id, currency_code,
         foreign_balance, carrying_base_balance, closing_rate,
         revalued_base_balance, gain_loss
       ) VALUES ($1, $2, $3, $4, $5, $6::NUMERIC(19,4), $7::NUMERIC(19,4), $8::NUMERIC(19,6),
                 $9::NUMERIC(19,4), $10::NUMERIC(19,4))`,
      [
        companyId,
        runId,
        l.customerId,
        l.invoiceId,
        l.currencyCode,
        formatDecimal4(l.foreignBalance4),
        formatDecimal4(l.carryingBase4),
        formatDecimal6(l.closingRate6),
        formatDecimal4(l.revaluedBase4),
        formatDecimal4(l.gainLoss4),
      ]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'FX_REVALUATION_POSTED',
    tableName: 'fx_revaluation_runs',
    recordId: runId,
    newValues: {
      asOfDate: draft.asOfDate,
      baseCurrency: draft.baseCurrency,
      invoiceCount: draft.lines.length,
      totalGain: formatDecimal4(draft.totalGain4),
      totalLoss: formatDecimal4(draft.totalLoss4),
      journalTxnId,
    },
  });

  return {
    ...presentDraft(draft),
    posted: true,
    runId,
    journalTransactionId: journalTxnId,
  };
}

export async function listFxRevaluationRuns(
  tx: Transaction,
  companyId: number,
  limit = 20
) {
  const res = await tx.query<{
    id: number;
    as_of_date: string;
    base_currency: string;
    status: string;
    total_gain: string;
    total_loss: string;
    journal_txn_id: number | null;
    created_at: string;
  }>(
    `SELECT id, as_of_date::text, base_currency, status, total_gain::text, total_loss::text,
            journal_txn_id, created_at::text
       FROM fx_revaluation_runs
      WHERE company_id = $1 AND status = 'posted'
      ORDER BY as_of_date DESC, id DESC
      LIMIT $2`,
    [companyId, Math.min(Math.max(Number(limit) || 20, 1), 100)]
  );
  return res.rows.map((r: {
    id: number;
    as_of_date: string;
    base_currency: string;
    status: string;
    total_gain: string;
    total_loss: string;
    journal_txn_id: number | null;
    created_at: string;
  }) => ({
    runId: Number(r.id),
    asOfDate: r.as_of_date,
    baseCurrency: r.base_currency,
    status: r.status,
    totalGain: toMoneyNumber(parseDecimal4(r.total_gain)),
    totalLoss: toMoneyNumber(parseDecimal4(r.total_loss)),
    journalTransactionId: r.journal_txn_id !== null ? Number(r.journal_txn_id) : null,
    createdAt: r.created_at,
  }));
}
