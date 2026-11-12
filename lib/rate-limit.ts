/**
 * Shared rate limiter. Upstash or the internal Rust/Redis service is required
 * for production Next.js routes; local memory is development-only.
 */

type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  unavailable?: boolean;
};

function memoryRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key) || { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((timestamp) => now - timestamp < windowMs);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0] || now;
    buckets.set(key, bucket);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(windowMs - (now - oldest), 0),
    };
  }

  bucket.timestamps.push(now);
  buckets.set(key, bucket);
  return {
    allowed: true,
    remaining: Math.max(limit - bucket.timestamps.length, 0),
    retryAfterMs: 0,
  };
}

async function upstashRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  const redisKey = `rl:${key}`;
  try {
    const pipeline = [
      ['INCR', redisKey],
      ['EXPIRE', redisKey, String(windowSec), 'NX'],
      ['TTL', redisKey],
    ];
    const response = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pipeline),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { result?: unknown; error?: string }[];
    if (!Array.isArray(data) || data.some((item) => item?.error)) return null;
    const count = Number(data[0]?.result);
    const ttl = Number(data[2]?.result ?? windowSec);
    if (!Number.isFinite(count)) return null;
    if (count > limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(ttl, 1) * 1000 };
    }
    return { allowed: true, remaining: Math.max(limit - count, 0), retryAfterMs: 0 };
  } catch {
    return null;
  }
}

async function rustRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult | null> {
  const base = process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/, '');
  const secret = process.env.RATE_LIMIT_SHARED_SECRET;
  if (!base || !secret) return null;

  try {
    const response = await fetch(`${base}/internal/rate-limit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rate-limit-secret': secret,
      },
      body: JSON.stringify({ key, limit, windowMs }),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      allowed?: boolean;
      remaining?: number;
      retryAfterMs?: number;
    };
    if (typeof data.allowed !== 'boolean') return null;
    return {
      allowed: data.allowed,
      remaining: Math.max(0, Number(data.remaining) || 0),
      retryAfterMs: Math.max(0, Number(data.retryAfterMs) || 0),
    };
  } catch {
    return null;
  }
}

/** Synchronous fallback retained for existing handlers during migration. */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  return memoryRateLimit(key, limit, windowMs);
}

/**
 * Remote outages fail closed. A production deployment must configure either
 * the internal Rust limiter or Upstash; it must not quietly use per-process
 * memory as a substitute for shared limits.
 */
export async function rateLimitAsync(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const rustConfigured = Boolean(
    process.env.RUST_BACKEND_URL && process.env.RATE_LIMIT_SHARED_SECRET
  );
  if (rustConfigured) {
    const result = await rustRateLimit(key, limit, windowMs);
    if (result) return result;
    return { allowed: false, remaining: 0, retryAfterMs: 2_000, unavailable: true };
  }

  const upstashConfigured = Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
  if (upstashConfigured) {
    const result = await upstashRateLimit(key, limit, windowMs);
    if (result) return result;
    return { allowed: false, remaining: 0, retryAfterMs: 2_000, unavailable: true };
  }

  if (process.env.NODE_ENV === 'production') {
    return { allowed: false, remaining: 0, retryAfterMs: 2_000, unavailable: true };
  }

  return memoryRateLimit(key, limit, windowMs);
}

/** Trust only forwarding headers written by the hosting proxy. */
export function clientIpFromRequest(req: Request): string {
  const configured = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  const trustedHeader =
    configured ||
    (process.env.VERCEL === '1'
      ? 'x-vercel-forwarded-for'
      : process.env.CF_PAGES === '1'
        ? 'cf-connecting-ip'
        : '');

  // Never fall back to arbitrary X-Forwarded-For values supplied by callers.
  if (!['x-vercel-forwarded-for', 'cf-connecting-ip', 'x-real-ip'].includes(trustedHeader)) {
    return 'unknown';
  }

  const value = req.headers.get(trustedHeader)?.split(',')[0]?.trim();
  return value || 'unknown';
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    bucket.timestamps = bucket.timestamps.filter((timestamp) => now - timestamp < 60_000);
    if (bucket.timestamps.length === 0) buckets.delete(key);
  }
}, 60_000).unref?.();
