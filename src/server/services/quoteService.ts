import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { assertIsoDate } from './commercialHelpers.ts';
import { writeAuditLog } from '../audit.ts';

/**
 * Versioned quote documents for commercial work.
 *
 * A quote owns an ordered series of immutable versions; each version is a
 * snapshot of its lines and totals. Revising a quote adds a new version rather
 * than mutating history. Status transitions are explicit and validated.
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
  lines: QuoteLineInput[];
}

export interface AddVersionInput {
  lines: QuoteLineInput[];
  notes?: string | null;
}

const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired', 'converted'] as const;
type QuoteStatus = (typeof QUOTE_STATUSES)[number];

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

async function loadQuote(tx: Transaction, companyId: number, id: number, forUpdate = false) {
  const res = await tx.query<{
    id: number;
    quote_number: string;
    customer_id: number;
    title: string;
    status: string;
    current_version: number;
    total: string;
    valid_until: string | null;
    notes: string | null;
  }>(
    `SELECT id, quote_number, customer_id, title, status, current_version,
            total::text AS total, valid_until::text AS valid_until, notes
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

export async function listQuotes(tx: Transaction, companyId: number) {
  const res = await tx.query(
    `SELECT q.id, q.quote_number, q.customer_id, c.name AS customer_name, q.title, q.status,
            q.current_version, q.total::text AS total, q.valid_until::text AS valid_until,
            q.created_at::text AS created_at
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
    `SELECT id, version_no, lines, subtotal::text AS subtotal, tax_amount::text AS tax_amount,
            total::text AS total, notes, created_at::text AS created_at
       FROM quote_versions
      WHERE company_id = $1 AND quote_id = $2
      ORDER BY version_no ASC`,
    [companyId, Number(quote.id)]
  );
  return { quote, versions: versions.rows };
}

async function nextQuoteNumber(tx: Transaction, companyId: number): Promise<string> {
  const res = await tx.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM quotes WHERE company_id = $1`,
    [companyId]
  );
  const seq = Number(res.rows[0].cnt) + 1;
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
  const lines = normalizeLines(input.lines);
  const subtotal4 = sumLines(lines);
  const quoteNumber = await nextQuoteNumber(tx, companyId);

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO quotes (company_id, quote_number, customer_id, title, status, current_version, total, valid_until, notes)
     VALUES ($1, $2, $3, $4, 'draft', 1, $5::NUMERIC(19,4), $6::DATE, $7)
     RETURNING id`,
    [companyId, quoteNumber, customerId, title, formatDecimal4(subtotal4), validUntil, input.notes?.trim() || null]
  );
  const id = Number(ins.rows[0].id);

  await tx.query(
    `INSERT INTO quote_versions (company_id, quote_id, version_no, lines, subtotal, tax_amount, total, notes, created_by)
     VALUES ($1, $2, 1, $3::JSONB, $4::NUMERIC(19,4), 0, $5::NUMERIC(19,4), $6, $7)`,
    [companyId, id, JSON.stringify(lines), formatDecimal4(subtotal4), formatDecimal4(subtotal4), input.notes?.trim() || null, actor.userId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'quote.create',
    tableName: 'quotes',
    recordId: id,
    newValues: { quoteNumber, title, total: formatDecimal4(subtotal4) },
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
  const nextVersion = Number(quote.current_version) + 1;

  await tx.query(
    `INSERT INTO quote_versions (company_id, quote_id, version_no, lines, subtotal, tax_amount, total, notes, created_by)
     VALUES ($1, $2, $3, $4::JSONB, $5::NUMERIC(19,4), 0, $6::NUMERIC(19,4), $7, $8)`,
    [companyId, quoteId, nextVersion, JSON.stringify(lines), formatDecimal4(subtotal4), formatDecimal4(subtotal4), input.notes?.trim() || null, actor.userId]
  );

  await tx.query(
    `UPDATE quotes
        SET current_version = $2, total = $3::NUMERIC(19,4), status = 'draft', updated_at = NOW()
      WHERE company_id = $1 AND id = $4`,
    [companyId, nextVersion, formatDecimal4(subtotal4), quoteId]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'quote.add_version',
    tableName: 'quotes',
    recordId: quoteId,
    newValues: { version: nextVersion, total: formatDecimal4(subtotal4) },
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
  if (quote.status === 'converted' && next !== 'converted') {
    throw new AccountingError(409, 'A converted quote cannot change status', 'QUOTE_CONVERTED');
  }
  if (quote.status === next) {
    return getQuote(tx, companyId, quoteId);
  }

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