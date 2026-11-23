import fs from 'node:fs';
import path from 'node:path';
import { PGlite, Transaction } from '@electric-sql/pglite';
import { migrateUp, SqlExecutor } from '../../db/migrator.ts';
import { ServerConfig } from './config.ts';
import { CompanyRole } from './permissions.ts';
import { hashPassword } from './supabaseAuth.ts';
import { writeAuditLog } from './audit.ts';
import { postJournalEntry, postOpeningBalances } from './services/accountingEngine.ts';
import {
  activatePrintingContract,
  createExamBatch,
  createPrintingContract,
  fundContractFromWallet,
  recordContractAcceptance,
  requestContractActivation,
} from './services/printingRecordsService.ts';
import { recordWalletDeposit } from './services/customerWalletService.ts';
import { seedDefaultMalawiConfig } from './services/malawiPayroll.ts';

export interface ServerDatabase {
  pg: PGlite;
  config: ServerConfig;
  withSystemDb<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  withCompanyDb<T>(companyId: number, fn: (tx: Transaction) => Promise<T>): Promise<T>;
  createCompanyWithDefaults(params: {
    name: string;
    legalName?: string;
    ein?: string;
    currencySymbol?: string;
    baseCurrency?: string;
    fiscalYearStartMonth?: number;
    accountingMethod?: 'accrual' | 'cash';
    ownerUserId: number;
    ownerUsername: string;
    makeDefault?: boolean;
  }): Promise<{ companyId: number; membershipId: number; slug: string }>;
  close(): Promise<void>;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'company';
}

async function seedDefaultCoa(tx: SqlExecutor, companyId: number): Promise<Record<string, number>> {
  const res = await tx.query<{ id: number; code: string }>(
    `INSERT INTO accounts (
       company_id, code, name, account_type, detail_type, bank_kind,
       normal_balance, is_system, is_control, is_contra, balance
     )
     VALUES
       ($1, '1010', 'Operating Checking', 'Bank', 'bank', 'bank', 'debit', true, true, false, 0.0000),
       ($1, '1100', 'Accounts Receivable', 'AccountsReceivable', 'accounts_receivable', NULL, 'debit', true, true, false, 0.0000),
       ($1, '1200', 'Inventory Asset', 'Inventory', 'other_current_asset', NULL, 'debit', true, true, false, 0.0000),
       ($1, '1500', 'Printing Presses & Equipment', 'FixedAsset', 'fixed_asset', NULL, 'debit', true, false, false, 0.0000),
       ($1, '1590', 'Accumulated Depreciation', 'FixedAsset', 'fixed_asset', NULL, 'credit', true, false, true, 0.0000),
       ($1, '2000', 'Accounts Payable', 'AccountsPayable', 'accounts_payable', NULL, 'credit', true, true, false, 0.0000),
       ($1, '2050', 'Corporate Press Card', 'CreditCard', 'credit_card', 'credit_card', 'credit', true, false, false, 0.0000),
       ($1, '2100', 'Payroll Liabilities', 'PayrollLiability', 'payroll_liabilities', NULL, 'credit', true, false, false, 0.0000),
       ($1, '2200', 'Sales Tax Payable', 'OtherCurrentLiability', 'other_current_liability', NULL, 'credit', true, true, false, 0.0000),
       ($1, '2300', 'Unearned Contract Retainers', 'OtherCurrentLiability', 'other_current_liability', NULL, 'credit', true, true, false, 0.0000),
       ($1, '2500', 'Equipment Financing Loan', 'LongTermLiability', 'long_term_liability', NULL, 'credit', true, false, false, 0.0000),
       ($1, '3000', 'Owner Capital & Equity', 'Equity', 'equity', NULL, 'credit', true, false, false, 0.0000),
       ($1, '3200', 'Retained Earnings', 'Equity', 'equity', NULL, 'credit', true, true, false, 0.0000),
       ($1, '3900', 'Opening Balance Equity', 'Equity', 'equity', NULL, 'credit', true, true, false, 0.0000),
       ($1, '4000', 'Printing & Sales Revenue', 'Income', 'income', NULL, 'credit', true, true, false, 0.0000),
       ($1, '4900', 'Other Miscellaneous Income', 'Income', 'other_income', NULL, 'credit', true, false, false, 0.0000),
       ($1, '5000', 'Cost of Goods Sold', 'CostOfGoodsSold', 'cost_of_goods_sold', NULL, 'debit', true, true, false, 0.0000),
       ($1, '6100', 'Payroll Expenses', 'Expense', 'expense', NULL, 'debit', true, false, false, 0.0000),
       ($1, '6200', 'Rent & Utilities Expense', 'Expense', 'expense', NULL, 'debit', true, false, false, 0.0000),
       ($1, '6300', 'Depreciation & Press Wear', 'Expense', 'expense', NULL, 'debit', true, false, false, 0.0000),
       ($1, '6810', 'Bank Charges & Fees', 'Expense', 'expense', NULL, 'debit', true, false, false, 0.0000),
       ($1, '6900', 'Other Non-Operating Expense', 'OtherExpense', 'other_expense', NULL, 'debit', true, false, false, 0.0000)
     RETURNING id, code`,
    [companyId]
  );
  const map: Record<string, number> = {};
  for (const r of res.rows) map[r.code] = Number(r.id);
  return map;
}

