import crypto from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { ServerConfig } from './config.ts';

export interface VerifiedSupabaseClaims {
  sub: string;
  email?: string;
  role?: string;
  payload: JWTPayload;
}

let cachedJwksUrl = '';
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(jwksUrl: string) {
  if (!cachedJwks || cachedJwksUrl !== jwksUrl) {
    cachedJwksUrl = jwksUrl;
    cachedJwks = createRemoteJWKSet(new URL(jwksUrl));
  }
  return cachedJwks;
}

export function createSupabasePublicClient(config: ServerConfig): SupabaseClient | null {
  if (!config.supabaseUrl || !config.supabasePublishableKey) return null;
  return createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export function createSupabaseAdminClient(config: ServerConfig): SupabaseClient | null {
  if (!config.supabaseUrl || !config.supabaseSecretKey) return null;
  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Verifies a Supabase JWT access token against the Supabase project's JWKS endpoint (ES256 / RS256).
 */
export async function verifySupabaseJwt(
  token: string,
  config: ServerConfig
): Promise<VerifiedSupabaseClaims> {
  if (!config.supabaseJwksUrl) {
    throw new Error('SUPABASE_JWKS_URL is not configured');
  }
  const jwks = getJwks(config.supabaseJwksUrl);
  const expectedIssuer = config.supabaseUrl ? `${config.supabaseUrl}/auth/v1` : undefined;

  const { payload } = await jwtVerify(token, jwks, {
    ...(expectedIssuer ? { issuer: expectedIssuer } : {}),
  });

  if (!payload.sub) {
    throw new Error('Supabase JWT missing sub claim');
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    role: typeof payload.role === 'string' ? payload.role : undefined,
    payload,
  };
}

/**
 * Password hashing using Node built-in salted scrypt (work factor N=16384, r=8, p=1).
 * Compatible with SlowBooks PBKDF2/scrypt salted hash discipline using zero external native dependencies.
 */
export function hashPassword(password: string): string {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$16384$8$1$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!password || !storedHash) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, salt, expectedHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !expectedHex) {
    return false;
  }
  const actualBuf = crypto.scryptSync(password, salt, 64, { N, r, p });
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export function generateOpaqueToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Signs a session token using HMAC-SHA256 (`<rawToken>.<hmac>`), preventing forged cookies
 * even before hitting the database, while database `auth_sessions` enforces revocation & expiry.
 */
export function signSessionCookieValue(rawToken: string, secret: string): string {
  const mac = crypto.createHmac('sha256', secret).update(rawToken, 'utf8').digest('base64url');
  return `${rawToken}.${mac}`;
}

export function verifySignedSessionCookieValue(cookieValue: string, secret: string): string | null {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const idx = cookieValue.lastIndexOf('.');
  if (idx <= 0) return null;
  const rawToken = cookieValue.slice(0, idx);
  const providedMac = cookieValue.slice(idx + 1);
  if (!rawToken || !providedMac) return null;

  const expectedMac = crypto.createHmac('sha256', secret).update(rawToken, 'utf8').digest('base64url');
  const providedBuf = Buffer.from(providedMac, 'utf8');
  const expectedBuf = Buffer.from(expectedMac, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) return null;
  return rawToken;
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

/**
 * Provisions or synchronizes a user in Supabase Auth (best effort via Admin API).
 * Never stores plaintext passwords locally.
 */
export async function syncUserToSupabaseAdmin(
  config: ServerConfig,
  params: { email: string; password: string; displayName: string; existingSupabaseUid?: string | null }
): Promise<{ supabaseUid: string | null; synced: boolean; error?: string }> {
  const admin = createSupabaseAdminClient(config);
  if (!admin) {
    return { supabaseUid: params.existingSupabaseUid ?? null, synced: false };
  }
  try {
    if (params.existingSupabaseUid) {
      const { data, error } = await admin.auth.admin.updateUserById(params.existingSupabaseUid, {
        email: params.email,
        password: params.password,
        email_confirm: true,
        user_metadata: { display_name: params.displayName },
      });
      if (error) return { supabaseUid: params.existingSupabaseUid, synced: false, error: error.message };
      return { supabaseUid: data.user?.id ?? params.existingSupabaseUid, synced: true };
    }

    const { data, error } = await admin.auth.admin.createUser({
      email: params.email,
      password: params.password,
      email_confirm: true,
      user_metadata: { display_name: params.displayName },
    });
    if (error) {
      // If user already exists in Supabase Auth, attempt lookup via listUsers
      const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const found = list.data?.users?.find(u => u.email?.toLowerCase() === params.email.toLowerCase());
      if (found) {
        return { supabaseUid: found.id, synced: true };
      }
      return { supabaseUid: null, synced: false, error: error.message };
    }
    return { supabaseUid: data.user?.id ?? null, synced: true };
  } catch (err: any) {
    return { supabaseUid: params.existingSupabaseUid ?? null, synced: false, error: err?.message || String(err) };
  }
}

export async function authenticateWithSupabasePassword(
  config: ServerConfig,
  email: string,
  password: string
): Promise<{ accessToken: string; supabaseUid: string } | null> {
  const client = createSupabasePublicClient(config);
  if (!client) return null;
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) return null;
    return {
      accessToken: data.session.access_token,
      supabaseUid: data.user.id,
    };
  } catch {
    return null;
  }
}
