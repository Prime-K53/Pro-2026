import crypto from 'node:crypto';
import { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';
import { verifyPassword } from '../supabaseAuth.ts';

// ─── TOTP Implementation (RFC 6238) ─────────────────────────────────────

const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30; // seconds
const TOTP_WINDOW = 1; // allow 1 period before/after

/**
 * Generate a random base32 secret for TOTP.
 */
export function generateTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  return base32Encode(bytes);
}

/**
 * Generate a TOTP code for the given secret and time.
 */
export function generateTotpCode(secret: string, time?: number): string {
  const counter = Math.floor((time || Date.now()) / 1000 / TOTP_PERIOD);
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  // Write counter as big-endian 64-bit
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % Math.pow(10, TOTP_DIGITS);
  return code.toString().padStart(TOTP_DIGITS, '0');
}

/**
 * Verify a TOTP code against a secret.
 */
export function verifyTotpCode(secret: string, code: string, time?: number): boolean {
  const now = time || Date.now();
  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    const t = now + i * TOTP_PERIOD * 1000;
    if (generateTotpCode(secret, t) === code) {
      return true;
    }
  }
  return false;
}

/**
 * Generate a QR code URL for TOTP enrolment (otpauth:// URI).
 */
export function getTotpUri(secret: string, accountName: string, issuer: string = 'Prime ERP'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

// ─── Backup Codes ───────────────────────────────────────────────────────

export function generateBackupCodes(count: number = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(code.slice(0, 4) + '-' + code.slice(4, 8));
  }
  return codes;
}

export function hashBackupCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

// ─── Encryption (AES-256-GCM) ───────────────────────────────────────────
// Shared implementation in secretCrypto.ts so AI keys and TOTP secrets use
// the same key derivation and format.

import { encryptSecret, decryptSecret } from './secretCrypto.ts';
export { encryptSecret, decryptSecret };

// ─── Base32 Encoding/Decoding ────────────────────────────────────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

// ─── Database Operations ────────────────────────────────────────────────

export interface TwoFactorStatus {
  enabled: boolean;
  hasSecret: boolean;
  backupCodesRemaining: number;
}

export async function getTwoFactorStatus(tx: Transaction, userId: number): Promise<TwoFactorStatus> {
  const secretRes = await tx.query<any>(
    `SELECT enabled FROM user_two_factor_secrets WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const hasSecret = secretRes.rows.length > 0;
  const enabled = hasSecret && secretRes.rows[0].enabled === true;

  const codesRes = await tx.query<any>(
    `SELECT COUNT(*)::text AS cnt FROM user_backup_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  const backupCodesRemaining = Number(codesRes.rows[0]?.cnt || 0);

  return { enabled, hasSecret, backupCodesRemaining };
}

export async function enrollTwoFactor(tx: Transaction, userId: number): Promise<{ secret: string; uri: string }> {
  const secret = generateTotpSecret();
  const encrypted = encryptSecret(secret);

  // Upsert secret
  const existing = await tx.query<any>(
    `SELECT id FROM user_two_factor_secrets WHERE user_id = $1 LIMIT 1`,
    [userId]
  );

  if (existing.rows.length > 0) {
    await tx.query(
      `UPDATE user_two_factor_secrets SET secret_encrypted = $2, enabled = FALSE, updated_at = NOW() WHERE user_id = $1`,
      [userId, encrypted]
    );
  } else {
    await tx.query(
      `INSERT INTO user_two_factor_secrets (user_id, secret_encrypted, enabled) VALUES ($1, $2, FALSE)`,
      [userId, encrypted]
    );
  }

  // Get user info for URI
  const userRes = await tx.query<any>(
    `SELECT username, email FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  const accountName = userRes.rows[0]?.email || userRes.rows[0]?.username || 'user';

  const uri = getTotpUri(secret, accountName);
  return { secret, uri };
}

export async function verifyAndEnableTwoFactor(tx: Transaction, userId: number, code: string): Promise<boolean> {
  const secretRes = await tx.query<any>(
    `SELECT secret_encrypted FROM user_two_factor_secrets WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (secretRes.rows.length === 0) {
    throw new AccountingError(404, '2FA not enrolled', 'NOT_ENROLLED');
  }

  const secret = decryptSecret(secretRes.rows[0].secret_encrypted);
  if (!verifyTotpCode(secret, code)) {
    return false;
  }

  // Enable 2FA
  await tx.query(
    `UPDATE user_two_factor_secrets SET enabled = TRUE, updated_at = NOW() WHERE user_id = $1`,
    [userId]
  );

  return true;
}

export async function generateBackupCodesForUser(tx: Transaction, userId: number): Promise<string[]> {
  // Delete existing unused codes
  await tx.query(
    `DELETE FROM user_backup_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );

  const codes = generateBackupCodes(10);
  for (const code of codes) {
    const hash = hashBackupCode(code);
    await tx.query(
      `INSERT INTO user_backup_codes (user_id, code_hash) VALUES ($1, $2)`,
      [userId, hash]
    );
  }

  return codes;
}

export async function verifyBackupCode(tx: Transaction, userId: number, code: string): Promise<boolean> {
  const hash = hashBackupCode(code);
  const res = await tx.query<any>(
    `SELECT id FROM user_backup_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1`,
    [userId, hash]
  );
  if (res.rows.length === 0) {
    return false;
  }

  // Mark as used
  await tx.query(
    `UPDATE user_backup_codes SET used_at = NOW() WHERE id = $1`,
    [res.rows[0].id]
  );

  return true;
}

export async function disableTwoFactor(tx: Transaction, userId: number, password: string): Promise<boolean> {
  // Re-authentication is mandatory before disabling 2FA.
  const userRes = await tx.query<any>(`SELECT password_hash FROM users WHERE id = $1 LIMIT 1`, [userId]);
  if (userRes.rows.length === 0 || !verifyPassword(password, userRes.rows[0].password_hash)) {
    throw new AccountingError(403, 'Password verification failed', '2FA_DISABLE_REAUTH');
  }

  // Delete secret and backup codes
  await tx.query(`DELETE FROM user_two_factor_secrets WHERE user_id = $1`, [userId]);
  await tx.query(`DELETE FROM user_backup_codes WHERE user_id = $1`, [userId]);
  return true;
}

export async function verifyTwoFactorLogin(tx: Transaction, userId: number, code: string): Promise<boolean> {
  // Check TOTP code
  const secretRes = await tx.query<any>(
    `SELECT secret_encrypted, enabled FROM user_two_factor_secrets WHERE user_id = $1 LIMIT 1`,
    [userId]
  );

  if (secretRes.rows.length > 0 && secretRes.rows[0].enabled === true) {
    const secret = decryptSecret(secretRes.rows[0].secret_encrypted);
    if (verifyTotpCode(secret, code)) {
      return true;
    }
  }

  // Check backup code
  if (await verifyBackupCode(tx, userId, code)) {
    return true;
  }

  return false;
}