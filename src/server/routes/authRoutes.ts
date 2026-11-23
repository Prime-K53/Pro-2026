import { Router, Request, Response } from 'express';
import { ServerDatabase, createCompanyInTx } from '../db.ts';
import { createAuthMiddleware, clearSessionCookie, getClientIp } from '../middleware/auth.ts';
import { csrfProtection, generateCsrfToken } from '../middleware/csrf.ts';
import { getRolePermissions, CompanyRole } from '../permissions.ts';
import {
  authenticateWithSupabasePassword,
  generateOpaqueToken,
  hashPassword,
  sha256Hex,
  signSessionCookieValue,
  syncUserToSupabaseAdmin,
  verifyPassword,
  verifySupabaseJwt,
} from '../supabaseAuth.ts';
import { recordLoginAttempt, writeAuditLog } from '../audit.ts';
import { getTwoFactorStatus, verifyTwoFactorLogin } from '../services/twoFactorService.ts';
import { SqlExecutor } from '../../../db/migrator.ts';

function isHttpsRequest(req: Request): boolean {
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  return req.secure || proto.includes('https');
}

function setCookie(
  req: Request,
  res: Response,
  name: string,
  value: string,
  maxAgeSec: number,
  isProduction: boolean
) {
  const https = isHttpsRequest(req) || isProduction;
  res.cookie(name, value, {
    httpOnly: true,
    sameSite: https ? 'none' : 'lax',
    secure: https,
    maxAge: maxAgeSec * 1000,
    path: '/',
  });
}

async function issueServerSession(
  tx: SqlExecutor,
  db: ServerDatabase,
  req: Request,
  res: Response,
  params: {
    userId: number;
    companyId: number;
    membershipId: number;
    userSessionVersion: number;
    membershipVersion: number;
    supabaseSub?: string | null;
  }
) {
  const rawToken = generateOpaqueToken(32);
  const tokenHash = sha256Hex(rawToken);
  const ttlSec = db.config.sessionTtlSeconds;

  const sessionRes = await tx.query<{ id: number }>(
    `INSERT INTO auth_sessions (
       session_token_hash, user_id, active_company_id, membership_id,
       user_session_version, membership_version, supabase_sub,
       ip_address, user_agent, expires_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7::uuid,
       $8, $9, NOW() + ($10::text || ' seconds')::interval
     ) RETURNING id`,
    [
      tokenHash,
      params.userId,
      params.companyId,
      params.membershipId,
      params.userSessionVersion,
      params.membershipVersion,
      params.supabaseSub ?? null,
      getClientIp(req),
      String(req.headers['user-agent'] || '').slice(0, 500),
      String(ttlSec),
    ]
  );

  const signedCookie = signSessionCookieValue(rawToken, db.config.authSessionSecret);
  setCookie(req, res, db.config.cookieName, signedCookie, ttlSec, db.config.isProduction);
  return Number(sessionRes.rows[0].id);
}

async function listUserAuthorizedCompanies(tx: SqlExecutor, userId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await tx.query<{
    company_id: number;
    slug: string;
    name: string;
    legal_name: string;
    currency_symbol: string;
    base_currency: string;
    role: CompanyRole;
    is_default: boolean;
  }>(
    `SELECT
       c.id AS company_id,
       c.slug,
       c.name,
       c.legal_name,
       c.currency_symbol,
       c.base_currency,
       m.role,
       m.is_default
     FROM company_memberships m
     JOIN companies c ON c.id = m.company_id
     WHERE m.user_id = $1
       AND c.is_active = TRUE
       AND m.is_active = TRUE
       AND m.revoked_at IS NULL
       AND (m.expires_on IS NULL OR m.expires_on >= $2::date)
     ORDER BY m.is_default DESC, c.name ASC`,
    [userId, today]
  );
  return res.rows.map(r => ({
    id: Number(r.company_id),
    slug: r.slug,
    name: r.name,
    legalName: r.legal_name,
    currencySymbol: r.currency_symbol,
    baseCurrency: r.base_currency,
    role: r.role,
    isDefault: Boolean(r.is_default),
  }));
}