export async function createCompanyInTx(
  tx: SqlExecutor,
  params: {
    name: string;
    legalName?: string;
    ein?: string;
    currencySymbol?: string;
    baseCurrency?: string;
    fiscalYearStartMonth?: number;
    accountingMethod?: 'accrual' | 'cash';
    ownerUserId: number;
    ownerUsername: string;
    makeDefault?: boolean;
  }
): Promise<{ companyId: number; membershipId: number; slug: string; accountsByCode: Record<string, number> }> {
  await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);

  const baseSlug = slugify(params.name);
  let slug = baseSlug;
  for (let i = 1; i <= 50; i++) {
    const existing = await tx.query<{ id: number }>(`SELECT id FROM companies WHERE slug = $1`, [slug]);
    if (existing.rows.length === 0) break;
    slug = `${baseSlug}-${i + 1}`;
  }

  const compRes = await tx.query<{ id: number }>(
    `INSERT INTO companies (
       slug, name, legal_name, tax_id_ein, base_currency, currency_symbol,
       fiscal_year_start_month, accounting_method
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      slug,
      params.name.trim(),
      (params.legalName || params.name).trim(),
      params.ein || 'TPIN-000000',
      params.baseCurrency || 'ZMW',
      params.currencySymbol || 'K',
      params.fiscalYearStartMonth ?? 1,
      params.accountingMethod || 'accrual',
    ]
  );
  const companyId = Number(compRes.rows[0].id);

  if (params.makeDefault) {
    await tx.query(`UPDATE company_memberships SET is_default = FALSE WHERE user_id = $1`, [params.ownerUserId]);
  }

  const memRes = await tx.query<{ id: number }>(
    `INSERT INTO company_memberships (company_id, user_id, role, is_default, is_active, invited_by)
     VALUES ($1, $2, 'Administrator', $3, TRUE, $2)
     RETURNING id`,
    [companyId, params.ownerUserId, Boolean(params.makeDefault)]
  );
  const membershipId = Number(memRes.rows[0].id);

  const accountsByCode = await seedDefaultCoa(tx, companyId);

  // Seed default payment terms & linked bank/card registers for every new company
  await tx.query(
    `INSERT INTO payment_terms (company_id, name, kind, net_days)
     VALUES
       ($1, 'Due on Receipt', 'standard', 0),
       ($1, 'Net 15', 'standard', 15),
       ($1, 'Net 30', 'standard', 30),
       ($1, 'Net 60', 'standard', 60)
     ON CONFLICT DO NOTHING`,
    [companyId]
  );

  if (accountsByCode['1010']) {
    await tx.query(
      `INSERT INTO bank_accounts (company_id, gl_account_id, institution_name, account_mask, feed_provider, next_check_number)
       VALUES ($1, $2, 'Zanaco Business Banking', '4410', 'manual', 4411)
       ON CONFLICT DO NOTHING`,
      [companyId, accountsByCode['1010']]
    );
  }
  if (accountsByCode['2050']) {
    await tx.query(
      `INSERT INTO bank_accounts (company_id, gl_account_id, institution_name, account_mask, feed_provider, next_check_number)
       VALUES ($1, $2, 'Stanbic Corporate Card', '8821', 'manual', 1001)
       ON CONFLICT DO NOTHING`,
      [companyId, accountsByCode['2050']]
    );
  }

  await writeAuditLog(tx, {
    companyId,
    actorUserId: params.ownerUserId,
    actorUsername: params.ownerUsername,
    action: 'COMPANY_CREATED',
    tableName: 'companies',
    recordId: companyId,
    newValues: { slug, name: params.name.trim(), ownerRole: 'Administrator' },
    changedFields: ['name', 'slug'],
  });

  return { companyId, membershipId, slug, accountsByCode };
}

async function seedDemoWorkspaceIfEmpty(db: ServerDatabase): Promise<void> {
  const existingUsers = await db.withSystemDb(async tx => {
    const res = await tx.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM users`);
    return Number(res.rows[0].cnt);
  });
  if (existingUsers > 0) return;

  await db.withSystemDb(async tx => {
    await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);

    // Create default operational demo users (Administrator + multi-role team)
    const demoPassHash = hashPassword('PrintingAdmin#2026');
    const uAdmin = await tx.query<{ id: number }>(
      `INSERT INTO users (username, email, display_name, password_hash, is_active)
       VALUES ('admin', 'admin@primepress.zm', 'Chanda Mwansa (Director)', $1, TRUE)
       RETURNING id`,
      [demoPassHash]
    );
    const adminId = Number(uAdmin.rows[0].id);

    const uBookkeeper = await tx.query<{ id: number }>(
      `INSERT INTO users (username, email, display_name, password_hash, is_active)
       VALUES ('bookkeeper', 'books@primepress.zm', 'Mutale Banda (Bookkeeper)', $1, TRUE)
       RETURNING id`,
      [demoPassHash]
    );
    const bookkeeperId = Number(uBookkeeper.rows[0].id);

    const uAccountant = await tx.query<{ id: number }>(
      `INSERT INTO users (username, email, display_name, password_hash, is_active)
       VALUES ('accountant', 'audit@primepress.zm', 'Kabwe Phiri (CPA)', $1, TRUE)
       RETURNING id`,
      [demoPassHash]
    );
    const accountantId = Number(uAccountant.rows[0].id);

    const uProd = await tx.query<{ id: number }>(
      `INSERT INTO users (username, email, display_name, password_hash, is_active)
       VALUES ('production', 'press@primepress.zm', 'Thandiwe Lungu (Press Lead)', $1, TRUE)
       RETURNING id`,
      [demoPassHash]
    );
    const prodId = Number(uProd.rows[0].id);

    // Company A: Prime Educational Press Ltd
    const compA = await createCompanyInTx(tx, {
      name: 'Prime Educational Press Ltd',
      legalName: 'Prime Educational Press Limited',
      ein: 'TPIN-1004829104',
      ownerUserId: adminId,
      ownerUsername: 'admin',
      makeDefault: true,
    });

    // Grant Company A memberships across roles
    const grantsA: Array<[number, CompanyRole]> = [
      [bookkeeperId, 'Bookkeeper'],
      [accountantId, 'Accountant'],
      [prodId, 'ProductionManager'],
    ];
    for (const [uid, role] of grantsA) {
      await tx.query(
        `INSERT INTO company_memberships (company_id, user_id, role, is_default, is_active, invited_by)
         VALUES ($1, $2, $3, TRUE, TRUE, $4)`,
        [compA.companyId, uid, role, adminId]
      );
    }

    // Company B: Copperbelt Printers & Stationery (Isolated second company)
    const compB = await createCompanyInTx(tx, {
      name: 'Copperbelt Printers & Stationery',
      legalName: 'Copperbelt Printers & Stationery Ltd',
      ein: 'TPIN-2009914451',
      ownerUserId: adminId,
      ownerUsername: 'admin',
      makeDefault: false,
    });

    // Default Malawi statutory configuration (editable per effective date).
    await seedDefaultMalawiConfig(tx, compA.companyId);
    await seedDefaultMalawiConfig(tx, compB.companyId);

    // Seed isolated data in Company A
    const custA = await tx.query<{ id: number }>(
      `INSERT INTO customers (company_id, customer_code, customer_type, name, company_name, email, balance)
       VALUES ($1, 'CUST-000001', 'school', 'Lusaka Boys Secondary', 'Lusaka Boys Secondary School', 'bursar@lbs.edu.zm', 5400.0000)
       RETURNING id`,
      [compA.companyId]
    );
    const custAId = Number(custA.rows[0].id);

    const invARes = await tx.query<{ id: number }>(
      `INSERT INTO invoices (
         company_id, invoice_number, customer_id, invoice_date, due_date, status,
         subtotal, tax_rate, tax_amount, total, total_cost, amount_paid, balance_due
       ) VALUES (
         $1, 'INV-PEP-1001', $2, '2026-11-01', '2026-12-01', 'sent',
         5400.0000, 0.000000, 0.0000, 5400.0000, 2150.0000, 0.0000, 5400.0000
       ) RETURNING id`,
      [compA.companyId, custAId]
    );

    const estA = await tx.query<{ id: number }>(
      `INSERT INTO estimates (
         company_id, estimate_number, customer_id, estimate_date, expiry_date,
         status, subtotal, tax_rate, tax_amount, total, total_cost, notes
       ) VALUES (
         $1, 'EST-PEP-301', $2, '2026-11-10', '2026-12-10',
         'pending', 3600.0000, 0.000000, 0.0000, 3600.0000, 1420.0000,
         'Grade 12 Mock Examination Batch'
       ) RETURNING id`,
      [compA.companyId, custAId]
    );
    await tx.query(
      `INSERT INTO estimate_lines (company_id, estimate_id, line_order, description, quantity, unit_cost, rate, amount)
       VALUES ($1, $2, 1, 'Printed Exam Booklets (120 learners)', 120.000000, 11.833333, 30.0000, 3600.0000)`,
      [compA.companyId, Number(estA.rows[0].id)]
    );

    await tx.query(
      `INSERT INTO inventory_items (
         company_id, sku, name, item_type, description, unit_cost, sales_price, on_hand, reorder_point,
         purchase_unit, usage_unit, conversion_factor, asset_account_id, cogs_account_id, income_account_id
       ) VALUES
         ($1, 'RM-A4-80G', 'A4 80gsm White Bond Paper', 'raw_material', 'Internal press paper ream', 145.000000, 0.0000, 120.000000, 25.000000, 'Ream', 'Sheet', 500.000000, $2, $3, $4),
         ($1, 'RM-TONER-K', 'Kyocera TK-1124 Toner Cartridge', 'raw_material', 'Black toner cartridge for press', 320.000000, 0.0000, 40.000000, 8.000000, 'Cartridge', 'Impression', 10000.000000, $2, $3, $4),
         ($1, 'PP-EXBOOK-A4', 'Custom School Exercise Book', 'printed_product', 'Non-stocked BOM printed item', 6.400000, 14.0000, 0.000000, 0.000000, 'Book', 'Book', 1.000000, $2, $3, $4),
         ($1, 'ST-PEN-BOX', 'Blue Ballpoint Pen Box (12s)', 'stationery', 'Stocked retail stationery', 18.000000, 32.0000, 48.000000, 10.000000, 'Box', 'Box', 1.000000, $2, $3, $4),
         ($1, 'PS-DUPLEX-EXAM', 'Duplex Exam Printing Service', 'printing_service', 'Automated duplex press service', 0.390000, 1.2500, 0.000000, 0.000000, 'Page', 'Page', 1.000000, $2, $3, $4)`,
      [compA.companyId, compA.accountsByCode['1200'], compA.accountsByCode['5000'], compA.accountsByCode['4000']]
    );

    const paperItemRes = await tx.query<{ id: number }>(
      `SELECT id FROM inventory_items WHERE company_id = $1 AND sku = 'RM-A4-80G'`,
      [compA.companyId]
    );
    const tonerItemRes = await tx.query<{ id: number }>(
      `SELECT id FROM inventory_items WHERE company_id = $1 AND sku = 'RM-TONER-K'`,
      [compA.companyId]
    );
    const seedPaperItemId = paperItemRes.rows[0] ? Number(paperItemRes.rows[0].id) : 0;
    const seedTonerItemId = tonerItemRes.rows[0] ? Number(tonerItemRes.rows[0].id) : 0;

    await tx.query(
      `INSERT INTO employees (
         company_id, first_name, last_name, job_title, department, email,
         ssn_last4_masked, hire_date, pay_type, pay_rate, pay_frequency
       ) VALUES (
         $1, 'Bwalya', 'Tembo', 'Senior Offset Press Operator', 'Press Floor', 'bwalya@primepress.zm',
         '***-**-4812', '2024-03-01', 'salary', 12500.0000, 'monthly'
       )`,
      [compA.companyId]
    );

    // Post reconciled Double-Entry Journal foundation entries for Company A
    const adminActor = { userId: adminId, username: 'admin', role: 'Administrator' as const };
    const accountantActor = { userId: accountantId, username: 'accountant', role: 'Accountant' as const };
    const acA = compA.accountsByCode;

    await postOpeningBalances(tx, compA.companyId, adminActor, {
      txnDate: '2026-01-01',
      description: 'FY 2026 Opening Balances — Prime Educational Press Ltd',
      reference: 'OB-2026',
      autoBalanceAccountId: acA['3900'],
      idempotencyKey: 'seed-ob-comp-a',
      lines: [
        { accountId: acA['1010'], amount: '85000.0000' },
        { accountId: acA['1200'], amount: '18264.0000' },
        { accountId: acA['1500'], amount: '140000.0000' },
        { accountId: acA['1590'], amount: '-24000.0000' },
        { accountId: acA['2500'], amount: '45000.0000' },
        { accountId: acA['3000'], amount: '174264.0000' },
      ],
    });

    await postJournalEntry(tx, compA.companyId, adminActor, {
      txnDate: '2026-11-01',
      description: 'Invoice INV-PEP-1001 — Lusaka Boys Secondary School',
      reference: 'INV-PEP-1001',
      sourceType: 'invoice',
      sourceId: Number(invARes.rows[0].id),
      idempotencyKey: 'seed-inv-pep-1001',
      lines: [
        { accountId: acA['1100'], debit: '5400.0000', credit: '0.0000', description: 'Accounts Receivable — INV-PEP-1001' },
        { accountId: acA['4000'], debit: '0.0000', credit: '5400.0000', description: 'Exam & exercise book printing revenue' },
        { accountId: acA['5000'], debit: '2150.0000', credit: '0.0000', description: 'Production paper & toner COGS' },
        { accountId: acA['1200'], debit: '0.0000', credit: '2150.0000', description: 'Raw materials issued from inventory' },
      ],
    });

    const utilJe = await postJournalEntry(tx, compA.companyId, adminActor, {
      txnDate: '2026-11-05',
      description: 'Press Floor Electricity & Utilities — ZESCO',
      reference: 'CHK-4410',
      sourceType: 'check',
      idempotencyKey: 'seed-util-comp-a',
      lines: [
        { accountId: acA['6200'], debit: '1850.0000', credit: '0.0000', description: 'Three-phase press floor power' },
        { accountId: acA['1010'], debit: '0.0000', credit: '1850.0000', description: 'Paid via Operating Checking' },
      ],
    });

    // Seed a prepaid printing contract + examination batch for Company A so the
    // Printing Contracts and Examination modules load and round-trip through the
    // backend instead of relying only on bundled demo state.
    //
    // The seed exercises the full lifecycle — draft, wallet-funded, accepted,
    // approved, activated — because activation is only reachable that way (D-1).
    if (seedPaperItemId && seedTonerItemId) {
      // The wallet service requires a credit-normal wallet liability account
      // (default code 2310). Ensure it exists before any wallet movement.
      await tx.query(
        `INSERT INTO accounts (company_id, code, name, account_type, detail_type, normal_balance, is_active)
         SELECT $1, '2310', 'Customer Wallet Funds', 'OtherCurrentLiability',
                'other_current_liability', 'credit', TRUE
          WHERE NOT EXISTS (
            SELECT 1 FROM accounts WHERE company_id = $1 AND code = '2310'
          )`,
        [compA.companyId]
      );

      const draft = await createPrintingContract(tx, compA.companyId, adminActor, {
        schoolCustomerId: custAId,
        title: 'Grade 12 Mock & Final Examination Retainer',
        academicYear: '2026',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        totalPrepaidAmount: '3000.0000',
        totalAssessments: 3,
        depositBankAccountId: acA['1010'],
        notes: 'Annual school examination printing retainer (3 assessments)',
        assessments: [
          { assessmentNumber: 1, label: 'Term 1 Mock', scheduledDate: '2026-03-15', agreedAmount: '1000.0000', rawPaperItemId: seedPaperItemId, rawTonerItemId: seedTonerItemId, estimatedSheets: '5000.000000', estimatedImpressions: '10000.000000', paperCost: '450.0000', tonerCost: '120.0000' },
          { assessmentNumber: 2, label: 'Mid-Year Mock', scheduledDate: '2026-07-15', agreedAmount: '1000.0000', rawPaperItemId: seedPaperItemId, rawTonerItemId: seedTonerItemId, estimatedSheets: '5000.000000', estimatedImpressions: '10000.000000', paperCost: '450.0000', tonerCost: '120.0000' },
          { assessmentNumber: 3, label: 'Final Examination', scheduledDate: '2026-11-15', agreedAmount: '1000.0000', rawPaperItemId: seedPaperItemId, rawTonerItemId: seedTonerItemId, estimatedSheets: '5000.000000', estimatedImpressions: '10000.000000', paperCost: '450.0000', tonerCost: '120.0000' },
        ],
      });

      // 1. Cash into the customer wallet (Dr Bank / Cr Wallet liability).
      await recordWalletDeposit(tx, compA.companyId, adminActor, {
        customerId: custAId,
        amount: '3000.0000',
        bankAccountId: acA['1010'],
        txnDate: '2026-01-05',
        referenceNumber: 'SEED-WLT-DEP-1',
        memo: 'Retainer deposit — Grade 12 Mock & Final Examination Retainer',
        idempotencyKey: 'seed-wallet-deposit-contract-a',
      });

      // 2. Allocate the wallet to the contract (contract remains a draft).
      await fundContractFromWallet(tx, compA.companyId, adminActor, draft.contractId, {
        idempotencyKey: 'seed-contract-fund-a',
        notes: 'Seed retainer funding',
      });

      // 3. Record customer acceptance.
      await recordContractAcceptance(tx, compA.companyId, adminActor, draft.contractId, {
        method: 'drawn',
        signerName: 'Seeded School Administrator',
        documentVersion: 'v1',
        outcome: 'accepted',
      });

      // 4. Create and approve the activation request.
      const activationRequest = await requestContractActivation(tx, compA.companyId, adminActor, draft.contractId, {
        reason: 'Seed contract activation',
        amount: '3000.0000',
      });

      await tx.query(
        `UPDATE approval_requests
            SET status = 'approved', decided_by = $2, decided_at = NOW(),
                decision_note = 'Approved during seed'
          WHERE company_id = $1 AND id = $2 AND status = 'pending'`,
        [compA.companyId, activationRequest.requestId]
      );

      // 5. Activate — now reachable because funding, acceptance and approval exist.
      await activatePrintingContract(tx, compA.companyId, adminActor, draft.contractId);

      await createExamBatch(tx, compA.companyId, adminActor, {
        schoolCustomerId: custAId,
        assessmentName: 'Grade 12 Mock Examination',
        className: 'Grade 12',
        learnersCount: 120,
        pricePerLearner: '30.0000',
        contractId: draft.contractId,
        assessmentNumber: 1,
        papers: [
          { subjectName: 'Mathematics', pages: 8, copies: 120, rawPaperItemId: seedPaperItemId, rawTonerItemId: seedTonerItemId, printSide: 'Duplex', bindingType: 'Stapled', sheetsUsed: '480.000000', impressionsUsed: '960.000000', paperCost: '43.2000', tonerCost: '9.6000', productionDate: '2026-03-10', notes: 'Seed batch' },
          { subjectName: 'English', pages: 6, copies: 120, rawPaperItemId: seedPaperItemId, rawTonerItemId: seedTonerItemId, printSide: 'Duplex', bindingType: 'Stapled', sheetsUsed: '360.000000', impressionsUsed: '720.000000', paperCost: '32.4000', tonerCost: '7.2000', productionDate: '2026-03-10', notes: 'Seed batch' },
        ],
      });
    }

    // Mirror seeded check & vendor/template commercial defaults in Company A
    const bank1010Res = await tx.query<{ id: number }>(
      `SELECT id FROM bank_accounts WHERE company_id = $1 AND gl_account_id = $2 LIMIT 1`,
      [compA.companyId, acA['1010']]
    );
    const bank1010Id = bank1010Res.rows[0] ? Number(bank1010Res.rows[0].id) : null;
    await tx.query(
      `INSERT INTO bank_transactions (
         company_id, account_id, bank_account_id, txn_date, payee, txn_type,
         ref_number, memo, amount, is_cleared, status, offset_account_id, journal_txn_id, category
       ) VALUES (
         $1, $2, $3, '2026-11-05', 'ZESCO Commercial Power', 'Check',
         'CHK-4410', 'Three-phase press floor power', -1850.0000, FALSE, 'posted', $4, $5, 'Rent & Utilities Expense'
       )`,
      [compA.companyId, acA['1010'], bank1010Id, acA['6200'], utilJe.transaction.id]
    );

    await tx.query(
      `INSERT INTO vendors (
         company_id, name, company_name, email, phone, address, ein_or_ssn,
         is_1099_eligible, default_expense_account_id, terms_label, balance
       ) VALUES (
         $1, 'Zambia Paper Mills Ltd', 'Zambia Paper Mills Limited', 'orders@zambiapaper.zm',
         '+260 211 550120', 'Plot 44 Industrial Rd, Lusaka', 'TPIN-3008812241',
         FALSE, $2, 'Net 30', 0.0000
       )`,
      [compA.companyId, acA['1200']]
    );

    await tx.query(
      `INSERT INTO email_templates (company_id, kind, subject, body, is_default)
       VALUES
         ($1, 'invoice', 'Invoice {{invoiceNumber}} from Prime Educational Press', 'Dear {{customerName}},\n\nPlease find attached invoice {{invoiceNumber}} totaling {{total}} due on {{dueDate}}.', TRUE),
         ($1, 'statement', 'Account Statement for {{customerName}}', 'Dear {{customerName}},\n\nAttached is your current statement of account showing open balance {{balance}}.', TRUE)`,
      [compA.companyId]
    );

    await tx.query(
      `INSERT INTO invoice_reminder_rules (company_id, days_from_due, enabled, subject, body)
       VALUES ($1, 7, TRUE, 'Overdue Invoice Reminder: {{invoiceNumber}}', 'This is a friendly reminder that invoice {{invoiceNumber}} is 7 days past due.')`,
      [compA.companyId]
    );

    await tx.query(
      `INSERT INTO tax_category_mappings (company_id, account_id, tax_line)
       VALUES
         ($1, $2, 'ZRA VAT Output Tax (Standard 16%)'),
         ($1, $3, 'Gross Printing & Stationery Sales')`,
      [compA.companyId, acA['2200'], acA['4000']]
    );

    await postJournalEntry(tx, compA.companyId, accountantActor, {
      txnDate: '2026-11-10',
      description: 'Monthly Offset Press Depreciation Adjustment',
      reference: 'ADJ-2026-11',
      sourceType: 'depreciation',
      isAdjusting: true,
      idempotencyKey: 'seed-depr-comp-a',
      lines: [
        { accountId: acA['6300'], debit: '1200.0000', credit: '0.0000', description: 'Monthly press equipment depreciation' },
        { accountId: acA['1590'], debit: '0.0000', credit: '1200.0000', description: 'Accumulated depreciation — presses' },
      ],
    });

    // Seed isolated data in Company B (strictly invisible to Company A sessions!)
    const custB = await tx.query<{ id: number }>(
      `INSERT INTO customers (company_id, customer_code, customer_type, name, company_name, email, balance)
       VALUES ($1, 'CUST-000002', 'corporate', 'Ndola Mining Supplies', 'Ndola Mining Supplies Ltd', 'ap@ndolamining.zm', 9800.0000)
       RETURNING id`,
      [compB.companyId]
    );
    const invBRes = await tx.query<{ id: number }>(
      `INSERT INTO invoices (
         company_id, invoice_number, customer_id, invoice_date, due_date, status,
         subtotal, tax_rate, tax_amount, total, total_cost, amount_paid, balance_due
       ) VALUES (
         $1, 'INV-CB-9001', $2, '2026-11-02', '2026-12-02', 'sent',
         9800.0000, 0.000000, 0.0000, 9800.0000, 4100.0000, 0.0000, 9800.0000
       ) RETURNING id`,
      [compB.companyId, Number(custB.rows[0].id)]
    );
    await tx.query(
      `INSERT INTO inventory_items (
         company_id, sku, name, item_type, description, unit_cost, sales_price, on_hand, reorder_point,
         purchase_unit, usage_unit, conversion_factor, asset_account_id, cogs_account_id, income_account_id
       ) VALUES (
         $1, 'CB-NCR-A4', 'Carbonless NCR Receipt Pads', 'printed_product', 'Company B exclusive book', 22.000000, 45.0000, 0.000000, 0.000000,
         'Pad', 'Pad', 1.000000, $2, $3, $4
       )`,
      [compB.companyId, compB.accountsByCode['1200'], compB.accountsByCode['5000'], compB.accountsByCode['4000']]
    );

    const acB = compB.accountsByCode;
    await postOpeningBalances(tx, compB.companyId, adminActor, {
      txnDate: '2026-01-01',
      description: 'FY 2026 Opening Balances — Copperbelt Printers',
      reference: 'OB-CB-2026',
      autoBalanceAccountId: acB['3900'],
      idempotencyKey: 'seed-ob-comp-b',
      lines: [
        { accountId: acB['1010'], amount: '42000.0000' },
        { accountId: acB['3000'], amount: '42000.0000' },
      ],
    });
    await postJournalEntry(tx, compB.companyId, adminActor, {
      txnDate: '2026-11-02',
      description: 'Invoice INV-CB-9001 — Ndola Mining Supplies',
      reference: 'INV-CB-9001',
      sourceType: 'invoice',
      sourceId: Number(invBRes.rows[0].id),
      idempotencyKey: 'seed-inv-cb-9001',
      lines: [
        { accountId: acB['1100'], debit: '9800.0000', credit: '0.0000' },
        { accountId: acB['4000'], debit: '0.0000', credit: '9800.0000' },
      ],
    });
  });
}

