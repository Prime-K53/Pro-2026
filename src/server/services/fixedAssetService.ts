import type { Transaction } from '@electric-sql/pglite';
import { AccountingError, postJournalEntry, type ActorContext } from './accountingEngine.ts';
import { formatDecimal4, parseDecimal4 } from '../lib/decimal.ts';
import { assertIsoDate, todayIsoDate } from './commercialHelpers.ts';
import { checkRouteIdempotency, saveRouteIdempotency } from './commercialHelpers.ts';
import { writeAuditLog } from '../audit.ts';

/**
 * Fixed-asset register and depreciation engine.
 *
 * The schema (`fixed_assets`, `fixed_asset_types`) already exists from migration
 * 0006; this module adds the operational layer on top of it:
 *   - asset-type CRUD (with the GL accounts and depreciation method),
 *   - asset registration (capitalisation record),
 *   - a monthly depreciation run that posts Dr depreciation expense /
 *     Cr accumulated depreciation per asset (source_type = 'depreciation'),
 *   - a disposal/retirement workflow that posts the write-off and any gain/loss,
 *   - a roll-forward (cost, accumulated depreciation, net book value) report.
 *
 * All money is handled as scaled integers (1e4) via the shared decimal helpers;
 * the depreciation estimate itself is computed in floating point and quantised to
 * 4 dp before posting, which is appropriate for a depreciation schedule.
 */

type AssetMethod = 'straight_line' | 'declining_balance';

interface AssetTypeRow {
  id: number;
  name: string;
  asset_account_id: number | null;
  accum_depr_account_id: number | null;
  depr_expense_account_id: number | null;
  depreciation_method: AssetMethod;
  effective_life_years: string | null;
  annual_rate: string | null;
  is_active: boolean;
}

interface AssetRow {
  id: number;
  asset_type_id: number;
  asset_number: string;
  name: string;
  purchase_date: string;
  purchase_price: string;
  salvage_value: string;
  accumulated_depreciation: string;
  last_depreciation_date: string | null;
  disposal_date: string | null;
  status: 'registered' | 'disposed';
  description: string | null;
}

export interface CreateAssetTypeInput {
  name: string;
  assetAccountId?: number | null;
  accumDeprAccountId?: number | null;
  deprExpenseAccountId?: number | null;
  depreciationMethod?: AssetMethod;
  effectiveLifeYears?: number | string | null;
  annualRate?: number | string | null;
}

export interface CreateAssetInput {
  assetTypeId: number;
  assetNumber: string;
  name: string;
  purchaseDate: string;
  purchasePrice: string | number;
  salvageValue?: string | number | null;
  description?: string | null;
}

export interface DisposeAssetInput {
  disposalDate?: string | null;
  proceeds?: string | number | null;
  proceedsAccountId?: number | null;
  lossAccountId?: number | null;
  gainAccountId?: number | null;
  reason?: string | null;
}

function toId(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AccountingError(400, `${field} must be a positive integer`, 'INVALID_ID');
  }
  return n;
}

function monthsBetween(startIso: string, endIso: string): number {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  return Math.max(0, months);
}

/** Straight-line or declining-balance monthly depreciation, in major units. */
function monthlyDepreciation(asset: AssetRow, type: AssetTypeRow): number {
  const cost = Number(asset.purchase_price);
  const salvage = Number(asset.salvage_value);
  const accum = Number(asset.accumulated_depreciation);
  const remaining = cost - salvage - accum;
  if (remaining <= 0) return 0;

  let monthly: number;
  if (type.depreciation_method === 'declining_balance') {
    const rate = Number(type.annual_rate ?? 0);
    const nbv = cost - accum;
    monthly = (nbv * rate) / 12;
  } else {
    const lifeYears = Number(type.effective_life_years ?? 0);
    if (lifeYears <= 0) return 0;
    monthly = (cost - salvage) / lifeYears / 12;
  }
  if (!Number.isFinite(monthly) || monthly <= 0) return 0;
  return Math.min(monthly, remaining);
}

