/**
 * Single HTTP transport for the whole client.
 *
 * Every API client in `src/services` funnels through `requestJson` so that
 * cookie handling, JSON parsing, error shaping and session-expiry detection
 * live in exactly one place. Previously each client re-implemented `fetch`,
 * which meant a session expiry surfaced as a generic "Request failed".
 */

/** Fired on the window when the server rejects a request because the session is gone. */
export const SESSION_EXPIRED_EVENT = 'pms:session-expired';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** True when the server rejected the request for lack of a valid session. */
  get isSessionExpired(): boolean {
    return this.status === 401;
  }

  /** True when the caller simply lacks the permission for this action. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

function notifySessionExpired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

/**
 * Perform a JSON request against the API.
 *
 * - Sends the session cookie (`credentials: 'include'`).
 * - Parses the body defensively (empty/non-JSON bodies become `{}`).
 * - Throws an `ApiError` with the server's own message where available.
 * - Emits `SESSION_EXPIRED_EVENT` on HTTP 401 so the app can re-verify the session.
 */
export async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    ...init,
  });

  let body: any = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (!res.ok) {
    if (res.status === 401) notifySessionExpired();
    const message =
      body?.error ||
      body?.message ||
      (res.status === 401
        ? 'Your session has expired. Please sign in again.'
        : `Request failed (${res.status})`);
    throw new ApiError(message, res.status, body);
  }

  return body as T;
}

/**
 * Perform a request and return the raw envelope instead of throwing.
 * Used by the auth flows, which need to distinguish 401/403 from transport errors.
 */
export async function requestJsonRaw<T = any>(
  url: string,
  init: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      ...init,
    });
  } catch {
    return { ok: false, status: 0, data: {} as T };
  }

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (res.status === 401) notifySessionExpired();
  return { ok: res.ok, status: res.status, data };
}

/**
 * Fetch a binary payload (CSV export, attachment download).
 * Throws `ApiError` on failure so callers get the same error semantics.
 */
export async function requestBlob(url: string, init: RequestInit = {}): Promise<Blob> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    if (res.status === 401) notifySessionExpired();
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body?.error || message;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, res.status);
  }
  return res.blob();
}

/** Build a query string from a flat object, skipping empty values. */
export function buildQuery(
  params: Record<string, string | number | boolean | undefined | null>
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(blobUrl);
}
