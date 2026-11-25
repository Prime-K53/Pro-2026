import crypto from 'node:crypto';
import path from 'node:path';
import { Transaction } from '@electric-sql/pglite';
import { ServerDatabase } from '../db.ts';
import { writeAuditLog } from '../audit.ts';
import { CompanyRole, isValidCompanyRole } from '../permissions.ts';
import { hashPassword } from '../supabaseAuth.ts';
import {
  AccountingError,
  AccountType,
  ActorContext,
  ALL_ACCOUNT_TYPES,
  JournalSourceType,
  normalBalanceFor,
  rebuildStoredBalances,
  reverseJournalEntry,
} from './accountingEngine.ts';
import {
  absBigInt,
  formatDecimal4,
  parseDecimal4,
} from '../lib/decimal.ts';
import {
  formatDecimal6,
  parseDecimal6,
  recalculateCustomerBalance,
  recalculateVendorBalance,
} from './commercialHelpers.ts';
import {
  canonicalJsonHash,
  createSourceBackupArtifact,
  createTargetDatabaseBackup,
  SlowBooksId,
  SlowBooksSourceBundle,
} from './slowbooksSourceAdapter.ts';
import {
  buildReconciliationMarkdownReport,
  CompanyReconciliationReport,
  reconcileMigratedCompany,
} from './slowbooksReconciliationService.ts';

export interface RunMigrationOptions {
  batchKey?: string;
  sourceLabel?: string;
  dryRun?: boolean;
  backupDir?: string;
  asOfDate?: string;
  operatorUserId?: number | null;
}

export interface MigrationExecutionResult {
  batchId: number;
  batchKey: string;
  mode: 'dry_run' | 'execute';
  status: 'completed' | 'failed';
  sourceSha256: string;
  sourceBackupPath: string | null;
  sourceBackupSha256: string | null;
  targetBackupPath: string | null;
  targetBackupSha256: string | null;
  companyReports: CompanyReconciliationReport[];
  exceptionsPreview: Array<{
    companyId: number;
    sourceCompanyId: string;
    sourceEntity: string;
    sourceId: string;
    disposition: string;
    reasonCode: string;
    reasonDetail: string;
    financialImpact: string;
    resolutionStatus: string;
  }>;
  checkpointsSummary: Array<{
    companyId: number;
    domainOrder: number;
    domainName: string;
    sourceCount: number;
    migratedCount: number;
    deduplicatedCount: number;
    archivedCount: number;
    rejectedCount: number;
  }>;
  dryRunZeroMutationVerified: boolean;
}

const SOURCE_SYSTEM = 'SlowBooks-Pro-2026';

function slugify(name: string): string {
  const base = (name || 'company')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'company';
}