async function loadAssetType(tx: Transaction, companyId: number, id: number): Promise<AssetTypeRow> {
  const res = await tx.query<AssetTypeRow>(
    `SELECT id, name, asset_account_id, accum_depr_account_id, depr_expense_account_id,
            depreciation_method, effective_life_years::text AS effective_life_years,
            annual_rate::text AS annual_rate, is_active
       FROM fixed_asset_types
      WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Fixed asset type not found', 'ASSET_TYPE_NOT_FOUND');
  }
  return res.rows[0];
}

async function loadAsset(tx: Transaction, companyId: number, id: number, forUpdate = false): Promise<AssetRow> {
  const res = await tx.query<AssetRow>(
    `SELECT id, asset_type_id, asset_number, name, purchase_date::text AS purchase_date,
            purchase_price::text AS purchase_price, salvage_value::text AS salvage_value,
            accumulated_depreciation::text AS accumulated_depreciation,
            last_depreciation_date::text AS last_depreciation_date,
            disposal_date::text AS disposal_date, status, description
       FROM fixed_assets
      WHERE company_id = $1 AND id = $2
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [companyId, id]
  );
  if (res.rows.length === 0) {
    throw new AccountingError(404, 'Fixed asset not found', 'ASSET_NOT_FOUND');
  }
  return res.rows[0];
}

async function accountCodeMap(tx: Transaction, companyId: number): Promise<Map<string, number>> {
  const res = await tx.query<{ id: number; code: string | null }>(
    `SELECT id, code FROM accounts WHERE company_id = $1 AND is_active = TRUE`,
    [companyId]
  );
  const map = new Map<string, number>();
  for (const r of res.rows) if (r.code) map.set(r.code, Number(r.id));
  return map;
}

// ---------------------------------------------------------------------------
// Asset types
// ---------------------------------------------------------------------------

export async function listFixedAssetTypes(tx: Transaction, companyId: number) {
  const res = await tx.query(
    `SELECT t.id, t.name, t.asset_account_id, t.accum_depr_account_id, t.depr_expense_account_id,
            t.depreciation_method, t.effective_life_years::text AS effective_life_years,
            t.annual_rate::text AS annual_rate, t.is_active,
            a.code AS asset_account_code, a.name AS asset_account_name
       FROM fixed_asset_types t
       LEFT JOIN accounts a ON a.company_id = t.company_id AND a.id = t.asset_account_id
      WHERE t.company_id = $1
      ORDER BY t.name ASC`,
    [companyId]
  );
  return res.rows;
}

export async function createFixedAssetType(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: CreateAssetTypeInput
) {
  const name = String(input.name || '').trim();
  if (!name) throw new AccountingError(400, 'Asset type name is required', 'NAME_REQUIRED');

  const method: AssetMethod = input.depreciationMethod === 'declining_balance' ? 'declining_balance' : 'straight_line';
  const life = input.effectiveLifeYears != null && Number(input.effectiveLifeYears) > 0 ? Number(input.effectiveLifeYears) : null;
  const rate = input.annualRate != null && Number(input.annualRate) >= 0 ? Number(input.annualRate) : null;

  const ins = await tx.query<{ id: number }>(
    `INSERT INTO fixed_asset_types (
       company_id, name, asset_account_id, accum_depr_account_id, depr_expense_account_id,
       depreciation_method, effective_life_years, annual_rate
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::NUMERIC(8,2), $8::NUMERIC(9,6))
     RETURNING id`,
    [
      companyId,
      name,
      input.assetAccountId ? Number(input.assetAccountId) : null,
      input.accumDeprAccountId ? Number(input.accumDeprAccountId) : null,
      input.deprExpenseAccountId ? Number(input.deprExpenseAccountId) : null,
      method,
      life,
      rate,
    ]
  );
  const id = Number(ins.rows[0].id);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'fixed_asset_type.create',
    tableName: 'fixed_asset_types',
    recordId: id,
    newValues: { name, method },
  });
  return loadAssetType(tx, companyId, id);
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export async function listFixedAssets(tx: Transaction, companyId: number) {
  const res = await tx.query(
    `SELECT a.id, a.asset_type_id, t.name AS asset_type_name, a.asset_number, a.name,
            a.purchase_date::text AS purchase_date, a.purchase_price::text AS purchase_price,
            a.salvage_value::text AS salvage_value,
            a.accumulated_depreciation::text AS accumulated_depreciation,
            a.last_depreciation_date::text AS last_depreciation_date,
            a.disposal_date::text AS disposal_date, a.status, a.description,
            (a.purchase_price - a.accumulated_depreciation)::text AS net_book_value
       FROM fixed_assets a
       JOIN fixed_asset_types t ON t.company_id = a.company_id AND t.id = a.asset_type_id
      WHERE a.company_id = $1
      ORDER BY a.asset_number ASC`,
    [companyId]
  );
  return res.rows;
}

export async function getFixedAsset(tx: Transaction, companyId: number, id: number) {
  return loadAsset(tx, companyId, toId(id, 'asset id'));
}

