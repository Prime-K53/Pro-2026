import type { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';
import { writeAuditLog } from '../audit.ts';

/**
 * Compliance & self-service data foundation.
 *
 * 1. Customer statement: an accounts-receivable statement (invoices, payments,
 *    credits and the running balance) for a customer over a date range. This is
 *    the data backing a customer self-service portal's "statement of account".
 * 2. Vendor 1099-style summary: per-vendor disbursements for a calendar year,
 *    restricted to 1099-eligible vendors, with TIN and totals. This is the
 *    data backing a year-end 1099 reporting workflow.
 *
 * Neither of these modules mutates the ledger; they are read-only aggregations.
 */

export interface CustomerStatementLine {
  date: string;
  type: 'invoice' | 'payment' | 'credit_memo' | 'adjustment';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface CustomerStatement {
  customerId: number;
  customerName: string;
  startDate: string;
  endDate: string;
  openingBalance: number;
  lines: CustomerStatementLine[];
  closingBalance: number;
  totalInvoiced: number;
  totalPaid: number;
  totalCredits: number;
}

export async function getCustomerStatement(
  tx: Transaction,
  companyId: number,
  customerId: number,
  startDate: string,
  endDate: string
): Promise<CustomerStatement> {
  const custRes = await tx.query<{ id: number; name: string }>(
    `SELECT id, name FROM customers WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, customerId]
  );
  if (custRes.rows.length === 0) {
    throw new AccountingError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
  }
  const customer = custRes.rows[0];

  // Opening balance = sum of invoices unpaid at start of period - payments/credits
  // applied before the start date.
  const openRes = await tx.query<{ opening: string }>(
    `SELECT COALESCE(
       (SELECT COALESCE(SUM(balance_due), 0) FROM invoices
         WHERE company_id = $1 AND customer_id = $2 AND status <> 'void'
           AND invoice_date < $3::DATE),
       0)::text AS opening`,
    [companyId, customerId, startDate]
  );
  const openingBalance = Number(openRes.rows[0].opening ?? 0);

  // Invoices in range.
  const invRes = await tx.query<{
    invoice_date: string;
    invoice_number: string;
    total: string;
    balance_due: string;
  }>(
    `SELECT invoice_date::text AS invoice_date, invoice_number,
            total::text AS total, balance_due::text AS balance_due
       FROM invoices
      WHERE company_id = $1 AND customer_id = $2 AND status <> 'void'
        AND invoice_date BETWEEN $3::DATE AND $4::DATE
      ORDER BY invoice_date ASC, id ASC`,
    [companyId, customerId, startDate, endDate]
  );

  // Payments in range.
  const payRes = await tx.query<{
    payment_date: string;
    payment_number: string;
    amount: string;
  }>(
    `SELECT payment_date::text AS payment_date, payment_number, amount::text AS amount
       FROM payments
      WHERE company_id = $1 AND customer_id = $2
        AND payment_date BETWEEN $3::DATE AND $4::DATE
      ORDER BY payment_date ASC, id ASC`,
    [companyId, customerId, startDate, endDate]
  );

  // Credit memos in range.
  const cmRes = await tx.query<{
    credit_date: string;
    credit_number: string;
    total: string;
  }>(
    `SELECT credit_date::text AS credit_date, credit_number, total::text AS total
       FROM credit_memos
      WHERE company_id = $1 AND customer_id = $2 AND status <> 'void'
        AND credit_date BETWEEN $3::DATE AND $4::DATE
      ORDER BY credit_date ASC, id ASC`,
    [companyId, customerId, startDate, endDate]
  );

  type RawLine = { date: string; sort: number; line: CustomerStatementLine };
  const raw: RawLine[] = [];
  let seq = 0;
  for (const r of invRes.rows) {
    raw.push({
      date: String(r.invoice_date).slice(0, 10),
      sort: seq++,
      line: {
        date: String(r.invoice_date).slice(0, 10),
        type: 'invoice',
        reference: r.invoice_number,
        description: 'Invoice',
        debit: Number(r.total),
        credit: 0,
        runningBalance: 0,
      },
    });
  }
  for (const r of payRes.rows) {
    raw.push({
      date: String(r.payment_date).slice(0, 10),
      sort: seq++,
      line: {
        date: String(r.payment_date).slice(0, 10),
        type: 'payment',
        reference: r.payment_number,
        description: 'Payment received',
        debit: 0,
        credit: Number(r.amount),
        runningBalance: 0,
      },
    });
  }
  for (const r of cmRes.rows) {
    raw.push({
      date: String(r.credit_date).slice(0, 10),
      sort: seq++,
      line: {
        date: String(r.credit_date).slice(0, 10),
        type: 'credit_memo',
        reference: r.credit_number,
        description: 'Credit memo',
        debit: 0,
        credit: Number(r.total),
        runningBalance: 0,
      },
    });
  }
  raw.sort((a, b) => a.date.localeCompare(b.date) || a.sort - b.sort);

  let running = openingBalance;
  const lines: CustomerStatementLine[] = raw.map(r => {
    running = running + r.line.debit - r.line.credit;
    return { ...r.line, runningBalance: Number(running.toFixed(4)) };
  });

  const totalInvoiced = invRes.rows.reduce((s, r) => s + Number(r.total), 0);
  const totalPaid = payRes.rows.reduce((s, r) => s + Number(r.amount), 0);
  const totalCredits = cmRes.rows.reduce((s, r) => s + Number(r.total), 0);

  return {
    customerId,
    customerName: customer.name,
    startDate,
    endDate,
    openingBalance,
    lines,
    closingBalance: running,
    totalInvoiced,
    totalPaid,
    totalCredits,
  };
}

export interface Vendor1099Row {
  vendorId: number;
  vendorName: string;
  companyName: string;
  tin: string | null;
  is1099Eligible: boolean;
  totalPaid: number;
  paymentCount: number;
  totalWithheld: number;
}

export async function getVendor1099Summary(
  tx: Transaction,
  companyId: number,
  year: number
): Promise<{ year: number; vendors: Vendor1099Row[]; totalPaid: number }> {
  const res = await tx.query<{
            vendor_id: number;
            vendor_name: string;
            company_name: string;
            ein_or_ssn: string | null;
            is_1099_eligible: boolean;
            total_paid: string;
            payment_count: string;
            total_withheld: string;
          }>(
    `SELECT v.id AS vendor_id, v.name AS vendor_name, v.company_name,
            v.ein_or_ssn, v.is_1099_eligible,
            COALESCE(SUM(bp.amount), 0)::text AS total_paid,
            COALESCE(SUM(bp.withholding_tax_amount), 0)::text AS total_withheld,
            COUNT(bp.id)::text AS payment_count
       FROM vendors v
       LEFT JOIN bill_payments bp
         ON bp.company_id = v.company_id AND bp.vendor_id = v.id
        AND EXTRACT(YEAR FROM bp.payment_date) = $2
       WHERE v.company_id = $1
       GROUP BY v.id, v.name, v.company_name, v.ein_or_ssn, v.is_1099_eligible
       ORDER BY v.company_name ASC`,
    [companyId, year]
  );

  const vendors: Vendor1099Row[] = res.rows.map(r => ({
    vendorId: Number(r.vendor_id),
    vendorName: r.vendor_name,
    companyName: r.company_name,
    tin: r.ein_or_ssn,
    is1099Eligible: Boolean(r.is_1099_eligible),
    totalPaid: Number(r.total_paid) + Number(r.total_withheld),
    paymentCount: Number(r.payment_count),
    totalWithheld: Number(r.total_withheld),
  }));

  const totalPaid = vendors.reduce((s, v) => s + v.totalPaid, 0);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: null,
    actorUsername: 'system',
    action: 'compliance.vendor_1099_summary',
    tableName: 'vendors',
    recordId: 0,
    newValues: { year, vendorCount: vendors.length, totalPaid },
  });
  return { year, vendors, totalPaid };
}