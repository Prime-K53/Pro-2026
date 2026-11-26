import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { assertIsoDate } from './commercialHelpers.ts';
import { writeAuditLog } from '../audit.ts';
import { createInvoiceOrSalesReceipt } from './salesService.ts';

/**
 * Versioned quote documents for commercial work.
 *
 * A quote owns an ordered series of immutable versions; each version is a
 * snapshot of its lines and totals. Revising a quote adds a new version rather
 * than mutating history. Status transitions are explicit and validated against
 * a transition matrix. An accepted quote can be converted to a real invoice.
 */

export interface QuoteLineInput {
  description: string;
  quantity: string | number;
  rate: string | number;
}

export interface CreateQuoteInput {
  customerId: number;
  title: string;
  validUntil?: string | null;
  notes?: string | null;
  taxRate?: string | number | null;
  lines: QuoteLineInput[];
}

export interface AddVersionInput {
  lines: QuoteLineInput[];
  notes?: string | null;
  taxRate?: string | number | null;
}

const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired', 'converted'] as const;
type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/**
 * Allowed status transitions. A quote must be sent before it can be accepted or
 * declined, and only an accepted quote can be converted. Terminal states
 * (declined, expired, converted) cannot transition further.
 */
const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ['sent'],
  sent: ['accepted', 'declined', 'expired'],
  accepted: ['converted', 'expired'],
  declined: [],
  expired: [],
  converted: [],
};

function assertQuoteTransition(from: string, to: QuoteStatus): void {
  const allowed = QUOTE_TRANSITIONS[from as QuoteStatus] || [];
  if (!allowed.includes(to)) {
    throw new AccountingError(
      409,
      `Cannot change quote status from '${from}' to '${to}'`,
      'INVALID_QUOTE_TRANSITION'
    );
  }
}

function toId(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AccountingError(400, `${field} must be a positive integer`, 'INVALID_ID');
  }
  return n;
}

function normalizeLines(lines: QuoteLineInput[]): Array<{ description: string; quantity: string; rate: string; amount: string }> {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new AccountingError(400, 'At least one line is required', 'LINES_REQUIRED');
  }
  return lines.map((l, i) => {
    const qty4 = parseDecimal4(l.quantity ?? 0);
    const rate4 = parseDecimal4(l.rate ?? 0);
    if (qty4 <= 0n || rate4 < 0n) {
      throw new AccountingError(400, `Line ${i + 1} has an invalid quantity or rate`, 'INVALID_LINE');
    }
    return {
      description: String(l.description || '').trim() || `Line ${i + 1}`,
      quantity: formatDecimal4(qty4),
      rate: formatDecimal4(rate4),
      amount: formatDecimal4((qty4 * rate4) / 10000n),
    };
  });
}

function sumLines(lines: Array<{ amount: string }>): bigint {
  return lines.reduce((sum, l) => sum + parseDecimal4(l.amount), 0n);
}

/** Compute tax (decimal4) from a subtotal (decimal4) and a percentage rate. */
function computeTax4(subtotal4: bigint, taxRatePct: string | number | null | undefined): bigint {
  const rate4 = parseDecimal4(taxRatePct ?? 0); // percentage scaled ×10000 (e.g. 16% → 160000)
  if (rate4 <= 0n) return 0n;
  return (subtotal4 * rate4) / 1_000_000n;
}

