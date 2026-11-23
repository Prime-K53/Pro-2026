import { Router, Request, Response } from 'express';
import { ServerDatabase } from '../db.ts';
import { createAuthMiddleware } from '../middleware/auth.ts';
import { csrfProtection } from '../middleware/csrf.ts';
import { AccountingError } from '../services/accountingEngine.ts';
import { Transaction } from '@electric-sql/pglite';
import * as twoFactorService from '../services/twoFactorService.ts';
import { rateLimit } from '../rateLimiter.ts';
import { writeAuditLog } from '../audit.ts';

// Throttle OTP/backup-code attempts to resist brute force (per client IP).
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

function handleError(res: Response, err: unknown): Response {
  if (err instanceof AccountingError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  const msg = (err as any)?.message || '2FA service error';
  console.error('[2FA Route Error]', err);
  return res.status(500).json({ error: msg });
}

export function createTwoFactorRoutes(db: ServerDatabase): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(db);

  router.use('/auth/2fa', requireAuth, csrfProtection);

  // GET /auth/2fa/status — check if 2FA is enabled
  router.get('/auth/2fa/status', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const status = await db.withCompanyDb(auth.companyId, (tx: Transaction) =>
        twoFactorService.getTwoFactorStatus(tx, auth.userId)
      );
      return res.json(status);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /auth/2fa/enroll — generate TOTP secret and QR URI
  router.post('/auth/2fa/enroll', async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const result = await db.withCompanyDb(auth.companyId, async (tx: Transaction) => {
        const r = await twoFactorService.enrollTwoFactor(tx, auth.userId);
        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'TWO_FACTOR_ENROLLED',
          tableName: 'user_two_factor_secrets',
          recordId: auth.userId,
          newValues: { step: 'enrolled' },
        });
        return r;
      });
      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /auth/2fa/verify — verify TOTP code and enable 2FA
  router.post('/auth/2fa/verify', otpLimiter, async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { code } = req.body || {};
      if (!code) {
        return res.status(400).json({ error: 'code is required' });
      }
      const enabled = await db.withCompanyDb(auth.companyId, async (tx: Transaction) => {
        const ok = await twoFactorService.verifyAndEnableTwoFactor(tx, auth.userId, code);
        if (ok) {
          await writeAuditLog(tx, {
            companyId: auth.companyId,
            actorUserId: auth.userId,
            actorUsername: auth.username,
            action: 'TWO_FACTOR_ENABLED',
            tableName: 'user_two_factor_secrets',
            recordId: auth.userId,
            newValues: { enabled: true },
          });
        }
        return ok;
      });
      if (!enabled) {
        return res.status(400).json({ error: 'Invalid TOTP code' });
      }
      return res.json({ enabled: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /auth/2fa/backup-codes — generate backup codes
  router.post('/auth/2fa/backup-codes', otpLimiter, async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const codes = await db.withCompanyDb(auth.companyId, async (tx: Transaction) => {
        const c = await twoFactorService.generateBackupCodesForUser(tx, auth.userId);
        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'TWO_FACTOR_BACKUP_CODES_REGENERATED',
          tableName: 'user_backup_codes',
          recordId: auth.userId,
          newValues: { count: c.length },
        });
        return c;
      });
      return res.json({ codes });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /auth/2fa/disable — disable 2FA
  router.post('/auth/2fa/disable', otpLimiter, async (req: Request, res: Response) => {
    try {
      const auth = req.auth!;
      const { password } = req.body || {};
      if (!password) {
        return res.status(400).json({ error: 'password is required' });
      }
      await db.withCompanyDb(auth.companyId, async (tx: Transaction) => {
        await twoFactorService.disableTwoFactor(tx, auth.userId, password);
        await writeAuditLog(tx, {
          companyId: auth.companyId,
          actorUserId: auth.userId,
          actorUsername: auth.username,
          action: 'TWO_FACTOR_DISABLED',
          tableName: 'user_two_factor_secrets',
          recordId: auth.userId,
          newValues: { enabled: false },
        });
      });
      return res.json({ disabled: true });
    } catch (err) {
      return handleError(res, err);
    }
  });

  return router;
}