function isoDateOrDefault(raw: unknown, fallback = '2026-01-01'): string {
  const s = String(raw || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}

function normalizeAcctType(raw: string): AccountType {
  const clean = (raw || '').trim();
  const map: Record<string, AccountType> = {
    Bank: 'Bank',
    bank: 'Bank',
    AccountsReceivable: 'AccountsReceivable',
    accounts_receivable: 'AccountsReceivable',
    OtherCurrentAsset: 'OtherCurrentAsset',
    other_current_asset: 'OtherCurrentAsset',
    Inventory: 'Inventory',
    inventory: 'Inventory',
    FixedAsset: 'FixedAsset',
    fixed_asset: 'FixedAsset',
    AccountsPayable: 'AccountsPayable',
    accounts_payable: 'AccountsPayable',
    CreditCard: 'CreditCard',
    credit_card: 'CreditCard',
    OtherCurrentLiability: 'OtherCurrentLiability',
    other_current_liability: 'OtherCurrentLiability',
    PayrollLiability: 'PayrollLiability',
    payroll_liability: 'PayrollLiability',
    LongTermLiability: 'LongTermLiability',
    long_term_liability: 'LongTermLiability',
    Equity: 'Equity',
    equity: 'Equity',
    Income: 'Income',
    income: 'Income',
    Revenue: 'Income',
    CostOfGoodsSold: 'CostOfGoodsSold',
    cost_of_goods_sold: 'CostOfGoodsSold',
    COGS: 'CostOfGoodsSold',
    Expense: 'Expense',
    expense: 'Expense',
    OtherExpense: 'OtherExpense',
    other_expense: 'OtherExpense',
  };
  const resolved = map[clean];
  if (resolved && ALL_ACCOUNT_TYPES.includes(resolved)) return resolved;
  return 'Expense';
}

function defaultDetailFor(t: AccountType): string {
  const m: Record<AccountType, string> = {
    Bank: 'bank',
    AccountsReceivable: 'accounts_receivable',
    OtherCurrentAsset: 'other_current_asset',
    Inventory: 'other_current_asset',
    FixedAsset: 'fixed_asset',
    AccountsPayable: 'accounts_payable',
    CreditCard: 'credit_card',
    OtherCurrentLiability: 'other_current_liability',
    PayrollLiability: 'payroll_liabilities',
    LongTermLiability: 'long_term_liability',
    Equity: 'equity',
    Income: 'income',
    CostOfGoodsSold: 'cost_of_goods_sold',
    Expense: 'expense',
    OtherExpense: 'other_expense',
  };
  return m[t] || 'expense';
}

function normalizeRole(raw: string | undefined): CompanyRole | null {
  const trimmed = String(raw || '').trim();
  if (isValidCompanyRole(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower === 'admin' || lower === 'owner' || lower === 'administrator') return 'Administrator';
  if (lower === 'accountant' || lower === 'cpa') return 'Accountant';
  if (lower === 'bookkeeper') return 'Bookkeeper';
  if (lower === 'production' || lower === 'production_manager' || lower === 'productionmanager') {
    return 'ProductionManager';
  }
  if (lower === 'readonly' || lower === 'read-only' || lower === 'viewer') return 'Read-Only';
  return null;
}

const VALID_JOURNAL_SOURCE_TYPES = new Set<string>([
  'manual', 'invoice', 'sales_receipt', 'payment', 'credit_memo',
  'bill', 'bill_payment', 'vendor_credit',
  'deposit', 'transfer', 'check', 'expense', 'expense_claim', 'credit_card_charge', 'bank_import',
  'payroll', 'reconciliation', 'inventory_adjustment', 'inventory_damage', 'inventory_transfer', 'stock_count', 'depreciation',
  'printing_contract', 'quick_print', 'exam_production', 'opening_balance',
  'reversal', 'closing_entry', 'fx_gain_loss',
]);

function normalizeJournalSourceType(raw: string | undefined): JournalSourceType {
  const clean = String(raw || 'manual').trim().toLowerCase();
  if (VALID_JOURNAL_SOURCE_TYPES.has(clean)) return clean as JournalSourceType;
  if (clean === 'journal' || clean === 'general_journal') return 'manual';
  if (clean === 'opening') return 'opening_balance';
  if (clean === 'sales') return 'invoice';
  if (clean === 'purchase') return 'bill';
  return 'manual';
}

function normalizePaymentMethod(raw: string | undefined): string {
  const v = String(raw || '').trim();
  const valid = ['Check', 'Credit Card', 'Cash', 'ACH / Wire', 'Mobile Money'];
  const match = valid.find(x => x.toLowerCase() === v.toLowerCase());
  if (match) return match;
  if (v.toLowerCase().includes('wire') || v.toLowerCase().includes('ach') || v.toLowerCase().includes('eft')) {
    return 'ACH / Wire';
  }
  if (v.toLowerCase().includes('card')) return 'Credit Card';
  if (v.toLowerCase().includes('cash')) return 'Cash';
  if (v.toLowerCase().includes('mobile')) return 'Mobile Money';
  return 'Check';
}

function normalizeCustomerType(raw: string | undefined): string {
  const v = String(raw || '').trim().toLowerCase();
  if (['school', 'corporate', 'individual', 'government', 'nonprofit'].includes(v)) return v;
  if (v.includes('edu') || v.includes('school')) return 'school';
  if (v.includes('gov')) return 'government';
  if (v.includes('non')) return 'nonprofit';
  if (v.includes('ind') || v.includes('person')) return 'individual';
  return 'corporate';
}

function normalizeBankTxnType(raw: string | undefined): string {
  const v = String(raw || '').trim();
  const allowed = [
    'Check', 'Deposit', 'Transfer', 'Bill Payment', 'Debit', 'Fee',
    'Credit Card Charge', 'Credit Card Refund', 'Payment', 'Sales Receipt', 'Other',
  ];
  const exact = allowed.find(a => a.toLowerCase() === v.toLowerCase());
  if (exact) return exact;
  if (v.toLowerCase().includes('dep')) return 'Deposit';
  if (v.toLowerCase().includes('chk') || v.toLowerCase().includes('check')) return 'Check';
  if (v.toLowerCase().includes('bill')) return 'Bill Payment';
  if (v.toLowerCase().includes('trans')) return 'Transfer';
  if (v.toLowerCase().includes('fee')) return 'Fee';
  return 'Other';
}

function sourceKeyHash(entity: string, sourceId: SlowBooksId, payload: unknown): string {
  return canonicalJsonHash({ entity, sourceId: String(sourceId), payload });
}

interface ExceptionLogInput {
  companyId: number;
  batchId: number;
  sourceEntity: string;
  sourceId: string;
  disposition:
    | 'rejected'
    | 'duplicate_merged'
    | 'archived_preserved'
    | 'deleted_preserved'
    | 'deprecated_vertical'
    | 'discrepancy_explained';
  reasonCode: string;
  reasonDetail: string;
  financialImpact4?: bigint;
  sourcePayload?: unknown;
  resolutionStatus?: 'open' | 'resolved' | 'accepted';
}

async function recordException(tx: Transaction, input: ExceptionLogInput) {
  const impactStr = formatDecimal4(input.financialImpact4 ?? 0n);
  const resStatus =
    input.resolutionStatus ??
    (input.disposition === 'rejected' ? 'open' : 'accepted');
  const res = await tx.query<{ id: number }>(
    `INSERT INTO migration_exceptions (
       company_id, batch_id, source_entity, source_id, disposition,
       reason_code, reason_detail, financial_impact, source_payload, resolution_status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::NUMERIC(19,4), $9::JSONB, $10)
     RETURNING id`,
    [
      input.companyId,
      input.batchId,
      input.sourceEntity,
      input.sourceId,
      input.disposition,
      input.reasonCode.slice(0, 64),
      input.reasonDetail,
      impactStr,
      JSON.stringify(input.sourcePayload ?? {}),
      resStatus,
    ]
  );
  return Number(res.rows[0].id);
}

async function upsertIdMap(
  tx: Transaction,
  params: {
    companyId: number;
    batchId: number;
    sourceEntity: string;
    sourceId: string;
    targetTable: string;
    targetId: number;
    disposition: 'migrated' | 'merged_duplicate' | 'archived_preserved' | 'opening_balance';
    payload: unknown;
  }
) {
  const hash = sourceKeyHash(params.sourceEntity, params.sourceId, params.payload);
  await tx.query(
    `INSERT INTO migration_id_map (
       company_id, batch_id, source_system, source_entity, source_id,
       target_table, target_id, source_key_hash, disposition, metadata_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB)
     ON CONFLICT (company_id, source_system, source_entity, source_id)
     DO UPDATE SET target_table = EXCLUDED.target_table,
                   target_id = EXCLUDED.target_id`,
    [
      params.companyId,
      params.batchId,
      SOURCE_SYSTEM,
      params.sourceEntity,
      params.sourceId,
      params.targetTable,
      params.targetId,
      hash,
      params.disposition,
      JSON.stringify({ preservedAt: new Date().toISOString(), sourceId: params.sourceId }),
    ]
  );
}

async function saveCheckpoint(
  tx: Transaction,
  params: {
    companyId: number;
    batchId: number;
    domainOrder: number;
    domainName: string;
    sourceCount: number;
    migratedCount: number;
    deduplicatedCount: number;
    archivedCount: number;
    rejectedCount: number;
    lastSourceId?: string | null;
    meta?: Record<string, unknown>;
  }
) {
  await tx.query(
    `INSERT INTO migration_checkpoints (
       company_id, batch_id, domain_order, domain_name, status,
       source_count, migrated_count, deduplicated_count, archived_count, rejected_count,
       last_source_id, checkpoint_meta
     ) VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, $8, $9, $10, $11::JSONB)
     ON CONFLICT (company_id, batch_id, domain_name)
     DO UPDATE SET status = 'completed',
                   domain_order = EXCLUDED.domain_order,
                   source_count = EXCLUDED.source_count,
                   migrated_count = EXCLUDED.migrated_count,
                   deduplicated_count = EXCLUDED.deduplicated_count,
                   archived_count = EXCLUDED.archived_count,
                   rejected_count = EXCLUDED.rejected_count,
                   last_source_id = EXCLUDED.last_source_id,
                   checkpoint_meta = EXCLUDED.checkpoint_meta`,
    [
      params.companyId,
      params.batchId,
      params.domainOrder,
      params.domainName,
      params.sourceCount,
      params.migratedCount,
      params.deduplicatedCount,
      params.archivedCount,
      params.rejectedCount,
      params.lastSourceId ?? null,
      JSON.stringify(params.meta ?? {}),
    ]
  );
}

async function loadExistingCompanyIdMap(
  tx: Transaction,
  companyId: number
): Promise<Map<string, { targetId: number; targetTable: string; disposition: string }>> {
  const res = await tx.query<{
    source_entity: string;
    source_id: string;
    target_table: string;
    target_id: number;
    disposition: string;
  }>(
    `SELECT source_entity, source_id, target_table, target_id, disposition
       FROM migration_id_map
      WHERE company_id = $1 AND source_system = $2`,
    [companyId, SOURCE_SYSTEM]
  );
  const map = new Map<string, { targetId: number; targetTable: string; disposition: string }>();
  for (const r of res.rows) {
    map.set(`${r.source_entity}::${r.source_id}`, {
      targetId: Number(r.target_id),
      targetTable: r.target_table,
      disposition: r.disposition,
    });
  }
  return map;
}

async function findActiveMappedCompany(
  tx: Transaction,
  sourceCompanyId: string
): Promise<number | null> {
  const res = await tx.query<{ company_id: number }>(
    `SELECT m.company_id
       FROM migration_id_map m
       JOIN companies c ON c.id = m.company_id
      WHERE m.source_system = $1
        AND m.source_entity = 'companies'
        AND m.source_id = $2
        AND c.is_active = TRUE
      ORDER BY m.company_id DESC
      LIMIT 1`,
    [SOURCE_SYSTEM, sourceCompanyId]
  );
  return res.rows.length > 0 ? Number(res.rows[0].company_id) : null;
}

async function resolveOrCreateUser(
  tx: Transaction,
  srcUser: SlowBooksSourceBundle['users'][number],
  placeholderPassHash: string
): Promise<{
  userId: number;
  disposition: 'migrated' | 'merged_duplicate' | 'archived_preserved';
  reason?: string;
}> {
  const usernameClean = String(srcUser.username || '').trim();
  const emailClean = String(srcUser.email || `${usernameClean}@migrated.slowbooks.local`).trim();

  const existing = await tx.query<{ id: number; username: string; email: string }>(
    `SELECT id, username, email
       FROM users
      WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)
      ORDER BY id ASC
      LIMIT 1`,
    [usernameClean, emailClean]
  );

  const isArchivedOrDeleted = Boolean(srcUser.is_archived || srcUser.is_deleted || srcUser.is_active === false);

  if (existing.rows.length > 0) {
    const uid = Number(existing.rows[0].id);
    if (isArchivedOrDeleted) {
      return {
        userId: uid,
        disposition: 'archived_preserved',
        reason: `Inactive/archived/deleted SlowBooks user matched existing target user #${uid}`,
      };
    }
    return {
      userId: uid,
      disposition: 'merged_duplicate',
      reason: `Matched existing user '${existing.rows[0].username}' (${existing.rows[0].email}) deterministically`,
    };
  }

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO users (
       username, email, display_name, password_hash, is_active, session_version, expires_on, last_login_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::DATE, $8::TIMESTAMPTZ)
     RETURNING id`,
    [
      usernameClean.slice(0, 100),
      emailClean.slice(0, 255),
      (srcUser.display_name || usernameClean).slice(0, 150),
      srcUser.password_hash || placeholderPassHash,
      !isArchivedOrDeleted,
      Number(srcUser.session_version ?? 0) || 0,
      srcUser.expires_on ? isoDateOrDefault(srcUser.expires_on) : null,
      srcUser.last_login_at || null,
    ]
  );

  return {
    userId: Number(ins.rows[0].id),
    disposition: isArchivedOrDeleted ? 'archived_preserved' : 'migrated',
  };
}

async function migrateSingleCompany(
  tx: Transaction,
  batchId: number,
  bundle: SlowBooksSourceBundle,
  srcComp: SlowBooksSourceBundle['companies'][number],
  actor: ActorContext,
  options: { asOfDate?: string; operatorUserId?: number | null }
): Promise<{
  companyId: number;
  report: CompanyReconciliationReport;
  runStats: {
    sourceRecords: number;
    migrated: number;
    deduplicated: number;
    archived: number;
    rejected: number;
  };
}> {
  const sCompId = String(srcComp.id);
  const compArchivedOrDeleted = Boolean(srcComp.is_archived || srcComp.is_deleted);
  const placeholderPassHash = hashPassword('MigratedSlowBooks#2026');

  // Checkpoint 1: Companies & Settings
  let companyId = await findActiveMappedCompany(tx, sCompId);
  const existingCompanyMapBefore = companyId ? await loadExistingCompanyIdMap(tx, companyId) : new Map();

  let compMigrated = 0;
  let compDup = 0;
  let compArch = 0;
  let compRej = 0;

  if (!companyId) {
    const baseSlug = slugify(srcComp.slug || srcComp.name);
    let slug = baseSlug;
    for (let i = 1; i <= 50; i++) {
      const ex = await tx.query<{ id: number }>(`SELECT id FROM companies WHERE slug = $1`, [slug]);
      if (ex.rows.length === 0) break;
      slug = `${baseSlug}-${i + 1}`;
    }

    const insComp = await tx.query<{ id: number }>(
      `INSERT INTO companies (
         slug, name, legal_name, tax_id_ein, address, city_state_zip, phone, email, website,
         base_currency, currency_symbol, fiscal_year_start_month, accounting_method,
         sales_tax_rate, rounding_mode, decimal_places, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::NUMERIC(9,6), $15, $16, $17)
       RETURNING id`,
      [
        slug,
        String(srcComp.name).trim().slice(0, 200),
        String(srcComp.legal_name || srcComp.name).trim().slice(0, 250),
        srcComp.tax_id_ein ?? null,
        srcComp.address ?? null,
        srcComp.city_state_zip ?? null,
        srcComp.phone ?? null,
        srcComp.email ?? null,
        srcComp.website ?? null,
        (srcComp.base_currency || 'ZMW').slice(0, 3).toUpperCase(),
        (srcComp.currency_symbol || 'K').slice(0, 8),
        Math.min(12, Math.max(1, Number(srcComp.fiscal_year_start_month ?? 1))),
        srcComp.accounting_method === 'cash' ? 'cash' : 'accrual',
        Number(srcComp.sales_tax_rate ?? 0),
        srcComp.rounding_mode === 'HALF_UP' ? 'HALF_UP' : 'HALF_EVEN',
        Math.min(4, Math.max(2, Number(srcComp.decimal_places ?? 2))),
        srcComp.is_active !== false && !compArchivedOrDeleted,
      ]
    );
    companyId = Number(insComp.rows[0].id);

    await upsertIdMap(tx, {
      companyId,
      batchId,
      sourceEntity: 'companies',
      sourceId: sCompId,
      targetTable: 'companies',
      targetId: companyId,
      disposition: compArchivedOrDeleted ? 'archived_preserved' : 'migrated',
      payload: srcComp,
    });

    if (compArchivedOrDeleted) {
      compArch = 1;
      await recordException(tx, {
        companyId,
        batchId,
        sourceEntity: 'companies',
        sourceId: sCompId,
        disposition: srcComp.is_deleted ? 'deleted_preserved' : 'archived_preserved',
        reasonCode: 'COMPANY_ARCHIVED_OR_DELETED',
        reasonDetail: `Source company "${srcComp.name}" was marked ${srcComp.is_deleted ? 'deleted' : 'archived'} and preserved as inactive.`,
        sourcePayload: srcComp,
      });
    } else {
      compMigrated = 1;
    }

    // Company settings
    for (const s of (bundle.settings || []).filter(x => String(x.company_id) === sCompId)) {
      await tx.query(
        `INSERT INTO company_settings (company_id, setting_key, setting_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id, setting_key)
         DO UPDATE SET setting_value = EXCLUDED.setting_value`,
        [companyId, String(s.setting_key).slice(0, 120), s.setting_value ?? null]
      );
    }
  } else {
    compMigrated = 1;
  }

  // Ensure migration operator (if specified) can inspect/switch to active migrated companies
  if (options.operatorUserId) {
    await tx.query(
      `INSERT INTO company_memberships (company_id, user_id, role, is_default, is_active, invited_by)
       VALUES ($1, $2, 'Administrator', FALSE, TRUE, $2)
       ON CONFLICT (company_id, user_id) DO NOTHING`,
      [companyId, options.operatorUserId]
    );
  }

  await tx.query(
    `INSERT INTO migration_company_runs (
       company_id, batch_id, source_company_id, source_company_name, status
     ) VALUES ($1, $2, $3, $4, 'running')
     ON CONFLICT (company_id, batch_id)
     DO UPDATE SET status = 'running'`,
    [companyId, batchId, sCompId, String(srcComp.name).slice(0, 250)]
  );

  await saveCheckpoint(tx, {
    companyId,
    batchId,
    domainOrder: 1,
    domainName: 'companies',
    sourceCount: 1,
    migratedCount: compMigrated,
    deduplicatedCount: compDup,
    archivedCount: compArch,
    rejectedCount: compRej,
    lastSourceId: sCompId,
  });

  // Helper to resolve or reuse map across idempotent reruns
  const idMap = await loadExistingCompanyIdMap(tx, companyId);
  const getMappedId = (entity: string, sourceId: SlowBooksId | null | undefined): number | null => {
    if (sourceId === null || sourceId === undefined || sourceId === '') return null;
    return idMap.get(`${entity}::${String(sourceId)}`)?.targetId ?? null;
  };
  const setMapped = async (
    entity: string,
    sourceId: SlowBooksId,
    targetTable: string,
    targetId: number,
    disposition: 'migrated' | 'merged_duplicate' | 'archived_preserved' | 'opening_balance',
    payload: unknown
  ) => {
    const sid = String(sourceId);
    idMap.set(`${entity}::${sid}`, { targetId, targetTable, disposition });
    await upsertIdMap(tx, {
      companyId: companyId!,
      batchId,
      sourceEntity: entity,
      sourceId: sid,
      targetTable,
      targetId,
      disposition,
      payload,
    });
  };

  let totalSource = 1;
  let totalMigrated = compMigrated;
  let totalDup = compDup;
  let totalArch = compArch;
  let totalRej = compRej;

  const trackCheckpoint = async (
    order: number,
    name: string,
    counts: { src: number; mig: number; dup: number; arch: number; rej: number; last?: string | null; meta?: Record<string, unknown> }
  ) => {
    totalSource += counts.src;
    totalMigrated += counts.mig;
    totalDup += counts.dup;
    totalArch += counts.arch;
    totalRej += counts.rej;
    await saveCheckpoint(tx, {
      companyId: companyId!,
      batchId,
      domainOrder: order,
      domainName: name,
      sourceCount: counts.src,
      migratedCount: counts.mig,
      deduplicatedCount: counts.dup,
      archivedCount: counts.arch,
      rejectedCount: counts.rej,
      lastSourceId: counts.last ?? null,
      meta: counts.meta,
    });
  };

  // Global Users map (shared across companies in bundle)
  const srcUserById = new Map<string, SlowBooksSourceBundle['users'][number]>();
  for (const u of bundle.users || []) srcUserById.set(String(u.id), u);
  const resolvedUserIdBySrcId = new Map<string, number>();

  // Checkpoint 2: Memberships (and referenced users)
  {
    const srcMems = (bundle.company_memberships || []).filter(m => String(m.company_id) === sCompId);
    let mig = 0;
    let dup = 0;
    let arch = 0;
    let rej = 0;
    let lastId: string | null = null;

    for (let idx = 0; idx < srcMems.length; idx++) {
      const m = srcMems[idx];
      const memSid = String(m.id ?? `${sCompId}-${m.user_id}-${idx}`);
      lastId = memSid;
      const existing = idMap.get(`company_memberships::${memSid}`);
      if (existing) {
        mig++;
        continue;
      }

      const srcUser = srcUserById.get(String(m.user_id));
      if (!srcUser) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'company_memberships',
          sourceId: memSid,
          disposition: 'rejected',
          reasonCode: 'MISSING_SOURCE_USER',
          reasonDetail: `Membership references missing SlowBooks user_id=${m.user_id}`,
          sourcePayload: m,
        });
        continue;
      }

      const role = normalizeRole(m.role || srcUser.role);
      if (!role) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'company_memberships',
          sourceId: memSid,
          disposition: 'rejected',
          reasonCode: 'INVALID_ROLE',
          reasonDetail: `Unsupported SlowBooks role "${m.role || srcUser.role}"`,
          sourcePayload: m,
        });
        continue;
      }

      let targetUserId = resolvedUserIdBySrcId.get(String(srcUser.id)) ?? getMappedId('users', srcUser.id);
      if (!targetUserId) {
        const resU = await resolveOrCreateUser(tx, srcUser, placeholderPassHash);
        targetUserId = resU.userId;
        resolvedUserIdBySrcId.set(String(srcUser.id), targetUserId);
        await setMapped('users', srcUser.id, 'users', targetUserId, resU.disposition === 'merged_duplicate' ? 'merged_duplicate' : resU.disposition === 'archived_preserved' ? 'archived_preserved' : 'migrated', srcUser);
      }

      const dupMem = await tx.query<{ id: number }>(
        `SELECT id FROM company_memberships WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
        [companyId, targetUserId]
      );
      if (dupMem.rows.length > 0) {
        const tid = Number(dupMem.rows[0].id);
        dup++;
        await setMapped('company_memberships', memSid, 'company_memberships', tid, 'merged_duplicate', m);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'company_memberships',
          sourceId: memSid,
          disposition: 'duplicate_merged',
          reasonCode: 'DUPLICATE_MEMBERSHIP',
          reasonDetail: `Duplicate membership for user ${srcUser.username} merged into membership #${tid}`,
          sourcePayload: m,
        });
        continue;
      }

      const isMemInactive = Boolean(m.is_active === false || m.revoked_at || srcUser.is_archived || srcUser.is_deleted);
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO company_memberships (
           company_id, user_id, role, is_default, is_active, expires_on, revoked_at
         ) VALUES ($1, $2, $3, $4, $5, $6::DATE, $7::TIMESTAMPTZ)
         RETURNING id`,
        [
          companyId,
          targetUserId,
          role,
          Boolean(m.is_default),
          !isMemInactive,
          m.expires_on ? isoDateOrDefault(m.expires_on) : null,
          m.revoked_at || null,
        ]
      );
      const tid = Number(ins.rows[0].id);
      if (isMemInactive) {
        arch++;
        await setMapped('company_memberships', memSid, 'company_memberships', tid, 'archived_preserved', m);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'company_memberships',
          sourceId: memSid,
          disposition: 'archived_preserved',
          reasonCode: 'INACTIVE_OR_REVOKED_MEMBERSHIP',
          reasonDetail: `Inactive/revoked membership for "${srcUser.username}" preserved in target`,
          sourcePayload: m,
        });
      } else {
        mig++;
        await setMapped('company_memberships', memSid, 'company_memberships', tid, 'migrated', m);
      }
    }

    await trackCheckpoint(2, 'company_memberships', { src: srcMems.length, mig, dup, arch, rej, last: lastId });
  }

  // Checkpoint 3: Payment Terms
  {
    const srcTerms = (bundle.payment_terms || []).filter(t => String(t.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const pt of srcTerms) {
      const sid = String(pt.id);
      last = sid;
      if (idMap.has(`payment_terms::${sid}`)) { mig++; continue; }

      const existing = await tx.query<{ id: number }>(
        `SELECT id FROM payment_terms WHERE company_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
        [companyId, String(pt.name).trim()]
      );
      if (existing.rows.length > 0) {
        const tid = Number(existing.rows[0].id);
        dup++;
        await setMapped('payment_terms', sid, 'payment_terms', tid, 'merged_duplicate', pt);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'payment_terms',
          sourceId: sid,
          disposition: 'duplicate_merged',
          reasonCode: 'DUPLICATE_PAYMENT_TERM',
          reasonDetail: `Duplicate payment term "${pt.name}" merged into #${tid}`,
          sourcePayload: pt,
        });
        continue;
      }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO payment_terms (
           company_id, name, kind, net_days, due_day, cutoff_days,
           discount_percent, discount_days, discount_day, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(9,6), $8, $9, $10)
         RETURNING id`,
        [
          companyId,
          String(pt.name).trim().slice(0, 80),
          pt.kind === 'date_driven' ? 'date_driven' : 'standard',
          Math.max(0, Number(pt.net_days ?? 0)),
          pt.due_day ?? null,
          pt.cutoff_days ?? null,
          Number(pt.discount_percent ?? 0),
          Math.max(0, Number(pt.discount_days ?? 0)),
          pt.discount_day ?? null,
          pt.is_active !== false,
        ]
      );
      const tid = Number(ins.rows[0].id);
      if (pt.is_active === false) {
        arch++;
        await setMapped('payment_terms', sid, 'payment_terms', tid, 'archived_preserved', pt);
      } else {
        mig++;
        await setMapped('payment_terms', sid, 'payment_terms', tid, 'migrated', pt);
      }
    }
    await trackCheckpoint(3, 'payment_terms', { src: srcTerms.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 4: Classes (two-pass for parent_id)
  {
    const srcClasses = (bundle.classes || []).filter(c => String(c.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const c of srcClasses) {
      const sid = String(c.id);
      last = sid;
      if (idMap.has(`classes::${sid}`)) { mig++; continue; }

      const existing = await tx.query<{ id: number }>(
        `SELECT id FROM txn_classes WHERE company_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
        [companyId, String(c.name).trim()]
      );
      if (existing.rows.length > 0) {
        const tid = Number(existing.rows[0].id);
        dup++;
        await setMapped('classes', sid, 'txn_classes', tid, 'merged_duplicate', c);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'classes',
          sourceId: sid,
          disposition: 'duplicate_merged',
          reasonCode: 'DUPLICATE_CLASS',
          reasonDetail: `Duplicate class "${c.name}" merged into #${tid}`,
          sourcePayload: c,
        });
        continue;
      }

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO txn_classes (company_id, name, is_active) VALUES ($1, $2, $3) RETURNING id`,
        [companyId, String(c.name).trim().slice(0, 120), c.is_active !== false]
      );
      const tid = Number(ins.rows[0].id);
      if (c.is_active === false) {
        arch++;
        await setMapped('classes', sid, 'txn_classes', tid, 'archived_preserved', c);
      } else {
        mig++;
        await setMapped('classes', sid, 'txn_classes', tid, 'migrated', c);
      }
    }
    for (const c of srcClasses) {
      if (!c.parent_id) continue;
      const tid = getMappedId('classes', c.id);
      const pid = getMappedId('classes', c.parent_id);
      if (tid && pid && tid !== pid) {
        await tx.query(`UPDATE txn_classes SET parent_id = $3 WHERE company_id = $1 AND id = $2`, [companyId, tid, pid]);
      }
    }
    await trackCheckpoint(4, 'classes', { src: srcClasses.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 5: Chart of Accounts (two-pass for parent_id)
  {
    const srcAccts = (bundle.accounts || []).filter(a => String(a.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;

    for (const a of srcAccts) {
      const sid = String(a.id);
      last = sid;
      if (idMap.has(`accounts::${sid}`)) { mig++; continue; }

      const nameClean = String(a.name || '').trim();
      if (!nameClean) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'accounts',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'MISSING_ACCOUNT_NAME',
          reasonDetail: `SlowBooks account id=${sid} has empty name`,
          sourcePayload: a,
        });
        continue;
      }

      const codeClean = a.code ? String(a.code).trim().slice(0, 32) : null;
      if (codeClean) {
        const dupAcct = await tx.query<{ id: number; name: string }>(
          `SELECT id, name FROM accounts WHERE company_id = $1 AND LOWER(code) = LOWER($2) LIMIT 1`,
          [companyId, codeClean]
        );
        if (dupAcct.rows.length > 0) {
          const tid = Number(dupAcct.rows[0].id);
          dup++;
          await setMapped('accounts', sid, 'accounts', tid, 'merged_duplicate', a);
          await recordException(tx, {
            companyId,
            batchId,
            sourceEntity: 'accounts',
            sourceId: sid,
            disposition: 'duplicate_merged',
            reasonCode: 'DUPLICATE_ACCOUNT_CODE',
            reasonDetail: `Account code ${codeClean} ("${nameClean}") deterministically merged into "${dupAcct.rows[0].name}" (#${tid})`,
            sourcePayload: a,
          });
          continue;
        }
      }

      const acctType = normalizeAcctType(a.account_type);
      const bankKind =
        a.bank_kind === 'bank' || acctType === 'Bank'
          ? 'bank'
          : a.bank_kind === 'credit_card' || acctType === 'CreditCard'
          ? 'credit_card'
          : null;
      const detailType = a.detail_type?.trim() || defaultDetailFor(acctType);
      const normalBal = a.normal_balance === 'debit' || a.normal_balance === 'credit'
        ? a.normal_balance
        : normalBalanceFor(acctType);
      const isArchOrDel = Boolean(a.is_archived || a.is_deleted || a.is_active === false);

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO accounts (
           company_id, code, name, account_type, detail_type, bank_kind,
           description, normal_balance, is_system, is_control, is_active, balance
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0.0000)
         RETURNING id`,
        [
          companyId,
          codeClean,
          nameClean.slice(0, 160),
          acctType,
          detailType.slice(0, 40),
          bankKind,
          a.description ?? null,
          normalBal,
          Boolean(a.is_system),
          Boolean(a.is_control),
          !isArchOrDel,
        ]
      );
      const tid = Number(ins.rows[0].id);
      if (isArchOrDel) {
        arch++;
        await setMapped('accounts', sid, 'accounts', tid, 'archived_preserved', a);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'accounts',
          sourceId: sid,
          disposition: a.is_deleted ? 'deleted_preserved' : 'archived_preserved',
          reasonCode: 'INACTIVE_OR_ARCHIVED_ACCOUNT',
          reasonDetail: `Account "${nameClean}" (${codeClean || 'no code'}) preserved as inactive`,
          sourcePayload: a,
        });
      } else {
        mig++;
        await setMapped('accounts', sid, 'accounts', tid, 'migrated', a);
      }
    }

    for (const a of srcAccts) {
      if (!a.parent_id) continue;
      const tid = getMappedId('accounts', a.id);
      const pid = getMappedId('accounts', a.parent_id);
      if (tid && pid && tid !== pid) {
        await tx.query(`UPDATE accounts SET parent_id = $3 WHERE company_id = $1 AND id = $2`, [companyId, tid, pid]);
      }
    }

    await trackCheckpoint(5, 'accounts', { src: srcAccts.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 6: Fiscal Periods (Insert initially as 'open' so historical closed-period journals load cleanly; finalized in step 27)
  const deferredPeriodStatusUpdates: Array<{ periodId: number; status: 'open' | 'soft_closed' | 'closed'; closingSrcTxnId?: SlowBooksId | null; closedAt?: string | null; notes?: string | null }> = [];
  {
    const srcPeriods = (bundle.fiscal_periods || []).filter(p => String(p.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (let i = 0; i < srcPeriods.length; i++) {
      const p = srcPeriods[i];
      const sid = String(p.id ?? `${p.start_date}_${p.end_date}`);
      last = sid;
      if (idMap.has(`fiscal_periods::${sid}`)) {
        const tid = getMappedId('fiscal_periods', sid)!;
        deferredPeriodStatusUpdates.push({
          periodId: tid,
          status: p.status,
          closingSrcTxnId: p.closing_txn_id,
          closedAt: p.closed_at,
          notes: p.notes,
        });
        mig++;
        continue;
      }

      const start = isoDateOrDefault(p.start_date);
      const end = isoDateOrDefault(p.end_date);
      if (end < start) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'fiscal_periods',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'INVALID_PERIOD_DATES',
          reasonDetail: `Fiscal period "${p.period_name}" has end_date ${end} < start_date ${start}`,
          sourcePayload: p,
        });
        continue;
      }

      const dupPer = await tx.query<{ id: number }>(
        `SELECT id FROM fiscal_periods WHERE company_id = $1 AND start_date = $2::DATE AND end_date = $3::DATE LIMIT 1`,
        [companyId, start, end]
      );
      if (dupPer.rows.length > 0) {
        const tid = Number(dupPer.rows[0].id);
        dup++;
        await setMapped('fiscal_periods', sid, 'fiscal_periods', tid, 'merged_duplicate', p);
        continue;
      }

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO fiscal_periods (company_id, period_name, start_date, end_date, status, notes)
         VALUES ($1, $2, $3::DATE, $4::DATE, 'open', $5)
         RETURNING id`,
        [companyId, String(p.period_name).slice(0, 60), start, end, p.notes ?? null]
      );
      const tid = Number(ins.rows[0].id);
      mig++;
      await setMapped('fiscal_periods', sid, 'fiscal_periods', tid, 'migrated', p);
      deferredPeriodStatusUpdates.push({
        periodId: tid,
        status: p.status,
        closingSrcTxnId: p.closing_txn_id,
        closedAt: p.closed_at,
        notes: p.notes,
      });
    }
    await trackCheckpoint(6, 'fiscal_periods', { src: srcPeriods.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 7: Customers (+ reseller_permits + invoice_messages)
  {
    const srcCusts = (bundle.customers || []).filter(c => String(c.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const c of srcCusts) {
      const sid = String(c.id);
      last = sid;
      if (idMap.has(`customers::${sid}`)) { mig++; continue; }

      const nameClean = String(c.name || '').trim();
      if (!nameClean) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'customers',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'MISSING_CUSTOMER_NAME',
          reasonDetail: `Customer id=${sid} has empty name`,
          sourcePayload: c,
        });
        continue;
      }

      const dupC = await tx.query<{ id: number; name: string }>(
        `SELECT id, name FROM customers WHERE company_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
        [companyId, nameClean]
      );
      if (dupC.rows.length > 0) {
        const tid = Number(dupC.rows[0].id);
        dup++;
        await setMapped('customers', sid, 'customers', tid, 'merged_duplicate', c);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'customers',
          sourceId: sid,
          disposition: 'duplicate_merged',
          reasonCode: 'DUPLICATE_CUSTOMER_NAME',
          reasonDetail: `Duplicate customer "${nameClean}" merged into #${tid}`,
          sourcePayload: c,
        });
        continue;
      }

      const isArchOrDel = Boolean(c.is_archived || c.is_deleted || c.is_active === false);
      const termId = getMappedId('payment_terms', c.payment_term_id);
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO customers (
           company_id, customer_type, name, company_name, email, phone,
           billing_address, shipping_address, payment_term_id, terms_label,
           credit_limit, balance, is_tax_exempt, notes, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::NUMERIC(19,4), 0.0000, $12, $13, $14)
         RETURNING id`,
        [
          companyId,
          normalizeCustomerType(c.customer_type),
          nameClean.slice(0, 200),
          String(c.company_name || nameClean).slice(0, 200),
          c.email ?? null,
          c.phone ?? null,
          c.billing_address ?? null,
          c.shipping_address ?? null,
          termId,
          (c.terms_label || 'Net 30').slice(0, 60),
          c.credit_limit !== null && c.credit_limit !== undefined ? formatDecimal4(parseDecimal4(c.credit_limit)) : null,
          Boolean(c.is_tax_exempt),
          c.notes ?? null,
          !isArchOrDel,
        ]
      );
      const tid = Number(ins.rows[0].id);
      if (isArchOrDel) {
        arch++;
        await setMapped('customers', sid, 'customers', tid, 'archived_preserved', c);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'customers',
          sourceId: sid,
          disposition: c.is_deleted ? 'deleted_preserved' : 'archived_preserved',
          reasonCode: 'INACTIVE_OR_ARCHIVED_CUSTOMER',
          reasonDetail: `Customer "${nameClean}" preserved as inactive`,
          sourcePayload: c,
        });
      } else {
        mig++;
        await setMapped('customers', sid, 'customers', tid, 'migrated', c);
      }
    }
    for (const c of srcCusts) {
      if (!c.parent_customer_id) continue;
      const tid = getMappedId('customers', c.id);
      const pid = getMappedId('customers', c.parent_customer_id);
      if (tid && pid && tid !== pid) {
        await tx.query(`UPDATE customers SET parent_customer_id = $3 WHERE company_id = $1 AND id = $2`, [companyId, tid, pid]);
      }
    }
    for (const p of (bundle.reseller_permits || []).filter(x => String(x.company_id) === sCompId)) {
      const custId = getMappedId('customers', p.customer_id);
      if (!custId) continue;
      await tx.query(
        `INSERT INTO reseller_permits (
           company_id, customer_id, jurisdiction, permit_number, issued_at, expires_at, is_active
         ) VALUES ($1, $2, $3, $4, $5::DATE, $6::DATE, $7)
         ON CONFLICT (company_id, jurisdiction, permit_number) DO NOTHING`,
        [
          companyId,
          custId,
          String(p.jurisdiction).slice(0, 80),
          String(p.permit_number).slice(0, 100),
          p.issued_at ? isoDateOrDefault(p.issued_at) : null,
          p.expires_at ? isoDateOrDefault(p.expires_at) : null,
          p.is_active !== false,
        ]
      );
    }
    for (const msg of (bundle.invoice_messages || []).filter(x => String(x.company_id) === sCompId)) {
      await tx.query(
        `INSERT INTO invoice_messages (company_id, name, kind, body)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, kind, name) DO NOTHING`,
        [companyId, String(msg.name).slice(0, 120), msg.kind, msg.body]
      );
    }
    await trackCheckpoint(7, 'customers', { src: srcCusts.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 8: Vendors / Suppliers
  {
    const srcVendors = (bundle.vendors || []).filter(v => String(v.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const v of srcVendors) {
      const sid = String(v.id);
      last = sid;
      if (idMap.has(`vendors::${sid}`)) { mig++; continue; }

      const nameClean = String(v.name || '').trim();
      if (!nameClean) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'vendors',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'MISSING_VENDOR_NAME',
          reasonDetail: `Vendor id=${sid} has empty name`,
          sourcePayload: v,
        });
        continue;
      }

      const dupV = await tx.query<{ id: number }>(
        `SELECT id FROM vendors WHERE company_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
        [companyId, nameClean]
      );
      if (dupV.rows.length > 0) {
        const tid = Number(dupV.rows[0].id);
        dup++;
        await setMapped('vendors', sid, 'vendors', tid, 'merged_duplicate', v);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'vendors',
          sourceId: sid,
          disposition: 'duplicate_merged',
          reasonCode: 'DUPLICATE_VENDOR_NAME',
          reasonDetail: `Duplicate vendor "${nameClean}" merged into #${tid}`,
          sourcePayload: v,
        });
        continue;
      }

      const isArchOrDel = Boolean(v.is_archived || v.is_deleted || v.is_active === false);
      const defAcctId = getMappedId('accounts', v.default_expense_account_id);
      const termId = getMappedId('payment_terms', v.payment_term_id);

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO vendors (
           company_id, name, company_name, email, phone, address, ein_or_ssn,
           is_1099_eligible, default_expense_account_id, payment_term_id, terms_label, balance, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0.0000, $12)
         RETURNING id`,
        [
          companyId,
          nameClean.slice(0, 200),
          String(v.company_name || nameClean).slice(0, 200),
          v.email ?? null,
          v.phone ?? null,
          v.address ?? null,
          v.ein_or_ssn ?? null,
          Boolean(v.is_1099_eligible),
          defAcctId,
          termId,
          (v.terms_label || 'Net 30').slice(0, 60),
          !isArchOrDel,
        ]
      );
      const tid = Number(ins.rows[0].id);
      if (isArchOrDel) {
        arch++;
        await setMapped('vendors', sid, 'vendors', tid, 'archived_preserved', v);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'vendors',
          sourceId: sid,
          disposition: v.is_deleted ? 'deleted_preserved' : 'archived_preserved',
          reasonCode: 'INACTIVE_OR_ARCHIVED_VENDOR',
          reasonDetail: `Vendor "${nameClean}" preserved as inactive`,
          sourcePayload: v,
        });
      } else {
        mig++;
        await setMapped('vendors', sid, 'vendors', tid, 'migrated', v);
      }
    }
    await trackCheckpoint(8, 'vendors', { src: srcVendors.length, mig, dup, arch, rej, last });
  }

  // Resolve fallback GL accounts for Inventory Items (1200/5000/4000)
  const acctLookupRes = await tx.query<{ id: number; code: string | null; account_type: string }>(
    `SELECT id, code, account_type FROM accounts WHERE company_id = $1 ORDER BY id ASC`,
    [companyId]
  );
  const acctByCode = new Map<string, number>();
  const acctByType = new Map<string, number>();
  for (const r of acctLookupRes.rows) {
    if (r.code) acctByCode.set(r.code, Number(r.id));
    if (!acctByType.has(r.account_type)) acctByType.set(r.account_type, Number(r.id));
  }
  const defaultAssetId = acctByCode.get('1200') ?? acctByType.get('Inventory') ?? acctByType.get('OtherCurrentAsset') ?? acctLookupRes.rows[0]?.id;
  const defaultCogsId = acctByCode.get('5000') ?? acctByType.get('CostOfGoodsSold') ?? acctByType.get('Expense') ?? acctLookupRes.rows[0]?.id;
  const defaultIncomeId = acctByCode.get('4000') ?? acctByType.get('Income') ?? acctLookupRes.rows[0]?.id;

  // Checkpoint 9: Inventory Items (4 PMS types + adjustments + movements)
  {
    const srcItems = (bundle.items || []).filter(i => String(i.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;

    for (const it of srcItems) {
      const sid = String(it.id);
      last = sid;
      if (idMap.has(`items::${sid}`)) { mig++; continue; }

      const skuClean = String(it.sku || '').trim();
      const nameClean = String(it.name || '').trim();
      if (!skuClean || !nameClean) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'items',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'MISSING_SKU_OR_NAME',
          reasonDetail: `Item id=${sid} missing SKU or name`,
          sourcePayload: it,
        });
        continue;
      }

      const rawType = (it.item_type || '').trim().toLowerCase();
      let mappedType: 'raw_material' | 'printed_product' | 'stationery' | 'printing_service' = 'stationery';
      if (['raw_material', 'material', 'paper', 'toner', 'consumable'].includes(rawType)) {
        mappedType = 'raw_material';
      } else if (['printed_product', 'non_inventory'].includes(rawType)) {
        mappedType = 'printed_product';
      } else if (['printing_service', 'service', 'labor'].includes(rawType)) {
        mappedType = 'printing_service';
      } else if (rawType === 'product') {
        mappedType = parseDecimal6(it.on_hand ?? 0) > 0n ? 'stationery' : 'printed_product';
      } else if (['stationery', 'inventory'].includes(rawType)) {
        mappedType = 'stationery';
      }

      const onHand6 = parseDecimal6(it.on_hand ?? 0);
      const salesPrice4 = parseDecimal4(it.sales_price ?? 0);
      const avgCost6 = parseDecimal6(it.avg_cost ?? it.unit_cost ?? 0);
      const unitCost6 = parseDecimal6(it.unit_cost ?? it.avg_cost ?? 0);

      // Enforce domain invariants explicitly
      if (mappedType === 'raw_material' && salesPrice4 > 0n) {
        rej++;
        const impact = (onHand6 * (avgCost6 > 0n ? avgCost6 : unitCost6)) / 100000000n;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'items',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'RAW_MATERIAL_SALES_PRICE_FORBIDDEN',
          reasonDetail: `Raw material "${nameClean}" (${skuClean}) carries forbidden sales_price=${formatDecimal4(salesPrice4)}`,
          financialImpact4: impact,
          sourcePayload: it,
        });
        continue;
      }
      if ((mappedType === 'printed_product' || mappedType === 'printing_service') && onHand6 !== 0n) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'items',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'NON_STOCKED_TYPE_HAS_ON_HAND',
          reasonDetail: `Non-stocked ${mappedType} "${nameClean}" (${skuClean}) has non-zero on_hand=${formatDecimal6(onHand6)}`,
          sourcePayload: it,
        });
        continue;
      }

      const dupSku = await tx.query<{ id: number }>(
        `SELECT id FROM inventory_items WHERE company_id = $1 AND LOWER(sku) = LOWER($2) LIMIT 1`,
        [companyId, skuClean]
      );
      if (dupSku.rows.length > 0) {
        const tid = Number(dupSku.rows[0].id);
        dup++;
        await setMapped('items', sid, 'inventory_items', tid, 'merged_duplicate', it);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'items',
          sourceId: sid,
          disposition: 'duplicate_merged',
          reasonCode: 'DUPLICATE_ITEM_SKU',
          reasonDetail: `Duplicate SKU "${skuClean}" merged into inventory_item #${tid}`,
          sourcePayload: it,
        });
        continue;
      }

      const assetAcct = getMappedId('accounts', it.asset_account_id) ?? defaultAssetId;
      const cogsAcct = getMappedId('accounts', it.cogs_account_id) ?? defaultCogsId;
      const incomeAcct = getMappedId('accounts', it.income_account_id) ?? defaultIncomeId;
      const isArchOrDel = Boolean(it.is_archived || it.is_deleted || it.is_active === false);
      const conv6 = parseDecimal6(it.conversion_factor ?? 1);

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO inventory_items (
           company_id, sku, name, item_type, description,
           unit_cost, avg_cost, sales_price, on_hand, reorder_point,
           purchase_unit, usage_unit, conversion_factor,
           is_taxable, asset_account_id, cogs_account_id, income_account_id, is_active
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6::NUMERIC(19,6), $7::NUMERIC(19,6), $8::NUMERIC(19,4), $9::NUMERIC(19,6), $10::NUMERIC(19,6),
           $11, $12, $13::NUMERIC(19,6),
           $14, $15, $16, $17, $18
         ) RETURNING id`,
        [
          companyId,
          skuClean.slice(0, 64),
          nameClean.slice(0, 200),
          mappedType,
          it.description ?? null,
          formatDecimal6(unitCost6),
          formatDecimal6(avgCost6 > 0n ? avgCost6 : unitCost6),
          formatDecimal4(salesPrice4),
          formatDecimal6(onHand6),
          formatDecimal6(parseDecimal6(it.reorder_point ?? 0)),
          (it.purchase_unit || 'Unit').slice(0, 40),
          (it.usage_unit || 'Unit').slice(0, 40),
          formatDecimal6(conv6 > 0n ? conv6 : 1000000n),
          Boolean(it.is_taxable),
          assetAcct,
          cogsAcct,
          incomeAcct,
          !isArchOrDel,
        ]
      );
      const tid = Number(ins.rows[0].id);
      if (isArchOrDel) {
        arch++;
        await setMapped('items', sid, 'inventory_items', tid, 'archived_preserved', it);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'items',
          sourceId: sid,
          disposition: it.is_deleted ? 'deleted_preserved' : 'archived_preserved',
          reasonCode: 'INACTIVE_OR_ARCHIVED_ITEM',
          reasonDetail: `Item "${nameClean}" (${skuClean}) preserved as inactive`,
          sourcePayload: it,
        });
      } else {
        mig++;
        await setMapped('items', sid, 'inventory_items', tid, 'migrated', it);
      }
    }

    for (const adj of (bundle.inventory_adjustments || []).filter(a => String(a.company_id) === sCompId)) {
      const sid = String(adj.id);
      if (idMap.has(`inventory_adjustments::${sid}`)) continue;
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO inventory_adjustments (company_id, adj_date, memo, created_by)
         VALUES ($1, $2::DATE, $3, $4) RETURNING id`,
        [companyId, isoDateOrDefault(adj.adj_date), adj.memo ?? null, actor.userId]
      );
      await setMapped('inventory_adjustments', sid, 'inventory_adjustments', Number(ins.rows[0].id), 'migrated', adj);
    }

    for (const mv of (bundle.inventory_movements || []).filter(m => String(m.company_id) === sCompId)) {
      const sid = String(mv.id);
      if (idMap.has(`inventory_movements::${sid}`)) continue;
      const itemId = getMappedId('items', mv.item_id);
      const delta6 = parseDecimal6(mv.quantity_delta);
      if (!itemId || delta6 === 0n) continue;
      const mvType = ['purchase', 'sale', 'production_consume', 'adjustment', 'return_in', 'return_out', 'void'].includes(mv.movement_type)
        ? mv.movement_type
        : 'adjustment';
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO inventory_movements (
           company_id, item_id, movement_at, movement_type, quantity_delta,
           unit_cost, balance_qty, balance_avg_cost, source_type, source_id
         ) VALUES (
           $1, $2, COALESCE($3::TIMESTAMPTZ, NOW()), $4, $5::NUMERIC(19,6),
           $6::NUMERIC(19,6), $7::NUMERIC(19,6), $8::NUMERIC(19,6), $9, $10
         ) RETURNING id`,
        [
          companyId,
          itemId,
          mv.movement_at || null,
          mvType,
          formatDecimal6(delta6),
          formatDecimal6(parseDecimal6(mv.unit_cost)),
          formatDecimal6(parseDecimal6(mv.balance_qty)),
          formatDecimal6(parseDecimal6(mv.balance_avg_cost)),
          String(mv.source_type || 'migration').slice(0, 40),
          Number(mv.source_id) || 0,
        ]
      );
      await setMapped('inventory_movements', sid, 'inventory_movements', Number(ins.rows[0].id), 'migrated', mv);
    }

    await trackCheckpoint(9, 'items', { src: srcItems.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 10: Opening Balances
  {
    const srcObs = (bundle.opening_balances || []).filter(o => String(o.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;

    for (const ob of srcObs) {
      const sid = String(ob.id);
      last = sid;
      if (idMap.has(`opening_balances::${sid}`)) { mig++; continue; }

      const parsedLines: Array<{ accountId: number; dr4: bigint; cr4: bigint; desc: string | null }> = [];
      let sumDr = 0n;
      let sumCr = 0n;
      let missingAcct: string | null = null;

      for (const l of ob.lines || []) {
        const aid = getMappedId('accounts', l.account_id);
        if (!aid) { missingAcct = String(l.account_id); break; }
        const dr4 = parseDecimal4(l.debit);
        const cr4 = parseDecimal4(l.credit);
        if (dr4 === 0n && cr4 === 0n) continue;
        sumDr += dr4;
        sumCr += cr4;
        parsedLines.push({ accountId: aid, dr4, cr4, desc: l.description ?? null });
      }

      if (missingAcct || parsedLines.length === 0 || sumDr !== sumCr) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'opening_balances',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: missingAcct ? 'UNMAPPED_ACCOUNT' : 'UNBALANCED_OPENING_BALANCE',
          reasonDetail: missingAcct
            ? `Opening balance ${sid} references unmapped account ${missingAcct}`
            : `Opening balance ${sid} does not balance (DR=${formatDecimal4(sumDr)}, CR=${formatDecimal4(sumCr)})`,
          financialImpact4: absBigInt(sumDr - sumCr),
          sourcePayload: ob,
        });
        continue;
      }

      const entryNum = `MIG-OB-${sid}`.slice(0, 64);
      const hdr = await tx.query<{ id: number }>(
        `INSERT INTO journal_transactions (
           company_id, entry_number, txn_date, reference, description, memo,
           source_type, status, is_posted, posted_at, posted_by, created_by, idempotency_key
         ) VALUES (
           $1, $2, $3::DATE, 'OPENING-BAL', $4, $4,
           'opening_balance', 'posted', TRUE, NOW(), $5, $5, $6
         ) RETURNING id`,
        [
          companyId,
          entryNum,
          isoDateOrDefault(ob.txn_date),
          ob.description || 'Migrated SlowBooks Opening Balance',
          actor.userId,
          `mig-ob-${companyId}-${sid}`,
        ]
      );
      const txnId = Number(hdr.rows[0].id);
      for (let i = 0; i < parsedLines.length; i++) {
        const l = parsedLines[i];
        await tx.query(
          `INSERT INTO journal_lines (
             company_id, transaction_id, line_order, account_id, basis, description, debit, credit
           ) VALUES ($1, $2, $3, $4, 'both', $5, $6::NUMERIC(19,4), $7::NUMERIC(19,4))`,
          [companyId, txnId, i + 1, l.accountId, l.desc, formatDecimal4(l.dr4), formatDecimal4(l.cr4)]
        );
      }
      mig++;
      await setMapped('opening_balances', sid, 'journal_transactions', txnId, 'opening_balance', ob);
    }

    await trackCheckpoint(10, 'opening_balances', { src: srcObs.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 11: General Ledger Journal Transactions & Reversal Links
  {
    const srcTxns = (bundle.transactions || []).filter(t => String(t.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;

    for (const t of srcTxns) {
      const sid = String(t.id);
      last = sid;
      if (idMap.has(`transactions::${sid}`)) { mig++; continue; }

      const entryNum = String(t.entry_number || `SB-${sid}`).trim().slice(0, 64);
      const dupEntry = await tx.query<{ id: number }>(
        `SELECT id FROM journal_transactions WHERE company_id = $1 AND entry_number = $2 LIMIT 1`,
        [companyId, entryNum]
      );
      if (dupEntry.rows.length > 0) {
        const tid = Number(dupEntry.rows[0].id);
        dup++;
        await setMapped('transactions', sid, 'journal_transactions', tid, 'merged_duplicate', t);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'transactions',
          sourceId: sid,
          disposition: 'duplicate_merged',
          reasonCode: 'DUPLICATE_ENTRY_NUMBER',
          reasonDetail: `Duplicate journal entry_number "${entryNum}" merged into #${tid}`,
          sourcePayload: t,
        });
        continue;
      }

      // Validate lines before insert so deferred trigger never aborts batch
      let accDr = 0n;
      let accCr = 0n;
      let cashDr = 0n;
      let cashCr = 0n;
      let invalidReason: string | null = null;
      const validLines: Array<{
        order: number;
        accountId: number;
        basis: 'both' | 'accrual' | 'cash';
        description: string | null;
        debit4: bigint;
        credit4: bigint;
        classId: number | null;
        partyType: 'customer' | 'vendor' | 'employee' | null;
        partyId: number | null;
        isReconciled: boolean;
      }> = [];

      const rawLines = t.lines || [];
      for (let i = 0; i < rawLines.length; i++) {
        const l = rawLines[i];
        const aid = getMappedId('accounts', l.account_id);
        if (!aid) {
          invalidReason = `Line ${i + 1} references unmapped SlowBooks account ${l.account_id}`;
          break;
        }
        const dr4 = parseDecimal4(l.debit);
        const cr4 = parseDecimal4(l.credit);
        if (dr4 < 0n || cr4 < 0n || (dr4 > 0n && cr4 > 0n) || (dr4 === 0n && cr4 === 0n)) {
          invalidReason = `Line ${i + 1} violates single-sided positive debit/credit invariant (dr=${l.debit}, cr=${l.credit})`;
          break;
        }
        const basis = l.basis === 'accrual' || l.basis === 'cash' ? l.basis : 'both';
        if (basis !== 'cash') {
          accDr += dr4;
          accCr += cr4;
        }
        if (basis !== 'accrual') {
          cashDr += dr4;
          cashCr += cr4;
        }

        let partyId: number | null = null;
        if (l.party_type === 'customer' && l.party_id !== null && l.party_id !== undefined) {
          partyId = getMappedId('customers', l.party_id);
        } else if (l.party_type === 'vendor' && l.party_id !== null && l.party_id !== undefined) {
          partyId = getMappedId('vendors', l.party_id);
        }

        validLines.push({
          order: l.line_order ?? i + 1,
          accountId: aid,
          basis,
          description: l.description ?? null,
          debit4: dr4,
          credit4: cr4,
          classId: getMappedId('classes', l.class_id),
          partyType: l.party_type ?? null,
          partyId,
          isReconciled: Boolean(l.is_reconciled),
        });
      }

      const isPosted = t.is_posted !== false && t.status !== 'draft';
      if (!invalidReason && isPosted && validLines.length === 0) {
        invalidReason = 'Posted journal transaction has zero lines';
      }
      if (!invalidReason && isPosted && accDr !== accCr) {
        invalidReason = `Unbalanced accrual/both journal (debits=${formatDecimal4(accDr)}, credits=${formatDecimal4(accCr)})`;
      }
      if (!invalidReason && isPosted && cashDr !== cashCr) {
        invalidReason = `Unbalanced cash/both journal (debits=${formatDecimal4(cashDr)}, credits=${formatDecimal4(cashCr)})`;
      }

      if (invalidReason) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'transactions',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'INVALID_OR_UNBALANCED_JOURNAL',
          reasonDetail: `Journal ${entryNum} rejected: ${invalidReason}`,
          financialImpact4: absBigInt(accDr - accCr) > 0n ? absBigInt(accDr - accCr) : accDr,
          sourcePayload: t,
        });
        continue;
      }

      const isSoftDeleted = Boolean(t.is_deleted);
      const effectiveStatus = isSoftDeleted ? 'voided' : (t.status || 'posted');
      const effectivePosted = isSoftDeleted ? false : isPosted;
      const srcType = normalizeJournalSourceType(t.source_type);

      const hdr = await tx.query<{ id: number }>(
        `INSERT INTO journal_transactions (
           company_id, entry_number, txn_date, reference, description, memo,
           source_type, source_ref, source_kind, source_difference, class_id,
           status, is_posted, is_adjusting, posted_at, posted_by, created_by, idempotency_key
         ) VALUES (
           $1, $2, $3::DATE, $4, $5, $6,
           $7, $8, $9, $10::NUMERIC(19,4), $11,
           $12, $13, $14, $15::TIMESTAMPTZ, $16, $16, $17
         ) RETURNING id`,
        [
          companyId,
          entryNum,
          isoDateOrDefault(t.txn_date),
          t.reference ?? null,
          t.description ?? null,
          t.memo ?? null,
          srcType,
          t.source_ref ?? null,
          t.source_kind ?? t.source_type ?? null,
          t.source_difference !== null && t.source_difference !== undefined
            ? formatDecimal4(parseDecimal4(t.source_difference))
            : null,
          getMappedId('classes', t.class_id),
          effectiveStatus,
          effectivePosted,
          Boolean(t.is_adjusting),
          effectivePosted ? (t.created_at || new Date().toISOString()) : null,
          actor.userId,
          `mig-je-${companyId}-${sid}`,
        ]
      );
      const txnId = Number(hdr.rows[0].id);

      for (const l of validLines) {
        await tx.query(
          `INSERT INTO journal_lines (
             company_id, transaction_id, line_order, account_id, basis,
             description, debit, credit, class_id, party_type, party_id, is_reconciled
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9, $10, $11, $12
           )`,
          [
            companyId,
            txnId,
            l.order,
            l.accountId,
            l.basis,
            l.description,
            formatDecimal4(l.debit4),
            formatDecimal4(l.credit4),
            l.classId,
            l.partyType,
            l.partyId,
            l.isReconciled,
          ]
        );
      }

      if (isSoftDeleted) {
        arch++;
        await setMapped('transactions', sid, 'journal_transactions', txnId, 'archived_preserved', t);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'transactions',
          sourceId: sid,
          disposition: 'deleted_preserved',
          reasonCode: 'DELETED_JOURNAL_VOIDED',
          reasonDetail: `Soft-deleted journal ${entryNum} preserved in voided/unposted state`,
          sourcePayload: t,
        });
      } else {
        mig++;
        await setMapped('transactions', sid, 'journal_transactions', txnId, 'migrated', t);
      }
    }

    // Pass 2: Link reversal pairs (allowed by trg_prevent_posted_txn_mutation since immutable columns don't change)
    for (const t of srcTxns) {
      const tid = getMappedId('transactions', t.id);
      if (!tid) continue;
      const revTarget = getMappedId('transactions', t.reverses_transaction_id);
      const revByTarget = getMappedId('transactions', t.reversed_by_transaction_id);
      if (revTarget && revTarget !== tid) {
        await tx.query(
          `UPDATE journal_transactions SET reverses_transaction_id = $3 WHERE company_id = $1 AND id = $2`,
          [companyId, tid, revTarget]
        );
      }
      if (revByTarget && revByTarget !== tid) {
        await tx.query(
          `UPDATE journal_transactions SET reversed_by_transaction_id = $3 WHERE company_id = $1 AND id = $2`,
          [companyId, tid, revByTarget]
        );
      }
    }

    await trackCheckpoint(11, 'transactions', { src: srcTxns.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 12: Estimates
  {
    const srcEsts = (bundle.estimates || []).filter(e => String(e.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const e of srcEsts) {
      const sid = String(e.id);
      last = sid;
      if (idMap.has(`estimates::${sid}`)) { mig++; continue; }

      const custId = getMappedId('customers', e.customer_id);
      const sub4 = parseDecimal4(e.subtotal);
      const tax4 = parseDecimal4(e.tax_amount);
      const tot4 = parseDecimal4(e.total);
      if (!custId || sub4 + tax4 !== tot4) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'estimates',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: !custId ? 'UNMAPPED_CUSTOMER' : 'ESTIMATE_MATH_MISMATCH',
          reasonDetail: `Estimate ${e.estimate_number} failed customer or total=subtotal+tax check`,
          financialImpact4: tot4,
          sourcePayload: e,
        });
        continue;
      }

      const dupE = await tx.query<{ id: number }>(
        `SELECT id FROM estimates WHERE company_id = $1 AND estimate_number = $2 LIMIT 1`,
        [companyId, String(e.estimate_number).slice(0, 64)]
      );
      if (dupE.rows.length > 0) {
        dup++;
        await setMapped('estimates', sid, 'estimates', Number(dupE.rows[0].id), 'merged_duplicate', e);
        continue;
      }

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO estimates (
           company_id, estimate_number, customer_id, estimate_date, expiry_date,
           status, subtotal, tax_rate, tax_amount, total, total_cost, notes
         ) VALUES (
           $1, $2, $3, $4::DATE, $5::DATE,
           $6, $7::NUMERIC(19,4), $8::NUMERIC(9,6), $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11::NUMERIC(19,4), $12
         ) RETURNING id`,
        [
          companyId,
          String(e.estimate_number).slice(0, 64),
          custId,
          isoDateOrDefault(e.estimate_date),
          e.expiry_date ? isoDateOrDefault(e.expiry_date) : null,
          ['pending', 'accepted', 'rejected', 'invoiced', 'expired'].includes(e.status) ? e.status : 'pending',
          formatDecimal4(sub4),
          Number(e.tax_rate ?? 0),
          formatDecimal4(tax4),
          formatDecimal4(tot4),
          formatDecimal4(parseDecimal4(e.total_cost ?? 0)),
          e.notes ?? null,
        ]
      );
      const estId = Number(ins.rows[0].id);
      for (let i = 0; i < (e.lines || []).length; i++) {
        const l = e.lines[i];
        await tx.query(
          `INSERT INTO estimate_lines (
             company_id, estimate_id, line_order, item_id, description,
             quantity, unit_cost, rate, amount, taxable, class_id
           ) VALUES ($1, $2, $3, $4, $5, $6::NUMERIC(19,6), $7::NUMERIC(19,6), $8::NUMERIC(19,4), $9::NUMERIC(19,4), $10, $11)`,
          [
            companyId,
            estId,
            i + 1,
            getMappedId('items', l.item_id),
            l.description || 'Estimated Item',
            formatDecimal6(parseDecimal6(l.quantity) > 0n ? parseDecimal6(l.quantity) : 1000000n),
            formatDecimal6(parseDecimal6(l.unit_cost ?? 0)),
            formatDecimal4(parseDecimal4(l.rate)),
            formatDecimal4(parseDecimal4(l.amount)),
            Boolean(l.taxable),
            getMappedId('classes', l.class_id),
          ]
        );
      }
      mig++;
      await setMapped('estimates', sid, 'estimates', estId, 'migrated', e);
    }
    await trackCheckpoint(12, 'estimates', { src: srcEsts.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 13: Invoices & Sales Receipts
  {
    const srcInvs = (bundle.invoices || []).filter(i => String(i.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;

    // Pre-fetch item types to enforce no raw_material on invoice_lines
    const itemTypesRes = await tx.query<{ id: number; item_type: string }>(
      `SELECT id, item_type FROM inventory_items WHERE company_id = $1`,
      [companyId]
    );
    const itemTypeById = new Map<number, string>();
    for (const r of itemTypesRes.rows) itemTypeById.set(Number(r.id), r.item_type);

    for (const inv of srcInvs) {
      const sid = String(inv.id);
      last = sid;
      if (idMap.has(`invoices::${sid}`)) { mig++; continue; }

      const custId = getMappedId('customers', inv.customer_id);
      const invDate = isoDateOrDefault(inv.invoice_date);
      const dueDate = isoDateOrDefault(inv.due_date || invDate, invDate);
      const sub4 = parseDecimal4(inv.subtotal);
      const tax4 = parseDecimal4(inv.tax_amount);
      const tot4 = parseDecimal4(inv.total);
      const paid4 = parseDecimal4(inv.amount_paid);
      const bal4 = parseDecimal4(inv.balance_due);

      let rejectReason: string | null = null;
      if (!custId) rejectReason = `Customer ${inv.customer_id} not mapped`;
      else if (dueDate < invDate) rejectReason = `due_date (${dueDate}) precedes invoice_date (${invDate})`;
      else if (sub4 + tax4 !== tot4) rejectReason = `Total mismatch: subtotal ${formatDecimal4(sub4)} + tax ${formatDecimal4(tax4)} != total ${formatDecimal4(tot4)}`;
      else if (paid4 + bal4 !== tot4) rejectReason = `Balance mismatch: amount_paid ${formatDecimal4(paid4)} + balance_due ${formatDecimal4(bal4)} != total ${formatDecimal4(tot4)}`;

      if (!rejectReason) {
        for (const l of inv.lines || []) {
          const mappedItem = getMappedId('items', l.item_id);
          if (mappedItem && itemTypeById.get(mappedItem) === 'raw_material') {
            rejectReason = `Invoice line references raw_material item ${l.item_id} (forbidden by PMS inventory rules)`;
            break;
          }
        }
      }

      if (rejectReason) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'invoices',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'INVOICE_VALIDATION_FAILED',
          reasonDetail: `Invoice ${inv.invoice_number} rejected: ${rejectReason}`,
          financialImpact4: bal4 > 0n ? bal4 : tot4,
          sourcePayload: inv,
        });
        continue;
      }

      const dupInv = await tx.query<{ id: number }>(
        `SELECT id FROM invoices WHERE company_id = $1 AND invoice_number = $2 LIMIT 1`,
        [companyId, String(inv.invoice_number).slice(0, 64)]
      );
      if (dupInv.rows.length > 0) {
        const tid = Number(dupInv.rows[0].id);
        dup++;
        await setMapped('invoices', sid, 'invoices', tid, 'merged_duplicate', inv);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'invoices',
          sourceId: sid,
          disposition: 'duplicate_merged',
          reasonCode: 'DUPLICATE_INVOICE_NUMBER',
          reasonDetail: `Duplicate invoice "${inv.invoice_number}" merged into #${tid}`,
          sourcePayload: inv,
        });
        continue;
      }

      const isDeleted = Boolean(inv.is_deleted);
      const effStatus = isDeleted
        ? 'voided'
        : ['draft', 'sent', 'partial', 'paid', 'overdue', 'voided'].includes(inv.status)
        ? inv.status
        : 'sent';

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO invoices (
           company_id, invoice_number, customer_id, invoice_date, due_date,
           payment_term_id, terms_label, po_number, status, is_sales_receipt, is_tax_exempt,
           currency_code, exchange_rate, subtotal, tax_rate, tax_amount, total, total_cost,
           amount_paid, balance_due, journal_txn_id, source_estimate_id, class_id, notes
         ) VALUES (
           $1, $2, $3, $4::DATE, $5::DATE,
           $6, $7, $8, $9, $10, $11,
           $12, $13::NUMERIC(19,6), $14::NUMERIC(19,4), $15::NUMERIC(9,6), $16::NUMERIC(19,4),
           $17::NUMERIC(19,4), $18::NUMERIC(19,4), $19::NUMERIC(19,4), $20::NUMERIC(19,4),
           $21, $22, $23, $24
         ) RETURNING id`,
        [
          companyId,
          String(inv.invoice_number).slice(0, 64),
          custId,
          invDate,
          dueDate,
          getMappedId('payment_terms', inv.payment_term_id),
          (inv.terms_label || 'Net 30').slice(0, 60),
          inv.po_number ?? null,
          effStatus,
          Boolean(inv.is_sales_receipt),
          Boolean(inv.is_tax_exempt),
          (inv.currency_code || srcComp.base_currency || 'ZMW').slice(0, 3).toUpperCase(),
          formatDecimal6(parseDecimal6(inv.exchange_rate ?? 1)),
          formatDecimal4(sub4),
          Number(inv.tax_rate ?? 0),
          formatDecimal4(tax4),
          formatDecimal4(tot4),
          formatDecimal4(parseDecimal4(inv.total_cost ?? 0)),
          formatDecimal4(paid4),
          formatDecimal4(bal4),
          getMappedId('transactions', inv.journal_txn_id),
          getMappedId('estimates', inv.source_estimate_id),
          getMappedId('classes', inv.class_id),
          inv.notes ?? null,
        ]
      );
      const invoiceId = Number(ins.rows[0].id);

      for (let i = 0; i < (inv.lines || []).length; i++) {
        const l = inv.lines[i];
        await tx.query(
          `INSERT INTO invoice_lines (
             company_id, invoice_id, line_order, item_id, description,
             quantity, rate, amount, unit_cost, total_cost, taxable, class_id
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6::NUMERIC(19,6), $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9::NUMERIC(19,6), $10::NUMERIC(19,4), $11, $12
           )`,
          [
            companyId,
            invoiceId,
            i + 1,
            getMappedId('items', l.item_id),
            l.description || 'Sales Line',
            formatDecimal6(parseDecimal6(l.quantity) > 0n ? parseDecimal6(l.quantity) : 1000000n),
            formatDecimal4(parseDecimal4(l.rate)),
            formatDecimal4(parseDecimal4(l.amount)),
            formatDecimal6(parseDecimal6(l.unit_cost ?? 0)),
            formatDecimal4(parseDecimal4(l.total_cost ?? 0)),
            Boolean(l.taxable),
            getMappedId('classes', l.class_id),
          ]
        );
      }

      if (isDeleted) {
        arch++;
        await setMapped('invoices', sid, 'invoices', invoiceId, 'archived_preserved', inv);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'invoices',
          sourceId: sid,
          disposition: 'deleted_preserved',
          reasonCode: 'DELETED_INVOICE_VOIDED',
          reasonDetail: `Soft-deleted invoice ${inv.invoice_number} preserved as voided`,
          sourcePayload: inv,
        });
      } else {
        mig++;
        await setMapped('invoices', sid, 'invoices', invoiceId, 'migrated', inv);
      }
    }

    await trackCheckpoint(13, 'invoices', { src: srcInvs.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 14: Customer Payments & Allocations
  {
    const srcPmts = (bundle.payments || []).filter(p => String(p.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const p of srcPmts) {
      const sid = String(p.id);
      last = sid;
      if (idMap.has(`payments::${sid}`)) { mig++; continue; }

      const custId = getMappedId('customers', p.customer_id);
      const depAcct = getMappedId('accounts', p.deposit_to_account_id) ?? acctByCode.get('1010') ?? acctByType.get('Bank');
      const amt4 = parseDecimal4(p.amount);
      if (!custId || !depAcct || amt4 <= 0n) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'payments',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'INVALID_PAYMENT_RECORD',
          reasonDetail: `Payment ${p.payment_number} invalid customer, deposit account, or amount=${p.amount}`,
          financialImpact4: absBigInt(amt4),
          sourcePayload: p,
        });
        continue;
      }

      const dupP = await tx.query<{ id: number }>(
        `SELECT id FROM payments WHERE company_id = $1 AND payment_number = $2 LIMIT 1`,
        [companyId, String(p.payment_number).slice(0, 64)]
      );
      if (dupP.rows.length > 0) {
        dup++;
        await setMapped('payments', sid, 'payments', Number(dupP.rows[0].id), 'merged_duplicate', p);
        continue;
      }

      const isVoidOrDel = Boolean(p.is_voided || p.is_deleted);
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO payments (
           company_id, payment_number, customer_id, payment_date, amount,
           payment_method, reference_number, deposit_to_account_id, is_voided, journal_txn_id, memo
         ) VALUES ($1, $2, $3, $4::DATE, $5::NUMERIC(19,4), $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          companyId,
          String(p.payment_number).slice(0, 64),
          custId,
          isoDateOrDefault(p.payment_date),
          formatDecimal4(amt4),
          normalizePaymentMethod(p.payment_method),
          p.reference_number ?? null,
          depAcct,
          isVoidOrDel,
          getMappedId('transactions', p.journal_txn_id),
          p.memo ?? null,
        ]
      );
      const paymentId = Number(ins.rows[0].id);

      for (const al of p.allocations || []) {
        const invId = getMappedId('invoices', al.invoice_id);
        const alAmt4 = parseDecimal4(al.amount);
        if (!invId || alAmt4 <= 0n) continue;
        await tx.query(
          `INSERT INTO payment_allocations (company_id, payment_id, invoice_id, amount, from_remainder)
           VALUES ($1, $2, $3, $4::NUMERIC(19,4), $5)
           ON CONFLICT (company_id, payment_id, invoice_id) DO NOTHING`,
          [companyId, paymentId, invId, formatDecimal4(alAmt4), Boolean(al.from_remainder)]
        );
      }

      if (p.is_deleted) {
        arch++;
        await setMapped('payments', sid, 'payments', paymentId, 'archived_preserved', p);
      } else {
        mig++;
        await setMapped('payments', sid, 'payments', paymentId, 'migrated', p);
      }
    }
    await trackCheckpoint(14, 'payments', { src: srcPmts.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 15: Credit Memos & Applications
  {
    const srcCms = (bundle.credit_memos || []).filter(c => String(c.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const cm of srcCms) {
      const sid = String(cm.id);
      last = sid;
      if (idMap.has(`credit_memos::${sid}`)) { mig++; continue; }

      const custId = getMappedId('customers', cm.customer_id);
      if (!custId) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'credit_memos',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_CUSTOMER',
          reasonDetail: `Credit memo ${cm.credit_number} references unmapped customer ${cm.customer_id}`,
          sourcePayload: cm,
        });
        continue;
      }

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO credit_memos (
           company_id, credit_number, customer_id, credit_date, status,
           subtotal, tax_rate, tax_amount, total, remaining_credit, journal_txn_id, memo
         ) VALUES (
           $1, $2, $3, $4::DATE, $5,
           $6::NUMERIC(19,4), $7::NUMERIC(9,6), $8::NUMERIC(19,4), $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11, $12
         ) RETURNING id`,
        [
          companyId,
          String(cm.credit_number).slice(0, 64),
          custId,
          isoDateOrDefault(cm.credit_date),
          ['open', 'applied', 'voided'].includes(cm.status) ? cm.status : 'open',
          formatDecimal4(parseDecimal4(cm.subtotal)),
          Number(cm.tax_rate ?? 0),
          formatDecimal4(parseDecimal4(cm.tax_amount)),
          formatDecimal4(parseDecimal4(cm.total)),
          formatDecimal4(parseDecimal4(cm.remaining_credit)),
          getMappedId('transactions', cm.journal_txn_id),
          cm.memo ?? null,
        ]
      );
      const cmId = Number(ins.rows[0].id);
      for (const l of cm.lines || []) {
        await tx.query(
          `INSERT INTO credit_memo_lines (company_id, credit_memo_id, item_id, description, quantity, rate, amount, class_id)
           VALUES ($1, $2, $3, $4, $5::NUMERIC(19,6), $6::NUMERIC(19,4), $7::NUMERIC(19,4), $8)`,
          [
            companyId,
            cmId,
            getMappedId('items', l.item_id),
            l.description || 'Credit line',
            formatDecimal6(parseDecimal6(l.quantity) > 0n ? parseDecimal6(l.quantity) : 1000000n),
            formatDecimal4(parseDecimal4(l.rate)),
            formatDecimal4(parseDecimal4(l.amount)),
            getMappedId('classes', l.class_id),
          ]
        );
      }
      for (const app of cm.applications || []) {
        const invId = getMappedId('invoices', app.invoice_id);
        const amt4 = parseDecimal4(app.amount);
        if (!invId || amt4 <= 0n) continue;
        await tx.query(
          `INSERT INTO credit_applications (company_id, credit_memo_id, invoice_id, amount, applied_date)
           VALUES ($1, $2, $3, $4::NUMERIC(19,4), $5::DATE)`,
          [companyId, cmId, invId, formatDecimal4(amt4), isoDateOrDefault(app.applied_date || cm.credit_date)]
        );
      }
      mig++;
      await setMapped('credit_memos', sid, 'credit_memos', cmId, 'migrated', cm);
    }
    await trackCheckpoint(15, 'credit_memos', { src: srcCms.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 16: Recurring Invoices
  {
    const srcRec = (bundle.recurring_invoices || []).filter(r => String(r.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const r of srcRec) {
      const sid = String(r.id);
      last = sid;
      if (idMap.has(`recurring_invoices::${sid}`)) { mig++; continue; }
      const custId = getMappedId('customers', r.customer_id);
      if (!custId) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'recurring_invoices',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_CUSTOMER',
          reasonDetail: `Recurring invoice ${sid} references unmapped customer ${r.customer_id}`,
          sourcePayload: r,
        });
        continue;
      }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO recurring_invoices (
           company_id, customer_id, frequency, start_date, end_date, next_due, is_active, tax_rate, notes
         ) VALUES ($1, $2, $3, $4::DATE, $5::DATE, $6::DATE, $7, $8::NUMERIC(9,6), $9)
         RETURNING id`,
        [
          companyId,
          custId,
          r.frequency,
          isoDateOrDefault(r.start_date),
          r.end_date ? isoDateOrDefault(r.end_date) : null,
          isoDateOrDefault(r.next_due),
          r.is_active !== false,
          Number(r.tax_rate ?? 0),
          r.notes ?? null,
        ]
      );
      const recId = Number(ins.rows[0].id);
      for (let i = 0; i < (r.lines || []).length; i++) {
        const l = r.lines[i];
        await tx.query(
          `INSERT INTO recurring_invoice_lines (
             company_id, recurring_invoice_id, item_id, description, quantity, rate, is_taxable, line_order
           ) VALUES ($1, $2, $3, $4, $5::NUMERIC(19,6), $6::NUMERIC(19,4), $7, $8)`,
          [
            companyId,
            recId,
            getMappedId('items', l.item_id),
            l.description,
            formatDecimal6(parseDecimal6(l.quantity) > 0n ? parseDecimal6(l.quantity) : 1000000n),
            formatDecimal4(parseDecimal4(l.rate)),
            Boolean(l.is_taxable),
            i + 1,
          ]
        );
      }
      if (r.is_active === false) {
        arch++;
        await setMapped('recurring_invoices', sid, 'recurring_invoices', recId, 'archived_preserved', r);
      } else {
        mig++;
        await setMapped('recurring_invoices', sid, 'recurring_invoices', recId, 'migrated', r);
      }
    }
    await trackCheckpoint(16, 'recurring_invoices', { src: srcRec.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 17: Purchase Orders
  {
    const srcPos = (bundle.purchase_orders || []).filter(p => String(p.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const po of srcPos) {
      const sid = String(po.id);
      last = sid;
      if (idMap.has(`purchase_orders::${sid}`)) { mig++; continue; }
      const vendId = getMappedId('vendors', po.vendor_id);
      if (!vendId) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'purchase_orders',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_VENDOR',
          reasonDetail: `Purchase order ${po.po_number} references unmapped vendor ${po.vendor_id}`,
          sourcePayload: po,
        });
        continue;
      }
      const status = ['draft', 'open', 'partially_received', 'closed', 'cancelled'].includes(po.status)
        ? po.status
        : 'open';
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO purchase_orders (
           company_id, po_number, vendor_id, po_date, expected_date, status, total, notes
         ) VALUES ($1, $2, $3, $4::DATE, $5::DATE, $6, $7::NUMERIC(19,4), $8)
         RETURNING id`,
        [
          companyId,
          String(po.po_number).slice(0, 64),
          vendId,
          isoDateOrDefault(po.po_date),
          po.expected_date ? isoDateOrDefault(po.expected_date) : null,
          status,
          formatDecimal4(parseDecimal4(po.total)),
          po.notes ?? null,
        ]
      );
      const poId = Number(ins.rows[0].id);
      for (let i = 0; i < (po.lines || []).length; i++) {
        const l = po.lines[i];
        await tx.query(
          `INSERT INTO purchase_order_lines (
             company_id, purchase_order_id, line_order, item_id, account_id,
             description, quantity, received_qty, rate, amount, class_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(19,6), $8::NUMERIC(19,6), $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11)`,
          [
            companyId,
            poId,
            i + 1,
            getMappedId('items', l.item_id),
            getMappedId('accounts', l.account_id),
            l.description || 'PO Line',
            formatDecimal6(parseDecimal6(l.quantity) > 0n ? parseDecimal6(l.quantity) : 1000000n),
            formatDecimal6(parseDecimal6(l.received_qty ?? 0)),
            formatDecimal4(parseDecimal4(l.rate)),
            formatDecimal4(parseDecimal4(l.amount)),
            getMappedId('classes', l.class_id),
          ]
        );
      }
      mig++;
      await setMapped('purchase_orders', sid, 'purchase_orders', poId, 'migrated', po);
    }
    await trackCheckpoint(17, 'purchase_orders', { src: srcPos.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 18: Bills
  {
    const srcBills = (bundle.bills || []).filter(b => String(b.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const b of srcBills) {
      const sid = String(b.id);
      last = sid;
      if (idMap.has(`bills::${sid}`)) { mig++; continue; }

      const vendId = getMappedId('vendors', b.vendor_id);
      const billDate = isoDateOrDefault(b.bill_date);
      const dueDate = isoDateOrDefault(b.due_date || billDate, billDate);
      const tot4 = parseDecimal4(b.total);
      const paid4 = parseDecimal4(b.amount_paid);
      const bal4 = parseDecimal4(b.balance_due);

      let rejectReason: string | null = null;
      if (!vendId) rejectReason = `Vendor ${b.vendor_id} not mapped`;
      else if (dueDate < billDate) rejectReason = `due_date (${dueDate}) precedes bill_date (${billDate})`;
      else if (paid4 + bal4 !== tot4) rejectReason = `Balance math mismatch: amount_paid (${formatDecimal4(paid4)}) + balance_due (${formatDecimal4(bal4)}) != total (${formatDecimal4(tot4)})`;

      if (rejectReason) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'bills',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'BILL_VALIDATION_FAILED',
          reasonDetail: `Bill ${b.bill_number} rejected: ${rejectReason}`,
          financialImpact4: bal4 > 0n ? bal4 : tot4,
          sourcePayload: b,
        });
        continue;
      }

      const dupB = await tx.query<{ id: number }>(
        `SELECT id FROM bills WHERE company_id = $1 AND vendor_id = $2 AND bill_number = $3 LIMIT 1`,
        [companyId, vendId, String(b.bill_number).slice(0, 64)]
      );
      if (dupB.rows.length > 0) {
        dup++;
        await setMapped('bills', sid, 'bills', Number(dupB.rows[0].id), 'merged_duplicate', b);
        continue;
      }

      const isDeleted = Boolean(b.is_deleted);
      const effStatus = isDeleted
        ? 'voided'
        : ['open', 'partial', 'paid', 'overdue', 'voided'].includes(b.status)
        ? b.status
        : 'open';

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO bills (
           company_id, bill_number, vendor_id, bill_date, due_date,
           payment_term_id, terms_label, status, total, amount_paid, balance_due,
           journal_txn_id, purchase_order_id, memo
         ) VALUES (
           $1, $2, $3, $4::DATE, $5::DATE,
           $6, $7, $8, $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11::NUMERIC(19,4),
           $12, $13, $14
         ) RETURNING id`,
        [
          companyId,
          String(b.bill_number).slice(0, 64),
          vendId,
          billDate,
          dueDate,
          getMappedId('payment_terms', b.payment_term_id),
          (b.terms_label || 'Net 30').slice(0, 60),
          effStatus,
          formatDecimal4(tot4),
          formatDecimal4(paid4),
          formatDecimal4(bal4),
          getMappedId('transactions', b.journal_txn_id),
          getMappedId('purchase_orders', b.purchase_order_id),
          b.memo ?? null,
        ]
      );
      const billId = Number(ins.rows[0].id);

      for (let i = 0; i < (b.lines || []).length; i++) {
        const l = b.lines[i];
        const acctId = getMappedId('accounts', l.account_id) ?? defaultCogsId;
        await tx.query(
          `INSERT INTO bill_lines (
             company_id, bill_id, line_order, account_id, item_id,
             description, quantity, unit_cost, amount, use_tax_rate, class_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(19,6), $8::NUMERIC(19,6), $9::NUMERIC(19,4), $10::NUMERIC(9,6), $11)`,
          [
            companyId,
            billId,
            i + 1,
            acctId,
            getMappedId('items', l.item_id),
            l.description || 'Bill Line',
            formatDecimal6(parseDecimal6(l.quantity) > 0n ? parseDecimal6(l.quantity) : 1000000n),
            formatDecimal6(parseDecimal6(l.unit_cost ?? 0)),
            formatDecimal4(parseDecimal4(l.amount)),
            Number(l.use_tax_rate ?? 0),
            getMappedId('classes', l.class_id),
          ]
        );
      }

      if (isDeleted) {
        arch++;
        await setMapped('bills', sid, 'bills', billId, 'archived_preserved', b);
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'bills',
          sourceId: sid,
          disposition: 'deleted_preserved',
          reasonCode: 'DELETED_BILL_VOIDED',
          reasonDetail: `Soft-deleted bill ${b.bill_number} preserved as voided`,
          sourcePayload: b,
        });
      } else {
        mig++;
        await setMapped('bills', sid, 'bills', billId, 'migrated', b);
      }
    }
    await trackCheckpoint(18, 'bills', { src: srcBills.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 19: Bill Payments & Allocations
  {
    const srcBps = (bundle.bill_payments || []).filter(bp => String(bp.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const bp of srcBps) {
      const sid = String(bp.id);
      last = sid;
      if (idMap.has(`bill_payments::${sid}`)) { mig++; continue; }

      const vendId = getMappedId('vendors', bp.vendor_id);
      const bankAcct = getMappedId('accounts', bp.bank_account_id) ?? acctByCode.get('1010') ?? acctByType.get('Bank');
      const amt4 = parseDecimal4(bp.amount);
      if (!vendId || !bankAcct || amt4 <= 0n) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'bill_payments',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'INVALID_BILL_PAYMENT',
          reasonDetail: `Bill payment ${bp.payment_number} invalid vendor, bank account, or amount`,
          financialImpact4: absBigInt(amt4),
          sourcePayload: bp,
        });
        continue;
      }

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO bill_payments (
           company_id, payment_number, vendor_id, payment_date, amount,
           bank_account_id, check_number, is_voided, journal_txn_id, memo
         ) VALUES ($1, $2, $3, $4::DATE, $5::NUMERIC(19,4), $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          companyId,
          String(bp.payment_number).slice(0, 64),
          vendId,
          isoDateOrDefault(bp.payment_date),
          formatDecimal4(amt4),
          bankAcct,
          bp.check_number ?? null,
          Boolean(bp.is_voided),
          getMappedId('transactions', bp.journal_txn_id),
          bp.memo ?? null,
        ]
      );
      const bpId = Number(ins.rows[0].id);
      for (const al of bp.allocations || []) {
        const billId = getMappedId('bills', al.bill_id);
        const alAmt4 = parseDecimal4(al.amount);
        if (!billId || alAmt4 <= 0n) continue;
        await tx.query(
          `INSERT INTO bill_payment_allocations (company_id, bill_payment_id, bill_id, amount)
           VALUES ($1, $2, $3, $4::NUMERIC(19,4))
           ON CONFLICT (company_id, bill_payment_id, bill_id) DO NOTHING`,
          [companyId, bpId, billId, formatDecimal4(alAmt4)]
        );
      }
      mig++;
      await setMapped('bill_payments', sid, 'bill_payments', bpId, 'migrated', bp);
    }
    await trackCheckpoint(19, 'bill_payments', { src: srcBps.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 20: Vendor Credits
  {
    const srcVcs = (bundle.vendor_credits || []).filter(vc => String(vc.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;
    for (const vc of srcVcs) {
      const sid = String(vc.id);
      last = sid;
      if (idMap.has(`vendor_credits::${sid}`)) { mig++; continue; }

      const vendId = getMappedId('vendors', vc.vendor_id);
      if (!vendId) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'vendor_credits',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_VENDOR',
          reasonDetail: `Vendor credit ${vc.credit_number} references unmapped vendor ${vc.vendor_id}`,
          sourcePayload: vc,
        });
        continue;
      }

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO vendor_credits (
           company_id, credit_number, vendor_id, original_bill_id, credit_date,
           status, total, remaining_credit, journal_txn_id, memo
         ) VALUES (
           $1, $2, $3, $4, $5::DATE,
           $6, $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9, $10
         ) RETURNING id`,
        [
          companyId,
          String(vc.credit_number).slice(0, 64),
          vendId,
          getMappedId('bills', vc.original_bill_id),
          isoDateOrDefault(vc.credit_date),
          ['open', 'applied', 'voided'].includes(vc.status) ? vc.status : 'open',
          formatDecimal4(parseDecimal4(vc.total)),
          formatDecimal4(parseDecimal4(vc.remaining_credit)),
          getMappedId('transactions', vc.journal_txn_id),
          vc.memo ?? null,
        ]
      );
      const vcId = Number(ins.rows[0].id);
      for (const l of vc.lines || []) {
        await tx.query(
          `INSERT INTO vendor_credit_lines (
             company_id, vendor_credit_id, account_id, item_id, description, quantity, rate, amount, class_id
           ) VALUES ($1, $2, $3, $4, $5, $6::NUMERIC(19,6), $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9)`,
          [
            companyId,
            vcId,
            getMappedId('accounts', l.account_id) ?? defaultCogsId,
            getMappedId('items', l.item_id),
            l.description || 'Vendor Credit Line',
            formatDecimal6(parseDecimal6(l.quantity) > 0n ? parseDecimal6(l.quantity) : 1000000n),
            formatDecimal4(parseDecimal4(l.rate)),
            formatDecimal4(parseDecimal4(l.amount)),
            getMappedId('classes', l.class_id),
          ]
        );
      }
      for (const app of vc.applications || []) {
        const billId = getMappedId('bills', app.bill_id);
        const amt4 = parseDecimal4(app.amount);
        if (!billId || amt4 <= 0n) continue;
        await tx.query(
          `INSERT INTO vendor_credit_applications (company_id, vendor_credit_id, bill_id, amount, applied_date)
           VALUES ($1, $2, $3, $4::NUMERIC(19,4), $5::DATE)`,
          [companyId, vcId, billId, formatDecimal4(amt4), isoDateOrDefault(app.applied_date || vc.credit_date)]
        );
      }
      mig++;
      await setMapped('vendor_credits', sid, 'vendor_credits', vcId, 'migrated', vc);
    }
    await trackCheckpoint(20, 'vendor_credits', { src: srcVcs.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 21: Bank Accounts, Reconciliations, Bank Transactions & Rules
  {
    const srcBas = (bundle.bank_accounts || []).filter(ba => String(ba.company_id) === sCompId);
    const srcRecons = (bundle.reconciliations || []).filter(r => String(r.company_id) === sCompId);
    const srcBtxns = (bundle.bank_transactions || []).filter(bt => String(bt.company_id) === sCompId);
    const srcRules = (bundle.bank_rules || []).filter(br => String(br.company_id) === sCompId);

    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;

    for (const ba of srcBas) {
      const sid = String(ba.id);
      last = sid;
      if (idMap.has(`bank_accounts::${sid}`)) { mig++; continue; }
      const glId = getMappedId('accounts', ba.gl_account_id);
      if (!glId) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'bank_accounts',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_GL_ACCOUNT',
          reasonDetail: `Bank account "${ba.institution_name}" references unmapped GL account ${ba.gl_account_id}`,
          sourcePayload: ba,
        });
        continue;
      }
      const fp = ['manual', 'simplefin', 'mercury', 'ofx', 'csv'].includes(ba.feed_provider || '') ? ba.feed_provider! : 'manual';
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO bank_accounts (
           company_id, gl_account_id, institution_name, account_mask, feed_provider, next_check_number, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, gl_account_id)
         DO UPDATE SET institution_name = EXCLUDED.institution_name
         RETURNING id`,
        [
          companyId,
          glId,
          String(ba.institution_name).slice(0, 150),
          ba.account_mask ? String(ba.account_mask).slice(0, 12) : null,
          fp,
          Math.max(1, Number(ba.next_check_number ?? 1001)),
          ba.is_active !== false,
        ]
      );
      mig++;
      await setMapped('bank_accounts', sid, 'bank_accounts', Number(ins.rows[0].id), 'migrated', ba);
    }

    for (const r of srcRecons) {
      const sid = String(r.id);
      last = sid;
      if (idMap.has(`reconciliations::${sid}`)) { mig++; continue; }
      const acctId = getMappedId('accounts', r.account_id);
      const diff4 = parseDecimal4(r.difference);
      if (!acctId || diff4 !== 0n) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'reconciliations',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'INVALID_RECONCILIATION',
          reasonDetail: `Reconciliation ${sid} has non-zero difference ${r.difference} or unmapped account`,
          financialImpact4: absBigInt(diff4),
          sourcePayload: r,
        });
        continue;
      }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO reconciliations (
           company_id, account_id, bank_account_id, statement_date,
           statement_ending_balance, beginning_balance, cleared_total, difference, status, completed_at
         ) VALUES (
           $1, $2, $3, $4::DATE,
           $5::NUMERIC(19,4), $6::NUMERIC(19,4), $7::NUMERIC(19,4), 0.0000, $8, COALESCE($9::TIMESTAMPTZ, NOW())
         ) RETURNING id`,
        [
          companyId,
          acctId,
          getMappedId('bank_accounts', r.bank_account_id),
          isoDateOrDefault(r.statement_date),
          formatDecimal4(parseDecimal4(r.statement_ending_balance)),
          formatDecimal4(parseDecimal4(r.beginning_balance)),
          formatDecimal4(parseDecimal4(r.cleared_total)),
          r.status === 'reversed' ? 'reversed' : 'completed',
          r.completed_at || null,
        ]
      );
      mig++;
      await setMapped('reconciliations', sid, 'reconciliations', Number(ins.rows[0].id), 'migrated', r);
    }

    for (const bt of srcBtxns) {
      const sid = String(bt.id);
      last = sid;
      if (idMap.has(`bank_transactions::${sid}`)) { mig++; continue; }
      const acctId = getMappedId('accounts', bt.account_id);
      if (!acctId) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'bank_transactions',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_BANK_ACCOUNT',
          reasonDetail: `Bank txn ${sid} references unmapped GL account ${bt.account_id}`,
          financialImpact4: absBigInt(parseDecimal4(bt.amount)),
          sourcePayload: bt,
        });
        continue;
      }

      if (bt.external_fitid) {
        const dupFit = await tx.query<{ id: number }>(
          `SELECT id FROM bank_transactions WHERE company_id = $1 AND account_id = $2 AND external_fitid = $3 LIMIT 1`,
          [companyId, acctId, bt.external_fitid]
        );
        if (dupFit.rows.length > 0) {
          dup++;
          await setMapped('bank_transactions', sid, 'bank_transactions', Number(dupFit.rows[0].id), 'merged_duplicate', bt);
          continue;
        }
      }

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO bank_transactions (
           company_id, account_id, bank_account_id, txn_date, payee, txn_type,
           ref_number, memo, amount, running_balance, is_cleared,
           reconciliation_id, journal_txn_id, external_fitid, category, status
         ) VALUES (
           $1, $2, $3, $4::DATE, $5, $6,
           $7, $8, $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11,
           $12, $13, $14, $15, $16
         ) RETURNING id`,
        [
          companyId,
          acctId,
          getMappedId('bank_accounts', bt.bank_account_id),
          isoDateOrDefault(bt.txn_date),
          String(bt.payee || 'Payee').slice(0, 200),
          normalizeBankTxnType(bt.txn_type),
          bt.ref_number ?? null,
          bt.memo ?? null,
          formatDecimal4(parseDecimal4(bt.amount)),
          formatDecimal4(parseDecimal4(bt.running_balance ?? 0)),
          Boolean(bt.is_cleared),
          getMappedId('reconciliations', bt.reconciliation_id),
          getMappedId('transactions', bt.journal_txn_id),
          bt.external_fitid ?? null,
          bt.category ?? null,
          bt.status === 'pending_import' || bt.status === 'voided' ? bt.status : 'posted',
        ]
      );
      const btId = Number(ins.rows[0].id);
      if (bt.check_number || bt.print_later) {
        await tx.query(
          `INSERT INTO bank_check_details (company_id, bank_txn_id, check_number, print_later)
           VALUES ($1, $2, $3, $4)`,
          [companyId, btId, bt.check_number ?? null, Boolean(bt.print_later)]
        );
      }
      mig++;
      await setMapped('bank_transactions', sid, 'bank_transactions', btId, 'migrated', bt);
    }

    for (const br of srcRules) {
      const sid = String(br.id);
      last = sid;
      if (idMap.has(`bank_rules::${sid}`)) { mig++; continue; }
      const targetAcct = getMappedId('accounts', br.target_account_id);
      if (!targetAcct) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'bank_rules',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_TARGET_ACCOUNT',
          reasonDetail: `Bank rule "${br.name}" references unmapped target_account_id=${br.target_account_id}`,
          sourcePayload: br,
        });
        continue;
      }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO bank_rules (
           company_id, name, match_field, match_pattern, target_account_id,
           default_vendor_id, default_customer_id, default_class_id, priority, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          companyId,
          String(br.name).slice(0, 120),
          ['payee', 'memo', 'amount'].includes(br.match_field) ? br.match_field : 'payee',
          String(br.match_pattern).slice(0, 200),
          targetAcct,
          getMappedId('vendors', br.default_vendor_id),
          getMappedId('customers', br.default_customer_id),
          getMappedId('classes', br.default_class_id),
          Number(br.priority ?? 10),
          br.is_active !== false,
        ]
      );
      mig++;
      await setMapped('bank_rules', sid, 'bank_rules', Number(ins.rows[0].id), 'migrated', br);
    }

    await trackCheckpoint(21, 'banking', {
      src: srcBas.length + srcRecons.length + srcBtxns.length + srcRules.length,
      mig,
      dup,
      arch,
      rej,
      last,
    });
  }

  // Checkpoint 22: Payroll & HR (employees, benefit_codes, employee_benefits, pay_runs, pay_stubs, pto, time_entries)
  {
    const srcEmps = (bundle.employees || []).filter(e => String(e.company_id) === sCompId);
    const srcBenefits = (bundle.benefit_codes || []).filter(b => String(b.company_id) === sCompId);
    const srcEmpBenefits = (bundle.employee_benefits || []).filter(b => String(b.company_id) === sCompId);
    const srcRuns = (bundle.pay_runs || []).filter(r => String(r.company_id) === sCompId);
    const srcPtoPol = (bundle.pto_policies || []).filter(p => String(p.company_id) === sCompId);
    const srcPtoAcc = (bundle.pto_accruals || []).filter(a => String(a.company_id) === sCompId);
    const srcTime = (bundle.time_entries || []).filter(t => String(t.company_id) === sCompId);

    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;

    for (const e of srcEmps) {
      const sid = String(e.id);
      last = sid;
      if (idMap.has(`employees::${sid}`)) { mig++; continue; }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO employees (
           company_id, first_name, last_name, job_title, department, email, phone,
           ssn_last4_masked, hire_date, termination_date, pay_type, pay_rate,
           pay_frequency, filing_status, w4_allowances, is_active
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9::DATE, $10::DATE, $11, $12::NUMERIC(19,4),
           $13, $14, $15, $16
         ) RETURNING id`,
        [
          companyId,
          String(e.first_name).slice(0, 100),
          String(e.last_name).slice(0, 100),
          e.job_title ?? null,
          e.department ?? null,
          e.email ?? null,
          e.phone ?? null,
          e.ssn_last4_masked ?? null,
          isoDateOrDefault(e.hire_date),
          e.termination_date ? isoDateOrDefault(e.termination_date) : null,
          e.pay_type === 'salary' ? 'salary' : 'hourly',
          formatDecimal4(parseDecimal4(e.pay_rate)),
          ['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(e.pay_frequency) ? e.pay_frequency : 'monthly',
          ['single', 'married', 'head_of_household'].includes(e.filing_status || '') ? e.filing_status! : 'single',
          Math.max(0, Number(e.w4_allowances ?? 0)),
          e.is_active !== false,
        ]
      );
      const empId = Number(ins.rows[0].id);
      for (const ba of e.bank_accounts || []) {
        await tx.query(
          `INSERT INTO employee_bank_accounts (
             company_id, employee_id, routing_number, account_masked, account_kind, split_percent, is_primary
           ) VALUES ($1, $2, $3, $4, $5, $6::NUMERIC(7,4), $7)`,
          [
            companyId,
            empId,
            String(ba.routing_number).slice(0, 20),
            String(ba.account_masked).slice(0, 24),
            ba.account_kind === 'savings' ? 'savings' : 'checking',
            Number(ba.split_percent ?? 100),
            ba.is_primary !== false,
          ]
        );
      }
      if (e.is_active === false) {
        arch++;
        await setMapped('employees', sid, 'employees', empId, 'archived_preserved', e);
      } else {
        mig++;
        await setMapped('employees', sid, 'employees', empId, 'migrated', e);
      }
    }

    for (const bc of srcBenefits) {
      const sid = String(bc.id);
      if (idMap.has(`benefit_codes::${sid}`)) { mig++; continue; }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO benefit_codes (
           company_id, code, name, kind, calc_method, liability_acct_id, expense_acct_id, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [
          companyId,
          String(bc.code).slice(0, 32),
          String(bc.name).slice(0, 140),
          bc.kind,
          bc.calc_method,
          getMappedId('accounts', bc.liability_acct_id),
          getMappedId('accounts', bc.expense_acct_id),
          bc.is_active !== false,
        ]
      );
      mig++;
      await setMapped('benefit_codes', sid, 'benefit_codes', Number(ins.rows[0].id), 'migrated', bc);
    }

    for (const eb of srcEmpBenefits) {
      const empId = getMappedId('employees', eb.employee_id);
      const bcId = getMappedId('benefit_codes', eb.benefit_code_id);
      if (!empId || !bcId) continue;
      await tx.query(
        `INSERT INTO employee_benefits (
           company_id, employee_id, benefit_code_id, employee_rate, employer_rate, ytd_employee, ytd_employer
         ) VALUES ($1, $2, $3, $4::NUMERIC(19,4), $5::NUMERIC(19,4), $6::NUMERIC(19,4), $7::NUMERIC(19,4))
         ON CONFLICT (company_id, employee_id, benefit_code_id) DO NOTHING`,
        [
          companyId,
          empId,
          bcId,
          formatDecimal4(parseDecimal4(eb.employee_rate)),
          formatDecimal4(parseDecimal4(eb.employer_rate)),
          formatDecimal4(parseDecimal4(eb.ytd_employee ?? 0)),
          formatDecimal4(parseDecimal4(eb.ytd_employer ?? 0)),
        ]
      );
    }

    for (const pr of srcRuns) {
      const sid = String(pr.id);
      last = sid;
      if (idMap.has(`pay_runs::${sid}`)) { mig++; continue; }
      const bankAcct = getMappedId('accounts', pr.bank_account_id) ?? acctByCode.get('1010') ?? acctByType.get('Bank');
      if (!bankAcct) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'pay_runs',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_BANK_ACCOUNT',
          reasonDetail: `Pay run ${pr.run_number} references unmapped bank account ${pr.bank_account_id}`,
          sourcePayload: pr,
        });
        continue;
      }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO pay_runs (
           company_id, run_number, pay_period_start, pay_period_end, pay_date,
           bank_account_id, total_gross, total_net, total_employee_taxes, total_employer_taxes,
           status, journal_txn_id
         ) VALUES (
           $1, $2, $3::DATE, $4::DATE, $5::DATE,
           $6, $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9::NUMERIC(19,4), $10::NUMERIC(19,4),
           $11, $12
         ) RETURNING id`,
        [
          companyId,
          String(pr.run_number).slice(0, 64),
          isoDateOrDefault(pr.pay_period_start),
          isoDateOrDefault(pr.pay_period_end),
          isoDateOrDefault(pr.pay_date),
          bankAcct,
          formatDecimal4(parseDecimal4(pr.total_gross)),
          formatDecimal4(parseDecimal4(pr.total_net)),
          formatDecimal4(parseDecimal4(pr.total_employee_taxes)),
          formatDecimal4(parseDecimal4(pr.total_employer_taxes)),
          ['draft', 'processed', 'voided'].includes(pr.status) ? pr.status : 'processed',
          getMappedId('transactions', pr.journal_txn_id),
        ]
      );
      const runId = Number(ins.rows[0].id);
      for (const st of pr.stubs || []) {
        const empId = getMappedId('employees', st.employee_id);
        if (!empId) continue;
        await tx.query(
          `INSERT INTO pay_stubs (
             company_id, pay_run_id, employee_id, hours_regular, hours_overtime,
             gross_pay, federal_tax, state_tax, ss_employee, medicare_employee, net_pay,
             ss_employer, medicare_employer, futa_employer, suta_employer
           ) VALUES (
             $1, $2, $3, $4::NUMERIC(10,4), $5::NUMERIC(10,4),
             $6::NUMERIC(19,4), $7::NUMERIC(19,4), $8::NUMERIC(19,4), $9::NUMERIC(19,4), $10::NUMERIC(19,4), $11::NUMERIC(19,4),
             $12::NUMERIC(19,4), $13::NUMERIC(19,4), $14::NUMERIC(19,4), $15::NUMERIC(19,4)
           ) ON CONFLICT (company_id, pay_run_id, employee_id) DO NOTHING`,
          [
            companyId,
            runId,
            empId,
            formatDecimal4(parseDecimal4(st.hours_regular ?? 0)),
            formatDecimal4(parseDecimal4(st.hours_overtime ?? 0)),
            formatDecimal4(parseDecimal4(st.gross_pay)),
            formatDecimal4(parseDecimal4(st.federal_tax ?? 0)),
            formatDecimal4(parseDecimal4(st.state_tax ?? 0)),
            formatDecimal4(parseDecimal4(st.ss_employee ?? 0)),
            formatDecimal4(parseDecimal4(st.medicare_employee ?? 0)),
            formatDecimal4(parseDecimal4(st.net_pay)),
            formatDecimal4(parseDecimal4(st.ss_employer ?? 0)),
            formatDecimal4(parseDecimal4(st.medicare_employer ?? 0)),
            formatDecimal4(parseDecimal4(st.futa_employer ?? 0)),
            formatDecimal4(parseDecimal4(st.suta_employer ?? 0)),
          ]
        );
      }
      mig++;
      await setMapped('pay_runs', sid, 'pay_runs', runId, 'migrated', pr);
    }

    for (const pol of srcPtoPol) {
      const sid = String(pol.id);
      if (idMap.has(`pto_policies::${sid}`)) { mig++; continue; }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO pto_policies (company_id, name, pto_type, accrual_method, accrual_rate, max_balance)
         VALUES ($1, $2, $3, $4, $5::NUMERIC(10,4), $6::NUMERIC(10,2)) RETURNING id`,
        [companyId, String(pol.name).slice(0, 120), pol.pto_type, pol.accrual_method, Number(pol.accrual_rate), pol.max_balance ?? null]
      );
      mig++;
      await setMapped('pto_policies', sid, 'pto_policies', Number(ins.rows[0].id), 'migrated', pol);
    }

    for (const acc of srcPtoAcc) {
      const empId = getMappedId('employees', acc.employee_id);
      const polId = getMappedId('pto_policies', acc.policy_id);
      if (!empId || !polId) continue;
      await tx.query(
        `INSERT INTO pto_accruals (company_id, employee_id, policy_id, balance_hrs, accrued_ytd, used_ytd)
         VALUES ($1, $2, $3, $4::NUMERIC(10,4), $5::NUMERIC(10,4), $6::NUMERIC(10,4))
         ON CONFLICT (company_id, employee_id, policy_id) DO NOTHING`,
        [
          companyId,
          empId,
          polId,
          formatDecimal4(parseDecimal4(acc.balance_hrs)),
          formatDecimal4(parseDecimal4(acc.accrued_ytd ?? 0)),
          formatDecimal4(parseDecimal4(acc.used_ytd ?? 0)),
        ]
      );
    }

    for (const te of srcTime) {
      const sid = String(te.id);
      if (idMap.has(`time_entries::${sid}`)) { mig++; continue; }
      const empId = getMappedId('employees', te.employee_id);
      if (!empId) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'time_entries',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_EMPLOYEE',
          reasonDetail: `Time entry ${sid} references unmapped employee ${te.employee_id}`,
          sourcePayload: te,
        });
        continue;
      }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO time_entries (company_id, employee_id, entry_date, hours_regular, hours_overtime, status, notes)
         VALUES ($1, $2, $3::DATE, $4::NUMERIC(8,4), $5::NUMERIC(8,4), $6, $7) RETURNING id`,
        [
          companyId,
          empId,
          isoDateOrDefault(te.entry_date),
          formatDecimal4(parseDecimal4(te.hours_regular)),
          formatDecimal4(parseDecimal4(te.hours_overtime ?? 0)),
          ['draft', 'submitted', 'approved', 'paid'].includes(te.status || '') ? te.status! : 'submitted',
          te.notes ?? null,
        ]
      );
      mig++;
      await setMapped('time_entries', sid, 'time_entries', Number(ins.rows[0].id), 'migrated', te);
    }

    await trackCheckpoint(22, 'payroll_and_hr', {
      src: srcEmps.length + srcBenefits.length + srcRuns.length + srcPtoPol.length + srcTime.length,
      mig,
      dup,
      arch,
      rej,
      last,
    });
  }

  // Checkpoint 23: Fixed Assets
  {
    const srcTypes = (bundle.fixed_asset_types || []).filter(t => String(t.company_id) === sCompId);
    const srcAssets = (bundle.fixed_assets || []).filter(a => String(a.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;

    for (const ft of srcTypes) {
      const sid = String(ft.id);
      last = sid;
      if (idMap.has(`fixed_asset_types::${sid}`)) { mig++; continue; }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO fixed_asset_types (
           company_id, name, asset_account_id, accum_depr_account_id, depr_expense_account_id,
           depreciation_method, effective_life_years, annual_rate
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (company_id, LOWER(name)) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [
          companyId,
          String(ft.name).slice(0, 120),
          getMappedId('accounts', ft.asset_account_id),
          getMappedId('accounts', ft.accum_depr_account_id),
          getMappedId('accounts', ft.depr_expense_account_id),
          ft.depreciation_method === 'declining_balance' ? 'declining_balance' : 'straight_line',
          ft.effective_life_years ?? null,
          ft.annual_rate ?? null,
        ]
      );
      mig++;
      await setMapped('fixed_asset_types', sid, 'fixed_asset_types', Number(ins.rows[0].id), 'migrated', ft);
    }

    for (const fa of srcAssets) {
      const sid = String(fa.id);
      last = sid;
      if (idMap.has(`fixed_assets::${sid}`)) { mig++; continue; }
      const typeId = getMappedId('fixed_asset_types', fa.asset_type_id);
      const price4 = parseDecimal4(fa.purchase_price);
      const salv4 = parseDecimal4(fa.salvage_value ?? 0);
      const accum4 = parseDecimal4(fa.accumulated_depreciation ?? 0);
      if (!typeId || salv4 > price4 || accum4 > price4 - salv4) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'fixed_assets',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'INVALID_FIXED_ASSET',
          reasonDetail: `Fixed asset ${fa.asset_number} failed asset_type or depreciation cap validation`,
          financialImpact4: price4,
          sourcePayload: fa,
        });
        continue;
      }

      const ins = await tx.query<{ id: number }>(
        `INSERT INTO fixed_assets (
           company_id, asset_type_id, asset_number, name, purchase_date,
           purchase_price, salvage_value, accumulated_depreciation,
           last_depreciation_date, disposal_date, status, description
         ) VALUES (
           $1, $2, $3, $4, $5::DATE,
           $6::NUMERIC(19,4), $7::NUMERIC(19,4), $8::NUMERIC(19,4),
           $9::DATE, $10::DATE, $11, $12
         ) RETURNING id`,
        [
          companyId,
          typeId,
          String(fa.asset_number).slice(0, 64),
          String(fa.name).slice(0, 200),
          isoDateOrDefault(fa.purchase_date),
          formatDecimal4(price4),
          formatDecimal4(salv4),
          formatDecimal4(accum4),
          fa.last_depreciation_date ? isoDateOrDefault(fa.last_depreciation_date) : null,
          fa.disposal_date ? isoDateOrDefault(fa.disposal_date) : null,
          fa.status === 'disposed' ? 'disposed' : 'registered',
          fa.description ?? null,
        ]
      );
      mig++;
      await setMapped('fixed_assets', sid, 'fixed_assets', Number(ins.rows[0].id), 'migrated', fa);
    }

    await trackCheckpoint(23, 'fixed_assets', { src: srcTypes.length + srcAssets.length, mig, dup, arch, rej, last });
  }

  // Checkpoint 24: Budgets, Tax Mappings & Saved Reports
  {
    const srcBudgets = (bundle.budgets || []).filter(b => String(b.company_id) === sCompId);
    const srcTaxMaps = (bundle.tax_category_mappings || []).filter(t => String(t.company_id) === sCompId);
    const srcReports = (bundle.saved_reports || []).filter(r => String(r.company_id) === sCompId);
    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;

    for (let i = 0; i < srcBudgets.length; i++) {
      const b = srcBudgets[i];
      const sid = String(b.id ?? `${b.account_id}_${b.fiscal_year}_${b.fiscal_month}`);
      last = sid;
      if (idMap.has(`budgets::${sid}`)) { mig++; continue; }
      const aid = getMappedId('accounts', b.account_id);
      if (!aid) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'budgets',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_ACCOUNT',
          reasonDetail: `Budget row ${sid} references unmapped account ${b.account_id}`,
          sourcePayload: b,
        });
        continue;
      }
      const cid = getMappedId('classes', b.class_id);
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO budgets (company_id, account_id, fiscal_year, fiscal_month, amount, class_id)
         VALUES ($1, $2, $3, $4, $5::NUMERIC(19,4), $6)
         ON CONFLICT (company_id, account_id, fiscal_year, fiscal_month, COALESCE(class_id, 0))
         DO UPDATE SET amount = EXCLUDED.amount
         RETURNING id`,
        [companyId, aid, Number(b.fiscal_year), Number(b.fiscal_month), formatDecimal4(parseDecimal4(b.amount)), cid]
      );
      mig++;
      await setMapped('budgets', sid, 'budgets', Number(ins.rows[0].id), 'migrated', b);
    }

    for (let i = 0; i < srcTaxMaps.length; i++) {
      const tm = srcTaxMaps[i];
      const sid = String(tm.id ?? `${tm.account_id}`);
      last = sid;
      if (idMap.has(`tax_category_mappings::${sid}`)) { mig++; continue; }
      const aid = getMappedId('accounts', tm.account_id);
      if (!aid) {
        rej++;
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: 'tax_category_mappings',
          sourceId: sid,
          disposition: 'rejected',
          reasonCode: 'UNMAPPED_ACCOUNT',
          reasonDetail: `Tax mapping ${sid} references unmapped account ${tm.account_id}`,
          sourcePayload: tm,
        });
        continue;
      }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO tax_category_mappings (company_id, account_id, tax_line)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id, account_id) DO UPDATE SET tax_line = EXCLUDED.tax_line
         RETURNING id`,
        [companyId, aid, String(tm.tax_line).slice(0, 100)]
      );
      mig++;
      await setMapped('tax_category_mappings', sid, 'tax_category_mappings', Number(ins.rows[0].id), 'migrated', tm);
    }

    for (const rep of srcReports) {
      const sid = String(rep.id);
      last = sid;
      if (idMap.has(`saved_reports::${sid}`)) { mig++; continue; }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO saved_reports (company_id, name, report_type, parameters, created_by)
         VALUES ($1, $2, $3, $4::JSONB, $5) RETURNING id`,
        [companyId, String(rep.name).slice(0, 160), String(rep.report_type).slice(0, 60), JSON.stringify(rep.parameters ?? {}), actor.userId]
      );
      mig++;
      await setMapped('saved_reports', sid, 'saved_reports', Number(ins.rows[0].id), 'migrated', rep);
    }

    await trackCheckpoint(24, 'budgets_and_reports', {
      src: srcBudgets.length + srcTaxMaps.length + srcReports.length,
      mig,
      dup,
      arch,
      rej,
      last,
    });
  }

  // Checkpoint 25: Documents, Templates, QBO Mappings & Historical Audit Logs
  {
    const srcDocs = (bundle.documents || []).filter(d => String(d.company_id) === sCompId);
    const srcOcr = (bundle.ocr_templates || []).filter(o => String(o.company_id) === sCompId);
    const srcEmail = (bundle.email_templates || []).filter(e => String(e.company_id) === sCompId);
    const srcAudits = (bundle.audit_log || []).filter(a => String(a.company_id) === sCompId);
    const srcDocAudits = (bundle.document_audits || []).filter(d => String(d.company_id) === sCompId);
    const srcQbo = (bundle.qbo_mappings || []).filter(q => String(q.company_id) === sCompId);

    let mig = 0, dup = 0, arch = 0, rej = 0, last: string | null = null;

    for (const d of srcDocs) {
      const sid = String(d.id);
      last = sid;
      if (idMap.has(`documents::${sid}`)) { mig++; continue; }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO stored_files (
           company_id, storage_kind, original_name, content_type, size_bytes, sha256_hex, storage_key, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::TIMESTAMPTZ, NOW()))
         RETURNING id`,
        [
          companyId,
          (d.storage_kind || 'local').slice(0, 32),
          String(d.original_name).slice(0, 255),
          String(d.content_type || 'application/octet-stream').slice(0, 120),
          Math.max(0, Number(d.size_bytes ?? 0)),
          String(d.sha256_hex || crypto.createHash('sha256').update(sid).digest('hex')).padEnd(64, '0').slice(0, 64),
          String(d.storage_key || `migrated/${sid}`).slice(0, 255),
          actor.userId,
          d.created_at || null,
        ]
      );
      const fileId = Number(ins.rows[0].id);
      if (d.entity_type && d.entity_id !== null && d.entity_id !== undefined) {
        const mappedEntityId = getMappedId(d.entity_type, d.entity_id) ?? (Number(d.entity_id) || fileId);
        await tx.query(
          `INSERT INTO attachments (company_id, stored_file_id, entity_type, entity_id, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [companyId, fileId, String(d.entity_type).slice(0, 60), mappedEntityId, d.notes ?? null]
        );
      }
      mig++;
      await setMapped('documents', sid, 'stored_files', fileId, 'migrated', d);
    }

    for (const o of srcOcr) {
      const sid = String(o.id);
      if (idMap.has(`ocr_templates::${sid}`)) { mig++; continue; }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO ocr_templates (company_id, merchant_key, merchant_name, fields_json, use_count)
         VALUES ($1, $2, $3, $4::JSONB, $5)
         ON CONFLICT (company_id, merchant_key) DO UPDATE SET use_count = EXCLUDED.use_count
         RETURNING id`,
        [companyId, String(o.merchant_key).slice(0, 120), String(o.merchant_name).slice(0, 200), JSON.stringify(o.fields_json ?? {}), Number(o.use_count ?? 0)]
      );
      mig++;
      await setMapped('ocr_templates', sid, 'ocr_templates', Number(ins.rows[0].id), 'migrated', o);
    }

    for (const em of srcEmail) {
      const sid = String(em.id);
      if (idMap.has(`email_templates::${sid}`)) { mig++; continue; }
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO email_templates (company_id, kind, subject, body, is_default)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [companyId, String(em.kind).slice(0, 40), String(em.subject).slice(0, 255), em.body, Boolean(em.is_default)]
      );
      mig++;
      await setMapped('email_templates', sid, 'email_templates', Number(ins.rows[0].id), 'migrated', em);
    }

    for (const q of srcQbo) {
      const sid = String(q.id ?? `${q.entity_type}_${q.local_id}`);
      if (idMap.has(`qbo_mappings::${sid}`)) { mig++; continue; }
      const localTarget = getMappedId(q.entity_type, q.local_id) ?? (Number(q.local_id) || 0);
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO qbo_mappings (company_id, entity_type, local_id, external_id, sync_token, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (company_id, entity_type, local_id) DO UPDATE SET external_id = EXCLUDED.external_id
         RETURNING id`,
        [companyId, String(q.entity_type).slice(0, 60), localTarget, String(q.external_id).slice(0, 100), q.sync_token ?? null]
      );
      mig++;
      await setMapped('qbo_mappings', sid, 'qbo_mappings', Number(ins.rows[0].id), 'migrated', q);
    }

    for (const a of srcAudits) {
      const sid = String(a.id);
      last = sid;
      if (idMap.has(`audit_log::${sid}`)) { mig++; continue; }
      const mappedRecId = getMappedId(a.table_name, a.record_id) ?? (Number(a.record_id) || 0);
      const hash = a.sha256_hash && /^[0-9a-f]{64}$/i.test(a.sha256_hash)
        ? a.sha256_hash.toLowerCase()
        : canonicalJsonHash({ companyId, sid, a });
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO audit_log (
           company_id, occurred_at, actor_user_id, actor_username, action,
           table_name, record_id, old_values, new_values, changed_fields, sha256_hash, source
         ) VALUES (
           $1, COALESCE($2::TIMESTAMPTZ, NOW()), $3, $4, $5,
           $6, $7, $8::JSONB, $9::JSONB, $10::TEXT[], $11, 'slowbooks_migration'
         ) RETURNING id`,
        [
          companyId,
          a.occurred_at || null,
          actor.userId,
          (a.actor_username || actor.username).slice(0, 100),
          String(a.action || 'MIGRATED_EVENT').slice(0, 40),
          String(a.table_name || 'unknown').slice(0, 100),
          mappedRecId,
          a.old_values ? JSON.stringify(a.old_values) : null,
          a.new_values ? JSON.stringify(a.new_values) : null,
          a.changed_fields ?? null,
          hash,
        ]
      );
      mig++;
      await setMapped('audit_log', sid, 'audit_log', Number(ins.rows[0].id), 'migrated', a);
    }

    for (const da of srcDocAudits) {
      const sid = String(da.id);
      if (idMap.has(`document_audits::${sid}`)) { mig++; continue; }
      const mappedEnt = getMappedId(da.entity_type, da.entity_id) ?? (Number(da.entity_id) || 0);
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO document_audits (company_id, entity_type, entity_id, event_type, actor_username, details, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::TIMESTAMPTZ, NOW())) RETURNING id`,
        [
          companyId,
          String(da.entity_type).slice(0, 60),
          mappedEnt,
          String(da.event_type).slice(0, 40),
          da.actor_username ?? null,
          da.details ?? null,
          da.created_at || null,
        ]
      );
      mig++;
      await setMapped('document_audits', sid, 'document_audits', Number(ins.rows[0].id), 'migrated', da);
    }

    await trackCheckpoint(25, 'documents_and_audits', {
      src: srcDocs.length + srcOcr.length + srcEmail.length + srcQbo.length + srcAudits.length + srcDocAudits.length,
      mig,
      dup,
      arch,
      rej,
      last,
    });
  }

  // Checkpoint 26: Explicitly account for deprecated/consolidated vertical records (never silently dropped)
  {
    const srcDepr = (bundle.deprecated_records || []).filter(d => String(d.company_id) === sCompId);
    let arch = 0;
    let last: string | null = null;
    for (const d of srcDepr) {
      const sid = String(d.id);
      last = sid;
      const alreadyEx = await tx.query<{ id: number }>(
        `SELECT id FROM migration_exceptions
          WHERE company_id = $1 AND batch_id = $2 AND source_entity = $3 AND source_id = $4 LIMIT 1`,
        [companyId, batchId, d.source_table, sid]
      );
      if (alreadyEx.rows.length === 0) {
        await recordException(tx, {
          companyId,
          batchId,
          sourceEntity: d.source_table,
          sourceId: sid,
          disposition: 'deprecated_vertical',
          reasonCode: 'CONSOLIDATED_VERTICAL_RECORD',
          reasonDetail: `Deprecated vertical record (${d.source_table}): ${d.summary}`,
          financialImpact4: parseDecimal4(d.amount ?? 0),
          sourcePayload: d.payload ?? d,
          resolutionStatus: 'accepted',
        });
      }
      arch++;
    }
    await trackCheckpoint(26, 'deprecated_verticals', { src: srcDepr.length, mig: 0, dup: 0, arch, rej: 0, last });
  }

  // Checkpoint 27: Rebuild Account, Customer & Vendor Balances + Lock Historical Closed Fiscal Periods
  await rebuildStoredBalances(tx, companyId, actor);

  const allCustRes = await tx.query<{ id: number }>(`SELECT id FROM customers WHERE company_id = $1`, [companyId]);
  for (const c of allCustRes.rows) {
    await recalculateCustomerBalance(tx, companyId, Number(c.id));
  }
  const allVendRes = await tx.query<{ id: number }>(`SELECT id FROM vendors WHERE company_id = $1`, [companyId]);
  for (const v of allVendRes.rows) {
    await recalculateVendorBalance(tx, companyId, Number(v.id));
  }

  // Flush deferred journal validation triggers while historical periods are still open, then lock closed periods
  await tx.exec(`SET CONSTRAINTS trg_enforce_balanced_journal_txn, trg_enforce_balanced_journal_line IMMEDIATE;`);
  for (const p of deferredPeriodStatusUpdates) {
    if (p.status === 'open') continue;
    const mappedClosingTxn = p.closingSrcTxnId ? getMappedId('transactions', p.closingSrcTxnId) : null;
    await tx.query(
      `UPDATE fiscal_periods
          SET status = $3::VARCHAR(20),
              closed_by = CASE WHEN $3::TEXT = 'closed' THEN $4::INTEGER ELSE NULL END,
              closed_at = CASE WHEN $3::TEXT = 'closed' THEN COALESCE($5::TIMESTAMPTZ, NOW()) ELSE NULL END,
              closing_txn_id = COALESCE($6::INTEGER, closing_txn_id),
              notes = COALESCE($7::TEXT, notes)
        WHERE company_id = $1 AND id = $2`,
      [companyId, p.periodId, p.status, actor.userId, p.closedAt || null, mappedClosingTxn, p.notes ?? null]
    );
  }
  await tx.exec(`SET CONSTRAINTS trg_enforce_balanced_journal_txn, trg_enforce_balanced_journal_line DEFERRED;`);

  // Update per-company run counters
  await tx.query(
    `UPDATE migration_company_runs
        SET status = 'completed',
            total_source_records = $3,
            total_migrated = $4,
            total_deduplicated = $5,
            total_archived = $6,
            total_rejected = $7
      WHERE company_id = $1 AND batch_id = $2`,
    [companyId, batchId, totalSource, totalMigrated, totalDup, totalArch, totalRej]
  );

  // Run full Financial & Entity-Count Reconciliation & persist snapshot
  const report = await reconcileMigratedCompany(tx, companyId, batchId, sCompId, bundle, {
    asOfDate: options.asOfDate || bundle.asOfDate,
    basis: 'accrual',
    persistSnapshot: true,
  });

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: existingCompanyMapBefore.size > 0 ? 'SLOWBOOKS_MIGRATION_RERUN' : 'SLOWBOOKS_MIGRATION_EXECUTED',
    tableName: 'migration_batches',
    recordId: batchId,
    newValues: {
      sourceCompanyId: sCompId,
      totalSource,
      totalMigrated,
      totalDup,
      totalArch,
      totalRej,
      cutoverReady: report.cutoverReady,
    },
  });

  return {
    companyId,
    report,
    runStats: {
      sourceRecords: totalSource,
      migrated: totalMigrated,
      deduplicated: totalDup,
      archived: totalArch,
      rejected: totalRej,
    },
  };
}

