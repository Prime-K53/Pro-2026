import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthHeaders,
  getCsrfToken,
  getSessionToken,
  requestJson,
  requestJsonRaw,
  SESSION_EXPIRED_EVENT,
  setCsrfToken,
  setSessionToken,
} from './http';

describe('http auth transport', () => {
  afterEach(() => {
    setSessionToken(null);
    setCsrfToken(null);
    vi.restoreAllMocks();
  });

  it('attaches in-memory Bearer sessionToken and X-CSRF-Token on mutations', async () => {
    setSessionToken('tok.sig');
    setCsrfToken('csrf-123');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await requestJson('/api/accounts', { method: 'POST', body: JSON.stringify({ name: 'Test' }) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBe('include');
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer tok.sig');
    expect(headers.get('X-CSRF-Token')).toBe('csrf-123');
    expect(getSessionToken()).toBe('tok.sig');
    expect(getCsrfToken()).toBe('csrf-123');
    expect(getAuthHeaders('GET')).toEqual({ Authorization: 'Bearer tok.sig' });
  });

  it('does not emit SESSION_EXPIRED_EVENT on /api/auth/login or /api/auth/status 401 responses', async () => {
    const expiredSpy = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, expiredSpy);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Session gone' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await requestJsonRaw('/api/auth/login', { method: 'POST', body: '{}' });
    await requestJsonRaw('/api/auth/status', { method: 'GET' });
    expect(expiredSpy).not.toHaveBeenCalled();

    await requestJsonRaw('/api/accounts', { method: 'GET' });
    expect(expiredSpy).toHaveBeenCalledTimes(1);

    window.removeEventListener(SESSION_EXPIRED_EVENT, expiredSpy);
  });
});
