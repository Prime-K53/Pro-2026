import { Router, Request, Response } from 'express';
import { ServerDatabase, createCompanyInTx } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { writeAuditLog } from '../audit.ts';
import { getRolePermissions } from '../permissions.ts';

/**
 * Print-desk pricing defaults. These live in `company_settings` (company-scoped
 * key/value) rather than as new columns because they are pricing policy, not
 * legal-entity facts: each company can change them without a schema change, the
 * values are validated here, and every desk form reads the same defaults instead
 * of hard-coding a price per component.
 */
const PRINTING_PRICING_KEYS = {
  extraTypingFinishingPerPage: 'printing.extra_typing_finishing_per_page',
  manualSellingPricePerSheet: 'printing.manual_selling_price_per_sheet',
} as const;

const PRINTING_PRICING_DEFAULTS = {
  extraTypingFinishingPerPage: 0,
  manualSellingPricePerSheet: 0,
};

type PrintingPricingSettings = typeof PRINTING_PRICING_DEFAULTS;

async function readPrintingPricingSettings(
  tx: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  companyId: number
): Promise<PrintingPricingSettings> {
  const r = await tx.query<{ setting_key: string; setting_value: string | null }>(
    `SELECT setting_key, setting_value
       FROM company_settings
      WHERE company_id = $1 AND setting_key = ANY($2::TEXT[])`,
    [companyId, Object.values(PRINTING_PRICING_KEYS)]
  );
  const byKey = new Map(r.rows.map(row => [row.setting_key, row.setting_value]));
  const num = (key: string, fallback: number) => {
    const raw = byKey.get(key);
    const parsed = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    extraTypingFinishingPerPage: num(
      PRINTING_PRICING_KEYS.extraTypingFinishingPerPage,
      PRINTING_PRICING_DEFAULTS.extraTypingFinishingPerPage
    ),
    manualSellingPricePerSheet: num(
      PRINTING_PRICING_KEYS.manualSellingPricePerSheet,
      PRINTING_PRICING_DEFAULTS.manualSellingPricePerSheet
    ),
  };
}

async function writePrintingPricingSettings(
  tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  companyId: number,
  values: Partial<PrintingPricingSettings>
): Promise<void> {
  const entries: Array<[string, number]> = [];
  if (values.extraTypingFinishingPerPage !== undefined) {
    entries.push([
      PRINTING_PRICING_KEYS.extraTypingFinishingPerPage,
      values.extraTypingFinishingPerPage,
    ]);
  }
  if (values.manualSellingPricePerSheet !== undefined) {
    entries.push([
      PRINTING_PRICING_KEYS.manualSellingPricePerSheet,
      values.manualSellingPricePerSheet,
    ]);
  }
  for (const [key, amount] of entries) {
    await tx.query(
      `INSERT INTO company_settings (company_id, setting_key, setting_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, setting_key)
       DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
      [companyId, key, String(amount)]
    );
  }
}

/**
 * Additional company-scoped settings stored as `company_settings` key/value
 * rows (not legal-entity columns): branding, document defaults, banking and
 * payment-term policy. Each is validated here and audited on write.
 */
const COMPANY_SETTING_KEYS = {
  defaultBankAccountId: 'company.default_bank_account_id',
  defaultPaymentTerms: 'company.default_payment_terms',
  logoBase64: 'branding.logo_base64',
  signatureBase64: 'branding.signature_base64',
  documentFooter: 'documents.footer_text',
  invoiceNumberPrefix: 'documents.invoice_number_prefix',
  defaultTaxCode: 'documents.default_tax_code',
} as const;

type CompanySettingsKey = keyof typeof COMPANY_SETTING_KEYS;

const COMPANY_SETTING_DEFAULTS: Record<CompanySettingsKey, string> = {
  defaultBankAccountId: '',
  defaultPaymentTerms: 'Due on Receipt',
  logoBase64: '',
  signatureBase64: '',
  documentFooter: '',
  invoiceNumberPrefix: '',
  defaultTaxCode: '',
};

async function readCompanySettings(
  tx: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  companyId: number
): Promise<Record<CompanySettingsKey, string>> {
  const r = await tx.query<{ setting_key: string; setting_value: string | null }>(
    `SELECT setting_key, setting_value
       FROM company_settings
      WHERE company_id = $1 AND setting_key = ANY($2::TEXT[])`,
    [companyId, Object.values(COMPANY_SETTING_KEYS)]
  );
  const byKey = new Map(r.rows.map(row => [row.setting_key, row.setting_value]));
  const out = {} as Record<CompanySettingsKey, string>;
  for (const key of Object.keys(COMPANY_SETTING_KEYS) as CompanySettingsKey[]) {
    const raw = byKey.get(COMPANY_SETTING_KEYS[key]);
    out[key] = raw === null || raw === undefined ? COMPANY_SETTING_DEFAULTS[key] : raw;
  }
  return out;
}

async function writeCompanySettings(
  tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  companyId: number,
  values: Partial<Record<CompanySettingsKey, string>>
): Promise<void> {
  for (const key of Object.keys(values) as CompanySettingsKey[]) {
    const value = values[key];
    if (value === undefined) continue;
    await tx.query(
      `INSERT INTO company_settings (company_id, setting_key, setting_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, setting_key)
       DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
      [companyId, COMPANY_SETTING_KEYS[key], value]
    );
  }
}

