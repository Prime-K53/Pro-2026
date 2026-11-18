import crypto from 'node:crypto';

const SENSITIVE_KEYS = new Set(['password', 'token', 'secret', 'authorization', 'cookie', 'session', 'key']);

function redact(value: any, depth = 0): any {
  if (depth > 4) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase()) || /password|token|secret|authorization|cookie/i.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, message: string, context?: Record<string, any>, correlationId?: string): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    correlationId: correlationId || null,
    message,
    ...(context ? { context: redact(context) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (m: string, c?: Record<string, any>, cid?: string) => log('debug', m, c, cid),
  info: (m: string, c?: Record<string, any>, cid?: string) => log('info', m, c, cid),
  warn: (m: string, c?: Record<string, any>, cid?: string) => log('warn', m, c, cid),
  error: (m: string, c?: Record<string, any>, cid?: string) => log('error', m, c, cid),
};
