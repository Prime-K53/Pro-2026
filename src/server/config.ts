import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';

export interface ServerConfig {
  port: number;
  nodeEnv: string;
  appUrl: string;
  dbDataDir: string;
  attachmentsDir: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseSecretKey: string;
  supabaseJwksUrl: string;
  authSessionSecret: string;
  sessionTtlSeconds: number;
  idleTimeoutSeconds: number;
  cookieName: string;
  isProduction: boolean;
  twilioAuthToken: string | null;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const fallbackSecret = crypto
  .createHash('sha256')
  .update(process.env.SUPABASE_SECRET_KEY || process.cwd() || 'pms-dev-local-fallback')
  .digest('hex');

export function loadServerConfig(): ServerConfig {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const nodeEnv = (process.env.NODE_ENV || 'development').trim();
  const isProduction = nodeEnv === 'production';

  return {
    port: isProduction
      ? parsePositiveInt(process.env.PMS_PORT || process.env.PORT, 3000)
      : parsePositiveInt(process.env.PMS_PORT, 3000),
    nodeEnv,
    appUrl: (process.env.APP_URL || 'http://localhost:3000').trim(),
    dbDataDir: (process.env.PMS_PG_DATA_DIR || path.resolve(process.cwd(), '.data', 'pms-pg')).trim(),
    attachmentsDir: (
      process.env.PMS_ATTACHMENTS_DIR || path.resolve(process.cwd(), '.data', 'attachments')
    ).trim(),
    supabaseUrl,
    supabasePublishableKey: (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim(),
    supabaseSecretKey: (process.env.SUPABASE_SECRET_KEY || '').trim(),
    supabaseJwksUrl: (
      process.env.SUPABASE_JWKS_URL ||
      (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : '')
    ).trim(),
    authSessionSecret: (process.env.AUTH_SESSION_SECRET || fallbackSecret).trim(),
    sessionTtlSeconds: parsePositiveInt(process.env.AUTH_SESSION_TTL_SECONDS, 60 * 60 * 12),
    idleTimeoutSeconds: parsePositiveInt(process.env.AUTH_IDLE_TIMEOUT_SECONDS, 60 * 60 * 2),
    cookieName: 'pms_session',
    isProduction,
    twilioAuthToken: (process.env.TWILIO_AUTH_TOKEN || '').trim() || null,
  };
}