async function loadQuote(tx: Transaction, companyId: number, id: number, forUpdate = false) {
  const res = await tx.query<{
    id: number;
    quote_number: string;
    customer_id: number;
    title: string;
    status: string;
    current_version: number;
    total: string;
    tax_rate: string;
    valid_until: string | null;
    notes: string | null;
  }>(
    `SELECT id, quote_number, customer_id, title, status, current_version,
            total::text AS total, tax_rate::text AS tax_rate, valid_until::text AS valid_until, notes
       FROM quotes
      WHERE company_id = $1 AND id = $2
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [companyId, id]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Quote not found', 'QUOTE_NOT_FOUND');
  }
  return res.rows[0];
}

/** Lazily mark overdue quotes (past valid_until) as expired so the status is accurate. */
async function expireOverdueQuotes(tx: Transaction, companyId: number): Promise<void> {
  await tx.query(
    `UPDATE quotes
        SET status = 'expired', updated_at = NOW()
      WHERE company_id = $1
        AND status IN ('draft', 'sent', 'accepted')
        AND valid_until IS NOT NULL
        AND valid_until < CURRENT_DATE`,
    [companyId]
  );
}

export async function listQuotes(tx: Transaction, companyId: number) {
  await expireOverdueQuotes(tx, companyId);
  const res = await tx.query(
    `SELECT q.id, q.quote_number, q.customer_id, c.company_name AS customer_name, q.title, q.status,
            q.current_version, q.total::text AS total, q.tax_rate::text AS tax_rate,
            q.valid_until::text AS valid_until, q.created_at::text AS created_at
       FROM quotes q
       JOIN customers c ON c.company_id = q.company_id AND c.id = q.customer_id
      WHERE q.company_id = $1
      ORDER BY q.created_at DESC`,
    [companyId]
  );
  return res.rows;
}

export async function getQuote(tx: Transaction, companyId: number, id: number) {
  const quote = await loadQuote(tx, companyId, toId(id, 'quote id'));
  const versions = await tx.query(
    `SELECT id, version_no, lines, subtotal::text AS subtotal, tax_rate::text AS tax_rate,
            tax_amount::text AS tax_amount, total::text AS total, notes, created_at::text AS created_at
       FROM quote_versions
      WHERE company_id = $1 AND quote_id = $2
      ORDER BY version_no ASC`,
    [companyId, Number(quote.id)]
  );
  return { quote, versions: versions.rows };
}

async function nextQuoteNumber(tx: Transaction, companyId: number): Promise<string> {
  // Lock the company row so concurrent quote creates cannot draw the same
  // number (mirrors generateNextDocNumber for invoices/payments).
  await tx.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [companyId]);
  // Monotonic MAX(id) so deleting rows can never reuse a quote number.
  const res = await tx.query<{ next: string }>(
    `SELECT (MAX(id) + 1)::text AS next FROM quotes WHERE company_id = $1`,
    [companyId]
  );
  const seq = Number(res.rows[0]?.next || 1);
  return `QT-${new Date().getFullYear()}-${String(seq).padStart(5, '0')}`;
}

export async function createQuote(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: CreateQuoteInput
) {
  const customerId = toId(input.customerId, 'customerId');
  const title = String(input.title || '').trim();
  if (!title) throw new AccountingError(400, 'Quote title is required', 'TITLE_REQUIRED');

  const customerRes = await tx.query<{ id: number }>(
    `SELECT id FROM customers WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, customerId]
  );
  if (customerRes.rows.length === 0) {
    throw new AccountingError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
  }

  const validUntil = input.validUntil ? assertIsoDate(input.validUntil, 'validUntil') : null;
  const taxRate = input.taxRate ?? 0;
  const lines = normalizeLines(input.lines);
  const subtotal4 = sumLines(lines);
  const tax4 = computeTax4(subtotal4, taxRate);
  const total4 = subtotal4 + tax4;
  const quoteNumber = await nextQuoteNumber(tx, companyId);

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO quotes (company_id, quote_number, customer_id, title, status, current_version, total, tax_rate, valid_until, notes)
     VALUES ($1, $2, $3, $4, 'draft', 1, $5::NUMERIC(19,4), $6::NUMERIC(9,6), $7::DATE, $8)
     RETURNING id`,
    [companyId, quoteNumber, customerId, title, formatDecimal4(total4), taxRate, validUntil, input.notes?.trim() || null]
  );
  const id = Number(ins.rows[0].id);

  await tx.query(
    `INSERT INTO quote_versions (company_id, quote_id, version_no, lines, subtotal, tax_rate, tax_amount, total, notes, created_by)
     VALUES ($1, $2, 1, $3::JSONB, $4::NUMERIC(19,4), $5::NUMERIC(9,6), $6::NUMERIC(19,4), $7::NUMERIC(19,4), $8, $9)`,
    [companyId, id, JSON.stringify(lines), formatDecimal4(subtotal4), taxRate, formatDecimal4(tax4), formatDecimal4(total4), input.notes?.trim() || null, actor.userId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'quote.create',
    tableName: 'quotes',
    recordId: id,
    newValues: { quoteNumber, title, total: formatDecimal4(total4) },
  });

  return getQuote(tx, companyId, id);
}

export async function addQuoteVersion(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  id: number,
  input: AddVersionInput
) {
  const quoteId = toId(id, 'quote id');
  const quote = await loadQuote(tx, companyId, quoteId, true);
  if (quote.status === 'converted') {
    throw new AccountingError(409, 'Converted quotes cannot be revised', 'QUOTE_CONVERTED');
  }
  if (quote.status === 'declined' || quote.status === 'expired') {
    throw new AccountingError(409, `Cannot revise a ${quote.status} quote`, 'QUOTE_NOT_REVISABLE');
  }

  const lines = normalizeLines(input.lines);
  const subtotal4 = sumLines(lines);
  const taxRate = input.taxRate !== undefined ? input.taxRate : quote.tax_rate;
  const tax4 = computeTax4(subtotal4, taxRate);
  const total4 = subtotal4 + tax4;
  const nextVersion = Number(quote.current_version) + 1;

  await tx.query(
    `INSERT INTO quote_versions (company_id, quote_id, version_no, lines, subtotal, tax_rate, tax_amount, total, notes, created_by)
     VALUES ($1, $2, $3, $4::JSONB, $5::NUMERIC(19,4), $6::NUMERIC(9,6), $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9, $10)`,
    [companyId, quoteId, nextVersion, JSON.stringify(lines), formatDecimal4(subtotal4), taxRate, formatDecimal4(tax4), formatDecimal4(total4), input.notes?.trim() || null, actor.userId]
  );

  // A revised sent quote must be re-sent (back to draft); an accepted quote keeps
  // its accepted status (the customer already approved the engagement).
  const nextStatus = quote.status === 'sent' ? 'draft' : quote.status;

  await tx.query(
    `UPDATE quotes
        SET current_version = $2, total = $3::NUMERIC(19,4), tax_rate = $4::NUMERIC(9,6), status = $5, updated_at = NOW()
      WHERE company_id = $1 AND id = $6`,
    [companyId, nextVersion, formatDecimal4(total4), taxRate, nextStatus, quoteId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'quote.add_version',
    tableName: 'quotes',
    recordId: quoteId,
    newValues: { version: nextVersion, total: formatDecimal4(total4), status: nextStatus },
  });

  return getQuote(tx, companyId, quoteId);
}

export async function setQuoteStatus(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  id: number,
  status: string
) {
  const quoteId = toId(id, 'quote id');
  const next = String(status || '').toLowerCase() as QuoteStatus;
  if (!QUOTE_STATUSES.includes(next)) {
    throw new AccountingError(400, `Invalid quote status '${status}'`, 'INVALID_QUOTE_STATUS');
  }
  const quote = await loadQuote(tx, companyId, quoteId, true);
  if (quote.status === next) {
    return getQuote(tx, companyId, quoteId);
  }
  assertQuoteTransition(quote.status, next);

  await tx.query(
    `UPDATE quotes SET status = $2, updated_at = NOW() WHERE company_id = $1 AND id = $3`,
    [companyId, next, quoteId]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'quote.status_change',
    tableName: 'quotes',
    recordId: quoteId,
    oldValues: { status: quote.status },
    newValues: { status: next },
  });
  return getQuote(tx, companyId, quoteId);
}

/**
 * Convert an accepted quote into a real invoice using the current version's
 * lines. The quote is flipped to `converted` only after the invoice is created.
 */
export async function convertQuoteToInvoice(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  id: number
) {
  const quoteId = toId(id, 'quote id');
  const quote = await loadQuote(tx, companyId, quoteId, true);
  if (quote.status === 'converted') {
    throw new AccountingError(409, `Quote ${quote.quote_number} has already been converted`, 'QUOTE_CONVERTED');
  }
  if (quote.status !== 'accepted') {
    throw new AccountingError(409, 'Only an accepted quote can be converted', 'QUOTE_NOT_ACCEPTED');
  }

  const verRes = await tx.query<{ lines: unknown }>(
    `SELECT lines FROM quote_versions
      WHERE company_id = $1 AND quote_id = $2 AND version_no = $3 LIMIT 1`,
    [companyId, quoteId, Number(quote.current_version)]
  );
  const rawLines = Array.isArray(verRes.rows[0]?.lines) ? (verRes.rows[0].lines as any[]) : [];
  const lines = rawLines.map(l => ({
    description: String(l.description || ''),
    quantity: String(l.quantity ?? 1),
    rate: String(l.rate ?? 0),
    taxable: false,
  }));
  if (lines.length === 0) {
    throw new AccountingError(409, 'Quote has no lines to convert', 'QUOTE_NO_LINES');
  }

  const result = await createInvoiceOrSalesReceipt(tx, companyId, actor, {
    customerId: Number(quote.customer_id),
    taxRate: quote.tax_rate,
    notes: `Converted from Quote ${quote.quote_number}`,
    lines,
  });
  const invoice = (result as any)?.invoice ?? result;

  await tx.query(
    `UPDATE quotes SET status = 'converted', updated_at = NOW() WHERE company_id = $1 AND id = $2`,
    [companyId, quoteId]
  );
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'quote.convert',
    tableName: 'quotes',
    recordId: quoteId,
    newValues: { status: 'converted', invoiceId: invoice?.id ?? null },
  });

  return { quote: await getQuote(tx, companyId, quoteId), invoice };
}