export function createCompanyRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  // GET /api/companies — only companies where the authenticated user holds an active, non-revoked membership
  router.get('/', requireAuth, async (req: Request, res: Response) => {
    const auth = req.auth!;
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.withSystemDb(async tx => {
      const r = await tx.query<{
        id: number;
        slug: string;
        name: string;
        legal_name: string;
        tax_id_ein: string | null;
        currency_symbol: string;
        base_currency: string;
        role: string;
        is_default: boolean;
      }>(
        `SELECT c.id, c.slug, c.name, c.legal_name, c.tax_id_ein, c.currency_symbol, c.base_currency,
                m.role, m.is_default
           FROM company_memberships m
           JOIN companies c ON c.id = m.company_id
          WHERE m.user_id = $1
            AND c.is_active = TRUE
            AND m.is_active = TRUE
            AND m.revoked_at IS NULL
            AND (m.expires_on IS NULL OR m.expires_on >= $2::date)
          ORDER BY m.is_default DESC, c.id ASC`,
        [auth.userId, today]
      );
      return r.rows;
    });

    return res.json({
      activeCompanyId: auth.companyId,
      companies: rows.map(r => ({
        id: Number(r.id),
        slug: r.slug,
        name: r.name,
        legalName: r.legal_name,
        ein: r.tax_id_ein,
        currencySymbol: r.currency_symbol,
        baseCurrency: r.base_currency,
        role: r.role,
        isDefault: Boolean(r.is_default),
        isActiveContext: Number(r.id) === auth.companyId,
      })),
    });
  });

  // POST /api/companies — create a brand-new isolated company book (Administrator only) and optionally switch
  router.post(
    '/',
    requireAuth, csrfProtection,
    requirePermission('companies:create'),
    async (req: Request, res: Response) => {
      const auth = req.auth!;
      const name = String(req.body?.name || '').trim();
      const legalName = String(req.body?.legalName || name).trim();
      const ein = String(req.body?.ein || 'TPIN-000000').trim();
      const currencySymbol = String(req.body?.currencySymbol || 'K').trim();
      const baseCurrency = String(req.body?.baseCurrency || 'ZMW').trim().toUpperCase().slice(0, 3);
      const switchImmediately = req.body?.switchImmediately !== false;

      if (!name || name.length < 2) {
        return res.status(400).json({ error: 'Company name must be at least 2 characters' });
      }

      const created = await db.withSystemDb(async tx => {
        const comp = await createCompanyInTx(tx, {
          name,
          legalName,
          ein,
          currencySymbol,
          baseCurrency,
          ownerUserId: auth.userId,
          ownerUsername: auth.username,
          makeDefault: false,
        });

        if (switchImmediately && auth.sessionId) {
          await tx.query(
            `UPDATE auth_sessions
                SET active_company_id = $1,
                    membership_id = $2,
                    membership_version = 0,
                    last_seen_at = NOW()
              WHERE id = $3`,
            [comp.companyId, comp.membershipId, auth.sessionId]
          );
        }

        return comp;
      });

      return res.status(201).json({
        company: {
          id: created.companyId,
          slug: created.slug,
          name,
          legalName,
          ein,
          currencySymbol,
          baseCurrency,
          role: 'Administrator',
        },
        switched: switchImmediately,
        permissions: getRolePermissions('Administrator'),
      });
    }
  );

  // GET /api/companies/current — active company settings strictly scoped
  router.get('/current', requireAuth, rejectCrossCompanyParams, async (req: Request, res: Response) => {
    const auth = req.auth!;
    const company = await db.withSystemDb(async tx => {
      const r = await tx.query<{
        id: number;
        slug: string;
        name: string;
        legal_name: string;
        tax_id_ein: string | null;
        address: string | null;
        city_state_zip: string | null;
        phone: string | null;
        email: string | null;
        website: string | null;
        currency_symbol: string;
        base_currency: string;
        fiscal_year_start_month: number;
        accounting_method: string;
        sales_tax_rate: string;
        rounding_mode: string;
        decimal_places: number;
        theme: string;
      }>(
        `SELECT id, slug, name, legal_name, tax_id_ein, address, city_state_zip, phone, email, website,
                currency_symbol, base_currency, fiscal_year_start_month, accounting_method,
                sales_tax_rate::text, rounding_mode, decimal_places, theme
           FROM companies WHERE id = $1`,
        [auth.companyId]
      );
      return r.rows[0];
    });

    const printingPricing = await db.withCompanyDb(auth.companyId, tx =>
      readPrintingPricingSettings(tx, auth.companyId)
    );
    const extraSettings = await db.withCompanyDb(auth.companyId, tx =>
      readCompanySettings(tx, auth.companyId)
    );

    return res.json({
      id: Number(company.id),
      slug: company.slug,
      name: company.name,
      legalName: company.legal_name,
      ein: company.tax_id_ein,
      address: company.address ?? '',
      cityStateZip: company.city_state_zip ?? '',
      phone: company.phone ?? '',
      email: company.email ?? '',
      website: company.website ?? '',
      currencySymbol: company.currency_symbol,
      baseCurrency: company.base_currency,
      fiscalYearStartMonth: Number(company.fiscal_year_start_month),
      accountingMethod: company.accounting_method,
      salesTaxRate: Number(company.sales_tax_rate),
      roundingMode: company.rounding_mode,
      decimalPlaces: Number(company.decimal_places),
      theme: company.theme,
      role: auth.role,
      extraTypingFinishingPerPage: printingPricing.extraTypingFinishingPerPage,
      manualSellingPricePerSheet: printingPricing.manualSellingPricePerSheet,
      defaultBankAccountId: extraSettings.defaultBankAccountId,
      defaultPaymentTerms: extraSettings.defaultPaymentTerms,
      logoBase64: extraSettings.logoBase64,
      signatureBase64: extraSettings.signatureBase64,
      documentFooter: extraSettings.documentFooter,
      invoiceNumberPrefix: extraSettings.invoiceNumberPrefix,
      defaultTaxCode: extraSettings.defaultTaxCode,
    });
  });

  // PATCH /api/companies/current — Administrator only
  router.patch(
    '/current',
    requireAuth, csrfProtection,
    rejectCrossCompanyParams,
    requirePermission('companies:settings:write'),
    async (req: Request, res: Response) => {
      const auth = req.auth!;
      const body = req.body ?? {};
      const str = (v: unknown): string | null =>
        v !== undefined ? String(v).trim() : null;

      const allowedName = str(body.name);
      const allowedLegal = str(body.legalName);
      const allowedEin = str(body.ein);
      const allowedAddress = str(body.address);
      const allowedCity = str(body.cityStateZip);
      const allowedPhone = str(body.phone);
      const allowedEmail = str(body.email);
      const allowedWebsite = str(body.website);
      const allowedTheme = str(body.theme);
      const allowedRounding = str(body.roundingMode);
      const allowedTaxRate = body.salesTaxRate !== undefined ? Number(body.salesTaxRate) : null;
      const allowedDecimals = body.decimalPlaces !== undefined ? Number(body.decimalPlaces) : null;

      if (allowedTaxRate !== null && (!Number.isFinite(allowedTaxRate) || allowedTaxRate < 0 || allowedTaxRate > 100)) {
        return res.status(400).json({ error: 'salesTaxRate must be between 0 and 100' });
      }
      if (allowedDecimals !== null && (!Number.isInteger(allowedDecimals) || allowedDecimals < 2 || allowedDecimals > 4)) {
        return res.status(400).json({ error: 'decimalPlaces must be between 2 and 4' });
      }
      if (allowedRounding !== null && !['HALF_EVEN', 'HALF_UP'].includes(allowedRounding)) {
        return res.status(400).json({ error: 'roundingMode must be HALF_EVEN or HALF_UP' });
      }
      if (allowedTheme !== null && !['classic', 'slate', 'midnight'].includes(allowedTheme)) {
        return res.status(400).json({ error: 'theme must be classic, slate, or midnight' });
      }

      const parsePricing = (raw: unknown): number | undefined | null => {
        if (raw === undefined) return undefined;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return null;
        return Math.round(n * 10000) / 10000;
      };
      const pricingExtra = parsePricing(body.extraTypingFinishingPerPage);
      const pricingSheet = parsePricing(body.manualSellingPricePerSheet);
      if (pricingExtra === null || pricingSheet === null) {
        return res.status(400).json({
          error: 'Printing pricing defaults must be positive amounts',
        });
      }

      // Company-scoped key/value settings (branding, document defaults, banking, terms).
      const extraPatch: Partial<Record<CompanySettingsKey, string>> = {};
      if (body.defaultBankAccountId !== undefined) extraPatch.defaultBankAccountId = str(body.defaultBankAccountId) ?? '';
      if (body.defaultPaymentTerms !== undefined) extraPatch.defaultPaymentTerms = str(body.defaultPaymentTerms) ?? '';
      if (body.logoBase64 !== undefined) extraPatch.logoBase64 = str(body.logoBase64) ?? '';
      if (body.signatureBase64 !== undefined) extraPatch.signatureBase64 = str(body.signatureBase64) ?? '';
      if (body.documentFooter !== undefined) extraPatch.documentFooter = str(body.documentFooter) ?? '';
      if (body.invoiceNumberPrefix !== undefined) extraPatch.invoiceNumberPrefix = str(body.invoiceNumberPrefix) ?? '';
      if (body.defaultTaxCode !== undefined) extraPatch.defaultTaxCode = str(body.defaultTaxCode) ?? '';

      const updated = await db.withSystemDb(async tx => {
        const before = await tx.query<Record<string, unknown>>(
          `SELECT name, legal_name, tax_id_ein, address, city_state_zip, phone, email, website,
                  sales_tax_rate::text, rounding_mode, decimal_places, theme
             FROM companies WHERE id = $1`,
          [auth.companyId]
        );

        const after = await tx.query<Record<string, unknown>>(
          `UPDATE companies
              SET name = COALESCE($1, name),
                  legal_name = COALESCE($2, legal_name),
                  tax_id_ein = COALESCE($3, tax_id_ein),
                  address = COALESCE($4, address),
                  city_state_zip = COALESCE($5, city_state_zip),
                  phone = COALESCE($6, phone),
                  email = COALESCE($7, email),
                  website = COALESCE($8, website),
                  sales_tax_rate = COALESCE($9, sales_tax_rate),
                  rounding_mode = COALESCE($10, rounding_mode),
                  decimal_places = COALESCE($11, decimal_places),
                  theme = COALESCE($12, theme)
            WHERE id = $13
            RETURNING id, slug, name, legal_name, tax_id_ein, address, city_state_zip, phone, email, website,
                      sales_tax_rate::text, rounding_mode, decimal_places, theme, currency_symbol`,
          [
            allowedName, allowedLegal, allowedEin, allowedAddress, allowedCity,
            allowedPhone, allowedEmail, allowedWebsite, allowedTaxRate,
            allowedRounding, allowedDecimals, allowedTheme, auth.companyId,
          ]
        );

        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'COMPANY_SETTINGS_UPDATED',
          tableName: 'companies',
          recordId: auth.companyId,
          oldValues: before.rows[0],
          newValues: after.rows[0],
        });

        return after.rows[0];
      });

      if (pricingExtra !== undefined || pricingSheet !== undefined) {
        const pricingPatch = {
          ...(pricingExtra !== undefined ? { extraTypingFinishingPerPage: pricingExtra } : {}),
          ...(pricingSheet !== undefined ? { manualSellingPricePerSheet: pricingSheet } : {}),
        };
        await db.withCompanyDb(auth.companyId, async tx => {
          const before = await readPrintingPricingSettings(tx, auth.companyId);
          await writePrintingPricingSettings(tx, auth.companyId, pricingPatch);
          await writeAuditLog(tx, {
            companyId: auth.companyId,
            actorUserId: auth.userId,
            actorUsername: auth.username,
            action: 'PRINTING_PRICING_DEFAULTS_UPDATED',
            tableName: 'company_settings',
            recordId: auth.companyId,
            oldValues: before,
            newValues: { ...before, ...pricingPatch },
          });
        });
      }

      if (Object.keys(extraPatch).length > 0) {
        await db.withCompanyDb(auth.companyId, async tx => {
          const before = await readCompanySettings(tx, auth.companyId);
          await writeCompanySettings(tx, auth.companyId, extraPatch);
          await writeAuditLog(tx, {
            companyId: auth.companyId,
            actorUserId: auth.userId,
            actorUsername: auth.username,
            action: 'COMPANY_PREFERENCES_UPDATED',
            tableName: 'company_settings',
            recordId: auth.companyId,
            oldValues: before,
            newValues: { ...before, ...extraPatch },
          });
        });
      }

      return res.json({ company: updated });
    }
  );

  return router;
}
