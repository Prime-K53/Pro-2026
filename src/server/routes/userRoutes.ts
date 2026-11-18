import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import {
  ALL_COMPANY_ROLES,
  CompanyRole,
  getPermissionMatrixRows,
  getRolePermissions,
  isValidCompanyRole,
} from '../permissions.ts';
import {
  generateOpaqueToken,
  hashPassword,
  sha256Hex,
  syncUserToSupabaseAdmin,
} from '../supabaseAuth.ts';
import { writeAuditLog } from '../audit.ts';

export function createUserRouter(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth, rejectCrossCompanyParams, requirePermission } = createAuthMiddleware(db);

  // GET /api/permissions/matrix — inspect RBAC matrix & active session role
  router.get('/permissions/matrix', requireAuth, async (req: Request, res: Response) => {
    return res.json({
      roles: ALL_COMPANY_ROLES,
      currentRole: req.auth!.role,
      currentPermissions: getRolePermissions(req.auth!.role),
      matrix: getPermissionMatrixRows(),
    });
  });

  // GET /api/users — Administrator only; strictly scoped to active company via RLS
  router.get(
    '/users',
    requireAuth,
    rejectCrossCompanyParams,
    requirePermission('users:list'),
    async (req: Request, res: Response) => {
      const auth = req.auth!;
      const data = await db.withCompanyDb(auth.companyId, async tx => {
        const members = await tx.query<{
          membership_id: number;
          user_id: number;
          username: string;
          email: string;
          display_name: string;
          user_active: boolean;
          role: CompanyRole;
          membership_active: boolean;
          expires_on: string | null;
          revoked_at: string | null;
          membership_version: number;
          last_login_at: string | null;
          created_at: string;
        }>(
          `SELECT
             m.id AS membership_id,
             u.id AS user_id,
             u.username,
             u.email,
             u.display_name,
             u.is_active AS user_active,
             m.role,
             m.is_active AS membership_active,
             m.expires_on::text,
             m.revoked_at::text,
             m.membership_version,
             u.last_login_at::text,
             m.created_at::text
           FROM company_memberships m
           JOIN users u ON u.id = m.user_id
           WHERE m.company_id = $1
           ORDER BY m.id ASC`,
          [auth.companyId]
        );

        const invites = await tx.query<{
          id: number;
          email: string;
          username: string;
          display_name: string;
          role: CompanyRole;
          status: string;
          expires_on: string | null;
          invite_expires_at: string;
          created_at: string;
        }>(
          `SELECT id, email, username, display_name, role, status, expires_on::text,
                  invite_expires_at::text, created_at::text
             FROM user_invitations
            WHERE company_id = $1
            ORDER BY created_at DESC`,
          [auth.companyId]
        );

        return { members: members.rows, invitations: invites.rows };
      });

      return res.json({
        companyId: auth.companyId,
        members: data.members.map(m => ({
          membershipId: Number(m.membership_id),
          userId: Number(m.user_id),
          username: m.username,
          email: m.email,
          displayName: m.display_name,
          userActive: Boolean(m.user_active),
          role: m.role,
          membershipActive: Boolean(m.membership_active),
          expiresOn: m.expires_on,
          revokedAt: m.revoked_at,
          membershipVersion: Number(m.membership_version),
          lastLoginAt: m.last_login_at,
          createdAt: m.created_at,
        })),
        invitations: data.invitations.map(inv => ({
          id: Number(inv.id),
          email: inv.email,
          username: inv.username,
          displayName: inv.display_name,
          role: inv.role,
          status: inv.status,
          expiresOn: inv.expires_on,
          inviteExpiresAt: inv.invite_expires_at,
          createdAt: inv.created_at,
        })),
      });
    }
  );

  // POST /api/invitations — Administrator creates one-time invite token bound to active company
  router.post(
    '/invitations',
    requireAuth,
    rejectCrossCompanyParams,
    requirePermission('users:invite'),
    async (req: Request, res: Response) => {
      const auth = req.auth!;
      const email = String(req.body?.email || '').trim().toLowerCase();
      const username = String(req.body?.username || email.split('@')[0] || '').trim();
      const displayName = String(req.body?.displayName || username).trim();
      const role = req.body?.role;
      const expiresOn = req.body?.expiresOn ? String(req.body.expiresOn).slice(0, 10) : null;

      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid invitee email is required' });
      }
      if (!username || username.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
      }
      if (!isValidCompanyRole(role)) {
        return res.status(400).json({ error: `Invalid role. Must be one of: ${ALL_COMPANY_ROLES.join(', ')}` });
      }

      const rawToken = generateOpaqueToken(24);
      const tokenHash = sha256Hex(rawToken);

      const invite = await db.withCompanyDb(auth.companyId, async tx => {
        const resInv = await tx.query<{ id: number; invite_expires_at: string }>(
          `INSERT INTO user_invitations (
             company_id, email, username, display_name, role, token_hash,
             invited_by, expires_on, invite_expires_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8::date, NOW() + INTERVAL '72 hours'
           ) RETURNING id, invite_expires_at::text`,
          [auth.companyId, email, username, displayName, role, tokenHash, auth.userId, expiresOn]
        );
        const inviteId = Number(resInv.rows[0].id);

        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'USER_INVITED',
          tableName: 'user_invitations',
          recordId: inviteId,
          newValues: { email, username, role, expiresOn },
        });

        return { id: inviteId, inviteExpiresAt: resInv.rows[0].invite_expires_at };
      });

      return res.status(201).json({
        invitation: {
          id: invite.id,
          companyId: auth.companyId,
          email,
          username,
          displayName,
          role,
          expiresOn,
          inviteExpiresAt: invite.inviteExpiresAt,
          // Returned once to the Administrator so they can share the one-time invite link/token cleanly
          oneTimeInviteToken: rawToken,
        },
      });
    }
  );

  // POST /api/invitations/accept — Invitee redeems one-time token and sets their own password
  router.post('/invitations/accept', async (req: Request, res: Response) => {
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    if (!token || password.length < 8) {
      return res.status(400).json({ error: 'Valid invitation token and password (min 8 chars) are required' });
    }

    const tokenHash = sha256Hex(token);
    const passHash = hashPassword(password);

    const outcome = await db.withSystemDb(async tx => {
      const invRes = await tx.query<{
        id: number;
        company_id: number;
        email: string;
        username: string;
        display_name: string;
        role: CompanyRole;
        expires_on: string | null;
        invite_expires_at: string;
        status: string;
        invited_by: number;
      }>(
        `SELECT id, company_id, email, username, display_name, role,
                expires_on::text, invite_expires_at::text, status, invited_by
           FROM user_invitations
          WHERE token_hash = $1
          LIMIT 1`,
        [tokenHash]
      );
      if (invRes.rows.length === 0) {
        return { ok: false as const, status: 400, error: 'Invalid invitation token' };
      }
      const inv = invRes.rows[0];
      if (inv.status !== 'pending' || new Date(inv.invite_expires_at).getTime() <= Date.now()) {
        return { ok: false as const, status: 400, error: 'Invitation has already been used, revoked, or expired' };
      }

      // Create user or attach membership if email already exists globally
      let userId: number;
      let existingUid: string | null = null;
      const uLookup = await tx.query<{ id: number; supabase_uid: string | null }>(
        `SELECT id, supabase_uid::text FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [inv.email]
      );
      if (uLookup.rows.length > 0) {
        userId = Number(uLookup.rows[0].id);
        existingUid = uLookup.rows[0].supabase_uid;
        await tx.query(
          `UPDATE users SET password_hash = $1, is_active = TRUE, last_password_change_at = NOW() WHERE id = $2`,
          [passHash, userId]
        );
      } else {
        // Deduplicate username if collision exists across companies
        let candidateUsername = inv.username;
        const dupName = await tx.query<{ id: number }>(
          `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
          [candidateUsername]
        );
        if (dupName.rows.length > 0) {
          candidateUsername = `${inv.username}_${inv.company_id}`;
        }
        const uIns = await tx.query<{ id: number }>(
          `INSERT INTO users (username, email, display_name, password_hash, is_active, last_password_change_at)
           VALUES ($1, $2, $3, $4, TRUE, NOW()) RETURNING id`,
          [candidateUsername, inv.email, inv.display_name, passHash]
        );
        userId = Number(uIns.rows[0].id);
      }

      await tx.query(
        `INSERT INTO company_memberships (company_id, user_id, role, is_default, is_active, expires_on, invited_by)
         VALUES ($1, $2, $3, FALSE, TRUE, $4::date, $5)
         ON CONFLICT (company_id, user_id) DO UPDATE
           SET role = EXCLUDED.role,
               is_active = TRUE,
               revoked_at = NULL,
               revoked_by = NULL,
               expires_on = EXCLUDED.expires_on,
               membership_version = company_memberships.membership_version + 1`,
        [inv.company_id, userId, inv.role, inv.expires_on, inv.invited_by]
      );

      await tx.query(
        `UPDATE user_invitations
            SET status = 'accepted', accepted_by_user_id = $1, accepted_at = NOW()
          WHERE id = $2`,
        [userId, inv.id]
      );

      await writeAuditLog(tx, {
        companyId: Number(inv.company_id),
        actorUserId: userId,
        actorUsername: inv.username,
        action: 'INVITATION_ACCEPTED',
        tableName: 'company_memberships',
        recordId: userId,
        newValues: { role: inv.role, invitationId: Number(inv.id) },
      });

      return { ok: true as const, inv, userId, existingUid };
    });

    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });

    const sbSync = await syncUserToSupabaseAdmin(db.config, {
      email: outcome.inv.email,
      password,
      displayName: outcome.inv.display_name,
      existingSupabaseUid: outcome.existingUid,
    });
    if (sbSync.supabaseUid && sbSync.supabaseUid !== outcome.existingUid) {
      await db.withSystemDb(tx =>
        tx.query(`UPDATE users SET supabase_uid = $1::uuid WHERE id = $2`, [sbSync.supabaseUid, outcome.userId])
      );
    }

    return res.json({
      ok: true,
      companyId: Number(outcome.inv.company_id),
      role: outcome.inv.role,
      message: 'Invitation accepted. You can now sign in.',
    });
  });

  // PATCH /api/users/:userId/membership — change role, expiry, active status; protects last active Admin
  router.patch(
    '/users/:userId/membership',
    requireAuth,
    rejectCrossCompanyParams,
    requirePermission('users:manage'),
    async (req: Request, res: Response) => {
      const auth = req.auth!;
      const targetUserId = Number(req.params.userId);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'Invalid userId' });
      }

      const nextRole = req.body?.role;
      if (nextRole !== undefined && !isValidCompanyRole(nextRole)) {
        return res.status(400).json({ error: 'Invalid company role' });
      }
      const nextIsActive = req.body?.isActive !== undefined ? Boolean(req.body.isActive) : undefined;
      const nextExpiresOn =
        req.body?.expiresOn === null
          ? null
          : req.body?.expiresOn !== undefined
          ? String(req.body.expiresOn).slice(0, 10)
          : undefined;

      const result = await db.withSystemDb(async tx => {
        const curRes = await tx.query<{
          id: number;
          role: CompanyRole;
          is_active: boolean;
          expires_on: string | null;
        }>(
          `SELECT id, role, is_active, expires_on::text
             FROM company_memberships
            WHERE company_id = $1 AND user_id = $2
            LIMIT 1`,
          [auth.companyId, targetUserId]
        );
        if (curRes.rows.length === 0) {
          return { ok: false as const, status: 404, error: 'Company membership not found' };
        }
        const cur = curRes.rows[0];
        const effectiveRole = (nextRole ?? cur.role) as CompanyRole;
        const effectiveActive = nextIsActive ?? cur.is_active;

        // Enforce last-active-administrator invariant (SlowBooks #admin-guard)
        if (cur.role === 'Administrator' && cur.is_active && (effectiveRole !== 'Administrator' || !effectiveActive)) {
          const adminCnt = await tx.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt
               FROM company_memberships
              WHERE company_id = $1 AND role = 'Administrator' AND is_active = TRUE AND revoked_at IS NULL`,
            [auth.companyId]
          );
          if (Number(adminCnt.rows[0].cnt) <= 1) {
            return {
              ok: false as const,
              status: 409,
              error: 'Cannot demote or deactivate the last active Administrator of this company',
            };
          }
        }

        const updated = await tx.query<{
          id: number;
          role: CompanyRole;
          is_active: boolean;
          expires_on: string | null;
          membership_version: number;
        }>(
          `UPDATE company_memberships
              SET role = $1,
                  is_active = $2,
                  expires_on = ${nextExpiresOn === undefined ? 'expires_on' : '$3::date'},
                  revoked_at = CASE WHEN $2 = FALSE THEN COALESCE(revoked_at, NOW()) ELSE NULL END,
                  revoked_by = CASE WHEN $2 = FALSE THEN $4 ELSE NULL END,
                  membership_version = membership_version + 1
            WHERE id = $5
            RETURNING id, role, is_active, expires_on::text, membership_version`,
          nextExpiresOn === undefined
            ? [effectiveRole, effectiveActive, auth.userId, cur.id]
            : [effectiveRole, effectiveActive, nextExpiresOn, auth.userId, cur.id]
        );

        // Immediately revoke any active sessions for this user on this company so changes apply on next request
        await tx.query(
          `UPDATE auth_sessions
              SET revoked_at = NOW(), revoke_reason = 'membership_updated'
            WHERE user_id = $1 AND active_company_id = $2 AND revoked_at IS NULL`,
          [targetUserId, auth.companyId]
        );

        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'MEMBERSHIP_UPDATED',
          tableName: 'company_memberships',
          recordId: Number(cur.id),
          oldValues: { role: cur.role, isActive: cur.is_active, expiresOn: cur.expires_on },
          newValues: { role: effectiveRole, isActive: effectiveActive },
        });

        return { ok: true as const, membership: updated.rows[0] };
      });

      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.json({ membership: result.membership });
    }
  );

  // DELETE /api/users/:userId/membership — immediate revocation + session invalidation
  router.delete(
    '/users/:userId/membership',
    requireAuth,
    rejectCrossCompanyParams,
    requirePermission('users:manage'),
    async (req: Request, res: Response) => {
      const auth = req.auth!;
      const targetUserId = Number(req.params.userId);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'Invalid userId' });
      }

      const result = await db.withSystemDb(async tx => {
        const curRes = await tx.query<{ id: number; role: CompanyRole; is_active: boolean }>(
          `SELECT id, role, is_active FROM company_memberships WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
          [auth.companyId, targetUserId]
        );
        if (curRes.rows.length === 0) {
          return { ok: false as const, status: 404, error: 'Membership not found' };
        }
        const cur = curRes.rows[0];
        if (cur.role === 'Administrator' && cur.is_active) {
          const adminCnt = await tx.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt
               FROM company_memberships
              WHERE company_id = $1 AND role = 'Administrator' AND is_active = TRUE AND revoked_at IS NULL`,
            [auth.companyId]
          );
          if (Number(adminCnt.rows[0].cnt) <= 1) {
            return {
              ok: false as const,
              status: 409,
              error: 'Cannot revoke the last active Administrator of this company',
            };
          }
        }

        await tx.query(
          `UPDATE company_memberships
              SET is_active = FALSE,
                  revoked_at = NOW(),
                  revoked_by = $1,
                  membership_version = membership_version + 1
            WHERE id = $2`,
          [auth.userId, cur.id]
        );

        await tx.query(
          `UPDATE auth_sessions
              SET revoked_at = NOW(), revoke_reason = 'membership_revoked'
            WHERE user_id = $1 AND active_company_id = $2 AND revoked_at IS NULL`,
          [targetUserId, auth.companyId]
        );

        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'MEMBERSHIP_REVOKED',
          tableName: 'company_memberships',
          recordId: Number(cur.id),
          newValues: { targetUserId },
        });

        return { ok: true as const };
      });

      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.json({ ok: true });
    }
  );

  // POST /api/users/:userId/deactivate-global — Administrator global account deactivation (revokes all sessions)
  router.post(
    '/users/:userId/deactivate',
    requireAuth,
    rejectCrossCompanyParams,
    requirePermission('users:manage'),
    async (req: Request, res: Response) => {
      const auth = req.auth!;
      const targetUserId = Number(req.params.userId);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'Invalid userId' });
      }
      if (targetUserId === auth.userId) {
        return res.status(409).json({ error: 'Administrators cannot deactivate their own active account' });
      }

      const result = await db.withSystemDb(async tx => {
        const memCheck = await tx.query<{ id: number; role: CompanyRole }>(
          `SELECT id, role FROM company_memberships WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
          [auth.companyId, targetUserId]
        );
        if (memCheck.rows.length === 0) {
          return { ok: false as const, status: 404, error: 'User does not belong to the active company' };
        }

        await tx.query(
          `UPDATE users SET is_active = FALSE, session_version = session_version + 1 WHERE id = $1`,
          [targetUserId]
        );
        await tx.query(
          `UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = 'user_deactivated'
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [targetUserId]
        );

        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'USER_DEACTIVATED',
          tableName: 'users',
          recordId: targetUserId,
        });

        return { ok: true as const };
      });

      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.json({ ok: true });
    }
  );

  // GET /api/audit/logs — Administrator & Accountant only, strictly RLS-isolated to active company
  router.get(
    '/audit/logs',
    requireAuth,
    rejectCrossCompanyParams,
    requirePermission('audit:read'),
    async (req: Request, res: Response) => {
      const auth = req.auth!;
      const limit = Math.min(200, Math.max(1, Number(req.query?.limit || 50)));
      const rows = await db.withCompanyDb(auth.companyId, async tx => {
        const r = await tx.query<{
          id: number;
          occurred_at: string;
          actor_user_id: number | null;
          actor_username: string | null;
          action: string;
          table_name: string;
          record_id: number;
          new_values: Record<string, unknown> | null;
          sha256_hash: string;
          source: string;
        }>(
          `SELECT id, occurred_at::text, actor_user_id, actor_username, action,
                  table_name, record_id, new_values, sha256_hash, source
             FROM audit_log
            ORDER BY id DESC
            LIMIT $1`,
          [limit]
        );
        return r.rows;
      });

      return res.json({
        companyId: auth.companyId,
        logs: rows.map(r => ({
          id: Number(r.id),
          occurredAt: r.occurred_at,
          actorUserId: r.actor_user_id ? Number(r.actor_user_id) : null,
          actorUsername: r.actor_username,
          action: r.action,
          tableName: r.table_name,
          recordId: Number(r.record_id),
          newValues: r.new_values,
          sha256Hash: r.sha256_hash,
          source: r.source,
        })),
      });
    }
  );

  return router;
}