export async function createFixedAsset(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: CreateAssetInput
) {
  const assetTypeId = toId(input.assetTypeId, 'assetTypeId');
  const assetNumber = String(input.assetNumber || '').trim();
  const name = String(input.name || '').trim();
  if (!assetNumber) throw new AccountingError(400, 'Asset number is required', 'ASSET_NUMBER_REQUIRED');
  if (!name) throw new AccountingError(400, 'Asset name is required', 'NAME_REQUIRED');

  const purchaseDate = assertIsoDate(input.purchaseDate, 'purchaseDate');
  const purchasePrice4 = parseDecimal4(input.purchasePrice ?? 0);
  if (purchasePrice4 <= 0n) {
    throw new AccountingError(400, 'Purchase price must be greater than zero', 'INVALID_PRICE');
  }
  const salvage4 = parseDecimal4(input.salvageValue ?? 0);
  if (salvage4 < 0n || salvage4 > purchasePrice4) {
    throw new AccountingError(400, 'Salvage value must be between 0 and the purchase price', 'INVALID_SALVAGE');
  }

  // Validate the type exists (and is active) before inserting.
  const type = await loadAssetType(tx, companyId, assetTypeId);
  if (!type.is_active) {
    throw new AccountingError(409, 'Asset type is inactive', 'ASSET_TYPE_INACTIVE');
  }

  let ins;
  try {
    ins = await tx.query<{ id: number }>(
      `INSERT INTO fixed_assets (
         company_id, asset_type_id, asset_number, name, purchase_date,
         purchase_price, salvage_value, description
       ) VALUES ($1, $2, $3, $4, $5::DATE, $6::NUMERIC(19,4), $7::NUMERIC(19,4), $8)
       RETURNING id`,
      [
        companyId,
        assetTypeId,
        assetNumber,
        name,
        purchaseDate,
        formatDecimal4(purchasePrice4),
        formatDecimal4(salvage4),
        input.description?.trim() || null,
      ]
    );
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new AccountingError(409, `Asset number '${assetNumber}' already exists`, 'ASSET_NUMBER_DUPLICATE');
    }
    throw err;
  }

  const id = Number(ins.rows[0].id);
  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'fixed_asset.create',
    tableName: 'fixed_assets',
    recordId: id,
    newValues: { assetNumber, name, purchasePrice: formatDecimal4(purchasePrice4) },
  });
  return loadAsset(tx, companyId, id);
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

export interface DepreciationRunResult {
  periodDate: string;
  assetsDepreciated: number;
  totalDepreciation: number;
  entries: Array<{ assetId: number; assetNumber: string; amount: number; journalTransactionId: number; entryNumber: string }>;
  idempotentReplay: boolean;
}

