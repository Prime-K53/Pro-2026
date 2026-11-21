#!/usr/bin/env node
/**
 * Printing Contract Gap Closure — Preflight Validation (WP-D2)
 *
 * Validates legacy data before enabling the assessment-sum constraint trigger
 * (G-07). Reports any contracts where the assessment schedule does not sum to
 * the prepaid total.
 *
 * Exit codes:
 *   0 = no mismatches (safe to enable constraint)
 *   1 = mismatches found (quarantine required before enabling constraint)
 *
 * Usage:
 *   node scripts/printing-contract-preflight.ts [options]
 *
 * Options:
 *   --company-id <id>  Check only this company (default: all companies)
 *   --json             Output JSON instead of human-readable
 */

import { createServerDatabase } from '../src/server/db.ts';

interface CompanyDb {
  withSystemDb<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  withCompanyDb<T>(companyId: number, fn: (tx: any) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface Mismatch {
  company_id: number;
  company_name: string;
  contract_id: number;
  contract_number: string;
  total_prepaid_amount: string;
  assessment_sum: string;
  difference: string;
}

function formatMoney(value: string | number | null): string {
  if (value == null) return '0.0000';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return num.toFixed(4);
}

async function checkMismatches(
  db: CompanyDb,
  companyId?: number
): Promise<Mismatch[]> {
  const results: Mismatch[] = [];

  const companies = await db.withSystemDb(async (tx: any) => {
    if (companyId != null) {
      const r = await tx.query(
        `SELECT id, name FROM companies WHERE id = $1`,
        [companyId]
      );
      return r.rows;
    }
    const r = await tx.query(`SELECT id, name FROM companies ORDER BY id`);
    return r.rows;
  });

  for (const company of companies) {
    const mismatches = await db.withCompanyDb(company.id, async (tx: any) => {
      const r = await tx.query(
        `SELECT
           c.id AS contract_id,
           c.contract_number,
           c.total_prepaid_amount::TEXT AS total_prepaid_amount,
           COALESCE(SUM(m.agreed_amount), 0)::TEXT AS assessment_sum,
           (c.total_prepaid_amount - COALESCE(SUM(m.agreed_amount), 0))::TEXT AS difference
         FROM printing_contracts c
         LEFT JOIN contract_assessment_milestones m
           ON m.company_id = c.company_id AND m.contract_id = c.id
         WHERE c.status IN ('draft', 'active', 'suspended', 'completed')
         GROUP BY c.id, c.contract_number, c.total_prepaid_amount
         HAVING ABS(c.total_prepaid_amount - COALESCE(SUM(m.agreed_amount), 0)) > 0.0001
         ORDER BY c.id`
      );

      return r.rows.map((row: any) => ({
        company_id: company.id,
        company_name: company.name,
        contract_id: Number(row.contract_id),
        contract_number: row.contract_number,
        total_prepaid_amount: row.total_prepaid_amount,
        assessment_sum: row.assessment_sum,
        difference: row.difference,
      }));
    });

    results.push(...mismatches);
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const companyIdArg = args.find((a) => a.startsWith('--company-id'));
  const companyId = companyIdArg
    ? parseInt(companyIdArg.split('=')[1] || args[args.indexOf(companyIdArg) + 1], 10)
    : undefined;

  if (companyId != null && isNaN(companyId)) {
    console.error('Invalid --company-id value');
    process.exit(1);
  }

  const cfg = {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    jwtSecret: process.env.JWT_SECRET || 'default-secret',
    isProduction: process.env.NODE_ENV === 'production',
    nodeEnv: process.env.NODE_ENV || 'development',
    dbDataDir: process.env.DB_DATA_DIR || './data',
    attachmentsDir: process.env.ATTACHMENTS_DIR || './attachments',
  };

  let db: CompanyDb | null = null;

  try {
    db = await createServerDatabase(cfg as any, { inMemory: false }) as CompanyDb;

    const mismatches = await checkMismatches(db, companyId);

    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            success: mismatches.length === 0,
            checked_companies: companyId ? 1 : undefined,
            mismatches,
            total_mismatches: mismatches.length,
          },
          null,
          2
        )
      );
    } else {
      if (mismatches.length === 0) {
        console.log('✓ No assessment-sum mismatches found.');
        console.log('  Safe to enable the contract assessment-sum constraint trigger (G-07).');
      } else {
        console.error(`✗ Found ${mismatches.length} contract(s) with assessment-sum mismatches:\n`);
        for (const m of mismatches) {
          console.error(`  Company ${m.company_id} (${m.company_name}):`);
          console.error(`    Contract ${m.contract_number} (ID: ${m.contract_id})`);
          console.error(`    Prepaid: ${formatMoney(m.total_prepaid_amount)}`);
          console.error(`    Assessment sum: ${formatMoney(m.assessment_sum)}`);
          console.error(`    Difference: ${formatMoney(m.difference)}\n`);
        }
        console.error('Action required:');
        console.error('  1. Review each contract and determine if it should be:');
        console.error('     a) Corrected (update assessments or prepaid amount)');
        console.error('     b) Quarantined (excluded from validation)');
        console.error('     c) Cancelled (if invalid)');
        console.error('  2. Re-run this script to verify all mismatches are resolved.');
        console.error('  3. Only then enable the constraint trigger.');
      }
    }

    process.exit(mismatches.length === 0 ? 0 : 1);
  } catch (err) {
    console.error('Preflight check failed:', err);
    process.exit(1);
  } finally {
    if (db) {
      await db.close();
    }
  }
}

main();