export function createAuthRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(db);

  // GET /api/auth/status
  router.get('/status', async (req: Request, res: Response, next) => {
    const cookies = req.headers.cookie;
    const bearer = req.headers.authorization;
    if (!cookies?.includes(`${db.config.cookieName}=`) && !bearer) {
      return res.json({ authenticated: false });
    }
    return requireAuth(req, res, async () => {
      const auth = req.auth!;
      const companies = await db.withSystemDb(tx => listUserAuthorizedCompanies(tx, auth.userId));
      return res.json({
        authenticated: true,
        authMode: auth.authMode,
        user: {
          id: auth.userId,
          username: auth.username,
          email: auth.email,
          displayName: auth.displayName,
          mustChangePassword: auth.mustChangePassword,
        },
        activeCompany: {
          id: auth.companyId,
          slug: auth.companySlug,
          name: auth.companyName,
          role: auth.role,
        },
        permissions: getRolePermissions(auth.role),
        companies,
      });
    });
  });

  // POST /api/auth/register — self-service user + new isolated company onboarding
  router.post('/register', async (req: Request, res: Response) => {
    try {
      const username = String(req.body?.username || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const displayName = String(req.body?.displayName || username).trim();
      const password = String(req.body?.password || '');
      const companyName = String(req.body?.companyName || '').trim();

      if (!username || username.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
      }
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email address is required' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      if (!companyName || companyName.length < 2) {
        return res.status(400).json({ error: 'Company name is required' });
      }

      const passwordHash = hashPassword(password);
      const sbSync = await syncUserToSupabaseAdmin(db.config, {
        email,
        password,
        displayName,
      });

      const created = await db.withSystemDb(async tx => {
        const dup = await tx.query<{ id: number }>(
          `SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2) LIMIT 1`,
          [username, email]
        );
        if (dup.rows.length > 0) {
          return { conflict: true as const };
        }

        const uRes = await tx.query<{ id: number; session_version: number }>(
          `INSERT INTO users (username, email, display_name, password_hash, supabase_uid, is_active)
           VALUES ($1, $2, $3, $4, $5::uuid, TRUE)
           RETURNING id, session_version`,
          [username, email, displayName, passwordHash, sbSync.supabaseUid]
        );
        const userId = Number(uRes.rows[0].id);
        const userSessionVersion = Number(uRes.rows[0].session_version);

        const comp = await createCompanyInTx(tx, {
          name: companyName,
          legalName: String(req.body?.legalName || companyName),
          ownerUserId: userId,
          ownerUsername: username,
          makeDefault: true,
        });

        await issueServerSession(tx, db, req, res, {
          userId,
          companyId: comp.companyId,
          membershipId: comp.membershipId,
          userSessionVersion,
          membershipVersion: 0,
          supabaseSub: sbSync.supabaseUid,
        });

        await writeAuditLog(tx, {
          companyId: comp.companyId,
          actorUserId: userId,
          actorUsername: username,
          action: 'USER_REGISTERED',
          tableName: 'users',
          recordId: userId,
          newValues: { username, email, companyId: comp.companyId, supabaseSynced: sbSync.synced },
        });

        const companies = await listUserAuthorizedCompanies(tx, userId);

        return {
          conflict: false as const,
          userId,
          companyId: comp.companyId,
          companySlug: comp.slug,
          companyName,
          companies,
        };
      });

      if (created.conflict) {
        return res.status(409).json({ error: 'Username or email is already registered' });
      }

      return res.status(201).json({
        authenticated: true,
        user: { id: created.userId, username, email, displayName, mustChangePassword: false },
        activeCompany: {
          id: created.companyId,
          slug: created.companySlug,
          name: created.companyName,
          role: 'Administrator' as CompanyRole,
        },
        permissions: getRolePermissions('Administrator'),
        companies: created.companies,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Registration failed' });
    }
  });

  // POST /api/auth/login — credentials verified server-side, creates revocable session
  router.post('/login', async (req: Request, res: Response) => {
    const identifier = String(req.body?.identifier || req.body?.username || req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const requestedCompanyId = req.body?.companyId ? Number(req.body.companyId) : null;
    const ip = getClientIp(req);
    const ua = String(req.headers['user-agent'] || '');

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Username/email and password are required' });
    }

    type UserRow = {
      id: number;
      username: string;
      email: string;
      display_name: string;
      password_hash: string;
      supabase_uid: string | null;
      is_active: boolean;
      expires_on: string | null;
      session_version: number;
      must_change_password: boolean;
    };

    const result = await db.withSystemDb(async tx => {
      const today = new Date().toISOString().slice(0, 10);
      const userRes = await tx.query<UserRow>(
        `SELECT id, username, email, display_name, password_hash, supabase_uid::text,
                is_active, expires_on::text, session_version, must_change_password
           FROM users
          WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
          LIMIT 1`,
        [identifier]
      );

      let u: UserRow | undefined = userRes.rows[0];
      let supabaseSub: string | null = u?.supabase_uid ?? null;
      let validPassword = false;

      if (!u) {
        // No local profile. The account may still be a valid Supabase Auth user
        // (e.g. created directly in the Supabase dashboard, or provisioned by a
        // different tool). Verify the credentials against Supabase and, on
        // success, provision the local profile + an isolated company so the user
        // can sign in. This mirrors self-service registration and is why a user
        // that "exists in Supabase" no longer fails with "Invalid username/email
        // or password".
        const sbLogin = await authenticateWithSupabasePassword(db.config, identifier, password);
        if (!sbLogin) {
          await recordLoginAttempt(tx, { username: identifier, ipAddress: ip, userAgent: ua, success: false });
          return { ok: false as const, status: 401, error: 'Invalid username/email or password' };
        }

        const email = identifier.includes('@')
          ? identifier.trim().toLowerCase()
          : `${identifier.trim().toLowerCase()}@users.noreply.local`;
        const username = email.split('@')[0] || 'user';
        const displayName = username;
        const passwordHash = hashPassword(password);

        const prov = await tx.query<{ id: number; session_version: number }>(
          `INSERT INTO users (username, email, display_name, password_hash, supabase_uid, is_active)
           VALUES ($1, $2, $3, $4, $5::uuid, TRUE)
           RETURNING id, session_version`,
          [username, email, displayName, passwordHash, sbLogin.supabaseUid]
        );
        const newUserId = Number(prov.rows[0].id);
        const companyName = `${displayName}'s Company`;
        const comp = await createCompanyInTx(tx, {
          name: companyName,
          legalName: companyName,
          ownerUserId: newUserId,
          ownerUsername: username,
          makeDefault: true,
        });

        u = {
          id: newUserId,
          username,
          email,
          display_name: displayName,
          password_hash: passwordHash,
          supabase_uid: sbLogin.supabaseUid,
          is_active: true,
          expires_on: null,
          session_version: Number(prov.rows[0].session_version),
          must_change_password: false,
        };
        supabaseSub = sbLogin.supabaseUid;
        validPassword = true;

        await writeAuditLog(tx, {
          companyId: comp.companyId,
          actorUserId: newUserId,
          actorUsername: username,
          action: 'SUPABASE_USER_PROVISIONED',
          tableName: 'users',
          recordId: newUserId,
          newValues: { email, supabaseUid: sbLogin.supabaseUid, companyId: comp.companyId },
        });
      } else {
        if (!u.is_active || (u.expires_on && u.expires_on.slice(0, 10) < today)) {
          await recordLoginAttempt(tx, { username: u.username, ipAddress: ip, userAgent: ua, success: false });
          return { ok: false as const, status: 403, error: 'Account is deactivated or expired' };
        }

        validPassword = verifyPassword(password, u.password_hash);

        if (!validPassword) {
          // Fallback check against Supabase Auth if user password was updated directly in Supabase
          const sbLogin = await authenticateWithSupabasePassword(db.config, u.email, password);
          if (sbLogin) {
            validPassword = true;
            supabaseSub = sbLogin.supabaseUid;
            await tx.query(
              `UPDATE users SET password_hash = $1, supabase_uid = COALESCE(supabase_uid, $2::uuid) WHERE id = $3`,
              [hashPassword(password), sbLogin.supabaseUid, u.id]
            );
          }
        }

        if (!validPassword) {
          await recordLoginAttempt(tx, { username: u.username, ipAddress: ip, userAgent: ua, success: false });
          return { ok: false as const, status: 401, error: 'Invalid username/email or password' };
        }
      }

      // Enforce two-factor authentication when the account has it enabled.
      // A valid TOTP code or single-use backup code is required before a
      // session is issued. The client is told to prompt for a code via the
      // `twoFactorRequired` flag on the 401 response.
      const twoFactorCode = String(req.body?.twoFactorCode ?? req.body?.code ?? '').trim();
      const tfStatus = await getTwoFactorStatus(tx, Number(u.id));
      if (tfStatus.enabled) {
        if (!twoFactorCode) {
          await recordLoginAttempt(tx, { username: u.username, ipAddress: ip, userAgent: ua, success: false });
          return {
            ok: false as const,
            status: 401,
            error: 'Two-factor authentication code required',
            twoFactorRequired: true,
          };
        }
        const tfOk = await verifyTwoFactorLogin(tx, Number(u.id), twoFactorCode);
        if (!tfOk) {
          await recordLoginAttempt(tx, { username: u.username, ipAddress: ip, userAgent: ua, success: false });
          return {
            ok: false as const,
            status: 401,
            error: 'Invalid two-factor authentication code',
            twoFactorRequired: true,
          };
        }
      }

      const memRes = await tx.query<{
        membership_id: number;
        company_id: number;
        company_slug: string;
        company_name: string;
        role: CompanyRole;
        membership_version: number;
      }>(
        `SELECT
           m.id AS membership_id,
           c.id AS company_id,
           c.slug AS company_slug,
           c.name AS company_name,
           m.role,
           m.membership_version
         FROM company_memberships m
         JOIN companies c ON c.id = m.company_id
         WHERE m.user_id = $1
           AND c.is_active = TRUE
           AND m.is_active = TRUE
           AND m.revoked_at IS NULL
           AND (m.expires_on IS NULL OR m.expires_on >= $2::date)
           ${requestedCompanyId ? 'AND c.id = $3' : ''}
         ORDER BY m.is_default DESC, c.id ASC
         LIMIT 1`,
        requestedCompanyId ? [u.id, today, requestedCompanyId] : [u.id, today]
      );

      if (memRes.rows.length === 0) {
        await recordLoginAttempt(tx, { username: u.username, ipAddress: ip, userAgent: ua, success: false });
        return {
          ok: false as const,
          status: 403,
          error: requestedCompanyId
            ? 'You do not have active membership in the requested company'
            : 'No active company membership assigned to this account',
        };
      }

      const m = memRes.rows[0];
      await tx.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [u.id]);
      await recordLoginAttempt(tx, { username: u.username, ipAddress: ip, userAgent: ua, success: true });

      const sessionId = await issueServerSession(tx, db, req, res, {
        userId: Number(u.id),
        companyId: Number(m.company_id),
        membershipId: Number(m.membership_id),
        userSessionVersion: Number(u.session_version),
        membershipVersion: Number(m.membership_version),
        supabaseSub,
      });

      await writeAuditLog(tx, {
        companyId: Number(m.company_id),
        actorUserId: Number(u.id),
        actorUsername: u.username,
        action: 'LOGIN_SUCCESS',
        tableName: 'auth_sessions',
        recordId: sessionId,
        newValues: { role: m.role, ipAddress: ip },
      });

      const companies = await listUserAuthorizedCompanies(tx, Number(u.id));

      return {
        ok: true as const,
        csrfToken: generateCsrfToken(String(sessionId)),
        user: {
          id: Number(u.id),
          username: u.username,
          email: u.email,
          displayName: u.display_name,
          mustChangePassword: Boolean(u.must_change_password),
        },
        activeCompany: {
          id: Number(m.company_id),
          slug: m.company_slug,
          name: m.company_name,
          role: m.role,
        },
        permissions: getRolePermissions(m.role),
        companies,
      };
    });

    if (!result.ok) {
      const body: Record<string, unknown> = { error: result.error };
      if ((result as any).twoFactorRequired) body.twoFactorRequired = true;
      return res.status(result.status).json(body);
    }

    return res.json({
      authenticated: true,
      csrfToken: (result as any).csrfToken ?? null,
      user: result.user,
      activeCompany: result.activeCompany,
      permissions: result.permissions,
      companies: result.companies,
    });
  });

  // POST /api/auth/supabase-session — verify live Supabase JWT via ES256 JWKS and mint server session
  router.post('/supabase-session', async (req: Request, res: Response) => {
    const accessToken = String(req.body?.accessToken || '');
    if (!accessToken) {
      return res.status(400).json({ error: 'accessToken is required' });
    }
    let claims;
    try {
      claims = await verifySupabaseJwt(accessToken, db.config);
    } catch (err: any) {
      return res.status(401).json({ error: 'Invalid Supabase JWT: ' + (err?.message || 'verification failed') });
    }

    const result = await db.withSystemDb(async tx => {
      const today = new Date().toISOString().slice(0, 10);
      const userRes = await tx.query<{
        id: number;
        username: string;
        email: string;
        display_name: string;
        is_active: boolean;
        expires_on: string | null;
        session_version: number;
        must_change_password: boolean;
      }>(
        `SELECT id, username, email, display_name, is_active, expires_on::text, session_version, must_change_password
           FROM users
          WHERE supabase_uid = $1::uuid OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2::text))
          LIMIT 1`,
        [claims.sub, claims.email ?? null]
      );
      if (userRes.rows.length === 0) {
        return { ok: false as const, status: 403, error: 'Supabase account has no local user profile' };
      }
      const u = userRes.rows[0];
      if (!u.is_active || (u.expires_on && u.expires_on.slice(0, 10) < today)) {
        return { ok: false as const, status: 403, error: 'User account is deactivated or expired' };
      }

      await tx.query(`UPDATE users SET supabase_uid = COALESCE(supabase_uid, $1::uuid) WHERE id = $2`, [
        claims.sub,
        u.id,
      ]);

      const memRes = await tx.query<{
        membership_id: number;
        company_id: number;
        company_slug: string;
        company_name: string;
        role: CompanyRole;
        membership_version: number;
      }>(
        `SELECT m.id AS membership_id, c.id AS company_id, c.slug AS company_slug, c.name AS company_name,
                m.role, m.membership_version
           FROM company_memberships m
           JOIN companies c ON c.id = m.company_id
          WHERE m.user_id = $1 AND c.is_active = TRUE AND m.is_active = TRUE AND m.revoked_at IS NULL
            AND (m.expires_on IS NULL OR m.expires_on >= $2::date)
          ORDER BY m.is_default DESC, c.id ASC
          LIMIT 1`,
        [u.id, today]
      );
      if (memRes.rows.length === 0) {
        return { ok: false as const, status: 403, error: 'No active company membership assigned' };
      }
      const m = memRes.rows[0];
      const sid = await issueServerSession(tx, db, req, res, {
        userId: Number(u.id),
        companyId: Number(m.company_id),
        membershipId: Number(m.membership_id),
        userSessionVersion: Number(u.session_version),
        membershipVersion: Number(m.membership_version),
        supabaseSub: claims.sub,
      });

      await writeAuditLog(tx, {
        companyId: Number(m.company_id),
        actorUserId: Number(u.id),
        actorUsername: u.username,
        action: 'SUPABASE_SESSION_EXCHANGED',
        tableName: 'auth_sessions',
        recordId: sid,
        newValues: { supabaseSub: claims.sub },
      });

      const companies = await listUserAuthorizedCompanies(tx, Number(u.id));
      return {
        ok: true as const,
        csrfToken: generateCsrfToken(String(sid)),
        user: {
          id: Number(u.id),
          username: u.username,
          email: u.email,
          displayName: u.display_name,
          mustChangePassword: Boolean(u.must_change_password),
        },
        activeCompany: {
          id: Number(m.company_id),
          slug: m.company_slug,
          name: m.company_name,
          role: m.role,
        },
        permissions: getRolePermissions(m.role),
        companies,
      };
    });

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ authenticated: true, ...result });
  });

  // POST /api/auth/logout — immediately revokes active session server-side
  router.post('/logout', requireAuth, csrfProtection, async (req: Request, res: Response) => {
    const auth = req.auth!;
    await db.withSystemDb(async tx => {
      if (auth.sessionId) {
        await tx.query(
          `UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = 'user_logout' WHERE id = $1`,
          [auth.sessionId]
        );
      }
      await writeAuditLog(tx, {
        companyId: auth.companyId,
        actorUserId: auth.userId,
        actorUsername: auth.username,
        action: 'LOGOUT',
        tableName: 'auth_sessions',
        recordId: auth.sessionId ?? 0,
      });
    });

    clearSessionCookie(res, db.config.cookieName, req);
    return res.json({ ok: true });
  });

  // POST /api/auth/switch-company — validates target membership and rotates active company binding
  router.post('/switch-company', requireAuth, csrfProtection, async (req: Request, res: Response) => {
    const auth = req.auth!;
    const targetCompanyId = Number(req.body?.companyId);
    if (!Number.isInteger(targetCompanyId) || targetCompanyId <= 0) {
      return res.status(400).json({ error: 'Valid numeric companyId is required' });
    }

    const result = await db.withSystemDb(async tx => {
      const today = new Date().toISOString().slice(0, 10);
      const memRes = await tx.query<{
        membership_id: number;
        company_id: number;
        company_slug: string;
        company_name: string;
        role: CompanyRole;
        membership_version: number;
      }>(
        `SELECT
           m.id AS membership_id,
           c.id AS company_id,
           c.slug AS company_slug,
           c.name AS company_name,
           m.role,
           m.membership_version
         FROM company_memberships m
         JOIN companies c ON c.id = m.company_id
         WHERE m.user_id = $1
           AND m.company_id = $2
           AND c.is_active = TRUE
           AND m.is_active = TRUE
           AND m.revoked_at IS NULL
           AND (m.expires_on IS NULL OR m.expires_on >= $3::date)
         LIMIT 1`,
        [auth.userId, targetCompanyId, today]
      );

      if (memRes.rows.length === 0) {
        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'COMPANY_SWITCH_DENIED',
          tableName: 'company_memberships',
          recordId: targetCompanyId,
          newValues: { targetCompanyId },
        });
        return { ok: false as const, status: 403, error: 'Access to target company is not authorized' };
      }

      const target = memRes.rows[0];
      if (auth.sessionId) {
        await tx.query(
          `UPDATE auth_sessions
              SET active_company_id = $1,
                  membership_id = $2,
                  membership_version = $3,
                  last_seen_at = NOW()
            WHERE id = $4`,
          [target.company_id, target.membership_id, target.membership_version, auth.sessionId]
        );
      }

      await writeAuditLog(tx, {
        companyId: Number(target.company_id),
        actorUserId: auth.userId,
        actorUsername: auth.username,
        action: 'COMPANY_SWITCHED',
        tableName: 'auth_sessions',
        recordId: auth.sessionId ?? 0,
        oldValues: { companyId: auth.companyId, role: auth.role },
        newValues: { companyId: Number(target.company_id), role: target.role },
      });

      const companies = await listUserAuthorizedCompanies(tx, auth.userId);
      return {
        ok: true as const,
        activeCompany: {
          id: Number(target.company_id),
          slug: target.company_slug,
          name: target.company_name,
          role: target.role,
        },
        permissions: getRolePermissions(target.role),
        companies,
      };
    });

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json(result);
  });

  // POST /api/auth/password-recovery — creates time-limited recovery token + optional Supabase reset email
  router.post('/password-recovery', async (req: Request, res: Response) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const rawToken = generateOpaqueToken(24);
    const tokenHash = sha256Hex(rawToken);

    const outcome = await db.withSystemDb(async tx => {
      const uRes = await tx.query<{ id: number; username: string; is_active: boolean }>(
        `SELECT id, username, is_active FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [email]
      );
      if (uRes.rows.length === 0 || !uRes.rows[0].is_active) {
        return { found: false as const };
      }
      const u = uRes.rows[0];
      await tx.query(
        `INSERT INTO password_recovery_tokens (user_id, email, token_hash, delivery_channel, expires_at)
         VALUES ($1, $2, $3, 'local_token', NOW() + INTERVAL '1 hour')`,
        [u.id, email, tokenHash]
      );

      const memRes = await tx.query<{ company_id: number }>(
        `SELECT company_id FROM company_memberships WHERE user_id = $1 LIMIT 1`,
        [u.id]
      );
      if (memRes.rows.length > 0) {
        await writeAuditLog(tx, {
          companyId: Number(memRes.rows[0].company_id),
          actorUserId: Number(u.id),
          actorUsername: u.username,
          action: 'PASSWORD_RECOVERY_REQUESTED',
          tableName: 'password_recovery_tokens',
          recordId: Number(u.id),
          newValues: { email },
        });
      }
      return { found: true as const };
    });

    // Never enumerate unregistered emails in response body; only emit preview token when explicitly running non-prod/test harness
    return res.json({
      ok: true,
      message: 'If an active account matches that email, recovery instructions have been issued.',
      ...(outcome.found && !db.config.isProduction ? { devRecoveryToken: rawToken } : {}),
    });
  });

  // POST /api/auth/password-reset — consumes recovery token, resets password, invalidates ALL prior sessions
  router.post('/password-reset', async (req: Request, res: Response) => {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (!token || newPassword.length < 8) {
      return res.status(400).json({ error: 'Valid recovery token and password (min 8 chars) are required' });
    }
    const tokenHash = sha256Hex(token);
    const newHash = hashPassword(newPassword);

    const outcome = await db.withSystemDb(async tx => {
      const r = await tx.query<{
        id: number;
        user_id: number;
        email: string;
        username: string;
        display_name: string;
        supabase_uid: string | null;
        expires_at: string;
        used_at: string | null;
      }>(
        `SELECT p.id, p.user_id, p.email, u.username, u.display_name, u.supabase_uid::text,
                p.expires_at::text, p.used_at::text
           FROM password_recovery_tokens p
           JOIN users u ON u.id = p.user_id
          WHERE p.token_hash = $1
          LIMIT 1`,
        [tokenHash]
      );
      if (r.rows.length === 0) {
        return { ok: false as const, status: 400, error: 'Invalid password recovery token' };
      }
      const row = r.rows[0];
      if (row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
        return { ok: false as const, status: 400, error: 'Recovery token is already used or expired' };
      }

      await tx.query(`UPDATE password_recovery_tokens SET used_at = NOW() WHERE id = $1`, [row.id]);
      await tx.query(
        `UPDATE users
            SET password_hash = $1,
                session_version = session_version + 1,
                must_change_password = FALSE,
                last_password_change_at = NOW()
          WHERE id = $2`,
        [newHash, row.user_id]
      );
      await tx.query(
        `UPDATE auth_sessions
            SET revoked_at = NOW(), revoke_reason = 'password_reset'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [row.user_id]
      );

      const memRes = await tx.query<{ company_id: number }>(
        `SELECT company_id FROM company_memberships WHERE user_id = $1 LIMIT 1`,
        [row.user_id]
      );
      if (memRes.rows.length > 0) {
        await writeAuditLog(tx, {
          companyId: Number(memRes.rows[0].company_id),
          actorUserId: Number(row.user_id),
          actorUsername: row.username,
          action: 'PASSWORD_RESET_COMPLETED',
          tableName: 'users',
          recordId: Number(row.user_id),
          newValues: { sessionsRevoked: true },
        });
      }

      return { ok: true as const, row };
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });

    await syncUserToSupabaseAdmin(db.config, {
      email: outcome.row.email,
      password: newPassword,
      displayName: outcome.row.display_name,
      existingSupabaseUid: outcome.row.supabase_uid,
    });

    return res.json({ ok: true, message: 'Password updated and all prior sessions invalidated.' });
  });

  return router;
}