export async function runDepreciation(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  input: { periodDate?: string | null; idempotencyKey?: string | null }
): Promise<DepreciationRunResult> {
  const periodDate = input.periodDate
    ? assertIsoDate(input.periodDate, 'periodDate')
    : todayIsoDate();
  const idemKey = input.idempotencyKey?.trim() || `dep-run-${companyId}-${periodDate}`;
  const idem = await checkRouteIdempotency<DepreciationRunResult>(
    tx,
    companyId,
    'fixed_asset_depreciation_run',
    idemKey,
    { periodDate }
  );
  if (idem.hit) {
    return { ...idem.response, idempotentReplay: true };
  }

  const codes = await accountCodeMap(tx, companyId);
  const assets = await tx.query<AssetRow>(
    `SELECT id, asset_type_id, asset_number, name, purchase_date::text AS purchase_date,
            purchase_price::text AS purchase_price, salvage_value::text AS salvage_value,
            accumulated_depreciation::text AS accumulated_depreciation,
            last_depreciation_date::text AS last_depreciation_date,
            disposal_date::text AS disposal_date, status, description
       FROM fixed_assets
      WHERE company_id = $1 AND status = 'registered'
      ORDER BY id ASC
      FOR UPDATE`,
    [companyId]
  );

  const entries: DepreciationRunResult['entries'] = [];
  let totalDep = 0;

  for (const asset of assets.rows) {
    const type = await loadAssetType(tx, companyId, Number(asset.asset_type_id));
    const start = asset.last_depreciation_date || asset.purchase_date;
    const months = monthsBetween(start, periodDate);
    if (months <= 0) continue;

    const monthly = monthlyDepreciation(asset, type);
    if (monthly <= 0) continue;

    const cost4 = parseDecimal4(asset.purchase_price);
    const salvage4 = parseDecimal4(asset.salvage_value);
    const accum4 = parseDecimal4(asset.accumulated_depreciation);
    const remaining4 = cost4 - salvage4 - accum4;
    if (remaining4 <= 0n) continue;

    let amount4 = parseDecimal4((monthly * months).toFixed(4));
    if (amount4 > remaining4) amount4 = remaining4;
    if (amount4 <= 0n) continue;

    const expenseAccountId = type.depr_expense_account_id ?? codes.get('6300');
    const accumAccountId = type.accum_depr_account_id ?? codes.get('1590');
    if (!expenseAccountId || !accumAccountId) {
      throw new AccountingError(
        409,
        `Asset type '${type.name}' is missing depreciation expense/accumulated accounts`,
        'ASSET_TYPE_ACCOUNTS_MISSING'
      );
    }

    const posted = await postJournalEntry(tx, companyId, actor, {
      txnDate: periodDate,
      description: `Depreciation — ${asset.asset_number} ${asset.name}`,
      reference: asset.asset_number,
      sourceType: 'depreciation',
      sourceId: Number(asset.id),
      idempotencyKey: `dep-${asset.id}-${periodDate}`,
      lines: [
        { accountId: expenseAccountId, debit: formatDecimal4(amount4), credit: '0.0000', description: `Depreciation expense — ${asset.name}` },
        { accountId: accumAccountId, debit: '0.0000', credit: formatDecimal4(amount4), description: `Accumulated depreciation — ${asset.name}` },
      ],
    });

    await tx.query(
      `UPDATE fixed_assets
          SET accumulated_depreciation = accumulated_depreciation + $2::NUMERIC(19,4),
              last_depreciation_date = $3::DATE
        WHERE company_id = $1 AND id = $4`,
      [companyId, formatDecimal4(amount4), periodDate, Number(asset.id)]
    );

    const amount = Number(formatDecimal4(amount4));
    totalDep += amount;
    entries.push({
      assetId: Number(asset.id),
      assetNumber: asset.asset_number,
      amount,
      journalTransactionId: posted.transaction.id,
      entryNumber: posted.transaction.entryNumber,
    });
  }

  const result: DepreciationRunResult = {
    periodDate,
    assetsDepreciated: entries.length,
    totalDepreciation: Number(totalDep.toFixed(4)),
    entries,
    idempotentReplay: false,
  };

  await saveRouteIdempotency(
    tx,
    companyId,
    'fixed_asset_depreciation_run',
    idemKey,
    idem.payloadHash,
    201,
    result,
    actor.userId
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'fixed_asset.depreciation_run',
    tableName: 'fixed_assets',
    recordId: 0,
    newValues: { periodDate, assetsDepreciated: result.assetsDepreciated, totalDepreciation: result.totalDepreciation },
  });

  return result;
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

