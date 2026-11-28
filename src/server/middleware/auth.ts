import { NextFunction, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { CompanyRole, hasPermission, Permission } from '../permissions.ts';
import {
  parseCookies,
  sha256Hex,
  verifySignedSessionCookieValue,
  verifySupabaseJwt,
} from '../supabaseAuth.ts';
import { writeAuditLog } from '../audit.ts';

export interface AuthContext {
  sessionId: number | null;
  authMode: 'session_cookie' | 'supabase_jwt';
  userId: number;
  username: string;
  email: string;
  displayName: string;
  mustChangePassword: boolean;
  companyId: number;
  companySlug: string;
  companyName: string;
  membershipId: number;
  role: CompanyRole;
  userSessionVersion: number;
  membershipVersion: number;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function getClientIp(req: Request): string {
  // Only trust X-Forwarded-For when explicitly behind a proxy (TRUST_PROXY).
  // Otherwise a client could spoof its IP to evade per-IP rate limiting.
  if (process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
      return fwd.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

export function isHttpsRequest(req?: Request): boolean {
  if (!req) return process.env.NODE_ENV === 'production';
  const proto = String(req.headers?.['x-forwarded-proto'] || '').toLowerCase();
  return Boolean(req.secure || proto.includes('https'));
}

export function setSessionCookie(
  req: Request,
  res: Response,
  cookieName: string,
  value: string,
  maxAgeSec: number,
  isProduction: boolean
) {
  const https = isHttpsRequest(req) || isProduction;
  res.cookie(cookieName, value, {
    httpOnly: true,
    sameSite: https ? 'none' : 'lax',
    secure: https,
    ...(https ? { partitioned: true } : {}),
    maxAge: maxAgeSec * 1000,
    path: '/',
  } as any);
}

export function clearSessionCookie(res: Response, cookieName: string, req?: Request) {
  const https = isHttpsRequest(req) || process.env.NODE_ENV === 'production';
  res.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: https ? 'none' : 'lax',
    secure: https,
    ...(https ? { partitioned: true } : {}),
    path: '/',
  } as any);
}

function isPastDate(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const today = new Date().toISOString().slice(0, 10);
  return dateStr.slice(0, 10) < today;
}

interface SessionLookupRow {
  session_id: number;
  user_id: number;
  username: string;
  email: string;
  display_name: string;
  user_active: boolean;
  user_expires_on: string | null;
  current_user_session_version: number;
  session_recorded_user_version: number;
  must_change_password: boolean;
  company_id: number;
  company_slug: string;
  company_name: string;
  company_active: boolean;
  membership_id: number;
  role: CompanyRole;
  membership_active: boolean;
  membership_expires_on: string | null;
  membership_revoked_at: string | null;
  current_membership_version: number;
  session_recorded_membership_version: number;
  session_expires_at: string;
  last_seen_at: string;
  session_revoked_at: string | null;
}

export function createAuthMiddleware(db: ServerDatabase) {
  const validateServerSession = async (rawToken: string) => {
    const tokenHash = sha256Hex(rawToken);
    return db.withSystemDb(async tx => {
      const r = await tx.query<SessionLookupRow>(
        `SELECT
           s.id AS session_id,
           u.id AS user_id,
           u.username,
           u.email,
           u.display_name,
           u.is_active AS user_active,
           u.expires_on::text AS user_expires_on,
           u.session_version AS current_user_session_version,
           s.user_session_version AS session_recorded_user_version,
           u.must_change_password,
           c.id AS company_id,
           c.slug AS company_slug,
           c.name AS company_name,
           c.is_active AS company_active,
           m.id AS membership_id,
           m.role,
           m.is_active AS membership_active,
           m.expires_on::text AS membership_expires_on,
           m.revoked_at::text AS membership_revoked_at,
           m.membership_version AS current_membership_version,
           s.membership_version AS session_recorded_membership_version,
           s.expires_at::text AS session_expires_at,
           s.last_seen_at::text AS last_seen_at,
           s.revoked_at::text AS session_revoked_at
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN companies c ON c.id = s.active_company_id
         JOIN company_memberships m ON m.id = s.membership_id AND m.company_id = s.active_company_id
         WHERE s.session_token_hash = $1
         LIMIT 1`,
        [tokenHash]
      );

      if (r.rows.length === 0) {
        return { ok: false as const, status: 401, error: 'Session not found' };
      }
      const row = r.rows[0];
      const nowMs = Date.now();

      if (row.session_revoked_at) {
        return { ok: false as const, status: 401, error: 'Session has been revoked' };
      }
      if (new Date(row.session_expires_at).getTime() <= nowMs) {
        await tx.query(
          `UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = 'expired' WHERE id = $1`,
          [row.session_id]
        );
        return { ok: false as const, status: 401, error: 'Session expired' };
      }
      const idleMs = nowMs - new Date(row.last_seen_at).getTime();
      if (idleMs > db.config.idleTimeoutSeconds * 1000) {
        await tx.query(
          `UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = 'idle_timeout' WHERE id = $1`,
          [row.session_id]
        );
        return { ok: false as const, status: 401, error: 'Session timed out due to inactivity' };
      }
      if (!row.user_active || isPastDate(row.user_expires_on)) {
        return { ok: false as const, status: 403, error: 'User account is deactivated or expired' };
      }
      if (Number(row.current_user_session_version) !== Number(row.session_recorded_user_version)) {
        return { ok: false as const, status: 401, error: 'Session invalidated by account security change' };
      }
      if (!row.company_active) {
        return { ok: false as const, status: 403, error: 'Active company is disabled' };
      }
      if (
        !row.membership_active ||
        row.membership_revoked_at ||
        isPastDate(row.membership_expires_on)
      ) {
        return { ok: false as const, status: 403, error: 'Company membership revoked or inactive' };
      }
      if (Number(row.current_membership_version) !== Number(row.session_recorded_membership_version)) {
        return {
          ok: false as const,
          status: 401,
          error: 'Session invalidated by company membership role/status change',
        };
      }

      await tx.query(`UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = $1`, [row.session_id]);

      return {
        ok: true as const,
        auth: {
          sessionId: Number(row.session_id),
          authMode: 'session_cookie' as const,
          userId: Number(row.user_id),
          username: row.username,
          email: row.email,
          displayName: row.display_name,
          mustChangePassword: Boolean(row.must_change_password),
          companyId: Number(row.company_id),
          companySlug: row.company_slug,
          companyName: row.company_name,
          membershipId: Number(row.membership_id),
          role: row.role,
          userSessionVersion: Number(row.current_user_session_version),
          membershipVersion: Number(row.current_membership_version),
        },
      };
    });
  };

  const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const rawCookie = cookies[db.config.cookieName];
      const authHeader = req.headers.authorization;
      const bearerToken =
        typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
          ? authHeader.slice(7).trim()
          : null;

      // Path 1: Cookie-backed server-tracked session
      if (rawCookie) {
        const rawToken = verifySignedSessionCookieValue(rawCookie, db.config.authSessionSecret);
        if (!rawToken) {
          clearSessionCookie(res, db.config.cookieName, req);
          return res.status(401).json({ error: 'Invalid session signature' });
        }

        const validation = await validateServerSession(rawToken);
        if (!validation.ok) {
          clearSessionCookie(res, db.config.cookieName, req);
          return res.status(validation.status).json({ error: validation.error });
        }

        req.auth = validation.auth;
        return next();
      }

      // Path 2: Signed server session token passed as Authorization: Bearer (iframe fallback when 3P cookies are blocked)
      if (bearerToken) {
        const rawServerToken = verifySignedSessionCookieValue(bearerToken, db.config.authSessionSecret);
        if (rawServerToken) {
          const validation = await validateServerSession(rawServerToken);
          if (!validation.ok) {
            return res.status(validation.status).json({ error: validation.error });
          }
          req.auth = validation.auth;
          return next();
        }
      }

      // Path 3: Supabase Bearer JWT verified via remote ES256 JWKS
      if (bearerToken) {
        let claims;
        try {
          claims = await verifySupabaseJwt(bearerToken, db.config);
        } catch {
          return res.status(401).json({ error: 'Invalid or expired Supabase bearer token' });
        }

        const requestedCompanyHeader = req.headers['x-company-id'];
        const requestedCompanyId =
          typeof requestedCompanyHeader === 'string' && /^\d+$/.test(requestedCompanyHeader)
            ? Number(requestedCompanyHeader)
            : null;

        const jwtLookup = await db.withSystemDb(async tx => {
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
              WHERE supabase_uid = $1::uuid
                 OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2::text))
              LIMIT 1`,
            [claims.sub, claims.email ?? null]
          );

          if (userRes.rows.length === 0) {
            return { ok: false as const, status: 403, error: 'Supabase user has no provisioned local profile' };
          }
          const u = userRes.rows[0];
          if (!u.is_active || isPastDate(u.expires_on)) {
            return { ok: false as const, status: 403, error: 'User account is deactivated or expired' };
          }

          const memRes = await tx.query<{
            membership_id: number;
            company_id: number;
            company_slug: string;
            company_name: string;
            role: CompanyRole;
            is_default: boolean;
            is_active: boolean;
            expires_on: string | null;
            revoked_at: string | null;
            membership_version: number;
          }>(
            `SELECT
               m.id AS membership_id,
               m.company_id,
               c.slug AS company_slug,
               c.name AS company_name,
               m.role,
               m.is_default,
               m.is_active,
               m.expires_on::text,
               m.revoked_at::text,
               m.membership_version
             FROM company_memberships m
             JOIN companies c ON c.id = m.company_id
             WHERE m.user_id = $1
               AND c.is_active = TRUE
               ${requestedCompanyId ? 'AND m.company_id = $2' : ''}
             ORDER BY m.is_default DESC, m.id ASC
             LIMIT 1`,
            requestedCompanyId ? [u.id, requestedCompanyId] : [u.id]
          );

          if (memRes.rows.length === 0) {
            return { ok: false as const, status: 403, error: 'No active company membership authorized' };
          }
          const m = memRes.rows[0];
          if (!m.is_active || m.revoked_at || isPastDate(m.expires_on)) {
            return { ok: false as const, status: 403, error: 'Company membership revoked or inactive' };
          }

          return {
            ok: true as const,
            auth: {
              sessionId: null,
              authMode: 'supabase_jwt' as const,
              userId: Number(u.id),
              username: u.username,
              email: u.email,
              displayName: u.display_name,
              mustChangePassword: Boolean(u.must_change_password),
              companyId: Number(m.company_id),
              companySlug: m.company_slug,
              companyName: m.company_name,
              membershipId: Number(m.membership_id),
              role: m.role,
              userSessionVersion: Number(u.session_version),
              membershipVersion: Number(m.membership_version),
            },
          };
        });

        if (!jwtLookup.ok) {
          return res.status(jwtLookup.status).json({ error: jwtLookup.error });
        }
        req.auth = jwtLookup.auth;
        return next();
      }

      return res.status(401).json({ error: 'Authentication required' });
    } catch (err) {
      return res.status(401).json({ error: 'Authentication verification failed' });
    }
  };

  /**
   * Prevents IDOR / cross-company parameter tampering:
   * If a client supplies `?companyId=`, `?company_id=`, `X-Company-Id`, or body `companyId`/`company_id`
   * that differs from the authenticated session's active companyId, immediately reject with 403 and log!
   */
  const rejectCrossCompanyParams = async (req: Request, res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const candidates: Array<[string, unknown]> = [
      ['query.companyId', req.query?.companyId],
      ['query.company_id', req.query?.company_id],
      ['header.x-company-id', req.headers['x-company-id']],
      ['body.companyId', req.body?.companyId],
      ['body.company_id', req.body?.company_id],
      ['params.companyId', req.params?.companyId],
    ];

    for (const [source, raw] of candidates) {
      if (raw === undefined || raw === null || raw === '') continue;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed !== auth.companyId) {
        await db.withSystemDb(async tx => {
          await writeAuditLog(tx, {
            companyId: auth.companyId,
            actorUserId: auth.userId,
            actorUsername: auth.username,
            action: 'CROSS_COMPANY_ATTEMPT',
            tableName: 'security_guard',
            recordId: Number.isInteger(parsed) ? parsed : 0,
            newValues: {
              source,
              attemptedCompanyId: String(raw),
              authorizedCompanyId: auth.companyId,
              path: req.originalUrl,
              method: req.method,
            },
          });
        });

        return res.status(403).json({
          error: 'Cross-company access denied. Use authenticated company switching to change tenant context.',
        });
      }
    }

    return next();
  };

  const requirePermission = (permission: Permission) => {
    return (req: Request, res: Response, next: NextFunction) => {
      const auth = req.auth;
      if (!auth) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!hasPermission(auth.role, permission)) {
        return res.status(403).json({
          error: `Role '${auth.role}' lacks required permission '${permission}'`,
        });
      }
      return next();
    };
  };

  /**
   * Read/write permission pair: GET/HEAD/OPTIONS require `readPerm`, mutating
   * methods require `writePerm`. Keeps routers to a single guard line.
   */
  const requireReadOrWrite = (readPerm: Permission, writePerm: Permission) => {
    return (req: Request, res: Response, next: NextFunction) => {
      const perm = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? readPerm : writePerm;
      return requirePermission(perm)(req, res, next);
    };
  };

  return {
    requireAuth,
    rejectCrossCompanyParams,
    requirePermission,
    requireReadOrWrite,
  };
}