export async function createServerDatabase(
  config: ServerConfig,
  options: { inMemory?: boolean; seedDemo?: boolean } = {}
): Promise<ServerDatabase> {
  let pg: PGlite;
  if (options.inMemory) {
    pg = new PGlite();
  } else {
    fs.mkdirSync(config.dbDataDir, { recursive: true });
    pg = new PGlite(config.dbDataDir);
  }

  await migrateUp(pg);

  const db: ServerDatabase = {
    pg,
    config,
    async withSystemDb<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      return pg.transaction(async tx => {
        await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);
        return fn(tx);
      });
    },
    async withCompanyDb<T>(companyId: number, fn: (tx: Transaction) => Promise<T>): Promise<T> {
      if (!Number.isInteger(companyId) || companyId <= 0) {
        throw new Error('Invalid companyId for scoped transaction');
      }
      return pg.transaction(async tx => {
        await tx.exec(`SET LOCAL ROLE pms_app_role;`);
        await tx.exec(`SELECT set_config('app.bypass_rls', 'off', true);`);
        await tx.query(`SELECT set_config('app.current_company_id', $1, true)`, [String(companyId)]);
        return fn(tx);
      });
    },
    async createCompanyWithDefaults(params) {
      return pg.transaction(async tx => {
        const res = await createCompanyInTx(tx, params);
        return { companyId: res.companyId, membershipId: res.membershipId, slug: res.slug };
      });
    },
    async close() {
      await pg.close();
    },
  };

  if (options.seedDemo !== false) {
    await seedDemoWorkspaceIfEmpty(db);
  }

  // Ensure attachments directory exists cleanly
  if (!options.inMemory) {
    fs.mkdirSync(path.resolve(config.attachmentsDir), { recursive: true });
  }

  return db;
}