export async function disposeFixedAsset(
  tx: Transaction,
  companyId: number,
  actor: ActorContext,
  assetId: number,
  input: DisposeAssetInput
) {
  const id = toId(assetId, 'asset id');
  const asset = await loadAsset(tx, companyId, id, true);
  if (asset.status === 'disposed') {
    throw new AccountingError(409, 'Asset is already disposed', 'ASSET_ALREADY_DISPOSED');
  }

  const disposalDate = input.disposalDate ? assertIsoDate(input.disposalDate, 'disposalDate') : todayIsoDate();
  const proceeds4 = parseDecimal4(input.proceeds ?? 0);
  if (proceeds4 < 0n) throw new AccountingError(400, 'Proceeds cannot be negative', 'INVALID_PROCEEDS');

  const type = await loadAssetType(tx, companyId, Number(asset.asset_type_id));
  const codes = await accountCodeMap(tx, companyId);

  const assetAccountId = type.asset_account_id ?? codes.get('1500');
  const accumAccountId = type.accum_depr_account_id ?? codes.get('1590');
  if (!assetAccountId || !accumAccountId) {
    throw new AccountingError(409, 'Asset type is missing asset/accumulated accounts', 'ASSET_TYPE_ACCOUNTS_MISSING');
  }

  const cost4 = parseDecimal4(asset.purchase_price);
  const accum4 = parseDecimal4(asset.accumulated_depreciation);

  const lines: Array<{ accountId: number; debit: string; credit: string; description: string }> = [];
  if (accum4 > 0n) {
    lines.push({ accountId: accumAccountId, debit: formatDecimal4(accum4), credit: '0.0000', description: `Remove accumulated depreciation — ${asset.name}` });
  }
  if (proceeds4 > 0n) {
    const proceedsAccountId = input.proceedsAccountId ?? codes.get('1010') ?? codes.get('1000');
    if (!proceedsAccountId) {
      throw new AccountingError(409, 'A proceeds (bank) account is required to record disposal proceeds', 'PROCEEDS_ACCOUNT_REQUIRED');
    }
    lines.push({ accountId: proceedsAccountId, debit: formatDecimal4(proceeds4), credit: '0.0000', description: `Disposal proceeds — ${asset.name}` });
  }
  lines.push({ accountId: assetAccountId, debit: '0.0000', credit: formatDecimal4(cost4), description: `Remove asset cost — ${asset.name}` });

  // difference = net book value - proceeds. Positive => loss, negative => gain.
  const difference4 = cost4 - accum4 - proceeds4;
  let gain = 0;
  let loss = 0;
  if (difference4 > 0n) {
    const lossAccountId = input.lossAccountId ?? type.depr_expense_account_id ?? codes.get('6300');
    if (!lossAccountId) throw new AccountingError(409, 'A loss account is required', 'LOSS_ACCOUNT_REQUIRED');
    lines.push({ accountId: lossAccountId, debit: formatDecimal4(difference4), credit: '0.0000', description: `Loss on disposal — ${asset.name}` });
    loss = Number(formatDecimal4(difference4));
  } else if (difference4 < 0n) {
    const gainAccountId = input.gainAccountId ?? codes.get('4000') ?? codes.get('4100');
    if (!gainAccountId) throw new AccountingError(409, 'A gain account is required', 'GAIN_ACCOUNT_REQUIRED');
    lines.push({ accountId: gainAccountId, debit: '0.0000', credit: formatDecimal4(-difference4), description: `Gain on disposal — ${asset.name}` });
    gain = Number(formatDecimal4(-difference4));
  }

  const posted = await postJournalEntry(tx, companyId, actor, {
    txnDate: disposalDate,
    description: `Disposal — ${asset.asset_number} ${asset.name}`,
    reference: asset.asset_number,
    sourceType: 'depreciation',
    sourceId: Number(asset.id),
    idempotencyKey: `asset-disposal-${asset.id}-${disposalDate}`,
    lines,
  });

  await tx.query(
    `UPDATE fixed_assets
        SET status = 'disposed', disposal_date = $2::DATE
      WHERE company_id = $1 AND id = $3`,
    [companyId, disposalDate, id]
  );

  await writeAuditLog(tx, {
    companyId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action: 'fixed_asset.dispose',
    tableName: 'fixed_assets',
    recordId: id,
    newValues: { assetNumber: asset.asset_number, proceeds: formatDecimal4(proceeds4), gain, loss, reason: input.reason ?? null },
  });

  return {
    assetId: id,
    assetNumber: asset.asset_number,
    disposalDate,
    proceeds: Number(formatDecimal4(proceeds4)),
    gain,
    loss,
    journalTransactionId: posted.transaction.id,
    entryNumber: posted.transaction.entryNumber,
  };
}

// ---------------------------------------------------------------------------
// Roll-forward report
// ---------------------------------------------------------------------------

export async function getAssetRollForward(tx: Transaction, companyId: number) {
  const res = await tx.query<{
    active_count: number;
    disposed_count: number;
    total_cost: string;
    total_accumulated_depreciation: string;
    total_net_book_value: string;
  }>(
    `SELECT
        COUNT(*) FILTER (WHERE a.status = 'registered')::int AS active_count,
        COUNT(*) FILTER (WHERE a.status = 'disposed')::int   AS disposed_count,
        COALESCE(SUM(a.purchase_price), 0)::text            AS total_cost,
        COALESCE(SUM(a.accumulated_depreciation), 0)::text  AS total_accumulated_depreciation,
        COALESCE(SUM(a.purchase_price - a.accumulated_depreciation), 0)::text AS total_net_book_value
       FROM fixed_assets a
      WHERE a.company_id = $1`,
    [companyId]
  );
  const row = res.rows[0];
  return {
    activeCount: Number(row.active_count ?? 0),
    disposedCount: Number(row.disposed_count ?? 0),
    totalCost: Number(row.total_cost ?? 0),
    totalAccumulatedDepreciation: Number(row.total_accumulated_depreciation ?? 0),
    totalNetBookValue: Number(row.total_net_book_value ?? 0),
  };
}