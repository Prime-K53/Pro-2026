import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

// CSRF token store (in-memory for single-process; use Redis for multi-process)
const csrfTokens = new Map<string, { token: string; expiresAt: number }>();

export function generateCsrfToken(sessionId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(sessionId, { token, expiresAt: Date.now() + 3600000 }); // 1 hour
  return token;
}

export function validateCsrfToken(sessionId: string, token: string): boolean {
  const stored = csrfTokens.get(sessionId);
  if (!stored) return false;
  if (stored.expiresAt < Date.now()) {
    csrfTokens.delete(sessionId);
    return false;
  }
  // Timing-safe comparison
  try {
    return crypto.timingSafeEqual(Buffer.from(stored.token), Buffer.from(token));
  } catch {
    return false;
  }
}

/**
 * Whether CSRF tokens are enforced for cookie-authenticated mutations.
 *
 * - `PMS_CSRF=off`      → never enforce (emergency escape hatch)
 * - `PMS_CSRF=enforce`  → always enforce (used by the CSRF regression test)
 * - otherwise           → enforce in production only
 *
 * Development/test default to off so the existing integration suites (which do
 * not yet attach tokens) keep working; production always enforces.
 */
export function csrfEnforced(): boolean {
  const mode = (process.env.PMS_CSRF || '').trim().toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'false') return false;
  if (mode === 'enforce' || mode === 'on' || mode === '1' || mode === 'true') return true;
  return process.env.NODE_ENV === 'production';
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  // Skip for GET, HEAD, OPTIONS (safe methods)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Skip for API key auth (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return next();
  }

  // Skip for webhook endpoints
  if (req.path.includes('/webhooks/') || req.path.includes('/verify/')) {
    return next();
  }

  if (!csrfEnforced()) {
    return next();
  }

  const sessionId = String(
    (req as any).auth?.sessionId ?? (req.headers['x-session-id'] as string) ?? ''
  );
  const csrfToken = req.headers['x-csrf-token'] as string || req.body?._csrf;

  if (!sessionId || !csrfToken) {
    return res.status(403).json({ error: 'CSRF token missing' });
  }

  if (!validateCsrfToken(sessionId, csrfToken)) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  next();
}

// Cleanup expired tokens periodically. `unref()` so importing this module (e.g.
// in tests) does not keep the Node event loop alive after the server closes.
const csrfCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of csrfTokens.entries()) {
    if (value.expiresAt < now) {
      csrfTokens.delete(key);
    }
  }
}, 300000); // 5 minutes
csrfCleanupTimer.unref?.();