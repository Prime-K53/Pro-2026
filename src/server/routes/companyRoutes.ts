import { Router, Request, Response } from 'express';
import { ServerDatabase, createCompanyInTx } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { writeAuditLog } from '../audit.ts';
import { getRolePermissions } from '../permissions.ts';

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
    requireAuth,
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
        currency_symbol: string;
        base_currency: string;
        fiscal_year_start_month: number;
        accounting_method: string;
        sales_tax_rate: string;
        theme: string;
      }>(
        `SELECT id, slug, name, legal_name, tax_id_ein, currency_symbol, base_currency,
                fiscal_year_start_month, accounting_method, sales_tax_rate::text, theme
           FROM companies WHERE id = $1`,
        [auth.companyId]
      );
      return r.rows[0];
    });

    return res.json({
      id: Number(company.id),
      slug: company.slug,
      name: company.name,
      legalName: company.legal_name,
      ein: company.tax_id_ein,
      currencySymbol: company.currency_symbol,
      baseCurrency: company.base_currency,
      fiscalYearStartMonth: Number(company.fiscal_year_start_month),
      accountingMethod: company.accounting_method,
      salesTaxRate: Number(company.sales_tax_rate),
      theme: company.theme,
      role: auth.role,
    });
  });

  // PATCH /api/companies/current — Administrator only
  router.patch(
    '/current',
    requireAuth,
    rejectCrossCompanyParams,
    requirePermission('companies:settings:write'),
    async (req: Request, res: Response) => {
      const auth = req.auth!;
      const allowedName = req.body?.name !== undefined ? String(req.body.name).trim() : null;
      const allowedLegal = req.body?.legalName !== undefined ? String(req.body.legalName).trim() : null;
      const allowedEin = req.body?.ein !== undefined ? String(req.body.ein).trim() : null;
      const allowedTaxRate = req.body?.salesTaxRate !== undefined ? Number(req.body.salesTaxRate) : null;

      if (allowedTaxRate !== null && (!Number.isFinite(allowedTaxRate) || allowedTaxRate < 0 || allowedTaxRate > 100)) {
        return res.status(400).json({ error: 'salesTaxRate must be between 0 and 100' });
      }

      const updated = await db.withSystemDb(async tx => {
        const before = await tx.query<Record<string, unknown>>(
          `SELECT name, legal_name, tax_id_ein, sales_tax_rate::text FROM companies WHERE id = $1`,
          [auth.companyId]
        );

        const after = await tx.query<Record<string, unknown>>(
          `UPDATE companies
              SET name = COALESCE($1, name),
                  legal_name = COALESCE($2, legal_name),
                  tax_id_ein = COALESCE($3, tax_id_ein),
                  sales_tax_rate = COALESCE($4, sales_tax_rate)
            WHERE id = $5
            RETURNING id, slug, name, legal_name, tax_id_ein, sales_tax_rate::text, currency_symbol`,
          [allowedName, allowedLegal, allowedEin, allowedTaxRate, auth.companyId]
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

      return res.json({ company: updated });
    }
  );

  return router;
}
