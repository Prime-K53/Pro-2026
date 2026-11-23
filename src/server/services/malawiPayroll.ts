import type { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';

/**
 * Configurable Malawi statutory payroll.
 *
 * Nothing here hardcodes a rate. Companies configure effective-dated PAYE
 * bands and statutory rates (pension etc.); a payroll run refuses to execute
 * until PAYE bands exist, so a missing configuration fails loudly.
 */

export type StatutoryRateType =
  | 'pension_employee'
  | 'pension_employer'
  | 'other_statutory';

export interface PayeBand {
  id?: number;
  lowerBound: number;
  upperBound: number | null;
  rate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface StatutoryRate {
  id?: number;
  rateType: StatutoryRateType;
  rate: number;
  basis: 'gross' | 'basic';
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface MalawiStatutoryConfig {
  bands: PayeBand[];
  pensionEmployeeRate: number;
  pensionEmployerRate: number;
  otherStatutoryRate: number;
}

export interface MalawiPayrollItem {
  grossPay: number;
  paye: number;
  pensionEmployee: number;
  pensionEmployer: number;
  otherDeductions: number;
  employerOther: number;
  netPay: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isoDate(value: unknown): string {
  return String(value || '').slice(0, 10);
}

/** Progressive PAYE across effective-dated bands. */
export function computePaye(taxable: number, bands: PayeBand[]): number {
  let tax = 0;
  const sorted = [...bands].sort((a, b) => a.lowerBound - b.lowerBound);
  for (const band of sorted) {
    if (taxable <= band.lowerBound) break;
    const upper = band.upperBound ?? Number.POSITIVE_INFINITY;
    const slice = Math.min(taxable, upper) - band.lowerBound;
    if (slice > 0) tax += slice * band.rate;
  }
  return round2(tax);
}

export function computeMalawiItem(
  gross: number,
  config: MalawiStatutoryConfig
): MalawiPayrollItem {
  const grossPay = round2(gross);
  const paye = computePaye(grossPay, config.bands);
  const pensionEmployee = round2(grossPay * config.pensionEmployeeRate);
  const pensionEmployer = round2(grossPay * config.pensionEmployerRate);
  const employerOther = round2(grossPay * config.otherStatutoryRate);
  // Other deductions (advances/loans) are applied by the caller; default 0.
  const otherDeductions = 0;
  const netPay = round2(
    grossPay - paye - pensionEmployee - otherDeductions
  );
  return {
    grossPay,
    paye,
    pensionEmployee,
    pensionEmployer,
    otherDeductions,
    employerOther,
    netPay,
  };
}

/** Load the configuration effective on `payDate`, or null if PAYE is unset. */
export async function loadMalawiConfig(
  tx: Transaction,
  companyId: number,
  payDate: string
): Promise<MalawiStatutoryConfig | null> {
  const bandRes = await tx.query<any>(
    `SELECT id, lower_bound, upper_bound, rate, effective_from::text, effective_to::text
       FROM payroll_paye_bands
      WHERE company_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY lower_bound ASC`,
    [companyId, payDate]
  );
  const bands: PayeBand[] = bandRes.rows.map((r: any) => ({
    id: Number(r.id),
    lowerBound: toNumber(r.lower_bound),
    upperBound: r.upper_bound == null ? null : toNumber(r.upper_bound),
    rate: toNumber(r.rate),
    effectiveFrom: isoDate(r.effective_from),
    effectiveTo: r.effective_to ? isoDate(r.effective_to) : null,
  }));
  if (bands.length === 0) return null;

  const rateRes = await tx.query<any>(
    `SELECT DISTINCT ON (rate_type) rate_type, rate, basis, effective_from::text, effective_to::text
       FROM payroll_statutory_rates
      WHERE company_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY rate_type, effective_from DESC`,
    [companyId, payDate]
  );
  const byType = new Map<string, any>();
  for (const r of rateRes.rows) byType.set(r.rate_type, r);

  return {
    bands,
    pensionEmployeeRate: toNumber(byType.get('pension_employee')?.rate ?? 0),
    pensionEmployerRate: toNumber(byType.get('pension_employer')?.rate ?? 0),
    otherStatutoryRate: toNumber(byType.get('other_statutory')?.rate ?? 0),
  };
}

// ─── Configuration CRUD ──────────────────────────────────────────────────

export async function listPayeBands(tx: Transaction, companyId: number): Promise<PayeBand[]> {
  const res = await tx.query<any>(
    `SELECT id, lower_bound, upper_bound, rate, effective_from::text, effective_to::text
       FROM payroll_paye_bands WHERE company_id = $1 ORDER BY lower_bound`,
    [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    lowerBound: toNumber(r.lower_bound),
    upperBound: r.upper_bound == null ? null : toNumber(r.upper_bound),
    rate: toNumber(r.rate),
    effectiveFrom: isoDate(r.effective_from),
    effectiveTo: r.effective_to ? isoDate(r.effective_to) : null,
  }));
}

export async function createPayeBand(
  tx: Transaction,
  companyId: number,
  input: {
    lowerBound: number;
    upperBound?: number | null;
    rate: number;
    effectiveFrom: string;
    effectiveTo?: string | null;
  }
): Promise<PayeBand> {
  if (!(input.rate >= 0 && input.rate <= 1)) {
    throw new AccountingError(400, 'rate must be between 0 and 1', 'INVALID_RATE');
  }
  const res = await tx.query<any>(
    `INSERT INTO payroll_paye_bands (company_id, lower_bound, upper_bound, rate, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5::date, $6::date) RETURNING *`,
    [
      companyId,
      input.lowerBound,
      input.upperBound ?? null,
      input.rate,
      input.effectiveFrom,
      input.effectiveTo || null,
    ]
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    lowerBound: toNumber(r.lower_bound),
    upperBound: r.upper_bound == null ? null : toNumber(r.upper_bound),
    rate: toNumber(r.rate),
    effectiveFrom: isoDate(r.effective_from),
    effectiveTo: r.effective_to ? isoDate(r.effective_to) : null,
  };
}

export async function deletePayeBand(tx: Transaction, companyId: number, id: number): Promise<boolean> {
  const res = await tx.query(
    `DELETE FROM payroll_paye_bands WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  return (res as any).rowCount > 0;
}

export async function listStatutoryRates(tx: Transaction, companyId: number): Promise<StatutoryRate[]> {
  const res = await tx.query<any>(
    `SELECT id, rate_type, rate, basis, effective_from::text, effective_to::text
       FROM payroll_statutory_rates WHERE company_id = $1 ORDER BY rate_type, effective_from`,
    [companyId]
  );
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    rateType: r.rate_type,
    rate: toNumber(r.rate),
    basis: r.basis,
    effectiveFrom: isoDate(r.effective_from),
    effectiveTo: r.effective_to ? isoDate(r.effective_to) : null,
  }));
}

export async function createStatutoryRate(
  tx: Transaction,
  companyId: number,
  input: {
    rateType: StatutoryRateType;
    rate: number;
    basis?: 'gross' | 'basic';
    effectiveFrom: string;
    effectiveTo?: string | null;
  }
): Promise<StatutoryRate> {
  if (!(input.rate >= 0 && input.rate <= 1)) {
    throw new AccountingError(400, 'rate must be between 0 and 1', 'INVALID_RATE');
  }
  const res = await tx.query<any>(
    `INSERT INTO payroll_statutory_rates (company_id, rate_type, rate, basis, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5::date, $6::date) RETURNING *`,
    [
      companyId,
      input.rateType,
      input.rate,
      input.basis || 'gross',
      input.effectiveFrom,
      input.effectiveTo || null,
    ]
  );
  const r = res.rows[0];
  return {
    id: Number(r.id),
    rateType: r.rate_type,
    rate: toNumber(r.rate),
    basis: r.basis,
    effectiveFrom: isoDate(r.effective_from),
    effectiveTo: r.effective_to ? isoDate(r.effective_to) : null,
  };
}

export async function deleteStatutoryRate(tx: Transaction, companyId: number, id: number): Promise<boolean> {
  const res = await tx.query(
    `DELETE FROM payroll_statutory_rates WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  return (res as any).rowCount > 0;
}

/**
 * Seed the commonly-cited Malawi defaults for a company. These are examples
 * only; the UI/API must allow them to be edited per effective date.
 */
export async function seedDefaultMalawiConfig(
  tx: Transaction,
  companyId: number,
  effectiveFrom = '2024-04-01'
): Promise<void> {
  const existing = await tx.query(
    `SELECT 1 FROM payroll_paye_bands WHERE company_id = $1 LIMIT 1`,
    [companyId]
  );
  if (existing.rows.length > 0) return;

  const bands = [
    { lower: 0, upper: 1170000, rate: 0 },
    { lower: 1170000, upper: 2340000, rate: 0.15 },
    { lower: 2340000, upper: null, rate: 0.3 },
  ];
  for (const b of bands) {
    await createPayeBand(tx, companyId, {
      lowerBound: b.lower,
      upperBound: b.upper,
      rate: b.rate,
      effectiveFrom,
    });
  }
  await createStatutoryRate(tx, companyId, {
    rateType: 'pension_employee',
    rate: 0.05,
    effectiveFrom,
  });
  await createStatutoryRate(tx, companyId, {
    rateType: 'pension_employer',
    rate: 0.1,
    effectiveFrom,
  });
}