/**
 * Rate limiter — uses Upstash Redis when configured, else in-memory (single instance).
 */

type Bucket = {
  timestamps: number[];
};

const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

function memoryRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key) || { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

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
    // INCR + EXPIRE via Upstash pipeline
    const pipeline = [
      ['INCR', redisKey],
      ['EXPIRE', redisKey, String(windowSec), 'NX'],
      ['TTL', redisKey],
    ];
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pipeline),
    });
    const data = (await res.json()) as { result?: unknown }[];
    const count = Number(data?.[0]?.result ?? 0);
    const ttl = Number(data?.[2]?.result ?? windowSec);
    if (count > limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(ttl, 1) * 1000,
      };
    }
    return {
      allowed: true,
      remaining: Math.max(limit - count, 0),
      retryAfterMs: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Sync rate limit (in-memory). Prefer rateLimitAsync when Upstash may be configured.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  return memoryRateLimit(key, limit, windowMs);
}

/** Async rate limit — Upstash when configured, else memory. */
export async function rateLimitAsync(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const remote = await upstashRateLimit(key, limit, windowMs);
  if (remote) return remote;
  return memoryRateLimit(key, limit, windowMs);
}

export function clientIpFromRequest(req: Request): string {
  const trustedPlatformIp=req.headers.get('x-vercel-forwarded-for')||req.headers.get('cf-connecting-ip')||req.headers.get('x-real-ip');
  if(trustedPlatformIp?.trim())return trustedPlatformIp.split(',')[0].trim();
  const forwarded=req.headers.get('x-forwarded-for');
  if(forwarded){const chain=forwarded.split(',').map(value=>value.trim()).filter(Boolean);return chain[chain.length-1]||'unknown';}
  return 'unknown';
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < 60_000);
    if (bucket.timestamps.length === 0) buckets.delete(key);
  }
}, 60_000).unref?.();