export async function runSlowBooksMigration(
  db: ServerDatabase,
  bundle: SlowBooksSourceBundle,
  actor: ActorContext,
  options: RunMigrationOptions = {}
): Promise<MigrationExecutionResult> {
  const mode: 'dry_run' | 'execute' = options.dryRun ? 'dry_run' : 'execute';
  const batchKey =
    options.batchKey?.trim() ||
    `SB-${mode.toUpperCase()}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const sourceLabel = options.sourceLabel || bundle.sourceSystem || SOURCE_SYSTEM;
  const sourceSha256 = canonicalJsonHash(bundle);

  // 1. Always archive an immutable read-only source backup artifact first
  let sourceBackupPath: string | null = null;
  let sourceBackupSha256: string | null = null;
  if (options.backupDir) {
    const srcBk = createSourceBackupArtifact(bundle, path.join(options.backupDir, 'source'), batchKey);
    sourceBackupPath = srcBk.filePath;
    sourceBackupSha256 = srcBk.sha256;
  }

  return db.withSystemDb(async tx => {
    await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);

    // 2. Capture target pre-migration backup snapshot (non-destructive)
    let targetBackupPath: string | null = null;
    let targetBackupSha256: string | null = null;
    let targetBackupMeta: Record<string, unknown> = {};
    if (options.backupDir) {
      const tgtBk = await createTargetDatabaseBackup(tx, path.join(options.backupDir, 'target'), batchKey);
      targetBackupPath = tgtBk.filePath;
      targetBackupSha256 = tgtBk.sha256;
      targetBackupMeta = tgtBk.snapshotSummary;
    }

    const batchIns = await tx.query<{ id: number }>(
      `INSERT INTO migration_batches (
         batch_key, source_system, source_label, source_sha256, mode, status,
         source_backup_path, source_backup_sha256, target_backup_path, target_backup_sha256,
         target_backup_json, started_by
       ) VALUES (
         $1, $2, $3, $4, $5, 'running',
         $6, $7, $8, $9,
         $10::JSONB, $11
       ) RETURNING id`,
      [
        batchKey,
        SOURCE_SYSTEM,
        sourceLabel.slice(0, 255),
        sourceSha256,
        mode,
        sourceBackupPath,
        sourceBackupSha256,
        targetBackupPath,
        targetBackupSha256,
        JSON.stringify(targetBackupMeta),
        actor.userId,
      ]
    );
    const batchId = Number(batchIns.rows[0].id);

    const companyReports: CompanyReconciliationReport[] = [];
    let exceptionsPreview: MigrationExecutionResult['exceptionsPreview'] = [];
    let checkpointsSummary: MigrationExecutionResult['checkpointsSummary'] = [];

    if (mode === 'dry_run') {
      await tx.exec(`SAVEPOINT sp_dry_run_migration;`);
      try {
        for (const srcComp of bundle.companies || []) {
          const res = await migrateSingleCompany(tx, batchId, bundle, srcComp, actor, options);
          companyReports.push(res.report);
        }

        const excRows = await tx.query<{
          company_id: number;
          source_entity: string;
          source_id: string;
          disposition: string;
          reason_code: string;
          reason_detail: string;
          financial_impact: string;
          resolution_status: string;
        }>(
          `SELECT company_id, source_entity, source_id, disposition, reason_code, reason_detail,
                  financial_impact::text, resolution_status
             FROM migration_exceptions
            WHERE batch_id = $1
            ORDER BY id ASC`,
          [batchId]
        );
        const companyIdToSrc = new Map<number, string>();
        for (const r of companyReports) companyIdToSrc.set(r.companyId, r.sourceCompanyId);
        exceptionsPreview = excRows.rows.map(e => ({
          companyId: Number(e.company_id),
          sourceCompanyId: companyIdToSrc.get(Number(e.company_id)) || '',
          sourceEntity: e.source_entity,
          sourceId: e.source_id,
          disposition: e.disposition,
          reasonCode: e.reason_code,
          reasonDetail: e.reason_detail,
          financialImpact: e.financial_impact,
          resolutionStatus: e.resolution_status,
        }));

        const cpRows = await tx.query<{
          company_id: number;
          domain_order: number;
          domain_name: string;
          source_count: number;
          migrated_count: number;
          deduplicated_count: number;
          archived_count: number;
          rejected_count: number;
        }>(
          `SELECT company_id, domain_order, domain_name, source_count, migrated_count,
                  deduplicated_count, archived_count, rejected_count
             FROM migration_checkpoints
            WHERE batch_id = $1
            ORDER BY company_id ASC, domain_order ASC`,
          [batchId]
        );
        checkpointsSummary = cpRows.rows.map(c => ({
          companyId: Number(c.company_id),
          domainOrder: Number(c.domain_order),
          domainName: c.domain_name,
          sourceCount: Number(c.source_count),
          migratedCount: Number(c.migrated_count),
          deduplicatedCount: Number(c.deduplicated_count),
          archivedCount: Number(c.archived_count),
          rejectedCount: Number(c.rejected_count),
        }));
      } finally {
        await tx.exec(`ROLLBACK TO SAVEPOINT sp_dry_run_migration;`);
        await tx.exec(`RELEASE SAVEPOINT sp_dry_run_migration;`);
      }

      const summaryObj = {
        dryRunZeroMutationVerified: true,
        companiesSimulated: companyReports.length,
        exceptionsCount: exceptionsPreview.length,
        companyReports,
        exceptionsPreview,
        checkpointsSummary,
      };

      await tx.query(
        `UPDATE migration_batches
            SET status = 'completed',
                completed_at = NOW(),
                summary_json = $2::JSONB
          WHERE id = $1`,
        [batchId, JSON.stringify(summaryObj)]
      );

      return {
        batchId,
        batchKey,
        mode,
        status: 'completed',
        sourceSha256,
        sourceBackupPath,
        sourceBackupSha256,
        targetBackupPath,
        targetBackupSha256,
        companyReports,
        exceptionsPreview,
        checkpointsSummary,
        dryRunZeroMutationVerified: true,
      };
    }

    // Live execution mode
    for (const srcComp of bundle.companies || []) {
      const res = await migrateSingleCompany(tx, batchId, bundle, srcComp, actor, options);
      companyReports.push(res.report);
    }

    const excRows = await tx.query<{
      company_id: number;
      source_entity: string;
      source_id: string;
      disposition: string;
      reason_code: string;
      reason_detail: string;
      financial_impact: string;
      resolution_status: string;
    }>(
      `SELECT company_id, source_entity, source_id, disposition, reason_code, reason_detail,
              financial_impact::text, resolution_status
         FROM migration_exceptions
        WHERE batch_id = $1
        ORDER BY id ASC`,
      [batchId]
    );
    const companyIdToSrc = new Map<number, string>();
    for (const r of companyReports) companyIdToSrc.set(r.companyId, r.sourceCompanyId);
    exceptionsPreview = excRows.rows.map(e => ({
      companyId: Number(e.company_id),
      sourceCompanyId: companyIdToSrc.get(Number(e.company_id)) || '',
      sourceEntity: e.source_entity,
      sourceId: e.source_id,
      disposition: e.disposition,
      reasonCode: e.reason_code,
      reasonDetail: e.reason_detail,
      financialImpact: e.financial_impact,
      resolutionStatus: e.resolution_status,
    }));

    const cpRows = await tx.query<{
      company_id: number;
      domain_order: number;
      domain_name: string;
      source_count: number;
      migrated_count: number;
      deduplicated_count: number;
      archived_count: number;
      rejected_count: number;
    }>(
      `SELECT company_id, domain_order, domain_name, source_count, migrated_count,
              deduplicated_count, archived_count, rejected_count
         FROM migration_checkpoints
        WHERE batch_id = $1
        ORDER BY company_id ASC, domain_order ASC`,
      [batchId]
    );
    checkpointsSummary = cpRows.rows.map(c => ({
      companyId: Number(c.company_id),
      domainOrder: Number(c.domain_order),
      domainName: c.domain_name,
      sourceCount: Number(c.source_count),
      migratedCount: Number(c.migrated_count),
      deduplicatedCount: Number(c.deduplicated_count),
      archivedCount: Number(c.archived_count),
      rejectedCount: Number(c.rejected_count),
    }));

    const allReconciled = companyReports.every(r => r.allBalanced && r.countsReconciled);
    await tx.query(
      `UPDATE migration_batches
          SET status = 'completed',
              completed_at = NOW(),
              reconciled = $2,
              summary_json = $3::JSONB
        WHERE id = $1`,
      [
        batchId,
        allReconciled,
        JSON.stringify({
          companiesMigrated: companyReports.length,
          exceptionsCount: exceptionsPreview.length,
          allReconciled,
        }),
      ]
    );

    return {
      batchId,
      batchKey,
      mode,
      status: 'completed',
      sourceSha256,
      sourceBackupPath,
      sourceBackupSha256,
      targetBackupPath,
      targetBackupSha256,
      companyReports,
      exceptionsPreview,
      checkpointsSummary,
      dryRunZeroMutationVerified: false,
    };
  });
}

export async function rollbackMigrationBatch(
  tx: Transaction,
  actor: ActorContext,
  batchId: number,
  reason: string
) {
  await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);

  const batchRes = await tx.query<{
    id: number;
    batch_key: string;
    mode: string;
    status: string;
    target_backup_path: string | null;
    target_backup_sha256: string | null;
  }>(
    `SELECT id, batch_key, mode, status, target_backup_path, target_backup_sha256
       FROM migration_batches
      WHERE id = $1
      FOR UPDATE`,
    [batchId]
  );
  if (batchRes.rows.length === 0) {
    throw new AccountingError(404, `Migration batch ${batchId} not found`);
  }
  const batch = batchRes.rows[0];
  if (batch.mode !== 'execute') {
    throw new AccountingError(400, `Dry-run batch ${batch.batch_key} has no live mutations to roll back`);
  }
  if (batch.status === 'rolled_back') {
    throw new AccountingError(409, `Migration batch ${batch.batch_key} is already rolled back`);
  }

  const runsRes = await tx.query<{ company_id: number }>(
    `SELECT company_id FROM migration_company_runs WHERE batch_id = $1 ORDER BY company_id ASC`,
    [batchId]
  );

  const rolledBackCompanies: Array<{ companyId: number; journalsReversed: number }> = [];

  for (const r of runsRes.rows) {
    const companyId = Number(r.company_id);

    // 1. Reopen fiscal periods & clear closing_date temporarily so accounting reversals pass period guards
    await tx.query(`UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1`, [companyId]);
    await tx.query(`DELETE FROM company_settings WHERE company_id = $1 AND setting_key = 'closing_date'`, [companyId]);

    // 2. Unmark reconciled flag on migrated lines (allowed by immutability trigger) & reverse all posted journals cleanly
    await tx.query(
      `UPDATE journal_lines SET is_reconciled = FALSE WHERE company_id = $1 AND is_reconciled = TRUE`,
      [companyId]
    );

    const txnsRes = await tx.query<{ id: number }>(
      `SELECT id
         FROM journal_transactions
        WHERE company_id = $1
          AND is_posted = TRUE
          AND status = 'posted'
          AND source_type <> 'reversal'
          AND reversed_by_transaction_id IS NULL
        ORDER BY id DESC`,
      [companyId]
    );
    let revCount = 0;
    for (const jt of txnsRes.rows) {
      await reverseJournalEntry(tx, companyId, actor, Number(jt.id), {
        reason: `Rollback of migration batch ${batch.batch_key}: ${reason}`,
        idempotencyKey: `rollback-${batchId}-je-${jt.id}`,
      });
      revCount++;
    }

    // 3. Void commercial subledger docs & deactivate migrated master records + company tenant
    await tx.query(`UPDATE invoices SET status = 'voided', amount_paid = 0, balance_due = 0 WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE payments SET is_voided = TRUE WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE credit_memos SET status = 'voided', remaining_credit = 0 WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE bills SET status = 'voided', amount_paid = 0, balance_due = 0 WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE bill_payments SET is_voided = TRUE WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE vendor_credits SET status = 'voided', remaining_credit = 0 WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE pay_runs SET status = 'voided' WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE customers SET is_active = FALSE WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE vendors SET is_active = FALSE WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE inventory_items SET is_active = FALSE WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE accounts SET is_active = FALSE WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE company_memberships SET is_active = FALSE WHERE company_id = $1`, [companyId]);
    await tx.query(`UPDATE companies SET is_active = FALSE WHERE id = $1`, [companyId]);

    await rebuildStoredBalances(tx, companyId, actor);
    const custIds = await tx.query<{ id: number }>(`SELECT id FROM customers WHERE company_id = $1`, [companyId]);
    for (const c of custIds.rows) await recalculateCustomerBalance(tx, companyId, Number(c.id));
    const vendIds = await tx.query<{ id: number }>(`SELECT id FROM vendors WHERE company_id = $1`, [companyId]);
    for (const v of vendIds.rows) await recalculateVendorBalance(tx, companyId, Number(v.id));

    await tx.query(
      `UPDATE migration_checkpoints SET status = 'rolled_back' WHERE company_id = $1 AND batch_id = $2`,
      [companyId, batchId]
    );
    await tx.query(
      `UPDATE migration_company_runs SET status = 'rolled_back', reconciled = FALSE, cutover_approved = FALSE WHERE company_id = $1 AND batch_id = $2`,
      [companyId, batchId]
    );

    await writeAuditLog(tx, {
      companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      action: 'MIGRATION_BATCH_ROLLED_BACK',
      tableName: 'migration_batches',
      recordId: batchId,
      newValues: { batchKey: batch.batch_key, reason, journalsReversed: revCount },
    });

    rolledBackCompanies.push({ companyId, journalsReversed: revCount });
  }

  await tx.query(
    `UPDATE migration_batches
        SET status = 'rolled_back',
            reconciled = FALSE,
            cutover_approved = FALSE,
            rolled_back_by = $2,
            rolled_back_at = NOW(),
            rollback_reason = $3
      WHERE id = $1`,
    [batchId, actor.userId, reason || 'Operator-initiated rollback']
  );

  return {
    batchId,
    batchKey: batch.batch_key,
    status: 'rolled_back',
    rolledBackCompanies,
    targetBackupPath: batch.target_backup_path,
    targetBackupSha256: batch.target_backup_sha256,
  };
}

export async function listMigrationBatches(tx: Transaction) {
  await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);
  const res = await tx.query(
    `SELECT id, batch_key, source_system, source_label, source_sha256, mode, status,
            source_backup_path, source_backup_sha256, target_backup_path, target_backup_sha256,
            started_at::text, completed_at::text, reconciled, cutover_approved,
            signed_off_by, signed_off_at::text, sign_off_notes,
            rolled_back_at::text, rollback_reason, summary_json
       FROM migration_batches
      ORDER BY id DESC`
  );
  return res.rows;
}

export async function getMigrationBatchDetails(tx: Transaction, batchId: number) {
  await tx.exec(`SET LOCAL app.bypass_rls = 'on';`);
  const batchRes = await tx.query(
    `SELECT id, batch_key, source_system, source_label, source_sha256, mode, status,
            source_backup_path, source_backup_sha256, target_backup_path, target_backup_sha256,
            started_at::text, completed_at::text, reconciled, cutover_approved,
            signed_off_by, signed_off_at::text, sign_off_notes,
            rolled_back_at::text, rollback_reason, summary_json
       FROM migration_batches WHERE id = $1 LIMIT 1`,
    [batchId]
  );
  if (batchRes.rows.length === 0) {
    throw new AccountingError(404, `Migration batch ${batchId} not found`);
  }

  const runs = await tx.query(
    `SELECT * FROM migration_company_runs WHERE batch_id = $1 ORDER BY company_id ASC`,
    [batchId]
  );
  const checkpoints = await tx.query(
    `SELECT * FROM migration_checkpoints WHERE batch_id = $1 ORDER BY company_id ASC, domain_order ASC`,
    [batchId]
  );
  const exceptions = await tx.query(
    `SELECT id, company_id, source_entity, source_id, disposition, reason_code,
            reason_detail, financial_impact::text, resolution_status, resolution_note,
            resolved_at::text, created_at::text
       FROM migration_exceptions WHERE batch_id = $1 ORDER BY id ASC`,
    [batchId]
  );
  const snapshots = await tx.query(
    `SELECT id, company_id, as_of_date::text, basis, all_balanced, counts_reconciled,
            open_rejected_count, cutover_ready, report_json, signed_off_at::text
       FROM migration_reconciliation_snapshots WHERE batch_id = $1 ORDER BY id DESC`,
    [batchId]
  );

  return {
    batch: batchRes.rows[0],
    companyRuns: runs.rows,
    checkpoints: checkpoints.rows,
    exceptions: exceptions.rows,
    snapshots: snapshots.rows,
  };
}

export async function lookupSourceReference(
  tx: Transaction,
  companyId: number,
  targetTable: string,
  targetId: number
) {
  const res = await tx.query<{
    id: number;
    batch_id: number;
    source_system: string;
    source_entity: string;
    source_id: string;
    target_table: string;
    target_id: number;
    source_key_hash: string;
    disposition: string;
    metadata_json: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, batch_id, source_system, source_entity, source_id, target_table, target_id,
            source_key_hash, disposition, metadata_json, created_at::text
       FROM migration_id_map
      WHERE company_id = $1 AND target_table = $2 AND target_id = $3
      ORDER BY id ASC`,
    [companyId, targetTable, targetId]
  );
  return res.rows;
}

export { buildReconciliationMarkdownReport };
