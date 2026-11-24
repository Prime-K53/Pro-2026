import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, ActorContext } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';

/**
 * Multi-rate tax engine: a per-company registry of tax codes (rate +
 * jurisdiction) and a jurisdiction tax summary. Invoices may reference a tax
 * code (`invoices.tax_code_id`); when set, the invoice's tax rate is taken from
 * the code instead of the single per-invoice flat rate.
 */

export interface TaxCodeInput {
  code: string;
  name: string;
  rate?: string | number | null;
  jurisdiction?: string | null;
}

export async function listTaxCodes(tx: Transaction, companyId: number) {
  const res = await tx.query(
    `SELECT id, code, name, rate::text AS rate, jurisdiction, is_active
       FROM tax_codes
      WHERE company_id = $1
      ORDER BY jurisdiction ASC, code ASC`,
    [companyId]
  );
  return res.rows;
}

export async function createTaxCode(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: TaxCodeInput
) {
  const code = String(input.code || '').trim().toUpperCase();
  const name = String(input.name || '').trim();
  if (!code) throw new AccountingError(400, 'Tax code is required', 'TAX_CODE_REQUIRED');
  if (!name) throw new AccountingError(400, 'Tax code name is required', 'NAME_REQUIRED');
  const rate = Number(input.rate ?? 0);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new AccountingError(400, 'Tax rate must be a non-negative percentage', 'INVALID_TAX_RATE');
  }
  const jurisdiction = String(input.jurisdiction || 'General').trim() || 'General';

  let ins;
  try {
    ins = await tx.query<{ id: number }>(
      `INSERT INTO tax_codes (company_id, code, name, rate, jurisdiction)
       VALUES ($1, $2, $3, $4::NUMERIC(9,6), $5)
       RETURNING id`,
      [companyId, code, name, rate, jurisdiction]
    );
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new AccountingError(409, `Tax code '${code}' already exists`, 'TAX_CODE_DUPLICATE');
    }
    throw err;
  }

  const id = Number(ins.rows[0].id);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'tax_code.create',
    tableName: 'tax_codes',
    recordId: id,
    newValues: { code, name, rate, jurisdiction },
  });
  const all = await listTaxCodes(tx, companyId);
  return all.find((c: any) => Number(c.id) === id)!;
}

/**
 * Resolve the effective tax rate (as a percentage) for an invoice: the tax
 * code's rate when a code is supplied, else the caller's flat rate.
 */
export async function resolveTaxRatePct(
  tx: Transaction,
  companyId: number,
  taxCodeId: number | null | undefined,
  fallbackRatePct: number
): Promise<number> {
  if (!taxCodeId) return fallbackRatePct;
  const res = await tx.query<{ rate: string; is_active: boolean }>(
    `SELECT rate::text AS rate, is_active FROM tax_codes WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, Number(taxCodeId)]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Tax code not found', 'TAX_CODE_NOT_FOUND');
  }
  if (!res.rows[0].is_active) {
    throw new AccountingError(409, 'Tax code is inactive', 'TAX_CODE_INACTIVE');
  }
  return Number(res.rows[0].rate);
}

/**
 * Tax summary by jurisdiction: taxable sales and tax collected, grouped by the
 * tax code's jurisdiction, for invoices in the date range.
 */
export async function getTaxSummaryByJurisdiction(
  tx: Transaction,
  companyId: number,
  startDate: string,
  endDate: string
) {
  const res = await tx.query<{
    jurisdiction: string;
    invoice_count: string;
    gross_sales: string;
    taxable_sales: string;
    tax_collected: string;
  }>(
    `SELECT
        COALESCE(tc.jurisdiction, 'General') AS jurisdiction,
        COUNT(*)::text AS invoice_count,
        COALESCE(SUM(i.total - i.tax_amount), 0)::text AS gross_sales,
        COALESCE(SUM(CASE WHEN i.is_tax_exempt = FALSE THEN (i.subtotal) ELSE 0 END), 0)::text AS taxable_sales,
        COALESCE(SUM(i.tax_amount), 0)::text AS tax_collected
       FROM invoices i
       LEFT JOIN tax_codes tc ON tc.company_id = i.company_id AND tc.id = i.tax_code_id
      WHERE i.company_id = $1
        AND i.is_sales_receipt = FALSE
        AND i.status <> 'void'
        AND i.invoice_date BETWEEN $2::DATE AND $3::DATE
      GROUP BY COALESCE(tc.jurisdiction, 'General')
      ORDER BY jurisdiction ASC`,
    [companyId, startDate, endDate]
  );

  const rows = res.rows.map(r => ({
    jurisdiction: r.jurisdiction,
    invoiceCount: Number(r.invoice_count),
    grossSales: Number(r.gross_sales),
    taxableSales: Number(r.taxable_sales),
    taxCollected: Number(r.tax_collected),
  }));
  const totals = rows.reduce(
    (acc, r) => ({
      invoiceCount: acc.invoiceCount + r.invoiceCount,
      grossSales: acc.grossSales + r.grossSales,
      taxableSales: acc.taxableSales + r.taxableSales,
      taxCollected: acc.taxCollected + r.taxCollected,
    }),
    { invoiceCount: 0, grossSales: 0, taxableSales: 0, taxCollected: 0 }
  );
  return { rows, totals };
}