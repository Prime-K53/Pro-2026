import crypto from 'node:crypto';
import { Transaction } from '@electric-sql/pglite';
import { AccountingError } from './accountingEngine.ts';

export interface QrVerificationResult {
  valid: boolean;
  companyId?: number;
  documentKind?: string;
  documentId?: number;
  documentVersion?: number;
  documentHash?: string | null;
  createdAt?: string;
  revoked?: boolean;
}

/**
 * Deterministic HMAC of a QR token used as an indexed lookup key.
 * The raw token is never stored.
 *
 * The key comes from QR_TOKEN_KEY / AUTH_SESSION_SECRET. If neither is set we
 * fall back to a random per-process key (never a hardcoded constant) and warn
 * once, so a misconfigured deployment cannot be verified with a known key.
 */
let qrKeyFallback: string | null = null;
function qrTokenLookup(token: string): string {
  const key =
    process.env.QR_TOKEN_KEY ||
    process.env.AUTH_SESSION_SECRET ||
    (qrKeyFallback ??= crypto.randomBytes(32).toString('hex'));
  return crypto.createHmac('sha256', key).update(token).digest('hex');
}

function mapVerificationRow(row: any): QrVerificationResult {
  return {
    valid: row.revoked_at === null,
    companyId: row.company_id != null ? Number(row.company_id) : undefined,
    documentKind: row.document_kind,
    documentId: Number(row.document_id),
    documentVersion: Number(row.document_version ?? 1),
    documentHash: row.document_hash ?? null,
    createdAt: row.created_at,
    revoked: row.revoked_at !== null,
  };
}

export async function generateQrToken(
  tx: Transaction,
  companyId: number,
  documentKind: string,
  documentId: number,
  options: { version?: number; contentHash?: string | null; baseUrl?: string } = {}
): Promise<{ token: string; hash: string; qrDataUrl: string }> {
  const salt = crypto.randomBytes(16).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token + salt).digest('hex');
  const lookup = qrTokenLookup(token);

  await tx.query(
    `INSERT INTO document_qr_codes (company_id, document_kind, document_id, qr_token_hash, qr_token_salt, token_lookup, document_version, document_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      companyId,
      documentKind,
      documentId,
      hash,
      salt,
      lookup,
      Math.max(1, Number(options.version ?? 1)),
      options.contentHash || null,
    ]
  );

  const baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
  const verifyPath = `/api/qr-verify/${token}/page`;
  const verifyUrl = `${baseUrl}${verifyPath}`;
  const QRCode = (await import('qrcode')).default;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });

  return { token, hash, qrDataUrl };
}

export async function verifyQrToken(
  tx: Transaction,
  token: string
): Promise<QrVerificationResult> {
  // Fast path: indexed HMAC lookup.
  const res = await tx.query<any>(
    `SELECT company_id, document_kind, document_id, document_version, document_hash, created_at, revoked_at
       FROM document_qr_codes
      WHERE token_lookup = $1
      LIMIT 1`,
    [qrTokenLookup(token)]
  );
  if (res.rows.length > 0) {
    return mapVerificationRow(res.rows[0]);
  }

  // Legacy fallback: rows created before token_lookup existed. Only rows with
  // a NULL token_lookup need the O(n) scan; indexed rows were handled above.
  const allRes = await tx.query<any>(
    `SELECT company_id, document_kind, document_id, document_version, document_hash, created_at, revoked_at, qr_token_salt, qr_token_hash
       FROM document_qr_codes
      WHERE token_lookup IS NULL`
  );
  for (const row of allRes.rows) {
    const computedHash = crypto
      .createHash('sha256')
      .update(token + row.qr_token_salt)
      .digest('hex');
    if (computedHash === row.qr_token_hash) {
      return mapVerificationRow(row);
    }
  }
  return { valid: false };
}

export async function revokeQrToken(
  tx: Transaction,
  companyId: number,
  documentKind: string,
  documentId: number
): Promise<void> {
  await tx.query(
    `UPDATE document_qr_codes SET revoked_at = NOW()
      WHERE company_id = $1 AND document_kind = $2 AND document_id = $3 AND revoked_at IS NULL`,
    [companyId, documentKind, documentId]
  );
}