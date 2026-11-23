import crypto from 'node:crypto';

/**
 * Validate a Twilio request signature.
 *
 * Twilio signs `url + sorted(key + value)...` with HMAC-SHA1 using the account
 * auth token. When no auth token is configured, requests are allowed only in
 * non-production (so local development works) and rejected in production.
 */
export function validateTwilioSignature(params: {
  url: string;
  form: Record<string, unknown>;
  signature?: string | null;
  authToken?: string | null;
  isProduction: boolean;
}): boolean {
  const { url, form, signature, authToken, isProduction } = params;

  if (!authToken) {
    return !isProduction;
  }
  if (!signature) {
    return false;
  }

  const keys = Object.keys(form).sort();
  let data = url;
  for (const key of keys) {
    const value = form[key];
    data += key + (Array.isArray(value) ? value.join(',') : String(value ?? ''));
  }

  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Reconstruct the public URL Twilio used, honouring proxy headers. */
export function twilioRequestUrl(req: {
  protocol: string;
  get(name: string): string | undefined;
  originalUrl: string;
}): string {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host') || '';
  return `${proto}://${host}${req.originalUrl}`;
}