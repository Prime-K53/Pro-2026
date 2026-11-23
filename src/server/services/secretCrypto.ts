import crypto from 'node:crypto';

/**
 * AES-256-GCM encryption for secrets at rest (AI API keys, TOTP secrets).
 *
 * Key is derived from TOTP_ENC_KEY, falling back to AUTH_SESSION_SECRET.
 * Format: base64(iv).base64(tag).base64(ciphertext).
 * Legacy plain-base64 values are decrypted for backward compatibility.
 */

function getEncryptionKey(): Buffer {
  const secret =
    process.env.TOTP_ENC_KEY ||
    process.env.AUTH_SESSION_SECRET ||
    'pms-local-dev-totp-key-change-me';
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(secret: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptSecret(encrypted: string): string {
  const parts = encrypted.split('.');
  if (parts.length === 3) {
    const [ivB, tagB, dataB] = parts;
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
  // Backward compatibility: previous versions stored plain base64.
  return Buffer.from(encrypted, 'base64').toString('utf8');
}