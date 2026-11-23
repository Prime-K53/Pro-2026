import http from 'node:http';
import { loadServerConfig } from '../../src/server/config.ts';
import { createServerDatabase, ServerDatabase } from '../../src/server/db.ts';
import { createApiExpressApp } from '../../src/server/app.ts';

export interface TestServer {
  baseUrl: string;
  db: ServerDatabase;
  close(): Promise<void>;
}

/**
 * Boots an in-memory server with a seeded demo company and guarantees teardown.
 *
 * Always wrap usage in try/finally:
 *   const srv = await startTestServer();
 *   try { ... } finally { await srv.close(); }
 */
export async function startTestServer(opts: { seedDemo?: boolean } = {}): Promise<TestServer> {
  const baseCfg = loadServerConfig();
  const db = await createServerDatabase(
    { ...baseCfg, nodeEnv: 'test', isProduction: false },
    { inMemory: true, seedDemo: opts.seedDemo ?? true }
  );
  const app = createApiExpressApp(db);
  const server = await new Promise<http.Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    db,
    close: async () => {
      await db.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

export interface CookieClient {
  cookie: string;
  request(
    method: string,
    pathname: string,
    options?: { body?: unknown; headers?: Record<string, string> }
  ): Promise<{ status: number; headers: Headers; text: string; json: any }>;
}

/** Minimal cookie-jar client for integration tests. */
export function createCookieClient(baseUrl: string): CookieClient {
  const client: CookieClient = {
    cookie: '',
    async request(method, pathname, options = {}) {
      const headers: Record<string, string> = {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(client.cookie ? { Cookie: client.cookie } : {}),
        ...(options.headers || {}),
      };
      const res = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const pair = setCookie.split(';')[0];
        client.cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, text, json };
    },
  };
  return client;
}

/** Logs in with the seeded demo administrator and returns an authenticated client. */
export async function loginAdmin(
  baseUrl: string
): Promise<{ client: CookieClient; csrfToken: string | null }> {
  const client = createCookieClient(baseUrl);
  const res = await client.request('POST', '/api/auth/login', {
    body: { identifier: 'admin', password: 'PrintingAdmin#2026' },
  });
  if (res.status !== 200) {
    throw new Error(`loginAdmin failed: ${res.status} ${res.text}`);
  }
  const csrfToken = client.cookie ? await fetchCsrfToken(baseUrl, client) : null;
  return { client, csrfToken };
}

async function fetchCsrfToken(baseUrl: string, client: CookieClient): Promise<string | null> {
  const res = await client.request('GET', '/api/auth/csrf-token');
  return res.json?.csrfToken ?? null;
}