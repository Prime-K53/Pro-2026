interface Bucket { count: number; resetAt: number; }

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyFn?: (req: any) => string;
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, keyFn } = opts;
  return (req: any, res: any, next: any) => {
    const key = keyFn ? keyFn(req) : (req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.status(429).json({ error: 'Too many requests', retryAfterMs: b.resetAt - now });
      return;
    }
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - b.count)));
    next();
  };
}

// cleanup stale buckets periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (now > v.resetAt + 60000) buckets.delete(k);
  }
}, 60000).unref?.();
